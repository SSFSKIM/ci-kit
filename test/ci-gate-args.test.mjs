import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, UsageError } from '../cli/args.mjs';
import { cleanLog, formatDuration, nonceMessage, parseGitHubRemote, pushFailure, refName, sanitizeLabel } from '../cli/naming.mjs';

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

test('pushFailure names the reason, not git\'s closing line', () => {
  const hook = 'remote: \nerror: failed to push some refs to \'x\'';
  const refused = [
    'pre-push hook: gitleaks found a secret in abc123',
    'error: failed to push some refs to \'https://github.com/SSFSKIM/arachne.git\'',
  ].join('\n');
  assert.equal(pushFailure(refused).reason, refused.split('\n')[1]); // no telling line: the last stands
  assert.equal(pushFailure(refused).lines.length, 2); // every line still reaches the notes
  const rejected = [
    'To https://github.com/SSFSKIM/arachne.git',
    ' ! [remote rejected] abc -> ci/x (refusing to allow a GitHub App to create workflow)',
    'error: failed to push some refs to \'https://github.com/SSFSKIM/arachne.git\'',
  ].join('\n');
  assert.match(pushFailure(rejected).reason, /remote rejected.*refusing/);
  assert.equal(pushFailure('remote: Permission to x denied.\nfatal: unable to access').reason, 'remote: Permission to x denied.');
  assert.match(pushFailure(hook).reason, /failed to push/); // a blank remote line is not a reason
  const warned = [
    'remote: warning: File a.bin is 60.00 MB; this is larger than the recommended maximum',
    'remote: error: File b.bin is 120.00 MB; this exceeds the file size limit of 100.00 MB',
    'error: failed to push some refs to \'x\'',
  ].join('\n');
  assert.match(pushFailure(warned).reason, /remote: error: File b\.bin/); // a warning never outranks the error
  assert.equal(pushFailure('').reason, 'no output from git');
});

// `ci-gate status` and `ci-gate known add|list` (gate ledger spec, M5).
import { parseKnownArgs, parseStatusArgs } from '../cli/args.mjs';

test('parseStatusArgs: --repo, or the repo origin pushes to', () => {
  assert.deepEqual(parseStatusArgs([]), { repo: null });
  assert.deepEqual(parseStatusArgs(['--repo', 'SSFSKIM/MAWS']), { repo: 'SSFSKIM/MAWS' });
  assert.deepEqual(parseStatusArgs(['--repo=SSFSKIM/MAWS']), { repo: 'SSFSKIM/MAWS' });
  assert.throws(() => parseStatusArgs(['--gates', 'a']), UsageError);
  assert.throws(() => parseStatusArgs(['x']), UsageError);
  assert.throws(() => parseStatusArgs(['--repo', 'nope']), UsageError);
});

test('parseKnownArgs: add with every option, and list', () => {
  assert.deepEqual(
    parseKnownArgs(['add', '--gate', 'e2e:panel', '--case', 'panel.spec.ts › a*', '--reason', '#778: x', '--review-by', '2026-11-26', '--repo', 'SSFSKIM/MAWS', '--id', 'maws-778', '--by', 'ux-wave']),
    { action: 'add', gate: 'e2e:panel', case: 'panel.spec.ts › a*', reason: '#778: x', review_by: '2026-11-26', keep: false, repo: 'SSFSKIM/MAWS', id: 'maws-778', by: 'ux-wave' },
  );
  assert.equal(parseKnownArgs(['add', '--gate=t', '--keep', '--reason=r', '--review-by=2027-01-01']).keep, true);
  assert.deepEqual(parseKnownArgs(['list']), { action: 'list', repo: null });
  assert.deepEqual(parseKnownArgs(['list', '--repo', 'SSFSKIM/cua']), { action: 'list', repo: 'SSFSKIM/cua' });
});

test('parseKnownArgs: refuses what it does not know; what an entry needs is the entry\'s to refuse', () => {
  assert.throws(() => parseKnownArgs([]), UsageError);
  assert.throws(() => parseKnownArgs(['remove']), UsageError);
  assert.throws(() => parseKnownArgs(['list', '--gate', 'x']), UsageError);
  assert.throws(() => parseKnownArgs(['add', '--reason']), UsageError);
  assert.throws(() => parseKnownArgs(['add', '--nope']), UsageError);
  assert.throws(() => parseKnownArgs(['add', 'extra']), UsageError);
  // An option token in a value position is refused; the = form keeps a value that starts with a dash.
  assert.throws(() => parseKnownArgs(['add', '--reason', '--keep', '--gate', 't']), /--reason needs a value, not the option --keep/);
  assert.throws(() => parseStatusArgs(['--repo', '--keep']), UsageError);
  assert.equal(parseKnownArgs(['add', '--reason=--keep is not set here']).reason, '--keep is not set here');
  assert.equal(parseKnownArgs(['add', '--reason=-1 run in 10']).reason, '-1 run in 10');
  // Parsed, then refused by validateKnown before anything is read.
  assert.equal(parseKnownArgs(['add', '--gate', 't']).reason, undefined);
});
