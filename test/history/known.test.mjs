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

// Writing (M5): `ci-gate known add` validates an entry before anything is read, names it, and appends it to the file
// it read; a write refused because the file changed since is read again and the one entry reapplied.
import { addKnown, isDay, KnownConflict, KnownError, knownEntry, validateKnown } from '../../history/known.mjs';

const TODAY = '2026-11-20';

test('an entry with no reason, no review date, a date that is not one, or one already past is refused', () => {
  const ok = { gate: 'test', reason: 'a reason', review_by: '2026-11-27' };
  assert.doesNotThrow(() => validateKnown(ok, TODAY));
  assert.doesNotThrow(() => validateKnown({ ...ok, review_by: TODAY }, TODAY)); // in force through its date
  assert.throws(() => validateKnown({ ...ok, reason: undefined }, TODAY), KnownError);
  assert.throws(() => validateKnown({ ...ok, reason: '   ' }, TODAY), KnownError);
  assert.throws(() => validateKnown({ ...ok, review_by: undefined }, TODAY), KnownError);
  assert.throws(() => validateKnown({ ...ok, review_by: '2026-11-31' }, TODAY), KnownError);
  assert.throws(() => validateKnown({ ...ok, review_by: '27.11.2026' }, TODAY), KnownError);
  // A date no calendar has is refused, never a RangeError.
  assert.throws(() => validateKnown({ ...ok, review_by: '2026-13-45' }, TODAY), KnownError);
  assert.equal(isDay('2026-13-45'), false);
  assert.equal(isDay('2026-02-30'), false);
  assert.equal(isDay('2026-02-28'), true);
  assert.throws(() => validateKnown({ ...ok, review_by: '2026-11-19' }, TODAY), KnownError);
  assert.throws(() => validateKnown({ ...ok, gate: undefined }, TODAY), KnownError);
  // An id or a gate is printed inside a line: one word of printable text.
  assert.throws(() => validateKnown({ ...ok, id: 'a\nFAIL x' }, TODAY), /an id is one word/);
  assert.throws(() => validateKnown({ ...ok, id: 'a b' }, TODAY), KnownError);
  assert.throws(() => validateKnown({ ...ok, gate: 'te\u001bst' }, TODAY), /a gate is one word/);
  assert.doesNotThrow(() => validateKnown({ ...ok, id: 'maws-778' }, TODAY));
  // A keep entry is about a gate, never a case.
  assert.throws(() => validateKnown({ ...ok, keep: true, case: 'a.ts › x' }, TODAY), KnownError);
});

test('a new entry is in force from today, carries who wrote it, and gets an id no other entry has', () => {
  const existing = [{ id: 'test-2026-11-20' }, { id: 'keep-test' }];
  assert.deepEqual(knownEntry({ gate: 'test', case: 'a.test.mjs › x*', reason: ' flaky on the guest ', review_by: '2026-11-27' }, [], { today: TODAY, by: 'CI-opt' }), {
    id: 'test-2026-11-20', gate: 'test', case: 'a.test.mjs › x*', reason: 'flaky on the guest', since: TODAY, review_by: '2026-11-27', by: 'CI-opt',
  });
  assert.equal(knownEntry({ gate: 'test', reason: 'r', review_by: '2026-11-27' }, existing, { today: TODAY, by: 'x' }).id, 'test-2026-11-20-2');
  const keep = knownEntry({ gate: 'test', keep: true, reason: 'r', review_by: '2027-02-19' }, existing, { today: TODAY, by: 'x' });
  assert.equal(keep.id, 'keep-test-2');
  assert.equal(keep.keep, true);
  assert.equal('case' in keep, false);
  assert.equal(knownEntry({ id: 'maws-778', gate: 'e2e:panel', reason: 'r', review_by: '2026-11-26' }, existing, { today: TODAY, by: 'x' }).id, 'maws-778');
  assert.throws(() => knownEntry({ id: 'keep-test', gate: 'test', reason: 'r', review_by: '2026-11-26' }, existing, { today: TODAY, by: 'x' }), KnownError);
});

// A file held as a contents API holds it: text and a blob id; a write names the id it read and is refused when the
// file has moved on.
function fakeFile(initial = null) {
  const file = { text: initial, sha: initial === null ? null : 'v0', writes: 0, reads: 0 };
  return {
    file,
    read: async () => {
      file.reads += 1;
      return file.text === null ? { entries: [], sha: null } : { entries: JSON.parse(file.text), sha: file.sha };
    },
    write: async (entries, sha) => {
      await Promise.resolve();
      if (sha !== file.sha) throw new KnownConflict();
      file.writes += 1;
      file.text = JSON.stringify(entries);
      file.sha = `v${file.writes}`;
    },
  };
}

test('an add appends its entry to the entries it read', async () => {
  const f = fakeFile(JSON.stringify([ENTRIES[0]]));
  const entry = await addKnown({ read: f.read, write: f.write, fields: { gate: 'unit', reason: 'r', review_by: '2026-11-27' }, today: TODAY, by: 'x' });
  assert.equal(entry.id, 'unit-2026-11-20');
  assert.deepEqual(JSON.parse(f.file.text).map((e) => e.id), ['maws-778', 'unit-2026-11-20']);
});

test('two adds whose reads raced both end in the file: the refused one reads again and reapplies its entry', async () => {
  const f = fakeFile(null); // no file yet: the first write creates it
  // Both reads happen before either write.
  let release;
  const gate = new Promise((r) => { release = r; });
  let waiting = 0;
  const read = async () => {
    const r = await f.read();
    waiting += 1;
    if (waiting === 2) release();
    if (waiting <= 2) await gate;
    return r;
  };
  const retries = [];
  const add = (gateName) => addKnown({ read, write: f.write, fields: { gate: gateName, reason: 'r', review_by: '2026-11-27' }, today: TODAY, by: 'x', onRetry: () => retries.push(gateName) });
  const [a, b] = await Promise.all([add('unit'), add('unit')]);
  const ids = JSON.parse(f.file.text).map((e) => e.id).sort();
  assert.deepEqual(ids, [a.id, b.id].sort());
  assert.notEqual(a.id, b.id); // the reapplied entry is named against the file it read again
  assert.equal(retries.length, 1);
  assert.equal(f.file.writes, 2);
  assert.equal(f.file.reads, 3);
});

test('an add refused on every attempt gives up with an error, having written nothing', async () => {
  const f = fakeFile('[]');
  const write = async () => { throw new KnownConflict(); };
  await assert.rejects(addKnown({ read: f.read, write, fields: { gate: 'unit', reason: 'r', review_by: '2026-11-27' }, today: TODAY, by: 'x', attempts: 3 }), /changed 3 times/);
  assert.equal(f.file.reads, 3);
});

test('a refused entry is refused before the file is read', async () => {
  const f = fakeFile('[]');
  await assert.rejects(addKnown({ read: f.read, write: f.write, fields: { gate: 'unit', review_by: '2026-11-27' }, today: TODAY, by: 'x' }), KnownError);
  assert.equal(f.file.reads, 0);
});
