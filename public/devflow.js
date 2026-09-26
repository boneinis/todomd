// Dev-flow board: a second surface for development work — sprint-grouped
// lanes (Backlog / Committed / In flight / Needs me / Shipped) over the same
// cards #board renders as the intake pipeline. Pure data helpers plus a
// render(el) DOM layer — shared between index.html and test/devflow.test.js
// (loaded there via node:vm).
//
// A CLASSIC script (window.TodomdDevflow), not an ES module: index.html loads
// /app.js with a plain <script src>, and a type=module helper would execute
// AFTER it and race the first render — same constraint as hierarchy.js.
//
// Every card here is hand- or agent-written, so list fields (labels,
// dependencies, sprint, children) can arrive as a scalar, a YAML mapping, or
// missing — nothing below may throw on that. A scalar `dependencies:`
// reaching `.some()` once blanked the entire board (test/ui/ui-smoke.test.js).
//
// render() reaches app.js's classic-script globals directly (boardData,
// filterInput, viewMode, myName, collapsedEpicIds, epicCollapseKey, esc,
// openDrawer, isHumanMoveAllowed, findBoardCard, headers, currentProject,
// toast, loadBoard). That is safe at any load order because they are only
// dereferenced when render/drag handlers RUN — always after app.js is up.
(function () {
  'use strict';

  // lane table: commitment stages, not board columns. Review (intake) is off
  // this board entirely; orchestrator-owned lanes get dropStatus: null so no
  // human drop can fake a Build/Verify/Done transition.
  const LANES = [
    { key: 'backlog',    label: 'Backlog',    statuses: ['Planned'],                           dropStatus: 'Planned' },
    { key: 'committed',  label: 'Committed',  statuses: ['Queue'],                             dropStatus: 'Queue' },
    { key: 'in-flight',  label: 'In flight',  statuses: ['Build', 'CI', 'Verify', 'Escalate'], dropStatus: null },
    { key: 'needs-me',   label: 'Needs me',   statuses: ['Needs Human'],                       dropStatus: null },
    { key: 'shipped',    label: 'Shipped',    statuses: ['Done'],                              dropStatus: null },
  ];
  const LANE_BY_STATUS = new Map();
  for (const lane of LANES) for (const s of lane.statuses) LANE_BY_STATUS.set(s, lane.key);

  /* ── part 1: pure data layer — no DOM, no fetch ── */

  // Lane for a status, or null when the card doesn't belong on the dev board
  // at all (Review is intake; missing/non-string status is hand-edit noise —
  // never throws on it). Any other unknown status — Plan, custom columns —
  // is pre-commitment by definition, so it lands in backlog rather than
  // vanishing. `config` is accepted for call-site symmetry with
  // isExecutionColumn but deliberately unused: membership is status-driven
  // so a renamed/added column still lands somewhere sane.
  function laneKeyFor(status, config) {
    if (typeof status !== 'string' || !status.trim()) return null;
    if (status === 'Review') return null;
    return LANE_BY_STATUS.get(status) || 'backlog';
  }

  // `sprint:` frontmatter may be missing, a scalar, or a hand-edited YAML
  // list — coerce all of that to one trimmed string ('' = unscheduled).
  function sprintOf(card) {
    const v = card && card.sprint;
    const s = Array.isArray(v) ? v[0] : v;
    return s === null || s === undefined ? '' : String(s).trim();
  }

  function devVisible(card, config) {
    return !!(card && !card.archived && laneKeyFor(card.status, config) !== null);
  }

  const PRIO_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

  // board_order can be missing/null/a hand-edited string — only a real finite
  // number counts as ranked (bare Number(null) === 0 would fake rank 0).
  function boardOrderOf(card) {
    const v = card && card.board_order;
    if (v === null || v === undefined) return NaN;
    if (typeof v === 'string' && !v.trim()) return NaN;
    return Number(v);
  }

  // Ranked cards (board_order) first, numeric; then priority
  // critical>high>medium>low with unknown last; then id ascending. Returns a
  // new array — the caller's order is boardData order and must not be mutated.
  function sortForLane(cards) {
    const list = Array.isArray(cards) ? cards.slice() : [];
    return list.sort((a, b) => {
      const ao = boardOrderOf(a), bo = boardOrderOf(b);
      const ar = Number.isFinite(ao), br = Number.isFinite(bo);
      if (ar && br && ao !== bo) return ao - bo;
      if (ar !== br) return ar ? -1 : 1;
      const ap = PRIO_RANK[String((a && a.priority) || '').toLowerCase()];
      const bp = PRIO_RANK[String((b && b.priority) || '').toLowerCase()];
      const ar2 = ap === undefined ? 99 : ap, br2 = bp === undefined ? 99 : bp;
      if (ar2 !== br2) return ar2 - br2;
      return String((a && a.id) || '').localeCompare(String((b && b.id) || ''));
    });
  }

  // [{name, cards}] — named sprints ascending, '' (unscheduled) always last.
  // Card order within a group is the caller's (already lane-sorted).
  function groupBySprint(cards) {
    const groups = new Map();
    for (const c of Array.isArray(cards) ? cards : []) {
      const name = sprintOf(c);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(c);
    }
    const names = [...groups.keys()].filter((n) => n !== '').sort((a, b) => a.localeCompare(b));
    if (groups.has('')) names.push('');
    return names.map((name) => ({ name, cards: groups.get(name) }));
  }

  // chip-strip counts: done means the card's status is 'Done' right now
  function sprintStats(cards) {
    return groupBySprint(cards).map((g) => ({
      name: g.name,
      total: g.cards.length,
      done: g.cards.filter((c) => c && c.status === 'Done').length,
    }));
  }

  // Ordered render list for one lane: every lane card becomes {card, children}
  // — children from childrenOf for epic rows only, and ONLY children that are
  // not visible as rows elsewhere: a child already in laneCards renders in
  // this lane, and a child whose status maps to a DIFFERENT lane renders
  // there. Nesting either would swallow a row; a child with no dev lane
  // (e.g. Review) DOES nest so it can't vanish — same philosophy as
  // hierarchy.js nestedChildIds.
  function epicRows(cards, laneCards) {
    const all = Array.isArray(cards) ? cards : [];
    const rows = Array.isArray(laneCards) ? laneCards : [];
    const rowIds = new Set(rows.map((c) => c && c.id));
    const H = window.TodomdHierarchy;
    return rows.map((card) => {
      const kids = card && card.epic && H && H.childrenOf ? H.childrenOf(all, card.id) : [];
      const rowLane = card ? laneKeyFor(card.status) : null;
      const children = (Array.isArray(kids) ? kids : []).filter((k) => {
        if (!k || rowIds.has(k.id)) return false;
        const kLane = laneKeyFor(k.status);
        return kLane === null || kLane === rowLane;
      });
      return { card, children };
    });
  }

  /* ── part 2: render(el) DOM layer — reads app.js globals ── */

  // hierarchy.js is a separate script tag — degrade gracefully (no dep chips,
  // no nesting) rather than throw mid-render if it somehow isn't there
  function depStateOf(card, all) {
    const H = window.TodomdHierarchy;
    return H && H.dependencyState ? H.dependencyState(card, all) : { blocked: false, waitingOn: [] };
  }
  function progressOf(all, id) {
    const H = window.TodomdHierarchy;
    return H && H.epicProgress ? H.epicProgress(all, id) : { total: 0, done: 0 };
  }
  // same coercion as app.js/hierarchy.js asList: scalar/mapping/missing → list
  function asList(x) {
    return (Array.isArray(x) ? x : x ? [x] : []).map(String);
  }

  let rootEl = null;
  let draggedId = null;      // own drag state — never touches app.js draggedCardId
  let suppressClick = false; // a dragend is followed by a click — don't open the drawer on it
  let activeSprint = null;   // sprint chip filter: null = all, '' = unscheduled only

  // drop indicators scoped to .dev-* only — app.js's clearDropIndicators owns
  // .column/.card classes and must never be invoked from here
  function clearDevDropIndicators() {
    if (!rootEl) return;
    rootEl.querySelectorAll('.drag-over, .drag-invalid, .drop-before, .drop-at-end').forEach((el) => {
      el.classList.remove('drag-over', 'drag-invalid', 'drop-before', 'drop-at-end');
    });
    rootEl.querySelectorAll('.dev-lane[data-drop-before]').forEach((el) => delete el.dataset.dropBefore);
  }

  // api() is GET-only; every write goes through this one POST helper
  async function postCard(id, action, body) {
    try {
      const res = await fetch(`/api/cards/${id}/${action}?project=${encodeURIComponent(currentProject)}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      if (!res.ok) toast(out.error || 'save failed');
      else if (out.warning) toast(out.warning);
    } catch {
      toast('server unreachable — not saved');
    }
    // loadBoard re-fetches boardData then redraws #board; awaiting it means our
    // own re-render below sees the fresh cards, not the pre-write ones
    try { await loadBoard(); } catch { toast('saved, but board refresh failed — reload'); }
    render();
  }

  // legal drop on a lane = the lane accepts drops AND (it's the card's own
  // column → reorder, or app.js's human-move table allows the transition)
  function laneLegal(lane, source) {
    return !!(lane.dropStatus && source &&
      (source.status === lane.dropStatus || isHumanMoveAllowed(source.status, lane.dropStatus, source, boardData)));
  }

  function wireLaneDrop(sec, lane) {
    sec.addEventListener('dragover', (e) => {
      e.preventDefault();
      const source = findBoardCard(draggedId);
      clearDevDropIndicators();
      if (!source) return;
      const legal = laneLegal(lane, source);
      if (e.dataTransfer) e.dataTransfer.dropEffect = legal ? 'move' : 'none';
      if (!legal) { sec.classList.add('drag-invalid'); return; }
      sec.classList.add('drag-over');
      if (source.status === lane.dropStatus) {
        // same lane → reorder: first peer midpoint below the pointer is the
        // insertion point (app.js wireDrop's rule), the source excluded so a
        // card can never be its own beforeId
        const peers = [...sec.querySelectorAll('.dev-row')].filter((el) => el.dataset.id !== draggedId);
        const before = peers.find((el) => e.clientY < el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2);
        sec.dataset.dropBefore = before ? before.dataset.id : '';
        if (before) before.classList.add('drop-before');
        else sec.classList.add('drop-at-end');
      }
    });
    sec.addEventListener('dragleave', (e) => {
      if (!sec.contains(e.relatedTarget)) clearDevDropIndicators();
    });
    sec.addEventListener('drop', async (e) => {
      e.preventDefault();
      const id = (e.dataTransfer && e.dataTransfer.getData('text/todomd-id')) || draggedId;
      const source = findBoardCard(id);
      const beforeId = sec.dataset.dropBefore || null;
      clearDevDropIndicators();
      if (!id || !source) return;
      if (!laneLegal(lane, source)) {
        toast(`${lane.dropStatus || lane.label} is set by the orchestrator`);
        return;
      }
      const sameLane = source.status === lane.dropStatus;
      await postCard(id, sameLane ? 'reorder' : 'move', sameLane ? { beforeId } : { status: lane.dropStatus });
    });
  }

  // sprint heads and chips tag the dropped card's sprint — tagging is not a
  // status move, so lane legality doesn't apply (a live-run refusal comes back
  // as a toast via postCard). stopPropagation keeps the enclosing lane's own
  // dragover/drop from double-handling the same event.
  function wireSprintTarget(el) {
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearDevDropIndicators(); // the lane's handler is stopped — clear its indicators ourselves
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drag-over');
      const id = (e.dataTransfer && e.dataTransfer.getData('text/todomd-id')) || draggedId;
      if (!id) return;
      await postCard(id, 'set', { sprint: el.dataset.sprint || '' });
    });
  }

  // chips: priority / blocked / epic progress / assignee — escaped everywhere
  // user-written frontmatter lands in markup
  function rowChips(card, allCards) {
    const chips = [];
    if (card.priority) chips.push(`<span class="chip dev-chip-prio">${esc(String(card.priority))}</span>`);
    const dep = depStateOf(card, allCards);
    if (dep.blocked) chips.push(`<span class="chip dev-chip-blocked">waits on ${esc(dep.waitingOn.map((w) => w.id).join(', '))}</span>`);
    if (card.epic) {
      const p = progressOf(allCards, card.id);
      chips.push(`<span class="chip dev-chip-epic">${p.done}/${p.total}</span>`);
    }
    if (card.assignee) chips.push(`<span class="dev-row-assignee">${esc(String(card.assignee))}</span>`);
    return chips.join('');
  }

  function renderRow(row, lane, allCards, viewer) {
    const card = row.card;
    const el = document.createElement('article');
    el.className = 'dev-row';
    el.dataset.id = card.id;
    el.draggable = !viewer;
    // the stage chip only exists in in-flight — the lane name already answers
    // "which column" everywhere else
    const stage = lane.key === 'in-flight' ? `<span class="dev-row-stage">${esc(String(card.status || ''))}</span>` : '';
    el.innerHTML = `<header class="dev-row-head"><span class="dev-row-id">${esc(String(card.id || card.file || ''))}</span>${stage}</header>` +
      `<h4 class="dev-row-title">${esc(String(card.title || card.file || card.id || ''))}</h4>` +
      `<div class="dev-row-chips">${rowChips(card, allCards)}</div>` +
      `<ul class="dev-row-children" hidden></ul>`;

    const kidsUl = el.querySelector('.dev-row-children');
    if (row.children.length) {
      const key = epicCollapseKey(card.id);
      const collapsed = collapsedEpicIds.has(key);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'dev-epic-toggle';
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.textContent = `${collapsed ? '▸' : '▾'} ${row.children.length} subtask${row.children.length === 1 ? '' : 's'}`;
      toggle.addEventListener('click', (e) => {
        e.stopPropagation(); // don't let the row's own click open the drawer
        if (collapsed) collapsedEpicIds.delete(key); else collapsedEpicIds.add(key);
        render(); // cheap full re-render, same as app.js's epic toggle
      });
      el.querySelector('.dev-row-chips').appendChild(toggle);
      kidsUl.hidden = collapsed;
      kidsUl.innerHTML = row.children.map((k) => {
        const dep = depStateOf(k, allCards);
        const note = dep.blocked ? `<span class="dev-child-dep">waits on ${esc(dep.waitingOn.map((w) => w.id).join(', '))}</span>` : '';
        return `<li class="dev-child" data-id="${esc(String(k.id))}"><span class="dev-child-title">${esc(String(k.title || k.id || ''))}</span><span class="dev-child-status">${esc(String(k.status || ''))}</span>${note}</li>`;
      }).join('');
      kidsUl.querySelectorAll('.dev-child').forEach((li) => {
        li.addEventListener('click', (e) => { e.stopPropagation(); openDrawer(li.dataset.id); });
      });
    }

    el.addEventListener('click', () => { if (!suppressClick) openDrawer(card.id); });
    if (!viewer) {
      el.addEventListener('dragstart', (e) => {
        draggedId = card.id;
        e.dataTransfer.setData('text/todomd-id', card.id);
        e.dataTransfer.effectAllowed = 'move';
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => {
        draggedId = null;
        el.classList.remove('dragging');
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
        clearDevDropIndicators();
      });
    }
    return el;
  }

  function render(el) {
    if (el) rootEl = el;
    if (!rootEl) return;
    const root = rootEl;
    root.innerHTML = '';
    const data = boardData || {};
    const cfg = data.config;
    const cards = Array.isArray(data.cards) ? data.cards : [];
    const viewer = data.access === 'viewer';

    // same filter shape as app.js renderBoard so both views agree on "matches"
    const filter = String((filterInput && filterInput.value) || '').trim().toLowerCase();
    const mine = viewMode === 'mine' && myName ? String(myName).toLowerCase() : null;
    const passes = (c) => c && devVisible(c, cfg)
      && (!mine || String(c.assignee || '').toLowerCase() === mine)
      && (!filter || `${c.id} ${c.title} ${asList(c.labels).join(' ')} ${String(c.assignee || '')}`.toLowerCase().includes(filter));
    const visible = cards.filter(passes);
    // the strip counts come from `visible` (pre-sprint-filter) so the chips
    // stay stable while one is active; lanes render `shown`
    const shown = activeSprint === null ? visible : visible.filter((c) => sprintOf(c) === activeSprint);

    const strip = document.createElement('div');
    strip.className = 'dev-sprints';
    strip.innerHTML = sprintStats(visible).map((s) => {
      const cls = ['dev-sprint-chip'];
      if (s.name === '') cls.push('dev-sprint-none');
      if (activeSprint === s.name) cls.push('active');
      const label = s.name === '' ? 'unscheduled' : esc(s.name);
      const count = s.name === '' ? String(s.total) : `${s.done}/${s.total}`;
      return `<button type="button" class="${cls.join(' ')}" data-sprint="${esc(s.name)}">${label} <b>${count}</b></button>`;
    }).join('') + (viewer ? '' : '<button type="button" class="dev-sprint-chip dev-sprint-new">+ new sprint</button>');
    strip.querySelectorAll('.dev-sprint-chip[data-sprint]').forEach((chip) => {
      chip.addEventListener('click', () => {
        activeSprint = activeSprint === chip.dataset.sprint ? null : chip.dataset.sprint;
        render();
      });
      if (!viewer) wireSprintTarget(chip);
    });
    const newChip = strip.querySelector('.dev-sprint-new');
    if (newChip) newChip.addEventListener('click', () => {
      const name = prompt('sprint name?');
      if (name && name.trim()) { activeSprint = name.trim(); render(); }
    });
    if (!viewer && newChip) {
      newChip.addEventListener('dragover', (e) => {
        e.preventDefault();
        clearDevDropIndicators();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        newChip.classList.add('drag-over');
      });
      newChip.addEventListener('dragleave', () => newChip.classList.remove('drag-over'));
      newChip.addEventListener('drop', async (e) => {
        e.preventDefault();
        newChip.classList.remove('drag-over');
        const id = (e.dataTransfer && e.dataTransfer.getData('text/todomd-id')) || draggedId;
        const name = prompt('sprint name?');
        if (!id || !name || !name.trim()) return;
        await postCard(id, 'set', { sprint: name.trim() });
      });
    }
    root.appendChild(strip);

    const lanesEl = document.createElement('div');
    lanesEl.className = 'dev-lanes';
    for (const lane of LANES) {
      const laneCards = sortForLane(shown.filter((c) => laneKeyFor(c.status, cfg) === lane.key));
      const sec = document.createElement('section');
      sec.className = 'dev-lane';
      sec.dataset.lane = lane.key;
      if (lane.dropStatus) sec.dataset.status = lane.dropStatus;
      sec.innerHTML = `<header class="dev-lane-head"><span class="dev-lane-name">${esc(lane.label)}</span><span class="dev-lane-count">${laneCards.length}</span></header>`;
      if (!laneCards.length) {
        const p = document.createElement('p');
        p.className = 'dev-lane-empty';
        p.textContent = 'empty';
        sec.appendChild(p);
      } else {
        // rows are built once per lane (rowIds must see the WHOLE lane or a
        // same-lane child in another sprint group would nest AND render),
        // then dealt out to their sprint groups
        const rowByCard = new Map();
        for (const r of epicRows(cards, laneCards)) rowByCard.set(r.card, r);
        for (const g of groupBySprint(laneCards)) {
          if (!g.cards.length) continue;
          const grp = document.createElement('div');
          grp.className = 'dev-sprint-group';
          const head = document.createElement('div');
          head.className = 'dev-sprint-head';
          head.dataset.sprint = g.name;
          head.textContent = g.name || 'unscheduled';
          if (!viewer) wireSprintTarget(head);
          grp.appendChild(head);
          const list = document.createElement('div');
          list.className = 'dev-lane-cards';
          for (const c of g.cards) list.appendChild(renderRow(rowByCard.get(c), lane, cards, viewer));
          grp.appendChild(list);
          sec.appendChild(grp);
        }
      }
      if (!viewer) wireLaneDrop(sec, lane);
      lanesEl.appendChild(sec);
    }
    root.appendChild(lanesEl);
  }

  window.TodomdDevflow = {
    LANES,
    laneKeyFor,
    sprintOf,
    devVisible,
    sortForLane,
    groupBySprint,
    sprintStats,
    epicRows,
    render,
  };
})();
