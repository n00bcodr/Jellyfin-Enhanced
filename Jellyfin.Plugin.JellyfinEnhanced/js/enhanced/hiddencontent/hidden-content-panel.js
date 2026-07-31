/**
 * @file Hidden Content — management panel overlay (searchable grid of hidden
 * items with unhide actions) and the shared hidden-item card factory.
 * Split from hidden-content.js (code motion; bodies verbatim).
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.hiddenContent = JE.internals.hiddenContent || {};

    const { getHiddenData, unhideItem, unhideAll } = internal;

    /** Max poster width when loading images from TMDB / Jellyfin. */
    const POSTER_MAX_WIDTH = 300;

    // ============================================================
    // Management panel (overlay)
    // ============================================================

    /**
     * Creates the header bar for the management panel overlay.
     * @param {number} count Current number of hidden items.
     * @returns {HTMLElement} The header element with title and close button.
     */
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

    /**
     * Creates a card element for a single hidden item in the management panel.
     * Includes poster, name link, type/date metadata, and an Unhide button.
     * @param {Object} item Hidden item data object.
     * @param {Function} [onNavigate] Callback when the user clicks to navigate (closes the panel).
     * @returns {HTMLElement} The card element.
     */
    function createItemCard(item, onNavigate) {
        const card = document.createElement('div');
        card.className = 'je-hidden-item-card';
        card.dataset.itemId = item.itemId;

        const hasJellyfinId = !!item.itemId;
        const hasTmdbId = !!item.tmdbId;
        const mediaType = item.type === 'Series' ? 'tv' : 'movie';

        // Clickable poster area that navigates to item detail
        const posterLink = document.createElement('a');
        posterLink.className = 'je-hidden-item-poster-link';
        if (hasJellyfinId) {
            posterLink.href = `#/details?id=${item.itemId}`;
        } else if (hasTmdbId) {
            posterLink.href = '#';
            posterLink.dataset.tmdbId = item.tmdbId;
            posterLink.dataset.mediaType = mediaType;
        }

        if (item.posterPath) {
            const img = document.createElement('img');
            img.className = 'je-hidden-item-poster';
            img.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${item.posterPath}`;
            img.alt = '';
            img.loading = 'lazy';
            posterLink.appendChild(img);
        } else if (hasJellyfinId) {
            const img = document.createElement('img');
            img.className = 'je-hidden-item-poster';
            img.src = `${ApiClient.getUrl('/Items/' + item.itemId + '/Images/Primary', { maxWidth: POSTER_MAX_WIDTH })}`;
            img.alt = '';
            img.loading = 'lazy';
            img.onerror = function() {
                const self = this;
                // Switch card to Jellyseerr navigation
                if (hasTmdbId && JE.jellyseerrMoreInfo) {
                    card.dataset.jellyfinRemoved = '1';
                }
                // Item removed from Jellyfin — fall back to TMDB poster
                if (hasTmdbId && item.posterPath) {
                    self.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${item.posterPath}`;
                    self.onerror = function() { this.style.display = 'none'; };
                } else if (hasTmdbId && JE.jellyseerrAPI) {
                    // No posterPath stored — fetch it from Jellyseerr
                    self.onerror = function() { this.style.display = 'none'; };
                    const fetchFn = mediaType === 'tv'
                        ? JE.jellyseerrAPI.fetchTvShowDetails
                        : JE.jellyseerrAPI.fetchMovieDetails;
                    fetchFn(parseInt(item.tmdbId, 10)).then(function(details) {
                        const path = details && (details.posterPath || details.poster_path);
                        if (path) {
                            self.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${path}`;
                        } else {
                            self.style.display = 'none';
                        }
                    }).catch(function() { self.style.display = 'none'; });
                } else if (item.type !== 'Person' && item.name && JE.jellyseerrAPI && JE.jellyseerrMoreInfo) {
                    // No TMDB id stored and the Jellyfin media is gone — resolve via a Seerr search
                    // so the card opens the more-info modal instead of a blank poster + dead link.
                    self.style.display = 'none';
                    const wantType = (item.type === 'Series' || item.type === 'Episode' || item.type === 'Season') ? 'tv' : 'movie';
                    JE.jellyseerrAPI.search(item.name).then(function(res) {
                        const results = (res && res.results) || [];
                        const hit = results.find(function(r) { return r.mediaType === wantType; })
                            || results.find(function(r) { return r.mediaType === 'movie' || r.mediaType === 'tv'; });
                        if (hit && hit.id) {
                            card.dataset.jellyfinRemoved = '1';
                            card.dataset.resolvedTmdbId = String(hit.id);
                            card.dataset.resolvedMediaType = hit.mediaType || wantType;
                            const p = hit.posterPath || hit.poster_path;
                            if (p) {
                                self.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${p}`;
                                self.style.display = '';
                                self.onerror = function() { this.style.display = 'none'; };
                            }
                        }
                    }).catch(function() {});
                } else {
                    self.style.display = 'none';
                }
            };
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
        if (hasJellyfinId) {
            nameLink.href = `#/details?id=${item.itemId}`;
        } else if (hasTmdbId) {
            nameLink.href = '#';
            nameLink.dataset.tmdbId = item.tmdbId;
            nameLink.dataset.mediaType = mediaType;
        }
        info.appendChild(nameLink);

        // Attach navigation click handlers
        const navigableLinks = [posterLink, nameLink];
        for (const link of navigableLinks) {
            link.addEventListener('click', (e) => {
                // If item was removed from Jellyfin, fall back to the Seerr modal — using the
                // stored TMDB id, or one resolved at render time by a Seerr search.
                const removedId = (card.dataset.jellyfinRemoved === '1')
                    ? (hasTmdbId ? item.tmdbId : card.dataset.resolvedTmdbId)
                    : '';
                if (hasJellyfinId && removedId && JE.jellyseerrMoreInfo) {
                    e.preventDefault();
                    JE.jellyseerrMoreInfo.open(parseInt(removedId, 10), hasTmdbId ? mediaType : (card.dataset.resolvedMediaType || mediaType));
                    if (onNavigate) onNavigate();
                } else if (hasJellyfinId) {
                    if (onNavigate) onNavigate();
                } else if (hasTmdbId && JE.jellyseerrMoreInfo) {
                    e.preventDefault();
                    JE.jellyseerrMoreInfo.open(parseInt(item.tmdbId, 10), mediaType);
                    if (onNavigate) onNavigate();
                } else if (!hasJellyfinId) {
                    e.preventDefault();
                }
            });
        }

        const metaDiv = document.createElement('div');
        metaDiv.className = 'je-hidden-item-meta';
        const hiddenDate = item.hiddenAt ? new Date(item.hiddenAt).toLocaleDateString() : '';
        const _scope = (item.hideScope || 'global').toLowerCase();
        const _scopeText =
            _scope === 'continuewatching' ? JE.t('hidden_content_scope_cw_label') :
            _scope === 'nextup'           ? JE.t('hidden_content_scope_nextup_label') :
            _scope === 'homesections'     ? JE.t('hidden_content_scope_homesections_label') :
            '';
        metaDiv.textContent = [item.type, _scopeText, hiddenDate].filter(Boolean).join(' \u00B7 ');
        info.appendChild(metaDiv);

        const unhideBtn = document.createElement('button');
        unhideBtn.className = 'je-hidden-item-unhide';
        unhideBtn.textContent = _scope === 'continuewatching'
            ? JE.t('hidden_content_add_back_to_cw')
            : JE.t('hidden_content_unhide');
        info.appendChild(unhideBtn);

        card.appendChild(info);
        return card;
    }

    /**
     * Creates and displays the management panel overlay.
     * Shows all hidden items in a searchable grid with unhide actions.
     */
    function showManagementPanel() {
        document.querySelector('.je-hidden-management-overlay')?.remove();

        const data = getHiddenData();
        const items = Object.entries(data.items || {}).map(([key, item]) => ({ ...item, _key: key }));

        const overlay = document.createElement('div');
        overlay.className = 'je-hidden-management-overlay';

        const panel = document.createElement('div');
        panel.className = 'je-hidden-management-panel';

        const header = createManagementHeader(items.length);
        const closeOverlay = () => {
            overlay.remove();
            document.removeEventListener('keydown', escHandler);
        };
        header.querySelector('.je-hidden-management-close').addEventListener('click', closeOverlay);
        panel.appendChild(header);

        const toolbar = createManagementToolbar();
        panel.appendChild(toolbar.element);

        const gridContainer = document.createElement('div');
        panel.appendChild(gridContainer);

        /**
         * Renders the item grid, optionally filtered by search text.
         * @param {string} [filter] Search text to filter by name.
         */
        function renderGrid(filter) {
            const filtered = filter
                ? items.filter(i => i.name?.toLowerCase().includes(filter.toLowerCase()))
                : items;

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
                const card = createItemCard(item, () => overlay.remove());

                card.querySelector('.je-hidden-item-unhide').addEventListener('click', () => {
                    card.classList.add('je-hidden-item-removing');
                    setTimeout(() => {
                        unhideItem(item._key || item.itemId);
                        card.remove();
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

        toolbar.searchInput.addEventListener('input', () => renderGrid(toolbar.searchInput.value));

        toolbar.unhideAllBtn.addEventListener('click', () => {
            if (!confirm(JE.t('hidden_content_clear_confirm'))) return;
            unhideAll();
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'je-hidden-management-empty';
            emptyDiv.textContent = JE.t('hidden_content_manage_empty');
            gridContainer.replaceChildren(emptyDiv);
            header.querySelector('h2').textContent = `${JE.t('hidden_content_manage_title')} (0)`;
        });

        overlay.appendChild(panel);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeOverlay();
        });

        const escHandler = (e) => {
            if (e.key === 'Escape') closeOverlay();
        };
        document.addEventListener('keydown', escHandler);

        document.body.appendChild(overlay);
    }

    /**
     * Creates the toolbar (search + unhide-all button) for the management panel.
     * @returns {{ element: HTMLElement, searchInput: HTMLInputElement, unhideAllBtn: HTMLButtonElement }}
     */
    function createManagementToolbar() {
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

        return { element: toolbar, searchInput, unhideAllBtn };
    }

    Object.assign(internal, { createItemCard, showManagementPanel });

})(window.JellyfinEnhanced);
