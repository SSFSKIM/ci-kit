// ci-gate [<worktree-or-sha>] [--gates a,b] [--repo OWNER/NAME] [--label NAME] [--keep]   (spec I5)
// ci-gate init [<dir>] [--force] [--repo OWNER/NAME]                                       (plugin spec)
// ci-gate status [--repo OWNER/NAME]; ci-gate known add|list …                               (gate ledger spec, M5)

export const USAGE = `usage: ci-gate [<worktree-or-sha>] [--gates a,b] [--repo OWNER/NAME] [--label NAME] [--keep]
       ci-gate init [<dir>] [--force] [--repo OWNER/NAME]   (adopt ci-kit: ci-gate init --help)
       ci-gate status [--repo OWNER/NAME]                   (the gate ledger: ci-gate known --help)
       ci-gate known add|list …

Runs the repo's ci-kit gates for one commit on GitHub Actions and reports each gate as it finishes.
  <worktree-or-sha>  a worktree (its HEAD is tested) or a commit; default: the current directory
  --gates a,b        exactly these gates (the CI-Gates trailer); default: selected by the changed files
  --repo OWNER/NAME  the GitHub repo; default: the one origin pushes to
  --label NAME       the ci ref's label; default: the branch name, else "gate"
  --keep             leave the ci/ ref on the remote
Stdout: WAIT/PASS/FAIL/SKIP/CANCEL <gate> lines as gates progress; THROTTLE remaining=<n> once if the token's REST
budget falls below 500 (polls then slow to 60 s); THROTTLE remaining=<n> until=<time> while an exhausted budget is
waited out (up to 90 min); last, GREEN, RED or ERROR. The ci/ ref is removed after GREEN or RED; after an ERROR
while a run exists it is kept for a rerun, named on stderr with the command that removes it.
After a FAIL line, indented lines may follow from the gate ledger's status of the repo (when it can be read and is
under 48 hours old): base: when the gate last ran on the default branch and failed, and known: for each recorded
reason in force that names the gate. They are context, never a verdict; nothing else changes.
Exit: 0 GREEN, 1 RED, 2 ERROR (infra or config). CI_GATE_DEBUG=1 logs each API request on stderr.`;

export const LEDGER_USAGE = `usage: ci-gate status [--repo OWNER/NAME]
       ci-gate known list [--repo OWNER/NAME]
       ci-gate known add --gate G [--case PATTERN] --reason TEXT --review-by YYYY-MM-DD [--keep] [--repo OWNER/NAME]
                         [--id ID] [--by NAME]

The gate ledger's record of a repo (default: the one origin pushes to), in the store (the private ci-kit-sandbox's
test-history branch, or CI_KIT_STORE=OWNER/NAME@BRANCH), read and written with gh's login.
  status       each gate's latest result on the default branch, how old the record is, and the known entries
  known list   every known entry: in force, keep, expired or not yet begun
  known add    records a reason, in force from today through --review-by:
    --gate G          the gate it names
    --case PATTERN    without --keep: the failing case it names, '<file> › <title>' (file whole or by name), * for
                      anything; without it, every failure of the gate
    --reason TEXT     why (required)
    --review-by DATE  when it stops being in force and is reviewed (required)
    --keep            the gate stays whatever it has caught: the weekly report never nominates it for removal
    --id ID           the entry's id; default keep-<gate> or <gate>-<today>
    --by NAME         who records it; default git's user.name
Exit: 0 done, 2 refused or the store unreadable.`;

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

// Options of the ledger's subcommands: each takes a value but --keep.
function parseOptions(argv, allowed, what) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    let value;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (!arg.startsWith('--')) throw new UsageError(`${what} takes no argument ${arg}`);
    const name = arg.slice(2);
    if (!allowed.includes(name)) throw new UsageError(`unknown option ${arg} for ${what}`);
    if (name === 'keep') {
      if (value !== undefined) throw new UsageError('--keep takes no value');
      opts.keep = true;
      continue;
    }
    if (value === undefined) {
      value = argv[i + 1];
      i += 1;
      // An option where a value belongs is the next option, not the value (`--reason --keep`); a value that starts
      // with a dash is written --name=value.
      if (value?.startsWith('-')) throw new UsageError(`${arg} needs a value, not the option ${value} (for a value that starts with -, write ${arg}=<value>)`);
    }
    if (value === undefined || value === '') throw new UsageError(`${arg} needs a value`);
    if (name === 'repo' && !/^[\w.-]+\/[\w.-]+$/.test(value)) throw new UsageError(`--repo is OWNER/NAME, not ${value}`);
    opts[name] = value;
  }
  return opts;
}

// `ci-gate status`'s arguments, after the word status.
export function parseStatusArgs(argv) {
  return { repo: parseOptions(argv, ['repo'], 'status').repo ?? null };
}

// `ci-gate known`'s arguments, after the word known. What an entry needs (a reason, a date) is checked by the entry
// (history/known.mjs validateKnown), not here.
export function parseKnownArgs(argv) {
  const [action, ...rest] = argv;
  if (action === 'list') return { action, repo: parseOptions(rest, ['repo'], 'known list').repo ?? null };
  if (action !== 'add') throw new UsageError(`ci-gate known add|list, not ${action ?? 'nothing'}`);
  const o = parseOptions(rest, ['gate', 'case', 'reason', 'review-by', 'keep', 'repo', 'id', 'by'], 'known add');
  return { action, gate: o.gate, case: o.case, reason: o.reason, review_by: o['review-by'], keep: o.keep === true, repo: o.repo ?? null, id: o.id, by: o.by };
}
