# Recent JE historical-regression audit

This pass triaged **253 public issue/PR records numbered 650–910** from the fetched snapshot. [Per-record triage](history-recent-triage.json) distinguishes title/body-excerpt screening from detailed source/test assessment. It is **not** a claim that 253 bug reproductions were validated. Dependency, translation, documentation and feature requests are not automatically historical bugs; open/closed state is not evidence of correctness. Comments, screenshots, client-specific environments, and full patches were not exhaustively examined.

## Proven findings

| Report | Existing suite assessment | Added or existing assertion | Sensitivity evidence |
|---|---|---|---|
| [PR 658: repeated approvals](https://github.com/n00bcodr/Jellyfin-Enhanced/pull/658) | Existing `pages-downloads` approval test substitutes `renderPage`; it cannot exercise accumulating DOM listeners. | New real cards/page render test rerenders the same container five times; one click must dispatch one approval, decline or navigation. Also covers three custom-container renders. | A faithful historical fault removes the bind-once condition. Baseline passes; mutant fails with duplicate action dispatch; restored passes. |
| [PR 658: pending season on available show](https://github.com/n00bcodr/Jellyfin-Enhanced/pull/658) | No existing real request-card assertion covered this status combination. | New real card/page rendering checks pending request actions for Partially Available, Available and Pending media; approved/declined/nonprivileged cases have no actions. | Replaced the predicate with the exact pre-`d76a5847` media-status predicate, in its now-split file. Baseline passes; mutant fails; restored passes. |
| [Issue 659: stereo first suppresses surround badge](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/659) | Existing shared renderer tests use a synthetic renderer; neither these nor single-track fixtures establish stream-order behavior. Poster parity is a separate suite and is not claimed to survive this fault. | New production quality renderer plus shared DOM overlay tests two stream orders for 5.1 and two for 7.1, asserting real badge values. | Restored the complete historical `getChannelTag` function from `4fc376fb^`, adjusting indentation only. Baseline passes; mutant fails; restored passes. |
| [Issue 774: bookmark pins leak across episodes](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/774) | **Existing test catches the central matching defect.** | `episode provider fallback excludes other episodes and seasons but retains legacy records` in `features-bookmarks.test.mjs`. | Exact removal of the matching guard introduced by `9acc883b`: baseline passes; mutant fails with extra episode/season matches; restored passes. This does not prove player-timeline integration, metadata backfill, or every changed hunk. |

The **pre-audit frontend suite was also run against each of the three new-test faults** in a disposable copy: all 33 pre-existing test files (323 tests) still passed for all three mutants. The new tests therefore close demonstrated frontend-suite blind spots. This experiment does not claim that the separate backend, poster-parity or real-host suites would also survive.

Tests call real production modules. Request rendering substitutes unrelated avatar/link hydration and captures the action/navigation boundary; it does not simulate real Seerr notifications or prove its backend emits one notification. No production code needed changing for these cases.

## Repeatable verification

```sh
node --test tests/frontend/regressions/history-recent-regressions.test.mjs
python3 tests/runner/mutations.py --cases tests/history/recent-mutations.json --layer frontend --artifacts artifacts/history-audit/recent-mutations
```

Results: **3 new tests passed; 4 mutation cases each passed baseline, failed at an expected assertion, and passed after restoration.** Mutation evidence is in `artifacts/history-audit/recent-mutations/summary.json` with per-stage logs. All faults were applied in disposable source copies; live production files were untouched. Historical provenance is stored in the version-controlled case manifest.

## Related assertions are not proof of catching the historical bug

- [PR 740](https://github.com/n00bcodr/Jellyfin-Enhanced/pull/740): extensive session/bootstrap/cache race tests exist, but no claim of reversing every changed module.
- [PR 901](https://github.com/n00bcodr/Jellyfin-Enhanced/pull/901): existing native-tab tests assert placeholders, late claims, index rewriting and user choice. This is not the full real Custom Tabs/Jellyfin layout matrix.
- [PRs 895](https://github.com/n00bcodr/Jellyfin-Enhanced/pull/895) and [904](https://github.com/n00bcodr/Jellyfin-Enhanced/pull/904): stylesheet assertions cover public/full versus private/subset font definitions. They do not prove all feature-injected styles or actual glyph rendering under each theme.
- [PR 845](https://github.com/n00bcodr/Jellyfin-Enhanced/pull/845): the Activity pending-load cleanup test directly covers stale polling restart, but not every inactive tab integration.
- [Issue 657](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/657): the new repeated-render test proves one navigation dispatch, not the reported browser back-stack behavior on a real host.

## Important remaining candidates

The JSON records **141 not-assessed candidates**, **2 environment gaps**, **8 related-assertion mappings without historical proof**, and **7 backend records with selected proof in the [coordinating audit](history-audit.md)**. Other counts are 45 feature requests, 41 maintenance records, 5 documentation records, 3 issue/PR records with proven tests (four defects), and one partial navigation mapping. These classifications describe this pass, not global JE completeness.

- [Issue 899](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/899): Moonfin button chosen as the header host. Existing foreign-button fixtures do not reproduce the reported nesting/click-through structure.
- [PR 795](https://github.com/n00bcodr/Jellyfin-Enhanced/pull/795): React-owned text-node replacement. A DOM-only assertion is not enough to establish React reconciliation safety. The alternative [PR 792](https://github.com/n00bcodr/Jellyfin-Enhanced/pull/792) is an example of eliminating a crash by inadvertently stopping the feature; closed proposed fixes must not be treated as accepted fixes.
- [Issue 833](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/833): optional avatar 404s need a request-count test for absent image metadata.
- [Issue 910](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/910): actual Edge/Windows Picture-in-Picture video recovery needs real media, user activation and visibility transitions. jsdom or mobile viewport emulation cannot establish this.
- [Issue 893](https://github.com/n00bcodr/Jellyfin-Enhanced/issues/893): mobile/webOS Seerr-login takeover is not reproduced in the current native Linux Chromium host smoke suite.

Remaining reports include tag-cache memory/disk lifecycle, subtitle layout and disablement, player skip/track-selection behavior, library-version compatibility, and admin configuration. They remain explicit audit work, not implicitly covered because a similarly named feature has tests.
