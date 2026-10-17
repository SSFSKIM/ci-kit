// ci-gate init (plugin spec, `ci-gate init`): write the two files a repo adopts ci-kit with (docs/adopting.md): the
// caller workflow, verbatim, and a draft .github/ci-kit.yml with a gate per command the repo declares, validated by the
// planner's own parser before anything is written. Neither file is overwritten without --force. The draft is the
// agent's to judge; `ci-gate` is its proof.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify } from '../vendor/yaml/dist/index.js';
import { createGitHub, ghToken } from '../lib/github.mjs';
import { parseConfig } from '../plan/config.mjs';
import { INIT_USAGE, parseInitArgs, UsageError } from './args.mjs';
import { resolveRemote, TargetError } from './git.mjs';

export const CALLER_PATH = '.github/workflows/ci.yml';
export const CONFIG_PATH = '.github/ci-kit.yml';

// I2, verbatim from docs/adopting.md (a test holds the two equal).
export const CALLER = `name: ci
on:
  pull_request:
  push:
    branches: ['ci/**']
  workflow_dispatch:
    inputs:
      gates: {description: 'comma list of gate names; empty = all', required: false, default: ''}
jobs:
  ci:
    uses: SSFSKIM/ci-kit/.github/workflows/gates.yml@v1
    secrets: inherit
`;

const DEFAULT_NODE = '24';
const NODE_SCRIPTS = ['test', 'lint', 'typecheck', 'type-check', 'build'];
const MAKE_TARGETS = ['test', 'check', 'lint', 'typecheck', 'build'];
// `npm init`'s placeholder test script, which fails by design.
const NPM_PLACEHOLDER = /no test specified/;
const PLACEHOLDER_RUN = 'echo "ci-kit: replace the placeholder gate in .github/ci-kit.yml with this repo\'s own checks" >&2; exit 1';

const read = (dir, file) => {
  try {
    return readFileSync(join(dir, file), 'utf8');
  } catch {
    return null;
  }
};
const has = (dir, file) => existsSync(join(dir, file));
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const readJson = (dir, file) => {
  const text = read(dir, file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// --- Detection: what the repo declares, ecosystem by ecosystem. Each answers
// { source, gates: [{name, run}], install?, node?, pnpm?, notes: [] } or null.

function packageManager(dir, pkg) {
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
  const declaredName = declared.split('@')[0];
  const lock = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json', 'npm-shrinkwrap.json'].find((f) => has(dir, f));
  const name = { 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'bun.lock': 'bun', 'bun.lockb': 'bun' }[lock] ?? (lock ? 'npm' : declaredName || 'npm');
  const notes = [];
  let install;
  let pnpm = false;
  if (name === 'pnpm') {
    pnpm = true;
    install = lock ? 'pnpm install --frozen-lockfile' : 'pnpm install';
    if (!declared.startsWith('pnpm@')) {
      notes.push('package.json has no packageManager "pnpm@<version>", so corepack picks the pnpm version; pin it there');
    }
  } else if (name === 'yarn') {
    const berry = /^yarn@([2-9]|\d{2,})/.test(declared);
    install = berry ? 'corepack enable && yarn install --immutable' : `yarn install${lock ? ' --frozen-lockfile' : ''}`;
  } else if (name === 'bun') {
    // GitHub's runners have no bun; npm installs it.
    install = `npm install -g bun && bun install${lock ? ' --frozen-lockfile' : ''}`;
  } else {
    install = lock ? 'npm ci' : 'npm install';
    if (!lock) notes.push('no lockfile: every run resolves dependencies afresh (commit package-lock.json to pin them)');
  }
  const run = (script) => {
    if (name === 'npm') return script === 'test' ? 'npm test' : `npm run ${script}`;
    return `${name} run ${script}`;
  };
  return { name, lock, install, pnpm, run, notes };
}

function nodeVersion(dir, pkg) {
  for (const file of ['.nvmrc', '.node-version']) {
    const text = read(dir, file)?.trim().split('\n')[0].trim().replace(/^v(?=\d)/, '');
    if (text) return { node: text, from: file };
  }
  const major = String(pkg.engines?.node ?? '').match(/\d+/)?.[0];
  if (major) return { node: major, from: 'engines.node' };
  return { node: DEFAULT_NODE, from: null };
}

function detectNode(dir) {
  const pkg = readJson(dir, 'package.json');
  if (pkg === null) return has(dir, 'package.json') ? { source: 'package.json', gates: [], notes: ['package.json is not valid JSON; no Node gates drafted'] } : null;
  const pm = packageManager(dir, pkg);
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const notes = [...pm.notes];
  const gates = [];
  for (const script of NODE_SCRIPTS) {
    const body = scripts[script];
    if (typeof body !== 'string' || body.trim() === '') continue;
    if (script === 'test' && NPM_PLACEHOLDER.test(body)) {
      notes.push('the "test" script is npm init\'s placeholder, which always fails; no test gate drafted from it');
      continue;
    }
    gates.push({ name: script, run: pm.run(script) });
  }
  const { node, from } = nodeVersion(dir, pkg);
  if (!from) notes.push(`no .nvmrc, .node-version or engines.node: Node ${DEFAULT_NODE} assumed`);
  const os = Array.isArray(pkg.os) ? pkg.os : [];
  const macos = os.length > 0 && os.every((o) => o === 'darwin') ? 'package.json "os" is darwin only' : null;
  return {
    source: `package.json (${pm.name}${pm.lock ? `, ${pm.lock}` : ''})`,
    gates,
    install: gates.length > 0 ? pm.install : undefined,
    node: gates.length > 0 ? node : undefined,
    pnpm: gates.length > 0 && pm.pnpm,
    macos,
    notes,
  };
}

// A [section] of a TOML file, as its raw lines (enough to see which keys it declares).
function tomlSection(text, header) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === `[${header}]`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\s*\[/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

function usesPytest(dir, texts) {
  if (has(dir, 'pytest.ini') || has(dir, 'conftest.py') || has(dir, 'tests/conftest.py')) return true;
  if ((read(dir, 'setup.cfg') ?? '').includes('[tool:pytest]') || (read(dir, 'tox.ini') ?? '').includes('[pytest]')) return true;
  if (texts.some((t) => /\bpytest\b/.test(t))) return true;
  for (const d of ['tests', 'test']) {
    if (isDir(join(dir, d)) && readdirSync(join(dir, d)).some((f) => /^test_.*\.py$|_test\.py$/.test(f))) return true;
  }
  return false;
}

const REQUIREMENTS = ['requirements.txt', 'requirements-dev.txt', 'requirements-test.txt', 'dev-requirements.txt', 'test-requirements.txt'];

function detectPython(dir) {
  const pyproject = read(dir, 'pyproject.toml');
  const reqs = REQUIREMENTS.filter((f) => has(dir, f));
  const setupPy = has(dir, 'setup.py');
  if (pyproject === null && reqs.length === 0 && !setupPy) return null;
  const declared = [pyproject ?? '', ...reqs.map((f) => read(dir, f) ?? '')];
  if (!usesPytest(dir, declared)) {
    return { source: 'pyproject.toml / requirements', gates: [], notes: ['a Python project with no sign of pytest: no Python test gate drafted'] };
  }
  if (has(dir, 'uv.lock')) {
    return { source: 'pyproject.toml (uv, uv.lock)', gates: [{ name: 'test', run: 'uv run pytest' }], install: 'pipx install uv && uv sync --locked', notes: [] };
  }
  if (has(dir, 'poetry.lock')) {
    return { source: 'pyproject.toml (poetry, poetry.lock)', gates: [{ name: 'test', run: 'poetry run pytest' }], install: 'pipx install poetry && poetry install', notes: [] };
  }
  // pip, into the runner's python3 (GitHub's runners allow it, 2026-10-17 probe).
  const parts = [];
  let pytestDeclared = reqs.some((f) => /\bpytest\b/.test(read(dir, f) ?? ''));
  const isPackage = setupPy || /^\s*\[(project|build-system)\]/m.test(pyproject ?? '');
  if (isPackage) {
    const extras = tomlSection(pyproject ?? '', 'project.optional-dependencies') ?? '';
    const extra = ['test', 'tests', 'testing', 'dev'].find((k) => new RegExp(`^\\s*${k}\\s*=`, 'm').test(extras));
    parts.push(extra ? `-e '.[${extra}]'` : '-e .');
    if (extra && /\bpytest\b/.test(extras)) pytestDeclared = true;
  }
  for (const f of reqs) parts.push(`-r ${f}`);
  if (!pytestDeclared) parts.push('pytest');
  return {
    source: `${isPackage ? (pyproject !== null ? 'pyproject.toml' : 'setup.py') : reqs.join(', ')} (pip)`,
    gates: [{ name: 'test', run: 'python3 -m pytest' }],
    install: `python3 -m pip install ${parts.join(' ')}`,
    notes: [],
  };
}

function detectCargo(dir) {
  const cargo = read(dir, 'Cargo.toml');
  if (cargo === null) return null;
  const workspace = /^\s*\[workspace\]/m.test(cargo);
  return { source: 'Cargo.toml', gates: [{ name: 'test', run: workspace ? 'cargo test --workspace' : 'cargo test' }], notes: [] };
}

function detectGo(dir) {
  if (!has(dir, 'go.mod')) return null;
  return { source: 'go.mod', gates: [{ name: 'test', run: 'go test ./...' }], notes: [] };
}

function detectSwift(dir) {
  if (!has(dir, 'Package.swift')) return null;
  return { source: 'Package.swift', gates: [{ name: 'test', run: 'swift test' }], notes: [] };
}

function detectMake(dir) {
  const file = ['GNUmakefile', 'makefile', 'Makefile'].find((f) => has(dir, f));
  if (!file) return null;
  const targets = new Set();
  for (const line of read(dir, file).split('\n')) {
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/);
    if (m) targets.add(m[1]);
  }
  const gates = MAKE_TARGETS.filter((t) => targets.has(t)).map((t) => ({ name: t, run: `make ${t}` }));
  return { source: file, gates, notes: [] };
}

function macosSignal(dir) {
  const project = readdirSync(dir).find((f) => /\.(xcodeproj|xcworkspace)$/.test(f));
  return project ? `${project} at the root` : null;
}

const ECOSYSTEMS = [
  ['node', detectNode],
  ['py', detectPython],
  ['cargo', detectCargo],
  ['go', detectGo],
  ['swift', detectSwift],
  ['make', detectMake],
];

// Every detected command as a gate. A name already taken goes under its ecosystem's prefix (make-test).
export function detect(dir) {
  const found = [];
  const gates = [];
  const taken = new Set();
  const notes = [];
  const installs = [];
  let node;
  let pnpm = false;
  let macos = macosSignal(dir);
  for (const [prefix, fn] of ECOSYSTEMS) {
    const d = fn(dir);
    if (!d) continue;
    found.push(d.source);
    notes.push(...d.notes);
    if (d.install) installs.push(d.install);
    if (d.node) node = d.node;
    if (d.pnpm) pnpm = true;
    if (d.macos) macos ??= d.macos;
    for (const g of d.gates) {
      const name = taken.has(g.name) ? `${prefix}-${g.name}` : g.name;
      if (name !== g.name) notes.push(`${d.source} also has a "${g.name}" command: drafted as gate ${name}; drop it if it runs the same checks`);
      taken.add(name);
      gates.push({ name, run: g.run, from: d.source });
    }
  }
  return { found, gates, notes, installs, node, pnpm, macos };
}

// --- Rendering.

// One YAML scalar on one line (plain when safe, quoted otherwise).
const scalar = (value) => stringify(value, { lineWidth: 0 }).trimEnd();

function block(key, text, indent) {
  if (!text.includes('\n')) return `${indent}${key}: ${scalar(text)}`;
  const pad = `${indent}  `;
  return `${indent}${key}: |\n${text.split('\n').map((l) => pad + l).join('\n')}`;
}

function comment(text, indent = '') {
  // Wrap at about 116 columns.
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && `${indent}# ${line} ${w}`.length > 116) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => `${indent}# ${l}`).join('\n');
}

const POOL_NOTE =
  'This repo is private, so a gate may also run on `lane: pool` (a GCE spot VM per job; `cpus: 2|4|8|16`) once ' +
  "SSFSKIM/ci-kit's pool/config/gce.json lists the repo (a PR in ci-kit) and the owner has installed the " +
  'ci-kit-runners GitHub App on it; or on `lane: mac`, the Mac mini, whose runner only the owner can register.';

// visibility: { isPrivate: true | false | null, reason? }. Unknown is drafted as public: hosted lanes only.
export function render(found, visibility) {
  const isPrivate = visibility.isPrivate === true;
  const out = [];
  out.push(comment('ci-kit gates. Schema: https://github.com/SSFSKIM/ci-kit/blob/main/docs/adopting.md'));
  out.push(
    comment(
      found.found.length
        ? `Drafted by \`ci-gate init\` from ${found.found.join(', ')}. Check that each gate runs what CI should, then prove the config with \`ci-gate\`.`
        : 'Drafted by `ci-gate init`, which found no command to gate: complete the placeholder below, then prove the config with `ci-gate`.',
    ),
  );
  let lane = null;
  if (found.macos && !isPrivate) {
    lane = 'hosted-macos';
    out.push(comment(`This repo looks macOS-specific (${found.macos}), so its gates run on hosted-macos, free on a public repo.`));
  } else if (found.macos) {
    out.push(
      comment(
        `This repo looks macOS-specific (${found.macos}). Its gates are on hosted (ubuntu); hosted-macos works too but bills ` +
          'at 10x on a private repo.',
      ),
    );
  }
  if (isPrivate) out.push(comment(`Every gate runs on hosted (GitHub's ubuntu-latest; billed minutes on a private repo). ${POOL_NOTE}`));
  out.push('version: 1');
  const setup = [];
  if (found.node) setup.push(`  node: ${scalar(found.node)}`);
  if (found.pnpm) setup.push('  pnpm: true');
  if (found.installs.length) setup.push(block('install', found.installs.join('\n'), '  '));
  if (setup.length) out.push('setup:', ...setup);
  out.push('gates:');
  if (found.gates.length === 0) {
    out.push(comment('No test, lint, typecheck or build command was found. This placeholder fails until its run is replaced with the repo\'s own checks.', '  '));
    out.push('  - name: check', block('run', PLACEHOLDER_RUN, '    '));
  }
  for (const g of found.gates) {
    out.push(`  - name: ${g.name}`, block('run', g.run, '    '));
    if (lane) out.push(`    lane: ${lane}`);
  }
  return out.join('\n') + '\n';
}

// --- The command.

// Writes both files into the repo at `dir` (its top level). Answers { code, lines }: what was written and what next,
// or a refusal. The draft is checked by the planner's parser before anything is written.
export function initRepo({ dir, force = false, visibility }) {
  const caller = join(dir, CALLER_PATH);
  const config = join(dir, CONFIG_PATH);
  const callerSame = read(dir, CALLER_PATH) === CALLER;
  if (!force) {
    if (existsSync(config)) {
      return { code: 2, lines: [`ERROR ${CONFIG_PATH} already exists (the repo uses ci-kit already); pass --force to draft it again`] };
    }
    if (existsSync(caller) && !callerSame) {
      return {
        code: 2,
        lines: [
          `ERROR ${CALLER_PATH} already exists and is not ci-kit's caller; ci-gate looks for its runs at that path, so ` +
            'pass --force to replace it (move a workflow of your own to another name first)',
        ],
      };
    }
  }
  const found = detect(dir);
  const text = render(found, visibility);
  let parsed;
  try {
    parsed = parseConfig(text, { isPrivate: visibility.isPrivate === true });
  } catch (e) {
    // The planner refuses the draft: a bug in init, never something to write.
    return { code: 2, lines: [`ERROR the draft fails the planner's validation: ${e.message.split('\n').join('; ')}`] };
  }
  mkdirSync(dirname(caller), { recursive: true });
  if (!callerSame) writeFileSync(caller, CALLER);
  writeFileSync(config, text);

  const lines = [];
  lines.push(callerSame ? `kept ${CALLER_PATH} (already ci-kit's caller)` : `wrote ${CALLER_PATH} (ci-kit's caller, verbatim from docs/adopting.md)`);
  if (found.gates.length) {
    lines.push(`wrote ${CONFIG_PATH}: ${parsed.gates.length} gate${parsed.gates.length > 1 ? 's' : ''} (${parsed.gates.map((g) => g.name).join(', ')}) from ${found.found.join(', ')}`);
  } else {
    lines.push(
      `wrote ${CONFIG_PATH}: no test, lint, typecheck or build command found${found.found.length ? ` in ${found.found.join(', ')}` : ''}, ` +
        'so it holds one placeholder gate, check, that fails until you replace its run with the repo\'s own checks',
    );
  }
  if (visibility.isPrivate === null) lines.push(`note: the repo's visibility is unknown (${visibility.reason}); drafted as for a public repo: hosted lanes only`);
  if (visibility.isPrivate === true) lines.push('note: private repo: every gate is on hosted; the comment in the config says what the pool and mac lanes need');
  for (const n of found.notes) lines.push(`note: ${n}`);
  lines.push('next: review the draft, commit both files, then run ci-gate: GREEN means every gate passed on GitHub');
  return { code: 0, lines };
}

// The repo's visibility through gh's login, or unknown with the reason.
async function readVisibility(dir, repoOpt) {
  let repo;
  try {
    repo = resolveRemote(dir, repoOpt).repo;
  } catch (e) {
    if (e instanceof TargetError) return { isPrivate: null, reason: e.message };
    throw e;
  }
  const token = ghToken();
  if (!token) return { isPrivate: null, reason: 'gh is not authenticated' };
  try {
    const info = await createGitHub(token).getRepo(repo);
    return { isPrivate: info.private === true, repo };
  } catch (e) {
    return { isPrivate: null, reason: `could not read ${repo}: ${e.message}` };
  }
}

export async function runInit(argv, { out }) {
  if (argv.includes('-h') || argv.includes('--help')) {
    out(INIT_USAGE);
    return 0;
  }
  let opts;
  try {
    opts = parseInitArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(INIT_USAGE + '\n');
    out(`ERROR ${e.message}`);
    return 2;
  }
  let top;
  try {
    top = execFileSync('git', ['-C', opts.target, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    out(`ERROR ${opts.target} is not inside a git repo`);
    return 2;
  }
  const visibility = await readVisibility(top, opts.repo);
  const { code, lines } = initRepo({ dir: top, force: opts.force, visibility });
  for (const line of lines) out(line);
  return code;
}
