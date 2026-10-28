#!/usr/bin/env python3
"""Run JE regression suites with explicit prerequisites and machine-readable outcomes."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
from runner.preflight import check as check_preflight

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("suite", choices=["fast", "tooling", "backend", "frontend", "browser", "visual", "host", "poster", "mutation", "history", "all"], nargs="?", default="fast")
    parser.add_argument("--target", choices=["jf10", "jf12", "all"], default="all")
    parser.add_argument("--artifacts", type=Path, default=ROOT / "artifacts" / "regression")
    parser.add_argument("--backend-shards", type=int, choices=[1, 2, 3, 4], default=int(os.environ.get("JE_BACKEND_SHARDS", "1")))
    parser.add_argument("--speed-profile", action="store_true", help="Opt into bounded workers, frontend text caching and fail-fast prerequisites")
    parser.add_argument("--preflight-witnesses", action="store_true", help="Stop incomplete on a known-failing backend witness")
    parser.add_argument("--backend-durations", type=Path, help="Previous complete TRX for shard balancing")
    args = parser.parse_args()
    speed_profile = bool(args.speed_profile or args.backend_shards > 1 or args.preflight_witnesses or args.backend_durations)
    suites = {"fast": ["tooling", "backend", "frontend"], "all": ["tooling", "backend", "frontend", "browser", "poster", "host", "mutation", "history"]}.get(args.suite, [args.suite])
    artifacts = args.artifacts.resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    results = []
    (artifacts / "summary.json").write_text("[]\n")
    targets = ["jf10", "jf12"] if args.target == "all" else [args.target]

    def execute(name, command):
        print("\nRunning " + name + ": " + " ".join(map(str, command)), flush=True)
        started = time.monotonic()
        code = 127
        log = artifacts / (name + ".log")
        with log.open("w") as output:
            try:
                process = subprocess.Popen(list(map(str, command)), cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True,
                                           **({"env": {**os.environ, "JE_SPEED_PROFILE": "1"}} if speed_profile else {}))
                try:
                    for line in process.stdout:
                        output.write(line)
                        print(line, end="", flush=True)
                    code = process.wait()
                except KeyboardInterrupt:
                    # Forward cancellation to this suite's process tree so its
                    # own teardown can remove containers/browser fixtures.
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                    code = 130
            except OSError as error:
                output.write(str(error))
                print(error, file=sys.stderr)
        results.append({"name": name, "command": list(map(str, command)), "status": "passed" if code == 0 else "failed", "exit_code": code, "seconds": round(time.monotonic() - started, 2), "log": str(log)})
        (artifacts / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
        if code == 130:
            raise SystemExit(130)
        return code == 0

    def incomplete(message):
        results.append({"name": "suite", "status": "incomplete", "exit_code": 1, "error": message})
        (artifacts / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
        print("INCOMPLETE: " + message, file=sys.stderr)
        return 1

    def prerequisite_error(message):
        results.append({"name": "prerequisites", "status": "failed", "exit_code": 127, "error": message})
        (artifacts / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
        if speed_profile:
            incomplete(message)
        parser.error(message)

    required = set()
    if "tooling" in suites:
        required.update(["node", "npm"] if speed_profile else ["node"])
    if any(s in suites for s in ["backend", "host", "poster", "mutation", "history"]):
        required.add("dotnet")
    if any(s in suites for s in ["frontend", "browser", "visual", "poster", "mutation", "history", "host"]):
        required.update(["node", "npm"])
    if "host" in suites:
        required.add("docker")
    missing = sorted(tool for tool in required if not shutil.which(tool))
    if missing:
        prerequisite_error("Missing prerequisites: " + ", ".join(missing) + ". See tests/docs/README.md.")
    if "npm" in required and not (ROOT / "node_modules").exists():
        prerequisite_error("Missing JavaScript dependencies. Run npm ci first.")

    if speed_profile:
        try:
            check_preflight(ROOT, suites, targets, os.environ)
        except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
            return incomplete("Prerequisite preflight failed: " + str(error))

    if args.suite in ["fast", "all"]:
        ok = execute("inventory", [sys.executable, "tests/inventory/generate.py", "--check"])
        if speed_profile and not ok:
            return incomplete("Inventory preflight failed")
    for suite in suites:
        if suite == "tooling":
            ok = execute("tooling", [sys.executable, "-m", "unittest", "discover", "-s", "tests/runner/tests", "-v"])
            if speed_profile and not ok:
                return incomplete("Tooling preflight failed")
        elif suite == "backend":
            for target in targets:
                results_path = artifacts / "backend" / target
                isolated = bool(args.backend_shards > 1 or args.preflight_witnesses or args.backend_durations)
                if not isolated and results_path.exists():
                    shutil.rmtree(results_path)
                ok = execute("jellyfin-api-" + target, [sys.executable, "tests/backend/jellyfin_api.py", "--target", target])
                if speed_profile and not ok:
                    return incomplete("Pinned Jellyfin prerequisites failed")
                if isolated:
                    command = [sys.executable, "tests/runner/backend.py", "--target", target,
                               "--results", results_path, "--build", artifacts / "build" / target / "snapshot",
                               "--shards", args.backend_shards]
                    if args.preflight_witnesses:
                        command.append("--preflight-witnesses")
                    if args.backend_durations:
                        command.extend(["--durations", args.backend_durations.resolve()])
                else:
                    # Preserve the ordinary command's TRX/collector schema and
                    # paths, including cleanup after an interrupted isolated run.
                    build_path = artifacts / "build" / target
                    shutil.rmtree(build_path / 'snapshot', ignore_errors=True)
                    for name in ('build-identity.json', 'build.log', 'build.lock'):
                        (build_path / name).unlink(missing_ok=True)
                    command = ["dotnet", "test", "tests/backend/JE.Tests.csproj", "-c", "Release",
                               "-p:JellyfinTarget=" + target, "-p:RestoreLockedMode=true",
                               *(["-m:4"] if speed_profile else []),
                               "--artifacts-path", artifacts / "build" / target,
                               "--results-directory", results_path, "--logger", "trx", "--collect:XPlat Code Coverage"]
                if execute("backend-" + target, command):
                    coverage = [sys.executable, "tests/runner/coverage.py", results_path]
                    if args.backend_shards > 1:
                        coverage.extend(["--manifest", results_path / "partitions.json"])
                    execute("coverage-" + target, coverage)
                elif isolated:
                    status_path = results_path / 'status.json'
                    status = json.loads(status_path.read_text()) if status_path.exists() else {'status': 'incomplete'}
                    if status.get('status') == 'incomplete' or args.preflight_witnesses:
                        return incomplete("Backend witness/preflight failed; full suite not completed")
        elif suite == "frontend":
            execute("frontend", ["npm", "run", "test:frontend:coverage"])
        elif suite in ["browser", "visual"]:
            execute(suite, ["npm", "run", "test:" + suite])
        elif suite == "host":
            execute("host", [sys.executable, "tests/host/run.py", "--target", args.target, "--browser", "--artifacts", artifacts / "host"])
        elif suite == "poster":
            execute("poster", [sys.executable, "tests/runner/poster.py", "--artifacts", artifacts / "poster"])
        elif suite == "mutation":
            for target in targets:
                execute("mutation-" + target, [sys.executable, "tests/runner/mutations.py", "--target", target, "--artifacts", artifacts / "mutations" / target])
        elif suite == "history":
            for group in ("early", "middle", "recent"):
                execute("history-" + group, [sys.executable, "tests/runner/mutations.py", "--cases", "tests/history/" + group + "-mutations.json", "--layer", "frontend", "--artifacts", artifacts / "history" / group])
            for target in targets:
                execute("history-backend-" + target, [sys.executable, "tests/runner/mutations.py", "--cases", "tests/history/backend-mutations.json", "--target", target, "--artifacts", artifacts / "history" / target])
    print("\n" + "\n".join(result["name"] + ": " + result["status"] for result in results))
    return 1 if any(result["status"] != "passed" for result in results) else 0


if __name__ == "__main__":
    def cancel(_signal, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, cancel)
    sys.exit(main())
