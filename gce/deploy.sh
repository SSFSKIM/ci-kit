#!/bin/bash
# Deploys the GCE backend's control plane (spec §3a, I12) into ssfskim-ci-kit, idempotently, from the MacBook with
# gcloud's default account. No GCP credential exists anywhere else.
#   gce/deploy.sh [base] [network] [bake] [bake-schedule]     (no argument: all of them, in that order)
#   base           the APIs, the service account ci-kit-launcher, and its compute role on the project
#   network        the VPC ci-kit and its subnetwork ci-kit-us-central1, with no firewall rule: GCE's implied rules
#                  deny all ingress and allow all egress. It then checks that no rule allows ingress into it.
#   bake           the Cloud Run job ci-kit-bake, built from this checkout
#   bake-schedule  the Scheduler job ci-kit-bake-weekly, which runs the bake every Sunday at 18:00 UTC
# The App's secrets (ci-kit-app-id, ci-kit-app-key, readable by the service account only) are created by hand for
# now: docs/pool.md, GCE.
set -euo pipefail
PROJECT=ssfskim-ci-kit
REGION=us-central1
SA_NAME=ci-kit-launcher
SA="$SA_NAME@$PROJECT.iam.gserviceaccount.com"
KIT=$(cd "$(dirname "$0")/.." && pwd)

g() { gcloud --project="$PROJECT" --quiet "$@"; }
die() { echo "deploy: $*" >&2; exit 1; }

base() {
  g services enable compute.googleapis.com secretmanager.googleapis.com run.googleapis.com \
    cloudscheduler.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
  g iam service-accounts describe "$SA" > /dev/null 2>&1 ||
    g iam service-accounts create "$SA_NAME" --display-name='ci-kit launcher and bake'
  # Create, label and delete the backend's instances, disks and images. VMs get no service account, so the account
  # needs no actAs on any other.
  g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" \
    --role=roles/compute.instanceAdmin.v1 --condition=None > /dev/null
  echo "deploy: base ok ($SA)"
}

# Every pool VM and bake VM sits here, never on the project's default network, whose stock rules open ssh and RDP to
# the internet and allow ingress inside the network (spec §3a Network: no inbound rules). Networks and firewall rules
# take no labels; the names carry the kit's.
NETWORK=ci-kit
SUBNET=ci-kit-us-central1
SUBNET_RANGE=10.64.0.0/20
network() {
  g compute networks describe "$NETWORK" > /dev/null 2>&1 ||
    g compute networks create "$NETWORK" --subnet-mode=custom \
      --description='ci-kit: pool and bake VMs (spec 3a); no ingress rules, egress by the implied rule'
  g compute networks subnets describe "$SUBNET" --region="$REGION" > /dev/null 2>&1 ||
    g compute networks subnets create "$SUBNET" --network="$NETWORK" --region="$REGION" --range="$SUBNET_RANGE" \
      --description='ci-kit: pool and bake VMs'
  local open
  open=$(g compute firewall-rules list --format='value(name,network.basename(),direction,disabled,allowed[].map().firewall_rule().list())' |
    awk -F'\t' -v net="$NETWORK" '$2 == net && $3 == "INGRESS" && $4 != "True" && $5 != "" { print $1 }')
  [ -z "$open" ] || die "network $NETWORK has rules allowing ingress: $open"
  echo "deploy: network ok ($NETWORK, $SUBNET $SUBNET_RANGE; no ingress allowed)"
}

bake() {
  # The job runs the bake orchestrator only; the builder clones the kit at the commit it bakes (main's head).
  g run jobs deploy ci-kit-bake --source="$KIT" --region="$REGION" --service-account="$SA" \
    --command=node --args=gce/bake/bake.mjs --labels=ci-kit=bake \
    --tasks=1 --max-retries=0 --task-timeout=60m --cpu=1 --memory=512Mi
  g run jobs add-iam-policy-binding ci-kit-bake --region="$REGION" \
    --member="serviceAccount:$SA" --role=roles/run.invoker > /dev/null
  echo "deploy: bake job ok"
}

bake_schedule() {
  local verb=create
  g scheduler jobs describe ci-kit-bake-weekly --location="$REGION" > /dev/null 2>&1 && verb=update
  g scheduler jobs "$verb" http ci-kit-bake-weekly --location="$REGION" \
    --schedule='0 18 * * 0' --time-zone=Etc/UTC --http-method=POST \
    --uri="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/ci-kit-bake:run" \
    --oauth-service-account-email="$SA" > /dev/null
  echo "deploy: bake schedule ok"
}

[ $# -gt 0 ] || set -- base network bake bake-schedule
for part in "$@"; do
  case $part in
    base) base ;;
    network) network ;;
    bake) bake ;;
    bake-schedule) bake_schedule ;;
    *) die "unknown part $part (base, network, bake, bake-schedule)" ;;
  esac
done
