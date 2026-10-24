#!/bin/bash
# Sourced by kickoff.sh, wrapper.sh, the guest's hooks and the bake's provision.sh: where a clone of the VM lane finds
# what the host shows it, and how it writes back. The out/ protocol itself is written down once, in wrapper.sh's header.
#
# The launcher gives each clone four Tart directory shares (virtio-fs), mounted in the guest under
# /Volumes/My Shared Files/<name>: kit (this kit, read-only; the image's symlink ~/ci-kit reaches it, so the runner's
# .env names hook paths without a space), jit (this clone's JIT config, read-only), out (what the guest
# writes back) and cache (MAWS's e2e build cache), both read-write. CI_KIT_VM_SHARES and CI_KIT_VM_RUNNER move the roots
# for tests.
# shellcheck disable=SC2034 # a library: its callers read these
vm_shares=${CI_KIT_VM_SHARES:-/Volumes/My Shared Files}
vm_out=$vm_shares/out
vm_jit=$vm_shares/jit/config
vm_cache=$vm_shares/cache
vm_runner=${CI_KIT_VM_RUNNER:-$HOME/actions-runner-maws}
# Runner identity files, removed from baked images and written by the JIT listener with umask 077.
vm_identity_files='.runner .credentials .credentials_rsaparams'
# Every marker of the protocol: a clone is handed an out/ holding none of them.
vm_markers='listening session-conflict assigned job refused stop-request stop-refused stop-raced stopped done unfit'
# The guest's own hooks log, as dialog.sh writes it; wrapper.sh copies it to out/ at the end.
vm_hooks_log=$HOME/Library/Logs/ci-kit/mac-runner-hooks.log

# The guest's display mode, the mini's own geometry at @2x. `tart set --display 2560x1440pt` does not reach it (V1: a
# clone booted at 1024x768, scale 2); displayplacer sets it in the image (provision.sh display), every clone keeps it,
# and the wrapper refuses a clone without it. CI_KIT_VM_DISPLAYPLACER moves the tool for tests.
vm_display_res=2560x1440
vm_displayplacer=${CI_KIT_VM_DISPLAYPLACER:-/opt/homebrew/bin/displayplacer}
# The main display's mode from `displayplacer list` (at most 10 s): dp_id (its persistent screen id), dp_res and
# dp_scaling (on or off); false when it cannot be read.
vm_display() {
  local mode
  dp_id='' dp_res='' dp_scaling=''
  mode=$(perl -e 'alarm shift; exec { $ARGV[0] } @ARGV' 10 "$vm_displayplacer" list 2>/dev/null | awk '
    /^Persistent screen id: / { id = $4; res = ""; scaling = "" }
    /^Resolution: / { res = $2 }
    /^Scaling: / { scaling = $2 }
    /^Origin: .* - main display/ && !found { found = id " " res " " scaling }
    END { print found }') || return 1
  read -r dp_id dp_res dp_scaling <<<"$mode"
  [[ -n $dp_id && -n $dp_res && -n $dp_scaling ]]
}
# Whether that mode is the lane's.
vm_display_right() {
  [[ $dp_res == "$vm_display_res" && $dp_scaling == on ]]
}

vm_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}
# out/<name>, replaced whole by a rename, so the launcher never reads half a marker.
vm_mark() { # <name> <contents>
  printf '%s\n' "$2" >"$vm_out/.$1.tmp" 2>/dev/null && mv -f "$vm_out/.$1.tmp" "$vm_out/$1" 2>/dev/null
}
