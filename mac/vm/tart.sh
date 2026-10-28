#!/bin/bash
# Sourced by the VM lane's launcher (lane.sh) and the maintenance procedure's script (bake.sh): the Tart steps, each
# under a deadline (dialog.sh's bounded, which the caller sources first), in the C locale, and with the descriptors of
# the desktop lock (8) and the launcher's own lock (7) closed, so nothing Tart leaves behind can hold either.
#
# Tart's list is read only on a transition, never on the launcher's idle poll (which reads `tart run` processes).
# Even `tart list --source local` sizes each local disk.img through `diskutil image info --plist`: an image attach
# whose IOKit objects macOS never freed on the mini (2026-10-28: 232,825 AppleAPFSContainer objects, about 8 GB leaked
# in a week, 9.76 of 16 GB wired; 15% free could not meet the guest's 57% boot floor). JSON (Name, State, Running),
# never the locale-dependent table; --source local also avoids attaching cached OCI images.
# A VM's end is verified, not assumed: Tart lists it stopped (or not at all) and no `tart run` of its name is in the
# process table. This retains a few leaking list calls per job (normally boot, verified end, then delete: three
# lists, each attaching every local image), not two per idle poll. A failed transition retries until it settles.
# A stop goes through `tart stop --timeout`, Tart's graceful stop and then its force,
# and is verified the same way. Tart refuses to delete a running VM (VMDirectory.delete(), 2.41.1), but nothing here
# relies on that alone: a delete comes only after a verified stop.
#
# CI_KIT_TART names the binary (tart on the PATH); CI_KIT_VM_PS moves the process-table read (/bin/ps) for tests.
# CI_KIT_VM_GUEST_KIT is where a clone sees the kit share
# (/Users/admin/ci-kit, the image's symlink to /Volumes/My Shared Files/kit). Bash 3.2: macOS's own.
tart_bin=${CI_KIT_TART:-tart}
tart_guest_kit=${CI_KIT_VM_GUEST_KIT:-/Users/admin/ci-kit}
tart_why=''

tart_call() { # <seconds> <tart arguments...>
  local seconds=$1
  shift
  bounded "$seconds" env LC_ALL=C "$tart_bin" "$@" 7>&- 8>&-
}

# Every local VM, one line each: <name><TAB><state>, the state as Tart gives it (stopped, running, suspended), running
# whenever Running says so. False when the list cannot be read or parsed.
tart_vms() {
  local out
  out=$(tart_call 30 list --source local --format json 2>/dev/null) || return 1
  perl -MJSON::PP -e '
    my $vms = eval { JSON::PP->new->decode(do { local $/; <STDIN> }) };
    exit 1 unless ref $vms eq "ARRAY";
    for my $vm (@$vms) {
      next unless ref $vm eq "HASH" && defined $vm->{Name} && ($vm->{Source} // "local") eq "local";
      my $state = $vm->{Running} ? "running" : ($vm->{State} // "unknown");
      print "$vm->{Name}\t$state\n";
    }' <<<"$out"
}
tart_state_in() { # <tart_vms output> <name>: its state, or nothing when it is not there
  awk -F'\t' -v name="$2" '$1 == name { print $2; exit }' <<<"$1"
}

# The pids of a VM's `tart <subcommand>` processes, one per line, from the process table: a process with the
# subcommand right after a `tart` and, for run, the VM's name last; for exec, right after the subcommand. False when
# the table cannot be read. With run and no name, returns the names of all running maws-vm-* VMs instead.
tart_pids() { # run|exec [<name>]
  local table
  table=$(LC_ALL=C bounded 10 "${CI_KIT_VM_PS:-/bin/ps}" -axww -o pid=,command= 7>&- 8>&- 2>/dev/null) || return 1
  perl -e '
    my ($sub, $name) = @ARGV[0, 1];
    @ARGV = ();
    while (<STDIN>) {
      my ($pid, @argv) = split " ";
      for my $i (0 .. $#argv - 2) {
        next unless $argv[$i] =~ m{(?:^|/)tart$} && $argv[$i + 1] eq $sub;
        if ($sub eq "run" && $name eq "") {
          if ($argv[-1] =~ /^maws-vm-/) { print "$argv[-1]\n"; last }
        } elsif ($sub eq "run" ? $argv[-1] eq $name : $argv[$i + 2] eq $name) { print "$pid\n"; last }
      }
    }' "$1" "${2:-}" <<<"$table"
}
tart_run_pids() { # <name>: its `tart run` processes
  tart_pids run "$1"
}
tart_run_vms() { # all maws-vm-* names with a `tart run` process; false when the table cannot be read
  tart_pids run
}

# Whether a VM's end is verified: 0 when Tart lists it stopped or not at all and no `tart run` of it runs, 1 when it
# runs, 2 when that cannot be told. tart_why says why it is not 0.
tart_ended() { # <name>
  local vms state pids
  if ! vms=$(tart_vms); then
    tart_why='Tart cannot list its VMs'
    return 2
  fi
  state=$(tart_state_in "$vms" "$1")
  if ! pids=$(tart_run_pids "$1"); then
    tart_why='the process table cannot be read'
    return 2
  fi
  if [[ -n $pids ]]; then
    tart_why="a tart run of $1 runs (pid ${pids//$'\n'/, })"
    return 1
  fi
  case $state in
    '' | stopped) tart_why='' ;;
    *) tart_why="Tart lists $1 as $state"; return 1 ;;
  esac
}
# Stops a VM unless its end is verified already, then verifies it: the same answers as tart_ended.
tart_stop_verified() { # <name> <seconds of graceful stop>
  local status
  tart_ended "$1"
  status=$?
  ((status == 1)) || return "$status"
  if ! tart_call $(($2 + 30)) stop "$1" --timeout "$2" >/dev/null 2>&1; then
    tart_ended "$1" && return 0
    status=$?
    tart_why="tart stop failed; $tart_why"
    return "$status"
  fi
  tart_ended "$1"
}

tart_clone() { # <source> <name>
  tart_call "${CI_KIT_VM_CLONE_WAIT:-300}" clone "$1" "$2"
}
tart_delete() { # <name>
  tart_call 120 delete "$1"
}
# Whether the guest agent answers: `tart exec`, gRPC over the VM's control socket, never the guest's address.
tart_answers() { # <name>
  tart_call 10 exec "$1" true >/dev/null 2>&1
}
# kickoff.sh in the clone, which starts the slot's runner under wrapper.sh and returns (guest/kickoff.sh).
tart_kickoff() { # <name> <slot> <seconds>
  tart_call "$3" exec "$1" "$tart_guest_kit/vm/guest/kickoff.sh" "$2" "$1"
}
# The four directory shares a clone is given (guest/guest.sh), mounted in the guest under /Volumes/My Shared
# Files/<name>: the kit and this clone's JIT directory read-only, the slot's out/ and cache read-write.
tart_shares() { # <kit dir> <slot dir> <clone>
  printf '%s\n' "--dir=kit:$1:ro" "--dir=jit:$2/jit/$3:ro" "--dir=out:$2/out" "--dir=cache:$2/cache"
}
# `tart run --no-graphics --no-clipboard` of a VM, detached in a session of its own: it outlives its caller, which is
# how a guest keeps running through a launcher's death, and nothing of the caller's (its output, its locks, its process
# group) reaches it. Tart shares the host's pasteboard with a guest by default, graphics or not (Run.swift passes
# clipboard: !noClipboard), and a guest's pasteboard must never be the host's: MAWS's clipboard groups would cross
# desktops. Sets tart_run_pid.
tart_spawn() { # <name> <log file> <tart run options...>
  local name=$1 out=$2
  shift 2
  (cd / && exec perl -MPOSIX=setsid -e 'setsid() or exit 126; exec { $ARGV[0] } @ARGV; exit 127' \
    env LC_ALL=C "$tart_bin" run --no-graphics --no-clipboard "$@" "$name") </dev/null >>"$out" 2>&1 7>&- 8>&- 9>&- &
  # shellcheck disable=SC2034 # the caller reads it
  tart_run_pid=$!
}
# For a caller that waits in one step (bake.sh's trial): until the guest agent answers (0), the run exits (3), or the
# seconds pass (1).
tart_wait_answer() { # <name> <seconds> <tart run pid>
  local deadline=$((SECONDS + $2))
  while ((SECONDS < deadline)); do
    kill -0 "$3" 2>/dev/null || return 3
    tart_answers "$1" && return 0
    sleep 2
  done
  return 1
}

# The same host login as gh_read (no job or alert token). No credential crosses argv or stdout.
jit_mint() { # <repo> <machine> <slot dir> <slot> <clone>
  bounded 20 python3 -I "$here/jit.py" mint "$@" 7>&- 8>&-
}
jit_retire() { # <slot dir> <clone>, only after the verified end; local revocation, no API wait
  bounded 5 python3 -I "$here/jit.py" retire "$@" 7>&- 8>&-
}
jit_reap() { # <slot dirs...>: one nonsecret pending registration, best-effort remote cleanup
  bounded 20 python3 -I "$here/jit.py" reap "$@" 7>&- 8>&-
}
