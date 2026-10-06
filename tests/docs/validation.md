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
| Tooling false-green checks | 8 passed |
| Backend, Jellyfin 10.11 / .NET 9 | 717 passed |
| Backend, Jellyfin 12 / .NET 10 | 717 passed |
| Backend coverage | jf10 48.30% lines / 36.27% branches; jf12 48.31% / 36.30% (floors 47% / 35%) |
| Frontend, instrumented production modules | 344 passed |
| Frontend coverage | 29.47% statements, 21.30% branches, 30.27% functions, 30.95% lines (floors 28% / 20% / 29% / 30%) |
| Browser, Chromium desktop/mobile and Firefox | 39 passed, including 3 unchanged visual baselines |
| Native poster pipeline | 140 checks passed |
| JavaScript/C# poster parity | 40 profiles × 101 fixtures matched; 115,556 language names and 31,676 casing strings matched (Node 26.2.0, ICU 78.3) |
| Native assets | 253 flags decoded and HarfBuzz shaping passed on Skia 3.116.1 and 3.119.4 |
| Mutation checks, jf12 | 4 of 4 faults detected, with passing baseline and restored runs |
| Historical fault replay | 13 historical faults (9 JavaScript, 4 backend on each target): all 17 experiments detected the fault and passed again once restored |
| Real Jellyfin hosts | Jellyfin 10.11.11 and 12.0 each passed 46 checks: 45 HTTP scenarios plus real Chromium regular/admin login, panel save and reload |

Coverage counts every production module, including ones no test loads. It guards against regressions; it is not a measure of behavioral completeness. The [coverage matrix](coverage-matrix.md) lists what is tested and what is not.

## Not covered by these runs

Native clients, complete playback on a media-playing host, every page's layout and accessibility, and the feature combinations listed as gaps in the coverage matrix. Maintenance recovery's cross-store limits are described in [maintenance recovery](maintenance-recovery.md).
