#!/bin/bash
# Canonical cloud-init executes this once. Job images disable cloud-init completely: job input is JSON read by the unit.
set -euo pipefail
KIT_SHA=__KIT_SHA__
CACHE=/var/lib/ci-kit/cache
REPORT=$(printf '%s' '__REPORT__' | base64 -d)
WARM_TOKEN=$(printf '%s' '__TOKEN__' | base64 -d)
export DEBIAN_FRONTEND=noninteractive HOME=/root
step=start
# The failure report carries a bounded tail of this script's output (cloud-init's output log, still on disk here) for
# the S3 report only; the controller prints a pointer to it. python3 is the one interpreter Canonical's image has before
# step apt. The GitHub token, also its basic-auth form, and the report URL are redacted, even after WARM_TOKEN is unset,
# and so are both as user-data carries them (base64), which a traced line of this script would print.
# shellcheck disable=SC2016
FAILURE_REPORT='
import base64, json, sys
step, status, path = sys.argv[1:]
token, url = sys.stdin.buffer.read().split(b"\0", 1)
values, secrets = [token], {url, base64.b64encode(token), base64.b64encode(url)}
try:
    owners = json.loads(token)
    if isinstance(owners, dict): values += [v.encode() for v in owners.values() if isinstance(v, str)]
except ValueError: pass
for v in values: secrets |= {v, base64.b64encode(b"x-access-token:" + v)}
try:
    with open(path, "rb") as f: data = f.read()
except OSError: data = b""
for s in sorted(secrets - {b""}, key=len, reverse=True): data = data.replace(s, b"[redacted]")
# Whole lines only, within 8 KiB and 40 lines, as boundCompactLogTail keeps them.
if len(data) > 8192:
    newline = data.find(b"\n", len(data) - 8193)
    data = data[newline + 1:] if newline >= 0 else b""
lines = data.split(b"\n")
tail = b"\n".join(lines[-41:] if data.endswith(b"\n") else lines[-40:]).decode("utf-8", "replace")
diagnostic = {"reason": "builder-failed", "exit_status": int(status), **({"log_tail": tail} if tail else {})}
print(json.dumps({"value": "failed:" + step, "diagnostic": diagnostic}))
'
finish() {
  local status=$? report
  set +e
  if [ "$status" -ne 0 ]; then
    echo "ci-kit bake: failed at $step"
    report=$(printf '%s\0%s' "$(printf '%s' '__TOKEN__' | base64 -d)" "$REPORT" |
      timeout 20 python3 -I -c "$FAILURE_REPORT" "$step" "$status" /var/log/cloud-init-output.log) || report=
    if [ -n "$report" ]; then
      printf '%s' "$report" | curl -sf --max-time 20 -X PUT --data-binary @- "$REPORT" >/dev/null
    else
      curl -sf --max-time 20 -X PUT --data "{\"value\":\"failed:$step\"}" "$REPORT" >/dev/null
    fi
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
# From the region's EC2 mirror, and from the main archive when that fails: us-east-2's answered 503 for a universe
# package after eleven minutes (bake 20261119-232507-taub, partclone), and three earlier bakes that day ended at this
# step. Only the network part is retried and time-limited, so two attempts (20 min at most) and a 16-min build stay
# inside the controller's 45; dpkg runs once after it. --error-on=any: a failed pocket is otherwise only a warning.
packages=(docker.io git jq curl xz-utils ca-certificates iptables gdisk partclone dosfstools)
sources=/etc/apt/sources.list.d/ubuntu.sources
apt_fetch() {
  timeout -k 30 180 apt-get update --error-on=any &&
    timeout -k 30 360 apt-get install -y --no-install-recommends --download-only "${packages[@]}"
}
if ! apt_fetch; then
  if [ -f "$sources" ]; then
    cp -p "$sources" /run/ci-kit-region.sources
    sed -E 's#https?://[a-z0-9.-]+\.ec2\.archive\.ubuntu\.com/ubuntu/?#http://archive.ubuntu.com/ubuntu/#' /run/ci-kit-region.sources > "$sources"
  fi
  echo "ci-kit bake: the region's mirror failed; installing from archive.ubuntu.com"
  apt_fetch
fi
apt-get install -y --no-install-recommends --no-download "${packages[@]}"
# The image keeps the region's mirror; the install above needed the lists of the sources they were fetched from.
if [ -f /run/ci-kit-region.sources ]; then mv /run/ci-kit-region.sources "$sources"; fi
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
