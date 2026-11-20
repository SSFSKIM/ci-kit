#!/usr/bin/env node
// The gate ledger's weekly report (gate ledger spec, "The report and the status file", M4):
//   node history/report.mjs --store <dir> --repo <alias> --week <YYYY-Www>   prints the week's report (Markdown)
//   node history/report.mjs --store <dir> --write [--repo <alias>]           the daily pass: per repository, writes
//       reports/<week>.md for the current ISO week and the three before it, and status.json (status.mjs)
// A report reads a repository's job lines, cause lines and landings for its ISO week and the three before it, each
// gate attempt counted in the week its result was known (`available`), the job lines loaded with a day's margin each
// side. Over those four weeks: per gate, its attempts, runner minutes by lane (the Mac's apart), superseded and
// cancelled cost and reds by cause, and the nominations and candidates judged on them; for the week itself: the
// unattributed reds to read (each week's report lists its own) and the landings. It reads files only and makes no
// GitHub call. The report is a file of the private store and may name tests (a known entry's case, an override's
// reason): `--write` prints counts only, never a gate or a test, as every line of a collection's log does.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDays, WINDOW_DAYS } from './derive.mjs';
import { describeError } from './errors.mjs';
import { gateAttempts } from './jobs.mjs';
import { inForce, readKnown } from './known.mjs';
import { derivedAt, statusOf } from './status.mjs';
import { dayOf, openLedger, writeAtomic } from './store.mjs';

const DAY = 86_400_000;
const WEEKS = 4;
const MIN_COVERED = 21; // covered days of the window's 28
const MIN_ATTEMPTS = 20;
const RECENT_DAYS = 7; // the covered days a nomination's and a candidate's minutes are counted over
const RED_CAUSES = ['infra', 'rerun-green', 'test-only-diff', 'product-diff', 'unattributed'];
// The reds a candidate to read may have; any other (a `product-diff`, an `unattributed`, a red whose attribution is
// pending or whose cause this report does not know) keeps a gate out of both lists. A nomination's are `infra` alone.
const READABLE = new Set(['infra', 'rerun-green', 'test-only-diff']);
// The one Mac (the mini, under Actions and by hand): the scarce machine, whose minutes are shown apart.
const MAC_LANES = new Set(['mini-host', 'mini-guest', 'manual-host', 'manual-guest']);
const day = (ms) => dayOf(new Date(ms).toISOString());
const isoOf = (ms) => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
const round = (x) => Math.round(x * 10) / 10;
const keyOf = (a) => JSON.stringify([a.run, a.attempt, a.gate, a.scope_key]);

// ISO weeks: Monday to Sunday, week 1 the one holding the year's first Thursday.
export function weekOf(ms) {
  const d = new Date(ms);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const thursday = midnight + (3 - ((d.getUTCDay() + 6) % 7)) * DAY;
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
export function weekStart(week) {
  const m = /^(\d{4})-W(\d\d)$/.exec(week ?? '');
  if (!m) throw new Error(`history: a week is YYYY-Www, not ${week}`);
  const jan4 = Date.UTC(Number(m[1]), 0, 4);
  const start = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY + (Number(m[2]) - 1) * 7 * DAY;
  if (weekOf(start) !== week) throw new Error(`history: ${m[1]} has no week ${m[2]}`);
  return start;
}

// What the report reads: the files of [from, to) (ms), job lines with a day's margin each side.
export function loadRecord(root, alias, from, to) {
  const dir = join(root, alias);
  const ledger = openLedger(root, alias);
  const [a, b] = [day(from - DAY), day(to)];
  const flat = (kind) => [...readDays(join(dir, kind), a, b).values()].flat();
  return {
    lines: ledger.jobLines(a, b),
    causes: flat('causes'),
    // No landing record where the activity listing was refused or has never run.
    landings: ledger.state.activity && ledger.state.activity !== 'refused' ? flat('landings') : null,
    covered: (d) => ledger.covered(d),
    activity: ledger.state.activity ?? null,
    known: readKnown(root, alias),
    asOf: derivedAt(ledger.state),
  };
}

// The report's figures for `week`, from a loaded record (pure). `now`: the time the report is made; days from its
// own on have not ended, and it is the day the report's policy is read on: which `keep` entries hold and which known
// entries are in force, expiring or expired are what they are when the report is made, whatever week its evidence is.
export function weekModel({ week, now, entry, record }) {
  const weekFrom = weekStart(week);
  const to = weekFrom + 7 * DAY;
  const from = weekFrom - (WEEKS - 1) * 7 * DAY;
  const [fromIso, weekIso, toIso] = [from, weekFrom, to].map(isoOf);
  const inWindow = (t) => Boolean(t) && t >= fromIso && t < toIso;
  const inWeek = (t) => Boolean(t) && t >= weekIso && t < toIso;

  // Gate attempts, each counted where its result was known; copies are no execution.
  const attempts = gateAttempts(record.lines).filter((a) => !a.copied && inWindow(a.available));
  const billed = new Map(); // attempt key → its lines that carry minutes (no copy, no summary job)
  for (const l of record.lines) {
    if (l.kind !== 'gate' || l.copy || l.role === 'summary') continue;
    (billed.get(keyOf(l)) ?? billed.set(keyOf(l), []).get(keyOf(l))).push(l);
  }
  const causes = record.causes.filter((c) => inWindow(c.available));
  const caused = new Set(causes.map(keyOf));
  const gates = new Map();
  const gateOf = (gate) =>
    gates.get(gate) ??
    gates.set(gate, { gate, attempts: 0, minutes: 0, lanes: {}, mac: {}, superseded: { n: 0, minutes: 0 }, cancelled: { n: 0, minutes: 0 }, reds: {}, pending: [], week: { attempts: 0, minutes: 0 }, recent: { attempts: 0, minutes: 0, lanes: {} }, last: null }).get(gate);
  // Coverage of the window's 28 days.
  const today = day(now);
  const days = Array.from({ length: WEEKS * 7 }, (_, i) => day(from + i * DAY));
  const ended = days.filter((d) => d < today);
  const notCovered = ended.filter((d) => !record.covered(d));
  const coveredCount = ended.length - notCovered.length;
  const covered = { count: coveredCount, enough: coveredCount >= MIN_COVERED, notCovered, notEnded: days.filter((d) => d >= today) };
  // The most recent 7 covered days: what a gate costs now, which is what a nomination says removing it would free.
  const recent = new Set(ended.filter((d) => record.covered(d)).slice(-RECENT_DAYS));

  const windowLanes = new Set();
  const weekLanes = new Set();
  for (const a of attempts) {
    const g = gateOf(a.gate);
    g.attempts += 1;
    const isRecent = recent.has(day(Date.parse(a.available)));
    if (isRecent) g.recent.attempts += 1;
    if (!g.last || a.available > g.last) g.last = a.available;
    for (const l of billed.get(keyOf(a)) ?? []) {
      const lane = l.lane ?? 'no lane';
      const into = MAC_LANES.has(lane) ? g.mac : g.lanes;
      if (l.minutes) into[lane] = (into[lane] ?? 0) + l.minutes;
      g.minutes += l.minutes ?? 0;
      if (isRecent && l.minutes) {
        g.recent.minutes += l.minutes;
        g.recent.lanes[lane] = (g.recent.lanes[lane] ?? 0) + l.minutes;
      }
      if (l.lane) windowLanes.add(l.lane);
      if (l.lane && inWeek(a.available)) weekLanes.add(l.lane);
    }
    if (inWeek(a.available)) {
      g.week.attempts += 1;
      g.week.minutes += a.minutes;
    }
    if (a.result === 'failed' && !caused.has(keyOf(a))) g.pending.push(a); // its cause not derived yet
  }
  for (const c of causes) {
    const g = gateOf(c.gate);
    if (c.cause === 'superseded' || c.cause === 'cancelled') {
      g[c.cause].n += 1;
      g[c.cause].minutes += c.minutes ?? 0;
    } else (g.reds[c.cause] ??= []).push(c);
  }
  for (const g of gates.values()) {
    for (const o of [g.lanes, g.mac, g.recent.lanes]) for (const k of Object.keys(o)) o[k] = round(o[k]);
    for (const x of [g, g.superseded, g.cancelled, g.week, g.recent]) x.minutes = round(x.minutes);
    g.last = g.last?.slice(0, 10) ?? null;
    for (const list of Object.values(g.reds)) list.sort(newestFirst);
  }
  const rows = [...gates.values()].sort((x, y) => y.minutes - x.minutes || (x.gate < y.gate ? -1 : 1));

  // Too little record is a fact of its own, shown whether or not a keep entry holds the gate.
  for (const g of rows) g.thin = !covered.enough || g.attempts < MIN_ATTEMPTS;

  // Nominations and candidates.
  const known = record.known;
  const keepOf = (gate) => known.find((e) => e.keep && e.gate === gate && inForce(e, today)) ?? null;
  const [nominations, candidates, tooLittle, kept, idle] = [[], [], [], [], []];
  for (const g of rows) {
    const keep = keepOf(g.gate);
    // No attempt in the most recent covered days: probably retired or renamed, so it frees nothing now. A keep entry
    // still shows it among the kept.
    if (recent.size && g.recent.attempts === 0) idle.push({ ...g, keep });
    if (keep) kept.push({ ...g, keep });
    else if (recent.size && g.recent.attempts === 0) continue;
    else if (g.thin) tooLittle.push(g);
    else if (g.pending.length || Object.keys(g.reds).some((c) => !READABLE.has(c))) continue;
    else if (Object.keys(g.reds).some((c) => c !== 'infra')) candidates.push(g);
    else nominations.push(g);
  }

  // The week's unattributed reds, by gate.
  const toRead = rows
    .filter((g) => g.reds.unattributed)
    .map((g) => ({ gate: g.gate, reds: g.reds.unattributed.filter((c) => inWeek(c.available)), earlier: g.reds.unattributed.filter((c) => !inWeek(c.available)).length }))
    .filter((g) => g.reds.length || g.earlier);

  // The week's landings.
  let landings = null;
  if (record.landings) {
    const week = record.landings.filter((l) => inWeek(l.at)).sort((x, y) => (x.at < y.at ? -1 : 1));
    const count = (f) => week.reduce((o, l) => ((o[f(l)] = (o[f(l)] ?? 0) + 1), o), {});
    const checkOf = (l) => (!l.pr_check ? 'no check' : l.pr_check.result === 'unrun' && l.pr_check.inflight ? 'unrun in flight' : l.pr_check.result);
    const reason = (l) => {
      if (l.exact === 'red' || l.pr_check?.result === 'red') return 'red';
      if (l.head_green) return 'head_green';
      if (l.exact === 'unrun' && !l.pr_check?.inflight) return 'unrun';
      if (l.pr_check?.result === 'unrun' && !l.pr_check.inflight) return 'unrun';
      return null;
    };
    landings = {
      total: week.length,
      exact: count((l) => l.exact ?? 'unknown'),
      prCheck: count(checkOf),
      listed: week.filter(reason).map((l) => ({ ...l, reason: reason(l), check: checkOf(l) })),
      overrides: week.filter((l) => l.ship_with),
    };
  }

  const knownSplit = {
    inForce: known.filter((e) => inForce(e, today)).sort(byId),
    expiring: known.filter((e) => inForce(e, today) && e.review_by < day(now + 7 * DAY)).sort(byId),
    expired: known.filter((e) => e.review_by < today).sort(byId),
    notYet: known.filter((e) => e.since > today).sort(byId),
  };

  // Chain breaks are found by the derivation over its own input window (the 35 days before its pass, with a day's
  // margin) from where the activity listing began: the part of these four weeks that was checked.
  let landingRecord = record.activity === 'refused' ? { state: 'refused' } : !record.activity ? { state: 'never-listed' } : null;
  if (!landingRecord) {
    const derived = record.asOf ? Date.parse(record.asOf) : now;
    const checkedFrom = [day(from), day(derived - WINDOW_DAYS * DAY), (record.activity.since ?? '').slice(0, 10)].sort().at(-1);
    const checkedTo = [day(to - DAY), day(derived)].sort()[0];
    const breaks = (record.activity.breaks ?? []).filter((b) => inWindow(b.at) && b.at.slice(0, 10) >= checkedFrom);
    landingRecord = { state: 'listed', checked: checkedFrom <= checkedTo ? [checkedFrom, checkedTo] : null, breaks };
  }
  return {
    week, repo: entry.repo, hasCheck: Boolean(entry.verdict_job), from: day(from), weekFrom: day(weekFrom), to: day(to - DAY), inProgress: now < to, asOf: record.asOf, today,
    gates: rows, covered, recentDays: recent.size ? [[...recent][0], [...recent].at(-1)] : null, nominations, candidates, tooLittle, kept, idle, toRead, landings, known: knownSplit,
    landingRecord,
    quietLanes: [...windowLanes].filter((l) => !weekLanes.has(l)).sort(),
    comparesBase: (entry.compares_base ?? []).filter((g) => gates.has(g)),
    pending: rows.reduce((n, g) => n + g.pending.length, 0),
  };
}
const newestFirst = (x, y) => (x.available < y.available ? 1 : x.available > y.available ? -1 : 0);
const byId = (x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

// ---- Markdown ------------------------------------------------------------------------------------------------------

const CAUSE_TEXT = {
  infra: '`infra`: every unsuccessful job was lost (the platform said so, or a later attempt on the same tree got it past where it stopped). A lost job may still hide a fault of the change in a job that never ran.',
  'rerun-green': '`rerun-green`: a later comparable attempt on the same tree passed. That is what a flaky test looks like, and what an intermittent fault in the product looks like.',
  'test-only-diff': '`test-only-diff`: the change went green after editing only test paths. That is what a wrong test looks like, and what a weakened assertion looks like.',
  'product-diff': '`product-diff`: the change went green after editing product paths. That is what a catch looks like, and what a scene an intended change made wrong looks like.',
  unattributed: '`unattributed`: the record shows nothing about the red; its `why` says what was missing.',
  superseded: '`superseded` and `cancelled` are not reds: a newer run replaced the attempt, or someone stopped it. They say nothing of the product either way; a person may stop a hanging job before its time limit.',
};

const fmtMinutes = (m) => String(round(m));
const plural = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`;
const lanesText = (o) => Object.entries(o).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([k, v]) => `${k} ${fmtMinutes(v)}`).join(', ') || '–';
const recentText = (g) => `${fmtMinutes(g.recent.minutes)} runner minutes in the last ${RECENT_DAYS} covered days (${lanesText(g.recent.lanes)})`;
const costText = ({ n, minutes }) => (n ? `${n} (${fmtMinutes(minutes)} min)` : '–');
const cancelledText = ({ n, minutes }) => (n ? `cancelled ${n} (${fmtMinutes(minutes)} min)` : 'cancelled 0');
const time = (t) => (t ? t.replace(/:\d\d(\.\d+)?Z$/, 'Z').replace('T', ' ') : '?');

function runLink(repo, run, attempt) {
  if (typeof run !== 'number') return `hand-run ${run}`;
  return `[run ${run}${attempt > 1 ? ` attempt ${attempt}` : ''}](https://github.com/${repo}/actions/runs/${run}/attempts/${attempt})`;
}
const commitLink = (repo, sha) => `[${(sha ?? '?').slice(0, 9)}](https://github.com/${repo}/commit/${sha})`;

// Consecutive days as ranges: `a to b`.
function ranges(days) {
  const out = [];
  for (const d of days) {
    const last = out.at(-1);
    if (last && day(Date.parse(`${last[1]}T00:00:00Z`) + DAY) === d) last[1] = d;
    else out.push([d, d]);
  }
  return out.map(([a, b]) => (a === b ? a : `${a} to ${b}`)).join(', ');
}

export function renderReport(m) {
  const out = [];
  const p = (...lines) => out.push(...lines);
  p(`# ${m.repo}: gate ledger, ${m.week} (${m.weekFrom} to ${m.to})`, '');
  const record = m.asOf ? `the record is as of ${m.asOf}` : 'the record is from a pass still under way, its causes not all derived';
  p(m.inProgress ? `The week is in progress; ${record}.` : `${record[0].toUpperCase()}${record.slice(1)}.`);
  p(
    `Per gate, nominations and candidates are over four weeks, ${m.from} to ${m.to}, each gate attempt counted in the week its result was known; the reds to read and the landings are this week's. ` +
      'Runner minutes are summed over jobs, a summary job adding none: they are never elapsed time. The Mac\'s minutes (the mini, under Actions and by hand) are shown apart. Superseded and cancelled minutes are counted in the lanes too.',
    '',
  );

  p('## Per gate', '');
  const extra = m.pending > 0;
  p(`| Gate | Attempts | Minutes by lane | The Mac's minutes | Superseded | Cancelled | ${RED_CAUSES.join(' | ')}${extra ? ' | attribution pending' : ''} | This week |`);
  p(`|---|--:|---|---|--:|--:|${RED_CAUSES.map(() => '--:').join('|')}|${extra ? '--:|' : ''}---|`);
  for (const g of m.gates) {
    const reds = RED_CAUSES.map((c) => String(g.reds[c]?.length ?? 0)).join(' | ');
    p(`| \`${g.gate}\` | ${g.attempts} | ${lanesText(g.lanes)} | ${lanesText(g.mac)} | ${costText(g.superseded)} | ${costText(g.cancelled)} | ${reds}${extra ? ` | ${g.pending.length}` : ''} | ${plural(g.week.attempts, 'attempt')}, ${fmtMinutes(g.week.minutes)} min |`);
  }
  if (m.gates.length === 0) p('', 'No gate attempt in these four weeks.');
  p('');

  p('## Reds to read', '');
  p('Each gate\'s `unattributed` reds of this week, newest first: what a person reads to learn what a gate is really catching.', '');
  if (!m.toRead.some((g) => g.reds.length)) p('None this week.', '');
  for (const g of m.toRead) {
    p(`### \`${g.gate}\``, '');
    for (const c of g.reds) p(`- ${time(c.available)} ${runLink(m.repo, c.run, c.attempt)}: \`${c.why}\`, ${c.event}, ${c.basis}${c.context?.base_also_failed ? ', the default branch also failed then' : ''}${c.context?.known?.length ? `, known: ${c.context.known.map((k) => `${k.id} (${k.case_match})`).join(', ')}` : ''}`);
    if (g.earlier) p(`- ${g.earlier} earlier in the four weeks, in their own weeks' reports.`);
    p('');
  }

  p('## Nominations', '');
  const recentSpan = m.recentDays ? ` (${m.recentDays[0]} to ${m.recentDays[1]})` : '';
  p(`A gate is nominated only when its four weeks are covered (at least ${MIN_COVERED} of the 28 days covered, and at least ${MIN_ATTEMPTS} attempts), every red it had is \`infra\`, it ran in the most recent ${RECENT_DAYS} covered days, and no \`keep\` entry holds it. A person decides; nothing here removes a check.`, '');
  p(`A nomination's and a candidate's minutes are those of the most recent ${RECENT_DAYS} covered days${recentSpan}, what the gate costs now; the four weeks' total is beside them for scale.`, '');
  if (!m.covered.enough) p(`These four weeks hold ${m.covered.count} covered days of the ${MIN_COVERED} a nomination needs: no gate can be nominated.`, '');
  if (m.nominations.length === 0) p('None.');
  for (const g of m.nominations) {
    const infra = g.reds.infra?.length ?? 0;
    const kind = infra ? `${infra} \`infra\` red${infra === 1 ? '' : 's'} in ${g.attempts} attempts, 0 other` : `0 reds in ${g.attempts} attempts`;
    p(`- \`${g.gate}\`: ${kind}; ${recentText(g)}, which removing or demoting it would free on those lanes, of ${fmtMinutes(g.minutes)} in the four weeks; ${cancelledText(g.cancelled)}.`);
  }
  p('', '### Candidates to read', '');
  p('A covered gate whose reds are only `rerun-green` or `test-only-diff` (and `infra`). A rerun\'s pass does not rule out an intermittent product fault, and a test-only change may have weakened the test: nothing is proposed for these gates. A person who has read the reds below may.', '');
  if (m.candidates.length === 0) p('None.');
  for (const g of m.candidates) {
    const reds = ['rerun-green', 'test-only-diff'].flatMap((c) => (g.reds[c] ?? []).map((r) => `${c} ${runLink(m.repo, r.run, r.attempt)}`));
    p(`- \`${g.gate}\`: ${g.attempts} attempts, ${recentText(g)}, of ${fmtMinutes(g.minutes)} in the four weeks; ${cancelledText(g.cancelled)}; reds: ${reds.join(', ')}.`);
  }
  p('', '### No attempts in the last week', '');
  p(`A gate with attempts in the four weeks and none in the most recent ${RECENT_DAYS} covered days${recentSpan}: it has probably been retired or renamed, and removing it would free nothing now. Neither nominated nor a candidate.`, '');
  if (m.idle.length === 0) p('None.');
  for (const g of m.idle) p(`- \`${g.gate}\`: last attempt ${g.last}, ${plural(g.attempts, 'attempt')} in the four weeks${g.keep ? `; held by ${g.keep.id}` : ''}.`);
  p('', '### Too little record', '');
  p(`Fewer than ${MIN_COVERED} covered days in the four weeks (${m.covered.count} here), or fewer than ${MIN_ATTEMPTS} attempts: never nominated.`, '');
  if (m.tooLittle.length === 0) p('None.');
  for (const g of m.tooLittle) p(`- \`${g.gate}\`: ${plural(g.attempts, 'attempt')}.`);
  if (m.kept.length) {
    p('', '### Kept', '');
    for (const g of m.kept) p(`- \`${g.gate}\`: ${g.keep.id} (review by ${g.keep.review_by}): ${g.keep.reason}${g.thin ? ` Too little record: ${plural(g.attempts, 'attempt')}, ${m.covered.count} covered days.` : ''}`);
  }
  p('');

  p('## Landings', '');
  if (!m.landings) p(m.landingRecord.state === 'refused' ? 'This repository has no landing record: its activity listing is refused.' : 'This repository has no landing record yet: its activity listing has not run.', '');
  else {
    const counts = (o) => Object.entries(o).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
    const check = m.hasCheck ? `\`pr_check\` (what the required check saw): ${counts(m.landings.prCheck)}.` : 'The repository has no required check: no `pr_check`.';
    p(`${m.landings.total} landings this week. \`exact\` (did the landed tree run, in full, and pass): ${counts(m.landings.exact)}. ${check}`, '');
    if (m.landings.listed.length) {
      p('Red, unrun and not in flight, or gated only at the branch head (`head_green`):', '');
      for (const l of m.landings.listed) p(`- ${commitLink(m.repo, l.after)} ${time(l.at)}${l.pr ? ` #${l.pr}` : ''}: ${l.reason}; exact ${l.exact ?? 'unknown'}, pr_check ${l.check}`);
      p('');
    }
    if (m.landings.overrides.length) {
      p('Overrides (`Ship-with:`):', '');
      for (const l of m.landings.overrides) p(`- ${commitLink(m.repo, l.after)}${l.pr ? ` #${l.pr}` : ''}: ${l.ship_with}`);
      p('');
    }
  }

  p('## Known entries', '');
  const entry = (e) => `- ${e.id}: \`${e.gate}\`${e.case ? ` (${e.case})` : ''}${e.keep ? ', keep' : ''}, review by ${e.review_by}: ${e.reason}`;
  const groups = [['In force', m.known.inForce], ['Expiring within a week', m.known.expiring], ['Expired', m.known.expired], ['Not yet in force', m.known.notYet]];
  if (groups.every(([, list]) => list.length === 0)) p('None recorded.', '');
  else {
    for (const [title, list] of groups) {
      if (title === 'Not yet in force' && list.length === 0) continue;
      p(`${title} on ${m.today}:`, '', ...(list.length ? list.map(entry) : ['None.']), '');
    }
  }

  p('## What the record cannot say', '');
  for (const c of [...RED_CAUSES, 'superseded']) p(`- ${CAUSE_TEXT[c]}`);
  p(`- Days not covered in the four weeks: ${m.covered.notCovered.length ? ranges(m.covered.notCovered) : 'none'}${m.covered.notEnded.length ? `; ${ranges(m.covered.notEnded)} not yet ended` : ''}.`);
  p(`- Lanes with lines in the four weeks and none this week: ${m.quietLanes.length ? m.quietLanes.join(', ') : 'none'}.`);
  const lr = m.landingRecord;
  if (lr.state === 'refused') p('- This repository has no landing record (its activity listing is refused): its landings and the default branch\'s movement under rule 2 are unknown.');
  else if (lr.state === 'never-listed') p('- This repository has no landing record yet (its activity listing has not run): its landings and the default branch\'s movement under rule 2 are unknown.');
  else if (!lr.checked) p('- Landing record: chain breaks were not checked for these four weeks (the check reaches back 35 days from its pass).');
  else {
    const n = lr.breaks.length;
    const span = `${lr.checked[0]} to ${lr.checked[1]}, the part of these four weeks the derivation checked`;
    if (n === 0) p(`- Landing record: no chain break from ${span}.`);
    else p(`- Landing record: ${n} chain break${n === 1 ? '' : 's'} from ${span}, a landing the activity listing lacks before each (before ${lr.breaks.map((b) => time(b.at)).join(', ')}).`);
  }
  if (m.pending) p(`- ${m.pending} failed attempts await attribution (their causes not derived yet): their gates are neither nominated nor candidates until they are.`);
  if (m.comparesBase.length) p(`- Gates that compare with the default branch of the moment: ${m.comparesBase.map((g) => `\`${g}\``).join(', ')}. Two runs of one tree can differ, so their \`rerun-green\` says the base moved as often as it says anything about the test.`);
  return `${out.join('\n')}\n`;
}

// The report of `week` for one repository. → { model, text }.
export function weekReport({ root, alias, entry, week, now = Date.now() }) {
  const start = weekStart(week);
  const record = loadRecord(root, alias, start - (WEEKS - 1) * 7 * DAY, start + 7 * DAY);
  const model = weekModel({ week, now, entry, record });
  return { model, text: renderReport(model) };
}

// The daily pass: per repository with a directory in the store, the current week's report and the three before it,
// and status.json, each written only when its bytes change. → [{ alias, reports, weeks, gates, failed, known }].
export function writeAll({ root, repos, now = Date.now() }) {
  const out = [];
  const current = weekStart(weekOf(now));
  const weeks = Array.from({ length: WEEKS }, (_, i) => weekOf(current - (WEEKS - 1 - i) * 7 * DAY));
  for (const entry of repos) {
    if (!existsSync(join(root, entry.alias, 'attempts.json'))) continue;
    // One load for the four reports: from the earliest one's window to the current week's end.
    const record = loadRecord(root, entry.alias, current - (2 * WEEKS - 2) * 7 * DAY, current + 7 * DAY);
    let reports = 0;
    for (const week of weeks) {
      const text = renderReport(weekModel({ week, now, entry, record }));
      if (writeIfChanged(join(root, entry.alias, 'reports', `${week}.md`), text)) reports += 1;
    }
    const status = statusOf({ root, alias: entry.alias, entry, now });
    writeIfChanged(join(root, entry.alias, 'status.json'), `${JSON.stringify(status, null, 1)}\n`);
    const gates = Object.values(status.gates);
    out.push({ alias: entry.alias, reports, weeks: weeks.length, gates: gates.length, failed: gates.filter((g) => g.result === 'failed').length, known: status.known.length });
  }
  return out;
}
const writeIfChanged = (path, text) => {
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
  writeAtomic(path, text);
  return true;
};

export const formatWritten = (c) => `${c.alias}: reports ${c.reports} written of ${c.weeks}, status gates ${c.gates} (failed ${c.failed}), known in force ${c.known}`;

const USAGE = 'history: usage: report.mjs --store <dir> (--repo <alias> --week <YYYY-Www> | --write [--repo <alias>])';
export function parseArgs(argv) {
  const opts = { store: null, repo: null, week: null, write: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--store') opts.store = argv[++i];
    else if (argv[i] === '--repo') opts.repo = argv[++i];
    else if (argv[i] === '--week') opts.week = argv[++i];
    else if (argv[i] === '--write') opts.write = true;
    else throw new Error(`history: unknown argument ${argv[i]}\n${USAGE}`);
  }
  if (!opts.store || (!opts.write && (!opts.repo || !opts.week)) || (opts.write && opts.week)) throw new Error(USAGE);
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const repos = JSON.parse(readFileSync(new URL('./repos.json', import.meta.url), 'utf8'));
  const chosen = opts.repo ? repos.filter((r) => r.alias === opts.repo) : repos;
  if (chosen.length === 0) throw new Error(`history: ${opts.repo} is not in history/repos.json`);
  if (opts.write) {
    for (const c of writeAll({ root: opts.store, repos: chosen })) console.log(`history: ${formatWritten(c)}`);
    return;
  }
  process.stdout.write(weekReport({ root: opts.store, alias: chosen[0].alias, entry: chosen[0], week: opts.week }).text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`report: ${describeError(err)}`); // what it failed on (a file's text) is never printed
    process.exit(1);
  }
}
