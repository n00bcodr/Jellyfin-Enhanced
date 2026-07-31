// @ts-check
// Spoiler Guard pending toggle for the Jellyseerr more-info modal.
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    /** @type {any} Shared cross-file namespace; each module contributes a focused surface. */
    const internal = JE.internals.spoilerGuard = JE.internals.spoilerGuard || {};
    const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';

    internal.buildSeerrToggle = function(data, mediaType) {
        if (JE.pluginConfig?.SpoilerBlurEnabled !== true) return null;
        if (mediaType !== 'tv' && mediaType !== 'movie') return null;
        const tmdbId = data?.id;
        if (!tmdbId) return null;

        const jellyfinMediaId = data?.mediaInfo?.jellyfinMediaId || null;
        const displayName = data?.title || data?.name || '';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'je-spoiler-pending-btn';
        button.dataset.jeTmdbId = String(tmdbId);
        button.dataset.jeMediaType = mediaType;

        const icon = document.createElement('span');
        icon.className = 'material-icons';
        const label = document.createElement('span');
        button.appendChild(icon);
        button.appendChild(label);

        function refresh() {
            const enabled = internal.isTmdbEnabled(mediaType, tmdbId, jellyfinMediaId);
            const text = JE.t(enabled ? 'spoiler_blur_pending_button_on' : 'spoiler_blur_pending_button_off');
            button.classList.toggle('je-spoiler-pending-on', enabled);
            button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
            button.title = text;
            icon.textContent = enabled ? 'blur_on' : 'blur_off';
            label.textContent = text;
        }

        refresh();
        internal.whenLoaded().then(refresh).catch(function() {});
        button.addEventListener('click', function(event) {
            event.preventDefault();
            event.stopPropagation();
            if (button.disabled) return;
            button.disabled = true;
            const wasEnabled = internal.isTmdbEnabled(mediaType, tmdbId, jellyfinMediaId);
            void (async function() {
                try {
                    if (wasEnabled) {
                        if (!await internal.confirmDisableSpoiler()) return;
                        await internal.disableForTmdb(mediaType, tmdbId);
                        JE.toast?.(JE.t('spoiler_blur_pending_disabled_toast'));
                    } else {
                        await internal.enableForTmdb(mediaType, tmdbId, displayName);
                        JE.toast?.(JE.t('spoiler_blur_pending_enabled_toast'));
                    }
                } catch (e) {
                    console.warn(`${logPrefix} Seerr toggle failed:`, e);
                    JE.toast?.(JE.t('spoiler_blur_pending_error_toast'));
                } finally {
                    refresh();
                    button.disabled = false;
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
