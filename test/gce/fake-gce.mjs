// A fake Compute Engine client (the interface of lib/gce.mjs) over recorded resource shapes. Like the Hetzner fake, it
// ignores filters and returns every resource in the project, so the code under test must check labels itself.
// Instances it creates follow a script: each instance() read takes the next state ({status, attrs}) and the last one
// sticks. FOREIGN holds resources the kit must never delete or label, some carrying the kit's names.
import { GceError } from '../../lib/gce.mjs';

const ZONE_URL = (zone) => `https://www.googleapis.com/compute/v1/projects/ssfskim-ci-kit/zones/${zone}`;

// As GET instances/{name} returns it (recorded 2026-10-16, fields the kit reads).
export const instanceShape = ({ name, zone = 'us-central1-a', status = 'RUNNING', labels = {}, created = '2026-10-16T02:50:00.000-07:00' }) => ({
  kind: 'compute#instance',
  id: String(1000 + name.length),
  creationTimestamp: created,
  name,
  status,
  zone: ZONE_URL(zone),
  labels,
  labelFingerprint: 'abc=',
  disks: [{ boot: true, autoDelete: true, source: `${ZONE_URL(zone)}/disks/${name}` }],
});

// As GET images/{name} returns it.
export const imageShape = ({ name, family = 'ci-kit-runner', labels, created, status = 'READY' }) => ({
  kind: 'compute#image',
  id: String(2000 + name.length),
  creationTimestamp: created,
  name,
  status,
  family,
  labels,
  labelFingerprint: 'fp=',
  diskSizeGb: '30',
  selfLink: `https://www.googleapis.com/compute/v1/projects/ssfskim-ci-kit/global/images/${name}`,
});

export const FOREIGN = {
  instances: [
    instanceShape({ name: 'devbox', labels: {}, status: 'RUNNING', created: '2026-09-01T00:00:00.000-07:00' }),
    instanceShape({ name: 'ci-kit-gce-builder-20260901-000000', labels: { owner: 'someone' }, status: 'TERMINATED', created: '2026-09-01T00:00:00.000-07:00' }),
  ],
  images: [
    imageShape({ name: 'someone-elses', family: 'ci-kit-runner', labels: {}, created: '2026-09-01T00:00:00.000-07:00' }),
    imageShape({ name: 'other-family', family: 'other', labels: { 'ci-kit': 'gce-image', 'ci-kit-ready': 'true' }, created: '2026-09-01T00:00:00.000-07:00' }),
  ],
};

// insertErrors: codes the next inserts fail with, in order ('' for success). scripts: per role ('builder', 'smoke'),
// the states an instance created for that role goes through.
// imageInsert: 'accepted-timeout' makes the image insert succeed on the server but fail the call, as a lost response
// or an operation wait that times out does.
export function fakeGce({ instances = [], images = [], insertErrors = [], scripts = {}, imageInsert } = {}) {
  const state = { instances: [...FOREIGN.instances, ...instances], images: [...FOREIGN.images, ...images] };
  const progress = new Map(); // name → { steps, at }
  const calls = [];
  const inserted = []; // successful insert bodies, in order
  const foreignTouched = [];
  const isForeign = (kind, name) => FOREIGN[kind].some((r) => r.name === name);

  const read = (name) => {
    const inst = state.instances.find((i) => i.name === name);
    if (!inst) return null;
    const p = progress.get(name);
    if (p) {
      const step = p.steps[Math.min(p.at, p.steps.length - 1)];
      p.at += 1;
      inst.status = step.status;
      inst.attrs = step.attrs ?? {};
    }
    return inst;
  };

  return {
    calls,
    inserted,
    foreignTouched,
    state,
    instances: async () => state.instances.map((i) => ({ ...i })),
    instance: async (zone, name) => {
      const i = read(name);
      return i && { ...i };
    },
    insertInstance: async (zone, body) => {
      const machine = body.machineType.split('/').pop();
      calls.push(`insert ${body.name} ${machine}@${zone}`);
      const code = insertErrors.shift();
      if (code) throw new GceError(200, `operation failed: ${code}`, [code]);
      if (state.instances.some((i) => i.name === body.name)) throw new GceError(409, 'alreadyExists', ['alreadyExists']);
      const inst = instanceShape({ name: body.name, zone, labels: body.labels, created: '2026-10-16T09:45:00.000Z' });
      inserted.push(body);
      state.instances.push(inst);
      progress.set(body.name, { steps: scripts[body.labels['ci-kit-role']] ?? [{ status: 'RUNNING' }], at: 0 });
      return inst;
    },
    deleteInstance: async (zone, name) => {
      calls.push(`delete instance ${name}`);
      if (isForeign('instances', name)) foreignTouched.push(`delete instance ${name}`);
      state.instances = state.instances.filter((i) => i.name !== name);
    },
    guestAttribute: async (zone, name, path) => {
      const inst = state.instances.find((i) => i.name === name);
      if (!inst) throw new GceError(404, 'notFound', ['notFound']);
      return inst.attrs?.[path] ?? null;
    },
    images: async () => state.images.map((i) => ({ ...i, labels: { ...i.labels } })),
    image: async (name) => {
      const i = state.images.find((x) => x.name === name);
      return i ? { ...i, labels: { ...i.labels } } : null;
    },
    insertImage: async (body) => {
      calls.push(`insert image ${body.name} from ${body.sourceDisk.split('/').pop()}`);
      if (state.images.some((i) => i.name === body.name)) throw new GceError(409, `The resource '${body.name}' already exists`, ['alreadyExists']);
      state.images.push(imageShape({ name: body.name, family: body.family, labels: { ...body.labels }, created: '2026-10-16T10:00:00.000Z' }));
      if (imageInsert === 'accepted-timeout') throw new Error('The operation was aborted due to timeout');
    },
    setImageLabels: async (name, labels) => {
      calls.push(`label image ${name} ${JSON.stringify(labels)}`);
      if (isForeign('images', name)) foreignTouched.push(`label image ${name}`);
      state.images.find((i) => i.name === name).labels = { ...labels };
    },
    deleteImage: async (name) => {
      calls.push(`delete image ${name}`);
      if (isForeign('images', name)) foreignTouched.push(`delete image ${name}`);
      state.images = state.images.filter((i) => i.name !== name);
    },
  };
}
