// The mirror (gate ledger spec, Glossary "The mirror", "Tree key"): a tree-only bare clone, commits fetched by id,
// tree keys under a path policy, path differences and ancestry. Against a real git origin on disk, which allows a fetch
// of any commit by id as GitHub does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openMirror } from '../../history/mirror.mjs';

const POLICY = { exclude: ['docs/'], except: ['docs/doperpowers/evidence/'] };

function origin() {
  const dir = mkdtempSync(join(tmpdir(), 'ci-kit-origin-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'uploadpack.allowFilter', 'true');
  git('config', 'uploadpack.allowAnySHA1InWant', 'true');
  const commit = (files, message) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) git('rm', '-q', path);
      else {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
        git('add', path);
      }
    }
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the mirror: a nonce commit fetched by id brings its parent; tree keys, paths and ancestry', () => {
  const o = origin();
  const root = mkdtempSync(join(tmpdir(), 'ci-kit-mirrors-'));
  try {
    const base = o.commit({ 'src/a.ts': '1', 'docs/plan.md': 'p', 'docs/doperpowers/evidence/e.json': '{}' }, 'base');
    const docsOnly = o.commit({ 'docs/plan.md': 'p2' }, 'docs');
    const evidence = o.commit({ 'docs/doperpowers/evidence/e.json': '{"a":1}' }, 'evidence');
    const renamed = (o.git('mv', 'src/a.ts', 'src/b.ts'), o.commit({}, 'rename'));
    // A ci-gate push: an empty commit on top of the tested one, on a ref deleted afterwards.
    o.git('checkout', '-q', '-b', 'ci/x-12345678');
    const nonce = o.commit({}, 'ci-gate\n\nNonce: 1');
    o.git('checkout', '-q', 'main');
    o.git('branch', '-q', '-D', 'ci/x-12345678');

    const m = openMirror({ dir: join(root, 'o.git'), url: `file://${o.dir}`, token: null });
    m.ensure();
    assert.equal(m.has(nonce), false);
    assert.deepEqual(m.fetch([nonce, 'f'.repeat(40)]), new Set([nonce])); // one id it cannot get spoils no other
    assert.equal(m.parentOf(nonce), renamed);
    assert.equal(m.parentOf('e'.repeat(40)), null);

    const tree = (c) => o.git('rev-parse', `${c}^{tree}`);
    // Without a policy a tree's key is the tree.
    assert.equal(m.treeKey(tree(base), null), tree(base));
    // Under MAWS's policy a docs-only change keeps the key, and a change under the exception does not.
    assert.equal(m.treeKey(tree(docsOnly), POLICY), m.treeKey(tree(base), POLICY));
    assert.notEqual(m.treeKey(tree(evidence), POLICY), m.treeKey(tree(docsOnly), POLICY));
    assert.notEqual(m.treeKey(tree(renamed), POLICY), m.treeKey(tree(evidence), POLICY));

    // A rename counts under both names; the difference is between the trees themselves.
    assert.deepEqual(m.paths(evidence, renamed), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(m.paths(base, evidence), ['docs/doperpowers/evidence/e.json', 'docs/plan.md']);
    assert.deepEqual(m.paths(nonce, renamed), []);
    assert.equal(m.isAncestor(base, renamed), true);
    assert.equal(m.isAncestor(renamed, base), false);

    // A second mirror over the same directory reuses the clone.
    const again = openMirror({ dir: join(root, 'o.git'), url: `file://${o.dir}`, token: null });
    again.ensure();
    assert.equal(again.has(nonce), true);
  } finally {
    o.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the mirror: a commit's tree, parents and message; pull requests' heads; one file's text fetched on demand", () => {
  const o = origin();
  const root = mkdtempSync(join(tmpdir(), 'ci-kit-mirrors-'));
  try {
    const base = o.commit({ '.github/ci-kit.yml': 'version: 1\n', 'src/a.ts': '1' }, 'base');
    o.git('checkout', '-q', '-b', 'topic');
    const head = o.commit({ 'src/a.ts': '2' }, 'topic work');
    o.git('checkout', '-q', 'main');
    o.git('merge', '-q', '--no-ff', '-m', 'Merge pull request #7 from o/topic\n\nShip-with: known', 'topic');
    const merge = o.git('rev-parse', 'HEAD');
    // A pull request's head no branch reaches: GitHub keeps it under refs/pull/<n>/head.
    o.git('checkout', '-q', '-b', 'gone');
    const squashed = o.commit({ 'src/a.ts': '3' }, 'abandoned');
    o.git('checkout', '-q', 'main');
    o.git('branch', '-q', '-D', 'gone', 'topic');
    o.git('update-ref', 'refs/pull/7/head', head);
    o.git('update-ref', 'refs/pull/9/head', squashed);

    const m = openMirror({ dir: join(root, 'o.git'), url: `file://${o.dir}`, token: null });
    m.ensure();
    const c = m.commit(merge);
    assert.deepEqual(c.parents, [base, head]);
    assert.equal(c.tree, o.git('rev-parse', `${merge}^{tree}`));
    assert.equal(c.message, 'Merge pull request #7 from o/topic\n\nShip-with: known\n');
    assert.equal(m.commit('e'.repeat(40)), null);

    assert.equal(m.has(squashed), false);
    assert.equal(m.fetchPulls(), true);
    assert.deepEqual(m.pulls(), new Map([[7, head], [9, squashed]]));
    assert.equal(m.has(squashed), true);

    // Without contents in the clone, the file's blob is fetched for this read alone.
    assert.equal(m.fileAt(base, '.github/ci-kit.yml'), 'version: 1\n');
    assert.equal(m.fileAt(base, 'nowhere.yml'), null);
    assert.equal(m.fileAt('e'.repeat(40), '.github/ci-kit.yml'), null);
  } finally {
    o.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
