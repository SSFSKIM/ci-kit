// The job VM's git watchdog. While a job container runs, the host looks at the container's git processes through its
// own /proc and kills a transfer that has stalled, so actions/checkout's own retry runs a fresh fetch instead of the job
// waiting out its limit. Each kill logs one diagnostic record (git-stall-record.mjs) saying how the transfer stalled.
//
// Why: a pool job's `git fetch --depth=1` has sat silent for a job's whole 30 minutes on one VM while its neighbours
// fetched in a second (5 sightings 2026-11-12..15, the last MAWS run 43681826487 on an image that carries
// GIT_ENV's low-speed bound). That bound lives in libcurl and sees neither a trickle above its 1,000 B/s floor nor a
// git-remote-https blocked in curl's write callback because git is blocked writing to disk; this sees both.
import { readFile as fsReadFile, readdir as fsReaddir, readlink as fsReadlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stallRecord, probeDisk } from './git-stall-record.mjs';
import { CACHE } from '../agent/docker.mjs';

export const TICK_MS = 20_000;
// Three times GIT_ENV's 60 s low-speed time: a transfer libcurl is still judging is not this watchdog's to end, and a
// git whose counters (any read or write syscall, any byte to or from disk) have not moved for three minutes is blocked.
export const STILL_MS = 180_000;
// A pool checkout fetch at depth 1 takes seconds (every neighbour of a stalled one fetched in under a second); five
// minutes is well past any healthy one, yet a stall caught there still costs the job a few minutes, not thirty.
// A trickle moves the counters, so only this bound catches it. It is checkout's shallow fetch alone: a full-history
// fetch or a job's own clone can be legitimately long, and a bytes-per-second floor would have to guess for those.
export const CHECKOUT_FETCH_WALL_MS = 300_000;

const GIT_COMMS = new Set(['git', 'git-remote-http']); // comm is cut at 15 characters: git-remote-https reads git-remote-http
const HELPERS = new Set(['git-remote-http', 'git-remote-https']);
// The commands that move data over the network; a git doing anything else (an idle `cat-file --batch` server, say) may
// rightly sit still for minutes.
const TRANSFERS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule']);
const CLK_TCK = 100; // USER_HZ, fixed at 100 on Linux x86-64 and arm64: /proc/<pid>/stat's starttime unit
const OPTIONS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

const basename = (path) => path.split('/').at(-1);

export function gitSubcommand(argv) {
  for (let i = 1; i < argv.length; i++) {
    if (OPTIONS_WITH_VALUE.has(argv[i])) i++;
    else if (!argv[i].startsWith('-')) return argv[i];
  }
  return null;
}

// actions/checkout's fetch, exactly as its git-command-manager builds it, and only at a depth.
export function isCheckoutFetch(argv) {
  return basename(argv[0]) === 'git' && argv[1] === '-c' && argv[2] === 'protocol.version=2' && argv[3] === 'fetch' &&
    argv.includes('--prune') && argv.includes('--no-recurse-submodules') && argv.includes('origin') &&
    argv.some((a) => /^--depth=\d+$/.test(a));
}

export function parseStat(text) {
  const close = text.lastIndexOf(')');
  const rest = text.slice(close + 2).split(' ');
  return { comm: text.slice(text.indexOf('(') + 1, close), state: rest[0], ppid: Number(rest[1]), start: Number(rest[19]) / CLK_TCK };
}

export function parseIo(text) {
  return Object.fromEntries(text.trim().split('\n').map((line) => line.split(': ')).map(([k, v]) => [k, Number(v)]));
}

const sameIo = (a, b) => Object.keys(b).every((k) => a[k] === b[k]);

// One container's watchdog; `tick` is driven by watchGitTransfers' timer, or directly by tests.
export function gitWatchdog(name, deps) {
  const { readFile, readdir, exec, kill, now, log } = deps;
  const tracks = new Map(); // `${pid}@${start}` → { argv, first: { at, io }, io, changedAt }
  const handled = new Set();
  let id, stopped = false, active, failed = false;

  const inContainer = async (pid) => (await readFile(`/proc/${pid}/cgroup`)).includes(id);

  async function members() {
    const table = new Map();
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try { table.set(Number(entry), parseStat(await readFile(`/proc/${entry}/stat`))); } catch { /* exited */ }
    }
    const found = new Map(), at = now();
    for (const [pid, p] of table) {
      if (!GIT_COMMS.has(p.comm) || p.state === 'Z') continue;
      const key = `${pid}@${p.start}`;
      try {
        if (!await inContainer(pid)) continue;
        // Read once, while the process is young: reading cmdline takes the process's mmap lock, which a process
        // stalled in a page fault can hold.
        const argv = tracks.get(key)?.argv ?? (await readFile(`/proc/${pid}/cmdline`)).split('\0').filter(Boolean);
        const name = basename(argv[0] ?? '');
        if (name !== 'git' && !HELPERS.has(name)) continue;
        const io = parseIo(await readFile(`/proc/${pid}/io`));
        let track = tracks.get(key);
        if (!track) track = { argv, first: { at, io }, io, changedAt: at };
        else if (!sameIo(track.io, io)) Object.assign(track, { io, changedAt: at });
        const helper = HELPERS.has(name);
        const label = helper ? name : `git ${gitSubcommand(argv) ?? ''}`.trim();
        found.set(pid, { pid, key, ...p, argv, name, helper, label, track });
      } catch { /* exited between reads */ }
    }
    const seen = new Set([...found.values()].map((m) => m.key));
    for (const key of tracks.keys()) if (!seen.has(key)) tracks.delete(key);
    for (const m of found.values()) tracks.set(m.key, m.track);
    for (const key of handled) if (!tracks.has(key)) handled.delete(key);
    const children = new Map();
    for (const [pid, p] of table) {
      if (!children.has(p.ppid)) children.set(p.ppid, []);
      children.get(p.ppid).push(pid);
    }
    return { found, children, at };
  }

  // A transfer is the tree of git processes under one root (a git whose parent is not one): checkout's fetch, its
  // git-remote-https, its index-pack.
  function verdict(root, group, children, at) {
    const age = at - root.start * 1000;
    if (isCheckoutFetch(root.argv) && age >= CHECKOUT_FETCH_WALL_MS) {
      return `checkout fetch running ${Math.round(age / 1000)} s (bound ${CHECKOUT_FETCH_WALL_MS / 1000} s)`;
    }
    if (!group.some((m) => m.helper) && !TRANSFERS.has(gitSubcommand(root.argv))) return null;
    // A git waiting on a hook, a credential helper or ssh is not stalled itself: what it waits on is not watched.
    if (group.some((m) => (children.get(m.pid) ?? []).some((c) => !group.some((g) => g.pid === c)))) return null;
    const still = Math.min(...group.map((m) => at - m.track.changedAt));
    return still >= STILL_MS ? `no io for ${Math.round(still / 1000)} s (window ${STILL_MS / 1000} s)` : null;
  }

  async function end(target, group, reason) {
    handled.add(target.key);
    const lines = await stallRecord({ container: name, target, group, reason, at: now() }, deps);
    if (stopped) return;
    let outcome = 'exited before the kill';
    try {
      const again = parseStat(await readFile(`/proc/${target.pid}/stat`));
      if (again.start === target.start && await inContainer(target.pid)) {
        kill(target.pid, 'SIGKILL');
        outcome = 'killed (SIGKILL)';
      }
    } catch { /* exited */ }
    const record = [...lines, `git watchdog ${target.pid}: ${outcome}`];
    for (const line of record) log(line);
    deps.onRecord?.(record);
  }

  async function check() {
    if (!id) {
      try {
        const out = (await exec('docker', ['inspect', '--format', '{{.Id}}', name], { timeout: 10_000 })).stdout.trim();
        if (/^[0-9a-f]{64}$/.test(out)) id = out;
      } catch { /* not created yet */ }
      if (!id) return;
    }
    const { found, children, at } = await members();
    const groups = new Map();
    for (const m of found.values()) {
      let root = m;
      while (found.has(root.ppid)) root = found.get(root.ppid);
      groups.set(root.pid, [...(groups.get(root.pid) ?? []), m]);
    }
    for (const [rootPid, group] of groups) {
      const reason = verdict(found.get(rootPid), group, children, at);
      if (!reason) continue;
      // The helper holds the connection: killing it fails the fetch the way a dropped connection would.
      const helpers = group.filter((m) => m.helper && !handled.has(m.key));
      const root = found.get(rootPid);
      for (const target of helpers.length ? helpers : handled.has(root.key) ? [] : [root]) {
        if (stopped) return;
        await end(target, group, reason);
      }
    }
  }

  return {
    async tick() {
      if (stopped || active) return;
      active = check().catch((error) => {
        if (!failed) log(`git watchdog: check failed: ${error.message}`);
        failed = true;
      }).finally(() => { active = undefined; });
      await active;
    },
    async stop() {
      stopped = true;
      await active;
    },
  };
}

const sh = promisify(execFile);
const host = {
  now: () => Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000,
  readFile: (path) => fsReadFile(path, 'utf8'),
  readdir: fsReaddir,
  readlink: fsReadlink,
  exec: sh,
  kill: (pid, signal) => process.kill(pid, signal),
  probeDisk: () => probeDisk(CACHE),
};

// Starts watching the named job container; the returned function stops it when the container has ended. Each record
// is logged, and handed to onRecord for a guest whose console does not outlive it (EC2's exit report).
export function watchGitTransfers(name, { log = console.log, onRecord } = {}) {
  const watchdog = gitWatchdog(name, { ...host, log, onRecord });
  const timer = setInterval(() => { watchdog.tick(); }, TICK_MS);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await watchdog.stop();
  };
}
