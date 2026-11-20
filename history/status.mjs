// The status file (gate ledger spec, "The report and the status file", M4): `<alias>/status.json` in the store,
// written in the daily pass, read by `ci-gate` at a failure (M5):
//   { v, as_of, gates: { <gate>: { result, commit, at, run, attempt } }, known: [ …entries in force… ] }
// `gates`: each gate's standing on the default branch (landings.mjs `observationsOf`): the latest observation of the
// newest landed tree that has one, `result` `succeeded` or `failed`, `commit` the landed commit, `at` when the attempt
// completed, `run` and `attempt` the run that made it. Over the same window the derivation reads (35 days and a day's
// margin each side), so a gate unobserved for longer has no standing. `known`: every entry of known.json in force on
// the day the file is written, `keep` ones included (a reader that prints context skips them, and checks each entry's
// date again when it reads it).
// `as_of`: how fresh the record behind the standings is, not when the file was written: the run listing of the pass
// whose derivation completed. Standings are computed only from such a pass. While a pass is under way (its derivation
// not complete, the job and landing files on disk part new and part old: a failure whose later green is still queued)
// the previous file's gates and as_of are carried forward unchanged, so a dead or stuck collector ages the file even
// when the daily workflow writes it again; with no previous file there are no gates and as_of is null. `known` is read
// afresh each time: known.json is the record of its own writers, not of the collection.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from './cause.mjs';
import { readDays, WINDOW_DAYS } from './derive.mjs';
import { inForce, readKnown } from './known.mjs';
import { observationsOf } from './landings.mjs';
import { dayOf, openLedger } from './store.mjs';

const DAY = 86_400_000;
const day = (ms) => dayOf(new Date(ms).toISOString());

// When the repository's record was last whole: the run listing of its pass whose derivation completed, else null.
export const derivedAt = (state) => (state.pass?.derived === true && state.pass.listed_at) || null;

const readStatus = (root, alias) => {
  const path = join(root, alias, 'status.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
};

export function statusOf({ root, alias, entry, now = Date.now() }) {
  const ledger = openLedger(root, alias);
  const { state } = ledger;
  const known = readKnown(root, alias).filter((e) => inForce(e, day(now)));
  const asOf = derivedAt(state);
  if (!asOf) {
    const previous = readStatus(root, alias);
    return { v: 1, as_of: previous?.as_of ?? null, gates: previous?.gates ?? {}, known };
  }
  const [from, to] = [day(now - WINDOW_DAYS * DAY), day(now + DAY)];
  const lines = ledger.jobLines(from, to);
  const created = Object.fromEntries(Object.entries(state.runs ?? {}).filter(([, r]) => r.created).map(([id, r]) => [id, r.created]));
  const analysis = analyze(lines, { created });
  const landings = state.activity && state.activity !== 'refused' ? [...readDays(join(root, alias, 'landings'), from, to).values()].flat().sort((a, b) => (a.at < b.at ? -1 : 1)) : null;
  const observations = observationsOf({ analysis, landings, entry });
  const at = new Date(now).toISOString();
  const gates = {};
  for (const gate of [...new Set(analysis.attempts.map((a) => a.gate))].sort()) {
    const s = observations.standing(gate, at);
    if (s) gates[gate] = { result: s.result, commit: s.commit, at: s.at, run: s.run, attempt: s.attempt };
  }
  return { v: 1, as_of: asOf, gates, known };
}
