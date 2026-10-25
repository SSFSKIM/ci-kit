// Gate selection (spec §1) and the planner's output (spec I3).
import { ConfigError, DEFAULT_FETCH_DEPTH } from './config.mjs';
import { matchesAny } from './glob.mjs';

const RUNS_ON = {
  hosted: () => ['ubuntu-latest'],
  'hosted-macos': () => ['macos-latest'],
  pool: (gate) => ['self-hosted', 'ci-kit-pool', `cpus-${gate.cpus}`],
  mac: () => ['self-hosted', 'macOS', 'ARM64', 'ci-kit-mac'],
};
const NO_SETUP = { node: '', pnpm: false, install: '', fetch_depth: DEFAULT_FETCH_DEPTH, apt: [], brew: [], cask: [], script: '' };

export function splitList(text) {
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

// The `CI-Gates:` trailer (I4): read from the message's last paragraph, as git reads trailers.
export function trailerGates(message) {
  const paragraphs = (message ?? '').trim().split(/\n\s*\n/);
  if (paragraphs.length < 2) return null;
  for (const line of paragraphs.at(-1).split('\n')) {
    const m = /^ci-gates:\s*(.*)$/i.exec(line.trim());
    if (m) return splitList(m[1]);
  }
  return null;
}

// A gate with no paths is touched by every change.
const touched = (gate, changedFiles) => gate.paths.length === 0 || changedFiles.some((f) => matchesAny(f, gate.paths));

// event: pr | ci-ref | dispatch, or a build cache seed: schedule | push. explicit: a gate list from the dispatch input
// or the trailer, or null. changedFiles: repo-relative paths (ignored for an explicit list, a dispatch and a schedule).
export function selectGates(config, { event, explicit = null, explicitSource = 'the gate list', changedFiles = [] }) {
  // The build cache's seeding runs (docs/adopting.md, "Build cache"), which select by build_cache whatever a gate's on.
  // A schedule seeds every gate with a cache, so that the default branch holds each scope; a push to the default
  // branch, those whose paths it changed.
  if (event === 'schedule') return config.gates.filter((g) => g.build_cache);
  if (event === 'push') return config.gates.filter((g) => g.build_cache && touched(g, changedFiles));
  if (explicit && explicit.length > 0) {
    const known = config.gates.map((g) => g.name);
    const unknown = explicit.filter((n) => !known.includes(n));
    if (unknown.length > 0) {
      throw new ConfigError(unknown.map((n) => `unknown gate "${n}" in ${explicitSource} (known: ${known.join(', ')})`));
    }
    return config.gates.filter((g) => explicit.includes(g.name));
  }
  return config.gates.filter((g) => g.on.includes(event) && (event === 'dispatch' || touched(g, changedFiles)));
}

// cacheWrite: whether the build_cache gates write the cache as well as read it (plan.mjs decides).
export function planOutput(config, selected, { cacheWrite = false } = {}) {
  return {
    gates: selected.map((g) => ({
      name: g.name,
      run: g.run,
      runs_on: RUNS_ON[g.lane](g),
      timeout: g.timeout,
      setup: g.setup ? { ...config.setup } : { ...NO_SETUP },
      artifacts: g.artifacts,
      env: g.env,
      build_cache: g.build_cache,
    })),
    pool: selected.some((g) => g.lane === 'pool'),
    note: selected.length === 0 ? 'no gates selected' : '',
    cache_write: cacheWrite,
  };
}
