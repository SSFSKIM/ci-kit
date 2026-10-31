import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../mac/repo.sh', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'ci-kit-repo-'));
after(() => rmSync(root, { recursive: true, force: true }));
function resolve(contents, override) {
  const home = mkdtempSync(join(root, 'home-'));
  mkdirSync(join(home, 'actions-runner-maws'));
  if (contents !== undefined) writeFileSync(join(home, 'actions-runner-maws/.env'), contents);
  const result = spawnSync('/bin/bash', ['-eu', '-c', 'source "$1"; ci_kit_repo', 'bash', helper], {
    encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin', ...(override === undefined ? {} : { CI_KIT_VM_REPO: override }) },
  });
  return { ...result, home };
}
test('the unconfigured Mac keeps today’s repository', () => {
  const r = resolve();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'SSFSKIM/MAWS');
});
test('all host tools read the exclusive runner’s one persisted repo setting', () => {
  const r = resolve('LANG=en_US.UTF-8\nCI_KIT_VM_REPO=neworg/MAWS\n');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'neworg/MAWS');
});
test('an explicit environment overrides the stored setting; empty means use stored/default', () => {
  const r = resolve('CI_KIT_VM_REPO=neworg/MAWS\n', 'rehearsal/other');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'rehearsal/other');
  assert.equal(resolve('CI_KIT_VM_REPO=neworg/MAWS\n', '').stdout.trim(), 'neworg/MAWS');
  assert.equal(resolve('CI_KIT_VM_REPO=\n').stdout.trim(), 'SSFSKIM/MAWS');
});
test('the runner environment is data, never executable shell', () => {
  const r = resolve('UNRELATED=$(touch "$HOME/executed")\nCI_KIT_VM_REPO=neworg/MAWS\n');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'neworg/MAWS');
  assert.equal(existsSync(join(r.home, 'executed')), false);
  for (const value of ['neworg', 'neworg/MAWS/extra', '$(touch "$HOME/executed")/MAWS']) {
    const bad = resolve(`CI_KIT_VM_REPO=${value}\n`);
    assert.notEqual(bad.status, 0);
    assert.equal(bad.stdout, '');
    assert.equal(existsSync(join(bad.home, 'executed')), false);
  }
});
