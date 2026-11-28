// The GCE job VM's unit (spec §3a Shape, VM lifecycle step 3): the job container it runs, the metadata block that
// keeps DNS, what it does with and without a JIT config, and how it reads the smoke check's verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobRunArgs, vmMode, smokeVerdict, METADATA_BLOCK } from '../../gce/vm/run.mjs';
import { CACHE } from '../../pool/agent/docker.mjs';

test('a GCE job container gets every vCPU, the shared caches, hook and JIT passing, and no memory cap', () => {
  const args = jobRunArgs({ name: 'ci-kit-gce-abc', cpus: 8 });
  const joined = args.join(' ');
  assert.equal(args[0], 'run');
  assert.doesNotMatch(joined, /--cpuset-cpus|--memory|--detach|docker\.sock|\/etc\/ci-kit|--privileged/);
  assert.ok(args.includes('CI_KIT_CORES=0-7'));
  assert.match(joined, /--name ci-kit-gce-abc /);
  assert.match(joined, new RegExp(`-v ${CACHE}:${CACHE} `));
  assert.match(joined, /-e CI_KIT_JIT /);
  assert.ok(!args.some((a) => a.startsWith('CI_KIT_JIT=')));
  const dirs = {
    RUNNER_TOOL_CACHE: 'toolcache', AGENT_TOOLSDIRECTORY: 'toolcache', npm_config_cache: 'npm',
    npm_config_store_dir: 'pnpm-store', pnpm_config_store_dir: 'pnpm-store', COREPACK_HOME: 'corepack',
    PLAYWRIGHT_BROWSERS_PATH: 'ms-playwright', electron_config_cache: 'electron', ELECTRON_CACHE: 'electron',
  };
  for (const [env, dir] of Object.entries(dirs)) assert.ok(args.includes(`${env}=${CACHE}/${dir}`), env);
  assert.ok(args.includes('ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/bin/ci-kit-job-started.sh'));
  // A stalled git transfer fails after a minute rather than at the job's limit.
  assert.ok(args.includes('GIT_HTTP_LOW_SPEED_LIMIT=1000') && args.includes('GIT_HTTP_LOW_SPEED_TIME=60'));
  assert.equal(args.at(-1), 'ci-kit-runner:latest');
});

test('the smoke container runs the check script in place of the runner, told the vCPUs to expect and its work dir', () => {
  const args = jobRunArgs({ name: 's', cpus: 2, smoke: { expectCpus: 2 } });
  const joined = args.join(' ');
  assert.match(joined, /--entrypoint \/usr\/local\/bin\/ci-kit-smoke /);
  assert.match(joined, /-v \/opt\/ci-kit\/gce\/vm\/smoke\.sh:\/usr\/local\/bin\/ci-kit-smoke:ro /);
  assert.ok(args.includes('CI_KIT_EXPECT_CPUS=2'));
  assert.ok(args.includes(`CI_KIT_WORK=${CACHE}/work/s`));
  assert.equal(args.at(-1), 'ci-kit-runner:latest');
});

test('the metadata block drops the container\'s TCP and UDP to the metadata server except DNS on 53', () => {
  assert.deepEqual(METADATA_BLOCK, [
    ['DOCKER-USER', '-d', '169.254.169.254/32', '-p', 'tcp', '!', '--dport', '53', '-j', 'DROP'],
    ['DOCKER-USER', '-d', '169.254.169.254/32', '-p', 'udp', '!', '--dport', '53', '-j', 'DROP'],
  ]);
});

test('a VM runs its job with a JIT config, the smoke check with ci-kit-smoke, and nothing otherwise', () => {
  assert.deepEqual(vmMode({ jit: 'eyJ…', smoke: null }), { kind: 'job' });
  assert.deepEqual(vmMode({ jit: null, smoke: '4' }), { kind: 'smoke', expectCpus: 4 });
  assert.deepEqual(vmMode({ jit: 'x', smoke: '4' }), { kind: 'job' }); // a launcher VM is never a smoke VM
  assert.deepEqual(vmMode({ jit: null, smoke: null }), { kind: 'none' });
  assert.deepEqual(vmMode({ jit: '', smoke: 'many' }), { kind: 'none' });
});

test('the smoke verdict is the check script\'s last verdict line, or the container\'s exit when it printed none', () => {
  assert.equal(smokeVerdict('check cpus: ok\nci-kit smoke: ok\n', 0), 'ok');
  assert.equal(smokeVerdict('check cpus: ok\ncheck dns: FAILED\nci-kit smoke: failed:dns\n', 1), 'failed:dns');
  assert.equal(smokeVerdict('docker: Error response from daemon\n', 125), 'failed:container-exit-125');
  assert.equal(smokeVerdict('ci-kit smoke: ok\n', 1), 'failed:container-exit-1'); // an ok that did not exit 0 is not trusted
});

test('the unit powers the VM off at once however the job ends (no orderly shutdown: the disk is discarded), and starts after Docker', () => {
  const unit = readFileSync(new URL('../../gce/vm/ci-kit-gce-job.service', import.meta.url), 'utf8');
  const unitSection = unit.slice(unit.indexOf('[Unit]'), unit.indexOf('[Service]'));
  // An orderly poweroff took about 85 s on a job VM (A13 measurement, 2026-10-16), all of it billed and all of it
  // between the job's end and the VM's deletion.
  assert.match(unitSection, /^SuccessAction=poweroff-immediate$/m);
  assert.match(unitSection, /^FailureAction=poweroff-immediate$/m);
  assert.match(unitSection, /^Requires=docker\.service$/m);
  assert.match(unit, /^ExecStart=\/usr\/local\/bin\/node \/opt\/ci-kit\/gce\/vm\/job\.mjs$/m);
  assert.match(unit, /^WantedBy=multi-user\.target$/m);
});

// Pool M3, The boot: the image disables cloud-init, so the VM's own unit does what a job VM needed from it.
test('the job waits for the VM\'s own setup: its root grown to its disk and its hostname set to the instance name', () => {
  const job = readFileSync(new URL('../../gce/vm/ci-kit-gce-job.service', import.meta.url), 'utf8');
  assert.match(job, /^Requires=ci-kit-gce-instance\.service$/m);
  assert.match(job, /^After=.*\bci-kit-gce-instance\.service\b/m);
  const unit = readFileSync(new URL('../../gce/vm/ci-kit-gce-instance.service', import.meta.url), 'utf8');
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^ExecStart=\/opt\/ci-kit\/gce\/vm\/instance\.sh$/m);
  const script = readFileSync(new URL('../../gce/vm/instance.sh', import.meta.url), 'utf8');
  assert.match(script, /growpart/);
  assert.match(script, /resize2fs/);
  assert.match(script, /NOCHANGE/, 'a root that already fills its disk is not a failure');
  assert.match(script, /computeMetadata\/v1\/instance\/name/);
  assert.match(script, /hostnamectl set-hostname/);
});

// The console is a job VM's only window (no ssh), and journal lines reach it through rsyslog, which runs 20 s and more
// behind on a 115200-baud port and is cut off when the VM powers off: the VM's own units write to it directly.
test('the VM\'s setup and its job write to the serial console directly, the setup line stamped with the uptime', () => {
  for (const name of ['ci-kit-gce-instance.service', 'ci-kit-gce-job.service']) {
    const unit = readFileSync(new URL(`../../gce/vm/${name}`, import.meta.url), 'utf8');
    assert.match(unit, /^StandardOutput=journal\+console$/m, name);
    assert.match(unit, /^StandardError=journal\+console$/m, name);
  }
  const script = readFileSync(new URL('../../gce/vm/instance.sh', import.meta.url), 'utf8');
  assert.match(script, /\/proc\/uptime/);
});

test('the image boots without cloud-init: disabled, the builder\'s MAC-bound netplan replaced by one for any ethernet name', () => {
  const builder = readFileSync(new URL('../../gce/bake/builder.sh', import.meta.url), 'utf8');
  assert.match(builder, /^touch \/etc\/cloud\/cloud-init\.disabled$/m);
  assert.match(builder, /^rm -f \/etc\/netplan\/50-cloud-init\.yaml$/m);
  assert.match(builder, /match: \{name: "en\*"\}/);
  assert.match(builder, /^systemctl enable ci-kit-gce-job\.service ci-kit-gce-instance\.service$/m);
  assert.match(builder, /^: > \/etc\/hostname$/m);
  assert.match(builder, /^apt-get purge -y snapd$/m);
});

test('the smoke script checks infrastructure, Node and isolation, and prints one verdict', () => {
  const script = readFileSync(new URL('../../gce/vm/smoke.sh', import.meta.url), 'utf8');
  for (const check of ['cpus', 'user', 'isolation', 'runner', 'node22', 'node24', 'workdir', 'dns', 'egress', 'metadata-refused']) {
    assert.match(script, new RegExp(`^check ${check} `, 'm'), check);
  }
  assert.match(script, /^echo 'ci-kit smoke: ok'$/m);
});

test('the job container is told the VM it runs on, and only values its metadata can hold', () => {
  const args = jobRunArgs({ name: 'n', cpus: 4, placement: { machine: 'c3d-highcpu-4', provisioning: 'spot', zone: 'us-central1-a' } });
  for (const e of ['CI_KIT_MACHINE=c3d-highcpu-4', 'CI_KIT_PROVISIONING=spot', 'CI_KIT_ZONE=us-central1-a']) assert.ok(args.includes(e), e);
  assert.ok(!jobRunArgs({ name: 'n', cpus: 4 }).some((a) => /^CI_KIT_(MACHINE|PROVISIONING|ZONE)=/.test(a)));
  const odd = jobRunArgs({ name: 'n', cpus: 4, placement: { machine: 'c4d-highcpu-4', provisioning: 'x y', zone: undefined } });
  assert.ok(odd.includes('CI_KIT_MACHINE=c4d-highcpu-4'));
  assert.ok(!odd.some((a) => /^CI_KIT_(PROVISIONING|ZONE)=/.test(a)));
});

test('the job-started hook names the VM in the job log and its summary, and still runs without either', () => {
  const hook = new URL('../../pool/image/job-started.sh', import.meta.url).pathname;
  const summary = join(mkdtempSync(join(tmpdir(), 'ci-kit-hook-')), 'summary.md');
  const env = { PATH: process.env.PATH, RUNNER_NAME: 'ci-kit-gce-abc', CI_KIT_CORES: '0-3', CI_KIT_MACHINE: 'c3d-highcpu-4',
    CI_KIT_PROVISIONING: 'spot', CI_KIT_ZONE: 'us-central1-a', GITHUB_STEP_SUMMARY: summary };
  const line = execFileSync('bash', ['-e', hook], { env, encoding: 'utf8' });
  assert.match(line, /^ci-kit pool: runner ci-kit-gce-abc on c3d-highcpu-4 \(spot, us-central1-a\), cores 0-3 \(nproc \d+\)\n$/);
  assert.equal(readFileSync(summary, 'utf8'), line);
  // An older guest passes no placement, and a runner may give the hook no summary file.
  assert.match(execFileSync('bash', ['-e', hook], { env: { PATH: process.env.PATH }, encoding: 'utf8' }), /^ci-kit pool: runner \? on \? \(\?, \?\), cores \?/);
});

test('the job-started hook prints ? for the count and still succeeds when nproc fails or is absent', () => {
  const hook = new URL('../../pool/image/job-started.sh', import.meta.url).pathname;
  const bin = mkdtempSync(join(tmpdir(), 'ci-kit-hook-bin-'));
  for (const [name, body] of [['nproc', '#!/bin/sh\nexit 1\n']]) { writeFileSync(join(bin, name), body); chmodSync(join(bin, name), 0o755); }
  const bash = execFileSync('/bin/sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();
  assert.match(execFileSync(bash, ['-e', hook], { env: { PATH: bin }, encoding: 'utf8' }), /cores \? \(nproc \?\)\n$/); // nproc fails
  const empty = mkdtempSync(join(tmpdir(), 'ci-kit-hook-empty-'));
  assert.match(execFileSync(bash, ['-e', hook], { env: { PATH: empty }, encoding: 'utf8' }), /cores \? \(nproc \?\)\n$/); // no nproc at all
});
