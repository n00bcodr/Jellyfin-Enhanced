// /js/jellyseerr/listplaceholders/listplaceholders-search.js
// "Add title" modal of a playlist/collection page: Seerr search (through JE's proxy) →
// pick a result → TV granularity → playlist position → POST /items (titles already in
// the library are added as the real item, the toast says which). A "Custom entry" tab
// adds titles Seerr doesn't know. The same modal in "link" mode links a custom entry
// to a TMDB title (PATCH).
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.listPlaceholders = JE.internals.listPlaceholders || {};

    const SEARCH_DEBOUNCE_MS = 350;
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
        const positions = !linkMode && ctrl.listKind === 'playlist' && ctrl.positionOptions ? ctrl.positionOptions() : [];

        const searchPane = `
            <div class="je-lp-pane" data-pane="search"${seerrOn ? '' : ' hidden'}>
                <input type="search" class="je-lp-input je-lp-query" autocomplete="off" placeholder="${esc(JE.t('listPlaceholders_search_placeholder'))}" aria-label="${esc(JE.t('listPlaceholders_search_placeholder'))}">
                <div class="je-lp-results" role="listbox"></div>
                <div class="je-lp-selected" hidden></div>
            </div>`;
        const customPane = linkMode ? '' : `
            <div class="je-lp-pane" data-pane="custom"${seerrOn ? ' hidden' : ''}>
                <label class="je-lp-field"><span>${esc(JE.t('listPlaceholders_custom_title'))}</span><input type="text" class="je-lp-input je-lp-custom-title" maxlength="200"></label>
                <div class="je-lp-field-row">
                    <label class="je-lp-field"><span>${esc(JE.t('listPlaceholders_custom_type'))}</span>
                        <select class="je-lp-select je-lp-custom-type"><option value="movie">${esc(JE.t('listPlaceholders_kind_movie'))}</option><option value="tv">${esc(JE.t('listPlaceholders_kind_series'))}</option></select></label>
                    <label class="je-lp-field"><span>${esc(JE.t('listPlaceholders_custom_year'))}</span><input type="number" class="je-lp-input je-lp-custom-year" min="1870" max="2100" step="1"></label>
                    <label class="je-lp-field"><span>${esc(JE.t('listPlaceholders_custom_date'))}</span><input type="date" class="je-lp-input je-lp-custom-date"></label>
                </div>
                <label class="je-lp-field"><span>${esc(JE.t('listPlaceholders_custom_note'))}</span><input type="text" class="je-lp-input je-lp-custom-note" maxlength="300"></label>
            </div>`;
        const tabs = linkMode || !seerrOn ? '' : `
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
        let searchTimer = null;
        let searchController = null;
        let busy = false;

        const modal = JE.jellyseerrModal.create({
            title: JE.t(linkMode ? 'listPlaceholders_link_title' : 'listPlaceholders_add_title'),
            subtitle: linkMode ? options.placeholder.title : (ctrl.listName || ''),
            bodyHtml: `<div class="je-lp-add">${tabs}${searchPane}${customPane}${position}</div>`,
            buttonText: JE.t(linkMode ? 'listPlaceholders_link_button' : 'listPlaceholders_add_button'),
            onClose: () => {
                clearTimeout(searchTimer);
                searchController?.abort();
                granularity?.destroy();
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
                    history.back();
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

        /** Runs the Seerr search for the current query. */
        async function runSearch() {
            const query = root.querySelector('.je-lp-query').value.trim();
            searchController?.abort();
            if (query.length < 2) {
                resultsEl.innerHTML = '';
                return;
            }
            const controller = new AbortController();
            searchController = controller;
            resultsEl.innerHTML = `<div class="je-lp-muted">${esc(JE.t('listPlaceholders_loading'))}</div>`;
            try {
                const data = await JE.jellyseerrAPI.search(query, 1, { signal: controller.signal, throwOnError: true });
                if (controller.signal.aborted) return;
                results = usableResults(data?.results);
                resultsEl.innerHTML = resultsHtml(results);
            } catch (error) {
                if (error?.name === 'AbortError' || controller.signal.aborted) return;
                resultsEl.innerHTML = `<div class="je-lp-muted">${esc(JE.t('listPlaceholders_search_failed'))}</div>`;
            }
        }

        /**
         * Selects a search result (TV results get the granularity picker).
         * @param {number} index
         */
        function choose(index) {
            selected = results[index] || null;
            resultsEl.querySelectorAll('.je-lp-result').forEach((el, i) => {
                el.classList.toggle('je-lp-result-selected', i === index);
                el.setAttribute('aria-selected', i === index ? 'true' : 'false');
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
            if (selected.mediaType === 'tv') {
                granularity = lp.granularity.create({ tmdbId: Number(selected.id) });
                selectedEl.appendChild(granularity.element);
            }
        }

        root.querySelector('.je-lp-query')?.addEventListener('input', () => {
            clearTimeout(searchTimer);
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
            const row = e.target.closest('.je-lp-result');
            if (row) choose(Number(row.dataset.index));
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
        setTimeout(() => root.querySelector(seerrOn ? '.je-lp-query' : '.je-lp-custom-title')?.focus(), 50);
        return modal;
    }

    /**
     * Editor toolbar of a list page ("Add title"; later phases add Import).
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
        return bar;
    }

    /**
     * Updates the toolbar's "n not in your library" label.
     * @param {HTMLElement} bar
     * @param {number} count
     */
    function updateToolbar(bar, count) {
        const label = bar.querySelector('.je-lp-toolbar-label');
        if (label) label.textContent = count > 0 ? JE.t('listPlaceholders_count', { count }) : '';
    }

    lp.search = { open, readCustom, usableResults, resultsHtml, reportAdd, linkedIntoLibrary };
    lp.toolbar = { create: createToolbar, update: updateToolbar };

})(window.JellyfinEnhanced);
