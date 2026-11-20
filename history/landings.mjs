// A landing (gate ledger spec, "A landing"): one update of a default branch, from the repository activity listing, with
// what landed (the whole difference between `before` and `after`, read from the mirror), the pull request, the gates
// required of it, and two verdicts: `exact` (did the landed tree run, in full, and pass) and `pr_check` (what the
// required check saw). And the default branch's standing per gate: the full, exact gate attempts on landed trees and
// on the branch's own push runs, each usable only after both its completion and its landing's push.
import { parseConfig } from '../plan/config.mjs';
import { selectGates } from '../plan/select.mjs';

export const LANDING_TYPES = ['push', 'force_push', 'pr_merge', 'merge_queue_merge'];
const ZERO = /^0{40}$/;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const PR_EVENTS = ['pull_request', 'pull_request_target'];

// The default branch's landings since `since` (ISO), newest first, a page of 100 a call until a page reaches past it.
export async function listActivity(gh, repo, branch, { since }) {
  const out = [];
  for (let after = null; ;) {
    const { body, next } = await gh.activityPage(repo, `refs/heads/${branch}`, after);
    for (const a of body) {
      if (LANDING_TYPES.includes(a.activity_type) && a.timestamp >= since) out.push({ id: a.id, type: a.activity_type, before: a.before, after: a.after, at: a.timestamp });
    }
    if (!next || body.length === 0 || body.at(-1).timestamp < since) return out;
    after = next;
  }
}

// What a landing's verdicts read, from cause.mjs's analysis of the window, its job lines and the ledger's run records
// (attempts.json's `runs`): the full, exact, executed attempts by tree key, closed incomplete ones among them (none
// superseded or cancelled), and the pull request runs, each with its record (created, head, pull request, attempts
// closed, each attempt's own start and conclusion) and its lines by attempt. A run with no record is read from its
// lines.
export function landingIndex(analysis, lines, runs = {}) {
  const exact = new Map();
  for (const a of analysis.attempts) {
    if (!judged(a)) continue;
    (exact.get(a.tree_key) ?? exact.set(a.tree_key, []).get(a.tree_key)).push(a);
  }
  for (const list of exact.values()) list.sort((x, y) => (doneAt(x) < doneAt(y) ? -1 : 1));
  const pr = new Map(); // run → { run, created, head, pr, attempts, closed, info, lines: attempt → lines }
  const runOf = (id) => pr.get(id) ?? pr.set(id, { run: id, created: null, head: null, pr: null, attempts: 0, closed: new Set(), info: {}, lines: new Map(), recorded: false }).get(id);
  for (const [id, r] of Object.entries(runs)) {
    if (!PR_EVENTS.includes(r.event)) continue;
    Object.assign(runOf(Number(id)), { created: r.created ?? null, head: r.head ?? null, pr: r.pr ?? null, attempts: r.attempts, closed: new Set(r.closed), info: r.attempt_info ?? {}, recorded: true });
  }
  for (const l of lines) {
    if (!PR_EVENTS.includes(l.event)) continue;
    const r = runOf(l.run);
    if (!r.recorded) {
      r.head ??= l.head;
      r.created ??= analysis.runs.get(l.run)?.created ?? null;
      r.attempts = Math.max(r.attempts, l.attempt);
      r.closed.add(l.attempt);
    }
    (r.lines.get(l.attempt) ?? r.lines.set(l.attempt, []).get(l.attempt)).push(l);
  }
  return { exact, pr };
}

// A superseded or cancelled attempt was stopped, not judged: it is no observation and no verdict on a tree. An
// incomplete one is a verdict (the tree's latest attempt did not finish), not an observation.
const judged = (a) => a.basis === 'exact' && a.scope === 'full' && !a.copied && a.superseded_by === null && !a.cancelled && Boolean(a.tree_key);
const observable = (a) => judged(a) && (a.result === 'succeeded' || a.result === 'failed');
const doneAt = (a) => a.available ?? a.start;

// Each required gate's latest full, exact attempt on the tree key, completed before `at`: `green` when each succeeded,
// `red` when one failed, `unrun` otherwise (one never ran, or the latest did not finish).
function verdictOn(index, required, key, at) {
  const gates = {};
  for (const g of required) {
    const a = (index.exact.get(key) ?? []).filter((x) => x.gate === g && doneAt(x) < at).at(-1);
    gates[g] = a ? { result: a.result, run: a.run, attempt: a.attempt } : null;
  }
  const all = Object.values(gates);
  const verdict = all.some((x) => x?.result === 'failed') ? 'red' : all.every((x) => x?.result === 'succeeded') ? 'green' : 'unrun';
  return { verdict, gates };
}

// The required check as it stood at the landing: the verdict job of the latest pull request run created before it,
// in that run's latest attempt begun before it (a rerun by its own start). A run is the landing's by its head; where
// the head could not be read (a squash whose refs/pull head is gone), by the pull request the run records. `none`:
// the head has no pull request run; `unknown`: neither the head nor a run of the pull request is known. Without a
// verdict line, an attempt still open is `unrun` in flight, and one closed with no jobs reads as its run's conclusion
// (it failed before creating any: the check failed, which is what the check showed).
function prCheck(index, { pr, head }, at, verdictJob) {
  const runs = [...index.pr.values()]
    .filter((r) => r.created && r.created < at && (head !== null ? r.head === head : pr !== null && r.pr === pr))
    .sort((x, y) => (x.created < y.created ? -1 : 1));
  const latest = runs.at(-1);
  if (!latest) return { result: head === null ? 'unknown' : 'none' };
  const startOf = (k) => (k === 1 ? latest.created : latest.info[k]?.started ?? firstFresh(latest.lines.get(k)));
  let attempt = 1;
  for (let k = 2; k <= latest.attempts; k += 1) if ((startOf(k) ?? at) < at) attempt = k;
  const where = { run: latest.run, attempt };
  const lines = latest.lines.get(attempt) ?? [];
  const verdict = lines.find((l) => l.job === verdictJob);
  if (verdict) {
    if (verdict.completed && verdict.completed <= at) return { result: verdict.conclusion === 'success' ? 'green' : 'red', ...where };
    return { result: 'unrun', ...where, inflight: true, eventual: verdict.conclusion };
  }
  const info = latest.info[attempt] ?? null;
  if (!latest.closed.has(attempt)) return { result: 'unrun', ...where, inflight: true, eventual: null };
  if (lines.length === 0 && info?.conclusion) {
    if ((info.completed ?? startOf(attempt)) <= at) return { result: info.conclusion === 'success' ? 'green' : 'red', ...where, read: 'run' };
    return { result: 'unrun', ...where, inflight: true, eventual: info.conclusion };
  }
  return { result: 'unrun', ...where, verdict: 'missing' };
}
const firstFresh = (lines) => (lines ?? []).filter((l) => !l.copy).map((l) => l.started).filter(Boolean).sort()[0] ?? null;

// The pull request a tip's message names: a merge's `Merge pull request #n from …` (or `#n: <title>`, a merge whose
// subject was set), a squash's `… (#n)`.
export function prOfMessage(message) {
  const subject = (message ?? '').split('\n')[0];
  const m = /^Merge pull request #(\d+)\b/.exec(subject) ?? /\(#(\d+)\)\s*$/.exec(subject);
  return m ? Number(m[1]) : null;
}

const excluded = (policy, path) => policy.exclude.some((x) => path.startsWith(x)) && !(policy.except ?? []).some((x) => path.startsWith(x));

// The gates ci-kit's own planner requires of a pull request with these paths, from the config at `commit`; null when
// the config is absent or refused. A config's lanes are not checked against the repository's visibility: they decide
// where a gate runs, not whether it is selected.
function plannedGates(mirror, commit, paths) {
  const text = mirror.fileAt(commit, '.github/ci-kit.yml');
  if (text === null) return null;
  try {
    return selectGates(parseConfig(text, { isPrivate: true }), { event: 'pr', changedFiles: paths }).map((g) => g.name);
  } catch {
    return null;
  }
}

// One landing's line. `event`: { id, type, before, after, at }; `pulls`: pull request number → head (the mirror's
// refs/pull/<n>/head). The mirror is expected to hold `before` and `after` (fetched by the caller).
export function landingLine(event, { entry, mirror, index, pulls }) {
  const tip = mirror.commit(event.after);
  const before = ZERO.test(event.before ?? '') ? null : event.before;
  const line = { v: 1, ...event, tree: tip?.tree ?? null, tree_key: null, paths: null, pr: null, pr_link: null, head: null, required: null, exempt: false, exact: null, exact_gates: null, head_green: null, pr_check: null, ship_with: null };
  if (!tip) return line;
  line.tree_key = mirror.treeKey(tip.tree, entry.path_policy);
  line.paths = before === null ? mirror.paths(EMPTY_TREE, tip.tree) : mirror.has(before) ? mirror.paths(before, event.after) : null;
  line.ship_with = /^Ship-with:[ \t]*(.+?)[ \t]*$/m.exec(tip.message)?.[1] ?? null;
  const second = tip.parents.length === 2 ? tip.parents[1] : null;
  if (entry.verdict_job) {
    line.pr = prOfMessage(tip.message);
    if (line.pr !== null) {
      line.head = second ?? pulls.get(line.pr) ?? null;
      line.pr_link = second && pulls.get(line.pr) === second ? 'parent' : 'message';
      line.pr_check = prCheck(index, { pr: line.pr, head: line.head }, event.at, entry.verdict_job);
    }
  }
  if (line.paths === null) return line;
  line.required = entry.required ?? plannedGates(mirror, before ?? event.after, line.paths);
  line.exempt = Boolean(entry.path_policy) && line.paths.length > 0 && line.paths.every((p) => excluded(entry.path_policy, p));
  if (line.exempt || line.required?.length === 0) line.exact = 'exempt';
  else if (line.required) {
    const { verdict, gates } = verdictOn(index, line.required, line.tree_key, event.at);
    [line.exact, line.exact_gates] = [verdict, gates];
    if (verdict === 'unrun' && second) {
      const head = mirror.commit(second);
      line.head_green = Boolean(head) && verdictOn(index, line.required, mirror.treeKey(head.tree, entry.path_policy), event.at).verdict === 'green';
    }
  }
  return line;
}

// The default branch's observations per gate: the full, exact attempts on a landed tree key or of a push run of the
// default branch. `standing(gate, at)`: the observation about the newest landed tree that has one usable before `at`
// (completed, and its tree landed, before it), the latest of that tree's; a landing with none leaves the previous
// standing with its own commit and time. `landings`: landing lines ({ at, tree_key, after }).
export function observationsOf({ analysis, landings, entry }) {
  const byKey = new Map();
  for (const l of landings ?? []) if (l.tree_key) (byKey.get(l.tree_key) ?? byKey.set(l.tree_key, []).get(l.tree_key)).push(l);
  for (const list of byKey.values()) list.sort((x, y) => (x.at < y.at ? -1 : 1));
  const byGate = new Map();
  for (const a of analysis.attempts) {
    const pushRun = a.event === 'push' && a.ref === entry.default_branch;
    if (!observable(a) || (!byKey.has(a.tree_key) && !pushRun)) continue;
    const o = { result: a.result, at: a.available, run: a.run, attempt: a.attempt, tree_key: a.tree_key, head: a.head, push_run: pushRun, created: a.run_created };
    (byGate.get(a.gate) ?? byGate.set(a.gate, []).get(a.gate)).push(o);
  }
  for (const list of byGate.values()) list.sort((x, y) => (x.at < y.at ? -1 : 1));
  return {
    of: (gate) => byGate.get(gate) ?? [],
    standing(gate, at) {
      let best = null;
      for (const o of byGate.get(gate) ?? []) {
        if (o.at >= at) break;
        const landing = (byKey.get(o.tree_key) ?? []).filter((l) => l.at < at).at(-1);
        const landed = landing?.at ?? (o.push_run ? o.created : null);
        if (!landed) continue;
        const s = { result: o.result, commit: landing?.after ?? o.head, at: o.at, run: o.run, attempt: o.attempt, tree_key: o.tree_key, landed };
        if (!best || landed > best.landed || (landed === best.landed && o.at >= best.at)) best = s;
      }
      return best;
    },
  };
}
