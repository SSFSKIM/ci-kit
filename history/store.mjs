// The store directory (test history spec, Design "Store"): under <root>/<owner>/<repo>/,
//   runs/<YYYY-MM-DD>.jsonl              one line per (run, attempt, job), by the job's completion day (UTC)
//   base/<YYYY-MM-DD>/<job>.json.gz      the day's first complete report of the job, which run lines refer to
//   durations/<YYYY-MM-DD>/<job>.json.gz the day's last green report's file durations
// Reads are of the recent days; writes are staged and flushed at the end, each file only when its bytes change.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { jobSlug, lineKey, mergeLines } from './record.mjs';

const DAY = /^(\d{4}-\d\d-\d\d)\.jsonl$/;
export const dayOf = (iso) => iso.slice(0, 10);

const readLines = (path) => readFileSync(path, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
const readGz = (path) => (existsSync(path) ? JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) : null);

// `days`: how far back the run lines are read (the previous-run search and the known artifacts reach this far).
export function openStore(root, repo, { now = Date.now(), days = 14 } = {}) {
  const dir = join(root, repo);
  const oldest = dayOf(new Date(now - days * 86_400_000).toISOString());
  const lines = [];
  const runsDir = join(dir, 'runs');
  if (existsSync(runsDir)) {
    for (const name of readdirSync(runsDir).sort()) {
      const m = DAY.exec(name);
      if (m && m[1] >= oldest) lines.push(...readLines(join(runsDir, name)));
    }
  }
  const held = new Map(lines.map((l) => [lineKey(l), l]));
  const staged = new Map(); // day → lines
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
    artifactIds: () => new Set(lines.filter((l) => l.artifact).map((l) => l.artifact.id)),
    newestArtifact: () => lines.reduce((t, l) => (l.artifact ? Math.max(t, Date.parse(l.artifact.created)) : t), -Infinity),
    base: (day, job) => getGz(gzPath('base', day, job)),
    setBase: (day, job, base) => setGz(gzPath('base', day, job), base),
    durations: (day, job) => getGz(gzPath('durations', day, job)),
    setDurations: (day, job, d) => setGz(gzPath('durations', day, job), d),
    add(line) {
      const day = dayOf(line.completed);
      staged.set(day, [...(staged.get(day) ?? []), line]);
      const prior = held.get(lineKey(line));
      if (!prior || (prior.report === 'missing' && line.report !== 'missing')) held.set(lineKey(line), line);
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
      for (const [day, incoming] of [...staged].sort()) {
        const path = join(runsDir, `${day}.jsonl`);
        const merged = mergeLines(existsSync(path) ? readLines(path) : [], incoming);
        write(path, Buffer.from(merged.map((l) => `${JSON.stringify(l)}\n`).join('')));
      }
      return written;
    },
  };
}
