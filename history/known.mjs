// Known entries (gate ledger spec, "Known entries"): `<alias>/known.json` in the store, a list of recorded reasons.
// Read and matched here, and written here for `ci-gate known add` (M5). An entry without `keep` records a failure someone decided
// to ship with; one with `keep` records that a gate stays whatever it has caught, and is read only by the report's
// nominations. An entry is in force from its `since` through its `review_by`, so an expired one is never shown as in
// force.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const readKnown = (root, alias) => {
  const path = join(root, alias, 'known.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
};

export const inForce = (entry, day) => entry.since <= day && day <= entry.review_by;

// A case pattern: `*` matches anything, every other character is itself, and the whole case must match. A failing
// case ([project, file, title, n?] in the per-test record) reads `<file> › <title>`, its file whole or by its name
// alone, so an entry can name a test as a person would.
const patterns = new Map();
const patternRe = (pattern) => {
  if (!patterns.has(pattern)) patterns.set(pattern, new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`, 's'));
  return patterns.get(pattern);
};
export function caseMatches(pattern, id) {
  const [, file, title] = id;
  const re = patternRe(pattern);
  return re.test(`${file} › ${title}`) || re.test(`${file.split('/').at(-1)} › ${title}`);
}

// A cause line's `known` context: each entry in force on `day` without `keep` that names the gate, with `case_match`
// `yes` when the record has the attempt's failing cases and every one matches the entry's case (an entry with no case
// names every failure of its gate), `no` when some do not, `unverified` when the record has no cases for it.
export function knownContext(entries, { gate, day, cases }) {
  return entries
    .filter((e) => e.gate === gate && !e.keep && inForce(e, day))
    .map((e) => {
      let match = 'unverified';
      if (cases && cases.length > 0) match = !e.case || cases.every((id) => caseMatches(e.case, id)) ? 'yes' : 'no';
      return { id: e.id, case_match: match };
    });
}

// Writing (M5). An entry is refused before anything is read when it has no gate, no reason, or no review date that is
// a real day from today on, or when a keep entry names a case (it is about a gate, never a failure).
export class KnownError extends Error {}
// The file changed between the read and the write (the contents API refused the blob id the write named).
export class KnownConflict extends Error {}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (s) => typeof s === 'string' && DAY_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const given = (s) => typeof s === 'string' && s.trim() !== '';

export function validateKnown({ gate, case: pattern, reason, review_by: reviewBy, keep }, today) {
  if (!given(gate)) throw new KnownError('an entry names its gate (--gate)');
  if (!given(reason)) throw new KnownError('an entry needs a reason (--reason)');
  if (reviewBy === undefined || reviewBy === null || reviewBy === '') throw new KnownError('an entry needs a review date (--review-by YYYY-MM-DD)');
  if (!isDay(reviewBy)) throw new KnownError(`the review date is a day, YYYY-MM-DD, not ${reviewBy}`);
  if (reviewBy < today) throw new KnownError(`the review date ${reviewBy} is already past (today is ${today})`);
  if (keep && pattern !== undefined && pattern !== null) throw new KnownError('a keep entry is about a gate and names no case');
  if (pattern !== undefined && pattern !== null && !given(pattern)) throw new KnownError('an empty case names nothing');
}

// The entry as stored: in force from today. Its id is the one asked for, refused when taken, else `keep-<gate>` or
// `<gate>-<today>`, with `-2`, `-3`… until no entry of the file has it.
export function knownEntry(fields, existing, { today, by }) {
  validateKnown(fields, today);
  const gate = fields.gate.trim();
  const taken = new Set(existing.map((e) => e.id));
  let id = fields.id;
  if (id !== undefined && id !== null) {
    if (taken.has(id)) throw new KnownError(`an entry ${id} exists already`);
  } else {
    const base = fields.keep ? `keep-${gate}` : `${gate}-${today}`;
    id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  }
  const entry = { id, gate };
  if (fields.keep) entry.keep = true;
  else if (fields.case !== undefined && fields.case !== null) entry.case = fields.case;
  Object.assign(entry, { reason: fields.reason.trim(), since: today, review_by: fields.review_by, by });
  return entry;
}

// Appends one entry. read() → { entries, sha }; write(entries, sha) replaces the file only while it is still the one
// read (else throws KnownConflict). A refused write reads again and reapplies the entry, so two adds whose reads
// raced both end in the file. onRetry(): told of each conflict.
export async function addKnown({ read, write, fields, today, by, attempts = 5, onRetry = () => {} }) {
  validateKnown(fields, today);
  for (let i = 1; i <= attempts; i += 1) {
    const { entries, sha } = await read();
    const entry = knownEntry(fields, entries, { today, by });
    try {
      await write([...entries, entry], sha);
      return entry;
    } catch (e) {
      if (!(e instanceof KnownConflict)) throw e;
      if (i < attempts) onRetry();
    }
  }
  throw new Error(`known.json changed ${attempts} times while this entry was being written; nothing was written`);
}
