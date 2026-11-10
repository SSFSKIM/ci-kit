// The ci refs ci-gate leaves on the remote when a call ends without a verdict, and their sweep by a later call.
// A call that reached GREEN or RED removes its ref; one that ends in ERROR (or is interrupted) while its run exists keeps
// it, so a rerun of the run, or a manual read of its head, still finds the branch. Each kept ref is recorded in the
// clone's git directory (shared by its worktrees), and any later ci-gate in that clone removes the ones older than
// KEPT_FOR_MS, still compare-and-delete. Nothing else sweeps ci refs: the host janitor sees processes, not remotes.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Longer than any run lives (a job times out at 6 h) and than a rerun is likely to wait.
export const KEPT_FOR_MS = 24 * 3_600_000;

// verdict: the call ends GREEN or RED (not ERROR, not interrupted); runFound: discovery found the run; runMayExist: it
// could not look (the budget stayed exhausted), so the push most likely started a run nobody followed. A push that
// started no run within discovery's deadline has nothing to rerun: its ref goes, as after a verdict.
export const keepsRef = ({ verdict, runFound, runMayExist }) => !verdict && (runFound || runMayExist);

function ledger(dir) {
  const common = execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  return join(common, 'ci-gate', 'kept');
}

const fileOf = (ref) => `${ref.replaceAll('/', '_')}.json`;

// entry: { ref, commit, remote } (the remote's name in this clone).
export function recordKept(dir, entry, nowMs) {
  const path = ledger(dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, fileOf(entry.ref)), JSON.stringify({ ...entry, keptAt: nowMs }) + '\n');
}

// Removes each recorded ref kept longer than maxAgeMs with remove(entry) → true when the ref was deleted, and forgets
// it either way: a ref already gone or moved by a later push is not this clone's to retry. Answers what it tried.
export function sweepKept(dir, { nowMs, remove, maxAgeMs = KEPT_FOR_MS }) {
  const path = ledger(dir);
  let names;
  try {
    names = readdirSync(path);
  } catch {
    return []; // this clone never kept a ref
  }
  const due = [];
  for (const name of names) {
    const file = join(path, name);
    let entry;
    try {
      entry = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue; // being written by a concurrent call, or not ours
    }
    if (nowMs - entry.keptAt > maxAgeMs) due.push({ file, entry });
  }
  due.sort((a, b) => a.entry.keptAt - b.entry.keptAt);
  return due.map(({ file, entry }) => {
    const removed = remove(entry);
    rmSync(file, { force: true });
    return { ref: entry.ref, removed };
  });
}
