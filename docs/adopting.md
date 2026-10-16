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
  fetch_depth: 1            # optional; actions/checkout depth for gate jobs; 0 = full history; default 1
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
    env: {FOO: bar}         # optional; string values (quote numbers); CI_KIT_* names are the kit's
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
   - `paths` are globs anchored at the repo root, in a small dialect: `*` and `?` stay within one directory, `**`
     as a whole segment crosses directories (`src/**`, `**/*.md`), and every other character is literal. Dotfiles
     are not special.
   - Bracket expressions (`[...]`), backslash escapes, braces (`{a,b}`), a leading `!` or `/`, and an empty pattern
     are config errors, naming the gate and `paths[<i>]`, rather than patterns that might silently select nothing.
     List alternatives as separate patterns instead.
3. **An empty selection is a success.** `ci / verdict` is green with "no gates selected".

### Gate jobs

Each selected gate is one job, named after the gate. It checks out the tested commit (a PR's merge commit), applies
`setup` (Node through `actions/setup-node`, `corepack enable` when `pnpm`, then `install`), exports the gate's `env`,
and runs `run`. When the gate fails, its `artifacts` are uploaded as an artifact named after the gate.

The checkout holds `setup.fetch_depth` commits of history: the tested commit alone by default, everything with `0`.
Set `0` when tests read git history (`git log`, blame, tags). Like the rest of `setup`, it does not apply to a gate
with `setup: false`, which checks out at depth 1.

#### The change, in the gate's environment

`install` and `run` see two variables:

| Variable | Holds |
|---|---|
| `CI_KIT_HEAD` | the commit the gate checked out (`HEAD`): a PR's merge commit, or `ci-gate`'s nonce commit, whose tree is the tested commit's |
| `CI_KIT_BASE` | where that commit left the base: for a PR, the base it merges into; for a `ci/**` push, its merge-base with the default branch. **Empty on a dispatch**, which has no change basis |

So `git diff $CI_KIT_BASE $CI_KIT_HEAD` (two dots) is the change the gate is testing. The base commit is fetched into
the checkout whatever `fetch_depth` is, so this works at the default depth. Lint only what changed, for example (on
`hosted`; `--no-run-if-empty` is GNU xargs):

```yaml
  - name: shell-lint
    setup: false
    run: |
      if [ -z "$CI_KIT_BASE" ]; then echo "a dispatch has no change basis: nothing to lint"; exit 0; fi
      git diff --name-only --diff-filter=d -z "$CI_KIT_BASE" "$CI_KIT_HEAD" -- '*.sh' |
        xargs -0 --no-run-if-empty shellcheck
```

`--diff-filter=d` leaves out deleted files. With depth 1 the history between the two commits is absent, so use the
two-dot form above: `git log`, `git merge-base` and three-dot ranges need `fetch_depth: 0`.

A gate's `env` cannot set a `CI_KIT_*` name; the plan refuses it.

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
THROTTLE remaining=<n>       once, when the GitHub token's remaining REST budget falls below 500
```

The last line is `GREEN <run-url>` (exit 0), `RED <failed>/<total> <run-url>` (exit 1) or `ERROR <message>` (exit 2:
a config error, no run within 2 minutes of the push, the API rate limit exhausted while looking for it, gh not logged
in, a run that failed to start). Failed gates' logs are saved to `/tmp/ci-gate/<owner>-<repo>/<run-id>/<gate>.log`,
with their artifacts beside them. The ref is deleted afterwards unless `--keep`, and only while it still points at
this call's commit. Progress notes go to stderr.

**It is gentle with the shared token.** Every session on the account shares the gh login's 5,000 REST requests an
hour, so `ci-gate` polls the run and its jobs with conditional requests (a `304 Not Modified` is not counted against
the limit), every 15 s for the first 2 minutes and every 30 s after that, and fetches logs only for failed gates. When
the remaining budget drops below 500, while looking for the run or watching it, it prints `THROTTLE` and polls
every 60 s until the budget recovers; lines can then arrive up to a minute late. With `CI_GATE_DEBUG=1` it prints each API request and a final count on stderr.

`ci-gate` uses the `gh` CLI's login and needs no other credential. Install it with `install.sh` from a ci-kit checkout
that stays put (it symlinks `~/.local/bin/ci-gate`).

## Versioning

Callers pin `@v1`, a tag the kit moves forward on compatible releases. A breaking schema change becomes `version: 2`
and `@v2`. The planner always runs at the same commit as the reusable workflow that called it.
