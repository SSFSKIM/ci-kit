# What the runner in the directory given, any instance of the lane, is doing, from this user's processes: for
# install.sh, the dialog watcher's drain and the shared hold (docs/mac-lane.md). Prints one line:
#
#   busy <pid>...      a job runs: a process whose executable is exactly <dir>/bin/Runner.Worker
#   idle <log> <size>  the listener runs (<dir>/bin/Runner.Listener) and no job does. <log> is the listener's newest
#                      diag log in <dir>/_diag and <size> its length: the listener logs a job the moment it is offered
#                      one, seconds before the job's worker starts, and while it waits logs only a token refresh
#                      every 50 minutes or so, so two reads that print the same line saw no job offered in between
#   stopped            neither runs
#
# The path is the kernel's (proc_pidpath), never a command line or argv[0], which any process can set to anything. A
# process that exits while it is read is skipped. One whose path cannot be read (its file was deleted or replaced, as
# an updated binary's is) counts as busy when the kernel still names it Runner.Worker, or names it nothing: an unread
# job must never look idle. Any other failure, a listener without a diag log included, exits 2 and prints nothing,
# which the watcher takes as busy too.
#
# With --wait <pid>, it waits instead for <pid>, a job's worker, to exit (kqueue, so the exit is seen as it happens),
# and prints exited; or gone, when <pid> had already exited; or not-worker, when <pid> is some other process. Once the
# watch is armed, or there is nothing to watch, it writes `armed` to the ready file given, so the caller can know that
# an exit from then on is seen. The caller sets the deadline.
#
# With --workers instead of a directory, it prints the pids of every job worker of this user, of any runner: each
# process whose executable, by the kernel's path, is named Runner.Worker (or that the kernel names so, or names
# nothing, when its path cannot be read), space-separated on one line, empty when there is none. A sweep of a _work
# other than its own job's spares them and what they started (sweep.mjs --spare-workers), so a command line, which
# any process sets and ps prints unquoted, never decides it.
#
# Run as python3 -I runner-state.py <runner dir> [--wait <pid> [<ready file>]], or python3 -I runner-state.py --workers.
import ctypes
import errno
import os
import select
import sys

PROC_UID_ONLY = 4  # libproc.h: the processes of one effective uid
WORKER = b'Runner.Worker'


def main():
    runner = sys.argv[1]
    every = runner == '--workers'
    # A runner that updated itself has bin -> bin.<version>; the kernel reports the resolved path.
    worker = os.fsencode(os.path.realpath(os.path.join(runner, 'bin', 'Runner.Worker')))
    listener = os.fsencode(os.path.realpath(os.path.join(runner, 'bin', 'Runner.Listener')))
    if every:  # any runner's worker: by the executable's name, the kernel's path's last component
        worker, listener = None, None
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    path = ctypes.create_string_buffer(4096)  # PROC_PIDPATHINFO_MAXSIZE
    name = ctypes.create_string_buffer(256)

    def is_worker(pid):  # (whether pid is, or may be, a job; its path when readable). ProcessLookupError once gone
        ctypes.set_errno(0)
        if libproc.proc_pidpath(pid, path, ctypes.sizeof(path)) > 0:
            if every:
                return os.path.basename(path.value) == WORKER, path.value
            return path.value == worker, path.value
        if ctypes.get_errno() == errno.ESRCH:
            raise ProcessLookupError(pid)
        ctypes.set_errno(0)
        if libproc.proc_name(pid, name, ctypes.sizeof(name)) > 0:
            return name.value == WORKER, None
        if ctypes.get_errno() == errno.ESRCH:
            raise ProcessLookupError(pid)
        return True, None  # nothing about it can be read: it may be a job

    if len(sys.argv) > 2 and sys.argv[2] == '--wait':
        queue = select.kqueue()
        nothing = arm(queue, int(sys.argv[3]), is_worker)
        if len(sys.argv) > 4:
            with open(sys.argv[4], 'w') as ready:
                ready.write('armed\n')
        if nothing:
            return nothing
        queue.control(None, 1)
        return 'exited'

    size = libproc.proc_listpids(PROC_UID_ONLY, os.geteuid(), None, 0)
    if size <= 0:
        raise OSError(ctypes.get_errno(), 'proc_listpids')
    pids = (ctypes.c_int * (size // ctypes.sizeof(ctypes.c_int) + 256))()  # room for processes started since
    used = libproc.proc_listpids(PROC_UID_ONLY, os.geteuid(), pids, ctypes.sizeof(pids))
    if used <= 0 or used >= ctypes.sizeof(pids):  # a full buffer may have left processes out
        raise OSError(ctypes.get_errno(), 'proc_listpids')
    jobs, listening = [], False
    for pid in pids[:used // ctypes.sizeof(ctypes.c_int)]:
        if pid <= 0:
            continue
        try:
            job, seen = is_worker(pid)
        except ProcessLookupError:
            continue
        if job:
            jobs.append(pid)
        listening = listening or seen == listener
    if every:
        return ' '.join(map(str, jobs))
    if jobs:
        return ' '.join(['busy', *map(str, jobs)])
    if not listening:
        return 'stopped'
    diag = os.path.join(runner, '_diag')
    logs = sorted(entry for entry in os.listdir(diag) if entry.startswith('Runner_') and entry.endswith('.log'))
    if not logs:
        raise FileNotFoundError(errno.ENOENT, 'no Runner_*.log', diag)
    return f'idle {logs[-1]} {os.stat(os.path.join(diag, logs[-1])).st_size}'


def arm(queue, pid, is_worker):  # watches pid's exit on queue; returns why there is nothing to wait for, or None
    if pid < 1:
        return 'not-worker'
    try:  # watch first, then check what pid is, so an exit in between is not missed
        queue.control([select.kevent(pid, select.KQ_FILTER_PROC, select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                                     select.KQ_NOTE_EXIT)], 0, 0)
    except ProcessLookupError:
        return 'gone'
    try:
        if not is_worker(pid)[0]:
            return 'not-worker'
    except ProcessLookupError:
        pass  # it exited after the watch began: its event is queued
    return None


try:
    print(main())
except Exception as error:  # noqa: BLE001 - every failure is "unknown", never "idle"
    print(f'runner-state: {error}', file=sys.stderr)
    sys.exit(2)
