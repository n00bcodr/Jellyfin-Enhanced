## Project Structure

The plugin architecture uses a single entry point (`plugin.js`) that dynamically loads all other feature components.

The ordered module list lives in `js/component-scripts.json` (paths relative to `js/`; entries starting with `//` are ordering notes). Modules **execute in manifest order**, and that ordering is load-bearing: a module placed before one whose exports it reads at load time will bind `undefined`. Add new modules to the manifest *after* their producers.

In production the server concatenates the manifest into one script, `GET /JellyfinEnhanced/bundle.js` (`Services/ClientScriptBundle.cs`: built once per process, cache-keyed and immutable like every other script, with a `sections` source map at `bundle.js.map` so DevTools and stack traces still show the original file names and lines). The bundle wraps each file in a function and publishes them as `window.__JE_BUNDLE_MODULES`; once the configuration is applied, `plugin.js` inserts the script and runs the functions in manifest order in short slices scheduled in the browser's idle time (`requestIdleCallback`, capped), so evaluating 150+ modules never delays jellyfin-web's own first view. A module that throws at its top level is reported and skipped, not re-run; if the request fails or the bundle does not parse, every file is injected individually with `script.async = false` (parallel download, manifest-order execution), exactly as before the bundle existed. Dev mode (`DevMode` config) always uses the individual files.

`plugin.js` also fetches everything it needs before the component stage in one request, `GET /JellyfinEnhanced/bootstrap` (version, public config, admin-only private config, the Custom Tabs / Plugin Pages presence flags, the five per-user documents and the manifest), falling back to the individual endpoints if that fails. Its `Prefetched` block also carries the small answers modules ask for on every page load (the user's Spoiler Guard state, the Seerr user status and reachability when no Seerr call is needed, the active-streams session list under that endpoint's gate), each exactly the body of its standalone endpoint; modules take them once through `JE.takePrefetched(name)` shortly after the page load and otherwise call the endpoint as before.

Three client scripts are **not** in the manifest and are loaded by their own dedicated loaders: `others/splashscreen.js` and `extras/login-image.js` (both injected early, before the component stage, so they can affect the login screen) and `enhanced/translations.js` (loaded at the start of `initialize()`, in parallel with the bootstrap request, ahead of the component stage).

The client is delivered by `Services/ScriptInjectionStartupFilter.cs`, which injects `plugin.js` into the web client; all `js/**` files are embedded resources (`JellyfinEnhanced.csproj`) served by `GetScript` in `Controllers/JellyfinEnhancedController.cs`.

### File Structure

All client-side scripts live in `Jellyfin.Plugin.JellyfinEnhanced/js/`, grouped by feature. Server-side directories are summarised below. The Spoiler Guard services, event handlers, models and identity helpers are listed in full because they implement the server half of Spoiler Guard, whose client companion lives in `js/enhanced/spoilerguard/`; the remaining services are elided. Note the client never references these classes by name — it interacts with them through endpoints, cookies and image responses.

```text
Jellyfin.Plugin.JellyfinEnhanced/
├── JellyfinEnhanced.cs               # Plugin entry point, GetViews()
├── PluginServiceRegistrator.cs       # DI registration
├── Configuration/                    # PluginConfiguration.cs, UserConfiguration*.cs,
│                                     # configPage.html + configPage.css — the admin
│                                     # settings page
├── Controllers/                      # JellyfinEnhancedController.cs — every
│                                     # /JellyfinEnhanced/* endpoint the client calls;
│                                     # ArrAdminController.cs — arr registry/diagnostics
│                                     # and the credential rollback (admin only);
│                                     # ArrStateController.cs — arr snapshot diagnostics;
│                                     # ArrLiveController.cs — arr webhook receiver,
│                                     # change feed and webhook set-up;
│                                     # ArrStatusController.cs — title status routes;
│                                     # RequestsHubController.cs — the Requests page
│                                     # and the admin Manage drawer;
│                                     # JeBackupController.cs — backup/export/restore
├── PluginPages/                      # HTML wrappers for the sidebar/plugin pages
├── Assets/
│   └── PosterTags/                   # Embedded fonts, icon paths, flags, age-rating
│                                     # colours + licences for Native Poster Tags
│                                     # (generated by scripts/build_poster_assets.py)
├── Helpers/  Extensions/  ScheduledTasks/
│   └── Helpers/Jellyseerr/           # SeerrHttpHelper, ParentalRatingDecision,
│                                     # ParentalTagDecision, SeerrCertificationExtractor,
│                                     # SeerrTagSignatureExtractor
├── EventHandlers/
│   ├── ContinueWatchingPlaybackEvents.cs
│   ├── MaintenancePlaybackReminder.cs
│   ├── SpoilerAutoEnableEvents.cs
│   └── UserTopologyEvents.cs
├── Model/
│   ├── TagCacheEntry.cs
│   ├── Arr/                          # ArrInstance.cs, ArrItem.cs, ArrType.cs
│   └── Jellyseerr/                   # JellyseerrPermission.cs, JellyseerrUser.cs
├── Services/
│   ├── …                             # root-level services (Radarr, Sonarr,
│   │                                 # TagCache*, CdnAsset, WatchlistMonitor,
│   │                                 # SeerrParentalFilter, MaintenanceMode*,
│   │                                 # TmdbResponseCache, TmdbCompanyTvDiscover,
│   │                                 # ItemStatsService, ScriptInjectionStartupFilter,
│   │                                 # ClientScriptBundle, MovieCollectionsBatch, …)
│   ├── Identity/
│   │   └── RequestIdentityService.cs
│   ├── PosterTags/                   # Native Poster Tags (experimental)
│   │   ├── PosterTagModel.cs         # semantic layout contract (groups, corners, tags)
│   │   ├── PosterTagSettings.cs      # effective per-user settings + digest
│   │   ├── PosterTagResolver.cs      # tag-cache entry → layout (JS parity)
│   │   ├── Resolution/               # quality, language-flag, genre-icon, rating and
│   │   │   └── …                     # age-rating rules ported from js/tags/
│   │   ├── Rendering/                # PosterTagRenderer.cs (SkiaSharp drawing),
│   │   │   └── …                     # PosterTagAssets.cs (embedded asset loading)
│   │   ├── NativeClientPolicy.cs     # which clients get drawn-in tags
│   │   ├── PosterTagVariantToken.cs  # signed per-user image tag suffix
│   │   ├── PosterTagSettingsProvider.cs
│   │   ├── PosterTagDataProvider.cs
│   │   ├── PosterTagImageFilter.cs   # composites tags into Primary image responses
│   │   └── CompositeImageCache.cs    # memory + disk cache of drawn posters
│   └── SpoilerGuard/
│       ├── ImageBlurService.cs
│       ├── SpoilerBlurImageFilter.cs
│       ├── SpoilerIdentityService.cs
│       ├── SpoilerIdentityTagFilter.cs
│       ├── SpoilerFieldStripFilter.cs
│       ├── SpoilerTagDataStripper.cs
│       ├── SpoilerAutoEnableFilter.cs
│       ├── SpoilerAutoEnableArmer.cs
│       ├── SpoilerLibraryAddAutoEnabler.cs
│       ├── SpoilerExistingTitlesApplier.cs
│       ├── SpoilerSeerrPendingPromoter.cs
│       └── SpoilerUserResolver.cs
└── js/
    ├── plugin.js
    ├── component-scripts.json        # ordered module manifest (bundle + loader order)
    ├── fonts/                        # Material Symbols Rounded/Outlined: *-subset.woff2 (~5 KB each,
    │                                 # generated by scripts/material-symbols/subset.py) under the
    │                                 # private 'JE Material Symbols …' families JE's rules use (on the
    │                                 # private .je-msym-* classes), plus the full fonts under the
    │                                 # public names for themes/custom CSS
    ├── locales/                      # 26 translation files (en.json, de.json, …)
    ├── core/
    │   ├── api-client.js
    │   ├── dom-observer.js
    │   ├── lifecycle.js
    │   ├── media-language.js
    │   ├── navigation.js
    │   ├── session.js
    │   ├── tag-renderer-base.js
    │   └── ui-kit.js
    ├── enhanced/
    │   ├── config.js
    │   ├── events.js
    │   ├── features-random-button.js
    │   ├── helpers.js
    │   ├── icons.js
    │   ├── native-tabs.js
    │   ├── themer.js
    │   ├── translations.js
    │   ├── ui-styles.js
    │   ├── bookmarks/
    │   │   ├── bookmarks.js
    │   │   ├── bookmarks-library-init.js
    │   │   ├── bookmarks-library-items.js
    │   │   ├── bookmarks-library-modals.js
    │   │   ├── bookmarks-library-page.js
    │   │   ├── bookmarks-library-render.js
    │   │   ├── bookmarks-library-replacements.js
    │   │   └── bookmarks-library-styles.js
    │   ├── hiddencontent/            # 16 modules: data, filter, save, panel, dialogs,
    │   │   └── …                     # buttons, styles, init, custom-tab + the page
    │   │                             # (nav, state, render, cards, admin, init, styles)
    │   ├── homeremoval/
    │   │   ├── features-remove-home.js
    │   │   └── features-remove-multiselect.js
    │   ├── itemdetails/
    │   │   ├── features-details-media-info.js
    │   │   ├── features-details-page.js
    │   │   └── features-release-dates.js
    │   ├── player/
    │   │   ├── auto-skip.js
    │   │   ├── osd-rating.js
    │   │   ├── pausescreen.js
    │   │   ├── playback-rating-badge.js
    │   │   ├── playback.js
    │   │   └── subtitles.js
    │   ├── settingspanel/
    │   │   ├── ui-entry-points.js
    │   │   ├── ui-panel.js
    │   │   ├── ui-panel-hidden-content.js
    │   │   ├── ui-panel-language.js
    │   │   ├── ui-panel-settings.js
    │   │   ├── ui-panel-shortcut-editor.js
    │   │   ├── ui-panel-template.js
    │   │   └── ui-release-notes.js
    │   └── spoilerguard/             # 12 modules: state, ids, identity, snooze,
    │       └── …                     # styles, dialog, detail-button, seerr-toggle,
    │                                 # settings-tab, image-refresh, watched-refresh, index
    ├── jellyseerr/
    │   ├── api.js
    │   ├── hss-discovery-handler.js
    │   ├── issue-reporter.js
    │   ├── item-details.js
    │   ├── jellyseerr.js
    │   ├── modal.js
    │   ├── request-manager.js
    │   ├── seamless-scroll.js
    │   ├── seerr-detail-link.js
    │   ├── seerr-status.js
    │   ├── nativedetails/
    │   │   └── native-details.js
    │   ├── discovery/
    │   │   ├── discovery-base.js
    │   │   ├── discovery-filter-utils.js
    │   │   ├── collection-discovery.js
    │   │   ├── genre-discovery.js
    │   │   ├── network-discovery.js
    │   │   ├── person-discovery.js
    │   │   └── tag-discovery.js
    │   ├── moreinfo/                 # 8 modules: styles, data, seasons, badges,
    │   │   └── …                     # render, actions, actions-tv, init
    │   ├── recommendations/          # 8 modules: styles, catalog, data, render,
    │   │   └── …                     # page, category, init, custom-tab
    │   └── ui/                       # 10 modules: icons, styles, popover, badges,
    │       └── …                     # cards, buttons, quota, results,
    │                                 # request-modals, season-modal
    ├── arr/
    │   ├── arr-links.js
    │   ├── arr-tag-links.js
    │   ├── calendar/                 # 7 modules: styles, data, render-events,
    │   │   └── …                     # render-views, actions, init, custom-tab
    │   ├── live/
    │   │   ├── arr-live.js           # JE.arr.onStatusChange (change-feed long-poll)
    │   │   └── arr-intent.js         # JE.arrIntent (intent tokens for remote lists)
    │   ├── status/                   # 5 modules: core, episodes, details, cards,
    │   │   └── …                     # styles (status pill, chips, poster badges)
    │   └── requests/                 # 8 modules: styles, data, render-helpers,
    │       └── …                     # render-cards, render, actions, init, custom-tab
    ├── tags/
    │   ├── genretags.js
    │   ├── languagetags.js
    │   ├── peopletags.js
    │   ├── qualitytags.js
    │   ├── ratingtags.js
    │   ├── ageratingtags.js
    │   ├── userreviewtags.js
    │   ├── tag-cache-store.js
    │   └── tag-pipeline.js
    ├── elsewhere/
    │   ├── elsewhere.js
    │   └── reviews.js
    ├── extras/
    │   ├── active-streams.js
    │   ├── colored-activity-icons.js
    │   ├── colored-ratings.js
    │   ├── login-image.js
    │   ├── plugin-icons.js
    │   └── theme-selector.js
    └── others/
        ├── letterboxd-links.js
        └── splashscreen.js
```

Outside the plugin project, `scripts/` holds maintenance tooling: `generate_config_flag_groups.py` (regenerates `docs/advanced/config-flag-groups.json`, run by the docs CI), `validate-translations.js` (locale file checks) and `build_poster_assets.py` (downloads the pinned upstream fonts, icons and flags, verifies their checksums and writes `Assets/PosterTags/`; `--check` verifies the committed assets are up to date).

### How modules are organised

Each module is an IIFE. Features larger than a single file get their own directory.

The page-style directories that were split most recently (`arr/calendar/`, `arr/requests/`, and largely `jellyseerr/moreinfo/` and `jellyseerr/recommendations/`) use a concern-based suffix pattern:

| Suffix | Responsibility |
|---|---|
| `-styles` | CSS injection only |
| `-data` | State object and data access (fetching, caching) |
| `-render` | HTML/DOM construction (may split further, e.g. `-render-cards`) |
| `-actions` | User interactions — filters, pagination, buttons |
| `-init` | Bootstrap, navigation wiring and the public surface |
| `-custom-tab` | Mounts the feature inside a Custom Tabs / native tab panel |

Other directories use different concern names and prefixes — `spoilerguard/` uses bare names (`state.js`, `snooze.js`, `styles.js`), `settingspanel/` and `jellyseerr/ui/` use a `ui-` prefix, `jellyseerr/discovery/` puts the concern first (`discovery-base.js`) or last (`genre-discovery.js`), and `itemdetails/`/`homeremoval/` keep the `features-` prefix from the file they were split out of. **Follow the local convention of the directory you are touching** rather than applying the table above universally.

Modules in the same directory share state through a namespace object. In most directories every module that touches shared state runs the same idempotent guard, so whichever of them loads first seeds the shape (`-custom-tab` and standalone `-styles` modules consume the public surface instead and never reference the namespace):

```javascript
// run by every module that shares the directory's state
const P = (JE.internals.requestsPage = JE.internals.requestsPage || { /* state */ });
```

`jellyseerr/ui/` and `jellyseerr/moreinfo/` instead nominate a single owner — the first module that *uses* the namespace seeds the literal (`ui-icons.js` and `more-info-modal-data.js` respectively) and the rest read it directly (`const internal = JE.internals.jellyseerrUi;`), so a duplicated default can never silently diverge.

Directory names avoid hyphens (`settingspanel`, not `settings-panel`). Embedded-resource names are derived from the file path, and a hyphen in a *directory* segment is rewritten to an underscore while file-name hyphens are preserved — a hyphenated directory therefore makes its modules unreachable at runtime.

### Component Breakdown

* **`plugin.js`**: The main entry point. It loads the plugin configuration, user settings and translations (one bootstrap request plus the translations module), then loads the `component-scripts.json` modules in dependency order — the server-side bundle in production, individual files in dev mode or as a fallback (the three dedicated-loader scripts noted above are injected separately).

* **`/core/`**: Shared primitives used across every feature. Introduced to remove logic that was previously duplicated per module.
    * **`api-client.js`**: The single HTTP layer — `JE.core.api.{fetch,jf,plugin}` with auth headers, retry/backoff, response caching, request deduplication, concurrency limiting and `AbortController` support.
    * **`dom-observer.js`**: Multiplexed `MutationObserver` management — one shared body observer with named subscribers, plus dedicated observers and `waitForElement`.
    * **`lifecycle.js`**: Per-feature registration of observers, timers and listeners so they can be torn down together on navigation.
    * **`media-language.js`**: Shared audio-language → flag resolution (`JE.core.mediaLanguage.resolveFlag`) used by the Language Tags overlay and the details-page audio-language row. Region-aware: an explicit region subtag (`pt-BR`, `es-419`, `zh-Hant`) resolves to that region's flag; bare base languages keep their default flag.
    * **`navigation.js`**: One deduped SPA navigation dispatcher (`onNavigate`, `onViewPage`), replacing the ad-hoc `hashchange`/`viewshow` listeners that previously double-fired on hash navigation and missed `pushState` navigation.
    * **`session.js`**: Identity-epoch tracker for SPA user switches. Logging out and back in as a different user never reloads the page, so this module detects the transition (an `ApiClient.setAuthenticationInfo` hook plus navigation/storage fallbacks), runs every registered per-feature reset handler (`JE.session.onUserChange`), and emits `je:user-changed`; `plugin.js` then re-fetches the incoming user's data and emits `je:user-data-loaded`. Async loaders capture `JE.session.getEpoch()` and drop stale results after a switch.
    * **`tag-renderer-base.js`**: The shared poster-tag engine — overlay creation, positioning, tagged-card deduplication, caching and reinitialisation. The five poster-overlay renderers (genre, language, quality, rating, age rating) supply a spec; `peopletags.js` and `userreviewtags.js` do not use it.
    * **`ui-kit.js`**: `escapeHtml`, `toast`, deduped CSS injection, and scroll-friendly tap detection (`addTouchTapListener`, and `addDelegatedTouchTapListener` for one set of listeners on a container of cards), and `placeDetailAction`, which puts JE's details-page buttons (Hide, Report issue, Spoiler Guard) in one fixed order before Jellyfin's More… whichever module draws first.

* **`/enhanced/`**: Core "Jellyfin Enhanced" functionality.
    * **`config.js`**: Manages all settings, both from the plugin backend and the user's local storage.
    * **`events.js`**: Listens for user input, browser events and DOM changes to trigger the appropriate functions from other components.
    * **`features-random-button.js`**: The random item button.
    * **`helpers.js`**: Utility functions shared across the enhanced components.
    * **`icons.js`**: Icon selection and rendering (emoji, Lucide or Material UI).
    * **`native-tabs.js`**: Shared registry for JE-created home tabs, used when a feature is shown as a native tab rather than via the Custom Tabs plugin. Reconciles against the live page on every pass: keeps each tab at the position its index names (Jellyfin resolves tabs by position), places ours after every index another plugin occupies (relabelling them if a claim appears later), and handles the stable `jeTab=<id>` deep links.
    * **`themer.js`**: Theme detection and Enhanced Panel styling.
    * **`translations.js`**: Loads and caches translations. Loaded by its own loader at the start of `initialize()`, ahead of the component stage, so `JE.t` is resolved before any component runs.
    * **`ui-styles.js`**: Global stylesheet for the injected UI, including the settings panel's responsive rules.
    * **`/bookmarks/`**: `bookmarks.js` handles playback bookmarks (creation via `B`, timeline markers, navigation); the `bookmarks-library-*` modules provide the management interface — listing, orphan cleanup, duplicate detection and time-offset adjustment.
    * **`/hiddencontent/`**: Per-user hidden content — the data/filter/save layer, the settings panel section, and the standalone management page.
    * **`/homeremoval/`**: "Remove from Continue Watching / Next Up", including multi-select.
    * **`/itemdetails/`**: Detail-page enhancements — media info, file size, audio languages and release dates.
    * **`/player/`**: Everything that touches the video player — `playback.js` (speed, seeking, track cycling), `auto-skip.js` (media-segment driven intro/outro skipping), `subtitles.js` (styling and presets), `pausescreen.js` (custom pause overlay), `osd-rating.js` (TMDB/Rotten Tomatoes in the OSD), `playback-rating-badge.js` (age rating and genres card when playback starts).
    * **`/settingspanel/`**: The user settings panel — entry points, the HTML template, the section navigation shell, and per-section wiring (settings, language, hidden content, shortcut editor, release notes).
    * **`/spoilerguard/`**: Client-side companion for Spoiler Guard — the per-show/movie/collection toggle, in-memory opt-in and override state, the settings pane, and the soft image refresh after toggles and watched-state changes. The actual blur/strip happens server-side. `index.js` publishes the public `JE.spoilerBlur` surface once every implementation module has loaded.

* **`/jellyseerr/`**: Seerr integration.
    * **`api.js`**: Communication with the Seerr proxy endpoints on the Jellyfin server.
    * **`hss-discovery-handler.js`**: Intercepts clicks on Home Screen Sections discover cards and opens the title's native details page (when offered) or the Seerr More Info modal instead of navigating to the external Seerr site.
    * **`nativedetails/native-details.js`**: Native details for titles that aren't in the library (experimental, Jellyfin 12 web). `JE.titleDetails` is the one navigator every entry point uses (`open`, `show`, `openKey`: a library copy the viewer can open first, else the native page, else the More Info modal once), with the synthetic page id codec shared with the server; the page adapter hides actions a title without files can't do, holds the Request / Open controls and the slot the details surface draws into, adds the modal's ratings, information panel, trailers and collection, and shows a neutral refusal when the server refuses the title. Person pages made for cast and crew the library doesn't have get their "Known for" line, and the discovery pages of genres, studios and networks the library lacks (synthetic genre/studio ids on Jellyfin's list page) lose the empty list's controls; the genre, network and person discovery rows read those pages' ids.
    * **`issue-reporter.js`**: Report problems with media items directly from Jellyfin.
    * **`item-details.js`**: Similar and Recommended rows on item detail pages (when their data comes before Jellyfin has rendered the item, built ahead in idle time and inserted with that render), plus the "Request More" button for series with unrequested seasons.
    * **`jellyseerr.js`**: The Seerr search-results integration — intercepts Jellyfin's search page, renders Seerr results and handles their pagination/infinite scroll. Gated on `JellyseerrShowSearchResults`; the other Seerr components initialise independently of it.
    * **`modal.js`**: Advanced request modals.
    * **`request-manager.js`**: Thin alias onto `JE.core.api.manager`, kept as a stable public surface.
    * **`seamless-scroll.js`**: The buffer-fill infinite-scroll engine shared by the search row, the discovery modules and the Recommendations category page: keeps several screens of cards rendered ahead, passes each consumer a hint (deficit, engagement, empty-page budget) so it can fetch several pages in parallel and prefetch the next, pauses on a "Keep looking" button after 40 consecutive empty pages, and retries failures with backoff. Also owns the deduplicator helper.
    * **`seerr-detail-link.js`** / **`seerr-status.js`**: Detail-page link into Seerr, and the shared media/display status constants.
    * **`/discovery/`**: `discovery-base.js` owns the whole discovery lifecycle — three pagination strategies, abort handling, config gating, card rendering, filtering and cleanup. Each of `genre`, `network`, `person`, `tag` and `collection` supplies a small spec describing how to resolve its feeds. `discovery-filter-utils.js` provides shared TV/Movies/All filtering and card creation.
    * **`/moreinfo/`**: The Seerr More Info modal — cast, crew, extended metadata, seasons and request actions.
    * **`/recommendations/`**: The Recommendations page — Trending/Popular/Upcoming rows plus Studios and Networks tiles, with a "View All" category page. Available as a sidebar page or a tab.
    * **`/ui/`**: All visual elements of the integration — result cards, request buttons, status badges, quota display, the download-progress popover and the season/request modals.

* **`/arr/`**: Sonarr and Radarr integration.
    * **`arr-links.js`**: Links to Sonarr, Radarr and Bazarr on item detail pages, for administrators only.
    * **`arr-tag-links.js`**: Synced *arr tags as clickable links on item detail pages, with show/hide filtering.
    * **`/calendar/`**: The calendar page — upcoming items from Radarr and Sonarr, available via the sidebar or a tab.
    * **`/live/arr-live.js`**: `JE.arr.onStatusChange(keys, cb)` — pages showing download status subscribe to title keys and are called when they change; one long-poll per visible tab against `acquire/changes`, with backoff (Requests & downloads, phase 1).
    * **`/live/arr-intent.js`**: `JE.arrIntent.create(name, { intent })` → `{ next(), current(token), invalidate() }` — intent tokens for remote lists and searches: a read publishes its answer (or its error) only while it is the list's newest, the signed-in user is the same and what the page asks for (tab, query, filter, page) hasn't changed (Requests & downloads; used by the Downloads page data layer and the admin tabs).
    * **`/status/`**: Where each title has got to (Requests & downloads, phase 1): `status-core.js` (`JE.arrStatus`: status reads, family texts, pill, journey, badges, and subscriptions to the change feed that re-render a surface in place), `status-details.js` (pill on details pages), `status-arrival.js` (a details page whose title arrives turns into the playable page: Jellyfin reloads the same item, or the page moves to the item that replaced it; waits while the viewer types, plays or has a dialog open), `status-episodes.js` (episode chips and the missing-episodes banner), `status-cards.js` (lazy, batched poster badges), `status-modal.js` (the pill and journey in Seerr's more-info window) and `status-styles.js` (styles; `JE.initializeArrStatus` starts every status surface, the Requests page and the modal pill).
    * **`/hub/`**: The Requests page at `#/requests` (phase 1): `hub-page.js` (`JE.arrHub`: route, tabs, one read of `acquire/hub` per visit, re-read when the change feed reports a shown title or the user's own request list; for administrators the Downloads and Calendar pages rendered in tabs), `hub-render.js` (My requests groups, Coming soon agenda, Ready) and `hub-styles.js`.
    * **`/admin/`**: The administrator's phase-2 tabs of the Requests page: `admin-tabs.js` (Overview, Activity, System, Audit: loads each from its admin route, follows admin changes and polls once a minute (every 10 seconds without a feed subscription), retries failed refreshes, runs the fixes and queue actions, the remove dialog and the typed confirmation for removing with data), `admin-render.js` (instance cards, Needs attention, downloads, history, system, Jellyfin bridge and path doctor, audit) and `admin-styles.js`.
    * **`/hub/` phase-3 tabs**: `hub-extra-core.js` (shared helpers: capabilities, intent tokens, scope words), `hub-approvals.js` (Approvals: approve, approve with changes, decline with a reason, bulk approve), `hub-household.js` (Household: roles, quotas, preset), `hub-mine-ledger.js` (the caller's own requests from the ledger in My requests, with Cancel), `hub-chipbar.js` (the Managers' "needs your OK · stuck" chips on the home page), `hub-discover.js` (JE-mode Discover tab) and `hub-extra-styles.js`; they plug into `hub-page.js` through `H.extraTabs`.
    * **`/household/household-rules.js`** (phase 4b): household rules on the Requests page. The administrators' request conditions editor the Household tab mounts below its house rules (conditions per role, streaming country and services, shared allowances), Seerr's own rules read-only in Seerr mode, and rule verdicts, rule reasons and shared-allowance use in plain words for Approvals, My requests and the request controls (`JE.internals.arrHub.rules`).
    * **`/manage/`**: The administrator's Manage drawer (phase 1, Overview only): `manage-drawer.js` (`JE.arrManage.open({itemId}|{key})`: explanation, Search now, Open in Sonarr/Radarr, versions across instances, timeline, Seerr's requests; the Manage button on details pages) and `manage-styles.js`.
    * **`/requests/`**: The requests page — requests, download queue, issues and import history from the *arrs and Seerr, available via the sidebar or a tab.
    * **`/ask/` (asking for titles, phase 3)**: `ask-core.js` (`JE.arrAsk`: the caller's capabilities from `acquire/requests/me`, asks and cancels with a retry-safe `clientRequestId`, honest family words for every request outcome, `onChange` for surfaces to refresh; `searchInstance`/`adminSearch` for an administrator's Search through the Manage drawer's audited search route), `ask-episodes.js` (season pages: Get it on missing episodes, Search on ones missing for a long while, rows drawn for missing episodes Jellyfin has no row for when the viewer shows missing episodes, Jellyfin's own missing rows decorated, the download ring on a thumbnail, Get them on the Missing line, the episode dialog; plugs into `status-episodes.js` through `extend()`), `ask-search.js` (JE-mode "Not in your library" search row, which replaces Seerr's search row in JE mode), `ask-seerr.js` (in JE mode Seerr's request buttons, its details window's request buttons and season picker, discovery rows and Home Screen Sections' discover cards open JE's request sheet) and `ask-styles.js` (styles and `JE.initializeArrAsk`, started by `JE.initializeArrStatus`).
    * **`/ask/` (request sheet, smart actions, collections)**: `ask-sheet.js` (`JE.arrAskSheet`: the request sheet — bottom sheet on phones, dialog on desktop, full-screen on TV — with the series cards and their costs, over-quota "Send to … for an OK", the 4K choice; `openOrAsk` asks for a movie with one tap unless the sheet is needed), `ask-actions.js` (Get Season N, Get missing episodes, More… and Get 4K under the status block of details pages; called by `status-details.js`), `ask-collection.js` ("You have 4 of 6. Get the 2 missing" on collection pages, from `acquire/requests/collection/{itemId}`) and `ask-sheet-styles.js` (their styles).
        * **Request controls mount API**: `JE.arrAskSheet.mount(container, { key, kind, name, year, poster, seasons })` draws a title's request controls (Request or "Ask {contact}", Search for a title missing for a long while, Notify me, the current request state) into any container and returns `{ update(status), destroy() }`; `update` takes the title's status from `JE.arrStatus`. For pages that show a title JE draws itself. The full contract is in the comment at the top of `ask-sheet.js`.

* **`/tags/`**: Poster tag renderers. Five of them (genre, language, quality, rating, age rating) are built on `core/tag-renderer-base.js`; `peopletags.js` and `userreviewtags.js` render independently.
    * **`genretags.js`**: Genre information as tags on posters.
    * **`languagetags.js`**: Audio language as flag icons on posters.
    * **`peopletags.js`**: Age and birthplace for cast members, with country flags and deceased indicators.
    * **`qualitytags.js`**: Quality information (4K, HDR, Atmos) as tags on posters.
    * **`ratingtags.js`**: TMDB and Rotten Tomatoes ratings as badges on posters.
    * **`ageratingtags.js`**: The parental / age rating (PG-13, TV-MA, FSK 12, ...) as a colour-coded badge on posters, reusing the Colored Ratings colour table.
    * **`userreviewtags.js`**: The average user-review rating across all users, composed into the ratings overlay rather than rendered as its own poster tag. Resolves from the averages that ride on the server tag cache; asks `/reviews/ratings` in batches only without it.
    * **`tag-cache-store.js`**: The browser's copy of the server tag cache in IndexedDB, one per server and user, so a page load renders tags from it and only fetches what changed. Falls back to memory-only when IndexedDB is unavailable.
    * **`tag-pipeline.js`**: Shared server-backed tag cache feeding the renderers in bulk: restores the stored copy (or downloads the cache), keeps it current with `?since=` deltas, and scans cards in idle slices.

* **`/elsewhere/`**: Discovering media on other streaming services, and reviews.
    * **`elsewhere.js`**: Powers the "Jellyfin Elsewhere" feature.
    * **`reviews.js`**: TMDB reviews and the plugin's own per-user reviews on item detail pages (the reviews `userreviewtags.js` averages).

* **`/extras/`**: Optional scripts that extend functionality.
    * **`active-streams.js`**: Shows currently active streams.
    * **`colored-activity-icons.js`**: Material Design activity icons with custom colours.
    * **`colored-ratings.js`**: Colour-coded rating backgrounds on item detail pages.
    * **`login-image.js`**: User profile images instead of text on the manual login page.
    * **`plugin-icons.js`**: Custom plugin icons on the dashboard, plus custom config-page links.
    * **`theme-selector.js`**: Jellyfish colour palette selection, with an optional daily random theme.

* **`/others/`**: Miscellaneous utility scripts.
    * **`letterboxd-links.js`**: Letterboxd external links on movie and person (actor) detail pages.
    * **`splashscreen.js`**: The custom splash screen shown while the application loads.

* **`/Services/SpoilerGuard/`**: Server-side C# services that implement Spoiler Guard.
    * **`ImageBlurService.cs`**: SkiaSharp Gaussian blur, stock-card rendering, and the pre-encoded fail-closed fallback JPEG, with result caching.
    * **`SpoilerBlurImageFilter.cs`**: Intercepts image responses and replaces the bytes for unwatched items — safe parent art, blur, or the fail-closed dark card, depending on mode and availability.
    * **`SpoilerIdentityService.cs`**: Mints and resolves stable per-user image identity markers.
    * **`SpoilerIdentityTagFilter.cs`**: Stamps item DTO image tags with per-user identity markers so native image requests can be resolved without relying on IP address.
    * **`SpoilerFieldStripFilter.cs`**: Strips or rewrites metadata (titles, synopses, ratings, chapter names, cast, tags, taglines, air dates) in API responses for unwatched items, honoring per-user overrides.
    * **`SpoilerTagDataStripper.cs`**: Removes spoiler-sensitive poster-tag data for guarded items; shared by the tag-cache endpoints and Native Poster Tags so both hide the same things.
    * **`SpoilerAutoEnableFilter.cs`**: The shared auto-enable scope gate (content type + library allow-list) used by the first-play, Seerr-request and library-add modes.
    * **`SpoilerAutoEnableArmer.cs`**: The shared bulk-arming path (target users incl. disabled accounts, per-user library access, one locked `spoilerblur.json` write per user) used by the library-add batcher and the apply-to-existing-titles run.
    * **`SpoilerLibraryAddAutoEnabler.cs`**: Implements "Auto-enable when new titles are added to the library" — batches a scan's `ItemAdded` burst and arms every new Series/Movie for every user with access to its library, one file write per user.
    * **`SpoilerExistingTitlesApplier.cs`**: Applies the saved auto-enable scope to titles already in the library on demand (dry-run preview for the config page, skips titles a user already has or has fully watched). Run by `ScheduledTasks/SpoilerApplyExistingTitlesTask.cs` ("Spoiler Guard: apply to existing titles", no default triggers).
    * **`SpoilerSeerrPendingPromoter.cs`**: Promotes pending pre-acquisition entries (registered from the Seerr More Info modal or auto-enable on request) into real per-item protection when the content lands in the library.
    * **`SpoilerUserResolver.cs`**: Loads per-user Spoiler Guard state for the requesting user identified by `RequestIdentityService`.

* **`/Services/Secrets/`**: Credentials kept out of the plugin configuration.
    * **`SecretsStore.cs`**: The owner-only `secrets.json` sidecar holding every stored API key and secret, plus short-lived server-side handles for keys imported from Seerr.
    * **`SecretValue.cs`**: The placeholders the configuration, the dashboard and every response carry instead of a credential (mask, import handle, clear request).
    * **`SecretsMigration.cs`**: Moves plain-text credentials into the store at start-up (idempotent), merges dashboard saves (a placeholder or blank keeps the stored value) and writes them back for a downgrade. `Configuration/PluginConfigurationSecrets.cs` holds the accessors features use to read the real values.

* **`/Services/Arr/`**: Foundations of "Requests & downloads (new)".
    * **`ArrInstanceRegistry.cs`** / **`ArrConnection.cs`** / **`ArrRegistryMigration.cs`**: Instance registry v2 — typed, id-addressed Sonarr/Radarr instances (role, default, linked libraries, path mappings) over the existing `SonarrInstances` / `RadarrInstances` settings, with role-based default selection.
    * **`ArrClient.cs`** / **`ArrClientFactory.cs`** / **`ArrHttp.cs`**: One client per instance on a named HttpClient that never follows redirects and checks the address it connects to; per-call timeouts and size caps, typed `ArrError`s, GET backoff, paging, `appName` and version detection (`ArrSystemStatus.cs`).
    * **`ArrActionRunner.cs`** / **`ArrAuditLog.cs`** / **`ArrConfirmationTokens.cs`**: Direct arr writes with an idempotency key, read-back, an append-only `arr-audit.jsonl` and confirmation tokens for destructive actions.
    * **`ArrActivityMirror.cs`**: Copies each audited action into Jellyfin's activity log (phase 2).
    * **`ArrDiagnostics.cs`**: The connection check used by the admin test routes.
    * **`ArrStateStore.cs`** / **`ArrSnapshotSlot.cs`** / **`ArrStateLoaders.cs`** / **`ArrStateModels.cs`**: In-memory snapshots per instance (library index with provider ids and tags, the whole queue, a history ring kept current with `history/since`, a calendar window, system facts), refreshed in the background, single-flight, with failure backoff and a warm-start file for the library. The existing queue, history, calendar, link and tag-sync code reads from it, so serving a page makes no arr call. **`ArrStateReconciler.cs`** is the hosted loop that runs due refreshes; **`ArrCallAttribution.cs`** counts upstream calls per request; **`ArrLegacyViews.cs`** builds the existing routes' response shapes from the snapshots. **`ArrStateStore.Live.cs`** adds what live updates need: change notifications, in-place library patches, refreshes for live hints and single-title re-reads. **`ArrQueueStates.cs`** is the one precedence table for queue rows (status composer, Needs attention, the store's first-seen clocks); **`ArrIds.cs`** treats provider id 0 as missing.
    * **`/Live/`**: Live updates (phase 1). **`ArrSignalR.cs`** is the hand-rolled SignalR hub client (one connection per instance, backoff, pings) and **`ArrLiveService.cs`** the hosted service that runs them and turns messages into re-reads; **`ArrLiveRouter.cs`** coalesces those hints. **`ArrWebhookReceiver.cs`** checks webhook calls (per-instance secret, rate limits) and **`ArrWebhookProvisioner.cs`** sets the webhook up in the arr with consent. **`ArrChangeDetector.cs`** / **`ArrChangeTracker.cs`** turn snapshot changes and Jellyfin library adds/removes into title-key revisions in **`ArrChangeFeed.cs`**, which browsers long-poll; **`ArrFeedAudience.cs`** filters it per user; **`ArrTitleKey.cs`** defines the keys (`movie:tmdb:…`, `tv:tvdb:…[:s…[:e…]]`).

* **`/Services/Acquire/`**: The status composer behind "where has it got to" (Requests & downloads, phase 1). **`StatusComposer.cs`** derives stage, reason code and journey from the arr snapshots, Jellyfin and request facts; **`ArrStatusService.cs`** serves them per user from memory with a per-user body cache (**`ArrStatusCache.cs`**) keyed by the snapshots, the Jellyfin library and the change feed's per-title revisions; **`ArrJellyfinView.cs`** is the Jellyfin side (items, copies, episodes as each viewer may see them, and each movie's or episode's playable versions with their dimensions); **`EditionAvailability.cs`** the one answer to whether a viewer has the standard or the 4K edition of a scope (per version, across every copy they can open, or the copy a page is pinned to), used by request status, request fulfilment and Get 4K; **`TitleKey.cs`** the title keys shared with the change feed; **`TitleAliases.cs`** every key a title is known by (arr libraries, complete Seerr requests), so status, Calendar and audience copy lookups share its ids; **`EpisodeRange.cs`** the full inclusive range of a combined episode file, shared by status, notifications and privacy checks. **`SeerrRequestReadModel.cs`** reads Seerr's request list in the background (probe, paged full read, title details) and answers the composer's request facts, each user's requests and the feed announcements of changed requests; **`RequestsHubService.cs`** builds each user's Requests page from it; **`ArrManageService.cs`** the administrator's Manage drawer (overview from the snapshots, audit log and read model; Search now through the action runner). **`AcquireDatabase.cs`** is the SQLite database of Requests & downloads (`acquire.db`, the host's own Microsoft.Data.Sqlite, versioned migrations, one writer at a time, consistent copies for JE backups). Phase 2: **`ArrAdminHubService.cs`** builds the administrator's Overview/Activity/System tabs from memory, **`NeedsAttention.cs`** derives the Needs attention rows (and groups the queue into downloads), **`ArrQueueActionService.cs`** runs queue actions through the action runner (remove with data only with a confirmation token), **`JellyfinBridge.cs`** + **`BridgePaths.cs`** refresh the nearest Jellyfin folder after an arr import (never a TV library root), list imports Jellyfin doesn't have and run the path doctor, over **`JellyfinLibraryAccess.cs`** (the Jellyfin library seam); **`ArrInstanceLibraries.cs`** resolves which Jellyfin library an instance's title folder lands in (mapped title folder constrained to linked libraries, else linked libraries, else unresolved; shared by status, follows, the feed, Calendar and the path doctor); **`ArrAdminOpsFeed.cs`** announces the administrators' change-feed key the admin tabs follow. In **`/Helpers/`**, **`ArrCaller.cs`** decides who counts as a person on these routes (never an API key, the empty user id or an unknown user), **`BodyLimitAttribute.cs`** caps request bodies before model binding with a structured 413, **`PrivateResponseAttribute.cs`** marks administrators' answers `private, no-store`, and **`SeerrAskedProofCache.cs`** holds each user's Seerr requests for the legacy queue and history (read only when a row needs them, shared, never waited on for long).
* **`/Services/Acquire/Notify/`**: Notifications (Requests & downloads, phase 2). **`NotificationService.cs`** turns change-feed, Seerr and Jellyfin library changes (and the Jellyfin bridge's indexed imports) into notifications per user (first looks, ready transitions, episode batches, declines, Remind, and admin events from the admin tools' Needs attention list); **`NotifyStore.cs`** keeps follows, settings, watch state, the inbox and deliveries in `acquire.db`; **`NotifyDispatcher.cs`** delivers to ntfy and e-mail with retries and quiet hours; **`NotifyChannels.cs`** holds the ntfy and SMTP senders and the endpoint checks; **`NotifyTexts.cs`** the phone/e-mail texts. Routes in **`Controllers/NotifyController.cs`**; the browser side in **`js/arr/notify/`** (bell and inbox, toasts, Notify me / Remind buttons, the "Requests & alerts" settings).
* **`/Services/NativeDetails/`** (Jellyfin 12 build only): The native details facade for titles that aren't in the library. **`SyntheticId.cs`** (both builds) is the page id codec; **`NativeDetailsFacadeFilter.cs`** answers jellyfin-web's details requests for those ids from **`NativeDetailsAllowlist.cs`** (everything else naming one is refused) with **`NativeDetailsDtos.cs`**, under **`NativeDetailsPolicy.cs`** (who may open a page; session epochs end artwork grants on sign-out), from **`NativeDetailsSource.cs`** (Seerr/TMDB, shared public metadata) and **`NativeDetailsArtwork.cs`** (signed artwork grants, key kept in the plugin data folder, per-viewer upstream budget from **`ViewerBudget.cs`**, which also limits the feed reads). **`NativeDetailsLinks.cs`** decides where the page's names lead for the viewer (a library person, genre or studio they can open, else the person's own page or the genre/studio/network discovery page; read only). **`NativeDetailsFeeds.cs`** serves those pages' title lists (a person's filmography, the genre/studio/network discovery feeds) through **`Controllers/NativeDetailsFeedsController.cs`**, read with JE's own Seerr key (new reads limited per viewer and queued server-wide in `NativeDetailsSource.cs`, with **`FeedScheduler.cs`** capping each viewer's share of the queue and handing upstream slots to waiting viewers in turn, 429 past that) and filtered for the viewer on the server (parental limit, then any library copy they can open, a title whose copies are all hidden from them left out, an absent title only when its page would open). **`NativeDetailsPages.cs`** turns a page id into the absent-title page (`Services/Acquire/AbsentTitle.cs`, both builds) that the status and season-row routes compose by key; **`Controllers/NativeDetailsController.cs`** is `native-details/resolve`, the navigator's "where does this title open" (a copy the caller can open first).
* **`/Services/Acquire/Requests/SeasonRowsService.cs`**: One season's request rows for the season page (`GET acquire/requests/season/{itemId}`): the caller's request state per episode (their own first, other people only as "household") and the TMDB title, air date, runtime, overview and still path of the episodes Jellyfin has no file for (shared TMDB cache, server key); episodes hidden from the caller are left out.
* **`/Services/Acquire/Requests/` (phase 3c household and discovery)**: `RequestHubProjection.cs` (approval cards, the caller's own requests and the Manager chip-bar counts, with display data from `HouseholdDirectory.cs`: people, library access, title name/year/rating; where a request would land and a 4K copy already here from `RequestPlaces.cs`, memory only), `HouseholdService.cs` (the Household tab: read for Managers and Admins, save of roles, quotas and the preset for Jellyfin administrators) and `DiscoverService.cs` (JE-mode Discover rows and search from TMDB, filtered per caller for parental limits, library access and Hidden Content). Routes: `Controllers/AcquireHouseholdController.cs`, `AcquireDiscoverController.cs` and `AcquireCollectionsController.cs`.
* **`/Services/Acquire/Requests/CollectionGapsService.cs`**: What a person has of a Jellyfin collection and which movies are missing, from the collection's TMDB entry (shared TMDB cache, server key); movies Jellyfin hides from the person are left out and missing ones pass the parental check for titles not in Jellyfin. Served by **`Controllers/AcquireCollectionsController.cs`** (`GET acquire/requests/collection/{itemId}`).

* **`/Services/Backup/JeBackupService.cs`**: Export (zip with manifest and checksums; credentials left out or AES-GCM encrypted with a passphrase), scheduled copies with rotation (`ScheduledTasks/JeBackupTask.cs`, "Back up Jellyfin Enhanced data", no default triggers) and verified restore with a safety copy (`JellyfinEnhanced.RestoreConfiguration` applies the configuration).

* **`/Services/ClientScriptBundle.cs`**: Builds and caches the component bundle (`/JellyfinEnhanced/bundle.js`) and its index source map from the embedded `js/component-scripts.json` manifest; also the source of the ordered list returned by `/bootstrap`.

* **`/Services/MovieCollectionsBatch.cs`**: Id parsing and lookup scheduling for `GET /JellyfinEnhanced/jellyseerr/movie-collections`, the Seerr search row's one-request collection lookup for a batch of movies (Seerr's movie detail first, TMDB when Seerr names no collection).

* **`/Services/PosterTags/`**: Native Poster Tags (experimental) — draws each user's poster tags into Primary images for native apps that don't run the web overlays. Off unless `NativePosterTagsEnabled` is set.
    * **`PosterTagModel.cs`**: The semantic layout passed from resolution to rendering — tag groups, their corners and stack order, and the tags themselves. Visual details belong to the renderer.
    * **`PosterTagSettings.cs`** / **`PosterTagSettingsProvider.cs`**: A user's effective tag settings, merged from their `settings.json` and the admin defaults exactly as `enhanced/config.js` does, with a digest of every rendering-relevant value; the provider caches them per user and invalidates on save and config changes.
    * **`PosterTagResolver.cs`** + **`/Resolution/`**: Turns a `TagCacheEntry` into a layout, porting the web renderers' rules (quality detection and category order, genre icons, language flags, rating and user-review gating, age-rating colours).
    * **`/Rendering/`**: `PosterTagRenderer.cs` draws a layout onto the poster with SkiaSharp (HarfBuzz shaping, the web's sizes and colours); `PosterTagAssets.cs` loads the embedded `Assets/PosterTags/` resources once.
    * **`NativeClientPolicy.cs`**: Skips clients that run the web overlays themselves (built-in list plus `NativePosterTagsWebClientNames`).
    * **`PosterTagVariantToken.cs`**: Mints and verifies the signed `-jet` suffix stamped onto image tags (by `SpoilerGuard/SpoilerIdentityTagFilter.cs`), so a poster URL changes whenever its drawn content would.
    * **`PosterTagDataProvider.cs`**: Fetches the item's tag data (server tag cache or on-demand), checks the user can see the item, and applies Spoiler Guard stripping via `SpoilerGuard/SpoilerTagDataStripper.cs`.
    * **`PosterTagImageFilter.cs`**: The image action filter that composites the tags; registered before `SpoilerBlurImageFilter`, so it runs after the blur. Any failure serves the original image.
    * **`CompositeImageCache.cs`**: Byte-bounded memory LRU plus a disk cache under Jellyfin's cache path, with in-flight coalescing and bounded render concurrency.

* **`/Services/Identity/`**: Shared request identity helpers.
    * **`RequestIdentityService.cs`**: Resolves the current request identity using authenticated claims first, then image identity markers, single-user installs, cookies, and shared-IP session candidates.

* **`/EventHandlers/`** (Spoiler Guard):
    * **`SpoilerAutoEnableEvents.cs`**: Implements "Auto-enable on first play of a new show" — adds a series to the user's Spoiler Guard list on a fresh S1E1 play.
    * **`UserTopologyEvents.cs`**: Invalidates single-user and marker lookup caches when users are created or deleted.

* **Maintenance Mode** (server side):
    * **`/Services/MaintenanceModeService.cs`**: Owns the maintenance state file (who was disabled, end time, source), applies/restores user policies, resolves the `{countdown}` / `{ends_at}` tokens and sends the session popups.
    * **`/Services/MaintenanceScheduleService.cs`**: 30-second hosted timer that opens/closes the daily scheduled window and expires timed windows.
    * **`/EventHandlers/MaintenancePlaybackReminder.cs`**: Re-sends the notification to affected users on playback start while maintenance is active (throttled per session).

* **`/Model/`** (Spoiler Guard):
    * **`TagCacheEntry.cs`**: Pre-computed per-item tag data served to clients in bulk; carries the parent-series ID so the Spoiler Guard filter can strip cache entries for unwatched episodes without per-request library lookups.

* **Audio Language Tags**:
    * **`/Helpers/AudioLanguageTagHelper.cs`**: Maps stream language codes to tag names (base and regional) and computes the tag changes for an item.
    * **`/ScheduledTasks/AudioLanguageTagsSyncTask.cs`**: "Sync Audio Language Tags to Jellyfin" (no default triggers). Writes the tags for every movie and series.
    * **`/Services/TagCacheService.cs`**: Applies the same tags to a movie or series when its cache entry is rebuilt after a library event.

* **`/Services/Acquire/Automation/`**: The phase-4 automation engine (Requests & downloads). `AutomationFlags.cs` is the
  switch hierarchy and each recipe's mode as it applies (with the rollout Shadow guard), `AutomationModes.cs` the recipes
  and their stored modes and kill switches, `AutomationDecision.cs` the no-write decision seam (a rolled-back ledger
  preview) and who is eligible to go ahead without an OK, `AutomationBudgets.cs` durable atomic budget admission in
  acquire.db (rolling UTC windows, unique actions, uncertain sends counted until read back, fail closed),
  `AutomationAdmission.cs` the send guard for queued automatic work (per-write budget admission, breaker counting),
  `AutomationWriteGate.cs` the one write gate every automatic outbound write passes immediately before it leaves (Direct
  and Seerr backends, the old recipes' direct Seerr POST: every switch, kill, mode, consent, eligibility, breaker, disk
  and budget gate; facts first, then one decision: every storage read is made before the live settings are read and
  judged, and facts that may have gone stale meanwhile are read again, checked by version stamps),
  `AutomationFacts.cs` the one registry of every fact that check reads (read in its decision from memory, or gathered
  with a version every change moves before it can be seen), the Jellyfin user permission versions and the filter that
  brackets Jellyfin's own user actions (a test walks the check against the registry, another scans every writer for its
  bracket; `Helpers/FactVersion.cs` is that version, a seqlock: every change runs inside its bracket, odd before it can
  be seen and even after, also when it throws),
  `AutomationTransportHandler.cs` the guarantee behind it: the HTTP handler on the arr, Seerr
  and default clients that checks every write made in an automation context (an `AsyncLocal` the outbox and the old
  recipes set) synchronously as it is handed on, the job's budget reservations among the gate's facts and judged with
  their live limits in the same decision; the write sites'
  own calls and the test `tests/backend/Integrations/WriteGateWalk.cs` (a walk of the code from each gate to its HTTP
  send, and in a strict mode from the final decision to the hand-off) stay as defence in depth, `AutomationRecordSnapshot.cs` every live setting a recorded automatic intent depends on
  (compared as a whole before the ledger write and before a Shadow decision is saved), `AutomationStore.cs` decisions, recorded grants, breakers and the
  migration record, `AutomationMigration.cs` the one-time start-up migration, `AutomationConsents.cs` each person's
  recipe preference, `AutomationRisk.cs` which risk classes may ever be automatic, and `AutomationStatus.cs` the
  administrators' status and the request backend's admission contract. Routes in **`Controllers/ArrAdminAutomationController.cs`**;
  the Requests page card in **`js/arr/admin/admin-automation.js`**.

* **`/Services/Acquire/Requests/` (phase 4b household rules)**: `HouseholdFlags.cs` the switches as every route and
  worker reads them; `HouseholdRules.cs` the fixed conditions per role (rating, genre, original language, size estimate,
  streaming service), their validation and the verdict with its precedence (deny, look, approve, preset); `RuleFacts.cs`
  the title facts they read from TMDB through the shared cache (bounded memory cache, failed reads retried soon);
  `GroupQuotaPolicy.cs` group pools and who draws on which; `HouseholdTrust.cs` the Trusted role behind the automation
  engine's trust seam; `HouseholdRulesService.cs` the administrators' rules editor (and Seerr's own rules, read-only, in
  Seerr mode). The ledger keeps each want's verdict (schema 4 `rule_detail`) and binds each reservation to its pool
  (`pool_id`); `RequestLedger.PreviewBatch` previews a run of asks in one rolled-back transaction. Routes in
  **`Controllers/AcquireRulesController.cs`** (rules editor, streaming services, batch preview).

* **`/Services/Acquire/Lists/`**: Phase-4 lists (playlist and collection entries for titles not in the library).
  `ListStore.cs` keeps one document per list in `lists/` (atomic writes, per-list locks, a reverse index by title ids);
  `ListOrder.cs` the pure order algebra (real-entry tokens, projections, Jellyfin's move coordinates); `ListRules.cs`
  entry validation, identity, edition and the request a list ask makes; `ListHost.cs` the Jellyfin seam (lists, shares,
  inserts and moves on 12 and 10.11); `ListAccess.cs` who may see and edit a list and the parental filter of entries; `ListGate.cs` the one list access
  gate, read right before every Jellyfin write (its single-use `ListWrite` grant) and every answer with list contents
  (with the person's policy revision, which statuses are bound to);
  `ListResolver.cs` which library items stand for an entry (and fill progress); `ListPlaylistPlacement.cs` putting new
  items at their spot; `ListService.cs` views and every change (durable operations); `ListAcquisition.cs` Request one /
  Request all missing through the request service; `ListSwapService.cs`/`ListSwapMonitor.cs` swap-in on arrivals
  (consent-gated, intents settled by Jellyfin's real membership); `ListLifecycle.cs` deleted lists, restores and
  deleted people; `ListDatabase.cs` operations, request links and swap-in events in acquire.db (schema 5);
  `ListStatusSource.cs` the shared status for entries; `ListMetadata.cs` the metadata source behind
  `IListMetadataSource`; `ListSourceOwnership.cs` linked-source ownership on swap-in; `ExperimentalListImporter.cs` the
  one-time importer of the experimental lists; `ListFlags.cs` the switches and per-person preferences. Routes in
  **`Controllers/AcquireListsController.cs`**, models in **`Model/ListPlaceholders/`**, the daily task in
  **`ScheduledTasks/ListMaintenanceTask.cs`** and the client transport in **`js/arr/lists/list-api.js`** (`JE.arrLists`).

* **`/Services/Acquire/Stamps/`**: Phase-4 acquisition badges (New for you, Upgraded, 4K). `AcquisitionStamp.cs` holds
  the fixed stamp values, the switches and lifetimes (`AcquisitionStampFlags`), the 4K copy rule and the seams;
  `AcquisitionStampStore.cs` the facts in acquire.db (schema 7: a person's first arrivals, confirmed upgrades, judged
  arrivals and first arrival per part) with an in-memory index; `AcquisitionStampFeeder.cs` the background writer
  (library arrivals, the arrs' history in memory, catch-up and housekeeping); `AcquisitionStampResolver.cs` the pure
  in-memory decision per viewer and item that web cards and native posters share; `AcquisitionStampSources.cs` the
  Jellyfin, request/follow and arr-history adapters, the per-person preference reader and the deleted-user purge.
  Route in **`Controllers/AcquisitionStampsController.cs`** (`GET acquire/stamps`); native posters draw the stamp through
  `Services/PosterTags/` (an `Acquisition` group, pinned in the poster's data hash); the web badge is built by
  `JE.arrStatus.buildBadge` in **`js/arr/status/`**.
* **`/Services/Acquire/Ready/`**: Phase-4f private Ready playlist and native Ready messages. `ReadyModels.cs` holds the
  switches (`ReadyFlags`), states and records; `ReadyTables.cs` acquire.db step 8 (one table constant for the migration
  and the start-up ensure, with the restore-renewal policy); `ReadyPlaylistStore.cs` the bindings (server, owner,
  playlist id, create marker, epoch), the membership journal, the entries per interest and the native-message attempts;
  `ReadyInterests.cs` a person's own requests (from the request authority) and follows; `ReadyCopySelector.cs` the
  selection through `EditionAvailability` and the final exact-version checks; `ReadyPlaylistHost.cs` the Jellyfin
  playlist seam; `ReadyPlaylistService.cs` the per-person reconciliation (create by marker, journalled and read-back
  changes, deletion tombstones, privacy stops) and its bounded event queue; `ReadyJellyfin.cs` the library, watched,
  Hidden Content adapters and the event listeners; `ReadySessionMessages.cs` the session snapshots, the idle classifier
  and the DisplayMessage send; `ReadyNativeChannel.cs` the DisplayMessage channel the notification dispatcher calls.
  Routes in **`Controllers/AcquireReadyController.cs`** (`GET`/`PUT acquire/ready`, `POST acquire/ready/remove`); the
  panel section in **`js/arr/ready/ready-settings.js`**.

* **`/Services/Acquire/Requests/`**: Durable request server core. `RequestModels.cs` contains normalized scopes, outcomes
  and the pure quota projector; `RequestPolicy.cs` resolves server-owned roles, quotas and visibility; `RequestLedger.cs`
  commits intent, reservations, approvals, events and outbox jobs in acquire.db (schema 3 adds each want's server-built
  origin and provenance and its operation); `RequestOperations.cs` keeps durable batch/confirmation operations and derives
  each title's request id from the operation (a retry or restart reuses it, a new confirmation gets new ones). `RequestService.cs` orchestrates
  policy preparation and private list projections. `RequestOutbox.cs` provides local title locks, restart recovery,
  final-send authorization and a network-free fallback transport. `RequestBackends.cs` sends each job through the
  backend it was authorised for: `DirectArrBackend.cs` (Jellyfin Enhanced mode: Sonarr/Radarr adds and field-scoped
  monitoring, confirmed by a fresh read) or `SeerrBackend.cs` (Seerr mode, as the person who asked); `ArrAddService.cs`
  is the administrators' Manage › Add to. `LedgerRequestFacts.cs` selects ledger facts in JE
  mode and the existing Seerr read model otherwise (including when requests went out, which restarts the "still looking"
  clock), and builds the part of a title one person's requests ask for (seasons, single episodes, edition) for the
  Requests page, the household list, approval cards and notifications. `RequestSearchService.cs` runs the arr's search
  again for what requests already sent (family Search). `RequestLedgerArrivals.cs` (part of the ledger) marks requests
  fulfilled and reads the requester notices the ledger writes (delivered as OK'd / declined alerts by
  `Notify/NotificationService.cs`); `RequestFulfilment.cs` notices when what a request asks for is in Jellyfin and
  marks it fulfilled (Ready, never stale).
  `FutureSeasonCharges.cs` charges the owner of a "Keep getting new episodes" request once per new season a Sonarr
  library read shows started; in Seerr mode it also asks Seerr for each new started season every few hours (Seerr
  doesn't follow new seasons itself). `RequestDestination.cs` is the one rule for where a request goes (its target, and
  an administrator's Seerr server, profile, root folder and options stamp): every ledger and charges path where one
  request covers, dedups, follows or stands for another asks it, and so does every approval that re-confirms or edits
  one (a fresh stamp re-confirms only on the request's own Seerr; what went out never moves).
  `AcquireRequestsController.cs` exposes the authenticated server API.
  In Seerr mode `SeerrBackend.cs` also reads Seerr's Radarr/Sonarr servers (profiles, root folders, the options stamp)
  for administrator Seerr request options, checks a chosen server, profile and folder again right before the POST and
  sends them with it; **`Controllers/AcquireSeerrOptionsController.cs`** lists those options to administrators.
  `SeerrMigrationReader.cs` reads every Seerr request complete-or-nothing (with a digest and Seerr's requesting state) and
  `SeerrMigration.cs` runs the admin dry run, the import into `RequestLedgerImport.cs` (import batches, rollback by batch,
  the automation log) and the switch to JE request handling; `AcquireMigrationController.cs` exposes it to administrators.
  `SharedRequestFacts.cs` answers "who asked" for the watchlist features with a completeness flag, and
  `RequestOutboxEvents.cs` tells the Seerr scan nudge about confirmed adds.
* **`/Services/AutoRequest/`**: The auto season / auto movie hand-off. `PlaybackTriggerChannel.cs` is the bounded,
  coalescing queue the playback handlers write to in constant time; `PlaybackTriggerGate.cs` is the single-flight gate
  (cooldown only after a definitive outcome, short backoff after a failed lookup); `AutoRequestOutcome.cs` holds the
  typed outcomes; `AutoRequestRecorder.cs` records a recipe's decision as a request-ledger want while phase 3 is on.
* **`/Services/Arr/CalendarDedup.cs`**: Merges calendar events several instances report for the same release; "also in"
  names only instances whose event the caller may see.
* **`/Helpers/Jellyseerr/SeerrDownloadStatusProjector.cs`**: Strips release names, download ids and arr ids from the
  download rows in Seerr answers for anyone who isn't an administrator.
* **`/Helpers/Jellyseerr/SeerrLibraryAccessProjector.cs`**: Keeps Seerr's links to Jellyfin items to what the caller
  can open: hidden copies are unlinked, another copy the caller can open takes their place, and list rows of titles the
  library hides from the caller are left out.

### Native Dashboard user settings

- `Controllers/AcquireAdminUsersController.cs`: D19 human-administrator routes, private responses and partial group edits.
- `Services/Acquire/Users/AdminUserSettingsService.cs`: adapters over existing request policy, quota projection, pools, personal JSON, notification state, automation grants and list attribution; source revisions and audited writes.
- `js/arr/adminusers/admin-users-api.js`: independent private reads and narrow PATCH/ntfy transport.
- `js/arr/adminusers/admin-users.js`: both native Users route families, React-safe sibling mounting, retained drafts and batched card decoration.
- `tests/backend/Users/AdminUserSettingsTests.cs` and `tests/frontend/features/features-arr-admin-users.test.mjs`: administrator boundaries, inheritance/conflicts/unavailability/consent preservation and native-route lifecycle coverage.
- `Configuration/UserSettingsDefaults.cs`: one in-memory default mapping shared by first access, first administrator display write and reset, keeping unrelated preferences consistent without recording personal consent.
