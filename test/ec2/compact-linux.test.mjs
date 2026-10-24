import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Run only on a disposable Linux ext4-root guest with loop devices and partclone/e2fsprogs.
// sudo CI_KIT_EXT4_TEST=1 node --test test/ec2/compact-linux.test.mjs
// CI_KIT_ROOT_COPY_TARGET optionally enables the destructive full-root/two-disk path too.
test('real ext4 stale-cache coherence, fragmented orphan recovery, sparsity, corruption rejection and root thaw', {
  skip: process.env.CI_KIT_EXT4_TEST !== '1', timeout: 15 * 60_000,
}, () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid(), 0);
  const r = spawnSync('bash', [new URL('./compact-linux.sh', import.meta.url).pathname,
    new URL('../../ec2/bake/copy-root.sh', import.meta.url).pathname], {
    encoding: 'utf8', timeout: 14 * 60_000, maxBuffer: 2 ** 20,
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});
