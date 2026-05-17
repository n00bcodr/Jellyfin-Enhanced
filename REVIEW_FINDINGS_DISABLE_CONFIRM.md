# Disable-Confirm Dialog — Review Findings (Round 1)

## Context / environment
- Working dir: `/home/jake/Documents/Jellyfin-Enhanced/features/spoiler-blur-images`
- Branch: `features/spoiler-blur-images`
- Diff scope vs branch HEAD: `+114 / -0` across `spoiler-blur.js`, `more-info-modal.js`, and 25 locale files.
- Deploy target: `jellyfin-dev:8097`
- E2E test: `/tmp/je-e2e-test/test-spoiler-disable-confirm.js` (6/6 passing on initial run)

## Change summary
Adds Jellyfin-native confirm dialog when the user disables spoiler mode (series/movie/collection from the detail-page toggle, and Seerr pending entries via more-info-modal). Dialog includes a "Don't ask again for 15 minutes" checkbox; opt-in persists in `localStorage` keyed by Jellyfin user id.

## Reviewers run (Round 1, parallel)
- `pr-review-toolkit:code-reviewer` (Claude) — completed
- `pr-review-toolkit:silent-failure-hunter` (Claude) — completed
- `codex exec` (GPT-5.5, high effort) — pending

## Findings (Round 1)

### CRITICAL — merge blockers

| ID | Status | File:line | Summary | Source |
|---|---|---|---|---|
| **C1** | fix-pending | `spoiler-blur.js:705-719` | `setInterval` polling for the snooze checkbox + `change` listener races the OK click. If the user ticks the box and clicks OK before the 50 ms poller attaches the listener, `snoozeChecked` stays `false` and the snooze is silently lost. E2E test passed only because it inserts a 200 ms `waitForTimeout`. | code-reviewer C1, silent-failure C3 |

### HIGH

| ID | Status | File:line | Summary | Source |
|---|---|---|---|---|
| **H1** | fix-pending | `spoiler-blur.js:735` | `onToggleClicked` no longer disables the button before the async confirm round-trip; the original did. User can double-click the toggle and open two stacked confirm dialogs both resolving `proceed=true`, producing duplicate `performToggle` calls with stale `willBeEnabled`. | code-reviewer H2 |
| **H2** | fix-pending | `spoiler-blur.js:643-649` | `snoozeStorageKey()` returns `je-spoiler-disable-snooze:` (empty UID) during early page load / login transition / if `ApiClient` throws. Two users hitting that window share one snooze bucket — User B inherits User A's suppression. | code-reviewer H3, silent-failure C2 |
| **H3** | fix-pending | `more-info-modal.js:1803-1806` | If `confirmDisableSpoiler` is `undefined` (older `spoilerBlur` build), the `typeof === 'function'` skips the prompt entirely and disables silently. Worst fail-open for a confirmation gate. | silent-failure H6 |

### MEDIUM

| ID | Status | File:line | Summary | Source |
|---|---|---|---|---|
| **M1** | fix-pending | `spoiler-blur.js:654` | `parseInt` tolerates partial garbage (`'123abc'` → `123`) and accepts `Infinity`. Use `Number.isFinite` + a sanity range check. | silent-failure M8 |
| **M2** | fix-pending | `spoiler-blur.js:680-684` | Body/snooze-label strings are translator-sourced (Weblate). Concatenated into an HTML body via `Dashboard.confirm`. DOMPurify catches XSS, but stray `</div>` from a translator would break dialog layout. Escape via `JE.escapeHtml` before interpolation. | code-reviewer M5 |
| **M3** | defer | `spoiler-blur.js:679-684` | DOMPurify allowlist could theoretically strip `<input type="checkbox">` in a future Jellyfin update. Speculative; no current breakage. | code-reviewer M4 |

### LOW

| ID | Status | File:line | Summary |
|---|---|---|---|
| **L1** | resolved-by-C1-fix | `spoiler-blur.js:705-719` | Polling continues for 2.5 s even after the confirm callback resolves. Moot once polling is removed by the C1 fix. |
| **L2** | defer | `spoiler-blur.js:647` | Snooze key has no schema version; future format change would silently misinterpret old values. Speculative. |

### Out of scope
- Promise rejection path (silent-failure C1) — Dashboard.confirm always resolves via its internal `dialogHelper` promise in current Jellyfin; adding a timeout is over-engineering.

## Round 1 fix plan
1. **C1**: replace polling+change-listener with a capture-phase delegated change handler scoped via the marker class, AND read `cb.checked` defensively from the DOM inside the Dashboard.confirm callback. Belt-and-suspenders.
2. **H1**: set `button.disabled = true` on entry to `onToggleClicked`; clear in a `finally`-style chain spanning both the confirm + performToggle path.
3. **H2**: when `uid` is empty, `isDisableSnoozed` returns `false` AND `setDisableSnooze` is a no-op (fail-closed for snooze). Log once when this happens.
4. **H3**: `more-info-modal.js` — when `confirmDisableSpoiler` is missing, log `console.warn` so the silent skip is at least observable.
5. **M1**: replace `parseInt(...)` with `Number(...)` + `Number.isFinite` + range guard (`< Date.now() + 24h`).
6. **M2**: escape the i18n body + snooze label through `JE.escapeHtml` before interpolating into the HTML string.
