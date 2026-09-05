// Shares the authenticated desktop session; agent text is rendered as text only.
(() => {
  const el = (id) => document.getElementById(id);
  const dialog = el('board-agent-dialog');
  let polling, lastRender = '', loading = false;
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
    if (settings) {
      const c = state.config;
      for (const [id, key] of [['contact','contact'], ['instructions','instructions'], ['agent','agent'], ['model','model'], ['limit','maxActionsPerTurn']]) el('ba-' + id).value = c[key];
      el('ba-watch').checked = c.watch;
      el('ba-boards').replaceChildren(); el('ba-permissions').replaceChildren();
      for (const name of state.availableProjects) choice(el('ba-boards'), name, name, c.boards.includes(name));
      for (const [key, label] of Object.entries(state.routineActions)) choice(el('ba-permissions'), key, label, c.allowedActions.includes(key));
      contactMode();
    }
    if (state.storageError) error(new Error(state.storageError));
    el('ba-status').textContent = state.stopped ? 'Stopped · save rules to resume' : state.busy ? 'Agent is working…' : state.config.contact === 'external' ? 'External agent · shared inbox' : state.config.watch ? 'Watching selected boards' : 'Ready · watching off';
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
    try { render(await request(), settings); } catch (e) { error(e); } finally { loading = false; }
  }
  el('board-agent-open').onclick = async () => {
    dialog.showModal(); error(); await refresh(true);
    clearInterval(polling); polling = setInterval(() => refresh(), 1500);
  };
  el('ba-close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { clearInterval(polling); });
  el('ba-contact').onchange = contactMode;
  el('ba-settings').onsubmit = async (event) => {
    event.preventDefault(); error();
    const selected = (id) => [...el(id).querySelectorAll('input:checked')].map((input) => input.value);
    try {
      const state = await request('/config', { contact: el('ba-contact').value, boards: selected('ba-boards'), allowedActions: selected('ba-permissions'),
        instructions: el('ba-instructions').value, agent: el('ba-agent').value, model: el('ba-model').value,
        maxActionsPerTurn: Number(el('ba-limit').value), watch: el('ba-watch').checked });
      render(state, true);
    } catch (e) { error(e); }
  };
  el('ba-message').onsubmit = async (event) => {
    event.preventDefault(); error(); el('ba-send').disabled = true;
    const text = el('ba-text').value;
    el('ba-text').value = '';
    try { await request('/message', { text }); } catch (e) { error(e); if (!el('ba-text').value) el('ba-text').value = text; }
    await refresh();
  };
  el('ba-stop').onclick = async () => { try { await request('/stop', {}); el('ba-watch').checked = false; await refresh(); } catch (e) { error(e); } };
  document.addEventListener('todomd:context', (event) => {
    el('board-agent-open').hidden = event.detail?.primary !== true;
    if (event.detail?.primary !== true && dialog.open) dialog.close();
  });
})();
