// The ci refs ci-gate leaves on the remote when a call ends without a verdict, and their sweep by a later call.
// A call that reached GREEN or RED removes its ref; one that ends in ERROR (or is interrupted) while its run exists keeps
// it, so a rerun of the run, or a manual read of its head, still finds the branch. Each kept ref is recorded in the
// clone's git directory (shared by its worktrees), and any later ci-gate in that clone removes the ones older than
// KEPT_FOR_MS whose run is not going again (a rerun keeps the commit, so compare-and-delete alone would not spare it).
// Nothing else sweeps ci refs: the host janitor sees processes, not remotes.
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

// entry: { ref, commit, remote, repo } (remote: its name in this clone; repo: OWNER/NAME, where the ref's runs are).
export function recordKept(dir, entry, nowMs) {
  const path = ledger(dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, fileOf(entry.ref)), JSON.stringify({ ...entry, keptAt: nowMs }) + '\n');
}

// Sweeps the recorded refs kept longer than maxAgeMs and answers [{ ref, outcome }] for each:
//   busy(entry) → true while the ref's newest run is queued or going (outcome 'busy'), null when that cannot be told
//   (outcome 'unknown'); either way the ref is left for a later call. Otherwise remove(entry) → 'removed', 'gone' or
//   'moved', after which the record is forgotten, or 'failed', and it is kept to try again.
export async function sweepKept(dir, { nowMs, remove, busy, maxAgeMs = KEPT_FOR_MS }) {
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
  const swept = [];
  for (const { file, entry } of due) {
    const going = await busy(entry);
    const outcome = going === true ? 'busy' : going === null ? 'unknown' : remove(entry);
    if (['removed', 'gone', 'moved'].includes(outcome)) rmSync(file, { force: true });
    swept.push({ ref: entry.ref, outcome });
  }
  return swept;
}
