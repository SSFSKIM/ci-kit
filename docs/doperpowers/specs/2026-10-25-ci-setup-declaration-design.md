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
- [x] (2026-10-25 01:2xZ) Spec reviewed: adversarial design review and buildability review, two rounds; findings
  folded (Decision Log, review revision and second round).
- [x] (2026-10-25 01:3xZ) M1 — The declaration and the setup step. Two PRs around a `v1` move (Decision Log):
  ci-kit #139 (478facf; the keys, `setup/`, the hash; review fixes for Homebrew aliases and apt virtual names) and
  #140 (82c8d48; the gates workflow's step). `v1` = 82c8d48. Proofs: ci-kit-sandbox runs 40149966271 (own workflow
  on `setup@setup-m1`) and 40150585134 (`gates.yml@v1`), green on hosted Ubuntu, hosted macOS and the pool.
- [ ] M2 — MAWS declares its environment (completed: MAWS #145, head df6986dfc, independent review clean, class 1a
  green on the pool, run 40151266892; remaining: the two Mac runs of Concrete Steps, the mini's scratch-formula
  check, the architect's merge).
- [ ] M3 — Per-repo job images in the pool bake (completed: ci-kit #141 merged as d60bc8b after a high review, the
  bake job deployed from it; ci-kit-sandbox's default branch declares `apt: [cowsay]` (sandbox #52); remaining: the
  proof bake on both providers and its records).
- [ ] M4 — Pool jobs run on their repository's image.
- [ ] M5 — Rebuild on a declaration change.
- [ ] M6 — The Mac guest from the declaration.
- [ ] M7 — ci-kit forgets MAWS.
- [ ] M8 — manim-master declares its environment; acceptance.

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
   macOS job) names a small package absent from the runner, with a job that runs it, passes on GitHub's hosted
   Ubuntu, GitHub's hosted macOS and the pool. Each job log shows the setup step's summary naming the package as
   installed, then the job's output. After `v1` moves, the same holds through the gates workflow. (M1)
3. **A job on a matching image installs nothing.** A pool job whose image was built from its commit's declaration
   logs `ci-kit setup: image matches setup <hash>` and no install, and the step takes under 10 s. (M4)
4. **A job on an older image still passes.** A pool or guest job whose commit declares a package the image lacks
   logs a `::notice::` naming the image's setup hash and the commit's, installs the package, and passes. (M1 proves
   the install path on hosted and pool lanes; M4 the hash comparison on the pool; M6 on the guest.) The one
   exception is stated in the design: a newly declared macOS app that Gatekeeper must approve is installed, named in
   a `::warning::`, and usable only after its first-run approval on that lane.
5. **MAWS is green from its own declaration on all three of its CI lanes.** MAWS master's `.github/ci-kit.yml`
   declares its environment and its gate workflow applies it. A full MAWS run and a guest-routed run of its
   `MAC_VM_E2E` groups are both green, and the recorded runner names show jobs on the pool (`ci-kit-gce-*` or
   `ci-kit-ec2-*`), on the Mac mini's own runner (`ci-kit-mac-mini`) and in the guest
   (`ci-kit-mac-mini-maws-vm-job-*`). (M2)
6. **Each served repository's pool jobs run on its own job image.** After a bake, the newest ready GCE image and the
   newest ready AMI each carry `ci-kit-job/ssfskim-maws` (and `ci-kit-job/ssfskim-manim-master` once M8 lands)
   beside `ci-kit-runner`, and record each one's setup hash (GCE image labels, AMI tags) and its apply result in the
   bake manifest. The bake's log reports each job image's size above the base. (M3) A MAWS pool job's log names the
   job image it ran on; a repository with no declaration runs on `ci-kit-runner`. (M4)
7. **A declaration change rebuilds the pool images on its own.** A merge that changes a served repository's
   declaration on its default branch is followed, within the hour plus one bake, by new ready images whose
   recorded hash matches, with no manual dispatch; an hour with no change starts no bake. (M5)
8. **The guest is baked from MAWS's declaration.** A Mac golden baked after M6 carries Poppler, LibreOffice and
   Claude Code because MAWS's declaration names them; its runner's `.env` holds the declaration's hash after the
   whole bake; the bake prints the first-run click step for every app the declaration left quarantined (LibreOffice
   today); a guest job's log says the image matches. Wave 3's groups that are green on the current guest stay green
   on it. (M6)
9. **The mini's own runner installs what is declared.** A MAWS job on the mini whose declaration names a formula
   the mini lacks installs it with Homebrew and passes; a cask whose installer needs an administrator password
   fails the step with a message naming the cask and saying it needs a manual install. (M2 with a scratch formula;
   the cask message by M1's unit tests)
10. **ci-kit carries no project's tool list.** `pool/image/Dockerfile` has no zsh or MAWS fonts, the bake manifest
    and its validators name no repository, `pool/bake/warm.mjs` names no repository (or is gone), and
    `mac/vm/provision.sh` has no `store`, `libreoffice`, `poppler` or `engine` step; a bake from empty caches makes
    ready images on both providers, and MAWS's two runs from item 5 stay green. (M7)
11. **A second project works the same way.** manim-master declares ffmpeg, PostgreSQL 16 and uv; its gates drop
    their per-job `apt-get` and uv installs; its pool jobs pass with the setup step reporting the image matches.
    (M8)
12. **Repository code in a bake cannot reach the builder's credentials.** From inside a bake container, a request to
    the metadata server fails (GCE and EC2), and the clone's `.git/config` holds no credential; the bake checks
    both before applying any declaration and fails if either holds. (M3)

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
2. Checks each package of its platform for presence in one inventory call per list: on Linux `dpkg-query`, counting
   the names installed packages provide as present (a virtual name such as `libasound2` is satisfied by
   `libasound2t64`); on macOS `brew info --json=v2 --installed` for formulas and casks, matching declared names
   against each installed item's name, aliases and old names (so `pkg-config` is satisfied by `pkgconf` and never
   triggers an upgrade). A name the inventory does not know stays missing, and its install reports Homebrew's or
   apt's own error.
3. Installs only the missing ones: `sudo -n apt-get update` then `sudo -n apt-get install -y --no-install-recommends`
   with `DEBIAN_FRONTEND=noninteractive` on Linux; `brew install` and `brew install --cask` on macOS. A failed install
   fails the step naming the package. A cask install that fails asking for a password or `sudo` fails with a
   message saying the cask needs an administrator to install it on this machine.
4. Runs the script, if declared; a non-zero exit fails the step naming the script.
5. Prints one summary line: what was declared, what was installed, and the seconds it took.

With its `install` input set to `true` it then runs the declaration's `install` command (step 6); by default it
does not, because the gates workflow keeps its own Install step after it. A repository with its own workflow passes
`install: true`, so the declared command is the one its jobs run. The step is the same on every lane; what differs
is only how often it has anything to do.

After a cask install on macOS, the step lists the installed apps that still carry `com.apple.quarantine` and names
them in a `::warning::` (the exception under "Images are caches of the declaration").

In the gates workflow (`.github/workflows/gates.yml`) it runs after Set up Node and Enable pnpm and before Install,
for every gate whose `setup` is not `false`, when the declaration names anything. A repository with its own workflow
calls it after checkout, as MAWS calls `SSFSKIM/ci-kit/pool-ensure@v1` today.

On the Mac mini's own runner the step installs on the owner's machine, as the owner allowed: jobs already run the
pull request's code there as `new`, so this adds no access, but installs persist. Homebrew's own auto-update runs
before an install, which is the rare path.

### Images are caches of the declaration

An image applies the default branch's declaration ahead of time, so that a job's setup step finds nothing to do.
For packages and scripts, correctness never depends on an image being current: a stale image costs a job the
install time and a notice. This is why the bake can stay weekly plus on change, and why a pull request needs no
image of its own. Rejected: building an image per pull request or per declaration hash at job time (minutes of
build on the critical path, and an image store to manage), which Codespaces-style prebuilds need only because their
environment cannot be patched at start.

**The exception is a new macOS app that Gatekeeper must approve.** An app a cask installs is quarantined until
someone opens it once and approves it: on the Mac mini that is the owner at the mini's screen (agents never click
host dialogs); in the guest it is the refresh's first-run step. Until then, tests that launch it fail on that lane.
The setup step names every such app it installed in a `::warning::`, so the failure that follows reads plainly.
LibreOffice is the only such app today, and it is approved on both Mac lanes. The owner accepted this limit with the
design ("new GUI apps still need the one-time click").

**Linux.** The bake builds one job image per served repository with a declaration, on top of the base
`ci-kit-runner` image, inside the provider-neutral half of the bake (`pool/bake/prepare.sh`) that both builders run.

- **One set of inputs for both providers.** The bake's orchestrator (`gce/bake/bake.mjs`) already resolves MAWS's
  revision once into the bake manifest it hands both builders, so GCE and EC2 images are built from the same inputs.
  It now resolves every served repository's default-branch revision and setup hash once into the manifest's `repos`
  (Interfaces), and each builder clones exactly those revisions. A builder never reads a moving branch tip.
- **Repository code never sees the builder's credentials.** The builder holds a GitHub installation token: on GCE
  in its instance metadata (`ci-kit-gh-token`, `gce/bake/plan.mjs` `builderInstance`), on EC2 in its user-data.
  Before any repository's code runs, the builder installs the metadata block job VMs install
  (`pool/vm/container.mjs` `prepareContainer`'s `METADATA_BLOCK` rules), so containers cannot reach the metadata
  server; EC2 builders keep IMDSv2 with a hop limit of 1 (`ec2/bake/bake.mjs`), which already stops containers. The
  clone is made with the token passed to that one git call through its environment, as `gates.yml`'s change-basis
  fetch does, so the clone's `.git/config` holds no credential. The bake proves both from inside a bake container
  (a metadata request fails; no credential in the clone's git config) before applying anything, and fails if either
  holds. The token is narrowed to the served repositories' contents, read.
- **The bake container.** From `ci-kit-runner` with its JIT entrypoint overridden, as the image's `runner` user
  (UID 1001, with passwordless `sudo` as in jobs, so files a script puts under `~` land where jobs find them).
  Mounted: the clone, read-write and owned by 1001; the cache directory as jobs mount it, owned by 1001 before the
  run (today ownership is fixed only after warming); and the kit's `setup/` code with what it imports, read-only.
  The applier runs on the runner's own bundled Node (`/home/runner/externals/`, the runtime the action itself runs
  on), so the container needs no Node on its PATH for the applier. For the repository's own commands, the script in
  the first run and `install` in the second, the declaration's `node` and `pnpm` are put on the PATH from the mounted
  tool cache (`prepare.sh` installs Node 22 and 24 there) before either runs, as `actions/setup-node` and `corepack
  enable` do before the setup step in a job, so a script may call Node or pnpm in a bake as it may in a job.
- **Two runs, one committed.** The first run applies the packages and the script and is committed as
  `ci-kit-job/<owner>-<repo>:latest`, with `CI_KIT_SETUP_HASH` in its environment and as a label. The second runs a
  throwaway container from that new image, runs the declaration's `install` in the clone with the cache mounted, and
  is not committed: the shared caches (pnpm and npm stores, Electron, Playwright) are warmed by the repository's own
  commands, and the image holds only what the packages and the script installed. A builder starts with empty caches,
  so every bake is also the proof that a repository's own commands fill them.
- **A failed apply fails the bake**, naming the repository and the step, with the previous images left in place, as
  any failed bake does: a bad declaration on a default branch must not publish an image without it. A failed warm
  stays best effort, as today.
- **Records.** Each `repos` entry gains its apply and warm results; the provider image records each hash (GCE
  labels, AMI tags; Interfaces); the bake logs each job image's size above the base.

All served repositories share one VM disk; Docker shares the base layers, and each repository adds only its own. A
VM boots the job image of the repository whose job it runs (the launcher passes the repository; Interfaces), and
`ci-kit-runner` when that repository has none. Rejected: one VM disk per repository, which multiplies bakes and image
management while every repository's own layer is small. The bake reports each layer's size, and a repository whose
layer passes 1 GiB is the trigger for that split, since disk size drives an EC2 job's cost (an EC2 job's
initialization was ~84% of its cost at 11.46 GiB: `2026-10-23-ec2-pool-design.md`). The split itself is not built
here.

**The image checks follow the images.** Today's checks are MAWS-shaped: the manifest (`pool/bake/manifest.mjs`)
resolves MAWS's revision and lockfile, labels them, and its `verifyManifest` requires the `maws-files` and
`pnpm-fetch` warm records; the EC2 VM's image check (`ec2/vm/job.mjs` `checkImage`) rejects a manifest without
`maws`; the smoke check (`gce/vm/smoke.sh`) requires zsh, the MAWS fonts and the warm records in the base container.
They become per repository: the manifest's `repos` beside `maws`, every repository's apply result required, and a
smoke check of each job image that applies its declaration in `job` mode and requires that nothing is installed. Both
providers' producers and validators change in the same milestone, while the MAWS fields are still produced beside
the new ones; those are dropped with the MAWS warming they describe.

**Rebuild on change.** Beside the weekly bake, an hourly check compares each served repository's default-branch
setup hash with the hashes the newest ready images record, and bakes when any differs. An hour with no change does
nothing.

**Mac guest.** The golden's bake applies MAWS's declaration from the MAWS checkout it already shares read-only (a
scratch clone of the `maws` share), in `bake` mode: Homebrew formulas and casks, the script, then `install` in the
clone, which warms the pnpm store and Electron's cache as the `store` step does today. The guest is a whole VM, so
`install`'s side effects stay in the golden; that is why the hash includes `install` (Interfaces). The step leaves
its hash in `~/.ci-kit/setup-hash`, and every provisioning step that writes the runner's `.env` (`runner`, `env`)
writes `CI_KIT_SETUP_HASH` from that file when it exists, so no step order can erase it. The apps it left
quarantined are recorded in `~/.ci-kit/quarantined-apps`; the first-run step the bake prints lists them, and
`--first-run` refuses while any of them is unapproved, which today both do for LibreOffice by name. A changed
declaration never rebuilds the guest by itself: a job's notice is a refresh trigger for the coordinator, like the
runner's self-update today, and the refresh runs in a maintenance window under the documented hold
(`docs/mac-lane.md`, "The VM lane's maintenance"). The lane's infrastructure steps stay ci-kit's: `check`, `disk`,
`quiet`, `display`, `node` (Node 22 and pnpm on the runner's PATH, which the kit's hooks and MAWS's `plan` job run),
`runner`, `workrepo`, `helpers`.

**The Mac mini and hosted runners** have no image: the setup step applies the declaration in every job, and the
first job after a declaration change installs what it adds.

### What leaves ci-kit

Once MAWS's declaration is proven on every lane: the zsh and fonts lines of `pool/image/Dockerfile` (the base keeps
what any Electron or Chromium job needs: build tools, xvfb, the GUI libraries); `pool/bake/warm.mjs`'s MAWS
specifics (the repository's own `install` warms the caches) and, with them, the manifest's `maws` field, its image
labels, the `maws-files` and `pnpm-fetch` requirements, the EC2 image check's `maws` requirement, and the smoke
check's zsh, fonts and legacy warm checks; `provision.sh`'s `store`, `libreoffice`, `poppler` and
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

**The setup hash.** `setupHash(setup, scriptBytes)`, exported from `setup/hash.mjs`, which the action, the bakes and
the check all import:

```
sha256 of the canonical JSON (keys in this order, no whitespace) of
  { apt: sorted unique, brew: sorted unique, cask: sorted unique,
    node: setup.node, pnpm: setup.pnpm, install: setup.install,
    script: setup.script, script_sha256: hex sha256 of the script's bytes, or "" when there is no script }
first 16 hex characters
```

Every key a bake executes is in it; only `fetch_depth` is left out. Lockfiles are not: they change what the caches
hold, never what an image must contain, and a stale cache only slows an install. A repository with no declaration
has the hash `none`.

**The action** (`setup/action.yml`, `setup/` holding its code): no required inputs; `root` defaults to the
workspace; `install` (`true`/`false`, default `false`) also runs the declared `install`. Environment it reads: `CI_KIT_SETUP_HASH` (the image's). Outputs: `hash` (the commit's), `installed`
(space-separated `apt:<name>`, `brew:<name>`, `cask:<name>`), `stale` (`true` when an image hash was present and
differed). The same code runs as a CLI for the bakes: `node setup/apply.mjs --mode bake --root <clone> [--install]`,
where `--install` also runs the declaration's `install` command in the clone.

**Image records.** Job image: `ci-kit-job/<owner>-<repo>:latest`, env and label `CI_KIT_SETUP_HASH=<hash>`. GCE
image label `ci-kit-setup-<owner>-<repo>` (lower-case, `-` for any other character; GCE label keys and values allow
lower-case letters, digits, `-` and `_`, up to 63 characters) = `<hash>`. AMI tag `ci-kit-setup:<owner>/<repo>` =
`<hash>`. Mac guest: `CI_KIT_SETUP_HASH=<hash>` in `~/actions-runner-maws/.env`, written from
`~/.ci-kit/setup-hash` by every provisioning step that writes that `.env`; the apps left quarantined in
`~/.ci-kit/quarantined-apps`, one path a line.

**The bake manifest** (`pool/bake/manifest.mjs`). Beside its current fields it carries
`repos: { "<owner>/<repo>": { revision: <40 hex>, setup_hash: <hash> } }` for every served repository with a
declaration, resolved once by the orchestrator and handed to both builders. After the build each entry gains
`apply: { ok, image_bytes }` and `warm: { ok }` from its builder. `image_bytes` is the job image's size above
`ci-kit-runner` (Docker image sizes subtracted), the 1 GiB split-trigger metric; the builder logs the total too.
Only repository/revision/setup-hash pins must match across providers; sizes and warm results may differ. Verification requires every entry's `apply.ok`,
and `warm` stays best effort, as today's warming is. The EC2 VM's image check accepts a manifest with `repos`. The
`maws` field, its labels and the `maws-files`/`pnpm-fetch` requirements stay, produced as now, until M7 removes
them together.

**The repository on the VM.** The launcher adds the job's repository (`owner/name`) to what it already passes a VM:
GCE metadata key `ci-kit-repo`, and the EC2 user-data's JSON field `repo`. The VM's job runner uses
`ci-kit-job/<owner>-<repo>:latest` when `docker image inspect` finds it, else `ci-kit-runner:latest`, and logs which.

**The stale check.** A second Cloud Run job, `ci-kit-bake-check`, deployed from the same source as `ci-kit-bake`
with `CI_KIT_BAKE_IF_STALE=1` in its environment, so no per-execution override is needed. For each served
repository it reads the default branch's `.github/ci-kit.yml` and script through the contents API with the App token
(contents: read on the served repositories), computes the hash, and compares with the newest ready GCE image's labels
and the newest ready AMI's tags. All equal: it logs `bake: images current` and exits 0. Otherwise it logs the
repositories that differ and continues as the normal bake, in the same execution. Before either, it lists the
executions of both `ci-kit-bake` and `ci-kit-bake-check` and exits without baking while another one is running;
that needs `run.executions.list` on both jobs, granted to the bake's service account at deploy (`roles/run.viewer`
on each job), which it lacks today (it holds compute, monitoring and quota roles and `roles/run.invoker` on the
bake job). A Cloud Scheduler job `ci-kit-bake-check-hourly`, at minute 23, runs it. `gce/deploy.sh` gains a
`bake-check` target (the job and both grants), and `bake-schedule` creates both schedules. The check is tested
under the bake's own identity, as the scheduler runs it, never an operator's.

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
hash, presence checks, installs, script, optional install, quarantine listing, summary, outputs; the `--mode bake`
CLI), `.github/workflows/gates.yml` (the step), `docs/adopting.md` (the keys, the step, what runs where, the
presence-not-version limit, the Gatekeeper exception), and tests beside the existing ones (`test/config.test.mjs`, a
new `test/setup.test.mjs`).

Interfaces produced: the config fields, `setupHash`, the action with its inputs and outputs, the bake CLI.

Decisions: the action is `node24`, not composite, so it needs no Node on the PATH (a pool container has none before
`setup-node`). The gates workflow calls it as `SSFSKIM/ci-kit/setup@v1` (a `uses:` cannot take an expression, and a
second kit checkout in the gate's workspace would show up in the repository's own tree), so `gates.yml` and the
action move together with `v1`. Actions resolves every `uses:` of a job before any step runs, whatever its condition
(run 40148841436 failed setting up on `setup@v1` before v1 had the action), so M1 lands in two pull requests: the
action, schema and docs first, after which the coordinator moves `v1`; then the gates workflow's step, after which
`v1` moves again. The first move is safe for adopters because it only adds a directory and accepts new keys; the
second because the step is skipped for an empty declaration. It imports the config parser and `vendor/yaml` by relative path, as `pool-ensure` does for
its module. Presence checks run once per list, not per package. The test seam for the package managers is an
environment override naming the commands (as `mac/vm/provision.sh`'s tests use `CI_KIT_VM_DISKUTIL`), so unit tests
run no real apt or brew. The cask password message is recognized from the installer's failure output (`sudo`,
`password`, `a terminal is required`) and pinned by a unit test with that output.

Does not touch: images, bakes, the launcher, the Mac lane, any other repository.

Proves acceptance 1, 2, and 4's install path (hosted runners carry no image hash; the pool's current image has none
either, so it logs no notice). Tests pin: the hash is stable across key order and list order, changes with the
script's bytes and with `install`, and ignores `fetch_depth`; a missing script file fails the step naming it; the
gates workflow's step is absent for an empty declaration; `install: true` runs the declared command after the script
and `false` does not.

### M2 — MAWS declares its environment

At the end, MAWS master carries `.github/ci-kit.yml` (`setup` only) and `.github/ci-setup.sh`, its gate workflow
applies the declaration on every lane, and MAWS is green on all three of its CI lanes.

Touches, in MAWS: `.github/ci-kit.yml`; `.github/ci-setup.sh`; `.github/actions/setup/action.yml`, which calls
`SSFSKIM/ci-kit/setup@v1` with `install: true` after its pnpm and Node steps, and drops its own frozen install and the
apt packages the declaration now covers.

Decisions:

- MAWS's declaration, whole:

  ```yaml
  version: 1
  setup:
    node: "22"
    pnpm: true
    install: pnpm install --frozen-lockfile && pnpm exec playwright install chromium
    apt: [zsh, fonts-noto-cjk, fonts-inter, fonts-jetbrains-mono, xvfb]
    brew: [poppler]
    cask: [libreoffice]
    script: .github/ci-setup.sh
  ```

  `node`, `pnpm` and the frozen install are what MAWS's setup action does today, and the bakes consume them. The
  Playwright line is what ci-kit's warmer does for MAWS today (`pool/bake/warm.mjs` installs Chromium at the
  lockfile's Playwright version into `PLAYWRIGHT_BROWSERS_PATH`); `playwright install` does nothing when the browser
  is already there, so it costs a matching job only its check. Electron's binary needs no line: MAWS's own
  `scripts/postinstall.mjs`, which `pnpm install` runs, fetches it into Electron's cache. The lists are what MAWS's
  lanes install or assume today.
- `ci-setup.sh`, each part only when needed: Claude Code through Anthropic's native installer when
  `~/.local/bin/claude` is missing or does not run (the version the installer serves, as on the owner's Macs); on
  Linux, `/private/tmp` with mode 1777 (the path MAWS's recorded fixtures name, created by its setup action today).
- LibreOffice on Linux (`libreoffice-writer`, `libreoffice-impress`) stays the setup action's per-group input; M3
  measures whether it belongs in `apt`.
- The apparmor sysctl stays a step of MAWS's action: it is a kernel setting of the VM, which an image cannot carry.
- On the current guest image, the script installs Claude Code in each guest job until the next refresh: that fixes
  the four connector groups wave 3 found red before any image changes.

Does not touch: ci-kit code. The pool image still has zsh and the fonts, so on the pool the step finds them present.

Proves acceptance 5 and 9. For 9, a scratch MAWS branch (never landed) declares a small formula the mini lacks
(`brew: [hello]`) and runs a host-lane job, which installs it; the coordinator then uninstalls it on the mini
(`brew uninstall hello`).

### M3 — Per-repo job images in the pool bake

At the end, the pool's bake produces a job image for each served repository with a declaration, on both providers,
from one resolved set of inputs, behind the metadata block, with per-repository manifest entries, image records and
smoke checks. Nothing runs on the new images yet: VMs still start `ci-kit-runner`.

Touches `gce/bake/bake.mjs` (resolving `repos` into the manifest; the token's scope), `pool/bake/manifest.mjs`
(`repos`, its verification, its labels and tags), `pool/bake/prepare.sh` (the metadata block, the clones, the two
container runs, the commit, the size report), `pool/bake/warm.mjs`'s `WARM_SCOPE` and `pool/bake/app-token.mjs` as
needed, the GCE and EC2 image records (`gce/bake/`, `ec2/bake/`), `ec2/vm/job.mjs` `checkImage` (accepts `repos`),
`gce/vm/smoke.sh` (each job image applies its declaration in `job` mode and installs nothing), the tests beside
each, and `docs/pool.md`.

Interfaces consumed: the bake CLI and `setupHash` (M1). Produced: the manifest's `repos`, the job images and their
names, the image records.

Decisions: the bake reads the served repositories from the `gce.json` bundled with the bake job, as it does today. A
test pins a bake fixture whose script calls `node` and `pnpm`, in the first run as well as the second.
The metadata block is installed by the builder before the first clone and stays for the bake's life. EC2's image
compaction (`ec2/bake/compact.sh`, `copy-root.sh`) copies Docker's data like the rest of the root filesystem: measure
the new image size against the 9.12 GiB candidate and record it in Surprises & Discoveries.

The LibreOffice question, without a branch bake: on a pool job (a scratch ci-kit-sandbox branch whose gate runs on
the pool), time `sudo apt-get install -y --no-install-recommends libreoffice-writer libreoffice-impress` and sum
their installed sizes (`dpkg-query -W -f='${Installed-Size}\n'`), and read the time MAWS's LibreOffice groups spend
in that apt step today from their job logs. Record the numbers and the choice in the Decision Log: moving them into
MAWS's `apt` (an M2-style MAWS PR) when the layer stays well under the 1 GiB split trigger and the time saved per
job outweighs the bytes every MAWS VM boots.

Does not touch: the launcher, the VM's image choice (M4), the Hetzner agent, the Mac lane.

Proves acceptance 6's bake half and 12. The bake deploy is the coordinator's, from merged main; the proof is the
first bake after it, on both providers.

### M4 — Pool jobs run on their repository's image

At the end, each pool job runs in its repository's job image when the VM's image has one, and its setup step reports
whether the image matches.

Touches `gce/launcher/` (the repository in what it passes a VM: GCE metadata and EC2 user-data), `gce/vm/run.mjs`,
`gce/vm/job.mjs`, `ec2/vm/job.mjs` and `pool/vm/container.mjs` (the image choice and its log line), their tests,
`docs/pool.md`.

Interfaces consumed: the job images' names (M3). Produced: the repository on the VM.

Decisions: a VM whose metadata or user-data has no repository (one launched by a launcher older than this
milestone) runs `ci-kit-runner`, so the launcher and the VMs can deploy in either order. The image choice is logged
as `job image <name>` before the container starts.

Does not touch: the bake.

Proves acceptance 3, 4's pool comparison (a scratch branch of ci-kit-sandbox declaring one package more than its
default branch), and 6's job half. The VM's code ships inside the provider image (`gce/vm/ci-kit-gce-job.service`
runs `/opt/ci-kit/gce/vm/job.mjs`, checked out at the bake's kit commit), so after merge the coordinator deploys the
launcher and runs a bake from merged main, and the proof waits for ready images on both providers; either order is
safe, by the no-repository fallback above.

### M5 — Rebuild on a declaration change

At the end, an hourly check bakes when a served repository's default-branch declaration no longer matches the newest
images, and does nothing otherwise.

Touches `gce/bake/bake.mjs` (the `CI_KIT_BAKE_IF_STALE` mode and the running-execution guard), `gce/deploy.sh` (the
`bake-check` target with its grants; `bake-schedule` creates `ci-kit-bake-check-hourly` beside
`ci-kit-bake-weekly`), `docs/pool.md`.

Interfaces consumed: `setupHash`, the image records (M3).

Decisions: the check reads declarations through the contents API rather than cloning (seconds, no builder). A
repository whose default branch has no `.github/ci-kit.yml`, or one with no declaration, has the hash `none`, which
matches an image with no job image for it. The check job's task timeout is the bake job's, since a stale check
continues as a bake.

Does not touch: the weekly schedule, the launcher.

Proves acceptance 7, with a declaration change on ci-kit-sandbox's default branch (a package added, then removed),
which serves as the test repository. The deploy is the coordinator's.

### M6 — The Mac guest from the declaration

At the end, the guest's golden is baked from MAWS's declaration, keeps its hash in the runner's `.env`, and lists the
apps its first-run step must approve.

Touches `mac/vm/provision.sh` (a `setup` step running the applier in `bake` mode against a scratch clone of the
`maws` share, with `install`; it writes `~/.ci-kit/setup-hash` and `~/.ci-kit/quarantined-apps`; the `runner` and
`env` steps write `CI_KIT_SETUP_HASH` into `.env` from that file), `mac/vm/bake.sh` (the step's call after the
`store`, `libreoffice`, `poppler` and `engine` steps, which stay until M7; the first-run text and `--first-run`'s
refusal generalized to the recorded apps), `mac/install.sh` (publishing the applier and what it imports into the
installed kit, since the guest sees only the installed kit), `test/mac-vm-bake.test.mjs`, `docs/mac-lane.md`.

Interfaces consumed: the bake CLI and `setupHash` (M1).

Decisions: the golden this milestone bakes is a superset of today's (the old steps still run), so nothing a job
needs can go missing in between. The applier runs on the guest's Node 22 from the `node` step. Tests pin the final
`.env` of a whole fixture bake, not the step's output alone. The refresh that proves it is the coordinator's
(full-mini hold, the first-run click in the guest, trial, promote); the trial group is one the guest already passes
(the 2026-10-24 refresh lesson, `2026-10-21-mac-lane-concurrency-design.md`).

Does not touch: the lane's launcher, the guest's kickoff and wrapper, the host runner.

Proves acceptance 8 and 4's guest comparison.

### M7 — ci-kit forgets MAWS

At the end, ci-kit's images, manifest, validators and provisioning carry no project's tools or names, and MAWS is
still green everywhere.

Touches `pool/image/Dockerfile` (drop zsh, the MAWS fonts and the comment naming MAWS), `pool/bake/warm.mjs` (drop
MAWS's lockfile reads and constants; what remains is warming no repository's own `install` does, or nothing),
`pool/bake/manifest.mjs` (drop `maws`, its labels and the `maws-files`/`pnpm-fetch` requirements), `ec2/vm/job.mjs`
`checkImage` (drop the `maws` requirement), `gce/vm/smoke.sh` (the base checks only what ci-kit puts there),
`pool/bake/prepare.sh`, `mac/vm/provision.sh` and `mac/vm/bake.sh` (drop `store`, `libreoffice`, `poppler`,
`engine`), their tests, `docs/pool.md`, `docs/mac-lane.md` (the host-setup list keeps only ci-kit's own
prerequisites; the image rows say what the declaration supplies).

Decisions: an EC2 VM still booting an image from before this milestone has a manifest with `maws`, which the relaxed
check accepts; a VM booting a new image never meets the old check, because VM code ships inside the image. After
merge: a bake (the coordinator's), whose builders start with empty caches, must produce ready images on both
providers; then a Mac refresh; then MAWS's two runs from acceptance 5.

Proves acceptance 10.

### M8 — manim-master declares its environment; acceptance

At the end, manim-master's `setup` declares ffmpeg, PostgreSQL 16 and uv, its gates no longer install them, and its
pool jobs run on its own job image. Then the acceptance section is executed as written.

Touches, in manim-master: `.github/ci-kit.yml` (the declaration; the gates' `apt-get` and uv install lines removed)
and a `.github/ci-setup.sh` installing uv at the version its gates pin today (`0.12.3`), where its gates expect it.

Decisions: manim-master's CI is the coordinator's to change (CI-opt owns it); its PR still needs its gates green.

Proves acceptance 11, then 1 through 12 re-checked end to end (Concrete Steps).

## Concrete Steps

All from a ci-kit worktree unless named. Verify any commit with ci-gate, never by running the suites here:

```
cd <ci-kit worktree> && ci-gate .
# expect: one PASS line per gate, then GREEN https://github.com/SSFSKIM/ci-kit/actions/runs/<id>
node --test test/setup.test.mjs    # one focused file at a time is fine locally
```

**M1**, on ci-kit-sandbox (a pool repository), before merge: a scratch branch whose `.github/ci-kit.yml` declares
`apt: [cowsay]` and `brew: [cowsay]`, with its own workflow (as MAWS has) running jobs on `ubuntu-latest`,
`macos-latest` and the pool's labels, each checking out, then `uses: SSFSKIM/ci-kit/setup@<M1 branch>`, then
`cowsay ok`. Expected in each job log, before the job's output:

```
ci-kit setup: declared apt 1, brew 0, cask 0, script no; installed apt:cowsay in 9 s
```

(brew on the macOS job). After merge, the coordinator moves `v1`, then proves the gates workflow's step: a sandbox
branch with the same declaration and `ci-kit.yml` gates on the three lanes, run through `gates.yml@v1`. If that
fails, `v1` goes back to its previous commit by the same PATCH before anything else.

**M2**, from the MAWS worktree of the PR branch; the coordinator asks the architect first, since it takes the Mac
lanes:

```
scripts/ci-gate.sh . --gates all --runner macos
scripts/ci-gate.sh . --gates <the MAC_VM_E2E groups, comma-separated> --runner macos --lane vm
# expect GREEN twice; then the runner names of each run's jobs:
gh run view <run> -R SSFSKIM/MAWS --json jobs --jq '.jobs[] | "\(.name) \(.runnerName)"'
# expect ci-kit-gce-* or ci-kit-ec2-* (pool), ci-kit-mac-mini (host) and ci-kit-mac-mini-maws-vm-job-* (guest);
# each job's setup step logs "installed nothing" (or, in guest jobs before the next refresh, installed Claude Code)
```

**M3**, after the coordinator deploys the bake from merged main and runs it
(`gcloud run jobs execute ci-kit-bake --region us-central1 --wait`):

```
gcloud compute images describe <newest ready pool image> --format='value(labels)'
# expect ...;ci-kit-setup-ssfskim-maws=<16 hex>;...
aws ec2 describe-images --image-ids <newest ready AMI> --query 'Images[0].Tags' --profile ci-kit-ops --region us-east-2
# expect a tag ci-kit-setup:SSFSKIM/MAWS with the same hash
# and in the bake's log: the metadata check from inside a bake container failing as required, each job image's size
```

**M4**, after the coordinator deploys the launcher and a bake from merged main has made ready images on both
providers: a MAWS pool job's log shows `job image ci-kit-job/ssfskim-maws:latest`
and `ci-kit setup: image matches setup <hash>`; a ci-kit-sandbox job on a branch declaring one more package shows the
notice and the install.

**M5**: push a declaration change to ci-kit-sandbox's default branch; within the hour `gcloud run jobs executions
list --job ci-kit-bake-check --region us-central1` shows a check that baked, and that bake's images record the new
hash; the next hour's check logs `bake: images current`.

**M6**: the coordinator's refresh (`docs/mac-lane.md`, maintenance), whose `--bake` runs the `setup` step and whose
printed first-run step names LibreOffice; on the promoted golden, `grep CI_KIT_SETUP_HASH
~/actions-runner-maws/.env` in a clone matches MAWS master's hash; then wave 3's groups on it.

**M7**: the coordinator's bake and refresh after merge, then MAWS's two runs from M2.

**M8** and acceptance: manim-master's `ci-gate .` GREEN with its pool jobs' logs showing the image matches; then each
acceptance item checked as written above, its evidence recorded in Surprises & Discoveries.

## Surprises & Discoveries

- Observation: Actions resolves every `uses:` of a job before any step runs, whatever the step's condition, so a
  workflow cannot reference an action that its own tag does not hold yet.
  Evidence: run 40148841436 failed at job setup on `SSFSKIM/ci-kit/setup@v1` ("Can't find action.yml") while the
  step's `if:` was false; ci-kit #68.
- Observation: the setup step costs nothing measurable when nothing is missing, and seconds when something is.
  Evidence: first apply `installed apt:cowsay` in 7.0 s (hosted Ubuntu), 3.8 s (hosted macOS, brew), 4.5 s (pool,
  EC2); re-applies 0.0 s on Linux, 0.5 s on macOS (run 40149966271); MAWS's six pool jobs 0.1-0.6 s (run 40151266892).
- Observation: presence by declared name is wrong for Homebrew aliases and old names and for Debian virtual
  packages; the inventory has to resolve them.
  Evidence: `brew install --dry-run pkg-config` proposed upgrading the installed `pkgconf`; `libasound2` is only
  provided by `libasound2t64` on Ubuntu 24.04 (pool run 40150924865). Fixed in #139 (062434a).
- Observation: Node's `fs.cp` rewrites relative symlinks into absolute paths unless `verbatimSymlinks: true`, which
  would point a bake container's copy back outside its mount.
  Evidence: real-copy tests RED 3/3 before the option, GREEN after (ci-kit #141, 5d540bf).
- Observation: MAWS's Linux jobs need neither the installed engine nor LibreOffice, and only desk-web uses
  Playwright's Chromium, on Linux only.
  Evidence: MAWS master b51430679: LINUX_E2E `library artifacts available tools agents desk-web`; installedEngine's
  callers are the connector, delivery and live suites; LIBREOFFICE_E2E `document presentations` (Mac groups);
  desk-web's Playwright config uses Chromium on Linux and the installed Chrome on Darwin. A Linux native install of
  Claude Code measured 9.1-13.2 s per job before it was made Darwin-only (run 40150847990).

## Decision Log

- Decision: M1 lands in two pull requests: action, schema and docs first, then the gates workflow's step, with the
  coordinator moving `v1` after each merge. GitHub Actions resolves every job's `uses:` before running any step,
  including steps whose conditions are false. The first M1 ci-gate run,
  [40148841436](https://github.com/SSFSKIM/ci-kit/actions/runs/40148841436), failed preparing the gate because
  `setup@v1` did not yet contain `setup/action.yml`; no tests ran. The action is first proven through
  `setup@setup-m1` on the sandbox's hosted Ubuntu, hosted macOS and pool jobs. The second pull request's ci-gate run
  proves the gates step resolves at the published `v1`.
  Rejected: a second kit checkout in the gate's workspace, which would appear in the repository's own tree.
  Rationale: the condition makes an already-published action safe for an empty declaration, not an unpublished
  action resolvable. Two additive releases keep each pull request independently verifiable without moving `v1`
  before merge.
  Date/Author: 2026-10-25, CI-opt, from the M1 executor's report.

- Decision: Verification. This spec gets an adversarial design review and an adversarial buildability review of
  its execution section before execution. Each milestone's branch gets doperpowers:review-code: `reviewer-medium`
  for M1, M2, M6, M7 and M8, `reviewer-high` for M3, M4 and M5 (they change the production bake, launcher and
  schedules). Executors
  are astra subagents following the task-executor role, per the owner's standing ruling; the coordinator (CI-opt)
  is the controller and the spec's one writer.
  Rationale: the bake and launcher paths are the ones whose mistakes stop every pool job; the rest are bounded
  and proven by green runs.
  Date/Author: 2026-10-25, CI-opt.

- Decision: Review revision (adversarial design and buildability reviews). The bake resolves every served
  repository's revision and hash once into the manifest both builders read; repository code in a bake runs behind the
  metadata block job VMs use, from a credential-free clone, proven from inside the container; the Linux bake's
  container contract is stated (runner user, mounts and ownership, the runner's bundled Node, entrypoint
  override); `install` runs in a throwaway container for the caches, and joins the hash because the Mac golden keeps
  its side effects; the MAWS-shaped manifest, EC2 image check and smoke check become per-repository in the bake
  milestone and lose their MAWS fields in the removal milestone; the guest's hash survives the `.env` rewrites; the
  Gatekeeper exception for new macOS apps is stated instead of claimed away; the stale check is its own Cloud Run job
  with the grants it needs; MAWS's declaration is given whole, Playwright's Chromium included in its `install`;
  MAWS's proof routes the guest explicitly and records runner names; the LibreOffice question is measured without a
  branch bake. The old M3 is split into the bake (M3) and the VMs' image choice (M4), since they deploy separately
  and fail differently.
  Rationale: each finding was checked against the code (`gce/bake/plan.mjs` `builderInstance`'s metadata token,
  `pool/bake/manifest.mjs` `verifyManifest`, `ec2/vm/job.mjs` `checkImage`, `gce/vm/smoke.sh`,
  `mac/vm/provision.sh`'s `runner` step, `gce/deploy.sh`'s bake grants) and held. Rejected: keeping `install` out of
  the hash by committing its side effects anyway (a hash that says "matches" for a different image).
  Date/Author: 2026-10-25, CI-opt.

- Decision: Second review round. Six of the design review's seven findings and all four buildability findings
  are resolved; the two remaining points are fixed in place: the declaration's Node and pnpm are on the PATH for the
  script in the bake's first run as well as for `install` in its second, and M4's proof waits for a bake from merged
  main, because a VM runs the job code baked into its image. The review has converged; no further round.
  Date/Author: 2026-10-25, CI-opt.

- Decision: LibreOffice stays out of MAWS's `apt`.
  Rationale: no Linux pool job installs it (its groups run on the Macs), so moving it into the image saves no job
  time while every MAWS VM would boot 333.6 MiB more: on the pool, `apt-get update` 4 s, writer and impress 11 s,
  67 packages, 341,574 KiB installed (ci-kit-sandbox run 40150924865). Revisit if `document` or `presentations`
  gains a Linux lane. Rejected: baking it in "in case", which costs every EC2 job its initialization time.
  Date/Author: 2026-10-25, CI-opt.

- Decision: In MAWS's declaration, Claude Code installs on macOS only and Playwright's Chromium on Linux only
  (`pnpm --filter desk-web exec playwright install chromium`, desk-web being its one consumer).
  Rationale: the Surprises entry above; installing either where no job uses it costs every job on that lane.
  Date/Author: 2026-10-25, CI-opt (M2 executor's findings).

- Decision: ci-kit-sandbox is the test repository for M3-M5: its default branch declares `apt: [cowsay]`, so the
  bake has a declaration to build before MAWS #145 lands, and M5's check is proven by changing that line.
  Rationale: a proof that waited on MAWS's merge would wait on the Mac lanes; the sandbox is ours and already a
  served repository. Rejected: deploying M3 and proving it only after #145 merges.
  Date/Author: 2026-10-25, CI-opt.

## Outcomes & Retrospective

Pending — written at finish.
