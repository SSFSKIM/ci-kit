// Per-repo walks and synchronous admission. Neither cloud calls nor ledger I/O belongs here.
import { providerKey, requiredProvider } from './providers/contracts.mjs';

export const identity = (value, project) => ({ provider: value.provider ?? value.name ?? 'gce', account: value.account ?? value.candidate?.account ?? ((value.provider ?? value.name ?? 'gce') === 'gce' ? project : null) });
export const keyOf = (value, project) => providerKey(identity(value, project));

export function providerWalk({ repo, cpus, job, cfg, repoProviders, providers, ec2, creditPreference = () => true }) {
  const required = job ? requiredProvider(job.labels) : 'any';
  const refs = repoProviders?.[repo] ?? cfg.repos.find((r) => r.repo.toLowerCase() === repo.toLowerCase())?.providers ?? [{ provider: 'gce', account: cfg.project }];
  const listed = refs.map((ref) => ({ ...ref, account: ref.account ?? (ref.provider === 'gce' ? cfg.project : ec2?.accounts?.length === 1 ? ec2.accounts[0].account : null) }));
  const allowed = listed.filter((ref) => required === 'any' || ref.provider === required);
  const eligible = allowed.flatMap((ref) => {
    const provider = providers.get(providerKey(ref));
    if (!provider) return [];
    const account = ref.provider === 'ec2' ? ec2?.accounts.find((a) => a.account === ref.account) : null;
    if (ref.provider === 'ec2' && (!ec2?.enabled || !account || account.enabled === false)) return [];
    return [{ ...ref, api: provider, candidates: provider.candidates(account ?? cfg, cpus), demoted: Boolean(account?.credit && !creditPreference(account)), creditPolicy: account?.credit && creditPreference(account) ? 'on' : 'off' }];
  });
  const groups = [];
  for (const market of ['spot', 'standard']) {
    const order = market === 'spot' ? [...eligible.filter((p) => !p.demoted), ...eligible.filter((p) => p.demoted)] : eligible;
    for (const entry of order) {
      const candidates = entry.candidates.filter((c) => c.provisioning === market);
      if (!candidates.length) continue;
      const previous = groups.at(-1);
      // One cloud alone retains its original walk. Returning after another cloud's group opens a new allocation.
      if (previous && providerKey(previous) === providerKey(entry)) previous.candidates.push(...candidates);
      else groups.push({ ...entry, candidates });
    }
  }
  const declared = cfg.repos.find((r) => r.repo.toLowerCase() === repo.toLowerCase())?.providers ?? listed;
  return { groups, unlisted: required !== 'any' && !declared.some((r) => r.provider === required) ? required : null };
}

// The map is keyed by allocation, not by source of evidence: a persisted row and the in-flight reservation
// for the same allocation are one debit. Cleanup updates rowOf, so a final write releases both budgets.
export function createAdmission(seen, cfg) {
  const held = new Map();
  const entries = () => {
    const all = new Map(held);
    for (const i of seen.instances) {
      if (i.status === 'TERMINATED') continue;
      if (!all.has(i.alloc)) all.set(i.alloc, { ...identity(i, cfg.project), repo: seen.rowOf.get(i.alloc)?.repo ?? seen.byLabel.get(i.repoLabel), reserved: i.vcpus });
    }
    for (const [alloc, row] of seen.rowOf) {
      if (!row) continue;
      if (row.state === 'final') all.delete(alloc);
      else all.set(alloc, { ...row, ...identity(row, cfg.project), reserved: row.reserved ?? all.get(alloc)?.reserved ?? row.cpus });
    }
    return [...all.values()];
  };
  return {
    acquire(alloc, repo, group) {
      const reserved = Math.max(...group.candidates.map((c) => c.vcpus));
      const current = entries();
      if (current.reduce((n, r) => n + r.reserved, 0) + reserved > cfg.max_vcpus) return null;
      const own = current.filter((r) => r.repo?.toLowerCase() === repo.toLowerCase() && providerKey(r) === providerKey(group));
      if (own.reduce((n, r) => n + r.reserved, 0) + reserved > (group.max_vcpus ?? Infinity)) return null;
      held.set(alloc, { provider: group.provider, account: group.account, repo, reserved });
      return reserved;
    },
    release: (alloc) => held.delete(alloc),
    total: () => entries().reduce((n, r) => n + r.reserved, 0),
  };
}

// Adapt the provider-neutral instance to the scheduler's existing lifecycle view. Keep the original contract
// fields for the provider's terminate call; cloud-specific machine parsing stays in the provider.
export function schedulingView(i, rows) {
  if (i.name) return i;
  const row = rows.find((r) => r.alloc === i.alloc);
  return { ...i, name: i.runner, cpus: i.size, account: i.candidate.account, region: i.candidate.region,
    zone: i.candidate.zone, machine: i.candidate.machine, vcpus: i.candidate.vcpus, provisioning: i.candidate.provisioning,
    diskType: i.candidate.disk.type, created: Date.parse(i.createdAt), running: i.state === 'running' ? Date.parse(i.createdAt) : null,
    status: ({ pending: 'PROVISIONING', running: 'RUNNING', stopping: 'STOPPING', stopped: 'TERMINATED', gone: 'TERMINATED' })[i.state],
    repoLabel: i.repoLabel ?? (row?.repo ?? i.repo)?.toLowerCase().replace('/', '--').replace(/[^a-z0-9_-]/g, '_'),
  };
}
