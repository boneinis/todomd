// Shares the authenticated desktop session; agent text is rendered as text only.
(() => {
  const el = (id) => document.getElementById(id);
  const dialog = el('board-agent-dialog');
  let polling, lastRender = '', loading = false, scope = 'portfolio';
  const scopeBody = () => scope === 'portfolio' ? { scope } : { board_id: scope };
  const scopeQuery = () => scope === 'portfolio' ? '' : '?board_id=' + encodeURIComponent(scope);
  async function request(route = '', body) {
    const response = await fetch('/api/board-agent' + route, { headers: { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.error || 'Board Agent request failed');
    return result;
  }
  const error = (e) => { el('ba-error').textContent = e?.message || ''; };
  function choice(container, value, label, checked) {
    const line = document.createElement('label'); line.className = 'ba-check';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = value; input.checked = checked;
    line.append(input, document.createTextNode(label)); container.append(line);
  }
  function contactMode() {
    const external = el('ba-contact').value === 'external';
    el('ba-builtin').hidden = external; el('ba-external').hidden = !external;
  }
  function render(state, settings) {
    // Static assets may update while an older serve process is still running.
    if (!Array.isArray(state.boards)) {
      error(new Error('This Board Agent interface requires the updated server. Restart To-do MD in an idle window, then reopen this dialog. Existing board work is unchanged.'));
      el('ba-status').textContent = 'Server update required';
      for (const id of ['ba-save', 'ba-send', 'ba-stop']) el(id).disabled = true;
      return;
    }
    el('ba-stop').disabled = false;
    el('ba-migration').hidden = !state.migration;
    el('ba-migration').textContent = state.migration?.message || '';
    if (settings) {
      const c = state.boardPolicy || state.config;
      const selector = el('ba-scope'); selector.replaceChildren(new Option('All selected boards', 'portfolio'));
      for (const board of state.boards) selector.add(new Option(board.project + (board.available ? '' : ' (unavailable)'), board.board_id));
      selector.value = scope;
      el('ba-rebind-controls').hidden = state.available !== false;
      el('ba-rebind-project').replaceChildren(...state.availableProjects.map((name) => new Option(name, name)));
      el('ba-selection').hidden = scope !== 'portfolio';
      el('ba-board-rules').hidden = scope === 'portfolio';
      el('ba-publication-rules').hidden = scope === 'portfolio';
      el('ba-scope-hint').textContent = scope === 'portfolio' ? 'Portfolio conversation and board selection. Choose a board above to set its permissions and separate memory. New boards start with no routine permissions.' : 'This board keeps its own history, rules and stop control. Browser board switching does not change this conversation scope.';
      el('ba-publication').value = c.publication || 'review_required';
      el('ba-protected').value = (c.protectedBranches || ['main', 'master']).join(', ');
      el('ba-aliases').value = (c.aliases || []).join(', ');
      for (const [id, key] of [['contact','contact'], ['instructions','instructions'], ['agent','agent'], ['model','model'], ['limit','maxActionsPerTurn']]) el('ba-' + id).value = c[key];
      el('ba-watch').checked = c.watch;
      el('ba-watch-label').hidden = scope === 'portfolio';
      el('ba-boards').replaceChildren(); el('ba-permissions').replaceChildren();
      for (const name of state.availableProjects) choice(el('ba-boards'), name, name, state.config.boards.includes(name));
      for (const [key, label] of Object.entries(state.routineActions)) choice(el('ba-permissions'), key, label, c.allowedActions.includes(key));
      contactMode();
    }
    if (state.storageError) error(new Error(state.storageError));
    el('ba-status').textContent = state.stopped ? 'Stopped · save rules to resume' : state.busy ? 'Agent is working…' : (state.boardPolicy || state.config).contact === 'external' ? 'External agent · scoped inbox' : (state.boardPolicy || state.config).watch ? 'Watching this scope' : 'Ready · watching off';
    el('ba-status').textContent = (scope === 'portfolio' ? 'All selected boards' : state.boards.find((b) => b.board_id === scope)?.project || 'Board') + ' · ' + el('ba-status').textContent;
    el('ba-stop').textContent = scope === 'portfolio' ? 'Stop all coordinator turns' : 'Stop this board’s coordinator';
    el('ba-text').placeholder = scope === 'portfolio' ? 'What needs attention across my boards?' : 'What needs attention on this board?';
    el('ba-save').disabled = state.busy; el('ba-send').disabled = state.busy || state.stopped;
    const signature = JSON.stringify([state.history, state.pending, state.uncertain, state.busy]);
    if (signature === lastRender) return;
    lastRender = signature;
    const history = el('ba-history'), atBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 60;
    history.replaceChildren();
    if (!state.history.length) { const p = document.createElement('p'); p.textContent = 'Choose your boards and rules, then start the conversation.'; history.append(p); }
    for (const item of state.history) {
      const article = document.createElement('article'); article.className = 'ba-entry ba-' + item.role;
      const who = document.createElement('strong'); who.textContent = item.role === 'assistant' ? 'Board Agent' : item.role === 'user' ? 'You' : item.role === 'action' ? 'Board result' : 'Notice';
      const text = document.createElement('p'); text.textContent = item.content; article.append(who, text);
      if (item.result) { const details = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre'); summary.textContent = 'Action details'; pre.textContent = JSON.stringify(item.result, null, 2); details.append(summary, pre); article.append(details); }
      history.append(article);
    }
    if (atBottom || settings) history.scrollTop = history.scrollHeight;
    el('ba-pending').replaceChildren();
    for (const receipt of state.uncertain) { const p = document.createElement('p'); p.textContent = `Dispatch outcome unknown: ${receipt.action?.project || ''} ${receipt.action?.action || ''}. Inspect the board before retrying.`; el('ba-pending').append(p); }
    for (const proposal of state.pending) {
      const card = document.createElement('article'), title = document.createElement('strong'), reason = document.createElement('p');
      title.textContent = `${proposal.action.project} / ${proposal.action.card_id || 'board'} · ${proposal.action.action}`;
      reason.textContent = [proposal.reason, proposal.action.why].filter(Boolean).join('\n');
      const details = document.createElement('pre'); details.textContent = [proposal.action.title, proposal.action.description].filter(Boolean).join('\n');
      card.append(title, reason, details);
      for (const [label, accept] of [['Approve', true], ['Decline', false]]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.disabled = state.busy;
        button.onclick = async () => { button.disabled = true; try { error(); await request('/proposals/' + proposal.id, { accept }); } catch (e) { error(e); } finally { await refresh(); } };
        card.append(button);
      }
      el('ba-pending').append(card);
    }
  }
  async function refresh(settings = false) {
    if (loading) return;
    loading = true;
    try { render(await request(scopeQuery()), settings); } catch (e) { error(e); } finally { loading = false; }
  }
  el('board-agent-open').onclick = async () => {
    dialog.showModal(); error(); await refresh(true);
    clearInterval(polling); polling = setInterval(() => refresh(), 1500);
  };
  el('ba-close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { clearInterval(polling); });
  el('ba-contact').onchange = contactMode;
  el('ba-scope').onchange = async () => { scope = el('ba-scope').value; lastRender = ''; await refresh(true); };
  el('ba-rebind').onclick = async () => { try { const state = await request('/rebind', { board_id: scope, project: el('ba-rebind-project').value }); render(state, true); } catch (e) { error(e); } };
  el('ba-check-connection').onclick = async () => { try { const c = await request('/connection'); el('ba-connection').textContent = c.lastSeen ? 'Scoped tools last connected: ' + new Date(c.lastSeen).toLocaleString() + '. Test voice in your Codex task.' : 'Server is ready. No scoped tool call received yet. Restart the MCP connection in Codex, then ask for your board overview.'; } catch (e) { error(e); } };
  el('ba-revoke').onclick = async () => { try { const c = await request('/connection/revoke', {}); el('ba-connection').textContent = c.message; } catch (e) { error(e); } };
  el('ba-settings').onsubmit = async (event) => {
    event.preventDefault(); error();
    const selected = (id) => [...el(id).querySelectorAll('input:checked')].map((input) => input.value);
    try {
      const policy = { contact: el('ba-contact').value, instructions: el('ba-instructions').value,
        agent: el('ba-agent').value, model: el('ba-model').value, maxActionsPerTurn: Number(el('ba-limit').value), watch: scope !== 'portfolio' && el('ba-watch').checked };
      let state;
      if (scope === 'portfolio') state = await request('/config', { ...policy, boards: selected('ba-boards') });
      else state = await request('/board-config', { board_id: scope, policy: { ...policy, allowedActions: selected('ba-permissions'),
        publication: el('ba-publication').value, protectedBranches: el('ba-protected').value.split(',').map((s) => s.trim()).filter(Boolean),
        aliases: el('ba-aliases').value.split(',').map((s) => s.trim()).filter(Boolean) } });
      render(state, true);
    } catch (e) { error(e); }
  };
  el('ba-message').onsubmit = async (event) => {
    event.preventDefault(); error(); el('ba-send').disabled = true;
    const text = el('ba-text').value;
    el('ba-text').value = '';
    try { await request('/message', { text, ...scopeBody() }); } catch (e) { error(e); if (!el('ba-text').value) el('ba-text').value = text; }
    await refresh();
  };
  el('ba-stop').onclick = async () => { try { await request('/stop', scopeBody()); el('ba-watch').checked = false; await refresh(); } catch (e) { error(e); } };
  document.addEventListener('todomd:context', (event) => {
    el('board-agent-open').hidden = event.detail?.primary !== true;
    if (event.detail?.primary !== true && dialog.open) dialog.close();
  });
})();
