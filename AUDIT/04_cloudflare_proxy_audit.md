# Cloudflare / Reverse Proxy / Auth / SSRF Audit (38 findings)

## CRITICAL (4)
F1.  No Content-Type guard before JsonSerializer.Deserialize on any Seerr response — every HTTP-out helper in JellyfinEnhancedController.cs and Services/*RequestService.cs is vulnerable
F2.  Cloudflare 520-526 errors render same UX as "user not found"
F3.  Cloudflare HTML challenge cached as JSON for 10 minutes (response-cache poisoning)
F8.  SWAG+tinyauth / Pangolin / Authelia / Authentik 401+HTML silently fails over to next URL

## HIGH (21)
F4.  No User-Agent set on outbound HTTP — Cloudflare flags empty UA as bot
F5.  cf-connecting-ip / cf-ray headers never logged on errors (no diag breadcrumbs)
F9.  HttpClient default AllowAutoRedirect=true follows 302 to auth provider (silently fetches login page)
F10. No Accept: application/json on outbound — server returns HTML when content-negotiating
F12. Set-Cookie / 302 not detected as "auth required"
F13. ArrUrlGuard does not block IPv4 link-local 169.254.0.0/16 entirely (only specific cloud-metadata IPs)
F14. Decimal/hex/integer-encoded IP literals platform-dependent (Uri.TryCreate behavior)
F15. IPv6-mapped IPv4 / IPv6 link-local not normalized (::ffff:127.0.0.1 bypasses block)
F16. DNS rebinding window between guard check and HTTP-out (TOCTOU)
F17. Hostname normalization: trailing dot, IDN homograph (xn--... vs unicode)
F18. 23+ outbound calls bypass ArrUrlGuard entirely (proxy/avatar, /tmdb/*, scheduled tasks)
F19. Per-route IsAllowedUrl calls inconsistent — some call sync, some async, some none
F21. Endpoints missing [Authorize]: version, public-config (info disclosure of JellyseerrBaseUrl)
F22. X-Jellyfin-User-Id docs say it's a header but it's a JWT claim (mislead in docs/advanced/api.md)
F23. GET /api/v1/issue/{id} bypass for non-admins missing VIEW_ISSUES check (CVE-grade authz)
F24. No CSRF protection on POST/DELETE proxy endpoints (cookie auth path)
F27. X-Arr-ApiKey header path requires HTTPS (not enforced; can leak over HTTP)
F31. No reverse proxy / Cloudflare / WAF setup docs
F32. Issue #449 enumerated endpoint list still missing — only 6/99 endpoints documented
F33. public-config exposure not documented
F36. JellyseerrUrls scheme not validated at save (matches A2)
F37. Cookie-only Seerr auth — verified safe (the controller doesn't echo Set-Cookie)

## MEDIUM (8)
F6.  Cloudflare Access JWT not forwarded (incompatibility, not bug per se)
F11. nginx auth_request returning 200+HTML cascades same as F1
F19. Per-route IsAllowedUrl call inconsistency
F26. TMDB API key in URL query parameter (interpolation, no escaping)
F28. IsAdminUser uses magic string "Administrator" not Jellyfin's IsAdministrator
F29. Jellyfin admin bypasses Seerr permission check (intentional but undocumented)
F34. No docs about JE outbound IP allowlisting
F35. No docs about Cloudflare "Always Use HTTPS" pitfalls

## LOW (5)
F7.  Cloudflare Rocket Loader documented in only 2 places (issue #175)
F20. Dns.GetHostAddresses fails-open on SocketException (intentional pass-through)
F25. X-Emby-Token NOT forwarded upstream (correct design — verified safe)
F30. AuthorizeUserConfigAccess GUID format handling (verified safe)
F38. IsAllowedUrl empty-host edge case (safe by accident)

## Top remediation priorities

1. **Centralize all Seerr/arr outbound HTTP through one helper** that:
   - Sets User-Agent: JellyfinEnhanced/{version}
   - Sets Accept: application/json
   - Disables AllowAutoRedirect
   - Validates Content-Type starts with `application/json` before deserialization
   - Calls IsAllowedUrlAsync on every URL
   - Logs cf-ray, cf-cache-status on errors
   - Surfaces distinct error codes

2. **Tighten ArrUrlGuard:**
   - Block IPAddress.IsIPv4LinkLocal() and IsIPv6LinkLocal()
   - Block IPAddress.MapToIPv4() of any IPv6 against IPv4 blocklist
   - Reject integer/hex-only host strings before DNS
   - Strict scheme validation

3. **Document Cloudflare/reverse-proxy matrix** — single page enumerating every reverse proxy / Cloudflare feature / WAF interaction with bypass instructions.

4. **Auth bug fixes:**
   - F23: Add VIEW_ISSUES check for /api/v1/issue/{id}
   - F21: Move /version and JellyseerrBaseUrl behind [Authorize]
   - F29: Document admin bypass semantics

5. **Generate complete endpoint list** for docs/advanced/api.md (F32) — addresses issue #449.
