#!/bin/bash
# Read-only desktop snapshot for the job log, after start's Terminal/cursor work and before end's cleanup.
# Every probe has a 1 s supervisor deadline; failures are unknown, never a reason to fail the job.
set -uo pipefail
here=$(dirname "$0")

if [[ ${1:-} == --hid-idle ]]; then
  # Parse inside the supervised probe: the registry tree itself is much larger than the probe's 512-byte answer.
  ioreg -c IOHIDSystem -d 4 | LC_ALL=C awk '
    /"HIDIdleTime" = [0-9]+$/ { idle=$NF; found=1 }
    END { if (found) printf "%.0f\n", int(idle / 1000000000); else print "unknown" }
  '
  exit
fi

if [[ ${1:-} == --parsec ]]; then
  if [[ -e $HOME/.parsec/log.txt ]]; then
    # parsecd writes "===== Parsec: Started =====" when it starts (at login, after a reboot, on an update), and no
    # client survives that: every client before it is gone, and a log that holds only that start has no client.
    awk '
      /^\[[A-Z] [^]]+\] ===== Parsec: Started =====$/ { split("", clients); seen=1; next }
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

if [[ ${1:-} == --parsec-host ]]; then
  # Parsec's host process, by its path: Apple's CoreParsec (Siri suggestions) runs a parsecd of its own, and `ps -c`
  # prints both as parsecd.
  if table=$(LC_ALL=C ps -axo pid=,comm= 2>/dev/null); then
    LC_ALL=C awk '
      { path=$0; if (!sub(/^ *[0-9]+ +/, "", path)) { bad=1; next }; rows++ }
      path ~ /\/Parsec\.app\/Contents\/MacOS\/parsecd$/ { found=1 }
      END { print found ? "running" : (rows && !bad ? "none" : "unknown") }
    ' <<<"$table"
  else
    echo unknown
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
# The hook calls start after its cursor park. Save that boundary, not the time after these probes finish.
started_at=$(date -u +%s) || started_at=''
if [[ ${1:-} != --activity ]]; then
  front=$(probe "$here/desktop-check.sh" --frontmost) || front=unknown
  front=${front//$'\n'/ }
  front=${front//$'\r'/ }
  # The compiled display helper sits beside this script where install.sh built it. Run from a checkout, as the measured-job
  # guard runs it (mac/settle), the caller names the installed one in CI_KIT_CURSOR_PARK.
  display=$(probe "${CI_KIT_CURSOR_PARK:-$here/cursor-park}" --describe) || display=unknown
  [[ $display =~ ^[0-9]+x[0-9]+@[0-9]+([.][0-9]+)?x$ ]] || display=unknown
fi
# Keep the remote reads independent: one stalled source must not erase the other's positive signal.
parsec=$(probe /bin/bash "$0" --parsec) || parsec=unknown
# parsecd killed by a signal, or crashed, writes no "disconnected." line, so the log keeps its last client connected until
# Parsec next starts: with no host process running there is no client. Only a definite none overrides the log; a failed
# or stalled process read keeps its answer.
if [[ $parsec == parsec && $(probe /bin/bash "$0" --parsec-host) == none ]]; then
  parsec=none
fi
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
# IOHIDSystem's nanoseconds since input, readable without TCC. Read the clock before the probe so its runtime cannot
# make old input look newer. cursor-park's CGWarpMouseCursorPosition generates no event and does not reset this timer.
input_at=$(date -u +%s) || input_at=''
hid_idle_s=$(probe /bin/bash "$0" --hid-idle) || hid_idle_s=unknown
# The watcher needs only these independent signals, not frontmost, display, load or computer-use reads.
if [[ ${1:-} == --activity ]]; then
  printf 'remote=%s hid_idle_s=%s\n' "$remote" "$hid_idle_s"
  exit 0
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
fields="frontmost=${front:-unknown} display=$display remote=$remote hid_idle_s=$hid_idle_s load=$load computeruse=${computeruse:-unknown}"
# --read: the fields alone, logged nowhere, for the measured-job guard (mac/settle), which reads them every 30 s and
# logs one line of its own.
if [[ ${1:-} == --read ]]; then
  printf '%s\n' "$fields"
  exit 0
fi
logs=$HOME/Library/Logs/ci-kit
report() {
  printf '%s\n' "$1"
  {
    mkdir -p "$logs" &&
      printf '%s run=%s job=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${GITHUB_RUN_ID:--}" "${GITHUB_JOB:--}" "$1" >>"$logs/mac-runner-hooks.log"
  } 2>/dev/null || true
}
report "ci-kit desktop (${1:-unknown}): $fields"
# Both hooks pass their parent, the same Runner.Worker. Separate workers (including shared instances) cannot overwrite
# each other's baseline. The job identity also rejects a crashed job's stale record after a PID is reused.
if [[ ${2:-} =~ ^[1-9][0-9]*$ ]]; then
  baseline=$logs/desktop-input-$2
  identity="${GITHUB_RUN_ID:--}/${GITHUB_RUN_ATTEMPT:--}/${GITHUB_JOB:--}"
  if [[ ${1:-} == start ]]; then
    { printf '%s\n%s\n%s\n' "$started_at" "$identity" "$computeruse" >"$baseline"; } 2>/dev/null || true
  elif [[ ${1:-} == end ]]; then
    since='' previous='' before=unknown
    { read -r since; read -r previous; read -r before; } 2>/dev/null <"$baseline" || true
    rm -f "$baseline" 2>/dev/null || true
    # Seconds are rounded down; a one-second margin avoids blaming input at the start boundary (including a park).
    if [[ $previous == "$identity" && $since =~ ^[0-9]+$ && $input_at =~ ^[0-9]+$ && $hid_idle_s =~ ^[0-9]+$ ]] &&
      ((hid_idle_s + 1 < input_at - since)); then
      report "::warning::ci-kit desktop input during this job: hid_idle_s=$hid_idle_s remote=$remote computeruse_start=$before computeruse_end=$computeruse; input can disturb hover or focus. HID input may come from a person or computer-use automation, including the job itself; this is not proof of human interference."
    fi
  fi
fi
exit 0
