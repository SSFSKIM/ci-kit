// The JUnit reader (test history spec, M2): the report shapes vitest 5, node --test and Playwright write, and the
// XML a tag scanner must still read right.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseJUnit, splitClassname } from '../../history/junit.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const brief = (c) => [c.project, c.file, c.name, c.status];

test('vitest 5: two projects run one file with opposite outcomes, each case keeps its project', () => {
  const { cases } = parseJUnit(fixture('vitest5.xml'));
  const title = cases.filter((c) => c.name === 'Panel > draws its title');
  assert.deepEqual(title.map(brief), [
    ['app', 'src/widgets/Panel.test.tsx', 'Panel > draws its title', 'passed'],
    ['app-compiled', 'src/widgets/Panel.test.tsx', 'Panel > draws its title', 'failed'],
  ]);
  assert.equal(title[1].message, "expected 'Title' to be 'title' // Object.is equality");
  assert.equal(title[0].message, null);
  assert.equal(cases.length, 9);
  assert.equal(cases.filter((c) => c.status === 'skipped').length, 2);
  assert.equal(cases[1].name, 'Panel > keeps "quoted" & <angled> labels');
});

test("vitest 5: a suite's time is its own, not the sum of its cases (hooks and setup count in it)", () => {
  const { suites, cases } = parseJUnit(fixture('vitest5.xml'));
  const sum = cases.filter((c) => c.project === 'app').reduce((t, c) => t + c.ms, 0);
  assert.equal(sum, 413);
  assert.deepEqual(suites[0], { project: 'app', file: 'src/widgets/Panel.test.tsx', ms: 1204, timestamp: '2026-10-21T06:20:39.248Z' });
});

test("vitest 5: a project with its own root names the suite from the repo's root; the suite takes its cases' file", () => {
  const { suites } = parseJUnit(fixture('vitest5.xml'));
  assert.deepEqual(suites[2], { project: 'engine', file: 'src/queue.test.ts', ms: 701, timestamp: '2026-10-21T06:20:39.251Z' });
});

test('node --test: describe blocks are suites without a timestamp, and their names lead the case name', () => {
  const { suites, cases } = parseJUnit(fixture('node-test.xml'));
  assert.deepEqual(cases.map(brief), [
    ['', 'test', 'outer > passes', 'passed'],
    ['', 'test', 'outer > inner > fails', 'failed'],
    ['', 'test', 'outer > skipped one', 'skipped'],
    ['', 'test', 'outer > todo one', 'skipped'],
    ['', 'test', 'top level', 'passed'],
  ]);
  // node writes the message attribute escaped twice; it is read as written, once decoded
  assert.equal(cases[1].message, 'one is not &quot;two&quot;');
  assert.deepEqual(suites, [{ project: '', file: 'test', ms: 7, timestamp: null }]);
});

test("Playwright: CDATA failure text and system-out are read as text; the classname is the file", () => {
  const { suites, cases } = parseJUnit(fixture('playwright.xml'));
  assert.deepEqual(cases.map(brief), [
    ['', 'login.spec.ts', 'login › shows the form', 'passed'],
    ['', 'login.spec.ts', 'login › rejects a bad password', 'failed'],
    ['', 'login.spec.ts', 'login › remembers the user', 'skipped'],
  ]);
  assert.equal(cases[1].message, 'login.spec.ts:12:5 rejects a bad password');
  assert.deepEqual(suites, [{ project: '', file: 'login.spec.ts', ms: 6900, timestamp: '2026-10-21T06:20:30.000Z' }]);
});

test('either quote style, numeric entities, a self-closing testcase, <error> as a failure, a message from CDATA text', () => {
  const xml = `<?xml version='1.0'?>
<!-- a comment with <testcase name="not a case"/> in it -->
<testsuite name='s' timestamp='2026-10-21T00:00:00Z' time='0.5'>
  <testcase classname='p:a.test.ts' name='tab&#9;and &#x263A; and &#10;newline' time='0.1'/>
  <testcase classname="p:a.test.ts" name="literal
newline" time="0.1"/>
  <testcase classname="p:a.test.ts" name="errs" time="0.1"><error message="TypeError: x is not a function&#10;    at y"/></testcase>
  <testcase classname="p:a.test.ts" name="cdata" time="0.1"><failure><![CDATA[

  first line <b>&amp;</b>
  second line]]></failure></testcase>
  <testcase classname="p:a.test.ts" name="failed and skipped" time="0"><failure message="boom"/><skipped/></testcase>
</testsuite>`;
  const { cases } = parseJUnit(xml);
  assert.deepEqual(cases.map((c) => [c.name, c.status, c.message]), [
    ['tab\tand ☺ and \nnewline', 'passed', null],
    ['literal newline', 'passed', null],
    ['errs', 'failed', 'TypeError: x is not a function'],
    ['cdata', 'failed', 'first line <b>&amp;</b>'],
    ['failed and skipped', 'failed', 'boom'],
  ]);
});

test('a failure message is cut to 300 characters', () => {
  const xml = `<testsuite name="s"><testcase classname="a" name="n"><failure message="${'x'.repeat(400)}"/></testcase></testsuite>`;
  assert.equal(parseJUnit(xml).cases[0].message.length, 300);
});

test('the project is split from the classname only when the part before the colon is not a path', () => {
  assert.deepEqual(splitClassname('app-compiled:src/a.test.ts'), { project: 'app-compiled', file: 'src/a.test.ts' });
  assert.deepEqual(splitClassname('src/a.test.ts'), { project: '', file: 'src/a.test.ts' });
  assert.deepEqual(splitClassname('src/odd:name.test.ts'), { project: '', file: 'src/odd:name.test.ts' });
  assert.deepEqual(splitClassname('C:\\work\\a.test.ts'), { project: '', file: 'C:\\work\\a.test.ts' });
  assert.deepEqual(splitClassname('tests.test_mod.TestClass'), { project: '', file: 'tests.test_mod.TestClass' });
  assert.deepEqual(splitClassname(':a.test.ts'), { project: '', file: ':a.test.ts' });
});

test('a report that is not well-formed is refused, not half read', () => {
  assert.throws(() => parseJUnit('<testsuites><testsuite name="s"><testcase name="a">'), /ends inside an open element/);
  assert.throws(() => parseJUnit('<testsuites><testsuite name="s"></testcase></testsuites>'), /mismatched closing tag/);
  assert.throws(() => parseJUnit('<testsuites><testsuite name="s" time=1></testsuite></testsuites>'), /malformed tag/);
  assert.throws(() => parseJUnit('<html><body>not a report</body></html>'), /no <testsuites> or <testsuite>/);
  assert.throws(() => parseJUnit('<testsuites><!-- never closed'), /unterminated comment/);
  assert.throws(() => parseJUnit('<testsuite><testcase><failure><testcase/></failure></testcase></testsuite>'), { message: 'junit: a nested testcase at offset 30' });
});

test('a fault the reader has no rule for is a junit error named by its kind, never by its message', () => {
  const report = { length: 1, indexOf: () => { throw new RangeError('src/a.test.ts > a test name'); } };
  assert.throws(() => parseJUnit(report), { message: 'junit: the report breaks the reader (RangeError)' });
});

test('a report the size of the real one (21k cases) parses in under two seconds', () => {
  const suites = [];
  for (let f = 0; f < 1500; f += 1) {
    const cases = Array.from({ length: 14 }, (_, i) => `<testcase classname="p${f % 10}:src/f${f}.test.ts" name="block &gt; case ${i}" time="0.001"></testcase>`);
    suites.push(`<testsuite name="src/f${f}.test.ts" timestamp="2026-10-21T00:00:00Z" time="0.2">${cases.join('')}</testsuite>`);
  }
  const started = performance.now();
  const { cases } = parseJUnit(`<testsuites>${suites.join('\n')}</testsuites>`);
  assert.equal(cases.length, 21000);
  assert.ok(performance.now() - started < 2000);
});
