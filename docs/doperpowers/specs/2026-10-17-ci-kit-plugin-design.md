# ci-kit as a Claude Code plugin — living spec

**Date.** 2026-10-17. **Status.** Approved by the owner (2026-10-17): build it as a plugin of its own, separate from
doperpowers, listed in the doperpowers marketplace. Author: CI-opt. Parent: `2026-10-15-ci-kit-design.md` (the kit).

## Purpose

ci-kit moves a repo's gates off the MacBook (the parent spec). Today a repo adopts it by hand: an agent writes two files
from `docs/adopting.md`, and that repo's agents learn to use `ci-gate` only if someone adds a line to its CLAUDE.md.
After this work:

- **An adopted repo is used without anyone editing its CLAUDE.md.** A session that opens in a worktree whose repo has
  `.github/ci-kit.yml` is told, once, to verify commits with `ci-gate`, not by running the gates on the Mac.
- **Any repo can be adopted by asking.** "Set up CI for this repo" in a session with the plugin makes the agent draft the
  config with `ci-gate init`, judge it, prove it with a GREEN `ci-gate` run and open the PR. For a private repo it also
  names the steps only the owner can take.
- **`ci-gate` works wherever the plugin is installed**, with no `install.sh` step.

### What it must not be

- **Not a change to doperpowers' plugin or agent rules.** The only doperpowers change is one entry in
  `.claude-plugin/marketplace.json`, appended after the doperpowers entry: `scripts/bump-version.sh` writes
  `plugins.0.version`, so index 0 stays doperpowers.
- **Silent outside adopted repos.** The hook prints nothing in a repo without `.github/ci-kit.yml`, never fails a session,
  and stays well under a second. It never runs network calls.
- **No self-hosted lane for a public repo.** `ci-gate init` and the skill never put `pool` or `mac` on a public repo; the
  planner already refuses it, and init must not write a config the planner refuses.
- **No owner-only step taken on the owner's behalf.** For a private repo: the `pool/config/gce.json` PR in ci-kit is the
  agent's to open; installing the GitHub App on the repo and registering a mini runner for a `mac` lane are the owner's.
  The skill names them; it does not attempt them.
- **No merge rules, branch protection or required checks.** Checks are added, never made required.

## Acceptance

- **P1.** With the plugin installed from the doperpowers marketplace on this Mac, a new session in a cua worktree gets the
  ci-gate context; a new session in a repo without `.github/ci-kit.yml` gets nothing from the plugin.
- **P2.** In a clean checkout with no ci-kit files, `ci-gate init` writes `.github/workflows/ci.yml` (the verbatim file
  from `docs/adopting.md`) and a `.github/ci-kit.yml` drafted from the repo's own commands, validated by the kit's own
  config parser, and refuses to overwrite either file without `--force`. Fixture tests cover at least a Node repo, a
  Python repo and a repo with no detectable commands (a draft the agent must complete, said plainly).
- **P3.** A live adoption: on a branch of `SSFSKIM/ci-kit-sandbox` with its ci-kit files removed, `ci-gate init`
  regenerates a config whose `ci-gate` run is GREEN on the hosted lane.
- **P4.** Behaviour, run headless several times each (the eval): asked "set up CI for this repo" in a scratch repo, the
  agent uses the skill and reaches a GREEN `ci-gate` or stops at a named owner step; asked "verify this commit" in an
  adopted repo, it runs `ci-gate` and does not run the gates locally. Record the runs and their outcomes.
- **P5.** `npm test` passes, and an independent review (`doperpowers:reviewer-medium`) finds nothing material left.

## Design

### Layout (all in the ci-kit repo; the plugin source is the repo root)

| Path | What |
|---|---|
| `.claude-plugin/plugin.json` | name `ci-kit`, a version, description; the hook and skill are discovered from the paths below |
| `hooks/hooks.json`, `hooks/session-start.sh` | the SessionStart hook |
| `skills/adopt/SKILL.md` | the adoption skill (`ci-kit:adopt`) |
| `cli/init.mjs` (+ `ci-gate init` in `cli/args.mjs`) | the scaffold |
| `bin/ci-gate` | unchanged entry point; it has no npm dependencies, so it runs from the plugin cache as is |

The root `hooks/` and `skills/` directories are new; the runner hooks stay under `mac/hooks/`. Read the Claude Code
plugin documentation (or the engine) for how a plugin's hooks and skills are declared and for whether a plugin's `bin/`
reaches the Bash tool's PATH; where it does not, the hook names `ci-gate` by `${CLAUDE_PLUGIN_ROOT}/bin/ci-gate`.

### The hook

At SessionStart, if the working directory is inside a git worktree whose top level has `.github/ci-kit.yml`, it emits
additional context of a few lines: verify a commit with `ci-gate` (and how to reach it), what its output means (one line
per gate, a final GREEN or RED, failed logs on disk), and that the gates are not to be run on this Mac. Nothing else:
which gates exist is in the config, which the agent can read. Otherwise it prints nothing. Mirror the payload shape of
doperpowers' `hooks/kairos.sh`, which injects context at SessionStart and after compaction.

### `ci-gate init`

- Writes the verbatim `ci.yml` and a draft `ci-kit.yml`. Detects commands from what the repo declares: `package.json`
  scripts (test, lint, typecheck, build) with the package manager its lockfile implies, `Makefile` targets, `pyproject`
  / pytest, `Cargo.toml`, `go.mod`. A gate per detected command; `paths` filters only where the mapping is obvious.
- Reads the repo's visibility with `gh`. Public: `hosted` (and `hosted-macos` only when the repo is macOS-specific, said
  in a comment). Private: `hosted` by default, with a comment on the `pool` lane and the owner steps it needs.
- Validates the draft with `plan/config.mjs`. That module imports `yaml`, the kit's one dependency, so make it resolvable
  from the plugin cache without an install step (for example, vendor it), and keep `bin/ci-gate` dependency-free.
- Refuses to overwrite either file without `--force`; prints what it wrote and the next step (`ci-gate`).

### The skill

It carries what the reading model cannot derive: the two files' contract, the lanes and who may use them, the planner's
validation, `ci-gate` as the proof, the owner-only steps for private repos, and the kit's rule on timing tests (assert
that the event happened, not how fast; parent spec §6). It leaves the judgment of which tests belong in which gate to
the agent. Write it under doperpowers' authoring guidance (the essentialist principle in its CLAUDE.md, the
`doperpowers:writing-skills` skill), and let P4 decide whether a line earns its place.

### Versioning

Every change that alters what the plugin ships bumps `.claude-plugin/plugin.json`'s version in the same commit: the
marketplace updates by version, so a change under a number the cache already holds never installs.

## Execution

One worker owns P1–P5 on a branch of ci-kit, plus one PR in doperpowers for the marketplace entry. Order: the plugin
skeleton and the hook (P1 needs the doperpowers PR merged and the plugin installed), then `init` with its tests (P2, P3),
then the skill and its eval (P4), then review (P5). Merging: the dispatching session merges both PRs.

## Progress

- [ ] P1 plugin, hook, marketplace entry
- [ ] P2 `ci-gate init` with fixture tests
- [ ] P3 live adoption on the sandbox
- [ ] P4 behaviour eval
- [ ] P5 tests and review

## Decision Log

- 2026-10-17 (owner): a plugin of its own in the ci-kit repo, listed in the doperpowers marketplace; not part of
  doperpowers. Alternative rejected: a skill inside doperpowers, which the parent spec rules out.
- 2026-10-17 (CI-opt): the hook is silent outside adopted repos and suggests nothing there. Alternative rejected: a
  one-line "this repo could adopt ci-kit" nudge in every repo, which would push CI setup into sessions that did not ask.
- 2026-10-17 (CI-opt): the live proof uses `ci-kit-sandbox` (private, costs a few hosted minutes). Alternative rejected:
  creating a new public repo, an outward-facing step the owner did not ask for.
