# GCE pool: placements across regions, and a faster job start

## Purpose

The GCE pool (parent spec `2026-10-15-ci-kit-design.md` §3a) runs one spot VM per GitHub Actions job for MAWS,
manim-master and the sandbox. The owner ruled on 2026-10-21 that CI must never be the bottleneck: parallelism comes
first, and cost is no reason to hold it back. The pool's spend is still reported, never used to cut parallelism.

Two things now set how long a MAWS class 1a run takes, beside the tests themselves:

- **The CPU.** The pool runs C3D (AMD Genoa) in us-central1. C4D (AMD Turin) has about 1.38x the single-thread speed,
  which is what tsc, eslint and the builds wait on, and 1.30x the per-vCPU throughput (published benchmarks; the
  research is `~/Developer/ci-analysis/vm-cost-research.md`, CI-opt's machine). C4D spot in us-west4 costs 0.69x
  per unit of work at today's prices. The pool's capacity is also one region's quota: C3D 192 vCPUs, 32 external
  addresses.
- **The start.** A pool job waits about 100 s from queued to started (97–109 s measured). A MAWS class 1a run waits
  once: its plan job runs on GitHub-hosted `ubuntu-slim` (starts in ~4 s, runs ~14 s), and its gates then wait for
  their pool VMs. The critical-path work (`~/Developer/ci-analysis/critical-path.md`)
  measured where the time goes:

  | Stage | Median | Range |
  |---|---|---|
  | queued → next launcher tick (Cloud Scheduler, one a minute) | 26.9 s | 3.7–55.3 |
  | tick start → insert accepted (~29 sequential GitHub calls, cleanup before launches) | 14.9 s | 11.2–18.1 |
  | insert accepted → RUNNING | 10.5 s | 7.6–15.3 |
  | RUNNING → job started (dockerd waits on cloud-init, which waits on snapd seeding) | 29.6 s | 27.2–35.3 |

  Sharding the unit tests multiplies VMs per run, and the run then waits for the slowest of n starts (p90 ~113 s).

This initiative makes capacity span regions and machine families, puts C4D first, and takes the start from ~100 s
toward the boot alone, and below it for the jobs a warm runner covers.

### What it must not be

- Not a move. C3D us-central1 and its granted quota stay in the walk; a new placement adds capacity.
- Not a second cloud. AWS c8a and hosted runner services were weighed and set aside (Decision Log).
- Not a price optimizer. The order of placements is set by speed first; price is reported.

## Glossary

- **Placement:** one region and machine family the launcher may create a VM in: its zones, subnetwork, the machine
  type for each size (2, 4, 8, 16 vCPUs) and the boot disk type.
- **Walk:** the ordered attempts for one launch (`walkPlacements`, `logic.mjs`).
- **Hop:** one queued → started wait for a pool VM. A MAWS class 1a run has one on its critical path: the gates,
  queued when plan (hosted) ends.
- **Warm runner:** a booted VM whose runner is registered and listening before any job asks for it.

## Progress

- [x] (2026-10-21 12:2xZ) Quota preferences filed: C4D us-west4 192 (granted 0 at filing), instances us-west4 64
  (24), addresses us-west4 64 (8), Hyperdisk Balanced us-west4 4096 GB (500), all-regions CPUs 256 → 512.
- [ ] M1 — Placements in the launcher, the bake and the ledger.
- [ ] M2 — us-west4 C4D placement live, measured against C3D.
- [ ] M3 — The tick and the boot.
- [ ] M4 — Launch on GitHub's `workflow_job` webhook.
- [ ] M5 — Warm runners (the shape the owner chooses).

## Acceptance

1. With C4D us-west4 first in `gce.json`, MAWS class 1a jobs run on C4D; when us-west4 refuses (capacity or quota),
   the same tick creates the VM in the next placement, and nothing waits on a refusal from the region it left.
2. On one MAWS commit, three class 1a runs on C4D against three on C3D: all green, equal test counts, and the unit
   and static job medians lower on C4D by more than C3D's own spread.
3. The ledger's daily line prices every VM by its region and family, Hyperdisk included.
4. A pool job's median queued → started is at most 50 s (from ~100 s) with M3 and M4 in, over a day of MAWS runs.
5. With M5 in: pre-launch, a run's gate jobs start a median ≤ 25 s after they are queued; full standby, a job a warm
   runner covers starts within 10 s.
6. No regression: the parent spec's A13 clauses (teardown, ledger, alerts, no VM left behind) still hold.

## Design

### Placements

`pool/config/gce.json` replaces `region`, `subnetwork`, `zones`, `machines` and `machine_fallback` with an ordered
list:

```json
"placements": [
  {"region": "us-west4", "subnetwork": "ci-kit-us-west4", "zones": ["us-west4-a", "us-west4-b", "us-west4-c"],
   "machines": {"2": "c4d-highcpu-2", "4": "c4d-highcpu-4", "8": "c4d-highcpu-8", "16": "c4d-highcpu-16"},
   "disk_type": "hyperdisk-balanced"},
  {"region": "us-central1", "subnetwork": "ci-kit-us-central1",
   "zones": ["us-central1-a", "us-central1-b", "us-central1-c", "us-central1-f"],
   "machines": {"2": "c3d-highcpu-4", "4": "c3d-highcpu-4", "8": "c3d-highcpu-8", "16": "c3d-highcpu-16"},
   "disk_type": "pd-balanced"}
]
```

`machine_fallback` goes: the next placement is the fallback. A placement must name a machine for every size. E2 leaves
the pool: its us-central1 quota raise was refused twice, it is the slowest family, and size 2 in us-central1 runs on
`c3d-highcpu-4`, today's fallback for it.

**The walk for a size:** spot in every zone of the first placement, then spot in the next placement's zones, and so
on; then on demand in the same order. Spot everywhere before on demand anywhere, as today. A capacity refusal moves
to the next zone. A quota refusal skips the rest of that placement for that machine and provisioning. The launcher
remembers it for the rest of the tick, scoped to what ran out (the refusal's message names the metric and region):
a family's CPU quota by (region, family), a regional resource (instances, addresses, disk capacity) by region, the
all-regions CPU quota everywhere; and a remembered refusal skips only later requests of the same or more vCPUs in that
scope, since a smaller one may still fit. The rule that an unknown insert outcome stops the walk is unchanged: two
zones must never both hold one allocation's VM.

**The launch queue stops only when quota stops everything.** Today a tick stops every remaining launch as soon as any
launch met a quota refusal (`launcher.mjs`, `if (result.quota) stop = true`), even when its walk then created the VM
in another zone. With placements that would stop the queue at the first us-west4 refusal. A launch whose walk
created a VM never stops the queue; one whose walk was refused for quota in every placement stops later launches of
the same or more vCPUs, as the remembered scopes say.

**Admission:** `max_vcpus` stays one number across placements. A launch reserves the largest machine its walk could
land on, as today (every placement's machine for the size).

**Observation:** the launcher lists ci-kit instances with `aggregatedList`, every zone of every placement in one
call; the listing is complete only if no placement's zone is missing.

**The VM:** `jobInstance` takes the placement: subnetwork `regions/<region>/subnetworks/<subnetwork>`, the
placement's `disk_type` for the boot disk. The image family is global and the current image boots NVMe/gVNIC
machines (C3D needs both already); M1 proves C4D boots it with a smoke VM.

**The bake** builds in one placement (where it builds today) and runs its smoke VM once per placement, so an image
that does not boot on a placement's family is never marked ready. The image stays global. The bake job reads the
`gce.json` bundled at its deploy (`bake.mjs`), not main's: it changes only through `gce/deploy.sh bake`, after main
carries the config it should read (M2).

**The ledger** keys rates by family and region: the table in `ledger.mjs` gains `c4d` with us-west4 spot and
standard rates from the Cloud Billing catalog on the day M1 is built, and the disk price by disk type
(`hyperdisk-balanced` capacity, plus any IOPS or throughput above the baseline the catalog includes). A VM in a region
with no rate is reported unpriced, as today.

**Order is speed first.** C4D first, C3D second, on demand last. The ledger's daily line shows each placement's VM
count and cost, so a price swing is visible; reordering is a `gce.json` commit read from main, no deploy.

**Config change and deploy order.** The launcher reads `gce.json` from main every tick. The new launcher also reads
the old form: its zones and machines as one placement, and `machine_fallback` as a second placement in the same
region for the sizes it names, so size 2 keeps its `c3d-highcpu-4` fallback and the admission bound (the largest
machine a walk could land on) is what it is today. It deploys before the config changes; the old form's reader is
deleted in M2, once main carries the new form.

### The tick and the boot (M3)

- **Reads in parallel.** The tick's GitHub reads (queued jobs, runners per repo) run concurrently, and launches go
  before cleanup. Launching first can only under-admit against `max_vcpus` for one tick (a VM about to be deleted
  still counts), never over-admit. Target: tick start → first insert ≤ 5 s.
- **Cover.** `planLaunches` counts an instance as cover when its runner is registered and not busy. A VM whose job
  just ended still shows that way until its runner is removed, so a queued job of its size launches nothing and
  waits for the next tick (static job 119166794835 waited 126 s on 10-21). A job VM is single-use (JIT): an instance
  whose runner has taken a job is never cover, whatever its runner's state reads. How the launcher knows (the jobs
  API's `runner_name`, a guest attribute the job-started hook writes, or the VM's age against its claim) is M3's
  choice; its test replays that 10-21 sequence.
- **The boot.** The bake purges snapd and stops cloud-init from gating dockerd (`docker.service` no longer waits on
  `cloud-final`), and keeps only the cloud-init modules the VM uses. Target: RUNNING → job started ≤ 20 s.
- **Timing in the ledger.** Each ledger row gains the job's run id, workflow path and size, the job's queued and
  started times (GitHub's `created_at` and `started_at`, read when the row is reviewed) and the VM's RUNNING time
  (`lastStartTimestamp`); the tick logs its start and its first insert as structured fields. A collector in the repo
  (`gce/latency-report.mjs`) reads a day's rows and logs and prints the stage medians of the table in Purpose: M3's and
  M4's proofs, and the input M5's pre-launch reads.
- **Serial console.** Project metadata `serial-port-logging-enable=TRUE`, so a VM deleted after a failed boot leaves
  its console in Cloud Logging.

### The webhook (M4)

The launcher stays what it is: internal ingress, no unauthenticated invocation, one instance at most, Cloud Scheduler
authenticating with its identity. Cloud Run's ingress and invoker settings belong to a service, not a path, so the
public surface is a second, separate service:

- **The receiver** (`ci-kit-webhook`, public) verifies `X-Hub-Signature-256` against the webhook secret before
  reading anything else and answers 401 otherwise. For a `workflow_job` `queued` event of a served repo whose labels
  carry `ci-kit-pool`, it asks the launcher for a tick now, through a path the launcher's internal ingress admits
  with an authenticated identity (a Pub/Sub push subscription, or the receiver's VPC egress; M4 chooses). It holds
  no state and launches nothing.
- **The launcher** runs a requested tick at once, the same full tick as the scheduler's: every queued job planned
  together against a fresh observation, so coverage is counted once for all of them. Requests that arrive while a
  tick runs coalesce into one more tick after it; ticks start at least 10 s apart; and while GitHub's remaining rate
  budget for the App is under 20%, requested ticks are dropped and the minute tick alone serves.
- **No new state.** A requested tick is an ordinary tick, so a lost, duplicate or delayed delivery costs at most the
  minute until the next scheduled tick, never a job. Two launcher instances or revisions overlapping is the parent
  spec's bounded, self-healing overlap (§3a), unchanged: M4 adds no cached view and no reservation for it to break.

The webhook secret is created in Secret Manager by the owner (Secret Manager writes are human-only); M4 prepares the
exact command and waits for it. The App's webhook URL and secret can be set through the App's own API
(`PATCH /app/hook/config`, authenticated as the App); subscribing the App to `workflow_job` events may need its
settings page, which is the owner's to click: M4 finds out and prepares the steps.

### Warm runners and pre-launch (M5, shape pending the owner)

A run waits only for its slowest gate VM, so a warm runner shortens the run only when every long gate job of the run
(static and each unit shard) finds one; probes is short enough to start late. The owner was asked on 2026-10-21
(corrected the same hour: the first question assumed a plan hop on the pool) and M5 builds the shape chosen:

- **Pre-launch only (recommended).** When a served repo's run begins (its first job queued, the webhook of M4 or the
  tick), the launcher launches the VMs that run's gates will ask for, from the shape of the same workflow's recent
  runs in the ledger rows M3 adds (the median count per size over its last 10 runs inside the reader's window; none
  found, no pre-launch), so they boot while plan runs (~17 s hidden). A pre-launched VM is an ordinary job VM: one no
  job claims is removed by the idle rule (`idle_runner_minutes`). Cost: the occasional unclaimed VM (a docs-only run
  whose plan skips the gates).
- **Full standby.** Warm runners for one run's long gates (static and every unit shard, ~80 vCPU at 4×16 shards)
  kept booted: about $11–16 a day; only the first of concurrent runs gains, ~20–30 s over pre-launch.
- **None, or decide after measuring M3 and M4.** M5 waits or is dropped.

Pre-launched VMs count against `max_vcpus`. Full standby is not designed here: a warm runner conflicts with the
coverage window (`idle_runner_minutes`), the VM's creation-relative `max_run_minutes`, and A13's "an hour without
demand leaves no pool resources". If the owner chooses it, it gets its own design round first: warm, claimed and
retiring states, replenishment, unregister-before-delete rotation, a lifetime that lets a claimed job finish, and
the A13 amendment.

## Plan of Work

### M1 — Placements in the launcher, the bake and the ledger

Change `config.mjs` (schema; old form read as one placement), `logic.mjs` (`placements`, `largestMachineCpus`,
`jobInstance`, quota memory per tick), `launcher.mjs` (aggregated listing, completeness per placement zone), the bake
(`bake.mjs`, `plan.mjs`: disk type and subnetwork from the placement), `ledger.mjs` (rates by family and region,
disk by type), `docs/pool.md`. Tests beside each: the walk's order across two placements, quota memory, the old form,
disk type per placement, ledger pricing of a c4d VM, and the tick as a whole (`launcher.mjs`): more than 16 admitted
jobs, us-west4 refusing for quota, us-central1 with room, every job launched in that tick; a family-quota refusal
not blocking another family; a 16-vCPU refusal not blocking a 2-vCPU launch. `gce.json` on main is NOT changed in M1.

Proof: `npm test` green; ci-gate green; reviewer-medium; deployed from merged main (`gce/deploy.sh launcher`) with
the old-form `gce.json`, and one sandbox job served as before.

### M2 — us-west4 C4D placement live, measured against C3D

Wait for: the critical-path measurements to finish (CI-opt says when; changing the pool during them mixes their
arms) and the us-west4 quota grants (C4D ≥ 64 is enough to start; the walk falls through to C3D beyond it).

Steps 1 and 2 may run before the critical-path measurements end: they add a subnetwork and one VM outside the walk.

1. `gce/deploy.sh network` with the us-west4 subnetwork added (`ci-kit-us-west4`); the firewall is network-wide.
2. A smoke VM, `c4d-highcpu-2` on `hyperdisk-balanced` in us-west4 from the current image: runner registers, a
   sandbox job passes, the VM is gone within A13's teardown bound.
3. `gce.json` on main in the new form, C4D us-west4 first. Delete the old form's reader. Then `gce/deploy.sh bake`
   (the bake reads its bundled config) and one complete bake, run by hand: its log shows a smoke VM in each placement
   before the image is marked ready.
4. One MAWS commit (the critical-path base 21fc0732d's arm b, whose three C3D runs already exist): three more class 1a
   runs on C3D just before step 3, three on C4D just after (the pool's config is global, so the arms cannot run
   side by side): Acceptance 2.

Proof: Acceptance 1–3.

### M3 — The tick and the boot

As designed above. Proof: tick start → first insert ≤ 5 s and RUNNING → job started ≤ 20 s over a day's ledger; the
cover fix's test reproduces 119166794835's sequence; A13 clauses hold.

### M4 — Launch on the webhook

As designed above. Proof: at the receiver, a forged signature gets 401 and starts no tick; at the launcher, an
unauthenticated POST and one with a wrong identity are refused by Cloud Run (403) before the code runs; a burst of
same-size jobs between scheduled ticks is launched by one coalesced requested tick; a webhook dropped on purpose
(the secret rotated mid-test) still gets its job served by the minute tick; a day's median queued → started ≤ 50 s
from `latency-report.mjs` (Acceptance 4).

### M5 — Warm runners

After the owner's answer, in the shape chosen. Proof: Acceptance 5 over a day; the warm set's cost on the ledger's
daily line, reported to the owner.

## Verification

- This spec: one `doperpowers:adversarial-reviewer` round on the design and the execution section.
- Each milestone's PR: `doperpowers:reviewer-medium`; M4 (public ingress, signature check) at `reviewer-high`.
- Spec review round 1 (adversarial-reviewer, astra, on 5af3cd9): 3 P1 + 6 P2, all taken (Decision Log).
- Measurement rule for M2 (as the critical-path work): three green runs per arm, equal test counts, median gain larger
  than the baseline's spread.

## Decision Log

- 2026-10-21 (CI-opt): **C4D added as a placement, not a move.** Moving to us-west4 would give up C3D us-central1's
  granted 192 vCPUs and start a new region's grants from zero (C4D there was granted 0 when filed). A list keeps both,
  so the ceiling is the sum, and a spot stock-out in one region falls through to the other.
- 2026-10-21 (CI-opt): **Order by speed, not by a daily price ranking.** The research proposed ordering placements by
  each day's catalog price per unit of work, since spot prices move weekly (C4D us-west4 halved since April, C3D
  us-central1 rose 45%). Under the owner's ruling cost does not decide, and C4D is the faster family at any of those
  prices; a ranking would add a catalog reader and a moving order to explain a cost axis the owner set aside. The
  ledger shows the cost per placement; a reorder is one commit.
- 2026-10-21 (CI-opt): **Not AWS c8a, not a hosted service, not Hetzner.** c8a is the fastest per vCPU (one full core
  each) but AWS rates c8a.2xlarge in us-east-2 at ">20%" interruption against our measured 0.7%, and it means a second
  backend. Namespace starts a job in 14 s but caps concurrency at 32–160 vCPU by plan, which contradicts the
  parallelism ruling, and runs private code on a third party. Hetzner bills per started hour. Revisit c8a if GCE
  quota or spot stock becomes the ceiling.
- 2026-10-21 (CI-opt): **Webhook as a fast path, tick kept.** The parent spec deferred the webhook "until A13's
  measured latency is missed"; at ~27 s of a ~100 s start, and twice per run, it is. The tick stays the reconciler so
  a lost delivery costs a minute, never a job.
- 2026-10-21 (CI-opt): **No Cloud NAT.** It would remove the external-address quota as a ceiling, but its
  $0.045/GiB processing on each VM's ~260 MB of downloads costs as much as the VM. Addresses are requested instead.

- 2026-10-21 (CI-opt), spec review round 1: **the webhook is a separate public receiver that requests a full tick**,
  not a per-job planner in the launcher. Per-job planning counted one idle runner as cover for every job planned
  alone (a probe of `planLaunches` launched one VM for two jobs planned together, none for the same two planned
  apart), and a public path would have made the whole launcher public, since ingress and invoker settings are per
  service. A requested tick reuses the tested planner and adds no state; the price is a full observation per
  coalesced burst (rate-budget guarded). Rejected: shared pending-demand reservations (new state to keep correct
  across restarts, duplicates and two instances).
- 2026-10-21 (CI-opt), round 1: **quota memory scoped to what ran out, and the tick-wide quota stop removed**; the old
  form's `machine_fallback` kept as a second same-region placement; **E2 leaves the pool**; the bake's deploy step
  added to M2; ledger timing fields and `latency-report.mjs` added to M3 (the proofs of M3 and M4 and M5's input had
  no producer); full standby moved to its own design round (its lifecycle conflicts with the coverage window,
  `max_run_minutes` and A13).

## Surprises & Discoveries

- 2026-10-21 (CI-opt): the first version of this spec and the owner's first standby question assumed a pool hop for
  MAWS's plan job; plan runs on GitHub-hosted `ubuntu-slim`. Purpose, the glossary, M5 and Acceptance 5 corrected;
  the owner re-asked.
- C4D in us-west4 had a family quota of 0 for this project when the preference was filed, though Google lists
  C4D in us-west4-a/b/c. us-central1's external addresses are still granted 32 of 64 asked (reconciling since 10-21
  09:2xZ), which caps that region at 32 VMs.

## Outcomes & Retrospective

(at completion)
