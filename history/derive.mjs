// The gate ledger's derived lines (gate ledger spec, M3), written once a pass when a repository's job lines are in:
//   landings/<YYYY-MM-DD>.jsonl   one line per update of the default branch, by its push day (landings.mjs)
//   causes/<YYYY-MM-DD>.jsonl     one line per red gate attempt, by the day its result was known (cause.mjs)
// Both are recomputed while younger than 14 days, then final: an older day's lines are left as they are, its file
// read only when a line computed now (a red that arrived late) falls on it, and only lines of keys it lacks join it.
// A first derivation (no lines held), or one asked from a day (`from`), computes every line from that day on. Files
// are chosen by their day's name before any is read: the job lines, landings and test records of the 35-day window
// with a day's margin each side (a batch that crosses midnight sees the next day's jobs), and the causes of the
// recompute window.
// New landings come from the activity listing, a page of 100 a call. What it has covered is kept in attempts.json,
// apart from the derived files: `activity: { since, through, breaks }`, the listing reaching back to `since` once and
// on from the newest landing listed (`through`) after, so a first listing that failed is taken again from the start;
// it advances only once the landings it covers are written. `breaks`: the window's landings whose `before` no landing
// left the branch at (a landing the listing lacks). A repository whose listing is refused has no landing record
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
const ZERO = /^0{40}$/;
// The days a directory has a file for, by name only.
const dayFiles = (dir) => (existsSync(dir) ? readdirSync(dir).map((n) => DAYFILE.exec(n)?.[1]).filter(Boolean).sort() : []);
// The lines of the days in [fromDay, toDay], chosen by name before any is read.
const readDays = (dir, fromDay, toDay) => {
  const out = new Map();
  for (const day of dayFiles(dir).filter((d) => d >= fromDay && d <= toDay)) {
    out.set(day, readFileSync(join(dir, `${day}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
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

// Held lines kept where final (their day before `from`), computed lines elsewhere and wherever none is held, by key:
// a final day keeps its lines as they are and gains only lines of new keys (a red that arrived late); by day.
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
function failedCases(dir, fromDay, toDay) {
  const out = new Map();
  for (const lines of readDays(join(dir, 'runs'), fromDay, toDay).values()) {
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
  const day = (ms) => dayOf(new Date(ms).toISOString());
  const windowStart = day(now - (WINDOW_DAYS - 1) * DAY);
  const [inputFrom, inputTo] = [day(now - WINDOW_DAYS * DAY), day(now + DAY)];
  const [landingsDir, causesDir] = [join(dir, 'landings'), join(dir, 'causes')];
  const first = dayFiles(landingsDir).length === 0 && dayFiles(causesDir).length === 0;
  // Never before the job lines' window: a day before it has nothing to compute from.
  const asked = from && from > windowStart ? from : from ? windowStart : null;
  const recomputeFrom = asked ?? (first ? windowStart : day(now - FINAL_DAYS * DAY));
  const heldLandings = readDays(landingsDir, inputFrom, inputTo);
  const errors = [];
  let paced = false;
  const counts = { listed: 0, landings: 0, breaks: 0, causes: {} };
  const { state } = ledger;

  // 1. New landings from the activity listing: from the window's start until a listing has once reached it, then on
  //    from the newest landing listed.
  const held = [...heldLandings.values()].flat();
  const events = new Map(held.map((l) => [l.id, { id: l.id, type: l.type, before: l.before, after: l.after, at: l.at }]));
  let landingsKnown = state.activity !== 'refused';
  const covered = landingsKnown && state.activity ? state.activity : null;
  let activity = covered; // what the listing will have covered, kept in state once the landings are written
  const backfill = `${windowStart}T00:00:00Z`;
  let listed = false; // this pass's listing reached back to where the record left off: the record is whole
  if (landingsKnown) {
    let since = covered && covered.since <= backfill ? covered.through : backfill;
    if (asked && `${asked}T00:00:00Z` < since) since = `${asked}T00:00:00Z`;
    try {
      let through = covered?.through ?? since;
      for (const e of await listActivity(gh, repo, entry.default_branch, { since })) {
        counts.listed += 1;
        // A landing before the input window was written while it was in it: the listing from the watermark can
        // return it again, and its day is not loaded, so it stays out of what is written.
        if (!events.has(e.id) && dayOf(e.at) >= inputFrom) events.set(e.id, e);
        if (e.at > through) through = e.at;
      }
      listed = true;
      activity = { since: covered && covered.since < since ? covered.since : since, through, breaks: covered?.breaks ?? [] };
    } catch (err) {
      if (err instanceof BudgetSpent) paced = true; // the next pass lists
      else if ([403, 404].includes(err.status) && !isRateLimited(err)) {
        state.activity = 'refused';
        [activity, landingsKnown] = [null, false];
      } else errors.push(`activity: ${describeError(err)}`);
    }
  }

  // 2. The mirror: every pull request's head, and the commits the landings to compute name.
  const heldIds = new Set(held.map((l) => l.id));
  const toCompute = [...events.values()].filter((e) => dayOf(e.at) >= recomputeFrom || !heldIds.has(e.id));
  const pulls = entry.verdict_job && mirror.fetchPulls() ? mirror.pulls() : new Map();
  mirror.fetch(toCompute.flatMap((e) => [e.before, e.after]));

  // 3. Landings.
  const lines = ledger.jobLines(inputFrom, inputTo);
  const created = Object.fromEntries(Object.entries(state.runs ?? {}).filter(([, r]) => r.created).map(([id, r]) => [id, r.created]));
  const analysis = analyze(lines, { created });
  const index = landingIndex(analysis, lines, state.runs ?? {});
  const computedLandings = toCompute.map((e) => landingLine(e, { entry, mirror, index, pulls }));
  const landingDays = landingsKnown
    ? merged(heldLandings, computedLandings, { keyOf: (l) => l.id, dayOfLine: (l) => dayOf(l.at), from: recomputeFrom, order: byTime('at') })
    : new Map();
  const landings = landingsKnown ? [...landingDays.values()].flat().sort(byTime('at')) : null;
  counts.landings = landings?.length ?? 0;
  // The chain: each landing moves the branch from where another left it. One whose `before` no landing of the record
  // left the branch at starts a chain; past the first start (where the record begins), each start is a break: a
  // landing is missing before it. Linked by commit, not by time: GitHub's times run out of order around the
  // fall-back hour (MAWS's and cua's 2026-11-01 09:00-12:00Z), which is no gap.
  if (landings && activity) {
    const afters = new Set(landings.map((l) => l.after));
    const starts = landings.filter((l) => !afters.has(l.before) && !ZERO.test(l.before ?? ''));
    activity = { ...activity, breaks: starts.slice(landings.some((l) => ZERO.test(l.before ?? '')) ? 0 : 1).map((l) => ({ at: l.at, id: l.id })) };
    counts.breaks = activity.breaks.length;
  }

  // 4. Causes: a first pass learns which trees' differences are asked for, so the heads holding them are fetched in
  //    one request; the second reads them.
  const observations = observationsOf({ analysis, landings, entry });
  const headOfTree = new Map(analysis.attempts.filter((a) => a.basis === 'exact' && a.tree).map((a) => [a.tree, a.head]));
  const wanted = new Set();
  // Whether the base moved between two pull request runs is read only from a record this pass's listing made whole.
  const record = listed ? { since: [activity.since, `${inputFrom}T00:00:00Z`].sort().at(-1), events: landings } : null;
  const inputs = {
    analysis, entry, record, standing: observations.standing, known: readKnown(root, alias), casesOf: failedCases(dir, inputFrom, inputTo),
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
  // The causes held: the recompute window's, and a final day's only where a line computed now falls on it.
  const finalDays = new Set(dayFiles(causesDir).filter((d) => d < recomputeFrom));
  const lateDays = [...new Set(computedCauses.map((c) => dayOf(c.available)))].filter((d) => finalDays.has(d));
  const heldCauses = new Map([...readDays(causesDir, recomputeFrom, inputTo), ...lateDays.map((d) => [d, readDays(causesDir, d, d).get(d)])]);
  const causeDays = merged(heldCauses, computedCauses, { keyOf: causeKey, dayOfLine: (c) => dayOf(c.available), from: recomputeFrom, order: byTime('available') });
  for (const c of [...causeDays.values()].flat()) counts.causes[c.cause] = (counts.causes[c.cause] ?? 0) + 1;

  counts.written = (landingsKnown ? writeDays(landingsDir, landingDays) : 0) + writeDays(causesDir, causeDays);
  // The listing's coverage advances only once the landings it covers are written.
  if (activity) state.activity = activity;
  counts.refused = !landingsKnown;
  counts.seconds = Math.round((Date.now() - started) / 1000);
  return { counts, errors, paced };
}

const CAUSES = ['superseded', 'cancelled', 'infra', 'rerun-green', 'test-only-diff', 'product-diff', 'unattributed'];
export const formatDerived = (repo, c, errors) =>
  `${repo}: derived: landings ${c.refused ? 'refused' : c.landings} (listed ${c.listed}, chain breaks ${c.breaks ?? 0}), causes ${CAUSES.map((k) => `${k} ${c.causes[k] ?? 0}`).join(', ')}, files written ${c.written}, errors ${errors}, ${c.seconds} s`;
