import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp, isolateHome, makeRepo, writeCard } from './helpers.js';
import { seedDelivery } from './delivery-fixture.js';
import { admissionStatus, recoverAdmission, withAdmissionSync, withExistingProjectAdmission } from '../src/delivery-admission.js';
import { projectAdmissionDirectory } from '../src/delivery-paths.js';
import { deliveryRuntimeStatus } from '../src/delivery-runtime.js';
import { createDeliveryStore } from '../src/delivery-store.js';
import { refKey } from '../src/delivery-local-state.js';
import { withRepoLock, patchFrontmatter } from '../src/board.js';
import * as scheduler from '../src/scheduler.js';

afterEach(() => scheduler.resetState());
const moduleUrl = new URL('../src/delivery-admission.js', import.meta.url).href;
const cli = fileURLToPath(new URL('../bin/todomd.js', import.meta.url));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function child(script, args = []) {
  const p = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['ignore','pipe','pipe'] });
  return new Promise((resolve,reject) => {
    let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);
    p.on('close',code=>resolve({code,out,err}));
  });
}
async function crash(root, kind = 'metadata') {
  const r = await child(`import {withAdmissionSync} from ${JSON.stringify(moduleUrl)};
    withAdmissionSync(process.argv[1], process.argv[2], 'task-0001', () => process.exit(23));`,[root,kind]);
  assert.equal(r.code,23,r.err); return admissionStatus(root).owner;
}
const request = owner => ({ epoch: owner.epoch, nonce: owner.nonce });
function project() {
  isolateHome(); const repo=makeRepo({automaticMaintenance:false}); writeCard(repo,'task-0001',{status:'Needs Human'});
  return {repo,root:projectAdmissionDirectory(repo)};
}

test('read-only inspection and ordinary repository work do not activate delivery gates', async () => {
  const {repo,root}=project();
  assert.equal(admissionStatus(root).enabled,false);
  await withRepoLock(repo,()=>42);
  assert.equal(fs.existsSync(root),false);
  const result=spawnSync(process.execPath,[cli,'delivery-admission',repo,'--json'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).read_only,true);
  assert.equal(fs.existsSync(root),false);
});

test('a live metadata owner cannot be recovered by age or a mismatched nonce', () => {
  const root=path.join(tmp('gate'),'admission');
  const result=withAdmissionSync(root,'metadata','task-0001',()=>{
    const owner=admissionStatus(root).owner;
    const file=path.join(root,`${owner.epoch}.owner.json`), old=new Date(0);fs.utimesSync(file,old,old);
    assert.equal(recoverAdmission(root,{...request(owner),nonce:'wrong'}).code,'stale_admission');
    assert.equal(recoverAdmission(root,request(owner)).code,'owner_alive');
    // A different synchronous stack cannot borrow the current metadata owner.
    assert.equal(withAdmissionSync(root,'metadata','task-0002',()=>99,{borrow:false}).code,'write_busy');
    return 42;
  });
  assert.equal(result.value,42); assert.equal(admissionStatus(root).owner,null);
});

test('dead transaction recovery is idempotent and cannot retire a replacement epoch', async () => {
  const root=path.join(tmp('gate-recovery'),'admission'), old=await crash(root);
  assert.equal(recoverAdmission(root,request(old)).ok,true);
  withAdmissionSync(root,'metadata','task-0002',()=>{
    const current=admissionStatus(root).owner;
    assert.equal(current.epoch,old.epoch+1);
    assert.equal(recoverAdmission(root,request(old)).replayed,true);
    assert.deepEqual(admissionStatus(root).owner,current);
  });
  assert.equal(fs.existsSync(path.join(root,`${old.epoch}.owner.json`)),true,'history is retained');
});

test('independent recovery callers close only the requested dead transaction', async () => {
  const root=path.join(tmp('gate-race'),'admission'), old=await crash(root);
  const script=`import {recoverAdmission} from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(recoverAdmission(process.argv[1],JSON.parse(process.argv[2]))));`;
  const results=await Promise.all(Array.from({length:6},()=>child(script,[root,JSON.stringify(request(old))])));
  for(const r of results){assert.equal(r.code,0,r.err);assert.equal(JSON.parse(r.out).ok,true);}
  assert.equal(admissionStatus(root).epoch,old.epoch+1);
});

test('a dead repository writer or launcher still needs authoritative external reconciliation', async () => {
  for(const kind of ['repository','launch']){
    const root=path.join(tmp(`gate-${kind}`),'admission'), owner=await crash(root,kind);
    assert.equal(recoverAdmission(root,request(owner)).code,'external_reconciliation_required');
    assert.deepEqual(admissionStatus(root).owner,owner);
  }
});

test('a dead PID from another host or boot is not proof for recovery', async () => {
  for (const field of ['host', 'boot']) {
    const root = path.join(tmp(`gate-foreign-${field}`), 'admission'), original = await crash(root);
    const { checksum, ...value } = original;
    value[field] = `foreign-${value[field]}`;
    const owner = { ...value, checksum: refKey(value) };
    const file = path.join(root, `${owner.epoch}.owner.json`);
    fs.writeFileSync(file, JSON.stringify(owner));
    assert.equal(recoverAdmission(root, request(owner)).code, 'unknown_process');
    assert.deepEqual(admissionStatus(root).owner, owner);
    assert.equal(fs.existsSync(path.join(root, `${owner.epoch}.done.json`)), false);
  }
});

test('repository writes, metadata transactions, and scheduler admission share one gate', async () => {
  const {repo,root}=project(); const {store}=seedDelivery(repo,'task-0001');
  writeCard(repo,'task-0002',{status:'Review'});
  const p={name:path.basename(repo),path:repo};let started=0,scheduled,patched;
  withAdmissionSync(root,'metadata','task-0001',()=>{
    scheduled=scheduler.schedule(p,'task-0002','Build',()=>{started++;});
    assert.equal(started,0);
    assert.match(scheduler.queuedEntries(p.name)[0].deferredReason,/admission/);
    patched=patchFrontmatter(repo,'task-0002',{description:'after admission'});
    assert.equal(store.read('task-0001').revision,1);
  });
  await patched; await scheduled;
  assert.equal(started,1);assert.equal(admissionStatus(root).owner,null);
  await withRepoLock(repo,()=>{
    assert.equal(admissionStatus(root).owner.kind,'repository');
    const writer=createDeliveryStore(path.dirname(root),{enabled:true,resolveContext:()=>({actor_id:'human:owner',busy:false,grants:['delivery:assign']})});
    assert.equal(writer.execute('task-0001',{action:'assign',expected_revision:1,idempotency_key:'assigned',role:'delivery_lead',owner:'human:owner',
      handoff:{evidence:'plan',next_action:'implement'}}).ok,true,'synchronous metadata can borrow its enclosing repository gate');
  });
});

test('an async continuation cannot reuse a released admission context', async () => {
  const {repo,root}=project(); seedDelivery(repo,'task-0001');const wake=deferred();let late;
  withAdmissionSync(root,'metadata','task-0001',()=>{
    late=wake.promise.then(()=>withAdmissionSync(root,'metadata','task-0002',()=>99));
  });
  await withExistingProjectAdmission(repo,async()=>{
    wake.resolve();assert.equal((await late).code,'write_busy');
  });
});

test('CLI recovery preserves a committed lease, candidate and receipt after process death', async () => {
  const {repo,root}=project();const {directory,store}=seedDelivery(repo,'task-0001',{leased:true});
  const file=path.join(repo,'.todomd/tasks/task-0001-card.md'), before=fs.readFileSync(file), lease=store.read('task-0001').lease;
  const script=`import fs from 'node:fs';import {createDeliveryStore} from ${JSON.stringify(new URL('../src/delivery-store.js',import.meta.url).href)};
    const rename=fs.renameSync;fs.renameSync=(...a)=>{rename(...a);process.exit(23);};
    const store=createDeliveryStore(process.argv[1],{enabled:true,now:()=>1000,
      resolveContext:()=>({actor_id:'agent-role:builder',grants:['delivery:renew']})});
    store.execute('task-0001',JSON.parse(process.argv[2]));`;
  const command={action:'renew',expected_revision:3,idempotency_key:'renew-once',lease_id:lease.id,run_id:lease.run_id,fence:lease.fence,ttl_ms:1000};
  assert.equal((await child(script,[directory,JSON.stringify(command)])).code,23);
  const owner=admissionStatus(root).owner;
  assert.equal(deliveryRuntimeStatus(repo,'task-0001').code,'delivery_transaction_pending');
  assert.doesNotMatch(JSON.stringify(deliveryRuntimeStatus(repo,'task-0001')),/nonce|pid|checksum|host|boot/);
  const result=spawnSync(process.execPath,[cli,'delivery-admission',repo,'--recover','--epoch',String(owner.epoch),'--nonce',owner.nonce,'--json'],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).effect,'transaction_gate_only');
  const writer=createDeliveryStore(directory,{enabled:true,now:()=>1000,resolveContext:()=>({actor_id:'agent-role:builder',grants:['delivery:renew']})});
  assert.equal(writer.execute('task-0001',command).replayed,true);
  assert.equal(store.read('task-0001').lease.id,lease.id);
  assert.equal(store.read('task-0001').revision,4);
  assert.deepEqual(fs.readFileSync(file),before);
  assert.equal(deliveryRuntimeStatus(repo,'task-0001').code,'delivery_execution_owned');
});

test('corrupt epochs and legacy lock remnants are preserved instead of bypassed', async () => {
  const {repo,root}=project(); const {directory,store}=seedDelivery(repo,'task-0001');
  const owner=await crash(root), file=path.join(root,`${owner.epoch}.owner.json`);
  fs.writeFileSync(file,'{bad');
  assert.equal(recoverAdmission(root,request(owner)).code,'corrupt_admission');
  assert.equal(fs.readFileSync(file,'utf8'),'{bad');
  assert.equal(deliveryRuntimeStatus(repo,'task-0001').code,'delivery_state_unavailable');
  const oldLock=path.join(directory,'task-0001.lock');fs.mkdirSync(oldLock);
  assert.equal(store.execute('task-0001',{action:'transition',to:'ready',expected_revision:1,idempotency_key:'blocked'}).code,'write_busy');
  assert.equal(fs.existsSync(oldLock),true);
});
