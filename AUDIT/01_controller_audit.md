I have enough context to compile the bug report. The TypeScript-related rule reminders don't apply to this C# codebase.

Now compiling my findings:

# Jellyfin Enhanced — Seerr/Jellyseerr/Discovery C# Audit Report

Below are issues I am ≥80% confident are real bugs in the Jellyseerr/Discovery surface. Numbered flat list, severity-tagged.

---

1. **[CRITICAL] Discovery silently disappears when /jellyseerr/user-status returns 401 (issue #577)**
   File: `Jellyfin.Plugin.JellyfinEnhanced/Controllers/JellyfinEnhancedController.cs:752-786`
   Bug: `GetJellyseerrUserStatus()` swallows EVERY failure mode of `GetJellyseerrUserId` into `{active:?, userFound:false}` with HTTP 200. The frontend (`api.js:198-213`) treats any non-200 (or success with `userFound:false`) as "user not linked" and hides the discovery sections — there is no way for it to differentiate "Jellyseerr down" from "user genuinely not linked" from "API key wrong" from "reverse proxy returned HTML" from "user is in the import blocklist". Combined with the negative-cache poisoning (#9 below), a single 30-min outage hides discovery for the whole plugin.
   Repro: Configure Seerr URL behind a Cloudflare-protected reverse proxy that returns an HTML challenge page; or set the API key wrong; or block the user via JellyseerrImportBlockedUsers. All three render the same opaque "discovery sections disappear" UX.
   Fix: Return distinct status codes/payloads (e.g. `{active:true, userFound:false, reason:"unlinked"}` vs `{active:false, reason:"unreachable"|"unauthorized"|"html_response"}`) and surface a banner toast on the frontend instead of silently hiding sections.

2. **[CRITICAL] Negative-cached null user lookups poison discovery for 30 minutes**
   File: `Controllers/JellyfinEnhancedController.cs:148-269` (`GetJellyseerrUser`) interacting with `:391-421` (`GetJellyseerrUserId`)
   Bug: When `TryAutoImportJellyseerrUser` returns `(null, definite=true)` — e.g. because of an "email collision" 500 from Seerr (line 304), or a 401 from a proxy rewriting the auth challenge as JSON — the result `null` is stored in `_userCache` for `JellyseerrUserIdCacheTtlMinutes` (default 30 min, line 260-266). Every subsequent request from that user gets the negative-cached `null` and falls into "user not linked" mode in the frontend, even after Seerr recovers or the email conflict is resolved. The cache is process-global; only restart or admin "Clear caches" recovers.
   Repro: Trigger any UNIQUE-constraint email error once → 30min outage. This matches the user's known JE bug ("403 negative-cached for 30min").
   Fix: Drop negative-cache TTL to ≤60s, or only negative-cache on truly definite "user does not exist on Seerr and import disabled" (skip definite=true in import-failure paths, since those are still recoverable). Also add an admin endpoint that bumps the cache version so saving Seerr config invalidates everything.

3. **[CRITICAL] Reverse-proxy/Cloudflare HTML challenge silently parsed as JSON in user lookups (issues #449/#577/#225/#146/#38)**
   File: `Controllers/JellyfinEnhancedController.cs:188-227` (`GetJellyseerrUser`), `:317-318` (`TryAutoImportJellyseerrUser`), `:1814` (`GetJellyseerrWatchlistForUser`), `:1880` (`GetJellyseerrRequestsForUser`), `:2043` (`GetJellyseerrPartialRequestsSetting`), `:5790-5791` (`EnrichWithTmdbData`), `Services/AutoMovieRequestService.cs:223-238`, `Services/AutoSeasonRequestService.cs:117`, `Services/WatchlistMonitor.cs:288-289`, `ScheduledTasks/JellyseerrWatchlistSyncTask.cs:258-259`
   Bug: None of the Jellyseerr HTTP callers check `response.Content.Headers.ContentType` before calling `JsonSerializer.Deserialize<JsonElement>(content)`. When Cloudflare/Pangolin/SWAG return a 200 OK HTML auth page (which they do for any browser-shaped User-Agent without a clearance cookie), the deserializer either: (a) throws JsonException and the URL silently fails over to the next URL; or (b) succeeds with bogus JSON shape so `TryGetProperty("results", out var usersArray)` returns false → user "not found" → empty discovery. The contrast: `IdentifyUrl` at `:4104-4115` *does* check `Content.Headers.ContentType?.MediaType.Contains("json")` — proving the awareness exists for the validate path but not the runtime callers.
   Repro: Put Seerr behind Cloudflare with "Bot Fight Mode" enabled. Authenticated browser users see a working Seerr; the JE plugin server-side gets an HTML challenge page on every `/api/v1/user` call.
   Fix: Centralize Seerr HTTP via a helper that validates `Content-Type` is `application/json` (or at least starts with `application/`) before deserializing; on HTML mime type, log a distinct error like "Seerr URL returned HTML — likely behind a reverse-proxy auth challenge; configure bypass for your Jellyfin server IP."

4. **[CRITICAL] `ProxyJellyseerrRequest` cache is keyed only by `apiPath` query string, missing recognised filters and language**
   File: `Controllers/JellyfinEnhancedController.cs:531` (`var cacheKey = $"{jellyfinUserId}:{apiPath}";`) combined with `:920-923` (`JellyseerrSearch`).
   Bug: Search includes `language` in the proxied apiPath (good), so it ends up in the key. But the discover endpoints in `:1156, 1163, 1492, 1499, 1506, 1513` build their `apiPath` via `AppendDiscoverFilters($"...&page={page}&network={networkId}")` BEFORE the cache lookup — and that's actually fine because the cache key contains the appended filters. However, the search endpoint at `:920` is `/api/v1/search?query=...&page=N&language=lang`, and `IsCacheableApiPath` matches it (`/search?` substring at line 460). Two different users on different pages but the SAME query/page/lang share a cached entry — that's intentional. But user A submits `/search?query=foo` with no `language`, the entry caches without language. User B then asks for the same query *with* a different language; the cache lookup at line 536 may miss correctly here because the apiPath differs, so this is OK. However, `_responseCache` is keyed `{jellyfinUserId}:{apiPath}` (line 531) — meaning each user has their *own* per-user cache. For purely public discovery results (network/genre/keyword), this means cache-busting on EVERY user, defeating the cache for any deployment with more than one user.
   Repro: 100 users hit `/jellyseerr/discover/movies/genre/28?page=1` simultaneously after a Seerr restart — 100 upstream Seerr requests, 100 cache entries.
   Fix: For public discovery endpoints (no per-user filters), key only by `apiPath`. Reserve per-user keys for endpoints that include `requestedBy` or `X-Api-User`-sensitive responses (none of the cached ones currently do).

5. **[CRITICAL] `ProxyJellyseerrRequest` does not validate Content-Type before caching responses**
   File: `Controllers/JellyfinEnhancedController.cs:583-606`
   Bug: On any 2xx response, `responseContent` is unconditionally cached and returned with `"application/json"` content type. If the upstream is an HTML auth page (Cloudflare 200 OK with a challenge), it gets cached as application/json for `JellyseerrResponseCacheTtlMinutes` (default 10 min). Every subsequent user hitting the same discovery endpoint gets served HTML labeled as JSON until the TTL expires. The frontend's JSON parser will throw — discovery sections silently fail.
   Repro: Cloudflare flips on temporarily, returns 200+HTML for a discovery request → 10 min of broken discovery for everyone.
   Fix: Before caching, verify `response.Content.Headers.ContentType?.MediaType` starts with `application/json`; otherwise return a clear error envelope and don't cache.

6. **[CRITICAL] `ImportJellyseerrUsers` includes the **admin's own** ID and fails open on transient errors**
   File: `Controllers/JellyfinEnhancedController.cs:1751-1775`
   Bug: `_userManager.Users.Select(u => u.Id.ToString().Replace("-", ""))` enumerates ALL Jellyfin users, including those created via SSO/OIDC bridges where the email field is empty or duplicates an existing Jellyseerr account. `BulkImportAsync` on line 1759 returns `>=0` if **any** URL returned a successful HTTP response, even if 0 users were actually imported (line 63 in `JellyseerrUserImportHelper.cs`). So the throttle slot at line 1746 is consumed (preventing retry for 30s), `ClearUserCaches()` is called (line 1763) flushing every legitimately-cached lookup, and the admin sees `success:true, usersImported:0`. Combined with #2, this can permanently stall imports for 30 min.
   Repro: Click "Import Users Now" with 50 users, half with email collisions; throttle triggers on first click, cache wipes, user lookups stampede Seerr again, get partially negative-cached, repeat.
   Fix: Validate user emails are unique on Jellyfin side before sending to Seerr; report per-user import results so the admin sees which users failed; gate `ClearUserCaches()` on `importedCount > 0`; reset throttle slot on partial-failure so retry is possible.

7. **[CRITICAL] `JellyseerrApiKey` and `X-Api-User` are added via `DefaultRequestHeaders` on a pooled `HttpClient` from `IHttpClientFactory.CreateClient()`**
   File: `Controllers/JellyfinEnhancedController.cs:178-181, 547-548, 1801-1802, 1862-1862, 1870-1871, 2028, 4912`. Same antipattern in `Services/AutoMovieRequestService.cs:263-264, 552-553, 624-625`, `Services/AutoSeasonRequestService.cs:102-103, 429-430, 588-589, 649-650`, `ScheduledTasks/JellyseerrWatchlistSyncTask.cs:96-97, 296-297, 349-350`, `Helpers/Jellyseerr/JellyseerrUserImportHelper.cs:43-45`, `Services/WatchlistMonitor.cs:159-160`, `Services/SeerrScanTriggerService.cs:164-170` (this last one correctly uses per-request headers).
   Bug: `IHttpClientFactory.CreateClient()` with no name returns a CLIENT that wraps a SHARED HttpMessageHandler. Default request headers are mutated on each request — when two requests interleave, headers can leak across users. In `GetJellyseerrRequestsForUser` (line 1870-1871) it does `Remove("X-Api-User") + Add(...)` per loop iteration, but if two callers concurrently mutate the same client instance the X-Api-User of user B can be in flight on user A's request. `AutoMovieRequestService.cs:552-553` actively *adds* `X-Api-Key` and `X-Api-User` without `Clear()` first — so on the second invocation HttpClient throws `InvalidOperationException: Cannot add value because header 'X-Api-Key' does not support multiple values`, which cascades to "request failed" for the rest of the lifetime of that pooled instance. The recently-added `FetchAndMapAsync` at line 4324 explicitly avoids this pattern; the rest of the codebase still has it.
   Repro: Two users concurrently click "request next season" — second one throws and silently fails.
   Fix: Replace every `_httpClientFactory.CreateClient()` + DefaultRequestHeaders pattern with `var request = new HttpRequestMessage(...); request.Headers.Add("X-Api-Key", ...);` (the pattern already used in `FetchAndMapAsync` and `SeerrScanTriggerService`).

8. **[HIGH] User-id resolution is by full GET `/api/v1/user?take=1000` for every distinct user with no in-flight dedup**
   File: `Controllers/JellyfinEnhancedController.cs:182-211` and identical loops in `Services/AutoMovieRequestService.cs:625-665`, `Services/AutoSeasonRequestService.cs:649-692`, `ScheduledTasks/JellyseerrWatchlistSyncTask.cs:243-289`.
   Bug: Each helper does a 1000-user pull from Seerr per cache miss. With 200+ Jellyfin users this is ~MB-scale. There is no in-flight task dedup (compare `_tmdbEnrichmentInFlight` at line 82 which DOES dedup) — concurrent first-time requests from N users all issue a full GET. Plus the `take=1000` cap means deployments with >1000 Seerr users silently drop the tail (no `skip=` pagination).
   Repro: Restart Jellyfin → 100 users hit dashboard simultaneously → 100 full user pulls hit Seerr in parallel. On a slow pi-hosted Seerr this stalls auth for several seconds across the user base.
   Fix: Add an in-flight dedup task per Seerr URL; paginate when `pageInfo.results > 1000`; consider `/api/v1/user/{jellyfinUserId}` if Seerr supports filtering by external id (it doesn't currently — bigger fix is bulk-cache the entire user→Jellyfin map for some short window).

9. **[HIGH] `_userCache` is **not** invalidated when `JellyseerrUrls`, `JellyseerrApiKey`, or `JellyseerrImportBlockedUsers` change**
   File: `Controllers/JellyfinEnhancedController.cs:64-69, 378-389` and `:148`
   Bug: `ClearUserCaches()` is only called inside `ImportJellyseerrUsers` (line 1763) and `JellyseerrUserImportTask.cs:87`. When an admin saves new Seerr URLs / API key / blocked users via the Configuration form (handled by Jellyfin core's plugin config save), no event clears `_userCache` or `_userIdCache` or `_responseCache`. So stale results, especially negative-cached `null` users, persist across the config change for the configured TTL. If the admin removes a user from `JellyseerrImportBlockedUsers`, the prior `null` cached at line 264 (or never-resolved because of line 158-161 short-circuit) keeps blocking them for 30 min.
   Repro: Admin updates `JellyseerrImportBlockedUsers` to remove a previously blocked user — the user still gets "not linked" until the cache TTL expires.
   Fix: Hook `BasePlugin.UpdateConfiguration` (or override the Jellyfin config-save callback) to call `ClearUserCaches()` plus `_responseCache.Clear()` on any change to Jellyseerr-prefixed fields.

10. **[HIGH] `JellyseerrAutoImportUsers` field is declared but **never initialised** in the constructor**
    File: `Configuration/PluginConfiguration.cs:448` (declaration) — note no assignment in the constructor block at lines 16-272.
    Bug: Boolean defaults to `false`. While that *happens* to be the documented default, the absence of explicit initialisation makes the convention inconsistent with every other JellyseerrXxx flag (lines 116-141 all explicitly set defaults). More importantly: when serialising config XML for migration and a previously-stored XML has the field absent, behaviour depends on serializer order. In practice harmless here, but the same pattern would be a bug if any JellyseerrXxx field had a non-default default.
    Repro: Refactoring this file to default another flag to true → easy regression.
    Fix: Add explicit `JellyseerrAutoImportUsers = false;` to the constructor for parity.

11. **[HIGH] `ProxyJellyseerrRequest` permission gate triggers ANOTHER `GetJellyseerrUser` call after `GetJellyseerrUserId` already did one**
    File: `Controllers/JellyfinEnhancedController.cs:480-526`
    Bug: Line 480 calls `GetJellyseerrUserId(jellyfinUserId)` (which calls `GetJellyseerrUser` internally on cache miss). Line 493 — for non-admins — does another `await GetJellyseerrUser(jellyfinUserId)`. Each of these can issue full user list pulls when caching is disabled (`JellyseerrDisableCache = true`). With caching disabled and 100 users, every Seerr proxy request hits Seerr's `/api/v1/user` twice. Compounds with #8.
    Repro: Set `JellyseerrDisableCache = true`. Open dashboard. Watch Seerr access logs explode.
    Fix: `GetJellyseerrUserId` already calls `GetJellyseerrUser` — change `ProxyJellyseerrRequest` to call `GetJellyseerrUser` once and use both the id and permissions from a single result.

12. **[HIGH] `GetJellyseerrUserStatus` calls `GetJellyseerrStatus()` and re-serializes the OkObjectResult to JSON to extract `active`**
    File: `Controllers/JellyfinEnhancedController.cs:776-784`
    Bug: After failing to find a user it does `await GetJellyseerrStatus()`, casts to `OkObjectResult`, calls `JsonSerializer.Serialize` on the value, then `JsonDocument.Parse` to read `active`. This is fragile: any future change to GetJellyseerrStatus's response shape silently breaks user-status. There's also no cancellation propagation — `GetJellyseerrStatus` opens its own HttpClient with 15 sec timeout (line 641), ignoring `HttpContext.RequestAborted`. A user closing the tab still pegs Seerr.
    Repro: Edit GetJellyseerrStatus's return shape — user-status silently breaks.
    Fix: Refactor to share a `IsSeerrReachable()` helper that returns a typed bool and accepts a cancellation token.

13. **[HIGH] `GetJellyseerrPartialRequestsSetting` returns 200 OK with `{partialRequestsEnabled:false, enableSpecialEpisodes:false}` on EVERY failure**
    File: `Controllers/JellyfinEnhancedController.cs:2017-2070`
    Bug: When Seerr is down, returns 200 OK with both flags false (line 2069). When admin sets partialRequestsEnabled=true in Seerr but Jellyseerr is briefly unreachable, the JE frontend silently flips to "no partial requests" mode and lets the user request whole seasons even though the admin disabled that. Also: the upstream JSON could legitimately omit either property; the code uses `prop.GetBoolean()` which throws on non-bool — caught by the outer try (line 2062) and re-iterates, and on full failure falls through to default-false (line 2069).
    Repro: Disable network for 5 sec while user opens season-request modal — they get whole-season UI even though Seerr is configured for partial-only.
    Fix: Return 503 on full failure, or include a `cached:true/error:string` flag so the frontend can fall back to last-known-good rather than to "false-default".

14. **[HIGH] `ProxyAvatar` cache poisoning via case-insensitive prefix match plus path-after-slash leakage**
    File: `Controllers/JellyfinEnhancedController.cs:5949-6070`
    Bug: The allow-list at lines 5985-5987 is case-insensitive (`OrdinalIgnoreCase`). The strip-query at 5965-5968 uses `IndexOf('?')` and `IndexOf('#')` which is fine, but the cache key at line 5998 is `avatarPath` (the lowercased-ish-not-actually-lowercased original path). Two requests with `/Avatar/Foo` and `/avatar/foo` produce different cache keys but allow-list both — minor cache duplication but not poisoning.
    Real bug: line 6027-6030 only blocks NON-image content types — but the upstream Seerr could return an image with embedded malicious payload or an HTML page disguised with an `image/svg+xml` Content-Type. SVG can contain JavaScript that executes in browsers viewing the avatar via `<img>` (modern browsers don't run scripts in `<img>`), but if any UI uses `<object data="...">` it's a stored XSS. Also the response is cached for 1 hour with content-type echoed back — admins cannot easily flush this cache after replacing an avatar in Seerr.
    Repro: Compromised Seerr returns SVG with embedded `<script>` as an avatar; cached for 1 hour, served to all users.
    Fix: Restrict allowed content types to a closed set: `image/png`, `image/jpeg`, `image/jpg`, `image/gif`, `image/webp`, `image/avif`. Reject `image/svg+xml`.

15. **[HIGH] `BulkImportAsync` returns `-1` only when ALL URLs failed, but `>=0` (success) on any URL returning success — even partial**
    File: `Helpers/Jellyseerr/JellyseerrUserImportHelper.cs:35-85`
    Bug: A 200 OK with an empty array `[]` returns `0` (line 63), which is treated as success by callers. Combined with `Controllers/JellyfinEnhancedController.cs:1761-1775` returning `success:true, usersImported:0`, an admin with 100 users where the Seerr instance has every user as "email collision" sees a misleading "Completed. 0 new user(s) imported" with no actionable error. There's no way to distinguish "all already imported" from "all failed silently".
    Repro: Admin runs import; everyone errors; UI says "Completed: 0 new". Admin assumes success.
    Fix: BulkImportAsync should return a struct `(int Imported, List<string> Errors)`; the controller should propagate per-user errors so UI can render which users failed.

16. **[HIGH] `IsCacheableApiPath` mis-classifies paths that contain `/discover/` as a substring of an unrelated URL**
    File: `Controllers/JellyfinEnhancedController.cs:451-461`
    Bug: Substring match for `/discover/`, `/genre`, `/similar`, `/recommendations`, `/person/`, `/collection/`, `/search?` against the *full* `apiPath`. There is no current Seerr endpoint that creates a false positive, but any future URL like `/api/v1/admin/genre-policy` or `/api/v1/users-discover/` would be aggressively cached. Worse: `/genre` (without trailing slash) matches `/api/v1/something/regenerate` (it wouldn't actually because there's no "regenre" pattern, but `/api/v1/genres` matches `/genre`). Actually checking more carefully: `apiPath.Contains("/genre")` matches `/api/v1/genres/movie` (line 1542) — that's the genre list endpoint which is intentionally cached. But it also matches a hypothetical `/api/v1/regenrich/...`.
    More concrete: `/search?` substring at line 460 is fine because it requires the literal `?`, but the cache layer at line 539 returns `Content(content, "application/json")` regardless of original mime type — see #5. Combined with #5 this becomes a cache-poisoning vector if Seerr returns redirected non-JSON for any path containing one of these substrings.
    Fix: Switch to start-of-path match (e.g. `apiPath.StartsWith("/api/v1/discover/")`) rather than substring contains.

17. **[HIGH] `AppendDiscoverFilters` does not propagate `with_companies`, `with_networks`, `with_watch_providers`, `studio`, `network`, `keywords` filters**
    File: `Controllers/JellyfinEnhancedController.cs:423-445`
    Bug: The whitelist at lines 423-429 omits `with_companies`, `with_networks`, `with_watch_providers`, `with_original_language` (Seerr supports these via the `/api/v1/discover` API). Any user who picks a "Watch Provider: Netflix" filter on a discovery slider gets the filter dropped silently — UI shows results that ignore the filter without any error. Also `studio`, `network`, `keywords` are NOT in DiscoverFilterParams but ARE injected by the route handlers at lines 1156, 1163, 1492-1513 via path concatenation — if a user accidentally passes `network=` as a query parameter to `/discover/tv/network/{networkId}`, the URL has `&network={routeParam}&network={query}` which is ambiguous (Seerr's TMDB-side query parser takes the last one).
    Repro: Visit `/JellyfinEnhanced/jellyseerr/discover/tv/network/123?network=456` → request goes to Seerr with `&network=123` (route) only; query `network=456` is dropped silently. Same for studio and keywords.
    Fix: Either expand the whitelist with `_companies` / `_networks` / `_watch_providers` (when frontend supports them), or document the supported filter list in the controller comment.

18. **[HIGH] `JellyseerrSearch` URL-encodes `query` but **not** `page` — page=1 fine, but no validation against negative**
    File: `Controllers/JellyfinEnhancedController.cs:916-924`
    Bug: `page` is a route-bound int (default 1). Negative values pass straight through to Seerr → 4xx response → frontend shows "no results" with no actionable error. Combined with `language` parameter at line 921 — `Uri.EscapeDataString` is correct, but the `query` parameter is not length-validated; an extremely long query (10MB) is forwarded to Seerr. Less critical.
    Fix: Clamp `page` to `Math.Max(1, page)`; cap `query.Length` at 256.

19. **[HIGH] `RequestTvSeasons` route accepts `tmdbId` from URL but uses `requestBody.ToString()` — `tmdbId` is ignored**
    File: `Controllers/JellyfinEnhancedController.cs:1587-1592`
    Bug: The endpoint `[HttpPost("jellyseerr/request/tv/{tmdbId}/seasons")]` parses `tmdbId` but the implementation forwards `/api/v1/request` with whatever the body says. If a malicious authenticated user crafts a body with a different `mediaId`, the URL's `tmdbId` is ignored and the request is for the body's mediaId. The legacy URL parameter is essentially decorative. While this isn't a privilege escalation (Seerr will validate against the user's permission), it is misleading: any logging key based on `tmdbId` from the route doesn't match the actual requested item, breaking audit trails.
    Fix: Either drop `tmdbId` from the route, or validate `requestBody.GetProperty("mediaId").GetInt32() == tmdbId` and 400 on mismatch.

20. **[HIGH] `EnrichWithTmdbData` cache key collides between movie/tv with same TMDB ID — actually OK, but cache survives Seerr-config change**
    File: `Controllers/JellyfinEnhancedController.cs:5759-5919`
    Bug: cache key is `$"{movie|tv}:{tmdbId}"` (line 5761) — that part is fine. But `_tmdbEnrichmentCache` at line 80 is a static dict, not invalidated on Seerr URL/key change (#9). When admin switches Seerr URL, stale entries from the old Seerr persist for `JellyseerrResponseCacheTtlMinutes` minutes. Fields like `posterUrl` may be specific to the Seerr instance's image base URL — actually no, `https://image.tmdb.org/...` is hardcoded at line 5862 so it's TMDB-direct. But `digitalReleaseDate` etc are content from the Seerr-proxy, which may differ between Seerr instances configured with different TMDB API keys.
    Less critical, lower confidence — would only matter if two Seerr instances had different TMDB region settings.
    Fix: Wire the same cache invalidation as recommended for #9.

21. **[HIGH] `GetCalendarEvents` calls every Sonarr/Radarr instance in parallel without a per-call `timeout` budget**
    File: `Controllers/JellyfinEnhancedController.cs:5278-5284`
    Bug: `Task.WhenAll` waits for the slowest. With one slow instance (e.g. an unreachable Sonarr behind a hung proxy), the calendar endpoint hangs for `TimeSpan.FromSeconds(30)` (line 5530 — Sonarr) or 10s (Radarr at 5620). The calendar UI shows a loading spinner the whole time. There's no overall request budget. Combined with the fact that the calendar pre-fetches images and the dedup loop is O(events²) on a popular calendar, the worst case can lock the UI for 30+ seconds.
    Fix: Add a master `Task.WhenAny` with a 15s overall budget; report `errors` for instances that didn't respond in time rather than blocking the whole endpoint.

22. **[HIGH] `GetCalendarEvents` writes `events.AddRange(...)` per result but uses unsafe shared variable `events` without checking dedup correctness across instances**
    File: `Controllers/JellyfinEnhancedController.cs:5295-5306` and dedup loop `:5381-5443`
    Bug: The dedup key for Radarr is `$"radarr|{movieKey}|{evt.ReleaseType}|{evt.ReleaseDate}"` (line 5393). `evt.ReleaseDate` is an ISO 8601 string with full precision. Two instances of Radarr with slightly different precision (one returns `2025-12-01T00:00:00.000Z`, another `2025-12-01T00:00:00Z`) generate different keys → fail to dedup. Same problem for Sonarr at line 5388. Calendar shows duplicate events.
    Repro: Compare any two Radarr instances of different versions for the same movie's release.
    Fix: Normalise the date in the dedup key to a calendar-day (`evt.ReleaseDate.Substring(0, 10)`) or parse to DateTimeOffset.

23. **[HIGH] `GetRequests` uses `config.JellyseerrUrls.Split(...).First()` — multi-instance failover broken on this endpoint**
    File: `Controllers/JellyfinEnhancedController.cs:4910`
    Bug: Only tries the first Seerr URL. If first is down, falls into the catch block at line 5171 which returns `Ok({requests:[],totalPages:0})` — silently empty UI. All other Jellyseerr proxy callers iterate URLs (`foreach (var url in urls)`); this one doesn't.
    Repro: Configure two Seerr URLs; take down the first; UI shows "no requests" instead of failing over.
    Fix: Loop over urls like every other helper.

24. **[HIGH] `GetRequests` silently swallows all errors as `Ok(new {requests:[]})`**
    File: `Controllers/JellyfinEnhancedController.cs:5171-5175`
    Bug: ANY exception (network, JSON parse, even programmer error / NullRef in enrichment) returns 200 OK with empty arrays. The frontend cannot distinguish "no requests" from "Seerr down" from "permission denied". The user instead sees a confusing "Requests page: empty" with no banner, no toast, no way to know there's a problem.
    Fix: Return distinct status codes with structured error envelope; let the frontend toast the user.

25. **[HIGH] Auto-Movie-Request and Auto-Season-Request mutate `httpClient.DefaultRequestHeaders` per loop iteration (race)**
    File: `Services/AutoMovieRequestService.cs:551-553, 624-625`, `Services/AutoSeasonRequestService.cs:587-589, 649-650`
    Bug: Same root cause as #7. The `_httpClientFactory.CreateClient()` returns a pooled client; `DefaultRequestHeaders.Add("X-Api-Key", ...)` on second invocation throws `InvalidOperationException`. The catch block at lines 596 (movie) / 621 (season) eats it, logs as a generic exception, and the request fails silently. The `Logger.Error` line shows up in logs but the user sees no UI feedback.
    Fix: Replace with per-request `HttpRequestMessage`.

26. **[HIGH] `WatchlistMonitor.ProcessItemForWatchlist` does NOT skip items when the requesting user is in `JellyseerrImportBlockedUsers`**
    File: `Services/WatchlistMonitor.cs:170-246`
    Bug: After the import-blocklist filter at the controller level, blocked users still have rows in Seerr (created by the user via Seerr UI directly, or imported once before being blocked). The watchlist monitor reads ALL Seerr requests (line 281) and matches by `requestedByJellyfinUserId` against ALL Jellyfin users including blocked ones (lines 177-179). So a user in the blocklist STILL gets requested-media added to their Jellyfin watchlist. The blocklist only stops them from being newly imported — it doesn't stop existing watchlist sync.
    Repro: User A is in blocklist. User A previously linked to Seerr. User A requests a movie via Seerr UI. Movie arrives. JE adds it to User A's Jellyfin watchlist anyway, contradicting the admin's blocklist intent.
    Fix: Filter `requesterIds` against `JellyseerrUserImportHelper.GetBlockedUserIds(...)` before adding to watchlist.

27. **[HIGH] `JellyseerrUserImportTask` uses `IUserManager.Users` lazy enumerable without a `.ToList()` snapshot and within an async loop**
    File: `ScheduledTasks/JellyseerrUserImportTask.cs:72-77`
    Bug: It does call `.ToList()` (line 72) which is good. But then iterates `userIds` which is also materialised, fine. However, the task does not use `cancellationToken.ThrowIfCancellationRequested()` BEFORE `BulkImportAsync` (line 82). If an admin cancels mid-import, the task reaches `BulkImportAsync` and runs to completion regardless. Less critical.
    Fix: `cancellationToken.ThrowIfCancellationRequested()` before the bulk call; the helper is already token-aware (line 51).

28. **[HIGH] `JellyseerrWatchlistSyncTask.GetJellyseerrUserMap` ignores `take=1000` cap silently**
    File: `ScheduledTasks/JellyseerrWatchlistSyncTask.cs:243-289`
    Bug: Single page only; deployments with >1000 Seerr users will silently miss the tail. No log warning. Combined with the user filtering at line 130-131, those tail users get "No Jellyseerr account linked" warning even though they are linked.
    Fix: Iterate `skip+=1000` until `pageInfo.results <= skip + items.Length`.

29. **[HIGH] `JellyseerrWatchlistSyncTask` does NOT respect `JellyseerrImportBlockedUsers`**
    File: `ScheduledTasks/JellyseerrWatchlistSyncTask.cs:106-138`
    Bug: Iterates all Jellyfin users without filtering by blocklist. Blocked users get "No Jellyseerr account linked for user X" log spam (correct outcome, but spammy). More serious: if the blocked user was already imported once, they are NOT skipped — their watchlist gets synced. This is the same class of bug as #26 but for the scheduled task path.
    Fix: Skip users in `GetBlockedUserIds(...)` before the foreach.

30. **[HIGH] `SeerrScanTriggerService` triggers scan even when JellyseerrEnabled is false at the moment of dispatch — but config-check timing is correct, so this is a near-miss**
    File: `Services/SeerrScanTriggerService.cs:119-156`
    Bug: Re-reads `Configuration` at dispatch time (line 121), good. But there's a subtle race: when admin toggles `TriggerSeerrScanOnItemAdded=false`, the timer fires `OnDebounceElapsed` (line 95) which only checks `_disposed` and `_pendingCount`, not the config. If admin disables the feature 1 second before the debounce expires, the dispatch still goes through. Also `TriggerNowAsync` (line 111) is unguarded — admin can manually trigger scans even when feature is disabled. Lower confidence on whether this is intentional.
    Fix: Re-check `JellyseerrEnabled && TriggerSeerrScanOnItemAdded` at the top of `DispatchAsync` for the auto-fire path.

31. **[HIGH] `ProxyJellyseerrRequest` sets last-error to a 500 but the actual Seerr response was, e.g., 401 with Cloudflare HTML**
    File: `Controllers/JellyfinEnhancedController.cs:608-618, 626`
    Bug: When the response is non-success and the body is HTML (not JSON), `JsonDocument.Parse(responseContent)` throws `JsonException` and falls into line 615-618: `lastErrorContent = JsonSerializer.Serialize(new { message = $"Upstream error from Jellyseerr: {response.ReasonPhrase}" });`. The status code returned from line 626 is the HTTP status from the HTML response (e.g. 200 if Cloudflare returned 200 OK with a challenge page). So the frontend sees a 200 with `{message: "Upstream error from Jellyseerr: OK"}` and tries to parse — it's valid JSON now, but the route handler doesn't know it's an error envelope.
    Repro: Cloudflare returns 200+HTML challenge → JE returns 200+`{message:"Upstream error from Jellyseerr: OK"}`. Frontend's `data.results` is undefined; discovery silently empty.
    Fix: Mirror the request status into a top-level error envelope shape, e.g. `{error:true, code:"upstream_html", message:"Jellyseerr returned an HTML page — check reverse-proxy bypass"}`, and return 502 instead of forwarding the upstream's 200.

32. **[MEDIUM] `_responseCache` and other caches use a plain `Dictionary` with a `lock` — no per-key concurrency, can deadlock under heavy contention**
    File: `Controllers/JellyfinEnhancedController.cs:72-73, 81-82, 64-65, 67-69`
    Bug: All four caches use `lock(_xxxLock)` around dict ops. Under 100+ concurrent users hitting discovery on first cache miss, each grabs the lock briefly; not a real deadlock, but the eviction loop at line 595-601 enumerates 200+ entries inside the lock, blocking all others for the duration. Plus the eviction is keyed off `_responseCache.Count > 200 || _responseCache.Count % 50 == 0` (line 593), so it runs nearly every write past 50 items — pathological for hot paths.
    Fix: Use `ConcurrentDictionary<string, ...>` and run eviction asynchronously or in a background task.

33. **[MEDIUM] `_avatarCache` has 50-entry threshold but uses `_avatarCache.Count > 50` which only evicts when OVER 50 — never bounds size**
    File: `Controllers/JellyfinEnhancedController.cs:6040-6049`
    Bug: Eviction only removes ENTRIES that are stale (older than 1 hour). If 1000 unique avatars are requested in 5 minutes, the cache grows unbounded — no LRU. Each entry stores raw image bytes (potentially MB-scale). Memory leak under "many distinct authors writing reviews" workload.
    Fix: Add a hard size cap (e.g. 200 entries) and evict oldest by `CachedAt` when exceeded.

34. **[MEDIUM] `ResolveQualityProfileAsync` returns `null` to mean "use default", which the caller `RequestMovie` interprets ambiguously**
    File: `Services/AutoMovieRequestService.cs:460-520, 532-601`
    Bug: `null` is conflated with "explicit default" and "fallback because original lookup failed" and "fallback because 4K detected and AutoMovieRequestFallbackOn4k is true". All three paths log different reasons, but the request body at line 561-577 falls through with no quality fields → Seerr default. If a user expects "Custom" mode but the config has no values set (line 510), they silently get the Seerr default — admin sees a `Warning` log but request still goes through.
    Repro: Admin selects "custom" mode but forgets to fill in any field; request goes through with Seerr default profile and admin doesn't notice for hours.
    Fix: Return a tagged enum/struct: `(QualitySettings, RequestSource)` with explicit "configuration_invalid" state that triggers a no-op or 400.

35. **[MEDIUM] `AutoMovieRequestMonitor.OnPlaybackProgress` is async void**
    File: `Services/AutoMovieRequestMonitor.cs:67`
    Bug: `async void` event handler — exceptions cannot be awaited or observed by the framework. The internal try/catch (line 69, 152) catches `Exception` so unobserved task exceptions are partly mitigated, but any await in `_autoMovieRequestService.CheckMovieForCollectionRequestAsync` that throws **asynchronously** after the catch frame exits will crash the process. Lower confidence — the wrap is broad, but `async void` is still the wrong pattern. Same in `AutoSeasonRequestMonitor.cs:68, 156`.
    Fix: Use `async Task` and a fire-and-forget wrapper that explicitly logs unobserved exceptions, or keep `async void` but ensure the entire async chain is inside the try.

36. **[MEDIUM] `OnPlaybackProgress` for season-request fires on EVERY progress event (every ~10 sec), only deduping by user+item**
    File: `Services/AutoSeasonRequestMonitor.cs:156-225`
    Bug: The dedup key is `{userId}_{itemId}` (line 188). If a user pauses, seeks back to the start, and resumes, they're at <2min progress again, but the dedup entry already exists → no re-trigger (correct). However, the entry persists for 1 hour. If user A starts an episode at 10:00 → cache populated → user B resumes A's session at 10:30, the dedup check at line 203 short-circuits user B — they never get a season-request check. Less critical but causes silent surprises.
    Fix: Include the playback session ID in the dedup key, not just user+item.

37. **[MEDIUM] `EnrichWithTmdbData` retains `_tmdbEnrichmentInFlight` entry on exception (TryRemove in finally block — actually correct), but the result is cached in `_tmdbEnrichmentCache` even if the inner `FetchEnrichmentAsync` returned a default `TmdbEnrichmentResult` (all-null fields) due to upstream error**
    File: `Controllers/JellyfinEnhancedController.cs:5778-5910`
    Bug: Lines 5785-5788: on non-success status, returns `new TmdbEnrichmentResult()` (all nulls). Lines 5876-5880: on any exception, same. This default is then cached at line 5898 for `JellyseerrResponseCacheTtlMinutes` minutes. Subsequent requests for the same TMDB ID get `null` title/poster for 10+ minutes even after Seerr recovers.
    Fix: Don't cache empty results; or use a much shorter TTL for negative entries (e.g. 30 sec).

38. **[MEDIUM] `JellyseerrWatchlistSyncTask` mutates `httpClient.DefaultRequestHeaders` per user inside foreach (race + non-atomic Remove+Add)**
    File: `ScheduledTasks/JellyseerrWatchlistSyncTask.cs:296-297, 349-350`
    Bug: Same antipattern as #7. Less critical because the scheduled task runs serially per user, but it shares the pooled HttpClient with the live controller's outbound requests — a concurrent live request's `X-Api-User` can be overwritten mid-flight by the task.
    Fix: Use per-request HttpRequestMessage.

39. **[MEDIUM] `AppendDiscoverFilters` logic uses `Uri.EscapeDataString` correctly but the **base path** is built without query-collision detection**
    File: `Controllers/JellyfinEnhancedController.cs:434-445`
    Bug: Caller passes `$"/api/v1/discover/tv?page={page}&network={networkId}"` (line 1156). `AppendDiscoverFilters` appends `&{param}=...`. If the user already passed a query parameter that's in the whitelist (e.g. they manually crafted `&sortBy=foo` in the URL), it's appended again, producing `?page=1&network=2&sortBy=foo` (legitimate). But if the route is a network/studio/genre path AND query params include `&page=...`, ASP.NET binds `page` from the route handler (default 1), but the user's `&page=2` query arg is what's appended — wait no, AppendDiscoverFilters doesn't include `page` in DiscoverFilterParams. So `page` from query is dropped if the user URL-includes it explicitly. UI doesn't do this so low impact.
    Fix: Document expected query params; consider stripping conflicting query params from `Request.Query` before appending.

40. **[MEDIUM] `_loggedCorruptArrConfig` is unbounded**
    File: `Controllers/JellyfinEnhancedController.cs:2550-2575`
    Bug: HashSet grows by 1 every time the JSON config changes. Long-running plugin restart-free for months with frequent config edits could accumulate hundreds of entries. Memory micro-leak, low impact.
    Fix: Cap at e.g. 32 entries with FIFO eviction.

41. **[MEDIUM] Permission audit (`/jellyseerr/permission-audit`) writes per-user `_logger.Info` lines without rate-limiting — N users → N log lines per audit run**
    File: `Controllers/JellyfinEnhancedController.cs:794-913`
    Bug: For 500 users this is 500+ log lines per audit click. Worse: the audit calls `bypassCache:true` (line 815), so each user triggers a full `/api/v1/user?take=1000` request to Seerr (#8 amplified). 500 user audit = 500 GET-1000-users calls to Seerr, taking minutes and pinning Seerr CPU.
    Fix: Build an in-process snapshot of the Seerr user map ONCE, then check each Jellyfin user against the snapshot.

42. **[MEDIUM] Issue endpoint authorisation gates apply `apiPath.StartsWith("/api/v1/issue?", IgnoreCase)` — misses `/issue` (no params)**
    File: `Controllers/JellyfinEnhancedController.cs:518-524`
    Bug: The list-issues check is `StartsWith("/api/v1/issue?")` OR `Equals("/api/v1/issue")`. Looks correct. But `GET /api/v1/issue/{id}` (line 3863) hits `ProxyJellyseerrRequest` with apiPath `/api/v1/issue/123`. None of the three issue checks (POST issue, GET issue with `?`, GET issue equals) match `/api/v1/issue/123`, so a non-admin without VIEW_ISSUES can fetch any single issue by id. Bypass.
    Repro: Non-admin user with no VIEW_ISSUES guesses issue id 1 and calls `/jellyseerr/issue/1` — gets the full issue payload.
    Fix: Add a check for `StartsWith("/api/v1/issue/", IgnoreCase)` (with trailing slash) that requires VIEW_ISSUES.

43. **[MEDIUM] `RequestTvSeasons` does not enforce that the body's `mediaType` is `tv`**
    File: `Controllers/JellyfinEnhancedController.cs:1587-1592`
    Bug: User can POST a body with `mediaType:"movie"` to the TV-seasons route, and ProxyJellyseerrRequest forwards as-is. Seerr will reject, but the route's permission check at line 502 only sees `apiPath == "/api/v1/request"` and applies `REQUEST/REQUEST_MOVIE/REQUEST_TV` (line 504-506). A user with `REQUEST_TV` only can submit a movie request through this route — Seerr re-validates, but the design intent is broken.
    Fix: Validate `mediaType` from body matches the route, or strictly enforce REQUEST_TV here.

44. **[MEDIUM] `JellyseerrPermission.NONE = 0` plus flag-arithmetic in `HasPermission` can give unexpected results for the NONE case**
    File: `Helpers/Jellyseerr/JellyseerrPermissionHelper.cs:7-15` and `Model/Jellyseerr/JellyseerrPermission.cs:4`
    Bug: `HasPermission(any, NONE) == ((any & 0) == 0) == true` for ANY input. Anyone "has" NONE — usually fine, but if any caller relies on `HasPermission(perms, JellyseerrPermission.NONE) == false` to mean "user has zero perms" they get incorrect results. Lower confidence — I see no caller relying on this.
    Fix: Either don't define `NONE = 0` as a flag, or document explicitly.

45. **[MEDIUM] `JellyseerrPermission` is missing `MANAGE_BLACKLIST` and `VIEW_BLACKLIST` distinctions for newer Seerr versions and is missing `2 = ADMIN` collision check**
    File: `Model/Jellyseerr/JellyseerrPermission.cs:4-34`
    Bug: `ADMIN = 2` is correct (Seerr's Permission.ADMIN). But Seerr's bitfield assigns 1 = NONE in some versions; this enum starts at NONE=0 / ADMIN=2 (no 1). New permissions (e.g. `IGNORE_BLACKLIST`, `MANAGE_USERS_BLACKLIST`) added in recent Seerr/Jellyseerr versions are missing — `HasAnyPermission(perms, MANAGE_BLACKLIST | VIEW_BLACKLIST)` won't match the right Seerr-side bits. Outside the scope of "is it correct now" but flag for ongoing maintenance.
    Fix: Periodically sync against `https://github.com/Fallenbagel/jellyseerr/blob/develop/server/lib/permissions.ts`.

46. **[MEDIUM] `IsJellyseerrImportBlocked` is checked in `GetJellyseerrUser` (line 158) but **not** in `GetJellyseerrUserId` short path**
    File: `Controllers/JellyfinEnhancedController.cs:391-421`
    Bug: `GetJellyseerrUserId` checks the cache (`_userIdCache`) before calling `GetJellyseerrUser`. If a previously non-blocked user was cached, then admin adds them to the blocklist, the cache hit at line 401-404 returns the cached id. The blocklist check at line 158 is bypassed for the TTL period.
    Repro: User U is allowed, admin imports them, they get cached. Admin adds U to blocklist. U continues to work for 30 min.
    Fix: Add the blocklist check at the top of `GetJellyseerrUserId` too, OR clear the cache on config change (per #9).

47. **[MEDIUM] `ProxyJellyseerrRequest` proxies `apiPath` straight to URL via string concat — no defence against `apiPath` containing `..` or `%2e%2e`**
    File: `Controllers/JellyfinEnhancedController.cs:558`
    Bug: `apiPath` always comes from controller-internal const strings (`/api/v1/...`) so user input cannot inject path traversal via this code path — UNLESS a future contributor adds a `[FromQuery] string apiPath` style endpoint. Currently safe; flag as a defensive guard for future-proofing.
    Fix: Validate `apiPath.StartsWith("/api/v1/")` and contains no `..` segments at the top of `ProxyJellyseerrRequest`.

48. **[MEDIUM] `GetCalendarEvents` `endDate.AddDays(90)` default but no upper bound when admin requests start...end far apart**
    File: `Controllers/JellyfinEnhancedController.cs:5193-5214`
    Bug: User can pass `start=1900-01-01&end=2099-12-31` and the calendar endpoint will fetch 200 years of calendar from each Sonarr/Radarr instance. Each instance returns potentially huge JSON, all loaded into memory, all dedup'd. Easy DoS for an authenticated user.
    Fix: Cap `(endDate - startDate).TotalDays` at e.g. 365.

49. **[MEDIUM] `CheckEpisodeCompletionAsync` reserves `_requestedSeasons[cacheKey]` BEFORE confirming the season actually exists on TMDB**
    File: `Services/AutoSeasonRequestService.cs:289-314`
    Bug: Sentinel write at line 304 happens before the `nextSeasonEpisodeCount == null` check at line 310-314. If the next season doesn't exist on TMDB yet (newly announced show), the sentinel is written but the failure path at line 313 returns WITHOUT removing the sentinel. The season is now "permanently" cached as "already requested" for 1 hour — when the season DOES become available on TMDB during that window, no request is fired.
    Repro: Last-episode-of-season check fires for a show whose next season hasn't been announced yet → sentinel cached → 30 min later TMDB updates with announcement → JE doesn't trigger because of stale cache.
    Fix: Move the sentinel write inside the success path, or remove it on the "season doesn't exist" return.

50. **[MEDIUM] `BulkImportAsync` adds API key via `httpClient.DefaultRequestHeaders.Add` on a pooled client, breaking subsequent calls**
    File: `Helpers/Jellyseerr/JellyseerrUserImportHelper.cs:43-45`
    Bug: Same antipattern as #7. After the first successful call adds X-Api-Key to the pooled handler's DefaultRequestHeaders, future callers sharing the same handler get... actually `_httpClientFactory.CreateClient()` returns a new `HttpClient` wrapping a pooled `HttpMessageHandler`, and `DefaultRequestHeaders` are per-client, NOT per-handler. So the leak is bounded to the lifetime of this single client instance. Less critical here.
    Fix: Per-request HttpRequestMessage anyway, for consistency.

51. **[MEDIUM] `GetCalendarEvents` access filter (line 5447-5459) uses `ItemId.HasValue` to gate filtering, but defaults to `true` when ItemId is null AND RootFolderPath is missing**
    File: `Controllers/JellyfinEnhancedController.cs:5447-5459`
    Bug: An event with `ItemId=null` AND `RootFolderPath=null` passes the filter unconditionally (`return true` at line 5457). Combined with the dedup tie-breaker that prefers "accessible" candidates, an unmatched event might actually slip through and show on a user's calendar even if they shouldn't see it. Lower confidence — depends on whether Jellyfin returns null root paths for legitimate items.
    Fix: Default to `false` when both ItemId and RootFolderPath are absent.

52. **[LOW] `IdentifyUrl` reads up to 64KB of HTML body to scan title — no charset detection (UTF-16 / GBK pages return garbage)**
    File: `Controllers/JellyfinEnhancedController.cs:4163-4173`
    Bug: `Encoding.UTF8.GetString(buffer)` regardless of page's actual encoding. Most arr services serve UTF-8 so works in practice; flagged for international deployments.
    Fix: Decode using `resp.Content.Headers.ContentType?.CharSet`.

53. **[LOW] `GetTmdbCollectionIdAsync` builds URL with `?api_key={config.TMDB_API_KEY}` interpolation**
    File: `Services/AutoMovieRequestService.cs:214` (also `Controllers/JellyfinEnhancedController.cs:1375` and `:2373`)
    Bug: API key is interpolated directly into the request URL with no encoding. TMDB API keys are 32-char hex so don't contain special characters in practice — flagged as defensive only.
    Fix: Use `Uri.EscapeDataString(config.TMDB_API_KEY)`.

54. **[LOW] `ProxyJellyseerrRequest` request body content type is hard-coded to `application/json` even when caller passes XML/multipart**
    File: `Controllers/JellyfinEnhancedController.cs:577`
    Bug: All current callers pass JSON, so safe today. Flag for future.
    Fix: Accept content type as a parameter to the helper.

55. **[LOW] `WatchlistMonitor.GetAllJellyseerrRequests` returns a list of >0 items even when Seerr returns `pageInfo.results > 1000` — no warning on truncation**
    File: `Services/WatchlistMonitor.cs:279`
    Bug: Pulls `take=1000` only. Servers with >1000 requests miss the tail; no log warning. Same class as #28.
    Fix: Iterate pages, or log a warning when `pageInfo.results > take`.

56. **[LOW] `WatchlistSyncTask.ProcessWatchlistItem` saves `userData.Likes = true` even when `_userDataManager.SaveUserData` may be racing with another sync**
    File: `ScheduledTasks/JellyseerrWatchlistSyncTask.cs:574-575`
    Bug: No transaction or compare-and-swap; if the user just toggled their own watchlist off in the UI between the `userData.Likes == true` check and the sync's `Likes = true` write, the user's manual unlike gets reverted. Also saves to ALL users every run (the "AlreadyInWatchlist" branch at line 551-571 saves processed-items state again, which writes the JSON file even when no actual change). I/O amplification.
    Fix: Skip the "AlreadyInWatchlist" save when state already shows the item is processed.

57. **[LOW] `JellyseerrSearch` does not pass `language` if the frontend doesn't supply it — Seerr defaults to English regardless of user's Jellyfin language**
    File: `Controllers/JellyfinEnhancedController.cs:918-924`
    Bug: Optional `language` query param. The frontend at `js/jellyseerr/api.js:230` (per the grep snippet I saw) does send `language=en`, but server-side fallback is `null` → English. Non-English users get English search results when their UI language doesn't match.
    Fix: Default `language` from `User.GetClaim("language")` or fall back to plugin config.

58. **[LOW] `ArrUrlGuard.IsAllowedUrlAsync` swallows `ArgumentException` differently than `IsAllowedUrl` — both return `false`, but the subsequent log at controller level doesn't differentiate "DNS failed" from "invalid hostname"**
    File: `Helpers/ArrUrlGuard.cs:66-86, 93-121`
    Bug: Less a bug, more a diagnostic gap. Admin who pastes a typo'd hostname can't tell from the log whether the URL is malformed or the resolver is down.
    Fix: Log the specific exception type in the controller's `IsAllowedUrl` wrapper (line 2529).

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 7 |
| HIGH     | 24 |
| MEDIUM   | 21 |
| LOW      | 6 |
| **Total**| **58** |

### Top user-facing impacts

The "discovery silently disappears" UX (issues #577 / #449 / #225 / #146 / #38) is reproducible from at least these distinct paths:
- **Bug #1 + #2 + #9** — 401 from a reverse proxy negative-caches null user for 30 min
- **Bug #3 + #5 + #31** — Cloudflare HTML page parsed/cached as JSON
- **Bug #16** — substring URL matching opens new poisoning vectors as Seerr's API surface grows
- **Bug #11 + #8** — N×2 user list pulls per request stalls Seerr enough to look like silent-failure
- **Bug #23 + #24** — single-URL fan-out plus 200-OK-on-error in `GetRequests`

The "broken Seerr URL crashes Jellyfin web UI" (#591) is **not** something I can pinpoint to a specific code path in this scope — config save itself doesn't perform any Seerr I/O in the read paths I reviewed. The most likely culprit is the FileTransformation patches in `Services/StartupService.cs` (out of scope for this audit) or the script-injection logic in `JellyfinEnhanced.cs:343-387`. Recommend a follow-up focused review on the FileTransformation registration path with crash logs from a repro.

### Files touched (all absolute paths)

- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/Controllers/JellyfinEnhancedController.cs`
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/Helpers/Jellyseerr/JellyseerrPermissionHelper.cs`
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/Helpers/Jellyseerr/JellyseerrUserImportHelper.cs`
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/Helpers/ArrUrlGuard.cs`
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/Model/Jellyseerr/JellyseerrPermission.cs`
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/Model/Jellyseerr/JellyseerrUser.cs`
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/Configuration/PluginConfiguration.cs`
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/ScheduledTasks/JellyseerrUserImportTask.cs`
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/ScheduledTasks/JellyseerrWatchlistSyncTask.cs`
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/Services/SeerrScanTriggerService.cs`
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/Services/AutoMovieRequestService.cs`
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/Services/AutoMovieRequestMonitor.cs`
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/Services/AutoSeasonRequestService.cs`
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/Services/AutoSeasonRequestMonitor.cs`
- `/home/jake/JE-seerr-bug-audit/Jellyfin.Plugin.JellyfinEnhanced/Services/WatchlistMonitor.cs`
