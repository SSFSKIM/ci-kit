// The diagnostic record the git watchdog logs before each kill: enough to tell, next time, whether the transfer
// trickled (bytes still arriving, slowly), was blocked on the disk (git in D state, the socket's receive queue full),
// or stalled some other way. A dozen lines at most, each prefixed so the serial console can be grepped for them.
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const MAX_FDS = 24, MAX_FRAMES = 10, MAX_SOCKETS = 3, MAX_SS = 2, MAX_GROUP = 8, MAX_LINE = 500;
const TCP_STATES = ['', 'ESTABLISHED', 'SYN_SENT', 'SYN_RECV', 'FIN_WAIT1', 'FIN_WAIT2', 'TIME_WAIT', 'CLOSE',
  'CLOSE_WAIT', 'LAST_ACK', 'LISTEN', 'CLOSING'];
const DISK_PROBE_MS = 10_000;

const seconds = (ms) => Math.round(ms / 1000);
const clip = (text) => (text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text);

export function redactArgs(argv) {
  return argv.map((arg, i) => {
    let out = arg.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1***@');
    const config = argv[i - 1] === '-c' ? out : /^-c./.test(out) ? out.slice(2) : null;
    if (config !== null && /^[^=]*(extraheader|auth|token|pass|secret|cred)[^=]*=/i.test(config)) {
      out = out.slice(0, out.indexOf('=') + 1) + '***';
    }
    return out;
  });
}

async function attempt(read, fallback = 'unavailable') {
  try { return await read(); } catch { return fallback; }
}

// /proc/net/tcp holds addresses as little-endian 32-bit words of hex.
function address(hex) {
  const [ip, port] = hex.split(':');
  const words = ip.match(/.{8}/g).map((w) => w.match(/../g).reverse().join(''));
  const host = words.length === 1
    ? words[0].match(/../g).map((b) => parseInt(b, 16)).join('.')
    : `[${words.join('').match(/.{4}/g).join(':')}]`;
  return `${host}:${parseInt(port, 16)}`;
}

async function sockets(pid, inodes, readFile) {
  const rows = [];
  for (const table of ['tcp', 'tcp6']) {
    const text = await attempt(() => readFile(`/proc/${pid}/net/${table}`), '');
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || !inodes.includes(f[9])) continue;
      const [tx, rx] = f[4].split(':').map((q) => parseInt(q, 16));
      rows.push(`socket:[${f[9]}] ${TCP_STATES[parseInt(f[3], 16)] ?? f[3]} ${address(f[1])} -> ${address(f[2])} ` +
        `tx_queue ${tx} rx_queue ${rx} retransmits ${parseInt(f[6], 16)}`);
    }
  }
  return rows.slice(0, MAX_SOCKETS);
}

// ss's -i line adds what the queues alone cannot: bytes received, and how long since the peer last sent anything.
async function ssBlocks(pid, exec) {
  const out = await attempt(async () => (await exec('nsenter', ['-t', String(pid), '-n', 'ss', '-tnpi'], { timeout: 5_000 })).stdout, null);
  if (out === null) return ['unavailable'];
  const blocks = [];
  for (const line of out.split('\n').slice(1)) {
    if (/^\s/.test(line) && blocks.length) blocks[blocks.length - 1] += ` ${line.trim()}`;
    else if (line.trim()) blocks.push(line.trim().replace(/\s+/g, ' '));
  }
  return blocks.filter((b) => b.includes(`pid=${pid},`)).slice(0, MAX_SS);
}

// What moved while the process was tracked, and at what rate: a trickle names itself here. A helper reads the network
// with recv(2), which rchar does not count; what it received shows as the wchar it passed on to git (and as ss's
// bytes_received).
function moved(target, at) {
  const { first, io } = target.track;
  const span = (at - first.at) / 1000;
  const age = (at - target.start * 1000) / 1000;
  const delta = (k) => (k in io ? `+${io[k] - first.io[k]} B` : 'n/a');
  const rate = (k) => (span > 0 ? Math.round((io[k] - first.io[k]) / span) : 0);
  return `moved over ${Math.round(span)} s tracked: rchar ${delta('rchar')} (${rate('rchar')} B/s), wchar ${delta('wchar')} ` +
    `(${rate('wchar')} B/s), read_bytes ${delta('read_bytes')}, write_bytes ${delta('write_bytes')}; ` +
    `since start (${Math.round(age)} s): rchar ${io.rchar} B, wchar ${io.wchar} B`;
}

export async function stallRecord({ container, target, group, reason, at }, { readFile, readdir, readlink, exec, probeDisk }) {
  const { pid } = target;
  const proc = (file) => readFile(`/proc/${pid}/${file}`);
  const wchan = async (p) => (await attempt(() => readFile(`/proc/${p}/wchan`), '?')).trim() || '-';
  const fds = await attempt(async () => {
    const names = (await readdir(`/proc/${pid}/fd`)).map(Number).sort((a, b) => a - b).slice(0, MAX_FDS);
    return Promise.all(names.map(async (fd) => [fd, await attempt(() => readlink(`/proc/${pid}/fd/${fd}`), '?')]));
  }, []);
  const inodes = fds.map(([, t]) => t.match(/^socket:\[(\d+)\]$/)?.[1]).filter(Boolean);
  const stack = await attempt(async () => (await proc('stack')).trim().split('\n')
    .map((l) => l.replace(/^\[<[^>]*>\]\s*/, '')).slice(0, MAX_FRAMES).join(' < '));
  const pressure = await attempt(async () => (await readFile('/proc/pressure/io')).trim().split('\n').join(', '));
  const members = await Promise.all(group.slice(0, MAX_GROUP).map(async (m) =>
    `${m.pid} ${m.label} (${m.state} ${await wchan(m.pid)}, no io for ${seconds(at - m.track.changedAt)} s)`));
  const prefix = `git watchdog ${pid}:`;
  return [
    `git watchdog: pid ${pid} (${target.name}) in ${container}: ${reason}`,
    `${prefix} cmd: ${redactArgs(target.argv).join(' ')}`,
    `${prefix} age ${seconds(at - target.start * 1000)} s, state ${target.state}, wchan ${await wchan(pid)}, parent ${target.ppid}`,
    `${prefix} ${moved(target, at)}`,
    `${prefix} io: ${Object.entries(target.track.io).map(([k, v]) => `${k} ${v}`).join(' ')}`,
    `${prefix} stack: ${stack}`,
    `${prefix} fds: ${fds.map(([fd, t]) => `${fd} ${t}`).join(' ') || 'unavailable'}`,
    ...(await sockets(pid, inodes, readFile)).map((row) => `${prefix} tcp: ${row}`),
    ...(inodes.length ? (await ssBlocks(pid, exec)).map((b) => `${prefix} ss: ${b}`) : []),
    `${prefix} disk: ${await attempt(probeDisk)}; io pressure ${pressure}`,
    `${prefix} group: ${members.join(', ')}`,
  ].map(clip);
}

// Whether the cache disk (the job's work directory is on it) takes a 4 KiB synchronous write. A hung disk would hang
// the probe too, so it runs as a child the watchdog stops waiting for, never in this process's thread pool.
export function probeDisk(dir) {
  const file = `${dir}/.ci-kit-git-watchdog-probe`;
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', 'dd if=/dev/zero of="$1" bs=4096 count=1 oflag=dsync 2>/dev/null && rm -f "$1"', 'sh', file],
      { stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.unref();
      resolve(`a 4 KiB synced write to ${dir} had not finished after ${DISK_PROBE_MS / 1000} s`);
    }, DISK_PROBE_MS);
    child.on('error', (error) => { clearTimeout(timer); resolve(`probe failed: ${error.message}`); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? `a 4 KiB synced write to ${dir} took ${Math.round(performance.now() - started)} ms`
        : `a 4 KiB synced write to ${dir} failed (exit ${code})`);
    });
  });
}

// The records an exit report carries: the first few, each cut to a few KiB, so the report stays far below the 64 KiB
// past which the launcher ignores it (gce/launcher/providers/ec2.mjs readReports) and the job's end with it.
export const REPORT_RECORDS = 4, REPORT_RECORD_BYTES = 4096;
export function reportRecords(records) {
  return records.slice(0, REPORT_RECORDS).map((lines) => {
    const text = lines.join('\n');
    return Buffer.byteLength(text) > REPORT_RECORD_BYTES ? `${Buffer.from(text).subarray(0, REPORT_RECORD_BYTES).toString()}…` : text;
  });
}
