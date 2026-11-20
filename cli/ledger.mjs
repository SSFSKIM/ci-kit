// ci-gate's side of the gate ledger (gate ledger spec, "`ci-gate` at a failure" and "Known entries", M5): the context
// lines printed after a FAIL, `ci-gate status`, and `ci-gate known add|list`. Everything is read and written through the
// contents API on the store's branch with gh's token; the store is the private sandbox's `test-history` branch, laid out
// by `<alias>/status.json` and `<alias>/known.json` (history/status.mjs, history/known.mjs).
//
// The context is context, never a verdict: one contents call, started at an invocation's first failure on a client
// of its own and never waited for. A status not yet answered, that cannot be read, is not a status, or is 48 hours old
// or older adds nothing, so ci-gate's output, verdict and timing are then exactly what they were without the ledger.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createGitHub, ghToken, GitHubError } from '../lib/github.mjs';
import { addKnown, inForce, isDay, KnownConflict, KnownError, validateKnown } from '../history/known.mjs';
import { LEDGER_USAGE, parseKnownArgs, parseStatusArgs, UsageError } from './args.mjs';
import { resolveRemote, TargetError } from './git.mjs';
import { THROTTLE_BELOW } from './pace.mjs';

export const STORE = { repo: 'SSFSKIM/ci-kit-sandbox', branch: 'test-history' };
const STALE_MS = 48 * 3_600_000;
// The pool's clock and this machine's may differ a little; a status further ahead than this is not a reading.
const SKEW_MS = 5 * 60_000;
const INDENT = '     '; // under the gate name of `FAIL <gate>`
const HOUR = 3_600_000;
// The lookup spends one call of the token every session shares, and the first failure's own path spends more before
// the next poll reads the budget: the log (up to 6 tries), the artifacts listing, `gh run download` (a listing and a
// download), then that poll (2). So it starts only with this much above the pacer's THROTTLE threshold: one failure
// path, the lookup and the poll fit with room to spare, and the lookup is never the call that brings on a THROTTLE.
export const CONTEXT_HEADROOM = 25;
export const roomForContext = (remaining) => typeof remaining === 'number' && remaining >= THROTTLE_BELOW + CONTEXT_HEADROOM;
// known add writes only here: the live branch, or a test copy whose name starts with the prefix.
const WRITABLE = (branch) => branch === STORE.branch || branch.startsWith('ledger-');

// CI_KIT_STORE=OWNER/NAME@BRANCH points every read at another copy of the store (a test branch; `known add` writes only
// to the store's repository, on test-history or a `ledger-*` branch); null when it is set and is not that, an empty
// value included.
export function storeOf(env = process.env) {
  const value = env.CI_KIT_STORE;
  if (value === undefined) return STORE;
  const m = /^([\w.-]+\/[\w.-]+)@(\S+)$/.exec(value);
  return m ? { repo: m[1], branch: m[2] } : null;
}

// The repositories the ledger collects. Read when first asked for, never at import: ci-gate's gate path loads this
// module, and a repos.json that cannot be read must cost it only the context.
let repos = null;
export const loadRepos = () => (repos ??= JSON.parse(readFileSync(new URL('../history/repos.json', import.meta.url), 'utf8')));

// A repository the ledger collects, by its GitHub name: its directory in the store and its default branch.
export function ledgerEntry(repo, list = loadRepos()) {
  const e = list.find((r) => typeof r.repo === 'string' && r.repo.toLowerCase() === repo.toLowerCase());
  return e ? { alias: e.alias ?? e.repo, branch: e.default_branch } : null;
}

// A file of the store: { text, sha }, or null when the branch has no such file.
export async function readStoreFile(gh, store, path) {
  try {
    const f = await gh.contents(store.repo, path, store.branch);
    return { text: Buffer.from(f.content, 'base64').toString('utf8'), sha: f.sha };
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}

// A field of the record as printed: one line of printable text ('' for anything that is not a string), so no value
// can open a line of its own or carry a terminal control sequence.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
export const printable = (v) => (typeof v === 'string' ? v.replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim() : '');
const sentence = (s) => printable(s).replace(/\.+$/, '');
const timeOf = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);
const minute = (ms) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
const commitOf = (v) => (typeof v === 'string' && /^[0-9a-f]{7,40}$/i.test(v) ? v.slice(0, 7) : null);
// A run: an Actions run id, or a hand-run Mac gate's run directory (`<sha12>-<YYYYMMDD>T<HHMMSS>Z`, history/manual-gate.mjs).
const MANUAL_RUN = /^[0-9a-f]{12}-\d{8}T\d{6}Z$/;
const runOf = (v) => ((Number.isSafeInteger(v) && v > 0) || (typeof v === 'string' && (/^[1-9]\d{0,19}$/.test(v) || MANUAL_RUN.test(v))) ? String(v) : null);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// What the status's as_of says of the record: `none` (null: no pass has derived it), `invalid` (not a status, or a
// time that does not parse), `ahead` (further ahead of this clock than the skew), `stale` (48 hours or older), `fresh`.
function freshness(status, now) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return { kind: 'invalid' };
  if (!status.gates || typeof status.gates !== 'object' || Array.isArray(status.gates)) return { kind: 'invalid' };
  if (status.as_of === null || status.as_of === undefined) return { kind: 'none' };
  const at = timeOf(status.as_of);
  if (at === null) return { kind: 'invalid' };
  const age = now - at;
  if (age <= -SKEW_MS) return { kind: 'ahead', at, age };
  return { kind: age < STALE_MS ? 'fresh' : 'stale', at, age };
}

// The lines printed after `FAIL <gate>`: `base:` when the gate's latest observation on the default branch is a
// failure with a commit, a time and a run that read as such; `known:` for each entry in force today without keep that
// names the gate and has an id and a reason.
export function contextLines(status, gate, { now, branch }) {
  if (freshness(status, now).kind !== 'fresh') return [];
  const lines = [];
  const g = status.gates[gate];
  if (g?.result === 'failed') {
    const [commit, at, run] = [commitOf(g.commit), timeOf(g.at), runOf(g.run)];
    if (commit && at !== null && run) {
      lines.push(`${INDENT}base: ${gate} last ran on ${printable(branch)} at ${commit} (${minute(at)}) and failed, run ${run}. The failures may differ: compare before rerunning.`);
    }
  }
  const today = dayOf(now);
  for (const e of Array.isArray(status.known) ? status.known : []) {
    if (!e || e.gate !== gate || e.keep || !isDay(e.since) || !isDay(e.review_by) || !inForce(e, today)) continue;
    const [id, reason] = [printable(e.id), sentence(e.reason)];
    if (!id || !reason) continue;
    lines.push(`${INDENT}known: ${id} (review by ${e.review_by}): ${reason}. Whether this failure is that one is not checked.`);
  }
  return lines;
}

// One invocation's context. start() begins the one contents call, at the first failure, without waiting for it; it
// does nothing when the shared budget is low (lowBudget()), the store or the repository is not the ledger's, or
// repos.json cannot be read. linesFor(gate) answers that gate's lines once the call has settled and [] until then, so a
// slow or stalled store delays nothing. Neither throws. gh should be a client of its own, so its answers never reach
// the watch's pacer, its counts or its debug log.
export function contextReader({ gh, repo, store, now, lowBudget = () => false, readRepos = loadRepos }) {
  let state = 'idle'; // idle → pending → ready | off
  let status = null;
  let entry = null;
  return {
    start() {
      if (state !== 'idle') return;
      state = 'off';
      try {
        if (!store || lowBudget()) return;
        entry = ledgerEntry(repo, readRepos());
        if (!entry) return;
        state = 'pending';
        readStoreFile(gh, store, `${entry.alias}/status.json`).then(
          (f) => {
            status = f ? JSON.parse(f.text) : null;
            state = 'ready';
          },
          () => { state = 'off'; },
        ).catch(() => { state = 'off'; });
      } catch {
        state = 'off';
      }
    },
    linesFor(gate) {
      if (state !== 'ready') return [];
      try {
        return contextLines(status, gate, { now: now(), branch: entry.branch });
      } catch {
        return [];
      }
    },
  };
}

const pad = (rows) => {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i].length))) ?? [];
  return rows.map((r) => `  ${r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ')}`);
};

const NOT_SHOWN = 'so ci-gate shows none of it at a failure';

// `ci-gate status`: the standing of each gate on the default branch, how old the record behind it is, and the entries.
export function statusReport({ status, known, repo, branch, now }) {
  const f = freshness(status, now);
  const where = `${printable(repo)} on ${printable(branch)}`;
  const tail = knownReport(known, dayOf(now));
  if (f.kind === 'none') return [`${where}: no standing yet (no pass has derived the record).`, ...tail];
  if (!status?.gates || typeof status.gates !== 'object' || Array.isArray(status.gates)) return [`${where}: the store's status.json is not a status file.`, ...tail];
  const rows = Object.keys(status.gates).sort().map((gate) => {
    const g = status.gates[gate] ?? {};
    const at = timeOf(g.at);
    return [printable(gate), printable(g.result) || '?', commitOf(g.commit) ?? '?', at === null ? '?' : minute(at), `run ${runOf(g.run) ?? '?'}${Number.isSafeInteger(g.attempt) && g.attempt > 1 ? ` attempt ${g.attempt}` : ''}`];
  });
  const hours = (ms) => (Math.abs(ms) / HOUR).toFixed(1);
  const head = {
    invalid: `${where}: the status's as_of is not a time (${printable(String(status.as_of))}), ${NOT_SHOWN}:`,
    ahead: `${where}, as of ${f.at === undefined ? '' : minute(f.at)} (${hours(f.age)} hours ahead of this machine's clock, ${NOT_SHOWN}):`,
    stale: `${where}, as of ${f.at === undefined ? '' : minute(f.at)} (${hours(f.age)} hours ago; older than 48 hours, ${NOT_SHOWN}):`,
    fresh: `${where}, as of ${f.at === undefined ? '' : minute(f.at)} (${hours(f.age)} hours ago):`,
  }[f.kind];
  return [head, ...pad(rows), ...tail];
}

function stateOf(e, today) {
  if (!isDay(e.since) || !isDay(e.review_by)) return 'dates unreadable, never in force';
  if (today > e.review_by) return `expired ${e.review_by}`;
  const span = today < e.since ? `from ${e.since}, review by ${e.review_by}` : `in force, review by ${e.review_by}`;
  return e.keep ? `keep, ${span}` : span;
}

// `ci-gate known list`, and the tail of `ci-gate status`: every entry of known.json with its state today.
export function knownReport(entries, today) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  if (list.length === 0) return ['Known entries: none.'];
  const lines = [`Known entries (${list.length}):`];
  for (const e of list) {
    lines.push(`  ${printable(e.id) || '?'}  ${printable(e.gate) || '?'}  ${stateOf(e, today)}  (by ${printable(e.by) || '?'}, since ${printable(e.since) || '?'})`);
    if (e.case) lines.push(`      case: ${printable(e.case)}`);
    lines.push(`      reason: ${printable(e.reason)}`);
  }
  return lines;
}

// known.json of one repository as addKnown reads and writes it: a write names the blob it read, and the contents API's
// refusal of a stale blob (409), or of a create when another writer created the file first (422 on a write that named
// no blob), is a KnownConflict; any other 422 is an error.
export function knownFile({ gh, store, alias }) {
  const path = `${alias}/known.json`;
  return {
    read: async () => {
      const f = await readStoreFile(gh, store, path);
      return f ? { entries: JSON.parse(f.text), sha: f.sha } : { entries: [], sha: null };
    },
    write: async (entries, sha) => {
      const added = entries.at(-1);
      const body = {
        message: `known: add ${added.id} (${added.gate}) to ${alias}`,
        content: Buffer.from(`${JSON.stringify(entries, null, 1)}\n`).toString('base64'),
        branch: store.branch,
        ...(sha ? { sha } : {}),
      };
      try {
        await gh.putContents(store.repo, path, body);
      } catch (e) {
        if (e instanceof GitHubError && (e.status === 409 || (e.status === 422 && !sha))) throw new KnownConflict();
        throw e;
      }
    },
  };
}

const gitUser = () => {
  try {
    return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
};

class LedgerError extends Error {}

// `ci-gate status` and `ci-gate known add|list` (argv from the subcommand's name on). Prints its result on stdout, or
// ERROR <message> as the last line; returns the exit code: 0 done, 2 refused or unreadable.
//   gh: a client (made from gh's login when absent); out/note: stdout and stderr lines; user(): who records an entry.
export async function runLedger(argv, { gh = null, out, note, env = process.env, now = Date.now, user = gitUser } = {}) {
  if (argv.includes('-h') || argv.includes('--help')) {
    out(LEDGER_USAGE);
    return 0;
  }
  try {
    const opts = argv[0] === 'status' ? { action: 'status', ...parseStatusArgs(argv.slice(1)) } : parseKnownArgs(argv.slice(1));
    const store = storeOf(env);
    if (!store && env.CI_KIT_STORE === '') throw new LedgerError('CI_KIT_STORE is set and empty; it is OWNER/NAME@BRANCH, or unset for the live store');
    if (!store) throw new LedgerError(`CI_KIT_STORE is OWNER/NAME@BRANCH, not ${printable(env.CI_KIT_STORE)}`);
    // A write goes only to the private store's repository, on its live branch or a `ledger-*` test copy; reads may go
    // anywhere.
    if (opts.action === 'add' && (store.repo.toLowerCase() !== STORE.repo.toLowerCase() || !WRITABLE(store.branch))) {
      throw new LedgerError(`known add writes only to the private store, ${STORE.repo}, on ${STORE.branch} or a test copy named ledger-*, not ${store.repo}@${printable(store.branch)}`);
    }
    const repo = opts.repo ?? resolveRemote('.', null).repo;
    let list;
    try {
      list = loadRepos();
    } catch (e) {
      throw new LedgerError(`history/repos.json cannot be read: ${e.message}`);
    }
    const entry = ledgerEntry(repo, list);
    if (!entry) throw new LedgerError(`${repo} is not a repository the gate ledger collects (history/repos.json)`);
    const today = dayOf(now());
    if (opts.action === 'add') validateKnown(opts, today);
    if (!gh) {
      const token = ghToken();
      if (!token) throw new LedgerError('gh is not authenticated (run: gh auth login)');
      gh = createGitHub(token);
    }
    const where = `${store.repo}@${store.branch}`;
    const file = knownFile({ gh, store, alias: entry.alias });
    const read = async (f) => {
      try {
        return await f();
      } catch (e) {
        if (e instanceof GitHubError || e instanceof SyntaxError || e instanceof TypeError) throw new LedgerError(`the store ${where} cannot be read: ${e.message}`);
        throw e;
      }
    };
    if (opts.action === 'status') {
      const status = await read(() => readStoreFile(gh, store, `${entry.alias}/status.json`));
      if (!status) throw new LedgerError(`no status.json for ${entry.alias} in ${where}`);
      const { entries } = await read(file.read);
      for (const line of statusReport({ status: await read(async () => JSON.parse(status.text)), known: entries, repo, branch: entry.branch, now: now() })) out(line);
    } else if (opts.action === 'list') {
      const { entries } = await read(file.read);
      for (const line of knownReport(entries, today)) out(line);
    } else {
      const fields = { ...opts, case: opts.case ?? null, id: opts.id ?? null };
      const added = await addKnown({ ...file, fields, today, by: opts.by ?? user() ?? 'unknown', onRetry: () => note('known.json changed since it was read; read it again and reapplied the entry') });
      out(`added ${added.id} to ${entry.alias}'s known entries (gate ${added.gate}, review by ${added.review_by}) in ${where}`);
    }
    return 0;
  } catch (e) {
    if (e instanceof UsageError) process.stderr.write(`${LEDGER_USAGE}\n`);
    else if (!(e instanceof LedgerError || e instanceof KnownError || e instanceof TargetError || e instanceof GitHubError)) throw e;
    out(`ERROR ${e.message}`);
    return 2;
  }
}
