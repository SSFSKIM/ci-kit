// Gate selection (spec §1) and the planner's output (spec I3).
import { ConfigError } from './config.mjs';
import { matchesAny } from './glob.mjs';

const RUNS_ON = {
  hosted: () => ['ubuntu-latest'],
  'hosted-macos': () => ['macos-latest'],
  pool: (gate) => ['self-hosted', 'ci-kit-pool', `cpus-${gate.cpus}`],
  mac: () => ['self-hosted', 'macOS', 'ARM64', 'ci-kit-mac'],
};
const NO_SETUP = { node: '', pnpm: false, install: '' };

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

// event: pr | ci-ref | dispatch. explicit: a gate list from the dispatch input or the trailer, or null.
// changedFiles: repo-relative paths (ignored for an explicit list and for a dispatch).
export function selectGates(config, { event, explicit = null, explicitSource = 'the gate list', changedFiles = [] }) {
  if (explicit && explicit.length > 0) {
    const known = config.gates.map((g) => g.name);
    const unknown = explicit.filter((n) => !known.includes(n));
    if (unknown.length > 0) {
      throw new ConfigError(unknown.map((n) => `unknown gate "${n}" in ${explicitSource} (known: ${known.join(', ')})`));
    }
    return config.gates.filter((g) => explicit.includes(g.name));
  }
  return config.gates.filter((g) => {
    if (!g.on.includes(event)) return false;
    if (event === 'dispatch' || g.paths.length === 0) return true;
    return changedFiles.some((f) => matchesAny(f, g.paths));
  });
}

export function planOutput(config, selected) {
  return {
    gates: selected.map((g) => ({
      name: g.name,
      run: g.run,
      runs_on: RUNS_ON[g.lane](g),
      timeout: g.timeout,
      setup: g.setup ? { ...config.setup } : { ...NO_SETUP },
      artifacts: g.artifacts,
      env: g.env,
    })),
    pool: selected.some((g) => g.lane === 'pool'),
    note: selected.length === 0 ? 'no gates selected' : '',
  };
}
