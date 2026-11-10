# Administrator configuration page

The page at `#/configurationpage?name=Jellyfin%20Enhanced` and the forwarding page for the older
Media Tags address are strict TypeScript. Sources are in `client/src/admin/config/`, host access in
`client/src/host/admin-config-host.ts`, and templates in `client/html/admin-config/`.

| Production file | Source |
| --- | --- |
| `Configuration/jeAdmin.js` | `engine-entry.ts`: the schema engine, published as `window.JEAdmin` |
| `Configuration/admin/per-user.js` | `per-user-entry.ts`, from the generated `per-user-props.ts` |
| `Configuration/admin/sections.js` | `sections-entry.ts`: every tab's definitions, in `sections/` |
| `Configuration/configPage.html` | template plus `startup-entry.ts` and `page-entry.ts` |
| `Configuration/mediaTagsPage.html` | template plus `media-tags-redirect-entry.ts` |

`GET /JellyfinEnhanced/Configuration/jeAdmin.js` still serves the engine followed by every embedded
`Configuration/admin/*.js`, so these outputs stay separate bundles that meet at `window.JEAdmin`.
Outside tests and `scripts/render_config_page.mjs`, nothing else reads that global.

## Layout

- `domain/`: pure logic with no browser access: configuration reading, request failures, Custom Tabs
  planning, shortcut rules, configuration value mapping, What's New entries.
- `engine/`: the schema (`schema.ts`), rendering (`render.ts`, pure text), the sidebar shell, linked
  copies, masonry, dialogs and `lifecycle.ts`.
- `sections/`: the schema definitions, one file per tab.
- `page/`: one feature module per concern.

Each module in `page/` is `createX(m)`. It declares what it uses as `XDeps = Pick<PageModules, …>` and
reads other modules only through `m`, resolved when called, so modules can refer to each other. A
module has two phases: creating it declares its functions and looks up its elements, and its `wire()`
runs its start-up work. `page.ts` creates every module, then wires them in the page's original order.

## Start-up

The page used to load the engine with a synchronous request. Now:

1. `startup-entry.ts` adds the stylesheet, CDN route and icon font, and starts loading `jeAdmin.js`
   with a script element. It records whether the view was shown during the wait.
2. `page-entry.ts` starts at once if the engine is ready. Otherwise it hides the unbuilt content, sets
   `aria-busy`, and waits.
3. `boot.ts` mounts the sections and starts the page. A `pageshow` that arrived early is replayed once,
   so the settings still load.

The load fails if the request fails, takes over 30 seconds, or finishes without a usable engine (an
empty or non-script answer). The page then shows an alert with Retry and writes nothing.

## Lifecycle and saved data

`MountLifecycle` owns what a view registers outside its own elements: document and window listeners,
observers, timers and the dirty-state interval. It is released on `viewdestroy` and when a later mount
replaces this one, so a dropped view cannot block leaving the page.

The form holds the saved settings only after a read succeeds. While a read is running or after it
failed, Save, Apply the above and Apply all plugin settings refuse to write, because they would put the
empty form over the saved values. Retry on the warning banner reads again. A newer read owns the form:
an older one finishing later is ignored.

A save starts from a fresh `getPluginConfiguration`, so fields this page does not know stay as stored.

## Writes belong to the account that started them

Save, Apply the above, Apply all plugin settings and clear client caches run inside
`jeHoldMediaTags`. Its callback gets a `WriteScope` (`domain/write-scope.ts`) built from the origin
captured when the action was asked for: the client object, server address, server id, user id and
token. Reading it at the call, not when the queue reaches the action, keeps queued work with the
account that asked for it. The scope also honours the Media Tags tab's own `HeldSaveScope`, and works
alone when the tab has not loaded. It expires when the origin changes, when the tab's scope does, and
when the action ends.

Callers check after every awaited confirmation, read and sync, and immediately before every write or
notice. A stale action ends with an AbortError that `jeRunHeldWrite` swallows: nothing is written and
no notice goes to whoever is signed in now. Every `catch` on these paths rethrows it, because they
would otherwise report a failure or carry on to the next write. The Seerr user import runs after its
save has finished, so it holds a scope of its own from `jeWriteOrigin`.

## Text the server reads from generated files

`WhatsNewService.SchemaIdRegex` reads `Configuration/admin/*.js` as text, and the backend tests read
the same files. Bundled output prints double quotes and wraps arguments, which that pattern no longer
matches. `sections-entry.ts` therefore starts with a `/*! Lexical index */` comment, the same approach
as `docs/rewrite/admin-tags.md`, holding one `{ id: '…', type: '…' }` line per setting id the baseline
reader found. No C# reader changed.

**A new schema setting needs a line in that index**, or What's New will not announce it. A test fails
until it has one. The index deliberately leaves out 45 ids built at runtime, such as the Hidden Content
defaults: the baseline reader never saw them, and adding them would announce them as new on upgrade.

`mediaTagsPage.html` keeps a literal `window.location.replace(` for `ApiMediaTagsPageTests`.

`scripts/generate_per_user_props.py` writes `client/src/admin/config/per-user-props.ts`. Run
`npm run client:build` after it. `scripts/render_config_page.mjs`,
`scripts/generate_config_flag_groups.py` and `scripts/material-symbols/subset.py` need no change.

## Limitation kept from the baseline

If jellyfin-web keeps an older view of this page in the document and opens a new one, the two share
element ids, and lookups reach the older view. Links to this page therefore open in place. A direct
navigation that creates a second view is not handled.

## Tests

- `tests/frontend/admin/config/admin-config-rewrite.test.mjs`: the generated page and scripts, booted
  through the real start-up path, with `tests/frontend/helpers/admin-config-page.mjs`.
- `tests/fixtures/admin-config-baseline.json`: ids, sections, per-user flags, main toggles and collected
  defaults recorded from the baseline scripts. Regenerate it only for an intentional schema change.
- `tests/browser/admin-config-rewrite.spec.cjs`: Chromium, Firefox and phone journeys.
