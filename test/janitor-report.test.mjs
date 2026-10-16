// The janitor's report: reclaimable worktrees (against real git repos), long-running VMs, memory by category.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  categoryOf,
  memoryByCategory,
  parseWorktrees,
  renderReport,
  runningVms,
  scanWorktrees,
} from '../host/report.mjs';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('git worktree list --porcelain parses into main, linked, detached and prunable entries', () => {
  const porcelain = [
    'worktree /r/main', 'HEAD aaa', 'branch refs/heads/main', '',
    'worktree /r/wt-a', 'HEAD bbb', 'branch refs/heads/feat/a', '',
    'worktree /r/wt-d', 'HEAD ccc', 'detached', '',
    'worktree /r/wt-gone', 'HEAD ddd', 'branch refs/heads/old', 'prunable gitdir file points to non-existent location', '',
    'worktree /r/wt-kept', 'HEAD eee', 'branch refs/heads/kept', 'locked', '',
  ].join('\n');
  assert.deepEqual(parseWorktrees(porcelain), [
    { path: '/r/main', branch: 'main', main: true, prunable: false, locked: false },
    { path: '/r/wt-a', branch: 'feat/a', main: false, prunable: false, locked: false },
    { path: '/r/wt-d', branch: null, main: false, prunable: false, locked: false },
    { path: '/r/wt-gone', branch: 'old', main: false, prunable: true, locked: false },
    { path: '/r/wt-kept', branch: 'kept', main: false, prunable: false, locked: true },
  ]);
});

let root;
before(() => {
  // git reports real paths (macOS's /var is /private/var).
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-kit-janitor-')));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'a'), 'a\n');
  git(repo, 'add', 'a');
  git(repo, 'commit', '-qm', 'one');
  // Branches: done (merged), dirty (merged, but its worktree has an untracked file), open (a commit main lacks).
  for (const b of ['done', 'dirty', 'open']) git(repo, 'worktree', 'add', '-q', '-b', b, join(root, `repo-wt-${b}`));
  writeFileSync(join(root, 'repo-wt-dirty', 'scratch'), 'x\n');
  writeFileSync(join(root, 'repo-wt-open', 'b'), 'b\n');
  git(join(root, 'repo-wt-open'), 'add', 'b');
  git(join(root, 'repo-wt-open'), 'commit', '-qm', 'two');
  git(repo, 'worktree', 'add', '-q', '--detach', join(root, 'repo-wt-detached'));
  git(repo, 'worktree', 'add', '-q', '-b', 'gone', join(root, 'repo-wt-gone'));
  rmSync(join(root, 'repo-wt-gone'), { recursive: true, force: true });
  // Merged and clean, but locked: someone asked git to keep it.
  git(repo, 'worktree', 'add', '-q', '-b', 'kept', join(root, 'repo-wt-kept'));
  git(repo, 'worktree', 'lock', join(root, 'repo-wt-kept'));
  // Neighbours the scan passes over: a plain directory and a repo with no linked worktrees.
  mkdirSync(join(root, 'notes'));
  execFileSync('git', ['init', '-q', '-b', 'main', join(root, 'solo')]);
});
after(() => rmSync(root, { recursive: true, force: true }));

test('a worktree is listed when its branch is merged into the default branch and its tree is clean', () => {
  const scan = scanWorktrees(root);
  assert.deepEqual(scan.reclaimable.map((w) => [w.path.replace(root, ''), w.branch, w.mergedInto]), [['/repo-wt-done', 'done', 'main']]);
  assert.match(scan.reclaimable[0].committed, /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  assert.deepEqual(scan.prunable.map((w) => w.path.replace(root, '')), ['/repo-wt-gone']);
  assert.deepEqual(scan.errors, []);
});

test('with an origin, merged means merged into the remote default branch', () => {
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  // main moves past origin/main to include "open": merged locally, not on the remote.
  git(repo, 'merge', '-q', '--ff-only', 'open');
  try {
    const scan = scanWorktrees(root);
    assert.deepEqual(scan.reclaimable.map((w) => [w.branch, w.mergedInto]), [['done', 'origin/main']]);
  } finally {
    git(repo, 'reset', '-q', '--hard', 'origin/main');
    git(repo, 'remote', 'remove', 'origin');
    rmSync(remote, { recursive: true, force: true });
  }
});

test('a running VM is aged by its tart run process; one with no process has no age', () => {
  const tartList = JSON.stringify([
    { Name: 'cua-clean', State: 'running', Running: true },
    { Name: 'cua-linux', State: 'stopped', Running: false },
    { Name: 'ghost', State: 'running', Running: true },
  ]);
  const procs = [
    { pid: 7, ppid: 1, age: 13 * 3600, command: '/opt/homebrew/Cellar/tart/2.30/tart.app/Contents/MacOS/tart run --no-graphics cua-clean' },
    { pid: 8, ppid: 1, age: 20 * 3600, command: '/opt/homebrew/bin/tart run cua-clean-2' },
  ];
  assert.deepEqual(runningVms(tartList, procs), [
    { name: 'cua-clean', age: 13 * 3600 },
    { name: 'ghost', age: null },
  ]);
});

test('memory is grouped by app bundle, else by executable name', () => {
  assert.equal(categoryOf('/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer'), 'Google Chrome');
  assert.equal(categoryOf('/Users/new/.local/bin/claude --resume e3ce7feb'), 'claude');
  assert.equal(categoryOf('claude'), 'claude');
  assert.equal(categoryOf('/Users/new/.nvm/versions/node/v22.23.2/bin/node /x/cua.mjs'), 'node');
  assert.equal(categoryOf('/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python x.py'), 'Python');
  const top = memoryByCategory([
    { rss: 100, command: '/bin/claude' },
    { rss: 300, command: 'claude --resume' },
    { rss: 350, command: '/Applications/Obsidian.app/Contents/MacOS/Obsidian' },
    { rss: 10, command: 'node x' },
  ], 2);
  assert.deepEqual(top, [
    { category: 'claude', count: 2, rssKb: 400 },
    { category: 'Obsidian', count: 1, rssKb: 350 },
  ]);
});

test('the report lists what it found and states that it deletes nothing', () => {
  const md = renderReport({
    host: 'mbp',
    at: '2026-10-15T23:00:00Z',
    dryRun: true,
    minAgeHours: 2,
    vmReportHours: 12,
    killed: [{ pid: 11, age: 3 * 3600, pattern: '^node --test', command: 'node --test x', result: 'would-kill' }],
    spared: [{ pid: 12, age: 4 * 3600, pattern: 'vitest', excludedBy: '--watch', command: 'node vitest.mjs --watch' }],
    worktrees: { reclaimable: [{ path: '/r/wt', branch: 'done', mergedInto: 'origin/main', committed: '2026-10-14 09:30' }], prunable: [], errors: ['/r/x: git failed'] },
    vms: [{ name: 'cua-clean', age: 13 * 3600 }, { name: 'ghost', age: null }],
    memory: [{ category: 'claude', count: 2, rssKb: 3 * 1024 * 1024 }],
  });
  assert.match(md, /deletes nothing/);
  assert.match(md, /Would kill \(dry run\)/);
  assert.match(md, /\| 11 \| 3h0m \|/);
  assert.match(md, /Left running/);
  assert.match(md, /\| 12 \| 4h0m \| `--watch` \|/);
  assert.match(md, /\| `\/r\/wt` \| done \| origin\/main \| 2026-10-14 09:30 \|/);
  assert.match(md, /\/r\/x: git failed/);
  assert.match(md, /\| cua-clean \| 13h0m \|/);
  assert.match(md, /\| ghost \| unknown \|/);
  assert.match(md, /\| claude \| 2 \| 3\.0 GB \|/);
});
