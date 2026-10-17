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
| launcher (Cloud Run service `ci-kit-launcher`) | `gce/launcher/`: `server.mjs` (the service), `launcher.mjs` (one tick), decisions in `logic.mjs`, ledger rows in `ledger.mjs` and `ledger-store.mjs`, configs from main in `source.mjs` |
| bake (orchestrator, decisions) | `gce/bake/bake.mjs`, `gce/bake/plan.mjs` |
| builder (startup script) | `gce/bake/builder.sh`, sharing `pool/bake/prepare.sh` with the Hetzner builder |
| the VM's job unit and smoke check | `gce/vm/` (`ci-kit-gce-job.service`, `job.mjs`, `run.mjs`, `smoke.sh`) |
| Compute Engine and Secret Manager client | `lib/gce.mjs` |
| deploy | `gce/deploy.sh` |
| config | `pool/config/gce.json` (I12) |

**The launcher.** Cloud Scheduler's `ci-kit-launcher-tick` POSTs to `ci-kit-launcher` every minute with an OIDC
token; the service has no public ingress (`--ingress=internal`, IAM-only), runs one instance at a time, one request
at a time. Each request is one reconciliation, and nothing is kept between them: state is in GCE labels, the ledger
and GitHub. A tick:

1. reads `gce.json` and `pool.json` from the kit's main (the newest commit that changed each; on a failed read it
   keeps the last good copy, and at a cold start without main, the copy in its own build);
2. refuses public repos and any repo in both files;
3. reads the ledger's last 26 h on every open ledger issue (below), then lists the `ci-kit=gce` instances and disks;
4. lists each repo's `ci-kit-gce-*` runners, and its queued and in-progress runs and their jobs;
5. cleans up (below), finalizes rows whose VM is gone, and records on each running row the job its runner holds;
6. launches one VM per queued pool job not covered by an unclaimed VM (a runner registered, not busy, younger than
   `idle_runner_minutes`; a busy one covers nothing), oldest job first, while the vCPUs in flight stay at or under
   `max_vcpus`;
7. once a day, in its first two hours (UTC), writes yesterday's daily line.

A launch writes the `launching` row, mints the JIT config (runner name = instance name, labels `self-hosted`,
`ci-kit-pool`, `cpus-N`, `ci-kit-gce`, work folder `/var/lib/ci-kit/cache/work/<instance>`), then creates
`ci-kit-gce-<allocation id>` from the newest image labelled `ci-kit-ready=true`. It tries the size's machine as spot
in each zone of `zones` in order, then on demand in each zone, then `machine_fallback` the same way.
`ZONE_RESOURCE_POOL_EXHAUSTED*` moves to the next zone; a quota refusal skips the machine and ends the tick's
launches (the job waits in GitHub's queue); an insert whose outcome is unknown is settled through its zone operation
before any other zone is tried, and if it stays unknown the walk stops and the cleanup rules settle it. The VM:
no service account, the JIT config in metadata `ci-kit-jit`, `maxRunDuration` = `max_run_minutes` with a `DELETE`
action, a `pd-balanced` boot disk of `disk_gb` that goes with it, labels `ci-kit=gce`, `ci-kit-alloc`,
`ci-kit-repo=<owner>--<repo>`, `ci-kit-cpus`, `ci-kit-provisioning=spot|standard` and `ci-kit-config=<gce.json
commit, 8>`.

Allocation ids are the launch minute in base36 (5 characters) and 5 random ones (about 60 million a minute), so a
runner's age is read from its name, never more than the real one: the runners API gives no creation time.
Admission reserves the largest machine a launch could land on (an `e2-highcpu-2` job reserves 4, its fallback
`c3d-highcpu-4`'s), and no placement attempt starts once the tick's 45 s budget is spent; the job waits for the
next tick. An attempt already started waits for its operation up to 40 s whatever the budget, since giving up early
only defers what the operation decides. Up to 16 launches run at once, so a burst launches in one round.

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
finalized, since another tick may have just created it. When the aggregated listing reports a zone unreachable,
the tick launches nothing and does nothing that rests on something being absent (finalizing a vanished VM's row,
unregistering a runner with no VM); when GCE's operation history cannot be read, a vanished VM's row waits rather
than being called `orphan`. Runners are listed for every repo with a row in the ledger's window, so a repo that has
left `gce.json` is still cleaned until its last runner is gone.

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
job ("runner lost"), and the launcher finalizes the row `preempted` with the job the runner held, which it wrote on
the row while the job ran. Re-run it, for example with `ci-gate` again.

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
- No VM gets a service account or a key. The builder gets a one-hour installation token, narrowed to reading
  MAWS's contents (`WARM_SCOPE` in `pool/bake/warm.mjs`), in its metadata; the image is made from its disk, never
  from its metadata.

**The network.** Every builder, smoke VM and job VM sits on the subnetwork `ci-kit-us-central1` (10.64.0.0/20) of
the VPC `ci-kit`, named in `gce.json` (`network`, `subnetwork`), with an ephemeral external address for outbound
traffic. The VPC has no firewall rule: GCE's implied rules deny all ingress and allow all egress. The project's
`default` network is never used, since its stock rules open ssh and RDP to the internet. `gce/deploy.sh network`
creates both idempotently and fails if any rule allows ingress into `ci-kit`. Networks and firewall rules take no
labels; the names carry the kit's. To check:

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
2. It creates `ci-kit-gce-builder-<run id>` (the run id is UTC seconds plus four random characters, so two bakes
   never share one; on demand: `e2-standard-4`, else `n2d-standard-4` when E2 is refused,
   zones in `gce.json` order) from `ubuntu-2404-lts-amd64`. Its startup script (`gce/bake/builder.sh`) installs
   Docker, clones the kit at the commit, runs `pool/bake/prepare.sh` (Node, the runner image, the caches), requires
   every cache warmed, installs and enables `ci-kit-gce-job.service`, cleans the disk, reports
   `ci-kit/bake=ok` (or `failed:<step>`) as a guest attribute, and powers off. GCE deletes a builder still running
   at 45 min.
3. Only on `ok` and power-off within 30 min, it images the builder's disk into the family, labelled
   `ci-kit-ready=false`, and deletes the builder.
4. It boots `ci-kit-gce-builder-<run id>-smoke` from the image on the `cpus-2` machine (its fallback when E2 is
   refused), with metadata `ci-kit-smoke=<vCPUs>` in place of a JIT config. The job unit runs `gce/vm/smoke.sh` in a
   job container: vCPUs, user, isolation, the runner, Node 22 and 24, every warmed cache, the work directory, DNS,
   egress, and the metadata server refused. It reports `ci-kit/smoke=ok|failed:<check>` and powers off.
5. On a pass the image is labelled `ci-kit-ready=true`; the launcher uses only ready images (never
   `getFromFamily`, which would return an unready one). On any failure the bake deletes its own image.
6. On every exit it deletes its instances, and keeps the two newest ready images (unready images of other runs
   are dropped once 2 h old). It deletes an image only while that image carries its `ci-kit-run` label: an image
   insert refused because the name exists leaves the existing image alone.

The Cloud Run job `ci-kit-bake` runs the same script as `ci-kit-launcher@`, at main's head: `gce/deploy.sh bake`
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

**The job VM.** At boot, `ci-kit-gce-job.service` runs `gce/vm/job.mjs`: it drops the job container's TCP and UDP
to `169.254.169.254` except port 53 (GCE's resolver lives there), runs one job container from
`ci-kit-runner:latest` on all of the VM's vCPUs with the Hetzner container's mounts and environment and the JIT
config from metadata `ci-kit-jit`, reports `ci-kit/job=exit:<code>`, and the unit powers the VM off at once
(`poweroff-immediate`: no orderly shutdown, since the disk is discarded; an orderly one took about 85 s). A VM with no
`ci-kit-jit` and no `ci-kit-smoke` reports `ci-kit/job=failed:no-jit` and powers off. Every VM needs metadata
`enable-guest-attributes=TRUE` for the reports.

**Deploy.** From a clean checkout of a commit on GitHub, with gcloud's default account (an owner of the project):

```
gce/deploy.sh                       # every part, in order; or name parts:
gce/deploy.sh base network          # APIs, the service account and its compute role; the VPC
gce/deploy.sh bake bake-schedule    # the Cloud Run job ci-kit-bake and its weekly Scheduler job
gce/deploy.sh launcher launcher-schedule   # the Cloud Run service ci-kit-launcher and its one-minute tick
gce/deploy.sh alert                 # the failed-tick metric and its alert policy, mailed to the owner
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
finalized, the gce.json commit it ran (`config`), and its GitHub budget.

**Reading the GCE ledger.** The same issue as Hetzner's ("pool ledger" in `SSFSKIM/ci-kit-sandbox`), one comment
per allocation:

```
| alloc | instance | repo | job (actual) | created (UTC) | deleted (UTC) | machine@zone | spot/standard | seconds | $ | end |
```

- The deleted column reads `launching` (before the VM exists), `running`, or `deleting <time>` until the row is
  final. A row never moves back.
- `job (actual)` is the job the runner held, by name and id: a runner takes any queued job of its repo and size,
  so it may not be the one the launch was for.
- `end`: `done` (its job ended, or its runner did), `cancelled-idle` (no job came within `idle_runner_minutes`, or
  its repo stopped being served), `preempted`, `max-run` (Compute Engine's run limit, or the launcher's overage
  rule), `abandoned` (no VM was created: every zone refused, quota, or a crash before the insert), `orphan` (a VM
  the launcher had no row for, or one that vanished before its run limit with no preemption recorded: deleted by a
  hand outside the launcher).
- `seconds` runs from the VM's creation to its deletion, `$` at the rates in `gce/launcher/ledger.mjs` (us-central1,
  2026-10-16), the address and the disk included.
- The daily line, `**GCE pool, <day> (UTC):** …`, totals the day's VMs, seconds and dollars, projects the month at
  that rate, and names the gce.json commit the launcher ran.
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

**Quotas and budget.** `max_vcpus` (64) is the launcher's soft cap on the vCPUs of its VMs in flight; the project's
quotas are the hard cap, and a refusal is a wait. Granted on 2026-10-16 (Cloud Quotas): `CPUS-ALL-REGIONS` 96, C3D
per-family 64 in us-central1, `IN-USE-ADDRESSES` 32, `SSD-TOTAL-GB` 2048. Not granted: E2 per-family stays at its
default 24 (asked 64), so at most 12 `cpus-2` VMs run on E2 and the rest fall back to `c3d-highcpu-4`
(`machine_fallback`). `INSTANCES` is 24 in us-central1: at most 24 job VMs at once, whatever `max_vcpus` says.
`PREEMPTIBLE_CPUS` is 0, so spot VMs count against the ordinary CPU quotas. To check:

```
gcloud compute regions describe us-central1 --project=ssfskim-ci-kit --format=json | jq '.quotas[]|select(.metric|test("^(CPUS|E2_CPUS|INSTANCES|IN_USE_ADDRESSES|SSD_TOTAL_GB)$"))'
```

The billing budget alert on the project ($40, mails at 50/90/100 %) is the billing admin's to create (spec,
Human-only steps). The Monitoring alert `ci-kit launcher ticks failing` mails the owner when three ticks fail within
10 minutes.
