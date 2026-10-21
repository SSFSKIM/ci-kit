#!/usr/bin/env node
// The test-history collector (test history spec, Design "Collector"):
//   node history/collect.mjs [--repo <owner/name>] --store <dir>
// For each repo in history/repos.json (or the one named), it records every gate job's JUnit report into the store
// directory: one run line per (run, attempt, job), the day's base and durations. It is idempotent by (run, attempt,
// job). Authentication is the ci-kit GitHub App's when CI_KIT_APP_ID and CI_KIT_APP_KEY are set, else gh's token.
// It prints one count line per repo and never a test's name, file or message: the repos it reads may be private.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGitHub, ghToken, GitHubError } from '../lib/github.mjs';
import { createAppTokens } from '../lib/github-app.mjs';
import { parseJUnit } from './junit.mjs';
import { previousRun, resolveTested } from './provenance.mjs';
import { buildBase, buildDurations, buildRunLine, jobSlug, lineKey, reportWithinJob, summarize } from './record.mjs';
import { dayOf, openStore } from './store.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ARTIFACT = /^test-results-(.+)-(\d+)$/;

// The upload step runs only when the job's test step ran (spec, Transport), so its having run is how a job without
// an artifact is told apart from one whose tests never started, or one from before the job uploaded at all.
const uploadRan = (job) => (job.steps ?? []).some((s) => /upload-artifact/i.test(s.name) && (s.conclusion === 'success' || s.conclusion === 'failure'));

// An attempt that re-ran only the failed jobs lists the others too, copied from the earlier attempt with their
// times and steps: such a job completed before it was created in this attempt, and it ran nothing here.
const carriedOver = (job) => Boolean(job.created_at) && job.completed_at < job.created_at;

// An artifact's XML files, in path order, unpacked with the system unzip into a temp dir removed afterwards.
export function readArtifact(zip) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-kit-history-'));
  try {
    writeFileSync(join(dir, 'a.zip'), zip);
    execFileSync('unzip', ['-qq', '-o', join(dir, 'a.zip'), '-d', join(dir, 'x')], { stdio: 'ignore' });
    return readdirSync(join(dir, 'x'), { recursive: true })
      .filter((p) => p.endsWith('.xml'))
      .sort()
      .map((p) => readFileSync(join(dir, 'x', p), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// What an error may say in a public log: GitHub's status and path, or a message this kit wrote (they name runs,
// jobs and offsets only); any other error by its kind alone, since its message can quote the text it failed on (a
// JSON parse error does).
const describe = (err) =>
  err instanceof GitHubError || /^(history|junit): /.test(err?.message ?? '') ? err.message : (err?.name ?? 'Error');

// One repo's pass. `jobs`: its reporting set, the job names that upload a report. → counts, and `errors`, one
// line each, naming runs and jobs only. A failed item writes nothing and is tried again by the next pass.
export async function collectRepo({ gh, repo, jobs, root, now = Date.now(), readZip = readArtifact }) {
  const counts = { artifacts: 0, lines: 0, present: 0, missing: 0, unparseable: 0, rejected: 0, failures: 0, written: 0 };
  const errors = [];
  const store = openStore(root, repo, { now });
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
  const jobsOf = cached((id, attempt) => gh.attemptJobs(repo, id, attempt));
  const artifactsOf = cached((id) => gh.runArtifacts(repo, id));
  const testedOf = cached((id) => runOf(id).then((run) => resolveTested(gh, repo, run)));

  // 1. New artifacts, newest first, down to an hour before the newest one already stored (an upload that
  //    finished late has that long to be listed), or the 8 days an artifact can live.
  const items = new Map(); // lineKey → { run, attempt, job, artifact }
  const known = store.artifactIds();
  const cutoff = Math.max(now - 8 * DAY, store.newestArtifact() - HOUR);
  for (let page = 1; ; page += 1) {
    const { artifacts } = await gh.artifactsPage(repo, page);
    for (const a of artifacts) {
      const m = ARTIFACT.exec(a.name);
      const job = m && bySlug.get(m[1]);
      if (!job || a.expired || known.has(a.id)) continue;
      items.set(`${a.workflow_run.id}/${Number(m[2])}/${job}`, { run: a.workflow_run.id, attempt: Number(m[2]), job, artifact: a });
    }
    if (artifacts.length < 100 || artifacts.some((a) => Date.parse(a.created_at) < cutoff)) break;
  }

  // 2. The last 3 days' jobs in the reporting set that ran their tests and have no line: their artifact if the
  //    listing missed it, else a `missing` line.
  for (const run of await gh.runsCreatedSince(repo, new Date(now - 3 * DAY).toISOString())) {
    for (let attempt = 1; attempt <= run.run_attempt; attempt += 1) {
      let attemptJobs;
      try {
        attemptJobs = await jobsOf(run.id, attempt);
      } catch (err) {
        errors.push(`run ${run.id} attempt ${attempt}: ${describe(err)}`);
        continue;
      }
      for (const job of attemptJobs) {
        const key = `${run.id}/${attempt}/${job.name}`;
        if (!reporting.has(job.name) || job.status !== 'completed' || carriedOver(job) || !uploadRan(job)) continue;
        if (items.has(key) || store.line(key)) continue;
        try {
          const name = `test-results-${jobSlug(job.name)}-${attempt}`;
          const artifact = (await artifactsOf(run.id)).find((a) => a.name === name && !a.expired && !known.has(a.id)) ?? null;
          items.set(key, { run: run.id, attempt, job: job.name, artifact });
        } catch (err) {
          errors.push(`run ${run.id} attempt ${attempt} ${job.name}: ${describe(err)}`);
        }
      }
    }
  }

  // 3. Each item's run and job, in the order the jobs completed, so a day's base is its first report.
  const work = [];
  for (const item of items.values()) {
    try {
      const run = await runOf(item.run);
      const job = (await jobsOf(item.run, item.attempt)).find((j) => j.name === item.job);
      if (!job) throw new Error('history: the attempt has no job of that name');
      if (job.status !== 'completed') continue; // the next pass takes it
      work.push({ ...item, runInfo: run, jobInfo: job });
    } catch (err) {
      errors.push(`run ${item.run} attempt ${item.attempt} ${item.job}: ${describe(err)}`);
    }
  }
  const order = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  work.sort((a, b) => order(a.jobInfo.completed_at, b.jobInfo.completed_at) || a.run - b.run || a.attempt - b.attempt || order(a.job, b.job));

  // 4. One line per item.
  const fresh = [];
  for (const w of work) {
    try {
      fresh.push(await lineFor(w));
    } catch (err) {
      errors.push(`run ${w.run} attempt ${w.attempt} ${w.job}: ${describe(err)}`);
    }
  }

  async function lineFor({ runInfo: run, attempt, job: name, jobInfo: job, artifact }) {
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
    };
    if (!artifact) return buildRunLine(prov, null, 'missing');
    const zip = await gh.artifactZip(repo, artifact.id);
    let reports;
    try {
      reports = readZip(zip).map(parseJUnit);
      if (reports.length === 0) throw new Error('history: no XML report in the artifact');
    } catch (err) {
      // a machine without unzip is this pass's failure, not the artifact's
      if (err.code === 'ENOENT') throw new Error('history: the system unzip is not installed');
      return buildRunLine(prov, artifact, 'unparseable');
    }
    if (!reportWithinJob(reports, job)) return buildRunLine(prov, artifact, 'rejected');
    const summary = summarize(reports);
    const day = dayOf(job.completed_at);
    let base = store.base(day, name);
    if (!base) {
      base = buildBase(prov, summary);
      store.setBase(day, name, base);
    }
    if (job.conclusion === 'success') {
      const held = store.durations(day, name);
      const later = !held || held.completed < prov.completed || (held.completed === prov.completed && (held.run < prov.run || (held.run === prov.run && held.attempt < prov.attempt)));
      if (later) store.setDurations(day, name, buildDurations(prov, summary));
    }
    return buildRunLine(prov, artifact, 'present', summary, base);
  }

  // 5. Each new present line's previous run, from every line known: the store's and this pass's.
  const all = new Map(store.lines().map((l) => [lineKey(l), l]));
  for (const l of fresh) all.set(lineKey(l), l);
  const unlinked = new Set();
  for (const line of fresh) {
    try {
      line.previous = await previousRun(gh, repo, line, [...all.values()]);
    } catch (err) {
      errors.push(`run ${line.run} attempt ${line.attempt} ${line.job}: previous run: ${describe(err)}`);
      unlinked.add(line);
    }
  }

  for (const line of fresh) {
    if (unlinked.has(line)) continue;
    store.add(line);
    counts.lines += 1;
    counts[line.report] += 1;
    if (line.artifact) counts.artifacts += 1;
    counts.failures += line.failed?.length ?? 0;
  }
  counts.written = store.flush();
  return { counts, errors };
}

export const formatCounts = (repo, c, errors) =>
  `${repo}: artifacts ${c.artifacts}, lines ${c.lines} (present ${c.present}, missing ${c.missing}, unparseable ${c.unparseable}, rejected ${c.rejected}), failures ${c.failures}, errors ${errors}, files written ${c.written}`;

function tokenFor(repo) {
  const [owner, name] = repo.split('/');
  const appId = process.env.CI_KIT_APP_ID?.trim();
  const pem = process.env.CI_KIT_APP_KEY;
  if (appId && pem) {
    return createAppTokens({ appId, pem, owner, scope: { repositories: [name], permissions: { actions: 'read', contents: 'read' } } });
  }
  const token = ghToken();
  if (!token) throw new Error('history: no credentials: set CI_KIT_APP_ID and CI_KIT_APP_KEY, or log gh in');
  return token;
}

function parseArgs(argv) {
  const opts = { repo: null, store: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--repo') opts.repo = argv[++i];
    else if (argv[i] === '--store') opts.store = argv[++i];
    else throw new Error(`history: unknown argument ${argv[i]}`);
  }
  if (!opts.store) throw new Error('history: usage: collect.mjs [--repo <owner/name>] --store <dir>');
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const repos = JSON.parse(readFileSync(new URL('./repos.json', import.meta.url), 'utf8'));
  const chosen = opts.repo ? repos.filter((r) => r.repo === opts.repo) : repos;
  if (chosen.length === 0) throw new Error(`history: ${opts.repo} is not in history/repos.json`);
  let failed = false;
  for (const { repo, jobs } of chosen) {
    const { counts, errors } = await collectRepo({ gh: createGitHub(tokenFor(repo)), repo, jobs, root: opts.store });
    for (const e of errors) console.error(`${repo}: ${e}`);
    console.log(formatCounts(repo, counts, errors.length));
    if (errors.length > 0) failed = true;
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
