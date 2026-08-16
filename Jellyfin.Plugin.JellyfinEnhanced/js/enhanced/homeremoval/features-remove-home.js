/**
 * @file Remove from Continue Watching / Next Up: surface detection, the server
 * POST + optimistic hide, and the per-item action-sheet Remove button.
 * Split from features.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.features = JE.internals.features || {};

    /**
     * Shows notifications using Jellyfin's built-in notification system.
     * @param {string} message The message to display.
     * @param {string} [type='info'] The type of notification ('info', 'error', 'success').
     */
    const showNotification = (message, type = 'info') => {
        try {
            if (window.Dashboard?.alert) {
                window.Dashboard.alert(message);
            } else if (window.Emby?.Notifications) {
                window.Emby.Notifications.show({ title: message, type: type, timeout: 3000 });
            } else {
                console.log(`🪼 Jellyfin Enhanced: Notification (${type}): ${message}`);
            }
        } catch (e) {
            console.error("🪼 Jellyfin Enhanced: Failed to show notification", e);
        }
    };

    // The two home-screen surfaces the Remove feature can act on. Each maps to a server
    // hide endpoint, the action-sheet label, and the HideScope persisted in hidden-content.json.
    const REMOVE_SURFACES = {
        continuewatching: { path: 'continue-watching', labelKey: 'remove_from_continue_watching', nameKey: 'remove_surface_continue_watching', successKey: 'remove_continue_watching_success' },
        nextup: { path: 'next-up', labelKey: 'remove_from_next_up', nameKey: 'remove_surface_next_up', successKey: 'remove_next_up_success' }
    };

    /**
     * Builds a menu item that matches the native action-sheet items in the given sheet. It
     * copies a sibling item's class list (so font size, borders and focus scaling match the
     * current sheet and device — Jellyfin adds `actionsheet-xlargeFont` on mobile, etc.) and
     * uses Jellyfin's own item structure: a class-based Material icon on an empty span plus
     * `listItemBody`/`actionSheetItemText`. It is parsed via innerHTML so the `is="emby-button"`
     * custom element upgrades (ripple) exactly like a native item.
     * @param {HTMLElement} scroller The `.actionSheetScroller` the item will live in.
     * @param {{dataId: string, icon: string, text: string}} opts
     * @returns {HTMLElement}
     */
    function buildNativeActionSheetItem(scroller, opts) {
        const ref = scroller.querySelector('.actionSheetMenuItem');
        // Mirror a real item's classes (minus any transient selection state) so sizing is identical.
        const itemClass = (ref ? ref.getAttribute('class') : 'listItem listItem-button actionSheetMenuItem')
            .replace(/\bselected\b/g, '').replace(/\s+/g, ' ').trim();
        const tmp = document.createElement('div');
        tmp.innerHTML =
            `<button is="emby-button" type="button" class="${itemClass}" data-id="${opts.dataId}">`
            + `<span class="actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons ${opts.icon}" aria-hidden="true"></span>`
            + `<div class="listItemBody actionsheetListItemBody"><div class="listItemBodyText actionSheetItemText"></div></div>`
            + `</button>`;
        const button = tmp.firstElementChild;
        // textContent (never innerHTML) for the label — matches native escapeHtml and is injection-safe.
        button.querySelector('.actionSheetItemText').textContent = opts.text;
        return button;
    }

    /** Swaps a native action-sheet item's Material icon (class-based, like Jellyfin's own items). */
    function setActionSheetItemIcon(button, iconName) {
        const span = button.querySelector('.actionsheetMenuItemIcon');
        if (span) {
            span.className = `actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons ${iconName}`;
        }
    }

    /**
     * Keeps the Remove item one line and on-screen. Our "Remove from …" label is wider than the
     * sheet's native items, but Jellyfin sized + positioned the sheet (a `position:fixed` dialog
     * with an inline `left`) for its content BEFORE we added our item, so the now-wider sheet can
     * spill past the right edge. We re-run Jellyfin's own overflow correction: if the sheet still
     * fits the viewport, nudge it left so the whole one-line label shows; only if the label is
     * wider than the entire screen do we wrap it. Reads offsetWidth / inline left (both unaffected
     * by the open animation's transform). Call AFTER inserting the item.
     * @param {HTMLElement} button The already-inserted item.
     * @param {HTMLElement} scroller The action-sheet scroller.
     */
    function fitRemoveItemToMenu(button, scroller) {
        try {
            const dlg = scroller.closest('.dialog, .actionSheet');
            const viewportW = document.documentElement.clientWidth || window.innerWidth || 0;
            if (!dlg || !viewportW) return;

            const left = parseFloat(dlg.style.left);
            // Only positioned (corner-anchored) sheets have an inline left; centered / full-width
            // sheets need no help — a long label just wraps within their width.
            if (!Number.isFinite(left)) return;

            const width = dlg.offsetWidth;
            if (width <= viewportW - 20) {
                // Fits on screen at one line — shift it left if it currently spills past the edge.
                if (left + width > viewportW - 10) {
                    dlg.style.left = Math.max(10, viewportW - width - 10) + 'px';
                }
            } else {
                // Too wide for the screen even pinned to the edge → wrap the label to fit.
                dlg.style.left = '10px';
                button.style.maxWidth = (viewportW - 24) + 'px';
                const text = button.querySelector('.actionSheetItemText');
                if (text) text.style.whiteSpace = 'normal';
            }
        } catch (e) { /* leave native sizing */ }
    }

    // How long a captured menu context stays valid. The action-sheet observer fires within
    // ~150ms of a menu opening; this bounds how stale a context can be before we ignore it.
    const REMOVE_CONTEXT_TTL_MS = 5000;

    // Section-level surface verdict, cached per section element so a full-page card scan does
    // not re-query the same row's title/link once per card. Keyed weakly, so a re-rendered
    // section is re-evaluated rather than keeping a stale entry alive. Replaced wholesale when the
    // home-section configuration arrives, since verdicts reached without it may have been guesses.
    let sectionSurfaceCache = new WeakMap();

    // Home Screen Sections stamps its section id onto the row element as a class, which is a
    // locale-independent identifier for the rows JE cares about. 'both' means the row renders
    // resume items and next-up items together, so only the card itself can say which it is.
    const HSS_ROW_CLASS_SURFACE = {
        continuewatching: 'continuewatching',
        nextup: 'nextup',
        continuewatchingnextup: 'both',
    };

    // jellyfin-web builds the home screen by reading the user's own `homesection{N}` preferences and
    // rendering one `sectionN` slot per entry, so that config states outright what each row is. Mirrors
    // homesections.js: the same defaults, the same 'folders' alias, and the same TV-layout behaviour of
    // prepending a library row (which shifts every index) when none is configured.
    const HOME_SECTION_DEFAULTS = Object.freeze([
        'smalllibrarytiles', 'resume', 'resumeaudio', 'resumebook',
        'livetv', 'nextup', 'latestmedia', 'none',
    ]);
    const HOME_SECTION_SLOTS = 10;
    // Video, audio and book resume rows are all "continue" rows and all carry playback positions.
    const RESUME_SECTION_TYPES = new Set(['resume', 'resumeaudio', 'resumebook']);

    /** CustomPrefs of the current user's `usersettings` display preferences, or null until fetched. */
    let homeSectionPrefs = null;
    /** User the snapshot belongs to, so a user switch cannot be answered from the previous user's config. */
    let homeSectionPrefsUserId = null;
    let homeSectionPrefsInFlight = false;
    /** Per-container memo of the resolved slot list, rebuilt whenever the snapshot changes. */
    let configuredSectionsCache = new WeakMap();

    /**
     * Fetches the current user's home-section configuration once, in the background.
     *
     * Deliberately fire-and-forget: until it lands, classifyRow falls through to the markup signals,
     * which are correct on their own — this only replaces inference with the actual configuration.
     * A failed fetch is not retried; the fallbacks stay in charge.
     */
    function primeHomeSectionPrefs() {
        let userId = null;
        try { userId = window.ApiClient?.getCurrentUserId?.() || null; } catch (e) { return; }
        if (!userId) return;
        if (homeSectionPrefsUserId === userId && (homeSectionPrefs || homeSectionPrefsInFlight)) return;

        homeSectionPrefsUserId = userId;
        homeSectionPrefs = null;
        homeSectionPrefsInFlight = true;
        configuredSectionsCache = new WeakMap();

        Promise.resolve()
            .then(() => window.ApiClient.getDisplayPreferences('usersettings', userId, 'emby'))
            .then((prefs) => {
                if (homeSectionPrefsUserId !== userId) return;
                homeSectionPrefs = prefs?.CustomPrefs || {};
                // Verdicts cached from the fallback path were reached without this config — drop them
                // so every row is re-read against it.
                configuredSectionsCache = new WeakMap();
                sectionSurfaceCache = new WeakMap();
            })
            .catch((e) => {
                console.warn('🪼 Jellyfin Enhanced: home-section preferences unavailable, falling back to row markup', e);
            })
            .then(() => {
                if (homeSectionPrefsUserId === userId) homeSectionPrefsInFlight = false;
            });
    }

    /** The `N` of a `sectionN` class, or null when the element carries none. */
    function sectionSlotIndex(section) {
        for (const cls of section.classList) {
            const match = /^section(\d+)$/.exec(cls);
            if (match) return Number.parseInt(match[1], 10);
        }
        return null;
    }

    /** Resolves the container's slot list from the user's config, memoised per container element. */
    function configuredSectionTypes(container) {
        if (!homeSectionPrefs) return null;
        const cached = configuredSectionsCache.get(container);
        if (cached) return cached;

        const types = [];
        for (let i = 0; i < HOME_SECTION_SLOTS; i++) {
            let type = homeSectionPrefs[`homesection${i}`] || HOME_SECTION_DEFAULTS[i] || '';
            if (type === 'folders') type = HOME_SECTION_DEFAULTS[0];
            types.push(String(type).toLowerCase());
        }
        // An 11th slot only exists on the TV layout, where a library row was prepended.
        if (container.querySelector(':scope > .section10')
            && !types.includes('smalllibrarytiles') && !types.includes('librarybuttons')) {
            types.unshift('smalllibrarytiles');
        }

        const frozen = Object.freeze(types);
        configuredSectionsCache.set(container, frozen);
        return frozen;
    }

    /**
     * Identifies a native home row from the user's home-section configuration.
     * @param {Element} section The row element.
     * @returns {'continuewatching'|'nextup'|'other'|null} 'other' means the config positively says this
     *   slot is something else; null means the config cannot answer and the caller should fall back.
     */
    function nativeRowKindFromPreferences(section) {
        const container = section.closest('.homeSectionsContainer');
        if (!container) return null;
        const index = sectionSlotIndex(section);
        if (index === null) return null;

        primeHomeSectionPrefs();
        const types = configuredSectionTypes(container);
        const type = types ? types[index] : null;
        if (!type || type === 'none') return null;

        if (RESUME_SECTION_TYPES.has(type)) return 'continuewatching';
        if (type === 'nextup') return 'nextup';
        return 'other';
    }

    /**
     * Classifies a home row as Continue Watching, Next Up, both, or neither — using the row's
     * own markup rather than its (translated) heading wherever possible.
     * @param {Element} section A `.section` / `.verticalSection` / `.homeSection` element.
     * @returns {'continuewatching'|'nextup'|'both'|null}
     */
    function classifyRow(section) {
        for (const cls of section.classList) {
            const hit = HSS_ROW_CLASS_SURFACE[cls.toLowerCase()];
            if (hit) return hit;
        }

        // A Home Screen Sections row is fully described by the class checked above, and it is
        // the ONLY thing that describes it: HSS stamps jellyfin-web's playback-monitor marker
        // onto every row it renders, including Recently Added, so the native test below would
        // read those as resume rows. Its rows are identifiable by the page index it tags them
        // with, so stop here rather than fall through to a marker it overloads.
        if (section.hasAttribute('data-page')) return null;

        // What the user actually configured this slot to be. Exact when available, and authoritative
        // in both directions: 'other' ends the search rather than letting a weaker signal override it.
        const configured = nativeRowKindFromPreferences(section);
        if (configured === 'continuewatching' || configured === 'nextup') return configured;
        if (configured === 'other') return null;

        // Native Next Up: its heading links to the Next Up list. Absent on the TV layout,
        // which renders a bare <h2> — that case is caught by the data-monitor test below.
        if (section.querySelector('a[href*="type=nextup"]')) return 'nextup';

        // Resume and Next Up are the only home rows jellyfin-web asks to re-render on playback
        // events, so a monitored row is one of the two. Both carry the same marker, so the
        // caller's per-card playback position decides which.
        const monitored = section.querySelector('.itemsContainer[data-monitor]');
        if (monitored && /playback/i.test(monitored.getAttribute('data-monitor') || '')) return 'both';

        // Last resort for themes/markup with none of the above: the (English) heading text.
        const title = (section.querySelector('.sectionTitle, h2, .headerText, .sectionTitle-sectionTitle')?.textContent || '')
            .toLowerCase().trim();
        if (title.includes('next up')) return 'nextup';
        if (title.includes('continue watching')) return 'continuewatching';
        return null;
    }

    /**
     * Determines the home surface a card is being *displayed on*, or null when it is not in a
     * Continue Watching / Next Up row at all.
     *
     * Strict by design: a resume item also appears in rows like "Recently Added", and those
     * cards carry a playback position too, so treating the position alone as proof of surface
     * would let a Continue-Watching-scoped hide blank the item everywhere it shows up. The row
     * decides the kind; the card's playback position only disambiguates a combined row (Home
     * Screen Sections renders one "Continue Watching / Next Up" section holding both).
     * @param {Element} el A `.card` element, or any element inside/representing one.
     * @returns {'continuewatching'|'nextup'|null}
     */
    JE.detectCardRowSurface = function(el) {
        if (!el) return null;
        const card = (typeof el.closest === 'function' ? el.closest('.card') : null) || el;
        const section = typeof card.closest === 'function'
            ? card.closest('.section, .verticalSection, .homeSection')
            : null;
        if (!section) return null;

        // Only the row-level verdict is cached — the per-card test below always runs, so a
        // resume card in a combined row is never served a stale "nextup".
        let kind;
        if (sectionSurfaceCache.has(section)) {
            kind = sectionSurfaceCache.get(section);
        } else {
            kind = classifyRow(section);
            sectionSurfaceCache.set(section, kind);
        }
        if (!kind) return null;
        if (kind !== 'both') return kind;

        const ticks = (card.getAttribute && card.getAttribute('data-positionticks'))
            || (el.getAttribute && el.getAttribute('data-positionticks'));
        return ticks ? 'continuewatching' : 'nextup';
    };

    /**
     * Which surface a Remove action on this card should be scoped to.
     *
     * Deliberately more generous than {@link JE.detectCardRowSurface}: when the row cannot be
     * identified (a custom theme, an unrecognised layout) a card that carries a playback
     * position is still a Continue Watching item, and offering Remove there is useful — the
     * worst case is writing a scope for a surface the user was not looking at, which hides
     * nothing extra. Filtering cannot afford the same guess, which is why it is a separate call.
     * @param {Element} el A `.card` element, or any element inside/representing one.
     * @returns {'continuewatching'|'nextup'|null}
     */
    JE.detectCardSurface = function(el) {
        if (!el) return null;
        const row = JE.detectCardRowSurface(el);
        if (row) return row;

        const card = (typeof el.closest === 'function' ? el.closest('.card') : null) || el;
        const ticks = (card.getAttribute && card.getAttribute('data-positionticks'))
            || (el.getAttribute && el.getAttribute('data-positionticks'));
        return ticks ? 'continuewatching' : null;
    };

    /**
     * Optimistically hides the just-removed card. Prefers hiding the exact card the user
     * acted on (so the same item shown in another row is never blanked); if that element is
     * gone, falls back to cards whose detected surface matches the one removed from.
     * @param {string} itemId Jellyfin item ID.
     * @param {string} surface 'continuewatching' | 'nextup'.
     * @param {Element} [card] The specific card element the action was triggered from.
     */
    function optimisticHideRemovedCard(itemId, surface, card) {
        try {
            if (card && card.isConnected) {
                card.style.display = 'none';
                return;
            }
            // Fallback (card re-rendered/detached): hide matching cards on the same surface only.
            document.querySelectorAll(`.card[data-id="${CSS.escape(itemId)}"]`).forEach(c => {
                if (JE.detectCardSurface(c) === surface) {
                    c.style.display = 'none';
                }
            });
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: optimistic DOM-hide failed', e);
        }
    }

    /**
     * Non-destructive removal from a home surface (Continue Watching / Next Up):
     * server POST + scoped optimistic DOM hide. Playback position is always preserved.
     * @param {string} itemId Jellyfin item ID.
     * @param {string} surface 'continuewatching' | 'nextup'.
     * @param {Element} [card] The specific card element the action was triggered from.
     * @returns {Promise<boolean>}
     */
    async function removeFromHomeSurface(itemId, surface, card) {
        const config = REMOVE_SURFACES[surface];
        const userId = ApiClient.getCurrentUserId();
        if (!userId || !itemId || !config) {
            showNotification(JE.t('remove_continue_watching_error'), "error");
            return false;
        }

        // Flush pending HC save BEFORE the POST so a later debounce can't clobber the just-written entry.
        // If the flush fails the debounce is rescheduled inside flushPendingSave; abort the write so we
        // don't proceed on top of stale server state.
        try {
            await JE.hiddenContent?.flushPendingSave?.();
        } catch (e) {
            showNotification(JE.t('remove_continue_watching_error_api', { error: e?.statusText || JE.t('unknown_error') }), "error");
            return false;
        }

        try {
            await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl(`/JellyfinEnhanced/${config.path}/hide/${itemId}`),
                data: '{}',
                contentType: 'application/json',
                dataType: 'json',
                headers: { 'Content-Type': 'application/json' }
            });

            optimisticHideRemovedCard(itemId, surface, card);

            // Local-cache mirror only — server already wrote the canonical entry; a refetch would risk a clobber.
            try {
                JE.hiddenContent?.markScopedHidden?.(itemId, surface);
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: markScopedHidden mirror failed', e);
            }
            return true;
        } catch (error) {
            const errorMessage = error.responseJSON?.message
                || error.responseJSON?.Message
                || error.statusText
                || JE.t('unknown_error');
            showNotification(JE.t('remove_continue_watching_error_api', { error: errorMessage }), "error");
            return false;
        }
    }

    // Closes any open action sheet via dialog.close() / Escape; never synthetic mouse events (they reopen the sheet).
    function closeOpenActionSheet() {
        try {
            const dialogs = document.querySelectorAll('dialog[open]');
            let dispatched = false;
            for (const dlg of dialogs) {
                if (typeof dlg.close === 'function') {
                    try { dlg.close(); dispatched = true; } catch (e) { /* not a real dialog */ }
                }
            }
            if (dispatched) return true;

            // Escape-keydown fallback targets the sheet directly — dispatching on `document` is
            // intercepted by JE's global shortcuts. Jellyfin leaves dismissed sheets in the DOM,
            // so target the VISIBLE one (newest), not the first (possibly stale/hidden) match.
            const sheets = [...document.querySelectorAll('.actionSheet, .actionsheet, .dialogContainer .dialog, .dialog.opened')];
            const sheet = sheets.reverse().find(s => s.offsetParent !== null) || sheets[0];
            if (sheet) {
                sheet.dispatchEvent(new KeyboardEvent('keydown', {
                    key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
                    bubbles: true, cancelable: true
                }));
            }
            return true;
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: action sheet close failed', err);
            return false;
        }
    }

    /** Hides Continue Watching / Next Up rows whose visible-card count is zero so the title doesn't linger. */
    function hideEmptyHomeSections() {
        try {
            const sections = document.querySelectorAll('.verticalSection, .section, .homeSection');
            for (const section of sections) {
                const titleEl = section.querySelector('.sectionTitle, h2, .headerText, .sectionTitle-sectionTitle');
                const title = (titleEl?.textContent || '').toLowerCase().trim();
                const isCW = title.startsWith('continue watching');
                const isNextUp = title.startsWith('next up');
                if (!isCW && !isNextUp) continue;

                const cards = section.querySelectorAll('.card[data-positionticks], .card[data-id]');
                let visibleCount = 0;
                for (const card of cards) {
                    if (card.classList.contains('je-hidden')) continue;
                    if (card.style.display === 'none') continue;
                    visibleCount++;
                }
                if (visibleCount === 0) section.style.display = 'none';
            }
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: hideEmptyHomeSections failed', err);
        }
    }
    JE.hideEmptyHomeSections = hideEmptyHomeSections;

    /**
     * Creates the surface-specific "Remove from …" button for the per-item action sheet,
     * rendered to match the sheet's native items. The bound item + surface are stamped onto
     * the element so a reused action sheet can tell whether an existing button still matches.
     * @param {HTMLElement} scroller The action-sheet scroller it will be inserted into.
     * @param {string} itemId The ID of the item.
     * @param {string} surface 'continuewatching' | 'nextup'.
     * @param {Element} [card] The source card element, for a precise optimistic hide.
     * @returns {HTMLElement} The created button element.
     */
    function createRemoveButton(scroller, itemId, surface, card) {
        const config = REMOVE_SURFACES[surface] || REMOVE_SURFACES.continuewatching;
        const button = buildNativeActionSheetItem(scroller, {
            dataId: 'remove-continue-watching',
            icon: 'visibility_off',
            text: JE.t(config.labelKey)
        });
        button.dataset.jeItemId = itemId;
        button.dataset.jeSurface = surface;
        const textEl = button.querySelector('.actionSheetItemText');

        button.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const originalText = textEl.textContent;
            button.disabled = true;
            textEl.textContent = JE.t('remove_button_removing');
            setActionSheetItemIcon(button, 'hourglass_empty');

            const success = await removeFromHomeSurface(itemId, surface, card);

            // Restore visuals BEFORE close — a stuck sheet under odd themes is better than a stuck "Removing…" label.
            button.disabled = false;
            textEl.textContent = originalText;
            setActionSheetItemIcon(button, 'visibility_off');

            if (success) {
                const closed = closeOpenActionSheet();
                showNotification(JE.t(config.successKey), closed ? "success" : "info");
                hideEmptyHomeSections();
            }
        });

        return button;
    }

    /**
     * Returns the scroller of the action sheet that is actually on screen. Jellyfin leaves
     * dismissed action-sheet DOM behind, so the first `.actionSheetScroller` in the document
     * can be a stale/hidden one — pick the newest visible scroller instead.
     * @returns {HTMLElement|null}
     */
    function getActiveActionSheetScroller() {
        const scrollers = document.querySelectorAll('.actionSheetScroller');
        for (let i = scrollers.length - 1; i >= 0; i--) {
            if (scrollers[i].offsetParent !== null) return scrollers[i];
        }
        return scrollers.length ? scrollers[scrollers.length - 1] : null;
    }

    /**
     * Adds the Remove button to the per-item action sheet for the item whose menu was just
     * opened. The action sheet content element is reused across opens, so a Remove button
     * from a previous item can linger; this reconciles the button against the freshly-captured
     * context (set on the menu mousedown / right-click) and removes any stale one.
     *
     * Two guards keep the button from leaking onto an unrelated sheet:
     *   • it only acts on a recent trigger (REMOVE_CONTEXT_TTL_MS), and
     *   • it only injects into a sheet that carries a media-item action (resume/play), so
     *     non-item sheets (sort menus, OSD audio/subtitle pickers, multi-select) are skipped.
     * The context is consumed once handled so a later sheet can't reuse it.
     */
    JE.addRemoveButton = () => {
        if (!JE.currentSettings.removeContinueWatchingEnabled) return;

        const scroller = getActiveActionSheetScroller();
        if (!scroller) return;

        const existing = scroller.querySelector('[data-id="remove-continue-watching"]');
        // Only a media-item action sheet exposes play/resume; anything else isn't an item menu.
        const insertionPoint = scroller.querySelector('[data-id="playallfromhere"]')
            || scroller.querySelector('[data-id="resume"]')
            || scroller.querySelector('[data-id="play"]');

        // Non-item sheet (sort/OSD/multi-select). It must never host the per-item Remove button,
        // so strip one that leaked in via a reused scroller — even with no fresh context — then bail.
        if (!insertionPoint) { if (existing) existing.remove(); return; }

        const ctx = JE.state.removeContext;
        // Media-item sheet but no recent trigger: leave any existing button untouched (don't strip
        // a still-valid button while its sheet is open; a fresh trigger reconciles it).
        if (!ctx || !ctx.itemId || (Date.now() - (ctx.ts || 0)) > REMOVE_CONTEXT_TTL_MS) return;

        const wantSurface = REMOVE_SURFACES[ctx.surface] ? ctx.surface : null;
        if (existing) {
            // Keep an already-correct button (avoids flicker on repeated observer fires).
            if (wantSurface && existing.dataset.jeItemId === ctx.itemId && existing.dataset.jeSurface === wantSurface) {
                JE.state.removeContext = null;
                return;
            }
            existing.remove();
        }
        if (!wantSurface) { JE.state.removeContext = null; return; }

        const removeButton = createRemoveButton(scroller, ctx.itemId, wantSurface, ctx.card);
        insertionPoint.after(removeButton);
        fitRemoveItemToMenu(removeButton, scroller);
        // Consume the context: one menu-open yields one button; later observer fires (or an
        // unrelated sheet opened within the TTL) must not re-inject from this same context.
        JE.state.removeContext = null;
    };

    // Shared with the multi-select Remove menu (features-remove-multiselect.js).
    internal.showNotification = showNotification;
    internal.REMOVE_SURFACES = REMOVE_SURFACES;
    internal.buildNativeActionSheetItem = buildNativeActionSheetItem;
    internal.setActionSheetItemIcon = setActionSheetItemIcon;
    internal.fitRemoveItemToMenu = fitRemoveItemToMenu;
    internal.removeFromHomeSurface = removeFromHomeSurface;
    internal.closeOpenActionSheet = closeOpenActionSheet;
    internal.hideEmptyHomeSections = hideEmptyHomeSections;
    internal.getActiveActionSheetScroller = getActiveActionSheetScroller;

})(window.JellyfinEnhanced);
