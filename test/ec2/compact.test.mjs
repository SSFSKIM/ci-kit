import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// The real shell owns ordering and failure handling. Only Linux block-device commands are replaced;
// the full filesystem copy, GPT checks and boot are also exercised on an EC2 candidate.
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
umount() { echo "CALL umount $*"; }
udevadm() { :; }
sgdisk() { echo "CALL sgdisk $*"; if [[ "$*" == *'-v'* ]]; then echo 'No problems found.'; fi; }
dd() { echo "CALL dd $*"; }
sync() { :; }
fsfreeze() { echo "CALL fsfreeze $*"; if [ "$1" = -f ]; then FROZEN=1; else FROZEN=0; fi; }
e2image() {
  echo "CALL e2image $*"
  [ "\${FROZEN:-0}" = 1 ] || return 2
  [ "$CASE" != copy-failure ]
}
e2fsck() { echo "CALL e2fsck $*"; [ "$CASE" != corrupt ] || return 4; }
. "$1"
`;
const script = new URL('../../ec2/bake/compact.sh', import.meta.url).pathname;
const run = (scenario = 'ok') => spawnSync('bash', ['-c', driver, 'fixture', script], {
  encoding: 'utf8', env: { ...process.env, CASE: scenario },
});

test('copy writes only used root blocks to a blank equal-sized disk while the source is frozen', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const lines = r.stdout.split('\n');
  const at = (text) => lines.findIndex(line => line.includes(text));
  assert.ok(at('umount /boot/efi') >= 0);
  assert.ok(at('umount /boot') < at('fsfreeze -f /'));
  assert.ok(at('sgdisk --replicate=/dev/nvme1n1 /dev/nvme0n1') >= 0);
  const copy = lines.find(line => line.startsWith('CALL e2image '));
  assert.match(copy, /-ra -f \/dev\/nvme0n1p1 \/dev\/nvme1n1p1$/);
  assert.ok(at('fsfreeze -f /') < at('e2image '));
  assert.ok(at('e2image ') < at('fsfreeze -u /'));
  assert.ok(at('fsfreeze -u /') < at('e2fsck -fn /dev/nvme1n1p1'));
  assert.ok(at('sgdisk -v /dev/nvme1n1') >= 0);
  for (const part of [14, 15, 16]) assert.ok(lines.some(line => line.startsWith('CALL dd ') && line.includes(`if=/dev/nvme0n1p${part} of=/dev/nvme1n1p${part}`)));
  assert.ok(!lines.some(line => line.startsWith('CALL dd ') && /if=\/dev\/nvme0n1p1(?:\s|$)/.test(line)), 'raw copying the root would preserve deleted blocks');
});

for (const scenario of ['size', 'occupied', 'mounted', 'ambiguous']) test(`refuses ${scenario} destination before any writes`, () => {
  const r = run(scenario);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /CALL (?:sgdisk|dd|e2image|fsfreeze)/);
});

test('copy failure still unfreezes the source and fails the bake', () => {
  const r = run('copy-failure');
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /CALL e2image /);
  assert.match(r.stdout, /CALL fsfreeze -u \//);
  assert.doesNotMatch(r.stdout, /CALL e2fsck/);
});

test('filesystem verification failure prevents successful compaction', () => {
  const r = run('corrupt');
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /CALL e2fsck -fn \/dev\/nvme1n1p1/);
  assert.match(r.stdout, /CALL fsfreeze -u \//);
});
