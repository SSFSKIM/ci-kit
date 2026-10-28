import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mac = fileURLToPath(new URL('../mac/', import.meta.url));
// A ps snapshot: native Tart, a shell-script Tart (the lane fixture), options before the name, and lookalikes.
const table = `101 /opt/homebrew/bin/tart run maws-vm-golden
102 /bin/bash /fixture/bin/tart run --no-graphics --dir=kit:/kit:ro maws-vm-job-vm-123
103 tart run unrelated
104 tart exec maws-vm-golden true
105 tart stop maws-vm-golden
106 not-tart run maws-vm-fake
107 tart run maws-vm-not-last --no-graphics
108 tart run maws-vm-golden-extra
`;

function read(t, args, { fail = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ci-kit-tart-read-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const ps = join(home, 'ps');
  writeFileSync(ps, `#!/bin/bash\n[[ $* == '-axww -o pid=,command=' ]] || exit 64\n${fail ? 'exit 1' : `cat <<'TABLE'\n${table}TABLE`}\n`);
  chmodSync(ps, 0o755);
  return spawnSync('/bin/bash', ['-uc', 'source "$1/hooks/dialog.sh"; source "$1/vm/tart.sh"; shift; "$@"', 'test', mac, ...args], {
    encoding: 'utf8', env: { ...process.env, HOME: home, CI_KIT_VM_PS: ps },
  });
}

test('all running lane VMs come from tart run with the VM name last', (t) => {
  const result = read(t, ['tart_run_vms']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'maws-vm-golden\nmaws-vm-job-vm-123\nmaws-vm-golden-extra\n');
});

test('a named run read still returns exact-match pids, not names or prefix matches', (t) => {
  const result = read(t, ['tart_run_pids', 'maws-vm-golden']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '101\n');
});

test('a named exec read still matches the name immediately after exec', (t) => {
  const result = read(t, ['tart_pids', 'exec', 'maws-vm-golden']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '104\n');
});

test('an unreadable process table fails rather than reporting an empty lane', (t) => {
  const result = read(t, ['tart_run_vms'], { fail: true });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
});
