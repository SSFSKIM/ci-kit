// The plugin's SessionStart / SubagentStart hook (plugin spec, P1): the ci-gate note in a worktree whose repo has
// .github/ci-kit.yml, and nothing anywhere else; it always exits 0.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'session-start.sh');
let root;
let adopted;
let plain;

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function hook(payload, { cwd = root } = {}) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return spawnSync('bash', [HOOK], { input, cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: '/plugin-root' } });
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'ci-kit-hook-'));
  adopted = join(root, 'adopted');
  plain = join(root, 'plain');
  for (const dir of [adopted, plain]) {
    execFileSync('git', ['init', '-q', dir]);
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 't');
    writeFileSync(join(dir, 'README.md'), 'x\n');
  }
  mkdirSync(join(adopted, '.github'));
  writeFileSync(join(adopted, '.github', 'ci-kit.yml'), 'version: 1\n');
  mkdirSync(join(adopted, 'src'));
  git(adopted, 'add', '.');
  git(adopted, 'commit', '-qm', 'one');
  git(adopted, 'worktree', 'add', '-q', join(root, 'adopted-wt'));
});

after(() => rmSync(root, { recursive: true, force: true }));

test('in an adopted repo, its subdirectory and its worktree: the ci-gate note, naming the plugin\'s copy', () => {
  for (const cwd of [adopted, join(adopted, 'src'), join(root, 'adopted-wt')]) {
    const r = hook({ hook_event_name: 'SessionStart', source: 'startup', cwd });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^ci-kit: this repo's gates \(\.github\/ci-kit\.yml\) run on GitHub Actions/);
    assert.match(r.stdout, /`ci-gate`/);
    assert.match(r.stdout, /`ci-gate --help` has the rest/);
    assert.match(r.stdout, /\/plugin-root\/bin\/ci-gate/);
    assert.match(r.stdout, /GREEN <run-url> \(exit 0\), RED <failed>\/<total> <run-url> \(exit 1\) or ERROR/);
    assert.match(r.stdout, /Do not run the gates' commands on this machine/);
  }
});

test('silent in a repo without .github/ci-kit.yml and outside any repo', () => {
  for (const cwd of [plain, root]) {
    const r = hook({ hook_event_name: 'SessionStart', source: 'startup', cwd });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  }
});

test('a subagent gets the same note as JSON additionalContext', () => {
  const r = hook({ hook_event_name: 'SubagentStart', agent_type: 'Explore', cwd: adopted });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.equal(out.hookSpecificOutput.additionalContext, hook({ cwd: adopted }).stdout.trimEnd());
  assert.equal(hook({ hook_event_name: 'SubagentStart', cwd: plain }).stdout, '');
});

test('a payload without a usable cwd falls back to the hook\'s own directory', () => {
  assert.match(hook('not json', { cwd: adopted }).stdout, /^ci-kit: /);
  assert.equal(hook('', { cwd: plain }).stdout, '');
  assert.match(hook({ cwd: join(root, 'gone') }, { cwd: adopted }).stdout, /^ci-kit: /);
});
