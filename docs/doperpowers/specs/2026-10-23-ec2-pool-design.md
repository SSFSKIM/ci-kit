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

To see it, push a MAWS class 1a run through `scripts/ci-gate.sh` and read its pool jobs' runner names. Then read the
launcher's `placed … ec2 …` log lines and the ledger rows.

The first milestone is a measurement. AWS's lazily loaded disks, EC2's boot path and the c8a's real speed on MAWS's
unit job are not known yet. The owner was told that the figures behind the decision are estimates until that
measurement exists.

### What it must not be

- **A second launcher reading the same queue.** Two schedulers would each count the same queued job as demand and
  each launch a VM for it. Pre-launch, the demand count and the concurrency budget stay single (Design, One
  scheduler).
- **A price optimizer.** Placement order is an explicit, configured policy. The owner rejected daily price ranking
  (`docs/doperpowers/specs/2026-10-21-pool-placement-latency-design.md`, Decision Log). "Credit first" is a
  policy switch, not a price signal.
- **AWS first at any price.** The credit makes AWS spot preferable. It never puts AWS on-demand (~$0.43/h for
  c8a.2xlarge) ahead of GCE spot, and EC2 on-demand stays off.
- **A stored AWS secret.** The launcher reaches AWS through federation of its Google identity. No AWS access key
  sits in Secret Manager, in the image or in any config. Secret Manager writes are the owner's alone, and this work
  needs none.
- **A change in GCE behaviour.** With EC2 disabled, the launcher places, prices, logs and ledgers exactly as it
  does today. Existing ledger rows stay readable.
- **ARM.** Graviton (c8g) is cheaper, but it needs an arm64 image and toolchain, which is a separate project.
- **Automatic reruns after an interruption.** As on GCE, an interrupted job is recorded and fails, and reruns are
  the caller's (`docs/pool.md`, Preemption).

## Glossary

- **Provider**: a cloud the scheduler can place VMs in: `gce` or `ec2`. In code, a module behind the interface in
  Interfaces and Dependencies.
- **Candidate**: one concrete way to place one VM: provider, region, zone, machine type, vCPUs, spot or standard,
  image, subnet, disk. The scheduler walks an ordered list of candidates per size.
- **Allocation**: one VM the launcher decided to create, with its ledger row and its GitHub JIT runner. Its id names
  both the runner and the VM.
- **JIT config**: GitHub's just-in-time runner configuration. It is minted per allocation and lets one ephemeral
  runner register with given labels, then take one job.
- **IMDSv2**: EC2's instance metadata service, in its session-token form. A process on the VM reads its user-data
  and spot interruption notices there.
- **User-data**: data attached to an EC2 instance at launch, readable from IMDS. Here it is a small JSON document,
  not a script.
- **Web-identity federation**: AWS STS `AssumeRoleWithWebIdentity`, which trades a Google-signed ID token for
  temporary AWS credentials of a role whose trust policy names that Google identity.
- **Credit preference**: the placement policy under which EC2 spot candidates come before GCE's. It ends at a
  spend threshold or a date.
- **Hydration**: an EBS volume created from an AMI's snapshot fetches each block from S3 the first time it is
  read, so first reads are slow.
- **Zone ID**: AWS's account-independent zone name (`use2-az1`). Zone names (`us-east-2a`) map to ids differently
  in each account.

## Progress

- [x] (2026-10-23 11:2xZ) Survey of the code seam (CI-opt's notes, `reports/ec2-backend-survey.md` in
  ci-analysis; its findings are folded into Design below).
- [x] (2026-10-23 11:0xZ) Spot vCPU quota increase requested: 32 → 256 in us-east-2 (request
  `7548a787be7d4005a3dda9b3359d6cbcS9TGNQLw`, pending).
- [ ] Spec reviewed.
- [ ] M1: the measurement spike, with its verdict recorded.
- [ ] M2: the provider boundary, with GCE behaviour unchanged.
- [ ] M3: the EC2 provider, its image and its one-time setup, serving ci-kit-sandbox.
- [ ] M4: credit preference, reports, guard, the MAWS canary and acceptance.

## Acceptance

Each item is behaviour someone can check. The Concrete Steps give the commands.

1. **No AWS secret.** `gcloud secrets list --project ssfskim-ci-kit` lists no AWS credential. The deployed
   launcher's environment carries only role ARNs. Its log shows `aws: assumed <role> until <time>` after a start,
   and it launches EC2 VMs.
2. **MAWS jobs on EC2.** With the credit preference on and EC2 enabled for MAWS, a MAWS class 1a run's pool jobs
   (static, the unit shards, probes) run on `ci-kit-ec2-*` runners and pass. Each ledger row reads `provider: ec2`,
   with its zone and zone id, `c8a.*`, `spot`, gross dollars and an image id.
3. **Overflow to GCE in the same tick.** When EC2 refuses (vCPU quota full, no capacity in any configured zone, or
   permission denied), the remaining allocations of that tick are placed on GCE. The launcher log shows the EC2
   refusal and the GCE placement for the same allocation id within one tick. Live, this shows when a burst exceeds
   the spot quota. It is pinned by tests either way.
4. **The VM cleans up after itself.** After its job, an EC2 job VM terminates within 60 s of the job's end, and no
   volume tagged `ci-kit-pool=ec2` is left. A VM whose runner never registers is terminated after the idle limit
   (10 min). A VM still running past its run limit (120 min) terminates itself.
5. **The guard reaps what the launcher missed.** An instance tagged as the pool's with no ledger row, or older than
   the run limit plus 15 min, is terminated by the scheduled guard within one period (15 min). So is an unattached
   pool volume or an unready AMI older than a day. The guard's run log names each one.
6. **An interruption is recorded, not rerun.** A synthetic spot interruption on a running job VM (AWS Fault
   Injection Service, `aws:ec2:send-spot-instance-interruptions`) ends that allocation's row `preempted`. GitHub
   shows the job failed, and no rerun is started.
7. **The credit preference ends by itself.** Once the spend checkpoint passes the configured budget, or the
   configured date passes, new allocations try GCE spot first and EC2 after it. The launcher logs
   `credit preference off: <reason>` once. Running VMs are untouched. Setting `credit.enabled: false` in
   `pool/config/ec2.json` and deploying has the same effect.
8. **Reports show both clouds.** `node gce/latency-report.mjs` groups its stages by provider and zone.
   `node gce/cost-report.mjs` prints per provider: VMs, gross dollars, and for EC2 the credit-funded estimate,
   the spend checkpoint and the remaining budget. Unknown rates print as unpriced, never as zero.
9. **GCE unchanged when EC2 is off.** With `pool/config/ec2.json` absent or `enabled: false`, the full launcher
   suite passes, and a class 1a run places on GCE as before.
10. **Images in step.** The EC2 AMI and the GCE image from one bake carry the same bake manifest: ci-kit commit,
    Node versions, MAWS lockfile hash, runner version and warm results. The same smoke suite passes on both.

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

The repos the pool serves stay where they are, in `pool/config/gce.json`'s `repos`. EC2 serves the same repos;
`pool/config/ec2.json` can narrow that with an optional `repos` list, used to canary on ci-kit-sandbox first. No
repo changes owner.

**Runner labels.** EC2 runners register with `self-hosted, ci-kit-pool, cpus-N, ci-kit-ec2`. GCE's keep
`ci-kit-gce`. A job that asks for `ci-kit-pool, cpus-N` matches either. A job that names `ci-kit-gce` stays on GCE,
and the demand count must respect that: a queued job counts toward a candidate only if its labels are a subset of
that provider's runner labels. Runner-name patterns (`ci-kit-gce-*` today) become per provider:
`ci-kit-ec2-<allocation>`.

### Placement order and the credit preference

Each provider expands its config into candidates, with their order fixed by config. The scheduler builds one walk
per size from three groups:

| Credit preference | Walk |
|---|---|
| on | EC2 spot candidates → GCE spot candidates → GCE standard candidates |
| off | GCE spot candidates → EC2 spot candidates → GCE standard candidates |

EC2 standard (on-demand) candidates are not configured, and the parser refuses them in this version.

Inside each group the order is the config's, the same as today. In EC2 that is a configured zone order, set by M1
from observed prices and capacity. Prices are reported, not used to rank.

The scheduler keeps today's per-attempt semantics (`gce/launcher/logic.mjs`, `placements`, stock-out and quota
memory), with the keys widened to `(provider, account, region, zone, machine, provisioning)`. A refusal in one
provider never blocks a candidate in the other.

**The preference ends** when any of these holds:

- `credit.enabled` is false in `pool/config/ec2.json`;
- today (UTC) is after `credit.until`;
- the spend checkpoint is at or above `credit.budget_usd`.

The launcher logs the change once (`credit preference off: <reason>`) and only new walks change. The preference
orders walks only for repos EC2 serves (`ec2.json`'s `repos`, or every pool repo when absent); a repo EC2 does not
serve walks GCE's candidates alone, as today. The budget is
**$180** against the $200 credit. The $20 margin covers what the estimate does not see: snapshot storage, bake and
smoke VMs, public IPv4 time outside jobs, billing lag, and charges the credit may not cover.

**The spend checkpoint** is a durable number: estimated gross EC2 dollars since `credit.since`. It lives in the
ledger issue as one machine-readable comment that the launcher rewrites. The ledger cache keeps only 26 h of rows
(`gce/launcher/ledger-store.mjs`), so it cannot be summed for a lifetime total. Two things move the checkpoint:

- **Finalize.** When a row is finalized, its gross EC2 cost is added. Repeated finalizes of one row must not
  double-count, so the checkpoint keeps the last row ids it counted.
- **Daily reconcile.** Once a day, the launcher reads Cost Explorer (`ce:GetCostAndUsage`, unblended, service
  "Amazon Elastic Compute Cloud - Compute" plus "EC2 - Other", grouped by record type, since `credit.since`). The
  checkpoint becomes the larger of the two figures. The reconcile costs $0.01 per request, so once a day is
  deliberate.

If the reconcile fails, the estimate stands, and the failure is logged and counted in the daily report.

### Reaching AWS: federation, no secret

The launcher runs on Cloud Run as `ci-kit-launcher@ssfskim-ci-kit.iam.gserviceaccount.com` (`gce/deploy.sh`,
`SA`), and the bake job runs as the same account. To call AWS, it:

1. asks Cloud Run's metadata server for an **ID token** with audience `https://ci-kit/290475840169/ec2`. Today's
   code fetches only access tokens (`lib/gce.mjs`).
2. calls regional STS `AssumeRoleWithWebIdentity` (`https://sts.us-east-2.amazonaws.com`) for the role it needs,
   asking for 4 h.
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

The roles:

- `ci-kit-ec2-launcher`, the runtime launcher. It can:
  - `ec2:RunInstances`, with the AMI, subnets, security group and instance profile restricted to the pool's own, and
    a request tag `ci-kit-pool=ec2` required;
  - `ec2:CreateTags`, only with `ec2:CreateAction=RunInstances`;
  - `ec2:TerminateInstances` and `ec2:DeleteVolume`, on resources tagged `ci-kit-pool=ec2` only;
  - read with `ec2:Describe*` (instances, images, instance types, type offerings, zones, spot price history, volumes)
    and `servicequotas:GetServiceQuota`, region us-east-2;
  - `s3:PutObject` and `s3:GetObject` on the report bucket's `reports/` prefix;
  - `ce:GetCostAndUsage`.
- `ci-kit-ec2-bake`: the launcher role's launch, read and terminate rights for builder and smoke instances, plus
  `CreateImage`, `CreateTags` on images and snapshots, `DeregisterImage`, `DeleteSnapshot` and `DescribeSnapshots`
  on the pool's tagged images and snapshots.
- `ci-kit-ec2-guard` is trusted by GitHub's OIDC provider instead (The guard).
- `ci-kit-ec2-fis`, trusted by `fis.amazonaws.com` and allowed only `ec2:SendSpotInstanceInterruptions` on
  pool-tagged instances. It exists for Acceptance 6's synthetic interruption, which CI-opt starts with `ci-kit-ops`.

The bake role also gets `ssm:GetParameter` on Canonical's public Ubuntu AMI parameters, which it reads to find its
builder's base image.

The launcher and the bake share one Google identity. Two AWS roles keep each call's rights narrow, but they are not
an isolation boundary: that identity can assume either. The strongest alternative was a separate service account
for the bake. It lost because GCE's side already shares the account, and the bake role's extra power reaches only
the pool's own images and snapshots.

**One-time setup** is `ec2/setup.sh`, run by CI-opt with the `ci-kit-ops` profile. It is idempotent: it creates
what is missing, changes nothing that exists unless asked, and prints what it did. It sets up:

- the Spot service-linked role `AWSServiceRoleForEC2Spot`, without which the first spot launch fails;
- a security group `ci-kit-pool` with no inbound rules, in the default VPC;
- the report bucket `ci-kit-ec2-reports-290475840169`, with public access blocked and a 7-day lifecycle on
  `reports/`;
- the four roles and their policies, and the FIS experiment template for Acceptance 6;
- GitHub's OIDC provider (`token.actions.githubusercontent.com`), for the guard.

The runtime roles get no IAM rights.

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
  the instance and its volume at creation.
- **`ClientToken`:** the allocation id plus the attempt number. A subnet is named, so the token's idempotency is
  zonal. Reconciling an uncertain launch therefore looks in the zone it was sent to, by `ci-kit-alloc` tag and
  token. A try in another zone is a new attempt with a new token. A race between providers gets a new allocation and
  a new JIT runner, as GCE races do today (`logic.mjs`, race).

**User-data** is JSON, not a script, so nothing on the VM executes launch input:

```json
{"v":1,"alloc":"<id>","jit":"<encoded JIT config>","deadline":"<RFC 3339, launch + max_run_minutes>",
 "report":{"boot":"<presigned PUT url>","exit":"<presigned PUT url>"}}
```

M3 checks its size against EC2's 16 KB user-data limit. The JIT config is the large part.

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

**The guest's report.** EC2 has no writable equivalent of GCE's guest attributes. The VM PUTs two small JSON
objects to presigned S3 URLs the launcher put in its user-data: `boot` when the runner container starts, and `exit`
at the end. They carry the stage timestamps: boot, user-data read, container started, runner listening,
`exit:<code>` or `failed:<stage>`, and an interruption notice if one came. The launcher reads them by allocation id
in its tick.

Presigned URLs need no credentials on the VM, and no instance profile is reachable from the host. The strongest
alternative was a write-only instance profile. It lost because it puts AWS credentials on every job VM for no
added function. A missing report is read as **unknown**, never success.

**Interruptions.** A notice is reported by the guest. An instance that vanishes with state reason
`Server.SpotInstanceTermination`, with or without a notice, is finalized `preempted` with the job its runner held,
as on GCE (`docs/pool.md`, Preemption).

### Failure classes on launch

The EC2 provider maps each launch result to the scheduler's existing outcomes. Today's GCE outcomes are the same
five, by meaning.

| EC2 result | Outcome | Scheduler does |
|---|---|---|
| instance id returned | `accepted` | Row → `running` once the instance shows. |
| `InsufficientInstanceCapacity`, `SpotMaxPriceTooLow`, `Unsupported` for the zone | `capacity` | Remember the candidate as stocked out for 5 min; try the next candidate. |
| `MaxSpotInstanceCountExceeded`, `VcpuLimitExceeded` | `quota` | Scope `ec2/us-east-2/spot-standard-family` for this tick; no EC2 spot candidate of any size is tried again this tick; continue in GCE. |
| `UnauthorizedOperation`, `AuthFailure`, an STS failure | `denied` | Log loudly. EC2 is off for 10 min, a misconfiguration and not a stock-out. Continue in GCE. |
| `RequestLimitExceeded` | `throttled` | Back off EC2 for this tick; continue in GCE. |
| Timeout or transport error | `uncertain` | Reconcile in the same zone (by tag and client token) before placing that allocation anywhere else, as GCE does. |

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

1. launches a builder from the current Ubuntu 24.04 x86-64 AMI (Canonical's SSM parameter) with shutdown
   behaviour **stop**;
2. runs the provider-neutral preparation (`pool/bake/prepare.sh` and the warm step), with the builder's EC2-specific
   steps in their own script beside `gce/bake/builder.sh`;
3. after the builder stops, runs `CreateImage`, tags the AMI unready, and terminates the builder;
4. runs the smoke suite (`gce/vm/smoke.sh`, made provider-neutral where it reads metadata) on a VM from the new AMI;
5. runs one real job on ci-kit-sandbox;
6. only then tags the AMI `ci-kit-ready=true`.

It keeps two ready generations. An older AMI is deregistered and **its snapshots deleted**: deregistering alone
keeps paying for the snapshot.

No temporary token, JIT config or instance identity may remain in the AMI. The bake clears cloud-init's state and
logs and any credential file the warm step used, and smoke asserts their absence.

The bake runs where the GCE bake runs: the Cloud Run job `ci-kit-bake` on its schedule (`gce/deploy.sh`, bake). It
gains an `ec2` stage after the GCE stage. Either stage failing leaves that provider's previous ready image in
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
- `client_token` (EC2), written before the request goes out, so a launcher that restarts mid-launch can reconcile;
- `credit_policy`: `on` or `off` when placed.

The end reasons gain none. `preempted`, `max-run`, `idle` and the rest keep their meanings.

Cost per row comes from the provider: GCE's formula as today (`gce/launcher/ledger.mjs`); EC2's from that zone's
spot price at launch, per second with a 60 s minimum, plus gp3 GB-seconds and public IPv4 time. EC2 does not charge
for a spot instance it interrupts in its first hour, and the row says so (`price.source: interrupted-free`).

The reports gain a provider column. The cost report adds, for EC2, the credit-funded estimate and the checkpoint
(Acceptance 8).

### The guard

GCE enforces a VM's run limit itself (`maxRunDuration`). EC2 has no equivalent, so two independent mechanisms
replace it: the guest's deadline timer, and a guard that does not depend on the launcher or the guest.

The guard is a job in `.github/workflows/pool-guard.yml` on `ubuntu-latest`, scheduled every 15 min. It assumes
`ci-kit-ec2-guard` through GitHub's OIDC, trusted only for `repo:SSFSKIM/ci-kit:ref:refs/heads/main`. It lists
pool-tagged resources and the ledger, then terminates or deletes:

- instances older than the run limit plus 15 min;
- stopped pool instances;
- instances tagged as the pool's with no ledger row for 15 min;
- builders older than 2 h;
- unattached pool volumes;
- unready AMIs older than a day.

It never acts on a resource without the pool tag. If a list fails, it acts on nothing that list would have
cleared. It names every action in its log. The existing Hetzner job in that workflow is unchanged.

The guard role can describe EC2 resources and terminate or delete pool-tagged ones. It cannot launch anything.

## Plan of Work

Constraints for every milestone:

- AWS is reached with the aws CLI or the AWS SDK for JavaScript v3 only (`@aws-sdk/client-ec2`, `client-sts`,
  `client-s3`, `client-cost-explorer`, `client-service-quotas`, plus `@aws-sdk/s3-request-presigner`). No AWS MCP
  servers, toolkits or agent skills.
- Account 290475840169, region us-east-2. Other regions are denied by the account's policy.
- Spot vCPU quota is 32 until the pending raise lands. Live tests keep at most 4 c8a.2xlarge at once until
  `aws service-quotas get-service-quota --service-code ec2 --quota-code L-34B43A08` shows more.
- Deploys run from a fresh clone of merged `main` only: `gce/deploy.sh <target>`. Secret Manager is not written.
- The launcher's GCE behaviour with EC2 off is the regression bar for M2–M4 (Acceptance 9).
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
   claims, and `AssumeRoleWithWebIdentity` succeeding against a role with the trust policy above?

**What to build.** Run `ec2/setup.sh` for the pieces the spike needs: the Spot service-linked role, the security
group and a spike role. Hand-bake one AMI from the bake steps; the full bake job comes in M3. A script,
`ec2/spike/`, launches instances, records the stage timestamps from inside the guest, and runs the MAWS unit
command in the runner container, as the bake's warm step runs MAWS. The same script runs the C4D arm on GCE from
the current ready GCE image. Prove federation from the MacBook by impersonating the launcher's service account:
`gcloud auth print-identity-token --impersonate-service-account=… --audiences=… --include-email`.

**Verdict.** Record in Surprises & Discoveries:

- per-stage medians and tails;
- the hydration penalty and the disk choice it implies: plain gp3, or provisioned initialization, or prefetch;
- the unit-job ratio;
- the token claims;
- the zone order for `ec2.json`;
- the AMI's written snapshot size, which sets the disk size and the snapshot cost.

**Promote** the disk configuration and zone order into M3.

**Escalate** to the owner before M2 if EC2's end-to-end per-job time, from queue to job end with the chosen disk
configuration, is above 1.25× GCE C4D's. Credit-first would then slow MAWS's CI, which the owner did not choose to
trade. Discard the spike scripts once M3's bake and provider exist; the verdict stays.

**Touches:** `ec2/setup.sh` (new, partial), `ec2/spike/` (new, deleted after M3). Nothing in the launcher.

**Proves:** nothing in Acceptance directly. It decides the inputs M3 and M4 depend on.

### M2 — The provider boundary, GCE unchanged

**At its end:** the launcher schedules through a provider interface with one provider, `gce`, and behaves exactly
as before. Ledger rows are v2 with `provider: gce`, and v1 rows still read. The candidate walk is built from
providers' candidates and the credit-preference table, with only GCE present.

**Touches:**
- `gce/launcher/` (`launcher.mjs`, `logic.mjs`, `room.mjs`, `ledger.mjs`, `server.mjs`, `config.mjs`);
- `lib/gce.mjs`;
- a new `gce/launcher/providers/` holding `gce.mjs` and the interface's contract tests;
- `gce/latency-report.mjs`, for the provider column;
- the tests under `test/gce/`.

**Decisions:**
- The scheduler stops deriving region, family or vCPUs from GCE machine and zone names (`zone.replace(...)` and
  similar). It reads them from the candidate.
- Stock-out and quota memory keys gain provider and account.
- Room (`room.mjs`) becomes per provider and is consulted through the provider.
- The pre-launch and coverage code is moved, not changed.

**Does not touch:** the VM side, the bake, the guard, or anything EC2.

**Proves:**
- Acceptance 9.
- New contract tests pin that:
  - a provider's `launch` outcomes map to the scheduler's actions per the failure table;
  - a refusal in one provider leaves the other's candidates untried-but-available;
  - v1 rows parse.
- A deploy of the launcher from merged main runs a class 1a MAWS run green, with its ledger rows v2 `provider: gce`.

### M3 — The EC2 provider, its image and its setup, serving the sandbox

**At its end:**
- `ec2/setup.sh` is complete and has been run.
- The bake job builds, smokes and promotes an AMI beside the GCE image, from one manifest.
- The launcher, configured with `pool/config/ec2.json` `{"enabled": true, "repos": ["SSFSKIM/ci-kit-sandbox"],
  "credit": {"enabled": true, …}}`, places ci-kit-sandbox's pool jobs on EC2 first. MAWS and manim-master are not in
  `repos`, so they place on GCE exactly as before.
- Live, a sandbox job runs on `ci-kit-ec2-*`, and its VM terminates itself after. The spend checkpoint does not exist
  yet, so the budget end is not enforced in M3. The preference still ends by flag or date, and the sandbox's spend is
  cents.

**Touches:**
- `gce/launcher/providers/ec2.mjs` (new);
- `lib/aws.mjs` (new: federation, credential cache, signed clients);
- `pool/config/ec2.json` and its parser;
- the VM side: `ec2/vm/` with `ci-kit-ec2-job.service` and its script, plus the shared container-start module
  extracted from `gce/vm/job.mjs`;
- the bake: `gce/bake/bake.mjs` gains the EC2 stage, and its builder script goes beside `gce/bake/builder.sh`;
- `gce/vm/smoke.sh`, made provider-neutral;
- `gce/deploy.sh`, for the launcher's and the bake's role ARNs as environment variables, never secrets;
- `ec2/setup.sh`.

**Decisions:**
- The user-data shape and size check.
- Report objects at `reports/<alloc>/boot.json` and `exit.json`.
- The client-token form.
- The failure table.
- The zone order and disk configuration from M1's verdict.
- The EC2 provider's `observe` lists only `ci-kit-pool=ec2` instances.
- If the list fails, the scheduler treats EC2's inventory as unknown and launches nothing on EC2 that tick. GCE
  still serves. Unseen EC2 VMs are not counted as gone.
- A test double of the EC2 API (in the style of `test/gce/fake-gce.mjs`) carries the provider's tests.

**Does not touch:** the credit preference's spend checkpoint (M4), the guard (M4), or MAWS's placement (credit
stays off for MAWS).

**Proves:**
- Acceptance 1.
- Acceptance 4 on the sandbox.
- Acceptance 10.
- Tests pin that:
  - an `uncertain` launch reconciles in its own zone and never retries elsewhere with the same token;
  - the guest uploads `exit` and powers off on every exit path, including a container that never starts;
  - a missing report finalizes as unknown;
  - the job VM never sees IMDS from inside the container (smoke).

### M4 — Credit preference, reports, guard, MAWS canary, acceptance

**At its end:**
- The credit preference runs with the spend checkpoint and daily reconcile.
- The cost and latency reports show both clouds.
- The guard runs every 15 min.
- `ec2.json` enables EC2 for every pool repo with `credit.enabled: true`, `credit.until: "2027-04-17"`,
  `credit.budget_usd: 180` and `credit.since` set to the day it is turned on.
- MAWS's pool jobs run on EC2 first.

**Touches:**
- `gce/launcher/` (the preference, the checkpoint comment, the reconcile);
- `gce/cost-report.mjs` (new, or the existing cost path; check `ledger.mjs`'s aggregation first);
- `gce/latency-report.mjs`;
- `.github/workflows/pool-guard.yml` and a new `ec2/guard.mjs`;
- `docs/pool.md`, an EC2 section in the voice of its GCE one.

**Decisions:**
- The checkpoint comment's shape: `{"v":1,"since":…,"usd":…,"counted":[last 500 row ids],"reconciled_at":…}`.
- The checkpoint is updated at finalize, and by the reconcile once a day after 06:00Z.
- The preference's three ends, per Design.
- The guard's list and its safety rule: it never acts on what a failed list would have covered.

**Does not touch:** c8g/ARM, more instance families, EC2 on-demand, automatic reruns.

**Proves:** Acceptance 2, 3, 5, 6, 7 and 8. Then the whole acceptance runs as written, in Concrete Steps.

## Concrete Steps

From a fresh clone of merged `main` (`git clone https://github.com/SSFSKIM/ci-kit /private/tmp/ci-kit-deploy`):

    # tests touched by the launcher and providers
    cd /private/tmp/ci-kit-deploy && node --test --test-concurrency=1 --test-timeout=15000 test/gce/*.test.mjs test/ec2/*.test.mjs
    # expect: every test ok, none skipped for lack of credentials

    # setup is idempotent: a second run reports nothing to do
    AWS_PROFILE=ci-kit-ops AWS_REGION=us-east-2 ec2/setup.sh
    # expect, second run: "setup: nothing to change"

    # deploys (CI-opt, merged main only)
    gce/deploy.sh launcher && gce/deploy.sh bake

    # Acceptance 1: no AWS secret
    gcloud secrets list --project ssfskim-ci-kit --format='value(name)' | grep -i -E 'aws|ec2' || echo "no aws secret"
    gcloud logging read 'resource.labels.service_name="ci-kit-launcher" AND textPayload:"aws: assumed"' --project ssfskim-ci-kit --limit 3 --format='value(textPayload)'
    # expect: "no aws secret"; "aws: assumed ci-kit-ec2-launcher until <time>"

    # Acceptance 2: a MAWS class 1a run on EC2 (from a MAWS worktree at master)
    scripts/ci-gate.sh <worktree> --gates static,unit,probes
    gh api repos/SSFSKIM/MAWS/actions/runs/<run>/jobs --jq '.jobs[]|[.name,.conclusion,.runner_name]|@tsv'
    # expect: static, unit 1/4..4/4, probes success, runner_name ci-kit-ec2-<alloc>

    # Acceptance 4: no leftovers after the run
    AWS_PROFILE=ci-kit-ops AWS_REGION=us-east-2 aws ec2 describe-volumes --filters Name=tag:ci-kit-pool,Values=ec2 --query 'length(Volumes)'
    # expect: 0 once the run's VMs are gone

    # Acceptance 6: a synthetic interruption (FIS template from ec2/spike or ec2/setup.sh, targeting one tagged instance)
    AWS_PROFILE=ci-kit-ops AWS_REGION=us-east-2 aws fis start-experiment --experiment-template-id <id>
    # expect: the job fails on GitHub; its ledger row ends "preempted"; no rerun

    # Acceptance 8
    node gce/cost-report.mjs --since <ISO> && node gce/latency-report.mjs --since <ISO>
    # expect: rows per provider; EC2 credit-funded estimate, checkpoint and remaining budget

## Interfaces and Dependencies

`gce/launcher/providers/<name>.mjs` exports `createProvider(deps) → Provider`:

    Candidate = {
      provider: 'gce' | 'ec2', account: string, region: string, zone: string, zoneId?: string,
      machine: string, vcpus: number, memoryGiB: number, arch: 'x86_64',
      provisioning: 'spot' | 'standard', subnet: string, disk: { type: string, sizeGB: number },
    }
    Instance = { provider, id, alloc, runner, state: 'pending'|'running'|'stopping'|'stopped'|'gone',
                 stateReason?: string, candidate: Candidate, createdAt: string }
    LaunchResult = { outcome: 'accepted'|'capacity'|'quota'|'denied'|'throttled'|'uncertain',
                     scope?: string, detail: string, id?: string }
    Provider = {
      name: 'gce' | 'ec2',
      candidates(config) : Candidate[],                     // ordered, all sizes
      observe()          : Promise<{ instances: Instance[], complete: boolean, room?: object }>,
      readyImage()       : Promise<{ id: string, manifest: object } | null>,
      launch(alloc, candidate, jit, report?) : Promise<LaunchResult>,
      reconcileLaunch(alloc) : Promise<LaunchResult>,
      terminate(instance)    : Promise<void>,
      readReports(allocs)    : Promise<Map<string, object>>, // missing = unknown
      cleanupOrphans(inventory, ledger) : Promise<string[]>, // names what it removed
    }

`lib/aws.mjs` exports `awsCredentials(roleArn) → Promise<{ accessKeyId, secretAccessKey, sessionToken, expiration }>`.
It is cached and refreshed per Reaching AWS, and the EC2, S3, Cost Explorer and Service Quotas clients are built on
it.

`pool/config/ec2.json`:

    {"enabled": true, "repos": ["SSFSKIM/ci-kit-sandbox"],          // optional narrowing; absent = gce.json's repos
     "account": "290475840169", "region": "us-east-2",
     "placements": [{"zone": "us-east-2b", "subnet": "subnet-…",
                     "machines": {"2": "c8a.large", "4": "c8a.xlarge", "8": "c8a.2xlarge", "16": "c8a.4xlarge"}}],
     "disk_gb": 50, "security_group": "sg-…", "report_bucket": "ci-kit-ec2-reports-290475840169",
     "roles": {"launcher": "arn:aws:iam::290475840169:role/ci-kit-ec2-launcher",
               "bake": "arn:aws:iam::290475840169:role/ci-kit-ec2-bake"},
     "credit": {"enabled": false, "since": "2026-10-23", "until": "2027-04-17", "budget_usd": 180}}

Each milestone produces the next one's inputs:
- M1 produces the verdict, which fills `placements`' zone order and `disk_gb`.
- M2 produces `Provider` and `Candidate`.
- M3 produces `createProvider` for `ec2`, `awsCredentials` and `ec2.json`.
- M4 consumes all of them.

## Verification

- The spec gets one independent review (adversarial-reviewer, technical) and, since it has four milestones, the
  adversarial-reviewer's buildability review of the execution section, in the same round.
- Each milestone is reviewed at its boundary by the plan-executor's task reviewer.
- The whole branch gets doperpowers:review-code at **high** (reviewer-high): it adds cloud credentials, an IAM
  surface and a second control plane to a launcher that runs the owner's private CI.

## Decision Log

- Decision: Verification as in Verification above: one technical spec review plus a buildability review, a review
  per milestone, and reviewer-high on the branch.
  Rationale: a new cloud, IAM and federation, and a scheduler change on the path of every MAWS run.
  Date/Author: 2026-10-23, CI-opt.

## Surprises & Discoveries

- Observation: The GCE placements are ordered by speed, not by price; prices are only reported.
  Evidence: `gce/launcher/logic.mjs` `placements()` walks spot then standard in config order; the owner rejected
  daily price ranking (placement spec, Decision Log). "Credit first" is therefore a policy switch, not a price
  input.

## Outcomes & Retrospective

Pending — written at finish.
