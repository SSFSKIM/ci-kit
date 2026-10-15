import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globMatch, matchesAny } from '../plan/glob.mjs';

const cases = [
  // [pattern, path, expected]
  ['src/**', 'src/a.js', true],
  ['src/**', 'src/deep/er/a.js', true],
  ['src/**', 'srcx/a.js', false],
  ['src/**', 'lib/src/a.js', false],
  ['**/*.md', 'README.md', true],
  ['**/*.md', 'docs/x/y.md', true],
  ['**/*.md', 'docs/x/y.mdx', false],
  ['docs/**/*.md', 'docs/a.md', true],
  ['docs/**/*.md', 'docs/a/b/c.md', true],
  ['*.json', 'package.json', true],
  ['*.json', 'a/package.json', false],
  ['src/*.js', 'src/a.js', true],
  ['src/*.js', 'src/a/b.js', false],
  ['?.txt', 'a.txt', true],
  ['?.txt', 'ab.txt', false],
  ['[ab].txt', 'b.txt', true],
  ['[!ab].txt', 'b.txt', false],
  ['[!ab].txt', 'c.txt', true],
  ['.github/**', '.github/workflows/ci.yml', true],
  ['**/*.yml', '.github/ci-kit.yml', true],
  ['*', '.gitignore', true],
  ['a.b', 'aXb', false],
  ['a+b(c)', 'a+b(c)', true],
  ['tests/sminos/**', 'tests/sminos', false],
  ['**', 'anything/at/all', true],
];

for (const [pattern, path, expected] of cases) {
  test(`glob ${pattern} ${expected ? 'matches' : 'does not match'} ${path}`, () => {
    assert.equal(globMatch(pattern, path), expected);
  });
}

test('matchesAny is true when one pattern matches', () => {
  assert.equal(matchesAny('src/a.js', ['docs/**', 'src/**']), true);
  assert.equal(matchesAny('lib/a.js', ['docs/**', 'src/**']), false);
});
