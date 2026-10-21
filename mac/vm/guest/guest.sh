#!/bin/bash
# Sourced by kickoff.sh, wrapper.sh and the guest's hooks: where a clone of the VM lane finds what the host shows it,
# and how it writes back. The out/ protocol itself is written down once, in wrapper.sh's header.
#
# The launcher gives each clone four Tart directory shares (virtio-fs), mounted in the guest under
# /Volumes/My Shared Files/<name>: kit (this kit, read-only; the image's symlink ~/ci-kit reaches it, so the runner's
# .env names hook paths without a space), identity (the slot's runner registration, read-only), out (what the guest
# writes back) and cache (MAWS's e2e build cache), both read-write. CI_KIT_VM_SHARES and CI_KIT_VM_RUNNER move the roots
# for tests.
# shellcheck disable=SC2034 # a library: its callers read these
vm_shares=${CI_KIT_VM_SHARES:-/Volumes/My Shared Files}
vm_out=$vm_shares/out
vm_identity=$vm_shares/identity
vm_cache=$vm_shares/cache
vm_runner=${CI_KIT_VM_RUNNER:-$HOME/actions-runner-maws}
# The runner's registration, as config.sh writes it and bake.sh --register moves it to the slot.
vm_identity_files='.runner .credentials .credentials_rsaparams'
# Every marker of the protocol: a clone is handed an out/ holding none of them.
vm_markers='listening session-conflict assigned job refused stop-request stop-refused stop-raced stopped done'
# The guest's own hooks log, as dialog.sh writes it; wrapper.sh copies it to out/ at the end.
vm_hooks_log=$HOME/Library/Logs/ci-kit/mac-runner-hooks.log

vm_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}
# out/<name>, replaced whole by a rename, so the launcher never reads half a marker.
vm_mark() { # <name> <contents>
  printf '%s\n' "$2" >"$vm_out/.$1.tmp" 2>/dev/null && mv -f "$vm_out/.$1.tmp" "$vm_out/$1" 2>/dev/null
}
