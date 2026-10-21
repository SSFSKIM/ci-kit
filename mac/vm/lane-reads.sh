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
#   the lane's parts (Tart's golden image the pointer names, the slot's identity, the kit).
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
gh_read() { # <api path> <output file> [<seconds>, 10]
  local err status
  err=$(mktemp) || return 1
  bounded "${3:-10}" env -u GH_TOKEN -u GITHUB_TOKEN "${CI_KIT_GH_BIN:-gh}" api "$1" >"$2" 2>"$err" 7>&- 8>&-
  status=$?
  if ((status == 124)); then
    q_why="the read of $1 timed out"
  elif ((status != 0)); then
    q_why="the read of $1 failed: $(head -1 "$err" 2>/dev/null)"
  fi
  rm -f "$err"
  return "$status"
}
# The read as a whole is bounded by queue_wait s, each call by what is left of it (at most 10 s): a slow queue reads as
# unknown, so the loop's guard samples on.
queue_left() {
  q_left=$((q_deadline - SECONDS))
  ((q_left > 10)) && q_left=10
  ((q_left > 0)) && return 0
  q_why="the queue read passed its $queue_wait s deadline"
  return 1
}
queue_read() {
  local scratch status runs='' id counts q_deadline=$((SECONDS + queue_wait)) q_left
  q_solo=0 q_vm=0 q_why=''
  scratch=$(mktemp) || { q_why='no scratch file'; return 1; }
  for status in queued in_progress; do
    if ! { queue_left && gh_read "repos/$repo/actions/runs?status=$status&per_page=100" "$scratch" "$q_left"; }; then
      rm -f "$scratch"
      return 1
    fi
    if ! id=$(perl -MJSON::PP -e '
      my $d = eval { JSON::PP->new->decode(do { local $/; <STDIN> }) };
      exit 1 unless ref $d eq "HASH" && ref $d->{workflow_runs} eq "ARRAY";
      print join(" ", map { $_->{id} } grep { ref $_ eq "HASH" && ($_->{id} // "") =~ /^\d+$/ } @{$d->{workflow_runs}}), "\n";
    ' <"$scratch"); then
      q_why="the $status runs could not be read"
      rm -f "$scratch"
      return 1
    fi
    runs+=" $id"
  done
  for id in $(tr ' ' '\n' <<<"$runs" | sort -un); do
    if ! { queue_left && gh_read "repos/$repo/actions/runs/$id/jobs?filter=latest&per_page=100" "$scratch" "$q_left"; }; then
      rm -f "$scratch"
      return 1
    fi
    if ! counts=$(perl -MJSON::PP -e '
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
    ' <"$scratch"); then
      q_why="the jobs of run $id could not be read"
      rm -f "$scratch"
      return 1
    fi
    q_solo=$((q_solo + ${counts% *})) q_vm=$((q_vm + ${counts#* }))
  done
  rm -f "$scratch"
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
  local file
  g_name=''
  if [[ ! -r $golden_pointer ]]; then parts_why="no golden pointer at $golden_pointer"; return 1; fi
  IFS= read -r g_name <"$golden_pointer" 2>/dev/null || true
  g_name=${g_name%%[[:space:]]*}
  if [[ ! $g_name =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then parts_why="the golden pointer $golden_pointer names no VM"; return 1; fi
  if [[ -z $(tart_state_in "$1" "$g_name") ]]; then parts_why="the golden image $g_name is not among Tart's VMs"; return 1; fi
  for file in $identity_files; do
    [[ -f $slot_dir/identity/$file ]] || { parts_why="the slot's identity lacks $file ($slot_dir/identity)"; return 1; }
  done
  [[ -f $kit/vm/guest/kickoff.sh ]] || { parts_why="no kit at $kit"; return 1; }
}
