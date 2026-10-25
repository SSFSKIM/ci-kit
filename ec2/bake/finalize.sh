#!/bin/bash
# Runs outside cloud-final, after its final status/results/log writes. Its unit and capability live only in /run.
set -euo pipefail
REPORT=
FAILURE_REPORT=
COMPACT_STARTED=0
step=report-input
compact_report() {
  node --input-type=module -e "
    import { readFile } from 'node:fs/promises';
    import { formatDiagnostic, formatCompactTrace, boundCompactLogTail } from '/opt/ci-kit/ec2/vm/diagnostics.mjs';
    const status = Number(process.argv[1]);
    const fallback = { elapsed_seconds: Number(process.argv[2]), exit_status: status, phases: {} };
    const trace = { ...fallback, phases: {} };
    try {
      for (const line of (await readFile('/run/ci-kit-bake/compact-trace', 'utf8')).split('\n')) {
        const fields = /^([a-z-]+) (\d{1,5}) (\d{1,3})$/.exec(line);
        if (!fields) continue;
        const [, phase, elapsed, exit] = fields;
        if (phase === 'compact') trace.elapsed_seconds = Number(elapsed);
        // The first record belongs to the innermost owner, not the outer setup fallback.
        else if (!Object.hasOwn(trace.phases, phase)) trace.phases[phase] = { elapsed_seconds: Number(elapsed), exit_status: Number(exit) };
      }
    } catch {}
    let compact = JSON.parse(formatCompactTrace(trace));
    if (compact.reason) compact = JSON.parse(formatCompactTrace(fallback));
    if (status === 0) {
      const manifest = JSON.parse(await readFile('/etc/ci-kit/bake-manifest.json', 'utf8'));
      console.log(JSON.stringify({ value: 'ok', manifest, compact }));
    } else {
      let diagnostic = JSON.parse(formatDiagnostic({ reason: 'compact-failed', phase: 'compact', exit_status: status }));
      try {
        const inner = JSON.parse(formatDiagnostic(JSON.parse(await readFile('/run/ci-kit-bake/compact-diagnostic', 'utf8'))));
        if (inner.reason === 'compact-failed') {
          diagnostic = inner;
          try {
            const log_tail = boundCompactLogTail(await readFile('/run/ci-kit-bake/compact-diagnostic.log', 'utf8'));
            if (log_tail) diagnostic.log_tail = log_tail;
          } catch {}
        }
      } catch {}
      console.log(JSON.stringify({ value: 'failed:compact', diagnostic, compact }));
    }
  " "$1" "$((SECONDS-COMPACT_STARTED))"
}
finish() {
  local status=$?
  set +e
  if [ "$status" -ne 0 ]; then
    echo "ci-kit bake: failed at $step"
    if [ "$step" = compact ]; then
      FAILURE_REPORT=$(compact_report "$status")
    fi
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
step=compact
COMPACT_STARTED=$SECONDS
# Only bounded failure/timing records cross the nested shells; root may be frozen when written.
install -d -m 0700 /run/ci-kit-bake
export CI_KIT_COMPACT_DIAGNOSTIC=/run/ci-kit-bake/compact-diagnostic
export CI_KIT_COMPACT_TRACE=/run/ci-kit-bake/compact-trace
bash /opt/ci-kit/ec2/bake/compact.sh
step=report
compact_report 0 | curl -sf --max-time 30 -X PUT --data-binary @- "$REPORT" > /dev/null
step=done
