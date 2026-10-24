#!/bin/bash
# EBS has no discard support. Copy allocated root blocks onto a never-written disk; do not zero its holes.
# The builder supplies exactly two equal-sized disks. The destination becomes the AMI's only root disk.
set -euo pipefail
export LC_ALL=C
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

# Keep the frozen interval free of writes to root (including journal output). /run is tmpfs.
# e2image -a includes file data; -r seeks over unallocated blocks; -f permits the frozen mounted source.
frozen=0
thaw() { if [ "$frozen" = 1 ]; then fsfreeze -u /; fi; }
trap thaw EXIT
trap 'exit 143' TERM INT
sync
frozen=1
fsfreeze -f /
e2image -ra -f "$root" "${target}p1"
fsfreeze -u /
frozen=0
sync
sgdisk -v "$target"
e2fsck -fn "${target}p1"
echo 'compact: partition table and copied root verified'
