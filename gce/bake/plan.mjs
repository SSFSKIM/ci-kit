// The GCE bake's pure parts (spec §3a Image, I12): when a builder or smoke VM is done, what the bake owns, what
// retention removes, the order of placements, and the request bodies. Only resources carrying the kit's labels are
// ever selected.
import { randomBytes } from 'node:crypto';

export const BAKE_TIMEOUT_MS = 30 * 60_000;
export const SMOKE_TIMEOUT_MS = 15 * 60_000;
export const STALE_MS = 2 * 3600_000;
export const KEEP_READY = 2;
// The builder needs memory for the image build and pnpm's fetch; it is on demand, since a preempted bake is a lost
// week. N2D stands in when E2 is refused (spec M10: quota requests were reconciling).
export const BUILDER_MACHINES = ['e2-standard-4', 'n2d-standard-4'];
export const BUILDER_DISK_GB = 30;
const UBUNTU = 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64';

// A builder (attribute ci-kit/bake) or smoke VM (ci-kit/smoke) is done once it reported and powered off. `report` is
// the last value seen: the attribute may be gone once the guest is off, so the caller remembers it across polls.
export function reportOutcome({ instance, report, elapsedMs, timeoutMs }) {
  if (report?.startsWith('failed:')) return { done: true, ok: false, reason: report };
  if (!instance) return { done: true, ok: false, reason: 'failed:vanished' };
  if (instance.status === 'TERMINATED') {
    return report === 'ok' ? { done: true, ok: true } : { done: true, ok: false, reason: 'failed:no-report' };
  }
  if (elapsedMs > timeoutMs) return { done: true, ok: false, reason: 'timeout' };
  return { done: false };
}

const labelled = (r, value) => r?.labels?.['ci-kit'] === value;
const created = (r) => Date.parse(r.creationTimestamp);

// An instance is this bake's while it carries the builder label and this run's id. One relabelled to keep it for
// debugging is no longer the bake's, and the bake neither images nor deletes it.
export const ownsBakeInstance = (instance, runId) => labelled(instance, 'gce-builder') && instance.labels['ci-kit-run'] === String(runId);

// An image is this bake's while it carries the image label and this run's id: an image that merely has the name the
// bake chose (a collision, or one an operator relabelled) is not.
export const ownsBakeImage = (image, runId) => labelled(image, 'gce-image') && image.labels['ci-kit-run'] === String(runId);

// An insert whose request the API refused outright (4xx before acceptance: alreadyExists, invalid, quota) created
// nothing of the caller's. Anything else (a timeout, a lost response, any failure once the insert was accepted, 4xx
// included) may have, and is checked by label.
export const refusedOutright = (err) => err?.status >= 400 && err.status < 500 && !err.accepted;

// Builders and smoke VMs of any bake older than 2 h: a bake killed mid-run (its job's timeout) cannot clean up.
export const staleBakeInstances = (instances, now) => instances.filter((i) => labelled(i, 'gce-builder') && now - created(i) > STALE_MS);

// Images of the family beyond the two newest ready ones, and unready ones older than 2 h (a bake that died before it
// could delete its own). A younger unready image may be a bake in flight, and is left to it.
export function imagesToPrune(images, { family, now, keep = KEEP_READY }) {
  const ours = images.filter((i) => labelled(i, 'gce-image') && i.family === family);
  const ready = ours.filter((i) => i.labels['ci-kit-ready'] === 'true').sort((a, b) => created(b) - created(a));
  const unready = ours.filter((i) => i.labels['ci-kit-ready'] !== 'true' && now - created(i) > STALE_MS);
  return [...ready.slice(keep), ...unready];
}

export const placements = (machines, zones) => machines.flatMap((machine) => zones.map((zone) => ({ machine, zone })));

// Why an insert was refused, when that refusal is definite: capacity is per zone, quota per region and family.
export function refusal(err) {
  const codes = err?.codes ?? [];
  if (codes.some((c) => /^ZONE_RESOURCE_POOL_EXHAUSTED/.test(c))) return 'capacity';
  if (codes.some((c) => /^(QUOTA_EXCEEDED|quotaExceeded)$/.test(c))) return 'quota';
  return null;
}

// UTC seconds and four random base36 characters: names and the ci-kit-run label are what a bake owns, so two bakes
// started in the same second must not share them.
export const bakeRunId = (date, suffix = () => randomBytes(4).readUInt32BE(0).toString(36).padStart(4, '0').slice(-4)) =>
  `${date.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${suffix()}`;

export const bakeNames = (runId, sha) => ({
  builder: `ci-kit-gce-builder-${runId}`,
  smoke: `ci-kit-gce-builder-${runId}-smoke`,
  image: `ci-kit-runner-${runId}-${sha.slice(0, 8)}`,
});

export function machineCpus(machine) {
  const n = Number(machine.split('-').pop());
  if (!Number.isInteger(n) || n < 1) throw new Error(`ci-kit: cannot read the vCPUs of machine ${machine}`);
  return n;
}

// What the builder and smoke VMs share with a job VM: no service account (the metadata server hands job code no
// credential), the kit's subnetwork (its network has no ingress rule; gce/deploy.sh network) with an ephemeral
// external address for outbound traffic, guest attributes for reporting, and a run limit after which Compute Engine
// deletes the VM whatever the bake is doing.
function vm({ name, zone, machine, labels, sourceImage, diskGb, metadata, maxRunSeconds, subnetwork }) {
  return {
    name,
    machineType: `zones/${zone}/machineTypes/${machine}`,
    labels,
    disks: [{
      boot: true,
      autoDelete: true,
      initializeParams: { diskName: name, sourceImage, diskSizeGb: String(diskGb), diskType: `zones/${zone}/diskTypes/pd-balanced`, labels },
    }],
    networkInterfaces: [{ subnetwork, accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }] }],
    serviceAccounts: [],
    metadata: { items: [{ key: 'enable-guest-attributes', value: 'TRUE' }, ...Object.entries(metadata).map(([key, value]) => ({ key, value }))] },
    scheduling: { provisioningModel: 'STANDARD', instanceTerminationAction: 'DELETE', maxRunDuration: { seconds: String(maxRunSeconds) }, automaticRestart: false },
  };
}

const bakeLabels = (runId, role) => ({ 'ci-kit': 'gce-builder', 'ci-kit-run': String(runId), 'ci-kit-role': role });

// The builder: stock Ubuntu running the builder script once, with a one-hour installation token, scoped to reading
// MAWS's contents, in its metadata. The App key never reaches a VM.
export const builderInstance = ({ name, zone, machine, runId, script, token, subnetwork, diskGb = BUILDER_DISK_GB }) =>
  vm({
    name, zone, machine, diskGb, subnetwork, sourceImage: UBUNTU, labels: bakeLabels(runId, 'builder'),
    metadata: { 'startup-script': script, 'ci-kit-gh-token': token },
    maxRunSeconds: BAKE_TIMEOUT_MS / 1000 + 15 * 60,
  });

// The smoke VM boots the new image as a job VM would, with `ci-kit-smoke` (the vCPUs it must see) in place of a JIT
// config: the image's unit runs its checks in a job container and reports them.
export const smokeInstance = ({ name, zone, machine, runId, image, diskGb, subnetwork }) =>
  vm({
    name, zone, machine, diskGb, subnetwork, sourceImage: image, labels: bakeLabels(runId, 'smoke'),
    metadata: { 'ci-kit-smoke': String(machineCpus(machine)) },
    maxRunSeconds: SMOKE_TIMEOUT_MS / 1000 + 5 * 60,
  });

// The image enters the family unready; the launcher uses only images labelled ci-kit-ready=true.
export const imageBody = ({ name, family, zone, disk, sha, runId }) => ({
  name,
  family,
  sourceDisk: `zones/${zone}/disks/${disk}`,
  description: `ci-kit pool runner image, kit ${sha.slice(0, 8)}`,
  labels: { 'ci-kit': 'gce-image', 'ci-kit-commit': sha, 'ci-kit-ready': 'false', 'ci-kit-run': String(runId) },
});

// Fills the builder script's one placeholder. The commit must be a full SHA: the builder checks it out, and a branch
// name would bake whatever the branch holds by then.
export function fillBuilderScript(template, { sha }) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`ci-kit: the bake needs a full kit commit, not "${sha}"`);
  return template.replace(/__[A-Z_]+__/g, (name) => {
    if (name !== '__KIT_SHA__') throw new Error(`ci-kit: builder script has an unknown placeholder ${name}`);
    return sha;
  });
}
