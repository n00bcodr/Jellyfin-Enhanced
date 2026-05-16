# features/spoiler-blur-images @ 2296ac9 — Review Findings

## Context

- Working dir: `/home/jake/Documents/Jellyfin-Enhanced/features/spoiler-blur-images`
- Branch: `features/spoiler-blur-images` (commit `2296ac9` under review; on top of `7bc7e54`)
- Working tree has additional fixes applied on top of `2296ac9` (uncommitted).
- Deploy target: `jellyfin-dev` container, plugin reload verified at 21:14:38.
- Build: 0 warnings / 0 errors (Release net9.0).
- Empirical verification (Bluey S1E2 unwatched, hide mode + opt-in): hide-response pixel (0,0)=(154,206,246) sky-blue (matches series Backdrop), played-response pixel (255,255,201) yellow (real frame, different). Confirmed intercept.

## Iteration log

- **Iter-1**: code-reviewer ✓, security-reviewer ✓, silent-failure-hunter ✓, codex/high ✓ — 1 HIGH-equivalent (silent-failure MEDIUM-1 + codex P2.2: originalBytes leak); 1 P2 (Season aspect regression); plus stale strings.
- **Iter-2 (post first fix batch)**: code-reviewer ✓ (CLEAN), silent-failure-hunter ✓ (NEW HIGH: outer-catch at line 558-573 bypasses HardcodedFallbackJpeg), codex/high ✓ (P3 stale comment + P3 byte[] exposure note).
- **Iter-3 (post outer-catch hardening + stale comment fix)**: in progress.

## Findings table (current state)

### CRITICAL
None.

### HIGH / P1

| ID | Status | File:line | Summary |
|---|---|---|---|
| **H1 (silent-failure iter-2)** | **fixed** | `SpoilerBlurImageFilter.cs:569-595` | Outer `catch` on the dispatch let original spoiler bytes pass through if `ReplaceWithStockCardAsync` threw before assigning `executed.Result` (e.g., `ExtractBytesAsync` IOException, OOM on 4K backdrop decode, ObjectDisposedException on cancelled request). Now branches on `spoilerMode == "hide"`: force-assigns `HardcodedFallbackJpeg` + no-store before returning. Blur-mode pass-through preserved (best-effort by design). |

### MEDIUM / P2

| ID | Status | File:line | Summary |
|---|---|---|---|
| **M1** | **fixed** | `SpoilerBlurImageFilter.cs:1052` | `parent-primary:` dedup key → `parent-art:`. |
| **M2** | **fixed** | `ImageBlurService.cs:126,158,195` | Three "parent-Primary" strings updated to "parent-art". |
| **M3** | deferred | `ImageBlurService.cs:164` | Source `SKBitmap.Decode` has no edge cap. Pre-existing in `ResizeToMatch`. Track for follow-up. |
| **P2.1 (codex iter-1)** | **fixed** | `SpoilerBlurImageFilter.cs:999` | Season Backdrop reintroduced aspect-mismatch squash. Route Season → Series Primary. |
| **P2.2 (codex iter-1 / silent-failure iter-1)** | **fixed** | `SpoilerBlurImageFilter.cs:962` | StockCard==null leaked original bytes. Embed pre-encoded 16x16 #101010 JPEG fallback (`HardcodedFallbackJpeg`). |

### LOW / P3

| ID | Status | File:line | Summary |
|---|---|---|---|
| **L1** | **fixed** | `SpoilerBlurImageFilter.cs:948,983` | Function rename + comment refresh. |
| **L2** | resolved | Behavioural | Season aspect-mismatch resolved by P2.1 fix. |
| **L3** | deferred | `ImageBlurService.cs:181-187` | Non-uniform Mitchell scale on cinemascope. Functional. |
| **L4** | deferred | `SpoilerBlurImageFilter.cs:1041` | Sync `File.ReadAllBytes` on request thread. Negligible. |
| **P3 (codex iter-1 stale parent art)** | deferred | `SpoilerBlurImageFilter.cs:947` | Cache key lacks parent image tag/path. Long-tail. |
| **P3 (code-reviewer iter-2 / codex iter-2 byte[] exposure)** | **noted; not changed** | `ImageBlurService.cs:59` | `HardcodedFallbackJpeg => _hardcodedFallbackJpeg` returns the static byte[] by reference. Sole consumer is FileContentResult (read-only). Defensive copy would cost 285 bytes per fallback hit — practical risk is near zero; not changed. |
| **P3 (codex iter-2 stale comment)** | **fixed** | `ImageBlurService.cs:126-131` | Doc on `ResizeToMatch` still said "Series Backdrop for episodes/seasons". Updated to spell out the per-aspect rule. |
| **L5 (code-reviewer iter-2 no-store parity)** | noted; not changed | `SpoilerBlurImageFilter.cs:967-969` | Fallback branch uses `ApplyNoStoreToResponse(ctx)` instead of `ApplyNoStoreHeadersDirect(ctx, imageType)`. Difference is benign (strict no-store applied; loses 30s chapter-image cache window — only matters when Skia is broken AND chapter previews are requested, vanishingly rare). |

## Fix log (chronological, on top of 2296ac9)

**Batch 1** (iter-1 fixes, code-reviewer + silent-failure + security + codex inputs):
1. `TryGetParentPrimaryBytes` → `TryGetParentArtBytes` (definition + call site).
2. Season routing: Series Backdrop → Series Primary (avoids 16:9→2:3 squash).
3. Pre-encoded 16x16 #101010 JPEG `HardcodedFallbackJpeg` added to `ImageBlurService.cs`; consumed by `ReplaceWithStockCardAsync` when `StockCard` returns null (was: original bytes).
4. `parent-primary:` dedup key → `parent-art:`.
5. `parent-Primary` log strings → `parent-art` in `ImageBlurService.cs`.
6. `// Try parent Primary first.` → `// Try parent art first.`
7. Doc comments on `ReplaceWithStockCardAsync` and `TryGetParentArtBytes` describe the per-aspect rule (Episode→Backdrop, Season→Primary, Movie/Collection→Primary).
8. configPage.html and PluginConfiguration.cs descriptions list each item type's parent image source explicitly.

**Batch 2** (iter-2 fix, silent-failure-hunter HIGH):
9. Outer `try/catch` at `SpoilerBlurImageFilter.cs:558-595` now branches on `spoilerMode == "hide"`: force-assigns `HardcodedFallbackJpeg` + no-store before returning instead of allowing MVC to write the original `FileStreamResult` body. Blur-mode pass-through preserved.

**Batch 3** (iter-2 codex P3 stale comment):
10. `ImageBlurService.cs:126-131` — `ResizeToMatch` doc updated to spell out per-aspect parent picks (was "Series Backdrop for episodes/seasons").

## Verification

- Build: `dotnet build` Release/net9.0 — 0 warnings, 0 errors at every batch.
- Deploy: DLL copied to `Jellyfin Enhanced_11.8.1.0/`, jellyfin-dev restarted, plugin re-init logged clean at 21:14:38.
- Embedded JPEG: Pillow round-trip → 16×16 RGB, pixel (16,16,16). Codex also independently confirmed via base64-decode + hex dump (FFD8/FFD9 markers, SOF0 declares 16x16, 3 components).
- Empirical hide-mode test (Bluey S1E2 unwatched, admin opted-in):
  - hide-mode response: `(154, 206, 246)` light blue → Series Backdrop match.
  - played (unfiltered) response: `(255, 255, 201)` yellow → real episode frame, distinct content.
  - Hash distinctness confirmed across both samples.
