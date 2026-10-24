#!/bin/bash
# Copy a frozen ext4 partition by its allocation bitmap, not by walking linked inodes.
set -euo pipefail
export LC_ALL=C
source=$1 target=$2 source_mount=$3
work=$(mktemp -d /run/ci-kit-copy.XXXXXX)
loop='' frozen=0 mounted=0 source_mounted=0
cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [ "$frozen" = 1 ]; then fsfreeze -u "$source_mount" || status=1; fi
  if [ "$mounted" = 1 ]; then umount "$work/root" || status=1; fi
  if [ "$source_mounted" = 1 ]; then umount "$work/source" || status=1; fi
  if [ -n "$loop" ]; then losetup --detach "$loop" || status=1; fi
  rm -f "$work/partclone.log" "$work/source.sha256" "$work/target.sha256"
  rmdir "$work/root" "$work/source" "$work" || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM INT
mkdir "$work/root" "$work/source"
# A non-recursive view exposes root files hidden by /run, /dev, etc., without foreign submounts.
mount --bind "$source_mount" "$work/source"
source_mounted=1
mount -o remount,bind,ro "$work/source"
inventory() {
  local root=$1 output=$2 label=$3 started=$SECONDS
  # Keep the whole pipeline in the timeout's process group; expand its parameters in the child.
  # shellcheck disable=SC2016
  timeout --kill-after=10s 3m bash -c '
    set -euo pipefail
    cd "$1"
    find . -xdev -type f -exec sha256sum -- {} + | sort -T "$2"
  ' inventory "$root" "$work" > "$output"
  echo "compact: $label content inventory $(wc -l < "$output") files in $((SECONDS-started))s"
}
# Partclone rejects a mounted source. A read-only alias avoids that guard without --force, which
# also suppresses genuine bitmap/I/O errors. Direct backing I/O is essential: filesystem fsync/freeze
# does not invalidate stale raw block-device cache, even if partclone itself uses direct reads.
loop=$(losetup --find --show --read-only --direct-io=on "$source")
[ "$(losetup --noheadings --raw --output DIO "$loop")" = 1 ] || {
  echo 'compact: loop backing direct I/O unavailable' >&2; exit 1;
}
sync
frozen=1
fsfreeze -f "$source_mount"
# Capture every regular file at the same frozen point as the block copy, including caches/layers.
inventory "$work/source" "$work/source.sha256" source
# /run is tmpfs: the default logfile on root would deadlock. Bound the copy so failure can thaw root.
timeout --kill-after=10s 8m partclone.ext4 --dev-to-dev --ignore_fschk --quiet \
  --logfile "$work/partclone.log" --source "$loop" --output "$target"
fsfreeze -u "$source_mount"
frozen=0
umount "$work/source"
source_mounted=0
losetup --detach "$loop"
loop=
# A frozen, still-mounted source can contain valid open-but-unlinked inodes. Mount only this
# destination for the kernel's normal journal/orphan recovery, not a general fsck repair pass.
mount -t ext4 -o rw "$target" "$work/root"
mounted=1
umount "$work/root"
mounted=0
mount -t ext4 -o ro "$target" "$work/root"
mounted=1
inventory "$work/root" "$work/target.sha256" target
umount "$work/root"
mounted=0
cmp -s "$work/source.sha256" "$work/target.sha256" || {
  echo 'compact: content inventory differs' >&2; exit 1;
}
e2fsck -fn "$target"
