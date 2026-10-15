import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, UsageError } from '../cli/args.mjs';
import { cleanLog, formatDuration, nonceMessage, parseGitHubRemote, refName, sanitizeLabel } from '../cli/naming.mjs';

test('parseArgs: defaults', () => {
  assert.deepEqual(parseArgs([]), { target: '.', gates: [], repo: null, label: null, keep: false });
});

test('parseArgs: every option', () => {
  assert.deepEqual(
    parseArgs(['../wt', '--gates', 'unit, lint', '--repo', 'SSFSKIM/cua', '--label', 'stab1', '--keep']),
    { target: '../wt', gates: ['unit', 'lint'], repo: 'SSFSKIM/cua', label: 'stab1', keep: true },
  );
  assert.equal(parseArgs(['--gates=unit']).gates[0], 'unit');
});

test('parseArgs: refuses what it does not know', () => {
  assert.throws(() => parseArgs(['--nope']), UsageError);
  assert.throws(() => parseArgs(['a', 'b']), UsageError);
  assert.throws(() => parseArgs(['--gates']), UsageError);
  assert.throws(() => parseArgs(['--repo', 'not-a-repo']), UsageError);
});

test('refName carries the label, 8 of the sha and 6 of the nonce', () => {
  assert.equal(refName('main', 'abcdef0123456789', '0123456789ab'), 'ci/main-abcdef01-012345');
});

test('sanitizeLabel keeps a ref-safe label', () => {
  assert.equal(sanitizeLabel('feat/x y'), 'feat-x-y');
  assert.equal(sanitizeLabel('m1-core'), 'm1-core');
  assert.equal(sanitizeLabel('..'), 'gate');
  assert.equal(sanitizeLabel(''), 'gate');
});

test('nonceMessage: the subject, then trailers after a blank line', () => {
  assert.equal(nonceMessage('0123456789ab', []), 'ci-gate 0123456789ab\n');
  assert.equal(nonceMessage('0123456789ab', ['unit', 'lint']), 'ci-gate 0123456789ab\n\nCI-Gates: unit,lint\n');
});

test('parseGitHubRemote reads https and ssh remotes', () => {
  assert.equal(parseGitHubRemote('https://github.com/SSFSKIM/ci-kit.git'), 'SSFSKIM/ci-kit');
  assert.equal(parseGitHubRemote('https://github.com/SSFSKIM/ci-kit'), 'SSFSKIM/ci-kit');
  assert.equal(parseGitHubRemote('git@github.com:SSFSKIM/cua.git'), 'SSFSKIM/cua');
  assert.equal(parseGitHubRemote('ssh://git@github.com/SSFSKIM/cua.git'), 'SSFSKIM/cua');
  assert.equal(parseGitHubRemote('https://gitlab.com/a/b.git'), null);
});

test('formatDuration is <m>m<ss>s', () => {
  assert.equal(formatDuration(41), '0m41s');
  assert.equal(formatDuration(125), '2m05s');
  assert.equal(formatDuration(3600), '60m00s');
  assert.equal(formatDuration(-3), '0m00s');
});

test('cleanLog drops the BOM, colour codes and timestamps', () => {
  const raw = '\uFEFF2026-10-13T15:09:42.4259551Z Run npm test\n2026-10-13T15:09:43.1Z \x1b[31mnot ok 1\x1b[0m\n';
  assert.equal(cleanLog(raw), 'Run npm test\nnot ok 1\n');
});
