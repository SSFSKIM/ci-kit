#!/usr/bin/env node
// The GCE pool's start latency (spec M3, Timing in the ledger): how long a pool job waits for its VM, stage by stage,
// as the table in the spec's Purpose. From the Mac, read-only, with gh's token and gcloud's default account:
//   node gce/latency-report.mjs [--since <ISO>] [--until <ISO>] [--repo <owner/name>]
// (default: the last 24 h, every served repo). The rows are the pool ledger's (one per VM: its creation, its RUNNING
// time, and the job it ran with that job's queued and started times); the ticks are the launcher's `tick:` log lines
// in Cloud Logging (each tick's start, its duration and its first insert). A row or tick without a stage's fields,
// as those written before M3, counts in none of that stage's samples. The whole pool's stages come first, then each
// machine type's VM stages, insert accepted → job started (M3's target, per VM) among them.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createGitHub, ghToken } from '../lib/github.mjs';
import { rowsOf } from './launcher/ledger.mjs';

const ms = (s) => (s ? Date.parse(s) : NaN);
const gap = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? b - a : null);
const present = (list) => list.filter((v) => v !== null);

// Each stage's samples (ms). rows: ledger rows; ticks: [{start, end, firstInsert}] (epoch ms; firstInsert null when
// not logged). A row belongs to the tick whose span holds its launch (`at`): a tick's insert is its first VM's
// creation, which Compute Engine stamps when it accepts the insert.
export function stages({ rows, ticks }) {
  const starts = ticks.map((k) => k.start).sort((a, b) => a - b);
  const nextTick = (at) => starts.find((s) => s >= at) ?? NaN;
  const firstCreated = new Map();
  for (const r of rows) {
    const at = ms(r.at);
    const tick = ticks.find((k) => k.start <= at && at <= k.end);
    const created = ms(r.created);
    if (!tick || !Number.isFinite(created)) continue;
    firstCreated.set(tick, Math.min(firstCreated.get(tick) ?? Infinity, created));
  }
  return {
    queuedToTick: present(rows.map((r) => gap(ms(r.job?.queued), nextTick(ms(r.job?.queued))))),
    tickToInsert: [...firstCreated].map(([tick, created]) => created - tick.start),
    tickToFirstInsert: ticks.filter((k) => k.firstInsert !== null).map((k) => k.firstInsert - k.start),
    insertToRunning: present(rows.map((r) => gap(ms(r.created), ms(r.running)))),
    runningToStarted: present(rows.map((r) => gap(ms(r.running), ms(r.job?.started)))),
    queuedToStarted: present(rows.map((r) => gap(ms(r.job?.queued), ms(r.job?.started)))),
    // M3's target statistic, each VM's own: summing the stages' medians is not the median of the whole.
    insertToStarted: present(rows.map((r) => gap(ms(r.created), ms(r.job?.started)))),
  };
}

// The launcher's `tick:` log entries (Cloud Logging's JSON) → ticks. A line from before M3 has no `started`: the
// tick began its `ms` before the line was written.
export const ticksOf = (entries) => entries
  .map((e) => {
    const end = Date.parse(e.timestamp);
    const p = e.jsonPayload ?? {};
    return { start: p.started ? Date.parse(p.started) : end - p.ms, end, firstInsert: p.firstInsert ? Date.parse(p.firstInsert) : null };
  })
  .filter((k) => Number.isFinite(k.start))
  .sort((a, b) => a.start - b.start);

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
function summary(samples) {
  const s = [...(samples ?? [])].sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = s.length / 2;
  const median = s.length % 2 ? s[Math.floor(mid)] : (s[mid - 1] + s[mid]) / 2;
  return { median, p10: quantile(s, 0.1), p90: quantile(s, 0.9), n: s.length };
}

const LINES = [
  ['queuedToTick', 'queued → next launcher tick'],
  ['tickToInsert', 'tick start → insert accepted'],
  ['tickToFirstInsert', 'tick start → first insert sent'],
  ['insertToRunning', 'insert accepted → RUNNING'],
  ['runningToStarted', 'RUNNING → job started'],
  ['insertToStarted', 'insert accepted → job started'],
  ['queuedToStarted', 'queued → started'],
];
// The stages one VM's row times on its own, which therefore split by machine type.
const VM_LINES = LINES.filter(([key]) => ['insertToRunning', 'runningToStarted', 'insertToStarted', 'queuedToStarted'].includes(key));
const sec = (v) => (v / 1000).toFixed(1);
const line = (label, samples) => {
  const s = summary(samples);
  return `${label.padEnd(34)}${(s ? `${sec(s.median)} s` : '-').padEnd(10)}${(s ? `${sec(s.p10)}–${sec(s.p90)}` : '-').padEnd(14)}${s?.n ?? 0}`;
};

export function renderReport(samples, { from, to, rows, ticks }) {
  const out = [
    `GCE pool start latency, ${new Date(from).toISOString()} → ${new Date(to).toISOString()}: ${rows} ledger rows, ${ticks} ticks`,
    `${'stage'.padEnd(34)}${'median'.padEnd(10)}${'p10–p90'.padEnd(14)}n`,
  ];
  for (const [key, label] of LINES) out.push(line(label, samples[key]));
  return out.join('\n');
}

// Each machine type's VM stages on their own (the c3d-highcpu-4 median beside the C4D one), machines in name order.
export function renderByMachine(rows) {
  const groups = new Map();
  for (const r of rows) groups.set(r.machine ?? '(no machine)', [...(groups.get(r.machine ?? '(no machine)') ?? []), r]);
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([machine, list]) => {
    const samples = stages({ rows: list, ticks: [] });
    return [`${machine} (${list.length} VM${list.length === 1 ? '' : 's'})`, ...VM_LINES.map(([key, label]) => line(label, samples[key]))].join('\n');
  }).join('\n\n');
}

// ── reading the live ledger and logs ─────────────────────────────────────────────────────────────────────────────

const LAUNCHER_LOG = (from, to) => [
  'resource.type="cloud_run_revision"', 'resource.labels.service_name="ci-kit-launcher"', 'jsonPayload.message:"tick:"',
  `timestamp>="${new Date(from).toISOString()}"`, `timestamp<="${new Date(to).toISOString()}"`,
].join(' AND ');

function readTicks(project, from, to) {
  const out = execFileSync('gcloud', [
    'logging', 'read', LAUNCHER_LOG(from, to), `--project=${project}`, '--order=asc',
    '--format=json(timestamp,jsonPayload.ms,jsonPayload.started,jsonPayload.firstInsert)',
  ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return ticksOf(JSON.parse(out || '[]'));
}

// The rows updated since `from` on every ledger issue (a row is updated at its VM's deletion, after its job): the
// open ones, and the closed (rotated) ones updated since `from`. A closed issue was closed after its last comment
// changed, so one holding a row of the window was itself updated in it.
export async function readRows(gh, { repo, issue_title: title }, from) {
  const since = new Date(from).toISOString();
  const listed = [...(await gh.openIssues(repo)), ...(await gh.closedIssuesSince(repo, since))];
  const issues = listed.filter((i) => !i.pull_request && (i.title === title || i.title.startsWith(`${title} from `)));
  return rowsOf((await Promise.all(issues.map((i) => gh.issueComments(repo, i.number, { since })))).flat());
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!['--since', '--until', '--repo'].includes(flag) || value === undefined) throw new Error(`usage: node gce/latency-report.mjs [--since <ISO>] [--until <ISO>] [--repo <owner/name>]`);
    opts[flag.slice(2)] = value;
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const to = opts.until ? Date.parse(opts.until) : Date.now();
  const from = opts.since ? Date.parse(opts.since) : to - 24 * 3600_000;
  const cfg = JSON.parse(readFileSync(new URL('../pool/config/gce.json', import.meta.url), 'utf8'));
  const token = ghToken();
  if (!token) throw new Error('gh is not authenticated (gh auth login)');
  const [ticks, all] = await Promise.all([readTicks(cfg.project, from, to), readRows(createGitHub(token), cfg.ledger, from)]);
  // A row counts when its VM was created in the span; its job's times then fall in or just after it.
  const rows = all.filter((r) => (!opts.repo || r.repo === opts.repo) && ms(r.created) >= from && ms(r.created) <= to);
  console.log(renderReport(stages({ rows, ticks }), { from, to, rows: rows.length, ticks: ticks.length }));
  console.log(`\nBy machine type\n\n${renderByMachine(rows)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
