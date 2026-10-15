// Tabulate trial results: node summarize.mjs /tmp/ci-kit-m4/trial-*.json
import { readFileSync, existsSync } from 'node:fs';
import { derive } from './derive.mjs';

// Re-derived from each trial's saved job log, so a parser fix applies to old trials too.
const trials = process.argv.slice(2).map((f) => {
  const r = JSON.parse(readFileSync(f, 'utf8'));
  const logFile = f.replace(/\.json$/, '.log');
  return existsSync(logFile) ? { ...r, ...derive(r, readFileSync(logFile, 'utf8')) } : r;
});
const keys = [
  'post_to_running_seen', 'post_to_kernel_boot', 'post_to_ready', 'ready_to_docker_run',
  'post_to_runner_online_seen', 'ready_to_job_started', 'post_to_job_started', 'post_to_job_step_start',
  'job_started_to_completed', 'dispatch_to_hosted_started', 'hosted_duration', 'server_life',
];
console.log(['trial', 'size', 'nproc', 'getconf', 'availPar', 'cpuset', ...keys].join('\t'));
for (const r of trials) {
  console.log([r.trial, r.size ?? '', r.box_nproc, r.box_getconf_nprocessors_onln, r.box_node_availableParallelism,
    r.box_cpuset, ...keys.map((k) => r.d[k])].join('\t'));
}
// Nearest-rank p90; with three samples per group it is the maximum.
const p90 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.ceil(0.9 * s.length) - 1]; };
const groups = Object.groupBy(trials, (r) => r.trial.replace(/-\d+$/, ''));
for (const [g, rs] of Object.entries(groups)) {
  const xs = rs.map((r) => r.d.post_to_job_started);
  console.log(`${g}: n=${xs.length} post→started_at min=${Math.min(...xs)} median=${[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]} p90=${p90(xs)} s; +60 s = ${Math.round((p90(xs) + 60) / 6) / 10} min`);
}
