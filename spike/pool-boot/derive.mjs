// The box's probe values from a job log, and the intervals the spec asks for
// (seconds, from POST /servers unless named).
const KEYS = ['job_step_start', 'nproc', 'getconf_nprocessors_onln', 'node_availableParallelism', 'node_cpus_length',
  'cpuset', 'memory_max', 'host_btime', 'spike_btime', 'spike_svc_start', 'spike_md_ok', 'spike_docker_run'];

export function derive(r, logText) {
  const box = {};
  // Probe output lines are "<timestamp>Z key=value ..."; the echoed script lines are not.
  for (const line of logText.split('\n')) {
    for (const m of line.replace(/^\S+Z /, '').matchAll(/(?:^|\s)([a-z_A-Z]+)=(\S*)/g)) {
      if (KEYS.includes(m[1]) && /^\S+Z [a-zA-Z_]+=/.test(line)) box[`box_${m[1]}`] ??= m[2];
    }
  }
  const all = { ...r, ...box };
  const sec = (a, b) => (a == null || b == null ? null : Math.round((b - a) * 10) / 10);
  const ts = (s) => (s ? Date.parse(s) / 1000 : null);
  const num = (s) => (s ? Number(s) : null);
  const ready = num(all.box_spike_svc_start);
  return {
    ...box,
    d: {
      post_to_running_seen: sec(r.t_post, r.t_running_seen),
      post_to_kernel_boot: sec(r.t_post, num(all.box_spike_btime ?? all.box_host_btime)),
      post_to_ready: sec(r.t_post, ready),
      ready_to_docker_run: sec(ready, num(all.box_spike_docker_run)),
      post_to_runner_online_seen: sec(r.t_post, r.t_runner_online_seen),
      ready_to_job_started: sec(ready, ts(r.job_started_at)),
      post_to_job_started: sec(r.t_post, ts(r.job_started_at)),
      post_to_job_step_start: sec(r.t_post, num(all.box_job_step_start)),
      job_started_to_completed: sec(ts(r.job_started_at), ts(r.job_completed_at)),
      dispatch_to_hosted_started: sec(ts(r.run_created_at), ts(r.hosted?.started_at)),
      hosted_duration: sec(ts(r.hosted?.started_at), ts(r.hosted?.completed_at)),
      server_life: sec(r.t_post, r.t_deleted),
    },
  };
}
