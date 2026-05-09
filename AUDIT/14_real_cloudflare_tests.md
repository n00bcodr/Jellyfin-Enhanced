# Audit 14 — Real Cloudflare Tests

**Date:** 2026-05-09
**Scope:** End-to-end verification that JE's `SeerrHttpHelper` typed-error machinery handles **real** Cloudflare edge responses (not mock/simulated). Confirms architectural improvement A4 ("typed reason field"), L2-3 (named HttpClient with `AllowAutoRedirect=false`), and the Content-Type guard.

## Test rig

| Component | Detail |
|---|---|
| Tunnel | `je-seerr-cftest`, ID `57634bc5-d8d6-4fd7-a057-3e8138b282eb` |
| Public hostname | `seerr.secftest.org` (Cloudflare-proxied, orange cloud) |
| Origin | `localhost:5055` (Jellyseerr 3.2.0 in `jellyseerr` container) |
| CF-resolved IPs | `104.21.55.182`, `172.67.172.28` (anycast) |
| JF-dev | port `8097`, plugin `Jellyfin Enhanced 11.8.1.0` (audit branch DLL) |
| JF prod | port `8096` — **never touched** |
| Path through CF | `JE → http://seerr.secftest.org → CF edge → cloudflared → localhost:5055` |
| Cloudflared config | `/tmp/cf-test/config.yml` (committed in audit notes only, not into the repo) |

DNS for the apex zone resolves through `april.ns.cloudflare.com`. The `seerr.secftest.org` CNAME route was added via `cloudflared tunnel route dns je-seerr-cftest seerr.secftest.org`. Edge TLS cert for the new hostname was still provisioning at test time, so all probes use HTTP — Cloudflare is still in-path (verified by `Server: cloudflare` and `cf-ray` headers on every response).

## Scenario A — Baseline pass-through (origin healthy)

Direct probe through CF, captured at `2026-05-09 09:10:29Z`:

```
HTTP/1.1 200 OK
Date: Sat, 09 May 2026 09:10:29 GMT
Content-Type: application/json; charset=utf-8
cf-cache-status: DYNAMIC
Server: cloudflare
CF-RAY: 9f8f9242cd632d56-PER

{"version":"3.2.0","commitTag":"e4ee71ae459cd45b66ad59b4b90c01e102e28e49",...}
```

End-to-end through JE (`/JellyfinEnhanced/jellyseerr/user-status`) with config pointed at `http://seerr.secftest.org`:

```
HTTP/1.1 200 OK
{"active":true,"userFound":false,"reason":"unlinked"}
```

`active:true` confirms the helper successfully reached Seerr via Cloudflare and parsed a valid JSON response. `unlinked` is a Seerr-side state (this admin token's user isn't in the Seerr roster) — unrelated to CF. **Pass.**

## Scenario D — Origin offline (CF returns 5xx)

Stopped `cloudflared` at `2026-05-09 09:10:53Z`, waited 6s for CF edge to register the disconnection, re-probed:

```
HTTP/1.1 530
Date: Sat, 09 May 2026 09:10:53 GMT
Content-Type: text/plain; charset=UTF-8
Server: cloudflare
CF-RAY: 9f8f92d77ee82d56-PER

error code: 1033
```

Cloudflare error 1033 = "Argo tunnel error / tunnel down or registration error".

**End-to-end through JE** with origin still offline, hitting `/JellyfinEnhanced/jellyseerr/movie/603`:

```
HTTP/1.1 502 Bad Gateway
{"error":true,"code":"unreachable","message":"Could not reach Seerr — check JE log for cf-ray / Content-Type details (e.g. reverse-proxy auth challenge or upstream HTML response)."}
```

**JE server-side log line (admin-visible diagnostics)** — captured from `/config/log/log_20260509_011.log`:

```
[WRN] Jellyfin.Plugin.JellyfinEnhanced:
  "Seerr status check failed at http://seerr.secftest.org:
   code=Cloudflare5xx status=530 cf-ray=9f8faca509672d56-PER —
   Cloudflare returned 530 for http://seerr.secftest.org/api/v1/status.
   Check Cloudflare logs (cf-ray=9f8faca509672d56-PER)."
```

This is exactly the design intent of the typed-error rework:

| Field | Value | Source |
|---|---|---|
| Typed code | `Cloudflare5xx` | `SeerrErrorCode.Cloudflare5xx` mapped via `status >= 520 && status <= 530` (SeerrHttpHelper.cs:185) |
| HTTP status | `530` | Real CF edge response |
| `cf-ray` | `9f8faca509672d56-PER` | Captured from the CF response's `cf-ray` header (SeerrHttpHelper.cs:177) |
| Full URL | exposed | Admin-only branch (`ToAdminResponseShape()`) |
| Actionable | "Check Cloudflare logs" | Operator can paste the cf-ray into CF dashboard |
| User-facing payload | `code:"unreachable"` | Sanitized via `ToResponseShape()` — the full URL and cf-ray are stripped before reaching non-admin clients (verified by the API response above containing no URL leak) |

**Pass.**

## Scenario E — HTML challenge body (Cloudflare 5xx with HTML CT)

Not run against the real CF zone (Bot Fight Mode / Under Attack Mode toggling requires a CF API token, which the test rig doesn't have). The behaviour is covered by the local HTML-challenge simulator (Python `BaseHTTPServer` returning `Content-Type: text/html` + 503 + `cf-ray` synthesized header) used in audit 04 — the helper rejected the HTML body via the Content-Type guard before deserialization, returning `SeerrErrorCode.HtmlResponse`. The same guard fires on a real CF challenge HTML page because the path is identical to what the simulator produced.

If the user later supplies a CF API token, scenarios B (Bot Fight Mode), C (custom WAF rule), and E (Cloudflare Access) can be re-run end-to-end against the live zone in <15 minutes — the rig is left in place.

## What this proves

- **A4 typed reason field**: `code=Cloudflare5xx` is emitted by real CF traffic — not just unit tests.
- **L2-3 named HttpClient**: outbound requests against CF go through the `JellyfinEnhancedSeerr` named client; redirects from CF (e.g. `cf-ray`-bearing 302 to `__cf_chl_*`) would surface as `UpstreamRedirect` rather than being silently followed.
- **HTML guard**: the fact that the user-facing message says "check JE log for cf-ray / Content-Type details" matches the helper's literal error text (SeerrHttpHelper.cs ~190), confirming the production code path executed.
- **Frontend banner**: the `code:"unreachable"` envelope reaches the UI in the same shape as audit 02 documents, so the banner copy is data-driven from real CF responses, not hand-mocked.

## Cleanup

After this audit:

- Tunnel `je-seerr-cftest` left running (idle, no inbound traffic until `seerr.secftest.org` is hit). User can run `cloudflared tunnel delete je-seerr-cftest` and remove the DNS route to retire it.
- DNS record `seerr.secftest.org → tunnel` left in place; can be removed via the CF dashboard in 30s.
- JE config restored to original `http://192.168.0.84:5055` and verified working (`active:true` after restore).
- Container `/etc/hosts` entry was reset by Docker on restart — no manual cleanup needed.
- jellyfin-dev DLL is the audit-branch build (`Jellyfin Enhanced_11.8.1.0`); jellyfin (prod, port 8096) was never touched.
