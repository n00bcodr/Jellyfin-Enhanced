/**
 * @file Per-user hidden content feature for Jellyfin Enhanced.
 * Allows users to hide specific movies/series from all rendering surfaces.
 * Hidden state is stored server-side per-user via hidden-content.json.
 */
(function (JE) {
    'use strict';

    // --- State ---
    const hiddenIdSet = new Set();
    const hiddenTmdbIdSet = new Set();
    const parentSeriesCache = new Map();
    let hiddenData = null;
    let saveTimeout = null;

    const SAVE_DEBOUNCE_MS = 500;
    const UNDO_TOAST_DURATION = 8000;

    // --- Internal helpers ---

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function getHiddenData() {
        if (!hiddenData) {
            hiddenData = JE.userConfig?.hiddenContent || { items: {}, settings: {} };
        }
        return hiddenData;
    }

    function getSettings() {
        const data = getHiddenData();
        return {
            enabled: true,
            filterLibrary: true,
            filterDiscovery: true,
            filterUpcoming: true,
            filterCalendar: true,
            filterSearch: true,
            filterRecommendations: true,
            filterRequests: true,
            ...data.settings
        };
    }

    function rebuildSets() {
        hiddenIdSet.clear();
        hiddenTmdbIdSet.clear();
        const data = getHiddenData();
        const items = data.items || {};
        for (const key of Object.keys(items)) {
            const item = items[key];
            if (item.itemId) hiddenIdSet.add(item.itemId);
            if (item.tmdbId) hiddenTmdbIdSet.add(String(item.tmdbId));
        }
    }

    function debouncedSave() {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
            saveTimeout = null;
            const data = getHiddenData();
            JE.saveUserSettings('hidden-content.json', data);
        }, SAVE_DEBOUNCE_MS);
    }

    function shouldFilterSurface(surface) {
        const settings = getSettings();
        if (!settings.enabled) return false;
        switch (surface) {
            case 'library': return settings.filterLibrary;
            case 'discovery': return settings.filterDiscovery;
            case 'search': return settings.filterSearch;
            case 'upcoming': return settings.filterUpcoming;
            case 'calendar': return settings.filterCalendar;
            case 'recommendations': return settings.filterRecommendations;
            case 'requests': return settings.filterRequests;
            default: return true;
        }
    }

    async function isParentSeriesHidden(itemId) {
        if (parentSeriesCache.has(itemId)) {
            const seriesId = parentSeriesCache.get(itemId);
            return seriesId ? hiddenIdSet.has(seriesId) : false;
        }
        try {
            const userId = ApiClient.getCurrentUserId();
            const item = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/Users/${userId}/Items/${itemId}`, { Fields: 'SeriesId' }),
                dataType: 'json'
            });
            const seriesId = item?.SeriesId || null;
            parentSeriesCache.set(itemId, seriesId);
            return seriesId ? hiddenIdSet.has(seriesId) : false;
        } catch (e) {
            parentSeriesCache.set(itemId, null);
            return false;
        }
    }

    // --- CSS injection ---

    function injectCSS() {
        if (!JE.helpers?.addCSS) return;
        JE.helpers.addCSS('je-hidden-content', `
            .je-hide-btn {
                position: absolute;
                top: 6px;
                right: 6px;
                z-index: 10;
                width: 28px;
                height: 28px;
                border-radius: 50%;
                background: rgba(0,0,0,0.7);
                border: 1px solid rgba(255,255,255,0.2);
                color: #fff;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                opacity: 0;
                transition: opacity 0.2s ease, background 0.2s ease;
                padding: 0;
                font-size: 16px;
                line-height: 1;
            }
            .je-hide-btn .material-icons {
                font-size: 16px;
            }
            .cardBox:hover .je-hide-btn,
            .je-hide-btn:focus {
                opacity: 1;
            }
            .je-hide-btn:hover {
                background: rgba(220, 50, 50, 0.85);
                border-color: rgba(255,255,255,0.4);
            }
            .je-hide-btn.je-already-hidden {
                opacity: 0;
                background: rgba(80,80,80,0.85);
                border-color: rgba(255,255,255,0.15);
                cursor: default;
                pointer-events: none;
                font-size: 10px;
                width: auto;
                border-radius: 4px;
                padding: 2px 8px;
                height: auto;
            }
            .cardBox:hover .je-hide-btn.je-already-hidden {
                opacity: 0.85;
            }
            .je-hide-btn.je-already-hidden:hover {
                background: rgba(80,80,80,0.85);
                border-color: rgba(255,255,255,0.15);
            }
            .je-detail-hide-btn.je-already-hidden {
                opacity: 0.5;
                pointer-events: none;
            }

            .je-undo-toast {
                position: fixed;
                bottom: 20px;
                right: 20px;
                background: linear-gradient(135deg, rgba(0,0,0,0.92), rgba(40,40,40,0.92));
                color: #fff;
                padding: 12px 16px;
                border-radius: 8px;
                z-index: 99999;
                font-size: 14px;
                font-weight: 500;
                box-shadow: 0 4px 20px rgba(0,0,0,0.4);
                backdrop-filter: blur(20px);
                border: 1px solid rgba(255,255,255,0.1);
                display: flex;
                align-items: center;
                gap: 12px;
                transform: translateX(100%);
                transition: transform 0.3s ease-out;
                max-width: 380px;
            }
            .je-undo-toast.je-visible {
                transform: translateX(0);
            }
            .je-undo-toast-text {
                flex: 1;
            }
            .je-undo-btn {
                background: rgba(255,255,255,0.15);
                border: 1px solid rgba(255,255,255,0.25);
                color: #fff;
                padding: 4px 12px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 600;
                white-space: nowrap;
                transition: background 0.2s ease;
            }
            .je-undo-btn:hover {
                background: rgba(255,255,255,0.25);
            }

            .je-hidden-management-overlay {
                position: fixed;
                inset: 0;
                z-index: 100000;
                background: rgba(0,0,0,0.85);
                backdrop-filter: blur(10px);
                display: flex;
                flex-direction: column;
                align-items: center;
                padding: 40px 20px;
                overflow-y: auto;
            }
            .je-hidden-management-panel {
                width: 100%;
                max-width: 900px;
                background: linear-gradient(135deg, rgba(30,30,35,0.98), rgba(20,20,25,0.98));
                border-radius: 12px;
                border: 1px solid rgba(255,255,255,0.1);
                overflow: hidden;
            }
            .je-hidden-management-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 20px 24px;
                border-bottom: 1px solid rgba(255,255,255,0.1);
            }
            .je-hidden-management-header h2 {
                margin: 0;
                font-size: 20px;
                font-weight: 600;
                color: #fff;
            }
            .je-hidden-management-close {
                background: rgba(255,255,255,0.1);
                border: 1px solid rgba(255,255,255,0.15);
                color: #fff;
                width: 32px;
                height: 32px;
                border-radius: 50%;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 18px;
                transition: background 0.2s ease;
            }
            .je-hidden-management-close:hover {
                background: rgba(255,80,80,0.4);
            }
            .je-hidden-management-toolbar {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 16px 24px;
                border-bottom: 1px solid rgba(255,255,255,0.06);
            }
            .je-hidden-management-search {
                flex: 1;
                background: rgba(255,255,255,0.08);
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 6px;
                color: #fff;
                padding: 8px 12px;
                font-size: 14px;
                outline: none;
            }
            .je-hidden-management-search::placeholder {
                color: rgba(255,255,255,0.4);
            }
            .je-hidden-management-search:focus {
                border-color: rgba(255,255,255,0.3);
            }
            .je-hidden-management-unhide-all {
                background: rgba(220,50,50,0.3);
                border: 1px solid rgba(220,50,50,0.5);
                color: #fff;
                padding: 8px 16px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 500;
                white-space: nowrap;
                transition: background 0.2s ease;
            }
            .je-hidden-management-unhide-all:hover {
                background: rgba(220,50,50,0.5);
            }
            .je-hidden-management-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
                gap: 16px;
                padding: 24px;
            }
            .je-hidden-management-empty {
                text-align: center;
                padding: 60px 24px;
                color: rgba(255,255,255,0.4);
                font-size: 15px;
            }
            .je-hidden-item-card {
                background: rgba(255,255,255,0.05);
                border-radius: 8px;
                overflow: hidden;
                border: 1px solid rgba(255,255,255,0.08);
                transition: border-color 0.2s ease, transform 0.2s ease;
            }
            .je-hidden-item-card:hover {
                border-color: rgba(255,255,255,0.2);
            }
            .je-hidden-item-poster-link {
                display: block;
                cursor: pointer;
                text-decoration: none;
            }
            .je-hidden-item-poster {
                width: 100%;
                aspect-ratio: 2/3;
                object-fit: cover;
                background: rgba(255,255,255,0.05);
                display: block;
                transition: opacity 0.2s ease;
            }
            .je-hidden-item-poster-link:hover .je-hidden-item-poster {
                opacity: 0.8;
            }
            .je-hidden-item-info {
                padding: 10px;
            }
            .je-hidden-item-name {
                font-size: 13px;
                font-weight: 500;
                color: #fff;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                margin-bottom: 4px;
                text-decoration: none;
                display: block;
            }
            .je-hidden-item-name:hover {
                text-decoration: underline;
                color: #fff;
            }
            .je-hidden-item-meta {
                font-size: 11px;
                color: rgba(255,255,255,0.4);
                margin-bottom: 8px;
            }
            .je-hidden-item-unhide {
                width: 100%;
                background: rgba(255,255,255,0.1);
                border: 1px solid rgba(255,255,255,0.15);
                color: #fff;
                padding: 6px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 500;
                transition: background 0.2s ease;
            }
            .je-hidden-item-unhide:hover {
                background: rgba(100,200,100,0.3);
                border-color: rgba(100,200,100,0.5);
            }
            .je-hidden-item-removing {
                animation: je-hidden-fadeout 0.3s ease forwards;
            }
            @keyframes je-hidden-fadeout {
                to { opacity: 0; transform: scale(0.9); }
            }
        `);
    }

    // --- Undo toast ---

    function showUndoToast(itemName, itemId) {
        // Remove any existing undo toast
        document.querySelectorAll('.je-undo-toast').forEach(el => el.remove());

        const toast = document.createElement('div');
        toast.className = 'je-undo-toast';

        const textSpan = document.createElement('span');
        textSpan.className = 'je-undo-toast-text';
        textSpan.textContent = JE.t('hidden_content_item_hidden', { name: itemName });
        toast.appendChild(textSpan);

        const undoBtn = document.createElement('button');
        undoBtn.className = 'je-undo-btn';
        undoBtn.textContent = JE.t('hidden_content_undo');
        undoBtn.addEventListener('click', () => {
            unhideItem(itemId);
            toast.classList.remove('je-visible');
            setTimeout(() => toast.remove(), 300);
        });
        toast.appendChild(undoBtn);

        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('je-visible'));

        setTimeout(() => {
            if (toast.parentNode) {
                toast.classList.remove('je-visible');
                setTimeout(() => toast.remove(), 300);
            }
        }, UNDO_TOAST_DURATION);
    }

    // --- Management panel ---

    function createManagementHeader(count) {
        const header = document.createElement('div');
        header.className = 'je-hidden-management-header';
        const h2 = document.createElement('h2');
        h2.textContent = `${JE.t('hidden_content_manage_title')} (${count})`;
        header.appendChild(h2);
        const closeBtn = document.createElement('button');
        closeBtn.className = 'je-hidden-management-close';
        closeBtn.textContent = '\u00D7';
        header.appendChild(closeBtn);
        return header;
    }

    function createItemCard(item) {
        const card = document.createElement('div');
        card.className = 'je-hidden-item-card';
        card.dataset.itemId = item.itemId;

        // Clickable poster area that navigates to item detail
        const posterLink = document.createElement('a');
        posterLink.className = 'je-hidden-item-poster-link';
        if (item.itemId) {
            posterLink.href = `#/details?id=${item.itemId}`;
        }

        if (item.posterPath) {
            const img = document.createElement('img');
            img.className = 'je-hidden-item-poster';
            img.src = `https://image.tmdb.org/t/p/w300${item.posterPath}`;
            img.alt = '';
            img.loading = 'lazy';
            posterLink.appendChild(img);
        } else if (item.itemId) {
            // Use Jellyfin primary image as fallback
            const img = document.createElement('img');
            img.className = 'je-hidden-item-poster';
            img.src = `${ApiClient.getUrl('/Items/' + item.itemId + '/Images/Primary', { maxWidth: 300 })}`;
            img.alt = '';
            img.loading = 'lazy';
            img.onerror = function() { this.style.display = 'none'; };
            posterLink.appendChild(img);
        } else {
            const placeholder = document.createElement('div');
            placeholder.className = 'je-hidden-item-poster';
            posterLink.appendChild(placeholder);
        }
        card.appendChild(posterLink);

        const info = document.createElement('div');
        info.className = 'je-hidden-item-info';

        const nameLink = document.createElement('a');
        nameLink.className = 'je-hidden-item-name';
        nameLink.title = item.name || '';
        nameLink.textContent = item.name || 'Unknown';
        if (item.itemId) {
            nameLink.href = `#/details?id=${item.itemId}`;
        }
        info.appendChild(nameLink);

        const metaDiv = document.createElement('div');
        metaDiv.className = 'je-hidden-item-meta';
        const hiddenDate = item.hiddenAt ? new Date(item.hiddenAt).toLocaleDateString() : '';
        metaDiv.textContent = [item.type, hiddenDate].filter(Boolean).join(' \u00B7 ');
        info.appendChild(metaDiv);

        const unhideBtn = document.createElement('button');
        unhideBtn.className = 'je-hidden-item-unhide';
        unhideBtn.textContent = JE.t('hidden_content_unhide');
        info.appendChild(unhideBtn);

        card.appendChild(info);
        return card;
    }

    function showManagementPanel() {
        // Remove existing panel
        document.querySelector('.je-hidden-management-overlay')?.remove();

        const data = getHiddenData();
        const items = Object.values(data.items || {});

        const overlay = document.createElement('div');
        overlay.className = 'je-hidden-management-overlay';

        const panel = document.createElement('div');
        panel.className = 'je-hidden-management-panel';

        // Header
        const header = createManagementHeader(items.length);
        header.querySelector('.je-hidden-management-close').addEventListener('click', () => overlay.remove());
        panel.appendChild(header);

        // Toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'je-hidden-management-toolbar';

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'je-hidden-management-search';
        searchInput.placeholder = JE.t('hidden_content_manage_search') || 'Search hidden items...';
        toolbar.appendChild(searchInput);

        const unhideAllBtn = document.createElement('button');
        unhideAllBtn.className = 'je-hidden-management-unhide-all';
        unhideAllBtn.textContent = JE.t('hidden_content_clear_all');
        toolbar.appendChild(unhideAllBtn);

        panel.appendChild(toolbar);

        // Grid container
        const gridContainer = document.createElement('div');
        panel.appendChild(gridContainer);

        function renderGrid(filter) {
            const filtered = filter
                ? items.filter(i => i.name?.toLowerCase().includes(filter.toLowerCase()))
                : items;

            // Sort by hiddenAt descending (most recent first)
            filtered.sort((a, b) => {
                const da = a.hiddenAt ? new Date(a.hiddenAt).getTime() : 0;
                const db = b.hiddenAt ? new Date(b.hiddenAt).getTime() : 0;
                return db - da;
            });

            if (filtered.length === 0) {
                const emptyDiv = document.createElement('div');
                emptyDiv.className = 'je-hidden-management-empty';
                emptyDiv.textContent = JE.t('hidden_content_manage_empty');
                gridContainer.replaceChildren(emptyDiv);
                return;
            }

            const grid = document.createElement('div');
            grid.className = 'je-hidden-management-grid';

            for (const item of filtered) {
                const card = createItemCard(item);

                // Clicking poster or name navigates to item detail and closes panel
                card.querySelectorAll('.je-hidden-item-poster-link, a.je-hidden-item-name').forEach(link => {
                    link.addEventListener('click', () => {
                        overlay.remove();
                    });
                });

                card.querySelector('.je-hidden-item-unhide').addEventListener('click', () => {
                    card.classList.add('je-hidden-item-removing');
                    setTimeout(() => {
                        unhideItem(item.itemId);
                        card.remove();
                        // Update header count
                        const remaining = gridContainer.querySelectorAll('.je-hidden-item-card').length;
                        header.querySelector('h2').textContent = `${JE.t('hidden_content_manage_title')} (${remaining})`;
                        if (remaining === 0) {
                            const emptyDiv = document.createElement('div');
                            emptyDiv.className = 'je-hidden-management-empty';
                            emptyDiv.textContent = JE.t('hidden_content_manage_empty');
                            gridContainer.replaceChildren(emptyDiv);
                        }
                    }, 300);
                });

                grid.appendChild(card);
            }

            gridContainer.replaceChildren(grid);
        }

        renderGrid();

        searchInput.addEventListener('input', () => renderGrid(searchInput.value));

        unhideAllBtn.addEventListener('click', () => {
            if (!confirm(JE.t('hidden_content_clear_confirm'))) return;
            const data = getHiddenData();
            hiddenData = { ...data, items: {} };
            JE.userConfig.hiddenContent = hiddenData;
            rebuildSets();
            debouncedSave();
            emitChange();
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'je-hidden-management-empty';
            emptyDiv.textContent = JE.t('hidden_content_manage_empty');
            gridContainer.replaceChildren(emptyDiv);
            header.querySelector('h2').textContent = `${JE.t('hidden_content_manage_title')} (0)`;
        });

        overlay.appendChild(panel);

        // Close on overlay background click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        // Close on Escape
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                overlay.remove();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);

        document.body.appendChild(overlay);
    }

    // --- Native card filtering ---

    var PROCESSED_ATTR = 'jeHiddenChecked';

    function getCardItemId(el) {
        if (el.dataset && el.dataset.id) return el.dataset.id;
        if (el.dataset && el.dataset.itemid) return el.dataset.itemid;
        return null;
    }

    function getCurrentNativeSurface() {
        var hash = window.location.hash || '';
        if (hash.indexOf('/search') !== -1) return 'search';
        return 'library';
    }

    function filterNativeCards() {
        if (!shouldFilterSurface(getCurrentNativeSurface())) return;
        var settings = getSettings();
        if (!settings.enabled) return;
        if (hiddenIdSet.size === 0) return;

        var cards = document.querySelectorAll('.card[data-id]:not([data-je-hidden-checked]), .card[data-itemid]:not([data-je-hidden-checked])');
        for (var i = 0; i < cards.length; i++) {
            var card = cards[i];
            var itemId = getCardItemId(card);
            card.setAttribute('data-je-hidden-checked', '1');
            if (!itemId) continue;

            if (hiddenIdSet.has(itemId)) {
                card.style.display = 'none';
            }
        }
    }

    function filterAllNativeCards() {
        if (!shouldFilterSurface(getCurrentNativeSurface())) return;
        var settings = getSettings();
        if (!settings.enabled) return;

        var cards = document.querySelectorAll('.card[data-id], .card[data-itemid]');
        for (var i = 0; i < cards.length; i++) {
            var card = cards[i];
            var itemId = getCardItemId(card);
            card.setAttribute('data-je-hidden-checked', '1');
            if (!itemId) continue;

            if (hiddenIdSet.has(itemId)) {
                card.style.display = 'none';
            } else if (card.style.display === 'none') {
                card.style.display = '';
            }
        }
    }

    var debouncedFilterNative = JE.helpers?.debounce
        ? JE.helpers.debounce(function() { requestAnimationFrame(filterNativeCards); }, 300)
        : filterNativeCards;

    function setupNativeObserver() {
        // Use onViewPage for page navigation — much cheaper than a body MutationObserver
        if (JE.helpers?.onViewPage) {
            JE.helpers.onViewPage(function() {
                if (!getSettings().enabled) return;
                if (hiddenIdSet.size === 0) return;
                setTimeout(filterAllNativeCards, 300);
            });
        }

        // Lightweight observer only for card containers, not the entire body
        if (typeof MutationObserver !== 'undefined') {
            var observer = new MutationObserver(function(mutations) {
                if (!getSettings().enabled || hiddenIdSet.size === 0) return;
                var hasNewCards = false;
                for (var i = 0; i < mutations.length; i++) {
                    var added = mutations[i].addedNodes;
                    for (var j = 0; j < added.length; j++) {
                        var node = added[j];
                        if (node.nodeType === 1 && (node.classList?.contains('card') || node.querySelector?.('.card[data-id]'))) {
                            hasNewCards = true;
                            break;
                        }
                    }
                    if (hasNewCards) break;
                }
                if (hasNewCards) debouncedFilterNative();
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }

    // --- Event emission ---

    function emitChange() {
        try {
            window.dispatchEvent(new CustomEvent('je-hidden-content-changed'));
        } catch (e) { /* ignore */ }
    }

    // --- Public API ---

    function isHidden(jellyfinItemId) {
        if (!jellyfinItemId) return false;
        const settings = getSettings();
        if (!settings.enabled) return false;
        return hiddenIdSet.has(jellyfinItemId);
    }

    function isHiddenByTmdbId(tmdbId) {
        if (!tmdbId) return false;
        const settings = getSettings();
        if (!settings.enabled) return false;
        return hiddenTmdbIdSet.has(String(tmdbId));
    }

    function hideItem({ itemId, name, type, tmdbId, posterPath }) {
        const data = getHiddenData();
        const key = itemId || `tmdb-${tmdbId}`;
        const newItem = {
            itemId: itemId || '',
            name: name || '',
            type: type || '',
            tmdbId: tmdbId ? String(tmdbId) : '',
            hiddenAt: new Date().toISOString(),
            posterPath: posterPath || ''
        };

        hiddenData = {
            ...data,
            items: { ...data.items, [key]: newItem }
        };
        JE.userConfig.hiddenContent = hiddenData;
        rebuildSets();
        debouncedSave();
        emitChange();
        showUndoToast(name || 'Item', key);
    }

    function unhideItem(itemId) {
        const data = getHiddenData();
        const newItems = { ...data.items };
        delete newItems[itemId];

        hiddenData = { ...data, items: newItems };
        JE.userConfig.hiddenContent = hiddenData;
        rebuildSets();
        debouncedSave();
        emitChange();

        // Re-show unhidden native cards and reset processed flags
        document.querySelectorAll('.card[data-id], .card[data-itemid]').forEach(function(card) {
            card.removeAttribute('data-je-hidden-checked');
            var cardId = getCardItemId(card);
            if (cardId === itemId && card.style.display === 'none') {
                card.style.display = '';
            }
        });
    }

    function updateSettings(partial) {
        const data = getHiddenData();
        hiddenData = {
            ...data,
            settings: { ...data.settings, ...partial }
        };
        JE.userConfig.hiddenContent = hiddenData;
        debouncedSave();
        emitChange();
    }

    function getAllHiddenItems() {
        const data = getHiddenData();
        return Object.values(data.items || {});
    }

    function getHiddenCount() {
        const data = getHiddenData();
        return Object.keys(data.items || {}).length;
    }

    function filterJellyseerrResults(results, surface) {
        if (!shouldFilterSurface(surface)) return results;
        if (!Array.isArray(results)) return results;
        return results.filter(item => {
            const tmdbId = item.id || item.tmdbId;
            return !hiddenTmdbIdSet.has(String(tmdbId));
        });
    }

    function filterCalendarEvents(events) {
        if (!shouldFilterSurface('calendar')) return events;
        if (!Array.isArray(events)) return events;
        return events.filter(event => {
            if (event.tmdbId && hiddenTmdbIdSet.has(String(event.tmdbId))) return false;
            if (event.itemId && hiddenIdSet.has(event.itemId)) return false;
            return true;
        });
    }

    function filterRequestItems(items) {
        if (!shouldFilterSurface('requests')) return items;
        if (!Array.isArray(items)) return items;
        return items.filter(item => {
            const tmdbId = item.tmdbId || item.id;
            if (tmdbId && hiddenTmdbIdSet.has(String(tmdbId))) return false;
            if (item.jellyfinMediaId && hiddenIdSet.has(item.jellyfinMediaId)) return false;
            return true;
        });
    }

    // --- Initialization ---

    JE.initializeHiddenContent = function () {
        hiddenData = JE.userConfig?.hiddenContent || { items: {}, settings: {} };
        rebuildSets();
        injectCSS();
        setupNativeObserver();

        // Initial filter of any cards already on the page
        if (hiddenIdSet.size > 0) {
            setTimeout(filterAllNativeCards, 500);
        }

        // Expose public API
        JE.hiddenContent = {
            isHidden,
            isHiddenByTmdbId,
            hideItem,
            unhideItem,
            getSettings,
            updateSettings,
            getAllHiddenItems,
            getHiddenCount,
            filterJellyseerrResults,
            filterCalendarEvents,
            filterRequestItems,
            filterNativeCards,
            showUndoToast,
            showManagementPanel
        };

        console.log(`🪼 Jellyfin Enhanced: Hidden Content initialized (${getHiddenCount()} items hidden)`);
    };

})(window.JellyfinEnhanced);
