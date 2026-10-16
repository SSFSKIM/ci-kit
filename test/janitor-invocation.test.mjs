// What a command line runs: node's and Python's own options walked by arity, the entrypoint after them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invocationOf } from '../host/invocation.mjs';

const text = (command) => invocationOf(command)?.text ?? null;

test('node options are walked by arity, and the first token after them is the entrypoint', () => {
  assert.equal(text('/usr/local/bin/node /x/a.test.mjs --flag'), 'node /x/a.test.mjs --flag');
  assert.equal(text('node --enable-source-maps --import=tsx /x/a.mjs b'), 'node /x/a.mjs b');
  assert.equal(text('node --import tsx /x/a.mjs'), 'node /x/a.mjs', 'a separate value is skipped');
  assert.equal(text('node -r /x/setup.cjs /x/a.mjs'), 'node /x/a.mjs');
  assert.equal(text('node --experimental-loader /srv/heartbeat.test.mjs /srv/daemon.mjs'), 'node /srv/daemon.mjs');
  assert.equal(text('node --inspect=0 /x/a.mjs'), 'node /x/a.mjs');
  assert.equal(text('node -- /x/a.mjs'), 'node /x/a.mjs');
  assert.equal(text('node'), 'node');
});

test("node's --test is kept wherever it sits among the options; the runner's file arguments follow it", () => {
  assert.equal(text('node --test'), 'node --test');
  assert.equal(text('node --test-reporter spec --test --test-concurrency=1 test/'), 'node --test test/');
  assert.equal(text('node --test-name-pattern /srv/heartbeat.test.mjs /srv/daemon.mjs'), 'node /srv/daemon.mjs');
});

test('execution modes, unknown options, separate values for inline-only options and stdin give no invocation', () => {
  for (const c of [
    'node -e 1 /x/a.test.mjs', 'node --eval 1 /x/a.test.mjs', 'node --eval=1 /x/a.test.mjs', 'node -p 1 x',
    'node --print=1 x', 'node -pe 1 x', 'node -c /x/a.test.mjs', 'node --check /x/a.test.mjs', 'node -i x',
    'node --interactive x', 'node --run test', 'node --run=test x', 'node - /x/a.test.mjs',
    'node --test-name-pattern X.test.mjs --eval=1', 'node --frobnicate /x/a.test.mjs',
    'node --max-old-space-size 4096 /x/a.test.mjs', 'node --test=1 x', 'node --import',
  ]) {
    assert.equal(invocationOf(c), null, c);
  }
});

test('watch options are recorded, with or without a value', () => {
  assert.deepEqual(invocationOf('node --watch /x/a.test.mjs'), { text: 'node /x/a.test.mjs', watch: '--watch' });
  assert.deepEqual(invocationOf('node --watch-path=/srv /srv/heartbeat.test.mjs'), { text: 'node /srv/heartbeat.test.mjs', watch: '--watch-path' });
  assert.deepEqual(invocationOf('node --watch-path /srv /srv/heartbeat.test.mjs'), { text: 'node /srv/heartbeat.test.mjs', watch: '--watch-path' });
  assert.equal(invocationOf('node --test --watch-preserve-output test/').watch, '--watch-preserve-output');
});

test('Python: bundled flags, -W/-X values inline or separate; -c, -m, - and long options give no invocation', () => {
  const py = '/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python';
  assert.equal(text(`${py} /tmp/smc.Ab3dE9/ctl.py supervisor x`), 'python /tmp/smc.Ab3dE9/ctl.py supervisor x');
  assert.equal(text('python3.12 -uI /x/s.py'), 'python /x/s.py');
  assert.equal(text('python3 -W ignore /srv/d.py /tmp/smc.Ab3dE9/ctl.py'), 'python /srv/d.py /tmp/smc.Ab3dE9/ctl.py');
  assert.equal(text('python3 -Wignore -X importtime /x/s.py'), 'python /x/s.py');
  for (const c of ['python3 -c pass /x/s.py', 'python3 -m pytest /x/s.py', 'python3 -uc pass /x/s.py', 'python3 - /x/s.py', 'python3 --check-hash-based-pycs never /x/s.py', 'python3']) {
    assert.equal(invocationOf(c), null, c);
  }
});

test('any other executable is judged by its command line as ps prints it', () => {
  const electron = '/x/Electron.app/Contents/MacOS/Electron --inspect=0 --remote-debugging-port=0 /x/main.js';
  assert.deepEqual(invocationOf(electron), { text: electron, watch: null });
  assert.equal(text('/opt/homebrew/bin/nodemon --test'), '/opt/homebrew/bin/nodemon --test');
});
