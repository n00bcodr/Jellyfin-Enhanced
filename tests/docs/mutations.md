# Targeted mutation verification

Historical issue/PR cases are also available via `python3 tests/run.py history`. See the [audit](history-audit.md). To run a specific case group, pass `--cases tests/history/backend-mutations.json` (or the early/middle/recent manifest) to this runner. Manifests use relative checkout paths and identify source provenance and the selected test. Absolute paths, parent traversal, empty case lists and empty layer selections are rejected.

Run from any working directory:

```sh
python3 tests/runner/mutations.py --target jf12
python3 tests/runner/mutations.py --target jf10 --layer backend --artifacts artifacts/mutations-jf10
```

Prerequisites are the .NET SDK/runtime for the selected target (jf12: .NET 10; jf10: .NET 9), Node 22.12 or newer, and `npm ci`. Install current servicing patches for both Microsoft.NETCore.App and Microsoft.AspNetCore.App: a test host built against a newer patch cannot run on an older runtime. A portable installation works by setting PATH and DOTNET_ROOT to its directory. NuGet packages must be cached or available for restore. Use `--layer frontend` for the JavaScript-only checks. The default report location is `artifacts/mutations`; use distinct artifact directories to retain multiple target reports.

The runner copies the current checkout, including uncommitted production files and tests, into a disposable directory managed by Python. It excludes Git metadata, dependencies and build artifacts; JavaScript dependencies are linked read-only by convention and are never installed or modified by the runner. The actual mutations and builds happen exclusively inside the copied tree. It neither commits nor changes production files in the original checkout. Temporary directories are removed on normal completion and exceptions.

For each case the selected test must first pass. The runner then introduces exactly one production fault, requires a failing test with the expected assertion, restores the original copied source, and requires the same test to pass again. A compilation failure, missing test, setup failure, or surviving mutation fails verification. Every command, exit status and log is retained; backend TRX reports are retained too. `summary.json` records the baseline, mutant, and restored outcomes. A nonzero runner exit means verification was not completed successfully.

| Production fault | Regression assertion |
| --- | --- |
| Allow arbitrary explicit user selection | A regular user cannot select another user's identity |
| Allow blocked tags to override parental restrictions | A blocked keyword/genre still denies access when an allowed keyword matches |
| Ignore the cookie-miss negative cache | Repeated forged-cookie requests perform exactly two session scans |
| Accept a hidden-content response from a previous user session | A late response cannot overwrite the incoming user's preferences |

These deliberately selected mutations demonstrate sensitivity of privacy, authorization, parental-policy, and resource-use regressions. They are not an exhaustive mutation score and do not imply that all tests or production branches detect every possible fault. Mutation anchors are checked for exactly one occurrence, so production refactors require explicit review and updates rather than silently testing a different path.
