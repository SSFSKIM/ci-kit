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

## 2026-10-22 — Day-one readings (CI-opt)

**Acceptance 4's median meets its bound in the requested window; Acceptance 5's run-level promise is missed:**
13 of 45 observed pre-launched runs have gate-job medians above 25 s. The worst, run 39731694196, has six jobs with
a median of 58.5 s, **33.5 s over**. The pooled-job median of 22 s is a diagnostic, not an A5 pass. **M3 does not
close:** 11 launch ticks miss its 5 s preparation bound, and the one timed C3D-4 job misses its 26 s bound. Keep the
20 s race trigger and spot placement order for now; neither a race-threshold change nor a C3D on-demand switch is
justified by these rows. No live configuration, quota, deployment or runner was changed for this reading.

### Window, sources and limits

The frozen window is **2026-10-22T00:15:00Z–2026-10-22T21:38:04Z** (21 h 23 m 04 s, not a completed 24 h).
The fresh checkout was main `e7cef209d92f`; every launcher log in the window names `ci-kit-launcher-00017-ldn`, and
its ticks name config `e6c8fefa`. The read used gh's token and the MacBook's default gcloud account,
`cli-owner@ytdownload-505811.iam.gserviceaccount.com`.

```sh
node gce/latency-report.mjs --since 2026-10-22T00:15:00Z --until 2026-10-22T21:38:04Z
```

The collector selected 433 VMs by **creation time**, 1,411 completed ticks, and 304 jobs with recorded queued and
started times, across 59 runs. All these VMs/jobs belong to MAWS; there are no sandbox/manim jobs in this cohort.
The ledger snapshot has 410 final rows and 23 running rows. The collector reads mutable ledger rows, not historical
snapshots: rerunning this command later can add jobs and final costs to the same creation cohort. These readings
are the captured day-to-date result, not certification of the remaining 2 h 36 m 56 s or of unclaimed live VMs.

Sources: the open/rotated [sandbox pool ledger](https://github.com/SSFSKIM/ci-kit-sandbox/issues/48) (read through
`readRows`), launcher Cloud Logging (`resource.type="cloud_run_revision"`, service `ci-kit-launcher`, the window
above), Compute audit events (`protoPayload.methodName="compute.instances.preempted"`, same window), and serial
logs searched for the runner's `shutdown signal`. Raw captures are retained on the reading MacBook in
`/private/tmp/ci-kit-dayread-evidence/`; that scratch directory is not a durable archive. Percentiles below use the
collector's nearest-rank rule. Insert send → done is the tick's operation duration, not creation → RUNNING.

### Acceptance 4 and 5

| Reading | Day-to-date result | Verdict against the promise |
|---|---|---|
| A4: MAWS pool jobs queued → started, median ≤ 50 s | 24.0 s; p10–p90 1–42 s; n=304; max 80 s | **Met in this window**, 26 s below the bound. A full 24 h remains unobserved. |
| A5: a pre-launched run's gate-job median ≤ 25 s | 32/45 observed runs meet the bound; 13/45 miss. Worst: run 39731694196, six jobs, median 58.5 s | **Missed in this window**, worst by 33.5 s. A pooled median cannot satisfy a run-level promise. |
| Diagnostic: pooled jobs of pre-launched runs | 22.0 s; p10–p90 1–42 s; n=235 across 45 runs; the 69 jobs of other runs have median 34 s | **Not an A5 verdict** or a randomized estimate of pre-launch's benefit. |
| M5: inserts before the run's own gates queue | 158/182 claimed VMs serving their intended run were created before their job queued; creation → own-job queued median 4.5 s, p10–p90 −0.6–24.4 s | **Demonstrated, not universal.** 24 were late; pre-launch does not always hide the boot. |

A5 promises a run's gate-job median, not the collector's pooled-job median. The median of the 45 run medians is
21.5 s, but neither that nor the 22 s pooled diagnostic overrides the 13 observed run-level misses. Full standby's
10 s clause is inapplicable: the owner chose pre-launch, not standby.

**Why A5 misses:** in the worst [run 39731694196](https://github.com/SSFSKIM/MAWS/actions/runs/39731694196),
all six serving VMs have `prelaunch` rows naming that run, but all were created **2.1–2.8 s after** their jobs queued
(06:04:37Z; VM creation 06:04:39.145–06:04:39.761Z). Their six original inserts took **38.795–39.822 s send → done**,
and their jobs started 58–60 s after queued (median 58.5 s). The launch tick began at 06:04:31.714Z and sent its
first insert at 06:04:38.527Z: **6.813 s preparation**. Pre-launch supplied no prequeue lead, and slow Compute
inserts then added to the exposed wait; the label alone does not establish that boot was hidden. Other misses also
have little or no prequeue lead, leaving the ordinary ~26 s accepted → started path visible. For example,
run 39765562278's six own pre-launched VMs were created 1.2–1.5 s after their jobs queued; creation → started had
median 26.148 s, and the run's queued → started median was 27.5 s. These timings are joined from the frozen
`rows.json` and `launcher.json` in `/private/tmp/ci-kit-dayread-evidence/`, not a new live observation.

As a concrete M5 proof of creation before queueing, MAWS
[run 39858604975](https://github.com/SSFSKIM/MAWS/actions/runs/39858604975)'s hosted plan ran 21:36:21–21:36:35;
`ci-kit-gce-hsec0lgnq8` was created at 21:36:26.363, before `e2e:desk-web` queued at 21:36:35. It started at 21:37:13;
its 38 s wait still misses A5.

### M3: tick and boot

| Stage | Median | p10–p90 | n |
|---|---:|---:|---:|
| queued → next tick | 7.7 s | 2.5–27.0 s | 304 |
| tick start → first insert **sent** | 3.2 s | 2.7–6.4 s | 86 |
| tick start → first insert accepted | 3.9 s | 3.3–6.9 s | 86 |
| accepted → RUNNING | 8.5 s | 6.9–18.4 s | 413 |
| RUNNING → job started | 17.6 s | 16.3–39.3 s | 304 |
| accepted → job started | 26.5 s | 24.4–56.6 s | 304 |

- **Tick ≤ 5 s: missed.** 75/86 launch ticks meet it, 11/86 (12.8%) do not. p90 misses by 1.352 s;
  the worst is 9.898 s, **4.898 s over**, at 01:31:53.427Z. Its first insert was sent at 01:32:03.325 and then
  completed in 8.7 s with no refusal. The excess precedes Compute provisioning: observation, ledger and JIT API
  work is the likely cause, not stock-out or boot. There are no per-call preparation timings to isolate which read
  or write was slow. A good median cannot close a ≤ 5 s bound that the spec did not qualify as a median.
- **C3D-4 accepted → started ≤ 26 s: observed miss by 20.637 s; insufficient day-long exposure.** The only timed
  sample is `hsec0lgnq8`, **46.637 s**: accepted → RUNNING 31.486 s, then → started 15.151 s. Compute's send →
  done was 32.292 s. This miss is provisioning, not a return of the old ~30 s guest-boot delay. First-use is a
  possible explanation, not established by this row. Only two C3D-4 VMs were created, the other an unclaimed race
  child without RUNNING/job timestamps in the snapshot. One job cannot establish a representative C3D day median.
- **C4D separately:** accepted → started median **26.493 s** (303 jobs). By size: C4D-2 26.8 s (28), C4D-4
  25.3 s (24), C4D-8 26.0 s (197), C4D-16 29.7 s (54). These are not substitutes for M3's C3D-4 target.
  The large upper tail includes VMs that waited for a later run to claim them; it is not all boot latency.

### Unclaimed pre-launch: count and cost

The collector reports **320 pre-launched VMs, 212 claimed, 108 not yet claimed**. Of those 108, **93 are final**
(`cancelled-idle`) and cost **$1.6783**, including their priced VM, disk and external-address lifetime; all 93 are
priced. They accumulated 59,546 VM-seconds (16.54 VM-hours). **15 are still running**, so 108 is not a final waste
count and $1.6783 is not the final cost of all 108. They may still take jobs, including another run's jobs.

Applying the ledger's `dailyLine` to this creation cohort's finalized rows gives 302 finalized pre-launch VMs,
93 unclaimed, $1.6783. The whole cohort's 410 finalized VMs cost $4.2664. These are a read-only subtotal, **not the
published full-UTC-day daily line** (the launcher publishes yesterday after midnight); rows created before 00:15
and final costs of the 23 running VMs are outside this subtotal. The current day's published line and the final
status of the 15 unclaimed pre-launch VMs remain to be read. There is no spend ceiling in the spec to miss.

### Race trigger and M6's tail

**Retain 20 s.** It falls almost exactly at the measured p90, rather than inside ordinary insertion time. The
434 logged attempts comprise 424 created in the tick, nine initially unknown, and one capacity refusal. All nine
unknown outcomes later have a created/settled record in the captured ledger. Combining their exact ledger
send/done times with the tick durations gives **433 successful inserts**, median **9.5 s**, p90 **20.1 s**, p95
**30.2 s**, p99 **53.8 s**, max **68.439 s**; **44/433 (10.2%) exceed 20 s**. The one refusal took 11.5 s.

There were **27 race allocations**; their rows were allocated 20.9–21.7 s after the original send (the 20 s timer
plus recording overhead). At the snapshot, 22 pairs are final: child first claim 7, original first claim 10,
neither claimed 5; three of the 17 claimed pairs had both claimed. Five pairs remain unresolved. Unclaimed VMs
in final race pairs cost **$0.5659**; this overlaps pre-launch waste where the original was pre-launched and must
not be added to it as a disjoint cost. First claim is not measured latency saved: a runner can serve a later run.
For example, `hsdem542qf` first claimed a static job around eight minutes after the race was allocated.

The day supports the trigger as a reasonable tail cutoff, **not an optimal threshold or a quantified speedup**.
Raising it would wait longer on the 48–68 s tail; lowering it would race more ordinary inserts. There is no
observed >90 s start to justify either change: **all 304 timed jobs started within 80 s**, so M6's refusal/slow-insert
90 s condition holds for the observed starts. Zero quota refusals, one capacity refusal (C4D us-central1-a, falling
through to -b), zero on-demand launches, zero deadline cuts. Probe-before-fan-out still has no demonstrated need.

### C3D us-central1 preemptions and owner decisions

**Zero audit-confirmed preemptions; no affected job identified.** The window-wide audit query returned no
`compute.instances.preempted` events; no runner `shutdown signal` was found in the serial log search, and no
captured ledger row ends `preempted`. Audit and serial absence alone cannot exclude the prior day's teardown race.
The more important limit is exposure: C4D served 426/433 new VMs, and **only five new C3D VMs ran in us-central1**,
all created at 21:36–21:37. They have just one recorded job (`e2e:desk-web`, job 120103272840 above, in progress
when checked). Including the 14.781 s tail of the C3D VM created before the window, the observed us-central1 C3D
exposure is only **389.419 VM-seconds (6.49 VM-minutes)**. Two other new C3D VMs are race children in us-east1.

The count fell from the previous day's 10 to zero, but the placement received almost no traffic; this does **not**
show a lower underlying preemption rate. **An on-demand-only switch is not warranted by this window.** Keep C4D
first and collect materially more C3D exposure before revisiting that decision, unless the owner chooses to pay
for interruption avoidance independently of these measurements.

No emergency quota action is indicated by the start results. Read-only quota checks still show C4D us-west4 **50
vCPUs**, other C4D regions **24 each**, and address grants **8 us-west4 / 32 us-central1 / 8 per east region**.
There were 786 admission-skip counters, all family-vCPU limits (390 west4, 276 central1, 90 east1, 24 east4, 6 east5),
not 786 distinct delayed jobs. For more fast-family headroom, pursue the already-requested west4 C4D 192 grant
and the address raises rather than changing the spot policy; no quota was filed or edited here.

**Remaining actions:** M3 and M5 must stay open. The owner can authorize work on the 11 slow preparation ticks
and the missing prequeue lead behind A5's run-level misses. A full 24-hour closeout and final pre-launch/race costs
need a later read after 2026-10-23T00:15Z, and C3D's boot and preemption conclusions need actual C3D traffic, not
another idle day. No on-demand switch, race change or NAT re-enable is recommended. Cloud Quotas initially billed
the MacBook service account's home project and returned 403; the read succeeded with `x-goog-user-project: ssfskim-ci-kit`,
without enabling an API or changing credentials
(ci-kit friction tracker #68).
