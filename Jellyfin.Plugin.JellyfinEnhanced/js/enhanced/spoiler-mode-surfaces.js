/**
 * @file Spoiler Mode Surfaces — detail page, search, player overlay, calendar,
 * toggle button, and confirmation dialog.
 *
 * Depends on: spoiler-mode.js (core) and spoiler-mode-redaction.js must load first.
 */
(function (JE) {
    'use strict';

    var core = JE._spoilerCore;
    if (!core) {
        console.warn('🪼 Jellyfin Enhanced: spoiler-mode-surfaces.js loaded before core');
        return;
    }

    // ============================================================
    // Local helpers
    // ============================================================

    /**
     * Extracts the Jellyfin item ID from a card element.
     * @param {HTMLElement} el The card element.
     * @returns {string|null} The item ID or null.
     */
    function getCardItemId(el) {
        return el.dataset?.id || el.dataset?.itemid || null;
    }

    // ============================================================
    // Spoiler confirmation dialog
    // ============================================================

    /**
     * Shows a confirmation dialog when the user clicks an active spoiler toggle.
     * Offers: Reveal Temporarily, Disable Protection, or Cancel.
     *
     * Accessibility: the overlay is marked as a modal dialog with aria attributes,
     * initial focus is placed on the reveal button, a focus trap keeps Tab within
     * the dialog, and focus is restored to the trigger element on close.
     *
     * @param {string} itemName Display name of the item.
     * @param {Function} onReveal Called when user chooses temporary reveal.
     * @param {Function} onDisable Called when user chooses to disable protection.
     */
    function showSpoilerConfirmation(itemName, onReveal, onDisable) {
        // Store the currently focused element so we can restore focus on close
        var triggerElement = document.activeElement;

        // Remove any existing confirmation overlay
        var existing = document.querySelector('.je-spoiler-confirm-overlay');
        if (existing) existing.remove();

        var overlay = document.createElement('div');
        overlay.className = 'je-spoiler-confirm-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'je-spoiler-confirm-title');

        var dialog = document.createElement('div');
        dialog.className = 'je-spoiler-confirm-dialog';

        var title = document.createElement('h3');
        title.id = 'je-spoiler-confirm-title';
        title.textContent = core.tFallback('spoiler_mode_confirm_title', 'Spoiler Protection');
        dialog.appendChild(title);

        var body = document.createElement('p');
        body.textContent = core.tFallback('spoiler_mode_confirm_body', 'What would you like to do with spoiler protection for "{name}"?').replace('{name}', itemName);
        dialog.appendChild(body);

        var buttons = document.createElement('div');
        buttons.className = 'je-spoiler-confirm-buttons';

        /**
         * Closes the dialog, removes event listeners, and restores focus.
         */
        var closeDialog = function () {
            overlay.remove();
            document.removeEventListener('keydown', keyHandler);
            if (triggerElement) triggerElement.focus();
        };

        var revealBtn = document.createElement('button');
        revealBtn.className = 'je-spoiler-confirm-btn je-spoiler-confirm-reveal';
        revealBtn.textContent = core.tFallback('spoiler_mode_confirm_reveal', 'Reveal Temporarily');
        revealBtn.addEventListener('click', function () { closeDialog(); onReveal(); });
        buttons.appendChild(revealBtn);

        var disableBtn = document.createElement('button');
        disableBtn.className = 'je-spoiler-confirm-btn je-spoiler-confirm-disable';
        disableBtn.textContent = core.tFallback('spoiler_mode_confirm_disable', 'Disable Protection');
        disableBtn.addEventListener('click', function () { closeDialog(); onDisable(); });
        buttons.appendChild(disableBtn);

        var cancelBtn = document.createElement('button');
        cancelBtn.className = 'je-spoiler-confirm-btn je-spoiler-confirm-cancel';
        cancelBtn.textContent = core.tFallback('spoiler_mode_confirm_cancel', 'Cancel');
        cancelBtn.addEventListener('click', closeDialog);
        buttons.appendChild(cancelBtn);

        dialog.appendChild(buttons);
        overlay.appendChild(dialog);

        // Close when clicking the backdrop (outside the dialog)
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeDialog();
        });

        // All focusable buttons in order
        var focusableButtons = [revealBtn, disableBtn, cancelBtn];

        /**
         * Handles keyboard events: Escape to close, Tab focus trapping.
         * @param {KeyboardEvent} e
         */
        var keyHandler = function (e) {
            if (e.key === 'Escape') {
                closeDialog();
                return;
            }

            // Focus trap: keep Tab cycling within the dialog buttons
            if (e.key === 'Tab') {
                var firstBtn = focusableButtons[0];
                var lastBtn = focusableButtons[focusableButtons.length - 1];

                if (e.shiftKey) {
                    // Shift+Tab at first button wraps to last
                    if (document.activeElement === firstBtn) {
                        e.preventDefault();
                        lastBtn.focus();
                    }
                } else {
                    // Tab at last button wraps to first
                    if (document.activeElement === lastBtn) {
                        e.preventDefault();
                        firstBtn.focus();
                    }
                }
            }
        };
        document.addEventListener('keydown', keyHandler);

        document.body.appendChild(overlay);

        // Set initial focus to the reveal button
        revealBtn.focus();
    }

    // ============================================================
    // Detail page toggle button
    // ============================================================

    /**
     * Adds a "Spoiler Mode" toggle button to the item detail page action buttons.
     * @param {string} itemId The item's Jellyfin ID.
     * @param {string} itemType The item type (Series, Movie, BoxSet).
     * @param {HTMLElement} visiblePage The visible detail page element.
     */
    function addSpoilerToggleButton(itemId, itemType, visiblePage) {
        // Only show for Series, Movies, and BoxSets (collections)
        if (itemType !== 'Series' && itemType !== 'Movie' && itemType !== 'BoxSet') return;

        // Respect the enabled and showButtons user settings
        var settings = core.getSettings();
        if (settings.enabled === false || settings.showButtons === false) return;

        // Don't add duplicate
        if (visiblePage.querySelector('.je-spoiler-toggle-btn')) return;

        var buttonContainer = core.findButtonContainer(visiblePage);
        if (!buttonContainer) return;

        var button = document.createElement('button');
        button.setAttribute('is', 'emby-button');
        button.className = 'button-flat detailButton emby-button je-spoiler-toggle-btn';
        button.type = 'button';

        var content = document.createElement('div');
        content.className = 'detailButton-content';
        button.appendChild(content);

        /**
         * Renders the button icon and label using safe DOM methods.
         * @param {string} iconName Material icon name.
         * @param {boolean} isActive Whether spoiler mode is active.
         */
        function renderContent(iconName, isActive) {
            content.replaceChildren();
            var icon = document.createElement('span');
            icon.className = 'material-icons detailButton-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = iconName;
            content.appendChild(icon);

            var textSpan = document.createElement('span');
            textSpan.className = 'detailButton-icon-text';
            textSpan.textContent = isActive
                ? core.tFallback('spoiler_mode_active', 'Spoiler On')
                : core.tFallback('spoiler_mode_off', 'Spoiler Off');
            content.appendChild(textSpan);
        }

        /**
         * Syncs the toggle button's CSS class, tooltip text, and icon
         * with the current spoiler rule for this item.
         */
        function updateState() {
            var rule = core.getRule(itemId);
            var active = rule?.enabled === true;

            if (active) {
                button.classList.add('je-spoiler-active');
                button.title = core.tFallback('spoiler_mode_disable_tooltip', 'Click to disable Spoiler Mode');
                renderContent('shield', true);
            } else {
                button.classList.remove('je-spoiler-active');
                button.title = core.tFallback('spoiler_mode_enable_tooltip', 'Click to enable Spoiler Mode');
                renderContent('shield_outlined', false);
            }
        }

        button.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();

            var rule = core.getRule(itemId);
            var isCurrentlyActive = rule?.enabled === true;

            // Get item name from the page title
            var nameEl = visiblePage.querySelector('.itemName, h1, h2, [class*="itemName"]');
            var itemName = nameEl?.textContent?.trim() || 'Unknown';

            // Enabling is always instant
            if (!isCurrentlyActive) {
                core.setRule({ itemId: itemId, itemName: itemName, itemType: itemType, enabled: true });
                updateState();
                JE.toast(JE.icon(JE.IconName.SHIELD) + ' ' + core.tFallback('spoiler_mode_enabled_toast', 'Spoiler Mode enabled'));
                setTimeout(function () { if (core.processCurrentPage) core.processCurrentPage(); }, core.TOGGLE_RESCAN_DELAY_MS);
                return;
            }

            // Disabling — show confirmation dialog with reveal option
            var currentSettings = core.getSettings();
            if (currentSettings.showDisableConfirmation !== false) {
                showSpoilerConfirmation(
                    itemName,
                    // Reveal temporarily
                    function () {
                        if (core.activateRevealAll) core.activateRevealAll();
                    },
                    // Disable protection
                    function () {
                        core.setRule({ itemId: itemId, itemName: itemName, itemType: itemType, enabled: false });
                        updateState();
                        JE.toast(JE.icon(JE.IconName.SHIELD) + ' ' + core.tFallback('spoiler_mode_disabled_toast', 'Spoiler Mode disabled'));
                        setTimeout(function () { if (core.processCurrentPage) core.processCurrentPage(); }, core.TOGGLE_RESCAN_DELAY_MS);
                    }
                );
            } else {
                core.setRule({ itemId: itemId, itemName: itemName, itemType: itemType, enabled: false });
                updateState();
                JE.toast(JE.icon(JE.IconName.SHIELD) + ' ' + core.tFallback('spoiler_mode_disabled_toast', 'Spoiler Mode disabled'));
                setTimeout(function () { if (core.processCurrentPage) core.processCurrentPage(); }, core.TOGGLE_RESCAN_DELAY_MS);
            }
        });

        updateState();

        // Insert before the overflow menu (three-dots) button
        var moreButton = buttonContainer.querySelector('.btnMoreCommands');
        if (moreButton) {
            buttonContainer.insertBefore(button, moreButton);
        } else {
            buttonContainer.appendChild(button);
        }
    }

    // ============================================================
    // Overview hide with reveal
    // ============================================================

    /**
     * Hides overview text and binds a click-to-reveal handler that auto-hides
     * after the configured reveal duration. Used on collection and movie
     * detail pages where the simpler (non-re-entrant) reveal pattern suffices.
     * @param {HTMLElement} visiblePage The visible detail page element.
     */
    function hideOverviewWithReveal(visiblePage) {
        var overviewEl = visiblePage.querySelector('.overview, .itemOverview');
        if (!overviewEl || overviewEl.classList.contains('je-spoiler-overview-hidden')) return;

        var settings = core.getSettings();
        overviewEl.dataset.jeSpoilerOriginal = overviewEl.textContent;
        var hiddenText = core.tFallback('spoiler_mode_hidden_overview', 'Overview hidden \u2014 click to reveal');
        overviewEl.textContent = hiddenText;
        overviewEl.classList.add('je-spoiler-overview-hidden');
        if (overviewEl.dataset.jeSpoilerOverviewBound) return;
        overviewEl.dataset.jeSpoilerOverviewBound = '1';
        overviewEl.addEventListener('click', function () {
            if (overviewEl.classList.contains('je-spoiler-overview-hidden')) {
                overviewEl.textContent = overviewEl.dataset.jeSpoilerOriginal;
                overviewEl.classList.remove('je-spoiler-overview-hidden');
                setTimeout(function () {
                    if (!core.revealAllActive) {
                        overviewEl.textContent = hiddenText;
                        overviewEl.classList.add('je-spoiler-overview-hidden');
                    }
                }, settings.revealDuration || core.DEFAULT_REVEAL_DURATION);
            }
        });
    }

    // ============================================================
    // Poster click-to-reveal
    // ============================================================

    /**
     * Binds a click-to-reveal handler on a blurred poster element.
     * Temporarily removes blur on click, re-applies after revealDuration.
     * Works for both inline-style blur and CSS-class blur.
     * @param {HTMLElement} el The blurred poster element.
     * @param {boolean} [useCssClass] If true, toggle je-spoiler-poster-revealed class instead of inline style.
     */
    function bindPosterReveal(el, useCssClass) {
        if (!el || el.dataset.jeSpoilerPosterBound) return;
        el.dataset.jeSpoilerPosterBound = '1';
        el.style.cursor = 'pointer';

        // Add "Click to reveal" overlay OUTSIDE the blurred element (as sibling)
        // so it doesn't get blurred. Parent .detailImageContainer is not blurred.
        var container = el.closest('.detailImageContainer');
        var overlay = null;
        if (container && !container.querySelector('.je-spoiler-poster-overlay')) {
            container.style.position = 'relative';
            overlay = document.createElement('div');
            overlay.className = 'je-spoiler-poster-overlay';
            overlay.textContent = core.tFallback('spoiler_mode_click_reveal', 'Click to reveal');
            container.appendChild(overlay);
        }

        el.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();

            var revealDuration = core.getSettings().revealDuration || core.DEFAULT_REVEAL_DURATION;

            if (overlay) overlay.style.display = 'none';
            if (useCssClass) {
                el.classList.add('je-spoiler-poster-revealed');
            } else {
                el.dataset.jeSpoilerOriginalFilter = el.style.filter || '';
                el.style.filter = 'none';
            }

            setTimeout(function () {
                if (core.revealAllActive) return;
                if (overlay) overlay.style.display = '';
                if (useCssClass) {
                    el.classList.remove('je-spoiler-poster-revealed');
                } else {
                    el.style.filter = el.dataset.jeSpoilerOriginalFilter || 'blur(' + core.BLUR_RADIUS + ')';
                }
            }, revealDuration);
        });

        // Also allow clicking the overlay itself
        if (overlay) {
            overlay.style.cursor = 'pointer';
            overlay.style.pointerEvents = 'auto';
            overlay.addEventListener('click', function () { el.click(); });
        }
    }

    // ============================================================
    // Detail page episode list redaction
    // ============================================================

    /**
     * Scans the episode list on a series/season detail page and applies
     * spoiler redaction to unwatched episodes. Also handles overview
     * hiding, backdrop blur, and chapter redaction.
     * @param {string} itemId The series or season ID.
     * @param {HTMLElement} visiblePage The visible detail page element.
     * @returns {Promise<void>}
     */
    async function redactEpisodeList(itemId, visiblePage) {
        if (core.revealAllActive) return;

        var seriesId = itemId;
        var detailItem = null;
        var userId = ApiClient.getCurrentUserId();

        try {
            detailItem = await ApiClient.getItem(userId, itemId);
            if (detailItem?.Type === 'Season') {
                seriesId = detailItem.SeriesId || itemId;
            } else if (detailItem?.Type !== 'Series') {
                return;
            }
        } catch (err) {
            return;
        }

        if (!core.isProtected(seriesId)) return;

        var settings = core.getSettings();
        var isSeasonDetail = detailItem?.Type === 'Season';
        var shouldHideOverview = !settings.showSeriesOverview;
        var overviewEl = visiblePage.querySelector('.overview, .itemOverview');

        // If this is a season detail page and that season is fully watched,
        // there is no spoiler risk in the overview text.
        if (shouldHideOverview && isSeasonDetail) {
            var fullyWatchedSeason = await core.isSeasonFullyWatched(itemId);
            if (fullyWatchedSeason) {
                shouldHideOverview = false;
                if (overviewEl) {
                    overviewEl.dataset.jeSpoilerOverviewSafeFor = itemId;
                }
                core.setDetailOverviewPending(false);
            }
        }

        // Redact the series/movie overview if configured (using textContent)
        var hiddenText = core.tFallback('spoiler_mode_hidden_overview', 'Overview hidden \u2014 click to reveal');
        var restoreOverview = function () {
            if (!overviewEl) return;
            if (overviewEl.dataset.jeSpoilerOriginal) {
                overviewEl.textContent = overviewEl.dataset.jeSpoilerOriginal;
                delete overviewEl.dataset.jeSpoilerOriginal;
            }
            delete overviewEl.dataset.jeSpoilerRevealUntil;
            overviewEl.classList.remove(core.OVERVIEW_REVEALED_CLASS);
            overviewEl.classList.remove('je-spoiler-overview-hidden');
        };

        if (overviewEl && !overviewEl.dataset.jeSpoilerOverviewBound) {
            overviewEl.dataset.jeSpoilerOverviewBound = '1';
            overviewEl.addEventListener('click', function () {
                if (!overviewEl.classList.contains('je-spoiler-overview-hidden')) return;
                if (!overviewEl.dataset.jeSpoilerOriginal) return;

                var revealDuration = core.getSettings().revealDuration || core.DEFAULT_REVEAL_DURATION;
                overviewEl.dataset.jeSpoilerRevealUntil = String(Date.now() + revealDuration);
                overviewEl.textContent = overviewEl.dataset.jeSpoilerOriginal;
                overviewEl.classList.add(core.OVERVIEW_REVEALED_CLASS);
                overviewEl.classList.remove('je-spoiler-overview-hidden');

                // Auto-hide after reveal duration unless extended by another click.
                setTimeout(function () {
                    var revealUntil = Number(overviewEl.dataset.jeSpoilerRevealUntil || '0');
                    if (core.revealAllActive || Date.now() < revealUntil) return;
                    overviewEl.textContent = hiddenText;
                    overviewEl.classList.remove(core.OVERVIEW_REVEALED_CLASS);
                    overviewEl.classList.add('je-spoiler-overview-hidden');
                }, revealDuration);
            });
        }

        if (shouldHideOverview) {
            if (overviewEl) {
                var revealUntil = Number(overviewEl.dataset.jeSpoilerRevealUntil || '0');
                var stillRevealed = revealUntil > Date.now();

                // Keep user reveal state during ongoing detail-page mutations.
                if (stillRevealed) {
                    if (overviewEl.dataset.jeSpoilerOriginal) {
                        overviewEl.textContent = overviewEl.dataset.jeSpoilerOriginal;
                    }
                    overviewEl.classList.add(core.OVERVIEW_REVEALED_CLASS);
                    overviewEl.classList.remove('je-spoiler-overview-hidden');
                } else if (!overviewEl.classList.contains('je-spoiler-overview-hidden')) {
                    delete overviewEl.dataset.jeSpoilerOverviewSafeFor;
                    overviewEl.dataset.jeSpoilerOriginal = overviewEl.textContent;
                    overviewEl.textContent = hiddenText;
                    overviewEl.classList.remove(core.OVERVIEW_REVEALED_CLASS);
                    overviewEl.classList.add('je-spoiler-overview-hidden');
                }
            }
        } else if (overviewEl && overviewEl.classList.contains('je-spoiler-overview-hidden')) {
            restoreOverview();
            if (isSeasonDetail) {
                overviewEl.dataset.jeSpoilerOverviewSafeFor = itemId;
            }
        }

        // Blur backdrop when artwork policy is generic or guest stars are hidden
        if (settings.artworkPolicy === 'generic' || settings.hideGuestStars) {
            var backdropEl = visiblePage.querySelector('.backdropImage, .detailImageContainer img');
            if (backdropEl) {
                backdropEl.style.filter = 'blur(' + core.BLUR_RADIUS + ')';
                backdropEl.style.transition = 'filter 0.3s ease';
            }
        }

        // Process episode cards on the detail page in parallel
        var episodeCards = visiblePage.querySelectorAll('.card[data-id], .listItem[data-id]');
        var promises = [];
        for (var i = 0; i < episodeCards.length; i++) {
            var card = episodeCards[i];
            if (card.hasAttribute(core.SCANNED_ATTR)) continue;
            card.setAttribute(core.PROCESSED_ATTR, '1');
            if (core.processCard) {
                promises.push(core.processCard(card));
            }
        }
        await Promise.all(promises);

        // Redact chapter cards if present (episodes can have Scenes sections too)
        await redactDetailPageChapters(itemId, visiblePage);

        // On season-focused views with no redacted episode cards, keep overview visible.
        if (shouldHideOverview && overviewEl && episodeCards.length > 0) {
            var hasRedactedCards = Array.from(episodeCards).some(function (card) {
                return card.hasAttribute(core.REDACTED_ATTR);
            });
            if (!hasRedactedCards) {
                restoreOverview();
                if (isSeasonDetail) {
                    overviewEl.dataset.jeSpoilerOverviewSafeFor = itemId;
                }
                core.setDetailOverviewPending(false);
            } else {
                delete overviewEl.dataset.jeSpoilerOverviewSafeFor;
            }
        }
    }

    // ============================================================
    // Detail page chapter redaction
    // ============================================================

    /**
     * Redacts chapter cards on a detail page, skipping chapters the user has
     * already watched (based on PlaybackPositionTicks).
     * @param {string} itemId The movie or episode Jellyfin ID.
     * @param {HTMLElement} visiblePage The visible detail page element.
     * @returns {Promise<void>}
     */
    async function redactDetailPageChapters(itemId, visiblePage) {
        if (core.revealAllActive) return;

        var chapterCards = visiblePage.querySelectorAll('.chapterCard[data-positionticks]');
        if (chapterCards.length === 0) return;

        // Skip if chapters were already processed for this item
        if (visiblePage.dataset.jeSpoilerChaptersProcessed === itemId) return;

        var playbackPositionTicks = 0;
        try {
            if (!core.isValidId(itemId)) return;

            var userId = ApiClient.getCurrentUserId();
            var item = await ApiClient.getItem(userId, itemId);

            playbackPositionTicks = item?.UserData?.PlaybackPositionTicks || 0;
        } catch (err) {
            // If we can't fetch position, redact all chapters to be safe
            playbackPositionTicks = 0;
        }

        // Mark as processed to prevent race conditions from duplicate calls
        visiblePage.dataset.jeSpoilerChaptersProcessed = itemId;

        var chapterIndex = 0;
        for (var i = 0; i < chapterCards.length; i++) {
            chapterIndex++;
            var positionTicks = parseInt(chapterCards[i].dataset.positionticks, 10);
            if (!isNaN(positionTicks) && positionTicks <= playbackPositionTicks) continue;
            if (core.redactChapterCard) {
                core.redactChapterCard(chapterCards[i], chapterIndex);
            }
        }
    }

    // ============================================================
    // Collection page redaction
    // ============================================================

    /**
     * Redacts unwatched movie cards on a BoxSet (collection) detail page.
     * @param {string} collectionId The BoxSet Jellyfin ID.
     * @param {HTMLElement} visiblePage The visible detail page element.
     * @returns {Promise<void>}
     */
    async function redactCollectionPage(collectionId, visiblePage) {
        if (core.revealAllActive) return;
        if (!core.isProtected(collectionId)) return;

        // Fetch collection items to populate cache
        await core.fetchCollectionItems(collectionId);

        // Hide overview if configured
        var settings = core.getSettings();
        if (!settings.showSeriesOverview) {
            hideOverviewWithReveal(visiblePage);
        }

        // Process all movie cards on the collection page
        var movieCards = visiblePage.querySelectorAll('.card[data-id], .listItem[data-id]');
        var promises = [];
        for (var i = 0; i < movieCards.length; i++) {
            var card = movieCards[i];
            card.setAttribute(core.PROCESSED_ATTR, '1');
            var movieId = getCardItemId(card);
            if (!movieId) continue;

            promises.push((function (cardRef, mId) {
                return (async function () {
                    var watched = await core.isMovieWatched(mId);
                    if (!watched) {
                        if (core.blurCardArtwork) core.blurCardArtwork(cardRef);
                        if (core.bindCardReveal) core.bindCardReveal(cardRef);
                    }
                    cardRef.setAttribute(core.SCANNED_ATTR, '1');
                })();
            })(card, movieId));
        }
        await Promise.all(promises);
    }

    // ============================================================
    // Movie detail page redaction
    // ============================================================

    /**
     * Redacts a directly-protected movie's detail page when unwatched.
     * Hides overview and optionally blurs backdrop.
     * @param {string} movieId The movie Jellyfin ID.
     * @param {HTMLElement} visiblePage The visible detail page element.
     * @returns {Promise<void>}
     */
    async function redactMovieDetailPage(movieId, visiblePage) {
        if (core.revealAllActive) return;

        var watched = await core.isMovieWatched(movieId);
        if (watched) return;

        var settings = core.getSettings();

        /**
         * Applies overview, poster, and backdrop redaction.
         * Called immediately and again after a delay to catch late-rendered elements.
         */
        function applyMovieRedaction() {
            if (core.revealAllActive) return;

            hideOverviewWithReveal(visiblePage);

            if (settings.artworkPolicy === 'blur' || settings.artworkPolicy === 'generic') {
                var backdropEl = document.querySelector('.backdropImage');
                if (backdropEl && !backdropEl.style.filter) {
                    backdropEl.style.filter = 'blur(' + core.BLUR_RADIUS + ')';
                    backdropEl.style.transition = 'filter 0.3s ease';
                }
                var posterEl = visiblePage.querySelector('.detailImageContainer .cardImageContainer');
                if (posterEl && !posterEl.style.filter) {
                    posterEl.style.filter = 'blur(' + core.BLUR_RADIUS + ')';
                    posterEl.style.transition = 'filter 0.3s ease';
                }
                // Bind click-to-reveal on movie poster (blurred via inline style)
                if (posterEl) bindPosterReveal(posterEl, false);
            }
        }

        applyMovieRedaction();

        // Redact chapter cards (Scenes section), skipping already-watched chapters
        await redactDetailPageChapters(movieId, visiblePage);

        // Re-apply after Jellyfin finishes rendering (overview, backdrop, chapters render async)
        setTimeout(function () {
            applyMovieRedaction();
            delete visiblePage.dataset.jeSpoilerChaptersProcessed;
            redactDetailPageChapters(movieId, visiblePage);
        }, 800);
        setTimeout(function () {
            applyMovieRedaction();
            delete visiblePage.dataset.jeSpoilerChaptersProcessed;
            redactDetailPageChapters(movieId, visiblePage);
        }, 2000);
    }

    // ============================================================
    // Episode detail page redaction
    // ============================================================

    /**
     * Redacts an unwatched episode's detail page when protectEpisodeDetails is on.
     * Hides overview, blurs backdrop and poster, hides metadata and chapters.
     * Optionally hides Guest Stars section when hideGuestStars is enabled.
     * @param {Object} episodeItem Jellyfin episode item with UserData.
     * @param {HTMLElement} visiblePage The visible detail page element.
     * @returns {Promise<void>}
     */
    async function redactEpisodeDetailPage(episodeItem, visiblePage) {
        if (core.revealAllActive) return;

        var settings = core.getSettings();
        if (!settings.protectEpisodeDetails) return;
        if (!core.shouldRedactEpisode(episodeItem)) return;

        try {
            var redactedTitle = core.formatRedactedTitle(
                episodeItem.ParentIndexNumber,
                episodeItem.IndexNumber,
                episodeItem.IndexNumberEnd,
                episodeItem.ParentIndexNumber === 0
            );

            /**
             * Applies title, overview, and backdrop redaction for the episode.
             * Called immediately and again after a delay to catch late-rendered elements.
             */
            function applyEpisodeRedaction() {
                if (core.revealAllActive) return;

                // Redact episode title with click-to-reveal
                var nameEl = visiblePage.querySelector('.itemName, h3.itemName');
                if (nameEl && !nameEl.classList.contains('je-spoiler-text-redacted')) {
                    nameEl.dataset.jeSpoilerOriginal = nameEl.textContent;
                    nameEl.textContent = redactedTitle;
                    nameEl.classList.add('je-spoiler-text-redacted');
                    nameEl.style.cursor = 'pointer';

                    if (!nameEl.dataset.jeSpoilerTitleBound) {
                        nameEl.dataset.jeSpoilerTitleBound = '1';
                        nameEl.addEventListener('click', function () {
                            if (!nameEl.classList.contains('je-spoiler-text-redacted')) return;
                            if (!nameEl.dataset.jeSpoilerOriginal) return;

                            nameEl.textContent = nameEl.dataset.jeSpoilerOriginal;
                            nameEl.classList.remove('je-spoiler-text-redacted');

                            var revealDuration = core.getSettings().revealDuration || core.DEFAULT_REVEAL_DURATION;
                            setTimeout(function () {
                                if (core.revealAllActive) return;
                                nameEl.textContent = redactedTitle;
                                nameEl.classList.add('je-spoiler-text-redacted');
                            }, revealDuration);
                        });
                    }
                }

                hideOverviewWithReveal(visiblePage);

                // Bind click-to-reveal on episode poster (blurred via CSS class)
                var epPosterEl = visiblePage.querySelector('.detailImageContainer .cardImageContainer');
                if (epPosterEl) bindPosterReveal(epPosterEl, true);

                // Blur backdrop image (lives outside #itemDetailPage in .backdropContainer)
                var backdropEl = document.querySelector('.backdropImage');
                if (backdropEl && !backdropEl.style.filter) {
                    backdropEl.style.filter = 'blur(' + core.BLUR_RADIUS + ')';
                    backdropEl.style.transition = 'filter 0.3s ease';
                }
            }

            applyEpisodeRedaction();

            // Add CSS class that blurs poster and hides metadata (runtime, genres, external links)
            if (!visiblePage.classList.contains('je-spoiler-episode-protected')) {
                visiblePage.classList.add('je-spoiler-episode-protected');
            }

            // Hide Guest Stars section only when hideGuestStars is enabled
            if (settings.hideGuestStars) {
                var allHeadings = document.querySelectorAll('#itemDetailPage .sectionTitle, #itemDetailPage h2, #itemDetailPage h3');
                for (var i = 0; i < allHeadings.length; i++) {
                    var text = (allHeadings[i].textContent || '').trim().toLowerCase();
                    if (text === 'guest stars' || text === 'guests') {
                        var section = allHeadings[i].closest('.verticalSection, .detailSection, .detailVerticalSection');
                        if (section && !section.classList.contains('je-spoiler-metadata-hidden')) {
                            section.classList.add('je-spoiler-metadata-hidden');
                        }
                    }
                }
            }

            // Redact chapter cards (Scenes section)
            await redactDetailPageChapters(episodeItem.Id, visiblePage);

            // Re-apply after Jellyfin finishes rendering (title, backdrop, overview, chapters render async)
            var epId = episodeItem.Id;
            setTimeout(function () {
                applyEpisodeRedaction();
                // Reset chapter processed flag so delayed call can re-scan for newly rendered chapters
                delete visiblePage.dataset.jeSpoilerChaptersProcessed;
                redactDetailPageChapters(epId, visiblePage);
            }, 800);
            setTimeout(function () {
                applyEpisodeRedaction();
                delete visiblePage.dataset.jeSpoilerChaptersProcessed;
                redactDetailPageChapters(epId, visiblePage);
            }, 2000);
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: Failed to fully redact episode detail page', episodeItem?.Id, err);
        }
    }

    // ============================================================
    // Search result redaction
    // ============================================================

    /**
     * Redacts episode results in search that belong to protected series.
     * Delegates to filterNewCards from the observer module.
     */
    function redactSearchResults() {
        var settings = core.getSettings();
        if (settings.enabled === false) return;
        if (!settings.protectSearch) return;
        if (core.protectedIdSet.size === 0) return;
        if (core.filterNewCards) core.filterNewCards();
    }

    // ============================================================
    // Player overlay redaction
    // ============================================================

    /**
     * Redacts episode title and chapter names in the player OSD.
     * For episodes, checks boundary; for movies, checks watched state.
     * Blurs chapter thumbnail previews that are past the playback position.
     * @param {string} itemId The currently playing item ID.
     * @returns {Promise<void>}
     */
    async function redactPlayerOverlay(itemId) {
        if (!itemId) return;
        if (core.revealAllActive) return;

        var settings = core.getSettings();
        if (settings.enabled === false) return;
        if (!settings.protectOverlay) return;

        var seriesId = await core.getParentSeriesId(itemId);
        var itemIsProtected = false;
        if (seriesId && core.isProtected(seriesId)) {
            itemIsProtected = true;
        } else if (core.isProtected(itemId) || await core.getProtectedCollectionForMovie(itemId)) {
            itemIsProtected = true;
        }
        if (!itemIsProtected) return;

        try {
            if (!core.isValidId(itemId)) return;

            var item = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Items/' + itemId, {
                    Fields: 'UserData,ParentIndexNumber,IndexNumber'
                }),
                dataType: 'json'
            });

            if (!item) return;

            var isMovie = item.Type === 'Movie';

            // For episodes, check boundary; for movies, check watched state
            if (isMovie) {
                if (item.UserData?.Played) return;
            } else {
                if (!core.shouldRedactEpisode(item)) return;
            }

            // Redact OSD title using textContent (XSS-safe)
            if (!isMovie) {
                var redactedTitle = core.formatRedactedTitle(
                    item.ParentIndexNumber,
                    item.IndexNumber,
                    item.IndexNumberEnd,
                    item.ParentIndexNumber === 0
                );

                var titleSelectors = [
                    '.osdTitle',
                    '.videoOsdTitle',
                    '.osd-title',
                    '.mediaInfoPrimaryContainer h3',
                    '.nowPlayingPageTitle'
                ];

                for (var s = 0; s < titleSelectors.length; s++) {
                    var el = document.querySelector(titleSelectors[s]);
                    if (el && el.textContent && !el.classList.contains('je-spoiler-osd-redacted')) {
                        el.dataset.jeSpoilerOriginal = el.textContent;
                        el.textContent = (item.SeriesName || '') + ' \u2014 ' + redactedTitle;
                        el.classList.add('je-spoiler-osd-redacted');
                    }
                }
            }

            // Redact chapter names, skipping already-watched chapters
            var playbackTicks = item.UserData?.PlaybackPositionTicks || 0;
            var chapterElements = document.querySelectorAll('.chapterCard .chapterCardText, [data-chapter-name]');
            var chapterIndex = 1;
            for (var c = 0; c < chapterElements.length; c++) {
                var chapterEl = chapterElements[c];
                var parentCard = chapterEl.closest('.chapterCard');
                var chapterTicks = parentCard ? parseInt(parentCard.dataset.positionticks, 10) : NaN;

                // Skip chapters the user has already watched past
                if (!isNaN(chapterTicks) && chapterTicks <= playbackTicks) {
                    chapterIndex++;
                    continue;
                }

                if (!chapterEl.classList.contains('je-spoiler-osd-redacted')) {
                    chapterEl.dataset.jeSpoilerOriginal = chapterEl.textContent;
                    chapterEl.textContent = 'Chapter ' + chapterIndex;
                    chapterEl.classList.add('je-spoiler-osd-redacted');
                }
                chapterIndex++;
            }

            // Blur chapter thumbnail previews (position-aware)
            var chapterCards = document.querySelectorAll('.chapterCard');
            for (var k = 0; k < chapterCards.length; k++) {
                var cardTicks = parseInt(chapterCards[k].dataset.positionticks, 10);
                if (!isNaN(cardTicks) && cardTicks <= playbackTicks) continue;

                var imgs = chapterCards[k].querySelectorAll('img, .chapterCardImage');
                for (var m = 0; m < imgs.length; m++) {
                    imgs[m].style.filter = 'blur(' + core.BLUR_RADIUS + ')';
                    imgs[m].style.transition = 'filter 0.3s ease';
                }
            }

        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: Error redacting player overlay', err);
        }
    }

    // ============================================================
    // Calendar event redaction
    // ============================================================

    /**
     * Filters calendar events to redact episode titles for protected series.
     * Checks all GUID format variants (hyphenated, compact, lowercase)
     * because calendar payloads may use a different casing.
     * @param {Array} events Array of calendar event objects.
     * @returns {Array} Events with redacted titles where applicable.
     */
    function filterCalendarEvents(events) {
        var settings = core.getSettings();
        if (settings.enabled === false) return events;
        if (!settings.protectCalendar) return events;
        if (!Array.isArray(events) || core.protectedIdSet.size === 0) return events;

        /**
         * Checks all GUID format variants for a calendar item ID.
         * @param {string} calItemId Calendar item Jellyfin ID.
         * @returns {boolean}
         */
        function isProtectedCalendarItem(calItemId) {
            if (!calItemId) return false;
            var raw = String(calItemId);
            var compact = raw.replace(/-/g, '');
            var lower = raw.toLowerCase();
            var compactLower = compact.toLowerCase();
            return core.isProtected(raw) || core.isProtected(compact) || core.isProtected(lower) || core.isProtected(compactLower);
        }

        return events.map(function (event) {
            var releaseType = event.releaseType || event.ReleaseType;
            if (releaseType !== 'Episode') return event;

            // Calendar payload uses Jellyfin itemId/itemEpisodeId; seriesId is Sonarr's numeric ID.
            var protectedItemId = event.itemId || event.ItemId;
            if (!protectedItemId || !isProtectedCalendarItem(protectedItemId)) return event;

            var seasonNum = event.seasonNumber || event.ParentIndexNumber || 0;
            var epNum = event.episodeNumber || event.IndexNumber || 0;
            var redactedTitle = core.formatShortRedactedTitle(seasonNum, epNum);
            var seriesName = event.seriesName || event.SeriesName || event.title || event.Title || '';

            return {
                ...event,
                title: seriesName,
                subtitle: redactedTitle,
                episodeTitle: '',
                EpisodeTitle: '',
                overview: '',
                Overview: ''
            };
        });
    }

    // ============================================================
    // Register on core
    // ============================================================

    core.showSpoilerConfirmation = showSpoilerConfirmation;
    core.addSpoilerToggleButton = addSpoilerToggleButton;
    core.hideOverviewWithReveal = hideOverviewWithReveal;
    core.redactEpisodeList = redactEpisodeList;
    core.redactDetailPageChapters = redactDetailPageChapters;
    core.redactCollectionPage = redactCollectionPage;
    core.redactMovieDetailPage = redactMovieDetailPage;
    core.redactEpisodeDetailPage = redactEpisodeDetailPage;
    core.redactSearchResults = redactSearchResults;
    core.redactPlayerOverlay = redactPlayerOverlay;
    core.filterCalendarEvents = filterCalendarEvents;

})(window.JellyfinEnhanced);
