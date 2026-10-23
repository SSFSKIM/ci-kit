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
  fi
  sync
  poweroff
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
apt-get install -y --no-install-recommends docker.io git jq curl xz-utils ca-certificates iptables
systemctl enable docker
step=kit
git clone --quiet https://github.com/SSFSKIM/ci-kit.git /opt/ci-kit
git -C /opt/ci-kit checkout --quiet "$KIT_SHA"
install -d -m 0755 /etc/ci-kit
export CI_KIT_BAKE_MANIFEST=/etc/ci-kit/bake-manifest.json
printf '%s' '__MANIFEST__' | base64 -d > "$CI_KIT_BAKE_MANIFEST"
. /opt/ci-kit/pool/bake/prepare.sh
unset WARM_TOKEN
step=warm-check
[ "$WARM_OK" = 1 ]
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
rm -rf /root/.aws /root/.config/gcloud /root/.git-credentials /root/.netrc /tmp/ci-kit-warm-* /tmp/ci-kit-electron-*
docker builder prune --all --force > /dev/null
docker image prune --force > /dev/null
cloud-init clean --logs --machine-id
rm -rf /var/lib/cloud/instances /var/lib/cloud/instance /var/lib/cloud/data /var/lib/cloud/seed
rm -f /var/log/cloud-init.log /var/log/cloud-init-output.log /etc/ssh/ssh_host_*
: > /etc/hostname
journalctl --rotate > /dev/null 2>&1 || true
journalctl --vacuum-time=1s > /dev/null 2>&1 || true
sync
fstrim -av || true
step=report
jq -c '{value:"ok",manifest:.}' "$CI_KIT_BAKE_MANIFEST" | curl -sf --max-time 30 -X PUT --data-binary @- "$REPORT" > /dev/null
step=done
