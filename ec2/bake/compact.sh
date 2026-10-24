#!/bin/bash
# EBS has no discard support. Copy allocated root blocks onto a never-written disk; do not zero its holes.
# The builder supplies exactly two equal-sized disks. The destination becomes the AMI's only root disk.
set -euo pipefail
export LC_ALL=C
bake_dir=${BASH_SOURCE[0]%/*}
root=$(readlink -f "$(findmnt -nro SOURCE /)")
source=/dev/$(lsblk -nro PKNAME "$root")
read -r target extra <<< "$(lsblk -dnpro NAME,TYPE | awk -v source="$source" '$2 == "disk" && $1 != source {printf "%s ", $1}')"
[ -n "$target" ] && [ -z "$extra" ] || { echo 'compact: expected one destination disk' >&2; exit 1; }
[ "$root" = "${source}p1" ] && [ "$(findmnt -nro FSTYPE /)" = ext4 ]
[ "$(blockdev --getsize64 "$source")" = "$(blockdev --getsize64 "$target")" ]
[ -z "$(wipefs --noheadings --output TYPE "$target")" ]
[ -z "$(lsblk -nrpo MOUNTPOINT "$target" | tr -d '[:space:]')" ]

systemctl stop docker.service docker.socket containerd.service
umount /boot/efi
umount /boot
# Replication writes both GPT headers, including the backup at the disk's end, and preserves partition UUIDs.
sgdisk --replicate="$target" "$source"
blockdev --rereadpt "$target"
udevadm settle
# Preserve the legacy boot code too, without overwriting the replicated GPT's protective MBR partition table.
dd if="$source" of="$target" bs=446 count=1 conv=notrunc status=none
for part in 14 15 16; do
  dd if="${source}p${part}" of="${target}p${part}" bs=4M conv=fsync status=none
done

bash "$bake_dir/copy-root.sh" "$root" "${target}p1" /
sync
sgdisk -v "$target"
echo 'compact: partition table and copied root verified'
