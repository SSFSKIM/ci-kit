# Gate ledger execution: report (interim, 2026-11-20)

Status: IN PROGRESS. M1 and M2 are complete and reviewed. M3 is built, and its executor is applying the
`cancelled` ruling and re-deriving the store on the pool. M4 and M5 have not started. No ci-kit pull request is
open yet.

The ledger is `.doperpowers/sde/2026-11-19-gate-ledger-design/progress.md` (gitignored). It holds the bases,
heads and agent handles a resume needs:
- M3's executor is `a2b868cbb0631adae`, base db4246f.
- M1's reviewer is `a71eae6159f9aa75c`.
- M2's reviewer is `a340ae69916c2a0f4`.

The spec's Progress, Surprises & Discoveries and Decision Log carry every decision folded so far.

## Milestones

- **M1, job lines:** 890528d..d78c85a. The review converged after two fix rounds.
  - Acceptance 1, 2 and 8 are met on the real store, backfilled from 10-22.
  - Sandbox PRs #87, #88, #90 and #93 are merged.
- **M2, the small store, the guard and the hand-run import:** d5e07ae..9b4c438. The review converged after two
  fix rounds.
  - Acceptance 7's first half and acceptance 9 are met.
  - Sandbox PRs #95 and #97 are merged. The guard arms itself once ci-kit main writes the marker.
- **M3, landings and causes:** db4246f..05f4e37, plus the `cancelled` ruling, which is in progress.
  - Acceptance 3 is met on the record, after its 44472434480 case was restated around 44478359816.
  - Acceptance 4: every `pr_check` difference from the hand measurement is explained by pull request number in
    Surprises & Discoveries.
  - Sandbox PR #100 is merged.
- **M4 and M5:** not started.

## Remaining

1. M3: the `cancelled` cause and the re-derivation, then M3's task review.
2. M4: the report and the status file. It also covers what the dispatching session added: cancelled attempts and
   minutes shown beside each gate's reds and on every candidate, and a count of activity chain breaks under "what
   the record cannot say".
3. M5: the context lines and known entries, then the whole acceptance section and the kit's suite through
   `ci-gate`.
4. The whole-branch review (doperpowers:review-code, medium), Outcomes & Retrospective, and the pull request.

## Friction routed around

- M1's executor once read MAWS from the MacBook: a single `gh api` call that returned one run's job count. It is
  not used as evidence.
- Sandbox alert issue #94 had been opened by transient 502s during the backfill; it is closed with a comment.

Sminos-Session: CI-opt#a45b97a3 (doperpowers on macbook)
