// The GCE bake's pure parts (spec §3a Image, I12): when a builder, smoke or check VM is done, when the real job has
// passed, what the bake owns, what retention removes, the order of placements, and the request bodies. Only resources
// carrying the kit's labels are ever selected.
import { randomBytes } from 'node:crypto';
import { workDir } from '../../pool/agent/docker.mjs';

export const BAKE_TIMEOUT_MS = 30 * 60_000;
export const SMOKE_TIMEOUT_MS = 15 * 60_000;
// From the dispatch to the check VM's power-off: a boot of about a minute and a job of about one.
export const CHECK_TIMEOUT_MS = 10 * 60_000;
// A GCE stage's builder, check runner or unready image younger than this may still be in use. GCE cleanup
// precedes the EC2 account stages, so this bounds GCE's stage rather than the multi-account job timeout.
export const STALE_MS = 4 * 3600_000;
export const KEEP_READY = 2;
// The builder needs memory for the image build and pnpm's fetch; it is on demand, since a preempted bake is a lost
// week. N2D stands in when E2 is refused (spec M10: quota requests were reconciling).
export const BUILDER_MACHINES = ['e2-standard-4', 'n2d-standard-4'];
export const BUILDER_DISK_GB = 30;
const BUILDER_DISK_TYPE = 'pd-balanced'; // E2 and N2D boot from Persistent Disk, not Hyperdisk
const UBUNTU = 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64';

// The real job (bake step 5) runs in ci-kit-sandbox, the launcher's round-trip repo, through its dispatch-only
// workflow bake-check.yml. The bake's token for it is scoped to that repo: a JIT runner (administration), and the
// workflow's dispatch, run and cancel (actions).
export const CHECK = { repo: 'SSFSKIM/ci-kit-sandbox', workflow: 'bake-check.yml', ref: 'main' };
export const CHECK_SCOPE = { repositories: ['ci-kit-sandbox'], permissions: { administration: 'write', actions: 'write' } };

// A builder (attribute ci-kit/bake), smoke VM (ci-kit/smoke) or check VM (ci-kit/job) is done once it reported and
// powered off; it passed only if its report is `ok` (`exit:0` for a check VM). Any other report fails it at once.
// `report` is the last value seen: the attribute may be gone once the guest is off, so the caller remembers it across
// polls.
export function reportOutcome({ instance, report, elapsedMs, timeoutMs, ok = 'ok' }) {
  if (report && report !== ok) return { done: true, ok: false, reason: report };
  if (!instance) return { done: true, ok: false, reason: 'failed:vanished' };
  if (instance.status === 'TERMINATED') {
    return report === ok ? { done: true, ok: true } : { done: true, ok: false, reason: 'failed:no-report' };
  }
  if (elapsedMs > timeoutMs) return { done: true, ok: false, reason: 'timeout' };
  return { done: false };
}

// The real job's verdict (bake step 5), from the check VM's outcome (reportOutcome over ci-kit/job), the dispatched
// run and, once it completed, its jobs. It passes only once the run concluded success with every job on the bake's
// own runner, and the VM reported its runner's exit 0 and powered off. A run still going when the VM is done waits,
// within the same bound: GitHub may not have recorded the end yet.
export function checkOutcome({ vm, run, jobs = [], runner, elapsedMs, timeoutMs }) {
  if (vm.done && !vm.ok) return vm;
  if (run?.status === 'completed') {
    if (run.conclusion !== 'success') return { done: true, ok: false, reason: `run ${run.conclusion}` };
    const elsewhere = jobs.filter((j) => j.runner_name !== runner).map((j) => j.runner_name ?? 'no runner');
    if (jobs.length === 0 || elsewhere.length) return { done: true, ok: false, reason: `ran on ${elsewhere.join(', ') || 'no job'}` };
    if (vm.ok) return { done: true, ok: true };
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

// Builders, smoke and check VMs of any bake older than STALE_MS (4 h): a bake killed mid-run (its job's timeout) cannot clean up.
export const staleBakeInstances = (instances, now) => instances.filter((i) => labelled(i, 'gce-builder') && now - created(i) > STALE_MS);

// The check runners of earlier bakes (ci-kit-bake-<run id>) that are older than STALE_MS, by the time in their run id, and
// not busy: a bake killed mid-check leaves its registration behind. A younger one may be a bake in flight.
export function staleBakeRunners(runners, now) {
  return runners.filter((r) => {
    const m = /^ci-kit-bake-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[a-z0-9]{4}$/.exec(r.name);
    return m && !r.busy && now - Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]) > STALE_MS;
  });
}

// Images of the family beyond the two newest ready ones, and unready ones older than STALE_MS (a bake that died before it
// could delete its own). A younger unready image may be a bake in flight, and is left to it.
export function imagesToPrune(images, { family, now, keep = KEEP_READY }) {
  const ours = images.filter((i) => labelled(i, 'gce-image') && i.family === family);
  const ready = ours.filter((i) => i.labels['ci-kit-ready'] === 'true').sort((a, b) => created(b) - created(a));
  const unready = ours.filter((i) => i.labels['ci-kit-ready'] !== 'true' && now - created(i) > STALE_MS);
  return [...ready.slice(keep), ...unready];
}

// The attempts for one bake VM: each placement in order, and in it each of its machines (machinesOf(placement),
// repeats dropped) across its zones before the next machine.
export const placements = (list, machinesOf) =>
  list.flatMap((placement) => [...new Set(machinesOf(placement))].flatMap((machine) => placement.zones.map((zone) => ({ machine, zone, placement }))));

// A placement's machines, smallest size first: a smoke or check VM uses the smallest the placement takes, as a cpus-2
// job does, and the next size's when that one is refused, so a placement's family is still the one booted.
export const smokeMachines = (placement) => ['2', '4', '8', '16'].map((size) => placement.machines[size]);

export const subnetworkOf = (placement) => `regions/${placement.region}/subnetworks/${placement.subnetwork}`;

// A VM's one network interface: its placement's subnetwork and, under gce.json's egress `external` (the default), an
// ephemeral external address it reaches GitHub, apt and npm through; under `nat` none, its region's Cloud NAT carrying
// that traffic (spec 2026-10-21 M6; gce/deploy.sh network).
export const networkInterface = (placement, egress) => ({
  subnetwork: subnetworkOf(placement),
  ...(egress === 'nat' ? {} : { accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }] }),
});

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

// The check VM is named and labelled as the bake's (ci-kit-gce-builder-*, ci-kit=gce-builder), never as a pool VM.
// Its runner, ci-kit-bake-<run id>, carries that name as its only label, and is outside the launcher's ci-kit-gce-*.
export const bakeNames = (runId, sha) => ({
  builder: `ci-kit-gce-builder-${runId}`,
  smoke: `ci-kit-gce-builder-${runId}-smoke`, // each placement's smoke VM adds its number: -smoke-1, -smoke-2, …
  check: `ci-kit-gce-builder-${runId}-check`,
  runner: `ci-kit-bake-${runId}`,
  image: `ci-kit-runner-${runId}-${sha.slice(0, 8)}`,
});

export function machineCpus(machine) {
  const n = Number(machine.split('-').pop());
  if (!Number.isInteger(n) || n < 1) throw new Error(`ci-kit: cannot read the vCPUs of machine ${machine}`);
  return n;
}

// What the builder and smoke VMs share with a job VM: no service account (the metadata server hands job code no
// credential), the placement's subnetwork of the kit's network (it has no ingress rule; gce/deploy.sh network) with the
// egress gce.json names (networkInterface), guest attributes for reporting, and a run limit after which Compute Engine
// deletes the VM whatever the bake is doing.
function vm({ name, zone, machine, labels, sourceImage, diskGb, diskType, metadata, maxRunSeconds, placement, egress }) {
  return {
    name,
    machineType: `zones/${zone}/machineTypes/${machine}`,
    labels,
    disks: [{
      boot: true,
      autoDelete: true,
      initializeParams: { diskName: name, sourceImage, diskSizeGb: String(diskGb), diskType: `zones/${zone}/diskTypes/${diskType}`, labels },
    }],
    networkInterfaces: [networkInterface(placement, egress)],
    serviceAccounts: [],
    metadata: { items: [{ key: 'enable-guest-attributes', value: 'TRUE' }, ...Object.entries(metadata).map(([key, value]) => ({ key, value }))] },
    scheduling: { provisioningModel: 'STANDARD', instanceTerminationAction: 'DELETE', maxRunDuration: { seconds: String(maxRunSeconds) }, automaticRestart: false },
  };
}

const bakeLabels = (runId, role) => ({ 'ci-kit': 'gce-builder', 'ci-kit-run': String(runId), 'ci-kit-role': role });

// The builder: stock Ubuntu running the builder script once, with a one-hour installation token, scoped to reading
// MAWS's contents, in its metadata. The App key never reaches a VM.
export const builderInstance = ({ name, zone, machine, runId, script, token, manifest, placement, egress, diskGb = BUILDER_DISK_GB }) =>
  vm({
    name, zone, machine, diskGb, diskType: BUILDER_DISK_TYPE, placement, egress, sourceImage: UBUNTU, labels: bakeLabels(runId, 'builder'),
    metadata: { 'startup-script': script, 'ci-kit-gh-token': token, ...(manifest ? { 'ci-kit-bake-manifest': JSON.stringify(manifest) } : {}) },
    maxRunSeconds: BAKE_TIMEOUT_MS / 1000 + 15 * 60,
  });

// The smoke VM boots the new image as a job VM would, on its placement's boot disk type, with `ci-kit-smoke` (the
// vCPUs it must see) in place of a JIT config: the image's unit runs its checks in a job container and reports them.
export const smokeInstance = ({ name, zone, machine, runId, image, diskGb, placement, egress }) =>
  vm({
    name, zone, machine, diskGb, diskType: placement.disk_type, placement, egress, sourceImage: image, labels: bakeLabels(runId, 'smoke'),
    metadata: { 'ci-kit-smoke': String(machineCpus(machine)) },
    maxRunSeconds: SMOKE_TIMEOUT_MS / 1000 + 5 * 60,
  });

// The check VM boots the new image as a job VM does, with a JIT config in ci-kit-jit: the image's unit runs the
// runner in a job container, and the real job dispatched to that runner's label runs on it.
export const checkInstance = ({ name, zone, machine, runId, image, diskGb, placement, egress, jit }) =>
  vm({
    name, zone, machine, diskGb, diskType: placement.disk_type, placement, egress, sourceImage: image, labels: bakeLabels(runId, 'check'),
    metadata: { 'ci-kit-jit': jit },
    maxRunSeconds: CHECK_TIMEOUT_MS / 1000 + 5 * 60,
  });

// The check runner: its one label is its name, which only the dispatched job asks for. Its work folder is the one the
// VM's unit makes for the instance (gce/vm/job.mjs).
export const checkJitRequest = (names) => ({ name: names.runner, labels: [names.runner], work_folder: workDir(names.check) });

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
