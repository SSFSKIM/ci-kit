# EC2 spot: a second cloud for the ephemeral pool, credit first

## Purpose

ci-kit's pool runs each Linux job of its member repositories (MAWS, ci-kit-sandbox, manim-master) on its own
spot VM in Google Compute Engine (GCE). One Cloud Run service decides which VMs exist: the launcher in
`gce/launcher/`. The owner holds $200 of AWS credit on account 290475840169 (expiring 2027-04-17). On 2026-10-23
they chose to spend it on CI, with EC2 spot as **a second pool beside GCE, used first while the credit lasts**.
Once the credit is spent, EC2 becomes overflow: it is tried after GCE's spot placements and before any on-demand
VM. That leaves a second capacity pool for when GCE's stock or quotas run out. One such ceiling today is
us-west4's 8 external IPv4 addresses, `IN_USE_ADDRESSES`.

After this work:

- A MAWS run's pool jobs start on c8a spot VMs in us-east-2. Their runner names read `ci-kit-ec2-<allocation>`.
- The jobs pass as they do on GCE.
- The ledger and the daily reports show each VM's cloud, zone, machine and gross cost, and how much of the credit is
  spent.
- When the credit is spent, or its date passes, new VMs go to GCE first. This needs no deploy, and no running job is
  touched.
- If AWS refuses capacity or quota, the job is placed on GCE in the same tick.
- Each pool repo has its own providers: which clouds and accounts it may use, in its own order, with optional
  vCPU caps, set in ci-kit's pool config. A repo that names none stays on GCE alone. Adding an AWS account for
  one project is config plus that account's setup run, not a scheduler change.

To see it, push a MAWS class 1a run through `scripts/ci-gate.sh` and read its pool jobs' runner names. Then read the
launcher's `placed … ec2 …` log lines and the ledger rows.

The first milestone is a measurement. AWS's lazily loaded disks, EC2's boot path and the c8a's real speed on MAWS's
unit job are not known yet. The owner was told that the figures behind the decision are estimates until that
measurement exists.

## Progress

- [x] (2026-10-23 11:2xZ) Survey of the code seam (CI-opt's notes, `reports/ec2-backend-survey.md` in
  ci-analysis; its findings are folded into Design below).
- [x] (2026-10-23 11:0xZ) Spot vCPU quota increase requested: 32 → 256 in us-east-2 (request
  `7548a787be7d4005a3dda9b3359d6cbcS9TGNQLw`, pending).
- [x] (2026-10-23) Two adversarial reviews returned; their accepted corrections are folded into the design,
  contracts and proofs. M2–M6 implementation has not started on this branch.
- [x] (2026-10-23) Round-two corrections incorporated: bounded launch reconciliation, bake permissions and
  market, role session duration, Cost Explorer's endpoint and immutable billing readings.
- [x] (2026-10-23 12:2xZ) Revised spec reviewed (round 2 confirmed round 1; its five findings applied). Loop stopped.
- [x] (2026-10-23 12:37Z) M1: the measurement spike. Verdict in
  `docs/doperpowers/specs/2026-10-23-ec2-pool-m1-verdict.md` (f5827cf, merged here); summary in Surprises &
  Discoveries. Every spike instance, volume, AMI, snapshot and GCE VM deleted; AWS spend at most $0.735.
- [x] (2026-10-23 13:1xZ) Owner's go after the M1 cost finding: "Proceed, credit first" (rejected: overflow only, stop).
- [x] (2026-10-23 18:37Z) M2: data contracts, v2 ledger with v1 reads, and provider-qualified keys; no behaviour change.
  Task review approved without findings; committed-head test gate green: run 40003608129, implementation 0de12c4.
  Live GCE parity remains the merged-main M3 proof. AWS spend remains at most $0.735 (no M2 resources).
- [x] (2026-10-23 19:06Z) M3: GCE effects extracted behind the provider; no behaviour change.
  Implementation fe16bdb reviewed clean; implementation gate 40006417067 and exact PR-head gate 40007392109 green.
  PR #107 merged c14ac6c; fresh-main deploy serves ci-kit-launcher-00019-pxv. MAWS class 1a run 40008135552
  passed all six pool jobs on GCE, with v2 rows in sandbox ledger issue #48. No rollback was needed.
  AWS resource spend remains M1's <=$0.735; this execution also made one Cost Explorer read ($0.01).
- [x] (2026-10-23 19:2xZ) Owner's ruling: per-project providers, built into this initiative ("Per-project, in
  EC2"; rejected: a provider protocol for outside operators, now or after EC2). Design revised: Each repo's
  providers; M4–M6, Acceptance 11 and Interfaces updated before M4 starts.
- [x] (2026-10-23) Closed the per-repo review findings before M4: disabled instances remain valid, admission
  reserves both budgets synchronously, and refused pre-launches do not consume slots; M4/M5 proofs updated.
- [x] (2026-10-23 19:59Z) M4: scheduling over providers and each repo's provider list,
  proved with fake providers in two EC2 accounts. Review approved through 3550a56 after three blocking fixes;
  Minor alert wording deferred to ci-kit #108 entry 1. Implementation gate 40014371555 and exact PR-head gate
  40014591706 green; PR #109 merged dcdc629. Fresh-main revision ci-kit-launcher-00020-t8v passed MAWS class 1a
  run 40015186704: all six pool jobs on GCE, v2 rows, no ERROR logs or rollback. AWS resource spend unchanged
  from M1's <=$0.735, plus this execution's one $0.01 Cost Explorer read.
- [ ] M5: the EC2 provider, its image and its one-time setup, serving ci-kit-sandbox.
- [ ] M6: credit preference, reports, guard, the MAWS canary and acceptance.

## What it must not be

- **A second launcher reading the same queue.** Two schedulers would each count the same queued job as demand and
  each launch a VM for it. Pre-launch, the demand count and the concurrency budget stay single (Design, One
  scheduler).
- **A price optimizer.** Placement order is an explicit, configured policy. The owner rejected daily price ranking
  (`docs/doperpowers/specs/2026-10-21-pool-placement-latency-design.md`, Decision Log). "Credit first" is a
  policy switch, not a price signal.
- **AWS first at any price.** The credit makes AWS spot preferable. It never puts AWS on-demand (~$0.43/h for
  c8a.2xlarge) ahead of GCE spot, and EC2 on-demand job candidates stay off. Only the bake builder uses
  on-demand, so it can stop for CreateImage (The image and parity).
- **A stored AWS secret.** The launcher reaches AWS through federation of its Google identity. No AWS access key
  sits in Secret Manager, in the image or in any config. Secret Manager writes are the owner's alone, and this work
  needs none.
- **A change in GCE behaviour.** With EC2 disabled, the launcher places, prices, logs and ledgers exactly as it
  does today. Existing ledger rows stay readable.
- **Provider rights in the repo's own hands.** Which accounts a repo may spend, in what order and up to what cap is
  ci-kit's pool config, read by the launcher. A repo's `.github/ci-kit.yml` does not grant it: a pull request
  edits that file, and the account owner pays.
- **ARM.** Graviton (c8g) is cheaper, but it needs an arm64 image and toolchain, which is a separate project.
- **Automatic reruns after an interruption.** As on GCE, an interrupted job is recorded and fails, and reruns are
  the caller's (`docs/pool.md`, Preemption).

## Glossary

- **Provider**: a cloud the scheduler can place VMs in: `gce` or `ec2`. In code, a module behind the interface in
  Interfaces and Dependencies. One provider instance exists per configured account: one GCE project, and one per
  entry of `ec2.json`'s `accounts`. Its identity is `(provider, account)`, the pair M2's keys already carry.
- **Provider list**: a pool repo's ordered list of the provider instances it may use, each with an optional vCPU
  cap (Each repo's providers). Absent means GCE alone.
- **Candidate**: one concrete way to place one VM: provider, region, zone, machine type, vCPUs, spot or standard,
  image, subnet, disk, logical job size and runner labels. Logical size is not physical vCPUs: GCE's
  c3d-highcpu-4 can serve a `cpus-2` or a `cpus-4` allocation. The scheduler walks candidates for one logical size.
- **Allocation**: one provider-bound attempt to create a VM, with its ledger row and its GitHub JIT runner.
  Its id names both the runner and the VM. Moving demand to another provider opens a new allocation.
- **JIT config**: GitHub's just-in-time runner configuration. It is minted per allocation and lets one ephemeral
  runner register with given labels, then take one job.
- **IMDSv2**: EC2's instance metadata service, in its session-token form. A process on the VM reads its user-data
  and spot interruption notices there.
- **User-data**: data attached to an EC2 instance at launch, readable from IMDS. Here it is a small JSON document,
  not a script.
- **Web-identity federation**: AWS STS `AssumeRoleWithWebIdentity`, which trades a Google-signed ID token for
  temporary AWS credentials of a role whose trust policy names that Google identity.
- **Credit preference**: an account's standing while its credit lasts: its instance keeps its place in each repo's
  provider list, and once the preference ends it becomes overflow (Placement order). It ends at a
  billing threshold, stale billing, a date or the flag being turned off.
- **Hydration**: an EBS volume created from an AMI's snapshot fetches each block from S3 the first time it is
  read, so first reads are slow.
- **Zone ID**: AWS's account-independent zone name (`use2-az1`). Zone names (`us-east-2a`) map to ids differently
  in each account.

## Acceptance

Each item names its owning milestone. The Concrete Steps give the commands and live procedures; M6 repeats the
whole acceptance after the parts have passed.

1. **No AWS secret (M5).** `gcloud secrets list --project ssfskim-ci-kit` lists no AWS credential. The deployed
   launcher's AWS configuration carries role ARNs, not keys. Its log shows `aws: assumed <role> until <time>` after
   a start, and it launches EC2 VMs. Both launcher and bake roles have `MaxSessionDuration: 14400`, and federation
   requests 14400 s. The bake launches a Canonical-base builder through its federated role, not `ci-kit-ops`.
2. **MAWS jobs on EC2 (M6).** With the credit preference on and MAWS's provider list naming EC2 first, a MAWS class 1a run's pool jobs
   (static, the unit shards, probes) run on `ci-kit-ec2-*` runners and pass. Each ledger row reads `provider: ec2`,
   with its zone and zone id, `c8a.*`, `spot`, estimated gross dollars and an image id.
3. **Overflow and launch recovery (M4 scheduling, M5 recovery, M6 live).** When all EC2 candidates refuse definitely, generic demand
   continues on GCE in the same tick, under a new allocation id and a GCE-labelled JIT registration. The log links
   the refusal and placement to the same demand, not the same allocation. Tests prove both directions, cleanup of
   the refused registration and that a VM never advertises the other provider's label. Provider-only demand never
   crosses clouds. Live, overflow can be observed in M6 when a sandbox burst exceeds EC2's spot quota with
   preference on. M5 restart tests prove that a request never received by AWS is abandoned at 10 min, while an
   accepted request with a lost response is found by tag/token and recorded running, with no request replay.
   M4 pre-launch tests retry on the next tick when all providers refused, count a successful fallback and its
   races as one speculative slot, and recover the same partial-batch counts after restart.
4. **The VM cleans up after itself (M5).** Compare `exit.json`'s job-end time with the instance's state-transition
   time: termination follows within 60 s. No volume belonging to that allocation remains. Launch a sandbox VM for
   a label no job uses, with `max_run_minutes: 5` in a test config and no launcher managing it: it powers off and
   terminates at its guest deadline. Separately, a VM whose runner never registers is terminated by the launcher
   after the idle limit (10 min), not by a guest deadline chosen to precede it.
5. **The guard reaps what the launcher missed (M6).** Hand-launch a pool-tagged `job` instance with no ledger row.
   Once it is 15 min old it is reaped within one guard period (15 min), with its id in the log. A stopped `builder`
   that has not yet reached CreateImage and is before its deadline is left alone. Expired job, builder and smoke
   resources, stopped job instances, orphan job volumes and unready AMIs older than a day are reaped under The
   guard's predicates; the AMI's snapshots are deleted too. A late job VM whose allocation row is already
   final is reaped within one guard period, even before its deadline.
6. **An interruption is recorded, not rerun (M6).** A synthetic spot interruption on a running job VM (AWS Fault
   Injection Service, `aws:ec2:send-spot-instance-interruptions`) ends that allocation's row `preempted`. GitHub
   shows the job failed, and no rerun is started. A notice alone neither claims nor retires the runner.
7. **The credit preference ends by itself (M6).** Before enabling preference, setup demonstrates a Cost Explorer
   read through the federated launcher role at the endpoint below; failure stops M6 for escalation. A test config
   with `budget_usd` below the current `billed_usd`
   logs `credit preference off: budget`; new generic demand tries GCE spot before EC2, while a running EC2 VM is
   untouched. A newest reading older than 48 h logs `credit preference off: stale billing` and has the same effect.
   Date expiry and `credit.enabled: false` also end the preference without retiring running VMs.
8. **Reports show both clouds (M6).** `node gce/latency-report.mjs` groups its stages by provider and zone.
   `node gce/cost-report.mjs` prints per provider instance: VMs and estimated gross dollars; for a credit account it also prints the
   credit-funded estimate, AWS's `billed_usd`, `through`, `read_at` and remaining budget. Unknown rates print as
   unpriced, never as zero. Row estimates do not drive placement policy. An overlap test starts a fresh reader
   after an older reading is posted last: the newer `read_at` still wins, regardless of comment creation order.
9. **GCE unchanged when EC2 is off (M2–M4, live M5, repeated M6).** With `pool/config/ec2.json` absent,
   top-level `enabled: false`, all listed EC2 accounts disabled, or no repo's list naming EC2, the full launcher
   suite passes and a generic class 1a run whose repos list GCE places there as before. Lists may still reference
   EC2: disabling it is valid, takes effect on reload and keeps existing allocations managed and accounted for.
   An absent file skips those entries with one log per config load and holds non-final EC2 reservations under
   Unknown EC2 inventory; it does not retain the last enabled config. Use `enabled: false` to switch EC2 off,
   not file deletion. M4 proves the transitions with fakes; M5 repeats them live. The regression bar is
   single-cloud behaviour, not retaining repo/size coverage that cannot distinguish provider-only jobs.
10. **Images in step (M5).** Compare the AMI's tags with the GCE image's labels for one bake: ci-kit commit, Node
    versions, MAWS revision and lockfile hash, runner version and warm results match. Read both smoke logs; the
    same suite passes on both images.
11. **Each repo on its own providers (M4 tests, M5 and M6 live).** Tests: a repo whose list is GCE alone never
    opens an EC2 allocation, even with credit preference on; a repo listing GCE before EC2 uses EC2 only after
    GCE's spot candidates refuse; a repo at its EC2 cap walks its next provider without opening an EC2
    allocation; two EC2 accounts are walked, capped, refused and remembered separately, and a refusal in one does
    not skip the other; a job pinned to a cloud its repo does not list stays queued with one log line naming the
    repo and cloud; removing a provider from a list leaves that repo's running VMs and their coverage untouched.
    Queued, speculative, race and fallback admissions acquire both budgets before asynchronous work, count each
    allocation once and reserve physical vCPUs. M4 proves concurrent admission, a race at cap, refusal release
    and fallback to a physically larger candidate without exceeding the global budget.
    Live: in M5 only ci-kit-sandbox lists EC2 and MAWS places on GCE alone; in M6 the lists of Acceptance 2 hold.

## Design

### One scheduler, two providers

The launcher keeps everything that is about demand and GitHub. That covers the queue read, coverage (unclaimed
VMs and uncertain launches subtracted from demand), pre-launch, allocation ids, JIT minting, reservations, the
global vCPU budget and the ledger. Everything that is about one cloud moves behind a **provider**:

- listing its VMs, images and limits;
- launching one allocation on one candidate;
- reconciling an uncertain launch;
- terminating;
- reading guest reports;
- cleaning up orphans.

Two providers exist: `gce`, which is today's code moved behind the interface, and `ec2`.

Why one scheduler: pre-launch and coverage are already subtle (`gce/launcher/logic.mjs`, `prelaunch.mjs`). A second
launcher reading the same queue would launch a second VM for every queued job. The strongest alternative was an
independent EC2 launcher with its own repo list. It lost because ci-kit's config makes repo ownership exclusive
between backends (`gce/launcher/config.mjs`; `pool-ensure/ensure.mjs`), so each repo would be wholly on one cloud
or the other, which defeats the overflow.

There is no backend interface to reuse from the Hetzner backend: Hetzner shares the job container and the image
preparation, not a control-plane interface. This is a new, small boundary for ephemeral VMs. The Hetzner host
agent is not touched.

The repos the pool serves stay where they are, in `pool/config/gce.json`'s `repos`. No repo changes owner. Which
providers each of them may use is that repo's provider list (Each repo's providers).

**Runner labels and coverage.** EC2 runners register with `self-hosted, ci-kit-pool, cpus-N, ci-kit-ec2`;
GCE's carry `ci-kit-gce` instead. Each queued job's labels give a required provider: `gce` when it names
`ci-kit-gce`, `ec2` when it names `ci-kit-ec2`, otherwise `any`. Other labels still have to match the runner's
labels; a job asking for both cloud labels is unservable. Runner names are provider-specific:
`ci-kit-gce-<allocation>` and `ci-kit-ec2-<allocation>`.

For one repo and logical size, a runner or pending allocation of provider P covers only demand requiring `any`
or P. Match the most constrained jobs first: GCE-only jobs against GCE coverage, EC2-only jobs against EC2
coverage, then generic jobs against what remains of either. Consume each coverage unit and each covered job
once. The two provider-only sets are disjoint subsets of the generic set, so this greedy matching is optimal;
letting oldest generic demand consume scarce provider-only coverage first is not. Remaining uncovered jobs keep
the existing oldest-first admission and global vCPU budget. A provider-restricted job walks only its provider's
candidates.

The existing eligibility rules for unclaimed runners and pending allocations still apply when inventory is
known. Pre-launch shapes record required provider alongside logical size, from the labels of the job actually
served, not from the cloud it happened to land on. Pre-launch speculates only for `any` demand. Read v1 rows as `any`: ci-kit's planner has only emitted generic pool labels
(`test/plan.test.mjs`, `test/select.test.mjs`), and no hand-written provider-pinned job is known. The accepted
risk is a speculative VM on the wrong cloud if such a job exists; label-aware coverage never counts that VM
against the pinned job. V2 stores job labels, so this assumption fades out with the old shapes. Rejecting v1
shapes instead would disable pre-launch until new history accumulates. This changes
`planLaunches` and `runShape`; moving their old repo/size counters unchanged would underprovision mixed labels.
Tests mix generic, GCE-only and EC2-only jobs in the same repo and size, with both runners and pending allocations.

**Unknown EC2 inventory.** A failed EC2 listing does not stop GCE serving. Every non-final EC2 ledger row keeps
its recorded vCPU reservations against the global budget and its `(repo, provider, account)` cap: launching,
running or deleting, including a launching row whose VM exists but whose running write failed. Reservation is
not coverage. GitHub's runner list is
independent of AWS: an online, idle, unclaimed `ci-kit-ec2-*` runner can cover eligible demand under the matching
rule above; a busy runner covers nothing, and a failed GitHub listing supplies no coverage. A row and its runner
are never counted twice. That tick makes no EC2 launch, termination or finalization; unseen rows are never
finalized as gone. If the inventory stays unknown for 30 min, the launcher logs an error once for that outage and
keeps the same conservative reservations. Non-final rows remain recoverable across restarts and outages
longer than the ledger's ordinary 26-hour cache window; cache aging or issue rotation cannot release them.
A failed list is not treated as a successful empty inventory. All of this is per provider instance: one EC2
account's failed listing holds that account's rows and launches only.

### Each repo's providers

The owner ruled on 2026-10-23 that each project has its own providers. Each entry of `gce.json`'s `repos` may
carry an ordered `providers` list (shape in Interfaces):

    {"repo": "SSFSKIM/MAWS",
     "providers": [{"provider": "ec2", "account": "290475840169", "max_vcpus": 128}, {"provider": "gce"}]}

- An entry names a provider instance by `provider` and `account`. `account` may be left out when that provider
  has one configured account, counting disabled accounts too. When it has several, `account` is required.
  For these list references and caps, the parser refuses only an EC2 account absent from `ec2.json`'s `accounts`
  while that file is present, an ambiguous account, a GCE account other than `gce.json`'s `project`, a duplicate
  instance, or a non-positive cap. Reference validity is separate from eligibility to launch.
- `max_vcpus` caps the physical vCPUs that this repo's non-final allocations reserve on that instance. It counts
  ledger non-final rows plus this tick's in-memory reservations, counting each allocation once, as the global
  budget does. Admission acquires both reservations synchronously (Provider-bound allocations). At the cap,
  the walk skips that instance for this repo: no allocation is opened, and nothing is remembered as a refusal.
  Absent means no cap beyond the global `max_vcpus`. The owner's standing rule is to maximize parallelism.
  A cap is for an account's owner to bound what one repo spends there; it is not a default.
- A repo without `providers` uses GCE alone. EC2 is opt-in per repo: enabling `ec2.json` changes no repo's
  placement until that repo's list names EC2 (Acceptance 9). This replaces the earlier `repos` narrowing in
  `ec2.json`.
- The list governs new allocations only. Removing a provider from it leaves the repo's running VMs, their coverage
  and their rows alone, just as the end of credit preference does.

A configured instance remains valid when disabled: top-level `ec2.json` `enabled: false` disables all EC2
instances; an account's optional `enabled: false` disables just that instance (default true). The walk skips it
for new allocations. Its existing allocations retain reservations and eligible coverage, and its provider still
observes, reconciles, terminates and reads reports. Disable is a valid reload, so `source.mjs`'s last-good-config
fallback for invalid input never masks it. **Switch EC2 off with `enabled: false`.**

When `ec2.json` is absent, no EC2 instance exists. List entries naming EC2 are skipped for new allocations, not
refused by the parser, and logged once per config load, not each tick or job. A confirmed deletion is absence,
not a read failure that keeps the last good config. Non-final EC2 rows keep both reservations and independent
GitHub coverage under Unknown EC2 inventory. Deleting the file while EC2 VMs live removes their provider
management and gives the guard no account legs; the VMs are left to their guest deadlines. This is not the way
to switch off EC2. Disabled accounts, unlike absent ones, remain guard legs.

A job's required provider (from its labels) filters its repo's list to that cloud. A pinned job whose repo lists
no instance of that cloud cannot be served. It stays queued, and the launcher logs `unservable: <repo> lists no
<provider>` once per job. ci-kit's planner emits only generic pool labels, so only a hand-written job can pin.
Pinning a gate to a cloud from `.github/ci-kit.yml` is a separate, later change.

Coverage is unchanged: runners and allocations already belong to one repo; the current list and launch
eligibility do not revoke existing coverage. Stock-out, quota, `denied` and `throttled` memory, rooms and
unknown-inventory holds are kept per provider instance, so one account's refusal never skips another account's
candidates.

Why the list lives in ci-kit's config: the account owner decides what may be spent there (What it must not be).
The strongest alternative was each repo declaring its providers in its own `.github/ci-kit.yml`. It lost because a
pull request edits that file. A repo-side preference within its list can be added later on top of this.

Accounts are configured, not coded. `ec2.json` holds a list of `accounts`, and each account carries its own
placements, roles, security group, report bucket and optional `credit`. This version configures and proves one
account live (290475840169); tests exercise two. A second account needs its config entry and its own setup run
(`ec2/setup.sh`), and the bake and the guard then cover it. GCE stays one project in this version.

### Placement order and the credit preference

Each provider instance expands its config into candidates, in config order. For one job, the scheduler builds
the walk from the repo's launch-eligible instances (Each repo's providers):

1. The spot candidates of each listed instance, in list order. An instance whose credit preference has ended
   moves after the repo's other spot instances, keeping its relative order. It becomes overflow.
2. Then the standard candidates of the listed instances that have them, in list order. Only GCE has standard
   candidates in this version.

"Ended" applies only to an account with a `credit` block whose preference is off (below). Credit never moves an
instance ahead of its place in a list; it only demotes a credit account once its preference ends. An EC2 account
without `credit` is walked where its repos list it.

The pool repos' M6 list, EC2 then GCE, gives the owner's credit-first choice:

| The EC2 account's credit preference | Walk for a repo listing EC2, then GCE |
|---|---|
| on | EC2 spot candidates → GCE spot candidates → GCE standard candidates |
| off | GCE spot candidates → EC2 spot candidates → GCE standard candidates |

A repo listing GCE before EC2 gets the second row whether the preference is on or off. A repo listing GCE alone
never walks EC2.

EC2 standard (on-demand) candidates are not configured, and the parser refuses them in this version.

Inside each instance the order is the config's, the same as today. In EC2 that is a configured zone order, set by
M1 from observed prices and capacity. Prices are reported, not used to rank.

The scheduler keeps today's per-attempt semantics (`gce/launcher/logic.mjs`, `placements`, stock-out and quota
memory), with the keys widened to `(provider, account, region, zone, machine, provisioning)`. A refusal in one
provider instance never blocks a candidate in another.

**The preference ends**, per account with a `credit` block, when any of these holds:

- `credit.enabled` is false in that account's entry in `pool/config/ec2.json`;
- today (UTC) is after `credit.until`;
- AWS's `billed_usd` is at or above `credit.budget_usd`;
- the newest billing reading is older than 48 h, or no reading is available.

The launcher logs the change once (`credit preference off: <reason>`); budget and stale data use respectively
`budget` and `stale billing`, and the line names the account. Only new walks change.
The budget is **$180** against the $200 credit. Billing can lag by about two days; at the expected full EC2 load
of about $5/day, that is about $10 of unreported spend. The $20 margin covers that lag with about $10 left for
variation and charges the credit may not cover. This is an estimate, not a hard AWS spending cap.

**The billing reading** comes from AWS, not finalized rows. Once a day, for each account with a `credit` block,
the launcher reads that account's Cost Explorer through its launcher role
(`ce:GetCostAndUsage`), unblended EC2 compute plus EC2-Other since `credit.since`, grouped by record type so
credits do not hide the gross charges consuming the budget. The daily refresh reads only when the newest
stored reading is older than 6 h, including across launcher restarts. This is best-effort cost control, not a strict call cap: overlapping launchers or a failed refresh may
read twice. At $0.01 per call that is accepted; no lock is needed. A launcher with a fresh stored reading makes
no Cost Explorer call. A failed refresh is logged and leaves the last reading in force until it becomes stale.

Each reading is a new, immutable comment on a dedicated, never-rotated issue titled `ec2 credit <account>` in the
configured ledger repo, found by title; one issue per credit account. Its schema is in Interfaces. A missing issue is created and populated
by a fresh read; until there is a valid reading for `credit.since`, preference stays off as stale billing.
Readers select the newest valid `read_at`, not the last comment created. A writer prunes all but the newest
20 readings; deleting the old readings is safe in any order. Overlapping writers never overwrite each other:
even if an older reading's write lands last, a fresh process still selects the newer reading. A single mutable
comment would lose that newer reading on restart, so it is rejected. Tests exercise this overlap, pruning,
restart refresh eligibility, stale data and a missing issue. This storage is separate from
`ledger-store.mjs`'s rotating issues and 26-hour row cache. There is no finalize increment or counted-id list;
row costs are report estimates only.

Cost Explorer uses `ce.us-east-1.amazonaws.com` and signs for `us-east-1`. This is the one documented exception
to the pool's `us-east-2` region constraint; EC2 stays in us-east-2. A `ci-kit-ops` billing read succeeded on
2026-10-23, proving the account policy does not deny Cost Explorer, not that the runtime role can read it.
Setup must demonstrate a billing read under the federated launcher role before M6 enables credit-first. If
that proof fails, M6 stops and escalates rather than shipping credit-first without working billing access.

### Reaching AWS: federation, no secret

The launcher runs on Cloud Run as `ci-kit-launcher@ssfskim-ci-kit.iam.gserviceaccount.com` (`gce/deploy.sh`,
`SA`), and the bake job runs as the same account. To call AWS, it:

1. asks Cloud Run's metadata server for an **ID token** with audience `https://ci-kit/290475840169/ec2`. Today's
   code fetches only access tokens (`lib/gce.mjs`).
2. calls regional STS `AssumeRoleWithWebIdentity` (`https://sts.us-east-2.amazonaws.com`) for the role it needs,
   asking for 14400 s (4 h), the duration the federation proof also requests.
3. caches the credentials and assumes the role again when less than 2 h 30 min remains. Report URLs must outlive a
   VM's 120-min life (The guest's report).

AWS knows `accounts.google.com` as a built-in web-identity provider, so no IAM OIDC provider resource is created
for Google. The trust policy of each role:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "accounts.google.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": { "StringEquals": {
      "accounts.google.com:sub": "<ci-kit-launcher's numeric unique id>",
      "accounts.google.com:aud": "<the token's azp claim>",
      "accounts.google.com:oaud": "https://ci-kit/290475840169/ec2"
    } }
  }]
}
```

AWS maps `:aud` to Google's `azp` when the token has one, and `:oaud` to Google's `aud`. M1 reads a real token's
claims before writing the policy. It does not assume `azp` from the docs.

Everything here is per account. Each configured account has its own roles, and its own audience
`https://ci-kit/<account>/ec2`. A token minted for one account's roles is refused by another account's trust policy.
The launcher keeps one credential cache per role ARN.

The launcher and bake roles both have `MaxSessionDuration=14400`. `ec2/setup.sh` sets that value when creating
roles and validates it on existing roles; a mismatch is reported, never silently changed. AWS's default role
session limit would reject production's four-hour request, so a shorter proof is not sufficient.

The roles:

- `ci-kit-ec2-launcher`, the runtime launcher. It can:
  - `ec2:RunInstances`, with the AMI owned by this account and pool-tagged, subnets and security group restricted
    to the pool's own, no instance profile, and request tags `ci-kit-pool=ec2` plus
    `ci-kit-purpose=job|smoke` on instance and volume resources;
  - `ec2:CreateTags`, only with `ec2:CreateAction=RunInstances`;
  - `ec2:TerminateInstances` and `ec2:DeleteVolume`, on resources tagged `ci-kit-pool=ec2` only;
  - read with `ec2:Describe*` (instances, images, instance types, type offerings, zones, spot price history, volumes)
    and `servicequotas:GetServiceQuota`, region us-east-2;
  - `s3:PutObject` and `s3:GetObject` on the report bucket's `reports/` prefix;
  - `ce:GetCostAndUsage`.
- `ci-kit-ec2-bake`: read and terminate rights for pool builders, plus `RunInstances` for Canonical-owned AMIs
  (`099720109477`) or this account's pool-tagged AMIs, with `ci-kit-purpose=builder` required on instance and
  volume resources. It cannot launch job or smoke instances, even from an owned pool image. Smoke and real-job
  launches use `ci-kit-ec2-launcher`, which cannot use a Canonical AMI. The bake role also has `CreateImage`,
  `CreateTags` on images and snapshots, `DeregisterImage`, `DeleteSnapshot` and `DescribeSnapshots` on the pool's
  tagged images and snapshots.
- `ci-kit-ec2-guard` is trusted by GitHub's OIDC provider instead (The guard).
- `ci-kit-ec2-fis`, trusted by `fis.amazonaws.com` and allowed only `ec2:SendSpotInstanceInterruptions` on
  pool-tagged instances. It exists for Acceptance 6's synthetic interruption, which CI-opt starts with `ci-kit-ops`.

The bake role also gets `ssm:GetParameter` on Canonical's public Ubuntu AMI parameters, which it reads to find its
builder's base image.

The launcher and the bake share one Google identity. Two AWS roles keep each call's rights narrow, but they are not
an isolation boundary: that identity can assume either. The strongest alternative was a separate service account
for the bake. It lost because GCE's side already shares the account; the extra rights are pool image management
and launching a Canonical image only as a pool builder, not unrestricted image launches.

**One-time setup** is `ec2/setup.sh`, run once per account: it takes that account's `ec2.json` entry and an
operator profile for that account (`ci-kit-ops` for 290475840169). It is idempotent: it creates what is missing,
changes nothing that exists unless asked, and prints what it did. It refuses when the profile's account differs
from the entry's. In that account, it sets up:

- the Spot service-linked role `AWSServiceRoleForEC2Spot`, without which the first spot launch fails;
- a security group `ci-kit-pool` with no inbound rules, in the default VPC;
- the report bucket `ci-kit-ec2-reports-290475840169`, with public access blocked and a 7-day lifecycle on
  `reports/`;
- the four roles and their policies, validating the launcher and bake roles' 14400-second maximum sessions,
  and the FIS experiment template for Acceptance 6;
- GitHub's OIDC provider (`token.actions.githubusercontent.com`), for the guard.

Setup validates these launch-purpose/image restrictions on existing roles, as it validates MaxSessionDuration;
policy drift is reported, not silently mutated. It also proves the federated launcher's billing access before
M6 enables preference (The billing reading). The runtime roles get no IAM rights.

### The EC2 job VM

One `RunInstances` per allocation:

- **Image:** the newest AMI tagged `ci-kit-ready=true` and `ci-kit-pool=ec2`.
- **Placement:** the candidate's subnet, and through it the zone. Public IPv4 on: GitHub needs egress, and a NAT
  gateway (~$33/month before data) costs more than the pool.
- **Root disk:** encrypted gp3 of the configured size (M1 sets it from the AMI's written data; 50 GB today),
  `DeleteOnTermination=true`.
- **Market:** one-time spot, `InstanceInterruptionBehavior=terminate`.
- **Shutdown:** `InstanceInitiatedShutdownBehavior=terminate`. The guest's ordinary poweroff then removes the
  instance and its disk, so no stopped VM keeps billing for a volume.
- **Metadata:** `HttpTokens=required`, `HttpPutResponseHopLimit=1` (the job container cannot reach it), IMDS IPv6
  off.
- **Instance profile:** none.
- **Tags:** `ci-kit-pool=ec2`, `ci-kit-alloc=<id>`, `ci-kit-repo=<owner>--<repo>`, `ci-kit-cpus=<n>`, applied to
  the instance and its volume at creation, together with `ci-kit-purpose=job` and
  `ci-kit-deadline=<launch + max_run_minutes + 15 min, RFC 3339>`. The guard deadline is later than the guest
  deadline; builder and smoke deadlines are defined under The guard.
- **`ClientToken`:** the allocation id plus the attempt number. A subnet is named, so the token's idempotency is
  zonal. Before sending, the row records zone, client token and send time. A token is never reused in another
  zone or provider. A try in another zone is a new attempt with a new token. A race between providers gets a new
  allocation and a new JIT runner, as GCE races do today (`logic.mjs`, race).

**User-data** is JSON, not a script, so nothing on the VM executes launch input:

```json
{"v":1,"alloc":"<id>","jit":"<encoded JIT config>","deadline":"<RFC 3339, launch + max_run_minutes>",
 "report":{"boot":"<presigned PUT url>","notice":"<presigned PUT url>","exit":"<presigned PUT url>"}}
```

M5 checks its size against EC2's 16 KB user-data limit. The JIT config is the large part.

The AMI disables cloud-init's user-data handling, so a JIT config is never written to cloud-init's logs or caches,
and boots like the GCE image's fast path. A baked systemd unit, `ci-kit-ec2-job.service`, the EC2 counterpart of
`gce/vm/ci-kit-gce-job.service`:

1. takes an IMDSv2 token and reads the user-data;
2. arms a host deadline timer at `deadline` that powers off;
3. starts the same runner container with the JIT config, exactly as `gce/vm/job.mjs` does on GCE (firewalled from
   metadata, non-root, no Docker socket);
4. polls `spot/instance-action` every 5 s. On a notice, it uploads a report with the notice time and stops nothing:
   a short job may finish in the two minutes;
5. on the container's exit, uploads `exit:<code>` with its timings, then powers off, whatever the outcome. A unit
   failure before the container starts also uploads a failure report and powers off.

The GCE job path changes only by moving its shared pieces (the container start and the metadata firewall) into a
module both units use.

**The guest's report.** EC2 has no writable equivalent of GCE's guest attributes. The VM PUTs small JSON
objects to the presigned S3 URLs in user-data: `reports/<alloc>/boot.json` when the container starts,
`notice.json` for an interruption notice, and `exit.json` at the end. They carry stage timestamps and the final
`exit:<code>` or `failed:<stage>` outcome. The launcher reads them by allocation id in its tick.

Reports have three meanings: `telemetry` (boot stages or a notice), `claimed` (a guest's claim signal), and
`terminal` (the exit object, including failure before a container starts). Only terminal evidence counts as
“the runner has taken its job” for report-driven coverage exclusion and retirement, as GCE's single terminal
`ci-kit/job` report does today. Boot or notice alone never marks a runner claimed or triggers cleanup. A guest
claim signal is nonterminal information, not retirement authority; the provider retains it in the nonterminal
telemetry channel if supplied. This guest emits boot, notice and exit only, not a separate claimed signal.
Independently, GitHub jobs, busy runners and recorded jobs still establish claims as today; terminal evidence
continues to establish report-driven coverage exclusion and retirement.
`readReports` separates telemetry from the optional terminal object; consumers never test the truthiness of the
whole bundle. Contract tests cover boot-only and notice-only bundles as well as terminal reports.

Presigned URLs need no credentials on the VM, and no instance profile is reachable from the host. The strongest
alternative was a write-only instance profile. It lost because it puts AWS credentials on every job VM for no
added function. A missing terminal report is **unknown**, never success; telemetry is not a substitute.

**Interruptions.** A notice is reported by the guest. An instance that vanishes with state reason
`Server.SpotInstanceTermination`, with or without a notice, is finalized `preempted` with the job its runner held,
as on GCE (`docs/pool.md`, Preemption).

### Provider-bound allocations

Opening an allocation for instance P synchronously acquires both its global vCPU reservation and its
`(repo, provider, account)` cap reservation in admission, before any asynchronous work: ledger write, JIT mint
or cloud call. This applies to queued launches, pre-launch speculation, races and fallback alike. Both budgets
count the ledger's non-final rows and this tick's in-memory reservations, keyed by allocation id so writing a
reserved allocation's row does not count it twice. `reserved` is physical vCPUs, the largest candidate the
allocation may try on its instance, not the demand's logical size.

The scheduler then mints a JIT registration with P's name pattern and labels and walks only P's candidates in
the placement order. The ledger's launching write precedes the cloud request, as today. One JIT across a
cross-provider walk is rejected: GitHub fixes its labels when it is minted, so a GCE fallback would otherwise
advertise `ci-kit-ec2`.

| Event | Allocation and next action |
|---|---|
| P accepts | Keep P's allocation; record running when observed. |
| Every eligible candidate of P refuses definitely (capacity, quota, denied or throttled) | End P's allocation `refused`, remove its JIT registration at once, release both reservations, and admit a new allocation on the next eligible instance in the same tick. |
| Launch is uncertain | Keep its allocation, registration and both reservations until reconciliation; EC2 resolves by observation or abandonment under the bounded rule below, never request replay. |
| A slow launch is raced | Admit the race with its own allocation, registration and both reservations; skip a capped instance and walk the repo's next eligible instance. Never reuse or relabel the original. |

A definite refusal releases both reservations before the fallback acquires its own; every final row releases
both. An uncertain launch keeps both. Fallback is fresh admission, not a transfer of the previous amount: a
size-2 demand falling back to GCE's `c3d-highcpu-4` needs 4 physical vCPUs and must pass both budgets anew. A
capped instance is skipped; no allocation opens without enough global room. Races use the same admission,
with the original's reservation still held.

One speculative demand occupies one pre-launch slot, regardless of how many fallback or race allocations it
opens. A definitely refused allocation occupies none. `prelaunch.group` on the rows persists that demand's
identity across accounts, clouds and restarts (Ledger rows and cost); this slot grouping does not combine their
vCPU reservations, which remain per allocation.

The walk still keeps all spot groups ahead of GCE standard. A later return to GCE standard after its spot group
and EC2 refused opens a fresh GCE allocation, not a resurrection of a refused one. Provider-only demand skips
other providers. A crash between refusal and unregister is covered by the existing no-VM-after-5-min orphan
runner rule, extended to `ci-kit-ec2-*`; it acts only on known inventory and never removes a busy runner.

**Uncertain EC2 launches resolve without replay.** The row holds `zone`, `client_token` and `sent_at` before
`RunInstances` is sent. It never holds the launch request: that request contains the JIT configuration and
presigned URLs, which are secrets. Every tick reconciles with `DescribeInstances` by `ci-kit-alloc` tag and by
client token in the recorded zone. An instance found there moves the row to running. If successful observation
still finds none 10 min after `sent_at`, the allocation ends `abandoned`, releases both reservations and removes
its JIT registration. Describe consistency is seconds; 10 min gives it ample time without retaining a lost
request forever. Unknown inventory still prevents finalization under the earlier rule.

This reconciliation reads only the row and AWS, so it survives a restart whether the request never arrived or
AWS accepted it but the response was lost. It never replays `RunInstances`. The five-minute orphan-runner rule
does not remove a still-uncertain allocation's registration inside this ten-minute window. If a VM materializes
after abandonment, its row is final and the guard reaps it under the final-row predicate. Its JIT registration
has been removed, so it cannot take a job.

### Failure classes on launch

The EC2 provider maps each launch result to the outcomes below. GCE's existing refusals, accepted inserts and
unknown inserts are adapted to this contract; its current internal outcome names are not this public API.

| EC2 result | Outcome | Scheduler does |
|---|---|---|
| instance id returned | `accepted` | Row → `running` once the instance shows. |
| `InsufficientInstanceCapacity`, `SpotMaxPriceTooLow`, `Unsupported` for the zone | `capacity` | Remember the candidate as stocked out for 5 min; try the next candidate. |
| `MaxSpotInstanceCountExceeded`, `VcpuLimitExceeded` | `quota` | Scope `ec2/<account>/us-east-2/spot-standard-family` for this tick; no spot candidate of that account, of any size, is tried again this tick; continue to the next eligible provider under a new allocation. |
| `UnauthorizedOperation`, `AuthFailure`, an STS failure | `denied` | Log loudly. That account is off for 10 min, a misconfiguration and not a stock-out. Continue to the next eligible provider under a new allocation. |
| `RequestLimitExceeded` | `throttled` | Back off EC2 for this tick; continue to the next eligible provider under a new allocation. |
| Timeout or transport error | `uncertain` | Reconcile by observation in the recorded zone; when a successful observation finds none 10 min after send, end abandoned and unregister. Never replay or reuse across zones/providers. |

### The image and parity

The EC2 image is an AMI built by the same bake run that builds the GCE image, from one **bake manifest** resolved
once at the start of the run:

- the ci-kit commit;
- the exact Node versions, since `pool/bake/prepare.sh` resolves the latest of each major at bake time, so two
  bakes could otherwise differ;
- the MAWS revision and lockfile hash the warm step uses;
- the runner version.

Each image records the manifest and its warm results: as image labels on GCE, as AMI tags plus a file at
`/etc/ci-kit/bake-manifest.json` on both.

The EC2 bake:

1. through the federated bake role, launches a short **on-demand c8a.2xlarge** builder from the current Ubuntu
   24.04 x86-64 AMI (Canonical's SSM parameter), with `ci-kit-purpose=builder` and shutdown behaviour **stop**;
2. runs the provider-neutral preparation (`pool/bake/prepare.sh` and the warm step), with the builder's EC2-specific
   steps in their own script beside `gce/bake/builder.sh`;
3. after the builder stops, runs `CreateImage`, tags the AMI unready, and terminates the builder;
4. through the federated launcher role, runs the smoke suite (`gce/vm/smoke.sh`, made provider-neutral where it
   reads metadata) on a smoke VM from the new AMI;
5. through the same launcher role, runs one real job on ci-kit-sandbox;
6. only then tags the AMI `ci-kit-ready=true`.

M1 found that one-time spot with interruption behaviour `terminate` rejects
`InstanceInitiatedShutdownBehavior=stop`. The builder must stop for CreateImage, so it uses on-demand under the
32-vCPU standard quota. Job VMs remain spot with shutdown=terminate; this builder exception does not add
on-demand scheduler candidates. M5 proves the builder launch with the federated bake role, not the operator's
broader `ci-kit-ops` credentials.

It keeps two ready generations. An older AMI is deregistered and **its snapshots deleted**: deregistering alone
keeps paying for the snapshot.

No temporary token, JIT config or instance identity may remain in the AMI. The bake clears cloud-init's state and
logs and any credential file the warm step used, and smoke asserts their absence.

The bake runs where the GCE bake runs: the Cloud Run job `ci-kit-bake` on its schedule (`gce/deploy.sh`, bake). It
gains an `ec2` stage after the GCE stage, run for each configured account from the same manifest. Either stage failing leaves that provider's previous ready image in
service. `.github/workflows/pool-bake.yml` is Hetzner's and is not the place.

### Ledger rows and cost

Rows gain a schema version and a provider. Rows without a version read as v1 GCE rows, so nothing already written
is rewritten. New fields:

- `provider`;
- `account` (the GCP project or the AWS account);
- `region`, `zone` and `zone_id`;
- `instance_id`, the cloud's id, distinct from the runner name;
- `image` and its manifest's ci-kit commit;
- `price` with its source and time;
- `client_token` and `sent_at` (EC2), persisted with the attempt's zone before sending, so reconciliation
  survives a restart without storing the secret-bearing request;
- `credit_policy`: `on` or `off` when placed.

Provider exhaustion gains the final end reason `refused`; existing reasons keep their meanings. An uncertain
EC2 attempt that remains absent at its ten-minute reconciliation limit uses the existing `abandoned` reason.
The job record also gains `labels` and `required_provider`, derived from those labels, for coverage and
pre-launch shapes.
Each non-final row retains `reserved` against both the global budget and its `(repo, provider, account)` cap;
a failed running write must not erase either reservation. A final row releases both.

M4 adds `prelaunch.group` to the existing `prelaunch` object: the first allocation's id for one speculative
demand. Every fallback and race descendant persists the same `{run, attempt, workflow, group}`, even when the
first allocation is refused. Different demands of the same run and size have different groups. `race.of` keeps
its existing meaning (the allocation whose slow launch is raced); it is not a fallback link. `prelaunchedFor`
counts distinct groups per repo, run, attempt and logical size among rows whose end is neither `refused` nor
`abandoned`. Other final rows still count as served, as today. A group with no such row occupies no slot, so an
all-refused speculative demand can be retried next tick. For old rows without `prelaunch.group`, retain today's
grouping: an original uses `alloc`, a race uses `race.of` with `race.demand`'s run and attempt. No old rows need
rewriting; the explicit group on each new descendant survives even without its original row.

Cost per row comes from the provider: GCE's formula as today (`gce/launcher/ledger.mjs`); EC2's from that zone's
spot price at launch, per second with a 60 s minimum, plus gp3 GB-seconds and public IPv4 time. An EC2 compute
charge waived for a provider interruption is recorded as such
(`price.source: interrupted-free`); disk, IPv4 and initialization charges are not erased with it.

If M1 selects provisioned EBS initialization, its per-volume charge is a candidate price input and enters the
row cost at volume creation. It is charged on the snapshot's full data size even if the volume is deleted early,
including failed boots and idle runners. M1 must report cost per job and how much of the $20 margin this option
uses before promoting it; otherwise plain gp3 or prefetch avoids that charge.

The reports gain a provider column. The cost report adds, for EC2, the credit-funded estimate and the AWS
billing reading (Acceptance 8). Row costs never update that reading or drive credit preference.

### The guard

GCE enforces a VM's run limit itself (`maxRunDuration`). EC2 has no equivalent, so two independent mechanisms
replace it: the guest's deadline timer, and a guard that does not depend on the launcher or the guest.

Every live EC2 pool instance and its volume carries `ci-kit-purpose=job|builder|smoke` and
`ci-kit-deadline=<RFC 3339>` at creation, as well as `ci-kit-pool=ec2`. Deadlines are launch plus
`max_run_minutes + 15 min` for a job, 2 h for a builder, and 30 min for smoke. These deadlines do not apply to
AMIs or snapshots: promoted images must survive the builder that made them.

The guard is an EC2 job in `.github/workflows/pool-guard.yml` on `ubuntu-latest`, scheduled every 15 min, with
one matrix leg per account in `ec2.json`, including disabled accounts. An absent file yields no EC2 legs.
One account's failure does not stop another account's leg. Each leg
assumes that account's `ci-kit-ec2-guard` through GitHub's OIDC, trusted only for
`repo:SSFSKIM/ci-kit:ref:refs/heads/main`. It lists pool resources and the ledger, then applies predicates by
purpose, not one broad “stopped pool VM” rule:

- Any live instance or volume past its deadline is reaped (terminate its instance before deleting its volume).
- A `job` instance is also reaped if its ledger row is final, if stopped, or if it has no ledger row 15 min
  after launch. The final-row rule catches a VM materializing after its uncertain allocation was abandoned.
  Shutdown is terminate for jobs, so stopped is wrong. Unattached job volumes are removed.
- A `builder` or `smoke` instance or volume is never reaped before its deadline, stopped or not. In particular,
  a stopped builder waiting for CreateImage is protected.
- Unready AMIs older than a day are deregistered with their snapshots deleted. The newest two ready generations
  are retained; older ready generations and their snapshots are removed by the image policy.

It never acts without the pool tag, or on what a failed list would have covered. For example, a failed ledger
read cannot establish “no row,” and a failed instance list cannot establish that a volume is orphaned. It names
every action in its log. Tests and a live check exercise a stopped, not-yet-imaged builder. The existing Hetzner
job and its 10-minute cadence stay unchanged; the EC2 schedule is distinct within the workflow.

The guard role can describe EC2 resources and terminate, deregister or delete pool-tagged ones. It cannot launch
anything.

## Plan of Work

Constraints for every milestone:

- AWS is reached with the aws CLI or the AWS SDK for JavaScript v3 only (`@aws-sdk/client-ec2`, `client-sts`,
  `client-s3`, `client-cost-explorer`, `client-service-quotas`, `client-ssm`, plus `@aws-sdk/s3-request-presigner`). No AWS MCP
  servers, toolkits or agent skills.
- Account 290475840169, EC2 region us-east-2. Cost Explorer alone uses `ce.us-east-1.amazonaws.com`, signed
  for us-east-1; its account-policy access was verified on 2026-10-23. Other EC2 regions remain out of scope.
- Spot vCPU quota is 256 as verified at M2 preflight on 2026-10-23 with
  `aws service-quotas get-service-quota --service-code ec2 --quota-code L-34B43A08` in us-east-2. Keep live
  fixtures bounded by their proof and the $25 pre-M6 spend cap rather than filling the expanded quota. The
  on-demand standard quota is separately 32 vCPUs; the short on-demand builder uses that quota, not the spot grant.
- Deploys run from a fresh clone of merged `main` only: `gce/deploy.sh <target>`. Secret Manager is not written.
- The launcher's GCE behaviour with EC2 off is the regression bar for M2–M6 (Acceptance 9).
- ci-kit's MacBook `npm test` has host-dependent `mac-*` failures (friction tracker #68). Judge the work by
  ci-gate and by the touched test files.

### M1 — The measurement spike (prototype; its deliverable is a verdict)

**Questions.**

1. How long from `RunInstances` to "runner listening" on c8a.2xlarge spot from a warmed AMI, p50/p90 over at
   least 10 launches across at least 2 zones? GCE C4D's figure comes from its ledger and latency report.
2. How much does hydration cost? Measure MAWS's unit shard on a cold volume, then again on the same VM after
   dropping the page cache (`echo 3 > /proc/sys/vm/drop_caches`), and record disk reads and iowait beside wall time.
   If the cold run's penalty exceeds 20 s, add an arm with EBS volume initialization at a provisioned rate (100–300
   MiB/s, billed per GiB) and one with a targeted prefetch of the pnpm store and toolchains. Count a prefetch's time
   in the end-to-end figure.
3. How long does one MAWS unit shard take on c8a.2xlarge against c4d-highcpu-8: the same MAWS commit, the same
   command and the same warm image contents, at least 5 runs each?
4. Does federation work as designed: a Google ID token for the launcher's account, its real `sub`/`azp`/`aud`
   claims, and `AssumeRoleWithWebIdentity` requesting 14400 s succeeding against a role with the trust policy
   and maximum session duration above?

**What to build.** Run `ec2/setup.sh` for the pieces the spike needs: the Spot service-linked role, the security
group and a spike role. Hand-bake one AMI from the bake steps; the full bake job comes in M5. A script,
`ec2/spike/`, launches instances, records the stage timestamps from inside the guest, and runs the MAWS unit
command in the runner container, as the bake's warm step runs MAWS. The same script runs the C4D arm on GCE from
the current ready GCE image. Prove federation from the MacBook by impersonating the launcher's service account:
`gcloud auth print-identity-token --impersonate-service-account=… --audiences=… --include-email`.

**Known discovery:** one-time spot with interruption=terminate cannot use shutdown=stop; the builder uses
on-demand as specified under The image and parity. The performance and disk verdict is still to be measured.

**Verdict.** Record in Surprises & Discoveries:

- per-stage medians and tails;
- the hydration penalty and the disk choice it implies: plain gp3, or provisioned initialization, or prefetch;
- the unit-job ratio;
- the token claims;
- the zone order for `ec2.json`;
- the AMI's written snapshot size, which sets the disk size and the snapshot cost.

**Promote** the disk configuration and zone order into M5. If provisioned initialization wins, include its
per-job charge on the full snapshot data size and the share of the $20 margin it consumes (Ledger rows and cost).

**Escalate** to the owner before M2 if EC2's end-to-end per-job time, from queue to job end with the chosen disk
configuration, is above 1.25× GCE C4D's. Credit-first would then slow MAWS's CI, which the owner did not choose to
trade. Discard the spike scripts once M5's bake and provider exist; the verdict stays.

**Touches:** `ec2/setup.sh` (new, partial), `ec2/spike/` (new, deleted after M5). Nothing in the launcher.

**Proves:** nothing in Acceptance directly. It decides the inputs M5 and M6 depend on.

### M2 — Data contracts, no behaviour change

**At its end:** ledger v2 reads and writes provider-qualified rows while v1 rows still read as GCE. `Candidate`
and `Instance` carry logical size and labels independently of physical vCPUs. Stock-out and quota keys include
provider and account. The existing GCE launcher still supplies all effects and makes the same decisions.

**Touches:** `gce/launcher/ledger.mjs`, `ledger-store.mjs`, `logic.mjs`, `room.mjs`, the contract definitions under
`gce/launcher/providers/`, and `test/gce/`. The contract shapes in Interfaces are produced here; provider effects
are not yet extracted. The scheduler will read region, family and vCPUs from candidates rather than deriving
them from GCE names once M4 consumes this boundary.

**Does not touch:** scheduling behaviour, pre-launch, cloud calls, guest code, EC2, billing or guard behaviour.

**Proves:** v1 reads and v2 round trips, provider-qualified keys without changed GCE refusal behaviour, and
GCE's `c3d-highcpu-4` mapping to both logical sizes 2 and 4 with 4 reserved physical vCPUs. EC2 attempt fields
round-trip zone, client token and send time without a stored launch request. Existing tests remain
green (Acceptance 9). Concrete Steps runs focused checks and the committed-head gate.

### M3 — GCE effects behind the provider, no behaviour change

**At its end:** `createProvider` for GCE owns observe, launch, reconcile, terminate, reports and orphan cleanup.
The existing scheduler uses those effects without changing its admission or placement behaviour. GCE's single
terminal guest report is adapted to the separated report contract, not confused with nonterminal telemetry.

**Touches:** `gce/launcher/launcher.mjs`, `server.mjs`, `room.mjs`, `lib/gce.mjs`, new
`gce/launcher/providers/gce.mjs`, and contract and regression tests under `test/gce/`. It consumes M2's types and
ledger and produces the operational `Provider` for M4. Room is provider-owned and consulted through that boundary.

**Does not touch:** cross-provider scheduling, EC2 calls, VM images, credit preference or the guard.

**Proves:** pending-launch reservations across restarts and failed writes, races, partial inventory, cleanup and
report-driven retirement retain GCE behaviour (Acceptance 9). Contract tests pin boot-only and notice-only
bundles as nonterminal and non-claiming. A merged-main launcher deploy runs a MAWS class 1a run green with v2 GCE
rows. Concrete Steps distinguishes that deployment from the run that proves it.

### M4 — The scheduler over providers

**At its end:** the scheduler admits mixed provider-labelled demand and can fall back between providers in one
tick without reusing an allocation or JIT registration. Each job walks its repo's provider list (Each repo's
providers), with per-instance caps and credit demotion as a policy input. `gce.json`'s parser accepts
`repos[].providers`; absent means GCE alone. Fake providers prove this before AWS effects are introduced,
including two instances of one kind in different accounts. With only GCE configured, existing observable
behaviour is unchanged.

**Touches:** `gce/launcher/launcher.mjs`, `logic.mjs`, `prelaunch.mjs`, `ledger.mjs`, `ledger-store.mjs`,
`config.mjs` (including the EC2 accounts schema), `source.mjs`, provider contract tests and scheduler tests under
`test/gce/`. It consumes M3's GCE provider and M2's data contracts and produces the multi-provider scheduler and
config loading used by M5. Walk order is an explicit policy input here; durable billing comes in
M6. Coverage, unknown inventory and allocation transitions follow Design, not the old repo/size implementation.

**Does not touch:** AWS clients, EC2 images or setup, live credit accounting, reports or the guard.

**Proves:**
- Mixed generic, GCE-only and EC2-only demand in one repo/size consumes runner and pending-allocation coverage
  once, most constrained first; restricted demand walks only its own provider.
- Pre-launch shapes preserve required provider and speculate only for generic demand.
- Unknown EC2 inventory retains every non-final row's recorded reservation, including failed running writes;
  online idle GitHub runners cover, busy runners do not; GCE continues within the global budget. No EC2 launch,
  termination or finalization occurs, unseen rows stay non-final even beyond the cache window and across
  restarts, and a 30-minute outage logs once.
- Definite refusals fall back in both directions in one tick with fresh allocations and correct labels;
  refused registrations are removed immediately, and the 5-minute orphan rule catches a crash. Uncertain
  allocations and races retain their own registrations and reservations (Acceptance 3).
- GCE-only behaviour, including pending launches, races and cleanup, remains green (Acceptance 9).
- Each repo's providers, as in Acceptance 11's tests. Parser failures are exactly the reference/cap cases in
  Each repo's providers, not disabled instances or an absent EC2 file. The walk applies list order, demotes a
  credit instance whose preference is off, and keeps refusal memory and unknown-inventory holds per instance.
- Config transitions through the real config source with fake providers: start with lists referencing EC2,
  set top-level `enabled: false`, then delete the file. Disabling takes effect instead of the last good enabled
  config: generic demand falls back to listed GCE, no new EC2 allocation opens, and existing EC2 allocations
  retain reservations and coverage and are observed, reconciled, terminated and reported. Deletion gives the
  same launch behaviour, logs the skipped EC2 entries once per config load, and holds non-final rows under
  Unknown EC2 inventory instead of managing them. Also prove account-level disable leaves other accounts eligible.
- Concurrent admission: two 8-vCPU demands in one tick against one instance's 8-vCPU repo cap admit exactly one
  there, even with its first ledger write delayed. Exercise queued and speculative demand; the second walks the
  next eligible instance. A row appearing in the ledger does not double-count its in-memory reservation.
- A race at its original instance's cap skips it and walks the repo's next eligible instance, under both budgets.
  An uncertain launch retains both reservations; a definite refusal releases both before fallback admission,
  and finalization releases both. Fallback to `c3d-highcpu-4` for size 2 reserves 4, not 2: prove it fits when
  the global budget has 4 free and waits when only 2 remain.
- Pre-launch slots: after every provider refuses, the next tick retries the unfilled demand. In a partial batch,
  one demand's successful fallback to another account fills exactly one slot; only unfilled demands are retried.
  Repeat both cases across a restart from persisted rows. Include race descendants sharing `prelaunch.group`
  with their original and fallback, and prove refused rows occupy no slot.

### M5 — The EC2 provider, its image and its setup, serving the sandbox

**At its end:** `ec2/setup.sh` is complete; the bake builds, smokes and promotes an AMI beside the GCE image from
one manifest. `ec2.json` configures one account, 290475840169, with `credit.enabled: false`. Only
`SSFSKIM/ci-kit-sandbox`'s provider list names it: EC2, then GCE. With the preference off, the sandbox's generic
demand still walks GCE spot first. Sandbox jobs explicitly labelled `ci-kit-ec2` exercise EC2 before the billing
reader exists. MAWS and manim-master list nothing and place on GCE alone. Live, a sandbox VM runs a job and
terminates itself.

**Touches:** new `gce/launcher/providers/ec2.mjs` (one instance per configured account), `lib/aws.mjs`,
`pool/config/ec2.json`, using M4's `accounts` parser; `pool/config/gce.json`'s sandbox entry;
`ec2/vm/` and the container-start pieces shared with `gce/vm/job.mjs`; `gce/bake/bake.mjs`'s EC2 stage and its
builder beside `gce/bake/builder.sh`; `gce/vm/smoke.sh`; `ec2/setup.sh`; and tests under `test/ec2/`. It consumes M1's disk/zone verdict and M4's scheduler and produces
EC2's `createProvider`, `awsCredentials`, the AMI and config for M6.

**Decisions owned here:** the EC2 provider observes only pool-tagged instances. A test double of the EC2 API,
in the style of `test/gce/fake-gce.mjs`, exercises the launch failure table and the report contract. Purpose and
deadline tags are applied now, before M6's guard consumes them. User-data obeys the defined shape and 16 KB limit.
Setup creates and validates 14400-second launcher/bake roles and the IAM-enforced purpose split: bake launches
builders only (Canonical or owned pool AMIs); launcher launches jobs/smokes only (owned pool AMIs).
The Cost Explorer client uses its explicit endpoint and signing region, not the EC2 client's region. Setup runs
per account and refuses a profile whose account differs from the entry's. The bake's EC2 stage runs per account.
Provider construction, federation audiences and credential caches are per account. Parser and provider tests
use two accounts, while the live proof uses one.

**Does not touch:** the billing preference, report aggregation or guard (M6), or MAWS's placement.

**Proves:** Acceptance 1, the recovery tests in 3, 4 and 10, and Acceptance 11's M5 live part. The live on-demand Canonical builder launch uses
the federated bake role,
with a 14400-second session. Live RunInstances dry-runs prove allowed/refused image-purpose combinations below.
Tests pin setup's report of existing role-duration or launch-policy mismatch without mutation;
restart after a request that never arrived (abandoned at 10 min, reservation released and JIT removed);
restart after an accepted request whose response was lost (found by tag/token, row running); no secret request
persistence, replay or token reuse in another zone/provider; registration retained through the reconciliation
window despite the five-minute orphan rule; and the unknown-inventory hold on abandonment.
Boot-only and notice-only reports neither claim nor retire;
`exit` upload and poweroff on every exit path, including a container that never starts; missing terminal evidence
is unknown; the job container cannot access IMDS (smoke). If M1 promoted provisioned initialization, tests charge
it at volume creation for failed boots and idle runners as well as successful jobs.
Repeat M4's config-transition proof live (Acceptance 9): with sandbox lists still referencing EC2, disable it,
then remove the file. Both changes route new generic sandbox demand to listed GCE with no EC2 allocation;
disabled EC2 allocations stay managed and accounted for, while deletion logs the skip once per config load
and retains non-final reservations under Unknown EC2 inventory. Concrete Steps bounds the deletion fixture.

### M6 — Credit preference, reports, guard, MAWS canary, acceptance

**At its end:** Cost Explorer's durable reading controls preference; the reports show both clouds; the guard
runs every 15 min with purpose-aware predicates, one leg per account. The account 290475840169 has
`credit.enabled: true`, `credit.until: "2027-04-17"`, `credit.budget_usd: 180` and `credit.since` covering the
first EC2 spending, including the spike and bake. The provider lists of MAWS, ci-kit-sandbox and manim-master
name EC2, then GCE. Setup first proves a billing read under the federated launcher role at Cost Explorer's
us-east-1 endpoint; failure stops M6 and is escalated. MAWS's pool jobs then run on EC2 first while the reading
permits it.

**Touches:** `gce/launcher/` for preference and the per-account billing issue; `pool/config/gce.json`'s repo
lists; `gce/cost-report.mjs` (new;
`ledger.mjs` already aggregates row estimates), `gce/latency-report.mjs`; `.github/workflows/pool-guard.yml` and
new `ec2/guard.mjs`; `docs/pool.md`. It consumes M5's AWS client, EC2 provider, tagged resources and image.

**Does not touch:** c8g/ARM, more instance families, EC2 on-demand job placements or automatic reruns.

**Proves:** Acceptance 2, 5, 6, 7, 8 and 11's M6 live part. Tests pin per-account billing issues and preference,
guard legs that fail independently, a missing billing issue, stale reading, immutable overlapping
writes (an older write lands last, then a fresh reader still chooses the newer `read_at`), pruning to the newest
20, no refresh with a fresh stored reading across restarts, and that finalizing rows cannot change policy spend.
Guard tests exercise every purpose, failed lists, a stopped builder awaiting CreateImage and a late VM whose
row is final. A failed federated billing proof prevents credit-first activation. Then run the full gate and
every Acceptance item as written in Concrete Steps, retaining the live run, allocation and image ids with their observations.

## Concrete Steps

These commands are proofs to run as their owning milestones land, not claims that acceptance has run already.
Angle-bracket ids come from the run or resource being checked. AWS commands use account 290475840169 through
`ci-kit-ops` in us-east-2; GCP commands name `ssfskim-ci-kit`. Every block names its working directory.

### Tests (M2–M6; Acceptance 3 and 9 and the milestone contracts)

In the ci-kit implementation worktree, install dependencies before a focused test (coverage logic below). Run the full suite off-host
through ci-kit's own `bin/ci-gate`, which tests committed HEAD, not uncommitted changes. `test/ec2/` exists from
M5; before that the scheduler's second provider is a fake under `test/gce/`.

    cd /private/tmp/ci-kit-ec2
    npm ci --no-audit --no-fund
    node --test --test-timeout=15000 test/gce/launcher-logic.test.mjs
    bin/ci-gate . --gates test
    # expect: the focused test passes; PASS test, then GREEN <run-url> from the remote gate

### Setup and deployment produce the system, not acceptance evidence (M3, M5, M6)

Deploy only from merged `main`. Create a fresh clone once, and use it for all following deploy and observation
blocks. The EC2 setup and bake commands apply from M5; M3 deploys only the extracted GCE launcher.

    cd /private/tmp
    git clone --branch main https://github.com/SSFSKIM/ci-kit /private/tmp/ci-kit-deploy
    cd /private/tmp/ci-kit-deploy
    npm ci --no-audit --no-fund
    AWS_PROFILE=ci-kit-ops AWS_REGION=us-east-2 ec2/setup.sh
    # expect, on a second setup run: "setup: nothing to change"
    gce/deploy.sh launcher
    gce/deploy.sh bake

A successful `deploy.sh bake` only deploys the producer. Execute it and wait; `us-central1` is `REGION` in
`gce/deploy.sh`. Then inspect the ready image and both smoke results, not just the deployment's exit code.

    cd /private/tmp/ci-kit-deploy
    gcloud run jobs execute ci-kit-bake --project ssfskim-ci-kit --region us-central1 --wait
    AWS_PROFILE=ci-kit-ops AWS_REGION=us-east-2 aws ec2 describe-images --owners self --filters Name=tag:ci-kit-pool,Values=ec2 Name=tag:ci-kit-ready,Values=true --query 'Images[].{id:ImageId,created:CreationDate,tags:Tags}'
    # expect: execution succeeded and a ready AMI from this bake, not merely an older ready generation

### Federation and image evidence (M5; Acceptance 1 and 10)

    cd /private/tmp/ci-kit-deploy
    gcloud secrets list --project ssfskim-ci-kit --format='value(name)'
    gcloud run services describe ci-kit-launcher --region us-central1 --project ssfskim-ci-kit --format='yaml(spec.template.spec.containers[0].env)'
    gcloud logging read 'resource.labels.service_name="ci-kit-launcher" AND jsonPayload.message:"aws: assumed"' --project ssfskim-ci-kit --limit 3 --format='value(jsonPayload.message)'
    # expect: no AWS credential secret or key environment variable; "aws: assumed <role> until <time>"
    AWS_PROFILE=ci-kit-ops AWS_REGION=us-east-2 aws ec2 describe-images --image-ids <ami-id> --query 'Images[0].Tags'
    gcloud compute images describe <gce-image-name> --project ssfskim-ci-kit --format='json(labels)'
    gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="ci-kit-bake" AND labels."run.googleapis.com/execution_name"="<execution-name>"' --project ssfskim-ci-kit --order asc --format=json

Compare the manifest fields named in Acceptance 10, then identify both GCE and EC2 smoke logs in that bake's
output. Both must say the common suite passed; image tags alone do not establish smoke parity. A successful EC2
sandbox job and its ledger row complete the runtime proof. Read the bake's builder launch and STS evidence too:
it must use `ci-kit-ec2-bake` with a 14400-second request and launch Canonical's base AMI as an on-demand builder.
An operator-launched builder is not this proof.

    cd /private/tmp/ci-kit-deploy
    AWS_PROFILE=ci-kit-ops aws iam get-role --role-name ci-kit-ec2-launcher --query 'Role.MaxSessionDuration'
    AWS_PROFILE=ci-kit-ops aws iam get-role --role-name ci-kit-ec2-bake --query 'Role.MaxSessionDuration'
    # expect: 14400 for each; setup reports a differing existing value without silently changing it

M5 also runs negative authorization proofs through each federated role using the exact otherwise-valid launch
inputs with `RunInstances --dry-run` (or SDK `DryRun: true`); dry-run creates no resources. Record the AWS error
code, not the CLI's nonzero status, since both authorized and unauthorized dry-runs return errors:

- bake + Canonical AMI + builder: `DryRunOperation`;
- bake + owned pool AMI + smoke: `UnauthorizedOperation`;
- launcher + Canonical AMI + job: `UnauthorizedOperation`;
- launcher + Canonical AMI + smoke: `UnauthorizedOperation`;
- launcher + owned pool AMI + smoke: `DryRunOperation`.

The builder/smoke guard deadline protections are unchanged by which role launched the VM.

Before M6 enables preference, run setup's billing proof through the federated launcher credentials, with a
14400-second STS request and Cost Explorer signing for us-east-1. The proof makes `GetCostAndUsage` for the
configured interval and records success without logging credentials. The known `ci-kit-ops` success is not a
substitute. If the federated read fails, stop M6 and escalate the access failure.

### Real jobs and overflow (M3, M5, M6; Acceptance 2, 3 and 9)

MAWS uses its own script, from a MAWS worktree at `master`, not ci-kit's checkout. Run this with EC2 disabled for
the M3/GCE regression proof, and with fresh billing and MAWS's provider list naming EC2 first for M6's canary.

    cd <absolute-MAWS-worktree>
    scripts/ci-gate.sh . --gates static,unit,probes
    gh api repos/SSFSKIM/MAWS/actions/runs/<run>/jobs --jq '.jobs[]|[.name,.conclusion,.runner_name]|@tsv'
    # expect: static, unit shards and probes success; ci-kit-gce-* in M3, ci-kit-ec2-* in M6

For M5, queue sandbox jobs labelled `ci-kit-ec2` to prove that provider before credit accounting is enabled.
In M6, a generic sandbox burst exceeding EC2's quota proves same-tick fallback with preference on; do not
exceed the live-test cap in Plan of Work. If the current quota prevents that live scenario, M4's fake-provider
refusal tests remain the deterministic proof. For a fallback, inspect one tick's log and the corresponding
ledger rows: the same demand has a refused EC2 allocation and a different GCE allocation and registration.

    cd /private/tmp/ci-kit-deploy
    gcloud logging read 'resource.labels.service_name="ci-kit-launcher"' --project ssfskim-ci-kit --freshness=1h --order asc --format='value(jsonPayload.message)'
    gh api repos/SSFSKIM/ci-kit-sandbox/actions/runs/<sandbox-run>/jobs --jq '.jobs[]|[.name,.conclusion,.runner_name]|@tsv'

### Config transitions (M5; Acceptance 9)

Use a bounded sandbox fixture with the deployed config source and its lists still naming EC2 then GCE. Keep an
EC2 allocation live while setting top-level `enabled: false`; load the changed config and submit generic sandbox
demand. Use the launcher log and ledger reads above to verify GCE placement, no new EC2 allocation, and continued
EC2 observation, reconciliation, report reads and ordinary cleanup, with reservations and eligible coverage held.
Then delete `ec2.json` for the fixture and reload: new demand still goes to GCE, the skip logs once for that load
(and not on repeated ticks), and non-final EC2 rows stay reserved without EC2 management. Use a short guest
deadline for any VM present during deletion; the guard has no legs without the file. Restore the file with
`enabled: false`, observe and clean up remaining fixtures, then restore M5's sandbox configuration. A deployment
restart alone is not this proof: the config source must see the enabled → disabled → absent transitions.

### Lifecycle and guard evidence (M5 and M6; Acceptance 4 and 5)

For a completed sandbox job, read its exit object and AWS state-transition timestamp. Compare those timestamps,
not when a polling command happened to observe termination. Inspect volumes by this allocation, since other
jobs or a bake may legitimately own pool volumes.

    cd /private/tmp/ci-kit-deploy
    AWS_PROFILE=ci-kit-ops AWS_REGION=us-east-2 aws s3 cp s3://ci-kit-ec2-reports-290475840169/reports/<alloc>/exit.json -
    AWS_PROFILE=ci-kit-ops AWS_REGION=us-east-2 aws ec2 describe-instances --instance-ids <instance-id> --query 'Reservations[].Instances[].{state:State.Name,transition:StateTransitionReason}'
    AWS_PROFILE=ci-kit-ops AWS_REGION=us-east-2 aws ec2 describe-volumes --filters Name=tag:ci-kit-pool,Values=ec2 Name=tag:ci-kit-alloc,Values=<alloc> --query 'length(Volumes)'
    # expect: terminated within 60 s of exit's job end; 0 volumes for this allocation

M5's deadline proof uses a sandbox VM with a valid JIT registration carrying a label no job uses and a test
config with `max_run_minutes: 5`. Launch it outside launcher management and observe its guest deadline and AWS
termination; neither the launcher nor the guard may cause this termination. Separately launch a fixture whose
runner never registers, keep it visible to the launcher, and give its guest deadline more than the idle limit.
Observe the launcher terminate it after 10 min. These are different fixtures: an idle runner that registered is
not proof of the never-register path.

For M6, use the provider's resolved launch inputs to hand-launch a pool-tagged `job` with no ledger row, preserving
the purpose/deadline tags. Observe a guard execution after the instance is 15 min old: within that period its
log names the instance and AWS shows termination. Keep a stopped builder before CreateImage, with its deadline
still in the future, through the same guard run; it must survive. Also present a live job VM carrying an
allocation whose row is already final, as if it materialized after abandonment; its unregistered runner cannot
take a job, and the guard must reap the VM within one period. Clean up the fixtures after observing them.

    cd /private/tmp/ci-kit-deploy
    gh run list --repo SSFSKIM/ci-kit --workflow pool-guard.yml --limit 5
    gh run view <guard-run> --repo SSFSKIM/ci-kit --log
    AWS_PROFILE=ci-kit-ops AWS_REGION=us-east-2 aws ec2 describe-instances --instance-ids <orphan-job-id> <stopped-builder-id> --query 'Reservations[].Instances[].{id:InstanceId,state:State.Name,tags:Tags}'
    # expect: orphan terminated; builder stopped, not terminated, before its deadline

### Interruption, credit and reports (M6; Acceptance 6, 7 and 8)

Target one running sandbox job with the FIS template created by setup, then read the GitHub job and ledger.
A notice without terminal evidence is not a cleanup signal; the actual interruption ends the row `preempted`.

    cd /private/tmp/ci-kit-deploy
    AWS_PROFILE=ci-kit-ops AWS_REGION=us-east-2 aws fis start-experiment --experiment-template-id <id>
    # expect: interrupted job fails; row ends preempted; no automatic rerun
    gh issue list --repo SSFSKIM/ci-kit-sandbox --search '"ec2 credit" in:title' --state all --json number,title
    gh api repos/SSFSKIM/ci-kit-sandbox/issues/<credit-issue-number>/comments --jq '.[].body'

For the budget proof, run the launcher with a test config whose `budget_usd` is below this reading's `billed_usd`.
Keep a running sandbox VM through that tick and queue generic demand. Observe the exact budget log, GCE-first
placement and that the running VM was untouched. For stale billing, supply a reading with `read_at` more than
48 h old and make refresh unavailable for that fixture; otherwise a successful refresh would rightly make the
data fresh. Observe the exact stale-billing log and the same placement behaviour. Restore the normal config
and reading after the proof; do not replace production billing with invented amounts. Tests also exercise the
flag and date ends, overlapping writers and a missing issue.

    cd /private/tmp/ci-kit-deploy
    gcloud logging read 'resource.labels.service_name="ci-kit-launcher" AND jsonPayload.message:"credit preference off:"' --project ssfskim-ci-kit --freshness=1h --format='value(jsonPayload.message)'
    # expect for the respective fixtures: "credit preference off: budget"; "credit preference off: stale billing"
    node gce/cost-report.mjs --since <ISO>
    node gce/latency-report.mjs --since <ISO>
    # expect: groups per provider; estimated row costs, AWS billing reading and remaining budget

M6 finishes by repeating the full committed-head gate and these live checks, recording the run ids and the
observations in this spec's Progress and Surprises & Discoveries.

## Interfaces and Dependencies

`gce/launcher/providers/<name>.mjs` exports `createProvider(deps) → Provider`:

    Candidate = {
      provider: 'gce' | 'ec2', account: string, region: string, zone: string, zoneId?: string,
      size: number, labels: string[],                       // logical cpus-N, not physical vCPUs
      machine: string, vcpus: number, memoryGiB: number, arch: 'x86_64',
      provisioning: 'spot' | 'standard', subnet: string, disk: { type: string, sizeGB: number },
      price: { source: string, at: string, initializationUsd?: number },
    }
    Instance = { provider, id, alloc, runner, repo?: string, size: number, labels: string[], state: 'pending'|'running'|'stopping'|'stopped'|'gone',
                 stateReason?: string, candidate: Candidate, createdAt: string }
    LaunchResult = { outcome: 'accepted'|'capacity'|'quota'|'denied'|'throttled'|'uncertain',
                     scope?: string, detail: string, id?: string }
    ReconcileResult = LaunchResult | { outcome: 'abandoned', detail: string }
    Provider = {
      name: 'gce' | 'ec2', account: string,
      candidates(config, size) : Candidate[],               // ordered for one logical size
      observe()          : Promise<{ instances: Instance[], complete: boolean, room?: object }>,
      readyImage()       : Promise<{ id: string, manifest: object } | null>,
      launch(alloc, candidate, jit, report?) : Promise<LaunchResult>,
      reconcileLaunch(alloc) : Promise<ReconcileResult>,
      terminate(instance)    : Promise<void>,
      readReports(allocs)    : Promise<Map<string, AllocationReports>>, // allocation id → bundle
      cleanupOrphans(inventory, ledger) : Promise<string[]>, // names what it removed
    }

`size` is the numeric N in `cpus-N`; `labels` are the GitHub runner labels, not EC2 tags or GCE resource labels.
The GCE contract pins `c3d-highcpu-4` as both a size-2 and a size-4 candidate, each with 4 physical vCPUs but
with the corresponding `cpus-N` label. `Instance` preserves the chosen logical size and labels when observed.

    RequiredProvider = 'any' | 'gce' | 'ec2'
    AllocationReports = {
      telemetry: Array<{ kind: 'telemetry' | 'claimed', ...fields }>,
      terminal?: { kind: 'terminal', ...fields },
    }
    BillingReading = { v: 1, since: string, billed_usd: number, through: string, read_at: string }
    Ec2Attempt = { zone: string, client_token: string, sent_at: string }
    Prelaunch = { run: number, attempt: number, workflow: string, group: string } // first allocation id

`readReports` returns `{ telemetry: [...], terminal?: {...} }` per allocation; a missing entry or terminal is
unknown, not success. GCE's `ci-kit/job` exit or failure becomes `terminal`. Boot and notice objects never do.
`BillingReading.since` is the configured start date, `through` the end of the billing interval read, and
`read_at` the UTC timestamp of that reading. Each complete `BillingReading` is an immutable comment on the
`ec2 credit <account>` issue outside the rotating allocation ledger; readers choose the newest valid `read_at` for the
configured `since`, and writers retain the newest 20. No finalize path mutates a reading.

`Ec2Attempt` is persisted on the row before sending. It holds no JIT configuration, presigned URL or full launch
request. For EC2, `reconcileLaunch` observes that zone by allocation tag and client token: `accepted` means an
instance was found (the scheduler records running), `uncertain` means the wait continues, and `abandoned` means
a successful observation found none at least 10 min after `sent_at`. An unknown inventory never yields
`abandoned`. The scheduler owns finalization, reservation release and JIT removal; the guard owns late VMs
whose rows are final. Reconciliation never replays the launch request.

Ledger v2 retains `cpus` as logical size and `reserved` as physical vCPUs, adds the provider/account fields in
Ledger rows and cost, and stores `job.labels` and `job.required_provider` for pre-launch shapes. V1 jobs read as requiring `any`,
under the legacy-label assumption in Runner labels and coverage. The required provider belongs
to demand; the provider on the allocation belongs to its VM. A generic job served on EC2 is still generic.
M4 stores `prelaunch: Prelaunch` on every allocation serving a speculative demand, including fallback and race
rows. `group` and the legacy read rule are defined in Ledger rows and cost; `race.of` remains the raced
allocation's id. `reserved` counts once per non-final allocation against both budgets, not once per group.

`lib/aws.mjs` exports `awsCredentials(roleArn) → Promise<{ accessKeyId, secretAccessKey, sessionToken, expiration }>`.
It is cached and refreshed per Reaching AWS, and the EC2, S3, Cost Explorer and Service Quotas clients are built on
it. The launcher and bake roles' `MaxSessionDuration` is 14400 and `awsCredentials` requests that many seconds.
The EC2 and regional clients use us-east-2; the Cost Explorer client alone uses endpoint
`https://ce.us-east-1.amazonaws.com` and signing region `us-east-1`.

`pool/config/ec2.json`:

    {"enabled": true,
     "accounts": [
      {"account": "290475840169", "enabled": true, "region": "us-east-2",
       "placements": [{"zone": "us-east-2b", "subnet": "subnet-…",
                       "machines": {"2": "c8a.large", "4": "c8a.xlarge", "8": "c8a.2xlarge", "16": "c8a.4xlarge"}}],
       "disk_gb": 50, "security_group": "sg-…", "report_bucket": "ci-kit-ec2-reports-290475840169",
       "roles": {"launcher": "arn:aws:iam::290475840169:role/ci-kit-ec2-launcher",
                 "bake": "arn:aws:iam::290475840169:role/ci-kit-ec2-bake",
                 "guard": "arn:aws:iam::290475840169:role/ci-kit-ec2-guard"},
       "credit": {"enabled": false, "since": "2026-10-23", "until": "2027-04-17", "budget_usd": 180}}]}

Each `accounts` entry is one provider instance; `account` is unique and every ARN must name it. Per-account
`enabled` is optional and defaults to true; an instance may launch only when both it and top-level `enabled`
are true. Disabled instances still manage existing allocations (Each repo's providers). `credit` is optional;
an account without it is never demoted (Placement order). The `repos` key of the earlier draft is gone.

`pool/config/gce.json`'s `repos` entries gain an optional ordered `providers` list (Each repo's providers):

    {"repo": "SSFSKIM/MAWS",
     "providers": [{"provider": "ec2", "account": "290475840169", "max_vcpus": 128}, {"provider": "gce"}]}
    ProviderEntry = { provider: 'gce' | 'ec2', account?: string, max_vcpus?: number }   // positive integer

Absent `providers` reads as `[{"provider": "gce"}]`. A `gce` entry's account, when given, must be `gce.json`'s
`project`. Once per config load, the parser resolves references independently of launch eligibility and refuses
only the reference/cap cases in Each repo's providers. Configured disabled instances remain resolved pairs;
when `ec2.json` is absent, EC2 entries are skipped and logged once for that load, not rejected. The scheduler
walks eligible resolved `(provider, account)` pairs; existing allocations remain managed by any configured
instance, regardless of eligibility.

The production chain is reviewed at each boundary:
- M1 produces the measured verdict, which fills `placements`' zone order and disk configuration for M5.
- M2 produces ledger v2 with v1 reads, `Candidate`, `Instance`, `Ec2Attempt`, the `Provider`/`ReconcileResult`
  contracts and provider-qualified keys.
- M3 consumes M2 and produces the GCE `createProvider`, including `AllocationReports` adaptation.
- M4 consumes M2/M3 and produces the scheduler over providers, label-aware coverage, provider-bound allocations,
  synchronous dual-budget admission, `Prelaunch` grouping, the EC2 accounts parser and config reloads with
  per-repo caps and credit demotion.
- M5 consumes M1/M4 and produces EC2's per-account `createProvider`, bounded reconciliation, `awsCredentials`,
  validated four-hour roles, the live `ec2.json` accounts config, tagged resources and the image built through the
  federated bake role.
- M6 consumes M5, proves federated billing access, and produces immutable `BillingReading` comments, credit
  policy, reports and guard (including final-row cleanup), then runs acceptance.

## Verification

- The spec gets one independent review (adversarial-reviewer, technical) and, since it has six milestones, the
  adversarial-reviewer's buildability review of the execution section, in the same round.
- Each milestone is reviewed at its boundary by the plan-executor's task reviewer.
- The whole branch gets doperpowers:review-code at **high** (reviewer-high): it adds cloud credentials, an IAM
  surface and a second control plane to a launcher that runs the owner's private CI.

## Surprises & Discoveries

- Observation: M4's deployed scheduler preserves the GCE-only live path. MAWS run `40015186704`, attempt 1,
  tested master `0c86e4861` through wrapper `d69ecff5812793000cc31a9c72531a9185482d34`; static, probes and all four
  unit shards passed on `ci-kit-gce-*`. Matching v2 rows in sandbox issue #48 name allocations `hsfd7kkod2`,
  `hsfd7pgdpg`, `hsfd7d10d4`, `hsfd72u0aq`, `hsfd7ty9ru`, `hsfd7p4q0t`, account `ssfskim-ci-kit`, us-west4-a.
  Evidence: https://github.com/SSFSKIM/MAWS/actions/runs/40015186704 and the attempt jobs/ledger APIs.
  Fresh-main clone `/private/tmp/ci-kit-ec2-deploy-m4` deployed `dcdc629` as `ci-kit-launcher-00020-t8v` at 100%;
  rollback revision was `ci-kit-launcher-00019-pxv`. No ERROR logs or rollback occurred during the canary.

- Observation: M3's deployed GCE provider passed the live MAWS class 1a proof with EC2 absent. Run
  `40008135552`, attempt 1, tested MAWS master `0c86e4861` through wrapper `e081f5e69b4bf867f3b2b02728349341ed839c20`.
  Static, probes and all four unit shards succeeded on `ci-kit-gce-*` runners. Ledger issue #48 in ci-kit-sandbox
  recorded `v:2`, `provider:gce`, `account:ssfskim-ci-kit`, actual job ids/labels and image provenance for allocations
  `hsfbqu5nay`, `hsfbqi7nql`, `hsfbqof83f`, `hsfbq464gc`, `hsfbqgekh0`, `hsfbqc1dr8`, all in us-west4-a.
  Evidence: https://github.com/SSFSKIM/MAWS/actions/runs/40008135552 ; the attempt-specific jobs API and ledger
  comments read after completion. Fresh clone `/private/tmp/ci-kit-ec2-deploy-m3` deployed merged-main `c14ac6c`;
  revision `ci-kit-launcher-00019-pxv` served 100%, with no ERROR logs observed in its canary window.
  Prior rollback revision was `ci-kit-launcher-00018-tpn` in us-central1; no rollback occurred.

- Observation: The requested spot quota increase landed before M2: us-east-2 now grants 256 vCPUs. Preflight
  found no active EC2 pool instances or pool volumes. Cost Explorer's 2026-10-23 reading had no EC2 charges yet
  (billing lag), so the M1 resource-based upper bound of $0.735 remains the pre-M2 spend estimate, not zero.
  Evidence: 2026-10-23 `service-quotas get-service-quota` for L-34B43A08 returned 256; pool-tagged instance and
  volume lists returned empty; Cost Explorer returned only a zero-dollar AWS Glue group.

- Observation: The GCE placements are ordered by speed, not by price; prices are only reported.
  Evidence: `gce/launcher/logic.mjs` `placements()` walks spot then standard in config order; the owner rejected
  daily price ranking (placement spec, Decision Log). Credit preference is therefore a policy switch.
- Observation: The original coverage and pre-launch implementation cannot be moved unchanged into two clouds.
  Evidence: `planLaunches` keys coverage by repo/size; `prelaunch.mjs` `runShape` counts only `r.cpus`;
  `ledger.mjs` `jobRecord` stores no labels. `pool/config/gce.json` maps c3d-highcpu-4 to both sizes 2 and 4.
- Observation: A truthy report means terminal evidence only in today's GCE implementation.
  Evidence: `claimedInstances` claims every truthy report and `reviewInstances` retires on it;
  `gce/vm/job.mjs` writes `ci-kit/job` only on exit or failure. EC2 boot/notice objects cannot enter those tests.
- Observation: Allocations and JIT labels are already coupled; cross-cloud fallback needs a new allocation.
  Evidence: `launcher.mjs` `launch` mints one JIT before its GCE walk, unregisters after definite exhaustion and
  finalizes `abandoned`. This design deliberately adds `refused` for provider exhaustion in M4.
- Observation: The allocation ledger is not durable lifetime billing storage or an atomic counter.
  Evidence: `ledger-store.mjs` has a 26-hour window, rotates at 2,000 comments and documents overlapping writes
  without compare-and-swap. Its cache and finalize path cannot implement lifetime credit accounting safely.
- Observation: Deployment success is not bake or canary evidence.
  Evidence: `gce/deploy.sh` deploys `ci-kit-bake` in us-central1; execution is separate. `server.mjs` logs JSON
  with `message`; ci-kit's gate is `bin/ci-gate`, while MAWS's is its own `scripts/ci-gate.sh`.

- Observation: M1's builder cannot be one-time spot with interruption=terminate and shutdown=stop.
  Evidence: M1 reported on 2026-10-23 that EC2 rejected that combination. The builder needs stop for CreateImage,
  so it uses a short on-demand c8a.2xlarge; the standard on-demand quota is 32 vCPUs.
- Observation: The account's regional policy permits Cost Explorer's global billing endpoint.
  Evidence: the author verified `aws ce get-cost-and-usage` under `ci-kit-ops` succeeded on 2026-10-23.
  Cost Explorer uses `ce.us-east-1.amazonaws.com`; federated launcher-role access remains a required live proof.

- Observation: M1 verdict. With plain gp3, lazy hydration makes an EC2 job 1.83x GCE C4D's end-to-end time
  (API call to job end); a targeted prefetch 1.34x; EBS provisioned volume initialization at 200 MiB/s 0.966x
  (1.028x with the repeated-VM unit median). c8a's warm unit shard is 0.93x C4D's. API to runner listening on c8a
  spot is p50/p90 95.4/97.9 s (10 launches, zones a and c) against 24.5 s on GCE.
  Evidence: `docs/doperpowers/specs/2026-10-23-ec2-pool-m1-verdict.md`, `ec2/spike/evidence/`.
- Observation: Initialization dominates EC2's cost per job. Ohio rates: $0.0024/GiB at 100-200 MiB/s, $0.0036 at
  201-300 MiB/s, charged on the snapshot's full data size (11.46 GiB) for every volume. A job costs ~$0.0329 gross,
  against $0.0035-0.0067 on GCE C4D: about 5-10x. At ~100 VMs/day the $180 budget lasts ~55 days; initialization
  alone is $2.75/day.
  Evidence: the verdict's economics table; `aws pricing get-products` (us-east-1) for "US East (Ohio)".
- Observation: c8a spot in us-east-2b, the cheapest zone, was refused `InsufficientInstanceCapacity` at the
  spike's first launch; AWS suggested a and c.
  Evidence: the verdict's launch log. Zone order c -> a -> b.

## Decision Log

- Decision: M3 preserves GCE's existing walker via a provider outcome adapter that retains original GCE error
  evidence. The GCE provider additionally owns batched reconciliation, existence/preemption reads and NAT
  telemetry; ledger and JIT settlement remain scheduler-owned. Its optional observation inputs preserve the
  existing ledger/inventory ordering and asynchronous bounded room wait. These are transitional GCE seams,
  not cross-provider scheduling policy: M4 owns their generalization.
  Rationale: extract cloud effects without silently changing reconciliation concurrency, failure classification,
  reservation timing or daily accounting. GCE reports expose only exit/failure values as terminal evidence;
  nonterminal telemetry and guest-claim signals cannot trigger the legacy claim or retirement consumers.
  Date/Author: 2026-10-23, M3 executor and controller; task review approved.

- Decision: M2 names the image's ci-kit provenance field `image_commit`, sourced from the selected GCE image's
  existing `ci-kit-commit` label. Candidate adds optional `family`, supplied by the GCE data adapter, so M4 can
  consume the provider's family without deriving it from a GCE machine name. Pure GCE shape adaptation lives in
  `providers/gce-data.mjs`; M3 owns `providers/gce.mjs` for effects.
  Rationale: preserve the existing image provenance and place cloud-specific interpretation at the provider
  boundary. V1 rows normalize to GCE with unknown account (`null`), rather than inventing a project not stored in
  their history; the existing hidden ledger comment marker remains readable.
  Date/Author: 2026-10-23, M2 executor and controller.

- Decision: Verification as in Verification above: one technical spec review plus a buildability review, a review
  per milestone, and reviewer-high on the branch.
  Rationale: a new cloud, IAM and federation, and a scheduler change on the path of every MAWS run.
  Date/Author: 2026-10-23, CI-opt.

- Decision: Coverage matches provider-only demand before generic demand, and pre-launch records required provider
  and speculates only for generic jobs; v1 rows read as generic, with the accepted hand-written-job risk.
  Rationale: mixed labels share a repo/size but not every runner. Rejected moving the old coverage counters
  unchanged; single-cloud behaviour is the regression bar.
  Date/Author: 2026-10-23, CI-opt.
- Decision: Separate nonterminal telemetry and claim signals from terminal reports; only terminal reports can
  establish a report-driven claim or retirement.
  Rationale: boot and interruption notices precede job completion. Rejected treating any guest object as GCE's
  existing terminal report.
  Date/Author: 2026-10-23, CI-opt.
- Decision: Unknown EC2 inventory keeps every non-final row's reservation, uses independent GitHub runner
  coverage, performs no EC2 mutation or finalization, and logs a sustained 30-minute outage once while GCE serves.
  Rationale: a failed list cannot prove absence or free capacity. Rejected dropping unseen rows or stopping both
  providers for an AWS-only failure.
  Date/Author: 2026-10-23, CI-opt.
- Decision: AWS billing readings in the dedicated `ec2 credit` issue drive preference, with daily refresh,
  a best-effort six-hour refresh floor across restarts and a 48-hour stale-data cutoff.
  Rationale: complete readings avoid double-counting overlapping finalizes and survive ledger rotation. Rejected
  the finalize-incremented checkpoint and counted-id list, and rejected a lock for $0.01 duplicate reads.
  The $20 margin covers roughly $10 of two-day billing lag at $5/day plus remaining uncertainty.
  Date/Author: 2026-10-23, CI-opt.
- Decision: Guard predicates use purpose and creation-time deadlines on live instances and volumes; image and
  snapshot retention stays separate.
  Rationale: a stopped builder waiting for CreateImage is valid. Rejected indiscriminate stopped-instance or
  no-ledger cleanup, and applying builder lifetimes to retained ready images. The author confirmed this scope.
  Date/Author: 2026-10-23, CI-opt.
- Decision: An allocation and its JIT registration belong to one provider; a definite exhaustion ends it refused
  and removes the registration before a new provider allocation serves the same demand.
  Rationale: labels minted for one cloud cannot advertise the other. Rejected one JIT registration across the
  cross-provider walk; uncertain attempts and races keep their own allocations.
  Date/Author: 2026-10-23, CI-opt.
- Decision: If selected by M1, provisioned EBS initialization is priced per volume on full snapshot data and
  charged at volume creation, with per-job cost and margin consumption in the spike verdict.
  Rationale: early deletion, failed boots and idle runners do not avoid the charge. Rejected pricing only
  successful job runtime or hiding initialization outside the candidate and row costs.
  Date/Author: 2026-10-23, CI-opt.
- Decision: Candidate and Instance expose logical size and labels; enumeration is `candidates(config, size)`;
  reports expose a telemetry array and optional terminal object.
  Rationale: physical vCPUs do not determine job labels, and report presence does not mean completion. Rejected
  size inference from machines, all-sizes enumeration and an undifferentiated report object.
  Date/Author: 2026-10-23, CI-opt.
- Decision: Split the provider work into M2 data contracts, M3 GCE effects and M4 scheduling, followed by M5 EC2
  and M6 policy and acceptance.
  Rationale: each consumed boundary needs review before its caller changes. Rejected one large extraction and
  scheduler milestone whose regressions could not be isolated.
  Date/Author: 2026-10-23, CI-opt.
- Decision: Acceptance assigns every proof to a milestone and uses distinct live fixtures for deadline, idle,
  guard, credit and image-parity behaviour.
  Rationale: observing ordinary jobs cannot prove the failure paths. Rejected acceptance claims with no way to
  trigger or distinguish the behaviour they name.
  Date/Author: 2026-10-23, CI-opt.
- Decision: Concrete Steps distinguish deployment from evidence, install dependencies before tests, execute and
  wait for the bake, and use each repo's gate and the launcher's structured log field.
  Rationale: the original commands could succeed without running the bake or could query the wrong surface.
  Rejected treating producer deployment as acceptance, ci-kit's checkout as MAWS, or `textPayload` as the log.
  Date/Author: 2026-10-23, CI-opt.

- Decision: Reconcile uncertain EC2 launches by recorded zone, token and send time without replay; successful
  absence at 10 min ends abandoned, releases the reservation and removes JIT, and the guard reaps late final-row VMs.
  Rationale: restart recovery needs no secret-bearing launch request. Rejected persisting and replaying that
  request, and indefinite reservations for requests that never reached AWS.
  Date/Author: 2026-10-23, CI-opt.
- Decision: The federated bake role may launch Canonical-owned AMIs only for builders; the stopped-for-image
  builder is on-demand, while job VMs remain spot with shutdown=terminate.
  Rationale: M1 found the spot/stop combination rejected. Rejected pool-AMI-only bake permissions, proving the
  bake with operator credentials, and a spot builder that cannot stop for CreateImage.
  Date/Author: 2026-10-23, CI-opt.
- Decision: Setup creates launcher and bake roles with MaxSessionDuration=14400, validates existing values
  without silent mutation, and the federation proof requests the production 14400 seconds.
  Rationale: a shorter session proves less than production needs. Rejected default role duration and silently
  rewriting existing roles to hide the mismatch.
  Date/Author: 2026-10-23, CI-opt.
- Decision: Cost Explorer alone uses its us-east-1 endpoint and signing region; federated launcher billing access
  must pass before M6 enables preference, or M6 stops and escalates.
  Rationale: operator access was verified but does not prove runtime access. Rejected a us-east-2 billing client,
  a blanket denial assumption, and enabling credit-first without its billing proof.
  Date/Author: 2026-10-23, CI-opt.
- Decision: Store billing readings as immutable comments, select the newest valid read_at from a fresh process,
  and prune all but the newest 20.
  Rationale: a late older write cannot erase a newer reading. Rejected a single mutable comment whose latest
  value could regress across a restart after overlapping writes.
  Date/Author: 2026-10-23, CI-opt.

- Decision: Promote M1's disk configuration: encrypted 50 GiB gp3 with EBS provisioned volume initialization at
  200 MiB/s, zones c -> a -> b, the builder on-demand. Initialization's per-volume charge is priced into each
  candidate and row (Ledger rows and cost).
  Rationale: the only arm under the 1.25x threshold; 200 MiB/s is the top of the cheaper tier. Rejected plain gp3
  (1.83x) and prefetch (1.34x), both over the threshold, and 300 MiB/s (50% higher rate for ~no gain).
  Date/Author: 2026-10-23, CI-opt.
- Decision: The image's written size is now a cost lever: initialization is charged per GiB of snapshot data for
  every job VM. M5's bake reports the snapshot size, and trimming what job VMs never read is in M5's scope.
  Rationale: at 11.46 GiB, initialization is ~84% of an EC2 job's cost. Rejected leaving the image as GCE's twin
  in content, which costs every VM the full size.
  Date/Author: 2026-10-23, CI-opt.

- Decision: Each pool repo has its own ordered provider list, with optional per-instance vCPU caps, in ci-kit's
  `gce.json` `repos` entries. A provider instance is `(provider, account)`. Absent means GCE alone, so EC2 is
  opt-in per repo. The list replaces `ec2.json`'s `repos` narrowing. Owner's ruling 2026-10-23: "Per-project, in
  EC2", chosen over a provider protocol for outside operators, now or after EC2, and over leaving one shared pool.
  Rationale: M2's keys already carry `(provider, account)`, and M4 is where the walk is built, so a list per repo
  costs little now and would mean rebuilding the walk later. Rejected: the repo declaring providers in its own
  `.github/ci-kit.yml`, because a pull request edits that file while the account owner pays. Rejected: absent
  means every configured provider, because enabling EC2 would silently move every repo and break Acceptance 9's
  bar.
  Date/Author: 2026-10-23, CI-opt.
- Decision: Credit is a property of an account, and it only demotes. Each repo's list order is its walk; an
  instance whose credit preference ended moves behind the repo's other spot instances. With the M6 lists (EC2,
  then GCE) this reproduces the owner's credit-first table exactly.
  Rationale: a global credit-first walk cannot express a repo that wants EC2 only as overflow, or never. Rejected
  credit promoting an instance ahead of its list position, which would override the repo's stated order.
  Date/Author: 2026-10-23, CI-opt.
- Decision: EC2 accounts are a list in `ec2.json`. Setup, the bake's EC2 stage, the guard's matrix leg, the
  billing issue (`ec2 credit <account>`) and federation audiences are per account. One account is configured and
  proved live; tests use two. GCE stays one project.
  Rationale: the owner asked for per-project providers and accounts. Writing these per account from the first
  build is a loop; retrofitting them after deployment would change the config shape, the billing issue's identity
  and the guard's roles in production. Rejected: entries by kind only, with accounts deferred until a second
  account exists.
  Date/Author: 2026-10-23, CI-opt.
- Decision: Pinning a gate to a cloud from `.github/ci-kit.yml` is out of scope. A pinned job (hand-written labels)
  whose repo lists no instance of that cloud stays queued and is logged once as unservable.
  Rationale: the repo-level list delivers per-project providers; a planner key and its plan-time check are a
  separate change. Rejected failing such jobs from the launcher, which cannot fail a queued GitHub job.
  Date/Author: 2026-10-23, CI-opt.

- Decision: Disabled EC2 instances remain valid list references and manage existing allocations; top-level and
  optional per-account `enabled` control new allocations only. An absent file skips EC2 entries once per config
  load and leaves non-final rows under the unknown-inventory rule. Switch off with `enabled: false`.
  Rationale: rejected treating disabled instances as invalid, because the last-good-config fallback would keep
  launching on them. Rejected file deletion as the off switch: it removes provider management and guard legs.
  Date/Author: 2026-10-23, CI-opt.
- Decision: Admission synchronously reserves both the global and repo/instance vCPU budgets before asynchronous
  work, once per allocation, for queued, speculative, race and fallback launches alike. Refusal releases both
  before fallback admission; uncertainty retains both, and final rows release both.
  Rationale: rejected checking only ledger rows or checking caps after an await, which lets concurrent launches
  oversubscribe. Rejected carrying a smaller reservation into a physically larger fallback candidate.
  Date/Author: 2026-10-23, CI-opt.
- Decision: Definitely refused allocations occupy no pre-launch slot. Persist `prelaunch.group`, the first
  allocation's id, on all fallback and race descendants so one speculative demand occupies at most one slot.
  Rationale: rejected counting each allocation, which suppresses retries and overcounts successful fallbacks.
  The existing `race.of` names an actual raced allocation, not every descendant's demand; a group field preserves
  that meaning and reconstructs partial batches across restarts without needing the original row.
  Date/Author: 2026-10-23, CI-opt.

- Decision: M4's Provider carries its account identity, and an observed Instance may carry its repo from cloud
  tags so orphan rows participate in repo/instance cap accounting. Cold/full ledger reads scan open ledger
  issues beyond the ordinary cost window to recover old non-final reservations. A budget-declined demand gets
  one admission retry after concurrent cleanup finalizes rows, preserving GCE's same-tick budget reuse.
  Rationale: provider kind alone cannot identify account-scoped effects, missing rows must not erase cap usage,
  and unknown inventory must retain reservations beyond 26 hours. The retry preserves existing admission
  opportunities without weakening synchronous acquisition of both budgets.
  Date/Author: 2026-10-23, M4 executor and controller; design-owner confirmed consistency.

- Decision: The M4 config source returns `{cfg, config, poolRepos, ec2, repoProviders}`; `config` retains its
  GCE-config-commit meaning and `ec2: null` denotes confirmed absence. Resolved repo references are separate
  from `cfg.repos`. Launcher receives `providers`, `ec2`, `repoProviders`, process-shared `providerState` and the
  pure policy input `creditPreference(account)`. Configured disabled instances remain in `providers`.
  The scheduler persists the exact `zone`, `client_token` and `sent_at` before calling an EC2 provider; M5 consumes
  these coordinates and never replays a request. M5 adds the promoted initialization rate to the accounts schema.
  Rationale: keep runtime wiring and durable launch ownership explicit at the M4/M5 boundary. Review additionally
  established that races activate only after admission, attempt-coordinate writes serialize with pending markers,
  and definite refusal is persisted before unregister; failed final persistence retains both debits and JIT.
  Date/Author: 2026-10-23, M4 executor and controller; reviewed through 3550a56.

- Decision: Include `@aws-sdk/client-ssm` among allowed AWS SDK v3 clients for the bake's specified Canonical
  public-parameter lookup. This fills a dependency-list omission; its permissions and behavior were already in
  the design. Federation audiences derive from the role ARN's account, STS uses the configured regional endpoint,
  and Cost Explorer always uses its explicit us-east-1 endpoint and signing region.
  Date/Author: 2026-10-23, controller; M5 client-interface coordination.

- Decision: M5 reads role ARNs from each account's `roles` config, not duplicate deploy environment variables.
  The guest emits the specified boot, notice and exit reports without a separate claimed event; providers retain
  any supplied claimed signal as nonterminal telemetry. Terminal reports still establish report-driven exclusion
  and retirement, independently of GitHub job/busy-runner and recorded-job claims.
  Rationale: per-account config already owns role identity, and the guest has no required separate claim signal.
  This removes stale single-account deployment wording without changing the report contract or claim semantics.
  Date/Author: 2026-10-23, M5 executor and controller.

- Decision: Enforce Canonical-only-as-builder with the existing two AWS roles: bake can launch builders only
  from Canonical or owned pool AMIs; launcher can launch jobs/smokes only from owned pool AMIs. Smoke launches
  therefore use launcher credentials. Setup validates these policies on existing roles, and M5 proves allowed
  and refused combinations with zero-resource RunInstances dry-runs. Guard deadlines are unchanged.
  Rationale: RunInstances authorizes AMIs and new instances/volumes separately: image conditions expose Owner
  but not request purpose tags, while instance/volume conditions expose request tags. Rejected one bake role
  with Canonical/builder coupling enforced only in code (not IAM), and a third builder-only role (extra setup
  for the same enforcement). Official authorization reference: https://servicereference.us-east-1.amazonaws.com/v1/ec2/ec2.json.
  Date/Author: 2026-10-23, design-owner confirmation relayed to M5 executor and controller.

## Outcomes & Retrospective

Pending — written at finish.
