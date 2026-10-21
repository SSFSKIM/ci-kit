# The pool — operator runbook

The pool is one Hetzner server, `ci-kit-pool`, that exists only while private repos' pool-lane gates run
(design: spec §3). A workflow's `plan` job runs **ensure**, which creates the box from the newest pool snapshot
if none exists. The **agent** on the box starts one Docker container per queued pool job, each with a fresh
just-in-time runner and an exclusive set of cores, and deletes the box when it is idle at minute ≥ 50 of its
billed hour. The **watchdog** on the box and the **guard** workflow are the backstops. The **bake** builds the
snapshot weekly.

**Idle** means no pool demand: no running job container, no queued or in-progress job carrying `ci-kit-pool` in
a served repo, and no ensure call in the last 15 minutes. Ensure stamps the box `ci-kit-want=<unix seconds>` on
every call, on an existing box as well as a new one, because the job it is for may queue minutes later behind
hosted jobs. A served repo's runs that use no pool job keep nothing alive. MAWS runs over a hundred gates a day,
and most of them never touch the pool.

| Piece | Where |
|---|---|
| ensure | `pool-ensure/` (the action), `pool/lib/ensure.mjs` |
| agent, watchdog | `pool/agent/` (`agent.mjs`, `watchdog.mjs`, `systemd/`), decisions in `logic.mjs` |
| job container image | `pool/image/` |
| bake | `.github/workflows/pool-bake.yml`, `pool/bake/` |
| guard | `.github/workflows/pool-guard.yml`, `pool/guard.mjs`, rules in `pool/lib/guard.mjs` |
| served repos and preferences | `pool/config/pool.json` |
| GCE backend (§3a): launcher, image bake, VM unit, deploy | `gce/`, `lib/gce.mjs`, `pool/config/gce.json`; see "GCE" below |
| ledger and alerts | issue "pool ledger" and issues labelled `ci-kit-alert` in `SSFSKIM/ci-kit-sandbox` |

Every Hetzner resource the kit makes carries a `ci-kit=` label (`pool`, `pool-image`, `builder`), and every
piece of the kit selects by that label and checks it again before acting. The project holds other work's
resources; anything without the label is never touched.

## Using the pool from a repo

A private repo's gate goes on the pool with `lane: pool` and `cpus: 2|4|8|16` in `.github/ci-kit.yml`
(see `docs/adopting.md`), plus two things only the operator can do:

1. **Serve the repo.** Add it to `repos` in `pool/config/pool.json`:
   `{"repo": "SSFSKIM/<name>", "workflows": ["ci.yml"]}`. The current agent no longer reads `workflows`: demand
   comes from pool jobs in any workflow. Boxes from images baked before 2026-10-16 still read it, so give it the
   workflows that use the pool until those images are gone. Commit to `main`. The agent re-reads the config every
   5 minutes, so no re-bake or restart is needed. A repo the API reports as public is refused.
2. **Install the App and set the secret.** Add the repo to the `ci-kit-runners` installation
   (github.com/settings/installations → ci-kit-runners → Configure), and set `HCLOUD_TOKEN`:
   `gh secret set HCLOUD_TOKEN -R SSFSKIM/<name> --body "$(cat ~/.config/claude-secrets/HETZNER_API_TOKEN)"`.

A repo with its own workflow (MAWS's `gate.yml`) uses the lane directly: `runs-on: [self-hosted, ci-kit-pool,
cpus-<N>]`, and a step before the pool jobs queue:

```yaml
- uses: SSFSKIM/ci-kit/pool-ensure@v1
  with: {hcloud-token: "${{ secrets.HCLOUD_TOKEN }}"}
```

Ensure reads which repos the pool serves from the kit's `main`. It uses the copy bundled with `v1` only when `main`
cannot be reached. It wakes or stamps a box only for a repo in `pool.json`. For a repo in `pool/config/gce.json`
its result is `gce`, and for a repo in neither it is `none`. In both cases it touches nothing in Hetzner and needs
no `hcloud-token`. A config on `main` whose `repos` cannot be read fails ensure rather than falling back to the
bundled list, which may still hold a repo that `main` has moved.

**Removing a repo** from `repos` drains it within 5 minutes, when the agent next reads the config. No new
container starts for the repo. Its busy runners finish their jobs, or run until the 6 h 15 min container
deadline. Its idle runners are unregistered, then their containers stop. Jobs it queues meanwhile wait in GitHub's
queue. Each box labels itself `ci-kit-config=<sha8>`, the commit of the config it runs: the newest commit on `main`
that changed `pool.json`, or the snapshot's bake commit until a fetch from `main` succeeds. A box showing the
removal commit, or a later one, has stopped serving the repo. A box on an older commit has not: its config fetch is
failing, or it booted from a snapshot whose baked list still has the repo. The agents in snapshots baked before this
change kill a removed repo's containers after 5 minutes, busy or not.

Inside a `cpus-N` container, `nproc` and Node's `os.availableParallelism()` report N; `getconf
_NPROCESSORS_ONLN` reports the host's cores. Size worker pools from `nproc`.

## Credentials

| Credential | Where | Used by |
|---|---|---|
| GitHub App `ci-kit-runners` (id 5337915), owned by SSFSKIM, installed on MAWS, ci-kit-sandbox and ci-kit; Administration rw, Actions rw, Contents r, Issues rw | private key in secrets `CI_KIT_APP_KEY` (kit, sandbox), id in `CI_KIT_APP_ID`; baked to `/etc/ci-kit/app.pem`, `/etc/ci-kit/app_id` | the agent (runners, schedules, ledger), the watchdog (ledger), the guard, the bake (cache warming) |
| Hetzner token | `~/.config/claude-secrets/HETZNER_API_TOKEN`; secret `HCLOUD_TOKEN` in the kit and every caller; baked to `/etc/ci-kit/hcloud_token` | ensure, agent, watchdog, guard, bake |

Everything under `/etc/ci-kit` is root-only, and job containers never mount it.

**Rotating a credential.** Update the repo secrets, then re-bake (below): the box reads its credentials from
the snapshot. For the App key: github.com/settings/apps/ci-kit-runners → Private keys → Generate; set
`CI_KIT_APP_KEY` in the kit and the sandbox from a 0600 file under `mktemp -d` (`gh secret set CI_KIT_APP_KEY -R
<repo> < "$dir/app.pem"`), remove the file, re-bake, then delete the old key on the App's page.

## Re-bake

The bake runs every Sunday at 18:00 UTC (03:00 KST Monday, an hour the pool is usually down) and on dispatch:

```
gh workflow run pool-bake.yml -R SSFSKIM/ci-kit
gh run watch -R SSFSKIM/ci-kit $(gh run list -R SSFSKIM/ci-kit -w pool-bake.yml -L 1 --json databaseId -q '.[0].databaseId')
```

It waits while a pool box is up (see "The project's core limit" below), then creates a builder
(`ci-kit-builder-<run id>`, label `ci-kit=builder`, from `ubuntu-24.04`, the smallest type that holds the build:
`cpx12` with 2 GB of swap added, else `cx23`, else `cpx22`; the bake's log shows the build's peak memory plus swap)
whose user-data
(`pool/bake/builder.sh`) writes `/etc/ci-kit/`, installs Docker, clones the kit at the run's commit, and runs the
provider-neutral half of the bake that the GCE bake shares (`pool/bake/prepare.sh`): Node, the runner image
(`pool/image/Dockerfile`), and the warmed caches (`pool/bake/warm.mjs`, given an installation token that
`pool/bake/app-token.mjs` mints from the baked App, narrowed to reading MAWS; it records what it did in
`/var/lib/ci-kit/cache/warm.json` on the image, readable by jobs). It then smoke-tests a cpuset container, marks itself
`ci-kit-bake=ok` and powers off. The workflow then snapshots it (`ci-kit=pool-image`, `ci-kit-commit=<sha>`),
deletes it, and keeps the two newest snapshots. A builder that fails marks itself `ci-kit-bake=failed-<step>`,
and the run fails naming the step. A failed or cancelled bake leaves the previous snapshots in place, and its
last step deletes its builder and any snapshot it left unfinished; the guard deletes a builder older than 2 h.

Bump the runner image's pinned version in `pool/image/Dockerfile` when GitHub releases a new runner, so jobs do
not pay a runner self-update at start.

The job image also carries `zsh` and the fonts `fonts-noto-cjk`, `fonts-inter` and `fonts-jetbrains-mono` (Ubuntu
noble, main and universe), which MAWS's jobs used to apt-install at job time: zsh on its static and unit jobs, zsh and
the fonts on its pool e2e. That took about 35 s on each job's critical path and depended on Launchpad, whose 503 once
failed a unit shard outright. The GCE smoke check proves them (`zsh`, `fonts`).

## Reading the ledger

The ledger is the issue "pool ledger" in `SSFSKIM/ci-kit-sandbox`. Each pool server session has one comment:

```
| server id | created (UTC) | deleted (UTC) | type@location | billed h | € | jobs | end |
```

- A row is provisional before the server is gone. Its deleted column reads `running, seen <time>` from the box's
  boot (the agent writes it then, and the guard writes or refreshes it every cycle for any live pool box). It reads
  `deleting <time>` once a deleter has written it just before its delete call. The guard, or the next box's agent
  at boot, finalizes it once the server is gone. A row never moves back.
- `end`: `idle` (the agent deleted its idle box), `stale-heartbeat` (the guard deleted a box whose agent had not
  reconciled for 10 min), `watchdog` (the box deleted itself after 30 min without reconciling), `max-uptime`
  (24 h up), `manual`, or `vanished`. `vanished` means the server disappeared while its row still read `running`,
  most likely its watchdog while GitHub was unreachable. Its deleted time is its last sighting, which is within one
  guard cycle of the truth.
- Accepted residue: a box that never reached GitHub and was deleted by its watchdog before the guard first saw it
  has no row. The watchdog deletes whether or not GitHub answers, because deletion must not depend on GitHub.
- `€` is billed hours times the type's gross hourly price in that location; the IPv4 address adds €0.001/h.
- Two writers can each create a comment for the same server, for example the guard and a watchdog at once. Readers
  count one row per server, the most final, then the oldest comment, and every writer deletes the others it finds.
- A box ensure made smaller for the core limit shows its type in the row, for example
  `| 170700001 | 2026-10-20 09:12:04 | 2026-10-20 10:02:11 | cpx52@hel1 | 1 | 0.19 | 6 | idle |`, and has a
  matching `ci-kit-alert` issue.
- Each comment starts with a hidden `<!-- ci-kit-ledger {…} -->` marker holding the same row as JSON; the kit
  reads that, not the table.

The guard posts a weekly summary comment (hours, euros, jobs, the month projected at that week's rate), and opens
a `ci-kit-alert` issue when a day's pool hours exceed `max_hours_per_day` (default 8). A day's hours are the
billed hours that begin in that UTC day, so a session across midnight counts on both days. It never deletes a box
for cost; the levers are a smaller type in `types` (cpx52 or cpx42), CX53 stock, or fewer pool gates.

## Changing type or location preferences

Edit `types`, `fallback_types` and `locations` in `pool/config/pool.json` and commit to `main`. Ensure reads them from the kit
checkout at the calling workflow's version (`@v1` callers after `v1` moves); the guard reads `main`. The first
available type in order wins, in the first location in order that offers it (availability from
`GET /v1/server_types`). A type with fewer than 16 cores serves fewer jobs at once. A job asking for more cores
than the box has runs on all of the box's cores once the box is otherwise empty, and its job log says so: `ci-kit
pool: this job asked for cpus-16; this box has 12 cores, so it runs on all of them (clamped)`. The box's disk must
be at least the snapshot's `disk_size` (40 GB from a `cpx12` or `cx23` builder), which every type in the lists
meets. Changing types for cost is the owner's call.

**The project's core limit.** The kit lives within the Hetzner project's current shared-core limit, which is
below 20 vCPU. 18 (the 16-core pool box plus the foreign 2-core `session-mirror`) is accepted, and 20 is refused.
Raising the limit is not available for now, and `session-mirror` is not the kit's. Two measures follow:

- **Smaller boxes.** When a create is refused for the limit (`403 resource_limit_exceeded`, "shared core limit
  exceeded"), ensure does not try the same type elsewhere, since the limit is project-wide. It moves on to
  `fallback_types` (cpx52 at 12 vCPU, then cpx42 at 8) and labels that box `ci-kit-fallback=core-limit`. Its agent
  opens an alert, the ledger row shows the smaller type, and larger gates run clamped (above).
- **The bake avoids the pool.** It is scheduled when the pool is usually down. If a pool box is up when it starts,
  or the builder is refused for the limit, it tries again every 15 min for at most 2 h, then fails with an alert.
  The previous snapshots stay in use.

Raising the project's limit (a Hetzner support request) removes the need for both measures. With room for a pool
box and a builder side by side, the fallback types would never be reached and the bake would never wait.

## Debug access

The box has no inbound access and no ssh key. Two ways in:

- **Hetzner console.** console.hetzner.cloud → the project → `ci-kit-pool` → Console. There is no root password
  set, so for a login: Rescue → Reset root password first (it reboots the box).
- **ssh, temporarily.** Add a rule allowing your address on port 22 to the `ci-kit-pool` firewall and an ssh
  key, then remove both:

  ```
  T="$(cat ~/.config/claude-secrets/HETZNER_API_TOKEN)"
  fw=$(curl -s -H "Authorization: Bearer $T" 'https://api.hetzner.cloud/v1/firewalls?label_selector=ci-kit=pool' | jq '.firewalls[0].id')
  me=$(curl -s https://api.ipify.org)
  curl -s -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
    "https://api.hetzner.cloud/v1/firewalls/$fw/actions/set_rules" \
    -d "{\"rules\":[{\"direction\":\"in\",\"protocol\":\"tcp\",\"port\":\"22\",\"source_ips\":[\"$me/32\"]}]}"
  ```

  A key cannot be added to a running server through the API; add one with `ssh-copy-id` from the console
  session, or create a debugging box with `ssh_keys` set (see "A box by hand" below). Afterwards set the rules
  back to `[]`.

On the box: `journalctl -u ci-kit-agent -f` (the agent logs every container it starts and retires, every state
change, and every skipped tick), `systemctl list-timers ci-kit-watchdog.timer`, `journalctl -u ci-kit-watchdog`,
`docker ps --filter label=ci-kit-job`, `cat /var/lib/ci-kit/warm.json /var/lib/ci-kit/kit-commit`.

**A box by hand.** For a test, create the server as ensure does, with user-data to change the box at boot (a
shell script that cloud-init runs once): for example writing a wrong key to `/etc/ci-kit/app.pem` and running
`systemctl restart ci-kit-agent`, or `systemctl disable --now ci-kit-watchdog.timer`. Give it the `ci-kit=pool`
and `ci-kit-state=booting` labels so the guard watches it, and delete it afterwards.

## When something goes wrong

| Symptom | Look at |
|---|---|
| A pool gate waits (`ci-gate` prints `WAIT`) for more than ~3 min | the `plan` job's Pool step (ensure's result); then `GET /v1/servers?label_selector=ci-kit=pool`; then the agent's journal |
| ensure fails "no pool server type is available" | stock: every pair in `types` × `locations` is out; add a type or location |
| ensure fails "no snapshot labelled ci-kit=pool-image" | run the bake |
| ensure warns "the project's core limit refused …", or an alert names a smaller box or a refused bake | the project's shared-core limit (above); list the project's servers, and ask Hetzner for a higher limit if this recurs |
| An alert "heartbeat stale" | the agent could not reconcile (GitHub unreachable, App key revoked, crash); the box is already deleted; check the App and the last bake |
| A box up more than 12 h | a pool job that never ends, or ensure called over and over (each call holds the box 15 min); cancel the job or find the caller, and the box then idles out |
| The guard has no scheduled runs (`gh api 'repos/SSFSKIM/ci-kit/actions/runs?event=schedule'`) an hour after its file changed | GitHub has not registered the schedule; commit any change to `.github/workflows/pool-guard.yml` on `main`. Meanwhile `gh workflow run pool-guard.yml -R SSFSKIM/ci-kit` runs one cycle |
| The guard or bake stopped running | GitHub disables scheduled workflows in a repo with no activity for 60 days; each pool boot re-enables them, or `gh workflow enable pool-guard.yml -R SSFSKIM/ci-kit` |

## GCE

The GCE backend (spec §3a) runs each pool job on its own spot VM in the project `ssfskim-ci-kit`, booted from the
image family `ci-kit-runner`. A repo listed in `pool/config/gce.json` is served by it; one in `pool.json` by the
Hetzner box; a repo is never in both (the launcher serves neither copy and opens an alert, and the kit's test that
the two files list no repo twice fails). Ensure prints `result=gce` for a GCE repo and touches nothing in Hetzner.

| Piece | Where |
|---|---|
| launcher (Cloud Run service `ci-kit-launcher`) | `gce/launcher/`: `server.mjs` (the service), `routes.mjs` (its paths), `ticker.mjs` (when ticks run), `launcher.mjs` (one tick), decisions in `logic.mjs`, ledger rows in `ledger.mjs` and `ledger-store.mjs`, configs from main in `source.mjs` |
| webhook receiver (Cloud Run service `ci-kit-webhook`) | `gce/webhook/`: `server.mjs` (the service), `receiver.mjs` (signature, filter, publish); the App's hook config: `gce/tools/app-hook.mjs` |
| bake (orchestrator, decisions) | `gce/bake/bake.mjs`, `gce/bake/plan.mjs` |
| builder (startup script) | `gce/bake/builder.sh`, sharing `pool/bake/prepare.sh` with the Hetzner builder |
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

The order is speed first; reordering is a commit on main, read by the next tick. `placements` is the only form: the
old keys (`region`, `subnetwork`, `zones`, `machines`, `machine_fallback`) are refused by `gce/launcher/config.mjs`.
E2 left the pool with them (its us-central1 quota raise was refused twice); size 2 in us-central1 runs on
`c3d-highcpu-4`. Adding a placement is a block in this list plus `gce/deploy.sh network`, which creates its
subnetwork. The bake reads the `gce.json` bundled at its deploy, so a change to the placements reaches it with
`gce/deploy.sh bake`.

**The launcher.** Cloud Scheduler's `ci-kit-launcher-tick` POSTs to `ci-kit-launcher`'s `/tick` every minute with an
OIDC token, and the webhook's Pub/Sub push POSTs to its `/request` when a job is queued in a served repo (The
webhook, below).
The service has no public ingress (`--ingress=internal`, IAM-only: `ci-kit-launcher@` is its one invoker), runs one
instance at a time and admits many requests at once, but runs one tick at a time (`ticker.mjs`). Every tick is the
same full reconciliation, whoever asked, and nothing is kept between ticks: state is in GCE labels, the ledger and
GitHub. A tick:

1. reads `gce.json` and `pool.json` from the kit's main (the newest commit that changed each; on a failed read it
   keeps the last good copy, and at a cold start without main, the copy in its own build);
2. reads, all at once: each repo's visibility (public repos, and any repo in both files, are refused), its
   `ci-kit-gce-*` runners and then its queued and in-progress runs and their jobs; the ledger's last 26 h on every
   open ledger issue (below) and then the `ci-kit=gce` instances and disks; the images; and, once the runners and
   instances are in, `ci-kit/job` of each VM whose runner is not busy;
3. launches one VM per queued pool job not covered by an unclaimed VM, oldest job first, while the vCPUs in flight
   stay at or under `max_vcpus`. An unclaimed VM has its runner registered, not busy, younger than
   `idle_runner_minutes`, and never having taken a job: a job VM is single-use, and its runner reads registered and
   not busy for a while after its job ends (a job this tick read names it, its row recorded a job, or it reported
   `ci-kit/job`). Static job 119166794835 waited 126 s on 2026-10-21 behind a VM whose job had just ended;
   then, with what those launches leave of `max_vcpus` and only when no queued job waits, pre-launches the VMs of
   each run that has begun before its pool jobs are queued (Pre-launch, below);
4. beside the launches, cleans up (below), finalizes rows whose VM is gone, and records on each running row the job
   its runner holds;
5. once a day, in its first two hours (UTC), writes yesterday's daily line.

The launches start as soon as the reads are in, before the cleanup, and the two run together: a VM about to be
deleted still counts against `max_vcpus` for that tick, so launching first can only under-admit, never over-admit.
The ledger store lives as long as the service's instance and, after its first read of an issue, asks only for the
comments updated since its last read, less 5 min; a busy day's window is several pages, which a tick would otherwise
read one after another before its first launch.

A launch writes the `launching` row, mints the JIT config (runner name = instance name, labels `self-hosted`,
`ci-kit-pool`, `cpus-N`, `ci-kit-gce`, work folder `/var/lib/ci-kit/cache/work/<instance>`), then creates
`ci-kit-gce-<allocation id>` from the newest image labelled `ci-kit-ready=true`. It walks the placements: the
size's machine as spot in each zone of the first placement, then of the next, and so on; then on demand in the same
order (an attempt two placements share is made once). `ZONE_RESOURCE_POOL_EXHAUSTED*` moves to the next zone. A quota
refusal is remembered for the rest of the tick, scoped to what its message names: a family's CPUs (`C4D_CPUS`) by
region and family, any other regional quota (`CPUS`, `INSTANCES`, `IN_USE_ADDRESSES`, disk capacity) by region,
`CPUS_ALL_REGIONS` everywhere, a `PREEMPTIBLE_` one for spot only; every later attempt in that scope of the same or
more vCPUs is skipped, in this walk and the tick's later ones, since a smaller VM may still fit. A launch whose every
attempt is so ruled out makes no runner or row and its job waits in GitHub's queue; no other launch stops. An insert
whose outcome is unknown is settled through its zone operation before any other zone is tried, and if it stays
unknown the walk stops and the cleanup rules settle it. The VM: no service account, its placement's subnetwork, the
JIT config in metadata `ci-kit-jit`, `maxRunDuration` = `max_run_minutes` with a `DELETE` action, a boot disk of the
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
- a `ci-kit=gce` disk attached to nothing for 10 min, and a `ci-kit=gce-builder` instance older than 2 h, are
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
  topic, and nothing else: it cannot invoke the launcher. Which repos are served is read from the `gce.json` and
  `pool.json` bundled at its deploy, so a repo added on main reaches the webhook path at the receiver's next
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
- **What to launch** is the shape of the same workflow's runs on the ledger: for each size, the median count of VMs
  its pool jobs took over its last 10 runs (newest by run id) among the rows in the ledger's 26 h window, rounded up;
  a run with no job of a size counts 0 for it. A row counts through the job its VM ran (`job.run`, `job.workflow`),
  whichever run it was launched for. A workflow with no run on the ledger gets nothing. Sizes go largest first.
- **Once per run.** A pre-launched VM's row names the run it was launched for (`prelaunch`: run, attempt, workflow,
  written in the `launching` row before the runner is minted), and a run gets its shape less the VMs already
  pre-launched for its run and attempt, whatever became of them (an `abandoned` row, which made no VM, does not
  count). A later tick, a redelivered or duplicate event and a second launcher reading the same ledger therefore
  launch nothing more; two ticks overlapping can both launch for one run, the overlap's usual over-launch, which the
  idle rule removes. A re-run of all of a run's jobs is a new attempt and is pre-launched again.
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
- The App key used by GCE lives only in Secret Manager: `ci-kit-app-id` and `ci-kit-app-key`, labelled
  `ci-kit=app`, readable only by `ci-kit-launcher@ssfskim-ci-kit.iam.gserviceaccount.com`. gcloud's default account
  reads them for a bake run from the Mac.
- The App has one key per backend, told apart by fingerprint (GitHub's App settings → Credentials → Key pairs):
  `SHA256:yj//oTVKm3OJamD12RO3JYnGFdQxzGoFYRmFkD90cYU=` is the Hetzner key (GitHub secrets `CI_KIT_APP_KEY`, baked
  into the snapshots); `SHA256:qQgu9FOJPM9maxPvDhd8nV+AyYS+tXW6+mp2RGiXvAg=` is the GCE key (Secret Manager), added
  2026-10-16. Retiring Hetzner revokes the Hetzner key without touching GCE.
- **Writing Secret Manager is a human-only step on this machine.** The agent's permission classifier refuses
  secret-store writes, so a rotation goes to the human from the start: generate a new key on the App's Key pairs
  page, then, with the `.pem` in a 0600 file under `mktemp -d`,
  `gcloud secrets versions add ci-kit-app-key --project=ssfskim-ci-kit --data-file=<file>`, remove the file, run a
  bake, and delete the old GCE key on the App's page.
- The webhook secret, `ci-kit-webhook-secret` (label `ci-kit=webhook`), is readable only by
  `ci-kit-webhook@ssfskim-ci-kit.iam.gserviceaccount.com`; creating and rotating it are the owner's (The webhook,
  above).
- No VM gets a service account or a key. The builder gets a one-hour installation token, narrowed to reading
  MAWS's contents (`WARM_SCOPE` in `pool/bake/warm.mjs`), in its metadata; the image is made from its disk, never
  from its metadata.

**The network.** Every builder, smoke VM and job VM sits on its placement's subnetwork of the VPC `ci-kit`
(`network` and each placement's `subnetwork` in `gce.json`: `ci-kit-us-central1`, 10.64.0.0/20, and `ci-kit-us-west4`,
10.64.16.0/20), with an ephemeral external address for outbound traffic. The VPC has no firewall rule: GCE's implied rules deny all ingress and allow
all egress. The project's `default` network is never used, since its stock rules open ssh and RDP to the internet.
`gce/deploy.sh network` creates the VPC and a subnetwork for each placement of `gce.json` idempotently (a new one takes
the first free /20 of 10.64.0.0/16, `gce/subnets.mjs`; an existing one is left alone) and fails if any rule allows
ingress into `ci-kit`. Networks and firewall rules take no labels; the names carry the kit's. To check:

```
gcloud compute networks list --project=ssfskim-ci-kit
gcloud compute networks subnets list --project=ssfskim-ci-kit --network=ci-kit
gcloud compute firewall-rules list --project=ssfskim-ci-kit --filter='network~/ci-kit$'   # expect: none
```

**The bake.** From the Mac (gcloud's default account), at a commit pushed to GitHub:

```
CI_KIT_COMMIT=$(git rev-parse HEAD) node gce/bake/bake.mjs     # default commit: the kit's main
```

1. It deletes builders and smoke VMs any bake left more than 2 h ago.
2. It creates `ci-kit-gce-builder-<run id>` (the run id is UTC seconds plus four random characters, so two bakes never
   share one; on demand: `e2-standard-4`, else `n2d-standard-4` when E2 is refused, on `pd-balanced`; the placements
   and their zones in `gce.json` order) from `ubuntu-2404-lts-amd64`. Its startup script (`gce/bake/builder.sh`)
   installs Docker, clones the kit at the commit, runs `pool/bake/prepare.sh` (Node, the runner image, the caches),
   requires every cache warmed, installs and enables `ci-kit-gce-job.service`, cleans the disk, reports
   `ci-kit/bake=ok` (or `failed:<step>`) as a guest attribute, and powers off. GCE deletes a builder still running at
   45 min.
3. Only on `ok` and power-off within 30 min, it images the builder's disk into the family, labelled
   `ci-kit-ready=false`, and deletes the builder.
4. In each placement in turn it boots `ci-kit-gce-builder-<run id>-smoke-<n>` from the image on the placement's
   subnetwork and disk type, on its `cpus-2` machine (the next size's when that is refused), so an image that does not
   boot on a placement's family is never ready, with metadata `ci-kit-smoke=<vCPUs>` in place of a JIT config. The job
   unit runs `gce/vm/smoke.sh` in a job container: vCPUs, user, isolation, the runner, zsh and MAWS's fonts, Node 22
   and 24, every warmed
   cache, the work directory, DNS, egress, and the metadata server refused. It reports
   `ci-kit/smoke=ok|failed:<check>` and powers off.
5. It runs the real job on a VM booted from the image in the first placement that takes it. When every smoke VM
   and the real job passed, the image is labelled `ci-kit-ready=true`; the launcher uses only ready images (never
   `getFromFamily`, which would return an unready one). On any failure the bake deletes its own image.
6. On every exit it deletes its instances, and keeps the two newest ready images (unready images of other runs
   are dropped once 2 h old). It deletes an image only while that image carries its `ci-kit-run` label: an image
   insert refused because the name exists leaves the existing image alone.

The Cloud Run job `ci-kit-bake` runs the same script as `ci-kit-launcher@`, at main's head, with the `gce.json` it was
deployed with (not main's: a placement change reaches the bake through `gce/deploy.sh bake`): `gce/deploy.sh bake`
deploys it, and `gce/deploy.sh bake-schedule` adds the weekly run (Sunday 18:00 UTC). To run it now:
`gcloud run jobs execute ci-kit-bake --region=us-central1 --project=ssfskim-ci-kit`. The first ready image,
`ci-kit-runner-20261016-100502-b4fc88e2`, was baked from the Mac (2026-10-16, 12.5 min: builder 8 min, image 1 min,
smoke 2.5 min).

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
`ci-kit-runner:latest` on all of the VM's vCPUs with the Hetzner container's mounts and environment and the JIT
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
gce/deploy.sh base network          # APIs, the service account and its compute role, serial port logging; the VPC
gce/deploy.sh bake bake-schedule    # the Cloud Run job ci-kit-bake and its weekly Scheduler job
gce/deploy.sh launcher launcher-schedule   # the Cloud Run service ci-kit-launcher and its one-minute tick
gce/deploy.sh webhook               # the receiver ci-kit-webhook, its Pub/Sub topic and push subscription
gce/deploy.sh alert                 # the failed-tick metric and its alert policy, mailed to the owner
gce/deploy.sh app-hook              # not in "every part": the App's webhook URL and secret (The webhook, above)
```

Every part is idempotent. `base` also gives the project's default compute account `roles/run.builder`: Cloud Run
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

**Reading the GCE ledger.** The same issue as Hetzner's ("pool ledger" in `SSFSKIM/ci-kit-sandbox`), one comment
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
- `node gce/tools/boot-sample.mjs --image <name> [--region <r>] [--machine <m>] [--count 5] [--parallel 2] [--out <dir>]`
  times job VMs from an image through the bake's real-job path (one `bake-check` job per sample in ci-kit-sandbox,
  on its own JIT runner) in one placement: `--region`'s (default: the first), on its zones, subnetwork and boot disk
  type, with `--machine` (default: its size-4 machine). It reports insert accepted → RUNNING → job started, keeps each
  sample's console and `ci-kit/job` report, and gives the median and range of each stage. It shares the pool's quota and stops at the first quota refusal;
  every VM and runner it made is gone when it ends.
- `end`: `done` (its job ended, or its runner did), `cancelled-idle` (no job came within `idle_runner_minutes`, or
  its repo stopped being served), `preempted`, `max-run` (Compute Engine's run limit, or the launcher's overage
  rule), `abandoned` (no VM was created: every zone refused, quota, or a crash before the insert), `orphan` (a VM
  the launcher had no row for, or one that vanished before its run limit with no preemption recorded: deleted by a
  hand outside the launcher).
- `seconds` runs from the VM's creation to its deletion, `$` at the rates in `gce/launcher/ledger.mjs` by region and
  family (c3d and e2 in us-central1, 2026-10-16; c4d in us-west4, the Cloud Billing catalog on 2026-10-21, SKU ids
  beside the table), the address and the disk by region and type included (Hyperdisk Balanced with the IOPS and
  throughput its defaults provision above the free baseline). A VM in a region, family or disk type with no rate
  there shows `-`. The row's JSON carries the disk type (`diskType`; a row without one is from before placements,
  on `pd-balanced`).
- The daily line, `**GCE pool, <day> (UTC):** …`, totals the day's VMs, seconds and dollars, projects the month at
  that rate, gives each family@region's VMs and dollars (and how many it could not price), on a day with
  pre-launches how many VMs were pre-launched, how many no job claimed and what those cost (`Pre-launched: N VMs, M
  unclaimed ($x)`), and names the gce.json commit the launcher ran.
- A writer reads a row's comment again just before updating it, and drops the write if the comment is already as
  far along; a final row is never rewritten. Issue comments have no compare-and-swap, so during an overlap of two
  ticks a row is eventually final rather than finalized once: a stale write that lands in the milliseconds after
  another tick finalized the row rolls it back to running, and the next tick finalizes it again, possibly with a
  later deletion time and charge.
- A launcher outage of more than 26 hours leaves residue (a deferred review finding). A row not yet final falls out
  of the window the launcher reads and stays unfinished in the ledger. Its VM is not necessarily gone:
  `maxRunDuration` deletes only a VM that is still running, and a VM whose guest powered off after its job is
  `TERMINATED` with its timer cleared, so it and its disk stay, costing about $0.007 a day at 50 GB, until the
  launcher is back. Its first tick deletes the stopped VM, under a new row ended `orphan` (it finds no row for it),
  so the old row stays unfinished beside it. The failed-tick alert fires within minutes of an outage, long before
  26 hours.
- Hidden markers `<!-- ci-kit-gce-ledger {…} -->` and `<!-- ci-kit-gce-daily {…} -->` hold the JSON the kit reads;
  the Hetzner readers skip them.

**Moving a repo between backends.** The preferred move is a window with the repo's pool lane off (spec §3a): the
repo's owner unsets the toggle (MAWS: `GATE_RUNNER`), so its pool jobs run hosted and nothing is in flight on either
backend; then one commit on main moves the repo between `pool.json` and `gce.json`; then the owner sets the toggle
again. Before the commit:

- From Hetzner: no job of the repo `in_progress` on a `ci-kit-pool-*` runner
  (`gh api repos/<repo>/actions/runs?status=in_progress` and their jobs' `runner_name`), and no pool box serving it
  (idle, or deleted by hand once idle, with a `manual` ledger row).
- From GCE (the fallback, reversed): no `ci-kit=gce` instance with `ci-kit-repo=<owner>--<repo>`
  (`gcloud compute instances list --project=ssfskim-ci-kit --filter='labels.ci-kit-repo=<owner>--<repo>'`).

When the lane cannot be toggled, the move is fail-closed: remove the repo from its old file first, wait for its
work there to end, then add it to the new file; jobs queued in between wait in GitHub's queue. A repo removed from
`gce.json` is draining: the launcher launches nothing for it, leaves its busy VMs to finish, and unregisters its
idle runners first, at once. To know the launcher runs the removal commit, read `config` in its tick log (a launcher
that cannot read main keeps its last good copy, and its log says so).

**Quotas and budget.** `max_vcpus` (242: the granted C3D us-central1 192 plus C4D us-west4 50, 2026-10-21) is the
launcher's soft cap on the vCPUs of its VMs in flight; the project's
quotas are the hard cap, and a refusal is a wait. Parallelism comes first: the owner ruled on 2026-10-21 that CI must
never be the bottleneck, and that cost is not a reason to lower parallelism. So `max_vcpus` follows the quotas. Granted
through Cloud Quotas:
- 2026-10-21: `CPUS-ALL-REGIONS` 256, C3D per-family 192 in us-central1, `INSTANCES` 64, `SSD-TOTAL-GB` 4096;
  `IN-USE-ADDRESSES` asked 64, still 32 when this was written (each job VM holds one external address, so 32 VMs at
  once until granted);
- 2026-10-16: the first grants;
- never granted: E2 per-family stays at its default 24 (asked 64, refused twice), so at most 12 `cpus-2` VMs run on E2
  and the rest fell back to `c3d-highcpu-4` (`machine_fallback`); E2 has since left the pool with that key.

A job reserves the largest machine its walk could land on in the launcher's count (a `cpus-2` job: `c3d-highcpu-4`).
`max_vcpus` admits only; it tracks the sum of the placements' granted family quotas, and a placement's own refusal
(family vCPUs, addresses, instances) falls through to the next one, so raise it with each grant (C4D us-west4's
re-filed 128 was denied 2026-10-21, so it stays 50; addresses pending in both regions).
`PREEMPTIBLE_CPUS` is 0, so spot VMs count against the ordinary CPU quotas. To check:

```
gcloud compute regions describe us-central1 --project=ssfskim-ci-kit --format=json | jq '.quotas[]|select(.metric|test("^(CPUS|E2_CPUS|INSTANCES|IN_USE_ADDRESSES|SSD_TOTAL_GB)$"))'
```

The billing budget alert on the project ($40, mails at 50/90/100 %) is the billing admin's to create (spec,
Human-only steps). The Monitoring alert `ci-kit launcher ticks failing` mails the owner when three ticks fail within
10 minutes.
