// public/voice/commands.js turns a Realtime tool call into an Actions API
// request, and the human's finalized spoken reply into a confirm/reject call.
// The model itself never gets a confirm/mutate tool (src/realtime.js); this
// file proves the browser-side router upholds the same contract — nothing
// executes on unrelated speech, rejection, timeout, or a proposal the router
// itself decided not to trust (a race, a visible-tier action).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommandRouter } from '../public/voice/commands.js';

// handleToolCall for propose_board_action now awaits the readback response's
// own completion before opening confirming, so it never settles on its own —
// tests must flush pending microtasks (the fake fetch's async chain) before
// the router reaches that wait, then fire handleResponseDone() to release it.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeController({ entersConfirming = true } = {}) {
  const sent = [];
  const enterConfirmingCalls = [];
  let pending = null;
  return {
    sent,
    enterConfirmingCalls,
    send(event) { sent.push(event); return true; },
    enterConfirming(opts) {
      enterConfirmingCalls.push(opts);
      if (!entersConfirming) return false;
      pending = opts;
      return true;
    },
    // Mirrors the real controller: resolving/timing out with nothing pending
    // (e.g. before enterConfirming has been called yet) is a silent no-op,
    // never a throw.
    resolve(text) { pending?.onResolve(text); },
    timeout() { pending?.onTimeout('timeout'); },
  };
}

// `plan` is consulted in call order: an array of { status, body }, or a
// function (url, opts) => { status, body } for tests that branch on the
// request. Every call is recorded on `.calls` regardless of which form is used.
function fakeFetch(plan) {
  const calls = [];
  let i = 0;
  const fn = async (url, opts = {}) => {
    const body = opts.body !== undefined ? JSON.parse(opts.body) : undefined;
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body });
    const r = typeof plan === 'function' ? plan(url, opts, body) : plan[Math.min(i, plan.length - 1)];
    i += 1;
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

function functionOutput(sent, callId) {
  const item = sent.find((e) => e.type === 'conversation.item.create' && e.item.call_id === callId);
  return item ? JSON.parse(item.item.output) : undefined;
}

test('read_board_report fetches the summary with the token/project and relays only its text', async () => {
  const controller = fakeController();
  const fetchFn = fakeFetch([{ status: 200, body: { text: '3 cards on the board.', counts: {}, activeRuns: [], needsHuman: [] } }]);
  const router = createCommandRouter({ controller, token: 'tok', project: () => 'demo', fetchFn });

  await router.handleToolCall({ callId: 'c1', name: 'read_board_report', arguments: {} });

  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0].url, '/api/voice/summary?project=demo');
  assert.equal(fetchFn.calls[0].method, 'GET');
  assert.equal(fetchFn.calls[0].headers['x-todomd-token'], 'tok');
  assert.deepEqual(functionOutput(controller.sent, 'c1'), { ok: true, text: '3 cards on the board.' });
  const response = controller.sent.find((e) => e.type === 'response.create');
  assert.equal(response.response.tool_choice, 'none');
});

test('read_board_report failure relays the bounded server error, never a raw exception', async () => {
  const controller = fakeController();
  const fetchFn = fakeFetch([{ status: 503, body: { error: 'board unavailable' } }]);
  const router = createCommandRouter({ controller, token: 't', project: () => 'demo', fetchFn });
  await router.handleToolCall({ callId: 'c1', name: 'read_board_report', arguments: {} });
  assert.deepEqual(functionOutput(controller.sent, 'c1'), { ok: false, error: 'board unavailable' });
});

test('read_card requires a cardId and never calls fetch without one', async () => {
  const controller = fakeController();
  const fetchFn = fakeFetch([]);
  const router = createCommandRouter({ controller, token: 't', project: () => 'demo', fetchFn });
  await router.handleToolCall({ callId: 'c1', name: 'read_card', arguments: {} });
  assert.equal(fetchFn.calls.length, 0);
  assert.deepEqual(functionOutput(controller.sent, 'c1'), { ok: false, error: 'cardId is required' });
});

test('read_card fetches the one card and relays only its text', async () => {
  const controller = fakeController();
  const fetchFn = fakeFetch([{ status: 200, body: { text: 'task-0020: fix thing — Review', id: 'task-0020', status: 'Review' } }]);
  const router = createCommandRouter({ controller, token: 't', project: () => 'demo', fetchFn });
  await router.handleToolCall({ callId: 'c1', name: 'read_card', arguments: { cardId: 'task-0020' } });
  assert.equal(fetchFn.calls[0].url, '/api/voice/cards/task-0020?project=demo');
  assert.deepEqual(functionOutput(controller.sent, 'c1'), { ok: true, text: 'task-0020: fix thing — Review' });
});

test('read_card not-found relays the error so the model can ask for clarification', async () => {
  const controller = fakeController();
  const fetchFn = fakeFetch([{ status: 404, body: { error: 'card not found: task-9999' } }]);
  const router = createCommandRouter({ controller, token: 't', project: () => 'demo', fetchFn });
  await router.handleToolCall({ callId: 'c1', name: 'read_card', arguments: { cardId: 'task-9999' } });
  assert.deepEqual(functionOutput(controller.sent, 'c1'), { ok: false, error: 'card not found: task-9999' });
});

test('propose_board_action requires cardId and action and never calls fetch without them', async () => {
  const controller = fakeController();
  const fetchFn = fakeFetch([]);
  const router = createCommandRouter({ controller, token: 't', project: () => 'demo', fetchFn });
  await router.handleToolCall({ callId: 'c1', name: 'propose_board_action', arguments: { cardId: 'task-0020' } });
  assert.equal(fetchFn.calls.length, 0);
  assert.deepEqual(functionOutput(controller.sent, 'c1'), { ok: false, error: 'cardId and action are required' });
});

test('an ineligible/failed prepare relays the error and never enters confirming', async () => {
  const controller = fakeController();
  const fetchFn = fakeFetch([{ status: 400, body: { error: 'task-0020 has a live run — cancel it in the app first' } }]);
  const router = createCommandRouter({ controller, token: 't', project: () => 'demo', fetchFn });
  await router.handleToolCall({ callId: 'c1', name: 'propose_board_action', arguments: { cardId: 'task-0020', action: 'retriage' } });
  assert.equal(controller.enterConfirmingCalls.length, 0);
  assert.deepEqual(functionOutput(controller.sent, 'c1'),
    { ok: false, error: 'task-0020 has a live run — cancel it in the app first' });
});

test('a visible-tier proposal (cancel/restart/archive) is reported but never enters voice confirmation, and is rejected immediately', async () => {
  const controller = fakeController();
  const fetchFn = fakeFetch([
    { status: 200, body: { proposalId: 'p1', readback: 'archive task-0020', confirmation: { tier: 'visible', phrase: null, challenge: null, visibleApprovalRequired: true } } },
    { status: 200, body: { ok: true, rejected: true } }, // the router's own cleanup reject()
  ]);
  const router = createCommandRouter({ controller, token: 't', project: () => 'demo', fetchFn });
  await router.handleToolCall({ callId: 'c1', name: 'propose_board_action', arguments: { cardId: 'task-0020', action: 'archive' } });

  assert.equal(controller.enterConfirmingCalls.length, 0, 'visible-tier actions are never voice-confirmable');
  assert.equal(fetchFn.calls[1].url, '/api/voice/actions/p1/reject?project=demo');
  assert.deepEqual(functionOutput(controller.sent, 'c1'), { ok: true, readback: 'archive task-0020', requiresVisibleApproval: true });
});

test('a reversible-tier proposal suppresses auto-response, clears buffered audio, and enters confirming', async () => {
  const controller = fakeController();
  const proposalBody = { proposalId: 'p2', readback: 'move task-0020 back to Review', confirmation: { tier: 'reversible', phrase: 'Yes To-do', challenge: null, visibleApprovalRequired: false } };
  const fetchFn = fakeFetch([{ status: 200, body: proposalBody }]);
  const router = createCommandRouter({ controller, token: 't', project: () => 'demo', fetchFn });
  const pending = router.handleToolCall({ callId: 'c1', name: 'propose_board_action', arguments: { cardId: 'task-0020', action: 'retriage' } });
  await flush();
  router.handleResponseDone();
  await pending;

  const bufferClear = controller.sent.find((e) => e.type === 'input_audio_buffer.clear');
  assert.ok(bufferClear, 'buffered input audio is discarded before opening the confirmation window');
  const suppress = controller.sent.find((e) => e.type === 'session.update');
  assert.equal(suppress.session.audio.input.turn_detection.create_response, false);
  assert.equal(suppress.session.audio.input.turn_detection.interrupt_response, false);
  assert.equal(controller.enterConfirmingCalls.length, 1);
  assert.deepEqual(functionOutput(controller.sent, 'c1'), { ok: true, readback: proposalBody.readback, confirmation: proposalBody.confirmation });
});

test('the confirmation window opens only after the readback response finishes — not when the proposal is merely prepared', async () => {
  const controller = fakeController();
  const proposalBody = { proposalId: 'p2', readback: 'move task-0020 back to Review', confirmation: { tier: 'reversible', phrase: 'Yes To-do', challenge: null } };
  const fetchFn = fakeFetch([{ status: 200, body: proposalBody }]);
  const router = createCommandRouter({ controller, token: 't', project: () => 'demo', fetchFn });
  const pending = router.handleToolCall({ callId: 'c1', name: 'propose_board_action', arguments: { cardId: 'task-0020', action: 'retriage' } });
  await flush();

  // The readback response hasn't finished yet: suppression must already be in
  // effect (so nothing auto-responds over it), but the confirmation window —
  // and its timer — must not be open, buffered audio must not be cleared yet,
  // and an exact phrase arriving now (an echo, a stray finalized fragment)
  // must have no effect at all.
  const suppress = controller.sent.find((e) => e.type === 'session.update');
  assert.equal(suppress?.session.audio.input.turn_detection.create_response, false);
  assert.equal(controller.sent.some((e) => e.type === 'input_audio_buffer.clear'), false,
    'buffered audio must not be cleared before the readback has finished playing');
  assert.equal(controller.enterConfirmingCalls.length, 0, 'the confirmation window must not be open yet');
  controller.resolve('Yes To-do'); // arrives before readback completion — must be a no-op
  await flush();
  assert.equal(fetchFn.calls.some((c) => c.url.includes('/confirm')), false,
    'an exact phrase received before read-back completion cannot confirm');
  assert.equal(fetchFn.calls.some((c) => c.url.includes('/reject')), false);

  // Now the readback finishes: the window opens, buffered audio is cleared,
  // and the SAME exact phrase — heard for real, after the readback — confirms.
  router.handleResponseDone();
  await pending;
  assert.equal(controller.sent.some((e) => e.type === 'input_audio_buffer.clear'), true);
  assert.equal(controller.enterConfirmingCalls.length, 1);
  controller.resolve('Yes To-do');
  await flush();
  assert.equal(fetchFn.calls.some((c) => c.url.includes('/confirm')), true,
    'the same exact phrase confirms once actually heard after the readback finished');
});

test('a matching "Yes To-do" reply confirms exactly once and speaks the completion', async () => {
  const controller = fakeController();
  const proposalBody = { proposalId: 'p2', readback: 'move task-0020 back to Review', confirmation: { tier: 'reversible', phrase: 'Yes To-do', challenge: null } };
  const fetchFn = fakeFetch((url) => (url.includes('/confirm')
    ? { status: 200, body: { ok: true } }
    : { status: 200, body: proposalBody }));
  const router = createCommandRouter({ controller, token: 't', project: () => 'demo', fetchFn });
  const pending = router.handleToolCall({ callId: 'c1', name: 'propose_board_action', arguments: { cardId: 'task-0020', action: 'retriage' } });
  await flush();
  router.handleResponseDone();
  await pending;

  controller.resolve('  yes,  TO-DO!  '); // punctuation/case/whitespace must not defeat the match
  await flush();

  const confirmCall = fetchFn.calls.find((c) => c.url.includes('/confirm'));
  assert.equal(confirmCall.url, '/api/voice/actions/p2/confirm?project=demo');
  assert.deepEqual(confirmCall.body, { confirmation: '  yes,  TO-DO!  ' }, 'the raw reply is sent — the server re-verifies it independently');
  const restore = controller.sent.filter((e) => e.type === 'session.update').at(-1);
  assert.equal(restore.session.audio.input.turn_detection.create_response, true);
  const speak = controller.sent.filter((e) => e.type === 'response.create').at(-1);
  assert.match(speak.response.instructions, /^Done — move task-0020 back to Review\.$/);
});

test('an unrelated or wrong reply rejects the proposal instead of confirming it', async () => {
  const controller = fakeController();
  const proposalBody = { proposalId: 'p2', readback: 'move task-0020 back to Review', confirmation: { tier: 'reversible', phrase: 'Yes To-do', challenge: null } };
  const fetchFn = fakeFetch((url) => (url.includes('/reject')
    ? { status: 200, body: { ok: true, rejected: true } }
    : { status: 200, body: proposalBody }));
  const router = createCommandRouter({ controller, token: 't', project: () => 'demo', fetchFn });
  const pending = router.handleToolCall({ callId: 'c1', name: 'propose_board_action', arguments: { cardId: 'task-0020', action: 'retriage' } });
  await flush();
  router.handleResponseDone();
  await pending;

  controller.resolve('what is the weather today');
  await flush();

  const rejectCall = fetchFn.calls.find((c) => c.url.includes('/reject'));
  assert.equal(rejectCall.url, '/api/voice/actions/p2/reject?project=demo');
  assert.equal(fetchFn.calls.some((c) => c.url.includes('/confirm')), false, 'a non-matching reply must never confirm');
  const speak = controller.sent.filter((e) => e.type === 'response.create').at(-1);
  assert.match(speak.response.instructions, /Cancelled/);
});

test('a bare "yes" does not confirm an agent-tier action — only its exact challenge phrase does', async () => {
  const controller = fakeController();
  const proposalBody = {
    proposalId: 'p3', readback: 'approve task-0020 and start the build',
    confirmation: { tier: 'agent', phrase: null, challenge: 'Confirm approve task-0020 amber7' },
  };
  const fetchFn = fakeFetch((url) => (url.includes('/reject')
    ? { status: 200, body: { ok: true, rejected: true } }
    : url.includes('/confirm') ? { status: 200, body: { ok: true } } : { status: 200, body: proposalBody }));
  const router = createCommandRouter({ controller, token: 't', project: () => 'demo', fetchFn });
  const pending = router.handleToolCall({ callId: 'c1', name: 'propose_board_action', arguments: { cardId: 'task-0020', action: 'approve' } });
  await flush();
  router.handleResponseDone();
  await pending;

  controller.resolve('yes');
  await flush();
  assert.equal(fetchFn.calls.some((c) => c.url.includes('/confirm')), false, '"yes" alone can never confirm an agent-starting action');
  assert.equal(fetchFn.calls.some((c) => c.url.includes('/reject')), true);
});

test('the exact challenge phrase confirms an agent-tier action', async () => {
  const controller = fakeController();
  const proposalBody = {
    proposalId: 'p3', readback: 'approve task-0020 and start the build',
    confirmation: { tier: 'agent', phrase: null, challenge: 'Confirm approve task-0020 amber7' },
  };
  const fetchFn = fakeFetch((url) => (url.includes('/confirm')
    ? { status: 200, body: { ok: true } }
    : { status: 200, body: proposalBody }));
  const router = createCommandRouter({ controller, token: 't', project: () => 'demo', fetchFn });
  const pending = router.handleToolCall({ callId: 'c1', name: 'propose_board_action', arguments: { cardId: 'task-0020', action: 'approve' } });
  await flush();
  router.handleResponseDone();
  await pending;

  controller.resolve('confirm APPROVE task-0020 amber7');
  await flush();
  assert.equal(fetchFn.calls.some((c) => c.url.includes('/confirm')), true);
});

test('a confirmation timeout releases the proposal and restores auto-response', async () => {
  const controller = fakeController();
  const proposalBody = { proposalId: 'p2', readback: 'move task-0020 back to Review', confirmation: { tier: 'reversible', phrase: 'Yes To-do', challenge: null } };
  const fetchFn = fakeFetch((url) => (url.includes('/reject')
    ? { status: 200, body: { ok: true, rejected: true } }
    : { status: 200, body: proposalBody }));
  const router = createCommandRouter({ controller, token: 't', project: () => 'demo', fetchFn });
  const pending = router.handleToolCall({ callId: 'c1', name: 'propose_board_action', arguments: { cardId: 'task-0020', action: 'retriage' } });
  await flush();
  router.handleResponseDone();
  await pending;

  controller.timeout();
  await flush();
  assert.equal(fetchFn.calls.some((c) => c.url === '/api/voice/actions/p2/reject?project=demo'), true);
  const restore = controller.sent.filter((e) => e.type === 'session.update').at(-1);
  assert.equal(restore.session.audio.input.turn_detection.create_response, true);
});

test('sign-off/offline landing while the readback was playing releases the proposal instead of leaving it dangling', async () => {
  const controller = fakeController({ entersConfirming: false }); // simulates the session having ended by the time readback finishes
  const proposalBody = { proposalId: 'p2', readback: 'move task-0020 back to Review', confirmation: { tier: 'reversible', phrase: 'Yes To-do', challenge: null } };
  const fetchFn = fakeFetch((url) => (url.includes('/reject')
    ? { status: 200, body: { ok: true, rejected: true } }
    : { status: 200, body: proposalBody }));
  const router = createCommandRouter({ controller, token: 't', project: () => 'demo', fetchFn });
  const pending = router.handleToolCall({ callId: 'c1', name: 'propose_board_action', arguments: { cardId: 'task-0020', action: 'retriage' } });
  await flush();
  router.handleResponseDone();
  await pending;

  // The tool call already got its (successful) result before the race was
  // even possible to detect — there is no second function_call_output for
  // the same call once a live session is gone to speak it into.
  assert.deepEqual(functionOutput(controller.sent, 'c1'), { ok: true, readback: proposalBody.readback, confirmation: proposalBody.confirmation });
  assert.equal(fetchFn.calls.some((c) => c.url === '/api/voice/actions/p2/reject?project=demo'), true);
  const restore = controller.sent.filter((e) => e.type === 'session.update').at(-1);
  assert.equal(restore.session.audio.input.turn_detection.create_response, true, 'suppression is restored even when nothing was ever confirmed');
});

test('an unknown tool name and malformed arguments both produce a bounded error, never a throw', async () => {
  const controller = fakeController();
  const fetchFn = fakeFetch([]);
  const router = createCommandRouter({ controller, token: 't', project: () => 'demo', fetchFn });
  await router.handleToolCall({ callId: 'c1', name: 'delete_everything', arguments: {} });
  assert.deepEqual(functionOutput(controller.sent, 'c1'), { ok: false, error: 'unknown tool: delete_everything' });

  await router.handleToolCall({ callId: 'c2', name: 'read_card', arguments: null });
  assert.deepEqual(functionOutput(controller.sent, 'c2'), { ok: false, error: 'malformed tool arguments' });
  assert.equal(fetchFn.calls.length, 0);
});

test('a network failure never throws out of the router — it surfaces as a bounded tool error', async () => {
  const controller = fakeController();
  const fetchFn = async () => { throw new Error('fetch failed'); };
  const router = createCommandRouter({ controller, token: 't', project: () => 'demo', fetchFn });
  await router.handleToolCall({ callId: 'c1', name: 'read_board_report', arguments: {} });
  assert.deepEqual(functionOutput(controller.sent, 'c1'), { ok: false, error: 'network error' });
});
