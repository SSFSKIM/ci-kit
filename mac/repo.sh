#!/bin/bash
# One host setting for registration, queue reads, JIT and baking. The exclusive
# runner's .env is the persisted source; an explicit environment wins for a rehearsal.
ci_kit_repo() {
  local repo=${CI_KIT_VM_REPO:-} key value
  if [[ -z $repo && -f $HOME/actions-runner-maws/.env ]]; then
    while IFS='=' read -r key value || [[ -n $key ]]; do
      [[ $key != CI_KIT_VM_REPO ]] || repo=$value
    done <"$HOME/actions-runner-maws/.env"
  fi
  repo=${repo:-SSFSKIM/MAWS}
  if [[ ! $repo =~ ^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo 'CI_KIT_VM_REPO must be owner/repository' >&2
    return 1
  fi
  printf '%s\n' "$repo"
}
