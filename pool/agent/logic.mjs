// The pool agent's decisions (spec §3), as pure functions. Times are epoch milliseconds.
// agent.mjs gathers the observations (GitHub, Docker, Hetzner) and carries out what these return.

const SIZES = new Set([2, 4, 8, 16]);
const MIN = 60_000;
export const CONTAINER_MAX_AGE = 6 * 3600_000 + 15 * MIN;
export const RUNNER_GONE_GRACE = 5 * MIN;
export const HEARTBEAT_EVERY = 60_000;
export const WATCHDOG_STALE = 30 * MIN;
export const MAX_UPTIME = 24 * 3600_000;

// The size a job asks for: exactly one cpus-N label with N in 2, 4, 8, 16.
export function cpusOf(labels) {
  const sizes = labels.map((l) => /^cpus-(\d+)$/.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  return sizes.length === 1 && SIZES.has(sizes[0]) ? sizes[0] : null;
}

const labelSet = (labels) => [...labels].sort().join(',');
const keyOf = (repo, labels) => `${repo}|${labelSet(labels)}`;

export function parseCpuset(text) {
  return text.split(',').filter(Boolean).flatMap((part) => {
    const [a, b = a] = part.split('-').map(Number);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });
}

export function formatCpuset(cores) {
  const sorted = [...cores].sort((x, y) => x - y);
  const parts = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(',');
}

// n exclusive cores out of `total`, given those in use: an aligned contiguous block if one is free, else the
// lowest free cores, else null. There is no overcommit (spec §3 Job containers).
export function allocateCores(total, used, n) {
  if (n > total) return null;
  for (let start = 0; start + n <= total; start += n) {
    const block = Array.from({ length: n }, (_, i) => start + i);
    if (block.every((c) => !used.has(c))) return block;
  }
  const free = Array.from({ length: total }, (_, i) => i).filter((c) => !used.has(c));
  return free.length >= n ? free.slice(0, n) : null;
}

const created = (job) => Date.parse(job.created_at);

export function queuedPoolJobs(jobs) {
  return jobs.filter((j) => j.status === 'queued' && j.labels.includes('ci-kit-pool'));
}

// Which queued jobs get a container now (spec §3 Pool agent, steps 2–3).
// queued: queued pool jobs, each with its `repo`. idleRunners: [{repo, labels}] for runners this agent started
// that have not taken a job yet; each covers one queued job of the same repo and label set.
// First in, first out by creation time: a job that does not fit now holds the line, so a big job is not starved.
// A job this box can never serve (no valid size, or more cores than it has) is passed over and reported.
export function planStarts({ queued, idleRunners, totalCores, usedCores }) {
  const cover = new Map();
  for (const r of idleRunners) cover.set(keyOf(r.repo, r.labels), (cover.get(keyOf(r.repo, r.labels)) ?? 0) + 1);
  const used = new Set(usedCores);
  const starts = [];
  const waiting = [];
  const unservable = [];
  const ordered = [...queued].sort((a, b) => created(a) - created(b) || a.id - b.id);
  for (const job of ordered) {
    const key = keyOf(job.repo, job.labels);
    if ((cover.get(key) ?? 0) > 0) {
      cover.set(key, cover.get(key) - 1);
      continue;
    }
    const n = cpusOf(job.labels);
    if (n === null) {
      unservable.push({ job, reason: 'no cpus-N label (N in 2, 4, 8, 16)' });
      continue;
    }
    if (n > totalCores) {
      unservable.push({ job, reason: `needs ${n} cores; this box has ${totalCores}` });
      continue;
    }
    const cores = waiting.length ? null : allocateCores(totalCores, used, n);
    if (!cores) {
      waiting.push(job);
      continue;
    }
    cores.forEach((c) => used.add(c));
    starts.push({ job, cores });
  }
  return { starts, waiting, unservable };
}

// What to do with each job container (spec §3 Pool agent steps 4–5, Container deadline).
// containers: [{name, running, created, repo, runnerId}]; runners: Map repo → Map runner id → GitHub runner.
// memory: Map container name → {goneSince?, idleSince?, sawBusy?}, carried from tick to tick.
// Returns {actions: [{container, kind: 'remove'|'kill', reason, unregister}], memory}.
export function reviewContainers({ containers, runners, memory, now, cfg }) {
  const next = new Map();
  const actions = [];
  const idleLimit = cfg.idle_runner_minutes * MIN;
  for (const c of containers) {
    const runner = runners.get(c.repo)?.get(c.runnerId) ?? null;
    const unregister = runner !== null;
    if (!c.running) {
      actions.push({ container: c, kind: 'remove', reason: 'exited', unregister: unregister && !runner.busy });
      continue;
    }
    if (now - c.created >= CONTAINER_MAX_AGE) {
      actions.push({ container: c, kind: 'kill', reason: 'max-age', unregister });
      continue;
    }
    const seen = { ...(memory.get(c.name) ?? {}) };
    if (!runner) {
      seen.goneSince ??= now;
      if (now - seen.goneSince >= RUNNER_GONE_GRACE) {
        actions.push({ container: c, kind: 'kill', reason: 'runner-gone', unregister: false });
        continue;
      }
    } else if (runner.busy) {
      seen.sawBusy = true;
      delete seen.idleSince;
    } else {
      seen.idleSince ??= seen.sawBusy ? now : c.created;
      if (now - seen.idleSince >= idleLimit) {
        actions.push({ container: c, kind: 'kill', reason: 'idle-runner', unregister: true });
        continue;
      }
    }
    next.set(c.name, seen);
  }
  return { actions, memory: next };
}

const fileOf = (path) => (path ?? '').split('@')[0].split('/').at(-1);

export function watchedRuns(runs, workflows) {
  return runs.filter((r) => (r.status === 'queued' || r.status === 'in_progress') && workflows.includes(fileOf(r.path)));
}

// The queued jobs this box could ever serve: a valid size no larger than the box. The others (a cpus-16 job on a
// smaller fallback box) wait in GitHub's queue and do not keep this box up.
export function servable(queued, totalCores) {
  return queued.filter((j) => {
    const n = cpusOf(j.labels);
    return n !== null && n <= totalCores;
  });
}

// Idle (spec §3): no running job container, no queued pool job, no queued or in-progress watched run.
export function isIdle({ containers, queued, watched }) {
  return !containers.some((c) => c.running) && queued.length === 0 && watched.length === 0;
}

// Minutes into the current billed hour, counted from the server's created time.
export function billedMinute(createdMs, now) {
  return Math.floor(((now - createdMs) % 3600_000) / MIN);
}

// The lifecycle table of spec §3. Returns 'none' | 'ready' | 'drain' | 'undrain' | 'delete'.
export function lifecycleAction({ state, idle, minute, drainMinute }) {
  const late = minute >= drainMinute;
  if (state === 'booting') return 'ready';
  if (state === 'ready') return idle && late ? 'drain' : 'none';
  if (state === 'draining') {
    if (!idle) return 'undrain';
    // An hour that turned while draining is already paid for: the box stays up until its own minute 50.
    return late ? 'delete' : 'undrain';
  }
  return 'none';
}

// The heartbeat records a fully successful reconciliation (spec §3 Heartbeat), at most every 60 s.
export function heartbeatDue({ tickOk, lastBeat, now }) {
  return tickOk && (lastBeat === null || now - lastBeat >= HEARTBEAT_EVERY);
}

// The box-local dead-man switch (spec §3 Watchdog). lastSuccess: the last-success file's time, or null before
// the first; bootTime: when the kernel booted. Returns the ledger end reason, or null to leave the box alone.
export function watchdogVerdict({ server, lastSuccess, bootTime, now }) {
  if (server?.labels?.['ci-kit'] !== 'pool') return null;
  if (now - Date.parse(server.created) > MAX_UPTIME) return 'max-uptime';
  if (now - (lastSuccess ?? bootTime) >= WATCHDOG_STALE) return 'watchdog';
  return null;
}

export const runnerName = (serverId, counter) => `ci-kit-pool-${serverId}-${counter}`;

// The next runner counter: past the server's `ci-kit-jobs` label and every runner name already in use.
export function nextCounter(serverId, { label, names }) {
  const prefix = `ci-kit-pool-${serverId}-`;
  const used = names
    .filter((n) => n.startsWith(prefix))
    .map((n) => n.slice(prefix.length))
    .filter((s) => /^\d+$/.test(s))
    .map(Number);
  return Math.max(Number(label) || 0, ...used) + 1;
}
