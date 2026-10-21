// The record's pure parts (test history spec, Design "Store"): case ids, a report's summary, a day's base and
// durations, a run line with its membership as a delta from the base, the reconstruction that checks it, and the
// idempotent merge of lines.
import { createHash } from 'node:crypto';

// A case id is [project, file, name]. A report can hold the same triple more than once (one test title written
// twice in a file); the nth such case, n ≥ 2, is [project, file, name, n], counted in report order, so a run's
// membership has as many ids as the report has cases.
export const idKey = (id) => JSON.stringify(id);

// Ids in their canonical order: by project, file and name (UTF-16 code units), then by number, the first case of a
// title (no number) being 1. Pairs of (project, file) sort the same way.
export function compareIds(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] === b[i]) continue;
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    return a[i] < b[i] ? -1 : 1;
  }
  return (a[3] ?? 1) - (b[3] ?? 1);
}

export const sortIds = (ids) => [...ids].sort(compareIds);

export function hashIds(sorted) {
  const h = createHash('sha256');
  for (const id of sorted) h.update(`${idKey(id)}\n`);
  return h.digest('hex');
}

// A file name for a job: its name with anything outside [A-Za-z0-9._-] as '-', the rule MAWS's artifact names follow
// (`unit:darwin` uploads `test-results-unit-darwin-<attempt>`).
export const jobSlug = (job) => job.replace(/[^A-Za-z0-9._-]/g, '-');

// The parsed reports of one artifact (one per XML file in it) → what a run line, a base and a durations snapshot
// hold. `files` is each (project, file)'s duration from its <testsuite time>, summed where a file has several suites.
export function summarize(reports) {
  const seen = new Map();
  const ids = [];
  const skipped = [];
  const failed = [];
  const projects = {};
  const files = new Map();
  let ms = 0;
  for (const { suites, cases } of reports) {
    for (const c of cases) {
      const triple = [c.project, c.file, c.name];
      const k = idKey(triple);
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      const id = n === 1 ? triple : [...triple, n];
      ids.push(id);
      const p = (projects[c.project] ??= { tests: 0, failed: 0, skipped: 0 });
      p.tests += 1;
      if (c.status === 'failed') {
        failed.push({ id, message: c.message ?? '' });
        p.failed += 1;
      } else if (c.status === 'skipped') {
        skipped.push(id);
        p.skipped += 1;
      }
    }
    for (const s of suites) {
      const k = idKey([s.project, s.file]);
      const f = files.get(k) ?? [s.project, s.file, 0];
      f[2] += s.ms;
      files.set(k, f);
      ms += s.ms;
    }
  }
  return {
    ids: sortIds(ids),
    skipped: sortIds(skipped),
    failed: failed.sort((a, b) => compareIds(a.id, b.id)),
    projects: Object.fromEntries(Object.keys(projects).sort().map((p) => [p, projects[p]])),
    files: [...files.values()].sort(compareIds),
    ms,
  };
}

// The report is this job's when every <testsuite timestamp> falls within the job's start and end, give or take a
// minute of clock skew between the runner and GitHub. A suite without a timestamp (node --test writes none) cannot
// be checked and does not count against the report.
export function reportWithinJob(reports, job, skewMs = 60_000) {
  const start = Date.parse(job.started_at) - skewMs;
  const end = Date.parse(job.completed_at) + skewMs;
  return reports.every(({ suites }) =>
    suites.every((s) => {
      if (s.timestamp === null) return true;
      const t = Date.parse(s.timestamp);
      return !Number.isFinite(t) || (t >= start && t <= end);
    }));
}

const source = (prov) => ({ run: prov.run, attempt: prov.attempt, job: prov.job, completed: prov.completed });

// A day's base for a job: the first complete report collected for the day. Every run line of that day and job
// records its membership against it.
export function buildBase(prov, summary) {
  return { ...source(prov), hash: hashIds(summary.ids), cases: summary.ids, skipped: summary.skipped, files: summary.files };
}

// The sampled cost M3 ranks by: (project, file) durations from one green report.
export function buildDurations(prov, summary) {
  return { ...source(prov), sampled: true, files: summary.files };
}

function delta(ids, baseIds) {
  const inBase = new Set(baseIds.map(idKey));
  const inRun = new Set(ids.map(idKey));
  return { added: ids.filter((id) => !inBase.has(idKey(id))), removed: baseIds.filter((id) => !inRun.has(idKey(id))) };
}

// One (run, attempt, job). `prov` is the provenance (collect.mjs builds it); `report` is 'present', 'missing',
// 'unparseable' or 'rejected'; `summary` and `base` are given for a present report only. `previous` starts null
// and is filled once every line of the pass is known (provenance.mjs, previousRun).
export function buildRunLine(prov, artifact, report, summary = null, base = null) {
  const line = {
    run: prov.run,
    attempt: prov.attempt,
    job: prov.job,
    workflow: prov.workflow,
    event: prov.event,
    headBranch: prov.headBranch,
    headSha: prov.headSha,
    tested: prov.tested,
    tree: prov.tree,
    producer: prov.producer,
    label: prov.label,
    gates: prov.gates,
    jobId: prov.jobId,
    runner: prov.runner,
    conclusion: prov.conclusion,
    started: prov.started,
    completed: prov.completed,
    artifact: artifact && { id: artifact.id, name: artifact.name, created: artifact.created_at },
    report,
    membership: null,
    failed: null,
    skipped: null,
    projects: null,
    ms: null,
    previous: null,
  };
  if (report !== 'present') return line;
  line.membership = { count: summary.ids.length, hash: hashIds(summary.ids), ...delta(summary.ids, base.cases) };
  line.failed = summary.failed;
  line.skipped = { count: summary.skipped.length, ...delta(summary.skipped, base.skipped) };
  line.projects = summary.projects;
  line.ms = summary.ms;
  return line;
}

function rebuild(baseIds, { added, removed }) {
  const gone = new Set(removed.map(idKey));
  return sortIds([...baseIds.filter((id) => !gone.has(idKey(id))), ...added]);
}

// A present line's full membership from its day's base, checked against the hash the line stored.
export function membershipOf(line, base) {
  const ids = rebuild(base.cases, line.membership);
  if (ids.length !== line.membership.count || hashIds(ids) !== line.membership.hash) {
    throw new Error(`history: run ${line.run} attempt ${line.attempt} ${line.job}: membership does not match its hash`);
  }
  return ids;
}

export function skippedOf(line, base) {
  const ids = rebuild(base.skipped, line.skipped);
  if (ids.length !== line.skipped.count) {
    throw new Error(`history: run ${line.run} attempt ${line.attempt} ${line.job}: skipped set does not match its count`);
  }
  return ids;
}

export const lineKey = (l) => `${l.run}/${l.attempt}/${l.job}`;

const lineOrder = (a, b) => a.run - b.run || a.attempt - b.attempt || (a.job < b.job ? -1 : a.job > b.job ? 1 : 0);

// Lines merged by (run, attempt, job), sorted by run, attempt and job. A line already held stays as it is, except
// that a `missing` line gives way to a line with a report.
export function mergeLines(existing, incoming) {
  const byKey = new Map(existing.map((l) => [lineKey(l), l]));
  for (const l of incoming) {
    const held = byKey.get(lineKey(l));
    if (!held || (held.report === 'missing' && l.report !== 'missing')) byKey.set(lineKey(l), l);
  }
  return [...byKey.values()].sort(lineOrder);
}
