import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import { previewDeliveryMigration } from './delivery-preview.js';
import { deliveryWriterPreflight } from './delivery-writer-preflight.js';
import { deliveryStoreDirectory } from './delivery-paths.js';
import { withAdmissionSync } from './delivery-admission.js';
import { validateDeliveryTask } from './delivery.js';
import { createDeliveryStore } from './delivery-store.js';

const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const digest = value => createHash('sha256').update(value).digest('hex');

const DEFAULT_OWNERS = Object.freeze({
  delivery_lead: 'human:project-owner',
  implementation: 'agent-role:todomd-maintainer',
  reviewer: 'agent-role:todomd-reviewer',
  release: 'human:project-owner',
});

export function migrateDeliveryBoard(repoPath, options = {}) {
  const repo = fs.realpathSync(repoPath);
  const directory = deliveryStoreDirectory(repo);
  const gate = path.join(directory, 'admission');

  // Step 1: Check writer preflight
  const preflight = deliveryWriterPreflight(repo);
  if (preflight.blocked && !options.confirmExternalQuiescence) {
    return {
      ok: false,
      code: 'writers_active',
      message: 'Active legacy writers or unquiesced sessions detected. Quiesce the board before migrating.',
      preflight,
    };
  }

  // Step 2: Under project admission, inspect and migrate
  const admission = withAdmissionSync(gate, 'metadata', null, () => {
    const preview = previewDeliveryMigration(repo);
    const dryRun = options.dryRun === true;
    const defaultLead = options.defaultLead || DEFAULT_OWNERS.delivery_lead;
    const defaultImplementation = options.defaultImplementation || DEFAULT_OWNERS.implementation;
    const defaultReviewer = options.defaultReviewer || DEFAULT_OWNERS.reviewer;
    const defaultRelease = options.defaultRelease || DEFAULT_OWNERS.release;
    const targetEnv = options.target_environment || 'production';

    const results = [];
    const tasksDir = path.join(repo, '.todomd', 'tasks');
    fs.mkdirSync(directory, { recursive: true });
    const store = createDeliveryStore(directory, { enabled: true });

    const rows = preview.cards || preview.tasks || [];
    for (const row of rows) {
      const filePath = path.join(tasksDir, row.file);
      const raw = fs.readFileSync(filePath, 'utf8');
      const match = raw.match(/^\uFEFF?---(?:yaml)?\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
      if (!match) continue;

      let frontmatter;
      try { frontmatter = yaml.load(match[1]); } catch { continue; }
      const body = match[2];
      const taskId = frontmatter.id;
      if (!taskId) continue;

      let deliveryState = 'backlog';
      let policy = 'released';
      let blocker = null;

      if (frontmatter.schema_version === 2 && frontmatter.delivery) {
        // Already v2
        results.push({ id: taskId, file: row.file, action: 'already_v2', state: frontmatter.delivery.state });
        continue;
      }

      // Legacy state mapping
      if (frontmatter.status === 'Done') {
        // Historical Done cards are completed under historical contract; NEVER bulk-labeled Released without deployment evidence
        deliveryState = 'completed';
        policy = 'completed';
      } else if (['Review', 'Plan', 'Triage'].includes(frontmatter.status)) {
        deliveryState = 'backlog';
        policy = 'released';
      } else if (['Planned', 'Queue'].includes(frontmatter.status)) {
        deliveryState = 'ready';
        policy = 'released';
      } else if (frontmatter.status === 'Build') {
        deliveryState = 'in_progress';
        policy = 'released';
      } else if (['CI', 'Verify'].includes(frontmatter.status)) {
        deliveryState = 'in_review';
        policy = 'released';
      } else if (frontmatter.status === 'Needs Human') {
        deliveryState = 'in_review';
        policy = 'released';
        blocker = {
          category: 'product_decision',
          owner: defaultLead,
          since: new Date().toISOString(),
          evidence: frontmatter.needs_human_reason || 'Migrated from legacy Needs Human hold',
          next_action: 'Review and resolve human hold',
        };
      }

      const delivery = {
        state: deliveryState,
        completion_policy: policy,
        ...(policy === 'released' && targetEnv ? { target_environment: targetEnv } : {}),
      };

      const ownership = {
        delivery_lead: defaultLead,
        implementation: defaultImplementation,
        reviewer: defaultReviewer,
        ...(policy === 'released' ? { release: defaultRelease } : {}),
      };

      const updatedFrontmatter = {
        ...frontmatter,
        schema_version: 2,
        delivery,
        ownership,
        ...(blocker ? { blocker } : {}),
      };

      const validation = validateDeliveryTask(updatedFrontmatter);
      if (!validation.ok) {
        results.push({ id: taskId, file: row.file, action: 'validation_failed', issues: validation.issues });
        continue;
      }

      if (dryRun) {
        results.push({ id: taskId, file: row.file, action: 'plan_migrate', to_state: deliveryState, policy });
        continue;
      }

      // Write updated card
      const yamlStr = yaml.dump(updatedFrontmatter, { lineWidth: -1 });
      const newContent = `---\n${yamlStr}---\n${body}`;
      const tmpFile = `${filePath}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmpFile, newContent, 'utf8');
      fs.renameSync(tmpFile, filePath);

      // Re-read for exact digest
      const freshRaw = fs.readFileSync(filePath);
      const source_revision = digest(freshRaw);

      // Initialize private delivery store record
      const recordFile = path.join(directory, `${taskId}.json`);
      const recordTask = {
        id: taskId,
        schema_version: 2,
        delivery: JSON.parse(JSON.stringify(delivery)),
        ownership: JSON.parse(JSON.stringify(ownership)),
        ...(blocker ? { blocker: JSON.parse(JSON.stringify(blocker)) } : {}),
      };

      const record = {
        format: 1,
        revision: 1,
        source_revision,
        task: recordTask,
        lease: null,
        next_fence: 1,
        last_handoff: { evidence: 'Initial board delivery migration', next_action: 'Proceed with delivery workflow', from: null, to: defaultLead, at: Date.now() },
        events: [{
          revision: 1,
          at: Date.now(),
          actor: defaultLead,
          grant: 'delivery:initialize',
          action: 'initialize',
          command: { action: 'initialize', task: recordTask, source_revision, expected_revision: 0, idempotency_key: `migrate-${taskId}` },
          evidence: { migration: true },
        }],
        receipts: {},
      };

      const canonical = v => JSON.stringify(v, (k, val) => (val !== null && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.keys(val).sort().map(x => [x, val[x]])) : val));
      const fingerprint = v => createHash('sha256').update(canonical(v)).digest('hex');
      record.checksum = fingerprint(record);

      const recordTmp = `${recordFile}.${randomUUID()}.tmp`;
      fs.writeFileSync(recordTmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(recordTmp, recordFile);

      results.push({ id: taskId, file: row.file, action: 'migrated', state: deliveryState });
    }

    if (!dryRun) {
      // Update config mode to delivery
      const configPath = path.join(repo, '.todomd', 'config.yml');
      if (fs.existsSync(configPath)) {
        let rawCfg = fs.readFileSync(configPath, 'utf8');
        if (/^mode:\s*.*$/m.test(rawCfg)) {
          rawCfg = rawCfg.replace(/^mode:\s*.*$/m, 'mode: delivery');
        } else {
          rawCfg = `mode: delivery\n` + rawCfg;
        }
        fs.writeFileSync(configPath, rawCfg, 'utf8');
      }
    }

    return {
      ok: true,
      dryRun,
      dry_run: dryRun,
      plan: results,
      count: results.filter(r => ['migrated', 'plan_migrate'].includes(r.action)).length,
      migrated_count: results.filter(r => ['migrated', 'plan_migrate'].includes(r.action)).length,
      tasks: results,
    };
  });
  if (!admission.ok) return admission;
  return admission.value;
}

export function rollbackDeliveryBoard(repoPath, options = {}) {
  const repo = fs.realpathSync(repoPath);
  const directory = deliveryStoreDirectory(repo);
  const gate = path.join(directory, 'admission');

  const admission = withAdmissionSync(gate, 'metadata', null, () => {
    const tasksDir = path.join(repo, '.todomd', 'tasks');
    let rolledCount = 0;
    if (fs.existsSync(tasksDir)) {
      const files = fs.readdirSync(tasksDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const filePath = path.join(tasksDir, file);
        const raw = fs.readFileSync(filePath, 'utf8');
        const match = raw.match(/^\uFEFF?---(?:yaml)?\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
        if (!match) continue;
        let frontmatter;
        try { frontmatter = yaml.load(match[1]); } catch { continue; }
        const body = match[2];
        if (frontmatter.schema_version === 2 || frontmatter.delivery) {
          delete frontmatter.schema_version;
          delete frontmatter.delivery;
          delete frontmatter.ownership;
          delete frontmatter.blocker;
          const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 });
          const newContent = `---\n${yamlStr}---\n${body}`;
          const tmp = `${filePath}.${randomUUID()}.tmp`;
          fs.writeFileSync(tmp, newContent, 'utf8');
          fs.renameSync(tmp, filePath);
          rolledCount++;
        }
      }
    }

    // Restore config mode to launcher
    const configPath = path.join(repo, '.todomd', 'config.yml');
    if (fs.existsSync(configPath)) {
      let rawCfg = fs.readFileSync(configPath, 'utf8');
      if (/^mode:\s*.*$/m.test(rawCfg)) {
        rawCfg = rawCfg.replace(/^mode:\s*.*$/m, 'mode: launcher');
      } else {
        rawCfg = `mode: launcher\n` + rawCfg;
      }
      fs.writeFileSync(configPath, rawCfg, 'utf8');
    }

    return {
      ok: true,
      mode: 'launcher',
      rolled_back: rolledCount,
      message: 'Delivery workflow deactivated; legacy runtime restored with all private records and history preserved.',
    };
  });
  if (!admission.ok) return admission;
  return admission.value;
}
