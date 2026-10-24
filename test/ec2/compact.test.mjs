import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Run the real shell, replacing only Linux block/mount commands. The opt-in Linux regression
// also runs the partition copier against real fragmented ext4 files and open, unlinked inodes.
const driver = `set -euo pipefail
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
mount() { echo "CALL mount $*"; [ "$CASE" != recovery-failure ]; }
umount() { echo "CALL umount $*"; }
udevadm() { :; }
sgdisk() { echo "CALL sgdisk $*"; if [[ "$*" == *'-v'* ]]; then echo 'No problems found.'; fi; }
dd() { echo "CALL dd $*"; }
sync() { :; }
mktemp() { echo /run/copy-fixture; }
mkdir() { :; }
rmdir() { :; }
rm() { :; }
losetup() { if [ "$1" = --detach ]; then echo "CALL losetup $*"; else echo /dev/loop7; fi; }
fsfreeze() { echo "CALL fsfreeze $*"; if [ "$1" = -f ]; then FROZEN=1; else FROZEN=0; fi; }
partclone.ext4() {
  echo "CALL partclone.ext4 $*"
  [ "\${FROZEN:-0}" = 1 ] || return 2
  case "$CASE" in copy-failure) return 1;; copy-timeout) return 124;; esac
}
timeout() { echo "CALL timeout $*"; shift 2; "$@"; }
e2image() { echo "CALL e2image $*"; }
e2fsck() { echo "CALL e2fsck $*"; [ "$CASE" != corrupt ] || return 4; }
# Keep the helper in the same controlled command environment without replacing its behavior.
bash() { . "$1" "\${@:2}"; }
. "$1"
`;
const script = new URL('../../ec2/bake/compact.sh', import.meta.url).pathname;
const run = (scenario = 'ok') => spawnSync('bash', ['-c', driver, 'fixture', script], {
  encoding: 'utf8', env: { ...process.env, CASE: scenario },
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
  assert.match(copy, /--logfile \/run\//, 'a frozen root cannot accept the default partclone log');
  assert.doesNotMatch(copy, /--force|--rescue|--skip_write_error/);
  assert.ok(at('fsfreeze -f /') < at('CALL partclone.ext4 '));
  assert.ok(at('CALL partclone.ext4 ') < at('fsfreeze -u /'));
  assert.ok(at('fsfreeze -u /') < at('CALL mount '));
  assert.match(lines[at('CALL mount ')], /-t ext4 -o rw \/dev\/nvme1n1p1 \/run\//);
  assert.ok(at('CALL mount ') < at('CALL umount /run/'));
  assert.ok(at('CALL umount /run/') < at('e2fsck -fn /dev/nvme1n1p1'));
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
  assert.doesNotMatch(r.stdout, /CALL (?:mount|e2fsck)/);
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
