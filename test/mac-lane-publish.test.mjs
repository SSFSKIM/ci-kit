import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'ci-kit-publish-'));
after(() => rmSync(root, { recursive: true, force: true }));
const mac = fileURLToPath(new URL('../mac', import.meta.url));
const driver = `import importlib.util,sys,json,datetime
s=importlib.util.spec_from_file_location('publisher',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
now=datetime.datetime.fromisoformat(sys.argv[3].replace('Z','+00:00'))
if sys.argv[2]=='verdict': print(json.dumps(m.verdict(m.Path.home(),now)))
elif sys.argv[2]=='deadline':
 try: m.command([sys.executable,'-I',sys.argv[1],'--verdict',sys.argv[3]],timeout=1)
 except RuntimeError as e: print(e)
else: m.main(now)
`;
function fixture() {
  const home = mkdtempSync(join(root, 'home-'));
  const kit = join(home, 'kit'); cpSync(mac, kit, { recursive: true });
  const bin = join(home, 'bin'); mkdirSync(bin);
  const put = (name, value) => { const p = join(home, name); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, value); };
  const fake = (name, body) => { put(`bin/${name}`, `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  const plist = (env = {}) => put('Library/LaunchAgents/com.ssfskim.ci-kit.vm-lane.plist', `<?xml version="1.0"?><plist version="1.0"><dict><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v]) => `<key>${k}</key><string>${v}</string>`).join('')}</dict></dict></plist>`);
  plist();
  put('actions-runner-maws/.env', 'CI_KIT_VM_REPO=example/project\nCI_KIT_MACHINE=mini\nCI_KIT_PUBLISH_LANES=1\n');
  fake('launchctl', `if [[ $2 == *mac-runner ]]; then [[ "$HOST_STATE" != missing ]] || exit 113; echo 'state = waiting'; else [[ "$VM_STATE" != missing ]] || exit 113; [[ "$VM_STATE" == stopped ]] || echo 'pid = 123'; fi`);
  fake('gh', `printf '%s\\n' "$*" >> "$HOME/gh.calls"
[[ -z \${GH_TOKEN:-} && -z \${GITHUB_TOKEN:-} ]] || exit 91
if [[ \${GH_MODE:-} == fail ]]; then echo 'gh: forbidden (HTTP 403)' >&2; exit 1; fi
if [[ \${GH_MODE:-} == missing && " $* " == *' PATCH '* ]]; then echo 'gh: Not Found (HTTP 404)' >&2; exit 1; fi
for arg in "$@"; do [[ $arg != value=* ]] || printf '%s' "\${arg#value=}" > "$HOME/value.json"; done`);
  const run = (action = 'verdict', at = '2026-11-08T12:00:00Z', env = {}) => {
    const r = spawnSync('python3', ['-I', '-c', driver, join(kit, 'lane-publish.py'), action, at], {
      encoding: 'utf8', timeout: 40_000, env: { ...process.env, HOME: home, CI_KIT_MACHINE: 'mini', PATH: `${bin}:${process.env.PATH}`, ...env },
    });
    assert.equal(r.status, 0, r.stderr || r.error?.message);
    return action === 'verdict' ? JSON.parse(r.stdout) : r;
  };
  const published = () => JSON.parse(readFileSync(join(home, 'value.json'), 'utf8'));
  const calls = () => { try { return readFileSync(join(home, 'gh.calls'), 'utf8').trim().split('\n'); } catch { return []; } };
  return { home, kit, put, fake, plist, run, published, calls };
}
const held = (v, host, vm, why) => { assert.equal(v.host, host); assert.equal(v.vm, vm); assert.match(v.why, why); };
test('a loaded busy-or-idle host and running VM launcher are independently free', () => {
  const f = fixture(); held(f.run(), 'free', 'free', /^$/);
  held(f.run('verdict', undefined, { HOST_STATE: 'missing' }), 'held', 'free', /host.*launch/i);
  held(f.run('verdict', undefined, { VM_STATE: 'stopped' }), 'free', 'held', /VM.*launch/i);
  held(f.run('verdict', undefined, { VM_STATE: 'missing' }), 'free', 'held', /VM.*launch/i);
  rmSync(join(f.home, 'Library/LaunchAgents/com.ssfskim.ci-kit.vm-lane.plist'));
  held(f.run(), 'free', 'held', /VM.*install/i);
});
test('quiet windows use the shared reader: daily, dated, invalid, and expired', () => {
  const f = fixture();
  for (const line of ['11:00Z 13:00Z owner', '2026-11-08T11:00Z 2026-11-08T13:00Z owner', 'broken']) {
    f.put('.local/state/ci-quiet', line); held(f.run(), 'held', 'held', /quiet/i);
  }
  f.put('.local/state/ci-quiet', '10:00Z 11:00Z ended'); held(f.run(), 'free', 'free', /^$/);
});
test('coordinator holds expire at their until, while malformed holds fail closed', () => {
  const f = fixture();
  f.put('.local/state/ci-hold', 'until=2026-11-08T12:01:00Z\nby=measurement team\n');
  held(f.run(), 'held', 'held', /ci-hold.*measurement team/);
  held(f.run('verdict', '2026-11-08T12:01:00Z'), 'free', 'free', /^$/);
  f.put('.local/state/ci-hold', 'until=garbage'); held(f.run(), 'held', 'held', /cannot read ci-hold/);
});
test('only measured claims hold both; drain existence includes dangling links', () => {
  const f = fixture(); f.put('Library/Logs/ci-kit/vm-claim.job', 'ordinary claim since today\n');
  held(f.run(), 'free', 'free', /^$/);
  f.put('Library/Logs/ci-kit/vm-claim.measured', 'measured claim since today\n');
  held(f.run(), 'held', 'held', /measured/);
  rmSync(join(f.home, 'Library/Logs/ci-kit/vm-claim.measured'));
  symlinkSync('missing-target', join(f.home, 'Library/Logs/ci-kit/runner-drained'));
  held(f.run(), 'held', 'held', /drain/);
});
test('all owners are reported; temporary and dot holds do not count', () => {
  const f = fixture();
  for (const name of ['vm-hold.one.tmp', '.vm-hold.staged']) f.put(`Library/Logs/ci-kit/${name}`, 'staging');
  held(f.run(), 'free', 'free', /^$/);
  for (const name of ['alpha', 'beta']) f.put(`Library/Logs/ci-kit/vm-hold.${name}`, 'timed since now');
  held(f.run(), 'free', 'held', /alpha.*; .*beta/);
});
test('VM pauses support indefinite, timed, expired and malformed values', () => {
  const f = fixture();
  for (const until of ['none', '9999999999', 'broken']) {
    f.put('Library/Logs/ci-kit/vm-pause', `reason=memory\nuntil=${until}\nwhy=pressure\n`);
    held(f.run(), 'free', 'held', /vm-pause/);
  }
  f.put('Library/Logs/ci-kit/vm-pause', 'reason=memory\nuntil=1\n'); held(f.run(), 'free', 'free', /^$/);
});
test('fixed quiet margin is inclusive at 06:43 and ends at 07:00; configurable windows wrap midnight', () => {
  const f = fixture();
  for (const [time, state] of [['06:42:59', 'free'], ['06:43:00', 'held'], ['06:44:59', 'held'], ['06:45:00', 'held'], ['06:59:59', 'held'], ['07:00:00', 'free']]) {
    held(f.run('verdict', `2026-11-08T${time}Z`), state, state, state === 'held' ? /06:43-07:00/ : /^$/);
  }
  held(f.run('verdict', '2026-11-08T00:01:00Z', { CI_KIT_LANE_HELD_WINDOWS: '23:30-00:30,00:00-01:00' }), 'held', 'held', /23:30-00:30.*; .*00:00-01:00/);
  held(f.run('verdict', undefined, { CI_KIT_LANE_HELD_WINDOWS: '25:00-26:00' }), 'held', 'held', /window.*invalid/);
});
test('VM windows come from its installed LaunchAgent, not the publisher environment', () => {
  const f = fixture(); f.plist({ CI_KIT_VM_PAUSE_WINDOWS: '11:00-13:00' });
  held(f.run(), 'free', 'held', /VM.*11:00-13:00/);
  f.plist({ CI_KIT_VM_PAUSE_WINDOWS: 'bad' }); held(f.run(), 'free', 'held', /window.*invalid/);
});
test('lookup, listing, and content errors fail closed only for the lanes concerned', () => {
  for (const [path, host] of [['.local/state/ci-quiet', 'held'], ['.local/state/ci-hold', 'held'], ['Library/Logs/ci-kit/vm-claim.bad', 'held'], ['Library/Logs/ci-kit/vm-pause', 'free']]) {
    const f = fixture(); f.put(path, ''); rmSync(join(f.home, path)); symlinkSync('loop', join(f.home, 'loop')); symlinkSync(join(f.home, 'loop'), join(f.home, path));
    held(f.run(), host, 'held', /cannot read/);
  }
  const f = fixture(); f.put('Library/Logs', 'not a directory'); held(f.run(), 'held', 'held', /cannot read/);
});
test('script errors fail closed and every concurrent reason survives', () => {
  const f = fixture(); f.put('.local/state/ci-quiet', '11:00Z 13:00Z owner'); writeFileSync(join(f.kit, 'hooks/quiet.sh'), 'exit 9\n');
  f.put('Library/Logs/ci-kit/vm-hold.owner', 'timed since now');
  f.put('Library/Logs/ci-kit/runner-drained', 'dialog');
  const v = f.run(); held(v, 'held', 'held', /quiet/); assert.match(v.why, /owner/); assert.match(v.why, /drain/);
});
test('publishes changes immediately and refreshes a minute-old state, with own login and repo', () => {
  const f = fixture(); f.run('publish', undefined, { GH_TOKEN: 'wrong', GITHUB_TOKEN: 'wrong' });
  assert.equal(f.calls().length, 1); assert.match(f.calls()[0], /PATCH repos\/example\/project\/actions\/variables\/MAC_MINI_LANES/);
  assert.deepEqual(f.published(), { v: 1, at: '2026-11-08T12:00:00Z', host: 'free', vm: 'free', why: '' });
  f.run('publish', '2026-11-08T12:00:59Z'); assert.equal(f.calls().length, 1);
  f.run('publish', '2026-11-08T12:01:00Z'); assert.equal(f.calls().length, 2);
  f.put('Library/Logs/ci-kit/runner-drained', 'dialog'); f.run('publish', '2026-11-08T12:01:01Z'); assert.equal(f.calls().length, 3);
  assert.equal(f.published().host, 'held');
  assert.equal(readFileSync(join(f.home, 'Library/Logs/ci-kit/lane-publish.log'), 'utf8').trim().split('\n').length, 2);
});
test('404 creates the variable; other failures retry next pass without advancing state', () => {
  const f = fixture(); f.run('publish', undefined, { GH_MODE: 'missing' });
  assert.equal(f.calls().length, 2); assert.match(f.calls()[1], /POST repos\/example\/project\/actions\/variables /);
  const g = fixture(); g.run('publish', undefined, { GH_MODE: 'fail' }); assert.equal(g.calls().length, 1);
  g.run('publish', '2026-11-08T12:00:01Z'); assert.equal(g.calls().length, 2);
  assert.match(readFileSync(join(g.home, 'Library/Logs/ci-kit/lane-publish.log'), 'utf8'), /publish failed/);
});

test('failed publishing does not log an unchanged verdict on every retry, and bad cache data is repaired', () => {
  const f = fixture();
  f.run('publish', undefined, { GH_MODE: 'fail' });
  f.run('publish', '2026-11-08T12:01:00Z', { GH_MODE: 'fail' });
  const lines = readFileSync(join(f.home, 'Library/Logs/ci-kit/lane-publish.log'), 'utf8').trim().split('\n');
  assert.equal(lines.filter(line => line.includes('host=')).length, 1);
  assert.equal(lines.filter(line => line.includes('publish failed')).length, 2);
  f.put('Library/Logs/ci-kit/lane-publish-state.json', JSON.stringify({ repo: 'example/project', value: { v: 1, host: 'free', vm: 'free', why: '', at: 'bad timestamp' } }));
  f.run('publish', '2026-11-08T12:02:00Z');
  assert.equal(f.published().at, '2026-11-08T12:02:00Z');
});
test('a crashed or invalid verdict child publishes both held, not a fresh free heartbeat', () => {
  for (const replacement of ['raise RuntimeError("crashed reader")', 'print("[]")']) {
    const f = fixture();
    const script = join(f.kit, 'lane-publish.py');
    writeFileSync(script, readFileSync(script, 'utf8').replace('if __name__ == "__main__":', `if __name__ == "__main__":\n    ${replacement}\n    sys.exit(0)`));
    f.run('publish'); held(f.published(), 'held', 'held', /cannot compute/);
  }
});
test('a slow shared reader fails closed and a slow gh call is bounded and retried', () => {
  const f = fixture(); f.put('.local/state/ci-quiet', '11:00Z 13:00Z slow reader');
  writeFileSync(join(f.kit, 'hooks/quiet.sh'), 'sleep 60\n');
  held(f.run(), 'held', 'held', /timed out/);
  const g = fixture(); g.fake('gh', 'sleep 60');
  const before = Date.now(); g.run('publish');
  assert.ok(Date.now() - before < 25_000, 'gh bounded to 15 seconds');
  assert.match(readFileSync(join(g.home, 'Library/Logs/ci-kit/lane-publish.log'), 'utf8'), /publish failed.*timed out/);
  g.fake('gh', 'for arg in "$@"; do [[ $arg != value=* ]] || printf "%s" "${arg#value=}" > "$HOME/value.json"; done');
  g.run('publish', '2026-11-08T12:01:00Z'); assert.equal(g.published().host, 'free');
});

test('a copied publisher identity or absent opt-in cannot write the variable', () => {
  for (const contents of ['CI_KIT_MACHINE=rental\nCI_KIT_PUBLISH_LANES=1\n', 'CI_KIT_MACHINE=mini\n']) {
    const f = fixture(); f.put('actions-runner-maws/.env', `CI_KIT_VM_REPO=example/project\n${contents}`);
    f.run('publish', undefined, { CI_KIT_MACHINE: 'mini' });
    assert.equal(f.calls().length, 0, 'refuse writes from a copied identity or an unconfigured host');
    assert.match(readFileSync(join(f.home, 'Library/Logs/ci-kit/lane-publish.log'), 'utf8'), /refus/);
  }
});
test('minute sampling with clock phase drift refreshes before the heartbeat can approach 180 seconds', () => {
  const f = fixture();
  for (const [at, count] of [['12:00:01', 1], ['12:01:00', 1], ['12:02:00', 2], ['12:03:00', 3]]) {
    f.run('publish', `2026-11-08T${at}Z`); assert.equal(f.calls().length, count, at);
  }
});
test('the overall deadline kills a hung nested reader and its child', () => {
  const f = fixture(); f.put('.local/state/ci-quiet', '11:00Z 13:00Z hung');
  writeFileSync(join(f.kit, 'hooks/quiet.sh'), 'echo $$ > "$HOME/nested.pid"\nsleep 60 &\necho $! > "$HOME/leaf.pid"\nwait\n');
  f.run('deadline');
  const pids = ['nested.pid', 'leaf.pid'].map(file => Number(readFileSync(join(f.home, file), 'utf8').trim()));
  try {
    for (const pid of pids) {
      const status = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
      assert.ok(status.status !== 0 || /^Z/.test(status.stdout.trim()), `reader descendant ${pid} still alive: ${status.stdout}`);
    }
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
});
