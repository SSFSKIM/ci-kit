import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costSummary, renderCostReport, readCostReport } from '../../gce/cost-report.mjs';
import { renderByProviderZone } from '../../gce/latency-report.mjs';
import { dailyLine, renderDaily, renderRow } from '../../gce/launcher/ledger.mjs';
import { renderReading } from '../../gce/launcher/billing-store.mjs';

const day = '2026-10-24', at = `${day}T12:00:00.000Z`;
const credit = { enabled: true, since: '2026-10-23', until: '2027-04-17', budget_usd: 180 };
const reading = { v: 1, since: credit.since, through: '2026-10-25', read_at: at, billed_usd: 12 };
const row = (alloc, provider, account, dollars, credit_policy = 'off') => ({
  v: 2, alloc, instance: `ci-kit-${provider}-${alloc}`, provider, account, cpus: 8, repo: 'owner/repo', state: 'final', end: 'done',
  created: at, deleted: `${day}T12:01:00.000Z`, running: `${day}T12:00:10.000Z`, seconds: 60,
  job: { queued: at, started: `${day}T12:00:20.000Z` }, dollars, credit_policy,
  zone: provider === 'gce' ? 'us-west4-a' : 'us-east-2a', region: provider === 'gce' ? 'us-west4' : 'us-east-2',
  machine: provider === 'gce' ? 'c4d-highcpu-8' : 'c8a.2xlarge',
});
const rows = [row('g', 'gce', 'project', .1), row('a', 'ec2', '111111111111', .2, 'on'),
  row('b', 'ec2', '111111111111', null, 'on'), row('c', 'ec2', '222222222222', null)];
const options = { project: 'project', ec2: { accounts: [{ account: '111111111111', credit }, { account: '222222222222' }] }, readings: new Map([['111111111111', reading]]) };

test('costs group per instance, label unknown rates and keep credited estimates separate from authoritative billing', () => {
  const groups = costSummary([...rows, { provider: 'ec2', account: '111111111111', state: 'final', seconds: null, end: 'refused' }], options);
  assert.deepEqual(groups, [
    { provider: 'ec2', account: '111111111111', vms: 2, dollars: .2, unpriced: 1, creditDollars: .2, creditUnpriced: 1, credit, reading, remaining: 168 },
    { provider: 'ec2', account: '222222222222', vms: 1, dollars: null, unpriced: 1, creditDollars: 0, creditUnpriced: 0 },
    { provider: 'gce', account: 'project', vms: 1, dollars: .1, unpriced: 0, creditDollars: 0, creditUnpriced: 0 },
  ]);
  const text = renderCostReport(groups, { from: Date.parse(at), to: Date.parse(at)+3600_000 });
  assert.match(text, /ec2\/111111111111: 2 VMs, estimated gross \$0\.2000 \+ 1 unpriced/);
  assert.match(text, /credit-funded estimate \$0\.2000 \+ 1 unpriced/);
  assert.match(text, /billed_usd=12\.0000, through=2026-10-25, read_at=2026-10-24T12:00:00.000Z, remaining budget=\$168\.00/);
  assert.match(text, /ec2\/222222222222: 1 VMs, estimated gross unpriced/);
  assert.doesNotMatch(text, /ec2\/222222222222[^\n]*\$0/);
  assert.match(text, /gce\/project: 1 VMs, estimated gross \$0\.1000/);
});

test('credit accounts without VMs still report their billing and missing readings never invent remaining budget', () => {
  const group = costSummary([], { ...options, readings: new Map() })[0];
  assert.equal(group.vms, 0);
  assert.equal(group.reading, null);
  assert.equal(group.remaining, null);
  assert.match(renderCostReport([group], { from: Date.parse(at), to: Date.parse(at) }), /billing unavailable; remaining budget unknown/);
  assert.equal(costSummary([], { ...options, readings: new Map([['111111111111', { ...reading, billed_usd: 200 }]]) })[0].remaining, 0);
  assert.equal(costSummary([row('old', 'gce', null, .2)], options).find(g => g.provider === 'gce').account, 'project');
});

test('cost CLI read path filters its window and repo but reads lifetime credit independently and performs no writes', async () => {
  const cfg = { project: 'project', ledger: { repo: 'owner/ledger', issue_title: 'pool ledger' } };
  const gh = {
    openIssues: async () => [{ number: 1, title: 'pool ledger' }, { number: 2, title: 'ec2 credit 111111111111' }],
    closedIssuesSince: async () => [],
    issueComments: async (_repo, issue) => issue === 1 ? [...rows, { ...row('outside', 'ec2', '111111111111', 7), created: '2026-10-23T00:00:00Z' },
      { ...row('other', 'ec2', '111111111111', 8), repo: 'other/repo' }].map((r,i) => ({ id: i+1, body: renderRow(r) })) : [
        { id: 20, body: renderReading(reading) }, { id: 21, body: renderReading({ ...reading, billed_usd: 9, read_at: '2026-10-24T11:00:00Z' }) }],
  };
  const result = await readCostReport({ gh, cfg, ec2: options.ec2, from: Date.parse(at), to: Date.parse(at)+3600_000, repo: 'owner/repo' });
  const group = result.find(g => g.account === '111111111111');
  assert.equal(group.dollars, .2);
  assert.equal(group.reading.billed_usd, 12);
});

test('latency stages stay separated by provider, account and zone rather than mixing different boot paths', () => {
  const slow = { ...rows[1], zone: 'us-east-2c', job: { ...rows[1].job, started: `${day}T12:01:40Z` } };
  const text = renderByProviderZone([rows[0], rows[1], slow]);
  assert.match(text, /ec2\/111111111111 us-east-2a \(1 VM\)[\s\S]*insert accepted → job started +20\.0 s/);
  assert.match(text, /ec2\/111111111111 us-east-2c \(1 VM\)[\s\S]*insert accepted → job started +100\.0 s/);
  assert.match(text, /gce\/project us-west4-a \(1 VM\)/);
});

test('mixed-cloud daily lines name each provider instance, keep EC2 regions intact, and never price unknowns as zero', () => {
  const daily = dailyLine(rows, day, 'commit');
  const text = renderDaily(daily);
  assert.match(text, /ec2\/111111111111: 2 VMs, estimated gross \$0\.2000 \+ 1 unpriced/);
  assert.match(text, /ec2\/222222222222: 1 VMs, estimated gross unpriced/);
  assert.match(text, /c8a@us-east-2/);
  assert.doesNotMatch(text, /c8a\.2xlarge@us-east,/);
  assert.match(text, /gce\/project: 1 VMs/);
  const unpriced = renderDaily(dailyLine([rows[3]], day, 'commit'));
  assert.doesNotMatch(unpriced, /\$0\.00/);
  assert.match(unpriced, /projected month unpriced/);
});

test('mixed-cloud prelaunch subtotals retain unknown costs rather than reporting free unclaimed VMs', () => {
  const unpriced = { ...row('unclaimed', 'ec2', '111111111111', null), job: undefined, prelaunch: { run: 1, attempt: 1 } };
  const daily = dailyLine([rows[0], unpriced], day, 'commit');
  assert.deepEqual(daily.prelaunched, { vms: 1, unclaimed: 1, unclaimedDollars: null, unclaimedUnpriced: 1 });
  const text = renderDaily(daily);
  assert.match(text, /Pre-launched: 1 VMs, 1 unclaimed \(unpriced\)/);
  assert.doesNotMatch(text, /unclaimed \(\$0/);
  const priced = { ...unpriced, alloc: 'priced', dollars: .2 };
  const mixed = dailyLine([rows[0], unpriced, priced], day, 'commit');
  assert.deepEqual(mixed.prelaunched, { vms: 2, unclaimed: 2, unclaimedDollars: .2, unclaimedUnpriced: 1 });
  assert.match(renderDaily(mixed), /2 unclaimed \(\$0\.2000 \+ 1 unpriced\)/);
  const knownZero = dailyLine([rows[0], { ...priced, dollars: 0 }], day, 'commit');
  assert.match(renderDaily(knownZero), /1 unclaimed \(\$0\.0000\)/, 'known zero is not an unknown rate');
});
