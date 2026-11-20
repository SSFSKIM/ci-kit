# Gate ledger execution report (M1 to M5)

Status: DONE. M1 to M5 are built and task-reviewed, and acceptance 1 to 9 are met on the real record. The
pull request from `gate-ledger` is open and not merged. The branch review and the merge belong to the dispatching
session. M6 is a later sitting.

The spec ([2026-11-19-gate-ledger-design.md](2026-11-19-gate-ledger-design.md)) carries every decision in its
Decision Log and every measurement in its Surprises & Discoveries. This file is the account of the execution.

## Milestones

| Milestone | Commits | Review | Sandbox |
|---|---|---|---|
| M1 job lines | 890528d..d78c85a | converged after 2 fix rounds | #87, #88, #90, #93 |
| M2 small store, guard, hand-run import | d5e07ae..9b4c438 | converged after 2 fix rounds | #95, #97 |
| M3 landings and causes | db4246f..c59c48c | converged after 3 fix rounds | #100 |
| M4 report and status file | f2523d0..e11c02a | clean after 1 fix round | #101 |
| M5 ci-gate context and known entries | fc324b8..5edad76 | converged after 2 fix rounds | none |

Each milestone had a fresh executor (opus/high) and a task reviewer (sol/xhigh). Fixes went back to the
executor that wrote the code. Each review stopped on triage, not on a clean verdict.

## Acceptance (final collection 44695640449 at b59d696, store 39b2ed7)

1. **Met.** Run 44486328066 has 9 job lines: gates `static`, `unit` (4 shards), `probes` and `e2e:desk-web`, all
   `success` and basis `exact`; `e2e:desk-web` took 7.6 min (08:18:10Z to 08:25:45Z). The gates' own jobs ran on
   `pool-gce`; `plan` and the `static` summary job ran on `hosted-linux` (acceptance revised). Every repository has
   a job file for every day from 10-22 on which it ran a gate, and 29 of 29 days are covered.
2. **Met.** Run 39962530337, attempt 1: gate `unit` is `failed` (`unit 2/4` failed, the other three passed). Its
   cause is `unattributed`, with no green evidence.
3. **Met.**
   - `infra`: 44468141412 `static`, and 44478359816 `e2e:desk-web`, which the acceptance names in place of
     44472434480. 44472434480 reads `unattributed` (`setup-uncorroborated`), because nothing on its tree got past
     the stall.
   - `superseded`: doperpowers 44489998299.
   - `unattributed`: doperpowers 42817698515 `mods-types` (`basis`), and MAWS 41995538110 (`setup-uncorroborated`).
   - The six labelled attempts were read on GitHub (doperpowers, cua and ci-kit only); none contradicts its label.
4. **Met.** Every `pr_check` difference from the hand measurement is explained by pull request number in Surprises
   & Discoveries. The fixed points hold: #481 is red, #410 is green, and f2c78808, 74ff0ff4 and 06d4ea08 are
   `unrun` pushes. MAWS: 884 landings, 465 exempt, 207 green, 1 red, 211 unrun.
5. **Met.**
   - doperpowers W47: 11 nominations, each "0 reds in N attempts", and 1 candidate (`shell-lint`, one
     `test-only-diff` red).
   - MAWS W47: 3 nominations, each with `infra` reds only. None of the 9 gates the retrospective credits with a
     product catch is nominated.
6. **Met.** On a throwaway failing commit with a fresh status copy, `ci-gate` prints `FAIL`, then `base:` and
   `known:`. In seven cases the output equals base's `ci-gate` byte for byte: a stale copy, no status file, a
   missing branch, a 401, a failed fetch, a stalled lookup and the real store. The replay was done at 5edad76.
7. **Met.** Hand-run run `24952ff2f8a4-20261119T054617Z` has seven lines and six gate attempts; each mini copy is
   an attempt of its own. `ci-gate status --repo SSFSKIM/MAWS` printed 82 gates and no known entries.
8. **Met.** Three MAWS names taken from the store appear 0 times in every collection log checked, and appear in 2,
   8 and 1 store files.
9. **Met.** The guard ran forced on a throwaway branch with a stale marker and opened alert #102, closed after the
   test. Without the override, on the live store, it exits clean until ci-kit `main` writes the marker.

Tests: `node --test test/history/*.test.mjs` passes 197/197, and the CLI files 91/91. The kit's full suite ran
through `ci-gate`: GREEN at 5edad76, run 44700701400.

## Spec statements that proved wrong, and their resolution (all in the Decision Log)

- **Copied shards.** A failed-jobs rerun does not keep the earlier attempt's number on a copied shard. A copy is
  now read by `completed_at < created_at`.
- **doperpowers and cua.** The App is not installed on them. Both are read with the sandbox run's `GITHUB_TOKEN`,
  so no new permission was granted.
- **manim-master annotations.** They are refused there, so the job's log is read instead.
- **Merges by the button.** They are `pr_merge` activity, not `push`.
- **Acceptance 3's case 44472434480.** Its premise does not hold in the record, so the acceptance was restated
  around 44478359816.
- **Cancellations.** An attempt cancelled from outside with no later run now has its own cause, `cancelled`,
  which is not a red. The dispatching session confirmed this. Before, MAWS showed 1,751 interruptions as reds,
  193 of them credited as product catches.

## Friction routed around

- M1's executor once read MAWS from the MacBook: one `gh api` call that returned one run's job count. It is not
  used as evidence.
- Sandbox alert issues were closed with a comment:
  - #94, from transient 502s during the backfill;
  - #96, #98 and #102, opened by the acceptance-9 tests;
  - #99, from a transient network error at token minting.
- The harness forced this session to hand back twice while a child was still running. The dispatching session
  relayed the child's report each time.
- One `git commit --amend` with a force push was refused by auto mode. It was redone as a new commit, with no
  force push.

## Unresolved review findings and residue

Both are in the pull request body. The ledger behind them is `.doperpowers/sde/2026-11-19-gate-ledger-design/`
(gitignored).

Sminos-Session: CI-opt#a45b97a3 (doperpowers on macbook)
