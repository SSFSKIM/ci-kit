# ci-kit

CI for SSFSKIM's repos without the MacBook: a per-repo config (`.github/ci-kit.yml`) and reusable workflow, an agent CLI (`ci-gate`), a runner pool for private repos (one GCE spot VM per job; the Hetzner pool is a frozen fallback), a Mac lane (the Mac mini and a second Mac), and a host janitor.

Status: being built. The living spec: [docs/doperpowers/specs/2026-10-15-ci-kit-design.md](docs/doperpowers/specs/2026-10-15-ci-kit-design.md).

## Use it

- **Adopt it in a repo:** two files, which `ci-gate init` drafts; see [docs/adopting.md](docs/adopting.md).
- **Run private gates on the pool:** [docs/pool.md](docs/pool.md).
- **Verify a commit:** `ci-gate` from a worktree.
- **In Claude Code:** `claude plugin install ci-kit@doperpowers` puts `ci-gate` on every session's PATH, tells sessions
  in adopted repos to verify with it, and adds the `ci-kit:adopt` skill ("set up CI for this repo"). Outside Claude
  Code, `./install.sh` from a long-lived checkout links `ci-gate` into `~/.local/bin`.

## Layout

| Path | What it is |
|---|---|
| `.github/workflows/gates.yml` | the reusable workflow: `plan`, one job per gate, `verdict` |
| `plan/` | the planner: config validation (`config.mjs`), selection (`select.mjs`), globs, the CLI (`plan.mjs`) |
| `bin/ci-gate`, `cli/` | `ci-gate`: arguments, git side, run watching; `ci-gate init` (`cli/init.mjs`) |
| `.claude-plugin/`, `hooks/`, `skills/adopt/` | the Claude Code plugin: manifest, the session-start note for adopted repos, the adoption skill |
| `vendor/yaml/` | the planner's YAML parser (yaml 2.9.1 from npm, its `dist/*.js`, `package.json` and `LICENSE`), vendored so the planner and `ci-gate init` run from a plain checkout or the plugin cache with no install |
| `lib/github.mjs`, `lib/github-app.mjs`, `lib/hcloud.mjs` | the small GitHub REST client (gh's login or the App's tokens) and the Hetzner client |
| `pool/`, `pool-ensure/` | the Hetzner pool: agent and watchdog (`pool/agent/`), runner image, bake, guard, config, and the ensure action; runbook in [docs/pool.md](docs/pool.md) |
| `.github/workflows/pool-guard.yml`, `pool-bake.yml` | the pool's scheduled backstop and its weekly image build |
| `.github/ci-kit.yml`, `.github/workflows/ci.yml` | the kit's own gates (it dogfoods itself) |
| `test/` | `npm test` (`node --test`; no network) |
