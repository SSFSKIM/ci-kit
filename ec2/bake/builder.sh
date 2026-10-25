#!/bin/bash
# Canonical cloud-init executes this once. Job images disable cloud-init completely: job input is JSON read by the unit.
set -euo pipefail
KIT_SHA=__KIT_SHA__
CACHE=/var/lib/ci-kit/cache
REPORT=$(printf '%s' '__REPORT__' | base64 -d)
WARM_TOKEN=$(printf '%s' '__TOKEN__' | base64 -d)
export DEBIAN_FRONTEND=noninteractive HOME=/root
step=start
finish() {
  local status=$?
  set +e
  if [ "$status" -ne 0 ]; then
    echo "ci-kit bake: failed at $step"
    curl -sf --max-time 20 -X PUT --data "{\"value\":\"failed:$step\"}" "$REPORT" >/dev/null
    rm -rf /run/ci-kit-bake
    sync
    poweroff
  fi
}
trap finish EXIT
warm_token() { printf '%s' "$WARM_TOKEN"; }
step=apt
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service || true
systemctl stop snapd.socket snapd.service snapd.seeded.service || true
apt-get purge -y snapd
rm -rf /snap /var/snap /var/lib/snapd /var/cache/snapd
printf 'Package: snapd\nPin: release *\nPin-Priority: -10\n' > /etc/apt/preferences.d/ci-kit-no-snapd
apt-get update
apt-get install -y --no-install-recommends docker.io git jq curl xz-utils ca-certificates iptables gdisk partclone dosfstools
systemctl enable docker
step=kit
git clone --quiet https://github.com/SSFSKIM/ci-kit.git /opt/ci-kit
git -C /opt/ci-kit checkout --quiet "$KIT_SHA"
install -d -m 0755 /etc/ci-kit
export CI_KIT_BAKE_MANIFEST=/etc/ci-kit/bake-manifest.json
printf '%s' '__MANIFEST__' | base64 -d > "$CI_KIT_BAKE_MANIFEST"
. /opt/ci-kit/pool/bake/prepare.sh
unset WARM_TOKEN
step=unit
install -m 0644 /opt/ci-kit/ec2/vm/ci-kit-ec2-job.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable ci-kit-ec2-job.service
echo "$KIT_SHA" > /var/lib/ci-kit/kit-commit
step=boot
touch /etc/cloud/cloud-init.disabled
rm -f /etc/netplan/50-cloud-init.yaml
cat > /etc/netplan/90-ci-kit.yaml <<'YAML'
network:
  version: 2
  ethernets:
    ci-kit-en:
      match: {name: "en*"}
      dhcp4: true
    ci-kit-eth:
      match: {name: "eth*"}
      dhcp4: true
YAML
chmod 600 /etc/netplan/90-ci-kit.yaml
step=clean
apt-get clean
# Snapshot initialization charges every written GiB on every launch. None of this is read by a job VM.
rm -rf /var/lib/apt/lists/* /opt/ci-kit/.git /opt/ci-kit/ec2/spike /opt/ci-kit/test /opt/ci-kit/docs /root/.npm /root/.cache
docker builder prune --all --force > /dev/null
docker image prune --force > /dev/null
# scripts-user is inside cloud-final, whose remaining modules and status wrapper write state after we return.
# Queue, never wait here: the finalizer's ordering would deadlock a synchronous start from this service.
step=finalizer
install -d -m 0700 /run/ci-kit-bake
(umask 077; printf '%s' "$REPORT" > /run/ci-kit-bake/report-url)
cat > /run/systemd/system/ci-kit-bake-finalize.service <<'UNIT'
[Unit]
Description=Sanitize the ci-kit builder after cloud-init completes
After=cloud-final.service
FailureAction=poweroff

[Service]
Type=oneshot
ExecStart=/bin/bash /opt/ci-kit/ec2/bake/finalize.sh
TimeoutStartSec=20min
TimeoutStopSec=30s
# Root is frozen during the sparse copy: no journal writes on its output path.
StandardOutput=console
StandardError=console
UNIT
systemctl daemon-reload
systemctl --no-block start ci-kit-bake-finalize.service
step=done
