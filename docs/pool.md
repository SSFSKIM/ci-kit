# The pool — operator runbook

The pool runs each private repo's job on an ephemeral GCE or EC2 VM. The launcher reads GitHub's queue and
provisions runners automatically; a workflow does not create capacity itself. Repositories and provider order
live in `pool/config/gce.json`; EC2 accounts live in `pool/config/ec2.json`. See [GCE](#gce) for the shared
launcher and bake, and [EC2 and credit preference](#ec2-and-credit-preference) for account selection and billing.

| Piece | Where |
|---|---|
| shared runner image and job-started hook | `pool/image/` |
| shared cache paths, container environment and queue filter | `pool/agent/docker.mjs`, `pool/agent/logic.mjs` |
| shared VM container runtime | `pool/vm/` |
| shared image preparation, setup manifest and job images | `pool/bake/` |
| alerts | `pool/lib/alerts.mjs` |
| launcher, GCE bake, VM unit and deploy | `gce/`, `lib/gce.mjs` |
| EC2 bake, VM unit and cloud setup | `ec2/`, `lib/aws.mjs` |
| independent EC2 guard | `.github/workflows/pool-guard.yml`, `ec2/guard.mjs` |
| ledger | issues titled "pool ledger" or "pool ledger from …" in `SSFSKIM/ci-kit-sandbox` |

## Using the pool from a repo

A private repo's gate uses `lane: pool` and `cpus: 2|4|8|16` in `.github/ci-kit.yml`
(see [adopting.md](adopting.md)). The operator must:

1. Add the repo to `repos` in `pool/config/gce.json`, with its provider preferences if needed, and commit to
   `main`. The launcher reloads configuration each tick. A repo the API reports as public is refused.
2. Add the repo to the `ci-kit-runners` App installation (GitHub Settings → Applications → Installed GitHub Apps
   → ci-kit-runners → Configure). Deploy the webhook receiver with the new repo list for prompt wakeups;
   the scheduled launcher tick still works before that deploy.

A custom workflow uses `runs-on: [self-hosted, ci-kit-pool, cpus-<N>]` directly. No cloud token or ensure step is
needed. `SSFSKIM/ci-kit/pool-ensure@v1` remains available for existing workflows as a no-op: its deprecated
`hcloud-token` input is accepted but ignored, and its `result` output is always `none`. Once `v1` includes this
retirement, callers may remove the old input and step.

Removing a repo from `gce.json` stops new launches after the launcher reads that commit. Busy VMs finish their
jobs; idle runners are unregistered immediately. Jobs queued meanwhile wait in GitHub. The launcher's tick log
records its `config` commit; a failed config fetch keeps the last good copy and logs that fact.

Inside a job container, size worker pools from `nproc` or Node's `os.availableParallelism()`.

## Credentials

The GitHub App `ci-kit-runners` (id 5337915) has separate private keys in GitHub repository secrets and GCP
Secret Manager. **Removing the old provider does not revoke either key.** The GitHub-secret key remains in use
by ci-kit's EC2 guard and ci-kit-sandbox's history/probe workflows. Keep `CI_KIT_APP_ID` and `CI_KIT_APP_KEY` in
both repositories. The GCP key serves the launcher and cloud bakes; it is not baked into GCE images or EC2 AMIs.
See the GCE credential details below before rotating either key. No cloud token is required in pool callers.

## Re-bake

GCE and EC2 share the bake manifest and preparation. Their Cloud Run bake jobs and the independent bake-check
job are deployed from a checkout with `gce/deploy.sh bake bake-check`; see the GCE bake instructions below for
execution and schedules. The baked job images contain tools and caches, not the App private key.

## GCE

The GCE backend (spec §3a) runs each pool job on its own spot VM in the project `ssfskim-ci-kit`, booted from the
image family `ci-kit-runner`. Repos listed in `pool/config/gce.json` are served by the shared launcher, using
each repo's configured GCE/EC2 provider preferences.

| Piece | Where |
|---|---|
| launcher (Cloud Run service `ci-kit-launcher`) | `gce/launcher/`: `server.mjs` (the service), `routes.mjs` (its paths), `ticker.mjs` (when ticks run), `launcher.mjs` (one tick), decisions in `logic.mjs`, ledger rows in `ledger.mjs` and `ledger-store.mjs`, configs from main in `source.mjs` |
| webhook receiver (Cloud Run service `ci-kit-webhook`) | `gce/webhook/`: `server.mjs` (the service), `receiver.mjs` (signature, filter, publish); the App's hook config: `gce/tools/app-hook.mjs` |
| bake (orchestrator, decisions) | `gce/bake/bake.mjs`, `gce/bake/plan.mjs` |
| builder (startup script) | `gce/bake/builder.sh`, sharing `pool/bake/prepare.sh` with the EC2 builder |
| the VM's job unit and smoke check | `gce/vm/` (`ci-kit-gce-job.service`, `job.mjs`, `run.mjs`, `smoke.sh`) |
| Compute Engine and Secret Manager client | `lib/gce.mjs` |
| deploy | `gce/deploy.sh` |
| start latency, stage by stage | `gce/latency-report.mjs` (Reading the GCE ledger, below) |
| config | `pool/config/gce.json` (I12; placements below) |

**Placements.** `gce.json` lists where the launcher may create a VM as an ordered list, `placements` (spec
`2026-10-21-pool-placement-latency-design.md`): each a region and machine family with its `zones`, `subnetwork`, a
machine for every size (`machines`: 2, 4, 8, 16) and the boot `disk_type`.

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

The pool's placements (spec M6, 2026-10-21), in walk order; C4D's sizes are `c4d-highcpu-2/4/8/16` on
`hyperdisk-balanced`, C3D's `c3d-highcpu-4/4/8/16` on `pd-balanced`. A region with two placements has one subnetwork:

| # | family | region | zones | subnetwork |
|---|---|---|---|---|
| 1 | C4D | us-west4 | a, b, c | `ci-kit-us-west4` |
| 2 | C4D | us-central1 | a, b, c, f | `ci-kit-us-central1` |
| 3 | C4D | us-east1 | b, c, d | `ci-kit-us-east1` |
| 4 | C4D | us-east4 | a, b, c | `ci-kit-us-east4` |
| 5 | C4D | us-east5 | a, b, c | `ci-kit-us-east5` |
| 6 | C3D | us-central1 | a, b, c, f | `ci-kit-us-central1` |
| 7 | C3D | us-east1 | b, c, d | `ci-kit-us-east1` |
| 8 | C3D | us-east4 | a, b, c | `ci-kit-us-east4` |

Every zone named offers the placement's machines (`gcloud compute machine-types list`, 2026-10-21). us-south1 and
us-west2 offer no C4D; us-east5 is C4D only, its C3D grant (24) left unused. How `max_vcpus` follows these
placements is under Quotas and budget.

The order is speed first; reordering is a commit on main, read by the next tick. `placements` is the only form: the
old keys (`region`, `subnetwork`, `zones`, `machines`, `machine_fallback`) are refused by `gce/launcher/config.mjs`.
E2 left the pool with them (its us-central1 quota raise was refused twice); size 2 on a C3D placement runs on
`c3d-highcpu-4`. Adding a placement is a block in this list plus `gce/deploy.sh network`, which creates its
subnetwork, router and NAT, and a smoke VM there, both from the change's checkout before it merges (the launcher reads
main's list every tick, so a placement published before its region is provisioned is walked into and refused). The
bake reads the `gce.json` bundled at its deploy, so a change to the placements reaches it with
`gce/deploy.sh bake`.

**The launcher.** Cloud Scheduler's `ci-kit-launcher-tick` POSTs to `ci-kit-launcher`'s `/tick` every minute with an
OIDC token, and the webhook's Pub/Sub push POSTs to its `/request` when a job is queued in a served repo (The
webhook, below).
The service has no public ingress (`--ingress=internal`, IAM-only: `ci-kit-launcher@` is its one invoker), runs one
instance at a time and admits many requests at once, but runs one tick at a time (`ticker.mjs`). Every tick is the
same full reconciliation, whoever asked, and nothing is kept between ticks: state is in GCE labels, the ledger and
GitHub. A tick:

1. reads `gce.json` and `ec2.json` from the kit's main (the newest commit that changed each; on a failed read it
   keeps the last good copy, and at a cold start without main, the copy in its own build);
2. reads, all at once: each repo's visibility (public repos are refused), its
   `ci-kit-gce-*` runners and then its queued and in-progress runs and their jobs; the ledger's last 26 h on every
   open ledger issue (below) and then the `ci-kit=gce` instances and disks; the images; and, once the runners and
   instances are in, `ci-kit/job` of each VM whose runner is not busy;
3. launches one VM per queued pool job not covered by an unclaimed VM, oldest job first, while the vCPUs in flight
   stay at or under `max_vcpus`. An unclaimed VM has its runner registered, not busy, younger than
   `idle_runner_minutes`, and never having taken a job: a job VM is single-use, and its runner reads registered and
   not busy for a while after its job ends (a job this tick read names it, its row recorded a job, or it reported
   `ci-kit/job`). Static job 119166794835 waited 126 s on 2026-10-21 behind a VM whose job had just ended. Nor is a
   VM unclaimed whose runner never came online 3 minutes after the VM started: it booted but cannot reach GitHub
   (under `egress: "nat"`, its region's NAT missing, misconfigured or out of ports), and the launcher logs it at ERROR each tick,
   `runner never online` with its zone and region, until the idle rule removes it;
   then, with what those launches leave of `max_vcpus` and only when no queued job waits, pre-launches the VMs of
   each run that has begun before its pool jobs are queued (Pre-launch, below), and races an insert still unsettled
   after 20 s with a second allocation (The race of a slow insert, below). A launching row whose insert never settled
   counts as its VM would (vCPUs, and cover while its runner waits);
4. beside the launches, cleans up (below), finalizes rows whose VM is gone, and records on each running row the job
   its runner holds;
5. once a day, between 00:05 and 02:00 UTC, writes yesterday's daily line.

The launches start as soon as the reads are in, before the cleanup, and the two run together: a VM about to be
deleted still counts against `max_vcpus` for that tick, so launching first can only under-admit, never over-admit.
The ledger store lives as long as the service's instance and, after its first read of an issue, asks only for the
comments updated since its last read, less 5 min; a busy day's window is several pages, which a tick would otherwise
read one after another before its first launch.

A launch writes the `launching` row, mints the JIT config (runner name = instance name, labels `self-hosted`,
`ci-kit-pool`, `cpus-N`, `ci-kit-gce`, work folder `/var/lib/ci-kit/cache/work/<instance>`), then creates
`ci-kit-gce-<allocation id>` from the newest image labelled `ci-kit-ready=true`. It walks the placements: the
size's machine as spot in each zone of the first placement, then of the next, and so on; then on demand in the same
order (an attempt two placements share is made once). `ZONE_RESOURCE_POOL_EXHAUSTED*` moves to the next zone, and the
launcher remembers that zone, machine and provisioning as stocked out for 5 min (in its process, across ticks; a
restart forgets): with eight placements a size has 26 spot attempts before its first on-demand one, more refusals than
one tick's 45 s holds, so the next ticks skip the zones already refused and reach the rest, then on demand. A quota
refusal is remembered for the rest of the tick, scoped to what its message names: a family's CPUs (`CPUS_PER_VM_FAMILY`,
the refused machine's family, or the older `C3D_CPUS` form) by region and family, so C4D refused in us-central1 leaves
C3D there to try, any other regional quota (`CPUS`, `INSTANCES`, `IN_USE_ADDRESSES`, disk capacity) by region,
`CPUS_ALL_REGIONS` everywhere, a `PREEMPTIBLE_` one for spot only; every later attempt in that scope of the same or
more vCPUs is skipped, in this walk and the tick's later ones, since a smaller VM may still fit.

A refusal costs 6-21 s (it is the insert operation's error), and walks in flight together each pay the same one, so
the walk also knows each placement's limits and skips a full placement without an insert (`gce/launcher/room.mjs`):
the region's `IN_USE_ADDRESSES` (while egress is external) and `INSTANCES` from regions.get, and the family's vCPUs
from Cloud Quotas' `CPUS_PER_VM_FAMILY` (region, vm_family) grant, read live and cached for 10 min, so a grant that
lands is picked up without a config change. What holds them is the tick's own listing (job and bake VMs; a stopped VM
holds no vCPUs or address, a NAT VM no address) plus what its walks have sent; a refused insert gives its share back,
and a refusal that still happens closes that limit for the rest of the tick, for every size. Without a read (the
cache's first read failed), nothing is skipped as full. The tick summary's `full` counts the attempts skipped, by limit.
A launch whose every attempt is so ruled out makes no runner or row and its job waits in GitHub's queue; no other
launch stops. A tick's budget is a 45 s constant (`TICK_BUDGET_MS`), well below the 300 s of Cloud Run's request
timeout, Cloud Scheduler's attempt deadline and Pub/Sub's ack deadline, since a request stays open for its tick's whole
run; a launch it cuts off (the summary's `cut`) gets a follow-up tick 10 s after the cut one started, inside the same
request (at most 3 in a row, none starting 3 min past the first), rather than waiting for the minute tick. An insert
whose outcome is unknown is settled through its zone operation before any other zone is tried, and if it stays
unknown the walk stops and the cleanup rules settle it. The VM: no service account, its placement's subnetwork with
the egress `gce.json` names (an ephemeral external address by default; The network, below), the JIT config in metadata `ci-kit-jit`, `maxRunDuration` = `max_run_minutes` with a `DELETE` action, a boot disk of the
placement's `disk_type` and `disk_gb` that goes with it, labels `ci-kit=gce`, `ci-kit-alloc`,
`ci-kit-repo=<owner>--<repo>`, `ci-kit-cpus`, `ci-kit-provisioning=spot|standard`, `ci-kit-disk=<disk type>` and
`ci-kit-config=<gce.json commit, 8>`.

Allocation ids are the launch minute in base36 (5 characters) and 5 random ones (about 60 million a minute), so a
runner's age is read from its name, never more than the real one: the runners API gives no creation time. Admission
reserves the largest machine a launch could land on in any placement (a `cpus-2` job reserves 4 when any placement
gives size 2 a `c3d-highcpu-4`), and no placement attempt starts once the tick's 45 s budget is spent; the job waits
for the next tick. An attempt already started waits for its operation up to 40 s whatever the budget, since giving up
early only defers what the operation decides. Up to 16 launches run at once, so a burst launches in one round.

Cleanup, every tick:
- a VM whose job unit reported `ci-kit/job=exit:<code>` (or `failed:<step>`) is deleted on that tick, without
  waiting for the guest's power-off, which takes about 85 s more. Only a VM whose runner is not busy is read, so a
  running job is never touched;
- a `TERMINATED` VM (its job ended and the guest powered off) is deleted;
- an idle runner (registered, not busy, its VM older than `idle_runner_minutes`) is unregistered first and its VM
  deleted only once GitHub has let go (or answers 404); `busy` or any error keeps the VM for the next tick, since
  the runner may have just taken a job. A failed runner listing is never read as idleness;
- a VM whose runner is gone but which is still up after `idle_runner_minutes` is deleted;
- a VM older than `max_run_minutes` + 5 is deleted, and an alert opens (Compute Engine should have deleted it);
- a `ci-kit-gce-*` runner with no VM, more than 5 min after its launch, is unregistered (a crash between the mint and
  the insert);
- a `ci-kit=gce` disk attached to nothing for 10 min, and a `ci-kit=gce-builder` instance older than 4 h, are
  deleted;
- a `launching` row with no VM and no runner 10 min after its launch is finalized `abandoned`.

Deletes are not waited for: the row goes `deleting` (with its end) just before the delete call, and the next tick
finds the VM gone and finalizes it. A VM missing from the listing is confirmed with a direct read before its row is
finalized, since another tick may have just created it. When the aggregated listing (one call over every zone) did not
read whole (unreachable, partial, or absent) a placement's zone or the zone of a row not yet final (a VM outlives a
placement removed from `gce.json`), or while a row not yet final names no zone (an insert whose running write
failed) any zone at all, the tick launches nothing and does nothing that rests
on something being absent (finalizing a vanished VM's row, unregistering a runner with no VM); when GCE's operation
history cannot be read, a vanished VM's row waits rather than being called `orphan`. Runners are listed for every repo
with a row in the ledger's window, so a repo that has left `gce.json` is still cleaned until its last runner is gone.

**The webhook.** A job queued between two minute ticks would wait for the next one (27 s median, up to a minute), so
GitHub's `workflow_job` events ask for a tick at once:

```
GitHub App ci-kit-runners ──workflow_job──▶ ci-kit-webhook (public) ──publish──▶ Pub/Sub ci-kit-tick-requests
    ──push subscription ci-kit-tick-requests-launcher, OIDC as ci-kit-launcher@──▶ ci-kit-launcher /request
```

- **The receiver** (`ci-kit-webhook`, `gce/webhook/`) is the pool's one public endpoint: ingress `all`, the invoker
  IAM check off (the org's domain-restricted sharing refuses an `allUsers` invoker). A delivery whose
  `X-Hub-Signature-256` is missing or not `sha256=` and 64 hex digits is answered 401 before the secret is read. Then
  it reads the body (1 MiB at most, else 413), checks the signature against the webhook secret and answers 401 to
  anything that does not verify, before it parses a byte. A `workflow_job` `queued` delivery of a served repo, on any
  runner, publishes one message (repo, job, run, labels, delivery id) and is answered 202: a pool job's tick launches
  its VM, and any other job's (MAWS's `plan` on hosted `ubuntu-slim`) may find its run just begun, which the tick
  pre-launches (Pre-launch, below). Holding no state, the receiver cannot tell a run's first job from a later one;
  the tick, which reads the run, decides. Every other delivery is answered 200 with why it was ignored, which
  GitHub's delivery log shows. It runs as `ci-kit-webhook@`, which may read the webhook secret and publish to the
  topic, and nothing else: it cannot invoke the launcher. Which repos are served is read from the `gce.json`
  bundled at its deploy, so a repo added on main reaches the webhook path at the receiver's next
  `gce/deploy.sh webhook` (until then its jobs wait for the minute tick, as before).
- **The path to the launcher.** Cloud Run's internal ingress admits a Pub/Sub push subscription of the same project
  calling the service's `run.app` URL; Cloud Run then checks the push's OIDC token (`ci-kit-launcher@`, audience the
  launcher's URL) like the scheduler's. A message older than 10 min is dropped; a failed push is retried after 10–60 s.
  The subscription's ack deadline is 300 s, since a push is answered only when its tick has ended (next item).
- **The launcher** runs the tick a push asks for at once when idle; when a tick is running, every request arriving
  meanwhile, scheduled or pushed, is served by one more tick after it (at most one pending); ticks start at least
  10 s apart; and while the App's remaining GitHub budget is under 20% of its limit, a tick that only pushes asked for
  is dropped (logged `requested tick dropped`), so the minute tick alone serves. Every request is answered when the
  tick that serves it has ended (a push 200 with the tick's outcome, `dropped` or `failed`; the scheduler 200 or 500,
  so a failed tick still fails its execution and the alert). An open request is what keeps a Cloud Run instance's
  CPU allocated under request-based billing, so the launcher stays in the free tier.
- **The ack deadline.** A push that arrives while a tick runs is served by the next tick, never dropped and never
  held past it, so the subscription's ack deadline outlives the worst case: the running tick (~100 s: launches stop
  starting at its 45 s budget, an insert already started waits up to 40 s more, then its tail; the longest of 4,283
  ticks in the 3 days to 2026-10-21 took 77 s), the 10 s spacing, the next tick (~100 s) and a cold start (~10 s):
  220 s. The deadline is 300 s, Cloud Run's request timeout for the launcher. A push held past it is cut and
  redelivered, which costs one more tick, never a job.
- **Pub/Sub's push window.** Pub/Sub narrows how many pushes it has outstanding when answers take over a second, and
  these take a tick's length. A burst can then reach the launcher a few pushes at a time, and the ones held back
  arrive as ticks end, each starting or joining the next tick. Every tick reads every queued job, so a job is
  launched by the first tick that starts after it was queued, whichever push started that tick. A held-back push can
  start that tick only once a push ahead of it is answered, at the end of the running tick, which is when a pending
  tick would have started anyway; it is later only by Pub/Sub's dispatch of the next push (not measured). What the
  window can cost is ticks: at worst one per held-back push, inside the 10 s spacing and the 20% budget rule. A tick's
  `requests` field shows how many pushes each tick served.
- **Nothing new to keep correct.** A requested tick is an ordinary tick. A lost, duplicated, forged-and-refused or
  late delivery, or a dropped request, costs at most the minute until the scheduled tick, never a job; a replayed
  genuine delivery costs one tick, inside the 10 s spacing.

The webhook secret is `ci-kit-webhook-secret` in Secret Manager (label `ci-kit=webhook`), readable by
`ci-kit-webhook@` only and mounted into the receiver as a file that Cloud Run reads from Secret Manager on each read,
a billed access counted against the project's quota. So the receiver keeps it for 60 s, and a signature that does not
verify asks for a re-read: a rotation is live within 10 s of the first delivery signed with the new secret. A read
starts at most once per 10 s per instance, failed ones included, and concurrent deliveries share the one in flight, so
neither a flood of forged signatures nor an outage of Secret Manager costs more. While reads fail, the last good copy
keeps serving; with none, a delivery is answered 503 and its job waits for the minute tick. The same value is the App's webhook secret, set with the App's URL by `gce/deploy.sh app-hook`
(`PATCH /app/hook/config` as the App; the secret is never printed). The App's subscribed events and its webhook's
**Active** box have no API: they are on its settings page, `https://github.com/settings/apps/ci-kit-runners` (Active,
under Webhook) and `https://github.com/settings/apps/ci-kit-runners/permissions` (Subscribe to events: **Workflow
job**, which the App's Actions permission allows; no installation has to approve it).

Setting it up, in order (Secret Manager writes are the owner's):

1. `gce/deploy.sh base`, which creates `ci-kit-webhook@` (and turns on the Pub/Sub API).
2. The owner creates the secret, its value generated in the pipe so that it lands in no file and no shell history,
   and lets the receiver read it:
   ```
   openssl rand -hex 32 | tr -d '\n' | gcloud secrets create ci-kit-webhook-secret --project=ssfskim-ci-kit \
     --replication-policy=automatic --labels=ci-kit=webhook --data-file=-
   gcloud secrets add-iam-policy-binding ci-kit-webhook-secret --project=ssfskim-ci-kit \
     --member=serviceAccount:ci-kit-webhook@ssfskim-ci-kit.iam.gserviceaccount.com \
     --role=roles/secretmanager.secretAccessor
   ```
3. `gce/deploy.sh launcher webhook`: the launcher with `/request`, then the receiver, the topic and the push
   subscription.
4. `gce/deploy.sh app-hook`: the App's webhook URL and secret.
5. The owner, on the App's settings page: tick **Active** under Webhook (the URL is already the receiver's; leave the
   secret field as it is) and save; then Permissions & events → Subscribe to events → **Workflow job** → Save.

To rotate the secret: the owner adds a version (`openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add
ci-kit-webhook-secret --project=ssfskim-ci-kit --data-file=-`), then `gce/deploy.sh app-hook` at once. Deliveries in
between may fail with 401 (once the receiver's 60 s copy is the new secret), and their jobs wait for the minute tick;
after `app-hook`, the receiver verifies the new signatures within 10 s (its copy is re-read on a mismatch). To turn the webhook path off: untick **Active** on the
App's page; the minute tick serves alone, as before M4.

To check: GitHub's delivery log (the App's page → Advanced) shows each delivery's answer; the receiver's logs
(`gcloud run services logs read ci-kit-webhook --region=us-central1 --project=ssfskim-ci-kit`) a line per published
request (`tick requested: <repo> job <id>`) or refused signature; the launcher's a `tick request:` line per push and a
`tick:` line per tick with its `trigger` (`scheduled` or `requested`) and `requests` (how many requests it served).

**Pre-launch.** A MAWS class 1a run waits once for the pool: its `plan` job runs on hosted `ubuntu-slim` (~4 s to
start, ~10–15 s to run), and its gates (static, the unit shards, probes) are created, queued, when it ends. So when a
served repo's run begins, the tick launches the VMs its pool jobs will ask for, and they boot while the plan runs
(`gce/launcher/prelaunch.mjs`):

- **A run has begun** when it is listed queued or in progress and none of its jobs is a pool job (`ci-kit-pool`,
  in any state, skipped included) or has ended. GitHub creates the jobs that need the first ones when those end, so
  a run whose first job ended with no pool job listed has none coming (a docs-only run's skipped gates, or class 1a
  on the Mac), and it gets nothing. The webhook's request for the plan's `queued` event finds the run at once; a
  minute tick that falls inside the plan finds it too.
- **What to launch.** On attempt 1, the last `Pool-Demand:` line of the head commit message supplies the exact
  demand: space-separated `<cpus>x<count>` tokens, sizes 2, 4, 8 or 16, each size at most once, each count a positive
  decimal integer. For example, `Pool-Demand: 16x1 8x4 4x2 2x1`. Exactly `Pool-Demand: none` means no pool jobs and
  launches nothing, even when history predicts otherwise. The message comes from the existing workflow-runs listing;
  no receiver or extra API read is needed. A malformed last value counts as absent, not as an earlier valid trailer.
  Later attempts ignore the trailer: a failed-jobs rerun needs a subset, not the original full plan.
- **Without a valid hint**, the same workflow's runs on the ledger supply its shape: for each size, the median count
  of VMs its pool jobs took over its last 10 runs (newest by run id) in the ledger's 26 h window, rounded up; a run
  with no job of a size counts 0 for it. A row counts through the job its VM ran (`job.run`, `job.workflow`), whichever
  run it was launched for. A workflow with neither a valid hint nor history gets nothing. Historical provider-pinned
  jobs stay separate from generic demand and are not speculated as generic VMs. Sizes go largest first.
- **Once per run.** A pre-launched VM's row names the run it was launched for (`prelaunch`: run, attempt, workflow,
  written in the `launching` row before the runner is minted), and a run gets its shape less the VMs already
  pre-launched for its run and attempt, whatever became of them (an `abandoned` row, which made no VM, does not
  count). A later tick, a redelivered or duplicate event and a second launcher reading the same ledger therefore
  launch nothing more; two ticks overlapping can both launch for one run, the overlap's usual over-launch, which the
  idle rule removes. A re-run of all of a run's jobs is a new attempt and is pre-launched again.
- **Shared inventory.** Before launching the remainder, subtract idle, online pool runners of the same repo and
  `cpus-N` size that queued jobs have not already reserved. Queued-job accounting matches required-provider labels
  first, so a pinned job and a generic job cannot spend the same runner. A runner whose ledger row names a pre-launch
  (or race) for an attempt still awaiting its pool jobs stays with that attempt; its own dedupe already counts it.
  Other eligible runners are assigned once per tick, oldest run first, with no durable reservation. Busy, offline,
  expired, retiring and previously used single-job runners do not count. Claims are known from jobs, ledger rows and
  guest reports, as for ordinary queued-job coverage. This reuses leftover capacity; it does not maintain standby.
- **An ordinary job VM.** Its runner is minted at launch with the size's labels, so it counts as cover for any queued
  job of its repo and size from that moment, and the run's gates, once queued, launch nothing more. GitHub gives
  each gate to any runner of its repo and size, so a VM pre-launched for one run may serve another's; the cover
  count is per repo and size, so the books balance either way. One no job claims is removed by the idle rule at
  `idle_runner_minutes` (10) after its creation, and a run is pre-launched once, so a docs-only run costs at most
  one idle window of its shape's VMs.
- **Admission.** Pre-launches come after the queued jobs' launches: none while a queued job waits, each reserves the
  largest machine its walk could land on as a launch does, against what the launches left of `max_vcpus`, oldest
  run first, and the first that does not fit stops the rest until a later tick. They start only once the queued jobs'
  launches have ended (those mint and insert up to 16 at once, and a pre-launch beside them could take the quota a
  job needs), and not at all in a tick where one of those launches stayed unserved (refused, unsettled or past the
  tick's budget): that tick has no spare quota to speculate with. They walk the placements and share the tick's quota
  memory like any launch.
- **To check:** the launcher logs `pre-launched <instance> (<machine>, <spot|standard>, <zone>) for run <id>
  (<workflow>) in <repo>`, and its tick line lists them in `prelaunched`. The ledger's row and daily line and the
  latency report show what they did (Reading the GCE ledger, below).

**The race of a slow insert** (spec 2026-10-21 M6). An ordinary insert is accepted in 8–15 s; on 2026-10-21 every
one whose outcome stayed unknown settled as created after 41–121 s, and the walk, which stops at an unknown outcome
(two zones must never hold one allocation's VM), made its job wait all of it. So an insert still unsettled 20 s after
it was sent (`RACE_AFTER_MS` in `logic.mjs`, provisional until the tick lines' `inserts` re-size it) starts a second
allocation of the same size: its own row, name and JIT runner, walking the attempts after the pending one in other
zones, another region first, spot before on demand.

- The first allocation keeps waiting on its own operation as before and makes no further attempt: refused after its
  race began, it is abandoned, never walked to another zone. Whichever VM's runner GitHub gives a job to first serves
  it (either may take any job of its repo and size); the other is an unclaimed VM the idle rule removes.
- An allocation races at most once and a race never races. A race starts only once every queued job of the tick has
  made its first launch attempt, and none starts past the tick's budget, with no zone left, or beyond `max_vcpus`: it
  reserves its largest machine like any launch, and pre-launch plans against what is left.
- Only a definite outcome settles an insert. One whose wait call ended before its operation did, still running when
  reconciled, stays eligible for its race, which the launch waits for within the tick.
- An insert whose outcome stays unknown leaves its row `launching` with the insert's send time (`slow`); a race's row,
  and its original's pending insert, are written before the race's insert. Until a later tick reads the end of the
  zone operation, such a row keeps the vCPUs its launch reserved (`reserved`, as recorded then, whatever the placements
  say now) and, while its runner waits, covers a job of its size as its VM would: the next tick, or a launcher
  restarted mid-race, neither launches nor races again for the same job. Those reads go one per zone, a few zones at
  once, within 15 s and beside the cleanup's deletions; a zone not read waits for the next tick, and what was read is
  written before any row is finalized. An insert is matched to its own operation (the link the API gave, else the
  newest sent no earlier than it), never to a walk's earlier attempt in the same zone. A refusal learned that way joins
  the row's `refused`, and a launching row so
  refused is abandoned and its runner unregistered at once: no VM will come. A race starts only once its original's
  pending insert is on the ledger. Overlapping ticks remain the accepted overlap below; there is no strict bound of
  two VMs per job.
- A pre-launched VM and the race of its slow insert fill one slot of the run's shape, the race alone when the original
  is abandoned.
- **To check:** the launcher logs `<instance>: its insert in <zone> is unsettled after 20 s; a second allocation races
  it` (or `no race (<why>)`) and `raced <instance> (<machine>, <spot|standard>, <zone>) against <instance> for job
  <id>`; the tick line lists races in `raced` (`<race> for <original>`), every insert sent in `inserts` (zone, machine,
  provisioning, outcome, seconds from send to settle, null when it never settled), and, of the rows its launches wrote,
  `refusals`, `slow` and `onDemand` as the daily line counts them.

**Overlap.** Two ticks can run at once (Cloud Run can briefly exceed one instance; a deploy overlaps two revisions).
Nothing depends on it never happening: deletes and unregisters treat 404 as done, rows are keyed by allocation and
only move forward, two comments for one allocation converge on the most final, and an over-launch leaves idle runners
that the idle rule removes within `idle_runner_minutes` (about $0.012 for a c3d-8). The project's vCPU quota is the
hard cap.

**The ledger rotates** before GitHub's cap of 2,500 comments per issue (ci-kit#25). The GCE ledger is every open
issue in `SSFSKIM/ci-kit-sandbox` titled "pool ledger" or "pool ledger from <YYYY-MM-DD>"; the highest-numbered is
current and takes new rows. At 2,000 comments the launcher opens the next one (its body names the one it continues),
and it closes an older one once nothing on it changed in the last 26 h and its successor is 26 h old. A row stays on
the issue it was written on and is finalized there. For history, search the sandbox's issues, closed ones included,
for "pool ledger".

**Preemption** is recorded, not re-run. GCE deletes a preempted spot VM (its termination action), GitHub fails the
job, and the launcher finalizes the row `preempted` with the job the runner held, which it wrote on the row while the
job ran. Re-run it, for example with `ci-gate` again. GitHub's conclusion is `failure`, the same as a red test's,
not `cancelled`: the runner gets the guest's shutdown, so the job's annotations read "The operation was canceled."
and "Process completed with exit code 130.", and its log "The runner has received a shutdown signal" (A13's
simulated preemption, sandbox run 38927837115). A job that hits its `timeout-minutes` also reads "The operation was
canceled.", beside "has exceeded the maximum execution time". So a reader that must tell a preemption from a red
test goes by the runner (`ci-kit-gce-*`) and those annotations, or by the ledger's `preempted` row, which names the
job.

Every resource carries a `ci-kit` label: `gce-builder` (builders and smoke VMs, with `ci-kit-run=<run id>` and
`ci-kit-role`), `gce-image` (images, with `ci-kit-commit` and `ci-kit-ready`). The bake selects by label and checks
the label again before it acts.

**Credentials.**
- The App key used by the cloud launcher and bakes lives in Secret Manager: `ci-kit-app-id` and `ci-kit-app-key`, labelled
  `ci-kit=app`, with an explicit secret-level accessor grant to
  `ci-kit-launcher@ssfskim-ci-kit.iam.gserviceaccount.com` (project owner/admin access may be inherited). Both
  `ci-kit-bake` and `ci-kit-bake-check` use this identity too, including their EC2 stages. Operator tools
  `gce/tools/boot-sample.mjs` and `gce/tools/app-hook.mjs` also read the pair through gcloud credentials.
- The documented fingerprints distinguish the two App keys (GitHub App settings → Credentials → Key pairs):
  `SHA256:yj//oTVKm3OJamD12RO3JYnGFdQxzGoFYRmFkD90cYU=` is the GitHub-secret key, also embedded in the retired
  Hetzner snapshots; `SHA256:qQgu9FOJPM9maxPvDhd8nV+AyYS+tXW6+mp2RGiXvAg=` is the Secret Manager key, added
  2026-10-16. The EC2 guard and sandbox history/probe workflows still need the former: update their repository
  secrets before revoking it, if the owner elects to rotate that key. Deleting retired snapshots alone does not
  rotate a key.
- **Writing Secret Manager is a human-only step on this machine.** The agent's permission classifier refuses
  secret-store writes, so a rotation goes to the human from the start: generate a new key on the App's Key pairs
  page, then, with the `.pem` in a 0600 file under `mktemp -d`,
  `gcloud secrets versions add ci-kit-app-key --project=ssfskim-ci-kit --data-file=<file>`, then remove the file.
  The launcher caches the PEM at process startup: restart/redeploy it (for example, `gce/deploy.sh launcher`)
  and verify the new revision serves a successful tick before revoking the old key. New bake/check executions
  read the latest version; let any old-key executions finish before revocation. No image rebuild is needed
  solely for App-key rotation. Rotation itself is the owner's decision, not a prerequisite for retiring a provider.
- The webhook secret, `ci-kit-webhook-secret` (label `ci-kit=webhook`), has an explicit secret-level accessor
  grant to `ci-kit-webhook@ssfskim-ci-kit.iam.gserviceaccount.com`; creating and rotating it are the owner's (The webhook,
  above).
- No VM gets a service account or a key. The builder gets a one-hour installation token, narrowed to reading
  the served repositories' contents (`bakeScope` in `pool/bake/manifest.mjs`), in its metadata; the image is made from its disk, never
  from its metadata.

**The network.** Every builder, smoke VM and job VM sits on its placement's subnetwork of the VPC `ci-kit`
(`network` and each placement's `subnetwork` in `gce.json`: `ci-kit-us-central1`, 10.64.0.0/20, and `ci-kit-us-west4`,
10.64.16.0/20; M6's new regions take the next free /20s when `gce/deploy.sh network` runs with them, `ci-kit-us-east1`,
`ci-kit-us-east4` and `ci-kit-us-east5` in that order, 10.64.32.0/20, 10.64.48.0/20 and 10.64.64.0/20 on today's
network). How a VM reaches GitHub, apt, npm and Docker Hub is `gce.json`'s `egress`, a commit on main read by the
next tick (the bake's, by the `gce.json` bundled at its deploy):
- `"external"`, the default when the key is absent: each VM takes an ephemeral external IPv4, priced on its ledger
  row. Each counts against its region's `IN_USE_ADDRESSES` quota (Quotas and budget), whose refusal is a quota
  refusal: the walk goes on to the next placement.
- `"nat"`: no VM has a public IP. Each subnetwork has Private Google Access, so Google APIs are reached without one,
  and all other egress goes through the region's Cloud NAT, `ci-kit-nat` on the Cloud Router `ci-kit-router` (spec
  2026-10-21 M6). The NAT allocates its own addresses as needed, so the address quota does not bound the pool; it
  covers every range of the region's subnetworks, gives each VM 1024 ports to 65536 by dynamic allocation (pnpm and
  apt open many connections at once), and logs dropped connections only, which `gce/deploy.sh alert` mails.

The NAT is parked since 2026-10-21: behind it, GitHub's runner endpoints (`pipelines*.actions.githubusercontent.com`)
refuse or stall the runners' first connections in a burst. In a 20-VM burst the median from boot to "Connected to
GitHub" was 54–70 s behind the NAT, whether 1, 3 or 11 NAT addresses carried it, against 12 s with external
addresses. So `gce.json` says `"egress": "external"`; the routers, NATs and Private Google Access stay deployed, so
switching back is that one value.
The VPC has no firewall rule: GCE's implied rules deny all ingress and allow all egress. The project's `default`
network is never used, since its stock rules open ssh and RDP to the internet. `gce/deploy.sh network` creates the
VPC, a subnetwork for each placement of `gce.json` (a new one takes the first free /20 of 10.64.0.0/16,
`gce/subnets.mjs`; an existing one keeps its range and gets Private Google Access if it lacks it), and a router and NAT
in each placement region (an existing NAT is updated to these settings), all idempotently, never deleting anything;
it fails if any rule allows ingress into `ci-kit`. Networks, routers and firewall rules take no labels; the names
carry the kit's. To check:

```
gcloud compute networks list --project=ssfskim-ci-kit
gcloud compute networks subnets list --project=ssfskim-ci-kit --network=ci-kit --format='table(name,region,ipCidrRange,privateIpGoogleAccess)'
gcloud compute routers nats describe ci-kit-nat --router=ci-kit-router --region=us-central1 --project=ssfskim-ci-kit
gcloud compute firewall-rules list --project=ssfskim-ci-kit --filter='network~/ci-kit$'   # expect: none
```

A VM short of NAT ports shows as an error entry in the NAT's log (`resource.type="nat_gateway"`) and as
`dropped_sent_packets_count` with reason `OUT_OF_RESOURCES` in its Cloud Monitoring metrics.

**The bake.** From the Mac (gcloud's default account), at a commit pushed to GitHub:

```
CI_KIT_COMMIT=$(git rev-parse HEAD) node gce/bake/bake.mjs     # default commit: the kit's main
```

1. It deletes builders and smoke VMs any bake left more than 4 h ago (`STALE_MS`, above the bake job's 180-min task
   timeout, so a bake still running is never swept).
2. It creates `ci-kit-gce-builder-<run id>` (the run id is UTC seconds plus four random characters, so two bakes never
   share one; on demand: `e2-standard-4`, else `n2d-standard-4` when E2 is refused, on `pd-balanced`; the placements
   and their zones in `gce.json` order) from `ubuntu-2404-lts-amd64`. Its startup script (`gce/bake/builder.sh`)
   installs Docker, clones the kit at the commit, runs `pool/bake/prepare.sh` (Node, the runner image, the caches),
   requires every declared package/script apply to succeed (cache warming is best effort), installs and enables `ci-kit-gce-job.service`, cleans the disk, reports
   `ci-kit/bake=ok` (or `failed:<step>`) as a guest attribute, and powers off. GCE deletes a builder still running at
   45 min.
3. Only on `ok` and power-off within 30 min, it images the builder's disk into the family, labelled
   `ci-kit-ready=false`, and deletes the builder.
4. In each placement in turn it boots `ci-kit-gce-builder-<run id>-smoke-<n>` from the image on the placement's
   subnetwork and disk type, on its `cpus-2` machine (the next size's when that is refused), with metadata
   `ci-kit-smoke=<vCPUs>` in place of a JIT config. A placement whose smoke VM no zone or machine takes (capacity or
   quota refused every attempt; C4D us-central1 had no capacity even on demand on 2026-10-21) is skipped, logged as a
   `warning:` naming it and listed again on the bake's last line; a smoke VM that boots and fails its checks fails the
   bake. An image that does not boot on a machine family of `gce.json` is never ready: every family needs a smoke VM of
   that family to pass in at least one placement (a smoke proves the machine it booted, not the rest of its
   placement's map), so a family whose every placement was skipped fails the bake. The job
   unit runs `gce/vm/smoke.sh` in a job container: vCPUs, user, isolation, the runner, Node 22
   and 24, the work directory, DNS, egress, and the metadata server refused. It reports
   `ci-kit/smoke=ok|failed:<check>` and powers off.
5. It runs the real job on a VM booted from the image in the first placement that takes it. When every family's
   smoke and the real job passed, the image is labelled `ci-kit-ready=true`; the launcher uses only ready images (never
   `getFromFamily`, which would return an unready one). On any failure the bake deletes its own image.
6. On every exit it deletes its instances, and keeps the two newest ready images (unready images of other runs
   are dropped once 4 h old). It deletes an image only while that image carries its `ci-kit-run` label: an image
   insert refused because the name exists leaves the existing image alone.

The Cloud Run job `ci-kit-bake` runs the same script as `ci-kit-launcher@`, at main's head, with the `gce.json` it was
deployed with (not main's: a placement change reaches the bake through `gce/deploy.sh bake`): `gce/deploy.sh bake`
deploys it, and `gce/deploy.sh bake-schedule` adds the weekly run (Sunday 18:00 UTC). To run it now:
`gcloud run jobs execute ci-kit-bake --region=us-central1 --project=ssfskim-ci-kit`. The first ready image,
`ci-kit-runner-20261016-100502-b4fc88e2`, was baked from the Mac (2026-10-16, 12.5 min: builder 8 min, image 1 min,
smoke 2.5 min).

**Per-repository job images (GCE and EC2).** The orchestrator resolves each served repository's default revision
and setup hash once, into `repos` in `/etc/ci-kit/bake-manifest.json`. Both builders fetch those exact commits with
a contents-read token scoped to the served repositories. The Docker metadata firewall is installed before these
clones; each container proves IPv4/IPv6 metadata and the IMDSv2 token endpoint unreachable and the clone's git config
credential-free before applying any repository code. The token exists only in the host's fetch environment.

`pool/bake/job-images.mjs` runs each declaration as `runner`, using the runner's bundled Node 24 for the applier.
The declaration's Node comes from the pinned tool cache (major 22/24 or the exact cached version); an unsupported
version fails rather than using a different runtime. pnpm shims are private to the container, backed by corepack.
The first container applies packages and the script and is committed as `ci-kit-job/<owner>-<repo>:latest` with
`CI_KIT_SETUP_HASH` in its environment and label. The runner entrypoint and working directory are restored on commit.
The second container also runs `setup.install` to warm shared caches and is never committed; its failure is best effort.
An apply failure fails that provider's bake. No separate project-specific warmer or warm-record requirement remains.

Each manifest entry records `apply: {ok, image_bytes}` (`image_bytes` is additional bytes above the shared base)
and `warm: {ok}`. Only the resolved inputs must match between providers, not layer sizes or warm results. Builders
log total and additional sizes; orchestrator logs include the additional bytes and apply/warm outcome. More than
1 GiB above base is a signal to consider separate VM disks, not an automatic rejection.
GCE records `ci-kit-setup-<owner>-<repo>=<hash>` labels (lowercase, punctuation normalized to `-`); AMIs also record
`ci-kit-setup:<owner>/<repo>=<hash>` tags. The manifest and cloud records contain infrastructure pins and per-repository declarations only.
Older ready images remain usable: launcher selection depends on provider readiness, not removed manifest fields.
The VM code ships inside its image; new host checks tolerate older manifests, and missing repository images fall
back to `ci-kit-runner`. The setup action then installs any missing declaration at job time. Base smoke checks only
ci-kit infrastructure; each declared job image is smoked separately by reapplying its declaration in job mode and
requiring no installs. Warm failures may make the first job slower but do not invalidate an otherwise satisfied image.

Only pristine smoke inputs are retained under `/var/lib/ci-kit/setup-sources/<owner>-<repo>/`, outside the job
images and shared cache: the exact `.github/ci-kit.yml`, the declared `setup.script` bytes at that path (if any),
and an empty Git repository carrying the clone's original local config for the credential audit. No cloned objects,
index, history, other source files or install artifacts survive there. In-tree input symlinks are materialized as
bytes; links outside the checkout fail the bake rather than reading the builder's files. Apply and warm still share
a **full disposable checkout** under the cache's `work/`; smoke gets a disposable copy of the retained inputs.

This set covers what `applySetup` reads in job mode without `install`, and preserves the setup hash: normalized
package lists, Node, pnpm, install command, script path and script bytes. The install command is hashed but not run
by smoke; package manifests and lockfiles are not hash inputs. A script still runs in smoke. If it needs other
repository files in job mode, smoke **fails** rather than skipping the script, fetching another clone or keeping the
whole repository. Keep its satisfied check self-contained (put dependency installation in `setup.install`); otherwise
its unhashed dependencies would not be covered by the image identity. Apply/warm may use the full repository.

On both providers, the host launches each job image with `gce/vm/smoke.sh --setup`: the retained declaration and
image environment/label must match the manifest hash, and setup in job mode must install nothing. These containers
have no Docker socket or host credentials; the host launches them separately before the original base-image checks.
A builder logs `ci-kit bake: <repo> retained smoke inputs: <after> bytes (was <before>; removed <difference>)`
(logical file bytes, including Git packs before trimming), followed by the usual layer sizes and apply/warm results.
Each smoke VM must still log `ci-kit smoke: <repo> setup <hash>: installed nothing` for every declaration. For #154,
compare EC2's `snapshot full written size` with 11.698 GiB: removing the retained full checkouts should save about
2.2 GiB (roughly 9.5 GiB afterwards), with job layers and warmed caches unchanged. Snapshot allocation/compression
means the source-byte log is not an exact prediction; measure both providers' next bake before claiming that saving.

### Selecting a repository's job image (M4)

This completes the separate deployment described above. The launcher passes the job's `owner/name` as GCE
metadata `ci-kit-repo` or EC2 user-data `repo`. Before starting the runner container, the VM inspects the local
`ci-kit-job/<owner>-<repo>:latest` image (the bake's lowercase, punctuation-normalized name). If it exists, the
job uses it only if its `CI_KIT_REPO` label matches `owner/name` case-insensitively; otherwise it uses
`ci-kit-runner:latest`. The bake writes that identity label beside `CI_KIT_SETUP_HASH`, since normalized tags can
alias different repository names. Older, unlabeled images also fall back to the base, and the image-choice log
names the fallback reason. No repository is also a base-image fallback, for VMs
started by an older launcher. Smoke still checks the base container and each
repository image separately.

The VM logs `job image <name>` before starting Docker. This is in its **serial console**, before the Actions
runner connects; the setup comparison and installation summary are in the **Actions job log**. Docker inherits
`CI_KIT_SETUP_HASH` from the selected image, never from the host. A missing or older repository image is only a
cache miss: the job's setup action applies its checked-out declaration.

**Rollout and proof (coordinator only).** From merged main, deploy `gce/deploy.sh launcher` and execute a bake
whose kit commit includes this change. Wait for ready images on both providers. Either order is safe:
launcher-first VMs running old guest code keep using the base; image-first VMs receive no repository from the
old launcher and use the base. A new guest on a disk lacking that repository's image also uses the base.
No `v1` move is needed for this milestone; the setup action is already published.

For a small proof, use a scratch ci-kit-sandbox branch from its default branch. Keep its declaration unchanged
(`apt: [cowsay]`) and add a pool gate named `setup-proof` (`lane: pool`, `cpus: 2`, setup enabled) whose command is
`/usr/games/cowsay setup-proof`. Commit and run `ci-gate . --gates setup-proof` in that worktree. Capture the
runner name from `gh api repos/SSFSKIM/ci-kit-sandbox/actions/runs/<run>/jobs --jq '.jobs[] | [.name,.runner_name]'`.
The VM console must name `job image ci-kit-job/ssfskim-ci-kit-sandbox:latest`; the Actions log must show
`ci-kit setup: image matches setup <hash>`, then a summary with `installed nothing` in under 10 seconds.

On the same scratch branch, change only the declaration to `apt: [cowsay, figlet]` and the gate command to
`figlet setup-proof`. Commit and run the same gate again, without merging or baking the branch. Its VM must
still name the sandbox job image. The Actions log must show
`::notice::ci-kit setup: image setup <baked-hash> differs from commit setup <branch-hash>; applying declaration`
and a summary naming `installed apt:figlet`, followed by the successful command. Inspect the raw job log if the
Actions UI renders the notice as an annotation. `gh run view <run> -R SSFSKIM/ci-kit-sandbox --log` retrieves the
setup output. MAWS on its default declaration is an equivalent matching-image proof.

Capture VM console evidence while the VM exists: on GCE, `gcloud compute instances get-serial-port-output
<runner-name> --zone=<zone> --project=ssfskim-ci-kit`; on EC2, `aws ec2 get-console-output --instance-id <id>
--latest --region us-east-2 --profile ci-kit-ops` (the API's `Output` is base64). GCE's retained Cloud Logging
query is documented below. Correlate each VM to the Actions runner name, not just its image generation; EC2
instances have `ci-kit-alloc=<runner-name without ci-kit-ec2->`. A provider image becoming ready proves its
smoke, not a job's hash comparison: retain both the console and Actions evidence.

**Hourly declaration check (GCE and EC2).** `ci-kit-bake-check` runs the same source as the bake, with
`CI_KIT_BAKE_IF_STALE=1`, as `ci-kit-launcher@ssfskim-ci-kit.iam.gserviceaccount.com`. Its timeout is the bake's
(180 minutes plus 120 per configured EC2 account). `ci-kit-bake-check-hourly` invokes it at minute 23 of every hour,
UTC. The weekly bake and manual `ci-kit-bake` executions remain unconditional; their job and weekly cadence are unchanged.

Before comparing anything, the check lists **both** jobs' executions, excluding itself. A pending/running execution
makes it log `bake: skipped; <execution names> still running` and exit successfully. This is a preflight check, not
an atomic lock: do not manually start a bake alongside a check. The check needs `run.executions.list`; deployment
grants its service account `roles/run.viewer` on both jobs, plus `roles/run.invoker` on the new job for Scheduler.
A failed listing fails the check rather than starting an unguarded bake.

It reads every served repository in its bundled `pool/config/gce.json` using the App's contents-read token. Config
and script bytes come through the contents API at one pinned default-branch commit, using the same resolver and
`setupHash` as a bake. Missing config or no declaration is `none`, matching an absent image label/tag. It compares
against the newest **ready** GCE image in the configured family and the newest available, ready pool AMI in **every**
configured EC2 account (disabled accounts still receive bakes). A missing ready image is stale. API/validation
failures are errors, not missing declarations. All equal logs `bake: images current` and exits without resolving the
full bake manifest or making a builder. Otherwise each changed repository is logged as
`bake: stale <owner/repo> on <gce|ec2/account>: <image hash> -> <default-branch hash>` (a missing provider image logs
`bake: stale <provider>: no ready image`), then this same execution continues through the ordinary bake. The bake
resolves its inputs afresh, once for both providers; a declaration merged during the check is therefore included.

Deploy **from merged main**, by the coordinator; no `v1` move is needed for the scheduler path:

```
gce/deploy.sh bake-check bake-schedule
# deploy: bake check job ok (execution reads on both bake jobs)
# deploy: bake schedule ok
# deploy: bake check schedule ok (hourly at minute 23 UTC)
```

This adds the check job and both execution-read grants without redeploying `ci-kit-bake`. `bake-schedule` converges
the existing weekly schedule to its unchanged settings and adds the hourly one. After future bake-code or bundled
config changes, deploy both `bake` and `bake-check` so they keep the same source/config.

Proof, under the bake's own identity (the check runs in Cloud Run, never `node ...` as an operator):

1. Merge a ci-kit-sandbox default-branch change from `apt: [cowsay]` to `apt: [cowsay, hello]`, leaving the rest of
   its config intact. Record that commit. Let the hourly schedule fire; do not manually dispatch a bake. To test only
   invocation/IAM ahead of the timed proof, `gcloud scheduler jobs run ci-kit-bake-check-hourly --location=us-central1
   --project=ssfskim-ci-kit` invokes the same job as Scheduler's service account.
2. List the execution and read its log (set `EXECUTION` to that execution's short name):
   ```
   gcloud run jobs executions list --job=ci-kit-bake-check --region=us-central1 --project=ssfskim-ci-kit
   gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="ci-kit-bake-check" AND labels."run.googleapis.com/execution_name"="'"$EXECUTION"'"' \
     --project=ssfskim-ci-kit --freshness=2h --order=asc --format='value(textPayload)'
   ```
   Expect `bake: stale SSFSKIM/ci-kit-sandbox on gce: <old> -> <new>` and the EC2 equivalent, then
   `bake <run>: kit ...`, the normal smoke/real-job records, and
   `done: every configured provider passed smoke and its real sandbox job`. Both newest ready images must carry
   `<new>` (not just a successful execution):
   ```
   gcloud compute images list --project=ssfskim-ci-kit \
     --filter='family=ci-kit-runner AND status=READY AND labels.ci-kit=gce-image AND labels.ci-kit-ready=true' \
     --sort-by='~creationTimestamp' --limit=1 --format='json(name,labels)'
   aws ec2 describe-images --owners self --profile ci-kit-ops --region us-east-2 \
     --filters Name=tag:ci-kit-pool,Values=ec2 Name=tag:ci-kit-ready,Values=true Name=state,Values=available \
     --query 'sort_by(Images, &CreationDate)[-1].{ImageId:ImageId,Tags:Tags}'
   ```
   Read `ci-kit-setup-ssfskim-ci-kit-sandbox` in GCE labels and `ci-kit-setup:SSFSKIM/ci-kit-sandbox` in AMI tags.
3. The first hourly execution **after that bake completes**, with no declaration change, must log
   `bake: images current` with no `bake <run>: kit ...` or new images. An intervening hour while the bake is still
   running instead logs the skip. Finally merge removal of `hello` (restore `[cowsay]`) and repeat steps 2–3: removal
   must also rebuild and settle to current. Record execution names, image IDs and both hashes.

**Checking for leftovers.**

```
gcloud compute images list --project=ssfskim-ci-kit --filter='family=ci-kit-runner' --format='table(name,status,labels)'
gcloud compute instances list --project=ssfskim-ci-kit --filter='labels.ci-kit:*'
gcloud compute disks list --project=ssfskim-ci-kit --filter='labels.ci-kit:*'
```

**The boot** (spec M3). Job VMs boot without cloud-init. Its network stages were ordered before `sysinit.target`,
which every service waits for, Docker and the job unit included, and they took 5–10 s of every boot. The builder
disables it (`/etc/cloud/cloud-init.disabled`; the builder itself, stock Ubuntu, still ran it) and replaces what a job
VM needed from it:
- the network: the netplan cloud-init wrote matched the builder's MAC address only; `/etc/netplan/90-ci-kit.yaml` runs
  DHCP on any `en*` (or `eth*`) interface, which covers virtio-net and gVNIC (C3D's comes up as `ens3`);
- the root's growth: the image is the builder's 30 GB disk and a job VM's is `disk_gb`. `ci-kit-gce-instance.service`
  (`gce/vm/instance.sh`, which the job unit requires) runs `growpart` and `resize2fs`, and names the host after the
  instance (the builder's `/etc/hostname` is emptied). It prints `ci-kit instance (up <s> s): root <size> on <disk>,
  hostname <name>` to the console.

The console runs at 115200 baud (about 11.5 KB/s), and rsyslog forwards the boot's journal backlog to it once it
starts, so a journal line reaches the console 20 s and more late, and the VM powers off before most of them arrive.
The instance and job units therefore write to the console directly (`StandardOutput=journal+console`); their lines,
the runner's included, carry the uptime in the kernel's stamp. Measured on c3d-highcpu-4 (5 jobs per image,
`gce/tools/boot-sample.mjs`, 2026-10-21): RUNNING → job started fell from a median of 31.4 s to 16.3 s. About 6 s
of it passes before the kernel starts (firmware); the guest reaches its job unit at 5.2–5.8 s of uptime and the runner
listens about 3 s later. The rest is GitHub's: connecting and assigning the job took 1–2 s in most samples and up to
11 s in some.

The guest agent, not cloud-init, serves the metadata and guest attributes. snapd is purged (no job uses a snap, and it
seeded itself on the first boot of every disk made from the image) and pinned out.

`gce/deploy.sh base` turns on the project's serial port logging to Cloud Logging, so a deleted VM's boot
can be read there:
`gcloud logging read 'logName="projects/ssfskim-ci-kit/logs/serialconsole.googleapis.com%2Fserial_port_1_output" AND resource.labels.instance_id="<id>"' --project=ssfskim-ci-kit`.

**The job VM.** At boot, `ci-kit-gce-job.service` runs `gce/vm/job.mjs`: it drops the job container's TCP and UDP
to `169.254.169.254` except port 53 (GCE's resolver lives there), runs one job container from
`ci-kit-runner:latest` on all of the VM's vCPUs with the shared container mounts and environment and the JIT
config from metadata `ci-kit-jit`, reports `ci-kit/job=exit:<code>`, and the unit powers the VM off at once
(`poweroff-immediate`: no orderly shutdown, since the disk is discarded; an orderly one took about 85 s). A VM with no
`ci-kit-jit` and no `ci-kit-smoke` reports `ci-kit/job=failed:no-jit` and powers off. Every VM needs metadata
`enable-guest-attributes=TRUE` for the reports.

**What a job sees** (measured in MAWS's `e2e:desk-web` job 117619513767 on c3d-highcpu-4, 2026-10-18, image
`ci-kit-runner-20261017-102843-n8tx-dbd88509`):
- The user `runner` with passwordless sudo (the actions-runner image's), so `apt-get` works. Playwright's
  `install --with-deps chromium webkit` installed 211 packages in 24 s.
- `/proc/sys` is read-only. `sudo sysctl -w` prints "ignoring: Read-only file system" and exits 0, so a kernel
  setting a job lifts is a silent no-op, not an error.
- `PLAYWRIGHT_BROWSERS_PATH` holds Chromium, its headless shell and ffmpeg at the revisions of the Playwright that
  MAWS's lockfile pinned when the image was baked (1.63.0: Chromium 1243). A job at that version downloads no
  Chromium; one at another version downloads its own, and WebKit, never baked, downloads in about 4 s.
- `xvfb-run` and `xauth`, and a 2 GB `/dev/shm`.
- The VM's whole memory, with no container cap, and about 39 GB of the 50 GB disk free. The desk-web job peaked at
  2.9 GB used, more than an e2-highcpu-2 (`cpus-2`) has, so MAWS runs it on `cpus-4`.

**Deploy.** From a clean checkout of a commit on GitHub, with gcloud's default account (an owner of the project):

```
gce/deploy.sh                       # every part, in order; or name parts:
gce/deploy.sh base network          # APIs, the service account and its compute role, serial port logging; the VPC, its NATs
gce/deploy.sh bake bake-schedule    # the Cloud Run job ci-kit-bake and its weekly Scheduler job
gce/deploy.sh launcher launcher-schedule   # the Cloud Run service ci-kit-launcher and its one-minute tick
gce/deploy.sh webhook               # the receiver ci-kit-webhook, its Pub/Sub topic and push subscription
gce/deploy.sh alert                 # log-based metrics and alert policies mailed to the owner (below)
gce/deploy.sh app-hook              # not in "every part": the App's webhook URL and secret (The webhook, above)
```

Every part is idempotent. `launcher` and `webhook` each end by sending all of their service's traffic to the revision
just deployed (`update-traffic --to-latest`) and checking that it serves, and fail naming what does if not: a manual
rollback (`gcloud run services update-traffic <service> --to-revisions=<old>=100`) pins traffic by name, and
`gcloud run deploy` alone would then leave the new revision at 0% while the script said ok. Their `ok` line names the
serving revision. `base` also gives the project's default compute account `roles/run.builder`: Cloud Run
source builds run as it in a project created after 2024, and no kit VM uses it. Both Cloud Run images are
buildpack builds, so their command is the CNB `launcher` (`launcher node <script>`), which puts the image's node on
the PATH. If every gcloud call stalls for minutes on the MacBook, its IPv6 route to Google is down (2026-10-16:
`curl -6 https://run.googleapis.com/` timed out, `-4` answered at once) and gcloud's Python waits out each IPv6
connect; a `sitecustomize.py` that filters `socket.getaddrinfo` to `AF_INET`, on `PYTHONPATH` with
`CLOUDSDK_PYTHON_SITEPACKAGES=1`, gets it through. `launcher` builds from the checkout (Cloud Build, buildpacks) and records its commit as
`CI_KIT_COMMIT`; the service reads its configs from main whatever commit it runs, so a config change needs no
deploy. To pause the launcher: `gcloud scheduler jobs pause ci-kit-launcher-tick --location=us-central1
--project=ssfskim-ci-kit` (and `resume`). Its logs: `gcloud run services logs read ci-kit-launcher
--region=us-central1 --project=ssfskim-ci-kit`; each tick logs one line with what it launched, deleted and
finalized, the gce.json commit it ran (`config`), its GitHub budget, when it started (`started`) and when it sent its
first insert (`firstInsert`, null when it launched nothing), what asked for it (`trigger`: `scheduled` when the
minute tick is among its requests, else `requested`) and how many requests it served (`requests`).

**Reading the GCE ledger.** The pool ledger issue in `SSFSKIM/ci-kit-sandbox`, one comment
per allocation:

```
| alloc | instance | repo | job (actual) | created (UTC) | deleted (UTC) | machine@zone | spot/standard | seconds | $ | end |
```

- The deleted column reads `launching` (before the VM exists), `running`, or `deleting <time>` until the row is
  final. A row never moves back.
- `job (actual)` is the job the runner held, by name and id: a runner takes any queued job of its repo and size,
  so it may not be the one the launch was for. A pre-launched VM's says so (`pre-launched for run <id>`, and
  `unclaimed` while it held no job), and its JSON keeps `prelaunch` (run, attempt, workflow). Since M3 the row's JSON also keeps the job's run (`job.run`), its
  workflow path (`job.workflow`) and GitHub's queued and started times (`job.queued`, `job.started`), and the VM's
  RUNNING time (`running`, Compute Engine's `lastStartTimestamp`); the size is `cpus`.
- `node gce/latency-report.mjs [--since <ISO>] [--until <ISO>] [--repo <owner/name>]` (default: the last 24 h) reads
  the rows and the launcher's tick lines (Cloud Logging, gcloud's default account) and prints the median and p10–p90
  of each stage of a job's wait: queued → next tick, tick start → insert accepted (the tick's first VM's
  creation), tick start → first insert sent, insert accepted → RUNNING, RUNNING → job started, insert accepted →
  job started (M3's target, each VM's own), and queued → started; then the VM stages again for each machine type;
  then pre-launch's: how many VMs were pre-launched and how many a job claimed, each claimed VM's insert accepted →
  its job queued when the job is of the run it was launched for (positive: the VM was on its way first, M5's proof),
  and queued → started of the pool jobs of pre-launched runs beside every other run's (Acceptance 5).
  Rows on rotated ledger issues closed since the window began are read too. A row or tick without a stage's fields
  (written before M3) is left out of that stage.
- `node gce/tools/boot-sample.mjs --image <name> [--region <r>] [--family <f>] [--machine <m>] [--count 5] [--parallel 2] [--out <dir>]`
  times job VMs from an image through the bake's real-job path (one `bake-check` job per sample in ci-kit-sandbox,
  on its own JIT runner) in one placement: the first in `--region` (default: any) of `--family` (`c4d`, `c3d`) that
  names `--machine`, so `--region us-central1 --machine c3d-highcpu-4` samples C3D there, not the C4D placement before
  it; on its zones, subnetwork and boot disk type, with `--machine` (default: its size-4 machine). It reports insert accepted → RUNNING → job started, keeps each
  sample's console and `ci-kit/job` report, and gives the median and range of each stage. It shares the pool's quota and stops at the first quota refusal;
  every VM and runner it made is gone when it ends.
- `end`: `done` (its job ended, or its runner did), `cancelled-idle` (no job came within `idle_runner_minutes`, or
  its repo stopped being served), `preempted`, `max-run` (Compute Engine's run limit, or the launcher's overage
  rule), `abandoned` (no VM was created: every zone refused, quota, or a crash before the insert), `orphan` (a VM
  the launcher had no row for, or one that vanished before its run limit with no preemption recorded: deleted by a
  hand outside the launcher).
- `seconds` runs from the VM's creation to its deletion, `$` at the rates in `gce/launcher/ledger.mjs` by region and
  family (c3d and e2 in us-central1, 2026-10-16; c4d in us-west4, and M6's c4d in us-central1, us-east1, us-east4
  and us-east5 and c3d in us-east1 and us-east4, the Cloud Billing catalog on 2026-10-21, SKU ids beside the table),
  its egress (its external IPv4, $0.0025 an hour on spot and $0.005 on demand; or under `nat` its
  hours of its region's Cloud NAT gateway, $0.0014 an hour, the NAT's GB processed and its addresses being per region,
  not per VM, and going on the daily line with M6's counts) and the disk by region and type included (Hyperdisk Balanced with the IOPS and throughput its defaults provision above the free baseline). A
  VM in a region, family or disk type with no rate there shows `-`. The row's JSON carries the disk type (`diskType`; a row without one is from before placements,
  on `pd-balanced`) and the egress its VM launched with (`egress`, which prices it whatever `gce.json` says by its
  end; a row without one is priced by the config's).
- The daily line, `**GCE pool, <day> (UTC):** …`, totals the day's VMs, seconds and dollars, projects the month at
  that rate, gives each family@region's VMs and dollars (and how many it could not price), on a day with
  pre-launches how many VMs were pre-launched, how many no job claimed and what those cost (`Pre-launched: N VMs, M
  unclaimed ($x)`), and names the gce.json commit the launcher ran.
- Since M6 the daily line also counts, on a day that has any: the walks' refusals of the day's final rows by kind,
  quota metric and zone (`Refusals: quota C4D_CPUS us-west4-a 2, capacity us-central1-a 1`); their slow inserts,
  those unsettled 20 s after they were sent or never settled, with how many never did and the settle times of the rest
  (`Slow inserts: 3, 1 unsettled, the rest settled in 41, 63 s`); the races launched that day by what was observed of
  each pair (which VM a job claimed first by the jobs' start, `tied` or `unknown` when the starts are equal or missing,
  both, neither, or unresolved while either row is not final; a first claim is not latency saved) and what the pairs' VMs that ran no job cost; and the VMs that ran on demand. Each row's JSON keeps
  its walk's `refused` ({kind, zone, metric}) and `slow` ({zone, outcome, sent, done}) inserts, a slow insert's `done`
  learned from its zone operation by a later tick when its own tick could not wait for it; a race's row keeps `race`
  ({of: the allocation it raced, demand: the job or run that allocation was for}), apart from the job its VM ran.
- The day's Cloud NAT, per region, from Cloud Monitoring (`router.googleapis.com/nat/*` on `nat_gateway`
  `ci-kit-nat`, read once, when the line is posted, from 00:05 UTC: the NAT's samples take minutes to land): GiB processed both ways at $0.045 and address-hours at $0.005
  (`NAT: us-west4 2 GiB, 2 address-hours, $0.1000; $0.1000 in all.`), apart from the VMs' dollars and month. An
  address-hour is counted from `allocated_ports`, one point a minute per NAT address while it holds a VM's ports:
  auto-allocated addresses are released when no VM needs them. A read that fails, or that Monitoring answers only in
  part, shows `NAT: unread`, never a guess;
  the launcher's account needs `monitoring.timeSeries.list` (`roles/monitoring.viewer`).
- A writer reads a row's comment again just before updating it, and drops the write if the comment is already as
  far along; a final row is never rewritten. Issue comments have no compare-and-swap, so during an overlap of two
  ticks a row is eventually final rather than finalized once: a stale write that lands in the milliseconds after
  another tick finalized the row rolls it back to running, and the next tick finalizes it again, possibly with a
  later deletion time and charge.
- The 26-hour window applies to finalized cost history, not non-final allocations. Cold/full reads retain old
  non-final rows across outages and issue rotation, so unknown EC2 inventory cannot release their reservations.
  A failed cloud list is not an empty inventory: that account's allocations stay reserved until observation
  recovers. The independent EC2 guard and guest deadlines remain backstops during a launcher outage.
- Hidden markers `<!-- ci-kit-gce-ledger {…} -->` and `<!-- ci-kit-gce-daily {…} -->` hold the JSON the kit reads;
  historical server-session rows use a different marker and are ignored.

**Quotas and budget.** `max_vcpus` is the launcher's soft cap on the vCPUs of its VMs in flight; the project's
quotas are the hard cap, and a refusal is a wait. Parallelism comes first: the owner ruled on 2026-10-21 that CI must
never be the bottleneck, and that cost is not a reason to lower parallelism. So `max_vcpus` follows the quotas.

The sizing rule: `max_vcpus` is the sum over the placements' regions of what each region can hold at once, the lesser
of its families' granted vCPUs (`CPUS-PER-VM-FAMILY`, summed over the region's placements) and its granted external
addresses times 8. Under `egress: "external"` every VM holds one address, and 8 vCPUs is the pool's mean VM (a MAWS
class 1a run is 50 vCPUs on 6 VMs), so a region of 8 addresses holds about 64 vCPUs whatever its CPU grants. On
2026-10-21 (Cloud Quotas, read-only):

| region | family vCPUs granted | addresses | addresses × 8 | holds |
|---|---|---:|---:|---:|
| us-west4 | C4D 50 | 8 | 64 | 50 |
| us-central1 | C4D 24 + C3D 192 = 216 | 32 | 256 | 216 |
| us-east1 | C4D 24 + C3D 24 = 48 | 8 | 64 | 48 |
| us-east4 | C4D 24 + C3D 24 = 48 | 8 | 64 | 48 |
| us-east5 | C4D 24 | 8 | 64 | 24 |
| | | | `max_vcpus` | **386** |

386 is under `CPUS-ALL-REGIONS` (512), which bounds every region together. Recompute it when a grant changes: an
address raise lifts only the regions whose addresses bind (none today), a family raise its region up to its addresses.
Under `egress: "nat"` no VM holds an address and the sum is of the family grants alone, the same 386 today. Each region also holds a
Hyperdisk Balanced capacity quota (`HDB-TOTAL-GB`: 4096 in us-west4, us-central1, us-east1 and us-east5; us-east4 still
500, ten 50 GB boot disks, above its 8 addresses) and `SSD-TOTAL-GB` for pd-balanced (500 in the east regions, ten
disks). Granted through Cloud Quotas:
- 2026-10-21 (M6): `CPUS-ALL-REGIONS` 512; C4D per-family 24 in us-central1, us-east1, us-east4 and us-east5 (the
  default), C3D 24 in us-east1 and us-east4 (the default); `HDB-TOTAL-GB` 4096 as above; each east region's
  `IN-USE-ADDRESSES` is its default 8;
- 2026-10-21: `CPUS-ALL-REGIONS` 256, C3D per-family 192 in us-central1, `INSTANCES` 64, `SSD-TOTAL-GB` 4096;
  `IN-USE-ADDRESSES` asked 64, still 32 when this was written (each job VM holds one external address under
  `egress: "external"`, so 32 VMs at once in a region until granted; under `"nat"` it holds none);
- 2026-10-16: the first grants;
- never granted: E2 per-family stays at its default 24 (asked 64, refused twice), so at most 12 `cpus-2` VMs run on E2
  and the rest fell back to `c3d-highcpu-4` (`machine_fallback`); E2 has since left the pool with that key.

A job reserves the largest machine its walk could land on in the launcher's count (a `cpus-2` job: `c3d-highcpu-4`).
`max_vcpus` admits only; a placement's own refusal (family vCPUs, addresses, instances, disk capacity) falls through to
the next one, so recompute it by the sizing rule with each grant (C4D us-west4's re-filed 128 was denied 2026-10-21, so
it stays 50).
`PREEMPTIBLE_CPUS` is 0, so spot VMs count against the ordinary CPU quotas. A family's refusal reads `Quota
'CPUS_PER_VM_FAMILY' exceeded.  Limit: 50.0 in region us-west4.`, and the launcher skips only that family there for the
rest of the tick. To check the regional quotas, and the family and all-regions ones (Cloud Quotas only: `regions
describe` does not list them):

```
for r in us-west4 us-central1 us-east1 us-east4 us-east5; do gcloud compute regions describe $r --project=ssfskim-ci-kit --format=json | jq -c --arg r $r '[.quotas[]|select(.metric|test("^(INSTANCES|IN_USE_ADDRESSES|SSD_TOTAL_GB)$"))|{(.metric):.limit}]|add+{region:$r}'; done
for q in CPUS-PER-VM-FAMILY-per-project-region HDB-TOTAL-GB-per-project-region CPUS-ALL-REGIONS-per-project; do curl -4 -s -H "Authorization: Bearer $(gcloud auth print-access-token)" -H 'x-goog-user-project: ssfskim-ci-kit' "https://cloudquotas.googleapis.com/v1/projects/ssfskim-ci-kit/locations/global/services/compute.googleapis.com/quotaInfos/$q" | jq -c '.dimensionsInfos[]|select(.details.value!=null)|{d:.dimensions,v:.details.value}' | grep -E 'us-(west4|central1|east1|east4|east5)|"d":null'; done
```

The billing budget alert on the project ($40, mails at 50/90/100 %) is the billing admin's to create (spec,
Human-only steps). Monitoring alerts (`gce/deploy.sh alert`) mail the owner: `ci-kit launcher ticks failing` when three
ticks fail within 10 minutes; `ci-kit pool VM runners never online` when the launcher logs a VM whose runner never
came online (above); and `ci-kit NAT dropping connections` when a pool NAT drops a connection (The network).

## EC2 and credit preference

The same launcher owns both ephemeral clouds; there is no second queue consumer. `pool/config/gce.json` still
owns the served repos and global physical-vCPU budget. Each repo's optional `providers` list grants accounts
and determines their order; absent means GCE alone. The configured MAWS, ci-kit-sandbox and manim-master lists
name EC2 account `290475840169`, then GCE. Consumer `.github/ci-kit.yml` cannot grant access to an account.
An optional `max_vcpus` on a list entry caps that repo's non-final physical reservations on that instance; there
is no default per-repo cap. Generic labels remain `self-hosted, ci-kit-pool, cpus-N`. Hand-written
`ci-kit-gce`/`ci-kit-ec2` labels restrict a job to its cloud, never bypass its repo's list.

`pool/config/ec2.json` holds accounts, placements and role ARNs. This account uses c8a spot in us-east-2,
zones c → a → b, encrypted 50-GiB gp3 and provisioned initialization at 200 MiB/s. Job instances have no
instance profile and terminate on shutdown. Launcher/bake credentials come from the Google identity through
four-hour STS federation, never stored AWS keys. Cost Explorer alone uses/signs for us-east-1. Adding an
account requires its entry and its own `ec2/setup.sh` run; the bake, billing reader and guard then cover it.
The builder uses on-demand only to stop for CreateImage; there are no on-demand EC2 job candidates.

### Enabling, demoting and disabling

Before first enabling credit preference, run the explicit `ec2/setup.sh --billing-proof` through the federated
launcher role. An operator-profile billing success is not that proof. Failure blocks activation. M6's prepared
config must not reach main/deployment before M5's live image, lifecycle and config-transition acceptance is complete.
Merging provider/credit config onto main changes the launcher's reload input; it is itself an activation step.
Roll out in two stages: first merge/deploy the M6 implementation with production credit still disabled, then
verify the new runtime and its durable billing reading. Only then merge a separate activation-config change
for the repo lists and `credit.enabled`. The old M5 runtime does not consult durable billing, so merging both
stages before deployment would briefly bypass the new policy. If the new runtime has missing/stale readings,
activation still leaves EC2 as overflow until a valid fresh reading permits preference.

Account `290475840169` has a $180 preference budget against $200 credit, `since: 2026-10-23` (including the
spike and bake) and `until: 2027-04-17` (inclusive UTC). While its credit preference is on, its repo-list place
is retained: EC2 spot → GCE spot → GCE standard. When preference ends, only new walks change to GCE spot →
EC2 spot → GCE standard. Existing EC2 VMs finish normally. A repo already listing GCE first stays GCE first;
a repo listing only GCE never uses EC2. An account without a credit block always keeps its configured place.

Preference ends when `credit.enabled` is false, the UTC date is after `until`, AWS `billed_usd` reaches the
budget, or no valid reading for `since` is available / the newest is more than 48 hours old. The launcher logs
one transition per reason/account, including `credit preference off: budget: <account>` and
`credit preference off: stale billing: <account>`. Billing may lag about two days; the $20 margin is an
estimate, not a hard spending cap. Turning preference off makes EC2 overflow, **not disabled**.

To stop new EC2 allocations, set top-level `enabled: false`, or disable that account. Disabled accounts still
observe/reconcile/retire existing VMs and remain guard legs. Do not delete `ec2.json` as an off switch: absence
removes EC2 management and guard legs, leaving non-final reservations held and VMs to their guest deadlines.
Removing a provider from one repo's list likewise changes new admissions only, not existing coverage.

### Durable billing and reports

For each account with credit, `gce/launcher/credit.mjs` reads Cost Explorer's unblended EC2 compute and EC2-Other
charges since the configured start, grouped by record type; credits/refunds cannot hide gross charges. It
refreshes on the next UTC day only after the newest stored reading is at least six hours old. That floor
survives process restarts. Failed refreshes keep the previous reading, retry no more than hourly within the
process, and eventually demote at the 48-hour cutoff. Overlapping processes may make duplicate $0.01 reads;
there is deliberately no distributed lock. Stored readings are reread every five minutes.

Each immutable reading is a comment on `ec2 credit <account>` in the configured ledger repo, never on the
rotating allocation issues. Its fields are `v`, `since`, `billed_usd`, `through` (exclusive billing interval
end) and `read_at`. Readers choose newest valid `read_at`, not last-posted comment; writers retain the newest
20 readings. A late older writer cannot erase a newer reading. Missing issues are created on the first
successful refresh. Allocation finalization never increments AWS billing or controls preference.

From an authenticated checkout, these commands are read-only:

```sh
node gce/cost-report.mjs --since 2026-10-24T00:00:00Z
node gce/latency-report.mjs --since 2026-10-24T00:00:00Z
```

Both support `--until <ISO>` and `--repo <owner/name>`; default is the last 24 hours. Cost reports count finalized
VMs created in that window, grouped by provider/account, with estimated gross dollars and explicit unpriced
counts. Refused allocations are not VMs, and active VM estimates are not yet finalized. For credit accounts,
they also print the window's credit-funded estimate (placements whose `credit_policy` was on), the lifetime
AWS reading and remaining preference budget. This estimate does not claim actual AWS credit application.
Unknown rates or billing never print as zero. The latency report separates VM stages by provider/account and
zone, alongside the existing whole-pool, machine and pre-launch sections. Mixed-cloud daily ledger lines also
name each provider/account; GCE-only daily output retains its established format.

EC2 row estimates include spot compute (60-second minimum), gp3 (its own minimum), IPv4 and the full snapshot's
provisioned-initialization charge per created volume. A first-hour EC2-initiated interruption waives compute,
not disk, IP or initialization. These estimates are not AWS invoices. Interruption notices are telemetry;
only terminal evidence/actual disappearance retires the allocation, as `preempted`. No automatic rerun occurs.

### Independent EC2 guard

`.github/workflows/pool-guard.yml` runs the independent EC2 guard every fifteen minutes. Each configured account, disabled ones included, gets an independent `ubuntu-latest` matrix leg;
an absent file yields none, invalid config fails discovery, and one leg's failure does not cancel the others.
Each leg exchanges GitHub OIDC for that account's guard role, trusted only for
`repo:SSFSKIM/ci-kit:ref:refs/heads/main`, with temporary credentials kept in memory. It cannot launch resources.
Manual dispatch must use main to satisfy that trust:

```sh
gh workflow run pool-guard.yml --repo SSFSKIM/ci-kit --ref main
gh run list --repo SSFSKIM/ci-kit --workflow pool-guard.yml --limit 5
gh run view <run-id> --repo SSFSKIM/ci-kit --log
```

The guard logs every action and only touches pool-tagged resources:

- Expired live instances/volumes are reaped; attached disks require safe instance termination first.
- Job VMs are also reaped when stopped, when their allocation is final (including a late VM after abandonment),
  or when no ledger row exists fifteen minutes after launch. Unattached job volumes are deleted.
- Builder/smoke instances and volumes before their deadlines are protected, including a stopped builder
  waiting for CreateImage. A job's deadline is max-run plus fifteen minutes; builders get two hours, smoke thirty minutes.
- Unready AMIs older than a day and ready generations beyond the newest two are deregistered with their tagged
  snapshots deleted. Retained images protect shared snapshots. Image retention never uses VM deadlines.
- A completed, pool-tagged snapshot older than one day with no surviving owned-image reference is also removed.
  This retries residue after AMI deregistration succeeded but snapshot deletion failed. Both image and snapshot
  inventories must be complete; all owned images (including non-pool, disabled and deprecated images) protect
  their references. Pending snapshots, young snapshots and unknown ages do not establish orphans.

Failed ledger/instance lists cannot establish absent rows/orphan volumes. Independent known inventories still
permit their own deadline/retention cleanup. A still-attached volume after termination is deferred rather than
force-detached, with its id logged. Cron can be delayed, so guest deadlines and launcher cleanup remain active
independent safety mechanisms. Live guard, FIS, budget/stale and MAWS acceptance procedures are in
`docs/doperpowers/specs/2026-10-23-ec2-pool-design.md`; passing tests or deploying the producer is not those proofs.
