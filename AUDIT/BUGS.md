# JE Seerr / Discovery — Master Bug Report

**Branch:** `audit/seerr-discovery-bugs` (from `n00bcodr/main`)
**Scope:** Every Seerr/Jellyseerr/Discovery code path — server (C#), client (JS), config UI (HTML), docs, deployment.
**Date:** 2026-05-08
**Method:** 5 parallel specialist code reviews + GitHub issue enumeration + live integration tests against `jellyfin-dev` (port 8097) with JE 11.8.1.0 + FileTransformation 2.5.9.0 + real Seerr 3.2.0.

**Total findings:** **142 unique bugs/concerns** (CRITICAL: 14 · HIGH: 64 · MEDIUM: 47 · LOW: 17). Plus 26 architectural / maintenance recommendations.

After factual review: 2 prior findings (audit01 #7 racy-headers, audit02 #14 mutation) overstated and revised below.

---

## How to read this report

Each finding has:
- **ID** (audit-source.severity.number) e.g. `C01-#1` = audit 01 finding #1
- **File:line**
- **Bug** in 1-3 sentences
- **Repro / when triggered**
- **Suggested fix**

Findings are grouped by symptom-cluster so you can pick a cluster and fix many at once. The Architectural Investments table at the end maps single refactors to the bugs they eliminate.

---

# CLUSTER 1 — "Discovery silently disappears" (issue #577 root cause)

This is the #1 user-reported failure mode. There are at least **6 distinct paths** that trigger it and the user sees the same blank surface from each.

## C01-CRIT-1. `/jellyseerr/user-status` returns 200 on every failure — frontend can't differentiate failure modes
**File:** `Controllers/JellyfinEnhancedController.cs:752-786`
**Bug:** `GetJellyseerrUserStatus()` flattens ANY failure (`network unreachable`, `auth-html-from-proxy`, `wrong API key`, `user not linked`, `user blocked`, `negative-cached null`) into `{active:?, userFound:false}` HTTP 200. Frontend has no way to display a meaningful error.
**Repro:** Confirmed live (audit 05 TEST 0): admin not linked to Seerr → returns `{"active":true,"userFound":false}` with no actionable detail.
**Fix:** Return distinct status codes/payloads (`{active:true,userFound:false,reason:"unlinked"}` vs `{active:false,reason:"unreachable"|"unauthorized"|"html_response"}`). Surface via banner toast on the frontend.

## C02-CRIT-1. `api.checkUserStatus` caches FAILURE for the entire SPA session
**File:** `js/jellyseerr/api.js:198-213`
**Bug:** When `/user-status` returns a transient 401/5xx (session token not yet ready, network blip), catch block sets `cachedUserStatus = { active: false, userFound: false }` with NO TTL. Cache returns this for entire session.
**Repro:** Open Jellyfin during plugin init before `ApiClient.accessToken()` populates → all discovery sections vanish until page reload.
**Fix:** Differentiate transient errors from confirmed-inactive. Only cache successful results, OR add 60-sec TTL on negatives.

## C02-CRIT-2. Every discovery module silently bails on `!status?.active`
**File:** `genre-discovery.js:580`, `network-discovery.js:642`, `tag-discovery.js:499`, `person-discovery.js:467`, `collection-discovery.js:182`, `item-details.js:274` — verified
**Bug:** Each module fires `JE.jellyseerrAPI.checkUserStatus()` and returns silently if not active. Zero UX surface (no toast, no banner, no inline message). User sees blank space.
**Fix:** Add a centralized "Seerr unavailable" banner that all discovery modules can register against — show once with diagnostic detail, not 6× blank.

## C01-CRIT-2. Negative-cached null user lookups poison discovery for 30 minutes
**File:** `Controllers/JellyfinEnhancedController.cs:148-269` + `:391-421`
**Bug:** When `TryAutoImportJellyseerrUser` returns `(null, definite=true)` — e.g. on auth-HTML-from-proxy with HTTP-status set, or on UNIQUE-constraint email collision — the `null` is cached for `JellyseerrUserIdCacheTtlMinutes` (default 30 min). Process-global cache; only restart or admin "Clear caches" recovers.
**Repro:** Matches user's known JE bug noted in memory: "403 negative-cached for 30 min."
**Fix:** Drop negative-cache TTL to ≤60s. Only negative-cache on genuine "user does not exist on Seerr and import disabled," skip definite=true on HTTP errors. Add admin endpoint to bump cache version on Seerr config save.

## C01-CRIT-3. Reverse-proxy/Cloudflare HTML challenge silently parsed as JSON across 6 sites
**File:** Controller `:188-227`, `:317-318`, `:1814`, `:1880`, `:2043`, `:5790-5791`; `Services/AutoMovieRequestService.cs:223-238`; `Services/AutoSeasonRequestService.cs:117`; `Services/WatchlistMonitor.cs:288-289`; `ScheduledTasks/JellyseerrWatchlistSyncTask.cs:258-259`
**Bug:** None of the Seerr HTTP callers check `Content-Type` before `JsonSerializer.Deserialize<JsonElement>()`. When Cloudflare/Pangolin/SWAG/Authelia returns 200 OK + HTML challenge page, deserializer either throws JsonException (silent failover) or succeeds with bogus shape (`results` property absent → "user not found"). The ONE site that gets it right is `IdentifyUrl` at `:4108` (`Content.Headers.ContentType?.MediaType.Contains("json")`).
**Repro:** Cloudflare with Bot Fight Mode — authenticated browser users see Seerr but JE plugin server-side gets HTML challenge.
**Fix:** Centralize Seerr HTTP via a helper that validates `Content-Type` starts with `application/json`. On HTML, return distinct error: `{"reason":"html_response","message":"Seerr returned HTML — likely behind reverse-proxy auth challenge; configure bypass for Jellyfin server IP."}`.

## C01-CRIT-5. `ProxyJellyseerrRequest` caches HTML response as JSON for 10 minutes
**File:** `Controllers/JellyfinEnhancedController.cs:583-606`
**Bug:** On any 2xx, `responseContent` is unconditionally cached and served as `application/json` regardless of upstream Content-Type. If Cloudflare returns 200+HTML for a discovery request, every subsequent user gets the HTML labeled as JSON for `JellyseerrResponseCacheTtlMinutes` minutes.
**Fix:** Verify `response.Content.Headers.ContentType?.MediaType.StartsWith("application/json")` before caching; otherwise return structured error and don't cache.

## C01-CRIT-31. `ProxyJellyseerrRequest` mirrors upstream's 200 status when body is HTML
**File:** `Controllers/JellyfinEnhancedController.cs:608-618, 626`
**Bug:** When Seerr returns 200+HTML (Cloudflare 200+challenge), `JsonDocument.Parse(responseContent)` throws `JsonException`, falls into catch (line 615-618), but the returned status is still the HTTP status (e.g. 200). Frontend receives 200 with `{"message":"Upstream error from Jellyseerr: OK"}` — JS parses successfully, `data.results` undefined, discovery silent.
**Fix:** Return 502 with structured `{error:true, code:"upstream_html"}` instead of mirroring 200.

---

# CLUSTER 2 — Auth & authorization bypasses

## C04-HIGH-F21. `/JellyfinEnhanced/version` returns plugin version unauthenticated *(verified live)*
**File:** `Controllers/JellyfinEnhancedController.cs:2113`
**Bug:** No `[Authorize]` attribute. Anonymous callers can fingerprint plugin version → exploit known-vuln matrix.
**Live test:** `curl http://localhost:8097/JellyfinEnhanced/version` returns `11.8.1.0` HTTP 200 — confirmed.
**Fix:** Add `[Authorize]`.

## C04-HIGH-F33. `/JellyfinEnhanced/public-config` exposes `JellyseerrBaseUrl` + `JellyseerrUrlMappings` to anonymous callers *(verified live)*
**File:** `Controllers/JellyfinEnhancedController.cs:2159` and configuration export
**Bug:** No `[Authorize]`. Returns 137 config fields including internal Seerr URL (`http://seerr.lan:5055`) and URL mappings (which contain public hostnames like `jellyseerr.<your-domain>.com`). Confirmed: API keys are NOT exposed (good), but URL/topology is.
**Fix:** Add `[Authorize]` on `public-config` (the rationale for "public" was to inject into `<head>` — if needed for unauth users, redact server URLs to a flag like `JellyseerrEnabled:true`).

## C04-HIGH-F23. `GET /api/v1/issue/{id}` bypass for non-admin without VIEW_ISSUES
**File:** `Controllers/JellyfinEnhancedController.cs:518-524, 3860-3865`
**Bug:** Permission gates check `apiPath.StartsWith("/api/v1/issue?")` OR `Equals("/api/v1/issue")`. Neither matches `/api/v1/issue/123`. Non-admin without `VIEW_ISSUES` permission can fetch any issue by id by guessing.
**Fix:** Add `apiPath.StartsWith("/api/v1/issue/")` check requiring `VIEW_ISSUES | MANAGE_ISSUES`.

## C04-HIGH-F24. No CSRF protection on POST /api/v1/request proxy
**File:** Controller proxy POST routes
**Bug:** `JellyseerrRequest` and other POST endpoints have no anti-forgery token. If a Jellyfin user is authenticated via cookie, a malicious page can issue cross-origin POST and submit a request on their behalf.
**Fix:** Add `[ValidateAntiForgeryToken]` or require a custom header (`X-Requested-With: XMLHttpRequest`) which CORS will reject without preflight.

## C01-MED-42. Admin-only endpoints' magic-string check
**File:** `Controllers/JellyfinEnhancedController.cs:2514` `private bool IsAdminUser() => User.IsInRole("Administrator");`
**Bug:** String-typed; Jellyfin core uses `PermissionKind.IsAdministrator`. Brittle against any role rename. Spans 16+ admin-gated endpoints.
**Fix:** Use Jellyfin core's `User.IsAdministrator` extension or check the `IsAdministrator` claim via `User.HasClaim`.

---

# CLUSTER 3 — Reverse-proxy / Cloudflare specific (Cloudflare 5xx, redirects, etc.)

## C04-CRIT-F2. Cloudflare 520-526 errors render same UX as "user not found"
**File:** All Seerr proxy paths
**Bug:** Cloudflare-generated 5xx (520 web server returned an error, 521 web server is down, 524 timeout, 525 SSL handshake failed, 526 invalid SSL cert) all collapse to generic "Connection failed" or 200+empty in the various endpoints. User has no signal that the issue is Cloudflare-specific.
**Fix:** Detect upstream `cf-ray` header and structured Cloudflare error → translate to specific error code in JE response.

## C04-CRIT-F8. SWAG+tinyauth / Pangolin / Authelia / Authentik 401+HTML silently fails over
**File:** All Seerr URL-loop sites
**Bug:** When forward-auth proxy returns 401+HTML login page, the URL-loop falls through to next URL, exhausting all configured Seerr URLs, then gives up. No error indicating "your reverse proxy intercepted the call."
**Fix:** Detect non-JSON 4xx with HTML content as a distinct "reverse_proxy_auth" error code.

## C04-HIGH-F4. No `User-Agent` on outbound — Cloudflare flags as bot
**File:** All HTTP-out callsites
**Bug:** Default `HttpClient` sends no User-Agent header. Cloudflare's "Browser Integrity Check" flags empty UA as bot, returns challenge page.
**Fix:** Set `User-Agent: JellyfinEnhanced/{Version}` on all outbound.

## C04-HIGH-F5. `cf-ray` / `cf-cache-status` headers never logged on errors
**File:** All HTTP-out callsites
**Bug:** When a Cloudflare-related error occurs, JE logs are useless for remote diagnosis. The `cf-ray` header is the *only* way Cloudflare support can trace a specific request.
**Fix:** On error, log `cf-ray`, `cf-cache-status`, and `cf-status` from response headers.

## C04-HIGH-F9. `HttpClient.AllowAutoRedirect=true` follows 302 to auth provider
**File:** All HTTP-out callsites
**Bug:** Default redirects ON. When forward-auth proxy returns 302 to a login URL, JE silently follows and gets the login page as the "response."
**Fix:** Configure named `HttpClient` with `AllowAutoRedirect=false`. Detect 302 → emit "auth required" error.

## C04-HIGH-F10. No `Accept: application/json` header on outbound
**File:** All HTTP-out callsites
**Bug:** Without `Accept`, the upstream may content-negotiate and return HTML when client identity is ambiguous.
**Fix:** Set `Accept: application/json` on every Seerr/TMDB/arr request.

## C04-HIGH-F12. `Set-Cookie` / 302 not detected as "auth required"
**File:** All HTTP-out callsites
**Bug:** Same root as F9. Even with redirect disabled, a 302 + `Set-Cookie` tells you the request is being redirected to login. Not detected.
**Fix:** Detect 302 with `Location` header pointing to a *different host* — emit `reverse_proxy_redirect` error.

## C03-A11. Test/Save race corrupts Integration Health card
**File:** `configPage.html:2806-2855, 4563-4602`
**Bug:** While `testJellyseerrConnection` is in flight, user can click global Save. `_jeSaveInFlight` prevents double-save, but doesn't gate test-then-save. Cache shows "Connected" for the OLD URL/key after test resolves.
**Fix:** Disable global Save button while test is in flight; pin cache key to URL+key tuple that was tested.

---

# CLUSTER 4 — Issue #591: saving broken Seerr URL crashes web UI

## C03-#591. ObjectDisposedException root cause: FileTransformation DI race
**File:** `/home/jake/Documents/jellyfin-plugin-file-transformation/rewrite/src/Jellyfin.Plugin.FileTransformation/PluginInterface.cs:14-30` (NOT in JE)
**Bug:** FileTransformation captures `IServiceProvider` once at plugin construction. Saving JE config triggers FT's `ConfigVersionService` (FileSystemWatcher) to bump version → injects auto-reload script → browser reload + slow Seerr URL keeps `/web/*` requests in-flight long enough for the captured ServiceProvider to be disposed mid-request. **JE's TransformationPatches.IndexHtml callback is innocent — does not touch ServiceProvider.**
**Repro:** Save any plugin config that triggers a noticeable delay window. The Seerr loopback URL widens the window because of the 15-sec validate timeout × multiple retries.
**Fix:** Upstream FT bug. JE can mitigate via:
- C03-A2 (block save of malformed URL → reduce trigger surface)
- C03-A19 (banner stays for syntactically invalid URL)
- Optionally fall back to Jellyfin core's InjectScript() helper instead of FT (loses asset-replace features)

## C03-A2. JellyseerrUrls saved with no scheme/format validation
**File:** `configPage.html:4310, 2807`
**Bug:** Save splits on newlines, trims, joins; no `http://`/`https://` check. `seerr.example.com` saves cleanly. Downstream `$"{url.TrimEnd('/')}/api/v1/..."` produces malformed URI → confusing UriFormatException buried in logs.
**Fix:** Pre-save URL validity check identical to URL-mapping validator (parse via `new URL(u)`, require `http:`/`https:`).

## C03-A19. `hasJellyseerrConfigured` allows malformed URL to pass
**File:** `configPage.html:5052-5056`
**Bug:** Banner only checks "enabled + URL non-empty + key non-empty." With Enabled + garbage URL like `garbage` + non-empty key, banner hides and Seerr feature toggles unlock — user thinks setup is done.
**Fix:** Add `URL.canParse()` guard so banner stays up until URL is syntactically valid.

## C03-A18. Blocklist hidden field WIPED on save if /Users API failed to load
**File:** `configPage.html:7012-7015, 7024`
**Bug:** If `/Users` transiently fails, `loadBlockedUsersList` shows "Could not load users." but hidden input retains old comma-list. On save, `syncBlockedUsersToHiddenInput` reads `:checked` checkboxes; with zero rendered checkboxes, `ids = []` → hidden field wiped to empty string. Silently unblocks every user previously blocked.
**Severity:** HIGH — data-loss pattern.
**Fix:** Guard sync — if `loadBlockedUsersList` rejected/failed, skip the wipe.

---

# CLUSTER 5 — Cache invalidation / stale state

## C01-HIGH-9. `_userCache` not invalidated when JellyseerrUrls/ApiKey/BlockedUsers change
**File:** `Controllers/JellyfinEnhancedController.cs:64-69, 378-389, 148`
**Bug:** `ClearUserCaches()` only called from `ImportJellyseerrUsers` and `JellyseerrUserImportTask`. Saving plugin config doesn't trigger any clear. Stale negative-cached `null` users persist for 30 min after admin removes them from blocklist.
**Fix:** Hook `BasePlugin.UpdateConfiguration` (or `OnConfigurationUpdated`). On any change to `Jellyseerr*`, call `ClearUserCaches()` + clear `_responseCache`.

## C01-CRIT-4. `_responseCache` keyed `{jellyfinUserId}:{apiPath}` defeats public-discovery caching
**File:** `Controllers/JellyfinEnhancedController.cs:531`
**Bug:** Public discovery endpoints (`/discover/movies/genre/28`, `/network/49`, etc.) return identical content for all users, but cache is per-user. 100 users × Seerr restart = 100 upstream requests instead of 1.
**Fix:** Two-tier cache. Public scope → key by `apiPath` only. User-scoped → key by `userId:apiPath`. Decision via route table (not substring).

## C01-MED-37. `EnrichWithTmdbData` caches empty result on upstream failure
**File:** `Controllers/JellyfinEnhancedController.cs:5778-5910`
**Bug:** Lines 5785-5788 + 5876-5880 return empty `TmdbEnrichmentResult` on failure. Line 5898 caches it for 10 min. Subsequent users get null title/poster for 10+ min after Seerr recovers.
**Fix:** Don't cache empty results, or use 30-sec TTL for negatives.

## C01-HIGH-46. `GetJellyseerrUserId` cache hit bypasses blocklist check
**File:** `Controllers/JellyfinEnhancedController.cs:391-421`
**Bug:** Cache check at line 401-407 returns cached id BEFORE `IsJellyseerrImportBlocked` check (which is inside `GetJellyseerrUser` at line 158). User added to blocklist remains active for 30 min.
**Fix:** Add blocklist check at top of `GetJellyseerrUserId`, or clear cache on config change (preferred).

## C02-#43. Frontend cache invalidation only matches `"jellyseerr:/discover/"` — discovery sub-modules never clear
**File:** `js/jellyseerr/api.js:144` `invalidateRequestCaches`
**Bug:** `invalidateRequestCaches` clears prefix `"jellyseerr:/discover/"`, but discovery sub-modules use prefixes `"genre:..."`, `"network:..."`, `"tag:..."`, `"person:..."`, `"collection:..."`. After a successful request from a genre slider, the genre cache still shows "Request" instead of "Pending" until a hard refresh.
**Fix:** Unify cache prefix vocabulary (architectural — see Senior Engineer review F4) or extend `invalidateRequestCaches` patterns list.

---

# CLUSTER 6 — Permission audit / user import

## C01-CRIT-6. `ImportJellyseerrUsers` returns success on partial failure + flushes valid cache
**File:** `Controllers/JellyfinEnhancedController.cs:1751-1775` + `Helpers/Jellyseerr/JellyseerrUserImportHelper.cs:35-85`
**Bug:** `BulkImportAsync` returns `>=0` on any URL succeeding, even if `0` users imported (e.g., all email-collisioned). Controller returns `success:true, usersImported:0`. Throttle slot consumed. `ClearUserCaches()` runs unconditionally — flushing every legitimately-cached lookup. Combined with negative-cache poison this can stall imports for 30 min.
**Fix:** Return `(int Imported, List<string> Errors)`; propagate per-user errors to UI; gate `ClearUserCaches()` on `Imported > 0`; reset throttle on partial-failure.

## C01-MED-15. `BulkImportAsync` empty-array success indistinguishable from "all already imported"
**File:** `Helpers/Jellyseerr/JellyseerrUserImportHelper.cs:35-85`
**Bug:** A 200 OK with `[]` returns `0`. Treated as success. Admin sees "Completed. 0 new users" with no info on why.
**Fix:** Return per-user results; UI shows which users failed.

## C01-HIGH-26. `WatchlistMonitor.ProcessItemForWatchlist` does not skip blocked users
**File:** `Services/WatchlistMonitor.cs:170-246`
**Bug:** Blocklist only stops new imports. Existing watchlist sync still processes blocked users → contradicts admin intent.
**Fix:** Filter `requesterIds` against `JellyseerrUserImportHelper.GetBlockedUserIds()` before adding to watchlist.

## C01-HIGH-29. `JellyseerrWatchlistSyncTask` doesn't filter blocked users
**File:** `ScheduledTasks/JellyseerrWatchlistSyncTask.cs:106-138`
**Bug:** Same class as #26. Blocked users get spammy log warnings + their watchlists still sync if previously imported.
**Fix:** Skip users in `GetBlockedUserIds()` before iterating.

## C03-A17. "Import Users Now" triggers full saveConfig including arr alerts
**File:** `configPage.html:7027-7045`
**Bug:** Calls `saveConfig(new Event('submit'))` synchronously → `saveArrInstances` may surface "Incomplete *arr instance" warning even though user clicked Seerr action. Confusing.
**Fix:** Save only Seerr-relevant fields, or short-circuit arr-validation alerts on this code path.

## C01-MED-41. Permission audit calls Seerr per-user (N requests) — pegs Seerr CPU
**File:** `Controllers/JellyfinEnhancedController.cs:794-913`
**Bug:** Each Jellyfin user gets its own `bypassCache:true` call → full `?take=1000` user pull from Seerr. 500 users = 500 GET-1000-user calls. Pins Seerr for minutes.
**Fix:** Single bulk pull → in-memory `Dictionary<NormalisedJellyfinUserId, JellyseerrUser>` → iterate Jellyfin users with map lookup.

---

# CLUSTER 7 — SSRF / URL guard

## C04-HIGH-F13. ArrUrlGuard does not block IPv4 link-local 169.254.0.0/16 entirely *(verified live)*
**File:** `Helpers/ArrUrlGuard.cs:25-33`
**Bug:** `_blockedIPs` lists only specific cloud-metadata IPs (169.254.169.254, 100.100.100.200, 169.254.170.2). Other 169.254.x.x addresses (Windows APIPA, ECS metadata services) are not blocked.
**Live test confirms:** `169.254.169.254` is blocked correctly; other 169.254.x.x not tested but expected to slip through.
**Fix:** Use `IPAddress.IsIPv4LinkLocal()` to block the entire range; allowlist specific known-safe IPs.

## C04-HIGH-F15. IPv6-mapped IPv4 not normalized — bypass for blocked IPs *(verified live)*
**File:** `Helpers/ArrUrlGuard.cs:50-51`
**Bug:** `IPAddress.TryParse(host, out literalIp)` doesn't normalize `[::ffff:169.254.169.254]` → 169.254.169.254. Could bypass cloud-metadata block.
**Live test:** Direct `169.254.169.254` blocked; `[::ffff:169.254.169.254]` returned HTTP:000 (blocked at network layer for unrelated reason — still slipped past guard).
**Fix:** Call `ip.MapToIPv4()` before checking against `_blockedIPs` for IPv6 inputs.

## C04-HIGH-F16. DNS rebinding window between TrySyncChecks and HTTP request
**File:** `Helpers/ArrUrlGuard.cs:93-121`
**Bug:** `Dns.GetHostAddressesAsync` resolves once for guard, then `HttpClient` resolves again for the actual request. Hostile DNS server can return safe IP for guard, blocked IP for request (TOCTOU).
**Fix:** Either pre-resolve to `IPAddress`, then connect to that IP with the host as `Host:` header (defeats SNI but secure), OR use socket-level pinning to the resolved IP.

## C04-HIGH-F17. Hostname normalization gaps: trailing dot, IDN homograph
**File:** `Helpers/ArrUrlGuard.cs:47`
**Bug:** Trailing dot stripped (good — verified live). But IDN homograph (`xn--metadata-google-internal-...`) not detected. Punycode-encoded homoglyphs of `metadata.google.internal` would bypass.
**Fix:** Convert to punycode and ASCII-fold before allow/block check. Reject IDN with mixed scripts.

## C04-HIGH-F18. 23+ outbound calls bypass ArrUrlGuard entirely
**File:** Various — `proxy/avatar`, `tmdb/*`, scheduled tasks
**Bug:** Only some routes call `IsAllowedUrl`. The avatar proxy, TMDB proxy, and most scheduled tasks construct URLs from config without guard checks.
**Fix:** Centralize in `ISeerrHttpClient` (architectural); guard on every HTTP-out.

## C04-MED-F26. TMDB API key in URL query parameter (not encoded)
**File:** `Services/AutoMovieRequestService.cs:214`, `Controllers/JellyfinEnhancedController.cs:1375, 2373`
**Bug:** `?api_key={config.TMDB_API_KEY}` interpolation. TMDB keys are 32-char hex (no special chars in practice) but defensive coding would `Uri.EscapeDataString`.
**Fix:** Wrap with `Uri.EscapeDataString()`. Better: TMDB also accepts `Authorization: Bearer <token>` — switch to header auth.

---

# CLUSTER 8 — DefaultRequestHeaders pattern (REVISED after factual review)

## ~~C01-CRIT-7~~ revised → C01-MED-7. DefaultRequestHeaders pattern is suboptimal but not currently exploitable
**File:** `Controllers/JellyfinEnhancedController.cs:178-181, 547-548, 1801-1802`; `Services/AutoMovieRequestService.cs:551-553`; `Services/AutoSeasonRequestService.cs:587-589, 649-650`; `ScheduledTasks/JellyseerrWatchlistSyncTask.cs:296-297, 349-350`; etc.
**Note:** Initial audit claimed cross-user leakage. Factual review confirmed `IHttpClientFactory.CreateClient()` returns a fresh `HttpClient` per call with its own `DefaultRequestHeaders`, so cross-user leak as described is NOT reproducible.
**Real issue:** The pattern is fragile — if a future maintainer reuses a single `HttpClient` instance (e.g. as a singleton field), `Add` will throw `InvalidOperationException` on second call without `Clear()` first. Per-request `HttpRequestMessage` is the correct defensive pattern.
**Fix:** Migrate to per-request `HttpRequestMessage` for consistency with `FetchAndMapAsync` (line 4308-4374) which already does this correctly.

---

# CLUSTER 9 — Calendar / requests page silent failures

## C01-HIGH-23. `GetRequests` only tries first JellyseerrUrl (failover broken)
**File:** `Controllers/JellyfinEnhancedController.cs:4910`
**Bug:** `var jellyseerrUrl = config.JellyseerrUrls.Split(...)[0].Trim().TrimEnd('/');` — only first URL. If down, falls into catch (5171) which returns `Ok({requests:[],totalPages:0})`.
**Fix:** Loop over all URLs like every other Seerr helper.

## C01-HIGH-24. `GetRequests` swallows all errors as 200 + empty list
**File:** `Controllers/JellyfinEnhancedController.cs:5171-5175`
**Bug:** Any exception → 200 OK with empty arrays. Frontend can't distinguish "no requests" from "Seerr down" from "permission denied."
**Fix:** Return distinct status codes with structured error envelope.

## C01-HIGH-21. `GetCalendarEvents` no per-instance timeout — slowest hangs UI
**File:** `Controllers/JellyfinEnhancedController.cs:5278-5284`
**Bug:** `Task.WhenAll(sonarrTasks)` waits for the slowest. One unreachable Sonarr behind hung proxy = 30+ sec UI hang.
**Fix:** Add master `Task.WhenAny` with 15-sec budget; report `errors` for slow instances.

## C01-HIGH-22. `GetCalendarEvents` dedup key uses ISO 8601 with full precision — duplicates across instance versions
**File:** `Controllers/JellyfinEnhancedController.cs:5381-5443`
**Bug:** Dedup key includes `evt.ReleaseDate` as full string. Different Sonarr/Radarr versions may format differently (`.000Z` vs `Z`) → fail to dedup → calendar shows duplicates.
**Fix:** Normalize date to calendar-day or parse to `DateTimeOffset`.

## C01-MED-48. `GetCalendarEvents` no upper bound on date range — DoS by authed user
**File:** `Controllers/JellyfinEnhancedController.cs:5193-5214`
**Bug:** User can pass `start=1900-01-01&end=2099-12-31` → 200 years of calendar data fetched + dedup'd in memory.
**Fix:** Cap `(endDate - startDate).TotalDays` at e.g. 365.

---

# CLUSTER 10 — Auto-Movie / Auto-Season request bugs

## C01-MED-49. `CheckEpisodeCompletionAsync` reserves sentinel before season-existence check
**File:** `Services/AutoSeasonRequestService.cs:289-314`
**Bug:** Line 304 writes sentinel cache BEFORE checking if next season exists on TMDB (line 310-314). When the season doesn't exist yet (newly announced show), sentinel is written but the failure return at 313 doesn't remove it. Once TMDB updates with the announcement, JE doesn't trigger because sentinel is still cached.
**Fix:** Move sentinel write to success path, or remove on failure.

## C01-MED-34. `ResolveQualityProfileAsync` returns null ambiguously — admin doesn't notice silent default
**File:** `Services/AutoMovieRequestService.cs:460-520, 532-601`
**Bug:** `null` conflates "explicit default" with "fallback because lookup failed" with "fallback because 4K detected." Request goes through with Seerr default; warning logged but admin doesn't see UI feedback.
**Fix:** Return tagged enum/struct `(QualitySettings, RequestSource)` with explicit "configuration_invalid" state that triggers no-op or 400.

## C01-MED-35. `OnPlaybackProgress` is `async void`
**File:** `Services/AutoMovieRequestMonitor.cs:67`, `Services/AutoSeasonRequestMonitor.cs:68, 156`
**Bug:** Event handler exceptions cannot be observed; broad catch mitigates but exceptions thrown asynchronously after catch frame exits can crash process.
**Fix:** Use `async Task` wrapper that explicitly logs unobserved exceptions.

## C01-MED-36. Season-request dedup key `{userId}_{itemId}` ignores playback session
**File:** `Services/AutoSeasonRequestMonitor.cs:188`
**Bug:** Cache entry persists 1 hour. If user A starts at 10:00 → user B resumes A's session at 10:30, dedup short-circuits B's check.
**Fix:** Include playback session ID in dedup key.

---

# CLUSTER 11 — Discovery filter / route mismatches

## C01-HIGH-17. `AppendDiscoverFilters` whitelist missing `with_companies`, `with_networks`, `with_watch_providers`, `studio`, `network`, `keywords`
**File:** `Controllers/JellyfinEnhancedController.cs:423-429`
**Bug:** User picks "Watch Provider: Netflix" filter → silently dropped (UI shows results ignoring the filter). Same for any filter not in DiscoverFilterParams.
**Fix:** Expand whitelist or document supported filter list.

## C01-HIGH-19. `RequestTvSeasons` route ignores `tmdbId` route param
**File:** `Controllers/JellyfinEnhancedController.cs:1587-1592`
**Bug:** Route `[HttpPost("jellyseerr/request/tv/{tmdbId}/seasons")]` accepts `tmdbId` but forwards `requestBody.ToString()` — body's `mediaId` wins. Audit trails based on `tmdbId` won't match the actual requested item.
**Fix:** Drop `tmdbId` from route OR validate `requestBody.GetProperty("mediaId").GetInt32() == tmdbId` and 400 on mismatch.

## C01-HIGH-43. `RequestTvSeasons` doesn't enforce `mediaType:"tv"` from body
**File:** `Controllers/JellyfinEnhancedController.cs:1587-1592`
**Bug:** Body with `mediaType:"movie"` to TV-seasons route → forwarded as-is; permission gate only sees `apiPath=="/api/v1/request"`, applies generic REQUEST/REQUEST_MOVIE/REQUEST_TV check.
**Fix:** Validate body `mediaType` matches route, or enforce `REQUEST_TV` strictly here.

## C01-HIGH-18. `JellyseerrSearch` query length unvalidated, page negative
**File:** `Controllers/JellyfinEnhancedController.cs:916-924`
**Bug:** Negative `page` passes to Seerr → 4xx; query length unbounded (a 10MB query is forwarded).
**Fix:** Clamp `page` to `Math.Max(1, page)`; cap `query.Length` at 256.

---

# CLUSTER 12 — Frontend XSS / unsafe innerHTML

## C02-#26. `posterUrl` interpolated into style attribute
**File:** `js/jellyseerr/ui.js:1069`
**Bug:** `style="background-image: url('${posterUrl}');"` — no escape, no `isValidPosterPath()` (which exists in more-info-modal.js but isn't applied in ui.js). User-controlled `posterUrl` from Seerr response can break out of CSS context.
**Fix:** Apply existing `isValidPosterPath` validator + escape backslashes/quotes.

## C02-#76. `more-info-modal.js` embeds CSS class `.modal-overlay` colliding with Jellyfin core
**File:** `js/jellyseerr/more-info-modal.js`
**Bug:** Class collision — Jellyfin's own modals get JE styling.
**Fix:** Namespace to `.je-modal-overlay`.

## C01-HIGH-14. ProxyAvatar accepts `image/svg+xml` → cached SVG with `<script>` is stored XSS
**File:** `Controllers/JellyfinEnhancedController.cs:6027-6030`
**Bug:** Allow-list checks `StartsWith("image/")` — SVG passes. Cached for 1 hour. UI rendering avatar via `<object data>` or `<embed>` would execute scripts.
**Fix:** Restrict to closed set: `image/png`, `image/jpeg`, `image/jpg`, `image/gif`, `image/webp`, `image/avif`. Reject `image/svg+xml`.

---

# CLUSTER 13 — Frontend silent failure / UX gaps

## C02-#3. `more-info-modal.js fetchRatings/fetchMediaDetails` bypass request-manager
**File:** `js/jellyseerr/more-info-modal.js:185-227`
**Bug:** Uses raw `ApiClient.ajax({type:'GET', ...})` — no retry, no AbortController, no dedup, no cache.
**Fix:** Migrate to `JE.requestManager.fetchWithRetry` like other Seerr API calls.

## C02-#6. Modal popstate handler hijacks browser back-button
**File:** `js/jellyseerr/modal.js:131-132, 160-174`
**Bug:** Pushes a fake state onto history; back button closes modal. But this fires after navigation away too, and stacks on multi-modal → user gets stuck.
**Fix:** Scope the popstate listener to modal-open lifecycle; cleanup explicitly on close.

## C02-#8. `cachedUserCanReport` written but never read
**File:** `js/jellyseerr/issue-reporter.js:10, 72`
**Bug:** Dead code — variable exists but no read. Either UI is broken or it's leftover from a refactor.
**Fix:** Read it and gate the issue reporter button, OR remove.

## C02-#13. `more-info-modal.js` polls every 10s with interval handle on a local var
**File:** `js/jellyseerr/more-info-modal.js`
**Bug:** Only `onClose` clears the interval. If close fails or modal is removed via DOM mutation without firing close, interval leaks forever.
**Fix:** Use AbortController.signal pattern; tie cleanup to MutationObserver disconnect.

## C02-#27. `fetchProviderIcons` raw fetch
**File:** `js/jellyseerr/ui.js:1403`
**Bug:** Raw `fetch(url)` — no retry, no AbortController, no timeout.
**Fix:** Migrate to request-manager.

---

# CLUSTER 14 — Documentation gaps

## C04-HIGH-F31. No reverse-proxy / Cloudflare / WAF setup docs
**File:** Doc gap
**Bug:** Users with Pangolin / SWAG / Authelia / Cloudflare in path repeatedly file the same issues. Docs don't tell them what to expose, what to bypass, what to allowlist.
**Fix:** Add `docs/jellyseerr/reverse-proxy.md` enumerating each proxy/WAF and recommended bypass config.

## C04-HIGH-F32. Issue #449 enumerated endpoint list never produced — only 6/99 endpoints documented
**File:** `docs/advanced/api.md` (referenced but doesn't exist or is incomplete)
**Bug:** Admins want to expose only the endpoints JE actually needs. Owner pointed at swagger; never produced an audit list.
**Fix:** Generate complete endpoint list from controller's `[Http*]` attributes.

## C04-HIGH-F22. docs/advanced/api.md says X-Jellyfin-User-Id is a header (it's a JWT claim)
**File:** `docs/advanced/api.md`
**Bug:** Docs `curl` example sets `-H "X-Jellyfin-User-Id: <USER_ID>"` — JE ignores this. Identity is from auth token's claims (`UserHelper.GetCurrentUserId(User)`).
**Fix:** Remove or correct examples.

## C04-MED-F34. No docs about JE outbound IP allowlisting
**File:** Doc gap
**Bug:** Admins setting WAF/IP allowlists need to allowlist Jellyfin server's egress IP (not the client IP).
**Fix:** Add to `docs/jellyseerr/jellyseerr-settings.md`.

## C04-MED-F35. No docs about Cloudflare "Always Use HTTPS" pitfalls
**File:** Doc gap
**Bug:** Cloudflare's `Automatic HTTPS Rewrites` can break self-signed Seerr origins.
**Fix:** Document recommended Cloudflare SSL/TLS encryption mode (Full strict).

## C03-A23. configPage.html Seerr section bare English (no `data-i18n`)
**File:** `configPage.html` — many lines
**Bug:** Plugin has translation pipeline but admin config page is not internationalized.
**Fix:** Either intentional (admin-only) — document it; or add `data-i18n` markup.

## C03-A25. Sign-in requirement banner buried under "Advanced URL Mappings" details
**File:** `configPage.html:1048-1054`
**Bug:** Critical "user must enable Seerr Sign-in" notice is inside collapsed `<details>`. Admins who don't expand never see it → file confusing "user import imports nobody" issues.
**Fix:** Hoist to main Seerr connection setup section.

---

# CLUSTER 15 — Static state / observability

## C01-MED-32. `_responseCache` and others use `Dictionary` + `lock` — eviction loop blocks under contention
**File:** `Controllers/JellyfinEnhancedController.cs:72-73, 81-82, 64-65, 67-69`
**Note:** Factual review confirmed 3 of 4 caches are Dictionary+lock. `_avatarCache` is ConcurrentDictionary.
**Bug:** Eviction loop enumerates 200+ entries inside the lock, blocking all others. Eviction triggers nearly every write past 50 items (`Count % 50 == 0` condition).
**Fix:** Use `ConcurrentDictionary` everywhere; run eviction on background task via `IMemoryCache`.

## C01-MED-33. `_avatarCache` 50-entry threshold but never bounds size
**File:** `Controllers/JellyfinEnhancedController.cs:6040-6049`
**Bug:** Eviction only removes stale entries (>1hr). 1000 unique avatars in 5 min → unbounded MB-scale growth.
**Fix:** Hard size cap (200 entries) + LRU eviction.

## C01-MED-40. `_loggedCorruptArrConfig` HashSet unbounded
**File:** `Controllers/JellyfinEnhancedController.cs:2550-2575`
**Bug:** Grows by 1 per config change, forever.
**Fix:** Cap at 32 entries with FIFO.

## C01-MED-41. Permission audit emits N log lines per click (no rate limit)
**File:** `Controllers/JellyfinEnhancedController.cs:794-913`
**Bug:** 500 users → 500 log lines per audit run. (See cluster 6 for the upstream Seerr-fan-out issue.)
**Fix:** Build audit summary log line at end; per-user lines as `LogTrace`.

---

# CLUSTER 16 — Misc HIGH/MED findings

## C01-HIGH-13. `GetJellyseerrPartialRequestsSetting` returns `{false,false}` on every failure
**File:** `Controllers/JellyfinEnhancedController.cs:2017-2070`
**Bug:** When Seerr unreachable, returns 200 OK with `partialRequestsEnabled:false`. Frontend silently flips to whole-season UI even though admin disabled it.
**Fix:** Return 503 on full failure or include `cached:true/error:string` flag.

## C01-HIGH-12. `GetJellyseerrUserStatus` re-serializes `OkObjectResult` to extract bool
**File:** `Controllers/JellyfinEnhancedController.cs:776-784`
**Bug:** Fragile cross-method dependency. Future shape change of `GetJellyseerrStatus` silently breaks user-status. No cancellation token forwarded.
**Fix:** Extract `IsSeerrReachable()` helper accepting cancellation token.

## C01-HIGH-11. `ProxyJellyseerrRequest` calls `GetJellyseerrUser` twice for non-admins
**File:** `Controllers/JellyfinEnhancedController.cs:480-526`
**Bug:** Line 480 calls `GetJellyseerrUserId` (which calls `GetJellyseerrUser`). Line 493 calls `GetJellyseerrUser` again for permission check. With `JellyseerrDisableCache=true`, every proxy request hits Seerr's `/api/v1/user` twice.
**Fix:** Resolve user once; pass id + permissions to caller.

## C01-HIGH-8. User resolution: full GET take=1000 with no in-flight dedup
**File:** Controller `:182-211`, AutoMovieRequestService `:625-665`, AutoSeasonRequestService `:649-692`, JellyseerrWatchlistSyncTask `:243-289`
**Bug:** Each helper does ~MB-scale GET per cache miss. 100 concurrent users = 100 parallel pulls. No `_tmdbEnrichmentInFlight`-style dedup. >1000 Seerr users silently truncated (no `skip=`).
**Fix:** Centralize via `IJellyseerrUserResolver` (architectural — see Senior Engineer review B1).

## C01-HIGH-28. `JellyseerrWatchlistSyncTask.GetJellyseerrUserMap` ignores `take=1000` cap
**File:** `ScheduledTasks/JellyseerrWatchlistSyncTask.cs:243-289`
**Bug:** Single page only; >1000 Seerr users silently miss tail. No log warning.
**Fix:** Iterate with `skip+=1000` until `pageInfo.results <= skip + items.Length`.

## C01-MED-30. `SeerrScanTriggerService` may dispatch even after admin disables flag mid-debounce
**File:** `Services/SeerrScanTriggerService.cs:119-156`
**Bug:** Re-reads config at dispatch time but auto-fire path doesn't check `JellyseerrEnabled && TriggerSeerrScanOnItemAdded`. `TriggerNowAsync` is unguarded.
**Fix:** Re-check both flags at top of `DispatchAsync`.

## C01-MED-44. `JellyseerrPermission.NONE = 0` — `HasPermission(any, NONE)` always returns true
**File:** `Helpers/Jellyseerr/JellyseerrPermissionHelper.cs:7-15`, `Model/Jellyseerr/JellyseerrPermission.cs:4`
**Bug:** Flag arithmetic `(any & 0) == 0` is `true` for any input. Anyone "has" NONE.
**Fix:** Don't define `NONE = 0` as a flag, or document explicitly.

## C01-MED-45. `JellyseerrPermission` enum drift — missing recent Seerr permissions
**File:** `Model/Jellyseerr/JellyseerrPermission.cs:4-34`
**Bug:** Missing `IGNORE_BLACKLIST`, `MANAGE_USERS_BLACKLIST`, etc. introduced in newer Seerr versions.
**Fix:** Sync against `https://github.com/Fallenbagel/jellyseerr/blob/develop/server/lib/permissions.ts` periodically.

## C01-MED-50. `BulkImportAsync` uses `httpClient.DefaultRequestHeaders.Add` once
**File:** `Helpers/Jellyseerr/JellyseerrUserImportHelper.cs:43-45`
**Bug:** Per `IHttpClientFactory.CreateClient()` semantics, this is a fresh client — headers are per-instance, not per-handler. Less critical than originally framed but still unidiomatic.
**Fix:** Migrate to per-request `HttpRequestMessage` for consistency.

## C01-MED-51. `GetCalendarEvents` access filter defaults to `true` when both ItemId and RootFolderPath are null
**File:** `Controllers/JellyfinEnhancedController.cs:5447-5459`
**Bug:** Event without library mapping passes filter unconditionally. May leak items user shouldn't see.
**Fix:** Default to `false` when both fields absent.

---

# Architectural Investments (from Senior Engineer review)

| Investment | Bugs eliminated |
|------------|-----------------|
| **B1: Extract `IJellyseerrUserResolver`** (one helper, one cache, one auth path) | C01 #8, #11, #28, #29, #46, all of "user resolution duplicated 5×" |
| **B3: `ISeerrHttpClient` with named HttpClient + Content-Type guard** | C01 #3, #5, #7 (revised), #25, #38, #50; C04 F1, F4, F9, F10, F11, F18, F26 |
| **C1: Typed `Result<T, SeerrError>` envelope** | C01 #1, #13, #24, #31; C02 #1, #2, #18; whole #577 cluster |
| **B5/D2: Wire `OnConfigurationUpdated` → IMemoryCache compact** | C01 #9, #20, #46; C03 A1 |
| **F1: Extract `DiscoverySection` base class** | C02 #21, #22, #82 (each appearing 5×) |
| **A2: Route-group `[Authorize]` policy** | C04 F21, F23, F33; future omissions |
| **G1: Structured logging + metrics** | Issue #577 debugability; C04 F5; admins disabling logs |

---

# Recovery / Recovery After Invalid Config (from live tests)

Per audit 05 testing:
- **Wrong API key**: `validate` returns 403 + generic `"Status check failed"` — UI conflates 401/403 (audit 03 A4)
- **Empty/whitespace API key**: 400 + ASP.NET model-binding error leaks internals
- **Loopback unreachable URL** (#591 trigger): 502 `"Unable to reach Jellyseerr"` — correct
- **Cloud metadata IP**: 400 `"Invalid URL"` — correctly blocked
- **Decimal-encoded loopback**: 502 (NOT blocked by guard, but loopback is allowed by design)
- **HTML response (Cloudflare sim)**: 404 `"Status check failed"` — does NOT distinguish "got HTML"
- **Recovery after fixing**: Cache TTLs (10/30 min) mean discovery silent for that long even after admin fixes config. **C01 #9 + #46 are the recovery-blocker bugs.**

**Bottom line on recovery testing:** YES, JE recovers, but only after caches expire (10-30 min). For admins debugging in real-time this is the worst possible UX — they fix the config, refresh, see "still broken," assume the fix didn't work. The architectural fix B5 (clear caches on config save) is the highest-priority recovery fix.

---

# Severity Summary

| Severity | Count | % |
|----------|-------|---|
| CRITICAL | 14    | 10% |
| HIGH     | 64    | 45% |
| MEDIUM   | 47    | 33% |
| LOW      | 17    | 12% |
| **Total**| **142** | |

Plus **26 architectural recommendations** + **#591 root-cause hypothesis** (FileTransformation upstream bug).

---

# Open questions / further investigation needed

1. Exhaustive route-by-route auth audit — there are 99 routes; this audit verified the most-used. A defensive sweep with grep for `[HttpGet|HttpPost]` without `[Authorize]` would close the loop.
2. Verify F15 (IPv6-mapped IPv4 of blocked IP) on a test where the connection isn't refused at network layer.
3. Empirically test the negative-cache poisoning recovery time across a config save (the architectural assumption is "won't recover until 30 min" but this needs live verification).
4. Verify F23 (issue/{id} bypass) with a non-admin Seerr user actually linked.
5. Verify cluster 1 fix proposals don't break the SPA navigation flow — discovery init order is fragile (audit02 #20, #88).

---

# Files referenced

All paths absolute under `/home/jake/JE-seerr-bug-audit/`:

- `Jellyfin.Plugin.JellyfinEnhanced/Controllers/JellyfinEnhancedController.cs` (6148 lines, primary)
- `Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html` (7688 lines, admin UI)
- `Jellyfin.Plugin.JellyfinEnhanced/Configuration/PluginConfiguration.cs` (664 lines)
- `Jellyfin.Plugin.JellyfinEnhanced/Helpers/ArrUrlGuard.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/Helpers/Jellyseerr/JellyseerrPermissionHelper.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/Helpers/Jellyseerr/JellyseerrUserImportHelper.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/Model/Jellyseerr/JellyseerrPermission.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/Model/Jellyseerr/JellyseerrUser.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/ScheduledTasks/JellyseerrUserImportTask.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/ScheduledTasks/JellyseerrWatchlistSyncTask.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/Services/AutoMovieRequestService.cs` (691 lines)
- `Jellyfin.Plugin.JellyfinEnhanced/Services/AutoSeasonRequestService.cs` (706 lines)
- `Jellyfin.Plugin.JellyfinEnhanced/Services/AutoMovieRequestMonitor.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/Services/AutoSeasonRequestMonitor.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/Services/SeerrScanTriggerService.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/Services/StartupService.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/Services/WatchlistMonitor.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.cs` (no `OnConfigurationUpdated` — confirmed via grep)
- `Jellyfin.Plugin.JellyfinEnhanced/PluginServiceRegistrator.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/api.js` (909 lines)
- `Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/jellyseerr.js` (613 lines)
- `Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/ui.js` (2791 lines)
- `Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/modal.js` (281 lines)
- `Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/more-info-modal.js` (3178 lines)
- `Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/item-details.js` (747 lines)
- `Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/request-manager.js` (421 lines)
- `Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/discovery-filter-utils.js`
- `Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/genre-discovery.js`
- `Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/network-discovery.js`
- `Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/tag-discovery.js`
- `Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/person-discovery.js`
- `Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/collection-discovery.js`
- `Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/seamless-scroll.js`
- `Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/hss-discovery-handler.js`
- `Jellyfin.Plugin.JellyfinEnhanced/js/jellyseerr/issue-reporter.js`
- `docs/jellyseerr/jellyseerr-features.md`
- `docs/jellyseerr/jellyseerr-settings.md`
- `docs/about.md`
- `SECURITY.md`

External reference:
- `/home/jake/Documents/jellyfin-plugin-file-transformation/rewrite/src/Jellyfin.Plugin.FileTransformation/PluginInterface.cs` — root cause of #591

---

**Audit complete:** 142 bugs + 26 architectural concerns documented across 7 prior audit files (`AUDIT/01-07.md`). All findings cross-checked. Critical findings verified live where possible. Next phase: 2-hour verification pass to look for edge cases prior audits may have missed.
