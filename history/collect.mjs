#!/usr/bin/env node
// The collector of the test history and the gate ledger (test history spec, Design "Collector"; gate ledger spec,
// "Reading GitHub cheaply and completely"):
//   node history/collect.mjs [--repo <alias>] --store <dir> [--limit <lines>] [--attempts <n>] [--pass <id>] [--mirrors <dir>]
// For each repo in history/repos.json (or the one named), one batch of two passes:
//   - the gate ledger's (history/ledger.mjs): every gate job's line, by its attempt's job listing, fetched once;
//   - for a repo with a reporting set (`jobs`), the per-test pass: every gate job's JUnit report into the store
//     directory: one run line per (run, attempt, job), kept small (counts, hashes and failed cases: record.mjs), the
//     day's base and durations, from the last 35 days' lines. A job a matrix shards, `<job> <k>/<n>`
//     uploading `test-results-<slug>-<k>of<n>-<attempt>`, makes one line of `<job>` from all n shards of the attempt.
//     It is idempotent by (run, attempt, job), and takes its jobs from the ledger's fetch.
// Authentication is per repo (`token`): the ci-kit GitHub App's when CI_KIT_APP_ID and CI_KIT_APP_KEY are set, the
// run's GITHUB_TOKEN for a public repo the App is not installed on, else gh's token.
// It prints count lines and never a test's name, file or message, a commit message or a log line: the repos it reads
// may be private.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { BudgetSpent, createGitHub, ghToken, isRateLimited } from '../lib/github.mjs';
import { createAppTokens } from '../lib/github-app.mjs';
import { parseJUnit } from './junit.mjs';
import { previousRun, resolveTested, startedBefore } from './provenance.mjs';
import { buildBase, buildDurations, buildRunLine, jobSlug, lineArtifacts, lineKey, reportWithinJob, summarize } from './record.mjs';
import { describeError } from './errors.mjs';
import { collectLedger, createPacer, formatLedger, LIMITS, retried, WINDOW_DAYS } from './ledger.mjs';
import { openMirror } from './mirror.mjs';
import { dayOf, openLedger, openStore, rewriteRecord } from './store.mjs';

const DAY = 86_400_000;
const ARTIFACT = /^test-results-(.+)-(\d+)$/;
const SHARD_JOB = /^(.+) ([1-9]\d*)\/([1-9]\d*)$/;
const SHARD_SLUG = /^(.+)-([1-9]\d*)of([1-9]\d*)$/;

// A job's name → { job, n }: a job of the reporting set (n null), or one of its n shards, `<job> <k>/<n>`; else null.
const jobPart = (name, reporting) => {
  if (reporting.has(name)) return { job: name, n: null };
  const m = SHARD_JOB.exec(name);
  return m && reporting.has(m[1]) ? { job: m[1], n: Number(m[3]) } : null;
};

// An artifact's name → { job, k, n, attempt } likewise, by slug: `test-results-<slug>[-<k>of<n>]-<attempt>`.
const artifactPart = (name, bySlug) => {
  const m = ARTIFACT.exec(name);
  if (!m) return null;
  const attempt = Number(m[2]);
  if (bySlug.has(m[1])) return { job: bySlug.get(m[1]), k: null, n: null, attempt };
  const s = SHARD_SLUG.exec(m[1]);
  return s && bySlug.has(s[1]) ? { job: bySlug.get(s[1]), k: Number(s[2]), n: Number(s[3]), attempt } : null;
};

const mixedCounts = (forms) => new Error(`history: the attempt has the job in more than one shard count (${[...forms].map((n) => String(n ?? 'unsharded')).sort().join(', ')})`);

const artifactName = (job, attempt, k = null, n = null) => `test-results-${jobSlug(job)}${n === null ? '' : `-${k}of${n}`}-${attempt}`;

// Job conclusions, worst first; one not named here counts as worse than any of them.
const CONCLUSIONS = ['failure', 'timed_out', 'cancelled', 'action_required', 'stale', 'neutral', 'skipped', 'success'];
const worst = (conclusions) => conclusions.reduce((w, c) => (CONCLUSIONS.indexOf(c) < CONCLUSIONS.indexOf(w) ? c : w));

// An attempt's shards as the one job they make up: no id or runner of its own (the line holds each shard's), the
// earliest start, the latest completion and the worst conclusion.
const logicalJob = (shards) => ({
  id: null,
  runner_name: null,
  conclusion: worst(shards.map((j) => j.conclusion)),
  started_at: shards.map((j) => j.started_at).sort()[0],
  completed_at: shards.map((j) => j.completed_at).sort().at(-1),
});

// The upload step runs only when the job's test step ran (spec, Transport), so its having run is how a job without
// an artifact is told apart from one whose tests never started, or one from before the job uploaded at all.
const uploadRan = (job) => (job.steps ?? []).some((s) => /upload-artifact/i.test(s.name) && (s.conclusion === 'success' || s.conclusion === 'failure'));

// An attempt that re-ran only the failed jobs lists the others too, copied from the earlier attempt with their
// times and steps: such a job completed before it was created in this attempt, and it ran nothing here.
const carriedOver = (job) => Boolean(job.created_at) && job.completed_at < job.created_at;

// The artifact's own archive is at fault: unzip's statuses for a generic or severe format error, a file that is no
// zip, and an unexpected end of the archive.
const DEFECTIVE = new Set([2, 3, 9, 51]);
export class ArchiveDefect extends Error {
  constructor(status) {
    super(`history: unzip finds the archive defective (status ${status})`);
    this.name = 'ArchiveDefect';
  }
}

// An artifact's XML files, in path order, unpacked with the system unzip into a temp dir removed afterwards. Throws
// ArchiveDefect for a defective archive; any other failure (no unzip, a full disk, unzip killed) is the machine's.
export function readArtifact(zip) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-kit-history-'));
  try {
    const out = join(dir, 'x');
    mkdirSync(out); // an empty archive unpacks nothing
    writeFileSync(join(dir, 'a.zip'), zip);
    const r = spawnSync('unzip', ['-qq', '-o', join(dir, 'a.zip'), '-d', out], { stdio: 'ignore' });
    if (r.error?.code === 'ENOENT') throw new Error('history: the system unzip is not installed');
    if (r.error) throw r.error;
    if (r.signal) throw new Error(`history: unzip was killed by ${r.signal}`);
    if (DEFECTIVE.has(r.status)) throw new ArchiveDefect(r.status);
    if (r.status !== 0 && r.status !== 1) throw new Error(`history: unzip failed with status ${r.status}`); // 1: warnings only
    return readdirSync(out, { recursive: true })
      .filter((p) => p.endsWith('.xml'))
      .sort()
      .map((p) => readFileSync(join(out, p), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// What an error may say in a public log: history/errors.mjs.
const describe = describeError;

// A copy that shares no string with its source. A string sliced from a report (an id, a message) keeps the whole
// report's text alive, so whatever outlives the report it came from is copied: a held line pinned its artifact's XML,
// and a backlog of such lines ran the heap out (2026-10-22 → 11-10).
const own = (value) => JSON.parse(JSON.stringify(value));

// One repo's pass. `jobs`: its reporting set, the job names that upload a report. `limit`: the most lines the pass
// builds, oldest first, so a backlog is taken in passes each durable on its own. → counts, `errors`, one line each,
// naming runs and jobs only, and `more`: whether work was left for another pass (none is claimed after a rate-limit
// error, which another pass would only repeat). A failed item writes nothing and is tried again by the next pass.
// `jobsOf(run, attempt)`: an attempt's job listing shared with the gate ledger's pass, which fetches each attempt's
// jobs once; `recentRuns`: the last 3 days' runs the ledger knows ({ id, run_attempt, created_at, attempts: the
// attempts still to sweep }), which the sweep (2.) reads instead of listing them again. Without them the pass lists
// and fetches for itself. A request the caller's budget refused (BudgetSpent) stops nothing else and is no error: the
// pass claims more, as for a full batch.
export async function collectRepo({ gh, repo, alias = repo, jobs, root, now = Date.now(), readZip = readArtifact, limit = Infinity, jobsOf: sharedJobsOf = null, recentRuns = null }) {
  const counts = { artifacts: 0, lines: 0, present: 0, missing: 0, unparseable: 0, rejected: 0, relinked: 0, failures: 0, written: 0 };
  const errors = [];
  let limited = false;
  let paced = false;
  const failed = (what, err) => {
    if (err instanceof BudgetSpent) {
      paced = true;
      return;
    }
    limited ||= isRateLimited(err);
    errors.push(`${what}: ${describe(err)}`);
  };
  const store = openStore(root, alias, { now });
  const bySlug = new Map(jobs.map((j) => [jobSlug(j), j]));
  const reporting = new Set(jobs);

  const cached = (fn) => {
    const memo = new Map();
    return (...key) => {
      const k = key.join('/');
      if (!memo.has(k)) memo.set(k, fn(...key));
      return memo.get(k);
    };
  };
  const runOf = cached((id) => gh.getRun(repo, id));
  const jobsOf = sharedJobsOf ?? cached((id, attempt) => gh.attemptJobs(repo, id, attempt));
  const artifactsOf = cached((id) => gh.runArtifacts(repo, id));
  const testedOf = cached((id) => runOf(id).then((run) => resolveTested(gh, repo, run)));

  // 1. New artifacts, newest first, down to the 8 days an artifact can live (7, and a margin). Every pass lists
  //    them all, so an artifact a pass could not take (its job still running, its download failed) is listed
  //    again by the next, however many newer ones were stored meanwhile. A shard's artifact is found with the rest
  //    of its set (3.), and also takes again a later attempt of its run that copied the shard and is `missing` it.
  //    One naming another shard count than its attempt's recorded line is refused.
  const items = new Map(); // lineKey → { run, attempt, job, artifact }
  const known = store.artifactIds();
  const waiting = store.lines().filter((l) => l.report === 'missing' && l.shards);
  const cutoff = now - 8 * DAY;
  for (let page = 1; ; page += 1) {
    const { artifacts } = await gh.artifactsPage(repo, page);
    for (const a of artifacts) {
      const part = artifactPart(a.name, bySlug);
      if (!part || a.expired) continue;
      // A known artifact still takes again a waiting rerun that lacks it: the pass that recorded its own attempt may
      // have left the rerun past its batch.
      for (const l of waiting) {
        if (l.run !== a.workflow_run.id || l.job !== part.job || l.attempt <= part.attempt || l.shards[part.k - 1]?.attempt !== part.attempt) continue;
        if (l.shards[part.k - 1].artifact?.id === a.id) continue; // the line already holds this artifact
        if (!items.has(lineKey(l))) items.set(lineKey(l), { run: l.run, attempt: l.attempt, job: l.job, artifact: null, at: a.created_at });
      }
      if (known.has(a.id)) continue;
      const key = `${a.workflow_run.id}/${part.attempt}/${part.job}`;
      const held = store.line(key);
      if (held && held.report !== 'missing') { // a re-upload of a job already recorded
        const recorded = held.shards?.length ?? null;
        if (recorded !== part.n) errors.push(`run ${a.workflow_run.id} attempt ${part.attempt} ${part.job}: ${mixedCounts([recorded, part.n]).message}`);
        continue;
      }
      const item = items.get(key) ?? { run: a.workflow_run.id, attempt: part.attempt, job: part.job, artifact: null, at: a.created_at };
      if (part.n === null) item.artifact = a;
      if (a.created_at > item.at) item.at = a.created_at; // a shard set's latest upload
      items.set(key, item);
    }
    if (artifacts.length < 100 || artifacts.some((a) => Date.parse(a.created_at) < cutoff)) break;
  }

  // 2. The last 3 days' jobs in the reporting set that ran their tests and have no line: their artifact if the
  //    listing missed it, else a `missing` line. A shard that ran its tests brings in its job, whose set 3. gathers.
  //    It costs a request per run and attempt, so it runs after 3. has taken every listed item, in a pass whose
  //    batch is not yet full, and its items fill what is left of the batch.
  const sweepRecent = async () => {
    const swept = new Map();
    const since = new Date(now - 3 * DAY).toISOString();
    for (const run of recentRuns ? recentRuns.filter((r) => r.created_at >= since) : await gh.runsCreatedSince(repo, since)) {
      for (const attempt of run.attempts ?? Array.from({ length: run.run_attempt }, (_, i) => i + 1)) {
        let attemptJobs;
        try {
          attemptJobs = await jobsOf(run.id, attempt);
        } catch (err) {
          failed(`run ${run.id} attempt ${attempt}`, err);
          continue;
        }
        for (const job of attemptJobs) {
          const part = jobPart(job.name, reporting);
          if (!part || job.status !== 'completed' || carriedOver(job) || !uploadRan(job)) continue;
          const key = `${run.id}/${attempt}/${part.job}`;
          if (items.has(key) || swept.has(key) || store.line(key)) continue;
          if (part.n !== null) {
            swept.set(key, { run: run.id, attempt, job: part.job, artifact: null, at: job.completed_at });
            continue;
          }
          try {
            const name = artifactName(job.name, attempt);
            const artifact = (await artifactsOf(run.id)).find((a) => a.name === name && !a.expired && !known.has(a.id)) ?? null;
            swept.set(key, { run: run.id, attempt, job: job.name, artifact, at: job.completed_at });
          } catch (err) {
            failed(`run ${run.id} attempt ${attempt} ${job.name}`, err);
          }
        }
      }
    }
    return [...swept.values()];
  };

  // 3. Each item's run and job, in the order the jobs completed, so a day's base is its first unselected report.
  //    A sharded job is taken once all n shards of the attempt completed. A shard a re-run copied into the attempt
  //    (GitHub composes the attempt's verdict from the copy) is the job it copies: the shard in the latest earlier
  //    attempt where it is no copy, whose report is that attempt's artifact. A shard that did not run its tests
  //    leaves the attempt without a line, as an unsharded job that did not run its tests has none; any other
  //    attempt's artifact never stands in for a shard. An attempt whose jobs and unexpired artifacts in the run's own
  //    listing name more than one shard count (unsharded included) is refused.
  //    Items are taken oldest first (by upload, or completion when there is no artifact), up to `limit` lines: a
  //    line's previous run is found among the lines stored before it, and the day's base is its first report.
  //    An item that writes no line (a shard still running or that never ran its tests) does not count against it.
  const order = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const oldestFirst = (list) => list.sort((a, b) => order(a.at, b.at) || a.run - b.run || a.attempt - b.attempt || order(a.job, b.job));
  const work = [];
  let left = false; // items the batch had no room for
  const takeAll = async (queue) => {
    for (const item of queue) {
      if (work.length >= limit) {
        left = true;
        return;
      }
      await take(item);
    }
  };
  async function take(item) {
    try {
      const run = await runOf(item.run);
      const mine = (await jobsOf(item.run, item.attempt)).filter((j) => jobPart(j.name, reporting)?.job === item.job);
      const artifacts = await artifactsOf(item.run);
      const parts = artifacts.filter((a) => !a.expired).map((a) => artifactPart(a.name, bySlug)).filter((p) => p?.job === item.job && p.attempt === item.attempt);
      const forms = new Set([...mine.map((j) => jobPart(j.name, reporting).n), ...parts.map((p) => p.n)]);
      if (forms.size > 1) throw mixedCounts(forms);
      const [n] = forms;
      if (n === null) {
        const job = mine.find((j) => j.name === item.job);
        if (!job) throw new Error('history: the attempt has no job of that name');
        if (job.status !== 'completed') return; // the next pass takes it
        work.push({ ...item, runInfo: run, jobInfo: job, shards: null });
        return;
      }
      const shards = [];
      for (let k = 1; k <= n; k += 1) {
        const job = mine.find((j) => j.name === `${item.job} ${k}/${n}`);
        if (!job) throw new Error(`history: the attempt has no shard ${k} of ${n}`);
        shards.push(job);
      }
      if (shards.some((j) => j.status !== 'completed')) return; // the next pass takes it
      const ran = [];
      for (const shard of shards) {
        let [job, attempt] = [shard, item.attempt];
        while (job && carriedOver(job) && attempt > 1) {
          attempt -= 1;
          job = (await jobsOf(item.run, attempt)).find((j) => j.name === shard.name);
        }
        ran.push({ job, attempt });
      }
      if (ran.some(({ job }) => !job || carriedOver(job) || !uploadRan(job))) return;
      const set = ran.map(({ job, attempt }, i) => ({
        job,
        attempt,
        artifact: artifacts.find((a) => a.name === artifactName(item.job, attempt, i + 1, n) && !a.expired) ?? null,
      }));
      if (set.some((s) => !s.artifact) && store.line(lineKey(item))) return; // still short, and already `missing`
      work.push({ ...item, runInfo: run, jobInfo: logicalJob(set.map((s) => s.job)), shards: set });
    } catch (err) {
      failed(`run ${item.run} attempt ${item.attempt} ${item.job}`, err);
    }
  }
  await takeAll(oldestFirst([...items.values()]));
  const sweep = work.length < limit;
  if (sweep) await takeAll(oldestFirst(await sweepRecent()));
  work.sort((a, b) => order(a.jobInfo.completed_at, b.jobInfo.completed_at) || a.run - b.run || a.attempt - b.attempt || order(a.job, b.job));

  // 4. One line per item.
  const fresh = [];
  for (const w of work) {
    try {
      fresh.push(own(await lineFor(w)));
    } catch (err) {
      failed(`run ${w.run} attempt ${w.attempt} ${w.job}`, err);
    }
  }

  async function lineFor({ runInfo: run, attempt, job: name, jobInfo: job, artifact, shards }) {
    const prov = {
      run: run.id,
      attempt,
      job: name,
      workflow: run.path,
      event: run.event,
      headBranch: run.head_branch,
      headSha: run.head_sha,
      ...(await testedOf(run.id)),
      jobId: job.id,
      runner: job.runner_name || null,
      conclusion: job.conclusion,
      started: job.started_at,
      completed: job.completed_at,
      shards: shards && shards.map(({ job: j, attempt: at, artifact: a }) => ({
        job: j.name, attempt: at, jobId: j.id, runner: j.runner_name || null, conclusion: j.conclusion, started: j.started_at, completed: j.completed_at, artifact: a,
      })),
    };
    // The report is the union of the shards' reports, each one checked against the job that ran it; an absent
    // artifact makes the job's line `missing`, which gives way to the full set should the rest turn up.
    const parts = shards ?? [{ job, artifact }];
    if (parts.some((p) => !p.artifact)) return buildRunLine(prov, artifact, 'missing');
    // Only the artifact's own fault makes its report unparseable: a defective archive, one with no XML, XML the
    // parser rejects. Any other failure is the item's: it writes nothing, and the next pass tries it again.
    const read = [];
    for (const p of parts) {
      const zip = await gh.artifactZip(repo, p.artifact.id);
      let xml;
      try {
        xml = readZip(zip);
      } catch (err) {
        if (err instanceof ArchiveDefect) return buildRunLine(prov, artifact, 'unparseable');
        throw err;
      }
      if (xml.length === 0) return buildRunLine(prov, artifact, 'unparseable');
      try {
        read.push({ job: p.job, reports: xml.map(parseJUnit) });
      } catch (err) {
        if (/^junit: /.test(err?.message ?? '')) return buildRunLine(prov, artifact, 'unparseable');
        throw err;
      }
    }
    if (!read.every((r) => reportWithinJob(r.reports, r.job))) return buildRunLine(prov, artifact, 'rejected');
    const summary = summarize(read.flatMap((r) => r.reports));
    const day = dayOf(job.completed_at);
    // The day's base: the record against whose hashes its lines say a case passed (record.mjs caseOutcome).
    if (!store.base(day, name) && prov.selection === null) store.setBase(day, name, own(buildBase(prov, summary)));
    // Selected reports are not whole-suite snapshots, even when a fallback happened to run every test.
    if (job.conclusion === 'success' && prov.selection === null) {
      const held = store.durations(day, name);
      const later = !held || held.completed < prov.completed || (held.completed === prov.completed && (held.run < prov.run || (held.run === prov.run && held.attempt < prov.attempt)));
      if (later) store.setDurations(day, name, own(buildDurations(prov, summary)));
    }
    return buildRunLine(prov, artifact, 'present', summary);
  }

  // 5. Each new present line's previous run, from every line known: the store's and this pass's.
  const all = new Map(store.lines().map((l) => [lineKey(l), l]));
  for (const l of fresh) all.set(lineKey(l), l);
  const everyLine = [...all.values()];
  const unlinked = new Set();
  for (const line of fresh) {
    try {
      line.previous = await previousRun(gh, repo, line, everyLine);
    } catch (err) {
      failed(`run ${line.run} attempt ${line.attempt} ${line.job}: previous run`, err);
      unlinked.add(line);
    }
  }

  // 6. A run that arrives after a later run of its change was stored (it was still running, or its artifact not
  //    yet listed) can be that later run's previous: each stored present line of a change that a new present line
  //    started before is linked again, and replaced where its previous run changed. When that fails, the new lines
  //    before it are held back, so the next pass collects them and links it again.
  const change = (l) => JSON.stringify([l.job, l.producer, l.label]);
  const arrived = fresh.filter((l) => l.report === 'present' && l.label !== null && !unlinked.has(l));
  const relinked = [];
  for (const line of store.lines()) {
    if (line.report !== 'present' || line.label === null) continue;
    const earlier = arrived.filter((f) => change(f) === change(line) && startedBefore(f, line));
    if (earlier.length === 0) continue;
    try {
      const previous = await previousRun(gh, repo, line, everyLine);
      if (!isDeepStrictEqual(previous, line.previous)) relinked.push({ ...line, previous });
    } catch (err) {
      failed(`run ${line.run} attempt ${line.attempt} ${line.job}: previous run`, err);
      for (const f of earlier) unlinked.add(f);
    }
  }

  // 7. Before anything is written: a link may name only a present line this pass leaves on disk, one stored or a new
  //    one not held back (a held-back line's key may still hold its `missing` line). A new line naming any other is
  //    held back too, which can strand a line that names it, so this repeats until nothing changes. A relinked line
  //    naming one is dropped; the pass that takes the held-back line links it again.
  const names = (keys, l) => !l.previous || keys.has(lineKey({ ...l.previous, job: l.job }));
  let present;
  for (let changed = true; changed; ) {
    present = new Set([...store.lines(), ...fresh.filter((l) => !unlinked.has(l))].filter((l) => l.report === 'present').map(lineKey));
    changed = false;
    for (const line of fresh) {
      if (unlinked.has(line) || names(present, line)) continue;
      unlinked.add(line);
      changed = true;
    }
  }
  const replacing = relinked.filter((l) => names(present, l));

  for (const line of fresh) {
    if (unlinked.has(line)) continue;
    store.add(line);
    counts.lines += 1;
    counts[line.report] += 1;
    counts.artifacts += lineArtifacts(line).length;
    counts.failures += line.failed?.length ?? 0;
  }
  for (const line of replacing) store.replace(line);
  counts.relinked = replacing.length;
  counts.written = store.flush();
  return { counts, errors, more: (left || !sweep || paced) && !limited };
}

// The sweep's work, kept in the ledger's attempts.json so a run the ledger closed is swept even when the batch that
// closed it could not (its per-test batch full, paced, or failing): every run created in the last 3 days, with the
// attempts no clean sweep has covered yet. An open attempt is offered too, as the sweep always read a running
// attempt's finished jobs, and stays offered until it closes.
export function recentRuns(state, now) {
  const since = new Date(now - 3 * DAY).toISOString();
  return Object.entries(state.runs)
    .filter(([, r]) => r.created && r.created >= since)
    .map(([id, r]) => ({ id: Number(id), run_attempt: r.attempts, created_at: r.created, attempts: Array.from({ length: r.attempts }, (_, i) => i + 1).filter((a) => !(r.swept ?? []).includes(a)) }))
    .filter((r) => r.attempts.length > 0)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id));
}

// After a clean sweep of `offered` (no error, nothing left for another batch): its closed attempts need no other.
export function markSwept(state, offered) {
  for (const r of offered) {
    const held = state.runs[r.id];
    const done = r.attempts.filter((a) => held?.closed.includes(a));
    if (done.length) held.swept = [...new Set([...(held.swept ?? []), ...done])].sort((a, b) => a - b);
  }
}

export const formatCounts = (repo, c, errors) =>
  `${repo}: artifacts ${c.artifacts}, lines ${c.lines} (present ${c.present}, missing ${c.missing}, unparseable ${c.unparseable}, rejected ${c.rejected}), relinked ${c.relinked}, failures ${c.failures}, errors ${errors}, files written ${c.written}`;

// The one-time rewrite's line (store.mjs rewriteRecord), counts only.
export const formatRewrite = (repo, r) => `${repo}: the record rewritten small: ${r.rewritten} of ${r.lines} lines over ${r.days} days, ${r.unverified} without a hash`;

// A repository's token: the ci-kit App's, scoped to it and read-only, when CI_KIT_APP_ID and CI_KIT_APP_KEY are set;
// for a public repository the App is not installed on (`token: "actions"` in history/repos.json), the run's own
// GITHUB_TOKEN, which reads public data and grants nothing; else gh's.
export function tokenFor(repo, kind = 'app') {
  const name = repo.split('/')[1];
  const appId = process.env.CI_KIT_APP_ID?.trim();
  const pem = process.env.CI_KIT_APP_KEY;
  const actions = process.env.GITHUB_TOKEN?.trim();
  if (kind === 'actions' && actions) return actions;
  if (kind !== 'actions' && appId && pem) {
    return createAppTokens({ appId, pem, repo, scope: { repositories: [name], permissions: { actions: 'read', contents: 'read' } } });
  }
  const token = ghToken();
  if (!token) throw new Error('history: no credentials: set CI_KIT_APP_ID and CI_KIT_APP_KEY (or GITHUB_TOKEN for a repository read with it), or log gh in');
  return token;
}

const USAGE = 'history: usage: collect.mjs [--repo <alias>] --store <dir> [--limit <lines>] [--attempts <n>] [--pass <id>] [--mirrors <dir>] [--calls <n>]';
const whole = (flag, value, what) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`history: ${flag} takes a whole number of ${what}, 1 or more`);
  return n;
};

// --limit: per-test lines a batch builds; --attempts: attempts a batch of the gate ledger closes; --pass: the pass a
// batch belongs to (the workflow's run), so only its first batch lists; --mirrors: where the mirrors are kept. The
// workflow gives the last two as HISTORY_PASS and HISTORY_MIRRORS, which a collector from before them ignores.
// --calls (HISTORY_CALLS): the calls a pass may make with each kind of token, in place of the daily pass's (a
// backfill, the same pass over a longer backlog, is then held by the hour's limits alone).
export function parseArgs(argv) {
  const env = process.env;
  const opts = { repo: null, store: null, limit: Infinity, attempts: 300, pass: env.HISTORY_PASS || null, mirrors: env.HISTORY_MIRRORS || join(tmpdir(), 'ci-kit-mirrors'), calls: env.HISTORY_CALLS ? whole('HISTORY_CALLS', env.HISTORY_CALLS, 'calls') : null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo') opts.repo = argv[++i];
    else if (argv[i] === '--store') opts.store = argv[++i];
    else if (argv[i] === '--limit') opts.limit = whole('--limit', argv[++i], 'lines');
    else if (argv[i] === '--attempts') opts.attempts = whole('--attempts', argv[++i], 'attempts');
    else if (argv[i] === '--pass') opts.pass = argv[++i];
    else if (argv[i] === '--mirrors') opts.mirrors = argv[++i];
    else if (argv[i] === '--calls') opts.calls = whole('--calls', argv[++i], 'calls');
    else throw new Error(`history: unknown argument ${argv[i]}`);
  }
  if (!opts.store || opts.pass === undefined || opts.mirrors === undefined) throw new Error(USAGE);
  return opts;
}

// The alias is the store/CLI identity; repo is the current GitHub API identity.
export function selectRepos(repos, alias) {
  const named = repos.map(r => ({ ...r, alias: r.alias ?? r.repo }));
  const chosen = alias ? named.filter(r => r.alias === alias) : named;
  if (chosen.length === 0) throw new Error(`history: ${alias} is not in history/repos.json`);
  return chosen;
}

// One repository's batch: the gate ledger's pass, then the per-test pass (for a repository with a reporting set),
// which takes its jobs from the ledger's fetch. Every request of both goes through the pacer (`admit`). → { errors,
// more, wait }. A job listing answered with a server error is asked again after each of `delays`, as a listing day
// is: one 502 among a pass's hundreds of calls would otherwise fail the day's run. `deps`: the client, the mirror,
// the token and the delays, replaced in tests.
const DEPS = { createGitHub, openMirror, tokenFor, delays: [3000, 10000] };
async function collectBoth({ entry, opts, pacer, now, ledger: opened, deps }) {
  const { repo, alias } = entry;
  const kind = entry.token;
  const token = deps.tokenFor(repo, kind);
  const gh = deps.createGitHub(token, { admit: () => pacer.allows(kind, 1), onError: (err) => isRateLimited(err) && pacer.rateLimited(kind) });
  pacer.attach(kind, opened.state, gh);
  const memo = new Map();
  const jobsOf = (run, attempt) => {
    const k = `${run}/${attempt}`;
    if (!memo.has(k)) memo.set(k, retried(() => gh.attemptJobs(repo, run, attempt), deps.delays));
    return memo.get(k);
  };
  const errors = [];
  let ledger = null;
  let result = { more: false };
  try {
    const mirror = deps.openMirror({ dir: join(opts.mirrors, `${alias}.git`), repo, token: typeof token === 'function' ? await token(repo) : token });
    const cloneStarted = Date.now();
    mirror.ensure();
    console.error(`${repo}: mirror ready in ${Math.round((Date.now() - cloneStarted) / 1000)} s`);
    // Progress goes to stderr, which the workflow's log shows as it happens: counts and seconds only.
    const progress = (what) => console.error(`${repo}: ${what}`);
    result = await collectLedger({ gh, repo, alias, entry, root: opts.store, ledger: opened, mirror, jobsOf, pacer, pass: opts.pass, now, limit: opts.attempts, progress });
    ledger = result.ledger;
    errors.push(...result.errors);
    console.log(formatLedger(repo, result.counts, result.errors.length));
  } catch (err) {
    errors.push(`ledger: ${describe(err)}`);
  }
  let more = result.more;
  let held = null;
  let perTestClean = !entry.jobs;
  if (entry.jobs) {
    // The per-test pass starts with room for a few calls; held by the hour instead, it is work for a later batch.
    held = pacer.reason(kind, 10);
    if (held === 'hour') more = true;
    if (held === null) {
      const perTestStarted = Date.now();
      const offered = ledger ? recentRuns(ledger.state, now) : null;
      try {
        // The run lines of the old shape are rewritten small once, before a per-test pass reads any.
        const rewritten = rewriteRecord(opts.store, alias, now);
        if (rewritten?.days) console.log(formatRewrite(repo, rewritten));
        const perTest = await collectRepo({ gh, repo, alias, jobs: entry.jobs, root: opts.store, now, limit: opts.limit, jobsOf, recentRuns: offered });
        errors.push(...perTest.errors);
        console.log(formatCounts(repo, perTest.counts, perTest.errors.length));
        more ||= perTest.more;
        perTestClean = perTest.errors.length === 0 && !perTest.more;
        if (offered && perTestClean) markSwept(ledger.state, offered);
      } catch (err) {
        if (err instanceof BudgetSpent) more = true; // stopped by the budget before its first line: a later batch's
        else errors.push(`per-test: ${describe(err)}`);
      }
      console.error(`${repo}: per-test pass in ${Math.round((Date.now() - perTestStarted) / 1000)} s`);
    }
  }
  // The per-test pass's calls count toward the pass too.
  if (ledger) {
    pacer.settle(ledger.state);
    ledger.flush();
  }
  // A pass whose calls are spent, or whose token GitHub refused, ends; one held by the hour waits. The repository's
  // work is taken when its ledger's pass has nothing queued or pending and its per-test pass ended clean.
  const why = held === 'hour' ? 'hour' : pacer.reason(kind, 2);
  const taken = ledger !== null && ledger.state.pass.queue.length === 0 && ledger.state.pass.pending.length === 0 && perTestClean && why !== 'rate-limited';
  const covered = ledger && lastCovered(ledger, now);
  if (why === 'pass' || why === 'rate-limited') return { errors, more: false, wait: null, taken, covered };
  return { errors, more, wait: more && why === 'hour' ? pacer.waitSeconds(kind) : null, taken, covered };
}

// The latest day of the ledger's window that is covered (store.mjs covered), or null.
const lastCovered = (ledger, now) => {
  for (let t = now - DAY, i = 1; i < WINDOW_DAYS; t -= DAY, i += 1) {
    const day = dayOf(new Date(t).toISOString());
    if (ledger.covered(day)) return day;
  }
  return null;
};

// The collector's marker at the store's root (gate ledger spec, M2), which the sandbox's store guard reads: when a
// pass last ended with every repository's work taken, and each repository's last covered day. Only a batch over every
// repository writes it.
export const writeMarker = (root, at, results) => writeFileSync(join(root, 'collected.json'), `${JSON.stringify({ v: 1, at, repos: Object.fromEntries(results.map(([alias, r]) => [alias, { covered: r.covered }])) })}\n`);

// One batch over the chosen repositories, printing count lines, errors (naming runs, jobs and statuses only) and the
// lines the workflow reads. → the exit code.
export async function collectBatch({ chosen, opts, now = Date.now(), deps = DEPS }) {
  const base = deps.limits ?? LIMITS; // a test's smaller limits
  const limits = opts.calls === null ? base : Object.fromEntries(Object.entries(base).map(([k, l]) => [k, { ...l, pass: opts.calls }]));
  const started = Date.now();
  const pacer = createPacer({ pass: opts.pass, limits, now: () => now + (Date.now() - started) }); // the clock runs on from `now`
  // Every repository's calls this pass and hour count from the start, whichever comes first.
  const ledgers = new Map(chosen.map((e) => [e.alias, openLedger(opts.store, e.alias)]));
  for (const e of chosen) pacer.add(e.token, ledgers.get(e.alias).state);
  let failed = false;
  const results = [];
  for (const entry of chosen) {
    const r = await collectBoth({ entry, opts, pacer, now, ledger: ledgers.get(entry.alias), deps: { ...DEPS, ...deps } });
    for (const e of r.errors) console.error(`${entry.repo}: ${e}`);
    if (r.errors.length > 0) failed = true;
    results.push(r);
  }
  for (const kind of new Set(chosen.map((e) => e.token))) {
    console.log(`history: calls ${kind} ${pacer.passUsed(kind)} this pass of ${limits[kind].pass}, ${pacer.hourUsed(kind)} in the hour of ${limits[kind].hour}`);
  }
  // The workflow reads these: `more` to run another batch, `wait` to sleep before it (every repository with work
  // left is held by an hour's limit), the peak resident memory (maxRSS is in KiB) to watch it.
  console.log(`history: peak rss ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
  if (!opts.repo && results.every((r) => r.taken)) writeMarker(opts.store, new Date(now + (Date.now() - started)).toISOString(), chosen.map((e, i) => [e.alias, results[i]]));
  const waiting = results.filter((r) => r.more);
  if (waiting.length > 0) {
    if (waiting.every((r) => r.wait !== null)) console.log(`history: wait ${Math.min(...waiting.map((r) => r.wait))}`);
    console.log('history: more');
  }
  return failed ? 1 : 0;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const repos = JSON.parse(readFileSync(new URL('./repos.json', import.meta.url), 'utf8'));
  return collectBatch({ chosen: selectRepos(repos, opts.repo), opts });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`collect: ${describe(err)}`);
      process.exit(1);
    },
  );
}
