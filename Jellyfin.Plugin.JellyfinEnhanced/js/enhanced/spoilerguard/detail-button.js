// @ts-check
// Series, movie and collection detail-page Spoiler Guard toggle.
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    /** @type {any} Shared cross-file namespace; each module contributes a focused surface. */
    const internal = JE.internals.spoilerGuard = JE.internals.spoilerGuard || {};
    const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';

    /** Draws ON/OFF, or (null) an unknown state that waits for the state to be read again. */
    function renderButton(button, enabled) {
        const unknown = enabled === null;
        const label = JE.t(unknown ? 'spoiler_blur_state_retrying' : enabled ? 'spoiler_blur_button_on' : 'spoiler_blur_button_off');
        button.classList.toggle('je-spoiler-blur-on', enabled === true);
        if (unknown) button.removeAttribute('aria-pressed');
        else button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        button.setAttribute('aria-busy', unknown ? 'true' : 'false');
        button.disabled = unknown;
        button.title = label;
        button.setAttribute('aria-label', label);
        button.replaceChildren();
        const content = document.createElement('div');
        content.className = 'detailButton-content';
        const icon = document.createElement('span');
        icon.className = 'material-icons detailButton-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = unknown ? 'sync' : enabled ? 'blur_on' : 'blur_off';
        content.appendChild(icon);
        button.appendChild(content);
    }

    /** true/false from the mirrors, or null while they cannot answer for this title. */
    function stateOf(kind, itemId) {
        return internal.isKnownForKind?.(kind, itemId) !== false ? internal.isEnabledForKind(kind, itemId) : null;
    }
    const stateName = enabled => enabled === null ? 'unknown' : enabled ? 'on' : 'off';

    /**
     * Writes the toggle for `owner` (the press's). Its page effects (toast, the page's reviews, the reload) happen only
     * for a write that was sent, while `owner` is still current, and on the page it was pressed on (D46S2 audit S3);
     * the button shows the state whatever happened.
     */
    function performToggle(button, itemId, kind, page, enable, owner) {
        const action = JE.createSessionAction({ owner });
        let displayName = '';
        if ((kind === 'movie' || kind === 'collection') && page) {
            try {
                const title = page.querySelector('h1.itemName-name, h1.itemName, .itemName, h2.itemName-name');
                displayName = title?.textContent?.trim() || '';
            } catch (e) {
                console.warn(`${logPrefix} ${kind} title lookup failed:`, e);
            }
        }

        let operation;
        if (kind === 'movie') operation = enable ? internal.enableForMovie(itemId, displayName, owner) : internal.disableForMovie(itemId, owner);
        else if (kind === 'collection') operation = enable ? internal.enableForCollection(itemId, displayName, owner) : internal.disableForCollection(itemId, owner);
        else operation = enable ? internal.enableForSeries(itemId, owner) : internal.disableForSeries(itemId, owner);

        operation.then(function(result) {
            const enabled = stateOf(kind, itemId);
            renderButton(button, enabled);
            button.setAttribute('data-je-spoiler-state', stateName(enabled));
            if (result === internal.UNSENT || !action.current() || !page?.isConnected) return;
            // Keep separate per-kind keys so translators can tailor the
            // wording later; all enabled messages are deliberately
            // mode-neutral because images may be hidden or blurred.
            let key;
            if (enable) {
                key = kind === 'movie' ? 'spoiler_blur_enabled_movie_toast'
                    : kind === 'collection' ? 'spoiler_blur_enabled_collection_toast'
                        : 'spoiler_blur_enabled_toast';
            } else {
                key = kind === 'movie' ? 'spoiler_blur_disabled_movie_toast'
                    : kind === 'collection' ? 'spoiler_blur_disabled_collection_toast'
                        : 'spoiler_blur_disabled_toast';
            }
            JE.toast?.(JE.t(key));

            try {
                if (enable && JE.pluginConfig?.SpoilerStripReviews !== false
                    && internal.getUserPrefs().HideReviews !== false) {
                    // The reviews of the page it was pressed on, never whatever page is current by then.
                    const reviews = page.querySelector('.tmdb-reviews-section');
                    reviews?.parentNode?.removeChild(reviews);
                }
            } catch (e) {
                console.warn(`${logPrefix} reviews cleanup failed:`, e);
            }

            internal.scheduleFullReload();
        }).catch(function(err) {
            if (!action.current()) return;
            console.error(`${logPrefix} toggle failed:`, err);
            JE.toast?.(JE.t('spoiler_blur_error_toast'));
        }).finally(function() {
            button.disabled = stateOf(kind, itemId) === null;
        });
    }

    /** `owner`: the press's (JE.ownerOf(event)): the operation a title action pressed the button for, else native. */
    function onToggle(button, itemId, kind, page, owner) {
        const action = JE.createSessionAction({ owner });
        if (button.disabled || stateOf(kind, itemId) === null) return;
        const enable = !internal.isEnabledForKind(kind, itemId);
        button.disabled = true;
        if (enable) {
            performToggle(button, itemId, kind, page, true, owner);
            return;
        }
        internal.confirmDisableSpoiler(owner).then(function(proceed) {
            if (proceed && action.current()) performToggle(button, itemId, kind, page, false, owner);
            else button.disabled = false;
        }).catch(function(err) {
            console.warn(`${logPrefix} disable confirmation failed:`, err);
            button.disabled = false;
        });
    }

    // The buttons this module drew. A copy of one (an action row replaced by a copy of itself) has no
    // click handler, so it never counts and goes.
    const drawnButtons = new WeakSet();

    internal.addSpoilerBlurButton = function(itemId, visiblePage, itemType) {
        if (JE.pluginConfig?.SpoilerBlurEnabled !== true || !itemId || !visiblePage) return;
        if (JE.titleDetails?.isSynthetic?.(itemId)) {
            visiblePage.querySelectorAll('.je-spoiler-blur-btn').forEach(button => button.remove());
            return;
        }
        if (!internal.isStateLoaded()) return;
        const kind = internal.kindOf(itemType);
        const container = ['.detailButtons', '.itemActionsBottom', '.mainDetailButtons', '.detailButtonsContainer']
            .map(selector => visiblePage.querySelector(selector)).find(Boolean);
        if (!container) return;

        const enabled = stateOf(kind, itemId);
        const state = stateName(enabled);
        let button = null;
        for (const existing of visiblePage.querySelectorAll('.je-spoiler-blur-btn')) {
            if (!button && drawnButtons.has(existing)) button = existing;
            else existing.remove();
        }
        if (!button) {
            button = document.createElement('button');
            drawnButtons.add(button);
            button.setAttribute('is', 'emby-button');
            button.className = 'button-flat detailButton emby-button je-spoiler-blur-btn';
            button.type = 'button';
            JE.core.ui.placeDetailAction(container, button);
            const viewAction = JE.createSessionAction();
            button.addEventListener('click', function(event) {
                event.preventDefault();
                event.stopPropagation();
                if (!viewAction.current()) { button.disabled = true; return; }
                const liveId = button.getAttribute('data-je-item-id') || '';
                const liveKind = button.getAttribute('data-je-spoiler-kind') || 'series';
                const livePage = button.closest('#itemDetailPage:not(.hide)') || visiblePage;
                onToggle(button, liveId, liveKind, livePage, JE.ownerOf(event));
            });
            button.setAttribute('data-je-item-id', itemId);
            button.setAttribute('data-je-spoiler-kind', kind);
            button.setAttribute('data-je-spoiler-state', state);
            renderButton(button, enabled);
            // Shared state changes (a write, or a recovered read) repaint the drawn control.
            const refresh = function() {
                const live = stateOf(button.getAttribute('data-je-spoiler-kind') || 'series', button.getAttribute('data-je-item-id') || '');
                if (button.getAttribute('data-je-spoiler-state') === stateName(live)) return;
                button.setAttribute('data-je-spoiler-state', stateName(live));
                renderButton(button, live);
            };
            button.jeSpoilerRefresh = refresh;
            internal.bindStateView?.(button, refresh);
            return;
        }

        JE.core.ui.placeDetailAction(container, button);
        const previousId = button.getAttribute('data-je-item-id');
        const previousKind = button.getAttribute('data-je-spoiler-kind');
        button.setAttribute('data-je-item-id', itemId);
        button.setAttribute('data-je-spoiler-kind', kind);
        if (button.getAttribute('data-je-spoiler-state') !== state || previousId !== itemId || previousKind !== kind) {
            button.setAttribute('data-je-spoiler-state', state);
            renderButton(button, enabled);
        }
    };
})(window.JellyfinEnhanced);
