// The gate ledger's job lines and gate attempts (gate ledger spec, "A job line", Glossary "Gate", "Gate attempt",
// "Scope", "Tree basis", "Change", "Lane"): pure functions of a run as the run listing gives it, one attempt's jobs as
// the attempt's job listing gives them, and the repository's entry in history/repos.json.
import { createHash } from 'node:crypto';
import { gatesOf, producerOf } from './provenance.mjs';

// The platform's own messages about a job, by kind (spec, "A job line": `annotations`). A message is kept as its kind,
// never as its text.
const PLATFORM = [
  ['not-started', /\bjob was not started because\b/i],
  ['runner-lost', /\blost communication with the server\b|\breceived a shutdown signal\b/i],
  ['time-limit', /\bexceeded the maximum execution time\b/i],
];
export const platformKind = (message) => PLATFORM.find(([, re]) => re.test(message ?? ''))?.[0] ?? null;

// A name pattern of history/repos.json (`control`, `parts`): the whole name, `*` matching anything.
const globRe = (pattern) => new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`);
const matches = (patterns, name) => patterns.some((p) => globRe(p).test(name));

const SHARD = /^(.+) ([1-9]\d*)\/([1-9]\d*)$/;
const BUNDLED_COPY = /^e2e: mini copy \((.+)\)$/;
const VARIANT = / \((mini copy|mini overflow|EC2 overflow)\)$/;
const VARIANTS = { 'mini copy': 'mini-copy', 'mini overflow': 'mini-overflow', 'EC2 overflow': 'ec2-overflow' };

// A job's name → { gate, shard: [k, n] | null, kind: 'gate' | 'control', variant }. The repository's job prefix (a
// reusable workflow's `ci / `) is dropped. A control job, or a name GitHub never expanded (a job that never got its
// matrix), is no gate. A summary's parts are its gate. A copy or an overflow of an e2e group is that group's gate with
// its variant, which keeps it an attempt apart (scope key); a copy bundling several groups is one job with one result,
// so it is a gate of its own, named by its groups.
export function gateOf(name, entry) {
  const raw = entry.job_prefix && name.startsWith(entry.job_prefix) ? name.slice(entry.job_prefix.length) : name;
  const none = { gate: null, shard: null, kind: 'control', variant: null };
  if (/\$\{\{|\bmatrix\./.test(raw) || matches(entry.control, raw)) return none;
  for (const [gate, parts] of Object.entries(entry.parts ?? {})) {
    if (matches(parts, raw)) return { gate, shard: null, kind: 'gate', variant: null };
  }
  const bundle = BUNDLED_COPY.exec(raw);
  if (bundle) return { gate: `e2e:${bundle[1].split(/,\s*/).sort().join('+')}`, shard: null, kind: 'gate', variant: 'mini-copy' };
  const v = VARIANT.exec(raw);
  const base = v ? raw.slice(0, v.index) : raw;
  const variant = v ? VARIANTS[v[1]] : null;
  const s = SHARD.exec(base);
  return s ? { gate: s[1], shard: [Number(s[2]), Number(s[3])], kind: 'gate', variant } : { gate: base, shard: null, kind: 'gate', variant };
}

// Where a job ran, from its runner's name (the pool's and the Mac's runners are named by their kind) and, for a job
// that never got a runner or ran on a hosted one, from the labels it asked for. Otherwise null: a lane is never
// guessed.
export function laneOf(job) {
  const name = job.runner_name ?? '';
  const labels = (job.labels ?? []).map((l) => l.toLowerCase());
  if (name.startsWith('ci-kit-gce-')) return 'pool-gce';
  if (name.startsWith('ci-kit-ec2-')) return 'pool-ec2';
  if (/^ci-kit-pool-\d+-\d+$/.test(name)) return 'pool-hetzner'; // the pool's first backend, retired 2026-10 (ci-kit #167)
  if (name.startsWith('ci-kit-mac-')) return name.includes('-maws-vm-') ? 'mini-guest' : 'mini-host';
  if (name === '' || name.startsWith('GitHub Actions ')) {
    if (labels.some((l) => l.startsWith('macos-'))) return 'hosted-macos';
    if (labels.some((l) => l.startsWith('ubuntu-'))) return 'hosted-linux';
  }
  return null;
}

// Where an unsuccessful job stopped (never why): its first step that concluded failure or cancelled, in `setup` when
// the step's name matches the repository's setup_steps, `post` for a post step, else `test`; `lost` when no step
// concluded so (a lost runner's steps never conclude; a refused job has none).
export function phaseOf(job, entry) {
  if (['success', 'skipped', 'neutral'].includes(job.conclusion)) return { failed_step: null, phase: null };
  const step = (job.steps ?? []).find((s) => s.conclusion === 'failure' || s.conclusion === 'cancelled');
  if (!step) return { failed_step: null, phase: 'lost' };
  const setup = entry.setup_steps.some((p) => new RegExp(p).test(step.name));
  const phase = setup ? 'setup' : /^Post |^Complete job$/.test(step.name) ? 'post' : 'test';
  return { failed_step: step.name, phase };
}

// A commit message's trailers: the key: value lines of its last paragraph, when it has more than one. Key → values.
export function trailersOf(message) {
  const paragraphs = (message ?? '').trim().split(/\n[ \t]*\n/);
  if (paragraphs.length < 2) return {};
  const out = {};
  for (const line of paragraphs.at(-1).split('\n')) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (m) (out[m[1]] ??= []).push(m[2]);
  }
  return out;
}

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

// What a gate attempt exercised. `unknown` on an event whose inputs the record does not hold and which can change
// what runs or where (MAWS's dispatch: runner, lane, live); `narrowed` on an event the repository lists as vacuous for
// the gate; `selected` under a `Selection: affected` trailer, whether or not selection fell back to the whole suite;
// else `full`. The scope key adds the repository's semantic trailers (what decides what ran or where, never what
// merely varies between two executions of the same work) and the job's variant.
export function scopeOf(run, gate, variant, entry) {
  const trailers = trailersOf(run.head_commit?.message);
  let scope = 'full';
  if (entry.opaque_events.includes(run.event)) scope = 'unknown';
  else if ((entry.vacuous[gate] ?? []).includes(run.event)) scope = 'narrowed';
  else if ((trailers.Selection ?? []).includes('affected')) scope = 'selected';
  const semantic = Object.fromEntries(entry.semantic_trailers.filter((t) => t in trailers).sort().map((t) => [t, trailers[t]]));
  return { scope, scope_key: hash({ scope, variant, semantic }) };
}

// Two gate attempts that exercised the same thing in the same place.
export const comparable = (a, b) => a.gate === b.gate && a.scope_key === b.scope_key && a.scope !== 'unknown' && b.scope !== 'unknown';

// A job a failed-jobs rerun carried over from an earlier attempt: GitHub lists it with the new attempt's number and a
// new id, and copies its times, runner and steps from the attempt that ran it, so it completed before it was created.
export const isCopy = (job) => Boolean(job.created_at && job.completed_at && job.completed_at < job.created_at);

// The attempt a copied job ran in: the latest earlier attempt whose job of that name is not itself a copy.
// `listingOf(k)`: attempt k's jobs; attempt 1 needs no listing, since nothing there can be a copy.
export function copiedFrom(name, attempt, listingOf) {
  for (let k = attempt - 1; k >= 2; k -= 1) {
    const jobs = listingOf(k);
    if (!jobs) throw new Error(`history: attempt ${k}'s jobs are needed to place a copied job`);
    const job = jobs.find((j) => j.name === name);
    if (!job || !isCopy(job)) return k;
  }
  return 1;
}

// One attempt of a run, as its job lines share it. `resolved`: the tested commit read from the mirror (a ci-gate
// head's one parent, null when the head has none or could not be read) and the tested tree's key (null when the
// mirror could not give it). `conclusion`: the attempt's own, when it is not the run's latest.
export function runFacts(run, attempt, { tested, treeKey }, entry, conclusion = null) {
  let { producer, label, sha8 } = producerOf(run);
  const basis = run.event === 'pull_request' || run.event === 'pull_request_target' ? 'pr-merge' : 'exact';
  const headTree = run.head_commit?.tree_id ?? null;
  let testedSha = basis === 'exact' ? run.head_sha : null;
  if (producer !== 'other') {
    if (tested?.startsWith(sha8)) testedSha = tested;
    else [producer, label] = ['other', null]; // not a ci-gate head: it tested its own head
  }
  let change = null;
  if (basis === 'pr-merge') {
    const pr = run.pull_requests?.[0]?.number;
    change = pr ? `pr:${pr}` : `branch:${run.head_branch}`;
  } else if (producer !== 'other' && !entry.fallback_labels.includes(label)) change = `${producer}:${label}`;
  // A ci-gate's nonce commit and the commit it tests share a tree, so the head's tree is the tested tree.
  const tree = basis === 'exact' ? headTree : null;
  return {
    source: run,
    run: run.id,
    attempt,
    workflow: run.name ?? null,
    event: run.event,
    ref: run.head_branch ?? null,
    producer,
    label,
    change,
    gates: gatesOf(run.head_commit?.message),
    head: run.head_sha,
    tested: testedSha,
    tree,
    tree_key: tree === null ? null : (treeKey ?? (entry.path_policy ? null : tree)),
    head_tree: basis === 'pr-merge' ? headTree : undefined,
    basis,
    run_conclusion: conclusion ?? (attempt === run.run_attempt ? run.conclusion ?? null : null),
  };
}

// A job's runner minutes: none for a job that never got a runner (cancelled or refused while queued, when GitHub's
// times span the queue, not a run).
const minutesOf = (job) => {
  if (!job.runner_name || !job.started_at || !job.completed_at) return 0;
  return Math.max(0, Math.round((Date.parse(job.completed_at) - Date.parse(job.started_at)) / 6000) / 10);
};

// A job's line. `copied_from`: the attempt a copy ran in (null for a job that ran here); a copy has no minutes.
// `annotations`: the platform kinds read for an unsuccessful job.
export function jobLine(facts, job, { copied_from = null, annotations = [] }, entry) {
  const { gate, shard, kind, variant } = gateOf(job.name, entry);
  const { scope, scope_key } = scopeOf(facts.source, gate, variant, entry);
  const { failed_step, phase } = phaseOf(job, entry);
  const head = {
    v: 1, run: facts.run, attempt: facts.attempt, workflow: facts.workflow, event: facts.event, ref: facts.ref,
    producer: facts.producer, label: facts.label, change: facts.change, gates: facts.gates, scope, scope_key,
    head: facts.head, tested: facts.tested, tree: facts.tree,
  };
  if (facts.basis === 'pr-merge') head.head_tree = facts.head_tree;
  return {
    ...head,
    tree_key: facts.tree_key, basis: facts.basis,
    job_id: job.id, job: job.name, gate, shard, kind, copied_from,
    lane: laneOf(job), runner: job.runner_name || null,
    started: job.started_at ?? null, completed: job.completed_at ?? null,
    minutes: copied_from === null ? minutesOf(job) : null,
    conclusion: job.conclusion, run_conclusion: facts.run_conclusion,
    failed_step, phase, annotations,
  };
}

const SHARED = ['run', 'attempt', 'gate', 'workflow', 'event', 'ref', 'producer', 'label', 'change', 'gates', 'scope', 'scope_key', 'basis', 'head', 'tested', 'tree', 'tree_key', 'head_tree', 'run_conclusion'];

// Job lines → gate attempts: a gate's jobs of one (run, attempt) and scope key. It succeeded only when every job
// succeeded and, for a sharded gate, every shard 1..n its names announce is there; it failed when any job did not
// succeed; otherwise it is incomplete. Copies count toward the result, not the minutes; `copied` names the attempts
// they ran in. Control jobs are not gates.
export function gateAttempts(lines) {
  const groups = new Map();
  for (const l of lines) {
    if (l.kind !== 'gate') continue;
    const key = JSON.stringify([l.run, l.attempt, l.gate, l.scope_key]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }
  return [...groups.values()].map((jobs) => {
    const first = jobs[0];
    const n = Math.max(0, ...jobs.map((j) => j.shard?.[1] ?? 0));
    const ks = new Set(jobs.filter((j) => j.shard).map((j) => j.shard[0]));
    const whole = Array.from({ length: n }, (_, i) => i + 1).every((k) => ks.has(k));
    const failed = jobs.some((j) => j.conclusion !== 'success');
    const result = failed ? 'failed' : whole ? 'succeeded' : 'incomplete';
    const at = Object.fromEntries(SHARED.filter((k) => first[k] !== undefined).map((k) => [k, first[k]]));
    const times = (key) => jobs.map((j) => j[key]).filter(Boolean).sort();
    return {
      ...at,
      result,
      shards: n || null,
      started: times('started')[0] ?? null,
      completed: times('completed').at(-1) ?? null,
      minutes: Math.round(jobs.reduce((t, j) => t + (j.minutes ?? 0), 0) * 10) / 10,
      lanes: [...new Set(jobs.filter((j) => j.copied_from === null).map((j) => j.lane).filter(Boolean))].sort(),
      copied: [...new Set(jobs.map((j) => j.copied_from).filter((c) => c !== null))].sort((a, b) => a - b),
      jobs: jobs.map((j) => j.job_id),
    };
  });
}
