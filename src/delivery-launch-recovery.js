import fs from 'node:fs';
import path from 'node:path';
import { deliveryStoreDirectory } from './delivery-paths.js';
import { recoverAdmission } from './delivery-admission.js';
import { registeredAuthority } from './delivery-authority-state.js';
import { createDeliveryStore } from './delivery-store.js';
import { createLocalDeliveryBackend } from './delivery-local-backend.js';
import { executionRef, sameExecution } from './delivery-execution-state.js';

// Local OS administrative capability, used by delivery-admission --recover.
// No request-supplied observation, backend path, PID or command is accepted.
// Closing the launch gate does NOT release the task lease or update its journal.
export function recoverProjectAdmission(repoPath, command) {
  const repo = fs.realpathSync(repoPath), directory = deliveryStoreDirectory(repo);
  const store = createDeliveryStore(directory);
  return recoverAdmission(path.join(directory, 'admission'), command, { reconcileLaunch: async owner => {
    const ref = owner.execution;
    const verify = () => {
      if (!registeredAuthority(directory, ref.backend, repo)) throw new Error('Unregistered local execution.');
      const record = store.read(ref.task_id);
      if (!record?.lease || !record.execution || !sameExecution(ref, executionRef(record)) || record.execution.phase !== 'dispatching') throw new Error('The launch journal no longer matches.');
    };
    verify();
    const backend = createLocalDeliveryBackend(path.join(directory, 'local-executions', ref.backend), { enabled: true, name: ref.backend });
    await backend.close(ref);
    const observation = await backend.inspect(ref);
    verify();
    return observation;
  } });
}
