# media-tags

Media tags: the poster tag pipeline, cache store, renderer base and contracts (`pipeline/`), the item tag editor and menu (`editor/`), one folder per tag type (`types/<type>/`: quality, direct-play, language, people, status, ratings, age-rating, awards, genre, logo, custom), layout, looks, poster colours and tag styles (`layout/`), the user-settings panels (`settings/`) and the admin Media Tags page (`admin/`; formerly `features/admin-tags`).

Owner: Jellyfin Enhanced maintainers. Backend counterpart: `Features/MediaTags/` (admin routes in `JeMediaTagsController.Admin.cs`) (PLAN.md canonical feature list).

## Entry points → shipped files

Sources are relative to this folder; outputs are relative to `Jellyfin.Plugin.JellyfinEnhanced/` and declared in `client/entries/admin-tags.json`, `client/entries/tag-runtime.json`, `client/entries/tag-rules.json`, `client/entries/settings-panel.json`. Load position is the 1-based index among the scripts in `js/component-scripts.json` (`–` = not in that list; loaded by its page or another script). `tests/frontend/architecture/feature-readme.test.mjs` checks this table against `client/generated-manifest.json`: update it whenever an entry source moves or an output is added.

| source | output | load position |
|---|---|---|
| `admin/admin-tags.ts` | `js/enhanced/admintags/admin-tags.js` | – |
| `admin/custom-rules-editor.ts` | `js/enhanced/admintags/custom-rules-editor.js` | – |
| `admin/sections/agerating.ts` | `js/enhanced/admintags/sections/agerating.js` | – |
| `admin/sections/awards.ts` | `js/enhanced/admintags/sections/awards.js` | – |
| `admin/sections/badges.ts` | `js/enhanced/admintags/sections/badges.js` | – |
| `admin/sections/colours.ts` | `js/enhanced/admintags/sections/colours.js` | – |
| `admin/sections/custom.ts` | `js/enhanced/admintags/sections/custom.js` | – |
| `admin/sections/genre.ts` | `js/enhanced/admintags/sections/genre.js` | – |
| `admin/sections/language.ts` | `js/enhanced/admintags/sections/language.js` | – |
| `admin/sections/layout.ts` | `js/enhanced/admintags/sections/layout.js` | – |
| `admin/sections/logos.ts` | `js/enhanced/admintags/sections/logos.js` | – |
| `admin/sections/overview.ts` | `js/enhanced/admintags/sections/overview.js` | – |
| `admin/sections/people.ts` | `js/enhanced/admintags/sections/people.js` | – |
| `admin/sections/portable.ts` | `js/enhanced/admintags/sections/portable.js` | – |
| `admin/sections/quality.ts` | `js/enhanced/admintags/sections/quality.js` | – |
| `admin/sections/rating.ts` | `js/enhanced/admintags/sections/rating.js` | – |
| `admin/sections/rules.ts` | `js/enhanced/admintags/sections/rules.js` | – |
| `admin/sections/server.ts` | `js/enhanced/admintags/sections/server.js` | – |
| `admin/sections/status.ts` | `js/enhanced/admintags/sections/status.js` | – |
| `admin/tag-styles-editor.ts` | `js/enhanced/admintags/tag-styles-editor.js` | – |
| `editor/tag-item-editor-entry.ts` | `js/tags/tag-item-editor.js` | 155 |
| `editor/tag-item-menu-entry.ts` | `js/tags/tag-item-menu.js` | 156 |
| `layout/poster-colours-entry.ts` | `js/tags/tag-poster-colours.js` | 150 |
| `layout/tag-layout-entry.ts` | `js/core/tag-layout.js` | 9 |
| `layout/tag-layout-styles-entry.ts` | `js/tags/tag-layout-styles.js` | 18 |
| `layout/tag-look-entry.ts` | `js/core/tag-look.js` | 10 |
| `layout/tag-styles-entry.ts` | `js/tags/tag-styles.js` | 153 |
| `pipeline/tag-cache-store-entry.ts` | `js/tags/tag-cache-store.js` | 16 |
| `pipeline/tag-pipeline-entry.ts` | `js/tags/tag-pipeline.js` | 17 |
| `pipeline/tag-renderer-base-entry.ts` | `js/core/tag-renderer-base.js` | 8 |
| `settings/ui-panel-media-tags.ts` | `js/enhanced/settingspanel/ui-panel-media-tags.js` | 78 |
| `settings/ui-panel-tag-editor.ts` | `js/enhanced/settingspanel/ui-panel-tag-editor.js` | 72 |
| `settings/ui-panel-tag-looks.ts` | `js/enhanced/settingspanel/ui-panel-tag-looks.js` | 75 |
| `settings/ui-panel-tag-portable.ts` | `js/enhanced/settingspanel/ui-panel-tag-portable.js` | 77 |
| `settings/ui-panel-tag-preview.ts` | `js/enhanced/settingspanel/ui-panel-tag-preview.js` | 76 |
| `types/age-rating/ageratingtags-entry.ts` | `js/tags/ageratingtags.js` | 145 |
| `types/awards/awardstags-entry.ts` | `js/tags/awardstags.js` | 146 |
| `types/custom/customtags-entry.ts` | `js/tags/customtags.js` | 152 |
| `types/direct-play/tag-direct-play-entry.ts` | `js/tags/tag-direct-play.js` | 147 |
| `types/genre/genretags-entry.ts` | `js/tags/genretags.js` | 140 |
| `types/language/languagetags-entry.ts` | `js/tags/languagetags.js` | 141 |
| `types/language/media-language-entry.ts` | `js/core/media-language.js` | 6 |
| `types/logo/logotags-entry.ts` | `js/tags/logotags.js` | 151 |
| `types/people/peopletags-entry.ts` | `js/tags/peopletags.js` | 142 |
| `types/quality/qualitytags-entry.ts` | `js/tags/qualitytags.js` | 143 |
| `types/ratings/rating-sources-entry.ts` | `js/tags/rating-sources.js` | 11 |
| `types/ratings/ratingtags-entry.ts` | `js/tags/ratingtags.js` | 144 |
| `types/ratings/userreviewtags-entry.ts` | `js/tags/userreviewtags.js` | 154 |
| `types/status/status-vocabulary-entry.ts` | `js/tags/status-vocabulary.js` | 148 |
| `types/status/statustags-entry.ts` | `js/tags/statustags.js` | 149 |

## Public API and global slots

`public-api.ts` is the only module another feature may import, and only with `import type` (feature-boundaries rule 1). It holds types only, no runtime code.

- Facades this feature publishes on `window.JellyfinEnhanced`: `tagPipeline`, `tagCacheStore`, `tagDirectPlay`, `reinitializeTagLayout`, `reinitializeQualityTags`, `adminTags`, `appendUserRatingToContainer`; `peopleTags` (step C4: the same object as its `JE.internals.peopleTags` slot, for the details page).
- `JE.internals` slots it owns (`tests/frontend/architecture/internals-owners.json`): `peopleTags`.
- `js/tags/tag-item-menu.js` also carries `editor/maintainerr-item-menu.ts` (upstream's `tags/maintainerr-item-menu.js`, the administrators' Mark / Keep / Postpone rows in the item menu, `JE.maintainerrMenu` for tests): the load order is pinned, so it has no script of its own, and the Media Tags row's capture listener hands it each ⋮ press.

## Settings / admin UI

`settings/` holds the Media Tags user-settings panels (`js/enhanced/settingspanel/ui-panel-media-tags.js`, `ui-panel-tag-*.js`); `admin/` holds the admin Media Tags page (`js/enhanced/admintags/**`) and its bridge `admin/host.ts`.

## Tests

```bash
node --test tests/frontend/features/media-tags/*.test.mjs tests/frontend/features/media-tags/admin/*.test.mjs tests/frontend/core/core-media-language.test.mjs tests/frontend/bootstrap/bootstrap-{tag-*,media-tags-*,custom-tags-hub}.test.mjs
```

Also: `tests/client-build/tag-data.test.mjs` (run by `npm run test:client-build`).

[`docs/feature-map.json`](../../../../docs/feature-map.json) lists this feature's test folders. `npm test` runs them all.

## Generated files here (do not edit)

Listed in `GENERATED_SOURCES` (`tests/frontend/architecture/scan.mjs`). Scripts and tests pin their paths (frontend.md §0.1), so a move updates those in the same commit:

- `types/status/status-vocabulary.ts`
- `types/quality/compact-quality.ts`
- `types/genre/genre-table.ts`

Hand-written source-of-truth tables, not generated (E1 decision (a)): `types/awards/awards-data.ts`, `types/ratings/rating-data.ts` and `types/language/media-language.ts` (`scripts/build_poster_assets.py` only reads them), and `types/quality/quality-data.ts`, whose aspect-ratio region alone is rewritten by `scripts/generate_technical_ratios.py` between its in-body markers. Edit them by hand.
