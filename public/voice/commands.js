// Command routing (docs/voice.md § Phrases and confirmation). This module is
// the only thing that turns a Realtime tool call into an Actions API request
// and turns the human's spoken reply into a confirm/reject call — the model
// itself has no execute or confirm tool (src/realtime.js). Every dependency
// (the controller, fetch, the token/project pair) is injected, so this is
// testable with plain fakes; there is no DOM access here at all.
//
// Suppression sequence when a mutation is proposed (voice-control-plan.md §
// Command recognition): disable automatic model responses/interruption BEFORE
// the model's readback turn plays, let it speak the immutable server
// read-back with `tool_choice: 'none'` so it cannot call another tool on top
// of its own turn, and WAIT for that turn's own `response.done` to arrive.
// Only then clear buffered input audio and open the confirmation window —
// opening it any earlier would let a transcript that lands mid-readback (an
// echo, a leftover finalized fragment) resolve the confirmation before the
// human ever heard what they'd be confirming, and would burn part of the
// fixed confirmation timeout on read-back latency instead of the human's
// actual reply. Restoring auto-response happens the moment the window
// closes, whichever way it closes.

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

// A `response.done` for the readback should arrive almost immediately over an
// open data channel; this only guards against one that's lost entirely (the
// session died mid-readback with no onClose race left to catch), so the
// confirmation window still opens — or the proposal still gets released —
// instead of hanging forever.
const READBACK_TIMEOUT_MS = 8_000;

export function createCommandRouter({
  controller,
  token = '',
  project = () => '',
  fetchFn = (...args) => fetch(...args),
  setTimeoutFn = (...args) => setTimeout(...args),
  clearTimeoutFn = (...args) => clearTimeout(...args),
  readbackTimeoutMs = READBACK_TIMEOUT_MS,
} = {}) {
  let pendingReadbackDone = null; // resolver for the readback response currently in flight, if any

  // Resolves once the readback response's own `response.done` arrives (or the
  // bounded timeout elapses). Armed synchronously so a caller can safely send
  // `response.create` on the very next line — there is no window in which a
  // same-tick `response.done` could arrive before this is listening.
  function waitForReadbackDone() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (pendingReadbackDone === finish) pendingReadbackDone = null;
        clearTimeoutFn(timer);
        resolve();
      };
      pendingReadbackDone = finish;
      const timer = setTimeoutFn(finish, readbackTimeoutMs);
    });
  }

  // Realtime session event, forwarded by the controller — see main.js.
  function handleResponseDone() {
    pendingReadbackDone?.();
  }

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

    // Suppress automatic responses/interruption BEFORE the model's readback
    // turn plays, so no stray audio during that turn can trigger a second
    // automatic response or tool call. Arm the readback wait synchronously,
    // immediately before triggering the one response this tool result is
    // allowed to produce, so no `response.done` for it can be missed.
    controller.send(suppressionUpdate(false));
    controller.send(functionCallOutput(call_.callId, {
      ok: true, readback: proposal.readback, confirmation: proposal.confirmation,
    }));
    const readbackDone = waitForReadbackDone();
    controller.send(requestResponse());
    await readbackDone;

    // Only now — after the readback has actually finished playing — drop
    // whatever audio buffered during it and open the confirmation window.
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
      // Lost the race — sign-off/offline/another proposal landed while the
      // readback was playing. There is no longer an active session to
      // confirm through, so release the reservation instead of leaving it to
      // expire on its own. The tool call already got its result above; there
      // is no live session left to speak anything further into.
      controller.send(suppressionUpdate(true));
      reject(proposal.proposalId);
    }
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

  return { handleToolCall, handleResponseDone };
}
