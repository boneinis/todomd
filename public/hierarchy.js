// Pure epic/chunk hierarchy helpers — no DOM, no fetch — shared between
// public/app.js and test/hierarchy.test.js (loaded there via node:vm).
//
// A CLASSIC script (window.TodomdHierarchy), not an ES module: index.html
// loads /app.js with a plain <script src>, and a type=module helper would
// execute AFTER it and race the first render.
//
// Every card here is hand- or agent-written, so list fields (dependencies,
// children) can arrive as a scalar, a YAML mapping, or missing — nothing
// below may throw on that. A scalar `dependencies:` reaching `.some()` once
// blanked the entire board (see test/ui/ui-smoke.test.js).
(function () {
  'use strict';

  // same coercion as the pre-existing app.js asList: scalar/mapping/missing → a list
  function asList(x) {
    return (Array.isArray(x) ? x : x ? [x] : []).map(String);
  }

  // Children of an epic, ordered by their dependency chain then id (a
  // topological sort, tie-broken by id) so rows render in build order.
  // A cycle between siblings can't fully resolve — the leftover cards are
  // appended by id rather than dropped or thrown on.
  function childrenOf(cards, epicId) {
    const kids = (Array.isArray(cards) ? cards : []).filter((c) => c && c.parent === epicId);
    const ids = new Set(kids.map((c) => c.id));
    const byId = new Map(kids.map((c) => [c.id, c]));
    const indegree = new Map(kids.map((c) => [c.id, 0]));
    const dependents = new Map(kids.map((c) => [c.id, []]));
    for (const c of kids) {
      for (const dep of asList(c.dependencies)) {
        if (dep === c.id || !ids.has(dep)) continue; // ignore self-deps and deps outside this epic
        dependents.get(dep).push(c.id);
        indegree.set(c.id, indegree.get(c.id) + 1);
      }
    }
    const ready = kids.map((c) => c.id).filter((id) => indegree.get(id) === 0).sort();
    const seen = new Set();
    const order = [];
    while (ready.length) {
      const id = ready.shift();
      seen.add(id);
      order.push(id);
      for (const next of dependents.get(id)) {
        indegree.set(next, indegree.get(next) - 1);
        if (indegree.get(next) === 0) {
          let i = 0;
          while (i < ready.length && ready[i] < next) i++;
          ready.splice(i, 0, next);
        }
      }
    }
    for (const id of kids.map((c) => c.id).sort()) if (!seen.has(id)) order.push(id); // cycle leftovers
    return order.map((id) => byId.get(id));
  }

  function epicProgress(cards, epicId) {
    const kids = (Array.isArray(cards) ? cards : []).filter((c) => c && c.parent === epicId);
    return { total: kids.length, done: kids.filter((c) => c.status === 'Done').length };
  }

  // blocked when any dependency id is missing from the board or not Done;
  // waitingOn lists just those blocking dependencies (status: null if the id has no card)
  function dependencyState(card, cards) {
    const list = Array.isArray(cards) ? cards : [];
    const waitingOn = [];
    for (const id of asList(card && card.dependencies)) {
      const dep = list.find((c) => c && c.id === id);
      if (!dep || dep.status !== 'Done') waitingOn.push({ id, status: dep ? dep.status : null });
    }
    return { blocked: waitingOn.length > 0, waitingOn };
  }

  // stage columns ARE the "active execution columns" — derived from config,
  // never hardcoded, so a renamed/added stage stays correct automatically
  function isExecutionColumn(status, config) {
    return !!((config && config.stages) || {})[status];
  }

  // ids to render as nested subtask rows: has a parent, that parent is
  // present on the board, and its own status isn't an execution column. A
  // child whose parent is absent (archived/filtered out) is NOT nested — it
  // must still render as a full card or it vanishes from the board entirely.
  function nestedChildIds(cards, config) {
    const list = Array.isArray(cards) ? cards : [];
    const byId = new Set(list.filter((c) => c && c.id).map((c) => c.id));
    const nested = new Set();
    for (const c of list) {
      if (!c || !c.parent || !byId.has(c.parent)) continue;
      if (isExecutionColumn(c.status, config)) continue;
      nested.add(c.id);
    }
    return nested;
  }

  window.TodomdHierarchy = {
    asList,
    childrenOf,
    epicProgress,
    dependencyState,
    isExecutionColumn,
    nestedChildIds,
  };
})();
