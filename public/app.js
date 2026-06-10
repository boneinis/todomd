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
  Assigned: 'var(--violet)', Build: 'var(--amber)', Verify: 'var(--amber)',
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
    boardEl.innerHTML = '<p class="col-empty">no projects — add one with the ⊕ button</p>';
    return;
  }
  boardData = await api(`board?project=${encodeURIComponent(currentProject)}`);
  runStates = boardData.runStates || {};
  renderBanners(boardData.banners || []);
  const usage = boardData.usage || {};
  const modeTag = boardData.mode === 'budget' ? ' · budget' : '';
  const viewer = boardData.access === 'viewer';
  $('#usage').textContent = (usage.month_cost_usd ? `$${usage.month_cost_usd.toFixed(2)}/mo` : '') + modeTag + (viewer ? ' · monitor' : '');
  document.body.classList.toggle('viewer', viewer);
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

function renderBoard() {
  if (!boardData) return;
  const filter = filterInput.value.trim().toLowerCase();
  boardEl.innerHTML = '';
  for (const col of boardData.config.columns) {
    const color = COL_COLORS[col] || 'var(--dim)';
    const cards = boardData.cards.filter(
      (c) => c.status === col &&
        (!filter || `${c.id} ${c.title} ${(c.labels || []).join(' ')}`.toLowerCase().includes(filter))
    );
    const colEl = document.createElement('section');
    colEl.className = 'column';
    colEl.style.setProperty('--col', color);
    colEl.dataset.status = col;
    colEl.innerHTML = `<header class="col-head"><span>${esc(col)}</span><span class="col-count">[${cards.length}]</span></header>`;
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
  el.querySelector('.card-id').textContent = card.id || card.file;
  const prio = el.querySelector('.card-prio');
  prio.textContent = card.priority || '';
  prio.className = `card-prio ${card.priority || ''}`;
  el.querySelector('.card-title').textContent = card.title || card.file;
  el.querySelector('.card-chips').textContent =
    [card.type, ...(card.labels || [])].filter(Boolean).join(' · ');
  const crit = el.querySelector('.card-criteria');
  if (card.criteria) {
    crit.textContent = `☑ ${card.criteria.done}/${card.criteria.total}`;
    if (card.criteria.done === card.criteria.total) crit.classList.add('complete');
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
  $('#drawer-run').hidden = runStates[id]?.state !== 'running';
  $('#drawer-cancel').hidden = !runStates[id];
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
  $('#route-model').value = card.data.model || '';
  $('#route-skill').value = card.data.skill || '';
  const cols = boardData?.config?.columns || [];
  $('#move-select').innerHTML = cols
    .filter((c) => c !== card.data.status)
    .map((c) => `<option>${esc(c)}</option>`).join('');
  $('#drawer').hidden = false;
}

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

$('#drawer-close').addEventListener('click', () => { $('#drawer').hidden = true; drawerCard = null; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#drawer').hidden = true; drawerCard = null; } });
$('#drawer-cancel').addEventListener('click', async () => {
  if (!drawerCard) return;
  const res = await fetch(`/api/cards/${drawerCard}/cancel?project=${encodeURIComponent(currentProject)}`,
    { method: 'POST', headers });
  const out = await res.json();
  toast(res.ok ? 'run cancelled' : out.error || 'cancel failed');
});

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
function inline(s) {
  return esc(s)
    // images: ![alt](url) — alt is already escaped; url sanitized
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
      const href = safeUrl(url);
      return href ? `<img class="card-img" alt="${alt}" src="${href}" loading="lazy" />` : esc(m);
    })
    // links: [text](url)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
      const href = safeUrl(url);
      if (!href) return text;
      const ext = /^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${href}"${ext}>${text}</a>`;
    })
    .replace(/`([^`]+)`/g, '<code>$1</code>')
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
        $('#drawer-run').hidden = msg.state !== 'running';
        $('#drawer-cancel').hidden = msg.state === 'idle' || !runStates[msg.card];
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
async function showQr(access) {
  try {
    const out = await api(`qr${access === 'full' ? '?access=full' : ''}`);
    $('#qr-svg').innerHTML = out.svg;
    $('#qr-url').textContent = out.url;
    $('#qr-note').textContent = QR_NOTES[access];
    $('#qr-tab-viewer').classList.toggle('active', access === 'viewer');
    $('#qr-tab-full').classList.toggle('active', access === 'full');
    $('#qr-backdrop').hidden = false;
  } catch (e) {
    toast(e.message);
  }
}
$('#qr-btn').addEventListener('click', () => showQr('viewer'));
$('#qr-tab-viewer').addEventListener('click', () => showQr('viewer'));
$('#qr-tab-full').addEventListener('click', () => showQr('full'));
$('#qr-close').addEventListener('click', () => { $('#qr-backdrop').hidden = true; });
$('#qr-backdrop').addEventListener('click', (e) => { if (e.target.id === 'qr-backdrop') $('#qr-backdrop').hidden = true; });

/* ── new card modal ── */
const backdrop = $('#modal-backdrop');
$('#new-card').addEventListener('click', () => {
  $('#card-form').reset();
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

loadProjects().then(loadBoard).then(connectWs).catch((e) => {
  boardEl.innerHTML = `<p class="col-empty">${esc(e.message)} — is the token in the URL?</p>`;
});
