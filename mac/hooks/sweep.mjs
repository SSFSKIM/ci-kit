#!/usr/bin/env node
// The mac runner's job hooks (I10): kill every process a job left under the runner's work directory, before the next
// job starts and again after each one ends, and log each kill to ~/Library/Logs/ci-kit/mac-runner-hooks.log.
//
//   node sweep.mjs <job-started|job-completed|manual> [--dry-run]
//
// Installed by mac/install.sh to <runner>/ci-kit/hooks/, so the work directory is <runner>/_work, two levels up. What
// counts as a stray is strays.mjs's. A stray gets SIGTERM, then SIGKILL after 10 s. --dry-run lists and kills nothing.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseLsofCwd, parsePs, selectStrays } from './strays.mjs';

const phase = process.argv[2] ?? 'manual';
const dryRun = process.argv.includes('--dry-run');
const workDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../_work');
const logDir = join(homedir(), 'Library/Logs/ci-kit');
const uid = process.getuid();

const run = (file, args) => {
  try {
    return execFileSync(file, args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    // lsof exits 1 when some process could not be read; what it could read is still on stdout.
    if (typeof error.stdout === 'string' && error.stdout.length > 0) return error.stdout;
    throw error;
  }
};
const processes = parsePs(run('/bin/ps', ['-axo', 'pid=,ppid=,uid=,command=']));
const cwds = parseLsofCwd(run('/usr/sbin/lsof', ['-a', '-u', String(uid), '-d', 'cwd', '-Fpn']));
const strays = selectStrays({ processes, cwds, workDir, uid, self: process.pid });

const job = `run=${process.env.GITHUB_RUN_ID ?? '-'} job=${process.env.GITHUB_JOB ?? '-'}`;
mkdirSync(logDir, { recursive: true });
const log = (line) => {
  const stamped = `${new Date().toISOString()} ${phase} ${job} ${line}`;
  console.log(stamped);
  if (!dryRun) appendFileSync(join(logDir, 'mac-runner-hooks.log'), `${stamped}\n`);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const signal = (pid, name) => {
  try {
    process.kill(pid, name);
  } catch {
    // gone already
  }
};

for (const stray of strays) {
  log(`${dryRun ? 'would kill' : 'kill'} pid=${stray.pid} (${stray.reason}) ${stray.command.slice(0, 300)}`);
  if (!dryRun) signal(stray.pid, 'SIGTERM');
}
if (!dryRun && strays.length > 0) {
  for (let waited = 0; waited < 10_000 && strays.some((s) => alive(s.pid)); waited += 250) await sleep(250);
  for (const stray of strays.filter((s) => alive(s.pid))) {
    log(`SIGKILL pid=${stray.pid} (still alive 10 s after SIGTERM)`);
    signal(stray.pid, 'SIGKILL');
  }
}
log(`swept ${strays.length} under ${workDir}${dryRun ? ' (dry run)' : ''}`);
