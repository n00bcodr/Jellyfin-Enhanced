# Spoiler-Blur Client Compatibility Matrix

What works on what. Tested 2026-05-10 (R23 stress run).

## Tested clients

| Client | Build | Where | Status |
|---|---|---|---|
| **Jellyfin Web** | bundled with server 10.11.7 | `jellyfin-dev` direct + reverse-proxy `BaseUrl=/jf` | ✅ all features |
| **Jellyfin AndroidTV** | v0.19.9 debug | NVIDIA SHIELD Android TV (Android 11) | ✅ all features |
| **API consumer (curl/python)** | n/a | `jellyfin-dev` direct + reverse-proxy `BaseUrl=/jf` | ✅ all features |

### Expected-but-unverified clients

| Client | Platform | Expected behaviour | Why we expect it works | Caveat |
|---|---|---|---|---|
| **Findroid** | Android phone/tablet (Compose UI) | Same as Jellyfin AndroidTV | Uses Jellyfin's official client SDK to construct image URLs (`ApiClient.getImageUrl`), which includes `api_key=` automatically → server filter resolves the user → blur applies. R23 install on SHIELD AndroidTV succeeded but Compose UI didn't render through uiautomator dump (SHIELD's Leanback variant), so deferring full UI verification to a phone install. | If a build path strips `api_key=` and relies on `Authorization:` header on image fetches, fallback is `SpoilerUserResolver.ResolveUserId` session-by-IP — fail-closed on shared IPs (see SECURITY.md). |
| **Streamyfin** | iOS / Android (React Native) | Same as AndroidTV | Uses Jellyfin's official `@jellyfin/sdk-typescript` which constructs image URLs identically. Same `api_key=` mechanism. | Same shared-IP caveat. |
| **Swiftfin** | iOS / tvOS native | Same as AndroidTV | Uses Jellyfin's official Swift SDK; image URLs include `api_key=`. | Same shared-IP caveat. |
| **Kodi** (jellycon / jellyfin-kodi addon) | Kodi/CoreELEC | Same as AndroidTV | Python addons construct image URLs via Jellyfin's REST API including `api_key=`. | Same shared-IP caveat. |
| **Stock Jellyfin iOS / iPad** | iOS native | Same as AndroidTV | Same Jellyfin SDK pattern. | Same shared-IP caveat. |

These clients ARE expected to work because the spoiler-blur mechanism is **entirely server-side** — every native client hits the same `/Items/{id}/Images/{type}` endpoint and gets back the bytes the server's `SpoilerBlurImageFilter` decides to return. The only client-specific concern is whether the request carries the `api_key=` query param (Jellyfin's official SDK always adds it).

Anything using Jellyfin's official SDK should work. Anything using raw image URLs without `api_key=` falls back to `SpoilerUserResolver`'s session-by-IP heuristic (5s window, see `SpoilerUserResolver.SharedIpAmbiguityWindow`) which fails closed on ambiguity. **Verified on AndroidTV — extrapolated to others.**

## Surface × client matrix

✅ = verified, ⚪ = N/A, ❓ = not exercised in this round.

| Surface | Web | AndroidTV (SHIELD) | API |
|---|---|---|---|
| Series detail page — `Spoiler mode activated` overview | ✅ | ✅ | ✅ |
| Series Primary art (poster) — clear pass-through (per spec) | ✅ | ✅ | ✅ |
| Series Backdrop — clear when `SpoilerBlurArtwork=false` | ✅ | ✅ | ✅ |
| Series Backdrop — blurred when `SpoilerBlurArtwork=true` | ✅ | ❓ | ✅ |
| Episode Primary (unwatched, S2+) — blurred / hide-mode placeholder | ✅ | ✅ | ✅ |
| Episode Primary (watched) — clear pass-through | ✅ | ✅ | ✅ |
| Movie detail page — `Spoiler mode activated` overview | ✅ | ✅ | ✅ |
| Movie Primary art — blurred (unwatched) / hide-mode | ✅ | ✅ | ✅ |
| Movie title preserved (no rewrite) | ✅ | ✅ | ✅ |
| Collection (BoxSet) detail page — passes through clear (collection name + art is the entry point) | ✅ | ✅ | ✅ |
| **Movies inside opted-in Collection — Primary art blurs per movie's watched state** | ✅ | ✅ | ✅ |
| **Movies inside opted-in Collection — Overview / ratings / etc. stripped per movie's watched state** | ✅ | ✅ | ✅ |
| **Collection name preserved (no rewrite)** | ✅ | ✅ | ✅ |
| Search hints — episode/movie name suppressed for unwatched | ✅ | ✅ | ✅ |
| NextUp / Continue Watching rails — episode tiles blurred | ✅ | ✅ | ✅ |
| TMDB reviews suppressed on spoiler-mode series/movie | ✅ | ⚪ (no reviews UI on AndroidTV) | ✅ |
| **R20 cache-bust on watched-flip — native client refetches without cache clear** | ✅ | ✅ **verified empirically** | ✅ |
| `BaseUrl=/jf` reverse-proxy — all spoiler-blur endpoints round-trip | ✅ | ❓ | ✅ |
| Per-user isolation — Test user only affects own state | ✅ | ⚪ | ✅ |
| Restricted user (TestAdmin/Test) — only sees library they have access to | ✅ | ⚪ | ✅ |

## R20 cache-bust verification — concrete proof on AndroidTV

The user's original concern: "currently on androidtv i have to clear image cache for the watched ones to be unblurred."

Empirical test on SHIELD `192.168.0.133` (Android 11) with jellyfin-androidtv v0.19.9 debug:

1. Spoiler enabled for movie `190b0d61daaad2d60b302aa0ada45e88`. Movie marked unwatched.
2. Deep-link to movie via `am start -a VIEW -d <UUID>`. Screenshot shows: gray placeholder (hide-mode), "Spoiler mode activated", date stripped to "2004", `Overview` field redacted.
3. API: `POST /Users/{uid}/PlayedItems/{movieId}` (mark watched).
4. Re-deep-link **without clearing app cache**. Screenshot shows: real movie poster (fish image), full original Overview text, "29 Apr 2004" full premiere date.

The mechanism: `ImageTags.Primary` is prefixed with `sb-{stateHash}-` before being returned in DTOs. The state-hash inputs include `watched` and `playbackPositionTicks`. When watched flips, the hash flips, the URL flips, the native client's URL-keyed cache (Glide on AndroidTV) misses, fetches fresh.

Verified hash flip: `sb-ac38ff6f-...` (unwatched/blurred 445B) → `sb-22ec0ec7-...` (watched/clear 4255B).

## Reverse-proxy verification (BaseUrl=/jf via nginx)

Spun up `nginx:alpine` proxying `:8099 → jellyfin-dev:8096/jf/`. Tested:
- `POST /Users/AuthenticateByName` via proxy → 200, valid token issued
- `POST /JellyfinEnhanced/spoiler-blur/{series,movies,collections}/{id}` via proxy → 200, state persisted
- `GET /Users/{uid}/Items/{id}` via proxy → strip filter applied (Overview="Spoiler mode activated", ImageTags prefixed)
- `GET /Items/{id}/Images/Primary` via proxy → 445B blurred body + `Cache-Control: private, no-store`
- `POST /JellyfinEnhanced/tag-data/{uid}` via proxy → Series + Movie stub returned (Genres=[], ratings=null, Path=null). BoxSet DTOs pass through unstripped per the R23 collection-redesign (collection is the entry point; movies inside it carry the strip).

Bytes through proxy match bytes from direct call. No URL-emission bugs.

## Backend stress harness

Continuous run on `jellyfin-dev`:
- 1157 iterations, ~22 minutes wall-clock
- 13879 surface probes
- **0 failures**
- 8 surfaces × 3 users (admin, TestAdmin, Test) × 7 spoiler-list shapes × randomized config matrix (mode/intensity/9 strip toggles)

See `/tmp/r23-summary.txt` and `/tmp/r23-failures.jsonl` for raw outputs.

## Known limitations / out of scope

- **Trickplay tiles** (timeline-hover preview thumbnails) bypass the image filter. Documented in SECURITY.md.
- **Subtitle content** is not stripped (rendering happens client-side from raw .srt/.vtt bytes).
- **In-memory client cache** (web client memory cache, not URL cache) is not invalidated on toggle — user must navigate or refresh. Mitigated by R14-M1 reviews-strip and JS tag-pipeline cache invalidation.
- **Push notifications** ("New episode of X added") are server events outside the plugin's filter chain.
