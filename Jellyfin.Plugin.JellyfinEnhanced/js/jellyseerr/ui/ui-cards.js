// /js/jellyseerr/ui/ui-cards.js
// Seerr search-result card construction.
(function(JE) {
    'use strict';

    const ui = JE.jellyseerrUI = JE.jellyseerrUI || {};
    JE.internals = JE.internals || {};
    // Shared state is seeded by ui-icons.js, which plugin.js loads first
    // in this group.
    const internal = JE.internals.jellyseerrUi;
    const MediaStatus = JE.seerrStatus.MEDIA;
    const icons = internal.icons; // requires ui-icons.js to be loaded first
    const escapeHtml = JE.escapeHtml;
    const addTouchTapListener = JE.core.ui.addTouchTapListener;

    /**
     * Creates an individual Seerr result card.
     * @param {Object} item - Search result item from Seerr API.
     * @param {boolean} isJellyseerrActive - If the server is reachable.
     * @param {boolean} jellyseerrUserFound - If the current user is linked.
     * @returns {HTMLElement} - Card element.
     */
    function createJellyseerrCard(item, isJellyseerrActive, jellyseerrUserFound) {
        const year = item.releaseDate?.substring(0, 4) || item.firstAirDate?.substring(0, 4) || 'N/A';
        // validate posterPath before interpolating into a CSS
        // url() context. Anything other than a leading-slash relative path
        // (TMDB always returns this shape, e.g. "/abc.jpg") is rejected so a
        // hostile poster path can't break out of the url() literal.
        const isSafePosterPath = (p) => typeof p === 'string'
            && /^\/[A-Za-z0-9_\-\.]+\.(jpg|jpeg|png|webp|avif)$/i.test(p);
        const posterUrl = isSafePosterPath(item.posterPath)
            ? `https://image.tmdb.org/t/p/w400${item.posterPath}`
            : JE.cdn.url('ibb', 'fdbkXQdP/jellyseerr-poster-not-found.png');
        const rating = item.voteAverage ? item.voteAverage.toFixed(1) : 'N/A';
        // Escape API-sourced values before interpolation into search card HTML
        const titleText = escapeHtml(item.title || item.name);
        // Resolve Seerr URL based on mappings or fallback to base URL
        const base = JE.jellyseerrAPI?.resolveJellyseerrBaseUrl() || '';
        const jellyseerrUrl = base ? `${base}/${item.mediaType}/${item.id}` : null;
        const useMoreInfoModal = !!(JE.pluginConfig && JE.pluginConfig.JellyseerrUseMoreInfoModal);

        const jellyfinMediaId = item.mediaInfo?.jellyfinMediaId || item.mediaInfo?.jellyfinMediaId4k || null;
        // For TV shows, derive the card-level availability from the season analysis so that
        // a stale Seerr jellyfinMediaId on a show where no seasons are confirmed present
        // does not produce a false "in library" green link.
        // Only AVAILABLE (all seasons present) or PARTIALLY_AVAILABLE (some present) justify the link.
        let cardEffectiveStatus;
        if (item.mediaType === 'tv' && item.mediaInfo?.seasons?.length) {
            const sa = internal.analyzeSeasonStatuses(item.mediaInfo.seasons);
            cardEffectiveStatus = sa ? sa.overallStatus : JE.seerrStatus.effectiveMediaStatus(item.mediaInfo?.status, jellyfinMediaId);
        } else {
            cardEffectiveStatus = JE.seerrStatus.effectiveMediaStatus(item.mediaInfo?.status, jellyfinMediaId);
        }
        const isAvailable = Boolean(jellyfinMediaId)
            && (cardEffectiveStatus === MediaStatus.AVAILABLE || cardEffectiveStatus === MediaStatus.PARTIALLY_AVAILABLE);
        const jellyfinHref = isAvailable ? `#!/details?id=${jellyfinMediaId}` : null;
        // Admin opt-in: for an available item, the poster click goes straight to Jellyfin
        // instead of opening the More Info modal / Seerr link — same as the title link already does.
        const linksAvailableToJellyfin = isAvailable
            && item.mediaType !== 'collection'
            && !!(JE.pluginConfig && JE.pluginConfig.JellyseerrAvailablePosterLinksToJellyfin);
        const goToJellyfinItem = () => {
            try {
                if (typeof Emby !== 'undefined' && Emby.Page?.showItem) {
                    Emby.Page.showItem(jellyfinMediaId);
                    return;
                }
            } catch (_) { /* fall through to hash */ }
            window.location.hash = jellyfinHref;
        };
        // True when the card should navigate directly to an external Seerr URL instead of
        // showing the hover overview — used to decide poster touch behaviour below.
        const navigatesExternally = !useMoreInfoModal && !jellyfinMediaId && !!jellyseerrUrl && item.mediaType !== 'collection';
        // is="emby-linkbutton" routes external URLs through the system browser on iOS/Android.
        const titleLinkIsAttribute = 'is="emby-linkbutton"';
        const titleHrefAttribute = jellyfinHref
            ? `href="${jellyfinHref}"`
            : (useMoreInfoModal
                ? 'href="#"'
                : (jellyseerrUrl
                    ? `href="${jellyseerrUrl}" target="_blank" rel="noopener noreferrer"`
                    : 'href="#"'));

        const card = document.createElement('div');
        card.className = `card overflowPortraitCard card-hoverable card-withuserdata jellyseerr-card${isAvailable ? ' jellyseerr-card-in-library' : ''}`;
        card.innerHTML = `
            <div class="cardBox cardBox-bottompadded">
                <div class="cardScalable">
                    <div class="cardPadder cardPadder-overflowPortrait"></div>
                    <div class="cardImageContainer coveredImage cardContent jellyseerr-poster-image" style="background-image: url('${posterUrl}');">
                        <div class="jellyseerr-status-badge"></div>
                        <div class="jellyseerr-elsewhere-icons"></div>
                        <div class="cardIndicators"></div>
                    </div>
                    <div class="cardOverlayContainer" data-action="link"></div>
                </div>
                <div class="cardText cardTextCentered cardText-first">
                    <a ${titleLinkIsAttribute}
                       ${titleHrefAttribute}
                       class="jellyseerr-more-info-link"
                       data-tmdb-id="${item.id}"
                       data-media-type="${item.mediaType}"
                       title="${jellyfinHref ? titleText : (useMoreInfoModal ? titleText : (jellyseerrUrl ? (JE.t('jellyseerr_card_view_on_jellyseerr') || 'View on Jellyseerr') : titleText))}"><bdi>${titleText}</bdi></a>
                </div>
                <div class="cardText cardTextCentered cardText-secondary jellyseerr-meta">
                    <img src="${JE.cdn.selfhst('svg/seerr.svg')}" class="jellyseerr-icon-on-card" alt="Seerr"/>
                    <bdi>${year}</bdi>
                    <div class="jellyseerr-rating">${icons.star}<span>${rating}</span></div>
                </div>
            </div>`;

        // Set the status badge icon based on the item's status
        internal.setStatusBadge(card, item);

        // Disable default Jellyfin card click behavior so we fully control taps/clicks
        const overlayContainer = card.querySelector('.cardOverlayContainer');
        if (overlayContainer) {
            overlayContainer.removeAttribute('data-action');
            overlayContainer.style.pointerEvents = 'none';
        }

        const imageContainer = card.querySelector('.cardImageContainer');
        const cardScalable = card.querySelector('.cardScalable');

        if (imageContainer && cardScalable) {
            imageContainer.classList.remove('itemAction');

            let overview = null;
            let button = null;

            // Create the overview element
            const createOverview = () => {
                overview = document.createElement('div');
                overview.className = 'jellyseerr-overview';
                overview.style.cursor = 'pointer';
                // When modal is disabled and item isn't in the library, wrap the description
                // text in a real <a is="emby-linkbutton"> so the user's tap opens outside the app.
                const contentHtml = navigatesExternally
                    ? `<a is="emby-linkbutton" href="${jellyseerrUrl}" target="_blank" rel="noopener noreferrer" class="content jellyseerr-overview-link" style="text-decoration:none;color:inherit;">${escapeHtml((item.overview || JE.t('jellyseerr_card_no_info')).slice(0, 500))}</a>`
                    : `<div class="content">${escapeHtml((item.overview || JE.t('jellyseerr_card_no_info')).slice(0, 500))}</div>`;
                overview.innerHTML = `
                    ${contentHtml}
                    <button type="button" class="jellyseerr-request-button" data-tmdb-id="${item.id}" data-media-type="${item.mediaType}"></button>
                `;

                cardScalable.appendChild(overview);
                button = overview.querySelector('.jellyseerr-request-button');
                internal.configureRequestButton(button, item, isJellyseerrActive, jellyseerrUserFound);

                // Click handler on overview to open modal
                overview.addEventListener('click', (e) => {
                    if (e.target.closest('.jellyseerr-request-button')) {
                        return;
                    }
                    if (e.target.closest('.jellyseerr-overview-link')) {
                        return;
                    }
                    e.preventDefault();
                    e.stopPropagation();

                    if (linksAvailableToJellyfin) {
                        goToJellyfinItem();
                    } else if (item.mediaType === 'collection') {
                        ui.showCollectionRequestModal(item.id, item.name || item.title, item);
                    } else if (useMoreInfoModal && JE.jellyseerrMoreInfo) {
                        const tmdbId = parseInt(item.id);
                        const mediaType = item.mediaType;
                        if (tmdbId && mediaType) {
                            JE.jellyseerrMoreInfo.open(tmdbId, mediaType);
                        }
                    }
                });
            };

            // Remove the overview element
            const removeOverview = () => {
                if (overview && overview.parentNode) {
                    overview.parentNode.removeChild(overview);
                    overview = null;
                    button = null;
                }
                document.removeEventListener('click', handleOutsideClick);
            };

            // Helper to close overview if clicked outside
            const handleOutsideClick = (evt) => {
                if (!card.contains(evt.target)) {
                    removeOverview();
                }
            };

            // Desktop: hover to show/hide overview. Skipped when the poster just links
            // straight to Jellyfin — there's no request/status info worth previewing.
            cardScalable.addEventListener('mouseenter', () => {
                if (!overview && !linksAvailableToJellyfin) {
                    createOverview();
                }
            });
            cardScalable.addEventListener('mouseleave', () => {
                removeOverview();
            });

            // Mobile/Touch: tap to show overview, second tap (click) on overview opens modal
            imageContainer.style.cursor = 'pointer';

            // Tap (not swipe) creates the overview; preventDefault() on the tap's
            // touchend suppresses the synthetic click so the fresh overview isn't
            // immediately activated. Swipes keep scrolling the results row natively.
            addTouchTapListener(imageContainer, (e) => {
                if (e.target.closest('.jellyseerr-overview') || e.target.closest('.jellyseerr-request-button')) {
                    return;
                }

                if (linksAvailableToJellyfin) {
                    goToJellyfinItem();
                    return;
                }

                if (!overview) {
                    e.preventDefault();
                    createOverview();
                    setTimeout(() => {
                        document.addEventListener('click', handleOutsideClick);
                    }, 0);
                }
            });

            // Desktop: use click event
            imageContainer.addEventListener('click', (e) => {
                // Skip if touch device (the tap handler already handled it)
                if (e.type === 'click' && 'ontouchstart' in window) {
                    return;
                }

                if (e.target.closest('.jellyseerr-overview')) {
                    return;
                }

                if (linksAvailableToJellyfin) {
                    e.preventDefault();
                    e.stopPropagation();
                    goToJellyfinItem();
                    return;
                }

                if (!overview) {
                    e.preventDefault();
                    e.stopPropagation();
                    createOverview();
                    setTimeout(() => {
                        document.addEventListener('click', handleOutsideClick);
                    }, 0);
                }
            });

            imageContainer.setAttribute('tabindex', '0');
            imageContainer.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (linksAvailableToJellyfin) {
                        goToJellyfinItem();
                    } else if (!overview) {
                        createOverview();
                    } else {
                        removeOverview();
                    }
                }
            });
        }
        internal.addMediaTypeBadge(card, item);
        // If movie belongs to a collection, show a collection badge that opens the modal
        internal.addCollectionMembershipBadge(card, item);

        // Add click handler for the poster image - opens modal (or, when the item is
        // available and the admin opted in, navigates straight to Jellyfin instead).
        const posterImage = card.querySelector('.jellyseerr-poster-image');
        if (posterImage && linksAvailableToJellyfin) {
            posterImage.style.cursor = 'pointer';
            posterImage.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                goToJellyfinItem();
            });
        } else if (posterImage && useMoreInfoModal && JE.jellyseerrMoreInfo) {
            posterImage.style.cursor = 'pointer';
            posterImage.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const tmdbId = parseInt(item.id);
                const mediaType = item.mediaType;
                if (tmdbId && mediaType) {
                    JE.jellyseerrMoreInfo.open(tmdbId, mediaType);
                }
            });
        }

        // Add click handler for the title link
        const moreInfoLink = card.querySelector('.jellyseerr-more-info-link');
        if (moreInfoLink) {
            moreInfoLink.addEventListener('click', (e) => {
                // Check if this is a library item (href already set to jellyfin item)
                const href = moreInfoLink.getAttribute('href');
                const isLibraryLink = href && href.startsWith('#!/details?id=');
                const isExternalJellyseerrLink = href && /^https?:\/\//i.test(href);

                if (isLibraryLink) {
                    // Allow default behavior for library links
                    return;
                }

                // If collection, open collection modal
                if (item.mediaType === 'collection') {
                    e.preventDefault();
                    e.stopPropagation();
                    ui.showCollectionRequestModal(item.id, item.name || item.title, item);
                    return;
                }

                // If using modal, prevent default and open modal
                if (useMoreInfoModal && JE.jellyseerrMoreInfo) {
                    e.preventDefault();
                    e.stopPropagation();
                    const tmdbId = parseInt(moreInfoLink.dataset.tmdbId);
                    const mediaType = moreInfoLink.dataset.mediaType;
                    if (tmdbId && mediaType) {
                        JE.jellyseerrMoreInfo.open(tmdbId, mediaType);
                    }
                    return;
                }

                // For external Seerr links the <a> has is="emby-linkbutton" — let default run.
                const isPlainLeftClick = e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
                if (isExternalJellyseerrLink && isPlainLeftClick) {
                    return;
                }
            }, true);
        }

        if (JE.pluginConfig.ShowElsewhereOnJellyseerr && JE.pluginConfig.TmdbEnabled && item.mediaType !== 'collection') {
            internal.fetchProviderIcons(card.querySelector('.jellyseerr-elsewhere-icons'), item.id, item.mediaType);
        }

        // Add hide button for hidden content feature
        if (JE.hiddenContent && JE.hiddenContent.getSettings().enabled && JE.hiddenContent.getSettings().showHideButtons !== false && JE.hiddenContent.getSettings().showButtonJellyseerr !== false) {
            const cardBox = card.querySelector('.cardBox');
            if (cardBox) {
                const hideBtn = document.createElement('button');
                const hiddenLabel = JE.t('hidden_content_already_hidden') !== 'hidden_content_already_hidden' ? JE.t('hidden_content_already_hidden') : 'Hidden';
                const unhideLabel = JE.t('hidden_content_unhide') !== 'hidden_content_unhide' ? JE.t('hidden_content_unhide') : 'Unhide';
                const hideLabel = JE.t('hidden_content_hide_button') !== 'hidden_content_hide_button' ? JE.t('hidden_content_hide_button') : 'Hide';
                const unhideKey = jellyfinMediaId || `tmdb-${item.id}`;

                /**
                 * Replaces the hide button's content with a material icon.
                 * @param {string} iconName - Material icon name (e.g. 'visibility', 'visibility_off').
                 */
                function renderHideIcon(iconName) {
                    hideBtn.replaceChildren();
                    const icon = document.createElement('span');
                    icon.className = 'material-icons';
                    icon.setAttribute('aria-hidden', 'true');
                    icon.textContent = iconName || 'visibility';
                    hideBtn.appendChild(icon);
                }

                /**
                 * Switches the hide button to "already hidden" state with unhide-on-click behaviour.
                 */
                function setHiddenState() {
                    hideBtn.className = 'je-hide-btn je-already-hidden';
                    hideBtn.title = hiddenLabel;
                    renderHideIcon('visibility_off');
                    hideBtn.onmouseenter = () => {
                        hideBtn.title = unhideLabel;
                    };
                    hideBtn.onmouseleave = () => {
                        hideBtn.title = hiddenLabel;
                    };
                    hideBtn.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        JE.hiddenContent.unhideItem(unhideKey);
                        setHideState();
                    };
                }

                /**
                 * Switches the hide button to the default "hide" state with confirm-and-hide-on-click behaviour.
                 */
                function setHideState() {
                    hideBtn.className = 'je-hide-btn';
                    hideBtn.title = hideLabel;
                    renderHideIcon('visibility');
                    hideBtn.onmouseenter = null;
                    hideBtn.onmouseleave = null;
                    hideBtn.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        JE.hiddenContent.confirmAndHide({
                            itemId: jellyfinMediaId || '',
                            name: titleText,
                            type: item.mediaType === 'tv' ? 'Series' : 'Movie',
                            tmdbId: item.id,
                            posterPath: item.posterPath || ''
                        }, () => {
                            card.style.display = 'none';
                        });
                    };
                }

                if (JE.hiddenContent.isHiddenByTmdbId(item.id)) {
                    setHiddenState();
                } else {
                    setHideState();
                }
                cardBox.style.position = 'relative';
                cardBox.appendChild(hideBtn);
            }
        }

        return card;
    }
    ui.createJellyseerrCard = createJellyseerrCard;

    internal.createJellyseerrCard = createJellyseerrCard;

})(window.JellyfinEnhanced);
