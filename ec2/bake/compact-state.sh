#!/bin/bash
# Optional tmpfs handoff shared by compact.sh and copy-root.sh. Only shell builtins run while frozen.
compact_record_failure() {
  if [ "$1" -ne 0 ] && [ -n "${CI_KIT_COMPACT_DIAGNOSTIC:-}" ] && [ ! -e "$CI_KIT_COMPACT_DIAGNOSTIC" ]; then
    printf '{"reason":"compact-failed","phase":"%s","exit_status":%s}\n' "$phase" "$1" > "$CI_KIT_COMPACT_DIAGNOSTIC" || true
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
