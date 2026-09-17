// Shared mode resolver for To-do MD tasks and epics.
// Unifies decomposition mode (one epic vs child cards) and provider
// delegation settings (teamwork execution), ensuring explicit epic_build_mode
// is authoritative and ordinary cards are not affected by hidden drawer state.

export function isEpicCard(card) {
  return Boolean(
    card?.data?.epic ||
    card?.epic ||
    (card?.data?.type === 'epic' || card?.type === 'epic')
  );
}

// Decomposition mode for an epic: 'teamwork' | 'chunks'.
// Precedence:
// 1. Explicit canonical `epic_build_mode` ('teamwork' | 'chunks')
// 2. Legacy `epic_split` (true -> 'chunks', false -> 'teamwork')
// 3. Legacy `workflow: teamwork` or `teamwork: true`
// 4. Stage/config default `workflow: teamwork` or `teamwork: true`
// 5. Fallback: 'chunks'
export function resolveEpicBuildMode(card, stageConfig = {}) {
  const raw = card?.data?.epic_build_mode ?? card?.epic_build_mode;
  const explicit = typeof raw === 'string' ? raw.trim() : '';
  if (explicit === 'teamwork' || explicit === 'chunks') {
    return explicit;
  }
  const split = card?.data?.epic_split ?? card?.epic_split;
  if (split === true) return 'chunks';
  if (split === false) return 'teamwork';

  const workflow = card?.data?.workflow ?? card?.workflow;
  const teamwork = card?.data?.teamwork ?? card?.teamwork;
  if (workflow === 'teamwork' || teamwork === true) return 'teamwork';

  if (stageConfig?.workflow === 'teamwork' || stageConfig?.teamwork === true) {
    return 'teamwork';
  }

  return 'chunks';
}

export function resolveCardModes(card, stageConfig = {}) {
  const isEpic = isEpicCard(card);
  const epicBuildMode = isEpic ? resolveEpicBuildMode(card, stageConfig) : null;
  const buildsDirectly = !isEpic || epicBuildMode === 'teamwork';

  const teamworkExecution = Boolean(
    (isEpic && epicBuildMode === 'teamwork') ||
    card?.data?.teamwork ||
    card?.teamwork ||
    (card?.data?.workflow === 'teamwork') ||
    (card?.workflow === 'teamwork') ||
    stageConfig?.teamwork ||
    stageConfig?.workflow === 'teamwork'
  );

  return {
    isEpic,
    epicBuildMode,
    buildsDirectly,
    teamworkExecution,
  };
}

export function epicActiveChildren(epicId, cards = []) {
  if (!epicId || !Array.isArray(cards)) return [];
  return cards.filter((c) => {
    const parentId = c?.parent ?? c?.data?.parent;
    if (parentId !== epicId) return false;
    const isArchived = Boolean(c?.archived ?? c?.data?.archived);
    if (isArchived) return false;
    const status = c?.status ?? c?.data?.status;
    return status !== 'Done';
  });
}

export function epicMaterializedChildren(epicId, cards = []) {
  if (!epicId || !Array.isArray(cards)) return [];
  return cards.filter((c) => {
    const parentId = c?.parent ?? c?.data?.parent;
    if (parentId !== epicId) return false;
    const isArchived = Boolean(c?.archived ?? c?.data?.archived);
    return !isArchived;
  });
}

export function cardInconsistency(card) {
  if (!card) return null;
  const isEpic = isEpicCard(card);
  const rawEpicMode = card?.data?.epic_build_mode ?? card?.epic_build_mode;
  if (!isEpic && rawEpicMode) {
    return {
      code: 'non_epic_has_build_mode',
      field: 'epic_build_mode',
      value: rawEpicMode,
      message: 'Ordinary non-epic card has epic_build_mode stored; ignored for execution.',
      repair: 'Clear epic_build_mode or mark card as epic.',
    };
  }
  return null;
}
