# Projects declare their own CI environment

Today a repository's CI environment lives in five places, none of them the repository's own: the Linux pool's job
image (`pool/image/Dockerfile`, which bakes MAWS's zsh and fonts), the pool bake's cache warming
(`pool/bake/warm.mjs`, which hard-codes MAWS), the Mac VM guest's provisioning (`mac/vm/provision.sh`'s `node`,
`store`, `libreoffice`, `poppler` and `engine` steps), the Mac mini's own Homebrew set (`docs/mac-lane.md`, host
setup), and each project's per-job installs (MAWS's `.github/actions/setup/action.yml`, manim-master's `apt-get` lines
in its gates). A tool a project starts to need shows up as a failed run on whichever lane lacks it: Poppler in the
guest (2026-10-24), Claude Code at `~/.local/bin/claude` in the guest (2026-10-24, ci-kit #137), each found by a wave
run and fixed by a ci-kit change.

After this work, a project says what its CI sandbox contains in its own `.github/ci-kit.yml`: Linux packages,
macOS formulas and apps, and an idempotent script for the rest. Every CI job, on every lane, applies that
declaration right after checkout, installing only what is missing. Images become caches of the declaration: each
records which declaration it was built from, and a job on an older image installs the difference, says so in its
log, and still passes. A project that adds a tool adds it to its declaration in the same pull request, and the
pull request is green on every lane. ci-kit stops carrying any project's tool list.

How to see it working: a pull request to a served repository that adds a package to `setup.apt` and a test that
calls it passes on the pool on its first run, with a job log line naming the package as installed at job time; an
hour after it merges, a new pool image carries the package, and the next job's log says the image matches.

The owner chose this (2026-10-25): "project should declare their own CI env", with the declaration in
`.github/ci-kit.yml` rather than in `devenv/`. `devenv/` is devcloud's agent development sandbox, which not every
project has; the CI sandbox is its counterpart ("[agent dev environment] <--> [remote CI sandbox]"). The devenv skill
already writes `devenv/` from `.github/ci-kit.yml`'s `setup`, so the CI declaration is also where an agent's
development environment learns what to install; nothing in this work changes devenv. The owner also ruled that a
job on the Mac mini's own runner may install what the project declares, as `devenv up` does on the person's other
Macs.

## Progress

- [x] (2026-10-25 00:3xZ) Design approved by the owner (declaration in `.github/ci-kit.yml`, mini host installs).
- [ ] Spec reviewed (adversarial design review, buildability review).
- [ ] M1 — The declaration and the setup step.
- [ ] M2 — MAWS declares its environment.
- [ ] M3 — Linux per-repo job images.
- [ ] M4 — Rebuild on a declaration change.
- [ ] M5 — The Mac guest from the declaration.
- [ ] M6 — ci-kit forgets MAWS.
- [ ] M7 — manim-master declares its environment; acceptance.

## Glossary

- **Declaration**: the `setup` block of a repository's `.github/ci-kit.yml`, with the script file it names.
- **Setup hash**: a digest of the declaration (defined in Interfaces) that an image records and a job recomputes.
- **The setup step**: ci-kit's action that applies a declaration in a job, `SSFSKIM/ci-kit/setup@v1`.
- **Lane**: where a job runs. The Linux pool (a GCE or EC2 VM per job, the job inside a Docker container from a
  baked image: `gce/vm/run.mjs`, `ec2/vm/job.mjs`, `pool/agent/docker.mjs` `runArgs`); the Mac VM guest (an
  ephemeral Tart clone of a golden image on the Mac mini, `mac/vm/`); the Mac mini's own runner (the owner's
  machine, user `new`); GitHub's hosted runners (cua's macOS, doperpowers' and ci-kit's Ubuntu).
- **Job image**: the Docker image a pool job's container runs. Today one, `ci-kit-runner:latest`
  (`pool/agent/docker.mjs` `IMAGE`), built from `pool/image/Dockerfile` by `pool/bake/prepare.sh`.
- **Served repository**: a repository in `pool/config/gce.json` `repos` (today ci-kit-sandbox, MAWS, manim-master).
  The Hetzner pool (`pool/config/pool.json`) serves none and is out of scope.

## Acceptance

Each item is behavior someone can observe; the milestone that proves it is named.

1. **A declaration validates.** A `.github/ci-kit.yml` holding only `version: 1` and a `setup` block with `apt`,
   `brew`, `cask` and `script` is accepted by `plan/config.mjs` (and so by `ci-gate` and the gates workflow's plan
   job), producing zero gates. Malformed entries are refused naming the key: a package name with a version pin
   (`zsh=5.9`), a non-list, a script path that is absolute or climbs out of the repository. (M1)
2. **A job installs what its image lacks.** On ci-kit-sandbox, a branch whose `setup.apt` (and `setup.brew` for a
   macOS gate) names a small package absent from the runner, with a gate that runs it, passes on the hosted
   Ubuntu lane, the hosted macOS lane and the pool lane. Each job log shows the setup step's summary naming the
   package as installed, then the gate's output. (M1)
3. **A job on a matching image installs nothing.** A pool job whose image was built from its commit's declaration
   logs `ci-kit setup: image matches setup <hash>` and no install, and the step takes under 10 s. (M3)
4. **A job on an older image still passes.** A pool or guest job whose commit declares a package the image lacks
   logs a `::notice::` naming the image's setup hash and the commit's, installs the package, and passes. (M1 proves
   the install path on hosted and pool lanes; M3 proves the hash comparison on the pool; M5 on the guest.)
5. **MAWS is green from its own declaration.** MAWS master's `.github/ci-kit.yml` declares its environment, its gate
   workflow applies it on every lane, and a full MAWS `ci-gate` run (`--gates all --runner macos`) is green: the
   pool's Linux jobs, the Mac mini's own runner and the guest's `MAC_VM_E2E` groups. (M2)
6. **Each served repository's pool jobs run on its own job image.** After a bake, the newest ready GCE image and the
   newest ready AMI each carry `ci-kit-job/ssfskim-maws` and `ci-kit-job/ssfskim-manim-master` (the latter once M7
   lands) beside `ci-kit-runner`, and record each one's setup hash (GCE image labels, AMI tags). A MAWS pool job's
   log names the job image it ran on. A repository with no declaration runs on `ci-kit-runner`. The bake's log
   reports each job image's own size above the base. (M3)
7. **A declaration change rebuilds the pool images on its own.** A merge that changes a served repository's
   declaration on its default branch is followed, within the hour plus one bake, by new ready images whose
   recorded hash matches, with no manual dispatch; an hour with no change starts no bake. (M4)
8. **The guest is baked from MAWS's declaration.** A Mac golden baked after M5 carries Poppler, LibreOffice and
   Claude Code because MAWS's declaration names them, not because `provision.sh` does. The bake prints the
   first-run click step for every app the declaration left quarantined (LibreOffice today), and a guest job's log
   says the image matches. Wave 3's groups that are green on the current guest stay green on it. (M5)
9. **The mini's own runner installs what is declared.** A MAWS job on the mini whose declaration names a formula
   the mini lacks installs it with Homebrew and passes; a cask whose installer needs an administrator password
   fails the step with a message naming the cask and saying it needs a manual install. (M2, with a scratch formula)
10. **ci-kit carries no project's tool list.** `pool/image/Dockerfile` has no zsh or MAWS fonts, `pool/bake/warm.mjs`
    (or its successor) names no repository, and `mac/vm/provision.sh` has no `store`, `libreoffice`, `poppler` or
    `engine` step; MAWS's full `ci-gate` run stays green. (M6)
11. **A second project works the same way.** manim-master declares ffmpeg, PostgreSQL 16 and uv; its gates drop
    their per-job `apt-get` and uv installs; its pool jobs pass with the setup step reporting the image matches.
    (M7)

## Design

### The declaration

`setup` in `.github/ci-kit.yml` keeps its keys (`node`, `pnpm`, `install`, `fetch_depth`) and gains four:

```yaml
setup:
  apt: [zsh, fonts-noto-cjk]        # Linux packages (Debian/Ubuntu names), installed with apt-get
  brew: [poppler]                   # macOS Homebrew formulas (tap-qualified names allowed: owner/tap/name)
  cask: [libreoffice]               # macOS Homebrew casks (apps)
  script: .github/ci-setup.sh       # repository-relative; run with bash on every lane, after the packages
```

- **Packages are declared by name, without versions.** An image or a job gets what the distribution or Homebrew
  serves that day, which is what every lane does today. A tool that must be an exact version is installed by the
  script. Rejected: version pins in the lists, which apt and Homebrew cannot honour uniformly (Homebrew keeps one
  version of a formula).
- **Each list applies on its own platform only**: `apt` on Linux, `brew` and `cask` on macOS. The script runs on
  both; it branches on `uname -s` when it must, as devenv scripts do.
- **The script is idempotent and fast when satisfied.** It runs in every job, so it checks before it installs
  (`command -v`, a version read). It runs from the repository root with `CI=true` (Actions sets it) and
  `CI_KIT_SETUP_MODE` set to `job` or `bake`. It gets no secrets; it runs before `install`.
- **A file may hold only `setup`.** A repository with its own workflow (MAWS's `gate.yml`) keeps its gates there and
  uses `.github/ci-kit.yml` for its declaration alone. Such a file has no `gates`, or an empty list; the plan
  produces zero gates for it. A file with neither gates nor a declaration is still refused.
- **Rejected: a new top-level `sandbox:` key.** `setup` is already the block every gate applies and the block the
  devenv skill reads; a second block would split one environment across two keys. Rejected: a Dockerfile option,
  since packages plus a script cover every served repository and a Dockerfile would serve Linux alone.

### The setup step

`SSFSKIM/ci-kit/setup@v1` is a JavaScript action (`runs: using: node24`), so it runs on every lane with the
runner's own Node, before and independent of any `setup-node`. It reads `.github/ci-kit.yml` from the workspace
through `plan/config.mjs`'s parser (the same validation as the plan), then:

1. Computes the setup hash of the commit's declaration, and reads the image's (`CI_KIT_SETUP_HASH` in its
   environment; absent on the mini's own runner and on hosted runners). Equal: it logs
   `ci-kit setup: image matches setup <hash>`. Different or absent: it proceeds the same way, and when an image hash
   was present it emits a `::notice::` naming both hashes, which is the signal that the image is older than the
   commit.
2. Checks each package of its platform for presence (`dpkg-query` on Linux, `brew list --formula` / `--cask` on
   macOS), all in one call per list.
3. Installs only the missing ones: `sudo -n apt-get update` then `sudo -n apt-get install -y --no-install-recommends`
   with `DEBIAN_FRONTEND=noninteractive` on Linux; `brew install` and `brew install --cask` on macOS. A failed install
   fails the step naming the package. A cask install that fails asking for a password or `sudo` fails with a
   message saying the cask needs an administrator to install it on this machine.
4. Runs the script, if declared; a non-zero exit fails the step naming the script.
5. Prints one summary line: what was declared, what was installed, and the seconds it took.

It never runs `install`: the gates workflow's Install step and MAWS's own setup action do that, after it. The step
is the same on every lane; what differs is only how often it has anything to do.

In the gates workflow (`.github/workflows/gates.yml`) it runs after Set up Node and Enable pnpm and before Install,
for every gate whose `setup` is not `false`, when the declaration names anything. A repository with its own workflow
calls it after checkout, as MAWS calls `SSFSKIM/ci-kit/pool-ensure@v1` today.

On the Mac mini's own runner the step installs on the owner's machine, as the owner allowed: jobs already run the
pull request's code there as `new`, so this adds no access, but installs persist. Homebrew's own auto-update runs
before an install, which is the rare path.

### Images are caches of the declaration

An image applies the default branch's declaration ahead of time, so that a job's setup step finds nothing to do.
Correctness never depends on an image being current: a stale image costs a job the install time and a notice. This
is why the bake can stay weekly plus on change, and why a pull request needs no image of its own. Rejected: building
an image per pull request or per declaration hash at job time (minutes of build on the critical path, and an image
store to manage), which Codespaces-style prebuilds need only because their environment cannot be patched at start.

**Linux.** The bake (`pool/bake/prepare.sh`, shared by the GCE and EC2 builders) builds, after the base
`ci-kit-runner` image, one job image per served repository that has a declaration:

- It clones the repository's default branch on the builder, outside any container, with the bake's App token
  narrowed to the served repositories' contents (read). The token never enters a container.
- It runs a container from `ci-kit-runner` with the clone bind-mounted and the cache directory mounted as jobs mount
  it, and applies the declaration there in `bake` mode: the packages, the script, then `install` in the clone, so the
  shared caches (pnpm and npm stores, Electron, Playwright) are warmed by the repository's own install command.
- It commits that container as `ci-kit-job/<owner>-<repo>:latest` (lower-case), with `CI_KIT_SETUP_HASH` set in the
  image's environment. The clone and the cache are mounts, so neither is in the image.
- It records each job image's hash on the provider's image (GCE image labels, AMI tags; Interfaces) and logs each
  job image's size above the base.

All served repositories share one VM disk; Docker shares the base layers, and each repository adds only its own.
A VM boots the job image of the repository whose job it runs (the launcher passes the repository; Interfaces), and
`ci-kit-runner` when that repository has none. Rejected: one VM disk per repository, which multiplies bakes and image
management while every repository's own layer is small; the bake reports each layer's size, and a repository whose
layer passes 1 GiB is the trigger for that split, since disk size drives an EC2 job's cost (an EC2 job's
initialization was ~84% of its cost at 11.46 GiB: `2026-10-23-ec2-pool-design.md`). The split itself is not built
here.

**Rebuild on change.** Beside the weekly bake, an hourly check compares each served repository's default-branch
setup hash with the hashes the newest ready images record, and runs the bake when any differs. An hour with no
change does nothing.

**Mac guest.** The golden's bake applies MAWS's declaration from the MAWS checkout it already shares read-only, in
`bake` mode: Homebrew formulas and casks, the script, then `install` in a scratch clone (which warms the pnpm store
and Electron's cache, as the `store` step does today). It records the hash in the runner's `.env` as
`CI_KIT_SETUP_HASH`. Every app the declaration left quarantined (an `.app` under `/Applications` carrying
`com.apple.quarantine`) is listed in the first-run step the bake prints, which today names LibreOffice by hand. A
changed declaration never rebuilds the guest by itself: a job's notice is a refresh trigger for the coordinator,
like the runner's self-update today, and the refresh runs in a maintenance window under the documented hold
(`docs/mac-lane.md`, "The VM lane's maintenance"). The lane's infrastructure steps stay ci-kit's: `check`, `disk`,
`quiet`, `display`, `node` (Node 22 and pnpm on the runner's PATH, which the kit's hooks and MAWS's `plan` job run),
`runner`, `workrepo`, `helpers`.

**The Mac mini and hosted runners** have no image: the setup step applies the declaration in every job, and the
first job after a declaration change installs what it adds.

### What leaves ci-kit

Once MAWS's declaration is proven on every lane: the zsh and fonts lines of `pool/image/Dockerfile` (the base keeps
what any Electron or Chromium job needs: build tools, xvfb, the GUI libraries); `pool/bake/warm.mjs`'s MAWS
specifics (the repository's own `install` warms the caches); `provision.sh`'s `store`, `libreoffice`, `poppler` and
`engine` steps and their `bake.sh` calls (ci-kit #137's engine step was a stopgap); the host-setup Homebrew list's
project tools in `docs/mac-lane.md`. Removal is its own milestone, after the declarations work, so every lane keeps
passing throughout (additive, then subtractive).

## Interfaces and Dependencies

**Config** (`plan/config.mjs`). `readSetup` returns, in addition to its current fields,

```js
{ apt: string[], brew: string[], cask: string[], script: string }   // empty lists and '' when absent
```

Names are validated: `apt` entries match `^[a-z0-9][a-z0-9+.-]*$`; `brew` and `cask` entries match
`^[a-z0-9][a-z0-9@+._-]*(/[a-z0-9][a-z0-9@+._-]*){0,2}$`; `script` is a relative POSIX path with no `..` segment.
The top-level check accepts a file with no `gates` (or `[]`) when `setup` declares any of the four; the gates list
is then empty. Existing errors keep their wording.

**The setup hash.** `setupHash(setup, scriptBytes)`, exported from a module the action, the bake and the check all
import:

```
sha256 of the canonical JSON (keys in this order, no whitespace) of
  { apt: sorted unique, brew: sorted unique, cask: sorted unique,
    node: setup.node, pnpm: setup.pnpm,
    script: setup.script, script_sha256: hex sha256 of the script's bytes, or "" when there is no script }
first 16 hex characters
```

`install` and `fetch_depth` are left out: they decide what a job does, not what its image must contain. A
repository with no declaration has the hash `none`.

**The action** (`setup/action.yml`, `setup/` holding its code): no required inputs; `root` defaults to the
workspace. Environment it reads: `CI_KIT_SETUP_HASH` (the image's). Outputs: `hash` (the commit's), `installed`
(space-separated `apt:<name>`, `brew:<name>`, `cask:<name>`), `stale` (`true` when an image hash was present and
differed). The same code runs as a CLI for the bakes: `node setup/apply.mjs --mode bake --root <clone> [--install]`,
where `--install` also runs the declaration's `install` command in the clone.

**Image records.** Job image: `ci-kit-job/<owner>-<repo>:latest`, env and label `CI_KIT_SETUP_HASH=<hash>`. GCE
image label `ci-kit-setup-<owner>-<repo>` (lower-case, `-` for any other character; GCE label keys and values allow
lower-case letters, digits, `-` and `_`, up to 63 characters) = `<hash>`. AMI tag `ci-kit-setup:<owner>/<repo>` =
`<hash>`. Mac guest: `CI_KIT_SETUP_HASH=<hash>` in `~/actions-runner-maws/.env`.

**The repository on the VM.** The launcher adds the job's repository (`owner/name`) to what it already passes a VM:
GCE metadata key `ci-kit-repo`, and the EC2 user-data's JSON field `repo`. The VM's job runner uses
`ci-kit-job/<owner>-<repo>:latest` when `docker image inspect` finds it, else `ci-kit-runner:latest`, and logs which.

**The stale check.** `gce/bake/bake.mjs` run with `CI_KIT_BAKE_IF_STALE=1`: for each served repository, read its
default branch's `.github/ci-kit.yml` and script through the contents API with the App token (contents: read on the
served repositories), compute the hash, and compare with the newest ready GCE image's labels and the newest ready
AMI's tags. All equal: log `bake: images current` and exit 0. Otherwise log the repositories that differ and run the
normal bake. A Cloud Scheduler job `ci-kit-bake-check`, hourly at minute 23, runs it (deployed by `gce/deploy.sh
bake-schedule`). While another execution of the bake job is running, the check exits without baking.

## Constraints on every milestone

- No changes to the doperpowers plugin (its `skills/`, `agents/`, `hooks/`, `output-styles/`), including devcloud's
  devenv skill. File an issue instead.
- MAWS changes go only as pull requests the MAWS architect lands; MAWS's class 1a gates green first. The executor
  prepares the branch and the PR; the coordinator (CI-opt) asks the architect to land it.
- ci-kit's `v1` tag moves only by `gh api -X PATCH repos/SSFSKIM/ci-kit/git/refs/tags/v1 -f sha=<c> -F force=true`,
  done by the coordinator after merge. M1 is the first milestone whose merge must move it (the action and
  `gates.yml` are read at `@v1`).
- Cloud deploys only from merged main, by the coordinator: `gce/deploy.sh <target>` from a fresh clone. Secret
  Manager writes are human-only. AWS only through the aws CLI or the SDK (no agent toolkit or MCP).
- The Mac mini is the coordinator's: holds, kit refreshes, bakes and the first-run click step run under
  `docs/mac-lane.md`'s procedures, by CI-opt only. Never osascript over ssh; never click host permission dialogs.
- No full test suites on the MacBook. One focused test file is fine; verify a commit with `ci-gate` from its worktree.
- Commits and PR bodies end with the session's `Sminos-Session:` line; no Co-Authored-By.
- The Hetzner pool and its agent are out of scope; they keep `ci-kit-runner:latest`.

## Plan of Work

### M1 — The declaration and the setup step

At the end, a repository can declare `apt`, `brew`, `cask` and `script`, a file may hold only `setup`, and every
gate of the gates workflow applies the declaration after checkout on any lane. The setup hash exists and is shared
by everything later.

Touches `plan/config.mjs` (schema, the gates-optional rule), a new `setup/` (the action and its code: config read,
hash, presence checks, installs, script, summary, outputs; the `--mode bake` CLI), `.github/workflows/gates.yml`
(the step), `docs/adopting.md` (the keys, the step, what runs where, the presence-not-version limit), and tests
beside the existing ones (`test/config.test.mjs`, a new `test/setup.test.mjs`).

Interfaces produced: the config fields, `setupHash`, the action and its outputs, the bake CLI.

Decisions: the action is `node24`, not composite, so it needs no Node on the PATH (a pool container has none before
`setup-node`). The gates workflow calls it as `SSFSKIM/ci-kit/setup@v1` (a `uses:` cannot take an expression, and a
second kit checkout in the gate's workspace would show up in the repository's own tree), so `gates.yml` and the
action move together with `v1`; the step's absence for an empty declaration is what makes moving `v1` safe for
every current adopter. It imports the config parser and `vendor/yaml` by relative path, as `pool-ensure` does for its
module. Presence checks run once per list, not per package. The test seam for the package managers is an
environment override naming the commands (as `mac/vm/provision.sh` tests use `CI_KIT_VM_DISKUTIL`), so unit tests run
no real apt or brew. The gates workflow skips the step when the declaration is empty, so existing adopters see no
new step output.

Does not touch: images, bakes, the launcher, the Mac lane, any other repository.

Proves acceptance 1 and 2, and 4's install path (no image hash on hosted lanes; the pool's current image has none
either, so it logs no notice). Tests pin: the hash is stable across key order and list order and changes with the
script's bytes; `install` changes do not change it; a missing script file fails the step naming it; the gates
workflow's step is absent for an empty declaration. Proof on ci-kit-sandbox (Concrete Steps).

### M2 — MAWS declares its environment

At the end, MAWS master carries `.github/ci-kit.yml` (`setup` only) and `.github/ci-setup.sh`, and its gate
workflow applies the declaration on every lane; a full MAWS run is green.

Touches, in MAWS: `.github/ci-kit.yml`; `.github/ci-setup.sh` (installs Claude Code with Anthropic's native
installer when `~/.local/bin/claude` is missing or does not run; ensures `/private/tmp` exists on Linux);
`.github/actions/setup/action.yml` (calls `SSFSKIM/ci-kit/setup@v1` after its pnpm and Node steps and drops the apt
packages the declaration now covers).

Decisions: MAWS's lists are what its lanes install or assume today. `apt`: `zsh`, `fonts-noto-cjk`, `fonts-inter`,
`fonts-jetbrains-mono`, `xvfb` (the e2e jobs' list in its setup action). `brew`: `poppler`. `cask`: `libreoffice`.
LibreOffice on Linux (`libreoffice-writer`, `libreoffice-impress`) stays the setup action's per-group input for now:
whether to move it into `apt` is M3's measurement (its layer size against the time its groups spend installing it).
The apparmor sysctl stays a job step in MAWS's action: it is a kernel setting of the VM, which an image cannot carry.
The engine's version is whatever the native installer serves when it runs, as on the owner's Macs.

Does not touch: ci-kit code. The pool image still has zsh and the fonts, so on the pool the step finds them present.

Proves acceptance 5 and 9. For 9, a scratch MAWS branch (never landed) declares a small formula the mini lacks
(`brew: [hello]`), a host-lane job installs it, and the coordinator uninstalls it afterwards (`brew uninstall hello`
on the mini); the cask-needs-a-password message is pinned by M1's unit tests, not by installing one on the mini.

### M3 — Linux per-repo job images

At the end, the pool's bake produces a job image per served repository with a declaration, the images record their
hashes, and each pool job runs on its repository's job image.

Touches `pool/bake/prepare.sh` (the per-repo build after the base image), the bake's token scope
(`gce/bake/bake.mjs`, `pool/bake/warm.mjs`'s `WARM_SCOPE`, `pool/bake/app-token.mjs` as needed), the GCE and EC2
image records (`gce/bake/`, `ec2/bake/`), the launcher (the repository passed to the VM: `gce/launcher/`), the VM
side (`gce/vm/run.mjs`, `gce/vm/job.mjs`, `ec2/vm/job.mjs`, `pool/vm/container.mjs`), the smoke check
(`gce/vm/smoke.sh`: each job image starts), and `docs/pool.md`.

Interfaces consumed: the bake CLI and `setupHash` (M1). Produced: the image records and the VM's image choice.

Decisions: the bake reads the served repositories from the `gce.json` bundled with the bake job, as it does today.
The per-repo container runs as the image's `runner` user (passwordless `sudo` for apt, as in jobs), so files a
script puts under `~` land where jobs find them. A repository whose apply fails fails the bake naming it and the
step, with the previous images left in place, as any failed bake does: a bad declaration on a default branch must not
publish an image without it. EC2's image compaction (`ec2/bake/compact.sh`, `copy-root.sh`) copies Docker's data like
the rest of the root filesystem; measure the new image size against the current 9.12 GiB candidate and record it.
LibreOffice on Linux: build MAWS's job image once with and once without `libreoffice-writer libreoffice-impress`
in `apt` (a scratch bake from the branch), record both layer sizes and the per-job install time it would remove, and
record the choice in the Decision Log; the MAWS change, if any, goes as an M2-style PR.

Does not touch: the Hetzner agent, the Mac lane.

Proves acceptance 3, 4 (pool), and 6. The launcher and bake deploys are the coordinator's, from merged main.

### M4 — Rebuild on a declaration change

At the end, an hourly check runs the bake when a served repository's default-branch declaration no longer matches
the newest images, and does nothing otherwise.

Touches `gce/bake/bake.mjs` (the `CI_KIT_BAKE_IF_STALE` mode), `gce/deploy.sh` (`bake-schedule` creates or updates
`ci-kit-bake-check` beside `ci-kit-bake-weekly`), `docs/pool.md`.

Interfaces consumed: `setupHash`, the image records (M3).

Decisions: the check reads declarations through the contents API rather than cloning (seconds, no builder). A repo
whose default branch has no `.github/ci-kit.yml`, or one with no declaration, has hash `none`, which matches an
image with no job image for it. The check exits early when an execution of the bake job is already running (the
Cloud Run executions list), so an hourly check never stacks bakes.

Does not touch: the weekly schedule, the launcher.

Proves acceptance 7, with a declaration change on ci-kit-sandbox's default branch (a package added, then removed),
which serves as the test repository.

### M5 — The Mac guest from the declaration

At the end, the guest's golden is baked from MAWS's declaration, and its jobs report whether their commit matches it.

Touches `mac/vm/provision.sh` (a `setup` step running the applier in `bake` mode against a scratch clone of the
`maws` share, with `--install`; it writes `CI_KIT_SETUP_HASH` to the runner's `.env` and records the quarantined
apps), `mac/vm/bake.sh` (the step's call; the first-run text and `--first-run`'s refusal generalized from LibreOffice
to the recorded apps), `mac/install.sh` (publishing the applier and what it imports into the installed kit, since
the guest sees only the installed kit), `test/mac-vm-bake.test.mjs`, `docs/mac-lane.md`.

Interfaces consumed: the bake CLI and `setupHash` (M1).

Decisions: in this milestone the new `setup` step runs after the existing `poppler` and `engine` steps, which stay
until M6, so the golden it bakes is a superset and nothing a job needs can go missing in between. The refresh that
proves it is the coordinator's (a full-mini hold, the first-run click in the guest, trial, promote). The trial group
is one the guest already passes (2026-10-24 refresh lesson, `2026-10-21-mac-lane-concurrency-design.md`).

Does not touch: the lane's launcher, the guest's kickoff and wrapper, the host runner.

Proves acceptance 8.

### M6 — ci-kit forgets MAWS

At the end, ci-kit's images and provisioning carry no project's tools, and MAWS is still green everywhere.

Touches `pool/image/Dockerfile` (drop zsh and the MAWS fonts, and the comment that names MAWS), `pool/bake/warm.mjs`
(drop MAWS's lockfile reads and constants; what remains is any warming not done by a repository's own `install`, or
nothing), `pool/bake/prepare.sh`, `mac/vm/provision.sh` and `mac/vm/bake.sh` (drop `store`, `libreoffice`, `poppler`,
`engine`), their tests, `docs/pool.md`, `docs/mac-lane.md` (the host-setup list keeps only ci-kit's own
prerequisites; the image rows say what the declaration supplies).

Decisions: a bake and a Mac refresh follow the merge (the coordinator's), then a full MAWS `ci-gate` run; until both
images are rebuilt, jobs on the old images are unaffected, since removal only drops what the declaration also
installs.

Proves acceptance 10.

### M7 — manim-master declares its environment; acceptance

At the end, manim-master's `setup` declares ffmpeg, PostgreSQL 16 and uv, its gates no longer install them, and its
pool jobs run on its own job image. Then the acceptance section is executed as written.

Touches, in manim-master: `.github/ci-kit.yml` (the declaration; the gates' `apt-get` and uv install lines removed),
and a `.github/ci-setup.sh` for uv at the version its gates pin today (`0.12.3`), installed where its gates expect it.

Decisions: manim-master's CI is the coordinator's to change (CI-opt owns it); its PR still needs its gates green.

Proves acceptance 11, then 1 through 10 re-checked end to end (Concrete Steps).

## Concrete Steps

All from a ci-kit worktree unless named. Verify any commit with ci-gate, never by running the suites here:

```
cd <ci-kit worktree> && ci-gate .
# expect: one PASS line per gate, then GREEN https://github.com/SSFSKIM/ci-kit/actions/runs/<id>
node --test test/config.test.mjs test/setup.test.mjs    # one focused file at a time is fine locally
```

M1 proof on ci-kit-sandbox (a pool repository), before merge: a scratch branch whose `.github/ci-kit.yml` declares
`apt: [cowsay]` and `brew: [cowsay]`, with its own workflow (as MAWS has) running jobs on `ubuntu-latest`,
`macos-latest` and the pool's labels, each checking out, then `uses: SSFSKIM/ci-kit/setup@<M1 branch>`, then
`cowsay ok`. Expected in each job log, before the gate's output:

```
ci-kit setup: declared apt 1, brew 0, cask 0, script no; installed apt:cowsay in 9 s
```

(brew on the macOS job). After merge, the coordinator moves `v1`, then proves the gates workflow's step: a sandbox
branch with the same declaration and `ci-kit.yml` gates on the three lanes, run through `gates.yml@v1`. If that
fails, `v1` is moved back to its previous commit by the same PATCH before anything else.

M2 proof, from the MAWS worktree of the PR branch (the coordinator asks the architect first, since it takes the
Mac lanes):

```
scripts/ci-gate.sh . --gates all --runner macos
# expect GREEN; a host-lane job's log shows "ci-kit setup: ... installed nothing", a guest job's the same
```

M3 proof: after the coordinator deploys the bake from merged main and the bake runs
(`gcloud run jobs execute ci-kit-bake --region <region> --wait`), the newest images' records:

```
gcloud compute images describe <newest ready pool image> --format='value(labels)'
# expect ...;ci-kit-setup-ssfskim-maws=<16 hex>;...
aws ec2 describe-images --image-ids <newest ready AMI> --query 'Images[0].Tags' --profile ci-kit-ops --region us-east-2
# expect a tag ci-kit-setup:SSFSKIM/MAWS = the same hash
```

then a MAWS pool job's log: `job image ci-kit-job/ssfskim-maws:latest` and `ci-kit setup: image matches setup
<hash>`.

M4 proof: push a declaration change to ci-kit-sandbox's default branch; within the hour the Cloud Run job's
execution list shows a check that started a bake, and that bake's images record the new hash; the next hour's check
logs `bake: images current`.

M5 proof: the coordinator's refresh (`docs/mac-lane.md`, maintenance), whose `--bake` prints the `setup` step and a
first-run list naming LibreOffice; then wave 3's groups on the new golden.

M7 proof and acceptance: manim-master's `ci-gate .` GREEN with its pool gates' logs showing the image matches; then
each acceptance item checked as written above, its evidence recorded in Surprises & Discoveries.

## Surprises & Discoveries

(none yet)

## Decision Log

- Decision: Verification. This spec gets an adversarial design review and an adversarial buildability review of
  its execution section before execution. Each milestone's branch gets doperpowers:review-code: `reviewer-medium`
  for M1, M2, M5, M6 and M7, `reviewer-high` for M3 and M4 (they change the production bake and launcher). Executors
  are astra subagents following the task-executor role, per the owner's standing ruling; the coordinator (CI-opt)
  is the controller and the spec's one writer.
  Rationale: the bake and launcher paths are the ones whose mistakes stop every pool job; the rest are bounded
  and proven by green runs.
  Date/Author: 2026-10-25, CI-opt.

## Outcomes & Retrospective

Pending — written at finish.
