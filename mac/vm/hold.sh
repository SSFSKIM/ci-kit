#!/bin/bash
# The coordinator's holds on the VM lane (docs/mac-lane.md, the VM lane, "Holds have owners"), run from the installed
# kit: `ssh <mac> '~/ci-kit-vm/kit/vm/hold.sh …'`.
#
#   hold.sh hold <owner> timed|maintenance   write vm-hold.<owner> ("<kind> since <time>"), then the wait below
#   hold.sh wait                             until no reservation stands and no maws-vm-* VM runs: prints `no guest`
#   hold.sh release <owner>                  remove vm-hold.<owner>, that owner's alone: another's hold stays
#
# A hold is written and removed under desktop.lock, the lock the launcher's boot holds from its read of the holds
# through its reservation's write. So a hold is either read by a boot, which then boots nothing, or written after that
# boot's reservation, which the wait then sees: never reported clear with a guest coming. The wait's first read is made
# under the same lock as the write.
#
# owner names the booking session: [A-Za-z0-9][A-Za-z0-9._-]*, so it is a file name and nothing else, whatever shell
# it passes through. The wait polls every CI_KIT_VM_TICK s (5) for at most CI_KIT_VM_HOLD_WAIT s (3600: a guest's
# running bound of 50 min, and its boot, kickoff and teardown). Exit 0: no guest. 1: past the bound a guest is still
# there (what stands is printed; the hold stays, so none comes after it). 2: usage. 3: the lock or the hold's file
# could not be taken or written (nothing changed). Tests move CI_KIT_TART; Bash 3.2: macOS's own.
set -uo pipefail
log_tag='vm-hold' # dialog.sh's log names its lines so
here=$(cd "$(dirname "$0")" && pwd) || exit 3
hooks=$here/../hooks
# shellcheck source=../hooks/dialog.sh
source "$hooks/dialog.sh"
# shellcheck source=../hooks/desktop-lock.sh
source "$hooks/desktop-lock.sh"
# shellcheck source=tart.sh
source "$here/tart.sh"
# A non-interactive ssh's PATH may lack Homebrew's, where Tart is.
PATH=$PATH:/opt/homebrew/bin:/usr/local/bin

reserved_file=$ci_kit_logs/vm-reserved
whole() { # <value> <default>
  if [[ $1 =~ ^[0-9]+$ ]]; then printf '%s\n' "$((10#$1))"; else printf '%s\n' "$2"; fi
}
tick=${CI_KIT_VM_TICK:-5}
wait_bound=$(whole "${CI_KIT_VM_HOLD_WAIT:-}" 3600)
say() {
  printf 'ci-kit vm hold: %s\n' "$*"
  log "$*" >/dev/null 2>&1 || true
}
usage() {
  sed -n '/^#   hold.sh/s/^# \{0,1\}//p' "$0" >&2
  exit 2
}
owner_ok() { # <owner>
  [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { say "refused: the owner '$1' is not a name ([A-Za-z0-9][A-Za-z0-9._-]*)"; exit 2; }
}

# Whether the lane has no guest: no reservation, and Tart lists no maws-vm-* VM but stopped ones. Anything that cannot
# be read is a guest that may be there. g_why says what stands.
no_guest() {
  local vms running
  perl -e 'exit 0 if lstat $ARGV[0]; exit 1 if $!{ENOENT}; exit 2' "$reserved_file"
  case $? in
    0) g_why="a reservation stands ($(head -1 "$reserved_file" 2>/dev/null || echo unreadable))"; return 1 ;;
    1) ;;
    *) g_why="whether a reservation stands cannot be read ($reserved_file)"; return 1 ;;
  esac
  if ! vms=$(tart_vms); then
    g_why="Tart cannot list its VMs ($tart_bin list failed)"
    return 1
  fi
  running=$(awk -F'\t' '$1 ~ /^maws-vm-/ && $2 != "stopped" { print $1 }' <<<"$vms" | tr '\n' ' ')
  if [[ -n $running ]]; then
    g_why="a maws-vm-* VM runs (${running% })"
    return 1
  fi
  g_why=''
}
wait_clear() { # [<first read's answer, 0 or 1>]
  local deadline=$((SECONDS + wait_bound)) said=''
  if [[ ${1:-1} == 0 ]] || no_guest; then
    say 'no guest'
    return 0
  fi
  while :; do
    [[ $g_why == "$said" ]] || { say "waiting: $g_why"; said=$g_why; }
    if ((SECONDS >= deadline)); then
      say "not clear after $wait_bound s: $g_why; the hold stays"
      return 1
    fi
    sleep "$tick"
    if no_guest; then
      say 'no guest'
      return 0
    fi
  done
}

case ${1:-} in
  hold)
    [[ $# == 3 ]] || usage
    owner_ok "$2"
    [[ $3 == timed || $3 == maintenance ]] || usage
    file=$ci_kit_logs/vm-hold.$2
    lock 120 || { say "the desktop lock stayed taken for 120 s; nothing written"; exit 3; }
    if ! printf '%s since %s\n' "$3" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$file.tmp" 2>/dev/null ||
      ! mv -f "$file.tmp" "$file" 2>/dev/null; then
      rm -f "$file.tmp" 2>/dev/null
      unlock
      say "$file could not be written; nothing held"
      exit 3
    fi
    no_guest
    first=$?
    unlock
    say "held: $file ($3)"
    wait_clear "$first"
    ;;
  wait)
    [[ $# == 1 ]] || usage
    wait_clear
    ;;
  release)
    [[ $# == 2 ]] || usage
    owner_ok "$2"
    file=$ci_kit_logs/vm-hold.$2
    lock 120 || { say "the desktop lock stayed taken for 120 s; nothing removed"; exit 3; }
    if [[ ! -e $file ]]; then
      unlock
      say "no hold of $2 ($file)"
      exit 0
    fi
    if ! rm -f "$file" 2>/dev/null; then
      unlock
      say "$file could not be removed; the hold stays"
      exit 3
    fi
    unlock
    say "released: $file"
    ;;
  *) usage ;;
esac
