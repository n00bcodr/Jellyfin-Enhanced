# Project Structure

Use this map to find the files responsible for a feature before changing it. Jellyfin Enhanced has two parts: a C# server plugin and an injected JavaScript client.

The server owns configuration, persistence, integration proxies and response filters. The client adds controls and pages to Jellyfin Web.

Unless a repository-root path is stated, source paths below are relative to `Jellyfin.Plugin.JellyfinEnhanced/`. Leading slashes denote HTTP routes.

For endpoint details, see the [API reference](api.md). For setup and placement, see [Settings Overview](../getting-started/settings-overview.md) and [JE Pages & Tabs](../getting-started/pages-and-tabs.md).

## Client delivery and initialization

This section follows the client from loader injection through initialization and user switches.

`Features/Platform/Services/ScriptInjectionStartupFilter.cs` injects the loader into web responses. It asks Jellyfin for the plain `index.html`, then serves the injected page itself with Brotli or gzip, a strong ETag per encoding and working 304s, and caches it keyed by the file's own ETag/Last-Modified. `GET /JellyfinEnhanced/script` serves `js/plugin.js`; it is separate from the component bundle. `JellyfinEnhanced.csproj` embeds `js/**`, and `GetScript` in `Features/Platform/JePlatformController.Assets.cs` serves individual resources at `/JellyfinEnhanced/js/{path}`.

The ordered module list lives in `js/component-scripts.json`: 181 component modules, with paths relative to `js/`. Entries starting with `//` are ordering notes.

**Modules execute in manifest order.** Place a module after every producer whose exports it reads at load time. A consumer loaded too early can capture `undefined`.

The initialization stages and user-switch behavior are:

| Stage | Owner and behavior |
|---|---|
| Early UI | Dedicated loaders inject `js/others/splashscreen.js` and, when enabled, `js/extras/login-image.js` before the component stage so they can affect the login screen. |
| Translations | `js/enhanced/translations.js` starts loading at the beginning of `initialize()`, in parallel with bootstrap. It loads/caches locale JSON and resolves `JE.t` before components run. |
| Bootstrap | Authenticated `GET /JellyfinEnhanced/bootstrap` returns version, token user ID, public configuration, administrator-only private configuration, Custom Tabs / Plugin Pages presence flags, five user documents and the component list. Non-admin `PrivateConfig` is null. The loader falls back to individual endpoints if bootstrap fails. |
| Components | After configuration is applied, production loads `GET /JellyfinEnhanced/bundle.js`; development mode and bundle failure use individual scripts. |
| User switches | `js/core/session.js` detects identity changes and resets registered feature state. The loader reloads the incoming user's documents and the public config fields the server projects per user (`TagLookItemOverrides`, filtered to the items that user can see) and emits `je:user-data-loaded`. Async work uses identity epochs to discard stale results. |

The bootstrap's `UserSettings` members are `Settings`, `Shortcuts`, `Bookmark`, `Elsewhere` and `HiddenContent`. A document-loading failure yields null for that document. Bootstrap always loads the token user's data, with no target-user parameter, and is served with `no-store`.

Bootstrap's `Prefetched` block can carry `SpoilerBlurSeries`, `SeerrUserStatus`, `SeerrStatus`, `ActiveStreamSessions` and `TagStripRevision`. The first four reuse standalone response bodies under the same feature, access and cache gates. `TagStripRevision` is the Spoiler Guard tag strip revision that `tag-data` answers carry; the tag pipeline reads it before its first request. Seerr answers are included only when no upstream lookup is needed; sessions follow the active-streams access gate.

Components consume a value once, shortly after bootstrap, through `JE.takePrefetched(name)`. Otherwise, they call their endpoint normally. Bootstrap does not fetch every feature's data.

### Bundle and development mode

`Features/Platform/Services/ClientScriptBundle.cs` builds the bundle on first use and caches it by the plugin's script cache key (version plus DLL timestamp). It wraps each manifest file in a function and publishes `window.__JE_BUNDLE_MODULES`.

The index source map at `/JellyfinEnhanced/bundle.js.map` uses `sections` to preserve original filenames and line numbers in DevTools and stack traces. Bundle and map routes are anonymous; production responses use `public, max-age=31536000, immutable`.

The loader waits for browser idle time, with a 100 ms timeout. It then executes functions in order, yielding between modules at an approximately 10 ms budget. This reduces interference with initial rendering; a synchronous module can still exceed the budget and occupy the main thread. A top-level exception is reported and skipped without re-running that module.

If the bundle request fails or the bundle does not define a valid module array, the loader injects individual files with `script.async = false`. Downloads can overlap; execution follows manifest order.

Administrator setting, under **Admin** → **Developer Settings**:

| Setting | Default | What it does |
|---|---|---|
| **Dev Mode** | Off (`DevMode=false`) | Loads individual component scripts and serves script responses with `no-store`. Direct bundle requests also rebuild rather than using the process cache. |

!!! note
    Development mode still serves embedded resources. Rebuild the plugin and load the new assembly after editing JavaScript; it does not read loose source files from your checkout.

`DisableScriptInjectionMiddleware=false` is a server configuration property without an admin-page control. It gates the request-time injection middleware. `BrandingAssetStartupFilter.cs` handles custom image assets separately from script injection.

## File Structure

Use the tree below to find the directory responsible for a feature. Detailed file indexes follow. The manifest is the authoritative list and order of component files. The repository also contains the three dedicated-loader scripts described above.

```text
Jellyfin.Plugin.JellyfinEnhanced/
├── JellyfinEnhanced.cs               # Plugin entry point; GetPages() and GetViews()
├── JellyfinEnhanced.csproj           # Targets, dependencies and embedded resources
├── packages.jf12.lock.json
├── PluginServiceRegistrator.cs       # Dependency injection, hosted services, filters
├── Logger.cs
├── Configuration/
│   ├── PluginConfiguration.cs
│   ├── UserConfiguration.cs
│   ├── TagShapeSettings.cs         # Per-shape layout/density/slot/cap validation and defaults
│   ├── TagLookSettings.cs
│   ├── CustomTagRuleSet.cs        # Custom tag rules: model, validation and the matcher
│   ├── UserConfigurationManager.cs
│   ├── configPage.html
│   ├── mediaTagsPage.html          # Old Media Tags page address: forwards to the Media Tags tab
│   ├── jeAdmin.js                      # Settings engine: sidebar, rendering, load/save, dialogs
│   ├── jeAdmin.css
│   ├── admin/
│   │   ├── sections.js                 # Every settings card
│   │   ├── sections.css
│   │   └── per-user.js                 # Generated list of settings users also hold personally
│   └── whats-new-seed.json
├── Features/                         # One folder per feature (docs/feature-map.json): Je<Feature>Controller.cs (+ partials), Services/, Models/, Events/, Tasks/, PublicApi/
├── Shared/                           # Code several features use, by area: Analytics/, Arr/, HiddenContent/, Host/, Library/, Maintenance/, Mdblist/, Media/, MediaTags/, Parental/, Reviews/, Seerr/, Sessions/, Settings/, SpoilerGuard/, Text/, Tmdb/
├── Infrastructure/                   # Auth/, Extensions/ (repository, database and user API adapters), Hosting/ (event consumer and MVC filter registration), Http/ (JeControllerBase), Identity/, Persistence/
├── Transport/                        # Bootstrap and bookmark wire records, TransportJson
├── PluginPages/                      # Seven embedded page wrappers
├── Assets/
│   ├── PosterTags/                   # Generated, embedded rendering assets
│   └── TagPresets/                   # Built-in Media Tags presets (embedded JSON)
└── js/
    ├── plugin.js
    ├── component-scripts.json
    ├── fonts/                        # Full and subset Material Symbols WOFF2 files
    ├── locales/                      # 33 bundled JSON files, including regional variants
    ├── core/                         # Shared browser primitives
    ├── enhanced/
    │   ├── bookmarks/
    │   ├── catchup/
    │   ├── hiddencontent/
    │   ├── homeremoval/
    │   ├── itemdetails/
    │   ├── player/
    │   ├── admintags/              # Media Tags tab of the configuration page (admin, not in the bundle)
    │   │   └── sections/
    │   ├── settingspanel/
    │   └── spoilerguard/
    ├── jellyseerr/
    │   ├── discovery/
    │   ├── moreinfo/
    │   ├── recommendations/
    │   └── ui/
    ├── arr/
    │   ├── calendar/
    │   └── requests/
    ├── awards/
    ├── tags/
    ├── elsewhere/
    ├── extras/
    └── others/
```

### Build targets and logging

`JellyfinEnhanced.csproj` uses the root namespace and assembly name `Jellyfin.Plugin.JellyfinEnhanced`. Every file under `Features/<F>/` declares `Jellyfin.Plugin.JellyfinEnhanced.Features.<F>[.*]` (enforced by `tests/backend/Architecture/FolderNamespaceTests.cs`), except scheduled-task types, which keep `…ScheduledTasks` (and `StartupService`, which keeps `…Services`) because Jellyfin keys a task's saved triggers and history by its type's full name. Files under `Shared/<Area>/` and `Infrastructure/<Area>/` declare `…Shared.<Area>[.*]` and `…Infrastructure.<Area>[.*]` (enforced by the same test since round 13; no exemptions).

| `JellyfinTarget` | Jellyfin references | Framework | Compilation symbol |
|---|---|---|---|
| `jf12` (default) | 12.0.0 | `net10.0` | `JF12` |

Only Jellyfin 12.x is supported; requesting `jf10` or a framework other than `net10.0` fails explicitly. Package-reference changes require refreshing `packages.jf12.lock.json` beside both the plugin and `tests/backend/JE.Tests.csproj`. See [CONTRIBUTING.md](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/main/CONTRIBUTING.md) for build and locked-restore instructions.

`Logger.cs` forwards messages to Jellyfin's main log and writes `JellyfinEnhanced_YYYY-MM-DD.log` under Jellyfin's log directory. `Shared/Host/HostCompatibilityService.cs` compares the assembly's build target with the running host and exposes mismatch diagnostics.

### Configuration and persistence

This table maps server settings, per-user documents and the configuration UI to their source files. Storage locations follow it.

| Source | Responsibility |
|---|---|
| `Configuration/PluginConfiguration.cs` | Server settings and administrator defaults. |
| `Configuration/configPage.html` | Admin page shell, tab buttons, page script (connection tests, Overview dashboards, load/save for fields the schema marks `manual`). Media Tags settings are not in its form: they are the **Media Tags** tab, whose content sits after the form and is drawn by `js/enhanced/admintags/` the first time it opens (`jeMountMediaTags`). The page's whole-configuration writes run inside `JE.adminTags.holdSaves`, and links to the page itself open in place. The Display tab's **Media Tags** card summarises it and has no fields. |
| `Configuration/jeAdmin.js`, `jeAdmin.css`, `admin/sections.js`, `admin/sections.css`, `admin/per-user.js` | The settings UI: the engine renders every card from `sections.js`, builds the sidebar and phone drawer, and owns load/save, dialogs and the apply-to-all-users banner. Tabs: **Overview**, **Display**, **Media Tags**, **Elsewhere & Reviews**, **Playback**, **Pages**, **Extras**, **Keyboard**, **Services**, **Seerr**, **\*arr**, **Admin**, **Credits**, **Docs**. `per-user.js` is generated by `scripts/generate_per_user_props.py`. |
| `Configuration/mediaTagsPage.html` | The old Media Tags page address (`#/configurationpage?name=JellyfinEnhancedMediaTags`, a second `PluginPageInfo` outside the menu): only forwards to the configuration page's Media Tags tab (`jeSection=media-tags`) with the same `tab` and `group`. See [Admin Media Tags tab](admin-media-tags.md). |
| `Configuration/UserConfiguration.cs` | Per-user document models, including settings, shortcuts, bookmarks, Elsewhere, Hidden Content and Spoiler Guard. |
| `Configuration/LanguageTagPrioritySettings.cs` | Personal ISO 639-1/639-2 priority validation (12 entries, canonical deduplication); nullable inheritance remains in the user document. |
| `Configuration/LogoTagSettings.cs` | Logos group modes (movies: provider/studio/off; series: network/provider/off), region and maximum, normalized on save. |
| `Configuration/LanguageTagDisplaySettings.cs` | Language display enums, save normalization and admin defaults for new-user seeding and reset-all. |
| `Configuration/TagLookSettings.cs` | Tag look rules and per-item locks: models and validation (`TagLookValidation`) for `settings.json` and the administrator's default rules. |
| `Configuration/CustomTagRuleSet.cs` | Custom tag rules (`CustomTagRule`): save-time normalisation (`CustomTagRuleSet`), rule ids, the icon list, and the matcher (`CustomTagMatcher`) the tag cache, `tag-data` and native posters share. |
| `Configuration/UserConfigurationManager.cs` | Server file storage, locking, writes, shared stores and migration of historical user-ID directory variants. |
| `Configuration/whats-new-seed.json` | Fallback baseline for detecting new admin controls; this is a historical baseline, not current defaults or a feature count. |
| `js/enhanced/config.js` | Resolves effective values from server-stored user settings, admin defaults and client fallbacks; serializes per-user saves to the server in order. It does not store user settings in localStorage. |

Per-user files live under `<PluginsPath>/configurations/Jellyfin.Plugin.JellyfinEnhanced/<normalized-user-id>/`. IDs are lowercase with hyphens removed. Bootstrap loads `settings.json`, `shortcuts.json`, `bookmark.json`, `elsewhere.json` and `hidden-content.json`; Spoiler Guard additionally uses `spoilerblur.json`, and Content Warnings stores its trigger picks in `ddd-triggers.json`, loaded on demand rather than at bootstrap.

Shared `reviews.json` and `activity.json` live in the parent plugin configuration directory, as do `catchup-log.jsonl` and its rotated `catchup-log.1.jsonl`. `UserConfigurationManager` owns the shared review/activity stores; `CatchUpLogService` owns the Catch Up log.

Browser storage serves other purposes: translation caching, IndexedDB tag snapshots and per-user Catch Up dismissals. Those are separate from the server-stored personal settings.

Admin changes may affect the server immediately, while web clients retain loaded configuration until refreshed. See [Settings Overview](../getting-started/settings-overview.md) for defaults, reset and backup procedures.

### Page wrappers and placement

`GetPages()` registers the administrator configuration page. `GetViews()` exposes all seven embedded feature wrappers:

| File under `PluginPages/` | View name | Client owner |
|---|---|---|
| `CalendarPage.html` | `calendarPage` | `js/arr/calendar/` |
| `DownloadsPage.html` | `downloadsPage` | `js/arr/requests/` (combined requests/downloads page) |
| `BookmarksPage.html` | `bookmarksPage` | `js/enhanced/bookmarks/` |
| `HiddenContentPage.html` | `hiddenContentPage` | `js/enhanced/hiddencontent/` |
| `RecommendationsPage.html` | `recommendationsPage` | `js/jellyseerr/recommendations/` |
| `ActivityPage.html` | `activityPage` | `js/extras/activity-page.js`, `activity-custom-tab.js` |
| `CatchUpPage.html` | `catchUpPage` | `js/enhanced/catchup/` |

Embedded view availability is distinct from where a page appears. `JellyfinEnhanced.cs` manages external Plugin Pages sidebar registration and optional Custom Tabs entries. Client mounting modules implement Custom Tabs panels and JE native Home tabs.

Feature and delivery flags determine registration/mounting. Each external delivery mode requires the corresponding external plugin. Native tabs use `js/enhanced/native-tabs.js` and do not require those plugins. See [JE Pages & Tabs](../getting-started/pages-and-tabs.md) for layout requirements and placement choices.

## How modules are organised

Each component is a single top-level IIFE. Larger features split implementation by concern. The Calendar, Requests, More Info and Recommendations directories use this pattern:

| Suffix | Responsibility |
|---|---|
| `-styles` | CSS injection |
| `-data` | State and data access: fetching and caching |
| `-render` | HTML/DOM construction, sometimes split into helpers or cards |
| `-actions` | User interactions: filters, pagination and buttons |
| `-init` | Bootstrap, navigation wiring and the public surface |
| `-custom-tab` | Mounting inside Custom Tabs or native tab panels |

Other directories have local conventions: `spoilerguard/` uses bare names such as `state.js`; `settingspanel/` and `jellyseerr/ui/` use `ui-`; discovery modules mix `discovery-base.js` and `genre-discovery.js`; `itemdetails/` and `homeremoval/` retain `features-`. Follow the directory you are touching.

Many modules idempotently create an empty namespace:

```javascript
const P = (JE.internals.requestsPage = JE.internals.requestsPage || {});
```

That guard does not initialize state or remove ordering dependencies. `requests-page-data.js` owns Requests state; `hidden-content-data.js` owns Hidden Content data; `hidden-content-page-state.js` owns its management-page state; `catchup-core.js` owns `JE.internals.catchUp`. Their consumers must follow them.

`jellyseerr/ui/ui-icons.js` and `jellyseerr/moreinfo/more-info-modal-data.js` seed their respective shared namespaces, which later modules read directly.

Avoid hyphens in JavaScript directory segments under the current implicit embedded-resource naming (`settingspanel`, not `settings-panel`). Directory hyphens are rewritten in resource names, while the loaders look up paths by converting slashes to dots; file-name hyphens are supported. Supporting hyphenated directories requires resource names matching that lookup and verification of both bundle and individual-script delivery.

[bootstrap-manifest.test.mjs](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/main/tests/frontend/bootstrap/bootstrap-manifest.test.mjs) checks manifest-order loading and the single-IIFE shape. Top-level directives or declarations outside that IIFE break the wrapping contract. These tests do not build a complete dependency graph; producer-before-consumer order remains your responsibility.

## Component Breakdown

These indexes group client modules and relevant supporting server files by web feature area.

### Shared browser primitives: `js/core/`

| File | Responsibility |
|---|---|
| `api-client.js` | Shared managed HTTP layer, `JE.core.api.{fetch,jf,plugin}`: authentication, retry/backoff, caching, deduplication, concurrency limits and abort support. Persistence, translations and some features also issue direct `ApiClient.ajax` or `fetch` requests. |
| `dom-observer.js` | One shared body MutationObserver with named subscribers, dedicated observers and `waitForElement`. |
| `lifecycle.js` | Registers feature observers, timers and listeners for coordinated cleanup. |
| `navigation.js` | Deduplicated SPA navigation notifications through `onNavigate` and `onViewPage`. |
| `session.js` | Hooks `ApiClient.setAuthenticationInfo`, follows navigation notifications and reconciles every five seconds. Runs `JE.session.onUserChange` reset handlers and emits `je:user-changed`; supplies identity epochs for async work. |
| `media-language.js` | Shared language/region-to-flag resolution (`resolveFlag`) and canonical ISO language bases (`canonicalBase`) through `JE.core.mediaLanguage`. |
| `tag-renderer-base.js` | Overlay creation, deduplication, caching and reinitialization for the genre, language, quality, rating, age-rating and status tags; hands each group to `tag-layout.js`. People and user-review renderers are independent. |
| `tag-layout.js` | Poster tag layouts (`JE.core.tagLayout`): resolves the user's layout, slots, group order, caps and label density (with the migration for settings saved before layouts), keeps one controller per card and presents each group's chips in slots, the caption outlet, the summary pill, quality dots and the hover scrim. `JE.reinitializeTagLayout()` re-presents every card; Status Tags supply translated compact labels through `data-je-compact`. `resolveLayout()` picks each card's look: lock, then first matching rule, then the default. |
| `tag-look.js` | Tag look rules and locks (`JE.core.tagLook`): normalization, condition matching, card facts from cache entries, saving rules, locking and unlocking. |
| `ui-kit.js` | HTML escaping, toasts, deduplicated CSS injection and scroll-friendly direct/delegated tap listeners. |

### Enhanced UI: `js/enhanced/`

| File or directory | Responsibility |
|---|---|
| `config.js` | Effective settings, shared state and server persistence. |
| `helpers.js`, `events.js` | Shared utilities and input/event wiring. |
| `header-actions.js` | Measures header space and moves overflow actions into a menu, retaining original buttons/listeners. Launcher: **More from Jellyfin Enhanced**; menu heading: **More from JE**. Follows `helpers.js` and precedes native tabs/consumers; no dedicated enable setting. |
| `features-random-button.js` | Random-item selection and header entry point. |
| `icons.js` | Emoji, Lucide and Material icon selection/rendering. |
| `native-tabs.js` | Registry for JE Home tabs. Reconciles positions against live tabs and other plugins' claimed indexes, and handles stable `jeTab=<id>` deep links. |
| `themer.js`, `ui-styles.js` | Theme detection, panel styling and responsive injected UI. |
| `translations.js` | Dedicated translation loader/cache, outside the component manifest. `js/locales/en.json` is the English string reference. |
| `bookmarks/` | `bookmarks.js` handles playback bookmark creation with ++b++, timeline markers and navigation. Seven `bookmarks-library-*` modules cover styles, page, rendering, item management, modals, replacements and initialization, including orphan cleanup, duplicate detection and time-offset adjustment. |
| `hiddencontent/` | Sixteen modules covering data, saving, filtering, hide controls, dialogs, panel wiring and the management page's state, admin operations, cards, rendering, navigation and mounting. |
| `homeremoval/` | `features-remove-home.js` and `features-remove-multiselect.js`: Continue Watching / Next Up removal and multi-select. |
| `itemdetails/` | `features-details-media-info.js`, `features-release-dates.js`, `features-details-page.js`: media information, file sizes, audio languages, release dates and detail-page orchestration. |
| `player/` | `playback.js` supplies speed, seeking and track cycling; `auto-skip.js` consumes its player state for media-segment skipping; `subtitles.js` handles styles/presets; `pausescreen.js` supplies the pause overlay; `osd-rating.js` shows Jellyfin community/critic scores; `playback-rating-badge.js` supplies the playback-start age-rating/genre card. |
| `admintags/` | The configuration page's Media Tags tab, loaded by `Configuration/configPage.html` when the tab first opens (not listed in `component-scripts.json`): `admin-tags.js` (section registry, declarative fields, auto-save, `holdSaves` for the page's whole-configuration writes, sections, addresses, preview hand-over), `admin-tags.css`, `tag-styles-editor.js` (the Tag Styles editor) and `sections/*.js`, one module per section or Groups panel. See [Admin Media Tags tab](admin-media-tags.md). |
| `settingspanel/` | Thirteen modules: `ui-entry-points.js`, `ui-release-notes.js`, `ui-panel-template.js`, `ui-panel-shortcut-editor.js`, `ui-panel-settings.js`, `ui-panel-tag-editor.js` (the Media Tags group editor), `ui-panel-hidden-content.js`, `ui-panel-language.js`, `ui-panel-tag-looks.js` (tag look rules and locked items), `ui-panel-tag-preview.js` (the Media Tags live preview: sample cards drawn by the layout controller; also used by the Media Tags admin tab with a seeded new-user document), `ui-panel-tag-portable.js` (Media Tags presets, import and export: the Layout tab's Presets and Import & export cards, and the dialogs and file/clipboard helpers the Media Tags admin tab reuses), `ui-panel-media-tags.js` (the Media Tags section: tabs, Layout/Status badges/Colours/Server tabs, the phone preview strip and its search entries), `ui-panel.js` (the panel host: dialog, section nav, settings search). The shell orchestrates section wiring after its producers. |
| `spoilerguard/` | Twelve modules: `ids.js`, `state.js`, `image-refresh.js`, `snooze.js`, `dialog.js`, `identity.js`, `styles.js`, `settings-tab.js`, `seerr-toggle.js`, `detail-button.js`, `watched-refresh.js`, `index.js`. The final module publishes `JE.spoilerBlur`; server filters perform image/metadata protection. |

### Catch Up

`js/enhanced/catchup/` contains `catchup-core.js`, `catchup-styles.js`, `catchup-deck.js`, `catchup-activity.js`, `catchup-page.js` and `catchup-custom-tab.js`.

Core loads first and owns state, helpers and API actions. The deck implements swipes, page code orchestrates the feature, and the mounting module follows the public page surface.

Swipes mark watched, dismiss, add to the watchlist (Jellyfin's Likes flag) or open a title. Dismissals are per-user browser-local data.

`Features/Catchup/JeCatchupController.cs` records authenticated users' actions through `POST /JellyfinEnhanced/catchup/event`; both feature and recording gates must be enabled. `GET /JellyfinEnhanced/catchup/events` and `GET /JellyfinEnhanced/catchup/summary` require authentication and enforce administrator status inside their methods. `Features/Catchup/Services/CatchUpLogService.cs` stores the bounded log, independently of Activity Feed.

Administrator settings under **Pages**:

| Setting | Default | What it does |
|---|---|---|
| **Enable Catch Up** | Off | Gates Catch Up (`CatchUpEnabled`). |
| **Record Catch Up activity** | On | Gates server logging (`CatchUpLogEnabled`), when Catch Up is enabled. |
| **Add Catch Up as a native Home tab** | Off | JE native-tab placement (`CatchUpUseNativeTab`). |
| **Use Plugin Pages** | Off | Sidebar delivery (`CatchUpUsePluginPages`); requires Plugin Pages. |
| **Use Custom Tabs** | Off | External tab delivery (`CatchUpUseCustomTabs`); requires Custom Tabs. |
| **Add the Custom Tabs entry for me** | Off | Manages the external entry (`CatchUpAutoCreateCustomTab`). |

`CatchUpCustomTabJeOwned=false` tracks internal ownership, not an administrator control. See [Enhanced Features](../enhanced/enhanced-features.md) for usage.

### Seerr and discovery: `js/jellyseerr/`

| File or directory | Responsibility |
|---|---|
| `api.js`, `request-manager.js`, `seerr-status.js` | Seerr proxy communication, the stable alias onto `JE.core.api.manager`, and shared media/display status constants. |
| `jellyseerr.js` | Search-results integration and pagination. Other Seerr components initialize independently of the search-results gate. |
| `modal.js`, `issue-reporter.js` | Request dialog support and media problem reporting. |
| `item-details.js` | Similar/recommended detail rows and requests for missing series seasons. |
| `hss-discovery-handler.js`, `seerr-detail-link.js` | Home Screen Sections discovery-card interception and detail-page links to Seerr. |
| `seamless-scroll.js` | Shared buffer-fill scrolling and deduplication for search, discovery and category pages, with prefetching and failure backoff. Pauses for manual continuation after 40 consecutive empty pages. |
| `discovery/` | `discovery-base.js` owns lifecycle, pagination, aborts, gating, filtering and rendering. `discovery-filter-utils.js` supplies shared filters/cards; `genre-discovery.js`, `network-discovery.js`, `person-discovery.js`, `tag-discovery.js`, `collection-discovery.js` provide feed specs. |
| `moreinfo/` | Eight `more-info-modal-*` modules: styles, data, seasons, badges, render, TV actions, general actions and initialization. |
| `recommendations/` | Eight `recommendations-*` modules: styles, catalog, data, render, page, category, initialization and tab mounting. Discovery rows, studio/network tiles and category pages live here. |
| `ui/` | Ten `ui-*` modules: icons, styles, popover, badges, cards, buttons, quota, results, request modals and season modal. |

See [Seerr Features](../seerr/seerr-features.md) for permissions and integration requirements.

### Calendar and requests: `js/arr/`

`arr-links.js` adds administrator detail links to Sonarr, Radarr and Bazarr; `arr-tag-links.js` turns synced *arr tags into filtered links.

`arr/calendar/` has seven modules: `calendar-page-styles.js`, `calendar-page-data.js`, `calendar-page-render-events.js`, `calendar-page-render-views.js`, `calendar-page-actions.js`, `calendar-page-init.js`, `calendar-custom-tab.js`.

Calendar combines Radarr, Sonarr and Shoko data. Shoko retrieval lives in `Features/Calendar/JeCalendarController.cs`, with Jellyfin posters and deep-link handling in the calendar modules; there is no separate `ShokoService.cs`. Shoko is configured when both URL and API key are present. Check it alone and alongside *arr sources when changing calendar behavior. See [*arr Settings](../arr/arr-settings.md) for setup.

Administrator settings under **\*arr** → **Shoko**:

| Setting | Default | What it does |
|---|---|---|
| **Shoko URL** | Empty | Server connection (`ShokoUrl`). |
| **Shoko API Key** | Empty | Authentication (`ShokoApiKey`). |
| **Shoko URL Mappings** | Empty | Browser-facing links (`ShokoUrlMappings`). |
| **Episodes** | On | Includes regular episodes (`ShokoShowEpisodes`). |
| **Specials** | Off | Includes specials (`ShokoShowSpecials`). |
| **Credits (OP/ED)** | Off | Includes credits (`ShokoShowCredits`). |
| **Trailers** | Off | Includes trailers (`ShokoShowTrailers`). |
| **Parodies** | Off | Includes parodies (`ShokoShowParodies`). |
| **Other** | Off | Includes other episode types (`ShokoShowOther`). |

`arr/requests/` has eight modules: `requests-page-styles.js`, `requests-page-data.js`, `requests-page-render-helpers.js`, `requests-page-render-cards.js`, `requests-page-render.js`, `requests-page-actions.js`, `requests-page-init.js`, `requests-custom-tab.js`. They implement the combined requests, downloads, issues and import-history page backed by Seerr and *arr integrations. See [Seerr Features](../seerr/seerr-features.md) for the page's user-visible behavior.

### Web tags: `js/tags/`

| File | Responsibility |
|---|---|
| `genretags.js`, `languagetags.js`, `qualitytags.js` | Genre badges, language flags/codes, CC subtitle chips and Dual/Multi badges (shared with the hub preview), and quality tags such as resolution, dynamic range and audio format, plus server-derived source and edition categories. |
| `ratingtags.js`, `rating-sources.js` | Ordered Community/Critic and MDBList source chips, bundled SVG logos, native formats, minimum score and score colours. The source helper also drives the hub preview. |
| `ageratingtags.js` | Color-coded parental/age ratings, sharing the Colored Ratings color table. |
| `genre-icons.json` | The genre → icon table (every language's names) and the Tag Styles genre labels (one canonical English genre per icon, plus Other). Native code (`Resolution/GenreIcons.cs`) embeds it; `scripts/generate_genre_labels.py` writes the table inside `genretags.js` from it (`--check` verifies it). |
| `status-vocabulary.json`, `status-vocabulary.js` | Shared status badge keys, style ids, compact translation keys and date thresholds; the JSON is embedded by native code and `scripts/generate_status_vocabulary.py` generates/checks its TypeScript table; the client builder owns its IIFE JS/map. |
| `logotags.js` | Logo Tags: the streaming provider, network or studio logo chips (server-proxied images, name chips with initials as the fallback); also builds the hub preview's samples. |
| `customtags.js` | Custom Tags: one chip per administrator rule the item matched (label, optional genre-set icon, with source tooltips for administrators only), from the cache entry's or `tag-data`'s `CustomTags`; Tag Styles hooks `data-je-custom`. |
| `statustags.js` | Status Tags: first-match badge per card for added/release dates, season milestones, schedules, trending and optional series status. Batches visible series through `status-tags/series`, guards stale card/user answers and supplies compact labels and `data-je-status` styling hooks. |
| `peopletags.js` | Cast age, birthplace flags and deceased indicators. |
| `userreviewtags.js` | Average of rated reviews visible to the current viewer, composed into the rating group through the layout controller. Uses tag-cache averages or batched `/JellyfinEnhanced/reviews/ratings` requests. |
| `tag-cache-store.js` | IndexedDB snapshot scoped by server and user; memory-only fallback when unavailable. A snapshot from another entry schema is not restored. |
| `tag-item-editor.js` | The per-item Media Tags editor: a dialog with the item's poster and real tags in the draft look (through `setPreviewLook`), layout, density, each group's place and limit, size, gap and edge spacing, **Lock this look for me** (the item's lock) and, for administrators, **For everyone** (the server-wide item look); also the admin page's editor for those looks. |
| `tag-item-menu.js` | The **Media Tags** row in Jellyfin's item ⋮ menu (detail page and cards): captures the item on the ⋮ press and appends a native-markup row to the open action sheet. |
| `tag-pipeline.js` | Restores/downloads the bulk server cache, applies `?since=` deltas and scans cards in idle slices. |
| `tag-layout-styles.js` | The one stylesheet for every tag layout, keyed off `.je-tag-host[data-je-layout]` and `.je-tag-slot[data-je-slot]`. |
| `tag-styles.js` | Retrieves the resolved Tag Styles (with the user's own preset when allowed) and injects web CSS for every chip group; paired with server `Shared/MediaTags/PosterTags/TagStyles.cs`. |
| `tag-poster-colours.js` | The Poster preset on the web: samples each card's artwork in idle slices (dominant colour, normalised for contrast; the same algorithm as `Shared/MediaTags/PosterTags/PosterColour.cs`), sets `--je-tag-bg/-border/-fg` on the card and keeps the colours in memory and in the tag cache store. |
| `tag-direct-play.js` | The Status group's direct-play warning: jellyfin-web 12.1's browser device profile (ported; `tests/fixtures/direct-play-web-12.1-chromium.json` is the real client's, captured in Chromium) and the user's saved bitrate, `PlaybackInfo` lookups for on-screen cards in idle slices (two in flight, each aborted after 15 seconds), answers per item and profile hash for a day in memory and the tag cache store. |

`Configuration/LogoTagSettings.cs` (`LogoTagRules`) normalizes the administrator's Logos modes, region and maximum. `Shared/MediaTags/TagLogo.cs` is the immutable `{kind,name,logo}` cache-entry value. `Features/MediaTags/Services/TagLogoService.cs` keeps the daily TMDB provider and company/network lookups (`tag-logos.json`), rate-limits them, and serves the allow-listed logo images from its size-bounded disk cache (least recently read evicted first, orphans swept at start) through `/JellyfinEnhanced/logo/{size}/{file}`. `Features/MediaTags/Services/TagCache/TagCacheLogos.cs` projects the lookups and Jellyfin's studio names into cache entries and batch DTOs, warms them before builds and reconciles, and republishes them after settings changes.

`Configuration/RatingSourceSettings.cs` validates ordered source preferences. `Shared/MediaTags/TagSourceRatings.cs` maps MDBList scores to immutable native-unit values. `Features/MediaTags/Services/TagCache/TagCacheSourceRatings.cs` enriches tag cache entries and batch DTOs through the existing MDBList cache, TTL and quota policy. `Assets/PosterTags/rating-source-icons.json` contains the same logo paths for native compositing.

`Shared/MediaTags/PosterTags/Resolution/StatusRules.cs` resolves the same first-match status decision server-side and reads embedded locale resources. `PosterTagStatusProvider.cs` obtains shared daily TMDB ranks and series schedules plus caller-filtered parent aggregates. `PosterTagPlan.cs` plans static top/bottom Bands and their overflow; `PosterTagRenderer.cs` paints strips, status chips and the dedicated overflow tile. `tests/fixtures/native-overflow/` holds browser measurements and isolated chip pixels for Corners/Bands, exercised by backend tests and `tests/browser/native-overflow.spec.cjs`. Status-enabled settings digests use a five-minute URL bucket. `tests/poster/parity/status-fixtures.mjs` exercises each status family and timezone boundaries against the real web renderer and native resolver; the integrated profiles also cover Bands, density, order and profile inheritance.

See [Tag Styles and CSS](../enhanced/tags.md#tag-styles-and-css) and [Native Poster Tags](../enhanced/tags.md#native-poster-tags-experimental) for controls and defaults. Tag Styles change colors, not size, shape or position. Administrator controls under **Display** map to these properties:

| Setting | Property |
|---|---|
| **Enable Tag Styles** | `TagStylesEnabled` |
| **Apply to** | `TagStyleTarget` |
| **Preset** | `TagStylePreset` |
| **Let users pick their own preset** | `TagStylesAllowUserPreset` |
| **Enable Native Poster Tags (Experimental)** | `NativePosterTagsEnabled` |
| **Additional Excluded Clients** | `NativePosterTagsWebClientNames` |

The editor stores `TagStyleOverrides=""` until a group or tag colour is saved, then a version 2 document of presets, groups and labels (`TagStyleApplyScope` is retired). Native rendering uses the same validated styles and preset palettes.

### Other web components

| Location | Responsibility |
|---|---|
| `js/elsewhere/elsewhere.js` | Streaming-provider discovery; see [Elsewhere & Reviews Features](../elsewhere/elsewhere-features.md). |
| `js/elsewhere/reviews.js` | TMDB and JE user reviews. Review visibility uses the shared author policy; Spoiler Guard suppression of this web panel is client behavior. |
| `js/awards/awards.js` | Details-page awards banner, backed by `Features/DetailsProviders/Services/WikidataAwardsService.cs` and `Features/DetailsProviders/Models/AwardsData.cs`. Authenticated `GET /JellyfinEnhanced/awards/{mediaType}/{tmdbId}` supports `movie`, `tv`, `person`; Wikidata needs no API key. Server results are cached. |
| `js/extras/active-streams.js` | Active stream header widget and session details. |
| `js/extras/colored-activity-icons.js`, `colored-ratings.js` | Colored activity icons and detail-page parental-rating backgrounds. |
| `js/extras/plugin-icons.js` | Dashboard plugin icons and custom configuration-page links. |
| `js/extras/plugin-revisions.js` | Hides repeated version rows within each plugin-detail revision list, retaining the first. Catalog compatibility filtering remains upstream; React nodes/install handlers and package responses are preserved. No dedicated setting. |
| `js/extras/theme-selector.js` | Jellyfish palette selection and optional daily random palette. |
| `js/extras/login-image.js` | Dedicated early loader for profile images on manual login. |
| `js/others/letterboxd-links.js` | Movie and person detail links to Letterboxd. |
| `js/others/splashscreen.js` | Dedicated early loader for the custom splash screen. |

Administrator setting under **Display**:

| Setting | Default | What it does |
|---|---|---|
| **Show Awards Banner** | Off | Enables the details-page banner (`ShowAwards=false`). |

### Activity Feed

`js/extras/activity-page.js` renders the feed; `activity-custom-tab.js` mounts it.

On the server, `Features/Activity/Events/ActivityPlaybackConsumer.cs` records playback-stop activity after at least 5% progress or Jellyfin-reported completion. `Features/Activity/Services/ActivityFavoriteMonitor.cs` watches favorite changes; `ActivityService.cs` supplies the recording API over `UserConfigurationManager` storage. `ActivityFeedBuilder.cs` merges activity and reviews, filters by viewer access/author visibility, then hydrates card data.

Administrator settings under **Pages** (the final two controls are under **Extras**):

| Setting | Default | What it does |
|---|---|---|
| **Enable Activity Feed** | Off | Gates recording/display (`ActivityFeedEnabled`). |
| **Show recently watched** | On | Playback activity (`ActivityFeedShowWatched`). |
| **Show recently favorited** | On | Favorite activity (`ActivityFeedShowFavorited`). |
| **Show recently reviewed** | On | Review activity (`ActivityFeedShowReviewed`). |
| **Show Active Streams section** | On | Live sessions section (`ActivityFeedShowActiveStreams`), subject to the session gate below. |
| **Add Activity as a native Home tab** | Off | Native placement (`ActivityFeedUseNativeTab`). |
| **Use Plugin Pages** | Off | Sidebar delivery (`ActivityFeedUsePluginPages`); requires Plugin Pages. |
| **Use Custom Tabs** | Off | External tab delivery (`ActivityFeedUseCustomTabs`); requires Custom Tabs. |
| **Add the Custom Tabs entry for me** | Off | Entry management (`ActivityFeedAutoCreateCustomTab`). |
| **Active Streams Header Widget** | Off | Enables the active-session data gate (`ActiveStreamsEnabled`). |
| **Show widget to non-admins** | Off | Additionally required for non-admin session access (`ActiveStreamsAllUsers`). |

`ActivityFeedCustomTabJeOwned=false` is internal ownership bookkeeping. The feed's session section shares the endpoint's gates even when the header widget itself is not mounted.

### MDBList display and metadata writes

`js/others/mdblist-ratings.js` displays the details-page ratings row. `Features/DetailsProviders/Services/MdblistService.cs` fetches/caches upstream results, with cache/account models in `Shared/Mdblist/MdblistRatings.cs`.

`Features/DetailsProviders/Tasks/MdblistRatingsFetchTask.cs` uses `MdblistRatingsFetchRunner.cs` to populate the cache and stops when remaining quota reaches the reserve. `MdblistRatingsSyncTask.cs` writes cached scores into Jellyfin's `CommunityRating` and `CriticRating`; the display overlay does not write metadata.

See [MDBList Ratings](../other/other-settings.md#mdblist-ratings) for controls and defaults. Administrator settings under **Display** map to these properties:

| Setting | Property |
|---|---|
| **Enable MDBList Ratings** | `MdblistRatingsEnabled` |
| **MDBList API Key** | `MdblistApiKey` |
| **Show Ratings Row on Item Details** | `MdblistRatingsShowOnItemDetails` |
| **Fetch Ratings from MDBList** | `MdblistRatingsFetchEnabled` |
| **Fetch Task Reserve** | `MdblistFetchReserve` |
| **Sync Ratings from MDBList to Jellyfin** | `MdblistRatingsAutoSyncEnabled` |
| **Star Rating Source (Community Rating)** | `MdblistCommunityRatingSource` |
| **Star Rating Fallback Source** | `MdblistCommunityRatingFallbackSource` |
| **Tomato Rating Source (Critic Rating)** | `MdblistCriticRatingSource` |
| **Tomato Rating Fallback Source** | `MdblistCriticRatingFallbackSource` |
| **Overwrite Existing Jellyfin Ratings** | `MdblistRatingsOverwriteExisting` |
| **Configure ratings shown** | `MdblistRatingsSources` |
| **Show % Symbol** | `MdblistRatingsShowPercentSymbol` |

Repository-root `images/mdblist-logos/` supplies logos. See [Other Features](../other/other-features.md) for usage and limits.

## Server ownership

The client interacts with server classes through endpoints, cookies and image responses, rather than referencing C# class names. `PluginServiceRegistrator.cs` is the source of truth for service lifetimes, event-consumer registrations and MVC filter order.

### Server services by feature

Paths are relative to `Jellyfin.Plugin.JellyfinEnhanced/`. `Features/<F>/` holds one feature's code; `Shared/<Area>/` holds code several features use.

| Files | Responsibility |
|---|---|
| `Shared/Arr/RadarrService.cs`, `Shared/Arr/SonarrService.cs` | *arr integration access. Shoko retrieval is in `Features/Calendar/JeCalendarController.cs`. |
| `Features/Seerr/Services/AutoMovieRequestService.cs`, `AutoSeasonRequestService.cs` | Automatic next-collection-movie and next-season request decisions/execution. |
| `Features/Seerr/Services/AutoMovieRequestMonitor.cs`, `AutoSeasonRequestMonitor.cs` | Playback event subscriptions feeding those request services. |
| `Features/Seerr/Services/WatchlistMonitor.cs`, `SeerrScanTriggerService.cs` | Watchlist event handling and debounced library-add → Seerr recently-added scan bridge. |
| `Shared/Parental/SeerrParentalFilter.cs` | Shared parental filtering for integration responses. |
| `Shared/Tmdb/TmdbResponseCache.cs`, `Features/Seerr/Services/TmdbCompanyTvDiscover.cs` | TMDB response caching/coalescing and studio-produced TV discovery shaped for Seerr consumers. |
| `Features/MediaTags/Services/Status/StatusTagsTrendingService.cs` | Server-wide trending ranks for Status Tags: TMDB daily trending, else Seerr weekly trending, cached for 30 minutes. |
| `Features/Seerr/Services/MovieCollectionsBatch.cs`, `Shared/Tmdb/WatchProvidersBatch.cs` | Parsing/shaping batched collection and regional streaming-provider lookups. Movie collections use Seerr first, then TMDB when needed. |
| `Features/DetailsProviders/Services/ItemStatsService.cs` | Aggregate item/subtree size and watch-progress data for detail chips. |
| `TagCacheService.cs`, `TagCacheMonitor.cs` | In `Features/MediaTags/Services/TagCache/`. Builds/persists tag data at the current cache schema (`CurrentCacheSchemaVersion`), maintains it from library events and filters episode-derived facts using contributor IDs and `filterRevision`. |
| `Features/MediaTags/Services/TagLogoService.cs`, `Features/MediaTags/Services/TagCache/TagCacheLogos.cs` | Logos group data: daily TMDB lookups and the logo image proxy cache; projection into tag cache entries. |
| `Features/MediaTags/Services/Status/StatusTagsSeriesService.cs` | Authenticated caller-filtered series schedule endpoint support: six-hour TMDB cache, four concurrent lookups, 35 starts per ten seconds, season episode-type enrichment. No per-user storage. |
| `Features/MediaTags/Services/Status/StatusTagsEpisodeFacts.cs` | Shared episode aggregation for cache and user-filtered batch fallback: aired episode indexes, episode-one season premiere and season added span. |
| `Features/MediaTags/Services/Status/StatusTagsEpisodeLookup.cs` | The batch fallback's episode facts per Series/Season: one capped query for small containers, a fixed handful of sorted one-episode queries for large ones (bounded however many episodes tie), fed to `StatusTagsEpisodeFacts`. |
| `Features/MediaTags/Services/LeavingSoonService.cs`, `Features/MediaTags/Services/TagCache/TagCacheLeaving.cs`, `Shared/MediaTags/LeavingSoonSources.cs` | Leaving soon facts (`LeavingSoonSources`: whether a source is configured and which source settings the admin page accepts): Maintainerr's `/api/collections` (delete date per item) or the administrator's leaving collections, refreshed on an interval with retry backoff into `leaving-soon.json` (no URL or key); projection into tag cache entries (`Leaving`), `/tag-data` and native posters. |
| `Features/MediaTags/Services/TagCache/TagCacheCustomTags.cs` | Custom tags in the tag cache: the rules each entry matches (`CustomTags`) from item and series tags and a pass over the collections a rule names; patches members after collection changes, series children after series changes, and re-matches the cache when the rules change. |
| `Shared/Library/ItemLibraryResolver.cs` | The library an item is in (seasons and episodes: their series'), stored as `LibraryId` in tag-cache entries and `tag-data` items for tag look rules. |
| `Features/MediaTags/Services/TagCache/TagCachePendingChanges.cs`, `TagCacheResponseBody.cs` | Coalesces pending item changes; assembles bulk response bytes and hashes the viewer's final body for its ETag. |
| `Shared/HiddenContent/HiddenContentResponseFilter.cs` | Filters supported Jellyfin item lists and Home Screen Sections responses using the viewer's hidden-content scopes. |
| `Shared/Reviews/ReviewAuthorCache.cs` | Cached author lookups for review visibility, invalidated by user changes/deletion/lockout. |
| `Shared/Settings/SettingsDocumentService.cs`, `SettingsDocumentPatch.cs`, `SettingsDefaults.cs` | The revisioned per-user settings document (read, patch, defaults), used by the Settings routes and, through `JeControllerBase.LoadRevisionedSettings`, by the Platform bootstrap. |
| `Features/Platform/Services/CdnAssetService.cs` | Local routes and disk caching for third-party static assets; separate from generated embedded poster assets. |
| `Features/Platform/Services/ScriptInjectionStartupFilter.cs`, `Features/Chrome/Services/BrandingAssetStartupFilter.cs` | Request-time loader injection and custom branding asset delivery. |
| `Features/Platform/Services/StartupService.cs`, `Shared/Host/HostCompatibilityService.cs` | Scheduled startup initialization and build/host compatibility diagnostics. |
| `Features/Admin/Services/WhatsNewService.cs` | Admin control-schema discovery and change-baseline persistence. |
| `Shared/Analytics/UsageEventCounterService.cs`, `Features/Platform/Services/AnalyticsReportingService.cs` | Usage counters and opt-in report construction/sending; see [Community Analytics](community-analytics.md). |
| `Features/DetailsProviders/Services/WikidataAwardsService.cs`, `MdblistService.cs` | Awards and MDBList fetching/cache ownership. |
| `Features/Activity/Services/ActivityService.cs`, `ActivityFavoriteMonitor.cs`, `ActivityFeedBuilder.cs`, `Features/Catchup/Services/CatchUpLogService.cs` | Activity recording/selection and separate Catch Up action logs. |
| `Shared/Maintenance/MaintenanceModeService.cs` | Maintenance state file, policy changes/restoration, message tokens `{countdown}` / `{ends_at}` and session popups. |
| `Features/Admin/Services/MaintenanceScheduleService.cs` | Hosted 30-second timer for scheduled windows and timed-window expiry; distinct from scheduled tasks. |

### Spoiler Guard and identity

Files in this table are under `Features/SpoilerGuard/Services/` unless the row names `Shared/SpoilerGuard/` (policy services other features also call):

| File | Responsibility |
|---|---|
| `ImageBlurService.cs` | SkiaSharp Gaussian blur, stock cards and pre-encoded fail-closed JPEG fallback, with result caching. |
| `SpoilerBlurImageFilter.cs` | Replaces protected image/trickplay responses with parent art, blur or fallback according to mode and availability. |
| `Shared/SpoilerGuard/SpoilerFieldStripFilter.cs` | Strips/rewrites supported unwatched-item metadata in Jellyfin API responses, honoring user state and overrides. |
| `Shared/SpoilerGuard/SpoilerIdentityService.cs`, `Features/SpoilerGuard/Services/SpoilerIdentityTagFilter.cs` | Stable per-user markers and item DTO image-tag stamping for anonymous image requests. The tag filter also calls native poster stamping. |
| `Shared/SpoilerGuard/ImageTagDecoration.cs` | Shared parsing/composition of `[sb-{8hex}-]{jellyfinTag}[-jet{23hex}][-jeu{12hex}]`. |
| `Shared/SpoilerGuard/SpoilerUserResolver.cs` | Loads Spoiler Guard state for the resolved requester. |
| `Shared/SpoilerGuard/SpoilerNextUnwatchedService.cs` | Cached per-user/per-series next-unwatched boundary for advanced category reveals. |
| `Shared/SpoilerGuard/SpoilerTagDataStripper.cs` | Removes sensitive tag data, shared by web tag endpoints and native poster rendering. |
| `Shared/SpoilerGuard/SpoilerSeerrRedactor.cs` | Applies the same per-user policy to Seerr, TMDB and MDBList data, after parental filtering and on top of their shared caches, and to the Requests, Downloads and calendar rows JE builds itself. Must change with `SpoilerFieldStripFilter.cs`. |
| `SpoilerAutoEnableFilter.cs` | Shared content-type/library scope gate for first-play, Seerr-request and library-add automation. |
| `SpoilerAutoEnableArmer.cs` | Bulk arming for users with library access, including disabled accounts, with one locked `spoilerblur.json` update per user. |
| `SpoilerLibraryAddAutoEnabler.cs` | Batches new-title library events into bulk arming. |
| `SpoilerExistingTitlesApplier.cs` | Preview/application for existing titles, run by `Features/SpoilerGuard/Tasks/SpoilerApplyExistingTitlesTask.cs`. |
| `Shared/SpoilerGuard/SpoilerSeerrPendingPromoter.cs` | Converts pending pre-acquisition protection into library-item entries when content arrives. |

`Infrastructure/Identity/RequestIdentityService.cs` resolves authenticated claims first, then image markers, the single-user shortcut, validated cookies and session-by-IP candidates. Consumers distinguish confident identity from ambiguous shared-IP candidates.

Server filters protect supported Jellyfin images/metadata, and `SpoilerSeerrRedactor.cs` protects what JE shows from Seerr, TMDB and MDBList; suppression of JE's Reviews panel happens in `js/elsewhere/reviews.js`. The review-list API uses author visibility rules and does not itself apply that web-panel suppression. See [Spoiler Guard](../spoiler-guard/spoiler-guard-features.md) for protection boundaries.

### Native Poster Tags: `Features/MediaTags/PosterTags/`, `Shared/MediaTags/PosterTags/`

Native rendering draws each user's tags into Primary image responses for clients that do not run web overlays. It is subject to the administrator master gate and enabled tag groups. Original artwork files are preserved. The administrator controls are listed under [Web tags](#web-tags-jstags).

Per-user setting in the Enhanced panel:

| Setting | Default | What it does |
|---|---|---|
| **Show Tags in Native Clients (Experimental)** | On when unset (`UseNativePosterTags=null`) | Personal preference, subject to the administrator master gate. |

| File or directory | Responsibility |
|---|---|
| `NativeClientPolicy.cs` | Excludes known clients running web overlays plus admin-configured client names. |
| `NativePosterTagStamper.cs` | Metadata-time Primary tag stamping, called by `SpoilerIdentityTagFilter`. |
| `Shared/MediaTags/PosterTags/PosterTagSettings.cs`, `PosterTagSettingsProvider.cs` | Effective personal settings/admin defaults, rendering digest, per-user cache and invalidation on settings/config changes. |
| `scripts/tag-translation-coverage.mjs` | Per-locale Media Tags translation coverage and placeholder integrity (run directly for a table; `features-tag-translation-coverage.test.mjs` keeps placeholders intact). |
| `Shared/MediaTags/PosterTags/Resolution/ScoreNumbers.cs` | Score numbers in the user's locale (decimal separator, digits) for native posters, from `js/tags/score-numbers.json`, which `scripts/generate_score_numbers.mjs` generates from the same ICU data the web's `Intl.NumberFormat` uses (`JE.core.mediaLanguage.formatNumberText`); `scripts/generate_status_vocabulary.py --check` checks it. |
| `Shared/MediaTags/PosterTags/PosterTagLookFacts.cs` | The facts a tag look rule reads about an image owner (type, library, genres, official rating) from its tag cache entry or the library item, and the rule matcher native posters share with `core/tag-look.js`. |
| `PosterTagUserCache.cs`, `PosterTagReviewRatings.cs` | User lookups and viewer-aware review averages. |
| `PosterTagDataProvider.cs` | Cache/on-demand tag data, access checks and Spoiler Guard stripping. |
| `Shared/MediaTags/PosterTags/PosterTagModel.cs`, `PosterTagResolver.cs` | Semantic corner/group/tag layout and web-parity resolution rules. |
| `PosterTagStatusProvider.cs` | Daily native TMDB ranks, cached schedules and viewer-filtered parent status aggregates. |
| `PosterTagComposer.cs` | Data → layout → pixels, shared by image filtering and previews; content-addressed cache keys and composition version. |
| `PosterTagImageFilter.cs` | Primary response composition. Registered before the blur filter, so its response processing runs after blur and draws on the protected result. Rendering failure passes through the underlying image response. |
| `PosterTagVariantToken.cs` | Signed `-jet` variants bound to user, item, settings, pixel version, flags and data hash. |
| `CompositeImageCache.cs` | Byte-bounded memory LRU and disk cache under Jellyfin's cache path, in-flight coalescing and bounded render concurrency. |
| `Shared/MediaTags/PosterTags/TagStyles.cs` | The versioned Tag Styles document (preset, group and label overrides): strict save validation, version 1 reading, per-chip resolution and the web model; plus the shipped colour catalog. |
| `Shared/MediaTags/PosterTags/TagStylePalettes.cs` | Group, label and preset ids, the preset palettes and built-in colours shared by web CSS, the config page and native drawing, and the WCAG contrast check. |
| `Shared/MediaTags/PosterTags/PosterColour.cs` | The Poster preset's colours: an artwork's dominant colour (downscaled histogram) normalised for legible text, its worst-case contrast, and the example colours; the renderer samples each poster with it. |
| `Resolution/` | `LogoRules.cs` (logo validation and name-chip text), `RatingRules.cs`. The rules Shared code also reads are in `Shared/MediaTags/PosterTags/Resolution/`: `AgeRatingRules.cs`, `GenreIcons.cs`, `JsText.cs`, `LanguageFlagRules.cs`, `LanguageNames.cs`, `QualityTagRules.cs` (including source/edition categories, order and low-quality gate), `StatusRules.cs`, `ResolutionData.g.cs`. |
| `Rendering/` | `PosterTagAssets.cs`, `PosterTagCss.cs` (in `Shared/MediaTags/PosterTags/Rendering/`), `PosterTagImageScaler.cs`, `PosterTagPlan.cs`, `PosterTagRenderer.cs`, `PosterTagText.cs`, `PosterTagTileCache.cs`: embedded assets, layout, scaling, text shaping, drawing and reusable tile caching. |

`ResolutionData.g.cs` is generated by repository-root `tests/poster/parity/gen-resolution-data.mjs`; do not edit it by hand. Renderer/composition version changes retire existing variant tokens, preventing old URLs from serving newly changed pixels under long-lived client caches.

`PosterTagVariantToken.cs` persists a 32-byte random signing secret at `<PluginsPath>/configurations/Jellyfin.Plugin.JellyfinEnhanced/native-poster-tags.key`, separate from rendered-image caches. Preserve it for URL-signing continuity during restoration.

Missing or wrong-length keys are recreated; old URLs can serve original artwork until clients refresh metadata. Persistence failure logs a warning and uses a process-lifetime key, changing URLs after restart. Unix creation uses owner-only read/write permissions. This is internal state without an admin control.

### Shared helpers, extensions and models

| Location | Files and responsibilities |
|---|---|
| Helpers | `Shared/Arr/ArrUrlGuard.cs` checks integration URLs; `Features/Platform/Services/BuildAttestation.cs` handles release attestation; `Shared/MediaTags/PluginConfigurationPatch.cs` writes a few configuration fields on top of the live configuration and reports conflicting edits (the Media Tags tab's saves); `Shared/MediaTags/MediaTagsPageFields.cs` is the list of fields those saves may write, read from the page's section modules; `Shared/MediaTags/MediaTagsPortable.cs` reads and writes the versioned Media Tags documents (user and server export, import preview with the save paths' validators, presets: built-in, per-user and offered); `Shared/Arr/ProviderHelper.cs` and `Infrastructure/Auth/UserHelper.cs` resolve provider/user identifiers; `Shared/Reviews/ReviewVisibility.cs` applies author visibility; `Features/MediaTags/Services/TagEpisodeSelector.cs` chooses representative episodes with usable streams. |
| Language handling | `Features/MediaTags/Services/MatroskaLanguageReader.cs`, `Features/MediaTags/Services/MediaStreamLanguageResolver.cs` recover stream language data; `Features/MediaTags/Services/MatroskaLanguageCache.cs` keeps each file's parsed languages (persisted, keyed by path, size and modification time) so unchanged files are not reopened; `Features/MediaTags/Services/AudioLanguageTagHelper.cs` maps base/regional codes to tag names and computes changes. |
| `Shared/Seerr/`, `Shared/Parental/` | `Shared/Seerr/`: `SeerrHttpHelper.cs`, `JellyseerrPermissionHelper.cs`, `JellyseerrUserImportHelper.cs`: HTTP, permission and import helpers. `Shared/Parental/`: `ParentalRatingDecision.cs`, `ParentalTagDecision.cs`, `SeerrCertificationExtractor.cs`, `SeerrTagSignatureExtractor.cs`: shared parental decisions/extraction. |
| `Infrastructure/Extensions/` | `ItemRepositoryExtensions.cs`, `JellyfinDbContextExtensions.cs`, `UserManagerExtensions.cs`: repository/database provider lookups and compatible user enumeration across server API changes. |
| `Shared/MediaTags/MediaNamingTags.cs` | Server-side source/edition detection from file and immediate parent-folder names, physical-stub priority and resolution-ranked multi-version selection. Shared by the tag cache and `/tag-data`; only labels reach clients. |
| `Shared/MediaTags/TagCacheEntry.cs` | Tag data at the current cache schema (`CurrentCacheSchemaVersion` in `Features/MediaTags/Services/TagCache/TagCacheService.cs`), including source/edition labels, named-source ratings, Custom rule matches, Logos (`Shared/MediaTags/TagLogo.cs`), series/season quality summaries, Status Tags facts and server-only contributor IDs for access filtering, plus precomputed item tag data, including parent-series IDs for Spoiler Guard filtering without per-entry library lookups. |
| `Shared/MediaTags/TagQualitySummary.cs`, `Shared/MediaTags/SeriesQualityAggregation.cs` | Policy-independent container quality facts, bounded distinct values, audio-language variants and policy resolution; built from existing episode streams and recomputed through the cache access filter for restricted users. |
| `Features/Platform/Models/AnalyticsData.cs`, `Features/Admin/Models/WhatsNewData.cs`, `Shared/Analytics/UsageCounterDiskFormat.cs` | Report records and inclusion/exclusion annotations; the usage-counter file format; configuration-schema and pending-change records. |
| `Features/DetailsProviders/Models/AwardsData.cs`, `Shared/Mdblist/MdblistRatings.cs` | Awards cache records and MDBList cache/account models (the MDBList models are in `Shared/` because MediaTags' `TagSourceRatings` reads them). |
| `Shared/Arr/` | `ArrInstance.cs`, `ArrItem.cs`, `ArrType.cs`: integration instance/item/type models. |
| `Shared/Seerr/` models | `JellyseerrPermission.cs`, `JellyseerrUser.cs`: Seerr permission/user models. |

### Event consumers

Event consumers live in each feature's `Events/` folder; `UserTopologyEvents.cs` is in `Infrastructure/Identity/`.

| File | Responsibility |
|---|---|
| `Features/Activity/Events/ActivityPlaybackConsumer.cs` | Qualifying playback-stop activity recording. |
| `Features/HiddenContent/Events/ContinueWatchingPlaybackEvents.cs` | `ContinueWatchingPlaybackConsumer` clears Continue Watching-only hides on playback start and demotes combined Continue Watching/Next Up hides to Next Up-only. Global/Next Up-only hides remain. `ContinueWatchingLibraryHook` prunes removed item IDs from personal hidden-content documents. |
| `Features/Admin/Events/MaintenancePlaybackReminder.cs` | `MaintenancePlaybackReminderConsumer` re-sends active-maintenance notifications on playback start, throttled per session. |
| `Features/SpoilerGuard/Events/SpoilerAutoEnableEvents.cs` | `SpoilerAutoEnableOnFirstPlayConsumer` arms a series on qualifying first-episode playback. |
| `Infrastructure/Identity/UserTopologyEvents.cs` | User creation/deletion invalidates identity caches; updates/deletions invalidate tag-access caches; updates/deletions/lockout invalidate review-author caches. |

### Scheduled tasks

The table lists task names as shown by Jellyfin and their default triggers. Files are in each feature's `Tasks/` folder (`Features/<F>/Tasks/`), except `StartupService.cs`. Task types keep the namespace `Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks` (and `StartupService` keeps `…Services`) so admins' saved schedules and history survive the move.

Feature gates still apply when a task runs. A task is hidden from the dashboard list while its feature is off and appears again once the feature is on, with no restart. Always listed: Refresh Translation Cache, Refresh CDN Assets and Jellyfin Enhanced Startup. Default triggers are distinct from an administrator's saved schedule.

| File | Task name | Default triggers |
|---|---|---|
| `Features/Platform/Tasks/AnalyticsReportTask.cs` | **Send Anonymous Usage Report** | Every 24 hours; execution also checks the configured reporting interval. |
| `Features/MediaTags/Tasks/ArrTagsSyncTask.cs` | **Sync Tags from \*arr to Jellyfin** | None |
| `Features/MediaTags/Tasks/AudioLanguageTagsSyncTask.cs` | **Sync Audio Language Tags to Jellyfin** | None |
| `Features/MediaTags/Tasks/BuildTagCacheTask.cs` | **Refresh Tag Cache** | Daily at 03:00 |
| `Features/DetailsProviders/Tasks/ClearTranslationCacheTask.cs` | **Refresh Translation Cache** | Application startup |
| `Features/Seerr/Tasks/JellyfinToSeerrWatchlistSyncTask.cs` | **Sync Watchlist from Jellyfin to Seerr** | Daily at 03:30 |
| `Features/Seerr/Tasks/JellyseerrUserImportTask.cs` | **Import Jellyfin Users to Seerr** | Every six hours |
| `Features/Seerr/Tasks/JellyseerrWatchlistSyncTask.cs` | **Sync Watchlist from Seerr to Jellyfin** | Daily at 03:00 |
| `Features/Seerr/Tasks/WatchlistRemovalSyncTask.cs` | **Sync Watchlist Removals between Jellyfin and Seerr** | Daily at 04:00 |
| `Features/DetailsProviders/Tasks/MdblistRatingsFetchTask.cs` | **Fetch Ratings from MDBList** | None |
| `Features/DetailsProviders/Tasks/MdblistRatingsSyncTask.cs` | **Sync Ratings from MDBList to Jellyfin** | None |
| `Features/Platform/Tasks/RefreshCdnAssetsTask.cs` | **Refresh CDN Assets** | Application startup and every 24 hours |
| `Features/SpoilerGuard/Tasks/SpoilerApplyExistingTitlesTask.cs` | **Spoiler Guard: apply to existing titles** | None |
| `Features/Platform/Services/StartupService.cs` | **Jellyfin Enhanced Startup** | Application startup |

`Features/DetailsProviders/Tasks/MdblistRatingsFetchRunner.cs` is shared fetching logic, not another task. Hosted timers/monitors listed above are separate from this dashboard task system.

Administrator setting under **Display**:

| Setting | Default | What it does |
|---|---|---|
| **Enable Audio Language Tags Sync** | Off (`AudioLanguageTagSyncEnabled=false`) | Gates the language-tag task's writes to movies/series. |

`Features/MediaTags/Services/TagCache/TagCacheService.cs` applies the same language tags when rebuilding entries after library events.

## Repository documentation and tooling

Repository-root files support development, documentation and release metadata:

| Location | Purpose |
|---|---|
| `README.md`, `CONTRIBUTING.md` | Project overview and contribution/build/check guidance. |
| `mkdocs.yml`, `docs/` | MkDocs navigation, enabled extensions and site content. Documentation is separate from embedded plugin resources. |
| `manifest.json` | Release/plugin catalog metadata; distinct from the component manifest and generated-asset manifest. |
| `package.json`, `package-lock.json` | Test tooling/dependencies; production client bundling is performed by C#, without an npm bundler. |
| `css/ratings.css`, `images/mdblist-logos/` | Rating color-table input and MDBList logo sources. |
| `LICENSE`, `SECURITY.md` | License and security-reporting policy. |
| `.gitattributes`, `.gitignore`, `.pre-commit-config.yaml`, `.vscode/settings.json` | Repository/editor conventions and local checks. |
| `scripts/` | Translation validation, generated documentation and asset maintenance. |
| `tests/` | Regression suites, fixtures, harnesses and evidence documentation. |

### Documentation tree

The overhaul organizes site pages as follows, including the new getting-started and tag pages:

```text
docs/
├── index.md
├── about.md
├── 404.md
├── getting-started/
│   ├── index.md
│   ├── compatibility.md
│   ├── settings-overview.md
│   └── pages-and-tabs.md
├── installation/
├── enhanced/                         # Includes tags.md
├── spoiler-guard/                    # Screenshots stay beside these pages
├── seerr/
├── arr/
├── elsewhere/
├── other/
├── advanced/                         # API, CSS, analytics and this map
├── faq-support/
├── other-projects/
├── images/
│   ├── getting-started/              # Screenshots (WebP) and recordings (MP4)
│   ├── enhanced/                     # Screenshots (WebP) and recordings (MP4)
│   ├── tags/                         # Screenshots (WebP) and recordings (MP4)
│   ├── seerr/                        # Screenshots (WebP) and recordings (MP4)
│   ├── arr/                          # Screenshots (WebP) and recordings (MP4)
│   ├── elsewhere/                    # Screenshots (WebP) and recordings (MP4)
│   ├── other/                        # Screenshots (WebP) and recordings (MP4)
│   ├── admin/                        # Screenshots (WebP) and recordings (MP4)
│   └── readme/                       # README images
├── javascripts/
│   └── extra.js                      # Small layout helpers (phone tables, scroll rows, nav icons)
└── stylesheets/
    ├── extra.css                     # The JE-style theme
    └── touch.css                     # Phone/tablet scrolling and search-overlay fixes
overrides/                            # Theme template overrides (copies of Material 9.6.12 templates with marked changes)
```

`mkdocs.yml` owns navigation and Markdown extensions. Site screenshots (WebP) and short screen recordings (MP4) live in the `docs/images/<area>/` folders above; Spoiler Guard's sit beside its pages in `docs/spoiler-guard/`. `docs/images/readme/` holds the README images. Keep the flat `docs/images/ratings.png`, `theme-selector.png`, `colored-activity-icons.png`, `login-image.png` and `plugin-icons.png`: the admin page loads them from `main` for its **View Screenshot** previews. `overrides/` copies a few Material 9.6.12 templates, so refresh it if the Material version pin in `.github/workflows/docs.yml` changes.

These are documentation assets, separate from runtime fonts, native rendering assets and root feature assets. The admin **Docs** tab loads the hosted site from the browser, rather than an offline copy embedded in the assembly.

### Generated assets and maintenance scripts

Use this index to find validation and asset-generation scripts and their maintenance requirements.

| Repository-root script | Inputs/outputs and maintenance contract |
|---|---|
| `scripts/generate_config_flag_groups.py` | Regenerates `docs/advanced/config-flag-groups.json` from admin configuration markup; docs CI runs it before building. |
| `scripts/validate-translations.js` | Validates locale JSON against `js/locales/en.json`; see [Contributing Translations](../faq-support/contributing-translations.md). |
| `scripts/material-symbols/subset.py` | Builds the two Material Symbols subsets from bundled full fonts. Add every new runtime icon name to `ICONS`, install fonttools/Brotli, regenerate and include both subset outputs. Literal scanning cannot cover dynamically constructed names. |
| `scripts/build_poster_assets.py` | Downloads pinned upstream inputs, verifies checksums and generates `Assets/PosterTags/`. Outputs are committed and do not regenerate during `dotnet build`. |
| `scripts/poster-assets/package.json`, `package-lock.json`, `rasterize_flags.mjs` | Pinned Node/Playwright tooling for Chromium flag rasterization used by the poster asset generator. |
| `scripts/capture-web-device-profile.mjs` | Captures jellyfin-web's own browser device profile and the `canPlayType` answers it read in headless Chromium into `tests/fixtures/direct-play-web-12.1-chromium.json`. Needs an authorised Jellyfin test server with the plugin installed (`--server`, `--user`, `JE_CAPTURE_PASSWORD`); `--cases-from` reuses the fixture's cases. Not run by CI. |

`js/fonts/` contains `materialsymbolsrounded.woff2`, `materialsymbolsoutlined.woff2`, `materialsymbolsrounded-subset.woff2` and `materialsymbolsoutlined-subset.woff2`. Full fonts use the public Material Symbols family names for themes/custom CSS; subsets use private `JE Material Symbols …` families and `.je-msym-*` classes for JE's own icons. Keep those families separate so a subset does not shadow a theme's full font.

Generated `Assets/PosterTags/` contains `fonts/NotoSans-Bold.ttf.br`, `flags/*.webp`, `icons.json`, `vector-icons.json`, `age-rating-colours.json`, `quality-colours.json`, `THIRD_PARTY_NOTICES.md` and `manifest.json`. The manifest records pins, tool versions, options and output checksums and is excluded from embedding. These generated assets use explicit resource names.

Full regeneration requires Python 3.10+ with the generator's pinned fonttools/Brotli/Pillow versions, plus Node 18+, pinned Playwright and Chromium for flags. Use the dependency versions in the script/manifest to reproduce bytes. From the repository root:

```sh
python3 scripts/build_poster_assets.py --check
python3 scripts/build_poster_assets.py --check --full
```

`python3 scripts/build_poster_assets.py --quality-only` regenerates the quality colour table and its manifest records without changing unrelated assets.

The fast check uses only the Python standard library to verify repository inputs and output checksums. The full check regenerates into a temporary directory and compares bytes, requiring the complete toolchain.

### Regression tests and inventory

Use this tree to find test suites, shared fixtures and supporting evidence.

```text
tests/
├── run.py
├── README.md
├── backend/                          # JE.Tests.csproj + jf12 package lock
│   ├── Architecture/                 # Guardrails: route/auth, registration and boundary snapshots, file size, folder = namespace, feature-map parity
│   ├── Features/<F>/                 # One folder per backend feature (docs/feature-map.json)
│   ├── Shared/
│   ├── Api/                          # Cross-cutting: controller construction, routing, configuration endpoints
│   ├── Core/
│   ├── Integrations/
│   ├── Persistence/
│   ├── PosterTags/
│   ├── ScheduledTasks/
│   └── Support/                      # Shared storage/plugin/HTTP fixtures
├── frontend/
│   ├── run.mjs
│   ├── admin/                        # Admin configuration page (admin/config/)
│   ├── architecture/                 # Guardrails: feature boundaries, max lines, generated markers, feature-map parity
│   ├── bootstrap/
│   ├── chrome/
│   ├── contracts/
│   ├── core/
│   ├── features/<f>/                 # One folder per client feature that has its own tests (docs/feature-map.json)
│   ├── pages/
│   ├── requests/
│   ├── regressions/
│   └── helpers/                      # Shared realms, discovery and coverage
├── browser/                          # Fixtures, server, Playwright config,
│                                     # reviewed snapshots and licensed fonts
├── host/                             # Disposable-host runner and browser checks
├── poster/
│   ├── rendering/
│   ├── pipeline/
│   └── parity/
├── history/                          # Historical fault manifests/triage
├── inventory/
│   └── generate.py
├── runner/
│   ├── clean.py
│   ├── coverage.py
│   ├── mutations.py
│   ├── poster.py
│   └── tests/test_regression.py
└── docs/                             # Setup, inventory, coverage and history evidence
```

Frontend test discovery is recursive. Reuse backend `Support/` and frontend `helpers/` fixtures, review browser snapshot changes, and keep generated evidence in the ignored root `artifacts/` directory. Real-host tests use disposable Jellyfin instances. See [tests/README.md](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/main/tests/README.md) for prerequisites and suite selection.

```sh
python3 tests/run.py fast
python3 tests/run.py all
python3 tests/inventory/generate.py --check
```

The inventory at `tests/docs/production-inventory.json` records lexical production surfaces such as files, routes, configuration and tasks; it is not behavioral coverage. Regenerate it with `python3 tests/inventory/generate.py` after relevant surface changes. Coverage gaps and historical evidence live in `tests/docs/`.

### CI and repository policies

`.github/workflows/` contains:

| Workflows | Purpose |
|---|---|
| `regression.yml` | Regression suites, lock checks and production inventory. |
| `docs.yml` | Generated config groups, MkDocs Material 9.6.12 build and Pages deployment. |
| `translation_validation.yml`, `check-unused-translations.yml` | Locale validation and unused-key reporting. |
| `validate-manifest.yml` | Release manifest validation. |
| `codeql.yml`, `dependency-review.yml`, `security-scan.yml`, `scorecards.yml` | Static analysis, dependency/security checks and repository scorecard. |
| `more-info-needed.yml`, `stale.yml` | Issue maintenance. |

`.github/ISSUE_TEMPLATE/bug.md` and `.github/ISSUE_TEMPLATE/feature_request.md` provide report templates; `.github/SECURITY_GUIDELINES.md`, `.github/codeql/codeql-config.yml`, `.github/dependabot.yml` and `.github/funding.yml` hold repository policy/configuration. Follow [CONTRIBUTING.md](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/main/CONTRIBUTING.md) for which checks apply to a contribution and [SECURITY.md](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/main/SECURITY.md) for reporting vulnerabilities.

### Tag size and gap ownership

`Configuration/TagLayoutSettings.cs` validates `TagScale` and `TagGap` for user settings and admin defaults; `TagShapeSettings.cs` reuses those validators for optional per-shape values. `js/core/tag-layout.js` resolves inheritance and writes `--je-tag-scale` / `--je-tag-gap` to hosts and caption outlets. The existing tag styles retain their responsive clamps and multiply their metrics by those properties. `preserveLegacySizing` derives the original declarations for version-0 hosts inside the same responsive rules, preserving exact legacy rasterization. The Media Tags hub controls save through `ui-panel-settings.js`; the preview uses the same card resolver.

Native settings and cache digests are resolved in `Shared/MediaTags/PosterTags/PosterTagSettings.cs`. `Shared/MediaTags/PosterTags/Rendering/PosterTagCss.cs` scales logical metrics, `PosterTagPlan.cs` places the resulting chips, and `PosterTagTileCache.cs` keys tiles by size and gap as well as image scale. `tests/backend/Features/MediaTags/CoreTagScaleSettingsTests.cs` covers validation, round trips, inherited defaults, native metrics and cache pixels; the existing frontend layout/hub suites and poster parity profiles cover web behavior and effective native settings. No new production module or tag-cache entry field is added.

### Awards poster tags

- `Shared/MediaTags/TagAwards.cs`: immutable exact-work chart/certification/winner facts in `TagCacheEntry.Awards`.
- `Features/MediaTags/Services/AwardTagsService.cs`: persistent `award-tags.json`, configurable MDBList list membership, provider certification, cached Wikidata winner projection, TTLs, quota reserve and cancellation.
- `Features/MediaTags/Services/TagCache/TagCacheAwards.cs`: cache-only batch/native projection and normal tag-cache publication after scheduled refresh or config changes.
- `Features/MediaTags/Tasks/RefreshAwardTagsTask.cs`: **Refresh Awards Tags**, daily 04:00 and on demand, hidden while Awards is off.
- `Features/MediaTags/Tasks/RefreshLeavingSoonTagsTask.cs`: **Refresh Leaving Soon Tags**, hourly, acting once the configured interval has passed, hidden without a Leaving soon source. `Shared/MediaTags/TagLeaving.cs` is its cache-entry value.
- `js/tags/awardstags.js`: IIFE renderer and shared preview chips/logos, registered in the component manifest.
- `Assets/PosterTags/award-icons.json`: generated logo paths loaded by `PosterTagAssets`; `scripts/build_poster_assets.py --awards-only` regenerates just those paths and manifest records. Source marks are nominative; project artwork is GPL-3.0 and trademarks remain with their owners.

The layout, settings hub, Tag Styles and native resolver/plan/renderer use the same `awards` group id and five stable label ids. Native pixel/resolver versions retire old variants. Regression coverage is in `tests/backend/Features/MediaTags/PosterTags/AwardTagsTests.cs`, `tests/frontend/features/media-tags/features-awards-tags.test.mjs` and the Awards offline parity profiles.
`Features/MediaTags/Services/Status/NativeStatusRefreshService.cs` owns scheduled and stale-read-triggered background refreshes for native status snapshots (series schedules in batches through `StatusTagsSeriesService`'s four-slot, rate-limited lookups); image composition reads these snapshots without upstream requests.

`scripts/generate_status_dates.mjs` generates `js/tags/status-short-dates.json` from browser Intl data for native Status month/day labels, with deduplicated formats and locale-to-format mappings for every shipped language and named territory. It also generates `tests/fixtures/native-status-dates.json` for four-date regional regressions; `generate_status_vocabulary.py --check` checks both tables.

`Configuration/NativePosterDateContext.cs` validates and bounds saved native locale/timezone context on assignment and document load.


### Quality stream display modes

`Configuration/QualityDisplaySettings.cs` validates Highest/All modes and the inclusive minimum-resolution buckets. Nullable personal overrides in `UserConfiguration.cs` inherit live admin defaults; the controller seeds, validates and resets them. The existing admin `sections/quality.js` declares all five controls, with validators in `Shared/MediaTags/MediaTagsPageFields.cs` and independent fixture/binding entries. Personal controls remain in the Quality group editor.

`TagStreamData.DistinctQualities` carries distinct track category/label/language triples computed by `QualityTagRules.DetectDistinct` when `TagCacheService.BuildStreamData` creates stream facts. `TagQualityCategory` carries full union, intersection and latest sets independently of its bounded legacy samples. `SeriesQualityAggregation` builds these from the existing episode walk and applies each policy per category, retaining parallel legacy/current audio facts and per-language/region summaries. `audio-aggregation.json` supplies shared expected facts for web/native regressions and parity. `qualitytags.js` reads the persisted sets or derives identical batch sets; `PosterTagResolver` uses the same native rules. The current tag cache schema (`CurrentCacheSchemaVersion` in `Features/MediaTags/Services/TagCache/TagCacheService.cs`) also gates both browser snapshot readers. Regression coverage is in `QualityDisplayTests.cs`, `features-quality-display.test.mjs`, shared `audio-alias-labels.json` / `audio-legacy-documents.json` fixtures, the group editor tests and offline native parity profiles.

### Technical poster chips and Scenes

`Shared/MediaTags/PosterTags/Resolution/TechnicalQualityRules.cs` mirrors `qualitytags.js` runtime formatting, the aspect-ratio tolerance table and frame-rate snapping. `Features/MediaTags/Services/SubtitleAccessibility.cs` detects whole-word SDH/CC title markers and the hearing-impaired flag; stream summaries and `SdhSubtitleLanguages` carry that fact through the existing tag cache, batch and native Language group. `Shared/Media/TrackRoles.cs` (mirrored by `isSecondaryAudio` in `js/tags/languagetags.js`) keeps commentary and audio-description tracks out of `AudioLanguages`; forced subtitle tracks never add a `SubtitleLanguages` entry. `Features/MediaTags/Services/Status/StatusTagsScenesService.cs` resolves daily TMDB movie keywords via `TmdbResponseCache`; `Features/MediaTags/Services/TagCache/TagCacheScenes.cs` warms and publishes those facts outside native image composition. The shared Status vocabulary includes both scene badges and is regenerated by `scripts/generate_status_vocabulary.py`. Formatting fixtures live in `tests/fixtures/technical-quality.json`; frontend, backend and offline parity consume them. The current tag cache schema (`CurrentCacheSchemaVersion` in `Features/MediaTags/Services/TagCache/TagCacheService.cs`) invalidates older entries.

Per-genre Tag Styles labels come from `js/tags/genre-icons.json` (see above). `tests/fixtures/genre-styles.json` holds one Tag Styles document and, per genre, the label, glyph and colours web chips and native posters draw; `tests/backend/Features/MediaTags/PosterTags/GenreStyleTests.cs`, `tests/frontend/features/media-tags/features-genre-styles.test.mjs` and `tests/browser/genre-styles.spec.cjs` read it, and the offline poster parity compares each genre chip's label too.

The technical aspect-ratio tolerance table in `TechnicalQualityRules.cs` also generates the web table inside `js/tags/qualitytags.js` through `scripts/generate_technical_ratios.py` (`--check` verifies it). The shared `tests/fixtures/technical-quality.json` exercises full and compact native/web output and tolerance boundaries.

Compact quality labels use `js/tags/quality-compact.json`, projected into `client/src/features/media-tags/types/quality/compact-quality.ts` and `Shared/MediaTags/PosterTags/Resolution/QualityCompactLabels.g.cs` by `scripts/generate_quality_compact.py`. Run its `--check` mode after editing the source.

`tests/fixtures/audio-stream-labels.json` checks real audio stream facts through the web renderer and native resolver in Full and Compact; the parity profiles include the same streams. `tests/fixtures/quality-detection-truth.json` is an independent truth table of Jellyfin stream shapes (Dolby Vision range types and base layers, HLG, misleading titles, codec/channel provenance across tracks, lossless audio, VC-1/VVC/ProRes) with the expected Highest, All and version-0 labels; `features-quality-detection-truth.test.mjs` and `QualityDetectionTruthTests.cs` assert it on both sides, so a shared mistake cannot pass as parity.

`tests/fixtures/side-status-fit.json` shares smaller-scale Status side-anchor budgets between the browser and native planner regressions (both sides, with and without an opposite group, across Default/Tight/Flush).

`tests/fixtures/first-chip-text-fit.json` shares fitted text-logo font size and letter spacing between the production-markup browser regressions, native planner tests and offline side-logo parity profiles. `PosterTagTextLayout` retains its builder’s shaping parameters so ellipsizing every tile kind uses its original typography. Pixel identity 8.2 invalidates previously fitted text logos; renderer version stays 8.
