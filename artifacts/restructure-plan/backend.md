# JE v12 backend restructure plan (by feature)

Status: PLAN ONLY. Generated 2026-11-08 from the working tree at HEAD `2e0f9251` plus ~656 uncommitted rewrite changes (`git status --short | wc -l`). Nothing in the tree was edited.
Evidence came from `grep`/`awk` over `Jellyfin.Plugin.JellyfinEnhanced/**`. Anything marked **(unverified)** is inference.

Rule for every step: **the rewrite's uncommitted changes must be committed (or stashed into a branch) by the owner before step 0 starts.** Worktrees branch from a commit, so this plan can't run on top of a dirty tree.

---

## 1. Endpoint inventory, grouped by proposed feature

Sources:
- `Controllers/JellyfinEnhancedController.cs`: 13,988 lines, class-level `[Route("JellyfinEnhanced")] [ApiController]`, **199 routes** on 198 action methods. `ActOnRequest` (L12702) has two `[HttpPost]` attributes: `arr/requests/{requestId}/approve` and `.../decline`.
- `Controllers/CatchUpController.cs`: 144 lines, `[Route("JellyfinEnhanced/catchup")]`, 3 routes, all `[Authorize]`. It is already split, so it only needs to move to `Features/Catchup/`.

Feature names match `client/src/features/<folder>` (PascalCase). Three groups have no folder under `features/`: **Admin** maps to `client/src/admin`, **Platform** maps to `client/src/{bootstrap,host,core,shared}`, and **Catchup** maps to `features/catchup`.

### Counts (JellyfinEnhancedController only)

| Feature (backend) | Client folder | Routes | ≈Lines in controller* | Routes whose body calls `IsAdminUser()` |
|---|---|---:|---:|---:|
| Seerr | features/seerr | 63 | 2552 | 10 |
| DetailsProviders | features/details-providers | 28 | 1578 | 10 |
| SpoilerGuard | features/spoiler-guard | 19 | 1398 | 5 |
| Platform | bootstrap, host, core, shared | 18 | 1429 | 3 |
| MediaTags | features/media-tags | 13 | 1374 | 1 |
| Admin | admin | 12 | 249 | 11 |
| HiddenContent | features/hidden-content | 10 | 705 | 4 |
| Settings | features/settings, settings-panel | 8 | 657 | 3 |
| MediaTags (admin routes; was AdminTags) | features/media-tags/admin | 7 | 161 | 6 |
| Bookmarks | features/bookmarks | 6 | 174 | 0 |
| Chrome | features/chrome | 6 | 505 | 4 |
| Downloads | features/downloads | 5 (4 methods) | 993 | 2 |
| Calendar | features/calendar | 3 | 932 | 0 |
| Activity | features/activity | 1 | 28 | 1 |
| Catchup (CatchUpController) | features/catchup | 3 | 144 (file) | 0 |

\* "≈Lines" adds up the distance from each route attribute to the next one, sorted by line. It includes private helpers and DTOs between endpoints, so it only approximates how big each feature's extraction is. The shared helper block (L5443–5510 auth helpers, L11570 `GetCurrentUserId`) is counted under whichever feature comes before it.
"Calls `IsAdminUser()`" is a heuristic: the call appears within 40 lines of the attribute. Some of these are **data-shaping** (e.g. `arr/links` and `reviews/*` add admin-only fields), not 403 gates. The reflection gate in §3 records behaviour per route. Do not treat this column as the auth contract.

### Anonymous routes (no `[Authorize]`; 12 total; must stay anonymous)
`script`, `js/{**path}`, `Configuration/jeAdmin.css`, `Configuration/jeAdmin.js`, `version`, `public-config`, `bundle.js`, `bundle.js.map`, `logo/{size}/{file}`, `cdn/{source}/{**path}`, `fonts/{name}`, `locales/{lang}.json`.
`[AllowAnonymous]` is never used as an attribute. These routes are anonymous only because they *lack* `[Authorize]` (comments at L3739/L3821 say "[AllowAnonymous]" but there is no attribute). **Risk:** a new feature base class carrying `[Authorize]` would silently lock these routes. See §3.
`tests/backend/Api/ApiRoutingTests.cs` already has `PublicAssetsRouteAndExecuteWithoutAuthentication` and `PrivateRoutesChallengeBeforeControllerUsesHostServices` theories. Keep both, and extend them with the snapshot gate.

Note: `items/by-providers`, `MaintenanceMode/*` and `{viewName}` put `[Authorize]` **before** `[Http*]`, so a naive grep for the attribute after the verb misses them. The snapshot test must use reflection, not regex.

### Full route list by feature
Columns: controller line · verb · route (relative to `JellyfinEnhanced/`) · auth attr · action method · body calls IsAdminUser() · ambiguity note.

#### Activity

| L | Verb | Route | Auth | Method | Admin? | Note |
|---|---|---|---|---|---|---|
| 9716 | GET | `activity` | Authorize | `GetActivityFeed` | yes |  |

#### Admin

| L | Verb | Route | Auth | Method | Admin? | Note |
|---|---|---|---|---|---|---|
| 1858 | GET | `host-compat` | Authorize | `GetHostCompatibility` | yes |  |
| 1889 | GET | `jellyfin-urls` | Authorize | `GetJellyfinNetworkUrls` | yes |  |
| 9357 | POST | `admin/configuration` | Authorize | `PatchConfiguration` | yes |  |
| 9744 | GET | `whats-new` | Authorize | `GetWhatsNew` | yes | whats-new UI lives in client/src/admin |
| 9765 | POST | `whats-new/dismiss` | Authorize | `DismissWhatsNew` | yes | whats-new UI lives in client/src/admin |
| 10808 | GET | `arr/validate/sonarr` | Authorize | `ValidateSonarr` |  | admin config-page validators |
| 10815 | GET | `arr/validate/radarr` | Authorize | `ValidateRadarr` | yes | admin config-page validators |
| 13828 | GET | `MaintenanceMode/Status` | Authorize | `GetMaintenanceStatus` | yes |  |
| 13852 | POST | `MaintenanceMode/Enable` | Authorize | `EnableMaintenanceMode` | yes |  |
| 13874 | POST | `MaintenanceMode/Disable` | Authorize | `DisableMaintenanceMode` | yes |  |
| 13883 | GET | `MaintenanceMode/Users` | Authorize | `GetMaintenanceModeUsers` | yes |  |
| 13897 | POST | `MaintenanceMode/Broadcast` | Authorize | `BroadcastMaintenanceMessage` | yes |  |

#### MediaTags: admin routes (formerly "AdminTags")
These move with MediaTags in **S2.11** into the partial `Features/MediaTags/JeMediaTagsController.Admin.cs` (§7.5 allows partials). There is **no `Features/AdminTags`**: the client folds `features/admin-tags` into `features/media-tags/admin` (frontend A3), and the canonical map in `PLAN.md` / `docs/feature-map.json` has no AdminTags row.


| L | Verb | Route | Auth | Method | Admin? | Note |
|---|---|---|---|---|---|---|
| 1323 | GET | `tag-styles/catalog` | Authorize | `GetTagStyleCatalog` |  |  |
| 9272 | POST | `tag-cache/rebuild` | Authorize | `RebuildTagCache` | yes |  |
| 9296 | GET | `tag-cache/summary` | Authorize | `GetTagCacheSummary` | yes |  |
| 9319 | GET | `admin/leaving-soon` | Authorize | `GetLeavingSoonStatus` | yes |  |
| 9332 | POST | `admin/leaving-soon/refresh` | Authorize | `RefreshLeavingSoon` | yes |  |
| 9380 | GET | `admin/media-tags/export` | Authorize | `ExportAdminMediaTags` | yes |  |
| 9399 | POST | `admin/media-tags/preview` | Authorize | `PreviewAdminMediaTags` | yes |  |

#### Bookmarks

| L | Verb | Route | Auth | Method | Admin? | Note |
|---|---|---|---|---|---|---|
| 6067 | GET | `user-settings/{userId}/bookmark-document` | Authorize | `GetBookmarkDocument` |  |  |
| 6079 | POST | `user-settings/{userId}/bookmark-document` | Authorize | `MutateBookmarkDocument` |  |  |
| 6097 | GET | `user-settings/{userId}/bookmark.json` | Authorize | `GetUserBookmark` |  |  |
| 6113 | POST | `user-settings/{userId}/bookmark.json` | Authorize | `SaveUserBookmark` |  |  |
| 6151 | POST | `user-settings/{userId}/bookmark.json/add` | Authorize | `AddUserBookmark` |  |  |
| 6201 | DELETE | `user-settings/{userId}/bookmark.json/{bookmarkId}` | Authorize | `RemoveUserBookmark` |  |  |

#### Calendar

| L | Verb | Route | Auth | Method | Admin? | Note |
|---|---|---|---|---|---|---|
| 12752 | GET | `arr/calendar` | Authorize | `GetCalendarEvents` |  |  |
| 13344 | POST | `arr/calendar/user-data` | Authorize | `GetCalendarUserDataForEvents` |  |  |
| 13801 | GET | `items/by-providers` | Authorize | `GetItemIdByProviders` |  | generic tmdb/imdb->item lookup; only caller calendar |

#### Chrome

| L | Verb | Route | Auth | Method | Admin? | Note |
|---|---|---|---|---|---|---|
| 10653 | POST | `UploadBrandingImage` | Authorize | `UploadBrandingImage` | yes | admin uploads; chrome login-image/splashscreen consume |
| 10720 | GET | `BrandingStatus` | Authorize | `GetBrandingStatus` |  | admin uploads; chrome login-image/splashscreen consume |
| 10735 | GET | `BrandingImage` | Authorize | `GetBrandingImage` |  | admin uploads; chrome login-image/splashscreen consume |
| 10761 | POST | `DeleteBrandingImage` | Authorize | `DeleteBrandingImage` | yes | admin uploads; chrome login-image/splashscreen consume |
| 11409 | GET | `active-streams/sessions` | Authorize | `GetActiveSessions` | yes |  |
| 11505 | POST | `active-streams/broadcast` | Authorize | `BroadcastMessage` | yes |  |

#### DetailsProviders

| L | Verb | Route | Auth | Method | Admin? | Note |
|---|---|---|---|---|---|---|
| 4899 | GET | `anilist/reviews` | Authorize | `GetAnilistReviews` |  |  |
| 4928 | GET | `translate/languages` | Authorize | `GetTranslationLanguages` |  | translate used by reviews; translate/languages by admin |
| 4956 | POST | `translate` | Authorize | `TranslateReview` |  | translate used by reviews; translate/languages by admin |
| 5022 | GET | `awards/{mediaType}/{tmdbId}` | Authorize | `GetAwards` |  |  |
| 5064 | GET | `mdblist-ratings/{mediaType}/{tmdbId}` | Authorize | `GetMdblistRatings` |  |  |
| 5118 | GET | `ddd/{mediaType}/{tmdbId}` | Authorize | `GetDoesTheDogDie` |  |  |
| 5144 | GET | `ddd/usage` | Authorize | `GetDoesTheDogDieUsage` | yes |  |
| 5173 | GET | `ddd/topics` | Authorize | `GetDoesTheDogDieTopics` |  |  |
| 5197 | GET | `user-settings/{userId}/ddd-triggers.json` | Authorize | `GetUserSettingsDdd` |  | per-user settings document under user-settings/; could live in Settings |
| 5208 | POST | `user-settings/{userId}/ddd-triggers.json` | Authorize | `SaveUserSettingsDdd` |  | per-user settings document under user-settings/; could live in Settings |
| 5239 | GET | `mdblist-ratings/account-status` | Authorize | `GetMdblistAccountStatus` | yes |  |
| 5791 | GET | `user-settings/{userId}/elsewhere.json` | Authorize | `GetUserSettingsElsewhere` |  | per-user settings document under user-settings/; could live in Settings |
| 6241 | POST | `user-settings/{userId}/elsewhere.json` | Authorize | `SaveUserSettingsElsewhere` |  | per-user settings document under user-settings/; could live in Settings |
| 8378 | GET | `reviews/{mediaType}/{tmdbId}` | Authorize | `GetItemReviews` |  |  |
| 8448 | GET | `reviews/ratings` | Authorize | `GetReviewRatings` |  | caller is media-tags (review score chips) |
| 8555 | POST | `reviews/{mediaType}/{tmdbId}` | Authorize | `UpsertReview` |  |  |
| 8600 | POST | `reviews/admin/{userIdN}/{mediaType}/{tmdbId}` | Authorize | `AdminUpsertReview` | yes |  |
| 8647 | DELETE | `reviews/{mediaType}/{tmdbId}` | Authorize | `DeleteReview` |  |  |
| 8771 | GET | `reviews/admin/all` | Authorize | `AdminListReviews` | yes |  |
| 8874 | DELETE | `reviews/admin/{userIdN}/{mediaType}/{tmdbId}` | Authorize | `AdminDeleteReview` | yes |  |
| 10422 | GET | `item-stats/{userId}/{itemId}` | Authorize | `GetItemStatsByItemId` |  |  |
| 10548 | GET | `file-size/{userId}/{itemId}` | Authorize | `GetFileSizeByItemId` |  |  |
| 10569 | GET | `watch-progress/{userId}/{itemId}` | Authorize | `GetWatchProgressByItemId` |  |  |
| 10861 | GET | `arr/identify-url` | Authorize | `IdentifyUrl` | yes |  |
| 10982 | GET | `arr/series-slug` | Authorize | `GetSeriesSlug` | yes |  |
| 11019 | GET | `arr/series-slugs` | Authorize | `GetSeriesSlugs` | yes |  |
| 11104 | GET | `arr/links` | Authorize | `GetArrLinks` | yes |  |
| 11357 | GET | `arr/movie-instances` | Authorize | `GetMovieInstances` | yes | also called by downloads |

#### Downloads

| L | Verb | Route | Auth | Method | Admin? | Note |
|---|---|---|---|---|---|---|
| 11759 | GET | `arr/queue` | Authorize | `GetDownloadQueue` |  |  |
| 12046 | GET | `arr/history` | Authorize | `GetDownloadHistory` | yes |  |
| 12249 | GET | `arr/requests` | Authorize | `GetRequests` |  |  |
| 12702 | POST | `arr/requests/{requestId}/decline` | Authorize | `ActOnRequest` | yes |  |

#### HiddenContent

| L | Verb | Route | Auth | Method | Admin? | Note |
|---|---|---|---|---|---|---|
| 6275 | GET | `user-settings/{userId}/hidden-content.json` | Authorize | `GetUserHiddenContent` |  |  |
| 6346 | POST | `user-settings/{userId}/hidden-content.json` | Authorize | `SaveUserHiddenContent` |  |  |
| 6544 | GET | `admin/hidden-content-users` | Authorize | `GetHiddenContentUsers` | yes |  |
| 6608 | GET | `admin/hidden-content/{userId}` | Authorize | `GetUserHiddenContentForAdmin` | yes |  |
| 6653 | POST | `admin/hidden-content/{userId}/unhide` | Authorize | `AdminUnhideForUser` | yes |  |
| 6724 | POST | `admin/hidden-content/{userId}/hide` | Authorize | `AdminHideForUser` | yes |  |
| 8074 | POST | `continue-watching/hide/{itemId}` | Authorize | `HideFromContinueWatching` |  |  |
| 8079 | POST | `next-up/hide/{itemId}` | Authorize | `HideFromNextUp` |  |  |
| 8198 | DELETE | `continue-watching/hide/{itemId}` | Authorize | `UnhideFromContinueWatching` |  |  |
| 8203 | DELETE | `next-up/hide/{itemId}` | Authorize | `UnhideFromNextUp` |  |  |

#### MediaTags

| L | Verb | Route | Auth | Method | Admin? | Note |
|---|---|---|---|---|---|---|
| 1306 | GET | `tag-styles` | Authorize | `GetTagStyles` |  |  |
| 2513 | GET | `status-tags/trending` | Authorize | `GetStatusTagsTrending` |  |  |
| 2547 | GET | `status-tags/series` | Authorize | `GetStatusTagsSeries` |  |  |
| 4867 | GET | `audio-language-tags` | Authorize | `GetAudioLanguageTags` |  |  |
| 5288 | GET | `logo/{size}/{file}` | **anon** | `GetLogoImage` |  |  |
| 5891 | GET | `user-settings/{userId}/media-tags/export` | Authorize | `ExportUserMediaTags` |  |  |
| 5911 | POST | `user-settings/{userId}/media-tags/preview` | Authorize | `PreviewUserMediaTags` |  |  |
| 5930 | GET | `user-settings/{userId}/media-tags/presets` | Authorize | `GetMediaTagsPresets` |  |  |
| 5955 | POST | `user-settings/{userId}/media-tags/presets` | Authorize | `SaveMediaTagsPreset` |  |  |
| 6005 | DELETE | `user-settings/{userId}/media-tags/presets/{presetId}` | Authorize | `DeleteMediaTagsPreset` |  |  |
| 9422 | GET | `tag-cache/{userId}` | Authorize | `GetTagCache` |  |  |
| 9775 | POST | `tag-data/{userId}` | Authorize | `GetTagData` |  |  |
| 10456 | GET | `native-poster-tags/preview/{itemId}` | Authorize | `PreviewNativePosterTags` | yes |  |

#### Platform

| L | Verb | Route | Auth | Method | Admin? | Note |
|---|---|---|---|---|---|---|
| 3705 | GET | `script` | **anon** | `GetMainScript` |  |  |
| 3707 | GET | `js/{**path}` | **anon** | `GetScript` |  |  |
| 3709 | GET | `Configuration/jeAdmin.css` | **anon** | `GetAdminStylesheet` |  |  |
| 3712 | GET | `Configuration/jeAdmin.js` | **anon** | `GetAdminScript` |  |  |
| 3743 | GET | `version` | **anon** | `GetVersion` |  |  |
| 3746 | GET | `private-config` | Authorize | `GetPrivateConfig` | yes |  |
| 3827 | GET | `public-config` | **anon** | `GetPublicConfig` |  |  |
| 4288 | GET | `bootstrap` | Authorize | `GetBootstrap` | yes |  |
| 4468 | GET | `bundle.js` | **anon** | `GetScriptBundle` |  |  |
| 4471 | GET | `bundle.js.map` | **anon** | `GetScriptBundleMap` |  |  |
| 4743 | POST | `usage/track` | Authorize | `TrackUsage` |  |  |
| 4799 | POST | `usage/preview` | Authorize | `PreviewUsageReport` | yes |  |
| 5261 | GET | `locales` | Authorize | `GetAvailableLocales` |  |  |
| 5317 | GET | `cdn/{source}/{**path}` | **anon** | `GetCdnAsset` |  |  |
| 5366 | GET | `fonts/{name}` | **anon** | `GetBundledFont` |  |  |
| 5385 | GET | `locales/{lang}.json` | **anon** | `GetLocale` |  |  |
| 13657 | GET | `proxy/avatar` | Authorize | `ProxyAvatar` |  | shared by seerr, downloads, shared/ |
| 13927 | GET | `{viewName}` | Authorize | `GetView` |  |  |

#### Seerr

| L | Verb | Route | Auth | Method | Admin? | Note |
|---|---|---|---|---|---|---|
| 1253 | GET | `jellyseerr/status` | Authorize | `GetJellyseerrStatus` |  |  |
| 1357 | GET | `jellyseerr/validate` | Authorize | `ValidateJellyseerr` | yes |  |
| 1421 | POST | `jellyseerr/trigger-recently-added-scan` | Authorize | `TriggerJellyseerrRecentlyAddedScan` | yes |  |
| 1482 | GET | `jellyseerr/user-status` | Authorize | `GetJellyseerrUserStatus` | yes |  |
| 1612 | GET | `jellyseerr/permission-audit` | Authorize | `GetPermissionAudit` | yes |  |
| 1736 | GET | `jellyseerr/search` | Authorize | `JellyseerrSearch` |  |  |
| 1769 | GET | `jellyseerr/sonarr` | Authorize | `GetSonarrInstances` |  |  |
| 1776 | GET | `jellyseerr/radarr` | Authorize | `GetRadarrInstances` |  |  |
| 1787 | GET | `jellyseerr/sonarr/lookup/{tmdbId}` | Authorize | `GetSonarrLookup` | yes |  |
| 1801 | GET | `jellyseerr/settings/{type}` | Authorize | `GetJellyseerrArrSettings` | yes |  |
| 1901 | GET | `jellyseerr/{type}/{serverId}` | Authorize | `GetServiceDetails` |  |  |
| 1916 | POST | `jellyseerr/request` | Authorize | `JellyseerrRequest` |  |  |
| 2048 | GET | `jellyseerr/request` | Authorize | `GetJellyseerrRequests` |  |  |
| 2056 | GET | `jellyseerr/quota` | Authorize | `GetJellyseerrQuota` |  |  |
| 2187 | GET | `jellyseerr/tv/{tmdbId}` | Authorize | `GetTvShow` |  |  |
| 2194 | GET | `jellyseerr/tv/{tmdbId}/season/{seasonNumber}` | Authorize | `GetTvSeason` |  |  |
| 2201 | GET | `jellyseerr/movie/{tmdbId}` | Authorize | `GetMovie` |  |  |
| 2223 | GET | `jellyseerr/movie-collections` | Authorize | `GetMovieCollectionsBatch` |  |  |
| 2342 | GET | `jellyseerr/movie/{tmdbId}/similar` | Authorize | `GetSimilarMovies` |  |  |
| 2349 | GET | `jellyseerr/movie/{tmdbId}/recommendations` | Authorize | `GetRecommendedMovies` |  |  |
| 2356 | GET | `jellyseerr/movie/{tmdbId}/ratingscombined` | Authorize | `GetMovieRatingsCombined` |  |  |
| 2363 | GET | `jellyseerr/tv/{tmdbId}/similar` | Authorize | `GetSimilarTvShows` |  |  |
| 2370 | GET | `jellyseerr/tv/{tmdbId}/recommendations` | Authorize | `GetRecommendedTvShows` |  |  |
| 2377 | GET | `jellyseerr/tv/{tmdbId}/ratings` | Authorize | `GetTvRatingsCombined` |  |  |
| 2384 | GET | `jellyseerr/discover/tv/network/{networkId}` | Authorize | `DiscoverTvByNetwork` |  |  |
| 2391 | GET | `jellyseerr/discover/movies/studio/{studioId}` | Authorize | `DiscoverMoviesByStudio` |  |  |
| 2406 | GET | `jellyseerr/discover/tv/studio/{studioId}` | Authorize | `DiscoverTvByStudio` |  |  |
| 2498 | GET | `jellyseerr/discover/trending` | Authorize | `DiscoverTrending` |  |  |
| 2624 | GET | `jellyseerr/discover/movies` | Authorize | `DiscoverMovies` |  |  |
| 2631 | GET | `jellyseerr/discover/tv` | Authorize | `DiscoverTv` |  |  |
| 2638 | GET | `jellyseerr/discover/movies/upcoming` | Authorize | `DiscoverUpcomingMovies` |  |  |
| 2645 | GET | `jellyseerr/discover/tv/upcoming` | Authorize | `DiscoverUpcomingTv` |  |  |
| 2652 | GET | `studio/{studioId}` | Authorize | `GetStudioInfo` |  | Jellyfin item info used by Seerr detail pages; people/info also used by details-providers+media-tags |
| 2686 | GET | `boxset/{boxsetId}` | Authorize | `GetBoxSetInfo` |  | Jellyfin item info used by Seerr detail pages; people/info also used by details-providers+media-tags |
| 2720 | GET | `person/{personId}` | Authorize | `GetPersonInfo` |  | Jellyfin item info used by Seerr detail pages; people/info also used by details-providers+media-tags |
| 2764 | GET | `people/info` | Authorize | `GetPeopleInfo` |  | Jellyfin item info used by Seerr detail pages; people/info also used by details-providers+media-tags |
| 3076 | GET | `genre/{genreId}` | Authorize | `GetGenreInfo` |  | Jellyfin item info used by Seerr detail pages; people/info also used by details-providers+media-tags |
| 3102 | GET | `jellyseerr/person/{personId}` | Authorize | `GetJellyseerrPerson` |  |  |
| 3121 | GET | `jellyseerr/person/{personId}/combined_credits` | Authorize | `GetJellyseerrPersonCredits` |  |  |
| 3137 | GET | `jellyseerr/discover/tv/genre/{genreId}` | Authorize | `DiscoverTvByGenre` |  |  |
| 3144 | GET | `jellyseerr/discover/movies/genre/{genreId}` | Authorize | `DiscoverMoviesByGenre` |  |  |
| 3151 | GET | `jellyseerr/discover/tv/keyword/{keywordId}` | Authorize | `DiscoverTvByKeyword` |  |  |
| 3158 | GET | `jellyseerr/discover/movies/keyword/{keywordId}` | Authorize | `DiscoverMoviesByKeyword` |  |  |
| 3165 | GET | `tmdb/search/person` | Authorize | `SearchTmdbPerson` |  |  |
| 3176 | GET | `tmdb/search/keyword` | Authorize | `SearchTmdbKeyword` |  |  |
| 3187 | GET | `tmdb/genres/movie` | Authorize | `GetTmdbMovieGenres` |  |  |
| 3194 | GET | `tmdb/genres/tv` | Authorize | `GetTmdbTvGenres` |  |  |
| 3201 | GET | `jellyseerr/discover/genreslider/movie` | Authorize | `GetMovieGenreSlider` |  |  |
| 3208 | GET | `jellyseerr/discover/genreslider/tv` | Authorize | `GetTvGenreSlider` |  |  |
| 3215 | GET | `jellyseerr/overrideRule` | Authorize | `GetOverrideRules` |  |  |
| 3222 | GET | `jellyseerr/collection/{collectionId}` | Authorize | `GetCollection` |  |  |
| 3229 | GET | `jellyseerr/user` | Authorize | `GetJellyseerrUsers` | yes |  |
| 3244 | POST | `jellyseerr/request/tv/{tmdbId}/seasons` | Authorize | `RequestTvSeasons` |  |  |
| 3281 | GET | `jellyseerr/watchlist` | Authorize | `GetJellyseerrWatchlist` |  |  |
| 3295 | POST | `jellyseerr/sync-watchlist` | Authorize | `SyncJellyseerrWatchlist` | yes |  |
| 3348 | POST | `jellyseerr/import-users` | Authorize | `ImportJellyseerrUsers` | yes |  |
| 3591 | GET | `jellyseerr/settings/partial-requests` | Authorize | `GetJellyseerrPartialRequestsSetting` |  |  |
| 3661 | GET | `tmdb/validate` | Authorize | `ValidateTmdb` | yes |  |
| 4501 | GET | `tmdb/{**apiPath}` | Authorize | `ProxyTmdbRequest` |  |  |
| 4618 | GET | `watch-providers` | Authorize | `GetWatchProvidersBatch` |  | only caller in client seerr; semantically DetailsProviders/elsewhere |
| 10590 | GET | `jellyseerr/issue` | Authorize | `GetJellyseerrIssues` |  | client caller: details-providers/report-issue? verify |
| 10629 | GET | `jellyseerr/issue/{id}` | Authorize | `GetJellyseerrIssueById` |  | client caller: details-providers/report-issue? verify |
| 10646 | POST | `jellyseerr/issue` | Authorize | `ReportJellyseerrIssue` |  | client caller: details-providers/report-issue? verify |

#### Settings

| L | Verb | Route | Auth | Method | Admin? | Note |
|---|---|---|---|---|---|---|
| 5594 | GET | `user-settings/{userId}/settings.json` | Authorize | `GetUserSettingsSettings` |  |  |
| 5741 | GET | `user-settings/{userId}/settings-document` | Authorize | `GetRevisionedSettings` |  |  |
| 5753 | POST | `user-settings/{userId}/settings-document` | Authorize | `SaveRevisionedSettings` | yes |  |
| 5776 | GET | `user-settings/{userId}/shortcuts.json` | Authorize | `GetUserSettingsShortcuts` |  |  |
| 5813 | POST | `user-settings/{userId}/settings.json` | Authorize | `SaveUserSettingsSettings` |  |  |
| 6043 | POST | `user-settings/{userId}/shortcuts.json` | Authorize | `SaveUserSettingsShortcuts` |  |  |
| 8914 | POST | `reset-all-users-settings` | Authorize | `ResetAllUsersSettings` | yes |  |
| 9141 | POST | `apply-user-settings` | Authorize | `ApplyUserSettings` | yes |  |

#### SpoilerGuard

| L | Verb | Route | Auth | Method | Admin? | Note |
|---|---|---|---|---|---|---|
| 6400 | GET | `user-settings/{userId}/spoilerblur.json` | Authorize | `GetUserSpoilerBlur` |  |  |
| 6429 | POST | `user-settings/{userId}/spoilerblur.json` | Authorize | `SaveUserSpoilerBlur` |  |  |
| 6820 | GET | `spoiler-blur/health` | Authorize | `GetSpoilerBlurHealth` | yes |  |
| 6855 | DELETE | `spoiler-blur/health/{targetUserId}` | Authorize | `AckSpoilerBlurCorruption` | yes |  |
| 6892 | GET | `spoiler-blur/apply-existing/preview` | Authorize | `PreviewSpoilerApplyExisting` | yes |  |
| 6919 | POST | `spoiler-blur/apply-existing` | Authorize | `StartSpoilerApplyExisting` | yes |  |
| 6952 | GET | `spoiler-blur/apply-existing/status` | Authorize | `GetSpoilerApplyExistingStatus` | yes |  |
| 7002 | GET | `spoiler-blur/movies/{movieId}/in-scope` | Authorize | `GetSpoilerMovieScope` |  |  |
| 7025 | GET | `spoiler-blur/series` | Authorize | `GetSpoilerBlurSeries` |  |  |
| 7067 | GET | `spoiler-blur/user-prefs` | Authorize | `GetSpoilerBlurUserPrefs` |  |  |
| 7101 | POST | `spoiler-blur/user-prefs` | Authorize | `SetSpoilerBlurUserPrefs` |  |  |
| 7159 | POST | `spoiler-blur/series/{seriesId}` | Authorize | `EnableSpoilerBlurForSeries` |  |  |
| 7248 | DELETE | `spoiler-blur/series/{seriesId}` | Authorize | `DisableSpoilerBlurForSeries` |  |  |
| 7312 | POST | `spoiler-blur/movies/{movieId}` | Authorize | `EnableSpoilerBlurForMovie` |  |  |
| 7407 | DELETE | `spoiler-blur/movies/{movieId}` | Authorize | `DisableSpoilerBlurForMovie` |  |  |
| 7469 | POST | `spoiler-blur/collections/{collectionId}` | Authorize | `EnableSpoilerBlurForCollection` |  |  |
| 7557 | DELETE | `spoiler-blur/collections/{collectionId}` | Authorize | `DisableSpoilerBlurForCollection` |  |  |
| 7619 | POST | `spoiler-blur/pending/{mediaType}/{tmdbId}` | Authorize | `EnableSpoilerBlurPending` |  |  |
| 7869 | DELETE | `spoiler-blur/pending/{mediaType}/{tmdbId}` | Authorize | `DisableSpoilerBlurPending` |  |  |

#### Catchup (already separate: `Controllers/CatchUpController.cs`)
3 routes, all `[Authorize]`: `POST catchup/event` (L66), `GET catchup/events` (L110), `GET catchup/summary` (L136).

### Ambiguous endpoints (decide before the step that moves them)
| Route | Proposed | Why ambiguous | Recommendation |
|---|---|---|---|
| `people/info`, `person/{personId}`, `studio/{id}`, `boxset/{id}`, `genre/{id}` | Seerr | Jellyfin-library lookups (not Seerr). `people/info` is also called from `details-providers` and `media-tags` | Put in **Seerr** for now (the main caller), or create a small `Features/Library` later. Keep the routes unchanged either way |
| `watch-providers` | Seerr | Client calls it only from `features/seerr`, but it's TMDB watch-provider data ("elsewhere") | Seerr (follows the caller) |
| `items/by-providers` | Calendar | Generic TMDB/IMDB-to-item lookup; only caller is calendar | Calendar; move to Platform if a second caller appears |
| `proxy/avatar` | Platform | Callers: seerr, downloads, shared | Platform |
| `arr/movie-instances` | DetailsProviders | Called by both details-providers and downloads | DetailsProviders |
| `arr/validate/{sonarr,radarr}`, `jellyseerr/validate`, `tmdb/validate` | Admin / Seerr | Config-page validators | Keep `jellyseerr/*` and `tmdb/*` in Seerr (same HTTP helpers); `arr/validate/*` goes in Admin |
| `reviews/ratings` | DetailsProviders | Caller is media-tags (review score chips) | DetailsProviders owns reviews; MediaTags uses it through the HTTP route only |
| `translate`, `translate/languages` | DetailsProviders | `translate/languages` is used by the admin page | DetailsProviders |
| `user-settings/{userId}/ddd-triggers.json`, `.../elsewhere.json` | DetailsProviders | Per-user documents under `user-settings/` | DetailsProviders, but they must keep using the shared `UserSettingsAccess` (§3) |
| `whats-new`, `whats-new/dismiss` | Admin | UI is in `client/src/admin` | Admin |
| `UploadBrandingImage`, `BrandingStatus`, `BrandingImage`, `DeleteBrandingImage` | Chrome | Admin uploads; `chrome/login-image` and `splashscreen` consume | Chrome (owns `BrandingAssetStartupFilter`) |
| `activity` | Activity | The only Activity route; it calls `IsAdminUser()` | Activity |
| `jellyseerr/issue*` | Seerr | Report-issue UI may live in details-providers **(unverified)** | Seerr |
| `{viewName}` (GET, L13927) | Platform | **Catch-all template**: any single-segment GET not matched elsewhere lands here | Platform. Must stay on a controller whose other routes are literal, and route-order tests must cover it (§6 R1) |

### Private helpers used by more than one feature (evidence for §6 R2)
Found by matching `Name(` for each of the 119 private/internal methods against the feature ranges above. "Header" means L1–1252 (fields, ctor, Seerr cache helpers), so treat it as Seerr.

| Uses | Helper | Def line | Used in features |
|---:|---|---:|---|
| 13 | `IsAdminUser` | 5494 | DetailsProviders, Platform, SpoilerGuard, Activity, Settings, HiddenContent, Seerr, Downloads, Admin, Chrome, MediaTags, Header |
| 12 | `GetCurrentUserId` | 11570 | DetailsProviders, Platform, SpoilerGuard, Calendar, Activity, HiddenContent, Seerr, Admin, Downloads, Chrome, MediaTags, Header |
| 11 | `ResolveUserDisplay` | 11580 | DetailsProviders, Platform, SpoilerGuard, Bookmarks, Settings, HiddenContent, Seerr, Downloads, Chrome, MediaTags, Header |
| 6 | `AuthorizeUserConfigAccess` | 5443 | DetailsProviders, SpoilerGuard, Bookmarks, Settings, HiddenContent, MediaTags |
| 4 | `WarnIfArrInstancesCorrupt` | 5538 | DetailsProviders, Platform, Calendar, Downloads |
| 4 | `IsAllowedUrl` | 5507 | DetailsProviders, Platform, Seerr, Admin |
| 3 | `TryParseIso` | 8054 | SpoilerGuard, Seerr, Downloads |
| 3 | `ParentalBlockedResult` | 763 | Seerr, Downloads, Header |
| 3 | `GetJellyseerrUser` | 333 | Seerr, Downloads, Header |
| 3 | `FindLibraryItemByTmdb` | 7951 | DetailsProviders, SpoilerGuard, Seerr |
| 2 | `TryGetCachedSeerrReachability` | 137 | Platform, Header |
| 2 | `TryGetCachedJellyseerrUserId` | 606 | Seerr, Header |
| 2 | `TryBuildSeerrUserStatusWithoutLookup` | 1538 | Platform, Seerr |
| 2 | `SeerrStatusResponse` | 1261 | Platform, Seerr |
| 2 | `PreviewBody` | 6028 | MediaTags (public + admin routes; stays a private method of `JeMediaTagsController`) |
| 2 | `LoadUserHiddenContentDocument` | 6294 | Platform, HiddenContent |
| 2 | `LoadRevisionedSettings` | 5738 | Platform, Settings |
| 2 | `IsSeerrReachableCached` | 117 | Seerr, Header |
| 2 | `IsJellyseerrImportBlocked` | 555 | Seerr, Header |
| 2 | `IsAllowedUrlAsync` | 5522 | DetailsProviders, Platform |
| 2 | `GetUserIdCacheTtl` | 162 | Seerr, Header |
| 2 | `GetRootFolderFromPath` | 13331 | DetailsProviders, Calendar |
| 2 | `GetJellyseerrUserId` | 626 | Seerr, Chrome |
| 2 | `FetchSeriesInfoFromInstance` | 11323 | DetailsProviders, Downloads |
| 2 | `FetchMovieInfoFromInstance` | 11381 | DetailsProviders, Downloads |
| 2 | `CreateReviewVisibilityContext` | 8301 | DetailsProviders, MediaTags |
| 2 | `ClearUserCaches` | 567 | Seerr, Header |
| 2 | `BuildHcDefaultSettings` | 6322 | Settings, HiddenContent |
| 2 | `BuildActiveSessionList` | 11444 | Platform, Chrome |
| 2 | `AuthorizeUserAccess` | 5468 | DetailsProviders, MediaTags |
| 2 | `ApplyParentalFilterAsync` | 778 | Seerr, Header |
| 2 | `AddSpoilerBlurPendingInternal` | 7695 | SpoilerGuard, Seerr |

Static state on the controller (§6 R3): `_avatarCache` (L91), `_userIdCacheLock`/`_userCacheLock`/`_responseCacheLock` (L96–104), `_lastManualImport` (L107), `_seerrStatusCacheLock` (L114), `_tmdbEnrichmentInFlight` (L154), `DiscoverFilterParams` (L658), `AdvancedRequestFields` (L837), `_loggedCorruptArrConfig` (L5535), `_tmdbIdRegex` (L8276), `_tagCacheJsonOptions` and `_tagCacheSerializationGate` (L9663–9668), `_arrLinksInstanceGates` (L11091), poll-log dedupe (L11599), `_arrQueueCacheLock` (L11722). There is also the public static `ClearAllSeerrCachesOnConfigChange()` (L580), which tests call 7 times.

Nested DTOs on the controller that tests refer to by type (§6 R4): `ConfigurationPatchRequest` (8 test refs), `TranslateRequest`. The others are `TmdbEnrichmentResult`, `WatchlistItem`, `AddBookmarkPayload`, `SpoilerBlurMovieRequest`, `SpoilerBlurCollectionRequest`, `SpoilerBlurPendingResult`, `ReviewPayload`, `ReviewVisibilityContext`, `ApplyUserSettingsRequest`, `CalendarUserDataRequest`, `CalendarEventInfo` and `MaintenanceBroadcastRequest`. Nested types in the rest of the class are not listed **(unverified)**.

---

## 2. Target layout

Some of this already exists: `Features/Bookmarks/BookmarkDocumentService.cs` (namespace `Jellyfin.Plugin.JellyfinEnhanced.Features.Bookmarks`) and `Infrastructure/Persistence/UserConfigurationDocument.cs`. The plan extends that convention and adds no new top-level concept.

```
Jellyfin.Plugin.JellyfinEnhanced/
  JellyfinEnhanced.cs, PluginServiceRegistrator.cs, Logger.cs   (stay; registrator becomes a list of AddXxx() calls)
  Configuration/        STAYS (PluginConfiguration XML + settings types; compiled by path into tools/ClientContracts)
  Transport/            STAYS (bootstrap wire contracts; compiled by path into tools/ClientContracts)
  Infrastructure/       Persistence/ (exists) + Http/JeControllerBase.cs + Auth/RequestAuthorization.cs
                        + Identity/ (RequestIdentityService) + Extensions/ (moved from Extensions/)
                        + Hosting/MvcFilterRegistration.cs (filter ORDER lives here, one place)
  Shared/               Arr/ (ArrInstance, ArrItem, ArrType, SonarrService, RadarrService, ArrUrlGuard, ArrInstanceClient)
                        Library/ (ItemLibraryResolver, LibraryItemLookup, UserDisplayResolver)
                        Media/ (TrackRoles, MediaStreamLanguageResolver, SubtitleAccessibility)  *see note
                        Text/ (PluralRules)
  Features/<Feature>/
     Je<Feature>Controller.cs          one controller, [Route("JellyfinEnhanced")] + the same per-action templates
     Je<Feature>Controller.<Area>.cs   optional partials when one controller passes 1,500 lines (see §7)
     Services/  Models/  Tasks/  Events/   (only the folders the feature needs)
     <Feature>ServiceRegistration.cs   public static IServiceCollection Add<Feature>(this IServiceCollection)
```

Features: `Activity, Admin, Bookmarks, Calendar, Catchup, Chrome, DetailsProviders, Downloads, HiddenContent, MediaTags, Platform, Seerr, Settings, SpoilerGuard`. They match `client/src/features/*`, plus `Admin` (client/src/admin) and `Platform` (client/src/{bootstrap,host,core,pages} + client/src/features/shared). `player` and `settings-panel` have no backend routes. `settings-panel` is served by `Settings`; there is no backend `SettingsPanel`. Backend top-level `Shared/` and `Infrastructure/` are layers, not features, and are unrelated to client `features/shared`. **The canonical feature list is the table in `PLAN.md` (checked in as `docs/feature-map.json`); if this section disagrees, PLAN.md wins.**

**Controller naming: prefix `Je`** (e.g. `JeSeerrController`). Jellyfin core already ships `ActivityLogController`, `ConfigurationController`, `LibraryController`, etc. Unprefixed names like `SettingsController` or `ActivityController` risk ApiExplorer/OpenAPI operation-id or controller-name collisions **(unverified for 12.x; the prefix avoids the question)**.

**Namespaces:** `Jellyfin.Plugin.JellyfinEnhanced.Features.<Feature>[.Services|.Models|.Tasks]`. The architecture test in §7 keys on these, so a file's folder and namespace must match.

\* Shared/Media note: `TrackRoles` is used by MediaTags, SpoilerGuard and Model. `PluralRules` is used by Helpers and PosterTags. Both are pure functions, so Shared is correct.

### File → destination mapping
"Phase 1" = the file move (`git mv`, namespace unchanged). Namespaces change in Phase 2 when the feature's controller is extracted (see §4).

| Current file | Lines | Destination | Notes |
|---|---:|---|---|
| Controllers/CatchUpController.cs | 144 | Features/Catchup/JeCatchupController.cs | rename class in Phase 2; routes unchanged |
| Services/CatchUpLogService.cs | 200 | Features/Catchup/Services/ | |
| Services/ActivityService.cs, ActivityFeedBuilder.cs, ActivityFavoriteMonitor.cs | 54/229/80 | Features/Activity/Services/ | |
| EventHandlers/ActivityPlaybackConsumer.cs | 90 | Features/Activity/Events/ | |
| Features/Bookmarks/BookmarkDocumentService.cs | 120 | Features/Bookmarks/Services/ | already in Features |
| Transport/BookmarkDocument.cs | 32 | STAYS | ClientContracts compiles by path |
| Services/SettingsDocumentService.cs, SettingsDocumentPatch.cs | 52/144 | Features/Settings/Services/ | |
| Services/HiddenContentResponseFilter.cs | 564 | Features/HiddenContent/Services/ | MVC filter: registration order is central (§6 R6) |
| EventHandlers/ContinueWatchingPlaybackEvents.cs | 234 | Features/HiddenContent/Events/ | contains `ContinueWatchingLibraryHook` (hosted) |
| Services/SpoilerGuard/* (15 files) | 7,174 | Features/SpoilerGuard/Services/ | keep file names |
| EventHandlers/SpoilerAutoEnableEvents.cs | 141 | Features/SpoilerGuard/Events/ | |
| ScheduledTasks/SpoilerApplyExistingTitlesTask.cs | 57 | Features/SpoilerGuard/Tasks/ | `IScheduledTask` key/name must not change (§6 R7) |
| Services/BrandingAssetStartupFilter.cs | 244 | Features/Chrome/Services/ | IStartupFilter |
| Services/MaintenanceModeService.cs, MaintenanceScheduleService.cs | 902/159 | Features/Admin/Services/ | hosted service |
| EventHandlers/MaintenancePlaybackReminder.cs | 77 | Features/Admin/Events/ | |
| Services/WhatsNewService.cs, Model/WhatsNewData.cs | 418/29 | Features/Admin/Services/, Models/ | **path read by** tests/frontend/helpers/admin-tags-declarations.mjs, features/admin-tags-rewrite.test.mjs (+ .declarations.json), features/admin-config-rewrite.test.mjs |
| Helpers/PluginConfigurationPatch.cs | 230 | Features/Admin/Services/ | path read by tests/frontend/helpers/admin-tags-page.mjs |
| Helpers/MediaTagsPageFields.cs | 364 | Features/MediaTags/Admin/ | path read by admin-tags-declarations.mjs, admin-tags-rewrite.test.mjs (+json), features-admin-tags-page-server.test.mjs |
| Services/TagCacheService.cs + partials TagCacheAwards/CustomTags/Inheritance/Leaving/Logos/Scenes/SourceRatings.cs | 4,123 + 1,813 | Features/MediaTags/Services/TagCache/ | **partial class: all 8 move together in one commit** (§6 R1). Path read by core-tag-pipeline, features-rating-sources and features-source-edition-tags tests |
| Services/TagCacheMonitor.cs, TagCachePendingChanges.cs, TagCacheResponseBody.cs | 157/67/181 | Features/MediaTags/Services/TagCache/ | |
| Services/StatusTags{EpisodeFacts,EpisodeLookup,ScenesService,SeriesService,TrendingService}.cs, NativeStatusRefreshService.cs | ~1,296 | Features/MediaTags/Services/Status/ | NativeStatusRefreshService is hosted |
| Services/AwardTagsService.cs, LeavingSoonService.cs, MediaNamingTags.cs, SeriesQualityAggregation.cs, TagLogoService.cs | ~2,251 | Features/MediaTags/Services/ | |
| Services/PosterTags/** (incl. Rendering/, Resolution/) | ~17k | Features/MediaTags/PosterTags/** (keep sub-tree) | **paths read by** scripts/generate_technical_ratios.py, scripts/tag-data.mjs, tests/client-build/tag-data.test.mjs, tools/ClientContracts/boundary.test.mjs, features-tag-runtime-generators.test.mjs, features-tag-poster-colours.test.mjs. `LanguageFlagRules.cs` ↔ client `features/media-tags/**/languagetags.ts` |
| Helpers/AudioLanguageTagHelper.cs, MatroskaLanguageCache.cs, MatroskaLanguageReader.cs, MediaTagsPortable.cs, TagEpisodeSelector.cs | 156/475/695/697/196 | Features/MediaTags/Services/ | MediaTagsPortable path read by bootstrap-media-tags-portable.test.mjs |
| Model/TagCacheEntry.cs, TagAwards.cs, TagLeaving.cs, TagLogo.cs, TagQualitySummary.cs, TagSourceRatings.cs | ~691 | Features/MediaTags/Models/ | TagCacheEntry is also used by SpoilerGuard (allow-list it, §7) |
| ScheduledTasks/ArrTagsSyncTask, AudioLanguageTagsSyncTask, BuildTagCacheTask, RefreshAwardTagsTask, RefreshLeavingSoonTagsTask | 597 | Features/MediaTags/Tasks/ | |
| Services/AnilistReviewsService, DoesTheDogDieService, ElsewhereDocumentService, ItemStatsService, MdblistService, ReviewAuthorCache, ReviewTranslationService, WikidataAwardsService | ~2,729 | Features/DetailsProviders/Services/ | WikidataAwardsService is consumed by MediaTags AwardTagsService (allow-list) |
| Helpers/ReviewVisibility.cs, ProviderHelper.cs | 81/78 | Features/DetailsProviders/Services/ | ReviewVisibility is also used by PosterTags (allow-list) |
| Model/AwardsData.cs, DoesTheDogDieData.cs, MdblistRatings.cs | 230 | Features/DetailsProviders/Models/ | |
| ScheduledTasks/ClearTranslationCacheTask, MdblistRatingsFetchRunner, MdblistRatingsFetchTask, MdblistRatingsSyncTask | 521 | Features/DetailsProviders/Tasks/ | ClearTranslationCacheTask is `partial` **(check it stays whole)** |
| Services/AutoMovieRequest{Service,Monitor}, AutoSeasonRequest{Service,Monitor}, WatchlistMonitor, SeerrParentalFilter, SeerrScanTriggerService, MovieCollectionsBatch, TmdbCompanyTvDiscover, TmdbResponseCache, WatchProvidersBatch | ~5,463 | Features/Seerr/Services/ | |
| Helpers/Jellyseerr/* (9 files) | 1,153 | Features/Seerr/Services/ | SeerrHttpHelper is used by JellyfinEnhanced.cs (plugin root may reference features) |
| Model/Jellyseerr/* | 50 | Features/Seerr/Models/ | |
| ScheduledTasks/JellyseerrWatchlistSyncTask (partial), JellyfinToSeerrWatchlistSyncTask, JellyseerrUserImportTask | 1,192 | Features/Seerr/Tasks/ | |
| Services/StartupService, ScriptInjectionStartupFilter, ClientScriptBundle, CdnAssetService, HostCompatibilityService, UsageEventCounterService, AnalyticsReportingService | ~2,401 | Features/Platform/Services/ | ClientScriptBundle path read by bootstrap-manifest.test.mjs and tests/frontend/README.md; CdnAssetService path read by scripts/generate_config_flag_groups.py |
| Model/AnalyticsData.cs | 113 | Features/Platform/Models/ | **compiled by path in tools/ClientContracts/ClientContracts.csproj**: update that `<Compile Include>` |
| ScheduledTasks/AnalyticsReportTask, RefreshCdnAssetsTask | 139 | Features/Platform/Tasks/ | |
| Helpers/BuildAttestation.cs | 49 | Features/Platform/Services/ | |
| Model/Arr/* | 235 | Shared/Arr/ | ArrInstance.cs is **compiled by path in ClientContracts.csproj** |
| Services/SonarrService.cs, RadarrService.cs, Helpers/ArrUrlGuard.cs | 437 | Shared/Arr/ | used by Downloads, Calendar, DetailsProviders, MediaTags (ArrTagsSyncTask) |
| Services/ItemLibraryResolver.cs | 66 | Shared/Library/ | used by controller and PosterTags |
| Helpers/TrackRoles.cs, MediaStreamLanguageResolver.cs, SubtitleAccessibility.cs | 167 | Shared/Media/ | TrackRoles path read by core-media-language.test.mjs |
| Helpers/PluralRules.cs | 86 | Shared/Text/ | |
| Helpers/UserHelper.cs | 38 | Infrastructure/Auth/ | used by CatchUp, Identity, PosterTags, SpoilerGuard |
| Services/Identity/RequestIdentityService.cs | 544 | Infrastructure/Identity/ | |
| EventHandlers/UserTopologyEvents.cs | 107 | Infrastructure/Identity/ | **split**: `UserCreated/DeletedIdentityInvalidator` stays here; `TagCacheAccessInvalidator` (L60) → MediaTags/Events; `ReviewAuthorCacheInvalidator` (L87) → DetailsProviders/Events |
| Extensions/*.cs | 117 | Infrastructure/Extensions/ | |
| Configuration/*, Transport/*, Infrastructure/Persistence/* | | STAY | |

### DI registration (`PluginServiceRegistrator.cs`, 226 lines)
Today it has ~95 `Add*` calls in one method, **interleaved across features** (e.g. Seerr at L56–63/L102/L118–120, MediaTags at L68–69/L77–78/L91–98/L112–117/L195+), so grouping by feature necessarily reorders lines (review-r2 F1). The **order matters** in four places, and all four must survive:
1. `IStartupFilter`s: `ScriptInjectionStartupFilter` then `BrandingAssetStartupFilter` (L33–34).
2. `Configure<MvcOptions>` filter order (L210–222): `HiddenContentResponseFilter`, `SpoilerIdentityTagFilter`, `SpoilerFieldStripFilter`, `PosterTagImageFilter`, `SpoilerBlurImageFilter`. The comment explains that they post-process in reverse order. **Keep this block verbatim in one file** (`Infrastructure/Hosting/MvcFilterRegistration.cs`), even though the filters belong to three features.
3. `NativeStatusRefreshService` is registered as a singleton and then as `AddHostedService(sp => sp.GetRequiredService<…>())` (L94–95). Both lines must move together.
4. **Multi-registered event consumers** (review-r2 F1): `IEventConsumer<PlaybackStartEventArgs>` ×3 (`MaintenancePlaybackReminderConsumer` L131, `ContinueWatchingPlaybackConsumer` L133, `SpoilerAutoEnableOnFirstPlayConsumer` L165), `IEventConsumer<UserDeletedEventArgs>` ×3 and `IEventConsumer<UserUpdatedEventArgs>` ×2 come from different features and are resolved in registration order. S2.0b moves **every `IEventConsumer<…>` registration** verbatim, in its original relative order, into one `Infrastructure/Hosting/EventConsumerRegistration.cs` (like the MVC filter block); `AddJe<F>()` never registers an event consumer. Other multi-registered types (`IStartupFilter`, the 5 `IHostedService`s) stay in `AddJe<F>()` only if the per-type order gate below still passes; otherwise the line stays in `AddJePlatform()` in original order.

Target: `RegisterServices` becomes a short sequence of calls (`services.AddJePlatform(); services.AddJeSeerr(); … services.AddJeMvcFilters();`). Keep the **original relative order** of calls across features. Each `Add<Feature>` lists its lines in their original order. Controllers need no registration: MVC discovers them from the plugin assembly.
Gate: add a test (`Architecture/ServiceRegistrationSnapshotTests`) that runs `RegisterServices` into a `ServiceCollection` and snapshots two things (review-r2 F1): **(a)** the **multiset** of `(ServiceType, ImplementationType|"factory", Lifetime)` entries, stored sorted, so feature grouping doesn't change it; **(b)** for **every ServiceType registered more than once** (computed from the collection, so it covers `IStartupFilter`, each `IEventConsumer<…>`, `IHostedService` and any future one), the **ordered** list of implementations. A global in-order snapshot is deliberately not used: it would fail at the first non-contiguous feature (S2.3) by design. Phase 2 steps must keep (a) and (b) identical, except for namespace changes in type names. Compare on `Type.Name` plus a namespace-insensitive key. Record `"factory"` for factory registrations (e.g. the `AddHostedService(sp => …)` at L95, whose `ImplementationType` is null). The `(ServiceType, ImplementationType, Lifetime)` list sees the MVC filter block only as one `IConfigureOptions<MvcOptions>`, so the test also builds the provider, resolves `IOptions<MvcOptions>` and snapshots `Filters.OfType<ServiceFilterType>().Select(f => f.ServiceType.Name)` **in order** (review-r1 F5).

---

## 3. Keeping authorization identical

### What exists today (evidence)
- **Attributes:** only bare `[Authorize]` (186 on JellyfinEnhancedController; 186 + 12 anonymous = 198 methods, 3 on CatchUpController). There are **no policies or roles** (`Policy=`, `Roles=`, `RequiresElevation` and `FirstTimeSetupOrElevated` never appear), and there is **no class-level `[Authorize]`**. 12 routes are anonymous because they have no attribute (list in §1).
- **Admin checks happen in the method body**: `private bool IsAdminUser()` (L5494) returns true for `User.IsInRole("Administrator")`, or when `IUserManager` reports `PermissionKind.IsAdministrator` for the `Jellyfin-UserId` claim. It has 73 real call sites (64 in 59 actions, 9 in 5 private helpers; 79 was the raw grep count incl. definition and comments). The usual pattern is `if (!IsAdminUser()) return Forbid();`, but some calls only shape data (e.g. `arr/links`, `reviews/*`).
- **Per-user identity** (`/user-settings/{userId}/…`, `tag-cache/{userId}`, `item-stats/{userId}/…`):
  - `AuthorizeUserConfigAccess(string requestedUserId, out string authorizedUserId)` (L5443, 27 call sites). It parses D or N GUIDs, then calls `UserHelper.GetUserId(User, id)`, which allows **self or Administrator role**, and returns the N-format id. Otherwise it returns 400 or `Forbid()`.
  - `AuthorizeUserAccess(Guid, out JUser)` (L5468, 6 call sites) does the same check and adds `NotFound()` when the user is missing.
- **Two current-user resolvers that disagree:**
  - `UserHelper.GetCurrentUserId` reads the `Jellyfin-UserId` claim.
  - The controller's private `GetCurrentUserId()` (L11570, 48 uses) reads `NameIdentifier`, then `sub`, then `Sid`, and returns `Guid.Empty` on failure.
  - **Do not unify them during the move.** Preserve each call site's resolver exactly. File a follow-up.
- **Request identity for filters:** `Services/Identity/RequestIdentityService.Resolve(HttpContext)`, used by `PosterTagImageFilter` and the spoiler filters. It doesn't change.
- `CatchUpController` uses `UserHelper` directly.

### Shared base (Phase 2, step 2)
`Infrastructure/Http/JeControllerBase : ControllerBase` (abstract, **no class-level attributes at all**, so the anonymous routes stay anonymous):
```csharp
public abstract class JeControllerBase : ControllerBase
{
    // Same field names as JellyfinEnhancedController (review-r2 F5): the moved bodies compile unchanged, and the
    // derived controller DELETES its own copies of these three fields (a same-named field would raise CS0108).
    protected JeControllerBase(IUserManager userManager, Logger logger, UserConfigurationManager userConfigurationManager)
    { _userManager = userManager; _logger = logger; _userConfigurationManager = userConfigurationManager; }
    protected readonly IUserManager _userManager;
    protected readonly Logger _logger;               // exact declared types copied from the controller's fields
    protected readonly UserConfigurationManager _userConfigurationManager;
    // Bodies moved VERBATIM from JellyfinEnhancedController; names unchanged so the IL gate below can match them.
    protected bool IsAdminUser() { ... }                                     // was L5494
    protected IActionResult? AuthorizeUserConfigAccess(string requestedUserId, out string authorizedUserId) { ... } // L5443
    protected IActionResult? AuthorizeUserAccess(Guid requestedUserId, out JUser user) { ... }                     // L5468
    protected Guid GetCurrentUserId() { ... }                                // L11570 (claims NameIdentifier/sub/Sid)
    // Also here because they read User/IsAdminUser() and are shared across features (review-r1 F2):
    protected ReviewVisibilityContext CreateReviewVisibilityContext(string endpoint, string target) { ... } // L8301
    protected RevisionedSettingsResponse LoadRevisionedSettings(string userId) { ... }                     // L5738
}
```
`ResolveUserDisplay` (L11580, 11 features) goes to `Shared/Library/UserDisplayResolver` as an injected singleton, not into the base class. Step 2 first makes `JellyfinEnhancedController : JeControllerBase` and deletes the private copies. This is one small, verifiable commit before any endpoint moves.
Each feature controller must declare `[ApiController]` and `[Route("JellyfinEnhanced")]` itself. Route templates are copied **character for character**, including the odd casing of `UploadBrandingImage`, `MaintenanceMode/Status` and `Configuration/jeAdmin.js`.

Not chosen: an `[JeAdmin]` filter attribute that replaces in-body checks. It would be cleaner, but it changes behaviour for the data-shaping call sites and mixes up "move" with "refactor". Do it later as a separate change against the same gates.

### Gate A: route/verb/auth snapshot (runtime routing)
New `tests/backend/Architecture/RouteAuthSnapshotTests.cs`. Reuse the `TestServer` setup from `Api/ApiRoutingTests.cs` (L43–51, `AddControllers().AddApplicationPart(typeof(JellyfinEnhancedController).Assembly)`). Resolve `EndpointDataSource` and, for every `RouteEndpoint` whose `ControllerActionDescriptor.ControllerTypeInfo.Assembly` is the plugin assembly, emit:
`{ verb, routePattern.RawText, requiresAuth = metadata.GetOrderedMetadata<IAuthorizeData>().Any() && !metadata.Any<IAllowAnonymous>(), policies/roles (joined), actionName, apiBehavior = metadata.Any<IApiBehaviorMetadata>(), parameters = [name:BindingSource.Id] }` (the last two from `ControllerActionDescriptor.Parameters`, review-r1 F6, so a missing `[ApiController]` or a changed binding source shows up).
Sort the entries and compare against the checked-in `tests/backend/Architecture/route-auth.snapshot.json`. **The controller type name is left out**, so moving an action between controllers doesn't change the snapshot. **`actionName` stays in**, which forces method names to be kept. Expected size: 199 + 3 = 202 entries, 12 with `requiresAuth=false`.
Regenerating the snapshot needs an explicit env var (`JE_UPDATE_SNAPSHOTS=1`), and a PR that changes it must explain why. Refactor steps must **never** regenerate it.

### Gate B: in-body auth-helper call snapshot (IL)
Gate A can't see `IsAdminUser()` inside bodies. `tests/backend/Architecture/AuthHelperCallSnapshotTests.cs` adds that check:
- For every action method, take the method plus its async state machine (`AsyncStateMachineAttribute.StateMachineType.GetMethod("MoveNext")`) plus compiler-generated closure/local-function methods whose name contains `<{ActionName}>`.
- Decode the IL call/callvirt tokens with `Module.ResolveMethod`. Count calls to the helper set `{IsAdminUser, AuthorizeUserConfigAccess, AuthorizeUserAccess, GetCurrentUserId, UserHelper.GetUserId, UserHelper.GetCurrentUserId, RequestIdentityService.Resolve}`, matched by **method name only**, where the declaring type is any type deriving from `ControllerBase` in the plugin assembly (incl. `JeControllerBase`) or `UserHelper`/`RequestIdentityService`. So the move into `JeControllerBase` is invisible (review-r1 F7).
- Snapshot `actionName → {helper: count}` as `auth-helper-calls.snapshot.json`.

Transitive attribution (review-r1 F2): follow calls **transitively** (with a visited set) into same-assembly methods declared on controller types and `JeControllerBase` only, never into services. Helpers that call `IsAdminUser()`/`User` today (`ProxyJellyseerrRequest` ×5, `LoadRevisionedSettings`, `CreateReviewVisibilityContext`, `ValidateArrService`, `GetAllowedRequestsForCurrentUserAsync`) therefore **must stay controller or base members**; a step that moves one into a service would change the counts and is wrong, not a reason to regenerate.
Companion check `ServicesDoNotReadUserTests`: fail if any type under `Features/**/Services`, `Shared/**` or `Infrastructure/**` (except `JeControllerBase`, `UserHelper`, `RequestIdentityService`) references `ControllerBase.User` or `IsAdminUser`.

### Gate C: behavioural spot checks (already partly present)
Extend `ApiRoutingTests.PrivateRoutesChallengeBeforeControllerUsesHostServices` from its current inline list to **all** `requiresAuth=true` entries in the snapshot: an anonymous request must get 401 before the controller is activated. Extend `PublicAssetsRouteAndExecuteWithoutAuthentication` to all 12 anonymous entries, checking for "not 401" rather than the mime type for the dynamic ones.
Required fix: `ApiRoutingTests.AssetActivator` (L22–30) **always returns a `JellyfinEnhancedController`** via `ApiAssetTests.Controller(fixture)`. Change it to construct `context.ActionDescriptor.ControllerTypeInfo` by reflection (the same parameter-filling logic as `ApiAssetTests.Controller`, L12–20, generalised to `Type`). Without this change, every split breaks the routing tests.

Gates A–C go in **step 0**, before any code moves, and are green against the current code.

### Other readers of backend paths and namespaces (a move must update them in the same step)
Found with `grep -rnoE '[A-Z][A-Za-z]+(\.g)?\.cs'` over scripts/, tools/, tests/{frontend,client-build,poster,runner,inventory}, .github/ and package.json:
- **Compiled by path:** `tools/ClientContracts/ClientContracts.csproj` → Transport/{BootstrapResponse,BookmarkDocument,BootstrapConfig}.cs, Configuration/{UserConfiguration,PluginConfiguration,TagLayoutSettings,TagLookSettings,TagShapeSettings,NativePosterDateContext,CustomTagRuleSet}.cs, **Model/Arr/ArrInstance.cs, Model/AnalyticsData.cs**.
- **Generators that write into the tree, with path and namespace hard-coded:**
  - `tests/poster/parity/gen-resolution-data.mjs` (L20 path, L260 `namespace …Services.PosterTags.Resolution`) → ResolutionData.g.cs
  - `scripts/generate_quality_compact.py` → QualityCompactLabels.g.cs (namespace in the template)
  - `scripts/tag-data.mjs`
  - `scripts/generate_technical_ratios.py` → TechnicalQualityRules.cs
  - `scripts/generate_per_user_props.py` (L16 reads `Controllers/JellyfinEnhancedController.cs`)
  - `scripts/generate_config_flag_groups.py` (reads CdnAssetService.cs and PluginConfiguration.cs)
- **C# harnesses that use the namespaces** `…Services.PosterTags[.Rendering|.Resolution]`: `tests/poster/pipeline/PosterTagsPipelineHarness.csproj`, `tests/poster/rendering/PosterTagsHarness.csproj`, `tests/poster/parity/PosterTagParity/PosterTagParity.csproj`.
- **Text-scraping tests:**
  - `tests/frontend/features/features-admin-config-schema.test.mjs:72` slices the controller between `[HttpPost("reset-all-users-settings")]` and `BuildHcDefaultSettings`
  - `features-admin-tags-page-overview-layout.test.mjs:230` slices `var defaultUserSettings = new JellyfinEnhancedUserSettings` … `TagLayoutRules.ApplyDefaults(`. Its anchors are inside `CreateSettingsDefaults`, which moves in **S2.0a** (not S2.8); S2.0a repoints it and adds a not-found guard (review-r2 F3)
  - `admin-tags-declarations.mjs`, `admin-tags-rewrite.test.mjs` (+`.declarations.json`), `admin-config-rewrite.test.mjs`, `features-admin-tags-page-server.test.mjs`, `bootstrap-manifest.test.mjs`, `bootstrap-media-tags-portable.test.mjs`, `core-media-language.test.mjs`, `core-tag-pipeline.test.mjs`, `features-rating-sources.test.mjs`, `features-source-edition-tags.test.mjs`, `features-tag-poster-colours.test.mjs`, `features-tag-runtime-generators.test.mjs:53`, `tests/client-build/tag-data.test.mjs`, `tools/ClientContracts/boundary.test.mjs`, `tests/poster/parity/colours-expected.mjs`
- **Mutation and inventory tooling:** `tests/runner/mutations.py` (Helpers/UserHelper.cs, Helpers/Jellyseerr/ParentalTagDecision.cs, Services/Identity/RequestIdentityService.cs), `tests/runner/tests/test_regression.py` (Services/PosterTags/NativeClientPolicy.cs at L82; the generator fixture `Controllers/Feature.cs` at L121-160 is synthetic and changes only in S0), **`tests/history/backend-mutations.json`** (review-r4 #2: `Services/CdnAssetService.cs` and `Helpers/ArrUrlGuard.cs` → P1-g, `Services/PosterTags/NativeClientPolicy.cs` → P1-e, `Controllers/JellyfinEnhancedController.cs` with anchor `content = StripAdvancedRequestOptions(content);` (today L954) → S2.14), the frontend default `test_file` in `tests/runner/mutations.py` L87/L120 and `tests/history/recent-mutations.json` (`features-bookmarks.test.mjs`) → frontend F1. **Decision: rewrite the `file`/`test_file` fields in place; no path map.** These files are live inputs to the extended CI job (`regression.yml:253-255`, `run.py mutation`/`history`), and `mutations.py` reads `file` relative to the checkout and raises when the anchor doesn't match once (L126), so a map would need new runner code for no benefit. Leave `sources`, `evidence` and `rationale` untouched: they are historical records. `tests/inventory/generate.py` (Services/StartupService.cs), `tests/docs/production-inventory.json`, `tests/docs/coverage-matrix.md`.
- **CI trigger filters:** `.github/workflows/regression.yml:215` runs offline poster parity only when a PR touches `Services/|Model/|Configuration/|Helpers/|Assets/PosterTags/…`. After P1-e/P1-g, poster code lives under `Features/MediaTags/`, `Shared/` and `Infrastructure/`, so P1-e extends the regex (review-r4 #3).
- **Comments only (R grep catches them):** `tests/poster/parity/PosterTagParity/Program.cs:1` ("Services/PosterTags") → P1-e.
- **Not path readers:** the many `enhanced/admintags/admin-tags.{js,css}` references in tests/backend, tests/browser and tests/frontend are built `js/**` output paths, which never change (gate G).
- **Docs:** `.github/workflows/docs.yml` (Configuration/PluginConfiguration.cs, which stays), plus docs/rewrite/{elsewhere-document,seerr-proxy-outcomes,admin-tags}.md.
Every step runs `git grep -nE '<old path or namespace>'` for each file it moves and must end with zero hits outside `artifacts/`.

---

## 4. Migration order

### Commands (from the repo; run inside the step's worktree)
```bash
# once per worktree (the plugin build runs `node scripts/client-build.mjs --check` via Directory.Build.targets, so node_modules is required)
npm ci
dotnet restore Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj -p:JellyfinTarget=jf12
dotnet restore tests/backend/JE.Tests.csproj -p:JellyfinTarget=jf12

# B = build (must be warning-neutral vs. baseline)
dotnet build Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.csproj -c Release -p:JellyfinTarget=jf12 --no-restore
# G = gates (step 0 onward)
dotnet test tests/backend/JE.Tests.csproj -c Release --no-restore -p:JellyfinTarget=jf12 --filter "FullyQualifiedName~Architecture"
# T = full backend suite
dotnet test tests/backend/JE.Tests.csproj -c Release --no-restore -p:JellyfinTarget=jf12
# F = frontend + contracts + path readers
npm run test:frontend && npm run test:client-build && npm run contracts:check && npm run test:contract-boundary && npm run verify:rewrite && npm run inventory:rewrite:check
# INV = production inventory (CI: regression.yml:36, tests/run.py:82); route list must equal the step-1 baseline (PLAN.md gate INV).
# The gate does NOT regenerate (review-r4 #4). Regenerating is a step action: a step that moves controller files runs
# `python3 tests/inventory/generate.py` and commits the result; then, on the committed tree:
scripts/restructure-gates.sh inv     # = generate.py --check, then the route-list diff against baselines/inventory-routes.txt
# TOOL = runner unit tests (CI: regression.yml:134) + mutation/history path check (PLAN.md gate TOOL; review-r4 #1, #2)
scripts/restructure-gates.sh tool    # = python3 tests/run.py tooling && the check below
# H = poster harnesses (only steps that touch MediaTags/PosterTags namespaces)
for p in tests/poster/rendering/PosterTagsHarness.csproj tests/poster/pipeline/PosterTagsPipelineHarness.csproj tests/poster/parity/PosterTagParity/PosterTagParity.csproj; do dotnet build "$p" -c Release -p:JellyfinTarget=jf12 || break; done
node tests/poster/parity/gen-resolution-data.mjs --check   # documented at L8 of the script
# R = no stale references
! git grep -nE '<old paths / namespaces of this step>' -- . ':!artifacts'   # non-zero exit = stale refs; no `exit`, which kills an interactive shell (review-r2 F7)
```
The `tool` path check (inlined in `restructure-gates.sh`; stdlib only, no dotnet). **Measured on the current tree (round 4): 9 frontend anchors already resolve 0 times** (`mutations.py` `stale-user-hidden-response`, and 8 cases in `early-`/`middle-`/`recent-mutations.json`), because the uncommitted rewrite regenerated `js/**`. That is pre-existing and outside this plan; report it to the owner. So the gate is "no new failures": step 1 records the sorted output in `baselines/mutation-check.txt`, and every later run must add no line to it. Any missing `file`/`test_file`/default, or any anchor that newly stops matching, fails.
```bash
mutation_check() { python3 - <<'PY'
import glob, importlib.util, json, re, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('mutations', 'tests/runner/mutations.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)   # main() is guarded by __name__
defaults = set(re.findall(r"case\.get\('test_file', '([^']+)'\)", Path('tests/runner/mutations.py').read_text()))
cases = [('mutations.py', c) for c in m.CASES]
for f in sorted(glob.glob('tests/history/*-mutations.json')):
    cases += [(f, c) for c in json.load(open(f))]
bad = [f'default test_file missing: {d}' for d in defaults if not Path(d).is_file()]
for src, c in cases:
    if not Path(c['file']).is_file(): bad.append(f"{src}:{c['name']}: file missing {c['file']}"); continue
    if c.get('test_file') and not Path(c['test_file']).is_file(): bad.append(f"{src}:{c['name']}: test_file missing {c['test_file']}")
    n = Path(c['file']).read_text().count(c['before'])
    if n != 1: bad.append(f"{src}:{c['name']}: anchor occurs {n}x in {c['file']}")
print('\n'.join(sorted(bad)))
PY
}
# step 1:   mutation_check | LC_ALL=C sort > artifacts/restructure-plan/baselines/mutation-check.txt
# gate:     new=$(mutation_check | LC_ALL=C sort | LC_ALL=C comm -13 artifacts/restructure-plan/baselines/mutation-check.txt -); [ -z "$new" ] || { echo "$new"; false; }
```
All gates are also wrapped as `scripts/restructure-gates.sh be|fe|r <pattern>|h|inv|tool|bundle` (added in PLAN.md step 1), which runs them in a subshell with `set -e` and exits non-zero on the first failure; prefer it (review-r2 F7).
`verify:rewrite` is what `.github/workflows/rewrite-validation.yml` runs in CI (`npm run verify:rewrite` → `scripts/client-verify.mjs`). Whether it also runs the dotnet tests is **unverified**, so run T explicitly.
Every step ends with **B, G, T, F, R, INV, TOOL** green. **G must show the route/auth snapshot unchanged with no `JE_UPDATE_SNAPSHOTS`.**

### Precondition
The ~656 uncommitted rewrite changes are committed by their owner (the plan never touches them). Every step branches from that commit.

### Phase 0: gates (sequential)
| Step | Content | Parallel? |
|---|---|---|
| **S0** | Add the `tests/backend/Architecture/` gates: RouteAuthSnapshot (A), AuthHelperCallSnapshot (B), ServiceRegistrationSnapshot (multiset + per-ServiceType order, §2), `ServicesDoNotReadUserTests` (§3), `ControllerActivationTests` (§6 R5: resolves every controller type in the plugin assembly with `ActivatorUtilities`), FeatureBoundaryTests (report-only, §7) and FileSizeTests (report-only). Generalise `ApiRoutingTests.AssetActivator` and `ApiAssetTests.Controller` to any controller `Type`. Extend the anonymous/private routing theories to every snapshot entry (C). Replace `typeof(JellyfinEnhancedController).Assembly` (**6 test sites**: ApiRoutingTests:51, ElsewhereDocumentTests:88, ApiItemLookMutationTests:91,182, ApiAssetTests:133,137; the last two are manifest-resource lookups) with `typeof(Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced).Assembly`. **Inventory generator (review-r3 #1, before any move):** `tests/inventory/generate.py:55` extracts routes only when `category == 'Controllers'`, so after any move the routes vanish from `tests/docs/production-inventory.json` and `features-api-routes-docs.test.mjs` fails against `docs/advanced/api.md`. Change it to extract routes from every `.cs` file under the plugin that declares a class whose name ends in `Controller` (`(?:public\s+)?(?:sealed\s+|partial\s+)*class\s+\w+Controller\b`), so `Features/<F>/Je<F>Controller.cs`, its partials (`JeMediaTagsController.Admin.cs`, which has no base list) and classes deriving from `JeControllerBase` (which the current `:\s*(?:ControllerBase|Controller)\b` regex would miss) are all found. Keep the class-level `[Route]` lookup per declaration, defaulting to `JellyfinEnhanced`; `JeControllerBase` contributes nothing (name doesn't end in `Controller`, no `[Http*]`); `SpoilerBlurImageFilter.cs` (an `[HttpGet]` in a comment, no `("`) stays excluded. Update the generator self-test fixture in `tests/runner/tests/test_regression.py:121-160` (builds `Controllers/Feature.cs`) with a second controller under `Features/X/` and a partial without a base list. Regenerate once: the route list must equal `baselines/inventory-routes.txt`, recorded right after the PLAN base-prep (202 routes on 2026-11-08). Diff against it with gate INV; do not re-save it (review-r6 #3). Run gate **TOOL** (`python3 tests/run.py tooling` + path check) before and after the generator/fixture edit; the test count must not drop below `baselines/tooling-tests.txt` (review-r4 #1). Use a required `public\s+` in the new class regex (review-r4 note) and keep capture group 1 `((?:\[[^\n]+\]\s*)*)` in front of it, because L58 reads `declaration[1]`. Note the other `typeof(JellyfinEnhancedController)` method lookups (ApiAssetTests:15, ApiMediaTagsPageTests:382, BootstrapContractTests:171, ElsewhereDocumentTests:701–702): each Phase-2 step that moves the named action repoints them to the new controller. Generate the snapshots once. | sequential (base for everything) |

### Phase 1: pure file moves (`git mv`, namespaces unchanged, no controller edits)
C# doesn't need folder and namespace to match, so these steps change no compiled output. They are **conflict-free and can run in parallel worktrees**: each one touches a disjoint set of files (checked against the path-reader list above). Merge in any order, then run B/T/F once on the merged result. **"Conflict-free" holds only within this plan** (review-r1 F3): P1-e shares files with frontend B2 (P1-e goes first), and P1-f shares files with frontend A3 (A3 goes first). Follow the combined order in `PLAN.md`.

| Step | Moves (see §2 table) | Path readers to update | Parallel? |
|---|---|---|---|
| **P1-a** | Catchup, Activity, Bookmarks (service into `Services/`) | none | ∥ |
| **P1-b** | SpoilerGuard (15 services, event, task) | none found | ∥ |
| **P1-c** | Seerr (services, Helpers/Jellyseerr, Model/Jellyseerr, 3 tasks) | tests/runner/mutations.py (ParentalTagDecision); gate TOOL | ∥ |
| **P1-d** | DetailsProviders (+ `ReviewAuthorCacheInvalidator` split out of UserTopologyEvents.cs into a new file) | none found | ∥ (P1-g also edits UserTopologyEvents.cs: **run P1-d's split inside P1-g instead**) |
| **P1-e** | MediaTags (TagCache* partials together, Status*, PosterTags/** subtree, tag helpers/models/tasks) | gen-resolution-data.mjs L20 (path only), generate_quality_compact.py, tag-data.mjs, generate_technical_ratios.py, build_poster_assets.py comments, tag-data.test.mjs, boundary.test.mjs, runtime-generators.test.mjs, poster-colours.test.mjs, colours-expected.mjs, core-tag-pipeline, rating-sources, source-edition-tags, bootstrap-media-tags-portable, tests/runner/tests/test_regression.py (L82), **tests/history/backend-mutations.json** (NativeClientPolicy.cs `file`), **`.github/workflows/regression.yml:215`** (add `Features/MediaTags/\|Shared/\|Infrastructure/` inside the `Jellyfin\.Plugin\.JellyfinEnhanced/(…)` group, keeping the old alternatives; review-r4 #3), PosterTagParity/Program.cs:1 comment; gate TOOL | ∥ |
| **P1-f** | Admin + MediaTags admin (`MediaTagsPageFields.cs` → `Features/MediaTags/Admin/`) + Chrome + Settings + HiddenContent services. Runs **after frontend A3** (PLAN.md step order) because its path readers are the admin-tags tests A3 renames | admin-tags-declarations.mjs, admin-tags-rewrite.test.mjs (+json), admin-config-rewrite.test.mjs, admin-tags-page-server.test.mjs, helpers/admin-tags-page.mjs | ∥ |
| **P1-g** | Shared/ + Infrastructure/ (Arr, Library, Media, Text, UserHelper, Identity, Extensions, UserTopologyEvents split into 3 files) + Platform services/models/tasks | ClientContracts.csproj (ArrInstance, AnalyticsData), bootstrap-manifest.test.mjs, tests/frontend/README.md, generate_config_flag_groups.py, core-media-language.test.mjs, tests/runner/mutations.py (UserHelper, RequestIdentityService), tests/inventory/generate.py (StartupService path only; route discovery already fixed in S0), tests/docs/coverage-matrix.md; **tests/history/backend-mutations.json** (CdnAssetService.cs, ArrUrlGuard.cs `file`); `production-inventory.json` is regenerated by the step (then checked by gate INV), never hand-edited; gate TOOL | ∥ (P1-c also edits mutations.py, on different lines; trivial merge, or fold P1-c's line into P1-g) |

Check per Phase 1 step: B, T, F, R, plus `git diff -M --stat` shows only renames (100% similarity) for .cs files. **Exception: P1-g's split of `UserTopologyEvents.cs`** (review-r2 F8). Check it instead: strip `using` and `namespace` lines from the original (`git show restructure-base:<path>`) and from the three new files, then `diff` the original against the concatenation of the three (in original class order); it must be empty apart from blank lines.

### Phase 2: controller extraction (SEQUENTIAL: every step edits JellyfinEnhancedController.cs and PluginServiceRegistrator.cs)
Each step:
1. Create `Features/<F>/Je<F>Controller.cs : JeControllerBase` with `[ApiController][Route("JellyfinEnhanced")]`.
2. **Cut** the feature's actions, nested DTOs and private helpers used only by this feature from the main controller, verbatim.
3. Give the new controller a constructor with only the dependencies it uses.
4. Change the namespace of the feature's files to `…Features.<F>[.Services|.Models|.Tasks|.Events]` and fix the `using`s.
5. Create `<F>ServiceRegistration.cs` and replace the feature's lines in `PluginServiceRegistrator` with `services.AddJe<F>()`, **at the position of the first moved line**, keeping the lines' original relative order inside it. Event consumers stay in `EventConsumerRegistration` (§2 item 4). The registration gate (multiset + per-ServiceType order) must stay identical.
6. Move and rename the feature's tests (§5).
7. Update the generators and harnesses for namespace changes.
8. Turn on FeatureBoundaryTests enforcement for this feature.

Steps go from smallest and most isolated to largest. Rebase each step onto the previous one.

| Step | Feature | Routes | Shared helpers to resolve first | Extra readers |
|---|---|---:|---|---|
| **S2.0a** | Infrastructure (base class only) | 0 | Introduce `JeControllerBase` with the controller-bound helpers moved verbatim: `IsAdminUser`, `AuthorizeUserConfigAccess`, `AuthorizeUserAccess`, `GetCurrentUserId`, **plus `CreateReviewVisibilityContext` (L8301, used by DetailsProviders and MediaTags) and `LoadRevisionedSettings` (L5738, used by Settings and Platform)**, which read `User`/`IsAdminUser()` and so must stay controller members (review-r1 F2). Their non-`User` dependencies `_userManager`, `_logger`, `_userConfigurationManager` become `protected readonly` base fields **with the same names** (sketch below); `CreateSettingsDefaults` moves to static `Features/Settings/Services/SettingsDefaults.Create()` (review-r2 F3); the bodies stay verbatim. Gates A and B and the registration snapshot must be unchanged | `features-admin-tags-page-overview-layout.test.mjs:230` (repoint + not-found guard), `features-admin-config-schema.test.mjs:73-76` (guard only) |
| **S2.0b** | Infrastructure (helper extractions) | 0 | Move the Seerr static caches (L91–160) and `ClearAllSeerrCachesOnConfigChange` into a `static class Features/Seerr/Services/SeerrCaches`; leave a forwarding static on the controller for the 7 test call sites. Extract `ResolveUserDisplay` → `Shared/Library/UserDisplayResolver`; `WarnIfArrInstancesCorrupt`, `FetchSeriesInfoFromInstance`, `FetchMovieInfoFromInstance`, `GetRootFolderFromPath` → `Shared/Arr/ArrInstanceClient`; `IsAllowedUrl(Async)` → `Shared/Arr/ArrUrlGuard`; `TryParseIso` → `Shared/Text/IsoDates`; `FindLibraryItemByTmdb` → `Shared/Library/LibraryItemLookup`. **None of these may read `User` or call `IsAdminUser()`** (checked: they don't). Move the MVC filter block to `Infrastructure/Hosting/MvcFilterRegistration.cs` | — |
| **S2.1** | Catchup | 3 | none (rename `CatchUpController` → `JeCatchupController`) | — |
| **S2.2** | Activity | 1 | none | — |
| **S2.3** | Bookmarks | 6 | uses `AuthorizeUserConfigAccess` (base) | — |
| **S2.4** | *(retired; review-r1 F1)* | 0 | The 7 former AdminTags routes move with MediaTags in **S2.11**. The number is kept so later step IDs don't shift | — |
| **S2.5** | Calendar | 3 (+`items/by-providers`) | `GetRootFolderFromPath` (done in S2.0b) | — |
| **S2.6** | Chrome | 6 | `BuildActiveSessionList` → `Features/Chrome/Services/ActiveSessionsService` (Platform→Chrome allowed) | — |
| **S2.7** | Admin | 12 | `ConfigurationPatchRequest` becomes a top-level type in `Features/Admin/Models`; update 8 test references | — |
| **S2.8** | Settings | 8 | `LoadRevisionedSettings` is **already on `JeControllerBase`** (S2.0a; it calls `IsAdminUser()` and is used by both Settings and the Platform bootstrap at L4322, so it can't be a service or a private Settings method); `SettingsDocumentService` only moves namespace; `BuildHcDefaultSettings` → `Features/HiddenContent/Services/HiddenContentDefaults` | **generate_per_user_props.py, features-admin-config-schema.test.mjs** (its `reset-all-users-settings`/`BuildHcDefaultSettings` anchors move now; overview-layout was already repointed in S2.0a): point them at the new files; re-run the generator and confirm `client/src/admin/config/per-user-props.ts` is unchanged. Update the `Services.` qualifier in `JeControllerBase.LoadRevisionedSettings` (`new Services.SettingsDocumentService(...)`) to the new namespace (review-r3 #5) |
| **S2.9** | HiddenContent | 10 | `LoadUserHiddenContentDocument` → HiddenContent service (Platform bootstrap uses it) | — |
| **S2.10** | Downloads | 5 (4 methods) | `GetJellyseerrUser` (Seerr) → `Features/Seerr/Services/SeerrUserLookup` (Downloads→Seerr allowed). `ParentalBlockedResult` (L763) calls `ControllerBase.StatusCode`, so it can't go into a service verbatim: move it in this step to `JeControllerBase` as `protected`, body verbatim (review-r2 F4) | — |
| **S2.11** | MediaTags (13 public + 7 admin = 20) | 20 | Public routes → `JeMediaTagsController.cs`; the 7 admin routes → partial `JeMediaTagsController.Admin.cs`. `PreviewBody` stays a private controller method (shared by both partials). `CreateReviewVisibilityContext` is **already on `JeControllerBase`** (S2.0a, because it calls `User`/`IsAdminUser`); only the `ReviewVisibilityContext` DTO moves to `Shared/Reviews/` (with Helpers/ReviewVisibility.cs). Static `_tagCacheJsonOptions`/`_tagCacheSerializationGate` move with `tag-cache/{userId}` | namespace change → **H**, gen-resolution-data.mjs L260, generate_quality_compact.py template, tests/poster harnesses |
| **S2.12** | DetailsProviders | 28 | `ReviewPayload`, `TranslateRequest` (test ref) | — |
| **S2.13** | SpoilerGuard | 19 | `AddSpoilerBlurPendingInternal` → `Features/SpoilerGuard/Services/SpoilerPendingService` (Seerr→SpoilerGuard allowed; Seerr already uses `SpoilerSeerrRedactor`). **Done as `Shared/SpoilerGuard/SpoilerPendingService`**, with the cross-feature policy services moved to `Shared/SpoilerGuard/` (§7.7); `SpoilerApplyExistingTitlesTask` keeps `…ScheduledTasks` (§7.8) | — |
| **S2.14** | Seerr | 63 | **First (§7.7):** `SeerrParentalFilter`, injected into Downloads, → `Shared/Parental/` as a pure rename (still registered where it is); resolve the other Downloads/Admin → Seerr references the same way or as static helpers in `Shared/`; the 3 Seerr task types keep `…ScheduledTasks` (§7.8). Header region (L1–1252) moves wholesale. Split into partials `JeSeerrController.{Status,Discover,Requests,Users,Tmdb,Issues}.cs` to stay under the size cap. Remove the forwarding `ClearAllSeerrCachesOnConfigChange` and update the tests. Repoint the `tests/history/backend-mutations.json` case whose anchor is `content = StripAdvancedRequestOptions(content);` (today `Controllers/JellyfinEnhancedController.cs` L954, with `StripAdvancedRequestOptions` at L843) to whichever `JeSeerrController*.cs` partial holds it, keeping the anchor text identical; gate TOOL (review-r4 #2) | — |
| **S2.15** | Platform | 18 | Rename what's left of `JellyfinEnhancedController` → `Features/Platform/JePlatformController`, delete `Controllers/`. Bootstrap aggregates the other features (Platform may depend on every feature's `Services`) | grep confirms no `JellyfinEnhancedController` remains; update `JellyfinEnhanced.cs:399` `Controllers.JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange` to its new type (review-r3 #5) |

### Phase 3 (sequential)
| Step | Content | Parallel? |
|---|---|---|
| **S3** | Enforce guardrails (§7): flip FeatureBoundaryTests and FileSizeTests from report to fail; FolderNamespaceTests; delete empty `Services/`, `Helpers/`, `Model/`, `ScheduledTasks/`, `EventHandlers/`, `Extensions/`; update CONTRIBUTING.md, docs/rewrite/*.md (e.g. the `--filter FullyQualifiedName~Privacy` example), tests/backend/README.md, and the `jellyfin-enhanced` skill notes | sequential |

Total: **24 steps** (S0, P1-a…g = 7, Phase 2 = 16: S2.0a, S2.0b, S2.1–S2.3, S2.5–S2.15 (S2.4 retired), S3). The combined backend+frontend order, gates and rollback are in `PLAN.md`.
**Real-host checkpoints (mandatory, review-r1 F4):** after S2.0b, after S2.5, S2.9 and S2.13 (≈ every 4 Phase-2 steps), and after S2.15. Procedure is `PLAN.md` gate **HOST**. The full smoke test after S2.15 additionally: loads the plugin into a disposable jf12 server, open the admin page, a details page, Seerr discover and a Media Tags poster, check `GET /api-docs/openapi.json` returns 200, and confirm the JE scheduled tasks are listed under their original names.

---

## 5. Tests layout

Today: `tests/backend/{Api,Core,Integrations,Persistence,PosterTags,Privacy,ScheduledTasks,Support}`. Namespaces are mixed (`JE.Tests`, `JellyfinEnhanced.Tests`).
Target mirrors the plugin:
```
tests/backend/
  Architecture/   RouteAuthSnapshotTests, AuthHelperCallSnapshotTests, ServiceRegistrationSnapshotTests,
                  FeatureBoundaryTests, FileSizeTests, FolderNamespaceTests, *.snapshot.json
  Features/<Feature>/...        namespace JE.Tests.Features.<Feature>
  Shared/...  Infrastructure/... (Persistence/ → Infrastructure/Persistence/)
  Support/        unchanged (fixtures)
```
Indicative mapping (confirm per file in each step):
- `Api/ApiSeerr*`, `SeerrCsrfHandlerTests`, `SeerrRequestOutcomeContractTests`, `ScheduledTasks/TaskSeerrSync*`, `TaskAutoRequest*`, `Integrations/IntegrationTmdb*`, `IntegrationCompanyDiscover*`, `IntegrationWatchProviders*` → **Seerr**
- `PosterTags/*`, `Core/CoreTag*`, `CoreLanguageTag*`, `CoreNativeDateContext*`, `CoreAwards*`, `Api/ApiMediaTags*`, `ApiItemLookMutation*`, `Integrations/IntegrationStatus*`, `NativeScenesInvalidation*`, `IntegrationAwards*` → **MediaTags**
- `Privacy/*` → **SpoilerGuard**, except `PrivacyHiddenContentTests` → HiddenContent, `ReviewActivityVisibilityTests` → DetailsProviders and `UrlPolicyTests` → Shared
- `Api/BookmarkDocumentTests` → Bookmarks
- `ElsewhereDocumentTests`, `ApiReviewTranslationTests`, `Integrations/IntegrationMdblist*`, `IntegrationAnilist*`, `IntegrationReviewTranslation*`, `IntegrationItemStats*` → **DetailsProviders**
- `Core/CoreMaintenance*`, `CoreWhatsNew*`, `Api/ApiConfigurationTests`, `SettingsPreservationTests` (unverified: may be Settings) → **Admin**
- `RevisionedSettingsTests` → Settings
- `ApiBrandingTests` → Chrome
- `Integrations/IntegrationCalendar*` → Calendar
- `Api/ApiAssetTests`, `ApiCdnRefreshTests`, `ApiMiddlewareTests`, `BootstrapContractTests`, `Core/CoreUsage*`, `CoreHostCompatibility*`, `IntegrationAnalytics*` → **Platform**
- `ApiRoutingTests`, `ScheduledTasks/TaskMetadata*`, `TaskVisibility*`, `TaskRegression*` → **Architecture** (cross-cutting)

**Move tests in the same Phase 2 step as their feature, not in Phase 1.** The namespace change in Phase 2 forces `using` edits in those tests anyway, and keeping them in one step lets `--filter FullyQualifiedName~JE.Tests.Features.<F>` run as the step's focused check. Don't move tests in Phase 1: it would double the churn, and Phase 1 must stay pure renames.
Check per step: the total test count printed by `dotnet test` must equal the previous step's count. Record it in the step's PR description.
Fixtures under `tests/fixtures/*` are embedded by `LogicalName` in `JE.Tests.csproj`, so they don't move.

---

## 6. Risks and mitigations

| # | Risk | Evidence | Mitigation |
|---|---|---|---|
| R1 | **Route collisions or precedence changes** after the split. In particular, the catch-all `GET {viewName}` (L13927) could start shadowing or ambiguating literal routes, and duplicate templates would throw `AmbiguousMatchException` at runtime, not at build | `{viewName}`, `js/{**path}`, `cdn/{source}/{**path}`, `tmdb/{**apiPath}`, `jellyseerr/{type}/{serverId}` vs `jellyseerr/settings/{type}` | Attribute routing ranks routes globally across controllers, so precedence shouldn't change **(verify with Gate A + C)**. Gate C issues a real request for every snapshot entry, with a sample value per parameter, and asserts that the resolved `actionName` matches the snapshot. That catches shadowing and ambiguity |
| R1b | Partial-class split errors | `TagCacheService` has 8 partial files; `JellyseerrWatchlistSyncTask` and `ClearTranslationCacheTask` are partial | Move all parts of a partial in the same commit, with the same namespace. B fails fast if not |
| R2 | **Private helpers shared across endpoints** get duplicated or diverge | 32 helpers used by ≥2 features (table in §1) | Extract them in S2.0a/S2.0b or in the first step that needs them, **verbatim**, into Shared/ or the owning feature's service. Never copy-paste. FeatureBoundaryTests block hidden re-coupling |
| R3 | **Static state** gets duplicated per controller (e.g. two `_avatarCache`s), or gets reset | 16 static fields listed in §1; `ClearAllSeerrCachesOnConfigChange` is public static and called by tests | Move each static field with its only users. Fields used by several features move to a single `static class` in the owning feature (`SeerrCaches`). A grep check in R: `grep -c 'static readonly' Features/*/Je*Controller*.cs` is reviewed per step |
| R4 | **Frontend-visible serialization changes** | Nested DTOs become top-level types. The client contracts in `client/src/contracts/{generated,schema,bootstrap}.ts` come from `tools/ClientContracts` (Transport/Configuration types, which **don't move**) | Moving a type doesn't change STJ property names, but don't rename properties or add `[JsonPropertyName]`. `npm run contracts:check` + `test:contract-boundary` + `BootstrapContractTests` in every step. Keep DTO type names unique with a feature prefix if OpenAPI schema IDs collide **(unverified whether Jellyfin uses full names)** |
| R5 | **Plugin load or DI breakage**: a moved controller's constructor asks for an unregistered service. That shows up only at request time, not at build | MVC activates controllers per request | Add an Architecture test that builds the plugin's `ServiceCollection` (as in the registration snapshot) plus the host fakes from `Support/ApiPluginFixture.cs`, and resolves every `Je*Controller` with `ActivatorUtilities.CreateInstance`. Plus the smoke test after S2.15 |
| R6 | **MVC filter, startup filter or hosted-service order** changes when registration is split | L33–34, L94–95, L210–222 | Filter block stays verbatim in one file (`MvcFilterRegistration`). ServiceRegistrationSnapshot compares registration order **and** the resolved `MvcOptions.Filters` order (§2 DI) |
| R7 | **Scheduled-task identity changes** (Jellyfin keys a task's trigger config by `IScheduledTask.Key`; it may also persist the type name) | 15 tasks under ScheduledTasks/ | Never change `Key`, `Name` or `Category`. `TaskMetadataTests` already exists; extend it to snapshot `Key`+`Name` for all tasks. Type-name dependence of persisted triggers is **unverified**: check it in the smoke test |
| R8 | **Path and namespace readers outside C#** break silently or generate files into old folders | list in §2 | Each step's **R** grep plus F and H. Generators gain a `--check` run in that step |
| R9 | **Merge conflicts with the in-flight rewrite**: 656 uncommitted changes, many probably in the controller | `git status --short \| wc -l` = 656 | Precondition commit. Phase 1 is renames only (git follows them). Phase 2 is sequential, one feature per PR, rebased promptly |
| R10 | Admin and current-user resolvers get "harmonised" by an eager agent | Two resolvers (§3) | Briefs forbid it. Gate B counts helper calls per action |
| R11 | `ApiRoutingTests` activator only knows the old controller | L22–30 | Fixed in S0 |
| R12 | Embedded resources move by accident | csproj `EmbeddedResource LogicalName=…` for Assets/, PluginPages/, Configuration/*.html,*.js | Only `.cs` files move. Configuration/ stays. `ApiAssetTests` proves every resource is still served |

---

## 7. Guardrails against regrowth (enforced in S3; report-only from S0)

1. **File size:** `FileSizeTests` fails when any `*.cs` under `Jellyfin.Plugin.JellyfinEnhanced/Features/**` or `Shared/**` exceeds **1,500 lines**, or any `Je*Controller*.cs` file exceeds **1,200 lines**. Generated `*.g.cs` files are exempt. Start with an explicit allow-list of current offenders (e.g. `TagCacheService.cs` 4,123, `PosterTagSettings.cs` 1,384, `SpoilerFieldStripFilter.cs` 1,408, `SpoilerBlurImageFilter.cs` 1,370, `SeerrParentalFilter.cs` 1,393, `PosterTagRenderer.cs` 1,078). The allow-list may only shrink.
2. **Feature boundaries:** `FeatureBoundaryTests` uses reflection only, with no extra analyzer package. For every type in namespace `…Features.<A>`, it collects referenced types (constructor parameters, fields, properties, method parameters and return types, plus IL member references via `Module.ResolveMember` on method bodies, reusing the Gate B decoder). It fails when a type in `Features.<A>` references a type in `Features.<B>` that isn't on the allow-list in `tests/backend/Architecture/feature-dependencies.json`.
   - Controllers may reference only their own feature plus `Shared`/`Infrastructure`/`Configuration`/`Transport`/`Logger`.
   - Services follow the allow-list. Initial allow-list, from the evidence above:
     - `Downloads→Seerr`, `Seerr→SpoilerGuard`
     - `SpoilerGuard→MediaTags` (TagCacheEntry, TagQualitySummary), `SpoilerGuard→HiddenContent` (HiddenContentResponseFilter usage)
     - `MediaTags→DetailsProviders` (WikidataAwardsService, MdblistService ratings)
     - `Platform→*`
   - A new edge requires editing the JSON in the same PR, so the reviewer sees it.
   - **Round 13 (review G1):** types are attributed to a feature or layer by the **folder** of their source file, not by namespace (`tests/backend/Architecture/SourceFolders.cs`), for this rule and for the M2 Shared/Infrastructure ratchet. Scheduled-task types and `StartupService` (§7.8) are scanned as members of their folder's feature. The edges this made visible are type-scoped `allowType` entries (`StartupService`, `MdblistRatingsFetchTask`); CHANGELOG R13-a.
3. **Folder = namespace:** `FolderNamespaceTests` fails when a file under `Features/<F>/` declares a namespace other than `…Features.<F>[.*]` (round 13: also `Shared/<Area>/` → `…Shared.<Area>[.*]` and `Infrastructure/<Area>/` → `…Infrastructure.<Area>[.*]`, no exemptions; CHANGELOG R13) (exempt: `IScheduledTask` types in `…ScheduledTasks`, item 8), or when any `.cs` file is added to the retired folders `Services/`, `Helpers/`, `Model/`, `ScheduledTasks/`, `EventHandlers/` or `Controllers/`.
4. **Naming:**
   - Feature folders = the `backend` column of `docs/feature-map.json` (canonical table in `PLAN.md`). The parity test reads that file, not a kebab→Pascal rule, so `settings-panel`, `player`, `shared`, `Admin` and `Platform` need no special cases.
   - Controller = `Je<Feature>Controller`, with optional partials `Je<Feature>Controller.<Area>.cs`.
   - Registration = `<Feature>ServiceRegistration.Add<…>`.
   - Tasks end in `Task` and live in `Tasks/`. Event consumers live in `Events/`.
   - Routes stay under `[Route("JellyfinEnhanced")]` with no feature prefix change (changing a route = contract change = snapshot update).
5. **One controller per feature:** a test asserts that each `Features/<F>` contains at most one controller type (partials allowed).
6. **Docs:** add a 10-line "where things live" table to `CONTRIBUTING.md` that names, for each feature, the client folder, the backend folder and the test folder.
7. **Cross-feature helpers go to `Shared/<area>/` (coordinator decision, step 7).** When a feature controller needs a helper another feature owns, and a step's namespace change would make `FeatureBoundaryTests` fail, the helper moves to `Shared/<area>/` as a pure rename (or, for a new extraction, is created there) in that step. The controller rule is never widened and no allow-list entry is added. Moves so far:
   - **S2.8:** `BuildHcDefaultSettings` → `Shared/HiddenContent/HiddenContentDefaults` (not `Features/HiddenContent/Services/`, the §4 row's target). Settings' `reset-all-users-settings` and HiddenContent's `hidden-content.json`/continue-watching routes both call it, and the Settings controller is enforced from S2.8.
   - **S2.9:** `Features/HiddenContent/Services/HiddenContentResponseFilter.cs` → `Shared/HiddenContent/HiddenContentResponseFilter.cs` (`git mv`, namespace `…Shared.HiddenContent`, body unchanged). The enforced Settings controller calls its static `InvalidateUser` after `reset-all-users-settings` and `apply-user-settings`, so renaming HiddenContent's namespace would have made that a controller → HiddenContent finding. It is still registered by `AddJeHiddenContent()`, and its MVC filter position is unchanged (`MvcFilterRegistration`). The `SpoilerGuard → HiddenContent` allow-list edge is now unused, and it was left in place.
   - **S2.11–S2.12** (step 8): `MediaTagsPageFields`, `MediaTagsPortable`, `SeriesQualityAggregation`, `PluginConfigurationPatch` → `Shared/MediaTags/`; `ReviewVisibility` + top-level `ReviewVisibilityContext` → `Shared/Reviews/`; `ProviderHelper` → `Shared/Arr/`; `MdblistService`'s static `IsListId`/`ParseList` → `Shared/MediaTags/AwardLists` (all pure renames or verbatim static extractions). `AggregateVisibleReviewRatings`, `IsReviewVisibleToViewer` and `ResolveReviewAuthor` read `User`, so they went to `JeControllerBase` (`protected`, verbatim) instead.
   - **PublicApi (S2.11):** a feature-owned **stateful** service that another feature needs (e.g. `TagCacheService`) stays in its feature; the other feature calls a static forwarder in `Features/<B>/PublicApi/` (`MediaTagsApi.TagCache.OnLogoSettingsChanged`/`OnRatingSourceSettingsChanged`). `FeatureBoundaryTests` allows a reference into another feature's `…Features.<B>.PublicApi` namespace and marks the edge `(PublicApi)`; anything else in `Features.<B>` is still a finding. **Round 13:** the rule is applied to static reaches only: a feature calling another feature's stateful service through a static (`X.Instance`, static members) uses a forwarder (`MediaTagsApi.TagCache.RefreshRatingSourceAvailability` for `MdblistRatingsFetchTask`). A constructor-injected dependency cannot become a static forwarder without changing DI, so it stays a visible `allow`/`allowType` entry (`StartupService`; `SpoilerIdentityTagFilter` → `NativePosterTagStamper`; `AwardTagsService`/`TagCacheService` → `MdblistService`, `WikidataAwardsService`). Forwarders whose target moved to `Shared/` (`MediaTagsApi.LeavingSoon`, `MediaTagsApi.TagStyles`) were retired; callers use the Shared type. Backend PublicApi exists for Bookmarks, MediaTags, Seerr and SpoilerGuard.
   - **Cross-cutting policy services go to `Shared/<Policy>/` (coordinator decision, step 8, option B).** A *policy service* enforces one rule across several features (spoiler protection, parental filtering and the like). When another feature's constructors receive such a service, it moves to `Shared/<Policy>/` as a **pure rename**: same class names, no logic edits, no DI registration changes (it stays registered by its feature's `Add<Feature>()`), registration snapshot unchanged. The feature's own controller, endpoints and feature-only code stay in `Features/<Feature>/`. This differs from the PublicApi rule, which still covers feature-owned stateful services such as `TagCacheService`: those are one feature's data, not a rule other features must apply. **S2.13:** `SpoilerSeerrRedactor` (+ nested `GuardedRows`, `RowPolicy`), `SpoilerUserResolver`, `SpoilerIdentityService`, `SpoilerTagDataStripper` (+ `SpoilerTagStripPolicy`, `SpoilerTagDataStub`) and the static `ImageTagDecoration`/`ImageTagParts` → `Shared/SpoilerGuard/` (Calendar, Downloads, DetailsProviders and MediaTags inject or call them). The new `SpoilerPendingService` (the §4 row's `AddSpoilerBlurPendingInternal` extraction) is created there too, not in `Features/SpoilerGuard/Services/`, because the Seerr request route calls it and S2.14 makes that a controller → SpoilerGuard reference. **S2.14 (done, step 9; coordinator decision D3):** `SeerrParentalFilter`, injected into Downloads, → `Shared/Parental/` (still registered where it was), with its stateless decision helpers `ParentalRatingDecision`, `ParentalTagDecision`, `SeerrCertificationExtractor`, `SeerrTagSignatureExtractor`. Stateless helpers and DTOs → `Shared/Seerr/` (`SeerrHttpHelper`, `SeerrError`/`SeerrErrorCode`, `SeerrRequestOutcome`/`SeerrRequestOutcomes`/`SeerrProxyErrorResponse`, `JellyseerrPermission`, `JellyseerrPermissionHelper`, `JellyseerrUser`) and `Shared/Tmdb/` (`WatchProvidersBatch`); `SeerrUserLookup` and `SeerrCaches` (with `TmdbEnrichmentResult` and the *arr queue/history caches) → `Shared/Seerr/` (D3).
   - **Feature-neutral shared infrastructure services go to `Shared/<Area>/` (coordinator decision, step 9, option A).** A service qualifies when it is stateful, used by two or more features, received through DI or called statically, and owns no single feature's behaviour. It moves as a **pure rename**: no logic change, no registration change (it stays registered exactly where it was), registration snapshot unchanged. Examples: `TmdbResponseCache` (+ nested `TmdbResponse`) → `Shared/Tmdb/` (S2.14; Seerr's TMDB passthrough and person lookups and MediaTags' status/logo tags), `HostCompatibilityService` → `Shared/Host/` (S2.15; Admin and Platform). **S2.15 (coordinator decision D4):** `MaintenanceModeService` (+ `MaintenanceState`) → `Shared/Maintenance/` as a policy service (still registered by `AddJeAdmin()`); `ActiveSessionsService` → `Shared/Sessions/`, `HiddenContentDocumentService` → `Shared/HiddenContent/` (pure renames); static PublicApi forwarders `MediaTagsApi.LeavingSoon.Configured`, `BookmarksApi.Documents.Read`, `SpoilerGuardApi.AutoEnableFilter.AllowsType` and `SeerrApi.Status.*` for the Platform bootstrap and the Seerr request hook. Also in S2.15: `UsageEventCounterService` → `Shared/Analytics/` under the shared-infrastructure rule (stateful, received through DI by Platform and by HiddenContent's `ContinueWatchingPlaybackConsumer`, counts usage for every feature; still registered where it was), and the static forwarders `MediaTagsApi.TagStyles.{ParseIsEmpty,NormalizePreset}` (public-config) and `MediaTagsApi.NativeClients.BuiltInWebClients` (`AnalyticsReportingService`). `FeatureBoundaryTests` reports 0 findings with every feature enforced, also with the `Platform: ["*"]` allow-list entry removed (it is no longer needed). Feature-owned stateful services still go through PublicApi forwarders, and allow-list entries stay forbidden.
8. **Scheduled-task types keep their legacy namespace (coordinator decision, step 8).** Jellyfin 12.4 keys a task's saved triggers (`config/ScheduledTasks/<id>.js`) and last result (`data/ScheduledTasks/<id>.js`) by `ScheduledTaskWorker.Id` = MD5 of the task type's **full name**, and `/ScheduledTasks` returns that id. Renaming a task type's namespace would reset admins' schedules and history. So every `IScheduledTask` type keeps `Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks` while its file lives in `Features/<F>/Tasks/` (MediaTags 5, DetailsProviders 3, SpoilerGuard 1 so far; Seerr 3 in S2.14, Platform 2 in S2.15). **`StartupService`** (the "Jellyfin Enhanced Startup" task, file `Features/Platform/Services/StartupService.cs`) keeps its original namespace `Jellyfin.Plugin.JellyfinEnhanced.Services` for the same reason; S3's exemption must cover it (it is not in `…ScheduledTasks`). Helpers in `Tasks/` that are not tasks (e.g. `MdblistRatingsFetchRunner`) do move. **S3:** `FolderNamespaceTests` exempts types implementing `IScheduledTask` (namespace `…ScheduledTasks` only); `ScheduledTasks/` stays a retired folder for new files.
9. **Over-cap controllers (S3).** `JeDownloadsController` (1,421 lines), `JeMediaTagsController` (1,530) and `JeDetailsProvidersController` (1,499) exceed the 1,200-line controller cap. S3 splits them into partials by sub-area as a **pure move** (e.g. `JeDetailsProvidersController.{Reviews,Elsewhere,Ratings}.cs`), checked like a Phase-1 move; they are not added to the `FileSizeTests` allow-list.

---

## 8. Agent briefs (paste one per step)

Common preamble for every brief:
> Repo: jellyfin-enhanced-v12-rewrite, Jellyfin 12 only. Work in your own git worktree on branch `restructure/<step>` from `<base commit>`. **Move code verbatim**: no renames of actions, routes, parameters, JSON properties, task keys or log messages, and no logic changes, "cleanups" or resolver unification. Don't regenerate snapshots (`JE_UPDATE_SNAPSHOTS` must stay unset). Run `npm ci` and both `dotnet restore … -p:JellyfinTarget=jf12` once. Before you finish, run B, G, T, F, R from artifacts/restructure-plan/backend.md §4, all green, and report the test count. No containers, no real GitHub writes. Commit with a message `refactor(backend): <step>`.

**S0: gates.** Add `tests/backend/Architecture/` with RouteAuthSnapshotTests (EndpointDataSource over a TestServer built like `Api/ApiRoutingTests.cs` L43–51), AuthHelperCallSnapshotTests (IL scan incl. async MoveNext and one level of same-type private calls), ServiceRegistrationSnapshotTests (multiset + per-ServiceType order for multi-registered types, §2), `ServicesDoNotReadUserTests` (§3) and `ControllerActivationTests` (§6 R5), plus FeatureBoundaryTests, FileSizeTests and FolderNamespaceTests in **report-only** mode (write findings to test output, don't fail). Generalise `ApiRoutingTests.AssetActivator` and `ApiAssetTests.Controller` to construct `context.ActionDescriptor.ControllerTypeInfo`. Extend the two routing theories to all snapshot entries. Replace `typeof(JellyfinEnhancedController).Assembly` with `typeof(JellyfinEnhanced).Assembly` at all 6 sites listed in §4 S0. Generate the snapshots once and commit them. Expect 202 routes, 12 anonymous. Don't touch the plugin source.

**P1-a … P1-g: file moves.** Using `git mv` only, move the files listed for your step in §2/§4 to their `Features/…`, `Shared/…` or `Infrastructure/…` destination. **Don't change namespaces or any C# content** (exception: P1-g splits `EventHandlers/UserTopologyEvents.cs` into three files, one class each, content verbatim). Update every path reader listed for your step. If your step moves a file named in `tests/runner/mutations.py` or `tests/history/*-mutations.json`, rewrite that `file` field in place (no path map; leave `sources`/`evidence` alone). `git diff -M --stat` must show only renames for `.cs` files. Then run R with the old paths, and gates **INV** and **TOOL** (`scripts/restructure-gates.sh inv`, `scripts/restructure-gates.sh tool`).

**S2.0a: base class.** Create `Infrastructure/Http/JeControllerBase.cs` and move `IsAdminUser` (L5494), `AuthorizeUserConfigAccess` (L5443), `AuthorizeUserAccess` (L5468), `GetCurrentUserId` (L11570), `CreateReviewVisibilityContext` (L8301) and `LoadRevisionedSettings` (L5738) into it verbatim, as `protected`. Move `CreateSettingsDefaults` (L5618–5736) **verbatim** to a static `Features/Settings/Services/SettingsDefaults.Create()`: it reads only `JellyfinEnhanced.Instance` and the static `TagLayoutRules`/`TagLookValidation`/`LanguageTagDisplay`/`TagShapeRules.ApplyDefaults`, no `User` and no instance field (verified; stop and report if that is no longer true). `LoadRevisionedSettings` passes `SettingsDefaults.Create`; other callers of `CreateSettingsDefaults` are repointed. In the same step (review-r2 F3): repoint `tests/frontend/features/features-admin-tags-page-overview-layout.test.mjs:230-231` to `Features/Settings/Services/SettingsDefaults.cs`, and add a not-found guard (`assert.ok(start >= 0 && end > start)` plus `copied.length >=` the count measured before the move) there and in `features-admin-config-schema.test.mjs:73-76`. Otherwise `indexOf` silently falls through to the duplicate pair in `ResetAllUsersSettings` (L8930/L9036) and the test passes on different code. `generate_per_user_props.py` needs no guard (`str.index` raises). Make `JellyfinEnhancedController : JeControllerBase`. Nothing else. Gates A and B must be unchanged.

**S2.0b: helper extractions.** Extract into injected singletons or static classes, verbatim: `ResolveUserDisplay` → `Shared/Library/UserDisplayResolver`; the Arr helpers (`WarnIfArrInstancesCorrupt` L5538, `FetchSeriesInfoFromInstance` L11323, `FetchMovieInfoFromInstance` L11381, `GetRootFolderFromPath` L13331) → `Shared/Arr/ArrInstanceClient`; `IsAllowedUrl(Async)` → `Shared/Arr/ArrUrlGuard`; `TryParseIso` → `Shared/Text/IsoDates`; `FindLibraryItemByTmdb` → `Shared/Library/LibraryItemLookup`; Seerr statics L91–160 + `ClearAllSeerrCachesOnConfigChange` → `Features/Seerr/Services/SeerrCaches` (static), with a forwarding static left on the controller. Move the `Configure<MvcOptions>` block verbatim to `Infrastructure/Hosting/MvcFilterRegistration.cs`, and every `IEventConsumer<…>` registration, in original relative order, to `Infrastructure/Hosting/EventConsumerRegistration.cs` (§2 item 4). Gate B and the registration snapshot must be unchanged.

**S2.1 … S2.15: one feature.** Feature `<F>`, routes = the `<F>` table in §1 (§1 lists line numbers). Create `Features/<F>/Je<F>Controller.cs` (`[ApiController]`, `[Route("JellyfinEnhanced")]` — **except S2.1 Catchup: rename `CatchUpController` only and keep its class-level `[Route("JellyfinEnhanced/catchup")]` exactly** (review-r2 F9) — inheriting `JeControllerBase`, **no class-level `[Authorize]`**). Cut those actions, with their exact attributes and the nested DTOs and private helpers that only they use, out of `Controllers/JellyfinEnhancedController.cs`. Resolve the shared helpers named for this step in the §4 table first. **Never move a helper that reads `User` or calls `IsAdminUser()` into a service**; it stays a controller (or `JeControllerBase`) member. Repoint any `typeof(JellyfinEnhancedController).GetMethod(...)` test lookup for an action you move. Give the controller a constructor with only what it uses. Change the namespace of `Features/<F>/**` to `Jellyfin.Plugin.JellyfinEnhanced.Features.<F>…` and fix the `using`s across the solution, the tests and the `tests/poster` harnesses. Add `Features/<F>/<F>ServiceRegistration.cs` and replace the feature's lines in `PluginServiceRegistrator.cs` with one call at the position of the first moved line (event consumers stay in `EventConsumerRegistration`). Move the feature's tests to `tests/backend/Features/<F>/` (namespace `JE.Tests.Features.<F>`). Enable FeatureBoundaryTests enforcement for `<F>`, adding only the allow-list edges in §7. Route/auth snapshot, auth-helper snapshot and registration snapshot must be unchanged (registration compared namespace-insensitively). Regenerate `tests/docs/production-inventory.json` and commit it as part of the step (a step action), then pass gates **INV** (`--check` plus route list unchanged; the gate itself never regenerates, review-r4 #4) and **TOOL** (a moved action can move a mutation anchor). Step-specific notes are in the §4 row (e.g. S2.8 must repoint `scripts/generate_per_user_props.py` and one frontend test (`features-admin-config-schema`), fix the `Services.` qualifier in `LoadRevisionedSettings`, then re-run the generator with no diff; S2.11 must run **H**; S2.14 splits into partials ≤1,200 lines; S2.15 renames the remainder to `JePlatformController` and deletes `Controllers/`).

**S3: guardrails.** Turn FeatureBoundaryTests, FileSizeTests (with the shrinking allow-list) and FolderNamespaceTests to failing mode. Delete the now-empty legacy folders. Add the folder-name parity test against `docs/feature-map.json`. Update CONTRIBUTING.md (the "where things live" table), docs/rewrite/*.md test filters and tests/backend/README.md.
