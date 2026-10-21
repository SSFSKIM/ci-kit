// Pre-launch (spec 2026-10-21 M5): when a served repo's run begins, the launcher launches the VMs its pool jobs will
// ask for before those jobs are queued, so the VMs boot while the run's first job runs (MAWS's plan, on a hosted
// runner, ~15 s from queued to done; its gates are created when it ends). What to launch is the shape of the same
// workflow's recent runs in the ledger. Nothing new is kept: a pre-launched VM is an ordinary job VM (its runner covers
// any queued job of its repo and size, and the idle rule removes it if none comes), and its ledger row names the run it
// was launched for, which is what keeps a later tick, a second launcher or a redelivered event from launching for that
// run again.
import { largestMachineCpus } from './logic.mjs';

export const SHAPE_RUNS = 10;

const median = (sorted) => (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
const sameRepo = (a, b) => a.toLowerCase() === b.toLowerCase();

// A workflow's shape: size → how many VMs of that size its runs' pool jobs took, the median over its last SHAPE_RUNS
// runs (newest by run id) among the rows, rounded up (a VM too many idles out; one too few is a gate waiting for a boot).
// A run with no job of a size counts 0 for it. rows: ledger rows; a row counts through the job its VM ran
// (job.run, job.workflow), whichever run the VM was launched for. null when the rows hold none of its runs.
export function runShape(rows, repo, workflow) {
  const runs = new Map(); // run id → Map size → VMs
  for (const r of rows) {
    if (!r.job?.run || r.job.workflow !== workflow || !sameRepo(r.repo, repo)) continue;
    const sizes = runs.get(r.job.run) ?? runs.set(r.job.run, new Map()).get(r.job.run);
    sizes.set(r.cpus, (sizes.get(r.cpus) ?? 0) + 1);
  }
  if (!runs.size) return null;
  const recent = [...runs].sort(([a], [b]) => b - a).slice(0, SHAPE_RUNS).map(([, sizes]) => sizes);
  const shape = {};
  for (const size of new Set(recent.flatMap((sizes) => [...sizes.keys()]))) {
    const count = Math.ceil(median(recent.map((sizes) => sizes.get(size) ?? 0).sort((a, b) => a - b)));
    if (count > 0) shape[size] = count;
  }
  return shape;
}

// The VMs pre-launched for a run's attempt, by size: Map cpus → Set of groups, a group being a pre-launched allocation
// and the race of its slow insert (spec M6), which carries the same run and attempt in its demand. A group fills one
// slot while any of its rows made or may make a VM (not abandoned): an original abandoned after its race began leaves
// the slot to the race.
export function prelaunchedFor(rows, run) {
  const of = (r) => {
    if (r.prelaunch?.run === run.id && r.prelaunch.attempt === run.attempt) return r.alloc;
    if (r.race?.demand?.run === run.id && r.race.demand.attempt === run.attempt) return r.race.of;
    return null;
  };
  const out = new Map();
  for (const r of rows) {
    const group = of(r);
    if (!group || r.end === 'abandoned') continue;
    if (!out.has(r.cpus)) out.set(r.cpus, new Set());
    out.get(r.cpus).add(group);
  }
  return out;
}

const isPoolJob = (job) => job.labels.some((l) => l.toLowerCase() === 'ci-kit-pool');

// The VMs to launch now for runs that have begun: [{repo, cpus, prelaunch: {run, attempt, workflow}}].
// A run has begun and its pool jobs are still to come while none of its listed jobs is a pool job (queued, running or
// skipped) and none has ended: GitHub creates the jobs that need the first ones when those end, so a run whose first
// job ended with no pool job listed has none coming. Each such run gets its workflow's shape, less the VMs already
// pre-launched for it (prelaunchedFor: the rows naming its run and attempt, a race with its original as one, in any
// state but abandoned, which made no VM).
// runs: [{repo, id, path, attempt}] of the served repos, queued and in progress; jobs: their jobs (run_id, labels,
// status); rows: the ledger's; runners: Map repo → its runners, for the repos whose listing succeeded (no other repo
// gets anything); inflight and waiting: the vCPUs in flight after this tick's launches for queued jobs, and how many
// queued jobs wait (planLaunches). Queued jobs come first: nothing is pre-launched while one waits, and pre-launches go
// oldest run first, largest size first (a run waits for its slowest gate, and its long gates are the large ones), each
// reserving its largest machine as a launch does, until one does not fit.
export function planPrelaunches({ runs, jobs, rows, runners, inflight, waiting, cfg }) {
  if (waiting > 0) return [];
  const out = [];
  let reserved = inflight;
  for (const run of [...runs].sort((a, b) => a.id - b.id)) {
    if (!runners.has(run.repo)) continue;
    const own = jobs.filter((j) => j.run_id === run.id);
    if (own.some((j) => isPoolJob(j) || j.status === 'completed')) continue;
    const shape = runShape(rows, run.repo, run.path);
    if (!shape) continue;
    const done = new Map();
    for (const [cpus, groups] of prelaunchedFor(rows, run)) done.set(cpus, groups.size);
    const sizes = Object.keys(shape).map(Number).filter((cpus) => cfg.placements[0].machines[cpus]).sort((a, b) => b - a);
    for (const cpus of sizes) {
      for (let k = done.get(cpus) ?? 0; k < shape[cpus]; k += 1) {
        const need = largestMachineCpus(cpus, cfg);
        if (reserved + need > cfg.max_vcpus) return out;
        reserved += need;
        out.push({ repo: run.repo, cpus, prelaunch: { run: run.id, attempt: run.attempt, workflow: run.path } });
      }
    }
  }
  return out;
}
