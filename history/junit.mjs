// A JUnit XML reader (test history spec, Design "Format"): a dependency-free tag scanner over the report vitest,
// `node --test`, Playwright and pytest all write. It reads what the record needs, each outermost <testsuite> (a file,
// for the runners that have one) and each <testcase>, and refuses anything that is not well-formed enough to trust.

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref] ?? whole;
  });
}

// XML normalizes a literal tab, newline or carriage return in an attribute value to a space; a character reference
// (&#10;) survives as itself.
const attrValue = (raw) => decode(raw.replace(/[\t\n\r]/g, ' '));

const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
const ATTR = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attributes(raw) {
  const out = {};
  for (const m of raw.matchAll(ATTR)) out[m[1]] = attrValue(m[2] ?? m[3]);
  return out;
}

// `<project>:<file>` when the part before the first colon is not a path (no slash, not a drive letter); otherwise
// the whole classname is the file and the project is empty.
export function splitClassname(classname) {
  const i = classname.indexOf(':');
  if (i > 0 && i < classname.length - 1) {
    const before = classname.slice(0, i);
    const rest = classname.slice(i + 1);
    const drive = /^[A-Za-z]$/.test(before) && /^[\\/]/.test(rest);
    if (!/[\\/]/.test(before) && !drive) return { project: before, file: rest };
  }
  return { project: '', file: classname };
}

const seconds = (s) => {
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : 0;
};

const firstLine = (text) => (text ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';

// parseJUnit(xml) → { suites: [{ project, file, ms, timestamp }], cases: [{ project, file, name, status, ms, message }] }
// - A suite is an outermost <testsuite>. Its project and file are its first case's; a suite with no case takes its
//   own name as the file. `ms` is the suite's own time, which counts hooks and setup its cases' times do not.
// - A case carries the names of the describe blocks around it before its own, joined with ' > ' as vitest joins
//   its own. A describe block is an inner <testsuite>, or an outermost one with no timestamp: vitest, Playwright and
//   pytest stamp the suite that stands for a file, while `node --test` writes its describe blocks as suites and stamps
//   none.
// - `status` is 'failed' for a <failure> or an <error>, else 'skipped' for a <skipped>, else 'passed'. `message` is
//   the first line of the failure's message attribute, else of its text.
// Throws on a report that is not well-formed: an unterminated or mismatched tag, a testcase inside a testcase, or no
// <testsuites>/<testsuite>. Every error it throws begins `junit: `: the reader is pure over its input, so a fault
// with no rule of its own is the report's too, and it is named by its kind alone, since its message could quote the
// report.
export function parseJUnit(xml) {
  try {
    return scan(xml);
  } catch (err) {
    if (/^junit: /.test(err?.message ?? '')) throw err;
    throw new Error(`junit: the report breaks the reader (${err?.name ?? 'Error'})`);
  }
}

function scan(xml) {
  const suites = [];
  const cases = [];
  const stack = []; // open element names
  const suitePath = []; // the open <testsuite>s' names, '' for a file's
  let suite = null; // the open outermost suite's record
  let current = null; // the open <testcase>
  let fault = null; // the open <failure>/<error>: { attrMessage, text }
  let sawRoot = false;
  let i = 0;

  const openSuite = (attrs) => {
    sawRoot = true;
    if (suitePath.length === 0) {
      suite = { project: null, file: null, ms: seconds(attrs.time), timestamp: attrs.timestamp ?? null, name: attrs.name ?? '' };
      suites.push(suite);
      suitePath.push(attrs.timestamp === undefined ? (attrs.name ?? '') : '');
    } else suitePath.push(attrs.name ?? '');
  };
  const closeSuite = () => {
    suitePath.pop();
    if (suitePath.length === 0) suite = null;
  };
  const openCase = (attrs) => {
    const { project, file } = splitClassname(attrs.classname ?? '');
    const blocks = suitePath.filter((n) => n !== '');
    current = { project, file, name: [...blocks, attrs.name ?? ''].join(' > '), status: 'passed', ms: seconds(attrs.time), message: null };
    if (suite && suite.file === null) {
      suite.project = project;
      suite.file = file;
    }
  };
  const closeCase = () => {
    cases.push(current);
    current = null;
  };

  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (fault && lt > i) fault.text += decode(xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) throw new Error('junit: an unterminated comment');
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end < 0) throw new Error('junit: an unterminated CDATA section');
      if (fault) fault.text += xml.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) throw new Error('junit: an unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt + 2);
      if (end < 0) throw new Error('junit: an unterminated declaration');
      i = end + 1;
      continue;
    }
    TAG.lastIndex = lt;
    const m = TAG.exec(xml);
    if (!m) throw new Error(`junit: a malformed tag at offset ${lt}`);
    i = TAG.lastIndex;
    const [, closing, name, rawAttrs, selfClosing] = m;

    if (closing) {
      if (stack.pop() !== name) throw new Error(`junit: a mismatched closing tag at offset ${lt}`);
      if (name === 'testsuite') closeSuite();
      else if (name === 'testcase' && current) closeCase();
      else if ((name === 'failure' || name === 'error') && fault) {
        current.message = (fault.attrMessage ? firstLine(fault.attrMessage) : '') || firstLine(fault.text);
        fault = null;
      }
      continue;
    }

    const attrs = attributes(rawAttrs);
    if (name === 'testsuites') sawRoot = true;
    else if (name === 'testsuite') openSuite(attrs);
    else if (name === 'testcase') {
      if (current) throw new Error(`junit: a nested testcase at offset ${lt}`);
      openCase(attrs);
    }
    else if ((name === 'failure' || name === 'error') && current) {
      current.status = 'failed';
      if (selfClosing) current.message = firstLine(attrs.message);
      else fault = { attrMessage: attrs.message ?? '', text: '' };
    } else if (name === 'skipped' && current && current.status === 'passed') current.status = 'skipped';

    if (selfClosing) {
      if (name === 'testsuite') closeSuite();
      else if (name === 'testcase') closeCase();
    } else stack.push(name);
  }
  if (stack.length > 0) throw new Error('junit: the report ends inside an open element');
  if (!sawRoot) throw new Error('junit: no <testsuites> or <testsuite> element');

  for (const s of suites) {
    if (s.file === null) Object.assign(s, { project: '', file: s.name });
    delete s.name;
  }
  for (const c of cases) if (c.message !== null) c.message = c.message.slice(0, 300);
  return { suites, cases };
}
