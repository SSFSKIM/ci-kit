// The gate ledger's job lines and gate attempts (gate ledger spec, "A job line", Glossary "Gate", "Gate attempt",
// "Scope", "Tree basis", "Change", "Lane"): pure functions of a run as the run listing gives it, one attempt's jobs as
// the attempt's job listing gives them, and the repository's entry in history/repos.json.
import { createHash } from 'node:crypto';
import { gatesOf, producerOf } from './provenance.mjs';

// The platform's own messages about a job, by kind (spec, "A job line": `annotations`), as GitHub words them, whole
// from their first word (its annotations, 2026-10/11): a test's output that quotes them is not them, and a message too
// vague to name a cause (`The operation was canceled.`) is no kind, since a false `runner-lost` would call a real
// failure infra. A message is kept as its kind, never as its text.
const PLATFORM = [
  ['not-started', /^The job was not started because (?:recent account payments have failed|your account is locked due to a billing issue)/],
  ['runner-lost', /^The (?:self-hosted |hosted )?runner(?:: \S+)? lost communication with the server\./],
  ['runner-lost', /^The runner has received a shutdown signal\./],
  ['time-limit', /^The job has exceeded the maximum execution time of [0-9hms]+\.?$/],
  ['time-limit', /^The job running on runner .+ has exceeded the maximum execution time of \d+ minutes\.$/],
];
export const platformKind = (message) => PLATFORM.find(([, re]) => re.test(message ?? ''))?.[0] ?? null;

// An annotation is the platform's when it is made at the workflow (`.github`), not at a file a step reported.
export const annotationKind = (annotation) => (annotation?.path === '.github' ? platformKind(annotation.message) : null);

// A job log's platform kinds: only from the runner's own error lines (`<time> ##[error]<message>`), never from what a
// step printed.
const RUNNER_ERROR = /^\uFEFF?(?:\d{4}-\d\d-\d\dT[\d:.]+Z )?##\[error\](.*?)\r?$/;
export const logKinds = (text) => [...new Set((text ?? '').split('\n').map((line) => platformKind(RUNNER_ERROR.exec(line)?.[1])).filter(Boolean))];

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
// A scope key: the scope, the job's variant and what else decides what ran or where (`semantic`), hashed.
export const scopeKey = (scope, variant, semantic) => hash({ scope, variant, semantic });

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
  return { scope, scope_key: scopeKey(scope, variant, semantic) };
}

// Two gate attempts that exercised the same thing in the same place.
export const comparable = (a, b) => a.gate === b.gate && a.scope_key === b.scope_key && a.scope !== 'unknown' && b.scope !== 'unknown';

// A job a failed-jobs rerun carried over from an earlier attempt: GitHub lists it with the new attempt's number and a
// new id, and copies its times, runner and steps from the attempt that ran it, so it completed before it was created.
// A first attempt has nothing to copy: one of its jobs that seems to have completed first carries GitHub's misread
// clock (2026-11-01 09:00Z, the hour US clocks fell back).
export const isCopy = (job, attempt) => attempt > 1 && Boolean(job.created_at && job.completed_at && job.completed_at < job.created_at);

// The attempt a copied job ran in: the latest earlier attempt whose listing has a job of that name that is not itself
// a copy; null when none has (the copy is still a copy, with no minutes). `listingOf(k)`: attempt k's jobs.
export function copiedFrom(name, attempt, listingOf) {
  for (let k = attempt - 1; k >= 1; k -= 1) {
    const jobs = listingOf(k);
    if (!jobs) throw new Error(`history: attempt ${k}'s jobs are needed to place a copied job`);
    const job = jobs.find((j) => j.name === name);
    if (job && !isCopy(job, k)) return k;
  }
  return null;
}

// When a copy is filed: when its own gate attempt's result became available (the latest fresh completion among the
// attempt's jobs of its gate and scope key), else, for a gate of copies only, by its copies' latest time. So the day
// that holds a gate attempt's last fresh job holds its copies, whatever its copied shards' days or another gate's
// jobs. A line that ran in its attempt is filed by its own completion. `lines`: the attempt's lines.
export function filingTime(lines, copy) {
  const same = lines.filter((l) => l.gate === copy.gate && l.scope_key === copy.scope_key);
  const latest = (list) => list.map((l) => l.completed).filter(Boolean).sort().at(-1) ?? null;
  return latest(same.filter((l) => !l.copy)) ?? latest(same);
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

// A summary job: one whose name is its gate's where the repository names the gate's parts (MAWS's hosted `static`).
// It decides the result with its parts; their minutes and lanes are the gate's.
const roleOf = (name, gate, entry) => {
  const raw = entry.job_prefix && name.startsWith(entry.job_prefix) ? name.slice(entry.job_prefix.length) : name;
  return gate !== null && raw === gate && gate in (entry.parts ?? {}) ? 'summary' : null;
};

// A job that never started: no runner took it and no step ran. The billing refusal (`not-started`) is believed of
// such a job only.
const neverStarted = (job) => !job.runner_name && !(job.steps ?? []).some((s) => s.conclusion && s.conclusion !== 'skipped');
const believed = (job, kinds) => kinds.filter((k) => k !== 'not-started' || neverStarted(job));

// A job's line. `copy`: carried over from an earlier attempt; `copied_from`: the attempt it ran in (null when it ran
// here, or for a copy whose origin no earlier listing shows); a copy has no minutes. The platform kinds read for an
// unsuccessful job, by where they were read: `annotations` from its annotations, `log_kinds` from its log's runner
// lines (where annotations are refused), which only the job's own structure can corroborate.
export function jobLine(facts, job, { copied_from = null, annotations = [], log_kinds = [] }, entry) {
  const { gate, shard, kind, variant } = gateOf(job.name, entry);
  const copy = isCopy(job, facts.attempt);
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
    job_id: job.id, job: job.name, gate, shard, kind, role: roleOf(job.name, gate, entry), copy, copied_from,
    lane: laneOf(job), runner: job.runner_name || null,
    started: job.started_at ?? null, completed: job.completed_at ?? null,
    minutes: copy ? null : minutesOf(job),
    conclusion: job.conclusion, run_conclusion: facts.run_conclusion,
    failed_step, phase, annotations: believed(job, annotations), log_kinds: believed(job, log_kinds),
  };
}

const SHARED = ['run', 'attempt', 'gate', 'workflow', 'event', 'ref', 'producer', 'label', 'change', 'gates', 'scope', 'scope_key', 'basis', 'head', 'tested', 'tree', 'tree_key', 'head_tree', 'run_conclusion'];

// Job lines → gate attempts: a gate's jobs of one (run, attempt) and scope key. It failed when any job did not succeed
// (a summary job too), a job with no conclusion aside; it succeeded only when every job succeeded, its jobs announce
// one shard count n (or none) and, for n, every shard 1..n is there; otherwise it is incomplete. Copies count toward the result, not the minutes;
// `copies` names the attempts they ran in, and `copied` says every job was a copy: no new execution, never an attempt
// or a later green of its own. `available`: when the result was known (its latest fresh job's completion), apart from
// the jobs' physical `started` and `completed`. A summary job adds no minutes or lane. Control jobs are not gates.
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
    const forms = new Set(jobs.map((j) => j.shard?.[1] ?? null));
    const [n] = forms;
    const ks = new Set(jobs.filter((j) => j.shard).map((j) => j.shard[0]));
    const whole = forms.size === 1 && (n === null || Array.from({ length: n }, (_, i) => i + 1).every((k) => ks.has(k)));
    // A job with no conclusion (a hand-run gate's job that never ran, or ran no tests) neither fails nor completes it.
    const failed = jobs.some((j) => j.conclusion !== null && j.conclusion !== 'success');
    const ran = jobs.every((j) => j.conclusion !== null);
    const result = failed ? 'failed' : whole && ran ? 'succeeded' : 'incomplete';
    const at = Object.fromEntries(SHARED.filter((k) => first[k] !== undefined).map((k) => [k, first[k]]));
    const times = (list, key) => list.map((j) => j[key]).filter(Boolean).sort();
    const fresh = jobs.filter((j) => !j.copy);
    const billed = fresh.filter((j) => j.role !== 'summary');
    return {
      ...at,
      result,
      shards: forms.size === 1 ? n : null,
      started: times(jobs, 'started')[0] ?? null,
      completed: times(jobs, 'completed').at(-1) ?? null,
      available: times(fresh, 'completed').at(-1) ?? null,
      minutes: Math.round(billed.reduce((t, j) => t + (j.minutes ?? 0), 0) * 10) / 10,
      lanes: [...new Set(billed.map((j) => j.lane).filter(Boolean))].sort(),
      copied: fresh.length === 0,
      copies: [...new Set(jobs.map((j) => j.copied_from).filter((c) => c !== null))].sort((a, b) => a - b),
      jobs: jobs.map((j) => j.job_id),
    };
  });
}
