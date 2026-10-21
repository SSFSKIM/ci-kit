#!/usr/bin/env node
// Times a job VM's start from an image, as the pool sees it (spec M3, The boot): one real sandbox job per sample,
// through the bake's real-job path (gce/bake/bake.mjs step 5). For each sample it registers a JIT runner labelled
// ci-kit-bake-<run id>, dispatches bake-check.yml to that label, creates a check VM from the image on the machine,
// and records when Compute Engine accepted the insert (creationTimestamp), when it called the VM RUNNING
// (lastStartTimestamp) and when GitHub started the job; the VM's serial console is kept beside the result. From the
// Mac, with gcloud's default account:
//   node gce/tools/boot-sample.mjs --image <image name> [--region <r>] [--machine <m>] [--count 5] [--parallel 2] [--out <dir>]
// It samples one placement of gce.json: --region's (default: the first), on its zones, subnetwork and boot disk type,
// with --machine (default: the placement's size-4 machine).
// Every VM and runner it made is gone when it ends. A quota refusal stops it: the pool shares the quota.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGce, accessToken } from '../../lib/gce.mjs';
import { createAppTokens } from '../../lib/github-app.mjs';
import { createGitHub } from '../../lib/github.mjs';
import { parseGceConfig } from '../launcher/config.mjs';
import { bakeRunId, bakeNames, checkInstance, checkJitRequest, refusal, ownsBakeInstance, CHECK, CHECK_SCOPE } from '../bake/plan.mjs';

const POLL_MS = 2_000;
const SAMPLE_TIMEOUT_MS = 8 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const secs = (a, b) => (a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : null);

// The stages of one sample, in seconds.
export const stagesOf = (s) => ({
  acceptedToRunning: secs(s.accepted, s.running),
  runningToStarted: secs(s.running, s.started),
  acceptedToStarted: secs(s.accepted, s.started),
});

export function summarize(samples) {
  const out = {};
  for (const key of ['acceptedToRunning', 'runningToStarted', 'acceptedToStarted']) {
    const v = samples.map((s) => stagesOf(s)[key]).filter((x) => x !== null).sort((a, b) => a - b);
    const mid = v.length / 2;
    out[key] = v.length ? { n: v.length, median: v.length % 2 ? v[Math.floor(mid)] : (v[mid - 1] + v[mid]) / 2, min: v[0], max: v.at(-1) } : null;
  }
  return out;
}

// The placement a run samples and the machine it boots: opts.region's placement (default: the first), and
// opts.machine (default: that placement's size-4 machine).
export function samplePlacement(cfg, { region, machine } = {}) {
  const placement = region ? cfg.placements.find((p) => p.region === region) : cfg.placements[0];
  if (!placement) throw new Error(`no placement in ${region} in gce.json (${cfg.placements.map((p) => p.region).join(', ')})`);
  return { placement, machine: machine ?? placement.machines['4'] };
}

// Removes what one sample made, as the bake's cleanup does: its VMs found by the run's label (an insert accepted whose
// wait failed left no zone to address it by), its run cancelled if still going, and its runner unregistered, found by
// name when the registration's response was lost. A 404 counts as done; a runner that just finished its job is
// refused (422) for a while, and retried.
export async function cleanUpSample({ gce, gh, runId, runner, run, log, sleep: wait = sleep }) {
  try {
    for (const i of (await gce.instances('labels.ci-kit=gce-builder')).filter((x) => ownsBakeInstance(x, runId))) {
      await gce.deleteInstance(i.zone.split('/').pop(), i.name);
    }
  } catch (err) {
    log(`cleanup ${runId}: instances: ${err.message}`);
  }
  if (run) {
    const state = await gh.getRun(CHECK.repo, run).catch(() => null);
    if (state && state.status !== 'completed') await gh.cancelRun(CHECK.repo, run).catch((err) => log(`cancel ${run}: ${err.message}`));
  }
  const id = runner.id ?? (await gh.runners(CHECK.repo).catch(() => [])).find((r) => r.name === runner.name)?.id;
  for (let attempt = 1; id && attempt <= 13; attempt += 1) {
    try {
      await gh.deleteRunner(CHECK.repo, id);
      return;
    } catch (err) {
      if (err.status === 404) return;
      if (err.status !== 422 || attempt === 13) {
        log(`runner ${runner.name} (${id}) not unregistered: ${err.message}`);
        return;
      }
      await wait(30_000);
    }
  }
}

class QuotaStop extends Error {}

async function sample({ gce, gh, cfg, placement, project, image, machine, token, out, log }) {
  const runId = bakeRunId(new Date());
  const names = bakeNames(runId, 'sample00');
  const record = { runId, image, region: placement.region, machine, vm: names.check };
  let zone = null;
  const runner = { name: names.runner, id: null }; // named before the call: a lost response leaves no id
  let run = null;
  try {
    const jit = await gh.jitConfig(CHECK.repo, checkJitRequest(names));
    runner.id = jit.runner.id;
    run = (await gh.dispatchWorkflow(CHECK.repo, CHECK.workflow, { ref: CHECK.ref, inputs: { bake: runId } })).workflow_run_id;
    for (const z of placement.zones) {
      try {
        await gce.insertInstance(z, checkInstance({
          name: names.check, zone: z, machine, runId, image: `projects/${project}/global/images/${image}`, diskGb: cfg.disk_gb, placement, jit: jit.encoded_jit_config,
        }));
        zone = z;
        break;
      } catch (err) {
        const why = refusal(err);
        if (why === 'quota') throw new QuotaStop(`quota refused ${machine}@${z}: ${err.message}`);
        if (why !== 'capacity') throw err;
        log(`${names.check}: ${machine}@${z} out of capacity`);
      }
    }
    if (!zone) throw new Error(`no zone had capacity for ${machine}`);
    record.zone = zone;
    let serial = '';
    let next = 0;
    const readSerial = async () => {
      const res = await fetch(`https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances/${names.check}/serialPort?port=1&start=${next}`, {
        headers: { authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        log(`${names.check}: serial port read ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return;
      }
      // The API keeps the last 1 MB; a read starting before that window gets the window, with a gap noted.
      const body = await res.json();
      if (Number(body.start) > next) serial += `\n[ci-kit boot-sample: ${Number(body.start) - next} bytes lost]\n`;
      serial += body.contents ?? '';
      next = Number(body.next ?? next);
    };
    const until = Date.now() + SAMPLE_TIMEOUT_MS;
    let inst = null;
    for (;;) {
      inst = await gce.instance(zone, names.check);
      if (inst) {
        record.accepted = inst.creationTimestamp;
        if (inst.lastStartTimestamp) record.running = inst.lastStartTimestamp;
        await readSerial();
        // The job unit's report (job.mjs): it shows the guest agent took the guest attribute write. Read while the
        // guest is up; the attribute may be gone once it is off.
        record.report = (await gce.guestAttribute(zone, names.check, 'ci-kit/job').catch(() => null)) ?? record.report;
      }
      const job = (await gh.listJobs(CHECK.repo, run))[0];
      if (job) Object.assign(record, { job: job.id, queued: job.created_at, started: job.started_at ?? undefined, conclusion: job.conclusion ?? undefined });
      if (job?.status === 'completed' || Date.now() > until) break;
      await sleep(POLL_MS);
    }
    // The console runs behind the guest (a 115200-baud port); keep reading until the guest powers itself off.
    for (const drainUntil = Date.now() + 60_000; inst?.status === 'RUNNING' && Date.now() < drainUntil; inst = await gce.instance(zone, names.check)) {
      await readSerial();
      record.report = (await gce.guestAttribute(zone, names.check, 'ci-kit/job').catch(() => null)) ?? record.report;
      await sleep(POLL_MS);
    }
    writeFileSync(join(out, `${names.check}.serial`), serial);
    log(`${names.check} (${machine}@${zone}): ${JSON.stringify(stagesOf(record))} ${record.conclusion ?? 'unfinished'}, report ${record.report ?? 'unseen'}`);
    return record;
  } finally {
    await cleanUpSample({ gce, gh, runId, runner, run, log });
  }
}

function parseArgs(argv) {
  const opts = { count: 5, parallel: 2, out: '.' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in opts || ['image', 'region', 'machine'].includes(key)) || argv[i + 1] === undefined) {
      throw new Error('usage: node gce/tools/boot-sample.mjs --image <name> [--region r] [--machine m] [--count n] [--parallel n] [--out dir]');
    }
    opts[key] = ['count', 'parallel'].includes(key) ? Number(argv[i + 1]) : argv[i + 1];
  }
  if (!opts.image) throw new Error('--image is required');
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const cfg = parseGceConfig(readFileSync(new URL('../../pool/config/gce.json', import.meta.url), 'utf8'));
  const { placement, machine } = samplePlacement(cfg, opts);
  const token = accessToken();
  const gce = createGce({ project: cfg.project, token });
  const app = { appId: (await gce.secret('ci-kit-app-id')).trim(), pem: await gce.secret('ci-kit-app-key'), owner: 'SSFSKIM' };
  const gh = createGitHub(createAppTokens({ ...app, scope: CHECK_SCOPE }));
  if ((await gh.getRepo(CHECK.repo)).private !== true) throw new Error(`${CHECK.repo} is not private`);
  mkdirSync(opts.out, { recursive: true });
  const samples = [];
  let left = opts.count;
  let stop = null;
  const worker = async () => {
    while (left > 0 && !stop) {
      left -= 1;
      try {
        samples.push(await sample({ gce, gh, cfg, placement, project: cfg.project, image: opts.image, machine, token, out: opts.out, log }));
      } catch (err) {
        if (err instanceof QuotaStop) stop = err;
        log(`sample failed: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: opts.parallel }, worker));
  writeFileSync(join(opts.out, 'samples.json'), `${JSON.stringify(samples, null, 2)}\n`);
  console.log(JSON.stringify({ image: opts.image, region: placement.region, machine, samples: samples.length, ...summarize(samples) }, null, 2));
  if (stop) {
    console.error(`stopped: ${stop.message}`);
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
