#!/bin/bash
# Destination must be blank: seeking over zero input cannot erase existing nonzero blocks.
# Match EBS's 512-KiB snapshot blocks; fullblock coalesces short pipe reads before zero detection.
set -euo pipefail
target=$1
if [ "$#" = 2 ]; then set -- "if=$2"; else set --; fi
dd "$@" of="$target" bs=512K iflag=fullblock conv=sparse,fsync status=none
