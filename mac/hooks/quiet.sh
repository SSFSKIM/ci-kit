#!/bin/bash
# UTC quiet windows, daily or dated, shared by the drain, VM launcher and local heavy-work launchers.
# Sourcing this file does no work. quiet_read sets quiet_windows (active declarations, joined by "; ") and
# quiet_invalid (malformed lines). The watcher logs malformed lines; the other readers only decide admission.
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
quiet_read() {
  local file=$HOME/.local/state/ci-quiet line time current start end instant='' from until
  local pattern='^([01][0-9]|2[0-3]):([0-5][0-9])Z[[:blank:]]+([01][0-9]|2[0-3]):([0-5][0-9])Z[[:blank:]]+([^[:space:]].*)$'
  local dated='^([0-9-]+T[0-9:]+Z)[[:blank:]]+([0-9-]+T[0-9:]+Z)[[:blank:]]+([^[:space:]].*)$'
  quiet_windows='' quiet_invalid=''
  [[ -f $file ]] || return 0
  time=$(date -u +%H:%M) || return 0
  current=$((10#${time%:*} * 60 + 10#${time#*:}))
  while IFS= read -r line || [[ -n $line ]]; do
    [[ ! $line =~ ^[[:blank:]]*(#|$) ]] || continue
    if [[ $line =~ $pattern ]]; then
      start=$((10#${BASH_REMATCH[1]} * 60 + 10#${BASH_REMATCH[2]}))
      end=$((10#${BASH_REMATCH[3]} * 60 + 10#${BASH_REMATCH[4]}))
      if ((start != end)); then
        if (( (start < end && current >= start && current < end) ||
              (start > end && (current >= start || current < end)) )); then
          quiet_windows="${quiet_windows:+$quiet_windows; }quiet window $line"
        fi
        continue
      fi
    elif [[ $line =~ $dated ]]; then
      from=${BASH_REMATCH[1]} until=${BASH_REMATCH[2]}
      if quiet_valid_stamp "$from" && quiet_valid_stamp "$until" && [[ $from < $until ]]; then
        [[ -n $instant ]] || instant=$(date -u +%Y-%m-%dT%H:%MZ)
        if [[ -n $instant && ! $instant < $from && $instant < $until ]]; then
          quiet_windows="${quiet_windows:+$quiet_windows; }quiet window $line"
        fi
        continue
      fi
    fi
    quiet_invalid="${quiet_invalid:+$quiet_invalid$'\n'}$line"
  done <"$file"
}
