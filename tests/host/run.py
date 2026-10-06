#!/usr/bin/env python3
"""Real Jellyfin smoke tests. Every resource belongs to this invocation."""
import argparse
import json
import os
import ipaddress
import pathlib
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import wave

ROOT = pathlib.Path(__file__).resolve().parents[2]
IMAGES = {
    "jf10": "jellyfin/jellyfin:10.11.11@sha256:aefb67e6a7ff1debdd154a78a7bbb780fd0c873d8639210a7f6a2016ad2b35db",
    "jf12": "jellyfin/jellyfin:12.0@sha256:baba630419915985442f315f08b0cf46d9f4c8a0cc4bd38e94a6d35751dd5ef5",
}
PLUGIN_ID = "f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b"
# Every container and network carries this label (value: the run's unique name).
LABEL = "je-regression.run"


def command(*args, **kwargs):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kwargs)
    if result.returncode:
        raise RuntimeError(f"{args[0]} {args[1] if len(args) > 1 else ''} failed: {result.stdout.strip()}")
    return result.stdout.strip()


def owned(*args):
    """Run a command against this invocation's own resource; a resource that was never created is not an error.

    Returns the output, or None when Docker reports no such object."""
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if result.returncode:
        if "No such" in result.stdout or "not found" in result.stdout:
            return None
        raise RuntimeError(f"{' '.join(args[:3])} failed: {result.stdout.strip()}")
    return result.stdout.strip()


def create_network(name):
    """Create the internal test network on the first free /28, retrying when a concurrent run takes it first."""
    network_ids = command("docker", "network", "ls", "-q").splitlines()
    existing = json.loads(command("docker", "network", "inspect", *network_ids))
    allocated = [ipaddress.ip_network(entry["Subnet"]) for network in existing
                 for entry in (network.get("IPAM", {}).get("Config") or []) if entry.get("Subnet")]
    for candidate in ipaddress.ip_network("10.253.0.0/16").subnets(new_prefix=28):
        if any(candidate.overlaps(used) for used in allocated if used.version == 4):
            continue
        result = subprocess.run(["docker", "network", "create", "--internal", "--label", f"{LABEL}={name}",
                                 "--subnet", str(candidate), name], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if result.returncode == 0:
            return candidate
        if "overlap" not in result.stdout.lower():
            raise RuntimeError(f"docker network create failed: {result.stdout.strip()}")
    raise RuntimeError("No free 10.253.0.0/16 test subnet for the regression network")


class Host:
    def __init__(self, url):
        self.url = url
        self.passed = []

    def request(self, path, method="GET", body=None, token=None, expected=200):
        headers = {"Authorization": 'MediaBrowser Client="JE regression", Device="isolated host", DeviceId="je-tests", Version="1.0"'}
        if token:
            headers["Authorization"] += f', Token="{token}"'
        data = None if body is None else json.dumps(body).encode()
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.url + path, data=data, headers=headers, method=method)
        try:
            response = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read().decode()
            assert response.status == expected, f"{method} {path}: expected {expected}, got {response.status}: {raw[:400]}"
            if response.headers.get_content_type() == "application/json" and raw:
                return json.loads(raw)
            return raw

    def ready(self):
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            try:
                self.request("/JellyfinEnhanced/version")
                return
            except (OSError, AssertionError):
                time.sleep(0.5)
        raise AssertionError("Jellyfin did not become ready within 180 seconds; see server.log")

    def check(self, label, action):
        action()
        self.passed.append(label)
        print(f"  PASS {label}", flush=True)


def run(target, artifacts, browser=False):
    output = artifacts / target
    output.mkdir(parents=True, exist_ok=True)
    name = "je-regression-" + uuid.uuid4().hex[:12]
    host = None
    with tempfile.TemporaryDirectory(prefix=name) as temporary:
        temp = pathlib.Path(temporary)
        temp.chmod(0o755)
        try:
            print(f"Building {target}", flush=True)
            result = subprocess.run(["dotnet", "build", str(ROOT / "Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj"),
                "-c", "Release", f"-p:JellyfinTarget={target}", "--artifacts-path", str(temp / "build")],
                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            (output / "build.log").write_text(result.stdout)
            assert result.returncode == 0, f"Build failed: {output / 'build.log'}"
            dlls = list((temp / "build/bin").rglob("Jellyfin.Plugin.JellyfinEnhanced.dll"))
            assert len(dlls) == 1, f"Expected one built plugin, found {dlls}"
            plugin = temp / "config/plugins/JellyfinEnhanced"
            plugin.mkdir(parents=True)
            shutil.copyfile(dlls[0], plugin / dlls[0].name)
            media = temp / "media"
            media.mkdir()
            with wave.open(str(media / "Regression Fixture.wav"), "wb") as fixture:
                fixture.setnchannels(1)
                fixture.setsampwidth(2)
                fixture.setframerate(8000)
                fixture.writeframes(b"\x00\x00" * 8000)
            create_network(name)
            (temp / "cache").mkdir()
            command("docker", "run", "-d", "--name", name, "--label", f"{LABEL}={name}", "--network", name,
                    "--user", f"{os.getuid()}:{os.getgid()}",
                    "--volume", f"{temp / 'cache'}:/cache",
                    "--volume", f"{temp / 'config'}:/config",
                    "--volume", f"{media}:/media:ro", "--env", "JELLYFIN_PublishedServerUrl=http://localhost",
                    IMAGES[target])
            inspection = json.loads(command("docker", "inspect", name))[0]
            address = inspection["NetworkSettings"]["Networks"][name]["IPAddress"]
            host = Host("http://" + address + ":8096")
            host.ready()
            password = "Regression-only-" + uuid.uuid4().hex
            host.request("/Startup/Configuration", "POST", {"UICulture": "en-US", "MetadataCountryCode": "US", "PreferredMetadataLanguage": "en"}, expected=204)
            host.request("/Startup/User")
            host.request("/Startup/User", "POST", {"Name": "regression-admin", "Password": password}, expected=204)
            host.request("/Startup/RemoteAccess", "POST", {"EnableRemoteAccess": False, "EnableAutomaticPortMapping": False}, expected=204)
            host.request("/Startup/Complete", "POST", expected=204)
            def login(username):
                return host.request("/Users/AuthenticateByName", "POST", {"Username": username, "Pw": password})
            admin = login("regression-admin")
            admin_token = admin["AccessToken"]
            users = []
            for username in ("regression-regular", "regression-restricted"):
                user = host.request("/Users/New", "POST", {"Name": username, "Password": password}, admin_token)
                policy = user["Policy"]
                policy.update({"IsAdministrator": False, "EnableRemoteAccess": False})
                if username.endswith("restricted"):
                    policy.update({"EnableAllFolders": False, "EnabledFolders": [], "MaxParentalRating": 1})
                host.request(f"/Users/{user['Id']}/Policy", "POST", policy, admin_token, expected=204)
                users.append(login(username))
            regular, restricted = users
            host.request("/Library/VirtualFolders?name=Regression&collectionType=music&refreshLibrary=true", "POST",
                         {"LibraryOptions": {"PathInfos": [{"Path": "/media"}], "EnableRealtimeMonitor": False,
                          "EnableInternetProviders": False, "SaveLocalMetadata": False}}, admin_token, expected=204)
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                items = host.request("/Items?Recursive=true&IncludeItemTypes=Audio", token=admin_token)["Items"]
                if items:
                    break
                time.sleep(0.5)
            assert len(items) == 1, "Synthetic audio fixture was not scanned"
            item_id = items[0]["Id"]
            def library_access():
                visible = host.request("/Items?Recursive=true&IncludeItemTypes=Audio", token=regular["AccessToken"])["Items"]
                hidden = host.request("/Items?Recursive=true&IncludeItemTypes=Audio", token=restricted["AccessToken"])["Items"]
                assert any(item["Id"] == item_id for item in visible), "Regular user lost fixture access"
                assert not hidden, "Restricted user can enumerate a disabled library"
            host.check("generated media scan and restricted library isolation", library_access)
            prefix = "/JellyfinEnhanced"
            plugin_config_route = f"/Plugins/{PLUGIN_ID}/Configuration"
            configuration = host.request(plugin_config_route, token=admin_token)
            configuration["JellyseerrApiKey"] = "regression-fake-secret-do-not-expose"
            host.request(plugin_config_route, "POST", configuration, admin_token, expected=204)
            def bootstrap_privacy(user):
                payload = host.request(prefix + "/bootstrap", token=user["AccessToken"])
                normalized = {key.lower(): value for key, value in payload.items()}
                assert normalized["userid"].replace("-", "") == user["User"]["Id"].replace("-", "")
                assert normalized.get("privateconfig") is None
                assert "regression-fake-secret-do-not-expose" not in json.dumps(payload)
                assert normalized["componentscripts"], "Bootstrap must enumerate production scripts"
                assert host.request(prefix + "/private-config", token=user["AccessToken"]) == {}

            def compatibility():
                info = host.request(prefix + "/host-compat", token=admin_token)
                assert info["mismatch"] is False, info
                assert info["builtFor"] == info["hostTarget"], info
            host.check("plugin loads and matches host runtime", compatibility)
            def web_injection():
                html = host.request("/web/index.html")
                assert html.count("/JellyfinEnhanced/script") == 1, "Web index must inject the JE loader exactly once"
            host.check("Jellyfin web index script injection", web_injection)
            def asset(path):
                value = host.request(prefix + path)
                assert value, "Embedded resource is empty: " + path
            for path in ("/script", "/js/component-scripts.json", "/locales/en.json", "/Configuration/configPage.css"):
                host.check("embedded asset " + path, lambda path=path: asset(path))
            host.check("anonymous bootstrap denied", lambda: host.request(prefix + "/bootstrap", expected=401))
            for user in users:
                token, uid = user["AccessToken"], user["User"]["Id"]
                host.check("bootstrap " + user["User"]["Name"], lambda user=user: bootstrap_privacy(user))
                for path in ("/host-compat", "/admin/hidden-content-users", "/reviews/admin/all"):
                    host.check("non-admin denied " + user["User"]["Name"] + path,
                               lambda path=path, token=token: host.request(prefix + path, token=token, expected=403))
                for document in ("settings", "shortcuts", "elsewhere", "bookmark", "hidden-content", "spoilerblur"):
                    other = admin["User"]["Id"]
                    route = f"{prefix}/user-settings/{other}/{document}.json"
                    host.check("cross-user read denied " + user["User"]["Name"] + document,
                               lambda route=route, token=token: host.request(route, token=token, expected=403))
                    host.check("cross-user write denied " + user["User"]["Name"] + document,
                               lambda route=route, token=token: host.request(route, "POST", {}, token, expected=403))
            route = f"{prefix}/user-settings/{regular['User']['Id']}/settings.json"
            saved = host.request(route, token=regular["AccessToken"])
            # Production's JSON contract uses camelCase for user settings.
            setting_key = next(key for key in saved if key.lower() == "autopauseenabled")
            restricted_route = f"{prefix}/user-settings/{restricted['User']['Id']}/settings.json"
            restricted_before = host.request(restricted_route, token=restricted["AccessToken"])
            saved[setting_key] = not saved[setting_key]
            host.check("save own preferences", lambda: host.request(route, "POST", saved, regular["AccessToken"]))
            def persisted():
                actual = host.request(route, token=regular["AccessToken"])
                assert actual[setting_key] == saved[setting_key]
                other = host.request(restricted_route, token=restricted["AccessToken"])
                assert other == restricted_before, "Saving one user changed another user's preferences"
            host.check("read back own preferences", persisted)
            command("docker", "restart", name)
            host.ready()
            host.check("plugin reload after restart", compatibility)
            host.check("preferences persist across restart", persisted)
            host.check("restricted library policy persists across restart", library_access)
            if browser:
                result = subprocess.run(["node", str(ROOT / "tests/host/browser.mjs")],
                    input=json.dumps({"url": host.url, "password": password, "artifacts": str(output),
                                      "users": ["regression-regular", "regression-admin"]}),
                    text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=ROOT)
                (output / "browser.log").write_text(result.stdout.replace(password, "[REDACTED]"))
                assert result.returncode == 0, f"Real browser journey failed: {output / 'browser.log'}"
                host.passed.append("real Chromium regular/admin login, panel and preference persistence")
                print(result.stdout, flush=True)
            (output / "report.json").write_text(json.dumps({"target": target, "image": IMAGES[target], "passed": host.passed, "status": "passed"}, indent=2))
        except BaseException as error:
            (output / "report.json").write_text(json.dumps({"target": target, "image": IMAGES[target], "passed": host.passed if host else [], "status": "failed", "error": str(error)}, indent=2))
            raise
        finally:
            # Attempt all cleanup even if log collection or one removal fails, and
            # whether or not creation reported success: a create that failed or was
            # interrupted part-way can still leave the uniquely named resource behind.
            cleanup_errors = []
            try:
                logs = owned("docker", "logs", name)
                if logs is not None:
                    for value in locals().get("users", []) + ([locals()["admin"]] if "admin" in locals() else []):
                        logs = logs.replace(value["AccessToken"], "[REDACTED]")
                    if "password" in locals():
                        logs = logs.replace(password, "[REDACTED]")
                    (output / "server.log").write_text(logs)
            except Exception as error:
                cleanup_errors.append(str(error))
            for removal in (("docker", "rm", "-f", name), ("docker", "network", "rm", name)):
                try:
                    owned(*removal)
                except Exception as error:
                    cleanup_errors.append(str(error))
            if cleanup_errors:
                report_path = output / "report.json"
                report = json.loads(report_path.read_text()) if report_path.exists() else {"target": target}
                report.update({"status": "failed", "cleanup_errors": cleanup_errors})
                report_path.write_text(json.dumps(report, indent=2))
                raise RuntimeError("Cleanup failed: " + "; ".join(cleanup_errors))



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=["all", *IMAGES], default="all")
    parser.add_argument("--artifacts", type=pathlib.Path, default=ROOT / ".engineering-artifacts/host")
    parser.add_argument("--browser", action="store_true", help="Run real Chromium login/settings journeys; requires npm ci and Playwright Chromium")
    args = parser.parse_args()
    def terminate(signum, frame):
        raise KeyboardInterrupt("Termination requested; cleaning owned test resources")
    signal.signal(signal.SIGTERM, terminate)
    for binary in ("dotnet", "docker"):
        if not shutil.which(binary):
            parser.error(f"{binary} is required; install .NET 10 SDK and start Docker")
    command("docker", "info", "--format", "{{.ServerVersion}}")
    failures = []
    for target in IMAGES if args.target == "all" else [args.target]:
        try:
            run(target, args.artifacts.resolve(), args.browser)
        except Exception as error:
            print(f"FAIL {target}: {error}", flush=True)
            failures.append(target)
    return bool(failures)


if __name__ == "__main__":
    raise SystemExit(main())
