# Round 1 — End-to-end live testing (admin LINKED to Seerr)

Tokens: admin=ac4c741f non-admin=f30d7bd7

## R1-T1 — Discovery sections (real responses)
```
/movie/268/similar (Batman 1989):
  totalResults: 112980
  - Black Lightning (31162)
  - The Bad Guys (629542)
  - 3 Ninjas: High Noon at Mega Mountain (32302)

/movie/268/recommendations:
  totalResults: 658
  - The Dark Knight (155)
  - Batman Returns (364)
  - The Dark Knight Rises (49026)

/discover/movies/genre/28 (Action):
  totalResults: 52598
  - Apex
  - They Will Kill You
  - Vengeance

/discover/genreslider/movie:
  count: 19
  - Action (id=28)
  - Adventure (id=12)
  - Animation (id=16)
```

## R1-T2 — Person endpoint (V8 fix: tmdbId<=0)
```
Valid person 287 (Brad Pitt):
  name=Brad Pitt tmdbId=287

Person 0 (invalid — V8 should reject):
{"error":true,"code":"UpstreamError","httpStatus":500,"message":"Seerr returned 500 from http://seerr.lan:5055/api/v1/person/0."}  HTTP:500

Person -1 (invalid):
{"error":true,"code":"UpstreamError","httpStatus":500,"message":"Seerr returned 500 from http://seerr.lan:5055/api/v1/person/-1."}  HTTP:500
```

## R1-T3 — F23 issue/{id} permission gate (admin-linked, can hit Seerr)
```
Admin: any issue id should now reach Seerr (404 from Seerr if id doesn't exist):
{"id":1,"issueType":1,"status":1,"problemSeason":28,"problemEpisode":1,"createdAt":"2025-12-13T09:17:35.000Z","updatedAt":"2025-12-13T09:17:35.000Z","comments":[{"id":1,"message":"s","createdAt":"2025-12-13T09:17:35.000Z","updatedAt":"2025-12-13T09:17:35.000Z","user":{"permissions":2,"warnings":[],"id":1,"email":"admin@admin.com","plexUsername":null,"jellyfinUsername":"admin","username":null,"reco
Issue list:
{"pageInfo":{"pages":16,"pageSize":5,"results":76,"page":1},"results":[{"id":76,"issueType":4,"status":1,"problemSeason":1,"problemEpisode":1,"createdAt":"2026-04-11T10:10:14.000Z","updatedAt":"2026-04-11T10:10:14.000Z","createdBy":{"permissions":1048736,"warnings":[],"id":5,"email":"stefaan","plexUsername":null,"jellyfinUsername":"Stefaan","username":null,"recoveryLinkExpirationDate":null,"userTy```

## R1-T4 — V3 advanced-request gate (admin works, non-admin gated by perms)
```
Admin /jellyseerr/sonarr (admin bypasses → Seerr response):
[{"id":0,"name":"sonarr","is4k":false,"isDefault":true,"activeDirectory":"/tv","activeProfileId":8,"activeAnimeProfileId":8,"activeAnimeDirectory":"/tv","activeTags":[]}]  HTTP:200

Admin /jellyseerr/radarr:
[{"id":0,"name":"radarr","is4k":false,"isDefault":true,"activeDirectory":"/movies","activeProfileId":7,"activeTags":[]}]  HTTP:200

Admin /jellyseerr/overrideRule:
[]  HTTP:200
```

## R1-T5 — V3 non-admin user (Test) — what's their Seerr-side state?
```
non-admin user-status:
{"active":true,"userFound":true,"jellyseerrUserId":"8","reason":"linked"}
non-admin /jellyseerr/sonarr (V3 gate — non-admin needs REQUEST_ADVANCED):
{"code":"no_advanced_permission","message":"You do not have permission to use advanced request options."}  HTTP:403

non-admin /jellyseerr/issue/1 (F23 — needs VIEW_ISSUES):
{"id":1,"issueType":1,"status":1,"problemSeason":28,"problemEpisode":1,"createdAt":"2025-12-13T09:17:35.000Z","updatedAt":"2025-12-13T09:17:35.000Z","comments":[{"id":1,"message":"s","createdAt":"2025-12-13T09:17:35.000Z","updatedAt":"2025-12-13T09:17:35.000Z","user":{"permissions":2,"warnings":[],"id":1,"email":"admin@admin.com","plexUsername":null,"jellyfinUsername":"admin","username":null,"reco
non-admin /jellyseerr/issue (issue list — F23 — needs VIEW_ISSUES):
{"pageInfo":{"pages":16,"pageSize":5,"results":76,"page":1},"results":[{"id":76,"issueType":4,"status":1,"problemSeason":1,"problemEpisode":1,"createdAt":"2026-04-11T10:10:14.000Z","updatedAt":"2026-04-11T10:10:14.000Z","createdBy":{"permissions":1048736,"warnings":[],"id":5,"email":"stefaan","plexUsername":null,"jellyfinUsername":"Stefaan","username":null,"recoveryLinkExpirationDate":null,"userTy```

## R1-T6 — Watchlist & quota
```
Quota:
{"movie":{"days":7,"limit":0,"used":0,"restricted":false},"tv":{"days":7,"limit":0,"used":0,"restricted":false}}

Watchlist:
{"error":true,"code":"UpstreamError","httpStatus":400,"message":"Seerr returned 400 from http://seerr.lan:5055/api/v1/user/watchlist."}```

## R1-T7 — Requests page (HIGH-23/24 fix — structured error not silent empty)
```
  totalResults: 254
  totalPages: 51
  - id=287 status=None type=None tmdb=None
  - id=286 status=None type=None tmdb=None
  - id=285 status=None type=None tmdb=None
```

## R1-T8 — More-info-modal data (movie + TV)
```
Movie 268 (Batman 1989):
  title=Batman runtime=126 releaseDate=1989-06-21
  mediaInfo: False
Movie ratings:
{"rt":{"title":"Batman","url":"https://www.rottentomatoes.com/m/batman","criticsRating":"Certified Fresh","criticsScore":77,"audienceRating":"Upright","audienceScore":84,"year":1989},"imdb":{"title":"Batman","url":"https://www.imdb.com/title/tt0096895","criticsScore":7.5,"criticsScoreCount":431693}}

TV 1399 (GoT):
  name=Game of Thrones seasons=8 episodes=73
  status=Ended  inProduction=False
TV season 1 detail:
  s1 episode count: 10
```

## R1-T9 — V8 fix: invalid person id (now 400 BadRequest, not 500)
```
Person 0 (need to deploy NEW build first; current: 500 from Seerr):
{"error":true,"code":"UpstreamError","httpStatus":500,"message":"Seerr returned 500 from http://seerr.lan:5055/api/v1/person/0."}  HTTP:500

Person 5 (Howard Hughes):
  name=Peter Cushing id=5
```

## R1-T10 — Search edge cases
```
Common term 'matrix' (positive):
  totalResults: 123, totalPages: 7

Empty query (V10 — clean BadRequest):
{"error":true,"code":"missing_query","message":"Search query is required."}  HTTP:400

Whitespace-only query:
{"error":true,"code":"missing_query","message":"Search query is required."}  HTTP:400

Very long emoji query (NB-8 surrogate-safe):
  totalResults=0 (should be 0 for emoji)
  did not crash on surrogate truncation ✓
```

## R1-T11 — Calendar (audit C01-HIGH-21/22 + V5)
```
Default (90 days):
  events count: 42
  - The Grand Tour (2016) 2026-05-01T12:00:00.0000000Z Sonarr
  - Rooster Fighter 2026-05-03T04:00:00.0000000Z Sonarr
  - Family Guy 2026-05-04T00:00:00.0000000Z Sonarr
  - Bob's Burgers 2026-05-04T00:30:00.0000000Z Sonarr
  - Euphoria (US) 2026-05-04T01:00:00.0000000Z Sonarr

Year-long range (capped to 365 days — audit C01-MED-48 fix):
{"events":[{"id":"13362","source":"Sonarr","type":"Series","title":"Hell\u0027s Kitchen (US)","subtitle":"S23E11 - A Soap Opera in Hell","releaseDate":"2025-01-03T01:00:00.0000000Z","releaseType":"Epi
JE log lines confirming cap:
[2026-05-09 12:33:40] [INFO] Calendar range capped from 1094 days to 365 days.
```

## R1-T12 — Tag/keyword/network discovery
```
Network 1024 (HBO):
  totalResults: 372, totalPages: 19

Studio Disney:
  totalResults: 416, totalPages: 21

Keyword 9715:
  totalResults: 1252, totalPages: 63
```

## R1-T13 — Discovery filters (audit C01-HIGH-17 expanded whitelist)
```
Genre + sortBy + voteAverageGte (existing whitelist):
  totalResults: 5861
  - The Frog vote=10
  - Debus. vote=10
  - Fight! vote=10

withCompanies (NEW in expanded whitelist — should now propagate):
  totalResults: None
```

## R1-T14 — Permission audit (audit C01-MED-41: per-user fan-out — slow but should still work)
```
  total users in audit: 13
  linked: 13, unlinked: 0
  - Sludgeisveryodd      linked=True issues=1
  - Gab                  linked=True issues=1
  - Stephen              linked=True issues=1
  - Test                 linked=True issues=1
  - pwned                linked=True issues=1
```

## R1-T15 — Issue creation (POST issue path — non-admin needs CREATE_ISSUES)
```
Admin attempts (should hit Seerr; may fail if mediaId doesn't exist):
{"createdBy":{"permissions":2,"warnings":[],"id":1,"email":"admin@admin.com","plexUsername":null,"jellyfinUsername":"admin","username":null,"recoveryLinkExpirationDate":null,"userType":3,"plexId":null,"jellyfinUserId":"02ff664249444346b16d1f8de0346650","avatar":"/avatarproxy/02ff664249444346b16d1f8de0346650?v=1772974057000","avatarETag":"daefef9a01b9fd52c6c47cd95d442996c49d238f6dc703a803d07658c974```

## R1-T16 — Trigger Seerr scan (admin only, V3 confirmed earlier)
```
(skipped — would mutate Seerr state)
```

## R1-T17 — JE log: structured errors during this round
```
[2026-05-09 02:23:18] [WARN] Failed to auto-import user to Jellyseerr at http://seerr.lan:5055: code=Forbidden status=403 cf-ray= — Seerr returned 403. Common causes: API key rotated, user lacks permission, or CSRF protection enabled in Seerr.
[2026-05-09 02:23:18] [WARN] Failed to fetch users from Seerr at http://seerr.lan:5055: code=Forbidden status=403 cf-ray= — Seerr returned 403. Common causes: API key rotated, user lacks permission, or CSRF protection enabled in Seerr.
[2026-05-09 02:23:18] [WARN] Failed to auto-import user to Jellyseerr at http://seerr.lan:5055: code=Forbidden status=403 cf-ray= — Seerr returned 403. Common causes: API key rotated, user lacks permission, or CSRF protection enabled in Seerr.
[2026-05-09 03:00:00] [WARN] [Jellyseerr Watchlist Sync] Failed to get users from Jellyseerr: code=Forbidden status=403 cf-ray= — Seerr returned 403. Common causes: API key rotated, user lacks permission, or CSRF protection enabled in Seerr.
[2026-05-09 07:26:25] [WARN] [Watchlist] Failed to fetch requests from Jellyseerr: code=Forbidden status=403 cf-ray= — Seerr returned 403. Common causes: API key rotated, user lacks permission, or CSRF protection enabled in Seerr.
[2026-05-09 12:31:29] [WARN] Seerr request failed for user admin (02ff6642-4944-4346-b16d-1f8de0346650) at http://seerr.lan:5055: code=UpstreamError status=500 cf-ray= — Seerr returned 500 from http://seerr.lan:5055/api/v1/person/0.
[2026-05-09 12:31:30] [WARN] Seerr request failed for user admin (02ff6642-4944-4346-b16d-1f8de0346650) at http://seerr.lan:5055: code=UpstreamError status=500 cf-ray= — Seerr returned 500 from http://seerr.lan:5055/api/v1/person/-1.
[2026-05-09 12:33:34] [WARN] Seerr request failed for user admin (02ff6642-4944-4346-b16d-1f8de0346650) at http://seerr.lan:5055: code=UpstreamError status=400 cf-ray= — Seerr returned 400 from http://seerr.lan:5055/api/v1/user/watchlist.
[2026-05-09 12:33:38] [WARN] Seerr request failed for user admin (02ff6642-4944-4346-b16d-1f8de0346650) at http://seerr.lan:5055: code=UpstreamError status=500 cf-ray= — Seerr returned 500 from http://seerr.lan:5055/api/v1/person/0.
[2026-05-09 12:36:07] [WARN] Seerr request failed for user admin (02ff6642-4944-4346-b16d-1f8de0346650) at http://seerr.lan:5055: code=UpstreamError status=400 cf-ray= — Seerr returned 400 from http://seerr.lan:5055/api/v1/discover/movies?page=1&genre=28&withCompanies=2.
```

## R1-T18 — proxy/avatar with safe MIME (audit C01-HIGH-14)
```
Valid avatar path:
  HTTP:400, Content-Type:application/problem+json; charset=utf-8

Invalid path traversal attempt:
{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":400,"errors":{"path":["The path field is required."]},"traceId":"00-363654de025c
Disallowed prefix:
{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":400,"errors":{"path":["The path field is required."]},"traceId":"00-0c818310a32e```

## R1-T19 — Hidden content / blocklisted items (audit C01-HIGH-MISC)
```
Excluded (blocklist) on discovery — admin's user-config:
```

## R1-T20 — TMDB enrichment + image rendering (cluster cache poison)
```
  tmdb-direct: title=Batman runtime=126
```
