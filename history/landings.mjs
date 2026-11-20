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

// What a landing's verdicts read, from cause.mjs's analysis of the window and its job lines: the full, exact, executed
// attempts by tree key (none superseded, none incomplete), and the pull request runs' lines by head commit.
export function landingIndex(analysis, lines) {
  const exact = new Map();
  for (const a of analysis.attempts) {
    if (!observable(a)) continue;
    (exact.get(a.tree_key) ?? exact.set(a.tree_key, []).get(a.tree_key)).push(a);
  }
  for (const list of exact.values()) list.sort((x, y) => (x.available < y.available ? -1 : 1));
  const pr = new Map(); // head → run → attempt → lines
  for (const l of lines) {
    if (!PR_EVENTS.includes(l.event)) continue;
    const runs = pr.get(l.head) ?? pr.set(l.head, new Map()).get(l.head);
    const attempts = runs.get(l.run) ?? runs.set(l.run, new Map()).get(l.run);
    (attempts.get(l.attempt) ?? attempts.set(l.attempt, []).get(l.attempt)).push(l);
  }
  return { exact, pr, runs: analysis.runs };
}

const observable = (a) => a.basis === 'exact' && a.scope === 'full' && !a.copied && a.superseded_by === null && a.tree_key && (a.result === 'succeeded' || a.result === 'failed');

// Each required gate's latest full, exact attempt on the tree key, completed before `at`: `green` when each succeeded,
// `red` when one failed, `unrun` otherwise.
function verdictOn(index, required, key, at) {
  const gates = {};
  for (const g of required) {
    const a = (index.exact.get(key) ?? []).filter((x) => x.gate === g && x.available < at).at(-1);
    gates[g] = a ? { result: a.result, run: a.run, attempt: a.attempt } : null;
  }
  const all = Object.values(gates);
  const verdict = all.some((x) => x?.result === 'failed') ? 'red' : all.every((x) => x?.result === 'succeeded') ? 'green' : 'unrun';
  return { verdict, gates };
}

// The required check as it stood at the landing: the verdict job of the latest pull request run of `head` created
// before it, in that run's latest attempt begun before it. `none` when the head has no pull request run.
function prCheck(index, head, at, verdictJob) {
  const runs = [...(index.pr.get(head) ?? new Map())]
    .map(([run, attempts]) => ({ run, attempts, created: index.runs.get(run)?.created ?? null }))
    .filter((r) => r.created && r.created < at)
    .sort((x, y) => (x.created < y.created ? -1 : 1));
  const latest = runs.at(-1);
  if (!latest) return { result: 'none' };
  const begun = [...latest.attempts]
    .map(([attempt, lines]) => ({ attempt, lines, start: attempt === 1 ? latest.created : lines.filter((l) => !l.copy).map((l) => l.started).filter(Boolean).sort()[0] ?? null }))
    .filter((x) => x.start && x.start < at)
    .sort((x, y) => x.attempt - y.attempt)
    .at(-1);
  if (!begun) return { result: 'none' };
  const verdict = begun.lines.find((l) => l.job === verdictJob);
  const where = { run: latest.run, attempt: begun.attempt };
  if (!verdict) return { result: 'unrun', ...where, verdict: 'missing' };
  if (verdict.completed && verdict.completed <= at) return { result: verdict.conclusion === 'success' ? 'green' : 'red', ...where };
  return { result: 'unrun', ...where, inflight: true, eventual: verdict.conclusion };
}

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
      line.pr_check = line.head ? prCheck(index, line.head, event.at, entry.verdict_job) : { result: 'none' };
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
