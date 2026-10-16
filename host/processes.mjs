// The janitor's process side: one ps listing, the rule that picks orphaned one-shot test processes, and the kill.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { identityOf } from '../mac/hooks/strays.mjs';
import { invocationOf } from './invocation.mjs';
import { terminate as sharedTerminate } from '../mac/hooks/terminate.mjs';

const execFileAsync = promisify(execFile);

// ps's etime is [[dd-]hh:]mm:ss; the result is seconds (NaN for anything else).
export function parseEtime(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!m) return NaN;
  const [, d = 0, h = 0, min, s] = m;
  return ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60 + Number(s);
}

// BSD-style options without a dash work on macOS and procps alike; `ww` keeps command lines whole. lstart is the
// start time, in one fixed format under the C locale: with the uid it is a process's birth identity.
const PS_COLUMNS = 'uid=,pid=,ppid=,etime=,rss=,lstart=,command=';
const PS_ENV = { ...process.env, LC_ALL: 'C' };
const LSTART = String.raw`\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}`;

export function parsePs(text) {
  const row = new RegExp(String.raw`^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(${LSTART})\s(.*)$`);
  const procs = [];
  for (const line of text.split('\n')) {
    const m = row.exec(line);
    if (!m) continue;
    const [, uid, pid, ppid, etime, rss, started, command] = m;
    procs.push({ uid: Number(uid), pid: Number(pid), ppid: Number(ppid), age: parseEtime(etime), rss: Number(rss), started, command: command.trim() });
  }
  return procs;
}

// Every process on the machine, in one ps call: the kill rule, the VM ages and the memory report all read it.
export async function listProcesses() {
  const { stdout } = await execFileAsync('ps', ['axww', '-o', PS_COLUMNS], { env: PS_ENV, maxBuffer: 64 * 1024 * 1024 });
  return parsePs(stdout);
}

function compileList(config, key) {
  const list = config[key];
  if (!Array.isArray(list)) throw new Error(`config: ${key} must be a list of regexes`);
  return list.map((source, i) => {
    // new RegExp would coerce anything else: {} becomes /[object Object]/, which matches almost any command line.
    if (typeof source !== 'string' || source === '') throw new Error(`config: ${key}[${i}] must be a non-empty regex string, not ${JSON.stringify(source)}`);
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

// A process qualifies when it is this user's, its parent is launchd, it is older than the minimum age, and what it
// runs (its invocation, invocation.mjs) matches a pattern. An exclusion always wins, and so does a watch option
// among node's own: such a process is spared (reported, left running).
export function classify(procs, rules, { uid, selfPid }) {
  const kill = [];
  const spare = [];
  for (const p of procs) {
    if (p.uid !== uid || p.ppid !== 1 || p.pid === selfPid || !(p.age > rules.minAgeSeconds)) continue;
    const invocation = invocationOf(p.command);
    if (!invocation) continue;
    const pattern = rules.patterns.find(({ re }) => re.test(invocation.text));
    if (!pattern) continue;
    const excludedBy = invocation.watch ? `node ${invocation.watch}` : rules.exclude.find(({ re }) => re.test(invocation.text))?.source;
    const identity = identityOf(p);
    if (excludedBy) spare.push({ ...p, identity, pattern: pattern.source, excludedBy });
    else kill.push({ ...p, identity, pattern: pattern.source });
  }
  return { kill, spare };
}

// pid → birth identity of those of the given pids that run now. ps exits 1 when none of them does.
export function snapshotOf(pids) {
  if (pids.length === 0) return new Map();
  let stdout;
  try {
    stdout = execFileSync('ps', ['ww', '-o', PS_COLUMNS, '-p', pids.join(',')], { encoding: 'utf8', env: PS_ENV, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    if (err.status !== 1) throw err;
    stdout = err.stdout ?? '';
  }
  return new Map(parsePs(stdout).map((p) => [p.pid, identityOf(p)]));
}

// SIGTERM, then SIGKILL after the grace to what is left: M6's terminate (mac/hooks/terminate.mjs), which signals a
// pid only while the process holding it still has the birth identity it was chosen with, checked against a fresh
// snapshot just before each round. Each victim's result: terminated (ended after SIGTERM), killed (SIGKILL sent),
// gone (ended before SIGTERM), replaced (its pid held by another process before SIGTERM: not signalled),
// survived (still there after SIGKILL) or failed: <code>.
export async function terminate(victims, { graceMs = 10_000, snapshot, signal = (pid, name) => process.kill(pid, name), sleep } = {}) {
  const pids = victims.map((v) => v.pid);
  const io = {
    snapshot: snapshot ?? (() => snapshotOf(pids)),
    signal,
    sleep: sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    graceMs,
    pollMs: Math.min(500, graceMs),
  };
  const { events, survivors } = await sharedTerminate(victims, io);
  return victims.map((v) => {
    const term = events.find((e) => e.pid === v.pid && e.signal === 'SIGTERM');
    const kill = events.find((e) => e.pid === v.pid && e.signal === 'SIGKILL');
    let result;
    if (term.outcome === 'error') result = `failed: ${term.code}`;
    else if (term.outcome !== 'sent') result = term.outcome;
    else if (kill?.outcome === 'error') result = `failed: ${kill.code}`;
    else if (survivors.includes(v.pid)) result = 'survived';
    else result = kill?.outcome === 'sent' ? 'killed' : 'terminated';
    return { ...v, result };
  });
}
