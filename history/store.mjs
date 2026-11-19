// The store directory (test history spec, Design "Store"): under <root>/<alias>/ (default alias: owner/repo),
//   runs/<YYYY-MM-DD>.jsonl              one line per (run, attempt, job), by the job's completion day (UTC)
//   base/<YYYY-MM-DD>/<job>.json.gz      the day's first complete unselected report, which delta lines refer to
//   durations/<YYYY-MM-DD>/<job>.json.gz the day's last unselected green report's file durations
// Every day's run lines are read (≈ 100 KB a day: the previous-run search reaches a re-run or a resumed change
// weeks back); writes are staged and flushed at the end, each file only when its bytes change.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { jobSlug, lineKey, mergeLines } from './record.mjs';

const DAY = /^(\d{4}-\d\d-\d\d)\.jsonl$/;
export const dayOf = (iso) => iso.slice(0, 10);

const readLines = (path) => readFileSync(path, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
const readGz = (path) => (existsSync(path) ? JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) : null);

export function openStore(root, alias) {
  const dir = join(root, alias);
  const lines = [];
  const runsDir = join(dir, 'runs');
  if (existsSync(runsDir)) {
    for (const name of readdirSync(runsDir).sort()) {
      if (DAY.test(name)) lines.push(...readLines(join(runsDir, name)));
    }
  }
  const held = new Map(lines.map((l) => [lineKey(l), l]));
  const staged = new Map(); // day → lines
  const replacing = new Map(); // day → lines that replace the held line of their key
  const stage = (into, line) => {
    const day = dayOf(line.completed);
    into.set(day, [...(into.get(day) ?? []), line]);
  };
  const gz = new Map(); // path → object (read or staged)
  const dirty = new Set(); // gz paths to write

  const gzPath = (kind, day, job) => join(dir, kind, day, `${jobSlug(job)}.json.gz`);
  const getGz = (path) => {
    if (!gz.has(path)) gz.set(path, readGz(path));
    return gz.get(path);
  };
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
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
        written += 1;
      };
      const bases = [...dirty].filter((p) => p.startsWith(join(dir, 'base')));
      for (const path of [...bases, ...[...dirty].filter((p) => !bases.includes(p))]) {
        write(path, gzipSync(JSON.stringify(gz.get(path)), { level: 9 }));
      }
      for (const day of [...new Set([...staged.keys(), ...replacing.keys()])].sort()) {
        const path = join(runsDir, `${day}.jsonl`);
        const merged = mergeLines(existsSync(path) ? readLines(path) : [], staged.get(day) ?? [], replacing.get(day) ?? []);
        write(path, Buffer.from(merged.map((l) => `${JSON.stringify(l)}\n`).join('')));
      }
      return written;
    },
  };
}

// The gate ledger's files under <root>/<alias>/ (gate ledger spec, "One collector, one store, more kinds of line"):
//   attempts.json              which (run, attempt) pairs are collected, which are still open, when each day was listed,
//                              the pass under way (its listing's queue and its calls) and the calls of the last hour
//   jobs/<YYYY-MM-DD>.jsonl    one line per job of a gate run, by the job's completion day (UTC)
// Job lines are idempotent by (run, attempt, job id); writes are staged and flushed together, the job lines first, so
// a batch stopped between the two leaves its attempts open with their lines written, and the next batch writes the
// same lines again in place.
const jobKey = (l) => `${l.run}/${l.attempt}/${l.job_id}`;
const jobOrder = (a, b) => (a.completed < b.completed ? -1 : a.completed > b.completed ? 1 : a.run - b.run || a.attempt - b.attempt || a.job_id - b.job_id);
const emptyAttempts = () => ({ v: 1, runs: {}, listed: {}, settled: {}, pass: null, calls: {} });

export function openLedger(root, alias) {
  const dir = join(root, alias);
  const attemptsPath = join(dir, 'attempts.json');
  const state = existsSync(attemptsPath) ? JSON.parse(readFileSync(attemptsPath, 'utf8')) : emptyAttempts();
  const staged = new Map(); // day → lines
  const jobsDir = join(dir, 'jobs');
  const readDay = (day) => {
    const path = join(jobsDir, `${day}.jsonl`);
    return existsSync(path) ? readLines(path) : [];
  };
  const days = () => (existsSync(jobsDir) ? readdirSync(jobsDir).map((n) => DAY.exec(n)?.[1]).filter(Boolean) : []);
  const closedAll = (run) => run.closed.length >= run.attempts && Array.from({ length: run.attempts }, (_, i) => i + 1).every((a) => run.closed.includes(a));

  const ledger = {
    state,
    addJobLines(lines) {
      for (const l of lines) {
        const day = dayOf(l.completed);
        staged.set(day, [...(staged.get(day) ?? []), l]);
      }
    },
    // Every job line completed in [fromDay, toDay], the staged ones included.
    jobLines(fromDay, toDay) {
      const out = new Map();
      for (const day of [...new Set([...days(), ...staged.keys()])].filter((d) => d >= fromDay && d <= toDay).sort()) {
        for (const l of [...readDay(day), ...(staged.get(day) ?? [])]) out.set(jobKey(l), l);
      }
      return [...out.values()].sort(jobOrder);
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
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
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

export const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
