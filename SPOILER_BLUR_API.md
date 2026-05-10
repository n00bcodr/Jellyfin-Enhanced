# Spoiler Blur — External Client API

This document describes the public HTTP API the Jellyfin Enhanced plugin
exposes for the Spoiler Blur feature. It is aimed at developers of
**external clients** (Streamyfin, Findroid, Swiftfin, custom apps,
browser extensions) that want to integrate spoiler-mode without going
through Jellyfin's MVC pipeline.

The plugin's own server-side filters (`SpoilerBlurImageFilter` +
`SpoilerFieldStripFilter`) automatically rewrite responses for clients
that route through Jellyfin's `/Items` / `/PlaybackInfo` / image
endpoints. Native clients that talk to Jellyfin's API directly will
**still see raw, un-stripped data** — these endpoints exist so those
clients can mirror the strip locally.

- [API Versioning](#api-versioning)
- [Authentication](#authentication)
- [Quick start](#quick-start)
- [Endpoints](#endpoints)
  - [`GET /spoiler-blur/info`](#get-spoiler-blurinfo)
  - [`GET /spoiler-blur/config`](#get-spoiler-blurconfig)
  - [`GET /spoiler-blur/state`](#get-spoiler-blurstate)
  - [`GET /spoiler-blur/series`](#get-spoiler-blurseries)
  - [`POST /spoiler-blur/series/{seriesId}`](#post-spoiler-blurseriesseriesid)
  - [`DELETE /spoiler-blur/series/{seriesId}`](#delete-spoiler-blurseriesseriesid)
  - [`GET /spoiler-blur/movies`](#get-spoiler-blurmovies)
  - [`POST /spoiler-blur/movies/{movieId}`](#post-spoiler-blurmoviesmovieid)
  - [`DELETE /spoiler-blur/movies/{movieId}`](#delete-spoiler-blurmoviesmovieid)
  - [`GET /spoiler-blur/check/{itemId}`](#get-spoiler-blurcheckitemid)
  - [`POST /spoiler-blur/evaluate`](#post-spoiler-blurevaluate)
- [Field reference](#field-reference)
- [Recommended client patterns](#recommended-client-patterns)
- [Error handling](#error-handling)
- [Versioning policy](#versioning-policy)

---

## API Versioning

All endpoints live under the same base path as the rest of the plugin:

```
{jellyfin-base-url}/JellyfinEnhanced/spoiler-blur/...
```

The current API version is **`1`**. Returned by `/info` as `apiVersion`.
Adding fields is non-breaking; clients should ignore unknown fields.
Removing or renaming fields bumps the integer.

## Authentication

All endpoints except `/info` require Jellyfin authentication. Use the
standard `X-Emby-Token` header or Jellyfin's `Authorization:
MediaBrowser ...` header — the same credentials your client already
uses to call `/Items` etc.

The `/info` endpoint is anonymous so a client can probe for the plugin
before the user has logged in.

## Quick start

```bash
TOKEN="..."  # the user's Jellyfin access token

# 1. Probe — is the plugin available?
curl "$JELLYFIN/JellyfinEnhanced/spoiler-blur/info"

# 2. One-shot fetch of everything you need
curl -H "X-Emby-Token: $TOKEN" \
     "$JELLYFIN/JellyfinEnhanced/spoiler-blur/state"

# 3. For a list of cards on screen, ask which to strip
curl -X POST -H "X-Emby-Token: $TOKEN" -H "Content-Type: application/json" \
     -d '{"itemIds":["abc...","def...","ghi..."]}' \
     "$JELLYFIN/JellyfinEnhanced/spoiler-blur/evaluate"
```

---

## Endpoints

### `GET /spoiler-blur/info`

**Auth:** None
**Purpose:** Capability discovery. Use to detect whether the plugin is
installed before showing any UI that depends on it.

**Response** (200):
```json
{
  "feature": "spoiler-blur",
  "apiVersion": 1,
  "pluginVersion": "11.8.1.0",
  "available": true,
  "serverEnabled": true
}
```

| Field | Meaning |
|---|---|
| `feature` | Always `"spoiler-blur"` for this surface. |
| `apiVersion` | Bumped on any breaking change to the response shapes below. |
| `pluginVersion` | The actual JE plugin version installed. |
| `available` | Always `true` when this endpoint responds — feature exists. |
| `serverEnabled` | Whether the admin has the master switch on. **If `false`, do NOT show spoiler-mode UI** — toggling will fail because the server-side filters won't fire. |

If the plugin isn't installed at all, this endpoint returns 404. Clients
should treat 404 as "feature unavailable; no UI".

---

### `GET /spoiler-blur/config`

**Auth:** Bearer
**Purpose:** Returns the server-wide spoiler-blur config. Useful for
clients that want to mirror the strip rules locally.

**Response** (200):
```json
{
  "enabled": true,
  "blurMode": "blur",
  "blurArtwork": false,
  "blurIntensity": 40,
  "stripOverview": true,
  "stripTags": true,
  "stripChapters": true,
  "stripTaglines": true,
  "stripCommunityRating": false,
  "stripCriticRating": false,
  "stripPremiereDate": false,
  "replaceTitle": false,
  "stripCast": false,
  "stripCastMode": "GuestStars",
  "stripReviews": true,
  "overviewPlaceholder": "Spoiler mode activated"
}
```

See [Field reference](#field-reference) below for what each toggle does.

---

### `GET /spoiler-blur/state`

**Auth:** Bearer
**Purpose:** All-in-one. Returns the server config **and** the user's
spoiler list (series + movies). Cuts a cold-start from 3 round-trips to 1.

**Response** (200):
```json
{
  "config": { ... same as /config ... },
  "series": {
    "678cc5beec6679b5af8b6a8836656fe7": {
      "seriesId": "678cc5beec6679b5af8b6a8836656fe7",
      "seriesName": "Bluey",
      "enabledAt": "2026-04-26T11:13:29.0212717Z"
    }
  },
  "movies": {
    "f1234...": {
      "movieId": "f1234...",
      "movieName": "Top Gun: Maverick",
      "enabledAt": "2026-05-01T12:00:00.0000000Z"
    }
  }
}
```

Returns `503` if the user's `spoilerblur.json` is corrupt (the server
has already backed it up to a `.corrupt-{timestamp}` file). Clients
should retry after the user resets the list.

---

### `GET /spoiler-blur/series`

**Auth:** Bearer
**Purpose:** List the user's spoiler-mode-enabled series.

**Response** (200):
```json
{
  "Series": {
    "abc123": { "seriesId": "abc123", "seriesName": "...", "enabledAt": "..." }
  }
}
```

Returns `{ "Series": {} }` for first-time users (file doesn't exist yet),
`503` on corruption.

### `POST /spoiler-blur/series/{seriesId}`

**Auth:** Bearer
**Purpose:** Enable spoiler mode for a series. `seriesId` accepts both
dashed (`abc-123-...`) and N-format (`abc123...`) GUIDs.

**Response** (200):
```json
{ "success": true, "seriesId": "abc123...", "name": "Bluey" }
```

Returns `404` if the series doesn't exist or the user can't access it.
Returns `503` on store corruption.

### `DELETE /spoiler-blur/series/{seriesId}`

**Auth:** Bearer
**Purpose:** Disable spoiler mode for a series.

**Response** (200):
```json
{ "success": true, "seriesId": "abc123...", "removed": true }
```

`removed: false` means the series wasn't in the list to begin with
(client/server desync) — still treated as success.

---

### `GET /spoiler-blur/movies`

**Auth:** Bearer
**Purpose:** Symmetric to `/series` — lists the user's enabled movies.

**Response** (200):
```json
{
  "Movies": {
    "f1234...": { "movieId": "f1234...", "movieName": "...", "enabledAt": "..." }
  }
}
```

### `POST /spoiler-blur/movies/{movieId}`

**Auth:** Bearer
**Purpose:** Enable spoiler mode for a movie. Optional body sanitizes
the display name (otherwise pulled from the library item).

**Body** (optional):
```json
{ "MovieName": "Top Gun: Maverick" }
```

**Response** (200):
```json
{ "success": true, "movieId": "f1234...", "name": "Top Gun: Maverick" }
```

### `DELETE /spoiler-blur/movies/{movieId}`

**Auth:** Bearer
**Response** shape mirrors `DELETE /spoiler-blur/series/{id}`.

---

### `GET /spoiler-blur/check/{itemId}`

**Auth:** Bearer
**Purpose:** Per-item evaluation. Tells the client whether to apply
blur / metadata strip / progressive chapter strip, plus the placeholder
text and replacement name.

**Response** (200):
```json
{
  "itemId": "abc123",
  "itemType": "Episode",
  "inSpoilerList": true,
  "watched": false,
  "playbackPositionTicks": 0,
  "shouldBlur": true,
  "shouldStripMetadata": true,
  "fieldsToStrip": ["overview", "tags", "chapters", "taglines"],
  "replaceName": "Season 2, Episode 6",
  "placeholder": "Spoiler mode activated",
  "seriesId": "678cc5be...",
  "seasonNumber": 2,
  "episodeNumber": 6,
  "chaptersToHideName": []
}
```

**Field semantics:**

| Field | Notes |
|---|---|
| `itemType` | One of `"Episode"`, `"Season"`, `"Series"`, `"Movie"`, or the raw type for extras. |
| `inSpoilerList` | The user has spoiler mode on for this item (or its parent series for episodes/seasons). |
| `watched` | For episodes/movies: `UserData.Played`. For seasons: any episode in the season is played. For series: always `false` (no per-item watched). |
| `playbackPositionTicks` | Resume point in 100-ns ticks. Used for movie chapter progressive strip. |
| `shouldBlur` | The client should render a blurred / placeholder image. |
| `shouldStripMetadata` | The client should hide spoilery fields. |
| `fieldsToStrip` | Sorted list of field-keys (see below). Empty when nothing should be hidden. |
| `replaceName` | When non-null, replace `item.Name` with this string. Movies: always `null` (movie titles are not hidden, per design). |
| `placeholder` | Admin-set placeholder string for stripped descriptions. |
| `chaptersToHideName` | For movies under progressive strip: 0-based chapter indexes whose names/thumbnails should be hidden. Empty means show all (or strip all if `shouldStripMetadata && stripChapters`). |
| `imageCacheToken` | 8-hex-char hash that **changes whenever the image bytes for this item would change** (watched-state, blur mode, intensity, master-switch). Append it to image URLs as `?_v={token}` to defeat aggressive native image caches. See [Image cache busting](#image-cache-busting). |

**`fieldsToStrip` keys:**

| Key | Field |
|---|---|
| `overview` | `BaseItemDto.Overview` → replace with `placeholder`. |
| `tags` | `BaseItemDto.Tags` (TMDB tags). |
| `chapters` | `BaseItemDto.Chapters[].Name` (and `.ImagePath` when title-strip is also on). |
| `taglines` | `BaseItemDto.Taglines`. |
| `communityRating` | `BaseItemDto.CommunityRating`. |
| `criticRating` | `BaseItemDto.CriticRating`. |
| `premiereDate` | `BaseItemDto.PremiereDate`. |
| `cast` | `BaseItemDto.People`. Whether to strip everyone or only guest stars depends on `config.stripCastMode`. |
| `name` | Replace `BaseItemDto.Name` (Episode + Season only — see `replaceName` for the new value). |
| `path` | `BaseItemDto.Path` plus `MediaSources[].Path/Name`. |
| `mediaStreams` | `MediaStreams[].Title/Comment/Path/DeliveryUrl` and the same on nested `MediaSources[].MediaStreams`. |
| `mediaSources` | `MediaSources[].Path/Name` and `MediaAttachments[].FileName/Comment`. |
| `remoteTrailers` | `BaseItemDto.RemoteTrailers` (URL-slug leak). |
| `externalUrls` | `BaseItemDto.ExternalUrls`. |

Returns `404` if the item doesn't exist or the user can't access it.

---

### `POST /spoiler-blur/evaluate`

**Auth:** Bearer
**Purpose:** Batch version of `/check`. Accepts up to **200 IDs** per
call so a card-grid render doesn't fan out 200 individual GETs.

**Body:**
```json
{
  "itemIds": ["abc123...", "def456...", "ghi789..."]
}
```

**Response** (200):
```json
{
  "items": {
    "abc123...": { ...same shape as /check... },
    "def456...": { ...same shape as /check... },
    "ghi789...": null
  }
}
```

A `null` value means the item wasn't found or wasn't accessible (treat
as "no special handling" — render normally). Errors don't fail the
whole batch.

Returns `400` for empty or oversized batches.

---

## Field reference

### `config.blurMode`

| Value | Behaviour |
|---|---|
| `"blur"` | Default. Image filter blurs the original bytes via SkiaSharp Gaussian. |
| `"hide"` | Returns a flat dark-grey placeholder JPEG sized to the original. |

### `config.blurArtwork`

| Value | Image types blurred |
|---|---|
| `false` | (Default.) Only `Primary` / `Thumb` / `Screenshot` / `Chapter`. |
| `true` | Adds `Backdrop` / `Art` (the wide images on detail pages and collections). |

### `config.stripCastMode`

Only meaningful when `config.stripCast == true`.

| Value | Behaviour |
|---|---|
| `"GuestStars"` | Drop only `People[]` entries with `Type == GuestStar`. |
| `"All"` | Drop the entire `People` array. |

### `config.replaceTitle`

When `true`, episodes / seasons get a generic `Name`:
- Episode → `"Season {n}, Episode {m}"` (server already populates the synthetic name in `replaceName`)
- Season → `"Season {n}"`
- **Movies are never renamed** even with this on (titles surface in URLs / nav anyway; per-design carve-out).

---

## Image cache busting

**Problem:** Native image cache libraries (Glide, Coil, SDWebImage,
ImageKit, etc.) cache image bytes strictly **by URL** and routinely
ignore HTTP `Cache-Control` headers. When the user marks an episode
watched, the server happily serves the unblurred bytes — but the
client never asks because it has the blurred copy cached under the
exact same URL. The only "fix" was clearing the app's image cache
manually.

**Two automatic solutions, no opt-in needed:**

### 1. Server-side ImageTags mutation (zero integration)

The plugin's field-strip filter mutates `BaseItemDto.ImageTags` for
items in the user's spoiler list. The tag becomes
`sb-{stateHash}-{originalTag}`. Native clients build image URLs
using `?tag={ImageTags["Primary"]}`, so:

- Unwatched: URL is `/Items/{id}/Images/Primary?tag=sb-abc12345-deadbeef`
- Watched: URL becomes `/Items/{id}/Images/Primary?tag=sb-99887766-deadbeef` (different state hash)

Native client cache keys by URL → cache miss → fresh fetch → unblurred
bytes appear immediately. **Works without any client code changes.**

### 2. `imageCacheToken` (when you want explicit control)

For clients that construct image URLs themselves rather than reading
`ImageTags` from the DTO, the `/check` and `/evaluate` endpoints
return an `imageCacheToken`. Append it to your image URLs:

```ts
const eval_ = await fetch(`${jf}/JellyfinEnhanced/spoiler-blur/check/${itemId}`,
  { headers: { 'X-Emby-Token': token } }).then(r => r.json());

const imgUrl = `${jf}/Items/${itemId}/Images/Primary?fillWidth=320&_v=${eval_.imageCacheToken}`;
```

Both approaches use the **same hash function**, so a client that mixes
them (some images from `ImageTags`, some constructed manually) ends
up with consistent URLs.

The hash inputs:
- itemId
- server-wide `enabled`
- per-item `shouldBlur` decision (function of in-list + watched)
- `blurMode` ("blur" / "hide" → different output bytes)
- `blurIntensity` (different sigma → different bytes)
- `blurArtwork` (gates Backdrop/Art tier)
- `playbackPositionTicks` (movies — chapter image reveal advances)

Token format: 8 hex chars (32 bits). Collision probability across
typical libraries is negligible.

## Recommended client patterns

### 1. App start

```ts
// One-time probe. Cache the result for the session.
const info = await fetch(`${jf}/JellyfinEnhanced/spoiler-blur/info`).then(r => r.json());
if (!info.available || !info.serverEnabled) {
  // Hide spoiler-mode UI. Skip remaining calls.
  return;
}
```

### 2. After login

```ts
// Pull combined state once. Cache.
const state = await fetch(`${jf}/JellyfinEnhanced/spoiler-blur/state`,
  { headers: { 'X-Emby-Token': token } }).then(r => r.json());

// `state.config` drives strip rules. `state.series` / `state.movies`
// drive whether to show the spoiler-toggle button on detail pages.
```

### 3. Detail-page toggle

```ts
// Series page
async function toggleSeries(seriesId, on) {
  const m = on ? 'POST' : 'DELETE';
  await fetch(`${jf}/JellyfinEnhanced/spoiler-blur/series/${seriesId}`,
    { method: m, headers: { 'X-Emby-Token': token } });
  // Re-fetch /state to refresh local cache.
}
```

### 4. Card-grid render (Home, search, browse)

Use `/evaluate` for the visible cards in one batch:

```ts
const visibleIds = grid.children.map(card => card.itemId).slice(0, 200);
const r = await fetch(`${jf}/JellyfinEnhanced/spoiler-blur/evaluate`, {
  method: 'POST',
  headers: { 'X-Emby-Token': token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ itemIds: visibleIds })
}).then(r => r.json());

for (const [id, eval_] of Object.entries(r.items)) {
  if (!eval_) continue;
  if (eval_.shouldBlur) renderPlaceholder(id);
  if (eval_.replaceName) setName(id, eval_.replaceName);
  if (eval_.shouldStripMetadata) hideFields(id, eval_.fieldsToStrip);
}
```

### 5. Player timeline (movies)

```ts
// On player open
const r = await fetch(`${jf}/JellyfinEnhanced/spoiler-blur/check/${movieId}`,
  { headers: { 'X-Emby-Token': token } }).then(r => r.json());

if (r.shouldBlur && r.chaptersToHideName.length > 0) {
  // The chapters in chaptersToHideName are not yet watched.
  // Hide their thumbnails / names; keep timestamps.
  for (const idx of r.chaptersToHideName) {
    chapter[idx].name = r.placeholder;
    chapter[idx].thumbnail = null;
  }
}
```

---

## Error handling

| Status | Meaning |
|---|---|
| 200 | Success |
| 400 | Bad request — invalid item ID or batch too big |
| 401 / 403 | Auth failed or user not authorized |
| 404 | Item not found, not accessible, or plugin not installed |
| 503 | User's `spoilerblur.json` is corrupt (already backed up); retry after they reset their list |

The server NEVER returns 5xx for normal "feature not enabled" cases —
that's `info.serverEnabled = false` in the success response. 5xx means
something genuinely failed; clients should retry with backoff.

---

## Versioning policy

`apiVersion` increments on:
- Removing a field
- Renaming a field
- Changing a field's type
- Changing a field's enum value range
- Changing a status code semantically

`apiVersion` does NOT increment on:
- Adding a field
- Adding a new endpoint
- Adding a new enum value (e.g. new `blurMode`)
- Server-side behavioural changes that don't alter the response shape

Clients should:
- Hard-code `apiVersion >= 1` as a minimum
- Ignore unknown fields silently
- Tolerate `null` for optional fields
- Treat 4xx as "don't apply spoiler-mode for this item" (fail-open) and
  5xx as transient (retry with backoff)
