import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// sudo CI_KIT_BOOT_COPY_TEST=1 node --test test/ec2/boot-copy-linux.test.mjs
// Uses only disposable, nonzero-initialized target loop images, not the guest's root or disks.
test('FAT and ext4 boot bitmap copies write allocated zeros but leave free blocks untouched', {
  skip: process.env.CI_KIT_BOOT_COPY_TEST !== '1', timeout: 10 * 60_000,
}, () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid(), 0);
  const r = spawnSync('bash', [new URL('./boot-copy-linux.sh', import.meta.url).pathname,
    new URL('../../ec2/bake/copy-boot.sh', import.meta.url).pathname], {
    encoding: 'utf8', timeout: 9 * 60_000, maxBuffer: 2 ** 20,
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});
