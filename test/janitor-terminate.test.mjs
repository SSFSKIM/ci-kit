// SIGTERM, then SIGKILL after the grace, signalling a pid only while it keeps the birth identity it was chosen with.
// The identity cases run against a scripted process table; the last test runs real child processes and real ps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { snapshotOf, terminate } from '../host/processes.mjs';

// pid → identity, the signals sent, and fake time: sleep advances it and runs what is scheduled by then.
function world(initial) {
  const table = new Map(Object.entries(initial).map(([pid, identity]) => [Number(pid), identity]));
  const sent = [];
  const on = {}; // `${pid} ${signal}` → reaction
  const at = []; // [ms, fn]
  let now = 0;
  return {
    table,
    sent,
    on,
    at,
    io: {
      graceMs: 10_000,
      snapshot: () => new Map(table),
      signal(pid, name) {
        if (!table.has(pid)) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
        sent.push(`${name} ${pid}`);
        on[`${pid} ${name}`]?.();
      },
      async sleep(ms) {
        now += ms;
        for (const [t, fn] of at.filter(([t]) => t <= now)) fn();
        at.splice(0, at.length, ...at.filter(([t]) => t > now));
      },
    },
  };
}
const victim = (pid, identity) => ({ pid, ppid: 1, identity, command: 'node --test test/' });

test('a process that ends on SIGTERM is terminated; one that ignores it is SIGKILLed after the grace', async () => {
  const w = world({ 300: 'A', 301: 'B' });
  w.on['300 SIGTERM'] = () => w.table.delete(300);
  w.on['301 SIGKILL'] = () => w.table.delete(301);
  const results = await terminate([victim(300, 'A'), victim(301, 'B')], w.io);
  assert.deepEqual(results.map((r) => r.result), ['terminated', 'killed']);
  assert.deepEqual(w.sent, ['SIGTERM 300', 'SIGTERM 301', 'SIGKILL 301']);
});

test('a pid reused between the listing and SIGTERM gets no signal at all', async () => {
  // Chosen as A; by the time of the signal the pid holds C, the same command started later.
  const w = world({ 300: 'C' });
  const [r] = await terminate([victim(300, 'A')], w.io);
  assert.equal(r.result, 'replaced');
  assert.deepEqual(w.sent, []);
});

test('a pid reused during the grace by the same command under launchd gets no SIGKILL', async () => {
  const w = world({ 300: 'A' });
  // It ignores SIGTERM but exits 1 s later; then a new process with the same command, parent and uid takes the pid.
  w.at.push([1000, () => w.table.set(300, 'A2')]);
  const [r] = await terminate([victim(300, 'A')], w.io);
  assert.equal(r.result, 'terminated');
  assert.deepEqual(w.sent, ['SIGTERM 300']);
});

test('a process gone before SIGTERM is gone; one that outlives SIGKILL is reported as survived', async () => {
  const w = world({ 301: 'B' });
  const results = await terminate([victim(300, 'A'), victim(301, 'B')], w.io);
  assert.deepEqual(results.map((r) => r.result), ['gone', 'survived']);
});

test('against real processes: real ps identities, SIGTERM honoured, SIGTERM ignored', async () => {
  const child = (source) => {
    const proc = spawn(process.execPath, ['-e', `${source};console.log('ready')`], { stdio: ['ignore', 'pipe', 'ignore'] });
    return {
      proc,
      ready: new Promise((resolve) => proc.stdout.once('data', resolve)),
      exited: new Promise((resolve) => proc.once('exit', (code, signal) => resolve(signal))),
    };
  };
  const polite = child('setInterval(() => {}, 1e6)');
  const stubborn = child("process.on('SIGTERM', () => {}); setInterval(() => {}, 1e6)");
  await Promise.all([polite.ready, stubborn.ready]);
  const ids = snapshotOf([polite.proc.pid, stubborn.proc.pid]);
  assert.match(ids.get(polite.proc.pid), /^\d+ \w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
  const results = await terminate(
    [polite, stubborn].map(({ proc }) => ({ pid: proc.pid, ppid: process.pid, identity: ids.get(proc.pid), command: 'node -e …' })),
    { graceMs: 600 },
  );
  assert.deepEqual(results.map((r) => r.result), ['terminated', 'killed']);
  assert.equal(await polite.exited, 'SIGTERM');
  assert.equal(await stubborn.exited, 'SIGKILL');
});
