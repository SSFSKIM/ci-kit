#!/usr/bin/env node
// The GCE bake (spec §3a Image, I12): builds the image family ci-kit-runner. It runs as the Cloud Run job ci-kit-bake
// (gce/deploy.sh), or from the Mac with gcloud's default account:
//   node gce/bake/bake.mjs
// No inbound network or ssh: the builder does its work through its startup script, reports through a guest
// attribute and powers off; this script images it only on `ok`, smoke-boots the image, runs one real Actions job on a
// VM booted from it, and marks it ready only when both pass. Every VM and runner registration the bake made is gone
// when it ends, a failed bake deletes its own image, and the two newest ready images are kept.
// Env (optional): CI_KIT_COMMIT, the kit commit to bake (default: main's head); CI_KIT_BAKE_RUN, the run id.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createGce, accessToken, GceError } from '../../lib/gce.mjs';
import { createAppTokens } from '../../lib/github-app.mjs';
import { createGitHub } from '../../lib/github.mjs';
import { WARM_SCOPE } from '../../pool/bake/warm.mjs';
import {
  reportOutcome, checkOutcome, ownsBakeInstance, ownsBakeImage, refusedOutright, staleBakeInstances, staleBakeRunners, imagesToPrune, placements,
  refusal, bakeRunId, bakeNames, builderInstance, smokeInstance, checkInstance, checkJitRequest, imageBody, fillBuilderScript,
  BUILDER_MACHINES, BAKE_TIMEOUT_MS, SMOKE_TIMEOUT_MS, CHECK_TIMEOUT_MS, CHECK, CHECK_SCOPE,
} from './plan.mjs';

const BAKE_FILTER = 'labels.ci-kit=gce-builder';
const IMAGE_FILTER = 'labels.ci-kit=gce-image';
const POLL_MS = 15_000;
// A runner whose VM was deleted mid-job stays busy until GitHub lets go of the job; its unregister is retried that long.
const RUNNER_RETRIES = 6;
const RUNNER_RETRY_MS = 30_000;
const zoneOf = (instance) => instance.zone.split('/').pop();

// Creates the VM at the first placement that takes it. Capacity moves to the next zone; quota skips the machine's
// remaining zones, since quota is per region. Anything else fails the bake.
async function createFirst(gce, options, body, log) {
  const tried = [];
  let skip = null;
  for (const { machine, zone } of options) {
    if (machine === skip) continue;
    const spec = body({ machine, zone });
    try {
      await gce.insertInstance(zone, spec);
      log(`${spec.name}: ${machine}@${zone} created`);
      return { name: spec.name, zone };
    } catch (err) {
      const why = refusal(err);
      if (!why) throw err;
      tried.push(`${machine}@${zone} (${why})`);
      if (why === 'quota') skip = machine;
    }
  }
  throw new Error(`ci-kit: no placement took the VM: ${tried.join(', ')}`);
}

// One look at a bake VM: the instance and its report at `path`. The report is remembered across looks, since it may
// no longer be readable once the guest is off. A VM relabelled by someone (to keep it for debugging) is theirs from
// then on.
async function look(gce, vm, path, runId, last) {
  const instance = await gce.instance(vm.zone, vm.name);
  if (instance && !ownsBakeInstance(instance, runId)) throw new Error(`ci-kit: ${vm.name} is no longer this bake's (labels ${JSON.stringify(instance.labels ?? {})}); left untouched`);
  let report = last;
  if (instance) {
    try {
      report = (await gce.guestAttribute(vm.zone, vm.name, path)) ?? report;
    } catch (err) {
      if (!(err instanceof GceError && err.status === 404)) throw err;
    }
  }
  return { instance, report };
}

// Polls a builder or smoke VM until it reported and powered off, or failed.
async function awaitReport(gce, vm, path, timeoutMs, { runId, sleep, now, log }) {
  const start = now();
  let report = null;
  for (;;) {
    let instance;
    ({ instance, report } = await look(gce, vm, path, runId, report));
    const outcome = reportOutcome({ instance, report, elapsedMs: now() - start, timeoutMs });
    if (outcome.done) {
      log(`${vm.name}: ${outcome.ok ? 'ok' : outcome.reason} after ${Math.round((now() - start) / 1000)} s`);
      return outcome;
    }
    await sleep(POLL_MS);
  }
}

async function deleteIfOwned(gce, vm, runId, log) {
  const instance = await gce.instance(vm.zone, vm.name);
  if (!instance || !ownsBakeInstance(instance, runId)) return;
  await gce.deleteInstance(vm.zone, vm.name);
  log(`${vm.name}: deleted`);
}

// Bake step 5: one real Actions job on a VM booted from the image. The bake registers the check runner, dispatches
// bake-check.yml to its label, and boots the check VM with the runner's JIT config, as the launcher boots a job VM.
// `check` records what exists (the runner's id, the run's id) for the cleanup. Returns the run's URL on a pass.
async function realJob(gce, gh, { cfg, names, runId, image, subnetwork, machines, check, sleep, now, log }) {
  if ((await gh.getRepo(CHECK.repo)).private !== true) throw new Error(`ci-kit: ${CHECK.repo} is not private, and no runner is registered on a public repo`);
  const jit = await gh.jitConfig(CHECK.repo, checkJitRequest(names));
  check.runner = jit.runner.id;
  log(`runner ${names.runner} registered in ${CHECK.repo}`);
  const start = now();
  const run = await gh.dispatchWorkflow(CHECK.repo, CHECK.workflow, { ref: CHECK.ref, inputs: { bake: String(runId) } });
  if (!run?.workflow_run_id) throw new Error(`ci-kit: dispatching ${CHECK.workflow} in ${CHECK.repo} returned no run`);
  check.run = run.workflow_run_id;
  log(`real job: ${run.html_url}`);
  const vm = await createFirst(gce, placements(machines, cfg.zones),
    ({ machine, zone }) => checkInstance({ name: names.check, zone, machine, runId, image, diskGb: cfg.disk_gb, subnetwork, jit: jit.encoded_jit_config }), log);
  let report = null;
  for (;;) {
    let instance;
    ({ instance, report } = await look(gce, vm, 'ci-kit/job', runId, report));
    const state = await gh.getRun(CHECK.repo, check.run);
    const jobs = state.status === 'completed' ? await gh.listJobs(CHECK.repo, check.run) : [];
    const elapsedMs = now() - start;
    const outcome = checkOutcome({
      vm: reportOutcome({ instance, report, elapsedMs, timeoutMs: CHECK_TIMEOUT_MS, ok: 'exit:0' }),
      run: state, jobs, runner: names.runner, elapsedMs, timeoutMs: CHECK_TIMEOUT_MS,
    });
    if (outcome.done) {
      log(`real job: ${outcome.ok ? 'passed' : outcome.reason} after ${Math.round(elapsedMs / 1000)} s`);
      if (!outcome.ok) throw new Error(`ci-kit: the real job did not pass: ${outcome.reason} (${run.html_url})`);
      return run.html_url;
    }
    await sleep(POLL_MS);
  }
}

// One bake. Returns { image, check } (the real job's run URL) once the image is ready; throws with the reason
// otherwise. gh: a GitHub client for ci-kit-sandbox (CHECK_SCOPE).
export async function runBake(gce, { cfg, sha, runId, token, gh, script, sleep, now = Date.now, log = () => {} }) {
  const names = bakeNames(runId, sha);
  const subnetwork = `regions/${cfg.region}/subnetworks/${cfg.subnetwork}`;
  const wait = { runId, sleep, now, log };
  const check = { runner: null, run: null };
  let image = null;
  let ready = false;
  for (const stale of staleBakeInstances(await gce.instances(BAKE_FILTER), now())) {
    await gce.deleteInstance(zoneOf(stale), stale.name);
    log(`${stale.name}: deleted, left by an earlier bake (created ${stale.creationTimestamp})`);
  }
  for (const stale of staleBakeRunners(await gh.runners(CHECK.repo), now())) {
    await gh.deleteRunner(CHECK.repo, stale.id).then(
      () => log(`runner ${stale.name}: unregistered, left by an earlier bake`),
      (err) => log(`runner ${stale.name}: left by an earlier bake, not unregistered: ${err.message}`),
    );
  }
  try {
    const builder = await createFirst(gce, placements(BUILDER_MACHINES, cfg.zones),
      ({ machine, zone }) => builderInstance({ name: names.builder, zone, machine, runId, script, token, subnetwork }), log);
    const built = await awaitReport(gce, builder, 'ci-kit/bake', BAKE_TIMEOUT_MS, wait);
    if (!built.ok) throw new Error(`ci-kit: the builder did not finish: ${built.reason}`);

    // The disk is consistent: the guest powered off after reporting. Re-check ownership right before imaging it.
    const owned = await gce.instance(builder.zone, builder.name);
    if (!owned || !ownsBakeInstance(owned, runId)) throw new Error(`ci-kit: ${builder.name} is gone or no longer this bake's`);
    // An insert refused outright made nothing of this run's (a name collision leaves the other image alone). One
    // whose outcome is uncertain may have made the image, so the cleanup looks for it, and deletes it only by label.
    try {
      await gce.insertImage(imageBody({ name: names.image, family: cfg.image_family, zone: builder.zone, disk: builder.name, sha, runId }));
    } catch (err) {
      if (!refusedOutright(err)) image = names.image;
      throw err;
    }
    image = names.image;
    log(`image ${image} created (unready)`);
    await deleteIfOwned(gce, builder, runId, log);

    const machines = [cfg.machines['2'], cfg.machine_fallback?.['2']].filter(Boolean);
    const source = `projects/${cfg.project}/global/images/${image}`;
    const smoke = await createFirst(gce, placements(machines, cfg.zones),
      ({ machine, zone }) => smokeInstance({ name: names.smoke, zone, machine, runId, image: source, diskGb: cfg.disk_gb, subnetwork }), log);
    const checked = await awaitReport(gce, smoke, 'ci-kit/smoke', SMOKE_TIMEOUT_MS, wait);
    if (!checked.ok) throw new Error(`ci-kit: the smoke VM did not pass: ${checked.reason}`);
    await deleteIfOwned(gce, smoke, runId, log);

    const url = await realJob(gce, gh, { cfg, names, runId, image: source, subnetwork, machines, check, ...wait });

    const made = (await gce.images(IMAGE_FILTER)).find((i) => i.name === image);
    await gce.setImageLabels(image, { ...made.labels, 'ci-kit-ready': 'true' });
    ready = true;
    log(`image ${image} is ready`);
    return { image, check: url };
  } finally {
    await cleanUp(gce, { cfg, runId, image: ready ? null : image, gh, check, sleep, now, log });
  }
}

// Every exit: the real job's run if it is still going (a job no runner took would wait in the queue for a day), this
// run's instances, its check runner, its own unready image, and the images retention drops. A failure here is logged,
// not thrown over the bake's own outcome; the next bake's sweeps and retention retry it.
async function cleanUp(gce, { cfg, runId, image, gh, check, sleep, now, log }) {
  const step = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      log(`cleanup: ${what} failed: ${err.message}`);
    }
  };
  if (check.run) {
    await step('real job run', async () => {
      if ((await gh.getRun(CHECK.repo, check.run)).status === 'completed') return;
      await gh.cancelRun(CHECK.repo, check.run);
      log(`cleanup: real job run ${check.run} cancelled`);
    });
  }
  await step('instances', async () => {
    for (const i of (await gce.instances(BAKE_FILTER)).filter((x) => ownsBakeInstance(x, runId))) {
      await gce.deleteInstance(zoneOf(i), i.name);
      log(`cleanup: ${i.name} deleted`);
    }
  });
  if (check.runner) {
    await step('check runner', async () => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await gh.deleteRunner(CHECK.repo, check.runner);
          log(`cleanup: check runner ${check.runner} unregistered`);
          return;
        } catch (err) {
          if (err.status === 404) return; // a JIT runner leaves on its own once its job is done
          if (err.status !== 422 || attempt >= RUNNER_RETRIES) throw new Error(`${err.message}; the next bake's sweep unregisters it`);
          await sleep(RUNNER_RETRY_MS);
        }
      }
    });
  }
  if (image) {
    await step('image', async () => {
      const found = await gce.image(image);
      if (!found) return;
      if (!ownsBakeImage(found, runId)) {
        log(`cleanup: image ${image} is not this bake's (labels ${JSON.stringify(found.labels ?? {})}); left untouched`);
        return;
      }
      await gce.deleteImage(image);
      log(`cleanup: unready image ${image} deleted`);
    });
  }
  await step('retention', async () => {
    for (const old of imagesToPrune(await gce.images(IMAGE_FILTER), { family: cfg.image_family, now: now() })) {
      await gce.deleteImage(old.name);
      log(`retention: image ${old.name} deleted (${old.labels['ci-kit-ready'] === 'true' ? 'ready, beyond the two newest' : 'unready, stale'})`);
    }
  });
}

async function mainHead() {
  const res = await fetch('https://api.github.com/repos/SSFSKIM/ci-kit/commits/main', {
    headers: { accept: 'application/vnd.github.sha' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`ci-kit: could not read the kit's main (HTTP ${res.status})`);
  return (await res.text()).trim();
}

async function main() {
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const cfg = JSON.parse(await readFile(new URL('../../pool/config/gce.json', import.meta.url), 'utf8'));
  const sha = process.env.CI_KIT_COMMIT || (await mainHead());
  const runId = process.env.CI_KIT_BAKE_RUN || bakeRunId(new Date());
  const gce = createGce({ project: cfg.project, token: accessToken() });
  const app = { appId: (await gce.secret('ci-kit-app-id')).trim(), pem: await gce.secret('ci-kit-app-key'), owner: 'SSFSKIM' };
  // The builder's token: one hour, MAWS's contents only (the cache warming reads its lockfile).
  const token = await createAppTokens({ ...app, scope: WARM_SCOPE })();
  // The real job's: ci-kit-sandbox only, minted as needed, so it is fresh after a long build.
  const gh = createGitHub(createAppTokens({ ...app, scope: CHECK_SCOPE }));
  const script = fillBuilderScript(await readFile(new URL('./builder.sh', import.meta.url), 'utf8'), { sha });
  log(`bake ${runId}: kit ${sha.slice(0, 8)}, project ${cfg.project}`);
  const { image, check } = await runBake(gce, { cfg, sha, runId, token, gh, script, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log });
  log(`done: ${image}, real job ${check}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
