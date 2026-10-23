#!/usr/bin/env node
// A GCE job VM's one task (spec §3a VM lifecycle step 3), run at boot by ci-kit-gce-job.service: block the job
// container from the metadata server (DNS stays open), then run the job container with the JIT config from this VM's
// metadata, or, on the bake's smoke VM, the smoke check. The result goes to a guest attribute (ci-kit/job=exit:<code>,
// or ci-kit/smoke=ok|failed:<check>); the unit powers the VM off when this exits, however it exits.
// The JIT config reaches the container only through the docker CLI's environment, never a command line or a log.
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { prepareContainer, docker } from '../../pool/vm/container.mjs';
import { jobRunArgs, vmMode, smokeVerdict } from './run.mjs';

const MD = 'http://169.254.169.254/computeMetadata/v1/instance';
const log = (...a) => console.log(`ci-kit gce job (up ${readFileSync('/proc/uptime', 'utf8').split(' ')[0]} s):`, ...a);

async function meta(path) {
  const res = await fetch(`${MD}/${path}`, { headers: { 'metadata-flavor': 'Google' }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`metadata ${path}: HTTP ${res.status}`);
  return res.text();
}

async function report(key, value) {
  try {
    const res = await fetch(`${MD}/guest-attributes/ci-kit/${key}`, {
      method: 'PUT',
      headers: { 'metadata-flavor': 'Google' },
      body: value,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    log(`could not report ci-kit/${key}=${value}: ${err.message}`);
  }
}

async function main() {
  const name = await meta('name');
  const mode = vmMode({ jit: await meta('attributes/ci-kit-jit'), smoke: await meta('attributes/ci-kit-smoke') });
  log(`${name}: ${mode.kind}`);
  if (mode.kind === 'none') {
    await report('job', 'failed:no-jit');
    process.exitCode = 1;
    return;
  }
  await prepareContainer(name);
  const cpus = availableParallelism();

  if (mode.kind === 'smoke') {
    const { code, out } = await docker(jobRunArgs({ name, cpus, smoke: { expectCpus: mode.expectCpus } }), { capture: true });
    const verdict = smokeVerdict(out, code);
    log(`smoke: ${verdict}`);
    await report('smoke', verdict);
    return;
  }
  const jit = await meta('attributes/ci-kit-jit');
  const { code } = await docker(jobRunArgs({ name, cpus }), { env: { CI_KIT_JIT: jit } });
  log(`job container exited ${code}`);
  await report('job', `exit:${code}`);
}

main().catch(async (err) => {
  log(`failed: ${err.message}`);
  await report('job', 'failed:unit');
  process.exit(1);
});
