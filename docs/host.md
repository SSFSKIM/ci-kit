# The host janitor

`host/janitor.mjs` keeps a Mac that runs many agent sessions from filling up with test processes nobody is
waiting for. It runs every 30 minutes as the LaunchAgent `com.ssfskim.ci-kit.janitor`, on the MacBook and on the
mini. It kills one class of process, and it reports everything else it finds without deleting anything.

## What it kills

A process is killed only when all of these hold:

- it belongs to the user the janitor runs as (never root's, never another user's);
- its parent is `launchd` (pid 1): whatever started it is gone;
- it has run for more than `min_age_hours` (2);
- its command line matches one of `patterns` in `host/janitor.json`, and none of `exclude`.

It gets SIGTERM, then SIGKILL if it still runs 10 s later as the same process (see Signals). Each kill is a line in
`~/Library/Logs/ci-kit/janitor.log`, and a macOS notification says how many were killed.

**Why that rule.** A one-shot test process that `launchd` has adopted, two hours on, has outlived the session that
started it, whatever that session's state is. Parentage and age alone cannot tell a stray from a watcher someone
detached on purpose, so a kill needs a command line that is positively a one-shot test. Everything else is
reported, never killed.

### The patterns

Each pattern is a JavaScript regex over the whole command line, as `ps -o command` prints it, and must be a
non-empty string. The patterns match what a process *runs*, not what its arguments mention. A pattern names the
interpreter (`node`, Python), lets only that interpreter's own options (`-x`, `--x=y`) come before the script, and
then requires a test entrypoint as the script, or the runner's own flag in the runner's position. So
`node …/claude-code/cli.js --resume "… vitest run …"`, `node daemon.mjs --test-mode` and
`node daemon.mjs --config heartbeat.test.mjs` never qualify. An interpreter option that takes a separate value
(`node --import tsx --test`) also stops a match; such a process is not killed.

| Pattern targets | Example command line |
|---|---|
| the `node --test` runner (exactly `--test`, among node's options) | `node --test test/` |
| a test file as the script, as the runner's children are | `node /x/test/eof-drain.test.mjs` |
| vitest's entrypoint (`vitest/vitest.mjs`, `.bin/vitest`) | `node /x/node_modules/vitest/vitest.mjs run` |
| the Playwright test runner's entrypoint, then `test` (not `@playwright/cli` or MCP) | `node /x/node_modules/.bin/playwright test` |
| Electron as Playwright's `_electron.launch` starts it (its loader, then `--inspect=0 --remote-debugging-port=0`) | `…/Electron -r …/playwright-core/lib/server/electron/loader.js --inspect=0 --remote-debugging-port=0 …` |
| Electron with a worktree path (`.claude/worktrees/`, `.worktrees/`, `<repo>-wt-<x>`): reported only, see below | `…/Electron /x/MAWS-wt-95/out/main/index.js` |
| cua's `fake-upstream-process.mjs` fixture as the script | `node /x/test/fixtures/fake-upstream-process.mjs` |
| sminos test stand-ins: a script under `tests/sminos/` or in a test's `/tmp/sm?.XXXXXX/` | `Python /tmp/smc.Ab3dE9/ctl.py supervisor …` |
| codex-companion: a script inside a `codex-plugin-test-*` workspace, or a task worker serving one | `node /var/…/T/codex-plugin-test-Qx81/codex app-server` |

### The exclusions

An exclusion is checked after the patterns and always wins. A process that matches a pattern and an exclusion is
listed in the report under "Left running" and is not touched.

- watch, UI and server modes, as separate arguments: `--watch`, `-w`, `--ui`, `serve`, `dev`, `preview`. This
  also spares a codex-companion broker serving a test workspace (`app-server-broker.mjs serve`);
- vitest's entrypoint without a `run` subcommand or a `--run` flag, since bare `vitest` watches;
- Electron without Playwright's launch flags. A developer may leave an app from a worktree open on purpose, so
  only a test launch is killed; the rest is reported.

### Signals

Each process is chosen with its birth identity: its uid and start time (`ps -o lstart`, under the C locale).
Immediately before SIGTERM, and again before SIGKILL, a fresh `ps -p` of the chosen pids checks that each pid
still holds that identity. A pid that a new process took meanwhile, even one with the same command line, gets
nothing. This is M6's `mac/hooks/terminate.mjs`, which the janitor calls.

## What it reports

Every run rewrites `~/Library/Logs/ci-kit/report.md`:

- the processes it killed (or would kill, in dry-run mode) and the ones it left running;
- linked worktrees of the repos under `repos_root` (`~/Developer/GitHub`) whose branch is merged into the repo's
  default branch (`origin/HEAD`, else a local `main` or `master`) and whose tree is clean, with the date of the
  branch tip, plus registered worktrees whose directory is gone;
- VMs from `tart list` that have run for more than `vm_report_hours` (12), aged by their `tart run` process;
- the top memory users, grouped by app bundle or executable.

It deletes nothing it lists. Removing a worktree or stopping a VM is a person's call, or a session's.

Limits of the worktree list:

- A worktree created moments ago is "merged" until its first commit; its tip date gives it away.
- A branch landed by squash or rebase is not merged in git's sense and is not listed.
- Detached and locked worktrees are never listed.

## Cost per run

One `ps` call for the whole machine; when it kills, a `ps -p` of just those pids every half second of the grace. For each repo under `repos_root` that has linked worktrees (checked on disk,
no git call otherwise): three git calls, plus a `git status` for each worktree whose branch is merged. All git
calls use `--no-optional-locks`, so the janitor never rewrites an index an agent is using. One `tart list` where
tart is installed. Run by hand on the MacBook at load 180, that is about 2 s of wall time and 0.7 s of CPU.
The agent runs at background priority (`ProcessType` `Background`), which macOS throttles hard on a loaded
machine: its first run on the MacBook took about 3 minutes, almost all of it waiting. Kills come first in a run,
so the throttling delays the report, not the kills.

## Install, modes and removal

```bash
~/Developer/GitHub/ci-kit/host/install.sh --dry-run    # logs would-kill lines, kills nothing
~/Developer/GitHub/ci-kit/host/install.sh              # live
~/Developer/GitHub/ci-kit/host/install.sh --uninstall
ssh mini '~/Developer/GitHub/ci-kit/host/install.sh'   # the same on the mini
```

The agent runs the janitor from the checkout `install.sh` sits in, so install from the clone that stays on `main`.
`install.sh` pins the `node` it finds on `PATH` by absolute path: re-run it after removing that Node version.
Switching modes is a re-run.

The agent reads `host/janitor.json` on every run, so a pattern change takes effect at the next run without a
reinstall. Check a change first:

```bash
node host/janitor.mjs --dry-run                       # would-kill lines: pid, age, pattern, command
node host/janitor.mjs --dry-run --config /tmp/j.json  # against another config
tail ~/Library/Logs/ci-kit/janitor.log
```

`janitor.err` in the same directory holds the agent's crashes, and config errors (exit 2) name the key and entry.

## Owner action outside the kit: update cmux

cmux 0.64.19 burns about one core in six `libghostty` threads, which is fixed upstream from 0.64.23 (0.65.1 is the
latest as of 2026-10-15). Update it and restart at a quiet time: a restart ends the sessions running in cmux
terminals. Its sidebar git watcher was switched off on 2026-10-15; to turn it back on:
`defaults delete com.cmuxterm.app sidebarWatchGitStatus`.
