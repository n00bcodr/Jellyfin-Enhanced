import type { PlayerContext, TrackKind } from './context';
import { decodeItem, decodeSegments, decodeSessions, type MediaSegment, type Stream, type PlayingSession } from './wire';
import { normalizeItemId, parseItemIdFromVideosSrc } from './identity';
export function createTrackMenu(context: PlayerContext) {
 const { JE, ApiClient, lifetime, getVideo, getCurrentVideoItemId, tWithFallback } = context;
    // ── Native OSD track menus ───────────────────────────────────────────────
    //
    // Cycling subtitle/audio tracks drives Jellyfin's own action sheet. Doing that
    // safely needs four things the previous implementation got wrong:
    //
    //  * Wait for the sheet, don't guess. It was read 200ms after clicking the OSD
    //    button, with nothing verifying it had opened. The sheet is built inside a
    //    dynamic import() of components/actionSheet, so the delay was a bet on how
    //    fast that resolves. (In practice elements/emby-select statically imports
    //    actionSheet, so the chunk is usually already loaded — which is why this
    //    rarely misfires and is hard to reproduce — but a cold deep-link into
    //    /video, or a slow device, can still lose the race.)
    //
    //  * Scope every query to one sheet. dialogHelper only hides a dismissed sheet
    //    after a 100ms exit animation and removes it later still, so a document-wide
    //    '.actionSheetContent .listItem' query can read a stale sheet, or two at once.
    //
    //  * Close sheets the way dialogHelper expects. document.body.click() is a no-op
    //    here: the close listener is bound to .dialogContainer (a CHILD of body, so a
    //    body-dispatched event never reaches it), it requires e.target to BE that
    //    container, and it also requires a preceding mousedown — HTMLElement.click()
    //    dispatches only a click.
    //
    //  * Never compare against English UI strings. Sheet titles are localized
    //    ('Untertitel', 'Sous-titres', 字幕). The OSD button's own title attribute
    //    resolves the *same* translation key, so it is a locale-proof reference. The
    //    'Secondary Subtitles' row is localized too, which is why rows are now
    //    identified by their numeric data-id (the stream index) instead of by text —
    //    otherwise a localized UI can land the cycle on the secondary-subtitle row
    //    and open that submenu instead of changing the track.

    /** In-flight menu open, so repeated presses cannot stack sheets. @type {Promise|null} */
    let pendingMenuOpen: Promise<void> | null = null;

    // dialogHelper keeps a dismissed sheet in the DOM — and visually rendered — for the length
    // of its exit animation, so isRendered() alone cannot tell a live sheet from a dying one.
    // Clicking a track row closes the sheet, so a quick second press could otherwise reuse the
    // closing sheet: read its stale check marks, click a settled dialog to no effect, and toast
    // a track that was never applied. dialogHelper announces the close by dispatching a
    // non-bubbling 'closing' event on the dialog the moment closing starts; non-bubbling events
    // still run the capture phase, so a document-level capture listener sees it.
    // Timestamped rather than a plain set: if the exit animationend never fires (backgrounded
    // tab, interrupted animation) the sheet stays rendered, and a permanent mark would exempt
    // it from closeActionSheet's leftover cleanup forever. After the grace window — far longer
    // than any exit animation — a still-rendered sheet is treated as a stuck leftover again.
    const sheetClosingAt = new WeakMap<Element, number>();
    const SHEET_CLOSING_GRACE_MS = 1000;
    document.addEventListener('closing', (e) => {
        const t = e.target;
        if (t instanceof Element && t.classList.contains('actionSheet')) {
            sheetClosingAt.set(t, performance.now());
        }
    }, true);

    /** @param {Element} sheet */
    function isClosing(sheet: Element) {
        const at = sheetClosingAt.get(sheet);
        return at !== undefined && (performance.now() - at) < SHEET_CLOSING_GRACE_MS;
    }

    // Jellyfin applies a track selection only when the sheet's close animation finishes
    // (actionSheet resolves on the dialog 'close' event, not on the row click), so for a
    // beat after a cycle the player still reports the OLD track and a freshly opened sheet
    // still check-marks it. Remembering what was just clicked lets the next press continue
    // the cycle from there instead of re-selecting the same track. The window is short —
    // a few times the exit animation, just long enough for the selection to land — because
    // past that the check mark is authoritative again and an out-of-band change (a mouse
    // click in the native menu, the SubtitleMenu shortcut) would make the memory stale.
    const lastCycled: Record<TrackKind, { id: string | null; at: number; item: string | null } | null> = { subtitle: null, audio: null };

    /** @param {'subtitle'|'audio'} kind @returns {string|null} data-id or null */
    function recentlyCycledId(kind: TrackKind) {
        const rec = lastCycled[kind];
        return rec
            && (performance.now() - rec.at) < 500
            && rec.item === getCurrentVideoItemId() // stream indices repeat across items
            ? rec.id : null;
    }

    /**
     * Clicks an element the way the video OSD expects. On Firefox/Edge the OSD installs a
     * document capture-phase guard that cancels any click whose target does not contain its
     * `clickedElement`, which a bare programmatic .click() after a keypress fails. Sending
     * pointerdown first makes the element the clickedElement. JE.skipIntroOutro above already
     * uses this pattern for the same reason.
     * @param {HTMLElement} el
     */
    function activate(el: HTMLElement) {
        if (typeof PointerEvent === 'function') {
            el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        }
        el.click();
    }

    /**
     * The localized title of an OSD button — the same translation key the matching
     * action sheet renders as its title. Deliberately title-only: an aria-label
     * fallback sounds safer but is worse, because a label WORDED differently from
     * the sheet title would make the match never succeed (3s timeout, false "not
     * found" toast), while an empty string only degrades the guards gracefully.
     * @param {string} selector
     * @returns {string}
     */
    function osdButtonTitle(selector: string) {
        const btn = document.querySelector<HTMLElement>(selector);
        return ((btn && btn.getAttribute('title')) || '').trim();
    }

    /**
     * @param {Element|null} el
     * @returns {boolean} True when the element is actually rendered (not a dismissed sheet).
     */
    function isRendered(el: HTMLElement | null) {
        if (!el) return false;
        const h = /** @type {HTMLElement} */ (el);
        // Not offsetParent: actionSheet sets position:fixed on the sheet, so offsetParent is
        // null unless .dialogContainer happens to carry `contain: strict`. Depending on that
        // CSS would silently disable both the reuse fast path and closing if it ever changed.
        return !!(h.offsetWidth || h.offsetHeight || h.getClientRects().length);
    }

    /**
     * Finds a rendered action sheet whose title matches `title`.
     * @param {string} title
     * @returns {Element|null} The sheet's .dialogContainer, or null.
     */
    function findOpenSheetByTitle(title: string) {
        if (!title) return null;
        // Permanent exclusion here, unlike closeActionSheet's timed one: a sheet that ever
        // began closing has stale check marks and must never be REUSED, even if its exit
        // animation stalls past the grace window — it just becomes cleanable again.
        const sheet = Array.from(document.querySelectorAll<HTMLElement>('.actionSheet')).find(s =>
            isRendered(s) && !sheetClosingAt.has(s) &&
            Array.from(s.querySelectorAll<HTMLElement>('.actionSheetTitle'))
                .some(t => (t.textContent || '').trim() === title)
        );
        return sheet ? (sheet.closest('.dialogContainer') || sheet) : null;
    }

    /**
     * Closes the open native action sheet by replaying the outside tap dialogHelper
     * listens for: mousedown then click, dispatched ON the dialog container so both
     * `e.target === dialogContainer` and `e.target == clickedElement` hold.
     * @param {Element} [target] - A specific .dialogContainer to close; defaults to the
     *   first rendered sheet that is not already closing.
     * @returns {boolean} True when a close was attempted.
     */
    function closeActionSheet(target?: Element | null) {
        let container = target || null;
        if (!container) {
            const sheet = Array.from(document.querySelectorAll<HTMLElement>('.actionSheet'))
                .find(s => isRendered(s) && !isClosing(s));
            container = sheet ? sheet.closest('.dialogContainer') : null;
        }
        if (!container) return false;
        // pointerdown FIRST. On Firefox/Edge the video OSD installs a document capture-phase
        // click guard that cancels any click whose target does not contain its `clickedElement`
        // (video/index.js onClickCapture). That variable is refreshed by keydown and by
        // pointerdown — not by mousedown — so a bare mousedown+click is still swallowed and the
        // sheet never closes. Dispatching pointerdown on the container makes it the
        // clickedElement, after which dialogHelper's own mousedown+click guards both pass.
        if (typeof PointerEvent === 'function') {
            container.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
        }
        ['mousedown', 'click'].forEach(type => {
            container?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        });
        return true;
    }

    /**
     * Clicks an OSD button and resolves with the dialog container of the sheet it opened —
     * waiting for the sheet to exist rather than assuming a delay.
     * @param {string} buttonSelector
     * @returns {Promise<Element|null>} The new sheet's container, or null if none appeared.
     */
    function openOsdMenu(buttonSelector: string, expectedTitle: string, timeout = 3000) {
        const before = new Set<Element>(document.querySelectorAll<HTMLElement>('.dialogContainer'));
        const btn = /** @type {HTMLElement|null} */ (document.querySelector<HTMLElement>(buttonSelector));
        if (!btn) return Promise.resolve(null);
        activate(btn);
        // Accept only a container that did not exist before the click — a dismissed sheet would
        // otherwise satisfy the selector immediately. Match on .actionSheetContent rather than a
        // row: actionSheet sets innerHTML before dialogHelper appends the container, so content
        // is never half-rendered, and a genuinely EMPTY menu (a video with no audio streams)
        // must resolve immediately instead of stalling until the timeout. Also require the title
        // to be the menu we asked for, so a sheet opened concurrently elsewhere is not adopted.
        return JE.core.dom.waitForElement('.dialogContainer', {
            timeout,
            quiet: true,
            signal: lifetime.lease().signal,
            predicate: (el) => {
                if (before.has(el) || !el.querySelector<HTMLElement>('.actionSheetContent')) return false;
                if (!expectedTitle) return true;
                const t = el.querySelector<HTMLElement>('.actionSheetTitle');
                return !!t && (t.textContent || '').trim() === expectedTitle;
            }
        });
    }

    /**
     * Advances to the next track within one already-resolved sheet.
     * @param {Element} container - The sheet's .dialogContainer; all queries are scoped to it.
     * @param {string} emptyToastKey
     * @param {string} toastVar - 'subtitle' | 'audio'
     */
    function cycleWithinSheet(container: Element, emptyToastKey: string, toastVar: TrackKind) {
        // Real track rows carry a numeric data-id (the stream index; -1 is "Off").
        // Non-track rows such as "Secondary Subtitles" do not, so this needs no text match.
        const options = Array.from(container.querySelectorAll<HTMLElement>('.actionSheetMenuItem'))
            .filter(item => /^-?\d+$/.test(item.getAttribute('data-id') || ''));

        // 'Off' (data-id -1) alone is not a cycle: a subtitle menu for an item with no
        // subtitle streams still renders the Off row, and toggling Off→Off with a toast
        // naming "Off" would masquerade as a track change.
        if (!options.some(item => item.getAttribute('data-id') !== '-1')) {
            JE.toast(JE.t(emptyToastKey));
            closeActionSheet(container);
            return;
        }

        // Prefer the row we cycled to moments ago over the check mark: the selection is
        // applied on sheet close, so right after a cycle the check mark still sits on the
        // previous track and trusting it would re-select the same track.
        const recentId = recentlyCycledId(/** @type {'subtitle'|'audio'} */ (toastVar));
        let currentIndex = recentId !== null
            ? options.findIndex(option => option.getAttribute('data-id') === recentId)
            : -1;
        if (currentIndex === -1) {
            currentIndex = options.findIndex(option => {
                const check = option.querySelector<HTMLElement>('.listItemIcon.check');
                return check && getComputedStyle(check).visibility !== 'hidden';
            });
        }

        const next = options[(currentIndex + 1) % options.length];
        if (!next) return;
        activate(/** @type {HTMLElement} */ (next));
        // Recorded after activate(): if the click throws or is swallowed, an unset record
        // (falling back to the check mark) is the safe direction, not a poisoned one.
        lastCycled[toastVar] = {
            id: next.getAttribute('data-id'),
            at: performance.now(),
            item: getCurrentVideoItemId()
        };
        const labelEl = next.querySelector<HTMLElement>('.listItemBodyText');
        JE.toast(JE.t('toast_' + toastVar, { [toastVar]: JE.escapeHtml(((labelEl && labelEl.textContent) || '').trim()) }));
    }

    /**
     * Opens (or reuses) an OSD track menu and advances to the next track.
     * @param {string} buttonSelector - The OSD button that opens the menu.
     * @param {string} emptyToastKey - Toast key for "this menu has no tracks".
     * @param {string} toastVar - 'subtitle' | 'audio'
     */
    function cycleTrackMenu(buttonSelector: string, emptyToastKey: string, toastVar: TrackKind) {
        const lease = lifetime.lease(getVideo());
        const title = osdButtonTitle(buttonSelector);
        const alreadyOpen = findOpenSheetByTitle(title);
        if (alreadyOpen) {
            cycleWithinSheet(alreadyOpen, emptyToastKey, toastVar);
            return;
        }
        // One open at a time. Without this, a second press before the sheet exists snapshots a
        // stale `before` set, clicks the button again and leaves an orphan sheet on screen.
        if (pendingMenuOpen) return;
        // A different sheet may be open (audio while cycling subtitles, or a leftover).
        // Close it first so we never stack two sheets and then read rows from both.
        closeActionSheet();
        const pending = openOsdMenu(buttonSelector, title)
            .then(container => {
                if (!lease.current()) return;
                if (!container) {
                    if (!document.querySelector<HTMLElement>(buttonSelector)) {
                        console.warn(`🪼 Jellyfin Enhanced: ${buttonSelector} is not present; cannot cycle tracks.`);
                    } else {
                        console.warn(`🪼 Jellyfin Enhanced: ${buttonSelector} menu did not open in time.`);
                    }
                    // Only touch the UI if we are still on the player — the await window is up to
                    // 3s, in which the user may have navigated away and opened an unrelated sheet.
                    if (typeof JE.isVideoPage !== 'function' || JE.isVideoPage()) {
                        JE.toast(JE.t(emptyToastKey));
                    }
                    return;
                }
                cycleWithinSheet(container, emptyToastKey, toastVar);
            })
            .catch(err => {
                console.warn('🪼 Jellyfin Enhanced: track cycling failed:', err);
            })
            .finally(() => { if (pendingMenuOpen === pending) pendingMenuOpen = null; });
        pendingMenuOpen = pending;
    }


lifetime.onReset(() => { lastCycled.subtitle = lastCycled.audio = null; pendingMenuOpen = null; });
return { cycleTrackMenu, openOsdMenu, activate, closeActionSheet };
}
export type TrackMenu = ReturnType<typeof createTrackMenu>;
