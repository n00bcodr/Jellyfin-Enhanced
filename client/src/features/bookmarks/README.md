# bookmarks

Bookmarks: the player bookmark API and the bookmarks library page.

Owner: Jellyfin Enhanced maintainers. Backend counterpart: `Features/Bookmarks/` (PLAN.md canonical feature list).

## Entry points → shipped files

Sources are relative to this folder; outputs are relative to `Jellyfin.Plugin.JellyfinEnhanced/` and declared in `client/entries/bookmarks.json`. Load position is the 1-based index among the scripts in `js/component-scripts.json` (`–` = not in that list; loaded by its page or another script). `tests/frontend/architecture/feature-readme.test.mjs` checks this table against `client/generated-manifest.json`: update it whenever an entry source moves or an output is added.

| source | output | load position |
|---|---|---|
| `bookmarks.ts` | `js/enhanced/bookmarks/bookmarks.js` | 81 |
| `library-init.ts` | `js/enhanced/bookmarks/bookmarks-library-init.js` | 88 |
| `library-items.ts` | `js/enhanced/bookmarks/bookmarks-library-items.js` | 85 |
| `library-modals.ts` | `js/enhanced/bookmarks/bookmarks-library-modals.js` | 86 |
| `library-page.ts` | `js/enhanced/bookmarks/bookmarks-library-page.js` | 83 |
| `library-render.ts` | `js/enhanced/bookmarks/bookmarks-library-render.js` | 84 |
| `library-replacements.ts` | `js/enhanced/bookmarks/bookmarks-library-replacements.js` | 87 |
| `library-styles.ts` | `js/enhanced/bookmarks/bookmarks-library-styles.js` | 82 |

## Public API and global slots

`public-api.ts` is the only module another feature may import, and only with `import type` (feature-boundaries rule 1). It holds types only, no runtime code.

- Facades this feature publishes on `window.JellyfinEnhanced`: `bookmarks`.
- `JE.internals` slots it owns (`tests/frontend/architecture/internals-owners.json`): `bookmarkLifetimes`, `bookmarksLibrary`.

## Settings / admin UI

None in this folder. Any toggles are in the settings-panel shell (`settings-panel/ui-panel-settings.ts`) until step A5 moves them into per-feature `settings/` sections.

## Tests

```bash
node --test tests/frontend/features/bookmarks/*.test.mjs
```

[`docs/feature-map.json`](../../../../docs/feature-map.json) lists this feature's test folders. `npm test` runs them all.

## Generated files here (do not edit)

None.
