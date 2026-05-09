# Round 4 — Soak / stress / edge tests

## R4-T1 — Concurrent discovery requests (cache locking, race)
```
Burst of 30 parallel /discover/movies/genre requests:
  30 parallel requests in 1461ms

JE log entries from this burst (should not show race exceptions):
  ✓ no exceptions in log
```

## R4-T2 — Cache hit-rate sanity
```
Same URL twice — second call should hit cache (much faster):
  cold: 213ms
  warm: 14ms
  ✓ cache appears to be working
```

## R4-T3 — Long search query (NB-8 surrogate-safe truncation under stress)
```
  100 emojis: {"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors 
  500 emojis: {"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors 
  1000 emojis: HTTP:414
  5000 emojis: HTTP:414
```

## R4-T4 — All discovery routes (smoke)
```
  /discover/genreslider/movie → BH1c8OHCAkCq4x.jpg"]}]HTT
  /discover/genreslider/tv → YCnfaxJY5bX7B8.jpg"]}]HTT
  /discover/movies/genre/28?page=1 → DOVTGkv3hFpyyt.jpg"}]}HTT
  /discover/tv/genre/18?page=1 → MYHW9o1zWhJRNq.jpg"}]}HTT
  /discover/movies/keyword/9715?page=1 → I2HkvldwSABZy5.jpg"}]}HTT
  /discover/tv/keyword/210024?page=1 → kxYDavyKWqLQwi.jpg"}]}HTT
  /discover/movies/studio/2?page=1 → l4Q2zmRrA5BEEN.jpg"}]}HTT
  /discover/tv/network/49?page=1 → he-seven-kingdoms"}}]}HTT
  /discover/watchlist?page=1 → -993aa4cabce03e25-00"}HTT
```

## R4-T5 — Validate endpoint extreme inputs
```
  'http://localhost:5055' → {"ok":false,"message":"Unable to reach Jellyseerr"} HTTP:502
  'https://google.com' → {"ok":false,"message":"Status check failed"} HTTP:404
  'ftp://etc-passwd' → {"ok":false,"message":"Invalid URL"} HTTP:400
  'javascript:alert(1)' → {"ok":false,"message":"Invalid URL"} HTTP:400
  'file:///etc/passwd' → {"ok":false,"message":"Invalid URL"} HTTP:400
  'http://[::1]:5055' → {"ok":false,"message":"Unable to reach Jellyseerr"} HTTP:502
  'http://[::ffff:127.0.0.1]:5055' → {"ok":false,"message":"Unable to reach Jellyseerr"} HTTP:502
  'http://0.0.0.0:5055' → {"ok":false,"message":"Invalid URL"} HTTP:400
  'http://0:5055' → {"ok":false,"message":"Invalid URL"} HTTP:400
  'http://1.2.3.4.5' → {"ok":false,"message":"Unable to reach Jellyseerr"} HTTP:502
  '' → {"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":
```

## R4-T6 — Non-admin can't reach admin endpoints (regression check)
```
  jellyseerr/permission-audit →  HTTP:403
  jellyseerr/import-users →  HTTP:403
  jellyseerr/sync-watchlist →  HTTP:403
  jellyseerr/trigger-recently-added-scan?url=http%3A%2F%2Fseerr.lan%3A5055 →  HTTP:405
  jellyseerr/validate?url=http%3A%2F%2Fseerr.lan%3A5055 →  HTTP:403
```
