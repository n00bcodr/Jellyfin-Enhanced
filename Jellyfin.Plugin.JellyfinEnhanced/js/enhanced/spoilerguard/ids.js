// @ts-check
// Pure ID and item-kind helpers for Spoiler Guard.
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    /** @type {any} Shared cross-file namespace; each module contributes a focused surface. */
    const internal = JE.internals.spoilerGuard = JE.internals.spoilerGuard || {};

    internal.normalizeId = function(id) {
        if (!id) return '';
        if (typeof id !== 'string' && typeof id !== 'number' && typeof id !== 'bigint') return '';
        return String(id).replace(/-/g, '').toLowerCase();
    };

    internal.pendingKey = function(mediaType, tmdbId) {
        const type = typeof mediaType === 'string' ? mediaType.toLowerCase() : '';
        const id = (typeof tmdbId === 'string' || typeof tmdbId === 'number')
            ? String(tmdbId).trim()
            : '';
        if (!id || (type !== 'tv' && type !== 'movie')) return '';
        return `${type}:${id}`;
    };

    internal.kindOf = function(itemType) {
        if (itemType === 'Movie') return 'movie';
        if (itemType === 'BoxSet') return 'collection';
        return 'series';
    };
})(window.JellyfinEnhanced);
