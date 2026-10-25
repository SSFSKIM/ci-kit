#!/bin/bash
# Optional tmpfs handoff shared by compact.sh and copy-root.sh. Only shell builtins run while frozen.
compact_record_failure() {
  if [ "$1" -ne 0 ] && [ -n "${CI_KIT_COMPACT_DIAGNOSTIC:-}" ] && [ ! -e "$CI_KIT_COMPACT_DIAGNOSTIC" ]; then
    if printf '{"reason":"compact-failed","phase":"%s","exit_status":%s}\n' "$phase" "$1" > "$CI_KIT_COMPACT_DIAGNOSTIC"; then
      compact_failed_log=${compact_log:-}
    fi
  fi
}
# Called only after thaw, before the tool's tmpfs work directory is removed. Only the shell
# that recorded the first failure owns its log; outer cleanup must not replace it.
compact_record_log() {
  if [ -n "${compact_failed_log:-}" ] && [ -f "$compact_failed_log" ]; then
    local bytes
    bytes=$(wc -c < "$compact_failed_log") || return 0
    if [ "$bytes" -gt 8192 ]; then
      # Include the preceding byte, then drop the partial first line so only whole
      # diagnostic lines survive the byte limit. Oversized lines are omitted.
      tail -c 8193 "$compact_failed_log" | sed '1d' | tail -n 40
    else
      tail -n 40 "$compact_failed_log"
    fi > "$CI_KIT_COMPACT_DIAGNOSTIC.log" || true
  fi
}
compact_record_phase() {
  if [ -n "${CI_KIT_COMPACT_TRACE:-}" ]; then
    printf '%s %s %s\n' "$phase" "$((SECONDS-phase_started))" "$1" >> "$CI_KIT_COMPACT_TRACE" || true
  fi
}
compact_phase() {
  compact_record_phase 0
  phase=$1
  phase_started=$SECONDS
}
