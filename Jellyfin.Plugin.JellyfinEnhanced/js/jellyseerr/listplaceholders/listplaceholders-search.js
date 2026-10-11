// /js/jellyseerr/listplaceholders/listplaceholders-search.js
// "Add title" modal of a playlist/collection page: Seerr search (through JE's proxy) →
// pick a result → TV granularity → playlist position → POST /items (titles already in
// the library are added as the real item, the toast says which). A "Custom entry" tab
// adds titles Seerr doesn't know. The same modal in "link" mode links a custom entry
// to a TMDB title (PATCH). Admins with "Add to Radarr/Sonarr" on also get a Radarr/Sonarr
// lookup group (listplaceholders-arr.js), which works without Seerr.
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.listPlaceholders = JE.internals.listPlaceholders || {};

    const SEARCH_DEBOUNCE_MS = 350;
    const ARR_RESULTS_PER_SERVICE = 8;
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

    /**
     * Seerr results the feature can store: movies and shows only.
     * @param {Array<Object>} results
     * @returns {Array<Object>}
     */
    function usableResults(results) {
        return (results || []).filter(r => (r?.mediaType === 'movie' || r?.mediaType === 'tv') && Number.isInteger(Number(r.id)) && Number(r.id) > 0);
    }

    /**
     * Markup of the search results list.
     * @param {Array<Object>} results
     * @returns {string}
     */
    function resultsHtml(results) {
        const esc = lp.render.esc;
        if (!results.length) return `<div class="je-lp-muted je-lp-empty">${esc(JE.t('listPlaceholders_no_results'))}</div>`;
        return results.map((r, i) => {
            const date = (r.mediaType === 'tv' ? r.firstAirDate : r.releaseDate) || '';
            const year = /^\d{4}/.test(date) ? date.slice(0, 4) : JE.t('listPlaceholders_tba');
            const type = r.mediaType === 'tv' ? JE.t('listPlaceholders_kind_series') : JE.t('listPlaceholders_kind_movie');
            const inLibrary = r.mediaInfo?.jellyfinMediaId && (r.mediaInfo.status === 5 || r.mediaInfo.status === 4);
            return `<button type="button" class="je-lp-result" role="option" aria-selected="false" data-index="${i}">`
                + `<img loading="lazy" alt="" src="${esc(lp.render.posterUrl(r.posterPath, 'w92'))}">`
                + `<span class="je-lp-result-text"><span class="je-lp-result-title">${esc(r.title || r.name || '')}</span>`
                + `<span class="je-lp-muted">${esc(year)} · ${esc(type)}${inLibrary ? ` · <span class="je-lp-inlib">${esc(JE.t('listPlaceholders_in_library'))}</span>` : ''}</span></span>`
                + '</button>';
        }).join('');
    }

    /**
     * A Seerr-shaped media object for an arr lookup candidate, so the same selection,
     * granularity and placeholder code handles both sources.
     * @param {Object} candidate - From JE.listPlaceholders.arr.searchCandidates().
     * @returns {Object|null} null when the candidate has no TMDB id (custom entry only).
     */
    function arrMedia(candidate) {
        const dto = JE.listPlaceholders?.arr?.toPlaceholder?.(candidate);
        if (!dto) return null;
        const media = { id: dto.tmdbId, mediaType: dto.mediaType, title: dto.title, overview: dto.overview, posterPath: dto.posterPath, source: 'arr' };
        if (dto.mediaType === 'tv') {
            media.name = dto.title;
            media.firstAirDate = dto.releaseDate;
        } else {
            media.releaseDate = dto.releaseDate;
        }
        if (dto.tvdbId) media.tvdbId = dto.tvdbId;
        if (dto.imdbId) media.imdbId = dto.imdbId;
        // Announced titles often have a year but no date yet; basePlaceholder() falls back to it.
        if (dto.year) media.year = dto.year;
        return media;
    }

    /**
     * Radarr and Sonarr hits interleaved (each service's best first), at most `perService` of each,
     * so a show isn't buried under twenty movie hits.
     * @param {Array<Object>} candidates - Radarr hits then Sonarr hits, as searchCandidates() returns them.
     * @param {number} [perService]
     * @returns {Array<Object>}
     */
    function mixArrResults(candidates, perService = ARR_RESULTS_PER_SERVICE) {
        const movies = [];
        const shows = [];
        for (const candidate of candidates || []) (candidate?.mediaType === 'tv' ? shows : movies).push(candidate);
        const mixed = [];
        for (let i = 0; i < perService; i++) {
            if (movies[i]) mixed.push(movies[i]);
            if (shows[i]) mixed.push(shows[i]);
        }
        return mixed;
    }

    /**
     * Markup of the Radarr/Sonarr lookup results: a selectable row (add as a placeholder)
     * plus an "Add to Radarr/Sonarr" button per result.
     * @param {Array<Object>} candidates - Arr lookup candidates.
     * @returns {string}
     */
    function arrResultsHtml(candidates) {
        const esc = lp.render.esc;
        const arr = JE.listPlaceholders?.arr;
        if (!candidates.length) return `<div class="je-lp-muted je-lp-empty">${esc(JE.t('listPlaceholders_no_results'))}</div>`;
        return candidates.map((c, i) => {
            const year = Number(c.year) > 0 ? String(c.year) : JE.t('listPlaceholders_tba');
            const type = c.mediaType === 'tv' ? JE.t('listPlaceholders_kind_series') : JE.t('listPlaceholders_kind_movie');
            const poster = lp.render.isSafePoster(c.posterPath) || !/^https:\/\//i.test(c.posterUrl || '')
                ? lp.render.posterUrl(c.posterPath, 'w92')
                : c.posterUrl;
            const instance = c.instance?.name || '';
            const state = c.inArr ? JE.t('listPlaceholders_arr_in_instance', { instance: esc(instance) }) : esc(instance);
            const noTmdb = arrMedia(c) ? '' : ` · ${esc(JE.t('listPlaceholders_arr_no_tmdb'))}`;
            const entry = arr?.menuItemFor?.(c);
            const add = entry
                ? `<button type="button" class="je-lp-arr-result-add" data-arr-index="${i}" title="${esc(entry.label)}" aria-label="${esc(`${entry.label}: ${c.title || ''}`)}"><span class="material-icons" aria-hidden="true">${esc(entry.icon)}</span></button>`
                : '';
            return '<div class="je-lp-arr-result" role="presentation">'
                + `<button type="button" class="je-lp-result" role="option" aria-selected="false" data-arr-index="${i}">`
                + `<img loading="lazy" alt="" referrerpolicy="no-referrer" src="${esc(poster)}">`
                + `<span class="je-lp-result-text"><span class="je-lp-result-title">${esc(c.title || '')}</span>`
                + `<span class="je-lp-muted">${esc(year)} · ${esc(type)}${state ? ` · ${state}` : ''}${noTmdb}</span></span>`
                + '</button>'
                + add
                + '</div>';
        }).join('');
    }

    /**
     * Reads and validates the custom entry form.
     * @param {HTMLElement} root
     * @returns {{dto?: Object, error?: string}}
     */
    function readCustom(root) {
        const title = root.querySelector('.je-lp-custom-title').value.trim();
        const yearText = root.querySelector('.je-lp-custom-year').value.trim();
        const mediaType = root.querySelector('.je-lp-custom-type').value === 'tv' ? 'tv' : 'movie';
        const date = root.querySelector('.je-lp-custom-date').value.trim();
        const note = root.querySelector('.je-lp-custom-note').value.trim();
        if (!title || title.length > 200) return { error: JE.t('listPlaceholders_custom_title_required') };
        const dto = { kind: 'custom', mediaType, title };
        if (yearText) {
            const year = Number(yearText);
            if (!Number.isInteger(year) || year < 1870 || year > 2100) return { error: JE.t('listPlaceholders_custom_bad_year') };
            dto.year = year;
        }
        if (date) {
            if (!DATE_RE.test(date)) return { error: JE.t('listPlaceholders_custom_bad_date') };
            dto.releaseDate = date;
            if (!dto.year) dto.year = Number(date.slice(0, 4));
        }
        if (note) dto.note = note.slice(0, 300);
        return { dto };
    }

    /**
     * Toast for the outcome of an add.
     * @param {Object} result - ApplyResultDto.
     * @param {string} title - What was added.
     */
    function reportAdd(result, title) {
        const esc = lp.render.esc;
        if (result?.addedAsItems?.length && result?.added?.length) {
            // A TV scope partly in the library: its episodes went in, the placeholder tracks the rest (C1).
            JE.toast(JE.t('listPlaceholders_added_partly', { title: esc(title) }), 4000);
        } else if (result?.addedAsItems?.length) {
            JE.toast(JE.t('listPlaceholders_added_as_item', { title: esc(title) }), 4000);
        } else if (result?.added?.length) {
            JE.toast(JE.t('listPlaceholders_added', { title: esc(title) }), 3000);
        } else if (result?.skipped?.length) {
            JE.toast(esc(lp.skipReasonText(result.skipped[0].reason)), 4000);
        }
    }

    /**
     * Whether a link answer shows the entry already swapped in: gone from the view (a movie or a
     * complete scope) or with episodes filled (C1: whatever is in the library goes in at once).
     * @param {Object|null|undefined} view - ListViewDto the PATCH returned.
     * @param {string} placeholderId
     * @returns {boolean}
     */
    function linkedIntoLibrary(view, placeholderId) {
        if (!view || !Array.isArray(view.placeholders)) return false;
        const ph = view.placeholders.find(p => p.id === placeholderId);
        return !ph || Number(ph.filledCount) > 0;
    }

    /**
     * Opens the Add title modal (or the link modal for a custom entry).
     * @param {Object} ctrl - Page controller: {listId, listKind, listName, view, positionOptions?(), afterRealItemsAdded?()}.
     * @param {{mode?: 'add'|'link', placeholder?: Object}} [options]
     * @returns {Object|null} The modal instance.
     */
    function open(ctrl, options = {}) {
        if (!JE.jellyseerrModal?.create) return null;
        lp.ensureStyles?.();
        const esc = lp.render.esc;
        const linkMode = options.mode === 'link';
        const seerrOn = JE.pluginConfig?.JellyseerrEnabled === true && !!JE.jellyseerrAPI?.search;
        if (linkMode && !seerrOn) return null;
        // Admin Radarr/Sonarr lookup results (add mode only); they also make the search usable without Seerr.
        const arr = linkMode ? null : JE.listPlaceholders?.arr;
        const arrOn = !!arr?.isAvailable?.();
        const searchOn = seerrOn || arrOn;
        const positions = !linkMode && ctrl.listKind === 'playlist' && ctrl.positionOptions ? ctrl.positionOptions() : [];

        const searchPane = `
            <div class="je-lp-pane" data-pane="search"${searchOn ? '' : ' hidden'}>
                <input type="search" class="je-lp-input je-lp-query" autocomplete="off" placeholder="${esc(JE.t('listPlaceholders_search_placeholder'))}" aria-label="${esc(JE.t('listPlaceholders_search_placeholder'))}">
                <div class="je-lp-results" role="listbox"></div>
                <div class="je-lp-selected" hidden></div>
            </div>`;
        const customPane = linkMode ? '' : `
            <div class="je-lp-pane" data-pane="custom"${searchOn ? ' hidden' : ''}>
                <label class="je-lp-field"><span>${esc(JE.t('listPlaceholders_custom_title'))}</span><input type="text" class="je-lp-input je-lp-custom-title" maxlength="200"></label>
                <div class="je-lp-field-row">
                    <label class="je-lp-field"><span>${esc(JE.t('listPlaceholders_custom_type'))}</span>
                        <select class="je-lp-select je-lp-custom-type"><option value="movie">${esc(JE.t('listPlaceholders_kind_movie'))}</option><option value="tv">${esc(JE.t('listPlaceholders_kind_series'))}</option></select></label>
                    <label class="je-lp-field"><span>${esc(JE.t('listPlaceholders_custom_year'))}</span><input type="number" class="je-lp-input je-lp-custom-year" min="1870" max="2100" step="1"></label>
                    <label class="je-lp-field"><span>${esc(JE.t('listPlaceholders_custom_date'))}</span><input type="date" class="je-lp-input je-lp-custom-date"></label>
                </div>
                <label class="je-lp-field"><span>${esc(JE.t('listPlaceholders_custom_note'))}</span><input type="text" class="je-lp-input je-lp-custom-note" maxlength="300"></label>
            </div>`;
        const tabs = linkMode || !searchOn ? '' : `
            <div class="je-lp-tabs" role="tablist">
                <button type="button" class="je-lp-tab je-lp-tab-active" role="tab" aria-selected="true" data-tab="search">${esc(JE.t('listPlaceholders_tab_search'))}</button>
                <button type="button" class="je-lp-tab" role="tab" aria-selected="false" data-tab="custom">${esc(JE.t('listPlaceholders_tab_custom'))}</button>
            </div>`;
        const position = positions.length ? `
            <label class="je-lp-field je-lp-position"><span>${esc(JE.t('listPlaceholders_position'))}</span>
                <select class="je-lp-select je-lp-position-select">${positions.map(p => `<option value="${esc(p.value)}">${esc(p.label)}</option>`).join('')}</select></label>` : '';

        let selected = null;
        let granularity = null;
        let results = [];
        let arrResults = [];
        // An arr result whose "Add to Radarr/Sonarr" was pressed: opened once this modal has closed.
        let pendingArr = null;
        let searchTimer = null;
        let searchController = null;
        let busy = false;
        // Closed (Cancel, Escape, backdrop or Back) while an add was running: its history entry is gone already.
        let closed = false;

        const modal = JE.jellyseerrModal.create({
            title: JE.t(linkMode ? 'listPlaceholders_link_title' : 'listPlaceholders_add_title'),
            subtitle: linkMode ? options.placeholder.title : (ctrl.listName || ''),
            bodyHtml: `<div class="je-lp-add">${tabs}${searchPane}${customPane}${position}</div>`,
            buttonText: JE.t(linkMode ? 'listPlaceholders_link_button' : 'listPlaceholders_add_button'),
            onClose: () => {
                closed = true;
                clearTimeout(searchTimer);
                searchController?.abort();
                granularity?.destroy();
                // Two Seerr modals can't stack (each closes on any popstate and both answer Escape), so
                // the arr dialog opens after this one has gone, once modal.js has finished closing it.
                if (pendingArr) {
                    const candidate = pendingArr;
                    pendingArr = null;
                    setTimeout(() => arr.openAddDialog(candidate), 0);
                }
            },
            onSave: async (modalEl, button) => {
                if (busy) return;
                const customTab = modalEl.querySelector('[data-pane="custom"]');
                const isCustom = customTab && !customTab.hidden;
                let dto;
                let title;
                if (isCustom) {
                    const read = readCustom(modalEl);
                    if (read.error) { JE.toast(esc(read.error), 3000); return; }
                    dto = read.dto;
                    title = dto.title;
                } else {
                    if (!selected) { JE.toast(esc(JE.t('listPlaceholders_pick_result')), 3000); return; }
                    const selection = granularity ? granularity.getSelection() : undefined;
                    dto = lp.granularity.toPlaceholder(selected, selection, granularity ? granularity.getDetails() : null);
                    if (!dto) { JE.toast(esc(JE.t('listPlaceholders_pick_episode')), 3000); return; }
                    if (selected.imdbId) dto.imdbId = selected.imdbId;
                    title = dto.title;
                }
                busy = true;
                button.disabled = true;
                try {
                    if (linkMode) {
                        // The answer (published to the page) already has the linked title's library
                        // items in the list when it is there: the page reloads its rows/cards from it.
                        const ph = options.placeholder;
                        const linked = await lp.actions.withRev(ctrl, view => lp.api.patchPlaceholder(ctrl.listId, ph.id, { rev: view.rev, link: dto }),
                            view => view.placeholders.some(p => p.id === ph.id));
                        const inLibrary = linkedIntoLibrary(linked, ph.id);
                        JE.toast(JE.t(inLibrary ? 'listPlaceholders_linked_in_library' : 'listPlaceholders_linked', { title: esc(title) }), inLibrary ? 4000 : 3000);
                    } else {
                        const value = modalEl.querySelector('.je-lp-position-select')?.value || 'end';
                        const pos = value === 'start' ? { atStart: true } : value === 'end' ? undefined : { afterToken: value };
                        const result = await lp.api.addPlaceholders(ctrl.listId, [dto], pos);
                        reportAdd(result, title);
                        if (result?.addedAsItems?.length) ctrl.afterRealItemsAdded?.();
                    }
                    // Same exit path as Cancel; a modal the user already closed must not go back again (leaves the page).
                    if (!closed) history.back();
                } catch (error) {
                    lp.toastError(error);
                    busy = false;
                    button.disabled = false;
                }
            }
        });

        const root = modal.modalElement;
        const resultsEl = root.querySelector('.je-lp-results');
        const selectedEl = root.querySelector('.je-lp-selected');

        /**
         * Seerr search into `target`.
         * @param {string} query
         * @param {AbortController} controller
         * @param {HTMLElement} target
         */
        async function runSeerrSearch(query, controller, target) {
            target.innerHTML = `<div class="je-lp-muted">${esc(JE.t('listPlaceholders_loading'))}</div>`;
            try {
                const data = await JE.jellyseerrAPI.search(query, 1, { signal: controller.signal, throwOnError: true });
                if (controller.signal.aborted) return;
                results = usableResults(data?.results);
                target.innerHTML = resultsHtml(results);
            } catch (error) {
                if (error?.name === 'AbortError' || controller.signal.aborted) return;
                target.innerHTML = `<div class="je-lp-muted">${esc(JE.t('listPlaceholders_search_failed'))}</div>`;
            }
        }

        /**
         * Radarr/Sonarr lookup into `target` (admins; shown as its own group).
         * @param {string} query
         * @param {AbortController} controller
         * @param {HTMLElement} target
         */
        async function runArrSearch(query, controller, target) {
            target.innerHTML = `<div class="je-lp-muted">${esc(JE.t('listPlaceholders_loading'))}</div>`;
            try {
                const candidates = await arr.searchCandidates(query, { signal: controller.signal });
                if (controller.signal.aborted) return;
                arrResults = mixArrResults(candidates);
                target.innerHTML = arrResultsHtml(arrResults);
            } catch (error) {
                if (error?.name === 'AbortError' || controller.signal.aborted) return;
                target.innerHTML = `<div class="je-lp-muted">${esc(JE.t('listPlaceholders_search_failed'))}</div>`;
            }
        }

        /** Runs the Seerr search (and the admin Radarr/Sonarr lookup) for the current query. */
        async function runSearch() {
            const query = root.querySelector('.je-lp-query').value.trim();
            searchController?.abort();
            if (query.length < 2) {
                resultsEl.innerHTML = '';
                return;
            }
            const controller = new AbortController();
            searchController = controller;
            if (!arrOn) {
                await runSeerrSearch(query, controller, resultsEl);
                return;
            }
            resultsEl.innerHTML = (seerrOn ? '<div class="je-lp-results-group" data-group="seerr"></div>' : '')
                + `<div class="je-lp-results-group" data-group="arr" role="group" aria-label="${esc(JE.t('listPlaceholders_arr_results_heading'))}">`
                + `<div class="je-lp-results-heading">${esc(JE.t('listPlaceholders_arr_results_heading'))}</div><div class="je-lp-results-body"></div></div>`;
            arrResults = [];
            await Promise.all([
                seerrOn ? runSeerrSearch(query, controller, resultsEl.querySelector('[data-group="seerr"]')) : null,
                runArrSearch(query, controller, resultsEl.querySelector('[data-group="arr"] .je-lp-results-body'))
            ]);
        }

        /**
         * Selects a search result (TV results get the granularity picker, which needs Seerr).
         * @param {Object|null} media - Seerr result (or arrMedia() of an arr candidate).
         * @param {HTMLElement} row - Its row.
         */
        function choose(media, row) {
            selected = media || null;
            resultsEl.querySelectorAll('.je-lp-result').forEach((el) => {
                el.classList.toggle('je-lp-result-selected', el === row);
                el.setAttribute('aria-selected', el === row ? 'true' : 'false');
            });
            granularity?.destroy();
            granularity = null;
            selectedEl.innerHTML = '';
            selectedEl.hidden = !selected;
            if (!selected) return;
            const heading = document.createElement('div');
            heading.className = 'je-lp-selected-title';
            heading.textContent = JE.t('listPlaceholders_selected', { title: selected.title || selected.name || '' });
            selectedEl.appendChild(heading);
            if (selected.mediaType === 'tv' && seerrOn) {
                granularity = lp.granularity.create({ tmdbId: Number(selected.id) });
                selectedEl.appendChild(granularity.element);
            } else if (selected.mediaType === 'tv') {
                const note = document.createElement('div');
                note.className = 'je-lp-muted';
                note.textContent = JE.t('listPlaceholders_arr_series_only');
                selectedEl.appendChild(note);
            }
        }

        /**
         * Picks an arr lookup result: as a placeholder when it has a TMDB id, else the custom
         * entry form prefilled with its title, year and type.
         * @param {number} index
         * @param {HTMLElement} row
         */
        function chooseArr(index, row) {
            const candidate = arrResults[index];
            if (!candidate) return;
            const media = arrMedia(candidate);
            if (media) {
                choose(media, row);
                return;
            }
            root.querySelector('.je-lp-custom-title').value = String(candidate.title || '').slice(0, 200);
            root.querySelector('.je-lp-custom-year').value = Number(candidate.year) > 0 ? String(candidate.year) : '';
            root.querySelector('.je-lp-custom-type').value = candidate.mediaType === 'tv' ? 'tv' : 'movie';
            root.querySelector('.je-lp-tab[data-tab="custom"]')?.click();
        }

        /**
         * "Add to Radarr/Sonarr" on an arr result: closes this modal first (same exit path as
         * Cancel), then onClose opens the arr dialog.
         * @param {number} index
         */
        function addToArr(index) {
            const candidate = arrResults[index];
            if (!candidate || busy || pendingArr) return;
            pendingArr = candidate;
            history.back();
        }

        root.querySelector('.je-lp-query')?.addEventListener('input', () => {
            clearTimeout(searchTimer);
            // A lookup still running for the previous text must never render under the new text.
            searchController?.abort();
            searchController = null;
            searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
        });
        root.querySelector('.je-lp-query')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                clearTimeout(searchTimer);
                runSearch();
            }
        });
        resultsEl?.addEventListener('click', (e) => {
            const arrAdd = e.target.closest('.je-lp-arr-result-add');
            if (arrAdd) {
                addToArr(Number(arrAdd.dataset.arrIndex));
                return;
            }
            const row = e.target.closest('.je-lp-result');
            if (!row) return;
            if (row.dataset.arrIndex !== undefined) chooseArr(Number(row.dataset.arrIndex), row);
            else choose(results[Number(row.dataset.index)], row);
        });
        root.querySelector('.je-lp-tabs')?.addEventListener('click', (e) => {
            const tab = e.target.closest('.je-lp-tab');
            if (!tab) return;
            root.querySelectorAll('.je-lp-tab').forEach(t => {
                const active = t === tab;
                t.classList.toggle('je-lp-tab-active', active);
                t.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            root.querySelectorAll('.je-lp-pane').forEach(p => { p.hidden = p.dataset.pane !== tab.dataset.tab; });
        });

        modal.show();
        const query = root.querySelector('.je-lp-query');
        if (linkMode && query && options.placeholder?.title) {
            // Start from the custom entry's own title.
            query.value = String(options.placeholder.title).slice(0, 200);
            runSearch();
        }
        setTimeout(() => root.querySelector(searchOn ? '.je-lp-query' : '.je-lp-custom-title')?.focus(), 50);
        return modal;
    }

    /**
     * Editor toolbar of a list page ("Add title"; listplaceholders-source.js adds "Import list" and the source chip).
     * @param {Object} ctrl - Page controller.
     * @returns {HTMLElement}
     */
    function createToolbar(ctrl) {
        lp.ensureStyles?.();
        const bar = document.createElement('div');
        bar.className = 'je-lp-toolbar';
        if (ctrl.listKind === 'playlist') bar.classList.add('padded-right');
        const label = document.createElement('span');
        label.className = 'je-lp-toolbar-label';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'je-lp-toolbar-btn';
        const icon = document.createElement('span');
        icon.className = 'material-icons';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = 'add';
        const text = document.createElement('span');
        text.textContent = JE.t('listPlaceholders_add_title');
        button.append(icon, text);
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            open(ctrl);
        });
        bar.append(label, button);
        bar.__jeLpCtrl = ctrl;
        lp.sourceUi?.decorateToolbar(bar, ctrl);
        return bar;
    }

    /**
     * Shows "Auto-request: next N" in the toolbar while list auto-requests are on (server setting, needs Seerr) and the
     * list has placeholders; removes it otherwise.
     * @param {HTMLElement} bar - Toolbar.
     * @param {number} count - Placeholders in the list.
     */
    function updateAutoRequestHint(bar, count) {
        const config = JE.pluginConfig || {};
        const on = config.ListPlaceholdersAutoRequestEnabled === true && config.JellyseerrEnabled === true && count > 0;
        let hint = bar.querySelector('.je-lp-toolbar-auto');
        if (!on) {
            hint?.remove();
            return;
        }
        const next = Math.min(10, Math.max(1, parseInt(config.ListPlaceholdersAutoRequestCount, 10) || 1));
        if (!hint) {
            hint = document.createElement('span');
            hint.className = 'je-lp-toolbar-auto';
            bar.querySelector('.je-lp-toolbar-label')?.after(hint);
        }
        hint.textContent = JE.t('listPlaceholders_auto_request_hint', { count: next });
        hint.title = JE.t('listPlaceholders_auto_request_hint_tip', { count: next });
    }

    /**
     * Updates the toolbar's "n not in your library" label.
     * @param {HTMLElement} bar
     * @param {number} count - Count for the label (0 hides it).
     * @param {number} [listed=count] - Placeholders in the list (auto-request hint), when the label is hidden.
     */
    function updateToolbar(bar, count, listed = count) {
        updateAutoRequestHint(bar, listed);
        const label = bar.querySelector('.je-lp-toolbar-label');
        if (label) label.textContent = count > 0 ? JE.t('listPlaceholders_count', { count }) : '';
        if (bar.__jeLpCtrl) lp.sourceUi?.decorateToolbar(bar, bar.__jeLpCtrl);
    }

    lp.search = { open, readCustom, usableResults, resultsHtml, arrMedia, arrResultsHtml, mixArrResults, reportAdd, linkedIntoLibrary };
    lp.toolbar = { create: createToolbar, update: updateToolbar };

})(window.JellyfinEnhanced);
