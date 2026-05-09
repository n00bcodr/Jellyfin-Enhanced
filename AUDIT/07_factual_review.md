# Factual Review (25 spot-checks)

**Verdict: 19 verified outright, 4 verified with caveats/partial, 2 refuted.**

## Refutations (must revise before final report)

### Audit 01 #7 — DefaultRequestHeaders race
**OVERSTATED.** `IHttpClientFactory.CreateClient()` returns a fresh `HttpClient` per call with its own `DefaultRequestHeaders`. Cross-user leakage as described is not reproducible. The "InvalidOperationException on second invocation" claim is incorrect — each call gets fresh headers. The pattern is still suboptimal; recommend revising to "anti-pattern, not currently exploitable, migrate to HttpRequestMessage for consistency."

### Audit 02 #14 — prepareResultsWithCollections mutation
**REFUTED.** `addCollections` (api.js:294) returns a new array via `Promise.all(results.map(...))`, so the subsequent splice mutates the new array, NOT the caller's. Remove from bug list.

## Caveats (verified-but-narrower-scope)

- Audit 01 #2 negative-cache: already gated by `importDefinite` for network errors; HTTP-401-from-proxy DOES still negative-cache (real bug). Audit narrative was sound.
- Audit 01 #14 ProxyAvatar: SVG XSS verified; cache class detail wrong (`_avatarCache` is ConcurrentDictionary not Dictionary+lock — partially refutes audit 01 #32's framing).
- Audit 01 #32 cache class: 3 of 4 caches use Dictionary+lock, `_avatarCache` and `_tmdbEnrichmentInFlight` are ConcurrentDictionary. "All four" framing is wrong.
- Audit 02 #1: cache "forever" really means "for SPA session"; clearUserStatusCache exists but only on logout.

## Verified Outright (CRITICAL/HIGH)

- 01 #1 GetJellyseerrUserStatus 200-on-everything ✅
- 01 #3 HTML challenge parsed as JSON across 6 sites ✅ (IdentifyUrl is the ONE site that gets it right)
- 01 #4 Per-user cache key on public discovery ✅ — line 531
- 01 #5 ProxyJellyseerrRequest no Content-Type before cache ✅
- 01 #6 ImportJellyseerrUsers fails open ✅ (admin's own ID enumerated; ClearUserCaches runs unconditionally)
- 01 #8 No in-flight dedup, take=1000 ✅
- 01 #16 IsCacheableApiPath substring matching ✅
- 01 #17 AppendDiscoverFilters whitelist gaps ✅
- 01 #19 RequestTvSeasons ignores tmdbId from route ✅
- 01 #21 GetCalendarEvents no master timeout ✅
- 01 #23 GetRequests uses .First() only ✅
- 01 #24 GetRequests returns Ok([]) on every error ✅
- 01 #44 NONE=0 always returns true ✅
- 01 #46 GetJellyseerrUserId cache hit bypasses blocklist ✅
- 01 #49 AutoSeasonRequestService sentinel cache leak ✅
- 02 #2 Issue #577 silent leak across 6 modules ✅
- 02 #3 more-info-modal bypasses request-manager ✅
- 02 #6 Modal popstate hijacks browser back ✅
- 02 #8 cachedUserCanReport written but never read ✅
- 02 #18 response.json() with no Content-Type guard ✅
- 02 #26 posterUrl XSS in style attribute ✅
- 02 #27 fetchProviderIcons raw fetch ✅
- 03 A18 Blocklist hidden field WIPED if /Users fails ✅
- 04 F1 No Content-Type guard across all cited files ✅
- 04 F21 version, public-config missing [Authorize] ✅ (CONFIRMED via live test)
- 04 F23 issue/{id} bypass missing VIEW_ISSUES gate ✅

## Confidence
The CRITICAL findings (Content-Type missing, per-user cache, fail-open user-status, single-URL GetRequests, NONE flag, sentinel leak, blocklist wipe, version/public-config unauth, issue/{id} bypass) all check out cleanly and are real bugs that justify the master report.
