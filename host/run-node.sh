#!/bin/bash
# launchd has no shell profile or nvm function. Search stable PATH entries and the nvm installs that exist now,
# not the version that happened to be the default when the LaunchAgent was installed.
set -euo pipefail
IFS=: read -r -a bins <<< "$PATH"
for bin in "${bins[@]}" "$HOME"/.nvm/versions/node/*/bin; do
  node=$bin/node
  [[ -x $node ]] || continue
  if "$node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
    export PATH="$bin:$PATH"
    exec "$node" "$@"
  fi
done
echo 'ci-kit janitor: Node >= 22 not found on PATH or in ~/.nvm/versions/node; install a compatible Node' >&2
exit 1
