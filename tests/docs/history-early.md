# Historical issue audit: records 1–349

This audit indexes all **321 available records** in this range: **260 issues and 61 pull requests**. The per-record source links, classification, test links and limitations are in [`early-triage.json`](../../tests/history/early-triage.json). Deleted/missing issue numbers are not invented. The index is an initial triage, not 321 reproduced bugs: substantive report bodies and fix history guided the selected tests; many reports still need comments, an exact patch, or an affected-client fixture before a detection claim is possible.

## Demonstrated historical detection

[Issue #55](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/55) reported that Command-R selected random media instead of refreshing on macOS. [Fix 4f8feb69](https://github.com/n00bcodr/Jellyfin-Enhanced/commit/4f8feb69997749667e08d65a2e933b0999b9bd94) added the missing Meta modifier to shortcut matching.

The new `history issue 55 Command-R preserves browser refresh without selecting random media` test executes the production event module. It asserts that Meta/Ctrl/Alt-R leave the event unconsumed and perform no random selection, while unmodified R still selects. Existing shortcut tests did not explicitly cover this browser shortcut. This is **newly added detection**, not evidence that the previous suite would have caught #55.

The mutation manifest reverses the specific Meta term introduced by that fix in a disposable source copy. Current modifier ordering differs from the old file, so this is an exact reversal of the fixing expression, not a checkout of the entire obsolete application. Results: baseline **pass**, historical fault **assertion failure**, restored source **pass**. Production workspace files were never mutated.

## Two additional report-derived tests

The same [test file](../../tests/frontend/regressions/history-early-events.test.mjs) adds:

- [#1](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/1): pressing S closes an existing subtitle sheet without clicking the opener; a subsequent S opens it. Covers the English Jellyfin sheet title used by current code. Localized sheet labels remain a gap.
- [#163](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/163): disabled automatic pause leaves playback untouched on tab visibility changes; enabled pause resumes only playback paused by JE, and disabling it again takes effect. This isolates actual event behavior; it does not establish administrator/default-settings precedence or physical device playback behavior.

These two tests pass current code. Their historical failures were not replayed, so they are report-derived tests, not demonstrated historical catches. No production fixes were necessary for these three scenarios.

## Existing coverage versus remaining gaps

The index marks **37 records partially covered by existing tests**, with concrete files and limitations. Examples:

| Historical reports | Existing contract | What remains unproven |
|---|---|---|
| #242, #329, #330 | `TaskSeerrSyncTests.InboundWatchlistIsUserScopedIdempotentAndDoesNotReaddRemovedItems` | Manual sync and library-event paths; exact historical patch replay |
| #206, #217, #226, #282, #349 | `TaskAutoRequestTests.SeasonThresholdAvailabilityAndExistingRequestsControlAutomaticRequest` | All release metadata combinations and concurrent cross-user duplicate requests |
| #71, #257 | Translation document-language fallback and Unicode resource loading | Original browser profile Auto state and release-specific failure |
| #130 | Authenticated route and safe configuration tests | Replaying the historical missing-authorization change |
| #151 | Poster resolver stream-height boundaries | Exact 1328×720 width-sensitive historical input; a height-only test may miss it |
| #319, #320 | Scroll empty/zero-progress termination, hidden sections and teardown | Complete discovery filter/dedup/retry journey |

The conservative tally is: 1 proven new catch, 2 new passing report-derived tests, 37 partial existing mappings, 104 unresolved gaps, 103 feature requests, 42 historical changes without detection proof, 12 old deployment/version cases, 12 native-client gaps, 4 permission-environment cases, and 4 support requests. Feature and historical-change classifications **do not imply those features are covered**. Some fix-bearing PRs classified as changes still need deeper reproduction.

Notable actionable gaps include stale server-ID recovery (#299/#312), ARR URL/slug and missing-TMDB polling (#131/#182/#245/#251), Seerr HTTP fallback (#328), and exact unwatched random filtering (#276). Native-client reports require actual affected clients or faithful host fixtures. Historical installer/ABI reports are not proven by current 10.11.11/12.0 host smoke tests.

## Reproduce

```sh
node --test tests/frontend/regressions/history-early-events.test.mjs
python3 tests/runner/mutations.py --layer frontend \
  --cases tests/history/early-mutations.json \
  --artifacts artifacts/history-audit/early-mutations
```

The behavioral run passed 3/3 tests, with no skipped tests. The mutation run passed its baseline/failure/restoration checks and exited 0. Detailed logs and JSON are under the artifact directory; the manifest is retained with the test sources for repeatability.
