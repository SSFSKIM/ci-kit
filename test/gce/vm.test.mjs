// The GCE job VM's unit (spec §3a Shape, VM lifecycle step 3): the job container it runs, the metadata block that
// keeps DNS, what it does with and without a JIT config, and how it reads the smoke check's verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jobRunArgs, vmMode, smokeVerdict, METADATA_BLOCK } from '../../gce/vm/run.mjs';
import { runArgs, CACHE } from '../../pool/agent/docker.mjs';

test('a GCE job container gets every vCPU, the same caches, hook and JIT passing as on the Hetzner box, and no memory cap', () => {
  const args = jobRunArgs({ name: 'ci-kit-gce-abc', cpus: 8 });
  const joined = args.join(' ');
  assert.equal(args[0], 'run');
  assert.doesNotMatch(joined, /--cpuset-cpus|--memory|--detach|docker\.sock|\/etc\/ci-kit|--privileged/);
  assert.ok(args.includes('CI_KIT_CORES=0-7'));
  assert.match(joined, /--name ci-kit-gce-abc /);
  assert.match(joined, new RegExp(`-v ${CACHE}:${CACHE} `));
  assert.match(joined, /-e CI_KIT_JIT /);
  assert.ok(!args.some((a) => a.startsWith('CI_KIT_JIT=')));
  // Everything the Hetzner container gets from its environment, the GCE one gets too.
  const hetzner = runArgs({ name: 'n', repo: 'o/r', runnerId: 1, labels: ['cpus-8'], cores: [0, 1, 2, 3, 4, 5, 6, 7], memoryGbPerCpu: 2 });
  for (const a of hetzner.filter((x) => /^[A-Za-z_]+=/.test(x) && !x.startsWith('CI_KIT_CORES='))) assert.ok(args.includes(a), a);
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

test('the smoke script checks the image, the caches and the isolation, and prints one verdict', () => {
  const script = readFileSync(new URL('../../gce/vm/smoke.sh', import.meta.url), 'utf8');
  for (const check of ['cpus', 'user', 'isolation', 'runner', 'node22', 'node24', 'warm', 'pnpm-store', 'workdir', 'dns', 'egress', 'metadata-refused']) {
    assert.match(script, new RegExp(`^check ${check} `, 'm'), check);
  }
  assert.match(script, /^echo 'ci-kit smoke: ok'$/m);
});

// MAWS's jobs used to apt-install these at job time (~35 s on the critical path, and a Launchpad 503 failed a shard):
// the job image carries them, and the smoke check proves it before an image is marked ready.
test('the job image carries zsh and the CJK, Inter and JetBrains Mono fonts, and the smoke check proves it', () => {
  const docker = readFileSync(new URL('../../pool/image/Dockerfile', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../../gce/vm/smoke.sh', import.meta.url), 'utf8');
  for (const pkg of ['zsh', 'fonts-noto-cjk', 'fonts-inter', 'fonts-jetbrains-mono']) assert.match(docker, new RegExp(`\\s${pkg}(\\s|$)`), pkg);
  assert.match(script, /^check zsh zsh --version$/m);
  assert.match(script, /^check fonts dpkg -s fonts-noto-cjk fonts-inter fonts-jetbrains-mono$/m);
});
