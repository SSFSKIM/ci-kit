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
(`pool/bake/builder.sh`) installs Docker and Node, clones the kit at the run's commit, builds the runner image
(`pool/image/Dockerfile`), warms the caches (`pool/bake/warm.mjs`, which records what it did in
`/var/lib/ci-kit/cache/warm.json` on the image, readable by jobs), writes `/etc/ci-kit/`, smoke-tests a cpuset container, marks itself
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
