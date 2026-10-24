#!/usr/bin/env python3
"""Clone-scoped runner credentials. gh uses the host user's login, never a job token.

Only config is secret; all files are private and outside out/. The nonsecret record
is written before POST so recovery can find a registration even if its reply was
lost. Delete runs only after the caller has verified the clone's end.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import sys


class Failure(Exception):
    pass


def api(repo, path, method="GET", body=None):
    env = {k: v for k, v in os.environ.items() if k not in ("GH_TOKEN", "GITHUB_TOKEN", "GH_DEBUG")}
    args = [env.get("CI_KIT_GH_BIN", "gh"), "api", f"repos/{repo}/actions/runners{path}", "--method", method]
    if body is not None:
        args += ["--input", "-"]
    try:
        result = subprocess.run(args, input=json.dumps(body) if body is not None else None,
                                capture_output=True, text=True, env=env, timeout=10, check=False)
    except subprocess.TimeoutExpired as exc:
        raise Failure(f"{method} timed out after 10 s") from exc
    except OSError as exc:
        raise Failure(f"cannot start gh ({exc.strerror})") from exc
    if result.returncode:
        # Never forward a response or gh's diagnostic: either can contain the config.
        status = re.search(r"HTTP (\d{3})", result.stderr)
        if method == "DELETE" and status and status[1] == "404":
            return None
        reason = f"HTTP {status[1]}" if status else f"gh exit {result.returncode}"
        raise Failure(f"{method} failed ({reason})")
    if method == "DELETE":
        return None
    try:
        return json.loads(result.stdout)
    except (ValueError, TypeError) as exc:
        raise Failure(f"{method} returned invalid JSON") from exc


def save(path, value):
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w") as stream:
        stream.write(value)
    temporary.replace(path)


def mint(repo, machine, slot_dir, slot, clone):
    directory = slot_dir / "jit" / clone
    directory.mkdir(parents=True, mode=0o700)  # never overwrite a clone's credential
    record = {"repo": repo, "name": f"ci-kit-mac-{machine}-{clone}"}
    save(directory / "runner.json", json.dumps(record))
    labels = ["ci-kit-mac-vm-trial"] if slot == "vm-trial" else ["ci-kit-mac-solo", "ci-kit-mac-vm"]
    reply = api(repo, "/generate-jitconfig", "POST", {
        "name": record["name"], "runner_group_id": 1, "labels": labels, "work_folder": "_work",
    })
    try:
        runner_id = reply["runner"]["id"]
        config = reply["encoded_jit_config"]
        if not isinstance(runner_id, int) or runner_id <= 0 or not isinstance(config, str) or not config:
            raise ValueError()
    except (KeyError, TypeError, ValueError) as exc:
        raise Failure("POST returned no runner id or JIT config") from exc
    record["id"] = runner_id
    save(directory / "runner.json", json.dumps(record))
    save(directory / "config", config)


def delete(slot_dir, clone):
    directory = slot_dir / "jit" / clone
    if not directory.exists():
        return
    # Revoke local access even if GitHub is unavailable; retain only cleanup metadata.
    for name in ("config", "config.tmp"):
        (directory / name).unlink(missing_ok=True)
    record_file = directory / "runner.json"
    if not record_file.exists():
        # The process died before publishing the record, hence before the POST.
        (directory / "runner.json.tmp").unlink(missing_ok=True)
        directory.rmdir()
        return
    record = json.loads(record_file.read_text())
    ids = [record["id"]] if "id" in record else []
    if "id" not in record:
        # A timeout/crash can lose the POST's answer. Find only this clone's name,
        # not the retired persistent slot runners. Bound each page as every API call.
        page = 1
        while True:
            reply = api(record["repo"], f"?per_page=100&page={page}")
            runners = reply["runners"]
            ids.extend(r["id"] for r in runners if r["name"] == record["name"])
            if len(runners) < 100:
                break
            page += 1
    for runner_id in ids:
        api(record["repo"], f"/{int(runner_id)}", "DELETE")
    (directory / "runner.json.tmp").unlink(missing_ok=True)
    record_file.unlink()
    directory.rmdir()


def main():
    os.umask(0o077)
    action, *args = sys.argv[1:]
    try:
        if action == "mint":
            repo, machine, slot_dir, slot, clone = args
            mint(repo, machine, Path(slot_dir), slot, clone)
        elif action == "delete":
            slot_dir, clone = args
            delete(Path(slot_dir), clone)
        else:
            raise Failure("unknown operation")
    except (Failure, OSError, ValueError, KeyError, TypeError) as exc:
        # Parsing exceptions can embed input, which could be credential-bearing.
        reason = str(exc) if isinstance(exc, Failure) else f"local state error ({type(exc).__name__})"
        print(f"JIT {action}: {reason}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
