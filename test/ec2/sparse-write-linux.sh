#!/bin/bash
# Opt-in block-device proof on a disposable Linux guest: exact bytes and no writes for zero runs.
set -euo pipefail
writer=$(readlink -f "${1:?write-sparse.sh path required}")
work=$(mktemp -d /run/ci-kit-sparse-test.XXXXXX)
loop=
cleanup() {
  set +e
  [ -z "$loop" ] || losetup --detach "$loop"
  rm -rf "$work"
}
trap cleanup EXIT
python3 -I - "$work" <<'PY'
import pathlib, sys
p=pathlib.Path(sys.argv[1]); block=512*1024
(p/'zero').write_bytes(bytes(8*1024*1024))
b=bytearray(16*block+4096)
b[block+17]=0x59
b[7*block-1]=0xa7
b[-1]=0x31
(p/'mixed').write_bytes(b)
PY
for mode in zero pipe file; do
  truncate -s 16M "$work/disk"
  loop=$(losetup --find --show "$work/disk")
  stat=/sys/class/block/$(basename "$loop")/stat
  before=$(awk '{print $7}' "$stat")
  input=$work/mixed expected=1052672
  if [ "$mode" = zero ]; then input=$work/zero expected=0; fi
  if [ "$mode" = file ]; then bash "$writer" "$loop" "$input";
  else cat "$input" | bash "$writer" "$loop"; fi
  after=$(awk '{print $7}' "$stat")
  written=$(((after-before)*512))
  [ "$written" = "$expected" ] || { echo "wrong device writes: mode=$mode got=$written expected=$expected" >&2; exit 1; }
  [ "$(blockdev --getsize64 "$loop")" = 16777216 ]
  dd if="$loop" of="$work/actual" bs=4096 count=$(($(stat -c %s "$input")/4096)) status=none
  cmp "$input" "$work/actual"
  echo "GREEN: $mode logical bytes match; device wrote $written bytes; geometry unchanged"
  losetup --detach "$loop"
  loop=
  rm "$work/disk" "$work/actual"
done
