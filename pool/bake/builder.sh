#!/bin/bash
# The bake's builder (spec §3 Bake): runs once on a fresh ubuntu-24.04 server through cloud-init, turns its disk
# into the pool image, marks the result on its own server labels (ci-kit-bake=ok or failed-<step>),
# and powers off. pool/bake/bake.mjs fills the placeholders, waits for `off`, and snapshots only a builder marked ok.
# Secrets arrive in this user-data; nothing here echoes them, and cloud-init's copies and logs are removed
# before the snapshot.
set -euo pipefail
KIT_SHA=__KIT_SHA__
RUN_ID=__RUN_ID__
CACHE=/var/lib/ci-kit/cache
export DEBIAN_FRONTEND=noninteractive
step=start
label() {
  # Merge one label into this server's labels through the Hetzner API (the token is in /etc/ci-kit by then). Only
  # while the server is still this bake's builder: an operator who relabelled it to keep it for debugging owns it.
  local token id labels
  token=$(cat /etc/ci-kit/hcloud_token 2>/dev/null || true)
  id=$(curl -sf --max-time 10 http://169.254.169.254/hetzner/v1/metadata/instance-id || true)
  [ -n "$token" ] && [ -n "$id" ] || return 0
  command -v jq > /dev/null || return 0
  labels=$(curl -sf --max-time 20 -H "Authorization: Bearer $token" "https://api.hetzner.cloud/v1/servers/$id" | jq -c --arg k "$1" --arg v "$2" --arg run "$RUN_ID" \
    'select(.server.labels["ci-kit"] == "builder" and .server.labels["ci-kit-run"] == $run) | .server.labels + {($k): $v}') || return 0
  [ -n "$labels" ] || return 0
  curl -sf --max-time 20 -X PUT -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d "{\"labels\": $labels}" "https://api.hetzner.cloud/v1/servers/$id" > /dev/null || true
}
finish() {
  local status=$?
  # Nothing in here may stop the power-off: errexit would end the trap at the first failing command (a builder
  # that fails before jq is installed cannot label itself), and the bake would wait 30 min for nothing.
  set +e
  if [ "$status" -ne 0 ]; then
    echo "ci-kit bake: failed at step $step (exit $status)"
    label ci-kit-bake "failed-$step"
  fi
  sync
  poweroff
}
trap finish EXIT

step=secrets
install -d -m 0700 /etc/ci-kit
umask 077
cat > /etc/ci-kit/app_id <<'CI_KIT_APP_ID'
__APP_ID__
CI_KIT_APP_ID
cat > /etc/ci-kit/app.pem <<'CI_KIT_APP_KEY'
__APP_KEY__
CI_KIT_APP_KEY
cat > /etc/ci-kit/hcloud_token <<'CI_KIT_HCLOUD_TOKEN'
__HCLOUD_TOKEN__
CI_KIT_HCLOUD_TOKEN
umask 022

# An ephemeral box is patched by re-baking, not by apt timers racing its boot (M4).
step=apt
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service || true

# A cpx12 builder has 2 GB of memory: the build gets 2 GB of swap on top, and the peak of memory plus swap in use
# is sampled so the bake's log shows how much the build needed (label ci-kit-mem-peak, MB).
step=swap
if [ ! -e /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
fi
( peak=0; while :; do
    used=$(free -m | awk '/^Mem:/ {m=$3} /^Swap:/ {s=$3} END {print m+s}')
    [ "$used" -gt "$peak" ] && peak=$used && echo "$peak" > /run/ci-kit-mem-peak
    sleep 2
  done ) &
sampler=$!
apt-get update
apt-get install -y --no-install-recommends docker.io git jq curl xz-utils ca-certificates iptables
systemctl enable docker

step=kit
git clone --quiet https://github.com/SSFSKIM/ci-kit.git /opt/ci-kit
git -C /opt/ci-kit checkout --quiet "$KIT_SHA"
install -m 0600 /opt/ci-kit/pool/config/pool.json /etc/ci-kit/pool.json

# Node, dependencies, the base runner image and cache directories; this dormant pool has no served declarations.
. /opt/ci-kit/pool/bake/prepare.sh

step=smoke
# The image runs, a cpuset bounds nproc, and the baked Node runs inside a job container.
n=$(docker run --rm --cpuset-cpus 0 --entrypoint nproc ci-kit-runner:latest)
[ "$n" = 1 ]
node22=$(ls -d "$CACHE"/toolcache/node/22.*/x64 | head -1)
docker run --rm -v "$CACHE:$CACHE" --entrypoint "$node22/bin/node" ci-kit-runner:latest -e 'process.exit(0)'

step=units
install -m 0644 /opt/ci-kit/pool/agent/systemd/ci-kit-agent.service /etc/systemd/system/
install -m 0644 /opt/ci-kit/pool/agent/systemd/ci-kit-watchdog.service /etc/systemd/system/
install -m 0644 /opt/ci-kit/pool/agent/systemd/ci-kit-watchdog.timer /etc/systemd/system/
systemctl daemon-reload
# Enabled, not started: they run on the pool boxes made from this disk, never on the builder.
systemctl enable ci-kit-agent.service ci-kit-watchdog.timer
mkdir -p /var/lib/ci-kit
echo "$KIT_SHA" > /var/lib/ci-kit/kit-commit

step=clean
kill "$sampler" 2>/dev/null || true
label ci-kit-mem-peak "$(cat /run/ci-kit-mem-peak 2>/dev/null || echo unknown)"
swapoff /swapfile && rm -f /swapfile
apt-get clean
docker image prune --force > /dev/null
label ci-kit-bake ok
# cloud-init keeps this user-data (and its output) on disk; the snapshot must not.
cloud-init clean --logs
journalctl --rotate > /dev/null 2>&1 || true
journalctl --vacuum-time=1s > /dev/null 2>&1 || true
step=done
