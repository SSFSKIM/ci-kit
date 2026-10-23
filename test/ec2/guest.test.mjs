import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGuest, imdsClient, armDeadline, putReport, finalizeGuest } from '../../ec2/vm/job.mjs';
import * as guest from '../../ec2/vm/job.mjs';
import { prepareContainer, runContainer } from '../../pool/vm/container.mjs';
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const data = () => ({ v: 1, alloc: 'abc123', jit: 'secret-jit', deadline: '2026-10-24T02:00:00Z',
  report: { boot: 'https://s3.example/boot?signature=secret', notice: 'https://s3.example/notice', exit: 'https://s3.example/exit' } });
function fixture(overrides = {}) {
  const calls = [], reports = [];
  let notice;
  const deps = {
    readUserData: async () => JSON.stringify(data()),
    now: () => new Date('2026-10-24T01:00:00Z'),
    saveState: async state => calls.push(['state', state]),
    armDeadline: async deadline => calls.push(['deadline', deadline]),
    prepareContainer: async name => calls.push(['prepare', name]),
    checkImage: async () => calls.push(['image']),
    runContainer: async options => { calls.push(['run', options]); await options.onStarted(); return { code: 0, out: '' }; },
    watchNotice: callback => { notice = callback; return () => calls.push(['unwatch']); },
    putReport: async (url, report) => { reports.push({ url, ...report }); },
    poweroff: async () => calls.push(['poweroff']),
    log: text => calls.push(['log', text]),
    ...overrides,
  };
  return { deps, calls, reports, notice: (...args) => notice(...args) };
}

test('a guest arms its host deadline before starting and reports terminal exit then powers off', async () => {
  const f = fixture();
  await runGuest(f.deps);
  assert.deepEqual(f.calls.filter(([op]) => ['deadline', 'prepare', 'poweroff'].includes(op)), [
    ['deadline', data().deadline], ['prepare', 'ci-kit-ec2-abc123'], ['poweroff'],
  ]);
  const opts = f.calls.find(([op]) => op === 'run')[1];
  assert.equal(opts.jit, 'secret-jit');
  assert.equal(opts.name, 'ci-kit-ec2-abc123');
  assert.deepEqual(f.reports.map(r => [r.event, r.kind, r.value]), [
    ['boot', 'telemetry', undefined], ['exit', 'terminal', 'exit:0'],
  ]);
  assert.equal(f.reports[1].timings.container_exit, '2026-10-24T01:00:00.000Z');
  assert.ok(f.calls.filter(([op]) => op === 'state').every(([, state]) => !JSON.stringify(state).includes('secret-jit')));
});

test('an interruption notice uploads telemetry without stopping or retiring the running container', async () => {
  let finish;
  const running = new Promise(resolve => { finish = resolve; });
  const f = fixture({ runContainer: async options => { await options.onStarted(); await f.notice({ action: 'terminate', time: '2026-10-24T01:02:00Z' }); return running; } });
  const job = runGuest(f.deps);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.reports.map(r => r.kind), ['telemetry', 'telemetry']);
  assert.deepEqual(f.reports[1].notice, { action: 'terminate', time: '2026-10-24T01:02:00Z' });
  assert.ok(!f.calls.some(([op]) => op === 'poweroff'));
  finish({ code: 137, out: '' });
  await job;
  assert.equal(f.reports.at(-1).value, 'exit:137');
  assert.equal(f.calls.at(-1)[0], 'poweroff');
});

for (const [dependency, stage] of [['armDeadline', 'deadline'], ['prepareContainer', 'prepare'], ['runContainer', 'container']]) {
  test(`${dependency} failure reports failed:${stage} and powers off without leaking the error's secrets`, async () => {
    const f = fixture({ [dependency]: async () => { throw new Error('secret-jit'); } });
    await runGuest(f.deps);
    assert.equal(f.reports.at(-1).value, `failed:${stage}`);
    assert.equal(f.reports.at(-1).kind, 'terminal');
    assert.equal(f.calls.at(-1)[0], 'poweroff');
    assert.ok(!JSON.stringify(f.reports).includes('secret-jit'));
    assert.ok(!JSON.stringify(f.calls.filter(([op]) => op === 'log')).includes('secret-jit'));
  });
}

test('invalid launch input with a usable exit URL reports failure; unreadable metadata still powers off', async () => {
  const f = fixture({ readUserData: async () => JSON.stringify({ ...data(), jit: '', deadline: 'not-a-date' }) });
  await runGuest(f.deps);
  assert.equal(f.reports.at(-1).value, 'failed:userdata');
  assert.ok(!f.calls.some(([op]) => op === 'run'));
  assert.equal(f.calls.at(-1)[0], 'poweroff');
  const missing = fixture({ readUserData: async () => { throw new Error('offline'); } });
  await runGuest(missing.deps);
  assert.equal(missing.calls.at(-1)[0], 'poweroff');
});

test('an already expired deadline never starts a container and reports failed:deadline', async () => {
  const f = fixture({ now: () => new Date('2026-10-24T03:00:00Z') });
  await runGuest(f.deps);
  assert.equal(f.reports.at(-1).value, 'failed:deadline');
  assert.ok(!f.calls.some(([op]) => op === 'run'));
});

test('report transport failures cannot skip poweroff or hide the terminal attempt', async () => {
  const attempted = [];
  const f = fixture({ putReport: async (url, report) => { attempted.push(report); throw new Error(url); } });
  await runGuest(f.deps);
  assert.deepEqual(attempted.map(r => r.event), ['boot', 'exit']);
  assert.equal(attempted.at(-1).value, 'exit:0');
  assert.equal(f.calls.at(-1)[0], 'poweroff');
  assert.ok(!JSON.stringify(f.calls.filter(([op]) => op === 'log')).includes('signature'));
});

test('smoke uses the identical container path and reports its verdict only in the terminal object', async () => {
  const f = fixture({ readUserData: async () => JSON.stringify({ ...data(), jit: undefined, smoke: 2 }),
    runContainer: async options => { assert.deepEqual(options.smoke, { expectCpus: 2 }); await options.onStarted(); return { code: 0, out: 'ci-kit smoke: ok\n' }; } });
  await runGuest(f.deps);
  assert.equal(f.reports.at(-1).smoke, 'ok');
  assert.equal(f.reports.at(-1).value, 'exit:0');
});

test('IMDS reads require a session token, renew on 401, and treat a notice 404 as absence', async () => {
  const calls = [];
  const responses = [new Response('token-one'), new Response('expired', { status: 401 }), new Response('token-two'), new Response(JSON.stringify(data())), new Response('', { status: 404 })];
  const md = imdsClient({ fetch: async (url, options) => { calls.push({ url, ...options }); return responses.shift(); } });
  assert.equal(await md.read('user-data'), JSON.stringify(data()));
  assert.equal(await md.read('meta-data/spot/instance-action'), null);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].headers['X-aws-ec2-metadata-token-ttl-seconds'], '21600');
  assert.equal(calls[1].headers['X-aws-ec2-metadata-token'], 'token-one');
  assert.equal(calls[3].headers['X-aws-ec2-metadata-token'], 'token-two');
  assert.equal(calls[4].headers['X-aws-ec2-metadata-token'], 'token-two');
});

test('deadline is a host systemd timer independent of the runner process', async () => {
  const calls = [];
  await armDeadline(data().deadline, async (...args) => calls.push(args));
  assert.equal(calls[0][0], 'systemd-run');
  assert.ok(calls[0][1].includes('--on-calendar=2026-10-24 02:00:00 UTC'));
  assert.ok(calls[0][1].includes('--timer-property=AccuracySec=1s'));
  assert.deepEqual(calls[0][1].slice(-3), ['/usr/local/bin/node', '/opt/ci-kit/ec2/vm/job.mjs', '--deadline']);
});

test('S3 reports use bounded JSON PUT and fail on HTTP errors without echoing signed URLs', async () => {
  const calls = [];
  await putReport(data().report.exit, { kind: 'terminal', value: 'exit:0' }, async (...args) => { calls.push(args); return new Response(); });
  assert.equal(calls[0][1].method, 'PUT');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0][1].body), { kind: 'terminal', value: 'exit:0' });
  assert.ok(calls[0][1].signal instanceof AbortSignal);
  await assert.rejects(putReport(data().report.exit, {}, async () => new Response('', { status: 403 })), /HTTP 403/);
});

test('EC2 preparation denies IPv4 and IPv6 metadata before making a runner-owned work directory', async () => {
  const calls = [];
  await prepareContainer('ci-kit-ec2-abc123', {
    blockIpv6: true,
    exec: async (cmd, args) => { calls.push([cmd, ...args]); if (args[0] === '-C') throw new Error('absent'); },
    makeDir: async (...args) => calls.push(['mkdir', ...args]), own: async (...args) => calls.push(['chown', ...args]),
  });
  assert.ok(calls.some(c => c[0] === 'iptables' && c[1] === '-I' && c.includes('169.254.169.254/32')));
  assert.ok(calls.some(c => c[0] === 'ip6tables' && c[1] === '-I' && c.includes('fd00:ec2::254/128') && c.includes('DROP')));
  assert.deepEqual(calls.at(-1), ['chown', '/var/lib/ci-kit/cache/work/ci-kit-ec2-abc123', 1001, 1001]);
});

test('an iptables failure fails closed before preparing a workdir or running a job', async () => {
  let made = false;
  await assert.rejects(prepareContainer('test', { exec: async () => { throw new Error('firewall unavailable'); },
    makeDir: async () => { made = true; } }), /firewall unavailable/);
  assert.equal(made, false);
});

async function imageFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ci-kit-guest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'etc/ci-kit'), { recursive: true });
  await mkdir(join(root, 'etc/cloud'), { recursive: true });
  await mkdir(join(root, 'var/lib/cloud/instances'), { recursive: true });
  await writeFile(join(root, 'etc/cloud/cloud-init.disabled'), '');
  const manifest = { v: 1, kit_commit: 'abc', node: { 22: 'v22.23.0', 24: 'v24.10.0' },
    maws: { revision: 'def', lock_sha256: '123' }, runner_version: '2.338.0', warm: { install: { ok: true } } };
  await writeFile(join(root, 'etc/ci-kit/bake-manifest.json'), JSON.stringify(manifest));
  return root;
}

test('host smoke rejects stale cloud-init identity or credentials without exposing host files to the job', async t => {
  const root = await imageFixture(t);
  await guest.checkImage(root);
  await mkdir(join(root, 'var/lib/cloud/instances/i-builder'));
  await writeFile(join(root, 'var/lib/cloud/instances/i-builder/user-data.txt'), 'secret-token');
  await assert.rejects(guest.checkImage(root), /cloud-init/);
  await rm(join(root, 'var/lib/cloud/instances/i-builder'), { recursive: true });
  await mkdir(join(root, 'root/.aws'), { recursive: true });
  await writeFile(join(root, 'root/.aws/credentials'), 'secret');
  await assert.rejects(guest.checkImage(root), /credential/);
  await rm(join(root, 'root/.aws'), { recursive: true });
  await writeFile(join(root, 'etc/ci-kit/bake-manifest.json'), '{}');
  await assert.rejects(guest.checkImage(root), /manifest/);
});

test('host smoke rejects each retained builder state, log, credential and temporary artifact', async t => {
  const artifacts = [
    ['var/lib/cloud/instance', 'cloud-init', 'symlink'],
    ['var/lib/cloud/instances/i-builder/user-data.txt', 'cloud-init'],
    ['var/lib/cloud/data/instance-id', 'cloud-init'],
    ['var/lib/cloud/data/previous-instance-id', 'cloud-init'],
    ['var/lib/cloud/data/status.json', 'cloud-init'],
    ['var/lib/cloud/seed/nocloud/user-data', 'cloud-init'],
    ['var/log/cloud-init.log', 'cloud-init'],
    ['var/log/cloud-init-output.log', 'cloud-init'],
    ['var/log/cloud-init.log.1.gz', 'cloud-init'],
    ['var/log/cloud-init-output.log.1', 'cloud-init'],
    ['root/.aws/credentials', 'credential'],
    ['root/.config/gcloud/access_tokens.db', 'credential'],
    ['root/.git-credentials', 'credential', 'empty'],
    ['root/.netrc', 'credential', 'empty'],
    ['tmp/ci-kit-warm-builder/.git/config', 'temporary'],
    ['tmp/ci-kit-electron-builder/auth.json', 'temporary'],
    ['tmp/ci-kit-warm-token', 'temporary'],
    ['tmp/ci-kit-electron-token', 'temporary', 'symlink'],
  ];
  for (const [artifact, category, type] of artifacts) {
    await t.test(artifact, async t => {
      const root = await imageFixture(t);
      const target = join(root, artifact);
      await mkdir(dirname(target), { recursive: true });
      if (type === 'symlink') await symlink('/nonexistent-builder-state', target);
      else await writeFile(target, type === 'empty' ? '' : 'secret-builder-residue');
      await assert.rejects(guest.checkImage(root), error => {
        assert.match(error.message, new RegExp(category));
        assert.ok(!error.message.includes('secret-builder-residue'));
        return true;
      });
    });
  }
});

test('host smoke permits fresh guest identity, runtime state and unrelated logs or temporary files', async t => {
  const root = await imageFixture(t);
  for (const file of ['etc/machine-id', 'etc/hostname', 'etc/ssh/ssh_host_ed25519_key',
    'run/ci-kit-ec2/state.json', 'run/cloud-init/cloud-init-generator.log', 'var/log/syslog', 'tmp/current-guest']) {
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, 'new-guest-state');
  }
  await guest.checkImage(root);
});

test('deadline and killed-unit finalizers report terminal failure and power off even when PUT fails', async () => {
  for (const reason of ['deadline', 'unit']) {
    const f = fixture({ loadState: async () => ({ alloc: 'abc123', report: data().report, timings: { guest_start: 'start' } }) });
    await finalizeGuest(reason, f.deps);
    assert.equal(f.reports.at(-1).value, `failed:${reason}`);
    assert.equal(f.reports.at(-1).kind, 'terminal');
    assert.equal(f.calls.at(-1)[0], 'poweroff');
  }
  const f = fixture({ loadState: async () => { throw new Error('no state'); },
    putReport: async () => { throw new Error('offline'); } });
  await finalizeGuest('unit', f.deps);
  assert.equal(f.calls.at(-1)[0], 'poweroff');
});

test('ExecStopPost never overwrites a completed exit with failed:unit and retries an unsent terminal unchanged', async () => {
  const state = { alloc: 'abc123', report: data().report, reported: true,
    terminal: { kind: 'terminal', event: 'exit', value: 'exit:0', at: 'finished', timings: {} } };
  const f = fixture({ loadState: async () => state });
  await finalizeGuest('unit', f.deps);
  assert.deepEqual(f.reports, []);
  state.reported = false;
  await finalizeGuest('unit', f.deps);
  assert.equal(f.reports.at(-1).value, 'exit:0');
  assert.equal(f.reports.at(-1).at, 'finished');
});

test('stopping a notice watcher cannot prevent the terminal report', async () => {
  const f = fixture({ watchNotice: () => async () => { throw new Error('watcher failed'); } });
  await runGuest(f.deps);
  assert.equal(f.reports.at(-1).value, 'exit:0');
  assert.equal(f.calls.at(-1)[0], 'poweroff');
});

test('the real Docker CLI boundary keeps JIT out of arguments and waits for the container exit', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ci-kit-docker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tool = join(dir, 'docker');
  await writeFile(tool, `#!/bin/sh
case "$1" in
run)
  [ "$CI_KIT_JIT" = secret-jit ] || exit 90
  case "$*" in *secret-jit*|*docker.sock*|*--privileged*|*'--user root'*) exit 91;; esac
  case "$*" in *'-e CI_KIT_JIT '*) :;; *) exit 92;; esac
  echo container-id;;
logs) echo 'ci-kit smoke: ok';;
wait) echo 7;;
*) exit 93;;
esac
`);
  await chmod(tool, 0o755);
  const old = process.env.PATH;
  process.env.PATH = `${dir}:${old}`;
  t.after(() => { process.env.PATH = old; });
  let started = false;
  const result = await runContainer({ name: 'ci-kit-ec2-test', cpus: 2, jit: 'secret-jit', smoke: { expectCpus: 2 }, onStarted: async () => { started = true; } });
  assert.equal(started, true);
  assert.equal(result.code, 7);
  assert.equal(result.out, 'ci-kit smoke: ok\n');
});

test('common smoke rejects reachable IPv4 metadata, IMDSv2 token endpoints, and IPv6 metadata', async t => {
  const { readFile } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), 'ci-kit-smoke-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const smoke = await readFile(new URL('../../gce/vm/smoke.sh', import.meta.url), 'utf8');
  // Execute the real smoke helper, stopping before image-specific checks require the baked filesystem.
  const script = join(dir, 'probe.sh');
  await writeFile(script, smoke.slice(0, smoke.indexOf('\ncheck cpus ')) + '\nmetadata_refused\n');
  await writeFile(join(dir, 'curl'), `#!/bin/sh
for arg in "$@"; do
  [ "$arg" != "$REACHABLE" ] || exit 0
done
exit 7
`);
  await chmod(join(dir, 'curl'), 0o755);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, REACHABLE: 'none' };
  await exec('bash', [script], { env });
  for (const address of ['http://169.254.169.254/', 'http://169.254.169.254/latest/api/token', 'http://[fd00:ec2::254]/']) {
    await assert.rejects(exec('bash', [script], { env: { ...env, REACHABLE: address } }), address);
  }
});

test('a deadline crossed while systemd arms the timer cannot leave a job running with a past calendar event', async () => {
  let now = new Date('2026-10-24T01:59:59Z');
  const f = fixture({ now: () => now, armDeadline: async () => { now = new Date('2026-10-24T02:00:01Z'); } });
  await runGuest(f.deps);
  assert.equal(f.reports.at(-1).value, 'failed:deadline');
  assert.ok(!f.calls.some(([op]) => op === 'run'));
});
