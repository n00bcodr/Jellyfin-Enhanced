# Details-page providers TypeScript replacement

The thirteen production scripts of the `details-providers` group now compile from
`client/entries/details-providers.json`. Output paths, the loader order in
`js/component-scripts.json`, the public `JE` facades and the translation keys are
unchanged; the builder bundles each entry with its imports into the existing
classic-script IIFE.

| Production script | TypeScript entry |
| --- | --- |
| `js/enhanced/features-random-button.js` | `random-button.ts` |
| `js/enhanced/itemdetails/features-details-media-info.js` | `media-info.ts` |
| `js/enhanced/itemdetails/features-release-dates.js` | `release-dates.ts` |
| `js/enhanced/itemdetails/features-details-page.js` | `details-page.ts` |
| `js/elsewhere/elsewhere.js` | `elsewhere.ts` |
| `js/elsewhere/reviews.js` | `reviews.ts` |
| `js/awards/awards.js` | `awards.ts` |
| `js/others/mdblist-ratings.js` | `mdblist-ratings.ts` |
| `js/others/doesthedogdie.js` | `doesthedogdie.ts` |
| `js/arr/arr-links.js` | `arr-links.ts` |
| `js/arr/arr-tag-links.js` | `arr-tag-links.ts` |
| `js/extras/colored-ratings.js` | `colored-ratings.ts` |
| `js/others/letterboxd-links.js` | `letterboxd-links.ts` |

All entries live in `client/src/features/details-providers/`.

## Boundaries

`client/src/features/details-providers/host.ts` declares one finite facade slice per
entry (`RandomBridge`, `ReviewsBridge`, …); configuration fields are typed from the
generated bootstrap contract (`BootstrapPublicConfig`, `BootstrapPrivateConfig`,
`ElsewhereSettings`). There is no shared global bag. Every Jellyfin call reads the
active `window.ApiClient` at call time, and facade members (`core.api.plugin`,
`helpers.*`, `saveUserSettings`) are read when used, so a later-loaded helper or a
replaced client is honoured.

`wire.ts` projects every untrusted Jellyfin, plugin and upstream (TMDB, AniList,
MDBList, Wikidata, DoesTheDogDie, *arr) response. The projections are lenient where
the legacy optional reads were (a wrong-typed field is absent), but values reaching
markup, URLs or arithmetic are typed: ratings and scores must be finite numbers,
provider ids are strings (numbers accepted), and items keep their media-source
positions for version counting. The awards, MDBList and DoesTheDogDie response DTOs
are not in the generated contract yet, so their decoders are local.

Pure logic is separate and browser-global free where useful: `media-info-domain.ts`
(sizes, times, progress modes), `release-domain.ts` (TMDB release/air-date choice),
`elsewhere-domain.ts` (provider filters, season grouping, region/provider lists),
`review-domain.ts` (markdown/HTML conversion, translation prose and re-linking, star
markup, response projections), `provider-domain.ts` (TMDB target resolution, awards,
MDBList links/badges, DoesTheDogDie views), `arr-domain.ts` (URL mappings, status,
link/dropdown models, tag filtering), `rating-domain.ts`, `random-domain.ts`.
`page.ts` holds the details-page visit lease and `links.ts` the sanitized external
link fallback and tag-route navigation.

## Lifecycle and identity

A details result is applied only through a `DetailsLease`: the route still names the
same item, the same page element is the visible detail page, and the captured client,
server root, token, session epoch and signed-in user remain current. Reviews (including the refresh after a write
or delete), Awards, MDBList and DoesTheDogDie use it; Arr links, Arr tag links and
Letterboxd check the equivalent conditions. Elsewhere, DoesTheDogDie, Letterboxd and
Arr tag links reset their per-account state on `session.onUserChange`. Release-chip failures only enter the negative cache when they still belong to the
current session and spoiler-policy revision. A null or malformed details lookup
stops until a later lifecycle trigger instead of immediately retrying itself.

Elsewhere forms require a fresh validated settings read before exposing Save.
Incoming settings invalidate the form and rebuild existing provider panels; stale
callbacks cannot adopt old preferences. Elsewhere and DoesTheDogDie retain a draft
and show retry feedback after a rejected POST, committing local preferences only
after acknowledgement. Unknown Elsewhere fields survive edits.

Already-rendered reviews and their average-rating chip belong to their originating
page and account. Reused views re-evaluate spoiler policy. Review actions recheck
the owner after confirmation and before mutation; late completion cannot refresh
another account's view. Markdown protects links and code spans before emphasis,
so underscores remain part of URLs.

## Behaviour retained

Random button scopes (current playlist/collection, pinned source, unwatched, library
fallback toasts, dice animation and re-enable); watch progress percentage/time/
remaining toggle persisted to `settings.json`; file size per media source; audio
languages through `/tag-data` with native fallback, flags and tag links; release
chips with prefetch take-over, limiter abort and spoiler-guard invalidation; hide
button with episode/show choice; Spoiler Guard button gate; people-tag prefetch;
Elsewhere default/multi-region lookups, provider allow/ignore filters, custom
branding, per-season providers and season-page fallback; TMDB, AniList and user
reviews with Spoiler Guard fail-closed suppression, user-opt-out, write/edit/delete,
admin moderation (server-enforced), average-rating chip, read more, browser and
LibreTranslate translation with re-linking and rate-limit messages, persisted
expand state and the user-review tag-cache invalidation; awards banner (title and
person modes); MDBList badges, links, order, Fresh/Rotten splats and percent symbol;
DoesTheDogDie warnings, trigger picker and `ddd-triggers.json`; admin-only *arr links
(single/multi-instance, status, URL mappings, Bazarr, corrupt-config and instance
error toasts, dropdown closer, observer retirement and re-initialisation on
`je:user-data-loaded`); *arr tag links; colored ratings with `normalizeOfficialRating`
shared with poster badges and the tag-look editor, and the pause-screen
`pauseRatingsPolling`/`resumeRatingsPolling` hooks; Letterboxd movie/person links and
the shared-runtime R2 transient-null retry.

## Fixed defects

Fourteen original owner candidates are independently verified at the R1 hashes.
The R1 reviews left DETAILS-PROVIDERS-003 and -007 partially resolved and confirmed
-017/-018 plus DPB-001/002/005. Their remediation is implemented with focused
before/after checks and awaits paired R2 review. DPB-004 remains an explicit
mounted-provider-panel subcase of -003. The parent additionally reproduced and
fixed REVIEW-DP-R2-01: a pending review-delete confirmation could issue a mutation
after the account or item changed. That case also awaits independent review.

See docs/rewrite/bug-ledger.json for current adjudicated counts, the original
artifacts/rewrite-details-providers/bugs.json for historical owner claims, and
artifacts/reviews/parent-remediation/details-providers-r1/report.md for the current
remediation, controls and limits.

## Validation and remaining checks

```
node --test tests/frontend/features/details-providers/features-details-providers-rewrite.test.mjs \
  tests/frontend/features/details-providers/features-random.test.mjs tests/frontend/features/details-providers/features-media-info.test.mjs \
  tests/frontend/features/details-providers/features-release-dates.test.mjs tests/frontend/features/details-providers/features-details-prefetch.test.mjs \
  tests/frontend/pages/pages-reviews.test.mjs tests/frontend/pages/pages-awards.test.mjs \
  tests/frontend/core/core-letterboxd.test.mjs tests/frontend/core/core-shared-boundaries.test.mjs \
  tests/frontend/features/spoiler-guard/features-seerr-spoiler-guard.test.mjs tests/frontend/bootstrap/bootstrap-manifest.test.mjs
npx playwright test --config tests/browser/playwright.config.cjs tests/browser/details-providers-rewrite.spec.cjs
```

These run against the production emitted scripts. The browser journey uses an
intercepted local fixture in Chromium, mobile Chromium and Firefox and opens no
Jellyfin connection. `colored-ratings.js` still loads in the poster-parity sandbox's
minimal VM, and its `normalizeOfficialRating` matched the legacy script on 2,342
inputs; the full .NET parity run was not executed here.

Parent integration still owns the combined gate, the migration inventory refresh,
real Jellyfin 12 hosts (Modern and Legacy layouts, TV/native clients), real
TMDB/MDBList/Wikidata/DoesTheDogDie/LibreTranslate/*arr services, real account
switches and visual review of the detail sections. Server-side DTOs for awards,
MDBList and DoesTheDogDie should join the generated contract so their local
decoders can be replaced by generated validation.


The R2 client remediation also retires release chips and queued frames on identity changes, rejects an entire malformed trigger preference array, removes retained review text when metadata is unknown, and preserves the selected country when an optional catalog is delayed or incomplete. Detached review toggles cannot change another account's setting. Strict Elsewhere storage readiness and unknown-field preservation are tracked as backend work; client validation alone does not certify those boundaries.
