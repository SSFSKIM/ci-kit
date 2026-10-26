// A fake Compute Engine client (the interface of lib/gce.mjs) over recorded resource shapes. It
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
// or an operation wait that times out does; 'accepted-4xx' fails it after acceptance with a 4xx, as a refused wait
// call or a completed operation's httpErrorStatusCode does (lib/gce.mjs marks such errors `accepted`).
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
      if (imageInsert === 'accepted-4xx') throw new GceError(403, 'gce POST .../operations/op-9/wait: 403 Forbidden', ['forbidden'], { accepted: true });
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

// A fake GitHub client (the calls of lib/github.mjs the bake makes) for the real job in ci-kit-sandbox. The run the
// bake dispatches follows `run`: each getRun() takes the next state ({status, conclusion, took, ranOn}) and the last
// one sticks. `took` makes the check runner busy; a completed state with `ranOn` (true: the bake's runner; a string:
// that runner) is the job having run there, and a JIT runner leaves once its job is done. `busyDeletes` refusals
// (422) answer unregistering a busy runner before GitHub lets go of it. `jitLost`: GitHub registers the runner, but
// the response is lost and jitConfig throws. `runners` are registrations already there.
const httpError = (status, message) => Object.assign(new Error(message), { status });
export function fakeSandbox({ run = [{ status: 'queued' }], runners = [], isPrivate = true, runDetails = true, busyDeletes = 0, jitLost = false } = {}) {
  const state = { runners: runners.map((r) => ({ busy: false, ...r })), run: null, jobs: [] };
  const calls = [];
  let nextId = 900;
  let at = 0;
  let mine = null; // the check runner's name
  let refusals = busyDeletes;
  const advance = () => {
    if (!state.run || state.run.status === 'completed') return;
    const step = run[Math.min(at, run.length - 1)];
    at += 1;
    if (step.took) for (const r of state.runners) if (r.name === mine) r.busy = true;
    state.run = { ...state.run, status: step.status, conclusion: step.conclusion ?? null };
    if (step.status === 'completed' && step.ranOn) {
      const on = step.ranOn === true ? mine : step.ranOn;
      state.jobs = [{ id: nextId++, run_id: state.run.id, status: 'completed', conclusion: step.conclusion, runner_name: on, labels: [mine] }];
      state.runners = state.runners.filter((r) => r.name !== on);
    }
  };
  return {
    calls,
    state,
    getRepo: async () => ({ private: isPrivate }),
    runners: async () => state.runners.map((r) => ({ ...r })),
    jitConfig: async (repo, spec) => {
      calls.push(`jit ${repo} ${spec.name} [${spec.labels}] ${spec.work_folder}`);
      mine = spec.name;
      const r = { id: nextId++, name: spec.name, busy: false, labels: spec.labels.map((name) => ({ name })) };
      state.runners.push(r);
      if (jitLost) throw httpError(504, 'Gateway Timeout');
      return { runner: { id: r.id, name: r.name }, encoded_jit_config: `jit-for-${spec.name}` };
    },
    dispatchWorkflow: async (repo, file, { ref, inputs }) => {
      calls.push(`dispatch ${repo} ${file}@${ref} ${JSON.stringify(inputs)}`);
      state.run = { id: 4242, status: 'queued', conclusion: null };
      return runDetails ? { workflow_run_id: 4242, run_url: `https://api.github.com/repos/${repo}/actions/runs/4242`, html_url: `https://github.com/${repo}/actions/runs/4242` } : null;
    },
    getRun: async () => {
      advance();
      return { ...state.run };
    },
    listJobs: async () => state.jobs.map((j) => ({ ...j })),
    cancelRun: async (repo, id) => {
      calls.push(`cancel ${id}`);
      state.run = { ...state.run, status: 'completed', conclusion: 'cancelled' };
    },
    deleteRunner: async (repo, id) => {
      const r = state.runners.find((x) => x.id === id);
      calls.push(`unregister ${r?.name ?? id}`);
      if (!r) throw httpError(404, 'Not Found');
      if (r.busy && refusals > 0) {
        refusals -= 1;
        throw httpError(422, 'Bad request - Runner is still running a job');
      }
      state.runners = state.runners.filter((x) => x !== r);
    },
  };
}
