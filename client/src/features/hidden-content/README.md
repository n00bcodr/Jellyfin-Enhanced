# hidden-content

Hidden content: hide buttons, filtering, the hidden-content page and the home-screen removal features.

Owner: Jellyfin Enhanced maintainers. Backend counterpart: `Features/HiddenContent/` (PLAN.md canonical feature list).

## Entry points → shipped files

Sources are relative to this folder; outputs are relative to `Jellyfin.Plugin.JellyfinEnhanced/` and declared in `client/entries/hidden-content.json`, `client/entries/settings-panel.json`. Load position is the 1-based index among the scripts in `js/component-scripts.json` (`–` = not in that list; loaded by its page or another script). `tests/frontend/architecture/feature-readme.test.mjs` checks this table against `client/generated-manifest.json`: update it whenever an entry source moves or an output is added.

| source | output | load position |
|---|---|---|
| `features-remove-home.ts` | `js/enhanced/homeremoval/features-remove-home.js` | 36 |
| `features-remove-multiselect.ts` | `js/enhanced/homeremoval/features-remove-multiselect.js` | 37 |
| `hidden-content-buttons.ts` | `js/enhanced/hiddencontent/hidden-content-buttons.js` | 48 |
| `hidden-content-custom-tab.ts` | `js/enhanced/hiddencontent/hidden-content-custom-tab.js` | 57 |
| `hidden-content-data.ts` | `js/enhanced/hiddencontent/hidden-content-data.js` | 42 |
| `hidden-content-dialogs.ts` | `js/enhanced/hiddencontent/hidden-content-dialogs.js` | 45 |
| `hidden-content-filter.ts` | `js/enhanced/hiddencontent/hidden-content-filter.js` | 47 |
| `hidden-content-init.ts` | `js/enhanced/hiddencontent/hidden-content-init.js` | 49 |
| `hidden-content-page-admin.ts` | `js/enhanced/hiddencontent/hidden-content-page-admin.js` | 52 |
| `hidden-content-page-cards.ts` | `js/enhanced/hiddencontent/hidden-content-page-cards.js` | 53 |
| `hidden-content-page-init.ts` | `js/enhanced/hiddencontent/hidden-content-page-init.js` | 56 |
| `hidden-content-page-nav.ts` | `js/enhanced/hiddencontent/hidden-content-page-nav.js` | 55 |
| `hidden-content-page-render.ts` | `js/enhanced/hiddencontent/hidden-content-page-render.js` | 54 |
| `hidden-content-page-state.ts` | `js/enhanced/hiddencontent/hidden-content-page-state.js` | 50 |
| `hidden-content-page-styles.ts` | `js/enhanced/hiddencontent/hidden-content-page-styles.js` | 51 |
| `hidden-content-panel.ts` | `js/enhanced/hiddencontent/hidden-content-panel.js` | 46 |
| `hidden-content-save.ts` | `js/enhanced/hiddencontent/hidden-content-save.js` | 43 |
| `hidden-content-styles.ts` | `js/enhanced/hiddencontent/hidden-content-styles.js` | 44 |
| `settings/ui-panel-hidden-content.ts` | `js/enhanced/settingspanel/ui-panel-hidden-content.js` | 73 |

## Public API and global slots

`public-api.ts` is the only module another feature may import, and only with `import type` (feature-boundaries rule 1). It holds types only, no runtime code.

- Facades this feature publishes on `window.JellyfinEnhanced`: `hiddenContent`; `homeRemoval` (step C4: `buildNativeActionSheetItem`, forwarded from its `features` slot, for Media Tags' item menu).
- `JE.internals` slots it owns (`tests/frontend/architecture/internals-owners.json`): `features`, `hiddenContent`, `hiddenContentPage`, `hiddenContentRuntime`.

## Settings / admin UI

`settings/ui-panel-hidden-content.ts` (the user-settings panel section, shipped as `js/enhanced/settingspanel/ui-panel-hidden-content.js`).

## Tests

```bash
node --test tests/frontend/features/hidden-content/*.test.mjs tests/frontend/bootstrap/bootstrap-panel-resize.test.mjs
```

[`docs/feature-map.json`](../../../../docs/feature-map.json) lists this feature's test folders. `npm test` runs them all.

## Generated files here (do not edit)

None.
