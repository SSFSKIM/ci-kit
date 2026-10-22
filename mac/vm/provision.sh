#!/bin/bash
# The bake's provisioning (docs/mac-lane.md, the VM lane's maintenance): run inside a candidate image, never a job
# clone, by bake.sh through `tart exec <vm> /bin/bash '/Volumes/My Shared Files/kit/vm/provision.sh' <step> …`, one step
# a call, each safe to run again. It makes the image what the guest's kickoff, wrapper and hooks need (guest/):
#
#   check                                the base: macOS's version, Homebrew, python3 (installed when the system's
#                                        cannot run runner-state.py) and the Swift compiler
#   node <pnpm version>                  Node 22 (Homebrew's node@22) and pnpm through corepack, on the runner's PATH
#   store                                the pnpm store and Electron's download cache warmed: a scratch clone of the
#                                        read-only maws share, `pnpm install --frozen-lockfile`, then the clone removed
#   libreoffice                          LibreOffice (cask), for the document groups
#   runner <version> <sha256> <machine>  the runner at install.sh's pin in ~/actions-runner-maws, its .env and .path
#                                        (env below), and ~/ci-kit -> the kit share, which keeps a space out of the
#                                        hook paths
#   env <machine>                        the runner's .env and .path alone
#   helpers                              cursor-park and window-list compiled into ~/ci-kit-helpers (the kit share is
#                                        read-only, and the guest's hooks look there)
#   register <slot> <name> <labels> <url>
#                                        config.sh with the registration token read from stdin (never an argument),
#                                        then the identity (.runner, .credentials, .credentials_rsaparams) moved to the
#                                        identity-<slot> share and out of the image, which holds no runner identity
#
# <machine> is the guest's CI_KIT_MACHINE, <host machine>-vm, so a guest's refusal never reads as the host's. Bash 3.2.
set -euo pipefail
export HOME=${HOME:-/Users/admin}
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=guest/guest.sh
source "$here/guest/guest.sh"
# The PATH the runner gives every job and hook (.path): Node 22 first, then Homebrew's tools, then the system's.
runner_path=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH=$runner_path NONINTERACTIVE=1 HOMEBREW_NO_ENV_HINTS=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
fail() {
  echo "provision: $*" >&2
  exit 1
}
say() {
  echo "provision: $*"
}

write_env() { # <machine>
  [[ $1 =~ ^[a-z0-9-]+$ ]] || fail "env takes the guest's machine name (got '$1')"
  [[ -d $vm_runner ]] || fail "no runner at $vm_runner"
  {
    echo LANG=en_US.UTF-8
    echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=$HOME/ci-kit/vm/guest/hooks/job-started.sh"
    echo "ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$HOME/ci-kit/vm/guest/hooks/job-completed.sh"
    echo "CI_KIT_MACHINE=$1"
    echo CI_KIT_VM_GUEST=1
  } >"$vm_runner/.env"
  echo "$runner_path" >"$vm_runner/.path"
  ln -sfn "$vm_shares/kit" "$HOME/ci-kit"
  say "$vm_runner/.env and .path written; $HOME/ci-kit -> $vm_shares/kit"
}

step=${1:-}
shift || true
case $step in
  check)
    say "macOS $(sw_vers -productVersion)"
    command -v brew >/dev/null || fail 'no Homebrew in the base image'
    if ! python3 -I -c 'import ctypes, json' >/dev/null 2>&1; then
      say 'python3 cannot run runner-state.py; installing python from Homebrew'
      brew install python
    fi
    say "$(python3 --version)"
    xcrun --find swiftc >/dev/null || fail 'no Swift compiler (the Xcode command line tools) in the base image'
    ;;
  node)
    [[ ${1:-} =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "node takes pnpm's version (got '${1:-}')"
    brew list node@22 >/dev/null 2>&1 || brew install node@22
    node_bin=$(brew --prefix node@22)/bin
    [[ $("$node_bin/node" --version) == v22.* ]] || fail "node@22 is $("$node_bin/node" --version)"
    [[ -x $node_bin/corepack ]] || "$node_bin/npm" install -g --prefix "$(brew --prefix node@22)" corepack
    "$node_bin/corepack" enable --install-directory "$node_bin" pnpm
    "$node_bin/corepack" install --global "pnpm@$1"
    [[ $(pnpm --version) == "$1" ]] || fail "pnpm is $(pnpm --version), not $1"
    say "node $(node --version), pnpm $(pnpm --version)"
    ;;
  store)
    [[ -f $vm_shares/maws/package.json && -f $vm_shares/maws/pnpm-lock.yaml ]] || fail "no MAWS checkout at $vm_shares/maws"
    scratch=$HOME/maws-bake
    rm -rf "$scratch"
    # The share's files are the host user's: git would otherwise refuse the clone's source as of dubious ownership.
    git -c safe.directory='*' clone --quiet --no-hardlinks "$vm_shares/maws" "$scratch"
    (cd "$scratch" && CI=1 pnpm install --frozen-lockfile)
    rm -rf "$scratch"
    say "the pnpm store ($(pnpm store path)) and Electron's download cache are warm"
    ;;
  libreoffice)
    [[ -d /Applications/LibreOffice.app ]] || brew install --cask libreoffice
    [[ -x /Applications/LibreOffice.app/Contents/MacOS/soffice ]] || fail 'LibreOffice did not install'
    say 'LibreOffice installed'
    ;;
  runner)
    version=${1:-} sha=${2:-}
    [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && $sha =~ ^[0-9a-f]{64}$ ]] || fail 'runner takes <version> <sha256> <machine>'
    tarball=actions-runner-osx-arm64-$version.tar.gz
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    curl -fsSL -o "$tmp/$tarball" "https://github.com/actions/runner/releases/download/v$version/$tarball"
    echo "$sha  $tmp/$tarball" | shasum -a 256 -c --quiet - || fail "checksum mismatch for $tarball"
    rm -rf "$vm_runner"
    mkdir -p "$vm_runner"
    tar -xzf "$tmp/$tarball" -C "$vm_runner"
    write_env "${3:-}"
    say "runner $version in $vm_runner"
    ;;
  env)
    write_env "${1:-}"
    ;;
  helpers)
    mkdir -p "$HOME/ci-kit-helpers"
    for helper in cursor-park window-list; do
      xcrun swiftc -O -o "$HOME/ci-kit-helpers/.$helper.tmp" "$vm_shares/kit/hooks/$helper.swift"
      mv -f "$HOME/ci-kit-helpers/.$helper.tmp" "$HOME/ci-kit-helpers/$helper"
    done
    say "helpers in $HOME/ci-kit-helpers; display $("$HOME/ci-kit-helpers/cursor-park" --describe 2>/dev/null || echo unreadable)"
    ;;
  register)
    slot=${1:-} name=${2:-} labels=${3:-} url=${4:-}
    [[ $slot =~ ^[a-z0-9-]+$ && $name =~ ^[A-Za-z0-9._-]+$ && -n $labels && $url == https://github.com/* ]] ||
      fail 'register takes <slot> <runner name> <labels> <repository url>, the token on stdin'
    IFS= read -r token || true
    [[ -n $token ]] || fail 'no registration token on stdin'
    dest=$vm_shares/identity-$slot
    [[ -d $dest && -w $dest ]] || fail "the identity-$slot share is not shown read-write at $dest"
    cd "$vm_runner" 2>/dev/null && [[ -x ./config.sh && -f .env && -f .path ]] || fail "no provisioned runner at $vm_runner"
    for file in $vm_identity_files; do rm -f "$file"; done
    # config.sh rewrites .path from its own PATH and adds to .env (the runner's env.sh): the bake's are put back.
    cp .env .env.bake && cp .path .path.bake
    status=0
    env -i HOME="$HOME" USER="${USER:-admin}" PATH="$runner_path" LANG=en_US.UTF-8 ACTIONS_RUNNER_INPUT_TOKEN="$token" \
      ./config.sh --unattended --url "$url" --name "$name" --labels "$labels" --no-default-labels --work _work --replace ||
      status=$?
    token=''
    mv -f .env.bake .env && mv -f .path.bake .path
    ((status == 0)) || fail "config.sh failed ($status)"
    for file in $vm_identity_files; do
      [[ -f $file ]] || fail "config.sh left no $file"
      cp "$file" "$dest/$file.tmp" && mv -f "$dest/$file.tmp" "$dest/$file"
    done
    for file in $vm_identity_files; do rm -f "$file"; done
    rm -rf _diag
    say "$name registered with $labels; its identity is in the identity-$slot share, and none is left in $vm_runner"
    ;;
  *)
    fail "unknown step '${step}' (check, node, store, libreoffice, runner, env, helpers, register)"
    ;;
esac
