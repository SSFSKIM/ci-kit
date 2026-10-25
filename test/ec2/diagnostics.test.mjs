import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDiagnostic, formatCompactTrace } from '../../ec2/vm/diagnostics.mjs';

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

test('compact diagnostics retain only a finite phase and numeric shell failure status', () => {
  for (const phase of ['compact', 'disk-validation', 'boot-copy', 'copy-root-setup', 'source-inventory',
    'root-copy', 'root-recovery', 'target-inventory', 'root-comparison', 'root-fsck', 'copy-root-cleanup', 'disk-verification']) {
    assert.equal(formatDiagnostic({ reason: 'compact-failed', phase, exit_status: 124, path: 'secret', command: 'secret',
      stderr: 'secret', url: 'https://reports.example/?signature=secret' }),
    JSON.stringify({ reason: 'compact-failed', phase, exit_status: 124 }));
  }
  assert.equal(formatDiagnostic({ reason: 'compact-failed', phase: 'root-fsck', exit_status: 255 }),
    '{"reason":"compact-failed","phase":"root-fsck","exit_status":255}');
});

test('forged compact phases or exit statuses never become log text', () => {
  const secret = 'secret https://reports.example/?signature=secret';
  const cases = [
    { phase: secret, exit_status: 1 }, { phase: ['root-copy'], exit_status: 1 },
    { phase: 'toString', exit_status: 1 }, { phase: 'root-copy' },
    ...[0, -1, 256, 1.5, '124', [124], null, NaN, Infinity, secret].map(exit_status => ({ phase: 'root-copy', exit_status })),
  ];
  for (const fields of cases) assert.equal(formatDiagnostic({ reason: 'compact-failed', ...fields }), '{"reason":"unexpected"}');
  assert.equal(formatDiagnostic({ reason: 'filesystem', path: '/var/log', phase: secret, exit_status: secret }),
    '{"reason":"filesystem","path":"/var/log"}');
});

test('compact timing trace retains only finite phases, bounded numbers and the enforced timeout budgets', () => {
  const secret = 'jit-private https://reports.invalid/?signature=secret';
  const input = { elapsed_seconds: 360, exit_status: 0, command: secret, phases: {
    'source-inventory': { elapsed_seconds: 47, exit_status: 0, bound_seconds: 300, stderr: secret },
    'root-copy': { elapsed_seconds: 114, exit_status: 0 },
    'target-inventory': { elapsed_seconds: 135, exit_status: 0 },
    [secret]: { elapsed_seconds: 1, exit_status: 0 },
  }, toJSON() { throw Error('never serialize the input'); } };
  assert.equal(formatCompactTrace(input), JSON.stringify({ elapsed_seconds: 360, exit_status: 0, phases: {
    'source-inventory': { elapsed_seconds: 47, exit_status: 0, bound_seconds: 300 },
    'root-copy': { elapsed_seconds: 114, exit_status: 0, bound_seconds: 480 },
    'target-inventory': { elapsed_seconds: 135, exit_status: 0, bound_seconds: 300 },
  } }));
  assert.equal(formatCompactTrace({ elapsed_seconds: 86400, exit_status: 255, phases: {} }),
    '{"elapsed_seconds":86400,"exit_status":255,"phases":{}}');
});

test('forged timing types, oversized numbers and altered timeout budgets cannot cross the report boundary', () => {
  const valid = { elapsed_seconds: 1, exit_status: 0, phases: {} };
  const cases = [null, [], 'secret', { ...valid, phases: [] }, { ...valid, phases: null },
    ...[-1, 86401, 1.5, '47', NaN, Infinity].map(elapsed_seconds => ({ ...valid, elapsed_seconds })),
    ...[-1, 256, 1.5, '124', NaN, Infinity].map(exit_status => ({ ...valid, exit_status })),
    ...[null, [], {elapsed_seconds:1,exit_status:'124'}, {elapsed_seconds:1,exit_status:0,bound_seconds:180},
      {elapsed_seconds:1,exit_status:0,bound_seconds:'secret'}].map(value => ({ ...valid, phases: {'source-inventory':value} })),
  ];
  for (const input of cases) assert.equal(formatCompactTrace(input), '{"reason":"unexpected"}');
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

// Dropping the tail or reflecting report objects/control sequences breaks these boundary guarantees.
test('compact tool output is bounded, sanitized, and optional; unrelated report fields stay private', () => {
  const base = { reason:'compact-failed', phase:'root-copy', exit_status:1 };
  const input = { ...base, log_tail:'\x1b[31mRead bitmap failed\x1b[0m\r\n\x00See https://reports.invalid/?signature=private\u202e', manifest:{secret:'manifest-private'} };
  assert.equal(formatDiagnostic(input), JSON.stringify({...base,log_tail:'Read bitmap failed\nSee [redacted-url]'}));
  for (const log_tail of [undefined, null, [], {}, 42, '', '\x00']) assert.equal(formatDiagnostic({...base,log_tail}), JSON.stringify(base));
  const lines = Array.from({length:100}, (_, i) => `line ${i}`).join('\n');
  assert.equal(JSON.parse(formatDiagnostic({...base,log_tail:lines})).log_tail, lines.split('\n').slice(-40).join('\n'));
  const huge = JSON.parse(formatDiagnostic({...base,log_tail:'é'.repeat(20000)+'END'})).log_tail;
  assert.ok(Buffer.byteLength(huge) <= 8192);
  assert.ok(huge.endsWith('END'));
  assert.equal(formatDiagnostic({...base,log_tail:huge}), JSON.stringify({...base,log_tail:huge}));
});
