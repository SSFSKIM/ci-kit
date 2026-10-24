// Shared log rendering for the guest and bake reader. S3 report fields are data, not trusted error text.
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

// The finite vocabulary bounds the output. Never stringify the original object, including its extra fields.
export function formatDiagnostic(value) {
  const unexpected = '{"reason":"unexpected"}';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unexpected;
  if (!pathsByReason.get(value.reason)?.includes(value.path)) return unexpected;
  if (value.code !== undefined && !codesByReason.get(value.reason)?.has(value.code)) return unexpected;
  return JSON.stringify({ reason: value.reason, path: value.path, ...(value.code !== undefined ? { code: value.code } : {}) });
}
