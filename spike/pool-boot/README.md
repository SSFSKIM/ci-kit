# M4 spike: the pool's boot path

Measured on 2026-10-15, 21:45–21:58 UTC. Throwaway code: M5 builds the real bake,
agent and ensure. It is kept because the box-side pieces are the shape M5's bake
starts from, and `trial.mjs` re-measures a cold start in two minutes.

## What was measured

A cold create of a `cpx62` in `hel1` from a snapshot, with a `cpus-4` pool job
already queued in `SSFSKIM/ci-kit-sandbox` (workflow `spike-pool.yml`), timed from
`POST /servers` to the job's `started_at`. The JIT runner config is minted on the
Mac with `gh api` and travels in user-data; a systemd unit in the snapshot
(`ci-kit-spike-boot`, standing in for the agent's start) reads it from the
metadata service and starts one runner container with `--cpuset-cpus=0-3
--memory=8g`.

- **small**: Ubuntu 24.04 + `docker.io` + the pinned `actions-runner` 2.338.0
  image. Snapshot `image_size` 1.70 GB (compressed), `disk_size` 40.
- **large**: the same + 10 GiB of incompressible data under
  `/var/lib/ci-kit/cache/`. Snapshot `image_size` 12.16 GB.

Builders were `cx23` in `hel1`; each was done (powered off) about 100 s after create.

## Results (seconds from `POST /servers`)

| trial | running seen | kernel boot | ready (unit start) | runner online | job `started_at` | job step |
|---|---|---|---|---|---|---|
| small-1 | 12.7 | 18.9 | 35.4 | 41.0 | **40.9** | 42.6 |
| small-2 | 19.4 | 26.5 | 41.6 | 47.5 | **46.5** | 48.3 |
| small-3 | 20.2 | 24.6 | 46.7 | 51.3 | **51.6** | 53.8 |
| large-1 | 24.4 | 28.7 | 43.1 | 48.0 | **48.7** | 50.8 |
| large-2 | 22.2 | 29.3 | 51.1 | 56.4 | **56.3** | 58.3 |
| large-3 | 24.8 | 29.3 | 44.7 | 50.1 | **51.3** | 52.6 |

- p90 (nearest rank; the maximum of three): small 51.6 s, large 56.3 s. Plus the
  spec's 1 min for plan and ensure: **1.9 min**. Verdict band: ≤ 5 min.
- Snapshot size adds about 5 s (median 51.3 vs 46.5 s), mostly before the kernel
  starts.
- `ready` → job `started_at`: 4.9–6.6 s (container start, runner connect, job
  assignment). The runner image was pre-pulled; no runner self-update happened.
- Inside the container: `nproc` = 4, `os.availableParallelism()` = 4, cpuset
  `0-3`, `memory.max` = 8 GiB, but `getconf _NPROCESSORS_ONLN` = **16** on all six.
- The hosted stand-in for the plan job started 3–4 s after the run was created
  and its checkout step took 4–5 s.

Raw records are in `results/`; `node summarize.mjs results/trial-*.json` reprints
the table.

## Rerun

```
node make-snapshots.mjs cx23 hel1          # prints the two snapshot ids
node trial.mjs <name> <snapshot-id> cpx62 hel1
node summarize.mjs /tmp/ci-kit-m4/trial-*.json
```

Then delete the snapshots and the `ci-kit-spike` firewall (label `ci-kit=spike`).
