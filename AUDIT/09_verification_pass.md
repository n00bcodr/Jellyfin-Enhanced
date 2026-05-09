# Verification Pass — 33 NEW findings (V1-V33)

## CRITICAL (1)
V18. Docs iframe sandbox `allow-popups-to-escape-sandbox` lets compromised github.io break out to attack admin

## V10 DOWNGRADED to MEDIUM after live verification
V10. JellyseerrSearch missing-query — ASP.NET model binding actually catches null/empty with 400 before Uri.EscapeDataString runs (verified live). Real bug: error message leaks RFC9110 URL + ASP.NET traceId in response body, exposing implementation details. Fix: declare param as `string?`, return clean BadRequest envelope `{ok:false,message:"Query parameter is required"}`.

## HIGH (12)
V1.  Monitor singletons never disposed — event subs leak across plugin upgrade → double auto-requests
V2.  Static caches process-lifetime — survive plugin reload via stale ALC pinned by V1's leaked subs
V3.  AutoMovieRequestMonitor.Initialize early-returns if disabled at startup → toggling on requires Jellyfin restart
V5.  Calendar rootFolderAccessMap incomplete — leaks unimported episodes to users without root-folder access
V6.  Calendar dedup key — Sonarr/Radarr precision drift causes duplicate events even with audit C01-HIGH-22's fix idea
V8.  GetTmdbPersonData accepts tmdbPersonId=0 → TMDB 404 + log noise
V11. request-manager.abortAllRequests is exposed but never wired to navigation
V12. Modal popstate close path: stacked nested modals all close on single back press
V13. Issues reporter monthNames hardcoded English
V14. 6 more bare-English strings in issue-reporter.js (combined with V13: most-i18n-broken module)
V15. `jellyseerr_select_all_seasons` key reused for "All episodes" label — translators see it as "All seasons"
V20. ProxyAvatar no User-Agent/Accept → Cloudflare bot challenge → silent avatar disappear
V28. plugin.js mutates JE.pluginConfig client-side without server PUT → UI/server divergence

## MEDIUM (14)
V4.  JE.pluginConfig.JellyseerrEnabled non-optional in jellyseerr.js → throws if config load failed
V7.  Sonarr 30s vs Radarr 10s timeout inconsistency
V9.  TMDB API key interpolated into URL at /person/{id} — F26 missed this site
V16. bookmarks_library_title key USED in JS but MISSING from EVERY locale
V19. ProxyAvatar cache key omits jellyseerrUrl → wrong avatar served after Seerr URL change
V21. ProxyAvatar SHA256 ETag in request path — 25ms+ for animated GIFs
V22. Calendar fallback DateTime.TryParse without InvariantCulture
V23. accessibleIds O(N) DB hits during dedup tie-break
V24. Promoting public-discovery cache to user-shared key would leak per-user-filtered content (architectural caveat to C01-CRIT-4 fix)
V25. labelKey indirection hides translation keys from static analysis
V27. clearUserStatusCache exposed but no caller (still pending after audit 02 #44)
V29. RequestTvSeasons uses ToString() not GetRawText() — round-trip loses fidelity
V30. JellyfinEnhanced.cs writes pluginPagesConfig on every constructor without diff
V32. No global rate limit on auto-request fan-out to Seerr

## LOW (5)
V17. Locale files have empty-string values for some keys
V26. cachedUserCanReport STILL declared and written but never read (audit 02 #8 still unaddressed)
V31. SaveConfiguration() from constructor — risk of double-init
V33. issueType validation could be tightened to whitelist '1','2','3','4'

## Top fixes (architectural pay-off)
1. **AddHostedService<T>()** for monitors → fixes V1, V3, partial V2
2. **IMemoryCache + OnConfigurationUpdated** → fixes V2, V19, plus C01 #9/#20/#46, C03 A1
3. **Translation-key build-time lint** → V13, V15, V16, V17, V25 regression prevention
