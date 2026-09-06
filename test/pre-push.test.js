import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmp, git } from './helpers.js';

test('pre-push clears inherited Git context before CI creates fixture repositories', () => {
  const repo=tmp('hook-owner');const child=tmp('hook-fixture');const bin=tmp('hook-bin');
  git(repo,['init','-q']);git(repo,['config','user.name','Fixture']);git(repo,['config','user.email','fixture@example.test']);
  fs.writeFileSync(path.join(repo,'source'),'preserve');git(repo,['add','source']);git(repo,['commit','-qm','owner']);
  const before=git(repo,['rev-parse','HEAD']);
  fs.writeFileSync(path.join(bin,'npm'),`#!/bin/sh
set -eu
test -z "\${GIT_DIR:-}"
test -z "\${GIT_INDEX_FILE:-}"
cd "$FLEET_HOOK_FIXTURE"
git init -q
git config user.name Fixture
git config user.email fixture@example.test
touch fixture
git add fixture
git commit -qm fixture
`,{mode:0o755});
  const hook=fileURLToPath(new URL('../.githooks/pre-push',import.meta.url));
  execFileSync('sh',[hook],{cwd:repo,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,
    GIT_DIR:path.join(repo,'.git'),GIT_INDEX_FILE:path.join(repo,'.git/index'),FLEET_HOOK_FIXTURE:child}});
  assert.equal(git(repo,['rev-parse','HEAD']),before);
  assert.equal(git(repo,['status','--porcelain']),'');
  assert.notEqual(git(child,['rev-parse','HEAD']),before);
});
