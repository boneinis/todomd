import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isEpicCard,
  resolveEpicBuildMode,
  resolveCardModes,
  epicActiveChildren,
  epicMaterializedChildren,
  cardInconsistency,
} from '../src/build-mode.js';

test('isEpicCard recognizes various epic markers and rejects ordinary cards', () => {
  assert.equal(isEpicCard({ data: { epic: true } }), true);
  assert.equal(isEpicCard({ epic: true }), true);
  assert.equal(isEpicCard({ data: { type: 'epic' } }), true);
  assert.equal(isEpicCard({ type: 'epic' }), true);
  assert.equal(isEpicCard({ data: { epic: false, type: 'epic' } }), true);
  assert.equal(isEpicCard({ data: { title: 'Ordinary card' } }), false);
  assert.equal(isEpicCard({ title: 'Ordinary card' }), false);
  assert.equal(isEpicCard(null), false);
  assert.equal(isEpicCard(undefined), false);
});

test('resolveEpicBuildMode enforces explicit mode precedence over legacy flags', () => {
  // Explicit chunks overrides workflow: teamwork and teamwork: true
  assert.equal(resolveEpicBuildMode({ data: { epic: true, epic_build_mode: 'chunks', workflow: 'teamwork' } }), 'chunks');
  assert.equal(resolveEpicBuildMode({ data: { epic: true, epic_build_mode: 'chunks', teamwork: true } }), 'chunks');

  // Explicit teamwork overrides legacy epic_split: true
  assert.equal(resolveEpicBuildMode({ data: { epic: true, epic_build_mode: 'teamwork', epic_split: true } }), 'teamwork');

  // Legacy epic_split: true -> chunks
  assert.equal(resolveEpicBuildMode({ data: { epic: true, epic_split: true } }), 'chunks');
  // Legacy epic_split: false -> teamwork
  assert.equal(resolveEpicBuildMode({ data: { epic: true, epic_split: false } }), 'teamwork');

  // Legacy workflow: teamwork -> teamwork
  assert.equal(resolveEpicBuildMode({ data: { epic: true, workflow: 'teamwork' } }), 'teamwork');
  assert.equal(resolveEpicBuildMode({ data: { epic: true, teamwork: true } }), 'teamwork');

  // Stage default fallback
  assert.equal(resolveEpicBuildMode({ data: { epic: true } }, { workflow: 'teamwork' }), 'teamwork');
  assert.equal(resolveEpicBuildMode({ data: { epic: true } }, { teamwork: true }), 'teamwork');

  // Default fallback -> chunks
  assert.equal(resolveEpicBuildMode({ data: { epic: true } }), 'chunks');
});

test('resolveCardModes isolates ordinary cards from hidden epic drawer state', () => {
  // Ordinary non-epic card with hidden epic_build_mode: chunks must NOT be treated as epic tracker
  const ordinaryWithChunks = resolveCardModes({ data: { title: 'Regular card', epic_build_mode: 'chunks', workflow: 'teamwork' } });
  assert.equal(ordinaryWithChunks.isEpic, false);
  assert.equal(ordinaryWithChunks.epicBuildMode, null);
  assert.equal(ordinaryWithChunks.buildsDirectly, true);
  assert.equal(ordinaryWithChunks.teamworkExecution, true);

  // Epic with chunks mode is an epic tracker and does NOT build directly
  const epicChunks = resolveCardModes({ data: { epic: true, epic_build_mode: 'chunks', workflow: 'teamwork' } });
  assert.equal(epicChunks.isEpic, true);
  assert.equal(epicChunks.epicBuildMode, 'chunks');
  assert.equal(epicChunks.buildsDirectly, false);
  assert.equal(epicChunks.teamworkExecution, true);

  // Epic with teamwork mode builds directly
  const epicTeamwork = resolveCardModes({ data: { epic: true, epic_build_mode: 'teamwork' } });
  assert.equal(epicTeamwork.isEpic, true);
  assert.equal(epicTeamwork.epicBuildMode, 'teamwork');
  assert.equal(epicTeamwork.buildsDirectly, true);
  assert.equal(epicTeamwork.teamworkExecution, true);
});

test('epicActiveChildren and epicMaterializedChildren filter children accurately', () => {
  const cards = [
    { id: 'child-1', parent: 'epic-1', status: 'Build', archived: false },
    { id: 'child-2', parent: 'epic-1', status: 'Done', archived: false },
    { id: 'child-3', parent: 'epic-1', status: 'Queue', archived: '2026-09-12' },
    { id: 'child-4', parent: 'epic-2', status: 'Build', archived: false },
  ];

  const active = epicActiveChildren('epic-1', cards);
  assert.deepEqual(active.map(c => c.id), ['child-1']);

  const materialized = epicMaterializedChildren('epic-1', cards);
  assert.deepEqual(materialized.map(c => c.id), ['child-1', 'child-2']);
});

test('cardInconsistency identifies ordinary cards with epic_build_mode', () => {
  assert.equal(cardInconsistency({ data: { title: 'Normal card' } }), null);
  assert.equal(cardInconsistency({ data: { epic: true, epic_build_mode: 'chunks' } }), null);

  const inconsistency = cardInconsistency({ data: { title: 'Normal card', epic_build_mode: 'chunks' } });
  assert.ok(inconsistency);
  assert.equal(inconsistency.code, 'non_epic_has_build_mode');
  assert.equal(inconsistency.value, 'chunks');
});
