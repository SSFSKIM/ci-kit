// One cold-create trial: dispatch the sandbox's spike-pool workflow, mint a JIT
// runner config, create a server from the snapshot with it in user-data, and time
// POST /servers → the pool job's started_at. Deletes the server when the job ends.
// Usage: node trial.mjs <trial-name> <snapshot-id> [type] [location]
import { writeFileSync, mkdirSync } from 'node:fs';
import { hc, gh, ensureFirewall, sleep, now, iso, log } from './api.mjs';
import { derive } from './derive.mjs';

const REPO = 'SSFSKIM/ci-kit-sandbox';
const LABELS = ['self-hosted', 'ci-kit-pool', 'cpus-4'];
const [trial, snapshot, type = 'cpx62', location = 'hel1'] = process.argv.slice(2);
if (!trial || !snapshot) throw new Error('usage: trial.mjs <trial-name> <snapshot-id> [type] [location]');
const outDir = '/tmp/ci-kit-m4';
mkdirSync(outDir, { recursive: true });
const r = { trial, snapshot: Number(snapshot), type, location };
const t = (k) => { r[k] ??= now(); };

// 1. Queue the job first, so the runner has work the moment it connects.
const { server_types } = await hc('GET', '/server_types?name=cx53');
r.cx53_available = server_types[0].locations.filter((l) => l.available).map((l) => l.name);
r.t_dispatch = now();
await gh('POST', `/repos/${REPO}/actions/workflows/spike-pool.yml/dispatches`, { ref: 'main', inputs: { trial } });
let run, poolJob, hostedJob;
for (let i = 0; !poolJob; i++) {
  if (i > 60) throw new Error('dispatched run or its pool job never appeared');
  await sleep(2000);
  const { workflow_runs } = await gh('GET', `/repos/${REPO}/actions/workflows/spike-pool.yml/runs?event=workflow_dispatch&per_page=10`);
  run = workflow_runs.find((w) => w.display_title === `spike-pool ${trial}`);
  if (!run) continue;
  const { jobs } = await gh('GET', `/repos/${REPO}/actions/runs/${run.id}/jobs`);
  poolJob = jobs.find((j) => j.name === 'pool' && j.status === 'queued');
}
r.run_id = run.id;
r.run_url = run.html_url;
r.job_id = poolJob.id;
log(trial, 'run', run.id, 'pool job queued', poolJob.id);

// 2. A JIT config for exactly this job's labels; it travels only in user-data.
const jit = await gh('POST', `/repos/${REPO}/actions/runners/generate-jitconfig`, {
  name: `ci-kit-spike-${trial}`, runner_group_id: 1, labels: LABELS, work_folder: '_work',
});
r.runner_id = jit.runner.id;
const userData = `#cloud-config\n# ci-kit-jit: ${jit.encoded_jit_config}\n# ci-kit-cpus: 4\n`;
const fw = await ensureFirewall();

// 3. Cold create, then poll the three clocks: Hetzner, the runner, the job.
r.t_post = now();
const { server } = await hc('POST', '/servers', {
  name: `ci-kit-spike-${trial}`, server_type: type, location, image: Number(snapshot),
  labels: { 'ci-kit': 'spike', 'ci-kit-role': 'trial' }, firewalls: [{ firewall: fw }], user_data: userData,
});
r.t_post_returned = now();
r.server_id = server.id;
r.server_created = server.created;
log(trial, 'server', server.id, 'created', type, location);

let job;
try {
  for (;;) {
    const [{ server: s }, runner, j] = await Promise.all([
      hc('GET', `/servers/${server.id}`),
      gh('GET', `/repos/${REPO}/actions/runners/${r.runner_id}`).catch(() => null),
      gh('GET', `/repos/${REPO}/actions/jobs/${r.job_id}`),
    ]);
    job = j;
    if (s.status === 'running') t('t_running_seen');
    if (runner?.status === 'online') t('t_runner_online_seen');
    if (runner?.busy) t('t_runner_busy_seen');
    if (job.status === 'in_progress' || job.status === 'completed') t('t_job_in_progress_seen');
    if (job.status === 'completed') break;
    if (now() - r.t_post > 900) throw new Error('job did not finish within 15 min of POST /servers');
    await sleep(2000);
  }
} finally {
  await hc('DELETE', `/servers/${server.id}`).then(() => { r.t_deleted = now(); log(trial, 'server deleted'); })
    .catch((e) => log(trial, 'DELETE FAILED', e.message));
  await gh('DELETE', `/repos/${REPO}/actions/runners/${r.runner_id}`).catch(() => {});
}

// 4. GitHub's own clocks and the box's, from the job record and its log.
r.job_conclusion = job.conclusion;
r.job_created_at = job.created_at;
r.job_started_at = job.started_at;
r.job_completed_at = job.completed_at;
r.runner_name = job.runner_name;
const { jobs } = await gh('GET', `/repos/${REPO}/actions/runs/${run.id}/jobs`);
hostedJob = jobs.find((j) => j.name === 'hosted');
r.run_created_at = run.created_at;
r.hosted = hostedJob && { started_at: hostedJob.started_at, completed_at: hostedJob.completed_at, conclusion: hostedJob.conclusion };
const logText = await gh('GET', `/repos/${REPO}/actions/jobs/${r.job_id}/logs`).catch((e) => `log fetch failed: ${e.message}`);
writeFileSync(`${outDir}/trial-${trial}.log`, String(logText));
Object.assign(r, derive(r, String(logText)));
r.iso = { t_post: iso(r.t_post) };
writeFileSync(`${outDir}/trial-${trial}.json`, JSON.stringify(r, null, 2));
log(trial, JSON.stringify({ nproc: r.box_nproc, getconf: r.box_getconf_nprocessors_onln, avail: r.box_node_availableParallelism, cpuset: r.box_cpuset, ...r.d }));
