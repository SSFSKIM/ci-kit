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
const orphan = (command, over = {}) => ({ uid: ME, pid: 4242, ppid: 1, age: 3 * HOURS, rss: 1000, command, ...over });
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

test('the ps listing keeps the whole command line, spaces included', () => {
  const text = [
    '  501 90860     1       02:00:02    5120 node --test /tmp/a b/a11.test.mjs',
    '    0     1     0 17-07:32:17   20480 /sbin/launchd',
    '  501   684     1 17-07:32:15  307200 /Applications/KakaoTalk.app/Contents/MacOS/KakaoTalk',
    '',
  ].join('\n');
  assert.deepEqual(parsePs(text), [
    { uid: 501, pid: 90860, ppid: 1, age: 7202, rss: 5120, command: 'node --test /tmp/a b/a11.test.mjs' },
    { uid: 0, pid: 1, ppid: 0, age: 1495937, rss: 20480, command: '/sbin/launchd' },
    { uid: 501, pid: 684, ppid: 1, age: 1495935, rss: 307200, command: '/Applications/KakaoTalk.app/Contents/MacOS/KakaoTalk' },
  ]);
});

test('one-shot test commands are killed', () => {
  const node = '/Users/new/.nvm/versions/node/v22.23.2/bin/node';
  for (const command of [
    'node --test',
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
    `${node} /Users/new/.claude/plugins/codex/broker.mjs --cwd /var/folders/7x/abc/T/codex-plugin-test-Qx81`,
    '/Users/new/Developer/GitHub/MAWS/.claude/worktrees/agent-a1b2/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --inspect=0 --remote-debugging-port=0 /Users/new/Developer/GitHub/MAWS/.claude/worktrees/agent-a1b2/out/main/index.js',
    '/Users/new/Developer/GitHub/MAWS/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /Users/new/Developer/GitHub/MAWS-wt-95/out/main/index.js',
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
    'node /x/node_modules/vitest/dist/workers/forks.js', // a worker: its parent's mode is unknowable
    'node --test --watch test/',
    'node --watch /x/a.test.mjs',
    'node /x/node_modules/.bin/playwright test --ui',
    'node /x/node_modules/@playwright/test/cli.js test --ui=true',
    '/Users/new/Developer/GitHub/MAWS-wt-3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /Users/new/Developer/GitHub/MAWS-wt-3 dev',
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
