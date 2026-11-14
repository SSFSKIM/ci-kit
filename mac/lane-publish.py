#!/usr/bin/env python3
"""Publish admission (not busyness) independently of the runners and dialog watcher."""
import datetime as dt
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import stat
import subprocess
import sys

HERE = Path(__file__).resolve().parent
UTC = dt.timezone.utc
DEFAULT_WINDOWS = "06:43-07:00"
VM_AGENT = "com.ssfskim.ci-kit.vm-lane"
HORIZON = dt.timedelta(hours=6)
HOST_AGENT = "com.ssfskim.ci-kit.mac-runner"
reader_child = False


def stamp(now):
    return now.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def command(args, timeout=5, env=None):
    # Each reader child (the verdict, the windows) and all its readers share one group. A nested
    # timeout kills that whole read too; compute() then publishes both held, or no windows.
    # Nested setsid would let readers escape the outer deadline.
    with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, start_new_session=not reader_child, env=env) as proc:
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(os.getpgrp() if reader_child else proc.pid, signal.SIGKILL)
            proc.communicate()
            raise RuntimeError(f"{Path(args[0]).name} timed out after {timeout}s") from None
        if proc.returncode:
            raise RuntimeError(f"{Path(args[0]).name} exit {proc.returncode}: {err.strip()[:300]}")
        return out


def exists(path):
    # Only ENOENT means absent. lstat counts a dangling symlink as present.
    try:
        path.lstat()
        return True
    except FileNotFoundError:
        return False


def read(path):
    if not exists(path):
        return None
    # A FIFO or device where a hold should be is unreadable, not a blocking read.
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    with os.fdopen(fd, encoding="utf-8") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("not a regular file")
        return stream.read()


def fields(text):
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)


def shell(script, *args):
    return command(["/bin/bash", "-eu", "-c", script, "lane-publish", *map(str, args)])


def parse_windows(windows):
    """The VM launcher's format, rejecting its silently ignored bad input."""
    parsed = windows.replace(",", " ").split()
    for window in parsed:
        if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d", window):
            raise ValueError(f"window invalid: {window}")
        if window[:5] == window[6:]:
            raise ValueError(f"window invalid (empty): {window}")
    return parsed


def active_windows(windows, now):
    """Which windows hold now, by the VM launcher's reader."""
    active = []
    for window in parse_windows(windows):
        result = shell('source "$1"; pause_windows=$2; clock=$3; date() { echo "$clock"; }; '
                       'if in_pause_window; then echo active; fi',
                       HERE / "vm/lane-reads.sh", window, now.strftime("%H%M"))
        if result.strip() == "active":
            active.append(window)
    return active


def minute_stamp(moment):
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%MZ")


def daily(start, end, now):
    """The occurrences of a daily window (minutes after midnight UTC, wrapping when end < start) around now."""
    midnight = now.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    length = dt.timedelta(minutes=(end - start) % 1440)
    for day in (-1, 0, 1):
        begin = midnight + dt.timedelta(days=day, minutes=start)
        yield begin, begin + length


def clock_minutes(hhmm):
    return int(hhmm[:2]) * 60 + int(hhmm[3:5])


def lane_held_reason(window):
    return f"lane held window {window} (UTC)"


def vm_pause_reason(window):
    return f"VM pause window {window} (UTC)"


def verdict(home, now):
    reasons = []
    answer = {"host": "free", "vm": "free"}
    logs = home / "Library/Logs/ci-kit"

    def hold(lanes, reason):
        for lane in lanes:
            answer[lane] = "held"
        reasons.append(reason)

    def check(lanes, label, reader):
        try:
            for reason in reader():
                hold(lanes, reason)
        except Exception as error:
            hold(lanes, f"cannot read {label}: {error}")

    both = ("host", "vm")

    def quiet():
        if read(home / ".local/state/ci-quiet") is None:
            return []
        text = shell('source "$1"; _publish_clock=$2; _publish_instant=$3; '
                     'date() { case "$*" in "-u +%H:%M") echo "$_publish_clock";; '
                     '"-u +%Y-%m-%dT%H:%MZ") echo "$_publish_instant";; *) return 1;; esac; }; '
                     'quiet_read; printf "%s\\n%s" "$quiet_windows" "$quiet_invalid"',
                     HERE / "hooks/quiet.sh", now.strftime("%H:%M"), now.strftime("%Y-%m-%dT%H:%MZ"))
        windows, invalid = text.split("\n", 1)
        return ([windows] if windows else []) + ([f"quiet file invalid: {invalid}"] if invalid else [])

    check(both, "ci-quiet", quiet)

    def coordinator():
        text = read(home / ".local/state/ci-hold")
        if text is None:
            return []
        data = fields(text)
        until = dt.datetime.fromisoformat(data["until"].replace("Z", "+00:00"))
        if until.tzinfo is None:
            raise ValueError("until has no timezone")
        return [f"ci-hold: {data.get('by', 'coordinator')} until {data['until']}"] if until > now else []

    check(both, "ci-hold", coordinator)

    def claims_and_holds():
        try:
            names = sorted(p.name for p in logs.iterdir())
        except FileNotFoundError:
            return []
        for name in names:
            if name.startswith("vm-claim."):
                def claim(name=name):
                    text = read(logs / name)
                    return [f"measured claim {name}"] if text and text.splitlines()[0].startswith("measured claim since") else []
                check(both, name, claim)
            elif name.startswith("vm-hold.") and not name.endswith(".tmp"):
                # Existence holds even if the owner cannot write readable contents.
                check(("vm",), name, lambda name=name: [f"VM hold {name[len('vm-hold.'):]}"] if exists(logs / name) else [])
        return []

    check(both, "claims/holds directory", claims_and_holds)
    check(both, "runner-drained", lambda: ["dialog watcher drain"] if exists(logs / "runner-drained") else [])
    check(both, "lane held windows", lambda: [lane_held_reason(w) for w in active_windows(
        os.environ.get("CI_KIT_LANE_HELD_WINDOWS", DEFAULT_WINDOWS), now)])

    def pause():
        text = read(logs / "vm-pause")
        if text is None:
            return []
        data = fields(text)
        until = data.get("until", "")
        if not data.get("reason") or not (until == "none" or re.fullmatch(r"[0-9]+", until)):
            raise ValueError("vm-pause invalid")
        if until == "none" or int(until) > now.timestamp():
            return [f"vm-pause: {data['reason']}: {data.get('why', '')}"]
        return []

    check(("vm",), "vm-pause", pause)

    def vm_config():
        text = read(home / f"Library/LaunchAgents/{VM_AGENT}.plist")
        if text is None:
            return ["VM lane not installed"]
        config = plistlib.loads(text.encode())
        windows = config.get("EnvironmentVariables", {}).get("CI_KIT_VM_PAUSE_WINDOWS", "")
        return [vm_pause_reason(w) for w in active_windows(windows, now)]

    check(("vm",), "VM launcher configuration", vm_config)
    domain = f"gui/{os.getuid()}"

    def host_loaded():
        command(["launchctl", "print", f"{domain}/{HOST_AGENT}"])
        return []

    check(("host",), "host launcher", host_loaded)

    def vm_running():
        text = command(["launchctl", "print", f"{domain}/{VM_AGENT}"])
        return [] if re.search(r"^\s*pid = [1-9][0-9]*\s*$", text, re.M) else ["VM launcher not running"]

    check(("vm",), "VM launcher", vm_running)
    answer["why"] = "; ".join(" ".join(reason.split()) for reason in reasons)
    return answer


def upcoming(home, now):
    """Windows active now or starting within HORIZON, so a planner sees a hold coming. Its own child reads them after
    the verdict: no failure here reaches host, vm or why, each source's own reader there decides the hold. A source
    that cannot be read, or a malformed declaration or setting, holds through the verdict and announces nothing."""
    windows = []
    minute = now.astimezone(UTC).replace(second=0, microsecond=0)
    both = ("host", "vm")

    def announce(lanes, begin, end, reason):
        if end > minute and begin <= minute + HORIZON:
            windows.append({"from": minute_stamp(begin), "until": minute_stamp(end), "lanes": list(lanes),
                            "why": " ".join(reason.split())})

    def clock(lanes, spec, reason):
        for window in parse_windows(spec):
            for begin, end in daily(clock_minutes(window[:5]), clock_minutes(window[6:]), now):
                announce(lanes, begin, end, reason(window))

    def quiet():
        if read(home / ".local/state/ci-quiet") is None:
            return
        for entry in shell('source "$1"; quiet_list', HERE / "hooks/quiet.sh").splitlines():
            kind, begin, end, line = entry.split("\t", 3)
            reason = f"quiet window {line}"
            if kind == "daily":
                for start, stop in daily(int(begin), int(end), now):
                    announce(both, start, stop, reason)
            else:
                announce(both, *(dt.datetime.fromisoformat(t.replace("Z", "+00:00")) for t in (begin, end)), reason)

    def vm_pause():
        text = read(home / f"Library/LaunchAgents/{VM_AGENT}.plist")
        if text is None:
            return
        config = plistlib.loads(text.encode())
        clock(("vm",), config.get("EnvironmentVariables", {}).get("CI_KIT_VM_PAUSE_WINDOWS", ""), vm_pause_reason)

    for source in (quiet, lambda: clock(both, os.environ.get("CI_KIT_LANE_HELD_WINDOWS", DEFAULT_WINDOWS),
                                        lane_held_reason), vm_pause):
        try:
            source()
        except Exception:
            pass
    return sorted(windows, key=lambda w: (w["from"], w["until"], w["why"]))


def valid_window(window):
    return (isinstance(window, dict) and set(window) == {"from", "until", "lanes", "why"}
            and all(isinstance(window[k], str) for k in ("from", "until", "why"))
            and window["lanes"] in (["host", "vm"], ["vm"]))


def compute(now):
    # A failed/hung filesystem read or reader crash still produces a held heartbeat.
    try:
        value = json.loads(command([sys.executable, "-I", str(HERE / "lane-publish.py"),
                                    "--verdict", stamp(now)], timeout=20))
        if (not isinstance(value, dict) or set(value) != {"host", "vm", "why"}
                or value["host"] not in ("held", "free") or value["vm"] not in ("held", "free")
                or not isinstance(value["why"], str)):
            raise ValueError("invalid verdict")
    except Exception as error:
        value = {"host": "held", "vm": "held", "why": f"cannot compute lane verdict: {error}"}
    # A failed windows read omits the field (unknown), rather than publishing [] (nothing coming).
    try:
        windows = json.loads(command([sys.executable, "-I", str(HERE / "lane-publish.py"),
                                      "--windows", stamp(now)], timeout=10))
        if isinstance(windows, list) and all(valid_window(w) for w in windows):
            value["windows"] = windows
    except Exception:
        pass
    return value


def log(home, now, text):
    line = f"{stamp(now)} lane-publish: {' '.join(text.split())}\n"
    try:
        path = home / "Library/Logs/ci-kit/lane-publish.log"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a") as stream:
            stream.write(line)
    except OSError:
        sys.stderr.write(line)


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    staged = path.with_suffix(".tmp")
    staged.write_text(json.dumps(state))
    staged.replace(path)


def main(now=None):
    now = now or dt.datetime.now(UTC)
    home = Path.home()
    try:
        config = fields(read(home / "actions-runner-maws/.env") or "")
        machine = os.environ.get("CI_KIT_MACHINE")
        if not machine or config.get("CI_KIT_MACHINE") != machine or config.get("CI_KIT_PUBLISH_LANES") != "1":
            raise ValueError("runner is not opted in for this publisher's machine identity")
    except (OSError, ValueError) as error:
        log(home, now, f"publish refused: {error}")
        return
    current = compute(now)
    value = {"v": 1, "at": stamp(now), **current}
    state_file = home / "Library/Logs/ci-kit/lane-publish-state.json"
    try:
        state = json.loads(read(state_file) or "{}")
        if not isinstance(state, dict):
            state = {}
    except (OSError, ValueError):
        state = {}
    previous = state.get("value")
    try:
        age = now.timestamp() - dt.datetime.fromisoformat(previous["at"].replace("Z", "+00:00")).timestamp()
    except (KeyError, TypeError, ValueError, AttributeError):
        previous, age = {}, 120
    # The log records verdict changes; a window coming into view republishes (below) without one.
    seen = {k: current[k] for k in ("host", "vm", "why")}
    if state.get("seen") != seen:
        log(home, now, f"host={value['host']} vm={value['vm']}: {value['why']}")
        state["seen"] = seen
        try:
            save_state(state_file, state)
        except OSError as error:
            log(home, now, f"publish failed to save observed verdict: {error}")
    try:
        # repo.sh owns the setting; preflight catches an inaccessible .env rather than accepting its fallback.
        read(home / "actions-runner-maws/.env")
        repo = shell('source "$1"; ci_kit_repo', HERE / "repo.sh").strip()
        changed = any(previous.get(k) != current.get(k) for k in {*current, *previous} - {"v", "at"})
        if not changed and state.get("repo") == repo and 0 <= age < 60:
            return
        env = {k: v for k, v in os.environ.items() if k not in ("GH_TOKEN", "GITHUB_TOKEN")}
        args = ["-f", "name=MAC_MINI_LANES", "-f", "value=" + json.dumps(value, separators=(",", ":"))]
        endpoint = f"repos/{repo}/actions/variables"
        try:
            command(["gh", "api", "-X", "PATCH", endpoint + "/MAC_MINI_LANES", *args], timeout=15, env=env)
        except RuntimeError as error:
            if "(HTTP 404)" not in str(error):
                raise
            command(["gh", "api", "-X", "POST", endpoint, *args], timeout=15, env=env)
        state.update(repo=repo, value=value)
        save_state(state_file, state)
    except Exception as error:
        log(home, now, f"publish failed: {error}")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] in ("--verdict", "--windows"):
        # compute() already owns this group; a direct diagnostic invocation must
        # own one too before a reader timeout is allowed to kill the group.
        if os.getpgrp() != os.getpid():
            os.setpgid(0, 0)
        reader_child = True
        reader = verdict if sys.argv[1] == "--verdict" else upcoming
        print(json.dumps(reader(Path.home(), dt.datetime.fromisoformat(sys.argv[2].replace("Z", "+00:00")))))
    else:
        main()
