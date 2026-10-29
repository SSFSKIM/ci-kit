// Run the janitor at its process-table boundary: no Tart command may run, even when Tart is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JANITOR = new URL('../host/janitor.mjs', import.meta.url).pathname;

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'ci-kit-janitor-vms-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  mkdirSync(join(home, 'repos'));
  const config = join(home, 'config.json');
  writeFileSync(config, JSON.stringify({
    patterns: ['^never-match$'], exclude: [], min_age_hours: 2, vm_report_hours: 12,
    repos_root: '~/repos', notify: false,
  }));
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\n/bin/cat "$HOME/ps.txt"\n', { mode: 0o755 });
  writeFileSync(join(home, 'ps.txt'), [
    '501 101 1 13:05:00 100 Thu Oct 29 00:00:00 2026 /opt/homebrew/bin/tart run --disk maws-vm-value old-vm --no-graphics',
    '501 102 1 12:00:00 100 Thu Oct 29 01:05:00 2026 tart run threshold-vm',
    '501 103 1 01:00:00 100 Thu Oct 29 12:05:00 2026 tart run young-vm',
    '501 104 1 20:00:00 100 Wed Oct 28 17:05:00 2026 tart exec not-running command',
    '',
  ].join('\n'));
  return {
    home, bin,
    report: join(home, 'Library/Logs/ci-kit/report.md'),
    run: () => spawnSync(process.execPath, [JANITOR, '--config', config, '--dry-run'], {
      encoding: 'utf8', env: { ...process.env, HOME: home, PATH: bin },
    }),
  };
}

for (const installed of [true, false]) {
  test(`the janitor reports process ages without invoking Tart (installed: ${installed})`, (t) => {
    const f = fixture(t);
    if (installed) writeFileSync(join(f.bin, 'tart'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/tart-calls"\nprintf \'[{"Name":"ghost","Running":true,"State":"running"}]\\n\'\n', { mode: 0o755 });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const report = readFileSync(f.report, 'utf8');
    const section = report.split('## VMs running more than 12 h\n')[1].split('## Top memory users')[0];
    assert.equal(section.trim(), '| VM | running for |\n|---|---|\n| old-vm | 13h5m |');
    assert.equal(existsSync(join(f.home, 'tart-calls')), false, 'no Tart invocation, including list');
  });
}

test('no Tart processes means no running VMs, not a missing-installation error', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.home, 'ps.txt'), '');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(f.report, 'utf8'), /## VMs running more than 12 h\n\nNone\./);
});

test('a failed process read fails the janitor without replacing its last report', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, 'Library/Logs/ci-kit'), { recursive: true });
  writeFileSync(f.report, 'last successful report\n');
  writeFileSync(join(f.bin, 'ps'), '#!/bin/sh\necho "process table unavailable" >&2\nexit 1\n');
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /process table unavailable/);
  assert.equal(readFileSync(f.report, 'utf8'), 'last successful report\n');
});
