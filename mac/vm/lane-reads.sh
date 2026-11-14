#!/bin/bash
# Sourced by the VM lane's launcher (lane.sh, whose header has the boot rule they serve): what it reads of the machine.
# Each read goes through dialog.sh's bounded, with the launcher's locks (descriptors 7 and 8) closed, and a read that
# fails is unknown, which admits nothing. The launcher sets the inputs these use (the paths, the reads' overrides, the
# bounds) and now_epoch before each.
#
# - memory_read: the kernel's pressure level, the percentage it counts available, and the swap used, from one sysctl;
#   each read joins swap's history, which swap_steady compares with the newest read at least swap_gap s older.
# - disk_read: the free space of the volume holding Tart's VMs.
# - display_admits: the host's main display at @2x (cursor-park --describe).
# - queue_read and wants_guest: the queued jobs a guest can take, read with the machine user's own gh login, and
#   whether the host's exclusive instance takes a solo one first (runner-state.py, by the kernel's paths).
# - mode_admits, holds_read, in_pause_window, parts_ready: the mode, the coordinator's holds, the pause windows, and
#   the lane's parts (Tart's golden image the pointer names, the kit).
# shellcheck disable=SC2034,SC2154 # a library of lane.sh's: it reads the launcher's inputs and sets what it reads
memory_read() { # m_pressure, m_available (%), m_swap (MB); false when the read fails. Each read joins swap's history.
  local text swap i keep_at=() keep_mb=()
  m_pressure='' m_available='' m_swap=''
  text=$(bounded 5 "$sysctl_bin" -n kern.memorystatus_vm_pressure_level kern.memorystatus_level vm.swapusage 7>&- 8>&- 2>/dev/null) ||
    return 1
  { read -r m_pressure && read -r m_available && read -r swap; } <<<"$text"
  if [[ ! ($m_pressure =~ ^[0-9]+$ && $m_available =~ ^[0-9]+$ && $swap =~ used\ =\ ([0-9]+)([.][0-9]+)?M) ]]; then
    m_pressure='' m_available=''
    return 1
  fi
  m_swap=${BASH_REMATCH[1]}
  # Only the newest read at least swap_gap s old, and those since, can be compared with the next.
  for ((i = 0; i < ${#swap_at[@]}; i++)); do
    if ((i + 1 < ${#swap_at[@]})) && ((now_epoch - swap_at[i + 1] >= swap_gap)); then continue; fi
    keep_at+=("${swap_at[i]}") keep_mb+=("${swap_mb[i]}")
  done
  swap_at=(${keep_at[@]+"${keep_at[@]}"} "$now_epoch") swap_mb=(${keep_mb[@]+"${keep_mb[@]}"} "$m_swap")
}
swap_at=() swap_mb=()
# Whether swap has not grown since the newest read at least swap_gap s older than the last one; why in swap_why.
swap_steady() {
  local n=${#swap_at[@]} i ref=-1 keep_at=() keep_mb=()
  ((n > 0)) || { swap_why='swap: no read yet'; return 1; }
  for ((i = n - 2; i >= 0; i--)); do
    if ((swap_at[n - 1] - swap_at[i] >= swap_gap)); then ref=$i; break; fi
  done
  if ((ref < 0)); then
    swap_why="swap: no read $swap_gap s older than this one yet"
    return 1
  fi
  for ((i = ref; i < n; i++)); do keep_at+=("${swap_at[i]}"); keep_mb+=("${swap_mb[i]}"); done
  swap_at=("${keep_at[@]}") swap_mb=("${keep_mb[@]}")
  if ((swap_mb[${#swap_mb[@]} - 1] > swap_mb[0])); then
    swap_why="swap grew from ${swap_mb[0]} MB to ${swap_mb[${#swap_mb[@]} - 1]} MB in $((swap_at[${#swap_at[@]} - 1] - swap_at[0])) s"
    return 1
  fi
  swap_why="swap steady over $((swap_at[${#swap_at[@]} - 1] - swap_at[0])) s"
}
disk_read() { # d_free (GB, whole) and d_free_kb; false when the read fails
  local text
  d_free='' d_free_kb=''
  text=$(bounded 10 "$df_bin" -Pk "$tart_home" 7>&- 8>&- 2>/dev/null) || return 1
  d_free_kb=$(awk 'NR == 2 { print $4 }' <<<"$text")
  [[ $d_free_kb =~ ^[0-9]+$ ]] || { d_free_kb=''; return 1; }
  d_free=$((d_free_kb / 1048576))
}
memory_line() {
  if [[ -n $m_pressure ]]; then printf 'pressure %s, available %s%%, swap %s MB' "$m_pressure" "$m_available" "$m_swap"; else printf 'memory unknown'; fi
}
disk_line() {
  if [[ -n $d_free_kb ]]; then printf 'free %s GB' "$d_free"; else printf 'free space unknown'; fi
}
display_admits() {
  local described
  described=$(bounded 5 "$display_read" --describe 7>&- 8>&- 2>/dev/null) || described=''
  described=${described//$'\n'/}
  display_seen=${described:-unreadable}
  [[ $described =~ ^[0-9]+x[0-9]+@2x$ ]]
}
# The queue: q_solo and q_vm, the queued jobs only a guest or the exclusive instance can take (ci-kit-mac-solo) and
# only a guest can (ci-kit-mac-vm). False with q_why when it cannot be read.
#
# Every session and machine of the account shares one REST budget (5,000 an hour), and 2 + N plain reads a poll (N the
# runs listed) drained it alone in a wave of runs (2026-11-14: queued guest jobs went unbooted). So each read is
# conditional: queue_cache keeps, per API path, the ETag and body of its last 200; the next read of the path sends
# If-None-Match, and a 304, which GitHub does not count, reuses the kept body. A complete read drops what it did not
# read (the runs no longer listed). Anything unexpected (no ETag, an answer whose headers do not parse, a kept body
# that cannot be read or parsed) reads plainly: the counts never rest on the cache. A read GitHub refuses for its rate
# limit stops the reads until the limit lifts (q_budget_until, from rate_limit, which GitHub does not count either).
gh_read() { # <api path> <output file> [<seconds>, 10]: a plain read
  local err status
  err=$(mktemp) || return 1
  bounded "${3:-10}" env -u GH_TOKEN -u GITHUB_TOKEN "${CI_KIT_GH_BIN:-gh}" api "$1" >"$2" 2>"$err" 7>&- 8>&-
  status=$?
  if ((status == 124)); then
    q_why="the read of $1 timed out"
  elif ((status != 0)) && ! rate_limited "$err" "$2"; then
    q_why="the read of $1 failed: $(head -1 "$err" 2>/dev/null)"
  fi
  rm -f "$err"
  return "$status"
}
# Whether a failed read was GitHub's rate limit (lib/github.mjs's rule: a 403 or a 429 whose message names it, or one
# with nothing of the budget left); if so the reads stop until it lifts, which q_budget_until and q_why say: the core
# budget's reset when rate_limit reads it empty, the answer's retry-after when later, a minute when neither says.
rate_limited() { # <stderr file> <body file> [<status> <x-ratelimit-remaining> <x-ratelimit-reset> <retry-after>]
  local code=${3:-} remaining=${4:-} reset=${5:-} now until=0 core='' left
  if [[ -z $code && $(cat "$1" 2>/dev/null) =~ \(HTTP\ ([0-9]{3})\) ]]; then code=${BASH_REMATCH[1]}; fi
  [[ $code == 403 || $code == 429 ]] || return 1
  [[ $remaining == 0 ]] || grep -qi 'rate limit' "$1" "$2" 2>/dev/null || return 1
  now=$(date +%s)
  [[ ! ${6:-} =~ ^[0-9]+$ ]] || until=$((now + 10#$6))
  # The probe, bounded by what is left of the queue read's deadline (at most 5 s), is skipped when nothing is left.
  left=$((q_deadline - SECONDS))
  ((left > 5)) && left=5
  if ((left > 0)); then
    core=$(bounded "$left" env -u GH_TOKEN -u GITHUB_TOKEN "${CI_KIT_GH_BIN:-gh}" api rate_limit 2>/dev/null 7>&- 8>&- | perl -MJSON::PP -e '
      my $d = eval { JSON::PP->new->decode(do { local $/; <STDIN> }) };
      my $c = ref $d eq "HASH" && ref $d->{resources} eq "HASH" ? $d->{resources}{core} : undef;
      exit 1 unless ref $c eq "HASH" && ($c->{remaining} // "") =~ /^\d+$/ && ($c->{reset} // "") =~ /^\d+$/;
      print "$c->{remaining} $c->{reset}\n";
    ')
  fi
  if [[ $core =~ ^([0-9]+)\ ([0-9]+)$ ]]; then remaining=${BASH_REMATCH[1]} reset=${BASH_REMATCH[2]}; fi
  # A few seconds past the reset, for the clocks' skew.
  if [[ $remaining == 0 && $reset =~ ^[0-9]+$ ]] && ((reset + 5 > until)); then until=$((reset + 5)); fi
  ((until > now)) || until=$((now + 60))
  q_budget_until=$until
  if [[ $remaining == 0 ]]; then
    q_budget_why="the GitHub API budget is empty until $(date -u -r "$until" +%H:%M:%SZ)"
  else
    q_budget_why="GitHub's rate limit holds the API reads until $(date -u -r "$until" +%H:%M:%SZ)"
  fi
  q_why=$q_budget_why
}
q_budget_until=0 q_budget_why=''
# The read as a whole is bounded by queue_wait s, each call by what is left of it (at most 10 s): a slow queue reads as
# unknown, so the loop's guard samples on.
queue_left() {
  q_left=$((q_deadline - SECONDS))
  ((q_left > 10)) && q_left=10
  ((q_left > 0)) && return 0
  q_why="the queue read passed its $queue_wait s deadline"
  return 1
}
# A gh api -i answer on stdin: the body to the file, and the status, ETag, x-ratelimit-remaining, x-ratelimit-reset
# and retry-after, a line each; false when it has no status line. gh ends its header lines in CRLF.
# shellcheck disable=SC2016 # perl, not the shell
q_answer='
  my $raw = do { local $/; <STDIN> };
  my ($head, $body) = split /\r?\n\r?\n/, $raw, 2;
  my @lines = split /\r?\n/, $head // "";
  my ($code) = (shift(@lines) // "") =~ m{^HTTP/\S+ (\d{3})\b} or exit 1;
  my %h;
  /^([^:\s]+):\s*(.*?)\s*$/ and $h{lc $1} = $2 for @lines;
  open(my $out, ">", $ARGV[0]) or exit 1;
  print $out $body // "";
  close $out or exit 1;
  print map { ($_ // "") . "\n" } $code, @h{qw(etag x-ratelimit-remaining x-ratelimit-reset retry-after)};
'
# One read through the cache, bounded by what is left of the queue read; g_kept names the entry when the body came
# by a conditional read (kept or just replaced), for queue_parsed to drop if it does not parse.
queue_get() { # <api path> <output file>
  local entry raw err status meta='' code='' etag='' sent='' remaining='' reset='' retry='' cond=()
  entry=$queue_cache/${1//[!A-Za-z0-9._-]/_}
  g_kept=''
  q_read+=${entry##*/}$'\n'
  queue_left || return 1
  if { IFS= read -r sent <"$entry"; } 2>/dev/null && [[ $sent =~ ^(W/)?\"[^\"]+\"$ ]]; then
    cond=(-H "If-None-Match: $sent")
  else
    sent=''
  fi
  raw=$(mktemp) || { q_why='no scratch file'; return 1; }
  err=$(mktemp) || { rm -f "$raw"; q_why='no scratch file'; return 1; }
  bounded "$q_left" env -u GH_TOKEN -u GITHUB_TOKEN "${CI_KIT_GH_BIN:-gh}" api "$1" -i ${cond[@]+"${cond[@]}"} \
    >"$raw" 2>"$err" 7>&- 8>&-
  status=$?
  if ((status != 124)) && meta=$(perl -e "$q_answer" "$2" <"$raw" 2>/dev/null); then
    { read -r code; read -r etag; read -r remaining; read -r reset; read -r retry; } <<<"$meta"
  fi
  rm -f "$raw"
  if ((status == 124)); then
    q_why="the read of $1 timed out"
  elif ((status == 0)) && [[ $code == 2[0-9][0-9] ]]; then
    # A 200 replaces the entry; one with no ETag leaves none.
    if [[ $etag =~ ^(W/)?\"[^\"]+\"$ ]] && mkdir -p "$queue_cache" 2>/dev/null &&
      { printf '%s\n' "$etag" && cat "$2"; } >"$entry.tmp" 2>/dev/null && mv -f "$entry.tmp" "$entry" 2>/dev/null; then
      g_kept=$entry
    else
      rm -f "$entry.tmp" "$entry"
    fi
  elif [[ $code == 304 && -n $sent ]] && tail -n +2 "$entry" >"$2" 2>/dev/null; then
    g_kept=$entry status=0
  elif ((status != 0)) && [[ -n $code && $code != 304 ]]; then
    rate_limited "$err" "$2" "$code" "$remaining" "$reset" "$retry" || q_why="the read of $1 failed: $(head -1 "$err" 2>/dev/null)"
  elif ((status != 0)) && [[ -z $code ]]; then
    rate_limited "$err" "$2" || q_why="the read of $1 failed: $(head -1 "$err" 2>/dev/null)"
  else
    # An answer that does not parse, or a 304 whose kept body is gone: the plain read.
    rm -f "$err" "$entry"
    queue_left && gh_read "$1" "$2" "$q_left"
    return
  fi
  rm -f "$err"
  return "$status"
}
# The read and its parse (a perl program over the body) into q_parsed: 1 when the read fails (q_why says why), 2 when
# the body does not parse. A conditional read's body that does not parse is dropped from the cache and read plainly.
queue_parsed() { # <api path> <scratch file> <program>
  queue_get "$1" "$2" || return 1
  q_parsed=$(perl -MJSON::PP -e "$3" <"$2") && return 0
  [[ -n $g_kept ]] || return 2
  rm -f "$g_kept"
  { queue_left && gh_read "$1" "$2" "$q_left"; } || return 1
  q_parsed=$(perl -MJSON::PP -e "$3" <"$2") || return 2
}
# shellcheck disable=SC2016 # perl, not the shell
queue_runs='
  my $d = eval { JSON::PP->new->decode(do { local $/; <STDIN> }) };
  exit 1 unless ref $d eq "HASH" && ref $d->{workflow_runs} eq "ARRAY";
  print join(" ", map { $_->{id} } grep { ref $_ eq "HASH" && ($_->{id} // "") =~ /^\d+$/ } @{$d->{workflow_runs}}), "\n";
'
# shellcheck disable=SC2016 # perl, not the shell
queue_jobs='
  my $d = eval { JSON::PP->new->decode(do { local $/; <STDIN> }) };
  exit 1 unless ref $d eq "HASH" && ref $d->{jobs} eq "ARRAY";
  my ($solo, $vm) = (0, 0);
  for my $job (@{$d->{jobs}}) {
    next unless ref $job eq "HASH" && ($job->{status} // "") eq "queued" && ref $job->{labels} eq "ARRAY";
    my @labels = map { lc } @{$job->{labels}};
    next unless @labels && !grep { $_ ne "ci-kit-mac-solo" && $_ ne "ci-kit-mac-vm" } @labels;
    if (grep { $_ eq "ci-kit-mac-vm" } @labels) { $vm++ } else { $solo++ }
  }
  print "$solo $vm\n";
'
queue_read() {
  local scratch status runs='' id counts q_deadline=$((SECONDS + queue_wait)) q_left q_read='' file
  q_solo=0 q_vm=0 q_why=''
  if (($(date +%s) < q_budget_until)); then q_why=$q_budget_why; return 1; fi
  scratch=$(mktemp) || { q_why='no scratch file'; return 1; }
  for status in queued in_progress; do
    queue_parsed "repos/$repo/actions/runs?status=$status&per_page=100" "$scratch" "$queue_runs"
    case $? in
      0) runs+=" $q_parsed" ;;
      1) rm -f "$scratch"; return 1 ;;
      *) q_why="the $status runs could not be read"; rm -f "$scratch"; return 1 ;;
    esac
  done
  for id in $(tr ' ' '\n' <<<"$runs" | sort -un); do
    queue_parsed "repos/$repo/actions/runs/$id/jobs?filter=latest&per_page=100" "$scratch" "$queue_jobs"
    case $? in
      0) counts=$q_parsed ;;
      1) rm -f "$scratch"; return 1 ;;
      *) q_why="the jobs of run $id could not be read"; rm -f "$scratch"; return 1 ;;
    esac
    q_solo=$((q_solo + ${counts% *})) q_vm=$((q_vm + ${counts#* }))
  done
  rm -f "$scratch"
  # What this read did not read is no longer listed.
  for file in "$queue_cache"/*; do
    [[ -e $file && $'\n'$q_read != *$'\n'"${file##*/}"$'\n'* ]] || continue
    rm -f "$file" 2>/dev/null
  done
  return 0
}
# What a host instance is doing (runner-state.py, from the kernel's paths): busy, idle, stopped, or unknown.
instance_state() { # <instance root>
  local read
  read=$(bounded 10 python3 -I "$hooks/runner-state.py" "$1" 7>&- 8>&- 2>/dev/null) || { echo unknown; return; }
  echo "${read%% *}"
}
# Conditions 1 and 2 from the queue read: true when a queued job wants a guest; why says what was read.
wants_guest() {
  local host
  if ((q_vm > 0)); then want_why="$q_vm ci-kit-mac-vm job(s) queued"; return 0; fi
  if ((q_solo == 0)); then want_why='no queued job for the guest'; return 1; fi
  if ((q_solo > 1)); then want_why="$q_solo ci-kit-mac-solo jobs queued, more than the host's exclusive instance takes"; return 0; fi
  if [[ -e $drain_marker ]]; then
    host=held
  else
    host=$(instance_state "$lane_root")
  fi
  case $host in
    busy | held) want_why="a ci-kit-mac-solo job queued, and the host's exclusive instance is $host"; return 0 ;;
    stopped) want_why='a ci-kit-mac-solo job queued, and the host'\''s exclusive instance is offline'; return 0 ;;
    idle) want_why='a ci-kit-mac-solo job queued, but the host'\''s exclusive instance is idle and takes it first'; return 1 ;;
    *) want_why='a ci-kit-mac-solo job queued, but whether the host'\''s exclusive instance takes it cannot be read'; return 1 ;;
  esac
}
# Condition 7.
mode_admits() {
  local root roots
  case $lane_mode in
    always) mode_why='mode always'; return 0 ;;
    hold-only) ;;
    *) mode_why="CI_KIT_VM_LANE_MODE is '$lane_mode', neither always nor hold-only"; return 1 ;;
  esac
  if [[ -e $drain_marker ]]; then mode_why='mode hold-only, every host instance held'; return 0; fi
  roots=$( { printf '%s\n' "$lane_root"; shared_instances; } )
  while IFS= read -r root; do
    [[ -d $root ]] || continue
    if [[ $(instance_state "$root") != stopped ]]; then
      mode_why="mode hold-only, and ${root##*/} is not held"
      return 1
    fi
  done <<<"$roots"
  mode_why='mode hold-only, every host instance held'
}
# The holds: h_owners, one line each (<owner>: <its first line>); 1 when there is one, 2 when they cannot be listed.
holds_read() {
  local file why
  h_owners=''
  why=$(perl -e 'opendir(my $d, $ARGV[0]) and exit 0; exit 1 if $!{ENOENT}; print "$!"; exit 2' "$ci_kit_logs" 2>&1)
  case $? in
    0) ;;
    1) return 0 ;;
    *) h_owners="the holds in $ci_kit_logs cannot be listed (${why:-the listing failed})"; return 2 ;;
  esac
  for file in "$ci_kit_logs"/vm-hold.*; do
    [[ -e $file && $file != *.tmp ]] || continue
    h_owners+="${h_owners:+$'\n'}${file##*/vm-hold.}: $(head -1 "$file" 2>/dev/null || echo unreadable)"
  done
  [[ -z $h_owners ]] || return 1
}
in_pause_window() { # whether now is inside one of CI_KIT_VM_PAUSE_WINDOWS (UTC)
  local window from to hhmm
  [[ -n $pause_windows ]] || return 1
  hhmm=$(date -u +%H%M)
  for window in ${pause_windows//,/ }; do
    [[ $window =~ ^([0-2][0-9]):([0-5][0-9])-([0-2][0-9]):([0-5][0-9])$ ]] || continue
    from=${BASH_REMATCH[1]}${BASH_REMATCH[2]} to=${BASH_REMATCH[3]}${BASH_REMATCH[4]}
    if ((10#$from <= 10#$to)); then
      ((10#$hhmm >= 10#$from && 10#$hhmm < 10#$to)) && { window_seen=$window; return 0; }
    else
      ((10#$hhmm >= 10#$from || 10#$hhmm < 10#$to)) && { window_seen=$window; return 0; }
    fi
  done
  return 1
}

# The lane's parts, from one Tart list: g_name the golden image the pointer names; false with parts_why.
parts_ready() { # <tart_vms output>
  g_name=''
  if [[ ! -r $golden_pointer ]]; then parts_why="no golden pointer at $golden_pointer"; return 1; fi
  IFS= read -r g_name <"$golden_pointer" 2>/dev/null || true
  g_name=${g_name%%[[:space:]]*}
  if [[ ! $g_name =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then parts_why="the golden pointer $golden_pointer names no VM"; return 1; fi
  if [[ -z $(tart_state_in "$1" "$g_name") ]]; then parts_why="the golden image $g_name is not among Tart's VMs"; return 1; fi
  [[ -f $kit/vm/guest/kickoff.sh ]] || { parts_why="no kit at $kit"; return 1; }
}
