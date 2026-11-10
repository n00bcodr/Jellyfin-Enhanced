# calendar

Calendar page (custom tab) of upcoming releases.

Owner: Jellyfin Enhanced maintainers. Backend counterpart: `Features/Calendar/` (PLAN.md canonical feature list).

## Entry points → shipped files

Sources are relative to this folder; outputs are relative to `Jellyfin.Plugin.JellyfinEnhanced/` and declared in `client/entries/calendar.json`. Load position is the 1-based index among the scripts in `js/component-scripts.json` (`–` = not in that list; loaded by its page or another script). `tests/frontend/architecture/feature-readme.test.mjs` checks this table against `client/generated-manifest.json`: update it whenever an entry source moves or an output is added.

| source | output | load position |
|---|---|---|
| `calendar-custom-tab.ts` | `js/arr/calendar/calendar-custom-tab.js` | 173 |
| `calendar-page-actions.ts` | `js/arr/calendar/calendar-page-actions.js` | 170 |
| `calendar-page-data.ts` | `js/arr/calendar/calendar-page-data.js` | 167 |
| `calendar-page-init.ts` | `js/arr/calendar/calendar-page-init.js` | 171 |
| `calendar-page-render-events.ts` | `js/arr/calendar/calendar-page-render-events.js` | 168 |
| `calendar-page-render-views.ts` | `js/arr/calendar/calendar-page-render-views.js` | 169 |
| `calendar-page-styles.ts` | `js/arr/calendar/calendar-page-styles.js` | 166 |

## Public API and global slots

`public-api.ts` is the only module another feature may import, and only with `import type` (feature-boundaries rule 1). It holds types only, no runtime code.

- Facades this feature publishes on `window.JellyfinEnhanced`: none.
- `JE.internals` slots it owns (`tests/frontend/architecture/internals-owners.json`): `calendarLifetime`, `calendarPage`.

## Settings / admin UI

None in this folder. Any toggles are in the settings-panel shell (`settings-panel/ui-panel-settings.ts`) until step A5 moves them into per-feature `settings/` sections.

## Tests

```bash
node --test tests/frontend/pages/pages-calendar*.test.mjs
```

[`docs/feature-map.json`](../../../../docs/feature-map.json) lists this feature's test folders. `npm test` runs them all.

## Generated files here (do not edit)

None.
