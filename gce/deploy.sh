#!/bin/bash
# Deploys the GCE backend's control plane (spec §3a, I12) into ssfskim-ci-kit, idempotently, from the MacBook with
# gcloud's default account. No GCP credential exists anywhere else.
#   gce/deploy.sh [base] [network] [bake] [bake-schedule] [launcher] [launcher-schedule] [alert]
#                  (no argument: all of them, in that order)
#   base               the APIs, the service account ci-kit-launcher, and its compute role on the project
#   network            the VPC ci-kit and its subnetwork ci-kit-us-central1, with no firewall rule: GCE's implied rules
#                      deny all ingress and allow all egress. It then checks that no rule allows ingress into it.
#   bake               the Cloud Run job ci-kit-bake, built from this checkout
#   bake-schedule      the Scheduler job ci-kit-bake-weekly, which runs the bake every Sunday at 18:00 UTC
#   launcher           the Cloud Run service ci-kit-launcher, built from this checkout: no public ingress, one
#                      instance, one request at a time, 300 s per request
#   launcher-schedule  the Scheduler job ci-kit-launcher-tick, which calls the launcher every minute with an OIDC token
#   alert              a log-based metric of failed ci-kit-launcher-tick executions and an alert policy on it, mailed
#                      to CI_KIT_ALERT_EMAIL (default: the project's owner)
# The App's secrets (ci-kit-app-id, ci-kit-app-key, readable by the service account only) are created by hand:
# docs/pool.md, GCE. Deploy from a clean checkout of a commit on GitHub: the services record it as CI_KIT_COMMIT.
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
    cloudscheduler.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
    logging.googleapis.com monitoring.googleapis.com
  g iam service-accounts describe "$SA" > /dev/null 2>&1 ||
    g iam service-accounts create "$SA_NAME" --display-name='ci-kit launcher and bake'
  # Create, label and delete the backend's instances, disks and images. VMs get no service account, so the account
  # needs no actAs on any other.
  g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" \
    --role=roles/compute.instanceAdmin.v1 --condition=None > /dev/null
  # Cloud Run source deploys build as the project's default compute account (new projects since 2024), which needs
  # the builder role to read the uploaded source and push the image. No kit VM runs as that account: VMs have none.
  local number
  number=$(g projects describe "$PROJECT" --format='value(projectNumber)')
  g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$number-compute@developer.gserviceaccount.com" \
    --role=roles/run.builder --condition=None > /dev/null
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
    --command=launcher --args=node,gce/bake/bake.mjs --labels=ci-kit=bake \
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

COMMIT=$(git -C "$KIT" rev-parse HEAD)
LAUNCHER=ci-kit-launcher

launcher() {
  # Buildpack images keep node in their layers, off the bare PATH: the CNB `launcher` sets up the layers' environment
  # and then runs the command (the same holds for the bake job above).
  # Request-based billing: a tick a minute of well under a second's work stays in the free tier.
  g run deploy "$LAUNCHER" --source="$KIT" --region="$REGION" --service-account="$SA" \
    --command=launcher --args=node,gce/launcher/server.mjs --set-env-vars="CI_KIT_COMMIT=$COMMIT" --labels=ci-kit=launcher \
    --no-allow-unauthenticated --ingress=internal --min-instances=0 --max-instances=1 --concurrency=1 \
    --timeout=300 --cpu=1 --memory=512Mi
  # Cloud Scheduler calls it as the service account, which may invoke it and nothing else may.
  g run services add-iam-policy-binding "$LAUNCHER" --region="$REGION" \
    --member="serviceAccount:$SA" --role=roles/run.invoker > /dev/null
  echo "deploy: launcher ok (kit ${COMMIT:0:8})"
}

launcher_schedule() {
  local url verb=create
  url=$(g run services describe "$LAUNCHER" --region="$REGION" --format='value(status.url)')
  [ -n "$url" ] || die "the launcher is not deployed (gce/deploy.sh launcher)"
  g scheduler jobs describe ci-kit-launcher-tick --location="$REGION" > /dev/null 2>&1 && verb=update
  g scheduler jobs "$verb" http ci-kit-launcher-tick --location="$REGION" \
    --schedule='* * * * *' --time-zone=Etc/UTC --http-method=POST --uri="$url/tick" \
    --oidc-service-account-email="$SA" --oidc-token-audience="$url" --attempt-deadline=300s > /dev/null
  echo "deploy: launcher schedule ok (every minute → $url/tick)"
}

# A launcher that is down leaves stopped VMs to cost their disks and the ledger's daily line missing (spec §3a
# Lifetime bounds): three failed ticks within 10 minutes mail the owner. Metrics, channels and policies take no
# resource labels everywhere; their names carry the kit's, and the policy and channel carry ci-kit user labels.
ALERT_METRIC=ci-kit-launcher-tick-failed
alert() {
  local email=${CI_KIT_ALERT_EMAIL:-kimmi@l1ngual.com} channel policy
  g logging metrics describe "$ALERT_METRIC" > /dev/null 2>&1 ||
    g logging metrics create "$ALERT_METRIC" \
      --description='ci-kit: failed executions of the Scheduler job ci-kit-launcher-tick (spec 3a)' \
      --log-filter='resource.type="cloud_scheduler_job" AND resource.labels.job_id="ci-kit-launcher-tick" AND severity>=ERROR'
  # Only resource names are kept from gcloud's output: its first alpha or beta call may install those components and
  # print the installer's lines to stdout.
  channel=$(g beta monitoring channels list --filter="displayName=\"ci-kit owner\"" --format='value(name)' | grep '^projects/' | head -1 || true)
  [ -n "$channel" ] || channel=$(g beta monitoring channels create --display-name='ci-kit owner' --type=email \
    --channel-labels="email_address=$email" --user-labels=ci-kit=alert --format='value(name)' | grep '^projects/' | head -1)
  [ -n "$channel" ] || die "no notification channel"
  policy=$(g alpha monitoring policies list --filter='displayName="ci-kit launcher ticks failing"' --format='value(name)' | grep '^projects/' | head -1 || true)
  if [ -z "$policy" ]; then
    local file
    file=$(mktemp)
    cat > "$file" <<JSON
{"displayName": "ci-kit launcher ticks failing",
 "documentation": {"content": "Cloud Scheduler's ci-kit-launcher-tick failed 3 times in 10 minutes: the GCE launcher (Cloud Run ci-kit-launcher in ssfskim-ci-kit) is not reconciling. Stopped pool VMs cost their disks until it is back. Read its logs: gcloud run services logs read ci-kit-launcher --region=us-central1 --project=ssfskim-ci-kit. docs/pool.md, GCE.", "mimeType": "text/markdown"},
 "userLabels": {"ci-kit": "alert"},
 "combiner": "OR",
 "conditions": [{"displayName": "failed ticks",
   "conditionThreshold": {"filter": "metric.type=\"logging.googleapis.com/user/$ALERT_METRIC\" AND resource.type=\"cloud_scheduler_job\"",
     "aggregations": [{"alignmentPeriod": "600s", "perSeriesAligner": "ALIGN_SUM", "crossSeriesReducer": "REDUCE_SUM"}],
     "comparison": "COMPARISON_GT", "thresholdValue": 2, "duration": "0s", "trigger": {"count": 1}}}],
 "alertStrategy": {"autoClose": "3600s"},
 "notificationChannels": ["$channel"]}
JSON
    g alpha monitoring policies create --policy-from-file="$file" > /dev/null
    rm -f "$file"
  fi
  echo "deploy: alert ok (metric $ALERT_METRIC, mailed to $email)"
}

[ $# -gt 0 ] || set -- base network bake bake-schedule launcher launcher-schedule alert
for part in "$@"; do
  case $part in
    base) base ;;
    network) network ;;
    bake) bake ;;
    bake-schedule) bake_schedule ;;
    launcher) launcher ;;
    launcher-schedule) launcher_schedule ;;
    alert) alert ;;
    *) die "unknown part $part (base, network, bake, bake-schedule, launcher, launcher-schedule, alert)" ;;
  esac
done
