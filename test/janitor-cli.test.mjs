// host/janitor.mjs end to end, against real orphaned processes it is pointed at by a unique marker.
// macOS only: the janitor is a LaunchAgent, and an orphan's parent is launchd (pid 1) only there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const JANITOR = new URL('../host/janitor.mjs', import.meta.url).pathname;
const darwin = process.platform === 'darwin';
const marker = `ci-kit-janitor-test-${process.pid}-${Date.now()}`;
let home;
let config;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Starts `node -e <loop> <marker> [args]` orphaned: its shell exits at once, so launchd adopts it.
function orphan(...args) {
  const out = execFileSync('sh', ['-c', `"$0" -e 'setInterval(() => {}, 1e6)' "$@" >/dev/null 2>&1 & echo $!`, process.execPath, marker, ...args], { encoding: 'utf8' });
  return Number(out.trim());
}

const run = (...args) =>
  spawnSync(process.execPath, [JANITOR, '--config', config, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } });

before(() => {
  home = mkdtempSync(join(tmpdir(), 'ci-kit-janitor-home-'));
  mkdirSync(join(home, 'repos'));
  config = join(home, 'janitor.json');
  writeFileSync(
    config,
    JSON.stringify({
      patterns: [`^\\S*\\bnode\\s.*${marker}`],
      exclude: ['\\s--watch(?:[=\\s]|$)'],
      min_age_hours: 0,
      vm_report_hours: 12,
      repos_root: '~/repos',
      notify: false,
    }),
  );
});

after(() => {
  spawnSync('pkill', ['-f', marker]);
  rmSync(home, { recursive: true, force: true });
});

test('a dry run lists what it would kill and kills nothing; a live run kills it and spares the watcher', { skip: !darwin && 'macOS only' }, async () => {
  const oneShot = orphan('once');
  const watcher = orphan('--watch');
  await sleep(1500); // older than min_age_hours: 0, in whole seconds of etime
  const log = join(home, 'Library/Logs/ci-kit/janitor.log');
  const report = join(home, 'Library/Logs/ci-kit/report.md');

  const dry = run('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`would-kill pid=${oneShot} age=\\S+ pattern=`));
  assert.doesNotMatch(dry.stdout, new RegExp(`pid=${watcher}\\b`));
  assert.ok(alive(oneShot) && alive(watcher), 'a dry run kills nothing');
  assert.match(readFileSync(log, 'utf8'), new RegExp(`would-kill pid=${oneShot}\\b`));
  assert.match(readFileSync(report, 'utf8'), new RegExp(`\\| ${watcher} \\|`), 'the watcher is reported');

  const live = run();
  assert.equal(live.status, 0, live.stderr);
  assert.match(live.stdout, new RegExp(`kill pid=${oneShot} .* result=terminated`));
  assert.ok(!alive(oneShot), 'the one-shot orphan is gone');
  assert.ok(alive(watcher), 'the watcher is left running');
  assert.match(readFileSync(log, 'utf8'), new RegExp(`\\skill pid=${oneShot}\\b.*result=terminated`));
});

test('a bad flag or a broken config exits 2 and says why', () => {
  const bad = spawnSync(process.execPath, [JANITOR, '--now'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /janitor: unknown argument --now/);
  const broken = join(home, 'broken.json');
  writeFileSync(broken, JSON.stringify({ patterns: ['('], exclude: [], min_age_hours: 2, vm_report_hours: 12, repos_root: '~' }));
  const r = spawnSync(process.execPath, [JANITOR, '--config', broken, '--dry-run'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /janitor: .*patterns\[0\]/);
});
