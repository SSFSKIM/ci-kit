// The janitor's process side: the ps listing, the age arithmetic, and which processes the shipped patterns kill,
// spare (report and leave running) or ignore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify, compileRules, parseEtime, parsePs } from '../host/processes.mjs';

const shipped = JSON.parse(readFileSync(new URL('../host/janitor.json', import.meta.url), 'utf8'));
const rules = compileRules(shipped);
const ME = 501;
const HOURS = 3600;

// One orphaned process of this user, 3 h old, with the given command line.
const orphan = (command, over = {}) => ({ uid: ME, pid: 4242, ppid: 1, age: 3 * HOURS, rss: 1000, started: 'Thu Oct 15 20:00:00 2026', command, ...over });
const verdict = (command, over) => {
  const { kill, spare } = classify([orphan(command, over)], rules, { uid: ME, selfPid: 1 });
  if (kill.length) return 'kill';
  if (spare.length) return 'spare';
  return 'ignore';
};

test('etime parses every ps form into seconds', () => {
  assert.equal(parseEtime('00:05'), 5);
  assert.equal(parseEtime('14:07'), 14 * 60 + 7);
  assert.equal(parseEtime('09:00:29'), 9 * 3600 + 29);
  assert.equal(parseEtime('17-07:32:17'), 17 * 86400 + 7 * 3600 + 32 * 60 + 17);
  assert.equal(parseEtime('2-00:00:00'), 2 * 86400);
  assert.ok(Number.isNaN(parseEtime('soon')));
});

test('the ps listing keeps the whole command line, spaces included, and each process its start time', () => {
  const text = [
    '  501 90860     1       02:00:02    5120 Thu Oct 15 22:46:22 2026 node --test /tmp/a b/a11.test.mjs',
    '    0     1     0 17-07:32:17   20480 Mon Sep 28 15:10:01 2026 /sbin/launchd',
    '  501   684     1 17-07:32:15  307200 Mon Sep  8 15:10:03 2026 /Applications/KakaoTalk.app/Contents/MacOS/KakaoTalk',
    '',
  ].join('\n');
  assert.deepEqual(parsePs(text), [
    { uid: 501, pid: 90860, ppid: 1, age: 7202, rss: 5120, started: 'Thu Oct 15 22:46:22 2026', command: 'node --test /tmp/a b/a11.test.mjs' },
    { uid: 0, pid: 1, ppid: 0, age: 1495937, rss: 20480, started: 'Mon Sep 28 15:10:01 2026', command: '/sbin/launchd' },
    { uid: 501, pid: 684, ppid: 1, age: 1495935, rss: 307200, started: 'Mon Sep  8 15:10:03 2026', command: '/Applications/KakaoTalk.app/Contents/MacOS/KakaoTalk' },
  ]);
});

const node = '/Users/new/.nvm/versions/node/v22.23.2/bin/node';
const wt = '/Users/new/Developer/GitHub/MAWS/.claude/worktrees/agent-a1b2';

test('one-shot test commands are killed', () => {
  for (const command of [
    'node --test',
    // Options known to keep the script position may come first.
    `${node} --experimental-vm-modules --no-warnings --test`,
    `${node} --import=tsx --test-reporter=spec --test test/`,
    `${node} --enable-source-maps --max-old-space-size=4096 /x/test/a.test.mjs`,
    `${node} --max-old-space-size=8192 /x/node_modules/vitest/vitest.mjs run`,
    'python3 -u -I /tmp/smb.Q1w2E3/fakemod.py /tmp/x.sock',
    'python3 -X importtime /tmp/smb.Q1w2E3/fakemod.py',
    `${node} --inspect=0 --test-reporter spec --test`,
    `${node} -- /x/test/a.test.mjs`,
    `${node} --test --test-concurrency=1 test/`,
    `${node} --experimental-vm-modules --test "test/**/*.test.mjs"`,
    // The node --test runner's child: what is left when the runner itself dies.
    `${node} /tmp/ci-kit-a11-1/a11.test.mjs`,
    `${node} /Users/new/Developer/GitHub/cua/test/eof-drain.test.mjs --flag`,
    `node /Users/new/Developer/GitHub/MAWS/node_modules/.pnpm/vitest@3.2.4/node_modules/vitest/vitest.mjs run`,
    `node /Users/new/Developer/GitHub/MAWS/node_modules/.bin/vitest --run src/a.test.ts`,
    `node /x/node_modules/@playwright/test/cli.js test --project=e2e`,
    `node /x/node_modules/.bin/playwright test e2e/code-tools.spec.ts`,
    `${node} /Users/new/Developer/GitHub/cua/test/fixtures/fake-upstream-process.mjs 4011`,
    '/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python /tmp/smc.Ab3dE9/ctl.py supervisor /tmp/x/sup ok',
    'python3 /Users/new/Developer/GitHub/doperpowers/tests/sminos/hub_standin.py /tmp/sms.x/hub.port cid-0 secret-0 1000',
    `${node} /var/folders/7x/abc/T/codex-plugin-test-Qx81/codex app-server`,
    `${node} /x/skills/codex-companion/runtime/scripts/codex-companion.mjs task-worker --cwd /var/folders/7x/abc/T/codex-plugin-test-Qx81 --job-id j1`,
    // Electron as Playwright's _electron.launch starts it (playwright-core 1.63): its loader, then these two flags.
    `${wt}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron -r ${wt}/node_modules/playwright-core/lib/server/electron/loader.js --inspect=0 --remote-debugging-port=0 ${wt}/out/main/index.js`,
    // ...and with an executablePath: no loader. Positive evidence of a test launch, wherever the app lives.
    '/Users/new/Developer/GitHub/MAWS/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --inspect=0 --remote-debugging-port=0 /Users/new/Developer/GitHub/MAWS/out/main/index.js',
  ]) {
    assert.equal(verdict(command), 'kill', command);
  }
});

test('watch, UI and server modes are reported and left running', () => {
  for (const command of [
    'node /x/node_modules/vitest/vitest.mjs --watch',
    'node /x/node_modules/vitest/vitest.mjs', // vitest without run watches by default
    'node /x/node_modules/vitest/vitest.mjs run --watch',
    'node /x/node_modules/vitest/vitest.mjs run --ui',
    'node /x/node_modules/vitest/vitest.mjs -w',
    'node --test --watch test/',
    // Watch mode turned on by any of node's watch options, not only a bare --watch.
    'node --watch-path=/srv /srv/heartbeat.test.mjs',
    'node --watch-path /srv /srv/heartbeat.test.mjs',
    'node --watch /x/a.test.mjs',
    'node /x/node_modules/.bin/playwright test --ui',
    'node /x/node_modules/@playwright/test/cli.js test --ui=true',
    '/Users/new/Developer/GitHub/MAWS-wt-3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /Users/new/Developer/GitHub/MAWS-wt-3 dev',
    // Electron from or for a worktree with no test-launch flags: a developer may have left the app open on purpose.
    `${wt}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ${wt}/out/main/index.js`,
    '/Users/new/Developer/GitHub/MAWS/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /Users/new/Developer/GitHub/MAWS-wt-95/out/main/index.js',
    `${wt}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --inspect=9229 ${wt}/out/main/index.js`,
    // A codex-companion broker serving a test workspace: a server mode, so the exclusion wins.
    `${node} /x/skills/codex-companion/runtime/scripts/app-server-broker.mjs serve --endpoint unix:/tmp/b.sock --cwd /var/folders/7x/abc/T/codex-plugin-test-Qx81 --pid-file /tmp/b.pid`,
  ]) {
    assert.equal(verdict(command), 'spare', command);
  }
});

test('everything else is ignored, however it reads', () => {
  for (const command of [
    // Claude sessions and shells carry test words in their arguments; the executable is what counts.
    '/Users/new/.local/bin/claude --resume run node --test and vitest run',
    "/bin/zsh -c source /Users/new/.claude/shell-snapshots/s.sh && eval 'pnpm vitest run' < /dev/null",
    'sh -c node --test "test/**/*.test.mjs"',
    // Long-lived tools that are not tests.
    'node /Users/new/.nvm/versions/node/v22.23.2/lib/node_modules/@playwright/cli/cli.js daemon --session s1',
    '/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python /Users/new/.claude/plugins/cache/doperpowers/doperpowers/7.156.1/skills/sminos/scripts/sminos.py daemon run',
    '/Applications/Obsidian.app/Contents/MacOS/Obsidian',
    '/Users/new/Developer/GitHub/MAWS/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /Users/new/Developer/GitHub/MAWS/out/main/index.js',
    '/Users/new/.nvm/versions/node/v22.23.2/bin/node /Users/new/Developer/GitHub/cua/bin/cua.mjs agent run --relay',
    '/opt/homebrew/bin/nodemon --test',
    // Node-hosted CLIs and scripts whose later arguments merely mention tests (the M8 review's probes).
    'node /x/node_modules/@anthropic-ai/claude-code/cli.js --resume investigate vitest run failures',
    `${node} /x/node_modules/@anthropic-ai/claude-code/cli.js -p "run node --test and playwright test, then fake-upstream-process.mjs"`,
    'node /srv/daemon.mjs --test-mode',
    'node /srv/daemon.mjs --test',
    'node --test-mode /srv/daemon.mjs',
    'node /srv/daemon.mjs --config /srv/heartbeat.test.mjs',
    'node /srv/runner.mjs /x/node_modules/vitest/vitest.mjs run',
    'node /srv/tool.mjs /x/node_modules/.bin/playwright test',
    'node /srv/tool.mjs /x/test/fixtures/fake-upstream-process.mjs',
    'node /srv/watch.mjs --dir /var/folders/7x/abc/T/codex-plugin-test-Qx81/state',
    'python3 /srv/daemon.py /Users/new/Developer/GitHub/doperpowers/tests/sminos/hub_standin.py',
    'python3 /srv/daemon.py --log /tmp/smc.Ab3dE9/ctl.py',
    // Execution modes make the "script" an argument: eval, print, check, interactive, stdin, node --run, python -c/-m/-.
    'node --eval=setInterval(()=>{},1e6) /srv/heartbeat.test.mjs',
    'node --eval setInterval(()=>{},1e6) /srv/heartbeat.test.mjs',
    'node -e setInterval(()=>{},1e6) /srv/heartbeat.test.mjs',
    'node --eval=setInterval(()=>{},1e6) /x/node_modules/vitest/vitest.mjs run',
    'node --print=1 /x/node_modules/.bin/playwright test',
    'node --print 1 /x/node_modules/.bin/playwright test',
    'node -p 1 /x/node_modules/.bin/playwright test',
    'node -pe 1 /x/test/fixtures/fake-upstream-process.mjs',
    'node -e 1 --test',
    'node --input-type=module -e 1 /x/a.test.mjs',
    'node --check /x/a.test.mjs',
    'node -c /x/a.test.mjs',
    'node -i /x/a.test.mjs',
    'node - /x/a.test.mjs',
    'node --run test /x/a.test.mjs',
    'node --run=test /x/node_modules/vitest/vitest.mjs run',
    'node --eval=1 /var/folders/7x/abc/T/codex-plugin-test-Qx81/codex app-server',
    'python3 -c import\ time;time.sleep(1e6) /tmp/smc.Ab3dE9/ctl.py',
    'python3 -m http.server /Users/new/Developer/GitHub/doperpowers/tests/sminos/hub_standin.py',
    'python3 - /tmp/smc.Ab3dE9/ctl.py',
    'python3 -u -c pass /tmp/smc.Ab3dE9/ctl.py',
    // Option values are values, never the entrypoint (fix wave 3).
    'node --experimental-loader /srv/heartbeat.test.mjs /srv/daemon.mjs',
    'node --test-name-pattern /srv/heartbeat.test.mjs /srv/daemon.mjs',
    'node --test-name-pattern X.test.mjs --eval=setInterval(()=>{},1e6)',
    'node --env-file=/tmp/codex-plugin-test-ABC/env /srv/daemon.mjs',
    'node --env-file /tmp/codex-plugin-test-ABC/env /srv/daemon.mjs',
    'node --import /x/node_modules/vitest/vitest.mjs /srv/daemon.mjs run',
    'node -r /x/test/fixtures/fake-upstream-process.mjs /srv/daemon.mjs',
    'node --require=/x/node_modules/.bin/playwright /srv/daemon.mjs test',
    'python3 -W ignore /srv/daemon.py /tmp/smc.Ab3dE9/ctl.py',
    // An option the walk does not know, or an inline-only option given a separate value, stops it.
    'node --frobnicate /x/test/a.test.mjs',
    'node --max-old-space-size 4096 /x/test/a.test.mjs',
    // A vitest worker: its parent's mode is unknowable, and it is not an entrypoint.
    'node /x/node_modules/vitest/dist/workers/forks.js',
    // Electron with only a debugger port is not Playwright's launch.
    '/Applications/Some.app/Contents/MacOS/Electron --remote-debugging-port=9222',
  ]) {
    assert.equal(verdict(command), 'ignore', command);
  }
});

test('only an orphan of this user older than the minimum age qualifies', () => {
  const cmd = 'node --test test/';
  assert.equal(verdict(cmd), 'kill');
  assert.equal(verdict(cmd, { ppid: 777 }), 'ignore', 'still has a parent');
  assert.equal(verdict(cmd, { uid: 0 }), 'ignore', "root's");
  assert.equal(verdict(cmd, { uid: 502 }), 'ignore', "another user's");
  assert.equal(verdict(cmd, { age: 2 * HOURS }), 'ignore', 'exactly the minimum age is not more than it');
  assert.equal(verdict(cmd, { age: 2 * HOURS + 1 }), 'kill');
  assert.equal(classify([orphan(cmd)], rules, { uid: ME, selfPid: 4242 }).kill.length, 0, 'never itself');
});

test('a kill names the pattern that matched; a spare names the exclusion that won', () => {
  const { kill, spare } = classify(
    [orphan('node --test test/', { pid: 1 }), orphan('node /x/vitest/vitest.mjs --watch', { pid: 2 })],
    rules,
    { uid: ME, selfPid: 9 },
  );
  assert.equal(kill.length, 1);
  assert.equal(kill[0].pid, 1);
  assert.match(kill[0].pattern, /--test/);
  assert.equal(kill[0].identity, `${ME} Thu Oct 15 20:00:00 2026`, 'chosen with its birth identity');
  assert.equal(spare.length, 1);
  assert.equal(spare[0].pid, 2);
  assert.match(spare[0].pattern, /vitest/);
  assert.match(spare[0].excludedBy, /watch/);
});

test('a bad regex in the config is refused, naming the list and the entry', () => {
  assert.throws(() => compileRules({ ...shipped, patterns: ['ok', '(unclosed'] }), /patterns\[1\].*\(unclosed/);
  assert.throws(() => compileRules({ ...shipped, exclude: ['['] }), /exclude\[0\]/);
  assert.throws(() => compileRules({ ...shipped, min_age_hours: -1 }), /min_age_hours/);
  assert.throws(() => compileRules({ ...shipped, patterns: [] }), /patterns/);
});

test('every pattern and exclusion must be a non-empty string: new RegExp would coerce the rest into broad regexes', () => {
  // {} would become /[object Object]/ and [] the empty regex, which matches every command line.
  assert.throws(() => compileRules({ ...shipped, patterns: [{}] }), /patterns\[0\] must be a non-empty regex string, not \{\}/);
  assert.throws(() => compileRules({ ...shipped, patterns: ['^node --test', []] }), /patterns\[1\]/);
  assert.throws(() => compileRules({ ...shipped, exclude: ['x', 'y', 7] }), /exclude\[2\]/);
  assert.throws(() => compileRules({ ...shipped, exclude: [null] }), /exclude\[0\]/);
  assert.throws(() => compileRules({ ...shipped, patterns: [''] }), /patterns\[0\]/);
  assert.throws(() => compileRules({ ...shipped, exclude: 'x' }), /exclude must be a list/);
});
