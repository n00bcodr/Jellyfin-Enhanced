# Browser regressions

These tests execute production JE scripts in a small deterministic **mock host page**, not in Jellyfin. The real Jellyfin-host suite is separate. API surfaces in the language settings tests are local fixtures; modal save callbacks record actions without contacting Seerr. Passing these tests does not establish complete Jellyfin UI compatibility, successful media requests, or native-client support.

```sh
npm ci
npx playwright install --with-deps chromium firefox
npm run test:browser
npm run test:visual
```

The suite runs desktop Chromium, mobile Chromium (Pixel 7 viewport/touch emulation, not Android), and desktop Firefox. It starts and stops its own loopback fixture server on port 4179. External requests are blocked except explicitly intercepted locale fixtures. Unexpected console errors and page errors fail tests; retries are disabled. Traces and screenshots are retained for failures under `artifacts/browser`, alongside HTML and JUnit reports. `JE_CHROMIUM_PATH` is an optional local diagnostic override; use Playwright's pinned browser for baseline checks.

Covered behavior:

- Production Seerr modal: primary callback receives the selected fixture season, cancel/back/Escape, repeated open/close cleanup, keyboard focus wrapping, text injection protection, responsive layout.
- Production advanced request forms: regular/4K default server matching, alphabetical server order, quality/root-folder defaults, free-space labels, dependent dropdown replacement and reset.
- Production navigation: push/replace URL transitions, redundant events, unsubscribe.
- Production UI primitives: replacement/removal of injected CSS, Seerr stylesheet deduplication, escaped toast content and controlled expiry.
- Production language settings: persisted regional locale normalization, per-user storage isolation, automatic language selection, translation-cache clearing without deleting unrelated storage, failed locale discovery.

The test fixture bundles Liberation Sans Regular/Bold under the SIL Open Font License (see `fonts/LICENSE`), eliminating system-font dependence for the visual fixture. Other browser tests include non-Latin text; the visual fixture uses Latin text to avoid platform-dependent CJK fallback fonts. Screenshots use pinned viewports, locale/timezone, dark color scheme, disabled transitions/animations, and loaded fixture fonts. One modal baseline per browser project captures actual production CSS.

Review visual changes before updating snapshots. Inspect the retained actual/expected/diff images and determine whether production behavior changed intentionally. To introduce or intentionally update baselines:

```sh
npx playwright test --config tests/browser/playwright.config.cjs --grep @visual --update-snapshots
npm run test:visual
```

Commit the reviewed PNG changes with their reason. Do not update them merely to clear a failure. Existing baselines were initially created on Linux; use Linux for visual comparisons. Missing browsers, missing snapshots, and unavailable servers are failures, not skips.

Remaining scope: full Enhanced panel wiring, poster-tag interactions, bookmarks, hidden-content/Spoiler Guard browser journeys, playback, real touch hardware, and complete native Jellyfin navigation are not established by this fixture suite. Consult the coverage matrix for their other test layers and gaps.
