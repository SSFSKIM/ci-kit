// The package cache (docs/adopting.md, "Package cache") as gates.yml runs it. Its steps' bash runs here for real, with
// sudo and apt-get replaced by recording fakes: the apt configuration and key they write, and the warm job's pruning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  // setsid only starts its command (the group is the runner's business); apt-cache show prints $FIXTURE/index.
  writeFileSync(join(bin, 'setsid'), `#!/usr/bin/env bash
[ "$1" = --wait ] || { echo "setsid without --wait returns before apt does" >&2; exit 4; }
shift; exec "$@"
`, { mode: 0o755 });
  writeFileSync(join(bin, 'apt-cache'), `#!/usr/bin/env bash
echo "apt-cache $*" >> "$FIXTURE/calls"
cat "$FIXTURE/index" 2>/dev/null
[ -z "$APT_CACHE_STATUS" ] || exit "$APT_CACHE_STATUS"
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
  assert.ok(names.indexOf('Restore the package cache') < names.indexOf('Check the restored packages against the index'));
  assert.ok(names.indexOf('Check the restored packages against the index') < at);
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
  // An older image's or another set's complete entry before a warm job's cut-short download.
  assert.deepEqual(restore.with['restore-keys'].trim().split('\n'),
    ['${{ steps.apt-cache.outputs.set }}', '${{ steps.apt-cache.outputs.any }}', '${{ steps.apt-cache.outputs.partial }}']);
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
    partial: 'ci-kit-apt-1-partial-ubuntu24-X64-0123456789abcdef-',
    resume: 'ci-kit-apt-1-partial-ubuntu24-X64-0123456789abcdef-20261102.1.0-',
  });
  const outputs = s.outputs();
  for (const prefix of [outputs.set, outputs.any]) assert.ok(!outputs.resume.startsWith(prefix), 'no gate mistakes a partial download for a set');
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

test('a warm cut short saves what it downloaded apart, and the next warm resumes from it', () => {
  const download = step(warm.steps, 'Download the declared packages');
  assert.ok(download['timeout-minutes'] < warm['timeout-minutes'] - 5, 'the partial save has time to run');
  const partial = step(warm.steps, 'Save the partial download');
  const restore = step(gate, 'Restore the package cache');
  assert.equal(partial.with.path, restore.with.path);
  assert.equal(partial.with.key, '${{ steps.apt-cache.outputs.resume }}${{ github.run_id }}-${{ github.run_attempt }}');
  for (const [outcome, saved] of [['failure', true], ['cancelled', true], ['success', false], ['skipped', false]]) {
    const ran = evaluate(partial.if.replace('always()', 'true'), { steps: { download: { outcome } } });
    assert.equal(ran, saved, outcome);
  }
  // This image's cut-short download first; an older image's last, so that a slow mirror across an image change still
  // converges (the pruning drops what the new image does not need).
  assert.deepEqual(step(warm.steps, 'Restore an older package cache').with['restore-keys'].trim().split('\n'), [
    '${{ steps.apt-cache.outputs.resume }}', '${{ steps.apt-cache.outputs.set }}', '${{ steps.apt-cache.outputs.any }}',
    '${{ steps.apt-cache.outputs.partial }}',
  ]);
  // apt resumes a file it had begun (a 669 MB one at a slow mirror's 300 kB/s never finishes in one warm), so the
  // entries carry partial/ too, which apt keeps root's alone until it is opened to the cache before either save.
  assert.deepEqual(restore.with.path.trim().split('\n'),
    ['${{ runner.temp }}/ci-kit-apt/*.deb', '${{ runner.temp }}/ci-kit-apt/partial/*.deb']);
  const names = warm.steps.map((s) => s.name);
  const open = step(warm.steps, 'Let the cache read the unfinished downloads');
  assert.ok(names.indexOf('Download the declared packages') < names.indexOf(open.name));
  assert.ok(names.indexOf(open.name) < names.indexOf('Save the package cache'));
  assert.match(open.if, /^always\(\) && /, 'it runs after a timed-out download too');
});

test('the warm job downloads only what the cache lacks and keeps only what the set needs', (t) => {
  const s = sandbox(t);
  const dir = join(s.env.RUNNER_TEMP, 'ci-kit-apt');
  mkdirSync(join(dir, 'partial'), { recursive: true });
  // An older entry: one package still current, one superseded version, and one the set no longer declares.
  for (const deb of ['zsh_5.9-6_amd64.deb', 'cowsay_3.03-1_all.deb', 'gone_1.0_amd64.deb', 'lock']) writeFileSync(join(dir, deb), '');
  // And files a cut-short warm had begun: one still needed, which apt resumes, and one no longer.
  for (const deb of ['libx_1%3a2.0_amd64.deb', 'old_2.0_amd64.deb']) writeFileSync(join(dir, 'partial', deb), 'begun');
  writeFileSync(join(s.root, 'needed'), 'zsh_5.9-6_amd64.deb\ncowsay_3.03-2_all.deb\nlibx_1%3a2.0_amd64.deb\n');
  const download = step(warm.steps, 'Download the declared packages');
  s.run(download.run, { CI_KIT_APT: '["cowsay","zsh"]' });
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.deb')).sort(), ['cowsay_3.03-2_all.deb', 'libx_1%3a2.0_amd64.deb', 'zsh_5.9-6_amd64.deb']);
  assert.deepEqual(s.fetched(), ['cowsay_3.03-2_all.deb', 'libx_1%3a2.0_amd64.deb']);
  assert.deepEqual(readdirSync(join(dir, 'partial')), ['libx_1%3a2.0_amd64.deb']);
  const apt = s.calls().filter((c) => c.startsWith('apt-get'));
  assert.equal(apt.length, 3);
  assert.match(apt[0], /^apt-get update .*Acquire::Retries=3/);
  assert.match(apt[1], /^apt-get install .*--no-install-recommends --no-upgrade --print-uris .*Dir::Cache::Archives=\S+\/ cowsay zsh$/);
  assert.match(apt[2], /^apt-get install .*--no-install-recommends --no-upgrade --download-only .*Acquire::Retries=3.* cowsay zsh$/);
  // The download runs in a process group of its own, recorded; its exit is recorded once it returns.
  assert.ok(s.calls().some((c) => /^sudo setsid --wait bash -c .* apt-get install .*--download-only/.test(c)));
  assert.match(s.read('temp/ci-kit-apt-download.pgid'), /^\d+\n$/);
  assert.equal(s.read('temp/ci-kit-apt-download.exit'), '0\n');
});

test('after a timed-out download the warm stops only its own apt before the cache reads the unfinished file', (t) => {
  const s = sandbox(t);
  const open = step(warm.steps, 'Let the cache read the unfinished downloads');
  mkdirSync(join(s.env.RUNNER_TEMP, 'ci-kit-apt', 'partial'), { recursive: true });
  for (const name of ['kill', 'pkill', 'chmod']) {
    // The group is gone after the first signal (kill -0 fails); the others only record.
    writeFileSync(join(s.root, 'bin', name), `#!/usr/bin/env bash\necho "${name} $*" >> "$FIXTURE/calls"\n${name === 'kill' ? '[ "$1" != -0 ] || exit 1' : ''}\n`, { mode: 0o755 });
  }
  const state = join(s.env.RUNNER_TEMP, 'ci-kit-apt-download');
  const run = (outcome, { pgid = '4242', exit = null } = {}) => {
    writeFileSync(join(s.root, 'calls'), '');
    rmSync(`${state}.pgid`, { force: true });
    rmSync(`${state}.exit`, { force: true });
    if (pgid) writeFileSync(`${state}.pgid`, `${pgid}\n`);
    if (exit !== null) writeFileSync(`${state}.exit`, `${exit}\n`);
    s.run(open.run, { CI_KIT_DOWNLOAD: outcome });
    return s.calls().filter((c) => !c.startsWith('sudo '));
  };
  assert.equal(open.env.CI_KIT_DOWNLOAD, '${{ steps.download.outcome }}');
  // A step's timeout ends its bash, not the apt-get it started under sudo, which goes on writing (tar: "file changed
  // as we read it", arachne run 42835893694). It is stopped by its process group, never by name: another apt on the
  // machine is not the warm's.
  const stopped = run('failure');
  assert.deepEqual(stopped, ['kill -TERM -- -4242', 'kill -0 -- -4242', `chmod -R a+rX ${join(s.env.RUNNER_TEMP, 'ci-kit-apt', 'partial')}`]);
  assert.deepEqual(run('cancelled').slice(0, 1), ['kill -TERM -- -4242']);
  // apt returned (its failure is the step's, not a timeout's), apt never started, or the download succeeded: no signal.
  for (const [outcome, options] of [['failure', { exit: 100 }], ['failure', { pgid: null }], ['success', { exit: 0 }]]) {
    assert.deepEqual(run(outcome, options).map((c) => c.split(' ')[0]), ['chmod'], `${outcome} ${JSON.stringify(options)}`);
  }
});

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const record = (pkg, version, arch, sha) => `Package: ${pkg}\nVersion: ${version}\nArchitecture: ${arch}\nFilename: pool/${pkg}.deb\nSHA256: ${sha}\n`;

test('restored packages are checked against the signed index, and a mismatch or an unknown file is dropped', (t) => {
  const s = sandbox(t);
  const check = step(gate, 'Check the restored packages against the index');
  const dir = join(s.env.RUNNER_TEMP, 'ci-kit-apt');
  mkdirSync(join(dir, 'partial'), { recursive: true });
  const files = {
    // matches: Ubuntu 26.04's amd64v3 build, whose index record says Architecture: amd64 (arachne run 42841293986)
    'zsh_5.9-6_amd64v3.deb': 'zsh',
    'libx_1%3a2.0_amd64.deb': 'libx', // matches, an epoch in its name
    'cowsay_3.03-2_all.deb': 'tampered', // the index holds another hash
    'stray_1.0_all.deb': 'stray', // the index does not know it
  };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  writeFileSync(join(dir, 'partial', 'begun_1.0_all.deb'), 'begun');
  writeFileSync(join(s.root, 'index'), [
    record('zsh', '5.9-6', 'amd64', sha256('zsh')),
    record('libx', '1:2.0', 'amd64', sha256('libx')),
    record('cowsay', '3.03-2', 'all', sha256('cowsay')),
  ].join('\n'));
  // apt-cache show fails for the version it does not know, and still prints the others.
  s.run(check.run, { APT_CACHE_STATUS: '100' });
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.deb')).sort(), ['libx_1%3a2.0_amd64.deb', 'zsh_5.9-6_amd64v3.deb']);
  assert.deepEqual(readdirSync(join(dir, 'partial')), ['begun_1.0_all.deb'], 'apt hashes a resumed file whole');
  const calls = s.calls().filter((c) => !c.startsWith('sudo '));
  assert.match(calls[0], /^apt-get update .*Acquire::Retries=3/, 'the index is current before it is trusted');
  assert.equal(calls[1].split(' ').slice(0, 2).join(' '), 'apt-cache show');
  assert.deepEqual(calls[1].split(' ').slice(2).sort(), ['cowsay=3.03-2', 'libx=1:2.0', 'stray=1.0', 'zsh=5.9-6']);
});

test('the check drops every restored package when the index cannot be read, and costs nothing on a miss', (t) => {
  const s = sandbox(t);
  const check = step(gate, 'Check the restored packages against the index');
  assert.equal(step(warm.steps, 'Check the restored packages against the index').run, check.run, 'one check in both jobs');
  assert.equal(check.if, "steps.apt-cache.outcome == 'success'");
  assert.equal(step(warm.steps, 'Check the restored packages against the index').if, "steps.lookup.outputs.cache-hit != 'true'");
  const names = warm.steps.map((x) => x.name);
  assert.ok(names.indexOf('Restore an older package cache') < names.indexOf('Check the restored packages against the index'));
  assert.ok(names.indexOf('Check the restored packages against the index') < names.indexOf('Download the declared packages'));
  const dir = join(s.env.RUNNER_TEMP, 'ci-kit-apt');
  mkdirSync(dir, { recursive: true });
  s.run(check.run);
  assert.deepEqual(s.calls(), [], 'nothing restored: nothing to check, no update');
  writeFileSync(join(dir, 'zsh_5.9-6_amd64.deb'), 'zsh');
  writeFileSync(join(s.root, 'bin', 'apt-get'), '#!/usr/bin/env bash\necho "apt-get $*" >> "$FIXTURE/calls"\nexit 100\n', { mode: 0o755 });
  const r = s.run(check.run);
  assert.deepEqual(readdirSync(dir), []);
  assert.match(r.stdout, /::warning::/);
});
