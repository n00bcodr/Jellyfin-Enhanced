/**
 * @file Requests & downloads, phase 3: Seerr's request controls in Jellyfin Enhanced mode. Once Jellyfin Enhanced
 * handles requests (JE mode), Seerr no longer takes requests from the household, so every Seerr-style Request
 * control JE draws (search and Discover cards, the more-info modal's request buttons and season picker, the
 * recommendation, collection and person rows, Home Screen Sections' discover cards) opens JE's own request sheet
 * (JE.arrAskSheet) for that title instead: movies with one tap unless the sheet is needed, series with the season
 * and episode choices, 4K buttons with the 4K edition; a collection's Request lists its movies and asks for the
 * ticked ones. Seerr's own request modals are never shown in JE mode, so
 * the household never sees Seerr's servers, profiles or folders. In Seerr mode (and with the request controls
 * off) nothing here changes anything: every control keeps its Seerr behaviour.
 *
 * How: one capture-phase click listener takes clicks on Seerr request buttons and 4K menu items (and HSS request
 * buttons) before their own handlers; the request-modal entry points (movie, season picker, collection) are
 * wrapped for callers that open them directly; and Seerr's "advanced options" check reads true in JE mode so the
 * one-tap paths go through the (wrapped) modal entry points instead of writing to Seerr.
 */
(function (JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Requests:';
    const state = { installed: false, listening: false };

    /**
     * True in JE mode: the request controls are on and Jellyfin Enhanced (not Seerr) handles requests.
     * @returns {boolean} JE mode.
     */
    function jeMode() {
        return JE.pluginConfig?.ArrRequestsJeMode === true && JE.arrAsk?.enabled?.() === true;
    }

    /**
     * The JE request sheet's title for a Seerr/TMDB item.
     * @param {'movie'|'tv'} mediaType Media type.
     * @param {number|string} tmdbId TMDB id.
     * @param {Object|null} item Seerr search/discover item (title, name, dates, posterPath), if known.
     * @param {string} [fallbackName] Name shown on the card.
     * @returns {Object|null} Title for JE.arrAskSheet, or null when the id isn't usable.
     */
    function titleOf(mediaType, tmdbId, item, fallbackName) {
        const id = Number.parseInt(String(tmdbId ?? ''), 10);
        if (!Number.isInteger(id) || id <= 0 || !['movie', 'tv'].includes(mediaType)) return null;
        const movie = mediaType === 'movie';
        const date = String((movie ? item?.releaseDate : item?.firstAirDate) || item?.releaseDate || item?.firstAirDate || '');
        const year = /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : undefined;
        const name = String(item?.title || item?.name || item?.originalTitle || item?.originalName || fallbackName || '').trim();
        const poster = typeof item?.posterPath === 'string' && /^\/[A-Za-z0-9_.-]{1,80}$/.test(item.posterPath) ? item.posterPath : undefined;
        return { key: `${movie ? 'movie' : 'tv'}:tmdb:${id}`, kind: movie ? 'movie' : 'series', name, year, poster, tmdbId: id };
    }

    /**
     * Opens JE's request sheet for a title (movies one tap unless the sheet is needed; 4K always through the
     * sheet) and, when an ask was recorded, shows it on the control that opened it.
     * @param {Object} title Title (see {@link titleOf}).
     * @param {{opener?: HTMLElement|null, variant?: string}} [options] Opener (focus returns there; it shows the outcome) and edition.
     * @returns {Promise<Object|null>} The ask result, or null.
     */
    async function openSheet(title, options) {
        const sheet = JE.arrAskSheet;
        if (!sheet || !title) return null;
        const opener = options?.opener || null;
        const variant = options?.variant === '4k' ? '4k' : 'standard';
        let result = null;
        try {
            result = title.kind === 'movie' && variant === 'standard'
                ? await sheet.openOrAsk(title, { opener })
                : await sheet.open(title, { opener, variant });
        } catch (err) {
            console.warn(`${logPrefix} the request sheet could not open (${err?.message || err})`);
            JE.arrAsk?.toast?.(JE.arrAsk.describe({ state: 'failed' }, null).text);
            return null;
        }
        if (result && (result.ok || result.state === 'unknown') && opener?.isConnected && opener.matches?.('.jellyseerr-request-button, .discover-requestbutton')) {
            if (title.kind !== 'movie') {
                // A season or an episode asked for leaves the rest to ask for: the button stays and reopens the sheet.
                opener.textContent = JE.arrAsk.tr('arr_discover_request_more');
                opener.classList.add('je-ask-seerr-asked');
            } else if (variant === 'standard') {
                // (A 4K ask leaves the standard button as it is; the sheet said what happened.)
                const said = JE.arrAsk.describe(result, await JE.arrAsk.me(), null);
                if (said.chip) {
                    opener.disabled = true;
                    opener.textContent = said.chip;
                    opener.classList.add('je-ask-seerr-asked');
                }
            }
        }
        return result;
    }

    /** Most movies one collection ask asks for (as a collection page's "Get the N missing"). */
    const MAX_COLLECTION = 20;

    /**
     * Keeps a collection picker's ticks to at most {@link MAX_COLLECTION}: once that many are ticked, the other movies
     * that could be asked for can't be ticked until one is unticked.
     * @param {ParentNode|null|undefined} root The picker (or its list).
     * @returns {void}
     */
    function capTicks(root) {
        const boxes = [...(root?.querySelectorAll?.('.jellyseerr-collection-checkbox[data-je-askable]') || [])];
        const full = boxes.filter(b => b.checked).length >= MAX_COLLECTION;
        for (const box of boxes) box.disabled = full && !box.checked;
    }

    /**
     * Seerr's collection request in JE mode: the collection's movies (Seerr's collection details) in Seerr's request
     * window; the first 20 not already available are ticked and at most 20 can be (a note says so when there are
     * more); the button asks Jellyfin Enhanced for each ticked movie in turn and says what happened, as a collection
     * page's "Get the N missing" does. No Seerr servers, profiles or folders, no Seerr write. Without an id (or the
     * window) it says to ask one movie at a time.
     * @param {number|string} [collectionId] TMDB collection id.
     * @param {string} [collectionName] Collection name.
     * @returns {Promise<void>}
     */
    async function collectionAsk(collectionId, collectionName) {
        const caps = await JE.arrAsk.me();
        if (!JE.arrAsk.canAsk(caps, 'movie')) {
            JE.arrAsk.toast(JE.arrAsk.describe({ state: 'denied' }, caps).text);
            return;
        }
        const id = Number.parseInt(String(collectionId ?? ''), 10);
        const modal = JE.jellyseerrModal;
        const fetchDetails = JE.jellyseerrAPI?.fetchCollectionDetails;
        if (!Number.isInteger(id) || id <= 0 || typeof modal?.create !== 'function' || typeof fetchDetails !== 'function') {
            JE.arrAsk.toast(JE.arrAsk.tr('arr_seerr_collection_one_by_one'));
            return;
        }
        let details = null;
        try {
            details = await fetchDetails(id);
        } catch {
            details = null;
        }
        if (!details) {
            JE.arrAsk.toast(JE.arrAsk.tr('jellyseerr_toast_collection_fetch_failed'));
            return;
        }
        const parts = (Array.isArray(details.parts) ? details.parts : []).filter(p => Number.isInteger(p?.id) && p.id > 0);
        if (!parts.length) {
            JE.arrAsk.toast(JE.arrAsk.tr('jellyseerr_toast_no_movies_in_collection'));
            return;
        }
        const esc = typeof JE.escapeHtml === 'function' ? JE.escapeHtml : (v) => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
        let ticked = 0;
        const askable = parts.filter(movie => movie.mediaInfo?.status !== 5).length;
        const rows = parts.map((movie) => {
            // Seerr's media status 5: available (in Jellyfin).
            const here = movie.mediaInfo?.status === 5;
            const tick = !here && ticked < MAX_COLLECTION;
            if (tick) ticked++;
            const date = String(movie.releaseDate || '');
            const year = /^\d{4}/.test(date) ? date.slice(0, 4) : '';
            const poster = typeof movie.posterPath === 'string' && /^\/[A-Za-z0-9_.-]{1,80}$/.test(movie.posterPath)
                ? `<img src="https://image.tmdb.org/t/p/w92${esc(movie.posterPath)}" alt="" class="jellyseerr-collection-movie-poster">` : '<div></div>';
            return `<div class="jellyseerr-collection-movie-row">
                <input type="checkbox" class="jellyseerr-collection-checkbox" data-tmdb-id="${esc(movie.id)}" aria-label="${esc(movie.title || movie.name || '')}" ${here ? 'disabled' : `data-je-askable="1"${tick ? ' checked' : ''}`}>
                ${poster}
                <div class="jellyseerr-collection-movie-details"><div class="title">${esc(movie.title || movie.name || '')}</div><div class="year">${esc(year)}</div></div>
                ${here ? `<div class="jellyseerr-season-status jellyseerr-season-status-available">${esc(JE.arrAsk.tr('jellyseerr_btn_available'))}</div>` : '<div></div>'}
            </div>`;
        }).join('');
        const instance = modal.create({
            title: JE.arrAsk.tr('jellyseerr_modal_request_collection'),
            subtitle: String(collectionName || details.name || ''),
            bodyHtml: (askable > MAX_COLLECTION ? `<p class="je-arr-collection-cap" style="margin: 0 0 0.75em; opacity: 0.85;">${esc(JE.arrAsk.tr('arr_seerr_collection_cap', { n: MAX_COLLECTION }))}</p>` : '')
                + `<div class="jellyseerr-collection-list" style="max-height: 600px; overflow-y: auto;">${rows}</div>`,
            backdropPath: details.backdropPath || details.backdrop_path,
            buttonText: JE.arrAsk.tr('jellyseerr_modal_request_selected_movies'),
            onSave: async (modalEl, button, closeFn) => {
                const ids = [...modalEl.querySelectorAll('.jellyseerr-collection-checkbox:checked:not(:disabled)')]
                    .map(cb => Number.parseInt(cb.dataset.tmdbId, 10)).filter(n => Number.isInteger(n) && n > 0);
                if (!ids.length) {
                    JE.arrAsk.toast(JE.arrAsk.tr('jellyseerr_modal_toast_select_movie'));
                    return;
                }
                if (ids.length > MAX_COLLECTION) {
                    // Never a silent cut: the picker stays open to untick some.
                    JE.arrAsk.toast(JE.arrAsk.tr('arr_seerr_collection_cap', { n: MAX_COLLECTION }));
                    capTicks(modalEl);
                    return;
                }
                button.disabled = true;
                const results = [];
                for (const tmdbId of ids) {
                    let result;
                    try {
                        result = await JE.arrAsk.ask(JE.arrAsk.movieInput(`movie:tmdb:${tmdbId}`));
                    } catch {
                        result = { ok: false, state: 'failed' };
                    }
                    if (result?.stale) return;
                    results.push(result || { ok: false, state: 'failed' });
                }
                const line = JE.internals?.arrAskCollection?.summarize?.(results, caps);
                if (line) JE.arrAsk.toast(line);
                closeFn();
            }
        });
        const list = instance?.modalElement?.querySelector?.('.jellyseerr-collection-list');
        if (list) {
            list.addEventListener('change', () => capTicks(list));
            capTicks(list);
        }
        instance?.show?.();
    }

    /**
     * Capture-phase clicks: a Seerr request button, a 4K menu item or a Home Screen Sections request button opens
     * the JE sheet for its title in JE mode (their own handlers don't run). Anything else passes through.
     * @param {MouseEvent} e Click.
     * @returns {void}
     */
    function onClick(e) {
        if (!jeMode()) return;
        const target = e.target instanceof Element ? e.target : null;
        if (!target) return;
        let title = null;
        let variant = 'standard';
        let opener = null;
        const popupItem = target.closest('.jellyseerr-4k-popup-item[data-action="request4k"]');
        const hss = !popupItem && target.closest('.discover-requestbutton');
        const seerrButton = !popupItem && !hss && target.closest('button.jellyseerr-request-button');
        if (popupItem) {
            // The popup is appended to <body>, not inside its card: the split button it was opened from says which title.
            const source = JE.internals?.jellyseerrUi?.fourKPopupSource?.(popupItem.closest('.jellyseerr-4k-popup')) || null;
            const card = source?.buttonGroup?.closest?.('.jellyseerr-card') || popupItem.closest('.jellyseerr-card');
            const button = source?.buttonGroup?.querySelector?.('.jellyseerr-request-button') || card?.querySelector('.jellyseerr-request-button');
            const item = source?.item || parseItem(button?.dataset?.searchResultItem);
            const mediaType = String(popupItem.dataset.mediaType || item?.mediaType || 'movie').toLowerCase();
            title = titleOf(mediaType, popupItem.dataset.tmdbId, item, cardName(card));
            variant = '4k';
            opener = button || null;
        } else if (hss) {
            const card = hss.closest('.discover-card');
            const mediaType = String(card?.dataset?.mediaType || '').toLowerCase();
            title = titleOf(mediaType, card?.dataset?.tmdbId, null, card?.querySelector('.cardText, .discover-title, .cardText-first')?.textContent);
            opener = hss;
        } else if (seerrButton) {
            if (seerrButton.disabled) return;
            const mediaType = String(seerrButton.dataset.mediaType || '').toLowerCase();
            if (mediaType === 'collection') {
                e.preventDefault();
                e.stopImmediatePropagation();
                const item = parseItem(seerrButton.dataset.searchResultItem);
                collectionAsk(seerrButton.dataset.tmdbId || item?.id, item?.name || item?.title || cardName(seerrButton.closest('.jellyseerr-card')));
                return;
            }
            const item = parseItem(seerrButton.dataset.searchResultItem);
            title = titleOf(mediaType, seerrButton.dataset.tmdbId || item?.id, item, cardName(seerrButton.closest('.jellyseerr-card')));
            opener = seerrButton;
        } else {
            return;
        }
        // Nothing usable to open (no id, or no name to show where the page knows more, as in the more-info modal):
        // leave the control alone; its own handler reaches the wrapped modal entry points with the full item.
        if (!title || (!title.name && !hss)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (popupItem) popupItem.closest('.jellyseerr-4k-popup')?.remove();
        openSheet(title, { opener, variant });
    }

    /**
     * The Seerr item a request button carries (JSON in data-search-result-item), or null.
     * @param {string|undefined} json JSON.
     * @returns {Object|null} Item.
     */
    function parseItem(json) {
        if (!json) return null;
        try {
            return JSON.parse(json);
        } catch {
            return null;
        }
    }

    /**
     * The name shown on a Seerr card ('' when none).
     * @param {Element|null|undefined} card Card.
     * @returns {string} Name.
     */
    function cardName(card) {
        return card?.querySelector?.('.cardText-first bdi, .cardText-first')?.textContent?.trim() || '';
    }

    /**
     * Wraps Seerr's request entry points once (they exist once the Seerr modules have loaded): in JE mode they
     * open the JE sheet; otherwise the originals run unchanged.
     * @returns {void}
     */
    function install() {
        if (state.installed) return;
        const ui = JE.jellyseerrUI;
        const api = JE.jellyseerrAPI;
        if (!ui || !api) return;
        state.installed = true;
        const showMovie = ui.showMovieRequestModal;
        const showSeasons = ui.showSeasonSelectionModal;
        const showCollection = ui.showCollectionRequestModal;
        const advanced = api.shouldShowAdvanced;
        if (typeof showMovie === 'function') {
            ui.showMovieRequestModal = function (tmdbId, titleText, item, is4k) {
                if (!jeMode()) return showMovie.apply(this, arguments);
                return openSheet(titleOf('movie', tmdbId, item, titleText), { opener: document.activeElement, variant: is4k ? '4k' : 'standard' });
            };
        }
        if (typeof showSeasons === 'function') {
            ui.showSeasonSelectionModal = function (tmdbId, mediaType, showTitle, item, is4k) {
                if (!jeMode()) return showSeasons.apply(this, arguments);
                return openSheet(titleOf(String(mediaType || 'tv').toLowerCase(), tmdbId, item, showTitle), { opener: document.activeElement, variant: is4k ? '4k' : 'standard' });
            };
        }
        if (typeof showCollection === 'function') {
            ui.showCollectionRequestModal = function (collectionId, collectionName) {
                if (!jeMode()) return showCollection.apply(this, arguments);
                return collectionAsk(collectionId, collectionName);
            };
        }
        if (typeof advanced === 'function') {
            // JE mode: the one-tap Seerr paths ask "show the request modal?" first; yes sends them to the sheet.
            api.shouldShowAdvanced = function () {
                return jeMode() ? true : advanced.apply(this, arguments);
            };
        }
    }

    /**
     * Starts listening (once).
     * @returns {void}
     */
    function initialize() {
        install();
        if (state.listening) return;
        state.listening = true;
        document.addEventListener('click', onClick, true);
    }

    initialize();

    JE.internals = JE.internals || {};
    JE.internals.arrAskSeerr = { jeMode, titleOf, openSheet, onClick, install, state, capTicks };
})(window.JellyfinEnhanced);
