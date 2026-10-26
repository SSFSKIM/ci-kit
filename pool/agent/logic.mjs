// Shared queue filter for the ephemeral-VM launcher.
export function queuedPoolJobs(jobs) {
  return jobs.filter((j) => j.status === 'queued' && j.labels.includes('ci-kit-pool'));
}
