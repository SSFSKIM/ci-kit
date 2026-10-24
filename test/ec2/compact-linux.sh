#!/bin/bash
# Destructive, opt-in Linux regression. Needs root, loop devices, e2fsprogs and partclone.
# bash test/ec2/compact-linux.sh ec2/bake/copy-root.sh
# CI_KIT_ROOT_COPY_TARGET=... additionally runs compact.sh against this guest's real root and blank second disk.
set -euo pipefail
export LC_ALL=C
copy=$(readlink -f "${1:?copy-root.sh path required}")
work=$(mktemp -d /run/ci-kit-ext4-test.XXXXXX)
source='' target='' baseline='' holder='' mounted=0 frozen=0
cleanup() {
  set +e
  [ "$frozen" = 0 ] || fsfreeze -u "$work/source"
  [ -z "$holder" ] || kill "$holder"
  umount "$work/check" 2>/dev/null
  [ "$mounted" = 0 ] || umount "$work/source"
  for loop in "$source" "$target" "$baseline"; do [ -z "$loop" ] || losetup --detach "$loop"; done
  rm -rf "$work"
}
trap cleanup EXIT
mkdir "$work/source" "$work/check"
for image in source target baseline; do truncate -s 128M "$work/$image.img"; done
source=$(losetup --find --show "$work/source.img")
target=$(losetup --find --show "$work/target.img")
baseline=$(losetup --find --show "$work/baseline.img")
mkfs.ext4 -q -F -b 4096 "$source"
mount "$source" "$work/source"
mounted=1
cat > "$work/files.py" <<'PY'
import hashlib, json, os, sys, time
root, ready = sys.argv[1:]
os.makedirs(root, exist_ok=True)
for name in ['visible', 'orphan']:
    fd = os.open(root + '/' + name, os.O_RDWR | os.O_CREAT, 0o640)
    for i in range(256):
        os.pwrite(fd, bytes([i % 251 + 1]) * 4096, i * 8192)
    os.setxattr(fd, 'user.ci-kit', (b'x' if name == 'visible' else b'y') * 2048)
    os.fsync(fd)
    if name == 'visible':
        os.close(fd)
    else:
        inode = os.fstat(fd).st_ino
        os.unlink(root + '/orphan')
os.link(root + '/visible', root + '/hardlink')
os.symlink('visible', root + '/symlink')
with open(ready, 'w') as f:
    json.dump({'inode': inode, 'hash': hashlib.sha256(open(root + '/visible', 'rb').read()).hexdigest()}, f)
while True:
    time.sleep(1)
PY
python3 -I "$work/files.py" "$work/source" "$work/ready" &
holder=$!
for _ in $(seq 1 100); do [ ! -s "$work/ready" ] || break; sleep .1; done
[ -s "$work/ready" ]
sync
inode=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["inode"])' "$work/ready")
debugfs -R "stat <$inode>" "$source" > "$work/orphan-stat" 2>&1
cat "$work/orphan-stat"
grep -q '(ETB0)' "$work/orphan-stat" # More than the four inline extents: metadata e2image omitted.
# A freed block retains nonzero bytes on the source, but must never be written to the blank target.
dd if=/dev/urandom of="$work/source/deleted" bs=1M count=4 status=none
sync
free_block=$(debugfs -R 'blocks /deleted' "$source" 2>/dev/null | awk '{print $1}')
rm "$work/source/deleted"
sync
dd if="$source" of="$work/freed-before" bs=4096 skip="$free_block" count=1 status=none
dd if=/dev/zero of="$work/zero" bs=4096 count=1 status=none
if cmp -s "$work/freed-before" "$work/zero"; then echo 'fixture freed block was not dirty' >&2; exit 1; fi

# Characterize the original failure: a consistent frozen source, yet missing orphan extent metadata.
frozen=1
fsfreeze -f "$work/source"
set +e
timeout --kill-after=2s 15s e2image -ra -f "$source" "$baseline"
old_copy=$?
set -e
fsfreeze -u "$work/source"
frozen=0
[ "$old_copy" = 0 ]
extent_block=$(sed -n 's/.*(ETB0):\([0-9]*\).*/\1/p' "$work/orphan-stat")
dd if="$source" of="$work/extent-before" bs=4096 skip="$extent_block" count=1 status=none
dd if="$baseline" of="$work/extent-after" bs=4096 skip="$extent_block" count=1 status=none
if cmp -s "$work/extent-before" "$work/zero"; then echo 'fixture orphan had no external extent metadata' >&2; exit 1; fi
cmp -s "$work/extent-after" "$work/zero"
# Even normal recovery cannot release an orphan whose external extent tree was not copied.
if mount "$baseline" "$work/check"; then umount "$work/check"; fi
set +e
e2fsck -fn "$baseline" > "$work/old-fsck" 2>&1
old_check=$?
set -e
cat "$work/old-fsck"
[ "$old_check" != 0 ]
echo "RED: e2image zeroed allocated orphan extent block $extent_block; normal recovery + read-only fsck exit=$old_check"

bash "$copy" "$source" "$target" "$work/source"
mount -o ro "$target" "$work/check"
python3 -I - "$work/check" "$work/ready" <<'PY'
import hashlib, json, os, stat, sys
root, ready = sys.argv[1:]
assert hashlib.sha256(open(root + '/visible', 'rb').read()).hexdigest() == json.load(open(ready))['hash']
assert os.stat(root + '/visible').st_ino == os.stat(root + '/hardlink').st_ino
assert os.stat(root + '/visible').st_nlink == 2
assert stat.S_IMODE(os.stat(root + '/visible').st_mode) == 0o640
assert os.readlink(root + '/symlink') == 'visible'
assert os.getxattr(root + '/visible', 'user.ci-kit') == b'x' * 2048
assert not os.path.exists(root + '/orphan')
PY
umount "$work/check"
dd if="$target" of="$work/freed-after" bs=4096 skip="$free_block" count=1 status=none
cmp -s "$work/freed-after" "$work/zero"
echo 'GREEN: allocated-block copy recovered fragmented orphan; retained bytes, hardlinks, symlink, mode and xattr; freed block stayed zero'

# A linked inode with a corrupt link count is not orphan recovery. Never silently repair it.
kill "$holder"
wait "$holder" 2>/dev/null || true
holder=
umount "$work/source"
mounted=0
debugfs -w -R 'set_inode_field /visible links_count 7' "$source"
mount "$source" "$work/source"
mounted=1
set +e
bash "$copy" "$source" "$baseline" "$work/source" > "$work/corrupt" 2>&1
corrupt=$?
set -e
cat "$work/corrupt"
[ "$corrupt" != 0 ]
grep -q 'ref count is 7, should be 2' "$work/corrupt"
timeout 5 touch "$work/source/thawed"
echo "GREEN: genuine linked-inode corruption rejected (exit=$corrupt), source thawed"

# Exercise the production timeout/EXIT cleanup against the real frozen guest root, not just a loop FS.
mkdir "$work/bin"
cat > "$work/bin/timeout" <<'SH'
#!/bin/bash
shift 2
exec /usr/bin/timeout --kill-after=1s 1s "$@"
SH
cat > "$work/bin/partclone.ext4" <<'SH'
#!/bin/bash
kill -STOP $$
SH
chmod +x "$work/bin/timeout" "$work/bin/partclone.ext4"
root=$(readlink -f "$(findmnt -nro SOURCE /)")
loops_before=$(losetup -ln -O NAME | sort)
set +e
PATH="$work/bin:$PATH" bash "$copy" "$root" "$baseline" / > "$work/timeout" 2>&1
timed=$?
set -e
cat "$work/timeout"
[ "$timed" != 0 ]
[ "$loops_before" = "$(losetup -ln -O NAME | sort)" ]
timeout 5 touch /root/ci-kit-root-thawed
rm /root/ci-kit-root-thawed
echo "GREEN: real-root copy timeout (exit=$timed) thawed root and released its loop alias"

if [ -n "${CI_KIT_ROOT_COPY_TARGET:-}" ]; then
  # The harness launches exactly one blank equal-size destination. compact.sh independently checks it.
  [ -b "$CI_KIT_ROOT_COPY_TARGET" ]
  python3 -I "$work/files.py" /root/ci-kit-root-visible "$work/root-ready" &
  holder=$!
  for _ in $(seq 1 100); do [ ! -s "$work/root-ready" ] || break; sleep .1; done
  [ -s "$work/root-ready" ]
  sync
  bash "$(dirname "$copy")/compact.sh"
  mount -o ro "${CI_KIT_ROOT_COPY_TARGET}p1" "$work/check"
  python3 -I - "$work/check/root/ci-kit-root-visible" "$work/root-ready" <<'PY'
import hashlib, json, os, sys
root, ready = sys.argv[1:]
assert hashlib.sha256(open(root + '/visible', 'rb').read()).hexdigest() == json.load(open(ready))['hash']
assert os.stat(root + '/visible').st_nlink == 2
assert os.getxattr(root + '/visible', 'user.ci-kit') == b'x' * 2048
PY
  umount "$work/check"
  echo 'GREEN: complete compact.sh copied actual guest root while frozen and verified GPT and ext4'
fi
