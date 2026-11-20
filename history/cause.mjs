// What a red gate attempt's record shows (gate ledger spec, "What a red gate attempt's record shows"): pure over the job
// lines of a window, with the mirror's path differences, the landings and the default branch's standing given by the
// caller. A cause is named for what the record shows, never for a conclusion: where it shows nothing the answer is
// `unattributed`, with the reason.
//   - `superseded`: the cancelled jobs (none at its time limit) of a run that was itself cancelled while a later run
//     existed for its ref or its change (MAWS's ci-gate makes a ref per commit; a later gate of the same change is its
//     newer push). Not a red.
//   - `cancelled`: an attempt whose every unsuccessful job was cancelled from outside (none failed, none reached its
//     time limit) with no such later run: someone stopped it, which shows nothing of the product. Not a red.
//   - Every other failed attempt: each unsuccessful job read as lost or failed, then the first rule that holds:
//     infra, rerun-green, test-only-diff, product-diff, unattributed.
// A copied attempt (every job carried over by a rerun) is no execution: it has no cause and is never a later green.
import { matchesAny } from '../plan/glob.mjs';
import { comparable, gateAttempts } from './jobs.mjs';
import { knownContext } from './known.mjs';

const dayOf = (iso) => iso.slice(0, 10);
const keyOf = (a) => JSON.stringify([a.run, a.attempt, a.gate, a.scope_key]);
const SETUPISH = new Set(['setup', 'lost']);

// Where a job stopped, read again from its failed step under the repository's setup_steps as they stand (a pattern
// added later applies to the lines already written).
export function phaseOfLine(l, entry) {
  if (l.phase === null || l.phase === 'lost' || !l.failed_step) return l.phase;
  if (entry.setup_steps.some((p) => new RegExp(p).test(l.failed_step))) return 'setup';
  return /^Post |^Complete job$/.test(l.failed_step) ? 'post' : 'test';
}

// The window's gate attempts, each with its job lines (`lines`), its key and `start` (when its own jobs began: a copy
// carries the earlier attempt's times), `superseded_by` (the later run that superseded it, or null) and `cancelled`
// (stopped from outside with no such later run: neither is a red or an observation). `created`:
// run id → its creation (attempts.json); a run without one is taken as created when its first job started.
export function analyze(lines, { created = {} } = {}) {
  const attempts = gateAttempts(lines);
  const byKey = new Map(attempts.map((a) => [keyOf(a), a]));
  for (const a of attempts) a.lines = [];
  for (const l of lines) if (l.kind === 'gate') byKey.get(keyOf(l))?.lines.push(l);
  const runs = new Map(); // run → { created, ref, change }
  for (const l of lines) {
    const r = runs.get(l.run) ?? runs.set(l.run, { created: created[l.run] ?? null, first: null, ref: l.ref, change: l.change }).get(l.run);
    if (l.attempt === 1 && l.started && (r.first === null || l.started < r.first)) r.first = l.started;
  }
  for (const r of runs.values()) r.created ??= r.first;
  for (const a of attempts) {
    a.key = keyOf(a);
    const fresh = a.lines.filter((l) => !l.copy).map((l) => l.started).filter(Boolean).sort();
    a.start = fresh[0] ?? a.started;
    a.run_created = runs.get(a.run)?.created ?? a.start;
  }
  // A later run for the same ref, or the same change, created before this attempt ended.
  const laterRuns = new Map(); // ref or change → [{ run, created }]
  for (const [run, r] of runs) {
    for (const k of [`ref:${r.ref}`, r.change ? `change:${r.change}` : null].filter(Boolean)) {
      (laterRuns.get(k) ?? laterRuns.set(k, []).get(k)).push({ run, created: r.created });
    }
  }
  for (const a of attempts) {
    a.superseded_by = null;
    a.cancelled = false;
    if (a.result !== 'failed' || a.copied || !unsuccessful(a).every(cancelledFromOutside)) continue;
    a.cancelled = true;
    if (a.run_conclusion !== 'cancelled' || typeof a.run !== 'number') continue;
    const mine = runs.get(a.run);
    const later = [`ref:${a.ref}`, a.change ? `change:${a.change}` : null]
      .filter(Boolean)
      .flatMap((k) => laterRuns.get(k) ?? [])
      .filter((r) => r.run !== a.run && r.created && mine.created && r.created > mine.created && r.created <= a.completed)
      .sort((x, y) => (x.created < y.created ? -1 : 1));
    a.superseded_by = later[0]?.run ?? null;
    if (a.superseded_by !== null) a.cancelled = false;
  }
  return { attempts, runs };
}

// A job cancelled from outside it (its run cancelled, by a newer run or by hand), apart from one that reached its time
// limit: GitHub concludes that `cancelled` too, but it ended on its own, which a deadlock in the product does.
const timeLimited = (l) => l.conclusion === 'timed_out' || l.annotations.includes('time-limit') || l.log_kinds.includes('time-limit');
const cancelledFromOutside = (l) => l.conclusion === 'cancelled' && !timeLimited(l);

// The unsuccessful jobs that speak for an attempt. A summary job's failure is dropped only where it restates a part's:
// a part failed (beside parts only cancelled, a failed summary is the attempt's own failure), and the summary did not
// reach its own time limit (that is its own failure, whatever its parts did).
function unsuccessful(a) {
  const bad = a.lines.filter((l) => l.conclusion !== null && l.conclusion !== 'success');
  if (!bad.some((l) => l.role !== 'summary' && !cancelledFromOutside(l))) return bad;
  return bad.filter((l) => l.role !== 'summary' || timeLimited(l));
}

// Whether the default branch held still from `from` to `to`, by its landing record (`{ since, events }`, events by
// time): a landing on each side of the interval, none inside it, and the one after moved the branch from where the one
// before left it. Anything less (no landing before, none yet after, a break, a record starting later, no record) does
// not show it unbroken: not known, so false. Only the default branch's landings are read: a pull request to another
// branch is compared against the default's (rare here, and rerun-green nominates nothing).
export function baseHeld(record, from, to) {
  if (!record || !from || !to || from < record.since) return false;
  let prev = null;
  for (const e of record.events) {
    if (e.at <= from) prev = e;
    else if (e.at <= to) return false;
    else return prev !== null && e.before === prev.after;
  }
  return false;
}

// Whether two attempts tested the same tree: two exact attempts of one tree; two pull request runs of one head while
// the default branch held still between them.
function sameTree(a, b, record) {
  if (a.basis === 'exact' && b.basis === 'exact') return a.tree !== null && a.tree === b.tree;
  if (a.basis !== 'pr-merge' || b.basis !== 'pr-merge' || a.head !== b.head) return false;
  return baseHeld(record, a.run_created, b.start);
}

// Whether a job's stop could be the platform's, to be corroborated by a later attempt: it stopped in setup, or with no
// step ended. Not a job cancelled before any runner took it (beside a job of its attempt that failed): that was
// cancelled, not lost. Not a job at its time limit unless the step it stopped in is setup: a time limit is an outcome,
// not a cause, and a deadlock in the product reaches it too.
const setupish = (l, phase) => SETUPISH.has(phase) && !(l.conclusion === 'cancelled' && !l.runner) && !(timeLimited(l) && phase !== 'setup');

// A lost job's reason: the platform said its runner was lost or the job never started (an annotation, or its log's
// runner line for a job that stopped with no step ended), or its stop is setup-ish and a later comparable attempt on
// the same exact tree got that job past that phase. `infra` is the cause that nominates, so only exact trees
// corroborate: two pull request runs of one head are one tree for rule 2 alone. `followers`: the attempts that began
// after this one's result was known.
function readJob(l, a, followers, entry) {
  const phase = phaseOfLine(l, entry);
  const out = { job_id: l.job_id, job: l.job, conclusion: l.conclusion, phase, lost: null, cancelled: cancelledFromOutside(l) };
  if (l.annotations.includes('runner-lost')) out.lost = 'annotation:runner-lost';
  else if (l.annotations.includes('not-started')) out.lost = 'annotation:not-started';
  else if (l.log_kinds.includes('not-started')) out.lost = 'log:not-started';
  else if (l.log_kinds.includes('runner-lost') && phase === 'lost') out.lost = 'log:runner-lost';
  if (out.lost || !setupish(l, phase)) return out;
  for (const b of followers) {
    if (a.basis !== 'exact' || b.basis !== 'exact' || a.tree === null || a.tree !== b.tree || !comparable(a, b)) continue;
    const past = b.lines.find((x) => x.job === l.job && !x.copy && (x.conclusion === 'success' || ['test', 'post'].includes(phaseOfLine(x, entry))));
    if (past) return { ...out, lost: 'corroborated', by: { run: b.run, attempt: b.attempt } };
  }
  return out;
}

// A pull request run's change: its pull request's number where the mirror's heads give one for its branch (`prOf`).
const changeOf = (a, prOf) => {
  if (a.basis !== 'pr-merge' || !a.change?.startsWith('branch:')) return a.change;
  const n = prOf(a.ref);
  return n ? `pr:${n}` : a.change;
};

// The cause lines of every failed attempt available on `from` or later. `paths(treeA, treeB)` → the paths between
// two trees (null when the mirror cannot read them); `record`: the default branch's landing record
// ({ since, events: [{ at, before, after }] by time }), null when there is no whole one; `standing(gate, at)`: the
// gate's latest observation on the default branch before `at` (landings.mjs), or null; `known`: known.json's entries; `casesOf(run, attempt, gate)`: the attempt's failing
// cases in the per-test record, or null.
export function deriveCauses({ analysis, entry, record, standing, known, casesOf, paths, prOf, from }) {
  const { attempts } = analysis;
  const executions = attempts.filter((a) => !a.copied).sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : x.key < y.key ? -1 : 1));
  // Each gate's executions by start. What followed an attempt is what began strictly after its result was known: an
  // attempt that overlapped it is no evidence about it, whichever began first.
  const byGate = new Map();
  for (const a of executions) (byGate.get(a.gate) ?? byGate.set(a.gate, []).get(a.gate)).push(a);
  const after = (a) => byGate.get(a.gate).filter((b) => b.start > a.available);
  const out = [];
  for (const a of executions) {
    if (a.result !== 'failed' || !a.available || dayOf(a.available) < from) continue;
    const head = {
      v: 1, run: a.run, attempt: a.attempt, gate: a.gate, scope: a.scope, scope_key: a.scope_key, workflow: a.workflow, event: a.event,
      ref: a.ref, change: changeOf(a, prOf), basis: a.basis, tree: a.tree, head: a.head, available: a.available, minutes: a.minutes, lanes: a.lanes,
    };
    if (a.superseded_by !== null) {
      out.push({ ...head, cause: 'superseded', why: null, evidence: { by_run: a.superseded_by }, context: {} });
      continue;
    }
    if (a.cancelled) {
      out.push({ ...head, cause: 'cancelled', why: null, evidence: { jobs: unsuccessful(a).map((l) => ({ job_id: l.job_id, job: l.job, conclusion: l.conclusion, phase: phaseOfLine(l, entry), started: Boolean(l.runner), minutes: l.minutes })) }, context: {} });
      continue;
    }
    const followers = after(a);
    const jobs = unsuccessful(a).map((l) => readJob(l, a, followers, entry));
    const evidence = { jobs };
    let cause = null;
    let why = null;
    if (jobs.every((j) => j.lost)) cause = 'infra';
    if (!cause) {
      const green = followers.find((b) => b.result === 'succeeded' && comparable(a, b) && sameTree(a, b, record));
      if (green) [cause, evidence.green] = ['rerun-green', { run: green.run, attempt: green.attempt }];
    }
    const inChange = a.change === null ? [] : followers.filter((b) => b.change === a.change);
    if (!cause && a.basis === 'exact' && a.change !== null) {
      const next = inChange.find((b) => b.result === 'succeeded' && b.basis === 'exact' && comparable(a, b));
      const diff = next && a.tree && next.tree ? paths(a.tree, next.tree) : null;
      if (diff) {
        const outside = diff.filter((p) => !matchesAny(p, entry.test_globs));
        cause = outside.length === 0 ? 'test-only-diff' : 'product-diff';
        evidence.green = { run: next.run, attempt: next.attempt, tree: next.tree, paths: diff.length, ...(outside.length ? { outside: outside.slice(0, 5) } : {}) };
      } else if (next) why = 'unreadable';
    }
    if (!cause) {
      cause = 'unattributed';
      if (jobs.every((j) => setupish(jobById(a, j), j.phase))) why = 'setup-uncorroborated';
      else if (a.basis === 'pr-merge') why = 'basis';
      else if (a.scope === 'unknown') why = 'incomparable';
      else if (a.change === null) why = 'no-change';
      else if (inChange.length > 0 && !inChange.some((b) => comparable(a, b))) why = 'incomparable';
      else why ??= 'no-later-green';
    }
    const context = {};
    const base = standing(a.gate, a.available);
    if (base?.result === 'failed') context.base_also_failed = { commit: base.commit, at: base.at, run: base.run };
    const k = known.length ? knownContext(known, { gate: a.gate, day: dayOf(a.available), cases: casesOf(a.run, a.attempt, a.gate) }) : [];
    if (k.length) context.known = k;
    out.push({ ...head, cause, why, evidence, context });
  }
  return out;
}

const jobById = (a, j) => a.lines.find((l) => l.job_id === j.job_id);
