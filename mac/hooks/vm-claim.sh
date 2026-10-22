#!/bin/bash
# The host's side of the VM lane (docs/mac-lane.md): what keeps the guest, the job clone the lane's launcher boots, from
# starting while a host job needs the machine to itself. Only on a Mac with the lane installed (instances.sh,
# vm_lane_installed); without it nothing calls this.
#
#   vm-claim.sh measured <pid>              settle (mac/settle), at its first read: raises the measured claim for the
#                                           Runner.Worker among the pid's ancestors, and prints the claim's name
#   vm-claim.sh exclusive-start <worker>    the exclusive instance's job-started hook: classifies the job, and raises
#                                           the claim of a job of unknown kind. Exits 0 for a VM-safe job, 3 for one
#                                           whose claim is up, 1 refused
#   vm-claim.sh exclusive-wait <seconds>    then, for a claimed job: waits until no guest runs, at most
#                                           CI_KIT_EXCLUSIVE_WAIT minutes (10) counted from the hook's start, given as
#                                           the seconds it has waited already; refused past it
#   vm-claim.sh end <worker>                every instance's job-completed hook, once its sweep went through: removes the
#                                           claim naming its worker
#   vm-claim.sh reservation                 settle, at each read: prints none, reserved or unknown
#   vm-claim.sh claims                      the launcher, holding the desktop lock: prints the claims that hold the
#                                           lane, one line each, and removes the stale ones. Any line printed holds
#                                           the lane: a live claim, or one that cannot be read (owner unknown). Exits
#                                           1 when the claims cannot be listed, which the caller takes as held too
#
# In ~/Library/Logs/ci-kit, under the desktop lock (desktop-lock.sh), each file replaced whole:
#
# - vm-reserved: the launcher's reservation, "a job clone may be running", written before the clone exists and removed
#   only once Tart shows it stopped. Read here for its presence alone, whatever wrote it and whether that lives; a
#   lookup that fails is unknown, and unknown is waited for as a guest is.
# - vm-claim.<worker pid>-<its start time>: one claim per host job that keeps the guest out, naming the job and its
#   Runner.Worker as the shared hold does. The launcher boots nothing while a live one exists; one whose worker is
#   gone is stale and counts for nothing. A claim lasts to its job's end hook, whatever becomes of the job's start: a
#   refused hook fails its step, but the steps that run after a failure still run (shared-hold.sh).
#
# Which jobs claim. A measured job, through settle, the one step only measured jobs run. And, since settle protects only
# the workflows that run it, every exclusive job the hook cannot show to be VM-safe: its workflow file, read at
# GITHUB_WORKFLOW_SHA with the machine user's own gh login (bounded 10 s), must carry the contract line
# `# ci-kit-vm-contract: 1`, by which the calling repository promises that every measured job runs settle. Any other
# outcome (no line, another number, a read that fails, an empty variable) is unknown, and an unknown job is treated as
# measured. The runner gives the hook GITHUB_WORKFLOW_SHA, GITHUB_WORKFLOW_REF and GITHUB_REPOSITORY from the job's
# github context (actions/runner v2.338.0: GitHubContext.cs's allow-list, which ScriptHandler.cs exports to the hook).
# Bash 3.2: macOS's own.
set -uo pipefail
log_tag='vm-claim'
here=$(dirname "$0")
# shellcheck source=dialog.sh
source "$here/dialog.sh"
# shellcheck source=desktop-lock.sh
source "$here/desktop-lock.sh"

vm_reserved=$ci_kit_logs/vm-reserved
contract=1
read_bound=10

claim_file() { # <worker pid> <its start time>
  printf '%s/vm-claim.%s-%s\n' "$ci_kit_logs" "$1" "$(tr -s ' ' '-' <<<"$2")"
}

# The reservation, as reserved_as (none, reserved or unknown) and reserved_line (its first line, or why it is unknown).
reservation() {
  local why
  why=$(perl -e 'exit 0 if lstat $ARGV[0]; exit 1 if $!{ENOENT}; print "$!"; exit 2' "$vm_reserved" 2>&1)
  case $? in
    0) reserved_as=reserved reserved_line=$(head -1 "$vm_reserved" 2>/dev/null) ;;
    1) reserved_as=none reserved_line='' ;;
    *) reserved_as=unknown reserved_line="$vm_reserved: ${why:-the lookup failed}" ;;
  esac
}

# Raises the claim of a worker, under the lock: true with claim_name set, or false with claim_why.
raise() { # <worker pid> <what>
  local started file
  claim_name='' claim_why=''
  started=$(started_of "$1")
  if [[ -z $started ]]; then
    claim_why="the start time of worker $1 could not be read"
    return 1
  fi
  file=$(claim_file "$1" "$started")
  clock
  if ! lock 180; then
    claim_why='the desktop lock could not be taken within 180 s'
    return 1
  fi
  if ! write_marker "$file" "$2" "$1" "$started" 2>/dev/null; then
    unlock
    claim_why="$file could not be written"
    return 1
  fi
  unlock
  claim_name=${file##*/}
}

# The Runner.Worker among a process's ancestors, itself included: a job's steps run under it.
worker_of() { # <pid>
  local pid=$1 parent command hops
  for ((hops = 0; hops < 32; hops++)); do
    [[ $pid =~ ^[1-9][0-9]*$ && $pid != 1 ]] || return 1
    read -r parent command < <(LC_ALL=C bounded 5 /bin/ps -o ppid=,comm= -p "$pid" 8>&- 2>/dev/null) || return 1
    if [[ ${command##*/} == Runner.Worker ]]; then
      printf '%s\n' "$pid"
      return 0
    fi
    pid=$parent
  done
  return 1
}

measured() { # <pid>: settle prints the claim's name in its line, so nothing is logged here
  local worker
  if ! worker=$(worker_of "$1"); then
    echo "no Runner.Worker among the ancestors of process $1" >&2
    exit 1
  fi
  raise "$worker" 'measured claim' || { echo "$claim_why" >&2; exit 1; }
  printf '%s\n' "$claim_name"
}

# Whether the job's workflow carries the contract line; why, when it cannot be shown.
classify() {
  local repo=${GITHUB_REPOSITORY:-} sha=${GITHUB_WORKFLOW_SHA:-} ref=${GITHUB_WORKFLOW_REF:-} path out err status found
  if [[ -z $sha ]]; then
    why='GITHUB_WORKFLOW_SHA is empty'
    return 1
  fi
  # owner/repo/.github/workflows/<file>@<ref>
  path=${ref%@*}
  if [[ -z $repo || $path != "$repo"/?* ]]; then
    why="GITHUB_WORKFLOW_REF '$ref' names no workflow of ${repo:-the repository}"
    return 1
  fi
  path=${path#"$repo"/}
  out=$(mktemp) || { why='no scratch file'; return 1; }
  err=$(mktemp) || { rm -f "$out"; why='no scratch file'; return 1; }
  # A file, not a pipe: nothing gh leaves behind can hold the read open. The job's own token, if its environment has
  # one, is not the machine's login.
  bounded "$read_bound" env -u GH_TOKEN -u GITHUB_TOKEN "${CI_KIT_GH_BIN:-gh}" api \
    -H 'Accept: application/vnd.github.raw+json' "repos/$repo/contents/$path?ref=$sha" >"$out" 2>"$err"
  status=$?
  if ((status == 124)); then
    why="the read of $path timed out after $read_bound s"
  elif ((status != 0)); then
    why="the read of $path failed: $(head -1 "$err" 2>/dev/null)"
    [[ $why != *': ' ]] || why+="exit $status"
  else
    found=$(sed -n -E 's/^[[:space:]]*#[[:space:]]*ci-kit-vm-contract:[[:space:]]*([0-9]+)[[:space:]]*$/\1/p' "$out" | head -1)
    if [[ -z $found ]]; then
      why="no contract line in $path at ${sha:0:12}"
    elif [[ $found != "$contract" ]]; then
      why="contract $found in $path at ${sha:0:12}, not $contract"
    else
      rm -f "$out" "$err"
      return 0
    fi
  fi
  rm -f "$out" "$err"
  return 1
}

exclusive_start() { # <worker pid>
  if classify; then
    log "vm-safe: yes (contract $contract)"
    exit 0
  fi
  log "vm-safe: unknown ($why)"
  if ! raise "$1" 'unknown-kind claim'; then
    log "refusing this job: the guest cannot be kept out ($claim_why)"
    echo "ci-kit: the guest on the $machine could not be kept out for a job of unknown kind ($claim_why) — rerun" >&2
    exit 1
  fi
  log "raised $claim_name: no guest boots until this job ends"
  exit 3
}

exclusive_wait() { # <seconds the hook has waited already>
  local bound said='' why
  bound=$(minutes "${CI_KIT_EXCLUSIVE_WAIT:-}" 10)
  [[ $1 =~ ^[0-9]+$ ]] && SECONDS=$1 || SECONDS=0
  while :; do
    reservation
    case $reserved_as in
      none)
        [[ -z $said ]] || log "no guest runs after $SECONDS s"
        return 0
        ;;
      reserved) why="the reservation stands, ${reserved_line:-$vm_reserved}" ;;
      *) why="cannot tell whether a guest runs ($reserved_line)" ;;
    esac
    [[ $why == "$said" ]] || log "waiting for the guest (at most $bound min): $why"
    said=$why
    if ((SECONDS >= $(seconds "$bound"))); then
      log "refusing this job after $bound min: $why; its claim stays until it ends"
      echo "ci-kit: the guest on the $machine did not make way for a job of unknown kind (after $bound min: $why); waited $SECONDS s — rerun" >&2
      exit 1
    fi
    sleep "$poll"
  done
}

end_job() { # <worker pid>
  local file started
  started=$(started_of "$1")
  for file in "$ci_kit_logs/vm-claim.$1-"*; do
    [[ -e $file && $file != *.tmp ]] || continue
    if ! read_marker "$file"; then
      log "could not read ${file##*/}; it stays, and holds the lane until someone removes it"
      continue
    fi
    remove_named "$file" "$1" "$started" claim 'its job ended' || true
  done
}

claims() { # the caller holds the desktop lock: taking it here would wait on the caller
  local file why
  # A directory that cannot be listed hides every claim in it: the glob below would see none.
  why=$(perl -e 'opendir(my $d, $ARGV[0]) and exit 0; exit 1 if $!{ENOENT}; print "$!"; exit 2' "$ci_kit_logs" 2>&1)
  case $? in
    0) ;;
    1) return 0 ;;
    *) echo "the claims in $ci_kit_logs cannot be listed (${why:-the listing failed})" >&2; exit 1 ;;
  esac
  for file in "$ci_kit_logs"/vm-claim.*; do
    [[ -e $file && $file != *.tmp ]] || continue
    # A claim that cannot be read may be a live job's: it holds the lane, and is never removed here.
    if ! read_marker "$file"; then
      printf '%s: unreadable, owner unknown\n' "${file##*/}"
      continue
    fi
    if alive "$m_worker" "$m_started"; then
      printf '%s: %s\n' "${file##*/}" "$(named)"
    elif rm -f "$file"; then
      log "${file##*/} is stale: its worker is gone; removed" >/dev/null
    fi
  done
}

case ${1:-} in
  measured) measured "${2:?a pid}" ;;
  exclusive-start) exclusive_start "${2:?a worker pid}" ;;
  exclusive-wait) exclusive_wait "${2:-0}" ;;
  end) end_job "${2:?a worker pid}" ;;
  reservation) reservation; printf '%s\n' "$reserved_as" ;;
  claims) claims ;;
  *) echo 'usage: vm-claim.sh measured <pid> | exclusive-start|end <worker pid> | exclusive-wait <seconds> | reservation | claims' >&2; exit 2 ;;
esac
exit 0
