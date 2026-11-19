#!/usr/bin/env node
// The collector of the test history and the gate ledger (test history spec, Design "Collector"; gate ledger spec,
// "Reading GitHub cheaply and completely"):
//   node history/collect.mjs [--repo <alias>] --store <dir> [--limit <lines>] [--attempts <n>] [--pass <id>] [--mirrors <dir>]
// For each repo in history/repos.json (or the one named), one batch of two passes:
//   - the gate ledger's (history/ledger.mjs): every gate job's line, by its attempt's job listing, fetched once;
//   - for a repo with a reporting set (`jobs`), the per-test pass: every gate job's JUnit report into the store
//     directory: one run line per (run, attempt, job), the day's base and durations. A job a matrix shards, `<job> <k>/<n>`
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
import { createGitHub, ghToken, GitHubError, isRateLimited } from '../lib/github.mjs';
import { createAppTokens } from '../lib/github-app.mjs';
import { parseJUnit } from './junit.mjs';
import { previousRun, resolveTested, startedBefore } from './provenance.mjs';
import { buildBase, buildDurations, buildRunLine, jobSlug, lineArtifacts, lineKey, reportWithinJob, summarize } from './record.mjs';
import { collectLedger, createPacer, formatLedger, LIMITS } from './ledger.mjs';
import { openMirror } from './mirror.mjs';
import { dayOf, openStore } from './store.mjs';

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

// What an error may say in a public log: GitHub's status and path, or a message this kit wrote (they name runs,
// jobs and offsets only); any other error by its kind alone, and a system error's code (ENOSPC), since its message
// can quote the text it failed on (a JSON parse error does) or a path (a file the artifact unpacked).
const describe = (err) => {
  if (err instanceof GitHubError || /^(history|junit): /.test(err?.message ?? '')) return err.message;
  const kind = err?.name ?? 'Error';
  return /^E[A-Z0-9]+$/.test(err?.code ?? '') ? `${kind} ${err.code}` : kind;
};

// A copy that shares no string with its source. A string sliced from a report (an id, a message) keeps the whole
// report's text alive, so whatever outlives the report it came from is copied: a held line pinned its artifact's XML,
// and a backlog of such lines ran the heap out (2026-10-22 → 11-10).
const own = (value) => JSON.parse(JSON.stringify(value));

// One repo's pass. `jobs`: its reporting set, the job names that upload a report. `limit`: the most lines the pass
// builds, oldest first, so a backlog is taken in passes each durable on its own. → counts, `errors`, one line each,
// naming runs and jobs only, and `more`: whether work was left for another pass (none is claimed after a rate-limit
// error, which another pass would only repeat). A failed item writes nothing and is tried again by the next pass.
// `jobsOf(run, attempt)`: an attempt's job listing shared with the gate ledger's pass, which fetches each attempt's
// jobs once; `recentRuns`: the runs that pass closed attempts of in this batch, which the sweep (2.) reads instead of
// listing the last 3 days again. Without them the pass lists and fetches for itself.
export async function collectRepo({ gh, repo, alias = repo, jobs, root, now = Date.now(), readZip = readArtifact, limit = Infinity, jobsOf: sharedJobsOf = null, recentRuns = null }) {
  const counts = { artifacts: 0, lines: 0, present: 0, missing: 0, unparseable: 0, rejected: 0, relinked: 0, failures: 0, written: 0 };
  const errors = [];
  let limited = false;
  const failed = (what, err) => {
    limited ||= isRateLimited(err);
    errors.push(`${what}: ${describe(err)}`);
  };
  const store = openStore(root, alias);
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
      for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) {
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
    let base = store.base(day, name);
    if (!base && prov.selection === null) {
      base = own(buildBase(prov, summary));
      store.setBase(day, name, base);
    }
    // Selected reports are not whole-suite snapshots, even when a fallback happened to run every test.
    if (job.conclusion === 'success' && prov.selection === null) {
      const held = store.durations(day, name);
      const later = !held || held.completed < prov.completed || (held.completed === prov.completed && (held.run < prov.run || (held.run === prov.run && held.attempt < prov.attempt)));
      if (later) store.setDurations(day, name, own(buildDurations(prov, summary)));
    }
    return buildRunLine(prov, artifact, 'present', summary, base);
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
  return { counts, errors, more: (left || !sweep) && !limited };
}

export const formatCounts = (repo, c, errors) =>
  `${repo}: artifacts ${c.artifacts}, lines ${c.lines} (present ${c.present}, missing ${c.missing}, unparseable ${c.unparseable}, rejected ${c.rejected}), relinked ${c.relinked}, failures ${c.failures}, errors ${errors}, files written ${c.written}`;

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

const USAGE = 'history: usage: collect.mjs [--repo <alias>] --store <dir> [--limit <lines>] [--attempts <n>] [--pass <id>] [--mirrors <dir>]';
const whole = (flag, value, what) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`history: ${flag} takes a whole number of ${what}, 1 or more`);
  return n;
};

// --limit: per-test lines a batch builds; --attempts: attempts a batch of the gate ledger closes; --pass: the pass a
// batch belongs to (the workflow's run), so only its first batch lists; --mirrors: where the mirrors are kept. The
// workflow gives the last two as HISTORY_PASS and HISTORY_MIRRORS, which a collector from before them ignores.
export function parseArgs(argv) {
  const env = process.env;
  const opts = { repo: null, store: null, limit: Infinity, attempts: 300, pass: env.HISTORY_PASS || null, mirrors: env.HISTORY_MIRRORS || join(tmpdir(), 'ci-kit-mirrors') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo') opts.repo = argv[++i];
    else if (argv[i] === '--store') opts.store = argv[++i];
    else if (argv[i] === '--limit') opts.limit = whole('--limit', argv[++i], 'lines');
    else if (argv[i] === '--attempts') opts.attempts = whole('--attempts', argv[++i], 'attempts');
    else if (argv[i] === '--pass') opts.pass = argv[++i];
    else if (argv[i] === '--mirrors') opts.mirrors = argv[++i];
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
// which takes its jobs from the ledger's fetch. → { errors, more, wait }.
async function collectBoth({ entry, opts, pacer, now }) {
  const { repo, alias } = entry;
  const token = tokenFor(repo, entry.token);
  const gh = createGitHub(token);
  const memo = new Map();
  const jobsOf = (run, attempt) => {
    const k = `${run}/${attempt}`;
    if (!memo.has(k)) memo.set(k, gh.attemptJobs(repo, run, attempt));
    return memo.get(k);
  };
  const errors = [];
  let ledger = null;
  let result = { more: false, wait: null, closed: null };
  try {
    const mirror = openMirror({ dir: join(opts.mirrors, `${alias}.git`), repo, token: typeof token === 'function' ? await token(repo) : token });
    mirror.ensure();
    result = await collectLedger({ gh, repo, alias, entry, root: opts.store, mirror, jobsOf, pacer, pass: opts.pass, now, limit: opts.attempts });
    ledger = result.ledger;
    errors.push(...result.errors);
    console.log(formatLedger(repo, result.counts, result.errors.length));
  } catch (err) {
    errors.push(`ledger: ${describe(err)}`);
  }
  let more = result.more;
  if (entry.jobs && pacer.allows(entry.token, 10)) {
    const perTest = await collectRepo({ gh, repo, alias, jobs: entry.jobs, root: opts.store, now, limit: opts.limit, jobsOf, recentRuns: result.closed });
    errors.push(...perTest.errors);
    console.log(formatCounts(repo, perTest.counts, perTest.errors.length));
    more ||= perTest.more;
  }
  // The per-test pass's calls count toward the pass too.
  if (ledger) {
    pacer.settle(ledger.state);
    ledger.flush();
  }
  return { errors, more, wait: result.wait };
}

async function main(argv) {
  const opts = parseArgs(argv);
  const repos = JSON.parse(readFileSync(new URL('./repos.json', import.meta.url), 'utf8'));
  const chosen = selectRepos(repos, opts.repo);
  const now = Date.now();
  const pacer = createPacer({ pass: opts.pass });
  let failed = false;
  const results = [];
  for (const entry of chosen) {
    const r = await collectBoth({ entry, opts, pacer, now });
    for (const e of r.errors) console.error(`${entry.repo}: ${e}`);
    if (r.errors.length > 0) failed = true;
    results.push(r);
  }
  for (const kind of new Set(chosen.map((e) => e.token))) {
    console.log(`history: calls ${kind} ${pacer.passUsed(kind)} this pass of ${LIMITS[kind].pass}, ${pacer.hourUsed(kind)} in the hour of ${LIMITS[kind].hour}`);
  }
  // The workflow reads these: `more` to run another batch, `wait` to sleep before it (every repository with work
  // left is held by an hour's limit), the peak resident memory (maxRSS is in KiB) to watch it.
  console.log(`history: peak rss ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
  const waiting = results.filter((r) => r.more);
  if (waiting.length > 0) {
    if (waiting.every((r) => r.wait !== null)) console.log(`history: wait ${Math.min(...waiting.map((r) => r.wait))}`);
    console.log('history: more');
  }
  return failed ? 1 : 0;
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
