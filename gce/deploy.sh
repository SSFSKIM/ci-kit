#!/bin/bash
# Deploys the GCE backend's control plane (spec §3a, I12) into ssfskim-ci-kit, idempotently, from the MacBook with
# gcloud's default account. No GCP credential exists anywhere else.
#   gce/deploy.sh [base] [network] [bake] [bake-schedule] [launcher] [launcher-schedule] [webhook] [alert] [app-hook]
#                  (no argument: all of them but app-hook, in that order)
#   base               the APIs, the service account ci-kit-launcher and its compute role on the project, the receiver's
#                      service account ci-kit-webhook (no role here: webhook grants its two), and serial port logging, so
#                      a VM deleted after a failed boot leaves its console in Cloud Logging
#   network            the VPC ci-kit and a subnetwork for each placement of pool/config/gce.json (gce/subnets.mjs: a new
#                      one takes the first free /20 of 10.64.0.0/16; one that exists keeps its range), each with Private
#                      Google Access, and in each placement region a Cloud Router ci-kit-router with a Cloud NAT
#                      ci-kit-nat: pool and bake VMs have no external address. No firewall rule: GCE's implied rules
#                      deny all ingress and allow all egress. It then checks that no rule allows ingress into it.
#   bake               the Cloud Run job ci-kit-bake, built from this checkout
#   bake-schedule      the Scheduler job ci-kit-bake-weekly, which runs the bake every Sunday at 18:00 UTC
#   launcher           the Cloud Run service ci-kit-launcher, built from this checkout: no public ingress, one
#                      instance, 300 s per request; requests are many at a time, ticks one. Like webhook, it ends with
#                      all traffic on the revision it deployed, a rollback's pin undone, and fails if that does not serve
#   launcher-schedule  the Scheduler job ci-kit-launcher-tick, which calls the launcher every minute with an OIDC token
#   webhook            the public Cloud Run service ci-kit-webhook (the App's webhook receiver), the Pub/Sub topic
#                      ci-kit-tick-requests it publishes to, and the push subscription that asks the launcher for a
#                      tick. Needs the launcher deployed and the webhook secret created by the owner (docs/pool.md, GCE)
#   alert              log-based metrics and alert policies, mailed to CI_KIT_ALERT_EMAIL (default: the project's
#                      owner): failed ci-kit-launcher-tick executions, VMs whose runner never came online, NAT drops
#   app-hook           points the GitHub App's webhook at ci-kit-webhook with the secret (gce/tools/app-hook.mjs); run
#                      it after webhook's first deploy and after each rotation of the secret
# The App's secrets (ci-kit-app-id, ci-kit-app-key, readable by ci-kit-launcher only) and the webhook secret
# (ci-kit-webhook-secret, readable by ci-kit-webhook only) are created by hand: docs/pool.md, GCE. Deploy from a clean
# checkout of a commit on GitHub: the services record it as CI_KIT_COMMIT.
set -euo pipefail
PROJECT=ssfskim-ci-kit
REGION=us-central1
SA_NAME=ci-kit-launcher
SA="$SA_NAME@$PROJECT.iam.gserviceaccount.com"
KIT=$(cd "$(dirname "$0")/.." && pwd)
WEBHOOK_SA_NAME=ci-kit-webhook
WEBHOOK_SA="$WEBHOOK_SA_NAME@$PROJECT.iam.gserviceaccount.com"

g() { gcloud --project="$PROJECT" --quiet "$@"; }
die() { echo "deploy: $*" >&2; exit 1; }

base() {
  g services enable compute.googleapis.com secretmanager.googleapis.com run.googleapis.com \
    cloudscheduler.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
    logging.googleapis.com monitoring.googleapis.com pubsub.googleapis.com
  g iam service-accounts describe "$SA" > /dev/null 2>&1 ||
    g iam service-accounts create "$SA_NAME" --display-name='ci-kit launcher and bake'
  # The public receiver's own identity, apart from the launcher's: it may read the webhook secret (granted by the
  # owner with the secret) and publish to one topic (webhook), and nothing else. Created here so that the owner can
  # grant it the secret before the receiver's first deploy.
  g iam service-accounts describe "$WEBHOOK_SA" > /dev/null 2>&1 ||
    g iam service-accounts create "$WEBHOOK_SA_NAME" --display-name='ci-kit webhook receiver'
  # Create, label and delete the backend's instances, disks and images. VMs get no service account, so the account
  # needs no actAs on any other.
  g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" \
    --role=roles/compute.instanceAdmin.v1 --condition=None > /dev/null
  # Read the Cloud NAT's day (bytes processed, addresses held) for the ledger's daily line (spec M6).
  g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" \
    --role=roles/monitoring.viewer --condition=None > /dev/null
  # Cloud Run source deploys build as the project's default compute account (new projects since 2024), which needs
  # the builder role to read the uploaded source and push the image. No kit VM runs as that account: VMs have none.
  local number
  number=$(g projects describe "$PROJECT" --format='value(projectNumber)')
  g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$number-compute@developer.gserviceaccount.com" \
    --role=roles/run.builder --condition=None > /dev/null
  # A job VM's console is the only record of its boot, and the VM is deleted minutes after its job (spec M3).
  g compute project-info add-metadata --metadata=serial-port-logging-enable=TRUE > /dev/null
  echo "deploy: base ok ($SA, $WEBHOOK_SA; serial port logging on)"
}

# Every pool VM and bake VM sits here, never on the project's default network, whose stock rules open ssh and RDP to
# the internet and allow ingress inside the network (spec §3a Network: no inbound rules). Networks and firewall rules
# take no labels; the names carry the kit's.
NETWORK=ci-kit
ROUTER=ci-kit-router
NAT=ci-kit-nat
# NAT ports a VM gets, by dynamic allocation: at least the minimum from its first connection, more as it opens them
# (pnpm and apt open many at once), up to the maximum (65536: one whole NAT address). Provisional: M6's burst proof
# (20 cpus-2 jobs in one tick, the NAT's dropped-packet metrics) sizes them. Powers of 2, minimum under maximum.
NAT_MIN_PORTS_PER_VM=1024
NAT_MAX_PORTS_PER_VM=65536
network() {
  local subnet region taken range subnets pga
  g compute networks describe "$NETWORK" > /dev/null 2>&1 ||
    g compute networks create "$NETWORK" --subnet-mode=custom \
      --description='ci-kit: pool and bake VMs (spec 3a); no ingress rules, egress by the implied rule'
  # One subnetwork per placement of gce.json, in the checkout's copy. A region's subnetwork holds its instances (the
  # project's 64-instance quota there), so a /20 each is far more than enough; ranges must not overlap in the network.
  # The list is read before the loop so that a failure stops the deploy (set -e does not see a process substitution);
  # gcloud reads no stdin in the loop, whose own input is the list.
  subnets=$(node "$KIT/gce/subnets.mjs" list) || die "cannot read the placements' subnetworks from pool/config/gce.json"
  [ -n "$subnets" ] || die "pool/config/gce.json names no subnetwork"
  # Pool and bake VMs have no external address (spec 2026-10-21 M6): they reach Google APIs by Private Google Access on
  # their subnetwork, and everything else (GitHub, apt, npm) through their region's Cloud NAT, below.
  while read -r subnet region; do
    if pga=$(g compute networks subnets describe "$subnet" --region="$region" --format='value(privateIpGoogleAccess)' 2> /dev/null < /dev/null); then
      [ "$pga" = True ] || g compute networks subnets update "$subnet" --region="$region" --enable-private-ip-google-access < /dev/null
      continue
    fi
    taken=$(g compute networks subnets list --network="$NETWORK" --format='value(ipCidrRange)' < /dev/null)
    # shellcheck disable=SC2086 # one argument per range
    range=$(node "$KIT/gce/subnets.mjs" free $taken) || die "no free range in the network $NETWORK for $subnet"
    g compute networks subnets create "$subnet" --network="$NETWORK" --region="$region" --range="$range" \
      --enable-private-ip-google-access --description='ci-kit: pool and bake VMs' < /dev/null
  done <<< "$subnets"
  # A Cloud Router and its Cloud NAT in each placement region, for every range of the region's subnetworks (the network
  # holds the pool's only). Google allocates the NAT's addresses as ports run short, so no address quota bounds the
  # pool. Ports by dynamic allocation (NAT_MIN_PORTS_PER_VM above), which needs endpoint-independent mapping off. Only
  # dropped connections are logged (a VM short of ports; the alert part mails them). A NAT that exists is updated to
  # these settings, never recreated.
  local nat=(--auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges
    --enable-dynamic-port-allocation --no-enable-endpoint-independent-mapping
    --min-ports-per-vm="$NAT_MIN_PORTS_PER_VM" --max-ports-per-vm="$NAT_MAX_PORTS_PER_VM"
    --enable-logging --log-filter=ERRORS_ONLY)
  local regions
  read -r -a regions <<< "$(cut -d' ' -f2 <<< "$subnets" | sort -u | tr '\n' ' ')"
  for region in "${regions[@]}"; do
    g compute routers describe "$ROUTER" --region="$region" > /dev/null 2>&1 ||
      g compute routers create "$ROUTER" --network="$NETWORK" --region="$region" \
        --description='ci-kit: Cloud NAT for pool and bake VMs, which have no external address'
    if g compute routers nats describe "$NAT" --router="$ROUTER" --region="$region" > /dev/null 2>&1; then
      g compute routers nats update "$NAT" --router="$ROUTER" --region="$region" "${nat[@]}"
    else
      g compute routers nats create "$NAT" --router="$ROUTER" --region="$region" "${nat[@]}"
    fi
  done
  local open
  open=$(g compute firewall-rules list --format='value(name,network.basename(),direction,disabled,allowed[].map().firewall_rule().list())' |
    awk -F'\t' -v net="$NETWORK" '$2 == net && $3 == "INGRESS" && $4 != "True" && $5 != "" { print $1 }')
  [ -z "$open" ] || die "network $NETWORK has rules allowing ingress: $open"
  echo "deploy: network ok ($NETWORK; no ingress allowed; egress through $NAT in each placement region)"
  g compute networks subnets list --network="$NETWORK" --format='value(name,ipCidrRange)' | sed 's/^/deploy:   subnetwork /'

}

bake() {
  # The job runs the bake orchestrator only; the builder clones the kit at the commit it bakes (main's head).
  # Its timeout stays above the bake's own bounds (builder 30 min, a smoke 15 in each placement in turn, eight since
  # M6, real job 10, the image and the cleanup), so the bake's cleanup always runs; a typical bake takes about 15 min
  # plus a few per placement. STALE_MS (gce/bake/plan.mjs, 4 h) stays above it, so no other bake sweeps a live one's
  # check runner or image.
  g run jobs deploy ci-kit-bake --source="$KIT" --region="$REGION" --service-account="$SA" \
    --command=launcher --args=node,gce/bake/bake.mjs --labels=ci-kit=bake \
    --tasks=1 --max-retries=0 --task-timeout=180m --cpu=1 --memory=512Mi
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

# A deploy leaves a service's traffic where it was: after a rollback pinned it to an older revision
# (update-traffic --to-revisions=<old>=100), `gcloud run deploy` creates the new revision at 0% and says so only in
# passing. So every traffic goes to the latest ready revision, which is then checked to serve all of it. Prints it.
# It runs in a command substitution, where errexit is off: each failure returns explicitly.
serve_latest() {
  local service=$1 status
  g run services update-traffic "$service" --region="$REGION" --to-latest > /dev/null || return
  # shellcheck disable=SC2016 # a JavaScript template literal, not the shell's
  status=$(g run services describe "$service" --region="$REGION" --format=json | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const { latestReadyRevisionName: latest, traffic = [] } = JSON.parse(s).status ?? {};
      const live = traffic.filter((t) => t.percent > 0);
      if (live.length === 1 && live[0].revisionName === latest && live[0].percent === 100) console.log(`serving ${latest}`);
      else console.log(`its latest revision ${latest} does not serve all traffic: ${live.map((t) => `${t.revisionName} ${t.percent}%`).join(", ") || "none"}`);
    });') || return
  [[ $status == serving\ * ]] || die "$service: $status"
  echo "${status#serving }"
}

launcher() {
  # Buildpack images keep node in their layers, off the bare PATH: the CNB `launcher` sets up the layers' environment
  # and then runs the command (the same holds for the bake job above).
  # Request-based billing: a tick a minute of a few seconds' work stays in the free tier.
  # Requests are many at a time (spec 2026-10-21 M4): the webhook's pushes arrive while a tick runs, and the process
  # coalesces them (gce/launcher/ticker.mjs), so concurrency only has to admit them; ticks stay one at a time. Every
  # request, scheduled or pushed, is answered when the tick that serves it has ended, so a request is open, and the
  # CPU allocated, for every tick's whole run.
  g run deploy "$LAUNCHER" --source="$KIT" --region="$REGION" --service-account="$SA" \
    --command=launcher --args=node,gce/launcher/server.mjs --set-env-vars="CI_KIT_COMMIT=$COMMIT" --labels=ci-kit=launcher \
    --no-allow-unauthenticated --ingress=internal --min-instances=0 --max-instances=1 --concurrency=80 \
    --cpu-throttling --timeout=300 --cpu=1 --memory=512Mi
  # Cloud Scheduler calls it as the service account, and so does Pub/Sub's push (webhook); nothing else may.
  g run services add-iam-policy-binding "$LAUNCHER" --region="$REGION" \
    --member="serviceAccount:$SA" --role=roles/run.invoker > /dev/null
  local revision
  revision=$(serve_latest "$LAUNCHER")
  echo "deploy: launcher ok ($revision serving; kit ${COMMIT:0:8})"
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

# The webhook path (spec 2026-10-21 M4): GitHub → ci-kit-webhook (public; the signature is its gate) → Pub/Sub topic
# ci-kit-tick-requests → push subscription → the launcher's /request, which internal ingress admits: Cloud Run counts
# a Pub/Sub push subscription of the same project, to the service's run.app URL, as internal. The push carries an OIDC
# token of ci-kit-launcher@, the launcher's one invoker; Pub/Sub's service agent mints it through its project role
# (roles/pubsub.serviceAgent holds iam.serviceAccounts.getOpenIdToken). The receiver can publish and nothing else: it
# cannot invoke the launcher itself.
WEBHOOK=ci-kit-webhook
WEBHOOK_SECRET=ci-kit-webhook-secret
TOPIC=ci-kit-tick-requests
SUBSCRIPTION=ci-kit-tick-requests-launcher
webhook() {
  local url hook reader
  # The secret is the owner's to create and grant (Secret Manager writes are human-only); Cloud Run's deploy would
  # refuse a secret its service account cannot read, with a less useful message.
  g secrets describe "$WEBHOOK_SECRET" > /dev/null 2>&1 ||
    die "no secret $WEBHOOK_SECRET: the owner creates it and grants it to $WEBHOOK_SA (docs/pool.md, GCE, The webhook)"
  reader=$(g secrets get-iam-policy "$WEBHOOK_SECRET" --flatten='bindings[].members' \
    --filter="bindings.role=roles/secretmanager.secretAccessor AND bindings.members=serviceAccount:$WEBHOOK_SA" \
    --format='value(bindings.members)')
  [ -n "$reader" ] || die "$WEBHOOK_SA cannot read $WEBHOOK_SECRET: the owner grants it (docs/pool.md, GCE, The webhook)"
  url=$(g run services describe "$LAUNCHER" --region="$REGION" --format='value(status.url)')
  [ -n "$url" ] || die "the launcher is not deployed (gce/deploy.sh launcher)"

  g pubsub topics describe "$TOPIC" > /dev/null 2>&1 || g pubsub topics create "$TOPIC" --labels=ci-kit=webhook
  g pubsub topics add-iam-policy-binding "$TOPIC" --member="serviceAccount:$WEBHOOK_SA" \
    --role=roles/pubsub.publisher > /dev/null

  # Public: GitHub delivers from its own addresses. The org's domain-restricted sharing refuses an allUsers invoker,
  # so the invoker IAM check is off instead (Cloud Run's way for that case). The secret is a volume, which Cloud Run
  # reads from Secret Manager on each read: a rotated secret is live without a deploy. A few instances bound what a
  # flood of forged deliveries can cost; GitHub waits 10 s for an answer.
  g run deploy "$WEBHOOK" --source="$KIT" --region="$REGION" --service-account="$WEBHOOK_SA" \
    --command=launcher --args=node,gce/webhook/server.mjs --labels=ci-kit=webhook \
    --set-env-vars="CI_KIT_COMMIT=$COMMIT,CI_KIT_TOPIC=projects/$PROJECT/topics/$TOPIC,CI_KIT_WEBHOOK_SECRET_FILE=/secrets/webhook/secret" \
    --set-secrets="/secrets/webhook/secret=$WEBHOOK_SECRET:latest" \
    --ingress=all --no-invoker-iam-check --min-instances=0 --max-instances=3 --concurrency=80 \
    --timeout=30 --cpu=1 --memory=256Mi
  local revision
  revision=$(serve_latest "$WEBHOOK")

  # The launcher answers a push when the tick that serves it has ended, and a push that arrives while a tick runs is
  # served by the next one, so the ack deadline must outlive the worst case: the running tick (~100 s: launches stop
  # starting at its 45 s budget, an insert already started waits up to 40 s more, then the tick's tail; the longest of
  # 4,283 ticks in the 3 days to 2026-10-21 took 77 s), the 10 s spacing, the next tick (~100 s again) and a cold
  # start (~10 s): 220 s. 300 s, Cloud Run's request timeout here, covers it with 80 s to spare; a push held past it
  # is cut by Cloud Run and redelivered, which costs one more tick, never a job. A request older than 10 min (Pub/Sub's
  # shortest retention) is dropped: the minute tick has served its job by then.
  local push=(--push-endpoint="$url/request" --push-auth-service-account="$SA" --push-auth-token-audience="$url"
    --ack-deadline=300 --message-retention-duration=10m --expiration-period=never --min-retry-delay=10s --max-retry-delay=60s)
  if g pubsub subscriptions describe "$SUBSCRIPTION" > /dev/null 2>&1; then
    g pubsub subscriptions update "$SUBSCRIPTION" "${push[@]}" > /dev/null
  else
    g pubsub subscriptions create "$SUBSCRIPTION" --topic="$TOPIC" "${push[@]}" --labels=ci-kit=webhook > /dev/null
  fi
  hook=$(g run services describe "$WEBHOOK" --region="$REGION" --format='value(status.url)')
  echo "deploy: webhook ok ($revision serving; $hook → $TOPIC → $url/request; kit ${COMMIT:0:8})"
}

app_hook() {
  local hook
  hook=$(g run services describe "$WEBHOOK" --region="$REGION" --format='value(status.url)')
  [ -n "$hook" ] || die "the receiver is not deployed (gce/deploy.sh webhook)"
  node "$KIT/gce/tools/app-hook.mjs" "$hook"
}

# Failures that mail the owner, each a log-based metric and an alert policy on it. Metrics, channels and policies take
# no resource labels everywhere; their names carry the kit's, and the policies and channel carry ci-kit user labels.
# - A launcher that is down leaves stopped VMs to cost their disks and the ledger's daily line missing (spec §3a
#   Lifetime bounds): three failed ticks within 10 minutes.
# - A VM whose runner never came online (spec 2026-10-21 M6): it booted but cannot reach GitHub, and its job waits on
#   another VM; the launcher logs it at ERROR each tick (launcher.mjs reportNeverOnline). Any in 10 minutes.
# - A connection a pool NAT dropped (M6): a VM out of ports, or the NAT out of addresses. The NAT logs drops only
#   (network). Any in 10 minutes.
alert() {
  local email=${CI_KIT_ALERT_EMAIL:-kimmi@l1ngual.com} channel
  # Only resource names are kept from gcloud's output: its first alpha or beta call may install those components and
  # print the installer's lines to stdout.
  channel=$(g beta monitoring channels list --filter="displayName=\"ci-kit owner\"" --format='value(name)' | grep '^projects/' | head -1 || true)
  [ -n "$channel" ] || channel=$(g beta monitoring channels create --display-name='ci-kit owner' --type=email \
    --channel-labels="email_address=$email" --user-labels=ci-kit=alert --format='value(name)' | grep '^projects/' | head -1)
  [ -n "$channel" ] || die "no notification channel"
  alert_on_log ci-kit-launcher-tick-failed cloud_scheduler_job 2 'ci-kit launcher ticks failing' \
    'ci-kit: failed executions of the Scheduler job ci-kit-launcher-tick (spec 3a)' \
    'resource.type="cloud_scheduler_job" AND resource.labels.job_id="ci-kit-launcher-tick" AND severity>=ERROR' \
    "Cloud Scheduler's ci-kit-launcher-tick failed 3 times in 10 minutes: the GCE launcher (Cloud Run ci-kit-launcher in ssfskim-ci-kit) is not reconciling. Stopped pool VMs cost their disks until it is back. Read its logs: gcloud run services logs read ci-kit-launcher --region=us-central1 --project=ssfskim-ci-kit. docs/pool.md, GCE."
  alert_on_log ci-kit-runner-never-online cloud_run_revision 0 'ci-kit pool VM runners never online' \
    'ci-kit: pool VMs RUNNING for over 3 min whose runner never came online (spec 2026-10-21 M6)' \
    'resource.type="cloud_run_revision" AND resource.labels.service_name="ci-kit-launcher" AND severity>=ERROR AND jsonPayload.event="runner-never-online"' \
    "A pool VM has been RUNNING for over 3 minutes and its runner never came online: it booted but cannot reach GitHub, and its job waits for another VM. The usual cause is egress: GitHub unreachable from the VM's external address (or, under gce.json egress \"nat\", its region's Cloud NAT ci-kit-nat missing, misconfigured or out of ports). The launcher's ERROR entries name the VM, zone and region: gcloud logging read 'jsonPayload.event=\"runner-never-online\"' --project=ssfskim-ci-kit --freshness=1h. Then gce/deploy.sh network. docs/pool.md, GCE, The network."
  alert_on_log ci-kit-nat-dropped nat_gateway 0 'ci-kit NAT dropping connections' \
    "ci-kit: connections ci-kit-nat dropped (spec 2026-10-21 M6)" \
    'resource.type="nat_gateway" AND resource.labels.gateway_name="ci-kit-nat" AND jsonPayload.allocation_status="DROPPED"' \
    "A pool Cloud NAT (ci-kit-nat) dropped connections in the last 10 minutes: a VM ran out of NAT ports, or the NAT could not allocate an address. Jobs may fail to reach GitHub, apt or npm. Read the drops: gcloud logging read 'resource.type=\"nat_gateway\" AND jsonPayload.allocation_status=\"DROPPED\"' --project=ssfskim-ci-kit --freshness=1h, and the NAT's dropped_sent_packets_count by reason in Cloud Monitoring. The port settings are in gce/deploy.sh network. docs/pool.md, GCE, The network."
  echo "deploy: alert ok (ticks failing, runners never online, NAT drops; mailed to $email)"
}

# alert_on_log METRIC RESOURCE THRESHOLD TITLE DESCRIPTION FILTER DOC: the log-based metric METRIC of the entries FILTER
# matches, and the policy TITLE mailing $channel when more than THRESHOLD of them fall in 10 minutes. Each is created
# once, found by its name; one that exists is left as it is.
alert_on_log() {
  local metric=$1 resource=$2 threshold=$3 title=$4 description=$5 filter=$6 doc=$7 policy file
  g logging metrics describe "$metric" > /dev/null 2>&1 ||
    g logging metrics create "$metric" --description="$description" --log-filter="$filter"
  policy=$(g alpha monitoring policies list --filter="displayName=\"$title\"" --format='value(name)' | grep '^projects/' | head -1 || true)
  [ -z "$policy" ] || return 0
  file=$(mktemp)
  # shellcheck disable=SC2016 # a JavaScript template literal, not the shell's
  node -e '
    const [title, doc, metric, resource, threshold, channel] = process.argv.slice(1);
    console.log(JSON.stringify({
      displayName: title,
      documentation: { content: doc, mimeType: "text/markdown" },
      userLabels: { "ci-kit": "alert" },
      combiner: "OR",
      conditions: [{ displayName: metric, conditionThreshold: {
        filter: `metric.type="logging.googleapis.com/user/${metric}" AND resource.type="${resource}"`,
        aggregations: [{ alignmentPeriod: "600s", perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM" }],
        comparison: "COMPARISON_GT", thresholdValue: Number(threshold), duration: "0s", trigger: { count: 1 } } }],
      alertStrategy: { autoClose: "3600s" },
      notificationChannels: [channel],
    }));' "$title" "$doc" "$metric" "$resource" "$threshold" "$channel" > "$file"
  g alpha monitoring policies create --policy-from-file="$file" > /dev/null
  rm -f "$file"
}

[ $# -gt 0 ] || set -- base network bake bake-schedule launcher launcher-schedule webhook alert
for part in "$@"; do
  case $part in
    base) base ;;
    network) network ;;
    bake) bake ;;
    bake-schedule) bake_schedule ;;
    launcher) launcher ;;
    launcher-schedule) launcher_schedule ;;
    webhook) webhook ;;
    alert) alert ;;
    app-hook) app_hook ;;
    *) die "unknown part $part (base, network, bake, bake-schedule, launcher, launcher-schedule, webhook, alert, app-hook)" ;;
  esac
done
