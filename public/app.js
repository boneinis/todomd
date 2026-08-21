// Keep the token out of the visible URL/history while preserving the selected
// project and card hash. The project query is intentionally shareable; the
// capability token is not.
const initialParams = new URLSearchParams(location.search);
const initialProject = initialParams.get('project') || '';
const token = initialParams.get('token')
  || sessionStorage.getItem('todomd-token') || '';
if (initialParams.has('token')) {
  sessionStorage.setItem('todomd-token', token);
  initialParams.delete('token');
  const query = initialParams.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
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
let currentProject = initialProject || localStorage.getItem('todomd-project') || null;
let boardData = null;
let boardLoadGeneration = 0;
let runStates = {};
let drawerCard = null;
let myName = localStorage.getItem('todomd-me') || '';
let viewMode = (localStorage.getItem('todomd-view') === 'mine' && myName) ? 'mine' : 'all';
let showArchived = false;   // the "archived" view shows only archived cards
let drawerArchived = false; // is the open card archived?
let deleteArmed = false;    // two-click confirm for delete
let draggedCardId = null;

function compactActivity(value, max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function activityFromRunEvent(event) {
  const content = event?.message?.content || (Array.isArray(event?.content) ? event.content : []);
  for (const block of [...content].reverse()) {
    if (block?.type === 'tool_use') {
      const target = block.input?.path || block.input?.command || block.input?.pattern || '';
      return compactActivity(`${block.name || 'tool'}${target ? ` · ${target}` : ''}`);
    }
    if (block?.type === 'text' && block.text) return compactActivity(block.text);
    if (block?.type === 'thinking') return 'Reasoning through the next step';
  }
  const item = event?.item || {};
  if (item.type === 'command_execution') return compactActivity(item.command || 'Running a command');
  if (item.type === 'mcp_tool_call') return compactActivity(
    [item.server, item.tool].filter(Boolean).join('.') || item.name || 'Running a tool');
  if (item.type === 'file_change') return 'Updating files';
  if (item.type === 'reasoning') return 'Reasoning through the next step';
  if (item.type === 'agent_message' && item.text) return compactActivity(item.text);
  return '';
}

// The classic board script can finish its async load before the voice module
// graph has registered a context listener. Retain the latest safe UI context
// and replay it when voice announces readiness so that one lost event cannot
// leave the initially-hidden control hidden forever.
let latestVoiceContext = null;
function publishVoiceContext(detail) {
  latestVoiceContext = detail;
  document.dispatchEvent(new CustomEvent('todomd:context', { detail }));
}
function setCurrentProject(nextProject) {
  const next = nextProject || null;
  if (next === currentProject) {
    projectSel.value = next || '';
    if (next) localStorage.setItem('todomd-project', next);
    const params = new URLSearchParams(location.search);
    params.delete('token');
    if (next) params.set('project', next);
    else params.delete('project');
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
    return false;
  }
  // Revoke capture before changing project identity. Callers may still need to
  // fetch the replacement board, and that request is allowed to fail without
  // leaving voice bound to the project we just left.
  publishVoiceContext({ project: '', access: 'none', primary: false });
  currentProject = next;
  projectSel.value = next || '';
  if (next) localStorage.setItem('todomd-project', next);
  else localStorage.removeItem('todomd-project');
  const params = new URLSearchParams(location.search);
  params.delete('token');
  if (next) params.set('project', next);
  else params.delete('project');
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  return true;
}
document.addEventListener('todomd:voice-ready', () => {
  if (latestVoiceContext) publishVoiceContext(latestVoiceContext);
});

// project/card pairs whose subtask rows are collapsed — task ids repeat across
// projects, so an id alone would leak UI state when the project selector moves.
// The board is replaced wholesale on every poll, so this can't live in the DOM.
const collapsedEpicIds = new Set();
const epicCollapseKey = (id) => JSON.stringify([currentProject || '', id]);

// model suggestions per vendor — pulled from the provider CLI (server reads
// `<cli> --help` + config), cached per vendor. The card editor still uses the
// shared datalist; column routing copies these values into a real select.
const modelCache = {};
const MODEL_FALLBACKS = {
  codex: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'],
  gemini: ['gemini-3.7-flash-high', 'gemini-3.1-pro-high'],
  claude: ['opus', 'sonnet', 'haiku'],
};
function fillModels(list) {
  $('#model-options').innerHTML = (list || []).map((m) => `<option value="${esc(m)}"></option>`).join('');
}
async function setModelOptions(vendor) {
  vendor = vendor || 'claude';
  if (modelCache[vendor]) { fillModels(modelCache[vendor]); return; }
  fillModels(MODEL_FALLBACKS[vendor] || MODEL_FALLBACKS.claude); // instant default
  if (!currentProject) return;
  try {
    const { models } = await api(`models?agent=${encodeURIComponent(vendor)}&project=${encodeURIComponent(currentProject)}`);
    modelCache[vendor] = models;
    fillModels(models);
  } catch { /* keep the default */ }
}
async function setStageModelOptions(vendor, selected = '') {
  await setModelOptions(vendor);
  const models = [...$('#model-options').querySelectorAll('option')].map((o) => o.value);
  if (selected && !models.includes(selected)) models.unshift(selected);
  $('#stage-model').innerHTML = [
    '<option value="">board default</option>',
    ...models.map((model) => `<option value="${esc(model)}">${esc(model)}</option>`),
  ].join('');
  $('#stage-model').value = selected;
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
  const selected = (!currentProject || !projects.includes(currentProject)) ? projects[0] : currentProject;
  setCurrentProject(selected); // also fences voice if reconnect discovers the old project disappeared
}

async function loadBoard() {
  const requestedProject = currentProject;
  const generation = ++boardLoadGeneration;
  if (!requestedProject) { // no projects (e.g. the last one was removed) — show an empty state
    boardData = null;
    boardEl.innerHTML = `<div class="empty-board">
      <h2>No project yet</h2>
      <p>Add a git repo with the <b>⊕</b> button (paste its path), or run <code>todomd init</code> in a repo's terminal — then refresh.</p>
      <p><button id="empty-guide" class="modal-submit">open the Getting Started guide</button></p>
    </div>`;
    $('#empty-guide')?.addEventListener('click', openGuide);
    // no board to point voice at (e.g. the last project was just removed) —
    // tell voice/main.js so an armed/active session doesn't keep running
    // against a project that no longer has a board behind it
    publishVoiceContext({ project: '', access: 'none', primary: false });
    return;
  }
  const nextBoard = await api(`board?project=${encodeURIComponent(requestedProject)}${showArchived ? '&archived=1' : ''}`);
  // A project switch can finish its newer request before this one. Never let a
  // late response redraw the old board or republish its access as if it belonged
  // to the newly-selected project.
  if (generation !== boardLoadGeneration || requestedProject !== currentProject) return;
  boardData = nextBoard;
  (boardData.cards || []).forEach(normalizeCardLists);
  runStates = boardData.runStates || {};
  renderBanners(boardData.banners || []);
  const usage = boardData.usage || {};
  const modeTag = boardData.mode === 'budget' ? ' · budget' : '';
  const viewer = boardData.access === 'viewer';
  const pausedTag = usage.queue_paused ? ' · queue paused' : '';
  const runsTag = usage.model_runs ? `${usage.model_runs} AI run${usage.model_runs === 1 ? '' : 's'}` : '';
  const tokenTag = usage.tokens && usage.model_runs
    ? `${compactNumber(usage.tokens.input_tokens)} in / ${compactNumber(usage.tokens.output_tokens)} out`
    : '';
  const unavailableTag = usage.unavailable_usage_runs ? `${usage.unavailable_usage_runs} usage unavailable` : '';
  const costTag = usage.month_cost_usd ? `$${usage.month_cost_usd.toFixed(2)} legacy est` : '';
  $('#usage').textContent = [costTag, runsTag, tokenTag, unavailableTag].filter(Boolean).join(' · ') + modeTag + pausedTag + (viewer ? ' · monitor' : '');
  const providers = Object.entries(usage.by_provider || {}).map(([provider, item]) =>
    `${provider}: ${item.runs} run${item.runs === 1 ? '' : 's'}, ${compactNumber(item.tokens?.input_tokens)} input, ${compactNumber(item.tokens?.cached_input_tokens)} cached, ${compactNumber(item.tokens?.output_tokens)} output${item.unavailable_usage_runs ? `, ${item.unavailable_usage_runs} unavailable` : ''}`);
  $('#usage').title = ['Current-month normalized model usage. Dollar value is provider-reported legacy estimate, not a bill.', ...providers].join('\n');
  document.body.classList.toggle('viewer', viewer);
  applyQueuePause(usage.queue_paused === true);
  renderBoard();
  const targetHash = (location.hash || '').slice(1);
  if (targetHash && /^task-[\w-]+$/.test(targetHash) && !drawerCard) {
    const cardExists = (boardData.cards || []).some((c) => c.id === targetHash);
    if (cardExists) openDrawer(targetHash);
  }
  // voice/main.js is a separate ES module (see index.html) with no access to
  // this classic script's top-level scope — this is the only bridge it needs.
  publishVoiceContext({ project: requestedProject, access: boardData.access, primary: boardData.primary === true });
}

function compactNumber(value) {
  const n = Number(value) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function applyQueuePause(paused) {
  const btn = $('#queue-pause');
  const run = $('#queue-run');
  const readOnly = !boardData || boardData.access !== 'full';
  btn.textContent = paused ? 'resume queue' : 'pause queue';
  btn.classList.toggle('active', paused);
  btn.setAttribute('aria-pressed', String(paused));
  btn.disabled = readOnly;
  run.disabled = readOnly || boardData.mode === 'budget' || paused;
  run.title = paused
    ? 'resume this project queue before running it'
    : 'wake this project\'s already-approved Queue cards';
  btn.title = paused
    ? 'resume starting parked Queue cards'
    : 'let active work finish, then hold new starts';
}

$('#queue-pause').addEventListener('click', async () => {
  if (!currentProject || !boardData || boardData.access !== 'full') return;
  const btn = $('#queue-pause');
  const paused = boardData.usage?.queue_paused === true;
  btn.disabled = true;
  try {
    const res = await fetch(`/api/queue/${paused ? 'resume' : 'pause'}?project=${encodeURIComponent(currentProject)}`,
      { method: 'POST', headers });
    const out = await res.json();
    if (!res.ok) return toast(out.error || `could not ${paused ? 'resume' : 'pause'} queue`);
    boardData.usage = { ...(boardData.usage || {}), queue_paused: out.queue_paused === true };
    applyQueuePause(out.queue_paused === true);
    toast(out.queue_paused ? 'queue paused — active work will finish' : 'queue resumed');
    await loadBoard();
  } catch {
    toast('server unreachable');
  } finally {
    btn.disabled = false;
  }
});

$('#queue-run').addEventListener('click', async () => {
  if (!currentProject || !boardData || boardData.access !== 'full') return;
  const btn = $('#queue-run');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/queue/kick?project=${encodeURIComponent(currentProject)}`,
      { method: 'POST', headers });
    const out = await res.json();
    if (!res.ok) return toast(out.error || 'could not run queue');
    toast(out.enqueued ? `queued ${out.enqueued} card${out.enqueued === 1 ? '' : 's'}` : 'queue already up to date');
    await loadBoard();
  } catch {
    toast('server unreachable');
  } finally {
    btn.disabled = false;
  }
});

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
  Queue: 'Approved & waiting to build. An agent picks it up automatically (launcher mode) or via your /loop dispatcher (budget mode). Manually paused and quota-paused cards wait here without losing work.',
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
  const passesView = (c) =>
    (showArchived ? c.archived : true) && // archived view shows only archived cards
    (!mine || String(c.assignee || '').toLowerCase() === mine) &&
    (!filter || `${c.id} ${c.title} ${asList(c.labels).join(' ')} ${String(c.assignee || '')}`.toLowerCase().includes(filter));
  // ids that nest under an epic card THIS render: structurally nestable (per
  // hierarchy.js), and their epic parent will actually be shown. A parent
  // hidden by the filter/mine/archived view must not swallow a child that
  // still matches — the child surfaces as its own full card instead.
  const byId = new Map(boardData.cards.map((c) => [c.id, c]));
  const nested = TodomdHierarchy.nestedChildIds(boardData.cards, boardData.config);
  const boardColumns = new Set(boardData.config.columns || []);
  const shownNested = new Set(
    [...nested].filter((id) => {
      const child = byId.get(id);
      const parent = byId.get(child?.parent);
      return child && parent?.epic && passesView(child) && passesView(parent)
        && boardColumns.has(parent.status) && !nested.has(parent.id);
    })
  );
  boardEl.innerHTML = '';
  for (const col of boardData.config.columns) {
    const color = COL_COLORS[col] || 'var(--dim)';
    // .col-count must match what's actually appended below — a nested child is
    // rendered inside its epic's card, not as a card of its own here.
    const cards = boardData.cards.filter(
      (c) => c.status === col && passesView(c) && !shownNested.has(c.id)
    ).sort((a, b) => {
      const ao = Number(a.board_order), bo = Number(b.board_order);
      const aRanked = Number.isFinite(ao), bRanked = Number.isFinite(bo);
      if (aRanked && bRanked && ao !== bo) return ao - bo;
      if (aRanked !== bRanked) return aRanked ? -1 : 1;
      return String(a.file || a.id || '').localeCompare(String(b.file || b.id || ''));
    });
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
    colEl.innerHTML = `<header class="col-head"><span class="col-name">${esc(col)} <button class="col-help-btn" title="what does this column do?">?</button></span><span class="col-head-right"><span class="col-count">${cards.length}</span>${editBtn}</span></header>`;
    colEl.querySelector('.col-help-btn')?.addEventListener('click', (e) => { e.stopPropagation(); showColHelp(col, e.currentTarget); });
    colEl.querySelector('.col-edit')?.addEventListener('click', (e) => { e.stopPropagation(); openPromptEditor(e.currentTarget.dataset.cmd); });
    const list = document.createElement('div');
    list.className = 'col-cards';
    if (!cards.length) list.innerHTML = `<p class="col-empty">empty</p>`;
    cards.forEach((card, i) => list.appendChild(renderCard(card, color, i, shownNested)));
    colEl.appendChild(list);
    wireDrop(colEl, list);
    boardEl.appendChild(colEl);
  }
}

// hand-edited cards can make labels a YAML mapping or a bare string — coerce
// to a list of strings so no card shape can throw and abort the whole render
const asList = (x) => (Array.isArray(x) ? x : x ? [x] : []).map(String);
// The board is markdown files people edit by hand, and chunk cards are written
// by an agent — so EVERY list field can arrive as a scalar, a mapping, or
// missing. Normalize once, where card data enters, rather than at each use
// site: coercing per-site is how a scalar `dependencies:` reached
// `.some(...)` inside the board render and blanked the entire board.
const LIST_FIELDS = ['labels', 'dependencies', 'children'];
function normalizeCardLists(card) {
  const target = card?.data || card; // /api/board cards are flat; /api/cards/:id nests under .data
  if (!target) return card;
  for (const f of LIST_FIELDS) if (f in target) target[f] = asList(target[f]);
  return card;
}
// label pills: a stable hue per label text (chip-c0..chip-c5 in the stylesheet)
function labelHue(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 6;
}
// avatar disc shows 1–2 initials ("Sam Ortiz" → SO, "sam.ortiz" → SO, "sam" → S)
function initials(name) {
  const parts = String(name).trim().split(/[\s.@_-]+/).filter(Boolean);
  return (parts[0]?.[0] || '?').toUpperCase() + (parts[1]?.[0] || '').toUpperCase();
}

// one subtask row: title, status, dependency state, assignee — click opens
// that child's drawer. stopPropagation so the click doesn't also fire the
// parent epic card's own click handler (which would open the epic instead).
function renderSubtaskRow(kid) {
  const el = $('#subtask-row-tpl').content.firstElementChild.cloneNode(true);
  el.dataset.id = kid.id;
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `open ${kid.title || kid.id}`);
  el.querySelector('.subtask-title').textContent = kid.title || kid.id;
  el.querySelector('.subtask-status').textContent = kid.status || '';
  const dep = el.querySelector('.subtask-dep');
  const { blocked, waitingOn } = TodomdHierarchy.dependencyState(kid, boardData.cards);
  dep.textContent = blocked ? `🔒 waiting on ${waitingOn.map((item) => item.id).join(', ')}` : 'ready';
  const av = el.querySelector('.subtask-assignee');
  if (kid.assignee) { av.textContent = initials(kid.assignee); av.title = `@${kid.assignee}`; }
  else { av.textContent = 'unassigned'; av.classList.add('unassigned'); }
  const open = (e) => { e.stopPropagation(); openDrawer(kid.id); };
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); }
  });
  return el;
}

function renderCard(card, color, i, nestedIds) {
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
  const tldr = el.querySelector('.card-tldr');
  tldr.textContent = card.tldr || '';
  tldr.hidden = !card.tldr;
  // label pills — a needs-human flag replaces them with a warning pill
  const chips = el.querySelector('.card-chips');
  if (card.needs_human_reason) {
    chips.innerHTML = `<span class="chip chip-warn">⚠ ${esc(String(card.needs_human_reason))}</span>`;
  } else {
    const pills = [];
    if (card.type) pills.push(`<span class="chip chip-type">${esc(String(card.type))}</span>`);
    for (const l of asList(card.labels)) pills.push(`<span class="chip chip-c${labelHue(l)}">${esc(l)}</span>`);
    chips.innerHTML = pills.join('');
  }
  const av = el.querySelector('.card-assignee');
  if (card.assignee) {
    const who = String(card.assignee);
    av.textContent = initials(who); av.title = `@${who}`;
  }
  const crit = el.querySelector('.card-criteria');
  if (card.criteria) {
    crit.textContent = `☑ ${card.criteria.done}/${card.criteria.total}`;
    if (card.criteria.done === card.criteria.total) crit.classList.add('complete');
  }
  // epic/chunk relationship badge (sequential chunking)
  const rel = el.querySelector('.card-rel');
  if (card.epic) {
    const { done, total } = TodomdHierarchy.epicProgress(boardData.cards, card.id);
    rel.textContent = `⊞ epic ${done}/${total}`;
    const epicBox = el.querySelector('.card-epic');
    const subtasksEl = el.querySelector('.card-subtasks');
    const kids = TodomdHierarchy.childrenOf(boardData.cards, card.id)
      .filter((k) => nestedIds && nestedIds.has(k.id));
    if (kids.length) {
      epicBox.hidden = false;
      epicBox.querySelector('.epic-progress-fill').style.width = `${total ? (done / total) * 100 : 0}%`;
      const collapseKey = epicCollapseKey(card.id);
      const collapsed = collapsedEpicIds.has(collapseKey);
      const toggle = epicBox.querySelector('.epic-toggle');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.textContent = `${collapsed ? '▸' : '▾'} ${kids.length} subtask${kids.length === 1 ? '' : 's'}`;
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (collapsed) collapsedEpicIds.delete(collapseKey); else collapsedEpicIds.add(collapseKey);
        renderBoard();
      });
      subtasksEl.hidden = collapsed;
      subtasksEl.innerHTML = '';
      for (const kid of kids) subtasksEl.appendChild(renderSubtaskRow(kid));
    }
  } else if (card.parent) {
    // dependencyState tolerates a scalar/mapping/missing `dependencies:` — this
    // runs inside the board render, so one hand-edited card must not throw and
    // blank the WHOLE board
    const { blocked } = TodomdHierarchy.dependencyState(card, boardData.cards);
    rel.textContent = blocked ? '⊞ chunk 🔒' : '⊞ chunk';
    if (blocked) rel.classList.add('blocked');
  }
  const rs = runStates[card.id];
  const runEl = el.querySelector('.card-run');
  if (rs?.state === 'running') {
    el.classList.add('running');
    runEl.textContent = `● ${rs.stage}`;
  } else if (rs?.state === 'deferred') {
    el.classList.add('deferred');
    runEl.textContent = `⏸ deferred${rs.reason ? `: ${rs.reason}` : ''}`;
    runEl.title = rs.reason || '';
  } else if (rs?.state === 'deferred-for-load') {
    // a CI job the machine's resource governor gracefully cancelled and
    // requeued at CRITICAL pressure — distinct from an ordinary 'deferred'
    // capacity/resource wait so it reads as "this was running, then paused
    // for load", not "never got a chance to start"
    el.classList.add('deferred-for-load');
    runEl.textContent = `⚠ paused for load${rs.reason ? `: ${rs.reason}` : ''}`;
    runEl.title = rs.reason || '';
  } else if (rs?.state === 'queued') {
    el.classList.add('queued');
    runEl.textContent = '◌ queued';
  } else if (rs?.state === 'passed') {
    el.classList.add('passed');
    runEl.textContent = `✓ ${rs.stage} passed`;
  } else if (rs?.state === 'failed') {
    el.classList.add('failed');
    runEl.textContent = `✕ ${rs.stage} failed`;
  }
  el.addEventListener('dragstart', (e) => {
    draggedCardId = card.id;
    e.dataTransfer.setData('text/todomd-id', card.id);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    draggedCardId = null;
    el.classList.remove('dragging');
    clearDropIndicators();
  });
  el.addEventListener('click', () => openDrawer(card.id));
  return el;
}

const ORCH_ONLY = new Set(['Planned', 'Build', 'Verify', 'Done', 'Needs Human']);

function isHumanMoveAllowed(from, to, card, boardData) {
  if (!from || !to || from === to) return false;
  if (to === 'Review') return true;
  if (to === 'Planned' && from === 'Needs Human') return true;
  if (from === 'Needs Human' && (to === 'Queue' || to === 'Build')) return true;
  if (to === 'Queue' && from === 'Planned') return true;

  const stages = boardData?.config?.stages || {};
  const isStageCol = stages[to] && !['Build', 'Verify'].includes(to);
  if (isStageCol) {
    if (to === 'Plan' && ['Review', 'Planned', 'Needs Human'].includes(from)) return true;
  }

  if (!ORCH_ONLY.has(to) && to !== 'Queue' && !stages[to]) return true;

  return false;
}

function clearDropIndicators() {
  document.querySelectorAll('.column.drag-over').forEach((el) => el.classList.remove('drag-over'));
  document.querySelectorAll('.column.drag-invalid').forEach((el) => el.classList.remove('drag-invalid'));
  document.querySelectorAll('.card.drop-before').forEach((el) => el.classList.remove('drop-before'));
  document.querySelectorAll('.col-cards.drop-at-end').forEach((el) => el.classList.remove('drop-at-end'));
  document.querySelectorAll('.col-cards[data-drop-before]').forEach((el) => delete el.dataset.dropBefore);
}

function wireDrop(colEl, listEl) {
  colEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    const source = findBoardCard(draggedCardId);
    clearDropIndicators();
    if (!source) return;

    const targetCol = colEl.dataset.status;
    const sameColumn = source.status === targetCol;
    const allowed = sameColumn || isHumanMoveAllowed(source.status, targetCol, source, boardData);

    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = allowed ? 'move' : 'none';
    }

    if (!allowed) {
      colEl.classList.add('drag-invalid');
      return;
    }

    if (!sameColumn) {
      colEl.classList.add('drag-over');
      return;
    }

    // Native DnD gives us the pointer Y even when it is over a child inside a
    // card. Compare it with every other card's midpoint; the first midpoint
    // below the pointer is the persisted `beforeId`. Excluding the source
    // avoids the classic A-after-B → "insert before A" self-reference.
    const peers = [...listEl.querySelectorAll(':scope > .card')]
      .filter((el) => el.dataset.id !== draggedCardId);
    const before = peers.find((el) => e.clientY < el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2);
    listEl.dataset.dropBefore = before?.dataset.id || '';
    if (before) before.classList.add('drop-before');
    else listEl.classList.add('drop-at-end');
  });
  colEl.addEventListener('dragleave', (e) => {
    if (!colEl.contains(e.relatedTarget)) clearDropIndicators();
  });
  colEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/todomd-id');
    const source = findBoardCard(id);
    const targetCol = colEl.dataset.status;
    const sameColumn = source?.status === targetCol;
    const beforeId = listEl.dataset.dropBefore || null;
    clearDropIndicators();
    if (!id) return;

    if (!sameColumn && !isHumanMoveAllowed(source?.status, targetCol, source, boardData)) {
      toast(`${targetCol} is set by the orchestrator`);
      return;
    }

    try {
      const action = sameColumn ? 'reorder' : 'move';
      const res = await fetch(`/api/cards/${id}/${action}?project=${encodeURIComponent(currentProject)}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(sameColumn ? { beforeId } : { status: targetCol }),
      });
      const out = await res.json();
      if (!res.ok) toast(out.error || 'move failed');
      else if (out.warning) toast(out.warning);
      else if (sameColumn) toast('priority updated');
    } catch {
      toast('server unreachable — move not saved');
    }
    loadBoard();
  });
}

/* ── drawer relationship helpers ── */
function findBoardCard(id) {
  return boardData?.cards?.find((c) => c.id === id);
}

function relChip(id, label) {
  const bc = findBoardCard(id);
  const status = bc ? esc(bc.status) : '?';
  const displayLabel = label || id;
  return `<button type="button" class="rel-chip" data-id="${esc(id)}">${esc(displayLabel)} <span class="rel-status">${status}</span></button>`;
}

// `state` is this card's TodomdHierarchy.dependencyState(...): waitingOn holds
// only the blocking dependencies, so an id absent from it is Done
function depChip(id, state) {
  const waiting = state.waitingOn.find((w) => w.id === id);
  const done = !waiting;
  const status = done ? 'Done' : (waiting.status || '?');
  return `<span class="dep-chip ${done ? 'dep-done' : 'dep-blocked'}">${done ? '' : '🔒 '}${esc(id)} <span class="rel-status">${esc(status)}</span></span>`;
}

// Splits the raw "## Chunks" section (planner's fenced yaml breakdown, plus any
// trailing prose) out of a card body — mirrors src/board.js parseChunks's
// fenced-aware "## " heading split exactly, so the drawer's idea of "the
// Chunks section" and the parser's idea never disagree.
function splitChunksSection(body) {
  const raw = body || '';
  let fenced = false;
  const sections = [{ prefix: '', text: '' }];
  for (const ln of raw.split('\n')) {
    if (/^\s*(```|~~~)/.test(ln)) fenced = !fenced;
    if (!fenced && /^## /.test(ln)) sections.push({ prefix: '## ', text: ln.slice(3) + '\n' });
    else sections[sections.length - 1].text += ln + '\n';
  }
  const idx = sections.findIndex((s) => s.prefix && /^Chunks\s*(\r?\n|$)/.test(s.text));
  if (idx === -1) return { body: raw, planner: '' };
  const planner = sections[idx].text.replace(/^Chunks\r?\n?/, '').trim();
  const body2 = sections.filter((_, i) => i !== idx).map((s) => s.prefix + s.text).join('');
  return { body: body2, planner };
}

/* ── drawer tabs: Details / Subtasks (epics only) ── */
let drawerTab = 'details';
let drawerReturnFocus = null;
// Generation token for openDrawer's in-flight card fetch. Opening or closing the
// modal invalidates any open still awaiting its response, so a reply that lands
// after an Escape (or after you moved on to another card) can't re-show the
// modal or overwrite fresher content — same idea as backfillRunLog's guard.
let drawerOpenSeq = 0;
const drawerEl = $('#drawer');
const drawerBackdropEl = $('#drawer-backdrop');
const drawerBackground = [document.querySelector('.topbar'), $('#banners'), boardEl].filter(Boolean);

function drawerFocusable() {
  return [...drawerEl.querySelectorAll('button, [href], input, select, textarea, details > summary, [tabindex]')]
    .filter((el) => !el.disabled && el.tabIndex !== -1 && !el.closest('[hidden]') && el.getClientRects().length);
}

function showDrawer() {
  if (drawerEl.hidden) drawerReturnFocus = document.activeElement;
  drawerBackdropEl.hidden = false;
  drawerEl.hidden = false;
  drawerBackground.forEach((el) => { el.inert = true; });
  requestAnimationFrame(() => $('#drawer-close').focus());
}

function closeDrawer() {
  drawerEl.hidden = true;
  drawerBackdropEl.hidden = true;
  drawerBackground.forEach((el) => { el.inert = false; });
  drawerOpenSeq++; // a pending open must not re-show the modal after this close
  drawerCard = null;
  if (location.hash) {
    history.replaceState(null, '', location.pathname + location.search);
  }
  const target = drawerReturnFocus;
  drawerReturnFocus = null;
  if (target?.isConnected) target.focus();
}

function setDrawerTab(tab) {
  drawerTab = tab;
  $('#drawer-details').hidden = tab !== 'details';
  $('#drawer-subtasks').hidden = tab !== 'subtasks';
  document.querySelectorAll('.drawer-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
}
$('#drawer-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.drawer-tab');
  if (btn) setDrawerTab(btn.dataset.tab);
});

/* ── drawer ── */
function relativeRunTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return ms < 10_000 ? 'now' : `${Math.max(1, Math.floor(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h${minutes ? ` ${minutes}m` : ''}`;
}

function renderBuildProgress(id = drawerCard) {
  const panel = $('#drawer-build-progress');
  if (!panel) return;
  const state = id ? runStates[id] : null;
  const visible = state?.state === 'running' && state?.stage === 'Build';
  panel.hidden = !visible;
  if (!visible) return;

  const progress = state.progress || {};
  const nowMs = Date.now();
  const startedMs = Date.parse(progress.startedAt || '');
  const activityMs = Date.parse(progress.lastActivityAt || progress.startedAt || '');
  const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0;
  const quietMs = Number.isFinite(activityMs) ? Math.max(0, nowMs - activityMs) : elapsedMs;
  const health = quietMs >= 10 * 60_000 ? 'at-risk' : quietMs >= 2 * 60_000 ? 'quiet' : 'active';
  panel.classList.toggle('quiet', health === 'quiet');
  panel.classList.toggle('at-risk', health === 'at-risk');
  $('#build-progress-state').textContent = health === 'at-risk' ? 'check agent' : health;

  const slice = Number(progress.slice) || 1;
  const maxSlices = Number(progress.maxSlices) || 1;
  const budgetMinutes = Number(progress.budgetMinutes) || 0;
  $('#build-progress-slice').textContent = `slice ${slice}/${maxSlices}`;
  $('#build-progress-elapsed').textContent = relativeRunTime(elapsedMs);
  $('#build-progress-activity-age').textContent = relativeRunTime(quietMs);
  $('#build-progress-files').textContent = Number.isFinite(Number(progress.changedPaths))
    ? String(Number(progress.changedPaths)) : '—';
  const budgetMs = budgetMinutes * 60_000;
  $('#build-progress-fill').style.width = `${budgetMs ? Math.min(100, (elapsedMs / budgetMs) * 100) : 0}%`;
  $('#build-progress-current').textContent = progress.activity ||
    (health === 'at-risk' ? 'No agent event has arrived recently. The stage watchdog is still monitoring the process.'
      : 'Agent process is running; waiting for its next visible update.');

  const checkpoint = progress.lastCheckpoint;
  $('#build-progress-checkpoint').textContent = checkpoint
    ? `${checkpoint.progressed ? 'Progress detected' : 'No worktree progress'} at checkpoint ${checkpoint.slice}/${maxSlices}` +
      `${Number.isFinite(Number(checkpoint.changedPaths)) ? ` · ${Number(checkpoint.changedPaths)} changed paths` : ''}` +
      `${progress.noProgressSlices ? ` · ${progress.noProgressSlices} consecutive quiet checkpoint${progress.noProgressSlices === 1 ? '' : 's'}` : ''}.`
    : `No checkpoint yet. Productive turn-limit checkpoints continue automatically` +
      `${budgetMinutes ? ` within this ${budgetMinutes}-minute window` : ''}.`;
}

setInterval(() => renderBuildProgress(), 15_000);

async function openDrawer(id) {
  const seq = ++drawerOpenSeq;
  const card = normalizeCardLists(await api(`cards/${id}?project=${encodeURIComponent(currentProject)}`));
  // Bail before touching the DOM if the modal was closed (Escape/backdrop/close)
  // or another card was opened while this fetch was in flight — otherwise
  // showDrawer() below would re-open the modal with drawerCard already cleared,
  // leaving every action button (answer, move, archive, delete…) a silent no-op.
  if (seq !== drawerOpenSeq) return;
  // Do not point action controls at the requested card until its data is ready
  // to replace the currently rendered card. During a slow child fetch the old
  // card remains visible, so its controls must continue to target that old ID.
  drawerCard = id;
  if (location.hash !== '#' + id) {
    history.replaceState(null, '', '#' + id);
  }
  $('#run-log').textContent = '';
  const drawerRun = $('#drawer-run');
  drawerRun.hidden = true;
  drawerRun.open = false;
  drawerRun.classList.remove('is-live');
  drawerRun.dataset.agent = card.data.agent || 'claude';
  drawerRun.dataset.stage = runStates[id]?.stage || '';
  renderBuildProgress(id);
  $('#run-tldr').textContent = '';
  $('#run-tldr').hidden = true;
  $('#run-tldr').classList.remove('is-pending');
  $('#drawer-description').open = false;
  $('#drawer-cancel').hidden = !runStates[id];
  backfillRunLog(id); // fill the log with the run-so-far (and keep it for finished runs)
  $('#drawer-id').textContent = card.data.id;
  $('#drawer-title').textContent = card.data.title;
  const tldr = String(card.tldr || '').trim();
  $('#drawer-meta').innerHTML = [
    ['status', card.data.status], ['type', card.data.type], ['priority', card.data.priority],
    ['agent', card.data.agent], ['source', card.data.source],
    // asList, not `|| []`: a hand-edited/agent-written card can make labels a
    // bare string or a mapping, and .join on that throws — which aborts
    // openDrawer entirely, leaving the card silently un-openable (no drawer, so
    // no way to read it, answer its question, or delete it)
    ['labels', asList(card.data.labels).join(', ') || null],
  ].filter(([, v]) => v).map(([k, v]) => `<span class="meta-chip">${esc(k)} <b>${esc(String(v))}</b></span>`).join('');
  // Subtasks view (epics only) replaces the raw "## Chunks" planner YAML in the
  // main details flow — the fenced block is still reachable in a collapsed,
  // closed-by-default Planner record for auditability.
  const isEpic = !!card.data.epic;
  $('#drawer-tabs').hidden = !isEpic;
  setDrawerTab('details'); // reset so a click-through from a subtask row never lands on a tab the child doesn't have
  const { body: bodyForDisplay, planner } = isEpic ? splitChunksSection(card.body) : { body: card.body, planner: '' };
  $('#drawer-planner').hidden = !isEpic || !planner;
  $('#drawer-planner').open = false; // always closed by default, even reopening a different epic
  $('#drawer-planner-body').textContent = planner;
  const subtasksList = $('#drawer-subtasks-list');
  subtasksList.innerHTML = '';
  if (isEpic) {
    const kids = TodomdHierarchy.childrenOf(boardData.cards, card.data.id);
    if (kids.length) kids.forEach((kid) => subtasksList.appendChild(renderSubtaskRow(kid)));
    else subtasksList.innerHTML = '<li class="subtask-empty">no subtasks yet</li>';
  }
  // relationship section: epic → children, chunk → parent + deps
  const relEl = $('#drawer-rel');
  if (card.data.epic) {
    // same coercion as labels: a scalar `children:` survives the .length check
    // and then throws on .map, taking the whole drawer with it
    const children = TodomdHierarchy.asList(card.data.children);
    const chipsHtml = children.length
      ? children.map((cid) => relChip(cid, cid)).join('')
      : '<span class="rel-empty">no chunks</span>';
    relEl.innerHTML = `<span class="rel-label">chunks</span>${chipsHtml}`;
    relEl.hidden = false;
  } else if (card.data.parent) {
    const state = TodomdHierarchy.dependencyState(card.data, boardData.cards);
    const deps = TodomdHierarchy.asList(card.data.dependencies);
    const depsHtml = deps.length
      ? `<span class="rel-label">depends on</span>${deps.map((id) => depChip(id, state)).join('')}`
      : '';
    relEl.innerHTML = `<span class="rel-label">epic</span>${relChip(card.data.parent, card.data.parent)}${depsHtml}`;
    relEl.hidden = false;
  } else {
    relEl.innerHTML = '';
    relEl.hidden = true;
  }
  // acceptance-criteria progress bar (parsed from the card body's checkboxes)
  const crits = [...card.body.matchAll(/^- \[( |x)\]/gim)];
  const critTotal = crits.length;
  const critDone = crits.filter((m) => m[1].toLowerCase() === 'x').length;
  $('#drawer-criteria').hidden = !critTotal;
  if (critTotal) {
    $('#criteria-fill').style.width = `${(critDone / critTotal) * 100}%`;
    $('#criteria-fill').classList.toggle('full', critDone === critTotal);
    $('#criteria-label').textContent = `${critDone}/${critTotal} criteria`;
  }
  $('#drawer-body').innerHTML = mdToHtml(bodyForDisplay);
  const descriptionWords = bodyForDisplay.trim() ? bodyForDisplay.trim().split(/\s+/).length : 0;
  $('#description-tldr').textContent = tldr || (descriptionWords ? 'Summarizing description…' : 'No description to summarize.');
  $('#description-tldr').hidden = false;
  $('#description-tldr').classList.toggle('is-pending', !tldr && !!descriptionWords);
  $('#description-summary').textContent = [
    descriptionWords ? `${descriptionWords} ${descriptionWords === 1 ? 'word' : 'words'}` : 'empty',
    critTotal ? `${critDone}/${critTotal} criteria` : '',
  ].filter(Boolean).join(' · ');
  $('#drawer-file').textContent = `.todomd/tasks/${card.file}`;
  $('#route-agent').value = card.data.agent || 'claude';
  setModelOptions($('#route-agent').value); // suggestions match the card's vendor
  $('#route-model').value = card.data.model || '';
  $('#route-effort').value = card.data.effort || '';
  $('#route-workflow').value = card.data.workflow || '';
  const buildProfile = card.data.build_profile || card.recovery?.build_profile || 'standard';
  $('#route-build-profile').value = buildProfile;
  const buildLimits = card.recovery?.build_limits || card.data.build_limits || {};
  $('#build-profile-hint').textContent = buildProfile === 'split_required'
    ? 'This card must return to Plan and become child cards before Build.'
    : `${buildProfile} profile: up to ${buildLimits.max_slices || (buildProfile === 'long' ? 6 : 3)} checkpoints / ${buildLimits.budget_minutes || (buildProfile === 'long' ? 120 : 60)} minutes per admission.`;
  $('#route-skill').value = card.data.skill || '';
  $('#route-assignee').value = card.data.assignee || '';
  const cols = boardData?.config?.columns || [];
  const optionsHtml = cols
    .filter((c) => c !== card.data.status)
    .map((c) => {
      const allowed = isHumanMoveAllowed(card.data.status, c, card, boardData);
      const recovery = card.data.status === 'Needs Human' && (c === 'Queue' || c === 'Build');
      return `<option value="${esc(c)}"${allowed ? '' : ' disabled'}>${esc(c)}${recovery ? ' (repair preserved work)' : allowed ? '' : ' (orchestrator only)'}</option>`;
    }).join('');
  $('#move-select').innerHTML = optionsHtml;
  const firstAllowed = cols.find((c) => c !== card.data.status && isHumanMoveAllowed(card.data.status, c, card, boardData));
  if (firstAllowed) $('#move-select').value = firstAllowed;
  // archive / delete controls
  drawerArchived = !!card.data.archived;
  $('#drawer-archive').textContent = drawerArchived ? 'restore' : 'archive';
  // Eligibility is computed server-side from the actual registered worktree,
  // not just a possibly stale `worktree:` frontmatter value.
  $('#drawer-resume-build').hidden = !card.recovery?.resume_build;
  $('#drawer-restart-build').hidden = !card.recovery?.restart_build;
  const retryVerify = $('#drawer-retry-verify');
  retryVerify.hidden = !card.recovery?.retry_verification;
  const retryingCi = ['ci_failed', 'ci_attempts_exhausted', 'ci_evidence_invalid']
    .includes(card.data.needs_human_reason);
  retryVerify.textContent = retryingCi ? 'retry CI + verification' : 'retry verification';
  retryVerify.title = retryingCi
    ? 'rerun CI on this preserved candidate and continue the same verification attempt if it passes'
    : 'retry verification on this preserved candidate';
  $('#drawer-return-build').hidden = !card.recovery?.return_to_build;
  $('#agent-return-build').hidden = !card.recovery?.return_to_build;
  resetDeleteBtn();
  // pending agent question
  const q = card.data.question;
  $('#drawer-question').hidden = !q;
  if (q) { $('#question-text').textContent = q; $('#answer-input').value = ''; }
  $('#agent-prompt').value = '';
  syncPromptComposer();
  showDrawer();
  refreshCardSummaries(id, seq);
}

$('#drawer-rel').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-id]');
  if (!chip) return;
  e.preventDefault();
  openDrawer(chip.dataset.id);
});

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
    closeDrawer();
    loadBoard();
  } catch { toast('server unreachable'); }
});

function syncPromptComposer() {
  const state = drawerCard ? runStates[drawerCard] : null;
  const busy = !!state;
  $('#agent-prompt').disabled = busy;
  $('#agent-prompt-submit').disabled = busy;
  $('#agent-instruction-save').disabled = busy;
  $('#agent-return-build').disabled = busy;
  $('#agent-prompt-status').textContent = busy
    ? `${state.state || 'running'} · ${state.stage || 'agent'}`
    : 'advisor · handoff ready';
}

async function saveCardInstruction() {
  if (!drawerCard) return false;
  const instruction = $('#agent-prompt').value.trim();
  if (!instruction) { toast('type an instruction first'); return false; }
  try {
    const res = await fetch(`/api/cards/${drawerCard}/instruction?project=${encodeURIComponent(currentProject)}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction }),
    });
    const out = await res.json();
    toast(res.ok ? 'handoff saved for the next Build agent' : out.error || 'could not save handoff');
    return res.ok;
  } catch {
    toast('server unreachable');
    return false;
  }
}

async function returnCardToBuild() {
  if (!drawerCard) return;
  const instruction = $('#agent-prompt').value.trim();
  try {
    const res = await fetch(`/api/cards/${drawerCard}/return-build?project=${encodeURIComponent(currentProject)}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ instruction }),
    });
    const out = await res.json();
    if (!res.ok) return toast(out.error || 'could not return card to Build');
    toast(instruction ? 'sent to Build with your handoff' : 'sent to Build with preserved work');
    closeDrawer();
    loadBoard();
  } catch { toast('server unreachable'); }
}

$('#agent-instruction-save').addEventListener('click', saveCardInstruction);
$('#agent-return-build').addEventListener('click', returnCardToBuild);

$('#drawer-prompt').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!drawerCard) return;
  const prompt = $('#agent-prompt').value.trim();
  if (!prompt) return toast('type a prompt first');
  const id = drawerCard;
  $('#agent-prompt').disabled = true;
  $('#agent-prompt-submit').disabled = true;
  $('#agent-prompt-status').textContent = 'queueing…';
  try {
    const res = await fetch(`/api/cards/${id}/prompt?project=${encodeURIComponent(currentProject)}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const out = await res.json();
    if (!res.ok) {
      syncPromptComposer();
      return toast(out.error || 'prompt failed');
    }
    $('#agent-prompt').value = '';
    toast('prompt queued — the answer will appear here');
  } catch {
    syncPromptComposer();
    toast('server unreachable');
  }
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
    closeDrawer();
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
    closeDrawer();
    loadBoard();
  } catch { toast('server unreachable'); }
});

$('#move-apply').addEventListener('click', async () => {
  if (!drawerCard) return;
  try {
    const res = await fetch(`/api/cards/${drawerCard}/move?project=${encodeURIComponent(currentProject)}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        status: $('#move-select').value,
        instruction: $('#agent-prompt').value.trim(),
      }),
    });
    const out = await res.json();
    if (!res.ok) return toast(out.error || 'move failed');
    toast(out.warning || `moved to ${$('#move-select').value}`);
    closeDrawer();
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
        effort: $('#route-effort').value,
        workflow: $('#route-workflow').value,
        build_profile: $('#route-build-profile').value,
        skill: $('#route-skill').value.trim(),
        assignee: $('#route-assignee').value.trim(),
      }),
    });
    const out = await res.json();
    toast(res.ok ? 'routing saved' : out.error || 'save failed');
    if (res.ok) {
      await loadBoard();
      if (drawerCard) await openDrawer(drawerCard);
    }
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

$('#drawer-close').addEventListener('click', closeDrawer);
drawerBackdropEl.addEventListener('click', (e) => { if (e.target === drawerBackdropEl) closeDrawer(); });
document.addEventListener('keydown', (e) => {
  if (drawerEl.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
  if (e.key !== 'Tab') return;
  const focusable = drawerFocusable();
  if (!focusable.length) { e.preventDefault(); drawerEl.focus(); return; }
  const first = focusable[0], last = focusable.at(-1);
  if (e.shiftKey && (document.activeElement === first || !drawerEl.contains(document.activeElement))) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !drawerEl.contains(document.activeElement))) {
    e.preventDefault(); first.focus();
  }
});
$('#drawer-cancel').addEventListener('click', async () => {
  if (!drawerCard) return;
  const res = await fetch(`/api/cards/${drawerCard}/cancel?project=${encodeURIComponent(currentProject)}`,
    { method: 'POST', headers });
  const out = await res.json();
  toast(res.ok ? 'run cancelled' : out.error || 'cancel failed');
});

$('#drawer-retry-verify').addEventListener('click', async () => {
  if (!drawerCard) return;
  try {
    const res = await fetch(`/api/cards/${drawerCard}/retry-verify?project=${encodeURIComponent(currentProject)}`, { method: 'POST', headers });
    const out = await res.json();
    if (!res.ok) return toast(out.error || 'could not retry verification');
    toast('verification retry started');
    closeDrawer();
    loadBoard();
  } catch { toast('server unreachable'); }
});

$('#drawer-return-build').addEventListener('click', returnCardToBuild);

$('#drawer-resume-build').addEventListener('click', async () => {
  if (!drawerCard) return;
  try {
    const res = await fetch(`/api/cards/${drawerCard}/resume-build?project=${encodeURIComponent(currentProject)}`, { method: 'POST', headers });
    const out = await res.json();
    if (!res.ok) return toast(out.error || 'could not resume build');
    toast('build resumed in the preserved worktree');
    closeDrawer();
    loadBoard();
  } catch { toast('server unreachable'); }
});

$('#drawer-restart-build').addEventListener('click', async () => {
  if (!drawerCard) return;
  try {
    const res = await fetch(`/api/cards/${drawerCard}/restart-build?project=${encodeURIComponent(currentProject)}`, { method: 'POST', headers });
    const out = await res.json();
    if (!res.ok) return toast(out.error || 'could not restart build');
    toast('fresh build started');
    closeDrawer();
    loadBoard();
  } catch { toast('server unreachable'); }
});

// fetch the most recent run's events so the drawer shows the whole run, not just
// what streams in after you open it (works for a finished run too)
async function backfillRunLog(id) {
  const running = runStates[id]?.state === 'running';
  try {
    const { agent, stage, events, tldr } = await api(`cards/${id}/runlog?project=${encodeURIComponent(currentProject)}`);
    if (id !== drawerCard) return; // the drawer moved on while we were fetching
    $('#run-log').textContent = '';
    const run = $('#drawer-run');
    run.dataset.agent = agent || '';
    run.dataset.stage = stage || runStates[id]?.stage || '';
    setRunHeader(running);
    for (const ev of events) appendRunEvent({ vendor: agent, ...ev });
    $('#drawer-run').hidden = !(running || events.length);
    if (running) setRunTldr('Summary available when this run finishes.', { pending: true });
    else if (events.length) setRunTldr(tldr || 'Summarizing the complete run…', { pending: !tldr });
    else setRunTldr('');
    setRunHeader(running);
  } catch {
    $('#drawer-run').hidden = !running;
    setRunHeader(running);
  }
}

function runEntry(tag, cls) {
  const entry = document.createElement(tag);
  entry.className = `chat-entry ${cls}`;
  return entry;
}

function appendRunEntry(entry) {
  const log = $('#run-log');
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
  setRunHeader($('#drawer-run').classList.contains('is-live'));
  return entry;
}

function setRunHeader(running) {
  const run = $('#drawer-run');
  run.classList.toggle('is-live', !!running);
  $('#run-title').textContent = running ? 'live run' : 'last run';
  const parts = [run.dataset.stage, run.dataset.agent, `${$('#run-log').children.length} updates`].filter(Boolean);
  $('#run-summary').textContent = parts.join(' · ');
}

function setRunTldr(text, { pending = false } = {}) {
  const summary = String(text || '').trim();
  $('#run-tldr').textContent = summary;
  $('#run-tldr').hidden = !summary;
  $('#run-tldr').classList.toggle('is-pending', !!summary && pending);
}

async function refreshCardSummaries(id, seq = drawerOpenSeq) {
  if (boardData?.access !== 'full') {
    if (id !== drawerCard || seq !== drawerOpenSeq) return;
    if ($('#description-tldr').classList.contains('is-pending')) {
      $('#description-tldr').textContent = 'Summary not generated yet.';
      $('#description-tldr').classList.remove('is-pending');
    }
    if (!$('#drawer-run').hidden && $('#run-tldr').classList.contains('is-pending')) {
      setRunTldr('Run summary not generated yet.');
    }
    return;
  }
  try {
    const res = await fetch(`/api/cards/${id}/summaries?project=${encodeURIComponent(currentProject)}`, {
      method: 'POST', headers,
    });
    const out = await res.json();
    if (id !== drawerCard || seq !== drawerOpenSeq) return;
    if (!res.ok && /after the active run finishes/i.test(String(out.error || ''))) {
      if ($('#description-tldr').classList.contains('is-pending')) {
        $('#description-tldr').textContent = 'Summary available when this run finishes.';
      }
      if (!$('#drawer-run').hidden) setRunTldr('Summary available when this run finishes.', { pending: true });
      return;
    }
    if (!res.ok) throw new Error(out.error || 'summary generation failed');
    const description = String(out.description_tldr || '').trim();
    $('#description-tldr').textContent = description || 'No description to summarize.';
    $('#description-tldr').classList.remove('is-pending');
    if (!$('#drawer-run').hidden) {
      const run = String(out.last_run_tldr || '').trim();
      setRunTldr(run || 'No meaningful run result to summarize.');
    }
  } catch {
    if (id !== drawerCard || seq !== drawerOpenSeq) return;
    if ($('#description-tldr').classList.contains('is-pending')) {
      $('#description-tldr').textContent = 'Summary unavailable.';
      $('#description-tldr').classList.remove('is-pending');
    }
    if (!$('#drawer-run').hidden && $('#run-tldr').classList.contains('is-pending')) {
      setRunTldr('Run summary unavailable.');
    }
  }
}

function appendRunSystem(text, cls = 'chat-system') {
  if (!text) return;
  const entry = runEntry('div', cls);
  entry.textContent = text;
  appendRunEntry(entry);
}

function appendAgentMessage(text, vendor = 'agent') {
  if (!text) return;
  const entry = runEntry('article', 'chat-assistant');
  const head = document.createElement('header');
  const avatar = document.createElement('span');
  avatar.className = 'chat-avatar';
  avatar.textContent = '◆';
  const label = document.createElement('span');
  label.textContent = vendor || 'agent';
  head.append(avatar, label);
  const body = document.createElement('div');
  body.className = 'chat-copy drawer-body';
  body.innerHTML = mdToHtml(String(text));
  const actions = document.createElement('footer');
  actions.className = 'chat-message-actions';
  const handoff = document.createElement('button');
  handoff.type = 'button';
  handoff.textContent = 'use as handoff';
  handoff.addEventListener('click', () => {
    $('#agent-prompt').value = String(text).trim();
    $('#agent-prompt').focus();
    toast('advisor response copied into the next-agent handoff');
  });
  actions.appendChild(handoff);
  entry.append(head, body, actions);
  appendRunEntry(entry);
}

function appendHumanMessage(text) {
  if (!text) return;
  const entry = runEntry('article', 'chat-user');
  const label = document.createElement('header');
  label.textContent = 'you';
  const body = document.createElement('div');
  body.textContent = String(text);
  entry.append(label, body);
  appendRunEntry(entry);
}

function findRunEntry(eventId) {
  if (!eventId) return null;
  return [...$('#run-log').children].find((el) => el.dataset.eventId === String(eventId)) || null;
}

function appendRunDisclosure(cls, title, detail, { eventId = '', status = '' } = {}) {
  let entry = findRunEntry(eventId);
  if (!entry) {
    entry = runEntry('details', cls);
    if (eventId) entry.dataset.eventId = String(eventId);
    appendRunEntry(entry);
  }
  entry.className = `chat-entry ${cls}`;
  entry.textContent = '';
  const summary = document.createElement('summary');
  const glyph = document.createElement('span');
  glyph.className = 'chat-glyph';
  glyph.textContent = cls === 'chat-reasoning' ? '◇' : '›';
  const name = document.createElement('span');
  name.className = 'chat-entry-title';
  name.textContent = title || 'activity';
  summary.append(glyph, name);
  if (status) {
    const state = document.createElement('span');
    state.className = `chat-entry-status ${status === 'completed' || status === 'success' ? 'is-complete' : ''}`;
    state.textContent = String(status).replaceAll('_', ' ');
    summary.append(state);
  }
  entry.appendChild(summary);
  if (detail) {
    const pre = document.createElement('pre');
    pre.textContent = String(detail);
    entry.appendChild(pre);
  }
  $('#run-log').scrollTop = $('#run-log').scrollHeight;
}

function compactJson(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function appendCodexItem(event) {
  const item = event.item || {};
  const completed = event.type === 'item.completed';
  if (item.type === 'agent_message') {
    if (completed || !String(event.type || '').startsWith('item.')) appendAgentMessage(item.text, event.vendor);
    return true;
  }
  if (item.type === 'reasoning') {
    if (item.text) appendRunDisclosure('chat-reasoning', 'reasoning', item.text, { eventId: item.id, status: item.status });
    return true;
  }
  if (item.type === 'command_execution') {
    appendRunDisclosure('chat-tool', item.command || 'command', item.aggregated_output, {
      eventId: item.id, status: item.status || (completed ? 'completed' : 'in_progress'),
    });
    return true;
  }
  if (item.type === 'mcp_tool_call') {
    const name = [item.server, item.tool].filter(Boolean).join('.') || item.name || 'tool call';
    const detail = item.result != null ? compactJson(item.result) : compactJson(item.arguments || item.input);
    appendRunDisclosure('chat-tool', name, detail, {
      eventId: item.id, status: item.status || (completed ? 'completed' : 'in_progress'),
    });
    return true;
  }
  if (item.type === 'file_change' || item.type === 'web_search') {
    appendRunDisclosure('chat-tool', item.type.replaceAll('_', ' '), compactJson(item.changes || item.query || item), {
      eventId: item.id, status: item.status || (completed ? 'completed' : 'in_progress'),
    });
    return true;
  }
  return false;
}

function appendRunEvent(event) {
  if (event.type === 'rate_limit_event' || event.type === 'turn.started') return;
  if (event.type === 'human_message') {
    appendHumanMessage(event.text);
    return;
  }
  if (event.type === 'system' || event.type === 'thread.started') {
    const session = event.session_id || event.thread_id;
    if (event.type === 'thread.started' || event.subtype === 'init') appendRunSystem(`session ${session || 'started'}`);
    return;
  }
  if (event.type === 'runner-invocation') {
    appendRunSystem(`started ${event.executable || event.vendor || 'agent'}`);
    return;
  }
  if (event.type === 'runner-diagnostic') {
    const exit = event.spawnError ? `start error ${event.spawnError}`
      : event.signal ? `signal ${event.signal}` : `exit ${event.exitCode}`;
    const output = event.structuredOutput != null ? compactJson(event.structuredOutput) : event.finalMessage || '(none)';
    appendRunDisclosure('chat-diagnostic', `${event.vendor || 'agent'} process · ${exit}`,
      `executable: ${event.executable}\nworking directory: ${event.cwd}\nstandard error: ${event.stderr || '(empty)'}\nfinal result: ${output}`,
      { status: event.exitCode === 0 && !event.signal && !event.spawnError ? 'success' : 'failed' });
    return;
  }
  if (event.type === 'assistant' || Array.isArray(event.message?.content)) {
    const content = event.message?.content || (Array.isArray(event.content) ? event.content : []);
    for (const block of content) {
      if (block.type === 'text' && block.text) appendAgentMessage(block.text, event.vendor);
      else if (block.type === 'thinking' && block.thinking) {
        appendRunDisclosure('chat-reasoning', 'reasoning', block.thinking, { eventId: block.id });
      } else if (block.type === 'tool_use') {
        const primary = block.input?.path || block.input?.command || block.input?.pattern || block.name;
        appendRunDisclosure('chat-tool', `${block.name}${primary && primary !== block.name ? ` · ${primary}` : ''}`,
          compactJson(block.input), { eventId: block.id });
      }
    }
    return;
  }
  if (event.item && appendCodexItem(event)) return;
  if (event.type === 'turn.completed') {
    const usage = event.usage || {};
    const tokens = usage.input_tokens != null ? ` · ${usage.input_tokens} in / ${usage.output_tokens || 0} out` : '';
    appendRunSystem(`turn complete${tokens}`);
    return;
  }
  if (event.text) appendAgentMessage(event.text, event.vendor);
  else if (typeof event.message === 'string') appendAgentMessage(event.message, event.vendor);
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
      else runStates[msg.card] = { state: msg.state, stage: msg.stage, reason: msg.reason,
        ...(msg.progress ? { progress: msg.progress } : {}) };
      if (msg.card === drawerCard) {
        $('#drawer-cancel').hidden = msg.state === 'idle' || !runStates[msg.card];
        syncPromptComposer();
        if (msg.state === 'running') {
          const run = $('#drawer-run');
          $('#run-log').textContent = '';
          run.hidden = false;
          run.open = true;
          run.dataset.stage = msg.stage || '';
          run.dataset.agent = $('#route-agent').value || '';
          setRunTldr('Summary available when this run finishes.', { pending: true });
          setRunHeader(true);
        }
        else {
          backfillRunLog(drawerCard); // run ended — keep its log, now as "last run"
          refreshCardSummaries(drawerCard, drawerOpenSeq);
        }
        renderBuildProgress(drawerCard);
      }
      renderBoard();
    } else if (msg.type === 'run-progress' && msg.project === currentProject) {
      const state = runStates[msg.card];
      if (state) state.progress = { ...(state.progress || {}), ...(msg.progress || {}) };
      if (msg.card === drawerCard) renderBuildProgress(msg.card);
    } else if (msg.type === 'run-event' && msg.project === currentProject && msg.card === drawerCard) {
      const run = $('#drawer-run');
      run.hidden = false;
      if (msg.event?.vendor) run.dataset.agent = msg.event.vendor;
      const state = runStates[msg.card];
      if (state) {
        state.progress ||= {};
        state.progress.lastActivityAt = new Date().toISOString();
        state.progress.activity = activityFromRunEvent(msg.event) || state.progress.activity;
        renderBuildProgress(msg.card);
      }
      appendRunEvent({ vendor: run.dataset.agent || 'agent', ...msg.event });
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
let promptDefaults = { agent: 'claude', model: '', effort: '' };
let routingColumn = null;
// the column's effective agent/model = its own override, else the board default
function renderRoutingNote(item) {
  const agent = item.agent || `${promptDefaults.agent} (board)`;
  const model = item.model || (promptDefaults.model ? `${promptDefaults.model} (board)` : 'CLI default');
  const effort = item.effort || (promptDefaults.effort ? `${promptDefaults.effort} (board)` : 'CLI default');
  const workflow = item.workflow === 'ultra_code' ? ' · Ultra Code workflow' : '';
  $('#stage-routing-note').textContent = `runs as ${agent} · ${model} · ${effort} effort${workflow} — a card can still override per-card`;
}
async function updateRoutingRow(item) {
  const row = $('#prompt-routing');
  if (!item || !item.stage) { row.hidden = true; routingColumn = null; return; }
  routingColumn = item.column;
  $('#stage-agent').value = item.agent || '';
  $('#stage-effort').value = item.effort || '';
  $('#stage-workflow').value = item.workflow || '';
  $('#stage-workflow-row').hidden = item.column !== 'Build';
  row.hidden = false;
  await setStageModelOptions(item.agent || promptDefaults.agent, item.model || '');
  renderRoutingNote(item);
}
async function loadPromptCommand(command) {
  const out = await api(`commands/${encodeURIComponent(command)}?project=${encodeURIComponent(currentProject)}`);
  $('#prompt-locked').textContent = out.locked || '';
  $('#prompt-custom').value = out.custom || '';
  $('#prompt-local').value = out.local || ''; // .todomd/local/<cmd>.md — gitignored
  const item = promptCommands.find((c) => c.command === command);
  $('#prompt-meta').textContent = item ? `${item.command}.md${item.exists ? '' : ' · (new)'}` : `${command}.md`;
  await updateRoutingRow(item);
}
// open the editor, optionally pre-targeted to a column's command
async function openPromptEditor(command) {
  if (!currentProject) return;
  try {
    const { commands, defaultAgent, defaultModel, defaultEffort } = await api(`commands?project=${encodeURIComponent(currentProject)}`);
    promptCommands = commands;
    promptDefaults = { agent: defaultAgent || 'claude', model: defaultModel || '', effort: defaultEffort || '' };
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
    item.model = ''; // the API clears an incompatible model whenever the vendor changes
    await setStageModelOptions(item.agent || promptDefaults.agent, '');
    renderRoutingNote(item); toast(`${col} agent saved`);
  } else if (item) {
    e.target.value = item.agent || '';
  }
});
$('#stage-model').addEventListener('change', async (e) => {
  const col = routingColumn, item = promptCommands.find((c) => c.column === col);
  if (await saveRouting({ model: e.target.value }) && item) {
    item.model = e.target.value;
    renderRoutingNote(item); toast(`${col} model saved`);
  } else if (item) {
    e.target.value = item.model || '';
  }
});
$('#stage-effort').addEventListener('change', async (e) => {
  const col = routingColumn, item = promptCommands.find((c) => c.column === col);
  if (await saveRouting({ effort: e.target.value }) && item) {
    item.effort = e.target.value;
    renderRoutingNote(item); toast(`${col} effort saved`);
  }
});
$('#stage-workflow').addEventListener('change', async (e) => {
  const col = routingColumn, item = promptCommands.find((c) => c.column === col);
  if (await saveRouting({ workflow: e.target.value }) && item) {
    item.workflow = e.target.value;
    renderRoutingNote(item); toast(`${col} workflow saved`);
  }
});
$('#prompts-close').addEventListener('click', () => { $('#prompts-backdrop').hidden = true; });
$('#prompts-backdrop').addEventListener('click', (e) => { if (e.target.id === 'prompts-backdrop') $('#prompts-backdrop').hidden = true; });
$('#prompt-save').addEventListener('click', async () => {
  const command = $('#prompt-select').value;
  try {
    const res = await fetch(`/api/commands/${encodeURIComponent(command)}?project=${encodeURIComponent(currentProject)}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      // both halves in one save: `custom` is committed with the prompt file,
      // `local` lands in the gitignored .todomd/local/ and never leaves the box
      body: JSON.stringify({ custom: $('#prompt-custom').value, local: $('#prompt-local').value }),
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
    loadIntakeAudit();
  } catch (e) { toast(e.message); }
});
// screened-out/held email, newest first — untrusted content (email headers/body), escape all of it
function intakeAuditRow(r) {
  const when = r.timestamp ? new Date(r.timestamp).toLocaleString() : 'unknown time';
  return `<li class="intake-audit-row">
    <span class="intake-audit-when">${esc(when)}</span>
    <span class="intake-audit-verdict intake-audit-${esc(r.verdict || '')}">${esc(r.verdict || '')}</span>
    <span class="intake-audit-from">${esc(r.from || 'unknown sender')}</span>
    <span class="intake-audit-subject">${esc(r.subject || '(no subject)')}</span>
    <span class="intake-audit-reason">${esc(r.reason || '')}</span>
  </li>`;
}
async function loadIntakeAudit() {
  const list = $('#intake-audit-list');
  const empty = $('#intake-audit-empty');
  try {
    const { records } = await api(`projects/${encodeURIComponent(currentProject)}/intake-audit`);
    if (!records.length) { list.hidden = true; list.innerHTML = ''; empty.hidden = false; return; }
    list.innerHTML = records.map(intakeAuditRow).join('');
    list.hidden = false; empty.hidden = true;
  } catch { list.hidden = true; list.innerHTML = ''; empty.hidden = false; }
}
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
      if (res.ok) {
        if (name === currentProject) setCurrentProject(null);
        toast(`removed ${name}`); await renderProjectList(); await loadProjects(); loadBoard();
      }
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
    setCurrentProject(out.name);
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
  $('#card-advanced').open = false;
  setModelOptions($('#card-form [name=agent]').value); // suggestions for the default vendor
  backdrop.hidden = false;
  $('#card-form [name=prompt]').focus();
});
$('#modal-cancel').addEventListener('click', () => { backdrop.hidden = true; });
backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.hidden = true; });
$('#card-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const prompt = String(f.get('prompt') || '').trim();
  const payload = {
    title: todoCardPrompt.deriveTitle(prompt, f.get('title')),
    type: f.get('type'),
    priority: f.get('priority'),
    agent: f.get('agent'),
    model: (f.get('model') || '').trim() || undefined,
    effort: f.get('effort') || undefined,
    workflow: f.get('workflow') || undefined,
    skill: (f.get('skill') || '').trim() || undefined,
    assignee: (f.get('assignee') || '').trim() || undefined,
    labels: String(f.get('labels') || '').split(',').map((s) => s.trim()).filter(Boolean),
    description: todoCardPrompt.buildDescription(prompt, f.get('description')),
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

projectSel.addEventListener('change', () => {
  // Revoke the old context before waiting for the newly-selected board. A
  // slow/failed request must never let capture outlive the project it belongs
  // to; the authenticated full/primary context is restored by loadBoard().
  setCurrentProject(projectSel.value);
  loadBoard();
});
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
window.addEventListener('hashchange', () => {
  const hash = (location.hash || '').slice(1);
  if (hash && /^task-[\w-]+$/.test(hash)) {
    if (drawerCard !== hash) openDrawer(hash);
  } else if (drawerCard) {
    closeDrawer();
  }
});

loadProjects().then(loadBoard).then(connectWs).then(() => {
  if (!localStorage.getItem('todomd-guided')) openGuide(); // first visit → show the guide
}).catch((e) => {
  boardEl.innerHTML = `<p class="col-empty">${esc(e.message)} — is the token in the URL?</p>`;
});
