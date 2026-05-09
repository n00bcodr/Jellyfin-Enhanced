# Consistency + Redundancy Review

## A. Consistency issues (10)
1. Negative-cache TTL: 30 min steady-state (C01-CRIT-2) vs unbounded across reloads (V2) — both true
2. _avatarCache cache-class: was overstated as Dictionary+lock; actually ConcurrentDictionary
3. DefaultRequestHeaders severity: cluster 8 walked back, but #25 / #38 / #50 still framed as HIGH races — should match
4. #591 cluster naming: A2/A19/A18 are JE-side trigger reductions, not the bug itself (FT root cause)
5. C01-MED-41 listed twice in BUGS.md (Cluster 6 and Cluster 15) — same ID, same line, different bug surfaces
6. F23 issue/{id} bypass: blocked by user-link short-circuit in TEST 6 (admin not linked); needs re-test with linked non-admin
7. F18 says "23+ bypass guard"; B3 says "31 outbound sites" — should cross-reference (~23 of 31 lack guard)
8. Terminology drift: "user not linked" / "user not found" / "userFound:false" / "user blocked" — needs glossary
9. Calendar dedup: V6 supersedes C01-HIGH-22 fix idea; merge with V6's more-specific recommendation
10. Decimal-encoded loopback test result: live test correctly reflects design (loopback intentionally allowed); F14 generic claim untested for non-loopback blocked IPs (e.g., decimal-encoded 169.254.169.254)

## B. Top 20 redundancy clusters (canonical IDs to keep)

1. **User-status silent fail cluster** — merge C01-CRIT-1, C02-CRIT-1, C02-CRIT-2, 02#2, C04-CRIT-F8 → CRIT
2. **No Content-Type guard cluster** — merge C01-CRIT-3, C01-CRIT-5, C01-CRIT-31, C04-CRIT-F1, C04-CRIT-F2, C04-CRIT-F3, 02#18 → CRIT
3. **Duplicated user resolution** — merge C01-HIGH-8, C01-HIGH-11, C01-HIGH-28, C01-LOW-55, C01-MED-41 → HIGH (architecture B1)
4. **Cache survives config change** — merge C01-HIGH-9, C01-HIGH-46, C01-HIGH-20, C03-A1, V2, V19 → HIGH (architecture B5/D2)
5. **5 discovery module duplication** — merge 5×C02-#21, 5×C02-#22, 5×C02-#82 → CRIT (architecture F1)
6. **Cache prefix drift** — merge C02-#43, F4 → HIGH
7. **Missing route auth** — merge C04-F21, C04-F33, A2 → HIGH (route-group policy)
8. **Admin-only Seerr endpoints leak to non-admin** — merge V1, V3 → HIGH
9. **Negative-cache poison** — keep C01-CRIT-2 → CRIT
10. **No User-Agent / Accept / redirect-disable / log cf-ray on outbound** — merge C04-F4, F5, F9, F10, F12, F18, V20 → HIGH (architecture B3)
11. **Cache eviction unbounded** — merge C01-MED-32, 33, 40 → MED
12. **GetRequests fragile** — merge C01-HIGH-23, 24 → HIGH
13. **Lifecycle cleanup gaps** — merge C01-MED-35, C02-#13, V11, V12 → MED
14. **String interpolation XSS class** — merge C02-#26, 02#51, 02#52, 02#65, 02#81, C01-HIGH-14 → HIGH
15. **Translation hardcoded English / missing keys** — merge 02#90, V13, V14, V15, V16, V17, V25, 02#67, 02#28, 02#40, V32 → MED
16. **URL save validation gap** — merge C03-A2, A19 → MED
17. **Permission enum drift** — merge C01-MED-44, 45, E3 → MED
18. **ArrUrlGuard hardening** — merge C04-F13, 14, 15, 16, 17 → HIGH
19. **Frontend bypasses request-manager** — merge C02-#3, 27, 13, 23, 17 → HIGH
20. **Monitor singleton/event-sub leak** — merge V1, V2 (partial), V3 → HIGH (architecture: AddHostedService)

## C. Final canonical count (post-dedup)

| Severity | Before | After | Reduction |
|----------|--------|-------|-----------|
| CRITICAL | 14     | 6     | -57% |
| HIGH     | 64     | ~28   | -56% |
| MEDIUM   | 47     | ~24   | -49% |
| LOW      | 17     | ~12   | -29% |
| **Total**| 142    | ~70   | -50% |

Architecture: 26 → 14 (60% absorbed by clusters above)

**Headline:** ~50% of raw findings collapse into 7 architectural investments:
- B1: IJellyseerrUserResolver
- B3: ISeerrHttpClient with Content-Type / UA / Accept / no-redirect / IsAllowedUrl
- C1: Result<T, SeerrError> typed envelope
- B5/D2: OnConfigurationUpdated → IMemoryCache.Compact
- F1: DiscoverySection base class for 5 modules
- A2: Route-group [Authorize] policy
- AddHostedService<T>() for monitors
