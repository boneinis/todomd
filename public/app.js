// keep the token out of the visible URL/history; sessionStorage survives reloads
const token = new URLSearchParams(location.search).get('token')
  || sessionStorage.getItem('todomd-token') || '';
if (location.search.includes('token')) {
  sessionStorage.setItem('todomd-token', token);
  history.replaceState(null, '', location.pathname);
}
const headers = { 'x-todomd-token': token };

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

const COL_COLORS = {
  Review: 'var(--dim)', Plan: 'var(--cyan)', Planned: 'var(--cyan)',
  Queue: 'var(--violet)', Build: 'var(--amber)', Verify: 'var(--amber)',
  'Needs Human': 'var(--red)', Done: 'var(--green)',
};

const $ = (sel) => document.querySelector(sel);
const boardEl = $('#board');
const projectSel = $('#project');
const filterInput = $('#filter');
let currentProject = null;
let boardData = null;
let runStates = {};
let drawerCard = null;
let myName = localStorage.getItem('todomd-me') || '';
let viewMode = (localStorage.getItem('todomd-view') === 'mine' && myName) ? 'mine' : 'all';
let showArchived = false;   // the "archived" view shows only archived cards
let drawerArchived = false; // is the open card archived?
let deleteArmed = false;    // two-click confirm for delete

// model suggestions per vendor — pulled from the provider CLI (server reads
// `<cli> --help` + config), cached per vendor. Still a datalist, so a custom
// id is allowed. Falls back to a sane default until the fetch resolves.
const modelCache = {};
function fillModels(list) {
  $('#model-options').innerHTML = (list || []).map((m) => `<option value="${esc(m)}"></option>`).join('');
}
async function setModelOptions(vendor) {
  vendor = vendor || 'claude';
  if (modelCache[vendor]) { fillModels(modelCache[vendor]); return; }
  fillModels(vendor === 'codex' ? ['gpt-5-codex', 'gpt-5'] : ['opus', 'sonnet', 'haiku']); // instant default
  if (!currentProject) return;
  try {
    const { models } = await api(`models?agent=${encodeURIComponent(vendor)}&project=${encodeURIComponent(currentProject)}`);
    modelCache[vendor] = models;
    fillModels(models);
  } catch { /* keep the default */ }
}
function setSkillOptions() { // the repo's available commands (from the board payload)
  $('#skill-options').innerHTML = ((boardData && boardData.skills) || [])
    .map((s) => `<option value="${esc(s)}"></option>`).join('');
}

async function api(path) {
  const res = await fetch(`/api/${path}`, { headers });
  if (res.status === 401) {
    toast('session expired — restart todomd and open the newly printed URL');
    throw new Error('bad token');
  }
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}

async function loadProjects() {
  const { projects } = await api('projects');
  projectSel.innerHTML = projects.map((p) => `<option>${esc(p)}</option>`).join('');
  if (!currentProject || !projects.includes(currentProject)) currentProject = projects[0]; // undefined if none
  projectSel.value = currentProject || '';
}

async function loadBoard() {
  if (!currentProject) { // no projects (e.g. the last one was removed) — show an empty state
    boardData = null;
    boardEl.innerHTML = `<div class="empty-board">
      <h2>No project yet</h2>
      <p>Add a git repo with the <b>⊕</b> button (paste its path), or run <code>todomd init</code> in a repo's terminal — then refresh.</p>
      <p><button id="empty-guide" class="modal-submit">open the Getting Started guide</button></p>
    </div>`;
    $('#empty-guide')?.addEventListener('click', openGuide);
    return;
  }
  boardData = await api(`board?project=${encodeURIComponent(currentProject)}${showArchived ? '&archived=1' : ''}`);
  runStates = boardData.runStates || {};
  renderBanners(boardData.banners || []);
  const usage = boardData.usage || {};
  const modeTag = boardData.mode === 'budget' ? ' · budget' : '';
  const viewer = boardData.access === 'viewer';
  $('#usage').textContent = (usage.month_cost_usd ? `$${usage.month_cost_usd.toFixed(2)}/mo` : '') + modeTag + (viewer ? ' · monitor' : '');
  document.body.classList.toggle('viewer', viewer);
  setSkillOptions();
  renderBoard();
}

function renderBanners(list) {
  const el = $('#banners');
  el.innerHTML = list.map((b) =>
    `<div class="banner ${esc(b.level)}">${esc(b.text)}${b.level === 'warn'
      ? ' <button class="banner-resume">resume</button>' : ''}</div>`
  ).join('');
  el.querySelectorAll('.banner-resume').forEach((btn) =>
    btn.addEventListener('click', () =>
      fetch('/api/resume-queues?project=' + encodeURIComponent(currentProject), { method: 'POST', headers }))
  );
}

/* ── team / my-work view ── */
function applyViewToggle() {
  const btn = $('#view-toggle');
  btn.textContent = viewMode === 'mine' ? `mine: ${myName}` : 'team';
  btn.classList.toggle('active', viewMode === 'mine');
}
function promptName(initial) {
  const n = prompt("Your name for 'my work' — match the assignee on your cards:", initial || '');
  if (n && n.trim()) { myName = n.trim(); localStorage.setItem('todomd-me', myName); return true; }
  return false;
}
$('#view-toggle').addEventListener('click', (e) => {
  if (e.altKey) { if (promptName(myName)) { applyViewToggle(); renderBoard(); } return; } // ⌥-click: change name
  if (viewMode === 'all') {
    if (!myName && !promptName()) return;
    viewMode = 'mine';
  } else {
    viewMode = 'all';
  }
  localStorage.setItem('todomd-view', viewMode);
  applyViewToggle();
  renderBoard();
});

/* ── archived view ── */
function applyArchivedToggle() {
  $('#archived-toggle').classList.toggle('active', showArchived);
  document.body.classList.toggle('archived-view', showArchived);
}
$('#archived-toggle').addEventListener('click', () => {
  showArchived = !showArchived;
  applyArchivedToggle();
  loadBoard(); // re-fetch: archived cards aren't in the default board payload
});

// plain-language explanation of what each column does (shown by the ? button)
const COLUMN_HELP = {
  Review: 'New cards land here. An agent auto-triages each one — codebase insight, a proposed plan, an estimate, and flags — written into the card. You decide: drag to Plan to proceed.',
  Plan: 'An agent writes a concrete implementation plan into the card, then moves it to Planned. (No code is written yet.)',
  Planned: 'The plan is ready for your review. Read it in the card, then drag to Queue to approve and build it.',
  Queue: 'Approved & waiting to build. An agent picks it up automatically (launcher mode) or via your /loop dispatcher (budget mode). Quota-paused cards also wait here to resume.',
  Build: 'An agent is implementing the card in an isolated git worktree (your main branch is untouched until it passes).',
  Verify: 'An independent agent checks the work against the acceptance criteria. Pass → merged to Done; fail → it retries with the findings, up to the attempt cap.',
  'Needs Human': 'The pipeline paused for you: attempts exhausted, a merge/work conflict, a worktree-env issue, or the agent has a question. Open the card for the reason — answer it, or drag it back to retry.',
  Done: 'Verified and merged into your branch. (Archive it to clear it off the board when you like.)',
};
const colHelpEl = (() => {
  const el = document.createElement('div');
  el.id = 'col-help'; el.hidden = true;
  document.body.appendChild(el);
  return el;
})();
function showColHelp(col, anchor) {
  colHelpEl.textContent = COLUMN_HELP[col] || `the ${col} column`;
  const r = anchor.getBoundingClientRect();
  colHelpEl.style.left = `${Math.min(r.left, window.innerWidth - 320)}px`;
  colHelpEl.style.top = `${r.bottom + 6}px`;
  colHelpEl.hidden = false;
}
document.addEventListener('click', (e) => { if (!e.target.classList?.contains('col-help-btn')) colHelpEl.hidden = true; });

// the command a column's prompt edits: a stage command, or triage for Review
function columnCommand(col) {
  const cfg = boardData.config || {};
  if ((cfg.stages || {})[col]) return cfg.stages[col].command || `todomd-${col.toLowerCase()}`;
  if (col === 'Review' && cfg.triage) return cfg.triage.command || 'todomd-triage';
  if (['Plan', 'Build', 'Verify'].includes(col)) return `todomd-${col.toLowerCase()}`;
  return null;
}

function renderBoard() {
  if (!boardData) return;
  const filter = filterInput.value.trim().toLowerCase();
  const mine = viewMode === 'mine' && myName ? myName.toLowerCase() : null;
  boardEl.innerHTML = '';
  for (const col of boardData.config.columns) {
    const color = COL_COLORS[col] || 'var(--dim)';
    const cards = boardData.cards.filter(
      (c) => c.status === col &&
        (showArchived ? c.archived : true) && // archived view shows only archived cards
        (!mine || (c.assignee || '').toLowerCase() === mine) &&
        (!filter || `${c.id} ${c.title} ${(c.labels || []).join(' ')} ${c.assignee || ''}`.toLowerCase().includes(filter))
    );
    const colEl = document.createElement('section');
    colEl.className = 'column';
    colEl.style.setProperty('--col', color);
    colEl.dataset.status = col;
    // columns that run a prompt get an inline edit affordance (full-access only).
    // Review maps to the triage (auto-review) prompt, which isn't a stage.
    const cmd = columnCommand(col);
    const stageCol = !!(boardData.config.stages || {})[col];
    const editBtn = (cmd && boardData.access !== 'viewer')
      ? `<button class="col-edit" data-cmd="${esc(cmd)}" title="${col === 'Review' ? 'edit the review (triage) prompt' : stageCol ? `${esc(col)} settings — prompt, agent & model` : `edit the ${esc(col)} prompt`}">⚙ ${stageCol ? 'settings' : 'prompt'}</button>` : '';
    colEl.innerHTML = `<header class="col-head"><span class="col-name">${esc(col)} <button class="col-help-btn" title="what does this column do?">?</button></span><span class="col-head-right"><span class="col-count">[${cards.length}]</span>${editBtn}</span></header>`;
    colEl.querySelector('.col-help-btn')?.addEventListener('click', (e) => { e.stopPropagation(); showColHelp(col, e.currentTarget); });
    colEl.querySelector('.col-edit')?.addEventListener('click', (e) => { e.stopPropagation(); openPromptEditor(e.currentTarget.dataset.cmd); });
    const list = document.createElement('div');
    list.className = 'col-cards';
    if (!cards.length) list.innerHTML = `<p class="col-empty">empty</p>`;
    cards.forEach((card, i) => list.appendChild(renderCard(card, color, i)));
    colEl.appendChild(list);
    wireDrop(colEl);
    boardEl.appendChild(colEl);
  }
}

function renderCard(card, color, i) {
  const el = $('#card-tpl').content.firstElementChild.cloneNode(true);
  if (boardData.access === 'viewer') el.draggable = false;
  el.style.setProperty('--col', color);
  el.style.setProperty('--i', i);
  el.dataset.id = card.id;
  if (card.archived) el.classList.add('archived');
  el.querySelector('.card-id').textContent = card.id || card.file;
  const prio = el.querySelector('.card-prio');
  prio.textContent = card.priority || '';
  prio.className = `card-prio ${card.priority || ''}`;
  el.querySelector('.card-title').textContent = card.title || card.file;
  el.querySelector('.card-chips').textContent =
    [card.type, ...(card.labels || [])].filter(Boolean).join(' · ');
  if (card.assignee) {
    const a = document.createElement('span');
    a.className = 'card-assignee';
    a.textContent = `@${card.assignee}`;
    el.querySelector('header').appendChild(a);
  }
  const crit = el.querySelector('.card-criteria');
  if (card.criteria) {
    crit.textContent = `☑ ${card.criteria.done}/${card.criteria.total}`;
    if (card.criteria.done === card.criteria.total) crit.classList.add('complete');
  }
  // epic/chunk relationship badge (sequential chunking)
  const rel = el.querySelector('.card-rel');
  if (card.epic) {
    const kids = boardData.cards.filter((c) => c.parent === card.id);
    const done = kids.filter((c) => c.status === 'Done').length;
    rel.textContent = `⊞ epic ${done}/${kids.length}`;
  } else if (card.parent) {
    const blocked = (card.dependencies || []).some((d) => boardData.cards.find((c) => c.id === d)?.status !== 'Done');
    rel.textContent = blocked ? '⊞ chunk 🔒' : '⊞ chunk';
    if (blocked) rel.classList.add('blocked');
  }
  const rs = runStates[card.id];
  const runEl = el.querySelector('.card-run');
  if (rs?.state === 'running') {
    el.classList.add('running');
    runEl.textContent = `● ${rs.stage}`;
  } else if (rs?.state === 'queued') {
    runEl.textContent = '◌ queued';
  }
  if (card.needs_human_reason) {
    el.querySelector('.card-chips').textContent = `⚠ ${card.needs_human_reason}`;
  }
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/todomd-id', card.id);
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('click', () => openDrawer(card.id));
  return el;
}

function wireDrop(colEl) {
  colEl.addEventListener('dragover', (e) => { e.preventDefault(); colEl.classList.add('drag-over'); });
  colEl.addEventListener('dragleave', () => colEl.classList.remove('drag-over'));
  colEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    colEl.classList.remove('drag-over');
    const id = e.dataTransfer.getData('text/todomd-id');
    if (!id) return;
    try {
      const res = await fetch(`/api/cards/${id}/move?project=${encodeURIComponent(currentProject)}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ status: colEl.dataset.status }),
      });
      const out = await res.json();
      if (!res.ok) toast(out.error || 'move failed');
      else if (out.warning) toast(out.warning);
    } catch {
      toast('server unreachable — move not saved');
    }
    loadBoard();
  });
}

/* ── drawer ── */
async function openDrawer(id) {
  drawerCard = id;
  $('#run-log').textContent = '';
  $('#drawer-run').hidden = true;
  $('#drawer-cancel').hidden = !runStates[id];
  backfillRunLog(id); // fill the log with the run-so-far (and keep it for finished runs)
  const card = await api(`cards/${id}?project=${encodeURIComponent(currentProject)}`);
  $('#drawer-id').textContent = card.data.id;
  $('#drawer-title').textContent = card.data.title;
  $('#drawer-meta').innerHTML = [
    ['status', card.data.status], ['type', card.data.type], ['priority', card.data.priority],
    ['agent', card.data.agent], ['source', card.data.source],
    ['labels', (card.data.labels || []).join(', ') || null],
  ].filter(([, v]) => v).map(([k, v]) => `<span class="meta-chip">${esc(k)} <b>${esc(String(v))}</b></span>`).join('');
  $('#drawer-body').innerHTML = mdToHtml(card.body);
  $('#drawer-file').textContent = `.todomd/tasks/${card.file}`;
  $('#route-agent').value = card.data.agent || 'claude';
  setModelOptions($('#route-agent').value); // suggestions match the card's vendor
  $('#route-model').value = card.data.model || '';
  $('#route-skill').value = card.data.skill || '';
  $('#route-assignee').value = card.data.assignee || '';
  const cols = boardData?.config?.columns || [];
  $('#move-select').innerHTML = cols
    .filter((c) => c !== card.data.status)
    .map((c) => `<option>${esc(c)}</option>`).join('');
  // archive / delete controls
  drawerArchived = !!card.data.archived;
  $('#drawer-archive').textContent = drawerArchived ? 'restore' : 'archive';
  resetDeleteBtn();
  // pending agent question
  const q = card.data.question;
  $('#drawer-question').hidden = !q;
  if (q) { $('#question-text').textContent = q; $('#answer-input').value = ''; }
  $('#drawer').hidden = false;
}

$('#answer-submit').addEventListener('click', async () => {
  if (!drawerCard) return;
  const answer = $('#answer-input').value.trim();
  if (!answer) return toast('type an answer first');
  try {
    const res = await fetch(`/api/cards/${drawerCard}/answer?project=${encodeURIComponent(currentProject)}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ answer }),
    });
    const out = await res.json();
    if (!res.ok) return toast(out.error || 'failed');
    toast('answered — resuming the build');
    $('#drawer').hidden = true;
    loadBoard();
  } catch { toast('server unreachable'); }
});

function resetDeleteBtn() {
  deleteArmed = false;
  const b = $('#drawer-delete');
  b.textContent = 'delete';
  b.classList.remove('armed');
}

$('#drawer-archive').addEventListener('click', async () => {
  if (!drawerCard) return;
  const archiving = !drawerArchived;
  try {
    const res = await fetch(`/api/cards/${drawerCard}/archive?project=${encodeURIComponent(currentProject)}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ archived: archiving }),
    });
    const out = await res.json();
    if (!res.ok) return toast(out.error || 'failed');
    toast(archiving ? 'archived' : 'restored');
    $('#drawer').hidden = true;
    loadBoard();
  } catch { toast('server unreachable'); }
});

// delete is a two-click confirm: first click arms, second deletes (auto-disarms)
$('#drawer-delete').addEventListener('click', async () => {
  if (!drawerCard) return;
  if (!deleteArmed) {
    deleteArmed = true;
    $('#drawer-delete').textContent = 'confirm delete?';
    $('#drawer-delete').classList.add('armed');
    setTimeout(resetDeleteBtn, 3500);
    return;
  }
  try {
    const res = await fetch(`/api/cards/${drawerCard}?project=${encodeURIComponent(currentProject)}`, { method: 'DELETE', headers });
    const out = await res.json();
    if (!res.ok) { resetDeleteBtn(); return toast(out.error || 'delete failed'); }
    toast('deleted');
    resetDeleteBtn();
    $('#drawer').hidden = true;
    loadBoard();
  } catch { toast('server unreachable'); }
});

$('#move-apply').addEventListener('click', async () => {
  if (!drawerCard) return;
  try {
    const res = await fetch(`/api/cards/${drawerCard}/move?project=${encodeURIComponent(currentProject)}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ status: $('#move-select').value }),
    });
    const out = await res.json();
    if (!res.ok) return toast(out.error || 'move failed');
    toast(out.warning || `moved to ${$('#move-select').value}`);
    $('#drawer').hidden = true;
    drawerCard = null;
    loadBoard();
  } catch {
    toast('server unreachable');
  }
});

$('#route-save').addEventListener('click', async () => {
  if (!drawerCard) return;
  try {
    const res = await fetch(`/api/cards/${drawerCard}/set?project=${encodeURIComponent(currentProject)}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: $('#route-agent').value,
        model: $('#route-model').value.trim(),
        skill: $('#route-skill').value.trim(),
        assignee: $('#route-assignee').value.trim(),
      }),
    });
    const out = await res.json();
    toast(res.ok ? 'routing saved' : out.error || 'save failed');
    if (res.ok) loadBoard();
  } catch {
    toast('server unreachable');
  }
});
/* ── attachments: upload via button or drag-drop onto the drawer ── */
async function uploadFiles(files) {
  if (!drawerCard || !files?.length) return;
  for (const file of files) {
    try {
      const res = await fetch(`/api/cards/${drawerCard}/attach?project=${encodeURIComponent(currentProject)}`, {
        method: 'POST',
        headers: { ...headers, 'x-filename': encodeURIComponent(file.name) },
        body: file,
      });
      const out = await res.json();
      if (!res.ok) { toast(out.error || 'upload failed'); continue; }
      toast(`attached ${out.name}`);
    } catch { toast('server unreachable'); }
  }
  openDrawer(drawerCard); // re-render with the new attachment
}
$('#drawer-attach').addEventListener('click', () => $('#attach-input').click());
$('#attach-input').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });
const drawerEl = $('#drawer');
drawerEl.addEventListener('dragover', (e) => { e.preventDefault(); drawerEl.classList.add('drag-file'); });
drawerEl.addEventListener('dragleave', () => drawerEl.classList.remove('drag-file'));
drawerEl.addEventListener('drop', (e) => {
  e.preventDefault();
  drawerEl.classList.remove('drag-file');
  if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files);
});

// click a file reference in the rendered card body → open it with the OS default app
$('#drawer-body').addEventListener('click', async (e) => {
  const a = e.target.closest('.file-link');
  if (!a) return;
  e.preventDefault();
  const p = a.dataset.path;
  try {
    const res = await fetch(`/api/open?project=${encodeURIComponent(currentProject)}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ path: p }),
    });
    const out = await res.json();
    toast(res.ok ? `opening ${p}…` : (out.error || 'could not open'));
  } catch { toast('server unreachable'); }
});

$('#drawer-close').addEventListener('click', () => { $('#drawer').hidden = true; drawerCard = null; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#drawer').hidden = true; drawerCard = null; } });
$('#drawer-cancel').addEventListener('click', async () => {
  if (!drawerCard) return;
  const res = await fetch(`/api/cards/${drawerCard}/cancel?project=${encodeURIComponent(currentProject)}`,
    { method: 'POST', headers });
  const out = await res.json();
  toast(res.ok ? 'run cancelled' : out.error || 'cancel failed');
});

// fetch the most recent run's events so the drawer shows the whole run, not just
// what streams in after you open it (works for a finished run too)
async function backfillRunLog(id) {
  const running = runStates[id]?.state === 'running';
  try {
    const { agent, events } = await api(`cards/${id}/runlog?project=${encodeURIComponent(currentProject)}`);
    if (id !== drawerCard) return; // the drawer moved on while we were fetching
    $('#run-log').textContent = '';
    for (const ev of events) appendRunEvent(agent === 'codex' ? { vendor: 'codex', ...ev } : ev);
    $('#drawer-run').hidden = !(running || events.length);
    $('#drawer-run .run-title').textContent = running ? 'live run' : 'last run';
  } catch {
    $('#drawer-run').hidden = !running;
  }
}

function appendRunEvent(event) {
  const log = $('#run-log');
  if (event.vendor === 'codex') {
    const text = event.item?.text || event.item?.command || event.message || '';
    log.textContent += `▸ ${event.type}${text ? `: ${String(text).slice(0, 200)}` : ''}\n`;
    log.scrollTop = log.scrollHeight;
    return;
  }
  if (event.type === 'system' && event.subtype === 'init') {
    log.textContent += `· session ${event.session_id}\n`;
  } else if (event.type === 'assistant') {
    for (const block of event.message?.content || []) {
      if (block.type === 'text' && block.text) log.textContent += block.text + '\n';
      else if (block.type === 'tool_use') log.textContent += `▸ ${block.name}\n`;
    }
  }
  log.scrollTop = log.scrollHeight;
}

/* minimal markdown renderer: headings, checkboxes, lists, code, bold/inline code */
function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
// only attachment paths and http(s) are renderable; everything else (e.g.
// javascript:) is dropped to plain text — no XSS via card-authored links
function safeUrl(rawUrl) {
  const u = rawUrl.replace(/&amp;/g, '&').trim();
  if (u.startsWith('.todomd/attachments/')) {
    return `/api/file?project=${encodeURIComponent(currentProject)}&p=${encodeURIComponent(u)}&token=${encodeURIComponent(token)}`;
  }
  if (/^https?:\/\//i.test(u)) return u;
  return null;
}
// Extensions that mark a bare filename (no slash) as a file worth linking — a
// path with a slash is treated as a file regardless. Keeps prose like "e.g."
// or "v1.0" from turning into links.
const FILE_EXT = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'md', 'markdown', 'txt', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'sh', 'bash', 'zsh', 'fish', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'svg', 'sql', 'vue', 'svelte', 'astro', 'env', 'lock', 'gradle', 'csv', 'tsv', 'log', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico']);
// Does a token look like a repo-relative file path? Returns { path } or null.
// (a trailing :line / :line:col is tolerated but dropped — the OS open ignores it)
function looksLikeFile(raw) {
  const m = (raw || '').trim().match(/^([\w./@+-]+\.[A-Za-z0-9]{1,10})(?::\d+){0,2}$/);
  if (!m) return null;
  const p = m[1];
  if (p.length > 200 || p.startsWith('/') || p.includes('..')) return null;
  if (!p.includes('/') && !FILE_EXT.has(p.split('.').pop().toLowerCase())) return null;
  return { path: p };
}
function fileLinkHtml(label, info) {
  const p = String(info.path).replace(/"/g, '&quot;');
  return `<a href="#" class="file-link" data-path="${p}" title="open ${p}">${label}</a>`;
}
function inline(s) {
  return esc(s)
    // images: ![alt](url) — alt is already escaped; url sanitized
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
      const href = safeUrl(url);
      return href ? `<img class="card-img" alt="${alt}" src="${href}" loading="lazy" />` : esc(m);
    })
    // links: [text](url) — http/attachment links; else a repo file path → open-link
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
      const href = safeUrl(url);
      if (href) {
        const ext = /^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
        return `<a href="${href}"${ext}>${text}</a>`;
      }
      const f = looksLikeFile(url);
      return f ? fileLinkHtml(text, f) : text;
    })
    // inline code — a `path/to/file.ext` becomes a click-to-open link
    .replace(/`([^`]+)`/g, (m, content) => {
      const f = looksLikeFile(content);
      return f ? fileLinkHtml(`<code>${content}</code>`, f) : `<code>${content}</code>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}
function mdToHtml(md) {
  const lines = md.split('\n');
  let html = '', inList = false, inCode = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (const line of lines) {
    if (line.startsWith('```')) {
      closeList();
      html += inCode ? '</code></pre>' : '<pre><code>';
      inCode = !inCode;
      continue;
    }
    if (inCode) { html += esc(line) + '\n'; continue; }
    const h = line.match(/^(#{1,3}) (.*)/);
    const todo = line.match(/^- \[( |x)\] (.*)/i);
    const li = line.match(/^[-*] (.*)/) || line.match(/^(\d+)\. (.*)/);
    if (h) { closeList(); html += `<h2>${inline(h[2])}</h2>`; }
    else if (todo) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li class="${todo[1].toLowerCase() === 'x' ? 'done' : 'todo'}">${inline(todo[2])}</li>`;
    } else if (li) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(li[2] ?? li[1])}</li>`;
    } else if (line.trim() === '') closeList();
    else { closeList(); html += `<p>${inline(line)}</p>`; }
  }
  closeList();
  return html;
}

/* ── live sync ── */
function connectWs() {
  const ws = new WebSocket(`ws://${location.host}/?token=${token}`);
  ws.onopen = () => {
    $('#conn').classList.remove('down');
    $('#conn-label').textContent = 'SYNC';
    loadProjects().then(loadBoard).catch(() => {}); // refetch anything missed while disconnected
  };
  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'board-changed' && msg.project === currentProject) loadBoard();
    else if (msg.type === 'run-state' && msg.project === currentProject) {
      if (msg.state === 'idle') delete runStates[msg.card];
      else runStates[msg.card] = { state: msg.state, stage: msg.stage };
      if (msg.card === drawerCard) {
        $('#drawer-cancel').hidden = msg.state === 'idle' || !runStates[msg.card];
        if (msg.state === 'running') $('#drawer-run').hidden = false;
        else backfillRunLog(drawerCard); // run ended — keep its log, now as "last run"
      }
      renderBoard();
    } else if (msg.type === 'run-event' && msg.project === currentProject && msg.card === drawerCard) {
      $('#drawer-run').hidden = false;
      appendRunEvent(msg.event);
    } else if (msg.type === 'banners') {
      renderBanners(msg.banners);
    }
  };
  ws.onclose = () => {
    $('#conn').classList.add('down');
    $('#conn-label').textContent = 'DOWN';
    setTimeout(connectWs, 2000);
  };
}

/* ── theme toggle ── */
$('#theme-btn').addEventListener('click', () => {
  const light = document.body.classList.toggle('light');
  localStorage.setItem('todomd-theme', light ? 'light' : 'dark');
});

/* ── column settings: locked-core/editable prompt + per-column agent/model ── */
let promptCommands = [];
let promptDefaults = { agent: 'claude', model: '' };
let routingColumn = null;
// the column's effective agent/model = its own override, else the board default
function renderRoutingNote(item) {
  const agent = item.agent || `${promptDefaults.agent} (board)`;
  const model = item.model || (promptDefaults.model ? `${promptDefaults.model} (board)` : 'CLI default');
  $('#stage-routing-note').textContent = `runs as ${agent} · ${model} — a card can still override per-card`;
}
async function updateRoutingRow(item) {
  const row = $('#prompt-routing');
  if (!item || !item.stage) { row.hidden = true; routingColumn = null; return; }
  routingColumn = item.column;
  $('#stage-agent').value = item.agent || '';
  $('#stage-model').value = item.model || '';
  row.hidden = false;
  await setModelOptions(item.agent || promptDefaults.agent); // suggestions match the effective vendor
  renderRoutingNote(item);
}
async function loadPromptCommand(command) {
  const out = await api(`commands/${encodeURIComponent(command)}?project=${encodeURIComponent(currentProject)}`);
  $('#prompt-locked').textContent = out.locked || '';
  $('#prompt-custom').value = out.custom || '';
  const item = promptCommands.find((c) => c.command === command);
  $('#prompt-meta').textContent = item ? `${item.command}.md${item.exists ? '' : ' · (new)'}` : `${command}.md`;
  await updateRoutingRow(item);
}
// open the editor, optionally pre-targeted to a column's command
async function openPromptEditor(command) {
  if (!currentProject) return;
  try {
    const { commands, defaultAgent, defaultModel } = await api(`commands?project=${encodeURIComponent(currentProject)}`);
    promptCommands = commands;
    promptDefaults = { agent: defaultAgent || 'claude', model: defaultModel || '' };
    $('#prompt-select').innerHTML = commands.map((c) => `<option value="${esc(c.command)}">${esc(c.column)} — ${esc(c.command)}</option>`).join('');
    const target = (command && commands.some((c) => c.command === command)) ? command : commands[0]?.command;
    if (target) { $('#prompt-select').value = target; await loadPromptCommand(target); }
    $('#prompts-backdrop').hidden = false;
  } catch (e) { toast(e.message); }
}
// per-column routing saves immediately on change (like the per-card drawer)
async function saveRouting(patch) {
  if (!routingColumn || !currentProject) return false;
  try {
    const res = await fetch(`/api/stages?project=${encodeURIComponent(currentProject)}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ column: routingColumn, ...patch }),
    });
    const out = await res.json();
    if (!res.ok) { toast(out.error || 'save failed'); return false; }
    return true;
  } catch { toast('server unreachable'); return false; }
}
$('#prompts-btn').addEventListener('click', () => openPromptEditor());
$('#prompt-select').addEventListener('change', (e) => loadPromptCommand(e.target.value).catch((x) => toast(x.message)));
$('#stage-agent').addEventListener('change', async (e) => {
  const col = routingColumn, item = promptCommands.find((c) => c.column === col);
  if (await saveRouting({ agent: e.target.value }) && item) {
    item.agent = e.target.value;
    await setModelOptions(item.agent || promptDefaults.agent);
    renderRoutingNote(item); toast(`${col} agent saved`);
  }
});
$('#stage-model').addEventListener('change', async (e) => {
  const col = routingColumn, item = promptCommands.find((c) => c.column === col);
  if (await saveRouting({ model: e.target.value }) && item) {
    item.model = e.target.value.replace(/[^\w.-]/g, '');
    renderRoutingNote(item); toast(`${col} model saved`);
  }
});
$('#prompts-close').addEventListener('click', () => { $('#prompts-backdrop').hidden = true; });
$('#prompts-backdrop').addEventListener('click', (e) => { if (e.target.id === 'prompts-backdrop') $('#prompts-backdrop').hidden = true; });
$('#prompt-save').addEventListener('click', async () => {
  const command = $('#prompt-select').value;
  try {
    const res = await fetch(`/api/commands/${encodeURIComponent(command)}?project=${encodeURIComponent(currentProject)}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ custom: $('#prompt-custom').value }),
    });
    const out = await res.json();
    toast(res.ok ? `saved ${command}` : (out.error || 'save failed'));
    if (res.ok) { const it = promptCommands.find((c) => c.command === command); if (it) it.exists = true; }
  } catch { toast('server unreachable'); }
});

/* ── email intake (IMAP) settings ── */
const intakeForm = $('#intake-form');
$('#intake-btn').addEventListener('click', async () => {
  if (!currentProject) return;
  $('#intake-project').textContent = currentProject;
  $('#intake-status').textContent = '';
  try {
    const c = await api(`intake?project=${encodeURIComponent(currentProject)}`);
    intakeForm.host.value = c.host; intakeForm.port.value = c.port; intakeForm.secure.checked = c.secure;
    intakeForm.user.value = c.user; intakeForm.folder.value = c.folder;
    intakeForm.pollSeconds.value = c.pollSeconds; intakeForm.assignee.value = c.assignee;
    intakeForm.pass.value = '';
    intakeForm.pass.placeholder = c.hasPassword ? 'saved — leave blank to keep' : 'app-specific password';
    $('#intake-backdrop').hidden = false;
  } catch (e) { toast(e.message); }
});
$('#intake-close').addEventListener('click', () => { $('#intake-backdrop').hidden = true; });
$('#intake-backdrop').addEventListener('click', (e) => { if (e.target.id === 'intake-backdrop') $('#intake-backdrop').hidden = true; });
function intakePayload() {
  const f = intakeForm;
  return {
    host: f.host.value.trim(), port: Number(f.port.value), secure: f.secure.checked,
    user: f.user.value.trim(), pass: f.pass.value, folder: f.folder.value.trim(),
    pollSeconds: Number(f.pollSeconds.value), assignee: f.assignee.value.trim(),
  };
}
intakeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await fetch(`/api/intake?project=${encodeURIComponent(currentProject)}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(intakePayload()),
    });
    const out = await res.json();
    if (!res.ok) return toast(out.error || 'save failed');
    toast('intake settings saved'); $('#intake-backdrop').hidden = true;
  } catch { toast('server unreachable'); }
});
$('#intake-test').addEventListener('click', async () => {
  // save first so the test uses the entered settings, then test
  $('#intake-status').textContent = 'saving + testing…';
  try {
    await fetch(`/api/intake?project=${encodeURIComponent(currentProject)}`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(intakePayload()),
    });
    const res = await fetch(`/api/intake/test?project=${encodeURIComponent(currentProject)}`, { method: 'POST', headers });
    const r = await res.json();
    $('#intake-status').textContent = r.ok
      ? `✓ connected — folder "${r.folder}", ${r.unseen} unseen message(s)`
      : `✗ ${r.error}`;
  } catch { $('#intake-status').textContent = '✗ server unreachable'; }
});

/* ── manage projects ── */
async function renderProjectList() {
  const { projects } = await api('projects');
  $('#proj-list').innerHTML = projects.map((p) =>
    `<li><span>${esc(p)}</span><button class="proj-remove" data-name="${esc(p)}" title="remove from board">remove</button></li>`
  ).join('');
  $('#proj-list').querySelectorAll('.proj-remove').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      const res = await fetch(`/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE', headers });
      if (res.ok) { toast(`removed ${name}`); await renderProjectList(); await loadProjects(); loadBoard(); }
      else toast('remove failed');
    })
  );
}
$('#manage-projects').addEventListener('click', async () => {
  $('#proj-path').value = '';
  await renderProjectList().catch(() => {});
  $('#projects-backdrop').hidden = false;
  $('#proj-path').focus();
});
$('#projects-close').addEventListener('click', () => { $('#projects-backdrop').hidden = true; });
$('#projects-backdrop').addEventListener('click', (e) => { if (e.target.id === 'projects-backdrop') $('#projects-backdrop').hidden = true; });
async function addProjectByPath() {
  const p = $('#proj-path').value.trim();
  if (!p) return;
  try {
    const res = await fetch('/api/projects', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ path: p }),
    });
    const out = await res.json();
    if (!res.ok) return toast(out.error || 'could not add');
    toast(`added ${out.name}`);
    $('#proj-path').value = '';
    await loadProjects();
    currentProject = out.name; projectSel.value = out.name;
    await renderProjectList();
    loadBoard();
  } catch { toast('server unreachable'); }
}
$('#proj-add').addEventListener('click', addProjectByPath);
$('#proj-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') addProjectByPath(); });

/* ── QR / mobile access ── */
const QR_NOTES = {
  viewer: 'Read-only link for devices on this network — the board streams live, but cards can’t be moved or created from it.',
  full: '⚠ Full-control link: a phone with this QR can move cards and trigger agent runs. Plain HTTP on this network — only use on networks you trust. Revoke any time with `todomd revoke`.',
};
async function openQr() {
  $('#qr-backdrop').hidden = false;
  let lan;
  try { lan = await api('lan'); } catch (e) { return toast(e.message); }
  if (lan.enabled) { $('#qr-enable').hidden = true; $('#qr-view').hidden = false; showQr('viewer'); }
  else { $('#qr-view').hidden = true; $('#qr-enable').hidden = false; }
}
async function showQr(access) {
  try {
    const out = await api(`qr${access === 'full' ? '?access=full' : ''}`);
    $('#qr-svg').innerHTML = out.svg;
    $('#qr-url').textContent = out.url;
    $('#qr-note').textContent = QR_NOTES[access];
    $('#qr-tab-viewer').classList.toggle('active', access === 'viewer');
    $('#qr-tab-full').classList.toggle('active', access === 'full');
  } catch (e) { toast(e.message); }
}
async function setLan(enabled) {
  const res = await fetch('/api/lan', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) });
  const out = await res.json();
  if (!res.ok) { toast(out.error || 'could not change network access'); return false; }
  return true;
}
$('#qr-btn').addEventListener('click', openQr);
$('#qr-enable-go').addEventListener('click', async () => { if (await setLan(true)) openQr(); });
$('#qr-enable-cancel').addEventListener('click', () => { $('#qr-backdrop').hidden = true; });
$('#qr-disable').addEventListener('click', async () => { if (await setLan(false)) { toast('network access off'); $('#qr-backdrop').hidden = true; } });
$('#qr-tab-viewer').addEventListener('click', () => showQr('viewer'));
$('#qr-tab-full').addEventListener('click', () => showQr('full'));
$('#qr-close').addEventListener('click', () => { $('#qr-backdrop').hidden = true; });
$('#qr-backdrop').addEventListener('click', (e) => { if (e.target.id === 'qr-backdrop') $('#qr-backdrop').hidden = true; });

/* ── new card modal ── */
// keep model suggestions in sync with the selected vendor (drawer + new-card modal)
$('#route-agent').addEventListener('change', () => setModelOptions($('#route-agent').value));
$('#card-form [name=agent]').addEventListener('change', (e) => setModelOptions(e.target.value));

const backdrop = $('#modal-backdrop');
$('#new-card').addEventListener('click', () => {
  $('#card-form').reset();
  setModelOptions($('#card-form [name=agent]').value); // suggestions for the default vendor
  backdrop.hidden = false;
  $('#card-form [name=title]').focus();
});
$('#modal-cancel').addEventListener('click', () => { backdrop.hidden = true; });
backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.hidden = true; });
$('#card-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const payload = {
    title: f.get('title'),
    type: f.get('type'),
    priority: f.get('priority'),
    agent: f.get('agent'),
    model: (f.get('model') || '').trim() || undefined,
    skill: (f.get('skill') || '').trim() || undefined,
    assignee: (f.get('assignee') || '').trim() || undefined,
    labels: String(f.get('labels') || '').split(',').map((s) => s.trim()).filter(Boolean),
    description: f.get('description'),
    criteria: String(f.get('criteria') || '').split('\n').map((s) => s.trim()).filter(Boolean),
  };
  try {
    const res = await fetch(`/api/cards?project=${encodeURIComponent(currentProject)}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const out = await res.json();
    if (!res.ok) return toast(out.error || 'create failed');
    backdrop.hidden = true;
    toast(`${out.id} created`);
    loadBoard();
  } catch {
    toast('server unreachable');
  }
});

projectSel.addEventListener('change', () => { currentProject = projectSel.value; loadBoard(); });
filterInput.addEventListener('input', renderBoard);
applyViewToggle();

/* ── getting started ── */
function openGuide() { $('#welcome-backdrop').hidden = false; }
$('#wordmark').addEventListener('click', openGuide);
$('#help-btn').addEventListener('click', openGuide);
$('#welcome-close').addEventListener('click', () => {
  $('#welcome-backdrop').hidden = true;
  localStorage.setItem('todomd-guided', '1');
});
$('#welcome-backdrop').addEventListener('click', (e) => {
  if (e.target.id === 'welcome-backdrop') { $('#welcome-backdrop').hidden = true; localStorage.setItem('todomd-guided', '1'); }
});

loadProjects().then(loadBoard).then(connectWs).then(() => {
  if (!localStorage.getItem('todomd-guided')) openGuide(); // first visit → show the guide
}).catch((e) => {
  boardEl.innerHTML = `<p class="col-empty">${esc(e.message)} — is the token in the URL?</p>`;
});
