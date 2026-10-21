#!/usr/bin/env node
// The mac runner's job hooks (I10): kill every process a job left under the runner's work directory, before the next
// job starts and again after each one ends, and log each kill to ~/Library/Logs/ci-kit/mac-runner-hooks.log.
//
//   node sweep.mjs <job-started|job-completed|manual|shared-hold> [--dry-run] [--spare-workers] [--work <dir>]
//
// Installed by mac/install.sh to <runner>/ci-kit/hooks/, so the work directory is <runner>/_work, two levels up, unless
// --work names another instance's (shared-hold.sh, which never relies on that instance's own copy being there). What
// counts as a stray is strays.mjs's; how one is ended (SIGTERM, then SIGKILL after 10 s, each only while the pid still
// holds the process selected) is terminate.mjs's. --dry-run lists and kills nothing; `manual` without it refuses while a
// job runs. --spare-workers leaves every live job worker of the user (any instance's Runner.Worker, known by the
// kernel's executable path: runner-state.py --workers, read after the process list, so every worker in it is known)
// and what it started alone: the shared hold sweeps a _work that is not its job's own, where a job may sit in its own
// hook or have started since its caller looked (shared-hold.sh). When the workers cannot be read, nothing is swept.
//
// Exit 1 when a stray could not be ended (a signal refused, or a process outliving SIGKILL), with the pids, signals and
// errors on the last log line. As a hook that fails the job: before a job, because a desktop job beside a survivor is
// not the clean desktop it assumes and its result would not be trusted; after one, because the survivor is what that
// job left.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { identityOf, parseLsofCwd, parsePs, selectStrays } from './strays.mjs';
import { terminate } from './terminate.mjs';

const phase = process.argv[2] ?? 'manual';
const dryRun = process.argv.includes('--dry-run');
// The physical path, as lsof prints working directories: a home or runner reached through a symlink must not hide what
// sits there. The default is physical already (a script's own location is resolved); a --work that is not there yet
// holds no process.
const workAt = process.argv.indexOf('--work');
const physical = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
const workDir = workAt > 0 ? physical(process.argv[workAt + 1] ?? '') : resolve(dirname(fileURLToPath(import.meta.url)), '../../_work');
const logDir = join(homedir(), 'Library/Logs/ci-kit');
const uid = process.getuid();

const run = (file, args) => {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      maxBuffer: 64 << 20,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' }, // lstart in one fixed format
    });
  } catch (error) {
    // lsof exits 1 when some process could not be read; what it could read is still on stdout.
    if (typeof error.stdout === 'string' && error.stdout.length > 0) return error.stdout;
    throw error;
  }
};
const listProcesses = () => parsePs(run('/bin/ps', ['-axo', 'pid=,ppid=,uid=,lstart=,command=']));
const processes = listProcesses();
const cwds = parseLsofCwd(run('/usr/sbin/lsof', ['-a', '-u', String(uid), '-d', 'cwd', '-Fpn']));
const job = `run=${process.env.GITHUB_RUN_ID ?? '-'} job=${process.env.GITHUB_JOB ?? '-'}`;
mkdirSync(logDir, { recursive: true });
const log = (line) => {
  const stamped = `${new Date().toISOString()} ${phase} ${job} ${line}`;
  console.log(stamped);
  if (!dryRun) appendFileSync(join(logDir, 'mac-runner-hooks.log'), `${stamped}\n`);
};
let spare = [];
if (process.argv.includes('--spare-workers')) {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    spare = execFileSync('python3', ['-I', join(here, 'runner-state.py'), '--workers'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split(/\s+/).filter(Boolean).map(Number);
  } catch (error) {
    log(`FAILED sweep under ${workDir}: the job workers to spare could not be read (${error.status ?? error.code ?? error.message})`);
    process.exit(1);
  }
}
const strays = selectStrays({ processes, cwds, workDir, uid, self: process.pid, spare });
// By hand, a sweep during a job would kill the job; the hooks run inside one, as its worker's descendants.
const worker = `${dirname(workDir)}/bin/Runner.Worker`;
if (phase === 'manual' && !dryRun && processes.some((p) => p.command.startsWith(worker))) {
  console.error('sweep: a job is running on this runner; sweep by hand only between jobs (or with --dry-run)');
  process.exit(1);
}

for (const stray of strays) {
  log(`${dryRun ? 'would kill' : 'kill'} pid=${stray.pid} (${stray.reason}) ${stray.command.slice(0, 300)}`);
}
if (dryRun || strays.length === 0) {
  log(`swept ${strays.length} under ${workDir}${dryRun ? ' (dry run)' : ''}`);
  process.exit(0);
}

const result = await terminate(strays, {
  snapshot: () => new Map(listProcesses().map((p) => [p.pid, identityOf(p)])),
  signal: (pid, name) => process.kill(pid, name),
  sleep,
});
for (const event of result.events) {
  if (event.signal === 'SIGKILL' && event.outcome === 'sent') log(`SIGKILL pid=${event.pid} (still alive 10 s after SIGTERM)`);
  else if (event.outcome === 'replaced') log(`skip ${event.signal} pid=${event.pid} (the pid now belongs to another process)`);
  else if (event.outcome === 'error') log(`${event.signal} pid=${event.pid} failed: ${event.code}`);
}
if (result.ok) {
  log(`swept ${strays.length} under ${workDir}`);
} else {
  const errors = result.failures.map((f) => `${f.pid}:${f.signal}:${f.code}`).join(',') || '-';
  log(`FAILED sweep of ${strays.length} under ${workDir}: survivors=${result.survivors.join(',') || '-'} errors=${errors}`);
  process.exit(1);
}
