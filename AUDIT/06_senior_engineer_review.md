# Senior Engineer Architectural Review (26 findings)

## A. Controller monolith (2)
A1. 6148-line controller / 99 routes / 11-arg constructor — split by feature
A2. Routes lack route-group [Authorize] policies — F21/F23/F33 slip through individually

## B. Duplicated logic (5)
B1. **CRITICAL**: User resolution duplicated in 5 places (controller, AutoMovieRequest, AutoSeasonRequest, WatchlistMonitor, WatchlistSyncTask) with subtly different normalization + caching → root cause of audit01 #8/#11/#28/#29/#46 + audit04 F1
B2. URL list parsing duplicated in 6 places (some accept comma, some don't)
B3. **CRITICAL**: HTTP outbound boilerplate duplicated 31 times — one helper (FetchAndMapAsync) does it correctly but only 7/99 routes use it. Root cause of all DefaultRequestHeaders races, missing User-Agent, missing Accept, missing AllowAutoRedirect, missing Content-Type guard
B4. Cache-key scope is per-user but most cached endpoints are PUBLIC (defeats cache for multi-user deployments)
B5. No config-change cache invalidation — JellyfinEnhanced.cs has no OnConfigurationUpdated override

## C. Missing typed error envelope (2)
C1. **CRITICAL**: Every Seerr failure mode collapses to opaque shape → root cause of issue #577 cluster, audit01 #1/#13/#24/#31, audit02 #1/#2/#18
C2. GetJellyseerrUserStatus re-serializes another IActionResult to JSON to extract bool — fragile

## D. Static state & singleton coupling (3)
D1. JellyfinEnhanced.Instance used as global service-locator (39+ refs in controller, 30+ in services)
D2. Static caches on transient controller — surive config reload, can't be flushed without static internals exposure
D3. No DI for helpers, no test project, no unit tests anywhere — every regression caught only by manual repro

## E. Magic strings (3)
E1. IsAdminUser literal "Administrator" — should use Jellyfin's PermissionKind.IsAdministrator
E2. /api/v1/* hardcoded ~75 times across files — substring matching causes audit01 #16/#42 false-positive risk
E3. Permission enum drift C# ↔ JS — audit01 #44 (NONE=0 always returns true), #45 (missing IGNORE_BLACKLIST)

## F. Frontend architecture (4)
F1. **CRITICAL**: 5 discovery modules (genre/network/tag/person/collection) reimplement same render-state-machine — audit02 #21/#22/#82 each appear 5×
F2. more-info-modal.js is 3178 lines, bypasses request-manager, has 7 independent design defects
F3. Implicit module load order via JE.* global — audit02 #20/#63/#88
F4. Cache-prefix drift between server and client — audit02 #43 (genre/network caches never invalidate after request)

## G. Observability (2)
G1. Unstructured logging, no metrics — issue #577 nearly impossible to remote-debug
G2. Per-request Info logs at line 570/608 — admins disable plugin logs, hiding legitimate WARN/ERR

## H. Decisions to reconsider (4)
H1. ArrUrlGuard intentionally allows loopback — keep but add config flag, document threat model
H2. JIT auto-import is silent boolean — consider per-user opt-in or audit log
H3. Permission audit calls Seerr per-user (N×1000 user pulls) — should be ONE bulk pull + map lookup
H4. Public discover cache scoped per-user — should be 2-tier (public path → shared key, user-scoped → per-user key)

## I. Testability (1)
I1. **CRITICAL**: Zero tests, no test project — recommend incremental: extract IJellyseerrUserResolver first, build WireMock-based integration tests reproducing audit01 #1/#2/#6

## Headline
Of audit01's 7 CRITICALs, **6 disappear** with B1+B3+C1.
Of audit02's 8 CRITICALs, **5 are downstream** of F1+F3+C1.
Of audit04's 4 CRITICALs, **all 4 downstream** of B3+C1.
Architecture investment (B1, B3, C1, D2, F1) pays in bug-class elimination, not bug-by-bug fixes.
