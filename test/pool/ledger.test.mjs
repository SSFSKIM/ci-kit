// Ledger rows (spec I9): one comment per server session, written as `deleting` and finalized in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  billedHours, makeRow, renderRow, parseRow, rowComment, hoursOnDay, weeklySummary, lastSummaryAt, renderSummary,
} from '../../pool/lib/ledger.mjs';

const t = (iso) => Date.parse(iso);
const server = { id: 123, created: '2026-10-15T22:00:12Z', type: 'cpx62', location: 'hel1', price: 0.2452, jobs: 3 };

test('billed hours count started hours from the server\'s created time, at least one', () => {
  assert.equal(billedHours(t('2026-10-15T22:00:00Z'), t('2026-10-15T22:00:00Z')), 1);
  assert.equal(billedHours(t('2026-10-15T22:00:00Z'), t('2026-10-15T22:59:59Z')), 1);
  assert.equal(billedHours(t('2026-10-15T22:00:00Z'), t('2026-10-15T23:00:00Z')), 1);
  assert.equal(billedHours(t('2026-10-15T22:00:00Z'), t('2026-10-15T23:00:01Z')), 2);
});

test('a row renders as the I9 table with a machine-readable marker, and parses back', () => {
  const row = makeRow(server, { deleted: t('2026-10-15T22:51:02Z'), end: 'idle', state: 'deleting' });
  assert.equal(row.billed, 1);
  assert.equal(row.euros, 0.25);
  const body = renderRow(row);
  assert.match(body, /^<!-- ci-kit-ledger \{.*\} -->\n/);
  assert.match(body, /\| server id \| created \(UTC\) \| deleted \(UTC\) \| type@location \| billed h \| € \| jobs \| end \|/);
  assert.match(body, /\| 123 \| 2026-10-15 22:00:12 \| deleting 2026-10-15 22:51:02 \| cpx62@hel1 \| 1 \| 0\.25 \| 3 \| idle \|/);
  assert.deepEqual(parseRow(body), row);
  const final = renderRow({ ...row, state: 'final' });
  assert.match(final, /\| 123 \| 2026-10-15 22:00:12 \| 2026-10-15 22:51:02 \| cpx62@hel1 \|/);
  assert.equal(parseRow('just a comment'), null);
});

test('unknown price or jobs render as a dash', () => {
  const row = makeRow({ ...server, price: null, jobs: null }, { deleted: t('2026-10-16T00:30:00Z'), end: 'stale-heartbeat', state: 'final' });
  assert.equal(row.billed, 3);
  assert.match(renderRow(row), /\| cpx62@hel1 \| 3 \| - \| - \| stale-heartbeat \|/);
});

test('a row is found by server id among the issue\'s comments; at most one per server', () => {
  const comments = [
    { id: 1, body: 'pool ledger' },
    { id: 2, body: renderRow(makeRow({ ...server, id: 7 }, { deleted: t('2026-10-15T20:00:00Z'), end: 'idle', state: 'final' })) },
    { id: 3, body: renderRow(makeRow(server, { deleted: t('2026-10-15T22:51:02Z'), end: 'idle', state: 'deleting' })) },
  ];
  assert.equal(rowComment(comments, 123).id, 3);
  assert.equal(rowComment(comments, 7).id, 2);
  assert.equal(rowComment(comments, 8), null);
});

test('a crash window across an hour boundary: the same row is rewritten with the true deletion time, hours and reason', () => {
  // The agent wrote its row at 22:59:30 and died before its delete call; the guard deletes it at 23:14.
  const provisional = makeRow(server, { deleted: t('2026-10-15T22:59:30Z'), end: 'idle', state: 'deleting' });
  assert.equal(provisional.billed, 1);
  const rewritten = makeRow(server, { deleted: t('2026-10-15T23:14:00Z'), end: 'stale-heartbeat', state: 'final' });
  assert.equal(rewritten.billed, 2);
  assert.equal(rewritten.euros, 0.49);
  assert.equal(rewritten.server, provisional.server);
});

test('pool hours today count rows created today and live servers without a row', () => {
  const now = t('2026-10-15T15:30:00Z');
  const rows = [
    makeRow({ ...server, id: 1, created: '2026-10-15T08:00:00Z' }, { deleted: t('2026-10-15T09:50:00Z'), end: 'idle', state: 'final' }),
    makeRow({ ...server, id: 2, created: '2026-10-14T23:30:00Z' }, { deleted: t('2026-10-15T00:50:00Z'), end: 'idle', state: 'final' }),
    makeRow({ ...server, id: 3, created: '2026-10-15T14:00:00Z' }, { deleted: t('2026-10-15T14:50:00Z'), end: 'idle', state: 'deleting' }),
  ];
  const live = [{ id: 3, created: '2026-10-15T14:00:00Z' }, { id: 4, created: '2026-10-15T13:10:00Z' }];
  assert.equal(hoursOnDay(rows, live, now), 2 + 1 + 3);
});

test('the weekly summary covers sessions deleted in the last 7 days and projects a 30-day month', () => {
  const now = t('2026-10-22T00:05:00Z');
  const rows = [
    makeRow({ ...server, id: 1, created: '2026-10-15T08:00:00Z' }, { deleted: t('2026-10-15T09:50:00Z'), end: 'idle', state: 'final' }),
    makeRow({ ...server, id: 2, created: '2026-10-20T08:00:00Z', jobs: 5 }, { deleted: t('2026-10-20T08:50:00Z'), end: 'idle', state: 'final' }),
    makeRow({ ...server, id: 3, created: '2026-10-01T08:00:00Z' }, { deleted: t('2026-10-01T08:50:00Z'), end: 'idle', state: 'final' }),
  ];
  const s = weeklySummary(rows, now);
  assert.deepEqual(s, { from: '2026-10-15T00:05:00.000Z', to: '2026-10-22T00:05:00.000Z', sessions: 2, hours: 3, euros: 0.74, jobs: 8, month: 3.17 });
  const body = renderSummary(s);
  assert.match(body, /^<!-- ci-kit-ledger-summary \{"at":"2026-10-22T00:05:00.000Z"\} -->/);
  assert.match(body, /2 sessions, 3 billed hours, €0\.74, 8 jobs; projected month €3\.17/);
  assert.equal(lastSummaryAt([{ body: 'x' }, { body }, { body: renderSummary({ ...s, to: '2026-10-01T00:00:00.000Z' }) }]), t('2026-10-22T00:05:00Z'));
  assert.equal(lastSummaryAt([{ body: 'x' }]), null);
});
