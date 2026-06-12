import { readCard, loadBoard, createCard, patchFrontmatter, appendRunLog, moveCard, deleteCard } from './board.js';

const now = () => new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z';

// Materialize a `## Chunks` breakdown into child card files.
// Sets epic:true and children:[ids] on the epic, moves it to Planned.
// Returns the array of created child card IDs.
export async function materializeChunks(repoPath, epicId, chunks) {
  const epic = readCard(repoPath, epicId);
  const epicType = epic?.data?.type;
  const epicAgent = epic?.data?.agent;
  const epicModel = epic?.data?.model;
  const ids = [];
  const titleToId = new Map();
  let prev = null;
  let usedDag = false;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const hasNeeds = Object.prototype.hasOwnProperty.call(c, 'needs');
    const dependencies = [];
    if (hasNeeds) {
      usedDag = true;
      for (const title of Array.isArray(c.needs) ? c.needs : []) {
        const depId = titleToId.get(title);
        if (depId) dependencies.push(depId);
        else await appendRunLog(repoPath, epicId, `  - ⚠ chunk ${i + 1} needs unknown earlier chunk: ${title}`);
      }
    } else if (prev) {
      dependencies.push(prev);
    }
    const res = await createCard(repoPath, {
      title: c.title,
      description: c.title,
      type: c.type || epicType,
      criteria: c.criteria,
      plan: c.plan,
      dependencies,
      parent: epicId,
      status: 'Planned',
      triaged: `n/a (chunk ${i + 1}/${chunks.length} of ${epicId})`,
      agent: epicAgent,
      model: epicModel,
      source: 'chunk',
    });
    if (!res.ok) {
      await appendRunLog(repoPath, epicId, `  - ⚠ chunk ${i + 1} create failed: ${res.error || 'unknown'}`);
      for (let j = ids.length - 1; j >= 0; j--) {
        await deleteCard(repoPath, ids[j]);
      }
      return [];
    }
    ids.push(res.id);
    titleToId.set(c.title, res.id);
    prev = res.id;
  }
  if (!ids.length) {
    await moveCard(repoPath, epicId, 'Planned', { reason: 'split produced no chunks; kept as one card' });
    return ids;
  }
  await patchFrontmatter(repoPath, epicId, { epic: true, children: ids });
  await appendRunLog(repoPath, epicId,
    `- ${now()} · Plan · split into ${ids.length} ${usedDag ? 'chunks (DAG)' : 'sequential chunks'}: ${ids.join(' → ')}`);
  await moveCard(repoPath, epicId, 'Planned', { reason: `split into ${ids.length} chunks` });
  return ids;
}

// Move every Planned child of epicId whose dependencies are all Done to Queue.
// Returns the array of moved card IDs. Does NOT call enqueueBuild.
export async function advanceEpicChildren(repoPath, epicId) {
  const board = loadBoard(repoPath, { includeArchived: false });
  const moved = [];
  for (const child of board.cards.filter((c) => c.parent === epicId && c.status === 'Planned' && !c.epic)) {
    const blocked = (child.dependencies || []).filter((d) => board.cards.find((c) => c.id === d)?.status !== 'Done');
    if (blocked.length) continue;
    const mv = await moveCard(repoPath, child.id, 'Queue', { reason: 'chunk ready' });
    if (mv.ok && !mv.unchanged) moved.push(child.id);
  }
  const fresh = loadBoard(repoPath, { includeArchived: false });
  const kids = fresh.cards.filter((c) => c.parent === epicId && !c.epic);
  const epic = readCard(repoPath, epicId);
  const epicStatus = epic?.data?.status;
  const completable = ['Planned', 'Queue', 'Build'].includes(epicStatus);
  if (completable && kids.length && kids.every((c) => c.status === 'Done')) {
    await moveCard(repoPath, epicId, 'Done', { reason: 'all chunks complete' });
  }
  return moved;
}
