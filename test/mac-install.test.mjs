import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-kit-install-')));
after(() => rmSync(root, { recursive: true, force: true }));
const python = spawnSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
const hookFiles = ['job-started.sh', 'job-completed.sh', 'desktop-check.sh', 'desktop-posture.sh', 'sweep.mjs', 'strays.mjs', 'terminate.mjs'];
const macOnly = { skip: process.platform !== 'darwin' };

function fixture() {
  const home = mkdtempSync(join(root, 'home-'));
  const kit = join(home, 'kit');
  const bin = join(home, 'bin');
  mkdirSync(bin);
  for (const dir of ['mac', 'host']) cpSync(join(repo, dir), join(kit, dir), { recursive: true });
  const executable = (path, body) => { writeFileSync(path, `#!/bin/bash\n${body}\n`); chmodSync(path, 0o755); };
  const fake = (name, body) => executable(join(bin, name), body);
  fake('launchctl', 'echo "$*" >> "$HOME/launchctl.calls"\n[[ $1 != print ]]');
  fake('plutil', 'exit 0');
  fake('pgrep', 'exit 1');
  fake('uname', 'if [[ $1 == -m ]]; then echo arm64; else echo Darwin; fi');
  for (const name of ['node', 'corepack', 'git', 'soffice']) fake(name, 'echo fixture-tool');
  // Never download/register a runner or invoke any real compiler or desktop tool.
  fake('curl', 'exit 90');
  fake('xcrun', `if [[ $1 == clang ]]; then echo fixture-clang; exit 0; fi
[[ $1 == swiftc && $2 == -O && $3 == -o ]] || exit 91
printf '#!/bin/bash\\necho cursor-park\\n' > "$4"
chmod +x "$4"
[[ \${FAIL_COMPILE:-0} != 1 ]]`);
  fake('cp', `if [[ \${FAIL_COPY:-0} == 1 && $1 == */hooks/job-started.sh ]]; then
  /bin/cp "$1" "\${!#}/"
  exit 73
fi
if [[ \${OMIT_COPY:-0} == 1 && $1 == */hooks/strays.mjs ]]; then exit 0; fi
exec /bin/cp "$@"`);
  symlinkSync(python, join(bin, 'python3'));
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
  // Production intentionally ignores the installer's PATH for prerequisites. Redirect that boundary in this copy,
  // including its LibreOffice existence probe, so the fixture never relies on the machine's installed tools.
  const install = join(kit, 'mac/install.sh');
  writeFileSync(install, readFileSync(install, 'utf8')
    .replace(/^RUNNER_PATH=.*$/m, `RUNNER_PATH=${env.PATH}`)
    .replace('test -x /Applications/LibreOffice.app/Contents/MacOS/soffice', 'true'));
  const runner = join(home, 'actions-runner-maws');
  mkdirSync(join(runner, 'bin'), { recursive: true });
  executable(join(runner, 'config.sh'), 'exit 92');
  executable(join(runner, 'bin/runsvc.sh'), 'echo fixture-runner');
  writeFileSync(join(runner, '.runner'), '{}');
  const hooks = join(runner, 'ci-kit/hooks');
  mkdirSync(hooks, { recursive: true });
  for (const file of [...hookFiles, 'cursor-park', 'obsolete']) writeFileSync(join(hooks, file), `old ${file}\n`);
  writeFileSync(join(runner, '.env'), 'old environment\n');
  const snapshot = () => Object.fromEntries(readdirSync(hooks).sort().map((name) => [name, readFileSync(join(hooks, name), 'utf8')]));
  const run = (script = 'mac/install.sh', args = ['--disabled'], extra = {}) => spawnSync('/bin/bash', [join(kit, script), ...args], {
    encoding: 'utf8', timeout: 15_000, env: { ...env, ...extra },
  });
  return { home, kit, bin, env, runner, hooks, executable, run, snapshot };
}

// run-node.sh needs only bash builtins, so its PATH can be one empty directory: unlike /usr/bin:/bin, it cannot
// discover a real host Node (a compatible /usr/bin/node on Linux would preempt the fake nvm candidates or make a
// "no runtime" premise false), and unlike the fixture's bin it holds no fake node either.
function isolatedPath(f) {
  const empty = join(f.home, 'empty-path');
  mkdirSync(empty);
  return empty;
}

function assertNewHooks(f, { cursor = true } = {}) {
  assert.deepEqual(readdirSync(f.hooks).sort(), [...hookFiles, ...(cursor ? ['cursor-park'] : [])].sort());
  for (const file of hookFiles) {
    assert.equal(readFileSync(join(f.hooks, file), 'utf8'), readFileSync(join(f.kit, 'mac/hooks', file), 'utf8'));
    if (file.endsWith('.sh')) assert.ok(statSync(join(f.hooks, file)).mode & 0o111, file);
  }
  if (cursor) assert.ok(statSync(join(f.hooks, 'cursor-park')).mode & 0o111);
  assert.match(readFileSync(join(f.runner, '.env'), 'utf8'), new RegExp(`ACTIONS_RUNNER_HOOK_JOB_STARTED=${f.hooks}/job-started.sh`));
}

test('a partial hook copy leaves the complete old hooks and environment untouched', macOnly, () => {
  const f = fixture();
  const before = f.snapshot();
  const result = f.run(undefined, undefined, { FAIL_COPY: '1' });
  assert.equal(result.status, 73, result.stderr);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(readFileSync(join(f.runner, '.env'), 'utf8'), 'old environment\n');
  assert.equal(existsSync(join(f.home, 'launchctl.calls')), false);
  assert.deepEqual(readdirSync(join(f.runner, 'ci-kit')), ['hooks']);
});

test('incomplete or invalid staged hooks never replace the old hooks', macOnly, () => {
  for (const invalid of ['missing', 'syntax', 'swap-failure']) {
    const f = fixture();
    const before = f.snapshot();
    if (invalid === 'syntax') writeFileSync(join(f.kit, 'mac/hooks/job-completed.sh'), '#!/bin/bash\nif then\n');
    if (invalid === 'swap-failure') {
      rmSync(join(f.bin, 'python3'));
      f.executable(join(f.bin, 'python3'), '[[ $1 == --version ]] && { echo Python; exit 0; }; exit 74');
    }
    const result = f.run(undefined, undefined, invalid === 'missing' ? { OMIT_COPY: '1' } : {});
    assert.notEqual(result.status, 0, invalid);
    assert.deepEqual(f.snapshot(), before, invalid);
    assert.deepEqual(readdirSync(join(f.runner, 'ci-kit')), ['hooks']);
  }
});

test('a successful refresh replaces the full old set, including the compiled cursor helper', macOnly, () => {
  const f = fixture();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assertNewHooks(f);
  assert.deepEqual(readdirSync(join(f.runner, 'ci-kit')), ['hooks']);
});

test('a failed Swift compile warns and publishes complete hooks without a partial cursor binary', macOnly, () => {
  const f = fixture();
  const result = f.run(undefined, undefined, { FAIL_COMPILE: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /warning: cursor-park did not compile/);
  assertNewHooks(f, { cursor: false });
});

test('a first install publishes hooks when there is no old directory', macOnly, () => {
  const f = fixture();
  rmSync(f.hooks, { recursive: true });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assertNewHooks(f);
});

test('the fixed hook paths stay readable while an idle runner is refreshed', macOnly, async () => {
  const f = fixture();
  const stop = join(f.home, 'stop');
  const observer = spawn(python, ['-I', '-u', '-c', `
import os, sys
hooks, source, stop = sys.argv[1:]
files = ['job-started.sh', 'job-completed.sh', 'desktop-check.sh', 'desktop-posture.sh', 'sweep.mjs', 'strays.mjs', 'terminate.mjs']
allowed = {name: {open(os.path.join(hooks, name), 'rb').read(), open(os.path.join(source, name), 'rb').read()} for name in files}
print('ready', flush=True)
reads = 0
while not os.path.exists(stop):
    for name in files:
        with open(os.path.join(hooks, name), 'rb') as stream:
            assert stream.read() in allowed[name], name
        reads += 1
print(reads)
`, f.hooks, join(f.kit, 'mac/hooks'), stop], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  observer.stdout.on('data', (chunk) => { output += chunk; });
  observer.stderr.on('data', (chunk) => { errors += chunk; });
  const closed = new Promise((resolve) => observer.on('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      observer.stdout.once('data', resolve);
      observer.once('error', reject);
      observer.once('exit', (code) => { if (code) reject(new Error(errors)); });
    });
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
  } finally {
    writeFileSync(stop, '');
  }
  assert.equal(await closed, 0, errors);
  assert.ok(Number(output.trim().split('\n').at(-1)) > 0, output);
  assertNewHooks(f);
});

function readPlist(path) {
  const result = spawnSync(python, ['-I', '-c', 'import json, plistlib, sys; print(json.dumps(plistlib.load(open(sys.argv[1], "rb"))))', path], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('the installed janitor plist resolves Node again after an nvm version is removed', () => {
  const f = fixture();
  const oldNode = join(f.home, '.nvm/versions/node/v22.1.0/bin/node');
  mkdirSync(join(oldNode, '..'), { recursive: true });
  f.executable(oldNode, 'if [[ $1 == -p ]]; then echo 22; else echo v22.1.0; fi');
  const node = join(f.home, '.local/bin/node');
  mkdirSync(join(node, '..'), { recursive: true });
  f.executable(node, `if [[ $1 == -e ]]; then exit 0; fi\nprintf '%s\\n' "$@"`);
  const installed = f.run('host/install.sh', ['--dry-run'], { PATH: `${join(oldNode, '..')}:${f.env.PATH}` });
  assert.equal(installed.status, 0, installed.stderr);
  const plist = readPlist(join(f.home, 'Library/LaunchAgents/com.ssfskim.ci-kit.janitor.plist'));
  rmSync(join(f.home, '.nvm/versions/node/v22.1.0'), { recursive: true });
  const result = spawnSync(plist.ProgramArguments[0], plist.ProgramArguments.slice(1), {
    encoding: 'utf8', timeout: 5000,
    env: { HOME: f.home, ...plist.EnvironmentVariables },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [join(f.kit, 'host/janitor.mjs'), '--dry-run']);
});

test('Node resolution works with only nvm installs and no shell profile, skipping obsolete versions', () => {
  const f = fixture();
  for (const [version, status] of [['v20.1.0', 1], ['v24.1.0', 0]]) {
    const node = join(f.home, `.nvm/versions/node/${version}/bin/node`);
    mkdirSync(join(node, '..'), { recursive: true });
    f.executable(node, `if [[ $1 == -e ]]; then exit ${status}; fi\nprintf '%s\\n' "$@"`);
  }
  writeFileSync(join(f.home, '.bash_profile'), 'exit 99\n');
  const result = spawnSync('/bin/bash', [join(f.kit, 'host/run-node.sh'), 'script with spaces.mjs', '--dry-run'], {
    encoding: 'utf8', env: { HOME: f.home, PATH: isolatedPath(f) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), ['script with spaces.mjs', '--dry-run']);
});

test('Node resolution reports a missing compatible runtime instead of running the janitor', () => {
  const f = fixture();
  const result = spawnSync('/bin/bash', [join(f.kit, 'host/run-node.sh'), 'must-not-run.mjs'], {
    encoding: 'utf8', env: { HOME: f.home, PATH: isolatedPath(f) },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Node >= 22/);
});
