import fs from 'node:fs';
import path from 'node:path';
import { refKey, writeOnce, privateDirectory } from './delivery-local-state.js';

const expected = (backend, repo, profile) => ({ format: 1, backend, repository: refKey(repo), profile, kind: 'local_process_group' });
const fileFor = (directory, backend) => path.join(directory, 'job-authorities', `${backend}.json`);
export function registeredAuthority(directory, backend, repo, profile = null) {
  if (!/^local-job-[a-f0-9]{64}$/.test(backend)) return false;
  if (!privateDirectory(path.join(directory, 'job-authorities'))) return false;
  let fd, record;
  try {
    fd = fs.openSync(fileFor(directory, backend), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384) throw new Error('Invalid job authority registration.');
    record = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  if (typeof record?.profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(record.profile) ||
    profile !== null && profile !== record.profile) throw new Error('Invalid job authority profile.');
  const wanted = expected(backend, repo, record.profile);
  if (JSON.stringify(record) !== JSON.stringify({ ...wanted, checksum: refKey(wanted) })) throw new Error('Invalid job authority registration.');
  return true;
}
export function registerAuthority(directory, backend, repo, profile) {
  if (registeredAuthority(directory, backend, repo, profile)) return;
  const record = expected(backend, repo, profile);
  privateDirectory(path.join(directory, 'job-authorities'), true);
  writeOnce(fileFor(directory, backend), { ...record, checksum: refKey(record) });
  if (!registeredAuthority(directory, backend, repo, profile)) throw new Error('Job authority registration is unavailable.');
}
