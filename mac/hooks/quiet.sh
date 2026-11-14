#!/bin/bash
# UTC quiet windows, daily or dated, shared by the drain, VM launcher, local heavy-work launchers and the lane publisher.
# Sourcing this file does no work. quiet_read sets quiet_windows (active declarations, joined by "; ") and
# quiet_invalid (malformed lines). The watcher logs malformed lines; the other readers only decide admission.
# quiet_list prints every well-formed declaration, active or not, so the publisher can announce one before it starts.
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
quiet_parse() {
  local pattern='^([01][0-9]|2[0-3]):([0-5][0-9])Z[[:blank:]]+([01][0-9]|2[0-3]):([0-5][0-9])Z[[:blank:]]+([^[:space:]].*)$'
  local dated='^([0-9-]+T[0-9:]+Z)[[:blank:]]+([0-9-]+T[0-9:]+Z)[[:blank:]]+([^[:space:]].*)$'
  if [[ $1 =~ $pattern ]]; then
    quiet_kind=daily
    quiet_from=$((10#${BASH_REMATCH[1]} * 60 + 10#${BASH_REMATCH[2]}))
    quiet_until=$((10#${BASH_REMATCH[3]} * 60 + 10#${BASH_REMATCH[4]}))
    ((quiet_from != quiet_until))
  elif [[ $1 =~ $dated ]]; then
    quiet_kind=dated quiet_from=${BASH_REMATCH[1]} quiet_until=${BASH_REMATCH[2]}
    quiet_valid_stamp "$quiet_from" && quiet_valid_stamp "$quiet_until" && [[ $quiet_from < $quiet_until ]]
  else
    return 1
  fi
}
quiet_read() {
  local file=$HOME/.local/state/ci-quiet line time current instant='' quiet_kind quiet_from quiet_until
  quiet_windows='' quiet_invalid=''
  [[ -f $file ]] || return 0
  time=$(date -u +%H:%M) || return 0
  current=$((10#${time%:*} * 60 + 10#${time#*:}))
  while IFS= read -r line || [[ -n $line ]]; do
    [[ ! $line =~ ^[[:blank:]]*(#|$) ]] || continue
    if ! quiet_parse "$line"; then
      quiet_invalid="${quiet_invalid:+$quiet_invalid$'\n'}$line"
    elif [[ $quiet_kind == daily ]]; then
      if (( (quiet_from < quiet_until && current >= quiet_from && current < quiet_until) ||
            (quiet_from > quiet_until && (current >= quiet_from || current < quiet_until)) )); then
        quiet_windows="${quiet_windows:+$quiet_windows; }quiet window $line"
      fi
    else
      [[ -n $instant ]] || instant=$(date -u +%Y-%m-%dT%H:%MZ)
      if [[ -n $instant && ! $instant < $quiet_from && $instant < $quiet_until ]]; then
        quiet_windows="${quiet_windows:+$quiet_windows; }quiet window $line"
      fi
    fi
  done <"$file"
}
# One line per well-formed declaration, whatever the time: <kind> TAB <from> TAB <until> TAB <line>, in quiet_parse's
# terms. Malformed lines are quiet_read's to report.
quiet_list() {
  local file=$HOME/.local/state/ci-quiet line quiet_kind quiet_from quiet_until
  [[ -f $file ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    [[ ! $line =~ ^[[:blank:]]*(#|$) ]] || continue
    if quiet_parse "$line"; then printf '%s\t%s\t%s\t%s\n' "$quiet_kind" "$quiet_from" "$quiet_until" "$line"; fi
  done <"$file"
}
