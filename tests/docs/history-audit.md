# Historical regression audit — 2026-10-05

The public GitHub API returned **849 issue/PR records: 522 issues and 327 pull requests**, through #910. All received initial triage; selected bugs received detailed source/test comparison and reproducible fault replay. This is not 849 reproduced bugs, an exhaustive comment/attachment review, or a historical detection percentage. Many applicable reports still lack demonstrated coverage.

Per-record assessments and limitations: [1–349](history-early.md), [350–649](history-middle.md), [650–910](history-recent.md). The ignored raw snapshot is `artifacts/history-audit/issues.json`; durable ledgers retain source links. Closed issues/PRs are not assumed fixed, merged, or relevant to current hosts. Feature, dependency, translation and deployment records are distinguished from reproducible runtime faults.

## What the previous tests would catch

| Source | Existing assertion | Evidence and limits |
| --- | --- | --- |
| [#823 / #825](https://github.com/n00bcodr/Jellyfin-Enhanced/pull/825) | `ApiCdnRefreshTests.FullKnownAssetRefreshContinuesAfterHttpTimeoutAndReportsCompletion` | Exact reversal of the cancellation catch filter makes a simulated HTTP timeout abort refresh. The test fails with `TaskCanceledException`; current/restored code completes the sweep. |
| [#861 / #873](https://github.com/n00bcodr/Jellyfin-Enhanced/pull/873) | `UrlPolicyTests.ContainerAliasesPermitPodmanLinkLocalWithoutPermittingCloudMetadata` | Representative removal of the container-alias exception fails Podman's link-local cases. Tests inject resolved addresses into the actual policy; no real Podman DNS fixture is claimed. |
| [#900](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/900) | `ApiSeerrTests.RequestsUsePrincipalIdentityPreserveSeasonSelectionAndGateAdvancedOptions` | Removing advanced-field stripping fails the outgoing-payload assertion. This proves backend enforcement, not the report's complete modal-visibility journey. |
| [#513 / #519](https://github.com/n00bcodr/Jellyfin-Enhanced/pull/519) | Existing translation language-fallback test | Reversing primary-language candidate insertion fails fallback behavior. |
| [#774](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/774) | Existing bookmark episode/season matching test | Removing the historical matching guard fails with bookmarks from other episodes. Player timeline integration remains separate. |

## Blind spots found and repaired

**The original 323-test frontend suite passed with three historical faults restored:** pending-season approval controlled by media availability, accumulated request-page click listeners, and stereo-first audio badge selection. New tests fail each fault. See [recent audit](history-recent.md) and `artifacts/history-audit/recent-prior-suite/` for original-suite survivor evidence.

**The original native poster pipeline also passed with Jellium Desktop removed from the web-client exclusions**, exactly reversing [PR #906](https://github.com/n00bcodr/Jellyfin-Enhanced/pull/906). Its test iterates the production list, so a missing entry disappears from both behavior and expectations. New `HistoryNativeClientTests` uses independently specified client names through the real claims-based policy and fails that reversal. Old pipeline baseline/fault/restored logs are in `artifacts/history-audit/jellium-original-harness/`; all three exited 0, demonstrating that specific gap. This does not claim every other suite also survived.

Additional new tests cover Command-R versus random selection, subtitle-sheet toggling, disabled auto-pause, reverse-proxy avatar URLs/authentication, concurrent avatar download deduplication/cleanup, and preserving Jellyfin's native subtitle stylesheet. **Nine frontend tests and thirteen backend cases were added.** Subtitle-sheet and auto-pause scenarios pass current code but were not replayed against their historical faults. No JE production source needed modification in this audit.

## Repeatable evidence

```sh
python3 tests/run.py fast --artifacts artifacts/history-audit/integrated
python3 tests/run.py history --artifacts artifacts/history-audit/history-suite
```

`history` runs **13 distinct fault scenarios**: nine JavaScript cases and four backend cases on each build target, for 17 baseline/fault/restored experiments. Each must pass first, fail the selected test with the expected failure signature after mutation, and pass after restoration. Compilation errors and zero selected tests do not count. Manifests in `tests/history/*-mutations.json` record source links and exact-reversal versus representative-fault distinctions. Current-code tests run normally in PR suites; historical replay is part of `all` and scheduled/manual extended CI.

The runner copies local sources into temporary storage, rejects absolute/traversing manifest paths, checks targets remain inside the copy, and never modifies live production source. Two tooling tests guard empty-case false success and escaping the disposable checkout. Historical proofs require no GitHub access after setup. Nothing was committed, pushed or posted upstream.

## Remaining work

Ledgers retain hundreds of unproven candidates. High-value gaps include composite Seerr fixes, admin configuration/reverse-proxy styling, restricted calendar libraries, tag-cache lifecycle/scale, React-owned search DOM, Moonfin header nesting, native-client behavior, and the open Edge/Windows Picture-in-Picture report. Linux jsdom or Chromium tests cannot establish recovery of Edge's native video surface.

Selected historical experiments establish sensitivity to those faults only. They do not make the broader regression-testing goal complete or convert line coverage into complete behavioral coverage. See [validation](validation.md) for execution results and the distinction between this follow-up and the earlier full-host/fresh-tree run.
