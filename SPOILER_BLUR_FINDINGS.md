# Spoiler Blur — Findings From the 5-Approach Bake-Off

Test source: `/tmp/blur-test/source.jpg` — 1280×720 Bluey S1E6 thumbnail (130549 bytes).
Each approach is implemented in `/tmp/blur-test/Program.cs`. Outputs written to `/tmp/blur-test/method_*.jpg`. Numerical sharpness check via Python PIL midline-row R-channel std + mean-edge-diff.

| Method | Bytes | Time | Mean edge diff | Visual verdict |
|---|---|---|---|---|
| 1. Plain Gaussian sigma=8 ×5  (ImageSharp)  | 43146 | 1008 ms | 2.76 | Too weak — characters still recognisable. Visible stripe artifacts on full-resolution view. |
| 2. Pixelate (downsample to 32px + nearest-neighbor) | 23902 | 247 ms | 3.02 | Chunky minecraft pixels. Hides content but looks like a corruption, not a blur. |
| 3. Downsample(24) + Mitchell upsample + Gaussian(10) | 36538 | 265 ms | 1.45 | Strong smooth blur. Faint subliminal vertical artifacts at full resolution from the Gaussian step. |
| **4. SkiaSharp `CreateBlur(40, Clamp)`** | **35721** | **129 ms** | **2.68** | **Winner.** Strong, perfectly smooth Gaussian blur. No artifacts at any resolution. Characters reduced to colored silhouettes; scene unrecognizable. |
| 5. Stack-blur (custom managed, 3-pass, r=30) | 34474 | 2064 ms | 1.37 | Visually equivalent to Method 4. But pure C# loop is 16× slower than Skia (2 seconds vs 130 ms). |

## Why Skia wins

1. **Visual quality.** Skia's `CreateBlur` is a separable Gaussian with proper edge handling. No banding or stripe artifacts at any sigma we tried (tested 25 and 40). Smooth result at both full resolution and thumbnail-display sizes.
2. **Speed.** ~130 ms on a 1280×720 RGBA buffer. The custom stack-blur was 2 seconds; the repeated-Gaussian was 1 second. Skia is the only one fast enough to apply on every image-fetch with cache misses without becoming a bottleneck.
3. **Zero new shipping weight.** Jellyfin's host process **already** loads `SkiaSharp.dll` from `/usr/lib/jellyfin/bin/SkiaSharp.dll` (its own thumbnail engine). Our plugin can reference SkiaSharp at compile time and not ship its own copy — we just use the host's.
4. **Tile mode `Clamp`.** Without this the blur kernel reads zero-alpha beyond the image edge and you get a black halo around the picture. Clamp samples the edge pixel forever, so the corners stay the same colour as the source.
5. **No artefact at high sigma.** The original failed approach (ImageSharp `GaussianBlur(sigma=30)`) produces visible vertical-stripe banding on cartoon-style images. Skia at sigma=40 is artefact-free. This is the difference between "technically lower entropy" (Method 1) and "actually looks blurred" (Method 4).

## Why others lose

- **ImageSharp's `GaussianBlur` is not safe at high sigma on cartoon images.** Methods 1 and 3 both eventually use it; both showed banding artefacts on full-resolution output. Method 3 only barely got away with it because it was downsampled first so the Gaussian sigma was small.
- **Pixelation (Method 2)** was unmistakably "blurred" but visually communicates "broken thumbnail" rather than "spoiler hidden."
- **Custom stack-blur (Method 5)** has identical visual quality to Skia and zero deps, BUT 16× slower. On a typical home server with 50+ Bluey episode thumbs in a season grid, that's a 100-second blocking serialised cost on cache miss vs ~6 seconds for Skia. Fail-open behaviour would just mean the user sees the originals, defeating the feature.

## Decision

**Use `SkiaSharp.SKImageFilter.CreateBlur` with sigma=40, tile mode Clamp.**

- Reference the SkiaSharp NuGet package with `Private="false"` so we compile against its types but do not deploy our own `SkiaSharp.dll` (Jellyfin's already loaded one wins at runtime).
- Sigma=40 default. Expose `SpoilerBlurSigma` (1..100) in admin config; map directly to Skia's sigma parameter.
- Drop the SixLabors.ImageSharp dependency we added — no longer needed.
