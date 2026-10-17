---
name: adopt
description: Use when asked to set up CI for a repo, add CI checks or GitHub Actions gates to it, or adopt ci-kit in a repo that has no .github/ci-kit.yml.
---

# Adopting ci-kit

ci-kit runs the owner's (SSFSKIM's) gates on GitHub Actions instead of on this machine, which carries many sessions
at high load. A repo adopts it with two files; after that every PR gets a `ci / <gate>` check per gate plus
`ci / verdict`, and any session verifies a commit with `ci-gate`. The config schema, the lanes and how gates are
selected are in `${CLAUDE_PLUGIN_ROOT}/docs/adopting.md`: read it before you edit the config.

## The path

1. **Draft.** Run `${CLAUDE_PLUGIN_ROOT}/bin/ci-gate init` in the repo. Use that path: an older `ci-gate` may come
   first on PATH and lack `init`. It writes `.github/workflows/ci.yml`, ci-kit's caller, and a draft
   `.github/ci-kit.yml` with a gate per command the repo declares, already accepted by the planner. Keep the caller
   verbatim: its workflow name and job id make the checks read `ci / <gate>`, and `ci-gate` finds its runs by that path.
2. **Judge the draft.** It knows only what the manifests declare. Which checks belong in CI and how they split into
   gates is yours to decide from the repo's own test setup: leave out what needs this machine (credentials only it
   has, a GUI, model calls, local state) and add what the manifests don't show. `paths` only saves minutes, and a
   wrong pattern leaves a change untested.
3. **Prove it.** Commit, then run `ci-gate` in the worktree. GREEN is the proof. RED leaves each failed gate's log on
   disk; ERROR names a config problem by gate and field. Iterate through `ci-gate`, not by running the suites here.
4. **Open the PR** with both files.

## Lanes

- `hosted` (ubuntu) suits any repo. `hosted-macos` is free on a public repo and billed at 10x on a private one.
- `pool` and `mac` are for private repos only, and the planner refuses them on a public one: a stranger's fork PR
  must never reach a self-hosted machine.
  - `pool` (a GCE spot VM per job, `cpus: 2|4|8|16`) needs the repo listed in ci-kit's `pool/config/gce.json`
    (`{"repo": "SSFSKIM/<name>"}`, a PR in SSFSKIM/ci-kit that is yours to open) and the `ci-kit-runners` GitHub App
    installed on the repo, which only the owner can do.
  - `mac` is the Mac mini's runner, which only the owner can register for a repo.

  A gate that would be better on one of these starts on `hosted`; your report names the owner's steps that would
  move it.

## When a gate is red

- **Timing tests.** CI runners are loaded too, so a test that asserts how fast something happened fails there. The
  kit's rule: assert that the event happened, never how fast. Wait on the condition (poll it, or await the event)
  under a generous, uniform ceiling of 10–30 s that is a liveness bound, not a speed claim; logic that depends on a
  time budget gets a controlled clock in its test. Fix a timing test that way rather than raising its timeout or
  skipping it.
- **Tests that read git history** (log, blame, tags) fail at the default depth of one commit: set
  `setup.fetch_depth: 0`.

Making checks required, branch protection and merge rules are the owner's: ci-kit adds checks and never makes them
required.
