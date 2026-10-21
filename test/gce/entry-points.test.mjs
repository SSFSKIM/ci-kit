// The kit's runnable scripts start when run through a symlinked path. Each checks that it is the main module by
// comparing its own URL, which Node resolves through symlinks, with argv[1], the path as typed (macOS's /tmp is
// /private/tmp). Compared unresolved, a run from a /tmp worktree would do nothing and exit 0, which a caller
// (deploy.sh, an operator) reads as done. Each case starts the script through a symlink to gce/ in a way that stops
// before any outside effect, and expects that stop, not a silent 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs gce/<script> through a symlink to gce/: {status, stderr}.
function runLinked(script, args = [], env = process.env) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-kit-entry-'));
  try {
    const link = join(dir, 'gce');
    symlinkSync(fileURLToPath(new URL('../../gce/', import.meta.url)), link);
    const run = spawnSync(process.execPath, [join(link, script), ...args], { encoding: 'utf8', env, timeout: 20_000 });
    return { status: run.status, stderr: run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('app-hook: no URL given, it prints its usage and exits 2, before any secret is read', () => {
  const run = runLinked('tools/app-hook.mjs');
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /usage: node gce\/tools\/app-hook\.mjs <receiver url>/);
});

test('latency-report: an unknown flag stops it with its usage, before any read', () => {
  const run = runLinked('latency-report.mjs', ['--bogus', 'x']);
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /usage: node gce\/latency-report\.mjs/);
});

test('boot-sample: an unknown flag stops it with its usage, before any read', () => {
  const run = runLinked('tools/boot-sample.mjs', ['--bogus', 'x']);
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /usage: node gce\/tools\/boot-sample\.mjs/);
});

test('bake: with no gcloud on the PATH it fails at its first Google token, before it creates anything', () => {
  // CI_KIT_COMMIT skips the read of the kit's main; no K_SERVICE or CLOUD_RUN_JOB, so the token is gcloud's, and an
  // empty PATH has no gcloud. The bake's first outside call is the App secret's read, which needs that token.
  const run = runLinked('bake/bake.mjs', [], { PATH: '', CI_KIT_COMMIT: '0'.repeat(40) });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /gcloud/);
});
