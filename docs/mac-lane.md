# The mac lane

Each Mac in the lane runs GitHub Actions runners for `SSFSKIM/MAWS`, so MAWS's macOS-bound gates (its Electron e2e
above all) run there instead of on the MacBook. The design is §4 of the
[spec](doperpowers/specs/2026-10-15-ci-kit-design.md); the contract is I10. A Mac's runners are its
[instances](#instances-and-the-shared-hold): the exclusive one, which runs each job alone on the desktop, and the shared
ones a machine opts into, which run beside each other
([design](doperpowers/specs/2026-10-21-mac-lane-concurrency-design.md)). A machine may also opt into
[the VM lane](#the-vm-lane): a guest macOS desktop beside the host's, booted for one job at a time.

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
| Labels | the exclusive instance: `self-hosted`, `macOS`, `ARM64` (what MAWS's `gate.yml` targets), `ci-kit-mac`, `ci-kit-mac-home` with `--home` (the mini only), and `ci-kit-mac-solo` with [the VM lane](#the-vm-lane); a shared instance: `ci-kit-mac-shared` alone |
| Directory | the exclusive instance: `~/actions-runner-maws` (work directory `~/actions-runner-maws/_work`); shared instance n: `~/actions-runner-maws-<n>` |
| LaunchAgent | `com.ssfskim.ci-kit.mac-runner` (shared instance n: `com.ssfskim.ci-kit.mac-runner-<n>`) — RunAtLoad, KeepAlive, `ProcessType` Interactive, Aqua session only; its program is the instance's own `runner-hold.sh`, which execs the runner's `runsvc.sh` unless the dialog watcher holds the runners |
| Hooks | `<instance>/ci-kit/hooks/job-started.sh` (admission on a Mac with shared instances, the desktop check, then the sweep), `job-completed.sh` (the [drain](#the-drain)'s job end, then the sweep, then the admission's release), a full copy from `mac/hooks/` in each instance |
| Dialog watcher | `com.ssfskim.ci-kit.dialog-watch`, one per machine — RunAtLoad, every 60 s, `ProcessType` Background, Aqua session only; runs the exclusive instance's `dialog-watch.sh` ([below](#the-dialog-watcher)) |
| Logs | `~/Library/Logs/ci-kit/mac-runner-hooks.log` (the hooks and the watcher, every instance's), `mac-runner.out.log` / `.err.log` (the exclusive runner; shared instance n's are `mac-runner-<n>.*`), `dialog-watch.err.log`, `<instance>/_diag/` |
| State | `~/Library/Logs/ci-kit/dialog-alert.state` (the dialog episode), `runner-drained` (the watcher's hold on every runner), `window-list.miss` (while the watcher cannot read the windows on screen, why); with shared instances, `desktop.lock`, `shared-hold`, `shared-running-<n>` and `shared-hold.alert` ([the shared hold](#instances-and-the-shared-hold)) |

**Why a LaunchAgent.** Electron windows need a WindowServer, which only the user's GUI session has; a LaunchDaemon runs
outside it. **Why one exclusive runner per machine.** e2e groups contend for the desktop (focus, pointer, clipboard), so
a job that has not been shown to be safe beside another runs alone: on the machine's exclusive instance, the only one
carrying the labels MAWS's jobs ask for. The base labels are shared, so GitHub gives
those jobs to whichever machine is idle, and one run's groups can split across the machines (the jobs API's
`runner_name` says where each ran). `ci-kit-mac-home` is the exception: only the mini's exclusive instance carries it,
for MAWS's measured and live e2e groups that require the home desktop. SSFSKIM is a user account with no runner groups;
to keep all jobs off a machine, disable its agents (below). Groups shown to be safe beside each other
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
repo=$(ssh mini 'source ~/Developer/GitHub/ci-kit/mac/repo.sh; ci_kit_repo')
gh api -X POST "repos/$repo/actions/runners/registration-token" --jq .token \
  | ssh mini "CI_KIT_VM_REPO=$repo ~/Developer/GitHub/ci-kit/mac/install.sh --name ci-kit-mac-mini --home --display 2560x1440@2x"
gh api -X POST "repos/$repo/actions/runners/registration-token" --jq .token \
  | ssh mini "CI_KIT_VM_REPO=$repo ~/Developer/GitHub/ci-kit/mac/install.sh --shared 2"   # ci-kit-mac-mini-2 and -3, installed disabled
```

**One repository setting.** `CI_KIT_VM_REPO` is an `owner/repository`, defaulting to `SSFSKIM/MAWS`.
The installer stores it in the exclusive runner's `~/actions-runner-maws/.env`; re-installs preserve it.
`mac/repo.sh` reads only that key as data, never sources `.env`. Registration, the installed VM launcher's queue
and JIT calls, and `bake.sh` all use that same setting. An explicit process/LaunchAgent environment wins over
`.env` (useful for a rehearsal); do not duplicate it in the VM plist if `.env` is the source you intend to edit.
The baker passes the resolved name to the guest's `workrepo` step for the seed's origin. JIT cleanup keeps the
repo recorded at mint time, so changing the setting never redirects a pending DELETE to another repository.

To deploy this support, refresh the checkout, then run `mac/install.sh` on the drained Mac with its existing VM
lane installed. This republishes the whole `~/ci-kit-vm/kit` (including the new `repo.sh` and updated `install.sh`,
`vm/lane.sh`, `vm/bake.sh`, `vm/provision.sh`), writes `CI_KIT_VM_REPO=SSFSKIM/MAWS` in the exclusive runner's `.env`,
and reloads the enabled services. The shared instances' hooks and environments are refreshed too; their disabled
state is preserved. No guest image rebuild is needed to install the setting; a later bake uses it for the seed.

At a repository move, drain first, edit that **one line** in `~/actions-runner-maws/.env`, then boot out and bootstrap
`com.ssfskim.ci-kit.vm-lane` in `gui/$(id -u)` using its existing plist in `~/Library/LaunchAgents/` (only if enabled).
The launcher reads the setting at startup; the next bake or install reads it on invocation. Existing host runner
registrations are not changed by this edit, and need no restart just to retain them. Verify their association in
the destination repository before electing to re-register. If a registration was lost, remove its old server record
if still present, and its local `.runner`, `.credentials` and `.credentials_rsaparams` while drained, then run the
registration command above with a destination token. `--uninstall` alone retains those files and cannot re-register.

A fresh **EC2 Mac** registration does not restore its manually assigned `ci-kit-mac-ec2` routing label. Snapshot
labels before re-registration, then find the new runner id and restore it (and any other missing snapshot labels):

```bash
# repo is the same target used for registration; id is the new ci-kit-mac-ec2 runner id.
gh api -X POST "repos/$repo/actions/runners/$id/labels" -f 'labels[]=ci-kit-mac-ec2'
```

Compare all labels against the snapshot, not just the runner name; keep the mini's shared instances disabled.

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
- **Expected display.** `--display 2560x1440@2x` sets the main display's logical width and height in points and backing
  scale, not physical panel pixels. A re-run keeps it from the exclusive instance's `.env`; passing `--display` again
  replaces it. It reaches every instance and the watcher as `CI_KIT_DISPLAY`, alongside `CI_KIT_MACHINE`. A machine
  never given a display setting behaves as before. This checks the display; it never sets a mode or starts BetterDisplay.
- **Home desktop.** `--home` adds `ci-kit-mac-home` to a newly registered exclusive instance, never a shared instance.
  Only the mini gets it, never a second Mac. The exclusive `.env` keeps `CI_KIT_HOME=1`, so every refresh remembers the
  choice and prints the label note. As with the VM lane's solo label, an existing registration keeps its labels: add
  the label through GitHub's runner API or settings, not by registering again. The mini already has it (2026-10-26).
  For an existing runner whose numeric id is `<id>`:
  `gh api -X POST repos/SSFSKIM/MAWS/actions/runners/<id>/labels -f 'labels[]=ci-kit-mac-home'`.
- **Shared instances.** `--shared <n>` sets their count: instances 2 to n+1, each named `ci-kit-mac-<machine>-<i>`
  after the machine and registered with `--labels ci-kit-mac-shared --no-default-labels`, so it carries that label
  alone. One token on stdin registers every instance that needs it. Without `--shared`, a re-run keeps the count
  installed (the shared LaunchAgents), and a machine with none has none: sharing is opted into. Lowering the count
  unloads the extra instances and removes their LaunchAgents; their registrations and directories stay, as an
  uninstall leaves them.
- **Re-running** (no token, no name) refreshes every instance's hooks, `.env` and `.path`, and every LaunchAgent, and
  reloads them, the watcher's first. Before staging it refuses while a job runs on any instance; a job is a process
  whose executable is that instance's `Runner.Worker` (`runner-state.py`, below). That check is not enough: GitHub
  can offer a job while the files are being published. Immediately before stopping **each** instance (also when
  disabling it or lowering the shared count), it waits for `stopped` or two identical `idle <log> <size>` reads five
  seconds apart, as in [the drain](#the-drain). A new offer changes the log before its worker exists; a changed or
  unreadable answer keeps the instance running. This narrows the race to the final read and bootout, rather than the
  whole publication. The VM lane's publication and reload (or removal) finish and release its lock **before** these
  host-runner waits, so a VM-safe host job does not keep the VM launcher offline. It reports the wait once a minute
  and gives each instance about two hours (`CI_KIT_INSTALL_IDLE_WAIT`, seconds; default `7200`). At the limit it leaves
  that agent's loaded/enabled state alone, finishes the other instances, then exits nonzero naming the pending
  restart/removal and asking for a re-run. Published hooks, environment and plists stay complete; an unrestarted listener keeps its old
  environment until the retry. On success the exclusive instance ends enabled, as before. **A shared instance keeps
  the enabled state launchd has for it** (`launchctl print-disabled`; a state that cannot be read counts as disabled),
  and a new one is installed disabled,
  so a refresh never turns a shared instance on or off: that is done per instance (below). While the watcher holds the
  runner, the install loads it held and says so (`loaded, held by the dialog watcher (…)`) instead of waiting for it
  to listen: it starts when the episode closes. New hooks and the optional
  compiled helpers (`cursor-park`, `window-list`) are staged and checked in a sibling directory. Darwin's atomic
  `RENAME_SWAP` exchanges that directory with `ci-kit/hooks/`, so the fixed hook paths in `.env` never disappear
  between renames: a job starting during publication finds either complete set. Copy or validation failures leave the
  old set untouched; a Swift compile failure still warns and installs without that helper (its log is
  `~/Library/Logs/ci-kit/<helper>-build.log`).
- **The VM lane.** `--vm` installs it beside the instances, and a re-run keeps it; `--no-vm` removes it
  ([the VM lane](#the-vm-lane), "Install, enable, remove"). Without it, `install.sh` installs and reads nothing of the
  lane.
- **Prerequisites** checked on the PATH jobs get: Node ≥ 22.12 (MAWS's `engines`), corepack, the Xcode command line
  tools' `clang` (native modules such as `node-pty`), `python3` (node-gyp), and git. Project applications are not
  registration prerequisites: jobs apply their repository's declaration after checkout. MAWS's setup action installs
  its own Node 22 and pnpm per job into the runner's tool cache; the system Node runs MAWS's plan job when it lands here (`GATE_RUNNER=macos`) and the hooks. A
  Homebrew install that asks no password closes a gap; anything that needs one goes to the human.
- **The runner version** is pinned with its checksum in `install.sh` for the first install; after that the runner
  updates itself, as GitHub requires.
- **Environment.** `.env` sets `LANG=en_US.UTF-8` (the mini's locale is Korean, and jobs parse tool output), the two
  hook variables (each instance's own copy of the hooks), and `CI_KIT_MACHINE`, the machine's short name, the same in
  every instance; when configured, `CI_KIT_DISPLAY` is too. The exclusive instance remembers `--home` with
  `CI_KIT_HOME=1`. A shared instance's adds `CI_KIT_SHARED_DESKTOP=1`, which its jobs read to know the desktop has
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
while a job runs on any instance at the initial check. It uses the same per-instance idle wait immediately before
stopping each runner. If one times out, already-idle instances are removed, but the busy instance's agent, the watcher,
its holds and the VM lane stay; it exits nonzero and asks for a re-run. Only after every runner is stopped does it
remove the watcher and holds:

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

**A system dialog on screen fails the job at once.** Before anything else, the job-started hook
(`mac/hooks/desktop-check.sh`) reads the frontmost app with `lsappinfo`. If it is `UserNotificationCenter`,
`CoreServicesUIAgent`, `SecurityAgent` or `loginwindow`, a system dialog or the login screen holds key focus, and every
e2e group would fail on focus and pasteboard (2026-10-16: seven groups red with `UserNotificationCenter` frontmost).
Each is known by its bundle id as well as its name (`mac/hooks/dialog.sh` holds the one list the hook and the watcher
share), because `lsappinfo`'s names are localized. Messages and titles always carry the canonical name.

One of them with a window on screen fails the job too, whatever is in front. SecurityAgent and UserNotificationCenter
panels float over other apps' windows without focus, where a group's real input (cua, cursor moves, key events) could
answer a keychain or permission prompt, and its screenshots would see it (2026-10-21: a SecurityAgent keychain prompt
sat on the mini's screen for hours with Terminal in front). The hook reads the windows on screen with `window-list`
(`mac/hooks/window-list.swift`, which `install.sh` compiles beside the hooks): each window's owner, layer, alpha and
bounds, which need no Screen Recording grant; a window's title would, and is never read. A listed dialog's window
counts once it shows (some alpha, some area); a running process alone does not, since SecurityAgent outlives its
window. In a logged-in, unlocked session none of the four owns a window on screen, `loginwindow` included (read on the
mini, macOS 27, 2026-10-21): its windows are the lock screen and its shut-down and Force Quit panels, each the human's
to answer like the rest. The job then fails at "Set up runner" with one of:

```
ci-kit: a system dialog (<dialog>: <likely source>) holds focus on the <machine> since <first seen> — dismiss it there and rerun
ci-kit: a system dialog (<dialog>: <likely source>) is on screen without focus on the <machine> since <first seen> — dismiss it there and rerun
ci-kit: a system dialog (SecurityAgent: security request from codesign) holds focus on the mini since 2026-10-17T05:12Z — dismiss it there and rerun
```

The hooks log adds the dialog's window to the frontmost app (`frontmost is 터미널; on screen: SecurityAgent (pid 4711,
layer 2002, 520x260 at 1020,400): …`); with the frontmost app unreadable the line says `is on screen`.

`<machine>` is the runner's `CI_KIT_MACHINE` (`mini` on the mini). `<first seen>` is the dialog episode's, the same
time its alert title carries ([below](#the-dialog-watcher)). Every refusal line starts with `ci-kit: ` and ends with
`rerun`; MAWS's `scripts/ci-gate.sh` tells a refused job by that shape. Dismissing the dialog is the human's, in
that machine's GUI session (never an agent, never cua). The dialog read uses `lsappinfo` and `window-list` alone:
AppleScript or System Events would raise TCC prompts. When `lsappinfo` fails or prints nothing, the job is not blocked
unless a dialog is on screen or the configured display check fails; when `window-list` is missing (a failed compile), fails or passes its 5 s deadline, a
dialog is seen only in front, as before it existed. Either miss is logged. Every check logs a `desktop-check` line (the
frontmost app) to the job's log and the hooks log.

**A configured display is checked before every job.** `--display` opts a machine into a read-only check of
`cursor-park --describe`, the same main-display probe used in posture below. Either different logical dimensions or a
different backing scale refuses the job before Terminal is opened, even if the frontmost app is unreadable. For example:

```text
ci-kit: display 1920x1080@1x, expected 2560x1440@2x on the ec2; desktop held since 2026-10-26T05:12Z — restore its display there and rerun
```

A missing, failed, timed-out or invalid probe gets two retries (three attempts total, each with a 1 s deadline).
A successful retry is judged normally and a transient miss opens no episode. Three misses are `display unreadable`
and refuse the job rather than running blind. The watcher uses the same retry policy, but still requires two blocked
minute ticks before opening an episode between jobs. Once open, only three consecutive ticks with a matching display
and no dialog release the runners; an unreadable display is never a clear read. A failed `cursor-park` compile therefore
leaves a configured machine refusing jobs until the helper is restored. No setting means no extra probe or refusal.
The check does not change display modes, launch BetterDisplay, or use AppleScript. The owner restores the desktop.

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
Terminal as `터미널`. System dialogs are never touched, and an unreadable frontmost app alone still lets the job run. The hook
acts only before the job, so it never fights MAWS's own `MAWS_E2E_FOREGROUND=1`, and it does take the front from
whoever is using the machine's desktop when a job starts.

**Desktop posture is visible in the job log.** After start's Terminal/cursor work, and at job completion before
cleanup can hide a leaked app, `desktop-posture.sh` prints one line to stdout and the hooks log:

```text
ci-kit desktop (start): frontmost=Terminal display=2560x1440@2x remote=parsec hid_idle_s=356 load=3.12/2.87/2.51 computeruse=none
ci-kit desktop (end): frontmost=Google Chrome display=2560x1440@1x remote=none hid_idle_s=20 load=15.70/11.06/6.38 computeruse=SkyComputerUseService,cua-sandbox-golden
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
  history is unknown. A parsecd killed by a signal or crashed writes no `disconnected.` line, so when the log shows a
  client, another read checks for Parsec's host process by its path (`*/Parsec.app/Contents/MacOS/parsecd` in
  `ps -axo pid=,comm=`; Apple's CoreParsec runs a `parsecd` of its own): none running reads `none`, while a failed or
  stalled table keeps the log's answer.
  Screen Sharing is `screensharingd` running, matched by its exact name in the same non-root `ps -axco pid=,comm=`
  table the computer-use read uses. launchd holds the Screen Sharing listener and starts the daemon when a viewer
  connects, so the read covers every transport the daemon serves: TCP 5900 or a remapped port, a tunnel, and
  [High Performance Screen Sharing's](https://support.apple.com/guide/remote-desktop/use-high-performance-screen-sharing-apdf8e09f5a9/mac)
  UDP. `SSMenuAgent`, which keeps running after a session, and this Mac's own outgoing viewer (`Screen Sharing`) are
  not counted.
  Failed, timed-out or unrecognized reads give `unknown` unless another signal already establishes a remote connection.
- `hid_idle_s`: seconds since the last HID input, rounded down from `IOHIDSystem`'s `HIDIdleTime` nanoseconds
  (`ioreg -c IOHIDSystem -d 4`, read-only, no TCC). A failed, timed-out or malformed read gives `unknown`. This is
  input reaching the desktop, not proof of a person's action: computer-use automation can reset it too. CDP's
  synthetic hover is not HID input. `cursor-park` uses `CGWarpMouseCursorPosition`, which
  [generates no mouse event](https://developer.apple.com/library/archive/documentation/GraphicsImaging/Conceptual/QuartzDisplayServicesConceptual/Articles/MouseCursor.html),
  and does not reset this timer. Checked read-only on the mini on 2026-10-29: at 08:27:12Z the idle age was 658 s
  (last input about 08:16:14Z), despite its 08:17:02Z park moving the cursor from `66,0` to `1280,2` and three later parks.
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

The start hook records a post-park boundary in `~/Library/Logs/ci-kit/desktop-input-<worker pid>`. At end, input newer
than that boundary produces `::warning::ci-kit desktop input during this job: hid_idle_s=… remote=…
computeruse_start=… computeruse_end=…` in the job log and hooks log. The warning says the input may be a person's or
computer-use automation's, including the job itself, not proof of human interference. It helps diagnose a hover or
focus red without changing the job's result. The worker and run/attempt/job identity keep concurrent jobs separate;
end consumes the record. Missing records or unknown idle reads produce no warning. A one-second margin avoids
blaming input on the rounded start boundary; this is an end snapshot, not an event recorder, and cannot establish
who supplied input. The boundary begins after Terminal/cursor work, not when the worker was first assigned.

Computer use is a **presence snapshot at the job's two edges**. It is the evidence for MAWS's rule (its gate-offload
Decision Log 58) that a computer-use session drives the shared desktop only between jobs: a name at `start` was running
as the job began, a name at `end` was still running when it finished. A session that started and stopped inside the job
leaves nothing here, and a running service is not proof that it drove the desktop; for the stretch between, the unified
log is still the record (`/usr/bin/log show --predicate 'process == "SkyComputerUseService" OR process BEGINSWITH "cua"'`,
the full path because zsh has a `log` builtin). The names were checked on the MacBook (macOS 26) against running
processes carrying them, and the mini's (macOS 27) `ps -c` output read-only.

Screen Sharing is a **daemon signal, not authentication proof**. launchd starts `screensharingd` when a connection
arrives, before anyone authenticates, so a viewer still at the login prompt reads `screensharing`. The daemon can
linger about 5 min after the last viewer leaves (the mini, macOS 27, 2026-10-22); two earlier reads on 10-18 saw it exit
after 15 s. `ScreensharingAgent` went with the daemon, and `SSMenuAgent` was running afterwards. `none` means the daemon
was not running; remote control that does not go through it is not covered. The
read used to be `netstat -an`'s incoming 5900 sockets, which works from ssh and launchd agents but not in a job hook:
inside Runner.Worker's process tree the kernel's Internet socket list is withheld (likely Local Network privacy, not
proven), netstat exits 0 without its `Active Internet connections` section, and the read printed `none` with a viewer
attached ([#50](https://github.com/SSFSKIM/ci-kit/issues/50)). The process table is not filtered there: a job's `ps`
lists root's processes, `screensharingd` among them.

The seven posture reads — frontmost, display, Parsec, Screen Sharing, HID idle, load and computer use — each have an independent,
unconditional 1 s Perl-supervisor deadline, which kills and reaps a hanging probe even if it ignores SIGALRM.
Supervision covers the direct child before it has established its process group, as well as the group's descendants.
Results are combined only afterward, so a positive Parsec read survives a hanging Screen Sharing read and vice versa.
All seven timing out takes about 7 s plus process overhead. Local positive fixtures scale the supervisor's clock only
inside their test processes so scheduling load does not look like a failed read; hanging fakes sleep far beyond it. The
all-seven-hung and delayed-process-group regressions use the real, unscaled clock. Fixtures also cover interleaved
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
| `vm` | `none` | no guest of the VM lane may be running (`vm-reserved` is absent); only on a Mac with the lane installed |
| `bound` | `15` | minutes: the job is refused once the next read would come after them |

`any` leaves a condition unchecked. A malformed input fails the step with `ci-kit settle: <input> takes …` (exit 2),
never in the refusal's shape.

**On a Mac with the VM lane** (its launcher's LaunchAgent file is installed), `vm: none` also raises the measured
claim before the first read: `vm-claim.<worker>` in `~/Library/Logs/ci-kit`, naming the job and its `Runner.Worker`,
which keeps the lane from booting a guest until the job's job-completed hook removes it. The line names the claim, and
each posture carries `vm=none|reserved|unknown`. A claim that cannot be raised (no `Runner.Worker` among the step's
ancestors, the desktop lock not taken) refuses the job at once with a `ci-kit: … rerun` line. `vm: any` neither claims
nor waits. Without the lane the input changes nothing and the line is as below.

**Settled** is two reads 30 s apart that each meet every condition, so a quiet desktop releases the job 30 s in. A read
is `desktop-posture.sh --read`: the posture line's seven reads under their 1 s deadlines, printed without the line's label
and logged nowhere. A read that fails is `unknown`, and unknown meets no checked condition: an unreadable load holds
the job as a high one does. `hid_idle_s` is informational here, not an additional measured-job condition.

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

**A remote viewer alone refuses after 6 min.** With `remote: none`, if a viewer is the only failed condition in every
read for 6 min, the guard refuses early, naming the viewer and how long it alone held the job. Screen Sharing's daemon
can linger about 5 min after disconnect, so a viewer just closed still gets time to clear; a forgotten viewer no longer
costs the whole 15-min bound (MAWS lost about 30 min that way on 2026-10-28). A read with another failed condition —
load, display, computer use, VM or an unknown read — or with no viewer restarts that window. Those conditions still
wait to the bound, as does any remote-only stretch shorter than 6 min. `remote: any` changes nothing, and a shorter
bound still governs. The early refusal has the same `ci-kit: … rerun` shape and the same two logs:

```text
ci-kit: the mini did not settle for a measured job (screensharingd alone for 360 s); waited 360 s; start: frontmost=Terminal display=2560x1440@2x remote=screensharing load=1.52/6.00/5.00 computeruse=none; refusal: frontmost=Terminal display=2560x1440@2x remote=screensharing load=1.52/6.00/5.00 computeruse=none — fix that there and rerun
```

**Keeping other work off the Mac while it measures.** The guard reads the load only before the job. Work started on
the machine afterwards still lands in the measurement: Claude sessions living there, or evals and renders that other
sessions start there over ssh. On 2026-10-28, three of four MAWS idle-bound runs were void at loads of 11 to 26 that
way, while two eval scripts ran there. The claims and holds tell such work to wait:

- **A measured job is running:** its claim, `~/Library/Logs/ci-kit/vm-claim.*`, has a first line starting
  `measured claim since` (on a Mac with the VM lane). The claim exists from the guard's first read until the job's
  job-completed hook removes it.
- **A measurement window is held:** `~/.local/state/ci-hold`, written by whoever coordinates a set of measured runs
  back to back, so the gaps between jobs are covered too. It holds `until=<UTC, ISO 8601>` and `by=<who, what for>`,
  and its writer removes it when the set ends. An `until` in the past counts as no hold. For a daily window or an on-demand operator drain, the
  operator writes `~/.local/state/ci-quiet` instead: `<HH:MM>Z <HH:MM>Z <who, what for>`, one UTC window per line
  (the [drain](#the-drain) below). Unlike `ci-hold`, a quiet window also drains CI runners and prevents VM boots.

A launcher that runs heavy work on the Mac waits while any is in force, and does well to wait while the 1-minute load
is 5 or more as well (the guard's own bound):

```bash
source ~/actions-runner-maws/ci-kit/hooks/quiet.sh
held() {
  local until
  quiet_read
  [[ -z $quiet_windows ]] || return 0
  until=$(sed -n 's/^until=//p' ~/.local/state/ci-hold 2>/dev/null)
  [[ -n $until && $(date -u +%Y-%m-%dT%H:%M:%SZ) < $until ]] && return 0
  grep -lqs '^measured claim since' ~/Library/Logs/ci-kit/vm-claim.* 2>/dev/null
}
```

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
as its run. Every other job keeps its labels and runs alone. **What such a job may rely on:** its runner environment
sets `CI_KIT_SHARED_DESKTOP=1`, which no exclusive job's does, and its runner's name, `RUNNER_NAME`, is
`ci-kit-mac-<machine>-<n>`, ending in `-<n>`, the instance's number (2 and above); `install.sh` keeps the short name of
a machine with shared instances from ending in `-<number>` itself. MAWS gives each instance its own window origin and
build cache by that number.

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
  A worker is known by the kernel's path of its executable (`runner-state.py --workers`), never by a command line,
  which `ps` prints unquoted; and the sweep is the exclusive instance's own copy, given that work directory, so a
  shared instance an install left half-way, without its hooks, stops nothing.
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

## The VM lane

A second macOS desktop on the mini: a guest, run by Tart (`/opt/homebrew/bin/tart`) over Apple's
Virtualization.framework, booted fresh for one job from a golden image and deleted after it. A job that needs a
desktop to itself runs there beside the host's jobs, and keeps running while the host's desktop is held for an untimed
GUI session. Memory, not CPU, is what binds on the mini's 16 GB, so the lane is admitted job by job: by the host's
admission lock, by a memory guard, and by the coordinator's holds. The design and its reasons are the
[concurrency spec](doperpowers/specs/2026-10-21-mac-lane-concurrency-design.md) ("The VM lane"); the lane is opted
into per machine (`install.sh --vm`), and a Mac without it has none of what follows.

**The parts.**

| | |
|---|---|
| Launcher | `mac/vm/lane.sh`, the program of the LaunchAgent `com.ssfskim.ci-kit.vm-lane` (RunAtLoad, KeepAlive, Aqua session only, `ProcessType` Interactive), run from the installed kit. It is the only automated way a guest starts: it reads the queue every 15 s, decides admission, boots a job clone, follows it through its one job and deletes it. Its header has the lifecycle, the boot rule, the guard and every input. |
| Installed kit | `~/ci-kit-vm/kit`, a copy of `mac/` plus `setup/`, `plan/` and `vendor/` (the setup applier and its imports) that `install.sh` publishes with the hooks' staged swap, so the checkout can move on. Every clone is shown it read-only, so a hook change needs no image refresh. |
| Golden image | the local Tart VM `~/ci-kit-vm/golden` names (`maws-vm-golden-<id>`): the macOS 27 base (`ghcr.io/cirruslabs/macos-golden-gate-base`) with ci-kit's Node 22, pnpm, runner, seeded work repository and compiled helpers, plus the tools and warmed caches supplied by the project's declaration. It is never run for a job; only the [maintenance procedure](#the-vm-lanes-maintenance) makes or replaces it. |
| Job clone | `maws-vm-job-vm-<time>`, an APFS copy of the golden image (seconds; it holds only what the job writes), run with `tart run --no-graphics --no-clipboard` (its pasteboard is never the host's) and four directory shares: the kit and this clone's JIT directory read-only, its `out/` and `cache/` read-write. |
| Slot | `~/ci-kit-vm/vm/`: `jit/<clone>/` (a 0700 directory holding the 0600 one-use config and cleanup record, removed at teardown), `out/` (what the guest writes back: its markers, `_diag`, its hooks log), `cache/` (MAWS's e2e build cache). The trial slot, `~/ci-kit-vm/vm-trial/`, is the same for a candidate's trial and serves nothing else. |
| In the guest | `mac/vm/guest/`: `kickoff.sh` (run by `tart exec`, which is gRPC to the Tart guest agent, never the guest's address) makes the clone the slot's runner and starts `wrapper.sh`, which supplies the JIT config to `run.sh` through its masked secret input environment, writes the `out/` markers (its header is the protocol), answers the idle stop and powers the guest off; `hooks/` is the guest's start and end, cut down: the display and dialog check, Terminal in front, the posture line with `vm=` and `clone=`, no sweep, no alert, no `gh`. |
| State | in `~/Library/Logs/ci-kit`, each file replaced whole, written under `desktop.lock`: `vm-reserved` (the slot's reservation), `vm-released` (the last release's epoch second), `vm-hold.<owner>` (the holds, written and removed by `mac/vm/hold.sh`), `vm-claim.<worker>` (host jobs keeping the guest out), `vm-pause` (the guard's), and the launcher's own `vm-failures` and `vm-lane.alert.<kind>`. |
| Logs | `vm-lane.log` (every decision, every boot's reads, the guard's samples, each clone's `out/` folded in at its end), `vm-run.log` (the clones' `tart run` output), `vm-out/<clone>/` (the last 20 clones' `out/`), `vm-bake.log` (the maintenance procedure's transcript); the guest's hook lines land in `mac-runner-hooks.log`. |

**One registration per clone.** Before booting, `jit.py` mints `generate-jitconfig` through the machine user's
existing `gh` login, with `GH_TOKEN` and `GITHUB_TOKEN` removed just as the queue reader does. No new credential or
token file is installed. GitHub itself holds a JIT runner to one job; the old persistent runner's `--once` could
lose the next queued job to an exiting poll (actions/runner#4728). A mint failure logs a reason, boots nothing and
retries on the lane's next poll. Each clone sees only its own config, never in argv, logs or `out/`; the listener
consumes and removes `ACTIONS_RUNNER_INPUT_JITCONFIG` before workers start and writes identity files under umask 077.
After the verified end, teardown revokes the local config, moves only the nonsecret cleanup record to
`jit-pending/<clone>/`, and releases the reservation. A bounded background worker retries remote deletion on later
loops (404 is fine), logging failures without blocking boots or guard samples. Recovery
also finds a mint interrupted before the clone existed, using the record written before POST and its unique name.

`bake.sh --register` is retired and refuses without booting. Existing `vm/identity/` and `vm-trial/identity/`
directories are unused and not shared or modified. Once installed, the old persistent GitHub registrations
`ci-kit-mac-<machine>-vm` and `ci-kit-mac-<machine>-vm-trial` can be deleted by the coordinator; this change does not
delete them. `--trial` mints its own config with only `ci-kit-mac-vm-trial` and cleans it up by the same path.
An interrupted trial's stopped registration is retired by the next trial or `--retire <trial clone>`; the lane also
retries the trial slot's pending deletions. A local revocation failure still holds teardown; an API hiccup does not.

**The reservation.** `vm-reserved` means "a job clone of this slot may be running", whatever became of the launcher
that wrote it. It is written in the same locked step that spawns the clone, before the clone exists, and removed only
after Tart shows the clone stopped and it is deleted. A launcher that dies leaves its guest running (`tart run` is
detached), so the reservation is never read as stale by its writer's pid: settle, the exclusive hook, `install.sh` and
`bake.sh` all read its presence alone.

**Labels and what MAWS does.**

| Runner | Labels | Who reaches it |
|---|---|---|
| `ci-kit-mac-<machine>` (the exclusive instance) | today's, plus `ci-kit-mac-solo` | today's jobs, and a solo job when it is free |
| `ci-kit-mac-<machine>-<job clone>` (the guest) | `ci-kit-mac-solo`, `ci-kit-mac-vm` (JIT labels, no OS/architecture defaults) | a solo job when it is free, or a job forced to the guest |
| `ci-kit-mac-<machine>-<trial clone>` (a candidate's trial clone) | `ci-kit-mac-vm-trial` alone | a trial commit's job, and nothing else |

A job that asks for `[ci-kit-mac-solo]` runs on whichever of the exclusive instance and the guest is free: GitHub's
assignment does the balancing, and the launcher boots a clone only when the host will not take the job first. MAWS
(its `gate.yml` and plan) sends its `MAC_VM_E2E` groups to `[ci-kit-mac-solo]`, keeps every `MEASURED_E2E` group on
today's labels, honours `Lane: vm` (`scripts/ci-gate.sh --lane vm`: those groups to `[ci-kit-mac-vm]` alone) and
`Lane: vm-trial` (to `[ci-kit-mac-vm-trial]`, a candidate's trial and nothing else), and gives a solo job the exclusive
wait in its timeout. **What a guest job may rely on:** its runner environment sets `CI_KIT_VM_GUEST=1` (MAWS's budgets
treat a guest as a loaded host), its `CI_KIT_MACHINE` is `<machine>-vm`, and `RUNNER_NAME` ends in no `-<n>`.
**Every host instance** of a Mac with the lane sets `CI_KIT_VM_RESERVATION=<absolute path to vm-reserved>` in its
`.env` (normally `$HOME/Library/Logs/ci-kit/vm-reserved`), not the old static `CI_KIT_VM_LANE=1`. MAWS's budgets read
whether a guest overlapped the test, not whether a lane is installed or enabled: for a test started at wall-clock time
`t0`, read at verdict time, first the reservation path and then its sibling `vm-released`. The host reads as loaded
if the reservation exists **or** `vm-released >= floor(t0 in seconds)`. An unreadable path, other than not-found,
reads as loaded; a malformed stamp does too. Read the reservation first so a release between the two reads is caught
by the stamp. A guest that boots after the test's start is covered even if it ends before the verdict; an idle lane
no longer loosens every host bound. Epoch-second rounding can conservatively include a guest released earlier in
the test's starting second.

Every reservation release, including failed boots and recovery, atomically replaces `vm-released` with one line
from `date +%s` (temporary file, then rename), **before** removing `vm-reserved` and only once the clone is gone.
A stamp write failure is reported in `vm-lane.log` and the release still proceeds: a test may then assert a tight
bound beside a guest that just ended, a visible flaky red rather than a hidden pass. The last stamp stays between
jobs. MAWS's alert reader treats `-vm` and `-vm-trial` as machines of their own, and the guest never opens an alert.

The exclusive instance gains `ci-kit-mac-solo` when it is registered with `--vm`. An instance registered before keeps
its labels; add the label from the MacBook (the runner keeps its registration and needs no restart):

```bash
id=$(gh api repos/SSFSKIM/MAWS/actions/runners --jq '.runners[]|select(.name=="ci-kit-mac-mini").id')
gh api -X POST repos/SSFSKIM/MAWS/actions/runners/$id/labels -f 'labels[]=ci-kit-mac-solo' --jq '[.labels[].name]|join(",")'
#   expect: self-hosted,macOS,ARM64,ci-kit-mac,ci-kit-mac-solo
```

**Admission: the job boot, under the host's lock.** At each poll the launcher boots a clone only when all of these
hold, and it logs what fails, once per change, and what it read at each boot:
1. a queued job of `SSFSKIM/MAWS` asks only for labels among `ci-kit-mac-solo` and `ci-kit-mac-vm` (read with the
   machine user's own `gh` login, `Actions: read`);
2. the host will not take it first: a `ci-kit-mac-vm` job always counts; a `ci-kit-mac-solo` job counts while the
   exclusive instance is busy, held by the dialog watcher or offline, or when more than one is queued;
3. nothing holds the lane: no `vm-hold.<owner>`, no live `vm-claim.*`, no `vm-pause` in force;
4. no guest exists: no `vm-reserved`, and the process table has no `tart run` of a `maws-vm-*` VM (options may come before or after its name);
5. the memory guard and the disk reserve admit (below);
6. the host's main display is at @2x, since the guest takes its density from it at boot;
7. the mode allows it: `CI_KIT_VM_LANE_MODE` `always` (the default), or `hold-only` with every host instance held or
   stopped;
8. every host job now running is VM-safe, which is 3: a job that is not holds a claim.

Conditions 3 and 4 are read again under `desktop.lock`, in the one step that writes the reservation, clones and spawns
`tart run`; nothing can release the reservation between its write and the run. The lane never stops a running guest to
admit anything else: a measured job, a timed hold and the maintenance procedure each wait for it.

The idle poll reads processes, never `tart list`. The launcher reads Tart's local JSON list only on transitions:
just before an otherwise-admitted boot (including checking the golden), at verified teardown and deletion, and in
start-up recovery. Failed transitions retry until they settle; maintenance procedures also retain their state checks.
Even `tart list --source local` runs `diskutil image info --plist` on every local `disk.img`, attaching it and leaking
APFS IOKit objects on the mini. On 2026-10-28, a week of polling had left 232,825 AppleAPFSContainer objects and
9.76 of 16 GB wired (about 8 GB leaked); 15% free could not meet the guest's 57% boot floor. Only a reboot reclaimed
it. A normal job still pays three list calls (boot, verified end, deletion), but an unchanged idle lane pays none.

**Host jobs and the guest.**
- **A measured job** keeps the guest out through settle ([the measured-job guard](#the-measured-job-guard)): `vm:
  none` raises the measured claim at the first read, so nothing boots from then on, and releases the job only once no
  reservation stands.
- **Every other exclusive job is classified** before today's start: its job-started hook reads the workflow file it
  runs under, at `GITHUB_WORKFLOW_SHA`, through the machine's own `gh` login (bounded 10 s), for the contract line
  `# ci-kit-vm-contract: 1` (MAWS's `gate.yml` carries it, and MAWS's tests pin what it promises: every timed group is
  on `MEASURED_E2E`, and every measured job runs settle). The job log says which: `vm-safe: yes (contract 1)` runs
  beside a guest; `vm-safe: unknown (<why>)` (no line, another number, a read that fails, an empty SHA, as an old
  sha's rerun has) is treated as measured: the hook raises `vm-claim.<worker>`, waits for the reservation to go within
  the exclusive bound, and keeps the claim to its end hook. Past the bound it is refused:

  ```
  ci-kit: the guest on the mini did not make way for a job of unknown kind (after 10 min: …); waited 600 s — rerun
  ```

- **Shared instances** need no classification: only a contract workflow can ask for their label.
- A guest job refused by the guest's own start (a dialog in the guest, a display off geometry) carries the lane's
  shape, naming the guest: `ci-kit: a system dialog (…) holds focus in the guest mini-vm (vm=vm clone=…) — if every
  clone shows it, answer it in the image; rerun`. Two such refusals in a row pause the lane with an alert: a fresh
  clone that refuses twice shows an image fault.

**Holds have owners, and keep each other.** A hold is a file of its own, `~/Library/Logs/ci-kit/vm-hold.<owner>`,
written and removed by its owner alone (CI-opt names it after the session that booked the mini), always through the
installed kit's `vm/hold.sh`; the lane is held while any exists, so one owner's release never drops another's.
`hold.sh` writes and removes a hold under `desktop.lock`, the lock the launcher's boot holds from its read of the holds
through its reservation's write, so a hold is either seen by a boot, which then boots nothing, or written after that
boot's reservation, which its wait then sees. A file written by hand has neither guarantee: it can land between the
boot's read and its reservation, and a wait for the reservation's absence then reports no guest while one boots. The
owner is a name (`[A-Za-z0-9][A-Za-z0-9._-]*`, not ending in `.tmp`, which the holds' readers skip as a write under
way), refused otherwise. The first line says its kind. Each hold is logged once per change, and alerted after 6 h
(`ci-kit alert: vm lane on <machine> held by <owner> since <minute>`).

`hold.sh`'s own check comes too late for an `ssh` command line: the remote shell parses the command, owner included,
before `hold.sh` runs. Every command below goes through this helper, pasted into the coordinator's shell first, which
checks the owner locally and quotes each argument into the remote command (`printf %q`), so the remote shell reads each
as one word:

```bash
# vm_hold hold <owner> timed|maintenance | vm_hold release <owner> | vm_hold wait
vm_hold() {
  [[ $1 == wait ]] || { [[ ${2:-} =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && $2 != *.tmp ]] || { echo "vm_hold: not an owner: ${2:-}" >&2; return 2; }; }
  ssh mini "~/ci-kit-vm/kit/vm/hold.sh $(printf '%q ' "$@")"
}
```

The booking a session makes through CI-opt says which kind it needs:
- **Untimed** (cua's functional sessions): CI-opt takes the host's instances down as for any hold (below) and leaves
  the lane running, so the guest goes on taking `solo` jobs while the session has the host's desktop. No marker.
- **Timed** (MAWS's benches, anything that reads the machine's timing): the marker first, then the wait for the
  reservation to go, then the host's instances; at release the marker is removed first, then the instances come back.

  ```bash
  owner=<session>   # the booking session's name: one file per owner
  vm_hold hold "$owner" timed
  #   expect: ci-kit vm hold: held: …/vm-hold.<owner> (timed), then ci-kit vm hold: no guest
  #   (at most the running bound; in practice the guest job's own length and its boot). Exit 1, "not clear after …",
  #   means a guest is still there: the hold stays; run `vm_hold wait` until it says no guest.
  # … take the host's instances down, as for any hold; the session runs …
  vm_hold release "$owner"   # at release, before the instances come back
  #   expect: ci-kit vm hold: released: …/vm-hold.<owner>
  ```

  A hold script that forgets the marker gets a guest beside its bench.
- **Maintenance** is the [procedure below](#the-vm-lanes-maintenance), with the launcher's agent booted out as well.
- **The dialog watcher's drain** does not hold the lane: a dialog on the host is the host instances' problem, and the
  guest's jobs keep CI going through it.

**The memory guard and the disk reserve.** A boot needs memory pressure at level 1
(`kern.memorystatus_vm_pressure_level`), at least `CI_KIT_VM_MEMORY_FLOOR` % available (`kern.memorystatus_level`, 57;
V1's samples on the mini: a busy 4 GB guest moved the figure at most 8 points, 24 with a host e2e job beside it, and
pressure 2 began at 35–41 %, while a 3 GB surge left 53 %, which blocks a boot. V1's 60 stopped admitting once the idle
mini read 57–59 % (2026-10-25: a host e2e job reads 51–56 %), so the floor moved to 57, where a boot comes when the host
is idle), swap not grown over 60 s (`vm.swapusage`), and `CI_KIT_VM_DISK_RESERVE`
GB free on the volume of `~/.tart` (40); a read that fails admits nothing. From `tart run` to the clone's verified end
the launcher samples every 15 s into `vm-lane.log`: warning on two samples gives up a guest that holds no job (through
the idle stop) and pauses the next boot 2 min behind one that does; critical on one sample, or free space under 5 GB,
stops the guest in any state, with an alert (`ci-kit alert: vm lane on <machine> stopped a job for memory|disk at
<minute>`) and a pause. Such a job ends without a `ci-kit: … rerun` line: GitHub reports the runner lost.

**Recovery.** It runs at one point, the launcher's start (KeepAlive after a death, RunAtLoad after a reboot), under the
lock, before the first queue read, and it touches job clones and `vm-reserved` alone: a running job is adopted and
followed to its end, a guest without one is asked to stop or stopped, a stopped one is deleted and released. A golden,
a candidate, a trial clone or the base is never touched; while one of them runs the launcher boots nothing and alerts
after 10 min. A stop that fails, or a state that cannot be read, keeps the reservation, is retried each poll and alerts
after 10 min (`ci-kit alert: vm lane on <machine> cannot stop <clone> since <minute>`); nothing boots meanwhile. A VM
left running by hand is ended with the verified stop, the same check the launcher and `bake.sh` make before any delete:

```bash
vm=<name>
ssh mini "tart stop $vm --timeout 60; tart list --format json | python3 -c 'import json,sys; print([v[\"State\"] for v in json.load(sys.stdin) if v[\"Name\"] == \"$vm\"])'; pgrep -fl 'tart run' | grep -- '$vm\$' || echo 'no tart run'"
#   expect: ['stopped'] (or [] once deleted), then: no tart run
```

A reservation stands until the launcher's teardown removes it. Remove one by hand only after that check shows its VM
stopped or gone, with the launcher booted out.

**Failures** are counted by kind (`image`, `session`, `memory`, `disk`, `raced`) in `vm-failures`. Three `image`
failures in a row (a clone that never answers or never listens, one whose wrapper starts no runner and says why in
`out/unfit`, such as a display not at 2560x1440 with scaling on, a job past its bound) pause the lane with no expiry and
an alert, since the image is the likely cause; an operator lifts the pause by removing `vm-pause` once the image is
fixed. A listener that finds the slot's previous session still open (a clone that died mid-job) retries for up to
5 min and counts as `session`, apart from the image. An idle stop that raced a job's acceptance is reported with an
alert naming the job, which GitHub shows cancelled: rerun it.

**Install, enable, remove.** `install.sh --vm` installs the lane beside the instances ([Install, update,
remove](#install-update-remove)): the launcher's agent, disabled on a machine new to the lane; the kit and the slots;
`CI_KIT_VM_RESERVATION=<absolute path to vm-reserved>` in every host instance's `.env`; and Tart's directory on the
launcher's PATH (Tart is a prerequisite with `--vm`). A re-run without `--vm` keeps an installed lane and refreshes it,
the launcher keeping the enabled state launchd has for it; `--disabled` disables it with the runners; `--no-vm` unloads
and removes its agent and the `.env` reservation path, keeping `~/ci-kit-vm`; refresh also removes the old static flag.
`--uninstall` removes it with the rest. While the lane's reservation stands, or the maintenance hold is up, every one
of these refuses before anything changes: a reload would restart the launcher beside
its guest or bring it back into the procedure, and a publish would pull the kit from under a running clone. A guest
the launcher boots between that read and its bootout refuses the install too, and the launcher comes back to adopt
it. The lane boots nothing until a golden image exists (the [procedure](#the-vm-lanes-maintenance)) and its agent is
enabled:

```bash
ssh mini 'launchctl enable gui/$(id -u)/com.ssfskim.ci-kit.vm-lane; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ssfskim.ci-kit.vm-lane.plist'
ssh mini 'tail -3 ~/Library/Logs/ci-kit/vm-lane.log'
#   expect: … vm-lane starting (pid …, slot vm, mode always); recovery first … then the boot rule's first read
```

Check by hand:

```bash
ssh mini 'cat ~/Library/Logs/ci-kit/vm-reserved ~/Library/Logs/ci-kit/vm-hold.* ~/Library/Logs/ci-kit/vm-pause 2>/dev/null; cat ~/ci-kit-vm/golden; tail -5 ~/Library/Logs/ci-kit/vm-lane.log'
#   expect, between guest jobs: no reservation, the holds in force (if any), the golden's name, the launcher's last reads
gh api repos/SSFSKIM/MAWS/actions/runners --jq '.runners[]|select(.name|test("-vm"))|[.name,.status,.busy,([.labels[].name]|join(","))]|@tsv'
#   expect: ci-kit-mac-mini-vm  online|offline  …  ci-kit-mac-solo,ci-kit-mac-vm   (online only while a clone listens)
```

## The VM lane's maintenance

The golden image is made, tried and replaced by one procedure, the coordinator's (CI-opt), run with
`mac/vm/bake.sh` under a full hold of the mini with the launcher's agent booted out, so nothing automated boots,
recovers or releases while it runs. It is run on invalidation, never on a schedule: a runner the image's is behind
(`vm-lane.log` says `refresh trigger: the runner updated itself` per job), MAWS's Node or pnpm pins, a stale store
(a job's `pnpm install` past 60 s in `vm-out/<clone>/`), a setup step's `::notice::` that the image's declaration
hash differs from the commit's, a growing checkout delta from a long-unrefreshed work repository, the mini's macOS moving, a new Electron bundle id or LibreOffice version wanting its first-run window
again. Every job starts from the image's repository, not the preceding job's fetched commits, so a stale golden
makes each job fetch the accumulated delta again. A refresh takes the mini for its length, as a timed hold does.

`bake.sh` checks the hold before every step but `--retire`, and refuses without it: a `vm-hold.<owner>` whose first
line starts `maintenance` (`hold.sh hold <owner> maintenance` writes `maintenance since <time>`), no `vm-reserved`, the launcher's agent not loaded (`launchctl print`), and no launcher
holding `vm-lane.lock`. It holds that lock itself for each step, so a launcher bootstrapped out of order waits for the
step. The steps that boot a VM also refuse while any `maws-vm-*` VM runs, and under the disk reserve. Each step prints
what it did and logs it to `vm-bake.log`; each is safe to run again: nothing is deleted without a verified stop
first, and `--promote` finishes from either name.

Run it from the installed kit, `~/ci-kit-vm/kit/vm/bake.sh`, after refreshing the kit (`install.sh`, before the
maintenance hold: it refuses a maintenance-kind hold or a standing reservation, not a timed hold). An install
already under way holds `vm-lane.lock` while it publishes the kit, so a step started then refuses until it is done.
The candidate is provisioned with the kit the lane will run. In the commands, `owner` is the session's name, as for
a timed hold, and `cand` the candidate's name `--bake` prints.

**When a timed booking passes directly to maintenance, keep the lane held throughout.** Note whether the launcher
was enabled before the window, before running `install.sh --vm --disabled`: that flag disables the launcher as well
as the host instances. Run the install under the booking's timed hold, after its wait has confirmed no guest. Take
the coordinator's maintenance hold and ensure the host instances are down and the launcher booted out (step 1),
then release the booking's timed hold. At maintenance release, restore the launcher's pre-window state explicitly
(step 7), not the disabled state the install left. Releasing the timed hold first would let the launcher boot a
guest for a queued solo job while the host instance was still held. This order was used after cua_repl's 2026-10-23
booking.

1. **The hold.** Keep the launcher's pre-window enabled state for release (record it before any `--disabled`
   install). Write the marker and wait for the guest to go (`hold.sh`, which waits for no reservation and no
   `maws-vm-*` VM running), take the host's instances down as for any hold, and boot the launcher out:

   ```bash
   owner=<session>   # with vm_hold pasted (the VM lane, "Holds have owners")
   vm_hold hold "$owner" maintenance
   #   expect: ci-kit vm hold: held: …/vm-hold.<owner> (maintenance), then ci-kit vm hold: no guest
   # take the host's instances down (Disable and enable, above: every com.ssfskim.ci-kit.mac-runner*), noting which were enabled
   ssh mini 'launchctl bootout gui/$(id -u)/com.ssfskim.ci-kit.vm-lane; launchctl print gui/$(id -u)/com.ssfskim.ci-kit.vm-lane >/dev/null 2>&1 || echo booted out'
   #   expect: booted out
   ```

2. **The reserve.** `--bake` and `--trial` read the free space of the volume of `~/.tart` and refuse
   under `CI_KIT_VM_DISK_RESERVE` GB (40), printing the figure. `--bake` also prints the lowest free space it saw
   between its steps, and stops under the floor (5 GB). The first refresh (2026-10-23) measured an 8 GB bake peak:
   134 GB free before, lowest 126 GB during, 124 GB after registration and the trial. The default stays 40 GB,
   several times the bake peak and a job clone's few GB of writes.

3. **The bake** clones the base to `maws-vm-candidate-<YYYYMMDD>` (UTC; `--name maws-vm-candidate-<id>` for another),
   sets `--cpu 4 --memory <MB> --display 2560x1440pt --disk-size 60`, boots it with the installed kit and the MAWS
   checkout shared read-only (`--maws`, default `~/Developer/GitHub/MAWS`), provisions it through `tart exec` (`mac/vm/provision.sh`'s steps: the base's tools and `python3`; the APFS
   container grown into the 60 GB disk, the recovery container after it removed first, and the result verified;
   Spotlight indexing and the measured background services turned off (`quiet`, below); the display set to
   2560x1440 with scaling on through `displayplacer` and read back, since `tart set --display` does not reach the
   guest's mode; Node 22 and the checkout's pnpm
   through corepack; the project's declaration applied with its install command in a scratch clone; the runner at `install.sh`'s pin in
   `~/actions-runner-maws`, its `.env` naming the hooks through `~/ci-kit` → the kit share, `CI_KIT_MACHINE=mini-vm`,
   `CI_KIT_VM_GUEST=1` and `LANG=en_US.UTF-8`, and its `.path`; the seeded MAWS work repository (`workrepo`, below);
   the compiled helpers in `~/ci-kit-helpers/`), and verifies its stop. `--memory` is the guest's size in MB, 4096 by
   default (V1's size); under 4096 is refused at once, the base image's minimum being 4 GiB.

   **Before baking, bring the mini's shared MAWS checkout to current master.** The declaration, warm store and work
   repository depend on it. The first refresh found it 2168 commits behind; a `gh` login alone does not keep it
   current. The coordinator updates it before the bake and checks its branch and commit against GitHub's master.
   The bake does not fetch the host checkout or check its freshness against GitHub.

   **The project supplies its environment.** The `setup` step makes a scratch clone of the share's committed master
   at `~/maws-setup`. On the guest's Node 22 it applies `.github/ci-kit.yml` in `bake` mode: formulas and casks, the
   declared script, then the declared `install`, warming the pnpm store and Electron cache. The clone is removed on
   success or failure; the declaration's installed tools and home-directory caches stay in the golden. A failed apply
   stops the bake before the runner is installed; it never records the failed declaration's hash. A checkout with
   no `.github/ci-kit.yml`, or a config without a setup declaration, fails the bake: no legacy provision step supplies
   project tools. MAWS's declaration supplies Poppler, LibreOffice and the native engine on macOS, and its install
   fills the caches. ci-kit neither picks an engine version nor requires an engine on the host to bake the guest.

   The bake prints `MAWS environment from its declaration (setup)`, the clone's commit, the applier's summary and
   `provision: setup <hash> applied with install; records in /Users/admin/.ci-kit`. The setup hash is stored in
   `~/.ci-kit/setup-hash`; both `runner` and `env` always read it into the runner's `.env` as
   `CI_KIT_SETUP_HASH=<hash>`. After the whole bake, in a clone, check that `grep CI_KIT_SETUP_HASH
   ~/actions-runner-maws/.env` matches `cat ~/.ci-kit/setup-hash` and MAWS master's declaration hash. The hash is
   computed by `setup/hash.mjs` from the declaration and its script bytes (including `install`, not the lockfile).
   The trial job's setup log must say `ci-kit setup: image matches setup <hash>` and `installed nothing`.
   A job on an older golden instead prints a `::notice::` naming both hashes and installs the missing tools. That
   notice is a coordinator refresh trigger, not an automatic guest rebuild.

   `~/.ci-kit/quarantined-apps` records one app path per line, including apps already installed by the base that
   still carry quarantine. A missing record fails both the bake and `--first-run`; an empty record means no apps need approval. Homebrew's `~/Applications/...` artifact paths are expanded to absolute guest
   paths before inspection and recording. The bake's printed window step lists every app (LibreOffice today).
   A new cask installed at job time is the exception to stale images being transparent: the setup action names its
   quarantined app in a `::warning::`, and tests launching it can fail until this refresh's first-run approval.
   No code clears quarantine or answers a permission dialog.

   **The image quiets the guest's boot, not its macOS desktop.** `provision.sh quiet` runs after `disk` and before
   `display` and the installs, so the bake's own dependency and checkout writes are not indexed either. It runs
   `sudo -n mdutil -a -i off`, then requires `mdutil -a -s` to report `Indexing disabled.` for every volume it lists,
   which must include `/` and `/System/Volumes/Data`. mdutil lists only mounted volumes: a bake candidate reports
   those two, and a booted clone of a golden also `/System/Volumes/Preboot`, so Preboot is checked when listed but
   not required. It disables and boots out exactly these
   services (`com.apple.` before each name), with no pattern search over the jobs loaded at bake time:

   | Domain | Services |
   |---|---|
   | `gui/<guest uid>` | `BiomeAgent`, `assistantd`, `biomesyncd`, `chronod`, `corespotlightd`, `duetexpertd`, `intelligencecontextd`, `jetpackassetd`, `knowledge-agent`, `managedcorespotlightd`, `mediaanalysisd`, `passd`, `photoanalysisd`, `remindd`, `siriinferenced`, `siriknowledged`, `spotlightknowledged`, `suggestd`, `triald` |
   | `system` (through `sudo -n`) | `AssetCacheTetheratorService`, `PerfPowerServices`, `audioanalyticsd` |

   Every label must read disabled in its domain's `launchctl print-disabled` (`disabled` or `true`). A label not
   loaded (`launchctl print` exits 113) is logged and still gets a verified disabled override: this makes the step
   repeatable, covers an idle service and lets a future macOS remove one without breaking the bake. An absent
   service needs no bootout; a failed disable, unreadable state, enabled or missing override, or failed bootout
   while the service remains loaded fails the bake. The persistent overrides and indexing setting carry into the
   clones. A new base that changes the status format or volume layout must be checked, not silently accepted.

   This is the list measured in launch-cost probe 4 (2026-10-23), not a general debloat: nothing of WindowServer,
   TCC, LaunchServices or fseventsd is touched. Against `maws-vm-golden-20261023b` (4 vCPU, 4096 MB), three
   interleaved fresh clones per arm ran MAWS's 19-test document e2e with mean test sums of 154.1 s before and
   107.8 s after (-30%; ranges 145.4–167.5 s and 104.1–110.3 s, all 19/19 green). Warm runs were 99–105 s;
   mean load1 at test start fell from 60.6 to 38.2. The measurement justifies this list alone, not more services.

   **Spotlight queries (`mdfind`) return nothing in a guest with indexing off.** An e2e test that depends on
   `mdfind` detection cannot run on the VM lane. MAWS's current only Spotlight use is ClaudeUsage app detection
   (`src/main/gateway/claude-usage-app.ts`); ClaudeUsage is not installed in the guest, so its answer is unchanged.

   **The image carries a work repository, not just a warm store.** After installing the runner (which replaces its
   directory), `workrepo` clones the share's master into `<runner>/<work folder>/MAWS/MAWS`, normally
   `~/actions-runner-maws/_work/MAWS/MAWS`. It reads `.runner`'s `workFolder` if present; before registration it uses
   the same `_work` setting as the JIT registration. The clone is depth 1, single-branch, without tags, made through git's
   transport (`--no-local`) so it holds its own objects: no hardlinks, alternates, copied host config, credentials,
   dependencies or dirty files. Its origin is `https://github.com/SSFSKIM/MAWS`, exactly the URL checkout v7 expects.
   The `.git` directory, clean tree and valid HEAD let checkout detach, remove old refs, clean and reset without
   deleting the repository, then fetch only the changes since the seed. Full history is unnecessary: a local
   bare-remote experiment transferred 4,740 bytes for the next depth-1 fetch from either shallow or full seeds,
   versus 4,214,714 bytes from empty (the spec's Surprises records the method).

   The step prints the seed commit and its tree-plus-`.git` size. The second refresh on 2026-10-23 seeded MAWS
   master 5a4b93b at 442,992 KiB (about 433 MiB); its trial checkout took 3 s, against 50–221 s in the unseeded
   wave 1 jobs. This is repository payload, not a measurement of the Tart disk's physical growth. Kickoff clears
   `_diag` and links the build cache, not the work repository; neither the wrapper nor the guest hooks clear it. The host sweep and
   janitor terminate processes, not checkout directories, and are not run as guest job hooks. No MAWS share is
   needed by a job clone: the bake alone reads it.

   ```bash
   ssh mini '~/ci-kit-vm/kit/vm/bake.sh --bake --memory 4096'
   #   expect: … baked: maws-vm-candidate-<id>, stopped; the lowest free space during the bake was <n> GB
   ```

   **Then the first-run window step, once, on the candidate,** which `--bake` prints with the candidate's name.
   A prompt answered in the image stays answered in every clone, while one left unanswered comes up on every job's
   fresh desktop (the 10-16 incident, `UserNotificationCenter` in front, per job). The human, or CI-opt through cua
   on the owner's 2026-10-23 ruling, does the window step. The mini's own prompts stay the human's. No script
   answers a prompt.

   1. From the mini's GUI session, run `tart run --no-clipboard --dir=maws:<checkout>:ro <cand>` with its window:
      a one-shot Aqua LaunchAgent works without typing into the mini's Terminal (the second refresh, 2026-10-23).
      The human can also run it in the mini's Terminal over Screen Sharing from the MacBook. Never VNC into the
      guest, which would connect to its address. The guest logs in as admin by itself; its clipboard is not shared.
   2. Open Terminal and every app listed by the bake in the guest (LibreOffice today), either by clicks or through
      `tart exec <cand> open -a Terminal` and `tart exec <cand> open '<app path>'` from the MacBook over ssh to the
      mini. Answer any first-run prompts by clicks in the guest's Tart window, and quit each app from its menu.
      Launching an app through `tart exec` does not answer its prompt. Nothing is typed or pasted into the guest.
   3. From the MacBook run:

      ```bash
      ssh mini '~/ci-kit-vm/kit/vm/bake.sh --first-run <cand>'
      ```

      Answer any prompt the group raises in the guest's window, including Electron's notification prompt as the
      mini's own setting has it (System Settings > Notifications > Electron). On the first refresh no notification
      prompt came up, and neither the guest's nor the mini's preferences had an Electron entry.

   `--first-run` requires the maintenance hold, a running candidate with its guest agent answering, and the MAWS
   share mounted at `/Volumes/My Shared Files/maws`. It reads `~/.ci-kit/quarantined-apps` and refuses while any
   recorded app's quarantine flags lack the user-approved bit (`0x40`), naming that app. An absent quarantine
   attribute or an approved one passes; an unreadable app or flags refuses. The declaration-backed bake must have
   written the record: a missing or unreadable record refuses; an empty record means no app needs approval.
   On 10-23, answering LibreOffice's Gatekeeper "Open" changed `0181` to `01c1`. The group launches `soffice`, so that window step comes first.

   The shell part runs through `tart exec` in the guest's login session. It reads the runner's PATH from
   `~/actions-runner-maws/.path` (the baked Node 22 is keg-only; a fresh Terminal finds Node 24 and no pnpm), makes
   `~/maws-firstrun` as a scratch clone of the share, runs `pnpm install --frozen-lockfile`, then runs
   `NODE_OPTIONS=--max-old-space-size=3072 pnpm e2e:deliverables`, streaming its output. In the 4 GB guest the first
   attempt exited 134 in electron-vite's build; with that heap it passed 12/12. The shell work has a 20 min bound
   (`CI_KIT_VM_FIRST_RUN_WAIT`, seconds). At the start, and on success, failure or expiry, it stops processes whose
   arguments or working directory name the scratch, including detached Electron, and removes the clone. It gives
   them 5 s after TERM, then kills stragglers and verifies they are gone. This scratch belongs only to the first-run
   step in a candidate. A cancelled `tart exec` can kill the cleanup shell; the next run cleans its leftovers first.
   A failure leaves the guest up for inspection and returns non-zero. Fix the cause and rerun `--first-run` until it
   passes. Only then does it shut the guest down itself, with `sudo -n /sbin/shutdown -h now`, and verify the stop:
   under `tart exec`, sudo's PATH has no `/sbin`, so the full path is needed. Run `--trial` only after that pass
   and verified stop; it refuses a candidate still running.

4. **Registration is automatic.** No `--register` step or registration token is needed. The trial and job clone
   each mint a JIT configuration with the host user's existing `gh` login, as described above.

5. **The trial.** Push a scratch MAWS commit whose trailer is `Lane: vm-trial` (`scripts/ci-gate.sh --lane vm-trial`,
   with `MAC_VM_E2E` naming one group, `document-app` the first time); its job asks for `[ci-kit-mac-vm-trial]` alone
   and waits queued. Then `--trial` clones the candidate to `maws-vm-trial-<time>` and boots and kicks it off as the
   launcher boots a job clone, but with its own JIT config and the trial slot's `out/` and cache, so its runner carries
   `ci-kit-mac-vm-trial` alone and no production job can reach it. It prints each `out/` marker, waits for the guest
   to power itself off (no job within 30 min: the idle stop; a job past 50 min: a stop), verifies the stop, deletes
   the clone, keeps its `out/` as `~/ci-kit-vm/trials/<clone>.out`, reads the job's numeric id and conclusion
   through `gh` (the jobs of `out/job`'s run attempt that ran on the trial runner after the trial began), and writes
   the record `~/ci-kit-vm/trials/<cand>`, which binds the candidate, the clone, the run, the job and the conclusion.
   A trial whose clone took no job, or whose job cannot be told, is recorded with no job id and why.

   ```bash
   ssh mini "~/ci-kit-vm/kit/vm/bake.sh --trial $cand; cat ~/ci-kit-vm/trials/$cand"
   #   expect: trial of <cand>: run <run> job <job> success, then candidate=… run=… job=… conclusion=success
   ```

6. **Promote** refuses unless the record names the candidate, a job id and `success`; then renames the candidate to
   `maws-vm-golden-<id>` and replaces the pointer `~/ci-kit-vm/golden` by a rename. Interrupted between the two, the
   pointer still names the old golden, which is valid; run again, it finds the VM under either name and finishes.

   ```bash
   ssh mini "~/ci-kit-vm/kit/vm/bake.sh --promote $cand"
   #   expect: promoted: the pointer names maws-vm-golden-<id> (it named <old>); then the --retire line for <old>
   ```

7. **Release**, in this order: if the launcher was enabled before the window, explicitly enable it and then
   bootstrap it, even if `install.sh --disabled` left it disabled. A launcher disabled before the window stays off.

   ```bash
   # Only if the launcher was enabled before the window:
   ssh mini 'launchctl enable gui/$(id -u)/com.ssfskim.ci-kit.vm-lane && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ssfskim.ci-kit.vm-lane.plist'
   # After that succeeds (or with a previously disabled launcher left off):
   vm_hold release "$owner"
   # Bring back the host's instances that were enabled before their hold.
   ```

   The launcher's start reconciles job clones only and boots from the pointer's VM from then on, naming the golden
   at every boot. The 2026-10-23 second refresh released in this order: enable, bootstrap, hold release, host instance.

8. **Retire** the old golden after the first green production job from the new one (`vm-lane.log` names the golden at
   each boot): `bake.sh --retire <old>`. It needs no hold, and refuses the pointer's VM, a running VM, and anything
   but a golden, a candidate or a trial clone. A retire and a promote take the pointer's own lock
   (`~/ci-kit-vm/golden.lock`), so a retire never deletes the VM a promote is about to point at.

**When a step fails.** Nothing automated meets it, since the launcher is booted out: rerun the same step. A candidate
whose trial failed, or took no job, stays for reading (`~/ci-kit-vm/trials/<clone>.out/`, `vm-bake.log`); `--promote`
refuses it, the pointer and the golden are untouched, and `--retire <cand>` deletes it. A candidate or trial clone
left running by a step that died is ended with the verified stop ([above](#the-vm-lane)) and then retired. A bake that
fails leaves its candidate stopped; retire it before baking again under the same name.

## The dialog watcher

The job hook sees a dialog only when a job starts. On 2026-10-17 securityd crashed, and a SecurityAgent keychain-unlock
dialog covered the mini for 12 minutes; MAWS was holding its runs, so no job started and nobody was told. The watcher,
the LaunchAgent `com.ssfskim.ci-kit.dialog-watch`, reads the frontmost app and the windows on screen at load and every
60 s, whether or not a job runs. When `CI_KIT_DISPLAY` is set, it checks that too. It runs `~/actions-runner-maws/ci-kit/hooks/dialog-watch.sh`, which `install.sh` copies with the hooks, in every
mode (`--disabled` turns off the runner, not the alerts), and removes with `--uninstall`.

A display mismatch or three failed display probe attempts counts as a blocked desktop just like a dialog below.
The stable condition name is `Display`; the source names the observed and expected mode. Changes from one wrong mode
to another are still blocked ticks, not a new pending condition. A display fault takes precedence for attribution while
present. With a matching display, dialogs still block; either condition keeps the shared episode open until both clear.
The drain is unchanged: it holds every instance and stops runners only between jobs, never cancels a job already
running when the display changes.

**One episode per machine, from either side.** The watcher and the job hook share `mac/hooks/dialog.sh`: the dialog
list, the read-only `lsappinfo` and `window-list` reads, the source attribution and the episode, kept in
`~/Library/Logs/ci-kit/dialog-alert.state`. They read and rewrite it under a lock, so one episode is one issue
whichever side sees the dialog first. The state is the machine's own: a machine comments on and closes only the issue
it opened, never another machine's.

- **Opening.** The watcher opens an episode after two consecutive blocked reads, at most 150 s apart. With
  `CI_KIT_DISPLAY` configured, these count machine readiness: any dialog or display fault counts, even if the attribution
  name changes between reads. Without a display setting, both reads must see the same dialog, in front or on screen
  without focus (losing focus while staying on screen does not break the streak). A prompt answered within the minute
  alerts nobody. A refused job opens one at once, since a job was already lost.
- **First seen** is the first read of that pending streak. A refused job adopts that time when it continues the same
  streak before the watcher's second read. The state keeps it, so every later refusal and the title carry the same time.
- **The source** is attributed once, when the episode opens: the same log queries as before, at most three of 10 s
  each. A refusal during the episode reuses it.
- **Closing.** The watcher closes the episode after three consecutive reads with no dialog and a matching display (when configured), about three minutes: it
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
ci-kit alert: ec2: Display since 2026-10-26T05:12Z (display 1920x1080@1x, expected 2560x1440@2x)
```

- `<machine>` is `CI_KIT_MACHINE`, which `install.sh` keeps to `[a-z0-9-]`.
- `<dialog>` is the canonical name from the dialog list, whatever the display language, or `Display`.
- `<YYYY-MM-DDTHH:MMZ>` is the first-seen minute, in UTC.
- ` (<source>)` follows when attribution found one; for `Display` it always names the observed (or unreadable) and expected display.

The kit's other alerts (`ci-kit alert: pool hours on …`, `pool server …`, `bake builder …`, `GCE VM …`) and the
dialog alerts opened before this format never match it. The body adds the time, the dialog and how it holds the
desktop (`Dialog: SecurityAgent holds focus`, or `… is on screen without focus (pid …, layer …, <w>x<h> at <x>,<y>)`),
the frontmost app, the first-seen second, who opened it (the watcher, or a refused job and its run id), the source and
its log line. A dialog on screen without focus is attributed as one in front is: UserNotificationCenter's TCC
requests are read before its own process came to front.

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
- **Releasing.** When the episode closes, no quiet window is in force and the desktop is no longer in use (below),
  the watcher removes the marker, and every wrapper starts its runner within 5 s. A marker left while no episode is
  pending or open and neither other reason holds goes at the next read. The watcher writes and removes the
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

**Quiet windows, daily or on demand.** The operator writes `~/.local/state/ci-quiet`, one UTC window per line:

```text
23:00Z 23:50Z semis-research-coordinator's market-open update (no CI from 23:30Z)
```

The form is `<HH:MM>Z <HH:MM>Z <who, what for>`. The start is included and the end excluded. An end before the start
wraps midnight; equal endpoints are malformed, not an all-day hold. Blank lines and lines starting with `#` are
ignored. For an on-demand operator drain, use dated endpoints in the same file:

```text
2026-10-29T12:00Z 2026-10-29T12:10Z coordinator packaged-app build
```

That form is `<YYYY-MM-DDTHH:MMZ> <YYYY-MM-DDTHH:MMZ> <who, what for>`, with valid calendar dates and an end after the
start. It holds only during that span, not every day. Expired lines remain in the operator-owned file and silently
hold nothing; remove them when convenient. Both forms can coexist and overlap.

Each malformed line holds nothing and is logged once in `mac-runner-hooks.log` (`quiet window: ignored
malformed line`); `quiet-invalid.lines` beside it remembers which were reported. Other valid lines still apply.

The watcher reads the schedule on its usual 60 s tick and uses the same drain, not a second hold: every exclusive and
shared runner waits on `runner-drained`, idle runners stop on two matching reads, and busy runners stop when their
jobs end. A window does not cancel a running job or open an alert issue. Its declaration, including its writer and
purpose, appears on the marker's first line and in `dialog-watch … drain: holding the runners: quiet window …`.
Overlapping windows all appear there. Closing a dialog during a window keeps the hold; ending a window during an
open dialog keeps it too. Removing the declaration releases its reason at the next read.

Put the lead into the window itself: `23:00Z` leaves half an hour for jobs already running to finish before a
`23:30Z` measurement. The drain is polled, not a timer interrupt at the start minute, and a busy job is always left to
finish. Include the watcher's tick and the idle confirmation in that lead. The VM launcher reads the same schedule at
admission and again before spawning, so it boots no guest in a window, independently of the watcher's tick. A guest
already booted is left to finish; a dialog alone still permits the VM fallback as before. The existing VM-only pause
windows and owner holds are unchanged. Local heavy-work launchers use `quiet_read` in the check above, so they do not
have to wait for the drain marker either.

To see it holding, read `~/Library/Logs/ci-kit/runner-drained` and the `drain:` lines in `mac-runner-hooks.log`.
`vm-lane.log` says `no boot: quiet window …`; each runner's `mac-runner[-<n>].out.log` says `runner-hold: …; waiting`
once that runner has stopped. There is no quiet-window alert issue to close.

**Desktop in use.** A remote viewer (`remote=parsec`, `screensharing`, or both) **and** HID input less than 120 s ago
hold the same drain. A viewer who is only watching holds nothing, and input without a viewer holds nothing. The
120 s span bridges the watcher's 60 s ticks and short pauses in a sitting without reserving the desktop for an idle
viewer. The operator can set `CI_KIT_DESKTOP_IDLE_SECONDS` in the watcher's LaunchAgent environment (a positive integer
of up to five digits; invalid values use 120). No separate schedule or state file is needed.

The watcher uses the posture reader's same bounded remote and HID probes (`desktop-posture.sh --activity`). The reason
is `desktop in use (remote=screensharing, input within 120 s)` in `runner-drained` and in
`dialog-watch … drain: holding the runners: …`. Like a quiet window it opens no alert and cancels no running job.
The idle-confirmation and job-end drains still stop only between jobs. At the first tick seeing idle age at least
120 s, or no remote signal, this reason releases; an open dialog or quiet window keeps its own reason. Unknown input
or remote reads do not establish use. Screen Sharing's daemon can linger after disconnection (above); the idle
threshold then releases the hold even while it lingers. The hold is polled, not instantaneous protection for a job
already running or a job starting before the next tick.

HID input does not identify its author: computer-use work can keep this hold up while a viewer watches it. That job
is left to finish, and its end warning explicitly allows its own automation as the source. The **VM lane stays
eligible**: `mac/vm/tart.sh` launches `tart run --no-graphics --no-clipboard`, so the guest has no host window to take
the pointer. Host input does not reach that separate desktop. Quiet windows still block VM boots as above.

**Cheap and bounded.** A read with no dialog, episode or quiet schedule costs two `lsappinfo` calls and one `window-list` run, 5 s
deadline each, plus the remote and HID reads (each supervised at 1 s), and writes nothing. A window list that cannot
be read is logged when that starts and when it ends, not at every read. Every other external call has its own supervised deadline, which kills and reaps it even when it ignores
SIGALRM: 10 s for each `log`, `gh` and `launchctl` call and for the runner-state read. The watcher never clicks,
types, dismisses or focuses anything, and uses no AppleScript and no new permission.

Check by hand:

```bash
ssh mini 'launchctl print gui/$(id -u)/com.ssfskim.ci-kit.dialog-watch | grep -E "state =|runs =|last exit code"'
#   expect: runs = <n>, last exit code = 0 (state = not running between reads)
ssh mini 'cat ~/Library/Logs/ci-kit/dialog-alert.state ~/Library/Logs/ci-kit/runner-drained 2>/dev/null; grep dialog-watch ~/Library/Logs/ci-kit/mac-runner-hooks.log | tail -5'
#   expect, with no dialog, quiet window or desktop use: no output from the state files (phase=closed is an alert close still owed; the log says why)
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
Keychain or notification request). On a host, including the mini, they are answered by the human, in that machine's
GUI session, never by an agent and never through cua. Inside the VM lane's guest, during a refresh's first-run step,
CI-opt may answer the prompts through cua on the owner's ruling of 2026-10-23. Never on the host.

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

A second machine runs a second exclusive runner with the base labels, so MAWS's `[self-hosted, macOS, ARM64]` jobs go
to whichever machine is idle. Do not give it `--home`: only the mini carries `ci-kit-mac-home`, which MAWS's measured,
live and MAC_HOME_E2E e2e groups target (MAC_HOME_E2E: those needing what only the mini runs, such as ClaudeUsage's
relay). An EC2 M1 (`mac2.metal`), `ci-kit-mac-ec2`, ran this way from 2026-10-26 to 10-27, then was released at the
owner's call once hosted Macs took 31 of MAWS's e2e groups. Since 10-28, a `mac-m4.metal` in us-east-2c is back as the
second exclusive Mac: `ci-kit-mac-ec2`, runner id 6951, reached as `ssh ec2-mac`.

Below, `<host>` is the MacBook's `ssh` host for it and `<name>` its short name, a lowercase word of letters, digits and
`-`, not ending in `-<number>` (a shared runner's name does): the runner is `ci-kit-mac-<name>`, and its refusals and
alert say "on the <name>", so pick a word that reads there. EC2 Mac capacity comes and goes within hours; a successful
dedicated-host allocation starts billing at once, for at least 24 h.

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
ssh $host '/opt/homebrew/bin/brew install --cask betterdisplay'
ssh $host 'git clone https://github.com/SSFSKIM/ci-kit ~/Developer/GitHub/ci-kit'
ssh $host '~/Developer/GitHub/ci-kit/mac/install.sh --check'
gh api -X POST repos/SSFSKIM/MAWS/actions/runners/registration-token --jq .token \
  | ssh $host "~/Developer/GitHub/ci-kit/mac/install.sh --disabled --name ci-kit-mac-$name --display 2560x1440@2x"
ssh $host '~/Developer/GitHub/ci-kit/host/install.sh'
printf '%s\n' "$(cat ~/.config/claude-secrets/CI_KIT_ALERT_TOKEN)" \
  | ssh $host 'umask 077; mkdir -p ~/.config/ci-kit && cat >~/.config/ci-kit/alert-token'
ssh $host 'GH_TOKEN=$(cat ~/.config/ci-kit/alert-token) /opt/homebrew/bin/gh issue list -R SSFSKIM/ci-kit-sandbox -L 1 >/dev/null && echo token ok'
```

- `corepack` is its own formula: Homebrew's `node` (26) ships without it, and `--check` requires it. The mini's comes
  from a Node.js package in `/usr/local`.
- BetterDisplay is ci-kit's display prerequisite (step 3). Project tools are installed by the project's
  `.github/ci-kit.yml` and its declared script, not by this host bootstrap. Run the setup action on the host before
  acceptance; approve any apps it reports quarantined through the human's first-run procedure.
- `--disabled` registers the runner and installs the hooks with the agent left off, so no MAWS job lands before step 3;
  step 4 turns it on. It also starts the [dialog watcher](#the-dialog-watcher), so from here a prompt left up for more
  than a minute, step 3's included, opens an alert that names the machine. It closes about three minutes after the
  prompt is answered and the configured display matches.
- The host janitor runs as on the mini ([host.md](host.md)), from the clone that stays.
- The alert token is the owner's to make, once for every rented Mac: a fine-grained personal access token with resource
  owner SSFSKIM, repository access to `SSFSKIM/ci-kit-sandbox` alone, and Issues read and write. The owner stores it on
  the MacBook with `/secret CI_KIT_ALERT_TOKEN`, and the copy goes through stdin, so it is never an argument
  or printed. The last line checks it reads the sandbox's issues. When it expires, the alert fails (the hooks log says
  `dialog alert issue creation failed or timed out`), and the job is still refused.

**2a. On an EC2 Mac, keep the internal SSD's locked volumes unmounted.** It boots from EBS, but the physical Mac's
internal SSD still holds AWS's macOS install. Its FileVault-locked `InternalDisk` and `Data` volumes raise a
SecurityAgent DiskUnlock password prompt at login (about 12 s after auto-login on the mac-m4). Before the owner's VNC
step, derive their UUIDs from this host, not a previous host or an AMI. The physical stores' `Internal` flag excludes
EBS and disk images; only FileVault-locked volumes in those containers get `noauto`.

From the MacBook (`host=ec2-mac`), as `ec2-user` on the host, whose sudo is passwordless:

```bash
internal_noauto=$(ssh -l ec2-user "$host" '/opt/homebrew/bin/python3 -I -' <<'PY'
import plistlib, subprocess

def diskutil(*args):
    return plistlib.loads(subprocess.check_output(["diskutil", *args]))

lines = []
for container in diskutil("apfs", "list", "-plist")["Containers"]:
    locked = [v for v in container["Volumes"] if v["FileVault"] and v["Locked"]]
    stores = container["PhysicalStores"]
    if locked and stores and all(diskutil("info", "-plist", s["DeviceIdentifier"])["Internal"] for s in stores):
        lines.extend("UUID=" + v["APFSVolumeUUID"] + " none apfs rw,noauto" for v in locked)
if not lines:
    raise SystemExit("No internal FileVault-locked volumes found; inspect diskutil apfs list before continuing")
print("\n".join(lines))
PY
) && printf '%s\n' "$internal_noauto"
#   expect: UUID=<this host's InternalDisk UUID> none apfs rw,noauto
#           UUID=<this host's Data UUID> none apfs rw,noauto
ssh "$host" 'diskutil apfs list'
#   expect: those UUIDs are the internal container's FileVault: Yes (Locked) volumes, not the EBS boot volumes
printf '%s\n' "$internal_noauto" | ssh -l ec2-user "$host" '
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    grep -Fqx "$line" /etc/fstab 2>/dev/null || printf "%s\n" "$line" | sudo -n tee -a /etc/fstab >/dev/null || exit 1
  done
  cat /etc/fstab'
#   expect: both derived lines, each once; existing unrelated lines stay
```

This changes mounting policy, not FileVault, and answers no password dialog. A failed derivation means inspect the
volumes before continuing; a sudo password requirement goes to the owner. On an AMI restored onto another physical
host, repeat this step: `/etc/fstab` in the image has the old host's UUIDs, which do not cover the new one's SSD.

Only the EC2 Mac's exclusive runner carries `ci-kit-mac-ec2`; MAWS's
[#322](https://github.com/SSFSKIM/MAWS/pull/322) (in review) targets `[self-hosted, macOS, ARM64, ci-kit-mac-ec2]` for
hosted-eligible groups during hosted-queue peaks. An existing registration keeps its labels, so add this through the
runner API, like `ci-kit-mac-home` above, not by registering again:

```bash
id=$(gh api repos/SSFSKIM/MAWS/actions/runners --jq '.runners[]|select(.name=="ci-kit-mac-ec2").id')
gh api -X POST repos/SSFSKIM/MAWS/actions/runners/$id/labels -f 'labels[]=ci-kit-mac-ec2' --jq '[.labels[].name]|join(",")'
#   expect: self-hosted,macOS,ARM64,ci-kit-mac,ci-kit-mac-ec2
```

**3. The owner, once, in the machine's GUI (VNC).**

- Open LibreOffice, Google Chrome and Terminal once each, and allow their first-launch prompts.
- In BetterDisplay, make a 2560x1440 HiDPI virtual display the main display, and turn on its launch at login so the
  display comes back after a restart. The mini's posture line reads `display=2560x1440@2x`, and some MAWS specs read
  `devicePixelRatio`; a smaller desktop clamps the 1280x820 e2e window. Step 2 saves this expectation with `--display`;
  every refresh keeps it, and the hooks and watcher refuse/hold the machine if a reboot or VNC leaves another mode.
  To enroll the existing mini, refresh it with `--home --display 2560x1440@2x` while it is idle.
- System Settings → Privacy & Security → Full Disk Access: the + button, Cmd+Shift+G, `/bin/bash`.

Then, from the MacBook:

```bash
ssh $host 'for app in LibreOffice "Google Chrome"; do xattr -p com.apple.quarantine "/Applications/$app.app"; done'
#   01c1;… (approved) or "No such xattr" for each; 0181;… is not yet approved
ssh $host '~/actions-runner-maws/ci-kit/hooks/cursor-park --describe'
#   expect: 2560x1440@2x
ssh $host '~/actions-runner-maws/ci-kit/hooks/window-list | cut -f1-3,8,9'
#   expect: one line per window on screen (pid, layer, alpha, bundle id, owner), none of SecurityAgent,
#   UserNotificationCenter, CoreServicesUIAgent or loginwindow while no dialog is up
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

**3a. Reboot before enabling the runner, then save the EC2 image.** With the runner still disabled, reboot once
(the owner on a non-EC2 Mac). After SSH returns and auto-login and BetterDisplay have finished, check the desktop
again; include the first minute after login so a delayed DiskUnlock prompt is not missed:

```bash
ssh -l ec2-user "$host" 'sudo -n reboot'   # EC2 only; SSH disconnects
#   after the machine returns:
ssh "$host" '~/actions-runner-maws/ci-kit/hooks/cursor-park --describe'
#   expect: 2560x1440@2x
ssh "$host" '~/actions-runner-maws/ci-kit/hooks/window-list | cut -f8 | grep -c SecurityAgent'
#   expect: 0 (grep exits 1 for no matches); repeat after the first minute of the GUI session
ssh "$host" '/usr/bin/log show --last 10m --predicate '\''process == "authd"'\'' | grep DiskUnlock'
#   expect: no DiskUnlock prompt since this boot
```

A SecurityAgent window goes to the owner in VNC, never an agent. Before releasing a configured EC2 Mac, save an AMI
with `ci-kit=mac-ec2`; releasing the first one without an image cost the full setup and the owner's first-run session
again on 10-28. Save after the reboot check, with the runner still disabled (image creation may reboot it again for a
consistent snapshot):

```bash
instance='<instance-id>'   # this EC2 Mac, not its dedicated host id
ami=$(aws --profile ci-kit-ops --region us-east-2 ec2 create-image --instance-id "$instance" \
  --name "ci-kit-mac-ec2-$(date -u +%Y%m%dT%H%M%SZ)" \
  --tag-specifications 'ResourceType=image,Tags=[{Key=ci-kit,Value=mac-ec2}]' --query ImageId --output text)
aws --profile ci-kit-ops --region us-east-2 ec2 wait image-available --image-ids "$ami"
aws --profile ci-kit-ops --region us-east-2 ec2 describe-images --image-ids "$ami" \
  --query 'Images[].{Image:ImageId,State:State,Tags:Tags}'
#   expect: the saved ami-…, State available, tag ci-kit=mac-ec2
```

The mac-m4's saved image on 2026-10-28 is `ami-00350dccb0d943b11` in us-east-2. A restore still needs step 2a for the
new host's internal SSD and this reboot check; the saved UUIDs are not portable.

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
