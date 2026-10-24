// Finalized VM estimates, shared by daily ledger lines and the read-only cost report.
const round = n => Math.round(n * 1e4) / 1e4;
export function providerCosts(rows, project) {
  const groups = new Map();
  for (const r of rows) {
    if (r.state !== 'final' || r.seconds == null) continue; // refused attempts are not VMs
    const provider = r.provider ?? 'gce', account = r.account ?? (provider === 'gce' ? project : null) ?? '(unknown)';
    const key = `${provider}/${account}`;
    if (!groups.has(key)) groups.set(key, { provider, account, vms: 0, dollars: 0, unpriced: 0, creditDollars: 0, creditUnpriced: 0 });
    const g = groups.get(key);
    g.vms++;
    if (Number.isFinite(r.dollars)) {
      g.dollars = round(g.dollars + r.dollars);
      if (r.credit_policy === 'on') g.creditDollars = round(g.creditDollars + r.dollars);
    } else {
      g.unpriced++;
      if (r.credit_policy === 'on') g.creditUnpriced++;
    }
  }
  for (const g of groups.values()) if (g.unpriced === g.vms) g.dollars = null;
  return [...groups.values()].sort((a, b) => `${a.provider}/${a.account}`.localeCompare(`${b.provider}/${b.account}`));
}

export const estimatedDollars = (amount, unpriced = 0) => amount === null ? 'unpriced' :
  `$${amount.toFixed(4)}${unpriced ? ` + ${unpriced} unpriced` : ''}`;
export const renderProviderCost = g => `${g.provider}/${g.account}: ${g.vms} VMs, estimated gross ${estimatedDollars(g.dollars, g.unpriced)}`;
