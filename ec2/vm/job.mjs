#!/usr/bin/env node
// EC2's host-only lifecycle. User-data is JSON, not executable; neither JIT nor signed URLs reach logs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename, mkdir, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareContainer, runContainer } from '../../pool/vm/container.mjs';
import { smokeVerdict } from '../../pool/vm/run.mjs';
import { formatDiagnostic } from './diagnostics.mjs';
import { verifyRepoResults } from '../../pool/bake/manifest.mjs';
import { smokeJobImages } from '../../pool/bake/job-images.mjs';

const sh = promisify(execFile);
const STATE = '/run/ci-kit-ec2/state.json';
const log = message => console.log(`ci-kit ec2: ${message}`);
const stamp = deps => deps.now().toISOString();
const usableUrl = value => {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
};

export function imdsClient({ fetch: request = globalThis.fetch } = {}) {
  let token;
  async function read(path) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!token) {
        const res = await request('http://169.254.169.254/latest/api/token', {
          method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' }, signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`IMDS token HTTP ${res.status}`);
        token = await res.text();
      }
      const res = await request(`http://169.254.169.254/latest/${path}`, {
        headers: { 'X-aws-ec2-metadata-token': token }, signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401) { token = undefined; continue; }
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`IMDS HTTP ${res.status}`);
      return res.text();
    }
    throw new Error('IMDS token rejected');
  }
  return { read };
}

export async function putReport(url, report, request = globalThis.fetch) {
  const res = await request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(report), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`report HTTP ${res.status}`);
}

export async function armDeadline(deadline, exec = sh) {
  const calendar = new Date(deadline).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  await exec('systemd-run', ['--unit=ci-kit-ec2-deadline', `--on-calendar=${calendar}`,
    '--timer-property=AccuracySec=1s', '--property=Type=exec', '--property=RuntimeMaxSec=30s',
    '--property=SuccessAction=poweroff-immediate', '--property=FailureAction=poweroff-immediate',
    '/usr/local/bin/node', '/opt/ci-kit/ec2/vm/job.mjs', '--deadline'], { timeout: 10_000 });
}

export function watchNotice(md, callback, { intervalMs = 5_000, log: logger = log } = {}) {
  let stopped = false, last, active = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped) return;
    stopped = true; // At most one bounded IMDS request / PUT at a time.
    active = (async () => {
      try {
        const raw = await md.read('meta-data/spot/instance-action');
        if (raw && raw !== last) { await callback(JSON.parse(raw)); last = raw; }
      } catch { logger('notice poll failed'); }
    })().finally(() => { stopped = false; });
  }, intervalMs);
  return async () => { clearInterval(timer); await active; };
}

function validate(data) {
  if (data?.v !== 1 || !/^[a-zA-Z0-9-]{1,80}$/.test(data.alloc ?? '') ||
      typeof data.deadline !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(data.deadline) ||
      !Number.isFinite(Date.parse(data.deadline)) ||
      !['boot', 'notice', 'exit'].every(key => usableUrl(data.report?.[key]))) throw new Error('invalid user-data');
  const job = typeof data.jit === 'string' && data.jit.length > 0;
  const smoke = Number.isInteger(data.smoke) && data.smoke > 0;
  if (job === smoke) throw new Error('expected one guest mode');
}

async function upload(deps, state, event, fields = {}) {
  const report = { kind: event === 'exit' ? 'terminal' : 'telemetry', alloc: state.alloc,
    event, at: stamp(deps), timings: { ...state.timings }, ...fields };
  if (event === 'exit') {
    state.terminal = report;
    try { await deps.saveState(state); } catch { deps.log('terminal state write failed'); }
  }
  if (usableUrl(state.report?.[event])) {
    try {
      await deps.putReport(state.report[event], report);
      if (event === 'exit') {
        state.reported = true;
        try { await deps.saveState(state); } catch { deps.log('report receipt state write failed'); }
      }
    } catch { deps.log(`${event} report upload failed`); }
  } else deps.log(`${event} report URL unavailable`);
}

export async function runGuest(deps) {
  let stage = 'userdata', state = { timings: { guest_start: stamp(deps) } }, stopNotice;
  let value, smoke, diagnostic;
  try {
    const raw = await deps.readUserData();
    const data = JSON.parse(raw);
    // Preserve only report routing in host-only tmpfs; never persist the JIT configuration.
    state = { ...state, alloc: data?.alloc, report: data?.report, deadline: data?.deadline };
    validate(data);
    await deps.saveState(state);
    stage = 'deadline';
    if (Date.parse(data.deadline) <= deps.now().getTime()) throw new Error('deadline elapsed');
    await deps.armDeadline(data.deadline);
    // An absolute calendar event that passed while systemd was starting must not become a timer that never fires.
    if (Date.parse(data.deadline) <= deps.now().getTime()) throw new Error('deadline elapsed');
    stage = 'prepare';
    await deps.prepareContainer(`ci-kit-ec2-${data.alloc}`);
    if (data.smoke) {
      stage = 'image';
      await deps.checkImage();
    }
    stopNotice = deps.watchNotice(notice => upload(deps, state, 'notice', { notice }));
    stage = 'container';
    const result = await deps.runContainer({ name: `ci-kit-ec2-${data.alloc}`, repo: data.repo, jit: data.jit, log: deps.log,
      ...(data.smoke ? { smoke: { expectCpus: data.smoke } } : {}),
      onStarted: async () => {
        state.timings.container_start = stamp(deps);
        await deps.saveState(state);
        await upload(deps, state, 'boot');
      },
    });
    state.timings.container_exit = stamp(deps);
    value = `exit:${result.code}`;
    if (data.smoke) smoke = smokeVerdict(result.out, result.code);
  } catch (error) {
    value = `failed:${stage}`;
    diagnostic = error instanceof ImageCheckError ? error.diagnostic : { reason: 'unexpected' };
    deps.log(`${value} ${formatDiagnostic(diagnostic)}`);
  } finally {
    try {
      try { await stopNotice?.(); } catch { deps.log('notice watcher stop failed'); }
      state.timings.guest_end = stamp(deps);
      await upload(deps, state, 'exit', { value, ...(smoke ? { smoke } : {}), ...(diagnostic ? { diagnostic } : {}) });
    } finally { await deps.poweroff(); }
  }
}

// Also invoked by the independent deadline timer and ExecStopPost after a crashed/killed main process.
export async function finalizeGuest(reason, deps) {
  try {
    let state;
    try { state = await deps.loadState(); }
    catch {
      const data = JSON.parse(await deps.readUserData());
      state = { alloc: data.alloc, report: data.report, timings: {} };
    }
    if (!state.reported) {
      if (state.terminal) {
        try { await deps.putReport(state.report.exit, state.terminal); } catch { deps.log('exit report upload failed'); }
      } else await upload(deps, state, 'exit', { value: `failed:${reason}` });
    }
  } catch { deps.log('failure report unavailable'); }
  finally { await deps.poweroff(); }
}

// Only this private type crosses into guest diagnostics. Its reason and path come from fixed checks,
// never Error.message, manifest contents, discovered filenames, or subprocess output.
class ImageCheckError extends Error {
  constructor(reason, path, code) {
    super(reason);
    this.diagnostic = Object.freeze({ reason, path: `/${path}`, ...(code ? { code } : {}) });
  }
}
const filesystemCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'EIO', 'ELOOP', 'EMFILE', 'ENFILE']);
const imageFilesystemError = (name, error) => new ImageCheckError(
  name === 'etc/ci-kit/bake-manifest.json' && error.code === 'ENOENT' ? 'manifest-missing' : 'filesystem',
  name, filesystemCodes.has(error.code) ? error.code : undefined,
);

// Host-only smoke: never mount these files into the untrusted runner container.
export async function checkImage(root = '/') {
  const path = name => join(root, name);
  const exists = async name => {
    try { await lstat(path(name)); return true; }
    catch (err) { if (err.code === 'ENOENT') return false; throw imageFilesystemError(name, err); }
  };
  const read = async (name, operation) => {
    try { return await operation(path(name)); }
    catch (err) { throw imageFilesystemError(name, err); }
  };
  const manifestPath = 'etc/ci-kit/bake-manifest.json';
  const raw = await read(manifestPath, file => readFile(file, 'utf8'));
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch { throw new ImageCheckError('manifest-invalid', manifestPath); }
  if (manifest?.v !== 1 || !manifest.kit_commit || !manifest.node?.[22] || !manifest.node?.[24] ||
      !manifest.runner_version) {
    throw new ImageCheckError('manifest-incomplete', manifestPath);
  }
  try { verifyRepoResults(manifest.repos); }
  catch { throw new ImageCheckError('manifest-incomplete', manifestPath); }
  if (!await exists('etc/cloud/cloud-init.disabled')) throw new ImageCheckError('cloud-init-marker-missing', 'etc/cloud/cloud-init.disabled');
  if (await exists('var/lib/cloud/instance')) throw new ImageCheckError('cloud-init-identity', 'var/lib/cloud/instance');
  // Cloud-init is disabled on these images: persisted state is from the builder, not this guest's boot.
  // Empty container directories are harmless; current generator/job state lives separately under /run.
  for (const name of ['var/lib/cloud/instances', 'var/lib/cloud/data', 'var/lib/cloud/seed']) {
    if (await exists(name) && (await read(name, readdir)).length) throw new ImageCheckError('cloud-init-state', name);
  }
  for (const name of ['root/.aws', 'root/.config/gcloud', 'root/.git-credentials', 'root/.netrc']) {
    if (await exists(name)) throw new ImageCheckError('credential-artifact', name);
  }
  for (const [directory, pattern, reason] of [
    ['var/log', /^cloud-init(?:-output)?\.log(?:\..+)?$/, 'cloud-init-log'],
    ['tmp', /^ci-kit-(?:warm|electron)-/, 'temporary-artifact'],
  ]) {
    if (await exists(directory) && (await read(directory, readdir)).some(name => pattern.test(name))) {
      throw new ImageCheckError(reason, directory);
    }
  }
}

function runtime() {
  const md = imdsClient();
  return {
    now: () => new Date(), log,
    readUserData: () => md.read('user-data'), putReport, armDeadline, runContainer,
    checkImage: async () => { await checkImage(); await smokeJobImages(); },
    prepareContainer: name => prepareContainer(name, { blockIpv6: true }),
    watchNotice: callback => watchNotice(md, callback),
    saveState: async state => {
      await mkdir('/run/ci-kit-ec2', { recursive: true, mode: 0o700 });
      const temporary = `${STATE}.${process.pid}`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, STATE);
    },
    loadState: async () => JSON.parse(await readFile(STATE, 'utf8')),
    poweroff: () => sh('systemctl', ['--force', '--force', 'poweroff'], { timeout: 10_000 }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deps = runtime();
  const mode = process.argv[2];
  (mode === '--deadline' || mode === '--finalize' ? finalizeGuest(mode === '--deadline' ? 'deadline' : 'unit', deps) : runGuest(deps))
    .catch(() => { log('guest unit failed'); process.exitCode = 1; });
}
