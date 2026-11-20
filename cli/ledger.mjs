// ci-gate's side of the gate ledger (gate ledger spec, "`ci-gate` at a failure" and "Known entries", M5): the context
// lines printed after a FAIL, `ci-gate status`, and `ci-gate known add|list`. Everything is read and written through the
// contents API on the store's branch with gh's token; the store is the private sandbox's `test-history` branch, laid out
// by `<alias>/status.json` and `<alias>/known.json` (history/status.mjs, history/known.mjs).
//
// The context is context, never a verdict: it is read with one contents call at an invocation's first failure, and a
// status that cannot be read, is not a status, or is 48 hours old or older adds nothing, so ci-gate's output is then
// exactly what it was without the ledger.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createGitHub, ghToken, GitHubError } from '../lib/github.mjs';
import { addKnown, inForce, KnownConflict, KnownError, validateKnown } from '../history/known.mjs';
import { LEDGER_USAGE, parseKnownArgs, parseStatusArgs, UsageError } from './args.mjs';
import { resolveRemote, TargetError } from './git.mjs';

export const STORE = { repo: 'SSFSKIM/ci-kit-sandbox', branch: 'test-history' };
const STALE_MS = 48 * 3_600_000;
// The pool's clock and this machine's may differ a little; a status further ahead than this is not a reading.
const SKEW_MS = 5 * 60_000;
const INDENT = '     '; // under the gate name of `FAIL <gate>`

// CI_KIT_STORE=OWNER/NAME@BRANCH points every read and write at another copy of the store (a test branch); null when
// it is set and is not that.
export function storeOf(env = process.env) {
  const value = env.CI_KIT_STORE;
  if (value === undefined || value === '') return STORE;
  const m = /^([\w.-]+\/[\w.-]+)@(\S+)$/.exec(value);
  return m ? { repo: m[1], branch: m[2] } : null;
}

const REPOS = JSON.parse(readFileSync(new URL('../history/repos.json', import.meta.url), 'utf8'));

// A repository the ledger collects, by its GitHub name: its directory in the store and its default branch.
export function ledgerEntry(repo) {
  const e = REPOS.find((r) => r.repo.toLowerCase() === repo.toLowerCase());
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

const minute = (iso) => `${iso.slice(0, 16)}Z`;
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const sentence = (s) => oneLine(s).replace(/\.+$/, '');
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// The status's age in ms, or null when it is not a status with a time of its own.
function ageOf(status, now) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return null;
  if (!status.gates || typeof status.gates !== 'object' || Array.isArray(status.gates)) return null;
  if (typeof status.as_of !== 'string') return null;
  const at = Date.parse(status.as_of);
  return Number.isNaN(at) ? null : now - at;
}

const fresh = (status, now) => {
  const age = ageOf(status, now);
  return age !== null && age > -SKEW_MS && age < STALE_MS;
};

// The lines printed after `FAIL <gate>`: `base:` when the gate's latest observation on the default branch is a
// failure, `known:` for each entry in force today without keep that names the gate.
export function contextLines(status, gate, { now, branch }) {
  if (!fresh(status, now)) return [];
  const lines = [];
  const g = status.gates[gate];
  if (g?.result === 'failed') {
    lines.push(`${INDENT}base: ${gate} last ran on ${branch} at ${String(g.commit).slice(0, 7)} (${minute(g.at)}) and failed, run ${g.run}. The failures may differ: compare before rerunning.`);
  }
  const today = dayOf(now);
  for (const e of Array.isArray(status.known) ? status.known : []) {
    if (e?.gate !== gate || e.keep || !inForce(e, today)) continue;
    lines.push(`${INDENT}known: ${e.id} (review by ${e.review_by}): ${sentence(e.reason)}. Whether this failure is that one is not checked.`);
  }
  return lines;
}

// context(gate) → the lines to print after that gate's FAIL. The status is read once, at the first call; any failure
// to read it, or a repository the ledger does not collect, gives no lines. It never throws.
export function contextReader({ gh, repo, store, now }) {
  const entry = ledgerEntry(repo);
  let status;
  return async (gate) => {
    if (!entry || !store) return [];
    try {
      status ??= readStoreFile(gh, store, `${entry.alias}/status.json`).then((f) => (f ? JSON.parse(f.text) : null));
      return contextLines(await status, gate, { now: now(), branch: entry.branch });
    } catch {
      return [];
    }
  };
}

const pad = (rows) => {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => r[i].length))) ?? [];
  return rows.map((r) => `  ${r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ')}`);
};

// `ci-gate status`: the standing of each gate on the default branch, how old the record behind it is, and the entries.
export function statusReport({ status, known, repo, branch, now }) {
  const age = ageOf(status, now);
  if (age === null) return [`${repo} on ${branch}: no standing yet (no pass has derived the record).`, ...knownReport(known, dayOf(now))];
  const hours = `${(Math.max(0, age) / 3_600_000).toFixed(1)} hours ago`;
  const stale = fresh(status, now) ? '' : '; older than 48 hours, so ci-gate shows none of it at a failure';
  const rows = Object.keys(status.gates).sort().map((gate) => {
    const g = status.gates[gate];
    return [gate, String(g.result), String(g.commit).slice(0, 7), minute(String(g.at)), `run ${g.run}${g.attempt > 1 ? ` attempt ${g.attempt}` : ''}`];
  });
  return [`${repo} on ${branch}, as of ${minute(status.as_of)} (${hours}${stale}):`, ...pad(rows), ...knownReport(known, dayOf(now))];
}

function stateOf(e, today) {
  if (today > e.review_by) return `expired ${e.review_by}`;
  const span = today < e.since ? `from ${e.since}, review by ${e.review_by}` : `in force, review by ${e.review_by}`;
  return e.keep ? `keep, ${span}` : span;
}

// `ci-gate known list`, and the tail of `ci-gate status`: every entry of known.json with its state today.
export function knownReport(entries, today) {
  if (entries.length === 0) return ['Known entries: none.'];
  const lines = [`Known entries (${entries.length}):`];
  for (const e of entries) {
    lines.push(`  ${e.id}  ${e.gate}  ${stateOf(e, today)}  (by ${e.by}, since ${e.since})`);
    if (e.case) lines.push(`      case: ${oneLine(e.case)}`);
    lines.push(`      reason: ${oneLine(e.reason)}`);
  }
  return lines;
}

// known.json of one repository as addKnown reads and writes it: a write names the blob it read, and the contents API's
// refusal of a stale blob (409; 422 when another writer created the file first) is a KnownConflict.
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
        if (e instanceof GitHubError && (e.status === 409 || e.status === 422)) throw new KnownConflict();
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
    if (!store) throw new LedgerError(`CI_KIT_STORE is OWNER/NAME@BRANCH, not ${env.CI_KIT_STORE}`);
    const repo = opts.repo ?? resolveRemote('.', null).repo;
    const entry = ledgerEntry(repo);
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
