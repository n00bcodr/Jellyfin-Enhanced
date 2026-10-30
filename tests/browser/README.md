# Browser regressions

These tests execute production JE scripts in a small deterministic **mock host page**, not in Jellyfin. The real Jellyfin-host suite is separate. API surfaces in the language settings tests are local fixtures; modal save callbacks record actions without contacting Seerr. Passing these tests does not establish complete Jellyfin UI compatibility, successful media requests, or native-client support.

```sh
npm ci
npx playwright install --with-deps chromium firefox
npm run test:browser
npm run test:visual
```

To run the centre-anchor geometry regressions on an existing lab origin without
starting the fixture server:

```sh
JE_BROWSER_LAB_URL=http://127.0.0.1:18537 npx playwright test --config tests/browser/playwright.config.cjs tag-centres.spec.cjs
```

These cases check the selected lab's health, then run production renderers and
styles in an isolated page on that origin. They use real browser geometry;
authenticated Jellyfin cards still need the separate lab verification.

The suite runs desktop Chromium, mobile Chromium (Pixel 7 viewport/touch emulation, not Android), and desktop Firefox. It starts and stops its own loopback fixture server on port 4179 (set `JE_BROWSER_PORT` to use another). External requests are blocked except explicitly intercepted locale fixtures. Unexpected console errors and page errors fail tests; retries are disabled. Traces and screenshots are retained for failures under `artifacts/browser`, alongside HTML and JUnit reports. `JE_CHROMIUM_PATH` is an optional local diagnostic override; use Playwright's pinned browser for baseline checks.

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

The settings-panel regression loads the production host in the fixture by default and checks real pointer clicks on native inert content, body-retargeted events, late background controls, and destinationless blur in all three browser projects. It can also exercise the deployed bundle on the layouts lab. Redeploy the worktree before each lab run because that server is shared:

```sh
/home/jake/je-lab/deploy.sh layouts /home/jake/je-wt/tag-layouts
JE_PANEL_LAB_URL=http://127.0.0.1:18520 JE_PANEL_LAB_USER=real-admin \
  JE_PANEL_SHOTS=.notes/shots/phase5-fixes-r2 \
  npx playwright test -c tests/browser/playwright.config.cjs settings-panel --project=chromium --workers=1
```

Use `real-viewer` to check the non-admin path. Passwords come from the local lab accounts file, or `JE_PANEL_LAB_PASSWORD`. `JE_PANEL_SHOTS` optionally saves successful screenshots. The lab mode fails if the deployed host lacks the focus fix; it never injects the checkout's scripts over Jellyfin's bundle.

Language-chip navigation also has a real-host mode. Run only that spec against
an authorized disposable lab, serially, with `JE_LANGUAGE_LAB_URL`,
`JE_LANGUAGE_LAB_USER` (defaults to `real-admin`) and
`JE_LANGUAGE_LAB_PASSWORD` supplied in the environment:

```sh
npx playwright test --config tests/browser/playwright.config.cjs language-navigation --project=chromium --workers=1
```

Without the lab variables it uses the fixture host. Both modes check actual
left-click navigation and new tabs from Control/Command-click and middle-click
for audio flags, codes, subtitle captions, subtitle summary pills and count
badges. Lab fixtures change only the current browser's display settings and
card facts; no user preferences or media metadata are saved.
