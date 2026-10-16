#!/bin/bash
# Start one JIT runner (spec §3 Job containers). The agent passes the JIT config in CI_KIT_JIT. The config names
# the work folder: a real directory under the cache mount (not a symlink to one: git's includeIf matches the
# resolved path, and actions/checkout's credentials hang on it), so the checkout shares a mount with pnpm's store
# and pnpm hardlinks instead of copying.
set -euo pipefail
jit=${CI_KIT_JIT:?no JIT config}
unset CI_KIT_JIT
exec /home/runner/run.sh --jitconfig "$jit"
