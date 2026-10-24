#!/bin/bash
# EBS has no discard support. Copy bitmap-allocated filesystem blocks; do not zero free space.
# Unwritten EBS bytes may be pseudorandom: only bitmap-free blocks may be skipped, never allocated zeros.
# The builder supplies exactly two equal-sized disks. The destination becomes the AMI's only root disk.
set -euo pipefail
export LC_ALL=C
phase=disk-validation
phase_started=$SECONDS compact_started=$SECONDS
bake_dir=${BASH_SOURCE[0]%/*}
. "$bake_dir/compact-state.sh"
finish() {
  local status=$?
  trap - EXIT
  # The child records first; preserve its more specific failure and phase timings.
  compact_record_failure "$status"
  compact_record_phase "$status"
  phase=compact phase_started=$compact_started
  compact_record_phase "$status"
  exit "$status"
}
trap finish EXIT
trap 'exit 143' TERM
root=$(readlink -f "$(findmnt -nro SOURCE /)")
source=/dev/$(lsblk -nro PKNAME "$root")
read -r target extra <<< "$(lsblk -dnpro NAME,TYPE | awk -v source="$source" '$2 == "disk" && $1 != source {printf "%s ", $1}')"
[ -n "$target" ] && [ -z "$extra" ] || { echo 'compact: expected one destination disk' >&2; exit 1; }
[ "$root" = "${source}p1" ] && [ "$(findmnt -nro FSTYPE /)" = ext4 ]
[ "$(blockdev --getsize64 "$source")" = "$(blockdev --getsize64 "$target")" ]
[ -z "$(wipefs --noheadings --output TYPE "$target")" ]
[ -z "$(lsblk -nrpo MOUNTPOINT "$target" | tr -d '[:space:]')" ]

compact_phase boot-copy
systemctl stop docker.service docker.socket containerd.service
umount /boot/efi
umount /boot
# Replication writes both GPT headers, including the backup at the disk's end, and preserves partition UUIDs.
sgdisk --replicate="$target" "$source"
blockdev --rereadpt "$target"
udevadm settle
# Preserve the legacy boot code too, without overwriting the replicated GPT's protective MBR partition table.
dd if="$source" of="$target" bs=446 count=1 conv=notrunc status=none
dd if="${source}p14" of="${target}p14" bs=4M conv=fsync status=none
bash "$bake_dir/copy-boot.sh" vfat "${source}p15" "${target}p15"
bash "$bake_dir/copy-boot.sh" ext4 "${source}p16" "${target}p16"

compact_phase copy-root-setup
bash "$bake_dir/copy-root.sh" "$root" "${target}p1" /
# copy-root.sh owns the nested phases; do not time the whole helper again as setup.
phase=disk-verification phase_started=$SECONDS
sync
sgdisk -v "$target"
echo 'compact: partition table and copied root verified'
