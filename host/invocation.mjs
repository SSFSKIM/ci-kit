// What a process runs, read from its command line before any pattern sees it. For node and Python the interpreter's
// own options are walked with a table of known options and their arity; the first token after them is the entrypoint.
// The patterns in janitor.json then match the invocation text: `node [--test] <entry> <args…>` or
// `python <entry> <args…>`, and for any other executable the command line as ps prints it.
//
// ps joins argv with spaces, so the command line is split on whitespace: an argument containing a space reads as
// several tokens, which can only make a pattern miss.

import { basename } from 'node:path';

// Node options that keep the script in its place. Anything else (an execution mode such as -e/--eval, -p/--print,
// -c/--check, -i, --run, `-` for stdin, or an option missing from this table) ends the walk with no invocation.
const NODE_FLAGS = new Set([
  '--test', '--test-only', '--test-force-exit', '--test-update-snapshots',
  '--experimental-test-coverage', '--experimental-test-module-mocks', '--experimental-test-snapshots',
  '--experimental-vm-modules', '--experimental-strip-types', '--experimental-transform-types',
  '--experimental-detect-module', '--experimental-require-module', '--experimental-sqlite',
  '--experimental-websocket', '--experimental-wasm-modules', '--experimental-import-meta-resolve',
  '--no-experimental-strip-types', '--no-experimental-require-module', '--no-experimental-detect-module',
  '--no-experimental-fetch', '--no-experimental-global-navigator',
  '--no-warnings', '--no-deprecation', '--throw-deprecation', '--pending-deprecation',
  '--trace-warnings', '--trace-deprecation', '--trace-uncaught', '--trace-exit', '--trace-sigint',
  '--enable-source-maps', '--expose-gc', '--preserve-symlinks', '--preserve-symlinks-main',
  '--frozen-intrinsics', '--no-addons', '--abort-on-uncaught-exception', '--use-strict',
  '--inspect', '--inspect-brk', '--inspect-wait',
]);
// Options whose value may be inline (`--opt=value`) or the next token.
const NODE_VALUE = new Set([
  '--import', '--require', '-r', '--loader', '--experimental-loader', '--conditions', '-C',
  '--env-file', '--env-file-if-exists', '--unhandled-rejections', '--disable-warning', '--input-type', '--title',
  '--redirect-warnings', '--diagnostic-dir', '--report-dir', '--localstorage-file',
  '--test-reporter', '--test-reporter-destination', '--test-concurrency', '--test-name-pattern',
  '--test-skip-pattern', '--test-timeout', '--test-shard', '--test-isolation', '--test-global-setup',
  '--test-coverage-include', '--test-coverage-exclude', '--test-coverage-branches',
  '--test-coverage-functions', '--test-coverage-lines',
]);
// Options that take their value inline only (`--opt=value`).
const NODE_INLINE = new Set(['--inspect', '--inspect-brk', '--inspect-wait', '--inspect-port', '--max-old-space-size', '--max-semi-space-size', '--stack-size']);
// Options that turn on watch mode: such a process is long-lived on purpose, so it is only ever reported.
const NODE_WATCH_FLAGS = new Set(['--watch', '--watch-preserve-output']);
const NODE_WATCH_VALUE = new Set(['--watch-path', '--watch-kill-signal']);

// Python's one-letter flags (they bundle: -uI), and the ones that take a value (-Wignore or -W ignore).
const PY_FLAGS = new Set('IuBEsSObdqvxRP');
const PY_VALUE = new Set('WX');

function walkNode(tokens) {
  let test = false;
  let watch = null;
  let i = 1;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') {
      i++;
      break;
    }
    if (!t.startsWith('-') || t === '-') break;
    const eq = t.indexOf('=');
    const name = eq > 0 ? t.slice(0, eq) : t;
    const inline = eq > 0;
    if (NODE_WATCH_FLAGS.has(name) && !inline) watch = name;
    else if (NODE_WATCH_VALUE.has(name)) {
      watch = name;
      if (!inline) i++;
    } else if (NODE_FLAGS.has(name) && !inline) {
      if (name === '--test') test = true;
    } else if (NODE_INLINE.has(name) && inline) {
      // value given
    } else if (NODE_VALUE.has(name)) {
      if (!inline) i++;
    } else return null; // an execution mode, or an option of unknown arity
  }
  if (tokens[i] === '-') return null; // the script comes from stdin
  if (i > tokens.length) return null; // a value option with its value missing
  return { text: ['node', ...(test ? ['--test'] : []), ...tokens.slice(i)].join(' '), watch };
}

function walkPython(tokens) {
  let i = 1;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') {
      i++;
      break;
    }
    if (!t.startsWith('-') || t === '-') break;
    if (t.startsWith('--')) return null; // long options: none is needed, and their arity varies
    let takesNext = false;
    for (let k = 1; k < t.length; k++) {
      const c = t[k];
      if (PY_VALUE.has(c)) {
        takesNext = k === t.length - 1; // -W ignore; -Wignore carries it inline
        break;
      }
      if (!PY_FLAGS.has(c)) return null; // -c, -m, or an unknown flag
    }
    if (takesNext) i++;
  }
  if (i >= tokens.length || tokens[i] === '-') return null; // the REPL, or a script from stdin
  return { text: ['python', ...tokens.slice(i)].join(' '), watch: null };
}

// { text, watch } for what the command runs, or null when it runs nothing a pattern may judge.
export function invocationOf(command) {
  const tokens = command.trim().split(/\s+/);
  const exe = basename(tokens[0]);
  if (exe === 'node' || exe === 'nodejs') return walkNode(tokens);
  if (/^python[\d.]*$/i.test(exe)) return walkPython(tokens);
  return { text: command, watch: null };
}
