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

        // Only the collection can switch this guard off, so here it's a status, not a control.
        const inherited = data?.jeSpoilerGuardInherited === true;

        // The server's verdict also covers what ids alone can't: a title guarded through
        // a collection, or one whose Seerr id doesn't match this library.
        function isEnabled() {
            return data?.jeSpoilerGuard === true || internal.isTmdbEnabled(mediaType, tmdbId, jellyfinMediaId);
        }

        function refresh() {
            const enabled = isEnabled();
            // "Pending" only fits a title that hasn't arrived yet.
            const onLabel = internal.isTmdbPending(mediaType, tmdbId) ? 'spoiler_blur_pending_button_on' : 'spoiler_blur_button_on';
            const text = JE.t(enabled ? onLabel : 'spoiler_blur_pending_button_off');
            button.classList.toggle('je-spoiler-pending-on', enabled);
            button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
            // A locale without the hint yet gets the key back, so it keeps the label.
            const hint = JE.t('spoiler_blur_inherited_hint');
            button.title = inherited && hint !== 'spoiler_blur_inherited_hint' ? hint : text;
            button.disabled = inherited;
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
            const wasEnabled = isEnabled();
            const modal = button.closest('.je-more-info-modal');
            const epoch = JE.session ? JE.session.getEpoch() : 0;
            const sameUser = () => !JE.session || JE.session.isCurrent(epoch);
            void (async function() {
                let changed = false;
                try {
                    if (wasEnabled) {
                        // Each step checks first: requests go out as whoever is signed in now.
                        if (!await internal.confirmDisableSpoiler() || !sameUser()) return;
                        const result = await internal.disableForTmdb(mediaType, tmdbId);
                        if (!sameUser()) return;
                        // The server's list reaches what a TMDB id can't: an item without
                        // one, and a title held twice, where that id leads to one copy.
                        const items = data?.jeSpoilerGuardItems || [];
                        const outcomes = await Promise.allSettled(items.map(id => (mediaType === 'tv' ? internal.disableForSeries(id) : internal.disableForMovie(id))));
                        if (!sameUser()) return;
                        const removed = result?.removed !== false || outcomes.some(outcome => outcome.status === 'fulfilled');
                        const failed = !removed || outcomes.some(outcome => outcome.status === 'rejected');
                        JE.toast?.(JE.t(failed ? 'spoiler_blur_pending_error_toast' : 'spoiler_blur_pending_disabled_toast'));
                        // Anything that went through still has to reach the modal.
                        if (!removed) return;
                    } else {
                        const result = await internal.enableForTmdb(mediaType, tmdbId, displayName);
                        JE.toast?.(JE.t(result?.promoted === 'pending' ? 'spoiler_blur_pending_enabled_toast' : 'spoiler_blur_enabled_toast'));
                    }
                    changed = true;
                } catch (e) {
                    console.warn(`${logPrefix} Seerr toggle failed:`, e);
                    JE.toast?.(JE.t('spoiler_blur_pending_error_toast'));
                } finally {
                    refresh();
                    button.disabled = false;
                }
                // Reopened so the modal shows what the server now sends for this title, unless
                // it has since been closed, replaced or left behind by a change of user.
                const stillOpen = modal?.isConnected && !modal._isClosing;
                if (changed && stillOpen && sameUser()) await JE.jellyseerrMoreInfo?.open?.(tmdbId, mediaType);
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
