// The refs ci-gate keeps for a rerun when a call ends without a verdict, and their later sweep, against a scratch repo
// and an injected remover.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEPT_FOR_MS, keepsRef, recordKept, sweepKept } from '../cli/kept.mjs';

let root;
let work;
let linked;
const H = 3_600_000;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'ci-kit-kept-'));
  work = join(root, 'work');
  linked = join(root, 'linked');
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  execFileSync('git', ['-C', work, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one']);
  execFileSync('git', ['-C', work, 'worktree', 'add', '-q', '-b', 'side', linked]);
});

after(() => rmSync(root, { recursive: true, force: true }));

test('the ref stays only on an ERROR while a run exists or may exist; a verdict, or a run never found, removes it', () => {
  assert.equal(keepsRef({ verdict: true, runFound: true, runMayExist: false }), false); // GREEN or RED
  assert.equal(keepsRef({ verdict: false, runFound: true, runMayExist: false }), true); // ERROR or interrupted while watching
  assert.equal(keepsRef({ verdict: false, runFound: false, runMayExist: true }), true); // the budget hid the run
  assert.equal(keepsRef({ verdict: false, runFound: false, runMayExist: false }), false); // no run appeared, or interrupted before one
});

test(`a kept ref is swept by a later call after ${KEPT_FOR_MS / H} h, from any worktree of the clone, and only once`, () => {
  const t0 = Date.parse('2026-11-10T11:00:00Z');
  recordKept(work, { ref: 'ci/old-abcdef12-111111', commit: 'c1', remote: 'origin' }, t0);
  recordKept(linked, { ref: 'ci/new-abcdef12-222222', commit: 'c2', remote: 'origin' }, t0 + 20 * H);
  const removed = [];
  const remove = (e) => { removed.push(e); return true; };

  assert.deepEqual(sweepKept(linked, { nowMs: t0 + 23 * H, remove }), []);
  assert.deepEqual(sweepKept(work, { nowMs: t0 + 25 * H, remove }), [{ ref: 'ci/old-abcdef12-111111', removed: true }]);
  assert.deepEqual(removed, [{ ref: 'ci/old-abcdef12-111111', commit: 'c1', remote: 'origin', keptAt: t0 }]);
  assert.deepEqual(sweepKept(work, { nowMs: t0 + 26 * H, remove }), []);
  assert.deepEqual(sweepKept(work, { nowMs: t0 + 45 * H, remove }), [{ ref: 'ci/new-abcdef12-222222', removed: true }]);
});

test('a ref that cannot be removed (already gone, moved by a later push) is reported and not tried again', () => {
  const t0 = Date.parse('2026-11-10T11:00:00Z');
  recordKept(work, { ref: 'ci/gone-abcdef12-333333', commit: 'c3', remote: 'origin' }, t0);
  assert.deepEqual(sweepKept(work, { nowMs: t0 + 25 * H, remove: () => false }), [{ ref: 'ci/gone-abcdef12-333333', removed: false }]);
  assert.deepEqual(sweepKept(work, { nowMs: t0 + 26 * H, remove: () => true }), []);
});

test('a clone that never kept a ref sweeps nothing and writes nothing', () => {
  const fresh = join(root, 'fresh');
  execFileSync('git', ['init', '-q', fresh]);
  assert.deepEqual(sweepKept(fresh, { nowMs: Date.now(), remove: () => assert.fail('nothing to remove') }), []);
  assert.deepEqual(readdirSync(join(fresh, '.git')).filter((n) => n === 'ci-gate'), []);
});
