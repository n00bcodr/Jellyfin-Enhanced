# Audit 15 — Cross-Review (claude code-reviewer + claude security-reviewer + Codex CLI)

**Date:** 2026-05-09
**Scope:** Independent review of `audit/seerr-discovery-bugs` against `origin/main` (5 commits, 34 files, +4821/-404). Three reviewers in parallel: `code-reviewer` agent, `security-reviewer` agent, and Codex CLI (`gpt-5.5`, reasoning-high).

## Findings + resolution

### Codex P2 — Arr regression (HIGH, fixed)

**File:** `Controllers/JellyfinEnhancedController.cs:4854`

`FetchAndMapAsync` is the generic helper for Sonarr/Radarr fetches (calendar, queue, calendar-by-instance, movie/series lookup — all `/api/v3/...`). The audit branch had it using `SeerrHttpHelper.CreateClient(_httpClientFactory)`, which is the named client with `AllowAutoRedirect=false`. That's correct for Seerr (a 302 to a login URL is a security signal there) but **wrong for Arr** — Arr behind reverse proxies commonly does HTTP↔HTTPS or trailing-slash 301/302 canonicalization, and those would now fail.

Fix: swap to the default `_httpClientFactory.CreateClient()` for Arr. Inline comment documents why Arr keeps redirects but Seerr doesn't.

Verified live on jellyfin-dev:
- `/arr/calendar` returned real Sonarr+Radarr events
- `/arr/queue` returned real download queue with Sonarr+Radarr items

### Security MED — `SanitizeMessage` regex case-sensitivity + bracketed-IPv6 (fixed)

**File:** `Helpers/Jellyseerr/SeerrHttpHelper.cs:87-95`

Two PoCs both leaked the URL to non-admin callers:
1. `"Failed: HTTPS://internal.host:5055"` — uppercase scheme not matched (no `IgnoreCase`)
2. `"Got https://[::ffff:169.254.169.254]/api/v1 trying"` — negated class stopped at the literal `]` in IPv6 bracket-host, leaving the URL intact

Fix: branch the host on `(?:\[[^\]\s]+\]|[^\s)\]"'<>/]+)` and add `RegexOptions.IgnoreCase`. Verified by running the new pattern against 7 test cases inside a throwaway `dotnet run` project (`/tmp/cf-test/regex_test/`):

```
IN:  Failed: HTTPS://Seerr.example.com
OUT: Failed: <seerr-url>

IN:  Got https://[::ffff:169.254.169.254]/api/v1 trying
OUT: Got <seerr-url> trying

IN:  URL: https://seerr.example.com:5055/api/v1, please retry
OUT: URL: <seerr-url>, please retry  (trailing comma preserved)

IN:  case: https://foo.bar HTTPS://baz.qux end
OUT: case: <seerr-url> <seerr-url> end  (multiple URLs, mixed case)

IN:  no url here
OUT: no url here  (no false positive)
```

### Code-review MED-1 — `GetServiceDetails` unvalidated path segment (fixed)

**File:** `Controllers/JellyfinEnhancedController.cs:1295-1300`

Route `/jellyseerr/{type}/{serverId}` interpolates `type` straight into `/api/v1/service/{type}/{serverId}` against Seerr. No allowlist meant `type=foobar` (or path traversal payloads like `%2e%2e`) would reach Seerr. Today Seerr only knows `sonarr`/`radarr`, but defensively returning 400 for anything else removes the smell entirely.

Fix: add `if (type != "sonarr" && type != "radarr") return BadRequest(...)`. Verified live:
- `/jellyseerr/sonarr/1` → 404 (Seerr says no service at id 1, expected)
- `/jellyseerr/radarr/1` → 404 (same)
- `/jellyseerr/foobar/1` → 400 with `{"error":true,"code":"invalid_service_type",...}`

## Findings noted but not fixed (LOW / accepted)

| # | Source | File:line | Status |
|---|---|---|---|
| MED-2 | claude CR | controller cache shape `{userId}:/api/v1/service/sonarr/1` could collide with `radarr/1` if ever cached | not currently cacheable; deferred |
| MED-3 | claude CR | `IsSeerrReachableCached` calls `[Authorize]` action method as worker; fragile but correct | refactor candidate; not a bug |
| LOW-1 | claude CR | `IsJsonContentType` operator-precedence readability | cosmetic |
| LOW-2 | claude CR | `BulkImportAsync` `Reached=true` for HtmlResponse/Cloudflare5xx — semantics drift | doc-only fix |
| LOW-3 | claude CR | `UpdateConfiguration` flushes caches even on no-op save | accepted (audit B5/D2 design) |
| INFO | claude SR | Public-scope cache passes `X-Api-User` header — Seerr 3.2.0 ignores, but future-fragile | defensive omission deferred |
| LOW | claude SR | Configured `JellyseerrUrls` not run through `ArrUrlGuard` (admin-only setting) | acceptable per threat model |

## What this proves

- **Two reviewers (Codex + claude SR) found different real issues** — running them in parallel covers more of the surface than either alone. Codex caught the Arr regression that the claude code-reviewer missed because the claude CR didn't trace `FetchAndMapAsync` callers down to the `/api/v3/` paths.
- **No CRITICAL or HIGH findings remain** after these three fixes. Both claude reviewers reported "0 CRIT, 0 HIGH" before the fixes; Codex's P2 was the only HIGH-equivalent finding (broken Arr deployments).
- **CONTRIBUTING.md compliance**: all 5 prior commits use conventional commits (`fix(seerr): ...`); JSDoc/XML doc on new public/private methods in `SeerrHttpHelper.cs`, `EvictMovieTvCacheForRequest`, etc.; Jellyfin 10.11.x compat preserved (build clean).
- **SECURITY_GUIDELINES.md compliance**: input validation added (path-segment allowlist + body validation); `[Authorize]` on every new endpoint; no hardcoded secrets; no SQL/path-traversal in new code; XSS protection via `escapeHtml` / `textContent` in JS error rendering.

## Verdict

**Mergeable.** All review-loop findings closed. 3 medium items resolved as one combined commit; remaining MED/LOW/INFO items are quality-of-life or defer-to-future scenarios with no current exploit path.
