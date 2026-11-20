#!/usr/bin/env node
// The hand-run Mac gate's import (gate ledger spec, M2): CI-opt's manual-gate-mac runs MAWS's Mac jobs on the mini
// outside Actions, and keeps each run under ~/.local/share/ci-opt/manual-gate/runs/<sha12>-<stamp>/mac/. Each run with
// a record (mac-summary.json, which its lib/summary.mjs writes from the mini's result.tsv) becomes job lines in the
// store's jobs-manual/<day>.jsonl, the collector's job line in shape:
//   node history/manual-gate.mjs --runs <dir> --store <dir> [--repo <alias>] [--git-dir <dir>]
// run on the MacBook, then pushed to the store (fetch and replay on a non-fast-forward). `--git-dir`: a clone holding
// the runs' trees, for the tree key under the repository's path policy; without it a line has no tree key.
//   - `workflow: "manual-gate"`, `run` the directory's name, attempt 1, `job_id` the summary row's id; the run's build
//     is kind `control`.
//   - A mini copy bundling several groups is one line per group, `job_id` `<row id>:<group>`, each with its own exit
//     and its segment's minutes and times where the job's log has them (the runner's step markers, nothing else of
//     the log), else the job's end and, on the first group only, its minutes.
//   - Scope `narrowed` under a test filter (`--e2e-args`) or a command in the group script's place (`--e2e-script`),
//     else `full`; the scope key holds the filter, the environment, the peer, the live flag, the place (host or
//     guest) and whether the job is a mini copy, so a mini copy is an attempt of its own and never joins its direct job.
//   - A job that never ran (refused by the mini's start check, not run for a failed build or for disk, absent from
//     the record) or that ran no tests has no conclusion: its gate attempt is incomplete, never red or green.
// It prints counts only: a run's log and filter can name tests.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describeError } from './errors.mjs';
import { scopeKey } from './jobs.mjs';
import { openMirror } from './mirror.mjs';
import { dayOf, writeManualLines } from './store.mjs';

const RUN_ID = /^[0-9a-f]{12}-(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/;
// The summary's statuses for a job that never ran its steps (lib/summary.mjs `codes`): refused by the start check,
// not run for the run's failed build, not run for disk.
const NEVER_RAN = new Set([3, 8, 9]);
// Statuses the mini's run gives for its own failures: the guest's or its agent's loss, and the job's bound.
const KINDS = { 4: 'runner-lost', 5: 'runner-lost', 6: 'runner-lost', 124: 'time-limit' };
const SEGMENT = /^(\d\d:\d\d:\d\d)Z manual-gate: ##\[step(-end)?\] gate-copy\.sh run \d+ \(e2e:([^)]+)\)(?:: exit (\d+))?\r?$/;
const NAME = /^(.+?)(?: \((mini copy|peer [0-9a-f]+)\))?$/;

// A job's environment file (`export K=v` lines): each key's last value, a single-quoted one unquoted ('\'' inside),
// any other kept as written (printf %q's escapes), which is enough to compare and hash it; and how often each key was
// assigned (manual-gate-mac appends an assignment to override the plan's).
export function parseEnv(text) {
  const values = new Map();
  const counts = new Map();
  for (const line of text.split('\n')) {
    const m = /^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2];
    values.set(m[1], raw.startsWith("'") ? raw.split("'\\''").map((part) => part.replace(/^'|'$/g, '')).join("'") : raw);
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return { get: (k) => values.get(k) ?? '', count: (k) => counts.get(k) ?? 0 };
}

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

// One run directory → what its lines are made of. → null when the run has no record (it never reached the mini, or its
// record never came back).
export function readRun(dir) {
  const mac = join(dir, 'mac');
  const summaryPath = join(mac, 'mac-summary.json');
  if (!existsSync(summaryPath)) return null;
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  const planPath = join(mac, 'plan', 'mac-jobs.json');
  const gates = existsSync(planPath) ? JSON.parse(readFileSync(planPath, 'utf8')).gates ?? null : null;
  const jobs = summary.rows.map((r) => {
    const logs = join(mac, 'mini-run', 'logs', r.id);
    const steps = read(join(logs, 'steps.tsv')).split('\n').filter(Boolean).map((l) => {
      const [id, status, , name] = l.split('\t');
      return { id, status, name };
    });
    const segments = new Map();
    if (r.kind === 'e2e-copy') {
      for (const l of read(join(logs, 'job.log')).split('\n')) {
        const m = SEGMENT.exec(l);
        if (!m) continue;
        const seg = segments.get(m[3]) ?? { start: null, end: null, exit: null };
        if (m[2]) Object.assign(seg, { end: m[1], exit: m[4] ?? null });
        else seg.start = m[1];
        segments.set(m[3], seg);
      }
    }
    return { row: r, env: parseEnv(read(join(mac, 'mini-run', 'jobs', `${r.id}.env`))), steps, segments };
  });
  return { sha: summary.sha, tree: summary.tree, verdict: summary.verdict, gates, jobs };
}

const round = (m) => Math.round(m * 10) / 10;
const minutesBetween = (a, b) => (a && b ? round(Math.max(0, (Date.parse(b) - Date.parse(a)) / 60000)) : 0);
// A step marker's time of day, dated by the job's start (a segment after midnight is the next day's).
const dated = (time, start) => {
  if (!time || !start) return null;
  let at = Date.parse(`${start.slice(0, 10)}T${time}Z`);
  if (at < Date.parse(start) - 60_000) at += 86_400_000;
  return new Date(at).toISOString().replace('.000Z', 'Z');
};

// Where an unsuccessful job stopped, from its steps (the mini's steps.tsv): its first step that did not exit 0, in
// `setup` for the checkout, setup and download steps, `post` for its reports, else `test`; `lost` when none did.
function stopOf(steps) {
  const step = steps.find((s) => s.status !== '0');
  if (!step) return { failed_step: null, phase: 'lost' };
  const phase = /^(checkout|setup|download)/.test(step.id) ? 'setup' : /^reports/.test(step.id) ? 'post' : 'test';
  return { failed_step: step.name, phase };
}

// A job's own end: { conclusion, failed_step, phase, annotations, ran }.
function endOf({ row, steps }) {
  const ran = row.status !== null && !NEVER_RAN.has(row.status);
  const none = { failed_step: null, phase: null, annotations: [] };
  if (!ran) return { conclusion: null, ...none, ran };
  const good = row.kind === 'build' ? row.result === 'BUILT' : row.result === 'PASS' || row.result === 'RAN';
  if (good) return { conclusion: 'success', ...none, ran };
  if (row.status === 0) return { conclusion: null, ...none, ran }; // exited 0 and ran no tests
  return { conclusion: 'failure', ...stopOf(steps), annotations: KINDS[row.status] ? [KINDS[row.status]] : [], ran };
}

// A run (readRun) → its job lines, each with the day it is filed on: { day, line }. `treeKey(tree)`: the tree's key
// under the repository's path policy, or null.
export function runLines(id, run, entry, treeKey = () => null) {
  const m = RUN_ID.exec(id);
  const runStart = m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
  const facts = {
    v: 1, run: id, attempt: 1, workflow: 'manual-gate', event: 'manual', ref: null, producer: 'manual-gate', label: null, change: null,
    gates: run.gates,
  };
  const tree = { head: run.sha, tested: run.sha, tree: run.tree, tree_key: entry.path_policy ? treeKey(run.tree) : run.tree, basis: 'exact' };
  const out = [];
  const add = (job, { job_id, gate, variant, end, started, completed, minutes }) => {
    const { row, env } = job;
    const scripted = env.count('J_SCRIPT') > 1;
    const scope = env.get('J_E2E_ARGS') || scripted ? 'narrowed' : 'full';
    const semantic = {
      place: row.place, filter: env.get('J_E2E_ARGS') || null, env: env.get('J_E2E_ENV') || null,
      peer: env.get('J_PEER') || null, live: env.get('J_LIVE') === 'true', script: scripted ? env.get('J_SCRIPT') : null,
    };
    const control = gate === null;
    const line = {
      ...facts,
      scope: control ? 'full' : scope, scope_key: scopeKey(control ? 'full' : scope, variant, control ? {} : semantic),
      ...tree,
      job_id, job: row.name, gate, shard: null, kind: control ? 'control' : 'gate', role: null, copy: false, copied_from: null,
      lane: end.ran ? (row.place === 'guest' ? 'manual-guest' : 'manual-host') : null, runner: null,
      started, completed, minutes: end.ran ? minutes : 0,
      conclusion: end.conclusion, run_conclusion: run.verdict === 'GREEN' ? 'success' : 'failure',
      failed_step: end.failed_step, phase: end.phase, annotations: end.annotations, log_kinds: [],
    };
    out.push({ day: dayOf(completed ?? started ?? runStart), line });
  };
  for (const job of run.jobs) {
    const { row, env, segments } = job;
    const end = endOf(job);
    const own = { end, started: row.start ?? null, completed: row.end ?? null, minutes: minutesBetween(row.start, row.end) };
    if (row.kind === 'build') {
      add(job, { ...own, job_id: row.id, gate: null, variant: null });
    } else if (row.kind === 'e2e-copy') {
      env.get('J_COPY_GROUPS').split(/,\s*/).filter(Boolean).forEach((group, i) => {
        const seg = segments.get(group);
        const step = job.steps.find((s) => /^copy/.test(s.id) && s.name.endsWith(`(e2e:${group})`));
        const piece = seg?.exit != null
          ? {
              end: seg.exit === '0' ? { ...end, conclusion: 'success', failed_step: null, phase: null, annotations: [] } : { ...end, conclusion: 'failure', failed_step: step?.name ?? null, phase: 'test', annotations: [] },
              started: dated(seg.start, row.start), completed: dated(seg.end, row.start),
            }
          : { end, started: own.started, completed: own.completed };
        const minutes = seg?.exit != null ? minutesBetween(piece.started, piece.completed) : i === 0 ? own.minutes : 0;
        add(job, { ...piece, minutes, job_id: `${row.id}:${group}`, gate: `e2e:${group}`, variant: 'mini-copy' });
      });
    } else {
      const [, gate, suffix] = NAME.exec(row.name);
      add(job, { ...own, job_id: row.id, gate, variant: suffix === 'mini copy' ? 'mini-copy' : null });
    }
  }
  return out;
}

// Every run under `runsDir` into the store. → { runs, unrecorded, lines, written }.
export function importRuns({ runsDir, root, alias, gitDir = null, entry = null }) {
  entry ??= JSON.parse(readFileSync(new URL('./repos.json', import.meta.url), 'utf8')).find((r) => r.alias === alias);
  if (!entry) throw new Error(`history: ${alias} is not in history/repos.json`);
  const mirror = gitDir && openMirror({ dir: gitDir });
  const treeKey = (tree) => {
    if (!mirror) return null;
    try {
      return mirror.treeKey(tree, entry.path_policy);
    } catch {
      return null; // a tree the clone does not hold
    }
  };
  const counts = { runs: 0, unrecorded: 0, lines: 0, written: 0 };
  const entries = [];
  for (const id of readdirSync(runsDir).filter((n) => RUN_ID.test(n)).sort()) {
    const run = readRun(join(runsDir, id));
    if (!run) {
      counts.unrecorded += 1;
      continue;
    }
    counts.runs += 1;
    entries.push(...runLines(id, run, entry, treeKey));
  }
  counts.lines = entries.length;
  counts.written = writeManualLines(root, alias, entries);
  console.log(`manual-gate: ${alias}: runs ${counts.runs} imported (${counts.unrecorded} without a record), lines ${counts.lines}, files written ${counts.written}`);
  return counts;
}

const USAGE = 'history: usage: manual-gate.mjs --runs <dir> --store <dir> [--repo <alias>] [--git-dir <dir>]';

function main(argv) {
  const opts = { runsDir: null, root: null, alias: 'SSFSKIM/MAWS', gitDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--runs') opts.runsDir = argv[++i];
    else if (argv[i] === '--store') opts.root = argv[++i];
    else if (argv[i] === '--repo') opts.alias = argv[++i];
    else if (argv[i] === '--git-dir') opts.gitDir = argv[++i];
    else throw new Error(`history: unknown argument ${argv[i]}`);
  }
  if (!opts.runsDir || !opts.root || !opts.alias) throw new Error(USAGE);
  importRuns(opts);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`manual-gate: ${describeError(err)}`);
    process.exit(1);
  }
}
