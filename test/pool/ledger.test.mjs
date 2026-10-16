// Ledger rows (spec I9): one comment per server session, written as `deleting` and finalized in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  billedHours, makeRow, renderRow, parseRow, rowComment, hoursOnDay, weeklySummary, lastSummaryAt, renderSummary, rowsOf,
  extraRowComments,
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

test('pool hours on a day count the billed hours that begin in that UTC day, across midnight both ways', () => {
  const now = t('2026-10-15T15:30:00Z');
  const rows = [
    // 08:00–09:50: two billed hours, both on the 15th.
    makeRow({ ...server, id: 1, created: '2026-10-15T08:00:00Z' }, { deleted: t('2026-10-15T09:50:00Z'), end: 'idle', state: 'final' }),
    // 23:30 on the 14th to 00:50: two billed hours, 23:30 (the 14th) and 00:30 (the 15th).
    makeRow({ ...server, id: 2, created: '2026-10-14T23:30:00Z' }, { deleted: t('2026-10-15T00:50:00Z'), end: 'idle', state: 'final' }),
  ];
  // A live server without a row, up since 13:10: 13:10, 14:10, 15:10 so far.
  const live = [{ id: 4, created: '2026-10-15T13:10:00Z' }];
  assert.equal(hoursOnDay(rows, live, now), 2 + 1 + 3);
  assert.equal(hoursOnDay(rows, live, now, t('2026-10-14T12:00:00Z')), 1);
});

test('a server confirmed live counts to now whatever its row says: a provisional deleting row does not freeze its hours', () => {
  // The agent wrote `deleting` at 14:50 and crashed before its delete call; a restarted agent resumed work, and the
  // server is still listed at 17:20. Its billed hours begin 14:00, 15:00, 16:00, 17:00.
  const row = makeRow({ ...server, id: 3, created: '2026-10-15T14:00:00Z' }, { deleted: t('2026-10-15T14:50:00Z'), end: 'idle', state: 'deleting' });
  const live = [{ id: 3, created: '2026-10-15T14:00:00Z' }];
  assert.equal(hoursOnDay([row], live, t('2026-10-15T17:20:00Z')), 4);
  // Once it is gone, the row's deleted time ends it again.
  assert.equal(hoursOnDay([row], [], t('2026-10-15T17:20:00Z')), 1);
  // A final row of a live server (a stale write healed later) counts to now as well.
  assert.equal(hoursOnDay([{ ...row, state: 'final' }], live, t('2026-10-15T17:20:00Z')), 4);
});

test('a live session that started yesterday counts only its hours since midnight today', () => {
  const now = t('2026-10-16T02:15:00Z');
  const running = makeRow({ ...server, id: 9, created: '2026-10-15T22:40:00Z' }, { at: t('2026-10-15T22:41:00Z'), state: 'running' });
  // Billed hours begin 22:40, 23:40 (the 15th), 00:40, 01:40 (the 16th); live, so it runs to now.
  assert.equal(hoursOnDay([running], [{ id: 9, created: '2026-10-15T22:40:00Z' }], now), 2);
  assert.equal(hoursOnDay([running], [{ id: 9, created: '2026-10-15T22:40:00Z' }], now, t('2026-10-15T10:00:00Z')), 2);
  // Gone without a deleter's row: it ends when its row was last written.
  assert.equal(hoursOnDay([running], [], now), 0);
});

test('a running row is provisional: written at boot, never downgrading a later state', () => {
  const running = makeRow(server, { at: t('2026-10-15T22:01:00Z'), state: 'running' });
  assert.equal(running.deleted, null);
  assert.equal(running.end, null);
  assert.match(renderRow(running), /\| 123 \| 2026-10-15 22:00:12 \| running, seen 2026-10-15 22:01:00 \| cpx62@hel1 \| 1 \| 0\.25 \| 3 \| - \|/);
  assert.deepEqual(parseRow(renderRow(running)), running);
});

test('duplicate rows for one server reconcile deterministically: the most final wins, then the oldest comment', () => {
  const running = makeRow(server, { at: t('2026-10-15T22:01:00Z'), state: 'running' });
  const deleting = makeRow(server, { deleted: t('2026-10-15T22:51:00Z'), end: 'idle', state: 'deleting' });
  const final = { ...deleting, state: 'final' };
  const c = (id, row) => ({ id, body: renderRow(row) });
  assert.deepEqual(rowsOf([c(5, running), c(3, deleting), c(9, final)]).map((r) => r.state), ['final']);
  assert.equal(rowComment([c(5, running), c(3, deleting)], 123).id, 3);
  assert.equal(rowComment([c(7, deleting), c(3, deleting)], 123).id, 3);
  assert.deepEqual(extraRowComments([c(7, deleting), c(3, deleting), c(4, running), { id: 1, body: 'x' }], 123).map((x) => x.id), [7, 4]);
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
