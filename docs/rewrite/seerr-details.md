# Seerr details

This slice replaces the thirteen `js/jellyseerr` scripts behind the more-info modal,
the detail-page rows and link, the issue reporter, the HSS handler and the scroll
engine with strict TypeScript. It does **not** complete the JE rewrite or certify
Jellyfin or Seerr host parity. The Seerr core (`api.js`, `ui/*`, `modal.js`,
`seerr-status.js`) is a separate slice: this one depends only on its public facades.

## Source, boundaries and ownership

`client/entries/seerr-details.json` maps the thirteen original resource paths to
`client/src/features/seerr/details/`. `component-scripts.json` and the load order are
unchanged, and generated JavaScript and maps come from the shared client builder.
`client/src/features/seerr/host-details.ts` is the only boundary with the JE global: it
names each facade member this slice uses and types every reply as `unknown`.

| Output | Entry |
| --- | --- |
| `moreinfo/more-info-modal-{styles,data,seasons,badges,render,actions-tv,actions,init}.js` | `moreinfo/{styles,data,seasons,badges,render,actions-tv,actions,init}-entry.ts` |
| `seerr-detail-link.js` | `seerr-detail-link-entry.ts` |
| `hss-discovery-handler.js` | `hss-discovery-entry.ts` |
| `item-details.js` | `details-page/item-details-entry.ts`, with `rows.ts` |
| `issue-reporter.js` | `issues/issue-reporter-entry.ts`, with `issue-model.ts`, `report-markup.ts` |
| `seamless-scroll.js` | `scroll/seamless-scroll-entry.ts`, with `seamless-scroll.ts` |

`domain/` holds pure logic with no browser state: narrowing (`json.ts`), calendar
dates (`dates.ts`), link safety (`links.ts`), title and season rules (`media.ts`,
`seasons.ts`). Each entry bundles its own copy of what it imports, so nothing with
state lives in a shared module: state crosses bundles only through
`JE.internals.moreInfoModal` and on the modal element.

## Compatibility kept on purpose

- `JE.jellyseerrMoreInfo` (`open`, `close`, `checkForUnrequestedSeasons`),
  `JE.jellyseerrIssueReporter` (all eight methods), `JE.seamlessScroll` (with a mutable
  `CONFIG` read on use and the `state` object's field names),
  `JE.initializeSeerrDetailLinkScript`, and the `JE.internals.moreInfoModal` registry
  with its 35 function names. Each more-info script still finds its siblings there at
  call time, so scripts can load one by one and tests can stub a sibling.
- `modal._isClosing`: Spoiler Guard's toggle reads it to refuse a modal on its way out.
- The events `jellyseerr-media-requested`, `jellyseerr-tv-requested` and
  `jellyseerr-more-info-closed`, the viewshow, popstate and session wiring, and every
  class name, data attribute, label and SVG. The stylesheet is byte-identical to the
  baseline.
- Source-specific reply shapes: Seerr's camelCase next to `iso_3166_1` and
  `release_dates`, TMDB's snake_case seasons, Jellyfin's PascalCase items, and the TV
  ratings endpoint, whose reply is the Rotten Tomatoes record itself (wrapped as `{rt}`).
- `null`, `''` and absent stay distinct where they did: a status of 0 or absent is
  requestable, a season number of 0 is Specials and has no media row.
- Links stay relative to what they were relative to: `#!/details?id=` hash routes keep
  any server base path, and the Seerr base keeps a sub-path (joined, never `new URL`).

## Lifetimes

Every modal owns a scope: an `AbortSignal` for its requests and teardown for what it
put outside itself (document listeners, the 4K menu on `body`). Closing disposes it
synchronously, at the start of the 300 ms exit animation, and a modal is live only
while it is current and not closing. Each `renderActions` is a child of that scope, so
a redraw cancels the previous render's lookups and closes its menu. Controls check the
render when clicked, so nothing still on screen during the exit can start a write.

A request's completion is checked twice: its account (the session epoch taken when the
request started) decides whether anything happens at all, and its modal decides whether
that modal is redrawn. `renderActions` draws into the modal it is given, never whichever
modal is current. An old account's response neither redraws nor announces; a closed
modal's response, for the same account, still announces so other surfaces update.

The report dialog closes on an account change and stops its lookups when closed.
`tryAddButton` joins an in-flight run for the same page and item and re-checks the page,
item and account after each await. The rows keep their existing deferral design
(`rows.ts`), and Request More now stops on an account change and skips a view Jellyfin
is still replacing. The scroll engine's teardown is idempotent and cancels a waiting retry.

## Intentional corrections

These change behaviour against the baseline. Each is covered by a test named for it
and recorded with a `SEERR-DETAILS-*` id in the slice's report.

- Every value from a reply is escaped wherever it lands, and reply URLs open only over
  http(s); a trailer without a usable URL is left out.
- The Rotten Tomatoes fact link appears when its page is known, after ratings arrive,
  instead of being a dead `href=""`; TV logos link to the show's own page.
- A movie Seerr calls available but the library lost can be requested, as a show could.
- More Info 4K movie requests go through override rules, like the card's 4K button.
- A movie requested through the advanced dialog updates the open modal.
- A refresh replaces the reply: fields Seerr no longer sends leave the title, except
  the ratings the client fetched itself. Season links are re-read on refresh, and a
  failed lookup is not remembered.
- Date-only values are calendar days in every time zone; an unreadable date is left
  out rather than shown as `NaN` or `Invalid Date`.
- Requester avatars use the relative proxy path the protected avatar loader expects.
- Request and failure icons come from the core library at `JE.jellyseerrUI.icons`, like
  the cards. More Info used to read `JE.jellyseerrUIIcons`, which nothing defines, so
  it always drew a Material `download` glyph and no failure icon. That glyph remains
  the fallback until the library has loaded.
- An unknown media type fails like a missing title, without asking Seerr; the HSS
  handler ignores a card whose id or type is not one, and it keeps working as a link.
- The TMDB fallback never returns a title of another kind, and issues of a new type
  show under Other. An Episode never reads its season as the series.
- The unavailable report button is marked `aria-disabled` and dimmed rather than
  `disabled`, because a disabled button fires no click, so its explanation never showed.

## Not changed

- Season request statuses and media statuses share one scale in
  `checkForUnrequestedSeasons`, so a declined season reads as in progress. Seerr's own
  semantics decide whether that should change; the logic is unchanged.
- A status chip shows the raw status: a stale Available still reads Available next to
  the Request button it now gets.
- `moreInfoModal.close()` from navigation or an account change leaves the history entry
  `open` pushed, and the same is true of the report dialog's `close` in `modal.js`.
- Labels that were hard-coded English stay so (`Seasons`, `Available`, the unavailable
  reasons); this slice adds no translation keys.

## Tests

`tests/frontend/pages/pages-seerr-details-{moreinfo,issue-reporter,links,request-more,scroll}.test.mjs`
run the emitted scripts over stubbed facades, with the real `seerr-status.js` and
`modal.js` where they matter; `tests/frontend/helpers/seerr-details.mjs` is their
shared fixture. `tests/browser/seerr-details-rewrite.spec.cjs` is a small journey in a
real browser: history, CSS, `IntersectionObserver`, keyboard. Existing regressions pass
unchanged. Real Jellyfin and Seerr hosts were not exercised by this slice.
