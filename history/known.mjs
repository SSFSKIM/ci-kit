// Known entries (gate ledger spec, "Known entries"): `<alias>/known.json` in the store, a list of recorded reasons.
// Read and matched here; written by `ci-gate known add` (M5). An entry without `keep` records a failure someone decided
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
