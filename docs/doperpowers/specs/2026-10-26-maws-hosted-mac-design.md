# MAWS on GitHub's hosted Macs

## Purpose

MAWS's CI is short of Macs. On 2026-10-24 and 10-25 the Macs ran about 1,100 job-minutes a day. A Mac job waited a
median of 24 to 27 minutes in the queue; the slowest tenth waited 77 to 95 minutes or more. Today the Mac capacity is
the Mac mini, plus its macOS guest. The guest is a second desktop, but for 342 minutes of 10-25 the memory floor held
it off. A second machine (an EC2 Mac) is blocked on AWS capacity.

GitHub's standard hosted runners are free, with no minute limit, on public repositories. That includes macOS: up to 5
jobs at once per account. The owner's ruling (2026-10-26): the sole reason to publish MAWS's code is to run CI on
those Macs. So the code goes to a new public repository, `SSFSKIM/maws-app`. MAWS stays private, and so do its
history, its pull requests and its Actions logs. The owner's answers:

- the public repository is `SSFSKIM/maws-app`, with no licence;
- it holds the whole tree minus a few paths, which the architect narrowed to what CI needs (below);
- it runs its own CI;
- every commit CI tests may be published, branch work included.

After this work, a gate run moves some e2e groups to GitHub's hosted Macs: those on a new admission list, or those a
`Lane: hosted` trailer names. Each such group still shows in the private run as a job named `e2e:<group>`. That job
does three things: it pushes the filtered tree of the run's commit to maws-app, waits for that group's hosted run there,
and ends with the hosted job's verdict. So `scripts/ci-gate.sh`, its alerts, its relaunch line, `e2e:default`'s
derivation and the architect's reading of a run see what they see today. The mini keeps everything else, and these
always: the timing-measured groups, the paid live groups, and anything that needs a secret.

How to see it working: `scripts/ci-gate.sh <sha> --gates e2e:document-app --runner macos --lane hosted` prints GREEN.
The private run's `e2e:document-app` job ran on a ci-kit pool box, and its log names a maws-app run. That run's commit
carries `MAWS-Source: <sha>`, and it ran on `macos-26` at 1920x1080.

### What it must not be

- **Never a self-hosted runner on maws-app**, and nothing on a self-hosted runner triggered by maws-app (ci-kit's
  rule: a public repository's fork pull request must never reach the owner's machines). maws-app's one workflow
  runs on GitHub's runners and is triggered only by a push (the deploy key's) or by the owner's dispatch. It has
  no `pull_request` trigger.
- **No secret in maws-app.** Its workflow reads none. A group that needs a credential stays on the mini.
- **Nothing published beyond the filter.** Every pushed tree is the deterministic filter's output for one MAWS
  commit. No private history, no other refs, no logs of the private run.
- **No change to what a private run means.** A hosted group's verdict is a job of the private run. A run that
  passes means every group passed somewhere admitted.
- **No measured, live or secret-needing group on a hosted Mac**, whatever the lists say. The plan refuses them
  there.

## Glossary

- **maws-app**: the public repository `SSFSKIM/maws-app`. It takes no issues or pull requests, and its workflow
  approval policy for fork pull requests is `all_external_contributors`.
- **The filter**: `.github/scripts/maws-app-tree.sh` in MAWS. From one MAWS commit it writes the tree maws-app runs
  CI on. It is deterministic: the same commit and the same filter version give the same files, byte for byte.
- **The overlay**: the files the filter adds on top, kept in MAWS under `.github/maws-app/`: the public `README.md`
  and the public workflow `workflows/hosted-mac.yml`.
- **A hosted group**: an e2e group whose job in a private run is a waiter, not a test run.
- **The waiter**: the private job for a hosted group, run by `.github/scripts/hosted-mac.sh`. It runs on the
  smallest ci-kit pool box. It pushes the filtered tree, waits for the public job and exits with its conclusion.
- **Admission**: the step that puts a group on `HOSTED_MAC_E2E` in `gate.yml`. A group is admitted after 3 of 3
  green hosted runs whose results match the mini host's. This is the rule `MAC_VM_E2E` already uses.

## Progress

- [x] (2026-10-26 02:13Z) Spike, three runs on maws-app (40258008992, 40258766113, 40259835982). Verdict: promote.
  It is recorded in Surprises & Discoveries.
- [x] (2026-10-26 02:0xZ) maws-app created: public, no licence; issues, wiki and projects off; fork-PR approval
  `all_external_contributors`. It holds commit 648b7e88 (MAWS e654db0cb6a5 through the spike's filter) and two spike
  commits on `main`.
- [ ] M1: the filter and the overlay in MAWS; the hosted Mac setup; one hand-pushed hosted run green.
- [ ] M2: the routing and the waiter; the deploy key; acceptance 1–6.
- [ ] M3: admission waves; `HOSTED_MAC_E2E` populated; acceptance 7.
- [ ] M4: a week's measurement; acceptance 8; Outcomes.

## Design

### The three desktops

| Desktop | Machine | Display | Backing scale |
|---|---|---|---|
| Mac mini host (`ci-kit-mac-mini`) | M4 Mac mini, 16 GiB, macOS 27.0 | 2560x1440, BetterDisplay HiDPI virtual display | 2x |
| Mac mini guest (`maws-vm-job-*`) | Tart VM, 4 GiB, macOS 27 golden | 2560x1440, scaling on | 2x |
| Hosted (`macos-26`) | Apple M1 (Virtual), 3 CPUs, 7 GiB, macOS 26.6.2 | 1920x1080, set by the setup step | 1x |

The hosted runner's display starts at 1024x768. It offers 12 modes, from 640x480 to 1920x1080, all with scaling off.
The e2e window is 1280x820 (`e2e/support/launch.ts`), and at 1024x768 macOS clamped it. That failed 7 width and click
checks in document-app, presentations and browser-chrome (spike run 2). Making the display a setup step, not
something each job discovers, makes a group's hosted result a property of the group (the architect's condition,
2026-10-26). 2x is out of reach there: forcing Chromium's device scale factor to 2 halves the logical screen to
960x540, smaller than the window. A group whose specs read pixels or compare PNGs at 2x either matches at 1x and
passes admission, or stays on the mini or the guest. A HiDPI virtual display on the hosted runner (BetterDisplay) is
possible but unproven; it is out of scope here, and its own spike if admission leaves many groups behind for scale.

### The flow of one hosted group

1. The plan job (`gate-plan.mjs`) places the group as hosted. That happens when the group is on `HOSTED_MAC_E2E`
   on a macOS lane, or named under `Lane: hosted`, and is neither measured, live nor on `MAC_SECRET_E2E`. Its
   matrix entry goes to the new `e2e_hosted` output instead of `e2e_host` or `e2e_vm`. Its runner is
   `[self-hosted, ci-kit-pool, cpus-2]`.
2. The `e2e-hosted` job, named `e2e:${{ matrix.group }}`, runs `.github/scripts/hosted-mac.sh` on that box. The
   script:
   1. checks out the run's commit;
   2. runs the filter into an empty directory;
   3. fetches maws-app's `main` with `--depth=1 --filter=blob:none`, so the push sends only the blobs `main` lacks;
   4. commits the filtered tree with `main`'s tip as its parent and the trailers below;
   5. pushes it to `ci/hosted/<run id>-<attempt>-<group slug>` with the deploy key.
3. maws-app's `hosted-mac.yml` runs on that push. It reads `Hosted-Group:` from the head commit and runs that one
   group on `macos-26`, as the private gate's e2e job would.
4. The waiter finds the maws-app run by branch and head sha. It prints the run's URL, polls until its one e2e job
   completes, and then prints the job's count lines and the failed tests' names. When the job failed, it also
   copies the hosted job's report artifact into the private run, so `ci-gate.sh`'s "failed jobs' reports" download
   finds it. It deletes its public ref and exits 0 only when the hosted job's conclusion is `success`.

A rerun of a red `e2e:<group>` in the private run is a new attempt. So it is a new ref, a new push and a new hosted
run, with no API token in either repository. A spot preemption of the waiter is rerun by ci-gate's existing rule
(Decision Log 70) and ends the same way.

Why a waiter per group, and not a waiter per run or ci-gate reading two runs:

- ci-gate's per-gate lines, its refused-against-finished summary, its relaunch line and `DefaultBeside` all read the
  private run's own job list. A job per group keeps every one of them unchanged.
- A run launched without ci-gate (a dispatch from the UI, the architect's landing gate) still gets a truthful
  conclusion.

The cost is a cpus-2 spot box per hosted group while it waits, about $0.0006 a minute. Waiters on `ubuntu-slim`
would cost $0.002 a minute: about $90 a month at the expected 1,500 waiter-minutes a day, against about $27 on the
pool.

### Provenance

Each maws-app commit's message is `MAWS <sha12> e2e:<group>` and ends with these trailers, so the architect can
recompute the tree from the MAWS sha:

    MAWS-Source: <full MAWS sha>
    MAWS-Source-Tree: <MAWS sha's tree id>
    MAWS-Filter: v2
    MAWS-Run: <private run id>/<attempt>
    Hosted-Group: <group>

The check is: run `maws-app-tree.sh <MAWS git dir> <sha> <empty dir>`, `git add -A` it in a fresh repository, and
compare `git write-tree` with the maws-app commit's tree. `v1` was the spike's filter, which lived outside MAWS. `v2`
is the first filter in MAWS; any change to the filter or the overlay bumps it.

### What the filter leaves out

From the MAWS tree, the filter removes:

- `.github/workflows/gate.yml`: the self-hosted gate, which would queue forever on maws-app.
- `.smns`: the sminos project file, which names the desk hub.
- `research/`: analyses of the Claude Desktop and Codex app bundles, with quoted excerpts. Publishing it is a
  licence and terms call.
- `docs/doperpowers/evidence/`, except `p1-e8/g0-cli-probe.txt`. `src/shared/plugins/cli.test.ts` reads that file;
  it is on `gate-affected.mjs`'s `READ_AS_DATA`.
- `spikes/p4-parity-bench/record-*`: recordings of the owner's real sittings.
- `mockups/shots/` and the PNGs under `mockups/desk/`.

It replaces the owner's four personal addresses with placeholders: `supremekim17@gmail.com` and
`supremekim17@icloud.com` become `owner@example.com`, and the two test accounts become `test-account-1@example.com`
and `test-account-2@example.com`. The four specs that write evidence under `docs/doperpowers/evidence/<x>` when their
SHOTS or EVIDENCE flags are set (c12-budget, c12-live, c12-prerun, code-editor) are checked in M1 for a recursive
mkdir. The hosted lane never sets those flags.

The filter then copies the overlay to the root. `.github/ci-kit.yml` and `.github/ci-setup.sh` stay, because the
shared setup reads them.

### The hosted job

`hosted-mac.yml` has one plan job on `ubuntu-latest`, which reads the trailer, and one e2e job on `macos-26`. The e2e
job has `MAWS_E2E_QUIET=1`, `SHELL=/bin/zsh`, `NODE_OPTIONS=--max-old-space-size=5120` (gate.yml's own) and a
60-minute timeout. Its steps:

1. Checkout.
2. `./.github/actions/setup` with `e2e: 'true'`. On a GitHub-hosted macOS runner, the setup action now first sets
   the display with `displayplacer`: 1920x1080, 60 Hz, scaling off. It prints `ci-kit desktop: <macOS version>
   <cpu> cpus <n> memory <GiB> display <WxH>@<scale>x`. It caches the pnpm store and Electron's download, as it
   already does on hosted Linux.
3. Remove the quarantine flag from `/Applications/LibreOffice.app` and `Google Chrome.app`. This is an ephemeral VM,
   and a first launch would wait on Gatekeeper.
4. The group's package script through `.github/scripts/gate-run.sh`, as gate.yml's e2e step runs it. It uses
   `MAWS_E2E_BUILD_CACHE=$RUNNER_TEMP/maws-e2e-build` and `MAWS_E2E_BUILD_KEY=$GITHUB_SHA`, so the script builds
   its out/ variant itself, about 80 to 90 s.
5. On failure, upload `playwright-report/` and `test-results/` as `e2e-<slug>`, kept 7 days.

`macos-26` is pinned, not `macos-latest`: it is closest to the mini's 27, and a silent image move would change
results.

### Admission

`HOSTED_MAC_E2E` starts empty. A candidate is a group on `MAC_VM_E2E`, which is already proven outside the host.
`unit:darwin` and `packaged` are not e2e groups and stay on the mini; moving them is later work. A candidate is admitted after three green runs under `Lane: hosted` on one MAWS tree whose host
runs on the same tree are green, or red on the same named baseline. Groups are admitted in waves, and the architect
lands each wave with its run ids.

- **`MAC_SECRET_E2E`**: a new list of the groups that need a credential or the login keychain's custody. They never
  go hosted. It starts with `connectors-oauth` and `discover`; Discover's custody conditions (a), (b) and (c) stand.
- **Loosened bounds**: a group whose bound needs loosening on the hosted Mac uses `latency-budget.ts`'s load policy,
  named in its spec, as the guest's did.
- **Rollback**: emptying `HOSTED_MAC_E2E` puts every group back on the mini at once.
- **The other direction**: `Lane: no-hosted` keeps every group of one run on the mini, for diagnosis.

### Capacity and cost

- **Hosted Macs**: 5 at once for the account, shared with cua's hosted-macOS gates. cua is a light user: 6 runs from
  10-24 to 10-26.
- **Spike timings** (test minutes, hosted against the mini host): document-app 2.5 against 2.1, transcript 5.1
  against 5.0, presentations 6.6 against 3.6, browser-chrome 1.4 against 1.0, connectors 3.9 against 3.9.
- **Per-job overhead**: about 2.3 minutes of cold setup (pnpm install, poppler, the LibreOffice cask, the engine) and
  about 1.5 minutes of build. The pnpm and Electron caches cut part of the setup. The build stays per job in this
  design, because sharing it would need a token to read the private run's artifact.
- **Cost**: the hosted Macs and maws-app's Linux plan job are free. The waiters cost the pool's cpus-2 spot rate.

## Plan of Work

Constraints that bind every milestone:

- MAWS changes land as pull requests the architect merges, with a class 1a static gate before the push for lane files
  (gate-offload Decision Log 57). The wiring's landing gets gate-offload Decision Log 106 from the architect.
- ci-kit is not changed: the waiter runs on the pool as any job does.
- The deploy key and the `MAWS_APP_DEPLOY_KEY` secret are made by CI-opt with the owner's `gh` login. The private
  key is written only to the secret, never printed or kept on disk beyond the command that sets it.
- Nothing runs the gates' commands on the owner's MacBook. A focused test file is fine.
- Every commit and PR body ends with `Sminos-Session: CI-opt#a45b97a3 (doperpowers on macbook)`; no Co-Authored-By.

### M1 — MAWS: the filter, the overlay and the hosted Mac setup

At its end, a MAWS commit can be turned into a maws-app tree by a script in MAWS, and a hand push of that tree with a
`Hosted-Group:` trailer runs the group green on `macos-26`.

Touches:

- `.github/scripts/maws-app-tree.sh` (new): the filter.
- `.github/maws-app/README.md` and `.github/maws-app/workflows/hosted-mac.yml` (new): the overlay. Start from the
  spike's `README.md` and `mac-e2e.yml` in `SSFSKIM/maws-app` at `main`, with the trigger changed to `push` on
  `ci/**` plus `workflow_dispatch`, and the group read from the trailer.
- `.github/actions/setup/action.yml`: the hosted macOS display step and the desktop line; the pnpm and Electron
  caches extended to GitHub-hosted macOS.
- A test beside the gate scripts' tests.
- The four SHOTS and EVIDENCE writers, if one of them lacks a recursive mkdir.

Decisions:

- The filter is bash plus a short Python 3 redaction, as the spike's, and it preserves line endings
  (`newline=''`).
- It reads only the git objects of the given sha (`git archive`), never the working tree.
- It prints its version on stdout.

Does not touch: `gate.yml`'s jobs or lists, `gate-plan.mjs`, `ci-gate.sh`.

Proves: acceptance 4 and 5. The tests pin:

- two exports of one sha are byte-identical;
- every excluded path is absent, and `p1-e8/g0-cli-probe.txt` is present;
- none of the four addresses remains;
- `gate.yml` is absent, and the overlay's two files are present.

### M2 — MAWS: the routing and the waiter

At its end, `--lane hosted` on a macOS run sends the run's eligible groups to the hosted Macs. Each one is a private
job named `e2e:<group>` whose verdict is the hosted job's.

Touches:

- `gate.yml`: the lists `HOSTED_MAC_E2E` (empty) and `MAC_SECRET_E2E`; the `e2e-hosted` job; the plan's
  `e2e_hosted` output; the workflow_dispatch input `lane` accepting `hosted` and `no-hosted`.
- `.github/scripts/gate-plan.mjs` and its tests: the placement in Design, "The flow of one hosted group", step 1.
  The refusal of a measured, live or secret group under `Lane: hosted` names the group and the list it is on. The
  `e2e` output keeps hosted groups, so `e2e-default-specs.mjs` counts them as beside `default`.
- `scripts/ci-gate.sh`: `--lane hosted|no-hosted`, into the `Lane:` trailer.
- `.github/scripts/hosted-mac.sh` (new): the waiter.
- The deploy key on maws-app and the `MAWS_APP_DEPLOY_KEY` secret on MAWS.

Decisions:

- **The public ref**: `ci/hosted/<run id>-<attempt>-<slug>`, force-pushed; deleted by the waiter on every exit path
  after the push.
- **Finding the run**: the waiter polls `gh api repos/SSFSKIM/maws-app/actions/runs?branch=<ref>&event=push` for the
  pushed sha, for up to 2 minutes. Not found: it prints `hosted: no run of <sha> on <ref>` and exits 1.
- **Waiting**: polls every 30 s. The job timeout is 100 minutes, under the pool's `max_run_minutes` of 120. A whole
  set's hosted groups queue at GitHub's 5-job limit; the waiter prints `hosted: queued` while the hosted job has not
  started.
- **Reading the result**: with the job's own `GITHUB_TOKEN`; maws-app is public. If its logs or artifacts cannot be
  read, it prints the URL and the conclusion and carries on, because the verdict does not depend on them.
- **Timeout of the waiter itself**: it cancels the hosted run.
- **The push's transport**: SSH with the deploy key, `GIT_SSH_COMMAND` naming a key file under `$RUNNER_TEMP` that
  the job removes on exit. If a pool box cannot reach github.com on port 22, it uses `ssh.github.com` on port 443,
  which GitHub serves for this.

Does not touch: the mini's lanes, `MAC_VM_E2E`, ci-kit.

Proves: acceptance 1, 2, 3 and 6. The tests pin:

- gate-plan places a listed group hosted on a macOS lane, and never on a Linux lane;
- `Lane: hosted` places a named, unlisted group hosted;
- `Lane: no-hosted` places none;
- a measured, live or secret group is refused under `Lane: hosted` and kept on the mini under the list;
- the `e2e` output still lists hosted groups;
- ci-gate.sh's `--lane` accepts the two new values.

### M3 — Admission waves

At its end, `HOSTED_MAC_E2E` holds every candidate that passed, and a default macOS run sends them to the hosted Macs.

The work:

- Run the candidates in waves of up to 5 groups under `--lane hosted`, three runs per wave on one MAWS tree.
- Take host references on the same tree. Reuse a green host run of the same tree when one exists.
- Record each wave's run ids and verdicts in this spec's Decision Log, and send them to the architect. The architect
  lands the list change.
- A group that fails for the 1x display, the 3 CPUs or the 7 GiB stays off the list, with the failure named.

Proves: acceptance 7.

### M4 — Measurement

At its end, the effect is measured.

- **Before**: 10-24 and 10-25 from the jobs data in `/tmp/ci-analysis/linux-e2e/jobs-prev.json`. Refetch it if it is
  gone.
- **After**: the 7 days after M3's first wave lands, refetched with the same script.
- **The record**: the Mac queue's median and p90, the hosted share of e2e job-minutes, and the waiter cost, in
  Outcomes & Retrospective.

Proves: acceptance 8.

## Concrete Steps

From a MAWS worktree on the milestone's branch:

    .github/scripts/maws-app-tree.sh "$(git rev-parse --git-common-dir)" HEAD /tmp/maws-app-tree-a   # prints v2
    .github/scripts/maws-app-tree.sh "$(git rev-parse --git-common-dir)" HEAD /tmp/maws-app-tree-b
    diff -rq /tmp/maws-app-tree-a /tmp/maws-app-tree-b && echo deterministic

M1's hand push, from the filtered tree, with a fresh `GIT_DIR`. Commit it with the trailers in Design, "Provenance",
and `Hosted-Group: document-app`. Then:

    git push https://github.com/SSFSKIM/maws-app.git HEAD:refs/heads/ci/hosted/m1-proof
    gh run list -R SSFSKIM/maws-app -w hosted-mac.yml --branch ci/hosted/m1-proof   # completed success

M2's proof, from the MAWS worktree:

    scripts/ci-gate.sh HEAD --gates e2e:document-app,e2e:transcript --runner macos --lane hosted
    # PASS e2e:document-app … PASS e2e:transcript … ci-gate: run <id> success

## Acceptance

1. `scripts/ci-gate.sh <sha> --gates e2e:document-app,e2e:transcript --runner macos --lane hosted` ends with
   `ci-gate: run <id> success`. Each `e2e:` job of that run ran on a `ci-kit-pool` runner. Each log prints a maws-app
   run URL. Each such run's head commit carries `MAWS-Source: <sha>` and `Hosted-Group: <group>`, and its job log has
   a `ci-kit desktop:` line with `display 1920x1080@1x`.
2. A hosted group that fails makes its private `e2e:<group>` job fail. ci-gate prints RED with that group and the
   failed test's name in its log tail. Prove it with a scratch commit that breaks one assertion of a hosted group's
   spec.
3. Rerunning that failed private job (`gh run rerun <id> --job <job id>`) makes a new maws-app ref and run. After the
   scratch commit is reverted, the rerun's verdict follows the new hosted run.
4. The architect's recompute: the filter, run on the run's MAWS sha, gives a tree whose `git write-tree` equals the
   maws-app commit's tree.
5. No pushed maws-app commit contains `research/`, `.smns`, `.github/workflows/gate.yml`, a
   `docs/doperpowers/evidence/` file other than `p1-e8/g0-cli-probe.txt`, or any of the four addresses. The M1 test
   pins this, and `git -C <maws-app clone> grep` over the refs of the acceptance runs shows it.
6. maws-app's workflow file has no `secrets.` reference and no `pull_request` trigger;
   `gh api repos/SSFSKIM/maws-app/actions/permissions/fork-pr-contributor-approval` answers
   `all_external_contributors`; `gh api repos/SSFSKIM/maws-app/actions/runners` lists none.
7. After M3, a default macOS run (`--runner macos`, no `Lane:`) runs the admitted groups as waiters and the rest on
   the mini. `HOSTED_MAC_E2E` names exactly the admitted groups, each with its 3 run ids in a gate.yml comment.
8. M4's numbers are in Outcomes & Retrospective: the Mac queue median before and after, and the share of e2e
   job-minutes on the hosted Macs.

## Verification

- **This spec**: one `doperpowers:adversarial-reviewer` pass on the whole document, and one on the execution
  section's buildability (the spec has more than one milestone).
- **The branch**: M1 and M2 get `doperpowers:reviewer-high` on their diffs. The waiter and the plan's placement are
  launcher paths: a wrong placement sends a measured group to the wrong desktop, and a wrong push publishes the wrong
  tree. M3 is list edits with run evidence; its review is the architect's landing.

## Decision Log

- 2026-10-26 (owner, through CI-opt's questions):
  - **Route**: a separate public repository with a fresh history, over flipping MAWS. The flip loses the self-hosted
    lanes, and it exposes 8,783 commits, 176 branches, 134 undeletable pull requests and the Actions logs.
  - **Settings**: name `SSFSKIM/maws-app`, no licence, the tree minus the CI and personal paths, static and unit on
    pull requests. That last answer is superseded below, once the intent became clear.
  - **The intent**: the sole reason to go public is Mac capacity for CI.
  - **Publishing**: every commit CI tests may be published, branch work included.
- 2026-10-26 (CI-opt, after the owner's intent): maws-app is a CI executor for MAWS's Mac groups, not a mirror, and
  its CI is this lane, not a pull-request gate. A mirror of landed master would not add a single Mac minute to the
  queue.
- 2026-10-26 (architect, four conditions, all taken):
  - keep the one evidence file a suite reads;
  - provenance trailers and a deterministic filter, with the hosted results reported against the MAWS sha;
  - admission by `MAC_VM_E2E`'s rule, with the mini keeping the measured, live and secret groups;
  - Decision Log 106 at the landing.
  Also: the display mode and scale are part of setup and stated per desktop.
- 2026-10-26 (CI-opt): one waiter job per hosted group in the private run, on the pool's cpus-2 box. The waiter
  pushes the tree itself, so a rerun of the private job is a fresh hosted run and no API token is needed in either
  repository. Rejected: ci-gate reading two runs, which would leave a UI-dispatched private run green whatever the
  hosted result and would need changes to the job-list readers (alerts, refusals, `DefaultBeside`). Also rejected:
  `ubuntu-slim` waiters, at about three times the pool's cost for the same wait.
- 2026-10-26 (CI-opt): `macos-26` is pinned, and the display is 1920x1080@1x, set in setup.
- 2026-10-26 (CI-opt): the out/ build stays in each hosted job. Sharing the private run's e2e-build artifact would
  need a cross-repository token, and the build costs about 1.5 minutes of free hosted time.

## Surprises & Discoveries

- **The spike** (runs 40258008992, 40258766113, 40259835982 on maws-app):
  - **The machine**: `macos-26` is macOS 26.6.2 on an Apple M1 (Virtual) with 3 CPUs and 7 GiB.
  - **Results**: document-app 20/20, transcript 37/37, presentations 38 passed and 10 skipped, browser-chrome 7/7,
    connectors 5/5. That is one run each, which is not admission evidence.
  - **The heap**: the harness build ran out of Node's default 2 GB heap (transcript, browser-chrome), until the job
    took gate.yml's `NODE_OPTIONS=--max-old-space-size=5120`.
  - **The display**: it starts at 1024x768, and the 1280x820 window was clamped. That failed document-app
    `document-narrow.spec.ts:316` and `document.spec.ts:119` (click timeouts), presentations
    `presentations-comments.spec.ts:95` (652 against more than 720), `presentations-history.spec.ts:134` and
    `presentations.spec.ts:501` (1353px against 1360px), and browser-chrome `:376` and `:745`. All passed at
    1920x1080.
  - **Verdict**: promote. M1 hardens the filter and the workflow, and M2 wires them.
- **The schedule is not the waiter's problem, but the 5-job limit is.** A whole set with about 25 hosted groups takes
  roughly five waves of hosted jobs. The waiter's 100-minute timeout covers that queue. A gate launched behind a whole
  set waits at GitHub instead of at the mini.

## Outcomes & Retrospective

(At M4.)
