# player

Video player: auto-skip, pause screen, playback rating badge, subtitles, track controls, frame seek and long press.

Owner: Jellyfin Enhanced maintainers. Backend counterpart: none (client-only) (PLAN.md canonical feature list).

## Entry points → shipped files

Sources are relative to this folder; outputs are relative to `Jellyfin.Plugin.JellyfinEnhanced/` and declared in `client/entries/player.json`. Load position is the 1-based index among the scripts in `js/component-scripts.json` (`–` = not in that list; loaded by its page or another script). `tests/frontend/architecture/feature-readme.test.mjs` checks this table against `client/generated-manifest.json`: update it whenever an entry source moves or an output is added.

| source | output | load position |
|---|---|---|
| `auto-skip.ts` | `js/enhanced/player/auto-skip.js` | 41 |
| `now-playing.ts` | `js/enhanced/player/now-playing.js` | 40 |
| `osd-rating.ts` | `js/enhanced/player/osd-rating.js` | 89 |
| `pausescreen.ts` | `js/enhanced/player/pausescreen.js` | 90 |
| `playback-rating-badge.ts` | `js/enhanced/player/playback-rating-badge.js` | 91 |
| `playback.ts` | `js/enhanced/player/playback.js` | 39 |
| `subtitles.ts` | `js/enhanced/player/subtitles.js` | 64 |

## Public API and global slots

`public-api.ts` is the only module another feature may import, and only with `import type` (feature-boundaries rule 1). It holds types only, no runtime code.

- Facades this feature publishes on `window.JellyfinEnhanced`: none.
- `JE.internals` slots it owns (`tests/frontend/architecture/internals-owners.json`): `autoSkip`, `nowPlaying`, `player`.

## Settings / admin UI

None in this folder. Any toggles are in the settings-panel shell (`settings-panel/ui-panel-settings.ts`) until step A5 moves them into per-feature `settings/` sections.

## Tests

```bash
node --test tests/frontend/features/player/*.test.mjs
```

[`docs/feature-map.json`](../../../../docs/feature-map.json) lists this feature's test folders. `npm test` runs them all.

## Generated files here (do not edit)

None.
