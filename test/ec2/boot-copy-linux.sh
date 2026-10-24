#!/bin/bash
# Destructive only to disposable loop images. Needs Linux root, partclone, dosfstools and e2fsprogs.
set -euo pipefail
export LC_ALL=C
copy=$(readlink -f "${1:?copy-boot.sh path required}")
work=$(mktemp -d /run/ci-kit-boot-test.XXXXXX)
source='' target=''
cleanup() {
  set +e
  umount "$work/source" 2>/dev/null
  umount "$work/target" 2>/dev/null
  for loop in "$source" "$target"; do [ -z "$loop" ] || losetup --detach "$loop"; done
  rm -rf "$work"
}
trap cleanup EXIT
mkdir "$work/source" "$work/target"
for kind in vfat ext4; do
  truncate -s 64M "$work/source.img"
  python3 -I - "$work/target.img" <<'PY'
import sys
with open(sys.argv[1], 'wb') as f:
    for _ in range(64):
        f.write(b'\xa5' * 2**20)
PY
  source=$(losetup --find --show "$work/source.img")
  target=$(losetup --find --show "$work/target.img")
  if [ "$kind" = ext4 ]; then
    mkfs.ext4 -q -F -b 4096 -E lazy_itable_init=0,lazy_journal_init=0 "$source"
  else
    mkfs.fat -F 32 "$source"
  fi
  mount "$source" "$work/source"
  python3 -I - "$work/source" <<'PY'
import os, sys
root = sys.argv[1]
os.mkdir(root + '/nested')
for name, data in [('ZERO.BIN', b'\0' * 2**20), ('nested/kernel with spaces', bytes(range(256)) * 8192), ('empty', b'')]:
    with open(root + '/' + name, 'wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
PY
  sync
  umount "$work/source"
  uuid=$(blkid -s UUID -o value "$source")
  if [ "$kind" = ext4 ]; then
    zero_block=$(debugfs -R 'bmap /ZERO.BIN 0' "$source" 2>/dev/null)
    free_block=$(debugfs -R 'find_free_block' "$source" 2>/dev/null | grep -o '[0-9][0-9]*' | head -1)
    debugfs -R "testb $free_block" "$source" 2>&1 | grep -q 'not in use'
    zero_offset=$((zero_block * 4096)) free_offset=$((free_block * 4096)) block_bytes=4096
  else
    # Independently locate ZERO.BIN's allocated first cluster and a bitmap-free FAT32 cluster.
    read -r zero_offset free_offset block_bytes < <(python3 -I - "$source" <<'PY'
import struct, sys
with open(sys.argv[1], 'rb', buffering=0) as f:
    boot = f.read(512)
    u16 = lambda n: struct.unpack_from('<H', boot, n)[0]
    u32 = lambda n: struct.unpack_from('<I', boot, n)[0]
    sector, cluster = u16(11), boot[13]
    reserved, fats, fat_size, root = u16(14), boot[16], u32(36), u32(44)
    data = (reserved + fats * fat_size) * sector
    cluster_bytes = sector * cluster
    f.seek(reserved * sector)
    fat = f.read(fat_size * sector)
    f.seek(data + (root - 2) * cluster_bytes)
    directory = f.read(cluster_bytes)
    entry = next(directory[i:i+32] for i in range(0, len(directory), 32) if directory[i:i+11] == b'ZERO    BIN')
    zero = (struct.unpack_from('<H', entry, 20)[0] << 16) | struct.unpack_from('<H', entry, 26)[0]
    assert struct.unpack_from('<I', fat, zero * 4)[0] & 0xfffffff, 'zero file must be allocated'
    clusters = (u32(32) * sector - data) // cluster_bytes
    free = next(c for c in range(2, clusters + 2) if struct.unpack_from('<I', fat, c * 4)[0] & 0xfffffff == 0)
    print(data + (zero - 2) * cluster_bytes, data + (free - 2) * cluster_bytes, cluster_bytes)
PY
)
  fi
  # Direct reads independently establish the allocated-zero/nonzero-target precondition.
  dd if="$source" of="$work/zero-before" iflag=direct bs=512 skip=$((zero_offset / 512)) count=$((block_bytes / 512)) status=none
  dd if=/dev/zero of="$work/zero" bs=512 count=$((block_bytes / 512)) status=none
  cmp "$work/zero-before" "$work/zero"
  dd if="$target" of="$work/allocated-before" iflag=direct bs=512 skip=$((zero_offset / 512)) count=$((block_bytes / 512)) status=none
  dd if="$target" of="$work/free-before" iflag=direct bs=512 skip=$((free_offset / 512)) count=$((block_bytes / 512)) status=none
  if cmp -s "$work/allocated-before" "$work/zero"; then echo 'target was not initialized nonzero' >&2; exit 1; fi
  bash "$copy" "$kind" "$source" "$target"
  [ "$uuid" = "$(blkid -s UUID -o value "$target")" ]
  dd if="$target" of="$work/zero-after" iflag=direct bs=512 skip=$((zero_offset / 512)) count=$((block_bytes / 512)) status=none
  dd if="$target" of="$work/free-after" iflag=direct bs=512 skip=$((free_offset / 512)) count=$((block_bytes / 512)) status=none
  cmp "$work/zero-after" "$work/zero"
  cmp "$work/free-before" "$work/free-after"
  options=ro
  [ "$kind" != ext4 ] || options=ro,noload
  mount -t "$kind" -o "$options" "$source" "$work/source"
  mount -t "$kind" -o "$options" "$target" "$work/target"
  python3 -I - "$work/source" "$work/target" <<'PY'
import os, sys
source, target = sys.argv[1:]
def inventory(root):
    return {os.path.relpath(os.path.join(p, n), root): open(os.path.join(p, n), 'rb').read()
            for p, _, names in os.walk(root) for n in names if os.path.isfile(os.path.join(p, n))}
assert inventory(source) == inventory(target), 'complete regular-file bytes differ'
assert open(target + '/ZERO.BIN', 'rb').read() == b'\0' * 2**20, 'allocated all-zero spans were skipped'
PY
  umount "$work/source" "$work/target"
  losetup --detach "$source" "$target"
  source='' target=''
  rm "$work/source.img" "$work/target.img"
  echo "GREEN: $kind allocated zeros and complete files preserved on nonzero target; known free block untouched; UUID preserved"
done
