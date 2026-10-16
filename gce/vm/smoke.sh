#!/bin/bash
# The smoke check of a new GCE image (spec §3a Image, bake step 4). The job unit runs it in a job container in place of
# the runner, on a VM booted from the image with no JIT config, so it sees what a job would see. One line per check,
# then `ci-kit smoke: ok` or `ci-kit smoke: failed:<check>` at the first failure.
set -uo pipefail
C=/var/lib/ci-kit/cache

check() {
  local name=$1
  shift
  if "$@" > /dev/null 2>&1; then
    echo "check $name: ok"
  else
    echo "check $name: FAILED"
    echo "ci-kit smoke: failed:$name"
    exit 1
  fi
}
node_runs() {
  local dir
  dir=$(ls -d "$RUNNER_TOOL_CACHE"/node/"$1".*/x64 | head -1)
  "$dir/bin/node" -e 'process.exit(0)'
}
nonempty() { [ -n "$(ls -A "$1" 2> /dev/null)" ]; }
# A cache warm.json records is present; one it does not record (the lockfile pins no such package) is not required.
warmed() { ! jq -e --arg k "$1" 'has($k)' "$C/warm.json" || find "$2" -name "$3" | grep -q .; }
writable() { touch "$1/.ci-kit-smoke" && rm "$1/.ci-kit-smoke"; }
metadata_refused() { ! curl -s --max-time 5 -o /dev/null http://169.254.169.254/; }

check cpus test "$(nproc)" = "$CI_KIT_EXPECT_CPUS"
check user test "$(id -un)" = runner
check isolation test ! -e /var/run/docker.sock -a ! -e /etc/ci-kit
check runner test -x /home/runner/run.sh -a -x /usr/local/bin/ci-kit-entrypoint
check node22 node_runs 22
check node24 node_runs 24
check warm jq -e 'length > 0 and all(.[]; .ok)' "$C/warm.json"
check pnpm-store nonempty "$npm_config_store_dir"
check playwright warmed playwright "$PLAYWRIGHT_BROWSERS_PATH" 'chromium*'
check electron warmed electron "$electron_config_cache" 'electron-v*.zip'
check workdir writable "$CI_KIT_WORK"
check dns getent hosts github.com
check egress curl -sf --max-time 15 -o /dev/null https://api.github.com/zen
check metadata-refused metadata_refused
echo 'ci-kit smoke: ok'
