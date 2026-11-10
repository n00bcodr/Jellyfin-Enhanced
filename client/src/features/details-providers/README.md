# details-providers

Item details page providers: external links, ratings, reviews, awards, release dates, media info, Elsewhere, DoesTheDogDie and the random button.

Owner: Jellyfin Enhanced maintainers. Backend counterpart: `Features/DetailsProviders/` (PLAN.md canonical feature list).

## Entry points → shipped files

Sources are relative to this folder; outputs are relative to `Jellyfin.Plugin.JellyfinEnhanced/` and declared in `client/entries/details-providers.json`. Load position is the 1-based index among the scripts in `js/component-scripts.json` (`–` = not in that list; loaded by its page or another script). `tests/frontend/architecture/feature-readme.test.mjs` checks this table against `client/generated-manifest.json`: update it whenever an entry source moves or an output is added.

| source | output | load position |
|---|---|---|
| `arr-links.ts` | `js/arr/arr-links.js` | 157 |
| `arr-tag-links.ts` | `js/arr/arr-tag-links.js` | 158 |
| `awards.ts` | `js/awards/awards.js` | 94 |
| `colored-ratings.ts` | `js/extras/colored-ratings.js` | 175 |
| `details-page.ts` | `js/enhanced/itemdetails/features-details-page.js` | 35 |
| `doesthedogdie.ts` | `js/others/doesthedogdie.js` | 96 |
| `elsewhere.ts` | `js/elsewhere/elsewhere.js` | 92 |
| `letterboxd-links.ts` | `js/others/letterboxd-links.js` | 182 |
| `mdblist-ratings.ts` | `js/others/mdblist-ratings.js` | 95 |
| `media-info.ts` | `js/enhanced/itemdetails/features-details-media-info.js` | 33 |
| `random-button.ts` | `js/enhanced/features-random-button.js` | 32 |
| `release-dates.ts` | `js/enhanced/itemdetails/features-release-dates.js` | 34 |
| `reviews.ts` | `js/elsewhere/reviews.js` | 93 |

## Public API and global slots

`public-api.ts` is the only module another feature may import, and only with `import type` (feature-boundaries rule 1). It holds types only, no runtime code.

- Facades this feature publishes on `window.JellyfinEnhanced`: none.
- `JE.internals` slots it owns (`tests/frontend/architecture/internals-owners.json`): `features`.

## Settings / admin UI

None in this folder. Any toggles are in the settings-panel shell (`settings-panel/ui-panel-settings.ts`) until step A5 moves them into per-feature `settings/` sections.

## Tests

```bash
node --test tests/frontend/features/details-providers/*.test.mjs tests/frontend/core/core-letterboxd.test.mjs tests/frontend/pages/pages-{awards,reviews}.test.mjs
```

[`docs/feature-map.json`](../../../../docs/feature-map.json) lists this feature's test folders. `npm test` runs them all.

## Generated files here (do not edit)

None.
