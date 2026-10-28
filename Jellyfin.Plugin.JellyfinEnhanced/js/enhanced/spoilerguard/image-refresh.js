// @ts-check
// Cache-bust visible Jellyfin images after Spoiler Guard state changes.
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    /** @type {any} Shared cross-file namespace; each module contributes a focused surface. */
    const internal = JE.internals.spoilerGuard = JE.internals.spoilerGuard || {};
    const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';
    const imagePath = /\/Items\/[a-f0-9-]+\/Images\//i;
    let pendingReload = null;

    internal.bustSpoilerImageUrl = function(url, cacheBuster) {
        if (typeof url !== 'string' || !url || !imagePath.test(url)) return url;
        const cleaned = url.replace(/([?&])_sbcb=\d+&?/g, '$1').replace(/[?&]$/, '');
        return `${cleaned}${cleaned.includes('?') ? '&' : '?'}${cacheBuster}`;
    };

    internal.refreshSpoilerableImages = function() {
        const cacheBuster = `_sbcb=${Date.now()}`;
        const bust = url => internal.bustSpoilerImageUrl(url, cacheBuster);

        document.querySelectorAll('img[src*="/Items/"], img[srcset*="/Items/"]').forEach(function(img) {
            const src = img.getAttribute('src') || '';
            if (imagePath.test(src)) img.setAttribute('src', bust(src));
            const srcset = img.getAttribute('srcset');
            if (srcset && imagePath.test(srcset)) {
                img.setAttribute('srcset', srcset.replace(/([^\s,]+)(?=\s*[\d.]+[wx]|\s*,|\s*$)/g,
                    url => imagePath.test(url) ? bust(url) : url));
            }
        });

        document.querySelectorAll('source[srcset*="/Items/"]').forEach(function(source) {
            const srcset = source.getAttribute('srcset') || '';
            if (imagePath.test(srcset)) {
                source.setAttribute('srcset', srcset.replace(/([^\s,]+)(?=\s*[\d.]+[wx]|\s*,|\s*$)/g,
                    url => imagePath.test(url) ? bust(url) : url));
            }
        });

        document.querySelectorAll('[style*="/Items/"]').forEach(function(element) {
            const style = element.getAttribute('style') || '';
            if (!imagePath.test(style)) return;
            const next = style.replace(/url\((["']?)([^"')]+)\1\)/gi,
                (_match, quote, url) => `url(${quote}${bust(url)}${quote})`);
            if (next !== style) element.setAttribute('style', next);
        });
    };

    /**
     * Reloads the page 600 ms from now for `owner` (required, D46S2-R11-6: the toggle's press, or the page's own step):
     * checked as the reload happens, so a navigation, an account switch or the document leaving in between reloads
     * nothing. A newer request replaces a pending one.
     * @param {any} owner
     */
    internal.scheduleFullReload = function(owner) {
        const resolved = JE.requireOwner(owner, 'the Spoiler Guard reload');
        if (!resolved) return;
        if (pendingReload) clearTimeout(pendingReload);
        pendingReload = setTimeout(function() {
            pendingReload = null;
            if (!JE.effectOwner(resolved, 'the Spoiler Guard reload')) return;
            try { location.reload(); }
            catch (e) { console.warn(`${logPrefix} reload failed:`, e); }
        }, 600);
    };
})(window.JellyfinEnhanced);
