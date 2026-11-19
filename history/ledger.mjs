// The gate ledger's collection pass (gate ledger spec, "Reading GitHub cheaply and completely" and M1): every gate
// workflow's runs listed by creation day, every (run, attempt) not yet closed read once by its attempt's job listing,
// and one job line per job written by completion day.
//   - Discovery once a pass: the pass's first batch lists the last 35 days, one request a day (a day of more than
//     1,000 runs is listed by the hour), and keeps the work it found, oldest first, in attempts.json; later batches of
//     the pass take from it without listing again. A run still in progress leaves its latest attempt open.
//   - Each attempt's jobs are fetched once, through `jobsOf`, which the per-test pass shares.
//   - Calls are counted per token (`createPacer`): no new work is taken past a pass's or an hour's limit.
// It never prints a commit message, a path or a log line: the counts and errors it returns name runs and jobs only.
import { isRateLimited } from '../lib/github.mjs';
import { copiedFrom, isCopy, jobLine, platformKind, runFacts } from './jobs.mjs';
import { producerOf } from './provenance.mjs';
import { dayOf, nextDay, openLedger } from './store.mjs';

const DAY = 86_400_000;
export const WINDOW_DAYS = 35; // reruns are possible for 30 days

// Calls a pass, and an hour, may make with each kind of token. The App's installation allows at least 5,000 an hour,
// shared with the pool's launcher; a run's GITHUB_TOKEN 1,000 an hour, shared by every repository read with it.
export const LIMITS = { app: { pass: 1500, hour: 2000 }, actions: { pass: 600, hour: 800 } };

const minute = (ms) => new Date(ms).toISOString().slice(0, 16);

// Counts each repository's calls by its token's kind, across the batches of a pass (the pass's calls) and across
// passes (the last hour's, by minute), both kept in the repository's attempts.json.
export function createPacer({ limits = LIMITS, pass = null, now = Date.now } = {}) {
  const clients = [];
  const live = (c) => c.gh.stats().requests - c.base;
  const of = (kind) => clients.filter((c) => c.kind === kind);
  const hourAgo = () => minute(now() - 60 * 60_000);
  const pacer = {
    add(kind, gh, state) {
      clients.push({ kind, gh, state, base: gh.stats().requests });
    },
    passUsed: (kind) => of(kind).reduce((t, c) => t + (pass !== null && c.state.pass?.id === pass ? c.state.pass.calls : 0) + live(c), 0),
    hourUsed: (kind) => of(kind).reduce((t, c) => t + Object.entries(c.state.calls ?? {}).filter(([m]) => m > hourAgo()).reduce((s, [, n]) => s + n, 0) + live(c), 0),
    allows: (kind, cost = 1) => pacer.passUsed(kind) + cost <= limits[kind].pass && pacer.hourUsed(kind) + cost <= limits[kind].hour,
    // Whether the pass's own limit is what stops the kind (then nothing more this pass), else seconds until the last
    // hour's calls fall under the hour's limit.
    passSpent: (kind, cost = 2) => pacer.passUsed(kind) + cost > limits[kind].pass,
    waitSeconds(kind) {
      const buckets = of(kind).flatMap((c) => Object.entries(c.state.calls ?? {})).filter(([m]) => m > hourAgo()).sort();
      let over = pacer.hourUsed(kind) - limits[kind].hour + 1;
      for (const [m, n] of buckets) {
        over -= n;
        if (over <= 0) return Math.max(60, Math.ceil((Date.parse(`${m}:00Z`) + 61 * 60_000 - now()) / 1000));
      }
      return 3600;
    },
    // Moves a client's calls into its state (before the state is flushed).
    settle(state) {
      for (const c of clients.filter((x) => x.state === state)) {
        const n = live(c);
        if (n === 0) continue;
        if (state.pass) state.pass.calls += n;
        const m = minute(now());
        state.calls = Object.fromEntries(Object.entries(state.calls ?? {}).filter(([k]) => k > hourAgo()));
        state.calls[m] = (state.calls[m] ?? 0) + n;
        c.base += n;
      }
    },
  };
  return pacer;
}

// A run as the queue keeps it: what the job lines need, the head's message cut to its subject and last paragraph
// (the trailers).
const slimMessage = (m) => {
  const paragraphs = (m ?? '').trim().split(/\n[ \t]*\n/);
  return paragraphs.length < 2 ? paragraphs[0] : `${paragraphs[0]}\n\n${paragraphs.at(-1)}`;
};
const slimRun = (r) => ({
  id: r.id, name: r.name, path: r.path, event: r.event, head_branch: r.head_branch, head_sha: r.head_sha,
  head_commit: r.head_commit ? { tree_id: r.head_commit.tree_id, message: slimMessage(r.head_commit.message) } : null,
  pull_requests: (r.pull_requests ?? []).map((p) => ({ number: p.number })),
  status: r.status, conclusion: r.conclusion, run_attempt: r.run_attempt, created_at: r.created_at,
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// GitHub's listing answers a heavy filtered page with a 502 now and then (2026-11-19, MAWS): a server error or a
// timeout is tried again after each of `delays`.
const transient = (err) => err?.status >= 500 || err?.name === 'TimeoutError' || err?.name === 'AbortError';
async function retried(fn, delays) {
  for (let i = 0; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!transient(err) || i >= delays.length) throw err;
      await pause(delays[i]);
    }
  }
}

// One UTC day's runs of a workflow by creation. A filtered listing stops at 1,000 results, so a day with more is
// listed hour by hour.
export async function listDay(gh, repo, workflow, day, { delays = [3000, 10000] } = {}) {
  const page = (created, n) => retried(() => gh.workflowRuns(repo, workflow, created, n), delays);
  const rest = async (created, first) => {
    const runs = [...first.workflow_runs];
    for (let n = 2; first.workflow_runs.length === 100 && runs.length < first.total_count; n += 1) {
      const body = await page(created, n);
      runs.push(...body.workflow_runs);
      if (body.workflow_runs.length < 100) break;
    }
    return runs;
  };
  const whole = `${day}T00:00:00Z..${day}T23:59:59Z`;
  const first = await page(whole, 1);
  if (first.total_count <= 1000) return rest(whole, first);
  const runs = [];
  for (let h = 0; h < 24; h += 1) {
    const hour = `${day}T${String(h).padStart(2, '0')}:00:00Z..${day}T${String(h).padStart(2, '0')}:59:59Z`;
    runs.push(...(await rest(hour, await page(hour, 1))));
  }
  return runs;
}

// What a pass's error may say in a public log: GitHub's status and path, or a message this kit wrote.
const describe = (err) => (err?.status || /^(history|junit): /.test(err?.message ?? '') ? err.message : err?.name ?? 'Error');

// One repository's batch of the pass. `mirror`: the repository's mirror (history/mirror.mjs). `jobsOf(run, attempt)`:
// the shared, cached job listing. → counts, `errors`, `more` (work left that this pass may still take), `wait` (seconds until the hour allows more, or null) and
// `closed` (the runs whose attempts this batch closed, for the per-test pass's sweep) and the `ledger`, whose state
// the caller settles and flushes again after the per-test pass's calls.
export async function collectLedger({ gh, repo, alias = repo, entry, root, mirror, jobsOf, pacer, pass = null, now = Date.now(), limit = 300, listDelays = [3000, 10000] }) {
  const started = Date.now();
  const ledger = openLedger(root, alias);
  const { state } = ledger;
  const kind = entry.token;
  pacer.add(kind, gh, state);
  const counts = { listed: 0, days: 0, closed: 0, lines: 0, queued: 0, pending: 0, open: 0 };
  const errors = [];
  let limited = false;
  const failed = (what, err) => {
    limited ||= isRateLimited(err);
    errors.push(`${what}: ${describe(err)}`);
  };
  const key = (run, attempt) => `${run}/${attempt}`;

  // 1. Discovery, once a pass: its first batch lists each day of the window; a day whose listing failed, or that the
  //    token's limits left, stays pending for a later batch of the pass. Each listed day's work joins the queue,
  //    oldest first; its runs join the index at once, so a day listed is never covered by an index that lacks them.
  if (pass === null || state.pass?.id !== pass) {
    const days = [];
    for (let d = dayOf(new Date(now - (WINDOW_DAYS - 1) * DAY).toISOString()); d <= dayOf(new Date(now).toISOString()); d = nextDay(d)) days.push(d);
    state.pass = { id: pass ?? `local-${now}`, listed_at: new Date(now).toISOString(), calls: 0, pending: days, queue: [] };
  }
  if (state.pass.pending.length > 0) {
    const queued = new Set(state.pass.queue.map((i) => key(i.run.id, i.attempt)));
    const still = [];
    for (const day of state.pass.pending) {
      if (!pacer.allows(kind, entry.workflows.length)) {
        still.push(day);
        continue;
      }
      try {
        const runs = (await Promise.all(entry.workflows.map((w) => listDay(gh, repo, w, day, { delays: listDelays })))).flat();
        for (const r of runs.map(slimRun)) {
          const held = (state.runs[r.id] ??= { day: dayOf(r.created_at), attempts: r.run_attempt, closed: [] });
          held.attempts = Math.max(held.attempts, r.run_attempt);
          for (let attempt = 1; attempt <= r.run_attempt; attempt += 1) {
            if (held.closed.includes(attempt) || queued.has(key(r.id, attempt))) continue;
            if (attempt === r.run_attempt && r.status !== 'completed') continue; // open: read again next pass
            state.pass.queue.push({ attempt, run: r });
            queued.add(key(r.id, attempt));
          }
        }
        state.listed[day] = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
        counts.days += 1;
        counts.listed += runs.length;
      } catch (err) {
        failed(`listing ${day}`, err);
        still.push(day);
      }
    }
    state.pass.pending = still;
    state.pass.queue.sort((a, b) => (a.run.created_at < b.run.created_at ? -1 : a.run.created_at > b.run.created_at ? 1 : a.run.id - b.run.id || a.attempt - b.attempt));
    if (still.length === 0) ledger.prune(dayOf(new Date(now - (WINDOW_DAYS + 5) * DAY).toISOString()));
  }

  // 2. The work: the queue's oldest attempts, up to `limit`, each taken while the token's limits allow it.
  const queue = state.pass.queue;
  const batch = queue.slice(0, limit);
  const listings = new Map(); // run/attempt → jobs
  const listingOf = async (run, attempt) => {
    if (!listings.has(key(run, attempt))) listings.set(key(run, attempt), await jobsOf(run, attempt));
    return listings.get(key(run, attempt));
  };

  // 3. The tested commits and tree keys, from the mirror: every exact head the batch names, fetched in one request. A
  //    head the mirror cannot get (GitHub no longer serves it by id) is read by the API, one call, and has no key.
  const exactEvent = (run) => run.event !== 'pull_request' && run.event !== 'pull_request_target';
  const present = mirror.fetch(batch.filter((i) => exactEvent(i.run)).map((i) => i.run.head_sha));
  const resolve = async (run) => {
    if (!exactEvent(run)) return { tested: null, treeKey: null };
    const ciGate = producerOf(run).producer !== 'other';
    const tree = run.head_commit?.tree_id ?? null;
    if (present.has(run.head_sha)) return { tested: ciGate ? mirror.parentOf(run.head_sha) : null, treeKey: tree && entry.path_policy ? mirror.treeKey(tree, entry.path_policy) : null };
    if (!ciGate) return { tested: null, treeKey: null };
    try {
      const head = await gh.gitCommit(repo, run.head_sha);
      return { tested: head.parents?.length === 1 ? head.parents[0].sha : null, treeKey: null };
    } catch (err) {
      if (err.status === 404 || err.status === 422) return { tested: null, treeKey: null };
      throw err;
    }
  };

  let refused = state.annotations === 'refused';
  const kindsOf = async (job) => {
    if (!refused) {
      try {
        return [...new Set((await gh.annotations(repo, job.id)).map((a) => platformKind(a.message)).filter(Boolean))];
      } catch (err) {
        if (err.status !== 403) throw err;
        refused = true; // a private repository: the endpoint needs Checks read, which the App does not have
        state.annotations = 'refused';
      }
    }
    try {
      // The platform's messages are in a log's last lines; nothing of the log is kept but the kinds matched.
      const tail = (await gh.jobLog(repo, job.id)).slice(-20_000).split('\n');
      return [...new Set(tail.map(platformKind).filter(Boolean))];
    } catch (err) {
      if (err.status === 404 || err.status === 410) return []; // a job with no log (a lost runner's, a refused one's)
      throw err;
    }
  };

  const closed = new Map();
  const done = new Set();
  for (const item of batch) {
    if (!pacer.allows(kind, 2)) break;
    const { run, attempt } = item;
    try {
      const jobs = await listingOf(run.id, attempt);
      if (jobs.some((j) => j.status !== 'completed')) continue; // the next pass takes it
      const conclusion = attempt < run.run_attempt ? (await gh.attemptRun(repo, run.id, attempt)).conclusion : null;
      const facts = runFacts(run, attempt, await resolve(run), entry, conclusion);
      const lines = [];
      for (const job of jobs) {
        if (job.conclusion === 'skipped') continue;
        let copied = null;
        if (isCopy(job)) {
          for (let k = attempt - 1; k >= 2; k -= 1) await listingOf(run.id, k);
          copied = copiedFrom(job.name, attempt, (k) => listings.get(key(run.id, k)) ?? null);
        }
        const unsuccessful = copied === null && !['success', 'neutral'].includes(job.conclusion);
        lines.push(jobLine(facts, job, { copied_from: copied, annotations: unsuccessful ? await kindsOf(job) : [] }, entry));
      }
      ledger.addJobLines(lines);
      const held = (state.runs[run.id] ??= { day: dayOf(run.created_at), attempts: run.run_attempt, closed: [] });
      held.closed = [...new Set([...held.closed, attempt])].sort((a, b) => a - b);
      done.add(item);
      closed.set(run.id, run);
      counts.closed += 1;
      counts.lines += lines.length;
    } catch (err) {
      failed(`run ${run.id} attempt ${attempt}`, err);
    }
  }
  state.pass.queue = queue.filter((i) => !done.has(i));
  counts.queued = state.pass.queue.length;
  counts.pending = state.pass.pending.length;
  counts.open = Object.values(state.runs).reduce((t, r) => t + r.attempts - r.closed.length, 0) - counts.queued; // still running
  pacer.settle(state);
  ledger.flush();
  counts.seconds = Math.round((Date.now() - started) / 1000);
  const more = state.pass.queue.length + state.pass.pending.length > 0 && !limited && !pacer.passSpent(kind);
  return { counts, errors, more, wait: more && !pacer.allows(kind, 2) ? pacer.waitSeconds(kind) : null, closed: [...closed.values()], ledger };
}

export const formatLedger = (repo, c, errors) =>
  `${repo}: ledger: listed ${c.listed} runs over ${c.days} days (${c.pending} days pending), attempts closed ${c.closed} (lines ${c.lines}), queued ${c.queued}, open ${c.open}, errors ${errors}, ${c.seconds} s`;
