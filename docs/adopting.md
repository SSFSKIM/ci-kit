# Adopting ci-kit

A repo adopts ci-kit with two files. After that, its pull requests get one check per selected gate plus `ci / verdict`,
and an agent in any of its worktrees verifies a commit with `ci-gate`.

## The two files

### 1. `.github/workflows/ci.yml`

Copy this verbatim:

```yaml
name: ci
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
```

The workflow name `ci` and job id `ci` are what make the checks read `ci / <gate>`, and `ci-gate` looks for the run
of `.github/workflows/ci.yml`. Keep both.

### 2. `.github/ci-kit.yml`

The gates. For example:

```yaml
version: 1
setup:
  node: "24"
  install: npm ci
gates:
  - name: unit
    run: npm test
    paths: ["src/**", "test/**", "package*.json"]
  - name: lint
    run: npm run lint
```

## Schema reference (version 1)

Unknown keys are errors. Every error names the gate and the field, and fails the `plan` job before any gate runs.

```yaml
version: 1                  # required; must be 1
setup:                      # optional; applied to every gate unless the gate sets setup: false
  node: "24"                # optional; an actions/setup-node version spec, quoted
  pnpm: false               # optional; true → corepack enable (pnpm's version from package.json packageManager)
  install: npm ci           # optional; shell command run after checkout
gates:                      # required; non-empty
  - name: unit              # required; [a-z0-9][a-z0-9-]*; unique; not "plan" or "verdict"
    run: npm test           # required; run with bash -eo pipefail at the repo root
    lane: hosted            # hosted | hosted-macos | pool | mac ; default hosted
    cpus: 4                 # pool only; one of 2 4 8 16; default 4
    timeout: 15             # minutes; default 30; max 360
    paths: ["src/**"]       # optional; selection filter for pr and ci-ref
    on: [pr, ci-ref, dispatch]       # optional; default all three
    artifacts: ["test-results/**"]   # optional; uploaded when the gate fails
    setup: true             # optional; false skips the shared setup
    env: {FOO: bar}         # optional; string values (quote numbers)
```

### Lanes

| Lane | Runs on | Who may use it |
|---|---|---|
| `hosted` | GitHub's `ubuntu-latest` | any repo |
| `hosted-macos` | GitHub's `macos-latest` (free on public repos) | any repo |
| `pool` | the on-demand Hetzner box, `[self-hosted, ci-kit-pool, cpus-<N>]` | private repos only |
| `mac` | the Mac mini's runner, `[self-hosted, macOS, ARM64, ci-kit-mac]` | private repos only |

A public repo whose config puts any gate on `pool` or `mac` fails its plan with
`ci-kit: lane "pool" is for private repos only (gate "<name>")`: a stranger's fork PR must never reach a self-hosted
machine.

### Which gates run

1. **An explicit list wins.** On a dispatch, the `gates` input; on a `ci/**` push, the head commit's `CI-Gates: a,b`
   trailer (what `ci-gate --gates` writes). Exactly those gates run; `paths` and `on` are ignored. An unknown name is
   a config error.
2. **Otherwise**, a gate runs when its `on` list includes the event (`pr`, `ci-ref` or `dispatch`) and either it has
   no `paths`, or a changed file matches one of them.
   - Changed files: for a PR, against the PR's base; for a `ci/**` ref, against the merge-base of the tested commit
     and the default branch. Added, modified and deleted files count, and both paths of a rename. A dispatch ignores
     changes.
   - `paths` are globs anchored at the repo root: `*`, `?` and `[...]` stay within one directory, `**` crosses
     directories (`src/**`, `**/*.md`). Dotfiles are not special.
3. **An empty selection is a success.** `ci / verdict` is green with "no gates selected".

### Gate jobs

Each selected gate is one job, named after the gate. It checks out the tested commit (a PR's merge commit), applies
`setup` (Node through `actions/setup-node`, `corepack enable` when `pnpm`, then `install`), exports the gate's `env`,
and runs `run`. When the gate fails, its `artifacts` are uploaded as an artifact named after the gate.

`ci / verdict` always runs and is green only when every selected gate is. It is the one stable check a repo can
choose to require; the kit never makes anything required.

A newer push to a PR cancels the older PR run. A `ci-gate` run is never cancelled by another: each call has its own ref.

## `ci-gate`

```
ci-gate [<worktree-or-sha>] [--gates a,b] [--repo OWNER/NAME] [--label NAME] [--keep]
```

It tests a commit, not a working tree: a worktree's `HEAD` (uncommitted changes are not tested, and it says so on
stderr) or a sha. It pushes that commit plus an empty nonce commit to `ci/<label>-<sha8>-<nonce6>`, follows the run,
and prints one line per gate as it finishes:

```
WAIT <gate> <m>m<ss>s        once, when a gate has been queued for 2 minutes
PASS <gate> <m>m<ss>s
FAIL <gate> <m>m<ss>s log=<path>
SKIP <gate>
CANCEL <gate>
```

The last line is `GREEN <run-url>` (exit 0), `RED <failed>/<total> <run-url>` (exit 1) or `ERROR <message>` (exit 2:
a config error, no run within 2 minutes of the push, gh not logged in, a run that failed to start). Failed gates' logs
are saved to `/tmp/ci-gate/<owner>-<repo>/<run-id>/<gate>.log`, with their artifacts beside them. The ref is deleted
afterwards unless `--keep`, and only while it still points at this call's commit. Progress notes go to stderr.

`ci-gate` uses the `gh` CLI's login and needs no other credential. Install it with `install.sh` from a ci-kit checkout
that stays put (it symlinks `~/.local/bin/ci-gate`).

## Versioning

Callers pin `@v1`, a tag the kit moves forward on compatible releases. A breaking schema change becomes `version: 2`
and `@v2`. The planner always runs at the same commit as the reusable workflow that called it.
