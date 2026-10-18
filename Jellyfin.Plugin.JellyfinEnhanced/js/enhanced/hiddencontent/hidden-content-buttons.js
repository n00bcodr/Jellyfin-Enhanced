/**
 * @file Hidden Content — hide/unhide toggle buttons injected on native
 * library cards, including the scoped (Next Up / Continue Watching) flow.
 * Split from hidden-content.js (code motion; bodies verbatim).
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.hiddenContent = JE.internals.hiddenContent || {};

    const { hiddenIdSet, getSettings, hideItem, unhideItem, getCardSurface, getCardItemId, confirmAndHide } = internal;
    let checkedCards = new WeakSet();
    /** After a failed identity batch, later passes retry it once this window has passed. */
    const TITLE_RETRY_AFTER_MS = 30000;
    let titlesRetryAt = 0;
    JE.session?.onUserChange('hidden-content-card-identities', () => { checkedCards = new WeakSet(); titlesRetryAt = 0; });

    /** Resolves ID-only native card identities in bounded batches, only when provider rules exist. */
    async function hydrateCardTitles() {
        if (!internal.hasProviderRules() || JE.pluginConfig?.HiddenContentEnabled === false || Date.now() < titlesRetryAt) return;
        const action = JE.createSessionAction();
        const byId = new Map();
        for (const card of document.querySelectorAll('.card[data-id], .card[data-itemid]')) {
            const id = getCardItemId(card);
            const surface = internal.getCardSurface(card) || internal.getCurrentNativeSurface();
            if (checkedCards.has(card) || (!card.querySelector('.je-hide-btn') && !internal.shouldFilterSurface(surface)) ||
                !['movie', 'series'].includes((card.dataset.type || '').toLowerCase()) ||
                internal.titleData({ itemId: id, type: card.dataset.type, tmdbId: card.dataset.tmdbId }) ||
                JE.titleDetails?.isSynthetic?.(id)) continue;
            checkedCards.add(card);
            if (!byId.has(id)) byId.set(id, []);
            byId.get(id).push(card);
        }
        const ids = [...byId.keys()];
        for (let start = 0; start < ids.length; start += 50) {
            if (!action.current()) return;
            const batch = ids.slice(start, start + 50);
            try {
                const reply = await ApiClient.ajax({ type: 'GET', dataType: 'json',
                    url: ApiClient.getUrl(`/Users/${ApiClient.getCurrentUserId()}/Items`, { Ids: batch.join(','), Fields: 'ProviderIds' }) });
                if (!action.current()) return;
                for (const item of reply?.Items || []) {
                    const title = internal.titleData(item);
                    if (!title) continue;
                    for (const card of byId.get(internal.normalizeId(item.Id)) || []) {
                        card.dataset.type = title.type;
                        card.dataset.tmdbId = title.tmdbId;
                        card.querySelector('.je-hide-btn')?.jeHiddenPaint?.();
                    }
                }
                internal.refreshNativeCardVisibility();
            } catch (_) {
                // Leave unresolved cards usable; the same cards retry after the window.
                if (!action.current()) return;
                for (const id of batch) for (const card of byId.get(id) || []) checkedCards.delete(card);
                titlesRetryAt = Date.now() + TITLE_RETRY_AFTER_MS;
                return;
            }
        }
    }

    // ============================================================
    // Library hide buttons
    // ============================================================

    /**
     * Creates and attaches a hide/unhide toggle button to a single library card.
     * Captures per-card references in a closure for state management.
     * @param {HTMLElement} cardBox The `.cardBox` element to attach the button to.
     * @param {HTMLElement} card The parent `.card` element.
     * @param {string} itemId The Jellyfin item ID.
     */
    function createLibraryHideButton(cardBox, card, itemId, isPerson) {
        cardBox.style.position = 'relative';
        const btn = document.createElement('button');

        const hideLabel = JE.t('hidden_content_hide_button') !== 'hidden_content_hide_button' ? JE.t('hidden_content_hide_button') : 'Hide';
        const hiddenLabel = JE.t('hidden_content_already_hidden') !== 'hidden_content_already_hidden' ? JE.t('hidden_content_already_hidden') : 'Hidden';
        const unhideLabel = JE.t('hidden_content_unhide') !== 'hidden_content_unhide' ? JE.t('hidden_content_unhide') : 'Unhide';

        /**
         * Renders a material icon inside the button.
         * @param {string} iconName Material icon name.
         */
        function renderIcon(iconName) {
            btn.replaceChildren();
            const icon = document.createElement('span');
            icon.className = 'material-icons';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = iconName || 'visibility';
            btn.appendChild(icon);
        }

        /** Configures the button for "already hidden" state — click to unhide. */
        function setHiddenState() {
            btn.className = 'je-hide-btn je-already-hidden';
            btn.title = hiddenLabel;
            renderIcon('visibility_off');
            btn.onmouseenter = () => { btn.title = unhideLabel; };
            btn.onmouseleave = () => { btn.title = hiddenLabel; };
            btn.onclick = async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const action = JE.createSessionAction();
                const saved = await unhideItem(itemId, { type: card.dataset.type, tmdbId: card.dataset.tmdbId });
                if (!action.current()) return;
                if (saved === false) btn.textContent = JE.t('hidden_content_save_failed_persistent');
                else setHideState();
            };
        }

        /** Configures the button for "visible" state — click to hide. */
        function setHideState() {
            btn.className = 'je-hide-btn';
            btn.title = hideLabel;
            renderIcon('visibility');
            btn.onmouseenter = null;
            btn.onmouseleave = null;
            btn.onclick = async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const action = JE.createSessionAction();

                const cardName = card.querySelector('.cardText')?.textContent || '';
                const surface = getCardSurface(card);

                if (surface === 'nextup' || surface === 'continuewatching') {
                    await handleScopedCardHide(card, itemId, cardName, surface, setHiddenState);
                } else {
                    const itemData = { itemId, name: cardName, type: card.dataset.type || '', tmdbId: card.dataset.tmdbId || '' };
                    if (isPerson) itemData.type = 'Person';
                    // Only a deliberate click resolves an ID-only native card. Mounting/scanning makes no requests.
                    if (!isPerson && !itemData.tmdbId) {
                        try {
                            const userId = ApiClient.getCurrentUserId();
                            const item = JE.helpers?.getItemCached ? await JE.helpers.getItemCached(itemId, { userId }) : await ApiClient.getItem(userId, itemId);
                            itemData.type = item?.Type || itemData.type;
                            itemData.tmdbId = item?.ProviderIds?.Tmdb || '';
                        } catch (_) { btn.textContent = JE.t('hidden_content_save_failed_persistent'); return; }
                    }
                    if (!action.current()) return;
                    const title = internal.titleData(itemData);
                    if (title) {
                        // Later filter passes (and cloned cards) need the identity resolved by this click.
                        card.dataset.type = title.type;
                        card.dataset.tmdbId = title.tmdbId;
                        if (internal.isHiddenByTmdbId(title.tmdbId, title.type)) {
                            const saved = await unhideItem(itemId, itemData);
                            if (!action.current()) return;
                            if (saved === false) btn.textContent = JE.t('hidden_content_save_failed_persistent');
                            else setHideState();
                            return;
                        }
                        /** Confirms before persistence, then acknowledges only a successful provider-rule save. */
                        async function saveConfirmedTitle() {
                            if (!action.current()) return;
                            btn.disabled = true;
                            try {
                                const saved = await internal.saveTitleRule(title, true).catch(() => false);
                                if (saved && action.current()) {
                                    card.classList.toggle('je-hidden', internal.shouldFilterSurface(surface || internal.getCurrentNativeSurface()));
                                    setHiddenState();
                                }
                                else btn.textContent = JE.t('hidden_content_save_failed_persistent');
                            } finally { btn.disabled = false; }
                        }
                        if (!internal.isConfirmationSuppressed()) {
                            internal.showHideConfirmation(title.name || 'Item', saveConfirmedTitle);
                            return;
                        }
                        return saveConfirmedTitle();
                    }
                    confirmAndHide(itemData, () => {
                        card.classList.add('je-hidden');
                    });
                }
            };
        }

        /** Reuses metadata already on the card when rules change, without provider lookups. */
        btn.jeHiddenPaint = () => {
            const hidden = internal.isHidden(itemId, { type: card.dataset.type, tmdbId: card.dataset.tmdbId });
            if (hidden !== btn.classList.contains('je-already-hidden')) {
                if (hidden) setHiddenState(); else setHideState();
            }
        };
        setHideState();
        btn.jeHiddenPaint();
        btn.jeHideButtonLive = true;
        cardBox.appendChild(btn);
    }

    /**
     * Handles the hide flow for a card in a scoped surface (Next Up / Continue Watching).
     * Fetches item metadata to determine if episode-choice should be offered.
     * @param {HTMLElement} card The card element to hide.
     * @param {string} itemId The Jellyfin item ID.
     * @param {string} cardName Display name from the card text.
     * @param {string} surface The detected surface ('nextup' or 'continuewatching').
     * @param {Function} setHiddenState Callback to switch the button to "hidden" state.
     */
    async function handleScopedCardHide(card, itemId, cardName, surface, setHiddenState) {
        const action = JE.createSessionAction();
        const itemData = { itemId, name: cardName };
        // Pass surface through so the hideScope stays bound to the row the user clicked.
        const dialogOpts = { surface };

        try {
            const userId = ApiClient.getCurrentUserId();
            const item = JE.helpers?.getItemCached
                ? await JE.helpers.getItemCached(itemId, { userId })
                : await ApiClient.getItem(userId, itemId);
            const itemType = item?.Type || '';
            if (!action.current()) return;
            const seriesId = item?.SeriesId || '';
            const seriesName = item?.SeriesName || '';

            itemData.type = itemType;
            itemData.name = item?.Name || cardName;
            itemData.seriesId = seriesId;
            itemData.seriesName = seriesName;
            itemData.seasonNumber = item?.ParentIndexNumber != null ? item.ParentIndexNumber : null;
            itemData.episodeNumber = item?.IndexNumber != null ? item.IndexNumber : null;
            itemData.tmdbId = item?.ProviderIds?.Tmdb || '';

            if ((itemType === 'Episode' || itemType === 'Season') && seriesId) {
                dialogOpts.showEpisodeChoice = true;
                dialogOpts.onChooseScoped = () => {
                    hideItem({ ...itemData, hideScope: surface });
                    card.classList.add('je-hidden');
                };
                dialogOpts.onChooseShow = async () => {
                    let seriesTmdbId = '';
                    try {
                        const series = JE.helpers?.getItemCached
                            ? await JE.helpers.getItemCached(seriesId, { userId })
                            : await ApiClient.getItem(userId, seriesId);
                        seriesTmdbId = series?.ProviderIds?.Tmdb || '';
                    } catch (err) {
                        console.warn('🪼 Jellyfin Enhanced: Failed to fetch series TMDB ID', err);
                    }
                    if (!action.current()) return;
                    hideItem({
                        itemId: seriesId,
                        name: seriesName || cardName,
                        type: 'Series',
                        tmdbId: seriesTmdbId
                    });
                    card.classList.add('je-hidden');
                };
            } else {
                dialogOpts.onChooseScoped = () => {
                    hideItem({ ...itemData, hideScope: surface });
                    card.classList.add('je-hidden');
                };
            }
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: Failed to fetch item data for scoped hide', err);
            dialogOpts.onChooseScoped = () => {
                hideItem({ itemId, name: cardName, hideScope: surface });
                card.classList.add('je-hidden');
            };
        }

        if (!action.current()) return;
        confirmAndHide(itemData, () => {
            card.classList.add('je-hidden');
        }, dialogOpts);
    }

    /**
     * Adds hide/unhide toggle buttons to native Jellyfin library cards.
     * Only runs when the `showButtonLibrary` setting is enabled.
     * Skips cards that already have a `.je-hide-btn` to avoid duplicates.
     */
    function addLibraryHideButtons() {
        const s = getSettings();
        if (!s.enabled || !s.showHideButtons) return;
        // At least one of library or cast buttons must be enabled
        if (!s.showButtonLibrary && !s.showButtonCast && !s.showButtonJellyseerr) return;

        const skipCollections = !s.experimentalHideCollections;

        const cards = document.querySelectorAll('.card[data-id] .cardBox, .card[data-itemid] .cardBox');
        for (let i = 0; i < cards.length; i++) {
            const cardBox = cards[i];
            const existing = cardBox.querySelector('.je-hide-btn');
            if (existing?.jeHideButtonLive) { existing.jeHiddenPaint?.(); continue; }
            existing?.remove();

            const card = cardBox.closest('.card');
            if (!card) continue;

            // Skip image editor cards and cards inside dialogs/admin pages
            if (card.hasAttribute('data-imagetype') || card.closest('.formDialog, .editPageInnerContent')) continue;

            // Skip chapter/scene cards on detail pages
            if (card.closest('#itemDetailPage') && card.querySelector('.chapterCardImageContainer')) continue;

            const itemId = getCardItemId(card);
            if (!itemId) continue;
            const synthetic = JE.titleDetails?.parse?.(itemId);
            const requestSurface = !!synthetic || !!card.closest('.je-native-absent, .je-discovery-grid, .je-seerr-section, #similarCollapsible');
            if (requestSurface && s.showButtonJellyseerr) {
                const title = internal.titleData({ itemId, type: card.dataset.type, tmdbId: card.dataset.tmdbId,
                    name: card.querySelector('.cardText')?.textContent || '' });
                if (title) {
                    const button = internal.buildTitleControl(title, { card, surface: () => internal.getCardSurface(card) || internal.getCurrentNativeSurface() });
                    if (button) cardBox.appendChild(button);
                    continue;
                }
            }
            if (JE.titleDetails?.isSynthetic?.(itemId)) continue;

            const cardType = (card.dataset.type || '').toLowerCase();
            const isPerson = cardType === 'person' || card.classList.contains('personCard');

            // Skip Person cards unless showButtonCast is enabled
            if (isPerson && !s.showButtonCast) continue;
            // Skip non-Person cards unless showButtonLibrary is enabled
            if (!isPerson && !s.showButtonLibrary && !(requestSurface && s.showButtonJellyseerr)) continue;

            if (skipCollections && !isPerson) {
                if (cardType === 'collectionfolder' || cardType === 'userview' || cardType === 'boxset' || cardType === 'playlist' || cardType === 'channel') continue;
                const section = card.closest('.section, .verticalSection, .homeSection');
                if (section) {
                    const sTitle = (section.querySelector('.sectionTitle, h2, .headerText, .sectionTitle-sectionTitle')?.textContent || '').toLowerCase();
                    if (sTitle.includes('my media') || sTitle.includes('collections')) continue;
                }
            }

            createLibraryHideButton(cardBox, card, itemId, isPerson);
        }
        if (s.showButtonJellyseerr) {
            document.querySelectorAll('[data-je-hide-title]').forEach(card => {
                const existing = card.querySelector('.je-hide-btn');
                if (existing?.jeHideButtonLive) { existing.jeHiddenPaint?.(); return; }
                existing?.remove();
                const [type, provider, tmdbId] = card.dataset.jeHideTitle.split(':');
                if (provider !== 'tmdb') return;
                const control = internal.buildTitleControl({ type, tmdbId, name: card.dataset.jeHideName || '' }, {
                    card, surface: card.dataset.jeHideSurface || 'requests'
                });
                if (control) { card.appendChild(control); control.jeHiddenPaint(); }
            });
        }
        void hydrateCardTitles();
    }

    /**
     * Removes all hide buttons from native Jellyfin library cards.
     * Called when the `showButtonLibrary` setting is toggled off.
     */
    function removeLibraryHideButtons() {
        const btns = document.querySelectorAll('.card[data-id] .je-hide-btn, .card[data-itemid] .je-hide-btn');
        for (let i = 0; i < btns.length; i++) {
            btns[i].remove();
        }
    }

    Object.assign(internal, { addLibraryHideButtons, removeLibraryHideButtons, hydrateCardTitles });

})(window.JellyfinEnhanced);
