# Seerr core TypeScript slice

This replaces the fifteen Seerr core entry implementations (status, request
manager alias, API, search integration, the `ui/ui-*.js` card/button/modal
group and the request modal shell) for Jellyfin 12.x. It is one slice of an
incomplete rewrite, not a release or whole-product parity certification.
Baseline: `2e0f9251bfe833cb58866e9e245ba62be69a69ad`.

## Ownership and integration

`client/entries/seerr-core.json` maps the original production paths, in the
unchanged `component-scripts.json` order, to `client/src/features/seerr/core/`:

| Output (`js/jellyseerr/…`) | Entry | Installs |
| --- | --- | --- |
| `seerr-status.js` | `status-entry.ts` | `JE.seerrStatus` |
| `request-manager.js` | `request-manager-entry.ts` | `JE.requestManager` alias of `JE.core.api.manager` |
| `api.js` | `api-entry.ts` | `JE.jellyseerrAPI` |
| `jellyseerr.js` | `search-entry.ts` | `JE.initializeJellyseerrScript` |
| `ui/ui-icons.js` … `ui/ui-season-modal.js` | `ui/*-entry.ts` | `JE.jellyseerrUI`, `JE.internals.jellyseerrUi` |
| `modal.js` | `modal-entry.ts` | `JE.jellyseerrModal` |

`client/src/features/seerr/host-core.ts` is the only access to the legacy global:
a structurally optional bridge (no assertions) naming each host API and
sibling facade the group reads. Facade types for other owners are exported
from `client/src/features/seerr/core/contract.ts`; status rules (`status.ts`),
decoders (`decode.ts`) and display rules (`display.ts`, `search-query.ts`,
`override-rules.ts`) are pure and importable. No component manifest, shared
contract, settings, locale, backend or other group was edited.

Each entry installs once per page (`internals.jellyseerrUi.installed`); a
re-evaluated bundle replaces nothing and adds no listeners. Siblings are
reached through the shared facades at call time, exactly as before, so tests,
themes and other owners can replace a member (`markCardRequested`,
`showMovieRequestModal`, `JE.jellyseerrModal`, API members) and the group calls
the replacement. Pure rules are bundled into each entry instead, so an entry no
longer throws when a sibling is not loaded.

## Preserved behavior

Every public member keeps its name, arguments, result and failure contract,
including `requestMedia`/`requestTvSeasons` (one non-retried POST, rejection
with the original error), quotas (chip, dialog, `isQuotaError`, the
`JellyseerrShowQuotaInfo` switch), override rules (language, genre, keywords
including Spoiler Guard's `jeRuleKeywords`, user lists, tags), season and whole
show requests (Specials excluded from whole-show requests, single-season mode,
Select All excluding Specials, TVDB match for #653 with the stored id), 4K split
buttons and popup, the collection batch (stops at the quota), status mapping
(enum values, display states, button/badge/chip/season configurations, stale
"available" demotion with the Jellyfin season map), user-status caching (sticky
success, 60 s negatives, banner once per reason), the batched watch-provider
lookups, lazy posters, deferred provider icons, delegated card events, the
search row (typing hold, collection insertion, infinite scroll, year filter,
Seerr-only filter, manual refresh, hidden-content and in-library filtering),
the modal's focus trap, Back/Escape/backdrop closing and the TV select picker,
CSS byte-for-byte, and all translation keys. The cached result object is still
updated in place by a movie request (item details depends on it).

## Boundaries and intentional corrections

All network values enter as `unknown`. Results are accepted by guards that check
every consumed field and return the same object (identity is preserved for
caches and in-place updates); malformed results are dropped, a malformed page is
a read failure (`throwOnError` callers see `SeerrDecodeError`), and malformed
status/quota/settings/servers/candidates/rules are rejected individually.
Details documents stay opaque to the facade and are decoded by the parts that
read them.

Writes capture their originating account and server when initiated. If the
identity changes before the POST is sent (override rules are still loading, a
modal opened by the previous account), nothing is sent
(`SeerrRequestNotSent`). An answer that arrives after a change is returned to
its caller but no request event, watchlist or usage side effect reaches the new
account, and buttons, modals and batches of the previous account change
nothing on screen. A definite rejection keeps the existing messages (quota
dialog, 404 user not found, 403 permission codes, the server's message). A
failure with an unknown outcome after sending (lost response, timeout, unreadable
2xx, or an unqualified proxy 5xx) is reported as "status unknown, check Seerr before requesting again" and
the control is restored for an explicit retry; nothing is retried
automatically. A bounded in-memory journal (`internals.jellyseerrUi.outcomes`,
50 entries) records acknowledged / rejected / uncertain / not-sent outcomes for
diagnostics; it is not replayed.

Only `serverId`, `profileId`, `rootFolder`, `languageProfileId`, numeric `tags`
and `is4k` from a caller's settings reach the request body; override rules still
apply only when the caller passed no settings at all, as before.

Fixed baseline defects are listed with reproduction evidence in
`artifacts/rewrite-seerr-core/REPORT.md` (SEERR-CORE-01 … -18). New user-facing
strings (`jellyseerr_request_outcome_unknown`,
`jellyseerr_toast_collection_uncertain_count`) are included in the English locale, with fallbacks for other locales.

## Review status

The guarded search refresh facade is installed (SEERR-CORE-19). Active request
seasons use the request enum and are combined with current library presence
(SEERR-CORE-21); normal and 4K library IDs remain separate. Modal Request/Back
closure restores only its own history entry and disposes the TV picker
(SEERR-CORE-22). The More Info icon integration (SEERR-CORE-20) is tracked by
the details owner and is not certified here.

The central bug ledger and independent review artifacts give the current
dispositions. Remaining backend/host validation is separate from these client fixes.

## Verification and gaps

Commands, logs, hashes, mutation results and baseline evidence are under
`artifacts/rewrite-seerr-core/`. Permanent coverage:
`tests/frontend/requests/seerr-core-boundaries.test.mjs` (24 cases; 23 fail on
the baseline scripts for the defect they name, all pass on the emitted scripts;
16/16 injected regressions are caught) and
`tests/browser/seerr-core-rewrite.spec.cjs` (Chromium journeys through the
emitted core client: single submission, lost-response outcome, account change
in flight, season modal with quota). Existing request, card, modal, spoiler,
details-row, core API and browser flow regressions pass unchanged.

No backend build, real Jellyfin/Seerr host, live install, deploy, commit, push or
PR was performed by this owner. Real Seerr payload variants, TV/mobile focus,
visual parity beyond the existing modal snapshot and multi-server journeys
remain parent integration work.


## Review remediation
Rendered controls retain the originating client, root, credential and session. A late quota dialog cannot present the previous account's result. Unknown write outcomes are distinct from a definite rejection, including a proxy failure after dispatch. Active request-season states are translated from the request enum before combining them with media state; disabled selections cannot be submitted. Search filters restore only their own native-result changes, and modal refreshes require the current mounted query. Modal close consumes the owned history entry without navigating a replacement host route.

The parent remediation report and its frozen scope record focused verification and limitations. Actual Seerr/Jellyfin host journeys and the backend write-outcome review remain separate gates.
