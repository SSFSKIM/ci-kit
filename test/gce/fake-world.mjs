// One shared fake of Compute Engine and GitHub (the interfaces of lib/gce.mjs and lib/github.mjs) for the GCE
// launcher's tests, over recorded shapes. Several launchers can run against one world, as overlapping Cloud Run
// requests do. Like the other fakes it ignores filters, so the code under test must check labels itself.
// The world also plays the VM and GitHub's side: boot() brings a runner online, take() gives it a job, finish() ends
// the job (the JIT runner unregisters, the guest powers off), preempt() is GCE deleting a spot VM.
// Time is the world's clock: after(ms) is a timer on it (the launcher's `after`), fired by advance(). An insert can be
// held (hooks.holdInsert returns a promise it waits on), and an insert error with `running: true` leaves its operation
// running, as a wait that outlived its deadline does; sim.completeInsert() finishes it later.
import { GceError } from '../../lib/gce.mjs';

const ZONE_URL = (zone) => `https://www.googleapis.com/compute/v1/projects/ssfskim-ci-kit/zones/${zone}`;
const httpError = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });

// zones: the zones an aggregated listing returns a scope for (every zone of the project, as the real one does).
const ZONES = ['us-central1-a', 'us-central1-b', 'us-central1-c', 'us-central1-f', 'us-west4-a', 'us-west4-b', 'us-west4-c', 'europe-west4-a'];

export function world({ start, repos = { 'SSFSKIM/ci-kit-sandbox': { private: true } }, images, zones = ZONES } = {}) {
  let clock = start;
  let nextId = 1;
  const g = {
    instances: [], disks: [], ops: [], preempted: [],
    images: images ?? [{
      name: 'ci-kit-runner-ready', family: 'ci-kit-runner', status: 'READY', creationTimestamp: '2026-10-16T11:18:31Z',
      labels: { 'ci-kit': 'gce-image', 'ci-kit-ready': 'true' }, selfLink: 'https://www.googleapis.com/compute/v1/projects/ssfskim-ci-kit/global/images/ci-kit-runner-ready',
    }],
    foreign: [{ name: 'devbox', status: 'RUNNING', zone: ZONE_URL('us-central1-a'), labels: {}, creationTimestamp: '2026-09-01T00:00:00Z', machineType: 'x/e2-small' }],
    insertErrors: [], // [{match: (zone, body) => bool, error: () => Error, accepted?: true}] consumed in order
  };
  const gh = {
    runners: new Map(), runs: [], jobs: [], comments: [], repos,
    issues: [{ number: 1, title: 'pool ledger', state: 'open', created_at: '2026-10-15T23:18:00Z', older: 0 }],
  };
  let nextIssue = 100;
  const commentCount = (n) => (gh.issues.find((i) => i.number === n)?.older ?? 0) + gh.comments.filter((c) => (c.issue ?? 1) === n).length;
  const log = []; // every mutation, in order
  const counts = new Map(); // successful (non-404) deletes and unregisters per resource
  const count = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);
  const hooks = {};
  let timers = []; // {due, fire}

  const runnersOf = (repo) => {
    if (!gh.runners.has(repo)) gh.runners.set(repo, []);
    return gh.runners.get(repo);
  };

  const gce = {
    instances: async () => [...g.instances, ...g.foreign].map((i) => structuredClone(i)),
    disks: async () => g.disks.map((d) => structuredClone(d)),
    // hooks.unreachable: a zone the aggregated listings cannot reach this time (its resources are missing, and it is not
    // among the zones read whole).
    listInstances: async () => {
      const hidden = hooks.unreachable;
      return {
        items: [...g.instances, ...g.foreign].filter((i) => !hidden || !i.zone.endsWith(hidden)).map((i) => structuredClone(i)),
        complete: !hidden, zones: new Set(zones.filter((z) => z !== hidden)),
      };
    },
    listDisks: async () => ({ items: g.disks.filter((d) => !hooks.unreachable || !d.zone.endsWith(hooks.unreachable)).map((d) => structuredClone(d)), complete: !hooks.unreachable }),
    images: async () => g.images.map((i) => structuredClone(i)),
    instance: async (zone, name) => structuredClone(g.instances.find((i) => i.name === name && i.zone.endsWith(zone)) ?? null),
    insertInstance: async (zone, body, opts = {}) => {
      log.push(`insert-wait ${body.name} ${opts.deadlineMs}`);
      hooks.beforeInsert?.(zone, body);
      const held = hooks.holdInsert?.(zone, body);
      if (held) await held;
      const i = g.insertErrors.findIndex((e) => e.match(zone, body));
      if (i >= 0) {
        const [e] = g.insertErrors.splice(i, 1);
        if (e.running) {
          log.push(`insert ${body.name} ${zone} unsettled`);
          throw e.error(operation(zone, body, 'RUNNING'));
        }
        if (e.accepted) create(zone, body);
        log.push(`insert ${body.name} ${zone} refused`);
        throw e.error();
      }
      create(zone, body);
      log.push(`insert ${body.name} ${zone}`);
    },
    deleteInstance: async (zone, name) => {
      const inst = g.instances.find((i) => i.name === name);
      log.push(`delete ${name}`);
      if (!inst) return; // 404: done
      if (g.foreign.some((f) => f.name === name)) throw new Error(`deleted a foreign instance ${name}`);
      count(`instance ${name}`);
      g.instances = g.instances.filter((i) => i !== inst);
      g.disks = g.disks.filter((d) => d.name !== name); // autoDelete
    },
    deleteDisk: async (zone, name) => {
      log.push(`delete disk ${name}`);
      if (!g.disks.some((d) => d.name === name)) return;
      count(`disk ${name}`);
      g.disks = g.disks.filter((d) => d.name !== name);
    },
    operations: async () => {
      if (hooks.operationsFail) throw new GceError(503, 'operations listing failed');
      return g.preempted.map((p) => structuredClone(p));
    },
    // hooks.zoneOperations(zone, filter): a promise the read waits on first (it may reject, as a failed read).
    zoneOperations: async (zone, filter) => {
      log.push(`read operations ${zone}`);
      await hooks.zoneOperations?.(zone, filter);
      return listOperations(zone, filter);
    },
    operation: async (link) => {
      const { body, ...op } = g.ops.find((o) => o.selfLink === link) ?? {};
      return op.name ? structuredClone(op) : null;
    },
    // Cloud Monitoring: hooks.timeSeries(filter, opts) answers (it may throw, as a refused read); none by default.
    timeSeries: async (filter, opts) => {
      log.push(`time series ${/nat\/([a-z_]+)/.exec(filter)?.[1] ?? filter}`);
      return hooks.timeSeries ? hooks.timeSeries(filter, opts) : [];
    },
    guestAttribute: async (zone, name, path) => {
      const inst = g.instances.find((i) => i.name === name);
      if (!inst) throw new GceError(404, 'notFound', ['notFound']);
      log.push(`read ${path} ${name}`);
      return inst.attrs?.[path] ?? null;
    },
  };

  const listOperations = (zone, filter) => g.ops.filter((o) => filter.includes(o.targetLink.split('/').pop()) && o.zone === zone).map(({ body, ...o }) => structuredClone(o));

  function operation(zone, body, status) {
    const op = `op-${nextId++}`;
    const made = {
      name: op, zone, operationType: 'insert', status, targetLink: `${ZONE_URL(zone)}/instances/${body.name}`, selfLink: `${ZONE_URL(zone)}/operations/${op}`,
      ...(status === 'DONE' ? { endTime: new Date(clock).toISOString() } : {}), body,
    };
    g.ops.push(made);
    return made;
  }

  function create(zone, body, { withOperation = true } = {}) {
    const inst = {
      kind: 'compute#instance', name: body.name, status: 'PROVISIONING', zone: ZONE_URL(zone),
      machineType: `${ZONE_URL(zone)}/machineTypes/${body.machineType.split('/').pop()}`,
      creationTimestamp: new Date(clock).toISOString(), labels: { ...body.labels }, scheduling: body.scheduling, metadata: body.metadata,
      networkInterfaces: structuredClone(body.networkInterfaces),
    };
    g.instances.push(inst);
    g.disks.push({ name: body.name, zone: ZONE_URL(zone), users: [`${ZONE_URL(zone)}/instances/${body.name}`], labels: { ...body.disks[0].initializeParams.labels }, creationTimestamp: inst.creationTimestamp });
    if (withOperation) operation(zone, body, 'DONE');
  }

  const github = {
    getRepo: async (repo) => {
      if (!gh.repos[repo]) throw httpError(404);
      return { private: gh.repos[repo].private };
    },
    runners: async (repo) => {
      if (hooks.runnersFail?.(repo)) throw httpError(502, 'runners listing failed');
      return runnersOf(repo).map((r) => ({ ...r }));
    },
    runsByStatus: async (repo, status) => gh.runs.filter((r) => r.repo === repo && r.status === status).map((r) => ({ ...r })),
    listJobs: async (repo, id) => gh.jobs.filter((j) => j.run_id === id).map((j) => ({ ...j, labels: [...j.labels] })),
    runsCreatedSince: async (repo, iso) => gh.runs.filter((r) => r.repo === repo && r.created_at >= iso).map((r) => ({ ...r })),
    jitConfig: async (repo, spec) => {
      hooks.beforeJit?.(repo, spec);
      const r = { id: nextId++, name: spec.name, status: 'offline', busy: false, labels: spec.labels.map((name) => ({ name })) };
      runnersOf(repo).push(r);
      log.push(`jit ${spec.name}`);
      return { runner: { id: r.id, name: r.name }, encoded_jit_config: `jit-for-${spec.name}` };
    },
    deleteRunner: async (repo, id) => {
      const list = runnersOf(repo);
      const r = list.find((x) => x.id === id);
      log.push(`unregister ${r?.name ?? id}`);
      hooks.beforeUnregister?.(repo, r);
      if (!r) throw httpError(404, 'Not Found');
      if (r.busy) throw httpError(422, 'Bad request - Runner is still running a job');
      count(`runner ${r.name}`);
      gh.runners.set(repo, list.filter((x) => x !== r));
    },
    // Issues: a comment without `issue` is on #1, and an issue's `older` stands for comments made before the test.
    // GitHub's cap: no new comment on an issue that already has 2,500. Edits are allowed on any issue, closed or not.
    openIssues: async () => gh.issues.filter((i) => i.state === 'open').map((i) => ({ ...i, comments: commentCount(i.number) })),
    createIssue: async (_repo, issue) => {
      const made = { number: nextIssue++, ...issue, state: 'open', created_at: new Date(clock).toISOString(), older: 0 };
      gh.issues.push(made);
      log.push(`issue #${made.number} ${issue.title}`);
      return { ...made, comments: 0 };
    },
    closeIssue: async (_repo, n) => {
      gh.issues.find((i) => i.number === n).state = 'closed';
      log.push(`close #${n}`);
    },
    issueComments: async (_repo, n, { since } = {}) =>
      gh.comments.filter((c) => (c.issue ?? 1) === n && (!since || c.updated_at >= since)).map((c) => ({ ...c })),
    // hooks.commentWrite(body): a promise a comment's creation or edit waits on first (it may reject: a failed write).
    createComment: async (_repo, n, body) => {
      await hooks.commentWrite?.(body);
      if (commentCount(n) >= 2500) throw httpError(403, 'Commenting is disabled on issues with more than 2500 comments');
      const c = { id: nextId++, issue: n, body, updated_at: new Date(clock).toISOString() };
      gh.comments.push(c);
      return { ...c };
    },
    getComment: async (_repo, id) => {
      const c = gh.comments.find((x) => x.id === id);
      if (!c) throw httpError(404);
      return { ...c };
    },
    updateComment: async (_repo, id, body) => {
      await hooks.commentWrite?.(body);
      const c = gh.comments.find((x) => x.id === id);
      if (!c) throw httpError(404);
      c.body = body;
      c.updated_at = new Date(clock).toISOString();
    },
    deleteComment: async (_repo, id) => {
      if (!gh.comments.some((c) => c.id === id)) throw httpError(404);
      gh.comments = gh.comments.filter((c) => c.id !== id);
    },
    ensureLabel: async () => {},
  };

  // GitHub's and the VM's side.
  let runId = 1000;
  const sim = {
    // A job in a new run, or in `run` (another job's run_id) when given.
    queue(repo, labels, { name = 'ci / gate', run: inRun } = {}) {
      let run = gh.runs.find((r) => r.id === inRun);
      if (!run) {
        run = { id: runId++, repo, status: 'queued', path: '.github/workflows/gate.yml', created_at: new Date(clock).toISOString() };
        gh.runs.push(run);
      }
      const job = {
        id: run.id * 10 + gh.jobs.filter((j) => j.run_id === run.id).length, run_id: run.id, name, status: 'queued', labels,
        created_at: new Date(clock).toISOString(), started_at: null, runner_name: null,
      };
      gh.jobs.push(job);
      return job;
    },
    vm: (name) => g.instances.find((i) => i.name === name),
    runner: (repo, name) => runnersOf(repo).find((r) => r.name === name),
    boot(repo, name) {
      sim.vm(name).status = 'RUNNING';
      sim.vm(name).lastStartTimestamp = new Date(clock).toISOString();
      sim.runner(repo, name).status = 'online';
    },
    take(repo, name, job) {
      const r = sim.runner(repo, name);
      r.busy = true;
      job.status = 'in_progress';
      job.started_at = new Date(clock).toISOString();
      job.runner_name = name;
      gh.runs.find((x) => x.id === job.run_id).status = 'in_progress';
    },
    // The job ends: the JIT runner leaves, the unit reports ci-kit/job=exit:<code>, and the guest powers off, which
    // takes it a while (`poweredOff: false` stops before the VM is TERMINATED). GitHub removes the runner a little
    // after the job ends (`runnerLeaves: false` stops before: it reads registered and not busy). The run completes
    // with its last job.
    finish(repo, name, job, { poweredOff = true, code = 0, runnerLeaves = true } = {}) {
      job.status = 'completed';
      if (gh.jobs.every((j) => j.run_id !== job.run_id || j.status === 'completed')) gh.runs.find((x) => x.id === job.run_id).status = 'completed';
      if (runnerLeaves) gh.runners.set(repo, runnersOf(repo).filter((r) => r.name !== name)); // a JIT runner leaves after its job
      else sim.runner(repo, name).busy = false;
      sim.vm(name).attrs = { ...sim.vm(name).attrs, 'ci-kit/job': `exit:${code}` };
      if (poweredOff) sim.vm(name).status = 'TERMINATED';
    },
    // An insert left running (an insert error with `running: true`) finishes now: its VM is created, or with `codes`
    // (and the error's `message`) the operation ends in that error and creates nothing.
    completeInsert(name, { codes, message } = {}) {
      const op = g.ops.find((o) => o.status === 'RUNNING' && o.targetLink.endsWith(`/instances/${name}`));
      Object.assign(op, { status: 'DONE', endTime: new Date(clock).toISOString() });
      if (codes) op.error = { errors: codes.map((code) => ({ code, ...(message ? { message } : {}) })) };
      else create(op.zone, op.body, { withOperation: false });
    },
    preempt(name) {
      const inst = sim.vm(name);
      g.instances = g.instances.filter((i) => i !== inst);
      g.disks = g.disks.filter((d) => d.name !== name);
      g.preempted.push({ operationType: 'compute.instances.preempted', targetLink: `${inst.zone}/instances/${name}`, insertTime: new Date(clock).toISOString() });
    },
  };

  return {
    gce, github, sim, g, gh, log, counts, hooks,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
      const due = timers.filter((t) => t.due <= clock);
      timers = timers.filter((t) => t.due > clock);
      for (const t of due) t.fire();
    },
    after: (ms) => {
      const t = { due: clock + ms };
      const promise = new Promise((resolve) => { t.fire = resolve; });
      timers.push(t);
      return { promise, cancel: () => { timers = timers.filter((x) => x !== t); } };
    },
  };
}

export const gceErr = (codes, opts = { accepted: true, finished: true }) => () => new GceError(200, `operation failed: ${codes}`, codes, opts);
