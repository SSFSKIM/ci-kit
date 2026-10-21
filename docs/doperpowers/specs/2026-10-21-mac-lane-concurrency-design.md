# Mac lane concurrency

## Purpose

On 2026-10-21 the owner ruled that maximizing CI parallelism, so CI is never the bottleneck, is the top priority. Cost
is no reason to lower it. The owner also observed that the Mac mini's CPU sits mostly idle, and directed that MAWS run
its e2e there. Today the mac lane runs one job per machine:
- **The queue.** On 10-20 the mini ran 178 jobs. The median wait was 9.5 min and the p90 39.7 min, and in landing hours
  the mini was busy 78% of the time. Cross-set queueing was 68% of the wait.
- **The load.** The 1-minute load mostly stays at 2–6 on 10 cores.

The one-job rule (`docs/mac-lane.md`, "Why one runner per machine") exists because e2e groups share one desktop: focus,
pointer and pasteboard. This initiative runs two jobs at a time on the mini. A desktop lease keeps every job that needs
the desktop, or a quiet machine, alone. Everything else runs beside another job.

It serves the people building MAWS: the sessions and children whose Mac sets wait in that queue. What it enables is
roughly twice the Mac lane's throughput without a second Mac.

### The VM lane (added 2026-10-21 evening)

The host lease adds a second job beside the first, but every job still needs the host's one desktop or a quiet host,
and the host desktop is held for hours at a time: GUI test sessions (cua's functional sessions, MAWS's benches) take
the runner offline, and Mac CI stops for their whole length, about 9 h on 10-20. The owner reopened the Tart route
tonight with a smaller guest ("we can reopen VM with smaller 3-4GB guest"), reversing the "No VM" line below (Decision
Log). The VM lane is a second macOS desktop on the mini: a macOS 27 guest, booted fresh for one job from a golden image
and destroyed after it, so a job that needs a desktop to itself (the four foreground groups above all) runs beside the
host's jobs, and keeps running while the host desktop is held for an untimed session. What it must never do is sit
beside a timed job or a timed hold: the 10-21 spike showed a busy guest breaking the host's timed rows, and memory, not
CPU, is what binds on this 16 GB machine (15 of 16 GB used and swap in use at 18:45Z, with the owner's Chrome, Claude
Desktop and CLIs resident). The lane is therefore admitted job by job: by the host's admission lock, by a memory guard,
and by the coordinator's holds, and the design below says what is read and when.

### What it must not be

- **No result changes because of a neighbour.** A group runs beside another only once a trial has shown its results
  match its solo runs. Anything unproven runs alone.
- **Measured and foreground groups never share the desktop.** Measured groups are timing-bounded (MAWS `MEASURED_E2E`);
  foreground groups are the ones whose cases test the app in front. The lease, not the settle step, is what
  guarantees this (settle checks at start and holds nothing). For the VM lane the settle step does hold something, the
  measured claim, because it is the only point that knows a job is measured (The VM lane, Admission).
- **The mini's other users keep what they have.** GUI holds, the quiet flag, the dialog watcher, the owner's own use
  and other sessions' bookings work as today, over every runner of the machine.
- **No guest beside a timed job or a timed hold, and no guest the host cannot afford.** The "No VM" line that stood
  here from the morning's draft was reversed by the owner on the evening of 10-21 (Decision Log); what stays is its
  reason: a guest's load broke timed rows in the spike, so a measured job, a timed GUI hold and the memory guard each
  keep the guest down.
- **Never on the MacBook, never for a public repository.** The guest registers to `SSFSKIM/MAWS` alone, as every runner
  of the lane does, and the MacBook is never a runner.

## Glossary

- **Instance.** One runner of the lane on a machine: its directory, LaunchAgent, runner name and labels.
- **The exclusive instance.** Instance 1, today's `ci-kit-mac-<machine>` in `~/actions-runner-maws`, with today's
  labels. Every job it runs runs alone on the desktop.
- **A shared instance.** Instance *n* ≥ 2. It carries only `ci-kit-mac-shared`, so only a job that asks for that label
  can reach it. Shared instances run beside each other, never beside an exclusive job.
- **The shared hold.** The marker an exclusive job raises while it waits or runs. While it is up, no shared job gets
  past its job-started hook.
- **A running marker.** The file a shared job writes when its hook admits it and removes at its end. It names the job's
  run id, job id and `Runner.Worker` (pid and start time).
- **Proven-shared group.** A group whose trial evidence (M4) shows its results unchanged beside neighbours. Only these
  ask for `ci-kit-mac-shared`.
- **The guest.** A macOS virtual machine on the mini, run by Tart (`/opt/homebrew/bin/tart`, 2.41.1) over Apple's
  Virtualization.framework, with its own desktop, display and user (`admin`). At most two run on one Mac (Apple's
  license); the lane starts with one.
- **The golden image.** The local Tart VM every job clone is made from: the macOS 27 base image
  (`ghcr.io/cirruslabs/macos-golden-gate-base`) plus what a MAWS job needs baked in. It is never run for a job.
- **A job clone.** The copy of the golden image booted for exactly one job and deleted after it; APFS makes the copy
  instant and the clone holds only what the job writes.
- **A slot.** One guest's identity on the host: a registered runner name (`ci-kit-mac-<machine>-vm`, a second
  `-vm2`), its registration files, and the per-slot directories the guest is shown. A slot runs at most one clone at a
  time.
- **The launcher.** The host-side LaunchAgent of the lane (`com.ssfskim.ci-kit.vm-lane`), in the user's GUI session,
  which reads the queue, decides admission, boots a clone for a job, and deletes it after.
- **`ci-kit-mac-solo`.** The label of a job that wants a desktop to itself, whichever desktop is free: the exclusive
  instance and the guest both carry it. **`ci-kit-mac-vm`** is the guest's alone, for trials and for forcing a job to
  the guest.
- **The reservation.** The slot's one marker, `vm-reserved`, written before any guest boots (a job clone, a bake, a
  registration, a candidate's trial) and released only after Tart shows the VM stopped. It means "a guest may be
  running", whoever asked for it and whether that process still lives.
- **A claim.** A host job's marker, `vm-claim.<worker>`, that keeps the guest from booting while the job runs: the
  measured claim settle raises, or the claim the exclusive hook raises for a job it cannot classify. Stale with its
  worker.
- **A hold.** A marker of the coordinator's (CI-opt, the session that books the mini for other sessions) or the
  bake's, `vm-hold.<owner>`, one file per owner, each removed by its owner alone: a timed hold, or a bake in progress.
- **A candidate.** A freshly baked image, `maws-vm-candidate-<date>`, that becomes the golden image only after one
  trial job boots from it and ends green.
- **Proven-VM group.** A group whose trial evidence (V4) shows its guest results green and matching its host results.
  Only these are on MAWS's `MAC_VM_E2E`.

## Progress

- [x] (2026-10-21 09:5xZ) Read-only audit of every MAWS Mac group (local: `~/Developer/ci-analysis/mac-concurrency-audit.md`
  on the MacBook; MAWS is private, so this spec carries its conclusions, not its line references).
- [x] (2026-10-21 10:2xZ) Adversarial review of the first draft (a reader-writer lease taken in hooks): six P1s and two
  P2s, all taken; the design below replaces it (Decision Log).
- [x] (2026-10-21 ~10:1xZ) Second adversarial review (astra), of the second draft (shared listeners stopped by a
  wrapper hold and a drain): two P1s and two P2s, all taken; admission moved into the hooks under one lock (Decision
  Log).
- [x] (2026-10-21 ~10:2xZ) Third adversarial review (astra), of the lock: two P1s and one P2, all taken (Decision
  Log).
- [x] (2026-10-21 ~11:5xZ) M1 — ci-kit: instances, admission in the hooks, per-instance identity. ci-kit #67 merged
  fcb538a (reviewer-medium, reviewer-high, and a delta review; every finding fixed; ci-gate 39594858245); `v1` moved.
  Its reinstall on the mini, with no shared instance, waits for an idle moment after the 10-21 evening hold and #103's
  Mac set.
- [ ] M2 — MAWS: the shared-state fixes and the routing of proven-shared groups. MAWS #103 open (head 7554ba433,
  class 1a 39589318188 green); its Mac set runs after the 10-21 evening hold.
- [ ] M3 — Install on the mini: one exclusive and two shared instances, shared ones disabled.
- [ ] M4 — Trial and the first proven-shared groups.
- [ ] M5 — Widen the proven-shared set.
- [ ] M6 — A third shared instance (only if memory allows).
- [x] (2026-10-21 evening) The owner reopened the VM route with a 3–4 GB guest; the VM lane designed below
  (ci-kit branch `vm-lane-design`), its Decision Log entries written. Nothing was booted on the mini for it.
- [x] (2026-10-21 late) Adversarial review of PR #81's design: four P1s (a dead launcher read as a stopped guest; a
  bake outside admission and holds overwriting each other; settle-only protection missing legacy workflows; the idle
  stop killing a job in preparation) and four P2s (supervision only while running; no session recovery; no disk
  reserve; no path for a candidate image), all real, all taken (Decision Log, the entries after the first eleven).
- [ ] V1 — The second spike: go/no-go on numbers (3 GB and 4 GB guests, the wide display, a baked image, two groups,
  host memory and a timed row beside).
- [ ] V2 — ci-kit: the launcher, the guest's runner and hooks, admission with the host lock, the memory guard, the bake.
- [ ] V3 — MAWS: `MAC_VM_E2E` and the `ci-kit-mac-solo` routing, the guest's budgets.
- [ ] V4 — Install on the mini, trials, the first proven-VM groups, the mode verdict, the coordinator's holds.
- [ ] V5 — Widen the proven-VM set; the second guest, if memory ever allows it.

## Design

**Admission is by labels, and fails closed.** Which jobs may share the desktop is decided before any runner accepts a
job, by the labels a job asks for:
- The exclusive instance keeps today's labels (`self-hosted`, `macOS`, `ARM64`, `ci-kit-mac`). So every job that
  exists today reaches only it and runs alone: an old commit's workflow, a rerun, a new group nobody classified, a
  measured or foreground group.
- A shared instance has only `ci-kit-mac-shared` (`--no-default-labels`, so not even `self-hosted`). A job reaches it
  only if it asks for that label alone, which MAWS does for proven-shared groups (M2, M4). A bare `runs-on:
  self-hosted` cannot reach it.
- The first draft's alternative failed review: every job took a shared lease in its hook, and exclusive groups
  upgraded in a step. An old workflow, or a group nobody listed, then ran shared.

**Admission happens in the job-started hooks, under one lock.** One machine-wide lock file, taken with Perl's `flock`
(kernel-released, as `dialog.sh` uses), guards the shared hold and the running markers. Each side checks and writes
while holding it, so no check can be overtaken between its read and its write.
- **A shared job's start.** It takes the lock. If neither the shared hold nor the dialog drain's marker
  (`runner-drained`) is up, it writes its running marker, releases the lock, and runs today's start. Otherwise it
  releases the lock and retries about once a second. The job is parked in its hook and has run no step. Past the
  shared wait bound (60 min, an input), it refuses with a `ci-kit: … rerun` line naming the hold.
- **A shared job's end.** It sweeps its own instance, then removes its marker under the lock.
- **An exclusive job's start,** before its desktop check:
  1. It raises the hold under the lock, naming its run id, job id and `Runner.Worker` (pid and start time). From then
     on no shared job is admitted, so a waiting exclusive job cannot be starved.
  2. It waits until no live running marker remains. A marker whose `Runner.Worker` is gone (pid and start time) is
     stale. The wait is bounded (10 min, an input); past it, the hook refuses with a rerun line and keeps the hold
     until its end hook.
  3. It sweeps what finished or dead shared jobs left running. Every live shared `Runner.Worker` and its descendants
     are spared: by then each is parked, or in its end hook after its own sweep. A hook runs as a child of its worker,
     with its working directory in the job's workspace, so the sweep would otherwise select a parked hook. Everything
     else under a shared `_work` is a finished or dead job's.
  4. It runs today's start: the dialog check, Terminal to the front, the cursor park, its own sweep.
- **An exclusive job's end.** It sweeps its own instance, then drops the hold. A failed own sweep keeps the hold up
  for the watcher's reconcile (Recovery).

**A refusal is not an abort, so a claim lasts to the job's end.** A job-started hook that fails only fails its step.
Later steps conditioned on `failure()`, `always()`, `!cancelled()` or `cancelled()` still run (actions/runner
v2.338.0, `ScriptHandler.cs` and `StepsRunner.cs`). So:
- A start refused after admission keeps its claim (a shared job its marker, an exclusive job the hold) until its end
  hook releases it. A refusal can come from the dialog check, Terminal, the sweep, or the exclusive wait bound.
- A shared job refused at its bound holds no claim. Its post-refusal steps can run beside the exclusive job.
- The lane's contract therefore covers steps that can run after a failed start: they must not use the desktop.
  `docs/mac-lane.md` states it, and MAWS pins it with a test over its Mac jobs (M2). Today those steps are artifact
  uploads, or are gated on a step that runs only after admission.

The exclusive job starts on a desktop where no neighbour runs a step and none has left anything running, and no
neighbour can start one until it ends. A measured job's `settle` reads a desktop that stays as it read, apart from
the bounded preparation below.

**No listener is stopped for an exclusive job.** The second draft stopped the shared instances' listeners: a hold in
their LaunchAgent wrapper and a drain at each job's end. Its second review showed that stop cannot be made safe:
- A wrapper can pass its check, stall, and start its listener after the exclusive hook has read it as stopped.
- The drain's SIGTERM can land after the listener has accepted its next job. `mac/hooks/dialog-watch.sh` already
  records the result: a job left in progress on an offline runner, or a cancelled one.

**The cost:** a shared job can be assigned while an exclusive job runs. Its preparation then happens beside the
exclusive job, before it parks:
- **Typically:** on the mini that preparation (`Set up job`) is 3–4 s of light disk and network work, once per shared
  instance per exclusive job.
- **It can recur.** A preparation that fails ends its job without reaching the hook, which frees the listener for
  the next queued shared job. A parked job that is cancelled frees it too. Action downloads retry up to three times,
  20 minutes each (actions/runner `ActionManager.cs`, `JobRunner.cs`).
- **What M4 must show.** Round one's objection to hooks, that a neighbour's preparation reaches a measured job, is
  therefore real but unbounded in its failure cases. M4 tests it: measured groups beside cold preparation, a download
  failure, and a cancel-and-replace burst, each inside its solo spread.
- **If M4 cannot show that,** shared instances are not enabled while measured groups can run. Sharing then waits for
  a design that isolates before setup.

**Shared instances.** A shared instance's start, once admitted, is today's: the dialog check, Terminal to the front
(harmless to proven-shared groups, which do not need key), the cursor park, and the sweep of its own `_work`. Two
shared jobs simply run.

**Per-instance identity.**
- Every hook acts on the instance that runs it, never on a path derived from where the hook file lives. The sweep, the
  drain and the running markers each take the instance's root from the runner's own environment or from a per-instance
  copy of the hooks.
- `runner-state.py` reads each instance by its own `bin/Runner.Worker` path and its own `_diag`.
- Uninstall, the dialog watcher's drain and a human's hold cover every instance. A shared job is not admitted while
  the drain's marker is up. The shared hold keeps one owner, the exclusive job.
- The coordinator's scripts (`hold-now.sh` and the release command) boot out and bring back every instance, restoring
  each shared instance's enabled state as it was.

**Recovery.**
- A process killed while it holds the lock leaves no lock behind (`flock` is released by the kernel).
- The hold and every running marker name a `Runner.Worker` by pid and start time, so PID reuse or a reboot cannot pass
  for one.
- **A dead shared job.** Its marker is stale and admits nothing. The exclusive start sweeps what it left running.
- **Every sweep spares every live `Runner.Worker` tree,** of any instance, taken from the sweep's own process
  snapshot. That covers the exclusive start's sweep and the reconcile's.
- **A crashed exclusive job.** Two matching idle reads do not reserve the exclusive instance, whose listener can start
  the next job at any moment. So recovery runs under the admission lock: it revalidates that the hold's owner is dead,
  sweeps, and drops the hold. A new exclusive job cannot pass admission meanwhile, and the sweep spares its live
  worker.
  - An exclusive start that finds a stale hold reconciles it itself, under the lock, then raises its own.
  - The dialog watcher, which already reads the runner every minute, reconciles a stale hold when no new exclusive job
    comes.
  - A hold whose sweep fails stays up, and the shared jobs stay parked. The watcher
  logs it and opens one alert issue (`ci-kit alert: shared hold stuck on <machine> since <minute> …`, a title outside
  MAWS's dialog-alert pattern), which it closes once no hold is up. Rather than admit a neighbour, the lane falls back
  to one job at a time.
- **After a reboot.** No `Runner.Worker` survives, so every marker is stale. The watcher reconciles the hold as above.

**Time budgets.**
- **An exclusive job** waits at most the 10-minute bound (`CI_KIT_EXCLUSIVE_WAIT`), and is refused before GitHub's
  timeout. Proven-shared groups are short: M4 admits no group whose p95 job time exceeds 8 minutes. So the bound is
  rarely reached.
- **MAWS adds the bound** to its exclusive Mac jobs' `timeout-minutes`: 30 → 40, measured 45 → 55.
- **An old commit's workflow** keeps its old timeout and still fits. Successful Mac jobs 10-19 to 10-21: the longest
  functional job is `e2e:default` at 13.8 min of its 30, and the longest measured job `e2e:document-scale` at 12.3 of
  45. After a full 10-minute wait, the first still has 6 minutes to spare and the second 23.
- **A shared job** parks for at most one exclusive job at a time. When a hold drops, a parked job, retrying each
  second, is admitted before the next exclusive job's preparation reaches its hook. Its parked time counts against
  its timeout, so MAWS gives shared jobs their own budget plus the 60-minute shared bound (`CI_KIT_SHARED_WAIT`).
  Both bounds are read from the runner's environment, which an instance's `.env` can set.

**MAWS's shared state** (M2; the audit's hazards). All of these matter only between shared jobs:
- **The e2e build cache** becomes one directory per instance (`…/maws-e2e-build/$RUNNER_NAME`). Two jobs on one
  variant otherwise race its restore, store and prune.
- **The clipboard lock** moves from `os.tmpdir()` to a fixed machine-wide path, so it holds across instances.
- **Each instance's windows open at their own origin.** A covered window's child WebContentsViews stop drawing.
- **The shared-desktop flag.** Shared instances set `CI_KIT_SHARED_DESKTOP=1` in their runner environment, and MAWS's
  load-aware latency budgets treat the host as loaded under it. The raw bounds the audit names go through that budget.
- **Later, for the groups that need them (M5):**
  - a lock around the recorded `/private/tmp` repo directories;
  - focus calls that do not activate the app under quiet e2e;
  - the dashboard clipboard steps inside the lock.

**Which groups become proven-shared** (M4). A group is proven-shared only with evidence, from paired runs at one sha
whose test intervals actually overlapped (read from the job logs), each compared against solo runs of the same groups
at that sha:
- beside itself;
- beside a heavy neighbour (`unit:darwin`, `terminal`'s flood);
- beside another clipboard user, if it uses the pasteboard (for example `browser` with `panel`);
- through its own named risk, if the audit gave one: presentations' display-sized window, connectors-direct's restore,
  browser's occluded tab views, settings' pixel shots.
- its p95 job time at most 8 minutes, so an exclusive job's 10-minute wait for it fits (Time budgets).

**What fails a pair:**
- a red the solo control lacks;
- an action stuck waiting for stability, or a stalled screenshot;
- a visibility read of hidden in a scene that showed its window;
- an Electron app frontmost in the 1 Hz `lsappinfo front` log;
- a clipboard lock timeout;
- a failed cache restore;
- a timing annotation outside its solo spread.

`unit:darwin` is first in line: it uses no desktop, its shared state is temporary directories, and the measured groups
it must never meet now run only on the exclusive instance.

**Memory.** The mini has 16 GB, most of it used by the owner's sessions. Two shared jobs fit by estimate. A sampler
records memory pressure, swap and free memory through M4. A third shared instance (M6) needs no pressure above level 1
and no swap growth in M4's reads, and its own trial: three-way overlaps of proven-shared groups, judged by the same
fail rules.

### The VM lane

**The parts, and where they live.** The lane is one more runner of the machine, whose desktop is a guest's.
- `mac/vm/lane.sh`, the launcher: the program of the LaunchAgent `com.ssfskim.ci-kit.vm-lane` (RunAtLoad, KeepAlive,
  Aqua session only, like the runners'). It is in the user's GUI session on purpose: Virtualization.framework needs an
  unlocked login keychain on macOS 15+ (Tart's FAQ: "Failed to generate keypair" without one), which auto-login gives
  the mini's session at boot, and the display rule below needs the host's main screen.
- `mac/vm/bake.sh`: builds and refreshes the golden image, and registers a slot's identity (`--register <slot>`).
- `mac/vm/guest/`: what runs inside a clone. `kickoff.sh` starts the one job's runner under `wrapper.sh`, which owns the
  listener, writes the `out/` markers from the listener's diag log and process, answers the idle handshake and powers
  the guest off at the end; `hooks/` is the guest's copy of the lane's hooks, cut down (below). The directory is shown
  to every clone read-only, so a hook change needs no image refresh.
- The slot, `~/ci-kit-vm/<slot>/`: `identity/` (the runner's `.runner`, `.credentials`, `.credentials_rsaparams`),
  `out/` (what the guest writes back: its markers, `_diag`, its hooks log) and `cache/` (MAWS's e2e build cache,
  below). The launcher gives a clone `identity/` and the kit read-only, `out/` and `cache/` read-write, as Tart
  directory shares (`--dir`, virtio-fs, mounted in the guest under `/Volumes/My Shared Files/<name>`, as the spike's
  checkout was).
- The lane's state, in `~/Library/Logs/ci-kit/` beside the shared hold's, written under the same `desktop.lock`, each
  file replaced whole by a rename, and a write that fails leaving the lane in the stricter state (a reservation that
  cannot be written is no boot; a release that cannot be written stays reserved):
  - `vm-reserved`: the slot's one reservation, whatever boots a guest (a job clone, a bake, a registration, a
    candidate's trial): its kind, the VM's name, the time, the process that asked (pid and start time, information
    only) and the job once the guest reports it. It states "a guest of this slot may be running", and it is cleared
    only by a teardown verified against Tart (Lifecycle), never by its asker's death.
  - `vm-hold.<owner>`: one hold per owner (a coordinator session's timed hold, the bake's); the lane is held while any
    exists, and each owner removes only its own.
  - `vm-claim.<worker pid>-<start time>`: one claim per host job that keeps the guest out: settle's measured claim, or
    the exclusive hook's claim for a job it cannot classify (Admission); stale when its worker is gone.
  - `vm-pause`: the guard's, with its expiry and its reason (memory, disk, failures).
  - `~/ci-kit-vm/golden`, the pointer to the golden image's VM name, and `~/ci-kit-vm/trial` (The image).
  The log is `vm-lane.log`; the guest's hook lines land in the hooks log through `out/`.
- Nothing of the lane reaches the guest by its IP address. The host talks to a clone only through `tart exec`, which
  is gRPC over the VM's control socket to the Tart guest agent inside (verified in Tart's `Exec.swift`), and through
  the directory shares. So the macOS Local Network prompt, which Tart's FAQ names for host tools that connect to a
  guest's address and the spike flagged as the risk to watch, never comes up for a job. The guest reaches GitHub
  through Tart's default shared (NAT) network; nothing connects inward.

**Lifecycle: one clone, one job, then gone.** Each row's exit is the next row's entry; every bound is an input with
the default shown, read from the launcher's environment. The reservation is written before the clone exists and
released only after the VM's end is verified; the guard samples through every row (The memory guard).

| State | What happens | Leaves when |
|---|---|---|
| idle | nothing runs; the launcher reads the queue every 15 s (`CI_KIT_VM_POLL`) | the boot rule (Admission) holds |
| booting | under the lock: `vm-reserved` written (kind `job`), then `tart clone <golden> maws-vm-job-<slot>-<time>` (APFS copy-on-write: seconds, and the clone holds only what the job writes), `tart run --no-graphics` with the four shares, detached | `tart exec <clone> true` answers (37 s in the spike), bound 120 s (`CI_KIT_VM_BOOT`) |
| kicking off | `tart exec <clone> …/kickoff.sh <slot>`: copies the identity into the runner's directory, links the cache, starts `wrapper.sh` (`run.sh --once` under it) detached from the exec and returns | `out/listening` or `out/session-conflict` appears, bound 60 s |
| session recovery | the listener found the slot's previous session still open at GitHub (a clone that died mid-job) and retries, every 30 s for up to 4 min in runner 2.338.0 (`MessageListener`, `BrokerMessageListener`); the wrapper writes the marker from the listener's diag log | `out/listening` appears, bound 5 min (`CI_KIT_VM_SESSION`); past it, teardown, and a failure counted as `session`, apart from the image's count |
| listening | the runner polls GitHub for its one job | `out/assigned` appears (the wrapper's watcher saw the listener take a job: a job line in the newest diag log, or a `Runner.Worker`); or no assignment within 3 min (`CI_KIT_VM_IDLE`): the idle handshake (below) |
| preparing | GitHub prepares the job in the guest (`Set up job`, action downloads: minutes in a bad case) before the job-started hook runs | `out/job` appears (the guest's job-started hook writes it) |
| running | the job runs; `vm-reserved` names it | `tart run` exits: the guest powered itself off after the runner exited; bound from `out/assigned` = the job's longest timeout + 10 min (`CI_KIT_VM_JOB_BOUND`, 50), then `tart stop` |
| teardown | the VM's end verified: `tart list` shows the clone stopped and no `tart run` of its name is in the process table; if it still runs, `tart stop` (its own timeout, then force), and the check again; `out/` folded into the lane's logs; then `tart delete <clone>`; then `vm-reserved` removed under the lock | → idle. A stop that fails, or a state that cannot be read, keeps the reservation, is retried each poll, and opens one alert after 10 min (`ci-kit alert: vm lane on <machine> cannot stop <clone> since <minute>`) |
| failed | a bound passed or a command failed: teardown, the reason logged, a failure counted by kind (`image`, `session`, `memory`, `disk`, `raced`); three `image` failures in a row pause the lane (`vm-pause`, no expiry) and open one alert | an operator clears the pause |

- **Why the runner runs once and exits, with no registration per job.** The guest's runner is a registered,
  non-ephemeral runner whose identity lives on the host in the slot and is copied into each clone; it is started with
  `run.sh --once`, so the listener takes one job and exits before asking for another (actions/runner `Runner.cs`: the
  once mode ends the loop after the job finishes, with a warning that `--once` "is going to be deprecated in the
  future"). This is the one-job lifecycle the second review called race-free at the server, without the credential
  it rejected: a just-in-time registration needs an `Administration: write` token on the host, readable by every host
  job (Decision Log). If `--once` is ever removed, the fallback is that JIT path, and the owner's call on the token.
- **Why the runner is started by `tart exec` and not by a LaunchAgent in the image.** TCC on macOS attributes a
  grant to the responsible process, which is how the host's jobs hold Full Disk Access through `/bin/bash`. The base
  image's build writes rows into both TCC databases (cirruslabs `macos-image-templates`, `update-tcc-database.sh`):
  Accessibility, Screen Capture and PostEvent for the Tart guest agent, `/usr/bin/osascript`, `sshd-keygen-wrapper`
  and Python. A runner the guest agent starts inherits those; one launchd starts as `/bin/bash` holds nothing. V1 reads
  the rows and the guest's `csrutil status` before anything relies on them.
- **Why the guest powers itself off.** `wrapper.sh`, after the runner exits, copies `_diag` and the hooks log to
  `out/`, writes `out/done <exit code>`, and runs `sudo shutdown -h now` (`admin` has passwordless sudo in the base
  image). `tart run` then returns, which is the launcher's signal that the job is over; the launcher still verifies
  the VM's state before it deletes (teardown), and a clone that never powers off hits the running bound.
- **Self-update.** The runner updates itself when GitHub asks, inside the clone, and the update is lost with it: the
  once mode returns `RunOnceRunnerUpdating` and `run.sh` relaunches the updated runner before the job, 30–60 s per
  job until the image is refreshed. An update line in `out/_diag` is logged as a refresh trigger (The image).
- **Recovery, and why the reservation outlives the launcher.** `tart run` is detached, so a launcher that dies leaves
  its guest running, and Tart refuses to delete a running VM (`VMDirectory.delete()` throws `VMIsRunning`, 2.41.1).
  So `vm-reserved` is never read as stale by its asker's pid, and settle's `vm` condition reads it as "a guest may be
  running" whatever the launcher's state. At start (KeepAlive after a death, RunAtLoad after a reboot) the launcher
  reconciles under the lock before it reads the queue:
  - a reservation whose VM `tart list` shows running, with `out/assigned` and no `out/done`: the launcher **adopts**
    it, re-entering `running` with the bound counted from `out/assigned`, and waits for the VM to stop as it would
    have; the job is not lost;
  - a reservation whose VM runs without an assignment, or whose `out/` cannot be classified: teardown, through the
    idle handshake where the wrapper answers and by `tart stop` where it does not;
  - a reservation whose VM is stopped or absent: teardown's delete and release;
  - any `maws-vm-job-*` or `maws-vm-bake-*` VM with no reservation (a write that failed before the clone): a
    reservation written first, so settle sees it, then the same teardown;
  - a bake's hold whose process is gone (its pid and start time): removed with its VM's teardown.
  After a reboot no VM runs, so every reservation is released through the delete. Two launchers cannot run:
  `vm-lane.lock`, an `flock` like the desktop lock's.
- **The idle handshake.** The launcher never signals the listener and never `tart stop`s a clone that may hold a
  job. Past `CI_KIT_VM_IDLE` with no `out/assigned`, it reads the queue once more; with nothing the guest can take, it
  writes `out/stop-request`. The wrapper answers under its own serialization: if the listener has taken a job (a job
  line in the newest diag log, or a `Runner.Worker`), it writes `out/stop-refused job=<id>` and the launcher goes to
  `preparing`; otherwise it sends the listener its graceful stop (SIGINT, the runner's exit without a job), waits for
  its exit, and reads the diag log once more: a job line dated after its check means an acceptance raced the stop and
  the shutdown cancelled the job, which it writes as `out/stop-raced job=<id>`; the launcher logs it, opens one alert
  naming the run and the job (GitHub shows it cancelled; the human reruns), and counts it as `raced`; `out/stopped`
  otherwise. The race is the drain's, narrowed to a listener that had nothing queued at the read, and reported when it
  happens, never silent. Preparation is told from idle listening by `out/assigned`, which the wrapper writes from the
  listener's own record, minutes before the hook could.

**Admission: one gate for every guest, under the host's lock.** Everything that boots a guest of the slot, a job
clone, the bake, a registration, a candidate's trial, goes through `vm-admit.sh <kind>`: it takes `desktop.lock`,
checks the conditions below together, and writes `vm-reserved` before it returns. Nothing boots without that
reservation, and `bake.sh` boots through this path, never beside it. The conditions:
1. **A job wants it** (kind `job`). The queue holds a MAWS job whose labels are a subset of
   `{ci-kit-mac-solo, ci-kit-mac-vm}` (the queued and in-progress runs' queued jobs, read with `gh` as the dialog
   alert is, which needs `Actions: read` and nothing more). The other kinds are asked for by hand.
2. **The host will not take it first.** For a `ci-kit-mac-solo` job, the exclusive instance is busy, held, disabled or
   offline, or more such jobs are queued than it can take (one). GitHub gives a queued job to whichever online runner
   carries its labels, so a solo job with the host idle lands on the host before a clone could boot, and the boot
   would be wasted. A `ci-kit-mac-vm` job always counts.
3. **Nothing holds the lane:** no `vm-hold.*` of any owner, no live `vm-claim.*`, no `vm-pause` in force.
4. **No reservation exists:** `vm-reserved` is absent. A reservation goes only by a verified teardown, so a dead
   launcher, a dead bake or an unreadable VM state keeps the lane closed until recovery has run, never open.
5. **The memory guard and the disk reserve admit** (below).
6. **The host's main display is at @2x** (`cursor-park --describe`, the posture's read), because the guest's display
   takes its density from it at boot (Display). At @1x the lane waits; the posture already treats @1x as a fault.
7. **The mode allows it:** `CI_KIT_VM_LANE_MODE` is `always`, or it is `hold-only` and every host instance is held or
   disabled. The mode is V4's verdict (Trials): `always` is the design; `hold-only` is the spike's conclusion, the
   fallback if host groups do not tolerate a busy guest.
8. **Every host job now running is VM-safe** (below): a job the exclusive hook could not classify holds a claim, so
   this is condition 3 again, named for what it protects.

The lane never stops a running guest to admit anything else: a measured job waits for it, a timed hold waits for it,
a bake waits for it, and the guard stops it only at critical pressure or the disk floor.

- **A measured job on the host.** Measured groups run on the exclusive instance behind `mac/settle@v1`. The host's
  job-started hook cannot tell a measured job from a functional one, so settle, which only measured jobs run, is where
  the guest is kept out. Settle gains a condition `vm` (default `none`): the job is released only while `vm-reserved` is
  absent, whatever process wrote it and whether that process lives (`any` leaves it unchecked, as the other conditions).
  And settle raises the measured claim, `vm-claim.<worker>`, at its first read, under the lock, naming the job and its
  `Runner.Worker` (pid and start time, as the hold does): from then on nothing boots, so the measured job cannot be
  starved by a stream of guest jobs, and the running one finishes first (V4 admits no group whose guest p95 exceeds 10
  min, so settle's 15-minute bound holds). The job's job-completed hook removes a claim naming its worker; a claim whose
  worker is gone is stale and counts for nothing. The 30 s between settle's two reads also lets the host's load decay
  after the clone's exit, which `load` already judges.
- **Host jobs are classified, and the unknown keeps the guest out.** Settle protects only the workflows that run it:
  MAWS commits exist with no settle step (f8d701acb5) and with `MEASURED_E2E` missing `dashboard-scale` and
  `design-scale` (0b7c31a12c), and a rerun or an old sha brings one to the exclusive instance at any time. So the
  exclusive instance's job-started hook, on a Mac with the lane installed, classifies its job before today's start:
  it reads the workflow file the job runs under, at `GITHUB_WORKFLOW_SHA`, through `gh` (the owner's login, bounded
  10 s), and the job is **VM-safe** only when that file carries the contract line (`# ci-kit-vm-contract: 1`, which
  MAWS's V3 change adds, and whose meaning MAWS pins by test: every measured group is on `MEASURED_E2E`, and every
  measured job runs settle). Any other outcome, no line, an older number, a read that fails or times out, is
  **unknown**, and an unknown job is treated as measured: the hook raises `vm-claim.<worker>` and waits, as its
  exclusive wait does for shared jobs, until `vm-reserved` is absent, bounded by `CI_KIT_EXCLUSIVE_WAIT` and refused
  past it in the lane's shape (`ci-kit: the guest on the <machine> did not make way for a job of unknown kind (…);
  waited <n> s — rerun`). The claim holds until the job's end hook. A VM-safe job holds no claim and runs beside a
  guest; the hook's line in the job log says which (`vm-safe: yes (contract 1)` or `vm-safe: unknown (<why>)`).
  Shared instances need no classification: only a contract workflow can ask for their label. The cost: one bounded
  API read per exclusive job, and an old sha's run waits for a running guest, at most the exclusive bound. V2 pins
  that `GITHUB_WORKFLOW_SHA` reaches the hook (the runner sets it for jobs; a hook that finds it empty reads unknown).
- **A host job beside a busy guest.** VM-safe functional jobs on the exclusive and shared instances run beside a clone;
  the host's admission is untouched, and a `ci-kit-mac-solo` job that lands on the exclusive instance is an exclusive
  job like any other. Whether a host group's results survive a busy guest is V4's evidence, group by group, as M4's is
  for neighbours; a group that does not goes to MAWS (its budget) or the mode goes to `hold-only`.
- **Holds have owners, and keep each other.** A hold is a file of its own, `vm-hold.<owner>`, written by its owner
  and removed by its owner alone; the lane is held while any exists, so two sessions' holds never overwrite each
  other and the release of one keeps the other. A coordinator's hold names no process and lasts until its owner
  removes it (the launcher logs each hold once per change and opens one alert after 6 h, `ci-kit alert: vm lane on
  <machine> held by <owner> since <minute>`); the bake's names its pid and start time, and is stale with its
  process. A hold is CI-opt's, over every runner of the machine, and the lane is one:
  - **Untimed** (cua's functional sessions): CI-opt boots out and disables the host's instances as today
    (`hold-now.sh`, `hold-by.sh`, `hold-for-cua.sh` on the MacBook, the `launchctl bootout` lines) and leaves the lane
    running. This is where the lane pays: the host desktop is the session's, the guest's goes on taking `solo` jobs.
    At release, CI-opt brings the instances back; the lane needs nothing.
  - **Timed** (MAWS's benches, anything that reads the machine's timing): CI-opt first writes `vm-hold.<session>`
    (`timed since <time>`), waits until `vm-reserved` is absent (at most the running bound; in practice the group's
    p95 plus the boot), then boots out the instances. At release it removes its own hold, then brings the instances
    back. A hold script that forgets the marker gets a guest beside its bench, so the hold scripts carry it, and the
    booking a session makes through CI-opt says which kind it is.
  - **The bake, a registration and a candidate's trial** boot through admission like a job (kinds `bake`, `register`,
    `trial`): each waits for every claim, every hold and any reservation, and holds the reservation while its VM
    runs, so a measured job's settle and a timed hold wait for a bake exactly as for a job, in either order. The bake
    also holds `vm-hold.bake` across its own sequence of boots (the bake VM, then a registration or the trial's
    request), so no job boots between its steps; that hold names its process and is stale with it. Apple allows two
    guests: with one slot a bake and a job never overlap, and a second slot would make the bake wait for both.
  - **The dialog watcher's drain** (`runner-drained`) does not hold the lane: a dialog on the host desktop is the host
    instances' problem, and jobs in the guest are what keeps CI going through it. The watcher's reconcile does not
    touch the lane's files; the launcher reconciles its own at start.
  - **`install.sh`** refreshes the launcher's agent as it refreshes the runners', refuses while a reservation exists,
    and `--uninstall` removes it; `--disabled` leaves it disabled.

**The memory guard.** Memory binds: at 18:45Z on 10-21, 15 of 16 GB was used and swap was in use, with the owner's
Chrome (about 3.8 GB while the daily journal edition reads articles, 13:10Z for up to an hour), Claude Desktop (about
1.2 GB), the Claude CLIs (about 1.2 GB), ClaudeUsage and a journal background session resident; Docker Desktop was
quit tonight with the owner's OK. The 6 GB spike guest took the host's available memory from 73% to 52% at boot and
to 37% at its lowest, and the host swapped 36 MB at the boot and 269 MB at most.
- **What is read.** `sysctl -n kern.memorystatus_vm_pressure_level` (1 normal, 2 warning, 4 critical: the kernel's
  own pressure state, what `memory_pressure` reports), `sysctl -n kern.memorystatus_level` (the percentage of memory
  the kernel counts available, the "System-wide memory free percentage" of `memory_pressure -Q`, which the spike's
  sampler read), and `sysctl -n vm.swapusage` (swap used). All three read on macOS 26 on the MacBook; V1 confirms them
  on the mini's 27. A read that fails is unknown, and unknown admits nothing.
- **Before a boot** (rule 5): pressure 1; available at least the guest's share of 16 GB plus 12 points (a 4 GB guest
  needs 37%, a 3 GB one 31%; V1 sets the figure from what a busy guest actually takes); swap used not grown between
  two reads 60 s apart (the launcher keeps its last read). Otherwise the launcher waits and logs the read once per
  change, not per poll. The daily journal hour is the case this is sized for: Chrome's 3.8 GB takes the available
  figure under the floor, and the lane simply boots nothing until it comes back.
- **From `tart run` to the verified end**, in every row of the lifecycle and through recovery, a sample every 15 s
  goes to `vm-lane.log` (the record the trials read). The response is by state:
  - pressure 2 on two consecutive samples: in `booting`, `kicking off`, `session recovery` or `listening` the guest
    is given up at once (the idle handshake where the wrapper answers, a plain teardown where it does not), since
    nothing is lost; in `preparing` or `running` the job is left to finish and `vm-pause` is written with an expiry
    2 min after the teardown, so no next guest boots into a host already warning. Either way the samples are logged.
  - pressure 4 on one sample stops the guest (`tart stop`) in any state: a job in it is lost, GitHub reports the
    runner lost, the launcher logs `stopped for memory`, opens one alert (`ci-kit alert: vm lane on <machine> stopped
    a job for memory at <minute>`, a title outside the dialog pattern), and the lane pauses 10 min. This is one of the
    cases (with the running bound, the disk floor and a stop the wrapper could not answer) where a guest job ends
    without a `ci-kit: … rerun` line, since the guest cannot print to a job the host killed; V4's samples show how far
    the lane stays from it.
  The host's own growth is what this is written for: Chrome's journal edition arriving at 13:10Z while a guest runs
  (a 13:09Z boot meets it at 13:11Z) reads as warning first, which gives up an unassigned guest and pauses the next
  boot, and reaches critical only if the job's own peak lands on it. V1 and V4 exercise that transition, one with a
  synthetic surge and one with the real hour.
- **A pause window** (`CI_KIT_VM_PAUSE_WINDOWS`, empty) is a knob V4 may set if the guard flaps around 13:10Z: a
  window that keeps the lane down through the hour is cheaper than the guard's reaction.

**The disk reserve.** Tart's clone reclaims cached images up to its prune limit but admits nothing, and an APFS clone
allocates as it writes, so a job or a bake can fill the volume while it runs. Before any boot (condition 5) the
launcher reads the free space of the volume holding `~/.tart` (`df`) and admits only above `CI_KIT_VM_DISK_RESERVE`
(40 GB: a job clone's writes, a few GB, plus a bake's peak, which V4 measures and the default then follows). The same
read goes with every memory sample: under half the reserve no next guest boots (`vm-pause`, reason `disk`, cleared
when the space is back); under a floor of 5 GB (`CI_KIT_VM_DISK_FLOOR`) the guest is stopped as at critical memory,
since a full volume damages the host, and the alert says `disk`. `bake.sh` reads the reserve before it starts and
refuses below it. A state write that fails for lack of space fails closed, as every write of the lane does (The
parts).

**Display.** The spike's one deterministic failure came from the guest's 1024x768 pt screen (document-narrow's drag
floated below the 1440 pt window the test set), so the guest needs at least 1600 pt of width, at the host's @2x. From
Tart's source (`Set.swift`, `Platform/Darwin.swift`, 2.41.1): `tart set --display WIDTHxHEIGHT[pt|px]` stores a size
whose unit defaults to points for a macOS guest; at `tart run`, a size in points is passed to Virtualization with the
host's main screen (`VZMacGraphicsDisplayConfiguration(for: hostMainScreen, sizeInPoints:)`), so the guest's density
is the host screen's at that moment; a size in pixels, or no main screen in the running process, becomes that many
pixels at 72 PPI, a 1x display. The default is 1024x768.
- The golden image is set to `2560x1440pt`, the mini's own geometry, so the guest's posture line reads
  `display=2560x1440@2x` like the host's and `devicePixelRatio` matches.
- The launcher runs in the GUI session, where `NSScreen.main` exists, and boots only while the host is @2x (rule 6).
- The guest's job-started hook reads the display as the host's does (`cursor-park --describe`) and refuses the job
  when it is under 1600 pt wide or not @2x, in the lane's refusal shape, so a wrong geometry is a refusal with a reason
  and never a silently different result.
- V1 verifies the pt path from a GUI-session process gives @2x in the guest (the spike's run, from an ssh session, got
  the host's density at the default size, which says the path was the pt one). If it does not, the fallback is a pixel
  size and a HiDPI mode chosen inside the guest, which is unverified.

**The image: what is baked, and what invalidates it.** The base is `ghcr.io/cirruslabs/macos-golden-gate-base`,
macOS 27 for parity with the host, already on the mini (41 GB on disk, pulled 10-21): `admin`/`admin`, auto-login,
passwordless sudo, SSH and Screen Sharing on, Gatekeeper disabled (`spctl --global-disable` in its template, so a
cask's "downloaded from the Internet" prompt does not come up), the Tart guest agent, Homebrew, node@24, `gh`, and the
TCC rows above (from the templates' source; the images' own contents are read in V1). `bake.sh` clones it, sets
`--cpu 4 --memory <V1's size> --display 2560x1440pt`, boots it with the host's MAWS checkout shared read-only (the
owner's `gh` login on the mini keeps that checkout at master), and through `tart exec`:
- Node 22 (MAWS's `engines`, what its setup action installs per job) and pnpm 11.23.0 (its `packageManager`, read from
  the shared checkout) through corepack, on the PATH the runner's `.path` gives jobs;
- a scratch clone of the checkout and `pnpm install --frozen-lockfile` in it, then its removal: this warms the pnpm
  store and Electron's download cache (`~/Library/Caches/electron`, which MAWS's setup action keys by Electron's
  version), the 120 s of guest setup the spike paid per boot;
- LibreOffice (cask), for the document groups;
- the runner at `install.sh`'s pinned version, in `~/actions-runner-maws`, with a `.env` whose hook variables point at
  the kit's share, `CI_KIT_MACHINE=<machine>-vm`, `CI_KIT_VM_GUEST=1`, `LANG=en_US.UTF-8`, and a `.path`; the
  compiled helpers (`cursor-park`, `window-list`) built there, since the share is read-only;
- then the human's part, once, in a window (`tart run <golden>` with graphics, from the mini's own GUI session, which
  the owner reaches over Screen Sharing; no VNC into the guest, which would be a connection to its address): open
  Terminal and LibreOffice, and run one MAWS group so Electron's notification prompt is answered, because a prompt
  answered in the image stays answered in every clone, while one left unanswered would come up on every job's fresh
  desktop (the 10-16 incident, `UserNotificationCenter` in front, would recur per job). The image never holds a runner
  identity: `bake.sh --register <slot>` boots the golden image through admission (kind `register`) with a registration
  token on stdin (piped from the MacBook as `install.sh` takes it), runs `config.sh --name ci-kit-mac-<machine>-vm
  --labels ci-kit-mac-solo,ci-kit-mac-vm --no-default-labels --unattended`, moves `.runner`, `.credentials` and
  `.credentials_rsaparams` to the slot on the host, and leaves the image clean. Those three files let a holder take that
  runner's jobs, which is what today's `~/actions-runner-maws/.credentials` on the host already allows; no new class of
  credential is on the mini.

What invalidates the image, and what each costs if stale:
- **the runner's version:** a self-update per job until refreshed (time, not correctness);
- **Node or pnpm pins in MAWS** (`engines`, `packageManager`): the setup action installs its own, so the bake's are
  for the hooks and the warm store; a drift costs download time;
- **MAWS's lockfile:** a stale store costs the delta's download, nothing else; refresh weekly or when a job's
  `pnpm install` line in `out/` passes 60 s;
- **the base image's macOS** when the mini's moves: parity is the point of macOS 27;
- **the helpers or the kit's guest files that are compiled, not shared;**
- **first-run grants:** a new Electron bundle id or LibreOffice version wants the human's window again.
A refresh never touches the golden image in place. The launcher boots job clones from the VM named in
`~/ci-kit-vm/golden`, a pointer file replaced whole by a rename and written only by `bake.sh --promote`:
- `bake.sh --bake` makes `maws-vm-candidate-<date>` from the base through admission (kind `bake`) and stops it; the
  human's window step is on the candidate.
- `bake.sh --trial <candidate>` writes `~/ci-kit-vm/trial` naming the candidate. The launcher's next `job` boot, and
  only that one, clones from the candidate instead of the pointer's VM, consumes the file (renamed to
  `trial.<clone name>`) and records the job's run and job ids in it; queue admission is otherwise unchanged, and no
  other boot reads a candidate. The trial is a scratch MAWS commit with `Lane: vm` (Routing), so the candidate takes
  a known job. `--trial` waits for that clone's teardown, reads the job's conclusion through `gh`, and reports it: a
  green trial prints the promote command; anything else leaves the candidate, the pointer and the current golden as
  they were.
- `bake.sh --promote <candidate>` is a green trial's second step: `tart rename <candidate> maws-vm-golden-<date>`,
  then the pointer's rename into place. Interrupted between the two, the pointer still names the old golden, which is
  valid, and the renamed VM exists under its new name; `--promote` run again finds the candidate under either name
  and finishes, so it is safe to repeat. The old golden stays until `bake.sh --retire <old>`, after the first green
  production job from the new one (every boot logs the golden's name, so the log shows it).
- A candidate that fails its trial is deleted by hand (`tart delete`) once its failure is read from `out/`.
Disk: the base 41 GB, each golden and candidate a copy-on-write clone (its own writes only), each job clone the job's
writes, deleted at its end; the mini had 141 GB free with the spike's 84 GB kept, and the refresh's peak is V4's to
measure against the reserve.

**Routing, labels and MAWS.** The guest's runner carries `ci-kit-mac-solo` and `ci-kit-mac-vm` (`--no-default-labels`);
the exclusive instance gains `ci-kit-mac-solo` beside today's labels. A job that asks for `[ci-kit-mac-solo]` runs on
whichever of the two is free: GitHub's own assignment does the balancing, which a VM-only label could not (a group
pinned to the guest would wait for it while the host sat idle). A job that asks for `[ci-kit-mac-vm]` runs only in a
guest. In MAWS's plan (V3):
- `MAC_VM_E2E`, a list like `MAC_SHARED_E2E`, empty at first: its groups ask for `[ci-kit-mac-solo]`. A `MEASURED_E2E`
  group on it is kept on today's labels whatever the list says (the guest is 1.3–1.7x slower, different hardware, and
  the bounds are the host's). A group on both `MAC_SHARED_E2E` and `MAC_VM_E2E` runs shared: a shared job runs beside
  neighbours and leaves the exclusive instance alone, which is the scarcer of the two.
- A `Lane: vm` trailer (`scripts/ci-gate.sh --lane vm`) sends the run's `MAC_VM_E2E` groups to `[ci-kit-mac-vm]`
  alone: trials, re-measurement, and a session that knows the host is held.
- Timeouts: a solo job that lands on the exclusive instance waits the exclusive bound like any exclusive job, so its
  `timeout-minutes` carries the same +10; in the guest it waits nowhere.
- Budgets: the guest's runner environment sets `CI_KIT_VM_GUEST=1`, which no host instance sets; MAWS's load-aware
  latency budgets treat a guest as a loaded host, as they treat `CI_KIT_SHARED_DESKTOP=1`, since the guest runs at
  1.3–1.7x the host's time. The runner-name contract stands: `ci-kit-mac-<machine>-vm` ends in no `-<n>`, and the
  shared-desktop flag is unset in the guest.
- The first candidates are the four foreground groups (`default`, `widgets`, `to-human`, `document-app`): exclusive on
  the host for their focus, they are exactly what a second desktop frees, and `document-app` already ran 18 of 19 in
  the spike with the one failure root-caused to the display.
- MAWS's alert reader, which folds a shared runner's `-<n>` (M3), sees `-vm` as the machine `<machine>-vm`: the guest
  is a machine of its own to a refusal line, and it never opens an alert (the guest holds no credential).

**TCC in the guest.** No job of the lane may click, edit or disable anything on the host, and the host's SIP stays on;
nothing here touches the host. In the guest, the lane grants nothing of its own: what the jobs get is the base
image's rows through the guest agent (above), and that is more than the host grants (`/bin/bash`'s Full Disk Access
alone, no Accessibility, no Screen Recording). A group that needs a grant the image lacks, Full Disk Access above all,
stays off the guest: V1 and V4 show which, if any, by running them. Pre-granting more in the image means writing TCC
rows as the base image's build does, with `sudo` over a process that holds Full Disk Access; whether that works with
SIP on in the guest is unverified (the templates never run `csrutil`), and disabling SIP in the guest to do it is the
owner's call, put to them only with a named group that needs it and its trial evidence.

**Failure modes.**

| Failure | What the lane does |
|---|---|
| the golden image is missing or `tart` is | no boot; one log line per change; an alert after an hour of a job waiting with no boot |
| a clone never answers, or never lists | teardown, a failure of kind `image`; three in a row pause the lane with an alert, since the image is the likely cause |
| the listener finds the slot's session still open (a clone died mid-job) | `session recovery`, up to 5 min, counted apart from `image`; past the bound, teardown and a `session` failure, and the next boot tries again, since the server closes the old session on its own |
| the runner refuses the job's start (the guest's hook: a dialog in the guest, a display off geometry) | the `ci-kit: … rerun` line; MAWS's `ci-gate.sh` relaunches; two such refusals in a row pause the lane with an alert naming the reason, because a fresh clone showing the same dialog is an image fault |
| a job outlives the running bound | `tart stop`, delete, the job fails at GitHub as a lost runner; logged |
| the host's memory goes critical | the clone is stopped (The memory guard) |
| an idle stop (a clone booted for a job that went elsewhere or was cancelled) | the idle handshake: a job the listener took before the hook ran is seen as `out/assigned` and never stopped; a stop is requested only with nothing queued, answered by the wrapper, refused when a job arrived meanwhile, and an acceptance that raced the stop is reported with an alert, never silent |
| the launcher dies (during boot, or mid-job, with a measured job waiting) | KeepAlive restarts it; the reservation stood throughout, so settle stayed parked; recovery adopts a running job and waits for it, tears down a guest without one, and releases only after Tart shows the VM stopped |
| a stop fails, or the VM's state cannot be read | the reservation stays, the teardown is retried each poll, one alert after 10 min; nothing boots meanwhile |
| a reboot | the agent starts with the session; no VM survives, so every reservation is released through the delete |
| a bake, a registration or a trial asked for while a guest runs, or a job while one of those runs | the one admission: the later asker waits for the reservation, in either order |
| a hold forgotten by its owner | the lane stays held, logged once per change, an alert after 6 h; another owner's release does not touch it |
| a bake that crashes | its hold is stale with its process; recovery tears down its VM and drops both |
| a candidate whose trial fails | the pointer and the golden are untouched; the candidate stays for reading, deleted by hand |
| low disk | under the reserve no boot and no bake; under half of it mid-run no next boot; under the floor the guest is stopped; a state write that fails leaves the stricter state |

**What it costs per job, by the spike's numbers and the design.** Boot to listening about 45 s, then the job: its
checkout over NAT, its setup from the warm store (seconds, not the spike's 120), the group at 1.3–1.7x the host's
time, the e2e build once per sha per slot through the cache share, and MAWS's own 2-minute cache upload at the end
(`docs/mac-lane.md`, "Every job saves the Actions cache again"), then the power-off and the delete. A
`document-app` job that takes about 4 min on the host (2.3 of them its own steps, 2 the cache upload) takes about 6
in the guest. That is the price of a job that
would otherwise wait for the host's desktop, or not run at all during a hold.

**A second guest.** Apple's license allows two. A second slot (`ci-kit-mac-<machine>-vm2`) needs: V4's memory samples
showing the available figure above two guests' floor through the owner's day, which 16 GB with the owner's apps is
unlikely to show; its own identity through `bake.sh --register vm2`; the boot rule counted per slot, and the bake
waiting for both; and a trial of two clones beside the host's jobs, judged by V4's rules. Until then one slot.

**Acceptance.**
- VA1. With the host desktop held for an untimed session (its instances disabled), a MAWS run whose `MAC_VM_E2E`
  groups ask for `[ci-kit-mac-solo]` completes those jobs green in the guest, each job's log carrying the guest's
  posture line (`display=2560x1440@2x`, `vm=vm clone=maws-vm-job-…`), and `tart list` on the mini shows no job clone
  afterwards.
- VA2. With the host idle, a `[ci-kit-mac-solo]` job runs on the host; with the host busy, the next one runs in the
  guest; the launcher's log shows the boot rule's reads for each.
- VA3. A measured job started while a clone runs settles only after the clone's teardown is verified, its log naming
  the wait and the `vm` condition; no clone boots until its end hook runs; its timings stay inside its solo spread.
- VA4. With `vm-hold.<owner>` written as a timed hold, no clone boots; with a second owner's hold added and the first
  removed, still none; with both removed, the next queued job boots one. A bake asked for under a timed hold or a
  measured claim waits; a measured job started during a bake waits for the bake.
- VA5. With the available figure under the floor (the journal hour, or a fake read), no clone boots and the log says
  why once; with pressure forced to warning during a job, the next boot waits the pause; forced to critical, the clone
  is stopped and the alert opened.
- VA6. The guest's jobs hold no `gh` credential and reach nothing by the host's address: the guest's `out/` shows no
  `gh` call, and the host's launcher log shows only `tart` commands.
- VA7. `install.sh` on a Mac without `--vm` installs nothing of the lane and behaves exactly as today; `--uninstall`
  removes the launcher with the rest.
- VA8. (V2 builds the interface and its tests; V4 records the runs.) A candidate is trialled by exactly one job boot
  and promoted only after a green trial, by a promote that is safe to repeat; a failed candidate leaves the pointer
  and the golden untouched. V4 records one refresh that promoted and one that rolled back.
- VA9. An old MAWS sha with no settle step, rerun on the host while the lane is enabled, is classified unknown by the
  exclusive hook, waits for the running clone, and no clone boots during it; a contract commit's functional job is
  classified VM-safe and runs beside one.
- VA10. The launcher killed during a job (and again during a boot), while a measured job waits at settle: settle
  stays parked, the restarted launcher adopts the job, the job finishes green, the clone is deleted only after Tart
  shows it stopped, and settle releases then.
- VA11. One slot's identity is reused: two jobs back to back; a job after a clone forced dead mid-job (`tart stop`),
  whose next listener recovers its session within the budget; and a second boot asked for while one runs is refused
  by admission.
- VA12. With free space faked under the reserve, no boot and no bake; under the floor during a job, the guest is
  stopped with the alert; a marker write on a full volume leaves the stricter state.

## Plan of Work

### M1 — ci-kit: instances, admission in the hooks, per-instance identity

At the end, `mac/install.sh` installs one exclusive instance and *n* shared ones. `--shared <n>` sets the count.
Without it, a re-run keeps the machine's installed count, and a fresh machine gets 0, so sharing is always opted into.
Each shared instance keeps the enabled state launchd has for it, and a new one starts disabled, so a plain refresh
never turns one on or off. The admission lock, the hold, the running markers, their recovery and per-instance hooks
exist. Nothing on the mini changes in M1.
- **`mac/install.sh`:**
  - shared instances at `~/actions-runner-maws-<n>`, LaunchAgent `com.ssfskim.ci-kit.mac-runner-<n>`, runner name
    `ci-kit-mac-<machine>-<n>`, the label `ci-kit-mac-shared` only (`--no-default-labels`);
  - `CI_KIT_SHARED_DESKTOP=1` in their `.env`;
  - a full copy of the hooks per instance, under that instance's directory (the sweep finds its `_work` from its own
    location);
  - `--disabled` disables every instance, for a new machine. Without it, the exclusive instance is enabled as today.
    Each shared instance keeps its state; a read of that state that fails counts as disabled;
  - uninstall removes every instance.
- **The hooks:** per-instance identity everywhere. Admission works as Design describes: the lock, the shared start
  parked on the hold or the drain marker, the exclusive start raising the hold and waiting on live markers, the sweep
  that spares live shared workers, and the bounds from `CI_KIT_EXCLUSIVE_WAIT` and `CI_KIT_SHARED_WAIT`. With no shared
  directory on the machine, the hooks behave exactly as today, with no marker and no extra log line. `runner-hold.sh`
  and the drain stay as today.
- **`runner-state.py`:** reads any instance.
- **The dialog watcher:**
  - drains every instance on a dialog;
  - reconciles a crashed exclusive job's hold;
  - opens and closes the stuck-hold alert.
- **`docs/mac-lane.md`:** the instances, admission, the labels, and what a calling repo does to opt a group in.
- **Tests,** with fakes as the existing hook tests do:
  - the second review's interleaving: a shared start holding the lock between its check and its marker write blocks
    the exclusive raise;
  - a shared job parked while the hold is up, and admitted after the drop;
  - a shared job parked while the drain marker is up;
  - an exclusive start waiting on a live marker, and admitted after that job's end;
  - a dead shared worker's marker read as stale, and its leftovers swept while another shared job is parked and
    spared;
  - both bounds' refusals;
  - a crashed exclusive job reconciled, and a failed sweep keeping the hold, with the alert opened and closed;
  - the third review's interleaving: second idle read, then the next exclusive worker starts, then the recovery sweep.
    The new worker and its hook survive;
  - a start refused after admission, and an exclusive bound refusal, each keeping its claim until its end hook;
  - a process killed while holding the lock, leaving no lock;
  - a reboot (markers on disk, no workers alive);
  - each instance's sweep killing only its own leftovers while the other instance's job runs;
  - the install's label sets: neither today's tuples nor a bare `self-hosted` can match a shared instance;
  - an install with no shared instances behaving exactly as today.

Proof:
- `npm test` and `ci-gate` green, and `doperpowers:reviewer-medium` on the PR.
- Merge, and move `v1` by the PATCH rule.
- Then reinstall on the mini with no shared instances, at idle, outside any hold; one Mac set there stays green. This
  ships the new hooks before any concurrency.

### M2 — MAWS: the shared-state fixes and the routing

At the end:
- MAWS's plan can send a named list of groups (`MAC_SHARED_E2E`, empty at first) to `[ci-kit-mac-shared]`, and every
  other Mac job to today's labels;
- exclusive Mac jobs' timeouts carry the 10-minute bound (30 → 40, measured 45 → 55). A group routed shared gets its
  own budget plus the 60-minute shared bound, pinned by a test while the list is empty;
- a test pins the lane's contract: every step of a Mac job that can run after a failed start is an artifact upload, or
  is gated on a step that runs only after admission;
- the e2e build cache is per runner, and the clipboard lock path is machine-wide;
- windows open at a per-instance origin, and the budgets read `CI_KIT_SHARED_DESKTOP`.

With the list empty, nothing behaves differently.

Proof: class 1a on the pool green; one Mac set at the head green (scheduled through CI-opt, never inside a hold); the
PR goes to the MAWS architect, who lands it.

### M3 — Install the shared instances on the mini

After M1 and M2 land, outside any hold or measured window:
- reinstall with `--shared 2`, at idle; the new shared instances start disabled;
- check that both shared runners register with only `ci-kit-mac-shared`, that their `$TMPDIR` equals the exclusive
  instance's, and that each has its own `_work`;
- update the coordinator's hold and release scripts to cover every instance and restore each shared instance's enabled
  state;
- before enabling any shared instance: MAWS's `scripts/ci-gate-alerts.mjs` must fold the `-<n>` suffix (it reads
  `ci-kit-mac-mini-2` as a machine `mini-2`, outside `mini`'s alert), or skip shared runners;
- delete the orphaned `~/Library/Caches/maws-e2e-build/<sha>` entries (M2 moved the cache to `<runner name>/`);
- tell every session that books the mini.

The shared instances are enabled only for trial runs until M4's verdict.

### M4 — Trial and the first proven-shared groups

In a window agreed with the MAWS architect, quiet flag down, nothing else of anyone's on the mini:
1. `unit:darwin` beside itself and beside a quiet group.
2. The audit's first pair, `browser` with `connectors`.
3. Then the frequent quiet groups, each through Design's evidence list.
4. An old commit's exclusive Mac jobs, one functional and one measured, admitted while shared jobs run: each finishes
   within its old timeout, and the measured one's timings stay inside their solo spread.
5. Measured groups beside shared preparation: cold preparation, a download failure, and a cancel-and-replace burst of
   shared jobs during the measured interval. Each measured timing stays inside its solo spread, or sharing is not
   enabled while measured groups can run (Design, the cost).

Run scratch MAWS commits that put the groups under trial on `MAC_SHARED_E2E` (never merged as such).
- Record every run's id, its partner, the overlap, the front-app log and the memory samples in Surprises.
- **Verdict:**
  - a MAWS PR sets `MAC_SHARED_E2E` to the groups that passed;
  - the shared instances are enabled for good;
  - the rest stay on the exclusive instance, with the evidence.

### M5 — Widen the proven-shared set

The MAWS fixes for the groups the audit found unsafe without a change:
- the recorded-directory lock;
- the dashboard clipboard steps;
- deliverables' notification focus;
- the quiet-focus helper where a trial showed activation.

Each group joins `MAC_SHARED_E2E` only through M4's evidence.

### M6 — A third shared instance

Only if M4's and M5's memory reads show room: install it, and run the three-way trial in Design.

The VM lane's milestones follow. They bind as M1–M6 do: nothing of the lane runs on the mini outside a window CI-opt
books, never inside a hold or beside a measured job, and never on the MacBook. V1 is a spike whose deliverable is a
verdict; V2–V4 build what it promotes.

### V1 — The second spike: go or no-go on numbers

**Prototyping.** The question: does a 3 GB or 4 GB macOS 27 guest, with a wide display and a baked image, run MAWS's
functional groups green at an acceptable cost to the host, within the admission rules above? The first spike's 6 GB
guest answered no as an always-on runner (1.30–1.72x host time, swap at boot, two timed rows broken on the host, one
deterministic display failure). This one measures the design's actual shape.

What to build, additively, on the mini: a first `mac/vm/bake.sh` (the bake steps in The image, by hand where the
script is not ready, from the kept base image; no registration), two golden candidates at `--memory 3072` and `4096`,
both `--cpu 4 --display 2560x1440pt`; a throwaway `tart exec`-driven run like `vm-spike-run.sh` in
`~/Developer/ci-analysis` (the MacBook), started from a process in the mini's GUI session (a one-shot `launchctl`
submission, since the display path depends on it), with the host sampler of the first spike extended to the three
memory reads of The memory guard.

What to run and observe, at each memory size, from a fresh MAWS master checkout shared read-only:
1. **Boot.** Time to the guest agent, and the guest's display as Electron reports it (`screen.getPrimaryDisplay()`:
   bounds, `scaleFactor`), with the host at @2x. Expect 2560x1440 at 2.
2. **Setup.** `pnpm install --frozen-lockfile` time from the warm store. Expect under 30 s.
3. **`e2e:document-app` three times** (foreground, the first spike's group), `MAWS_E2E_QUIET=1`,
   `MAWS_E2E_FOREGROUND=1` as its script sets. Expect 19 of 19 each time, and document-narrow's resize to 600 px to
   pass. Each run's time against the host's step median (113 s on 10-20).
4. **`e2e:widgets` three times** (foreground, key focus is what its cases test). Expect green each time.
5. **The host under it:** the three memory reads and the load every 15 s through every run, at the owner's normal
   evening load, Docker quit. One host functional job (`e2e:dashboard`, as in the first spike) beside a busy guest.
   Once, a synthetic surge beside a busy guest (a process that holds 3 GB for two minutes, the journal edition's
   shape), to see which pressure level the host reaches and how fast it recovers: the guard's thresholds are set
   from this.
6. **One timed row beside a busy guest, once:** `e2e:dashboard-scale` on the host while the guest runs
   `document-app`, to confirm the admission rule's necessity at this guest size (the first spike broke its rows at
   6 GB). This row is expected red or outside spread; it is the record, not a pass condition.
7. **The guest's TCC rows and `csrutil status`**, read-only, and whether a job started by `tart exec` sees
   `AXIsProcessTrusted` true (a one-line Swift or Python check).
8. The guest's own swap and pressure at 3 GB during `document-app`, to see whether 3 GB holds an Electron e2e job.

Promote (go) at a memory size when: 3/3 green on both groups; the warm run time at most 1.5x the host's step median;
the host's pressure stays 1 and its swap does not grow across the runs beyond 100 MB; the display reads 2560x1440 at
2x; boot to agent under 60 s. Prefer 3 GB if it passes, since every GB is the owner's. Discard (no-go) otherwise, with
the numbers in Surprises & Discoveries, and the lane stays designed and unbuilt. A partial result (green at 4 GB,
swap at the floor) is a go with the floor raised, recorded.

Proof: the verdict and every number in Surprises & Discoveries; the candidates deleted or kept per verdict; nothing
registered; the mini left as found (`tart list` shows the base and at most the chosen golden).

What it does not touch: no runner registration, no MAWS change, no hook change, nothing on the host's instances.

### V2 — ci-kit: the lane

At the end, `mac/install.sh --vm` installs the launcher on a Mac and `bake.sh --register vm` registers its slot;
the launcher, given a golden image, runs the lifecycle in Design against a fake Tart in tests and the real one on the
mini (V4); settle knows the `vm` condition and the measured claim; the guest's kickoff and hooks exist; and
`docs/mac-lane.md` has a section for the lane.
- **`mac/vm/lane.sh`**, **`mac/vm/vm-admit.sh`** and the LaunchAgent plist: the lifecycle table with every state,
  the one admission under `desktop.lock` (`shared-hold.sh`'s `lock`/`unlock` and marker shape, reused, not copied),
  the recovery with adoption, the idle handshake, the memory guard in every state, the disk reserve, the queue read
  with `gh` through `dialog.sh`'s bounded call and token handling, `vm-lane.lock`, the golden pointer and the trial
  file, the alerts (one open issue per kind, closed when the condition clears, as the stuck-hold alert is).
- **`mac/vm/bake.sh`:** `--bake`, `--register <slot>` with the token on stdin, `--trial`, `--promote`, `--retire`,
  each boot through `vm-admit.sh`, its own hold across its sequence, the reserve check, a free-space report.
- **The exclusive hook's classification:** `job-started.sh` on a Mac with the lane reads the workflow at
  `GITHUB_WORKFLOW_SHA` for the contract line, logs `vm-safe:`, and for an unknown job raises its claim and waits on
  the reservation; `job-completed.sh` drops the claim.
- **`mac/vm/guest/kickoff.sh`**, **`mac/vm/guest/wrapper.sh`** and **`mac/vm/guest/hooks/`:** the identity copy, the
  cache link (`~/Library/Caches/maws-e2e-build` → the `cache` share), the wrapper owning `run.sh --once` detached from
  the exec, the `out/` markers from the listener's diag log and process (`listening`, `session-conflict`, `assigned`,
  `done`), the handshake's answers, the power-off; the hooks as Design cuts them (the desktop check and Terminal from
  the lane's `dialog.sh` and `desktop-check.sh`, the posture line with `vm=` and `clone=`, the display refusal, no
  sweep, no alert, no `gh`). Reuse the lane's scripts by sourcing where they already take their machine name from
  `CI_KIT_MACHINE`; a guest copy exists only where the host script does something the guest must not (`gh`).
- **`mac/settle/settle.sh`:** the `vm` condition, read from the reservation's presence alone, and the measured claim,
  raised at the first read and named in the settle line; the exclusive instance's `job-completed.sh` removes a claim
  naming its worker.
- **`mac/install.sh`:** `--vm` installs the agent (disabled on a new machine, as shared instances are), the slot
  directories, and the exclusive instance's extra label (`ci-kit-mac-solo` is added at registration for a new machine;
  an existing registration's labels are changed from the MacBook by hand, through the labels API or a
  re-registration with `--replace`, which the docs say); refresh and
  `--uninstall` cover the agent; the refusal while a clone runs. Without `--vm`, nothing of the lane exists on the
  machine, and the hooks and settle behave as today (no marker, no extra line).
- **Tests** (`test/mac-vm-lane.test.mjs`, with a fake `tart` that records its calls, whose `run` blocks until a file
  appears, whose `list` reports the state the test sets and whose `delete` fails on a running VM as Tart's does, a
  fake `gh` for the queue and the workflow read, memory and disk reads from an environment override, a fake guest
  wrapper driven through `out/`, and the lock, markers and processes real, as `test/mac-shared-hold.test.mjs` does):
  - the boot rule: each of its conditions refusing alone, and a boot when all hold;
  - a solo job with the exclusive instance idle: no boot; with it busy: a boot;
  - the measured claim parking the launcher, and settle's `vm` condition waiting on the reservation and releasing
    only after the verified teardown; a stale claim ignored;
  - **the interleavings of a dead launcher:** killed during boot and killed during a job, each while settle waits:
    the reservation stands, settle stays parked, the restarted launcher adopts the job or tears down the guest, the
    fake `delete` refused on a running VM keeps the reservation, a stop that fails keeps it and alerts after its
    bound, and settle releases only after `list` shows the VM stopped;
  - **admission across kinds:** a bake asked for under a measured claim, and a claim raised during a bake; a bake
    under a timed hold, and a timed hold during a bake; two hold owners overlapping, one removed, the lane still held;
    a bake's hold with a dead process recovered with its VM;
  - **classification:** the contract line present, absent, an older number, a `gh` failure and an empty
    `GITHUB_WORKFLOW_SHA`: VM-safe only for the first; an unknown job raising its claim, waiting on the reservation,
    refused past the bound in the lane's shape, its claim held to the end hook;
  - **the idle handshake:** an acceptance before the hook, older than `CI_KIT_VM_IDLE`, never stopped
    (`out/assigned`); a stop requested only with nothing queued; `stop-refused` moving to `preparing`; `stop-raced`
    logged, alerted and counted;
  - **the guard in every state:** warning injected in each row of the lifecycle and in recovery, with the stated
    response per state; critical in each; an unknown read admitting nothing;
  - **session recovery:** `out/session-conflict` entering the state, its own bound, its failure counted apart from
    `image`, and three `image` failures pausing while `session` ones do not;
  - **disk:** free space under the reserve refusing a boot and a bake; under half mid-run pausing the next boot;
    under the floor stopping; a marker write on a full volume (a small disk image mounted for the state directory)
    leaving the stricter state;
  - **the golden pointer:** a trial boot from the candidate once and only once, the next boot from the pointer; a
    failed trial leaving the pointer; `--promote` interrupted between its two renames and run again to completion;
    `--retire`;
  - every lifecycle bound, each ending in a verified teardown and a counted failure;
  - `out/listening`, `out/assigned`, `out/job`, `out/done` driving the states;
  - the guest hooks' refusal shapes and that no `gh` is called in the guest;
  - `install.sh` with and without `--vm`, and `--uninstall`.

Proof: `npm test` and `ci-gate` green; `doperpowers:reviewer-medium` on the PR; merge and move `v1` by the PATCH
rule. VA7 is shown by the install tests, and VA8's interface by the pointer tests. Nothing on the mini changes in V2.

What it does not touch: MAWS; the host's admission (`shared-hold.sh`'s states are read, never changed); the dialog
watcher.

### V3 — MAWS: the lists and the routing

At the end, MAWS's plan sends `MAC_VM_E2E` (empty at first) to `[ci-kit-mac-solo]`, keeps measured groups off it,
gives a group on both lists to the shared instances, honours a `Lane: vm` trailer (`ci-gate.sh --lane vm`) by sending
those groups to `[ci-kit-mac-vm]`, carries the exclusive bound in a solo job's timeout, and its budgets read
`CI_KIT_VM_GUEST=1` as a loaded host. `gate.yml` carries the contract line `# ci-kit-vm-contract: 1`, and a test pins
what it promises: every group with a timing bound is on `MEASURED_E2E`, and every `MEASURED_E2E` job's first step is
settle; the line's number moves only with that promise. The alert reader treats `-vm` as its own machine. With the
list empty, nothing else behaves differently, pinned by a test as M2 pins its list.

Proof: class 1a green; one Mac set at the head green, scheduled through CI-opt; the MAWS architect lands it.

### V4 — Install on the mini, the trials, the first proven-VM groups, the mode

In windows CI-opt books, outside holds and measured windows:
1. `install.sh --vm`, the slot registered with a token from the MacBook, the launcher disabled; the exclusive
   instance's labels gain `ci-kit-mac-solo`; `gh api repos/SSFSKIM/MAWS/actions/runners` shows
   `ci-kit-mac-mini-vm` with its two labels, offline.
2. The golden image from V1's chosen candidate, through `bake.sh` as V2 shipped it, with the human's window step;
   `--register vm`.
3. The launcher enabled in `always` mode. One scratch MAWS commit with `MAC_VM_E2E: document-app` and `Lane: vm`:
   the first production-shaped guest job, green, its posture line read, the clone gone after (VA1's shape).
4. **Each candidate group three times in the guest** (`Lane: vm`), the four foreground groups first, then the
   functional groups by queue time: green 3/3, every timing annotation inside MAWS's guest budget, no stall, no
   screenshot difference MAWS's comparisons reject; the guest's p95 at most 10 min. The same fail rules as M4's,
   applied to the guest's own runs against the host's results for the same group at the same sha.
5. **The host beside a busy guest:** a Mac set on the host at one sha (`Lane:` default, the guest kept busy with a
   scratch set), each host group inside its solo spread; a measured job started while a clone runs, settling after it
   (VA3); the guard's samples through all of it (VA5's floor read from them).
6. **Hold rehearsals:** the coordinator's scripts in `~/Developer/ci-analysis` on the MacBook gain the timed form
   (`vm-hold.<session>`, the wait for the reservation) and keep the untimed one; one untimed hold with the lane
   taking jobs (VA1), one timed hold with the lane waiting, a second owner's hold overlapping it (VA4). The booking a
   session makes through CI-opt names the kind.
7. **Recovery rehearsal** (VA10): with a measured job waiting at settle, the launcher is killed during a guest job
   (`launchctl kickstart -k`), then once during a boot; the reservation and settle's wait are read from the logs, the
   adopted job's result from GitHub, the clone's absence from `tart list` after.
8. **A legacy workflow** (VA9): an old MAWS sha with no settle step (f8d701acb5's shape) rerun on the host while a
   clone runs: the hook's `vm-safe: unknown` line, its wait, no boot during it; then a contract commit's functional
   job classified VM-safe beside a clone.
9. **Slot reuse** (VA11): two guest jobs back to back; a clone stopped by hand mid-job (`tart stop`), then the next
   job's listener recovering the session, its time read from `out/_diag` against the 5 min budget; a second boot
   asked for by hand (`bake.sh --trial` during a job) refused by admission.
10. **The host-load transition:** the lane on through one 13:10Z journal hour, the guard's samples and responses
    read from the log (a warning, a given-up guest or a pause, no critical stop expected).
11. **A refresh and a rollback** (VA8, VA12): one candidate baked, trialled green, promoted and the old golden retired,
    with the volume's free space sampled through the bake to set `CI_KIT_VM_DISK_RESERVE`; then a deliberately broken
    candidate (its runner directory removed) trialled, its trial red, the pointer and golden unchanged, the candidate
    deleted by hand.
12. **The verdict:** a MAWS PR sets `MAC_VM_E2E` to the groups that passed; the mode stays `always` if step 5 held,
   else `hold-only`, recorded with the evidence; the launcher enabled for good; every run's id, group, clone, memory
   samples and timings in Surprises & Discoveries.

Proof: VA1–VA6 and VA8–VA12 shown on the mini and recorded.

### V5 — Widen the proven-VM set; the second guest

Groups that failed a trial for a cause MAWS can fix (a budget, a path, a grant it can do without) join `MAC_VM_E2E`
through step 4's evidence. The second guest only with the memory evidence Design names, its own identity, and a
two-clone trial. A group on both lists stays shared; if holds keep stalling shared groups, a later change may let a
hold-aware plan send them to the guest, which this spec leaves open.

## Verification

- Spec: two `doperpowers:adversarial-reviewer` rounds, done. A third, focused on the admission lock and its recovery,
  runs on this revision while M1 is built; its findings reach M1 before its PR is reviewed.
- M1: `doperpowers:reviewer-medium`, ci-gate, and the one-instance reinstall on the mini staying green.
- M2, M5: the MAWS architect lands each, on a green class 1a and a green Mac set.
- M4: Design's evidence and fail rules, checked by the spec's owner against the run logs.
- The VM lane: one `doperpowers:adversarial-reviewer` round on the first design (done, PR #81: four P1s and four P2s,
  all taken, Decision Log); a second round on this revision before V2's PR is reviewed, focused on the reservation's
  recovery, the one admission across kinds, the classification and the handshake. V1: its verdict against its
  criteria, by CI-opt. V2: `doperpowers:reviewer-medium`, ci-gate, and the interleaving tests Design names. V3: the
  MAWS architect. V4: VA1–VA6 and VA8–VA12 on the mini, checked by CI-opt against the launcher's log and the run logs.

## Decision Log

- 2026-10-21: **Lease on the host, not VMs or a second Mac.** The owner ruled for parallelism and pointed at the
  mini's idle CPU. A second Mac was declined on 10-21's measurement, and the Tart VM runner was put on hold by the
  owner after the spike: 1.3–1.7× slower e2e, and a display-geometry difference that failed a case. The host lease
  keeps the calibrated desktop and costs nothing new.
- 2026-10-21 (review of the first draft, all taken): **labels and a shared hold replace the reader-writer lease.**
  The adversarial review (astra) found six P1s in the lease taken by hooks:
  1. Admission was not fail-closed: old workflows and unlisted groups ran shared.
  2. The runner prepares a job before its hook, so a hook-held lease admitted neighbours' preparation into a measured
     job.
  3. One shared hook copy swept the wrong instance's `_work`.
  4. Waiters and the mutex had no crash recovery.
  5. A dead worker's leftovers were admitted beside the next holder.
  6. An upgraded job inherited a desktop its own start had not checked.

  It also found two P2s: the trial authorized combinations it never ran, and the waits exceeded MAWS's job timeouts.
  Labels make admission fail closed before any runner accepts a job. Stopping the shared instances' listeners keeps
  their preparation out. Per-instance identity, sweep-before-release, a reconciling watcher, a kernel-released lock,
  and the desktop check after the neighbours stop answer the rest. Evidence per group, and a timeout raise, answer the
  P2s. The cost: an exclusive job waits for running shared jobs to end (bounded), and the exclusive instance serves no
  shared job.
- 2026-10-21 (second review, all taken): **admission in the hooks under one lock; no listener is stopped.** The
  second adversarial review (astra) found two P1s and two P2s in the second draft:
  1. A shared wrapper could pass its check, stall, and start after the exclusive hook read it as stopped. It was
     reproduced with the unmodified `runner-hold.sh` and a fake service.
  2. The drain's SIGTERM could land after a listener accepted its next job, leaving the job in progress on an offline
     runner or cancelling it. Every exclusive admission would have exposed shared jobs to this.
  3. The `self-hosted` label let a bare `runs-on: self-hosted` job reach a shared instance.
  4. An old commit's exclusive job kept its old timeout but met the new 20-minute wait.

  The fixes:
  - Both sides now check and write under one `flock`, so there is no window between a check and a write, and no
    listener is ever stopped.
  - Shared instances carry `ci-kit-mac-shared` alone.
  - The exclusive wait bound drops to 10 minutes, and M4 admits only groups whose p95 is at most 8, so an old workflow
    still fits its old timeout (Time budgets).

  The alternatives rejected:
  - A runner-supported one-job lifecycle (ephemeral or JIT shared runners). It is race-free at the server, but it
    needs a credential on the mini that can register runners, readable by every job running as the same user.
  - Detecting and rerunning jobs lost in a shutdown. It needs an `actions: write` token on the mini, and it still
    loses the job once.

  The costs taken:
  - Round one's objection returns in bounded form: a shared job assigned during an exclusive job prepares beside it,
    3–4 s, at most once per shared instance per exclusive job.
  - A parked shared job burns its own timeout, which is why its budget carries the shared bound.

  Chosen with M1's builder:
  - the dialog drain's marker parks shared admission, and the hold keeps a single owner;
  - the exclusive sweep spares live shared workers and their descendants;
  - each shared instance keeps its enabled state across a re-install;
  - a stuck hold opens one alert issue.
- 2026-10-21 (third review, all taken): **claims last to the job's end, and recovery runs under the lock.** The third
  adversarial review (astra) of the lock found:
  1. P1: a refused hook is not an abort. Later `failure()`/`always()`/`!cancelled()` steps run, so a start refused
     after dropping its claim could run work beside a neighbour.
  2. P1: crash recovery swept after two idle reads but outside the lock, and could kill the next exclusive job started
     in between. It was reproduced on a pure process table against `selectStrays`.
  3. P2: preparation beside an exclusive job recurs in failure cases (failed initialization, cancellation, download
     retries), so the "once, 3–4 s" bound held only in the common case.

  The fixes:
  - Claims are held until the end hook.
  - The contract for post-refusal steps, pinned by MAWS.
  - Recovery runs under the lock, and every sweep spares all live workers.
  - M4 evidence for measured groups beside preparation bursts, with a stated fallback.

- 2026-10-21 (M1's builder, from the runner source): **no runner-level abort.** The alternative was to end a refused
  job by sending SIGKILL to its own `Runner.Worker`. The runner source (v2.338.0) shows it would work mechanically: the
  listener reads the signalled exit as a worker crash and reports the job Failed (`JobDispatcher.cs` L543–601), it
  keeps dispatching (`Runner.cs`), and no further step runs, since the end hook and post steps run inside the worker
  (`JobExtension.cs` L572–581). It was rejected for two reasons:
  - The `ci-kit: … rerun` line would likely never reach the job's log, because the worker uploads its own step logs.
    The caller would see a worker crash, not a refusal.
  - The end hook would never run, so a claim could be released only by staleness or the watcher's reconcile.

  The contract on post-refusal steps stands.
- 2026-10-21: **`tool-time-heavy-live` stays exclusive** while it is in `MEASURED_E2E`, though its code is safe beside
  others. Dropping it from that list is MAWS's call.
- 2026-10-21 (evening, the owner): **A VM lane, reversing "No VM".** The morning's entry declined the Tart runner on
  the spike's numbers: a 6 GB guest, always on, slowed e2e 1.3–1.7x, pushed the host into swap and broke two timed
  rows beside it. The owner reopened it tonight with a 3–4 GB guest, for what the host lease cannot give: a second
  desktop, so foreground and other desktop-bound jobs run beside the host's and keep running through the untimed GUI
  holds that cost about 9 h on 10-20. The strongest alternatives: a second Mac (declined on 10-21's measurement; it
  is the answer if the lane's throughput is not enough, and `docs/mac-lane.md` already says how to add one); a
  per-minute hosted macOS runner (no vendor documents a logged-in GUI session with TCC grants for an Electron e2e;
  Apple's 24-hour lease minimum for the dedicated kind); doing nothing and taking the holds (the owner's ruling is
  against it). The cost taken: 1.3–1.7x per guest job, about 45 s of boot, and 3–4 GB of a tight 16 GB, admitted job
  by job.
- 2026-10-21 (evening): **A registered runner started once per clone, not a just-in-time registration.** The
  ephemeral-runner pattern every Tart runner project uses (cirruslabs' own guides, KnobanLabs' and tartelet's
  per-job clones, `github-tart-runner`) mints a JIT configuration per job with `Administration: write` on the
  repository. On the mini that token would sit in a file every host job can read, which is what this spec's second
  review rejected for the shared instances. The runner's own once mode gives the same one-job lifecycle with no
  credential beyond the runner's registration files, whose exposure the host already has; it is marked for future
  deprecation but present (actions/runner `Runner.cs`, read 10-21). JIT lost on the credential; it returns as the
  fallback if `--once` goes, as the owner's decision on the token.
- 2026-10-21 (evening): **The runner is started through `tart exec` and powers the guest off itself,** not through
  a LaunchAgent in the image with the host polling it, and not over SSH. `tart exec` goes over the VM's control
  socket to the guest agent, so no host process connects to the guest's address (the Local Network prompt the spike
  flagged); what the guest agent starts inherits the base image's TCC rows, which a launchd `/bin/bash` would not;
  and `tart run` exiting on the guest's power-off is a signal the launcher cannot misread, where the drain's
  experience on the host shows what judging a runner's state from outside costs. SSH lost on the address and the
  prompt; a LaunchAgent in the image lost on the grants and on the state the host would have to read.
- 2026-10-21 (evening): **Boot on demand from a queue read, not a guest kept waiting.** A booted idle guest holds
  2–3 GB on a host where memory binds; a clone booted only for a queued job holds nothing between jobs and costs
  about 45 s per job. The read is `gh` with the owner's login on the mini, as the alert's is (`Actions: read` is all
  it uses), every 15 s. The alternative that removes the poll, a `workflow_job` webhook relayed from the pool's
  receiver to the mini, stays open for later; the poll's cost is a few calls a minute.
- 2026-10-21 (evening): **`ci-kit-mac-solo` on both the exclusive instance and the guest,** so a job that needs a
  desktop to itself takes whichever is free, by GitHub's own assignment. A VM-only label was the brief's first shape;
  it lost because routing is static per group, and a group pinned to the guest would wait for the one slot while the
  host sat idle outside holds. `ci-kit-mac-vm` stays for trials and forcing. The cost: the launcher must judge whether
  the host will take a solo job first (the boot rule's second condition), which is a local read.
- 2026-10-21 (evening): **Measured jobs keep the guest out through settle, which now holds a claim.** The job-started
  hook cannot tell a measured job (`GITHUB_JOB` is `e2e` for every group); a label routes and cannot claim; settle is
  the one step only measured jobs run. So settle gains the `vm` condition and raises the measured claim, the one
  exception to "settle holds nothing" above, named there. The lane never stops a running clone for a measured job;
  the job waits, bounded by the guest list's p95.
- 2026-10-21 (evening): **The memory guard reads the kernel's pressure level and available percentage, and pauses
  before it stops.** A fixed schedule (no guest 13:00–14:30Z) was the alternative; it is kept as a knob for a guard
  that flaps, because the journal hour's Chrome is predictable but the owner's other use is not. A balloon device,
  which would let the host reclaim guest memory, is not exposed by Tart.
- 2026-10-21 (evening): **The display is set in points at the mini's own geometry, from a GUI-session launcher.** A
  pixel size gives a 1x guest at 72 PPI (Tart's Darwin path); an in-guest mode change is unverified. The cost: the
  guest's density is the host screen's at boot, so the launcher boots only at @2x and the guest's hook refuses a
  wrong geometry.
- 2026-10-21 (evening): **No TCC grant of the lane's own in the guest, and no SIP change anywhere.** The base image's
  rows, inherited through the guest agent, already exceed the host's grants for the groups that run today. The
  SIP-off path in the guest is the owner's fork, opened only with a group that needs a grant the image lacks.
- 2026-10-21 (evening): **Heavy state is baked, hooks are shared.** The store, Electron's download, Node, pnpm,
  LibreOffice, the runner and the compiled helpers cost minutes to make and change rarely; the hooks change with the
  kit and cost nothing to read from a share at each boot, so a hook fix needs no image refresh.
- 2026-10-21 (evening): **Untimed holds keep the lane running; timed holds pause it; the booking names which.** The
  alternative, every hold pausing the lane, would give the lane nothing during the holds that cost the most.
- 2026-10-21 (late, the adversarial review of PR #81, all taken):
  1. **The reservation is the VM's, not the launcher's.** The draft read a dead launcher as a stopped guest and
     deleted at start; `tart run` is detached, and Tart refuses to delete a running VM. Now the reservation is cleared
     only after Tart shows the VM stopped, a stop that fails keeps it, and recovery adopts a running job rather than
     kill it. The alternative, a reservation tied to the launcher's pid, is what the shared hold does for its worker,
     and it is wrong here because the guest is not the launcher's child.
  2. **One admission for every guest, and holds per owner.** The draft let the bake boot beside admission and gave
     every holder one file, so a bake could run under a timed hold and one owner's release could drop another's.
     Now `vm-admit.sh` is the only way a guest boots, with a kind, and each owner holds its own file. Rejecting a
     second owner atomically was the alternative; it lost because a coordinator's hold and a bake's are both
     legitimate at once, and the union is what the lane must respect.
  3. **Host jobs are classified by their workflow's contract line, and the unknown keeps the guest out.** Settle
     covers only workflows that run it, and MAWS's history holds commits without it or with an incomplete measured
     list. The alternative, keeping such workflows off the host while the lane is enabled, cannot be enforced on a
     rerun of an old sha. The cost taken: one bounded read of the workflow per exclusive job, and an old sha's run
     waits for a running guest.
  4. **Assignment is tracked from the listener, and the idle stop is a handshake.** The draft's idle timeout ran from
     boot to the job-started hook, which GitHub's preparation can delay for minutes; the wrapper now writes
     `out/assigned` from the listener's own record, the launcher only asks for a stop, the wrapper refuses one with a
     job taken, and an acceptance that races the stop is reported, never silent. The alternative, never stopping an
     idle guest, holds 2–3 GB of a host where memory binds for as long as nothing arrives.
  5. **Supervision runs from `tart run` to the verified end, and warning has a bounded response.** The draft sampled
     only while running and acted only at critical; now every state is sampled, warning gives up a guest that holds no
     job and pauses the next boot behind one that does.
  6. **Session recovery is a state with its own budget.** A reused identity whose last listener died mid-job meets
     "session already exists" and the runner retries for up to 4 min; counting that as an image failure would pause
     the lane for a healthy image, so it is told apart and given 5 min.
  7. **A disk reserve gates every boot and bake, and a floor stops.** Tart's prune is not an admission gate, and
     clones allocate as they write. The reserve's default follows V4's measured bake peak.
  8. **The golden image is a pointer; a candidate is trialled through one job boot and promoted by a rename that is
     safe to repeat.** The draft's "trial, then rename" had no owner and no path through admission. Now the trial is a
     launcher boot of kind `trial`, consumed once, the pointer moves only after a green trial, and an interrupted
     promote completes when run again. The alternative, baking in place over the golden image, loses the last good
     image on a failed bake.

## Surprises & Discoveries

- 2026-10-21, M1 (ci-kit #67), from its reviews:
  - **A cross-instance sweep uses the caller's own `sweep.mjs`, with `--work <dir>`**, not the target instance's copy.
    A half-installed shared directory (no hooks yet) otherwise refused every exclusive job. Each job's own sweeps still
    find their `_work` from their own location.
  - **The target is matched by its real path** (`realpathSync`): `lsof` reports physical paths, so a symlinked home
    hid leftovers.
  - **Workers are known by the kernel's executable path** (`runner-state.py --workers`, read right after the `ps`
    snapshot; a failed read kills nothing). `ps` cannot identify a worker by its executable: it prints argv[0] and
    unquoted command lines, so a path with a space made a live parked hook look like a leftover.
  - **Waits:** the exclusive start waits up to 180 s for the lock, because a recovery sweep under it is bounded at
    120 s. Shared starts retry inside their own bound.
  - **Debt** (PR body; ci-kit #44 for the watcher):
    - leftovers that survive a shared job's end sweep sit beside other shared jobs until the next exclusive admission;
    - a leftover with the symlinked path only in its arguments is not matched;
    - parked jobs poll the lock about once a second.

- 2026-10-21, M2 (MAWS #103):
  - **The runner-name contract.** MAWS reads an instance's number from the trailing `-<n>` of `RUNNER_NAME`
    (`ci-kit-mac-<machine>-<n>`), and fails a launch under `CI_KIT_SHARED_DESKTOP=1` without it. M1 keeps that naming
    and documents it.
  - **Bounds M4 must weigh before sharing a group:**
    - `browser-chrome`'s 34 ms "no hole" check is the product's `STILL_SETTLE_MS`, not a test bound, so it cannot go
      through the latency budget;
    - `scm`'s 150 ms bound tells the stage's own refresh from the watcher's 250 ms debounce, which it can no longer do
      at the budget's 5× ceiling;
    - `unit:darwin`'s `--maxWorkers` is not halved when shared, as the audit suggested. Decide it before trialling
      `unit:darwin` with itself.
  - **`packaged`'s upload** is not gated on its checkout, unlike e2e's. After a refused start it would upload the
    previous job's reports. The contract allows it, since no desktop is used, but it is a correctness wart for MAWS's
    tracker.

- 2026-10-21 (evening), designing the VM lane (read from sources, not yet observed on the mini):
  - **The base image already carries TCC rows.** cirruslabs' `macos-image-templates` writes Accessibility, Screen
    Capture and PostEvent rows for the Tart guest agent, `osascript`, `sshd-keygen-wrapper` and Python into both TCC
    databases with `sudo sqlite3` (`scripts/update-tcc-database.sh`; on macOS 27 it finds the user database under
    `/private/var/containers/Data/ProtectedSystem/`), and never runs `csrutil`. Its vanilla template disables
    Gatekeeper (`spctl --global-disable`). Both change what the lane has to do: start the runner under the guest agent,
    and expect no quarantine prompt for LibreOffice.
  - **Tart's display unit decides the density.** `tart set --display` takes `pt` or `px`; `pt` (the macOS default) is
    passed with the host's main screen, `px` is 72 PPI (`Platform/Darwin.swift`). The spike's guest at 1024x768 @2x
    is the default size through the point path; why its `--display 1920x1200` did not take is not explained by the
    source read, and V1's first step reads `tart get` on the candidate before booting it.
  - **`tart exec` is not SSH.** It is gRPC over the VM's control Unix socket to the guest agent (`Exec.swift`), which
    is why the lane never touches the guest's address.
  - **The runner's `--once` is alive** in actions/runner `main`, with a warning that it is "going to be deprecated in
    the future"; the once mode and the ephemeral setting share one code path.

## Outcomes & Retrospective

(At completion.)
