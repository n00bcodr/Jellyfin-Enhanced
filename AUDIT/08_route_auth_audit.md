# Verification Pass — Route-by-Route Auth Audit (99 routes)

## Newly discovered HIGH-priority bypasses (NOT in prior audits)

### V1. `GET /jellyseerr/user` (line 1580) leaks full Seerr user roster to any authenticated JF user
**File:** `Controllers/JellyfinEnhancedController.cs:1580`
**Bug:** `[Authorize]` present (any logged-in JF user passes), but body proxies `/api/v1/user?take=1000` with admin Seerr apiKey. Seerr returns full user list including email, username, plexUsername, permissions, userType, requestCount per account. Non-admin can harvest entire roster.
**Severity:** HIGH (information disclosure of email addresses + permission topology)
**Fix:** Add `IsAdminUser()` check at top, OR redact email/permissions for non-admin callers.

### V2. `GET /tmdb/validate` (line 2072) is the only validate-foo endpoint without `IsAdminUser()`
**File:** `Controllers/JellyfinEnhancedController.cs:2072`
**Bug:** Other validate endpoints (`arr/validate/sonarr`, `arr/validate/radarr`, `jellyseerr/validate`) all require admin. `tmdb/validate` requires only `[Authorize]`. Accepts arbitrary apiKey query, makes outbound to api.themoviedb.org. Non-admin can use server as TMDB-key oracle.
**Severity:** HIGH (auth inconsistency + key validation oracle)
**Fix:** Add `IsAdminUser()` check matching sibling validate endpoints.

### V3. Seerr-admin-context endpoints leak admin Seerr data to any JF user
**Files:** `Controllers/JellyfinEnhancedController.cs:926, 933, 940, 1566`
**Bug:** `jellyseerr/sonarr`, `jellyseerr/radarr`, `jellyseerr/{type}/{serverId}`, `jellyseerr/overrideRule` are `[Authorize]`-only. They proxy Seerr admin-context endpoints (`/api/v1/service/*`, `/api/v1/overrideRule`) using the plugin's admin apiKey. Any non-admin JF user can list every Sonarr/Radarr instance, quality profiles, root folders, override rules. May be intentional for "user picks server in advanced request modal" use case, but should be confirmed.
**Severity:** HIGH (Seerr admin data exposure)
**Fix:** Either gate on `IsAdminUser()` (loses advanced-request modal feature for non-admin), OR document the intent and ensure non-admin can only USE this data, not see sensitive metadata. The advanced request modal already filters per-user; consider doing the same here.

## Confirmed prior findings

- F21 (version unauth) → CONFIRMED present line 2113
- F21 (public-config unauth) → CONFIRMED present line 2159
- F23 (issue/{id} permission gate gap) → CONFIRMED present at 3860 (gates only `?` and bare match)

## OK / acceptable

96 of 99 routes have correct auth posture. Static asset routes (`script`, `js/{**path}`, `Configuration/configPage.css`, `locales/{lang}.json`) are intentionally unauth. User-config routes use `AuthorizeUserConfigAccess` (correct).

## Defensive over-restriction

None found — admin checks in GetItemReviews and GetActiveSessions are conditional widening (admin sees hidden authors / IPs), which is correct.
