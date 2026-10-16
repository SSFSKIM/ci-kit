// The ledger issue's storage: one comment per server, written then finalized in place (spec I9), reconciled when
// concurrent writers made two (spec Decision Log, ledger coverage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerStore } from '../../pool/lib/ledger-store.mjs';
import { makeRow, parseRow } from '../../pool/lib/ledger.mjs';

// A shared fake issue. Every call yields first, so two stores' reads interleave before either writes.
function fakeGitHub() {
  const issues = [{ number: 3, title: 'pool ledger', pull_request: undefined }, { number: 4, title: 'pool ledger', pull_request: {} }];
  const comments = [];
  let id = 100;
  const calls = [];
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    calls, comments,
    openIssues: async () => { await tick(); return issues; },
    createIssue: async (_repo, issue) => { calls.push(`create issue ${issue.title}`); issues.push({ number: 9, ...issue }); return { number: 9 }; },
    issueComments: async (_repo, n) => { await tick(); return comments.filter((c) => c.issue === n).map((c) => ({ ...c })); },
    createComment: async (_repo, n, body) => { await tick(); calls.push(`create ${n}`); comments.push({ id: id++, issue: n, body }); },
    updateComment: async (_repo, cid, body) => { await tick(); calls.push(`update ${cid}`); comments.find((c) => c.id === cid).body = body; },
    deleteComment: async (_repo, cid) => {
      await tick();
      calls.push(`delete ${cid}`);
      const i = comments.findIndex((c) => c.id === cid);
      if (i < 0) { const e = new Error('Not Found'); e.status = 404; throw e; }
      comments.splice(i, 1);
    },
  };
}

const server = { id: 55, created: '2026-10-15T22:00:00Z', type: 'cpx62', location: 'hel1', price: 0.2452, jobs: 1 };
const REPO = { repo: 'SSFSKIM/ci-kit-sandbox', issue_title: 'pool ledger' };
const running = makeRow(server, { at: Date.parse('2026-10-15T22:01:00Z'), state: 'running' });
const deleting = makeRow(server, { deleted: Date.parse('2026-10-15T22:50:00Z'), end: 'idle', state: 'deleting' });
const final = { ...deleting, state: 'final' };

test('a row is written once and moved through running, deleting, final in the same comment; the issue is found by title, not a PR', async () => {
  const gh = fakeGitHub();
  const store = createLedgerStore(gh, REPO);
  await store.upsertRow(running);
  await store.upsertRow(deleting);
  await store.upsertRow(final);
  assert.deepEqual(gh.calls, ['create 3', 'update 100', 'update 100']);
  assert.equal(gh.comments.length, 1);
  assert.equal(parseRow(gh.comments[0].body).state, 'final');
  assert.deepEqual((await store.rows()).map((r) => r.server), [55]);
});

test('a row never moves back: a late running or deleting write leaves a final row as it is', async () => {
  const gh = fakeGitHub();
  const store = createLedgerStore(gh, REPO);
  await store.upsertRow(final);
  await store.upsertRow(running);
  await store.upsertRow(deleting);
  assert.deepEqual(gh.calls, ['create 3']);
  assert.equal(parseRow(gh.comments[0].body).state, 'final');
});

test('two writers that both find no row both create one; each reconciles to the same survivor, the most final', async () => {
  const gh = fakeGitHub();
  const guard = createLedgerStore(gh, REPO);
  const watchdog = createLedgerStore(gh, REPO);
  await Promise.all([guard.upsertRow(running), watchdog.upsertRow(deleting)]);
  assert.equal(gh.comments.length, 1);
  assert.equal(parseRow(gh.comments[0].body).state, 'deleting');
  assert.equal(gh.calls.filter((c) => c.startsWith('create')).length, 2);
  // A reader in between would have counted one row per server anyway.
  assert.equal((await createLedgerStore(gh, REPO).rows()).length, 1);
});

test('a reader counts one row per server even before a writer reconciles', async () => {
  const gh = fakeGitHub();
  gh.comments.push({ id: 1, issue: 3, body: (await import('../../pool/lib/ledger.mjs')).renderRow(running) });
  gh.comments.push({ id: 2, issue: 3, body: (await import('../../pool/lib/ledger.mjs')).renderRow(final) });
  const rows = await createLedgerStore(gh, REPO).rows();
  assert.deepEqual(rows.map((r) => [r.server, r.state]), [[55, 'final']]);
});

test('a missing ledger issue is created', async () => {
  const gh = fakeGitHub();
  const store = createLedgerStore(gh, { repo: 'SSFSKIM/ci-kit-sandbox', issue_title: 'another ledger' });
  await store.rows();
  assert.deepEqual(gh.calls, ['create issue another ledger']);
});
