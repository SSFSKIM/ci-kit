// The janitor's process side: one ps listing, the rule that picks orphaned one-shot test processes, and the kill.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ps's etime is [[dd-]hh:]mm:ss; the result is seconds (NaN for anything else).
export function parseEtime(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!m) return NaN;
  const [, d = 0, h = 0, min, s] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s);
}

// BSD-style options without a dash work on macOS and procps alike; `ww` keeps command lines whole.
const PS_ARGS = ['axww', '-o', 'uid=,pid=,ppid=,etime=,rss=,command='];

export function parsePs(text) {
  const procs = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s(.*)$/.exec(line);
    if (!m) continue;
    const [, uid, pid, ppid, etime, rss, command] = m;
    procs.push({ uid: Number(uid), pid: Number(pid), ppid: Number(ppid), age: parseEtime(etime), rss: Number(rss), command: command.trim() });
  }
  return procs;
}

// Every process on the machine, in one ps call: the kill rule, the VM ages and the memory report all read it.
export async function listProcesses() {
  const { stdout } = await execFileAsync('ps', PS_ARGS, { maxBuffer: 64 * 1024 * 1024 });
  return parsePs(stdout);
}

function compileList(config, key) {
  const list = config[key];
  if (!Array.isArray(list)) throw new Error(`config: ${key} must be a list of regexes`);
  return list.map((source, i) => {
    try {
      return { source, re: new RegExp(source) };
    } catch (err) {
      throw new Error(`config: ${key}[${i}] ${JSON.stringify(source)} is not a valid regex (${err.message})`);
    }
  });
}

export function compileRules(config) {
  const patterns = compileList(config, 'patterns');
  if (patterns.length === 0) throw new Error('config: patterns must not be empty');
  const exclude = compileList(config, 'exclude');
  const hours = config.min_age_hours;
  if (typeof hours !== 'number' || !(hours >= 0)) throw new Error('config: min_age_hours must be a number >= 0');
  return { patterns, exclude, minAgeSeconds: hours * 3600 };
}

// A process qualifies when it is this user's, its parent is launchd, it is older than the minimum age, and its
// command line matches a pattern. An exclusion always wins: such a process is spared (reported, left running).
export function classify(procs, rules, { uid, selfPid }) {
  const kill = [];
  const spare = [];
  for (const p of procs) {
    if (p.uid !== uid || p.ppid !== 1 || p.pid === selfPid || !(p.age > rules.minAgeSeconds)) continue;
    const pattern = rules.patterns.find(({ re }) => re.test(p.command));
    if (!pattern) continue;
    const excludedBy = rules.exclude.find(({ re }) => re.test(p.command));
    if (excludedBy) spare.push({ ...p, pattern: pattern.source, excludedBy: excludedBy.source });
    else kill.push({ ...p, pattern: pattern.source });
  }
  return { kill, spare };
}

const exists = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// The listed pids that still run, as ps sees them now.
async function psSurvivors(pids) {
  if (pids.length === 0) return [];
  try {
    const { stdout } = await execFileAsync('ps', ['ww', '-o', 'uid=,pid=,ppid=,etime=,rss=,command=', '-p', pids.join(',')]);
    return parsePs(stdout);
  } catch (err) {
    // ps exits 1 when none of the pids exists.
    if (err.code === 1) return parsePs(err.stdout ?? '');
    throw err;
  }
}

// SIGTERM to every victim, then SIGKILL after the grace to those still running. A pid is SIGKILLed only while ps
// still shows it with the parent and command line it was chosen for, so a pid reused meanwhile is left alone.
// Each result is terminated (ended on SIGTERM), killed (SIGKILL), gone (ended before SIGTERM) or failed: <reason>.
export async function terminate(victims, { graceMs = 10_000, survivors = psSurvivors } = {}) {
  const results = victims.map((v) => ({ ...v, result: 'terminated' }));
  const pending = [];
  for (const r of results) {
    try {
      process.kill(r.pid, 'SIGTERM');
      pending.push(r);
    } catch (err) {
      r.result = err.code === 'ESRCH' ? 'gone' : `failed: ${err.code ?? err.message}`;
    }
  }
  const deadline = Date.now() + graceMs;
  while (pending.some((r) => exists(r.pid)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, graceMs)));
  }
  const left = pending.filter((r) => exists(r.pid));
  if (left.length === 0) return results;
  const now = new Map((await survivors(left.map((r) => r.pid))).map((p) => [p.pid, p]));
  for (const r of left) {
    const seen = now.get(r.pid);
    if (!seen || seen.ppid !== r.ppid || seen.command !== r.command) continue;
    try {
      process.kill(r.pid, 'SIGKILL');
      r.result = 'killed';
    } catch (err) {
      if (err.code !== 'ESRCH') r.result = `failed: ${err.code ?? err.message}`;
    }
  }
  return results;
}
