#!/usr/bin/env bash
# Installs ci-gate for this user: a symlink ~/.local/bin/ci-gate → this checkout's bin/ci-gate.
# Run it from the checkout that stays (e.g. ~/Developer/GitHub/ci-kit on main), not from a worktree that will be
# removed; re-running it re-points the link. ci-gate needs Node >= 22 and an authenticated gh, nothing else.
set -euo pipefail

kit=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
bin_dir=$HOME/.local/bin

major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || { echo "install.sh: node not found; ci-gate needs Node >= 22" >&2; exit 1; }
((major >= 22)) || { echo "install.sh: node $(node --version) is too old; ci-gate needs Node >= 22" >&2; exit 1; }
command -v gh >/dev/null || { echo "install.sh: gh not found; ci-gate uses the gh CLI's login" >&2; exit 1; }

mkdir -p "$bin_dir"
ln -sfn "$kit/bin/ci-gate" "$bin_dir/ci-gate"
echo "install.sh: $bin_dir/ci-gate -> $kit/bin/ci-gate"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "install.sh: note: $bin_dir is not on PATH" ;;
esac
gh auth status --hostname github.com >/dev/null 2>&1 || echo "install.sh: note: gh is not logged in; run gh auth login"
