import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { validateDeliveryTask } from './delivery.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const finding = (code, message) => ({ code, message });
const LEGACY_STATE = { Review: 'backlog', Plan: 'backlog', Planned: 'ready', Queue: 'ready', Build: 'in_progress', CI: 'in_review', Verify: 'in_review' };
const REVIEW_HOLDS = new Set(['publication_review_required', 'merge_conflict', 'merge_noop', 'base_branch_moved', 'base_branch_unknown']);

function suggest(task, issues) {
  if (task.status === 'Done') {
    issues.push(finding('historical_completion', 'Legacy Done retains its historical meaning; integration and deployment require evidence before migration.'));
    return null;
  }
  if (task.status === 'Needs Human') {
    issues.push(finding('blocker_owner_required', 'Assign a responsible owner and supported next action for this hold.'));
    if (REVIEW_HOLDS.has(task.needs_human_reason)) return 'in_review';
    const stage = task.recovery_stage;
    if (stage === 'Build') return 'in_progress';
    if (['CI', 'Verify'].includes(stage)) return 'in_review';
    if (['Plan', 'Review', 'Triage'].includes(stage)) return 'backlog';
    issues.push(finding('ambiguous_hold', 'No trustworthy prior delivery stage can be inferred from this hold.'));
    return null;
  }
  if (!Object.hasOwn(LEGACY_STATE, task.status)) {
    issues.push(finding('unknown_legacy_status', 'Custom or missing runtime status requires an explicit mapping.'));
    return null;
  }
  if (['Planned', 'Queue'].includes(task.status)) issues.push(finding('readiness_unconfirmed', 'Legacy status is a mapping hint; Ready requirements and planning approval still need validation.'));
  return LEGACY_STATE[task.status];
}

// A filesystem-only snapshot: no pipeline/server imports, locks, writes, Git
// commands, registry changes, summaries, network requests or agent dispatch.
export function previewDeliveryMigration(repoPath) {
  const dir = path.join(repoPath, '.todomd', 'tasks');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    const error = new Error('No .todomd/tasks directory; initialize a board separately before previewing it.');
    error.code = 'board_not_found';
    throw error;
  }
  const entries = fs.readdirSync(dir).filter(file => file.endsWith('.md')).sort();
  const rows = [], sources = [], parsedTasks = new Map();
  for (const file of entries) {
    const full = path.join(dir, file);
    const row = { file, id: null, legacy_status: null, archived: false, source_revision: null,
      schema_version: null, schema_valid: false, proposed_state: null, declared_state: null,
      deployment: 'unknown', evidence_verified: false, requires_review: true, findings: [] };
    rows.push(row);
    let raw, descriptor;
    try {
      if (!fs.lstatSync(full).isFile()) {
        sources.push([file, 'not_regular']);
        row.findings.push(finding('not_regular_file', 'Only regular task files can be previewed; symbolic links are not followed.'));
        continue;
      }
      descriptor = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      if (!fs.fstatSync(descriptor).isFile()) throw new Error('task is no longer a regular file');
      raw = fs.readFileSync(descriptor);
    }
    catch {
      sources.push([file, 'unreadable']);
      row.findings.push(finding('unreadable_file', 'Task could not be read.'));
      continue;
    }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    row.source_revision = digest(raw);
    sources.push([file, row.source_revision]);
    let task;
    try {
      // Preview is data-only. Never select an executable frontmatter engine
      // from an authored language tag (for example gray-matter's JS engine).
      const frontmatter = raw.toString('utf8').match(/^\uFEFF?---(?:yaml)?\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!frontmatter) throw new Error('missing YAML frontmatter');
      task = yaml.load(frontmatter[1]);
      if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('frontmatter must be an object');
    }
    catch {
      row.findings.push(finding('frontmatter_parse_error', 'Repair invalid frontmatter before migration.'));
      continue;
    }
    row.id = typeof task.id === 'string' ? task.id : null;
    row.legacy_status = typeof task.status === 'string' ? task.status : null;
    row.archived = !!task.archived;
    parsedTasks.set(row, task);
    if (!row.id || !/^[\w.-]+$/.test(row.id) || ['.', '..'].includes(row.id)) row.findings.push(finding('invalid_id', 'A valid task identity is required.'));
    const validation = validateDeliveryTask(task);
    row.schema_version = validation.version;
    row.schema_valid = validation.ok;
    row.findings.push(...validation.issues);
    if (validation.version === 2) {
      row.declared_state = validation.ok ? task.delivery.state : null;
      row.findings.push(finding('evidence_not_reconciled', 'Declared delivery metadata is intent; this preview does not verify approvals, integration, or deployment.'));
    } else if (validation.version === 1) {
      row.proposed_state = suggest(task, row.findings);
      row.findings.push(finding('completion_policy_required', 'Choose a completion policy; task type alone does not establish whether deployment is required.'));
      row.findings.push(finding('ownership_mapping_required', task.assignee
        ? 'Map the existing assignee to an explicit stable identity; provider and worker names are not owners.'
        : 'Assign stable accountable owners before enabling delivery transitions.'));
    }
  }

  const byId = new Map();
  for (const row of rows) if (row.id) byId.set(row.id, [...(byId.get(row.id) || []), row]);
  for (const group of byId.values()) if (group.length > 1) for (const row of group) row.findings.push(finding('duplicate_id', 'Multiple task files claim this identity; resolve them before migration.'));
  const graph = new Map();
  for (const [row, task] of parsedTasks) {
    const deps = task.dependencies === undefined || task.dependencies === null || task.dependencies === '' ? [] : task.dependencies;
    if (!Array.isArray(deps) || deps.some(dep => typeof dep !== 'string' || !dep.trim())) {
      row.findings.push(finding('invalid_dependencies', 'Delivery migration requires an array of task IDs; legacy dependency handling remains unchanged.'));
      continue;
    }
    if (byId.get(row.id)?.length === 1) graph.set(row.id, deps);
    for (const dep of deps) {
      const matches = byId.get(dep) || [];
      if (matches.length !== 1) row.findings.push(finding(matches.length ? 'ambiguous_dependency' : 'missing_dependency', `Dependency ${dep} does not resolve to one task.`));
      else if (!matches[0].schema_valid) row.findings.push(finding('invalid_dependency', `Dependency ${dep} requires schema repair.`));
    }
  }
  // Two iterative graph passes identify strongly connected components, including
  // overlapping cycles, without overflowing on long historical chains.
  const done = new Set(), order = [], reverse = new Map();
  for (const id of graph.keys()) reverse.set(id, []);
  for (const [id, deps] of graph) for (const dep of deps) reverse.get(dep)?.push(id);
  for (const start of graph.keys()) {
    if (done.has(start)) continue;
    const stack = [{ id: start, next: 0 }];
    done.add(start);
    while (stack.length) {
      const frame = stack.at(-1), deps = graph.get(frame.id) || [];
      if (frame.next === deps.length) { order.push(frame.id); stack.pop(); continue; }
      const dep = deps[frame.next++];
      if (!done.has(dep) && graph.has(dep)) { done.add(dep); stack.push({ id: dep, next: 0 }); }
    }
  }
  const assigned = new Set(), cyclic = new Set();
  for (const start of order.reverse()) {
    if (assigned.has(start)) continue;
    const component = [], stack = [start];
    assigned.add(start);
    while (stack.length) {
      const id = stack.pop(); component.push(id);
      for (const dep of reverse.get(id)) if (!assigned.has(dep)) { assigned.add(dep); stack.push(dep); }
    }
    if (component.length > 1 || graph.get(start).includes(start)) for (const id of component) cyclic.add(id);
  }
  for (const id of cyclic) for (const row of byId.get(id) || []) row.findings.push(finding('dependency_cycle', 'This task participates in a dependency cycle.'));
  const fatal = new Set(['invalid_id', 'duplicate_id', 'invalid_dependencies', 'missing_dependency', 'ambiguous_dependency', 'invalid_dependency', 'dependency_cycle']);
  for (const row of rows) if (!row.schema_valid || row.findings.some(issue => fatal.has(issue.code))) row.proposed_state = null;
  return { version: 1, mode: 'preview', read_only: true, execution_enabled: false,
    revision: digest(JSON.stringify(sources)), atomic_snapshot: false,
    note: 'Per-file revisions describe this read-only scan. Revalidate every source before any future migration; files may change during the scan.',
    counts: { total: rows.length, archived: rows.filter(r => r.archived).length,
      invalid_schema: rows.filter(r => !r.schema_valid).length, requires_review: rows.length,
      deployment_unknown: rows.length }, cards: rows };
}

export function formatDeliveryPreview(report) {
  const lines = ['Delivery migration preview — read only', 'Execution: disabled; no cards or runtime state changed.',
    `Tasks: ${report.counts.total}; archived: ${report.counts.archived}; require review: ${report.counts.requires_review}`, ''];
  const printable = text => String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  for (const card of report.cards) {
    lines.push(`${printable(card.id || card.file)}: ${printable(card.legacy_status || 'unknown')} → ${card.proposed_state || 'mapping requires review'}; deployment unknown`);
    if (card.declared_state) lines.push(`  Declared state: ${card.declared_state} (unverified)`);
    for (const issue of card.findings) lines.push(`  ${issue.code}: ${printable(issue.message)}`);
  }
  return lines.join('\n');
}
