import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBillingStore, parseReading, renderReading } from '../../gce/launcher/billing-store.mjs';
import { readBilling, creditStatus, createCreditManager } from '../../gce/launcher/credit.mjs';
import { finalRow, launchRow, runningRow } from '../../gce/launcher/ledger.mjs';
import { createGceLedger } from '../../gce/launcher/ledger-store.mjs';

const HOUR = 3600_000;
const NOW = Date.parse('2026-10-24T12:00:00Z');
const account = (id = '290475840169') => ({ account: id, region: 'us-east-2', roles: { launcher: `arn:aws:iam::${id}:role/ci-kit-ec2-launcher` },
  credit: { enabled: true, since: '2026-10-23', until: '2027-04-17', budget_usd: 180 } });
const reading = (at = NOW, amount = 10) => ({ v: 1, since: '2026-10-23', billed_usd: amount, through: '2026-10-25', read_at: new Date(at).toISOString() });
function github() {
  let next = 1;
  const issues = [], comments = [], deletes = [];
  return { issues, comments, deletes,
    openIssues: async () => issues.filter(i => i.state !== 'closed'),
    closedIssuesSince: async () => issues.filter(i => i.state === 'closed'),
    createIssue: async (repo, input) => { const i = { ...input, repo, number: next++, state: 'open' }; issues.push(i); return i; },
    issueComments: async (repo, issue) => comments.filter(c => c.repo === repo && c.issue === issue),
    createComment: async (repo, issue, body) => { const c = { id: next++, repo, issue, body }; comments.push(c); return c; },
    deleteComment: async (repo, id) => { deletes.push(id); comments.splice(comments.findIndex(c => c.id === id && c.repo === repo), 1); },
  };
}
const store = (gh, id = account().account) => createBillingStore(gh, { repo: 'owner/ledger', account: id });

test('immutable overlapping writes survive a fresh reader; account and configured since isolate readings', async () => {
  const gh = github(), older = store(gh), newer = store(gh);
  assert.equal(await older.read('2026-10-23'), null);
  await newer.append(reading(NOW, 12));
  await older.append(reading(NOW - HOUR, 11)); // older read completes last
  assert.equal(gh.comments.length, 2);
  assert.deepEqual(await store(gh).read('2026-10-23'), reading(NOW, 12));
  assert.equal(await store(gh).read('2026-10-22'), null);
  await store(gh, '111111111111').append(reading(NOW, 99));
  assert.equal((await store(gh).read('2026-10-23')).billed_usd, 12);
  assert.equal((await store(gh, '111111111111').read('2026-10-23')).billed_usd, 99);
  assert.deepEqual(gh.issues.map(i => i.title), ['ec2 credit 290475840169', 'ec2 credit 111111111111']);
});

test('pruning retains newest 20 by reading time, not creation order, and ignores unrelated comments', async () => {
  const gh = github(), s = store(gh);
  for (let i = 25; i >= 0; i--) await s.append(reading(NOW - i * 1000, i));
  await gh.createComment('owner/ledger', gh.issues[0].number, 'operator note');
  await s.append(reading(NOW - 50_000, 50));
  const held = gh.comments.map(c => parseReading(c.body)).filter(Boolean);
  assert.equal(held.length, 20);
  assert.deepEqual(held.map(r => r.billed_usd).sort((a,b) => a-b), Array.from({ length: 20 }, (_, i) => i));
  assert.ok(gh.comments.some(c => c.body === 'operator note'));
  assert.equal((await store(gh).read('2026-10-23')).billed_usd, 0);
});

test('duplicate issue creation and manually closed credit issues do not hide newer readings', async () => {
  const gh = github();
  const first = await gh.createIssue('owner/ledger', { title: 'ec2 credit 290475840169' });
  const second = await gh.createIssue('owner/ledger', { title: first.title });
  first.state = 'closed';
  await gh.createComment('owner/ledger', first.number, renderReading(reading(NOW, 33)));
  await gh.createComment('owner/ledger', second.number, renderReading(reading(NOW-HOUR, 22)));
  assert.equal((await store(gh).read('2026-10-23')).billed_usd, 33);
});

test('malformed readings cannot authorize credit', () => {
  for (const patch of [{ v: 2 }, { billed_usd: -1 }, { billed_usd: null }, { read_at: 'tomorrow' }, { read_at: '2026-02-30T12:00:00Z' }, { since: '2026-02-30' }, { through: '2026-10-22' }]) {
    assert.equal(parseReading(JSON.stringify({ ...reading(), ...patch })), null);
  }
  assert.deepEqual(parseReading(renderReading(reading())), reading());
});

test('Cost Explorer reads all pages of gross EC2 compute and Other, excluding credits/refunds', async () => {
  const inputs = [];
  const group = (kind, amount) => ({ Keys: [kind], Metrics: { UnblendedCost: { Amount: String(amount), Unit: 'USD' } } });
  const ce = { send: async c => { inputs.push(c.input); return inputs.length === 1 ? {
    ResultsByTime: [{ TimePeriod: { Start: '2026-10-23', End: '2026-10-25' }, Groups: [group('Usage', 15), group('Credit', -12), group('Refund', -1)], Estimated: true }], NextPageToken: 'page2',
  } : { ResultsByTime: [{ TimePeriod: { Start: '2026-10-23', End: '2026-10-25' }, Groups: [group('Fee', 2)], Estimated: true }] }; } };
  assert.deepEqual(await readBilling(ce, account().credit, NOW), reading(NOW, 17));
  assert.deepEqual(inputs[0], { TimePeriod: { Start: '2026-10-23', End: '2026-10-25' }, Granularity: 'DAILY', Metrics: ['UnblendedCost'],
    Filter: { Dimensions: { Key: 'SERVICE', Values: ['Amazon Elastic Compute Cloud - Compute', 'EC2 - Other'] } }, GroupBy: [{ Type: 'DIMENSION', Key: 'RECORD_TYPE' }] });
  assert.equal(inputs[1].NextPageToken, 'page2');
  await assert.rejects(readBilling({ send: async () => ({ ResultsByTime: [{ Groups: [group('Usage', 'not money')] }] }) }, account().credit, NOW), /cost|billing/i);
});

test('preference ends on budget, date, flag or stale/missing/wrong-period billing, without depending on rows', () => {
  const a = account();
  assert.deepEqual(creditStatus(a, reading(), NOW), { on: true, reason: null });
  for (const [row, reason] of [[reading(NOW, 180), 'budget'], [reading(NOW-48*HOUR-1), 'stale billing'], [null, 'stale billing'], [{ ...reading(), since: '2026-10-22' }, 'stale billing']]) {
    assert.deepEqual(creditStatus(a, row, NOW), { on: false, reason });
  }
  assert.equal(creditStatus(a, reading(NOW-48*HOUR), NOW).on, true);
  assert.equal(creditStatus(a, reading(NOW+HOUR), NOW).on, false);
  assert.equal(creditStatus({ ...a, credit: { ...a.credit, enabled: false } }, reading(), NOW).reason, 'disabled');
  const expiry = Date.parse('2027-04-17T23:59:59Z');
  assert.equal(creditStatus(a, reading(expiry), expiry).on, true);
  assert.equal(creditStatus(a, reading(expiry), expiry+1000).reason, 'date');
  const r = reading();
  finalRow({ provider: 'ec2', state: 'running', created: new Date(NOW-HOUR).toISOString(), price: { computeHourly: 2 } }, { end: 'finished', deleted: NOW });
  assert.equal(creditStatus(a, r, NOW).on, true);
  assert.deepEqual(r, reading());
});

test('manager bootstraps missing issues, refreshes daily with six-hour restart floor, and isolates failures', async () => {
  const gh = github(), calls = [], logs = []; let time = NOW;
  const accounts = [account(), account('111111111111')];
  const options = { gh, repo: 'owner/ledger', now: () => time, log: s => logs.push(s),
    awsFactory: ({ roleArn }) => ({ ce: { send: async () => { calls.push(roleArn); if (roleArn.includes('111111111111')) throw new Error('denied');
      return { ResultsByTime: [{ Groups: [{ Keys: ['Usage'], Metrics: { UnblendedCost: { Amount: '10', Unit: 'USD' } } }] }] }; } } }) };
  let manager = createCreditManager(options);
  let preference = await manager.update({ accounts });
  assert.equal(preference(accounts[0]), true);
  assert.equal(preference(accounts[1]), false);
  assert.equal(calls.length, 2);
  assert.match(logs.join('\n'), /credit preference off: stale billing.*111111111111/);
  await manager.update({ accounts });
  assert.equal(calls.length, 2, 'failed daily reads are not retried on every tick');
  manager = createCreditManager(options);
  await manager.update({ accounts: [accounts[0]] });
  assert.equal(calls.length, 2, 'fresh persisted reading survives a new process');
  time += 11*HOUR;
  await manager.update({ accounts: [accounts[0]] });
  assert.equal(calls.length, 2, 'same UTC day needs no repeat');
  time += 2*HOUR;
  await manager.update({ accounts: [accounts[0]] });
  assert.equal(calls.length, 3, 'new UTC day refreshes');
  time += 4*HOUR;
  await createCreditManager(options).update({ accounts: [accounts[0]] });
  assert.equal(calls.length, 3);
  // A reading late yesterday is still inside the six-hour floor after midnight and a restart.
  await store(gh).append(reading(Date.parse('2026-10-25T23:00:00Z')));
  time = Date.parse('2026-10-26T01:00:00Z');
  await createCreditManager(options).update({ accounts: [accounts[0]] });
  assert.equal(calls.length, 3);
});

test('failed refresh retains the last reading until stale, logging a policy transition just once', async () => {
  const gh = github(), a = account(); let time = NOW;
  await store(gh).append(reading(NOW-30*HOUR));
  const logs = [];
  const manager = createCreditManager({ gh, repo: 'owner/ledger', now: () => time, log: s => logs.push(s),
    awsFactory: () => ({ ce: { send: async () => { throw new Error('unavailable'); } } }) });
  assert.equal((await manager.update({ accounts: [a] }))(a), true);
  time += 20*HOUR;
  assert.equal((await manager.update({ accounts: [a] }))(a), false);
  await manager.update({ accounts: [a] });
  assert.equal(logs.filter(s => s.includes('credit preference off: stale billing')).length, 1);
  assert.equal((await store(gh).read(a.credit.since)).billed_usd, 10);
  a.credit.budget_usd = 5;
  assert.equal((await manager.update({ accounts: [a] }))(a), false);
  assert.equal(logs.filter(s => s.includes('credit preference off: budget')).length, 1);
});

test('an actually delayed older append cannot clobber a concurrent newer writer on restart', async () => {
  const gh = github();
  await store(gh).append(reading(NOW-2*HOUR));
  const create = gh.createComment;
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  gh.createComment = async (...args) => {
    if (parseReading(args[2]).billed_usd === 11) { entered(); await delayed; }
    return create(...args);
  };
  const older = store(gh).append(reading(NOW-HOUR, 11));
  await waiting;
  await store(gh).append(reading(NOW, 12));
  release();
  await older;
  assert.equal(parseReading(gh.comments.at(-1).body).billed_usd, 11);
  assert.deepEqual(await store(gh).read('2026-10-23'), reading(NOW, 12));
});

test('finalizing and posting an expensive allocation cannot update authoritative credit spend', async () => {
  const gh = github(), a = account();
  await store(gh).append(reading());
  const before = gh.comments.find(c => parseReading(c.body));
  const ledger = createGceLedger(gh, { repo: 'owner/ledger', issue_title: 'pool ledger' }, { now: () => NOW });
  const running = runningRow(launchRow({ alloc: 'abc', repo: 'owner/repo', cpus: 8, at: NOW-HOUR, config: 'test', provider: 'ec2', account: a.account }),
    { zone: 'us-east-2a', machine: 'c8a.2xlarge', provisioning: 'spot', created: NOW-HOUR });
  await ledger.upsert({ ...finalRow(running, { end: 'done', deleted: NOW }), dollars: 2000 });
  const manager = createCreditManager({ gh, repo: 'owner/ledger', now: () => NOW,
    awsFactory: () => { throw new Error('fresh reading must avoid CE'); } });
  assert.equal((await manager.update({ accounts: [a] }))(a), true);
  assert.deepEqual(await store(gh).read(a.credit.since), reading());
  assert.equal(gh.comments.filter(c => parseReading(c.body)).length, 1);
  assert.equal(gh.comments.find(c => c.id === before.id).body, before.body);
});

test('inaccessible billing issue reads cannot establish zero spend or enable preference', async () => {
  const gh = github(), a = account(), logs = [];
  gh.openIssues = async () => { throw new Error('GitHub unavailable'); };
  const manager = createCreditManager({ gh, repo: 'owner/ledger', now: () => NOW, log: s => logs.push(s),
    awsFactory: () => { throw new Error('must not refresh without durable storage'); } });
  assert.equal((await manager.update({ accounts: [a] }))(a), false);
  assert.equal(gh.comments.length, 0);
  assert.match(logs.join('\n'), /GitHub unavailable/);
  assert.match(logs.join('\n'), /credit preference off: stale billing/);
});
