// ci-gate's git side against a local bare remote: the nonce commit, the push, and compare-and-delete.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertCaller, deleteRef, nonceCommit, pushRef, resolveRemote, resolveTarget } from '../cli/git.mjs';
import { CALLER_PATH } from '../cli/init.mjs';

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

test('--repo picks the remote that pushes to it; origin must push to GitHub otherwise', () => {
  assert.deepEqual(resolveRemote(work, 'other/thing'), { name: 'upstream', repo: 'other/thing' });
  assert.throws(() => resolveRemote(work, 'SSFSKIM/nope'), /no remote/);
  assert.throws(() => resolveRemote(work, null), /origin does not push to a GitHub repo/);
});

// A fork setup: origin fetches from the upstream repo and pushes to the fork (remote.origin.pushurl). The run is
// polled where the ref lands, so the push destination decides the repo, for the default and for --repo.
test('the repo is the remote\'s push destination, not its fetch URL', () => {
  const fork = join(root, 'fork');
  execFileSync('git', ['init', '-q', fork]);
  git(fork, 'remote', 'add', 'origin', 'https://github.com/upstream/repo.git');
  assert.deepEqual(resolveRemote(fork, null), { name: 'origin', repo: 'upstream/repo' });
  git(fork, 'config', 'remote.origin.pushurl', 'git@github.com:me/repo.git');
  assert.deepEqual(resolveRemote(fork, null), { name: 'origin', repo: 'me/repo' });
  assert.deepEqual(resolveRemote(fork, 'me/repo'), { name: 'origin', repo: 'me/repo' });
  assert.throws(() => resolveRemote(fork, 'upstream/repo'), /no remote .* pushes to upstream\/repo/);
});

test('a remote with several push URLs is ambiguous: refused as the default, and never matched by --repo', () => {
  const dir = join(root, 'multi');
  execFileSync('git', ['init', '-q', dir]);
  git(dir, 'remote', 'add', 'origin', 'https://github.com/a/one.git');
  git(dir, 'remote', 'add', 'other', 'https://github.com/c/three.git');
  git(dir, 'config', '--add', 'remote.origin.pushurl', 'https://github.com/a/one.git');
  git(dir, 'config', '--add', 'remote.origin.pushurl', 'https://github.com/b/two.git');
  assert.throws(() => resolveRemote(dir, null), /remote origin has several push URLs/);
  assert.throws(() => resolveRemote(dir, 'b/two'), /no remote .* pushes to b\/two .*several push URLs/);
  assert.deepEqual(resolveRemote(dir, 'c/three'), { name: 'other', repo: 'c/three' });
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

test('a transiently refused push is retried, and a lasting refusal still fails after the last attempt', () => {
  const sha = git(work, 'rev-parse', 'HEAD');
  const commit = nonceCommit(work, sha, 'ci-gate cccccccccccc\n');
  const late = join(root, 'late.git'); // absent until the first wait: the first push fails
  git(work, 'remote', 'add', 'late', late);
  const waits = [];
  pushRef(work, 'late', commit, 'ci/y', {
    sleep: (ms) => { waits.push(ms); execFileSync('git', ['init', '-q', '--bare', late]); },
  });
  assert.deepEqual(waits, [3000]);
  assert.equal(git(late, 'for-each-ref', '--format=%(objectname)', 'refs/heads/ci/y'), commit);

  git(work, 'remote', 'add', 'gone', join(root, 'never.git'));
  const tries = [];
  assert.throws(() => pushRef(work, 'gone', commit, 'ci/y', { sleep: (ms) => tries.push(ms) }));
  assert.deepEqual(tries, [3000, 8000]);
});

test("a commit that does not call ci-kit's gates workflow is refused before anything is pushed", () => {
  const repo = join(root, 'own-ci');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  const commitWith = (files) => {
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(repo, dirname(path)), { recursive: true });
      writeFileSync(join(repo, path), body);
    }
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'c');
    return git(repo, 'rev-parse', 'HEAD');
  };
  // An env-only ci-kit.yml with the repository's own workflow (MAWS's shape): no ci.yml at all.
  let sha = commitWith({ '.github/ci-kit.yml': 'version: 1\nsetup:\n  node: "22"\n', '.github/workflows/gate.yml': 'on: push\n' });
  assert.throws(() => assertCaller(repo, sha, CALLER_PATH), /has no \.github\/workflows\/ci\.yml, so this is not a repository ci-gate runs/);
  sha = commitWith({ 'scripts/ci-gate.sh': '#!/bin/sh\n' });
  assert.throws(() => assertCaller(repo, sha, CALLER_PATH), /use its scripts\/ci-gate\.sh$/);
  // A ci.yml of the repository's own, not the caller ci-gate init writes.
  sha = commitWith({ '.github/workflows/ci.yml': 'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: [{run: make test}]\n' });
  assert.throws(() => assertCaller(repo, sha, CALLER_PATH), /does not call ci-kit's gates workflow/);
  // The caller, pinned (an adopter) or local (ci-kit itself), passes.
  sha = commitWith({ '.github/workflows/ci.yml': 'jobs:\n  ci:\n    uses: SSFSKIM/ci-kit/.github/workflows/gates.yml@v1\n' });
  assert.doesNotThrow(() => assertCaller(repo, sha, CALLER_PATH));
  sha = commitWith({ '.github/workflows/ci.yml': 'jobs:\n  ci:\n    uses: ./.github/workflows/gates.yml\n' });
  assert.doesNotThrow(() => assertCaller(repo, sha, CALLER_PATH));
});
