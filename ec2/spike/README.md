# M1 measurement prototype

The [verdict](../../docs/doperpowers/specs/2026-10-23-ec2-pool-m1-verdict.md) and `evidence/` hold the results. These scripts are the experiment, not a second launcher or the production bake. M3 replaces them. They use Node built-ins, the existing GitHub App client, aws CLI and gcloud. MAWS runs only in guest containers.

The resource constants deliberately identify this account's Ohio default VPC/subnets and the ready GCE image tested on 2026-10-23. The recorded AMI and all job resources were deleted. A repeat needs a new bake; the historical ready image/base AMI may eventually be retired.

```sh
export AWS_PROFILE=ci-kit-ops AWS_REGION=us-east-2
export SPIKE_STATE=$(mktemp -d /private/tmp/ci-kit-spike.XXXXXX)
printf '%s\n' '{"sha":"9045f31adaaf54b4f4fb628466e03a02f2ed1ade"}' > "$SPIKE_STATE/maws-head.json"
node ec2/spike/federate.mjs             # real claims, four-hour STS proof; idempotent partial setup
node ec2/spike/run.mjs build           # on-demand, stop-capable builder
node ec2/spike/run.mjs image <builder-id>
aws ec2 wait image-available --image-ids <ami-id>
node ec2/spike/run.mjs aws <ami-id> us-east-2c 6
node ec2/spike/run.mjs gce us-east5-a
# Other arms, separate fresh volumes:
SPIKE_PREFETCH=1 node ec2/spike/run.mjs aws <ami-id> us-east-2c 1
SPIKE_INIT_RATE=200 node ec2/spike/run.mjs aws <ami-id> us-east-2c 1
SPIKE_INIT_RATE=300 node ec2/spike/run.mjs aws <ami-id> us-east-2c 1
# A boot-only observation uses 0 runs. Resume collection of an already accepted instance, never relaunch it:
node ec2/spike/run.mjs observe <instance-id>
node ec2/spike/summarize.mjs "$SPIKE_STATE" > measurements.json
node ec2/spike/run.mjs cleanup
```

`SPIKE_STATE` is private: raw GCE metadata contains short-lived App tokens and JIT configs. Do not commit raw metadata, tokens or console logs. `summarize.mjs` emits only timings, machine/image provenance, counters, tool versions and aggregate test counts. The committed evidence contains no credentials or private MAWS source/test names.

Run one orchestration loop at a time per cloud by default. This experiment kept at most four c8a.2xlarge instances running; fast replacement can still be quota-refused after termination. Every guest has a poweroff deadline, but cleanup is still required for stopped builders, snapshots and runner registrations. A failed script does not mean its accepted VM disappeared. The cleanup command preserves the setup roles/security group and the GCP impersonation binding.

The final builder handshake keeps a successful builder running until READY is collected, then stops it from the controller. That correction was syntax-checked after the measured bake; it was not used to create another AMI. The measured bake powered off itself, its stopped console was empty, and the subsequent job boots confirmed its warmed image. Production M3 should use its designed report channel rather than console retention.

Checks and evidence processing:

```sh
node --test ec2/spike/metrics.test.mjs
node ec2/spike/summarize.mjs "$SPIKE_STATE" > ec2/spike/evidence/measurements.json
# costs.mjs also consumes captured snapshot/Price List/Spot history and termination records in the private state:
node ec2/spike/costs.mjs "$SPIKE_STATE" <cleanup-ISO> > ec2/spike/evidence/costs.json
ci-gate .                             # committed HEAD, on GitHub Actions
```

Regional tariffs were read with `aws pricing get-products --region us-east-1 --service-code AmazonEC2`, filtered to `location=US East (Ohio)`, `productFamily=ProvisionedRateVolumeInitialization`. Pricing is a global endpoint; EC2 operations stay in us-east-2. The global AmazonVPC catalog supplies Ohio public IPv4 pricing. GCE planning rates come from the existing ledger implementation.
