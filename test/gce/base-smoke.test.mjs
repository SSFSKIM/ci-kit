import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Run the shipped smoke shell against an infrastructure-only filesystem. No project command or warmed cache
// exists. Only OS identity and network calls are fake; the shell checks real files, Node paths and work writes.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ci-kit-base-smoke-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const executable = (path, script) => writeFileSync(path, `#!/bin/bash\n${script}\n`, { mode: 0o755 });
  for (const path of ['bin', 'home/runner', 'usr/local/bin', 'work', 'cache', 'toolcache/node/22.1.0/x64/bin', 'toolcache/node/24.1.0/x64/bin']) {
    mkdirSync(join(root, path), { recursive: true });
  }
  executable(join(root, 'home/runner/run.sh'), 'exit 0');
  executable(join(root, 'usr/local/bin/ci-kit-entrypoint'), 'exit 0');
  for (const version of ['22.1.0', '24.1.0']) executable(join(root, `toolcache/node/${version}/x64/bin/node`), `exec '${process.execPath}' "$@"`);
  executable(join(bin, 'nproc'), 'echo 2');
  executable(join(bin, 'id'), 'echo runner');
  executable(join(bin, 'getent'), 'exit 0');
  executable(join(bin, 'curl'), '[[ "$*" != *169.254.169.254* && "$*" != *fd00:ec2::* ]] || [[ ${METADATA_OPEN:-0} == 1 ]]');
  for (const command of ['zsh', 'dpkg', 'jq']) executable(join(bin, command), 'exit 127');
  const script = readFileSync(new URL('../../gce/vm/smoke.sh', import.meta.url), 'utf8')
    .replaceAll('/home/runner', `${root}/home/runner`)
    .replaceAll('/usr/local/bin', `${root}/usr/local/bin`)
    .replaceAll('/etc/ci-kit', `${root}/etc/ci-kit`)
    .replaceAll('/var/run/docker.sock', `${root}/var/run/docker.sock`)
    .replaceAll('/var/lib/ci-kit/cache', `${root}/cache`);
  return (extra = {}) => spawnSync('/bin/bash', ['-c', script], {
    encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, RUNNER_TOOL_CACHE: `${root}/toolcache`,
      CI_KIT_WORK: `${root}/work`, CI_KIT_EXPECT_CPUS: '2', npm_config_store_dir: `${root}/cache`, ...extra },
  });
}

test('base smoke accepts empty caches without any project tools or legacy warm records', t => {
  const result = fixture(t)();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ci-kit smoke: ok/);
});

test('base smoke still refuses a reachable metadata endpoint', t => {
  const result = fixture(t)({ METADATA_OPEN: '1' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /ci-kit smoke: failed:metadata-refused/);
});
