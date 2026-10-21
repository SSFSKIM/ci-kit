// The pool configs the GCE tests run against, fixed here so a reorder or edit of pool/config/gce.json (a commit on
// main, read by the next tick) never changes what a test means. config.test.mjs holds the shipped file to the shape the
// spec gives it.
import { parseGceConfig } from '../../gce/launcher/config.mjs';

// The shipped file's keys other than its placements.
export const COMMON = {
  repos: [{ repo: 'SSFSKIM/ci-kit-sandbox' }, { repo: 'SSFSKIM/MAWS' }, { repo: 'SSFSKIM/manim-master' }],
  project: 'ssfskim-ci-kit', network: 'ci-kit', disk_gb: 50, max_run_minutes: 120, max_vcpus: 192,
  image_family: 'ci-kit-runner', idle_runner_minutes: 10, egress: 'external', ledger: { repo: 'SSFSKIM/ci-kit-sandbox', issue_title: 'pool ledger' },
};
export const WEST = {
  region: 'us-west4', subnetwork: 'ci-kit-us-west4', zones: ['us-west4-a', 'us-west4-b', 'us-west4-c'],
  machines: { 2: 'c4d-highcpu-2', 4: 'c4d-highcpu-4', 8: 'c4d-highcpu-8', 16: 'c4d-highcpu-16' }, disk_type: 'hyperdisk-balanced',
};
export const CENTRAL = {
  region: 'us-central1', subnetwork: 'ci-kit-us-central1', zones: ['us-central1-a', 'us-central1-b', 'us-central1-c', 'us-central1-f'],
  machines: { 2: 'c3d-highcpu-4', 4: 'c3d-highcpu-4', 8: 'c3d-highcpu-8', 16: 'c3d-highcpu-16' }, disk_type: 'pd-balanced',
};
// M6's placements (spec 2026-10-21, Stock-out and quota resilience, item 2): C4D in every region it is offered and
// granted, then C3D. Two placements in one region share its subnetwork.
const C4D_MACHINES = WEST.machines;
const C3D_MACHINES = CENTRAL.machines;
const zones = (region, letters) => letters.map((l) => `${region}-${l}`);
export const C4D_CENTRAL = { ...CENTRAL, machines: C4D_MACHINES, disk_type: 'hyperdisk-balanced' };
export const C4D_EAST1 = { region: 'us-east1', subnetwork: 'ci-kit-us-east1', zones: zones('us-east1', ['b', 'c', 'd']), machines: C4D_MACHINES, disk_type: 'hyperdisk-balanced' };
export const C4D_EAST4 = { region: 'us-east4', subnetwork: 'ci-kit-us-east4', zones: zones('us-east4', ['a', 'b', 'c']), machines: C4D_MACHINES, disk_type: 'hyperdisk-balanced' };
export const C4D_EAST5 = { region: 'us-east5', subnetwork: 'ci-kit-us-east5', zones: zones('us-east5', ['a', 'b', 'c']), machines: C4D_MACHINES, disk_type: 'hyperdisk-balanced' };
export const C3D_EAST1 = { ...C4D_EAST1, machines: C3D_MACHINES, disk_type: 'pd-balanced' };
export const C3D_EAST4 = { ...C4D_EAST4, machines: C3D_MACHINES, disk_type: 'pd-balanced' };
export const M6_PLACEMENTS = [WEST, C4D_CENTRAL, C4D_EAST1, C4D_EAST4, C4D_EAST5, CENTRAL, C3D_EAST1, C3D_EAST4];

// A placement whose size 2 is E2, which tests use for a machine family that can refuse for quota beside the C3D one in
// the same region (E2 itself left the shipped pool).
export const E2_CENTRAL = { ...CENTRAL, machines: { ...CENTRAL.machines, 2: 'e2-highcpu-2' } };

const parse = (placements) => parseGceConfig(JSON.stringify({ ...COMMON, placements }));
// C4D us-west4 first, C3D us-central1 second: the pool as the spec has it.
export const NEW_CFG = parse([WEST, CENTRAL]);
// The eight placements of M6, in its order.
export const M6_CFG = parse(M6_PLACEMENTS);
// One region, two machine families: size 2 on E2 with C3D as its next placement, as the pool ran before placements.
export const ONE_REGION_CFG = parse([E2_CENTRAL, CENTRAL]);
