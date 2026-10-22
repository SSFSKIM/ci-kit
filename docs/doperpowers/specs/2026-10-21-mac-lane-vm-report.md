# Mac lane concurrency, the VM lane: executor's report

The executor's account of the VM lane's milestones of
[the living spec](2026-10-21-mac-lane-concurrency-design.md) (V1–V5), for CI-opt, the session that owns the spec and
books the Mac mini. The spec is the source of truth: its Progress, Decision Log, Surprises & Discoveries and
Outcomes carry every decision; this report is the run's record and what comes next.

## Where it stands (2026-10-22 08:45Z)

| Milestone | State |
|---|---|
| V1, the second spike | Run 07:05–08:29Z 10-22, inside CI-opt's window (hard end 10:05:32Z). **Verdict: a partial go at 4096 MB, with the build moved out of the guest and `CI_KIT_VM_MEMORY_FLOOR` raised from 37 to 60.** Details are under "V1: the second spike". |
| V2, ci-kit: the lane | Merged: #89 (722d8e4). |
| V3, MAWS | Landed: MAWS #110, merge 64483a63d. |
| V4, install, trials, verdict | Preparation done, with no mini window: ci-kit PR (branch `vm-lane-v4-prep`) and MAWS #122, both reviewed and not merged. Details are under "V4's preparation". The install window comes next. |
| V5 | Not started. |

In V1's window the mini was used only from one-shot gui-session LaunchAgents (`v1-spike.sh launch <phase>`). No
osascript ran, no dialog was touched and no password prompt appeared. The mini was left as described in "V1: the end
state".

## V4's preparation (2026-10-22, no mini window)

The design change: out/ is built on the pool. It was decided by CI-opt with the MAWS architect and is recorded in the
spec's Decision Log.

- **MAWS #122** (https://github.com/SSFSKIM/MAWS/pull/122, branch `gate-vm-e2e-build`, for the architect to land):
  - `e2e-build.sh` gains `MAWS_E2E_BUILD_REQUIRE=1`;
  - the plan gains the outputs `e2e_host`, `e2e_vm`, `e2e_build` and `e2e_build_runner`;
  - `gate.yml` gains an `e2e-build` pool job and an `e2e-vm` job that shares `e2e`'s steps through YAML anchors;
  - the refusal relaunch never names `e2e-build (…)`.

  Evidence:
  - With MAC_VM_E2E empty the plan is unchanged apart from the added outputs.
  - Class 1a was green on the pool: runs 39751617140 and 39756283200, the second at the head.
  - reviewer-medium: one P2, fixed, then clean.
- **The proof (the architect's condition 1).** At scratch sha 5b18dfc0, the pool's out/ (run 39752104205; its two e2e
  jobs queued on [ci-kit-mac-vm] and were cancelled unrun at 09:03:49Z) was compared with a MacBook build:
  - plain: 855/855 files; harness: 1078/1078;
  - the only difference is `builtAt` in out/main/index.js (6 and 5 bytes);
  - the artifacts and the diff are in `/tmp/maws-e2e-proof/` on the MacBook.
- **ci-kit** (branch `vm-lane-v4-prep`, this branch):
  - displayplacer in the bake, with the boot check and the new `out/unfit` marker;
  - the disk at 60 GB, with the recovery container removed and the layout checked first;
  - the floor at 60, and `--memory` refused under 4096.

  Evidence: ci-gate green (runs 39753049588 and 39757552408); reviewer-medium found three P2s, all fixed; the
  re-review is clean.

**Unverified until the install window:**
- removing the recovery container from the running system;
- the real `e2e-vm` job's download and restore;
- the display check right after login: it reads the mode once, with no retry.

The V8 code-cache experiment is in V4 step 3.

## V1: the second spike

The script is `~/Developer/ci-analysis/v1-spike.sh` on the MacBook (copied to `~/ci-vm-spike/` on the mini). The
mini's logs are in `~/Library/Logs/ci-kit/v1-*.log`, with copies in `~/Developer/ci-analysis/v1-logs/` on the
MacBook. Every phase ran from a one-shot LaunchAgent in the mini's GUI session. The host sampler read
`kern.memorystatus_vm_pressure_level`, `kern.memorystatus_level`, `vm.swapusage` and the load every ~17 s; a guest
sampler read the same three every ~16 s through `tart exec`. All three reads work on macOS 27.

### Verdict

**A partial go at 4096 MB, with `CI_KIT_VM_MEMORY_FLOOR` at 60.** It holds on three conditions, which V4 builds
first:

1. The guest does not run `electron-vite build`. The out/ build happens outside the guest, and the guest restores it
   through MAWS's existing `MAWS_E2E_BUILD_CACHE` / `MAWS_E2E_BUILD_KEY` path in `scripts/e2e-build.sh`.
2. The bake sets the display mode inside the guest.
3. The guest's disk grows.

A 3 GB guest cannot be tested: the image refuses anything under 4 GiB. A 4 GB guest that builds for itself fails.

| Criterion (spec V1) | 4 GB, guest builds (no flags) | 4 GB, heap raised to 3072 MB | 4 GB, out/ prebuilt on the host (no flags) |
|---|---|---|---|
| 3/3 green, both groups | document-app 4/5 (run 1: one `firstWindow` 30 s timeout); **widgets 0/4** (the V8 heap runs out in the build, exit 134) | widgets 2/3 (run 3: ENOSPC, the guest disk full); document-app not run | **document-app 2/2, widgets 2/2** |
| Warm run ≤ 1.5x host step median (document-app 113 s, so ≤ 170 s) | 194–299 s: unmet | widgets 216–244 s | document-app 191 s (the first run of the clone), **163 s**; widgets 124, 140 s |
| Host pressure 1, swap growth ≤ 100 MB across the runs | met: pressure 1 throughout, swap 646.5 → 638.5 MB | met | met (until the surge, below) |
| Display 2560x1440 at 2x | met once `displayplacer` set the mode in the candidate (below) | met | met |
| Boot to agent < 60 s | 28–35 s | 35 s | 33 s |

The criteria are met with the build moved out, but narrowly. The warm document-app run is 163 s against 170 s; the
widgets ratio is unknown, because V1 has no host widgets step median. The prebuilt runs' tests were also slower than
the self-built runs' tests, which is not explained (under "Open"). V4's trials are the real test.

If the build cannot move out of the guest, 4 GB is a no-go. The sized question for the owner is then 5 or 6 GB; the
headroom figures are under "The host".

### What was measured

- **Tart.** 2.40.1. `brew upgrade tart` was a no-op: nothing newer is in the openai/tools tap.
- **The image's minimum.** The macOS 27 golden-gate base refuses `tart set --memory 3072` with
  `LessThanMinimalResourcesError: VM should have 4294967296 bytes of memory at minimum (requested 3221225472)`. That
  is why only 4 GB was tested, within the owner's ruling.
- **The bake.** The candidate `maws-vm-v1-cand-4g` was baked with cpu 4, 4096 MB and `--display 2560x1440pt`.
  - The guest came up in 28 s and was provisioned in 202 s.
  - It has node v22.23.3 (`node@22`, keg-only beside a linked `node@24`), pnpm 12.14.0 through corepack, a warm
    store, the LibreOffice cask, `swiftc` and `/opt/homebrew/bin/python3`.
  - The guest's disk has only **about 2.5 GiB free** (41 Gi container, 84 % used).
- **The display.** `tart set --display 2560x1440pt` is accepted but does not take.
  - Electron in a `--no-graphics` clone booted from the GUI session read `1024x768`, `scaleFactor` 2. The 10-21
    spike saw the same.
  - `displayplacer` (brew `jakehilborn/jakehilborn/displayplacer`) in the guest lists mode 25,
    `res:2560x1440 scaling:on`. Setting it gives Electron `2560x1440` at 2.
  - The mode set in the candidate persists into every clone.
- **The job clone.** Boot to agent 28–35 s. Setup (a clone of the read-only share plus a warm
  `pnpm install --frozen-lockfile`) took 18–21 s.
- **Why the build fails in the guest.** V8 sizes its default old-space heap from physical memory, about a quarter of
  it, so about 1 GB in a 4 GB guest; a 16 GB host gets the full 4 GB.
  - widgets' harness build exceeds that heap and aborts (`Ineffective mark-compacts near heap limit`, exit 134).
  - document-app's build fits, but its client step takes 2 min 8 s in the guest against 40.7 s on the host.
  - With `NODE_OPTIONS=--max-old-space-size=3072` the widgets build passes. It takes 1 min 59 s and pushes the guest
    to 831–890 MB of swap.
- **Where the guest's pressure falls** (CI-opt's question (b)). It falls in the build. Every pressure-2 sample of
  the self-built runs is in the build phase: 35 across the nine runs with no flags and 22 across the three with the
  heap raised. Their test phases saw none, 0 of 33 and 0 of 11.
  - The guest's swap grows only during builds, up to 533 MB.
  - With out/ prebuilt, the guest reached pressure 2 in only 4 of 35 test-phase samples (runs 3–4, the first beside
    the host surge), and its swap stayed at 14.9 MB.
- **document-app run 1's failure** was in the test phase: `electronApplication.firstWindow` timed out after 30 s on
  the export test (`document.spec.ts:270`). The guest was at pressure 1 then, with 46 % or more available, but held
  304 MB of swap from the build just before. My 08:01Z checkpoint said it failed under pressure 2; that was wrong.
- **The disk.** One clone running three heap-raised builds filled the guest's disk to 215 MiB free, and the third
  build failed with ENOSPC. In the lane each job gets a fresh clone, but a job that runs several groups builds and
  writes several times.
- **TCC, SIP, AX** (read-only, from a clone).
  - `csrutil status`: disabled.
  - The system TCC.db pre-grants Accessibility, ScreenCapture, PostEvent and (for some) AppleEvents to:
    - `tart-guest-agent` (0.15.0), and through it every process `tart exec` starts;
    - `/usr/bin/osascript`;
    - `org.python.python`;
    - `/usr/libexec/sshd-keygen-wrapper`.

    The same TCC.db denies `kTCCServiceDeveloperTool` to Terminal.
  - There is no per-user TCC.db.
  - `AXIsProcessTrusted` is True from a `tart exec`'d python3.

### The host

- **The mini**: 16 GiB (17179869184 bytes), 10 CPUs. Host node on `/opt/homebrew/bin` is v26, which has no corepack;
  `/usr/local/bin` has node v22.18.0 and pnpm 11.23.0, which the host runs used.
- **Available memory by load** (the kernel's available %):

  | Host state | Available % |
  |---|---|
  | No VM | 79–81 (66 at 07:07Z) |
  | A busy 4 GB guest alone | 73–81 (median 80) |
  | Guest plus host `dashboard-scale` | 57–72 |
  | Guest plus host `dashboard` | 58–74 |
  | Guest plus a 3 GB surge | 53 at the lowest |

  Pressure stayed 1 through all of these.
- **Where pressure 2 begins.** It appeared once, in the accidental 8 GB boot of 07:09Z (the image default, after the
  failed 3 GB `tart set`). Available fell from 66 to 35 in one sample, then read 41 and 41, while swap rose 142 → 1068
  → 1388 MB. Pressure returned to 1 when the VM was stopped at 07:10Z. The warn boundary on this host is therefore at
  about 35–41 % available.
- **The floor: 60.** In lane.sh, `CI_KIT_VM_MEMORY_FLOOR` is the available-% floor for admission. The design's 37 (a
  4 GB guest's 25 % of 16 GB plus 12 points) presumed that the available figure drops by the guest's size. It does
  not: a busy 4 GB guest moved it at most 8 points. The floor matters for two reasons:
  - The guest plus a host e2e job drew up to 24 points. A floor of 60 keeps the host above the 35–41 warn boundary
    even then.
  - A 3 GB surge left 53 % available. A floor of 60 blocks a boot during a surge like that one, the journal-hour case
    the design sized it for; 37 would admit there.

  The owner's evening load was not measured (the window was 07–08Z); V4's trials confirm the floor or move it.
- **The guest's memory size.** That is bake.sh's `--memory`, default 4096 MB, which is already right. It is not
  `CI_KIT_VM_MEMORY_FLOOR`. bake.sh's argument check accepts any 4–5 digit size, so `--memory 3072` fails only at
  `tart set`, with a die that names the failure. Nothing in `lane.sh` or `bake.sh` defaults below 4096.
- **5 or 6 GB** (CI-opt's question (a)), judged from these samples. The 8 GB boot drew 31 points (about 4 per GB);
  the 4 GB guest drew at most 8 points at the steady state.
  - **5 GB**: about 10–20 points. That leaves 46–71 % at the idle range measured, and 37–62 with a host e2e job.
  - **6 GB**: about 12–24 points. That leaves 42–69 % idle; with a host e2e job the low end (33) is at the warn
    boundary.

  Either would need a floor of about 60–65 to keep the margin above.
- **Swap.**
  - Before V1: 142.19 MB (07:07:39Z).
  - The accidental 8 GB boot: up to 1388 MB, reclaimed to 646.5–654.5 MB by 07:15–07:28Z (1364–1388 MB at the
    07:11Z baseline).
  - Across every guest run (07:28–08:21Z): 646.5 → 638.5 MB, so no growth.
  - The first surge did not register. It was a perl string of one repeated byte, which the compressor folds; it was
    rewritten as `os.urandom`.
  - The real surge (08:21:09Z) briefly peaked at 6 GB, because `bytearray(os.urandom(3 GB))` copies once. Swap went
    638.5 → 2465 MB in one sample, then settled at 2209 MB, with available at 53 and pressure 1.
  - At the end (08:28Z): 2081 MB used, pressure 1, available 85 %. That swap was **never reclaimed, not resident
    pressure.** The lane's swap rule compares growth, so stale swap does not block admission.
- **Timed rows beside a busy guest.** `dashboard-scale` on the host met every row but row 4, "replace to all views":
  542, 518 and 524 ms against its 500 ms bound, at loads 3.4–3.7. The spec expected this row red; it is the record.
  Host `dashboard`: 11/11 in 256 s.
- **The host builds** (node 22.18.0): out/ plain in 40 s, harness in 39 s; the cache holds 129 MB for both.
- **Claude.app** relaunched at 07:12:02Z (its process start time; ShipIt), during the bake. Nothing in V1 touched it.

### Open

- **The prebuilt runs' tests were slower.** Each test took about 3–4 s longer with the restored out/ than with the
  guest's own build: document-app 148 s against 88 s summed over 18 matching tests, and widgets 133 s against 90 s.
  That is a per-launch cost, since every test launches Electron. The cause is unknown. Candidates:
  - a fresh clone's first minutes (Spotlight indexing);
  - something in a host-built bundle that a guest build does not have;
  - the guest's memory: 30–38 % available in the prebuilt test phases against 46–56 % in the self-built ones.

  V4's first trial should restore a guest-built out/ in a fresh clone to tell these apart. If the cost goes away,
  document-app drops to about 1.0x the host.
- **No host widgets step median.** V4 reads one from MAWS's gate history.

### V1: what V4 must change

1. **The build moves out of the guest.** The guest runs the e2e group with `MAWS_E2E_BUILD_CACHE` /
   `MAWS_E2E_BUILD_KEY` set to an out/ built elsewhere: by the host, by the pool, or by an earlier step of the same
   job. MAWS's script restores and digest-checks it already. The restore writes `touch "$cache/$key"`, so the guest
   needs a writable copy, not the read-only share (V1 copied it to `~/bcache`, 129 MB). This is a design change to
   the job's shape. It is CI-opt's to decide where the build runs.
2. **The display mode is baked.** `provision.sh` installs `displayplacer` and sets `res:2560x1440 scaling:on`. The
   wrapper reads the mode before a job and refuses on any other.
3. **The disk grows.** `tart set --disk-size` on the candidate, plus the APFS container resize in the guest; neither
   was tried in V1. Otherwise a job that runs more than one group is near ENOSPC.
4. **`CI_KIT_VM_MEMORY_FLOOR` defaults to 60**, in `lane.sh` and its header comment.
5. Optional: `bake.sh` refuses a `--memory` under 4096 with the image's reason, before `tart set`.

### V1: the end state

At 08:28:46Z, 1 h 37 min before the hard end:
- No VM is running.
- The job clones are deleted (`maws-vm-v1-job-4g`, `maws-vm-v1-tcc`).
- Every `ci-kit.v1-spike.*` LaunchAgent is booted out and its plist removed.
- The host sampler is stopped, and the host checkout's `.bcache` is removed.

`tart list` shows the base image (both names), `maws-vm-spike` (from 10-21, as found) and the kept candidate
**`maws-vm-v1-cand-4g`** (41 GB, the chosen size; it carries the display mode). V4's `bake.sh --bake` makes the real
candidate; delete this one then. Nothing was registered, and nothing on the host's runner instances was touched (all
three were disabled by CI-opt for the window).

## V2: what was built

As four tasks (Decision Log, "V2's executor, pre-flight"), each run by a fresh `doperpowers:task-executor` (opus,
high) and reviewed by `doperpowers:task-reviewer` (sol, xhigh) before the next consumed it:

- **V2a, the host side.** `mac/hooks/desktop-lock.sh` (the lock and marker functions, moved out of
  `shared-hold.sh` verbatim); `mac/hooks/vm-claim.sh` (the exclusive hook's classification by the workflow's
  `# ci-kit-vm-contract: 1`, the unknown job's claim and wait, the claims reader); settle's `vm` condition and
  measured claim; `job-completed.sh` dropping a claim. Commits e050559..79d4a4c, 7846444.
- **V2b, the guest.** `mac/vm/guest/`: `kickoff.sh`, `wrapper.sh` (the `out/` protocol, written once in its header;
  the idle handshake's guest side), `diag.sh` (the listener-log patterns, cited to actions/runner v2.338.0),
  `guest.sh`, and the guest hooks (dialog and display refusals, the posture line with `vm=` and `clone=`; no sweep,
  alert or `gh`). Commits 6def22d..945dd45, 76c2680.
- **V2c, the launcher.** `mac/vm/lane.sh`, `lane-reads.sh`, `tart.sh` (shared with `bake.sh`), the LaunchAgent plist,
  and `mac/vm/hold.sh` (the coordinator's holds, under `desktop.lock`). Commits d17ea16..9dbe378, 8f0a698, 9200d6a,
  987edd7.
- **V2d, the procedure and the install.** `mac/vm/bake.sh` (`--bake`, `--register`, `--trial`, `--promote`,
  `--retire`), `mac/vm/provision.sh`, `mac/install.sh --vm` / `--no-vm`, and two `docs/mac-lane.md` sections (the
  lane; the maintenance procedure step by step, with the pasteable `vm_hold` helper). Commits c88d047..2c1b62e.

### Reviews

- Task reviews: V2a one Important (an unreadable claim read as no claim); V2b two Important plus a residue (a known
  assignment forgotten on an unreadable diag log, answers lost on a failed write, a mid-read error read as EOF); V2c
  four Important, then two (a warning killing a just-assigned job, a raced cancellation lost beside `done`, recovery
  able to delete a reserved candidate, the guard paused during blocking work, a failed kickoff overriding an
  assignment, the guard's cadence across a slow read); V2d three Important (retire and promote unserialized, install
  overtaking maintenance, the first-run window on the wrong runtime) and one design gap it found itself (Tart shares
  the clipboard by default: every run now passes `--no-clipboard`). All fixed, each re-reviewed clean.
- Whole branch: `doperpowers:reviewer-medium` (whole diff) and `doperpowers:reviewer-high` (admission, lock,
  recovery). Round 1: five P1s and a P2 (a hold published outside the lock racing the boot; pre-job deadlines
  plain-stopping a clone whose wrapper may run; session recovery ignoring `assigned`; the guard off while recovery
  cannot read Tart; the guest never loading the runner's `.path`; an injectable owner in the docs' ssh line). Round
  2: three residues (a stop by name never retried, `.tmp` owners, the docs' quoting). Round 3: clean.
- Deferred Minor findings, dispositioned: the full-suite flake in `mac-desktop-check` and `mac-install` at load 70+
  (passes alone at origin/main and at the head; logged by the V2c executor in ci-kit's friction tracker #68); the
  SC2030/SC2031 infos in `install.sh` (present at the merge base, left).

### Validation

- `npm test` 1022/1022 at 9200d6a (MacBook); the focused suites at 987edd7: lane, bake and install 142/142.
- ci-gate green at 987edd7: https://github.com/SSFSKIM/ci-kit/actions/runs/39713040812 (and at 7846444, 9200d6a).
- One red ci-gate on the way (bb73364, run 39703182954): a settle test inherited the CI job's own `Runner.Worker` as
  an ancestor; fixed in the test (7846444), `settle.sh` was right.

## V3

MAWS #110: `MAC_VM_E2E` (empty) to `[ci-kit-mac-solo]`, measured groups never routed off the host, `Lane: vm` /
`Lane: vm-trial`, the solo job's +10, `CI_KIT_VM_GUEST=1` and `CI_KIT_VM_LANE=1` as a loaded host, the contract line
and its test (which, after review, catches any raw time bound outside a measured job), the alert reader's `-<n>`
fold (M3's prerequisite) and `-vm` machines. reviewer-medium three rounds; class 1a green; Mac set green
(39684439702); CI-opt rebased it onto 489f591c7, added two gate-plan test commits, and the architect landed it at
64483a63d.

## Next: what CI-opt is asked for

1. **Check V1's verdict** against the design: 4096 MB, the floor at 60, and above all the build moving out of the guest
   (under "V1: what V4 must change", item 1), which changes the job's shape. If the build cannot move, the owner's
   question is 5 or 6 GB (the headroom figures are under "The host").
2. **V4 needs, in order:** V1's changes built (a ci-kit PR, before any install); a window for
   `install.sh --vm` (launcher installed disabled); a maintenance window for the first refresh (bake, the owner's
   first-run step, register with two tokens, a `Lane: vm-trial` scratch commit, trial, promote); then the trial
   windows of V4 steps 3–12.
3. **The owner's first-run step** (V4 step 2, after `--bake`): in the mini's own GUI session over Screen Sharing,
   `tart run --dir=maws:<checkout>:ro <candidate>` in the mini's Terminal; in the guest, open Terminal and
   LibreOffice and answer their first-run prompts; in the guest's Terminal,
   `export PATH="$(cat ~/actions-runner-maws/.path)"`, then
   `git -c safe.directory='*' clone "/Volumes/My Shared Files/maws" ~/maws-firstrun && cd ~/maws-firstrun && pnpm install --frozen-lockfile && pnpm e2e:deliverables`,
   answering Electron's notification prompt as the mini's own setting has it; then
   `cd && rm -rf ~/maws-firstrun && sudo shutdown -h now`. `bake.sh --bake` prints these with the names filled in.
4. **CI-opt's hold scripts** on the MacBook move to `hold.sh` (through `docs/mac-lane.md`'s `vm_hold`) for timed and
   maintenance holds before the lane is enabled (V4 step 6); a hand-written `vm-hold.*` file races the boot.

## Facts other work consumes

- Tart on the mini is 2.40.1 (the design read 2.41.1's source); its table output is localized, so the lane reads
  `--format json` only. `brew upgrade tart` at V1's start was a no-op, since nothing newer is in its tap.
- The macOS 27 golden-gate image refuses less than 4 GiB of memory (`LessThanMinimalResourcesError`), so a 3 GB guest
  does not exist on this image. Its `tart set --display` does not reach the guest's display mode; `displayplacer` in
  the guest does, and the mode persists into clones.
- In a 4 GB guest V8's default heap is about 1 GB; MAWS's widgets build needs more.
- The image pre-grants Accessibility, ScreenCapture and PostEvent to `tart-guest-agent` (so to every `tart exec`'d
  process), osascript and python; SIP is disabled in the guest.
- The mini's `/opt/homebrew/bin/node` is v26, which ships no corepack; `/usr/local/bin` has node 22.18.0 and pnpm
  11.23.0. Anything on the mini that runs `corepack` from a PATH where Homebrew comes first fails with
  `command not found: corepack`.
- A busy 4 GB guest moves the host's available % by at most 8 points. Pressure 2 began at about 35–41 % available, in
  the 8 GB boot.
- The mini's swap was at 510 MB before any guest (10-21 evening) and 142 MB at V1's start (07:07Z). After V1's surge
  it held 2081 MB at pressure 1, never reclaimed rather than resident.
- MAWS's alert check counts an online guest as a free Mac (V3 concern): a run may go ahead past a host alert, and a
  `--lane vm` run during a host alert stops while the guest is offline (`MAWS_GATE_IGNORE_ALERTS=1` passes it).

## Residue (for tickets)

- **MAWS: the alert check and the guest.** `scripts/ci-gate.sh` treats an online `-vm` runner as a free Mac, so a
  run proceeds past a host alert and its host jobs are refused. Decide whether a guest counts for a run with host
  jobs.
- **MAWS: `unit:darwin`'s vitest files are outside the time-bound walk** (#110's contract test scans e2e specs and
  the vitest files of non-measured groups' scripts, not `unit:darwin`'s). Whether they survive a busy guest is V4's
  evidence today.
- **ci-kit: `lane.sh` is about 1,250 lines.** The pure reads moved to `lane-reads.sh`; the lifecycle and state stayed
  together. A later split (the guard, recovery, alerts) would ease review once V4's evidence has settled the shapes.
- **ci-kit: a trial record cannot tell an infrastructure failure inside a job from the job's own red** (design debt,
  Surprises); V4's rollback rehearsal reads it from `out/` by hand.

- **ci-kit: V1's changes for V4** (the build out of the guest, the baked display mode, the guest disk, the floor at
  60): one PR before V4's install, designed by CI-opt where it changes the job's shape.
- **MAWS: the prebuilt out/'s slower tests** (3–4 s per Electron launch in V1's guest) need a cause before the lane
  depends on prebuilt out/ for its times.

## Friction

- The MacBook's load ran at 70–240 through the night (other sessions); two load-only test flakes appeared in full
  runs (tracked in ci-kit's friction tracker #68). Timing-sensitive tests were written against it.
- The engine's hand-back nudge ends a controller's turn when its last child stops; bounded foreground waits kept this
  run's turn open, as CI-opt advised.
- V1: one bounded foreground wait returned exit 144 at once, with no output (a harness interruption); I re-ran it,
  and nothing on the mini was affected. Replacing the running spike script in place on the mini would have changed
  a running zsh; I copied each new version to `.new` and moved it into place.
