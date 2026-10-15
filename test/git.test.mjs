// ci-gate's git side against a local bare remote: the nonce commit, the push, and compare-and-delete.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteRef, nonceCommit, pushRef, resolveRemote, resolveTarget } from '../cli/git.mjs';

let root;
let work;
let remote;
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const remoteRef = (ref) => git(remote, 'for-each-ref', '--format=%(objectname)', `refs/heads/${ref}`);

before(() => {
  root = mkdtempSync(join(tmpdir(), 'ci-kit-git-'));
  remote = join(root, 'remote.git');
  work = join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'feat/x', work]);
  git(work, 'config', 'user.email', 't@example.com');
  git(work, 'config', 'user.name', 't');
  writeFileSync(join(work, 'a'), 'a\n');
  git(work, 'add', 'a');
  git(work, 'commit', '-qm', 'one');
  git(work, 'remote', 'add', 'upstream', 'https://github.com/other/thing.git');
  git(work, 'remote', 'add', 'origin', remote);
});

after(() => rmSync(root, { recursive: true, force: true }));

test('a worktree target is its HEAD and branch; a dirty tree is flagged', () => {
  const t = resolveTarget(work);
  assert.equal(t.sha, git(work, 'rev-parse', 'HEAD'));
  assert.equal(t.branch, 'feat/x');
  assert.equal(t.dirty, false);
  writeFileSync(join(work, 'scratch'), 'x\n');
  assert.equal(resolveTarget(work).dirty, true);
  rmSync(join(work, 'scratch'));
});

test('a target that is neither a directory nor a commit is refused', () => {
  assert.throws(() => resolveTarget('no-such-thing-0123'), /no commit no-such-thing-0123/);
});

test('--repo picks the remote that points at it; origin must be on GitHub otherwise', () => {
  assert.deepEqual(resolveRemote(work, 'other/thing'), { name: 'upstream', repo: 'other/thing' });
  assert.throws(() => resolveRemote(work, 'SSFSKIM/nope'), /no remote/);
  assert.throws(() => resolveRemote(work, null), /origin is not a GitHub remote/);
});

test('the nonce commit has the tested tree, the tested parent and the exact message', () => {
  const sha = git(work, 'rev-parse', 'HEAD');
  const commit = nonceCommit(work, sha, 'ci-gate 0123456789ab\n\nCI-Gates: unit\n');
  assert.equal(git(work, 'rev-parse', `${commit}^{tree}`), git(work, 'rev-parse', `${sha}^{tree}`));
  assert.equal(git(work, 'rev-parse', `${commit}^`), sha);
  assert.equal(git(work, 'log', '-1', '--format=%B', commit), 'ci-gate 0123456789ab\n\nCI-Gates: unit');
});

test('compare-and-delete removes only a ref still at this call\'s commit', () => {
  const sha = git(work, 'rev-parse', 'HEAD');
  const mine = nonceCommit(work, sha, 'ci-gate aaaaaaaaaaaa\n');
  const theirs = nonceCommit(work, sha, 'ci-gate bbbbbbbbbbbb\n');
  pushRef(work, 'origin', mine, 'ci/x');
  assert.equal(remoteRef('ci/x'), mine);
  pushRef(work, 'origin', theirs, 'ci/x'); // another call took the ref over
  assert.equal(deleteRef(work, 'origin', mine, 'ci/x'), false);
  assert.equal(remoteRef('ci/x'), theirs);
  assert.equal(deleteRef(work, 'origin', theirs, 'ci/x'), true);
  assert.equal(remoteRef('ci/x'), '');
});
