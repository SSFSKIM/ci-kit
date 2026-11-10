// The package cache (docs/adopting.md, "Package cache") as gates.yml runs it. Its steps' bash runs here for real, with
// sudo and apt-get replaced by recording fakes: the apt configuration and key they write, and the warm job's pruning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../vendor/yaml/dist/index.js';
import { parseConfig } from '../plan/config.mjs';
import { planOutput } from '../plan/select.mjs';

const workflow = parse(readFileSync(new URL('../.github/workflows/gates.yml', import.meta.url), 'utf8'));
const gate = workflow.jobs.gate.steps;
const warm = workflow.jobs['package-cache'];
const step = (steps, name) => {
  const found = steps.find((s) => s.name === name);
  assert.ok(found, `no step "${name}"`);
  return found;
};
// GitHub's expression operators and join behave here as in JavaScript, for the values these conditions compare.
const evaluate = (expression, context) => Boolean(Function(...Object.keys(context), 'join', `return (${expression});`)(
  ...Object.values(context), (list, sep) => (list ?? []).join(sep)));

function sandbox(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-kit-package-cache-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'temp'));
  // sudo runs its command, except a tee into /etc, which lands in the sandbox instead.
  writeFileSync(join(bin, 'sudo'), `#!/usr/bin/env bash
echo "sudo $*" >> "$FIXTURE/calls"
if [ "$1" = tee ]; then cat > "$FIXTURE/apt.conf"; echo "$2" > "$FIXTURE/apt.conf.path"; exit 0; fi
exec "$@"
`, { mode: 0o755 });
  // apt-get knows the set's packages from $FIXTURE/needed. --print-uris lists them, downloads go to the configured
  // archive directory: the one -o names, else the cache directory the drop-in names.
  writeFileSync(join(bin, 'apt-get'), `#!/usr/bin/env bash
echo "apt-get $*" >> "$FIXTURE/calls"
archives="$RUNNER_TEMP/ci-kit-apt/"
for arg in "$@"; do case $arg in Dir::Cache::Archives=*) archives=\${arg#*=} ;; esac; done
case " $* " in
  *" --print-uris "*)
    [ -z "$(ls -A "$archives" | grep -v '^partial$')" ] || { echo "print-uris against a non-empty $archives" >&2; exit 3; }
    while read -r deb; do echo "'http://mirror/$deb' $deb 100 SHA256:00"; done < "$FIXTURE/needed" ;;
  *" --download-only "*)
    while read -r deb; do
      [ -e "$archives$deb" ] || { echo "$deb" >> "$FIXTURE/fetched"; touch "$archives$deb"; }
    done < "$FIXTURE/needed" ;;
esac
`, { mode: 0o755 });
  const output = join(root, 'output');
  const env = {
    PATH: `${bin}:${process.env.PATH}`, FIXTURE: root, RUNNER_TEMP: join(root, 'temp'), GITHUB_OUTPUT: output,
    ImageOS: 'ubuntu24', ImageVersion: '20261102.1.0', RUNNER_ARCH: 'X64',
  };
  const read = (name) => existsSync(join(root, name)) ? readFileSync(join(root, name), 'utf8') : '';
  return {
    root, env,
    run(script, extra = {}) {
      const r = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], { env: { ...env, ...extra }, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r;
    },
    outputs: () => Object.fromEntries(read('output').trim().split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2))),
    calls: () => read('calls').trim().split('\n').filter(Boolean),
    fetched: () => read('fetched').trim().split('\n').filter(Boolean),
    read,
  };
}

test('a hosted Linux gate with apt packages points apt at the package cache and restores it before the setup step', () => {
  const names = gate.map((s) => s.name);
  const at = names.indexOf('Apply CI environment');
  assert.ok(names.indexOf('Point apt at the package cache') < names.indexOf('Restore the package cache'));
  assert.ok(names.indexOf('Restore the package cache') < at);
  const point = step(gate, 'Point apt at the package cache');
  const config = parseConfig('version: 1\nsetup: {apt: [cowsay]}\ngates: [{name: yes, run: "true"}, {name: no, run: "true", setup: false}]', { isPrivate: true });
  const plan = planOutput(config, config.gates);
  const [yes, no] = plan.gates;
  const needs = { plan: { outputs: { apt_cache: plan.apt_cache } } };
  const hosted = { environment: 'github-hosted', os: 'Linux' };
  assert.equal(evaluate(point.if, { runner: hosted, needs, matrix: { gate: yes } }), true);
  assert.equal(evaluate(point.if, { runner: hosted, needs, matrix: { gate: no } }), false, 'setup: false');
  assert.equal(evaluate(point.if, { runner: { environment: 'self-hosted', os: 'Linux' }, needs, matrix: { gate: yes } }), false,
    'a self-hosted runner keeps its own apt configuration');
  assert.equal(evaluate(point.if, { runner: { environment: 'github-hosted', os: 'macOS' }, needs, matrix: { gate: yes } }), false);
  const restore = step(gate, 'Restore the package cache');
  assert.match(restore.uses, /^actions\/cache\/restore@v\d+$/);
  assert.equal(restore.if, "steps.apt-cache.outcome == 'success'");
});

test('the apt configuration step writes the drop-in, the directory and the keys', (t) => {
  const s = sandbox(t);
  const point = step(gate, 'Point apt at the package cache');
  s.run(point.run, { CI_KIT_APT_CACHE: '0123456789abcdef' });
  const dir = join(s.env.RUNNER_TEMP, 'ci-kit-apt');
  assert.ok(existsSync(dir));
  assert.equal(s.read('apt.conf.path').trim(), '/etc/apt/apt.conf.d/90ci-kit-package-cache');
  assert.equal(s.read('apt.conf'), `Dir::Cache::Archives "${dir}/";\nAPT::Sandbox::User "root";\n`);
  assert.deepEqual(s.outputs(), {
    key: 'ci-kit-apt-1-ubuntu24-X64-0123456789abcdef-20261102.1.0',
    set: 'ci-kit-apt-1-ubuntu24-X64-0123456789abcdef-',
    any: 'ci-kit-apt-1-ubuntu24-X64-',
  });
});

test('the warm job saves on the default branch, from the hosted lane runner, the same files the gates restore', () => {
  assert.equal(warm.if, "needs.plan.outputs.apt_warm != '[]' && needs.plan.outputs.apt_warm != ''");
  const hosted = parseConfig('version: 1\ngates: [{name: a, run: x}]', { isPrivate: false });
  assert.deepEqual([warm['runs-on']], planOutput(hosted, hosted.gates).gates[0].runs_on, 'the key names the image the hosted gates run on');
  assert.equal(warm['continue-on-error'], true, 'a failed warm leaves the run green');
  assert.ok(!(workflow.jobs.verdict.needs ?? []).includes('package-cache'));
  const point = step(warm.steps, 'Point apt at the package cache');
  assert.equal(point.run, step(gate, 'Point apt at the package cache').run, 'gates and warm job compute one key');
  const restore = step(gate, 'Restore the package cache');
  const save = step(warm.steps, 'Save the package cache');
  assert.match(save.uses, /^actions\/cache\/save@v\d+$/);
  assert.equal(save.with.path, restore.with.path, 'the path is part of the cache version');
  assert.equal(save.with.key, '${{ steps.apt-cache.outputs.key }}');
  const lookup = step(warm.steps, 'Look up the package cache');
  assert.equal(lookup.with['lookup-only'], true);
  assert.equal(lookup.with.path, restore.with.path);
  for (const name of ['Restore an older package cache', 'Download the declared packages', 'Save the package cache']) {
    assert.equal(step(warm.steps, name).if, "steps.lookup.outputs.cache-hit != 'true'", name);
  }
});

test('the warm job downloads only what the cache lacks and keeps only what the set needs', (t) => {
  const s = sandbox(t);
  const dir = join(s.env.RUNNER_TEMP, 'ci-kit-apt');
  mkdirSync(join(dir, 'partial'), { recursive: true });
  // An older entry: one package still current, one superseded version, and one the set no longer declares.
  for (const deb of ['zsh_5.9-6_amd64.deb', 'cowsay_3.03-1_all.deb', 'gone_1.0_amd64.deb', 'lock']) writeFileSync(join(dir, deb), '');
  writeFileSync(join(s.root, 'needed'), 'zsh_5.9-6_amd64.deb\ncowsay_3.03-2_all.deb\nlibx_1%3a2.0_amd64.deb\n');
  const download = step(warm.steps, 'Download the declared packages');
  s.run(download.run, { CI_KIT_APT: '["cowsay","zsh"]' });
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.deb')).sort(), ['cowsay_3.03-2_all.deb', 'libx_1%3a2.0_amd64.deb', 'zsh_5.9-6_amd64.deb']);
  assert.deepEqual(s.fetched(), ['cowsay_3.03-2_all.deb', 'libx_1%3a2.0_amd64.deb']);
  const apt = s.calls().filter((c) => c.startsWith('apt-get'));
  assert.equal(apt.length, 3);
  assert.match(apt[0], /^apt-get update .*Acquire::Retries=3/);
  assert.match(apt[1], /^apt-get install .*--no-install-recommends --no-upgrade --print-uris .*Dir::Cache::Archives=\S+\/ cowsay zsh$/);
  assert.match(apt[2], /^apt-get install .*--no-install-recommends --no-upgrade --download-only .*Acquire::Retries=3.* cowsay zsh$/);
});
