// The status file (gate ledger spec, "The report and the status file", M4): `<alias>/status.json` in the store,
// written in the daily pass, read by `ci-gate` at a failure (M5):
//   { v, as_of, gates: { <gate>: { result, commit, at, run, attempt } }, known: [ …entries in force… ] }
// `gates`: each gate's standing on the default branch (landings.mjs `observationsOf`): the latest observation of the
// newest landed tree that has one, `result` `succeeded` or `failed`, `commit` the landed commit, `at` when the attempt
// completed, `run` and `attempt` the run that made it. Over the same window the derivation reads (35 days and a day's
// margin each side), so a gate unobserved for longer has no standing. `known`: every entry of known.json in force on
// the day the file is written, `keep` ones included (a reader that prints context skips them, and checks each entry's
// date again when it reads it).
// `as_of`: how fresh the record behind it is, not when the file was written: the run listing of the repository's
// pass whose derivation completed, else the collector's last whole pass (collected.json), else null. A dead collector
// therefore ages the file even when the daily workflow writes it again.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from './cause.mjs';
import { readDays, WINDOW_DAYS } from './derive.mjs';
import { inForce, readKnown } from './known.mjs';
import { observationsOf } from './landings.mjs';
import { dayOf, openLedger } from './store.mjs';

const DAY = 86_400_000;
const day = (ms) => dayOf(new Date(ms).toISOString());

// How fresh the repository's record is (above). `state`: its attempts.json.
export function recordAsOf(root, state) {
  if (state.pass?.derived === true && state.pass.listed_at) return state.pass.listed_at;
  const marker = join(root, 'collected.json');
  return existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')).at ?? null : null;
}

export function statusOf({ root, alias, entry, now = Date.now() }) {
  const ledger = openLedger(root, alias);
  const { state } = ledger;
  const [from, to] = [day(now - WINDOW_DAYS * DAY), day(now + DAY)];
  const lines = ledger.jobLines(from, to);
  const created = Object.fromEntries(Object.entries(state.runs ?? {}).filter(([, r]) => r.created).map(([id, r]) => [id, r.created]));
  const analysis = analyze(lines, { created });
  const landings = state.activity === 'refused' ? null : [...readDays(join(root, alias, 'landings'), from, to).values()].flat().sort((a, b) => (a.at < b.at ? -1 : 1));
  const observations = observationsOf({ analysis, landings, entry });
  const at = new Date(now).toISOString();
  const gates = {};
  for (const gate of [...new Set(analysis.attempts.map((a) => a.gate))].sort()) {
    const s = observations.standing(gate, at);
    if (s) gates[gate] = { result: s.result, commit: s.commit, at: s.at, run: s.run, attempt: s.attempt };
  }
  return { v: 1, as_of: recordAsOf(root, state), gates, known: readKnown(root, alias).filter((e) => inForce(e, day(now))) };
}
