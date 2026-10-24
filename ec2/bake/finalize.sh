#!/bin/bash
# Runs outside cloud-final, after its final status/results/log writes. Its unit and capability live only in /run.
set -euo pipefail
REPORT=
FAILURE_REPORT=
step=report-input
finish() {
  local status=$?
  set +e
  if [ "$status" -ne 0 ]; then
    echo "ci-kit bake: failed at $step"
    if [ -n "$REPORT" ]; then
      if [ -n "$FAILURE_REPORT" ]; then
        printf '%s' "$FAILURE_REPORT" | curl -sf --max-time 20 -X PUT --data-binary @- "$REPORT" >/dev/null
      else
        curl -sf --max-time 20 -X PUT --data "{\"value\":\"failed:$step\"}" "$REPORT" >/dev/null
      fi
    fi
  fi
  rm -rf /run/ci-kit-bake
  sync
  poweroff
}
trap finish EXIT
trap 'exit 143' TERM
REPORT=$(cat /run/ci-kit-bake/report-url)
rm -rf /run/ci-kit-bake
step=clean
cloud-init clean --logs --machine-id
rm -rf /var/lib/cloud/instances /var/lib/cloud/instance /var/lib/cloud/data /var/lib/cloud/seed
rm -f /var/log/cloud-init.log* /var/log/cloud-init-output.log* /etc/ssh/ssh_host_*
rm -rf /root/.aws /root/.config/gcloud /root/.git-credentials /root/.netrc /tmp/ci-kit-warm-* /tmp/ci-kit-electron-*
: > /etc/hostname
journalctl --rotate > /dev/null 2>&1 || true
journalctl --vacuum-time=1s > /dev/null 2>&1 || true
step=image
FAILURE_REPORT=$(node --input-type=module -e "
  import { checkImage } from '/opt/ci-kit/ec2/vm/job.mjs';
  import { formatDiagnostic } from '/opt/ci-kit/ec2/vm/diagnostics.mjs';
  try { await checkImage(); }
  catch (error) {
    const diagnostic = JSON.parse(formatDiagnostic(error.diagnostic));
    console.error('ci-kit bake: image check ' + JSON.stringify(diagnostic));
    console.log(JSON.stringify({ value: 'failed:image', diagnostic }));
  }
")
[ -z "$FAILURE_REPORT" ] || exit 1
sync
fstrim -av || true
step=report
jq -c '{value:"ok",manifest:.}' /etc/ci-kit/bake-manifest.json | curl -sf --max-time 30 -X PUT --data-binary @- "$REPORT" > /dev/null
step=done
