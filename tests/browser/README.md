# Browser regressions

These tests execute production JE scripts in a small deterministic **mock host page**, not in Jellyfin. The real Jellyfin-host suite is separate. API surfaces in the language settings tests are local fixtures; modal save callbacks record actions without contacting Seerr. Passing these tests does not establish complete Jellyfin UI compatibility, successful media requests, or native-client support.

```sh
npm ci
npx playwright install --with-deps chromium firefox
npm run test:browser
npm run test:visual
```

The suite runs desktop Chromium, mobile Chromium (Pixel 7 viewport/touch emulation, not Android), and desktop Firefox. It starts and stops its own loopback fixture server on port 4179 (set `JE_BROWSER_PORT` to use another). External requests are blocked except explicitly intercepted locale fixtures. Unexpected console errors and page errors fail tests; retries are disabled. Traces and screenshots are retained for failures under `artifacts/browser`, alongside HTML and JUnit reports. `JE_CHROMIUM_PATH` is an optional local diagnostic override; use Playwright's pinned browser for baseline checks.

Covered behavior:

- Production arr UI (`arr.spec.cjs`, `arr-fixture.html`, `arr-fixtures.cjs`): details status, personal hub tabs, Manage drawer, notification inbox and Overview/Activity/System/Audit; overflow at 1440/390/360 CSS px; every visible arr control at least 44×44 CSS px on phones; Escape and opener focus; exclusive tab selection after click/native keyboard activation; importing/ready/stalled wording and Play availability; stale-source/refresh notes and truncated lists; held-response loading; member-only tabs. The explicit layout matrix runs in Chromium and Firefox; interaction cases run on Pixel 7 at 390px. All plugin calls use strict local route stubs (unknown paths or methods fail teardown), with production shared API and arr modules loaded in manifest order and English strings read from the production locale. The fixture pins Jellyfin's root font sizes and border-box inheritance; it does not suppress horizontal overflow. Each layout check attaches its measured control boxes as JSON to the Playwright report.
- Requests page routing (`arr-hub-route.spec.cjs`, `arr-fixture.html?host=router`): under a stand-in for jellyfin-web 12's router (its popstate listener added before JE's, "Page not found" for unknown routes, the phone menu only on routes it knows, the Dashboard/app layout switch replacing the page container), the page renders after the plugin configuration page at 1280/390 px, and entering it from Home or by a direct address keeps the phone header with every header control inside 390 px; leaving restores Home and its title.
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

The existing `browser` job in `.github/workflows/regression.yml` calls `python3 tests/run.py browser`, which runs `npm run test:browser`. Playwright's default `*.spec.cjs` discovery in this directory includes `arr.spec.cjs`; no additional job or testMatch is needed. The production inventory enumerates production files/routes, not browser test names.
