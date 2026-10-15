#!/bin/bash
# Start one JIT runner (spec §3 Job containers). The agent passes the JIT config in CI_KIT_JIT and the work
# directory in CI_KIT_WORK, a directory under the cache mount, so pnpm's store and the checkout share a mount
# and pnpm hardlinks instead of copying.
set -euo pipefail
jit=${CI_KIT_JIT:?no JIT config}
unset CI_KIT_JIT
ln -sfn "${CI_KIT_WORK:?no work directory}" /home/runner/_work
exec /home/runner/run.sh --jitconfig "$jit"
