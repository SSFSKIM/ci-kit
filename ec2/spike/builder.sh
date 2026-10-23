#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive HOME=/root
exec > >(tee /dev/console) 2>&1
# Successful builders stay up long enough for the controller to read READY, then it stops them for imaging.
# A stopped Nitro instance can return an empty console; the deadline still bounds a lost controller.
trap 's=$?; echo SPIKE_BUILD_EXIT=$s; sync; if [ "$s" -ne 0 ]; then poweroff; fi' EXIT
systemd-run --unit=spike-deadline --on-active=45m /sbin/poweroff
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service || true
systemctl stop snapd.socket snapd.service || true
apt-get purge -y snapd
apt-get update
apt-get install -y --no-install-recommends docker.io git jq curl xz-utils ca-certificates iptables
systemctl enable --now docker
git clone -q https://github.com/SSFSKIM/ci-kit /opt/ci-kit
git -C /opt/ci-kit checkout -q __KIT_SHA__
CACHE=/var/lib/ci-kit/cache
warm_token() { printf '%s' '__WARM_TOKEN__'; }
. /opt/ci-kit/pool/bake/prepare.sh
[[ "$WARM_OK" = 1 ]]
printf '%s' '__GUEST_B64__' | base64 -d > /opt/spike-guest.mjs
cat > /etc/systemd/system/spike.service <<'UNIT'
[Unit]
Description=EC2 M1 measurement
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service
[Service]
Type=exec
ExecStartPre=/usr/bin/systemd-run --unit=spike-deadline --on-active=40m /sbin/poweroff
ExecStart=/usr/local/bin/node /opt/spike-guest.mjs ec2
StandardOutput=journal+console
StandardError=journal+console
[Install]
WantedBy=multi-user.target
UNIT
systemctl enable spike.service
touch /etc/cloud/cloud-init.disabled
rm -f /etc/netplan/50-cloud-init.yaml
cat > /etc/netplan/90-ci-kit.yaml <<'NET'
network:
  version: 2
  ethernets:
    pool:
      match: {name: "en*"}
      dhcp4: true
NET
chmod 600 /etc/netplan/90-ci-kit.yaml
apt-get clean
docker image prune -f
printf 'SPIKE_DISK '; df -B1 --output=size,used /
printf 'SPIKE_NODES '; find "$CACHE/toolcache/node" -maxdepth 1 -mindepth 1 -type d
printf 'SPIKE_IMAGE '; docker image inspect ci-kit-runner:latest --format '{{.Id}}'
# Discard the only places cloud-init stored its token-bearing user-data before imaging.
cloud-init clean --logs --machine-id
rm -rf /var/lib/cloud/instances /var/lib/cloud/instance /var/log/cloud-init* /root/.bash_history
journalctl --rotate || true
journalctl --vacuum-time=1s || true
fstrim -av || true
echo SPIKE_BUILD_READY
