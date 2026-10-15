import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globMatch, globProblem, matchesAny } from '../plan/glob.mjs';

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

// Constructs the matcher does not implement are refused at validation, so none can silently fail to select.
const refused = [
  ['src/[[:digit:]].js', /bracket expressions/],
  ['[ab].txt', /bracket expressions/],
  ['src/[z-a].js', /bracket expressions/],
  ['a\\*b', /backslash escapes/],
  ['src/{a,b}/**', /braces/],
  ['!src/**', /negation/],
  ['', /empty/],
  ['/src/**', /leading "\/"/],
];
for (const [pattern, why] of refused) {
  test(`globProblem refuses ${JSON.stringify(pattern)}`, () => {
    assert.match(globProblem(pattern) ?? '', why);
  });
}

test('globProblem accepts what globMatch implements', () => {
  for (const p of ['src/**', '**/*.md', '?.txt', 'a+b(c)', '.github/**', 'docs/**/*.md']) assert.equal(globProblem(p), null, p);
});
