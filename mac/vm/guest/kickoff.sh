#!/bin/bash
# The VM lane's kickoff (docs/mac-lane.md, the VM lane): the launcher runs it in a freshly booted job clone, through
# `tart exec <clone> /Users/admin/ci-kit/vm/guest/kickoff.sh <slot> <clone>`, which is gRPC to the Tart guest agent and
# never the guest's address. It makes the clone the slot's runner for one job and returns:
#
# - the slot's identity (.runner, .credentials, .credentials_rsaparams, from the read-only identity share) is copied
#   into the runner's directory: the image holds none, so a clone is no runner until this;
# - the runner's _diag is emptied, so every diag log the wrapper reads is this clone's (a registration run in the image
#   leaves one);
# - MAWS's e2e build cache, ~/Library/Caches/maws-e2e-build, becomes a link to the cache share, so a build made in one
#   clone serves the next at the same sha;
# - wrapper.sh starts, in a session of its own with its output in out/wrapper.log, and runs the runner (`run.sh --once`)
#   under it. Nothing of it holds the exec's output or its process group, so the exec returns at once and its end
#   reaches nothing. Started by the guest agent, the runner inherits the image's TCC rows for it (Design, "Why the
#   runner is started by tart exec").
#
# It refuses, starting nothing, when out/ already holds a marker (the launcher hands every clone an empty one, and a
# stale marker would be read as this clone's), when a share or the runner is missing, or when the identity is
# incomplete. Its last line names the wrapper's pid.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd) || exit 1
# shellcheck source=guest.sh
source "$here/guest.sh"
fail() {
  echo "kickoff: $*" >&2
  exit 1
}
slot=${1:-} clone=${2:-}
[[ $slot =~ ^[a-z0-9][a-z0-9-]*$ && $clone =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail 'usage: kickoff.sh <slot> <clone>'
[[ -d $vm_out && -w $vm_out ]] || fail "out/ is not shown read-write at $vm_out"
for marker in $vm_markers; do
  [[ ! -e $vm_out/$marker ]] || fail "out/ already holds $marker: every clone starts from an empty out/"
done
[[ -x $vm_runner/run.sh ]] || fail "no runner at $vm_runner"
for file in $vm_identity_files; do
  [[ -f $vm_identity/$file ]] || fail "the identity share lacks $file ($vm_identity)"
done
for file in $vm_identity_files; do
  cp "$vm_identity/$file" "$vm_runner/$file" && chmod 600 "$vm_runner/$file" || fail "could not copy $file to $vm_runner"
done
rm -rf "$vm_runner/_diag" || fail "could not empty $vm_runner/_diag"
[[ -d $vm_cache ]] || fail "no cache share at $vm_cache"
link=$HOME/Library/Caches/maws-e2e-build
mkdir -p "${link%/*}" && rm -rf "$link" && ln -s "$vm_cache" "$link" || fail "could not link $link to $vm_cache"
(cd / && exec perl -MPOSIX=setsid -e 'setsid() or exit 126; exec { $ARGV[0] } @ARGV; exit 127' \
  /bin/bash "$here/wrapper.sh" "$slot" "$clone") </dev/null >>"$vm_out/wrapper.log" 2>&1 &
echo "kickoff: $slot $clone: identity copied, cache linked, wrapper $! started"
