# Validation

What the regression suite runs and what the latest complete local run produced. Install the prerequisites in the [setup guide](README.md#setup) first; every command runs from the repository root.

## Commands

```sh
dotnet build Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj -c Release -p:JellyfinTarget=jf12
dotnet build Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj -c Release -p:JellyfinTarget=jf10
python3 tests/run.py fast
python3 tests/run.py browser
python3 tests/runner/poster.py
python3 tests/run.py mutation --target jf12
python3 tests/run.py history
python3 tests/run.py host --target jf10
python3 tests/run.py host --target jf12
```

`python3 tests/run.py all` runs the same stages in one go. Each stage writes its command, exit status, duration and log path to `artifacts/regression/summary.json`.

## Latest results

All stages passed with no failed or skipped tests.

| Stage | Result |
| --- | --- |
| Plugin build, jf12 (.NET 10) and jf10 (.NET 9) | 0 warnings, 0 errors |
| Inventory freshness | Current |
| Tooling false-green checks | 9 passed |
| Backend, Jellyfin 10.11 / .NET 9 | 764 passed |
| Backend, Jellyfin 12 / .NET 10 | 764 passed |
| Backend coverage | jf10 48.56% lines / 36.59% branches; jf12 48.57% / 36.62% (floors 47% / 35%) |
| Frontend, instrumented production modules | 371 passed (Node 26.2.0 and the CI's Node 22.14.0) |
| Frontend coverage | 31.29% statements, 22.64% branches, 31.86% functions, 32.9% lines (floors 28% / 20% / 29% / 30%) |
| Browser, Chromium desktop/mobile and Firefox | 39 passed, including 3 unchanged visual baselines |
| Native poster pipeline | 140 checks passed |
| JavaScript/C# poster parity | 39 setting profiles × 101 fixtures matched, plus one empty-profile check; 115,960 language names and 31,676 casing strings matched (Node 26.2.0, ICU 78.3) |
| Native assets | 253 flags decoded and HarfBuzz shaping passed on Skia 3.116.1 and 3.119.4 |
| Mutation checks, jf12 | 4 of 4 faults detected, with passing baseline and restored runs |
| Historical fault replay | 13 historical faults (9 JavaScript, 4 backend on each target): all 17 experiments detected the fault and passed again once restored |
| Real Jellyfin hosts | Jellyfin 10.11.11 and 12.0 each passed 47 checks: 45 HTTP scenarios plus real Chromium login, panel save and reload as a regular and as an admin user |

Coverage counts every production module, including ones no test loads. It guards against regressions; it is not a measure of behavioral completeness. The [coverage matrix](coverage-matrix.md) lists what is tested and what is not.

## Not covered by these runs

Native clients, complete playback on a media-playing host, every page's layout and accessibility, and the feature combinations listed as gaps in the coverage matrix. Maintenance recovery's cross-store limits are described in [maintenance recovery](maintenance-recovery.md).
