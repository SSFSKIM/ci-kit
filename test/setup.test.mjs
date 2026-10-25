import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseConfig } from '../plan/config.mjs';
import { planOutput } from '../plan/select.mjs';
import { parse } from '../vendor/yaml/dist/index.js';
import { setupHash } from '../setup/hash.mjs';

const APPLY = new URL('../setup/apply.mjs', import.meta.url);
const ACTION = fileURLToPath(new URL('../setup/index.mjs', import.meta.url));
const setup = (fields = {}) => ({ apt: [], brew: [], cask: [], node: '', pnpm: false, install: '', script: '', fetch_depth: 1, ...fields });

test('the shared hash is canonical, content-sensitive, and excludes only fetch_depth', () => {
  const declaration = setup({ apt: ['zsh', 'cowsay', 'zsh'], brew: ['hello'], cask: ['app'], script: 'setup.sh', node: '22', pnpm: true, install: 'npm ci' });
  const bytes = Buffer.from('echo ready\n');
  const canonical = { apt: ['cowsay', 'zsh'], brew: ['hello'], cask: ['app'], node: '22', pnpm: true, install: 'npm ci', script: 'setup.sh', script_sha256: createHash('sha256').update(bytes).digest('hex') };
  const hash = setupHash(declaration, bytes);
  assert.equal(hash, createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16));
  assert.equal(hash, setupHash({ ...Object.fromEntries(Object.entries(declaration).reverse()), apt: ['cowsay', 'zsh'], fetch_depth: 0 }, bytes));
  for (const [key, value] of Object.entries({ apt: ['zsh'], brew: ['other'], cask: ['other'], node: '24', pnpm: false, install: 'npm install', script: 'other.sh' })) {
    assert.notEqual(hash, setupHash({ ...declaration, [key]: value }, bytes), key);
  }
  assert.notEqual(hash, setupHash(declaration, Buffer.from('echo changed\n')));
  assert.equal(setupHash(setup({ node: '22', install: 'npm ci' })), 'none');
  assert.throws(() => setupHash(declaration), /script/i, 'a script cannot silently hash as empty when its bytes were not read');
});

// The executable seam replaces package-manager commands, never the applier. Every call records its argv and the
// noninteractive environment. Scripts and install commands are real bash processes in a temporary checkout.
function fixture(t, fields, state = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-kit-setup-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.github'));
  writeFileSync(join(root, '.github/ci-kit.yml'), JSON.stringify({ version: 1, setup: fields, gates: [{ name: 'unit', run: 'true' }] }));
  writeFileSync(join(root, 'state.json'), JSON.stringify(state));
  const shim = `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const root = process.env.FIXTURE;
const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json')));
fs.appendFileSync(path.join(root, 'calls'), JSON.stringify({name, args, frontend: process.env.DEBIAN_FRONTEND, noninteractive: process.env.NONINTERACTIVE}) + '\\n');
if (name === 'sudo') {
  if (args.shift() !== '-n') process.exit(99);
  if (args[0] === '--') args.shift();
  const r = cp.spawnSync(args.shift(), args, {stdio: 'inherit', env: process.env});
  process.exit(r.status ?? 99);
}
let out = '', err = '', code = 0;
if (name === 'dpkg-query') { out = state.dpkg ?? ''; code = state.queryCode ?? 0; }
if (name === 'apt-get') { if (args[0] === 'install') { err = state.aptError ?? ''; code = err ? 1 : 0; } }
if (name === 'brew') {
  if (args[0] === 'info') out = JSON.stringify({formulae: state.formulae ?? [], casks: state.casks ?? []});
  else if (args[0] === 'list') out = state.artifacts ?? '';
  else if (args[0] === 'install') { err = state.brewError ?? ''; code = err ? 1 : 0; }
  if (['list', 'info'].includes(args[0]) && state.queryCode) code = state.queryCode;
}
if (name === 'xattr') { code = (state.quarantined ?? []).includes(args.at(-1)) ? 0 : 1; out = code ? '' : '0081;test'; }
process.stdout.write(out); process.stderr.write(err); process.exit(code);
`;
  const env = { ...process.env, FIXTURE: root, CI_KIT_SETUP_HASH: '', GITHUB_OUTPUT: '', CI: '', CI_KIT_SETUP_MODE: '', INPUT_ROOT: root, INPUT_INSTALL: 'false' };
  for (const [name, key] of Object.entries({ 'dpkg-query': 'DPKG_QUERY', 'apt-get': 'APT_GET', sudo: 'SUDO', brew: 'BREW', xattr: 'XATTR' })) {
    const path = join(root, name);
    writeFileSync(path, shim, { mode: 0o755 });
    env[`CI_KIT_SETUP_${key}`] = path;
  }
  return {
    root, env,
    calls: () => existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse) : [],
    run(options = {}, extraEnv = {}) {
      const program = `import { applySetup } from ${JSON.stringify(APPLY.href)};
try { const result = await applySetup(${JSON.stringify({ root, platform: 'linux', ...options })}); console.log('RESULT=' + JSON.stringify(result)); }
catch (e) { console.error(e.message); process.exitCode = 1; }`;
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', program], { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8' });
      return { ...r, result: r.status === 0 ? JSON.parse(r.stdout.match(/^RESULT=(.*)$/m)[1]) : null };
    },
    script(text) { writeFileSync(join(root, 'setup.sh'), text); },
  };
}
const successful = (r) => assert.equal(r.status, 0, r.stderr + r.stdout);

test('Linux checks once, ignores residual config, and installs only missing names, without interactive sudo', (t) => {
  const f = fixture(t, { apt: ['zsh', 'cowsay', 'cowsay'], brew: ['hello'], cask: ['app'] }, { dpkg: 'zsh\tinstalled\ncowsay\tconfig-files\n' });
  const r = f.run();
  successful(r);
  assert.equal(r.result.installed, 'apt:cowsay');
  assert.equal(r.result.stale, false);
  const calls = f.calls();
  assert.equal(calls.filter((c) => c.name === 'dpkg-query').length, 1);
  assert.equal(calls.filter((c) => c.name === 'brew').length, 0);
  assert.deepEqual(calls.filter((c) => c.name === 'apt-get').map((c) => c.args), [['update'], ['install', '-y', '--no-install-recommends', 'cowsay']]);
  assert.equal(calls.find((c) => c.name === 'apt-get' && c.args[0] === 'install').frontend, 'noninteractive');
  assert.match(r.stdout, /ci-kit setup: declared apt 2, brew 0, cask 0, script no; installed apt:cowsay in [\d.]+ s/);
});

test('a matching image still checks packages and runs the script, but needs no install', (t) => {
  const fields = { apt: ['zsh'], script: 'setup.sh' };
  const f = fixture(t, fields, { dpkg: 'zsh\tinstalled\n' });
  f.script('printf "%s %s %s" "$CI" "$CI_KIT_SETUP_MODE" "$PWD" > script-result');
  const hash = setupHash(setup(fields), readFileSync(join(f.root, 'setup.sh')));
  const r = f.run({}, { CI_KIT_SETUP_HASH: hash });
  successful(r);
  assert.equal(r.result.hash, hash);
  assert.equal(r.result.stale, false);
  assert.equal(r.result.installed, '');
  assert.match(r.stdout, new RegExp(`ci-kit setup: image matches setup ${hash}`));
  assert.match(r.stdout, /installed nothing/);
  assert.equal(readFileSync(join(f.root, 'script-result'), 'utf8'), `true job ${f.root}`);
  assert.deepEqual(f.calls().map((c) => c.name), ['dpkg-query']);
});

test('a stale image names both hashes and still installs the difference', (t) => {
  const f = fixture(t, { apt: ['cowsay'] });
  const r = f.run({}, { CI_KIT_SETUP_HASH: '0123456789abcdef' });
  successful(r);
  assert.equal(r.result.stale, true);
  assert.match(r.stdout, new RegExp(`::notice::.*0123456789abcdef.*${r.result.hash}`));
  assert.equal(r.result.installed, 'apt:cowsay');
});

test('macOS checks each list once, understands full names, and reports quarantined newly installed apps', (t) => {
  const f = fixture(t, { apt: ['zsh'], brew: ['hello', 'owner/tap/tool', 'homebrew/core/poppler'], cask: ['old-app', 'new-app'] }, {
    formulae: [
      { name: 'tool', full_name: 'owner/tap/tool', tap: 'owner/tap', aliases: [], oldnames: [], installed: [{ version: '1.0' }] },
      { name: 'poppler', full_name: 'poppler', tap: 'homebrew/core', aliases: [], oldnames: [], installed: [{ version: '1.0' }] },
    ],
    casks: [{ token: 'old-app', full_token: 'old-app', tap: 'homebrew/cask', old_tokens: [], installed: '1.0' }],
  });
  const app = join(f.root, 'Applications/New App.app');
  const approved = join(f.root, 'Applications/Approved.app');
  const link = join(f.root, 'Caskroom/new-app/1/New App.app');
  mkdirSync(app, { recursive: true });
  mkdirSync(approved, { recursive: true });
  mkdirSync(join(f.root, 'Caskroom/new-app/1'), { recursive: true });
  symlinkSync(app, link);
  const state = JSON.parse(readFileSync(join(f.root, 'state.json'), 'utf8'));
  writeFileSync(join(f.root, 'state.json'), JSON.stringify({ ...state,
    artifacts: `==> App\n${link} (12 files, 2MB)\n${approved} (3 files)\n==> Binary\n/usr/local/bin/new-app\n`, quarantined: [app],
  }));
  const r = f.run({ platform: 'darwin' });
  successful(r);
  assert.equal(r.result.installed, 'brew:hello cask:new-app');
  assert.deepEqual(r.result.quarantined, [app]);
  assert.deepEqual(f.calls().filter((c) => c.name === 'xattr').map((c) => c.args.at(-1)), [app, approved]);
  assert.doesNotMatch(r.stdout, /Caskroom/);
  const calls = f.calls();
  assert.equal(calls.filter((c) => c.name === 'brew' && c.args[0] === 'info').length, 2);
  assert.deepEqual(calls.filter((c) => c.name === 'brew' && c.args[0] === 'install').map((c) => c.args), [['install', 'hello'], ['install', '--cask', 'new-app']]);
  assert.ok(calls.filter((c) => c.name === 'brew' && c.args[0] === 'install').every((c) => c.noninteractive === '1'));
  assert.equal(calls.filter((c) => ['dpkg-query', 'apt-get', 'sudo'].includes(c.name)).length, 0);
  assert.match(r.stdout, /::warning::.*\/Applications\/New App\.app.*first.run/);
  assert.match(r.stdout, /declared apt 0, brew 3, cask 2, script no/);
});

for (const message of ['sudo: a terminal is required to read the password', 'Password:', 'sudo: a password is required']) {
  test(`a cask requiring privilege fails promptly with manual-install guidance: ${message}`, (t) => {
    const f = fixture(t, { cask: ['privileged-app'] }, { brewError: message });
    const r = f.run({ platform: 'darwin' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cask.*privileged-app.*administrator.*manual/i);
  });
}

test('a package-manager query failure is not mistaken for an empty image', (t) => {
  const f = fixture(t, { apt: ['zsh'], brew: ['hello'] }, { queryCode: 2 });
  for (const platform of ['linux', 'darwin']) {
    const r = f.run({ platform });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /presence|list|query/i);
  }
  assert.equal(f.calls().filter((c) => c.args[0] === 'install').length, 0);
});

test('failed installs name the declared packages', (t) => {
  const f = fixture(t, { apt: ['missing'], brew: ['missing'] }, { aptError: 'not found', brewError: 'not found' });
  for (const platform of ['linux', 'darwin']) {
    const r = f.run({ platform });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing.*not found/s);
  }
});

test('missing or failed scripts fail naming the script, before install', (t) => {
  const f = fixture(t, { script: 'setup.sh', install: 'touch installed' });
  const missing = f.run({ install: true });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /setup.sh/);
  f.script('exit 7');
  const failed = f.run({ install: true });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /setup.sh.*7/);
  assert.equal(existsSync(join(f.root, 'installed')), false);
});

test('install is opt-in and runs after the script; a failed install fails the step', (t) => {
  const f = fixture(t, { script: 'setup.sh', install: 'test -f ready && printf "$CI_KIT_SETUP_MODE" > installed && exit 9' });
  f.script('touch ready');
  successful(f.run());
  assert.equal(existsSync(join(f.root, 'installed')), false);
  const r = f.run({ install: true, mode: 'bake' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /setup.install.*9/);
  assert.equal(readFileSync(join(f.root, 'installed'), 'utf8'), 'bake');
});

test('the bake CLI uses the clone root, runs install after the script, and rejects unknown modes', (t) => {
  const f = fixture(t, { script: 'setup.sh', install: 'cat ready > installed' });
  f.script('printf "%s %s" "$CI" "$CI_KIT_SETUP_MODE" > ready');
  const args = [fileURLToPath(APPLY), '--mode', 'bake', '--root', f.root, '--install'];
  successful(spawnSync(process.execPath, args, { env: f.env, encoding: 'utf8', cwd: tmpdir() }));
  assert.equal(readFileSync(join(f.root, 'installed'), 'utf8'), 'true bake');
  const invalid = spawnSync(process.execPath, [fileURLToPath(APPLY), '--mode', 'typo', '--root', f.root], { env: f.env, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /mode/);
});

test('the JavaScript action defaults to the workspace, writes outputs, and honors install true/false', (t) => {
  const f = fixture(t, { script: 'setup.sh', install: 'cat ready > installed' });
  f.script('echo ready > ready');
  const output = join(f.root, 'outputs');
  const env = { ...f.env, INPUT_ROOT: '', GITHUB_WORKSPACE: f.root, GITHUB_OUTPUT: output, CI_KIT_SETUP_HASH: 'old-image' };
  successful(spawnSync(process.execPath, [ACTION], { env, encoding: 'utf8', cwd: tmpdir() }));
  assert.equal(existsSync(join(f.root, 'installed')), false);
  assert.match(readFileSync(output, 'utf8'), /^hash=[a-f0-9]{16}\ninstalled=\nstale=true\n$/);
  successful(spawnSync(process.execPath, [ACTION], { env: { ...env, INPUT_INSTALL: 'true' }, encoding: 'utf8' }));
  assert.equal(readFileSync(join(f.root, 'installed'), 'utf8'), 'ready\n');
});

test('the action manifest uses the runner Node and a resolvable entrypoint', () => {
  const action = parse(readFileSync(new URL('../setup/action.yml', import.meta.url), 'utf8'));
  assert.equal(action.runs.using, 'node24');
  assert.ok(existsSync(new URL(`../setup/${action.runs.main}`, import.meta.url)));
  assert.equal(action.inputs.install.default, 'false');
  assert.deepEqual(Object.keys(action.outputs).sort(), ['hash', 'installed', 'stale']);
});

test('the gates workflow applies only actual declarations and respects setup false, between tools and install', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/gates.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.gate.steps;
  const at = steps.findIndex((s) => s.uses === 'SSFSKIM/ci-kit/setup@v1');
  assert.ok(at > steps.findIndex((s) => s.name === 'Enable pnpm'));
  assert.ok(at < steps.findIndex((s) => s.name === 'Install'));
  // The condition's operators and join have the same behavior here as GitHub's expression language; exercise it
  // against the planner's real output, including the disabled gate's setup rather than a handwritten matrix.
  const enabled = (gate) => Boolean(Function('matrix', 'join', `return (${steps[at].if});`)({ gate }, (list, sep) => (list ?? []).join(sep)));
  for (const declaration of ['', 'apt: [cowsay]', 'brew: [hello]', 'cask: [app]', 'script: setup.sh']) {
    const config = parseConfig(`version: 1\nsetup: {node: "22"${declaration ? ', ' + declaration : ''}}\ngates: [{name: yes, run: "true"}, {name: no, run: "true", setup: false}]`, { isPrivate: true });
    const [yes, no] = planOutput(config, config.gates).gates;
    assert.equal(enabled(yes), Boolean(declaration), declaration);
    assert.equal(enabled(no), false, declaration);
  }
});

test('a setup-only file produces a successful empty plan', () => {
  const config = parseConfig('version: 1\nsetup: {apt: [cowsay]}', { isPrivate: false });
  assert.deepEqual(planOutput(config, config.gates), { gates: [], pool: false, note: 'no gates selected', cache_write: false });
});

test('installed apt providers satisfy virtual names, including versioned Provides, without update or install', (t) => {
  const f = fixture(t, { apt: ['awk', 'libasound2'] }, {
    dpkg: 'mawk\tinstalled\tawk\nlibasound2t64\tinstalled\tlibasound2 (= 1.2.11-1), libasound2-virtual\n',
  });
  const r = f.run();
  successful(r);
  assert.equal(r.result.installed, '');
  assert.deepEqual(f.calls().map((c) => c.name), ['dpkg-query']);
  assert.ok(f.calls()[0].args.some((arg) => arg.includes('${Provides}')));
  assert.match(r.stdout, /installed nothing/);
});

test('residual apt provider configuration does not satisfy its virtual names', (t) => {
  const f = fixture(t, { apt: ['awk'] }, { dpkg: 'mawk\tconfig-files\tawk\n' });
  const r = f.run();
  successful(r);
  assert.equal(r.result.installed, 'apt:awk');
});

const pkgconf = {
  name: 'pkgconf', full_name: 'pkgconf', tap: 'homebrew/core', aliases: ['pkg-config'], oldnames: ['old-pkgconf'],
  installed: [{ version: '2.1.0', used_options: [], built_as_bottle: true, poured_from_bottle: true, runtime_dependencies: [], installed_as_dependency: false, installed_on_request: true }],
  versions: { stable: '2.4.3', head: 'HEAD', bottle: true }, outdated: true,
};

test('Homebrew aliases and old names of an outdated installed formula and cask cause no upgrade', (t) => {
  const f = fixture(t, { brew: ['pkgconf', 'pkg-config', 'old-pkgconf', 'homebrew/core/pkg-config'], cask: ['new-app', 'old-app', 'homebrew/cask/old-app'] }, {
    formulae: [pkgconf],
    casks: [{ token: 'new-app', full_token: 'new-app', tap: 'homebrew/cask', old_tokens: ['old-app'], installed: '1.0', version: '2.0', outdated: true }],
  });
  const r = f.run({ platform: 'darwin' });
  successful(r);
  assert.equal(r.result.installed, '');
  assert.deepEqual(f.calls().map((c) => [c.name, c.args]), [
    ['brew', ['info', '--json=v2', '--installed', '--formula']],
    ['brew', ['info', '--json=v2', '--installed', '--cask']],
  ]);
});

test('an unknown Homebrew name stays missing while an installed alias in the same list stays untouched', (t) => {
  const f = fixture(t, { brew: ['pkg-config', 'no-such-name'] }, {
    formulae: [pkgconf], brewError: 'No available formula with the name "no-such-name"',
  });
  const r = f.run({ platform: 'darwin' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No available formula with the name "no-such-name"/);
  assert.deepEqual(f.calls().filter((c) => c.args[0] === 'install').map((c) => c.args), [['install', 'no-such-name']]);
});

test('Homebrew qualified aliases retain their tap identity', (t) => {
  const f = fixture(t, { brew: ['owner/tap/tool-alias', 'tool-alias', 'other/tap/tool-alias'] }, {
    formulae: [{ name: 'tool', full_name: 'owner/tap/tool', tap: 'owner/tap', aliases: ['tool-alias'], oldnames: [], installed: [{ version: '1.0' }], outdated: false }],
  });
  const r = f.run({ platform: 'darwin' });
  successful(r);
  assert.equal(r.result.installed, 'brew:other/tap/tool-alias');
});
