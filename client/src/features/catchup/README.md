# catchup

Catch-up deck and page (custom tab).

Owner: Jellyfin Enhanced maintainers. Backend counterpart: `Features/Catchup/` (PLAN.md canonical feature list).

## Entry points → shipped files

Sources are relative to this folder; outputs are relative to `Jellyfin.Plugin.JellyfinEnhanced/` and declared in `client/entries/social-pages.json`. Load position is the 1-based index among the scripts in `js/component-scripts.json` (`–` = not in that list; loaded by its page or another script). `tests/frontend/architecture/feature-readme.test.mjs` checks this table against `client/generated-manifest.json`: update it whenever an entry source moves or an output is added.

| source | output | load position |
|---|---|---|
| `catchup-activity.ts` | `js/enhanced/catchup/catchup-activity.js` | 61 |
| `catchup-core.ts` | `js/enhanced/catchup/catchup-core.js` | 58 |
| `catchup-custom-tab.ts` | `js/enhanced/catchup/catchup-custom-tab.js` | 63 |
| `catchup-deck.ts` | `js/enhanced/catchup/catchup-deck.js` | 60 |
| `catchup-page.ts` | `js/enhanced/catchup/catchup-page.js` | 62 |
| `catchup-styles.ts` | `js/enhanced/catchup/catchup-styles.js` | 59 |

## Public API and global slots

`public-api.ts` is the only module another feature may import, and only with `import type` (feature-boundaries rule 1). It holds types only, no runtime code.

- Facades this feature publishes on `window.JellyfinEnhanced`: none.
- `JE.internals` slots it owns (`tests/frontend/architecture/internals-owners.json`): `catchUp`.

## Settings / admin UI

None in this folder. Any toggles are in the settings-panel shell (`settings-panel/ui-panel-settings.ts`) until step A5 moves them into per-feature `settings/` sections.

## Tests

```bash
node --test tests/frontend/pages/pages-social-*.test.mjs
```

[`docs/feature-map.json`](../../../../docs/feature-map.json) lists this feature's test folders. `npm test` runs them all.

## Generated files here (do not edit)

None.
