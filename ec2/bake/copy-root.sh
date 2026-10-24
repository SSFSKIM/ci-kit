#!/bin/bash
# Copy a frozen ext4 partition by its allocation bitmap, not by walking linked inodes.
set -euo pipefail
export LC_ALL=C
source=$1 target=$2 source_mount=$3
work=$(mktemp -d /run/ci-kit-copy.XXXXXX)
loop='' frozen=0 mounted=0
cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [ "$frozen" = 1 ]; then fsfreeze -u "$source_mount" || status=1; fi
  if [ "$mounted" = 1 ]; then umount "$work/root" || status=1; fi
  if [ -n "$loop" ]; then losetup --detach "$loop" || status=1; fi
  rm -f "$work/partclone.log"
  rmdir "$work/root" "$work" || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM INT
mkdir "$work/root"
# Partclone rejects a mounted source. A read-only alias of the frozen device avoids that guard
# without --force, which also suppresses genuine bitmap and I/O errors. Set it up before freezing.
loop=$(losetup --find --show --read-only "$source")
sync
frozen=1
fsfreeze -f "$source_mount"
# /run is tmpfs: the default logfile on root would deadlock. Bound the copy so failure can thaw root.
timeout --kill-after=10s 8m partclone.ext4 --dev-to-dev --ignore_fschk --quiet \
  --logfile "$work/partclone.log" --source "$loop" --output "$target"
fsfreeze -u "$source_mount"
frozen=0
losetup --detach "$loop"
loop=
# A frozen, still-mounted source can contain valid open-but-unlinked inodes. Mount only this
# destination for the kernel's normal journal/orphan recovery, not a general fsck repair pass.
mount -t ext4 -o rw "$target" "$work/root"
mounted=1
umount "$work/root"
mounted=0
e2fsck -fn "$target"
