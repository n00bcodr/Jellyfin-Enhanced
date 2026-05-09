# Live Invalid-Config Recovery Tests

Run against jellyfin-dev (port 8097) with JE 11.8.1.0 + FT 2.5.9.0.
Real Seerr at `http://seerr.lan:5055`.

## TEST 0 — Baseline (correct config, admin not linked to Seerr)
```
  status:        {"active":true}|200
  user-status:   {"active":true,"userFound":false}|200
  search batman: {"message":"Current Jellyfin user is not linked to a Jellyseerr user."}|404
  discover/movie/popular: {"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":400,"errors":{"serverId":["The
```

## TEST 1 — Validate endpoint (admin-only) with WRONG API KEY
Tests `/jellyseerr/validate?url=...` with X-Arr-ApiKey header — used by config UI Test button.
```
Wrong API key against real Seerr URL:
{"ok":false,"message":"Status check failed"}
HTTP:403

Empty API key:
{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":400,"errors":{"X-Arr-ApiKey":["The apiKey field is required."]},"traceId":"00-c6eb3e6112c6b41f6f8a19a7c3e1123b-013f2af47cd832e7-00"}
HTTP:400

Whitespace-only API key:
{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":400,"errors":{"X-Arr-ApiKey":["The apiKey field is required."]},"traceId":"00-62b84602c727db9f9199be78e4a41c02-467cfac7ed0fb898-00"}
HTTP:400
```

## TEST 2 — Validate against UNREACHABLE URL (issue #591 trigger)
```
Loopback (127.0.0.1) where nothing answers — exact #591 repro:
{"ok":false,"message":"Unable to reach Jellyseerr"}
HTTP:502

RFC1918 unreachable IP:
{"ok":false,"message":"Unable to reach Jellyseerr"}
HTTP:502

Cloud metadata IP (should be blocked by ArrUrlGuard):
{"ok":false,"message":"Invalid URL"}
HTTP:400

Non-http scheme:
{"ok":false,"message":"Invalid URL"}
HTTP:400

Decimal-encoded loopback (issue F14):
{"ok":false,"message":"Unable to reach Jellyseerr"}
HTTP:502

IPv6 loopback (::1):
{"ok":false,"message":"Unable to reach Jellyseerr"}
HTTP:502

IPv6-mapped IPv4 loopback (::ffff:127.0.0.1) — checks F15:
{"ok":false,"message":"Unable to reach Jellyseerr"}
HTTP:502
```

## TEST 3 — Validate against URL that returns HTML (Cloudflare challenge sim)
```
Returns HTML 200 (e.g. www.google.com):
{"ok":false,"message":"Status check failed"}
HTTP:404

```

## TEST 4 — Trigger-recently-added-scan with bad URL
```
{"ok":false,"message":"Unable to reach Seerr"}
HTTP:502
```

## TEST 5 — F15 validation: IPv6-mapped IPv4 of BLOCKED IP (169.254.169.254)
```
Direct (should be blocked):
{"ok":false,"message":"Invalid URL"}
HTTP:400


IPv6-mapped form [::ffff:169.254.169.254] — F15 bypass?

HTTP:000


Hex-encoded (0x7F000001 = 127.0.0.1) — F14:
{"ok":false,"message":"Unable to reach Jellyseerr"}
HTTP:502


Trailing-dot hostname:
{"ok":false,"message":"Invalid URL"}
HTTP:400


Trailing-dot blocked-host (controller's normalization):
{"ok":false,"message":"Invalid URL"}
HTTP:400
```

## TEST 6 — Auth bypass tests
```

Validate WITHOUT token (auth required?):

HTTP:401


Search WITHOUT token:

HTTP:401


version endpoint (F21 — should require auth):
11.8.1.0
HTTP:200


public-config endpoint (F33 — should require auth):
{"TmdbEnabled":true,"ToastDuration":5302,"HelpPanelAutocloseDelay":99000,"EnableCustomSplashScreen":false,"SplashScreenImageUrl":"/web/assets/img/banner-light.png","ElsewhereEnabled":true,"DEFAULT_REG

issue/{id} bypass (F23 — non-admin without VIEW_ISSUES should be blocked):
{"message":"Current Jellyfin user is not linked to a Jellyseerr user."}
HTTP:404
```

## TEST 7 — Public-config exposure check (F33)
```
Look for sensitive fields in unauthenticated public-config:
SENSITIVE fields found in unauthenticated public-config:
  ✅ JellyseerrApiKey NOT in public-config
  ✅ TMDB_API_KEY NOT in public-config
  ✅ SonarrApiKey NOT in public-config
  ✅ RadarrApiKey NOT in public-config

NORMALLY-EXPOSED config fields verified present:
  • JellyseerrBaseUrl: http://seerr.lan:5055
  • JellyseerrUrlMappings: http://jellyfin.lan:8096|http://seerr.lan:5055
http://localhost:8097|http://l
  • JellyseerrEnabled: True
  • TmdbEnabled: True
  • JellyseerrShowSearchResults: True

TOTAL keys in public-config: 137
```

## TEST 8 — Admin-only validate without admin
```
Non-admin user trying to call validate (should be Forbidden):
non-admin token: 84f05c04...

HTTP:403


Non-admin permission-audit (admin-only):

HTTP:403


Non-admin trigger-recently-added-scan (admin-only):

HTTP:403
```

## TEST 9 — Discovery routes that need a serverId — what happens with junk?
```
discover/movies/genre/28 (Action — admin not linked to Seerr):

HTTP:401


person/12345 (Tom Cruise) — admin not linked to Seerr:

HTTP:401


movie/268 (Batman) similar:

HTTP:401
```

## TEST 10 — Verify V1, V2, V3 findings live
```
V1: GET /jellyseerr/user as non-admin — should leak user list?
{"message":"Current Jellyfin user is not linked to a Jellyseerr user."}
HTTP:404


V2: GET /tmdb/validate as non-admin (should require admin per sibling endpoints)
{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":400,"errors":{"apiKey":["The apiKey field is required."]},"traceId":"00-d190bc65bb32cc91d4e5ea259525fdcd-70c5ccc316b149d3-00"}
HTT

V3: GET /jellyseerr/sonarr as non-admin
{"message":"Current Jellyfin user is not linked to a Jellyseerr user."}
HTTP:404


V3: GET /jellyseerr/overrideRule as non-admin
{"message":"Current Jellyfin user is not linked to a Jellyseerr user."}
HTTP:404
```

## TEST 11 — V2 confirmed: tmdb/validate non-admin oracle
```
Non-admin can validate ARBITRARY TMDB key (oracle):
{"ok":true}
HTTP:200


Non-admin with junk key (oracle):
{"ok":false,"message":"Invalid API Key."}
HTTP:401


Compare: arr/validate/sonarr as non-admin (should be 403):

HTTP:403
```

## TEST 12 — V10 verification: JellyseerrSearch with missing query → 500?
```
Without query parameter at all:
{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":400,"errors":{"query":["The query field is required."]},"traceId":"00-b10c8af6d37194ccdeec18e42e931f09-5ecada3e2208a65b-00"}
HTTP:400


With empty query:
{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":400,"errors":{"query":["The query field is required."]},"traceId":"00-c055460853db0d2cf8284c3ade378227-7e83022d115d7867-00"}
HTTP:400


With null query (URL-encoded null byte):
{"message":"Current Jellyfin user is not linked to a Jellyseerr user."}
HTTP:404
```

## TEST 13 — V8 verification: TMDB person ID 0 / negative
```
Person ID 0:
{"message":"Current Jellyfin user is not linked to a Jellyseerr user."}
HTTP:404

Person ID -1:
{"message":"Current Jellyfin user is not linked to a Jellyseerr user."}
HTTP:404
```
