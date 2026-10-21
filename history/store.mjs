// The store directory (test history spec, Design "Store"): under <root>/<owner>/<repo>/,
//   runs/<YYYY-MM-DD>.jsonl              one line per (run, attempt, job), by the job's completion day (UTC)
//   base/<YYYY-MM-DD>/<job>.json.gz      the day's first complete unselected report, which delta lines refer to
//   durations/<YYYY-MM-DD>/<job>.json.gz the day's last unselected green report's file durations
// Every day's run lines are read (≈ 100 KB a day: the previous-run search reaches a re-run or a resumed change
// weeks back); writes are staged and flushed at the end, each file only when its bytes change.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { jobSlug, lineArtifacts, lineKey, mergeLines } from './record.mjs';

const DAY = /^(\d{4}-\d\d-\d\d)\.jsonl$/;
export const dayOf = (iso) => iso.slice(0, 10);

const readLines = (path) => readFileSync(path, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
const readGz = (path) => (existsSync(path) ? JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) : null);

export function openStore(root, repo) {
  const dir = join(root, repo);
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
    artifactIds: () => new Set(lines.flatMap(lineArtifacts).map((a) => a.id)),
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
