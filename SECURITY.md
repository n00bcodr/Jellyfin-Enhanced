# Security Policy

## Supported Versions

We release patches for security vulnerabilities in the following versions:

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |
| < Latest| :x:                |

We recommend always using the latest version of Jellyfin Enhanced to ensure you have the most recent security updates.

## Reporting a Vulnerability

We take the security of Jellyfin Enhanced seriously. If you believe you have found a security vulnerability, please report it to us responsibly.

### Please DO NOT:
- Open a public GitHub issue for security vulnerabilities
- Disclose the vulnerability publicly before it has been addressed

### Please DO:
1. **Report privately** via GitHub Security Advisories:
   - Go to the [Security tab](../../security/advisories)
   - Click "Report a vulnerability"
   - Provide detailed information about the vulnerability

2. **Include in your report:**

   - Description of the vulnerability
   - Steps to reproduce the issue
   - Potential impact
   - Suggested fix (if any)
   - Your contact information

### What to expect:
- **Initial Response**: Within 48 hours
- **Status Update**: Within 7 days with our assessment
- **Fix Timeline**: Depends on severity and complexity
  - Critical: Within 7 days
  - High: Within 30 days
  - Medium: Within 90 days
  - Low: Next regular release

## Security Best Practices for Users

### Plugin Configuration:
1. **API Keys**: Store API keys securely and never commit them to version control
2. **Access Control**: Use Jellyfin's built-in user permissions appropriately
3. **HTTPS**: Always access Jellyfin over HTTPS in production
4. **Updates**: Keep Jellyfin Enhanced and Jellyfin server up to date

### External Integrations:
1. **Seerr**: Ensure your Seerr instance is properly secured
2. **TMDB API**: Protect your TMDB API key and monitor usage
3. **Network Access**: Restrict access to your Jellyfin server appropriately

### Client-Side Security:
- The plugin runs JavaScript in the browser context
- Review custom CSS/JS modifications before applying
- Be cautious with user-generated content

## Known Security Considerations

### Client-Side Storage:
- Bookmarks and settings are stored per-user in Jellyfin's database
- No sensitive credentials are stored client-side

### API Communications:
- All API calls use Jellyfin's authentication system
- External API calls (TMDB, Seerr) are proxied through the plugin backend when possible
- API keys are stored server-side in plugin configuration

### Content Security:
- External content (posters, metadata) is fetched from trusted sources (TMDB, Jellyfin)
- User-provided URLs are validated before use
- XSS protection is implemented for user-generated content

## Spoiler Blur — Operational Notes

The Spoiler Blur feature blurs unwatched-episode images server-side via a
SkiaSharp Gaussian blur applied in an MVC action filter. Two
authentication paths are supported:

1. **Native clients** (Swiftfin, Findroid, Streamyfin, AndroidTV, etc.)
   — the plugin identifies the user from the active Jellyfin session
   that matches the request's remote IP. No special configuration needed.

2. **Web client** — the plugin's client-side JS appends `&api_key=<accessToken>`
   to every Jellyfin `/Items/{id}/Images/...` URL so that the server
   filter can identify the requesting user. Browsers issue anonymous
   `<img src>` requests by default, so without this rewrite the filter
   would have no user context and would pass everything through unblurred.

   **Operational implication for reverse-proxy / log-aggregation
   deployments**: the user's session token now appears in the query
   string of image URLs. Default `nginx` and `apache2` access-log
   formats capture full URLs including query strings, which means the
   token is persisted in cleartext for the log retention window. This
   is a regression compared to Jellyfin's default behaviour (anonymous
   image fetches). Operators using shared hosting, log aggregators, or
   long-retention access logs should either:

   - Scrub `api_key=...` from the access-log format before shipping
     logs. Sample nginx config:
     ```nginx
     map $request_uri $clean_uri {
         "~^(?<prefix>.*[?&])api_key=[^&]*(?<suffix>.*)$"
              $prefix"api_key=REDACTED"$suffix;
         default $request_uri;
     }
     log_format jellyfin_scrubbed '$remote_addr - $remote_user [$time_local] '
                                  '"$request_method $clean_uri $server_protocol" '
                                  '$status $body_bytes_sent';
     access_log /var/log/nginx/jellyfin.log jellyfin_scrubbed;
     ```
   - OR disable Spoiler Blur (`SpoilerBlurEnabled=false` in plugin config)
     until a cookie-based auth path is available.

   The token is the user's normal Jellyfin access token; rotating it
   (logging out and back in) invalidates anything that has been logged.

### Spoiler Blur — Shared-IP Limitations

The session-by-IP fallback used for native clients matches a request to
its user by looking up active Jellyfin sessions whose `RemoteEndPoint`
IP equals the request's `RemoteIpAddress`. Two operational caveats
apply:

1. **Reverse-proxy / NAT collapse.** If Jellyfin runs behind a reverse
   proxy (nginx, Traefik) and `KnownProxies` / `ForwardedHeadersOptions`
   is not configured to trust `X-Forwarded-For`, every request appears
   to come from the proxy's loopback address (typically `127.0.0.1`).
   When two users are simultaneously logged in through the same proxy,
   each anonymous image request matches BOTH sessions; the most
   recently-active one wins. Until the activity disambiguates, User A
   may see images blurred per User B's spoiler list, and vice versa.
   The plugin detects this case (multiple distinct users active within
   a 60-second window from the same IP) and **fails closed** — passes
   through unblurred rather than apply the wrong user's preferences.
   Configure Jellyfin's `KnownProxies` to trust your proxy's
   `X-Forwarded-For` so that the request IP reflects the actual client.

2. **Same-LAN multi-user.** Two devices behind the same external NAT
   IP are isolated only if Jellyfin sees distinct LAN IPs. On a typical
   home LAN the router presents each device's own LAN IP to Jellyfin,
   so this works correctly. On unusual setups (carrier-grade NAT,
   hairpin DNS, IPv6 prefix delegation collapse) two clients may share
   an apparent IP and the same fail-closed behaviour kicks in: blur is
   silently disabled rather than applied to the wrong user.

In both shared-IP scenarios, the failure mode is "no blur" rather than
"wrong-user blur"; no images are leaked TO an unauthorized user, but
the privileged user's spoiler-blur experience is degraded until the IP
disambiguates.

### Spoiler Blur — Header Fingerprint

When Spoiler Blur is enabled for a series, image responses for episodes
of that series carry `Cache-Control: private, no-store, max-age=0,
must-revalidate` and have `ETag` / `Last-Modified` removed — both for
blurred-bytes responses and for watched-episode pass-through. Image
responses for episodes that are NOT on any of the user's spoiler-list
series carry Jellyfin's default `Cache-Control: public, max-age=...`
plus standard validators.

A passive on-path observer with TLS visibility (corporate TLS-inspection
proxy, or operator of a non-HTTPS Jellyfin install) can therefore
distinguish "this episode belongs to a series the user has spoiler-mode
enabled for" from "this episode does not". The episode bytes themselves
are unchanged for watched episodes, so the leak is metadata only — the
series-membership-in-spoiler-list itself, not the user's watched/unwatched
state per-episode. Operators who want to eliminate this fingerprint
should ensure Jellyfin is fronted by HTTPS with no TLS-inspection
intermediaries, which is the recommended baseline for any Jellyfin
deployment.

### Spoiler Blur — Native-Client Coverage

External clients (Streamyfin, Findroid, Swiftfin, Jellyfin Android TV
app, Symfonium) talk to Jellyfin's API directly rather than rendering
in the web view, so they don't pick up any client-side filtering the
JE web bundle does. The plugin's image filter and field-strip MVC
filter run server-side on the listed routes below — anything served
from those routes is stripped before the client ever sees it.

**Server-side filter coverage (always on, no client integration
required):**

| Surface | Route | Native UI rail / use |
|---|---|---|
| Standard item lists | `Items.GetItems`, `Items.GetItemsByUserIdLegacy`, `Items.GetResumeItems` | Continue Watching, library browse, search-as-you-type |
| Single item | `UserLibrary.GetItem`, `UserLibrary.GetItemLegacy` | Item detail page |
| Latest rail | `UserLibrary.GetLatestMedia` | "Latest" home rail |
| Episode/season grid | `TvShows.GetEpisodes`, `TvShows.GetSeasons` | Show detail page |
| Up Next | `TvShows.GetNextUp`, `TvShows.GetUpcomingEpisodes` | Up Next home rail |
| Suggestions | `Suggestions.GetSuggestions` | Home recommendations |
| Search | `Search.GetSearchHints` | Autocomplete |
| Similar items | `Library.GetSimilarItems/Shows/Movies/Trailers/Albums` | "More Like This" rail |
| Extras | `UserLibrary.GetIntros/GetLocalTrailers/GetSpecialFeatures` | "Extras" / "Trailers" tabs |
| Image metadata | `Image.GetItemImageInfos` | "Edit Images" admin path; ImageInfo.Path |
| Playback negotiation | `MediaInfo.GetPlaybackInfo/GetPostedPlaybackInfo` | Pre-play info request |
| **Movie recommendations** | `Movies.GetMovieRecommendations` | Home "Recommended For You" rail (R21) |
| **Playlist contents** | `Playlists.GetPlaylistItems` | User-created playlists (R21) |
| Image bytes | `Image.GetItemImage/GetItemImageByIndex/GetItemImage2` | Every poster, thumb, scene preview |

**Image cache busting (no client integration needed):**

`BaseItemDto.ImageTags` is mutated to `sb-{stateHash}-{originalTag}`
for items in the user's spoiler list. Native image cache libraries
(Glide, Coil, SDWebImage) cache by URL and the URL embeds the tag, so
when the user marks watched the URL flips and the cache evicts
automatically. No "clear app cache" needed.

**Known limitations (inherent, no fix planned):**

- **Trickplay tile previews** (`/Videos/{id}/Trickplay/...`) are
  served by Jellyfin's video controller, not the image controller.
  Each tile is a sparse-sampled frame from the entire movie; blurring
  them defeats trickplay scrubbing entirely. They pass through
  unblurred. If this is a deal-breaker, disable trickplay generation
  for spoiler-list movies.
- **Subtitle file content** can describe scenes. Subtitle file
  fetches happen during playback (when the user is committed to
  watching). Out of scope.
- **In-memory client cache.** Some clients hold the previously-fetched
  `BaseItemDto` in memory for a session; subsequent renders use that
  cached object even after the user enables spoiler mode. The next
  page nav / back-foreground transition triggers a re-fetch which
  picks up the strip. Server can't force this.
- **Push notifications** for "new episode available" can carry the
  raw episode title. Sent by Jellyfin's notification system, not the
  plugin.

### Spoiler Blur — Movie Titles + Backdrop Art Are Intentionally Surfaced

Two scoped carve-outs deliberately leave content visible:

1. **Movie titles** (`item.Name`, `SearchHint.Name`, tag-data stub `Name`)
   are NOT rewritten under `SpoilerReplaceTitle`. Movie titles are
   library-evident from URLs, navigation breadcrumbs, and folder layouts
   anyway — the synopsis / chapters / cast are the actual spoiler
   surface for movies. The filesystem `Path` / `MediaSources[].Path` /
   `MediaStreams[].Title` strip remains active under `SpoilerReplaceTitle
   || SpoilerStripOverview`.

2. **Backdrop / Art images** pass through unblurred by default. Set
   `SpoilerBlurArtwork=true` in plugin config to also blur those wider
   aesthetic images. Default is opt-in scope-narrowing: backdrops are
   typically studio art (less plot-bearing than the curated Primary /
   Thumb posters where most spoiler risk lives).

Spoiler-list artwork (Backdrop / Art) is still served with
`Cache-Control: private, no-store` even when the toggle is off — so a
later `SpoilerBlurArtwork=true` flip immediately re-evaluates on the
next request, instead of letting the browser/proxy keep cached clear
bytes.

### Spoiler Blur — Title Strip is Best-Effort Across DTO Shapes

`SpoilerReplaceTitle` and `SpoilerStripOverview` aggressively null
title-bearing fields across every DTO shape we know about (R10/R11
batches): top-level `Path`, `EpisodeTitle`, `ForcedSortName`,
`CustomRating`, `RemoteTrailers`, `ExternalUrls`; top-level + nested
`MediaStreams[].Title/Comment/Path/DeliveryUrl`; `MediaSources[].Path/Name`,
`MediaSources[].MediaAttachments[].FileName/Comment`;
`ChapterInfo.ImagePath`; `People[].Role`; `SearchHint.MatchedTerm`;
`ImageInfo.Path` (`/Items/{id}/Images`);
`PlaybackInfoResponse.MediaSources[]` (`/Items/{id}/PlaybackInfo`).

Future Jellyfin upgrades may add new DTO fields or new DTO shapes that
carry title-leaky content. The current architecture is **route-allowlist
+ DTO-shape switch** — a new shape silently bypasses strip until added
to the allowlist. The recurring pattern observed across rounds 7–11 of
review suggests a structural change to a recursive response-body
property sweeper would be more durable. That work is a follow-up item;
if you upgrade to a new Jellyfin version and notice unexpected spoiler
leaks, file an issue.

### Spoiler Blur — Behaviour on Corrupt User State

`spoilerblur.json` is read on every image request and on every tag-cache /
tag-data poll. Three different read paths exist:

1. The dedicated `/JellyfinEnhanced/spoiler-blur/series` endpoint uses
   the **strict** read with corruption detection. A corrupt file backs
   up to `.corrupt-{ts}` and returns HTTP 503; the user sees a hard
   error in the UI and is forced to recover. This is the only path
   that mutates the file (read-modify-write on toggle).

2. The image filter (`SpoilerBlurImageFilter`) and the field-strip
   filter (`SpoilerFieldStripFilter`) both call the **lenient** read
   via `SpoilerUserResolver.LoadUserState`. The config manager catches
   read/parse errors internally and returns an empty `UserSpoilerBlur`,
   logging at Error level under the config-manager's namespace. The
   spoiler list is treated as empty for the duration of the corruption,
   so blur and field-strip silently disable until the user fixes the
   file via the UI. **This is fail-OPEN** — privacy is degraded for
   that one user until they recover. This trade-off is intentional:
   failing closed (treating every episode as needing strip) on a hot
   path would brick image rendering and be far more disruptive than
   the metadata leak. The corruption fact remains observable through
   the config manager's own log line.

3. The tag-cache + tag-data endpoints use the strict read via
   `LoadSpoilerStateForTagStrip`, but on corruption return `null` (skip
   strip) with a rate-limited warn rather than HTTP 503 — the unrelated
   tag-cache request stays usable. Behaviour is fail-OPEN, same caveat
   as (2).

If you operate a multi-user Jellyfin instance and want stronger
guarantees against corrupt-config leakage, monitor the Jellyfin log for
"Error deserializing 'spoilerblur.json'" lines and have an
out-of-band remediation playbook (delete the corrupt file or restore
from backup).

### Why `api_key=` is appended to web image URLs

The web URL patcher (`js/enhanced/spoiler-blur.js → patchImageUrlsForAuth`)
rewrites every `/Items/{id}/Images/{type}` URL that the web client emits
to include `?api_key=<accessToken>`. This is necessary for spoiler-blur
to work in the browser, and is **not a new credential exposure surface**
relative to what Jellyfin already does for other assets.

**Why it's required.** Jellyfin's image endpoint is anonymous-friendly by
design — `<img src="/Items/.../Images/Primary">` works without auth so
the browser can issue plain image requests (HTML/CSS image fetches don't
carry custom `Authorization` headers). For un-modified Jellyfin this is
fine because image bytes are item-level metadata, not per-user. But the
spoiler filter needs to know **which user** is requesting each image to
look up that user's per-spoiler-list and decide blur vs. clear. With no
token, the filter has no user → defaults to pass-through → unblurred
image leaks. Adding `api_key=<token>` to image URLs gives the filter the
identity it needs.

**Why this is safe.** The token used is the **session access token** the
page already has in `ApiClient.accessToken()` and sends as
`Authorization: Bearer …` on every JSON request. It is *not* a long-lived
API key. It's tied to the user's current device/login session; expires
on logout or token rotation. Leak blast radius = that user's current
session.

Jellyfin already emits this same token in URL query strings for several
asset types — `?api_key=…` shows up on `/Videos/{id}/stream.*`, HLS
playlists (`master.m3u8`), HLS segments, DASH manifests, subtitle
downloads, and many native-client image URLs (AndroidTV's SDK includes
it automatically). Image URLs joining this list does not change the
risk profile.

**Where the token can end up (already-true vs. new):**

| Surface | Already exposed in Jellyfin pre-plugin? | New under spoiler-blur? |
|---|---|---|
| Browser HTTP cache index (URL is cache key) | Yes — HLS segments, etc. | Image URLs join the same pattern |
| Server access logs (Jellyfin + reverse-proxy) | Yes — streaming URL lines | Same: image-request log lines now carry it |
| Browser DevTools Network tab | Yes — every authenticated request | No additional rows |
| HTTP `Referer` header to third party | No — Referer only carries the page URL | No |
| Browser address bar / history | No — only page URLs go there | No |

**Where the token does NOT leak (with rationale):**

1. **Third-party origins.** The URL patcher has an explicit same-origin
   guard in `shouldPatchUrl(url)` — the candidate URL is parsed and its
   `origin` is compared against the Jellyfin server's origin captured at
   patch-install time. Foreign URLs that coincidentally match the
   `/Items/{guid}/Images/` regex never receive the token. (This was a
   findings-driven defense — security finding H1 / H3 from earlier
   review rounds.)

2. **Already-authed URLs.** `HAS_KEY_RE` short-circuits when a URL
   already carries `api_key=` (or `ApiKey=`), so native-client URLs that
   include the token via Jellyfin's own SDK don't get double-appended.

3. **Cross-origin image embeds.** Same as (1) — the origin check
   prevents inadvertent token bleed to external image hosts.

4. **HTTPS-protected wire.** Over HTTPS the URL query string is encrypted
   between client and server, same as headers. Over plain HTTP the
   token was already exposed in every `Authorization` header for JSON
   requests — image URLs aren't worse.

**Native clients are unaffected** by the web patcher. AndroidTV's Glide
loader constructs URLs via `ApiClient.getImageUrl()` which already
includes the token. Other native clients (Findroid, Streamyfin,
Swiftfin) use similar SDK-level URL construction.

**If a user wants to invalidate any exposed session token immediately:**
Dashboard → Devices → revoke the affected device. New navigations will
re-authenticate with a fresh token.

## Contact

For security concerns that don't constitute a vulnerability, you can:
- Open a regular GitHub issue
- Start a discussion in GitHub Discussions
- Contact the maintainers directly

Thank you for helping keep Jellyfin Enhanced secure!
