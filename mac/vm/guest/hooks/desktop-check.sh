#!/bin/bash
# Part of the guest's job-started hook: the clone's desktop is the one every job needs, or the job is refused at once,
# in the lane's shape (`ci-kit: … rerun`, docs/mac-lane.md), the line also written to out/refused for the launcher.
#
# - The display: at least 1600 pt wide at @2x (cursor-park --describe, as the host's posture reads it). The guest's
#   density is the host screen's at boot, and a narrower screen failed a case in the spike (Design, Display), so a wrong
#   or unreadable geometry is a refusal with its reason, never a silently different result.
# - A system dialog, in front or on screen: the host's check (dialog.sh), with no episode and no alert. A clone lives
#   for one job and holds no gh credential; a dialog a fresh clone shows is the image's, and the launcher pauses the
#   lane after two such refusals in a row.
# - Any other app in front is replaced by Terminal, as on the host.
set -uo pipefail
log_tag='guest-desktop-check'
here=$(dirname "$0")
# shellcheck source=common.sh
source "$here/common.sh"
# shellcheck source=../../../hooks/dialog.sh
source "$lane_hooks/dialog.sh"
refuse() { # <line>
  echo "$1" >&2
  log "refused: $1" >/dev/null || true
  vm_mark refused "$1" || log "could not write out/refused" >/dev/null || true
  exit 1
}

display=$(bounded 5 "$CI_KIT_CURSOR_PARK" --describe 2>/dev/null) || display=''
display=${display//$'\n'/}
if [[ $display =~ ^([0-9]+)x[0-9]+@([0-9]+([.][0-9]+)?)x$ ]]; then
  if ((BASH_REMATCH[1] < 1600)) || [[ ${BASH_REMATCH[2]} != 2 ]]; then
    refuse "ci-kit: the display of the guest $machine ($vm_fields) is $display, not at least 1600 pt wide at @2x — rerun"
  fi
else
  refuse "ci-kit: the display of the guest $machine ($vm_fields) could not be read, not at least 1600 pt wide at @2x — rerun"
fi

read_front
read_windows
[[ -z $windows_miss ]] || log "could not read the windows on screen ($windows_miss); a dialog is seen only in front"
if is_dialog; then
  dialog_source || true
  log "$seen: $source; a system dialog $dialog_held; failing the job"
  refuse "ci-kit: a system dialog ($dialog: $source) $dialog_held in the guest $machine ($vm_fields) — if every clone shows it, answer it in the image; rerun"
fi
if [[ -z $name ]]; then
  log "display=$display; could not read the frontmost app; not blocking the job"
  exit 0
fi
if is_app com.apple.Terminal Terminal; then
  log "display=$display; frontmost is $name"
  exit 0
fi
before=$name
open -a Terminal || refuse "ci-kit: could not open Terminal in the guest $machine ($vm_fields; $before is in front) — rerun"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  read_front
  is_app com.apple.Terminal Terminal && break
  sleep 0.5
done
log "display=$display; frontmost before=$before after=${name:-unreadable}"
if [[ -z $name ]]; then
  log "could not read the frontmost app after opening Terminal; not blocking the job"
elif ! is_app com.apple.Terminal Terminal; then
  refuse "ci-kit: Terminal did not come to the front in the guest $machine ($vm_fields; $name is) — rerun"
fi
