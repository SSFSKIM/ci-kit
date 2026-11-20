// ci-gate's reads of the gate ledger (gate ledger spec, "`ci-gate` at a failure", M5): the context lines after a FAIL,
// `ci-gate status`, and `ci-gate known add|list`, against a fake contents API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubError } from '../lib/github.mjs';
import { addKnown } from '../history/known.mjs';
import { contextLines, contextReader, knownFile, knownReport, ledgerEntry, STORE, statusReport, storeOf } from '../cli/ledger.mjs';

const NOW = Date.parse('2026-11-20T08:00:00Z');
const HOUR = 3_600_000;
const STATUS = {
  v: 1,
  as_of: '2026-11-20T07:11:18.327Z',
  gates: {
    test: { result: 'failed', commit: '3f2a91c0123456789abcdef0123456789abcdef0', at: '2026-11-18T10:49:33Z', run: 44262593045, attempt: 1 },
    lint: { result: 'succeeded', commit: '1655a810f40af71cdb0bcddb435d7d61fd7a149e', at: '2026-11-20T00:48:36Z', run: 44648285549, attempt: 1 },
  },
  known: [
    { id: 'maws-778', gate: 'test', case: 'panel.spec.ts › at its minimum size*', reason: "#778: the banner steals the float card's body on the guest.", since: '2026-11-19', review_by: '2026-11-26', by: 'ux-wave' },
    { id: 'keep-test', gate: 'test', keep: true, reason: 'the only check of it', since: '2026-11-19', review_by: '2027-02-19', by: 'CI-opt' },
    // Written into the file while in force; expired by the time it is read.
    { id: 'old', gate: 'test', reason: 'expired', since: '2026-11-01', review_by: '2026-11-19', by: 'x' },
    { id: 'other', gate: 'lint', reason: 'another gate', since: '2026-11-19', review_by: '2026-11-26', by: 'x' },
  ],
};
const BASE = '     base: test last ran on main at 3f2a91c (2026-11-18T10:49Z) and failed, run 44262593045. The failures may differ: compare before rerunning.';
const KNOWN = "     known: maws-778 (review by 2026-11-26): #778: the banner steals the float card's body on the guest. Whether this failure is that one is not checked.";

test('the store is the sandbox\'s test-history branch unless CI_KIT_STORE names another', () => {
  assert.deepEqual(STORE, { repo: 'SSFSKIM/ci-kit-sandbox', branch: 'test-history' });
  assert.deepEqual(storeOf({}), STORE);
  assert.deepEqual(storeOf({ CI_KIT_STORE: 'o/n@a6-copy' }), { repo: 'o/n', branch: 'a6-copy' });
  assert.equal(storeOf({ CI_KIT_STORE: 'o/n' }), null);
  assert.equal(storeOf({ CI_KIT_STORE: 'nonsense@' }), null);
  // Set and empty is a mistake, not the live store.
  assert.equal(storeOf({ CI_KIT_STORE: '' }), null);
});

test('a repository is found in the ledger by its GitHub name: its store directory and default branch', () => {
  assert.deepEqual(ledgerEntry('SSFSKIM/ci-kit'), { alias: 'SSFSKIM/ci-kit', branch: 'main' });
  assert.deepEqual(ledgerEntry('ssfskim/maws'), { alias: 'SSFSKIM/MAWS', branch: 'master' });
  assert.equal(ledgerEntry('someone/else'), null);
});

test('after a FAIL: base when the gate last failed on the default branch, and each entry in force without keep', () => {
  assert.deepEqual(contextLines(STATUS, 'test', { now: NOW, branch: 'main' }), [BASE, KNOWN]);
  // Its latest observation a success, and no entry naming it: nothing.
  assert.deepEqual(contextLines({ ...STATUS, known: [] }, 'lint', { now: NOW, branch: 'main' }), []);
  assert.deepEqual(contextLines(STATUS, 'lint', { now: NOW, branch: 'main' }), ['     known: other (review by 2026-11-26): another gate. Whether this failure is that one is not checked.']);
  // A gate with no standing at all.
  assert.deepEqual(contextLines({ ...STATUS, known: [] }, 'docs', { now: NOW, branch: 'main' }), []);
  // A reason spread over lines stays one line.
  const multi = { ...STATUS, gates: {}, known: [{ ...STATUS.known[0], reason: 'one\n  two' }] };
  assert.deepEqual(contextLines(multi, 'test', { now: NOW, branch: 'main' }), ['     known: maws-778 (review by 2026-11-26): one two. Whether this failure is that one is not checked.']);
});

test('a status 48 hours old or older, with no as_of, or not a status at all gives no context', () => {
  const at = (ms) => ({ ...STATUS, as_of: new Date(ms).toISOString() });
  assert.deepEqual(contextLines(at(NOW - 48 * HOUR + 1000), 'test', { now: NOW, branch: 'main' }), [BASE, KNOWN]);
  assert.deepEqual(contextLines(at(NOW - 48 * HOUR), 'test', { now: NOW, branch: 'main' }), []);
  assert.deepEqual(contextLines(at(NOW - 72 * HOUR), 'test', { now: NOW, branch: 'main' }), []);
  // A time far ahead of the clock is not a reading of the record.
  assert.deepEqual(contextLines(at(NOW + 2 * HOUR), 'test', { now: NOW, branch: 'main' }), []);
  assert.deepEqual(contextLines({ ...STATUS, as_of: null }, 'test', { now: NOW, branch: 'main' }), []);
  assert.deepEqual(contextLines({ ...STATUS, as_of: 'yesterday' }, 'test', { now: NOW, branch: 'main' }), []);
  for (const junk of [null, [], 'text', { as_of: STATUS.as_of }, { ...STATUS, gates: 'x' }]) {
    assert.deepEqual(contextLines(junk, 'test', { now: NOW, branch: 'main' }), []);
  }
});

const b64 = (text) => Buffer.from(text).toString('base64');

// The contents API of one repository, holding files by branch and path, with blob ids that change on every write.
function fakeStore(files = {}) {
  const calls = [];
  let version = 0;
  const key = (repo, branch, path) => `${repo}@${branch}:${path}`;
  const held = new Map(Object.entries(files).map(([k, text]) => [k, { text, sha: `s${(version += 1)}` }]));
  return {
    calls,
    held,
    gh: {
      contents: async (repo, path, ref) => {
        calls.push(['GET', repo, path, ref]);
        const f = held.get(key(repo, ref, path));
        if (!f) throw new GitHubError(404, `HTTP 404 GET /repos/${repo}/contents/${path}: Not Found`);
        await Promise.resolve();
        return { sha: f.sha, encoding: 'base64', content: b64(f.text).replace(/(.{60})/g, '$1\n') };
      },
      putContents: async (repo, path, body) => {
        calls.push(['PUT', repo, path, body.branch]);
        await Promise.resolve();
        const f = held.get(key(repo, body.branch, path));
        if (f && !body.sha) throw new GitHubError(422, 'HTTP 422: "sha" wasn\'t supplied.');
        if (f && body.sha !== f.sha) throw new GitHubError(409, `HTTP 409 PUT /repos/${repo}/contents/${path}: does not match`);
        if (!f && body.sha) throw new GitHubError(404, 'HTTP 404');
        held.set(key(repo, body.branch, path), { text: Buffer.from(body.content, 'base64').toString('utf8'), sha: `s${(version += 1)}` });
        return { content: {} };
      },
    },
  };
}

const STATUS_PATH = 'SSFSKIM/ci-kit-sandbox@test-history:SSFSKIM/ci-kit/status.json';

// A lookup settles over a few microtasks; a macrotask is past all of them (as a log download is, in ci-gate).
const settled = () => new Promise((r) => setImmediate(r));

test('the context is read with one contents call when started, and serves every failure after it settles', async () => {
  const s = fakeStore({ [STATUS_PATH]: JSON.stringify(STATUS, null, 1) });
  const context = contextReader({ gh: s.gh, repo: 'SSFSKIM/ci-kit', store: STORE, now: () => NOW });
  assert.deepEqual(context.linesFor('test'), []); // not started: nothing, and no call
  assert.equal(s.calls.length, 0);
  context.start();
  context.start();
  assert.deepEqual(context.linesFor('test'), []); // in flight: nothing yet
  await settled();
  assert.deepEqual(context.linesFor('test'), [BASE, KNOWN]);
  assert.deepEqual(context.linesFor('lint'), ['     known: other (review by 2026-11-26): another gate. Whether this failure is that one is not checked.']);
  assert.deepEqual(s.calls, [['GET', 'SSFSKIM/ci-kit-sandbox', 'SSFSKIM/ci-kit/status.json', 'test-history']]);
});

test('no status file, an unreadable store, a file that is not JSON, a repository outside the ledger, or a low budget: no context, no throw', async () => {
  const cases = [
    fakeStore({}).gh,
    { contents: async () => { throw new TypeError('fetch failed'); } },
    { contents: async () => { throw new GitHubError(403, 'HTTP 403 GET …: Resource not accessible'); } },
    { contents: () => { throw new Error('a synchronous throw'); } },
    fakeStore({ [STATUS_PATH]: '{"v":1,' }).gh,
  ];
  for (const gh of cases) {
    const context = contextReader({ gh, repo: 'SSFSKIM/ci-kit', store: STORE, now: () => NOW });
    context.start();
    await settled();
    assert.deepEqual(context.linesFor('test'), []);
  }
  const s = fakeStore({ [STATUS_PATH]: JSON.stringify(STATUS) });
  for (const opts of [{ repo: 'someone/else' }, { store: null }, { lowBudget: () => true }]) {
    const context = contextReader({ gh: s.gh, repo: 'SSFSKIM/ci-kit', store: STORE, now: () => NOW, ...opts });
    context.start();
    await settled();
    assert.deepEqual(context.linesFor('test'), []);
  }
  assert.equal(s.calls.length, 0);
});

test('a repos.json that is missing or malformed leaves the context off, found only when the context starts', async () => {
  const s = fakeStore({ [STATUS_PATH]: JSON.stringify(STATUS) });
  for (const readRepos of [() => { throw new Error('ENOENT: no such file'); }, () => JSON.parse('{')]) {
    const context = contextReader({ gh: s.gh, repo: 'SSFSKIM/ci-kit', store: STORE, now: () => NOW, readRepos });
    assert.doesNotThrow(() => context.start());
    await settled();
    assert.deepEqual(context.linesFor('test'), []);
  }
  assert.equal(s.calls.length, 0);
});

test('a field of the record is printed as one line of printable text, and a base line needs a real commit, time and run', () => {
  const line = (known) => contextLines({ ...STATUS, gates: {}, known: [{ ...STATUS.known[0], ...known }] }, 'test', { now: NOW, branch: 'main' });
  assert.deepEqual(line({ id: 'maws-778\nFAIL lint', reason: 'r\u001b[31m\r\nGREEN x' }), ['     known: maws-778 FAIL lint (review by 2026-11-26): r [31m GREEN x. Whether this failure is that one is not checked.']);
  for (const bad of [{ id: '' }, { id: 7 }, { reason: '\n' }, { reason: null }, { review_by: '2026-11-26\nx' }]) assert.deepEqual(line(bad), []);
  const base = (g) => contextLines({ ...STATUS, known: [], gates: { test: { ...STATUS.gates.test, ...g } } }, 'test', { now: NOW, branch: 'main' });
  assert.deepEqual(base({}), [BASE]);
  for (const bad of [{ commit: undefined }, { commit: 'not a commit' }, { commit: '3f2a91c\nGREEN' }, { run: undefined }, { run: '44262593045\nx' }, { run: -1 }, { at: 'soon' }, { at: undefined }]) {
    assert.deepEqual(base(bad), [], JSON.stringify(bad));
  }
  assert.deepEqual(base({ run: '44262593045' }), [BASE]);
});

test('ci-gate status: the standing per gate with its age, then the known entries with their state', () => {
  const known = STATUS.known;
  assert.deepEqual(statusReport({ status: STATUS, known, repo: 'SSFSKIM/ci-kit', branch: 'main', now: NOW }), [
    'SSFSKIM/ci-kit on main, as of 2026-11-20T07:11Z (0.8 hours ago):',
    '  lint  succeeded  1655a81  2026-11-20T00:48Z  run 44648285549',
    '  test  failed     3f2a91c  2026-11-18T10:49Z  run 44262593045',
    ...knownReport(known, '2026-11-20'),
  ]);
  const stale = statusReport({ status: { ...STATUS, as_of: '2026-11-17T00:00:00Z' }, known: [], repo: 'SSFSKIM/ci-kit', branch: 'main', now: NOW });
  assert.equal(stale[0], 'SSFSKIM/ci-kit on main, as of 2026-11-17T00:00Z (80.0 hours ago; older than 48 hours, so ci-gate shows none of it at a failure):');
  assert.equal(stale.at(-1), 'Known entries: none.');
  const ahead = statusReport({ status: { ...STATUS, as_of: '2026-11-20T11:00:00Z' }, known: [], repo: 'SSFSKIM/ci-kit', branch: 'main', now: NOW });
  assert.equal(ahead[0], "SSFSKIM/ci-kit on main, as of 2026-11-20T11:00Z (3.0 hours ahead of this machine's clock, so ci-gate shows none of it at a failure):");
  const invalid = statusReport({ status: { ...STATUS, as_of: 'yesterday\nGREEN' }, known: [], repo: 'SSFSKIM/ci-kit', branch: 'main', now: NOW });
  assert.equal(invalid[0], "SSFSKIM/ci-kit on main: the status's as_of is not a time (yesterday GREEN), so ci-gate shows none of it at a failure:");
  assert.equal(invalid[1], '  lint  succeeded  1655a81  2026-11-20T00:48Z  run 44648285549');
  const never = statusReport({ status: { v: 1, as_of: null, gates: {}, known: [] }, known: [], repo: 'SSFSKIM/ci-kit', branch: 'main', now: NOW });
  assert.deepEqual(never, ['SSFSKIM/ci-kit on main: no standing yet (no pass has derived the record).', 'Known entries: none.']);
});

test('ci-gate known list: every entry, in force, keep, expired or not yet begun, with its case and reason', () => {
  const entries = [...STATUS.known, { id: 'later', gate: 'test', reason: 'from tomorrow', since: '2026-11-21', review_by: '2026-11-30', by: 'x' }];
  assert.deepEqual(knownReport(entries, '2026-11-20'), [
    'Known entries (5):',
    '  maws-778  test  in force, review by 2026-11-26  (by ux-wave, since 2026-11-19)',
    '      case: panel.spec.ts › at its minimum size*',
    "      reason: #778: the banner steals the float card's body on the guest.",
    '  keep-test  test  keep, in force, review by 2027-02-19  (by CI-opt, since 2026-11-19)',
    '      reason: the only check of it',
    '  old  test  expired 2026-11-19  (by x, since 2026-11-01)',
    '      reason: expired',
    '  other  lint  in force, review by 2026-11-26  (by x, since 2026-11-19)',
    '      reason: another gate',
    '  later  test  from 2026-11-21, review by 2026-11-30  (by x, since 2026-11-21)',
    '      reason: from tomorrow',
  ]);
  assert.deepEqual(knownReport([], '2026-11-20'), ['Known entries: none.']);
});

const KNOWN_PATH = 'SSFSKIM/ci-kit-sandbox@a6-copy:SSFSKIM/ci-kit/known.json';
const COPY = { repo: 'SSFSKIM/ci-kit-sandbox', branch: 'a6-copy' };

test('known add writes the file on the store\'s branch, creating it when absent, as the store writes JSON', async () => {
  const s = fakeStore();
  const file = knownFile({ gh: s.gh, store: COPY, alias: 'SSFSKIM/ci-kit' });
  const entry = await addKnown({ ...file, fields: { gate: 'test', reason: 'r', review_by: '2026-11-27' }, today: '2026-11-20', by: 'CI-opt' });
  const text = s.held.get(KNOWN_PATH).text;
  assert.equal(text, `${JSON.stringify([entry], null, 1)}\n`);
  assert.deepEqual(file.read && (await file.read()).entries, [entry]);
  const put = s.calls.find((c) => c[0] === 'PUT');
  assert.deepEqual(put, ['PUT', 'SSFSKIM/ci-kit-sandbox', 'SSFSKIM/ci-kit/known.json', 'a6-copy']);
});

test('two adds whose reads raced both end in the file, through the contents API\'s refusal', async () => {
  const s = fakeStore({ [KNOWN_PATH]: '[]\n' });
  const file = knownFile({ gh: s.gh, store: COPY, alias: 'SSFSKIM/ci-kit' });
  let retried = 0;
  const add = (gate) => addKnown({ ...file, fields: { gate, reason: `r ${gate}`, review_by: '2026-11-27' }, today: '2026-11-20', by: 'x', onRetry: () => { retried += 1; } });
  await Promise.all([add('test'), add('lint')]); // both read the same blob before either writes
  assert.deepEqual(JSON.parse(s.held.get(KNOWN_PATH).text).map((e) => e.gate).sort(), ['lint', 'test']);
  assert.equal(retried, 1);
  // A file created by another writer between this read (none) and this write is a conflict too.
  const t = fakeStore();
  const f2 = knownFile({ gh: t.gh, store: COPY, alias: 'SSFSKIM/ci-kit' });
  await Promise.all([addKnown({ ...f2, fields: { gate: 'a', reason: 'r', review_by: '2026-11-27' }, today: '2026-11-20', by: 'x' }), addKnown({ ...f2, fields: { gate: 'b', reason: 'r', review_by: '2026-11-27' }, today: '2026-11-20', by: 'x' })]);
  assert.deepEqual(JSON.parse(t.held.get(KNOWN_PATH).text).map((e) => e.gate).sort(), ['a', 'b']);
});

test('a 422 on a write that named a blob is an error, not a retry: only the create race is retried', async () => {
  let puts = 0;
  const gh = { contents: async () => ({ sha: 'b1', content: Buffer.from('[]').toString('base64') }), putContents: async () => { puts += 1; throw new GitHubError(422, 'HTTP 422 PUT: Invalid request'); } };
  const file = knownFile({ gh, store: COPY, alias: 'SSFSKIM/ci-kit' });
  await assert.rejects(addKnown({ ...file, fields: { gate: 'a', reason: 'r', review_by: '2026-11-27' }, today: '2026-11-20', by: 'x' }), /HTTP 422/);
  assert.equal(puts, 1);
});

test('a write the store refuses for another reason is an error, not a retry', async () => {
  const gh = { contents: async () => { throw new GitHubError(404, 'HTTP 404'); }, putContents: async () => { throw new GitHubError(403, 'HTTP 403 PUT: Resource not accessible'); } };
  const file = knownFile({ gh, store: COPY, alias: 'SSFSKIM/ci-kit' });
  await assert.rejects(addKnown({ ...file, fields: { gate: 'a', reason: 'r', review_by: '2026-11-27' }, today: '2026-11-20', by: 'x' }), /HTTP 403/);
});

// The subcommands end to end, with the contents API faked and the clock fixed.
import { runLedger } from '../cli/ledger.mjs';

function runWith(argv, { files = {}, env = {} } = {}) {
  const s = fakeStore(files);
  const out = [];
  const err = [];
  const code = runLedger(argv, { gh: s.gh, out: (l) => out.push(l), note: (l) => err.push(l), env, now: () => NOW, user: () => 'tester' });
  return code.then((c) => ({ code: c, out, err, calls: s.calls, held: s.held }));
}

test('ci-gate known add with no reason or no review date is refused before the store is touched', async () => {
  for (const argv of [
    ['known', 'add', '--repo', 'SSFSKIM/ci-kit', '--gate', 'test', '--review-by', '2026-11-27'],
    ['known', 'add', '--repo', 'SSFSKIM/ci-kit', '--gate', 'test', '--reason', 'r'],
  ]) {
    const r = await runWith(argv);
    assert.equal(r.code, 2);
    assert.match(r.out.at(-1), /^ERROR an entry needs a (reason|review date)/);
    assert.equal(r.calls.length, 0);
  }
  // An option where a value belongs is not the value: `--reason --keep` stores no reason "--keep".
  const flag = await runWith(['known', 'add', '--repo', 'SSFSKIM/ci-kit', '--gate', 'test', '--reason', '--keep', '--review-by', '2026-11-27']);
  assert.equal(flag.code, 2);
  assert.match(flag.out.at(-1), /^ERROR --reason needs a value/);
  assert.equal(flag.calls.length, 0);
});

test('ci-gate known add writes only to the private store\'s repository, and an empty CI_KIT_STORE is an error', async () => {
  const add = ['known', 'add', '--repo', 'SSFSKIM/ci-kit', '--gate', 'test', '--reason', 'r', '--review-by', '2026-11-27'];
  const elsewhere = await runWith(add, { env: { CI_KIT_STORE: 'SSFSKIM/ci-kit@main' } });
  assert.deepEqual([elsewhere.code, elsewhere.out], [2, ['ERROR known add writes only to the private store, SSFSKIM/ci-kit-sandbox, not SSFSKIM/ci-kit']]);
  assert.equal(elsewhere.calls.length, 0);
  // Any branch of the store's repository will do: a test copy.
  const copy = await runWith(add, { env: { CI_KIT_STORE: 'ssfskim/ci-kit-sandbox@a6-copy' } });
  assert.equal(copy.code, 0);
  for (const argv of [add, ['status', '--repo', 'SSFSKIM/ci-kit'], ['known', 'list', '--repo', 'SSFSKIM/ci-kit']]) {
    const empty = await runWith(argv, { env: { CI_KIT_STORE: '' } });
    assert.deepEqual([empty.code, empty.out], [2, ['ERROR CI_KIT_STORE is set and empty; it is OWNER/NAME@BRANCH, or unset for the live store']]);
    assert.equal(empty.calls.length, 0);
  }
});

test('ci-gate known add writes the entry and says so; list and status read it back', async () => {
  const env = { CI_KIT_STORE: 'SSFSKIM/ci-kit-sandbox@a6-copy' };
  const added = await runWith(['known', 'add', '--repo', 'SSFSKIM/ci-kit', '--gate', 'test', '--reason', 'r', '--review-by', '2026-11-27'], { env });
  assert.equal(added.code, 0);
  assert.deepEqual(added.out, ["added test-2026-11-20 to SSFSKIM/ci-kit's known entries (gate test, review by 2026-11-27) in SSFSKIM/ci-kit-sandbox@a6-copy"]);
  const entry = JSON.parse(added.held.get(KNOWN_PATH).text)[0];
  assert.equal(entry.by, 'tester');
  const files = { [KNOWN_PATH]: added.held.get(KNOWN_PATH).text, 'SSFSKIM/ci-kit-sandbox@a6-copy:SSFSKIM/ci-kit/status.json': JSON.stringify(STATUS) };
  const listed = await runWith(['known', 'list', '--repo', 'SSFSKIM/ci-kit'], { files, env });
  assert.deepEqual(listed.out, knownReport([entry], '2026-11-20'));
  const status = await runWith(['status', '--repo', 'SSFSKIM/ci-kit'], { files, env });
  assert.equal(status.code, 0);
  assert.deepEqual(status.out, statusReport({ status: STATUS, known: [entry], repo: 'SSFSKIM/ci-kit', branch: 'main', now: NOW }));
});

test('ci-gate status: no status file, a repository outside the ledger, or a bad CI_KIT_STORE is an ERROR, exit 2', async () => {
  const none = await runWith(['status', '--repo', 'SSFSKIM/ci-kit']);
  assert.deepEqual([none.code, none.out], [2, ['ERROR no status.json for SSFSKIM/ci-kit in SSFSKIM/ci-kit-sandbox@test-history']]);
  const outside = await runWith(['status', '--repo', 'someone/else']);
  assert.equal(outside.code, 2);
  assert.match(outside.out[0], /^ERROR someone\/else is not a repository the gate ledger collects/);
  const bad = await runWith(['status', '--repo', 'SSFSKIM/ci-kit'], { env: { CI_KIT_STORE: 'x' } });
  assert.deepEqual([bad.code, bad.out], [2, ['ERROR CI_KIT_STORE is OWNER/NAME@BRANCH, not x']]);
});

// ci-gate's gate path imports cli/ledger.mjs: a repos.json that is missing or malformed must cost only the context.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('ci-gate loads with repos.json missing or malformed; the context is then off and status is an ERROR', async (t) => {
  const kit = join(dirname(fileURLToPath(import.meta.url)), '..');
  for (const repos of [null, '{']) {
    const root = mkdtempSync(join(tmpdir(), 'ci-kit-norepos-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const d of ['bin', 'cli', 'lib']) cpSync(join(kit, d), join(root, d), { recursive: true });
    mkdirSync(join(root, 'history'));
    cpSync(join(kit, 'history', 'known.mjs'), join(root, 'history', 'known.mjs'));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    if (repos !== null) writeFileSync(join(root, 'history', 'repos.json'), repos);
    const help = spawnSync(process.execPath, [join(root, 'bin', 'ci-gate'), '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    const ledger = await import(pathToFileURL(join(root, 'cli', 'ledger.mjs')).href);
    const s = fakeStore({ [STATUS_PATH]: JSON.stringify(STATUS) });
    const context = ledger.contextReader({ gh: s.gh, repo: 'SSFSKIM/ci-kit', store: STORE, now: () => NOW });
    context.start();
    await settled();
    assert.deepEqual([context.linesFor('test'), s.calls.length], [[], 0]);
    const out = [];
    const code = await ledger.runLedger(['status', '--repo', 'SSFSKIM/ci-kit'], { gh: s.gh, out: (l) => out.push(l), note: () => {}, env: {}, now: () => NOW });
    assert.equal(code, 2);
    assert.match(out[0], /^ERROR history\/repos\.json cannot be read/);
  }
});
