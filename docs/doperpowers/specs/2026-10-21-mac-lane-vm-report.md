# Mac lane concurrency, the VM lane: executor's report

The executor's account of the VM lane's milestones of
[the living spec](2026-10-21-mac-lane-concurrency-design.md) (V1–V5), for CI-opt, the session that owns the spec and
books the Mac mini. The spec is the source of truth: its Progress, Decision Log, Surprises & Discoveries and
Outcomes carry every decision; this report is the run's record and what comes next.

## Where it stands (2026-10-22 ~03:00Z)

| Milestone | State |
|---|---|
| V1, the second spike | Not run. Window booked by CI-opt: hold-by after 09:00Z 10-22 (deadline 09:30Z), hard end start + 3 h, before 13:10Z. Script ready on the MacBook: `~/Developer/ci-analysis/v1-spike.sh`. |
| V2, ci-kit: the lane | Built, reviewed clean, ci-gate green. PR on branch `vm-lane-v2`, for CI-opt to merge and move `v1`. |
| V3, MAWS | Landed: MAWS #110, merge 64483a63d. |
| V4, install, trials, verdict | Not started. Needs V1's verdict, V2 merged, mini windows and one owner step (below). |
| V5 | Not started. |

Nothing was booted, installed or changed on the mini. Read-only `ssh mini` reads only (Tart's version, `tart list`,
sysctl reads, `gh auth status`, the LaunchAgents present).

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

1. **Merge the V2 PR and move `v1`** by the PATCH rule.
2. **V1's window** (booked). At the go I run `~/Developer/ci-analysis/v1-spike.sh` phases on the mini from a one-shot
   gui-session LaunchAgent: `brew upgrade tart` first, then the bake (3 GB candidate), the 4 GB candidate, per size
   `document-app`×3 and `widgets`×3 in a job-shaped clone with the host sampler, the TCC/`csrutil`/AX read, one host
   `e2e:dashboard` beside a busy guest, one 3 GB surge, one `dashboard-scale` row beside the guest. "done" means no VM
   running, the job clones deleted, candidates kept or deleted as recorded, the LaunchAgent removed.
3. **V4 needs, in order:** V1's verdict (the memory size, `CI_KIT_VM_MEMORY_FLOOR`); V2 merged; a window for
   `install.sh --vm` (launcher installed disabled); a maintenance window for the first refresh (bake, the owner's
   first-run step, register with two tokens, a `Lane: vm-trial` scratch commit, trial, promote); then the trial
   windows of V4 steps 3–12.
4. **The owner's first-run step** (V4 step 2, after `--bake`): in the mini's own GUI session over Screen Sharing,
   `tart run --dir=maws:<checkout>:ro <candidate>` in the mini's Terminal; in the guest, open Terminal and
   LibreOffice and answer their first-run prompts; in the guest's Terminal,
   `export PATH="$(cat ~/actions-runner-maws/.path)"`, then
   `git -c safe.directory='*' clone "/Volumes/My Shared Files/maws" ~/maws-firstrun && cd ~/maws-firstrun && pnpm install --frozen-lockfile && pnpm e2e:deliverables`,
   answering Electron's notification prompt as the mini's own setting has it; then
   `cd && rm -rf ~/maws-firstrun && sudo shutdown -h now`. `bake.sh --bake` prints these with the names filled in.
5. **CI-opt's hold scripts** on the MacBook move to `hold.sh` (through `docs/mac-lane.md`'s `vm_hold`) for timed and
   maintenance holds before the lane is enabled (V4 step 6); a hand-written `vm-hold.*` file races the boot.

## Facts other work consumes

- Tart on the mini is 2.40.1 (the design read 2.41.1's source); its table output is localized, so the lane reads
  `--format json` only. CI-opt approved `brew upgrade tart` at V1's start.
- The mini's swap was at 510 MB before any guest (10-21 evening); V1 measures growth from its own start.
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

## Friction

- The MacBook's load ran at 70–240 through the night (other sessions); two load-only test flakes appeared in full
  runs (tracked in ci-kit's friction tracker #68). Timing-sensitive tests were written against it.
- The engine's hand-back nudge ends a controller's turn when its last child stops; bounded foreground waits kept this
  run's turn open, as CI-opt advised.
