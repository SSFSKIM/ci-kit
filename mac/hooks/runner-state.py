# What the runner in the directory given is doing, from this user's processes, for the dialog watcher's drain
# (docs/mac-lane.md). Prints one word:
#
#   busy <pid>...  a job runs: a process whose executable is exactly <dir>/bin/Runner.Worker
#   idle           the listener runs (<dir>/bin/Runner.Listener) and no job does
#   stopped        neither runs
#
# The path is the kernel's (proc_pidpath), never a command line or argv[0], which any process can set to anything. A
# process that exits while it is read is skipped. One whose path cannot be read (its file was deleted or replaced, as
# an updated binary's is) counts as busy when the kernel still names it Runner.Worker, or names it nothing: an unread
# job must never look idle. Any other failure exits 2 and prints nothing, which the watcher takes as busy too.
# Run as python3 -I runner-state.py <runner dir>.
import ctypes
import errno
import os
import sys

PROC_UID_ONLY = 4  # libproc.h: the processes of one effective uid
WORKER = b'Runner.Worker'

try:
    # A runner that updated itself has bin -> bin.<version>; the kernel reports the resolved path.
    worker = os.fsencode(os.path.realpath(os.path.join(sys.argv[1], 'bin', 'Runner.Worker')))
    listener = os.fsencode(os.path.realpath(os.path.join(sys.argv[1], 'bin', 'Runner.Listener')))
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    size = libproc.proc_listpids(PROC_UID_ONLY, os.geteuid(), None, 0)
    if size <= 0:
        raise OSError(ctypes.get_errno(), 'proc_listpids')
    pids = (ctypes.c_int * (size // ctypes.sizeof(ctypes.c_int) + 256))()  # room for processes started since
    used = libproc.proc_listpids(PROC_UID_ONLY, os.geteuid(), pids, ctypes.sizeof(pids))
    if used <= 0 or used >= ctypes.sizeof(pids):  # a full buffer may have left processes out
        raise OSError(ctypes.get_errno(), 'proc_listpids')
    path = ctypes.create_string_buffer(4096)  # PROC_PIDPATHINFO_MAXSIZE
    name = ctypes.create_string_buffer(256)
    jobs, listening = [], False
    for pid in pids[:used // ctypes.sizeof(ctypes.c_int)]:
        if pid <= 0:
            continue
        ctypes.set_errno(0)
        if libproc.proc_pidpath(pid, path, ctypes.sizeof(path)) > 0:
            if path.value == worker:
                jobs.append(pid)
            listening = listening or path.value == listener
            continue
        if ctypes.get_errno() == errno.ESRCH:
            continue
        ctypes.set_errno(0)
        if libproc.proc_name(pid, name, ctypes.sizeof(name)) > 0:
            if name.value == WORKER:
                jobs.append(pid)
        elif ctypes.get_errno() != errno.ESRCH:
            jobs.append(pid)
except Exception as error:  # noqa: BLE001 - every failure is "unknown", never "idle"
    print(f'runner-state: {error}', file=sys.stderr)
    sys.exit(2)
print(' '.join(['busy', *map(str, jobs)]) if jobs else 'idle' if listening else 'stopped')
