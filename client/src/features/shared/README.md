# shared

Pure helpers every feature may import (feature-boundaries rule 1): DOM and settings-value readers, item, locale and URL helpers, the response decoders and session lease shared by activity and catchup (`wire.ts`), the settings panels' reads of the panel bridge and ApiClient shared by settings-panel, media-tags and hidden-content (`panel-host.ts`), plus the shared helpers, icons, themer and translations scripts.

Owner: Jellyfin Enhanced maintainers. Backend counterpart: none (part of Platform; not the backend `Shared/` layer) (PLAN.md canonical feature list).

## Entry points → shipped files

Sources are relative to this folder; outputs are relative to `Jellyfin.Plugin.JellyfinEnhanced/` and declared in `client/entries/shared.json`. Load position is the 1-based index among the scripts in `js/component-scripts.json` (`–` = not in that list; loaded by its page or another script). `tests/frontend/architecture/feature-readme.test.mjs` checks this table against `client/generated-manifest.json`: update it whenever an entry source moves or an output is added.

| source | output | load position |
|---|---|---|
| `helpers-entry.ts` | `js/enhanced/helpers.js` | 13 |
| `icons-entry.ts` | `js/enhanced/icons.js` | 19 |
| `themer-entry.ts` | `js/enhanced/themer.js` | 65 |
| `translations-entry.ts` | `js/enhanced/translations.js` | – |

## Public API and global slots

`public-api.ts` is the only module another feature may import, and only with `import type` (feature-boundaries rule 1). It holds types only, no runtime code.

- Facades this feature publishes on `window.JellyfinEnhanced`: none.
- `JE.internals` slots it owns (`tests/frontend/architecture/internals-owners.json`): none.

## Settings / admin UI

None in this folder. Any toggles are in the settings-panel shell (`settings-panel/ui-panel-settings.ts`) until step A5 moves them into per-feature `settings/` sections.

## Tests

```bash
node --test tests/frontend/core/core-shared-*.test.mjs tests/frontend/core/core-translat*.test.mjs
```

[`docs/feature-map.json`](../../../../docs/feature-map.json) lists this feature's test folders. `npm test` runs them all.

## Generated files here (do not edit)

None.
