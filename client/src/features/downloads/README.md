# downloads

Downloads / requests page (custom tab).

Owner: Jellyfin Enhanced maintainers. Backend counterpart: `Features/Downloads/` (PLAN.md canonical feature list).

## Entry points → shipped files

Sources are relative to this folder; outputs are relative to `Jellyfin.Plugin.JellyfinEnhanced/` and declared in `client/entries/downloads.json`. Load position is the 1-based index among the scripts in `js/component-scripts.json` (`–` = not in that list; loaded by its page or another script). `tests/frontend/architecture/feature-readme.test.mjs` checks this table against `client/generated-manifest.json`: update it whenever an entry source moves or an output is added.

| source | output | load position |
|---|---|---|
| `actions-entry.ts` | `js/arr/requests/requests-page-actions.js` | 164 |
| `custom-tab-entry.ts` | `js/arr/requests/requests-custom-tab.js` | 172 |
| `data-entry.ts` | `js/arr/requests/requests-page-data.js` | 160 |
| `init-entry.ts` | `js/arr/requests/requests-page-init.js` | 165 |
| `render-cards-entry.ts` | `js/arr/requests/requests-page-render-cards.js` | 162 |
| `render-entry.ts` | `js/arr/requests/requests-page-render.js` | 163 |
| `render-helpers-entry.ts` | `js/arr/requests/requests-page-render-helpers.js` | 161 |
| `styles-entry.ts` | `js/arr/requests/requests-page-styles.js` | 159 |

## Public API and global slots

`public-api.ts` is the only module another feature may import, and only with `import type` (feature-boundaries rule 1). It holds types only, no runtime code.

- Facades this feature publishes on `window.JellyfinEnhanced`: `downloadsPage`.
- `JE.internals` slots it owns (`tests/frontend/architecture/internals-owners.json`): `requestsPage`.

## Settings / admin UI

None in this folder. Any toggles are in the settings-panel shell (`settings-panel/ui-panel-settings.ts`) until step A5 moves them into per-feature `settings/` sections.

## Tests

```bash
node --test tests/frontend/pages/pages-downloads*.test.mjs tests/frontend/features/downloads/*.test.mjs
```

[`docs/feature-map.json`](../../../../docs/feature-map.json) lists this feature's test folders. `npm test` runs them all.

## Generated files here (do not edit)

None.
