#!/usr/bin/env node
// The host janitor (spec §7, I11): kills orphaned one-shot test processes and rewrites a report of what else could
// go. Runs every 30 minutes as the LaunchAgent com.ssfskim.ci-kit.janitor (host/install.sh).
//
//   node host/janitor.mjs [--dry-run] [--config <path>]
//
// --dry-run logs and prints would-kill lines and kills nothing. --config replaces host/janitor.json.
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { classify, compileRules, listProcesses, terminate } from './processes.mjs';
import { formatAge, memoryByCategory, renderReport, runningVms, scanWorktrees } from './report.mjs';

const execFileAsync = promisify(execFile);

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { dryRun: false, config: new URL('./janitor.json', import.meta.url).pathname };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') opts.dryRun = true;
    else if (argv[i] === '--config' && argv[i + 1]) opts.config = argv[++i];
    else throw new UsageError(`unknown argument ${argv[i]}`);
  }
  return opts;
}

function loadConfig(path, home) {
  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new UsageError(`cannot read config ${path}: ${err.message}`);
  }
  let rules;
  try {
    rules = compileRules(config);
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (typeof config.vm_report_hours !== 'number' || !(config.vm_report_hours >= 0)) throw new UsageError('config: vm_report_hours must be a number >= 0');
  if (typeof config.repos_root !== 'string') throw new UsageError('config: repos_root must be a path');
  return { config, rules, reposRoot: config.repos_root.replace(/^~(?=\/|$)/, home) };
}

async function notify(message) {
  if (process.platform !== 'darwin') return;
  const script = `display notification ${JSON.stringify(message)} with title "ci-kit janitor"`;
  await execFileAsync('osascript', ['-e', script], { timeout: 10_000 }).catch(() => {});
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const home = homedir();
  const { config, rules, reposRoot } = loadConfig(opts.config, home);
  const logDir = join(home, 'Library', 'Logs', 'ci-kit');
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, 'janitor.log');

  const procs = await listProcesses();
  const { kill, spare } = classify(procs, rules, { uid: process.getuid(), selfPid: process.pid });
  const results = opts.dryRun ? kill.map((k) => ({ ...k, result: 'would-kill' })) : await terminate(kill);

  const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const lines = results.map((r) => {
    const verb = opts.dryRun ? 'would-kill' : 'kill';
    const result = opts.dryRun ? '' : ` result=${r.result}`;
    return `${at} ${verb} pid=${r.pid} age=${formatAge(r.age)} pattern=${r.pattern}${result} cmd=${r.command.slice(0, 500)}`;
  });
  if (lines.length) {
    appendFileSync(logPath, `${lines.join('\n')}\n`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  const ended = results.filter((r) => r.result === 'terminated' || r.result === 'killed').length;
  if (ended && config.notify !== false) await notify(`Killed ${ended} orphaned test process${ended === 1 ? '' : 'es'}; see ~/Library/Logs/ci-kit/janitor.log`);

  const report = renderReport({
    host: hostname(),
    at,
    dryRun: opts.dryRun,
    minAgeHours: config.min_age_hours,
    vmReportHours: config.vm_report_hours,
    killed: results,
    spared: spare,
    worktrees: scanWorktrees(reposRoot),
    vms: runningVms(procs, process.getuid()).filter((vm) => vm.age > config.vm_report_hours * 3600),
    memory: memoryByCategory(procs),
  });
  const reportPath = join(logDir, 'report.md');
  writeFileSync(`${reportPath}.tmp`, report);
  renameSync(`${reportPath}.tmp`, reportPath);
  const done = opts.dryRun ? `would kill ${results.length}` : `killed ${ended} of ${results.length}`;
  process.stdout.write(`janitor: ${done}; left running ${spare.length}; report ${reportPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`janitor: ${err instanceof UsageError ? err.message : err.stack}\n`);
  process.exit(err instanceof UsageError ? 2 : 1);
});
