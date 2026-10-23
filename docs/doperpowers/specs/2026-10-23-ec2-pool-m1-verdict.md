# M1 verdict — EC2 is viable with provisioned initialization, not plain gp3

2026-10-23. **Recommend encrypted 50-GiB gp3, 3,000 IOPS / 125 MiB/s, `Ebs.VolumeInitializationRate: 200`; zones `us-east-2c`, `us-east-2a`, `us-east-2b`.**

**Escalation test:** plain gp3 **1.834×** GCE; targeted prefetch **1.338×**; initialization at 200 MiB/s **0.966×**, at 300 MiB/s **0.991×**. The recommended configuration's measured point estimate is below 1.25×. Its initialization charge dominates compute: **$0.03287/job, $3.287/day at 100 jobs/day, about 54.8 days for $180**, before ancillary costs. Do not promote plain gp3 as credit-first.

Scope of that conclusion: these are **API request → manual job completion**, not a measured production queue → completion. M2's scheduler does not exist yet. The comparison assumes the design's unchanged scheduler contributes the same nonnegative queue-to-launch delay to both clouds; adding that common delay cannot push the recommended arm's ratio above 1.25. Initialization/prefetch each have **one fresh-volume job**, not a measured tail distribution. M3's canary must verify the production path; this spike does not prove its queue or teardown behavior.

## Fixed inputs and commands

```text
MAWS commit       9045f31adaaf54b4f4fb628466e03a02f2ed1ade
ci-kit image code 7292a8b1dada5e3726dff164d9662ef6bafc3972
GCE ready image   ci-kit-runner-20261021-224528-8ogy-7292a8b1
EC2 AMI           ami-023201bf7235721cb                 [deleted]
Node / pnpm       v22.23.4 / 11.23.0, both clouds
warm.json         pnpm-fetch=true; Playwright 1.63.0; Electron 44.4.5, both clouds
runner            ci-kit-runner:latest, same pinned ci-kit Dockerfile/base
AWS               c8a.2xlarge: 8 cores, 1 thread/core, 16 GiB
GCE               c4d-highcpu-8: 8 vCPUs, 15 GiB; us-east5-a
unit command      corepack pnpm test --maxWorkers=8 --fsModuleCache --shard=1/4
setup             corepack pnpm install --frozen-lockfile
build             corepack pnpm build:main-preload
environment       CI=true NODE_OPTIONS=--max-old-space-size=5120
result/run        433 files passed, 1 skipped; 6009 tests passed, 29 skipped
```

The same non-root runner container and cache mounts run both arms. Each repetition removes `node_modules` and `out`, then the host performs `sync; echo 3 > /proc/sys/vm/drop_caches` before the container starts. The private source is read using a one-hour GitHub App installation token restricted to MAWS contents, minted with the existing bake's mechanism. No personal GitHub token reached a VM. Listening was an actual GitHub JIT runner in ci-kit-sandbox with an isolated `ec2-spike` label; it accepted no production job.

Parity is the pinned preparation code, tool versions, warm-result versions and measured MAWS revision—not a claim of byte-identical disks. The ready GCE image was baked October 21, AWS October 23; kernels/provider packages differ, and the existing warm manifest does not retain a lockfile hash or full store inventory. The steady-state ratio uses five repetitions after the first install on each VM.

## Boot stages

Seconds; nearest-rank p50/p90. **Ten plain-gp3 Spot launches: five in each of us-east-2a and us-east-2c.** Failed prototype launches are excluded. Kernel boot is reconstructed from the guest's wall clock and `/proc/uptime`. Polling latency is not added to guest timestamps. API request timing includes the orchestrator's CLI/HTTP call overhead.

| Stage | c8a plain p50 | c8a plain p90 | n | GCE own launch | EC2 init 200 | EC2 init 300 |
|---|---:|---:|---:|---:|---:|---:|
| API round trip | 2.120 | 2.187 | 10 | 1.546 | 2.116 | 2.052 |
| API request → kernel boot | 13.349 | 15.317 | 10 | 15.418 | 11.943 | 14.572 |
| Kernel boot → guest helper | 56.380 | 65.440 | 10 | 6.020 | 23.360 | 14.480 |
| Guest helper → container created | 7.323 | 8.936 | 10 | — | 0.918 | 1.615 |
| Container created → runner listening | 15.139 | 19.164 | 10 | — | 7.068 | 7.075 |
| Guest helper → runner listening | 22.705 | 27.170 | 10 | 3.067 | 7.986 | 8.690 |
| **API request → runner listening** | **95.357** | **97.934** | **10** | **24.505** | **43.289** | **37.742** |

The last three columns are single observations, not p50/p90 claims. The original GCE unit creates its container independently of the measurement startup script, so its container timestamp is not reconstructed.

GCE production ledger comparison, C4D highcpu-8 rows from 2026-10-22 11:00Z through the captured 2026-10-23 window; unique allocation IDs, missing stage fields excluded:

| Ledger stage | p50 s | p90 s | n |
|---|---:|---:|---:|
| Insert accepted → RUNNING | 8.052 | 18.870 | 140 |
| RUNNING → job started | 17.723 | 24.274 | 95 |
| Insert accepted → job started | 26.647 | 42.630 | 95 |
| Queued → job started | 30.000 | 49.000 | 95 |

`job started` is not `runner listening`; the ledger includes pre-launch and ordinary placements. [Raw stage rows](../../../ec2/spike/evidence/gce-ledger.json); [individual measured launches](../../../ec2/spike/evidence/measurements.json).

## Hydration and the unit-shard ratio

Pipeline = install + build + unit, excluding source checkout. Disk read bytes and iowait span the **whole container execution**, including checkout on the first run; they are not unit-process-only counters. Reads count the whole root device once, not its partitions. Iowait is its fraction of aggregate host CPU ticks.

| Arm | Pipeline s | Unit s | Root reads bytes | Iowait % |
|---|---:|---:|---:|---:|
| EC2 plain, cold | 182.317 | 94.339 | 699011072 | 12.063 |
| EC2 plain, cache-dropped warm p50, n=5 | 108.570 | 93.635 | 577421312 | 4.951 |
| GCE first job | 126.454 | 100.955 | 676491264 | 4.192 |
| GCE cache-dropped warm p50, n=5 | 114.923 | 100.801 | 554758144 | 6.201 |
| EC2 targeted prefetch, cold | 146.650 | 84.756 | 1574604800 | 14.595 |
| EC2 initialization 200, cold | 101.348 | 83.504 | 698613760 | 5.246 |
| EC2 initialization 300, cold | 113.960 | 95.033 | 699289600 | 4.072 |

```text
EC2 cold − same-VM cache-dropped warm pipeline = 73.747 s (>20 s)
GCE first − cache-dropped warm pipeline       = 11.531 s
Difference of those penalties                = 62.216 s
EC2 warm unit runs  [94.051, 94.232, 92.614, 93.635, 92.782]
GCE warm unit runs  [100.556,100.956,100.578,100.873,100.801]
p50 ratio          93.635 / 100.801 = 0.9289
p90                 EC2 94.232 s; GCE 100.956 s
```

The cold/warm difference includes first-install effects as well as EBS hydration; it is not a claim that all 73.747 seconds are physical block fetch time. The >20-second trigger holds even after subtracting GCE's first-install penalty. Prefetch read the pnpm store, Node tool cache and Corepack cache with eight readers; **its 26.301 seconds are included**.

Paired fresh-VM observations (boot + entire first container execution, including checkout):

| Disk arm | Boot s | First job s | API → end s | / GCE | >1.25? |
|---|---:|---:|---:|---:|---|
| GCE Hyperdisk Balanced | 24.505 | 139.624 | 164.129 | 1.000 | — |
| Plain gp3 | 95.700 | 205.239 | 300.939 | 1.834 | **yes** |
| gp3 + targeted prefetch | 50.640 | 169.040 | 219.680 | 1.338 | **yes** |
| gp3 + init 200 MiB/s | 43.289 | 115.334 | 158.623 | 0.966 | no |
| gp3 + init 300 MiB/s | 37.742 | 124.934 | 162.676 | 0.991 | no |

The 200 arm's unit run was faster than the repeated-VM median. Substituting the 93.635-second median raises its total to **168.754 seconds, 1.028× GCE**, still below 205.161 seconds (1.25×). One run does not establish that 200 is faster than 300. It establishes a lower-priced tier with measured headroom; retain that uncertainty for the canary.

## Written snapshot and per-job cost

```json
{"SnapshotId":"snap-090ce81cb8c62df6a","VolumeSize":50,
 "FullSnapshotSizeInBytes":12304515072,"writtenGiB":11.45947265625,
 "created":"2026-10-23T11:45:10.036Z","completed":"2026-10-23T11:57:12.508Z"}
```

Keep the measured 50-GiB disk for workspace headroom. Snapshot storage follows **11.4595 GiB**, not the provisioned 50 GiB; approximately $0.573/month per retained snapshot at $0.05/GiB-month. A smaller root would require a smaller builder/re-bake, not merely launching this AMI with a smaller volume.

Authoritative Ohio Price List publication `20261022231453`, read via the global Query API in us-east-1 with `location=US East (Ohio)`:

```text
7XB4FNQM945TNNMD  init 100–200 MiB/s  $0.0024 / GiB of full snapshot data
8DNMCHVWXV49ZUP7  init 201–300 MiB/s  $0.0036 / GiB of full snapshot data
M6UGCCQ3CDJQAA37  gp3                 $0.08 / GiB-month
8HFJK44D9234XNWA  public IPv4         $0.005 / hour
WKW5NUYTBWN4S8VU  c8a.2xlarge OD      $0.43108 / hour (builder only)
Spot observed    us-east-2c          $0.1114 / hour
```

**Initialization is charged against the full snapshot for every volume created, including one deleted before initialization finishes.** It is not prorated to job lifetime or the blocks the job happened to read.

| Fresh-job option | Compute $ | Disk $ | IPv4 $ | Initialization $ | Total $/job | $/100 jobs/day | $180 / daily gross |
|---|---:|---:|---:|---:|---:|---:|---:|
| GCE C4D, measured us-east5 | 0.00604 | 0.00053 | 0.00011 | 0 | **0.00668** | **0.668** | — |
| GCE C4D, preferred us-west4, same duration | — | — | — | 0 | **0.00346** | **0.346** | — |
| EC2 plain | 0.00931 | 0.00046 | 0.00042 | 0 | **0.01019** | **1.019** | 176.7 days |
| EC2 prefetch | 0.00680 | 0.00033 | 0.00031 | 0 | **0.00744** | **0.744** | 242.0 days |
| EC2 init 200 | 0.00491 | 0.00024 | 0.00022 | **0.02750** | **0.03287** | **3.287** | **54.8 days** |
| EC2 init 300 | 0.00503 | 0.00025 | 0.00023 | **0.04125** | **0.04676** | **4.676** | **38.5 days** |

Planning estimates use measured API → job-end duration as VM lifetime, a 730-hour planning month, no teardown/transfer/bake/snapshot amortization, and gross prices before credit. GCE uses the existing ledger's catalog rates and Hyperdisk default provisioned performance. The west4 row is a pricing counterfactual at the east5 measured duration, not another benchmark. Lifetime forecasts exclude ancillary spending and the credit-expiry date.

```text
200 initialization/job        $0.027502734375
200 initialization/100 jobs   $2.7502734375 = 13.751% of the $20 margin per day
300 initialization/job        $0.0412541015625
300 initialization/100 jobs   $4.12541015625 = 20.627% of the $20 margin per day
```

M4 should count initialization in each allocation's gross cost, rather than leave it to the margin. Daily Cost Explorer reconciliation must include these EC2-Other charges; the margin covers reconciliation lag and ancillary spend, not a permanently omitted per-job charge. [Rates, per-component calculations, and spike spend bound](../../../ec2/spike/evidence/costs.json).

## Federation and zone order

```json
{"sub":"110062000894727504485","azp":"110062000894727504485",
 "aud":"https://ci-kit/290475840169/ec2",
 "email":"ci-kit-launcher@ssfskim-ci-kit.iam.gserviceaccount.com"}
```

```text
Role                         arn:aws:iam::290475840169:role/ci-kit-ec2-spike
MaxSessionDuration           14400
AssumeRoleWithWebIdentity    DurationSeconds=14400
Proof request                2026-10-23T11:56:49.245Z
Returned expiration          2026-10-23T15:56:49Z
Assumed role                 arn:aws:sts::290475840169:assumed-role/ci-kit-ec2-spike/ec2-m1
```

Trust uses the observed `sub`, `azp` as `accounts.google.com:aud`, and intended audience as `accounts.google.com:oaud`. The permitted Token Creator binding was added **only** on the launcher service account for `cli-owner@ytdownload-505811.iam.gserviceaccount.com`; propagation took about four minutes. [Credential-free proof](../../../ec2/spike/evidence/federation.json).

| Order | Zone | Zone ID | Subnet | Spot $/h | Evidence |
|---:|---|---|---|---:|---|
| 1 | us-east-2c | use2-az3 | subnet-0110187a2f23b0d25 | 0.1114 | five plain boots + all three mitigation arms succeeded |
| 2 | us-east-2a | use2-az1 | subnet-01046dc75127e7e11 | 0.1332 | five plain boots succeeded |
| 3 | us-east-2b | use2-az2 | subnet-0efc861caf2eeb888 | 0.0864 | one Spot request refused `InsufficientInstanceCapacity`; API suggested a/c |

This is a fixed order based on this window, not a claim that b is permanently unavailable. Its on-demand builder succeeded, but that is not proof of Spot availability.

## Cleanup, spend, and retained setup

**AWS spike gross ceiling: $0.735, below $10.** This deliberately charges the builder for its stopped interval through cleanup, adds 60 seconds to every instance's recorded termination request, includes both full-snapshot initialization charges, and adds $0.10 for transfers/storage rounding. It is a conservative usage model, **not a posted billing total**. No Cost Explorer request was needed.

```json
{"verifiedAt":"2026-10-23T12:36:53Z",
 "aws":{"nonTerminated":[],"volumes":[],"images":[],"snapshots":[]},
 "gce":{"instances":[],"disks":[]}}
```

All 16 AWS instances (one builder, two discarded malformed-user-data launches, thirteen valid measurement VMs), their volumes, the AMI and its snapshot are gone. The GCE comparison/debug VMs and isolated JIT runner registrations are removed. No launcher VM/configuration/deployment was changed.

Retained, as requested:

```text
AWSServiceRoleForEC2Spot      service-linked role; AWS does not allow user tags on it
sg-04b8b036fd64144d6           ci-kit-pool, no inbound rules
ci-kit-ec2-spike              Google trust, max session 14400; DescribeAvailabilityZones only
GCP launcher-SA binding      roles/iam.serviceAccountTokenCreator for cli-owner
```

Every taggable AWS resource created carries `ci-kit-pool=ec2-spike` and `ci-kit-purpose=spike`. IAM and the security group have no running compute charge. [Describe-call cleanup evidence and retained resource details](../../../ec2/spike/evidence/cleanup.json).

## Implementation checks and discoveries

- `node --test ec2/spike/metrics.test.mjs`: **6/6 pass**, none skipped. RED covered missing calculations, prefetch incorrectly omitted from total (16 instead of 20 seconds), serial timestamp corruption, and full-snapshot initialization billing. GREEN covers nearest-rank quantiles, device-only reads, aggregate iowait, stage boundaries, prefetch inclusion and full-snapshot billing even after a two-second lifetime.
- The measurement/orchestration scripts are throwaway prototypes; the pure calculations are TDD-tested. `bash -n` / `node --check` cover script syntax. The committed branch is checked with ci-gate, not a MacBook full-suite run.
- One-time Spot + interruption `terminate` rejects instance-initiated shutdown `stop`; the short-lived imaging builder was on-demand. M3 must preserve that distinction.
- `RunInstances` can succeed before `DescribeInstances` sees the ID. Spot quota can also refuse a replacement after the prior instance is terminated, despite apparent room from visible-instance counts. Observe the accepted ID; do not duplicate it.
- AWS CLI automatically encodes `UserData` and decodes console `Output`; scripts pass raw JSON/script text. Two malformed prototype boots were excluded. The unused short-lived token exposed in the first rejected-request diagnostic was revoked; later errors redact request arguments.
- EC2 console output inserts bracketed timestamps inside long JSON records; the parser removes those before decoding and deduplicates repeated observations. The builder's stopped console was empty: job measurements retain console records while instances are running. A production report channel should not depend on console retention.
- Friction updated in [ci-kit #68](https://github.com/SSFSKIM/ci-kit/issues/68). The living design spec was not edited by this worker.

Sources: [EBS initialization behavior and billing](https://docs.aws.amazon.com/ebs/latest/userguide/initalize-volume.html), [EBS pricing](https://aws.amazon.com/ebs/pricing/), global AWS Price List Query responses captured in the cost evidence; GCE prices from `gce/launcher/ledger.mjs`.
