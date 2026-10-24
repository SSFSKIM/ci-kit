#!/usr/bin/env node
// Read-only estimates for finalized VMs created in the window, beside lifetime AWS billing.
// node gce/cost-report.mjs [--since ISO] [--until ISO] [--repo owner/name]
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGitHub, ghToken } from '../lib/github.mjs';
import { readRows } from './latency-report.mjs';
import { createBillingStore } from './launcher/billing-store.mjs';
import { providerCosts, renderProviderCost, estimatedDollars } from './launcher/costs.mjs';

export function costSummary(rows, { project, ec2, readings = new Map() } = {}) {
  const groups = providerCosts(rows, project);
  for (const a of ec2?.accounts ?? []) {
    if (!a.credit) continue;
    let group = groups.find(g => g.provider === 'ec2' && g.account === a.account);
    if (!group) {
      group = { provider: 'ec2', account: a.account, vms: 0, dollars: 0, unpriced: 0, creditDollars: 0, creditUnpriced: 0 };
      groups.push(group);
    }
    const reading = readings.get(a.account) ?? null;
    Object.assign(group, { credit: a.credit, reading, remaining: reading ? Math.max(0, a.credit.budget_usd - reading.billed_usd) : null });
  }
  return groups.sort((a,b) => `${a.provider}/${a.account}`.localeCompare(`${b.provider}/${b.account}`));
}

export function renderCostReport(groups, { from, to }) {
  const lines = [`Pool costs, finalized VMs created ${new Date(from).toISOString()} → ${new Date(to).toISOString()}`,
    'Row estimates are gross, not invoices. Credit-funded estimates count placements with credit policy on; they do not measure actual credit application or drive placement.'];
  for (const g of groups) {
    lines.push(renderProviderCost(g));
    if (g.credit) {
      lines.push(`  credit-funded estimate ${estimatedDollars(g.creditUnpriced && !g.creditDollars ? null : g.creditDollars, g.creditUnpriced)} (report window)`);
      lines.push(g.reading ? `  AWS since=${g.reading.since}, billed_usd=${g.reading.billed_usd.toFixed(4)}, through=${g.reading.through}, read_at=${g.reading.read_at}, remaining budget=$${g.remaining.toFixed(2)}` :
        '  AWS billing unavailable; remaining budget unknown');
    }
  }
  return lines.join('\n');
}

export async function readCostReport({ gh, cfg, ec2, from, to, repo }) {
  const [all, billing] = await Promise.all([
    readRows(gh, cfg.ledger, from),
    Promise.all((ec2?.accounts ?? []).filter(a => a.credit).map(async a => [a.account,
      await createBillingStore(gh, { repo: cfg.ledger.repo, account: a.account }).read(a.credit.since)])),
  ]);
  const rows = all.filter(r => (!repo || r.repo === repo) && Date.parse(r.created) >= from && Date.parse(r.created) <= to);
  return costSummary(rows, { project: cfg.project, ec2, readings: new Map(billing) });
}

async function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--since', '--until', '--repo'].includes(argv[i]) || !argv[i+1]) throw new Error('usage: node gce/cost-report.mjs [--since ISO] [--until ISO] [--repo owner/name]');
    opts[argv[i].slice(2)] = argv[i+1];
  }
  const to = opts.until ? Date.parse(opts.until) : Date.now(), from = opts.since ? Date.parse(opts.since) : to - 86400_000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error('invalid report interval');
  const cfg = JSON.parse(readFileSync(new URL('../pool/config/gce.json', import.meta.url), 'utf8'));
  let ec2 = null;
  try { ec2 = JSON.parse(readFileSync(new URL('../pool/config/ec2.json', import.meta.url), 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  const token = ghToken();
  if (!token) throw new Error('gh is not authenticated (gh auth login)');
  const groups = await readCostReport({ gh: createGitHub(token), cfg, ec2, from, to, repo: opts.repo });
  console.log(renderCostReport(groups, { from, to }));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(err => { console.error(err.message); process.exitCode = 1; });
}
