// The git side of ci-gate: resolve what to test, build the nonce commit, push the ci ref and remove it again.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { parseGitHubRemote } from './naming.mjs';

// The nonce commit is a throwaway: a fixed identity keeps it independent of the machine's git config.
const IDENTITY = {
  GIT_AUTHOR_NAME: 'ci-gate',
  GIT_AUTHOR_EMAIL: 'ci-gate@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'ci-gate',
  GIT_COMMITTER_EMAIL: 'ci-gate@users.noreply.github.com',
};

export class TargetError extends Error {}

function git(dir, args, { input, env } = {}) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    input,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(dir, args) {
  try {
    return git(dir, args);
  } catch {
    return null;
  }
}

const isDirectory = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// A worktree path tests its HEAD; anything else is a commit, resolved in the current directory's repo.
export function resolveTarget(target) {
  if (isDirectory(target)) {
    const sha = tryGit(target, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (!sha) throw new TargetError(`${target} is not a git worktree with a commit`);
    return {
      dir: target,
      sha,
      branch: tryGit(target, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      dirty: (tryGit(target, ['status', '--porcelain']) ?? '') !== '',
    };
  }
  const sha = tryGit('.', ['rev-parse', '--verify', '--quiet', `${target}^{commit}`]);
  if (!sha) throw new TargetError(`no commit ${target} (and no such directory)`);
  return { dir: '.', sha, branch: null, dirty: false };
}

// The remote to push to: the one pointing at `repo` (origin first), and the repo origin names when none is given.
export function resolveRemote(dir, repo) {
  const names = (tryGit(dir, ['remote']) ?? '').split('\n').filter(Boolean);
  names.sort((a, b) => (b === 'origin') - (a === 'origin'));
  const remotes = names.map((name) => ({ name, repo: parseGitHubRemote(tryGit(dir, ['remote', 'get-url', name]) ?? '') }));
  if (!repo) {
    const origin = remotes.find((r) => r.name === 'origin');
    if (!origin?.repo) throw new TargetError('origin is not a GitHub remote; pass --repo OWNER/NAME');
    return origin;
  }
  const match = remotes.find((r) => r.repo?.toLowerCase() === repo.toLowerCase());
  if (!match) throw new TargetError(`no remote of ${dir} points at ${repo}`);
  return { name: match.name, repo };
}

export function nonceCommit(dir, sha, message) {
  return git(dir, ['commit-tree', `${sha}^{tree}`, '-p', sha, '-F', '-'], { input: message, env: IDENTITY });
}

export function pushRef(dir, remote, commit, ref) {
  git(dir, ['push', '--quiet', '--force', remote, `${commit}:refs/heads/${ref}`]);
}

// Compare-and-delete: only while the ref still points at this call's nonce commit.
export function deleteRef(dir, remote, commit, ref) {
  try {
    git(dir, ['push', '--quiet', `--force-with-lease=refs/heads/${ref}:${commit}`, remote, `:refs/heads/${ref}`]);
    return true;
  } catch {
    return false;
  }
}
