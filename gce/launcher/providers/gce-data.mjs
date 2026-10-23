// Pure GCE data adaptation. No API calls: providers/gce.mjs supplies the cloud effects.
import { machineCpus } from '../../bake/plan.mjs';
import { providerRunnerLabels } from './contracts.mjs';

// gcloud compute machine-types describe: C4D highcpu memory is not a fixed ratio.
export const MEMORY_GIB = { e2: { 2: 2, 4: 4, 8: 8, 16: 16 }, c3d: { 4: 8, 8: 16, 16: 32 }, c4d: { 2: 3, 4: 7, 8: 15, 16: 30 } };
// Source dates of ledger.mjs's existing catalog rates, not a new quote or a pricing-policy input.
const gcePrice = (family, region) => ({ source: 'gce-catalog',
  at: region === 'us-central1' && ['e2', 'c3d'].includes(family) ? '2026-10-16T00:00:00Z' : '2026-10-21T00:00:00Z' });
const last = (path) => path?.split('/').pop();

/** @returns {import('./contracts.mjs').Candidate} */
export function gceCandidate({ account, size, machine, zone, region, provisioning, subnet, disk }) {
  const vcpus = machineCpus(machine);
  const family = machine.split('-')[0];
  return {
    provider: 'gce', account, region, zone, size, labels: providerRunnerLabels('gce', size),
    machine, family, vcpus, memoryGiB: MEMORY_GIB[family]?.[vcpus] ?? null, arch: 'x86_64',
    provisioning, subnet, disk, price: gcePrice(family, region),
  };
}

/** @returns {import('./contracts.mjs').Instance} */
export function gceInstance(resource, view) {
  const account = /\/projects\/([^/]+)\//.exec(resource.selfLink ?? resource.zone ?? '')?.[1] ?? null;
  const disk = resource.disks?.find((d) => d.boot);
  const candidate = gceCandidate({
    account, size: view.cpus, machine: view.machine, zone: view.zone, region: view.zone.replace(/-[a-z]$/, ''),
    provisioning: view.provisioning, subnet: last(resource.networkInterfaces?.[0]?.subnetwork) ?? null,
    disk: { type: view.diskType ?? 'pd-balanced', sizeGB: Number(disk?.diskSizeGb ?? disk?.initializeParams?.diskSizeGb) || null },
  });
  return {
    provider: 'gce', id: resource.id == null ? null : String(resource.id), alloc: view.alloc, runner: view.name,
    size: view.cpus, labels: view.cpus == null ? [] : candidate.labels,
    state: { PROVISIONING: 'pending', STAGING: 'pending', RUNNING: 'running', STOPPING: 'stopping', TERMINATED: 'stopped' }[view.status] ?? 'pending',
    candidate, createdAt: resource.creationTimestamp,
  };
}
