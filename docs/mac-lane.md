# The mac lane

The Mac mini runs one GitHub Actions runner for `SSFSKIM/MAWS`, so MAWS's macOS-bound gates (its Electron e2e above
all) run there instead of on the MacBook. The design is §4 of the
[spec](doperpowers/specs/2026-10-15-ci-kit-design.md); the contract is I10.

| | |
|---|---|
| Machine | the mini (`ssh mini`, user `new`), in `new`'s logged-in GUI session |
| Runner | `ci-kit-mac-mini`, registered to `SSFSKIM/MAWS` at repository level, non-ephemeral |
| Labels | `self-hosted`, `macOS`, `ARM64` (what MAWS's `gate.yml` targets), `ci-kit-mac` |
| Directory | `~/actions-runner-maws` (work directory `~/actions-runner-maws/_work`) |
| LaunchAgent | `com.ssfskim.ci-kit.mac-runner` — RunAtLoad, KeepAlive, `ProcessType` Interactive, Aqua session only |
| Hooks | `~/actions-runner-maws/ci-kit/hooks/job-started.sh` (the desktop check, then the sweep), `job-completed.sh` (copied from `mac/hooks/`) |
| Logs | `~/Library/Logs/ci-kit/mac-runner-hooks.log` (the hooks), `mac-runner.out.log` / `.err.log` (the runner), `~/actions-runner-maws/_diag/` |

**Why a LaunchAgent.** Electron windows need a WindowServer, which only the user's GUI session has; a LaunchDaemon runs
outside it. **Why one runner.** Concurrency is one: e2e groups contend for the desktop (focus, pointer, clipboard).
The mini's other runner (`actions-runner-ida-solution`, another repository's) is independent and untouched.

**Never other repositories' code.** The runner is registered to MAWS alone, and the kit's planner refuses the `mac` lane
on a public repository, so no stranger's fork can reach the mini.

## Which jobs it takes

MAWS's `gate.yml` decides, from its repository variables and the pushed commit's trailers:

- `GATE_RUNNER=macos` sends every job there (plan, static, unit, probes, e2e).
- `GATE_E2E_RUNNER=macos`, a `Runner: macos` trailer (`scripts/ci-gate.sh --runner macos`) or a dispatch with
  `runner=macos` sends the e2e jobs there.
- With neither variable set (the state on 2026-10-15), only runs that ask for `macos` reach the mini; every other job
  stays on `ubuntu-24.04`.

Setting those variables is maws-fe's call (proposal P4), not the kit's.

## Install, update, remove

Everything runs from the MacBook. `mac/install.sh` runs on the mini from a checkout of the kit there; it copies what
the runner needs into `~/actions-runner-maws`, so the checkout can move on afterwards.

```bash
ssh mini 'git -C ~/Developer/GitHub/ci-kit pull --ff-only || git clone https://github.com/SSFSKIM/ci-kit ~/Developer/GitHub/ci-kit'
ssh mini '~/Developer/GitHub/ci-kit/mac/install.sh --check'      # prerequisites only; a gap is reported, never installed
gh api -X POST repos/SSFSKIM/MAWS/actions/runners/registration-token --jq .token \
  | ssh mini '~/Developer/GitHub/ci-kit/mac/install.sh'
#   expect: ci-kit mac: running: ci-kit-mac-mini listens for jobs of https://github.com/SSFSKIM/MAWS
gh api repos/SSFSKIM/MAWS/actions/runners --jq '.runners[]|[.name,.status,.busy]|@tsv'
#   expect: ci-kit-mac-mini  online  false
```

- **The token** is read from stdin only while the runner is unregistered, and handed to the runner's `config.sh`
  through its environment (`ACTIONS_RUNNER_INPUT_TOKEN`), so it never lands in a file, an argument list or `ps`. It
  expires after an hour.
- **Re-running** (no token needed) refreshes the hooks, the runner's `.env` and `.path`, and the LaunchAgent, and
  reloads it. It refuses while a job runs, because reloading the agent kills the job.
- **Prerequisites** checked on the PATH jobs get: Node ≥ 22.12 (MAWS's `engines`), corepack, the Xcode command line
  tools' `clang` (native modules such as `node-pty`), `python3` (node-gyp), git, and LibreOffice's `soffice` (the
  document groups), found but not launched. MAWS's setup action installs its own Node 22 and pnpm per job into the
  runner's tool cache; the system Node runs MAWS's plan job when it lands here (`GATE_RUNNER=macos`) and the hooks. A
  Homebrew install that asks no password closes a gap; anything that needs one goes to the human.
- **The runner version** is pinned with its checksum in `install.sh` for the first install; after that the runner
  updates itself, as GitHub requires.
- **Environment.** `.env` sets `LANG=en_US.UTF-8` (the mini's locale is Korean, and jobs parse tool output) and the two
  hook variables. `.path` is Homebrew's tools, then the system's.

Disable and enable (the runner stays registered; GitHub shows it offline, and removes a self-hosted runner after 14
days offline):

```bash
ssh mini 'launchctl bootout gui/$(id -u)/com.ssfskim.ci-kit.mac-runner; launchctl disable gui/$(id -u)/com.ssfskim.ci-kit.mac-runner'
ssh mini 'launchctl enable gui/$(id -u)/com.ssfskim.ci-kit.mac-runner; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ssfskim.ci-kit.mac-runner.plist'
```

`install.sh --disabled` installs or refreshes with the agent left disabled.

Remove:

```bash
ssh mini 'launchctl bootout gui/$(id -u)/com.ssfskim.ci-kit.mac-runner; rm ~/Library/LaunchAgents/com.ssfskim.ci-kit.mac-runner.plist'
gh api -X POST repos/SSFSKIM/MAWS/actions/runners/remove-token --jq .token \
  | ssh mini 'read -r t; cd ~/actions-runner-maws && ACTIONS_RUNNER_INPUT_TOKEN=$t ./config.sh remove'
ssh mini 'rm -rf ~/actions-runner-maws'
```

## The job hooks

**A system dialog in front fails the job at once.** Before anything else, the job-started hook
(`mac/hooks/desktop-check.sh`) reads the frontmost app with `lsappinfo`. If it is `UserNotificationCenter`,
`CoreServicesUIAgent`, `SecurityAgent` or `loginwindow`, a system dialog or the login screen holds key focus, and every
e2e group would fail on focus and pasteboard (2026-10-16: seven groups red with `UserNotificationCenter` frontmost). The
job then fails at "Set up runner" with:

```
ci-kit: a system dialog (<name>) holds focus on the mini — dismiss it there and rerun
```

Dismissing it is the human's, in the mini's GUI session (never an agent, never cua). The check uses `lsappinfo` alone:
AppleScript or System Events would raise TCC prompts. When `lsappinfo` fails or prints nothing, the job is not blocked;
the miss is logged. Every check logs a `desktop-check` line (the frontmost app) to the job's log and the hooks log.

**Every job starts with Terminal in front.** Some of MAWS's paste and to-human results depend on the app in front, and
what is in front depended on what came before: Finder when an e2e app quits, or Chrome after a test leaked an open-URL
into the owner's browser (2026-10-16). So whenever any app other than Terminal is in front (after the dialog check),
the hook runs `open -a Terminal`, which goes through LaunchServices (no Apple Events, no Automation consent), and
re-reads the frontmost app for up to about 5 s. The job log gets `frontmost before=<app> after=Terminal`. If Terminal is
not in front by then, the job fails at "Set up runner":

```
ci-kit: Terminal did not come to the front on the mini (<name> is) — check its desktop and rerun
```

Terminal is told by its bundle id, `com.apple.Terminal`: `lsappinfo`'s names are localized, and the mini shows
Terminal as `터미널`. System dialogs are never touched, and an unreadable frontmost app still lets the job run. The hook
acts only before the job, so it never fights MAWS's own `MAWS_E2E_FOREGROUND=1`, and it does take the front from
whoever is using the mini's desktop when a job starts.

**Desktop posture is visible in the job log.** After start's Terminal/cursor work, and at job completion before
cleanup can hide a leaked app, `desktop-posture.sh` prints one line to stdout and the hooks log:

```text
ci-kit desktop (start): frontmost=Terminal display=2560x1440@2x remote=parsec
ci-kit desktop (end): frontmost=Google Chrome display=2560x1440@1x remote=none
```

- `frontmost`: the same localized `lsappinfo` name the desktop check reads, through its read-only `--frontmost` mode.
- `display`: the main display's size in points and backing-framebuffer scale. `cursor-park --describe` reads
  `CGDisplayBounds` and the current mode's pixel/point width ratio; it does not move the cursor. A missing, failing or
  timed-out helper gives `unknown`, so a HiDPI-to-1x switch is visible without running `system_profiler`.
- `remote`: `parsec`, `screensharing`, both comma-separated, or `none` when neither signal is present. Parsec uses the
  newest `user#id connected.` / `disconnected.` event in `~/.parsec/log.txt`; an absent log means no Parsec signal,
  while an unreadable log or one with no connection history is unknown. Screen Sharing uses non-root `netstat -an`:
  incoming TCP **local** port 5900 in `ESTABLISHED`, or UDP local ports 5900–5902 with a concrete foreign peer (not a
  wildcard listener), including loopback tunnels. UDP covers [High Performance Screen Sharing's ports](https://support.apple.com/guide/remote-desktop/use-high-performance-screen-sharing-apdf8e09f5a9/mac).
  Failed, timed-out or unrecognized reads give `unknown` unless another signal already establishes a remote connection.

Screen Sharing is a **transport signal, not authentication proof**: TCP can be established at the login prompt
([ScreenSharingMonitor documents this](https://github.com/mm2270/ScreenSharingMonitor)); a peered UDP socket does not
prove viewer liveness. `none` means no observed default-port transport, not coverage of remapped ports, Apple-ID relay
paths or other remote-control products. The MacBook's macOS 26 socket layout and absent-session case were checked
read-only; active TCP/UDP cases are covered by fixtures, not a live sharing session.

Each of the three posture probes has a 1 s Perl-supervisor deadline, which kills and reaps a hanging probe even if
it ignores SIGALRM. They only read state: no GUI actions, AppleScript, new permissions or remote-session changes.
Posture and hooks-log failures never affect the sweep's or the job's outcome.

Before each job and after it, the hooks kill every process of the runner's user that a job left behind:

- a process that **runs from** the work directory: a path under `~/actions-runner-maws/_work/` in its command line
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
someone removes the survivor, every job on the mini fails at "Set up runner" with that line, which is the point.

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

## Running a MAWS gate on it

From any MAWS checkout (MAWS's own script; it pushes a temporary `ci/` ref and deletes it):

```bash
scripts/ci-gate.sh <sha> --runner macos --gates e2e:composer
gh api repos/SSFSKIM/MAWS/actions/runs/<run-id>/jobs --jq '.jobs[]|select(.conclusion!="skipped")|[.name,.runner_name]|@tsv'
#   expect: plan  GitHub Actions <n>   (the plan job stays on ubuntu-24.04 unless GATE_RUNNER=macos)
#           e2e:composer  ci-kit-mac-mini
```

(`gh run view --json jobs` has no runner name; the jobs API's `runner_name` does.)

**Human-only prompts.** A first launch of a GUI app can raise a macOS prompt (Gatekeeper for a downloaded app, a
Keychain or notification request). They are answered by the human, in the mini's GUI session, never by an agent and
never through cua.

**Readiness hold: LibreOffice.** `/Applications/LibreOffice.app` (Homebrew cask) is installed but quarantined and has
never been launched on the mini, so its first launch raises Gatekeeper's "downloaded from the Internet" prompt. Until
the human has opened LibreOffice once on the mini and allowed it, no group that launches `soffice` runs there: in
MAWS's `gate.yml` those are `LIBREOFFICE_E2E`, `document` and `presentations`. The flag shows the approval:

```bash
ssh mini 'xattr -p com.apple.quarantine /Applications/LibreOffice.app'
#   0181;…  not yet approved (hold)
#   01c1;…  approved (0x40, user approved, is set): the hold is lifted
```

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
