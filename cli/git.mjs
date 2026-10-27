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

// ci-gate follows the run of ci-kit's gates workflow, so the tested commit must call it from CALLER_PATH (cli/init.mjs
// writes it). A repository whose CI runs from workflows of its own (one with an env-only ci-kit.yml, such as MAWS) is
// refused before anything is pushed: a ci/ push there starts that repository's own runs, which ci-gate never finds.
export function assertCaller(dir, sha, callerPath) {
  const caller = tryGit(dir, ['show', `${sha}:${callerPath}`]);
  if (caller === null) {
    throw new TargetError(`${sha.slice(0, 8)} has no ${callerPath}, so this is not a repository ci-gate runs: its CI runs from its own workflows${ownScript(dir, sha)}`);
  }
  if (!/^\s*uses:.*\.github\/workflows\/gates\.yml/m.test(caller)) {
    throw new TargetError(`${sha.slice(0, 8)}'s ${callerPath} does not call ci-kit's gates workflow, so ci-gate has no run to follow${ownScript(dir, sha)}`);
  }
}

const ownScript = (dir, sha) => (tryGit(dir, ['cat-file', '-e', `${sha}:scripts/ci-gate.sh`]) === null ? '' : '; use its scripts/ci-gate.sh');

// The remote to push to, and the repo it pushes to: the one whose push destination (`remote.<name>.pushurl`, else its
// URL) is `repo` (origin first), and the repo origin pushes to when none is given. The run is polled in the repo the
// ref lands in, so the fetch URL of a fork setup is never used. A remote with several push URLs pushes to all of
// them and has no one destination: it is refused as ambiguous.
export function resolveRemote(dir, repo) {
  const names = (tryGit(dir, ['remote']) ?? '').split('\n').filter(Boolean);
  names.sort((a, b) => (b === 'origin') - (a === 'origin'));
  const remotes = names.map((name) => {
    const urls = (tryGit(dir, ['remote', 'get-url', '--push', '--all', name]) ?? '').split('\n').filter(Boolean);
    return { name, ambiguous: urls.length > 1, repo: urls.length === 1 ? parseGitHubRemote(urls[0]) : null };
  });
  const ambiguity = (r) => `remote ${r.name} has several push URLs, so ci-gate cannot tell which repo it pushes to`;
  if (!repo) {
    const origin = remotes.find((r) => r.name === 'origin');
    if (origin?.ambiguous) throw new TargetError(ambiguity(origin));
    if (!origin?.repo) throw new TargetError('origin does not push to a GitHub repo; pass --repo OWNER/NAME');
    return { name: origin.name, repo: origin.repo };
  }
  const match = remotes.find((r) => r.repo?.toLowerCase() === repo.toLowerCase());
  if (match) return { name: match.name, repo };
  const ambiguous = remotes.find((r) => r.ambiguous);
  throw new TargetError(`no remote of ${dir} pushes to ${repo}${ambiguous ? ` (${ambiguity(ambiguous)})` : ''}`);
}

export function nonceCommit(dir, sha, message) {
  return git(dir, ['commit-tree', `${sha}^{tree}`, '-p', sha, '-F', '-'], { input: message, env: IDENTITY });
}

// GitHub sometimes refuses a push transiently while others push to the same repo
// ("remote rejected (failed)", an index-pack race). The ref is unique to this call and the commit is
// fixed, so pushing it again is safe.
export function pushRef(dir, remote, commit, ref, { attempts = 3, delays = [3000, 8000], sleep = sleepSync } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      git(dir, ['push', '--quiet', '--force', remote, `${commit}:refs/heads/${ref}`]);
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      sleep(delays[Math.min(attempt - 1, delays.length - 1)]);
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
