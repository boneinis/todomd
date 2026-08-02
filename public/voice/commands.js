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
// of its own turn, and WAIT until that specific turn has finished speaking.
// Only then clear buffered input audio and open the confirmation window —
// opening it any earlier would let a transcript that lands mid-readback (an
// echo of the challenge phrase the assistant is speaking aloud, a leftover
// finalized fragment) resolve the confirmation before the human ever heard
// what they'd be confirming, and would burn part of the fixed confirmation
// timeout on read-back latency instead of the human's actual reply. If that
// turn cannot be shown to have finished, the proposal is released rather than
// confirmed against. Restoring auto-response happens the moment the window
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

// A read-back is a single short sentence, so its lifecycle events should all
// arrive within a second or two over an open data channel. This only guards
// against a set that never completes (the session died mid-readback with no
// onClose race left to catch), so the proposal gets released instead of
// hanging forever.
const READBACK_TIMEOUT_MS = 8_000;
const READBACK_METADATA_KEY = 'todomd_readback_id';

export function createCommandRouter({
  controller,
  token = '',
  project = () => '',
  fetchFn = (...args) => fetch(...args),
  setTimeoutFn = (...args) => setTimeout(...args),
  clearTimeoutFn = (...args) => clearTimeout(...args),
  readbackTimeoutMs = READBACK_TIMEOUT_MS,
} = {}) {
  let pendingReadback = null; // the readback turn currently being waited on, if any
  let activeMutation = null; // one proposal lifecycle at a time, including its async prepare

  function releaseMutation(owner) {
    if (activeMutation === owner) activeMutation = null;
  }

  // Resolves with { completed } once the readback turn has finished SPEAKING,
  // or { timedOut } / { failed } if it cannot be shown to have done so.
  //
  // Armed synchronously, immediately before the caller sends its
  // `response.create`. The request carries a unique metadata value and only a
  // `response.created` echoing that exact value may bind the provider's
  // response id. Event order is not an identity boundary: an unrelated manual
  // or queued response can be created in the same interval.
  //
  // Completion is the readback's `output_audio_buffer.stopped`, not its
  // `response.done`: the latter means generation finished, while on WebRTC
  // the output audio is still draining afterwards.
  function waitForReadback(readbackId) {
    return new Promise((resolve) => {
      const wait = {
        readbackId,
        responseId: null,
        settled: false,
        settle(outcome) {
          if (wait.settled) return;
          wait.settled = true;
          if (pendingReadback === wait) pendingReadback = null;
          clearTimeoutFn(wait.timer);
          resolve(outcome);
        },
      };
      wait.timer = setTimeoutFn(() => wait.settle({ timedOut: true }), readbackTimeoutMs);
      pendingReadback = wait;
    });
  }

  // Realtime response lifecycle, forwarded by the controller — see main.js.
  // Everything that does not belong to the readback currently being waited on
  // is ignored, including every event while no wait is armed.
  function handleResponseEvent(event) {
    const wait = pendingReadback;
    if (!wait || !event) return;
    if (event.type === 'response.created') {
      if (wait.responseId === null
        && event.readbackId === wait.readbackId
        && typeof event.responseId === 'string') wait.responseId = event.responseId;
      return;
    }
    if (wait.responseId === null || event.responseId !== wait.responseId) return;
    if (event.type === 'response.done') {
      // A response that failed, was cancelled, or came back incomplete will
      // never finish playing — give up now rather than at the timeout.
      if (event.status && event.status !== 'completed') wait.settle({ failed: true, status: event.status });
      return;
    }
    if (event.type === 'output_audio_buffer.stopped') wait.settle({ completed: true });
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
  async function settle(proposal, text, mutation) {
    controller.send(suppressionUpdate(true));
    try {
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
    } finally {
      releaseMutation(mutation);
    }
  }

  async function handleProposeBoardAction(call_) {
    const { cardId, action, arguments: actionArguments } = call_.arguments || {};
    if (typeof cardId !== 'string' || typeof action !== 'string') {
      controller.send(functionCallOutput(call_.callId, { ok: false, error: 'cardId and action are required' }));
      controller.send(requestResponse());
      return;
    }
    if (activeMutation) {
      // A second tool call can arrive in the same provider response while the
      // first proposal POST is still in flight. Return its tool output, but do
      // not create another model response: the accepted proposal's correlated
      // read-back will consume all tool outputs after the prepare settles.
      controller.send(functionCallOutput(call_.callId, {
        ok: false,
        error: 'another board action is already awaiting confirmation',
      }));
      return;
    }
    const mutation = { callId: call_.callId };
    activeMutation = mutation;
    const body = { cardId, action };
    if (actionArguments !== undefined) body.arguments = actionArguments;
    const result = await call('actions', { method: 'POST', body });
    if (!result.ok) {
      releaseMutation(mutation);
      controller.send(functionCallOutput(call_.callId, { ok: false, error: result.body?.error || 'unable to prepare this action' }));
      controller.send(requestResponse());
      return;
    }
    const proposal = result.body;
    if (typeof proposal?.proposalId !== 'string' || typeof proposal.confirmation?.tier !== 'string') {
      releaseMutation(mutation);
      controller.send(functionCallOutput(call_.callId, { ok: false, error: 'the board returned an invalid action proposal' }));
      controller.send(requestResponse());
      return;
    }
    if (proposal.confirmation?.tier === 'visible') {
      // Cancel, Restart Build, and archive are never voice-confirmable — the
      // existing card-drawer buttons are the only approval path for them.
      // Reject the reservation immediately instead of leaving it pending for
      // its TTL, so a later voice request for the same card isn't blocked by
      // a proposal nothing will ever confirm.
      await reject(proposal.proposalId);
      releaseMutation(mutation);
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
    // allowed to produce, so none of that response's lifecycle events — the
    // `response.created` that names it least of all — can be missed.
    controller.send(suppressionUpdate(false));
    controller.send(functionCallOutput(call_.callId, {
      ok: true, readback: proposal.readback, confirmation: proposal.confirmation,
    }));
    const readback = waitForReadback(proposal.proposalId);
    controller.send(requestResponse({ metadata: { [READBACK_METADATA_KEY]: proposal.proposalId } }));
    const outcome = await readback;

    if (!outcome.completed) {
      // The readback is not known to have finished speaking — its lifecycle
      // events were lost, or the turn failed/was cancelled. Opening a
      // confirmation window now would ask the human to confirm something they
      // may never have heard, and would leave that window open to the
      // assistant's own audio, so release the reservation instead.
      controller.send(suppressionUpdate(true));
      await reject(proposal.proposalId);
      releaseMutation(mutation);
      speak('Cancelled — nothing was changed.');
      return;
    }

    // Only now — after the readback has actually finished playing — drop
    // whatever audio buffered during it and open the confirmation window.
    controller.send({ type: 'input_audio_buffer.clear' });
    const entered = controller.enterConfirming({
      challenge: proposal.confirmation.challenge,
      onResolve: (text) => settle(proposal, text, mutation),
      onTimeout: async () => {
        controller.send(suppressionUpdate(true));
        try {
          await reject(proposal.proposalId);
          speak('Cancelled — you did not confirm in time.');
        } finally {
          releaseMutation(mutation);
        }
      },
    });
    if (!entered) {
      // Lost the race — sign-off/offline/another proposal landed while the
      // readback was playing. There is no longer an active session to
      // confirm through, so release the reservation instead of leaving it to
      // expire on its own. The tool call already got its result above; there
      // is no live session left to speak anything further into.
      controller.send(suppressionUpdate(true));
      await reject(proposal.proposalId);
      releaseMutation(mutation);
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

  return { handleToolCall, handleResponseEvent };
}
