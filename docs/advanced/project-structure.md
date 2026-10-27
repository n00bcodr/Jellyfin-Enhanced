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
│   └── CatchUpController.cs           # Catch Up event recording and admin reads
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
│   ├── Identity/
│   ├── PosterTags/
│   │   ├── Rendering/
│   │   └── Resolution/
│   └── SpoilerGuard/
├── Assets/
│   └── PosterTags/                   # Generated, embedded rendering assets
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
| `Configuration/configPage.html`, `configPage.css` | Admin UI, control labels, save wiring and styling. Tabs: **Overview**, **Display**, **Playback**, **Pages**, **Seerr**, **\*arr**, **Elsewhere & Reviews**, **Extras**, **Keyboard**, **Admin**, **Docs**. |
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
| `js/elsewhere/elsewhere.js` | Streaming-provider discovery; see [Elsewhere & Reviews Features](../elsewhere/elsewhere-features.md). |
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

### Helpers, extensions and models

| Location | Files and responsibilities |
|---|---|
| `Helpers/` | `ArrUrlGuard.cs` checks integration URLs; `BuildAttestation.cs` handles release attestation; `ProviderHelper.cs` and `UserHelper.cs` resolve provider/user identifiers; `ReviewVisibility.cs` applies author visibility; `TagEpisodeSelector.cs` chooses representative episodes with usable streams. |
| `Helpers/` language handling | `MatroskaLanguageReader.cs`, `MediaStreamLanguageResolver.cs` recover stream language data; `MatroskaLanguageCache.cs` keeps each file's parsed languages (persisted, keyed by path, size and modification time) so unchanged files are not reopened; `AudioLanguageTagHelper.cs` maps base/regional codes to tag names and computes changes. |
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
| `UserTopologyEvents.cs` | User creation/deletion invalidates identity caches; updates/deletions invalidate tag-access caches; updates/deletions/lockout invalidate review-author caches. |

### Scheduled tasks

The table lists task names as shown by Jellyfin and their default triggers. Files are under `ScheduledTasks/` unless stated otherwise.

Feature gates still apply when a task runs. A task is hidden from the dashboard list while its feature is off and appears again once the feature is on, with no restart. Always listed: Refresh Translation Cache, Refresh CDN Assets and Jellyfin Enhanced Startup. Default triggers are distinct from an administrator's saved schedule.

| File | Task name | Default triggers |
|---|---|---|
| `AnalyticsReportTask.cs` | **Send Anonymous Usage Report** | Every 24 hours; execution also checks the configured reporting interval. |
| `ArrTagsSyncTask.cs` | **Sync Tags from \*arr to Jellyfin** | None |
| `AudioLanguageTagsSyncTask.cs` | **Sync Audio Language Tags to Jellyfin** | None |
| `BuildTagCacheTask.cs` | **Refresh Tag Cache** | Daily at 03:00 |
| `ClearTranslationCacheTask.cs` | **Refresh Translation Cache** | Application startup |
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
