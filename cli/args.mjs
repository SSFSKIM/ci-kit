// ci-gate [<worktree-or-sha>] [--gates a,b] [--repo OWNER/NAME] [--label NAME] [--keep]   (spec I5)
// ci-gate init [<dir>] [--force] [--repo OWNER/NAME]                                       (plugin spec)

export const USAGE = `usage: ci-gate [<worktree-or-sha>] [--gates a,b] [--repo OWNER/NAME] [--label NAME] [--keep]
       ci-gate init [<dir>] [--force] [--repo OWNER/NAME]   (adopt ci-kit: ci-gate init --help)

Runs the repo's ci-kit gates for one commit on GitHub Actions and reports each gate as it finishes.
  <worktree-or-sha>  a worktree (its HEAD is tested) or a commit; default: the current directory
  --gates a,b        exactly these gates (the CI-Gates trailer); default: selected by the changed files
  --repo OWNER/NAME  the GitHub repo; default: the one origin pushes to
  --label NAME       the ci ref's label; default: the branch name, else "gate"
  --keep             leave the ci/ ref on the remote
Stdout: WAIT/PASS/FAIL/SKIP/CANCEL <gate> lines as gates progress; THROTTLE remaining=<n> once if the token's REST
budget falls below 500 (polls then slow to 60 s); last, GREEN, RED or ERROR.
Exit: 0 GREEN, 1 RED, 2 ERROR (infra or config). CI_GATE_DEBUG=1 logs each API request on stderr.`;

export const INIT_USAGE = `usage: ci-gate init [<dir>] [--force] [--repo OWNER/NAME]

Adopts ci-kit in the repo holding <dir> (default: the current directory): writes .github/workflows/ci.yml, ci-kit's
caller verbatim, and a draft .github/ci-kit.yml with a gate per command the repo declares (package.json scripts,
pytest, Cargo, Go, Swift, Makefile targets), checked by the planner before it is written.
  --force            overwrite either file if it exists (without it, init refuses and writes nothing)
  --repo OWNER/NAME  the GitHub repo whose visibility decides the lanes; default: the one origin pushes to
Stdout: what was written, notes on what was guessed, and the next step. Exit: 0 written, 2 refused or failed.`;

export class UsageError extends Error {}

const VALUED = ['--gates', '--repo', '--label'];

export function parseArgs(argv) {
  const opts = { target: null, gates: [], repo: null, label: null, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    let value;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (VALUED.includes(arg)) {
      if (value === undefined) {
        value = argv[i + 1];
        i += 1;
      }
      if (value === undefined || value === '') throw new UsageError(`${arg} needs a value`);
      if (arg === '--gates') opts.gates = value.split(',').map((s) => s.trim()).filter(Boolean);
      if (arg === '--repo') {
        if (!/^[\w.-]+\/[\w.-]+$/.test(value)) throw new UsageError(`--repo is OWNER/NAME, not ${value}`);
        opts.repo = value;
      }
      if (arg === '--label') opts.label = value;
    } else if (arg === '--keep') {
      opts.keep = true;
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option ${arg}`);
    } else if (opts.target === null) {
      opts.target = arg;
    } else {
      throw new UsageError(`one target only (got ${opts.target} and ${arg})`);
    }
  }
  opts.target ??= '.';
  return opts;
}

// `ci-gate init`'s arguments, after the word init.
export function parseInitArgs(argv) {
  const opts = { target: null, force: false, repo: null };
  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    let value;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg === '--repo') {
      if (value === undefined) {
        value = argv[i + 1];
        i += 1;
      }
      if (value === undefined || value === '') throw new UsageError('--repo needs a value');
      if (!/^[\w.-]+\/[\w.-]+$/.test(value)) throw new UsageError(`--repo is OWNER/NAME, not ${value}`);
      opts.repo = value;
    } else if (arg === '--force') {
      if (value !== undefined) throw new UsageError('--force takes no value');
      opts.force = true;
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option ${arg} for init`);
    } else if (opts.target === null) {
      opts.target = arg;
    } else {
      throw new UsageError(`one directory only (got ${opts.target} and ${arg})`);
    }
  }
  opts.target ??= '.';
  return opts;
}
