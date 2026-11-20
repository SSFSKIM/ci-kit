// Known entries, read and matched (gate ledger spec, "Known entries"; M3 reads them, M5 writes them): an entry is in
// force from its `since` through its `review_by`; a cause's context names each entry in force that names the gate,
// with whether the attempt's failing cases all match its pattern.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseMatches, inForce, knownContext, readKnown } from '../../history/known.mjs';

const ENTRIES = [
  { id: 'maws-778', gate: 'e2e:panel', case: 'panel.spec.ts › at its minimum size, with a question waiting*', reason: '#778', since: '2026-11-19', review_by: '2026-11-26', by: 'ux-wave' },
  { id: 'whole-gate', gate: 'unit', reason: 'the whole gate', since: '2026-11-01', review_by: '2026-11-30', by: 'CI-opt' },
  { id: 'keep-cross-build', gate: 'e2e:cross-build', keep: true, reason: 'wire compatibility', since: '2026-11-19', review_by: '2027-02-19', by: 'CI-opt' },
  { id: 'old', gate: 'e2e:panel', case: '*', reason: 'expired', since: '2026-10-01', review_by: '2026-11-01', by: 'x' },
];
const panelCase = (name) => ['desk', 'apps/desk/e2e/panel.spec.ts', name];

test('an entry is in force from its since through its review_by, and an absent file has none', (t) => {
  assert.equal(inForce(ENTRIES[0], '2026-11-18'), false);
  assert.equal(inForce(ENTRIES[0], '2026-11-19'), true);
  assert.equal(inForce(ENTRIES[0], '2026-11-26'), true);
  assert.equal(inForce(ENTRIES[0], '2026-11-27'), false);
  const root = mkdtempSync(join(tmpdir(), 'history-known-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readKnown(root, 'o/r'), []);
  mkdirSync(join(root, 'o/r'), { recursive: true });
  writeFileSync(join(root, 'o/r/known.json'), JSON.stringify(ENTRIES));
  assert.deepEqual(readKnown(root, 'o/r'), ENTRIES);
});

test("a case pattern matches a failing case by its file and title, the file whole or by its name, `*` for anything", () => {
  const pattern = ENTRIES[0].case;
  assert.equal(caseMatches(pattern, panelCase('at its minimum size, with a question waiting, the card keeps its body')), true);
  assert.equal(caseMatches('apps/desk/e2e/panel.spec.ts › at its minimum size*', panelCase('at its minimum size, x')), true);
  assert.equal(caseMatches(pattern, panelCase('at its maximum size')), false);
  assert.equal(caseMatches(pattern, ['desk', 'apps/desk/e2e/other.spec.ts', 'at its minimum size, with a question waiting']), false);
  // Every other character is literal: a dot or a parenthesis in a title is not a pattern.
  assert.equal(caseMatches('a.ts › f(x)', ['p', 'a.ts', 'f(x)']), true);
  assert.equal(caseMatches('a.ts › f(x)', ['p', 'abts', 'f(x)']), false);
});

test("the context names each entry in force without keep that names the gate, with case_match in its three values", () => {
  const day = '2026-11-20';
  const yes = [panelCase('at its minimum size, with a question waiting: a'), panelCase('at its minimum size, with a question waiting: b')];
  assert.deepEqual(knownContext(ENTRIES, { gate: 'e2e:panel', day, cases: yes }), [{ id: 'maws-778', case_match: 'yes' }]);
  assert.deepEqual(knownContext(ENTRIES, { gate: 'e2e:panel', day, cases: [...yes, panelCase('something else')] }), [{ id: 'maws-778', case_match: 'no' }]);
  // No failing cases in the record for the attempt (none collected, or a gate without a per-test report).
  assert.deepEqual(knownContext(ENTRIES, { gate: 'e2e:panel', day, cases: null }), [{ id: 'maws-778', case_match: 'unverified' }]);
  assert.deepEqual(knownContext(ENTRIES, { gate: 'e2e:panel', day, cases: [] }), [{ id: 'maws-778', case_match: 'unverified' }]);
  // An entry with no case names every failure of its gate.
  assert.deepEqual(knownContext(ENTRIES, { gate: 'unit', day, cases: [['p', 'a.test.ts', 'x']] }), [{ id: 'whole-gate', case_match: 'yes' }]);
  // A keep entry is the report's only; an expired entry is in nobody's context.
  assert.deepEqual(knownContext(ENTRIES, { gate: 'e2e:cross-build', day, cases: null }), []);
  assert.deepEqual(knownContext(ENTRIES, { gate: 'e2e:panel', day: '2026-11-02', cases: null }), []);
});
