# Centre anchors — verification and handoff

Branch: `feat/tag-layouts-centres`, the supplied checkout started at `16355dba` (including earlier panel fixes above `e4089266`). Assigned worktree: `/home/jake/je-wt/tl-centres`.

## Changes

- Corners accepts `tl`, `tc`, `tr`, `ml`, `c`, `mr`, `bl`, `bc`, `br`, plus `off`, on client, server, admin editor, personal hub and rules/locks.
- Legacy values map both ways: `top-center`, `bottom-center`, `center-left`, `center-right`, `center`. Unknown strings retain the previous fallback behavior.
- The hub has nine translated Position pills in spatial 3×3 order, with Hidden beneath. Its existing preview uses the real placement code.
- Centre rows wrap and fit at most two rows. Side columns fit whole chips on short cards. Existing caps apply first, then fitting uses `+N` and accessible hidden-chip descriptions. The four original corners stay outside the new geometry work; `corners` remains outside `FIT_LAYOUTS`.
- Batched reads measure occupied corner stacks, side/top-centre indicators and progress bars before writing centre budgets. Existing top-right indicator handling is unchanged.
- Native posters parse, resolve, plan and paint every new anchor. Renderer pixel version bumped to 2. The static renderer omits whole overflowing chips without a `+N` tooltip; exceptionally wide side chips are omitted. It cannot reproduce web-only rules/locks or external Jellyfin overlays. These differences are documented.

## Checks

| Check | Result |
| --- | --- |
| `node tests/frontend/run.mjs` | 887 passed, 0 failed |
| `dotnet test tests/backend -p:JellyfinTarget=jf12` | 1,047 passed, 0 failed, 0 skipped |
| Release jf12 build, `/tmp/je-build-centres-jf12` | 0 warnings, 0 errors |
| Release jf10 build, `/tmp/je-build-centres-jf10` | 0 warnings, 0 errors |
| Offline native/web resolver parity | 50 profiles, 101 synthetic metadata entries; 0 differences |
| English translation validator | Passed |
| Production inventory `--check` | Current; no regeneration needed |
| Config flag groups generator | Ran; no generated diff |
| `git diff --check` | Passed |
| Docs images | Viewed; all Markdown image links checked |

The backend test project emits its two existing ASP.NET deprecation warnings (`ASPDEPR004`, `ASPDEPR008` in `ApiRoutingTests.cs`). The plugin release builds have no warnings.

Regression coverage includes legacy migration and promotion, unknown-slot dropping, editor order and save transport, live preview, caps and `+N`, short side columns, corner/indicator/progress reserves, rule and lock snapshots, server settings round trips, native anchor coordinates, native raster output, and preservation of existing corner coordinates when new anchors are added.

## Lab evidence

Only `je-lab-centres`, `http://127.0.0.1:18537`, was used. The container already existed when this work started; no containers, networks or volumes were created. Its lifecycle remains with the coordinator: it is left running, as the skill forbids stopping a container this worker did not create. No shared lab was touched.

`real-admin` configured through the hub: quality → top centre, status → right centre, rating → bottom centre, language → left centre, genre → centre. The series-status badge family was enabled through the hub so real Ended badges demonstrate right-centre placement. Reload verifies the saved settings. Disabling all six groups removes all card tag groups; restoring and reloading restores the five new slots. `real-viewer` retains its original four-corner settings. Frontend tests also exercise session/user switching.

All screenshots are under `.notes/shots/centres/`:

| Shot | Contents |
| --- | --- |
| `hub-groups-desktop.png`, `hub-groups-phone.png` | Quality editor, nine Position pills and preview at 1400px and 420px |
| `movies-1400.png`, `movies-420.png` | Movies grid with centre anchors |
| `series-1400.png`, `series-420.png` | 13 Reasons Why page; right-centre Ended badge |
| `series-seasons-1400.png`, `series-seasons-420.png` | Next Up episode and season cards, including count indicators |
| `legacy-viewer-{home,movies}-after.png` | Full default-viewer screenshots |
| `legacy-viewer-{home,movies}-reference-before.png` | Copies of the required phase-1a references |
| `legacy-viewer-{home,movies}-reference-crop.png` | Final screenshots cropped to the reference framing |
| `legacy-viewer-{home,movies}-cropped-diff.png` | ImageMagick comparison outputs |

The phase-1a reference images are 1400×660 crops beginning at y=90, rather than complete 1400×900 frames. Applying exactly that crop to the final screenshots produces `compare -metric AE` **0 (0)** for both home and movies. No reference pixels were changed.

Season-card geometry checks also find zero top-centre/indicator overlaps at both widths. The screenshot helper reports `failed:0`, `guardedImages:0`. There are no JE console errors or page errors. Jellyfin logs tokenless `/socket` handshake failures and missing source poster files; browser logs reflect those known server failures. Some navigations also emit a transient existing TagPipeline cache-fetch warning and use its batch fallback. The server also logged three canceled tag-cache requests during navigation, matching that fallback warning; no server error attributable to the anchor change was found.

The lab helpers are `.notes/lab-centres.mjs` (a local copy of the shared helper), `.notes/lab-centres-steps.mjs` (hub configuration and shots), and `.notes/lab-centres-checks.mjs` (season indicators and feature-off/restore). They run without embedded credentials, using the established lab account file.

## Documentation

- `docs/enhanced/tags.md`: nine anchors, wrapping/fitting, indicator reserves, default appearance, native differences, screenshot.
- `docs/enhanced/enhanced-settings.md`: 3×3 Position options.
- `docs/advanced/css-customization.md`: all nine `data-je-slot` hooks, position strings, layout and overflow hooks.
- Replaced `docs/images/tags/tag-group-editor.webp`; added `docs/images/tags/tag-layout-centres.webp`.
- `tests/poster/parity/README.md`: updated profile count and centre fixture coverage.

## Limits and pending choices

No native app was driven end to end; the resolver, planner and actual native renderer were tested. No 10.11 runtime was used (only jf10 compilation), as this task is confined to the assigned 12.1 lab. MkDocs is unavailable, so a full site build was not run; Markdown image links were checked. No independent review agent was used, in accordance with the no-child-agent instruction.

Open provisional rows in `.notes/pending-questions.md`: **CT-1** (measured occupied-corner reserves) and **CT-2** (native omission of overflowing chips, documented). No answers were fabricated and neither choice blocked work.

No push and no PR.
