// Classic script, loaded after hierarchy.js. Data shaping only; no DOM/network.
(function () {
  'use strict';
  const GROUPS = [
    { key: 'attention', label: 'Needs attention', statuses: ['Needs Human', 'Review', 'Planned'] },
    { key: 'queued', label: 'Queued', statuses: ['Queue', 'Plan'] },
    { key: 'active', label: 'In progress', statuses: ['Build', 'CI', 'Verify'] },
    { key: 'deferred', label: 'Deferred', statuses: [] },
    { key: 'done', label: 'Done', statuses: ['Done'] },
  ];
  const priorities = { critical: 0, high: 1, medium: 2, low: 3 };
  function groupOf(card, cards) {
    if (card.status === 'Done') return 'done';
    if (card.archived || window.TodomdHierarchy.dependencyState(card, cards).blocked) return 'deferred';
    return GROUPS.find((g) => g.statuses.includes(card.status))?.key || 'attention';
  }
  function rows(cards, visibleCards = cards) {
    const all = (Array.isArray(cards) ? cards : []).filter(Boolean);
    const visible = (Array.isArray(visibleCards) ? visibleCards : []).filter(Boolean);
    const byId = new Map(visible.map((c) => [c.id, c]));
    const nested = new Set();
    for (const card of visible) {
      const parent = byId.get(card.parent);
      // A nested epic isn't a second nesting sink; malformed/cyclic parents
      // and children of hidden parents always remain accessible as roots.
      if (parent?.epic && parent.id !== card.id && !byId.get(parent.parent)?.epic) nested.add(card.id);
    }
    return visible.filter((c) => !nested.has(c.id)).map((card) => ({
      card,
      group: groupOf(card, all),
      progress: window.TodomdHierarchy.epicProgress(all, card.id),
      children: card.epic ? window.TodomdHierarchy.childrenOf(all, card.id)
        .filter((c) => nested.has(c.id) && byId.has(c.id)) : [],
    })).sort((a, b) => GROUPS.findIndex((g) => g.key === a.group) - GROUPS.findIndex((g) => g.key === b.group)
      || (priorities[a.card.priority] ?? 4) - (priorities[b.card.priority] ?? 4)
      || String(a.card.id || a.card.file).localeCompare(String(b.card.id || b.card.file)));
  }
  window.TodomdListView = { GROUPS, groupOf, rows };
})();
