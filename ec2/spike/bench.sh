#!/bin/bash
# Runs inside the baked runner container, never on the orchestrator.
set -euo pipefail
export CI=true NODE_OPTIONS=--max-old-space-size=5120 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export PATH="$RUNNER_TOOL_CACHE/node/22.23.2/x64/bin:$PATH"
# Resolve from the actual baked cache rather than assume the version above exists.
node_dir=$(find "$RUNNER_TOOL_CACHE/node" -maxdepth 2 -type d -name '22.*' | sort -V | tail -1)
export PATH="$node_dir/x64/bin:$PATH"
cd /var/lib/ci-kit/cache/work/spike
if [[ ! -d source ]]; then
  mkdir source
  curl -fsSL --retry 3 -H "Authorization: Bearer $CI_KIT_GH_TOKEN" "https://api.github.com/repos/SSFSKIM/MAWS/tarball/$MAWS_SHA" | tar -xz -C source --strip-components=1
fi
unset CI_KIT_GH_TOKEN
cd source
printf 'SPIKE_TOOLCHAIN '; node --version; corepack pnpm --version
# Fresh job workspace each time; page-cache dropping must not be confused with a persisted Vitest build cache.
rm -rf node_modules out
stage() { printf 'SPIKE_STAGE %s %s\n' "$1" "$(date +%s.%N)"; }
stage install_start
corepack pnpm install --frozen-lockfile > /tmp/spike-install.log 2>&1 || { tail -30 /tmp/spike-install.log; exit 1; }
stage install_end
corepack pnpm build:main-preload > /tmp/spike-build.log 2>&1 || { tail -30 /tmp/spike-build.log; exit 1; }
stage build_end
set +e
corepack pnpm test --maxWorkers=8 --fsModuleCache --shard=1/4 > /tmp/spike-unit.log 2>&1
status=$?
stage unit_end
tail -12 /tmp/spike-unit.log
exit "$status"
