// ci-gate [<worktree-or-sha>] [--gates a,b] [--repo OWNER/NAME] [--label NAME] [--keep]   (spec I5)

export const USAGE = `usage: ci-gate [<worktree-or-sha>] [--gates a,b] [--repo OWNER/NAME] [--label NAME] [--keep]

Runs the repo's ci-kit gates for one commit on GitHub Actions and reports each gate as it finishes.
  <worktree-or-sha>  a worktree (its HEAD is tested) or a commit; default: the current directory
  --gates a,b        exactly these gates (the CI-Gates trailer); default: selected by the changed files
  --repo OWNER/NAME  the GitHub repo; default: the one origin pushes to
  --label NAME       the ci ref's label; default: the branch name, else "gate"
  --keep             leave the ci/ ref on the remote
Stdout: WAIT/PASS/FAIL/SKIP/CANCEL <gate> lines as gates progress; THROTTLE remaining=<n> once if the token's REST
budget falls below 500 (polls then slow to 60 s); last, GREEN, RED or ERROR.
Exit: 0 GREEN, 1 RED, 2 ERROR (infra or config). CI_GATE_DEBUG=1 logs each API request on stderr.`;

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
