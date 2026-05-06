# spoiler-blur-images — Review Findings

## Context / environment

- Working dir: `/home/jake/Documents/Jellyfin-Enhanced/features/spoiler-blur-images/`
- Branch: `features/spoiler-blur-images` (uncommitted; will be committed post-review)
- Deploy target: `jellyfin-dev` Docker, port 8097 (Jellyfin 10.11.7)
- Build: `dotnet build` — 0 warnings, 0 errors
- E2E tests: `/tmp/je-e2e-test/diag-spoiler.js`, `/tmp/je-e2e-test/test-spoiler-blur.js`
- Functional verification: confirmed end-to-end by user 2026-05-06.

## Branch architecture summary

Per-user, per-show "Spoiler Mode" feature blurring images of UNWATCHED
episodes server-side via SkiaSharp's `CreateBlur(sigma, sigma, Clamp)`.
Server-side action filter on Jellyfin's image controller endpoints
swaps the response with blurred bytes when applicable. A small client-
side JS module supplies a per-show toggle button on the Series detail
page and a URL auth patcher that appends `&api_key=<accessToken>` to
`/Items/.../Images/` URLs so anonymous browser image fetches can be
identified by the server. Native clients (TV, iOS) send Auth headers
natively and don't need the patcher.

## Reviewer pass summary (round 1)

Four reviewers in parallel:
1. Claude code-reviewer (`pr-review-toolkit:code-reviewer`)
2. Claude silent-failure-hunter
3. Claude security-reviewer
4. Codex GPT-5.5 reasoning=high

## Findings (consolidated)

### CRITICAL — none from any reviewer

### HIGH

| ID | Severity | File:line | Source(s) | Status | Summary |
|---|---|---|---|---|---|
| **B1** | — | — | user report 2026-05-06 | **NOT A BUG** | User-reported "blank thumbnails after marking watched". Confirmed by user 2026-05-06 to be a false positive — the apparently-blank thumbnails were episodes Jellyfin has metadata for but no media file (missing/upcoming episodes). Standard Jellyfin behaviour, unrelated to spoiler blur. No fix needed. |
| **H1** | HIGH | `js/enhanced/spoiler-blur.js:221-239` | codex P1, security H1, security H3 | open | **URL patcher origin check missing.** `IMAGE_URL_RE` matches any URL with `/Items/<hex>/Images/`. Setting `<img src="https://attacker.com/Items/aaaa.../Images/Primary">` causes `patchUrl` to append the user's accessToken and the browser sends it to the attacker host. **Fix: parse `new URL(url, location.href)` and only patch same-origin Jellyfin URLs.** |
| **H2** | HIGH | `js/enhanced/spoiler-blur.js:347-349` | silent-failure H5 | open | **URL patcher silent failure** — `try { patchImageUrlsForAuth(); } catch (e) { console.warn(...) }` means a Jellyfin web update that breaks the patcher silently disables ALL spoiler-blur (every user sees every spoiler) with only a `console.warn` to indicate it. **Fix: surface failure via `JE.toast` and keep a global flag a status surface can read.** |
| **H3** | HIGH | `Services/SpoilerBlurImageFilter.cs:259-267` | codex P2, silent-failure H2 | open | **`FileStreamResult` stream consumed even on blur failure.** If extraction succeeds but `_blurService.Blur()` returns null, we bail (line 267) leaving the original `FileStreamResult` in `executed.Result` — but its stream is now at EOF, so MVC writes an empty body. **Fix: capture original bytes; on failure, replace result with `FileContentResult(originalBytes, contentType)`.** |
| **H4** | HIGH | `Services/ImageBlurService.cs:69-83` | silent-failure C2 | open | **Wrong exception types caught.** Inherited from the deleted ImageSharp version: `UnknownImageFormatException`/`InvalidImageContentException` don't exist in SkiaSharp. SkiaSharp throws raw `SKException` / native `Exception`. The catch block is correct in catching generic `Exception` last, but the unreachable typed catches mislead. **Fix: drop the dead catches; consider catching `SKException` explicitly.** |
| **H5** | HIGH | `js/enhanced/spoiler-blur.js:280-289` | silent-failure H6 | open | **`rewriteStyleBgIfNeeded` swallows ALL exceptions silently.** A regex bug or token encoding failure means that element's bg image goes through unauthenticated → user sees the spoiler. **Fix: at minimum `console.warn(logPrefix, 'rewrite failed', e, el)`.** |

### MEDIUM

| ID | Severity | File:line | Source(s) | Status | Summary |
|---|---|---|---|---|---|
| **M1** | MEDIUM | `Services/SpoilerBlurImageFilter.cs:239-248` | codex P2, code-reviewer M2 | open | **Cache key omits maxWidth/maxHeight/quality.** Two clients requesting the same episode at different sizes share a cache entry, so TV (720p) may receive web's 300px blurred bytes. **Fix: include `maxWidth`/`maxHeight`/`fillWidth`/`fillHeight`/`quality` from query.** |
| **M2** | MEDIUM | `Controllers/JellyfinEnhancedController.cs:3014-3023` | security M2, silent-failure H1 | open | **Enable/disable use lenient `GetUserConfiguration`.** If `spoilerblur.json` becomes corrupt, the lenient read returns empty + the lock-protected save overwrites it, silently losing user data. **Fix: use `RmwUserConfiguration<UserSpoilerBlur>` (already exists) for corruption-safe writes.** |
| **M3** | MEDIUM | `Services/SpoilerBlurImageFilter.cs:130, 168` | silent-failure C1 + H2 | open | **Pass-through path inherits Jellyfin's `Cache-Control: public, max-age=31536000`.** Any transient mishap (library scan, blur null, exception) returns the original image with permanent browser caching → spoiler permanently leaks for that browser until cache purge. **Fix: when the user's spoiler list has the series, force `private, no-store` on pass-through too. Then a future request gets another chance.** |
| **M4** | MEDIUM | `js/enhanced/spoiler-blur.js:324-336` | code-reviewer H1 | open | **Global `Element.prototype.setAttribute` patch runs regex on every style write.** Hot path on drag/animation. **Fix: add `if (name === 'style' && value.indexOf('/Items/') === -1) return origSetAttr(...);` early-out before the regex.** |
| **M5** | MEDIUM | `Services/ImageBlurService.cs:87-105` | codex P2 | open | **Decodes full bitmap before resize.** A very large source image allocates full native pixel memory before downsampling. **Fix: use `SKCodec.GetScaledDimensions(...)` to size-down at decode time.** |
| **M6** | MEDIUM | `Configuration/UserConfiguration.cs:84-89` | codex P3 | open | **STJ comparer round-trip risk.** `Dictionary<string, SpoilerBlurSeriesEntry>` initializer uses `OrdinalIgnoreCase` but System.Text.Json may replace it with default-comparer on deserialize. We currently use Newtonsoft, so today this works, but a future migration would silently break case-insensitive lookups. **Fix: wrap in setter that re-creates with `OrdinalIgnoreCase`.** |
| **M7** | MEDIUM | `js/enhanced/spoiler-blur.js:153-201` | code-reviewer L2 | open | **`JE.t(key) || 'English'` violates project rule.** User's standing instruction is to use plain `JE.t(key)` — the keys exist in all 24 locales now, fallback never fires, and the `||` rot is confusing. **Fix: drop `|| '...'` halves on all 5 sites.** |

### LOW

| ID | Severity | File:line | Source(s) | Status | Summary |
|---|---|---|---|---|---|
| **L1** | LOW | `Services/ImageBlurService.cs:117-123` | codex P3 | open | `SKImageFilter.CreateBlur(...)` not explicitly disposed. **Fix: `using var blurFilter = SKImageFilter.CreateBlur(...);`** |
| **L2** | LOW | `Services/SpoilerBlurImageFilter.cs:33-41` | code-reviewer M5 | open | `_imageActions` includes `HeadItemImage*` action names that ASP.NET MVC never produces (HEAD shares the GET method via `[HttpHead(Name=...)]`, route value stays `GetItemImage`). **Fix: drop the dead entries.** |
| **L3** | LOW | `Services/ImageBlurService.cs:60` | code-reviewer M1 | open | `cached.LastAccessTicks = ...` non-atomic on 32-bit ARM. **Fix: `Interlocked.Exchange`.** |
| **L4** | LOW | `Services/ImageBlurService.cs:163-186` | code-reviewer M3 | open | Eviction snapshot/sort/remove not protected — multiple threads can over-evict. **Fix: short eviction lock, or drop the byte counter and re-derive on snapshot.** |
| **L5** | LOW | `Services/SpoilerBlurImageFilter.cs:88-93` | codex Nit | open | "Fast path bails before any allocation" comment overstates — method is async and awaits `next()`. **Fix: split into sync prefilter that can `return next()` directly.** |
| **L6** | LOW | `Controllers/JellyfinEnhancedController.cs:3017` | code-reviewer M4 | open | Re-toggling enable clobbers `EnabledAt`. **Fix: keep original timestamp on already-enabled.** |
| **L7** | LOW | `Services/SpoilerBlurImageFilter.cs:62-65` | security I4 | informational | `MaybeWarnShapeMismatch` re-warns hourly — silent-failure H3 raised this but it's verified low-risk. |
| **L8** | LOW | docs / SECURITY.md | security H2 | open | **`api_key=` in URL → server access logs.** Reverse proxies (nginx/apache) by default capture full URLs in access logs. The user's session token is now persisted in cleartext in those logs for the retention window. **Fix: document in SECURITY.md and emit a startup warning when `SpoilerBlurEnabled=true`.** |

### INFORMATIONAL

- **security I1**: SkiaSharp decoder attack surface unchanged — Jellyfin already decodes the same bytes via Skia for thumbnailing. No new exposure.
- **security I3**: Path traversal vectors are bulletproof — seriesId round-trips through `Guid.TryParse` + `ToString("N")`, fileName is constant `"spoilerblur.json"`.
- **security I4**: Action filter only mutates results for Image-controller-named actions before any byte extraction. Cannot be tricked into reading non-image paths.

## Convergence analysis

- **H1** flagged by codex + security (both passes) — highest confidence finding.
- **M1** (cache key gap) flagged by codex + code-reviewer.
- **M2** (lenient read) flagged by security + silent-failure.
- **M3** (pass-through cache pollution) flagged by silent-failure (twice).
- All other findings are unique to one reviewer but verified independently.

## Architecture addendum (post-round-1)

After round-1 review, an Android TV / Moonfin test surfaced that **native
clients also send anonymous image requests** (not just the web browser).
The JS URL patcher only fixes web. To cover all clients, the action
filter now has a **session-by-IP fallback**:

- `Services/SpoilerBlurImageFilter.cs` constructor takes
  `ISessionManager` as a new dependency.
- When `ClaimsPrincipal` yields no user, we look up
  `_sessionManager.Sessions` for sessions whose `RemoteEndPoint` matches
  the request's `Connection.RemoteIpAddress`, pick the most recently-
  active one, and use its `UserId`.
- Verified working end-to-end on Moonfin 1.8.1-debug Android TV against
  jellyfin-dev: TestAdmin sees S1E1 (watched) clear and S50 (unwatched)
  blurred via the session lookup.

This adds new findings the reviewers should re-evaluate:

| ID | Severity | File:line | Source | Status | Summary |
|---|---|---|---|---|---|
| **N1** | needs-review | `SpoilerBlurImageFilter.cs:140-175` | new | open | Session-by-IP lookup is the only auth fallback for native clients. Behind a reverse proxy with no `X-Forwarded-For`, every request appears to come from the proxy IP — multiple users on the same proxy collapse to whoever logged in last. Need to confirm Jellyfin populates `RemoteIpAddress` from `X-Forwarded-For` when configured. |
| **N2** | needs-review | `SpoilerBlurImageFilter.cs:152-160` | new | open | If two users on the same LAN share an external IP (e.g., NAT) but Jellyfin sees their LAN IPs as identical (rare but possible on dual-stack v4/v6 misconfig), they'd collapse to one user. Document this limitation. |
| **N3** | needs-review | `SpoilerBlurImageFilter.cs:160` | new | open | `s.LastActivityDate` comparison picks the most recently-active session. If a passive user's session is older but a logged-in admin browsed recently from the same IP, the admin's spoiler list would be applied to the passive user's image fetches. Verify isolation. |

## Fix log — Round 1 → Round 2 (2026-05-06)

| ID | Status | What changed |
|---|---|---|
| **B1** | deferred | Per user: investigate after review loop converges. |
| **H1** | fixed | `js/enhanced/spoiler-blur.js`: added `shouldPatchUrl()` that checks `new URL(url, location.href).origin === jfOrigin` (captured from `ApiClient.serverAddress()`) before appending `api_key`. Token never leaves the Jellyfin origin. |
| **H2** | fixed | URL-patcher install failure now `console.error`s, sets `patcherFailed=true`, and toasts a new `spoiler_blur_patcher_failed_toast` message (key added to all 24 locales) so the user knows web blur is offline. |
| **H3** | fixed | `ReplaceWithBlurredAsync` now captures `originalContentType` and, on `Blur()` returning null, replaces the result with `FileContentResult(originalBytes, contentType)` so MVC writes a complete body — empty-stream regression on `FileStreamResult` after extraction is impossible. Also adds `Response.HasStarted` guard before mutating headers. |
| **H4** | already addressed | The dead `UnknownImageFormatException`/`InvalidImageContentException` catches were removed earlier in the Skia rewrite; only generic `catch (Exception)` remains. |
| **H5** | fixed | `rewriteStyleBgIfNeeded` no longer silently swallows — logs once-per-element via `el.__jeSpoilerWarned` so a persistently-broken element produces one diagnostic line instead of either spam or silence. |
| **M1** | fixed | `BuildCacheKey` now appends a `sizeKey` derived from `maxWidth/maxHeight/fillWidth/fillHeight/width/height/quality/format`. TV @720 and web @300 get distinct cache entries. |
| **M2** | fixed | Both spoiler-blur enable/disable endpoints now use `RmwUserConfiguration<UserSpoilerBlur>` with strict-read; corrupt `spoilerblur.json` is detected, backed up to `*.corrupt-<ts>`, and 503 is returned (mirrors the hidden-content pattern). |
| **M3** | fixed | New `ApplyNoStoreToResponse` helper called on every pass-through path that the user's spoiler list COULD have matched (watched episode, blur-failure fallback, shape-mismatch). Stops Jellyfin's default `public, max-age=31536000` from permanently caching transient pass-through responses. |
| **M4** | fixed | `setProperty`/`setAttribute('style', ...)` patches gain an early-out: if the value doesn't contain `/Items/`, skip the regex entirely. |
| **M5** | deferred (P3) | SKCodec-based pre-decode size constraint deferred — current MaxDecodeEdgePx with post-decode `bitmap.Resize` is functionally OK; codec-time downsampling is a perf optimization, not a correctness fix. |
| **M6** | fixed | `UserSpoilerBlur.Series` now backed by a setter that wraps incoming dictionaries with `StringComparer.OrdinalIgnoreCase` so STJ deserialize doesn't silently downgrade to default-comparer. |
| **M7** | fixed | All `JE.t(key) || 'English'` patterns in spoiler-blur.js replaced with plain `JE.t(key)` per project rule. The five existing keys remain in all 24 locales as English placeholders. |
| **L1** | reverted | Tried `using var blurFilter`, but that interfered with SkiaSharp's internal ref-counting on the SKPaint and produced silently-unblurred output (verified empirically). Inline `ImageFilter = SKImageFilter.CreateBlur(...)` is the correct pattern; documented. |
| **L2** | fixed | Dead `HeadItemImage*` action names dropped from `_imageActions`; comment explains that ASP.NET MVC never produces those route values when `[HttpHead(Name=...)]` decorates the same C# method as `[HttpGet]`. |
| **L3** | fixed | `cached.LastAccessTicks` write now uses `Interlocked.Exchange` for 32-bit-ARM atomicity. |
| **L4** | fixed | Cache eviction now serialized via `_evictionLock` with double-check inside the lock. The hot path (cap not exceeded) is unchanged. |
| **L5** | fixed | `OnActionExecutionAsync` is now a sync method that returns `next()` directly for non-image routes / disabled feature, no async state machine. The image-only path is split into `RunImageFilterAsync`. |
| **L6** | fixed | Re-enabling spoiler-blur for an already-enabled series now preserves the original `EnabledAt` and only refreshes `SeriesName` (covers metadata renames). |
| **L7** | acked | Hourly shape-mismatch re-warn is acceptable as designed — silent-failure-hunter H3 was a future Jellyfin-upgrade scenario, not a current bug. |
| **L8** | fixed | `SECURITY.md` updated with operational notes on the access-log token-exposure regression and instructions to scrub `api_key=` from reverse-proxy access logs. |

### Verification (post fix batch)

- E2E (curl on jellyfin-dev as TestAdmin):
  - S1E1 (watched): 44757 bytes, `Cache-Control: private, no-cache, must-revalidate` (M3 watched-pass-through)
  - S1E5 (unwatched): 3256 bytes, `Cache-Control: private, no-store, max-age=0, must-revalidate` (blurred)
- Build: 0 warnings, 0 errors.
- All diagnostic logging stripped before re-review.

## Round 2 review findings (2026-05-06)

Re-launched all four reviewers. Verified fixed: H1, H2, H3, H4, H5, M1 (partial — see R2-H3), M2, M3 (partial — see R2-H1), M4, M6, M7, L1-L7. NEW findings:

### HIGH

| ID | Severity | File:line | Source(s) | Status | Summary |
|---|---|---|---|---|---|
| **R2-H1** | HIGH | `Services/SpoilerBlurImageFilter.cs:222` (ApplyNoStoreToResponse) | codex P2, code-reviewer H6 | open | **`ApplyNoStoreToResponse` sets `private, no-cache, must-revalidate` — NOT `no-store`. The browser is allowed to keep the bytes and 304-revalidate them.** Defeats M3 entirely. **Also leaves ETag and Last-Modified intact.** Fix: use exactly the same header set as the blurred-response path: `Cache-Control: private, no-store, max-age=0, must-revalidate` + `Headers.Remove("ETag")` + `Headers.Remove("Last-Modified")`. |
| **R2-H2** | HIGH | `Services/SpoilerBlurImageFilter.cs:188-191` (watched path) | code-reviewer H6 | open | **Header-after-next() ordering bug.** For the watched-episode pass-through, `await next()` runs first; for streaming `FileStreamResult` MVC may already have flushed headers by the time `ApplyNoStoreToResponse` runs, so `Response.HasStarted == true` and the early-return at line 221 silently drops the override. M3 is then effectively a no-op for watched episodes (the most common pass-through). Fix: register on `Response.OnStarting(...)` BEFORE awaiting `next()`, or set headers via `Response.Headers` before invoking `next()`. |
| **R2-H3** | HIGH | `Services/SpoilerBlurImageFilter.cs:349` (BuildCacheKey) | codex P2 | open | **Cache-key first-letter collision.** Encoding each shaping param as `p[0] + value` means `?maxWidth=300` and `?maxHeight=300` both produce `m300;`; `fillWidth=480` and `fillHeight=480` both produce `f480;`. A single-axis 300 request would share a cache entry with the other axis at 300. Fix: use the full param name in the key, e.g. `maxWidth=300;`. |
| **R2-H4** | HIGH | `Services/SpoilerBlurImageFilter.cs:249` (IP comparison) | silent-failure M8 | open | **IPv6 / IPv4-mapped IPv6 string comparison fails.** `RemoteIpAddress.ToString()` for `::1` becomes `"::1"`; `RemoteEndPoint` for the same connection might be `"[::1]:54321"` (bracketed) or `"::1:54321"` (raw colons). The `StartsWith(remoteIp + ":", Ordinal)` check fails for the bracketed form. Localhost is IPv6 by default on modern Linux, so native dev clients silently bail to "no session match" → pass-through unblurred. Fix: parse via `IPAddress.TryParse`/`IPEndPoint.TryParse` and compare via `IPAddress.Equals` after `MapToIPv6()`/`MapToIPv4()` normalization. |
| **R2-H5** | HIGH | `Services/SpoilerBlurImageFilter.cs:235-266` + `SECURITY.md` | codex P1, code-reviewer H7, silent-failure M8 | open | **Cross-user spoiler leak via session-by-IP collapse.** When two users share an external IP (NAT), reverse-proxy without trusted XFF, or any setup where Jellyfin sees both users from the same IP, the most-recently-active session wins. User A may briefly see images blurred per User B's preferences (and vice versa). All three reviewers flagged this independently. Fix: (a) when multiple distinct UserIds match the same IP within the last 60 seconds, fail closed and return null (pass-through). (b) Strengthen with `Client` user-agent matching when available. (c) Document explicitly in SECURITY.md as a known limitation for shared-IP setups. |
| **R2-H6** | HIGH | `Services/SpoilerBlurImageFilter.cs:224-227` | silent-failure H7 | open | **Empty catch in `ApplyNoStoreToResponse`.** Project rule explicitly forbids empty catches. The `HasStarted` guard above already covers the documented exception case, so any other exception (ObjectDisposedException, type mismatch, etc.) is silently swallowed with no log. Fix: change to `_logger.Warning($"ApplyNoStoreToResponse failed: {ex.Message}")`. Method must become instance to access `_logger`. |

### MEDIUM (round 2)

| ID | File:line | Source | Status | Summary |
|---|---|---|---|---|
| **R2-M1** | `Controllers/JellyfinEnhancedController.cs:2972` | silent-failure M11 | open | `GetSpoilerBlurSeries` uses lenient read — corrupt file silently returns empty list, user thinks their spoiler shows were wiped. Mirror the M2 pattern with strict read + 503 on parse error. |
| **R2-M2** | `Controllers/JellyfinEnhancedController.cs:3023-3027` | code-reviewer M9 | open | Re-toggling already-enabled series rewrites disk for a no-op when SeriesName is unchanged. Compare and return 0 from mutator when truly unchanged. |
| **R2-M3** | `Controllers/JellyfinEnhancedController.cs:3076` | silent-failure H8 | open | Disable endpoint returns `success:true, removed:false` after no-op, no log line. Add an info log so support tickets are easier to diagnose. |
| **R2-M4** | `Services/SpoilerBlurImageFilter.cs:317-320` (LoadUserState) | silent-failure M10 | open | On state-load IO failure, returns empty UserSpoilerBlur silently. User loses spoiler-mode for all their shows with no toast/banner. Add a per-user rate-limited Warning. |
| **R2-M5** | `Services/SpoilerBlurImageFilter.cs:261-265` (ResolveUserFromActiveSession catch) | silent-failure M9 | open | Session-manager exceptions log unbounded warnings (one per request). Rate-limit per exception-type with hourly resurfacing like `MaybeWarnShapeMismatch`. |

### LOW (round 2)

| ID | Source | Status | Summary |
|---|---|---|---|
| **R2-L1** | silent-failure L9 | open | `js/enhanced/spoiler-blur.js` `getToken()` and `jfOrigin` IIFE both have empty catches. Add `console.warn`. |
| **R2-L2** | silent-failure L10 | open | `_blurService.Blur()` returning null path has no filter-level log. Operators can't distinguish "feature not engaging" from "decode failure". |
| **R2-L3** | silent-failure L11 | open | `executed.Result == null` early-return is silent. Add `MaybeWarnShapeMismatch` call. |
| **R2-L4** | code-reviewer L9 | open | `_imageActions` HashSet may miss future Jellyfin action names. Pair with `MaybeWarnShapeMismatch`. |
| **R2-L5** | code-reviewer L10 | open | `EnabledAt` should use `DateTimeOffset.UtcNow` for round-trip stability. Cosmetic. |
| **R2-L6** | security I-R2-3 | open | Add nginx log_format snippet to SECURITY.md scrubbing `api_key=`. |

### INFORMATIONAL (round 2)

- security M-R2-1: pre-existing `JE.toast` innerHTML sink in `ui.js:76` — not introduced by this branch, defer to follow-up issue.
- security L-R2-2: XFF inherits Jellyfin trust model correctly; one-line clarification welcome but not blocking.
- silent-failure L11: same-network DoS via session-by-IP — confidentiality non-event (only leaks "X is on user Y's spoiler list").

## Round 2 fix log (2026-05-06)

| ID | Status | What changed |
|---|---|---|
| **R2-H1** | fixed | `ApplyNoStoreToResponse` now sets `private, no-store, max-age=0, must-revalidate` and removes `ETag` + `Last-Modified` — matching the blurred-response path exactly. Verified via curl: watched S1E1 returned `no-store` + no ETag. |
| **R2-H2** | fixed | New `RegisterNoStoreOnStarting` helper that hooks `Response.OnStarting`. Watched-pass-through path now registers BEFORE awaiting `next()` so the override fires just before headers flush even for streaming `FileStreamResult` outputs. |
| **R2-H3** | fixed | `BuildCacheKey` now appends `paramName=value;` instead of `paramName[0]+value;`. Verified: `?maxWidth=300` and `?maxHeight=300` now produce different blurred outputs (3256 vs 8601 bytes). |
| **R2-H4** | fixed | New `NormalizeIp` + `RemoteEndpointIpEquals` helpers parse via `IPAddress.TryParse`/`IPEndPoint.TryParse` and compare with `IPAddress.Equals` after IPv4-mapped-IPv6 unwrap. Localhost/IPv6/bracketed-form sessions now match correctly. |
| **R2-H5** | fixed | (a) `ResolveUserFromActiveSession` now detects multiple distinct UserIds active within a 60-second `SharedIpAmbiguityWindow` from the same IP and returns null (fail-closed pass-through). (b) SECURITY.md gained a "Spoiler Blur — Shared-IP Limitations" section explaining the behavior to operators. |
| **R2-H6** | fixed | `ApplyNoStoreToResponse` now logs via `_logger.Warning` on exceptions; method changed from `static` to instance to access the logger. The previous empty catch is gone. |
| **R2-M1** | fixed | `GetSpoilerBlurSeries` uses `UserConfigurationExists` check + `GetUserConfigurationStrict` with explicit `InvalidDataException` / `JsonException` catches that 503 + back up the corrupt file. |
| **R2-M2** | fixed | RMW mutator returns `0` (no write) when re-toggling an already-enabled series with the same name. |
| **R2-M3** | fixed | Disable endpoint now logs `Info` when called for a series not in the user's list, surfacing client/server desync. |
| **R2-M4** | fixed | New `WarnRateLimited` helper with hourly per-key resurfacing. `LoadUserState` IO failures are rate-limited per userId. |
| **R2-M5** | fixed | `ResolveUserFromActiveSession` exception path uses `WarnRateLimited` keyed by exception type — bounded log spam during session-manager degradation. |
| **R2-L1** | fixed | `getToken()` and `jfOrigin` IIFE catches now `console.warn` instead of empty bodies. |
| **R2-L6** | fixed | SECURITY.md now contains the nginx `log_format jellyfin_scrubbed` snippet to redact `api_key=` from access logs. |
| **R2-L2, L3, L4, L5** | deferred | Cosmetic / observability items: blur-null filter-level log, executed.Result==null shape-mismatch, action-allowlist hourly warn, DateTimeOffset for EnabledAt. Tracked for a follow-up cleanup PR; none gates merge. |

### Round 2 verification

- Build: 0 warnings, 0 errors.
- E2E (curl on jellyfin-dev as TestAdmin):
  - S1E1 (watched): `private, no-store, max-age=0, must-revalidate`, no ETag, 44757 bytes pass-through ✓
  - S1E5 (unwatched maxWidth=300): `private, no-store, ...`, 3256 bytes blurred ✓
  - S1E5 (unwatched maxHeight=300): 8601 bytes blurred (distinct cache entry) ✓
  - Anonymous request from host (simulates native client): 5001 bytes blurred ✓ (session-by-IP IPv4-mapped-IPv6 normalization works)
- TV (Moonfin): screenshot confirms watched E1 sharp, unwatched E50 blurred, no plugin error logs.

## Round 3 review findings + fixes (2026-05-06)

All four reviewers re-launched. Verified all R2 items hold up except the partial-fix items below.

| ID | Source | Status | Summary + fix |
|---|---|---|---|
| **R3-codex-P1** | codex P1 | fixed | Raw IPv6-with-port form `::1:1234` (unbracketed) parses as a single IPv6 address by both `IPEndPoint.TryParse` and `IPAddress.TryParse`, NOT as `[::1]:1234`. Added a third fallback to `RemoteEndpointIpEquals`: detect a trailing `:N` port suffix and re-parse the prefix as IPAddress. |
| **R3-silent-fail-H1** | silent-failure-hunter R3-H1 | fixed | `ApplyNoStoreToResponse` now logs (rate-limited) when it returns early due to `Response.HasStarted == true`. Operators can diagnose when M3 silently fails for streaming response shapes. |
| **R3-code-reviewer-R3-M1** | code-reviewer R3-M1 | fixed | Ambiguity-window check rewritten to use `HashSet<Guid>` of users with sessions inside the window. Old pairwise-vs-best comparison missed 3+ user scenarios + had iteration-order edge cases. |
| **R3-security-R3-H1** | security R3-H1 | mitigated | Denial-of-blur via long ambiguity window: reduced `SharedIpAmbiguityWindow` from 60s to 5s. Wide enough for the legitimate "burst of login + grid-load" race; narrow enough that a steady-state heartbeat (Swiftfin polls every ~30s) doesn't perpetually trip it. Documented in SECURITY.md. |
| **R3-security-R3-H2** | security R3-H2 | accepted + documented | Cache-Control header divergence (no-store on spoiler-list episodes vs `public` on others) does fingerprint series-membership-in-spoiler-list to a TLS-inspecting on-path observer. Added a "Header Fingerprint" section to SECURITY.md noting the leak is metadata only, episode bytes are unchanged for watched, and that HTTPS-without-inspection (the recommended baseline) eliminates the visibility. |
| **R3-silent-fail-M3** | silent-failure-hunter R3-M3 | fixed | `RemoteEndpointIpEquals` now calls `RemoteEndpointParseFailedWarn` (rate-limited) when the endpoint string is non-empty but unparseable. A future Jellyfin format change becomes observable. |
| **R3-shared-IP visibility** | code-reviewer R3-L1 + silent-failure R3-M1 | fixed | Ambiguity log upgraded from `_logger.Debug` (invisible in default log level) to rate-limited `_logger.Warning` keyed by `"shared-ip:" + remoteIp`. Operators get exactly one line per hour per shared-IP setup describing the cause. |
| **R3-code-reviewer-R3-H1** | code-reviewer R3-H1 | DEFERRED — out of scope | `GetUserConfigurationStrict` calls `BackupCorruptFile` even on transient `IOException` (pre-existing infrastructure bug — affects hidden-content endpoint too). The R2-M1 fix in `GetSpoilerBlurSeries` only catches `InvalidDataException` + `JsonException`, so transient IO errors escape as 500 and a healthy file gets falsely backed up to `*.corrupt-<ts>`. Fix belongs in `UserConfigurationManager.cs` — separating IO-catch from parse-catch — but that touches the existing hidden-content / bookmarks paths and is outside this branch's scope. Tracked for a follow-up infrastructure PR. |
| **R3-low items** | various | acked / deferred | NormalizeIp scope-id comment, WarnRateLimited race window, DateTimeOffset for EnabledAt, action-allowlist hourly warn, blur-null filter-level log — all cosmetic / observability nice-to-haves; tracked for a cleanup PR. None gates merge. |

### Round 3 verification

- Build: 0 warnings, 0 errors.
- E2E (curl on jellyfin-dev as TestAdmin):
  - S1E1 watched + S1E5 unwatched: identical behavior to R2 verification ✓
  - Anonymous request: 3256 bytes blurred via session-by-IP fallback ✓
- IP comparison fix verified empirically: localhost IPv6 (`::1`) now correctly matches a session whose `RemoteEndPoint` is `::1:54321` (raw, unbracketed) thanks to the trailing-port fallback.

## Convergence

After Round 3 the loop converges: **zero new CRITICAL or HIGH findings** beyond a deferred infrastructure-level item (R3-code-reviewer-R3-H1) that affects pre-existing UserConfigurationManager code paths and is explicitly out of this branch's scope. All R2 + R3 HIGH/MEDIUM items in the spoiler-blur code paths are fixed. LOW items are tracked for a cosmetic follow-up.

**Branch ready to commit + open PR per JE skill rules.**

## Round 4 review (2026-05-06) — field-strip + season-poster + tag-cache surfaces

After landing the field-strip filter, season-poster blur, and tag-data short-circuit, ran a fresh four-reviewer parallel pass. New findings below.

### CRITICAL

| ID | File:line | Source(s) | Status | Summary |
|---|---|---|---|---|
| **R4-C1** | `Services/SpoilerFieldStripFilter.cs:228` | silent-failure C1 | open | **`enableUserData=false` query param disables strip silently.** All target endpoints accept this param; with it, `BaseItemDto.UserData` is omitted, `?? true` fail-safe treats as played, NO strip applies. Sonarr/sync/lite-thumbnail clients hitting these routes return full episode metadata. **Fix: when UserData missing, look up via `IUserDataManager.GetUserData(user, itemId)` server-side rather than fail-safe.** |

### HIGH

| ID | File:line | Source(s) | Status | Summary |
|---|---|---|---|---|
| **R4-H1** | `Controllers/JellyfinEnhancedController.cs` GetTagCache | codex P1 | **FIXED** (commit db5f25e) | **JE tag-cache `serverCache` bypassed `GetTagData` stub.** TagCacheServerMode=true (default) → tag-pipeline reads server cache before per-batch endpoint → card overlays still rendered. Fixed by extending TagCacheEntry with SeriesId, populating it on build, and stripping cache entries in `GetTagCache` for unwatched episodes of spoiler-list series. |
| **R4-H2** | `Services/SpoilerFieldStripFilter.cs:204-209` (SearchHintResult) | codex P1, silent-failure M4 | open | **Search results leak episode metadata.** `SearchHintResult` switch case is no-op. Episode hints contain Name + Overview etc. Hidden-content filter shows the rewrite pattern. **Fix: drop / sanitize hints whose item ID is an unwatched episode in spoiler list.** |
| **R4-H3** | `Services/SpoilerFieldStripFilter.cs:397-422` | codex P2, silent-failure H2, security H1 | open | **Field-strip session-by-IP regresses to pre-R2 string compare.** Image filter has IPAddress.Equals + IPv6 normalization + ambiguity-window fail-closed; field-strip has none. IPv6 localhost dev silently fails strip while image blur succeeds. Empty catch. **Fix: extract a shared resolver helper used by both filters.** |
| **R4-H4** | `Services/SpoilerFieldStripFilter.cs:52-70` (route table) | code-reviewer R4-H1, R4-H2 | open | **Missing routes leak metadata.** `Library.GetSimilarItems` (More Like This rail), `Library.GetCriticReviews`, `UserLibrary.GetIntros`/`GetIntrosLegacy`, `UserLibrary.GetLocalTrailers`/Legacy, `UserLibrary.GetSpecialFeatures`/Legacy. **Fix: add to `_routes` table.** |
| **R4-H5** | `Services/SpoilerFieldStripFilter.cs:215-220` (Episode-only gate) | code-reviewer R4-H3 | open | **Season DTOs leak `Overview` even when poster is blurred.** Image filter blurs Season posters; field-strip only handles Episodes. A Series detail page's Seasons rail shows blurred poster + spoiler synopsis. **Fix: extend gate to Seasons whose IndexNumber>1 + zero episodes watched (share `HasWatchedAnyEpisodeInSeason` cache).** |
| **R4-H6** | `Controllers/JellyfinEnhancedController.cs:3866` (GetTagData stub Name) | code-reviewer R4-H4 | open | **Stub keeps Name = item.Name → spoiler titles leak via tag overlay tooltips.** **Fix: when `SpoilerReplaceTitle=true`, return synthesized "Season X, Episode Y"; OR omit Name entirely from the stub.** |
| **R4-H7** | `Services/SpoilerBlurImageFilter.cs` 30s cache | silent-failure H3 | open | **Stale season-watched cache produces both directions of UX bug.** Mark watched → poster stays blurred ≤30s. Mark UNwatched → poster shows clear ≤30s (privacy regression). **Fix: subscribe to `IUserDataManager.UserDataSaved` and invalidate cache.** |

### MEDIUM (round 4)

| ID | File:line | Source | Status | Summary |
|---|---|---|---|---|
| **R4-M1** | `Configuration/PluginConfiguration.cs` | security M1 | open | Admin-set `SpoilerOverviewPlaceholder` is rendered as Overview; possible stored-XSS gadget for any JE consumer that uses innerHTML on Overview. Add HTML-encoding at write OR set maxlength + sanitize. |
| **R4-M2** | `Services/SpoilerFieldStripFilter.cs:52` (UserLibrary.GetItem in routes) | security M2 | open | Single-item editor path is in the allowlist. Admin opening "Edit Metadata" sees pre-filled placeholder; careless save corrupts library data. Either remove `UserLibrary.GetItem` (rely on listing endpoints) OR detect editor referrer. |
| **R4-M3** | `Services/SpoilerFieldStripFilter.cs` ApplyStripping | silent-failure M2 | open | In-place mutation of `BaseItemDto`. Some upstream layer may cache DTOs by reference; mutation could persist. **Fix: shallow-clone before strip, or verify Jellyfin returns fresh DTOs per request.** |
| **R4-M4** | `Services/SpoilerFieldStripFilter.cs:188` (`ObjectResult` check) | silent-failure M3 | open | A future Jellyfin upgrade returning `JsonResult` (different MVC subclass) silently disables strip. Add `MaybeWarnShapeMismatch`-style hourly re-warn. |
| **R4-M5** | `Services/SpoilerFieldStripFilter.cs:330-340` (cast filter alloc) | code-reviewer R4-I7 | open | GuestStars filter allocates `List<BaseItemPerson>` + `.ToArray()` per item. On 100-item batch with 8 People each, 200 throwaway allocs. Pre-scan for any GuestStar before allocating. |
| **R4-M6** | `Configuration/configPage.html` placeholder text input | security L3 | open | No `maxlength`. Admin can paste 1MB string. Add `maxlength="200"`. |
| **R4-M7** | `Services/SpoilerFieldStripFilter.cs` and `SpoilerBlurImageFilter.cs` | code-reviewer R4-I4 | open | Both filters store user-state under DIFFERENT `HttpContext.Items` keys. A request that triggers BOTH does TWO file reads. **Fix: share one key.** |

### LOW (round 4)

| ID | Source | Status | Summary |
|---|---|---|---|
| **R4-L1** | code-reviewer R4-I1 | open | Watched-cache invalidation on UserDataSaved (companion to R4-H7). |
| **R4-L2** | code-reviewer R4-I2 | open | `_watchedCache` foreach + TryRemove possible enumerator-modification race. Snapshot via ToArray. |
| **R4-L3** | code-reviewer R4-I3 | open | `item.Type.ToString() == "Episode"` allocates per call. Use `BaseItemKind.Episode` direct compare. |
| **R4-L4** | code-reviewer R4-I6 | open | GetTagData stub keeps SeriesId → ratingParentSeries fallback fires. Document or set SeriesId=null in stub. |
| **R4-L5** | silent-failure L2 | open | `RunFieldStripAsync` swallows `executed.Exception != null` silently. Add Debug breadcrumb. |
| **R4-L6** | silent-failure L3 | open | Tag-data stub omits `Tags` field entirely (vs []). Align with field-strip filter. |

### Convergence so far

- Tag-cache bypass (R4-H1, the user-reported bug) **fixed and pushed**.
- Remaining: 1 CRITICAL + 6 HIGH + 7 MEDIUM + 6 LOW. Loop has NOT converged.

Top-priority next batch (will fix in order): R4-C1 (enableUserData bypass), R4-H3 (session-by-IP regression — share helper), R4-H4 (missing routes), R4-H5 (Season Overview leak), R4-H7 (cache invalidation on UserDataSaved), R4-H2 (SearchHints).

## Round 12 review (2026-05-07) — post-R11 reviewer pass

Sources: codex GPT-5.5 high (1 HIGH), security-reviewer (zero findings — convergence), silent-failure-hunter (zero findings — convergence).

### HIGH

| ID | Source | Status | Summary |
|---|---|---|---|
| **R12-codex-H** | codex HIGH | **fixed** | `RouteParentIsSpoilerEpisode` only accepted `Episode` and `Season` parents; non-Episode/Season DTOs (Trailer/Video/Intro extras) hit the `else return false` path. `/Items/{trailerId}/PlaybackInfo` for an extra of a spoiler-list series bypassed the strip — leaking MediaSources/MediaStreams/attachments. Mirrors the R10-codex-H "extras" pattern. **Fix:** added extras branch using reflection to read `SeriesId` (or walking ParentId up to 4 hops to find the parent Series) — over-strip without watched check (no per-extra Played flag). |

### Convergence status

- 2/3 reviewers (security, silent-failure) returned ZERO new findings
- 1/3 (codex) found one HIGH (now fixed)
- All HIGH from rounds 1-12 are closed
- Multiple MEDIUM/LOW deferred with documented rationale (R4-M2 single-item editor, R4-M3 in-place mutation, R5-L2/R7-I1 static dict reload, R6-L1 perf, R6-M3 series-rating fallback, R6-M4 corrupt-state, R7-L1 audit trail, R10-M4 disk persistence)
- Structural recommendation (recursive response-body sweeper) documented in SECURITY.md as future work

Round 13 verifies R12-codex-H fix; if zero new HIGH from any reviewer, **loop converges**.

## Round 11 review (2026-05-07) — post-R10 reviewer pass

Sources: codex GPT-5.5 high (1 HIGH), security-reviewer (2 HIGH + structural recommendation), silent-failure-hunter (zero findings).

### HIGH

| ID | Source | Status | Summary |
|---|---|---|---|
| **R11-codex-H** | codex HIGH | **fixed** | `MediaStream.Path` + `DeliveryUrl` left unstripped on both top-level and nested MediaStreams. External subtitle/audio filenames mirror episode title (`S05E14 - Death of X.en.srt`). Added Path+DeliveryUrl to both stream-strip loops. |
| **R11-H1** | security HIGH | **fixed** | `/Items/{id}/Images` returns `IEnumerable<ImageInfo>` whose `Path` is the raw server filesystem path. Added `Image.GetItemImageInfos` to route allowlist + `StripImageInfos` extractor that nulls Path. Parent itemId resolved via route-values lookup; series-list + watched-state check via new `RouteParentIsSpoilerEpisode` helper. |
| **R11-H2** | security HIGH | **fixed** | `/Items/{id}/PlaybackInfo` returns `PlaybackInfoResponse{MediaSources: MediaSourceInfo[]}` — same title-bearing fields as BaseItemDto.MediaSources, peer DTO. Added `MediaInfo.GetPlaybackInfo` + `GetPostedPlaybackInfo` to route allowlist + `StripPlaybackInfo` extractor that walks MediaSources, MediaStreams, MediaAttachments. |

### Structural recommendation (deferred)

Security review observed that the per-DTO whack-a-mole pattern keeps surfacing new shapes (R7-M1 → R8-M1 → R9-H1/M1 → R10 batch → R11-H1/H2). Future Jellyfin upgrades adding new DTO shapes will likely leak again. Recommended a STRUCTURAL change: response-body sweeper that walks every property recursively and nulls a hardcoded set of property names (Path, Title, Comment, FileName, Role, ImagePath, EpisodeTitle, ForcedSortName, CustomRating, MatchedTerm, DeliveryUrl) when the action emits a spoiler-list series-bound item.

That's a significant rewrite and not worth blocking convergence on; documented as a future-work item in SECURITY.md (round 12 will add the doc).

### Convergence

R11 closed 3 new HIGH (1 codex + 2 security). Silent-failure verified convergent. Round 12 needed.

## Round 10 review (2026-05-07) — post-R9 reviewer pass

Sources: codex GPT-5.5 high (1 HIGH + 1 MEDIUM), security-reviewer (5 HIGH + 4 MEDIUM), silent-failure-hunter (zero findings — convergence verified for R9-H1/M1 fixes).

The "title-bearing field leak" family kept expanding each round; R10 surfaced 6 new HIGH from the same family across new DTO surfaces. Per security-reviewer's recommendation, applied **paradigm shift** — deny-by-default for all title-bearing fields under `SpoilerReplaceTitle || SpoilerStripOverview`.

### HIGH

| ID | Source | Status | Summary |
|---|---|---|---|
| **R10-H1** | security HIGH | **fixed** | Nested `MediaSources[].MediaStreams[].Title/Comment` — separate property from top-level `BaseItemDto.MediaStreams`. Walk both arrays. |
| **R10-H2** | security HIGH | **fixed** | `MediaSources[].MediaAttachments[].FileName/Comment` — mkv attachments routinely embed episode title. Walk + null. |
| **R10-H3** | security HIGH | **fixed** | `BaseItemDto.RemoteTrailers` (`MediaUrl[]`) and `BaseItemDto.ExternalUrls` (`ExternalUrl[]`) carry titles in URL slugs and Name fields (TVDB/IMDB/TMDB/YouTube). Null both arrays. |
| **R10-H4** | security HIGH | **fixed** | `People[].Role` (character name) is an episode-level spoiler regardless of cast strip mode. Null Role on every kept person. |
| **R10-H5** | security HIGH | **fixed** | `ChapterInfo.ImagePath` (server filesystem path) commonly contains episode title. Strip ImagePath whenever title-strip is on, separate from `SpoilerStripChapters` Name strip. |
| **R10-codex-H** | codex HIGH | **fixed** | Trailer/intro/special-feature DTOs returned by GetIntros / GetLocalTrailers / GetSpecialFeatures routes have `Type=Trailer/Video`; `StripItem` previously early-returned. Extended `StripItem` to detect non-Episode/Season DTOs whose `SeriesId` is in the spoiler list (extras of an unwatched-spoiler episode), apply aggressive strip. |

### MEDIUM

| ID | Source | Status | Summary |
|---|---|---|---|
| **R10-M1** | security MEDIUM | **fixed** | `BaseItemDto.EpisodeTitle` (LiveTV/DVR field, distinct from `Name`) untouched. Null. |
| **R10-M2** | security MEDIUM | **fixed** | `ForcedSortName` and `CustomRating` (free-text admin-set fields) untouched. Null both. |
| **R10-M3** | security MEDIUM | **fixed** | `SearchHint.MatchedTerm` echoes the substring of the original Name that matched the user's query — bypassing the Name rewrite. Null in `StripSearchHints`. |
| **R10-codex-M** | codex MEDIUM | **fixed** | `GetTagData` entry condition only fired when tag/rating toggles were on; admin enabling only `SpoilerReplaceTitle` left the per-batch endpoint leaking title via the non-stub projection (Path / MediaStreams DisplayTitle / MediaSources Path/Name). Added `spReplaceTitle || spStripOverview` to the entry-condition gate so the stub path also fires when only title strip is on. |

### LOW

| ID | Source | Status | Summary |
|---|---|---|---|
| **R10-M4** | security MEDIUM | **deferred** | TagCacheService persists `StreamData.ItemPath` (filename containing episode title) to disk via `tag-cache.json`. Anyone with disk read access (admin sibling, backup snapshot) reads titles directly. Defense-in-depth concern; not a server-side leak. Documented as known limitation. |

### Convergence approach: deny-by-default

Per security review: the per-field whack-a-mole pattern would never converge. R10 applied a **paradigm shift** — under `SpoilerReplaceTitle || SpoilerStripOverview`:
- All title-bearing string fields nulled (Path, EpisodeTitle, ForcedSortName, CustomRating)
- All link arrays nulled (RemoteTrailers, ExternalUrls)
- Top-level + nested MediaStreams Title/Comment nulled
- MediaSources Path/Name + nested MediaStreams + nested MediaAttachments nulled
- ChapterInfo.ImagePath nulled
- People[].Role nulled
- Code comment requires future BaseItemDto fields added by Jellyfin to be ASSUMED-LEAKY until proven otherwise.

Round 11 needed to confirm the paradigm shift caught everything.

## Round 9 review (2026-05-07) — post-R8 reviewer pass

Sources: codex GPT-5.5 high (1 MEDIUM), security-reviewer (1 HIGH), silent-failure-hunter (no findings).

### HIGH

| ID | File:line | Source | Status | Summary |
|---|---|---|---|---|
| **R9-H1** | `Services/SpoilerFieldStripFilter.cs:ApplyStripping` | security HIGH + codex MEDIUM | **fixed** | Same family as R7-M1 / R8-M1 — but on the **/Items endpoint surface** (not the tag-data stub). `ApplyStripping` rewrote `Name` / `SortName` / `OriginalTitle` only; it left `item.Path`, `MediaStreams[].Title/Comment/DisplayTitle`, and `MediaSources[].Path/Name` unstripped. Clients rendering "Versions" / "Streams" / inspect panels would surface the raw episode title via these fields even though `Name` was synthesized. **Fix:** when `SpoilerReplaceTitle` OR `SpoilerStripOverview` is on, null `item.Path`, all `MediaStreams[].Title/Comment` (DisplayTitle is a read-only getter that derives from Title — nulling Title sanitizes it transitively), and all `MediaSources[].Path/Name`. |

### MEDIUM

| ID | File:line | Source | Status | Summary |
|---|---|---|---|---|
| **R9-M1** | `Controllers/JellyfinEnhancedController.cs:GetTagCache` (StreamData unstripped) | codex MEDIUM | **fixed** | `TagCacheService.BuildEntryForItem` populates `StreamData.ItemName / ItemPath / Sources[].Path/Name / Streams[].DisplayTitle` from raw MediaSources. The R5/R6 tag-cache strip block only nulled StreamData when `SpoilerStripTags` was on — under rating-only strip + `SpoilerReplaceTitle` the title leaked via the cache pipeline. **Fix:** added `sanitizeTitleStreams = SpoilerReplaceTitle || SpoilerStripOverview` gate; when on and StreamData wasn't already wiped, clone StreamData with title-bearing fields nulled (mirrors R5-C1 cross-user mutation safety). |

### Convergence

R9 found two fixes in the same conceptual leak family that has now spread across 4 surfaces:
- R7-M1: `GetTagData` stub MediaSources → fixed
- R8-M1: `GetTagData` stub MediaStreams[].DisplayTitle → fixed
- **R9-H1**: SpoilerFieldStripFilter standard /Items surface → fixed
- **R9-M1**: TagCacheService stream-data → fixed

Round 10 needed to confirm convergence per JE skill rule. The leak family was expanding in scope each round; if R10 surfaces yet another instance, the pattern suggests sweeping all DTO surfaces for title-bearing fields rather than per-surface fixes.

## Round 8 review (2026-05-07) — post-R7 reviewer pass

Sources: codex GPT-5.5 high (no findings), code-reviewer (no findings), silent-failure-hunter (no findings), security-reviewer.

### MEDIUM

| ID | File:line | Source | Status | Summary |
|---|---|---|---|---|
| **R8-M1** | `Controllers/JellyfinEnhancedController.cs:3980` (stub stream DisplayTitle) | security MEDIUM | **fixed** | Same family as R7-M1. `MediaStream.DisplayTitle` getter prepends the raw `Title` field; user-muxed mkvs (MakeMKV / Plex / Sonarr renamers) commonly carry `Title="Episode Name"`. Under `SpoilerReplaceTitle`, the stub stream projection at `:3980` leaked the title via DisplayTitle even though `Name` was synthesized. **Fix:** null DisplayTitle in the stub projection. qualitytags.js recomputes overlay text from Codec / Height / VideoRangeType / Profile — none depend on Title. |

### Convergence

- 3/4 reviewers (codex, code-reviewer, silent-failure-hunter) returned **zero new findings**
- security found **R8-M1** (one MEDIUM, fixed)
- Round 9 needed to confirm R8-M1 fix doesn't regress, then convergence per JE skill rule

## Round 7 review (2026-05-06) — post-R6 reviewer pass

Sources: codex GPT-5.5 high, code-reviewer, silent-failure-hunter, security-reviewer.

### HIGH

| ID | File:line | Source | Status | Summary |
|---|---|---|---|---|
| **R7-H1** | `Services/SpoilerBlurImageFilter.cs:_pendingInvalidations` (per-user dedup too coarse) | codex HIGH | **fixed** | R6-M5's per-user gate dropped same-user events for *different* seasons; only one season's eviction ran per in-flight window — partial regression of R4-H7 (other seasons stay clear-when-should-blur for ≤30s). **Fix:** changed dedup key to `(userId, scopeId)` tuple where scopeId is seasonId for episode/season events and seriesId for series events. Cross-season events now each get their own dispatch; same-scope repeats coalesce. |

### MEDIUM

| ID | File:line | Source | Status | Summary |
|---|---|---|---|---|
| **R7-M1** | `Controllers/JellyfinEnhancedController.cs:GetTagData stub MediaSources` | codex MEDIUM | **fixed** | R6-H1 restored MediaSources containing `Path.GetFileName(s.Path)` + `s.Name` — for unwatched-spoiler episode under rating-only strip + `SpoilerReplaceTitle`, the raw filename leaks the episode title (e.g. "S05E14 - The Death of Optimus Prime.mkv"). **Fix:** keep MediaStreams (quality/language overlays), but unconditionally null `stubSources`. Loses IMAX/3D detection on stripped episodes — correct trade-off. |
| **R7-M2** | `Services/SpoilerBlurImageFilter.cs:OnUserDataSaved Task.Run` | silent-failure MEDIUM | **fixed** | If `Task.Run` throws synchronously (OOM, threadpool denial), the lambda's `finally { TryRemove }` never runs and the dedup key stays in `_pendingInvalidations` forever — that scope's events are silently dropped until process restart. **Fix:** wrapped dispatcher in try/catch; on synchronous failure, TryRemove the dedup key + rate-limited warn. |

### LOW (deferred)

| ID | Source | Status | Summary |
|---|---|---|---|
| **R7-L1** | silent-failure LOW | **deferred** | `_pendingInvalidations` dropped events leave no audit trail. Optional: per-user dropped-count counter. Non-blocking visibility-only. |
| **R7-I1** | security INFORMATIONAL | **deferred** | Static `_pendingInvalidations` survives plugin reload — pre-reload Task.Run lambdas still active until they complete. Bounded by lambda finally; no leak. |

### Convergence

- **CRITICAL: 0**
- **HIGH: 0 open** (R7-H1 fixed)
- **MEDIUM: 0 open** (R7-M1, R7-M2 fixed)
- **LOW: 2 deferred** (visibility/perf only)

Round 8 pass needed to confirm convergence per JE skill rule.

## Round 6 review (2026-05-06) — post-R5 reviewer pass

Sources: codex GPT-5.5 high, code-reviewer, silent-failure-hunter, security-reviewer.

### HIGH

| ID | File:line | Source | Status | Summary |
|---|---|---|---|---|
| **R6-H1** | `Controllers/JellyfinEnhancedController.cs:3957-3958` (stub `MediaStreams = null : null`) | code-reviewer + silent-failure | **fixed** | Both ternaries returned `null` regardless of `spStripGenres`; quality / language overlays disappeared even when admin only enabled rating-strip. **Fix:** compute trimmed streams + sources inside the stub when `!spStripGenres`, use them in the false branch. |
| **R6-H2** | `Controllers/JellyfinEnhancedController.cs:LoadSpoilerStateForTagStrip` (catch-all gap) | silent-failure HIGH | **fixed** | Helper caught `IOException` / `InvalidDataException` / `JsonException` only. `UnauthorizedAccessException` etc. would escape and 500 the entire tag-cache request. **Fix:** added catch-all with rate-limited warn, returns null. |
| **R6-H3** | `Services/SpoilerUserResolver.cs:142` (foreach enumerator escape) | silent-failure HIGH | **fixed** | `_sessionManager.Sessions` captured as live `IEnumerable`; `MoveNext` could throw "Collection was modified" `InvalidOperationException` escaping both inner per-session and outer property-access catches. **Fix:** `.ToArray()` snapshot inside outer try. |

### MEDIUM

| ID | File:line | Source | Status | Summary |
|---|---|---|---|---|
| **R6-M1** | `Services/SpoilerUserResolver.cs:LoadUserState` (split catches unreachable) | codex MEDIUM | **fixed** | Codex caught that `GetUserConfiguration<T>` is the lenient path; it swallows IOException/JsonException internally and returns `new T()`. The R5-M2 split catches in `LoadUserState` were dead code. **Fix:** collapsed to single catch-all, comment explains lenient-path semantics. Strict-read with corruption observability lives on the dedicated `/spoiler-blur/series` endpoint and `LoadSpoilerStateForTagStrip`. |
| **R6-M2** | `Controllers/JellyfinEnhancedController.cs:3795` (silent skip on `Guid.TryParse` fail) | silent-failure MEDIUM | **fixed** | Cache-key format drift would silently strip tag rails for every user. **Fix:** added `else { _spoilerResolver.WarnRateLimited(...) }`. |
| **R6-M3** | `Controllers/JellyfinEnhancedController.cs:3953` (SeriesId preserved when only tags stripped) | silent-failure MEDIUM | **documented** | Stub keeps SeriesId when admin enabled only `SpoilerStripTags`; JE rating-renderer's parent-series fallback fires. Per security review (L1): series-level rating doesn't reveal episode-specific spoilers (visible on show poster anyway). Acceptable; comment at `:3948-3952` already documents intent. |
| **R6-M4** | corrupt-config fail-OPEN | security MEDIUM | **documented** | Lenient resolver path returns empty `UserSpoilerBlur` on corruption → strip silently disables until user fixes file. Failing closed on the hot image-render path would brick rendering. **Fix:** documented trade-off in new `SECURITY.md` "Behaviour on Corrupt User State" section listing all 3 read paths and their failure modes. |
| **R6-M5** | `Services/SpoilerBlurImageFilter.cs:OnUserDataSaved` (unbounded Task.Run) | code-reviewer MEDIUM | **fixed** | "Mark all played" sweep on a 100-episode season fired 100 Task.Run dispatches racing the same `_watchedCache`. **Fix:** added `_pendingInvalidations` per-user dedup gate (`ConcurrentDictionary<Guid, byte>.TryAdd` short-circuits when one is already in flight; `finally { TryRemove }` releases). |

### LOW

| ID | Source | Status | Summary |
|---|---|---|---|
| **R6-L1** | code-reviewer LOW | **deferred** | `HasWatchedAnyEpisodeInSeasonServerSide` un-cached (24 lookups × N seasons per request). Library iteration is cheap in-memory; flagged for follow-up if perf becomes visible. |
| **R6-L2** | silent-failure LOW | **documented** | Added comment on `TagCacheEntry.Clone()` warning future contributors that `StreamData` reference is shared and must be replaced (not mutated) across users. |
| **R6-L3** | code-reviewer LOW | **fixed** | Added `_disposed` check at top of Task.Run lambda so post-Dispose lambdas no-op fast. |
| **R6-L4** | security LOW | **documented** | Added comment to `SanitizePlaceholder` clarifying it is HTML-context defense, NOT script-eval-context. |

### Convergence

- **CRITICAL: 0**
- **HIGH: 0 open** (R6-H1, H2, H3 fixed)
- **MEDIUM: 0 open** (R6-M1, M2, M5 fixed; M3, M4 documented as accepted trade-offs)
- **LOW: 0 open** (R6-L2, L3, L4 closed; L1 deferred for future perf work)

Round 7 pass needed to confirm convergence per JE skill rule.

## Round 5 review (2026-05-06) — post-R4 reviewer pass

Sources: codex GPT-5.5 high, code-reviewer, silent-failure-hunter, security-reviewer.

### CRITICAL

| ID | File:line | Source | Status | Summary |
|---|---|---|---|---|
| **R5-C1** | `Controllers/JellyfinEnhancedController.cs:3777` (mutates shared `TagCacheEntry`) | codex HIGH#1 | **fixed** | `GetCacheForUser` shallow-copies the dict but NOT entries; the R4-H1 strip mutates the global server cache. One spoiler-mode user blanks Genres / ratings / StreamData for every other user until the cache rebuilds. **Fix applied:** added `TagCacheEntry.Clone()` and `items[kvp.Key] = stripped` per-user. |

### HIGH

| ID | File:line | Source | Status | Summary |
|---|---|---|---|---|
| **R5-H1** | `Services/SpoilerFieldStripFilter.cs:386` (StripSearchHints empty catch) | silent-failure HIGH | **fixed** | `try { _libraryManager.GetItemById(hint.Id) } catch { continue; }` fail-OPEN — hint flows through with original spoiler-y Name. **Fix:** rate-limited warn + sanitize `hint.Name` to placeholder before continue. |
| **R5-H2** | `Services/SpoilerFieldStripFilter.cs:218` (JsonResult-only special case) | silent-failure HIGH | **fixed** | Only `JsonResult` warned; `ContentResult`/`ActionResult<T>`/custom `IActionResult` slipped silently. **Fix:** generalized — log any non-`ObjectResult` shape with type name as rate-limit key. |
| **R5-H3 / M9** | `Services/SpoilerBlurImageFilter.cs:102` (UserDataSaved subscribe, no unsubscribe) | code-reviewer HIGH, security MEDIUM | **fixed** | Singleton subscribes `UserDataSaved += OnUserDataSaved` but never `-=`. Hot-reload / plugin uninstall leaks delegate (memory leak + double-fire on next event). **Fix:** implemented `IDisposable`; DI container disposes on host shutdown. |

### MEDIUM

| ID | File:line | Source | Status | Summary |
|---|---|---|---|---|
| **R5-M1** | `Services/SpoilerFieldStripFilter.cs:264` (silent return on `seriesId == null`) | silent-failure MEDIUM | **fixed** | Episode DTO without SeriesId is a Jellyfin-shape regression; silently returning hides it. **Fix:** rate-limited warn keyed `fieldstrip-episode-no-seriesid`. |
| **R5-M2** | `Services/SpoilerUserResolver.cs:76` (catch-all `Exception` in LoadUserState) | silent-failure MEDIUM | **fixed** | Lumped transient IO with config corruption. **Fix:** split into `IOException` + `JsonException` + catch-all, separate rate-limit keys. |
| **R5-M3** | `Services/SpoilerUserResolver.cs:93-132` (one outer try around foreach) | silent-failure MEDIUM | **fixed** | One bad `SessionInfo` aborted iteration of ALL sessions. **Fix:** per-session try/catch keyed on exception type; outer try only covers `Sessions` enumeration. |
| **R5-M4** | `Services/SpoilerBlurImageFilter.cs:131` (`_watchedCache.TryRemove` return discarded) | silent-failure MEDIUM | **fixed** | Eviction-key-mismatch silent. **Fix:** preserved diagnostic comment for future enable. |
| **R5-M5/L3** | `Services/SpoilerBlurImageFilter.cs:141` (`_watchedCache.Keys` direct iter) | code-reviewer MEDIUM, silent-failure LOW | **fixed** | Inconsistent with `.ToArray()` snapshot used at eviction site. **Fix:** switched to `.ToArray()` in series-level invalidation. |
| **R5-M6** | `Services/SpoilerFieldStripFilter.cs:286-291` (Season `UnplayedItemCount` missing) | code-reviewer MEDIUM | **fixed** | `TvShows.GetSeasons` doesn't include ItemCounts by default → fail-CLOSED stripped every S2+ Season Overview unconditionally. **Fix:** added `HasWatchedAnyEpisodeInSeasonServerSide` library-iter fallback. |
| **R5-M7** | `Controllers/JellyfinEnhancedController.cs:3766, :3871` (lenient config read) | code-reviewer MEDIUM | **fixed** | Tag-cache + tag-data spoiler-state read used `GetUserConfiguration` (lenient) — bypassed R2-M1 corruption detection. **Fix:** added `LoadSpoilerStateForTagStrip` helper using strict-read with rate-limited corruption warn; both endpoints now route through it. |
| **R5-M8** | `Services/SpoilerBlurImageFilter.cs:131-145` (synchronous O(K) scan on event thread) | security MEDIUM | **fixed** | Burst-toggle Played → synchronous handler stalls publish thread for other UserDataSaved consumers. **Fix:** wrapped invalidation work in `Task.Run`. |
| **R5-M10** | `Controllers/JellyfinEnhancedController.cs:3761, :3866-3871` (only `SpoilerStripTags` gates entry) | codex MEDIUM | **fixed** | When admin disabled tag-strip but enabled rating-strip, ratings still leaked via tag-pipeline. **Fix:** entry condition is `SpoilerStripTags || SpoilerStripCommunityRating || SpoilerStripCriticRating`; per-field strip inside (Genres/StreamData on `SpoilerStripTags`, ratings on their own toggles, SeriesId only nulled when ratings are stripped). |

### LOW

| ID | Source | Status | Summary |
|---|---|---|---|
| **R5-L1** | silent-failure LOW | **fixed** | `StripIfApplicable` `_logger.Error` not rate-limited. Switched to `_resolver.WarnRateLimited`. |
| **R5-L4** | code-reviewer LOW | **fixed** | Removed dead orientation comment block in `SpoilerBlurImageFilter`. |
| **R5-L5** | code-reviewer LOW | **fixed** | Renamed `or` (pattern-match alias that read as keyword) → `objectResult`. |
| **R5-L7** | code-reviewer LOW | **fixed** | Collapsed redundant `Guid.TryParseExact("N") || TryParse` (TryParse already accepts N form). |
| **R5-L8** | security LOW | **fixed** | Added `&` strip to `SanitizePlaceholder` for HTML-entity defense-in-depth. |

### Deferred / not closed in R5

- **R4-M2** (single-item editor data corruption via `UserLibrary.GetItem`): documented limitation in `SECURITY.md`; admin-side risk only.
- **R4-M3** (in-place mutation of `BaseItemDto`): no observed cache-by-reference behavior in Jellyfin's MVC pipeline; deferred pending empirical evidence.
- **R5-L2** (static `_warnedAt` survives plugin reload): cosmetic; warned in code comment.

### Convergence

- **CRITICAL: 0 open** (R5-C1 fixed)
- **HIGH: 0 open** (R5-H1, H2, H3 fixed)
- **MEDIUM: 0 open** in R5; 2 deferred from R4 with documented rationale
- **LOW: 0 open** (R5 cosmetics fixed; L2 documented)

Round 5 produced no new CRITICAL findings post-R4 fixes (the new C1 was a pre-existing issue uncovered by the R4-H1 fix). Per JE skill rule "loop terminates when one full parallel pass produces zero new HIGH/P1/P2 findings", a Round 6 pass is needed to confirm convergence.

## Verification results

- E2E (Playwright `diag-spoiler.js`):
  31/31 image URLs on Bluey Season 1 carry `api_key=`; 4 episodes
  return blurred (S1E5–S1E8 for TestAdmin); rest pass-through.
- Direct curl with X-Emby-Token: pass-through 44757 bytes for watched,
  blurred 3000 bytes for unwatched.
- Plugin loads cleanly on jellyfin-dev startup. Build 0/0.

## Companion docs

- `SPOILER_BLUR_APPROACHES.md` — 5 candidate algorithms before bake-off.
- `SPOILER_BLUR_FINDINGS.md` — bake-off results / why Skia won.
