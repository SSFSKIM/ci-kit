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

After this work, a gate run moves some e2e groups to GitHub's hosted Macs: those on a new admission list, or every
eligible group of a run under `Lane: hosted`. Each such group still shows in the private run as a job named
`e2e:<group>`. That job pushes the filtered tree of the run's commit to maws-app, waits for that group's hosted run
there, and ends with the hosted job's verdict. So `scripts/ci-gate.sh`'s per-gate lines, its relaunch line,
`e2e:default`'s derivation and the architect's reading of a run see what they see today; the three readers that must
learn about the new placement (the alert preflight, the pool-demand hint, the report download) are named in M2. The
mini keeps everything else, and these always: the timing-measured groups, the paid live groups, `default`, and
anything that needs a secret.

How to see it working: `scripts/ci-gate.sh <sha> --gates e2e:document-app --runner macos --lane hosted` prints GREEN.
The private run's `e2e:document-app` job ran on a ci-kit pool box, and its log names a maws-app run. That run's
request commit carries `MAWS-Source-Tree: <the tree of sha>`, and it ran on `macos-26` at 1920x1080.

### What it must not be

- **Never a self-hosted runner on maws-app**, and nothing on a self-hosted runner triggered by maws-app (ci-kit's
  rule: a public repository's fork pull request must never reach the owner's machines). maws-app's one workflow
  runs on GitHub's runners and is triggered only by a push to `ci/hosted/**` (the deploy key's), its schedule, or the
  owner's dispatch. It has no `pull_request` trigger.
- **No secret in maws-app, and no API credential across the two repositories.** maws-app's workflow reads no secret;
  its jobs use only their own automatic `GITHUB_TOKEN`, on maws-app. MAWS holds one credential for maws-app: a deploy
  key, which is git access and nothing else. The waiter learns everything over git. A group that needs a credential
  stays on the mini.
- **Nothing published beyond the filter.** Every pushed tree is the deterministic filter's output for one MAWS
  commit. No private history, no other refs, no logs of the private run. The filter is a deny list over a tree the
  owner chose to publish whole; it is not a scanner for content added to MAWS later.
- **No credential published by accident.** Every gated branch commit is published within minutes, so a token an
  agent commits to any branch would go public, where today it reaches only a private repository. A secret scan runs
  on what each push would add, and fails closed: a finding, or a scan that cannot run, makes the group red and
  pushes nothing (The secret scan).
- **No change to what a private run means.** A hosted group's verdict is a job of the private run. A run that
  passes means every group passed somewhere admitted, and admission keeps a group off the hosted Macs when 1x would
  hide a regression the 2x desktops catch.
- **No measured, live, secret-needing or `default` group on a hosted Mac**, whatever the lists say. The plan refuses
  a list that names one, and a lane never moves one.

## Glossary

- **maws-app**: the public repository `SSFSKIM/maws-app`. It takes no issues or pull requests, and its workflow
  approval policy for fork pull requests is `all_external_contributors`.
- **The filter**: `.github/scripts/maws-app-tree.sh` in MAWS. From one MAWS commit it writes the tree maws-app runs
  CI on. It is deterministic: the same commit and the same filter version give the same files, byte for byte.
- **The overlay**: the files the filter adds, kept in MAWS under `.github/maws-app/`: `README.md`, which becomes the
  tree's `README.md`, and `hosted-mac.yml`, which becomes `.github/workflows/hosted-mac.yml`.
- **A hosted group**: an e2e group whose job in a private run is a waiter, not a test run.
- **The waiter**: the private job for a hosted group, run by `.github/scripts/hosted-mac.sh`. It runs on the
  smallest ci-kit pool box. It pushes the filtered tree, waits for the public job's result and exits with it.
- **The suffix**: `<private run id>-<run attempt>-<group slug>`, unique to one attempt of one waiter.
- **The request**: the commit the waiter pushes to `ci/hosted/<suffix>` in maws-app. Its push starts the hosted run.
- **The result**: the commit maws-app's workflow writes to `ci/result/<suffix>` when the hosted job ends. It carries
  the verdict, the run's URL, the count lines and the failed tests' names.
- **A cancel**: a commit the waiter pushes over its request, with a `Hosted-Cancel:` trailer. Its push cancels the
  request's run through the workflow's concurrency group.
- **Admission**: the step that puts a group on `HOSTED_MAC_E2E` in `gate.yml`. A group is admitted after 3 of 3
  green hosted runs whose results match its usual desktop's. This is the rule `MAC_VM_E2E` already uses.

## Progress

- [x] (2026-10-26 02:13Z) Spike, three runs on maws-app (40258008992, 40258766113, 40259835982). Verdict: promote.
  It is recorded in Surprises & Discoveries.
- [x] (2026-10-26 02:0xZ) maws-app created: public, no licence; issues, wiki and projects off; fork-PR approval
  `all_external_contributors`. It holds commit 648b7e88 (MAWS e654db0cb6a5 through the spike's filter) and two spike
  commits on `main`.
- [x] (2026-10-26 05:1xZ) Spec review, two rounds (three adversarial reviews): the control plane moved to git refs, the
  ineligible groups and the three readers named, admission given its 1x rule, the acceptance list rewritten. Decision
  Log, 2026-10-26 "review round 1".
- [x] (2026-10-26 05:58Z) M1: the filter, the overlay, the secret scan and the hosted Mac setup in MAWS (21bad077d,
  reviewed clean: a task review and reviewer-high, one fix wave); maws-app's `main` at 6d44bb9 and ruleset 25857219;
  the public half proven by hand (Surprises & Discoveries). SSFSKIM/MAWS#151, for the architect to land.
- [ ] M2: the routing, the waiter and the three readers in MAWS; the deploy key; acceptance 1–4 and 7.
- [ ] M3: admission waves; `HOSTED_MAC_E2E` populated; acceptance 8.
- [ ] M4: the collector and the before numbers; the after numbers seven days after M3's first wave lands;
  acceptance 9; Outcomes.

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
960x540, smaller than the window.

What 1x costs is coverage, not only portability. A spec that reads the scale can pass at 1x and still miss a
regression that 2x shows: `e2e/browser-comment.spec.ts:366` checks that a crop's size is the element's times the
device pixel ratio, and a crop made at 1x on a 2x desktop passes that check at 1x. So admission (below) keeps a
group whose specs read the scale off the hosted Macs. A HiDPI virtual display on the hosted runner (BetterDisplay) is
possible but unproven; it is out of scope here, and its own spike if admission leaves many groups behind for scale.

### Placement

The plan (`gate-plan.mjs`) decides, for each e2e group of a run on a macOS lane, whether it is hosted.

A group is **eligible** when it is none of these: `default` (its job builds with `pnpm build` and runs a selection
derived from the whole run, `E2E_PLAN` and `DEFAULT_BESIDE`, which do not cross to maws-app); on `MEASURED_E2E`; on
`LIVE_E2E` or `LIVE_GUARD_E2E`; on `MAC_SECRET_E2E`; on `POOL_E2E` (those never take a Mac). A live run places no
group hosted. `unit:darwin` and `packaged` are not e2e groups and stay on the mini.

The `Lane:` trailer (the `lane` input on a dispatch; `ci-gate.sh --lane`) takes one value. An explicit lane decides for
the groups it moves, and the lists decide the rest:

| Lane | Hosted | Everything else |
|---|---|---|
| none | eligible groups on `HOSTED_MAC_E2E` | as today: shared, solo or the exclusive instance |
| `hosted` | every eligible group of the run | as today |
| `no-hosted` | none | as today |
| `vm`, `vm-trial` | eligible groups on `HOSTED_MAC_E2E` and not on `MAC_VM_E2E` | `MAC_VM_E2E` groups to the guest lane, the rest as today |

A Linux lane never places a group hosted. `HOSTED_MAC_E2E` naming a group that is not eligible is a contradiction in
`gate.yml`, and the plan refuses the run, naming the group and why (`default`, measured, live, secret, or pool). Under
`Lane: hosted` an ineligible group stays where it would be and the plan's summary names it, as `Lane: vm`'s note does
for groups off `MAC_VM_E2E`.

A hosted group's entry in the `e2e` output carries `hosted: true`, `runner: ["self-hosted","ci-kit-pool","cpus-2"]`,
`timeout: 100`, and no `variant`. The entry goes to the new `e2e_hosted` output, not to `e2e_host` or `e2e_vm`, so
e2e-build builds nothing for it. It stays in `e2e`, so `e2e-default-specs.mjs` counts it as beside `default`, and
`ci-gate-pool-demand.mjs` counts its cpus-2 box. The plan's `pool` output is true when `e2e_hosted` is not empty.

### The flow of one hosted group

1. **The private job.** gate.yml's `e2e-hosted` job, named `e2e:${{ matrix.group }}`, runs on the entry's runner
   with its timeout. Its steps: `actions/checkout` (depth 1); `.github/scripts/hosted-mac.sh` with the entry as
   `ENTRY` (JSON) and `MAWS_APP_DEPLOY_KEY` from secrets; and a last step, `if: always()`, `hosted-mac.sh --cleanup`.
   It needs no setup action: the waiter uses bash, git, ssh, python3 and jq, all on the pool image except possibly
   ssh (below).
2. **The request.** The waiter:
   1. writes the key to a 0600 file under `$RUNNER_TEMP`, and a known_hosts file with GitHub's published host keys
      for `github.com` and `[ssh.github.com]:443`, pinned in the script; `GIT_SSH_COMMAND` names both, with
      `IdentitiesOnly=yes`. If `ssh` is missing it installs `openssh-client` with the runner's passwordless sudo.
      The remote is `git@github.com:SSFSKIM/maws-app.git`, or `ssh://git@ssh.github.com:443/SSFSKIM/maws-app.git` when
      port 22 does not answer. `MAWS_APP_REMOTE` overrides it, for the tests;
   2. cancels earlier attempts of its own run and group: every `ci/hosted/<run id>-<k>-<slug>` with `k` below its
      attempt gets a cancel (a waiter lost to a spot preemption could not cancel its own);
   3. runs the filter on `$GITHUB_SHA` into an empty directory;
   4. fetches maws-app's `main` with `--depth=1 --filter=blob:none` into a fresh git directory, so the push sends only
      the blobs `main` lacks (the whole tree is a 51 MiB pack). Then it runs the secret scan on the files of the
      filtered tree that differ from `main`'s tree. A finding stops it here: it prints each finding's file, line and
      rule, never the value, prints `hosted: secret scan refused the push`, pushes nothing and exits 1;
   5. commits the filtered tree with `main`'s tip as its parent, the message `MAWS <sha12> e2e:<group>` and the
      trailers below, and force-pushes it to `ci/hosted/<suffix>`;
   6. when `main`'s tip is more than 24 hours old and the run's requested commit is already on MAWS master, pushes
      the request to `main` too, as a fast-forward; a rejected push (another waiter won) is ignored. The requested
      commit is `$GITHUB_SHA`'s first parent under ci-gate (its nonce commit), else `$GITHUB_SHA`; "on master" is
      MAWS's compare API (`compare/<commit>...master` answering `ahead` or `identical`), read with the job's own
      token. So `main`, its overlay (whose sweep the schedule runs) and its tree are always landed work, and the
      next pushes stay small;
   7. prints `hosted: request ci/hosted/<suffix> <request sha>` and the link
      `https://github.com/SSFSKIM/maws-app/actions?query=branch%3Aci%2Fhosted%2F<suffix>`.
3. **The hosted run.** maws-app's `hosted-mac.yml` runs on that push (below). Its `result` job writes the result
   commit to `ci/result/<suffix>`: the request's tree, the request as its only parent, and a message
   `hosted: <conclusion> e2e:<group>` whose body holds the hosted job's count lines and failed tests (at most 100
   lines) and whose trailers are `Hosted-Conclusion: <success|failure|cancelled|skipped>` and
   `Hosted-Run: <run URL>/attempts/<n>`.
4. **The wait.** The waiter runs `git ls-remote <remote> refs/heads/ci/result/<suffix>` every 30 s. git over SSH has
   no API rate limit to share with the rest of MAWS's jobs. When the ref appears, it fetches that commit alone
   (`--depth=1 --filter=tree:0`), checks that its parent is the request, prints `hosted: <conclusion> <Hosted-Run>`
   and the body, and deletes both refs in one push. It exits 0 only for `success`.
5. **The deadline.** The waiter's deadline is 95 minutes after it starts, under the job's 100-minute timeout, under
   the pool's `max_run_minutes` of 120. Past it, the waiter prints
   `hosted: no result by <UTC time>: the hosted job was still queued or running at GitHub`, cancels its request and
   exits 1. That line tells a capacity failure from a test failure in ci-gate's log tail.
6. **Cleanup.** `hosted-mac.sh --cleanup` runs when the job ends any way, including when the private run is
   cancelled (gate.yml's concurrency cancels a superseded run). If a request was pushed and no result read, it
   cancels the request; it deletes a result ref if one exists. It is best-effort and exits 0.

A rerun of a red `e2e:<group>` in the private run is a new attempt, so a new suffix, a new request and a new hosted
run, on the same `$GITHUB_SHA`: GitHub reruns keep the run's commit. A spot preemption of the waiter is rerun by
ci-gate's existing rule (Decision Log 70); the new attempt cancels the old request (step 2.2).

Why a waiter per group, and not a waiter per run or ci-gate reading two runs:

- ci-gate's per-gate lines, its refused-against-finished summary, its relaunch line and `DefaultBeside` all read the
  private run's own job list. A job per group keeps every one of them unchanged.
- A run launched without ci-gate (a dispatch from the UI, the architect's landing gate) still gets a truthful
  conclusion.

The cost is a cpus-2 spot box per hosted group while it waits, about $0.0006 a minute. Waiters on `ubuntu-slim`
would cost $0.002 a minute: about $90 a month at the expected 1,500 waiter-minutes a day, against about $27 on the
pool.

### Orphans and refs

A hosted run outlives its waiter in four cases, and each has an owner:

| Case | What ends the hosted run |
|---|---|
| the private run is cancelled | the cleanup step's cancel |
| the waiter's deadline passes | the waiter's cancel |
| the waiter's box is preempted, then rerun | the next attempt's cancel (step 2.2) |
| the waiter is lost with no rerun | the hosted job's stale guard if it has not started; its 60-minute timeout if it has |

The **stale guard** is the hosted e2e job's first step. It exits 1 at once, `hosted: stale request`, when the job
starts after the request's `Hosted-Deadline:`, or when the request's ref (`git ls-remote` of the public repository,
no token) no longer points at the run's own commit: a cancel, a deletion or a newer push has replaced it. GitHub does
not promise that a concurrency group sees two pushes in the order they were made, so a cancel can arrive before the
request it cancels; the ref check makes that request inert anyway. A job that waited in GitHub's queue past its
waiter's deadline, or past its cancel, so holds a Mac slot for seconds. The **sweep**, a scheduled job of `hosted-mac.yml` every 6 hours, deletes
`ci/hosted/*` and `ci/result/*` refs whose commit is more than 6 hours old: no waiter lives that long, so the refs are
dead.

### Provenance

Each request's message is `MAWS <sha12> e2e:<group>` and ends with these trailers:

    MAWS-Source: <the private run's commit, $GITHUB_SHA>
    MAWS-Source-Tree: <its tree id>
    MAWS-Filter: v2
    MAWS-Run: <private run id>/<attempt>
    Hosted-Group: <group>
    Hosted-Script: <the entry's package script>
    Hosted-Slug: <the entry's slug>
    Hosted-LibreOffice: <true|false>
    Hosted-Evidence: <true|false>
    Hosted-Deadline: <the waiter's deadline, Unix seconds>

`MAWS-Source` is the run's own commit. Under ci-gate that is its nonce commit, whose tree is the requested sha's and
whose first parent is the requested sha (`scripts/ci-gate.sh`, `commit-tree "$sha^{tree}" -p "$sha"`). So the tree
the architect recomputes is the requested sha's. The check: run `maws-app-tree.sh <MAWS git dir> <MAWS-Source>
<empty dir>`, `git add -A --force` it in a fresh repository (MAWS tracks files its own `.gitignore` matches, which a
plain `-A` drops), and compare `git write-tree` with the request's tree. `v1` was
the spike's filter, which lived outside MAWS. `v2` is the first filter in MAWS; any change to the filter or the
overlay bumps it.

### What the filter leaves out

From the MAWS tree (`git archive <sha>`, never the working tree), the filter removes:

- `.github/workflows/`, all of it: `gate.yml` is the self-hosted gate, which would queue forever on maws-app, and any
  workflow a branch adds would run on maws-app's push. The overlay's `hosted-mac.yml` is the only workflow there.
- `.smns`: the sminos project file, which names the desk hub.
- `research/`: analyses of the Claude Desktop and Codex app bundles, with quoted excerpts. Publishing it is a
  licence and terms call.
- `docs/doperpowers/evidence/`, except `p1-e8/g0-cli-probe.txt`. `src/shared/plugins/cli.test.ts` reads that file;
  it is on `gate-affected.mjs`'s `READ_AS_DATA`.
- `spikes/p4-parity-bench/record-*`: recordings of the owner's real sittings.
- `mockups/shots/` and the PNGs under `mockups/desk/`.

It replaces the owner's four personal addresses with placeholders: `supremekim17@gmail.com` and
`supremekim17@icloud.com` become `owner@example.com`, and the two test accounts become `test-account-1@example.com`
and `test-account-2@example.com`. The redaction is Python 3 working on bytes, in every file, so line endings are kept
and a file that is not UTF-8 is redacted too. The four specs that write evidence under `docs/doperpowers/evidence/<x>` when their SHOTS or EVIDENCE flags are
set (c12-budget, c12-live, c12-prerun, code-editor) are checked in M1 for a recursive mkdir. The hosted lane never
sets those flags.

The filter then writes the overlay: `.github/maws-app/README.md` to `README.md`, and
`.github/maws-app/hosted-mac.yml` to `.github/workflows/hosted-mac.yml`. It removes `.github/maws-app/` itself.
`.github/ci-kit.yml` and `.github/ci-setup.sh` stay, because the shared setup reads them. It prints its version on
stdout.

### The secret scan

`.github/scripts/maws-app-scan.sh <dir>` scans a directory with gitleaks (`dir` mode, `--redact`), using the default
rules and `.github/maws-app/gitleaks.toml`, whose allowlist names each known false positive with its reason (test
vectors, `api_message_id`, the public keys in saved pages: the kinds the 2026-10-26 history audit found). The script
pins one gitleaks release by version and sha256 and downloads it with curl when it is not on `PATH`; a download or
checksum failure is a refusal like a finding. It exits 0 when clean and 1 otherwise, printing each finding's file,
line and rule.

The waiter scans only the files that differ from `main`'s tree, copied with their paths into an empty directory:
`main` holds only trees that were scanned on their way there (its first v2 tree in full, in M1), so the new files are
what a push adds. The config is not published: the filter removes `.github/maws-app/`.

### The hosted workflow

`hosted-mac.yml`, in maws-app:

- **Triggers**: `push` to `ci/hosted/**`; `schedule` every 6 hours (the sweep; it runs from `main`'s copy, which step
  2.6 keeps current); `workflow_dispatch` (the owner's; runs the sweep).
- **Permissions**: `contents: read` at the top. Only `result` and `sweep` take `contents: write`.
- **Concurrency**: group `hosted-${{ github.ref }}`, `cancel-in-progress: true`. A cancel pushed to a request's ref
  cancels the request's run, queued or running.
- **`plan`** (`ubuntu-latest`, push only): reads the trailers from `github.event.head_commit.message`, with no
  checkout. A request with `Hosted-Cancel:` outputs no group, so nothing else runs.
- **`e2e`** (`macos-26`, 60-minute timeout), with `MAWS_E2E_QUIET=1`, `SHELL=/bin/zsh` and
  `NODE_OPTIONS=--max-old-space-size=5120` (gate.yml's own). Its steps:
  1. the stale guard;
  2. checkout, with `persist-credentials: false`;
  3. `./.github/actions/setup` with `e2e: 'true'` and `libreoffice` from `Hosted-LibreOffice`. On a GitHub-hosted
     macOS runner the setup action now first sets the display with `displayplacer`: 1920x1080, 60 Hz, scaling off.
     It prints `ci-kit desktop: <macOS version> <cpu> cpus <n> memory <GiB> display <WxH>@<scale>x`. It caches nothing
     there: a cache saved on a `ci/hosted/` branch is restorable only from that branch (Decision Log, M1);
  4. remove the quarantine flag from `/Applications/LibreOffice.app` and `Google Chrome.app` (an ephemeral VM, and a
     first launch would wait on Gatekeeper);
  5. `pnpm "$SCRIPT"` (`Hosted-Script`) through `.github/scripts/gate-run.sh` with gate.yml's count pattern, its
     output also kept in a file. It uses `MAWS_E2E_BUILD_CACHE=$RUNNER_TEMP/maws-e2e-build` and
     `MAWS_E2E_BUILD_KEY=$GITHUB_SHA`, so the script builds its out/ variant itself, about 80 to 90 s;
  6. `if: always()`: the job's `summary` output, the count lines and Playwright's numbered failure lines from that
     file, at most 100 lines;
  7. on failure, or when `Hosted-Evidence` is true, upload `playwright-report/` and `test-results/` as
     `e2e-<slug>`, kept 7 days.
- **`result`** (`ubuntu-latest`, `needs: [plan, e2e]`, `if: always()` and a group was planned): writes the result
  commit through the REST API (`git/commits` with the push's `head_commit.tree_id` and the request as parent, then
  the ref), with `needs.e2e.result` as `Hosted-Conclusion`.
- **`sweep`** (`ubuntu-latest`, schedule or dispatch): deletes the dead refs (Orphans and refs).

`macos-26` is pinned, not `macos-latest`: it is closest to the mini's 27, and a silent image move would change
results.

The report stays in maws-app. ci-gate.sh, which runs with its caller's `gh` login, downloads a failed hosted job's
`e2e-<slug>` from the maws-app run its log names, into the same directory as the private run's reports. No job in
either repository needs to read the other's artifacts.

### Admission

`HOSTED_MAC_E2E` starts empty. The candidates are the eligible groups of `CLASS1_E2E` (Placement), `MAC_VM_E2E`'s
first, since they are already proven off the host.

A candidate is admitted when all of these hold:

- three runs under `Lane: hosted` on one MAWS tree are green;
- a `Lane: no-hosted` run on the same tree, on the group's usual desktop, is green, or red on the same named
  baseline;
- each hosted run's count lines (passed, skipped, flaky) equal the baseline's. A group that skips on the hosted Mac
  what it runs on the mini is not admitted;
- its specs do not read the display's scale or its pixels. M3 searches each candidate's specs, and the e2e support
  files they import, for `devicePixelRatio`, `deviceScaleFactor`, `backingScaleFactor`, `scaleFactor`,
  `toHaveScreenshot`, `toMatchSnapshot`, `capturePage`, `toBitmap`, `PNG.sync` and `pngjs`. A group with a hit stays
  off the list, with the hits named, unless the architect rules each hit scale-neutral (most are colour samples, but
  a green run at 1x does not settle it). Splitting the
  scale-reading specs into a group of their own is later work for the architect.

Groups are admitted in waves, and the architect lands each wave with its run ids. Also:

- **`MAC_SECRET_E2E`**: a new list of the groups that need a credential or the login keychain's custody. They never
  go hosted. It starts with `connectors-oauth` and `discover`; Discover's custody conditions (a), (b) and (c) stand.
- **Loosened bounds**: a group whose bound needs loosening on the hosted Mac uses `latency-budget.ts`'s load policy,
  named in its spec, as the guest's did.
- **Rollback**: emptying `HOSTED_MAC_E2E` puts every group back on the mini at once.
- **The other direction**: `Lane: no-hosted` keeps every group of one run on the mini, for diagnosis.

### Capacity and cost

- **Hosted Macs**: 5 at once for the account, shared with cua's hosted-macOS gates. cua is a light user: 6 runs from
  10-24 to 10-26.
- **The queue moves, it does not vanish.** A set with about 25 hosted groups is five rounds of 5 hosted jobs; at the
  spike's 6 to 14 minutes a job that is 30 to 70 minutes, and two sets at once double it. The 95-minute deadline
  bounds a waiter's wait; a deadline red says so (step 5). M4 measures the hosted queue. If deadline reds show up,
  the next lever is a fallback to the mini for a group whose request has not started, which is not in this design.
- **Spike timings** (test minutes, hosted against the mini host): document-app 2.5 against 2.1, transcript 5.1
  against 5.0, presentations 6.6 against 3.6, browser-chrome 1.4 against 1.0, connectors 3.9 against 3.9.
- **Per-job overhead**: about 2.3 minutes of cold setup (pnpm install, poppler, the LibreOffice cask, the engine) and
  about 1.5 minutes of build. No cache cuts it (Decision Log, M1). The build stays per job, because
  sharing it would need a token to read the private run's artifact.
- **Cost**: the hosted Macs and maws-app's Linux jobs are free. The waiters cost the pool's cpus-2 spot rate.

## Plan of Work

Constraints that bind every milestone:

- MAWS changes land as pull requests the architect merges, with a class 1a static gate before the push for lane files
  (gate-offload Decision Log 57). The wiring's landing gets gate-offload Decision Log 106 from the architect. The
  executor reports to CI-opt, who talks to the architect.
- ci-kit's code is not changed: the waiter runs on the pool as any job does. M4's collector is a file beside this spec.
- The deploy key and the `MAWS_APP_DEPLOY_KEY` secret are made by CI-opt with the owner's `gh` login, when M2's proof
  needs them; the executor asks. The private key is written only to the secret, never printed or kept on disk beyond
  the command that sets it.
- Nothing runs the gates' commands on the owner's MacBook. A focused test file is fine (`node --test <file>`).
- The gate scripts' tests are `node:test` files beside the script (`.github/scripts/*.test.mjs`,
  `scripts/*.test.mjs`); static runs them all (`gate.yml`, the `gate-scripts` check).
- Every commit and PR body ends with `Sminos-Session: CI-opt#a45b97a3 (doperpowers on macbook)`; no Co-Authored-By.

### M1 — MAWS: the filter, the overlay and the hosted Mac setup

At its end, a MAWS commit can be turned into a maws-app tree by a script in MAWS, and the public half works: a request
pushed by hand runs its group and writes its result; a cancel cancels; a stale request stops at once.

Touches:

- `.github/scripts/maws-app-tree.sh` (new): the filter (What the filter leaves out). The spike's
  `/tmp/ci-analysis/maws-app/export.sh` is a starting point while it exists; this spec is the contract. Usage
  `maws-app-tree.sh <MAWS git dir> <sha> <empty dir>`.
- `.github/maws-app/README.md` and `.github/maws-app/hosted-mac.yml` (new): the overlay (The hosted workflow). Start
  from the spike's `README.md` and `.github/workflows/mac-e2e.yml` on maws-app's `main`.
- `.github/actions/setup/action.yml`: the hosted macOS display step and the desktop line.
- `.github/scripts/maws-app-tree.test.mjs` (new).
- `.github/scripts/maws-app-scan.sh`, `.github/maws-app/gitleaks.toml` and `.github/scripts/maws-app-scan.test.mjs`
  (new): the secret scan. The allowlist is built from a full scan of the current filtered tree.
- The four SHOTS and EVIDENCE writers, if one of them lacks a recursive mkdir.
- On maws-app, by hand: `main` moved to the v2 tree of M1's branch head (a commit with the current `main` as
  parent), after a full-tree scan of it comes back clean, so the schedule runs the overlay's sweep; a ruleset on `main` that blocks deletion and non-fast-forward pushes.

Does not touch: `gate.yml`'s jobs or lists, `gate-plan.mjs`, `ci-gate.sh`.

Proves: acceptance 5 and 6, and the public half by hand (Concrete Steps). The tests pin:

- two exports of one sha are byte-identical;
- every excluded path is absent, `p1-e8/g0-cli-probe.txt` is present, and `.github/maws-app/` is absent;
- none of the four addresses remains;
- `.github/workflows/` holds exactly `hosted-mac.yml`, and `README.md` is the overlay's;
- `hosted-mac.yml` has no `secrets.` reference and no `pull_request` trigger;
- the scan: a planted fake token (a well-formed GitHub token, an AWS key, a private key block) is found and exits 1
  with its file and rule and without the value; the current filtered tree scans clean; a scanner that cannot be
  downloaded or verified exits 1.

### M2 — MAWS: the routing, the waiter and the readers

At its end, `--lane hosted` on a macOS run sends the run's eligible groups to the hosted Macs. Each one is a private
job named `e2e:<group>` whose verdict is the hosted job's.

Touches:

- `gate.yml`: the lists `HOSTED_MAC_E2E` (empty) and `MAC_SECRET_E2E`; the `e2e-hosted` job; the plan's
  `e2e_hosted` output; the workflow_dispatch input `lane` accepting `hosted` and `no-hosted`, its description
  updated.
- `.github/scripts/gate-plan.mjs` and its tests: Placement, exactly.
- `.github/scripts/hosted-mac.sh` (new) and `.github/scripts/hosted-mac.test.mjs` (new): the waiter (The flow of one
  hosted group, steps 2, 4, 5, 6).
- `scripts/ci-gate.sh`: `--lane hosted|no-hosted`, into the `Lane:` trailer; the hosted report download (The hosted
  workflow, last paragraph).
- `scripts/ci-gate-alerts.mjs` and its tests: a run's Mac jobs are the jobs its plan, at the target sha, places on a
  Mac. A run whose every e2e group is hosted has no Mac e2e job, so a mini alert does not stop it; `guestRun` tells
  "no Mac job" from "needs the host".
- `scripts/ci-gate-pool-demand.mjs`'s tests: a hosted entry counts one cpus-2 box (the code reads `e2e` entries
  already).
- The deploy key on maws-app (write access, title `maws-hosted-mac`) and the `MAWS_APP_DEPLOY_KEY` secret on MAWS,
  by CI-opt.

Does not touch: the mini's lanes, `MAC_VM_E2E`, ci-kit.

Proves: acceptance 1–4, 6's scratch-token case, and 7. The tests pin:

- gate-plan: a listed eligible group is hosted on a macOS lane and never on a Linux lane; `Lane: hosted` hosts every
  eligible group of the run, with `--gates all`'s set as one case; `default`, a measured, a live, a secret and a
  `POOL_E2E` group (desk-web) stay where they are under `Lane: hosted`, named in the summary; a list naming one of
  them is refused; `Lane: no-hosted` hosts none and places the rest exactly as a run before this work; `Lane: vm`
  with a group on both lists sends it to the guest; a live run hosts none; a hosted entry is in `e2e` and
  `e2e_hosted`, not in `e2e_host`, `e2e_vm` or `e2e_build`; `pool` is true for a run whose only pool job is a waiter;
- the waiter, against a local bare repository as maws-app (`MAWS_APP_REMOTE`) with a fake result commit: the request's
  tree equals the filter's and its trailers are those of Provenance; `success` exits 0 and `failure` 1, with both refs
  deleted; a result whose parent is not the request is ignored; the deadline prints its line, pushes a cancel and
  exits 1; `--cleanup` after a push with no result pushes a cancel; an attempt-2 waiter cancels attempt 1's request;
  a scan finding pushes nothing and exits 1; the main refresh fast-forwards only, and only for a requested commit on
  master;
- ci-gate-alerts: a hosted-only run proceeds past a mini alert; a run with one hosted and one host group stops;
- ci-gate.sh's `--lane` accepts the two new values.

### M3 — Admission waves

Starts from MAWS master with M2 landed and the deploy key in place. At its end, `HOSTED_MAC_E2E` holds every
candidate that passed, and a default macOS run sends them to the hosted Macs.

The work:

- List the candidates (Admission): `CLASS1_E2E`'s eligible groups, `MAC_VM_E2E`'s first. Run the scale search on each
  and set aside the groups with hits, with their hits, for the architect.
- Run the rest in waves of up to 5 groups: three `--lane hosted` runs per wave on one MAWS tree (Concrete Steps),
  and one `--lane no-hosted` baseline on the same tree. Reuse a green baseline of the same tree when one exists.
  Record each baseline job's runner (host or guest).
- Compare each hosted run's count lines with the baseline's (Admission).
- Record each wave's run ids, verdicts and set-asides in this spec's Decision Log, and open the list change as a MAWS
  PR, each admitted group with its 3 run ids in a gate.yml comment. The architect lands it.
- A group that fails for the 1x display, the 3 CPUs or the 7 GiB stays off the list, with the failure named.

Proves: acceptance 8.

### M4 — Measurement

At its end, the effect is measured.

- **The collector**: `docs/doperpowers/specs/2026-10-26-maws-hosted-mac/measure.py` in ci-kit, beside this spec;
  Python 3 standard library and the caller's `gh`. `measure.py --since <UTC> --until <UTC>` reads MAWS's `gate.yml`
  runs and maws-app's `hosted-mac.yml` runs in the window, their jobs, and prints, and writes as JSON:
  - **Mac queue**: for MAWS jobs on a `ci-kit-mac-*` runner, `started_at` minus `created_at`: median and p90;
  - **hosted share**: maws-app `e2e` job minutes (`completed_at` minus `started_at`, jobs that ran) over those plus
    MAWS's `e2e:*` job minutes on `ci-kit-mac-*` runners. Waiter minutes are counted in neither;
  - **hosted queue**: maws-app `e2e` jobs' `started_at` minus `created_at`: median and p90;
  - **waiters**: their job minutes, times the cpus-2 spot rate; and the count of `hosted: no result by` reds.
- **Before**: the 7 days before M3's first wave lands, run by the executor at the end of M3.
- **After**: the 7 days after it lands, run by CI-opt on the eighth day.
- **The record**: both outputs in Outcomes & Retrospective.

Proves: acceptance 9.

## Concrete Steps

From a MAWS worktree on the milestone's branch:

    .github/scripts/maws-app-tree.sh "$(git rev-parse --absolute-git-dir)" HEAD /tmp/maws-app-tree-a   # prints v2
    .github/scripts/maws-app-tree.sh "$(git rev-parse --absolute-git-dir)" HEAD /tmp/maws-app-tree-b
    diff -rq /tmp/maws-app-tree-a /tmp/maws-app-tree-b && echo deterministic
    node --test .github/scripts/maws-app-tree.test.mjs

M1's public half by hand, with the owner's `gh` login over HTTPS (the deploy key comes in M2). From a filtered tree of
the branch head, in a fresh `GIT_DIR`, commit with `main` as parent and the trailers of Provenance, `MAWS-Run: m1/1`,
`Hosted-Group: document-app`, `Hosted-Script: e2e:document-app`, `Hosted-Slug: document-app`,
`Hosted-LibreOffice: false`, `Hosted-Evidence: false`, and a deadline an hour ahead. Then:

    git push https://github.com/SSFSKIM/maws-app.git HEAD:refs/heads/ci/hosted/m1-1-document-app
    gh run list -R SSFSKIM/maws-app -w hosted-mac.yml --branch ci/hosted/m1-1-document-app   # completed success
    git ls-remote https://github.com/SSFSKIM/maws-app.git refs/heads/ci/result/m1-1-document-app
    # the result's message: hosted: success e2e:document-app, with Hosted-Run and the count lines

Then the cancel: push a second request (`m1-2-transcript`), and while its e2e job is queued or running, push a commit
over it with the same tree, the request as parent and `Hosted-Cancel: m1 proof`. The request's run ends `cancelled`;
the cancel's run plans nothing. A third request whose ref is overwritten by a cancel before its e2e job starts stops
at the stale guard, with no setup, build or test step run. Then the stale guard: a request whose `Hosted-Deadline` is in the past ends its e2e
job within a minute with `hosted: stale request`. Then the sweep, by dispatch, deletes the refs older than 6 hours
(none of these yet; dispatch it once to see it run green), and delete the proof refs by hand.

M2's proof, from the MAWS worktree:

    scripts/ci-gate.sh HEAD --gates e2e:document-app,e2e:transcript --runner macos --lane hosted
    # PASS e2e:document-app … PASS e2e:transcript … ci-gate: run <id> success

M3's wave, from a worktree of MAWS master:

    scripts/ci-gate.sh HEAD --gates e2e:<g1>,…,e2e:<g5> --runner macos --lane hosted     # three times
    scripts/ci-gate.sh HEAD --gates e2e:<g1>,…,e2e:<g5> --runner macos --lane no-hosted  # the baseline

## Acceptance

1. `scripts/ci-gate.sh <sha> --gates e2e:document-app,e2e:transcript --runner macos --lane hosted` ends with
   `ci-gate: run <id> success`. Each `e2e:` job of that run ran on a `ci-kit-pool` runner, and its log prints the
   request and `hosted: success <maws-app run URL>`. Each request's `MAWS-Source` is the run's head commit, whose
   first parent is `<sha>`; its `MAWS-Source-Tree` is `<sha>`'s tree; its `Hosted-Group` is the group. Each hosted
   job's log has a `ci-kit desktop:` line with `display 1920x1080@1x`. No `ci/hosted/` or `ci/result/` ref of that
   run is left on maws-app.
2. A hosted group that fails makes its private `e2e:<group>` job fail. ci-gate prints RED with that group, the
   failed test's name in its log tail, and the hosted report under its reports directory. Prove it with a scratch
   commit that breaks one assertion of a hosted group's spec.
3. Rerunning that failed private job (`gh run rerun <id> --job <job id>`) makes a new request (attempt 2) and a new
   hosted run on the same `MAWS-Source`, which fails the same way. Reverting the assertion in a new commit and
   launching a new `ci-gate.sh` on it gives green.
4. Cancelling a private run while its waiter waits ends the hosted run `cancelled` within 2 minutes.
5. The architect's recompute: the filter, run on a request's `MAWS-Source`, gives a tree whose `git write-tree`
   equals the request's tree.
6. No pushed request contains `research/`, `.smns`, a workflow other than `hosted-mac.yml`, a
   `docs/doperpowers/evidence/` file other than `p1-e8/g0-cli-probe.txt`, or any of the four addresses. The M1 test
   pins this, and `git grep` over the acceptance runs' requests shows it. A scratch commit with a planted fake token
   makes its `e2e:<group>` red with `hosted: secret scan refused the push`, the file and the rule, and no request of
   that commit reaches maws-app.
7. maws-app's workflow has no `secrets.` reference and no `pull_request` trigger;
   `gh api repos/SSFSKIM/maws-app/actions/permissions/fork-pr-contributor-approval` answers
   `all_external_contributors`; `gh api repos/SSFSKIM/maws-app/actions/runners` lists none; the deploy key is the
   only key on maws-app; `main`'s ruleset blocks deletion and non-fast-forward pushes.
8. After M3, a default macOS run (`--runner macos`, no `Lane:`) runs the admitted groups as waiters and the rest on
   the mini. `HOSTED_MAC_E2E` names exactly the admitted groups, each with its 3 run ids in a gate.yml comment; the
   set-asides are in the Decision Log with their reasons.
9. M4's numbers are in Outcomes & Retrospective: the Mac queue median and p90 before and after, the hosted share of
   e2e job-minutes, the hosted queue, and the waiter cost.

## Verification

- **This spec**: one `doperpowers:adversarial-reviewer` pass on the whole document, and one on the execution
  section's buildability (the spec has more than one milestone). Round 1 done (Decision Log).
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
  pushes the tree itself, so a rerun of the private job is a fresh hosted run. Rejected: ci-gate reading two runs,
  which would leave a UI-dispatched private run green whatever the hosted result and would need changes to the
  job-list readers (alerts, refusals, `DefaultBeside`). Also rejected: `ubuntu-slim` waiters, at about three times
  the pool's cost for the same wait.
- 2026-10-26 (CI-opt): `macos-26` is pinned, and the display is 1920x1080@1x, set in setup.
- 2026-10-26 (CI-opt): the out/ build stays in each hosted job. Sharing the private run's e2e-build artifact would
  need a cross-repository token, and the build costs about 1.5 minutes of free hosted time.
- 2026-10-26 review round 1 (CI-opt, on two adversarial reviews):
  - **The control plane is git refs.** The first draft read the hosted run through the REST API with MAWS's
    `GITHUB_TOKEN` and cancelled it there. That token is scoped to MAWS: it cannot cancel a maws-app run, and an
    unauthenticated read of maws-app's artifact and log archives was refused (401, 403). A deploy key is git access,
    not API access. Now the result comes back as a commit maws-app's own token writes, a cancel is a push through the
    workflow's concurrency group, and the report download moves to ci-gate.sh, which has the caller's login. Rejected:
    a GitHub App or a fine-grained token on maws-app, stored in MAWS. It works, but it is a second credential, it
    needs the owner in the browser to create it, and the API's rate limit would be shared by 25 polling waiters.
  - **Orphans have owners**: the cleanup step, the next attempt, the stale guard and the sweep (Orphans and refs).
    The first draft assumed the waiter's exit paths covered them; a preempted box runs none.
  - **`default`, `POOL_E2E` and live runs are never hosted.** `default`'s job builds and derives its specs from the
    whole run; that contract does not cross. The lane table replaces "named under `Lane: hosted`".
  - **The filter drops all of `.github/workflows/`**, so a branch's new workflow cannot run on maws-app's push. The
    overlay maps to explicit destinations; the first draft's directory copy would have put the workflow at
    `workflows/` and nothing would have run.
  - **The plan entry crosses as trailers** (`Hosted-Script`, `-Slug`, `-LibreOffice`, `-Evidence`), so the hosted
    job runs the script the private job would, not `e2e:<group>` by name.
  - **Three readers change**: the alert preflight (it counted every macOS e2e group as a Mac job and stopped a
    hosted-only run on a mini alert, reproduced), the pool-demand hint (tests only), the report download.
  - **Admission's 1x rule**: green at 1x is portability, not coverage; groups whose specs read the scale stay off.
    Count lines must match the baseline, so hosted skips cannot pass for green.
  - **Acceptance 3** proves the rerun on the same commit and the fix through a new run: a rerun keeps the run's sha.
  - **Provenance**: `MAWS-Source` is the run's commit (ci-gate's nonce commit), and its tree is the requested sha's.
  - **The main refresh**: the waiter fast-forwards `main` once it is a day old, so each push sends only a day's
    changed blobs, and the schedule runs a current sweep. `main`'s ruleset makes a fast-forward the only update.
  - **M4's collector** is a file beside this spec and reads both repositories; the after numbers are CI-opt's, on
    the eighth day, since an executor does not wait a week.
  - **M3's candidates** widen from `MAC_VM_E2E` to every eligible `CLASS1_E2E` group, `MAC_VM_E2E` first: the hosted
    Mac has 7 GiB and builds its own out/, so the guest's two limits (4 GiB, out/ from e2e-build) do not apply.
  - Round 2 (one adversarial review): the stale guard also checks that the request's ref still points at the run's
    commit. GitHub's concurrency ordering follows arrival at the group, which is not guaranteed to be push order, so
    a cancel could be processed before its request; the request then started with a future deadline.
  - Not taken: a fallback to the mini for a request that has not started by a bound. It is the next lever if M4 shows
    deadline reds (Capacity and cost).

- 2026-10-26 (architect, on 32aa029, all taken):
  - **A secret scan before every push**, failing closed (The secret scan). Publishing every gated branch commit
    turns an accidentally committed token from a private leak into a public one.
  - **`main` refreshes only from landed work**: the first draft let any request, branch work included, become `main`,
    whose overlay the schedule runs and whose tree the world reads first. Rejected: refreshing only when the requested
    commit is master's tip, which a gate run before landing never is, so `main` would rarely move.
  - **The pixel terms** `capturePage`, `toBitmap`, `PNG.sync` and `pngjs` join the scale search; they appear in
    dashboard, dashboard-export, deliverables, design-export, library, presentations, presentations-export and
    terminal.
  - Deferred to the debt list: count-line equality is checked at admission only. A hosted group that later starts
    skipping on the 3-CPU, 1x box (a hardware-dependent skip) would stay green; a later check (ci-gate comparing a
    hosted job's skipped count with the mini's last run of the group) would catch it.

- 2026-10-26 (executor, M1, on MAWS 24eb6903a; CI-opt's revisions in place):
  - **A request's tree is the filter's output added with `git add -A --force`** (Provenance revised): MAWS tracks 175
    files its own `.gitignore` matches (`spikes/p3-store/s1/out/*` and the like), which `-A` drops in a fresh
    repository. The spike's 648b7e88 lacks them for that reason.
  - **Concrete Steps pass `--absolute-git-dir`**, not `--git-common-dir`: from a worktree the common dir resolves
    `HEAD` in the main checkout. The filter resolves `<sha>` to a commit once, at its start.
  - **The redaction works on bytes, in every file** (revised from text I/O with `newline=''`), so a non-UTF-8 file is
    redacted too. Today the 11 files that hold an address are all text.
  - **The desktop line reads `NSScreen.mainScreen`**, and setup fails on any display other than 1920x1080@1x, so a
    hosted result is a property of the group, as the architect asked.
  - **The result body** is the count lines and Playwright's numbered failure lines, at most 100; when the stale guard
    fired, its line.
  - **Nothing in the scanned tree can quiet the scan**: inline `gitleaks:allow` and a `.gitleaksignore` in the tree
    are not honoured, and `--config` takes precedence over a `.gitleaks.toml` there.
  - **The allowlist**: 8 entries cover the full scan's 3,413 findings in 78 files, all false positives (2,745 message
    ids, 600 catalog-fixture keys, saved third-party pages, desk-hub vectors, RFC sample values, test fakes, a pinned
    digest). Exact values for test fakes, so a real secret beside one is still found; shapes or paths for recurring
    kinds.
  - **No cache on the hosted Macs** (revised; review of M1, CI-opt): GitHub restores a cache only from the run's own
    branch or the default branch, and every request is a fresh `ci/hosted/` branch, so nothing a job saved could be
    read again. The executor's `warm` job seeded `main`'s caches on the schedule; with both caches hit, setup took
    111 s against 99 s cold (plus a 22 s cold save), so it bought nothing and cost a hosted Mac four times a day. Both
    the job and the hosted-macOS cache lines were dropped. The setup's time is brew and the LibreOffice cask, in
    ci-kit's setup.
  - **The secret scan publishes nothing it did not scan** (review of M1): gitleaks' `useDefault` also brings its
    global path allowlist, which skips `pnpm-lock.yaml`; a path-wide allowlist entry would let any new key beside
    a known one pass. Every published file is scanned, and allowlist entries are values or value shapes, a path only
    as an extra constraint.
  - **The filter reads only git objects**: an overlay file that is a symlink would have copied a host file into the
    tree. The overlay, the redaction and the scan never follow a symlink out of the export.
  - Proof requests carry no `Sminos-Session` trailer: they are protocol commits shaped as the waiter's. `main`'s
    commit carries it.

- 2026-10-26 (executor, M4's collector, 455a87d and 72c24a3, reviewed clean):
  - A Mac job is one whose runner name starts with `ci-kit-mac-` (host and guest). A waiter is an `e2e:*` job whose
    labels are exactly `self-hosted`, `ci-kit-pool`, `cpus-2`: no other e2e job asks for cpus-2 today (desk-web is
    cpus-4), and if one ever does, the rule needs the hosted entry's own mark.
  - A job counts in the window it was created in. Runs are listed 30 days back (GitHub's rerun limit) and their jobs
    fetched (`filter=all`) only when the run's `updated_at` is in or after the window, so a rerun of an older run
    counts: on 10-25 that was 8 jobs from 3 earlier runs. p90 is nearest-rank. The window should be closed (its runs
    finished) when measured.
  - The waiter cost is job minutes times the rate, as M4 says; the pool bills a box's whole life, so it is a floor.

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
- **Public is not open** (review round 1): on a public repository, a run's and a job's metadata read without a
  token, but an artifact's download answered 401 and a run's log archive 403. GitHub's `GITHUB_TOKEN` is scoped to
  its own repository whatever the other's visibility.
- **The pool image has no `gh`** (ci-kit `pool/image/Dockerfile`; the actions-runner base installs git, curl and jq).
  The waiter needs none: git, ssh, python3 and jq.
- **M1's public half** (maws-app runs 40272084391 request green, 20 passed at `display 1920x1080@1x`;
  40272130960/40272211679 cancel; 40272348101 ref deleted before start, stale guard in 6 s; 40272478183/40272483081
  cancel 2 s after its request, cancelled during `plan`; 40272484704 past deadline, stale in 4 s; 40273379322 sweep by
  dispatch): `main` is 7beb2bfd, the v2 tree of MAWS 1f7c9581d with parent 4520bbab, moved after a clean full-tree
  scan; ruleset 25857219 on `main` (deletion, non-fast-forward, no bypass), checked through the API only.
  - **Deleting a `ci/hosted/` ref starts no run**, so the waiter's two-ref delete is inert.
  - **A cancelled request still writes a result**: `result`'s `always()` runs on a run concurrency cancelled, even one
    cancelled during `plan`. The waiter's cleanup deletes a `ci/result/<suffix>` that appears after its cancel; the
    sweep takes any it misses.
  - **The hosted Mac queue was seconds** on 10-26: each e2e job started 3 to 5 s after `plan`.
  - **gitleaks' default rules pass an obviously fake PAT** (a repeated pattern); random ones are found. Tests and
    acceptance 6's scratch token use random values.
  - **A `git` call in the waiter's `--filter=blob:none` git dir lazily fetches** a missing object from maws-app, and a
    MAWS sha there fails `not our ref`: the waiter keeps its MAWS-side git calls out of that `GIT_DIR`.
  - **ci-kit's setup installs the LibreOffice cask on every macOS job**, `Hosted-LibreOffice` or not (the input is
    Linux-only); it is part of the setup's brew time, and only ci-kit could skip it.
- **`gh api` withholds a job log that holds terminal escapes** unless given `--allow-escape-sequences`; M4's collector
  passes it, or no `hosted: no result by` red could be read. The collector over all of 10-25: 383 Mac jobs, queue
  median 26.6 and p90 94.6 minutes, 1,082 Mac e2e job-minutes, in line with Purpose.

## Outcomes & Retrospective

(At M4.)
