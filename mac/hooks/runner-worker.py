# Whether the runner has a job: prints `busy <pid>…` with every process whose executable is exactly the file given (the
# runner's bin/Runner.Worker), or `idle` when no process is. The path is the kernel's (proc_pidpath), not a command line
# or argv[0], which any process can set to anything. `idle` is printed only after every process was read: the dialog
# watcher takes anything else, a failure, a syntax error or a timeout, as "a job may be running" (docs/mac-lane.md).
# Run as python3 -I runner-worker.py <path>.
import ctypes
import os
import sys

try:
    target = os.fsencode(os.path.realpath(sys.argv[1]))
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    count = libproc.proc_listallpids(None, 0)
    if count <= 0:
        raise OSError(ctypes.get_errno(), 'proc_listallpids')
    pids = (ctypes.c_int * (count + 256))()  # room for processes started since the count
    count = libproc.proc_listallpids(pids, ctypes.sizeof(pids))
    if count <= 0:
        raise OSError(ctypes.get_errno(), 'proc_listallpids')
    path = ctypes.create_string_buffer(4096)  # PROC_PIDPATHINFO_MAXSIZE
    found = [pid for pid in pids[:count]
             if pid > 0 and libproc.proc_pidpath(pid, path, ctypes.sizeof(path)) > 0 and path.value == target]
except Exception as error:  # noqa: BLE001 - every failure is "unknown", never "no job"
    print(f'runner-worker: {error}', file=sys.stderr)
    sys.exit(2)
print(' '.join(['busy', *map(str, found)]) if found else 'idle')
