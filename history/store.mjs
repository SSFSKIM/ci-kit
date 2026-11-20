// The store directory (test history spec, Design "Store"; gate ledger spec, "The per-test record, kept small"): under
// <root>/<alias>/ (default alias: owner/repo),
//   runs/<YYYY-MM-DD>.jsonl              one line per (run, attempt, job), by the job's completion day (UTC)
//   base/<YYYY-MM-DD>/<job>.json.gz      the day's first complete unselected report, whose hashes a line is read against
//   durations/<YYYY-MM-DD>/<job>.json.gz the day's last unselected green report's file durations
//   record.json                          when the run lines of the old shape were rewritten small (rewriteRecord)
// A pass reads the run lines of the last 35 days (the previous-run search reaches a re-run or a resumed change weeks
// back; a line's memory is its counts and failed cases, not its membership); writes are staged and flushed at the
// end, each file only when its bytes change.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { isSlim, jobSlug, lineKey, mergeLines, slimLine } from './record.mjs';

const DAY = /^(\d{4}-\d\d-\d\d)\.jsonl$/;

// Every store file is written whole or not at all: to a temporary beside it, then renamed into place. The workflow
// commits and pushes the store after a batch that ended with errors, so a write cut short (a full disk, an I/O error)
// must never leave a truncated file to publish. `io.write` is the one write, replaced by tests.
export const io = { write: writeFileSync };
export function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    io.write(tmp, data);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
export const dayOf = (iso) => iso.slice(0, 10);
export const RECENT_DAYS = 35; // the gate ledger's window: reruns are possible for 30 days

const readLines = (path) => readFileSync(path, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
const readGz = (path) => (existsSync(path) ? JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) : null);
const gzPathOf = (dir, kind, day, job) => join(dir, kind, day, `${jobSlug(job)}.json.gz`);
const daysIn = (dir) => (existsSync(dir) ? readdirSync(dir).map((n) => DAY.exec(n)?.[1]).filter(Boolean).sort() : []);
const readDayIn = (dir, day) => {
  const path = join(dir, `${day}.jsonl`);
  return existsSync(path) ? readLines(path) : [];
};
const jsonl = (lines) => lines.map((l) => `${JSON.stringify(l)}\n`).join('');

// The one-time rewrite of the run lines to the small shape, every day of them, a day at a time (memory bounded by a
// day's file), each line from the exact membership it holds (record.mjs slimLine). Marked in record.json once every
// day is written, so a pass that dies on the way does it again; the lines of the old shape stay in the branch's
// history. → null when the store is marked already, else { days, lines, rewritten, unverified }.
export function rewriteRecord(root, alias, now = Date.now()) {
  const dir = join(root, alias);
  const markPath = join(dir, 'record.json');
  if (existsSync(markPath) && JSON.parse(readFileSync(markPath, 'utf8')).slim) return null;
  const runsDir = join(dir, 'runs');
  const counts = { days: 0, lines: 0, rewritten: 0, unverified: 0 };
  for (const day of daysIn(runsDir)) {
    const path = join(runsDir, `${day}.jsonl`);
    const bases = new Map();
    const baseOf = (job) => {
      if (!bases.has(job)) bases.set(job, readGz(gzPathOf(dir, 'base', day, job)));
      return bases.get(job);
    };
    const out = readLines(path).map((l) => {
      if (isSlim(l)) return l;
      const { line, verified } = slimLine(l, baseOf(l.job));
      counts.rewritten += 1;
      if (!verified) counts.unverified += 1;
      return line;
    });
    counts.days += 1;
    counts.lines += out.length;
    const text = jsonl(out);
    if (readFileSync(path, 'utf8') !== text) writeAtomic(path, text);
  }
  writeAtomic(markPath, `${JSON.stringify({ v: 1, slim: new Date(now).toISOString() })}\n`);
  return counts;
}

// `now`: the pass's time, which sets the 35 days it loads.
export function openStore(root, alias, { now = Date.now() } = {}) {
  const dir = join(root, alias);
  const lines = [];
  const runsDir = join(dir, 'runs');
  const from = dayOf(new Date(now - (RECENT_DAYS - 1) * 86_400_000).toISOString());
  for (const day of daysIn(runsDir).filter((d) => d >= from)) lines.push(...readLines(join(runsDir, `${day}.jsonl`)));
  const staged = new Map(); // day → lines
  const replacing = new Map(); // day → lines that replace the held line of their key
  const stage = (into, line) => {
    const day = dayOf(line.completed);
    into.set(day, [...(into.get(day) ?? []), line]);
  };
  const gz = new Map(); // path → object (read or staged)
  const dirty = new Set(); // gz paths to write

  const gzPath = (kind, day, job) => gzPathOf(dir, kind, day, job);
  const getGz = (path) => {
    if (!gz.has(path)) gz.set(path, readGz(path));
    return gz.get(path);
  };
  // A line of the old shape among them (a collector from before the rewrite wrote it since) is held small at once and
  // written small by this pass's flush.
  for (const [i, l] of lines.entries()) {
    if (isSlim(l)) continue;
    lines[i] = slimLine(l, getGz(gzPath('base', dayOf(l.completed), l.job))).line;
    stage(replacing, lines[i]);
  }
  const held = new Map(lines.map((l) => [lineKey(l), l]));
  const setGz = (path, obj) => {
    gz.set(path, obj);
    dirty.add(path);
  };

  return {
    lines: () => [...held.values()],
    line: (key) => held.get(key) ?? null,
    // An artifact is known to the line of the attempt that uploaded it only: a line that copied a shard from an
    // earlier attempt leaves that attempt's artifact listed, so the earlier attempt is still taken if it has no line.
    artifactIds: () => new Set(lines.flatMap((l) => [l.artifact, ...(l.shards ?? []).filter((s) => s.attempt === l.attempt).map((s) => s.artifact)]).filter(Boolean).map((a) => a.id)),
    base: (day, job) => getGz(gzPath('base', day, job)),
    setBase: (day, job, base) => setGz(gzPath('base', day, job), base),
    durations: (day, job) => getGz(gzPath('durations', day, job)),
    setDurations: (day, job, d) => setGz(gzPath('durations', day, job), d),
    add(line) {
      stage(staged, line);
      const prior = held.get(lineKey(line));
      if (!prior || (prior.report === 'missing' && line.report !== 'missing')) held.set(lineKey(line), line);
    },
    // A held line rewritten (its previous run linked again): it replaces the line of its key, whatever that holds.
    replace(line) {
      stage(replacing, line);
      held.set(lineKey(line), line);
    },
    // Writes the bases first, so no run line is ever on disk before the base it refers to. → files written.
    flush() {
      let written = 0;
      const write = (path, bytes) => {
        if (existsSync(path) && Buffer.compare(readFileSync(path), bytes) === 0) return;
        writeAtomic(path, bytes);
        written += 1;
      };
      const bases = [...dirty].filter((p) => p.startsWith(join(dir, 'base')));
      for (const path of [...bases, ...[...dirty].filter((p) => !bases.includes(p))]) {
        write(path, gzipSync(JSON.stringify(gz.get(path)), { level: 9 }));
      }
      for (const day of [...new Set([...staged.keys(), ...replacing.keys()])].sort()) {
        const path = join(runsDir, `${day}.jsonl`);
        const merged = mergeLines(existsSync(path) ? readLines(path) : [], staged.get(day) ?? [], replacing.get(day) ?? []);
        write(path, Buffer.from(jsonl(merged)));
      }
      return written;
    },
  };
}

// The gate ledger's files under <root>/<alias>/ (gate ledger spec, "One collector, one store, more kinds of line"):
//   attempts.json              which (run, attempt) pairs are collected, which are still open, when each day was listed,
//                              the pass under way (its listing's queue and its calls) and the calls of the last hour
//   jobs/<YYYY-MM-DD>.jsonl    one line per job of a gate run, by the job's completion day (UTC); a copy by its
//                              gate attempt's availability (jobs.mjs filingTime)
//   jobs-manual/<YYYY-MM-DD>.jsonl  the same for the hand-run Mac gate (history/manual-gate.mjs), written from another
//                              machine, so the collector never writes it and a concurrent push merges trivially
// Job lines are idempotent by (run, attempt, job id); writes are staged and flushed together, the job lines first, so
// a batch stopped between the two leaves its attempts open with their lines written, and the next batch writes the
// same lines again in place.
const jobKey = (l) => `${l.run}/${l.attempt}/${l.job_id}`;
// Numbers by value, else as strings: a hand-run gate's run is its directory's name and its job id the row's.
const by = (x, y) => (typeof x === 'number' && typeof y === 'number' ? x - y : String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0);
const jobOrder = (a, b) => by(a.completed ?? '', b.completed ?? '') || by(a.run, b.run) || a.attempt - b.attempt || by(a.job_id, b.job_id);
const emptyAttempts = () => ({ v: 1, runs: {}, listed: {}, settled: {}, pass: null, calls: {} });

export function openLedger(root, alias) {
  const dir = join(root, alias);
  const attemptsPath = join(dir, 'attempts.json');
  const state = existsSync(attemptsPath) ? JSON.parse(readFileSync(attemptsPath, 'utf8')) : emptyAttempts();
  const staged = new Map(); // day → lines
  const jobsDir = join(dir, 'jobs');
  const manualDir = join(dir, 'jobs-manual');
  const readDay = (day) => readDayIn(jobsDir, day);
  const closedAll = (run) => run.closed.length >= run.attempts && Array.from({ length: run.attempts }, (_, i) => i + 1).every((a) => run.closed.includes(a));

  const ledger = {
    state,
    // `at`: the time to file the lines by, in place of each line's completion (an attempt's copies).
    addJobLines(lines, at = null) {
      for (const l of lines) {
        const day = dayOf(at ?? l.completed);
        staged.set(day, [...(staged.get(day) ?? []), l]);
      }
    },
    // Every job line filed in [fromDay, toDay], the staged ones and the hand-run gate's included.
    jobLines(fromDay, toDay) {
      const out = new Map();
      for (const day of [...new Set([...daysIn(jobsDir), ...staged.keys()])].filter((d) => d >= fromDay && d <= toDay).sort()) {
        for (const l of [...readDay(day), ...(staged.get(day) ?? [])]) out.set(jobKey(l), l);
      }
      const manual = daysIn(manualDir).filter((d) => d >= fromDay && d <= toDay).flatMap((d) => readDayIn(manualDir, d));
      return [...out.values(), ...manual].sort(jobOrder);
    },
    // A day is covered when it was listed after it ended and every attempt found for it is closed. A day whose runs
    // have aged out of the index keeps the answer it had then.
    covered(day) {
      if (day in state.settled) return state.settled[day];
      const listed = state.listed[day];
      if (!listed || listed < `${nextDay(day)}T00:00:00Z`) return false;
      return Object.values(state.runs).filter((r) => r.day === day).every(closedAll);
    },
    // Runs created before `day` leave the index, each day settling as covered or not.
    prune(day) {
      for (const d of new Set(Object.values(state.runs).map((r) => r.day))) {
        if (d < day && !(d in state.settled)) state.settled[d] = ledger.covered(d);
      }
      for (const [id, r] of Object.entries(state.runs)) if (r.day < day) delete state.runs[id];
    },
    // → files written.
    flush() {
      let written = 0;
      const write = (path, text) => {
        if (existsSync(path) && readFileSync(path, 'utf8') === text) return;
        writeAtomic(path, text);
        written += 1;
      };
      for (const day of [...staged.keys()].sort()) {
        const merged = new Map(readDay(day).map((l) => [jobKey(l), l]));
        for (const l of staged.get(day)) merged.set(jobKey(l), l);
        write(join(jobsDir, `${day}.jsonl`), [...merged.values()].sort(jobOrder).map((l) => `${JSON.stringify(l)}\n`).join(''));
      }
      staged.clear();
      write(attemptsPath, `${JSON.stringify(state)}\n`);
      return written;
    },
  };
  return ledger;
}

// The hand-run gate's job lines, each `{ day, line }` filed on its day, merged into jobs-manual/ by (run, attempt, job
// id): a line read again replaces its own wherever it was filed (a job that completed past midnight moves to the next
// day). A tree key the new line could not compute (an import without the runs' trees) is kept from the line it
// replaces when both name the same tree, so a re-import never erases one. → files written.
export function writeManualLines(root, alias, entries) {
  const dir = join(root, alias, 'jobs-manual');
  const files = new Map(daysIn(dir).map((day) => [day, readDayIn(dir, day)]));
  const filed = new Map(); // key → { day, line } as held
  for (const [day, lines] of files) for (const l of lines) filed.set(jobKey(l), { day, line: l });
  const changed = new Set();
  for (const { day, line } of entries) {
    const held = filed.get(jobKey(line));
    const next = held && line.tree_key === null && held.line.tree_key !== null && held.line.tree === line.tree ? { ...line, tree_key: held.line.tree_key } : line;
    if (held) {
      files.set(held.day, files.get(held.day).filter((l) => jobKey(l) !== jobKey(line)));
      changed.add(held.day);
    }
    files.set(day, [...(files.get(day) ?? []), next]);
    changed.add(day);
    filed.set(jobKey(line), { day, line: next });
  }
  let written = 0;
  for (const day of [...changed].sort()) {
    const path = join(dir, `${day}.jsonl`);
    const lines = files.get(day);
    if (lines.length === 0) {
      rmSync(path, { force: true });
      written += 1;
      continue;
    }
    const text = jsonl([...lines].sort(jobOrder));
    if (existsSync(path) && readFileSync(path, 'utf8') === text) continue;
    writeAtomic(path, text);
    written += 1;
  }
  return written;
}

export const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
