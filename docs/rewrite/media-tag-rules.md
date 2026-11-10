# Media Tags rule slice

This slice replaces exactly six existing browser entry points: `core/media-language.js`,
`core/tag-layout.js`, `core/tag-look.js`, `tags/rating-sources.js`,
`tags/status-vocabulary.js`, and `tags/tag-poster-colours.js`. Their paths and public
`JellyfinEnhanced` bridges stay available to the remaining JavaScript consumers.
This is not the whole Media Tags rewrite.

## Source boundaries

The implementation is under `client/src/features/media-tags/` (`layout/` and `types/<type>/`):

- `layout/layout-rules.ts`: legacy promotion, position/profile inheritance, caps, scales,
  gaps, edge spacing, shape overrides and derived look settings, with explicit
  document inputs. `layout/layout-fitting.ts` owns DOM-free row budgets, chip fitting,
  compact quality labels and shape/size calculations.
- `layout/tag-layout.ts` and `layout/layout-runtime-types.ts`: the existing card presentation
  lifecycle over typed HTML elements, fitting queues, observers and per-card
  contexts. It calls the pure rules and retains one owner for layout caches,
  controllers, waits and event subscriptions.
- `layout/tag-look.ts`: validated rule/lock/item-look documents, matching, precedence
  inputs, wire projections and session-bound saves with rollback. Its host supplies
  settings, the official-rating normalizer, session capture and persistence.
- `types/language/media-language.ts`: curated ISO/flag registries, region/script parsing,
  canonical audio equivalences, priorities and secondary-audio rules, plus a
  presentation factory with injected translations, locale candidates and flag URLs.
- `types/ratings/rating-data.ts`, `types/ratings/rating-sources.ts`, `types/ratings/rating-view.ts`: source vocabulary,
  nullable personal preferences, native-unit scores, score colours and injected
  DOM chip rendering.
- `layout/poster-colour-rules.ts`: dominant histogram, contrast/palette arithmetic and
  artwork keys. `layout/poster-colours.ts` owns the asynchronous sampler, decode queues,
  watches, generation and scoped store writes.
- `types/status/status-vocabulary.ts`: the full shared status vocabulary.

The six `*-entry.ts` modules install these bridges once. `client/src/features/media-tags/rules-host.ts`
is the narrow host boundary. Services installed later in loader order are resolved
at call time: particularly `saveUserSettings`, tag looks, poster colours and CDN URLs.
Missing settings persistence returns failure and rolls back; it never reports a save.
Imports between bundles carry pure rules or type-only dependencies, not a second
layout controller, sampler or persistence queue.

## Compatibility and fixes

The unchanged focused tests cover legacy migration, null/default inheritance,
per-item and series locks, item overrides, all layout shapes, scales/gaps/edges,
source ratings, language display, status finale parity, panel save queues and
poster sampler identity changes. Existing C# semantics were read without changes:
`TagLayoutSettings.cs`, `TagLookSettings.cs`, `LanguageTagPrioritySettings.cs`,
`RatingSourceSettings.cs`, `TrackRoles.cs`, `ScoreNumbers.cs` and `PosterColour.cs`.

New emitted-JS regressions cover prototype-name language inputs, malformed artwork
escapes, invalid pixel/palette inputs, nonfinite lock timestamps and extreme/missing
rating values. Layout normalization now uses its explicitly supplied administrator
policy for logo caps instead of the live global policy. Shared native JSON fixtures
check localized score text, compact quality labels and the complete status table.
These checks do not execute the native renderer.

## Integration follow-ups

The parent owns the migration inventory, combined gate, independent review and
real Jellyfin 12 host/browser validation. No deployment or live install was done.

The shared status/compact JSON tables now project into TypeScript via
`scripts/tag-data.mjs`; the existing Python commands remain entry points.
`generate_status_vocabulary.py --table-only` updates the TS vocabulary without
regenerating the separately pinned ICU date/number tables; its default invocation
still regenerates/checks those tables too. `generate_quality_compact.py` updates
`types/quality/compact-quality.ts` and the native C# projection. Neither writes executable JS.
Run the client builder afterward to regenerate JS/maps. Build, freshness, typecheck
and the MSBuild guard reject stale data projections before bundling, including
native compact labels. Generator tests exercise isolated JSON changes, rejection,
regeneration and emitted behavior. The native C# table is byte-identical for the
existing source data.

Build and focused-test logs, source/output hashes and limitations are recorded in
`artifacts/tag-rules/`. Reproduce generated assets with `flock
/home/jake/projects/je-v12-client-build.lock npm run client:build`.
