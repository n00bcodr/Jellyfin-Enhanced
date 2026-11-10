# spoiler-guard

Spoiler guard: blurring unwatched episode titles, images and overviews, with snooze, per-item toggles and the Seerr toggle.

Owner: Jellyfin Enhanced maintainers. Backend counterpart: `Features/SpoilerGuard/` (PLAN.md canonical feature list).

## Entry points → shipped files

Sources are relative to this folder; outputs are relative to `Jellyfin.Plugin.JellyfinEnhanced/` and declared in `client/entries/spoiler-guard.json`. Load position is the 1-based index among the scripts in `js/component-scripts.json` (`–` = not in that list; loaded by its page or another script). `tests/frontend/architecture/feature-readme.test.mjs` checks this table against `client/generated-manifest.json`: update it whenever an entry source moves or an output is added.

| source | output | load position |
|---|---|---|
| `detail-button.ts` | `js/enhanced/spoilerguard/detail-button.js` | 29 |
| `dialog.ts` | `js/enhanced/spoilerguard/dialog.js` | 24 |
| `identity.ts` | `js/enhanced/spoilerguard/identity.js` | 25 |
| `ids.ts` | `js/enhanced/spoilerguard/ids.js` | 20 |
| `image-refresh.ts` | `js/enhanced/spoilerguard/image-refresh.js` | 22 |
| `index.ts` | `js/enhanced/spoilerguard/index.js` | 31 |
| `seerr-toggle.ts` | `js/enhanced/spoilerguard/seerr-toggle.js` | 28 |
| `settings-tab.ts` | `js/enhanced/spoilerguard/settings-tab.js` | 27 |
| `snooze.ts` | `js/enhanced/spoilerguard/snooze.js` | 23 |
| `state.ts` | `js/enhanced/spoilerguard/state.js` | 21 |
| `styles.ts` | `js/enhanced/spoilerguard/styles.js` | 26 |
| `watched-refresh.ts` | `js/enhanced/spoilerguard/watched-refresh.js` | 30 |

## Public API and global slots

`public-api.ts` is the only module another feature may import, and only with `import type` (feature-boundaries rule 1). It holds types only, no runtime code.

- Facades this feature publishes on `window.JellyfinEnhanced`: `spoilerBlur` (step C4 added `appendSeerrToggle`, `buildSettingsHtml` and `wireSettings`, forwarded from the `JE.internals.spoilerGuard` registry for seerr and the settings panel).
- `JE.internals` slots it owns (`tests/frontend/architecture/internals-owners.json`): `spoilerGuard`.

## Settings / admin UI

None in this folder. Any toggles are in the settings-panel shell (`settings-panel/ui-panel-settings.ts`) until step A5 moves them into per-feature `settings/` sections.

## Tests

```bash
node --test tests/frontend/features/spoiler-guard/*.test.mjs
```

[`docs/feature-map.json`](../../../../docs/feature-map.json) lists this feature's test folders. `npm test` runs them all.

## Generated files here (do not edit)

None.
