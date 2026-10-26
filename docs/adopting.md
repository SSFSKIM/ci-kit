# Adopting ci-kit

A repo adopts ci-kit with two files. After that, its pull requests get one check per selected gate plus `ci / verdict`,
and an agent in any of its worktrees verifies a commit with `ci-gate`.

`ci-gate init` writes both: the caller below, verbatim, and a draft `.github/ci-kit.yml` with a gate per command the
repo declares (`package.json` scripts with the package manager its lockfile implies, pytest, Cargo, Go, Swift,
Makefile targets), checked by the planner before it is written. Every gate it drafts is on a hosted lane (a private
repo gets a comment on `pool` and `mac` and the owner's steps they need), and it refuses to overwrite either file
without `--force`. The draft is a starting point: `ci-gate` is the
proof. In a Claude Code session with the ci-kit plugin, asking to set up CI does all of it (the `ci-kit:adopt` skill).

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
  install: npm ci           # optional; shell command run after the packages and setup script
  fetch_depth: 1            # optional; actions/checkout depth for gate jobs; 0 = full history; default 1
  apt: [zsh, fonts-noto-cjk] # optional; Debian/Ubuntu package names, Linux only
  brew: [poppler]           # optional; Homebrew formulas, macOS only (owner/tap/name allowed)
  cask: [libreoffice]        # optional; Homebrew apps, macOS only
  script: .github/ci-setup.sh # optional; relative POSIX path, no .. segment; bash on both platforms
gates:                      # non-empty, unless setup declares packages or a script
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
    build_cache: gha        # optional; hosted only; the GitHub Actions cache for this gate's docker builds
```

### The CI environment declaration

`apt`, `brew`, `cask` and `script` are the repository's CI environment. Declare packages by name, without version
pins (`zsh=5.9` is rejected). `apt` names use lowercase letters, digits, `+`, `.` and `-`; Homebrew also accepts
`@` (for named formulas such as `postgresql@16`), `_` and tap-qualified names. Lists must be lists of strings. A
project requiring an exact tool version installs and checks it in the script instead.

The setup step checks presence, not versions: one `dpkg-query` on Linux (including installed virtual-package
providers), one `brew info --json=v2 --installed` per declared macOS list (including aliases and old names).
It installs only the missing names (`sudo -n apt-get` on Linux, `brew install` on macOS), then runs the script with
bash from the repository root, with `CI=true` and `CI_KIT_SETUP_MODE=job` (or `bake` in an image build). The script
runs **every time**, even on a matching image. Make it idempotent and fast when satisfied: check a command or its
version before downloading it. The action supplies no secrets. Scripts may use tools already available on the
runner; the action itself needs no Node on PATH, but it does not provision the declaration's Node or pnpm. The gates
workflow sets those up first; a custom workflow must do so when its script or install command needs them.

Package installs and scripts that fail fail the step, naming the package or script. An image hash is only a cache
hint: `CI_KIT_SETUP_HASH` matching the declaration produces `ci-kit setup: image matches setup <hash>`; a differing
hash produces a notice naming both, and the job still installs what is missing. Hosted runners and the Mac mini's
own runner normally have no image hash. Each run prints a summary naming the packages installed and the elapsed
seconds. Installs on the mini persist on the owner's machine.

**macOS apps have a first-run exception.** A newly installed app carrying `com.apple.quarantine` is named in a
warning. It needs a human's first-run approval on that lane before tests can launch it; the action never removes
quarantine or approves dialogs. A cask installer asking for a password or sudo fails with a message saying it needs
an administrator and a manual install. It does not prompt interactively.

#### Repositories with their own workflow

A repository may keep its jobs in its own workflow and use `.github/ci-kit.yml` only for this declaration:

```yaml
version: 1
setup:
  apt: [cowsay]
  brew: [cowsay]
  script: .github/ci-setup.sh
  install: npm ci
```

Omit `gates`, or set `gates: []`: the planner produces zero gates. A file with neither gates nor a nonempty package
list or script is still an error (`node` or `install` alone does not constitute an environment declaration).

After checkout (and any project Node/pnpm setup), call:

```yaml
- uses: SSFSKIM/ci-kit/setup@v1
  id: environment
  with:
    install: true
```

Inputs: `root` defaults to the workspace; `install` defaults to `false`. With `true`, the declared install command
runs after the script. The gates workflow uses the default because it keeps its own Install step, and skips the
action altogether for an empty declaration or a gate with `setup: false`.

`skip` (default empty) omits declared packages this job does not need, without changing the declaration or its hash:

```yaml
- uses: SSFSKIM/ci-kit/setup@v1
  with:
    install: true
    skip: ${{ runner.os == 'macOS' && !matrix.libreoffice && 'cask:libreoffice' || '' }}
```

Use whitespace-separated `apt:name`, `brew:name` or `cask:name` entries, matching the declaration exactly (including
any tap prefix). For example, `cask:libreoffice brew:owner/tap/tool`. Duplicates are ignored; malformed or undeclared
entries fail before package commands or scripts run, so a typo cannot silently leave an expensive install enabled.
Entries declared for the other platform are accepted but have no effect there. The log names the skipped entries;
`installed` still names only packages actually installed. An entirely skipped list needs no presence query. This
omits direct package requests, not dependencies of other packages, and never uninstalls anything already present.
The script and optional install command still run unchanged; the caller must ensure neither needs the omitted
packages. Image bakes always apply the full declaration; `skip` is a job-only action input, not a bake CLI option.

Outputs: `hash`, the commit's setup hash (`none` without a declaration); `installed`, space-separated `apt:<name>`,
`brew:<name>`, `cask:<name>` entries (empty if nothing was installed); `stale`, `true` only when an image hash was
present and differed. The hash includes the canonical package lists, Node, pnpm, install command, script path and
script bytes, but not checkout depth or lockfiles. Images are caches of this identity, never a correctness
requirement.

The same applier is available to image builds, with the kit checkout and its vendored parser alongside it:

```bash
node setup/apply.mjs --mode bake --root /path/to/clone [--install]
```

### Lanes

| Lane | Runs on | Who may use it |
|---|---|---|
| `hosted` | GitHub's `ubuntu-latest` | any repo |
| `hosted-macos` | GitHub's `macos-latest` (free on public repos) | any repo |
| `pool` | a GCE spot VM per job for repos in `pool/config/gce.json` (the frozen Hetzner pool for `pool.json`), `[self-hosted, ci-kit-pool, cpus-<N>]` | private repos only |
| `mac` | the mac lane's runners (the Mac mini and a second Mac), `[self-hosted, macOS, ARM64, ci-kit-mac]` | private repos only |

A public repo whose config puts any gate on `pool` or `mac` fails its plan with
`ci-kit: lane "pool" is for private repos only (gate "<name>")`: a stranger's fork PR must never reach a self-hosted
machine.

A `pool` gate needs the repo served by the pool and the `HCLOUD_TOKEN` secret; see [pool.md](pool.md), "Using the
pool from a repo". The `plan` job then creates the box if none exists, and the gate's first run on a cold box waits
about a minute for it (`ci-gate` prints `WAIT` after 2 minutes). Inside the job, `nproc` reports the gate's `cpus`.

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
3. **The build cache's seeds.** For a caller that adds them (see [Build cache](#build-cache)), a `schedule` plans every
   gate with `build_cache`, whatever its `paths` and `on`, and a push to the default branch the ones whose `paths` it
   changed (all of them when the branch has no earlier tip to diff against). Neither plans any other gate.
4. **An empty selection is a success.** `ci / verdict` is green with "no gates selected".

### Gate jobs

Each selected gate is one job, named after the gate. It checks out the tested commit (a PR's merge commit), applies
`setup` (Node through `actions/setup-node`, `corepack enable` when `pnpm`, packages and the setup script, then
`install`), exports the gate's `env`,
and runs `run`. When the gate fails, its `artifacts` are uploaded as an artifact named after the gate.

The checkout holds `setup.fetch_depth` commits of history: the tested commit alone by default, everything with `0`.
Set `0` when tests read git history (`git log`, blame, tags). Like the rest of `setup`, it does not apply to a gate
with `setup: false`, which checks out at depth 1.

#### The change, in the gate's environment

`install` and `run` see two variables:

| Variable | Holds |
|---|---|
| `CI_KIT_HEAD` | the commit the gate checked out (`HEAD`): a PR's merge commit, or `ci-gate`'s nonce commit, whose tree is the tested commit's |
| `CI_KIT_BASE` | where that commit left the base: for a PR, the base it merges into; for a `ci/**` push, its merge-base with the default branch; for a push to the default branch, the branch's tip before it. **Empty on a dispatch or a schedule**, which have no change basis, and on a default-branch push with no earlier tip to diff against |

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

#### Build cache

`build_cache: gha` lets a gate's `docker build` keep its layers in the GitHub Actions cache (BuildKit's `type=gha`
backend). Every run reads the cache; only a run on the default branch writes it: a weekly schedule there writes each
week's scope before anything needs it, and a merge that changes a cache gate's files writes it again.

The runner gives the cache service's token and URLs to JS actions only, never to `run:` steps, so before `install`
the gate's job exports them: `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_RESULTS_URL`, `ACTIONS_CACHE_URL` and
`ACTIONS_CACHE_SERVICE_V2`, from which buildx fills a `type=gha` cache's token and URL. With them come
`CI_KIT_BUILD_CACHE=gha`, and `CI_KIT_BUILD_CACHE_WRITE=1` when the run's ref is the default branch. It is a gate's
key, not part of the shared `setup`, so only the gates that build images hold the token; a gate without it gets none
of these variables. It applies with `setup: false` too. It is for the `hosted` lane only: GitHub's macOS runners have
no Docker, and a `pool` job's container has no Docker daemon.

The gate's command reads the cache, and writes it when told to:

```bash
cache=()
if [ "${CI_KIT_BUILD_CACHE:-}" = gha ]; then
  scope="myimage-$(date -u +%G-W%V)"
  cache=(--output "type=image,compression=zstd,oci-mediatypes=true" --cache-from "type=gha,scope=$scope")
  if [ -n "${CI_KIT_BUILD_CACHE_WRITE:-}" ]; then
    cache+=(--cache-to "type=gha,mode=min,scope=$scope,compression=zstd,ignore-error=true")
  fi
fi
docker build ${cache[@]+"${cache[@]}"} -t myimage .   # the ${...+...} form keeps bash 3.2's set -u quiet
```

The caller's `on:` gains the seeds: its default branch (here `main`) in `push: branches`, and a schedule, for example
just after the ISO week turns and again that morning:

```yaml
  push:
    branches: ['ci/**', main]
  schedule:
    - cron: '23 0 * * 1'
    - cron: '47 6 * * 1'
```

GitHub delays scheduled runs under load, worst at the start of each hour, and may drop them: doperpowers' first seed,
at 00:10 on 2026-10-26, never ran, and its week's scope stayed cold until a seed by hand. Hence a minute away from the
hour and a second fire, which seeds a dropped week and otherwise rebuilds a warm scope, finding every layer cached.

A schedule runs on the default branch and plans every `build_cache` gate. A push to the default branch plans the
`build_cache` gates whose `paths` match what it changed since the branch's tip before it, and every one of them when
there is no such tip to diff against (a new branch, a force push). Each seed is the gate's whole run, so a broken image
shows on the default branch. Neither seed plans any other gate: gates without `build_cache` run as before, on the events
they always had, and a merge is not tested again.

So a merge that changes no cache gate's files costs a plan job and the verdict, about 15 s on two hosted runners. One
that does runs those gates once, and the pull requests and `ci-gate` calls after it read the new layers rather than each
building them cold until the next schedule. Merges close together seed side by side, and the seed that finishes last
names the scope's layers: if an older one finishes after a newer one, the layers the newer one changed are built again
until a later seed. A push to any other branch outside `ci/**` still fails the plan. To seed by hand, dispatch on the
default branch: `gh workflow run ci.yml --ref <default branch> -f gates=<a cache gate>`. GitHub disables a public
repository's schedule after 60 days without activity in it.

- **Why only the default branch writes.** GitHub scopes a cache entry to the ref that wrote it. A run reads its own
  ref's entries and the default branch's (a PR run its base branch's too), never a sibling's. Every `ci-gate` call
  pushes a ref of its own, so what one writes is read only by a re-run of that run; a PR's writes, only by its own
  later runs. Those uploads cost each build its export (about 40 s for 600 MB of layers) and fill the repository's
  10 GB, so they are not made. A PR's re-run reads what the default branch holds and rebuilds the rest.
- The hosted runners' Docker (29 on `ubuntu-latest`) uses the containerd image store, whose default builder exports
  a `type=gha` cache itself: the image lands in the daemon as it always does, with no other builder and no `--load`.
  A daemon without that store refuses the export ("Cache export is not supported for the docker driver"); there the
  command needs a builder of its own (`docker buildx create --driver docker-container`, then `--builder` and `--load`).
- **The key is the command's business.** A `scope` holds one cache, which each export replaces, so give each image a
  scope of its own; gates that build the same image can share one. When a step installs "latest" (an
  `apt-get install`, a release download), a scope that changes only with the files keeps testing the first build's
  packages: give it an age bound, such as the ISO week above, which the weekly seed refreshes.
- `mode=min` exports the layers of the image built, which for a single-stage build is every step; a multi-stage build
  whose earlier stages are slow needs `mode=max`. `ignore-error=true` keeps a cache service failure from failing
  the gate.
- **zstd layers.** The containerd image store keeps every layer compressed, so the daemon compresses what it builds:
  gzip took 37–51 s of a 600 MB image's build, zstd 10–13 s, cache or no cache. The cache's `compression=zstd`
  keeps its layers the image's own, and a hit downloads and unpacks them faster too.
- **What a hit still costs.** A build that hits downloads and unpacks each layer: 25 s for 600 MB, the download 13 s
  of it, in a 27 s warm build of an image that takes 92–101 s uncached. Each layer comes down as one stream, so gates
  pulling the same layers at once wait longer (three at once: 28–38 s). The cache pays where building a layer takes
  longer than moving it.
- **What the token can do.** It is the job's runtime token: it reads and writes the run's cache scope, reads the
  default branch's, and uploads artifacts to the run. Gate commands are the repository's code, already trusted with
  the checkout; the opt-in keeps the token from the gates that do not build. A `pull_request` run can write only to
  its merge ref (`refs/pull/<n>/merge`), so a pull request, a fork's included, cannot change what other runs read.
- **Size.** A repository's caches share 10 GB by default, least recently used entries evicted first, and an entry not
  read for 7 days is dropped. A scope costs about its image's compressed layers, a week at a time; gates that share a
  scope each upload their own copy of a layer that does not build byte for byte the same, and the copies the index
  does not name age out. Each seed that rebuilds a layer uploads it again, so a scope that several merges a week
  rebuild holds as many copies until the old ones age out. Gates that share a scope can leave the writing to one of
  them: the others read it, and their seeds upload nothing.

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

`ci-gate` uses the `gh` CLI's login and needs no other credential. The ci-kit Claude Code plugin puts it on the Bash
tool's PATH in every session (below). Outside Claude Code, install it with `install.sh` from a ci-kit checkout that
stays put (it symlinks `~/.local/bin/ci-gate`). Claude Code appends plugin `bin/` directories after the shell's own
PATH, so that symlink, where it exists, is the `ci-gate` a session runs.

## The Claude Code plugin

The repo root is a Claude Code plugin, listed in the doperpowers marketplace:

```bash
claude plugin marketplace add SSFSKIM/doperpowers   # once per machine, if not added yet
claude plugin install ci-kit@doperpowers
```

- **`ci-gate`** is on the Bash PATH (the plugin's `bin/`). It has no npm dependencies; `ci-gate init` reads the
  planner, whose YAML parser is vendored under `vendor/yaml/`, so nothing is installed.
- **A note at session start.** In a worktree whose repo has `.github/ci-kit.yml`, the session (and every subagent) is
  told to verify commits with `ci-gate` rather than running the gates on the machine, and what its output means. In any
  other repo the hook prints nothing. A repo needs no CLAUDE.md line for this.
- **`ci-kit:adopt`**, the skill a session uses when asked to set up CI: `ci-gate init`, judging the draft, a GREEN
  `ci-gate`, the PR, and for a private repo the steps only the owner can take.

The plugin has no `version`: Claude Code versions it by the commit of `main`, so every merged change reaches the
installs on their next update.

## Versioning

Callers pin `@v1`, a tag the kit moves forward on compatible releases. A breaking schema change becomes `version: 2`
and `@v2`. The planner always runs at the same commit as the reusable workflow that called it.
