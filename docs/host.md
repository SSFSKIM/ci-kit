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

It gets SIGTERM, then SIGKILL if it is still running 10 s later, unchanged. Each kill is a line in
`~/Library/Logs/ci-kit/janitor.log`, and a macOS notification says how many were killed.

**Why that rule.** A one-shot test process that `launchd` has adopted, two hours on, has outlived the session that
started it, whatever that session's state is. Parentage and age alone cannot tell a stray from a watcher someone
detached on purpose, so a kill needs a command line that is positively a one-shot test. Everything else is
reported, never killed.

### The patterns

Each pattern is a JavaScript regex over the whole command line, as `ps -o command` prints it. Most patterns are
anchored on the executable (`^\S*\bnode\s`), because the words they look for also appear in the arguments of
processes that must never be killed: a `claude` session resumed with a prompt that mentions `vitest`, a `zsh -c`
wrapper whose script runs `node --test`.

| Pattern targets | Example command line |
|---|---|
| the `node --test` runner | `node --test test/` |
| a test file run by node, as the runner's children are | `node /x/test/eof-drain.test.mjs` |
| `vitest` | `node /x/node_modules/vitest/vitest.mjs run` |
| the Playwright test runner (not `@playwright/cli` or MCP) | `node /x/node_modules/.bin/playwright test` |
| Electron with a worktree path (`.claude/worktrees/`, `.worktrees/`, `<repo>-wt-<x>`) | `…/Electron.app/Contents/MacOS/Electron /x/MAWS-wt-95/out/main/index.js` |
| cua's `fake-upstream-process.mjs` fixture | `node /x/test/fixtures/fake-upstream-process.mjs` |
| sminos test stand-ins: scripts under `tests/sminos/` or a test's `/tmp/sm?.XXXXXX/` | `Python /tmp/smc.Ab3dE9/ctl.py supervisor …` |
| codex-companion test workspaces | `node /var/…/T/codex-plugin-test-Qx81/codex app-server` |

### The exclusions

An exclusion is checked after the patterns and always wins. A process that matches a pattern and an exclusion is
listed in the report under "Left running" and is not touched.

- watch, UI and server modes, as separate arguments: `--watch`, `-w`, `--ui`, `serve`, `dev`, `preview`;
- `vitest` without a `run` or `--run` argument, since bare `vitest` watches. This also spares vitest's worker
  processes, whose command lines do not say how their parent was started.

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

One `ps` call for the whole machine. For each repo under `repos_root` that has linked worktrees (checked on disk,
no git call otherwise): three git calls, plus a `git status` for each worktree whose branch is merged. All git
calls use `--no-optional-locks`, so the janitor never rewrites an index an agent is using. One `tart list` where
tart is installed. About 2 s of wall time and half a second of CPU on the MacBook at load 180.

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
