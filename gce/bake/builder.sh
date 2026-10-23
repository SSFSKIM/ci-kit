#!/bin/bash
# The GCE bake's builder (spec §3a Image): runs once, as the startup script of a fresh Ubuntu 24.04 VM. It turns the
# VM's disk into the pool runner image with the job unit installed, reports ci-kit/bake=ok or failed:<step> as a guest
# attribute, and powers off in every case. gce/bake/bake.mjs fills the kit commit, images the disk only on `ok`, and
# smoke-boots the image before anything uses it.
# It writes no credential. The one-hour GitHub token in this VM's metadata (MAWS contents, read) is fetched only into
# the cache warming's environment, and nothing here echoes it.
set -euo pipefail
KIT_SHA=__KIT_SHA__
CACHE=/var/lib/ci-kit/cache
MD=http://169.254.169.254/computeMetadata/v1/instance
export DEBIAN_FRONTEND=noninteractive HOME=/root
step=start

report() {
  curl -sf --max-time 10 -X PUT -H 'Metadata-Flavor: Google' --data "$1" "$MD/guest-attributes/ci-kit/bake" > /dev/null || true
}
finish() {
  local status=$?
  # Nothing in here may stop the power-off: the bake waits for it, and a builder left running costs until GCE deletes
  # it at its run limit.
  set +e
  if [ "$status" -ne 0 ]; then
    echo "ci-kit bake: failed at step $step (exit $status)"
    report "failed:$step"
  fi
  sync
  poweroff
}
trap finish EXIT
warm_token() { curl -sf --max-time 10 -H 'Metadata-Flavor: Google' "$MD/attributes/ci-kit-gh-token"; }

# An ephemeral VM is patched by re-baking, not by apt timers racing its boot.
step=apt
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service || true
# No job uses a snap, and snapd seeds itself on the first boot of every disk made from the image, beside the job's
# start (spec M3, The boot). The metapackages that depend on it go with it; their dependencies stay installed. The pin
# keeps any later install from bringing it back.
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
curl -sf --max-time 10 -H 'Metadata-Flavor: Google' "$MD/attributes/ci-kit-bake-manifest" > "$CI_KIT_BAKE_MANIFEST"
. /opt/ci-kit/pool/bake/prepare.sh

# Unlike the Hetzner box, a GCE image is used only once its caches are whole: a cold image costs every job it serves.
step=warm-check
[ "$WARM_OK" = 1 ]

step=unit
install -m 0644 /opt/ci-kit/gce/vm/ci-kit-gce-job.service /opt/ci-kit/gce/vm/ci-kit-gce-instance.service /etc/systemd/system/
systemctl daemon-reload
# Enabled, not started: they run on the VMs made from this disk, never on the builder.
systemctl enable ci-kit-gce-job.service ci-kit-gce-instance.service
echo "$KIT_SHA" > /var/lib/ci-kit/kit-commit

# A job VM boots without cloud-init (spec M3, The boot): its network stages ran ahead of sysinit.target, which every
# service waits for, Docker and the job included. What a job VM needed from it is replaced: the network by a netplan
# that runs DHCP on any ethernet interface (the one cloud-init wrote here matches this builder's MAC address only;
# virtio-net and gVNIC both come up as en*), the root's growth to the VM's disk and the hostname by
# ci-kit-gce-instance.service. The guest agent, not cloud-init, serves the metadata and guest attributes.
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
docker image prune --force > /dev/null
# A VM made from this disk gets its own machine id, and none of this boot's logs.
cloud-init clean --logs --machine-id
rm -rf /var/lib/cloud/instances /var/lib/cloud/instance /var/lib/cloud/data /var/lib/cloud/seed
rm -rf /root/.aws /root/.config/gcloud /root/.git-credentials /root/.netrc /tmp/ci-kit-warm-* /tmp/ci-kit-electron-*
# The builder's name would otherwise be every job VM's; ci-kit-gce-instance.service sets the instance's.
: > /etc/hostname
journalctl --rotate > /dev/null 2>&1 || true
journalctl --vacuum-time=1s > /dev/null 2>&1 || true
sync
curl -sf --max-time 10 -X PUT -H 'Metadata-Flavor: Google' --data-binary @"$CI_KIT_BAKE_MANIFEST" "$MD/guest-attributes/ci-kit/manifest" > /dev/null
report ok
step=done
