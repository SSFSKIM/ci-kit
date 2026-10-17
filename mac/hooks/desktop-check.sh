#!/bin/bash
# Part of the mac runner's job-started hook: make the mini's desktop the same before every job.
#
# - A system dialog in front refuses the job at once. An e2e job under a modal alert fails group after group on focus
#   and pasteboard (2026-10-16: seven groups red, UserNotificationCenter frontmost). Dialogs are the human's to dismiss;
#   this never tries to clear one.
# - Any other app in front is replaced by Terminal: some of MAWS's paste and to-human results depend on the app in
#   front (Finder where focus falls when an e2e app quits; Chrome after a test leaked a URL into it), so every job
#   starts from the same one. `open -a Terminal` goes through LaunchServices (no Apple Events, no Automation consent);
#   the job fails fast if Terminal is not in front within about 5 s. It acts only before the job, so MAWS's own
#   MAWS_E2E_FOREGROUND=1 is never fought.
#
# The frontmost app is read with lsappinfo alone: AppleScript or System Events would raise TCC prompts on the mini.
# When it cannot be read, the job is not blocked; the miss is logged.
set -uo pipefail

log() {
  mkdir -p "$HOME/Library/Logs/ci-kit"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) desktop-check run=${GITHUB_RUN_ID:--} job=${GITHUB_JOB:--} $*" |
    tee -a "$HOME/Library/Logs/ci-kit/mac-runner-hooks.log"
}

# `lsappinfo info -only name -only bundleid` prints `"LSDisplayName"="<name>"` and `"CFBundleIdentifier"="<id>"`, or,
# on macOS 27, `"<name>" ASN:0x…: …` and `bundleID="<id>"`. The name is localized (Terminal is `터미널` on the mini), so
# Terminal is told by bundle id, and by name only where no bundle id is printed. `-only pid` adds `pid = <number> …`
# or `"pid"=<number>`.
read_front() {
  local info
  info=$(lsappinfo info -only name -only bundleid -only pid "$(lsappinfo front 2>/dev/null)" 2>/dev/null) || info=''
  name=$(sed -n -E 's/^"LSDisplayName"="(.*)"$/\1/p; s/^"([^"]*)" ASN:.*/\1/p' <<<"$info" | head -1)
  bundle=$(sed -n -E 's/^"CFBundleIdentifier"="(.*)"$/\1/p; s/^[[:space:]]*bundleID="([^"]*)".*/\1/p' <<<"$info" | head -1)
  front_pid=$(sed -n -E 's/^[[:space:]]*"?pid"?[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' <<<"$info" | head -1)
}
is_app() { # <bundle id> <name>: whether the frontmost app read last is that app
  [[ $bundle == "$1" || (-z $bundle && $name == "$2") ]]
}

# These optional steps never decide the job's result. Overrides let hook tests use local fakes, not the real log/gh.
dialog_state="$HOME/Library/Logs/ci-kit/dialog-alert.state"
dialog_source() {
  local predicate out process tcc
  case $name in
    UserNotificationCenter) predicate='(process == "socketfilterfw" AND eventMessage CONTAINS "doask: sending prompt for a filtering decision on:") OR (eventMessage CONTAINS "TCCAccessRequest") OR (process == "launchservicesd" AND eventMessage CONTAINS "SETFRONT")' ;;
    SecurityAgent) predicate='process == "security" OR eventMessage CONTAINS "SecKeychain" OR (eventMessage CONTAINS "SecurityAgent" AND (eventMessage CONTAINS[c] "spawn" OR eventMessage CONTAINS[c] "launch"))' ;;
    *) return 0 ;;
  esac
  out=$(mktemp) || return 0
  # Use a file, not a pipe: an abandoned descendant cannot keep command substitution waiting on its stdout.
  if perl -e 'alarm 10; exec @ARGV' "${CI_KIT_LOG_BIN:-/usr/bin/log}" show --last 15m --style compact --info \
    --predicate "$predicate" >"$out" 2>/dev/null; then
    case $name in
      UserNotificationCenter)
        source_line=$(awk '/socketfilterfw\[/ && /doask: sending prompt for a filtering decision on: / { line=$0 } END { print line }' "$out") || source_line=''
        if [[ -n $source_line ]]; then
          source="firewall prompt for ${source_line##*doask: sending prompt for a filtering decision on: }"
        elif [[ -n $front_pid ]]; then
          # Anchor to this pid's latest SETFRONT, not to the job: the dialog may have held focus for minutes.
          # Five seconds catches the initiating burst; rank names by their latest request and omit noisy daemons.
          tcc=$(perl -MTime::Local=timegm -e '
            my $pid = shift;
            my (@requests, @names, $front_line);
            while (<>) {
              next unless /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(\.\d+)?\s+\S+\s+(.+?)\[\d+:[^\]]+\]/;
              my $client = $8;
              my $time = timegm($6, $5, $4, $3, $2 - 1, $1) + ($7 || 0);
              if ($client eq "launchservicesd" && /\bSETFRONT:\s+pid=\Q$pid\E(?:\s|$)/) {
                my %seen;
                @names = ();
                for my $request (reverse @requests) {
                  next unless $request->[0] >= $time - 5 && $request->[0] <= $time;
                  push @names, $request->[1] unless $seen{$request->[1]}++;
                }
                $front_line = $_;
              } elsif (/TCCAccessRequest/ && $client !~ /^(mds|coreaudiod|WindowServer)$/) {
                push @requests, [$time, $client];
              }
            }
            print join(", ", @names), "\n", $front_line if @names;
          ' "$front_pid" "$out") || tcc=''
          if [[ -n $tcc ]]; then
            source="TCC requests before it came to front: ${tcc%%$'\n'*}"
            source_line=${tcc#*$'\n'}
          fi
        fi
        ;;
      SecurityAgent)
        # Compact log output is chronological, with process[pid:thread] in column four. Prefer the last client
        # before SecurityAgent launched; without a launch record, use the latest security/SecKeychain client.
        source_line=$(awk '
          /SecurityAgent/ && tolower($0) ~ /(spawn|launch)/ { picked=last; launched=1; next }
          ($4 ~ /^security\[/ || /SecKeychain/) && $4 !~ /^(securityd|SecurityAgent)\[/ { last=$0 }
          END { print launched ? picked : last }
        ' "$out") || source_line=''
        process=$(awk '{ sub(/\[.*/, "", $4); print $4 }' <<<"$source_line") || process=''
        [[ -z $process ]] || source="security request from $process"
        ;;
    esac
  fi
  rm -f "$out" || true
}

alert_gh() {
  # gh can ignore an inherited SIGALRM. Keep the deadline in a supervisor that kills and reaps it.
  perl -e '
    my $pid = fork;
    defined $pid or exit 125;
    if (!$pid) { exec @ARGV; exit 127; }
    $SIG{ALRM} = sub { kill "KILL", $pid; waitpid $pid, 0; exit 124; };
    alarm 10;
    waitpid $pid, 0;
    my $status = $?;
    alarm 0;
    exit(($status & 127) ? 128 + ($status & 127) : $status >> 8);
  ' "${CI_KIT_GH_BIN:-gh}" "$@"
}
alert_dialog() {
  local out body issue=''
  [[ ! -e $dialog_state ]] || return 0
  mkdir -p "${dialog_state%/*}" || return 0
  # Remember even a failed/timed-out create, so every subsequent job does not alert again.
  : >"$dialog_state" || return 0
  out=$(mktemp) || return 0
  printf -v body 'Time: %s\nFrontmost app: %s\nLikely source: %s\nSource line: %s\nRun id: %s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$name" "$source" "${source_line:-source unknown}" "${GITHUB_RUN_ID:--}"
  if alert_gh issue create --repo SSFSKIM/ci-kit-sandbox --label ci-kit-alert \
    --title "ci-kit alert: system dialog on the mini ($name: $source)" --body "$body" >"$out" 2>/dev/null; then
    IFS= read -r issue <"$out" || true
    printf '%s\n' "$issue" >"$dialog_state" || true
  else
    log "dialog alert issue creation failed or timed out; episode remembered" || true
  fi
  rm -f "$out" || true
}

clear_dialog_alert() {
  local issue=''
  [[ -f $dialog_state ]] || return 0
  IFS= read -r issue <"$dialog_state" || true
  if [[ -n $issue ]]; then
    alert_gh issue comment "$issue" --repo SSFSKIM/ci-kit-sandbox \
      --body "cleared at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null 2>&1 || log "dialog alert clear comment failed or timed out" || true
    alert_gh issue close "$issue" --repo SSFSKIM/ci-kit-sandbox >/dev/null 2>&1 || log "dialog alert close failed or timed out" || true
  fi
  rm -f "$dialog_state" || true
}

read_front
# Read-only entry point for the start/end posture reporter; no focus changes, dialog alerts or logging.
if [[ ${1:-} == --frontmost ]]; then
  printf '%s\n' "${name:-unknown}"
  exit 0
fi
if [[ -z $name ]]; then
  log "could not read the frontmost app; not blocking the job"
  exit 0
fi

case $name in
  UserNotificationCenter | CoreServicesUIAgent | SecurityAgent | loginwindow)
    source='source unknown' source_line=''
    dialog_source || true
    log "frontmost is $name: $source; a system dialog holds focus; failing the job"
    echo "ci-kit: a system dialog ($name: $source) holds focus on the mini — dismiss it there and rerun" >&2
    alert_dialog || true
    exit 1
    ;;
esac

if is_app com.apple.Terminal Terminal; then
  log "frontmost is $name"
  clear_dialog_alert || true
  exit 0
fi

before=$name
if ! open -a Terminal; then
  log "frontmost before=$before; open -a Terminal failed; failing the job"
  echo "ci-kit: could not open Terminal on the mini ($before is in front) — check its desktop and rerun" >&2
  exit 1
fi
for _ in 1 2 3 4 5 6 7 8 9 10; do
  read_front
  is_app com.apple.Terminal Terminal && break
  sleep 0.5
done
log "frontmost before=$before after=${name:-unreadable}"
if [[ -z $name ]]; then
  log "could not read the frontmost app after opening Terminal; not blocking the job"
elif ! is_app com.apple.Terminal Terminal; then
  echo "ci-kit: Terminal did not come to the front on the mini ($name is) — check its desktop and rerun" >&2
  exit 1
else
  clear_dialog_alert || true
fi
