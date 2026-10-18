# Jellyfin Enhanced's API

Use Jellyfin Enhanced (JE)'s API to manage bookmarks, reviews, and personal settings, retrieve metadata, and work with integrations through HTTP(S) requests. Install and enable the plugin on your server first.

To use these APIs from a custom Jellyfin client, you need an HTTP client and a Jellyfin credential. You do not need the injected JE scripts.

This reference covers the 258 method/path entries in plugin version **12.12.0.0**, including the experimental [Requests & downloads (new)](#requests-downloads-new) routes. Use the endpoint tables to check access requirements, inputs, responses, and limits.

Paths in endpoint tables are relative to `/JellyfinEnhanced/`. Braces mark path parameters; replace them before making a request. The catch-all routes serve only the resources described below.

??? note "Which IDs to use"

    Reviews use author + media type + TMDB key as their identity. Bookmarks use bookmark IDs and contain a Jellyfin item ID, with optional TMDB/TVDB metadata.

    Seerr request, issue, user, and service IDs belong to Seerr; they are not Jellyfin GUIDs or TMDB IDs.

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
| PATCH | `user-settings/{userId}/consent` | Set one personal consent of the signed-in person (`{"Field":"AutoSeasonRequests","Value":true}`; fields `AutoSeasonRequests`, `AutoMovieRequests`, `ListSwapIn`) |
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

A save of `settings.json` replaces the whole file. Whoever saves it (the person, or an administrator saving their own or someone else's), the save keeps every personal consent (automatic season requests, automatic movie requests, list swap-in) as stored, so a stale browser cannot restore a revoked agreement.

Only the signed-in person changes a consent, one at a time, with `PATCH /JellyfinEnhanced/user-settings/{userId}/consent` and `{"Field":"AutoMovieRequests","Value":false}`: own person only (`403` for anyone else, administrators included). `Value` is `true` or `false`; for `AutoSeasonRequests` and `AutoMovieRequests` it may also be `null` (follow the administrator's recipe setting). A missing value, `null` for `ListSwapIn` or an unknown field is `400 invalid_consent`. The answer and the settings POST's answer carry `consents` with every consent as stored (`{"AutoSeasonRequests":null,"AutoMovieRequests":false,"ListSwapIn":true}`).

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

GET can create a first settings file using saved administrator defaults. It adds `IsAdmin`, computed for the **caller**, even when reading another user's document. POST ignores that derived field.

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
| `ShowDynamicRangeTag` | Boolean | `true` |
| `ShowSpecialFormatTag` | Boolean | `true` |
| `ShowVideoCodecTag` | Boolean | `true` |
| `ShowAudioInfoTag` | Boolean | `true` |
| `ResolutionTagOrder` | Nullable integer | `null` |
| `SourceTagOrder` | Nullable integer | `null` |
| `DynamicRangeTagOrder` | Nullable integer | `null` |
| `SpecialFormatTagOrder` | Nullable integer | `null` |
| `VideoCodecTagOrder` | Nullable integer | `null` |
| `AudioInfoTagOrder` | Nullable integer | `null` |
| `GenreTagsEnabled` | Boolean | `false` |
| `LanguageTagsEnabled` | Boolean | `false` |
| `RatingTagsEnabled` | Boolean | `false` |
| `AgeRatingTagsEnabled` | Boolean | `false` |
| `PeopleTagsEnabled` | Boolean | `false` |
| `TagsHideOnHover` | Boolean | `false` |
| `QualityTagsPosition` | String | `"top-left"` |
| `QualityTagsPreferredAudioLanguage` | String | `""` |
| `GenreTagsPosition` | String | `"top-right"` |
| `LanguageTagsPosition` | String | `"bottom-left"` |
| `RatingTagsPosition` | String | `"bottom-right"` |
| `RatingTagsOnMovies` | Boolean | `true` |
| `RatingTagsOnSeries` | Boolean | `true` |
| `RatingTagsOnSeasons` | Boolean | `true` |
| `RatingTagsOnEpisodes` | Boolean | `true` |
| `RatingTagsOnContinueWatching` | Boolean | `true` |
| `RatingTagsOnNextUp` | Boolean | `true` |
| `AgeRatingTagsPosition` | String | `"bottom-right"` |
| `ShowRatingInPlayer` | Boolean | `true` |
| `RemoveContinueWatchingEnabled` | Boolean | `false` |
| `LastOpenedTab` | String | `""` |
| `ReviewsExpandedByDefault` | Boolean | `false` |
| `DisplayLanguage` | String | `""` |
| `CalendarDisplayMode` | String | `"list"` |
| `CalendarDefaultViewMode` | String | `"agenda"` |

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
| GET | `jellyseerr/user-status` | Authenticated/caller | `active`, `userFound`, `reason`; linked results also contain string `jellyseerrUserId` and booleans `canRequestAdvanced` and `canViewIssues` (whether `jellyseerr/issue` would answer the caller or refuse with `403`); `no-store`. |
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
{"active":true,"userFound":true,"reason":"linked","jellyseerrUserId":"7","canRequestAdvanced":false,"canViewIssues":true}
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
| GET | `jellyseerr/tv/{tmdbId}/ratings` | Upstream TV ratings; `null` for a series Rotten Tomatoes doesn't know. |
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
| **Apply Tag Styles To** | `"both"` | `TagStyleTarget`; `both`, `web`, or `native`. |
| **Enable Native Poster Tags (Experimental)** | `false` | `NativePosterTagsEnabled`; delivery toggle, rather than a preview prerequisite. |

| Method | Path | Access | Request → response |
|---|---|---|---|
| POST | `tag-cache/rebuild` | Administrator | No body → `{success:true,message:"Tag cache rebuild started in the background."}`. |
| GET | `tag-cache/{userId}` | Own/admin | Optional `since` signed 64-bit cursor → cache envelope below; ETag/`304`. |
| POST | `tag-data/{userId}` | Own/admin | Raw nonempty string array, at most 200 IDs; optional `mediaSourceId` → `{Items:[<item>]}`. |
| GET | `item-stats/{userId}/{itemId}` | Own/admin | Optional `mediaSourceId` → `{success,size,progress,totalPlaybackTicks,totalRuntimeTicks}`. |
| GET | `file-size/{userId}/{itemId}` | Own/admin | Optional `mediaSourceId` → `{success,size}`. |
| GET | `watch-progress/{userId}/{itemId}` | Own/admin | `{success,progress,totalPlaybackTicks,totalRuntimeTicks}`. |
| GET | `tag-styles` | Authenticated | Effective web override set. |
| GET | `tag-styles/catalog` | Administrator | Shipped quality/age style catalog. |
| GET | `native-poster-tags/preview/{itemId}` | Administrator | JPEG diagnostic preview; query below. |

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

Use the cache for full snapshots or updates since a cursor. Use `tag-data` to fetch a batch of items directly, including when cached delivery is disabled.

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
| `Type`, `TmdbId`, `SeriesTmdbId`, `OfficialRating`, `SeriesId` | Nullable strings |
| `SeasonNumber`, `EpisodeNumber` | Nullable integers |
| `Genres`, `AudioLanguages`, `PartialAudioLanguages` | Nullable string arrays |
| `CommunityRating`, `CriticRating` | Nullable numbers |
| `LastUpdated` | Integer milliseconds |
| `StreamData` | Nullable `{Streams,Sources,ItemName,ItemPath}` |

`StreamData.Streams` contains `Type`, `Language`, `Codec`, `CodecTag`, `Profile`, `Height`, `Channels`, `ChannelLayout`, `VideoRangeType`, `DisplayTitle`; strings/numeric fields can be null. `Sources` contains `{Path,Name}`. These are trimmed tag data, rather than complete Jellyfin item DTOs.

Batch `tag-data` ignores malformed/inaccessible IDs. Items contain `Id`, `Type`, `Genres`, `CommunityRating`, `CriticRating`, `OfficialRating`, `SeriesId`, `ProviderIds`, `Name`, basename-only `Path`, trimmed `MediaStreams`, `MediaSources`, and nullable `FirstEpisode`.

Streams use the trimmed stream fields listed above, and sources contain basename-only `Path` and `Name`.

Container `FirstEpisode` has `{Id,Type,Genres,NeedsStreamFetch:true}`; fetch that episode through `tag-data` for its streams.

Spoiler Guard can strip metadata before return and add `Tags` on stripped stubs. `mediaSourceId` selects a media version; this route does not require cached delivery enabled.

Statistics aggregate playable descendants where applicable. `size` is bytes, `progress` an integer percentage, durations Jellyfin ticks (**10,000,000 ticks per second**). `mediaSourceId` filters size, rather than watch progress.

### Style and native-preview contracts

Read effective web styles or the shipped style catalog. As an administrator, use native preview to inspect how tags render on an item's artwork.

`tag-styles` returns `{quality,age,rating,genre}`. The first three are maps; `genre` is a nullable color object. Color objects have `background`, `border`, `color`. Age keys are individual rating strings.

If disabled or native-only, maps are empty and genre null. Missing configuration returns `503`. `TagStyleOverrides` defaults to `""` and stores editor-generated overrides.

Catalog has `quality:[{label,background,color}]`, `age:[{id,background,border,color,ratings}]`. It provides shipped defaults, rather than a user's effective styles.

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

Diagnostic headers use the prefix `X-JE-Poster-Tags-`: `Status`, `Artwork` (`original`), `Master-Enabled`, `User-Enabled`, `Any-Group`, `Settings-Digest`, `Spoiler-Stripped`.

### Audio tags, awards, MDBList, and content warnings

Use these routes to look up language tag names, awards, external ratings, and DoesTheDogDie content warnings. The account-status route lets administrators check MDBList limits.

| Setting | Default | What it does |
|---|---|---|
| **Enable Audio Language Tags Sync** | `false` | `AudioLanguageTagSyncEnabled`; gates audio tag-name lookup. |
| **Tag Prefix** | `"JE Language: "` | `AudioLanguageTagPrefix`; prefixes language tag names. |
| **Show Awards Banner** | `false` | `ShowAwards`; enables Wikidata lookup, without a TMDB key requirement. |
| **Enable MDBList Ratings** | `false` | `MdblistRatingsEnabled`; gates MDBList title responses. |
| **MDBList API Key** | `""` | `MdblistApiKey`; enables upstream lookups. |
| **Show Content Warnings** | `false` | `DoesTheDogDieEnabled`; also needs a nonblank `DoesTheDogDieApiKey`. |

| Method | Path | Access | Contract |
|---|---|---|---|
| GET | `audio-language-tags` | Authenticated | Query `codes` → `{code:{baseTag,variantTag}}`; disabled returns `{}`. |
| GET | `awards/{mediaType}/{tmdbId}` | Authenticated | `movie`, `tv`, or `person` → awards object. |
| GET | `mdblist-ratings/{mediaType}/{tmdbId}` | Authenticated | `movie` or `tv` → MDBList object. |
| GET | `mdblist-ratings/account-status` | Administrator | Optional nonblank query `apiKey` override → live account status. |
| GET | `ddd/{mediaType}/{tmdbId}` | Authenticated | `movie` or `tv` → caller-specific DoesTheDogDie object; a signed-in human user is required. |
| GET | `ddd/topics` | Authenticated | Topic catalogue for the trigger picker. |

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

DoesTheDogDie object: `{Guarded,PolicyRevision,Found,ItemId,Name,Topics,Confirmed,FetchedAtUnixMs}`. Replies are `private, no-store`. A protected library title (including collection protection) or pending-TMDB title returns `Guarded:true` with no topics or title details. To explicitly reveal warnings, repeat the request with `?reveal=true&policyRevision=<PolicyRevision>` from this viewer’s current reply. The revision is bound to the viewer, title and current protection policy; another viewer’s revision or an old revision cannot reveal topics. The raw upstream cache is shared, but its contents are checked against current viewer protection on every reply. Each topic has `{Id,Name,Yes,No}`, where `Yes` and `No` are vote counts; only topics with at least one vote are included. `ItemId` builds the title link `https://www.doesthedogdie.com/media/{ItemId}`. Cached found results last 30 days, confirmed misses 14 days, and failed lookups return `Confirmed:false` and are retried after an hour. Movie and show matches are separated by media type, because one TMDB ID can exist as both.

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
| `Prefetched` | `{SpoilerBlurSeries,SeerrUserStatus,SeerrStatus,ActiveStreamSessions}`; standalone response shapes or null. |

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
    | `PauseScreenEnabled`, `ShowPlaybackRatingBadge`, `NativePosterTagsEnabled`, `TagStyleWebActive`, `QualityTagsEnabled`, `ShowResolutionTag`, `ShowSourceTag`, `ShowDynamicRangeTag` | Boolean |
    | `ShowSpecialFormatTag`, `ShowVideoCodecTag`, `ShowAudioInfoTag`, `GenreTagsEnabled`, `LanguageTagsEnabled`, `RatingTagsEnabled`, `AgeRatingTagsEnabled`, `PeopleTagsEnabled` | Boolean |
    | `DisableAllShortcuts`, `DisableCustomSubtitleStyles`, `LanguageTagsPriorityStrict`, `QualityTagsAudioLanguageFromUser`, `RatingTagsOnMovies`, `RatingTagsOnSeries`, `RatingTagsOnSeasons`, `RatingTagsOnEpisodes` | Boolean |
    | `RatingTagsOnContinueWatching`, `RatingTagsOnNextUp`, `ShowRatingInPlayer`, `DisableTagsOnSearchPage`, `TagsHideOnHover`, `TagCacheServerMode`, `EnableTagsLocalStorageFallback`, `JellyseerrEnabled` | Boolean |
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
    | `ToastDuration`, `HelpPanelAutocloseDelay`, `PauseScreenDelaySeconds`, `ResolutionTagOrder`, `SourceTagOrder`, `DynamicRangeTagOrder`, `SpecialFormatTagOrder`, `VideoCodecTagOrder` | Integer |
    | `AudioInfoTagOrder`, `DefaultSubtitleStyle`, `DefaultSubtitleSize`, `DefaultSubtitleFont`, `DefaultSubtitleTextEffect`, `TagsCacheTtlDays`, `DownloadsPollIntervalSeconds`, `SpoilerBlurIntensity` | Integer |
    | `SplashScreenImageUrl`, `DEFAULT_REGION`, `DEFAULT_PROVIDERS`, `IGNORE_PROVIDERS`, `ElsewhereCustomBrandingText`, `ElsewhereCustomBrandingImageUrl`, `WatchProgressDefaultMode`, `WatchProgressTimeFormat` | String |
    | `MdblistRatingsSources`, `DefaultLanguage`, `QualityTagsPosition`, `GenreTagsPosition`, `LanguageTagsPosition`, `LanguageTagsPriority`, `QualityTagsPreferredAudioLanguage`, `RatingTagsPosition` | String |
    | `AgeRatingTagsPosition`, `JellyseerrBaseUrl`, `JellyseerrUrlMappings`, `ArrTagsPrefix`, `ArrTagsLinksFilter`, `ArrTagsLinksHideFilter`, `AudioLanguageTagPrefix`, `IconStyle` | String |
    | `CalendarFirstDayOfWeek`, `CalendarTimeFormat`, `MaintenanceModeMessage`, `MaintenanceModeAction`, `MaintenanceModeAffectedUsers` | String |
    | `ClearLocalStorageTimestamp`, `ClearTranslationCacheTimestamp` | Integer |
    | `Shortcuts` | Array of `{Name,Key,Label,Category}` |
    | `MaintenanceModeEndsAt` | Nullable ISO timestamp |

Private configuration is `no-store`. Admin fields are strings `SonarrUrl`, `RadarrUrl`, `BazarrUrl`, `SonarrUrlMappings`, `RadarrUrlMappings`, `BazarrUrlMappings`, `ShokoUrl`, `ShokoUrlMappings`; arrays `SonarrInstances`, `RadarrInstances` of `{Name,Url,UrlMappings,Enabled}`; and booleans `SonarrInstancesCorrupt`, `RadarrInstancesCorrupt`. This is selected link configuration and diagnostics, rather than the complete saved model. The separate admin `jellyseerr/settings/{type}` endpoint can return upstream API keys.

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
| GET | `arr/validate/sonarr` | Query `url`, header `X-Arr-ApiKey` → `{ok:true}`. Checks the app name; a masked key plus `instanceId` tests the saved key against that instance's saved URL. |
| GET | `arr/validate/radarr` | Query `url`, header `X-Arr-ApiKey` → `{ok:true}`. Same checks as Sonarr. |
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

These reads require authentication and answer `403` with `code: "feature_disabled"` while their page is off. Queue/history are administrator-visible without Seerr linkage. Anyone else only gets rows of titles they may see; **Filter Downloads by User Requests** narrows that to a linked caller's requests.

| Setting | Default | What it does |
|---|---|---|
| **Filter Downloads by User Requests** | `true` | `DownloadsFilterByUserRequests`; filters non-admin queue/history by caller's linked Seerr requests, and scopes their `arr/requests` list to their own requests. |
| **Show Download History Section** | `true` | `DownloadsShowHistory`; controls history availability. |
| **Restrict Download History to Admins** | `false` | `DownloadsHistoryAdminOnly`; hides history from viewers. |
| **Poll Interval (seconds)** | `30` | `DownloadsPollIntervalSeconds`; also cache TTL, clamped `5..300` seconds. |

| Method | Path | Parameters → response |
|---|---|---|
| GET | `arr/queue` | Requests page on. No parameters → `{items,errors}`; every row for an administrator, otherwise rows of titles the caller may see. |
| GET | `arr/history` | Requests page on. `take=20` clamped `1..50`, `skip=0` minimum 0 → `{items,totalPages,visible,errors}`; filtered like the queue before paging, and `errors` lists instances whose history can't be read. |
| GET | `arr/requests` | Requests or Calendar page on. `take=20` clamped `1..200`, `skip=0` minimum 0, optional `filter`, `userOnly=false` → `{requests,totalPages,totalResults,canApproveRequests}`. |
| POST | `arr/requests/{requestId}/approve` | Seerr request ID, no body → `{success:true}`. |
| POST | `arr/requests/{requestId}/decline` | Seerr request ID, no body → `{success:true}`. |

```bash
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/arr/history?take=20&skip=0"
curl -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/arr/requests?filter=processing&userOnly=true"
curl -X POST -H "Authorization: MediaBrowser Token=\"$TOKEN\"" "$JE_URL/arr/requests/42/approve"
```

Queue items contain `id`, `source`, `instanceName`, `title`, `subtitle`, nullable `seasonNumber`, `episodeNumber`, `status`, `progress`, `totalSize`, `sizeRemaining`, `timeRemaining`, `posterUrl`, `tmdbId`. Progress is percentage (rounded to one decimal); sizes are bytes. Errors contain `instanceName`, `source`, `reason`. Per-instance failures preserve other instances' items.

History items contain `source`, `instanceName`, `title`, `subtitle`, `eventType`, `date`, `posterUrl`, `tmdbId`; grouped Sonarr packs additionally contain `episodeCount`, `importedCount`, `failedCount`. Event types include `imported`, `failed`, and grouped `partial`. The merged history is bounded to 200 entries before caller filtering/paging; `totalPages` covers this visible window, rather than all upstream history.

Instance failures can yield partial/empty history; `errors` names each instance whose history can't be read.

History disabled or admin-restricted returns successful empty results with `visible:false`. Unavailable non-admin linkage/request data can return successful empty queue/history with history `visible:true`.

Thus an empty successful result can mean privacy filtering, rather than an empty server queue. Missing plugin configuration returns `500`.

Requests uses Seerr credentials and caller linkage (`400` for missing caller claim, `404` for unlinked). Missing saved URL/key can return an empty successful response without `canApproveRequests`; other unavailable upstream results return error statuses rather than a successful empty list.

This enriched endpoint differs from the raw `jellyseerr/request` proxy. It does not merge queue items into its `requests` array; queue is fetched separately.

Request records contain `id`, `type`, `title`, `year`, `posterUrl`, `tmdbId`, `tvdbId`, `mediaStatus`, `requestStatus`, `requestedBy`, `requestedByAvatar`, `createdAt`, `jellyfinMediaId`, `digitalReleaseDate`, `theatricalReleaseDate`, `initialAirDate`, `nextAirDate`, `isComingSoon`, `isOrphaned`. Optional fields can be missing/null.

Raw request statuses are `1` Pending, `2` Approved, `3` Declined, `4` Failed, `5` Completed, separate from media availability.

`filter` recognizes `pending`, `approved`, `available`, `processing`, `comingsoon`; other values use the upstream unfiltered list. Callers without `REQUEST_VIEW`, `MANAGE_REQUESTS`, or admin authority see only their own requests; `userOnly=true` also enforces this, and so does **Filter Downloads by User Requests** for every non-admin.

Processing/Coming Soon split a 500-record upstream processing window: future release/air-date items go to Coming Soon, others Processing, excluding orphaned rows from both.

Orphan detection considers old Approved/Processing requests and missing content in configured *arr instances. Counts/pagination on the split are bounded to that source window. Parental filtering applies.

Approve/decline requires a linked caller with Jellyfin administrator authority, Seerr `ADMIN`, or `MANAGE_REQUESTS`. Missing setup returns `503`; missing caller identity `400`; unlinked `404`; insufficient permission `403`. It uses the first configured URL and passes upstream failure statuses through. An administrator API key lacking a linked caller cannot bypass linkage.

??? info "Snapshots and per-instance errors"
    The Sonarr/Radarr data of the routes above comes from in-memory snapshots, refreshed in the background
    while a page uses them (queue and history at the Requests page's poll interval, calendar and library
    every 15 minutes), so a request makes no call to Sonarr or Radarr. A calendar range before last month
    or more than about three months ahead is read in the background by whole months (two at a time per
    instance at most; the request waits up to 15 seconds) and kept for 15 minutes; when the instance can't
    be read, the error is reported and that month is tried again 30 seconds later. The link routes report an
    instance's latest read error even while they still answer from the list read before. Each per-instance entry in
    `errors` has `instanceName`, `source` and a short `reason`; admins also get `detail`. A route whose page
    is switched off answers `403` with `code: "feature_disabled"`.

??? info "Who sees which downloads and calendar rows"
    Administrators (and Jellyfin API keys) get every row.
    Anyone else gets a queue or history row only for a title they may see: one Jellyfin has, when Jellyfin lets
    them open it (library access, parental rating and tags; down to single episodes of a season pack, whose
    counts shrink with them); one Jellyfin doesn't have yet, when they can open a library its instance is
    linked to (an instance without linked libraries counts as open to all) or, for users with a parental
    limit, only when they asked for it in Seerr (the integration's request list, or without it the user's
    Seerr requests, read only when some row waits on them, reused for about 30 seconds by both routes and
    never waited on for more than about 2 seconds; when Seerr can't be read, an older answer, up to 10 minutes
    old, is served meanwhile; answers are dropped when the Seerr settings are saved). A row without a
    TMDB (movie) or TVDB (series) id is never shown to them. "Filter Downloads by User Requests" narrows this
    further to titles they requested in Seerr. On the
    Calendar, with "filter by library access" on, an event Jellyfin has is Jellyfin's own check (the
    episode itself too, when Jellyfin has it in that copy, found by its ids or by its season and episode
    number): every copy counts when a title is in more than one library, and the event's `itemId` /
    `itemEpisodeId` point at the caller's own copy; an upcoming title it doesn't have yet is shown when the caller
    may open the library it lands in: the instance's linked libraries, else its folder through the
    instance's path mappings (the longest one that applies) and the Jellyfin library whose folder holds it.
    A folder no library holds, or, with no mapping for the folder, a root folder another instance also has
    unmapped or root folders of an instance that can't be read yet, hides the event from everyone but
    administrators (the System tab's path doctor flags such roots: `shared_root`, `roots_unknown`). Other callers without a known Jellyfin user get no events while this filter is on.

### Calendar

Read upcoming events from configured sources, then use user-data to retrieve favorite and watched flags for event references.

| Setting | Default | What it does |
|---|---|---|
| **Filter by Library Access** | `true` | `CalendarFilterByLibraryAccess`; excludes events the caller can't open, and upcoming titles whose destination library they can't open or that can't be told. |

| Method | Path | Access | Request → response |
|---|---|---|---|
| GET | `arr/calendar` | Authenticated; Calendar page on | Optional query `start`, `end` → `{events,errors}`. Each event's `id` is opaque and unique across instances and sources (the source, instance and Sonarr episode, Radarr movie and release type, or Shoko episode, joined by `|`). |
| POST | `arr/calendar/user-data` | Existing caller; Calendar page on | `{Events:[<event reference>]}` → `{results:[{id,isFavorite,isWatched}]}`. Body ≤ 1 MiB and at most 2000 distinct item ids (`400 too_many_ids` before any lookup); flags only for items the caller can open; `403 user_required` for an API key. |

GET defaults to today's UTC date through 90 days ahead. Parseable dates override each endpoint; invalid dates retain defaults, reversed ranges swap, ranges over 365 days cap at 365. Missing configuration returns `500`. Enabled Sonarr/Radarr and configured Shoko contribute events; per-source errors contain `instanceName`, `source`, `reason`.

Calendar events contain `id`, `source`, `type`, `title`, `subtitle`, `releaseDate`, `releaseType`, `hasFile`, `monitored`, `posterUrl`, `backdropUrl`, `imdbId`, Jellyfin `itemId`, `itemEpisodeId`, `overview`, `tvdbId`, `seasonNumber`, `episodeNumber`, `episodeTvdbId`, `episodeImdbId`, upstream `seriesId`, `tmdbId`, `shokoSeriesId`, `shokoEpisodeId`, `instanceName`, `alsoInInstances`. Nullable fields can be absent.

Duplicate entries across instances are combined, preferring accessible/file-backed entries and recording other instance names.

Internal root-folder access information is not serialized in calendar events. If an upcoming title's destination library cannot be determined, only administrators get the event. Requested-only display preferences operate in the client.

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

## Requests & downloads (new)

These routes back the experimental Requests & downloads integration. See [*arr features](../arr/arr-features.md#requests-downloads-new) for what each stage does and [*arr settings](../arr/arr-settings.md#requests-downloads-new) for its switches. A route whose switch is off answers `403` with `code: "feature_disabled"`.

??? note "Callers, bodies, and caching"
    (`acquire/*`, `arr/admin/*`,
    `admin/backup/*`, `admin/secrets/*`). A server API key, a token whose user id is empty and a user
    Jellyfin no longer knows, and disabled accounts, are not a person: per-user routes answer `403` with `code: "user_required"`
    and store nothing; administrators' routes answer `403` (an API key's administrator role is not enough:
    an administrator is a user with Jellyfin's administrator permission). Every route that takes a JSON body
    caps it before reading it (16 KiB; 64 KiB for `acquire/notify/read`, 256 KiB for `acquire/changes`, and
    1 MiB for `arr/calendar/user-data` and the arrs' webhook `arr/hook/{instanceId}`) and refuses a larger
    one, declared or streamed, with `413 {"error":true,"code":"payload_too_large","limitBytes":…}`. The
    backup uploads (`admin/backup/inspect`, `admin/backup/restore`) are multipart files of up to 512 MiB under
    the server's own request limit; a larger upload is refused by the server itself, not yet with this
    structured `413`.
    Administrators' answers (`arr/admin*`) carry `Cache-Control: private, no-store`; user status and hub
    answers keep `private, no-cache` with their `ETag`.

### Instances, live updates, and webhooks

Administrators use these routes to inspect and test instances and set up live updates. The webhook receiver is the only anonymous route.

| Method | Path | Access and contract |
|---|---|---|
| GET | `arr/admin/instances` | Admin, Requests & downloads (new): the instance registry; keys reported as set/hint only |
| POST | `arr/admin/instances/{id}/test` | Admin, Requests & downloads (new): test a saved instance (app, version, feature gates, health) |
| POST | `arr/admin/test` | Admin, Requests & downloads (new): test unsaved values |
| GET | `arr/admin/audit` | Admin, Requests & downloads (new): recent audited arr actions |
| GET | `arr/admin/state` | Admin: the in-memory Sonarr/Radarr snapshots behind the routes below (age, size, last refresh error per instance) and per-route counters of upstream calls made by requests themselves |
| POST | `arr/admin/state/refresh?instanceId=&kind=` | Admin: ask for a refresh of one snapshot (`library`, `queue`, `history`, `calendar`, `system`, `episodes`; debounced two seconds) |
| GET | `arr/admin/live` | Admin, Requests & downloads (new): live updates per instance (connection state, webhook traffic, a "silent for a day" warning) and the change feed's position |
| GET | `arr/admin/instances/{id}/webhook` | Admin, Requests & downloads (new): Jellyfin Enhanced's webhook(s) in that arr's Connect list (address, events, whether the secret matches; never the secret) |
| POST | `arr/admin/instances/{id}/webhook` | Admin, phase 1 on: set up or repair the webhook (body `{"consent":true,"jellyfinUrl":"http://jellyfin:8096","idempotencyKey":"…"}`; audited, idempotent) |
| DELETE | `arr/admin/instances/{id}/webhook` | Admin, Requests & downloads (new): remove the webhook and forget its secret (body `{"consent":true}`; audited) |
| POST | `arr/admin/instances/{id}/webhook/manual` | Admin, phase 1 on: copy-paste set-up (address, header name and the secret); audited |
| POST | `arr/hook/{instanceId}` | Anonymous, phase 1 on: the arrs' webhook receiver. Needs the instance's secret in `X-JE-Hook-Secret`; body ≤ 1 MiB; only triggers re-reads; `204`, or `401`/`400`/`429` with no body, or `413` `payload_too_large` for a larger body |

### Status and the change feed

Pages read where titles have got to and long-poll the change feed for updates.

| Method | Path | Access and contract |
|---|---|---|
| POST | `acquire/changes` | Any signed-in user, phase 1 on: the change feed. Body `{"epoch","cursor","keys":["movie:tmdb:…","tv:tvdb:…[:s…[:e…]]","req:u:<own user id>","ntf:u:<own user id>","req:state","admin:ops"],"wait":25}` (`req:u:…` changes when the caller's own Seerr request list does, `ntf:u:…` when their notification inbox does; nobody else ever hears either. `req:state` changes for everyone when the request list is first read, can't be read or recovers. A poll that follows `req:state` counts as the Requests page being open: only that page follows it. `admin:ops` reaches administrators only, with phase 2 on: something the Requests page's admin tabs show may have changed); answers `{"epoch","cursor","keys","reset"}` as soon as a title the caller asked about (and may open) changes, or after `wait` seconds. The first call (no epoch) returns the current position. At most 500 keys (`400 too_many_keys` beyond; send no keys to hear about every title the caller may open). At most 4 waits per user (`429` beyond) |
| GET | `acquire/status?ids=&keys=` | Any user, Requests & downloads + status on pages on: where each title has got to, for up to 100 Jellyfin item ids (items the caller can't open are left out) and up to 50 title keys (`movie:tmdb:603`, `tv:tvdb:78874`) |
| GET | `acquire/status?keys=&detail=true` | Same, for exactly one title key, with a movie's journey (Seerr's more-info window; `400 detail_needs_one_key` otherwise) |
| GET | `acquire/status/item/{itemId}` | Same, for one item's details page: the journey (movies, episodes), per-season state (series) or per-episode state (seasons). An empty `items` list when the caller can't see the item or it has no status (other item types, no provider id). Also answers the native details page id of a title that isn't in the library (by key; `openItemId` once a copy the caller can open is here) |
| GET | `acquire/status/arrival?key=…[&itemId=][&seriesId=]` | Where a details page goes once its title arrives: for the page's scope key (movie, series, season or episode), the id it showed and the series item it belonged to, `{"itemId": …}`, the item of that scope the caller can open (the movie copy the page showed while they can open it; a series, season or episode in the series copy the page showed, never another copy such as the 4K one, the series in another library or another folder of a grouped series; an episode only with its file; a movie whose file Jellyfin now keeps as a version of a new item, that item), or `{}` (no `itemId`) when there is none. Jellyfin replaces a missing episode or season with a new item once its file is there. Never names an item the caller can't open. Answered `Cache-Control: private, no-store`. Until Jellyfin drops the missing item, `acquire/status/item/{itemId}` of it reads as the item Jellyfin added for it, with that item's id in `openItemId`; so does a movie or episode whose file Jellyfin now keeps as a version of another item. A movie or episode status also says in `versions` how many versions Jellyfin plays it from for the caller (a version whose own item they can't open, in a library they can't open or above their parental limit, isn't counted), and a movie's says `fourK: true` when a copy the caller can open (this one or another library's) already has a playable 4K version they can open |

??? info "Status answers"
    The `acquire/status` routes answer with a stage (`asked`, `approved`, `notOut`, `looking`, `downloading`,
    `almostReady`, `ready`, `notHere`, `none`), a reason code with parameters (dates, percent, ETA) and, for
    series and seasons, counts. Each status has a `key`; a title Jellyfin knows only by another id (an IMDb-only movie,
    a series without a TVDB id) also gets `liveKey`, the `movie:tmdb:…`/`tv:tvdb:…` key `acquire/changes` announces it
    under. Non-admins never get instance names, URLs, paths, download clients, release names or
    the arr's own messages; admins also get an `admin` block with one entry per instance. Responses are
    per user with a private `ETag` (`Cache-Control: private, no-cache`; `If-None-Match` answers `304`), are
    served from the snapshots without calling Sonarr or Radarr, and answer `403` with `code: "feature_disabled"`
    while the feature is off. Request facts (asked, OK'd, declined; "you" or "someone in your household") come from
    Seerr's request list, which Jellyfin Enhanced reads in the background (every few minutes, every 30 seconds while
    someone has the Requests page open, and a second after a request is made or answered through Jellyfin Enhanced);
    no status route or `acquire/hub` calls Seerr. A user with a parental rating or tag limit gets statuses by key only
    for titles Jellyfin lets them open or that they asked for themselves. With phase 2 on, a title Seerr OK'd that no
    Sonarr/Radarr holds reads `approved_not_in_arr` (administrators after the grace period, with
    `admin.approvedNotInArrSince`; everyone else after the "still looking" hours), and the `acquire/hub` admin block
    carries `hub: true` (the admin tabs).

### Requests page and Manage

| Method | Path | Access and contract |
|---|---|---|
| GET | `acquire/stamps?ids=` | Any signed-in person, acquisition badges on (phase 4; `403 feature_disabled` otherwise, `403 user_required` for API keys): the caller's acquisition badge for up to 100 Jellyfin item ids, `{"items":[{"itemId","stamp"}]}` with `stamp` `upgraded`, `new` or `fourK`. The `items` list omits items without a badge and items the caller cannot open. A separate `subscriptions` list (`{itemId,keys:[titleKey]}`) includes accessible titles even without a badge, so acquisition-only cards can follow changes. A person who hid badges gets both lists empty. Decided in memory (no arr, Seerr or database read). `400 invalid_id` / `too_many`; private `ETag` |
| GET | `acquire/ready` | Any signed-in person, the Ready playlist or Ready messages on (phase 4f; `403 feature_disabled` otherwise, `403 user_required` for API keys): the caller's own Ready settings, `{"playlist":{"enabled","optedIn","state","reason","playlistId","entries","retentionDays","canRemove"},"messages":{"enabled","optedIn","recent":{"accepted","suppressed","unknown"}}}`. `state` is `off`, `active`, `deleted` (the person deleted it), `removed`, `renew` (restored from a backup) or `privacy` (shared, public or another owner's). `accepted` counts commands Jellyfin passed on, never displays. Asks for a fresh look at the playlist. `private, no-store` |
| PUT | `acquire/ready` | Same: changes only the fields sent, `{"readyPlaylist":bool,"nativeReadyMessages":bool}`; a field whose switch is off is refused (`403 feature_disabled`, nothing stored). Turning the playlist on again after a deletion, removal or restore renews it. Answers like GET |
| POST | `acquire/ready/remove` | Same: deletes the caller's managed Ready playlist (only it, only while it is their own, carries its marker and is private, as Jellyfin stored it right before the delete) and records it as removed; a shared or public one is kept as it is and no longer managed (`kept`); `{"outcome":"removed"\|"kept"\|"not_ours"\|"nothing"\|"changed","status":{…}}`. No route takes a user or playlist id |
| GET | `acquire/hub` | Any signed-in user, phase 1 and the Requests page on: the caller's own Seerr requests with their status (of the part asked for: the requested seasons of a series, the 4K copy of a 4K-only request): `mine` (groups `needsOk`, `onTheWay`, `notOut`, `declined`), `soon` (a date in the next 60 days), `ready` (arrived in the last 14 days), plus `seerr` (`configured`, `loaded`, `unavailable`). Administrators also get `admin` (`downloads`/`calendar` tabs, the request list's last read and error). Private `ETag` |
| GET | `arr/admin/manage?itemId=` or `?key=` | Admin, phase 1 and the Manage button on: the Manage drawer for a Jellyfin item or a title key (`movie:…`, `tv:…[:s…[:e…]]`): the admin status (of that season or episode for a season or episode key), every instance of the title's kind (in it or not, monitored, profile, path, its Jellyfin copy, queue rows, timeline of added/history events/Jellyfin Enhanced actions; with phase 2 on also `downloads`, the whole downloads in scope as on `arr/admin/hub/activity`, with their `actions`) and Seerr's requests with who asked. `403` for anyone else |
| POST | `arr/admin/manage/search` | Admin, same switches: Search now on one instance (body `{"instanceId","key","idempotencyKey"}`; movie, series, season or episode search; audited; the answer has `status`, `message`, `readBack`) |
| GET | `arr/admin/manage/add-options` | Administrator; `?instanceId=…&key=…` → the instance's profiles, root folders, tags and saved defaults from a current snapshot; with a key, the title and its seasons from one lookup on that instance. |
| POST | `arr/admin/manage/add` | Administrator, Jellyfin Enhanced mode; body `instanceId`, `key`, optional `profileId`/`rootFolder`, `seasons` for a series, one `idempotencyKey` per sheet. The add is a request owned by the administrator and routed to that instance. A 4K instance needs the phase-3 4K switch for that kind of title. |

### Notifications

Signed-in users manage their own inbox, follows and delivery settings; administrators see delivery state and send tests.

| Method | Path | Access and contract |
|---|---|---|
| GET | `acquire/notify/inbox?before=&limit=` | Any signed-in user, phase 2 notifications on: the caller's own notifications, newest first (`limit` 1-50, `before` an id to page back), with `unread` and `more`. Each item has `id`, `kind` (`ready`, `episodes`, `declined`, `approval`, `instance_down`, `instance_up`, `low_disk`, `stuck_digest`, `remind`, `attention` — a Needs attention row with `params.code` `import_blocked` or `approved_not_in_arr` —, `test`), `key`, `itemId` (a Jellyfin item the caller can open), `createdAt`, `read`, `params` (title, year, poster, counts…) and `link` (a hash route: the item's page, else `#/requests`, or for administrators' alerts about the arrs `#/requests?tab=overview` (Needs attention, stuck digest) or `?tab=system` (outages, low disk)). Administrators' kinds are left out (items and `unread`) when the caller is no longer an administrator; a `ready` or `episodes` item whose Jellyfin item the caller can no longer open comes without `key`, `itemId` and the title, year and poster in `params` (its `link` is the Requests page) |
| POST | `acquire/notify/read` | Same: mark the caller's own notifications read (`{"ids":[…]}` or `{"all":true}`) |
| GET, PUT | `acquire/notify/prefs` | Same: the caller's notification settings (`toasts`, `ready`, `episodes`, `declined`, `autoFollowRequests`, `ntfy`, `email`, `hideTitles`, `quietHours`, `quietFrom`/`quietTo` `HH:mm`, `timeZone`, `utcOffsetMinutes`; administrators also `adminAlerts`) and the channels on offer (the ntfy server people subscribe to; never a token or password). PUT changes only the fields sent |
| POST | `acquire/notify/ntfy/topic` | Same: set (`{"topic":"…"}`, 8-64 of `A-Z a-z 0-9 - _`), make up (`{"generate":true}`, 128 bits) or clear the caller's ntfy topic |
| POST, DELETE | `acquire/notify/email` | Same: send a 6-digit code to an address (`{"address":"…"}`; once a minute, five a day; `409 email_not_set_up` without SMTP), or forget the address |
| POST | `acquire/notify/email/verify` | Same: confirm the address with the code (`{"code":"123456"}`; five tries end the code, counted before the code is compared, so requests at once get no more) |
| POST | `acquire/notify/test` | Same: send the caller a test notification (bell, and every channel they have on); once per 30 seconds (several at once send one; the rest get 429 `too_soon`) |
| GET, PUT | `acquire/follows` | Same: the caller's follows, mutes and the titles followed because they asked for them; PUT `{"key":"movie:tmdb:…" or "tv:tvdb:…[:s…]","on":true}` follows (or stops following; stopping an own request's automatic follow mutes it). `403 not_allowed` for a title the caller may not read by key; at most 300 |
| POST | `acquire/remind` | Same: "Remind {contact}" (`{"key","itemId"}`) about a title that needs attention right now; administrators get it as an admin event. At most once per user and title every 24 hours, the movie or series whichever episode or season it is sent from (`429 too_soon` with `nextAt`); `409 not_stuck` / `409 admin` |
| GET | `arr/admin/notify` | Admin: channels (masked), database, deliveries (pending, sent and failed in 24 h, the latest problems) and every user's phone/e-mail state |
| PUT | `arr/admin/notify/users/{userId}` | Admin: give a user an ntfy topic (`{"topic"}` or `{"generate":true}`); their phone alerts go on |
| POST | `arr/admin/notify/test` | Admin: send one test straight through `ntfy` (to `topic`) or `email` (to `address`) with the saved settings; answers `{"ok","error"}` |

### Admin tools (phase 2)

| Method | Path | Access and contract |
|---|---|---|
| GET | `arr/admin/hub/overview` | Admin, phase 2 on: instance cards (live state, queue, health, disk per root folder), `needsAttention` (rows with `code`, `severity`, the app's `message`, `since`, `fixes` such as `open_in_arr`, `search_now`, `remove_search`, `retry_import`, `scan_now`, `open_system`, `open_seerr`, and `arrLink`, `downloadId` or `arrPath` for them), `next24h`, `downloading`, `waitingForOk`, `days` (grabs/imports for 14 days). `403` for anyone else (`code: "feature_disabled"` for admins with phase 2 off) |
| GET | `arr/admin/hub/activity` | Admin, phase 2: downloads grouped per download id (a season pack is one; `scope`, `episodes`, `state`, `status`, `percent`, the app's `messages`, `problem`, `actions`) and the recent history |
| GET | `arr/admin/hub/system` | Admin, phase 2: per instance version, health, disk space, root folders, scheduled tasks, live connection and webhook; Seerr's read state; the Jellyfin bridge (`targetedRefresh`, recent refreshes, `notInJellyfin`, `missingTitles`, `pathDoctor`) |
| POST | `arr/admin/queue/confirm` | Admin, phase 2 (a non-administrator's call to this or the other phase-2 POST routes gets `403` and a `denied` audit line, at most one a minute per user and route): body `{"instanceId","downloadId"}`; what the download covers and a one-time `token` (two minutes, bound to this administrator, instance and download) for `remove_with_data`. `404` when it's no longer queued; `409 queue_changing` when a paged, partial or cut queue cannot be checked against the download's complete rows |
| POST | `arr/admin/queue/action` | Admin, phase 2: body `{"instanceId","downloadId","action","blocklist","searchAgain","idempotencyKey","confirmationToken"}`; `action` is `remove` (keeps the client's data), `remove_with_data` (needs the token), `search` or `retry_import` (the app's `RefreshMonitoredDownloads`). Every row of the download is acted on; audited (refusals too); the answer has `status`, `message`, `readBack`, `auditId` |
| POST | `arr/admin/hub/search` | Admin, phase 2: Search now by title key for a row that isn't queued (body as `arr/admin/manage/search`; a search refused before the app is called is audited too) |
| POST | `arr/admin/bridge/scan` | Admin, phase 2: Scan now for an imported path as the app sees it (body `{"instanceId","path","idempotencyKey"}`): refreshes the nearest Jellyfin folder (then each new folder below it), or queues Jellyfin's scan of that one library when the path needs a TV library's root; paths outside every library, relative paths and paths with a `.` or `..` segment (either slash) are refused. Audited |

### Requests and approvals (phase 3)

Create, list, approve and send durable requests.

All routes below require an authenticated Jellyfin person; API keys and deleted or disabled accounts cannot use them.
Paths are relative to `/JellyfinEnhanced`. Responses include `outcome`, `reason`, `certainty` and safe `message` fields.
New intent (including a free follow of queued intent) returns 201; a repeated ask or a scope confirmed upstream returns 200; malformed input returns 400, permission or policy refusal
403, missing ids 404, conflicting idempotency or concurrent changes 409, hard limits 429, and unavailable storage 503.
Bulk approval returns 207 when some rows fail, with a separate checked outcome for every item.

| Method | Path | Access and contract |
|---|---|---|
| POST | `acquire/requests` | `requests.create`; create explicit movie, seasons, episodes, future or next-season scope |
| GET | `acquire/requests?view=mine` | Own requests filtered by current visibility |
| GET | `acquire/requests?view=pending` | `requests.approve`; visible pending requests |
| GET | `acquire/requests/quota` | Own allowance, use, estimate and next usable slot |
| GET | `acquire/requests/me` | Any person (Watchers too); own role, whether they may ask or approve, 4K, the household contact word, and `pausedMovies` / `pausedSeries` when new titles of that kind are paused for storage (`{"reason": "low_disk"}`; administrators also get `instance`, `folder`, `free`, `freePercent`, `limitPercent`) |
| GET | `acquire/requests/check?key=&variant=` | Any person; whether they may ask for one title (`standard` or `4k`) now: `{canRequest, blocked}`, `blocked` as in `pausedMovies` (or `instance_changed` / `invalid_instance` / `invalid_defaults`) |
| GET | `acquire/requests/season/{itemId}` | A season item the caller can open; their request state per episode, the metadata of episodes with no file, and `blocked` (why they can't ask now, as in the check) |
| POST | `acquire/requests/search` | `requests.create`; search again for what requests already sent, described below. |
| POST | `acquire/requests/{id}/cancel` | Owner, or visible Admin; before the outgoing write |
| POST | `acquire/requests/{id}/approve` | Approver; optional `input` edits scope/edition; instance/profile/folder edits require Admin |
| POST | `acquire/requests/{id}/decline` | Approver; plain-text `reason`, at most 500 characters |
| POST | `acquire/requests/bulk-approve` | Approver; at most 20 `ids`, each independently checked |
| GET | `acquire/requests/collection/{itemId}` | Any signed-in person who can open the collection; its gaps, described below. |
| POST | `acquire/requests/lab/{id}/hold` | Administrator, lab only (`ArrRequestLabEnabled`, off by default): persist a sending row without contacting any transport, as a crash checkpoint. |
| DELETE | `acquire/requests/lab/{id}` | Administrator, lab only: delete rows carrying the CLI prefix; never calls a backend. |

Create example:

```json
{
  "clientRequestId": "a-new-client-generated-id",
  "input": {
    "key": "tv:tvdb:78874",
    "scope": "seasons",
    "variant": "standard",
    "seasons": [1, 2],
    "episodes": []
  }
}
```

A future or next-season scope confirms one explicit season number; episode scope uses objects such as
`{"season":1,"episode":2}`. The canonical input is stored with an immutable fingerprint: reusing the client id with a
different input returns `idempotency_conflict`. Approving with edits uses the same input shape inside the approval body.
A matching ask from an Admin or Manager who may approve authorizes the existing pending scope after fresh requester
checks. The original scope owner keeps the charge; the new asker follows for free. A Member allowed to request
automatically can start their own authorized scope when the earlier ask is still awaiting approval. Once scope is queued,
other visible, permitted pending wants covered by it become free followers; additional scope remains pending. Declining
one pending want preserves other users' pending intents and holds their reservations until approval. Quota response fields
use camelCase, including `used`, `remaining`, `nextSlotAt`, `usedGb` and `available`.
Requests are serialized locally by title and edition; this lock cannot stop another upstream application writing.
The outgoing worker rechecks identity, roles, visibility, edition, flags, authority and connection identity at send.
A changed permission parks work for review. Restarted `sending` rows become `maybe_sent` and require read-back before
any resend. A 4K request nothing can take any more (no usable 4K Radarr/Sonarr in Jellyfin Enhanced mode, no 4K server
in Seerr as last read in Seerr mode) says so instead of turning stale: one not sent yet waits for an administrator
(`no_4k_instance`, "Stuck · nothing can take the 4K copy now" on the approval card; a queued job is held at send with
that reason), and one already sent keeps its state with that reason and is listed on the approval page as stuck. When a
4K target is back each is released as it was (sent, queued, or waiting for an OK, which resumes a job held at send).
A new 4K ask with no 4K target is refused up front, as the 4K capability needs one. List validators include user, role and policy revision, with private cache headers. Family responses contain
no backend connection, folder, profile, credential or other person's identity.

`acquire/requests/search` takes `{"key": "tv:tvdb:78874:s1:e4", "idempotencyKey": "…"}` (a movie key, or a series key, alone, with a season, or with a season and episode). It answers `{found}` (true, false, or null while unknown); outcome `skipped` with `not_requested` (nothing was sent for it: ask instead) or `not_searchable` (not missing for long enough) when there is nothing for it to search; 429 `searched_recently`, 502 `search_failed`, and the request API's own refusals (Watchers, parental limits).

`acquire/requests/collection/{itemId}` answers `{outcome, reason, certainty, message, collection: {have, total, missing: [{key, title, year, poster, released, request, blocked?}]}}`, where `request` is the person's own request state (`waiting`, `asked`, `declined`) or `household` when someone else asked, and `blocked` (released movies nobody asked for only) says why the person can't ask for it now, as in the title check (`{"reason": "low_disk"}`; where and how much is free for administrators only). A collection the person can't open, or one TMDB can't describe, answers 404.

#### Moving requests from Seerr

Administrators move Seerr's requests into Jellyfin Enhanced with a check, a move, and a rollback within 14 days.

| Method | Path | Access and contract |
|---|---|---|
| GET | `acquire/migration/seerr` | Request handling now and the newest moves with their rollback deadline |
| POST | `acquire/migration/seerr/preview` | The check: counts by kind, what is left out, Seerr's requesting state and a digest |
| POST | `acquire/migration/seerr/commit` | `{"digest": "…", "confirmRequestsDisabled": false}`; 409 when Seerr changed or its address was changed during the move (`seerr_changed`), the read was incomplete, requesting is still on or Jellyfin Enhanced's own Seerr writes didn't finish in time (`seerr_writes_in_flight`); 503 `switch_failed` when the switch couldn't be saved (nothing moved) |
| POST | `acquire/migration/seerr/rollback` | `{"batchId": "…"}`; within 14 days; 503 `switch_failed` (nothing rolled back) or `rollback_failed` (switched back; roll back again) |

### Automation (phase 4)

The automation engine's state, its recent decisions, and its admin actions.

| Method | Path | Access and contract |
|---|---|---|
| GET | `arr/admin/automation/status` | Admin, integration and phase 1 on: the phase-4 automation engine (switches as they apply, the rollout Shadow guard, kill switches, each recipe's stored and effective mode with the reason, budget windows with `used`/`limit`/`uncertain` and `nextSlotAt` when full, breakers per target, automatic requests waiting at send by reason, the request backend's guarantees and the one-time migration with its notice). Private, never cached |
| GET | `arr/admin/automation/decisions?recipe=&limit=` | Admin, integration and phase 1 on: recent automation decisions, newest first (one per trigger; `repeats` counts the same trigger again). `400 invalid_request` for an unknown recipe |
| POST | `arr/admin/automation/notice/dismiss` | Admin, integration and phase 1 on: hides the one-time migration notice (`{"dismissed":true}` when it was showing) |
| POST | `arr/admin/automation/breakers/reset` | Admin, integration and phase 1 on: body `{"target":"<instance id>"}` (or `"seerr"`); closes that target's breaker so the next automatic send is tried at once (`400 invalid_request` for a malformed target) |

### Household rules and request options (phase 4b)

Household rules, shared allowances, request previews and Seerr request options.

| Method | Path | Access and contract |
|---|---|---|
| GET | `acquire/household/rules` | Admin, phase 4 + phase 3 + household rules on: the fixed conditions per role (Kid, Member, Trusted: rating, genre, original language, size estimate, streaming service; each with a `match` and an `otherwise` action of `none`/`approve`/`review`/`deny`), the household streaming country and TMDB provider ids, the group pools with their `used` count in the window, and the choices (roles, actions, TMDB genres). With Seerr handling requests `editable` is `false` and `seerr` shows Seerr's own rules read-only (override rules as Seerr describes them, `null` when it can't; auto-approve; default quotas). Private, never cached |
| POST | `acquire/household/rules` | Admin, same switches, Jellyfin Enhanced handling requests: body `{"rules"?, "streamingCountry"?, "streamingServices"?: [ids], "pools"?: [{id, name, limit, roles, users}]}`; only named parts change, everything is validated first (`400 invalid_*`), pools need group quotas on (`403 feature_disabled`), Seerr handling refuses (`409 rules_seerr_owned`) |
| GET | `acquire/household/streaming-services?country=GB` | Admin, household rules on: the streaming services TMDB lists for a country (movies and series), `{services:[{id,name}]}`; `503 tmdb_unavailable` when TMDB can't be read |
| POST | `acquire/requests/preview` | Anyone who may ask, phase 4 + phase 3 on: body `{"items":[{"clientRequestId"?, "input":{…as POST acquire/requests…}}]}` (at most 20). What the asks would do one after another, nothing written: per item `outcome`, `status` (absent when refused), `reason` (`rule_review`, `group_quota`, `over_quota`, `household_rule`, …), `cost`, `estimateGb`, `follows`, `already`, `heldSeasons` (split at the series threshold) and `rules` (the household-rule conditions behind it); `summary` `{now, needOk, refused, cost, quota, pool}` |
| GET | `arr/admin/seerr/request-options?kind=movie\|tv` | Admin, phase 4 with phase 3 and `ArrPhase4SeerrRequestOptionsEnabled` on (else `403 seerr_options_disabled`): Seerr's Radarr (`movie`) or Sonarr (`tv`) servers for choosing where a Seerr request goes. `{enabled, canUse, reason, servers:[{id, name, is4k, isDefault, defaultProfileId, defaultRootFolder, profiles:[{id, name}], rootFolders:[{path}], options}]}`; `enabled` is false (`reason: "not_seerr_backend"`) while Jellyfin Enhanced handles requests, `canUse` false with `reason: "seerr_advanced_required"` when the administrator's Seerr account lacks Seerr's advanced-request permission (or `backend_unavailable`), and `servers` is then empty. `options` is the stamp to send back with a choice. Never an address, key or host name. `400 invalid_input` for another `kind`, `503 backend_unavailable` when Seerr can't be read. Private, never cached |

**Seerr request options on a request.** In Seerr mode an administrator's request input (`POST acquire/requests`, or an
approval's edited `input` on `POST acquire/requests/{id}/approve`) may carry `SeerrServerId` (Seerr's server id, 0 or more), `SeerrProfileId`, `SeerrRootFolder` (an absolute path, at most
1024 characters) and `SeerrOptions` (the server's `options` stamp from the route above, at most 128 characters): all
four or none, never together with `InstanceId`, `ProfileId` or `RootFolder` (`400 invalid_input`). They become part
of the stored request and its fingerprint (an input without them keeps the fingerprint it always had). Refusals:
`403 admin_required` (not a Jellyfin administrator), `403 seerr_options_disabled` (switch off), `403
seerr_advanced_required` (the Seerr account it goes out as lacks Seerr's advanced-request permission), `409
seerr_options_changed` (the server is gone or its facts changed since the stamp, including where Seerr reaches it; read the options again), `400
seerr_options_invalid` (the edition, profile or folder doesn't belong to that server), `503 backend_unavailable`
(Seerr's servers can't be read now) and `400 invalid_defaults` while Jellyfin Enhanced handles requests. A waiting
request whose choice stops fitting is held with the same reasons; nobody else's request answers include the choice.
A request with a choice is only ever answered by a request going to the same server, profile and folder against the
same stamp (otherwise it is a request of its own, checked when it is sent), and new seasons of a "keep getting"
request carry the choice. Only a request at the same destination (sent, queued or waiting) keeps a "keep getting"
request from following a new season. Approving a held request with only a new stamp for the same server, profile and
folder on the same Seerr re-confirms it (`200`): what it sent stays, what was held goes out with the new stamp, and a
part Seerr already has but that wasn't confirmed is read back first (it stays uncertain until then). Another
destination for a request that already went out, or any approval (as it is included) that would send what went out to
another Seerr, is `409 request_changed`; a part that was written resumes only where it was (`409 request_in_flight`
otherwise).

### Discover, household, and approvals

Routes for JE mode's Discover tab and search row, and for approvals and the household. API keys and unknown users get `403 user_required`; Watchers `requests_create_required`; Seerr mode and phase 3 off `feature_disabled`.

| Method | Path | Access and contract |
|---|---|---|
| GET | `acquire/discover` | A signed-in person who may ask, JE mode; query `list` (`trending`, `upcoming`, `popular` or `because`), `type` (`movie` or `tv`) and `page` (1–10) → one page of a row (`because`: groups per watched title). |
| GET | `acquire/search` | Same; `?q=…&page=1..10` → movies and series only. Queries over 100 characters get `400 query_too_long`; Kids get `403 search_hidden` when search is hidden from them. |
| GET | `acquire/requests/approvals` | Manager or Admin; approval cards for visible titles (requester names, role, quota use, rating line, "also wanted by", estimate) |
| GET | `acquire/requests/mine` | Any person; own requests with title data and whether each can still be cancelled |
| GET | `acquire/requests/attention` | Manager or Admin; `needOk` and `stuck` counts for visible titles (no network) |
| GET | `acquire/household` | Manager (people sharing a library) or Admin (everyone, overrides and house rules) |
| POST | `acquire/household` | Jellyfin administrator; saves roles, per-person limits, role limits, the preset and the default role |

Each result carries the title key, kind, TMDB id, title, year, poster path, a short overview, whether you have it
(with the Jellyfin item), whether anyone asked and your own ask's state, with what your own open asks cover
(`mineVariants`: standard and/or 4k; `mineSeasons`: the seasons your standard asks cover whole; both left out when
empty), and `blocked` when the person can't ask for the title's standard copy now (as in the title check: `low_disk`
measured on the title's own drive, else the default root's; worked out on every answer, cached pages too). Nothing
about Sonarr/Radarr, paths or other people is included (administrators' `blocked` names the instance, folder and free
space). TMDB being unavailable answers 503 `discover_unavailable`.

The household save body names only what changes, for example
`{"preset":"ask_first","users":{"<user id>":{"role":"Kid","quotaLimit":3}},"roles":{"Member":{"quotaLimit":7}}}`.
A person's entry replaces their role and limit overrides (`null` removes one); other parts of the override, such as
4K grants and GB caps, are kept. Unknown user ids, the Admin role, unknown presets and limits outside −1 to 10000 are
refused with 400 and nothing is written. Responses are private to the caller and never name an instance, profile,
folder or path.

### Native details pages

The native page's own requests are answered by the facade and never touch the library.

| Method | Path | Access and contract |
|---|---|---|
| GET | `acquire/status/item/{pageId}` | The page's status by key, as for a library item; adds `openItemId` once a copy the caller can open is here. An empty list when the caller may not open the page |
| GET | `acquire/requests/season/{pageId}` | A season page's rows: every episode's metadata and the caller's request state; 404 when the caller may not open it |
| GET | `native-details/resolve?key=…[&season=&episode=]` or `?id={pageId}` | Where a title opens for the caller: `{itemId}` (a library item they can open, the season or episode when named) or `{id}` (the native page). 404 when the title has no TMDB id; 403 for API keys or with the setting off |
| GET | `native-details/person/{tmdbId}/filmography` | The filmography on a person's own page, filtered for the caller on the server: a library copy they can open carries its Jellyfin id, a title the library hides from them is left out, a title not in the library is listed only when its page would open for them. No Seerr account needed in Jellyfin Enhanced request mode. 404 when refused or unknown, 503 when Seerr can't answer, 504 while parental checks still run, 429 (`Retry-After`) when the list isn't cached and the caller has started too many new reads or already has 8 running or waiting (or the server has too many queued); 403 for API keys or with the setting off |
| GET | `native-details/discover/{type}/{source}/{feedId}` | `type` `movie` or `tv`; `source` `genre`, `studio`, `network`, `company` or `keyword`; query `page`, `sortBy`. One page of a genre, studio, network or tag (TMDB keyword) discovery feed (`company`: a studio's own series, from TMDB), filtered and limited for the caller like the filmography; `totalPages` is the upstream count, so a page with every title left out isn't the end. Library pages' discovery rows use these for callers without a Seerr account |
| GET | `native-details/title/{type}/{tmdbId}`, `native-details/title/{type}/{tmdbId}/ratings` | `type` `movie` or `tv`. A title's public details (Seerr's per-account `mediaInfo` replaced by the caller's own: `{status: 5, jellyfinMediaId}` for a library copy they can open, else Seerr's public state of an absent title) or its ratings (`null` when it has none), for its native page's extras and for Seerr's details window of a caller without a Seerr account, under that page's own rule (no Seerr account needed in Jellyfin Enhanced request mode). Also answered with native pages off while requests run in Jellyfin Enhanced mode; ratings are limited like the feeds |
| GET | `native-details/title/{type}/{tmdbId}/related/{relation}` | `relation` `similar` or `recommendations`; query `page`. One page of a title's similar or recommended titles, under the title's rule above and filtered and limited like the discovery feeds, for the rows on a title's page of a caller without a Seerr account |
| GET | `native-details/collection/{collectionId}` | A movie collection's public details and its movies, each judged for the caller like a filmography's titles (`mediaInfo.status` 5 and `jellyfinMediaId` for a copy they can open), for a collection's **Request** of a caller without a Seerr account; answered like the title route |
| GET | `native-details/genres/{type}`, `native-details/keywords` | Query `query` for keywords. TMDB's genres (`[{id, name}]`) and the keywords matching a tag (`{results: [{id, name}]}`), so library genre and tag rows find their TMDB ids without a Seerr account |

The native page's own reads (its title, seasons, episodes and parents, a person, studio or network page) come out of
the same per-account budget as these lists: a read nobody has made yet waits up to 3 seconds for room, then answers
429 with `Retry-After: 2`. Jellyfin Enhanced's browser code waits at least that long before it asks again.

#### Lists (phase 4)

`/JellyfinEnhanced/acquire/lists/…`, signed-in people only (API keys and unknown or disabled users: `403 user_required`),
`404 {"code":"disabled"}` while lists are off. A list someone can't see answers `404 not_found` like one that doesn't
exist. Views are `private, no-cache` with an `ETag` bound to the person; every change is `private, no-store`. Changes
take a `requestId` (`[A-Za-z0-9_-]{1,64}`): the same id with the same body is answered from its durable record (also
after a restart) with the list as the caller may see it now; the same id with another body is `409 idempotency_conflict`.
Create records become deletion tombstones during cleanup, retained for 30 days after deletion even if Jellyfin reuses
the item id: retrying
the deleted list's create is `404 not_found`, and a new create needs a new request id. An access-denied 404 never carries
`listId` or `listKind`; other failed-create answers carry them only while the caller can still see the list.
Edits take the list's `rev`; a stale one is `409 rev_conflict` with the fresh view. The caller's rights, limits and the
items they and the playlist's owner can open are read again right before every write to Jellyfin and before every
answer (a person disabled meanwhile has lost it; nothing is written as a disabled playlist owner: `409 owner_missing`):
a change that loses the list on the way is `404 not_found` (`403 forbidden` without edit rights) and writes nothing more;
one that already wrote to Jellyfin answers its results without the list (`view` left out, the caller's new entries
skipped as `accessLost`); a placeholder their limits hide meanwhile is skipped as `blocked`; a library item
someone lost meanwhile is `409 access_changed` with the fresh view.
A create (its retry and recovery included) and a swap-in pass are each one continuation: after every await, and
right before every write and the answer, the create's operation and the caller's current access (a pass: its list, with
the agreeing editor's rights checked at every Jellyfin write) are read again, under the same lock deletion takes. Deletion marks the list's create operation and its create marker (the folder name or provider id
Jellyfin keeps) at once, also when the server stopped before it recorded the new list; a deleted create answers the
same identity-free `404 not_found`, writes nothing more to Jellyfin, and stays deleted if Jellyfin re-adds the folder
under the same item id. A create answers `listId`, `listKind` and `name` only while the operation and the caller's
current access allow it; one that lost access meanwhile answers like one that never had it. A restore stops create and
swap-in work that started before it; a retry with the same request id continues from the restored state.

| Method and path | Who | Body / answer |
|---|---|---|
| `GET /acquire/lists/{listId}` | can see the list | The caller's view: `rev`, `canEdit`, `nativeCanEdit`, `actions` (`edit`, `reorder`, `request`, `requestAll`, `swapIn`), `statusShown`, `swapIn`, `reconciling`, `order` (playlists: real `e:{itemId}:{n}` and entry `p:{id}` tokens the caller may see) and `placeholders` (each with `titleKey`, `edition`, `status` from the shared status, `filledCount`/`expectedCount`/`airedCount`, `actions`). |
| `POST /acquire/lists/{listId}/items` | can edit (authoring on) | `{requestId, rev?, placeholders: [{kind, mediaType?, tmdbId, tvdbId?, imdbId?, title, year?, releaseDate?, posterPath?, seasonNumber?, episodes?, note?, edition?}], position?: {afterToken \| atStart}}` (1–2000) → `{added, addedAsItems, skipped: [{index, reason, sameAs?}], view}`. |
| `POST /acquire/lists/{listId}/apply` | can edit | `{requestId, rev?, entries: [{type: "item", itemId} \| {type: "placeholder", placeholder}], position?}` → as above. |
| `PATCH /acquire/lists/{listId}/items/{id}` | can edit | `{requestId, rev, note?, link?}` (link: custom entries only) → view. |
| `DELETE /acquire/lists/{listId}/items/{id}?rev=&requestId=` | can edit | → view. |
| `PUT /acquire/lists/{listId}/order` | can edit (playlists) | `{requestId, rev, order, moved?}` (the caller's projection after a drag; `moved`: the real token that moved) → view, or `409` (`duplicate_copy`, `move_unsupported`, `real_order_changed`, …) with the fresh view. |
| `PUT /acquire/lists/{listId}/swap-in` | can edit (swap-in on) | `{requestId, rev, enabled}`: the caller becomes the person whose agreement swap-in needs. |
| `POST /acquire/lists/{listId}/requests/preview` | can see the list (list requests on; several entries: Request all missing on) | `{placeholderIds?, all?}` → `{items: [{placeholderId, title, outcome: request \| follow \| approval \| already \| skip, reason, cost}], askable, cost, maxBatch: 20}`. Writes nothing. |
| `POST /acquire/lists/{listId}/requests` | as above | `{clientId, placeholderIds}` (1–20) → `{operationId, replayed, results: [{placeholderId, result}], view}`; each `result` is the usual request outcome, and `view` is the list as the caller may see it now (left out when they can no longer see it). The confirmation stores each entry's request (scope and edition), backend target and request id before anything is asked; the same `clientId` with the same entries resumes from them (also after the entries' metadata changed or the backend moved), asks for nothing twice, and before each ask checks again that the caller can see the list and that entry (else `not_found` for it). |
| `POST /acquire/lists/summaries` | signed in (lists on; answers nothing while the caller's playlist and collection pages are both off) | `{listIds}` (1–200) → `{lists: [{listId, listKind, missing}], pending}`: the asked-for lists the caller can see that have entries they can see, with how many (`missing` ≥ 1; a list with none, or one they can't see, is left out, so hidden entries are never counted). Read through the same rights check as a view, right before the answer; no statuses or metadata. Lists not worked out within 10 seconds (slow parental checks) are in `pending`, to ask again. Private, not stored. |
| `GET /acquire/lists/editable` | authoring on | `{playlists: [{id, name, isOwn, nativeCanEdit, ownerName?}], collections, canManageCollections}`. |
| `POST /acquire/lists/playlists`, `POST /acquire/lists/collections` | authoring on (collections: administrators and collection managers) | `{requestId, name, isPublic?, entries?}` → `{listId, listKind, name, result}`. A retry with the same `requestId` continues with the list the first attempt created, even when the server stopped right after Jellyfin made it: the create runs under the chosen name plus the attempt's marker, so Jellyfin keeps the marker in the list's own folder (and a provider id on a collection), and the list then gets its chosen name (a retry finishes that too). A list of the same name, anyone's, is never taken for it, and no list ever gets a share for nobody. Collections: one create per destination at a time across people; a name a collection in Jellyfin's collections folder already has (or its folder, compared without case) is `409 name_taken`, a `[boxset]` folder elsewhere isn't; a list another attempt already recorded is `409 create_uncertain`, before any entry is applied. |
| `GET` / `POST /arr/admin/lists/import` | administrators (lists on) | The experimental-list importer: dry run / import. Report: `documents`, `collageMarkers`, `imported`, `unchanged`, `skipped`, `quarantined` with reasons. |

The current owner or a human administrator also receives `placements: [{state, reason, attempts, at, tokens}]` in the
list view. Other callers receive an empty array. Tokens name only landed entries the caller can currently see;
actor ids, anchors and source provenance stay internal. Pending plans have `state: "pending"`; abandonment uses
`state: "abandoned"` with `actor_revoked`, `actor_deleted`, `actor_disabled` or `placement_retry_limit`. The last 32
abandoned plans are retained. Recovery checks the original editor's current gate and starts at most three attempts,
persisting the count before awaiting a move. Abandonment keeps landed membership and provenance at the actual order,
and is audited. Restored editor access never restarts that plan. Pending plans do not block unrelated applies or
other placeholder swaps. A write explicitly anchored to a pending entry answers retryable `409 placement_pending`.


Bodies are capped at 16 KiB, except `items`, `apply`, `order` and list creation (1 MiB).

#### Home rows (phase 4)

| Method and path | Who | Answer |
|---|---|---|
| `GET /acquire/home` | signed-in people (API keys, unknown and disabled users: `403 user_required`); `404 {"outcome":"refused","reason":"disabled"}` while home rows are off | `{requests, soon, arrived, hss, ops}`: each row is a list of cards, or `null` when the person switched it off. Card: `key`, `liveKey?`, `kind` (`movie`/`tv`), `tmdbId?`, `title`, `year?`, `poster?` (TMDB path), `itemId?` (a Jellyfin item the person can open; for an arrived episode, the episode), `posterItemId?` (an episode card: its series item, whose poster it shows), `hssId?` (the card's id in a Home Screen Sections row), `status` (the shared status), `date?` (Coming soon: the next date; Just arrived: the first arrival), `day?` (`yyyy-MM-dd` when the date is a calendar day), `season?`/`episode?`/`episodeTitle?`, `is4k`, `follow`. Only the caller's own requests and follows; at most 20 cards per row. `private, no-cache` with an `ETag`; memory only (no Sonarr, Radarr or Seerr call). |
| `GET /arr/admin/home/ops` | administrators; `404` while the strip is off for them | `{actionable, downloading, importBlocked, attention, disks: [{name, usedPercent}]}`; `private, no-store`. |

Home Screen Sections calls Jellyfin Enhanced in process for its sections `JellyfinEnhancedYourRequests`,
`JellyfinEnhancedComingSoon` and `JellyfinEnhancedJustArrived` (through its own `GET /HomeScreen/Section/{id}`); the
answer is empty unless the signed-in caller is the user that request names.

The home `hss` flag means all three JE sections registered successfully, with native absent-title pages enabled; merely
finding the HSS assembly does not enable it. First-arrival dates refer to content, across editions. A later 4K version
fulfils that edition but is an upgrade, excluded from new-content arrivals. `ICollectionCoverage` projections recheck
list access and parental limits at the final answer and return only visible movie title keys.

Home rows and collection gaps prepare remote facts first, then use a shared synchronous response gate. The
gate resolves the current viewer and policy again before serializing or returning cached home bytes. Policy
changes restart preparation up to three times; continued changes fail closed. Home cache identities include
that policy revision, effective switches, row choices and current follows. Collection coverage is projected
from current list access, entries and preferences after the storage wait.

### Dashboard user settings (administrators)

All routes below require a known, enabled human Jellyfin administrator. A role claim, API key, household Manager or Trusted role is insufficient. Responses use `Cache-Control: private, no-store`, including errors. Disabled targets can be inspected and configured; deleted targets return 404.

| Method | Path under `/JellyfinEnhanced/arr/admin/users` | Purpose |
|---|---|---|
| GET | `/summary?offset=0&limit=500` | Bounded card batch, including disabled users. `next` identifies another page; no title metadata fetches. |
| GET | `/{userId}` | Stored overrides, effective policy, provenance, independent component availability and revision tokens. |
| PATCH | `/{userId}/policy` | `role`, `quotaLimit`, `quotaGb`, `fourKInstances`. GB/count/grant changes require JE request handling. |
| PATCH | `/{userId}/pool-membership` | `poolId`, or null to remove this person's explicit membership. Definitions, order and historical reservations are preserved. |
| PATCH | `/{userId}/display` | `listPlaceholders`, `listStatus`, `acquisitionBadges`, `nativeAcquisitionStamps`, `useNativePosterTags`, `listPlaylistUi`, `listCollectionUi`, `homeRowRequests`, `homeRowSoon`, `homeRowArrived`; boolean or null only. |
| PATCH | `/{userId}/seerr-import` | `blocked` boolean only. No import is performed. |

PATCH bodies include the corresponding `revision` from the detail response. Omitted fields retain their values; null explicitly inherits where supported. Stale revisions return 409, unknown/duplicate fields return 400, and unreadable or failed persistence returns 503. Payloads are capped at 16 KiB. Policy revisions conservatively include the complete current configuration; display revisions cover the exact personal file, so concurrent personal saves conflict too. Successful writes return the current detail projection plus `previousRevisions`, captured under the write lock for every affected revision. A pool-membership or Seerr-import patch advances both its own revision and the whole-configuration policy revision; a display patch advances only display. Clients may carry a dirty group forward across their own writes when its known revision matches that transition's previous revision; an intervening external change still requires conflict resolution. Writes audit actor, target and field names without preference contents or notification targets.

```json
{"revision":"<policy revision>","role":"Kid","quotaLimit":null,"quotaGb":25,"fourKInstances":[]}
```

Detail reads never seed settings, quarantine lists or import Seerr users. Independent unavailable stores are reported explicitly, with unknown usage represented by null. Seerr status refreshes make GET requests only and do not wake request dispatch. There are no personal-consent or verified-email setters. The notifications group reuses `PUT /JellyfinEnhanced/arr/admin/notify/users/{userId}` and its established assignment semantics.

### Backup & restore

Admin only. Jellyfin's own backups don't include plugin data.

| Method | Path | Access and contract |
|---|---|---|
| POST | `admin/backup/export` | Download a backup zip. Body `{"secrets":"exclude"}` (default) or `{"secrets":"encrypt","passphrase":"…"}` (12+ characters) |
| POST | `admin/backup/inspect` | Multipart `file` (+ optional `passphrase`): describe a backup without changing anything |
| POST | `admin/backup/restore` | Multipart `file`, `passphrase` (when it holds credentials) and `confirm=restore`: restore it; a safety copy of the current data is saved first |
| POST | `admin/secrets/rollback` | Admin: write stored credentials back into the plugin configuration before a downgrade (body `{"confirm":"write-credentials-to-plugin-config"}`; `409` if `secrets.json` can't be read) |

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
| GET | `whats-new` | Administrator | `{pluginVersion,newSettings}`. |
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
| GET | `items/by-providers` | Authenticated | Query provider dictionary and optional `types` → one matching GUID the caller can open. |

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

Provider lookup accepts multiple dictionary entries such as `providers[Tmdb]`, `providers[Imdb]`. `types` is a comma-separated item-kind list parsed case-insensitively; invalid kinds are ignored. No provider IDs return `400` with `No provider ids supplied`; no match returns `204` with no body. Success is a GUID value.

For a signed-in user, only an item they can open (library access and parental limits) is returned. A server API key, which has no library view, gets the first match.

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

Each person's own consents (automatic season and movie requests, list swap-in) are kept by the reset.

Reset also resets Hidden Content settings while retaining items, and preferences in existing Spoiler Guard files while retaining protection lists. It does not reset bookmarks, reviews, shortcuts, or Elsewhere.

`success:true` can accompany skipped settings/Hidden Content users. Spoiler preference-reset failures are logged without a separate skipped-ID list. Missing configuration returns `500`.

The authenticated HTML catch-all recognizes exact names `calendarPage`, `downloadsPage`, `bookmarksPage`, `hiddenContentPage`, `recommendationsPage`, `activityPage`, `catchUpPage`.

These are resource URLs, separate from Jellyfin web hash navigation or placement in Plugin Pages/Custom Tabs. Unknown names/missing resources return `404`; absent plugin instance `400`. See [JE Pages & Tabs](../getting-started/pages-and-tabs.md) for placement options.

## Full Endpoint Index

The endpoint tables above enumerate all 258 controller method/path entries, including the three catch-all templates. Each group documents effective access, inputs, response shape, and limits; shared proxy rows intentionally retain the configured upstream service's JSON contract.

For implementation details, [JellyfinEnhancedController.cs](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/main/Jellyfin.Plugin.JellyfinEnhanced/Controllers/JellyfinEnhancedController.cs) implements most indexed routes. `catchup/*` is in [CatchUpController.cs](https://github.com/n00bcodr/Jellyfin-Enhanced/blob/main/Jellyfin.Plugin.JellyfinEnhanced/Controllers/CatchUpController.cs), and the Requests & downloads routes are in the `Acquire*`, `Arr*`, `NativeDetails*`, `Notify`, `RequestsHub` and `JeBackup` controllers beside it. These upstream source links may advance beyond this versioned reference.
