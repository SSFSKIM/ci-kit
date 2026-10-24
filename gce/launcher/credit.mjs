// Account policy reads AWS charges, never allocation estimates or finalize events.
import { GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { createAws } from '../../lib/aws.mjs';
import { createBillingStore, parseReading } from './billing-store.mjs';

const HOUR = 3600_000;
const day = t => new Date(t).toISOString().slice(0, 10);

export async function readBilling(ce, credit, at = Date.now()) {
  const through = day(at + 24 * HOUR); // CE's exclusive end includes today's provisional charges
  const input = {
    TimePeriod: { Start: credit.since, End: through }, Granularity: 'DAILY', Metrics: ['UnblendedCost'],
    Filter: { Dimensions: { Key: 'SERVICE', Values: ['Amazon Elastic Compute Cloud - Compute', 'EC2 - Other'] } },
    GroupBy: [{ Type: 'DIMENSION', Key: 'RECORD_TYPE' }],
  };
  let token, billed = 0;
  do {
    const result = await ce.send(new GetCostAndUsageCommand({ ...input, ...(token ? { NextPageToken: token } : {}) }));
    if (!Array.isArray(result.ResultsByTime) || !result.ResultsByTime.length) throw new Error('billing: missing cost intervals');
    for (const period of result.ResultsByTime) {
      if (!Array.isArray(period.Groups)) throw new Error('billing: missing record-type cost groups');
      for (const group of period.Groups) {
        const metric = group.Metrics?.UnblendedCost;
        const amount = Number(metric?.Amount);
        if (!group.Keys?.[0] || typeof metric?.Amount !== 'string' || !metric.Amount.trim() ||
            !Number.isFinite(amount) || metric.Unit !== 'USD') throw new Error('billing: invalid USD cost group');
        // Credit and refunds must not hide charges consuming the promotional budget. Other adjustments
        // cannot reduce the gross estimate either; this is conservative preference, not an invoice total.
        if (!['Credit', 'Refund'].includes(group.Keys[0])) billed += Math.max(0, amount);
      }
    }
    token = result.NextPageToken;
  } while (token);
  return { v: 1, since: credit.since, billed_usd: Math.round(billed * 1e8) / 1e8, through, read_at: new Date(at).toISOString() };
}

export function creditStatus(account, reading, at = Date.now()) {
  const c = account.credit;
  if (!c) return { on: true, reason: null }; // no credit block: keep the repo's explicit list order
  let reason;
  const valid = reading && parseReading(JSON.stringify(reading)) && reading.since === c.since;
  if (!c.enabled) reason = 'disabled';
  else if (day(at) > c.until) reason = 'date';
  else if (valid && reading.billed_usd >= c.budget_usd) reason = 'budget';
  else if (!valid || Date.parse(reading.read_at) > at || at - Date.parse(reading.read_at) > 48 * HOUR) reason = 'stale billing';
  return { on: !reason, reason: reason ?? null };
}

export function createCreditManager({ gh, repo, now = Date.now, log = () => {}, awsFactory = createAws }) {
  const states = new Map();
  return {
    async update(ec2) {
      const statuses = new Map();
      await Promise.all((ec2?.accounts ?? []).map(async account => {
        if (!account.credit) return;
        const key = `${account.account}/${account.credit.since}/${account.roles.launcher}`;
        if (!states.has(key)) states.set(key, { store: createBillingStore(gh, { repo, account: account.account }), loaded: -Infinity, attempted: -Infinity, reading: null });
        const state = states.get(key), at = now();
        if (at - state.loaded >= 5 * 60_000) {
          try {
            state.reading = await state.store.read(account.credit.since);
            if (Date.parse(state.reading?.read_at) > at) state.reading = null;
            state.loaded = at;
            const readAt = Date.parse(state.reading?.read_at);
            const due = !state.reading || (day(readAt) !== day(at) && at - readAt >= 6 * HOUR);
            if (due && at - state.attempted >= HOUR) {
              state.attempted = at; // best-effort retry pacing, not a distributed lock
              state.aws ??= awsFactory({ roleArn: account.roles.launcher, region: account.region, log });
              const reading = await readBilling(state.aws.ce, account.credit, at);
              await state.store.append(reading); // policy never depends on a reading that was not durably written
              state.reading = await state.store.read(account.credit.since); // another writer may already be newer
            }
          } catch (err) { log(`billing refresh failed: ${account.account}: ${err.message}`); }
        }
        const status = creditStatus(account, state.reading, at);
        const signature = status.on ? 'on' : status.reason;
        if (state.status !== signature) {
          log(`credit preference ${status.on ? 'on' : `off: ${status.reason}`}: ${account.account}`);
          state.status = signature;
        }
        statuses.set(account.account, status.on);
      }));
      return account => !account.credit || statuses.get(account.account) === true;
    },
  };
}
