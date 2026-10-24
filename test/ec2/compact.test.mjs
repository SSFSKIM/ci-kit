import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run the real shell, replacing only Linux block/mount commands. The opt-in Linux regression
// also runs the partition copier against real fragmented ext4 files and open, unlinked inodes.
const driver = `set -euo pipefail
# An EXIT trap can inherit a failing command's redirection. Observe cleanup out of band.
exec 3>&1
readlink() { echo /dev/nvme0n1p1; }
findmnt() { if [[ "$*" == *FSTYPE* ]]; then echo ext4; else echo /dev/root; fi; }
lsblk() {
  if [[ "$*" == *PKNAME* ]]; then echo nvme0n1;
  elif [[ "$*" == *MOUNTPOINT* ]]; then [ "$CASE" != mounted ] || echo /mnt/occupied;
  else printf '/dev/nvme0n1 disk\n/dev/nvme1n1 disk\n'; [ "$CASE" != ambiguous ] || echo '/dev/nvme2n1 disk'; fi
  return 0
}
blockdev() {
  if [[ "$*" == *getsize64* ]]; then
    if [ "$CASE" = size ] && [[ "$*" == *nvme1n1* ]]; then echo 10; else echo 50; fi
  else echo "CALL blockdev $*"; fi
}
wipefs() { [ "$CASE" != occupied ] || echo ext4; return 0; }
systemctl() { echo "CALL systemctl $*"; }
mount() {
  echo "CALL mount $*"
  if [ "$CASE" = recovery-failure ] && [[ "$*" == '-t ext4 -o rw '* ]]; then return 1; fi
  if [[ "$*" == *'-o ro'* || "$*" == *'bind,ro'* ]]; then READONLY=1; else READONLY=0; fi
  export READONLY
}
umount() { echo "CALL umount $*" >&3; READONLY=0; export READONLY; }
rmdir() { command rmdir "$@"; case "$CASE" in cleanup-failure|copy-timeout-cleanup-failure) return 29;; esac; }
udevadm() { :; }
sgdisk() { echo "CALL sgdisk $*"; if [[ "$*" == *'-v'* ]]; then [ "$CASE" != disk-verify-failure ] || return 13; echo 'No problems found.'; fi; }
dd() { echo "CALL dd $*"; [ "$CASE" != boot-copy-failure ] || return 23; }
sync() { :; }
mktemp() { echo "CALL mktemp $*" >&2; command mktemp -d "\${TMPDIR:-/tmp}/copy-fixture.XXXXXX"; }
losetup() {
  if [ "$1" = --detach ]; then echo "CALL losetup $*" >&3;
  elif [[ "$*" == *DIO* ]]; then if [ "$CASE" = buffered-alias ]; then echo 0; else echo 1; fi
  else echo "CALL losetup $*" >&2; echo /dev/loop7; fi
}
find() {
  echo "CALL inventory frozen=\${FROZEN:-0} readonly=\${READONLY:-0}" >&2
  if [ "\${FROZEN:-0}" = 1 ]; then [ "$CASE" != hash-failure ] || return 1;
  else
    [ "\${READONLY:-0}" = 1 ] || return 2
    [ "$CASE" != target-hash-failure ] || return 26
    case "$CASE" in missing-file) return 0;; changed-file) echo 'changed-hash  ./file'; return 0;; esac
  fi
  echo 'same-hash  ./file'
  if [ "\${FROZEN:-0}" = 0 ] && [ "$CASE" = extra-file ]; then echo 'extra-hash  ./extra'; fi
  return 0
}
fsfreeze() { echo "CALL fsfreeze $*" >&3; if [ "$1" = -f ]; then FROZEN=1; else FROZEN=0; fi; export FROZEN; }
partclone.ext4() {
  echo "CALL partclone.ext4 $*"
  [ "\${FROZEN:-0}" = 1 ] || return 2
  if [ "$CASE" = timed-copy ]; then node -e 'setTimeout(() => {}, 1100)'; fi
  case "$CASE" in copy-failure) return 1;; copy-timeout|copy-timeout-cleanup-failure) return 124;; esac
}
timeout() {
  if [[ "$*" == *' find '* ]]; then
    echo "CALL timeout $*" >&2
    if [ "$CASE" = source-timeout ] && [ "\${FROZEN:-0}" = 1 ]; then return 124; fi
    if [ "$CASE" = target-timeout ] && [ "\${FROZEN:-0}" = 0 ]; then return 124; fi
  else echo "CALL timeout $*"; fi
  shift 2
  "$@"
}
e2image() { echo "CALL e2image $*"; }
e2fsck() { echo "CALL e2fsck $*"; [ "$CASE" != corrupt ] || return 4; }
# Run the real nested Bash processes, with only their Linux command boundary replaced.
export -f find mount umount rmdir mktemp losetup sync fsfreeze timeout partclone.ext4 e2fsck
. "$1"
`;
const script = new URL('../../ec2/bake/compact.sh', import.meta.url).pathname;
const run = (scenario = 'ok', handoff = 'enabled') => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-kit-compact-diagnostic-'));
  const diagnostic = join(dir, handoff === 'unwritable' ? 'missing/diagnostic' : 'diagnostic');
  const trace = join(dir, handoff === 'unwritable' ? 'missing/trace' : 'trace');
  try {
    const result = spawnSync('bash', ['-c', driver, 'fixture', script], {
      encoding: 'utf8', env: { ...process.env, CASE: scenario,
        CI_KIT_COMPACT_DIAGNOSTIC: handoff === 'disabled' ? undefined : diagnostic,
        CI_KIT_COMPACT_TRACE: handoff === 'disabled' ? undefined : trace },
    });
    return { ...result, diagnostic: existsSync(diagnostic) ? JSON.parse(readFileSync(diagnostic, 'utf8')) : undefined,
      trace: existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').map(line => {
        const [phase, elapsed, status] = line.split(' ');
        return { phase, elapsed_seconds: Number(elapsed), exit_status: Number(status) };
      }) : [] };
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

// Removing an inner failure handoff would turn these into the outer copy-root setup phase.
for (const [scenario, phase, exit_status] of [
  ['size', 'disk-validation', 1],
  ['boot-copy-failure', 'boot-copy', 23],
  ['buffered-alias', 'copy-root-setup', 1],
  ['hash-failure', 'source-inventory', 1],
  ['source-timeout', 'source-inventory', 124],
  ['copy-failure', 'root-copy', 1],
  ['copy-timeout', 'root-copy', 124],
  ['recovery-failure', 'root-recovery', 1],
  ['target-hash-failure', 'target-inventory', 26],
  ['target-timeout', 'target-inventory', 124],
  ['changed-file', 'root-comparison', 1],
  ['corrupt', 'root-fsck', 4],
  ['disk-verify-failure', 'disk-verification', 13],
  ['cleanup-failure', 'copy-root-cleanup', 1],
]) test(`${scenario} hands off the failing phase and shell exit status`, () => {
  const result = run(scenario);
  assert.equal(result.status, exit_status, result.stderr + result.stdout);
  assert.deepEqual(result.diagnostic, { reason: 'compact-failed', phase, exit_status });
  const failed = result.trace.find(entry => entry.phase === phase);
  assert.equal(failed?.exit_status, exit_status);
  assert.ok(Number.isInteger(failed?.elapsed_seconds) && failed.elapsed_seconds >= 0);
  assert.equal(result.trace.find(entry => entry.phase === 'compact')?.exit_status, exit_status);
});

test('cleanup failure cannot overwrite the original copy timeout diagnostic', () => {
  const result = run('copy-timeout-cleanup-failure');
  assert.equal(result.status, 1, 'retain the existing cleanup-failure exit status');
  assert.deepEqual(result.diagnostic, { reason: 'compact-failed', phase: 'root-copy', exit_status: 124 });
  assert.equal(result.trace.find(entry => entry.phase === 'root-copy')?.exit_status, 124);
  assert.equal(result.trace.find(entry => entry.phase === 'copy-root-cleanup')?.exit_status, 1);
  assert.equal(result.trace.find(entry => entry.phase === 'compact')?.exit_status, 1);
  assert.match(result.stdout, /CALL fsfreeze -u \//);
  assert.match(result.stdout, /CALL losetup --detach/);
});

for (const handoff of ['disabled', 'unwritable']) test(`${handoff} optional handoff cannot hide a shell failure`, () => {
  const result = run('copy-timeout', handoff);
  assert.equal(result.status, 124, result.stderr + result.stdout);
  assert.equal(result.diagnostic, undefined);
  assert.deepEqual(result.trace, []);
  assert.match(result.stdout, /CALL fsfreeze -u \//);
  assert.match(result.stdout, /CALL losetup --detach/);
});

test('successful compaction leaves no failure handoff', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.diagnostic, undefined);
});

test('successful compaction records every completed phase and actual elapsed copy time', () => {
  const result = run('timed-copy');
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(result.trace.map(entry => entry.phase), ['disk-validation', 'boot-copy', 'copy-root-setup',
    'source-inventory', 'root-copy', 'root-recovery', 'target-inventory', 'root-comparison', 'root-fsck',
    'copy-root-cleanup', 'disk-verification', 'compact']);
  for (const entry of result.trace) {
    assert.equal(entry.exit_status, 0);
    assert.ok(Number.isInteger(entry.elapsed_seconds) && entry.elapsed_seconds >= 0);
  }
  assert.ok(result.trace.find(entry => entry.phase === 'root-copy').elapsed_seconds >= 1);
  assert.ok(result.trace.find(entry => entry.phase === 'compact').elapsed_seconds >= 1);
  const timeouts = (result.stderr + result.stdout).match(/CALL timeout --kill-after=10s 5m bash/g) ?? [];
  assert.equal(timeouts.length, 2, 'both inventories receive the measured-cold 300-second bound');
  assert.match(result.stdout, /CALL timeout --kill-after=10s 8m partclone/);
});

test('copy preserves all allocated blocks, recovers normally, then verifies without repairing corruption', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const lines = r.stdout.split('\n');
  const at = (text) => lines.findIndex(line => line.includes(text));
  assert.ok(at('umount /boot/efi') >= 0);
  assert.ok(at('umount /boot') < at('fsfreeze -f /'));
  assert.ok(at('sgdisk --replicate=/dev/nvme1n1 /dev/nvme0n1') >= 0);
  const copy = lines.find(line => line.startsWith('CALL partclone.ext4 '));
  assert.ok(copy, r.stdout);
  assert.match(copy, /--dev-to-dev/);
  assert.match(copy, /--source \/dev\/loop7/);
  assert.match(copy, /--output \/dev\/nvme1n1p1/);
  assert.match(r.stderr, /CALL mktemp -d \/run\//, 'runtime files must live on tmpfs while root is frozen');
  assert.match(copy, /--logfile .*\/partclone.log/);
  assert.doesNotMatch(copy, /--force|--rescue|--skip_write_error/);
  assert.ok(at('fsfreeze -f /') < at('CALL partclone.ext4 '));
  assert.ok(at('CALL partclone.ext4 ') < at('fsfreeze -u /'));
  const recovery = at('mount -t ext4 -o rw ');
  assert.ok(at('fsfreeze -u /') < recovery);
  assert.match(lines[recovery], /-t ext4 -o rw \/dev\/nvme1n1p1 .*\/root/);
  assert.ok(recovery < lines.findIndex(line => /CALL umount .*\/root$/.test(line)));
  const readonly = at('mount -t ext4 -o ro ');
  assert.ok(readonly > recovery, r.stdout);
  assert.ok(readonly < at('e2fsck -fn /dev/nvme1n1p1'));
  assert.match(r.stderr, /CALL inventory frozen=1/);
  assert.match(r.stderr, /CALL inventory frozen=0 readonly=1/);
  assert.ok(at('losetup --detach /dev/loop7') > at('fsfreeze -u /'));
  assert.ok(at('sgdisk -v /dev/nvme1n1') >= 0);
  for (const part of [14, 15, 16]) assert.ok(lines.some(line => line.startsWith('CALL dd ') && line.includes(`if=/dev/nvme0n1p${part} of=/dev/nvme1n1p${part}`)));
  assert.ok(!lines.some(line => line.startsWith('CALL dd ') && /if=\/dev\/nvme0n1p1(?:\s|$)/.test(line)), 'raw copying the root would preserve deleted blocks');
});

for (const scenario of ['size', 'occupied', 'mounted', 'ambiguous']) test(`refuses ${scenario} destination before any writes`, () => {
  const r = run(scenario);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /CALL (?:sgdisk|dd|partclone|e2image|fsfreeze)/);
});

for (const scenario of ['copy-failure', 'copy-timeout']) test(`${scenario} still thaws the source, releases the alias, and fails the bake`, () => {
  const r = run(scenario);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /CALL partclone.ext4 /);
  assert.match(r.stdout, /CALL timeout --kill-after=10s /);
  assert.match(r.stdout, /CALL fsfreeze -u \//);
  assert.match(r.stdout, /CALL losetup --detach \/dev\/loop7/);
  assert.doesNotMatch(r.stdout, /CALL mount -t ext4|CALL e2fsck/);
});

test('normal recovery failure does not proceed to verification or report success', () => {
  const r = run('recovery-failure');
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /CALL mount /);
  assert.doesNotMatch(r.stdout, /CALL e2fsck|copied root verified/);
});

test('read-only verification failure prevents successful compaction without attempting repair', () => {
  const r = run('corrupt');
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /CALL e2fsck -fn \/dev\/nvme1n1p1/);
  assert.equal(r.stdout.split('\n').filter(line => line.startsWith('CALL e2fsck ')).length, 1);
  assert.doesNotMatch(r.stdout, /copied root verified/);
});

for (const scenario of ['changed-file', 'extra-file', 'missing-file']) test(`${scenario} content inventory prevents success even when filesystem structure is valid`, () => {
  const r = run(scenario);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /content inventory differs/);
  assert.doesNotMatch(r.stdout, /CALL e2fsck|copied root verified/);
  assert.match(r.stdout, /CALL umount .*\/root/);
});

test('source content read failure thaws root before any block copy', () => {
  const r = run('hash-failure');
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /CALL fsfreeze -u \//);
  assert.doesNotMatch(r.stdout, /CALL partclone|CALL mount -t ext4|copied root verified/);
});

test('a loop alias without backing direct I/O is refused before root is frozen', () => {
  const r = run('buffered-alias');
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /CALL fsfreeze|CALL partclone|copied root verified/);
  assert.match(r.stdout, /CALL losetup --detach \/dev\/loop7/);
});
