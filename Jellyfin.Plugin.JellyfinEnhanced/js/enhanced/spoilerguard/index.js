// @ts-check
// Spoiler Guard compatibility surface and boot orchestration.
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    /** @type {any} Shared cross-file namespace; each module contributes a focused surface. */
    const internal = JE.internals.spoilerGuard = JE.internals.spoilerGuard || {};
    const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';
    let installed = false;

    function init() {
        if (JE.pluginConfig?.SpoilerBlurEnabled !== true) return;
        internal.setIdentityCookie();
        if (!installed) {
            installed = true;
            internal.injectStyles();
            try { internal.installWatchedRefresh(); }
            catch (e) { console.warn(`${logPrefix} watched-state integration failed:`, e); }
        }
        void internal.loadState();
    }

    JE.spoilerBlur = {
        init,
        addSpoilerBlurButton: internal.addSpoilerBlurButton,
        isEnabledFor: internal.isEnabledFor,
        isMovieEnabledFor: internal.isMovieEnabledFor,
        isCollectionEnabledFor: internal.isCollectionEnabledFor,
        enableForSeries: internal.enableForSeries,
        disableForSeries: internal.disableForSeries,
        enableForMovie: internal.enableForMovie,
        disableForMovie: internal.disableForMovie,
        enableForCollection: internal.enableForCollection,
        disableForCollection: internal.disableForCollection,
        isTmdbEnabled: internal.isTmdbEnabled,
        enableForTmdb: internal.enableForTmdb,
        disableForTmdb: internal.disableForTmdb,
        whenLoaded: internal.whenLoaded,
        isLoadOk: internal.isLoadOk,
        confirmDisableSpoiler: internal.confirmDisableSpoiler,
        getUserPrefs: internal.getUserPrefs,
        setUserPrefs: internal.setUserPrefs,
    };

    // pluginConfig is already available when component scripts execute. Starting
    // here makes the state request race alongside later component evaluation;
    // plugin.js calls init again after setup, which is intentionally idempotent.
    init();
})(window.JellyfinEnhanced);
