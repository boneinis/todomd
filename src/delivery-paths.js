import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export function deliveryStoreDirectory(repoPath) {
  const key = createHash('sha256').update(fs.realpathSync(repoPath)).digest('hex');
  return path.join(process.env.TODOMD_HOME || os.homedir(), '.todomd', 'delivery', key);
}
export const projectAdmissionDirectory = repoPath => path.join(deliveryStoreDirectory(repoPath), 'admission');
