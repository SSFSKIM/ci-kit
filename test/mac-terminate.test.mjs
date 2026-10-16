import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminate } from '../mac/hooks/terminate.mjs';

// A scripted process table: pid → identity, signals recorded, each process reacting to signals as scripted. Time is
// fake: sleep advances it, so the 10 s grace costs nothing.
function world(initial, react = {}) {
  const table = new Map(Object.entries(initial).map(([pid, identity]) => [Number(pid), identity]));
  const sent = [];
  let now = 0;
  const errors = {};
  const tick = [];
  return {
    sent,
    table,
    errors,
    tick,
    snapshot: () => new Map(table),
    signal(pid, name) {
      const error = errors[`${pid} ${name}`];
      if (error === 'ESRCH') table.delete(pid); // it exited between the snapshot and the signal
      if (error) throw Object.assign(new Error(`kill ${pid} ${name}`), { code: error });
      if (!table.has(pid)) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      sent.push(`${name} ${pid}`);
      react[pid]?.(name, table, pid);
    },
    async sleep(ms) {
      now += ms;
      for (const f of tick) f(now, table);
    },
  };
}
const exitsOn = (signals) => (name, table, pid) => {
  if (signals.includes(name)) table.delete(pid);
};

test('a stray that exits on SIGTERM gets nothing more', async () => {
  const w = world({ 300: 'A' }, { 300: exitsOn(['SIGTERM']) });
  const result = await terminate([{ pid: 300, identity: 'A' }], w);
  assert.deepEqual(w.sent, ['SIGTERM 300']);
  assert.equal(result.ok, true);
});

test('a stray that ignores SIGTERM gets SIGKILL after the grace', async () => {
  const w = world({ 300: 'A' }, { 300: exitsOn(['SIGKILL']) });
  const result = await terminate([{ pid: 300, identity: 'A' }], w);
  assert.deepEqual(w.sent, ['SIGTERM 300', 'SIGKILL 300']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.events.map((e) => e.outcome), ['sent', 'sent']);
});

test('the original exits, its pid is reused during the grace, and the replacement gets no signal', async () => {
  const w = world({ 300: 'A' }, { 300: () => {} }); // ignores SIGTERM...
  w.tick.push((now, table) => {
    if (now >= 2_000 && table.get(300) === 'A') table.set(300, 'B'); // ...exits at 2 s; pid 300 is another process's
  });
  const result = await terminate([{ pid: 300, identity: 'A' }], w);
  assert.deepEqual(w.sent, ['SIGTERM 300']);
  assert.equal(result.ok, true);
});

test('a pid already held by another process when the sweep signals is left alone', async () => {
  const w = world({ 300: 'B' });
  const result = await terminate([{ pid: 300, identity: 'A' }], w);
  assert.deepEqual(w.sent, []);
  assert.equal(result.ok, true);
  assert.equal(result.events[0].outcome, 'replaced');
});

test('ESRCH means gone: not a failure', async () => {
  const w = world({ 300: 'A' });
  w.errors['300 SIGTERM'] = 'ESRCH';
  const result = await terminate([{ pid: 300, identity: 'A' }], w);
  assert.equal(result.ok, true);
});

test('EPERM is a failure, named with pid and signal, and the stray is a survivor', async () => {
  const w = world({ 300: 'A' });
  w.errors['300 SIGTERM'] = 'EPERM';
  w.errors['300 SIGKILL'] = 'EPERM';
  const result = await terminate([{ pid: 300, identity: 'A' }], w);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [
    { pid: 300, signal: 'SIGTERM', code: 'EPERM' },
    { pid: 300, signal: 'SIGKILL', code: 'EPERM' },
  ]);
  assert.deepEqual(result.survivors, [300]);
});

test('a stray that outlives SIGKILL is a survivor and the sweep is not ok', async () => {
  const w = world({ 300: 'A', 301: 'C' }, { 300: () => {}, 301: exitsOn(['SIGTERM']) });
  const result = await terminate([{ pid: 300, identity: 'A' }, { pid: 301, identity: 'C' }], w);
  assert.equal(result.ok, false);
  assert.deepEqual(result.survivors, [300]);
  assert.deepEqual(result.failures, []);
});
