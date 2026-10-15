#!/bin/bash
# M4 spike builder. Runs once on a fresh ubuntu-24.04 server through cloud-init,
# leaves a disk ready to snapshot, and powers off. EXTRA_GB (substituted by
# make-snapshots.mjs) adds that much incompressible data, standing in for caches.
set -euxo pipefail
EXTRA_GB=__EXTRA_GB__
RUNNER_IMAGE=ghcr.io/actions/actions-runner:2.338.0@sha256:4ffadc0002b2581327e06101fc8c06cd189232baf79fe561fac9caeb76f5e807
export DEBIAN_FRONTEND=noninteractive

# An ephemeral box gets patched by re-baking, not by apt timers racing its boot.
systemctl disable --now apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service || true

apt-get update
apt-get install -y --no-install-recommends docker.io
systemctl enable docker
docker pull "$RUNNER_IMAGE"
docker tag "$RUNNER_IMAGE" ci-kit-runner:spike

cat > /usr/local/sbin/ci-kit-spike-boot <<'EOF'
#!/bin/bash
# Stand-in for the pool agent's boot: read the JIT config from user-data and
# start one runner container pinned to N cores.
set -u
svc_start=$(date +%s.%N)
btime=$(awk '/^btime/{print $2}' /proc/stat)
ud=""
for _ in $(seq 1 120); do
  ud=$(curl -sf --max-time 2 http://169.254.169.254/hetzner/v1/userdata) && break
  sleep 0.5
done
md_ok=$(date +%s.%N)
jit=$(printf '%s\n' "$ud" | sed -n 's/^# ci-kit-jit: //p')
cpus=$(printf '%s\n' "$ud" | sed -n 's/^# ci-kit-cpus: //p')
cpus=${cpus:-4}
if [ -z "$jit" ]; then echo "ci-kit-spike-boot: no JIT config in user-data"; exit 0; fi
iptables -I DOCKER-USER -d 169.254.169.254 -j DROP 2>/dev/null || true
docker_run=$(date +%s.%N)
echo "ci-kit-spike-boot: btime=$btime svc_start=$svc_start md_ok=$md_ok docker_run=$docker_run"
exec docker run --rm --name ci-kit-spike-job \
  --cpuset-cpus="0-$((cpus - 1))" --memory="$((2 * cpus))g" \
  -e SPIKE_BTIME="$btime" -e SPIKE_SVC_START="$svc_start" \
  -e SPIKE_MD_OK="$md_ok" -e SPIKE_DOCKER_RUN="$docker_run" \
  ci-kit-runner:spike /home/runner/run.sh --jitconfig "$jit"
EOF
chmod 0755 /usr/local/sbin/ci-kit-spike-boot

cat > /etc/systemd/system/ci-kit-spike-boot.service <<'EOF'
[Unit]
Description=ci-kit M4 spike: start one JIT runner container at boot
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
ExecStart=/usr/local/sbin/ci-kit-spike-boot
Restart=no

[Install]
WantedBy=multi-user.target
EOF
systemctl enable ci-kit-spike-boot.service

if [ "$EXTRA_GB" -gt 0 ]; then
  mkdir -p /var/lib/ci-kit/cache
  # openssl's CTR stream is incompressible and far faster than /dev/urandom.
  openssl enc -aes-256-ctr -pass pass:"$(head -c 32 /dev/urandom | base64)" -nosalt -pbkdf2 \
    < /dev/zero 2>/dev/null | head -c "${EXTRA_GB}G" > /var/lib/ci-kit/cache/blob || true
  test "$(stat -c %s /var/lib/ci-kit/cache/blob)" -eq $((EXTRA_GB * 1024 * 1024 * 1024))
fi

apt-get clean
df -h /
sync
touch /var/lib/ci-kit-spike-built
poweroff
