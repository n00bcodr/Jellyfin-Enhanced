# Loader and standalone pages

Status: typed replacement, published as generated outputs. It is not a claim of real-host parity. See "Not verified".

`js/plugin.js` and the seven `PluginPages/*.html` scripts are generated from strict TypeScript. Do not edit the outputs.

| Source | Output |
| --- | --- |
| `client/src/bootstrap/loader/entry.ts` | `js/plugin.js` (`client/entries/bootstrap-pages.json`) |
| `client/src/pages/<page>-page.ts` and `client/html/bootstrap-pages/<Page>.html` | `PluginPages/<Page>.html` (`client/html-entries/bootstrap-pages.json`) |
| `client/src/host/bootstrap-pages-host.ts` | The only module that reads these window globals |

## Loader

`plugin.js` is one entry, so `createBootstrapClient` and `createConfigLoader` exist once. Nothing else may import them: another entry would get a second copy of the bootstrap promise, prefetched answers and private-key list. `js/contracts/bootstrap.js` stays a lazily loaded script, and only its types are imported.

Behaviour that must not regress:

- Identity is host-derived: user, server, URL, token and an epoch advanced by `je:user-changed`. A response that resolves under a different identity is dropped. Shared promises and prefetched answers are scoped to it.
- Authority comes from `getCurrentUser()`, never from a response. A missing or non-boolean policy rejects the whole bootstrap, which then uses the per-endpoint fallback.
- The validator global is untrusted until all three parsers exist.
- The bundle is fetched in idle time at low priority. Modules run in manifest order in short idle slices. A module that throws is logged, rethrown asynchronously, and does not stop the run.
- A session change during component loading resets user-scoped globals, then reloads for the live session. With nobody signed in, nothing is reloaded.

## Standalone pages

Plugin Pages fetches the page and calls `container.append(createContextualFragment(html))`, so the script runs during insertion and `document.currentScript` is valid. `mountPluginPage` must be called synchronously from the entry. It walks back from the script to find its own markup. Ids cannot do this: the three cached view slots keep earlier copies, and `getElementById` returns the first.

jellyfin-web restores a cached view on back navigation without running its script again. Leaving a page therefore suspends the mount and returning resumes it. A mount ends on `viewdestroy`, on `beforeunload`, or when its container is found disconnected. `sync()` is the only state transition: active means connected, shown, on the mount's route and not awaiting a new user's data.

### Borrowing unique selectors

Calendar, Downloads and Hidden Content look their container up with `getElementById`, and bookmark modals use the first `.sections.bookmarks`. A mounted page borrows that token. Other holders lose it while the page is active and get it back when it is left, so nothing is deleted. A suspended view holds no token. It therefore misses feature resets, and the mount clears it on `je:user-changed`.

`renderPage()` in Calendar and Hidden Content creates a hidden standalone page with the same id on first use. `view.reclaim()` displaces and empties that duplicate. If it took the render, the page renders again.

### Rules for a new page

- Add a template with the marker and an entry that calls `mountPluginPage`. The entry must not touch globals.
- Set `exclusive` only if the feature looks its container up globally. Passing the container explicitly is better.
- Tie listeners and timers to `view.signal`.
- A `suspend` hook must not stop a poller another surface may own. A custom tab can take over the single Downloads and Activity pollers while the page is being left.

The Calendar click listener is the one deliberate exception to `view.signal`. The feature registers the same function outside Plugin Pages mode, and removing it could remove the feature's registration. Adding it again changes nothing, so there is one listener per page load.

## Validation

```sh
node --test tests/frontend/bootstrap/bootstrap-loader-rewrite.test.mjs tests/frontend/pages/pages-plugin-pages.test.mjs tests/frontend/pages/pages-plugin-pages-features.test.mjs
npx playwright test --config tests/browser/playwright.config.cjs plugin-pages-rewrite --project=chromium
```

jsdom does not run scripts from contextual fragments, has no layout, and its `getElementById` is not document-ordered. Ownership claims therefore rest on the Chromium spec, which uses the unmodified path.

## Not verified

The Plugin Pages insertion path comes from that plugin's public source and is exercised in Chromium with a fixture host. These pages have not run on a Jellyfin 12 server with the plugin installed. jellyfin-web's view events, including `viewdestroy` and restore behaviour, are modelled from its source, not observed.
