# Report: GCE pool placements and faster job start (plan-executor, 2026-10-21)

Spec: `docs/doperpowers/specs/2026-10-21-pool-placement-latency-design.md`. Dispatcher: CI-opt. The executor's
account of the run; the spec's living sections hold the decisions and discoveries in full.

## Milestones

| | PR | Merged | Live | Proof |
|---|---|---|---|---|
| M1 placements in launcher, bake, ledger | #71 | 25012fa | launcher 14:3xZ | ci-gate, reviewer-medium (2 P2 fixed); sandbox job served |
| M2 us-west4 C4D live | #73 | f26f726 | network, bake, manual bake | Acceptance 1–3 |
| max_vcpus 192 → 242 | #78 | | config 18:37Z | |
| M3 tick and boot | #74 | 5e4dfb4 | launcher 00011-4hq, image, base | first insert 3.1–4.2 s into a tick; RUNNING → started 31.4 → 16.3 s |
| M4 webhook | #76 | 0c71271 | launcher 00012-27v, receiver 00001-z7r | 401 / 403 / burst / dropped-delivery proofs |
| M5 pre-launch | #79 | 7d96d85 | launcher 00013-78r, receiver 00002-4b6 | live pre-launch runs (below) |
| #77 test flake | #80 | eba995c | | ci-gate GREEN |
| M6 Cloud NAT | #82 | 1757fd7 | 00014-b8p, rolled back to 00013-78r | parked: GitHub stalls NAT bursts |
| M6 egress switch | #83 | 1b97c25 | | external by default |
| M6 race + counts + NAT line | #84 | aebe86e | base + launcher 00015-s2p | three review rounds; live MAWS run green |
| M6 walk admission + follow-up ticks | #87 | 41debfb | base + launcher 00017-ldn | burst 20/20 ≤ 67 s, refusals 33 → 12 |
| M6 placements | #85 | 7292a8b | network + smoke from PR checkout; bake 4zcgz; launcher 00016-8ct | bake smoked 7 of 8 (C4D us-central1 stocked out); walk burst green, 9 of 20 jobs past 90 s |

## Measurements

- **M2, C3D → C4D** (MAWS 21fc0732d arm b, three runs each): static 463 → 335 s; unit 570 → 427 s; accepted →
  started per VM 48.4 → 37.4 s. **The unit-gain qualification, kept as written (CI-opt):** against all nine C3D runs
  of the day, unit's gain is inside C3D's spread; only static clears it.
- **M3 boot** (c3d-highcpu-4, 5 samples per arm): RUNNING → started 31.4 → 16.3 s; accepted → started 38.5 → 35.2 s;
  the first new-image job on C4D 26.1 s. The first attempt (cloud-init trimmed) was not faster (34.4 vs 29.8 s); boot
  moved off cloud-init (CI-opt approved).
- **M5 live**: run 39655524984, gate jobs 26–32 s after queued (its plan's delivery hit the old receiver mid-rollout);
  run 39664676263 through NAT on C4D, 16–20 s; run 39681922143 on 00015-s2p, 1–6 s (VMs up before the gates queued).
  Acceptance 4 and 5 are read from a day of rows.
- **The day's slow jobs by stage** (spec M6 design): the tail was the minute tick and `max_vcpus` admission, not
  stock-outs; insert time is Compute's (a batch reaches Compute within 0.4–0.9 s, operations take 6–25 s).
- **Cloud NAT** (spec Surprises): boot → "Connected to GitHub" median 12.4 s on external IPs against 53.6–70.4 s on
  1, 3 or 11 NAT addresses. Zero NAT drops, at most 14 ports per VM.
- **Live walk** (00016-8ct, sandbox 39693012581, 20 × cpus-4): queued → started 26 s to 163 s, median 53 s; quota
  refusals 5.5–17 s, capacity 15–21 s. On 00017-ldn with admission (39697568771): 32–67 s, median 42 s, one tick,
  refusals 33 → 12.
- **First image use per region**: accepted → RUNNING 10.8–145 s on the first check VM, 6–7 s warm.

## Environment friction

- ci-gate: GitHub created runs late on 10-21; a plain run ERRORed on run creation; `--keep`, read, delete the `ci/`
  ref. `lib/gce.mjs` accessToken cached 30 min regardless of expiry (friction #68), fixed in M3.
- A foreground `deploy.sh launcher` was killed ("Terminated: 15"); re-run in the background.
- An executor crashed on API ECONNREFUSED mid-M3; resumed.
- `deploy.sh alert` needed three runs: a new log-based metric takes up to 10 min before a policy can use it.
- `deploy.sh launcher` onto traffic pinned by a rollback left the new revision at 0% and printed ok; routed by hand,
  fixed in #85.
- The engine's `[handback-send-enforce]` nudge ended this run early once, 2 s after a child stopped to wait on its
  ci-gate (doperpowers friction tracker #304); the run continued on CI-opt's word with bounded foreground waits.

## Residue

- The day-long readings: Acceptance 4 and 5, M3's day-of-rows proofs, day one's unclaimed pre-launched VMs and their
  cost (`gce/latency-report.mjs`), and the 20 s race trigger re-sized from the logged insert times.
- Config before code: the launcher reads `gce.json` from main every tick but runs its revision's code, so #85's
  placements went live on 00015-s2p before 00016-8ct (spec Surprises; ci-kit #72 comment, two fixes to weigh).
- Probe before fan-out (fix 2): not built, since admission alone met the bound; it would remove the burst's 12
  concurrent capacity refusals. A race row's missing zone (deferred #87 review P2).
- Spot preemptions, all C3D us-central1 (10 VMs on 10-21): check after a day of #85's order whether they drop; else
  consider C3D us-central1 on demand only (spec Open items).
- C4D us-central1 out of capacity at 22:00–22:19Z: watch its refusal counts; dropping it is a config commit.
- `deploy.sh alert` should create its metrics first and retry policies, not fail on propagation.
- Tick preparation before the first allocation (~5–6 s) above M3's ≤ 5 s target.
- The runner's job-end result-upload drain (33–56 s on 4 of 74 unit shards): no fix evidenced; instrumentation is to
  filter the runner's stdout to its end-of-job lines in `gce/vm/job.mjs`.
- The NAT question: what in GitHub's edge stalls concurrent NAT flows (a packet-level probe from a no-IP VM).
- From #72: stale c3d/e2 us-central1 rates (10-16 catalog).
- The runs listing's lag for brand-new runs; idle VMs not subtracted from the pre-launch shape.
