// The pool's git watchdog (pool/vm/git-watchdog.mjs): a fake /proc and clock drive the stall decisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitWatchdog, STILL_MS, CHECKOUT_FETCH_WALL_MS, TICK_MS, readCmdline, parseSocketBytes } from '../../pool/vm/git-watchdog.mjs';
import { redactArgs, probeDisk, boundedChild, reportRecords, REPORT_RECORDS, REPORT_RECORD_BYTES } from '../../pool/vm/git-stall-record.mjs';

const ID = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const CHECKOUT = ['git', '-c', 'protocol.version=2', 'fetch', '--no-tags', '--prune', '--no-recurse-submodules', '--depth=1',
  'origin', '+0123abc:refs/remotes/origin/ci/x'];
const HELPER = ['/usr/lib/git-core/git-remote-https', 'origin', 'https://github.com/SSFSKIM/MAWS']; // as git execs it

// A process table the tests mutate between ticks. `start` is seconds since boot; io counters default to zero.
function world() {
  let nowMs = 1_000_000;
  const procs = new Map();
  const calls = { logs: [], kills: [], exec: [], reads: 0 };
  const net = new Map(); // socket inode → bytes received and acknowledged (tcp_info), as ss -tine reports them
  const add = (pid, p) => {
    procs.set(pid, { ppid: 1, state: 'S', start: nowMs / 1000 - 1, cgroup: ID, fds: {}, wchan: 'do_poll', ...p,
      io: { rchar: 0, wchar: 0, syscr: 0, syscw: 0, read_bytes: 0, write_bytes: 0, ...p.io } });
  };
  const missing = (path) => Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
  const file = (path) => {
    calls.reads++;
    const m = path.match(/^\/proc\/(\d+)\/(.+)$/);
    const p = m && procs.get(Number(m[1]));
    if (!p) throw missing(path);
    const comm = p.comm ?? p.cmd[0].split('/').at(-1).slice(0, 15);
    switch (m[2]) {
      case 'stat': {
        const fields = [p.state, p.ppid, ...Array(17).fill(0), Math.round(p.start * 100), 0];
        return `${m[1]} (${comm}) ${fields.join(' ')}`;
      }
      case 'cmdline': return p.cmd.join('\0') + '\0';
      case 'cgroup': return `0::/system.slice/docker-${p.cgroup}.scope\n`;
      case 'io': return Object.entries(p.io).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n';
      case 'wchan': return p.wchan;
      case 'stack': return '[<0>] wait_woken+0x5c/0x80\n[<0>] tcp_recvmsg+0x1/0x2\n';
      case 'net/tcp': return [
        '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
        '   0: 0200000A:A1B2 03705C8C:01BB 01 00000000:00000000 00:00000000 00000000  1001        0 9001 1 0 20 4 30 10 -1',
      ].join('\n');
      case 'net/tcp6': return '  sl  local_address remote_address st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
      default: throw missing(path);
    }
  };
  const deps = {
    now: () => nowMs,
    readFile: async (path) => {
      if (path === '/proc/pressure/io') return 'some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n';
      return file(path);
    },
    readdir: async (path) => {
      if (path === '/proc') return ['1', 'self', ...[...procs.keys()].map(String), 'meminfo'];
      const m = path.match(/^\/proc\/(\d+)\/fd$/);
      const p = m && procs.get(Number(m[1]));
      if (!p) throw missing(path);
      return Object.keys(p.fds);
    },
    readlink: async (path) => {
      const m = path.match(/^\/proc\/(\d+)\/fd\/(\d+)$/);
      const target = m && procs.get(Number(m[1]))?.fds[m[2]];
      if (!target) throw missing(path);
      return target;
    },
    readCmdline: async (pid) => {
      const p = procs.get(pid);
      if (!p) throw missing(`/proc/${pid}/cmdline`);
      return p.cmd.join('\0') + '\0';
    },
    exec: async (cmd, args) => {
      calls.exec.push([cmd, ...args]);
      if (cmd === 'docker') return { stdout: `${ID}\n` };
      if (cmd === 'nsenter' && args.at(-1) === '-tine') {
        return { stdout: 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n' + [...net].map(([inode, bytes]) =>
          `ESTAB 0 0 10.0.0.2:41394 140.92.112.3:443 uid:1001 ino:${inode} sk:1 <->\n\t cubic bytes_acked:1 bytes_received:${bytes - 1} lastrcv:1`).join('\n') };
      }
      if (cmd === 'nsenter') {
        return { stdout: 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n'
          + `ESTAB 0 0 10.0.0.2:41394 140.92.112.3:443 users:(("git-remote-http",pid=${args[1]},fd=5))\n`
          + '\t cubic rtt:2.1/0.5 bytes_received:5120 lastrcv:181000 lastsnd:181200\n'
          + 'ESTAB 0 0 10.0.0.2:5000 10.0.0.9:22 users:(("sshd",pid=77,fd=3))\n\t cubic rtt:1\n' };
      }
      throw new Error(`unexpected ${cmd}`);
    },
    // A killed process exits, unless it waits in D state; a fetch exits when its helper dies.
    kill: (pid, signal) => {
      calls.kills.push([pid, signal]);
      const p = procs.get(pid);
      if (p.survives) return;
      procs.delete(pid);
      if (p.cmd[0].includes('git-remote-')) procs.delete(p.ppid);
    },
    probeDisk: async () => 'a 4 KiB synced write to /var/lib/ci-kit/cache took 3 ms',
    log: (line) => calls.logs.push(line),
  };
  const advance = (ms) => { nowMs += ms; };
  return { procs, calls, deps, add, advance, net, now: () => nowMs };
}

async function run(w, watchdog, ms, between = () => {}) {
  for (let t = 0; t < ms; t += TICK_MS) { w.advance(TICK_MS); between(); await watchdog.tick(); }
}

const fetchTree = (w, { cmd = CHECKOUT, io } = {}) => {
  w.add(100, { cmd: ['/runner/externals/node20/bin/node', 'checkout'], ppid: 1 });
  w.add(200, { cmd, ppid: 100 });
  w.add(201, { cmd: HELPER, ppid: 200, io, fds: { 0: 'pipe:[11]', 1: 'pipe:[12]', 5: 'socket:[9001]' } });
  w.net.set('9001', 5120);
};

test('a still transfer is left alone inside the window, then its helper alone is killed with one record', async () => {
  const w = world();
  fetchTree(w);
  const handed = [];
  const watchdog = gitWatchdog('ci-kit-gce-x', { ...w.deps, onRecord: (record) => handed.push(record) });
  await run(w, watchdog, STILL_MS - TICK_MS);
  assert.deepEqual(w.calls.kills, []);
  assert.deepEqual(w.calls.logs, []);
  await run(w, watchdog, 2 * TICK_MS);
  assert.deepEqual(w.calls.kills, [[201, 'SIGKILL']], 'the helper, not the fetch that waits on it');
  const record = w.calls.logs.join('\n');
  assert.match(record, /git watchdog: pid 201 \(git-remote-https\) in ci-kit-gce-x: no io or socket bytes for \d+ s/);
  assert.match(record, /cmd: \/usr\/lib\/git-core\/git-remote-https origin https:\/\/github\.com\/SSFSKIM\/MAWS/);
  assert.match(record, /state S, wchan do_poll/);
  assert.match(record, /rchar 0 .*read_bytes 0/);
  assert.match(record, /stack: wait_woken.*tcp_recvmsg/);
  assert.match(record, /fds: 0 pipe:\[11\] 1 pipe:\[12\] 5 socket:\[9001\]/);
  assert.match(record, /tcp: socket:\[9001\] ESTABLISHED 10\.0\.0\.2:41394 -> 140\.92\.112\.3:443 tx_queue 0 rx_queue 0 retransmits 0/);
  assert.match(record, /ss: ESTAB 0 0 10\.0\.0\.2:41394 140\.92\.112\.3:443 .*lastrcv:181000/);
  assert.doesNotMatch(record, /sshd/, 'only the process\'s own sockets');
  assert.match(record, /disk: a 4 KiB synced write .* took 3 ms; io pressure some avg10=0\.00/);
  assert.match(record, /group: 200 git fetch \(S do_poll, idle \d+ s\), 201 git-remote-https \(S do_poll, idle \d+ s\)/);
  assert.match(record, /killed \(SIGKILL\)/);
  assert.ok(w.calls.logs.every((line) => line.startsWith('git watchdog')), 'every line greppable');
  assert.deepEqual(handed, [w.calls.logs], 'the whole record, once, for a report');
  assert.ok(w.calls.logs.length <= 16, 'bounded');
  assert.deepEqual(w.calls.exec.filter((c) => c.at(-1) === '-tnpi'), [['nsenter', '-t', '201', '-n', 'ss', '-tnpi']]);
});

test('a helper that survives its kill is followed by its fetch, and neither is killed or recorded twice', async () => {
  const w = world();
  fetchTree(w);
  w.procs.get(201).survives = true;
  w.procs.get(200).survives = true;
  const watchdog = gitWatchdog('c', w.deps);
  await run(w, watchdog, STILL_MS + TICK_MS);
  assert.deepEqual(w.calls.kills, [[201, 'SIGKILL']]);
  await run(w, watchdog, TICK_MS);
  assert.deepEqual(w.calls.kills, [[201, 'SIGKILL'], [200, 'SIGKILL']]);
  const records = w.calls.logs.filter((line) => line.startsWith('git watchdog: ')).length;
  await run(w, watchdog, 3 * TICK_MS);
  assert.equal(w.calls.kills.length, 2);
  assert.equal(w.calls.logs.filter((line) => line.startsWith('git watchdog: ')).length, records);
  assert.equal(records, 2, 'one record per kill');
});

test('a transfer whose counters move is never killed, however long it runs, and nothing is logged', async () => {
  const w = world();
  fetchTree(w, { cmd: ['git', 'clone', 'https://github.com/big/repo'] });
  const watchdog = gitWatchdog('c', w.deps);
  await run(w, watchdog, 30 * 60_000, () => { w.procs.get(201).io.rchar += 50_000; });
  assert.deepEqual(w.calls.kills, []);
  assert.deepEqual(w.calls.logs, []);
  assert.deepEqual(w.calls.exec, [['docker', 'inspect', '--format', '{{.Id}}', 'c']], 'the container is looked up once, its sockets never');
});

test('a group is still only when every member is: a helper idle while its fetch checks connectivity is not killed', async () => {
  const w = world();
  fetchTree(w, { cmd: ['git', 'fetch', 'origin'] });
  w.add(202, { cmd: ['git', 'rev-list', '--objects', '--stdin', '--not', '--all'], ppid: 200 });
  const watchdog = gitWatchdog('c', w.deps);
  await run(w, watchdog, 2 * STILL_MS, () => { w.procs.get(202).io.rchar += 4096; });
  assert.deepEqual(w.calls.kills, []);
});

test('a trickling checkout fetch is killed past the wall bound whatever its counters, and the record names its rate', async () => {
  const w = world();
  fetchTree(w);
  const watchdog = gitWatchdog('c', w.deps);
  // The helper passes what trickles in on to git: its wchar moves (its network reads are recv(2), not in rchar).
  await run(w, watchdog, CHECKOUT_FETCH_WALL_MS - 2 * TICK_MS, () => { w.procs.get(201).io.wchar += 2_000 * TICK_MS / 1000; });
  assert.deepEqual(w.calls.kills, []);
  await run(w, watchdog, 2 * TICK_MS, () => { w.procs.get(201).io.wchar += 2_000 * TICK_MS / 1000; });
  assert.deepEqual(w.calls.kills, [[201, 'SIGKILL']]);
  const record = w.calls.logs.join('\n');
  assert.match(record, /pid 201 \(git-remote-https\) in c: checkout fetch running \d+ s \(bound 300 s\)/);
  // What moved over the attempt: the deltas since first seen, the span, and the rates (2,000 B/s here).
  assert.match(record, /moved over \d+ s tracked: rchar \+0 B \(0 B\/s\), wchar \+\d+ B \(2000 B\/s\), read_bytes \+0 B, write_bytes \+0 B; since start/);
});

test('the wall bound is for checkout\'s shallow fetch only: a job\'s own fetch and a full-history fetch keep running', async () => {
  for (const cmd of [
    ['git', 'fetch', '--depth=1', 'origin', 'main'],
    ['git', '-c', 'protocol.version=2', 'fetch', '--no-tags', '--prune', '--no-recurse-submodules', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
  ]) {
    const w = world();
    fetchTree(w, { cmd });
    const watchdog = gitWatchdog('c', w.deps);
    await run(w, watchdog, 3 * CHECKOUT_FETCH_WALL_MS, () => { w.procs.get(201).io.rchar += 100; });
    assert.deepEqual(w.calls.kills, [], cmd.join(' '));
  }
});

test('a fetch still after its transfer (no helper left) is killed itself', async () => {
  const w = world();
  w.add(200, { cmd: CHECKOUT, ppid: 1, state: 'D', wchan: 'folio_wait_bit' });
  w.add(210, { cmd: ['git', 'index-pack', '--stdin', '--fix-thin'], ppid: 200, state: 'D', wchan: 'balance_dirty_pages' });
  const watchdog = gitWatchdog('c', w.deps);
  await run(w, watchdog, STILL_MS + TICK_MS);
  assert.deepEqual(w.calls.kills, [[200, 'SIGKILL']]);
  assert.match(w.calls.logs.join('\n'), /210 git index-pack \(D balance_dirty_pages, idle \d+ s\)/);
});

test('never outside the job container, never a non-git process, never an idle non-transfer git or one waiting on a hook', async () => {
  const w = world();
  // Another container's stalled fetch, and the host's own.
  w.add(300, { cmd: ['git', 'fetch', 'origin'], cgroup: OTHER });
  w.add(301, { cmd: HELPER, ppid: 300, cgroup: OTHER });
  w.add(310, { cmd: HELPER, ppid: 1, cgroup: 'system.slice/ssh.service'.padEnd(64, 'x') });
  // In the container: a silent curl, an idle cat-file server, a push waiting on its pre-push hook.
  w.add(320, { cmd: ['curl', 'https://github.com'] });
  w.add(330, { cmd: ['git', 'cat-file', '--batch'] });
  w.add(340, { cmd: ['git', 'push', 'origin', 'HEAD'] });
  w.add(341, { cmd: ['sh', '.git/hooks/pre-push'], ppid: 340 });
  const watchdog = gitWatchdog('c', w.deps);
  await run(w, watchdog, 3 * STILL_MS);
  assert.deepEqual(w.calls.kills, []);
  assert.deepEqual(w.calls.logs, []);
});

test('a pid reused by a new process starts its tracking afresh', async () => {
  const w = world();
  fetchTree(w);
  const watchdog = gitWatchdog('c', w.deps);
  await run(w, watchdog, STILL_MS - TICK_MS);
  w.procs.get(201).start = w.now() / 1000; // the old helper exited and a new one took its pid
  await run(w, watchdog, 2 * TICK_MS);
  assert.deepEqual(w.calls.kills, []);
});

test('a process replaced while its record is gathered is not killed', async () => {
  const w = world();
  fetchTree(w);
  w.deps.probeDisk = async () => { w.procs.get(201).start = w.now() / 1000; return 'ok'; };
  const watchdog = gitWatchdog('c', w.deps);
  await run(w, watchdog, STILL_MS + TICK_MS);
  assert.deepEqual(w.calls.kills, []);
  assert.match(w.calls.logs.at(-1), /exited before the kill/);
});

test('the container\'s end stops the tracking: no reads and no kill after stop, even mid-record', async () => {
  const w = world();
  fetchTree(w);
  const watchdog = gitWatchdog('c', w.deps);
  await run(w, watchdog, STILL_MS - TICK_MS);
  let stopping;
  w.deps.probeDisk = async () => { stopping = watchdog.stop(); return 'ok'; };
  await run(w, watchdog, 2 * TICK_MS);
  await stopping;
  assert.deepEqual(w.calls.kills, []);
  const reads = w.calls.reads;
  await run(w, watchdog, STILL_MS);
  assert.equal(w.calls.reads, reads);
});

test('before the container exists the watchdog only asks Docker, silently', async () => {
  const w = world();
  w.deps.exec = async (cmd, args) => { w.calls.exec.push([cmd, ...args]); throw new Error('No such container'); };
  const watchdog = gitWatchdog('c', w.deps);
  await run(w, watchdog, 3 * TICK_MS);
  assert.equal(w.calls.exec.length, 3);
  assert.equal(w.calls.reads, 0);
  assert.deepEqual(w.calls.logs, []);
});

test('an exit report carries the first records, each cut short, far under the launcher\'s 64 KiB', () => {
  const records = Array.from({ length: 6 }, (_, i) => [`git watchdog: pid ${i}`, 'x'.repeat(9000)]);
  const carried = reportRecords(records);
  assert.equal(carried.length, REPORT_RECORDS);
  assert.ok(carried.every((text, i) => text.startsWith(`git watchdog: pid ${i}\n`) && Buffer.byteLength(text) <= REPORT_RECORD_BYTES + 3));
  assert.ok(Buffer.byteLength(JSON.stringify(carried)) < 32 * 1024);
  assert.deepEqual(reportRecords([['a', 'b']]), ['a\nb']);
});

test('a helper whose socket keeps receiving is not idle, though no io counter moves (recv(2) is not in rchar)', async () => {
  const w = world();
  fetchTree(w, { cmd: ['git', 'fetch', 'origin'] });
  const watchdog = gitWatchdog('c', w.deps);
  await run(w, watchdog, 3 * STILL_MS, () => { w.net.set('9001', w.net.get('9001') + 64 * 1024); });
  assert.deepEqual(w.calls.kills, []);
  w.calls.exec.length = 0;
  await run(w, watchdog, STILL_MS + 2 * TICK_MS); // then the bytes stop: idle from here
  assert.deepEqual(w.calls.kills, [[201, 'SIGKILL']]);
  const reads = w.calls.exec.filter((c) => c.at(-1) === '-tine').length;
  assert.ok(reads > 0 && reads <= (STILL_MS + 2 * TICK_MS) / TICK_MS, 'at most one socket read a tick');
});

test('without a socket reading an idle transfer is left running, and that is said once', async () => {
  const w = world();
  fetchTree(w, { cmd: ['git', 'fetch', 'origin'] });
  const exec = w.deps.exec;
  w.deps.exec = async (cmd, args, options) => {
    if (args?.at(-1) === '-tine') throw new Error('nsenter: permission denied');
    return exec(cmd, args, options);
  };
  const watchdog = gitWatchdog('c', w.deps);
  await run(w, watchdog, 2 * STILL_MS);
  assert.deepEqual(w.calls.kills, []);
  assert.deepEqual(w.calls.logs, ['git watchdog: socket progress unavailable, so idle transfers are left running: nsenter: permission denied']);
});

test('a checkout fetch waiting on ssh or a credential helper is left alone, past the wall bound too', async () => {
  const w = world();
  fetchTree(w);
  w.add(250, { cmd: ['ssh', 'git@github.com'], ppid: 200 });
  const watchdog = gitWatchdog('c', w.deps);
  await run(w, watchdog, 2 * CHECKOUT_FETCH_WALL_MS);
  assert.deepEqual(w.calls.kills, []);
});

test('a git whose command line cannot be read is not judged, and a hung check does not hold stop', async () => {
  const w = world();
  fetchTree(w);
  w.deps.readCmdline = async (pid) => { throw new Error(`no answer for ${pid}`); };
  const watchdog = gitWatchdog('c', w.deps);
  await run(w, watchdog, 2 * STILL_MS);
  assert.deepEqual(w.calls.kills, []);
  const hung = gitWatchdog('c', { ...world().deps, readdir: () => new Promise(() => {}), stopWaitMs: 50 });
  hung.tick();
  await new Promise((resolve) => setImmediate(resolve));
  const started = Date.now();
  await hung.stop();
  assert.ok(Date.now() - started < 1000);
});

test('ss -tine\'s sockets: inode to bytes received plus acknowledged', () => {
  assert.deepEqual(parseSocketBytes('State Recv-Q Send-Q Local Peer\n' +
    'ESTAB 0 0 10.0.0.2:1 1.2.3.4:443 uid:1001 ino:9001 sk:1 <->\n\t cubic bytes_sent:90 bytes_acked:91 bytes_received:5120 lastrcv:3\n' +
    'TIME-WAIT 0 0 10.0.0.2:2 1.2.3.4:443 timer:(timewait,1min) ino:0 sk:2\n'), new Map([['9001', 5211]]));
});

test('the disk probe never writes through a link a job planted in the cache, and leaves no file', async (t) => {
  const { mkdtemp, writeFile, readFile, readdir, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(`${tmpdir()}/ci-kit-probe-`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(`${dir}/target`, 'host file');
  await symlink(`${dir}/target`, `${dir}/planted`);
  assert.match(await probeDisk(dir, { file: 'planted' }), /failed \(EEXIST\)/);
  assert.equal(await readFile(`${dir}/target`, 'utf8'), 'host file');
  assert.match(await probeDisk(dir), /a 4 KiB synced write to .* took \d+ ms/);
  assert.deepEqual((await readdir(dir)).sort(), ['planted', 'target']);
});

test('a bounded child is given up on when it does not answer', async () => {
  const started = Date.now();
  assert.equal(await boundedChild(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], 100), null);
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(await boundedChild(process.execPath, ['-e', 'process.stdout.write("a\\0b")'], 5000), { code: 0, stdout: 'a\0b' });
});

test('credentials on a command line never reach the log', () => {
  assert.deepEqual(redactArgs(['git', 'clone', 'https://x-access-token:ghs_secret@github.com/o/r', '-c',
    'http.https://github.com/.extraheader=AUTHORIZATION: basic c2VjcmV0', '-chttp.extraheader=Bearer t']), ['git', 'clone',
    'https://***@github.com/o/r', '-c', 'http.https://github.com/.extraheader=***', '-chttp.extraheader=***']);
  assert.deepEqual(redactArgs(['git', 'clone', '--config', 'http.extraHeader=AUTHORIZATION: bearer t',
    '--config=http.https://github.com/.extraheader=AUTHORIZATION: basic c2VjcmV0', '--config', 'core.autocrlf=false', '--cached']),
  ['git', 'clone', '--config', 'http.extraHeader=***', '--config=http.https://github.com/.extraheader=***', '--config',
    'core.autocrlf=false', '--cached']);
});

// The real /proc: a git whose server accepted the connection and never answered, found, recorded and killed.
test('on Linux, a real git stalled on a silent server is recorded from /proc and its helper killed', { skip: process.platform !== 'linux', timeout: 30_000 }, async (t) => {
  const { createServer } = await import('node:net');
  const { spawn, execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { readFile, readdir, readlink, mkdtemp, rm } = await import('node:fs/promises');
  const { readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const sockets = [];
  const server = createServer((socket) => sockets.push(socket)); // accepts, never answers
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = await mkdtemp(`${tmpdir()}/ci-kit-watchdog-`);
  t.after(async () => { sockets.forEach((s) => s.destroy()); server.close(); await rm(dir, { recursive: true, force: true }); });
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  delete env.GIT_HTTP_LOW_SPEED_LIMIT;
  delete env.GIT_HTTP_LOW_SPEED_TIME;
  const git = spawn('git', ['ls-remote', `http://127.0.0.1:${server.address().port}/r.git`], { env, stdio: 'ignore' });
  const exited = new Promise((resolve) => git.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => git.kill('SIGKILL'));
  // git runs its helper through `git remote-http`: ls-remote, then that, then git-remote-http.
  const tree = new Set([git.pid]);
  let helper;
  const descend = async () => {
    for (const entry of await readdir('/proc')) {
      try {
        const stat = await readFile(`/proc/${entry}/stat`, 'utf8');
        if (!tree.has(Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]))) continue;
        tree.add(Number(entry));
        if (stat.includes('(git-remote-http)')) helper = Number(entry);
      } catch { /* exited */ }
    }
  };
  for (let i = 0; i < 100 && !(helper && sockets.length); i++) {
    await descend();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(helper && sockets.length, 'git connected to the silent server');
  await new Promise((resolve) => setTimeout(resolve, 300)); // the request written, curl waiting in poll

  let offset = 0, tine = '';
  const logs = [], kills = [];
  const watchdog = gitWatchdog('c', {
    now: () => Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000 + offset,
    // The test's processes stand in for a container's: they get its id in their cgroup.
    readFile: async (path) => {
      const text = await readFile(path, 'utf8');
      const m = path.match(/^\/proc\/(\d+)\/cgroup$/);
      return m && tree.has(Number(m[1])) ? `${text}0::/system.slice/docker-${ID}.scope\n` : text;
    },
    readdir, readlink, readCmdline,
    // Not root, so no nsenter: the test's processes share its network namespace, and ss reads it directly.
    exec: async (cmd, args) => {
      if (cmd === 'docker') return { stdout: ID };
      if (cmd === 'nsenter') {
        const result = await promisify(execFile)('ss', args.slice(4));
        if (args.at(-1) === '-tine') tine = result.stdout;
        return result;
      }
      throw new Error(`unexpected ${cmd}`);
    },
    kill: (pid, signal) => { kills.push(pid); process.kill(pid, signal); },
    probeDisk: () => probeDisk(dir),
    log: (line) => logs.push(line),
  });
  await watchdog.tick();
  offset += STILL_MS;
  await watchdog.tick();
  assert.deepEqual(kills, [helper], logs.join('\n'));
  const record = logs.join('\n');
  assert.match(record, new RegExp(`git watchdog: pid ${helper} \\(git-remote-http\\) in c: no io or socket bytes for 180 s`));
  assert.match(record, /cmd: \S*git-remote-http \S+ http:\/\/127\.0\.0\.1:\d+\/r\.git/);
  assert.match(record, /age \d+ s, state S, wchan \S+, parent \d+/);
  assert.match(record, /io: rchar \d+ wchar \d+ syscr \d+ syscw \d+/);
  assert.match(record, new RegExp(`tcp: socket:\\[\\d+\\] ESTABLISHED 127\\.0\\.0\\.1:\\d+ -> 127\\.0\\.0\\.1:${server.address().port} `));
  assert.match(record, /disk: a 4 KiB synced write to .* took \d+ ms/);
  assert.match(record, new RegExp(`group: .*${git.pid} git ls-remote \\(S \\S+, idle 180 s\\)`));
  assert.match(record, new RegExp(`group: .*${helper} git-remote-http \\(S \\S+, idle 180 s\\)`));
  assert.match(record, /killed \(SIGKILL\)/);
  // The socket reading the idle decision rested on was real ss output, and it named the helper's socket.
  const inode = record.match(/tcp: socket:\[(\d+)\]/)[1];
  assert.ok(parseSocketBytes(tine).has(inode), `ss -tine named the helper's socket ${inode}:\n${tine}`);
  const { code } = await exited;
  assert.notEqual(code, 0, 'the git fails at once, as a dropped connection would fail it');
  await watchdog.stop();
});
