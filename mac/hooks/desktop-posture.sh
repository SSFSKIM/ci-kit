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
  # screensharingd by its exact name, in the table the computer-use read uses. launchd holds the listener and starts the
  # daemon when a viewer connects, over whatever transport it serves; it exits about 15 s after the last viewer leaves.
  # Not netstat: in a job hook it leaves out every Internet socket (#50). SSMenuAgent outlives a session.
  if table=$(LC_ALL=C ps -axco pid=,comm= 2>/dev/null); then
    LC_ALL=C awk '
      { name=$0; if (!sub(/^ *[0-9]+ +/, "", name)) { bad=1; next }; rows++ }
      name == "screensharingd" { found=1 }
      END { print found ? "screensharing" : (rows && !bad ? "none" : "unknown") }
    ' <<<"$table"
  else
    echo unknown
  fi
  exit
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
# The compiled display helper sits beside this script where install.sh built it. Run from a checkout, as the measured-job
# guard runs it (mac/settle), the caller names the installed one in CI_KIT_CURSOR_PARK.
display=$(probe "${CI_KIT_CURSOR_PARK:-$here/cursor-park}" --describe) || display=unknown
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
# The 1, 5 and 15 minute load averages as sysctl prints them, `{ 1.52 1.37 1.29 }` (macOS formats each %.2f), so a reader
# can tell a load-induced red from the branch's own (#54).
load=$(probe sysctl -n vm.loadavg) || load=unknown
avg='([0-9]+[.][0-9]{2})'
if [[ $load =~ ^[{]\ $avg\ $avg\ $avg\ [}]$ ]]; then
  load=${BASH_REMATCH[1]}/${BASH_REMATCH[2]}/${BASH_REMATCH[3]}
else
  load=unknown
fi
computeruse=$(probe /bin/bash "$0" --computeruse) || computeruse=unknown
# computeruse stays last: a long list cannot push a field after it out of view.
fields="frontmost=${front:-unknown} display=$display remote=$remote load=$load computeruse=${computeruse:-unknown}"
# --read: the fields alone, logged nowhere, for the measured-job guard (mac/settle), which reads them every 30 s and
# logs one line of its own.
if [[ ${1:-} == --read ]]; then
  printf '%s\n' "$fields"
  exit 0
fi
line="ci-kit desktop (${1:-unknown}): $fields"
printf '%s\n' "$line"
{
  mkdir -p "$HOME/Library/Logs/ci-kit" &&
    printf '%s run=%s job=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${GITHUB_RUN_ID:--}" "${GITHUB_JOB:--}" "$line" >>"$HOME/Library/Logs/ci-kit/mac-runner-hooks.log"
} 2>/dev/null || true
exit 0
