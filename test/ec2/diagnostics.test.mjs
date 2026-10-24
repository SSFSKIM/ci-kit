import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDiagnostic } from '../../ec2/vm/diagnostics.mjs';

test('serialized image diagnostics retain known reasons, fixed paths and filesystem codes', () => {
  const cases = [
    [{ reason: 'manifest-missing', path: '/etc/ci-kit/bake-manifest.json', code: 'ENOENT' }, '{"reason":"manifest-missing","path":"/etc/ci-kit/bake-manifest.json","code":"ENOENT"}'],
    [{ reason: 'manifest-invalid', path: '/etc/ci-kit/bake-manifest.json' }, '{"reason":"manifest-invalid","path":"/etc/ci-kit/bake-manifest.json"}'],
    [{ reason: 'manifest-incomplete', path: '/etc/ci-kit/bake-manifest.json' }, '{"reason":"manifest-incomplete","path":"/etc/ci-kit/bake-manifest.json"}'],
    [{ reason: 'cloud-init-marker-missing', path: '/etc/cloud/cloud-init.disabled' }, '{"reason":"cloud-init-marker-missing","path":"/etc/cloud/cloud-init.disabled"}'],
    [{ reason: 'cloud-init-identity', path: '/var/lib/cloud/instance' }, '{"reason":"cloud-init-identity","path":"/var/lib/cloud/instance"}'],
    [{ reason: 'cloud-init-state', path: '/var/lib/cloud/seed' }, '{"reason":"cloud-init-state","path":"/var/lib/cloud/seed"}'],
    [{ reason: 'cloud-init-log', path: '/var/log' }, '{"reason":"cloud-init-log","path":"/var/log"}'],
    [{ reason: 'credential-artifact', path: '/root/.netrc' }, '{"reason":"credential-artifact","path":"/root/.netrc"}'],
    [{ reason: 'temporary-artifact', path: '/tmp' }, '{"reason":"temporary-artifact","path":"/tmp"}'],
    [{ reason: 'filesystem', path: '/var/lib/cloud/data', code: 'ENOTDIR' }, '{"reason":"filesystem","path":"/var/lib/cloud/data","code":"ENOTDIR"}'],
    [{ reason: 'filesystem', path: '/var/log' }, '{"reason":"filesystem","path":"/var/log"}'],
    [{ reason: 'unexpected' }, '{"reason":"unexpected"}'],
  ];
  for (const [value, expected] of cases) {
    assert.equal(formatDiagnostic(JSON.parse(JSON.stringify(value))), expected);
    assert.ok(formatDiagnostic(value).length < 160);
  }
});

test('absent or forged serialized fields cannot escape the controlled diagnostic vocabulary', () => {
  const secret = 'secret-jit https://s3.example/report?signature=secret';
  const cases = [null, undefined, secret, [], {}, { reason: secret }, { reason: 'toString', path: '/tmp' },
    { reason: ['cloud-init-log'], path: '/var/log' },
    { reason: 'cloud-init-log', path: `/var/log/cloud-init.log.${secret}` },
    { reason: 'credential-artifact', path: '/tmp' },
    { reason: 'filesystem', path: '/var/log', code: secret },
    { reason: 'filesystem', path: '/var/log', code: ['EIO'] },
    { reason: 'manifest-invalid', path: '/etc/ci-kit/bake-manifest.json', code: 'EIO' },
    { reason: 'manifest-missing', path: '/etc/ci-kit/bake-manifest.json', code: 'EACCES' },
    { reason: 'unexpected', path: secret, code: secret },
  ];
  for (const value of cases) assert.equal(formatDiagnostic(value), '{"reason":"unexpected"}');
});

test('unknown properties and serialization hooks are never emitted or invoked', () => {
  const value = { reason: 'cloud-init-log', path: '/var/log', message: 'secret', stdout: 'secret', stderr: 'secret',
    toJSON() { throw new Error('must not serialize the input'); } };
  assert.equal(formatDiagnostic(value), '{"reason":"cloud-init-log","path":"/var/log"}');
  assert.equal(formatDiagnostic({ reason: 'unexpected', message: 'x'.repeat(100_000) }), '{"reason":"unexpected"}');
});
