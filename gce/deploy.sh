#!/bin/bash
# Deploys the GCE backend's control plane (spec §3a, I12) into ssfskim-ci-kit, idempotently, from the MacBook with
# gcloud's default account. No GCP credential exists anywhere else.
#   gce/deploy.sh [base] [bake] [bake-schedule]     (no argument: all of them, in that order)
#   base           the APIs, the service account ci-kit-launcher, and its compute role on the project
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

[ $# -gt 0 ] || set -- base bake bake-schedule
for part in "$@"; do
  case $part in
    base) base ;;
    bake) bake ;;
    bake-schedule) bake_schedule ;;
    *) die "unknown part $part (base, bake, bake-schedule)" ;;
  esac
done
