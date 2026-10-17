// `.github/ci-kit.yml`, version 1 (spec I1): parse, validate fully, and fill defaults.
// Every problem is collected, so one failed plan names them all; each message names the gate and the field.
import { parse } from '../vendor/yaml/dist/index.js';
import { globProblem } from './glob.mjs';

export class ConfigError extends Error {
  constructor(messages) {
    super(messages.join('\n'));
    this.messages = messages;
  }
}

export const LANES = ['hosted', 'hosted-macos', 'pool', 'mac'];
export const PRIVATE_LANES = ['pool', 'mac'];
export const EVENTS = ['pr', 'ci-ref', 'dispatch'];
export const POOL_SIZES = [2, 4, 8, 16];
// The reusable workflow's own jobs: a gate with one of these names would be indistinguishable from them in checks.
const RESERVED = ['plan', 'verdict'];
const TOP_KEYS = ['version', 'setup', 'gates'];
const SETUP_KEYS = ['node', 'pnpm', 'install', 'fetch_depth'];
// actions/checkout's depth when setup does not say: the tested commit alone.
export const DEFAULT_FETCH_DEPTH = 1;
const GATE_KEYS = ['name', 'run', 'lane', 'cpus', 'timeout', 'paths', 'on', 'artifacts', 'setup', 'env'];
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The kit sets CI_KIT_BASE, CI_KIT_HEAD, CI_KIT_RUN... in gate steps; a gate's env must not shadow or be shadowed by them.
const KIT_ENV_RE = /^CI_KIT_/;

const isMapping = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s !== '');

function unknownKeys(obj, allowed, where, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${where}unknown key "${key}" (allowed: ${allowed.join(', ')})`);
  }
}

function readSetup(raw, errors) {
  const setup = { node: '', pnpm: false, install: '', fetch_depth: DEFAULT_FETCH_DEPTH };
  if (raw === undefined || raw === null) return setup;
  if (!isMapping(raw)) {
    errors.push('setup: must be a mapping');
    return setup;
  }
  unknownKeys(raw, SETUP_KEYS, 'setup: ', errors);
  if (raw.node !== undefined) {
    if (typeof raw.node === 'string' && raw.node !== '') setup.node = raw.node;
    else errors.push('setup.node: must be a string (quote it: node: "24")');
  }
  if (raw.pnpm !== undefined) {
    if (typeof raw.pnpm === 'boolean') setup.pnpm = raw.pnpm;
    else errors.push('setup.pnpm: must be true or false');
  }
  if (raw.install !== undefined) {
    if (typeof raw.install === 'string') setup.install = raw.install;
    else errors.push('setup.install: must be a string');
  }
  if (raw.fetch_depth !== undefined) {
    if (Number.isInteger(raw.fetch_depth) && raw.fetch_depth >= 0) setup.fetch_depth = raw.fetch_depth;
    else errors.push('setup.fetch_depth: must be a whole number of commits, 0 for full history');
  }
  return setup;
}

function readGate(raw, index, seen, isPrivate, errors) {
  if (!isMapping(raw)) {
    errors.push(`gates[${index}]: must be a mapping`);
    return null;
  }
  const label = typeof raw.name === 'string' ? `gate "${raw.name}": ` : `gates[${index}]: `;
  const err = (msg) => errors.push(label + msg);
  unknownKeys(raw, GATE_KEYS, label, errors);

  if (raw.name === undefined) err('name: required');
  else if (typeof raw.name !== 'string' || !NAME_RE.test(raw.name)) err('name: must match [a-z0-9][a-z0-9-]*');
  else if (RESERVED.includes(raw.name)) err(`name: "${raw.name}" is reserved for the workflow's own job`);
  else if (seen.has(raw.name)) err('name: duplicate');
  else seen.add(raw.name);

  if (raw.run === undefined) err('run: required');
  else if (typeof raw.run !== 'string' || raw.run.trim() === '') err('run: must be a non-empty string');

  let lane = 'hosted';
  if (raw.lane !== undefined) {
    if (LANES.includes(raw.lane)) lane = raw.lane;
    else err(`lane: must be one of ${LANES.join(', ')}`);
  }
  if (PRIVATE_LANES.includes(lane) && !isPrivate) {
    errors.push(`lane "${lane}" is for private repos only (gate "${raw.name}")`);
  }

  let cpus = lane === 'pool' ? 4 : null;
  if (raw.cpus !== undefined) {
    if (lane !== 'pool') err('cpus: only for lane pool');
    else if (POOL_SIZES.includes(raw.cpus)) cpus = raw.cpus;
    else err(`cpus: must be one of ${POOL_SIZES.join(', ')}`);
  }

  let timeout = 30;
  if (raw.timeout !== undefined) {
    if (Number.isInteger(raw.timeout) && raw.timeout >= 1 && raw.timeout <= 360) timeout = raw.timeout;
    else err('timeout: must be a whole number of minutes from 1 to 360');
  }

  let paths = [];
  if (raw.paths !== undefined) {
    if (!isStringList(raw.paths)) err('paths: must be a list of strings');
    else {
      paths = raw.paths;
      raw.paths.forEach((p, i) => {
        const problem = globProblem(p);
        if (problem) err(`paths[${i}]: "${p}" ${problem}`);
      });
    }
  }

  let on = [...EVENTS];
  if (raw.on !== undefined) {
    if (!Array.isArray(raw.on)) err('on: must be a list');
    else if (raw.on.length === 0) err(`on: must list at least one of ${EVENTS.join(', ')}`);
    else {
      const bad = raw.on.filter((e) => !EVENTS.includes(e));
      for (const e of bad) err(`on: "${e}" is not one of ${EVENTS.join(', ')}`);
      if (bad.length === 0) on = EVENTS.filter((e) => raw.on.includes(e));
    }
  }

  let artifacts = [];
  if (raw.artifacts !== undefined) {
    if (isStringList(raw.artifacts)) artifacts = raw.artifacts;
    else err('artifacts: must be a list of strings');
  }

  let setup = true;
  if (raw.setup !== undefined) {
    if (typeof raw.setup === 'boolean') setup = raw.setup;
    else err('setup: must be true or false');
  }

  const env = {};
  if (raw.env !== undefined) {
    if (!isMapping(raw.env)) err('env: must be a mapping of names to strings');
    else {
      for (const [key, value] of Object.entries(raw.env)) {
        if (!ENV_NAME_RE.test(key)) err(`env: "${key}" is not a valid variable name`);
        else if (KIT_ENV_RE.test(key)) err(`env: "${key}" is reserved: the kit sets CI_KIT_* variables`);
        else if (typeof value !== 'string') err(`env.${key}: must be a string (quote it)`);
        else env[key] = value;
      }
    }
  }

  return { name: raw.name, run: raw.run, lane, cpus, timeout, paths, on, artifacts, setup, env };
}

// `isPrivate` is the repo's visibility (the event payload's repository.private): pool and mac lanes are private-only.
export function parseConfig(text, { isPrivate }) {
  let raw;
  try {
    raw = parse(text);
  } catch (e) {
    throw new ConfigError([`.github/ci-kit.yml is not valid YAML: ${e.message.split('\n')[0]}`]);
  }
  if (!isMapping(raw)) throw new ConfigError(['the config must be a mapping with version and gates']);

  const errors = [];
  unknownKeys(raw, TOP_KEYS, '', errors);
  if (raw.version !== 1) errors.push('version: must be 1');
  const setup = readSetup(raw.setup, errors);

  const gates = [];
  if (!Array.isArray(raw.gates) || raw.gates.length === 0) {
    errors.push('gates: required, a non-empty list');
  } else {
    const seen = new Set();
    raw.gates.forEach((g, i) => {
      const gate = readGate(g, i, seen, isPrivate, errors);
      if (gate) gates.push(gate);
    });
  }

  if (errors.length > 0) throw new ConfigError(errors);
  return { version: 1, setup, gates };
}
