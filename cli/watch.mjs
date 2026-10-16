// Watches one run of the reusable workflow and turns its jobs into ci-gate's lines (spec I5).
// The gate jobs are the matrix of gates.yml, named after their gate; `plan` and `verdict` are the workflow's own.
import { formatDuration } from './naming.mjs';

const WAIT_AFTER_MS = 2 * 60 * 1000;
// The poll schedule (spec Decision Log, "ci-gate is a good citizen of the shared token"): every session on the human's
// account shares one REST budget of 5,000 requests an hour, so a poller backs off as a run ages and when the budget
// runs low.
const FAST_MS = 15_000;
const FAST_FOR_MS = 2 * 60 * 1000;
const SLOW_MS = 30_000;
const THROTTLED_MS = 60_000;
export const THROTTLE_BELOW = 500;
// A job not yet on a runner. Its started_at is no signal: GitHub sets it to created_at while the job is queued.
const QUEUED = ['queued', 'waiting', 'pending', 'requested'];
const GATE_RE = /^[a-z0-9][a-z0-9-]*$/;
const OWN_JOBS = ['plan', 'verdict'];

const lastSegment = (name) => name.split(' / ').at(-1);
// Finished jobs in the order they finished; unfinished ones after them, by id.
const doneAt = (job) => (job.completed_at ? Date.parse(job.completed_at) : Number.MAX_SAFE_INTEGER);
const seconds = (from, to) => (Date.parse(to) - Date.parse(from)) / 1000;

// The gate a job runs, or null for the workflow's own jobs and the matrix job that never expanded on an empty selection
// (the API lists it as "ci / matrix.gate.name").
export function gateOf(jobName) {
  const name = lastSegment(jobName);
  return GATE_RE.test(name) && !OWN_JOBS.includes(name) ? name : null;
}

const isPlan = (job) => lastSegment(job.name) === 'plan';

function outcome(conclusion) {
  if (conclusion === 'success' || conclusion === 'neutral') return 'PASS';
  if (conclusion === 'skipped') return 'SKIP';
  if (conclusion === 'cancelled') return 'CANCEL';
  return 'FAIL';
}

// The events the jobs show that have not been reported yet; `seen` remembers what was (gate → Set of 'wait'|'done').
export function jobEvents(jobs, seen, nowMs) {
  const events = [];
  const gateJobs = jobs
    .map((job) => ({ job, gate: gateOf(job.name) }))
    .filter((g) => g.gate !== null)
    .sort((a, b) => doneAt(a.job) - doneAt(b.job) || a.job.id - b.job.id);
  for (const { job, gate } of gateJobs) {
    const marks = seen.get(gate) ?? new Set();
    seen.set(gate, marks);
    if (job.status === 'completed') {
      if (marks.has('done')) continue;
      marks.add('done');
      const kind = outcome(job.conclusion);
      // A completed job's started_at is when a runner took it (a job cancelled while queued prints no duration).
      const took = job.started_at && job.completed_at ? seconds(job.started_at, job.completed_at) : 0;
      events.push({ kind, gate, job, seconds: took });
    } else if (QUEUED.includes(job.status) && !marks.has('wait')) {
      const queued = nowMs - Date.parse(job.created_at);
      if (queued >= WAIT_AFTER_MS) {
        marks.add('wait');
        events.push({ kind: 'WAIT', gate, job, seconds: queued / 1000 });
      }
    }
  }
  return events;
}

async function eventLine(event, onFail) {
  switch (event.kind) {
    case 'WAIT':
    case 'PASS':
      return `${event.kind} ${event.gate} ${formatDuration(event.seconds)}`;
    case 'FAIL':
      return `FAIL ${event.gate} ${formatDuration(event.seconds)} log=${await onFail(event.job, event.gate)}`;
    default:
      return `${event.kind} ${event.gate}`;
  }
}

function verdict(run, jobs, runUrl) {
  if (run.conclusion === 'startup_failure') {
    return { line: `ERROR the workflow run failed to start (is the caller's \`uses:\` ref valid?) ${runUrl}`, code: 2 };
  }
  const gates = jobs.filter((j) => gateOf(j.name) !== null);
  const failed = gates.filter((j) => ['FAIL', 'CANCEL'].includes(outcome(j.conclusion))).length;
  if (run.conclusion === 'success') return { line: `GREEN ${runUrl}`, code: 0 };
  if (run.conclusion === 'cancelled') return { line: `ERROR the run was cancelled ${runUrl}`, code: 2 };
  // RED is a verdict on the gates; a run that failed with no gate failing failed in the workflow itself.
  if (failed === 0) return { line: `ERROR the run failed though no gate did (${run.conclusion}) ${runUrl}`, code: 2 };
  return { line: `RED ${failed}/${gates.length} ${runUrl}`, code: 1 };
}

// How long to wait before the next poll: 15 s for the first 2 minutes of watching, 30 s after, and 60 s whenever the
// token's remaining budget (null until a response reports it) is below THROTTLE_BELOW.
export function pollInterval(elapsedMs, remaining) {
  if (remaining !== null && remaining < THROTTLE_BELOW) return THROTTLED_MS;
  return elapsedMs < FAST_FOR_MS ? FAST_MS : SLOW_MS;
}

// Polls until the run completes or its plan ends unsuccessfully. Returns the final line and the exit code.
//   gh: { getRun(repo, id), listJobs(repo, id), stats() → { remaining } }; emit(line): one stdout line;
//   onFail(job, gate) → the path of the failed gate's downloaded log; planError(job) → the plan's error message.
export async function watchRun({ gh, repo, runId, runUrl, emit, onFail, planError, now, sleep, maxUnreadable = 20 }) {
  const seen = new Map();
  const started = now();
  let throttled = false;
  let unreadable = 0;
  const wait = () => {
    const { remaining } = gh.stats();
    if (!throttled && remaining !== null && remaining < THROTTLE_BELOW) {
      throttled = true; // said once; the stretched poll itself lasts as long as the budget stays low
      emit(`THROTTLE remaining=${remaining}`);
    }
    return sleep(pollInterval(now() - started, remaining));
  };
  for (;;) {
    let run;
    let jobs;
    try {
      run = await gh.getRun(repo, runId);
      jobs = await gh.listJobs(repo, runId);
      unreadable = 0;
    } catch (e) {
      unreadable += 1;
      if (unreadable >= maxUnreadable) return { line: `ERROR run ${runId} cannot be read: ${e.message}`, code: 2 };
      await wait();
      continue;
    }
    for (const event of jobEvents(jobs, seen, now())) emit(await eventLine(event, onFail));

    const planJob = jobs.find(isPlan);
    if (planJob?.status === 'completed' && planJob.conclusion !== 'success') {
      return { line: `ERROR ${await planError(planJob)}`, code: 2 };
    }
    if (run.status === 'completed') return verdict(run, jobs, runUrl);
    await wait();
  }
}
