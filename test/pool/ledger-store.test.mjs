// The ledger issue's storage: one comment per server, written then finalized in place (spec I9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerStore } from '../../pool/lib/ledger-store.mjs';
import { makeRow, parseRow } from '../../pool/lib/ledger.mjs';

function fakeGitHub() {
  const issues = [{ number: 3, title: 'pool ledger', pull_request: undefined }, { number: 4, title: 'pool ledger', pull_request: {} }];
  const comments = [];
  let id = 100;
  const calls = [];
  return {
    calls, comments,
    openIssues: async () => issues,
    createIssue: async (_repo, issue) => { calls.push(`create issue ${issue.title}`); issues.push({ number: 9, ...issue }); return { number: 9 }; },
    issueComments: async (_repo, n) => comments.filter((c) => c.issue === n),
    createComment: async (_repo, n, body) => { calls.push(`create ${n}`); comments.push({ id: id++, issue: n, body }); },
    updateComment: async (_repo, cid, body) => { calls.push(`update ${cid}`); comments.find((c) => c.id === cid).body = body; },
  };
}

const server = { id: 55, created: '2026-10-15T22:00:00Z', type: 'cpx62', location: 'hel1', price: 0.2452, jobs: 1 };

test('a row is written once and finalized in the same comment; the issue is found by title, not a PR', async () => {
  const gh = fakeGitHub();
  const store = createLedgerStore(gh, { repo: 'SSFSKIM/ci-kit-sandbox', issue_title: 'pool ledger' });
  await store.upsertRow(makeRow(server, { deleted: Date.parse('2026-10-15T22:50:00Z'), end: 'idle', state: 'deleting' }));
  await store.upsertRow(makeRow(server, { deleted: Date.parse('2026-10-15T22:50:00Z'), end: 'idle', state: 'final' }));
  assert.deepEqual(gh.calls, ['create 3', 'update 100']);
  assert.equal(gh.comments.length, 1);
  assert.equal(parseRow(gh.comments[0].body).state, 'final');
  assert.deepEqual((await store.rows()).map((r) => r.server), [55]);
});

test('a missing ledger issue is created', async () => {
  const gh = fakeGitHub();
  const store = createLedgerStore(gh, { repo: 'SSFSKIM/ci-kit-sandbox', issue_title: 'another ledger' });
  await store.rows();
  assert.deepEqual(gh.calls, ['create issue another ledger']);
});
