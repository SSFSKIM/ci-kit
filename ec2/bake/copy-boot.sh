#!/bin/bash
# Copy an unmounted boot filesystem by allocation bitmap, then independently verify its files.
set -euo pipefail
export LC_ALL=C
kind=$1 source=$2 target=$3
case "$kind" in
  vfat) copier=partclone.fat; options=ro ;;
  ext4) copier=partclone.ext4; options=ro,noload ;;
  *) echo "compact: unsupported boot filesystem $kind" >&2; exit 1 ;;
esac
phase=boot-copy
. "${BASH_SOURCE[0]%/*}/compact-state.sh"
work=$(mktemp -d /run/ci-kit-boot.XXXXXX)
loop='' source_mounted=0 target_mounted=0
cleanup() {
  local status=$? cleanup_status=0
  trap - EXIT
  set +e
  # Record before cleanup so its errors cannot hide the original helper failure.
  compact_record_failure "$status"
  compact_record_log
  if [ "$source_mounted" = 1 ]; then umount "$work/source" || cleanup_status=1; fi
  if [ "$target_mounted" = 1 ]; then umount "$work/target" || cleanup_status=1; fi
  if [ -n "$loop" ]; then losetup --detach "$loop" || cleanup_status=1; fi
  rm -f "$work/partclone.log" "$work/source.sha256" "$work/target.sha256"
  rmdir "$work/source" "$work/target" "$work" || cleanup_status=1
  if [ "$status" = 0 ] && [ "$cleanup_status" != 0 ]; then status=1; fi
  compact_record_failure "$status"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM INT
mkdir "$work/source" "$work/target"
[ -z "$(lsblk -nrpo MOUNTPOINT "$source" | tr -d '[:space:]')" ]
# Even after unmount, old raw-device cache need not reflect recent filesystem writes.
loop=$(losetup --find --show --read-only --direct-io=on "$source")
[ "$(losetup --noheadings --raw --output DIO "$loop")" = 1 ] || {
  echo 'compact: boot loop backing direct I/O unavailable' >&2; exit 1;
}
check() {
  if [ "$kind" = ext4 ]; then timeout --kill-after=10s 5m e2fsck -fn "$1";
  else timeout --kill-after=10s 5m fsck.fat -n "$1"; fi
}
inventory() {
  # Hash every regular file independently; no journal replay or filesystem repair on either side.
  # shellcheck disable=SC2016
  timeout --kill-after=10s 5m bash -c '
    set -euo pipefail
    cd "$1"
    find . -xdev -type f -exec sha256sum -- {} + | sort -T "$2"
  ' inventory "$1" "$work" > "$2"
}
check "$loop"
mount -t "$kind" -o "$options" "$loop" "$work/source"
source_mounted=1
inventory "$work/source" "$work/source.sha256"
umount "$work/source"
source_mounted=0
# Unwritten EBS bytes may be pseudorandom: write every allocated block, including all-zero data.
compact_log=$work/partclone.log
timeout --kill-after=10s 8m "$copier" --dev-to-dev --quiet \
  --logfile "$work/partclone.log" --source "$loop" --output "$target"
compact_log=
sync
check "$target"
mount -t "$kind" -o "$options" "$target" "$work/target"
target_mounted=1
inventory "$work/target" "$work/target.sha256"
umount "$work/target"
target_mounted=0
cmp -s "$work/source.sha256" "$work/target.sha256" || {
  echo "compact: $kind boot content inventory differs" >&2; exit 1;
}
echo "compact: $kind boot filesystem and complete file inventory verified"
