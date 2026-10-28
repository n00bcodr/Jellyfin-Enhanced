// @ts-check
// Spoiler Guard pending toggle for the Jellyseerr more-info modal, and for the details page of a
// title that isn't in the library (a button in the native action row, like the library's own).
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    /** @type {any} Shared cross-file namespace; each module contributes a focused surface. */
    const internal = JE.internals.spoilerGuard = JE.internals.spoilerGuard || {};
    const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';

    /**
     * The pending Spoiler Guard switch for a title known by its TMDB id.
     * @param {Object} data Seerr details ({id, title|name, mediaInfo}).
     * @param {string} mediaType 'movie' | 'tv'.
     * @param {{detail?: boolean}} [options] detail: drawn as a native action-row button (icon only,
     *     the label as its tooltip and accessible name), as the library's Spoiler Guard button is.
     * @returns {HTMLButtonElement|null} Button, or null when Spoiler Guard is off or the title unknown.
     */
    internal.buildSeerrToggle = function(data, mediaType, options) {
        if (JE.pluginConfig?.SpoilerBlurEnabled !== true) return null;
        if (mediaType !== 'tv' && mediaType !== 'movie') return null;
        const tmdbId = data?.id;
        if (!tmdbId) return null;

        const jellyfinMediaId = data?.mediaInfo?.jellyfinMediaId || null;
        const displayName = data?.title || data?.name || '';
        const detail = options?.detail === true;
        const viewAction = JE.createSessionAction();
        const button = document.createElement('button');
        // Drawn for this session, route and document (D46S2-R11-1).
        JE.mountControl?.(button);
        button.type = 'button';
        button.className = detail ? 'button-flat detailButton emby-button je-spoiler-pending-detail' : 'je-spoiler-pending-btn';
        if (detail) button.setAttribute('is', 'emby-button');
        button.dataset.jeTmdbId = String(tmdbId);
        button.dataset.jeMediaType = mediaType;

        const icon = document.createElement('span');
        icon.className = detail ? 'material-icons detailButton-icon' : 'material-icons';
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        if (detail) {
            const content = document.createElement('div');
            content.className = 'detailButton-content';
            content.appendChild(icon);
            button.appendChild(content);
        } else {
            button.appendChild(icon);
            button.appendChild(label);
        }

        /** The mirrors once they can answer for this title; until then the server's projection of it. */
        function current() {
            return internal.isTmdbKnown?.(mediaType, tmdbId) !== false
                ? internal.isTmdbEnabled(mediaType, tmdbId, jellyfinMediaId)
                : data.jeSpoiler?.guarded === true;
        }

        function refresh() {
            if (!viewAction.current()) { button.disabled = true; return; }
            const enabled = current();
            const text = JE.t(enabled ? 'spoiler_blur_pending_button_on' : 'spoiler_blur_pending_button_off');
            button.classList.toggle('je-spoiler-pending-on', enabled);
            button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
            button.title = text;
            if (detail) button.setAttribute('aria-label', text);
            icon.textContent = enabled ? 'blur_on' : 'blur_off';
            label.textContent = text;
        }

        button.jeSpoilerRefresh = refresh;
        internal.bindStateView?.(button, refresh);
        refresh();
        internal.whenLoaded().then(refresh).catch(function() {});
        button.addEventListener('click', function(event) {
            event.preventDefault();
            event.stopPropagation();
            if (button.disabled || !viewAction.current()) return;
            // The toggle belongs to this click's session, through the confirmation and the write.
            const origin = JE.core.userWrite.origin();
            button.disabled = true;
            // The press's owner: the operation a title action pressed it for, else where it was pressed (D46S2-R6).
            const owner = JE.ownerOf(event);
            const action = JE.createSessionAction({ owner });
            const wasEnabled = current();
            void (async function() {
                try {
                    if (wasEnabled) {
                        if (!await internal.confirmDisableSpoiler(owner)) return;
                        if (!action.current()) return;
                        if (!JE.core.userWrite.isBound(origin)) { JE.core.userWrite.notSent(); return; }
                        await internal.disableForTmdb(mediaType, tmdbId, owner, origin);
                        if (action.current() && JE.core.userWrite.isBound(origin)) JE.toast?.(JE.t('spoiler_blur_pending_disabled_toast'));
                    } else {
                        await internal.enableForTmdb(mediaType, tmdbId, displayName, owner, origin);
                        if (action.current() && JE.core.userWrite.isBound(origin)) JE.toast?.(JE.t('spoiler_blur_pending_enabled_toast'));
                    }
                } catch (e) {
                    if (!action.current()) return;
                    console.warn(`${logPrefix} Seerr toggle failed:`, e);
                    if (!e?.sessionChanged && JE.core.userWrite.isBound(origin)) {
                        if (JE.core.userWrite.outcome(e) === 'uncertain') JE.core.userWrite.reportUncertain(e);
                        else JE.toast?.(JE.t('spoiler_blur_pending_error_toast'));
                    }
                } finally {
                    refresh();
                    button.disabled = !viewAction.current();
                }
            })();
        });
        return button;
    };

    internal.appendSeerrToggle = function(mount, data, mediaType) {
        if (!mount) return;
        try {
            const button = internal.buildSeerrToggle(data, mediaType);
            if (button) mount.appendChild(button);
        } catch (e) {
            console.warn(`${logPrefix} Seerr toggle render failed:`, e);
        }
    };
})(window.JellyfinEnhanced);
