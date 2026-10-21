// Provenance (test history spec, M2): the producer and label from both ci-gates' ref names, the tested commit, and
// the change's previous run with the relation and paths between them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatesOf, previousRun, producerOf, resolveTested } from '../../history/provenance.mjs';

test("both producers' ref names, and pushes and dispatches that are neither", () => {
  assert.deepEqual(producerOf({ event: 'push', head_branch: 'ci/unit-junit-83a54fc7' }), { producer: 'maws-ci-gate', label: 'unit-junit', sha8: '83a54fc7' });
  assert.deepEqual(producerOf({ event: 'push', head_branch: 'ci/history-96cc3c1a-0f9e2d' }), { producer: 'ci-kit-ci-gate', label: 'history', sha8: '96cc3c1a' });
  // a label may itself end in hex: the last segment's length decides
  assert.deepEqual(producerOf({ event: 'push', head_branch: 'ci/fix-abcdef-12345678' }), { producer: 'maws-ci-gate', label: 'fix-abcdef', sha8: '12345678' });
  assert.deepEqual(producerOf({ event: 'push', head_branch: 'ci/fix-12345678-12345678-abcdef' }), { producer: 'ci-kit-ci-gate', label: 'fix-12345678', sha8: '12345678' });
  assert.deepEqual(producerOf({ event: 'push', head_branch: 'master' }), { producer: 'other', label: null, sha8: null });
  assert.deepEqual(producerOf({ event: 'workflow_dispatch', head_branch: 'ci/unit-junit-83a54fc7' }), { producer: 'other', label: null, sha8: null });
  assert.deepEqual(producerOf({ event: 'push', head_branch: 'ci/no-sha' }), { producer: 'other', label: null, sha8: null });
});

test("the gates trailer, MAWS's or ci-kit's, as written", () => {
  assert.equal(gatesOf('ci-gate: 83a54fc7\n\nNonce: 1-2\nGates: static,unit,probes\nClass1a: pool'), 'static,unit,probes');
  assert.equal(gatesOf('ci-gate 0123456789ab\n\nCI-Gates: test\n'), 'test');
  assert.equal(gatesOf('ci-gate: 83a54fc7\n\nNonce: 1-2'), null);
});

const commits = {
  nonce: { tree: { sha: 'T1' }, parents: [{ sha: '83a54fc7aaaa' }], message: 'ci-gate: 83a54fc7\n\nGates: unit' },
  '83a54fc7aaaa': { tree: { sha: 'T1' }, parents: [{ sha: 'p0' }], message: 'the work' },
  stray: { tree: { sha: 'T9' }, parents: [{ sha: 'ffffffff0000' }], message: 'not a nonce' },
  main1: { tree: { sha: 'T5' }, parents: [{ sha: 'p0' }], message: 'a merge' },
};
const commitGh = { gitCommit: async (_repo, sha) => commits[sha] };

test("the tested commit is a ci-gate run's nonce parent; a run whose head is not such a commit tested its head", async () => {
  assert.deepEqual(await resolveTested(commitGh, 'o/r', { event: 'push', head_branch: 'ci/unit-junit-83a54fc7', head_sha: 'nonce' }),
    { producer: 'maws-ci-gate', label: 'unit-junit', gates: 'unit', selection: null, tested: '83a54fc7aaaa', tree: 'T1' });
  assert.deepEqual(await resolveTested(commitGh, 'o/r', { event: 'push', head_branch: 'ci/unit-junit-83a54fc7', head_sha: 'stray' }),
    { producer: 'other', label: null, gates: null, selection: null, tested: 'stray', tree: 'T9' });
  assert.deepEqual(await resolveTested(commitGh, 'o/r', { event: 'push', head_branch: 'master', head_sha: 'main1' }),
    { producer: 'other', label: null, gates: null, selection: null, tested: 'main1', tree: 'T5' });
});

test('selection comes from the run head, never the tested parent or a mention in its subject', async () => {
  const run = { event: 'push', head_branch: 'ci/unit-junit-83a54fc7', head_sha: 'nonce' };
  for (const [message, expected] of [
    ['ci-gate: 83a54fc7 affected\n\nGates: unit\nSelection: affected\n', 'affected'],
    ['ci-gate: 83a54fc7\n\nSelection:\taffected  \nGates: unit', 'affected'],
    ['ci-gate: 83a54fc7 affected', null],
    ['ci-gate: 83a54fc7\n\nSelection: full', null],
    ['ci-gate: 83a54fc7\n\nNote: Selection: affected', null],
  ]) {
    const gh = { gitCommit: async (_repo, sha) => ({ ...commits[sha], message: sha === 'nonce' ? message : 'work\n\nSelection: affected' }) };
    const resolved = await resolveTested(gh, 'o/r', run);
    assert.equal(resolved.selection, expected, message);
    assert.equal(resolved.tested, '83a54fc7aaaa');
  }
});

const line = (run, over = {}) => ({
  run, attempt: 1, job: 'unit', producer: 'maws-ci-gate', label: 'x', report: 'present',
  tested: `c${run}`, tree: `t${run}`, started: `2026-10-21T0${run}:00:00Z`, ...over,
});
// ancestry: c1 ← c2 ← c4; c3 is c2's sibling (an amended commit)
const ancestors = { c2: ['c1'], c3: ['c1'], c4: ['c1', 'c2'] };
function compareGh({ gone = [], files = {} } = {}) {
  const calls = [];
  return {
    calls,
    compare: async (_repo, base, head) => {
      calls.push(`${base}...${head}`);
      if (gone.includes(base) || gone.includes(head)) throw Object.assign(new Error('Not Found'), { status: 404 });
      return (ancestors[head] ?? []).includes(base) ? { status: 'ahead', files: files[`${base}...${head}`] ?? [] } : { status: 'diverged', files: [] };
    },
  };
}

test('the previous run is the latest earlier run of the same change whose commit is an ancestor; a sibling is passed over', async () => {
  const gh = compareGh({ files: { 'c2...c4': [{ filename: 'src/b.ts' }, { filename: 'src/new.ts', previous_filename: 'src/old.ts' }] } });
  const lines = [line(1), line(2), line(3, { tested: 'c3' }), line(4)];
  assert.deepEqual(await previousRun(gh, 'o/r', lines[3], lines), { run: 2, attempt: 1, relation: 'descendant', paths: ['src/b.ts', 'src/new.ts', 'src/old.ts'], truncated: false });
  assert.deepEqual(gh.calls, ['c3...c4', 'c2...c4']);
  assert.equal(await previousRun(gh, 'o/r', lines[0], lines), null);
});

test('the same tree needs no comparison, and a later attempt of one run follows its first', async () => {
  const gh = compareGh();
  const first = line(1);
  const again = line(1, { attempt: 2, started: '2026-10-21T01:30:00Z' });
  assert.deepEqual(await previousRun(gh, 'o/r', again, [first, again]), { run: 1, attempt: 1, relation: 'same-tree', paths: [], truncated: false });
  assert.deepEqual(gh.calls, []);
});

test('only lines of the same job, producer and label with a report are candidates', async () => {
  const gh = compareGh();
  const lines = [
    line(1, { job: 'unit:darwin' }), line(1, { producer: 'ci-kit-ci-gate', attempt: 2 }), line(1, { label: 'y', attempt: 3 }),
    line(1, { report: 'missing', attempt: 4 }), line(2),
  ];
  assert.equal(await previousRun(gh, 'o/r', lines[4], lines), null);
  assert.deepEqual(gh.calls, []);
});

test('a commit GitHub no longer has makes the relation unknown, and so does running out of comparisons', async () => {
  assert.deepEqual(await previousRun(compareGh({ gone: ['c2'] }), 'o/r', line(4), [line(1), line(2), line(4)]),
    { run: 2, attempt: 1, relation: 'unknown', paths: null, truncated: false });
  const gh = compareGh();
  assert.deepEqual(await previousRun(gh, 'o/r', line(4), [line(1), line(3, { tested: 'c3' }), line(4)], { maxCompares: 1 }),
    { run: 1, attempt: 1, relation: 'unknown', paths: null, truncated: false });
  assert.deepEqual(gh.calls, ['c3...c4']);
});

test('a comparison at its limit of 300 files is marked truncated; a run with no change has no previous run', async () => {
  const files = Array.from({ length: 300 }, (_, i) => ({ filename: `f${String(i).padStart(3, '0')}` }));
  const prev = await previousRun(compareGh({ files: { 'c1...c2': files } }), 'o/r', line(2), [line(1), line(2)]);
  assert.equal(prev.paths.length, 300);
  assert.equal(prev.truncated, true);
  const other = (run) => line(run, { producer: 'other', label: null });
  assert.equal(await previousRun(compareGh(), 'o/r', other(2), [other(1), other(2)]), null);
});
