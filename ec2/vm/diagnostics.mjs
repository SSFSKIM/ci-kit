// Shared log rendering for the guest and bake reader. S3 report fields are data, not trusted error text.
// This free text belongs only in the access-controlled report, never in controller logs.
// Keep complete diagnostic lines within both the byte and line limits.
export function boundCompactLogTail(value) {
  if (typeof value !== 'string') return '';
  let bytes = Buffer.from(value);
  if (bytes.length > 8192) {
    let start = bytes.length - 8192;
    if (bytes[start - 1] !== 10) {
      const newline = bytes.indexOf(10, start);
      if (newline === -1) return '';
      start = newline + 1;
    }
    bytes = bytes.subarray(start);
  }
  const text = bytes.toString('utf8');
  return text.split('\n').slice(text.endsWith('\n') ? -41 : -40).join('\n');
}
const manifest = '/etc/ci-kit/bake-manifest.json';
const pathsByReason = new Map([
  ['manifest-missing', [manifest]],
  ['manifest-invalid', [manifest]],
  ['manifest-incomplete', [manifest]],
  ['cloud-init-marker-missing', ['/etc/cloud/cloud-init.disabled']],
  ['cloud-init-identity', ['/var/lib/cloud/instance']],
  ['cloud-init-state', ['/var/lib/cloud/instances', '/var/lib/cloud/data', '/var/lib/cloud/seed']],
  ['cloud-init-log', ['/var/log']],
  ['credential-artifact', ['/root/.aws', '/root/.config/gcloud', '/root/.git-credentials', '/root/.netrc']],
  ['temporary-artifact', ['/tmp']],
]);
pathsByReason.set('filesystem', [...new Set([...pathsByReason.values()].flat())]);
const codesByReason = new Map([
  ['manifest-missing', new Set(['ENOENT'])],
  ['filesystem', new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'EIO', 'ELOOP', 'EMFILE', 'ENFILE'])],
]);

const compactPhases = new Set(['compact', 'disk-validation', 'boot-copy', 'copy-root-setup', 'source-inventory',
  'root-copy', 'root-recovery', 'target-inventory', 'root-comparison', 'root-fsck', 'copy-root-cleanup', 'disk-verification']);
const compactBounds = new Map([['source-inventory', 300], ['root-copy', 480], ['target-inventory', 300]]);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const timing = value => record(value) && Number.isInteger(value.elapsed_seconds) && value.elapsed_seconds >= 0 && value.elapsed_seconds <= 86400
  && Number.isInteger(value.exit_status) && value.exit_status >= 0 && value.exit_status <= 255;

// A finite set of numeric records, including successful phases. Unknown input properties never serialize.
export function formatCompactTrace(value) {
  const unexpected = '{"reason":"unexpected"}';
  if (!timing(value) || !record(value.phases)) return unexpected;
  const phases = {};
  for (const phase of compactPhases) {
    if (phase === 'compact' || !Object.hasOwn(value.phases, phase)) continue;
    const entry = value.phases[phase], bound = compactBounds.get(phase);
    if (!timing(entry) || (entry.bound_seconds !== undefined && entry.bound_seconds !== bound)) return unexpected;
    phases[phase] = { elapsed_seconds: entry.elapsed_seconds, exit_status: entry.exit_status,
      ...(bound !== undefined ? { bound_seconds: bound } : {}) };
  }
  return JSON.stringify({ elapsed_seconds: value.elapsed_seconds, exit_status: value.exit_status, phases });
}

// Only structured fields enter logs. logLocation comes from the controller, never from report data.
export function formatDiagnostic(value, { logLocation } = {}) {
  const unexpected = '{"reason":"unexpected"}';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unexpected;
  if (value.reason === 'compact-failed') {
    if (!compactPhases.has(value.phase) || !Number.isInteger(value.exit_status) || value.exit_status < 1 || value.exit_status > 255) return unexpected;
    const tail = logLocation ? boundCompactLogTail(value.log_tail) : '';
    const lines = tail ? tail.split('\n').length - Number(tail.endsWith('\n')) : 0;
    return JSON.stringify({ reason: 'compact-failed', phase: value.phase, exit_status: value.exit_status,
      ...(lines ? { log_tail: `${logLocation} (${lines} ${lines === 1 ? 'line' : 'lines'})` } : {}) });
  }
  if (!pathsByReason.get(value.reason)?.includes(value.path)) return unexpected;
  if (value.code !== undefined && !codesByReason.get(value.reason)?.has(value.code)) return unexpected;
  return JSON.stringify({ reason: value.reason, path: value.path, ...(value.code !== undefined ? { code: value.code } : {}) });
}
