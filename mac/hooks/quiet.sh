#!/bin/bash
# UTC quiet windows, daily or dated, shared by the drain, VM launcher, local heavy-work launchers and the lane publisher.
# Sourcing this file does no work. quiet_read sets quiet_windows (active declarations, joined by "; "), quiet_host and
# quiet_vm (those of them holding that lane) and quiet_invalid (malformed lines). The watcher logs malformed lines; the
# other readers only decide admission. quiet_list prints every well-formed declaration, active or not, so the publisher
# can announce one before it starts.
quiet_valid_stamp() { # <YYYY-MM-DDTHH:MMZ>: reject impossible dates, not just malformed times
  local year month day days
  local pattern='^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]Z$'
  [[ $1 =~ $pattern ]] || return 1
  year=$((10#${BASH_REMATCH[1]})) month=$((10#${BASH_REMATCH[2]})) day=$((10#${BASH_REMATCH[3]}))
  ((year > 0)) || return 1
  case $month in
    4 | 6 | 9 | 11) days=30 ;;
    2) days=28; if ((year % 4 == 0 && (year % 100 != 0 || year % 400 == 0))); then days=29; fi ;;
    *) days=31 ;;
  esac
  ((day <= days))
}
# <line>: false for a malformed declaration. A daily one sets quiet_kind=daily and quiet_from/quiet_until to minutes
# after midnight (until < from wraps midnight); a dated one sets quiet_kind=dated and the two stamps, from < until.
# quiet_lanes is the lanes it holds: host,vm, or the one a lanes=host or lanes=vm token right after the endpoints names.
quiet_parse() {
  local daily='^([01][0-9]|2[0-3]):([0-5][0-9])Z[[:blank:]]+([01][0-9]|2[0-3]):([0-5][0-9])Z[[:blank:]]+([^[:space:]].*)$'
  local dated='^([0-9-]+T[0-9:]+Z)[[:blank:]]+([0-9-]+T[0-9:]+Z)[[:blank:]]+([^[:space:]].*)$'
  local rest
  if [[ $1 =~ $daily ]]; then
    quiet_kind=daily
    quiet_from=$((10#${BASH_REMATCH[1]} * 60 + 10#${BASH_REMATCH[2]}))
    quiet_until=$((10#${BASH_REMATCH[3]} * 60 + 10#${BASH_REMATCH[4]}))
    rest=${BASH_REMATCH[5]}
    ((quiet_from != quiet_until)) || return 1
  elif [[ $1 =~ $dated ]]; then
    quiet_kind=dated quiet_from=${BASH_REMATCH[1]} quiet_until=${BASH_REMATCH[2]} rest=${BASH_REMATCH[3]}
    if ! { quiet_valid_stamp "$quiet_from" && quiet_valid_stamp "$quiet_until" && [[ $quiet_from < $quiet_until ]]; }; then
      return 1
    fi
  else
    return 1
  fi
  quiet_lanes=host,vm
  [[ $rest == lanes=* ]] || return 0
  # A lanes token naming anything else, or followed by no why, makes the line malformed.
  [[ $rest =~ ^lanes=(host|vm|host,vm)[[:blank:]]+[^[:space:]] ]] || return 1
  quiet_lanes=${BASH_REMATCH[1]}
}
quiet_read() {
  local file=$HOME/.local/state/ci-quiet line time current instant='' quiet_kind quiet_from quiet_until quiet_lanes window
  quiet_windows='' quiet_host='' quiet_vm='' quiet_invalid=''
  [[ -f $file ]] || return 0
  time=$(date -u +%H:%M) || return 0
  current=$((10#${time%:*} * 60 + 10#${time#*:}))
  while IFS= read -r line || [[ -n $line ]]; do
    [[ ! $line =~ ^[[:blank:]]*(#|$) ]] || continue
    if ! quiet_parse "$line"; then
      quiet_invalid="${quiet_invalid:+$quiet_invalid$'\n'}$line"
      continue
    fi
    if [[ $quiet_kind == daily ]]; then
      (( (quiet_from < quiet_until && current >= quiet_from && current < quiet_until) ||
         (quiet_from > quiet_until && (current >= quiet_from || current < quiet_until)) )) || continue
    else
      [[ -n $instant ]] || instant=$(date -u +%Y-%m-%dT%H:%MZ)
      [[ -n $instant && ! $instant < $quiet_from && $instant < $quiet_until ]] || continue
    fi
    window="quiet window $line"
    quiet_windows="${quiet_windows:+$quiet_windows; }$window"
    [[ $quiet_lanes != *host* ]] || quiet_host="${quiet_host:+$quiet_host; }$window"
    [[ $quiet_lanes != *vm* ]] || quiet_vm="${quiet_vm:+$quiet_vm; }$window"
  done <"$file"
}
# One line per well-formed declaration, whatever the time: <kind> TAB <from> TAB <until> TAB <lanes> TAB <line>, in
# quiet_parse's terms. Malformed lines are quiet_read's to report.
quiet_list() {
  local file=$HOME/.local/state/ci-quiet line quiet_kind quiet_from quiet_until quiet_lanes
  [[ -f $file ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    [[ ! $line =~ ^[[:blank:]]*(#|$) ]] || continue
    if quiet_parse "$line"; then
      printf '%s\t%s\t%s\t%s\t%s\n' "$quiet_kind" "$quiet_from" "$quiet_until" "$quiet_lanes" "$line"
    fi
  done <"$file"
}
