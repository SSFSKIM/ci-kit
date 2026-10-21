import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-kit-install-')));
after(() => rmSync(root, { recursive: true, force: true }));
const python = spawnSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
const hookFiles = ['job-started.sh', 'job-completed.sh', 'desktop-check.sh', 'desktop-posture.sh', 'dialog.sh', 'dialog-watch.sh', 'runner-hold.sh', 'runner-state.py', 'sweep.mjs', 'strays.mjs', 'terminate.mjs', 'instances.sh', 'shared-hold.sh'];
const watchAgent = 'com.ssfskim.ci-kit.dialog-watch';
const runnerAgent = 'com.ssfskim.ci-kit.mac-runner';
const macOnly = { skip: process.platform !== 'darwin' };

// What the runner writes at registration (2.338.0): JSON behind a UTF-8 byte-order mark (the mini's, read 2026-10-17).
const dotRunner = (name) => `\uFEFF${JSON.stringify({ agentId: 21, agentName: name, poolId: 1, gitHubUrl: 'https://github.com/SSFSKIM/MAWS', workFolder: '_work' }, null, 2)}`;

function fixture({ registered = 'ci-kit-mac-mini' } = {}) {
  const home = mkdtempSync(join(root, 'home-'));
  const kit = join(home, 'kit');
  const bin = join(home, 'bin');
  mkdirSync(bin);
  for (const dir of ['mac', 'host']) cpSync(join(repo, dir), join(kit, dir), { recursive: true });
  const executable = (path, body) => { writeFileSync(path, `#!/bin/bash\n${body}\n`); chmodSync(path, 0o755); };
  const fake = (name, body) => executable(join(bin, name), body);
  // A runner bootstrapped reports in its log.
  // launchd keeps which agents are enabled (print-disabled prints it); each runner bootstrapped reports in its log.
  fake('launchctl', `echo "$*" >> "$HOME/launchctl.calls"
db=$HOME/launchctl.db
case $1 in
  enable | disable) label=\${2##*/}; { grep -vF "\\"$label\\" " "$db" 2>/dev/null; echo "\\"$label\\" => \${1}d"; } >"$db.tmp"; mv "$db.tmp" "$db" ;;
  print-disabled) printf 'disabled services = {\n'; [[ -f $db ]] && sed 's/^/\t/' "$db"; printf '}\n'; exit 0 ;;
esac
if [[ $1 == bootstrap && $3 == *${runnerAgent}*.plist ]]; then log=\${3##*/}; log=\${log%.plist}; echo 'Listening for Jobs' >> "$HOME/Library/Logs/ci-kit/\${log#com.ssfskim.ci-kit.}.out.log"; fi
[[ $1 != print ]]`);
  fake('plutil', 'exit 0');
  fake('pgrep', 'exit 1');
  fake('uname', 'if [[ $1 == -m ]]; then echo arm64; else echo Darwin; fi');
  for (const name of ['node', 'corepack', 'git', 'soffice']) fake(name, 'echo fixture-tool');
  // Never download/register a runner or invoke any real compiler or desktop tool.
  fake('curl', 'echo "$*" >> "$HOME/curl.calls"\nexit 90');
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
  // A registration records its arguments and whether the token came through the environment, then writes .runner.
  // An instance's runner files. A registration records its arguments (in the instance, and the last in HOME) and whether
  // the token came through the environment, then writes .runner.
  const instance = (dir, registeredAs) => {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    executable(join(dir, 'config.sh'), `printf '%s\\n' "$@" > "$HOME/config.args"; cp "$HOME/config.args" config.args
printf '%s' "\${ACTIONS_RUNNER_INPUT_TOKEN-}" > "$HOME/config.token"
while (($# > 0)); do [[ $1 == --name ]] && name=$2; shift; done
printf '\\xef\\xbb\\xbf{"agentName": "%s"}' "$name" > .runner`);
    executable(join(dir, 'bin/runsvc.sh'), 'echo fixture-runner');
    if (registeredAs) writeFileSync(join(dir, '.runner'), dotRunner(registeredAs));
  };
  instance(runner, registered);
  const hooks = join(runner, 'ci-kit/hooks');
  mkdirSync(hooks, { recursive: true });
  for (const file of [...hookFiles, 'cursor-park', 'obsolete']) writeFileSync(join(hooks, file), `old ${file}\n`);
  writeFileSync(join(runner, '.env'), 'old environment\n');
  const snapshot = () => Object.fromEntries(readdirSync(hooks).sort().map((name) => [name, readFileSync(join(hooks, name), 'utf8')]));
  const run = (script = 'mac/install.sh', args = ['--disabled'], extra = {}, input = '') => spawnSync('/bin/bash', [join(kit, script), ...args], {
    encoding: 'utf8', timeout: 15_000, env: { ...env, ...extra }, input,
  });
  // Shared instance n's runner files, registered as given (null: not yet).
  const shared = (n, registeredAs = null) => { const dir = join(home, `actions-runner-maws-${n}`); instance(dir, registeredAs); return dir; };
  return { home, kit, bin, env, runner, hooks, executable, run, snapshot, shared };
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

const envFile = (f, machine) => [
  'LANG=en_US.UTF-8',
  `ACTIONS_RUNNER_HOOK_JOB_STARTED=${f.hooks}/job-started.sh`,
  `ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${f.hooks}/job-completed.sh`,
  `CI_KIT_MACHINE=${machine}`,
  '',
].join('\n');

test('a re-run on the mini with no argument keeps its registration, and its .env names it the mini', macOnly, () => {
  const f = fixture();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(f.home, 'config.args')), false, 'not registered again');
  assert.equal(readFileSync(join(f.runner, '.env'), 'utf8'), envFile(f, 'mini'));
});

test('a re-run keeps another machine its registered name; a matching --name is accepted', macOnly, () => {
  const f = fixture({ registered: 'ci-kit-mac-rental' });
  for (const args of [['--disabled'], ['--disabled', '--name', 'ci-kit-mac-rental']]) {
    const result = f.run(undefined, args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.runner, '.env'), 'utf8'), envFile(f, 'rental'));
  }
});

test('registration takes --name, hands the token over in the environment only, and a re-run keeps the name', macOnly, () => {
  const f = fixture({ registered: null });
  const result = f.run(undefined, ['--disabled', '--name', 'ci-kit-mac-rental'], {}, 'registration-token-123\n');
  assert.equal(result.status, 0, result.stderr);
  const args = readFileSync(join(f.home, 'config.args'), 'utf8').trim().split('\n');
  assert.equal(args[args.indexOf('--name') + 1], 'ci-kit-mac-rental');
  assert.equal(args[args.indexOf('--labels') + 1], 'ci-kit-mac');
  assert.ok(!args.some((arg) => arg.includes('registration-token-123')), 'the token is not an argument');
  assert.equal(readFileSync(join(f.home, 'config.token'), 'utf8'), 'registration-token-123');
  assert.equal(readFileSync(join(f.runner, '.env'), 'utf8'), envFile(f, 'rental'));
  rmSync(join(f.home, 'config.args'));
  const rerun = f.run();
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(existsSync(join(f.home, 'config.args')), false, 'not registered again');
  assert.equal(readFileSync(join(f.runner, '.env'), 'utf8'), envFile(f, 'rental'));
});

test('a name that is not the registered one, or missing at registration, is refused before anything changes', macOnly, () => {
  for (const [registered, args, input, refusal] of [
    ['ci-kit-mac-mini', ['--disabled', '--name', 'ci-kit-mac-rental'], '', /registered as ci-kit-mac-mini; to rename it/],
    [null, ['--disabled'], 'registration-token-123\n', /name the runner to register it: --name ci-kit-mac-<machine>/],
    [null, ['--name', 'the rental'], 'registration-token-123\n', /--name takes letters, digits/],
    // The short name is in every alert title, which MAWS reads with [a-z0-9-]+.
    [null, ['--disabled', '--name', 'ci-kit-mac-Rental'], 'registration-token-123\n', /short name, 'Rental' in ci-kit-mac-Rental, takes lowercase letters, digits and '-'/],
    [null, ['--disabled', '--name', 'ci-kit-mac-the_rental'], 'registration-token-123\n', /short name, 'the_rental'/],
    [null, ['--disabled', '--name', 'ci-kit-mac-mini.2'], 'registration-token-123\n', /short name, 'mini.2'/],
    ['ci-kit-mac-Mini', ['--disabled'], '', /short name, 'Mini' in ci-kit-mac-Mini/],
  ]) {
    const f = fixture({ registered });
    const before = f.snapshot();
    const result = f.run(undefined, args, {}, input);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, refusal);
    assert.equal(existsSync(join(f.home, 'config.args')), false, 'nothing registered');
    assert.deepEqual(f.snapshot(), before);
    assert.equal(readFileSync(join(f.runner, '.env'), 'utf8'), 'old environment\n');
    assert.equal(existsSync(join(f.home, 'launchctl.calls')), false);
  }
  assert.equal(fixture().run(undefined, ['--name']).status, 2, '--name without a value prints the usage');
});

test('a missing name at registration is refused before the runner is downloaded', macOnly, () => {
  const f = fixture({ registered: null });
  rmSync(join(f.runner, 'config.sh'));
  const before = f.snapshot();
  const result = f.run(undefined, ['--disabled'], {}, 'registration-token-123\n');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /name the runner to register it/);
  assert.equal(existsSync(join(f.home, 'curl.calls')), false, 'nothing downloaded');
  assert.deepEqual(f.snapshot(), before);
  assert.equal(readFileSync(join(f.runner, '.env'), 'utf8'), 'old environment\n');
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

const calls = (f) => existsSync(join(f.home, 'launchctl.calls')) ? readFileSync(join(f.home, 'launchctl.calls'), 'utf8').trim().split('\n') : [];
const uidOf = () => String(process.getuid());

test('every mode reloads the dialog watcher before the runner, and the runner runs through its hold wrapper', macOnly, () => {
  for (const args of [['--disabled'], []]) {
    const f = fixture();
    const result = f.run(undefined, args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`the dialog watcher ${watchAgent} runs`));
    const domain = `gui/${uidOf()}`;
    const log = calls(f);
    const watchPlist = join(f.home, `Library/LaunchAgents/${watchAgent}.plist`);
    const at = (call) => log.indexOf(call);
    for (const call of [`bootout ${domain}/${watchAgent}`, `enable ${domain}/${watchAgent}`, `bootstrap ${domain} ${watchPlist}`]) {
      assert.ok(at(call) >= 0 && at(call) < at(`bootout ${domain}/${runnerAgent}`), call);
    }
    const plist = readPlist(watchPlist);
    assert.deepEqual(plist.ProgramArguments, ['/bin/bash', join(f.hooks, 'dialog-watch.sh')]);
    assert.equal(plist.StartInterval, 60);
    assert.equal(plist.RunAtLoad, true);
    assert.equal(plist.LimitLoadToSessionType, 'Aqua');
    assert.equal(plist.EnvironmentVariables.CI_KIT_MACHINE, 'mini');
    assert.equal(plist.EnvironmentVariables.PATH, f.env.PATH, "the runner's PATH");
    const runner = readPlist(join(f.home, `Library/LaunchAgents/${runnerAgent}.plist`));
    // The job's responsible process stays /bin/bash: runner-hold.sh execs runsvc.sh in the process launchd started.
    assert.deepEqual(runner.ProgramArguments, ['/bin/bash', join(f.hooks, 'runner-hold.sh')]);
    assert.equal(runner.WorkingDirectory, f.runner);
    for (const p of [plist, runner]) assert.ok(!JSON.stringify(p).includes('__'), 'every placeholder is filled');
  }
});

test('an install while the watcher holds the runner loads it held and says so, without waiting for it to listen', macOnly, () => {
  const f = fixture();
  const marker = join(f.home, 'Library/Logs/ci-kit/runner-drained');
  mkdirSync(join(marker, '..'), { recursive: true });
  writeFileSync(marker, 'held at 2026-10-17T05:13:34Z: SecurityAgent since 2026-10-17T05:12:34Z\n');
  // The fake runner never reports listening here: a wait would fail after 30 s.
  rmSync(join(f.bin, 'launchctl'));
  f.executable(join(f.bin, 'launchctl'), 'echo "$*" >> "$HOME/launchctl.calls"\n[[ $1 != print ]]');
  const started = Date.now();
  const result = f.run(undefined, []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /loaded, held by the dialog watcher \(held at .*SecurityAgent.*\): ci-kit-mac-mini starts when the episode closes/);
  assert.ok(Date.now() - started < 10_000);
  assert.ok(existsSync(marker), 'the hold is the watcher’s to release');
});

test('a job found by its executable path refuses a re-run and an uninstall', macOnly, async () => {
  const f = fixture();
  const worker = join(f.runner, 'bin/Runner.Worker');
  copyFileSync(process.execPath, worker, constants.COPYFILE_FICLONE);
  const job = spawn(worker, ['-e', "console.log('running'); setTimeout(() => {}, 30_000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(job.stdout, 'data'); // it has exec'd: the check cannot see its parent's image
    for (const args of [[], ['--disabled'], ['--uninstall']]) {
      const result = f.run(undefined, args);
      assert.equal(result.status, 1, `${args}: ${result.stderr}`);
      assert.match(result.stderr, /a job is running on this runner; re-run when it is idle/);
    }
    assert.equal(existsSync(join(f.home, 'launchctl.calls')), false, 'nothing reloaded');
  } finally {
    job.kill('SIGKILL');
  }
});

test('--uninstall unloads and removes both LaunchAgents and the marker, and keeps the registration and hooks', macOnly, () => {
  const f = fixture();
  assert.equal(f.run().status, 0);
  const marker = join(f.home, 'Library/Logs/ci-kit/runner-drained');
  writeFileSync(marker, 'stopped\n');
  rmSync(join(f.home, 'launchctl.calls'));
  const result = f.run(undefined, ['--uninstall']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /uninstalled: .* the registration and .* stay/);
  const domain = `gui/${uidOf()}`;
  assert.deepEqual(calls(f).filter((call) => call.startsWith('bootout')), [`bootout ${domain}/${watchAgent}`, `bootout ${domain}/${runnerAgent}`]);
  assert.ok(!calls(f).some((call) => call.startsWith('bootstrap')));
  for (const agent of [watchAgent, runnerAgent]) assert.equal(existsSync(join(f.home, `Library/LaunchAgents/${agent}.plist`)), false);
  assert.equal(existsSync(marker), false);
  assert.ok(existsSync(join(f.runner, '.runner')));
  assertNewHooks(f);
  assert.equal(f.run(undefined, ['--uninstall', '--name', 'ci-kit-mac-mini']).status, 2, '--uninstall takes nothing else');
});

// Shared instances (--shared, mac/hooks/instances.sh).
const sharedAgent = (n) => `${runnerAgent}-${n}`;
const argsOf = (dir) => readFileSync(join(dir, 'config.args'), 'utf8').trim().split('\n');
// The labels a runner registers with: the defaults (self-hosted, macOS, ARM64) unless --no-default-labels, then --labels.
function labelsOf(args) {
  const own = args[args.indexOf('--labels') + 1].split(',');
  return args.includes('--no-default-labels') ? own : ['self-hosted', 'macOS', 'ARM64', ...own];
}
// GitHub gives a job to a runner that carries every label the job asks for, case-insensitively.
const reaches = (runsOn, labels) => [runsOn].flat().every((label) => labels.some((own) => own.toLowerCase() === label.toLowerCase()));

test('--shared 2 registers two shared instances, named after the machine, each with its own hooks and environment, installed disabled', macOnly, () => {
  const f = fixture();
  const dirs = [f.shared(2), f.shared(3)];
  const result = f.run(undefined, ['--shared', '2'], {}, 'registration-token-123\n');
  assert.equal(result.status, 0, result.stderr);
  const domain = `gui/${uidOf()}`;
  dirs.forEach((dir, i) => {
    const n = i + 2;
    const args = argsOf(dir);
    assert.equal(args[args.indexOf('--name') + 1], `ci-kit-mac-mini-${n}`);
    assert.ok(!args.some((arg) => arg.includes('registration-token-123')), 'the token is not an argument');
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), [
      'LANG=en_US.UTF-8', `ACTIONS_RUNNER_HOOK_JOB_STARTED=${dir}/ci-kit/hooks/job-started.sh`,
      `ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${dir}/ci-kit/hooks/job-completed.sh`, 'CI_KIT_MACHINE=mini', 'CI_KIT_SHARED_DESKTOP=1', '',
    ].join('\n'));
    for (const file of hookFiles) assert.equal(readFileSync(join(dir, 'ci-kit/hooks', file), 'utf8'), readFileSync(join(f.kit, 'mac/hooks', file), 'utf8'), `${n}: ${file}`);
    const plist = readPlist(join(f.home, `Library/LaunchAgents/${sharedAgent(n)}.plist`));
    assert.equal(plist.Label, sharedAgent(n));
    assert.deepEqual(plist.ProgramArguments, ['/bin/bash', join(dir, 'ci-kit/hooks/runner-hold.sh')]);
    assert.equal(plist.WorkingDirectory, dir);
    assert.equal(plist.StandardOutPath, join(f.home, `Library/Logs/ci-kit/mac-runner-${n}.out.log`));
    assert.ok(calls(f).includes(`disable ${domain}/${sharedAgent(n)}`));
    assert.ok(!calls(f).includes(`bootstrap ${domain} ${join(f.home, `Library/LaunchAgents/${sharedAgent(n)}.plist`)}`), 'a new shared instance starts disabled');
    assert.match(result.stdout, new RegExp(`installed, disabled: ci-kit-mac-mini-${n} \\(${sharedAgent(n)}\\) is not loaded`));
  });
  // The exclusive instance is today's.
  assert.equal(readFileSync(join(f.runner, '.env'), 'utf8'), envFile(f, 'mini'));
  assert.equal(readPlist(join(f.home, `Library/LaunchAgents/${runnerAgent}.plist`)).StandardOutPath, join(f.home, 'Library/Logs/ci-kit/mac-runner.out.log'));
  assert.match(result.stdout, /running: ci-kit-mac-mini listens for jobs of https:\/\/github.com\/SSFSKIM\/MAWS\n/);
  assertNewHooks(f);
});

test('a shared runner carries ci-kit-mac-shared alone: no job written for the exclusive instance, nor a bare self-hosted one, reaches it', macOnly, () => {
  const f = fixture({ registered: null });
  const dir = f.shared(2);
  const result = f.run(undefined, ['--name', 'ci-kit-mac-mini', '--shared', '1'], {}, 'registration-token-123\n');
  assert.equal(result.status, 0, result.stderr);
  const exclusive = labelsOf(argsOf(f.runner));
  const shared = labelsOf(argsOf(dir));
  assert.deepEqual(shared, ['ci-kit-mac-shared']);
  for (const runsOn of [['self-hosted', 'macOS', 'ARM64'], ['self-hosted', 'macOS', 'ARM64', 'ci-kit-mac'], 'self-hosted', ['self-hosted'], ['macOS'], ['self-hosted', 'ci-kit-mac-shared']]) {
    assert.ok(!reaches(runsOn, shared), `${runsOn} must not reach a shared runner`);
  }
  assert.ok(reaches(['ci-kit-mac-shared'], shared));
  assert.ok(reaches(['self-hosted', 'macOS', 'ARM64'], exclusive), "today's jobs reach the exclusive instance");
  assert.ok(!reaches(['ci-kit-mac-shared'], exclusive), 'a shared job never reaches the exclusive instance');
});

test('a re-run keeps the installed count and each shared instance\'s enabled state; --shared lowers it, keeping registrations', macOnly, () => {
  const f = fixture();
  const dirs = [f.shared(2), f.shared(3)];
  assert.equal(f.run(undefined, ['--shared', '2'], {}, 'registration-token-123\n').status, 0);
  const domain = `gui/${uidOf()}`;
  const plist = (n) => join(f.home, `Library/LaunchAgents/${sharedAgent(n)}.plist`);
  // A trial window: shared runner 2 enabled by hand.
  spawnSync(join(f.bin, 'launchctl'), ['enable', `${domain}/${sharedAgent(2)}`], { env: f.env });
  rmSync(join(f.home, 'launchctl.calls'));
  const refresh = f.run(undefined, []);
  assert.equal(refresh.status, 0, refresh.stderr);
  assert.ok(calls(f).includes(`bootstrap ${domain} ${plist(2)}`), 'the enabled one is reloaded');
  assert.ok(calls(f).includes(`disable ${domain}/${sharedAgent(3)}`) && !calls(f).includes(`bootstrap ${domain} ${plist(3)}`), 'the disabled one stays off');
  assert.match(refresh.stdout, /running: ci-kit-mac-mini-2 listens for jobs of https:\/\/github.com\/SSFSKIM\/MAWS that ask for ci-kit-mac-shared/);
  // A state launchd cannot report counts as disabled.
  rmSync(join(f.home, 'launchctl.db'));
  rmSync(join(f.home, 'launchctl.calls'));
  assert.equal(f.run(undefined, []).status, 0);
  assert.ok(!calls(f).some((call) => call.startsWith(`bootstrap ${domain} ${plist(2)}`)));
  // Down to one: the third's agent goes, its registration and directory stay.
  rmSync(join(f.home, 'launchctl.calls'));
  const lowered = f.run(undefined, ['--shared', '1']);
  assert.equal(lowered.status, 0, lowered.stderr);
  assert.ok(calls(f).includes(`bootout ${domain}/${sharedAgent(3)}`));
  assert.equal(existsSync(plist(3)), false);
  assert.ok(existsSync(join(dirs[1], '.runner')));
  assert.match(lowered.stdout, new RegExp(`removed: ${sharedAgent(3)} is unloaded and its LaunchAgent removed; its registration and ${dirs[1]} stay`));
  rmSync(join(f.home, 'launchctl.calls'));
  assert.equal(f.run(undefined, []).status, 0);
  assert.ok(!calls(f).some((call) => call.includes(sharedAgent(3))), 'a re-run keeps the lowered count');
  // --disabled turns every instance off.
  assert.equal(f.run(undefined, ['--disabled']).status, 0);
  for (const agent of [runnerAgent, sharedAgent(2)]) assert.ok(calls(f).includes(`disable ${domain}/${agent}`), agent);
});

test('shared names: a machine short name ending in -<number> is refused, and so is a shared instance registered under another name', macOnly, () => {
  for (const [registered, args, input, refusal] of [
    [null, ['--name', 'ci-kit-mac-mini-2'], 'registration-token-123\n', /short name, 'mini-2', ends in -<number>/],
    ['ci-kit-mac-rental-1', ['--shared', '1'], 'registration-token-123\n', /short name, 'rental-1', ends in -<number>/],
  ]) {
    const f = fixture({ registered });
    const before = f.snapshot();
    const result = f.run(undefined, args, {}, input);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, refusal);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(existsSync(join(f.home, 'launchctl.calls')), false);
  }
  // Already registered with no shared instance, such a name keeps working as it did.
  assert.equal(fixture({ registered: 'ci-kit-mac-rental-1' }).run(undefined, ['--disabled']).status, 0);
  const f = fixture();
  f.shared(2, 'ci-kit-mac-other-2');
  const result = f.run(undefined, ['--shared', '1']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /actions-runner-maws-2 is registered as 'ci-kit-mac-other-2', not ci-kit-mac-mini-2/);
  assert.match(f.run(undefined, ['--shared', '9']).stderr, /--shared takes a count of shared instances, 0 to 8/);
});

test('a job on a shared instance refuses a re-run and an uninstall; --uninstall removes every instance\'s agent', macOnly, async () => {
  const f = fixture();
  const dir = f.shared(2);
  assert.equal(f.run(undefined, ['--shared', '1'], {}, 'registration-token-123\n').status, 0);
  const worker = join(dir, 'bin/Runner.Worker');
  copyFileSync(process.execPath, worker, constants.COPYFILE_FICLONE);
  const job = spawn(worker, ['-e', "console.log('running'); setTimeout(() => {}, 30_000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(job.stdout, 'data');
    for (const args of [[], ['--uninstall']]) {
      const result = f.run(undefined, args);
      assert.equal(result.status, 1, `${args}: ${result.stderr}`);
      assert.match(result.stderr, /a job is running on shared runner 2; re-run when every instance is idle/);
    }
  } finally {
    job.kill('SIGKILL');
    await once(job, 'exit');
  }
  rmSync(join(f.home, 'launchctl.calls'));
  const result = f.run(undefined, ['--uninstall']);
  assert.equal(result.status, 0, result.stderr);
  const domain = `gui/${uidOf()}`;
  assert.deepEqual(calls(f).filter((call) => call.startsWith('bootout')), [`bootout ${domain}/${watchAgent}`, `bootout ${domain}/${runnerAgent}`, `bootout ${domain}/${sharedAgent(2)}`]);
  for (const agent of [runnerAgent, sharedAgent(2)]) assert.equal(existsSync(join(f.home, `Library/LaunchAgents/${agent}.plist`)), false);
  assert.match(result.stdout, new RegExp(`uninstalled: ${watchAgent} and ${runnerAgent}, ${sharedAgent(2)} are unloaded and removed`));
  assert.ok(existsSync(join(dir, '.runner')));
});

test('an install with no shared instance asks launchd nothing new and lays down nothing shared', macOnly, () => {
  const f = fixture();
  const result = f.run(undefined, []);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!calls(f).some((call) => call.startsWith('print-disabled') || call.includes(`${runnerAgent}-`)), calls(f).join('\n'));
  assert.ok(!readdirSync(f.home).some((name) => name.startsWith('actions-runner-maws-')));
  assert.equal(result.stdout.match(/^ci-kit mac: (running|installed|loaded)/gm).length, 1);
});
