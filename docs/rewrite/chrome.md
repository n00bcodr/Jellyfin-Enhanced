# Header and page chrome (TypeScript)

Status: typed replacement of nine production scripts. Baseline `2e0f9251bfe833cb58866e9e245ba62be69a69ad`. Jellyfin 12.x only.

| Production output | Entry | Loaded by |
| --- | --- | --- |
| `js/enhanced/events.js` | `client/src/features/chrome/events-entry.ts` | component bundle (order unchanged) |
| `js/enhanced/header-actions.js` | `client/src/features/chrome/header-actions-entry.ts` | component bundle |
| `js/enhanced/native-tabs.js` | `client/src/features/chrome/native-tabs-entry.ts` | component bundle |
| `js/extras/active-streams.js` | `client/src/features/chrome/active-streams-entry.ts` | component bundle |
| `js/extras/plugin-icons.js` | `client/src/features/chrome/plugin-icons-entry.ts` | component bundle |
| `js/extras/plugin-revisions.js` | `client/src/features/chrome/plugin-revisions-entry.ts` | component bundle |
| `js/extras/theme-selector.js` | `client/src/features/chrome/theme-selector-entry.ts` | component bundle |
| `js/extras/login-image.js` | `client/src/features/chrome/login-image-entry.ts` | own script tag, pre-login (`plugin.js`) |
| `js/others/splashscreen.js` | `client/src/features/chrome/splashscreen-entry.ts` | own script tag, early (`plugin.js`) |

Manifest: `client/entries/chrome.json`. Host adapter: `client/src/features/chrome/host.ts`.

## Contracts kept

- Public facades and their identities: `JE.keyListener` (same function for `ui-panel.js` add/remove), `JE.internals.canonicalCombo`, `JE.initializeEnhancedScript`, `JE.headerActions.getTray`, `JE.nativeTabs.register/unregister`, `JE.activeStreams.initialize/destroy`, `JE.initializePluginIcons`, `JE.stopPluginIconsMonitoring`, `JE.customPlugins.refresh`, `JE.initializePluginRevisions`, `JE.initializeThemeSelector`, `JE.initializeLoginImage`, `JE.initializeSplashScreen`, `JE.hideSplashScreen`.
- Load-time effects and order: header-actions and active-streams register their session resets at load; native-tabs registers its observers/navigation hooks at load; splash installs its preemptive styles at load; login image starts at load.
- DOM ids/classes, CSS text (Active Streams: one restored selector), Home tab positional contract (`tab=N` plus stable `jeTab=<id>`, reserved slots, Custom Tabs coexistence, modern-layout header fallback link), More-menu layout/paging/keyboard rules, OSD placement for Active Streams, shortcut priority order, long-press and visibility semantics, storage keys (`${userId}-customCss`, `${userId}-randomThemeEnabled`, `${userId}-lastRandomThemeDate`, `jellyfinEnhancedLastCleared`, `jellyfinEnhancedSettings`, `jellyfin-theme-applied`), request paths and options (`/active-streams/sessions`, `/active-streams/broadcast` with `skipRetry`, `CustomTabs/Config`, plugin configuration, `takePrefetched('ActiveStreamSessions', 5000)`).
- Existing translation keys are preserved. Three error-state keys were added: active_streams_unavailable, active_streams_load_failed and active_streams_last_success. Strings that were hard-coded English in the baseline (Active Streams panel/broadcast labels, theme selector labels, splash alt text) remain English.

## Identity and lifecycle

Asynchronous work captures an identity snapshot (`JE.session` epoch when present, plus the live client user, server, client reference, root and credential continuity) and re-checks it before touching the page or sending anything:

- Active Streams: reads render only for the owning instance and account; Send is refused (and the stale admin panel destroyed) unless the same administrator is still signed in; late `je:user-data-loaded` announcements for replaced epochs are ignored; initialization is idempotent per account.
- Native tabs: Custom Tabs count and the borrowed library backdrop are per identity; stale replies are discarded.
- Plugin icons: CustomPluginLinks cache per identity; stale replies trigger a re-read.
- Theme selector: a control built for one account never writes another account's keys.
- Header actions: unchanged reset (previous account's actions removed; next account starts with only More).

Repeated initialization is idempotent for events, active streams, plugin icons (navigation hook replaced), plugin revisions (teardown first), theme selector (observer replaced) and login image (bindings replaced). The splash is one-shot per document.

## Intentional behaviour changes

All are fixes recorded with before/after evidence in `artifacts/rewrite-chrome/bugs.json` (CHR-*). Notable: long-press listeners are always installed and resolve the player handlers per event (the player keeps gating on the current user's setting), the login image re-attaches to a login view rendered after an in-app sign-out, and a throwing native-tab mount no longer aborts other tabs.

## Validation

Original focused specs and the browser journey live under `artifacts/rewrite-chrome/` (ignored); they load the emitted scripts and can be pointed at the pinned baseline (`CHROME_JS=artifacts/rewrite-chrome/baseline-js`). The focused specs were promoted into tests/frontend/chrome/ and now run in the permanent frontend suite. The browser journey remains an artifact. Real-host behaviour (Jellyfin 12 modern/legacy layouts, TV/mobile clients, real Custom Tabs, real account/server transitions) was not exercised in this slice.

## Independent-review remediation

The R1 follow-up reconciles saved sidebar rows and removals, retains same-account links on failed refresh, refuses old admin actions after credential/client replacement, distinguishes session-read failures from an empty stream list, mounts native tabs without waiting for optional Custom Tabs configuration, and binds auto-resume to the same media source and account. Parent validation: 54 focused checks pass, including eleven new assertions; nine of those fail on the saved pre-fix assets and two preserve existing behaviour. Independent R2 and real-host validation remain separate gates. Evidence: artifacts/reviews/parent-remediation/chrome-r1/.
