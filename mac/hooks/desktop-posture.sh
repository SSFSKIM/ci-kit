#!/bin/bash
# Read-only desktop snapshot for the job log, after start's Terminal/cursor work and before end's cleanup.
# Every probe has a 1 s supervisor deadline; failures are unknown, never a reason to fail the job.
set -uo pipefail
here=$(dirname "$0")

if [[ ${1:-} == --remote ]]; then
  parsec=none
  if [[ -e $HOME/.parsec/log.txt ]]; then
    parsec=$(awk '
      /^\[I [^]]+\] .+#[0-9]+ connected\.$/ { state="parsec" }
      /^\[I [^]]+\] .+#[0-9]+ disconnected\.$/ { state="none" }
      END { print state ? state : "unknown" }
    ' "$HOME/.parsec/log.txt" 2>/dev/null) || parsec=unknown
  fi
  # Non-root socket visibility works even though screensharingd runs as root. Count incoming connections, not the
  # enabled/listening service or this Mac's outgoing viewer. High-performance sharing can use only peered UDP
  # 5900–5902. This is default-port transport presence, not authentication or UDP liveness proof (see mac-lane.md).
  sharing=unknown
  if sockets=$(LC_ALL=C netstat -an 2>/dev/null); then
    sharing=$(awk '
      /^Proto/ && /Local Address/ && /Foreign Address/ { header=1 }
      /^tcp[46]/ { if (NF < 6) bad=1; if ($4 ~ /[.]5900$/ && $6 == "ESTABLISHED") attached=1 }
      /^udp[46]/ {
        if (NF < 5) bad=1
        if ($4 ~ /[.]590[012]$/ && $5 !~ /\*/ && $5 ~ /[.][0-9]+$/) attached=1
      }
      END { print attached ? "screensharing" : (header && !bad ? "none" : "unknown") }
    ' <<<"$sockets") || sharing=unknown
  fi
  if [[ $parsec == parsec && $sharing == screensharing ]]; then
    echo parsec,screensharing
  elif [[ $parsec == parsec ]]; then
    echo parsec
  elif [[ $sharing == screensharing ]]; then
    echo screensharing
  elif [[ $parsec == unknown || $sharing == unknown ]]; then
    echo unknown
  else
    echo none
  fi
  exit 0
fi

# Like desktop-check's gh deadline, the alarm belongs to a supervisor, not the exec-ed helper (which may ignore it).
# Give each probe its own process group so a hanging shell and its children are killed together. Output goes to a
# file: an abandoned descendant cannot keep command substitution waiting for its stdout to close.
probe() {
  [[ -n $out ]] || return 1
  if perl -e '
    my $pid = fork;
    defined $pid or exit 125;
    if (!$pid) { setpgrp 0, 0 or exit 125; exec @ARGV; exit 127; }
    $SIG{ALRM} = sub { kill "KILL", -$pid; waitpid $pid, 0; exit 124; };
    alarm 1;
    waitpid $pid, 0;
    my $status = $?;
    alarm 0;
    exit(($status & 127) ? 128 + ($status & 127) : $status >> 8);
  ' "$@" >"$out" 2>/dev/null; then
    head -c 512 "$out"
  else
    return 1
  fi
}

out=$(mktemp) || out=''
trap '[[ -z $out ]] || rm -f "$out"' EXIT
front=$(probe "$here/desktop-check.sh" --frontmost) || front=unknown
front=${front//$'\n'/ }
front=${front//$'\r'/ }
display=$(probe "$here/cursor-park" --describe) || display=unknown
[[ $display =~ ^[0-9]+x[0-9]+@[0-9]+([.][0-9]+)?x$ ]] || display=unknown
remote=$(probe /bin/bash "$0" --remote) || remote=unknown
line="ci-kit desktop (${1:-unknown}): frontmost=${front:-unknown} display=$display remote=$remote"
printf '%s\n' "$line"
{
  mkdir -p "$HOME/Library/Logs/ci-kit" &&
    printf '%s run=%s job=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${GITHUB_RUN_ID:--}" "${GITHUB_JOB:--}" "$line" >>"$HOME/Library/Logs/ci-kit/mac-runner-hooks.log"
} 2>/dev/null || true
exit 0
