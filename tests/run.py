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

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("suite", choices=["fast", "tooling", "backend", "frontend", "browser", "visual", "host", "poster", "mutation", "history", "all"], nargs="?", default="fast")
    parser.add_argument("--target", choices=["jf10", "jf12", "all"], default="all")
    parser.add_argument("--artifacts", type=Path, default=ROOT / "artifacts" / "regression")
    args = parser.parse_args()
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
                process = subprocess.Popen(list(map(str, command)), cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
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

    def prerequisite_error(message):
        results.append({"name": "prerequisites", "status": "failed", "exit_code": 127, "error": message})
        (artifacts / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
        parser.error(message)

    required = set()
    if "tooling" in suites:
        required.add("node")
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

    if args.suite in ["fast", "all"]:
        execute("inventory", [sys.executable, "tests/inventory/generate.py", "--check"])
    for suite in suites:
        if suite == "tooling":
            execute("tooling", [sys.executable, "-m", "unittest", "discover", "-s", "tests/runner/tests", "-v"])
        elif suite == "backend":
            for target in targets:
                results_path = artifacts / "backend" / target
                if results_path.exists():
                    shutil.rmtree(results_path)
                if execute("backend-" + target, ["dotnet", "test", "tests/backend/JE.Tests.csproj", "-c", "Release", "-p:JellyfinTarget=" + target, "-p:RestoreLockedMode=true", "--artifacts-path", artifacts / "build" / target, "--results-directory", results_path, "--logger", "trx", "--collect:XPlat Code Coverage"]):
                    execute("coverage-" + target, [sys.executable, "tests/runner/coverage.py", results_path])
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
