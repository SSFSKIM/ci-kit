// SIGTERM, then SIGKILL after the grace period, against real child processes (with a short grace).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { terminate } from '../host/processes.mjs';

// A child that is ready once it has printed a line (its SIGTERM handler, if any, is installed by then).
function child(source) {
  const proc = spawn(process.execPath, ['-e', `${source};console.log('ready')`], { stdio: ['ignore', 'pipe', 'ignore'] });
  const ready = new Promise((resolve) => proc.stdout.once('data', resolve));
  const exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve(signal)));
  return { proc, ready, exited, victim: { pid: proc.pid, ppid: process.pid, command: `${process.execPath} -e …` } };
}

test('a process that honours SIGTERM ends there; one that ignores it is SIGKILLed after the grace', async () => {
  const polite = child('setInterval(() => {}, 1e6)');
  const stubborn = child("process.on('SIGTERM', () => {}); setInterval(() => {}, 1e6)");
  await Promise.all([polite.ready, stubborn.ready]);
  // The survivor check sees the stubborn child unchanged: same parent, same command.
  const survivors = async (pids) => pids.filter((p) => p === stubborn.proc.pid).map((pid) => ({ pid, ppid: process.pid, command: stubborn.victim.command }));
  const results = await terminate([polite.victim, stubborn.victim], { graceMs: 400, survivors });
  assert.deepEqual(results.map((r) => r.result), ['terminated', 'killed']);
  assert.equal(await polite.exited, 'SIGTERM');
  assert.equal(await stubborn.exited, 'SIGKILL');
});

test('a pid whose process changed during the grace is not SIGKILLed', async () => {
  const stubborn = child("process.on('SIGTERM', () => {}); setInterval(() => {}, 1e6)");
  await stubborn.ready;
  // The listing shows another command under that pid: the original is gone and the pid was reused.
  const survivors = async (pids) => pids.map((pid) => ({ pid, ppid: 1, command: 'something else' }));
  const [r] = await terminate([stubborn.victim], { graceMs: 200, survivors });
  assert.equal(r.result, 'terminated');
  assert.equal(stubborn.proc.exitCode, null, 'still running');
  stubborn.proc.kill('SIGKILL');
  await stubborn.exited;
});

test('a process already gone is reported as gone', async () => {
  const quick = child('');
  await quick.exited;
  const [r] = await terminate([quick.victim], { graceMs: 100, survivors: async () => [] });
  assert.equal(r.result, 'gone');
});
