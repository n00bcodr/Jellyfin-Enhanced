# Project Structure

Use this map to find the files responsible for a feature before changing it. Jellyfin Enhanced has two parts: a C# server plugin and an injected JavaScript client.

The server owns configuration, persistence, integration proxies and response filters. The client adds controls and pages to Jellyfin Web.

Unless a repository-root path is stated, source paths below are relative to `Jellyfin.Plugin.JellyfinEnhanced/`. Leading slashes denote HTTP routes.

For endpoint details, see the [API reference](api.md). For setup and placement, see [Settings Overview](../getting-started/settings-overview.md) and [JE Pages & Tabs](../getting-started/pages-and-tabs.md).

## Client delivery and initialization

This section follows the client from loader injection through initialization and user switches.

`Services/ScriptInjectionStartupFilter.cs` injects the loader into web responses. `GET /JellyfinEnhanced/script` serves `js/plugin.js`; it is separate from the component bundle. `JellyfinEnhanced.csproj` embeds `js/**`, and `GetScript` in `Controllers/JellyfinEnhancedController.cs` serves individual resources at `/JellyfinEnhanced/js/{path}`.

The ordered module list lives in `js/component-scripts.json`: 161 component modules, with paths relative to `js/`. Entries starting with `//` are ordering notes.

**Modules execute in manifest order.** Place a module after every producer whose exports it reads at load time. A consumer loaded too early can capture `undefined`.

The initialization stages and user-switch behavior are:

| Stage | Owner and behavior |
|---|---|
| Early UI | Dedicated loaders inject `js/others/splashscreen.js` and, when enabled, `js/extras/login-image.js` before the component stage so they can affect the login screen. |
| Translations | `js/enhanced/translations.js` starts loading at the beginning of `initialize()`, in parallel with bootstrap. It loads/caches locale JSON and resolves `JE.t` before components run. |
| Bootstrap | Authenticated `GET /JellyfinEnhanced/bootstrap` returns version, token user ID, public configuration, administrator-only private configuration, Custom Tabs / Plugin Pages presence flags, five user documents and the component list. Non-admin `PrivateConfig` is null. The loader falls back to individual endpoints if bootstrap fails. |
| Components | After configuration is applied, production loads `GET /JellyfinEnhanced/bundle.js`; development mode and bundle failure use individual scripts. |
| User switches | `js/core/session.js` detects identity changes and resets registered feature state. The loader reloads the incoming user's documents and emits `je:user-data-loaded`. Async work uses identity epochs to discard stale results. |

The bootstrap's `UserSettings` members are `Settings`, `Shortcuts`, `Bookmark`, `Elsewhere` and `HiddenContent`. A document-loading failure yields null for that document. Bootstrap always loads the token user's data, with no target-user parameter, and is served with `no-store`.

Bootstrap's `Prefetched` block can carry `SpoilerBlurSeries`, `SeerrUserStatus`, `SeerrStatus` and `ActiveStreamSessions`. These reuse standalone response bodies under the same feature, access and cache gates. Seerr answers are included only when no upstream lookup is needed; sessions follow the active-streams access gate.

Components consume a value once, shortly after bootstrap, through `JE.takePrefetched(name)`. Otherwise, they call their endpoint normally. Bootstrap does not fetch every feature's data.

### Bundle and development mode

`Services/ClientScriptBundle.cs` builds the bundle on first use and caches it by the plugin's script cache key (version plus DLL timestamp). It wraps each manifest file in a function and publishes `window.__JE_BUNDLE_MODULES`.

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
├── packages.jf10.lock.json
├── PluginServiceRegistrator.cs       # Dependency injection, hosted services, filters
├── Logger.cs
├── Configuration/
│   ├── PluginConfiguration.cs
│   ├── UserConfiguration.cs
│   ├── UserConfigurationManager.cs
│   ├── configPage.html
│   ├── configPage.css
│   └── whats-new-seed.json
├── Controllers/
│   ├── JellyfinEnhancedController.cs  # Most plugin endpoints
│   ├── CatchUpController.cs           # Catch Up event recording and admin reads
│   ├── Arr*Controller.cs              # Requests & downloads: arr admin, state, live, status, add
│   ├── Acquire*Controller.cs          # Requests & downloads: requests, household, discover, migration
│   ├── RequestsHubController.cs       # The Requests page and the Manage drawer
│   ├── NativeDetails*Controller.cs    # Pages for titles that aren't in the library
│   ├── NotifyController.cs            # Notifications, follows and reminders
│   └── JeBackupController.cs          # Backup, restore and the credential rollback
├── PluginPages/                      # Seven embedded page wrappers
├── Helpers/
│   └── Jellyseerr/                   # Seerr HTTP, permissions, imports, parental rules
├── Extensions/                       # Repository, database and user API adapters
├── EventHandlers/                    # Playback and user topology consumers/hooks
├── Model/
│   ├── Arr/
│   └── Jellyseerr/
├── ScheduledTasks/                   # Dashboard tasks and MDBList fetch runner
├── Services/
│   ├── Acquire/                      # Requests & downloads: status, hub, notifications, requests
│   │   ├── Notify/
│   │   └── Requests/
│   ├── Arr/                          # Instance registry, clients, snapshots, audit
│   │   └── Live/
│   ├── AutoRequest/
│   ├── Backup/
│   ├── Identity/
│   ├── PosterTags/
│   │   ├── Rendering/
│   │   └── Resolution/
│   ├── NativeDetails/                # Jellyfin 12 only, except the page-id codec
│   ├── Secrets/                      # secrets.json
│   └── SpoilerGuard/
├── Assets/
│   └── PosterTags/                   # Generated, embedded rendering assets
└── js/
    ├── plugin.js
    ├── component-scripts.json
    ├── fonts/                        # Full and subset Material Symbols WOFF2 files
    ├── language-policy.json          # Display-language tag rule (server and client; the shipped list comes from locales/)
    ├── locales/                      # 33 bundled JSON files, including regional variants
    ├── core/                         # Shared browser primitives
    ├── enhanced/
    │   ├── bookmarks/
    │   ├── catchup/
    │   ├── hiddencontent/
    │   ├── homeremoval/
    │   ├── itemdetails/
    │   ├── player/
    │   ├── settingspanel/
    │   └── spoilerguard/
    ├── jellyseerr/
    │   ├── discovery/
    │   ├── moreinfo/
    │   ├── nativedetails/
    │   ├── recommendations/
    │   └── ui/
    ├── arr/
    │   ├── admin/                    # Requests & downloads: admin tabs
    │   ├── ask/                      # request sheet and controls
    │   ├── calendar/
    │   ├── hub/                      # the Requests page
    │   ├── live/                     # change feed and intent tokens
    │   ├── manage/                   # the Manage drawer
    │   ├── notify/                   # bell, toasts and alert settings
    │   ├── requests/
    │   └── status/                   # status pill, chips and poster badges
    ├── awards/
    ├── tags/
    ├── elsewhere/
    ├── extras/
    └── others/
```

### Build targets and logging

`JellyfinEnhanced.csproj` uses the root namespace and assembly name `Jellyfin.Plugin.JellyfinEnhanced`. Directory organization does not always match C# namespaces: for example, services in `Services/SpoilerGuard/` and `Services/Identity/` use `Jellyfin.Plugin.JellyfinEnhanced.Services`. Check declarations rather than deriving namespaces from folders.

| `JellyfinTarget` | Jellyfin references | Framework | Compilation symbol |
|---|---|---|---|
| `jf12` (default) | 12.0.0 | `net10.0` | `JF12` |
| `jf10` | 10.11.0 | `net9.0` | `JF10` |

Build separate artifacts for the two targets. Package-reference changes require refreshing both plugin lock files and both locks beside `tests/backend/JE.Tests.csproj`. See [CONTRIBUTING.md](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/main/CONTRIBUTING.md) for build and locked-restore instructions.

`Logger.cs` forwards messages to Jellyfin's main log and writes `JellyfinEnhanced_YYYY-MM-DD.log` under Jellyfin's log directory. `Services/HostCompatibilityService.cs` compares the assembly's build target with the running host and exposes mismatch diagnostics.

### Configuration and persistence

This table maps server settings, per-user documents and the configuration UI to their source files. Storage locations follow it.

| Source | Responsibility |
|---|---|
| `Configuration/PluginConfiguration.cs` | Server settings and administrator defaults. |
| `Configuration/configPage.html`, `configPage.css` | Admin UI, control labels, save wiring and styling. Tabs: **Overview**, **Display**, **Playback**, **Pages**, **Seerr**, **\*arr**, **Elsewhere**, **Extras**, **Keyboard**, **Admin**, **Docs**. |
| `Configuration/UserConfiguration.cs` | Per-user document models, including settings, shortcuts, bookmarks, Elsewhere, Hidden Content and Spoiler Guard. |
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
| `media-language.js` | Shared audio-language/region-to-flag resolution through `JE.core.mediaLanguage.resolveFlag`. |
| `tag-renderer-base.js` | Overlay creation, positioning, deduplication, caching and reinitialization for genre, language, quality, rating and age-rating tags. People and user-review renderers are independent. |
| `ui-kit.js` | HTML escaping, toasts, deduplicated CSS injection and scroll-friendly direct/delegated tap listeners. `placeDetailAction` puts JE's detail-page buttons into Jellyfin's own action row. |

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
| `settingspanel/` | Eight modules: `ui-entry-points.js`, `ui-release-notes.js`, `ui-panel-template.js`, `ui-panel-shortcut-editor.js`, `ui-panel-settings.js`, `ui-panel-hidden-content.js`, `ui-panel-language.js`, `ui-panel.js`. The shell orchestrates section wiring after its producers. |
| `spoilerguard/` | Twelve modules: `ids.js`, `state.js`, `image-refresh.js`, `snooze.js`, `dialog.js`, `identity.js`, `styles.js`, `settings-tab.js`, `seerr-toggle.js`, `detail-button.js`, `watched-refresh.js`, `index.js`. The final module publishes `JE.spoilerBlur`; server filters perform image/metadata protection. |

### Catch Up

`js/enhanced/catchup/` contains `catchup-core.js`, `catchup-styles.js`, `catchup-deck.js`, `catchup-activity.js`, `catchup-page.js` and `catchup-custom-tab.js`.

Core loads first and owns state, helpers and API actions. The deck implements swipes, page code orchestrates the feature, and the mounting module follows the public page surface.

Swipes mark watched, dismiss, add to the watchlist (Jellyfin's Likes flag) or open a title. Dismissals are per-user browser-local data.

`Controllers/CatchUpController.cs` records authenticated users' actions through `POST /JellyfinEnhanced/catchup/event`; both feature and recording gates must be enabled. `GET /JellyfinEnhanced/catchup/events` and `GET /JellyfinEnhanced/catchup/summary` require authentication and enforce administrator status inside their methods. `Services/CatchUpLogService.cs` stores the bounded log, independently of Activity Feed.

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
| `hss-discovery-handler.js`, `seerr-detail-link.js` | Home Screen Sections discovery-card interception (opening the title's native details page when offered, otherwise More Info) and detail-page links to Seerr. |
| `nativedetails/` | Native details for titles that aren't in the library (experimental, Jellyfin 12 web). `JE.titleDetails` is the one navigator every entry point uses (`open`, `show`, `openKey`: a library copy the viewer can open first, else the native page, else the More Info modal once), with the synthetic page id codec shared with the server; the page adapter hides actions a title without files can't do, holds the Request / Open controls and the slot the details surface draws into, adds the modal's ratings, information panel, trailers and collection, and shows a neutral refusal when the server refuses the title. Person pages made for cast and crew the library doesn't have get their "Known for" line, and the discovery pages of genres, studios and networks the library lacks (synthetic genre/studio ids on Jellyfin's list page) lose the empty list's controls; the genre, network and person discovery rows read those pages' ids. |
| `seamless-scroll.js` | Shared buffer-fill scrolling and deduplication for search, discovery and category pages, with prefetching and failure backoff. Pauses for manual continuation after 40 consecutive empty pages. |
| `discovery/` | `discovery-base.js` owns lifecycle, pagination, aborts, gating, filtering and rendering. `discovery-filter-utils.js` supplies shared filters/cards; `genre-discovery.js`, `network-discovery.js`, `person-discovery.js`, `tag-discovery.js`, `collection-discovery.js` provide feed specs. |
| `moreinfo/` | Eight `more-info-modal-*` modules: styles, data, seasons, badges, render, TV actions, general actions and initialization. |
| `recommendations/` | Eight `recommendations-*` modules: styles, catalog, data, render, page, category, initialization and tab mounting. Discovery rows, studio/network tiles and category pages live here. |
| `ui/` | Ten `ui-*` modules: icons, styles, popover, badges, cards, buttons, quota, results, request modals and season modal. |

See [Seerr Features](../seerr/seerr-features.md) for permissions and integration requirements.

### Calendar and requests: `js/arr/`

`arr-links.js` adds administrator detail links to Sonarr, Radarr and Bazarr; `arr-tag-links.js` turns synced *arr tags into filtered links.

`arr/calendar/` has seven modules: `calendar-page-styles.js`, `calendar-page-data.js`, `calendar-page-render-events.js`, `calendar-page-render-views.js`, `calendar-page-actions.js`, `calendar-page-init.js`, `calendar-custom-tab.js`.

Calendar combines Radarr, Sonarr and Shoko data. Shoko retrieval lives in the main controller, with Jellyfin posters and deep-link handling in the calendar modules; there is no separate `ShokoService.cs`. Shoko is configured when both URL and API key are present. Check it alone and alongside *arr sources when changing calendar behavior. See [*arr Settings](../arr/arr-settings.md) for setup.

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

Requests & downloads (new) adds these `js/arr/` modules:

| Directory or file | Responsibility |
|---|---|
| `live/arr-live.js` | `JE.arr.onStatusChange(keys, cb)` — pages showing download status subscribe to title keys and are called when they change; one long-poll per visible tab against `acquire/changes`, with backoff (Requests & downloads, phase 1). |
| `live/arr-intent.js` | `JE.arrIntent.create(name, { intent })` → `{ next(), current(token), invalidate() }` — intent tokens for remote lists and searches: a read publishes its answer (or its error) only while it is the list's newest, the signed-in user is the same and what the page asks for (tab, query, filter, page) hasn't changed (Requests & downloads; used by the Downloads page data layer and the admin tabs). |
| `status/` | Where each title has got to (Requests & downloads, phase 1): `status-core.js` (`JE.arrStatus`: status reads, family texts, pill, journey, badges, and subscriptions to the change feed that re-render a surface in place), `status-details.js` (pill on details pages), `status-arrival.js` (a details page whose title arrives turns into the playable page: Jellyfin reloads the same item, or the page moves to the item that replaced it; waits while the viewer types, plays or has a dialog open), `status-episodes.js` (episode chips and the missing-episodes banner), `status-cards.js` (lazy, batched poster badges), `status-modal.js` (the pill and journey in Seerr's more-info window) and `status-styles.js` (styles; `JE.initializeArrStatus` starts every status surface, the Requests page and the modal pill). |
| `hub/` | The Requests page at `#/requests` (phase 1): `hub-page.js` (`JE.arrHub`: route, tabs, one read of `acquire/hub` per visit, re-read when the change feed reports a shown title or the user's own request list; for administrators the Downloads and Calendar pages rendered in tabs), `hub-render.js` (My requests groups, Coming soon agenda, Ready) and `hub-styles.js`. |
| `hub/` (phase 3 tabs) | `hub-extra-core.js` (shared helpers: capabilities, intent tokens, scope words), `hub-approvals.js` (Approvals: approve, approve with changes, decline with a reason, bulk approve), `hub-household.js` (Household: roles, quotas, preset), `hub-mine-ledger.js` (the caller's own requests from the ledger in My requests, with Cancel), `hub-chipbar.js` (the Managers' "needs your OK · stuck" chips on the home page), `hub-discover.js` (JE-mode Discover tab) and `hub-extra-styles.js`; they plug into `hub-page.js` through `H.extraTabs`. |
| `household/household-rules.js` (phase 4b) | Household rules on the Requests page. The administrators' request conditions editor the Household tab mounts below its house rules (conditions per role, streaming country and services, shared allowances), Seerr's own rules read-only in Seerr mode, and rule verdicts, rule reasons and shared-allowance use in plain words for Approvals, My requests and the request controls (`JE.internals.arrHub.rules`). |
| `admin/` | The administrator's phase-2 tabs of the Requests page: `admin-tabs.js` (Overview, Activity, System, Audit: loads each from its admin route, follows admin changes and polls once a minute (every 10 seconds without a feed subscription), retries failed refreshes, runs the fixes and queue actions, the remove dialog and the typed confirmation for removing with data), `admin-render.js` (instance cards, Needs attention, downloads, history, system, Jellyfin bridge and path doctor, audit) and `admin-styles.js`. |
| `manage/` | The administrator's Manage drawer (phase 1, Overview only): `manage-drawer.js` (`JE.arrManage.open({itemId})` or `JE.arrManage.open({key})`: explanation, Search now, Open in Sonarr/Radarr, versions across instances, timeline, Seerr's requests; the Manage button on details pages) and `manage-styles.js`. |
| `ask/` (asking, phase 3) | `ask-core.js` (`JE.arrAsk`: the caller's capabilities from `acquire/requests/me`, asks and cancels with a retry-safe `clientRequestId`, honest family words for every request outcome, `onChange` for surfaces to refresh; `searchInstance`/`adminSearch` for an administrator's Search through the Manage drawer's audited search route), `ask-episodes.js` (season pages: Get it on missing episodes, Search on ones missing for a long while, rows drawn for missing episodes Jellyfin has no row for when the viewer shows missing episodes, Jellyfin's own missing rows decorated, the download ring on a thumbnail, Get them on the Missing line, the episode dialog; plugs into `status-episodes.js` through `extend()`), `ask-search.js` (JE-mode "Not in your library" search row, which replaces Seerr's search row in JE mode), `ask-seerr.js` (in JE mode Seerr's request buttons, its details window's request buttons and season picker, discovery rows and Home Screen Sections' discover cards open JE's request sheet) and `ask-styles.js` (styles and `JE.initializeArrAsk`, started by `JE.initializeArrStatus`). |
| `ask/` (request sheet, smart actions, collections) | `ask-sheet.js` (`JE.arrAskSheet`: the request sheet — bottom sheet on phones, dialog on desktop, full-screen on TV — with the series cards and their costs, over-quota "Send to … for an OK", the 4K choice; `openOrAsk` asks for a movie with one tap unless the sheet is needed), `ask-actions.js` (Get Season N, Get missing episodes, More… and Get 4K under the status block of details pages; called by `status-details.js`), `ask-collection.js` ("You have 4 of 6. Get the 2 missing" on collection pages, from `acquire/requests/collection/{itemId}`) and `ask-sheet-styles.js` (their styles). |
| `ask/` request controls mount API | `JE.arrAskSheet.mount(container, { key, kind, name, year, poster, seasons })` draws a title's request controls (Request or "Ask {contact}", Search for a title missing for a long while, Notify me, the current request state) into any container and returns `{ update(status), destroy() }`; `update` takes the title's status from `JE.arrStatus`. For pages that show a title JE draws itself. The full contract is in the comment at the top of `ask-sheet.js`. |
| `notify/` | Notifications (phase 2): `notify-core.js`, `notify-styles.js`, `notify-bell.js` (the header bell and inbox, pop-up toasts), `notify-follow.js` (Notify me / Following buttons) and `notify-panel.js` (the **Requests & alerts** settings section). |

### Web tags: `js/tags/`

| File | Responsibility |
|---|---|
| `genretags.js`, `languagetags.js`, `qualitytags.js` | Genre badges, language flags and quality tags such as resolution, dynamic range and audio format. |
| `ratingtags.js` | Jellyfin `CommunityRating` and `CriticRating`, with star/tomato presentation. Metadata providers or MDBList synchronization determine the upstream scores. |
| `ageratingtags.js` | Color-coded parental/age ratings, sharing the Colored Ratings color table. |
| `peopletags.js` | Cast age, birthplace flags and deceased indicators. |
| `userreviewtags.js` | Average of rated reviews visible to the current viewer, composed into the rating overlay. Uses tag-cache averages or batched `/JellyfinEnhanced/reviews/ratings` requests. |
| `tag-cache-store.js` | IndexedDB snapshot scoped by server and user; memory-only fallback when unavailable. |
| `tag-pipeline.js` | Restores/downloads the bulk server cache, applies `?since=` deltas and scans cards in idle slices. |
| `tag-styles.js` | Retrieves validated color overrides and injects web CSS; paired with server `Services/PosterTags/TagStyles.cs`. |

See [Tag Styles and CSS](../enhanced/tags.md#tag-styles-and-css) and [Native Poster Tags](../enhanced/tags.md#native-poster-tags-experimental) for controls and defaults. Tag Styles change colors, not size, shape or position. Administrator controls under **Display** map to these properties:

| Setting | Property |
|---|---|
| **Enable Tag Styles** | `TagStylesEnabled` |
| **Apply Tag Styles To** | `TagStyleTarget` |
| **Preset** | `TagStylePreset` |
| **Apply to** | `TagStyleApplyScope` |
| **Enable Native Poster Tags (Experimental)** | `NativePosterTagsEnabled` |
| **Additional Excluded Clients** | `NativePosterTagsWebClientNames` |

The editor stores `TagStyleOverrides=""` until overrides are saved. Native rendering uses the same validated styles.

### Other web components

| Location | Responsibility |
|---|---|
| `js/elsewhere/elsewhere.js` | Streaming-provider discovery; see [Elsewhere Features](../elsewhere/elsewhere-features.md). |
| `js/elsewhere/reviews.js` | TMDB and JE user reviews. Review visibility uses the shared author policy; Spoiler Guard suppression of this web panel is client behavior. |
| `js/awards/awards.js` | Details-page awards banner, backed by `Services/WikidataAwardsService.cs` and `Model/AwardsData.cs`. Authenticated `GET /JellyfinEnhanced/awards/{mediaType}/{tmdbId}` supports `movie`, `tv`, `person`; Wikidata needs no API key. Server results are cached. |
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

On the server, `EventHandlers/ActivityPlaybackConsumer.cs` records playback-stop activity after at least 5% progress or Jellyfin-reported completion. `Services/ActivityFavoriteMonitor.cs` watches favorite changes; `ActivityService.cs` supplies the recording API over `UserConfigurationManager` storage. `ActivityFeedBuilder.cs` merges activity and reviews, filters by viewer access/author visibility, then hydrates card data.

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

`js/others/mdblist-ratings.js` displays the details-page ratings row. `Services/MdblistService.cs` fetches/caches upstream results, with cache/account models in `Model/MdblistRatings.cs`.

`ScheduledTasks/MdblistRatingsFetchTask.cs` uses `MdblistRatingsFetchRunner.cs` to populate the cache and stops when remaining quota reaches the reserve. `MdblistRatingsSyncTask.cs` writes cached scores into Jellyfin's `CommunityRating` and `CriticRating`; the display overlay does not write metadata.

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

### Root services: `Services/`

| Files | Responsibility |
|---|---|
| `RadarrService.cs`, `SonarrService.cs` | *arr integration access. Shoko handling is in the main controller. |
| `AutoMovieRequestService.cs`, `AutoSeasonRequestService.cs` | Automatic next-collection-movie and next-season request decisions/execution. |
| `AutoMovieRequestMonitor.cs`, `AutoSeasonRequestMonitor.cs` | Playback event subscriptions feeding those request services. |
| `WatchlistMonitor.cs`, `SeerrScanTriggerService.cs` | Watchlist event handling and debounced library-add → Seerr recently-added scan bridge. |
| `SeerrParentalFilter.cs` | Shared parental filtering for integration responses. |
| `TmdbResponseCache.cs`, `TmdbCompanyTvDiscover.cs` | TMDB response caching/coalescing and studio-produced TV discovery shaped for Seerr consumers. |
| `MovieCollectionsBatch.cs`, `WatchProvidersBatch.cs` | Parsing/shaping batched collection and regional streaming-provider lookups. Movie collections use Seerr first, then TMDB when needed. |
| `ItemStatsService.cs` | Aggregate item/subtree size and watch-progress data for detail chips. |
| `TagCacheService.cs`, `TagCacheMonitor.cs` | Builds/persists tag data and incrementally maintains it from library events. |
| `TagCachePendingChanges.cs`, `TagCacheResponseBody.cs` | Coalesces pending item changes; assembles bulk response bytes and hashes the viewer's final body for its ETag. |
| `HiddenContentResponseFilter.cs` | Filters supported Jellyfin item lists and Home Screen Sections responses using the viewer's hidden-content scopes. |
| `ReviewAuthorCache.cs` | Cached author lookups for review visibility, invalidated by user changes/deletion/lockout. |
| `CdnAssetService.cs` | Local routes and disk caching for third-party static assets; separate from generated embedded poster assets. |
| `ScriptInjectionStartupFilter.cs`, `BrandingAssetStartupFilter.cs` | Request-time loader injection and custom branding asset delivery. |
| `StartupService.cs`, `HostCompatibilityService.cs` | Scheduled startup initialization and build/host compatibility diagnostics. |
| `WhatsNewService.cs` | Admin control-schema discovery and change-baseline persistence. |
| `UsageEventCounterService.cs`, `AnalyticsReportingService.cs` | Usage counters and opt-in report construction/sending; see [Community Analytics](community-analytics.md). |
| `WikidataAwardsService.cs`, `MdblistService.cs` | Awards and MDBList fetching/cache ownership. |
| `ActivityService.cs`, `ActivityFavoriteMonitor.cs`, `ActivityFeedBuilder.cs`, `CatchUpLogService.cs` | Activity recording/selection and separate Catch Up action logs. |
| `MaintenanceModeService.cs` | Maintenance state file, policy changes/restoration, message tokens `{countdown}` / `{ends_at}` and session popups. |
| `MaintenanceScheduleService.cs` | Hosted 30-second timer for scheduled windows and timed-window expiry; distinct from scheduled tasks. |

### Spoiler Guard and identity

All files in this table are under `Services/SpoilerGuard/`:

| File | Responsibility |
|---|---|
| `ImageBlurService.cs` | SkiaSharp Gaussian blur, stock cards and pre-encoded fail-closed JPEG fallback, with result caching. |
| `SpoilerBlurImageFilter.cs` | Replaces protected image/trickplay responses with parent art, blur or fallback according to mode and availability. |
| `SpoilerFieldStripFilter.cs` | Strips/rewrites supported unwatched-item metadata in Jellyfin API responses, honoring user state and overrides. |
| `SpoilerIdentityService.cs`, `SpoilerIdentityTagFilter.cs` | Stable per-user markers and item DTO image-tag stamping for anonymous image requests. The tag filter also calls native poster stamping. |
| `ImageTagDecoration.cs` | Shared parsing/composition of `[sb-{8hex}-]{jellyfinTag}[-jet{23hex}][-jeu{12hex}]`. |
| `SpoilerUserResolver.cs` | Loads Spoiler Guard state for the resolved requester. |
| `SpoilerNextUnwatchedService.cs` | Cached per-user/per-series next-unwatched boundary for advanced category reveals. |
| `SpoilerTagDataStripper.cs` | Removes sensitive tag data, shared by web tag endpoints and native poster rendering. |
| `SpoilerAutoEnableFilter.cs` | Shared content-type/library scope gate for first-play, Seerr-request and library-add automation. |
| `SpoilerAutoEnableArmer.cs` | Bulk arming for users with library access, including disabled accounts, with one locked `spoilerblur.json` update per user. |
| `SpoilerLibraryAddAutoEnabler.cs` | Batches new-title library events into bulk arming. |
| `SpoilerExistingTitlesApplier.cs` | Preview/application for existing titles, run by `ScheduledTasks/SpoilerApplyExistingTitlesTask.cs`. |
| `SpoilerSeerrPendingPromoter.cs` | Converts pending pre-acquisition protection into library-item entries when content arrives. |

`Services/Identity/RequestIdentityService.cs` resolves authenticated claims first, then image markers, the single-user shortcut, validated cookies and session-by-IP candidates. Consumers distinguish confident identity from ambiguous shared-IP candidates.

Server filters protect supported Jellyfin images/metadata; suppression of JE's Reviews panel happens in `js/elsewhere/reviews.js`. The review-list API uses author visibility rules and does not itself apply that web-panel suppression. See [Spoiler Guard](../spoiler-guard/spoiler-guard-features.md) for protection boundaries.

### Native Poster Tags: `Services/PosterTags/`

Native rendering draws each user's tags into Primary image responses for clients that do not run web overlays. It is subject to the administrator master gate and enabled tag groups. Original artwork files are preserved. The administrator controls are listed under [Web tags](#web-tags-jstags).

Per-user setting in the Enhanced panel:

| Setting | Default | What it does |
|---|---|---|
| **Show Tags in Native Clients (Experimental)** | On when unset (`UseNativePosterTags=null`) | Personal preference, subject to the administrator master gate. |

| File or directory | Responsibility |
|---|---|
| `NativeClientPolicy.cs` | Excludes known clients running web overlays plus admin-configured client names. |
| `NativePosterTagStamper.cs` | Metadata-time Primary tag stamping, called by `SpoilerIdentityTagFilter`. |
| `PosterTagSettings.cs`, `PosterTagSettingsProvider.cs` | Effective personal settings/admin defaults, rendering digest, per-user cache and invalidation on settings/config changes. |
| `PosterTagUserCache.cs`, `PosterTagReviewRatings.cs` | User lookups and viewer-aware review averages. |
| `PosterTagDataProvider.cs` | Cache/on-demand tag data, access checks and Spoiler Guard stripping. |
| `PosterTagModel.cs`, `PosterTagResolver.cs` | Semantic corner/group/tag layout and web-parity resolution rules. |
| `PosterTagComposer.cs` | Data → layout → pixels, shared by image filtering and previews; content-addressed cache keys and composition version. |
| `PosterTagImageFilter.cs` | Primary response composition. Registered before the blur filter, so its response processing runs after blur and draws on the protected result. Rendering failure passes through the underlying image response. |
| `PosterTagVariantToken.cs` | Signed `-jet` variants bound to user, item, settings, pixel version, flags and data hash. |
| `CompositeImageCache.cs` | Byte-bounded memory LRU and disk cache under Jellyfin's cache path, in-flight coalescing and bounded render concurrency. |
| `TagStyles.cs` | Validated shared color overrides for web CSS and native drawing. |
| `Resolution/` | `AgeRatingRules.cs`, `GenreIcons.cs`, `JsText.cs`, `LanguageFlagRules.cs`, `LanguageNames.cs`, `QualityTagRules.cs`, `RatingRules.cs`, `ResolutionData.g.cs`. |
| `Rendering/` | `PosterTagAssets.cs`, `PosterTagCss.cs`, `PosterTagImageScaler.cs`, `PosterTagPlan.cs`, `PosterTagRenderer.cs`, `PosterTagText.cs`, `PosterTagTileCache.cs`: embedded assets, layout, scaling, text shaping, drawing and reusable tile caching. |

`ResolutionData.g.cs` is generated by repository-root `tests/poster/parity/gen-resolution-data.mjs`; do not edit it by hand. Renderer/composition version changes retire existing variant tokens, preventing old URLs from serving newly changed pixels under long-lived client caches.

`PosterTagVariantToken.cs` persists a 32-byte random signing secret at `<PluginsPath>/configurations/Jellyfin.Plugin.JellyfinEnhanced/native-poster-tags.key`, separate from rendered-image caches. Preserve it for URL-signing continuity during restoration.

Missing or wrong-length keys are recreated; old URLs can serve original artwork until clients refresh metadata. Persistence failure logs a warning and uses a process-lifetime key, changing URLs after restart. Unix creation uses owner-only read/write permissions. This is internal state without an admin control.

### Requests & downloads (new): server

These server directories back the experimental Requests & downloads integration. Its routes are in [the API reference](api.md#requests-downloads-new).

| Location | Files and responsibilities |
|---|---|
| `Services/Secrets/` | Credentials kept out of the plugin configuration. `SecretsStore.cs`: The owner-only `secrets.json` sidecar holding every stored API key and secret, plus short-lived server-side handles for keys imported from Seerr. `SecretValue.cs`: The placeholders the configuration, the dashboard and every response carry instead of a credential (mask, import handle, clear request). `SecretsMigration.cs`: Moves plain-text credentials into the store at start-up (idempotent), merges dashboard saves (a placeholder or blank keeps the stored value) and writes them back for a downgrade. `Configuration/PluginConfigurationSecrets.cs` holds the accessors features use to read the real values. |
| `Services/Arr/` | Foundations of "Requests & downloads (new)". `ArrInstanceRegistry.cs`, `ArrConnection.cs`, `ArrRegistryMigration.cs`: Instance registry v2 — typed, id-addressed Sonarr/Radarr instances (role, default, linked libraries, path mappings) over the existing `SonarrInstances` / `RadarrInstances` settings, with role-based default selection. `ArrClient.cs`, `ArrClientFactory.cs`, `ArrHttp.cs`: One client per instance on a named HttpClient that never follows redirects and checks the address it connects to; per-call timeouts and size caps, typed `ArrError`s, GET backoff, paging, `appName` and version detection (`ArrSystemStatus.cs`). `ArrActionRunner.cs`, `ArrAuditLog.cs`, `ArrConfirmationTokens.cs`: Direct arr writes with an idempotency key, read-back, an append-only `arr-audit.jsonl` and confirmation tokens for destructive actions. `ArrActivityMirror.cs`: Copies each audited action into Jellyfin's activity log (phase 2). `ArrDiagnostics.cs`: The connection check used by the admin test routes. `ArrStateStore.cs`, `ArrSnapshotSlot.cs`, `ArrStateLoaders.cs`, `ArrStateModels.cs`: In-memory snapshots per instance (library index with provider ids and tags, the whole queue, a history ring kept current with `history/since`, a calendar window, system facts), refreshed in the background, single-flight, with failure backoff and a warm-start file for the library. The existing queue, history, calendar, link and tag-sync code reads from it, so serving a page makes no arr call. **`ArrStateReconciler.cs`** is the hosted loop that runs due refreshes; **`ArrCallAttribution.cs`** counts upstream calls per request; **`ArrLegacyViews.cs`** builds the existing routes' response shapes from the snapshots. **`ArrStateStore.Live.cs`** adds what live updates need: change notifications, in-place library patches, refreshes for live hints and single-title re-reads. **`ArrQueueStates.cs`** is the one precedence table for queue rows (status composer, Needs attention, the store's first-seen clocks); **`ArrIds.cs`** treats provider id 0 as missing. `/Live/`: Live updates (phase 1). **`ArrSignalR.cs`** is the hand-rolled SignalR hub client (one connection per instance, backoff, pings) and **`ArrLiveService.cs`** the hosted service that runs them and turns messages into re-reads; **`ArrLiveRouter.cs`** coalesces those hints. **`ArrWebhookReceiver.cs`** checks webhook calls (per-instance secret, rate limits) and **`ArrWebhookProvisioner.cs`** sets the webhook up in the arr with consent. **`ArrChangeDetector.cs`** / **`ArrChangeTracker.cs`** turn snapshot changes and Jellyfin library adds/removes into title-key revisions in **`ArrChangeFeed.cs`**, which browsers long-poll; **`ArrFeedAudience.cs`** filters it per user; **`ArrTitleKey.cs`** defines the keys (`movie:tmdb:…`, `tv:tvdb:…[:s…[:e…]]`). |
| `Services/Arr/CalendarDedup.cs` | Merges calendar events several instances report for the same release; "also in" names only instances whose event the caller may see. |
| `Services/Acquire/` | The status composer behind "where has it got to" (Requests & downloads, phase 1). **`StatusComposer.cs`** derives stage, reason code and journey from the arr snapshots, Jellyfin and request facts; **`ArrStatusService.cs`** serves them per user from memory with a per-user body cache (**`ArrStatusCache.cs`**) keyed by the snapshots, the Jellyfin library and the change feed's per-title revisions; **`ArrJellyfinView.cs`** is the Jellyfin side (items, copies, episodes as each viewer may see them, and each movie's or episode's playable versions with their dimensions); **`EditionAvailability.cs`** the one answer to whether a viewer has the standard or the 4K edition of a scope (per version, across every copy they can open, or the copy a page is pinned to), used by request status, request fulfilment and Get 4K; **`TitleKey.cs`** the title keys shared with the change feed; **`TitleAliases.cs`** every key a title is known by (arr libraries, complete Seerr requests), so status, Calendar and audience copy lookups share its ids; **`EpisodeRange.cs`** the full inclusive range of a combined episode file, shared by status, notifications and privacy checks. **`SeerrRequestReadModel.cs`** reads Seerr's request list in the background (probe, paged full read, title details) and answers the composer's request facts, each user's requests and the feed announcements of changed requests; **`RequestsHubService.cs`** builds each user's Requests page from it; **`ArrManageService.cs`** the administrator's Manage drawer (overview from the snapshots, audit log and read model; Search now through the action runner). **`AcquireDatabase.cs`** is the SQLite database of Requests & downloads (`acquire.db`, the host's own Microsoft.Data.Sqlite, versioned migrations, one writer at a time, consistent copies for JE backups). Phase 2: **`ArrAdminHubService.cs`** builds the administrator's Overview/Activity/System tabs from memory, **`NeedsAttention.cs`** derives the Needs attention rows (and groups the queue into downloads), **`ArrQueueActionService.cs`** runs queue actions through the action runner (remove with data only with a confirmation token), **`JellyfinBridge.cs`** + **`BridgePaths.cs`** refresh the nearest Jellyfin folder after an arr import (never a TV library root), list imports Jellyfin doesn't have and run the path doctor, over **`JellyfinLibraryAccess.cs`** (the Jellyfin library seam); **`ArrInstanceLibraries.cs`** resolves which Jellyfin library an instance's title folder lands in (mapped title folder constrained to linked libraries, else linked libraries, else unresolved; shared by status, follows, the feed, Calendar and the path doctor); **`ArrAdminOpsFeed.cs`** announces the administrators' change-feed key the admin tabs follow. In **`/Helpers/`**, **`ArrCaller.cs`** decides who counts as a person on these routes (never an API key, the empty user id or an unknown user), **`BodyLimitAttribute.cs`** caps request bodies before model binding with a structured 413, **`PrivateResponseAttribute.cs`** marks administrators' answers `private, no-store`, and **`SeerrAskedProofCache.cs`** holds each user's Seerr requests for the legacy queue and history (read only when a row needs them, shared, never waited on for long). |
| `Services/Acquire/Notify/` | Notifications (Requests & downloads, phase 2). **`NotificationService.cs`** turns change-feed, Seerr and Jellyfin library changes (and the Jellyfin bridge's indexed imports) into notifications per user (first looks, ready transitions, episode batches, declines, Remind, and admin events from the admin tools' Needs attention list); **`NotifyStore.cs`** keeps follows, settings, watch state, the inbox and deliveries in `acquire.db`; **`NotifyDispatcher.cs`** delivers to ntfy and e-mail with retries and quiet hours; **`NotifyChannels.cs`** holds the ntfy and SMTP senders and the endpoint checks; **`NotifyTexts.cs`** the phone/e-mail texts. Routes in **`Controllers/NotifyController.cs`**; the browser side in **`js/arr/notify/`** (bell and inbox, toasts, Notify me / Remind buttons, the "Requests & alerts" settings). |
| `Services/Acquire/Automation/` | The phase-4 automation engine (Requests & downloads). `AutomationFlags.cs` is the switch hierarchy and each recipe's mode as it applies (with the rollout Shadow guard), `AutomationModes.cs` the recipes and their stored modes and kill switches, `AutomationDecision.cs` the no-write decision seam (a rolled-back ledger preview) and who is eligible to go ahead without an OK, `AutomationBudgets.cs` durable atomic budget admission in acquire.db (rolling UTC windows, unique actions, uncertain sends counted until read back, fail closed), `AutomationAdmission.cs` the send guard for queued automatic work (per-write budget admission, breaker counting), `AutomationWriteGate.cs` the one write gate every automatic outbound write passes immediately before it leaves (Direct and Seerr backends, the old recipes' direct Seerr POST: every switch, kill, mode, consent, eligibility, breaker, disk and budget gate; facts first, then one decision: every storage read is made before the live settings are read and judged, and facts that may have gone stale meanwhile are read again, checked by version stamps), `AutomationFacts.cs` the one registry of every fact that check reads (read in its decision from memory, or gathered with a version every change moves before it can be seen), the Jellyfin user versions (each person's, and every person's at once) and the filter that brackets every Jellyfin action that can change or authenticate a user (a test walks the check against the registry, another scans every writer for its bracket, both on the Roslyn semantic model; `Helpers/FactVersion.cs` is that version, a seqlock: every change runs inside its bracket, odd before it can be seen and even after, also when it throws), `JellyfinUserActions.cs` which actions those are, deny by default: every non-GET action of Jellyfin's user, Quick Connect and start-up controllers, and every action whose code reaches a user change or a sign-in, followed across the Jellyfin server assemblies next to it (metadata only, read once: interface and virtual calls to their implementations, sealed overrides included, delegate fields and events to what is stored in them; a non-GET action reaching a call that can't be followed and whose contract carries a user is bracketed for everyone, one reaching a callback that can't be followed, whatever its type, for the request's person; `PersonScoped` lists reviewed changes to the request's own person; its known limits are in `docs/arr/arr-features.md`) (`tests/backend/Integrations/IntegrationJellyfinApiUserActionTests.cs` runs the filter over Jellyfin's own `Jellyfin.Api.dll` and server assemblies, which `tests/backend/jellyfin_api.py` copies out of the pinned images), `AutomationTransportHandler.cs` the guarantee behind it: the HTTP handler on the arr, Seerr and default clients that checks every write made in an automation context (an `AsyncLocal` the outbox and the old recipes set) synchronously as it is handed on, the job's budget reservations among the gate's facts and judged with their live limits in the same decision; the write sites' own calls and the test `tests/backend/Integrations/WriteGateWalk.cs` (a walk of the code from each gate to its HTTP send, and in a strict mode from the final decision to the hand-off) stay as defence in depth, `AutomationRecordSnapshot.cs` every live setting a recorded automatic intent depends on (compared as a whole before the ledger write and before a Shadow decision is saved), `AutomationStore.cs` decisions, recorded grants, breakers and the migration record, `AutomationMigration.cs` the one-time start-up migration, `AutomationConsents.cs` each person's recipe preference, `AutomationRisk.cs` which risk classes may ever be automatic, and `AutomationStatus.cs` the administrators' status and the request backend's admission contract. Routes in **`Controllers/ArrAdminAutomationController.cs`**; the Requests page card in **`js/arr/admin/admin-automation.js`**. |
| `Services/Acquire/Requests/` (phase 4b household rules) | `HouseholdFlags.cs` the switches as every route and worker reads them; `HouseholdRules.cs` the fixed conditions per role (rating, genre, original language, size estimate, streaming service), their validation and the verdict with its precedence (deny, look, approve, preset); `RuleFacts.cs` the title facts they read from TMDB through the shared cache (bounded memory cache, failed reads retried soon); `GroupQuotaPolicy.cs` group pools and who draws on which; `HouseholdTrust.cs` the Trusted role behind the automation engine's trust seam; `HouseholdRulesService.cs` the administrators' rules editor (and Seerr's own rules, read-only, in Seerr mode). The ledger keeps each want's verdict (schema 4 `rule_detail`) and binds each reservation to its pool (`pool_id`); `RequestLedger.PreviewBatch` previews a run of asks in one rolled-back transaction. Routes in **`Controllers/AcquireRulesController.cs`** (rules editor, streaming services, batch preview). |
| `Services/Acquire/Lists/` | Phase-4 lists (playlist and collection entries for titles not in the library). `ListStore.cs` keeps one document per list in `lists/` (atomic writes, per-list locks, a reverse index by title ids); `ListOrder.cs` the pure order algebra (real-entry tokens, projections, Jellyfin's move coordinates); `ListRules.cs` entry validation, identity, edition and the request a list ask makes; `ListHost.cs` the Jellyfin seam (lists, shares, inserts and moves on 12 and 10.11); `ListAccess.cs` who may see and edit a list and the parental filter of entries; `ListGate.cs` the one list access gate, read right before every Jellyfin write (its single-use `ListWrite` grant) and every answer with list contents (with the person's policy revision, which statuses are bound to); `ListEditionAvailability.cs` the temporary adapter for shared source-level edition availability (scope, viewers, optional pinned copy, actual playable source IDs, including alternate versions and grouped physical series folders); `ListResolver.cs` which library items stand for an entry (and fill progress); `ListPlaylistPlacement.cs` putting new items at their spot; `ListService.cs` views and every change (durable operations); `ListAcquisition.cs` Request one / Request all missing through the request service; `ListSwapService.cs`/`ListSwapMonitor.cs` swap-in on arrivals (consent-gated, intents settled by Jellyfin's real membership); `ListLifecycle.cs` deleted lists, restores and deleted people; `ListDatabase.cs` operations, marker tombstones, request links and swap-in events in acquire.db (schema 5); `ListContinuation.cs` the runtime create/swap continuation boundary (fresh state and access after awaits, synchronous writes and the final create projection sharing deletion's lifecycle lock); `ListStatusSource.cs` the shared status for entries; `ListMetadata.cs` the metadata source behind `IListMetadataSource`; `ListSourceOwnership.cs` linked-source ownership on swap-in; `ExperimentalListImporter.cs` the one-time importer of the experimental lists; `LegacyCollageWithhold.cs`/`LegacyCollageWithholdFilter.cs` keep the poster collages the experimental lists drew into a list's own image (and the playlist/collection library tiles built from it) from every image route, item answer, search hint, image info and WebSocket message on both Jellyfin versions, without touching the files (`LegacyCollageProjection.cs` is the one rule, applied to the JSON as it is written, touching only the image fields of withheld items; `LegacyCollageBody.cs` is every answer body's byte boundary, whatever the action's result type: it decides when the bytes are written (checking again before each further part of a long answer), holds JSON in memory or in a temporary file of its own so an answer of any size is checked, and keeps its character set; `LegacyCollageSockets.cs` wraps Jellyfin's WebSocket manager so every message passes it; `LegacyCollageCompositions.cs` wraps Jellyfin's image processor so each library tile it composes from list images is recorded with the sources it read (copies JE judged first) and their verdicts; and `LegacyCollageTiles.cs` keeps that record in `lists/legacy-collage-tiles.json`: a tile is served only once its content is a composition of clean sources, one composed from a collage stays withheld for good, and a damaged record gives back every complete entry it still holds); `ListFlags.cs` the switches and per-person preferences. Routes in **`Controllers/AcquireListsController.cs`**, models in **`Model/ListPlaceholders/`**, the daily task in **`ScheduledTasks/ListMaintenanceTask.cs`** and the client transport in **`js/arr/lists/list-api.js`** (`JE.arrLists`). `ListSummaries.cs` answers the Playlists page (which lists have entries the person can see), with its models in `Model/ListPlaceholders/ListPageDtos.cs`. The pages themselves are in **`js/arr/lists/`**: `list-paint.js` (the paint gate: each page's ticket and Spoiler Guard policy, through which every list DOM write goes), `list-render.js` (rows, collection cards, styles, the Spoiler Guard rule), `list-playlist.js` (entries inline on playlist pages), `list-collection.js` (the collection section and the covered keys), `list-grid.js` (the Playlists page mark), `list-request.js` (Request on one entry through the shared sheet) and `list-pages.js` (when they draw and stop, `JE.arrListPages`). |
| `Services/Acquire/Stamps/` | Phase-4 acquisition badges (New for you, Upgraded, 4K). `AcquisitionStamp.cs` holds the fixed stamp values, the switches and lifetimes (`AcquisitionStampFlags`), the 4K copy rule, per-source identity/arrival facts and the seams; `AcquisitionStampStore.cs` the facts in acquire.db (schema 7: a person's first arrivals, confirmed upgrades, judged arrivals and first arrival per part), stable source observations, an in-memory fact index and one restore/deletion write guard; `AcquisitionStampFeeder.cs` the background writer (source arrivals and updates, the arrs' history in memory, catch-up and housekeeping); `AcquisitionStampResolver.cs` the pure in-memory decision per viewer and item that web cards and native posters share; `AcquisitionStampSources.cs` the Jellyfin, request/follow and arr-history adapters, the per-person preference reader and the deleted-user purge. Route in **`Controllers/AcquisitionStampsController.cs`** (`GET acquire/stamps`); native posters draw the stamp through `Services/PosterTags/` (an `Acquisition` group, pinned in the poster's data hash); the web badge is built by `JE.arrStatus.buildBadge` in **`js/arr/status/`**. |
| `Services/Acquire/Requests/` | Durable request server core. `RequestModels.cs` contains normalized scopes, outcomes and the pure quota projector; `RequestPolicy.cs` resolves server-owned roles, quotas and visibility (stored requests carry their persisted target; Seerr connection proof is scoped to that source, including approval notices); `RequestLedger.cs` commits intent, reservations, approvals, events and outbox jobs in acquire.db (schema 3 adds each want's server-built origin and provenance and its operation; schema 4 the household-rule verdict, each reservation's group pool and the order charges were made in); `RequestOperations.cs` keeps durable batch/confirmation operations and derives each title's request id from the operation (a retry or restart reuses it, a new confirmation gets new ones). `RequestService.cs` orchestrates policy preparation and private list projections. `RequestOutbox.cs` provides local title locks, restart recovery, final-send authorization and a network-free fallback transport. `RequestBackends.cs` sends each job through the backend it was authorised for: `DirectArrBackend.cs` (Jellyfin Enhanced mode: Sonarr/Radarr adds and field-scoped monitoring, confirmed by a fresh read) or `SeerrBackend.cs` (Seerr mode, as the person who asked); `ArrAddService.cs` is the administrators' Manage › Add to. `LedgerRequestFacts.cs` selects ledger facts in JE mode and the existing Seerr read model otherwise (including when requests went out, which restarts the "still looking" clock), and builds the part of a title one person's requests ask for (seasons, single episodes, edition) for the Requests page, the household list, approval cards and notifications. `RequestSearchService.cs` runs the arr's search again for what requests already sent (family Search). `RequestLedgerArrivals.cs` (part of the ledger) marks requests fulfilled and reads the requester notices the ledger writes (delivered as OK'd / declined alerts by `Notify/NotificationService.cs`); `RequestFulfilment.cs` notices when what a request asks for is in Jellyfin and marks it fulfilled (Ready, never stale). `FutureSeasonCharges.cs` charges the owner of a "Keep getting new episodes" request once per new season a Sonarr library read shows started; in Seerr mode it also asks Seerr for each new started season every few hours (Seerr doesn't follow new seasons itself). `RequestDestination.cs` is the one rule for where a request goes (its target, and an administrator's Seerr server, profile, root folder and options stamp): every ledger and charges path where one request covers, dedups, follows or stands for another asks it, and so does every approval that re-confirms or edits one (a fresh stamp re-confirms only on the request's own Seerr; what went out never moves); it also says when two requests are for the same title and edition. `RequestLedgerTitles.cs` (part of the ledger) holds every title under one key across its TMDB, TVDB and IMDb ids: the aliases it has learned (`title_aliases`) resolve every key that comes in, and learning one moves the title's requests, jobs and acquisitions to its canonical key and merges what was held apart (a request another one of the title already covers then follows it, with its charge given back; nothing is sent again). A merge that meets work in flight (being sent, or unconfirmed) is noted (`title_reconcile`) and finished once that work settles (`SettleMerges`, after each send and in the background pass), and the ledger's one send-time check (`ClaimForDispatch`) never sends what already went out for the title. Mutually covering uncertain retries detect wait cycles and choose the earliest charge (then job id) to resume; ordinary unsent duplicates wait. The Requests hub composes and caches each title edition separately, including its Ready state and cancellation ids. `RequestTitleIdentity.cs` hands what the arr libraries and Seerr's requests say about a title's ids to it, and is the one place every way into the ledger (an ask, a preview, a batch, an approval, a family Search) resolves the title's key before anything is prepared (`Entry`); it also runs a background pass over every stored title (after start, after an arr library read changes, and every few minutes). `AcquireRequestsController.cs` exposes the authenticated server API. In Seerr mode `SeerrBackend.cs` also reads Seerr's Radarr/Sonarr servers (profiles, root folders, the options stamp) for administrator Seerr request options, checks a chosen server, profile and folder again right before the POST and sends them with it; **`Controllers/AcquireSeerrOptionsController.cs`** lists those options to administrators. `SeerrMigrationReader.cs` reads every Seerr request complete-or-nothing (with a digest and Seerr's requesting state) and `SeerrMigration.cs` runs the admin dry run, the import into `RequestLedgerImport.cs` (import batches, rollback by batch, the automation log) and the switch to JE request handling; `AcquireMigrationController.cs` exposes it to administrators. `SharedRequestFacts.cs` answers "who asked" for the watchlist features with a completeness flag, and `RequestOutboxEvents.cs` tells the Seerr scan nudge about confirmed adds. |
| `Services/Acquire/Requests/SeasonRowsService.cs` | One season's request rows for the season page (`GET acquire/requests/season/{itemId}`): the caller's request state per episode (their own first, other people only as "household") and the TMDB title, air date, runtime, overview and still path of the episodes Jellyfin has no file for (shared TMDB cache, server key); episodes hidden from the caller are left out. |
| `Services/Acquire/Requests/` (household and discovery) | `RequestHubProjection.cs` (approval cards, the caller's own requests and the Manager chip-bar counts, with display data from `HouseholdDirectory.cs`: people, library access, title name/year/rating; where a request would land and a 4K copy already here from `RequestPlaces.cs`, memory only), `HouseholdService.cs` (the Household tab: read for Managers and Admins, save of roles, quotas and the preset for Jellyfin administrators) and `DiscoverService.cs` (JE-mode Discover rows and search from TMDB, filtered per caller for parental limits, library access and Hidden Content). Routes: `Controllers/AcquireHouseholdController.cs`, `AcquireDiscoverController.cs` and `AcquireCollectionsController.cs`. |
| `Services/Acquire/Requests/CollectionGapsService.cs` | What a person has of a Jellyfin collection and which movies are missing, from the collection's TMDB entry (shared TMDB cache, server key); movies Jellyfin hides from the person are left out and missing ones pass the parental check for titles not in Jellyfin. Served by **`Controllers/AcquireCollectionsController.cs`** (`GET acquire/requests/collection/{itemId}`). |
| `Services/AutoRequest/` | The auto season / auto movie hand-off. `PlaybackTriggerChannel.cs` is the bounded, coalescing queue the playback handlers write to in constant time; `PlaybackTriggerGate.cs` is the single-flight gate (cooldown only after a definitive outcome, short backoff after a failed lookup); `AutoRequestOutcome.cs` holds the typed outcomes; `AutoRequestRecorder.cs` records a recipe's decision as a request-ledger want while phase 3 is on. |
| `Services/NativeDetails/` (Jellyfin 12 build only) | The native details facade for titles that aren't in the library. **`SyntheticId.cs`** (both builds) is the page id codec; **`NativeDetailsFacadeFilter.cs`** answers jellyfin-web's details requests for those ids from **`NativeDetailsAllowlist.cs`** (everything else naming one is refused) with **`NativeDetailsDtos.cs`**, under **`NativeDetailsPolicy.cs`** (who may open a page; session epochs end artwork grants on sign-out), from **`NativeDetailsSource.cs`** (Seerr/TMDB, shared public metadata) and **`NativeDetailsArtwork.cs`** (signed artwork grants, key kept in the plugin data folder, per-viewer upstream budget from **`ViewerBudget.cs`**, which also limits the feed reads). **`NativeDetailsLinks.cs`** decides where the page's names lead for the viewer (a library person, genre or studio they can open, else the person's own page or the genre/studio/network discovery page; read only). **`NativeDetailsFeeds.cs`** serves those pages' title lists (a person's filmography, the genre/studio/network discovery feeds) through **`Controllers/NativeDetailsFeedsController.cs`**, read with JE's own Seerr key (new reads limited per viewer and queued server-wide in `NativeDetailsSource.cs`, with **`FeedScheduler.cs`** capping each viewer's share of the queue and handing upstream slots to waiting viewers in turn, 429 past that) and filtered for the viewer on the server (parental limit, then any library copy they can open, a title whose copies are all hidden from them left out, an absent title only when its page would open). **`NativeDetailsPages.cs`** turns a page id into the absent-title page (`Services/Acquire/AbsentTitle.cs`, both builds) that the status and season-row routes compose by key; **`Controllers/NativeDetailsController.cs`** is `native-details/resolve`, the navigator's "where does this title open" (a copy the caller can open first). |
| `Services/Backup/JeBackupService.cs` | Export (zip with manifest and checksums; credentials left out or AES-GCM encrypted with a passphrase), scheduled copies with rotation (`ScheduledTasks/JeBackupTask.cs`, "Back up Jellyfin Enhanced data", no default triggers) and verified restore with a safety copy (`JellyfinEnhanced.RestoreConfiguration` applies the configuration). |
| `Helpers/LanguageTags.cs` | The display languages JE stores and hands to clients: the tag rule from the embedded `js/language-policy.json` and the shipped locale codes (the panel's language list), read at run time from the locale files the build embeds (`js/locales/`; a new file needs no other step). A saved or default display language is a language tag of a shipped bundle (exactly or by base language) or Auto. Every writer of a person's `settings.json` stores the display language through it (`UserConfigurationManager.SaveUserConfiguration`; a backup restore and the start-up folder migration through `GateSettingsBytes`, which replaces only that value in the file and leaves out a file it can't read), as do configuration saves for the administrator's default. `TranslationsScript` serves `js/enhanced/translations.js` with the same rule and list written in, so the client's `JE.supportedLanguageCode` computes the same. |
| `Helpers/Jellyseerr/SeerrDownloadStatusProjector.cs` | Strips release names, download ids and arr ids from the download rows in Seerr answers for anyone who isn't an administrator. |
| `Helpers/Jellyseerr/SeerrLibraryAccessProjector.cs` | Keeps Seerr's links to Jellyfin items to what the caller can open: hidden copies are unlinked, another copy the caller can open takes their place, and list rows of titles the library hides from the caller are left out. |

### Personal home rows and collection coverage (phase 4d)

`Controllers/AcquireHomeController.cs` serves the caller's home rows and the administrator's actionable ops strip.
`Services/Acquire/AcquireResponseGate.cs` checks current policy at the synchronous response boundary for home and collection answers.
`Services/Acquire/Home/HomeProjection.cs` projects ledger/Seerr requests and notification follows into independent
30-day coming-soon and 7-day first-arrival windows. `HomeFlags.cs` owns the effective switches and tri-state display
preferences. `HomeArrivals.cs` records library events outside the scan thread; `Services/Acquire/ContentArrivalHistory.cs`
is the permanent first-content-arrival store shared with acquisition stamps. `AcquireDatabase.Initialize` repairs an
empty schema-6 slot at every supported startup, including schema-7 restores, without resetting versions or dates.

`FollowDates.cs` reads missing followed-title dates through the bounded, shared TMDB cache. `HssSectionsAdapter.cs`
registers three optional Home Screen Sections providers and verifies successful registration before advertising HSS.
Its authenticated results use real items and native absent-title pages on Jellyfin 12. Jellyfin 10.11 uses native
injection. `CollectionCoverage.cs` publishes `ICollectionCoverage.CoveredAsync`: viewer-filtered movie keys, projected
through `ListGate` after parental checks with fresh access, preferences and list membership. A list renderer may replace
that DI seam; hidden entries must never affect the visible gap count.

`js/arr/home/home-{styles,render,hss,rows}.js` provides cards, HSS decoration and one abortable lifecycle with the existing
change feed. It mounts once, clears on navigation or account changes, and adds no status poller. Home tests live in
`tests/backend/Home/`, collection integration tests in `IntegrationCollectionGapsPhase4Tests.cs`, and browser-module tests
in `features-arr-home.test.mjs`, `features-arr-collection-gaps-p4.test.mjs` and `bootstrap-settings-home.test.mjs`.

Home arrival projection consumes the badge adapter's playable source facts and persistent source observations, keeping edition arrival separate from permanent first-content arrival. HSS sections reconcile their cards, order and visibility against each fresh home answer.

### Native Dashboard user settings

- `Controllers/AcquireAdminUsersController.cs`: D19 human-administrator routes, private responses and partial group edits.
- `Services/Acquire/Users/AdminUserSettingsService.cs`: adapters over existing request policy, quota projection, pools, personal JSON, notification state, automation grants and list attribution; source revisions and audited writes.
- `js/arr/adminusers/admin-users-api.js`: independent private reads and narrow PATCH/ntfy transport.
- `js/arr/adminusers/admin-user-tabs.js`: reversible native tab selection, indicator, keyboard and supported deep links for both Dashboard route families.
- `js/arr/adminusers/admin-users.js`: vertical user form, retained drafts, one Save with per-section errors and batched card decoration.
- `tests/backend/Users/AdminUserSettingsTests.cs` and `tests/frontend/features/features-arr-admin-users.test.mjs`: administrator boundaries, inheritance/conflicts/unavailability/consent preservation and native-route lifecycle coverage.
- `Configuration/UserSettingsDefaults.cs`: one in-memory default mapping shared by first access, first administrator display write and reset, keeping unrelated preferences consistent without recording personal consent.

### Helpers, extensions and models

| Location | Files and responsibilities |
|---|---|
| `Helpers/` | `ArrUrlGuard.cs` checks integration URLs; `BuildAttestation.cs` handles release attestation; `ProviderHelper.cs` and `UserHelper.cs` resolve provider/user identifiers; `ReviewVisibility.cs` applies author visibility; `TagEpisodeSelector.cs` chooses representative episodes with usable streams. |
| `Helpers/` language handling | `MatroskaLanguageReader.cs`, `MediaStreamLanguageResolver.cs` recover stream language data; `AudioLanguageTagHelper.cs` maps base/regional codes to tag names and computes changes. |
| `Helpers/Jellyseerr/` | `SeerrHttpHelper.cs`, `JellyseerrPermissionHelper.cs`, `JellyseerrUserImportHelper.cs`: HTTP, permission and import helpers. `ParentalRatingDecision.cs`, `ParentalTagDecision.cs`, `SeerrCertificationExtractor.cs`, `SeerrTagSignatureExtractor.cs`: shared parental decisions/extraction. |
| `Extensions/` | `ItemRepositoryExtensions.cs`, `JellyfinDbContextExtensions.cs`, `UserManagerExtensions.cs`: repository/database provider lookups and compatible user enumeration across server API changes. |
| `Model/TagCacheEntry.cs` | Precomputed item tag data, including parent-series IDs for Spoiler Guard filtering without per-entry library lookups. |
| `Model/AnalyticsData.cs`, `WhatsNewData.cs` | Report/counter records and inclusion/exclusion annotations; configuration-schema and pending-change records. |
| `Model/AwardsData.cs`, `MdblistRatings.cs` | Awards cache records and MDBList cache/account models. |
| `Model/Arr/` | `ArrInstance.cs`, `ArrItem.cs`, `ArrType.cs`: integration instance/item/type models. |
| `Model/Jellyseerr/` | `JellyseerrPermission.cs`, `JellyseerrUser.cs`: Seerr permission/user models. |

### Event handlers: `EventHandlers/`

| File | Responsibility |
|---|---|
| `ActivityPlaybackConsumer.cs` | Qualifying playback-stop activity recording. |
| `ContinueWatchingPlaybackEvents.cs` | `ContinueWatchingPlaybackConsumer` clears Continue Watching-only hides on playback start and demotes combined Continue Watching/Next Up hides to Next Up-only. Global/Next Up-only hides remain. `ContinueWatchingLibraryHook` prunes removed item IDs from personal hidden-content documents. |
| `MaintenancePlaybackReminder.cs` | `MaintenancePlaybackReminderConsumer` re-sends active-maintenance notifications on playback start, throttled per session. |
| `SpoilerAutoEnableEvents.cs` | `SpoilerAutoEnableOnFirstPlayConsumer` arms a series on qualifying first-episode playback. |
| `UserTopologyEvents.cs` | `UserDeletedSettingsRemover` deletes a removed user's Jellyfin Enhanced settings folder. User creation/deletion invalidates identity caches; updates/deletions invalidate tag-access caches; updates/deletions/lockout invalidate review-author caches. |

### Scheduled tasks

The table lists task names as shown by Jellyfin and their default triggers. Files are under `ScheduledTasks/` unless stated otherwise.

Feature gates still apply when a task runs. Default triggers are distinct from an administrator's saved schedule.

| File | Task name | Default triggers |
|---|---|---|
| `AnalyticsReportTask.cs` | **Send Anonymous Usage Report** | Every 24 hours; execution also checks the configured reporting interval. |
| `ArrTagsSyncTask.cs` | **Sync Tags from \*arr to Jellyfin** | None |
| `AudioLanguageTagsSyncTask.cs` | **Sync Audio Language Tags to Jellyfin** | None |
| `BuildTagCacheTask.cs` | **Refresh Tag Cache** | Daily at 03:00 |
| `ClearTranslationCacheTask.cs` | **Refresh Translation Cache** | Application startup |
| `JeBackupTask.cs` | **Back up Jellyfin Enhanced data** | None |
| `JellyfinToSeerrWatchlistSyncTask.cs` | **Sync Watchlist from Jellyfin to Seerr** | Daily at 03:30 |
| `JellyseerrUserImportTask.cs` | **Import Jellyfin Users to Seerr** | Every six hours |
| `JellyseerrWatchlistSyncTask.cs` | **Sync Watchlist from Seerr to Jellyfin** | Daily at 03:00 |
| `MdblistRatingsFetchTask.cs` | **Fetch Ratings from MDBList** | None |
| `MdblistRatingsSyncTask.cs` | **Sync Ratings from MDBList to Jellyfin** | None |
| `RefreshCdnAssetsTask.cs` | **Refresh CDN Assets** | Application startup and every 24 hours |
| `SpoilerApplyExistingTitlesTask.cs` | **Spoiler Guard: apply to existing titles** | None |
| `Services/StartupService.cs` | **Jellyfin Enhanced Startup** | Application startup |

`MdblistRatingsFetchRunner.cs` is shared fetching logic, not another task. Hosted timers/monitors listed above are separate from this dashboard task system.

Administrator setting under **Display**:

| Setting | Default | What it does |
|---|---|---|
| **Enable Audio Language Tags Sync** | Off (`AudioLanguageTagSyncEnabled=false`) | Gates the language-tag task's writes to movies/series. |

`TagCacheService.cs` applies the same language tags when rebuilding entries after library events.

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

`js/fonts/` contains `materialsymbolsrounded.woff2`, `materialsymbolsoutlined.woff2`, `materialsymbolsrounded-subset.woff2` and `materialsymbolsoutlined-subset.woff2`. Full fonts use the public Material Symbols family names for themes/custom CSS; subsets use private `JE Material Symbols …` families and `.je-msym-*` classes for JE's own icons. Keep those families separate so a subset does not shadow a theme's full font.

Generated `Assets/PosterTags/` contains `fonts/NotoSans-Bold.ttf.br`, `flags/*.webp`, `icons.json`, `vector-icons.json`, `age-rating-colours.json`, `quality-colours.json`, `THIRD_PARTY_NOTICES.md` and `manifest.json`. The manifest records pins, tool versions, options and output checksums and is excluded from embedding. These generated assets use explicit resource names.

Full regeneration requires Python 3.10+ with the generator's pinned fonttools/Brotli/Pillow versions, plus Node 18+, pinned Playwright and Chromium for flags. Use the dependency versions in the script/manifest to reproduce bytes. From the repository root:

```sh
python3 scripts/build_poster_assets.py --check
python3 scripts/build_poster_assets.py --check --full
```

The fast check uses only the Python standard library to verify repository inputs and output checksums. The full check regenerates into a temporary directory and compares bytes, requiring the complete toolchain.

### Regression tests and inventory

Use this tree to find test suites, shared fixtures and supporting evidence.

```text
tests/
├── run.py
├── README.md
├── backend/                          # JE.Tests.csproj + jf12/jf10 package locks
│   ├── Api/
│   ├── Core/
│   ├── Integrations/
│   ├── PosterTags/
│   ├── Privacy/
│   ├── ScheduledTasks/
│   └── Support/                      # Shared storage/plugin/HTTP fixtures
├── frontend/
│   ├── run.mjs
│   ├── bootstrap/
│   ├── core/
│   ├── features/
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
