# Media Tags runtime slice

This slice replaces the 19 production scripts that draw, cache and edit poster tags with
strict TypeScript. It is part of the unfinished Jellyfin 12 rewrite; it is not a statement
that the rewrite, or real-host validation of it, is complete. Baseline:
`2e0f9251bfe833cb58866e9e245ba62be69a69ad`. Entries are owned by
`client/entries/tag-runtime.json`.

| Output (`js/…`) | Implementation under `client/src/features/media-tags/` |
| --- | --- |
| `core/tag-renderer-base.js` | `pipeline/tag-renderer-base.ts`, `pipeline/scopes.ts` |
| `tags/tag-cache-store.js` | `pipeline/tag-cache-store.ts` |
| `tags/tag-pipeline.js` | `pipeline/tag-pipeline.ts` |
| `tags/tag-layout-styles.js` | `layout/tag-layout-styles.ts` |
| `tags/genretags.js` | `types/genre/genretags.ts`, `types/genre/genre-table.ts` |
| `tags/languagetags.js` | `types/language/languagetags.ts` |
| `tags/peopletags.js` | `types/people/peopletags.ts`, `types/people/people-model.ts`, `types/people/people-countries.ts` |
| `tags/qualitytags.js` | `types/quality/qualitytags.ts`, `types/quality/quality-rules.ts`, `types/quality/quality-data.ts` |
| `tags/ratingtags.js`, `tags/ageratingtags.js` | `types/ratings/ratingtags.ts`, `types/age-rating/ageratingtags.ts` |
| `tags/awardstags.js` | `types/awards/awardstags.ts`, `types/awards/awards-data.ts` |
| `tags/tag-direct-play.js` | `types/direct-play/tag-direct-play.ts`, `types/direct-play/device-profile.ts` |
| `tags/statustags.js` | `types/status/statustags.ts`, `types/status/status-facts.ts` |
| `tags/logotags.js`, `tags/customtags.js` | `types/logo/logotags.ts`, `types/custom/customtags.ts` |
| `tags/tag-styles.js`, `tags/userreviewtags.js` | `layout/tag-styles.ts`, `types/ratings/userreviewtags.ts` |
| `tags/tag-item-editor.js`, `tags/tag-item-menu.js` | `editor/tag-item-editor.ts`, `editor/tag-item-menu.ts` |

Each output has a one-line `*-entry.ts` that runs its factory against the legacy global.

## Boundaries

`client/src/features/media-tags/host.ts` is the only code that touches `window.JellyfinEnhanced`
or `window.ApiClient`, and holds this slice's two type assertions (the global and its `core`).
`TagRuntimeBridge` lists the members this slice reads and installs; nothing else is reachable.
ApiClient is resolved at each call because jellyfin-web replaces it on a server switch.

`pipeline/dto.ts` is the network and storage boundary. Unvalidated JSON is `JsonRecord`, so every read is
`unknown` and the compiler forces a narrowing before use. Readers (`record`, `records`,
`stringList`, `text`, `finite`) accept malformed input without throwing and never answer from
`Object.prototype`. Objects stay raw rather than being copied into DTOs: the pipeline and
renderers compare entries by identity and a full library holds tens of thousands of them.

`pipeline/contract.ts` holds the renderer contract (`TagSpec`, `TagCtx`) and the explicit pipeline and
renderer facades. Facades are interfaces rather than inferred return types, so a consumer and
its dependency cannot form a circular inference.

`pipeline/scopes.ts`, `types/quality/quality-rules.ts`, `types/people/people-model.ts`, `types/status/status-facts.ts` and `types/direct-play/device-profile.ts` carry
the domain rules with no JE dependency; settings and language arrive through explicit hosts.
`types/direct-play/device-profile.ts` still asks the browser what it can play, which is what it is for.

## Behaviour kept

Bridges are installed once, at their original paths and manifest positions, with every public
member retained. `features-tag-runtime-consumers.test.mjs` pins those surfaces and passes against
both the baseline JavaScript and these bundles (its hostile-document case is the one exception, see
TAG-RUNTIME-009 below).

Everything the pipeline guarantees is unchanged: one scan, one batch and one load at a time;
shared first-episode and parent lookups; cache generation, session epoch and store-gate checks
after every await; `servedAt` ordering and owner tokens in IndexedDB; paged and streamed full loads
bounded by `MEMORY_SOFT_CAP`; and `stillShows`/identity checks for recycled cards. Stored data is
untouched: localStorage key names, the `identity-owner` sentinels, the fallback envelope and the
IndexedDB database, versions, stores and key formats all keep their baseline shapes, plus the
additions below.

Stylesheets are byte-identical to the baseline. The hash of the device profile, part of every
direct-play cache key, is too, so stored answers stay addressable.

## Intentional differences

All are defects in the baseline, except where noted.

- TAG-RUNTIME-001: `putDirectPlay` now stores the media fingerprint. Without it no stored answer
  could match `sameMedia`, so the direct-play store never saved a request.
- TAG-RUNTIME-003: the status fallback entry now keeps `pr`, `sm` and `vs` (probed, `.strm`,
  versions), and `CACHE_ENTRY_VERSION` is 6. Version 5 entries are misses; they expire within the hour
  anyway. A redraw from that cache no longer probes `.strm` files or forgets the picked version.
- TAG-RUNTIME-004: a persist timer armed before a reset re-arms instead of discarding the next
  session's unsaved answers.
- TAG-RUNTIME-005: a review batch that settles after a user switch resolves to "nothing to draw".
- TAG-RUNTIME-006: a stored copy stays unconfirmed unless its replacement download succeeded.
- TAG-RUNTIME-007: a cached card under pending Spoiler Guard state draws nothing, so the post-load
  rescan can still draw its rating.
- TAG-RUNTIME-008: a native shell profile without `CodecProfiles` no longer throws in host settings.
- TAG-RUNTIME-009: an own `__proto__` group in a stored document stays an ordinary entry.

TAG-RUNTIME-002 is **not** fixed: a genre literally named "constructor" still shows
`function Object() { [native code] }` as its icon, because `tests/fixtures/genre-styles.json` pins
that output and is shared with the backend and browser suites. Fixing it needs that fixture changed
too, so the choice is the parent's.

## Generated tables

Each table has one authoritative source. Generators project it into a typed module, and `client-build` alone emits
the browser script.

| Table | Source | Projection | Generator |
| --- | --- | --- | --- |
| Genre icons and labels | `js/tags/genre-icons.json` | `types/genre/genre-table.ts` | `scripts/generate_genre_labels.py` |
| Aspect tolerances | `TechnicalQualityRules.cs` | `types/quality/quality-data.ts` | `scripts/generate_technical_ratios.py` |

Both generators keep their marker comments, write only the typed module, and fail `--check` when it is stale. After
regenerating, run `npm run client:build`. Only tests enforce freshness of these two, as on the baseline; `tag-data.mjs`
enforces status and compact quality in the build.

`scripts/build_poster_assets.py` derives the poster assets from the typed tables through `TABLE_SOURCE`:
`types/language/media-language.ts`, `types/quality/quality-data.ts`, `types/ratings/rating-data.ts` and `types/awards/awards-data.ts`. Its
`IN_REPO` table and the `inputs` of `Assets/PosterTags/manifest.json` keep naming the scripts that ship, which carry the
same tables and are emitted deterministically. `--check` still ignores those hashes, as it did for hand-written JS.

## Failure boundaries

A bad list member is not always something to skip. Where a legacy read stopped on one, the group draws nothing for that
card, and native posters mirror exactly where:

- Quality: a null stream, a null source the 3D scan reaches before a match, a null distinct fact an All mode reads, a
  label that is not text, and a null summary category. A later source after a 3D match is never read.
- Language: a null audio code, or a null stream or source on the item path, ends the group. A language named after an
  `Object.prototype` member draws no group while it would show, in Flags style. `resolveFlag` still refuses those names;
  `flagOf` in `types/language/languagetags.ts` carries the rule, because the outcome is the renderer's.
- Genre: a null genre ends the group, and still counts as the item having genres.

`members`, `memberRecord` and `memberText` in `pipeline/dto.ts` are for these reads. `records` and `stringList` are for lists whose
bad members really are ignored. The status media key keeps null members in, since it files stored verdicts.

## Verification

`tests/frontend/features/media-tags/features-tag-runtime-regressions.test.mjs`, `features-tag-runtime-consumers.test.mjs`,
`features-tag-runtime-lifecycle.test.mjs` and `features-tag-runtime-malformed.test.mjs` drive the emitted scripts;
`features-tag-runtime-generators.test.mjs` holds the source boundary above;
`tests/browser/tag-runtime-journey.spec.cjs` covers real IndexedDB and a library page across a user
switch. Commands, hashes, the seeded differential against the baseline and remaining limits are in
`artifacts/rewrite-tag-runtime/`. Combined gate, independent review and real-host validation
belong to the parent.
