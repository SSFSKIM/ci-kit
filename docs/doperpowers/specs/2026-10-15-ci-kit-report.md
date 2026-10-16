# ci-kit — execution report (plan-executor)

Running account of the Plan of Work's execution. The spec's Progress, Surprises & Discoveries and
Decision Log carry the folded results; this file carries the execution mechanics.

## 2026-10-15

- Pre-flight committed (13154e6): execution order and concurrency, M2's "20 dispatched runs" read
  as A10's `ci-gate` runs, `.gitignore` for the execution ledger.
- Dispatched concurrently, each in its own worktree: M1 (`m1-core`), M4 (`m4-spike`), M6
  (`m6-mac-lane`). M8 waits for M1's `npm test` layout; M2/M3 wait for the hosted-probe
  prerequisite (not yet in §5).
- 2026-10-15: maws-fe (DL22) cleared the mini runner; M6 switched to e2e:composer with readiness steps (8371147); M6 executor told.
- 2026-10-15: M4 DONE — verdict ≤5 min band (p90 56.3 s), ~€1.50, all deleted (verified by controller). No task review: a spike with no product code; numbers verified against results/summary.tsv and the cleanup listing re-run. PR #1 merged.
- 2026-10-15: M1 merged (PR #2, 0a930ee) after two fix waves (WAIT on queued started_at, glob subset, plan-ending errors, error boundary). v1 → 0a930ee. ci-gate re-installed from the main clones on MacBook and mini.
- 2026-10-15: probe landed (e1cfd8a). Dispatched m2-kit (kit additions), M2 (cua) and M3 (doperpowers); coordination decisions recorded (c7ea5f3). Running: M2k, M2, M3, M5, M6, M8.
- 2026-10-16: M6 merged (PR #4) after one fix wave (PID identity, signal errors). Rate-limit incident (~23:00Z): executors drained the shared GitHub token; capped at 2 pollers; ci-gate fix wave dispatched (branch ci-gate-ratelimit).
- 2026-10-16: M8 merged (PR #6) after four review rounds ending in an argv parser; janitor live on both Macs from the main clones. Medium review of doperpowers #198 clean after one fix wave; M5 in its third review round.
- 2026-10-16: M5 code merged (PR #7) after three review rounds; v1 → 86069cf. Post-merge guard proofs dispatched. Janitor report headers confirmed live on both Macs (02:12Z runs).
- 2026-10-16: M2 merged (cua#143). M3 reworked after the owner discarded codex-companion; its 20-run series is running. M7 waits for the pool.
