/**
 * @file Details-page dispatcher: the debounced item-details observer, the Hide
 * button on detail pages, and the per-item-type feature gating.
 * Split from features.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.features = JE.internals.features || {};

    const { displayWatchProgress, displayItemSize, displayAudioLanguages, displayReleaseDate } = internal;

    /**
     * Handle item details page display with debounced observer
     */
    // Cache the last item id and type to avoid repeated ApiClient calls
    let lastDetailsItemId = null;
    let lastDetailsItemType = null;
    let itemTypeFetchInProgress = null;

    // Types that support file size and watch progress
    const FEATURES_SUPPORTED_TYPES = ['Episode', 'Season', 'Series', 'Movie', 'BoxSet', 'Playlist'];
    // Types that support audio languages (excludes BoxSet and Playlist)
    const AUDIO_LANGUAGES_SUPPORTED_TYPES = ['Episode', 'Season', 'Series', 'Movie'];

    // Types that support hiding
    const HIDE_SUPPORTED_TYPES = ['Movie', 'Series', 'Episode', 'Season'];

    /**
     * Adds a "Hide" button to the item detail page action buttons area.
     * Supports Movies, Series, Episodes, and Seasons.
     * For Episodes: shows a choice dialog between hiding the episode or the entire show.
     * @param {string} itemId The item's Jellyfin ID.
     * @param {HTMLElement} visiblePage The visible detail page element.
     */
    function addHideContentButton(itemId, visiblePage) {
        if (!JE.hiddenContent) return;
        const settings = JE.hiddenContent.getSettings();
        if (!settings.enabled || !settings.showHideButtons) return;
        const isPerson = lastDetailsItemType === 'Person';
        if (isPerson) {
            if (!settings.showButtonCast) return;
        } else {
            if (settings.showButtonDetails === false) return;
            if (!HIDE_SUPPORTED_TYPES.includes(lastDetailsItemType)) return;
        }

        // Don't add duplicate
        if (visiblePage.querySelector('.je-detail-hide-btn')) return;

        const selectors = [
            '.detailButtons',
            '.itemActionsBottom',
            '.mainDetailButtons',
            '.detailButtonsContainer'
        ];
        let buttonContainer = null;
        for (const sel of selectors) {
            const found = visiblePage.querySelector(sel);
            if (found) {
                buttonContainer = found;
                break;
            }
        }
        if (!buttonContainer) return;

        const button = document.createElement('button');
        button.setAttribute('is', 'emby-button');
        button.className = 'button-flat detailButton emby-button je-detail-hide-btn';
        button.type = 'button';

        const hideLabel = JE.t('hidden_content_hide_button') !== 'hidden_content_hide_button'
            ? JE.t('hidden_content_hide_button')
            : 'Hide';
        const hiddenLabel = JE.t('hidden_content_already_hidden') !== 'hidden_content_already_hidden'
            ? JE.t('hidden_content_already_hidden')
            : 'Hidden';
        const unhideLabel = JE.t('hidden_content_unhide') !== 'hidden_content_unhide'
            ? JE.t('hidden_content_unhide')
            : 'Unhide';

        const content = document.createElement('div');
        content.className = 'detailButton-content';
        button.appendChild(content);

        function renderContent(text, iconName) {
            content.replaceChildren();
            const icon = document.createElement('span');
            icon.className = 'material-icons detailButton-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = iconName || 'visibility';
            content.appendChild(icon);
            if (text) {
                const textSpan = document.createElement('span');
                textSpan.className = 'detailButton-icon-text';
                textSpan.textContent = text;
                content.appendChild(textSpan);
            }
        }

        function setHiddenState() {
            button.classList.add('je-already-hidden');
            button.setAttribute('aria-label', hiddenLabel);
            button.title = hiddenLabel;
            renderContent('', 'visibility_off');

            button.onmouseenter = () => {
                button.title = unhideLabel;
            };
            button.onmouseleave = () => {
                button.title = hiddenLabel;
            };
            button.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                JE.hiddenContent.unhideItem(itemId);
                setHideState();
            };
        }

        function setHideState() {
            button.classList.remove('je-already-hidden');
            button.setAttribute('aria-label', hideLabel);
            button.title = hideLabel;
            renderContent('', 'visibility');
            button.onmouseenter = null;
            button.onmouseleave = null;
            button.onclick = async (e) => {
                e.preventDefault();
                e.stopPropagation();

                // Get item name from the page title
                const nameEl = visiblePage.querySelector('.itemName, h1, h2, [class*="itemName"]');
                const itemName = nameEl?.textContent?.trim() || 'Unknown';

                // Fetch full item data for TMDb ID and episode/series metadata
                let tmdbId = '';
                let seriesId = '';
                let seriesName = '';
                let seasonNumber = null;
                let episodeNumber = null;
                try {
                    const userId = ApiClient.getCurrentUserId();
                    const item = JE.helpers?.getItemCached
                        ? await JE.helpers.getItemCached(itemId, { userId })
                        : await ApiClient.getItem(userId, itemId);
                    tmdbId = item?.ProviderIds?.Tmdb || '';
                    seriesId = item?.SeriesId || '';
                    seriesName = item?.SeriesName || '';
                    seasonNumber = item?.ParentIndexNumber != null ? item.ParentIndexNumber : null;
                    episodeNumber = item?.IndexNumber != null ? item.IndexNumber : null;
                } catch (err) {
                    console.warn('🪼 Jellyfin Enhanced: Could not fetch item metadata for hide button', err);
                }

                const isEpisode = lastDetailsItemType === 'Episode';
                const isSeason = lastDetailsItemType === 'Season';

                // Build base item data
                const baseItemData = {
                    itemId,
                    name: itemName,
                    type: lastDetailsItemType,
                    tmdbId,
                    seriesId,
                    seriesName,
                    seasonNumber,
                    episodeNumber
                };

                if (isEpisode && seriesId) {
                    // Episode on a detail page: show choice dialog
                    JE.hiddenContent.confirmAndHide(baseItemData, () => {
                        setHiddenState();
                    }, {
                        showEpisodeChoice: true,
                        onChooseShow: async () => {
                            // User chose to hide the entire show
                            let seriesTmdbId = '';
                            try {
                                const userId = ApiClient.getCurrentUserId();
                                const series = await ApiClient.getItem(userId, seriesId);
                                seriesTmdbId = series?.ProviderIds?.Tmdb || '';
                            } catch (err) {
                                console.warn('🪼 Jellyfin Enhanced: Could not fetch series metadata for hide-show action', err);
                            }
                            JE.hiddenContent.hideItem({
                                itemId: seriesId,
                                name: seriesName || itemName,
                                type: 'Series',
                                tmdbId: seriesTmdbId,
                                posterPath: ''
                            });
                            setHiddenState();
                        }
                    });
                } else if (isSeason && seriesId) {
                    // Season: hide with series metadata
                    JE.hiddenContent.confirmAndHide(baseItemData, () => {
                        setHiddenState();
                    });
                } else {
                    // Movie or Series: standard hide
                    JE.hiddenContent.confirmAndHide(baseItemData, () => {
                        setHiddenState();
                    });
                }
            };
        }

        if (JE.hiddenContent.isHidden(itemId)) {
            setHiddenState();
        } else {
            setHideState();
        }

        // Keep Jellyfin's overflow menu (three-dots) as the last action button.
        const moreButton = buttonContainer.querySelector('.btnMoreCommands');
        if (moreButton) {
            buttonContainer.insertBefore(button, moreButton);
        } else {
            buttonContainer.appendChild(button);
        }
    }

    const handleItemDetails = JE.helpers.debounce(() => {
        const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
        if (!visiblePage) return;

        const container = visiblePage.querySelector('.itemMiscInfo.itemMiscInfo-primary');
        if (!container) return;

        try {
            const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
            if (!itemId) return;

            // Reset cache when navigating to a new item
            if (lastDetailsItemId !== itemId) {
                lastDetailsItemId = itemId;
                lastDetailsItemType = null;
            }

            // Fetch item type once per item to decide applicability
            if (!lastDetailsItemType) {
                if (!itemTypeFetchInProgress) {
                    const userId = ApiClient.getCurrentUserId();
                    itemTypeFetchInProgress = (JE.helpers?.getItemCached
                        ? JE.helpers.getItemCached(itemId, { userId })
                        : ApiClient.getItem(userId, itemId))
                        .then(item => {
                            lastDetailsItemType = item?.Type || null;
                            itemTypeFetchInProgress = null;
                            // Re-run once type is known to render features
                            handleItemDetails();
                        })
                        .catch(() => { itemTypeFetchInProgress = null; });
                }
                return;
            }

            // Add hide content button on detail pages (including Person pages)
            if (JE.hiddenContent) {
                addHideContentButton(itemId, visiblePage);
            }

            // Spoiler Guard supports Series, Movie, and BoxSet detail pages.
            // Keep this before the media-info type gate so the action remains
            // available even when other detail enhancements are disabled.
            if ((lastDetailsItemType === 'Series' || lastDetailsItemType === 'Movie' || lastDetailsItemType === 'BoxSet')
                && typeof JE.spoilerBlur?.addSpoilerBlurButton === 'function') {
                JE.spoilerBlur.addSpoilerBlurButton(itemId, visiblePage, lastDetailsItemType);
            }

            // Skip unsupported item types for media features
            if (!FEATURES_SUPPORTED_TYPES.includes(lastDetailsItemType)) {
                return;
            }

            if (JE?.currentSettings?.showWatchProgress) {
                displayWatchProgress(itemId, container);
            }
            if (JE?.currentSettings?.showFileSizes) {
                displayItemSize(itemId, container);
            }
            if (JE?.currentSettings?.showAudioLanguages && AUDIO_LANGUAGES_SUPPORTED_TYPES.includes(lastDetailsItemType)) {
                displayAudioLanguages(itemId, container);
            }
            if (JE.pluginConfig?.ShowReleaseDates && JE.pluginConfig?.TmdbEnabled && AUDIO_LANGUAGES_SUPPORTED_TYPES.includes(lastDetailsItemType)) {
                displayReleaseDate(itemId, container);
            }
        } catch (e) {
        console.warn('🪼 Jellyfin Enhanced: Error in item details handler', e);
    }
    }, 100);

    // Create managed observer for item details
    JE.helpers.createObserver(
        'item-details-info',
        (mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'childList' || mutation.type === 'attributes') {
                    handleItemDetails();
                }
            }
        },
        document.body,
        {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style']
        }
    );
})(window.JellyfinEnhanced);
