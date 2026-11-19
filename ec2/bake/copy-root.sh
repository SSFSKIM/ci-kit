#!/bin/bash
# Copy a frozen ext4 partition by its allocation bitmap, not by walking linked inodes.
# Unwritten EBS blocks may read pseudorandom: skip only bitmap-free blocks, never allocated zeros.
set -euo pipefail
export LC_ALL=C
source=$1 target=$2 source_mount=$3
phase=copy-root-setup phase_started=$SECONDS
. "${BASH_SOURCE[0]%/*}/compact-state.sh"
work=$(mktemp -d /run/ci-kit-copy.XXXXXX)
loop='' frozen=0 mounted=0 source_mounted=0
cleanup() {
  local status=$? cleanup_status=0
  trap - EXIT
  set +e
  compact_record_failure "$status"
  compact_record_phase "$status"
  phase=copy-root-cleanup phase_started=$SECONDS
  if [ "$frozen" = 1 ]; then
    if fsfreeze -u "$source_mount"; then frozen=0; else cleanup_status=1; fi
  fi
  if [ "$frozen" = 0 ]; then compact_record_log; fi
  if [ "$mounted" = 1 ]; then umount "$work/root" || cleanup_status=1; fi
  if [ "$source_mounted" = 1 ]; then umount "$work/source" || cleanup_status=1; fi
  if [ -n "$loop" ]; then losetup --detach "$loop" || cleanup_status=1; fi
  rm -f "$work/partclone.log" "$work/partclone-retry.log" "$work/root-copy-retry.log" "$work/source.sha256" "$work/target.sha256"
  rmdir "$work/root" "$work/source" "$work" || cleanup_status=1
  if [ "$cleanup_status" -ne 0 ]; then status=1; fi
  compact_record_phase "$cleanup_status"
  compact_record_failure "$status"
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
  timeout --kill-after=10s 5m bash -c '
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
compact_phase source-inventory
inventory "$work/source" "$work/source.sha256" source
# /run is tmpfs: the default logfile on root would deadlock. Bound the copy so failure can thaw root.
copy() {
  timeout --kill-after=10s 8m partclone.ext4 --dev-to-dev --ignore_fschk --quiet \
    --logfile "$work/$1" --source "$loop" --output "$target"
}
# s_free_blocks_count_lo and _hi of the superblock at byte 1024, read in one block, never failing the copy.
superblock_free() {
  { dd if="$1" bs=4096 count=1 status=none "${@:2}" 2>/dev/null || true; } | od -An -tu4 -v -j1036 -N336 2>/dev/null |
    awk '{ for (i = 1; i <= NF; i++) w[n++] = $i } END { if (n == 84) printf "%.0f\n", w[0] + w[83] * 4294967296; else print "unreadable" }'
}
# Read-only evidence while root is frozen: shell builtins find the loop's openers; output goes only to tmpfs.
copy_evidence() {
  local fd pid comm holders=''
  for fd in /proc/[0-9]*/fd/*; do
    [ "$fd" -ef "$loop" ] || continue
    pid=${fd#/proc/} comm=unknown
    pid=${pid%%/*}
    read -r comm < "/proc/$pid/comm" || true
    holders+=" $pid($comm)"
  done
  for fd in "/sys/block/${loop##*/}/holders/"*; do [ ! -e "$fd" ] || holders+=" kernel:${fd##*/}"; done
  echo "compact: $1: loop $loop dio=$(losetup --noheadings --raw --output DIO "$loop" || echo unknown);" \
    "superblock free blocks: loop $(superblock_free "$loop"), loop direct $(superblock_free "$loop" iflag=direct)," \
    "source direct $(superblock_free "$source" iflag=direct), source buffered $(superblock_free "$source");" \
    "holders:${holders:- none}"
}
compact_phase root-copy
compact_log=$work/partclone.log
copy_status=0
copy partclone.log || copy_status=$?
# On 2026-11-19 partclone refused three frozen roots of six: every group matched its bitmap, but the superblock's free
# count was the one from before the freeze (ext4 rewrites it only at commit_super, which the freeze runs), read through
# this alias. Why is not known. The refusal comes while partclone computes its bitmap, before it writes the target, so
# a second attempt after dropping the alias's cached blocks starts clean; the inventories and e2fsck still judge it.
# The evidence goes to the failure tail, or to the report's root_copy_retry when the second attempt passes.
if [ "$copy_status" -ne 0 ] && [ "$copy_status" -ne 124 ] && grep -qs 'bitmap free count err' "$work/partclone.log"; then
  compact_record_phase "$copy_status"
  phase=root-copy-retry phase_started=$SECONDS
  compact_log=$work/root-copy-retry.log
  {
    echo "compact: root-copy attempt 1 exit $copy_status: $(grep -m1 'bitmap free count err' "$work/partclone.log")"
    echo "compact: kernel $(uname -r)"
    copy_evidence 'before flush'
  } > "$compact_log"
  blockdev --flushbufs "$loop"
  copy_evidence 'after flush' >> "$compact_log"
  copy_status=0
  copy partclone-retry.log || copy_status=$?
  if [ "$copy_status" -ne 0 ]; then
    # The last lines carry partclone's own error; the 40-line tail must keep the evidence above them too.
    awk '{ l[NR % 20] = $0 } END { for (i = NR - 19; i <= NR; i++) if (i > 0) print l[i % 20] }' \
      "$work/partclone-retry.log" >> "$compact_log" || true
  fi
  echo "compact: root-copy attempt 2 exit $copy_status" >> "$compact_log"
  if [ "$copy_status" -eq 0 ] && [ -n "${CI_KIT_COMPACT_RETRY:-}" ]; then cat "$compact_log" > "$CI_KIT_COMPACT_RETRY" || true; fi
fi
[ "$copy_status" -eq 0 ] || exit "$copy_status"
compact_log=
compact_phase root-recovery
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
compact_phase target-inventory
inventory "$work/root" "$work/target.sha256" target
compact_phase root-comparison
umount "$work/root"
mounted=0
cmp -s "$work/source.sha256" "$work/target.sha256" || {
  echo 'compact: content inventory differs' >&2; exit 1;
}
compact_phase root-fsck
e2fsck -fn "$target"
