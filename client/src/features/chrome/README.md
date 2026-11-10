# chrome

Page chrome: header actions, native tabs, branding (login image, splash screen, plugin icons), theme selector, active streams, plugin revisions and the event bus.

Owner: Jellyfin Enhanced maintainers. Backend counterpart: `Features/Chrome/` (PLAN.md canonical feature list).

## Entry points → shipped files

Sources are relative to this folder; outputs are relative to `Jellyfin.Plugin.JellyfinEnhanced/` and declared in `client/entries/chrome.json`. Load position is the 1-based index among the scripts in `js/component-scripts.json` (`–` = not in that list; loaded by its page or another script). `tests/frontend/architecture/feature-readme.test.mjs` checks this table against `client/generated-manifest.json`: update it whenever an entry source moves or an output is added.

| source | output | load position |
|---|---|---|
| `active-streams-entry.ts` | `js/extras/active-streams.js` | 179 |
| `events-entry.ts` | `js/enhanced/events.js` | 38 |
| `header-actions-entry.ts` | `js/enhanced/header-actions.js` | 14 |
| `login-image-entry.ts` | `js/extras/login-image.js` | – |
| `native-tabs-entry.ts` | `js/enhanced/native-tabs.js` | 15 |
| `plugin-icons-entry.ts` | `js/extras/plugin-icons.js` | 176 |
| `plugin-revisions-entry.ts` | `js/extras/plugin-revisions.js` | 177 |
| `splashscreen-entry.ts` | `js/others/splashscreen.js` | – |
| `theme-selector-entry.ts` | `js/extras/theme-selector.js` | 178 |

## Public API and global slots

`public-api.ts` is the only module another feature may import, and only with `import type` (feature-boundaries rule 1). It holds types only, no runtime code.

- Facades this feature publishes on `window.JellyfinEnhanced`: `canonicalCombo` (step C4; the same function as its `JE.internals.canonicalCombo` slot, read by the settings panel's shortcut editor).
- `JE.internals` slots it owns (`tests/frontend/architecture/internals-owners.json`): `canonicalCombo`.

## Settings / admin UI

None in this folder. Any toggles are in the settings-panel shell (`settings-panel/ui-panel-settings.ts`) until step A5 moves them into per-feature `settings/` sections.

## Tests

```bash
node --test tests/frontend/chrome/*.test.mjs tests/frontend/bootstrap/bootstrap-{header,native-tabs}.test.mjs tests/frontend/core/core-theme.test.mjs
```

[`docs/feature-map.json`](../../../../docs/feature-map.json) lists this feature's test folders. `npm test` runs them all.

## Generated files here (do not edit)

None.
