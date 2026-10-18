#!/bin/bash
# Read-only desktop snapshot for the job log, after start's Terminal/cursor work and before end's cleanup.
# Every probe has a 1 s supervisor deadline; failures are unknown, never a reason to fail the job.
set -uo pipefail
here=$(dirname "$0")

if [[ ${1:-} == --parsec ]]; then
  if [[ -e $HOME/.parsec/log.txt ]]; then
    awk '
      /^\[I [^]]+\] .+#[0-9]+ (dis)?connected\.$/ {
        client=$0
        sub(/^\[I [^]]+\] /, "", client)
        sub(/ (dis)?connected[.]$/, "", client)
        clients[client]=($NF == "connected.")
        seen=1
      }
      END {
        for (client in clients) if (clients[client]) { print "parsec"; exit }
        print seen ? "none" : "unknown"
      }
    ' "$HOME/.parsec/log.txt" 2>/dev/null
  else
    echo none
  fi
  exit
fi

if [[ ${1:-} == --screensharing ]]; then
  # Non-root socket visibility works even though screensharingd runs as root. Count incoming connections, not the
  # enabled/listening service or this Mac's outgoing viewer. High-performance sharing can use only peered UDP
  # 5900–5902. This is default-port transport presence, not authentication or UDP liveness proof (see mac-lane.md).
  sockets=$(LC_ALL=C netstat -an 2>/dev/null) && net=0 || net=$?
  if ((net == 0)); then
    result=$(awk '
      /^Proto/ && /Local Address/ && /Foreign Address/ { header=1 }
      /^tcp[46]/ { if (NF < 6) bad=1; if ($4 ~ /[.]5900$/ && $6 == "ESTABLISHED") attached=1 }
      /^udp[46]/ {
        if (NF < 5) bad=1
        if ($4 ~ /[.]590[012]$/ && $5 !~ /\*/ && $5 ~ /[.][0-9]+$/) attached=1
      }
      END { print attached ? "screensharing" : (header && !bad ? "none" : "unknown") }
    ' <<<"$sockets") && status=0 || status=$?
  else
    result=unknown status=0
  fi
  printf '%s\n' "$result"
  # #50: job hooks read none with a viewer attached, while every other context tried reads screensharing. While the
  # trigger file exists, each run appends what it saw to posture-debug.log: a few KB, no other environment, inside this
  # probe's deadline. In a subshell, so no failure there, even under an inherited errexit, changes the result.
  # SHELLOPTS lists this shell's own options too (the defaults, nounset, pipefail); any other was inherited.
  if [[ -e $HOME/Library/Logs/ci-kit/posture-debug ]]; then
    (
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) run=${GITHUB_RUN_ID:--} job=${GITHUB_JOB:--}" \
        "--screensharing: printed $result, exit $status"
      # Sockets on ports 5900-5909, not every line containing 590: under load, ephemeral ports (59049) and the
      # unix-socket section's hex addresses match by the dozen and would push the one that matters past the cap.
      printf '%s' "$sockets" | /usr/bin/awk -v net="$net" '
        /^(tcp|udp)/ && (/[.:]590[0-9][ \t]/ || /[.:]590[0-9]$/) && ++n <= 30 { hit[n] = substr($0, 1, 100) }
        END {
          print "  netstat: exit " net ", " NR " lines, " (n + 0) " on ports 5900-5909"
          for (i = 1; i <= n && i <= 30; i++) print "    " hit[i]
        }'
      echo "  uid $(id -u), pid $$, ppid $PPID"
      /bin/ps -A -o pid=,ppid=,comm= | /usr/bin/awk -v pid="$PPID" '
        { up[$1] = $2; name = $0; sub(/^ *[0-9]+ +[0-9]+ +/, "", name)
          comm[$1] = length(name) > 120 ? "..." substr(name, length(name) - 116) : name }
        END {
          for (i = 0; i < 24 && pid in comm; i++) {
            chain = chain (i ? " < " : "") pid " " comm[pid]
            if (pid == 1) break
            pid = up[pid]
          }
          print "  parents: " chain
        }'
      for name in PATH LANG LC_ALL SHELLOPTS BASHOPTS TMPDIR; do
        if [[ -n ${!name+set} ]]; then value=${!name}; echo "  $name=${value:0:1024}"; else echo "  $name unset"; fi
      done
      for tool in netstat awk perl; do printf '  command -v %s: %s\n' "$tool" "$(command -v "$tool" || echo none)"; done
    ) >>"$HOME/Library/Logs/ci-kit/posture-debug.log" 2>/dev/null || true
  fi
  exit "$status"
fi

if [[ ${1:-} == --computeruse ]]; then
  # Computer-use processes by executable name. `ps -c` prints each name in full; pgrep and ps's ucomm see the kernel's
  # 16-character name, where SkyComputerUseService is SkyComputerUseSe. Names only: a cua runtime's node and node_repl
  # run in every session with the plugin loaded, and ci-kit's own cursor-park starts with neither prefix.
  if table=$(LC_ALL=C ps -axco pid=,comm= 2>/dev/null); then
    LC_ALL=C awk '
      { name=$0; if (!sub(/^ *[0-9]+ +/, "", name)) { bad=1; next }; rows++ }
      name == "SkyComputerUseService" || index(name, "CUAService") || substr(name, 1, 3) == "cua" { found[name]=1 }
      END {
        for (name in found) { i=++n; while (i > 1 && names[i-1] > name) { names[i]=names[i-1]; i-- }; names[i]=name }
        # The reader keeps 512 bytes: whole names while the list fits in 490, then ",+N more" for the rest.
        for (i=1; i<=n; i++) { next_out=out (i > 1 ? "," : "") names[i]; if (length(next_out) > 490) break; out=next_out; kept=i }
        if (kept < n) out=out (kept ? "," : "") "+" (n - kept) " more"
        print n ? out : (rows && !bad ? "none" : "unknown")
      }
    ' <<<"$table"
  else
    echo unknown
  fi
  exit
fi

# Like desktop-check's gh deadline, the alarm belongs to a supervisor, not the exec-ed helper (which may ignore it).
# Give each probe its own process group so a hanging shell and its children are killed together; the child itself is
# killed first, since one scheduled late may not have its group yet when the alarm fires. Output goes to a file: an
# abandoned descendant cannot keep command substitution waiting for its stdout to close.
probe() {
  [[ -n $out ]] || return 1
  if perl -e '
    my $pid = fork;
    defined $pid or exit 125;
    if (!$pid) { setpgrp 0, 0 or exit 125; exec @ARGV; exit 127; }
    $SIG{ALRM} = sub { kill "KILL", $pid, -$pid; waitpid $pid, 0; exit 124; };
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
# Keep the remote reads independent: one stalled source must not erase the other's positive signal.
parsec=$(probe /bin/bash "$0" --parsec) || parsec=unknown
sharing=$(probe /bin/bash "$0" --screensharing) || sharing=unknown
if [[ $parsec == parsec && $sharing == screensharing ]]; then
  remote=parsec,screensharing
elif [[ $parsec == parsec ]]; then
  remote=parsec
elif [[ $sharing == screensharing ]]; then
  remote=screensharing
elif [[ $parsec == unknown || $sharing == unknown ]]; then
  remote=unknown
else
  remote=none
fi
computeruse=$(probe /bin/bash "$0" --computeruse) || computeruse=unknown
line="ci-kit desktop (${1:-unknown}): frontmost=${front:-unknown} display=$display remote=$remote computeruse=${computeruse:-unknown}"
printf '%s\n' "$line"
{
  mkdir -p "$HOME/Library/Logs/ci-kit" &&
    printf '%s run=%s job=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${GITHUB_RUN_ID:--}" "${GITHUB_JOB:--}" "$line" >>"$HOME/Library/Logs/ci-kit/mac-runner-hooks.log"
} 2>/dev/null || true
exit 0
