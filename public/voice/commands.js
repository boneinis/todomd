// Command routing (docs/voice.md § Phrases and confirmation). This module is
// the only thing that turns a Realtime tool call into an Actions API request
// and turns the human's spoken reply into a confirm/reject call — the model
// itself has no execute or confirm tool (src/realtime.js). Every dependency
// (the controller, fetch, the token/project pair) is injected, so this is
// testable with plain fakes; there is no DOM access here at all.
//
// Suppression sequence when a mutation is proposed (voice-control-plan.md §
// Command recognition): clear any buffered input audio, disable automatic
// model responses/interruption so only the human's answer can end the window,
// then let the model speak the immutable server read-back with `tool_choice:
// 'none'` so it cannot call another tool on top of its own turn. Restoring
// happens the moment the window closes, whichever way it closes.

function normalizePhrase(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function functionCallOutput(callId, output) {
  return {
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
  };
}

// tool_choice: 'none' on every response this module triggers — the model may
// speak, but it may never call another tool as a side effect of relaying a
// board fact, a read-back, or a completion result.
function requestResponse(overrides = {}) {
  return { type: 'response.create', response: { tool_choice: 'none', ...overrides } };
}

function suppressionUpdate(createResponse) {
  return {
    type: 'session.update',
    session: { audio: { input: { turn_detection: { type: 'server_vad', create_response: createResponse, interrupt_response: createResponse } } } },
  };
}

export function createCommandRouter({
  controller,
  token = '',
  project = () => '',
  fetchFn = (...args) => fetch(...args),
} = {}) {
  async function call(path, { method = 'GET', body } = {}) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `/api/voice/${path}${sep}project=${encodeURIComponent(project())}`;
    try {
      const res = await fetchFn(url, {
        method,
        headers: {
          'x-todomd-token': token,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      let data = {};
      try { data = await res.json(); } catch { /* an error response can arrive with no body */ }
      return { ok: res.ok, status: res.status, body: data };
    } catch {
      return { ok: false, status: 0, body: { error: 'network error' } };
    }
  }

  function reject(proposalId) {
    return call(`actions/${encodeURIComponent(proposalId)}/reject`, { method: 'POST', body: {} });
  }
  function confirm(proposalId, text) {
    return call(`actions/${encodeURIComponent(proposalId)}/confirm`, { method: 'POST', body: { confirmation: text } });
  }

  function speak(text) {
    controller.send(requestResponse({ instructions: text }));
  }

  async function handleReadBoardReport(call_) {
    const result = await call('summary');
    controller.send(functionCallOutput(call_.callId, result.ok
      ? { ok: true, text: result.body.text }
      : { ok: false, error: result.body?.error || 'the board report is unavailable right now' }));
    controller.send(requestResponse());
  }

  async function handleReadCard(call_) {
    const cardId = typeof call_.arguments?.cardId === 'string' ? call_.arguments.cardId : '';
    if (!cardId) {
      controller.send(functionCallOutput(call_.callId, { ok: false, error: 'cardId is required' }));
      controller.send(requestResponse());
      return;
    }
    const result = await call(`cards/${encodeURIComponent(cardId)}`);
    controller.send(functionCallOutput(call_.callId, result.ok
      ? { ok: true, text: result.body.text }
      : { ok: false, error: result.body?.error || 'card not found' }));
    controller.send(requestResponse());
  }

  // Resolves the human's finalized reply to an outstanding proposal: an exact
  // match confirms, anything else — a rejection, a stale reply, an unrelated
  // sentence — rejects. The server independently re-checks the exact phrase
  // at confirm time; this decides only which of the two endpoints to call.
  async function settle(proposal, text) {
    controller.send(suppressionUpdate(true));
    const tier = proposal.confirmation.tier;
    const expected = tier === 'reversible' ? 'yes to do' : normalizePhrase(proposal.confirmation.challenge);
    const matches = normalizePhrase(text) === expected;
    if (!matches) {
      await reject(proposal.proposalId);
      speak('Cancelled — nothing was changed.');
      return;
    }
    const outcome = await confirm(proposal.proposalId, text);
    speak(outcome.ok
      ? `Done — ${proposal.readback}.`
      : `That could not be completed: ${outcome.body?.error || 'unknown error'}.`);
  }

  async function handleProposeBoardAction(call_) {
    const { cardId, action, arguments: actionArguments } = call_.arguments || {};
    if (typeof cardId !== 'string' || typeof action !== 'string') {
      controller.send(functionCallOutput(call_.callId, { ok: false, error: 'cardId and action are required' }));
      controller.send(requestResponse());
      return;
    }
    const body = { cardId, action };
    if (actionArguments !== undefined) body.arguments = actionArguments;
    const result = await call('actions', { method: 'POST', body });
    if (!result.ok) {
      controller.send(functionCallOutput(call_.callId, { ok: false, error: result.body?.error || 'unable to prepare this action' }));
      controller.send(requestResponse());
      return;
    }
    const proposal = result.body;
    if (proposal.confirmation?.tier === 'visible') {
      // Cancel, Restart Build, and archive are never voice-confirmable — the
      // existing card-drawer buttons are the only approval path for them.
      // Reject the reservation immediately instead of leaving it pending for
      // its TTL, so a later voice request for the same card isn't blocked by
      // a proposal nothing will ever confirm.
      reject(proposal.proposalId);
      controller.send(functionCallOutput(call_.callId, {
        ok: true, readback: proposal.readback, requiresVisibleApproval: true,
      }));
      controller.send(requestResponse());
      return;
    }

    // Suppress automatic responses/interruption and drop buffered input audio
    // BEFORE the model's readback turn plays, so no stray audio during that
    // turn can trigger a second automatic response or tool call once entering
    // confirming below.
    controller.send(suppressionUpdate(false));
    controller.send({ type: 'input_audio_buffer.clear' });
    const entered = controller.enterConfirming({
      challenge: proposal.confirmation.challenge,
      onResolve: (text) => settle(proposal, text),
      onTimeout: () => {
        controller.send(suppressionUpdate(true));
        reject(proposal.proposalId);
        speak('Cancelled — you did not confirm in time.');
      },
    });
    if (!entered) {
      // Lost the race — sign-off/offline/another proposal landed while this
      // one was being prepared. There is no longer an active session to
      // confirm through, so release the reservation instead of leaving it to
      // expire on its own.
      controller.send(suppressionUpdate(true));
      reject(proposal.proposalId);
      controller.send(functionCallOutput(call_.callId, { ok: false, error: 'no longer listening for a confirmation' }));
      controller.send(requestResponse());
      return;
    }
    controller.send(functionCallOutput(call_.callId, {
      ok: true, readback: proposal.readback, confirmation: proposal.confirmation,
    }));
    controller.send(requestResponse());
  }

  async function handleToolCall(toolCall) {
    if (!toolCall || typeof toolCall.callId !== 'string' || typeof toolCall.name !== 'string') return;
    if (toolCall.arguments === null) {
      controller.send(functionCallOutput(toolCall.callId, { ok: false, error: 'malformed tool arguments' }));
      controller.send(requestResponse());
      return;
    }
    if (toolCall.name === 'read_board_report') return handleReadBoardReport(toolCall);
    if (toolCall.name === 'read_card') return handleReadCard(toolCall);
    if (toolCall.name === 'propose_board_action') return handleProposeBoardAction(toolCall);
    controller.send(functionCallOutput(toolCall.callId, { ok: false, error: `unknown tool: ${toolCall.name}` }));
    controller.send(requestResponse());
  }

  return { handleToolCall };
}
