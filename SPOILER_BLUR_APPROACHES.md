# Spoiler Blur — 5 Approaches

We need a server-side image blur for unwatched episodes that:
- Visibly blurs the image (the WHOLE point — the user just told us we have NOT achieved this).
- Does not produce vertical-stripe / banding artifacts.
- Runs fast (under ~50 ms per image at 1280x720).
- Works with the plugin's existing dependency footprint (Jellyfin.Controller + Newtonsoft + ImageSharp 3.1.12 + Jellyfin's built-in SkiaSharp).
- Always produces obviously, unmistakably blurred output. Not "technically lower entropy."

What FAILED so far:
- ImageSharp `GaussianBlur(sigma=30)` straight on a decoded JPEG → produces visible vertical-stripe artifacts on cartoon-style images. Mathematically blurred, visually broken.
- Box-downsample → bicubic-upsample → `GaussianBlur(4)` → still has visible block / stripe pattern.

---

## Approach 1 — Plain low-sigma Gaussian, applied multiple times

Apply `GaussianBlur(sigma=8)` N times. Convolution composes: applying sigma=8 five times gives effective sigma ≈ √5·8 ≈ 17.9, but each individual pass is well below the artifact threshold.

Pros: stays inside ImageSharp's well-tested path; pure managed.
Cons: 5x the CPU of one pass; effective sigma still moderate.

Predicted look: smooth Gaussian, characters as colored regions but recognizable shapes.

## Approach 2 — Heavy Box-blur via downsample to small + nearest-neighbour upsample

Decode → resize to 32×N pixels with `KnownResamplers.Box` → resize back to 1280×N with `KnownResamplers.NearestNeighbor`. Result: visible chunky pixel mosaic. The user said they'd accept anything visibly blurred — pixelated counts.

Pros: fast (two resizes, no convolution); cannot produce stripe artifacts because there is no convolution kernel; output is unmistakably blurred.
Cons: looks pixelated rather than blurred.

Predicted look: minecraft-style chunky pixels.

## Approach 3 — Aggressive downsample + Mitchell upsample + medium Gaussian

Resize down to 24×N with Box, up to 1280×N with Mitchell (smoother than Bicubic), then `GaussianBlur(sigma=10)` to smooth the macro-block edges.

Pros: still managed-only; produces smooth blur not pixelation.
Cons: stacks three operations; slightly more CPU.

Predicted look: smooth, soft blur — what most users mean by "blurred."

## Approach 4 — SkiaSharp `SKImageFilter.CreateBlur(sigma=25)`

Skia is already loaded in Jellyfin's process (every install). Reference SkiaSharp 3.116.1 with `Private="false"` so we use the host-loaded copy. Apply `SKImageFilter.CreateBlur(25, 25)` which Skia implements as a separable Gaussian with proper edge handling.

Pros: industry-standard image processing; same engine Jellyfin already uses for its own thumbnails; Skia's Gaussian implementation is well-tested at all sigmas; native code, very fast.
Cons: extra dependency; need to be careful not to ship a duplicate SkiaSharp.dll.

Predicted look: textbook Gaussian blur, no artifacts at any sigma.

## Approach 5 — Stack blur (custom managed implementation)

Hand-roll a stack-blur algorithm in pure C# operating on the Rgba32 byte buffer. Stack blur is a well-known fast approximation of Gaussian (used by Android's `RenderScript` blur and many Java libraries). Iterates pixels left-to-right then top-to-bottom maintaining a running sum.

Pros: zero new dependencies; predictable performance; well-known algorithm.
Cons: ~80 lines of pixel math; one more thing to maintain.

Predicted look: Gaussian-equivalent visual; smooth, no stripes.

---

## Decision criteria for the "winner"

A blurred S1E6 of Bluey:
1. MUST be visually unrecognizable as a specific scene to a viewer.
2. MUST NOT look broken / striped / corrupted.
3. SHOULD preserve dominant color regions (so the user can tell something is there).
4. Should round-trip in well under 100 ms (reasonable for a 720p thumb on a server).

We will run all five against the same Bluey S1E6 image, write each output to `/tmp/blur_method_N.jpg`, and visually verify by reading each image. We then pick the cleanest "obviously blurred but not corrupted" result.
