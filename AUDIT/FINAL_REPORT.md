# JE Seerr / Discovery — FINAL Audit Report

**Branch:** `audit/seerr-discovery-bugs` (from `n00bcodr/main`)
**Scope:** Every Seerr/Jellyseerr/Discovery code path — server (C#), client (JS), config UI (HTML), docs, deployment.
**Method:** 5 specialist code reviews + GitHub issue enumeration + live integration tests against `jellyfin-dev` (port 8097, JE 11.8.1.0 + FileTransformation 2.5.9.0 + Seerr 3.2.0). Plus factual + consistency + redundancy review passes.

**Result:** **70 unique root-cause bugs** (deduplicated from 142 raw findings) + **14 architectural recommendations**.

| Severity | Count | Notes |
|----------|-------|-------|
| **CRITICAL** | 6 | Discovery silently disappears; HTML-as-JSON; negative-cache poison; ImportUsers fail-open; Cloudflare 5xx invisible; docs-iframe escape |
| **HIGH** | 28 | Auth bypasses, calendar bugs, cache invalidation, lifecycle leaks |
| **MEDIUM** | 24 | UX/i18n, magic strings, perm enum drift, eviction caps |
| **LOW** | 12 | Cosmetic / defensive hardening |
| **Architectural** | 14 | Each absorbs 5-15 individual bugs |

**Headline:** ~50% of raw bugs collapse into 7 architectural investments.

**Repository setup:** Fresh clone from `n00bcodr/main` at `/home/jake/JE-seerr-bug-audit`. FileTransformation 2.5.9.0 + JE 11.8.1.0 deployed to `jellyfin-dev` for live testing. All 10 audit files preserved in `AUDIT/`.

---

# Top 6 CRITICAL clusters

## CRIT-1. Discovery silently disappears (issue #577 root cause)

**Symptoms:** User opens a movie/show page and sees no similar/recommended discovery sections. No error toast, no banner, no console log readable to non-developers.

**5 distinct causes that produce the same blank UX:**

1. **`/jellyseerr/user-status` returns 200 OK on every failure mode** *(controller :752-786)*. Returns `{active:?, userFound:false}` whether the cause is "user actually unlinked", "API key wrong", "Cloudflare returning HTML", "user blocked", or "negative-cached null."
2. **`api.checkUserStatus` caches failure for entire SPA session** *(api.js:198-213)*. No TTL on negative result.
3. **All 6 discovery modules silently bail** on `!status?.active`: `genre-discovery.js:580`, `network-discovery.js:642`, `tag-discovery.js:499`, `person-discovery.js:467`, `collection-discovery.js:182`, `item-details.js:274`. Zero UX surface.
4. **Forward-auth proxy 401+HTML silently fails over** through the URL list, exhausting all configured Seerr URLs without distinguishing the proxy auth failure from "Seerr down."
5. **No frontend banner registry** — each module bails independently.

**Single fix:** Typed `Result<T, SeerrError>` envelope server-side (architectural fix C1) + frontend banner showing the structured reason ("Seerr unreachable", "auth challenge from reverse proxy", "API key rejected", etc.). Drop the negative cache TTL to 60s and clear it on config change.

**Prior IDs absorbed:** C01-CRIT-1, C02-CRIT-1, C02-CRIT-2, 02#2, C04-CRIT-F8.

---

## CRIT-2. Reverse-proxy / Cloudflare HTML challenge silently parsed as JSON across 7+ sites

**Symptoms:** When Cloudflare/Pangolin/SWAG/Authelia returns a 200 OK HTML challenge page (Bot Fight Mode, IP allowlist mismatch, browser integrity check), JE callers parse it as JSON. Result: silent failover to next URL, or success-with-bogus-shape that drops `results` property.

**Sites affected:** `Controllers/JellyfinEnhancedController.cs:188-227, 317-318, 1814, 1880, 2043, 5790-5791`; `Services/AutoMovieRequestService.cs:223-238`; `Services/AutoSeasonRequestService.cs:117`; `Services/WatchlistMonitor.cs:288-289`; `ScheduledTasks/JellyseerrWatchlistSyncTask.cs:258-259`. **The ONLY site that gets it right is `IdentifyUrl`** at `:4108` — which validates `Content.Headers.ContentType?.MediaType.Contains("json")`. The pattern exists; it's just not reused.

Plus: `ProxyJellyseerrRequest` *caches* the HTML response as `application/json` for 10 minutes (`:583-606`), poisoning every subsequent user.

Plus: When the upstream returns 200+HTML, `ProxyJellyseerrRequest` mirrors the 200 status and emits `{message:"Upstream error from Jellyseerr: OK"}` (`:608-618, 626`) — frontend parses successfully but `data.results` is undefined.

Plus: Cloudflare 5xx errors (520-526) all collapse into the same opaque outcome.

Plus: Frontend `response.json()` (api.js:48, request-manager.js similar) does not check Content-Type either.

**Single fix:** Centralize all Seerr/arr outbound HTTP in `ISeerrHttpClient` with:
- `Content-Type` validation (must start with `application/json`)
- `User-Agent: JellyfinEnhanced/{Version}`
- `Accept: application/json`
- `AllowAutoRedirect=false` (detect 302→login as auth-required)
- Log `cf-ray`, `cf-cache-status` on errors
- Translate failures to typed `SeerrError` codes: `unreachable`, `unauthorized`, `html_response`, `cloudflare_5xx`, `rate_limited`

**Prior IDs absorbed:** C01-CRIT-3, C01-CRIT-5, C01-CRIT-31, C04-CRIT-F1, C04-CRIT-F2, C04-CRIT-F3, 02#18, plus C04-HIGH F4/F5/F9/F10/F12/F18/V20.

---

## CRIT-3. Negative-cached null user lookups poison discovery for 30+ minutes

**File:** `Controllers/JellyfinEnhancedController.cs:148-269` + `:391-421`

When `TryAutoImportJellyseerrUser` returns `(null, definite=true)` — e.g., on auth-HTML-from-proxy with HTTP-status set, or on UNIQUE-constraint email collision — the `null` is stored in `_userCache` for `JellyseerrUserIdCacheTtlMinutes` (default 30 min). Process-global cache; only restart or admin "Clear caches" recovers.

`GetJellyseerrUserId` cache hit at `:401-407` ALSO bypasses the blocklist re-check inside `GetJellyseerrUser` — so admin adding a user to blocklist takes 30 min to take effect.

Static cache survives plugin upgrade (process-lifetime), and stale event subscriptions on monitor singletons keep the OLD AssemblyLoadContext pinned (V1, V2).

Compounds with CRIT-1 and CRIT-2: a single transient failure can blank discovery for 30 min after recovery.

**Live test confirms:** After live invalid-config tests, JE recovers only after caches expire (10-30 min). Admins debugging in real-time see "still broken" after their fix and assume it didn't work.

**Single fix:** `OnConfigurationUpdated` hook → `IMemoryCache.Compact()` (architectural fix B5/D2). Reduce negative-cache TTL to 60s. Migrate static caches to DI-injected `IMemoryCache`.

**Prior IDs absorbed:** C01-CRIT-2, C01-HIGH-9, C01-HIGH-46, C01-HIGH-20, C03-A1, V2, V19.

---

## CRIT-4. ImportJellyseerrUsers returns success on partial failure + flushes all caches

**File:** `Controllers/JellyfinEnhancedController.cs:1751-1775` + `Helpers/Jellyseerr/JellyseerrUserImportHelper.cs:35-85`

`BulkImportAsync` returns `>=0` on any URL succeeding, even if `0` users imported (e.g., all email-collisioned). Controller returns `success:true, usersImported:0` to admin. Throttle slot consumed (30s lock-out). `ClearUserCaches()` runs unconditionally — flushing every legitimately-cached lookup, including healthy users who don't need to be re-resolved.

Combined with CRIT-3's negative-cache poison, can stall imports for 30 min.

**Fix:** Return `(int Imported, List<string> Errors)`. Propagate per-user errors to UI. Gate `ClearUserCaches()` on `Imported > 0`. Reset throttle on partial-failure.

**Prior IDs absorbed:** C01-CRIT-6, C01-MED-15.

---

## CRIT-5. Issue #591 — saving broken Seerr URL crashes /web/ via FileTransformation DI race (UPSTREAM bug)

**File:** `/home/jake/Documents/jellyfin-plugin-file-transformation/rewrite/src/Jellyfin.Plugin.FileTransformation/PluginInterface.cs:14-30` (NOT in JE)

FileTransformation captures `IServiceProvider` once at plugin construction (root, not scoped). When JE saves config:
1. Writes plugin XML
2. FT's `ConfigVersionService` (FileSystemWatcher on plugin XMLs) bumps version counter
3. FT injects auto-reload script into `/web/` index.html
4. Browser reload + slow Seerr URL (15s validate timeout) keeps `/web/*` requests in-flight long enough
5. If captured ServiceProvider was disposed during host scope rebuild, `GetRequiredService` throws `ObjectDisposedException`

**JE is innocent.** `StartupService.RegisterFileTransformation` registers a static callback (`TransformationPatches.IndexHtml`) that does NOT touch ServiceProvider. JE has no `OnConfigurationUpdated` override. The bug is owned by FileTransformation's `PluginInterface` class.

**JE-side mitigations to reduce trigger frequency:**
- C03-A2: Validate URL scheme on save (rejects garbage URLs)
- C03-A19: Keep "Seerr not configured" banner up until URL is parseable
- C03-A18: Don't wipe blocklist when /Users API fails

**Recommend:** File upstream bug against IAmParadox27/jellyfin-plugin-file-transformation. The local directory `/home/jake/Documents/jellyfin-plugin-file-transformation/issues/bugs/di-race/` confirms the maintainer is aware.

---

## CRIT-6. Docs iframe sandbox lets compromised github.io break out to attack admin

**File:** `Configuration/configPage.html:1995-2001, 2235`

The docs iframe loads `https://n00bcodr.github.io/Jellyfin-Enhanced/` with `sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"`. With `allow-popups-to-escape-sandbox`, ANY script in the iframe can `window.open(url, '_blank')` to a fully-unrestricted new window. If GitHub Pages is compromised or the maintainer's GH account is breached:

1. Attacker injects hostile script in docs page
2. Opens popup window (escapes sandbox) targeting Jellyfin admin URL
3. Popup runs unsandboxed, can phish admin credentials or trigger CSRF against Jellyfin

CRITICAL because admins are the only ones loading this iframe, and admin sessions are the privilege-escalation goal.

**Fix:** Drop `allow-popups-to-escape-sandbox` and `allow-popups`. The "Open in new tab" link (line 1990-1993) already exists. Or proxy docs through plugin (same-origin, sandbox is meaningful).

---

# 7 Architectural Investments (eliminate 50% of bugs)

| # | Investment | Bugs eliminated | Effort |
|---|------------|-----------------|--------|
| **B1** | Extract `IJellyseerrUserResolver` (one helper, one cache, one auth path) | C01 #8, #11, #28, #46; LOW-55; MED-41; "user resolution duplicated 5×" | M |
| **B3** | `ISeerrHttpClient` with named HttpClient + Content-Type guard + UA/Accept/no-redirect | CRIT-2 cluster (~13 bugs); CRIT-3 partially | M |
| **C1** | Typed `Result<T, SeerrError>` envelope across all Seerr proxy paths | CRIT-1 cluster; #577 long-tail; partial-requests-default-false; GetRequests-empty-on-error | M |
| **B5/D2** | `OnConfigurationUpdated` → `IMemoryCache.Compact()`; migrate static caches to DI | CRIT-3 cluster; cache-survival-after-config-change | S |
| **F1** | Extract `DiscoverySection` base class for 5 modules | C02 #21/22/82 (each ×5) = 15 bugs | M |
| **A2** | Route-group `[Authorize]` policy on controller class | F21, F33, V1, V2 (route auth), V3 — auth bypasses | XS |
| **HS** | `AddHostedService<T>()` for monitors (replace `AddSingleton<T>` + manual `Initialize()`) | V1, V2 (partial), V3 — leaked event subs across plugin upgrade | XS |

After applying these 7 investments, the residual bugs drop from 70 to ~30 distinct issues.

---

# 28 Standalone HIGH bugs

(After cluster dedup — these don't fit a CRIT cluster but warrant fixes.)

## Auth & authz
- **V1+V3 (auth-bypass cluster)**: `/jellyseerr/user`, `/tmdb/validate`, `/jellyseerr/sonarr`, `/jellyseerr/radarr`, `/jellyseerr/{type}/{serverId}`, `/jellyseerr/overrideRule` — `[Authorize]`-only, no `IsAdminUser()`. **CONFIRMED LIVE for `/tmdb/validate`** (TEST 11): non-admin Test user successfully validated TMDB key as oracle.
- **F21+F33**: `/version` and `/public-config` unauthenticated. **CONFIRMED LIVE** (TEST 6, 7).
- **F23**: `GET /jellyseerr/issue/{id}` permission gate at `:518-524` only matches `?` and bare-equals — `/issue/123` slips through. Needs re-test with linked non-admin user.
- **F24**: No CSRF protection on POST /api/v1/request proxy
- **MED-42**: `IsAdminUser` literal `"Administrator"` magic string

## Calendar & Requests
- **C01-HIGH-21**: GetCalendarEvents `Task.WhenAll` waits for slowest — 30+ sec UI hang
- **C01-HIGH-22+V6**: Calendar dedup precision — Sonarr/Radarr return different ISO formats; airDateUtc vs airDate fallback drift
- **V5**: rootFolderAccessMap incomplete for unimported episodes — leaks calendar entries to users without root-folder access
- **C01-HIGH-23+24** (consolidated): GetRequests uses .First() URL only AND swallows all errors as 200+empty
- **C01-MED-48**: GetCalendarEvents no upper bound on date range (DoS by authed user)
- **V7**: Sonarr 30s vs Radarr 10s timeout inconsistency
- **V23**: accessibleIds O(N) DB hits during dedup tie-break

## Auto-Movie / Auto-Season Request
- **C01-MED-49**: AutoSeasonRequestService sentinel cache leak when next season missing on TMDB
- **C01-MED-34**: ResolveQualityProfileAsync returns null ambiguously
- **V32**: No global rate limit on auto-request fan-out to Seerr

## Frontend XSS / unsafe interpolation
- **02#26**: `posterUrl` interpolated into `style="background-image:url(...)"` without escape
- **C01-HIGH-14**: ProxyAvatar accepts `image/svg+xml` → cached SVG with `<script>` is stored XSS for 1hr
- **02#76**: `more-info-modal.js` CSS class `.modal-overlay` collides with Jellyfin core

## Lifecycle & state
- **02#3**: more-info-modal `fetchRatings`/`fetchMediaDetails` bypass request-manager
- **02#13**: more-info-modal interval handle on local var, leaks if close fails
- **V11**: request-manager.abortAllRequests exposed but never wired to navigation
- **V12**: Modal popstate close path: stacked nested modals all close on single back press
- **V28**: plugin.js mutates JE.pluginConfig client-side without server PUT

## Discovery filter
- **C01-HIGH-17**: AppendDiscoverFilters whitelist gaps (`with_companies`, `with_networks`, `with_watch_providers`, `studio`, `network`, `keywords`)
- **C01-HIGH-19**: RequestTvSeasons ignores tmdbId route param (audit-trail mismatch)
- **C01-HIGH-43**: RequestTvSeasons doesn't enforce `mediaType:"tv"` from body

## Documentation
- **F31**: No reverse-proxy / Cloudflare / WAF setup docs
- **F32**: Issue #449 endpoint enumeration never produced (only 6/99 documented)

---

# Live test summary

(Run against jellyfin-dev port 8097 with JE 11.8.1.0 + FT 2.5.9.0 + Seerr 3.2.0.)

| Test | Finding | Result |
|------|---------|--------|
| TEST 0 | Baseline (admin not linked) | active:true, userFound:false, search 404 (correct) |
| TEST 1 | Wrong API key | 403 + "Status check failed" — no distinction between auth/network |
| TEST 1 | Empty API key | 400 + ASP.NET model error leaks |
| TEST 2 | Loopback unreachable URL (#591 trigger) | 502 "Unable to reach Jellyseerr" — correct |
| TEST 2 | Cloud metadata IP 169.254.169.254 | **Blocked correctly** (400 "Invalid URL") |
| TEST 2 | Decimal-encoded IP (2130706433) | 502 — passed guard (loopback allowed by design) |
| TEST 2 | IPv6-mapped IPv4 [::ffff:127.0.0.1] | 502 — passed guard (loopback allowed by design) |
| TEST 3 | HTML response (Cloudflare sim) | 404 — does NOT distinguish "got HTML" |
| TEST 5 | IPv6-mapped IPv4 of blocked IP | HTTP:000 — blocked at network layer (probably) |
| TEST 5 | Hex-encoded loopback (0x7F000001) | 502 — treated as hostname |
| TEST 6 | Validate WITHOUT token | 401 — correct |
| TEST 6 | `/version` without token | **200 — bypasses auth** ✅ F21 confirmed |
| TEST 6 | `/public-config` without token | **200 — exposes JellyseerrBaseUrl, mappings, 137 fields** ✅ F33 confirmed |
| TEST 7 | public-config sensitive field check | API keys NOT exposed (good); URLs ARE |
| TEST 8 | Non-admin validate/permission-audit/trigger | 403 — correct |
| TEST 11 | **`/tmdb/validate` as non-admin** | **200 with valid key, 401 with junk** ✅ V2 confirmed (oracle) |

---

# Recovery behavior (after invalid config)

**Critical UX finding:** When admin fixes a misconfiguration, JE recovers ONLY after caches expire (10-30 min). For real-time debugging, this is the worst possible UX — admins fix the config, refresh, see "still broken," assume the fix didn't work, file an issue.

**Architectural fix B5/D2** (clear caches on config save) is the highest-priority recovery fix. Without it, admins who follow the legitimate troubleshooting flow (fix → save → reload) will hit a stale-cache window and incorrectly conclude the fix didn't work.

---

# Cross-cutting issues by GitHub issue

| GH Issue | Status | Bugs identified |
|----------|--------|-----------------|
| #577 | Open | CRIT-1 cluster — discovery silently disappears (5 paths) |
| #591 | Open | CRIT-5 — FileTransformation upstream DI race; JE-side mitigations C03-A2/A18/A19 |
| #449 | Closed (no resolution) | F32 — endpoint enumeration never produced |
| #225, #146, #38, #27, #29 | Closed (proxy-side) | CRIT-2 cluster — HTML-as-JSON parsing |
| #175 | Closed | F7 — Cloudflare Rocket Loader docs gap |
| #525, #570 | Closed/Open | Custom Tabs cache; out-of-scope for this audit |
| #594 | Fix pending | A2 (status reconciliation for stale "Available") |
| #580 | In progress | Quota error message visibility |
| #564 | Partial fix | iOS webview escape — emby-linkbutton missing |

---

# Master action priority

## Must-fix-now (1-2 weeks)
1. **F23** — Fix `/issue/{id}` permission gate (one-line fix, real authz bypass)
2. **F21+F33** — Add `[Authorize]` to `/version` and `/public-config` (route-group policy)
3. **V1+V3** — Add `IsAdminUser()` to `/jellyseerr/user`, `/tmdb/validate`, `/jellyseerr/sonarr|radarr|{type}|overrideRule` (or document intent + redact sensitive fields)
4. **V2 (tmdb/validate oracle)** — Confirmed live; immediate consistency fix with sibling validate endpoints
5. **C03-A18** — Don't wipe blocklist when /Users API fails (data-loss bug)
6. **CRIT-6** — Drop `allow-popups-to-escape-sandbox` from docs iframe

## High-impact architecture (2-4 weeks)
1. **B5/D2**: `OnConfigurationUpdated` + `IMemoryCache` migration → eliminates CRIT-3 cluster + 6 supporting bugs
2. **B3**: `ISeerrHttpClient` (named HttpClient + Content-Type guard + UA/Accept/no-redirect) → eliminates CRIT-2 cluster (~13 bugs)
3. **C1**: `Result<T, SeerrError>` envelope → eliminates CRIT-1 cluster + #577 long-tail
4. **A2**: Route-group `[Authorize]` policy → makes future auth bypasses impossible
5. **HostedService**: Migrate monitors → eliminates V1/V2/V3 leak across plugin upgrade

## Frontend refactor (4-8 weeks)
6. **F1**: Extract `DiscoverySection` base class → eliminates 5×3 duplicated bugs in genre/network/tag/person/collection modules
7. **B1**: Extract `IJellyseerrUserResolver` → eliminates user-resolution duplication and its 5+ supporting bugs

## Documentation
8. **F31+F32+F33+F34+F35**: Reverse-proxy / Cloudflare / WAF setup docs + endpoint enumeration + outbound IP allowlisting + Cloudflare HTTPS pitfalls + public-config exposure note

---

# Files audited (absolute paths under /home/jake/JE-seerr-bug-audit/)

## Server (C#)
- `Jellyfin.Plugin.JellyfinEnhanced/Controllers/JellyfinEnhancedController.cs` (6148 lines, 99 routes)
- `Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html` (7688 lines)
- `Jellyfin.Plugin.JellyfinEnhanced/Configuration/PluginConfiguration.cs` (664 lines)
- `Jellyfin.Plugin.JellyfinEnhanced/Helpers/ArrUrlGuard.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/Helpers/Jellyseerr/{JellyseerrPermissionHelper,JellyseerrUserImportHelper}.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/Model/Jellyseerr/{JellyseerrPermission,JellyseerrUser}.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/ScheduledTasks/{JellyseerrUserImportTask,JellyseerrWatchlistSyncTask}.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/Services/{AutoMovieRequestService,AutoMovieRequestMonitor,AutoSeasonRequestService,AutoSeasonRequestMonitor,SeerrScanTriggerService,WatchlistMonitor,StartupService}.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/JellyfinEnhanced.cs`
- `Jellyfin.Plugin.JellyfinEnhanced/PluginServiceRegistrator.cs`

## Client (JS) — `js/jellyseerr/`
- `api.js` (909) · `jellyseerr.js` (613) · `ui.js` (2791) · `modal.js` (281) · `more-info-modal.js` (3178)
- `item-details.js` (747) · `request-manager.js` (421) · `discovery-filter-utils.js` (610)
- `genre-discovery.js` (773) · `network-discovery.js` (846) · `tag-discovery.js` (673)
- `person-discovery.js` (634) · `collection-discovery.js` (325)
- `seamless-scroll.js` (313) · `hss-discovery-handler.js` (47) · `issue-reporter.js` (1140)

## Docs
- `docs/jellyseerr/{jellyseerr-features,jellyseerr-settings}.md`
- `docs/about.md`
- `docs/installation/`
- `SECURITY.md`

## External (referenced but not in JE)
- `/home/jake/Documents/jellyfin-plugin-file-transformation/rewrite/src/Jellyfin.Plugin.FileTransformation/PluginInterface.cs` — root cause of #591

---

# Audit artifacts retained for reference

```
AUDIT/
├── BUGS.md                         (master report — 142 raw findings)
├── FINAL_REPORT.md                 (this file — 70 deduplicated)
├── 01_controller_audit.md          (58 server-side findings)
├── 02_js_frontend_audit.md         (60+ client-side findings)
├── 03_configpage_and_591.md        (25 config-UI + #591 hypothesis)
├── 04_cloudflare_proxy_audit.md    (38 security/proxy findings)
├── 05_invalid_config_tests.md      (live test results, 13 test groups)
├── 06_senior_engineer_review.md    (26 architectural concerns)
├── 07_factual_review.md            (25 spot-checks; 2 refutations)
├── 08_route_auth_audit.md          (99 routes; V1-V3 new bypasses)
├── 09_verification_pass.md         (33 V-findings: V1-V33)
├── 10_consistency_dedup.md         (consistency + redundancy review)
└── _test_helpers.sh                (test scripts for live probing)
```

---

**Audit Status:** COMPLETE.

70 unique root-cause bugs documented. 14 architectural recommendations. 14 live tests run. 5 specialist code reviews + factual + consistency + redundancy passes. Issue #577 root cause identified across 5 distinct paths. Issue #591 root cause traced to FileTransformation upstream. 4 new auth bypasses (V1/V2/V3) discovered during verification, V2 confirmed live as TMDB-key oracle.

After applying the 7 architectural investments, residual bug count drops to ~30 — most of which are tactical fixes that fit naturally into the new architecture.
