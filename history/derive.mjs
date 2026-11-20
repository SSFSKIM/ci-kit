// The gate ledger's derived lines (gate ledger spec, M3), written once a pass when a repository's job lines are in:
//   landings/<YYYY-MM-DD>.jsonl   one line per update of the default branch, by its push day (landings.mjs)
//   causes/<YYYY-MM-DD>.jsonl     one line per red gate attempt, by the day its result was known (cause.mjs)
// Both are recomputed while younger than 14 days, then final: an older line is kept as it is, and only an attempt or
// a landing with no line yet gets one. A first derivation (no lines held), or one asked from a day (`from`), computes
// every line from that day on. New landings come from the activity listing, a page of 100 a call, back to the newest
// landing held; a repository whose listing is refused has no landing record, said once in attempts.json
// (`activity: "refused"`). It prints nothing of what it reads: its counts name causes and days only.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BudgetSpent, isRateLimited } from '../lib/github.mjs';
import { analyze, deriveCauses } from './cause.mjs';
import { describeError } from './errors.mjs';
import { readKnown } from './known.mjs';
import { landingIndex, landingLine, listActivity, observationsOf } from './landings.mjs';
import { dayOf, writeAtomic } from './store.mjs';

const DAY = 86_400_000;
export const FINAL_DAYS = 14;
export const WINDOW_DAYS = 35;

const DAYFILE = /^(\d{4}-\d\d-\d\d)\.jsonl$/;
const readDir = (dir) => {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const day = DAYFILE.exec(name)?.[1];
    if (day) out.set(day, readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  }
  return out;
};
// Writes each day's lines whole, a day whose bytes are unchanged untouched. → files written.
const writeDays = (dir, days) => {
  let written = 0;
  for (const [day, lines] of [...days].sort()) {
    const path = join(dir, `${day}.jsonl`);
    const text = lines.map((l) => `${JSON.stringify(l)}\n`).join('');
    if (existsSync(path) && readFileSync(path, 'utf8') === text) continue;
    writeAtomic(path, text);
    written += 1;
  }
  return written;
};

// Held lines kept where final (their day before `from`), computed lines elsewhere and wherever none is held; by day.
function merged(held, computed, { keyOf, dayOfLine, from, order }) {
  const days = new Map();
  const heldKeys = new Set();
  for (const [day, lines] of held) {
    if (day >= from) continue;
    days.set(day, [...lines]);
    for (const l of lines) heldKeys.add(keyOf(l));
  }
  for (const l of computed) {
    const day = dayOfLine(l);
    if (day < from && heldKeys.has(keyOf(l))) continue;
    (days.get(day) ?? days.set(day, []).get(day)).push(l);
  }
  for (const lines of days.values()) lines.sort(order);
  // A day held from `from` on with nothing computed for it any more is written empty, not left stale.
  for (const day of held.keys()) if (day >= from && !days.has(day)) days.set(day, []);
  return days;
}

const causeKey = (c) => JSON.stringify([c.run, c.attempt, c.gate, c.scope_key]);
const byTime = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : String(a.run ?? a.id) < String(b.run ?? b.id) ? -1 : 1);

// The failing cases the per-test record holds for an attempt's job (runs/<day>.jsonl, a present report's `failed`).
function failedCases(dir, fromDay) {
  const out = new Map();
  for (const [day, lines] of readDir(join(dir, 'runs'))) {
    if (day < fromDay) continue;
    for (const l of lines) if (l.report === 'present') out.set(`${l.run}/${l.attempt}/${l.job}`, (l.failed ?? []).map((f) => f.id));
  }
  return (run, attempt, gate) => out.get(`${run}/${attempt}/${gate}`) ?? null;
}

// A pull request run's branch → its pull request, where the mirror's pull request heads name exactly one for the
// heads its runs tested (a branch name reused by a later pull request names two, and keeps its name).
function pullsByBranch(lines, pulls) {
  const byHead = new Map();
  for (const [n, head] of pulls) (byHead.get(head) ?? byHead.set(head, new Set()).get(head)).add(n);
  const byBranch = new Map();
  for (const l of lines) {
    if (l.basis !== 'pr-merge' || !l.ref) continue;
    for (const n of byHead.get(l.head) ?? []) (byBranch.get(l.ref) ?? byBranch.set(l.ref, new Set()).get(l.ref)).add(n);
  }
  return (branch) => {
    const found = byBranch.get(branch);
    return found?.size === 1 ? [...found][0] : null;
  };
}

// One repository's derivation. `ledger`: its openLedger store, its job lines in; `gh`: the client (admitted by the
// collector's pacer); `from`: a day to compute every line from, else the recompute window's. → { counts, errors }.
export async function deriveRepo({ gh, repo, alias = repo, entry, root, ledger, mirror, now = Date.now(), from = null }) {
  const started = Date.now();
  const dir = join(root, alias);
  const today = dayOf(new Date(now).toISOString());
  const windowStart = dayOf(new Date(now - (WINDOW_DAYS - 1) * DAY).toISOString());
  const heldLandings = readDir(join(dir, 'landings'));
  const heldCauses = readDir(join(dir, 'causes'));
  const first = heldLandings.size === 0 && heldCauses.size === 0;
  // Never before the job lines' window: a day before it has nothing to compute from.
  const asked = from && from > windowStart ? from : from ? windowStart : null;
  const recomputeFrom = asked ?? (first ? windowStart : dayOf(new Date(now - FINAL_DAYS * DAY).toISOString()));
  const errors = [];
  let paced = false;
  const counts = { listed: 0, landings: 0, causes: {} };
  const { state } = ledger;

  // 1. New landings from the activity listing.
  const held = [...heldLandings.values()].flat();
  const events = new Map(held.map((l) => [l.id, { id: l.id, type: l.type, before: l.before, after: l.after, at: l.at }]));
  let landingsKnown = state.activity !== 'refused';
  let listed = false; // the listing reached back to `since`: the record of the default branch's moves is whole
  if (landingsKnown) {
    const newest = held.map((l) => l.at).sort().at(-1);
    const since = asked || !newest ? `${recomputeFrom}T00:00:00Z` : newest;
    try {
      for (const e of await listActivity(gh, repo, entry.default_branch, { since })) {
        counts.listed += 1;
        if (!events.has(e.id)) events.set(e.id, e);
      }
      listed = true;
    } catch (err) {
      if (err instanceof BudgetSpent) paced = true; // the next pass lists
      else if ([403, 404].includes(err.status) && !isRateLimited(err)) {
        state.activity = 'refused';
        landingsKnown = false;
      } else errors.push(`activity: ${describeError(err)}`);
    }
  }

  // 2. The mirror: every pull request's head, and the commits landings name.
  const pulls = entry.verdict_job && mirror.fetchPulls() ? mirror.pulls() : new Map();
  mirror.fetch([...events.values()].flatMap((e) => [e.before, e.after]));

  // 3. Landings.
  const lines = ledger.jobLines(dayOf(new Date(now - WINDOW_DAYS * DAY).toISOString()), today);
  const created = Object.fromEntries(Object.entries(state.runs ?? {}).filter(([, r]) => r.created).map(([id, r]) => [id, r.created]));
  const analysis = analyze(lines, { created });
  const index = landingIndex(analysis, lines);
  const heldIds = new Set(held.map((l) => l.id));
  const computedLandings = [...events.values()]
    .filter((e) => dayOf(e.at) >= recomputeFrom || !heldIds.has(e.id))
    .map((e) => landingLine(e, { entry, mirror, index, pulls }));
  const landingDays = landingsKnown
    ? merged(heldLandings, computedLandings, { keyOf: (l) => l.id, dayOfLine: (l) => dayOf(l.at), from: recomputeFrom, order: byTime('at') })
    : new Map();
  const landings = landingsKnown ? [...landingDays.values()].flat() : null;
  counts.landings = landings?.length ?? 0;

  // 4. Causes: a first pass learns which trees' differences are asked for, so the heads holding them are fetched in
  //    one request; the second reads them.
  const observations = observationsOf({ analysis, landings, entry });
  const headOfTree = new Map(analysis.attempts.filter((a) => a.basis === 'exact' && a.tree).map((a) => [a.tree, a.head]));
  const wanted = new Set();
  // Whether the base moved between two pull request runs is read only from a whole record.
  const inputs = {
    analysis, entry, landings: listed ? landings : null, standing: observations.standing, known: readKnown(root, alias), casesOf: failedCases(dir, windowStart),
    prOf: pullsByBranch(lines, pulls), from: windowStart,
  };
  deriveCauses({ ...inputs, paths: (a, b) => (wanted.add(a).add(b), null) });
  mirror.fetch([...wanted].map((t) => headOfTree.get(t)).filter(Boolean));
  const paths = (a, b) => {
    try {
      return mirror.paths(a, b);
    } catch {
      return null; // a tree the mirror could not get
    }
  };
  const computedCauses = deriveCauses({ ...inputs, paths });
  const causeDays = merged(heldCauses, computedCauses, { keyOf: causeKey, dayOfLine: (c) => dayOf(c.available), from: recomputeFrom, order: byTime('available') });
  for (const c of [...causeDays.values()].flat()) counts.causes[c.cause] = (counts.causes[c.cause] ?? 0) + 1;

  counts.written = (landingsKnown ? writeDays(join(dir, 'landings'), landingDays) : 0) + writeDays(join(dir, 'causes'), causeDays);
  counts.refused = !landingsKnown;
  counts.seconds = Math.round((Date.now() - started) / 1000);
  return { counts, errors, paced };
}

const CAUSES = ['superseded', 'infra', 'rerun-green', 'test-only-diff', 'product-diff', 'unattributed'];
export const formatDerived = (repo, c, errors) =>
  `${repo}: derived: landings ${c.refused ? 'refused' : c.landings} (listed ${c.listed}), causes ${CAUSES.map((k) => `${k} ${c.causes[k] ?? 0}`).join(', ')}, files written ${c.written}, errors ${errors}, ${c.seconds} s`;
