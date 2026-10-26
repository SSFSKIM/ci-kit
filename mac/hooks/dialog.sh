#!/bin/bash
# Sourced by desktop-check.sh (the job-started hook) and dialog-watch.sh (the dialog watcher, every 60 s), so both work
# from one definition of a system dialog, the same read-only reads of the frontmost app and the windows on screen, one
# source attribution, the optional expected-display check, and one desktop-blocking episode per machine with its alert issue (docs/mac-lane.md). The caller sets
# log_tag before sourcing.
#
# The episode is the state file below, rewritten whole (a rename) under a lock, so whichever side sees a dialog first
# opens the one episode and both name it by the same first-seen time:
#
#   phase=pending  the watcher saw a blocked desktop on one read; continues_pending decides whether the next opens it
#   phase=open     the alert issue (issue=, empty when its creation failed) names name= since= and source=; the watcher
#                  closes it after three consecutive reads (clear=) with no dialog and a matching configured display
#   phase=closed   the episode closed at cleared=, but its alert's close failed: the issue is still open. Each watcher
#                  read that sees no dialog tries again, the clear comment unless commented= says when it went through,
#                  then the close, and the file goes once the close does. A close owed holds no runner and refuses no
#                  job. A dialog seen meanwhile tries the close first; while it cannot, the episode reopens
#                  (reopen_episode).
#
# Reads count as consecutive while they are at most reads_apart seconds apart (at= is the watcher's last read).
#
# Messages and the alert name the machine by CI_KIT_MACHINE, which mac/install.sh writes into the runner's .env and the
# watcher's LaunchAgent. A runner installed before it existed is the mini's.
machine=${CI_KIT_MACHINE:-mini}
ci_kit_logs=$HOME/Library/Logs/ci-kit
dialog_state=$ci_kit_logs/dialog-alert.state
dialog_lock=$ci_kit_logs/dialog-alert.lock
alert_repo=SSFSKIM/ci-kit-sandbox
reads_apart=150
clear_reads=3
dialog='' dialog_pid='' dialog_held='' dialog_window='' seen=''

log() {
  mkdir -p "$ci_kit_logs"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $log_tag run=${GITHUB_RUN_ID:--} job=${GITHUB_JOB:--} $*" |
    tee -a "$ci_kit_logs/mac-runner-hooks.log"
}

# Runs a command under a deadline. The alarm belongs to a supervisor that kills and reaps the command, which may ignore
# SIGALRM, and exits 124. The lock's descriptor is closed for it, so nothing it leaves behind can hold the lock.
bounded() { # <seconds> <command...>
  perl -e '
    my $seconds = shift;
    my $pid = fork;
    defined $pid or exit 125;
    if (!$pid) { exec { $ARGV[0] } @ARGV; exit 127; }
    $SIG{ALRM} = sub { kill "KILL", $pid; waitpid $pid, 0; exit 124; };
    alarm $seconds;
    waitpid $pid, 0;
    my $status = $?;
    alarm 0;
    exit(($status & 127) ? 128 + ($status & 127) : $status >> 8);
  ' "$@" 9>&-
}

# The system dialogs, and the login screen: the job hook refuses a job under one, and the watcher alerts on one. Every
# e2e group under one in front fails on focus and pasteboard (2026-10-16: seven groups red with UserNotificationCenter
# frontmost). One on screen without focus is in the way too: SecurityAgent and UserNotificationCenter panels float
# over other apps' windows, where a group's real input can land on them (an automated answer to a keychain or
# permission prompt) and its screenshots see them. Each is its canonical name and bundle id (both read on the mini,
# macOS 27).
dialogs='UserNotificationCenter=com.apple.UserNotificationCenter CoreServicesUIAgent=com.apple.coreservices.uiagent
  SecurityAgent=com.apple.SecurityAgent loginwindow=com.apple.loginwindow'
# Whether a system dialog is up, from the reads made last: the app in front is one (read_front), or, whatever is in
# front, one has a window on screen (read_windows). Sets dialog to the canonical name, which titles, messages and the
# state carry whatever the display language (lsappinfo's name is localized); dialog_pid to its process; dialog_held to
# how it holds the desktop, for the refusal and the alert; dialog_window to its window when it is not the app in front;
# and seen, which starts the log lines of the read, to what the read saw.
is_dialog() {
  local entry
  dialog='' dialog_pid='' dialog_held='' dialog_window='' seen="frontmost is ${name:-unreadable}"
  for entry in $dialogs; do
    if [[ $name == "${entry%%=*}" || (-n $bundle && $bundle == "${entry#*=}") ]]; then
      dialog=${entry%%=*} dialog_pid=$front_pid dialog_held='holds focus'
      return 0
    fi
  done
  [[ -n $screen_dialog ]] || return 1
  dialog=$screen_dialog dialog_pid=$screen_pid dialog_window=$screen_window
  # Without a frontmost read, which app has focus is not known.
  dialog_held="is on screen${name:+ without focus}"
  seen+="; on screen: $dialog ($dialog_window)"
}

# The configured main display is part of the desktop contract, not a mode to set here. cursor-park --describe is
# read-only and reports logical points and backing scale (the same probe as desktop-posture). A failed/invalid read
# gets two retries, each with a 1 s deadline: a transient miss need not hold a machine, but three misses refuse a job
# rather than run blind. The watcher still needs two blocked ticks to open and three clear ticks to close an episode.
# No setting preserves the old behavior, including not calling the helper.
expected_display=${CI_KIT_DISPLAY:-}
clear_condition='no dialog'
[[ -z $expected_display ]] || clear_condition+=' and the configured display matches'
display_fault='' display_detail=''
read_display() {
  local out actual='' attempt
  display_fault='' display_detail=''
  [[ -n $expected_display ]] || return 0
  out=$(mktemp) || out=''
  if [[ -n $out ]]; then
    for attempt in 1 2 3; do
      if bounded 1 "${CI_KIT_CURSOR_PARK:-$(dirname "${BASH_SOURCE[0]}")/cursor-park}" --describe >"$out" 2>/dev/null; then
        actual=$(head -c 512 "$out")
        [[ $actual =~ ^[1-9][0-9]*x[1-9][0-9]*@[1-9][0-9]*([.][0-9]+)?x$ ]] && break
      fi
      actual=''
    done
    rm -f "$out" || true
  fi
  # Numeric comparison accepts an equivalent scale such as 2.0; dimensions stay integer points.
  if [[ -n $actual ]] && awk -v actual="$actual" -v expected="$expected_display" 'BEGIN {
    split(actual, a, /[x@]/); split(expected, e, /[x@]/);
    exit !(a[1] == e[1] && a[2] == e[2] && a[3] + 0 == e[3] + 0)
  }'; then
    return 0
  fi
  display_fault=1
  display_detail="display ${actual:-unreadable (three probe attempts)}, expected $expected_display"
}

# Display faults take precedence for attribution. Display is one stable, single-word alert kind (MAWS parses that title);
# the observed/expected mode goes in its source and body. Neither condition may clear the other's episode.
is_blocked() {
  if [[ -n $display_fault ]]; then
    dialog=Display dialog_pid='' dialog_held='does not match its configured display' dialog_window='' seen=$display_detail
    return 0
  fi
  is_dialog
}

# The frontmost app, read with lsappinfo alone: AppleScript or System Events would raise TCC prompts.
# `lsappinfo info -only name -only bundleid` prints `"LSDisplayName"="<name>"` and `"CFBundleIdentifier"="<id>"`, or,
# on macOS 27, `"<name>" ASN:0x…: …` and `bundleID="<id>"`. The name is localized (Terminal is `터미널` on the mini), so
# Terminal is told by bundle id, and by name only where no bundle id is printed. `-only pid` adds `pid = <number> …`
# or `"pid"=<number>`. An unreadable app leaves name empty.
read_front() {
  local info front
  front=$(bounded 5 lsappinfo front 2>/dev/null) || front=''
  info=$(bounded 5 lsappinfo info -only name -only bundleid -only pid "$front" 2>/dev/null) || info=''
  name=$(sed -n -E 's/^"LSDisplayName"="(.*)"$/\1/p; s/^"([^"]*)" ASN:.*/\1/p' <<<"$info" | head -1)
  bundle=$(sed -n -E 's/^"CFBundleIdentifier"="(.*)"$/\1/p; s/^[[:space:]]*bundleID="([^"]*)".*/\1/p' <<<"$info" | head -1)
  front_pid=$(sed -n -E 's/^[[:space:]]*"?pid"?[[:space:]]*=[[:space:]]*([0-9]+).*/\1/p' <<<"$info" | head -1)
}
is_app() { # <bundle id> <name>: whether the frontmost app read last is that app
  [[ $bundle == "$1" || (-z $bundle && $name == "$2") ]]
}

# The windows on screen, from window-list (window-list.swift, which mac/install.sh compiles beside the hooks; the
# override lets hook tests use a fake): one line each, front to back, of owner pid, layer, alpha, x, y, width, height,
# bundle id ('-' for none) and owner name, tab-separated. A listed dialog is told by its bundle id or its name, as in
# front. Its window counts once it shows (some alpha, some area); the topmost one sets screen_dialog, screen_pid and
# screen_window. A running process alone would not do: SecurityAgent outlives its window. In a logged-in, unlocked
# session none of the four owns a window on screen (read 2026-10-21 on the mini, macOS 27, and on a MacBook, macOS
# 26), loginwindow included: its windows are the lock screen and its shut-down and Force Quit panels, each the human's
# to answer like the rest.
#
# windows_miss says why the list could not be read (no helper, a failure, the deadline): the read then sees a dialog
# only in front, as it did before the helper. The caller logs it.
window_list=${CI_KIT_WINDOW_LIST:-$(dirname "${BASH_SOURCE[0]}")/window-list}
screen_dialog='' screen_pid='' screen_window='' windows_miss=''
read_windows() {
  local out status found
  screen_dialog='' screen_pid='' screen_window='' windows_miss=''
  if [[ ! -x $window_list ]]; then
    windows_miss='window-list is missing'
    return 0
  fi
  out=$(mktemp) || { windows_miss='no scratch file'; return 0; }
  # A file, not a pipe, as for the unified log: nothing the helper leaves behind can hold the read open.
  if bounded 5 "$window_list" >"$out" 2>/dev/null; then status=0; else status=$?; fi
  case $status in
    0)
      # macOS's awk takes no newline in a -v value.
      found=$(awk -F'\t' -v dialogs="${dialogs//$'\n'/ }" '
        BEGIN {
          n = split(dialogs, entries, /[ \t\n]+/)
          for (i = 1; i <= n; i++) if (split(entries[i], kv, "=") == 2) { by_name[kv[1]] = kv[1]; by_bundle[kv[2]] = kv[1] }
        }
        NF >= 9 && $3 + 0 > 0 && $6 + 0 > 0 && $7 + 0 > 0 {
          d = ($8 in by_bundle) ? by_bundle[$8] : ($9 in by_name) ? by_name[$9] : ""
          if (d != "") { printf "%s\t%s\tpid %s, layer %s, %sx%s at %s,%s\n", d, $1, $1, $2, $6, $7, $4, $5; exit }
        }' "$out") || found=''
      IFS=$'\t' read -r screen_dialog screen_pid screen_window <<<"$found" || true
      ;;
    124) windows_miss='window-list timed out' ;;
    *) windows_miss="window-list failed ($status)" ;;
  esac
  rm -f "$out" || true
}

clock() {
  now_epoch=$(date -u +%s) || now_epoch=0
  [[ $now_epoch =~ ^[0-9]+$ ]] || now_epoch=0
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
}
minute() { # <YYYY-MM-DDTHH:MM:SSZ>: the time as people and agents quote it, YYYY-MM-DDTHH:MMZ
  printf '%sZ' "${1:0:16}"
}

# The source attribution. The overrides let hook tests use local fakes, not the real log or gh.
dialog_log() { # <output file> <log show arguments...>
  local out=$1
  shift
  # Use a file, not a pipe: an abandoned descendant cannot keep command substitution waiting on its stdout.
  bounded 10 "${CI_KIT_LOG_BIN:-/usr/bin/log}" show --style compact --info --timezone UTC "$@" >"$out" 2>/dev/null
}

dialog_tcc_source() { # <scratch file>; called only after firewall attribution missed
  local out=$1 predicate front_line window start end front_time tcc
  [[ -n $dialog_pid ]] || return 0
  # A quiet runner may not check a dialog for hours. Keep this long query narrow and pid-exact. The pid is the dialog's,
  # in front or not: one on screen without focus came to front when it opened.
  predicate="process == \"launchservicesd\" AND eventMessage CONTAINS \"SETFRONT: pid=$dialog_pid \""
  dialog_log "$out" --last 3h --predicate "$predicate" || return 0
  front_line=$(awk -v pid="$dialog_pid" '
    /launchservicesd\[/ && index($0, "SETFRONT: pid=" pid " ") { line=$0 }
    END { print line }
  ' "$out") || return 0
  [[ -n $front_line ]] || return 0
  window=$(perl -MTime::Local=timegm -MPOSIX=strftime -e '
    shift =~ /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(\.\d+)?\s/ or exit;
    my $seconds = timegm($6, $5, $4, $3, $2 - 1, $1);
    # log accepts whole-second dates; round outward, then filter to the exact five seconds below.
    print strftime("%Y-%m-%d %H:%M:%S+0000", gmtime($seconds - 5)), "\t",
          strftime("%Y-%m-%d %H:%M:%S+0000", gmtime($seconds + 1)), "\t", $seconds + ($7 || 0);
  ' "$front_line") || return 0
  [[ -n $window ]] || return 0
  IFS=$'\t' read -r start end front_time <<<"$window"
  # Include the transition itself to retain log order for requests sharing its millisecond.
  predicate="(eventMessage CONTAINS \"TCCAccessRequest\") OR ($predicate) OR (process == \"sandboxd\" AND (eventMessage == \"request approval\" OR eventMessage CONTAINS \"user interaction not allowed\"))"
  dialog_log "$out" --start "$start" --end "$end" --debug --predicate "$predicate" || return 0
  tcc=$(perl -MTime::Local=timegm -e '
    my ($front, $front_line) = (shift, shift);
    my (@requests, %pending, %seen);
    while (<>) {
      chomp;
      last if $_ eq $front_line;
      next unless /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(\.\d+)?\s+\S+\s+(.+?)\[(\d+:[^\]]+)\]/;
      my ($client, $thread) = ($8, $9);
      my $time = timegm($6, $5, $4, $3, $2 - 1, $1) + ($7 || 0);
      next unless $time >= $front - 5 && $time <= $front;
      if ($client eq "sandboxd") {
        if (/\brequest approval\s*$/) {
          my $request = ["sandboxd (data from other apps)", 1];
          push @requests, $request;
          $pending{$thread} = $request;
        } elsif (/user interaction not allowed/ && $pending{$thread}) {
          # Only the most recent approval on this pid/thread was rejected, not another thread or burst.
          $pending{$thread}->[1] = 0;
          delete $pending{$thread};
        }
      } elsif (/TCCAccessRequest/ && $client !~ /^(mds|coreaudiod|WindowServer)$/) {
        push @requests, [$client, 1];
      }
    }
    print join(", ", map { $_->[0] } grep { $_->[1] && !$seen{$_->[0]}++ } reverse @requests);
  ' "$front_time" "$front_line" "$out") || tcc=''
  if [[ -n $tcc ]]; then
    source="TCC requests before it came to front: $tcc"
    source_line=$front_line
  fi
}

# Sets source and source_line for the dialog read last ('source unknown' and empty when nothing is found). It runs once
# per episode, when the episode opens: up to three 10 s log queries.
dialog_source() {
  local predicate out process
  source='source unknown' source_line=''
  case $dialog in
    Display) source=$display_detail; return 0 ;;
    UserNotificationCenter) predicate='process == "socketfilterfw" AND eventMessage CONTAINS "doask: sending prompt for a filtering decision on:"' ;;
    SecurityAgent) predicate='process == "security" OR eventMessage CONTAINS "SecKeychain" OR (eventMessage CONTAINS "SecurityAgent" AND (eventMessage CONTAINS[c] "spawn" OR eventMessage CONTAINS[c] "launch"))' ;;
    *) return 0 ;;
  esac
  out=$(mktemp) || return 0
  if dialog_log "$out" --last 15m --predicate "$predicate"; then
    case $dialog in
      UserNotificationCenter)
        source_line=$(awk '/socketfilterfw\[/ && /doask: sending prompt for a filtering decision on: / { line=$0 } END { print line }' "$out") || source_line=''
        if [[ -n $source_line ]]; then
          source="firewall prompt for ${source_line##*doask: sending prompt for a filtering decision on: }"
        else
          dialog_tcc_source "$out"
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

# On a Mac the owner does not sit at, the alert writes with a token limited to the sandbox's issues instead of the
# account the machine's user is logged into (docs/mac-lane.md). gh gets it through its environment alone.
alert_token=$HOME/.config/ci-kit/alert-token
alert_gh_token=
read_alert_token() { # before the gh calls, outside their redirected output
  [[ -f $alert_token ]] || return 0
  read -r alert_gh_token 2>/dev/null <"$alert_token" || true
  [[ -n $alert_gh_token ]] || log "$alert_token is empty or unreadable; gh uses its own login"
}
alert_gh() ( # a subshell, so GH_TOKEN reaches this gh call and nothing else
  [[ -z $alert_gh_token ]] || export GH_TOKEN=$alert_gh_token
  bounded 10 "${CI_KIT_GH_BIN:-gh}" "$@"
)

# The episode's state, read into st_* and written back whole. A missing or unreadable file is no episode.
load_state() {
  local key value
  st_phase='' st_name='' st_since='' st_at=0 st_source='' st_issue='' st_clear=0 st_clear_since='' st_cleared=''
  st_commented=''
  [[ -f $dialog_state ]] || return 0
  while IFS='=' read -r key value; do
    case $key in
      phase) st_phase=$value ;;
      name) st_name=$value ;;
      since) st_since=$value ;;
      at) st_at=$value ;;
      source) st_source=$value ;;
      issue) st_issue=$value ;;
      clear) st_clear=$value ;;
      clear_since) st_clear_since=$value ;;
      cleared) st_cleared=$value ;;
      commented) st_commented=$value ;;
    esac
  done <"$dialog_state" 2>/dev/null || true
  # A state file from before the watcher holds only the URL of the issue its episode opened (empty when the creation
  # failed). It is adopted as an open episode, first seen when the file was written, so that issue is closed in turn.
  if [[ -z $st_phase ]]; then
    IFS= read -r value <"$dialog_state" 2>/dev/null || true
    if [[ $value != *=* ]]; then
      st_phase=open st_issue=$value st_source='source unknown'
      st_since=$(perl -MPOSIX=strftime -e 'print strftime("%Y-%m-%dT%H:%M:%SZ", gmtime((stat shift)[9]))' \
        "$dialog_state" 2>/dev/null) || st_since=${now:-}
    fi
  fi
  [[ $st_at =~ ^[0-9]+$ ]] || st_at=0
  [[ $st_clear =~ ^[0-9]+$ ]] || st_clear=0
  return 0
}
save_state() {
  mkdir -p "$ci_kit_logs" &&
    printf 'phase=%s\nname=%s\nsince=%s\nat=%s\nsource=%s\nissue=%s\nclear=%s\nclear_since=%s\ncleared=%s\ncommented=%s\n' \
      "$st_phase" "$st_name" "$st_since" "$st_at" "$st_source" "$st_issue" "$st_clear" "$st_clear_since" \
      "$st_cleared" "$st_commented" >"$dialog_state.tmp" &&
    mv -f "$dialog_state.tmp" "$dialog_state"
}
drop_state() {
  rm -f "$dialog_state"
}
consecutive() { # whether this read follows the watcher's last one closely enough to continue its count
  ((now_epoch - st_at <= reads_apart))
}
# Whether a blocked read continues the pending episode: configured machines track readiness regardless of attribution;
# without a display setting the same dialog must persist.
continues_pending() {
  [[ -n $expected_display || $st_name == "$dialog" ]] && consecutive
}

# One holder at a time: the watcher tries once and skips its read when the hook holds it; the hook waits (its job is
# refused or let through only after). The lock is flock(2) on descriptor 9, taken by a helper on the inherited
# descriptor; it is held until this shell closes the descriptor or exits.
lock_state() { # <seconds to wait; 0 tries once>
  mkdir -p "$ci_kit_logs" 2>/dev/null || return 1
  exec 9>>"$dialog_lock" || return 1
  if perl -MFcntl=:flock -e '
    open(my $fh, ">>&=", 9) or exit 2;
    my $wait = shift;
    exit(flock($fh, LOCK_EX | LOCK_NB) ? 0 : 1) unless $wait;
    local $SIG{ALRM} = sub { exit 1 };
    alarm $wait;
    exit(flock($fh, LOCK_EX) ? 0 : 1);
  ' "$1"; then
    return 0
  fi
  exec 9>&-
  return 1
}
unlock_state() {
  exec 9>&-
}

# The alert title is a contract: MAWS reads open alerts with ^ci-kit alert: ([a-z0-9-]+): (\S+) since (\S+), and
# install.sh keeps machine names to [a-z0-9-]. The source follows only when attribution found one.
alert_title() {
  local title="ci-kit alert: $machine: $st_name since $(minute "$st_since")"
  [[ -z $st_source || $st_source == 'source unknown' ]] || title+=" ($st_source)"
  printf '%s' "$title"
}

# Opens the episode for the dialog read last (is_dialog), from the first-seen time given: its source (read here, once), then the
# state, written before gh runs so a failed or timed-out creation is remembered and nothing alerts again until the
# episode closes. The issue follows with alert_episode.
start_episode() { # <first seen>
  dialog_source || true
  st_phase=open st_name=$dialog st_since=$1 st_at=$now_epoch st_source=$source st_issue='' st_clear=0 st_clear_since=''
  st_cleared='' st_commented=''
  save_state
}
alert_episode() { # <who opened it>
  local out body issue=''
  out=$(mktemp) || return 0
  read_alert_token
  printf -v body 'Time: %s\nMachine: %s\nDialog: %s %s%s\nFrontmost app: %s\nFirst seen: %s\nOpened by: %s\nLikely source: %s\nSource line: %s\nRun id: %s\n' \
    "$now" "$machine" "$st_name" "$dialog_held" "${dialog_window:+ ($dialog_window)}" "${name:-unreadable}" "$st_since" "$1" \
    "$st_source" "${source_line:-source unknown}" "${GITHUB_RUN_ID:--}"
  if alert_gh issue create --repo "$alert_repo" --label ci-kit-alert --title "$(alert_title)" --body "$body" \
    >"$out" 2>/dev/null; then
    IFS= read -r issue <"$out" || true
    st_issue=$issue
    save_state || true
  else
    log "dialog alert issue creation failed or timed out; episode remembered" || true
  fi
  rm -f "$out" || true
}
# Closes the episode (the watcher's third clear read) and then its alert issue. An open alert refuses the machine's
# jobs in MAWS's ci-gate.sh, so a close that fails is owed, never dropped (2026-10-20: the comment and the close failed
# while the network came up after a reboot, and the alert held every Mac job until it was closed by hand).
close_episode() {
  st_phase=closed st_cleared=$now st_commented=''
  close_alert || true
}
# What the closed episode owes its alert: the clear comment, unless it went through, then the close. True, with the
# file gone, once the close has gone through; gh's close of an issue someone has already closed goes through too. A
# failed close is settled only when GitHub says the issue itself is closed or gone (alert_settled). A comment that
# fails beside a close that goes through is not tried again: the close is what MAWS reads.
close_alert() {
  local owed='' why
  if [[ -n $st_issue ]]; then
    read_alert_token
    if [[ -z $st_commented ]]; then
      if alert_gh issue comment "$st_issue" --repo "$alert_repo" \
        --body "cleared at $st_cleared: $clear_condition on $clear_reads reads in a row since $st_clear_since" >/dev/null 2>&1; then
        st_commented=$now
      else
        log "dialog alert clear comment failed or timed out" || true
      fi
    fi
    if alert_gh issue close "$st_issue" --repo "$alert_repo" >/dev/null 2>&1; then
      :
    elif why=$(alert_settled); then
      log "dialog alert close failed, but GitHub says $st_issue is $why; nothing is left to close" || true
    else
      log "dialog alert close failed or timed out; the alert stays open until a later read closes it" || true
      owed=1
    fi
    if [[ -n $owed ]]; then
      save_state || true
      return 1
    fi
  fi
  drop_state || true
}
# Whether GitHub says the alert's issue needs no close, read from the issue itself (a search, as `gh issue list
# --label` is, may lag or come back cut short), and why: `closed` (by hand, or by a close whose answer gh did not live
# to give), `deleted` (410, which GitHub answers only to a caller that can read the repository) or `not there` (404 in
# a repository the token can read: the sandbox is private, so a 404 alone may be a token that cannot see it). Anything
# else, an open issue, a timeout or another error, keeps the close owed. gh's "Could not resolve to an issue" proves
# nothing either: GitHub says it too of an issue the caller cannot see (cli/cli#8013).
alert_settled() {
  local out err state why=''
  out=$(mktemp) || return 1
  err=$(mktemp) || { rm -f "$out"; return 1; }
  if alert_gh api "repos/$alert_repo/issues/${st_issue##*/}" --jq .state >"$out" 2>"$err"; then
    IFS= read -r state <"$out" || state=''
    [[ $state != closed ]] || why=closed
  elif grep -q '(HTTP 410)' "$err"; then
    why=deleted
  elif grep -q '(HTTP 404)' "$err" && alert_gh api "repos/$alert_repo" --silent >/dev/null 2>&1; then
    why='not there'
  fi
  rm -f "$out" "$err" || true
  [[ -n $why ]] || return 1
  printf '%s' "$why"
}
# A later read's try at an owed close (phase=closed). True, with the file gone, once it has gone through.
retry_close() {
  close_alert || return 1
  log "$seen: the alert $st_issue of the episode of $st_name since $st_since, which closed at $st_cleared, is closed" ||
    true
}
# A dialog in front while the alert's close is owed. The close is tried first: once it goes through (false, the file
# gone), the dialog is a new episode's, with its own time, source and alert. While it cannot, GitHub would most likely
# refuse a second alert too, and the open one is right again: the episode reopens with it (true, the state set and left
# for the caller to save), keeping its name, time and source, so that alert closes when this dialog is gone.
reopen_episode() {
  retry_close && return 1
  log "$seen: the alert $st_issue of the episode of $st_name since $st_since is still open; the episode reopens with it" ||
    true
  st_phase=open st_clear=0 st_clear_since='' st_cleared='' st_commented=''
}
