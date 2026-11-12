# Seerr discovery and recommendations rewrite slice

This slice replaces 15 production entries from baseline `2e0f9251bfe833cb58866e9e245ba62be69a69ad`. It is part of the unfinished Jellyfin 12.x rewrite, not a release or whole-product parity certification.

## Ownership and runtime

`client/entries/discovery-recommendations.json` maps the seven `js/jellyseerr/discovery/*.js` and eight `js/jellyseerr/recommendations/*.js` resources to strict TypeScript under `client/src/features/seerr/{discovery,recommendations}`. The host boundary is `client/src/features/seerr/host-discovery.ts`. Production paths and component-script order are unchanged, and no endpoint was added.

Each entry is bundled separately, so state lives where only one copy can exist. `JE.discoveryFilter` owns filter/sort choices and the session-cache purge. `createDiscovery` owns one section's machine. `JE.internals.recommendationsPage` holds the page state, published entry by entry in component order. `stage.ts` reads each part at call time, because the entries depend on each other at runtime. Consumers read `JE.discoveryFilter` at call time too, since it is the published owner.

`discovery/domain.ts` is pure: filtering, sorting, batch planning, URL parsing, name resolution and decoders for every response this slice reads. Network values arrive as `unknown`. A result row stays the original object, because the shared card renderer reads many more fields; only the fields this slice uses are narrowed.

Public surfaces keep their baseline shape: every `JE.discoveryFilter` and `JE.discoveryBase` member, `JE.recommendationsPage`, and every `JE.internals.recommendationsPage` member. The catalogues, sort options and both stylesheets are byte-identical to the baseline; `artifacts/rewrite-discovery-recommendations/parity.json` records the comparison. The controller gains `dispose`, and the internals gain `disposeRender` and `sweepRenders`.

The port of upstream ec470d75 (#1044, the section joins the page, with Jellyfin's controls, a Filters menu and role lines) changed this slice on purpose, as upstream did: the sort options (labels, and Most votes), the section header and its controls, the section's placement and retry row, a person's merged credits, and the translated title of a collection's section. Upstream ships the section's parts as seven scripts of their own before `discovery-filter-utils.js`; `js/component-scripts.json` is pinned, so here `discovery-filter-utils.ts` bundles them and publishes `JE.discoveryStyles`, `JE.discoveryBusy`, `JE.discoveryMenu`, `JE.discoveryRoles`, `JE.discoverySection` and `JE.discoveryFilters`, in upstream's load order, before `JE.discoveryFilter`. Every entry reads them at call time. The ledger entry (`docs/upstream-sync.json`) lists every difference from upstream.

## Retained behavior

- **Discovery:** genre, tag, network/studio, person and collection sections, with their config gates (network stays opt-in).
- **Paging:** TV and movie feeds interleaved, with parallel batches sized from the buffer deficit and observed yield, prefetch, escalation across filtered stretches, the 500-page TMDB cap, and committing a batch up to its first failure.
- **Controls:** All/Movies/Series by CSS class, sorting (server-side for feeds, client-side for person credits and categories), and defaults restored per section.
- **Client-side paging:** chunked person credits and the retry button after a failed filmography.
- **Placement:** list-page anchoring with stale-page detection and the six-second keep-attached window.
- **Recommendations:** five media rows, genre tiles, studio and network tiles, and the "View All" category page with one or two feeds.
- **Hosts:** standalone sidebar page, Plugin Pages through `renderForCustomTab`, Custom Tabs and native tabs.
- **Content visibility:** the `discovery` Hidden Content surface, exclude-library and exclude-blocklisted settings, the Spoiler Guard sort score, and the missing-only collection rule are unchanged.
- **Text:** the discovery section's words are translated (the `discovery_*` keys upstream added with ec470d75), the collection section's `Missing from …` title included.

## Deliberate behavior changes

Each item is a baseline defect, listed with reproduction evidence in `artifacts/rewrite-discovery-recommendations/`.

- **Identity.** Recommendations had no identity handling. An identity change now closes both pages, disposes every render, ends category requests and clears slider caches, genre lists and filter/sort choices. Renders, category states and discovery renders are bound to the session epoch, including silent adoption, and a discovery render the session ends also removes its section.
- **Render ownership.** Each container owns its render, so opening the page no longer cancels a tab's render and strands its skeleton. Hiding a page, deactivating a tab, leaving home or losing a container ends the render, disconnects its row observers, stops sticky tracking and empties the container. A tab therefore re-renders when reactivated after leaving home, served mostly from the request cache. The baseline kept that DOM.
- **Category paging.** Category requests carry their state's signal, so a sort reload or a closed page cancels them instead of letting them finish into the cache. Yield and duplicate tracking now belong to the state. Closing the page empties it. Back returns to the standalone page when the category was opened from there.
- **Genre and tag resolution.** A failed or empty genre list is no longer remembered as "no genres". The merged map and the tag keyword cache are per identity. The keyword cache now shares the per-user session cache, which adds a `keyword-id` sessionStorage entry.
- **Malformed data.** A page of the wrong shape counts as a failed page, leaving its neighbour's results and the retry path intact. Non-object rows are dropped. Rows with no usable name no longer abort a company, person or keyword search.
- **Empty first chunk.** A person whose first 40 credits are all filtered out now gets a section, seeded from the first chunk that yields a card.
- **Network matching.** Whole words only: Skydance is not Sky, and a blank name matches nothing. This changes results for names that only matched as a fragment, such as `MTV2` or `FXX`, which now use the studio feed.
- **Tags with `%`.** These keep their section.
- **Detail placement.** A detail section no longer joins the outgoing page during a transition.
- **Failed batches.** A card that fails to build in a feed or category batch now costs a retry. The baseline marked the batch as seen first and lost its titles, and rolling back only the page number left `hasMore` false on the last page. Repeats are now tracked by this slice, marked after rendering, so `JE.seamlessScroll.createDeduplicator` is no longer consumed here.
- **Sorting under a filter.** A sort reload now renders both media types and leaves hiding to the filter. The baseline rendered only the selected type, so All was missing the other type's first page.
- **Failure states.** When every row failed, the page offers a retry. A failed or empty genre slider is retried after 60 seconds.
- **Markup.** Tile and sidebar markup is built with the DOM, so slider data cannot inject attributes. The inline `onerror` handler is gone.
- **Page events.** Closing the page announces one `viewhide` rather than two. The standalone page uses the container inside it rather than the first element with that id.
- **Parsing.** A malformed `tmdbId` now falls back to a name search instead of ending the lookup.

## Evidence

Tests execute the generated scripts on the emitted core runtime.

- `tests/frontend/pages/pages-discovery-boundaries.test.mjs` and `pages-recommendations-boundaries.test.mjs`: 75 tests, mostly through the shipped entries in component order. Against the untouched baseline scripts, 34 fail and 41 pass. Of the 34, two fail only partly because of the defect: one reads a new internal field and one calls the new `dispose`. A third covers silent first adoption, which is hardening, not a user-visible defect.
- `tests/browser/discovery-recommendations-rewrite.spec.cjs`: one Chromium journey with real layout and the real scroll engine.
- A mutation pass applies 44 single defects to a copy of the source: 42 are caught. The two survivors are equivalent. The core lease rejects a stale genre list before the storage check, and slider keys include the session epoch, so clearing them only frees memory.
- No existing assertion changed.

Exact commands, results, hashes and the mutation run are in `artifacts/rewrite-discovery-recommendations/report.md`.

## Limitations

- `jellyseerr/seamless-scroll.js`, `jellyseerr.js`, `api.js`, `ui-cards.js` and `seerr-status.js` belong to other groups. Request mutations happen inside the shared cards, so binding them to the originating identity is that group's work.
- The fixtures are not a Jellyfin 12.4 host. Real Seerr and TMDB responses, parental filtering, `.itemDetailPage` placement on the live router, Plugin Pages inline scripts, Custom Tabs, native-tab integration, mobile layouts, visual parity and all locales remain parent-owned host validation.
- The `isStalePage` check for detail pages can delay a section by up to three seconds if the router reuses the same page element for a new item. This has not been exercised on a live host.
- Backend authorization of the endpoints this slice reads was not reviewed.

Independent review, inventory refresh, the combined gate and real-host runs remain parent-owned. No commit, push, deployment, live install or PR was performed.
