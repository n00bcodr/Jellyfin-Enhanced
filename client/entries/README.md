# Browser entry manifests

Each feature owner adds a flat `<feature>.json` object mapping output paths relative to
`Jellyfin.Plugin.JellyfinEnhanced/` to entry sources relative to the repository:

```json
{ "js/core/session.js": "client/src/core/session-entry.ts" }
```

The schema is `../entry-manifest.schema.json` (outside this directory so it is not
discovered as an entry). No metadata keys or empty placeholder manifests. Every
JSON file here is discovered in filename order. Keep manifests directly in this
directory. Paths use `/`, with no absolute paths, traversal or symlinks. Outputs
must end in `.js`; entries must be non-declaration `.ts` files under `client/src`.
Outputs must not collide by case or embedded-resource name. Output directories
must be ASCII identifiers (`[A-Za-z_][A-Za-z0-9_]*`); basenames allow letters,
digits, underscores and hyphens, followed by one `.js` extension. The schema and
builder reject hyphenated directories and extra filename dots because MSBuild
can rename them or interpret a suffix as a satellite-resource culture. TypeScript
source paths are independent of this production-resource naming restriction.

## Manifests and source folders

Sources are grouped by feature under `client/src/features/<feature>/`; everything
else is platform (`bootstrap/`, `core/`, `host/`, `pages/`, `contracts/`) or the
admin configuration page (`admin/config/`). [`docs/feature-map.json`](../../docs/feature-map.json)
is the canonical feature list, and each feature's `README.md` lists every output
whose source lies in that folder, with its load position.

The manifest file names and output keys predate the restructure and are kept
(`js/component-scripts.json` pins the load order), so a manifest's name does not
always match the folder of its sources:

| Manifest | Sources under `client/src/` |
|---|---|
| `admin-config.json` | `admin/config/` |
| `admin-tags.json` | `features/media-tags/admin/` (admin-tags is folded into media-tags) |
| `bookmarks.json` | `features/bookmarks/` |
| `bootstrap-pages.json` | `bootstrap/loader/` |
| `calendar.json` | `features/calendar/` |
| `chrome.json` | `features/chrome/` |
| `contracts.json` | `contracts/` |
| `core-api.json`, `core-runtime.json`, `core-ui.json` | `core/` |
| `details-providers.json` | `features/details-providers/` |
| `discovery-recommendations.json` | `features/seerr/discovery/`, `features/seerr/recommendations/` |
| `downloads.json` | `features/downloads/` |
| `hidden-content.json` | `features/hidden-content/` |
| `player.json` | `features/player/` |
| `seerr-core.json`, `seerr-details.json` | `features/seerr/core/`, `features/seerr/details/` |
| `settings-panel.json` | `features/settings-panel/`, plus the sections in `features/hidden-content/settings/` and `features/media-tags/settings/` |
| `settings.json` | `features/settings/` |
| `shared.json` | `features/shared/` |
| `social-pages.json` | `features/activity/`, `features/catchup/` |
| `spoiler-guard.json` | `features/spoiler-guard/` |
| `tag-rules.json`, `tag-runtime.json` | `features/media-tags/` (`pipeline/`, `layout/`, `editor/`, `types/<type>/`) |

Moving a source edits only the right-hand side of its mapping. Never rename an
output key or edit `js/component-scripts.json`.

Run `npm run client:build`, then commit source, manifests, generated `.js` and
`.js.map` files, and `client/generated-manifest.json` together. The build never
changes unmapped legacy JavaScript. An empty directory is temporarily supported
while the first runtime entry is implemented, with an explicit status message;
it does not mean the rewrite is complete.

See [frontend build](../../docs/rewrite/frontend-build.md) for validation and
removing or moving an entry.
