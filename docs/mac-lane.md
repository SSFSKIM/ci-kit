# The mac lane

Each Mac in the lane runs GitHub Actions runners for `SSFSKIM/MAWS`, so MAWS's macOS-bound gates (its Electron e2e
above all) run there instead of on the MacBook. The design is §4 of the
[spec](doperpowers/specs/2026-10-15-ci-kit-design.md); the contract is I10. A Mac's runners are its
[instances](#instances-and-the-shared-hold): the exclusive one, which runs each job alone on the desktop, and the shared
ones a machine opts into, which run beside each other
([design](doperpowers/specs/2026-10-21-mac-lane-concurrency-design.md)).

| | The mini | The second Mac |
|---|---|---|
| Machine | Mac mini, M2 Pro, 16 GB, macOS 27.0, the owner's | a rented cloud Mac mini ([Adding a Mac](#adding-a-mac)) |
| Reached as | `ssh mini`, user `new` | `ssh <host>`, user `new`; VNC for the owner |
| Runner | `ci-kit-mac-mini` | `ci-kit-mac-<name>` |
| Shared runners | `ci-kit-mac-mini-<n>`, n ≥ 2, once installed | `ci-kit-mac-<name>-<n>`, likewise |
| `CI_KIT_MACHINE` (messages, alert) | `mini`: "on the mini" | `<name>`: "on the <name>" |
| Alert credentials | the owner's own `gh` login | `~/.config/ci-kit/alert-token`: can only write issues on `SSFSKIM/ci-kit-sandbox` |
| Other runners | `actions-runner-ida-solution` (another repository's, independent and untouched) | none |

On every machine:

| | |
|---|---|
| Session | `new`'s logged-in GUI session |
| Registration | `SSFSKIM/MAWS`, at repository level, non-ephemeral |
| Labels | the exclusive instance: `self-hosted`, `macOS`, `ARM64` (what MAWS's `gate.yml` targets), `ci-kit-mac`; a shared instance: `ci-kit-mac-shared` alone |
| Directory | the exclusive instance: `~/actions-runner-maws` (work directory `~/actions-runner-maws/_work`); shared instance n: `~/actions-runner-maws-<n>` |
| LaunchAgent | `com.ssfskim.ci-kit.mac-runner` (shared instance n: `com.ssfskim.ci-kit.mac-runner-<n>`) — RunAtLoad, KeepAlive, `ProcessType` Interactive, Aqua session only; its program is the instance's own `runner-hold.sh`, which execs the runner's `runsvc.sh` unless the dialog watcher holds the runners |
| Hooks | `<instance>/ci-kit/hooks/job-started.sh` (admission on a Mac with shared instances, the desktop check, then the sweep), `job-completed.sh` (the [drain](#the-drain)'s job end, then the sweep, then the admission's release), a full copy from `mac/hooks/` in each instance |
| Dialog watcher | `com.ssfskim.ci-kit.dialog-watch`, one per machine — RunAtLoad, every 60 s, `ProcessType` Background, Aqua session only; runs the exclusive instance's `dialog-watch.sh` ([below](#the-dialog-watcher)) |
| Logs | `~/Library/Logs/ci-kit/mac-runner-hooks.log` (the hooks and the watcher, every instance's), `mac-runner.out.log` / `.err.log` (the exclusive runner; shared instance n's are `mac-runner-<n>.*`), `dialog-watch.err.log`, `<instance>/_diag/` |
| State | `~/Library/Logs/ci-kit/dialog-alert.state` (the dialog episode), `runner-drained` (the watcher's hold on every runner); with shared instances, `desktop.lock`, `shared-hold`, `shared-running-<n>` and `shared-hold.alert` ([the shared hold](#instances-and-the-shared-hold)) |

**Why a LaunchAgent.** Electron windows need a WindowServer, which only the user's GUI session has; a LaunchDaemon runs
outside it. **Why one exclusive runner per machine.** e2e groups contend for the desktop (focus, pointer, clipboard), so
a job that has not been shown to be safe beside another runs alone: on the machine's exclusive instance, the only one
carrying the labels MAWS's jobs ask for. Every exclusive runner of the lane carries the same labels, so GitHub gives
each job to whichever machine is idle, and one run's groups can split across the machines (the jobs API's
`runner_name` says where each ran). SSFSKIM is a user account, which has no runner groups, and the lane has no
per-machine label: to keep jobs off a machine, disable its agents (below). Groups shown to be safe beside each other
ask for `ci-kit-mac-shared` instead and run on the shared instances ([below](#instances-and-the-shared-hold)).

**Never other repositories' code.** The runners are registered to MAWS alone, and the kit's planner refuses the `mac`
lane on a public repository, so no stranger's fork can reach the lane's machines.

## Which jobs it takes

MAWS's `gate.yml` decides, from its repository variables and the pushed commit's trailers:

- `GATE_RUNNER=macos` sends every job there (plan, static, unit, probes, e2e).
- `GATE_E2E_RUNNER=macos`, a `Runner: macos` trailer (`scripts/ci-gate.sh --runner macos`) or a dispatch with
  `runner=macos` sends the e2e jobs there.
- With neither variable set (the state on 2026-10-15), only runs that ask for `macos` reach the lane; every other job
  stays on `ubuntu-24.04`.

Setting those variables is maws-fe's call (proposal P4), not the kit's.

## Install, update, remove

Everything runs from the MacBook. `mac/install.sh` runs on the Mac from a checkout of the kit there; it copies what
the runner needs into `~/actions-runner-maws`, so the checkout can move on afterwards. The commands name the mini; for
another machine, use its `ssh` host and runner name.

```bash
ssh mini 'git -C ~/Developer/GitHub/ci-kit pull --ff-only || git clone https://github.com/SSFSKIM/ci-kit ~/Developer/GitHub/ci-kit'
ssh mini '~/Developer/GitHub/ci-kit/mac/install.sh --check'      # prerequisites only; a gap is reported, never installed
ssh mini '~/Developer/GitHub/ci-kit/mac/install.sh'              # a registered runner: refresh and reload
#   expect: ci-kit mac: running: ci-kit-mac-mini listens for jobs of https://github.com/SSFSKIM/MAWS; the dialog watcher com.ssfskim.ci-kit.dialog-watch runs
gh api repos/SSFSKIM/MAWS/actions/runners --jq '.runners[]|[.name,.status,.busy]|@tsv'
#   expect: ci-kit-mac-mini  online  false
```

Registering (a new machine, or the mini again after a removal) pipes a token and names the runner, and adding shared
instances pipes a token for theirs:

```bash
gh api -X POST repos/SSFSKIM/MAWS/actions/runners/registration-token --jq .token \
  | ssh mini '~/Developer/GitHub/ci-kit/mac/install.sh --name ci-kit-mac-mini'
gh api -X POST repos/SSFSKIM/MAWS/actions/runners/registration-token --jq .token \
  | ssh mini '~/Developer/GitHub/ci-kit/mac/install.sh --shared 2'   # ci-kit-mac-mini-2 and -3, installed disabled
```

- **The token** is read from stdin only while the runner is unregistered, and handed to the runner's `config.sh`
  through its environment (`ACTIONS_RUNNER_INPUT_TOKEN`), so it never lands in a file, an argument list or `ps`. It
  expires after an hour.
- **The name** is needed only to register, and has no default: `config.sh --replace` takes over any registration of
  the same name, so a default would let a new Mac take the mini's. A re-run reads the registered name from the runner's
  `.runner` and refuses a different `--name`; renaming is a removal and a new registration. The part after
  `ci-kit-mac-` is the machine's short name, which the hooks' messages and alert use ("on the mini"). It must be
  lowercase letters, digits and `-`, because the alert title carries it ([the contract](#the-alert-title)); `install.sh`
  refuses any other name before anything changes. A new machine's short name, or that of one with shared instances,
  may not end in `-<number>`: `ci-kit-mac-mini-2` is the mini's first shared runner, and `--replace` would let a
  machine named `mini-2` take it over.
- **Shared instances.** `--shared <n>` sets their count: instances 2 to n+1, each named `ci-kit-mac-<machine>-<i>`
  after the machine and registered with `--labels ci-kit-mac-shared --no-default-labels`, so it carries that label
  alone. One token on stdin registers every instance that needs it. Without `--shared`, a re-run keeps the count
  installed (the shared LaunchAgents), and a machine with none has none: sharing is opted into. Lowering the count
  unloads the extra instances and removes their LaunchAgents; their registrations and directories stay, as an
  uninstall leaves them.
- **Re-running** (no token, no name) refreshes every instance's hooks, `.env` and `.path`, and every LaunchAgent, and
  reloads them, the watcher's first. It refuses while a job runs on any instance, because reloading an agent kills its
  job; a job is a process whose executable is that instance's `Runner.Worker` (`runner-state.py`, below). The
  exclusive instance ends enabled, as before. **A shared instance keeps the enabled state launchd has for it**
  (`launchctl print-disabled`; a state that cannot be read counts as disabled), and a new one is installed disabled,
  so a refresh never turns a shared instance on or off: that is done per instance (below). While the watcher holds the
  runner, the install loads it held and says so (`loaded, held by the dialog watcher (…)`) instead of waiting for it
  to listen: it starts when the episode closes. New hooks and the optional
  compiled cursor helper are staged and checked in a sibling directory. Darwin's atomic `RENAME_SWAP` exchanges
  that directory with `ci-kit/hooks/`, so the fixed hook paths in `.env` never disappear between renames: a job
  starting during publication finds either complete set. Copy or validation failures leave the old set untouched;
  a Swift compile failure still warns and installs without the optional helper.
- **Prerequisites** checked on the PATH jobs get: Node ≥ 22.12 (MAWS's `engines`), corepack, the Xcode command line
  tools' `clang` (native modules such as `node-pty`), `python3` (node-gyp), git, and LibreOffice's `soffice` (the
  document groups), found but not launched. MAWS's setup action installs its own Node 22 and pnpm per job into the
  runner's tool cache; the system Node runs MAWS's plan job when it lands here (`GATE_RUNNER=macos`) and the hooks. A
  Homebrew install that asks no password closes a gap; anything that needs one goes to the human.
- **The runner version** is pinned with its checksum in `install.sh` for the first install; after that the runner
  updates itself, as GitHub requires.
- **Environment.** `.env` sets `LANG=en_US.UTF-8` (the mini's locale is Korean, and jobs parse tool output), the two
  hook variables (each instance's own copy of the hooks), and `CI_KIT_MACHINE`, the machine's short name, the same in
  every instance. A shared instance's adds `CI_KIT_SHARED_DESKTOP=1`, which its jobs read to know the desktop has
  neighbours (MAWS's latency budgets treat the host as loaded under it). `.path` is Homebrew's tools, then the
  system's.

Disable and enable, one instance at a time (the runner stays registered; GitHub shows it offline, and removes a
self-hosted runner after 14 days offline). Disabling boots the agent out, which kills a running job: do it while the
runners list shows that runner `busy` false. The watcher never loads, unloads, enables or disables an agent, so a
disabled runner stays off whatever its [drain](#the-drain) does. **A hold, a human's or a coordinator's, covers every
instance**: boot out and disable each agent, `com.ssfskim.ci-kit.mac-runner` and every
`com.ssfskim.ci-kit.mac-runner-<n>`, and bring back only those that were enabled.

```bash
host=mini agent=com.ssfskim.ci-kit.mac-runner   # the machine's ssh host; a shared instance's is com.ssfskim.ci-kit.mac-runner-<n>
ssh $host "launchctl bootout gui/\$(id -u)/$agent; launchctl disable gui/\$(id -u)/$agent"
ssh $host "launchctl enable gui/\$(id -u)/$agent; launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/$agent.plist"
ssh $host 'launchctl print-disabled gui/$(id -u) | grep ci-kit'   # which agents are enabled
```

`install.sh --disabled` installs or refreshes with every runner's agent left disabled. The watcher runs in every mode:
a machine kept off CI still reports a dialog.

Remove, one machine at a time (`config.sh remove` deletes only the registration that machine holds). `--uninstall`
unloads and removes every instance's LaunchAgent and the watcher's, the watcher's hold and the shared hold, and refuses
while a job runs on any instance:

```bash
host=mini   # the machine's ssh host
ssh $host '~/Developer/GitHub/ci-kit/mac/install.sh --uninstall'
for dir in actions-runner-maws actions-runner-maws-2; do   # every instance's directory
  gh api -X POST repos/SSFSKIM/MAWS/actions/runners/remove-token --jq .token \
    | ssh $host "read -r t; cd ~/$dir && ACTIONS_RUNNER_INPUT_TOKEN=\$t ./config.sh remove && cd && rm -rf ~/$dir"
done
```

A rented Mac being given back also loses the janitor and the alert token; revoke the token on GitHub once no machine
holds it:

```bash
ssh $host '~/Developer/GitHub/ci-kit/host/install.sh --uninstall; rm -f ~/.config/ci-kit/alert-token'
```

## The job hooks

Every instance runs its own copy of the hooks, and each hook acts on the instance that runs it: the sweep finds its
work directory from where its copy sits. On a Mac with shared instances, the job-started hook first admits the job to
the desktop ([the shared hold](#instances-and-the-shared-hold)); on one without, it is the hook described here.

**A system dialog in front fails the job at once.** Before anything else, the job-started hook
(`mac/hooks/desktop-check.sh`) reads the frontmost app with `lsappinfo`. If it is `UserNotificationCenter`,
`CoreServicesUIAgent`, `SecurityAgent` or `loginwindow`, a system dialog or the login screen holds key focus, and every
e2e group would fail on focus and pasteboard (2026-10-16: seven groups red with `UserNotificationCenter` frontmost).
Each is known by its bundle id as well as its name (`mac/hooks/dialog.sh` holds the one list the hook and the watcher
share), because `lsappinfo`'s names are localized. Messages and titles always carry the canonical name. The job then
fails at "Set up runner" with:

```
ci-kit: a system dialog (<dialog>: <likely source>) holds focus on the <machine> since <first seen> — dismiss it there and rerun
ci-kit: a system dialog (SecurityAgent: security request from codesign) holds focus on the mini since 2026-10-17T05:12Z — dismiss it there and rerun
```

`<machine>` is the runner's `CI_KIT_MACHINE` (`mini` on the mini). `<first seen>` is the dialog episode's, the same
time its alert title carries ([below](#the-dialog-watcher)). Every refusal line starts with `ci-kit: ` and ends with
`rerun`; MAWS's `scripts/ci-gate.sh` tells a refused job by that shape. Dismissing the dialog is the human's, in
that machine's GUI session (never an agent, never cua). The check uses `lsappinfo` alone: AppleScript or System Events
would raise TCC prompts. When `lsappinfo` fails or prints nothing, the job is not blocked; the miss is logged. Every
check logs a `desktop-check` line (the frontmost app) to the job's log and the hooks log.

**The alert.** A refused job opens the machine's dialog episode, and its `ci-kit-alert` issue in
`SSFSKIM/ci-kit-sandbox`, when none is open. The dialog watcher ([below](#the-dialog-watcher)) shares the episode and
closes it. `gh` runs with the token in `~/.config/ci-kit/alert-token` when that file exists, handed over as `GH_TOKEN`
in its environment (never an argument, never printed); otherwise, or when the file is empty or unreadable (logged),
with the account the machine's user is logged into. A failed or timed-out `gh` call is logged and never changes the
job's result.

**Every job starts with Terminal in front.** Some of MAWS's paste and to-human results depend on the app in front, and
what is in front depended on what came before: Finder when an e2e app quits, or Chrome after a test leaked an open-URL
into the owner's browser (2026-10-16). So whenever any app other than Terminal is in front (after the dialog check),
the hook runs `open -a Terminal`, which goes through LaunchServices (no Apple Events, no Automation consent), and
re-reads the frontmost app for up to about 5 s. The job log gets `frontmost before=<app> after=Terminal`. If Terminal is
not in front by then, the job fails at "Set up runner":

```
ci-kit: Terminal did not come to the front on the <machine> (<name> is) — check its desktop and rerun
```

Terminal is told by its bundle id, `com.apple.Terminal`: `lsappinfo`'s names are localized, and the mini shows
Terminal as `터미널`. System dialogs are never touched, and an unreadable frontmost app still lets the job run. The hook
acts only before the job, so it never fights MAWS's own `MAWS_E2E_FOREGROUND=1`, and it does take the front from
whoever is using the machine's desktop when a job starts.

**Desktop posture is visible in the job log.** After start's Terminal/cursor work, and at job completion before
cleanup can hide a leaked app, `desktop-posture.sh` prints one line to stdout and the hooks log:

```text
ci-kit desktop (start): frontmost=Terminal display=2560x1440@2x remote=parsec load=3.12/2.87/2.51 computeruse=none
ci-kit desktop (end): frontmost=Google Chrome display=2560x1440@1x remote=none load=15.70/11.06/6.38 computeruse=SkyComputerUseService,cua-sandbox-golden
```

- `frontmost`: the same localized `lsappinfo` name the desktop check reads, through its read-only `--frontmost` mode.
- `display`: the main display's size in points and backing-framebuffer scale. `cursor-park --describe` reads
  `CGDisplayBounds` and the current mode's pixel/point width ratio; it does not move the cursor. A missing, failing or
  timed-out helper gives `unknown`, so a HiDPI-to-1x switch is visible without running `system_profiler`.
- `remote`: `parsec`, `screensharing`, both comma-separated, or `none` when neither signal is present. Parsec tracks the
  newest `user#id connected.` / `disconnected.` event **per client** in `~/.parsec/log.txt` and reports `parsec` while
  any observed client remains connected: Alice connecting, Bob connecting, then Bob disconnecting still leaves Alice.
  parsecd's own start line (`===== Parsec: Started =====`, written at login, after a reboot or an update) clears every
  client, since none survives it, so a log that has rotated at parsecd's start reads `none` until someone connects.
  An absent log means no Parsec signal, while an unreadable log or one with neither a start line nor connection
  history is unknown.
  Screen Sharing is `screensharingd` running, matched by its exact name in the same non-root `ps -axco pid=,comm=`
  table the computer-use read uses. launchd holds the Screen Sharing listener and starts the daemon when a viewer
  connects, so the read covers every transport the daemon serves: TCP 5900 or a remapped port, a tunnel, and
  [High Performance Screen Sharing's](https://support.apple.com/guide/remote-desktop/use-high-performance-screen-sharing-apdf8e09f5a9/mac)
  UDP. `SSMenuAgent`, which keeps running after a session, and this Mac's own outgoing viewer (`Screen Sharing`) are
  not counted.
  Failed, timed-out or unrecognized reads give `unknown` unless another signal already establishes a remote connection.
- `load`: the 1, 5 and 15 minute load averages, `/`-separated, each exactly as `sysctl -n vm.loadavg` prints it (two
  decimals). It lets a reader tell a red caused by the machine's load from the branch's own: on 2026-10-18 three of
  MAWS's timing-measured groups went red on the mini at a 1-minute load of 15.7–17.3, from another session's parallel
  renders, and that load had to be rebuilt from the other session's transcript
  ([#54](https://github.com/SSFSKIM/ci-kit/issues/54)). `start` shows the load the job walked into. `end`'s figures
  count the job's own processes too: after a job longer than a minute or so, its 1-minute figure is the job's last
  minute, and the 5 and 15 minute figures reach back across the job. A failed, timed-out or unrecognized read gives
  `unknown`. The line does not name the processes behind the load.
- `computeruse`: the distinct names of running computer-use processes, comma-separated in byte order (a list too long
  for the line ends in `+N more`), or `none`. A name counts when it is `SkyComputerUseService` (Codex and ChatGPT
  computer use; cua drives the desktop through it too), contains `CUAService`, or starts with `cua` (`cua-driver`,
  `cua-sandbox-golden`). The read is non-root `ps -axco pid=,comm=`, which prints each executable's name in full and
  never its path; `pgrep` and `ps -o ucomm` see the kernel's 16-character name, where `SkyComputerUseService` is
  `SkyComputerUseSe`. A cua runtime's `node` and `node_repl`, which every session with the cua plugin loaded keeps, and
  ci-kit's own `cursor-park` are not counted. A failed, timed-out, empty or unrecognized read gives `unknown` unless it
  already found a computer-use name.

Computer use is a **presence snapshot at the job's two edges**. It is the evidence for MAWS's rule (its gate-offload
Decision Log 58) that a computer-use session drives the shared desktop only between jobs: a name at `start` was running
as the job began, a name at `end` was still running when it finished. A session that started and stopped inside the job
leaves nothing here, and a running service is not proof that it drove the desktop; for the stretch between, the unified
log is still the record (`/usr/bin/log show --predicate 'process == "SkyComputerUseService" OR process BEGINSWITH "cua"'`,
the full path because zsh has a `log` builtin). The names were checked on the MacBook (macOS 26) against running
processes carrying them, and the mini's (macOS 27) `ps -c` output read-only.

Screen Sharing is a **daemon signal, not authentication proof**. launchd starts `screensharingd` when a connection
arrives, before anyone authenticates, so a viewer still at the login prompt reads `screensharing`. The daemon exits
about 15 s after the last viewer leaves, so `screensharing` can trail a session by up to that much. Observed twice on
the mini (macOS 27) on 2026-10-18: `No viewers so time to exit` 15 s after the last viewer was removed, then launchd's
`service inactive: com.apple.screensharing`; `ScreensharingAgent` went with the daemon, and `SSMenuAgent` was running
afterwards. `none` means the daemon was not running; remote control that does not go through it is not covered. The
read used to be `netstat -an`'s incoming 5900 sockets, which works from ssh and launchd agents but not in a job hook:
inside Runner.Worker's process tree the kernel's Internet socket list is withheld (likely Local Network privacy, not
proven), netstat exits 0 without its `Active Internet connections` section, and the read printed `none` with a viewer
attached ([#50](https://github.com/SSFSKIM/ci-kit/issues/50)). The process table is not filtered there: a job's `ps`
lists root's processes, `screensharingd` among them.

The six posture reads — frontmost, display, Parsec, Screen Sharing, load and computer use — each have an independent,
unconditional 1 s Perl-supervisor deadline, which kills and reaps a hanging probe even if it ignores SIGALRM.
Supervision covers the direct child before it has established its process group, as well as the group's descendants.
Results are combined only afterward, so a positive Parsec read survives a hanging Screen Sharing read and vice versa.
All six timing out takes about 6 s plus process overhead. Local positive fixtures scale the supervisor's clock only
inside their test processes so scheduling load does not look like a failed read; hanging fakes sleep far beyond it. The
all-six-hung and delayed-process-group regressions use the real, unscaled clock. Fixtures also cover interleaved
Parsec clients and both positive/hanging directions with and without SIGALRM ignored, including strict-shell runs.
The probes only read state: no GUI actions, AppleScript, new permissions or remote-session changes, and no signal to
any process the computer-use read finds. Posture and hooks-log failures never affect the sweep's or the job's outcome.

Before each job and after it, the hooks kill every process of the runner's user that a job left behind:

- a process that **runs from** the instance's work directory: a path under `~/actions-runner-maws/_work/` (a shared
  instance's `~/actions-runner-maws-<n>/_work/`) in its command line
  (the job's Electron and its helpers, the Node of the runner's tool cache, vitest, Playwright);
- a process that **sits in** it: its working directory is under it;
- every **descendant** of those, wherever it sits (an app's pty shell in `/tmp` is the app's).

The hook's own process, its ancestors (the runner's worker and listener) and its own children are spared. Each stray
gets SIGTERM, then SIGKILL after 10 s. A pid is signalled only while it still holds the process that was selected (same
uid and start time): a stray that exits during the grace can hand its pid to an unrelated process, which gets nothing.
Every run of a hook logs one line per stray (pid, why it matched, command line), one per SIGKILL, and a last line, to
`~/Library/Logs/ci-kit/mac-runner-hooks.log` and to the job's log.

The last line is `swept <n>`, or `FAILED sweep …` with the survivors' pids and each refused signal (`pid:SIGNAL:code`).
A failed sweep exits 1, which fails the job: before a job, because a desktop job beside a survivor is not the clean
desktop it assumes and its result would not be trusted; after one, because the survivor is what that job left. Until
someone removes the survivor, every job on that machine fails at "Set up runner" with that line, which is the point.

**Do not work inside the runner's work directory.** A shell or session whose working directory is under `_work`, or a
long-lived command that names a path there, is a stray to the next hook. To look at a job's files, copy them out.

What the hooks cannot see: a process that a job detached, whose parent has since exited, and that neither names nor
sits in the work directory (macOS does not let one process read another's environment, so the runner's
`RUNNER_TRACKING_ID` is no help). The host janitor (§7) is the backstop for those.

Check by hand, killing nothing:

```bash
ssh mini 'node ~/actions-runner-maws/ci-kit/hooks/sweep.mjs manual --dry-run'
#   expect, between jobs: ... swept 0 under /Users/new/actions-runner-maws/_work (dry run)
ssh mini 'pgrep -fl actions-runner-maws/_work'   # expect no output after a job
```

Without `--dry-run`, a sweep by hand kills what it lists; it refuses while a job runs, since the job's own processes
would be its strays.

## The measured-job guard

A timing measurement taken while the desktop was not the calibrated one is void. On 2026-10-18 MAWS lost two measured
sets on the mini: one to another session's parallel renders, which held the 1-minute load at 15 and more, and one to a
Parsec viewer, which switched the display from @2x to @1x. Until then a person watched the mini and sent the go by
hand. The guard is the action `SSFSKIM/ci-kit/mac/settle@v1`, the first step of a job that is measured; which jobs
those are is the calling repository's to say (MAWS lists its groups in `gate.yml`). It is a step, not part of the
job-started hook, because the hook cannot tell one matrix entry from another: `GITHUB_JOB` is `e2e` for every group.

```yaml
- uses: SSFSKIM/ci-kit/mac/settle@v1   # every input has the default below
```

| Input | Default | The job is released only while |
|---|---|---|
| `load` | `5` | the 1-minute load average is under it (two decimals at most) |
| `display` | `@2x` | the main display is at that scale |
| `remote` | `none` | no Parsec viewer is connected and `screensharingd` is not running |
| `computeruse` | `none` | no computer-use process runs |
| `bound` | `15` | minutes: the job is refused once the next read would come after them |

`any` leaves a condition unchecked. A malformed input fails the step with `ci-kit settle: <input> takes …` (exit 2),
never in the refusal's shape.

**Settled** is two reads 30 s apart that each meet every condition, so a quiet desktop releases the job 30 s in. A read
is `desktop-posture.sh --read`: the posture line's six reads under their 1 s deadlines, printed without the line's label
and logged nowhere. A read that fails is `unknown`, and unknown meets no condition: an unreadable load holds the job as
a high one does.

**Where the reads come from.** The guard runs `desktop-posture.sh` from the action's own checkout
(`_work/_actions/SSFSKIM/ci-kit/v1/`), not from the installed hooks: the guard and the reads it judges move together when
`v1` moves, and a tag move never meets an installed hook set older than a read it calls. What a checkout lacks is the
compiled display helper, which `install.sh` builds into the runner's hooks. The guard takes `cursor-park` from the
directory of `ACTIONS_RUNNER_HOOK_JOB_STARTED`, which the runner's `.env` gives every job, else from
`~/actions-runner-maws/ci-kit/hooks`, and hands it to the posture script as `CI_KIT_CURSOR_PARK`. Without it `display`
reads `unknown` and no job settles, which the refusal names.

**One line either way**, in the job's log and in the hooks log as a `settle` line (`<time> settle run=<id> job=<job>
<line>`): how long the job waited, the posture at the first read, and the posture at release or at refusal.

```
ci-kit settle: settled in 90 s; start: frontmost=Terminal display=2560x1440@2x remote=none load=7.20/6.10/5.02 computeruse=none; release: frontmost=Terminal display=2560x1440@2x remote=none load=3.10/5.20/4.90 computeruse=none
ci-kit: the mini did not settle for a measured job within 15 min (display @1x); waited 900 s; start: frontmost=Terminal display=2560x1440@1x remote=parsec load=2.10/2.00/1.90 computeruse=none; refusal: frontmost=Terminal display=2560x1440@1x remote=none load=1.20/1.50/1.70 computeruse=none — fix that there and rerun
```

**At the bound the job is refused** as the job-started check refuses one, with a `ci-kit: … rerun` line, so MAWS's
`scripts/ci-gate.sh` counts the job as refused by the mini, not red, and puts it in its relaunch line. The parenthesis
names each condition the last read did not meet, with what it read: `load 7.20`, `display @1x`, `parsec`,
`screensharingd`, `computeruse <names>`, or `<condition> unknown`; when the last read met them all and the one before it
did not, it names that one's. A cause that persists, a display left at @1x or a viewer left connected, then reads the
same on every refused job, and is fixed on the machine. No read starts after the bound: a refused job has waited at most
the bound and one read. The wait counts toward the job's `timeout-minutes`, which the caller sizes for the bound and the
measured run together.

## Instances and the shared hold

A Mac's jobs run one at a time on its **exclusive instance**, and, once the machine has **shared instances**
(`install.sh --shared <n>`), the jobs that ask for them run beside each other there. The design is the
[concurrency spec](doperpowers/specs/2026-10-21-mac-lane-concurrency-design.md).

**Admission is by labels.** The exclusive instance carries today's labels, so every job written for the lane reaches
only it: an old commit's workflow, a rerun, a group nobody classified, a measured or foreground group. A shared instance
carries `ci-kit-mac-shared` alone, with none of the runner's defaults, so a job reaches it only if it asks for that
label, and nothing asking for `self-hosted`, `macOS` or `ARM64` can. **What a calling repository does to opt a group
in:** run it on `runs-on: [ci-kit-mac-shared]` (MAWS: its `MAC_SHARED_E2E` list), only once a trial has shown its
results unchanged beside neighbours; and give such a job a `timeout-minutes` that covers the shared wait below as well
as its run. Every other job keeps its labels and runs alone.

**Exclusive and shared jobs never overlap.** Both kinds of job-started hook decide under one lock,
`~/Library/Logs/ci-kit/desktop.lock` (flock(2) through perl, which the kernel releases with its holder, so a process
killed while holding it leaves no lock behind), so no job's check can be overtaken by another's write:

- **A shared job** writes its instance's running marker, `shared-running-<n>`, once no hold is up, and then runs
  today's start. While the shared hold is up, or the dialog watcher holds the runners (`runner-drained`), it parks in
  its hook, checking each second, for at most `CI_KIT_SHARED_WAIT` minutes (60, in the runner's environment); past
  that it is refused, naming the hold:

  ```
  ci-kit: shared runner 2 on the mini waited 60 min to start (an exclusive job, run 18742 job e2e, holds the desktop since 2026-10-21T10:02:11Z) — rerun
  ```

- **An exclusive job** raises the shared hold, `shared-hold`, so no shared job starts until it ends, and waits for
  the running ones: until no running marker names a live worker, for at most `CI_KIT_EXCLUSIVE_WAIT` minutes (10).
  It then sweeps every shared instance's work directory, so nothing a dead or finished shared job left runs beside
  it, sparing every live job worker and what it started (a shared job parked in its own hook sits in its workspace).
  Then it runs today's start. Past its bound, or when a sweep fails, it is refused:

  ```
  ci-kit: the shared runners on the mini did not make way for an exclusive job (after 10 min: shared runner 2: run 18740 job e2e (worker 51234)); waited 600 s — rerun
  ```

- **A marker names a job** by its run, its job and its worker: the `Runner.Worker` that runs the hooks, by its pid and
  the start time the kernel gives it, so a reused pid or a reboot cannot pass for it. A running marker whose worker is
  gone is stale, and counts for nothing.

**A claim is kept until the job's end.** A running marker written, or the hold raised, is released only by the job's
job-completed hook, after its own sweep, whatever became of its start. A refused job-started hook fails its step, but
the job's steps whose condition runs after a failure (`failure()`, `always()`, `!cancelled()`, `cancelled()`) still
run, and the runner runs the job-completed hook at the end of every job (both are pre- and post-job steps with
`always()`, actions/runner `JobExtension.cs`). **The contract for a calling repository:** a step that can run after a
failed start must not use the desktop. MAWS pins this in its own tests.

**Recovery.**
- **A failed sweep keeps the claim.** At an exclusive job's start or end, the hold stays up, and no shared job starts
  beside what it left. A shared job's marker goes stale with its worker, and the next exclusive job's sweep tries
  that work directory again.
- **A crashed exclusive job** (its worker died, so its job-completed hook never ran) leaves the hold naming a dead
  worker. The dialog watcher reconciles it at each read: under the lock, it sweeps the exclusive instance's work
  directory, sparing every live worker (the next job may have started), and drops the hold. A sweep that fails keeps
  the hold up and opens one issue in `SSFSKIM/ci-kit-sandbox`, closed once no hold is up. Its title,
  `ci-kit alert: shared hold stuck on <machine> since <minute>: …`, is outside [the dialog alerts'
  pattern](#the-alert-title), so MAWS's `ci-gate.sh` does not take it for a dialog. The exclusive instance's next job,
  finding such a hold, does the same under the lock before raising its own.
- **After a reboot** every wrapper starts its runner (only the dialog watcher's marker holds one), and the markers left
  on disk name workers that are gone: the stale running markers count for nothing, and the hold is reconciled by the
  watcher or the next exclusive job.

**Every step goes to the log**, as `shared-hold` lines in the hooks log and in the job's log: the hold raised, each
job waited for, each stale marker, the sweeps, the admission and how long it waited, a parked job and its admission,
each refusal, each release.

**What it costs.** A shared job can be given to its runner during an exclusive job; it prepares (its workspace and
action downloads, "Set up job") and parks in its hook, at most one per shared instance at a time. An exclusive job
waits for running shared jobs to end, at most its bound, and the exclusive instance runs no shared job.

**With no shared instance** (no `~/actions-runner-maws-<n>` directory) the hooks take no lock, write no marker and log
no admission line: they are the hooks this page described before shared instances.

Check by hand:

```bash
ssh mini 'cat ~/Library/Logs/ci-kit/shared-hold ~/Library/Logs/ci-kit/shared-running-* 2>/dev/null; grep shared-hold ~/Library/Logs/ci-kit/mac-runner-hooks.log | tail -5'
#   expect, between jobs: no output from the markers
```

## The dialog watcher

The job hook sees a dialog only when a job starts. On 2026-10-17 securityd crashed, and a SecurityAgent keychain-unlock
dialog covered the mini for 12 minutes; MAWS was holding its runs, so no job started and nobody was told. The watcher,
the LaunchAgent `com.ssfskim.ci-kit.dialog-watch`, reads the frontmost app at load and every 60 s, whether or not a job
runs. It runs `~/actions-runner-maws/ci-kit/hooks/dialog-watch.sh`, which `install.sh` copies with the hooks, in every
mode (`--disabled` turns off the runner, not the alerts), and removes with `--uninstall`.

**One episode per machine, from either side.** The watcher and the job hook share `mac/hooks/dialog.sh`: the dialog
list, the read-only `lsappinfo` read, the source attribution and the episode, kept in
`~/Library/Logs/ci-kit/dialog-alert.state`. They read and rewrite it under a lock, so one episode is one issue
whichever side sees the dialog first. The state is the machine's own: a machine comments on and closes only the issue
it opened, never another machine's.

- **Opening.** The watcher opens an episode when a dialog holds the front on two consecutive reads, at most 150 s
  apart, so a prompt answered within the minute alerts nobody. A refused job opens one at once, since a job was
  already lost.
- **First seen** is the first read that saw the dialog: the watcher's single read, if a job comes before its second.
  The state keeps it, so every later refusal and the title carry the same time.
- **The source** is attributed once, when the episode opens: the same log queries as before, at most three of 10 s
  each. A refusal during the episode reuses it.
- **Closing.** The watcher closes the episode after three consecutive reads with no dialog, about three minutes: it
  comments `cleared at …` on the issue and closes it. On 2026-10-17 a dismissed prompt came back within a minute,
  twice. A dialog read from either side restarts the count.
- **A close that fails is owed, not dropped.** On 2026-10-20 the mini closed an episode just after a reboot, before
  its network was up. The comment and the close failed, nothing tried them again, and the open alert stopped MAWS's
  `ci-gate.sh` from pushing Mac jobs until it was closed by hand. Now the state keeps the issue (`phase=closed`), and
  every watcher read with no dialog tries again: the comment unless it went through, then the close. The file goes once
  the close does; closing an issue someone already closed counts. A close that fails is settled only by what GitHub
  says of the issue itself (`gh api repos/SSFSKIM/ci-kit-sandbox/issues/<n>`): closed, deleted (410), or 404 in a
  repository the token can read. The sandbox is private, so a 404 alone may be a token that cannot see it. An open
  issue, a timeout or any other error keeps the close owed, and so does `gh`'s `Could not resolve to an issue`, which
  GitHub says too of an issue the token cannot see. The episode itself has closed, so the runner is released at once,
  and jobs run while the close is owed.
- **A dialog while a close is owed**, seen by the watcher or a job, tries the close first. Once it goes through, the
  dialog starts an episode of its own, with its own first-seen time, source and alert. While it cannot, a new alert
  could not be opened either, and the open one is right again, so the episode reopens with it: the alert keeps the
  first dialog and time in its title, and closes when this dialog is gone.
- **A job's clear read** ends a single pending read, but does not count towards closing: jobs come at job cadence, not
  on the watcher's clock.

### The alert title

The title is a contract: MAWS reads open alerts with `^ci-kit alert: ([a-z0-9-]+): (\S+) since (\S+)`, and the
format is pinned in `test/mac-dialog-watch.test.mjs`.

```
ci-kit alert: <machine>: <dialog> since <YYYY-MM-DDTHH:MMZ>[ (<source>)]
ci-kit alert: mini: SecurityAgent since 2026-10-17T05:12Z (security request from codesign)
ci-kit alert: rental: loginwindow since 2026-10-17T05:12Z
```

- `<machine>` is `CI_KIT_MACHINE`, which `install.sh` keeps to `[a-z0-9-]`.
- `<dialog>` is the canonical name from the dialog list, whatever the display language.
- `<YYYY-MM-DDTHH:MMZ>` is the first-seen minute, in UTC.
- ` (<source>)` follows only when attribution found one.

The kit's other alerts (`ci-kit alert: pool hours on …`, `pool server …`, `bake builder …`, `GCE VM …`) and the
dialog alerts opened before this format never match it. The body adds the time, the frontmost app, the first-seen
second, who opened it (the watcher, or a refused job and its run id), the source and its log line.

### The drain

With two runners on the same labels, a machine whose hook refuses every job in seconds draws most of the queue and fails
it, while the healthy machine is busy with one job (2026-10-17, the mini alone: 14 jobs refused in three minutes). So
while an episode is open, the watcher holds every runner of the machine, the exclusive and the shared ones, and stops
each between its jobs. Queued jobs then go to the other
machine, or wait. On a single machine, the drain turns refusals into queued jobs, which run once the dialog is
dismissed and the episode closes.

- **The hold** is the marker `~/Library/Logs/ci-kit/runner-drained`, written when the episode opens. Every instance's
  LaunchAgent runs its own `runner-hold.sh`, which execs the runner's `runsvc.sh` only once the marker is absent, and otherwise
  waits, checking every 5 s. Absent means the lookup says no such file, a missing directory included. A marker that
  cannot be looked up, behind a directory that is not searchable for instance, holds the runner too, and the wrapper
  logs why. KeepAlive, RunAtLoad and a reboot can therefore start only the waiting wrapper, never the runner. The
  wrapper execs, so launchd's `/bin/bash` stays every job's responsible process.
- **Stopping, between jobs only.** A stop is SIGTERM to the agent (`launchctl kill SIGTERM`): `runsvc.sh` turns it
  into the listener's graceful stop, and KeepAlive brings back the waiting wrapper. A stop while a job's worker runs
  cancels that job ("The runner has received a shutdown signal"), and the listener asks for its next job the moment a
  worker exits. On 2026-10-18 the mini was given the next job in the second the busy one ended, and acquired it 2 s
  later, twice in a row (09:58:58 → 09:59:00, 09:59:07 → 09:59:09), while the drain waited for its 60 s tick: both
  were refused. So the runner is stopped at one of two moments.
  - **When its job ends.** The job-completed hook runs inside the job's worker, as the job's last step and before the
    worker reports the job's result, so it never stops the runner itself. It starts its own instance's
    `dialog-watch.sh --job-end`, which stops that instance's runner,
    detached from the job: its own session, outside the workspace, without the job's `RUNNER_TRACKING_ID` (the worker
    kills what still carries it after the last step) and without the hook's output, which the worker waits on. That
    process sees the worker exit as it happens (`runner-state.py --wait`, a kqueue), and the hook returns only once it
    is watching (5 s at most), so even a worker that exits at once is seen. The worker reports the result to
    GitHub before it exits, so if the marker exists then, it stops the runner at once: tens of milliseconds, against
    the 2 s the listener takes to acquire the next job. Held or not is decided at the exit, so an episode that opens
    while a job finishes counts; without the marker it does nothing and logs nothing.
  - **When it is confirmed idle.** On a watcher read with the hold on, the watcher reads every instance; when any is
    idle it reads those again 5 s later and stops each whose two reads match (idle, below). Any difference waits for
    the next read.
- **Idle** is what `runner-state.py` reads, for one instance, from the kernel's executable paths of this user's
  processes (`proc_pidpath`, `bin` resolved, since a runner that updated itself runs from `bin.<version>`): the
  instance's listener runs and no process is its `bin/Runner.Worker` (`~/actions-runner-maws/bin/Runner.Worker` for the
  exclusive instance). A command line, `argv[0]` or working directory naming that path does not
  count. A process whose path cannot be read (its file was deleted or replaced) counts as a job when the kernel still
  names it `Runner.Worker`. A read that fails or times out counts as a job too: the runner is left alone, and the
  watcher asks again next minute. An idle read also carries the length of the listener's newest diag log
  (`~/actions-runner-maws/_diag/Runner_*.log`): a job the listener has just been given has no worker for its first
  seconds, but the listener logs it at once. While it waits it logs only a token refresh about every 50 minutes,
  which delays a stop by one read. Two matching idle reads therefore saw no job running and none given in between.
  On 2026-10-18 at 09:59:18 the drain stopped the mini on a single idle read in the second it was given a job, and the
  job stayed in progress on the offline runner.
- **Releasing.** When the episode closes, the watcher removes the marker, and every wrapper starts its runner within
  5 s. A marker left while no episode is pending or open goes at the next read. The watcher writes and removes the
  marker under the episode's lock, in the same step as its read, so it never releases a runner for an episode a job
  hook has just opened.
- **An operator's runner stays the operator's.** The watcher never loads, unloads, enables or disables the runner's
  agent. A runner disabled by hand or by `install.sh --disabled` stays off, and one enabled during an episode waits for
  it to close.
- **What is left.** A job given to the listener in the milliseconds between the worker's exit, or the second idle read,
  and the stop is never acquired, since the listener shuts down first, so it does not stay in progress here. A job end
  the drain could not watch (the hook's parent is not the runner's worker, or the worker took more than 10 minutes to
  exit) is logged, and the next confirmed idle read stops the runner. If the stop reaches the listener before it has
  noticed the worker's exit, its line for that job in `mac-runner.out.log` says `Canceled`; GitHub keeps the result the
  worker reported.
- Every hold, stop, release and job left alone is a `dialog-watch … drain:` line in the hooks log, naming a shared
  instance as `shared runner <n>`. Each wrapper's own `runner-hold:` lines are in its instance's
  `mac-runner[-<n>].out.log`.

**Cheap and bounded.** A read with no dialog and no episode costs two `lsappinfo` calls, 5 s deadline each, and writes
nothing. Every other external call has its own supervised deadline, which kills and reaps it even when it ignores
SIGALRM: 10 s for each `log`, `gh` and `launchctl` call and for the runner-state read. The watcher never clicks,
types, dismisses or focuses anything, and uses no AppleScript and no new permission.

Check by hand:

```bash
ssh mini 'launchctl print gui/$(id -u)/com.ssfskim.ci-kit.dialog-watch | grep -E "state =|runs =|last exit code"'
#   expect: runs = <n>, last exit code = 0 (state = not running between reads)
ssh mini 'cat ~/Library/Logs/ci-kit/dialog-alert.state ~/Library/Logs/ci-kit/runner-drained 2>/dev/null; grep dialog-watch ~/Library/Logs/ci-kit/mac-runner-hooks.log | tail -5'
#   expect, with no dialog: no output from the state files (phase=closed is an alert close still owed; the log says why)
gh issue list -R SSFSKIM/ci-kit-sandbox -l ci-kit-alert
```

## Running a MAWS gate on it

From any MAWS checkout (MAWS's own script; it pushes a temporary `ci/` ref and deletes it):

```bash
scripts/ci-gate.sh <sha> --runner macos --gates e2e:composer
gh api repos/SSFSKIM/MAWS/actions/runs/<run-id>/jobs --jq '.jobs[]|select(.conclusion!="skipped")|[.name,.runner_name]|@tsv'
#   expect: plan  GitHub Actions <n>   (the plan job stays on ubuntu-24.04 unless GATE_RUNNER=macos)
#           e2e:composer  ci-kit-mac-mini   (or another machine's runner: whichever was idle)
```

(`gh run view --json jobs` has no runner name; the jobs API's `runner_name` does.)

**Human-only prompts.** A first launch of a GUI app can raise a macOS prompt (Gatekeeper for a downloaded app, a
Keychain or notification request). They are answered by the human, in that machine's GUI session, never by an agent
and never through cua.

**Readiness hold: LibreOffice.** `/Applications/LibreOffice.app` (Homebrew cask) is quarantined until the human first
opens it on that machine and allows Gatekeeper's "downloaded from the Internet" prompt. Until then, no group that
launches `soffice` can run there: in MAWS's `gate.yml` those are `LIBREOFFICE_E2E`, `document` and `presentations`.
Every runner takes every group, so a machine is enabled only after this approval ([Adding a Mac](#adding-a-mac)). On
2026-10-17 the mini's flag reads `01c1`. The flag shows the approval:

```bash
ssh mini 'xattr -p com.apple.quarantine /Applications/LibreOffice.app'
#   0181;…  not yet approved (hold)
#   01c1;…  approved (0x40, user approved, is set): the hold is lifted
```

## Adding a Mac

A second machine runs a second exclusive runner with the same labels, so MAWS's `[self-hosted, macOS, ARM64]` jobs go
to whichever machine is idle. Below, `<host>` is the MacBook's `ssh` host for it and `<name>` its short name, a
lowercase word of letters, digits and `-`, not ending in `-<number>` (a shared runner's name does): the runner is
`ci-kit-mac-<name>`, and its refusals and alert say "on the <name>", so pick a word that reads there.

**The instance count.** A new machine starts with its exclusive instance alone. Shared instances are added once the
machine is accepted (step 5), with `install.sh --shared <n>` and a registration token as in
[Install](#install-update-remove); they are installed disabled, and enabled per instance for a trial and then for good
([Instances and the shared hold](#instances-and-the-shared-hold)). Memory sets the count: two shared jobs at once fit
16 GB by estimate, and a third needs a trial's memory reads.

**The machine.** Apple silicon, 16 GB or more (the mini is an M2 Pro with 16 GB), macOS 27 like the mini (27.0).

**The user.** The runner's user is named `new` and is an admin: MAWS's fixtures carry `/Users/new` paths, so the same
home avoids divergence. SSH is key-only, with the MacBook's key; VNC is for the owner.

**1. The owner, once, in the GUI's Terminal as `new`.** These need root or `new`'s password, which the agent does not
hold.

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '<the MacBook public key>' >>~/.ssh/authorized_keys
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' | sudo tee /etc/ssh/sshd_config.d/010-key-only.conf
sudo pmset -a sleep 0 displaysleep 0 disksleep 0 standby 0 powernap 0 autorestart 1
sudo sysadminctl -autologin set -userName new -password -
sysadminctl -screenLock off -password -
defaults -currentHost write com.apple.screensaver idleTime -int 0
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"   # only without /opt/homebrew/bin/brew
```

- SSH: macOS's `sshd_config` includes `sshd_config.d/*` first, and each connection starts its own `sshd`, so the next
  login is key-only. The mini, which the MacBook reaches over the tailnet, still accepts passwords; a rented Mac can face
  the internet.
  From the MacBook, `ssh -o BatchMode=yes -o PubkeyAuthentication=no <host> true` must answer
  `Permission denied (publickey).`
- Power is the mini's (`pmset -g`), except that the mini's Power Nap is on, which does nothing on a Mac that never
  sleeps. `autorestart 1` brings it back after a power loss.
- Auto-login brings `new`'s GUI session, and with it the runner's LaunchAgent, back after a restart, and unlocks the
  login keychain at boot. `-password -` asks for `new`'s password.
- Screen lock and screensaver off, as on the mini (`sysadminctl -screenLock status`: `screenLock is off`; `idleTime` 0).
- Homebrew's installer asks for the password once. It also installs the Xcode command line tools, whose `clang`
  `install.sh --check` needs.

**2. The agent, over SSH, without sudo.**

```bash
host=<host> name=<name>
ssh $host '/opt/homebrew/bin/brew install node corepack git gh python jq'
ssh $host '/opt/homebrew/bin/brew install --cask google-chrome libreoffice betterdisplay'
ssh $host 'curl -fsSL https://claude.ai/install.sh | bash'
ssh $host 'git clone https://github.com/SSFSKIM/ci-kit ~/Developer/GitHub/ci-kit'
ssh $host '~/Developer/GitHub/ci-kit/mac/install.sh --check'
gh api -X POST repos/SSFSKIM/MAWS/actions/runners/registration-token --jq .token \
  | ssh $host "~/Developer/GitHub/ci-kit/mac/install.sh --disabled --name ci-kit-mac-$name"
ssh $host '~/Developer/GitHub/ci-kit/host/install.sh'
printf '%s\n' "$(cat ~/.config/claude-secrets/CI_KIT_ALERT_TOKEN)" \
  | ssh $host 'umask 077; mkdir -p ~/.config/ci-kit && cat >~/.config/ci-kit/alert-token'
ssh $host 'GH_TOKEN=$(cat ~/.config/ci-kit/alert-token) /opt/homebrew/bin/gh issue list -R SSFSKIM/ci-kit-sandbox -L 1 >/dev/null && echo token ok'
```

- `corepack` is its own formula: Homebrew's `node` (26) ships without it, and `--check` requires it. The mini's comes
  from a Node.js package in `/usr/local`.
- Google Chrome because MAWS's desk-web e2e drives the installed Chrome on a Mac; LibreOffice for the document groups;
  BetterDisplay for the display (step 3).
- Claude Code's native installer puts `claude` in `~/.local/bin`. Only MAWS's live groups launch the engine; class 1
  does not.
- `--disabled` registers the runner and installs the hooks with the agent left off, so no MAWS job lands before step 3;
  step 4 turns it on. It also starts the [dialog watcher](#the-dialog-watcher), so from here a prompt left up for more
  than a minute, step 3's included, opens an alert that names the machine. It closes about three minutes after the
  prompt is answered.
- The host janitor runs as on the mini ([host.md](host.md)), from the clone that stays.
- The alert token is the owner's to make, once for every rented Mac: a fine-grained personal access token with resource
  owner SSFSKIM, repository access to `SSFSKIM/ci-kit-sandbox` alone, and Issues read and write. The owner stores it on
  the MacBook with `/secret CI_KIT_ALERT_TOKEN`, and the copy goes through stdin, so it is never an argument
  or printed. The last line checks it reads the sandbox's issues. When it expires, the alert fails (the hooks log says
  `dialog alert issue creation failed or timed out`), and the job is still refused.

**3. The owner, once, in the machine's GUI (VNC).**

- Open LibreOffice, Google Chrome and Terminal once each, and allow their first-launch prompts.
- In BetterDisplay, make a 2560x1440 HiDPI virtual display the main display, and turn on its launch at login so the
  display comes back after a restart. The mini's posture line reads `display=2560x1440@2x`, and some MAWS specs read
  `devicePixelRatio`.
- System Settings → Privacy & Security → Full Disk Access: the + button, Cmd+Shift+G, `/bin/bash`.

Then, from the MacBook:

```bash
ssh $host 'for app in LibreOffice "Google Chrome"; do xattr -p com.apple.quarantine "/Applications/$app.app"; done'
#   01c1;… (approved) or "No such xattr" for each; 0181;… is not yet approved
ssh $host '~/actions-runner-maws/ci-kit/hooks/cursor-park --describe'
#   expect: 2560x1440@2x
```

**Why `/bin/bash`, and nothing else.** The only grant the mini's jobs hold is Full Disk Access, and they reach it
by inheritance: launchd starts the runner's agent as `/bin/bash runner-hold.sh`, which execs `runsvc.sh` (bash again,
in the same process), which waits on the runner rather than exec-ing it, so `/bin/bash` is the responsible process of
every job. On the mini, `/bin/bash` has held Full Disk Access since
2026-07-18, granted for something else. Full Disk Access also opens other apps' data (Mail, Messages, Safari) to
everything `/bin/bash` is responsible for on that machine. The mini holds no Accessibility or Screen Recording grant for
bash, the runner or Electron, so the new Mac gets none either: the goal is parity. A prompt for anything not granted
still refuses that machine's jobs through the desktop check, and its alert names the machine. While the alert is
open, the watcher holds that machine's runner, so the mini takes its jobs.

**4. Turn it on.**

```bash
ssh $host '~/Developer/GitHub/ci-kit/mac/install.sh'
#   expect: ci-kit mac: running: ci-kit-mac-<name> listens for jobs of https://github.com/SSFSKIM/MAWS; the dialog watcher com.ssfskim.ci-kit.dialog-watch runs
gh api repos/SSFSKIM/MAWS/actions/runners --jq '.runners[]|[.name,.status,.busy]|@tsv'
#   expect: ci-kit-mac-<name>  online  false, beside the mini's
ssh $host 'launchctl print gui/$(id -u)/com.ssfskim.ci-kit.dialog-watch | grep -E "runs =|last exit code"'
#   expect: runs = <n> (one a minute), last exit code = 0
```

**5. Acceptance.** The first job's posture line, in its log and in the machine's hooks log:

```bash
ssh $host "grep -m1 'ci-kit desktop (start)' ~/Library/Logs/ci-kit/mac-runner-hooks.log"
#   expect: … ci-kit desktop (start): frontmost=Terminal display=2560x1440@2x remote=… load=… computeruse=…
```

(`remote=screensharing` while the owner's VNC session is connected. The mini, whose locale is Korean, shows Terminal as
`터미널`.) Then one MAWS full set on master's tree, from a MAWS checkout, and the result of each group with the
machine that ran it:

```bash
scripts/ci-gate.sh "$(git rev-parse origin/master)" --runner macos
gh api --paginate repos/SSFSKIM/MAWS/actions/runs/<run-id>/jobs --jq '.jobs[]|select(.conclusion!="skipped")|[.name,.conclusion,.runner_name]|@tsv'
```

Compare each group's result across the machines: within this set, and against the same group's latest result on the
mini. A group red only on the new machine means disabling it there (Disable and enable, above) and fixing the cause before it
is enabled again. To put a whole set on the new machine, disable the mini's agent between jobs (its runner `busy` false)
and enable it after.

**Removal.** The remove commands above, with the machine's host, and the rented Mac's lines after them.

## Contention: measured

On 2026-10-15, 22:02–23:02 UTC, MAWS's `e2e:composer` group (18 keyboard and focus cases, the kind owner input broke
before) ran ten times in sequence on the mini through `scripts/ci-gate.sh <master 767fcbb7> --runner macos --gates
e2e:composer`, while the mini carried its normal load (6–13 Claude sessions, the cua session, the ida-solution runner).
A sampler read the memory pressure level, swap and free memory every 15 s.

| | |
|---|---|
| Result | **10 of 10 green**, every one `18 passed` in 49.7–51.4 s of Playwright time |
| Job wall time | 3 m 52 s – 6 m 48 s (about 1 m 25 s of it the e2e step; about 2 min the Actions cache save, see below) |
| Memory pressure | level 1 (normal) in all 242 samples; free memory 52–70 % (mean 64 % during jobs, 66 % idle) |
| Swap | no growth (1.6 GB before and after) |
| Load | at most 6.5 on 10 cores |
| Hooks | `swept 0` after every completed job; a job cancelled mid-run left 12 processes (the step's shell, pnpm, Playwright, Electron and its helpers), which its `job-completed` hook killed, none needing SIGKILL |

**Verdict: ship** (§4: 0–1 failures in 10). The desktop lease is not needed at this rate; MAWS's quiet e2e mode kept
the windows from contending with the cua session's GUI work during the hour measured.

**Measure again** when the mini's use changes materially (more sessions, a GUI-heavy cua task during the window, other
e2e groups): the same command ten times, in sequence, each with its own `--label`, counting only runs that ran to their
end (a run cancelled by a later push to the same ref is not a sample).

**Every job saves the Actions cache again.** MAWS's setup action caches the pnpm store and Electron's download, and
GitHub scopes a cache to the ref that saved it plus the default branch. Each `ci/` ref is new and the default branch
never runs `gate.yml`, so every gate run, hosted or here, restores nothing and uploads about 280 MB in its post step.
On the mini, whose store persists, that is two minutes per job for nothing. It is MAWS's to change (for instance,
skip both caches on a self-hosted runner, or seed them from the default branch).
