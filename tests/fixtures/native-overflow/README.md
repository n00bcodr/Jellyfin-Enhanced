# Native overflow parity

`metrics.json` pins Chromium's natural CSS-pixel measurements: `+1` is 24px,
`+12` is 30px, and the border-box height is 18.640625px. The shared rectangle
tolerance is the existing rendering harness's 1px. At 180px card width, twelve
29.09375px `4I` chips fit as nine chips and `+3` in a two-row bottom band.
The supplied-width reservation boundary cases remain in `../native-band-fit.json`.

The four PNGs are Chromium DPR-1 captures of the real `.je-tag-more` CSS in
Corners and Bands hosts, using the embedded Noto Sans Bold face (weight 700)
on RGB(70,90,130). They isolate the chip by disabling the band's background;
they do not assert parity of the separate band-gradient implementation.
The backend verifies each context's planned tile kind and metrics, then
compares the isolated tile pixels over that same solid background, including
its border, radius, text position, colours and lack of shadow. Only the chip
and a 2px surround contribute: mean RGB error must be at most 5/255, and no
more than 7% of pixels may differ by over 32/255. Glyph antialiasing differs
between the browser and native Skia; outside the pinned glyph bounds, mean
error is limited to 0.2/255 and maximum channel error to 10/255. Warm and uncached renders
must be identical. This catches paint regressions that width-only tests miss.

Run the browser geometry cases on an existing authorized lab without starting
another server:

```sh
JE_BROWSER_LAB_URL=http://127.0.0.1:18541 npx playwright test -c tests/browser/playwright.config.cjs native-overflow --project=chromium --workers=1
```

For deliberate baseline regeneration, add `JE_UPDATE_OVERFLOW_FIXTURES=1`
to that command, inspect all four PNGs, then run `dotnet test tests/backend
-p:JellyfinTarget=jf12`. The browser spec reads the production group styles,
layout CSS, container-query CSS and actual fitter; it never supplies chip
widths to the natural regression. Other browser projects verify geometry
without overwriting the Chromium pixel fixtures.
