/**
 * @file Details-page dispatcher: the debounced item-details observer, the Hide
 * button on detail pages, and the per-item-type feature gating.
 * Split from features.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.features = JE.internals.features || {};

    const {
        displayWatchProgress, displayItemSize, displayAudioLanguages, displayReleaseDate,
        prefetchItemStats, discardItemStatsPrefetch, prefetchReleaseDate, discardReleasePrefetch
    } = internal;

    /**
     * Handle item details page display with debounced observer
     */
    // Cache the last item id and type to avoid repeated ApiClient calls
    let lastDetailsItemId = null;
    let lastDetailsItemType = null;
    // A single-version item's only media source: the id Jellyfin's
    // `.selectSource` will hold once it fills it, used as the chips' source
    // until it has. Multi-version items keep waiting for the select (an
    // unplayable one never fills it and shows the all-versions total).
    let lastDetailsDefaultSourceId = null;
    // The pending item lookup, as { itemId }, or null. Keyed by item so that
    // navigating away while it is pending neither blocks the new item's own
    // lookup nor lets the old one's answer land in the new item's state.
    let itemTypeFetch = null;

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

    // The chips JE adds to Jellyfin's primary info row.
    const JE_INFO_CHIP = /\bmediaInfoItem-(watchProgress|fileSize|audioLanguage|releaseDate)\b/;

    /**
     * Whether Jellyfin has rendered its own items into the info row. Jellyfin
     * (re)builds that row while the page loads; chips added before it has
     * would be wiped by that render and re-added — a visible flicker.
     * @param {HTMLElement} container - The .itemMiscInfo-primary row.
     * @returns {boolean}
     */
    function hasJellyfinInfo(container) {
        for (const child of container.children) {
            if (!JE_INFO_CHIP.test(child.className)) return true;
        }
        return false;
    }

    /**
     * Places the details-page features (hide/Spoiler Guard buttons, the media
     * info chips) for the visible item. Idempotent: every feature skips an
     * item it has already placed.
     * @param {boolean} settled - The page's mutations have gone quiet. Early
     *   (unsettled) runs place the chips only once Jellyfin's own info items
     *   are in the row; the settled run places them regardless (some pages,
     *   e.g. seasons, leave the row empty).
     */
    function runItemDetails(settled) {
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
                lastDetailsDefaultSourceId = null;
            }

            // Fetch item type once per item to decide applicability
            if (!lastDetailsItemType) {
                if (itemTypeFetch?.itemId !== itemId) {
                    const userId = ApiClient.getCurrentUserId();
                    const lookup = { itemId };
                    itemTypeFetch = lookup;
                    (JE.helpers?.getItemCached
                        ? JE.helpers.getItemCached(itemId, { userId })
                        : ApiClient.getItem(userId, itemId))
                        .then(item => {
                            if (itemTypeFetch === lookup) itemTypeFetch = null;
                            // The page has moved on to another item: this answer
                            // is not its type or source (that item runs its own
                            // lookup).
                            if (lastDetailsItemId !== itemId) return;
                            lastDetailsItemType = item?.Type || null;
                            lastDetailsDefaultSourceId = item?.MediaSources?.length === 1 ? (item.MediaSources[0].Id || null) : null;
                            // Re-run once the type is known, without waiting for
                            // the page's mutations to go quiet again.
                            runItemDetails(false);
                        })
                        .catch(() => { if (itemTypeFetch === lookup) itemTypeFetch = null; });
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

            if (!settled && !hasJellyfinInfo(container)) return;

            // Jellyfin fills the version <select> after the info row (and the
            // settled run may come before either): for a single-version item
            // an empty select will hold its only source, so use that id now —
            // otherwise the chips fetch once for "no source" and again, with
            // the same answer, once the select holds the id.
            const sourceSelect = visiblePage.querySelector('.selectSource');
            const selectedSourceId = sourceSelect?.value
                || (sourceSelect && sourceSelect.options.length === 0 ? lastDetailsDefaultSourceId : null);
            if (JE?.currentSettings?.showWatchProgress) {
                displayWatchProgress(itemId, container, selectedSourceId);
            }
            if (JE?.currentSettings?.showFileSizes) {
                displayItemSize(itemId, container, selectedSourceId);
            }
            if (JE?.currentSettings?.showAudioLanguages && AUDIO_LANGUAGES_SUPPORTED_TYPES.includes(lastDetailsItemType)) {
                displayAudioLanguages(itemId, container, selectedSourceId);
            }
            if (JE.pluginConfig?.ShowReleaseDates && JE.pluginConfig?.TmdbEnabled && AUDIO_LANGUAGES_SUPPORTED_TYPES.includes(lastDetailsItemType)) {
                displayReleaseDate(itemId, container);
            }
        } catch (e) {
        console.warn('🪼 Jellyfin Enhanced: Error in item details handler', e);
    }
    }

    // Two schedules over the page's mutation bursts. The settled one waits
    // for 100 ms of quiet, as before. The early one runs within ~100 ms even
    // while Jellyfin is still building the page (mutations never go quiet
    // then, which postponed the chips by up to ~0.8 s); it places the chips
    // as soon as Jellyfin's info row is filled.
    const settledItemDetails = JE.helpers.debounce(() => runItemDetails(true), 100);
    const earlyItemDetails = JE.helpers.debounce(() => runItemDetails(false), 16, { maxWait: 100 });
    const handleItemDetails = () => {
        earlyItemDetails();
        settledItemDetails();
    };

    // ── Details visits ──────────────────────────────────────────────────
    // The chips used to ask for their data only once they were placed, after
    // Jellyfin had filled its info row (~0.3 s into the page). A visit starts
    // when Jellyfin shows a freshly built details view and, once the item is
    // known (the same shared lookup runItemDetails makes), starts the chips'
    // item-stats and release lookups, which the chips then take over. What no
    // chip took over is dropped when the visit ends, so a later visit asks
    // again exactly as before. Restored views (history back) start no visit:
    // Jellyfin doesn't reload them and their chips are already in place.
    let visit = null; // { itemId, view, epoch, item }

    function hashItemId() {
        return new URLSearchParams(window.location.hash.split('?')[1]).get('id');
    }

    function endDetailsVisit() {
        const ended = visit;
        if (!ended) return;
        visit = null;
        discardItemStatsPrefetch?.(ended);
        discardReleasePrefetch?.(ended);
    }

    /**
     * @param {HTMLElement} view The details view being shown.
     * @param {object|undefined} detail The viewshow event's detail.
     */
    function beginDetailsVisit(view, detail) {
        endDetailsVisit();
        const itemId = hashItemId();
        if (!itemId || (detail?.params?.id && detail.params.id !== itemId)) return;
        const settings = JE.currentSettings || {};
        const config = JE.pluginConfig || {};
        if (!(settings.showWatchProgress || settings.showFileSizes || (config.ShowReleaseDates && config.TmdbEnabled))) return;
        // runItemDetails already knows this item (A, home, A again) and makes
        // no lookup: neither does the visit.
        if (lastDetailsItemId === itemId && lastDetailsItemType) return;
        const userId = ApiClient.getCurrentUserId?.();
        if (!userId || !JE.helpers?.getItemCached) return;
        const current = visit = { itemId, view, epoch: JE.session ? JE.session.getEpoch() : 0, item: null };
        // The same cached lookup (key and promise) runItemDetails and Seerr make.
        JE.helpers.getItemCached(itemId, { userId }).then((item) => {
            if (visit !== current || !item) return;
            current.item = item;
            // Best effort: Seerr's lookups waiting on this item go first.
            setTimeout(() => prefetchChipData(current), 0);
        }).catch(() => { /* runItemDetails looks it up again */ });
    }

    function visitLive(current) {
        return visit === current
            && (!JE.session || JE.session.isCurrent(current.epoch))
            && hashItemId() === current.itemId
            && current.view.isConnected
            && !current.view.classList.contains('hide');
    }

    /**
     * Starts the lookups the chips of the visit's item will make, under the
     * same switches and type gates as runItemDetails.
     * @param {object} current The visit.
     */
    function prefetchChipData(current) {
        if (!visitLive(current)) return;
        const { item } = current;
        const settings = JE.currentSettings || {};
        const config = JE.pluginConfig || {};
        const sources = item.MediaSources;
        // The source runItemDetails hands the chips is the single version's
        // id (what Jellyfin's select will hold), or none without a version.
        // With several versions the selected one isn't known yet: no prefetch.
        if (FEATURES_SUPPORTED_TYPES.includes(item.Type) && (settings.showWatchProgress || settings.showFileSizes)
            && (!Array.isArray(sources) || sources.length <= 1)) {
            prefetchItemStats?.(current.itemId, sources?.length === 1 ? (sources[0].Id || null) : null,
                { watchProgress: !!settings.showWatchProgress, fileSize: !!settings.showFileSizes }, current);
        }
        if (config.ShowReleaseDates && config.TmdbEnabled && AUDIO_LANGUAGES_SUPPORTED_TYPES.includes(item.Type)) {
            prefetchReleaseDate?.(current.itemId, item, current);
        }
    }

    JE.core.navigation.onViewPage((_view, _element, _hash, _itemPromise, rawEvent) => {
        const target = rawEvent?.target;
        if (target && target.id === 'itemDetailPage' && rawEvent.detail?.isRestored !== true) {
            beginDetailsVisit(target, rawEvent.detail);
        }
    });
    JE.core.navigation.onNavigate(() => {
        if (visit && hashItemId() !== visit.itemId) endDetailsVisit();
    });
    JE.session?.onUserChange('details-prefetch', () => endDetailsVisit());

    // Managed observer for item details. childList-only routes it through the
    // shared body observer (Jellyfin re-renders the detail page's children on
    // navigation); the previous class/style attribute filter made it a
    // dedicated document-wide observer firing on every hover, focus and
    // lazy-image style change, and it called the handler once per record.
    JE.helpers.createObserver(
        'item-details-info',
        () => handleItemDetails(),
        document.body,
        {
            childList: true,
            subtree: true
        }
    );
    // A cached detail page re-shown by a class toggle alone produces no
    // childList mutation, so re-run on view show as well.
    JE.helpers.onViewPage(() => handleItemDetails());
})(window.JellyfinEnhanced);
