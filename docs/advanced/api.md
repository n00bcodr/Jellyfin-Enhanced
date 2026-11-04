# Jellyfin Enhanced's API

Use Jellyfin Enhanced (JE)'s API to manage bookmarks, reviews, and personal settings, retrieve metadata, and work with integrations through HTTP(S) requests. Install and enable the plugin on your server first.

To use these APIs from a custom Jellyfin client, you need an HTTP client and a Jellyfin credential. You do not need the injected JE scripts.

This reference covers the 194 method/path entries in plugin version **12.14.0.0**. Use the endpoint tables to check access requirements, inputs, responses, and limits.

Paths in endpoint tables are relative to `/JellyfinEnhanced/`. Braces mark path parameters; replace them before making a request. The catch-all routes serve only the resources described below.

??? note "Which IDs to use"

    Reviews use author + media type + TMDB key as their identity. Bookmarks use bookmark IDs and contain a Jellyfin item ID, with optional TMDB/TVDB metadata.

    Seerr request, issue, user, and service IDs belong to Seerr; they are not Jellyfin GUIDs or TMDB IDs.

## Series and season quality summaries

`SeriesQualityAggregation` is an administrator default and per-user `settings.json` preference. Its fixed values are `representative` (default), `latest`, `best`, `shared` and `mixed`; unknown values normalize to `representative`. Null personal values inherit the admin default. The public configuration includes the normalized default; new-user seeding and resetting all users copy it.

Series and Season entries in `GET /JellyfinEnhanced/tag-cache/{userId}` and items in `POST /JellyfinEnhanced/tag-data/{userId}` include `QualitySummary`:

```json
{
  "EpisodeCount": 2,
  "Categories": {
    "resolution": { "Best": "4K", "Latest": "1080p", "Values": ["1080p", "4K"], "AllAgree": false },
    "dynamicRange": { "Best": "HDR10", "Latest": null, "Values": [null, "HDR10"], "AllAgree": false },
    "videoCodec": { "Best": "HEVC", "Latest": "H264", "Values": ["H264", "HEVC"], "AllAgree": false },
    "audioInfo": { "Best": "ATMOS 7.1", "Latest": "DTS 5.1", "Values": ["DTS 5.1", "ATMOS 7.1"], "AllAgree": false }
  },
  "AudioByLanguage": {},
  "AudioRegionFallback": {},
  "LatestExtras": []
}
```

Each category keeps at most four distinct values (including null for missing metadata). `Best`, `Latest` and `AllAgree` are computed over every episode independently of that bound. `AudioByLanguage` maps available track language codes and base-language fallbacks to audio category facts; clients select exact-region matches first, then `AudioRegionFallback` (generic tracks for an unavailable region), then the base language and `Categories.audioInfo`. `LatestExtras` contains source/special-format labels for the newest aired non-virtual episode. Unknown/future air dates cannot supply latest values.

The current persisted cache schema includes the summary and server-only `QualityEpisodeIds`. Contributor IDs never appear in either response. Access filtering rebuilds summaries from visible contributors and replaces representative streams when necessary; the existing `filterRevision` changes when visibility changes. Spoiler Guard removes the summary whenever it removes quality streams. Missing summaries support legacy representative fallback. Collections are unchanged.

## Quick Start: Normal User vs Admin

Start here to set up your URL and credential. Use a user token for personal data or administrator credentials for admin routes.

Set one base URL, including any Jellyfin or reverse-proxy base path and without a trailing slash:

```bash
JELLYFIN_URL='https://jellyfin.example.com/jellyfin'
JE_URL="$JELLYFIN_URL/JellyfinEnhanced"
TOKEN='YOUR_JELLYFIN_ACCESS_TOKEN_OR_API_KEY'
USER_ID='9285e8b54149414941494edb9e464dcd'
```

Every authenticated example uses the same header:

```bash
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/version"
```

!!! note "Jellyfin 12 and legacy authorization headers"

    Use `Authorization: MediaBrowser Token="…"` on both Jellyfin 12 and 10.11. Acceptance of legacy headers such as `X-Emby-Token` and `X-Emby-Authorization` is controlled by Jellyfin Server. Jellyfin 12 disables legacy authorization by default. JE does not require different header names for different features.

    Install the JE artifact built for your Jellyfin version; shared controller source does not guarantee identical host serialization.

### As a normal user

Log in as the user whose personal data you want to manage. Jellyfin's own `POST /Users/AuthenticateByName` returns `AccessToken` and a `User` object containing the user's `Id`. Supply client identification for this pre-login request:

```bash
curl -X POST "$JELLYFIN_URL/Users/AuthenticateByName" \
  -H 'Authorization: MediaBrowser Client="MyApp", Device="MyApp", DeviceId="my-app-1", Version="1.0.0"' \
  -H 'Content-Type: application/json' \
  --data '{"Username":"YOUR_USERNAME","Pw":"YOUR_PASSWORD"}'
```

Use the returned access token as `TOKEN`. You can manage your bookmarks and reviews, and read other authors' reviews that are visible to you. Caller-scoped actions always use the identity in your token.

### As an administrator

A Jellyfin administrator token or server API key can call administrator routes. Use explicit target-user routes to manage another user's bookmarks, documents, or reviews.

A server API key grants administrator authority but may lack an existing user identity. It does not impersonate a user for Seerr, Activity, or caller-scoped writes.

Use a consistent lowercase, 32-character hexadecimal GUID without dashes (N format) for user IDs. You can obtain a target user's ID from Jellyfin's user API or the `userId` in that user's dashboard profile URL.

Ordinary document routes also accept parseable dashed GUIDs and normalize them; admin review and dedicated admin Hidden Content routes require N format.

### Authentication and identity

Use the access label in each endpoint table to check which credential you need. Some routes also require an existing user account or a linked Seerr identity.

| Access label | Effective requirement |
|---|---|
| Anonymous | No JE authorization attribute. A reverse proxy can impose its own access rules. |
| Authenticated | Jellyfin accepts the credential; no additional caller-account check unless stated. |
| Own/admin | Target is the token's user, or the principal has the `Administrator` role. Malformed document user IDs return `400`; cross-user denial returns `403`. An empty GUID falls back to the caller. |
| Caller | Uses the token's `Jellyfin-UserId` claim; there is no target-user override. Most writes require a nonempty ID. |
| Administrator | The principal has the `Administrator` role, or its resolved Jellyfin account has administrator permission. |
| Seerr-linked | Authenticated caller with a parseable user-ID claim and a linked Seerr identity, plus the stated permissions and setup. |

??? note "Account checks by route"

    - Bootstrap requires only a parseable user-ID claim, even an empty GUID; it does not verify an existing account.
    - Self review writes require a nonempty claim, but do not require account lookup before saving.
    - Activity and calendar user-data resolve an existing account.
    - Catch Up resolves an existing account when recording is enabled.
    - Spoiler Guard enable actions resolve the caller and check library access.
    - Own/admin tag and statistics routes additionally resolve the target account (`404` if absent).

Per-user document authorization uses the role check, rather than the broader administrator-account check used by most admin actions. No JE controller action declares a `RequiresElevation` policy. `X-Jellyfin-User-Id` does not supply caller identity or select a Seerr user.

### Response conventions

Check the HTTP status before reading a response body. The notes below cover request content types, field names, and error formats.

Send `Content-Type: application/json` for JSON bodies. Form endpoints specify their own content type. Successful JSON responses normally use `200`; exceptions include Catch Up (`204`), starting the Spoiler Guard task (`202`), and conditional reads (`304`, no body).

Examples use the field names declared by JE: document models use PascalCase; explicit envelopes usually use camelCase. Jellyfin's output formatter can affect wire casing and omit null model properties. Handle optional values as either missing or null; do not rely on universal null omission.

Typed request binding accepts property names case-insensitively. Bodies inspected as `JsonElement`, including Seerr requests and usage tracking, use the exact property names shown.

Invalid JSON or parameter types can fail MVC model binding with `400` before an action runs. Missing/invalid credentials normally produce `401`, and permission failures `403`.

Error bodies vary: some are strings, some have `message`, some have `success:false`, and proxy errors can include `code`. Inspect status before parsing a success schema. `499` indicates a canceled GET after the client disconnected.

### Check version

`GET /JellyfinEnhanced/version` is anonymous. It returns unquoted text such as `12.12.0.0`, or `unknown` if the plugin instance is unavailable.

```bash
curl "$JE_URL/version"
```

## Bookmarks API

Use these routes to bookmark a playback position and build a personal bookmarks screen. They use own/admin authorization, and do not check the client feature toggle, a TMDB API key, or a nonempty TMDB ID.

| Setting | Default | What it does |
|---|---|---|
| **Enable Bookmarks Feature** | `true` | `BookmarksEnabled`; enables the web client feature. |

### Bookmarks Storage Directory

Each user's file is stored at:

```text
{PluginsPath}/configurations/Jellyfin.Plugin.JellyfinEnhanced/{userIdN}/bookmark.json
```

`PluginsPath` is Jellyfin's configured plugins directory, commonly `{JELLYFIN_DATA_DIR}/plugins`. The user folder is a lowercase N-format GUID. The filename is `bookmark.json`, singular.

The dictionary key is the bookmark ID. This is a complete example of one entry:

```json
{
  "Bookmarks": {
    "Bm_1767441600000_a1b2c3d4e": {
      "ItemId": "9285e8b54149414941494edb9e464dcd",
      "TmdbId": "603",
      "TvdbId": "",
      "MediaType": "movie",
      "Name": "The Matrix",
      "Timestamp": 123.45,
      "Label": "Favorite scene",
      "CreatedAt": "2026-01-03T12:00:00.000Z",
      "UpdatedAt": "2026-01-03T12:00:00.000Z",
      "SyncedFrom": "",
      "SeasonNumber": null,
      "EpisodeNumber": null
    }
  }
}
```

| Field | Type/default | Meaning |
|---|---|---|
| `ItemId` | String, `""` | Jellyfin item ID; required and nonblank for add. |
| `TmdbId`, `TvdbId` | Strings, `""` | Optional provider metadata. |
| `MediaType` | String, `""` | Client convention: `movie` or `tv`; the server does not enforce these values. |
| `Name`, `Label` | Strings, `""` | Item name and bookmark label. |
| `Timestamp` | Number, `0` | Playback position in **seconds**. |
| `CreatedAt`, `UpdatedAt` | Strings, `""` | UTC ISO timestamps; generated by add. |
| `SyncedFrom` | String, `""` | Source item ID when copying a bookmark. |
| `SeasonNumber`, `EpisodeNumber` | Nullable integers, `null` | Episode identity for matching replacement items. |

For episode bookmarks, JE's client prefers the parent series' TMDB ID and the episode's own TVDB ID, falling back to the series' TVDB ID. The API accepts the metadata you send; it does not look these IDs up.

### Bookmarks API endpoints

Use add/remove for individual bookmarks. Use the document routes to read or replace the complete set.

| Method | Path | Access | Request → response |
|---|---|---|---|
| GET | `user-settings/{userId}/bookmark.json` | Own/admin | No body → bookmark document; missing/unreadable file gives `{"Bookmarks":{}}`. |
| POST | `user-settings/{userId}/bookmark.json` | Own/admin | Complete document → `{"success":true,"file":"bookmark.json"}`. |
| POST | `user-settings/{userId}/bookmark.json/add` | Own/admin | One entry, excluding timestamps → `{"success":true,"id":"Bm_…"}`. |
| DELETE | `user-settings/{userId}/bookmark.json/{bookmarkId}` | Own/admin | Bookmark dictionary key → `{"success":true,"removed":true}`. |

Add accepts all entry fields except `CreatedAt` and `UpdatedAt`; lowercased equivalents such as `itemId`, `seasonNumber`, and `episodeNumber` also bind. Only a nonblank `ItemId` is required at action level.

Add does not validate library access, provider IDs, media type, season existence, or timestamp range.

Omitted strings default to `""`; optional null strings are normalized to `""`. Every add generates a distinct ID, even for identical data.

```bash
curl -X POST "$JE_URL/user-settings/$USER_ID/bookmark.json/add" \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H 'Content-Type: application/json' \
  --data '{"itemId":"9285e8b54149414941494edb9e464dcd","tmdbId":"603","mediaType":"movie","name":"The Matrix","timestamp":123.45,"label":"Favorite scene"}'

curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  "$JE_URL/user-settings/$USER_ID/bookmark.json"

BOOKMARK_ID='ID_RETURNED_BY_ADD'
curl -X DELETE -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  "$JE_URL/user-settings/$USER_ID/bookmark.json/$BOOKMARK_ID"
```

Missing removal returns `404`:

```json
{"success":false,"removed":false,"message":"No matching bookmark to remove."}
```

Missing `ItemId` on add returns `400`:

```json
{"success":false,"message":"ItemId is required."}
```

Add/remove use locked, strict read-modify-write operations. Corruption triggers preservation/recovery handling and a `500` error, such as:

```json
{"success":false,"message":"Failed to add bookmark."}
```

!!! warning "Replacing the document"

    Whole-document POST replaces all bookmarks and can overwrite changes made since your GET. It does not strict-read the previous file. Prefer add/remove for individual changes. A lenient GET returning an empty document does not prove the disk file was healthy.

## Reviews API

Build star ratings or written reviews shared according to author visibility settings. One server-wide file holds every item's reviews:

```text
{PluginsPath}/configurations/Jellyfin.Plugin.JellyfinEnhanced/reviews.json
```

The store key is `{userIdN}:{mediaType}:{tmdbKey}`. These are local user reviews; TMDB reviews use the separate TMDB proxy.

| Setting | Default | What it does |
|---|---|---|
| **Enable User Written Reviews** | `false` | `ShowUserReviews`; shows the web review panel, without gating these routes. |
| **Show TMDB Reviews** | `false` | `ShowReviews`; separate external review panel, requiring TMDB configuration. |
| **Hide reviews from hidden users** | `true` | `HideReviewsFromHiddenUsers`; filters authors for non-admin readers. |
| **Hide reviews from disabled users** | `true` | `HideReviewsFromDisabledUsers`; filters authors for non-admin readers. |
| **Also save review star ratings as the user's Jellyfin rating** | `false` | `MirrorReviewRatingsToJellyfin`; optional rating mirroring described below. |
| **Show average user rating on poster cards** | `false` | `ShowUserRatingOnPosters`; governs poster/tag-cache inclusion, without gating `reviews/ratings`. |

Existing authors always see their own reviews. Administrators bypass author filtering, including deleted/orphaned authors. Non-admin readers see orphaned reviews only when both author filters are disabled; the stored ID can then be the display name. The direct review API applies author visibility; Spoiler Guard's client review hiding is a separate presentation rule.

### Rating and content rules

You can submit text, stars, or both. All self/admin POSTs accept the same body:

| Property | Type | Validation |
|---|---|---|
| `content` | Optional string | Trimmed; at most 2000 characters after trimming. Missing/null becomes `""`. |
| `rating` | Optional nullable number | `1..5`, in `0.5` increments; missing/null means no stars. |

Empty/whitespace text with no rating returns `400 {"success":false,"message":"A rating or review text is required."}`. Invalid ratings return `400` with `message:"Rating must be between 1 and 5, in 0.5 increments."`.

Upsert replaces text and rating and preserves the original `createdAt`; omitting either clears that field rather than preserving it.

### Reviewing a season or episode of a TV show

Use an extended TMDB key to identify a season or episode separately from the whole title.

`mediaType` must be exactly `movie` or `tv`. The independent `tmdbId` key accepts `^\d+(:s\d+(:e\d+)?)?$`:

| Key | Intended use |
|---|---|
| `1399` | Whole title |
| `1399:s1` | Season |
| `1399:s1:e1` | Episode |

No positive-ID or season/episode-existence check runs. Leading zeros are retained.

Extended keys are accepted for either media type: `reviews/movie/603:s1` passes validation; `reviews/movie:s1/603` returns a media-type error; `reviews/movie/603:s` returns `Invalid TmdbId.`. Use consistent keys and URL-encode colons if needed.

### Get reviews for an item

Read an item's visible reviews, or fetch rating aggregates for a batch of keys.

| Method | Path | Access | Response |
|---|---|---|---|
| GET | `reviews/{mediaType}/{tmdbId}` | Authenticated | `{"reviews":[<review>]}`; empty array when no visible review exists. |
| GET | `reviews/ratings` | Authenticated | Query `keys`; visible rated-review aggregates. |

```bash
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/reviews/movie/603"
curl -G -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  --data-urlencode 'keys=movie:603,tv:1399:s1' "$JE_URL/reviews/ratings"
```

A review has this shape:

```json
{
  "userId": "9285e8b54149414941494edb9e464dcd",
  "userName": "alice",
  "tmdbId": "603",
  "mediaType": "movie",
  "content": "Great movie!",
  "rating": 4.5,
  "createdAt": "2026-01-03T12:00:00.000Z",
  "updatedAt": "2026-01-05T09:30:00.000Z"
}
```

Text-only reviews have a missing or null `rating`; rating-only reviews have `content:""`. The per-item response contains no aggregate fields.

The batch route accepts comma-separated `mediaType:tmdbKey` values. It ignores malformed entries and collapses duplicates. No valid keys or more than 200 distinct valid keys returns `400`.

```json
{"ratings":{"movie:603":{"average":4.5,"count":2},"tv:1399:s1":null}}
```

`count` counts visible reviews with a nonzero, non-NaN rating, rather than all written reviews. `null` means no visible rated review. The direct aggregate route has no display-toggle gate.

### Write and delete reviews

Use the caller routes for your own reviews. As an administrator, use the explicit author routes to write or delete another author's review.

| Method | Path | Access | Response |
|---|---|---|---|
| POST | `reviews/{mediaType}/{tmdbId}` | Caller, nonempty ID | Review body → `{"success":true}`. |
| DELETE | `reviews/{mediaType}/{tmdbId}` | Caller, nonempty ID | `{"success":true}`, even when no review existed. |
| POST | `reviews/admin/{userIdN}/{mediaType}/{tmdbId}` | Administrator | Review body → `{"success":true}`. |
| DELETE | `reviews/admin/{userIdN}/{mediaType}/{tmdbId}` | Administrator | `{"success":true,"removed":true}`, or `404` below. |
| GET | `reviews/admin/all` | Administrator | Filtered/paged export described below. |

```bash
curl -X POST "$JE_URL/reviews/tv/1399:s1:e1" \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H 'Content-Type: application/json' --data '{"rating":4.5}'

curl -X POST "$JE_URL/reviews/admin/$USER_ID/movie/603" \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H 'Content-Type: application/json' --data '{"content":"Great movie!","rating":5}'
```

Admin author IDs must parse as N-format GUIDs, but the account need not exist and the supplied ID string is retained in the store key. Use canonical lowercase IDs to avoid casing-dependent duplicates. Missing admin deletion returns:

```json
{"success":false,"removed":false,"message":"No matching review to delete."}
```

With rating mirroring enabled, whole-movie/series stars are written to an accessible matching Jellyfin item as `stars × 2`. New stars overwrite its previous Jellyfin rating.

Removing stars or deleting a review clears that rating only if it still matches the previous mirrored value within `0.01`. Season/episode keys are excluded. Missing accounts/items or mirror failures do not undo the review operation.

### Admin export and polling

Use `reviews/admin/all` to export reviews or poll for updates. The filters and pagination rules below apply to this administrator route.

| Query | Default | Rules |
|---|---|---|
| `since` | Unset | Parseable ISO 8601; inclusive `updatedAt >= since`; invalid value returns `400`. |
| `userId` | Unset | One N-format author ID; invalid value returns `400`. |
| `limit` | `500` | `1..1000`; out-of-range returns `400`. |
| `offset` | `0` | Nonnegative; negative returns `400`. |

```bash
curl -G -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  --data-urlencode 'since=2026-01-01T00:00:00Z' \
  --data-urlencode 'limit=100' --data-urlencode 'offset=0' "$JE_URL/reviews/admin/all"
```

Response: `{"reviews":[<review>],"total":1,"offset":0,"limit":100}`. `total` counts all matching rows.

Results sort by `updatedAt` ascending (oldest matching reviews first), then store key in ordinal order. Unparseable update timestamps are included regardless of `since` and sort first. Admin exports bypass author filters.

De-duplicate polling results by author + media type + TMDB key because `since` is inclusive. Pagination is not a snapshot; changes during paging can move rows. There is no deletion/tombstone stream.

Reads are lenient and may return an empty store after corruption/I/O failure. Mutations strict-read the shared store, refuse to overwrite unreadable data, attempt a `.corrupt-<timestamp>` backup copy, and return `500` on failure. For example: `{"success":false,"message":"Failed to save review."}`.

## Per-User Settings Files

Use these routes to read or replace a user's saved preferences and state. They provide six explicit typed document pairs; unknown properties do not become arbitrary stored data.

All use own/admin authorization. GETs are `no-store`; POST replaces the complete document and normally returns `{"success":true,"file":"<filename>"}`. These routes are not an arbitrary file service.

| Method | Path | Document |
|---|---|---|
| GET | `user-settings/{userId}/settings.json` | Enhanced settings |
| POST | `user-settings/{userId}/settings.json` | Replace Enhanced settings |
| GET | `user-settings/{userId}/shortcuts.json` | Shortcut list |
| POST | `user-settings/{userId}/shortcuts.json` | Replace shortcut list |
| GET | `user-settings/{userId}/elsewhere.json` | Provider preferences |
| POST | `user-settings/{userId}/elsewhere.json` | Replace provider preferences |
| GET | `user-settings/{userId}/ddd-triggers.json` | Picked DoesTheDogDie trigger IDs, `{Triggers:[int]}` |
| POST | `user-settings/{userId}/ddd-triggers.json` | Replace picked trigger IDs |
| GET | `user-settings/{userId}/hidden-content.json` | Hidden Content state |
| POST | `user-settings/{userId}/hidden-content.json` | Replace Hidden Content state |
| GET | `user-settings/{userId}/spoilerblur.json` | Raw Spoiler Guard state |
| POST | `user-settings/{userId}/spoilerblur.json` | Replace raw Spoiler Guard state |

The bookmark GET/POST pair is listed in [Bookmarks API endpoints](#bookmarks-api-endpoints). All documents live in the same user directory. Save failures generally return `500 {"success":false,"message":"…"}`.

Settings, shortcuts, Elsewhere, and bookmark whole-file saves do not strict-read the previous document.

Hidden Content and raw Spoiler Guard saves lock and strict-read first: corruption returns `503` with backup/retry guidance, temporary I/O failures `500`.

Raw Spoiler Guard POST has a **2 MiB** request limit and at most **1000 entries in each** of `Series`, `Movies`, `Collections`, `PendingTmdb`; exceeding the dictionary cap returns `413`.

It maintains pending-promotion registrations. Its GET is lenient and can return defaults for corrupt data; [caller-facing Spoiler Guard reads](#spoiler-guard) instead report corruption.

```bash
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  "$JE_URL/user-settings/$USER_ID/settings.json"

curl -X POST "$JE_URL/user-settings/$USER_ID/elsewhere.json" \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H 'Content-Type: application/json' \
  --data '{"Region":"US","Regions":["US"],"Services":[],"SeasonProviders":true}'
```

### Settings document

GET can create a first settings file using saved administrator defaults. It adds `IsAdmin`, computed for the **caller**, even when reading another user's document. POST ignores that derived field. POST normalizes the tag layout fields before saving: an unknown layout or density falls back to `corners` / `full`, unknown groups and slots are dropped, caps are clamped to 0–10 and the group order is deduplicated.

Read the current document, modify the needed properties, and send it back to preserve other preferences.

The table below gives the `UserSettings` **model defaults** used when properties are omitted in a replacement body. They differ from initial values seeded by saved server configuration. For example, first GET seeds `LastOpenedTab:"shortcuts"`, and server defaults can enable features whose model defaults are false. See [settings overview](../getting-started/settings-overview.md) for the settings workflow.

| Field | Type | Model default |
|---|---|---|
| `AutoPauseEnabled` | Boolean | `false` |
| `AutoResumeEnabled` | Boolean | `false` |
| `AutoPipEnabled` | Boolean | `false` |
| `LongPress2xEnabled` | Boolean | `false` |
| `PauseScreenEnabled` | Boolean | `false` |
| `PauseScreenDelaySeconds` | Integer | `5` |
| `AutoSkipIntro` | Boolean | `false` |
| `AutoSkipOutro` | Boolean | `false` |
| `DisableCustomSubtitleStyles` | Boolean | `false` |
| `SelectedStylePresetIndex` | Integer | `0` |
| `SelectedFontSizePresetIndex` | Integer | `0` |
| `SelectedFontFamilyPresetIndex` | Integer | `0` |
| `SelectedTextEffectPresetIndex` | Integer | `0` |
| `CustomSubtitleTextColor` | String | `"#FFFFFFFF"` |
| `CustomSubtitleBgColor` | String | `"#00000000"` |
| `UsingCustomColors` | Boolean | `false` |
| `SubtitleVerticalPosition` | Integer | `85` |
| `SubtitleHorizontalPosition` | Integer | `50` |
| `RandomButtonEnabled` | Boolean | `false` |
| `RandomUnwatchedOnly` | Boolean | `false` |
| `RandomIncludeMovies` | Boolean | `false` |
| `RandomIncludeShows` | Boolean | `false` |
| `RandomScopeCurrentContainer` | Boolean | `false` |
| `RandomSourceId` | String | `""` |
| `ShowWatchProgress` | Boolean | `false` |
| `WatchProgressMode` | String | `"percentage"` |
| `WatchProgressTimeFormat` | String | `"hours"` |
| `ShowFileSizes` | Boolean | `false` |
| `ShowAudioLanguages` | Boolean | `false` |
| `UseNativePosterTags` | Nullable boolean | `null` |
| `QualityTagsEnabled` | Boolean | `false` |
| `ShowResolutionTag` | Boolean | `true` |
| `ShowSourceTag` | Boolean | `true` |
| `ShowEditionTag` | Nullable boolean (inherits admin default `true`) | `null` |
| `ShowLowQualitySourceTag` | Nullable boolean (inherits admin default `false`) | `null` |
| `EditionTagOrder` | Nullable integer (inherits admin default `7`) | `null` |
| `ShowDynamicRangeTag` | Boolean | `true` |
| `ShowSpecialFormatTag` | Boolean | `true` |
| `ShowVideoCodecTag` | Boolean | `true` |
| `ShowAudioInfoTag` | Boolean | `true` |
| `ResolutionTagOrder` | Nullable integer (inherits the admin default) | `null` |
| `SourceTagOrder` | Nullable integer (inherits the admin default) | `null` |
| `DynamicRangeTagOrder` | Nullable integer (inherits the admin default) | `null` |
| `SpecialFormatTagOrder` | Nullable integer (inherits the admin default) | `null` |
| `VideoCodecTagOrder` | Nullable integer (inherits the admin default) | `null` |
| `AudioInfoTagOrder` | Nullable integer (inherits the admin default) | `null` |
| `GenreTagsEnabled` | Boolean | `false` |
| `LanguageTagsEnabled` | Boolean | `false` |
| `RatingTagsEnabled` | Boolean | `false` |
| `AgeRatingTagsEnabled` | Boolean | `false` |
| `LogoTagsEnabled` | Boolean | `false` |
| `StatusTagsEnabled` | Boolean | `false` |
| `PeopleTagsEnabled` | Boolean | `false` |
| `TagsHideOnHover` | Boolean | `false` |
| `QualityTagsPosition` | String | `"top-left"` |
| `QualityTagsPreferredAudioLanguage` | String | `""` |
| `SeriesQualityAggregation` | Nullable string: `representative`, `latest`, `best`, `shared`, `mixed`; null inherits the admin default | `null` |
| `GenreTagsPosition` | String | `"top-right"` |
| `LanguageTagsPosition` | String | `"bottom-left"` |
| `RatingTagsPosition` | String | `"bottom-right"` |
| `RatingTagsOnMovies` | Boolean | `true` |
| `RatingTagsOnSeries` | Boolean | `true` |
| `RatingTagsOnSeasons` | Boolean | `true` |
| `RatingTagsOnEpisodes` | Boolean | `true` |
| `RatingTagsOnContinueWatching` | Boolean | `true` |
| `RatingTagsOnNextUp` | Boolean | `true` |
| `RatingTagsShowCommunity` | Boolean | `true` |
| `RatingTagsShowCritic` | Boolean | `true` |
| `AgeRatingTagsPosition` | String | `"bottom-right"` |
| `LogoTagsPosition` | String | `"bottom-left"` |
| `StatusTagsPosition` | String | `"top-right"` |
| `StatusTagsJustAdded` | Boolean | `true` |
| `StatusTagsNewRelease` | Boolean | `true` |
| `StatusTagsTrending` | Boolean | `true` |
| `StatusTagsSchedule`, `StatusTagsMilestones` | Boolean | `true` |
| `StatusTagsSeriesStatus` | Boolean | `false` |
| `StatusTagsLeaving`, `StatusTagsDirectPlay` | Boolean (Leaving soon; web direct-play warning) | `false` |
| `TagLayout` | String: `corners`, `bands`, `caption`, `summary` or `minimal` | `"corners"` |
| `TagLayoutSettingsVersion` | Integer; `0` = saved before layouts (keeps corners, positions, arrival order and the original limits), `1` = layout settings apply | `0` (new users: `1`) |
| `TagLayouts` | Nullable object `{Corners,Bands,Caption,Summary,Minimal}`, each `{Groups:[{Group,Slot}]}` | `null` |
| `TagGroupOrder` | Nullable array of group ids (`status`, `quality`, `rating`, `ageRating`, `language`, `genre`) | `null` |
| `TagGroupCaps` | Nullable object `{Quality,Genre,Language,Rating,AgeRating,Status}` of integers 0–10, `0` = unlimited | `null` |
| `TagLabelDensity` | String: `full` or `compact` | `"full"` |
| `TagScale` | Nullable string: `smaller`, `default`, `larger`, `largest` (85%, 100%, 115%, 130%) | `null` (admin: `"default"`) |
| `TagGap` | Nullable string: `tight`, `default`, `roomy` (75%, 100%, 150% spacing) | `null` (admin: `"default"`) |
| `TagEdgeSpacing` | Nullable string: `default` (6px), `tight` (3px) or `flush` (0px), the Corners layout's distance from the card edge; unknown values are stored as `default`. `null` inherits the administrator's `TagEdgeSpacing` (version `1` documents only; version `0` always uses `default`, and promotion writes `default`) | `null` (new users: the admin default) |
| `TagStylePreset` | Nullable string: `default`, `glass`, `outline`, `dark`, `light`, `mono` or `poster`; unknown values are stored as `null` | `null` (follow the admin's preset; only used while the admin allows user presets) |
| `TagLookRules` | Nullable array of `{Id,Enabled,When:[{Field,Value}],Layout,Density,ColourPreset,Slots,Shapes}`; `Field` is `library` (32-hex library id), `type`, `genre` or `ageRating`; at most 50 rules of 1–5 conditions; `Slots` nullable `[{Group,Slot}]`; `ColourPreset` reserved, `null`. `null` inherits the administrator's rules (version `1` documents only) | `null` (new users: the admin rules) |
| `TagShapeOverrides` | Nullable `{Landscape,List}`, each null or `{Layout,Density,TagScale,TagGap,Slots:[{Group,Slot}],Caps:{Quality,Genre,Language,Rating,AgeRating,Status}}`. Optional fields inherit the default look. Unknown layouts/densities become null, invalid groups/slots are dropped, caps clamp to 0–10. Null inherits admin defaults only for version `1`; `{Landscape:null,List:null}` explicitly turns both off | `null` |
| `TagLayoutLocks` | Nullable object keyed by item id (32 lowercase hex) of `{Layout,Density,ColourPreset,Slots,Shapes,Caps,TagScale,TagGap,EdgeSpacing,Scope,LockedAt}`; at most 500, the oldest `LockedAt` dropped first. `Caps` (`{Quality,…,Custom}`, 0–10, null per group keeps the user's), `TagScale`, `TagGap` and `EdgeSpacing` are optional (null keeps the user's; unknown values are stored as null); `Scope` is `"item"` (a Series lock stays on the series card) or null (its seasons and episodes inherit it). Written by the item editor (`tags/tag-item-editor.js`) | `null` |
| `ShowRatingInPlayer` | Boolean | `true` |
| `RemoveContinueWatchingEnabled` | Boolean | `false` |
| `LastOpenedTab` | String | `""` |
| `ReviewsExpandedByDefault` | Boolean | `false` |
| `DisplayLanguage` | String | `""` |
| `CalendarDisplayMode` | String | `"list"` |
| `CalendarDefaultViewMode` | String | `"agenda"` |

`Shapes` on rules and locks uses the same `{Landscape,List}` map as `TagShapeOverrides`; it layers over that rule's or lock's look, independently of the user's shape overrides. Resolution is the user's lock → the administrator's item look (`TagLookItemOverrides`) → first matching rule → shape override → default; a lock or item look on the item itself comes before one on its series (`core/tag-layout.js` `lookSource`, and natively `PosterTagSettings.ForItem`, which applies locks, item looks and rules but not shapes). POST also accepts a shape slot map such as `{"quality":"bottom","status":"top"}`; stored responses use arrays, matching `TagLayouts` and preserving group ids across key-case conversion. `Layout`/`Density` null inherits, and null caps inherit per group. A shape that changes layout uses the profile of the new layout. Portrait and square cards always use the default shape; Native Poster Tags ignore these objects.

`TagScale` and `TagGap` are presentation-only settings, normalized case-insensitively on save. An unknown global value becomes `default`; null inherits the administrator's validated choice, then `default`. Version-0 documents always render at default size/gap. Promotion writes explicit `default` values so changing another layout setting does not adopt new administrator sizing. New-user seeding and reset-all copy the administrator's values. A shape's optional `TagScale`/`TagGap` uses the same choices, with unknown values normalized to null (inherit). Shape fields also round-trip inside rule/lock `Shapes`. Native posters use global size/gap in their rendering metrics and settings digest, with shape overrides still web-only. These fields do not change `TagCacheEntry` or its schema.

The web client keeps these nullable fields null while they inherit: the settings panel shows the administrator's current value for `ShowEditionTag`, `ShowLowQualitySourceTag`, the three technical category switches (`ShowRuntimeTag`, `ShowAspectRatioTag`, `ShowFrameRateTag`), the three display modes, minimum resolution, Hide SDR, the ten `*TagOrder` fields and `SeriesQualityAggregation`, and saves `null` for each one the user has not changed, so a save, an import or its **Undo** never pins today's administrator default. Inheriting is a state, not a value comparison: any change through a panel control (even back to the administrator's value), an imported value (even one equal to the default) and a reorder of the quality categories (all ten orders) are saved as the user's own. Only **Follow server** in the series policy, **Follow server settings** in the Quality group, or an import or **Undo** of a null value makes a field inherit again.

### Media Tags import, export and presets

A user's Media Tags settings travel as a versioned document with the same PascalCase field names as `settings.json`:

```json
{ "v": 1, "kind": "je-media-tags-user", "settings": { "TagLayout": "bands", "TagLayoutSettingsVersion": 1, "TagScale": "larger", "QualityTagsEnabled": true } }
```

`settings` holds 86 personal Media Tags fields (`MediaTagsPortable.UserFields`, including the three display modes, minimum resolution, Hide SDR and technical categories): the group switches (`QualityTagsEnabled` … `CustomTagsEnabled`, `PeopleTagsEnabled`, `TagsHideOnHover`, `UseNativePosterTags`), quality includes and orders, `QualityTagsPreferredAudioLanguage`, `SeriesQualityAggregation`, the rating scopes, sources, minimum and colour switch, the language display and priority fields, the seven status families (including Scenes), the nine `*TagsPosition` fields, `TagLayout`, `TagLayoutSettingsVersion`, `TagLayouts`, `TagGroupOrder`, `TagGroupCaps`, `TagLabelDensity`, `TagScale`, `TagGap`, `TagEdgeSpacing`, `TagShapeOverrides` and `TagStylePreset`. Rules and locks (`TagLookRules`, `TagLayoutLocks`) are not part of it: they name the server's libraries and items. A **preset** is the same document with `kind: "je-media-tags-preset"`, an `id` (lower-case letters, digits and hyphens, up to 40), a `name` (1–60 characters) and a `description` (up to 240); its `settings` may name only some fields.

| Method | Path | Access | Request → response |
|---|---|---|---|
| GET | `user-settings/{userId}/media-tags/export` | Own/admin | No body → the user document above, every field in `UserFields` order. |
| POST | `user-settings/{userId}/media-tags/preview` | Own/admin | A user document or a preset (64 KB limit) → `{kind, v, name, description, imported:{Field:value}, changes:[{field, from, to}], skipped:[{field, reason, detail}]}`. Nothing is saved; the client writes the changed fields through `POST settings.json`. `400 {error}` refuses the document as a whole: `not-object`, `kind`, `version` (missing or not a positive integer), `newer` (`v` above the server's), `settings` (not an object). |
| GET | `user-settings/{userId}/media-tags/presets` | Own/admin | No body → `{max:10, builtIn:[preset], offered:[preset], mine:[preset]}`: the shipped presets (`Assets/TagPresets/*.json`), the administrator's `TagOfferedPresets` and the user's own. |
| POST | `user-settings/{userId}/media-tags/presets` | Own/admin | A preset, or a user document with a `name` (64 KB limit) → `{preset, skipped}`; the stored preset gets a new id and keeps only the accepted settings. `400 {error}`: a document error above, `name`, `description`, `empty` (no usable setting) or `full` with `max` (10 per user). |
| DELETE | `user-settings/{userId}/media-tags/presets/{presetId}` | Own/admin | No body → `{success:true}`; `404 {error:"missing"}` for an unknown id. |
| GET | `admin/media-tags/export` | Administrator | No body → `{v:1, kind:"je-media-tags-admin", settings:{…}}`: every field of the Media Tags page's allowlist (`MediaTagsPageFields.Allowed`) in the configuration API's shape, sorted, except `ClearLocalStorageTimestamp`. Secrets (`CustomTagRuleKey`, API keys, tokens, passwords) are never included. |
| POST | `admin/media-tags/preview` | Administrator | An administrator document (256 KB limit) → `{kind, v, imported, changes, skipped}`. Each field is read and checked exactly as `POST admin/configuration` reads it (`PluginConfigurationPatch.TryRead`); the page then applies the changes through that patch, with the values it read as `Expected`. |

Each user field is checked on its own: it must be one of `UserFields`, have the property's JSON type, pass the administrator field contract where the configuration has a field of that name and type (positions, orders 1–99, known values, minimum score 0–10, text limits), and come out of the settings save path's normalisation (`MediaTagsPortable.TryNormalizeUser`, the same call `POST settings.json` makes) exactly as given. Anything else is reported in `skipped` and never applied: `reason` is `unknown`, `invalid` (with the validator's `detail`), `secret`, or for administrator documents `signal`. `secret` covers every credential field of the plugin configuration as spelled (`MediaTagsPortable.Secrets`: `TMDB_API_KEY`, the other `*ApiKey` fields, `SonarrInstances`/`RadarrInstances`, `CustomTagRuleKey`, `AnalyticsInstallSecret`) and any other name ending in an API key or token or containing password or secret, ignoring case, `_` and `-`. `null` keeps its meaning (follow the administrator). Saved presets live in `media-tag-presets.json` in the user's directory, read-modify-written under the user's file lock.

The administrator's offered presets are the page field `TagOfferedPresets`: a JSON array text of at most 20 presets with distinct ids, each valid as a whole (no unknown or invalid setting); `""` offers none. The cap is 80 KiB (81,920 UTF-8 bytes, `MediaTagsPortable.MaxOfferedPresetsBytes`) for the text as sent and for its canonical stored form: the presets normalised and serialised the way the server stores them, with non-ASCII and HTML-sensitive characters escaped (`<` becomes `\u003C`), which can be several times longer than the text sent. A value over the cap once normalised is refused (`larger than 81920 bytes once normalised (N bytes)`), so every stored value exports and imports again unchanged. `POST admin/configuration` (and the import preview) reads up to 8 MiB (`PluginConfigurationPatch.MaxRequestBytes`) for the entire JSON body, including both `Changes` and `Expected`, outer string escaping and any Tag Styles data. Individually valid fields can exceed that aggregate limit together. Such a request is refused before any write; reduce the document and retry. Imports use the existing page conflict handling: each request is atomic, but resolving conflicts can retry the non-conflicting fields separately. There is no guarantee that every maximal old/new document fits one request.

**Versioning.** `v` grows only when a field is renamed, removed or changes meaning. New fields are added without a new version: an older server reports them as `unknown` and applies the rest. A server refuses a document whose `v` is higher than its own (`newer`), and reads an older `v` through that version's migration before checking it. `kind` never changes for an existing document type.

### Shortcuts and Elsewhere documents

Use these documents to save shortcut overrides and provider preferences.

`shortcuts.json` defaults to `{"Shortcuts":[]}`. Each shortcut has string fields `Name`, `Key`, `Label`, `Category`, all defaulting to `""`. The JSON file holds overrides; it does not itself describe every built-in shortcut.

```json
{"Shortcuts":[{"Name":"example","Key":"Ctrl+K","Label":"Example","Category":"custom"}]}
```

`elsewhere.json` defaults to:

```json
{"Region":"","Regions":[],"Services":[],"SeasonProviders":true}
```

`Region` is a string, `Regions` and `Services` are string arrays, and `SeasonProviders` is a boolean. These routes do not call provider services or validate region/provider availability.

### Hidden Content document

`hidden-content.json` contains `Items` (dictionary of `HiddenContentItem`) and `Settings`. `Items` defaults to `{}`. First ordinary GET can seed `Settings` from saved administrator defaults. The dedicated admin GET below uses a lenient read without this seeding.

| Entry field | Type/default |
|---|---|
| `ItemId`, `Name`, `Type`, `TmdbId`, `HiddenAt`, `PosterPath`, `SeriesId`, `SeriesName` | Strings, `""` |
| `SeasonNumber`, `EpisodeNumber` | Nullable integers, `null` |
| `HideScope` | String, `"global"`; scopes are `global`, `continuewatching`, `nextup`, `homesections`. |

Model settings defaults:

```json
{
  "Enabled": true,
  "FilterLibrary": true,
  "FilterDiscovery": true,
  "FilterUpcoming": true,
  "FilterCalendar": true,
  "FilterSearch": false,
  "FilterRecommendations": true,
  "FilterRequests": true,
  "FilterNextUp": true,
  "FilterContinueWatching": true,
  "ShowHideButtons": true,
  "ShowHideConfirmation": true,
  "ShowButtonJellyseerr": true,
  "ShowButtonLibrary": false,
  "ShowButtonDetails": true,
  "ShowButtonCast": false,
  "ExperimentalHideCollections": false
}
```

## Admin Hidden Content API

Manage other users' hidden items without replacing the whole document. These dedicated routes require administrator authority and the server toggle below. The ordinary own/admin file routes do not check this toggle.

| Setting | Default | What it does |
|---|---|---|
| **Let admins view and manage other users' hidden content** | `true` | `HiddenContentAdmin`; admits these dedicated admin actions. |

| Method | Path | Request → response |
|---|---|---|
| GET | `admin/hidden-content-users` | `{"users":[{"userId":"…","userName":"alice","count":2}]}`. |
| GET | `admin/hidden-content/{userId}` | `{"userId":"…","userName":"alice","hiddenContent":{"Items":{},"Settings":{}}}`; `Settings` has the document fields above. |
| POST | `admin/hidden-content/{userId}/hide` | Raw array of entries → `{"success":true,"added":1}`. |
| POST | `admin/hidden-content/{userId}/unhide` | Raw array of dictionary keys → `{"success":true,"removed":1}`. |

Target IDs must be nonempty N-format GUIDs (`400` otherwise); unknown accounts return `404`.

The user list includes existing accounts with stored hidden items, omits the caller and zero-count/deleted users, and sorts names case-insensitively. Lenient reads can report empty/default state for unreadable files.

```bash
curl -X POST "$JE_URL/admin/hidden-content/$USER_ID/hide" \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H 'Content-Type: application/json' \
  --data '[{"ItemId":"9285e8b54149414941494edb9e464dcd","Name":"Example movie","Type":"Movie","HideScope":"global"}]'

curl -X POST "$JE_URL/admin/hidden-content/$USER_ID/unhide" \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H 'Content-Type: application/json' \
  --data '["9285e8b54149414941494edb9e464dcd"]'
```

Hide requires a nonempty array of at most 200 entries. Entries need `ItemId` or `TmdbId`; the key is `ItemId`, otherwise `tmdb-{TmdbId}`. Empty or over-256-character keys and duplicates are skipped. Existing items are retained.

Unknown `HideScope` values become `global`; missing `HiddenAt` gets a server UTC timestamp.

The action truncates `Name`, `SeriesName`, `PosterPath` to 512 characters, `SeriesId` to 128, `Type` to 64, `TmdbId` to 32, and supplied `HiddenAt` to 64.

Unhide requires a nonempty key array; empty/over-256-character keys are ignored.

Both mutations are locked and strict-reading. Zero changes still succeeds.

Corruption returns `503 {"success":false,"message":"Hidden-content store is corrupt; backed up. Please retry."}`; temporary I/O failure returns `500`, as do other storage failures. These actions do not validate each supplied item's library existence.

See [content management](../enhanced/enhanced-features.md#content-management) for the web workflow.

## Continue Watching / Next Up

These caller actions store scoped Hidden Content entries, rather than changing watched state.

| Method | Path | Access | Response |
|---|---|---|---|
| POST | `continue-watching/hide/{itemId}` | Caller | `{"success":true,"key":"…","entry":<HiddenContentItem>}`. |
| DELETE | `continue-watching/hide/{itemId}` | Caller | `{"success":true}`. |
| POST | `next-up/hide/{itemId}` | Caller | Same hide response. |
| DELETE | `next-up/hide/{itemId}` | Caller | Same unhide response. |

```bash
curl -X POST -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  "$JE_URL/continue-watching/hide/9285e8b54149414941494edb9e464dcd"
```

POST requires an existing caller and an accessible Jellyfin item. Malformed item IDs return `400`; unavailable/inaccessible items return `404`.

POST seeds administrator defaults and turns filtering on only when it creates `hidden-content.json`. An existing file keeps its settings, including disabled filtering, even when its item list is empty.

Hiding on both surfaces widens the scope to `homesections`; an existing `global` hide stays global.

DELETE removes only the matching exact surface scope. A wider `global`/`homesections` entry can therefore yield `404 {"success":false,"message":"No matching hidden-content entry."}`. Corruption returns `503`; storage failures return `500`. There is no target-user override.

## Seerr Integration API

Use the Seerr routes for discovery, requests, quotas, and issues. The route prefix remains `jellyseerr` even when you use Seerr. Configure the server connection in [Seerr settings](../seerr/seerr-settings.md).

| Setting | Default | What it does |
|---|---|---|
| **Enable Seerr integration** | `false` | `JellyseerrEnabled`; enables integration. |
| **Seerr URL(s) (One per line)** | `""` | `JellyseerrUrls`; server-reachable URLs, generally tried in order. |
| **Seerr API Key** | `""` | `JellyseerrApiKey`; server-side upstream credential. |
| **Auto import Jellyfin users to Seerr** | `false` | `JellyseerrAutoImportUsers`; lookup/status may import unlinked callers. |
| **Blocked Users** | `""` | `JellyseerrImportBlockedUsers`; excludes selected users from lookup/import. |
| **Disable server-side response cache** | `false` | `JellyseerrDisableCache`; bypasses normal response, user, and enrichment caches. |
| **Response Cache TTL (min)** | `10` | `JellyseerrResponseCacheTtlMinutes`; minimum one minute. |
| **User ID Cache TTL (min)** | `30` | `JellyseerrUserIdCacheTtlMinutes`; minimum one minute. |
| **Sync Seerr Watchlist → Jellyfin** | `false` | `SyncJellyseerrWatchlist`; required for manual watchlist sync. |
| **Add requested media to Watchlist** | `false` | `AddRequestedMediaToWatchlist`; adds successfully requested media through the watchlist workflow. |

### Caller identity, permissions, and errors

Check these requirements before calling a Seerr proxy. Requests use your token's identity and the permissions of your linked Seerr account.

Ordinary proxies need enabled integration, URLs, API key, and a linked authenticated caller. JE derives the caller from the token's `Jellyfin-UserId` claim and uses that caller's Seerr identity upstream.

User lookup/status can auto-import; permission audit never auto-imports. Supplying an extra user-ID header does not change this identity.

| Operation | Permission for non-admin callers |
|---|---|
| Request creation, including seasons | At least one of `REQUEST`, `REQUEST_MOVIE`, `REQUEST_TV`; Seerr validates its own media-specific rules. |
| Advanced request fields | `REQUEST_ADVANCED` or `MANAGE_REQUESTS`; otherwise JE strips `serverId`, `profileId`, `rootFolder`, `languageProfileId`, `tags`. |
| Service and override-rule discovery | A request permission, `REQUEST_ADVANCED`, or `MANAGE_REQUESTS`. |
| Issue reads | `VIEW_ISSUES` or `MANAGE_ISSUES`. |
| Issue creation | `CREATE_ISSUES` or `MANAGE_ISSUES`. |

Jellyfin administrators and Seerr `ADMIN` callers bypass these permission checks, while ordinary proxy calls still require linkage.

Missing setup returns `503`; missing caller claim `403`; unreachable Seerr `502` with `code:"unreachable"`; blocked lookup `403` with `code:"blocked"`; unlinked reachable caller `404` with `code:"unlinked"`. Reachability is checked before the blocked/unlinked distinction.

Permission errors include `no_request_permission`, `no_issue_permission`, and `no_issue_view_permission`. Upstream authentication/authorization errors can return `401`/`403`; other upstream statuses can pass through. Admin error bodies may contain more diagnostics.

Success forwards upstream JSON, rather than a universal `success` envelope. Lists commonly contain `results`, `page`, `totalPages`, `totalResults`, or `pageInfo`; detail/service/rating bodies keep the upstream schema.

GET parental filtering can change lists or deny detail/subresource access. Request/issue validation remains Seerr's responsibility where JE does not impose a documented check.

Jellyfin parental policy applies server-side. Denied title/request access returns `403 {"error":true,"code":"parental_block","message":"This title is above your parental rating limit."}`.

Filtered reads still awaiting rating verification can return `504` with `code:"parental_pending"` and `Retry-After: 2`; retry these instead of treating them as an empty successful page.

GETs can return `499` on disconnect. Proxy POSTs continue independently of client disconnects.

### Status and administrative operations

Use these routes to check connectivity and user linkage, test connection settings, or run administrator operations such as import and watchlist sync.

| Method | Path | Access | Inputs → response |
|---|---|---|---|
| GET | `jellyseerr/status` | Authenticated | `{"active":true}`; reachability only, cached 30 seconds, including negative results. |
| GET | `jellyseerr/user-status` | Authenticated/caller | `active`, `userFound`, `reason`; linked results also contain string `jellyseerrUserId` and boolean `canRequestAdvanced`; `no-store`. |
| GET | `jellyseerr/validate` | Administrator | Query `url`, header `X-Arr-ApiKey` → `{"ok":true}`. |
| POST | `jellyseerr/trigger-recently-added-scan` | Administrator | Query `url`, header `X-Arr-ApiKey`, no body needed → `{"ok":true}`. |
| GET | `jellyseerr/permission-audit` | Administrator | Array of `{jellyfinUsername,jellyfinUserId,linked,permissions,issues}`. |
| POST | `jellyseerr/import-users` | Administrator | No body → `{success,usersImported,totalUsers,errors}`. |
| POST | `jellyseerr/sync-watchlist` | Administrator | No body → `{success,itemsProcessed,itemsAdded,errors}`. |
| GET | `jellyseerr/settings/{type}` | Administrator | Exact `type=sonarr` or `radarr` → upstream connection-settings array, including API keys. |
| GET | `jellyseerr/settings/partial-requests` | Authenticated | `{partialRequestsEnabled,enableSpecialEpisodes}` booleans, without caller linkage. |
| GET | `jellyfin-urls` | Administrator | `{externalUrl,internalUrl}` detected/published Jellyfin URLs. |
| GET | `jellyseerr/user` | Administrator + Seerr-linked | Optional `take=1000` → upstream user roster, not the caller's profile. |

User-status ordinarily returns `200` with reasons `disabled`, `no_user`, `blocked`, `unlinked`, `unreachable`, or `linked`; status does not establish linking. It can use cached user results. For example:

```json
{"active":true,"userFound":true,"reason":"linked","jellyseerrUserId":"7","canRequestAdvanced":false}
```

```bash
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/jellyseerr/user-status"

SEERR_URL='http://seerr:5055'
SEERR_KEY='YOUR_SEERR_API_KEY'
curl -G -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H "X-Arr-ApiKey: $SEERR_KEY" --data-urlencode "url=$SEERR_URL" \
  "$JE_URL/jellyseerr/validate"
```

Validation and manual scan test one **supplied**, possibly unsaved URL/key. Missing inputs or a rejected URL return `400 {ok:false,message}`. Upstream failures add `code` and optional `cfRay`; connection failure returns `502`.

Recently-added scan updates Seerr's library availability, rather than completing downloads/imports. Use service URLs reachable from the Jellyfin server/container; URL mappings control browser links separately.

The URL guard allows HTTP(S) and loopback, blocks metadata/unspecified addresses and literal IPv4 link-local URLs, and permits allowed container-host alias mappings.

Permission audit requires configured integration (`503` otherwise), bypasses cached lookup, and returns numeric permission bits or null plus issue strings for each account.

Manual import excludes blocked users, does not require auto-import enabled, returns `400` for missing setup, and has a 30-second throttle (`429`). A reached import can succeed with per-user errors; total upstream failure returns `502`.

Watchlist sync requires its toggle, enabled integration, and credentials (`400` if missing); it uses the first URL whose user list loads, returns `502` if none does, and can succeed with per-user errors. `errors` is nullable/omittable when none occurred. Missing users are not imported by sync. See [Seerr features](../seerr/seerr-features.md) for scheduled watchlist behavior.

`settings/{type}` backs **Import from Seerr** in the admin **\*arr** tab. It uses the first configured URL and does not require caller linkage; invalid type returns `400`, setup `503`, upstream rejection `403` or other upstream status. Treat returned instance API keys as credentials.

Partial-request settings try configured URLs and return structured `503` with `code:"disabled"` or `"unreachable"` if unavailable.

### Seerr Discovery & Requests

Use these routes to browse titles, submit requests, check quotas, and work with issues.

All routes in this table require **Seerr-linked** access, except TV-by-studio's separately described TMDB implementation. Numeric title IDs are TMDB IDs; genre, keyword, person, collection, network, and studio IDs belong to TMDB. Service IDs belong to Seerr.

| Method | Path | Parameters and result |
|---|---|---|
| GET | `jellyseerr/search` | Required nonblank `query`, `page=1` (minimum 1), optional `language` → upstream search page. |
| GET | `jellyseerr/sonarr` | Request/discovery permission → upstream service list. |
| GET | `jellyseerr/radarr` | Request/discovery permission → upstream service list. |
| GET | `jellyseerr/sonarr/lookup/{tmdbId}` | Request/discovery permission → upstream Sonarr match candidates. |
| GET | `jellyseerr/{type}/{serverId}` | Exact `type=sonarr` or `radarr` (`400` otherwise) → service profiles/folders/details. |
| POST | `jellyseerr/request` | JSON request object → upstream request record. |
| GET | `jellyseerr/request` | `take=500`, `skip=0`, `filter=all`, forwarded without JE clamping → upstream request page. |
| GET | `jellyseerr/quota` | Caller's quota; movie/TV sides can gain ISO `nextResetAt`. |
| GET | `jellyseerr/movie/{tmdbId}` | Movie detail. |
| GET | `jellyseerr/tv/{tmdbId}` | TV detail. |
| GET | `jellyseerr/tv/{tmdbId}/season/{seasonNumber}` | Season detail; numeric route values forwarded. |
| GET | `jellyseerr/movie-collections` | Query `ids` → collection map, described below. |
| GET | `jellyseerr/movie/{tmdbId}/similar` | `page=1` → upstream title page. |
| GET | `jellyseerr/movie/{tmdbId}/recommendations` | `page=1` → upstream title page. |
| GET | `jellyseerr/movie/{tmdbId}/ratingscombined` | Upstream combined movie ratings. |
| GET | `jellyseerr/tv/{tmdbId}/similar` | `page=1` → upstream title page. |
| GET | `jellyseerr/tv/{tmdbId}/recommendations` | `page=1` → upstream title page. |
| GET | `jellyseerr/tv/{tmdbId}/ratings` | Upstream TV ratings. |
| GET | `jellyseerr/discover/trending` | `page=1`, discover filters → upstream discovery page. |
| GET | `jellyseerr/discover/movies` | `page=1`, discover filters → upstream discovery page. |
| GET | `jellyseerr/discover/tv` | `page=1`, discover filters → upstream discovery page. |
| GET | `jellyseerr/discover/movies/upcoming` | `page=1`, discover filters → upstream discovery page. |
| GET | `jellyseerr/discover/tv/upcoming` | `page=1`, discover filters → upstream discovery page. |
| GET | `jellyseerr/discover/tv/network/{networkId}` | `page=1`, discover filters → upstream discovery page. |
| GET | `jellyseerr/discover/movies/studio/{studioId}` | `page=1`, discover filters → upstream discovery page. |
| GET | `jellyseerr/discover/tv/studio/{studioId}` | Caller + enabled Seerr + TMDB key; positive `studioId`, `page=1` within `1..500`, optional `sortBy`. |
| GET | `jellyseerr/discover/tv/genre/{genreId}` | `page=1`, discover filters → upstream discovery page. |
| GET | `jellyseerr/discover/movies/genre/{genreId}` | `page=1`, discover filters → upstream discovery page. |
| GET | `jellyseerr/discover/tv/keyword/{keywordId}` | `page=1`, discover filters → upstream discovery page. |
| GET | `jellyseerr/discover/movies/keyword/{keywordId}` | `page=1`, discover filters → upstream discovery page. |
| GET | `jellyseerr/discover/genreslider/movie` | Upstream genre-slider rows. |
| GET | `jellyseerr/discover/genreslider/tv` | Upstream genre-slider rows. |
| GET | `jellyseerr/person/{personId}` | Positive person ID (`400` otherwise) → upstream person detail. |
| GET | `jellyseerr/person/{personId}/combined_credits` | Positive person ID → upstream filmography. |
| GET | `jellyseerr/collection/{collectionId}` | Upstream collection detail. |
| GET | `jellyseerr/overrideRule` | Request/discovery permission → upstream override-rule list. |
| POST | `jellyseerr/request/tv/{tmdbId}/seasons` | Positive TMDB route ID, request body → upstream request record. |
| GET | `jellyseerr/watchlist` | `page=1`, minimum 1 → caller's upstream watchlist page; uncached. |
| GET | `jellyseerr/issue` | Optional positive Seerr `mediaId`; `take=20` clamped `1..200`, `skip=0` minimum 0, `filter=all`, `sort=added` → upstream issue page. |
| GET | `jellyseerr/issue/{id}` | Positive Seerr issue ID (`400` otherwise) → upstream issue detail. |
| POST | `jellyseerr/issue` | Upstream issue JSON → upstream issue record. |

Search trims long queries to at most 256 UTF-16 units without splitting a surrogate pair; blank query returns `400` with `code:"missing_query"`. Feed/similar/recommendation pagination is generally forwarded without bounds checks; only the documented search, watchlist, and TV-studio actions clamp or validate it.

Discover routes that say “discover filters” forward nonempty query values for `sortBy`, `primaryReleaseDateGte`, `primaryReleaseDateLte`, `firstAirDateGte`, `firstAirDateLte`, `voteAverageGte`, `voteAverageLte`, `withRuntimeGte`, `withRuntimeLte`, `certification`, `watchRegion`, `language`, `keywords`, `watchProviders`. Upstream Seerr interprets these strings.

```bash
curl -G -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  --data-urlencode 'query=The Matrix' --data-urlencode 'page=1' \
  "$JE_URL/jellyseerr/search"

curl -X POST "$JE_URL/jellyseerr/request" \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H 'Content-Type: application/json' \
  --data '{"mediaType":"movie","mediaId":603,"is4k":false}'

curl -X POST "$JE_URL/jellyseerr/request/tv/1399/seasons" \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H 'Content-Type: application/json' \
  --data '{"mediaType":"tv","mediaId":1399,"seasons":[1],"is4k":false}'

curl -X POST "$JE_URL/jellyseerr/issue" \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H 'Content-Type: application/json' \
  --data '{"mediaId":42,"issueType":1,"message":"Playback problem"}'
```

The issue example's `mediaId` is a **Seerr media-record ID**. Nonpositive issue-list `mediaId` is ignored.

On the seasons route, a supplied string `mediaType` must equal `tv` case-insensitively, and a supplied numeric `mediaId` must match the route ID; failures return `400` with `media_type_mismatch`/`media_id_mismatch`. These conditional guards do not validate every possible JSON property type. The route forwards the body rather than filling missing IDs.

Successful general request POST can auto-enable Spoiler Guard when configured; the separate seasons action does not run that hook.

Quota enrichment preserves upstream unlimited-side representations; missing `nextResetAt` does not itself mean unlimited.

Collections accepts comma-separated positive movie IDs, one to nine digits. It ignores malformed values and duplicates. Input is limited to 1100 characters and 100 distinct IDs; invalid/oversized input returns `400`. Response:

```json
{"results":{"603":{"id":2344,"name":"The Matrix Collection","posterPath":"/poster.jpg","backdropPath":"/backdrop.jpg"},"999":null}}
```

`null` means a successful lookup found no collection; failed/refused lookups are omitted. Seerr movie detail is used first; a configured TMDB key enables fallback when Seerr names no collection.

Setup failure returns `503`, missing caller claim `403`; failed caller linkage after a supplied claim returns `200 {"results":{}}`. It is `no-store`.

TV-by-studio queries TMDB directly and returns a Seerr-shaped discover page. It needs enabled Seerr and a TMDB key, but does not impose the ordinary linked-user prerequisite before querying TMDB.

Only titles accessible in the caller's library receive library/media status enrichment.

It uses only `studioId`, `page`, and supported `sortBy` values: `popularity`, `first_air_date`, `vote_average`, `vote_count`, `name`, `original_name`, each with `.asc` or `.desc`. Unsupported sorts are ignored.

Setup returns `503`, invalid ID/page `400`, TMDB failure `502`, cancellation `499`; parental filtering still applies.

### Seerr cache behavior

Use these caching rules when deciding whether a response may be stale.

Shared response entries cover content-only genre sliders, genre/keyword lookups, and person resources. Search, discovery, details, similar/recommendation, and collection responses are caller-scoped. Parentally restricted GETs are filtered even on cache hits. Watchlist and issues bypass normal response caching.

Negative user lookup is cached for 60 seconds. Successful request creation evicts corresponding cached movie/TV detail and subresources. Saving plugin configuration clears Seerr caches.

Reachability uses a separate 30-second cache; disabling normal response caching does not imply every status request probes upstream. Expect stale cached metadata until its TTL or invalidation event.

## TMDB Proxy & Metadata

Use local GUID routes for Jellyfin metadata, the generic TMDB route for external metadata, and Seerr-backed helpers when working through Seerr.

| Setting | Default | What it does |
|---|---|---|
| **TMDB API Key** | `""` | `TMDB_API_KEY`; required by the generic proxy and provider batch. |
| **Default Region** | `"US"` | `DEFAULT_REGION`; fallback for regional provider lookup. |

| Method | Path | Access | Inputs → response |
|---|---|---|---|
| GET | `studio/{studioId}` | Authenticated | Jellyfin GUID → `{id,name,tmdbId,type}`. |
| GET | `boxset/{boxsetId}` | Authenticated | Jellyfin BoxSet GUID → `{id,name,tmdbId,type}`. |
| GET | `genre/{genreId}` | Authenticated | Jellyfin GUID → `{id,name,type}`. |
| GET | `person/{personId}` | Authenticated | Jellyfin GUID, optional query `itemId` GUID → person info. |
| GET | `people/info` | Authenticated | Query `ids` (GUID list), optional `itemId` → `{"people":{"<personIdN>":<info>}}`. |
| GET | `tmdb/search/person` | Seerr-linked | Required nonblank `query` → Seerr search response, page 1. |
| GET | `tmdb/search/keyword` | Seerr-linked | Required nonblank `query` → Seerr keyword-search response. |
| GET | `tmdb/genres/movie` | Seerr-linked | Upstream Seerr movie genre list. |
| GET | `tmdb/genres/tv` | Seerr-linked | Upstream Seerr TV genre list. |
| GET | `tmdb/validate` | Administrator | Supplied query `apiKey` → `{"ok":true}`. |
| GET | `tmdb/{**apiPath}` | Authenticated | TMDB `/3/` resource path and query → upstream TMDB JSON/status. |
| GET | `watch-providers` | Authenticated | Query `items`, optional `region` → regional flat-rate provider map. |
| GET | `logo/{size}/{file}` | Anonymous | `size` `w45` or `w92`, `file` a logo file name the server has seen in a Logos lookup, spelled exactly as TMDB spells it (case-sensitive) → the image from the server's cache; `404` otherwise. |

Local lookups return `404` if absent and `500` on lookup errors. Boxset checks type; single studio/genre/person actions do not explicitly enforce their named type. They are local metadata lookups, rather than Seerr proxies.

Batch people ignores malformed/empty GUIDs, de-duplicates, and rejects no valid IDs or more than 100 distinct valid IDs with `400`. Missing/non-Person batch entities are omitted.

Person info extends `{id,name,tmdbId,type}` with nullable `birthDate`, `deathDate`, `birthPlace`, `currentAge`, `ageAtDeath`, `ageAtItemRelease`, and boolean `isDeceased`.

Optional `itemId` contributes its premiere date only when accessible to the caller. Optional TMDB enrichment falls back to local data after failure or six seconds. Person reads can return `499` on disconnect.

```bash
curl -G -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  --data-urlencode 'ids=9285e8b54149414941494edb9e464dcd' \
  "$JE_URL/people/info"

curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  "$JE_URL/tmdb/movie/603?language=en-US"
```

The generic proxy uses the saved key, returning `503` if absent. It forwards TMDB paths/query to `/3/` using that key.

Restricted callers can receive `403` with `code:"parental_block"` for unclassified/list/search/discover/trending paths, denied titles, or query parameters outside `language`, `page`, `region`, `include_adult`, `query`. Classified title resources are checked against parental policy. The named search/genre helpers above instead use Seerr setup, caller linkage, and proxy errors.

Successful generic responses use `Cache-Control: private, no-cache`, ETag and `304` revalidation.

Server caching is 30 minutes for query paths such as search/discover/trending, six hours for lookups, and ten minutes for JSON `404` responses. A query string on a title lookup does not itself select the shorter TTL.

Compatible cold movie/TV title, release-date, provider, and review requests can join one bundled upstream lookup; path, query, and cache state determine whether bundling is possible. Other upstream statuses are retained; connection exceptions return `500`, disconnect `499`.

TMDB validation tests the **supplied** key, including an unsaved value: blank key `400`, rejected key `401`, other upstream statuses retained, connection exception `500`, with `{ok:false,message}` failures.

### Batch watch providers

Look up regional flat-rate providers for multiple movies or TV titles in one request.

`items` contains comma-separated `movie:<id>`/`tv:<id>` keys. IDs must be positive and one to nine digits. Malformed entries are ignored, equivalent numeric IDs de-duplicated. Maximum input length is 2048 characters and maximum distinct valid keys 100; empty/invalid/oversized input returns `400`.

Explicit nonempty `region` must be two uppercase letters. Omitted/empty region uses normalized **Default Region**, falling back to `US` if invalid. No Elsewhere UI toggle is required.

```bash
curl -G -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  --data-urlencode 'items=movie:603,tv:1399' --data-urlencode 'region=US' \
  "$JE_URL/watch-providers"
```

```json
{"region":"US","results":{"movie:603":[{"provider_id":8,"provider_name":"Netflix","logo_path":"/logo.jpg"}],"tv:1399":null}}
```

Provider names/availability in the example are illustrative. Only usable flat-rate entries are retained. `[]` means no retained provider; `null` means refused, failed, or unusable lookup. Parentally denied titles get null results.

Missing key/setup returns `503`; cancellation `499`. Successful responses use private revalidation, ETag and `304`.

### Logo images

The Logos tag group's images come from `GET /JellyfinEnhanced/logo/{size}/{file}` (for example `logo/w92/pbpMk2JmcoNnQwx5JGpXngfoWtp.jpg`). The route is anonymous like the CDN assets, because an `<img>` cannot send a Jellyfin token, but it is not an open TMDB proxy: only the sizes `w45` and `w92` and PNG, JPEG or WebP file names that came back from the server's own provider or company/network lookups are served. TMDB's image paths are case-sensitive, so a file name must match the lookup's spelling exactly: any other casing is an unknown file and returns `404` before the server's image cache, its failure cache or TMDB is consulted. The server fetches a missing image from TMDB's image server once (at most 256 KiB, `image/*` only, SVG refused), keeps it under Jellyfin's cache directory in `jellyfin-enhanced/logos` (at most 64 MB for both sizes together: past that the least recently read images are deleted and fetched again when asked for; a start removes abandoned downloads and files no lookup names), and answers with `Cache-Control: public, max-age=604800`, a strong `ETag` and `304` revalidation. A failed fetch returns `404` and is retried after ten minutes. Native Poster Tags draw the same cached files and never fetch during a poster request: a poster built on demand (server cache off, or no entry yet) uses the stored lookups only, draws the name chip or no logo for that render, and queues the missing lookups and images for one background warm (within the same concurrency and rate limits) that later posters pick up.

!!! note "Privacy"
    Browsers never contact TMDB for logos: the lookups and image downloads run on the server with the server's TMDB key, and clients only see the names and image paths in the tag cache. Without a key or internet access the group shows names.

## Spoiler Guard

Use caller routes to manage protection without replacing the raw state file.

All caller actions require a nonempty user-ID claim. Enable actions additionally resolve an existing caller and accessible item; administrator credentials cannot select another user through these URLs. See [Spoiler Guard settings](../spoiler-guard/spoiler-guard-settings.md) for the administrator policy.

| Setting | Default | What it does |
|---|---|---|
| **Enable Spoiler Guard** | `false` | `SpoilerBlurEnabled`; gates pending POST and apply-existing preview/start. Other state-management routes remain callable. |
| **Auto-enable Spoiler Guard on Seerr request** | `false` | `SpoilerAutoEnableOnSeerrRequest`; hooks successful general Seerr request POSTs, alongside the master setting. |

### State and preferences

Read your protection lists and preferences here. Preference POSTs replace the complete preference object.

| Method | Path | Access | Request → response |
|---|---|---|---|
| GET | `spoiler-blur/series` | Caller | Full `{Series,Movies,Collections,PendingTmdb,Prefs}` state; `no-store`. |
| GET | `spoiler-blur/user-prefs` | Caller | `SpoilerBlurUserPrefs` object. |
| POST | `spoiler-blur/user-prefs` | Caller | Complete preference object, at most 8 KiB → `{success:true,prefs:<submitted preferences>}`. |

The four dictionaries default to `{}` and use case-insensitive keys. Library keys are N-format GUIDs. Pending keys are `movie:<tmdbId>` or `tv:<tmdbId>`.

| Dictionary | Entry fields (strings default to `""`) |
|---|---|
| `Series` | `SeriesId`, `SeriesName`, `EnabledAt` |
| `Movies` | `MovieId`, `MovieName`, `EnabledAt` |
| `Collections` | `CollectionId`, `CollectionName`, `EnabledAt` |
| `PendingTmdb` | `MediaType`, `TmdbId`, `DisplayName`, `RequestedAt` |

`EnabledAt`/`RequestedAt` are ISO timestamps. Collection protection applies to member movies; the collection itself remains the entry point.

`Prefs` defaults to this object (null fields can be omitted on the wire):

```json
{
  "HideSeriesDescriptions": null,
  "HideEpisodeDescriptions": null,
  "HideTags": null,
  "HideChapterNames": null,
  "HideTaglines": null,
  "HideRatings": null,
  "HideAirDate": null,
  "ReplaceEpisodeTitles": null,
  "HideCast": null,
  "HideReviews": null,
  "HideTrickplay": null,
  "UseAdvancedCategories": null,
  "SkipDisableConfirm": false
}
```

Nullable category flags inherit policy with null, and opt out of stripping with false. True never enables a category that the administrator disabled. `HideTrickplay=false` opts out of trickplay seek-preview protection (`SpoilerBlurTrickplay`). `UseAdvancedCategories=false` instead restores uniform stripping by opting out of category reveals.

POST replaces preferences rather than patching them; missing body returns `400`.

Missing files return default state/preferences with `200`. These caller reads strict-read existing files: corrupt data is backed up/reset and reported as `503 {success:false,message}` with a corruption event.

Preference write failures return `503` for corruption or `500` for other failures. The raw own/admin `spoilerblur.json` GET remains lenient.

```bash
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/spoiler-blur/series"
curl -X POST "$JE_URL/spoiler-blur/user-prefs" \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H 'Content-Type: application/json' --data '{"HideReviews":false}'
```

### Enable, disable, and pending protection

Add or remove protection for library items. Use pending protection for TMDB titles that may be added to your library later.

| Method | Path | Body/query → response |
|---|---|---|
| POST | `spoiler-blur/series/{seriesId}` | No body → `{success:true,seriesId,name}`. |
| DELETE | `spoiler-blur/series/{seriesId}` | No body → `{success:true,seriesId,removed}`. |
| POST | `spoiler-blur/movies/{movieId}` | Optional JSON `{MovieName:"…"}`, 8 KiB → `{success:true,movieId,name}`. |
| DELETE | `spoiler-blur/movies/{movieId}` | No body → `{success:true,movieId,removed}`. |
| POST | `spoiler-blur/collections/{collectionId}` | Optional JSON `{CollectionName:"…"}`, 8 KiB → `{success:true,collectionId,name}`. |
| DELETE | `spoiler-blur/collections/{collectionId}` | No body → `{success:true,collectionId,removed}`. |
| POST | `spoiler-blur/pending/{mediaType}/{tmdbId}` | Optional query `displayName` → `{success:true,promoted,jellyfinId,name}`. |
| DELETE | `spoiler-blur/pending/{mediaType}/{tmdbId}` | No body → `{success:true,removed,removedFrom,jellyfinId}` when removed. |

Library IDs must parse as GUIDs (`400` otherwise). POST requires the correct accessible Series/Movie/BoxSet type (`404` for missing, inaccessible, or wrong type); unresolved caller returns `403`.

Supplied movie/collection names have markup and angle brackets removed and are capped at 200 characters. Re-enabling preserves the existing timestamp. DELETE is idempotent: absent protection returns `200` with `removed:false`.

Pending type is normalized to `movie`/`tv`; TMDB ID must parse as a positive integer (`400` otherwise). Optional `displayName` is capped at 200 characters with control/format characters removed. Master off returns `503`.

Existing accessible titles may promote immediately, returning `promoted:"series"` or `"movie"` with a Jellyfin ID/name; otherwise `promoted:"pending"` with null/omitted ID/name. Future library additions can promote pending entries automatically.

New pending entries cap at 500 per user (`429`, `code:"pending_cap_exceeded"`); existing entries can still be updated/promoted.

Pending DELETE can remove both pending and promoted protection. A no-op returns `{"success":true,"removed":false,"removedFrom":"none"}`; successful removal names `series`, `movie`, or `pending`.

These mutations strict-read and return `503` on corruption, `500` on storage errors.

```bash
curl -X POST -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  "$JE_URL/spoiler-blur/series/9285e8b54149414941494edb9e464dcd"
curl -X POST -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  "$JE_URL/spoiler-blur/pending/tv/1399?displayName=Game%20of%20Thrones"
```

### Health and apply-existing task

Use health routes to review and acknowledge recorded corruption events. As an administrator, you can also preview, start, and monitor protection for existing titles in the saved auto-enable scope.

| Method | Path | Access | Contract |
|---|---|---|---|
| GET | `spoiler-blur/health` | Caller/admin | `{healthy,corruptionEvents:[{userId,userDisplay,at,reason}]}`. |
| DELETE | `spoiler-blur/health/{targetUserId}` | Own/admin | Acknowledge event → `{"success":true}`. |
| GET | `spoiler-blur/apply-existing/preview` | Administrator | Optional `skipStarted=false` → dry-run summary. |
| POST | `spoiler-blur/apply-existing` | Administrator | Optional `skipStarted=false`, no body → `202 {success:true,taskId,completedRuns}`. |
| GET | `spoiler-blur/apply-existing/status` | Administrator | `{taskId,state,progress,completedRuns,lastRun}`; `no-store`. |

Health reports retained **process-lifetime corruption history**, rather than testing the blur engine. Viewers see self, administrators all users. DELETE accepts a parseable target GUID (`400` otherwise); cross-user denial is `403`. Acknowledgment clears the event, rather than repairing files.

Preview/start use the saved auto-enable scope and return `409` if the master is off or a run is busy.

Preview failure returns `500`; start returns `503` if the scheduled task is unavailable.

Status works independently of the master toggle, returning `state:"Unavailable"` with null task/progress if no worker exists. Run history/counters are since server start.

??? note "Apply-existing summary fields"

    Summary fields are `DryRun`, `SkipStarted`, `SeriesInScope`, `MoviesInScope`, `Users`, `UsersAffected`, `SeriesArmed`, `MoviesArmed`, `AlreadyArmed`, `SkippedWatched`, `SkippedStarted`, `UsersFailed`, `Cancelled`, nullable `Error`, `StartedAt`, nullable `FinishedAt`, `ElapsedMs`, and `PerUser`.

    Each `PerUser` entry has `UserId`, `UserName`, `IsDisabled`, `VisibleTitles`, `Series`, `Movies`, `AlreadyArmed`, `SkippedWatched`, `SkippedStarted`, `Failed`. Status `lastRun` uses this same summary, or null before a completed run.

```bash
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  "$JE_URL/spoiler-blur/apply-existing/preview?skipStarted=true"
```

## Tags, Cache & Watch Data

Use these own/admin routes to retrieve data visible to the target account. Missing target accounts or inaccessible items return `404`; unauthorized target access `403`; invalid typed GUIDs/query values can return `400`. Metadata may be stripped by Spoiler Guard.

| Setting | Default | What it does |
|---|---|---|
| **Server-Side Tag Cache** | `true` | `TagCacheServerMode`; gates cached delivery and rebuild. |
| **Enable Tag Styles** | `false` | `TagStylesEnabled`; enables effective overrides. |
| **Apply to** (Tag Styles) | `"both"` | `TagStyleTarget`; `both`, `web`, or `native`. |
| **Preset** (Tag Styles) | `"default"` | `TagStylePreset`; `default`, `glass`, `outline`, `dark`, `light` or `mono`. |
| **Let users pick their own preset** | `false` | `TagStylesAllowUserPreset`; honours each user's `TagStylePreset` (below). |
| **Enable Native Poster Tags (Experimental)** | `false` | `NativePosterTagsEnabled`; delivery toggle, rather than a preview prerequisite. |

| Method | Path | Access | Request → response |
|---|---|---|---|
| POST | `tag-cache/rebuild` | Administrator | No body → `{success:true,message:"Tag cache rebuild started in the background."}`. |
| GET | `admin/leaving-soon` | Administrator | No body → the Leaving soon source state `{Configured, Maintainerr, Collections, CollectionsFound, Items, Dated, LastSuccess, LastAttempt, NextRefresh, LastError}` (times Unix ms or null; `LastError` a short reason such as `HTTP 500`, `timed out` or `not reachable`). Never the URL, key or collection names. |
| POST | `admin/leaving-soon/refresh` | Administrator | No body → reads the Leaving soon source now (Maintainerr and/or the leaving collections), publishes changed `Leaving` facts to the tag cache, then answers the state as above. |
| POST | `admin/configuration` | Administrator | `{Changes:{Field:value}, Expected?:{Field:value}}` (PluginConfiguration field names, values as `GET /Plugins/{id}/Configuration` returns them) → `{values:{Field:stored}}`. Writes only these fields on top of the configuration the server holds now, through the normal configuration save and inside its critical section: a full configuration save that lands while the request waits is kept, never put back, and so is the server's own write of a field in place (maintenance toggle clear, translation refresh signal, analytics state), which takes the same lock. A field in `Expected` is the value read before editing it: when the server's value differs from it and from the new value, nothing is written and the answer is `409` `{conflicts:{Field:serverValue}}`. Only the Media Tags page's own fields are accepted (those its section modules declare, `Helpers/MediaTagsPageFields.cs`); any other field, API keys included (except the write-only Leaving soon Maintainerr key), is `400` naming it, and nothing is written. Each value is checked with the normalisers the server uses for that field (`TagLayoutRules`, `TagShapeRules`, `LanguageTagDisplay`, `TagLookValidation`, `RatingSourceSettings`, `TagStyleSet`, the anchor positions): an unknown, empty or blank layout, density, position, target, preset or source (none of the server's own values has an empty "inherit"), a number outside its range (day windows and cache lifetime 1–365, order 1–99, minimum score 0–10, caps 0–10), a text over its limit (1024 characters unless the field has its own), more than 500 server-wide item looks (`TagLookItemOverrides`, also refused when an entry would be dropped or merged) or a document the normaliser would drop is `400` `{error:"Invalid value for 'Field': reason."}`; accepted values are stored in their canonical spelling and returned. The entire body, including `Changes`, `Expected` and JSON escaping, is limited to 8 MiB: a larger one is refused while it is read, before anything is checked or written (Jellyfin's exception middleware answers `500` "Error processing request."). Used by the Media Tags settings page and by the item editor's **For everyone** (`TagLookItemOverrides` only, using the per-entry mutation below). |
| GET | `tag-cache/summary` | Administrator | No body → `{enabled, entries, lastModified, rebuilding}`: whether the server tag cache is on, how many items it holds, its last change (Unix ms, `0` = never) and whether a full build is running or a manual one is queued. Counts are `0` while the cache is off. Used by the Media Tags settings page's Overview. |
| GET | `tag-cache/{userId}` | Own/admin | Optional `since` signed 64-bit cursor → cache envelope below; ETag/`304`. |
| POST | `tag-data/{userId}` | Own/admin | Raw nonempty string array, at most 200 IDs; optional `mediaSourceId`, optional `latestEpisode=true` → `{Items:[<item>],StripRevision}`. |
| GET | `status-tags/series?ids=…` | Authenticated, user-filtered | Up to 50 series item IDs → `{id:{status,lastAired,nextAired}}`; see below. |
| GET | `status-tags/trending` | Authenticated | `{source,movies,series}` trending ranks for Status Tags; see below. |
| GET | `item-stats/{userId}/{itemId}` | Own/admin | Optional `mediaSourceId` → `{success,size,progress,totalPlaybackTicks,totalRuntimeTicks}`. |
| GET | `file-size/{userId}/{itemId}` | Own/admin | Optional `mediaSourceId` → `{success,size}`. |
| GET | `watch-progress/{userId}/{itemId}` | Own/admin | `{success,progress,totalPlaybackTicks,totalRuntimeTicks}`. |
| GET | `tag-styles` | Authenticated | Effective web override set. |
| GET | `tag-styles/catalog` | Authenticated | Shipped labels and palettes only; no administrator configuration. |
| GET | `native-poster-tags/preview/{itemId}` | Administrator | JPEG diagnostic preview; query below. |

`Changes.TagLookItemOverrides` also accepts `{Set:[itemLook,...], Remove:[itemId,...], Expected:{itemId:previousEntryOrNull,...}}`. Every affected id must occur once across Set/Remove and in Expected; null means no entry was present. The server checks all affected entries and merges the update into the latest list inside one configuration write lock. A target changed meanwhile causes `409` with the latest list; unrelated changes are kept. The item editor retries once after a fresh read. Editor, Rules-list remove and entry Undo send only affected entries, with at most 500 distinct affected IDs across Set and Remove. The Rules store captures this per-entry intent and its Expected stamps when the user acts, then rebases pending operations onto each save response; newly returned remote entries never become implicit removals. A canceled delta resolves locally without a PATCH only before a write starts or after a definitive rejection (a conflict, or a 4xx body naming the field); other fields in the same atomic patch still save. Network errors, 5xx responses and lost responses leave the write outcome unknown, so pending intent, including Undo, requires a successful acknowledging PATCH before the page reports saved. A validated empty mutation from an older client succeeds without writing configuration. An addition that would exceed the final-list cap of 500 without a corresponding removal is refused.

Portable import and import Undo are explicit whole-list replacements: `Changes.TagLookItemOverrides` is an array/null and `Expected.TagLookItemOverrides` is the whole list the page read. They are never converted to per-entry mutations. Replacement is bounded by the final-list cap of 500 and the 8 MiB body envelope, so replacing 500 entries with 500 disjoint entries is supported even though a mutation would affect 1,000 IDs. Edits made before the replacement is acknowledged fold into its pending value; failure preserves the whole replacement for Retry, and Keep mine / Take theirs resolves that entire list. Only after successful acknowledgement do ordinary per-entry edits use the mutation transport again.

The admin import preview and configuration patch both allow 8 MiB including JSON escaping and Expected. A 500-entry list populated with the largest valid looks (nine slots and caps, two fully populated shape looks, 64-character colour preset, maximum timestamp) measures **926,353 bytes** in an admin export and **1,846,076 bytes** in a replacement with both Changes and Expected, leaving over four times headroom. Single-entry edit/remove/Undo requests measure 1,957–3,798 bytes. User import/preset endpoints retain their 64 KiB limit.


The Tier 2 page allowlist also includes `TagScale`, `TagGap`, `TagEdgeSpacing`; `AwardsTagsEnabled`, `AwardsTagsPosition`, `AwardsTagsImdb`, `AwardsTagsCertifiedFresh`, `AwardsTagsOscar`, `AwardsTagsEmmy`, `AwardsTagsLetterboxd`, `AwardsTagsImdbList`, `AwardsTagsLetterboxdList`, `AwardsTagsRefreshHours`; `LogoTagsEnabled`, `LogoTagsPosition`, `LogoTagsMovieMode`, `LogoTagsSeriesMode`, `LogoTagsRegion`, `LogoTagsMaxLogos`; and `CustomTagsEnabled`, `CustomTagsPosition`, `CustomTagRules`. The list fields require a numeric id or owner/slug, cadence is 1–168 hours, logo maximum is 1–2, and an empty logo region follows the server. Custom documents must contain at most 20 complete distinct rules accepted by `CustomTagRuleSet` (valid match, bounded value and label, non-reserved label and known optional icon). Invalid patches are refused as a whole. `CustomTagRuleKey` and `CustomTagRuleSources` are never page fields and return 400. The legacy Tag Styles preset alias `custom` is accepted as `default`; blank presets are refused.

The Tier 3 Leaving soon section adds `StatusTagsLeaving`, `StatusTagsDirectPlay`, `LeavingSoonMaintainerrUrl` (empty, or an `http(s)` address without credentials, query or fragment; 512 characters), `LeavingSoonMaintainerrApiKey` (printable ASCII without spaces; 256 characters), `LeavingSoonCollections` (at most 20 names of at most 200 characters, one per line or comma separated; 4096 characters) and `LeavingSoonRefreshHours` (1–168).


```bash
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/tag-cache/$USER_ID"
curl -X POST "$JE_URL/tag-data/$USER_ID" \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H 'Content-Type: application/json' \
  --data '["9285e8b54149414941494edb9e464dcd"]'
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  "$JE_URL/item-stats/$USER_ID/9285e8b54149414941494edb9e464dcd"
```

### Tag cache and batch shape

Use the cache for full snapshots or updates since a cursor. Use `tag-data` to fetch a batch of items directly, including when cached delivery is disabled. Web cards look up their valid `data-id`/`data-itemid` before the artwork URL, so an episode borrowing its season's poster requests the episode's data. Without a valid card id, the artwork id remains a fallback.

Cache disabled returns `404` for GET and `400` for rebuild. A busy rebuild returns `409`. Cached response:

```json
{"version":1,"timestamp":1767441600000,"servedAt":1767441601000,"filterRevision":"EXAMPLE","count":0,"items":{},"reviewRatings":{}}
```

`items` maps Jellyfin item IDs to `TagCacheEntry` objects. `timestamp`, `servedAt`, and entry `LastUpdated` use Unix **milliseconds**; `version` identifies a cache generation.

Use the returned `timestamp` as the next `since` cursor, rather than an ISO timestamp or `servedAt`. Deltas include changed entries plus guarded entries so watched/protection changes update their metadata. `servedAt` orders stored snapshots across restarts.

If `filterRevision` changes, fetch a full response and replace your copy because access/stripping changes can invalidate entries absent from a delta. Successful responses support ETag revalidation with `Cache-Control: no-cache`.

`reviewRatings` maps `mediaType:tmdbKey` to `{average,count}` under the **caller's** review visibility rules. It is present only when both **Enable User Written Reviews** and **Show average user rating on poster cards** are enabled; otherwise it is null/omitted.

It contains the full aggregate map even on deltas; absent keys mean no visible rated reviews.

| Cache entry field | Type |
|---|---|
| `Type`, `TmdbId`, `SeriesTmdbId`, `OfficialRating`, `SeriesId`, `LibraryId` | Nullable strings |
| `SeasonNumber`, `EpisodeNumber` | Nullable integers |
| `Genres`, `AudioLanguages`, `PartialAudioLanguages`, `SubtitleLanguages` | Nullable string arrays |
| `CommunityRating`, `CriticRating` | Nullable numbers |
| `Awards` | Optional immutable title facts: nullable `ImdbRank`, `LetterboxdRank` (1–250), booleans `CertifiedFresh`, `OscarWinner`, `EmmyWinner`, nullable `OscarYear`, `EmmyYear`; movie/series only, stripped with scores |
| `Ratings` | Optional object of nullable native-unit scores: `imdb`, `tmdb`, `rtCritic`, `rtAudience`, `metacritic`, `letterboxd`, `trakt`; no key or upstream data means absent |
| `LastUpdated` | Integer milliseconds |
| `DateCreated`, `PremiereDate`, `LatestEpisodeAdded` | Nullable integer milliseconds |
| `Status` | Nullable Jellyfin series status string |
| `LatestEpisodeAired` | Nullable integer milliseconds, series/season |
| `LatestEpisodeIndex`, `EpisodeIndex` | Nullable `{Season,Episode,IsLast}`; `IsLast` is nullable when unresolved |
| `SeasonPremiere` | Nullable `{Season,Aired}`; newest regular season's episode 1 for a series, the season's own episode 1 for a season |
| `SeasonAddedSpan` | Nullable `{First,Last,Count}` for season episode added dates |
| `StreamData` | Nullable `{Streams,Sources,ItemName,ItemPath}` |
| `Source`, `Edition` | Nullable canonical naming labels, computed server-side before basename trimming |
| `CustomTags` | Nullable string array: the Custom tag rules the item matches (see below) |
| `Logos` | Optional array (at most two) of `{kind,name,logo}`: `kind` is `provider`, `network` or `studio`, `logo` an optional TMDB image path for the logo route below; seasons and episodes carry their series'. Present only while the administrator or at least one user has the Logos group on; removed with the genres by Spoiler Guard's tag strip |

The Logos group's per-user settings are `LogoTagsEnabled` (default false) and `LogoTagsPosition` (default `"bottom-left"`), with `logos` as a group id in `TagLayouts`, `TagGroupOrder` and `TagGroupCaps` (cap 0 shows every logo an entry carries). The administrator's `LogoTagsMovieMode` (`provider`, `studio`, `off`; default `provider`), `LogoTagsSeriesMode` (`network`, `provider`, `off`; default `network`), `LogoTagsRegion` (two letters, empty uses `DEFAULT_REGION`) and `LogoTagsMaxLogos` (1 or 2, default 1) decide what entries carry; unknown values fall back to the defaults on save. Provider mode falls back to the studio or network when no subscription service is known for the region. Providers come from TMDB watch providers, and network or studio logos from TMDB details matched by name to Jellyfin's studios; both lookups are kept by the server for a day (failures retried after an hour) in `tag-logos.json` beside the tag cache (a lookup both not refreshed for 31 days and not read by an entry build, batch lookup or native poster for 30 days, such as a title no longer in the library or another region's, is dropped with the logo images only it named; one still read keeps its last data while refreshes fail, for example without a TMDB key), warmed before full builds and the daily reconcile, for batch items within a three-second budget, and in the background for native posters built on demand. Without a TMDB key or internet access entries carry names only.

Source rating preferences are `RatingTagsSources` (ordered string array; null preserves legacy include switches, empty hides source scores), `RatingTagsMinScore` (finite 0–10, default 0), and `RatingTagsColorByScore` (boolean, default false). They are per-user preferences with public admin defaults, seeded for new users and copied by reset-all-users. Unknown source ids and duplicates are removed on save. `Ratings` is immutable shared metadata, removed with Community/Critic scores by Spoiler Guard.

`SubtitleLanguages` is the lowercase union of subtitle-track languages, deduplicated across forced/SDH tracks. Series and seasons union their episodes; collections union their members. It follows the same access filtering and Spoiler Guard tag stripping as `AudioLanguages`; clients must replace their stored cache when `filterRevision` changes. Subtitle streams do not enter the quality-tag stream summary.

`CustomTags` lists the ids of the administrator's Custom tag rules the item matches, in the rule order of when it was matched. Treat it as a set: the web and native renderers draw matches in the current order of the public `CustomTagRules`, so reordering rules needs no re-match. A rule id is its match type and 16 hex digits of an HMAC of the match type and lower-cased value under a server-side key (`tag:1a2b3c4d5e6f7081`, `collection:9f2c1e0b7a6d5c4e`), so it never names, or lets a client confirm a guess of, the tag or collection. Tags are the item's own plus, for seasons and episodes, their series'; collections are those holding the item or its series, read from one pass over the collections a rule names. A collection match is served only to users whose access set includes a collection that produced it (library access and parental controls, as for the entries themselves); the rule collections a user cannot access are part of the response's `filterRevision`, so a stored copy is replaced when that access changes. Tag matches are not filtered: the tags are on the item. Clients look rules up by id in the public `CustomTagRules` and skip unknown ids, so label, icon and colour edits need no cache change. A configuration save that changes the set of matching rules re-matches every entry in the background (metadata only, no media reads; the snapshot stores the rules it was matched under). Collection changes seen by the library monitor patch the affected items, their seasons and episodes. Spoiler Guard's tag strip (`SpoilerStripTags`, the user's Hide Tags choice) removes it from guarded entries with `Genres`, in `tag-cache`, the `tag-data` stubs and native posters.

`LibraryId` is the library (collection folder) holding the item in N format; seasons and episodes carry their series'. Entries use the current cache schema (see below); older snapshots are discarded and rebuilt. `DateCreated` is when the item was added to the library. `PremiereDate` is set for movies, series and episodes. `LatestEpisodeAdded` is set for series and seasons only: the newest `DateCreated` among their non-virtual episodes. It is omitted for a caller who cannot see the episode it came from. Null fields are omitted.

`StreamData.Streams` contains `Type`, `SourceId`, `Language`, `Codec`, `CodecTag`, `Profile`, `Height`, `Width`, `Channels`, `ChannelLayout`, `VideoRangeType`, `DisplayTitle`; strings/numeric fields can be null. `Sources` contains `{Id,Path,Name,Source,Edition,RunTimeTicks}`; distinct track facts retain `SourceId` too. The browser remembers the selected merged version and filters streams, All-mode facts and source metadata together; native posters use the first version. These are trimmed tag data, rather than complete Jellyfin item DTOs. Directory paths are never returned; `Path` and `ItemPath` are basenames, including for Windows paths on a Unix server. The current persisted entry schema includes `Source` and `Edition`; older snapshots are discarded and rebuilt.

Batch `tag-data` ignores malformed/inaccessible IDs. Items contain `Id`, `Type`, `Genres`, `CommunityRating`, `CriticRating`, `Ratings`, `Awards`, `Logos`, `CustomTags` (collection matches filtered per caller; cache-off matches tags only), `OfficialRating`, `LibraryId`, `SeriesId`, `ProviderIds`, `Name`, basename-only `Path`, nullable `Source` and `Edition`, `SubtitleLanguages` (the selected media sources), trimmed `MediaStreams`, `MediaSources`, nullable `FirstEpisode`, and the nullable Unix-millisecond dates `DateCreated`, `PremiereDate` (movies, series and episodes) and `LatestEpisodeAdded` (series and seasons, only with `latestEpisode=true`; it counts only episodes the target user can see and costs one query per container).

With `latestEpisode=true`, batch items also carry the applicable `Status`, `LatestEpisodeAired`, `LatestEpisodeIndex`, `SeasonPremiere`, `SeasonAddedSpan` and `EpisodeIndex` facts. Episode sibling lookups use the target user too. The shared cache conservatively omits episode-derived aggregates if any contributor is inaccessible; its server-only `StatusEpisodeIds`/`LatestEpisodeId` are excluded from serialization. A changed `filterRevision` requires replacing stored data. Schema 26 invalidates older disk and IndexedDB copies, including sibling snapshots without the combined distinct quality sets, full All-mode series/season summaries, technical stream and SDH subtitle facts, Scenes, `Leaving` (including server-only collection provenance), cropped-video widths, version-scoped stream/quality/source facts, audio codec facts from the earlier AC-3/DTS-HD detector, summaries without parallel version-0 audio facts, per-track quality facts from the earlier text-based dynamic range, codec and sound detector, and language and naming facts that counted commentary/description audio, forced-only subtitles and edition or low-quality source words inside titles, and per-track sound facts that bucketed channel layouts into 7.1/5.1/2.0.

`StripRevision` is the server-issued revision of all effective data-affecting Spoiler Guard flags: tag stripping, rating stripping and title/overview stream sanitization, including user opt-outs and sorted guarded series/movie/collection sets. `none` means no relevant strip applies; `g2:` introduces the broader revision semantics. Bootstrap `Prefetched.TagStripRevision` comes from the same policy builder. `tag-pipeline.js` owns this authority, resets it to unknown immediately on user/guard/policy changes and passes each accepted answer's own value as `extras.stripRevision`. Session and generation checks reject obsolete answers. An invalidation also releases the retired queue drain immediately, so a pending first-episode lookup cannot block fresh guard data; that retired lookup cannot render or stamp its eventual answer.

`js/core/tag-renderer-base.js` validates every group's hot and persistent fallback entry through one versioned envelope with that revision, payload and timestamp. Unknown authority is a miss without initially deleting stored data; legacy, malformed, expired or mismatched entries are discarded from both tiers. Only authoritative batch answers can write stamped entries; IndexedDB, shared-cache and `/Items` projections cannot supply authority. Under `none`, entries may persist across loads; under a guard they are page-only because played state and collection membership may change without changing the policy digest. Empty stripped answers replace old facts and remain hits. Custom's rule fingerprint stays inside its payload. Full/delta refreshes invalidate all or affected fallback entries. Shared-cache access/filterRevision and native collection filtering remain independent requirements.

Streams use the trimmed stream fields listed above, and sources contain basename-only `Path` and `Name`.

Container `FirstEpisode` has `{Id,Type,Genres,NeedsStreamFetch:true}`; fetch that episode through `tag-data` for its streams and naming labels. A playable item chooses its naming labels from the highest-resolution version, then source quality for ties. `mediaSourceId` limits this choice to the requested version. Explicit edition markers precede known words; file and immediate parent-folder names are examined, and `.disc` stubs take precedence for source. Source/edition labels are removed with the corresponding Spoiler Guard title/tag stripping.

`CustomTagRules` (plugin configuration, administrators) is an array of at most 20 `{Match,Value,Label,Icon}` rules: `Match` is `tag` or `collection`, `Value` the tag or collection name (matched exactly, ignoring case and repeated spaces), `Label` the chip text and its Tag Styles label (at most 24 characters), `Icon` null or a genre icon name (`theaters`, `auto_awesome`, `menu_book`, …, the outlined Material Symbols subset JE ships). Saving drops rules with an unknown match type, an empty value or label, or a label of punctuation only (such as `*`, the Tag Styles whole-group key; every Unicode scalar value is in general category P or is white space, so a supplementary-plane mark such as U+10100 counts, while symbols such as `+` or `$` do not; the configuration page applies the same test), trims and collapses whitespace, cuts labels to 24 characters, drops unknown icons and keeps the first of rules with the same match type and value. `CustomTagRuleKey` is the secret the rule ids are derived from: generated when rules are first saved, kept across saves (a posted key never replaces a stored one) and never served outside the plugin configuration. The public configuration's `CustomTagRules` carries only `{Id,Label,Icon}` per rule, in table order; administrators also get `CustomTagRuleSources` (`{Id,Match,Value}`) in the private configuration, which the web client uses for the chip tooltip's source line. `CustomTagsEnabled` (false) and `CustomTagsPosition` (`top-left`) are per-user settings with public admin defaults, like the other groups; the layout settings accept the group id `custom` (order, caps with default 3, slots).

```json
{"CustomTagRules":[{"Match":"tag","Value":"4K Remaster","Label":"Remaster","Icon":"auto_awesome"},{"Match":"collection","Value":"Criterion","Label":"Criterion","Icon":null}]}
```

```json
{"CustomTagRules":[{"Id":"tag:1a2b3c4d5e6f7081","Label":"Remaster","Icon":"auto_awesome"},{"Id":"collection:9f2c1e0b7a6d5c4e","Label":"Criterion","Icon":null}]}
```

The per-user settings document and public admin defaults also carry `LanguageTagsShowAudio` (true), `LanguageTagsShowSubtitles` (false), `LanguageTagsStyle` (`flags` or `codes`, default `flags`) and `LanguageTagsCountBadge` (`off`, `only`, `both`, default `off`). Save normalizes unknown styles and modes to their defaults. These change presentation, not the cache facts.

Personal `settings.json` additionally accepts `LanguageTagsPriority` (nullable string array) and `LanguageTagsPriorityStrict` (nullable boolean). The existing own/admin `POST user-settings/{userId}/settings.json` validates the whole priority list before any write: at most 12 posted entries, each an assigned base ISO 639-1/639-2 code. Names, regional/BCP-47 tags, unknown codes, null entries and `und`/`mul` return `400`; the previous document stays intact. Codes are trimmed, lowercased and deduplicated in first-occurrence order through the existing audio-language equivalences (`eng`/`en`, `fre`/`fra`/`fr`, Tagalog/Filipino, Norwegian variants).

`null`/missing list means the live administrator `LanguageTagsPriority` string; `[]` explicitly disables prioritization. A nonempty personal list replaces that string. Strict `null`/missing inherits the live administrator boolean independently; `true` filters and `false` retains nonprioritized languages. Empty lists never filter. New-user seeding and reset-all leave both fields null. Admin public configuration retains its string/boolean types; personal settings use the array/nullable boolean types above.

The web client serializes saves of each user settings document. It applies a priority edit at its queue turn and restores it on failure before building the next queued document, preserving unrelated edits. Priority controls ignore further edits while saving; after failure, retry from the restored policy.

For example, merge these properties into the complete user document before posting:

```json
{"LanguageTagsPriority":["ja","en","fr"],"LanguageTagsPriorityStrict":null}
```

Personal matching uses canonical base languages across all codes represented by a grouped flag, with the server's regional merging unchanged. The same policy runs before audio/subtitle chip caps and Dual/Multi counting in web, hub preview and native resolution. Effective terms, strict mode and personal canonical-matching mode participate in the native settings digest and signed image variants; settings saves invalidate the user's native snapshot. No tag-cache entry/schema or access `filterRevision` change is needed: cached languages remain policy-independent facts. Refresh other open clients to load a saved preference.

Spoiler Guard can strip metadata before return and add `Tags` on stripped stubs. Series and movie stubs have no `ProviderIds` but keep the item's `TmdbId`, so Status Tags can still show a trending rank. `mediaSourceId` selects a media version; this route does not require cached delivery enabled.

Statistics aggregate playable descendants where applicable. `size` is bytes, `progress` an integer percentage, durations Jellyfin ticks (**10,000,000 ticks per second**). `mediaSourceId` filters size, rather than watch progress.

### Status Tags trending list

`status-tags/trending` returns the server-wide trending ranks behind the Status Tags badges:

```json
{"source":"tmdb-day","movies":{"1084244":54},"series":{"2190":23}}
```

`movies` and `series` map TMDB IDs to 1-based ranks across one combined list of at most 60 movies and series. `source` is `tmdb-day` (TMDB `trending/all/day`, pages 1–3, used when a TMDB API key is configured), `seerr-week` (Seerr `discover/trending`, TMDB's weekly list, used without a key or when TMDB does not answer or returns no movies or series), or null with empty maps when neither source answers. Seerr is called with the server API key only, without per-user parental filtering; the list holds only public TMDB IDs and ranks.

Any signed-in user may call it, non-administrators included. The server shares one copy for 30 minutes (5 minutes after an empty answer); saving the plugin configuration drops it. The web client fetches it when Status Tags first render and again after 30 minutes, or after 5 minutes following an empty or failed answer. With **Enable Status Tags** or **Show Trending rank** off in the plugin configuration, it returns `source:null` with empty maps without calling upstream.

### Status Tags series schedules

`GET /JellyfinEnhanced/status-tags/series?ids=<id>,<id>` requires authentication and 1–50 comma-separated Jellyfin item-ID strings. An empty request or more than 50 IDs returns `400`. Malformed/empty GUIDs, inaccessible items, non-series and series without a positive numeric TMDB ID are omitted. Lookup uses the caller's Jellyfin access (including parental limits and blocked tags); no target-user parameter is accepted.

```json
{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":{"status":"Returning Series","lastAired":{"date":"2026-10-28","season":2,"episode":10,"type":"finale"},"nextAired":{"date":"2027-03-01","season":3,"episode":1}}}
```

Item-ID keys use lowercase N-format GUIDs. Missing status/episode facts may be null; air dates are `yyyy-MM-dd` calendar dates, interpreted in the user's local calendar by the client. `type` is TMDB's `episode_type`, read from the latest aired season when absent from `tv/{id}`.

The endpoint returns `{}` without upstream calls while admin `StatusTagsEnabled` is off or no TMDB key is configured. Authoritative missing upstream series are omitted. Transient upstream failures (including 429, 5xx and transport exceptions) return `{ "<itemId>": { "retry": true } }` for the affected ID. The client retains its prior facts and retries after five minutes while a current card remains visible. Responses containing retry markers use `Cache-Control: private, no-store`; other responses use `Cache-Control: private, max-age=600`. TMDB responses are shared in `TmdbResponseCache` for six hours; credential changes use a separate cache key. At most four upstream lookups run concurrently, with 35 starts per ten-second window. The web client requests visible series and parent series of visible season/episode cards in batches of 50, caches answers for one hour, retries failures after five minutes, and drops stale card/user answers.

### Leaving soon and direct-play status badges

`LeavingSoonService` reads the administrator's source on the server only: `GET {LeavingSoonMaintainerrUrl}/api/collections` (header `X-Api-Key` when `LeavingSoonMaintainerrApiKey` is set, 30-second timeout, answers up to 16 MiB, the same address guard as the *arr URLs, through the named client `JellyfinEnhanced.Maintainerr`, which never follows a redirect: a 3xx answer is a failed refresh that keeps the previous answer, logged once per destination host, so the key never reaches another origin or an unchecked address) and/or the existing collections named in `LeavingSoonCollections`. A Maintainerr member's delete time is `addDate + deleteAfterDays` days (Unix ms UTC), and an answer with one more than ten years from now is refused as a failure (`a delete date is out of range`) that keeps the previous answer; renderers read a stored time no date type can hold as undated; inactive collections are skipped, and a member without a date (or the collection fallback) leaves undated. An empty list, or only inactive or empty collections, is a real empty answer; entries that are not collections and members without a usable id are skipped, but an answer with entries and no collection, or with members and none usable, is a failure that keeps the previous answer. Members match by `mediaServerId` (a Jellyfin item id) or, for a Plex-backed Maintainerr's movies and shows, by TMDB id. The answer is kept in `leaving-soon.json` next to the plugin configuration with a digest of the source, never the URL or key. **Refresh Leaving Soon Tags** (`JellyfinEnhancedRefreshLeavingSoonTags`) runs hourly and only acts once `LeavingSoonRefreshHours` (default 6) has passed; a failed request keeps the previous answer and retries after 15 minutes, doubling up to the interval; a source change refreshes at once in the background, and `POST admin/leaving-soon/refresh` forces one. Changed facts are published as `Leaving` (`{DeleteAt}`, Unix ms or null) on the cache entries of the items, their seasons and episodes (the earliest of the item's, its season's and its series'), through the normal generation/cursor boundary (the snapshot records which answer the cache last received, so an answer saved but not published, because the publish was cancelled or the server stopped, is published by the next run even when nothing is due or the answer is unchanged; the tag cache saves a publish on its normal debounce, so every cache load from disk re-applies the snapshot and an older cache file left by a crash or a failed save never shows facts the snapshot has replaced); `/tag-data` items carry the same `Leaving`, and served entries drop it while no source is set. A fact that only the leaving collections produced keeps those collections' ids on the server entry and is served (in `tag-cache`, `tag-data` and native posters) only to users whose access set includes one of them, like collection-matched `CustomTags`; the leaving collections a user cannot access are part of the response's `filterRevision`, and the ids themselves never reach clients. Maintainerr's facts name no Jellyfin collection, so they are served to anyone who can see the item. Card reads never contact Maintainerr. Public configuration has `StatusTagsLeaving`, `StatusTagsDirectPlay` (the starting family switches) and `LeavingSoonAvailable` (whether a source is set), never the source itself.

The direct-play warning is computed in the browser (`js/tags/tag-direct-play.js`) with Jellyfin's `POST /Items/{id}/PlaybackInfo` (`UserId`, the `DeviceProfile` jellyfin-web 12.1 would send: its `browserDeviceProfile` ported, because the bundle exposes no handle and the session capabilities the web client registers (`/Sessions`) carry no profile, with the app host's options for a video and its width/codec settings, or `window.NativeShell.AppHost.getDeviceProfile(builder)` in an app shell; `MaxStreamingBitrate` from the user's saved quality for the network, `maxbitrate-Video-{IsInNetwork}`, or the profile ceiling while automatic detection has measured nothing; `tests/fixtures/direct-play-web-12.1-chromium.json` holds the real client's profile captured in Chromium, `EnableDirectPlay`/`EnableDirectStream`/`EnableTranscoding`, `AutoOpenLiveStream:false`, `IsPlayback:false`; the profile is built again, with a new hash, when the signed-in user or any local setting its build read changes, compared at most once per task; a native shell's late answer applies only while its build's generation is current, which a user change or a changed setting ends at once, and the user and setting values that build read still hold, otherwise it is ignored and the profile built again); items Jellyfin's `PlaybackInfo` would refresh with a remote probe are not looked up (it does so when the item's path ends in `.strm`, probed before or not, and when a video's first media source lists no video stream): a `.strm` file name in the cache entry's `StreamData.ItemPath` or a `StreamData.Sources[].Path` (the `/tag-data` item's `Path` or `MediaSources[].Path`), or a stream list whose first source (matched by `SourceId` when streams carry one) has no `Video` stream; items with no stream list are looked up; the first media source's `SupportsDirectPlay`, `SupportsDirectStream` and `TranscodeReasons` (or the `TranscodeReasons` query of its `TranscodingUrl`) decide the badge. Requests are sent with `fetch` and the headers `ApiClient` sends (`ApiClient.ajax` takes no abort signal and sets no timeout on a POST): its own `Authorization` from `setRequestHeaders`, `MediaBrowser Client="…", Device="…", DeviceId="…", Version="…", Token="…"` (composed from its accessors where it has no such method), so the server attributes each lookup to this browser's session and device, each with a 15-second deadline covering the answer's body: past it the request is aborted, its slot frees at once, an answer arriving later is ignored, and the item counts as a failed lookup (asked again after ten minutes). At most two requests are on the network at once; a reset (renderer teardown, user switch) drops their answers but not their slots, which free when they settle or reach their deadline. Answers are stored in the browser's tag cache store (IndexedDB database version 3, store `directPlay`, keyed `scope|profileHash|itemId`, the hash covering the profile and the bitrate, at most 2,000 per scope) for a day. No plugin endpoint is involved and native posters never draw it.

### Style and native-preview contracts

Read effective web styles or the shipped style catalog. As an administrator, use native preview to inspect how tags render on an item's artwork.

`tag-styles` (any signed-in user) returns every chip's effective colours, already resolved field by field (label override, then group override, then the preset palette). Optional `preset` query: the caller's own preset, honoured only while **Let users pick their own preset** is on; otherwise the admin's preset applies.

```json
{"v":2,"preset":"glass",
 "quality":{"*":{"background":"rgba(255, 255, 255, 0.161)","border":"rgba(255, 255, 255, 0.349)","color":"rgba(255, 255, 255, 1)"},"4K":{…}},
 "age":[{"ratings":["PG-13","TV-14"],"background":"…","border":"…","color":"…"}],
 "ageDefault":{…},
 "rating":{"community":{…},"critic":{…},"userReview":{…}},
 "genre":{"*":{…},"horror":{…},"science fiction":{…}},
 "status":{"added":{…},"newMovie":{…},"newSeries":{…},"newEpisode":{…},"trending":{…}},
 "language":{"background":null,"border":"…","color":null},
 "logos":{"provider":{…},"company":{…},"text":{…}},
 "custom":{"*":{…},"Remaster":{…}}}
```

Colour objects have `background`, `border`, `color` (null keeps the built-in colour). `quality` and the status/rating maps list only chips with a non-default colour; `*` covers quality labels outside the catalog and `ageDefault` age ratings outside the colour sheet. `age` lists each age board with every rating it covers. `custom` has `*` (every Custom chip) and each Custom label with a colour of its own; `genre` likewise has `*` (every genre chip: the preset and group colours) and each genre label with a colour of its own, which the web matches on the chip's `data-je-genre` (only these entries colour the genre's `.genre-text` name too; `*` leaves the names as they were). Before genres had their own labels `genre` was a single colour object; the web still reads one as `*`. With Tag Styles off, a native-only target, or the default preset and no overrides, every map is empty and the single objects are null. Missing configuration returns `503`.

`TagStyleOverrides` stores a version 2 document, `""` when nothing is overridden:

```json
{"v":2,"preset":"glass",
 "groups":{"quality":{"background":"rgba(30, 136, 229, 1)","text":"rgba(255, 255, 255, 1)"}},
 "labels":{"quality:HEVC":{"background":"rgba(239, 108, 0, 1)"},"ageRating:9":{"border":"rgba(0, 0, 0, 0)"},"status:trending":{"text":"…"}}}
```

Groups are `quality`, `ageRating`, `rating`, `genre`, `status`, `language`, `awards`, `logos`, `custom`. Custom labels use `custom:<label>` (up to 24 characters; punctuation-only labels are reserved). Logos labels are `logos:provider|company|text`. Awards labels are `awards:imdbTop250|certifiedFresh|oscar|emmy|letterboxdTop250`. Labels are `group:label`: quality catalog labels, age board ids from the catalog, `rating:community|critic|userReview`, `genre:<genre>`, `status:added|newMovie|newSeries|newEpisode|trending|new_season|season_premiere|season_finale|series_finale|complete_season|airing_today|airs_date|returns_date|coming_soon|returning|ended|cancelled` and `language:flag|code|subtitles|countBadge|dual|multi` plus lowercase ISO language-code labels (including regional codes). Genre labels are the canonical English genres of `js/tags/genre-icons.json`, one per icon (`genre:action`, `genre:horror`, `genre:science fiction`, `genre:tv movie`, `genre:game-show`, `genre:reality-tv`, …, 25 in all), plus `genre:other` for genres outside the table; every spelling and translation of a genre in the table (`Sci-Fi`, `Comédie`, `Ужасы`) takes its canonical genre's label, on the web (`data-je-genre`) and on native posters alike. `scripts/generate_genre_labels.py` writes the web table from that file (`--check` verifies it); native code reads the file itself. The single `genre:genre` label of documents saved before is read as the genre group's colours (over any stored group colours, which is what every genre chip drew) and is not written again. Fields are `background`, `border`, `text`; language chips take all three fields; only flag images use just the border ring. Chip-code/dual/multi labels override the chip-kind label, then the language group and preset. `TagStylePreset` is the authoritative preset; the document's own `preset` mirrors it. Saving validates the document, whichever version it is (leaving out `v` does not skip the checks): unknown keys, groups, labels or fields, the reserved keys `__proto__`, `constructor` and `prototype`, anything that is not a colour, more than 400 labels or more than 32 KB keep the current styles (logged as a warning); valid documents are stored normalised to `rgba()`, keys in ordinal order and fields as `background`, `border`, `text` (the Media Tags page's editor writes that order, so a save comes back unchanged). The fixed-label regression checks that every catalog label, including the language-code labels and all 26 genres, with every colour field at its longest normalised value still fits the 32 KB cap. A version 1 document (`{quality:{label:{background,border,color}},age:{boardId:…},rating:{community|critic:…},genre:…}`, from before the editor redesign) is still read: each stored label becomes the colours it drew (the stored field, else the built-in colour; rating chips get no border) under the `default` preset, whatever `TagStylePreset` says (its `genre` colour becomes the genre group's), and it is converted to version 2 on the next save.

Catalog (administrator) has `quality:[{label,background,color}]`, `age:[{id,background,border,color,ratings,sample}]`, `presets` (ids in editor order), `groups` (`{group:[{key,name}]}`), `genreIcons` (`{genreLabel: glyph}`, the icon each genre label's tile shows; `other` has the default `theaters`) and `palettes` (`{preset:{"group:label":{background,border,color}}}`, every colour concrete: the preset's colour where it sets one, else the built-in colour; for `poster`, the colours an example red poster gives every tag but flags) and `poster` (`{worstContrast, example:{background,border,color}}`: the lowest text contrast the Poster preset's normalisation can produce over any artwork, and the example colours). It provides shipped defaults and palettes, rather than a user's effective styles. Under `poster`, `GET tag-styles` returns `preset: "poster"` with only the group and tag colours the administrator set; the web takes everything else from each card's artwork.

Native preview accepts a Jellyfin item GUID, optional target `userId` (missing/empty uses caller), `width=360`, optional `height`, nullable boolean `topRightOffset`. Dimensions clamp to `32..2048` pixels.

A credential without an existing caller must supply a real target user. Target access/parental policy applies; a missing user/item/artwork returns `404`.

Unsupported type or nonlocal Primary artwork returns `400`. Supported types are Movie, Series, Season, Episode, BoxSet, Video.

```bash
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  "$JE_URL/native-poster-tags/preview/9285e8b54149414941494edb9e464dcd?userId=$USER_ID&width=360" \
  --output poster-preview.jpg
```

Success is JPEG, `no-store`; rendering failure returns `500`.

Preview bypasses both delivery switches: the master and per-user nullable `UseNativePosterTags` (default null). Null/true means personal delivery on when allowed by the administrator; false opts out.

Preview may fall back to original bytes when no tags render. Artwork stays original/unblurred while tag data may be spoiler-stripped.

Native delivery and preview resolve Status with the web's shared vocabulary/threshold table and per-user family switches. Native TMDB trending is refreshed daily at UTC midnight through `TmdbResponseCache`; missing keys/empty lists omit popularity, with no Seerr fallback. Image composition reads fresh snapshots only; cold/stale snapshots omit remote-dependent badges and signal one background refresh. A hosted worker also refreshes daily trending and known series once a minute through the shared TMDB response cache. Series snapshots reuse `StatusTagsSeriesService`, its six-hour response cache and five-minute empty/failure retry suppression; at most 512 series are retained. Parent aggregates use the target user's access and Spoiler Guard strip.

Personal-only `NativePosterDateLocale` (registered BCP 47 culture, ≤35 characters) and `NativePosterTimeZone` (resolvable IANA zone, ≤64 characters) are nullable strings recording the date context from an explicit personal web save with Status enabled. Assignment, POST and document load trim and canonicalize base locale and timezone values; bounded BCP 47 Unicode extensions (`-u-`, unique attributes/keys, 2–8 character subtags) are preserved as sent by the browser. Native formatting uses the registered base language/script/region, ignoring Unicode calendar/numbering/collation overrides; oversized, malformed or unknown values become null before persistence/logging. Recognized Windows zone IDs within the same bound are converted to IANA IDs. No background save occurs and new-user/reset defaults leave them null. Native background trending pagination uses the hosted worker lifetime token for page waits and before requesting another page; shutdown never publishes its cancelled refresh. An existing shared TMDB HTTP request may finish for other callers. Native rendering validates culture/timezone ids, falling back to the JE display language/English and server timezone; short month/day dates use deduplicated, generated `Intl` data for all shipped languages and named regional variants, including Persian calendar/digits. Missing variants walk their culture parents, preserving a regional/script ancestor before the language or English fallback. Web cards continue to use their current browser context.

Native delivery resolves `PosterTagSettings.ForItem` before composing each poster: the personal lock on the item, then the personal lock on its series, then the server-wide look for the item, then the server-wide look for its series, then the first enabled tag look rule whose conditions hold, then the user’s default. Rules read `PosterTagLookFacts`: the owner's type, `LibraryId`, `Genres` and `OfficialRating` from its tag cache entry (the facts web cards match on), or from the library item with series fallbacks when the cache has no entry; the stamper and the image filter read the same facts, so a minted token verifies. A rule's look is its layout, density and slots; caps, size and gap stay the user's. A series look with `Scope = "item"` applies only to that series poster. Native Bands follows the resolved item’s Bands profile, priority order, caps and Full/Compact density; its gradient strips fit at most two rows each and count omitted chips as `+N`. Caption/Summary/Minimal fall back to the saved Corners positions while preserving the item’s hidden groups and limits, size, gap and edge spacing. Shape overrides remain web-only (an image request has no card shape). The administrator preview route reports where the look came from in `X-JE-Poster-Tags-Look` (`lock`, `item-look`, `rule:N` with the rule's place in the list, or `default`). Settings digests include active slots/layout/density, status switches/windows and date context. While Status is shown, a five-minute UTC bucket also enters the signed token digest (including weak/cache-off tokens), with `public,max-age=<remaining bucket seconds>` instead of immutable responses on 200/HEAD and 304. Freshness is floored to whole seconds; sub-second/expired buckets use `no-store`. Token verification and rendering share a captured instant, and completion across a bucket boundary retains original artwork uncached. Expired tokens fall back to original artwork with `no-store`; clients must refresh metadata. Composite keys additionally include live rank/schedule and filtered parent data; tile keys include the rendered status text and effective family colours. Existing spoiler/no-store policies take precedence. No persisted tag-cache field or schema changes.

Diagnostic headers use the prefix `X-JE-Poster-Tags-`: `Status`, `Artwork` (`original`), `Master-Enabled`, `User-Enabled`, `Any-Group`, `Settings-Digest`, `Spoiler-Stripped`.

### Audio tags, awards, MDBList, and content warnings

Use these routes to look up language tag names, awards, external ratings, AniList reviews, and DoesTheDogDie content warnings. The account-status route lets administrators check MDBList limits.

| Setting | Default | What it does |
|---|---|---|
| **Enable Audio Language Tags Sync** | `false` | `AudioLanguageTagSyncEnabled`; gates audio tag-name lookup. |
| **Tag Prefix** | `"JE Language: "` | `AudioLanguageTagPrefix`; prefixes language tag names. |
| **Show Awards Banner** | `false` | `ShowAwards`; enables Wikidata lookup, without a TMDB key requirement. |
| **Enable MDBList Ratings** | `false` | `MdblistRatingsEnabled`; gates MDBList title responses. |
| **MDBList API Key** | `""` | `MdblistApiKey`; enables upstream lookups. |
| **Show Content Warnings** | `false` | `DoesTheDogDieEnabled`; also needs a nonblank `DoesTheDogDieApiKey`. |
| **Show AniList Reviews** | `false` | `ShowAnilistReviews`; gates the AniList reviews route. |
| **Enable Review Translation** | `false` | `ReviewTranslationEnabled`; the translate routes also need a nonblank `ReviewTranslationUrl`. `ReviewTranslationApiKey` is optional and never returned to clients. |

| Method | Path | Access | Contract |
|---|---|---|---|
| GET | `audio-language-tags` | Authenticated | Query `codes` → `{code:{baseTag,variantTag}}`; disabled returns `{}`. |
| GET | `awards/{mediaType}/{tmdbId}` | Authenticated | `movie`, `tv`, or `person` → awards object. |
| GET | `mdblist-ratings/{mediaType}/{tmdbId}` | Authenticated | `movie` or `tv` → MDBList object. |
| GET | `mdblist-ratings/account-status` | Administrator | Optional nonblank query `apiKey` override → live account status. |
| GET | `ddd/{mediaType}/{tmdbId}` | Authenticated | `movie` or `tv` → DoesTheDogDie object. |
| GET | `ddd/topics` | Authenticated | Topic catalogue for the trigger picker. |
| GET | `anilist/reviews` | Authenticated | Query `anilistId` (positive AniList anime id) → `{SiteUrl, Reviews:[{Author,Summary,Content,Score,Rating,RatingAmount,CreatedAt,Url}]}` (PascalCase), the ten highest-rated AniList reviews, cached 12 hours (2 hours when none). `503` when disabled, `400` for a bad id, `502` when AniList fails. |
| GET | `translate/languages` | Authenticated | `{languages:[...]}`, the target languages the configured LibreTranslate offers for English. |
| POST | `translate` | Authenticated | Body `{text,target}` (English text of 1 to 20000 characters, language code) → `{text}`, translated live and cached in memory for an hour. A LibreTranslate rate limit returns 429 `{code:"translation_rate_limited"}`, plus `retryAfterSeconds` and a `Retry-After` header when LibreTranslate gave a wait; a LibreTranslate 403 returns 502 `{code:"translation_refused"}`. |

```bash
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  "$JE_URL/audio-language-tags?codes=en-US,zxx"
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/awards/movie/603"
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/mdblist-ratings/movie/603"
```

Audio tags examines the first 50 nonempty comma-separated codes; skips duplicates and codes over 16 characters. `variantTag` is nullable. A blank configured prefix falls back to `JE Language: `.

Awards/MDBList reject unsupported media types or non-digit IDs with `400`. Despite the error text saying “positive integer,” the controller checks digit-only strings and does not explicitly reject zero. Disabled features return `503`, lookup exceptions `500`.

Awards object: `{Found,Wins,Nominations,Awards,Confirmed,FetchedAtUnixMs}`. Each award has `{Name,Result,Year,Recipients,Works}`; `Result` is `Won`/`Nominated`, `Year` nullable. Title lookups populate recipients; person lookups populate works.

MDBList object: `{Found,Ratings,Confirmed,FetchedAtUnixMs,Ids}`. Each rating has `{Source,Value,Score,Votes,Url,Fresh}`; values other than source can be null.

`Value` is source-native, `Score` MDBList's scaled score, `Fresh` its optional critic flag (`1` Fresh, `0` Rotten). `Ids` maps provider names to string IDs.

`Found:false,Confirmed:true` is a confirmed miss. `Confirmed:false` is an unavailable/unconfirmed placeholder and should be retried, rather than treated as a definitive miss.

A missing MDBList key can return such a successful placeholder; a fresh cached result can still be returned. Confirmed awards/ratings get 30-minute private browser caching; unconfirmed placeholders do not.

DoesTheDogDie object: `{Found,ItemId,Name,Topics,Confirmed,FetchedAtUnixMs}`. Each topic has `{Id,Name,Yes,No}`, where `Yes` and `No` are vote counts; only topics with at least one vote are included. `ItemId` builds the title link `https://www.doesthedogdie.com/media/{ItemId}`. Cached found results last 30 days, confirmed misses 14 days, and failed lookups return `Confirmed:false` and are retried after an hour. Movie and show matches are separated by media type, because one TMDB ID can exist as both.

`ddd/topics` returns `{Topics:[{Id,Name,Category,Group}],FetchedAtUnixMs}`, refreshed about monthly. If the catalogue cannot be fetched and none is cached it returns `502`. Both `ddd` routes return `503` when the feature or key is missing and `400` for an unsupported media type or non-digit ID. The upstream key never reaches the client.

Account status force-refreshes and returns `{Plan,IsSupporter,RateLimit,RateLimitRemaining,RateLimitResetUnixSeconds,FetchedAtUnixMs}`. Without a supplied/saved key it returns `503`; unavailable account status `502`. Reset time is Unix **seconds**, fetch time Unix **milliseconds**.

## Client Bootstrap & Config

The injected web client uses these endpoints to load resources and its initial state. Custom clients can use the same data endpoints. See [project structure](project-structure.md) for the loading sequence.

| Method | Path | Access | Response |
|---|---|---|---|
| GET | `script` | Anonymous | Initial loader `js/plugin.js`, JavaScript. |
| GET | `js/{**path}` | Anonymous | Embedded JS tree resource; MIME follows JS/CSS/JSON/HTML extension. |
| GET | `Configuration/configPage.css` | Anonymous | Admin stylesheet, `text/css`. |
| GET | `version` | Anonymous | Unquoted version text. |
| GET | `public-config` | Anonymous | Curated public configuration; anonymous Seerr URLs redacted. |
| GET | `private-config` | Authenticated | Selected private configuration for admins; `{}` for other users. |
| GET | `bootstrap` | Caller, parseable claim | Initial state described below, `no-store`. |
| GET | `bundle.js` | Anonymous | Concatenated component JavaScript. |
| GET | `bundle.js.map` | Anonymous | Component source map, JSON. |
| GET | `host-compat` | Administrator | Build/host diagnostic object. |
| GET | `locales` | Authenticated | Sorted locale-code string array, excluding base `en`; one-day response-cache duration. |
| GET | `locales/{lang}.json` | Anonymous | Embedded translation JSON; regional code falls back to base language. |
| GET | `cdn/{source}/{**path}` | Anonymous | Allowlisted mirrored asset bytes; ETag/`304`. |
| GET | `fonts/{name}` | Anonymous | Allowlisted bundled WOFF2; `font/woff2`. |

```bash
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/bootstrap"
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/host-compat"
curl "$JE_URL/locales/de-DE.json"
```

### Bootstrap payload

Use `bootstrap` to load your initial configuration, user documents, and available prefetched data in one response.

| Field | Shape |
|---|---|
| `Version`, `UserId` | Version string and caller's N-format ID. |
| `PublicConfig` | Same field set as `public-config`, authenticated context. |
| `PrivateConfig` | Curated admin object below; null/omitted for viewers. |
| `HasCustomTabs`, `HasPluginPages` | Whether a plugin with that exact name is loaded. |
| `UserSettings` | `{Settings,Shortcuts,Bookmark,Elsewhere,HiddenContent}` typed documents. |
| `ComponentScripts` | Ordered component-script path array, nullable on manifest failure. |
| `Prefetched` | `{SpoilerBlurSeries,SeerrUserStatus,SeerrStatus,ActiveStreamSessions,TagStripRevision}`; standalone response shapes or null. `TagStripRevision` is the `StripRevision` a `tag-data` answer would carry, null when the Spoiler Guard state cannot be read. |

A missing/unparseable claim returns `403`; an empty but parseable GUID passes the initial check. There is no target-user parameter or account-existence check. Missing configuration returns `503`.

Individual document loading failures can yield null rather than failing bootstrap. First settings/Hidden Content loads can seed saved defaults as on their standalone GETs.

Prefetch values depend on feature/access/cache gates. Spoiler state is included only when enabled and readable without recovery; Seerr values are included only when existing caches avoid an upstream lookup; stream sessions require allowed access. Null means use the standalone endpoint when needed.

### Public and private configuration

Use these endpoints to read selected configuration values. The public payload is curated; private configuration provides selected administrator link settings and diagnostics.

Neither configuration endpoint exposes provider API keys. `TmdbEnabled` and `MdblistEnabled` report whether keys are configured. Anonymous public reads blank `JellyseerrBaseUrl` and `JellyseerrUrlMappings`; authenticated reads expose those link values.

`MaintenanceModeEnabled`, `MaintenanceModeMessage`, `MaintenanceModeEndsAt` reflect banner/runtime state, including scheduled windows; the end can be null for open-ended maintenance. Public `MaintenanceModeAffectedUsers` is only `all`/`selected`, rather than the underlying user IDs. Missing configuration returns `503`.

??? note "Public payload field types"

    Values reflect the current server configuration rather than fixed API defaults. The complete returned field set is grouped by JSON value type below. Nullable values may be absent on the wire.

    | Fields | JSON type |
    |---|---|
    | `TmdbEnabled`, `EnableCustomSplashScreen`, `ElsewhereEnabled`, `ElsewhereSeasonProviders`, `AutoPauseEnabled`, `AutoResumeEnabled`, `AutoPipEnabled`, `AutoSkipIntro` | Boolean |
    | `AutoSkipOutro`, `LongPress2xEnabled`, `RandomButtonEnabled`, `RandomIncludeMovies`, `RandomIncludeShows`, `RandomUnwatchedOnly`, `RandomScopeCurrentContainer`, `ShowWatchProgress` | Boolean |
    | `ShowFileSizes`, `RemoveContinueWatchingEnabled`, `ShowAudioLanguages`, `ShowReviews`, `ShowUserReviews`, `ReviewsExpandedByDefault`, `HideReviewsFromHiddenUsers`, `HideReviewsFromDisabledUsers` | Boolean |
    | `ShowAwards`, `DoesTheDogDieEnabled`, `MdblistEnabled`, `MdblistRatingsEnabled`, `MdblistRatingsShowOnItemDetails`, `MdblistRatingsShowPercentSymbol`, `ShowReleaseDates`, `ShowUserRatingOnPosters`, `ShowUserRatingDash` | Boolean |
    | `PauseScreenEnabled`, `ShowPlaybackRatingBadge`, `NativePosterTagsEnabled`, `TagStyleWebActive`, `QualityTagsEnabled`, `ShowResolutionTag`, `ShowSourceTag`, `ShowEditionTag`, `ShowLowQualitySourceTag`, `ShowDynamicRangeTag` | Boolean |
    | `ShowSpecialFormatTag`, `ShowVideoCodecTag`, `ShowAudioInfoTag`, `GenreTagsEnabled`, `LanguageTagsEnabled`, `RatingTagsEnabled`, `AgeRatingTagsEnabled`, `PeopleTagsEnabled` | Boolean |
    | `StatusTagsEnabled`, `StatusTagsJustAdded`, `StatusTagsNewRelease`, `StatusTagsTrending`, `StatusTagsSchedule`, `StatusTagsMilestones`, `StatusTagsSeriesStatus`, `StatusTagsLeaving`, `StatusTagsDirectPlay`, `LeavingSoonAvailable`, `TagStylesAllowUserPreset`, `CustomTagsEnabled` | Boolean |
    | `DisableAllShortcuts`, `DisableCustomSubtitleStyles`, `LanguageTagsPriorityStrict`, `LanguageTagsMergeRegions`, `QualityTagsAudioLanguageFromUser`, `RatingTagsOnMovies`, `RatingTagsOnSeries`, `RatingTagsOnSeasons`, `RatingTagsOnEpisodes` | Boolean |
    | `RatingTagsOnContinueWatching`, `RatingTagsOnNextUp`, `RatingTagsShowCommunity`, `RatingTagsShowCritic`, `ShowRatingInPlayer`, `DisableTagsOnSearchPage`, `TagsHideOnHover`, `TagCacheServerMode`, `EnableTagsLocalStorageFallback`, `JellyseerrEnabled` | Boolean |
    | `JellyseerrShowSearchResults`, `JellyseerrSearchExcludeLibraryItems`, `JellyseerrShowReportButton`, `JellyseerrShowIssueIndicator`, `JellyseerrEnable4KRequests`, `JellyseerrEnable4KTvRequests`, `ShowCollectionsInSearch`, `JellyseerrShowAdvanced` | Boolean |
    | `JellyseerrShowQuotaInfo`, `ShowElsewhereOnJellyseerr`, `JellyseerrUseMoreInfoModal`, `JellyseerrAvailablePosterLinksToJellyfin`, `AddRequestedMediaToWatchlist`, `SyncJellyseerrWatchlist`, `JellyseerrAutoImportUsers`, `JellyseerrShowSimilar` | Boolean |
    | `JellyseerrShowRecommended`, `JellyseerrShowRequestMoreOnSeries`, `JellyseerrShowNetworkDiscovery`, `JellyseerrShowGenreDiscovery`, `JellyseerrShowTagDiscovery`, `JellyseerrShowPersonDiscovery`, `JellyseerrShowCollectionDiscovery`, `JellyseerrShowDetailPageLink` | Boolean |
    | `JellyseerrShowDetailPageLinkAsText`, `JellyseerrExcludeLibraryItems`, `JellyseerrExcludeBlocklistedItems`, `JellyseerrDisableCache`, `BookmarksEnabled`, `BookmarksUsePluginPages`, `BookmarksUseCustomTabs`, `BookmarksUseNativeTab` | Boolean |
    | `ArrLinksEnabled`, `ShowArrLinksAsText`, `ArrLinksShowStatusSingle`, `ArrTagsSyncEnabled`, `ArrTagsShowAsLinks`, `AudioLanguageTagSyncEnabled`, `AudioLanguageTagShowAsLinks`, `LetterboxdEnabled` | Boolean |
    | `ShowLetterboxdLinkAsText`, `MetadataIconsEnabled`, `UseIcons`, `ColoredRatingsEnabled`, `ThemeSelectorEnabled`, `ColoredActivityIconsEnabled`, `PluginIconsEnabled`, `EnableLoginImage` | Boolean |
    | `ActiveStreamsEnabled`, `ActiveStreamsAllUsers`, `AnalyticsEnabled`, `AnalyticsShareUsageCounts`, `DownloadsPageEnabled`, `DownloadsPageShowIssues`, `ShowDownloadsInRequests`, `DownloadsUsePluginPages` | Boolean |
    | `DownloadsUseCustomTabs`, `DownloadsUseNativeTab`, `DownloadsPagePollingEnabled`, `DownloadsFilterByUserRequests`, `DownloadsShowHistory`, `DownloadsHistoryAdminOnly`, `CalendarPageEnabled`, `CalendarUseCustomTabs` | Boolean |
    | `CalendarUsePluginPages`, `CalendarUseNativeTab`, `CalendarHighlightFavorites`, `CalendarHighlightWatchedSeries`, `CalendarFilterByLibraryAccess`, `CalendarShowOnlyRequested`, `CalendarForceOnlyRequested`, `RecommendationsPageEnabled` | Boolean |
    | `RecommendationsUseCustomTabs`, `RecommendationsUseNativeTab`, `ActivityFeedEnabled`, `ActivityFeedUseCustomTabs`, `ActivityFeedUseNativeTab`, `ActivityFeedShowWatched`, `ActivityFeedShowFavorited`, `ActivityFeedShowReviewed` | Boolean |
    | `ActivityFeedShowActiveStreams`, `HiddenContentEnabled`, `HiddenContentUsePluginPages`, `HiddenContentUseCustomTabs`, `HiddenContentUseNativeTab`, `HiddenContentAdmin`, `CatchUpEnabled`, `CatchUpUsePluginPages` | Boolean |
    | `CatchUpUseCustomTabs`, `CatchUpUseNativeTab`, `MaintenanceModeEnabled`, `SpoilerBlurEnabled`, `SpoilerBlurStrictRefresh`, `SpoilerStripSeriesOverview`, `SpoilerStripOverview`, `SpoilerStripTags` | Boolean |
    | `SpoilerStripChapters`, `SpoilerStripTaglines`, `SpoilerStripRatings`, `SpoilerStripPremiereDate`, `SpoilerReplaceTitle`, `SpoilerStripCast`, `SpoilerStripReviews`, `SpoilerBlurTrickplay`, `SpoilerAdvancedMode` | Boolean |
    | `ToastDuration`, `HelpPanelAutocloseDelay`, `PauseScreenDelaySeconds`, `ResolutionTagOrder`, `SourceTagOrder`, `EditionTagOrder`, `DynamicRangeTagOrder`, `SpecialFormatTagOrder`, `VideoCodecTagOrder` | Integer |
    | `AudioInfoTagOrder`, `DefaultSubtitleStyle`, `DefaultSubtitleSize`, `DefaultSubtitleFont`, `DefaultSubtitleTextEffect`, `TagsCacheTtlDays`, `DownloadsPollIntervalSeconds`, `SpoilerBlurIntensity` | Integer |
    | `StatusTagsJustAddedDays`, `StatusTagsNewReleaseDays`, `LogoTagsMaxLogos` | Integer |
    | `SplashScreenImageUrl`, `DEFAULT_REGION`, `DEFAULT_PROVIDERS`, `IGNORE_PROVIDERS`, `ElsewhereCustomBrandingText`, `ElsewhereCustomBrandingImageUrl`, `WatchProgressDefaultMode`, `WatchProgressTimeFormat` | String |
    | `MdblistRatingsSources`, `DefaultLanguage`, `QualityTagsPosition`, `GenreTagsPosition`, `LanguageTagsPosition`, `LanguageTagsPriority`, `QualityTagsPreferredAudioLanguage`, `RatingTagsPosition` | String |
    | `AgeRatingTagsPosition`, `JellyseerrBaseUrl`, `JellyseerrUrlMappings`, `ArrTagsPrefix`, `ArrTagsLinksFilter`, `ArrTagsLinksHideFilter`, `AudioLanguageTagPrefix`, `IconStyle` | String |
    | `StatusTagsPosition`, `CustomTagsPosition`, `TagLayout`, `TagLabelDensity`, `TagScale`, `TagGap`, `TagEdgeSpacing`, `TagStylePreset`, `LogoTagsPosition`, `LogoTagsMovieMode`, `LogoTagsSeriesMode` | String |
    | `CustomTagRules` | Array of `{Id,Label,Icon}` in rule order (no tag or collection names, see above) |
    | `TagLayouts`, `TagGroupCaps`, `TagShapeOverrides` | Nullable object (shapes as in `settings.json`) |
    | `TagGroupOrder` | Nullable array of group ids |
    | `TagLookRules` | Nullable array of rules (shape as in `settings.json`), normalized |
    | `TagLookItemOverrides` | Nullable array of server-wide item looks `{ItemId,Layout,Density,ColourPreset,Slots,Shapes,Caps,TagScale,TagGap,EdgeSpacing,Scope,LockedAt}` (the `TagLayoutLocks` document with its item id), normalized, newest first, at most 500; only targets visible to the caller through Jellyfin library and parental access checks (including scoped series targets), `null` for anonymous callers or when none are visible. Public config and bootstrap are not cached across users |
    | `CalendarFirstDayOfWeek`, `CalendarTimeFormat`, `MaintenanceModeMessage`, `MaintenanceModeAction`, `MaintenanceModeAffectedUsers` | String |
    | `ClearLocalStorageTimestamp`, `ClearTranslationCacheTimestamp` | Integer |
    | `Shortcuts` | Array of `{Name,Key,Label,Category}` |
    | `MaintenanceModeEndsAt` | Nullable ISO timestamp |

Private configuration is `no-store`. Admin fields are strings `SonarrUrl`, `RadarrUrl`, `BazarrUrl`, `SonarrUrlMappings`, `RadarrUrlMappings`, `BazarrUrlMappings`, `ShokoUrl`, `ShokoUrlMappings`; arrays `SonarrInstances`, `RadarrInstances` of `{Name,Url,UrlMappings,Enabled}` and `CustomTagRuleSources` of `{Id,Match,Value}` (what each Custom tag rule matches); and booleans `SonarrInstancesCorrupt`, `RadarrInstancesCorrupt`. This is selected link configuration and diagnostics, rather than the complete saved model. The separate admin `jellyseerr/settings/{type}` endpoint can return upstream API keys.

Host compatibility returns `{builtFor,hostTarget,hostVersion,pluginVersion,mismatch,expectedAsset,manifestUrl,message}`. It diagnoses an installed artifact targeting a different Jellyfin version; no feature toggle is required.

### Static-resource limits and caching

Use these rules when loading or retaining JE scripts, translations, fonts, and mirrored assets.

| Setting | Default | What it does |
|---|---|---|
| **Dev Mode** | `false` | `DevMode`; switches script/bundle delivery to `no-store`; bundles rebuild per request. |

Production scripts, CSS, component bundles/maps, and fonts use one-year immutable caching. Use a version/build cache key in resource URLs when retaining them. Embedded missing resources return `404`; unavailable bundle instance `503`, bundle-build failure `500`.

Locale JSON tries the requested code, then a base-language fallback such as `de-DE` → `de`, then returns `404`.

Font names are `materialsymbolsrounded-subset.woff2`, `materialsymbolsoutlined-subset.woff2`, `materialsymbolsrounded.woff2`, `materialsymbolsoutlined.woff2`. Unsupported/missing names return `404`.

CDN `source` is one of `selfhst`, `jellyfish`, `dashboard-icons`, `zesty`, `jelly-helper`, `moonbase`, `flagcdn`, `flag-icons`, `ibb`, `locales`, `je-docs-img`, `je-css`, `icon-metadata`, `elsewhere-res`, `award-logos`, `mdblist-logos`, `mdblist-static`, `ddd-static`. It is a fixed-source mirror, rather than a generic URL proxy.

Paths/content types are validated, and some sources allow only fixed assets. Unknown/refused/unavailable assets return `404`; success uses the asset MIME, one-day public caching, ETag and `304`. No client feature toggle gates fonts/CDN.

## *arr (Sonarr/Radarr/Bazarr)

JE queries configured Sonarr/Radarr instances for links, downloads, and calendar data; the calendar can also use configured Shoko. These routes do not provide a general Bazarr API proxy. See [*arr settings](../arr/arr-settings.md) for multi-instance configuration and browser URL mappings.

### Validation and instance lookup

All routes in this table require **Administrator** access. Lookup routes query enabled instances and do not check a client link toggle.

| Method | Path | Inputs → response |
|---|---|---|
| GET | `arr/validate/sonarr` | Query `url`, header `X-Arr-ApiKey` → `{ok:true}`. |
| GET | `arr/validate/radarr` | Query `url`, header `X-Arr-ApiKey` → `{ok:true}`. |
| GET | `arr/identify-url` | Query `url` → `{reachable,service}`. |
| GET | `arr/series-slug` | Positive query `tvdbId`; first enabled Sonarr → `{titleSlug}`. |
| GET | `arr/series-slugs` | Positive query `tvdbId`; all enabled Sonarr → `{matches,errors}`. |
| GET | `arr/movie-instances` | Positive query `tmdbId`; all enabled Radarr → `{matches,errors}`. |
| GET | `arr/links` | Query `tmdbIds`/`tvdbIds` lists → `{movies:{id:{matches,errors}},series:{id:{matches,errors}}}`. |

```bash
ARR_URL='http://sonarr:8989'
ARR_KEY='YOUR_SONARR_API_KEY'
curl -G -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H "X-Arr-ApiKey: $ARR_KEY" --data-urlencode "url=$ARR_URL" \
  "$JE_URL/arr/validate/sonarr"

curl -G -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  --data-urlencode 'tmdbIds=603,604' --data-urlencode 'tvdbIds=121361' \
  "$JE_URL/arr/links"
```

Validation tests supplied URL/key values, including unsaved values. Missing/rejected inputs return `400`; invalid upstream auth returns `401`; timeout `504`; connection failure `502`; other upstream statuses can pass through. Failures use `{ok:false,message}`. URLs use the same HTTP(S)/address guard described under Seerr.

URL identification probes the supplied URL without looking up an item. Service values include `Sonarr`, `Radarr`, `Bazarr`, `Jellyfin`, `Seerr`, `arr`, `unknown`. Invalid input returns `400 {reachable:false,service:"unknown"}`; an unrecognized responding site can return `reachable:true,service:"unknown"`.

Single series lookup returns `400` for nonpositive IDs, `404` for no configured/found series/slug, `500` for missing/corrupt configuration, `502` for instance-fetch failure.

Multi-instance lookups require a positive ID (`400`), return `500` for absent plugin configuration, and retain partial matches and separate per-instance errors. No configured instances yields empty maps/arrays; all-disabled/corrupt settings add errors.

A series match contains `instanceName`, `instanceUrl`, `urlMappings`, `titleSlug`, `episodeFileCount`, `episodeCount`, `percentOfEpisodes`, `sizeOnDisk`, `rootFolderPath`.

A movie match contains `instanceName`, `instanceUrl`, `urlMappings`, `hasFile`, `sizeOnDisk`, `rootFolderPath`; size is bytes. Errors contain `instanceName`, `reason`.

Batch inputs are comma-separated positive integer movie TMDB IDs and series TVDB IDs. Invalid values/duplicates are ignored. No valid IDs or more than 100 combined IDs returns `400`; disconnect can return `499`. Plural series lookup accepts **one** series ID across instances, rather than multiple IDs.

### Queue, history, and Requests data

These reads require authentication. Queue/history are administrator-visible without Seerr linkage; non-admin filtering depends on server settings and a linked caller's requests.

| Setting | Default | What it does |
|---|---|---|
| **Filter Downloads by User Requests** | `true` | `DownloadsFilterByUserRequests`; filters non-admin queue/history by caller's linked Seerr requests. |
| **Show Download History Section** | `true` | `DownloadsShowHistory`; controls history availability. |
| **Restrict Download History to Admins** | `false` | `DownloadsHistoryAdminOnly`; hides history from viewers. |
| **Poll Interval (seconds)** | `30` | `DownloadsPollIntervalSeconds`; also cache TTL, clamped `5..300` seconds. |

| Method | Path | Parameters → response |
|---|---|---|
| GET | `arr/queue` | No parameters → `{items,errors}`. |
| GET | `arr/history` | `take=20` clamped `1..50`, `skip=0` minimum 0 → `{items,totalPages,visible}`. |
| GET | `arr/requests` | `take=20` clamped `1..200`, `skip=0` minimum 0, optional `filter`, `userOnly=false` → `{requests,totalPages,totalResults,canApproveRequests}`. |
| POST | `arr/requests/{requestId}/approve` | Seerr request ID, no body → `{success:true}`. |
| POST | `arr/requests/{requestId}/decline` | Seerr request ID, no body → `{success:true}`. |

```bash
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/arr/history?take=20&skip=0"
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/arr/requests?filter=processing&userOnly=true"
curl -X POST -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/arr/requests/42/approve"
```

Queue items contain `id`, `source`, `instanceName`, `title`, `subtitle`, nullable `seasonNumber`, `episodeNumber`, `status`, `progress`, `totalSize`, `sizeRemaining`, `timeRemaining`, `posterUrl`, `tmdbId`. Progress is percentage (rounded to one decimal); sizes are bytes. Errors contain `instanceName`, `source`, `reason`. Per-instance failures preserve other instances' items.

History items contain `source`, `instanceName`, `title`, `subtitle`, `eventType`, `date`, `posterUrl`, `tmdbId`; grouped Sonarr packs additionally contain `episodeCount`, `importedCount`, `failedCount`. Event types include `imported`, `failed`, and grouped `partial`. The merged history is bounded to 200 entries before caller filtering/paging; `totalPages` covers this visible window, rather than all upstream history.

Instance failures can yield partial/empty history without an errors array.

History disabled or admin-restricted returns successful empty results with `visible:false`. Unavailable non-admin linkage/request data can return successful empty queue/history with history `visible:true`.

Thus an empty successful result can mean privacy filtering, rather than an empty server queue. Missing plugin configuration returns `500`.

Requests uses Seerr credentials and caller linkage (`400` for missing caller claim, `404` for unlinked). Missing saved URL/key can return an empty successful response without `canApproveRequests`; other unavailable upstream results return error statuses rather than a successful empty list.

This enriched endpoint differs from the raw `jellyseerr/request` proxy. It does not merge queue items into its `requests` array; queue is fetched separately.

Request records contain `id`, `type`, `title`, `year`, `posterUrl`, `tmdbId`, `tvdbId`, `mediaStatus`, `requestStatus`, `requestedBy`, `requestedByAvatar`, `createdAt`, `jellyfinMediaId`, `digitalReleaseDate`, `theatricalReleaseDate`, `initialAirDate`, `nextAirDate`, `isComingSoon`, `isOrphaned`. Optional fields can be missing/null.

Raw request statuses are `1` Pending, `2` Approved, `3` Declined, `4` Failed, `5` Completed, separate from media availability.

`filter` recognizes `pending`, `approved`, `available`, `processing`, `comingsoon`; other values use the upstream unfiltered list. Callers without `REQUEST_VIEW`, `MANAGE_REQUESTS`, or admin authority see only their own requests; `userOnly=true` also enforces this.

Processing/Coming Soon split a 500-record upstream processing window: future release/air-date items go to Coming Soon, others Processing, excluding orphaned rows from both.

Orphan detection considers old Approved/Processing requests and missing content in configured *arr instances. Counts/pagination on the split are bounded to that source window. Parental filtering applies.

Approve/decline requires a linked caller with Jellyfin administrator authority, Seerr `ADMIN`, or `MANAGE_REQUESTS`. Missing setup returns `503`; missing caller identity `400`; unlinked `404`; insufficient permission `403`. It uses the first configured URL and passes upstream failure statuses through. An administrator API key lacking a linked caller cannot bypass linkage.

### Calendar

Read upcoming events from configured sources, then use user-data to retrieve favorite and watched flags for event references.

| Setting | Default | What it does |
|---|---|---|
| **Filter by Library Access** | `true` | `CalendarFilterByLibraryAccess`; excludes events with known inaccessible items/root folders. |

| Method | Path | Access | Request → response |
|---|---|---|---|
| GET | `arr/calendar` | Authenticated | Optional query `start`, `end` → `{events,errors}`. |
| POST | `arr/calendar/user-data` | Existing caller | `{Events:[<event reference>]}` → `{results:[{id,isFavorite,isWatched}]}`. |

GET defaults to today's UTC date through 90 days ahead. Parseable dates override each endpoint; invalid dates retain defaults, reversed ranges swap, ranges over 365 days cap at 365. Missing configuration returns `500`. Enabled Sonarr/Radarr and configured Shoko contribute events; per-source errors contain `instanceName`, `source`, `reason`.

Calendar events contain `id`, `source`, `type`, `title`, `subtitle`, `releaseDate`, `releaseType`, `hasFile`, `monitored`, `posterUrl`, `backdropUrl`, `imdbId`, Jellyfin `itemId`, `itemEpisodeId`, `overview`, `tvdbId`, `seasonNumber`, `episodeNumber`, `episodeTvdbId`, `episodeImdbId`, upstream `seriesId`, `tmdbId`, `shokoSeriesId`, `shokoEpisodeId`, `instanceName`, `alsoInInstances`. Nullable fields can be absent.

Duplicate entries across instances are combined, preferring accessible/file-backed entries and recording other instance names.

Internal root-folder access information is not serialized in calendar events. If item/root-folder access cannot be determined, an event can pass the access filter. Requested-only display preferences operate in the client.

```bash
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  "$JE_URL/arr/calendar?start=2026-10-01&end=2026-10-31"
curl -X POST "$JE_URL/arr/calendar/user-data" \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H 'Content-Type: application/json' \
  --data '{"events":[{"id":"fixture","type":"Movie","itemId":"9285e8b54149414941494edb9e464dcd"}]}'
```

User-data references accept optional `Id`, `Type`, `Title`, nullable GUID `ItemId`, `ItemEpisodeId`, nullable integer `TvdbId`, `TmdbId`, `SeasonNumber`, `EpisodeNumber`, and nullable string `ImdbId`.

Only IDs/type are needed for flag reads. Use exact `Type:"Movie"`/`"Series"` for watched-state handling. `isFavorite` actually reads `Likes == true`; `isWatched` includes `Played` or positive resume ticks on a movie, or on the supplied episode for Series.

This POST does not save preferences. Missing caller/account returns `401`; empty events return an empty array; lookup failures can leave partial results.

## Activity Feed & What's New

Activity merges recent watched/favorited entries with user reviews into library cards. What's New is the administrator's server-wide settings acknowledgment.

| Setting | Default | What it does |
|---|---|---|
| **Enable Activity Feed** | `false` | `ActivityFeedEnabled`; disabled API returns `404`. |
| **Show recently watched** | `true` | `ActivityFeedShowWatched`; includes watched entries. |
| **Show recently favorited** | `true` | `ActivityFeedShowFavorited`; includes favorite entries. |
| **Show recently reviewed** | `true` | `ActivityFeedShowReviewed`; includes reviews. |

| Method | Path | Access | Contract |
|---|---|---|---|
| GET | `activity` | Existing caller | `limit=50`, clamped `1..200` → `{items:[<activity>]}`, `no-store`. |
| GET | `whats-new` | Administrator | `{pluginVersion,newSettings,mediaTags}`. `mediaTags` maps each new setting that lives on the Media Tags page to `{page,tab,group}` (its tab, and its group on Groups, else `null`). |
| POST | `whats-new/dismiss` | Administrator | No body → empty `200`; acknowledges server-wide state. |

```bash
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/activity?limit=50"
```

Activity requires a nonempty existing caller (`403` otherwise).

Rows have `ActivityType` (`Watched`, `Favorited`, `Reviewed`), `UserId`, `UserName`, `UserHasPrimaryImage`, Unix-millisecond `Timestamp`, `Item`, nullable `Rating`/`Content`, boolean `Completed`, numeric `Progress` (fraction `0..1`).

Item summaries contain `Id`, `Name`, `Type`, `ProductionYear`, `SeriesName`, `SeriesId`, `SeasonNumber`, `EpisodeNumber`, `HasPrimaryImage`, `HasThumbImage`, `SeriesHasPrimaryImage`, `SeriesHasThumbImage`.

Results are newest first and respect viewer library access and configured author visibility, including admin/self exceptions. Missing items and filtered authors are skipped; review keys resolve to the parent title for cards.

Watched records can represent partial playback; `Completed` distinguishes completion and `Progress` retains the highest observed fraction.

What's New `newSettings` maps setting-control IDs to the plugin version in which each was first detected; absent state returns null `pluginVersion` and `{}`.

## Catch Up API

Log Catch Up swipes and retrieve an administrator feed/summary. Ingestion records events; it does not mark an item watched, dismiss it, or mutate watchlists.

| Setting | Default | What it does |
|---|---|---|
| **Enable Catch Up** | `false` | `CatchUpEnabled`; required for recording. |
| **Record Catch Up activity** | `true` | `CatchUpLogEnabled`; required for recording. |

| Method | Path | Access | Contract |
|---|---|---|---|
| POST | `catchup/event` | Authenticated; existing caller when recording | Event body → empty `204`. |
| GET | `catchup/events` | Administrator | Filters below → `{events,users,total}`. |
| GET | `catchup/summary` | Administrator | `{users,topWatched,topDismissed,topWatchlisted}`. |

```bash
curl -X POST "$JE_URL/catchup/event" \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H 'Content-Type: application/json' \
  --data '{"type":"swipe","action":"watched","itemId":"9285e8b54149414941494edb9e464dcd","ok":true,"seasons":["1"]}'
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  "$JE_URL/catchup/events?action=watched,undo&limit=200"
```

Body fields: required valid `type` and `action`, optional `undoOf`, nullable GUID `itemId`, nullable boolean `ok`, optional string array `seasons`.

Type/action are lowercased; type must be `swipe`, actions `watched`, `dismiss`, `watchlist`, `open`, `undo`. Supplied `undoOf` must be a known action. Invalid action/type returns `400`; missing existing caller returns `401` when recording.

Identity, time, title, and item kind are server-derived. Seasons retain at most 100 entries, each clipped to eight characters; `"all"` represents all seasons.

With either recording toggle off, requests reaching the action return `204` without its identity/event validation. Authentication and MVC binding still apply. `204` is acceptance rather than a JSON receipt or guaranteed durable write: logging I/O failures are caught internally.

| Feed query | Default/rules |
|---|---|
| `user` | Unset; username equality, case-insensitive. |
| `action` | Unset; comma-separated known values, compared case-sensitively to stored lowercase actions. |
| `q` | Unset; title substring, case-insensitive. |
| `since` | Unset; inclusive lexical comparison with stored UTC `yyyy-MM-ddTHH:mm:ssZ` strings. |
| `limit` | `200`; clamped `1..1000`. |

Events return in reverse retained-log order. Each has `ts`, `userId`, `user`, `type`, `action`, `undoOf`, `itemId`, `itemName`, `kind`, `ok`, `seasons`; optional values can be null. `users` and `total` cover the entire retained log, rather than only the filtered page.

Summary `users` entries have `user`, `lastSeen`, `watched`, `dismiss`, `watchlist`. Top lists have at most 15 `{itemId,name,kind,count,users}` records each. Counts are distinct surviving username/item/action marks, ignore `ok:false`, and account for undo.

Storage is `catchup-log.jsonl` plus `catchup-log.1.jsonl` at the shared plugin configuration root. The live file rotates before the next append once it exceeds 5 MiB, replacing older rotated history. Retention is bounded. Admin reads work with recording disabled.

## Usage Analytics API

Track the plugin's supported usage counters or preview a report. See [community analytics](community-analytics.md) for reporting behavior.

| Setting | Default | What it does |
|---|---|---|
| **Share Anonymous Usage Statistics** | `false` | `AnalyticsEnabled`; master opt-in. |
| **Feature toggle states (on/off only)** | `true` | `AnalyticsShareFeatureFlags`; report flag category. |
| **Feature usage counts** | `true` | `AnalyticsShareUsageCounts`; enables tracking alongside master. |
| **Data file sizes (bytes only, never contents)** | `true` | `AnalyticsShareDataSizes`; report size category. |

| Method | Path | Access | Contract |
|---|---|---|---|
| POST | `usage/track` | Authenticated | `{"key":"seerr.request_submitted"}` → empty `200`. |
| POST | `usage/preview` | Administrator | JSON object with optional booleans `shareFeatureFlags`, `shareUsageCounts`, `shareDataSizes` → preview. |

```bash
curl -X POST "$JE_URL/usage/preview" \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H 'Content-Type: application/json' \
  --data '{"shareFeatureFlags":true,"shareUsageCounts":true,"shareDataSizes":false}'
```

Allowed counter keys are `seerr.request_submitted`, `continue_watching.auto_removed`. Tracking returns empty `200` without recording unless master and usage counts are both enabled.

When active, an expected object with missing/non-string, invalid-format, or unknown `key` returns `400`. Use an object; action-level `400` behavior is not guaranteed for arbitrary non-object JSON.

Preview falls back to saved category values for omitted/non-boolean properties. It returns `Payload`, `LastReportedAt` (Unix milliseconds), and `LastPayloadJson` (string).

`Payload` contains strings `InstallId`, `PluginVersion`, `JellyfinVersion`, `JellyfinTarget`, `Period`, nullable boolean map `Config`, nullable string map `Settings`, nullable byte-size map `DataFileSizes`, and nullable `Events` array of `{key,count}`.

It neither registers an installation nor transmits a report. An unregistered installation shows a placeholder ID. Missing configuration returns `503`.

The admin **Preview** button sends unsaved category values; its controls appear when the master checkbox is checked.

## Active Streams & Proxy

Use these routes to read playback sessions, broadcast messages, retrieve avatars, or find Jellyfin item IDs from provider IDs.

### Sessions and broadcasts

Read now-playing sessions or send an administrator message to sessions with usable usernames.

| Setting | Default | What it does |
|---|---|---|
| **Active Streams Header Widget** | `false` | `ActiveStreamsEnabled`; disabled sessions/broadcast return `503`. |
| **Show widget to non-admins** | `false` | `ActiveStreamsAllUsers`; allows viewer session reads, otherwise `403`. |

| Method | Path | Access | Contract |
|---|---|---|---|
| GET | `active-streams/sessions` | Administrator, or authenticated with viewer setting enabled | Bare now-playing session array. |
| POST | `active-streams/broadcast` | Administrator | `{Header,Text,TimeoutMs}` → `{sent,skipped,errors}`. |
| GET | `proxy/avatar` | Authenticated | Query `path` → cached raster image bytes. |
| GET | `items/by-providers` | Authenticated | Query provider dictionary and optional `types` → one matching GUID. |

```bash
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/active-streams/sessions"
curl -X POST "$JE_URL/active-streams/broadcast" \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H 'Content-Type: application/json' \
  --data '{"Header":"Notice","Text":"Please finish playback soon.","TimeoutMs":30000}'
```

Non-admin `RemoteEndPoint` is null/omitted. Session lookup failure returns `500`.

??? note "Session response fields"

    Session fields are `UserId`, `UserName`, `UserHasPrimaryImage`, `Client`, `DeviceName`, `RemoteEndPoint`, `LastActivityDate`, `NowPlayingItem`, `PlayState`, `TranscodingInfo`.

    - `NowPlayingItem` has `Id`, `Type`, `Name`, `SeriesName`, `RunTimeTicks`, `ProductionYear`, `ParentIndexNumber`, `IndexNumber`, `ImageTags`, `SeriesId`, `SeriesPrimaryImageTag`, `MediaStreams` (`Type`, `Codec`, `BitRate`).
    - `PlayState` has `IsPaused`, `PositionTicks`, `PlayMethod`.
    - `TranscodingInfo` has `IsVideoDirect`, `VideoCodec`, `AudioCodec`, `Bitrate`, `TranscodeReasons`, `CompletionPercentage`, `Width`, `Height`, `Framerate`.

Broadcast requires nonblank `Text` (`400` otherwise), optional nullable `Header`/`TimeoutMs`.

It attempts all sessions with a usable username other than `Unknown`, including idle sessions. Send failures increment `skipped` and add error strings; a successful HTTP response can contain failures.

### Avatar and item-ID lookup

Retrieve an avatar from the first configured Seerr URL, or look up a Jellyfin item by provider IDs.

Avatar uses the first configured Seerr URL and strips query/fragment from `path`. It accepts `/avatar/`, `/avatarproxy/`, `/api/v1/avatar/`; traversal/scheme/unsafe paths return `400`.

Missing setup/image, upstream failure, or unsupported MIME returns `404`. Supported raster MIME types are PNG, JPEG/JPG, GIF, WebP, AVIF, BMP.

It caches for one hour with ETag and `304`; no caller linkage is required.

```bash
curl -G -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  --data-urlencode 'path=/avatar/example.png' "$JE_URL/proxy/avatar"
curl -G -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  --data-urlencode 'providers[Tmdb]=603' --data-urlencode 'types=Movie' \
  "$JE_URL/items/by-providers"
```

Provider lookup accepts multiple dictionary entries such as `providers[Tmdb]`, `providers[Imdb]`. `types` is a comma-separated item-kind list parsed case-insensitively; invalid kinds are ignored. No IDs/match returns `400` with `No provider ids supplied or no items found`; success is a GUID value.

Repository lookup is not filtered to caller library access and does not establish permission to view the returned item.

## Branding

Upload, retrieve, and remove custom branding assets. No enable toggle is required for storage operations.

Valid slots are `icon-transparent.png`, `banner-light.png`, `banner-dark.png`, `favicon.ico`, `apple-touch-icon.png`; names normalize to lowercase.

| Method | Path | Access | Request → response |
|---|---|---|---|
| POST | `UploadBrandingImage` | Administrator | Multipart first file plus form `fileName` → success string `File uploaded successfully`. |
| GET | `BrandingStatus` | Authenticated | Filename-to-existence boolean map for all five slots. |
| GET | `BrandingImage` | Authenticated | Query `fileName` → stored bytes with extension-derived MIME. |
| POST | `DeleteBrandingImage` | Administrator | Form `fileName` → success string `File deleted successfully`. |

```bash
curl -X POST "$JE_URL/UploadBrandingImage" \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -F 'file=@logo.png;type=image/png' -F 'fileName=icon-transparent.png'
curl -X POST "$JE_URL/DeleteBrandingImage" \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  --data-urlencode 'fileName=icon-transparent.png'
```

Upload checks an `image/` MIME prefix and a **10 MiB** maximum; it does not decode-validate image contents.

Missing files/fields in a valid form, a missing retrieval `fileName`, unsupported slot/MIME, or oversized upload returns `400`.

Upload/delete requests without a supported form content type return `500` when the actions try to read form data. Missing retrieval/deletion file returns `404`; filesystem permission failures on upload/delete return `403`; internal/filesystem errors `500`.

Delete reads a form, rather than JSON, and uses POST. Upload overwrites the selected slot.

## Maintenance Mode

Use these routes to check, enable, or end a maintenance window and send maintenance messages.

These routes require **Administrator** access. See [Other settings](../other/other-settings.md) for maintenance configuration.

| Method | Path | Request → response |
|---|---|---|
| GET | `MaintenanceMode/Status` | Current state object. |
| POST | `MaintenanceMode/Enable` | JSON request below → `{"success":true}`. |
| POST | `MaintenanceMode/Disable` | Optional query `includeScheduled=true` → `{"success":true}`. |
| GET | `MaintenanceMode/Users` | Bare array of all eligible non-admin `{Id,Username,HasImage}` accounts. |
| POST | `MaintenanceMode/Broadcast` | `{Header,Text,TimeoutMs}` → `{sent,skipped,errors}`. |

```bash
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/MaintenanceMode/Status"
curl -X POST "$JE_URL/MaintenanceMode/Enable" \
  -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  -H 'Content-Type: application/json' \
  --data '{"Message":"Maintenance notice","DurationMinutes":15,"Action":"none"}'
curl -X POST -H "Authorization: MediaBrowser Token=\"$TOKEN\"" \
  "$JE_URL/MaintenanceMode/Disable?includeScheduled=true"
```

| Enable property | Default | Meaning |
|---|---|---|
| `Message` | Empty effective message | Banner text. |
| `NotificationMessage` | Null | Optional popup text; falls back to message. |
| `DurationMinutes` | `0` | Positive minutes set a deadline; nonpositive means open-ended. |
| `Action` | `"disable_accounts"` | Recognized, case-sensitive strings: `none`, `disable_accounts`, `disable_remote`, `both`. |
| `AffectedUserIds` | Null | Null/empty targets all non-admin users. Otherwise string-array target IDs. |

!!! warning "Maintenance access changes"

    `disable_accounts` and `both` can disable selected accounts; `disable_remote` and `both` can disable remote access. Use `Action:"none"` for a notice-only window. Unknown action strings are not rejected, but disable neither account nor remote access.

For an active manual window, resending the same duration, action, and affected-user set preserves the existing deadline. Target-set comparison ignores order/duplicates but compares supplied strings, so differently formatted IDs can compare differently. Changing these values can establish a new deadline.

Status fields are `IsActive`, `Message`, `NotificationMessage`, `Action`, `Source` (`manual`/`schedule` when active), `StartedAt`, `EndsAt`, `AccountDisabledCount`, `RemoteDisabledCount`, `ServerLocalTime` (`HH:mm`), `ServerUtcOffset` (such as `+08:00`). End time can be null for open-ended maintenance.

The Users list is the full non-admin selector list, rather than just currently affected users.

Disable defaults to ending any active manual/scheduled window. `includeScheduled=false` leaves a scheduled window running. Ending a scheduled window suppresses it until the next day's window.

Broadcast can run without active maintenance. It requires nonblank `Text` (`400` otherwise) and accepts optional `Header` and `TimeoutMs=30000`. It resolves `{countdown}`/`{ends_at}` against the maintenance state. Nonpositive timeouts fall back to 30000 ms.

It attempts all sessions with a usable username, including idle sessions. Send failures are returned in `errors` and included in `skipped`.

## Misc

Use these routes to reset user preferences from server defaults or retrieve a registered JE page's HTML.

| Method | Path | Access | Contract |
|---|---|---|---|
| POST | `reset-all-users-settings` | Administrator | No body → `{success,userCount,totalUsers,skippedSettingsUserIds,skippedHcUserIds}`. |
| GET | `{viewName}` | Authenticated | Exact registered plugin view name → HTML. |

```bash
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/bookmarksPage"
```

Reset enumerates existing canonical user configuration directories and replaces Enhanced settings using copied server defaults, with model-default exceptions. `WatchProgressMode` resets to `"percentage"` and `WatchProgressTimeFormat` to `"hours"`, even when the saved server defaults differ.

Reset also resets Hidden Content settings while retaining items, and preferences in existing Spoiler Guard files while retaining protection lists. It does not reset bookmarks, reviews, shortcuts, or Elsewhere.

`success:true` can accompany skipped settings/Hidden Content users. Spoiler preference-reset failures are logged without a separate skipped-ID list. Missing configuration returns `500`.

The authenticated HTML catch-all recognizes exact names `calendarPage`, `downloadsPage`, `bookmarksPage`, `hiddenContentPage`, `recommendationsPage`, `activityPage`, `catchUpPage`.

These are resource URLs, separate from Jellyfin web hash navigation or placement in Plugin Pages/Custom Tabs. Unknown names/missing resources return `404`; absent plugin instance `400`. See [JE Pages & Tabs](../getting-started/pages-and-tabs.md) for placement options.

## Full Endpoint Index

The endpoint tables above enumerate all 194 controller method/path entries, including the three catch-all templates. Each group documents effective access, inputs, response shape, and limits; shared proxy rows intentionally retain the configured upstream service's JSON contract.

For implementation details, [JellyfinEnhancedController.cs](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/main/Jellyfin.Plugin.JellyfinEnhanced/Controllers/JellyfinEnhancedController.cs) implements all indexed routes except `catchup/*`, which is in [CatchUpController.cs](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/main/Jellyfin.Plugin.JellyfinEnhanced/Controllers/CatchUpController.cs). These upstream source links may advance beyond this versioned reference.

### Awards tag settings and refresh

Admin `AwardsTagsEnabled` (false) gates enrichment and seeds the per-user `AwardsTagsEnabled` default. Both settings and `AwardsTagsPosition` (`top-left`) follow new-user and reset-all defaults. `TagGroupCaps.Awards` defaults to 2, supports 0–10 (0 means all), and `awards` is a valid group in layout profiles, priority order, shape profiles and locked looks.

Admin-only `AwardsTagsImdb`, `AwardsTagsCertifiedFresh`, `AwardsTagsOscar`, `AwardsTagsEmmy`, `AwardsTagsLetterboxd` default true; `AwardsTagsImdbList` and `AwardsTagsLetterboxdList` accept a numeric list id or bounded `owner/slug`. Defaults are `sacwooky/imdb-top-250` and `abdulwahabaa/letterboxd-top-250`. `AwardsTagsRefreshHours` defaults to 24 and is clamped to 1–168 at use. Public configuration includes the gate, position and ribbon switches; the existing MDBList key remains private.

`Refresh Awards Tags` (`JellyfinEnhancedRefreshAwardTags`) is a normal Jellyfin scheduled task (04:00 daily), runnable on demand by an administrator through the existing scheduled-task API. There is no new public refresh route. Fresh titles/lists are skipped; cancellations propagate. The persisted `award-tags.json` stores immutable title facts, list ranks, refresh deadlines and hashed configuration identities. Failures keep old facts and back off one hour; no-key skips all MDBList calls. Certification confirms a refresh only when its cached answer is confirmed and younger than the Awards interval; stale answers retained after an unknown-quota or reserve skip keep the one-hour retry. Certification reads only the provider's `tomatoes.certified` flag, never `fresh` or score. MDBList cache records predating that flag are invalidated separately. Wikidata retains its existing TTLs and shares a global paced query gate with Retry-After handling. `AwardTagsService` publishes changed entry facts through the tag cache's normal generation/cursor boundary. Changing provider configuration drops incompatible cached facts without a network request. Card batch and native fallback reads remain cache-only.


### Quality stream display contracts

The administrator configuration/public config and personal settings share these fields (camelCase in the browser):

| Field | Admin default | Personal default | Accepted values |
|---|---|---|---|
| `QualityAudioDisplayMode` | `highest` | `null` (inherit) | `highest`, `all` |
| `QualityVideoCodecDisplayMode` | `highest` | `null` (inherit) | `highest`, `all` |
| `QualityHdrDisplayMode` | `highest` | `null` (inherit) | `highest`, `all` |
| `QualityMinimumResolution` | `off` | `null` (inherit) | `off`, `720p`, `1080p`, `4k` |
| `QualityHideSdr` | `false` | `null` (inherit) | Boolean |

User saves trim/lowercase modes and thresholds, normalize unknown non-null values to `highest`/`off`, and preserve null inheritance. New-user seeding and reset-all-users copy the normalized admin defaults. The Media Tags admin patch endpoint rejects invalid choices; its section declarations, field fixture and binding map include these five properties. No controls are added to the main configuration form. Quality display saves leave `TagLayoutSettingsVersion` unchanged. Active effective values enter the native settings digest, so new modes and filters select their own variants. The display-mode defaults preserve the existing selection rules; the current audio resolver and cache identities are documented below.

`StreamData.DistinctQualities` is a policy-independent array of `{Category, Label, Language?}` triples. Categories are `audioInfo`, `videoCodec` and `dynamicRange`; audio labels carry each track's own channels and retain language for exact-region/base/fallback selection. Values are deduplicated without retaining paths or names. An unknown/unprobed video track contributes no SDR; a probed non-HDR track contributes SDR. Old fixture or batch facts without the array derive the same sets from streams. Highest-only detection is unchanged.

Each `QualitySummary.Categories` / `AudioByLanguage` / `AudioRegionFallback` category additionally carries `All` (ranked union), `Shared` (intersection), `LatestAll` (latest aired episode's set) and `AllSetsAgree`. These full sets are separate from the existing bounded `Values` samples. Representative uses its own stream sets; latest/shared/best use those respective arrays. Mixed compares full sets for All categories and legacy agreement for Highest categories. Empty/unprobed episodes contribute empty sets. Existing contributor access filtering rebuilds all sets from visible episodes, and Spoiler Guard removes them with their containing quality facts; the existing access `filterRevision` continues to apply. The current cache schema (`CurrentCacheSchemaVersion` in `Services/TagCacheService.cs`) is shared with both IndexedDB readers.

Threshold and SDR filtering precede group caps, compact presentation and overflow fitting. The threshold compares detected resolution buckets inclusively, rather than raw pixel dimensions. Native and web resolve the same labels, order and caps.

### Technical chips and movie Scenes

Quality settings add `ShowRuntimeTag`, `ShowAspectRatioTag`, `ShowFrameRateTag` (all false) and `RuntimeTagOrder`, `AspectRatioTagOrder`, `FrameRateTagOrder` (8, 9, 10). They are public defaults, copied to new users and by Apply defaults to all users. Personal settings use the same names in the saved document (camelCase in the web client), with nullable overrides for these categories. The Media Tags admin page declares these switches/orders and `StatusTagsScenes` in its section modules; its patch endpoint validates booleans and orders 1–99. No new controls live on the main configuration page.

`StreamData.RunTimeTicks` belongs to the playable item (a container uses its representative episode). Video summaries carry `Width`, `AspectRatio`, `RealFrameRate`, `AverageFrameRate`, `IsInterlaced`; subtitle summaries retain `IsHearingImpaired` and `Title` alongside `DisplayTitle`. `SdhSubtitleLanguages` is a distinct language union, cloned, content-compared and stripped with subtitle facts; restricted container reads recompute it from visible contributors. Batch `/tag-data` carries the same runtime/video/accessibility facts. Hearing-impaired flags or whole-word SDH/CC title tokens set the marker without increasing subtitle chip counts.

Movie entries optionally carry `Scenes: { PostCredits: boolean, MidCredits: boolean }`. `StatusTagsScenes` defaults false on both server and user settings. The server reads exact `aftercreditsstinger` / `duringcreditsstinger` keyword names from `movie/{id}/keywords` through `TmdbResponseCache`, with a UTC-day freshness floor. Cache builds/reconciliation and enabling the admin family warm snapshots and publish them through the existing tag-cache change path. Confirmed negative results last until the next UTC day; transient failures retain a previous snapshot and retry after an hour; a provider failure pauses the remaining pass for that hour. Card batch and native reads return the last confirmed facts or nothing, without keyword requests. Missing or stale facts gather for two seconds into one background queue; the worker paces lookups at four per second, observes the same daily TTL and provider failure pause, and stops its waits and remaining movie pass when the tag-cache service is disposed. Cancelling a reader never cancels shared TMDB transport. Completed refreshes publish the movie IDs whose Scenes facts changed and invalidate only those native on-demand snapshots (and any dependent seasons/episodes). Failed or unchanged refreshes preserve existing snapshots, including when the bulk cache is disabled; enabling/disabling Scenes and provider changes compare the projected facts too. Change detection uses the live bulk entries and bounded native memo snapshots as its baselines, without retaining a separate history of movie reads. Eviction, deletion and rebuild retire the corresponding baseline; an unknown/null fact is compared with newly confirmed facts, and in-flight native builds recheck Scenes before memo publication. No key or disabled server Status/Scenes means no enrichment. Existing Status priorities win before Scenes; when both keywords exist Post-credits wins.

`LeavingSoonMaintainerrApiKey` is explicitly excluded from both user and administrator portable exports/imports, public/private configuration and runtime snapshots. The Status badges page uses a write-only password input: stored keys are never populated, compared or returned by its patch response; an unchanged blank field keeps the key. The administrator-only core Jellyfin plugin configuration API retains its normal credential-editing contract. Source URLs, collection names and cadence are administrator settings; private collection provenance never reaches tag clients.

Tag group cap normalization only clamps persisted values to 0–10, preserving valid values through saves and portable import/export. Effective presentation fixes Status and Age rating limits to one. Native resolution and web presentation also fix Logos to one when `LogoTagsMaxLogos` is one, including stored higher or unlimited caps and web look overrides. A two-logo policy keeps the configurable group cap.

The native renderer pixel version advances to 7 for Flush seams and centre-tab geometry. `PosterTagLayout.ProgressBarHeight` optionally supplies known progress-bar clearance in logical CSS pixels (zero for ordinary native image requests); it adds no stored setting or cache-entry field. Tight, Default and Bands retain their existing pixels.

Audio detection recognizes the Radarr/Sonarr [TRaSH-Guides Audio Formats](https://trash-guides.info/Radarr/Radarr-collection-of-custom-formats/#audio-formats) aliases in `DisplayTitle`, `Codec` and `Profile`, with specific-first matching: Atmos before carriers, Plus before DD, DTS-HD MA/HRA before DTS. E-AC-3/EAC3/DDP/DD+/Dolby Digital Plus resolve to Dolby Digital+. Both Atmos families retain ATMOS, DTS-ES retains DTS, FLAC and (L)PCM have their own labels, and AAC/Opus/MP3 retain the existing channel fallback. Highest only ranks each eligible track and takes codec and channels from the winning track. Dynamic range comes from `VideoRangeType` first (HLG and the DOVI family with its base layer in `DistinctQualities`); a missing or unknown type falls back to word-bounded title hints, and an unknown range is not SDR. Resolver version 14 retires native variants built with the earlier codec, dynamic-range and channel facts; the web computed-quality cache uses naming version 8. The cache version also retires derived quality facts and series summaries from the earlier detector; series/season summaries now also carry `LegacyAudio`, `LegacyAudioByLanguage` and `LegacyAudioRegionFallback`. Both consumers select these under the legacy gate for every policy, language tier and display mode.

Version-0 documents retain the previous audio detector to preserve existing chips, including ignored stored Full/Compact density values. The shared layout-version predicate controls this gate in each consumer. Normalized documents enable AC-3/DTS-HD detection. This presentation choice enters native settings digests and the web computed-quality cache identity.

The native renderer/pixel versions are now 8/8.2 to invalidate composites with the former half-width side-anchor fitting. Vertical anchors budget from logical card width, edge inset and the opposite middle group, with a gap and a half-width cap when both sides are occupied. Centre anchors retain their first chip with shaped ellipsis text when necessary, reusing its original font size, small-caps and letter spacing (including text-logo metrics); pixel 8.2 retires already-fitted text logos shaped with chip metrics; no tag-cache entry or schema changes. Existing fixtures without middle-side anchors retain their rendered pixels.

Language-chip shared-base pixels use version **8.5**. Versions 8.3 and 8.4 image tokens are retired; resolver and tag-cache schema versions stay unchanged. `data-je-language-label` on web chips corresponds to `LanguageTag.StyleLabel` in the native plan; this resolved presentation label is not a persisted cache-entry field.

Language code chips retain quality-chip fonts and height with tighter horizontal padding (2–4 logical pixels). Web corner language columns yield whole chips into `+N` to reserve a neighbouring centered rating or overflow indicator. A rating value that cannot fit whole is counted in overflow; it is never ellipsized. Plain legacy flag columns retain their geometry.
