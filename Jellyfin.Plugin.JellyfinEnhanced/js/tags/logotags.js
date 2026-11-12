// /js/tags/logotags.js
// Jellyfin Logos Tags - one small logo chip per card: the item's streaming
// provider, its TV network or its studio, as the administrator chose per item
// type. The server resolves the logos (TMDB watch providers and company /
// network logos, or Jellyfin's studio names) into the tag cache entry and the
// batch lookup as `Logos: [{kind, name, logo}]`; seasons and episodes carry
// their series'. Images come from the server's logo proxy
// (/JellyfinEnhanced/logo/w92/<file>), never from TMDB directly. A logo
// without an image, or one that fails to load, shows its name instead
// (an initialism when the name is long). Spoiler Guard's Hide tags strips
// the group server side; the browser's fallback copies carry the guard
// policy they were stripped under and are not used under another one.
// A spec over the core tag-renderer factory (js/core/tag-renderer-base.js).
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Logos Tags:';
    const containerClass = 'logo-overlay-container';
    const chipClass = 'je-logo-chip';
    const imageClass = 'je-logo-img';
    /** Names longer than this show as an initialism (TagCacheService.LogoTextMaxLength). */
    const TEXT_MAX_LENGTH = 12;
    const KINDS = new Set(['provider', 'network', 'studio']);
    const LOGO_PATH = /^\/[A-Za-z0-9_-]{1,80}\.(?:png|jpe?g|webp)$/;
    /** @type {Set<string>} image URLs that failed to load this session (shown as names) */
    const failedUrls = new Set();
    let errorListener = false;

    /**
     * The text a name chip shows: the name itself up to TEXT_MAX_LENGTH
     * characters, else the initials of its words (up to four: "Home Box
     * Office" → "HBO"), else the name cut to fit with an ellipsis.
     * Native posters use the same rule (LogoTagRules.ShortName).
     * @param {string} name
     * @returns {string}
     */
    function shortName(name) {
        const text = String(name || '').trim();
        if (text.length <= TEXT_MAX_LENGTH) return text;
        const words = text.split(/[\s\-–—/&+]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
        if (words.length >= 2) {
            return words.slice(0, 4).map((w) => (w.match(/[\p{L}\p{N}]/u) || [''])[0].toUpperCase()).join('');
        }
        return `${text.slice(0, TEXT_MAX_LENGTH - 1)}…`;
    }

    /**
     * Proxy URL of a TMDB logo path, or null when the path is not one the
     * server serves.
     * @param {*} path - "/abc.png".
     * @returns {string|null}
     */
    function logoUrl(path) {
        if (typeof path !== 'string' || !LOGO_PATH.test(path)) return null;
        const route = `JellyfinEnhanced/logo/w92${path}`;
        return typeof ApiClient !== 'undefined' && ApiClient.getUrl ? ApiClient.getUrl(route) : `/${route}`;
    }

    /**
     * Valid logos from a cache entry or batch item, in order (none dropped for
     * Hidden tags or the limit: what the card caches).
     * @param {*} raw - `Logos` as the server sends it.
     * @returns {Array<{kind: string, name: string, logo: string|null}>}
     */
    function validLogos(raw) {
        if (!Array.isArray(raw)) return [];
        const out = [];
        for (const entry of raw) {
            const kind = String(entry?.kind ?? entry?.Kind ?? '');
            const name = String(entry?.name ?? entry?.Name ?? '').trim();
            if (!KINDS.has(kind) || !name) continue;
            const logo = entry?.logo ?? entry?.Logo;
            out.push({ kind, name, logo: typeof logo === 'string' && LOGO_PATH.test(logo) ? logo : null });
        }
        return out;
    }

    /**
     * The logos a card shows: the valid ones whose style is not hidden (Hidden
     * tags: provider, company or text, as Tag Styles colours them), at most
     * two. A hidden one leaves before the limit, so the next logo shows
     * (LogoRules.Resolve on native posters).
     * @param {*} raw - `Logos` as the server sends it.
     * @returns {Array<{kind: string, name: string, logo: string|null}>}
     */
    function readLogos(raw) {
        const style = (l) => (!l.logo ? 'text' : l.kind === 'provider' ? 'provider' : 'company');
        return validLogos(raw).filter((l) => !JE.core.tagHidden?.hides('logos', style(l))).slice(0, 2);
    }

    /**
     * Turn a chip into a name chip (no image, or the image failed).
     * @param {HTMLElement} chip
     * @param {string} name
     */
    function asText(chip, name) {
        chip.textContent = shortName(name);
        chip.dataset.jeLogoStyle = 'text';
        chip.classList.add('je-logo-text');
        chip.removeAttribute('role');
        chip.removeAttribute('aria-label');
    }

    /**
     * One logo chip: the proxied image on its pill (provider logos on a dark
     * pill, network and studio logos on a light one), or a name chip. The
     * full name is the chip's title and the image's alt text.
     * @param {{kind: string, name: string, logo: string|null}} logo
     * @param {string} [src] - Image URL to use instead of the proxy's (the settings preview's inline samples).
     * @returns {HTMLElement}
     */
    function buildChip(logo, src) {
        const chip = document.createElement('span');
        chip.className = chipClass;
        chip.dataset.jeLogoKind = logo.kind;
        chip.title = logo.name;
        const url = src || logoUrl(logo.logo);
        if (!url || failedUrls.has(url)) {
            asText(chip, logo.name);
            return chip;
        }
        chip.dataset.jeLogoStyle = logo.kind === 'provider' ? 'provider' : 'company';
        const img = document.createElement('img');
        img.className = imageClass;
        img.alt = logo.name;
        img.decoding = 'async';
        img.draggable = false;
        img.src = url;
        chip.appendChild(img);
        return chip;
    }

    /**
     * Image failures fall back to the name. Listened for once, in the capture
     * phase (error events do not bubble), so the copies the layout controller
     * places (clones without handlers) fall back as well.
     */
    function listenForImageErrors() {
        if (errorListener || typeof document.addEventListener !== 'function') return;
        errorListener = true;
        document.addEventListener('error', (event) => {
            const img = /** @type {HTMLElement} */ (event.target);
            if (!(img instanceof HTMLImageElement) || !img.classList.contains(imageClass)) return;
            failedUrls.add(img.getAttribute('src') || '');
            const chip = img.closest(`.${chipClass}`);
            if (chip) asText(/** @type {HTMLElement} */ (chip), img.alt);
        }, true);
    }

    /**
     * The Spoiler Guard Hide tags policy the server strips this user's logos
     * under ('off' when it strips nothing), or null while it is not known.
     * Fallback-cache entries are stamped with it: one stamped under another
     * policy (a guard added or removed, Hide tags switched, a copy from
     * before stamping) is a miss, so the batch lookup asks the server again.
     * @returns {string|null}
     */


    /**
     * Build the group wrapper and hand it to the layout controller.
     * @param {Object} ctx - Factory context.
     * @param {HTMLElement} el - The card's tag host.
     * @param {Array<{kind: string, name: string, logo: string|null}>} logos
     */
    function applyLogoTags(ctx, el, logos) {
        if (!logos.length) return;
        ctx.removeExistingOverlay(el);
        const container = document.createElement('div');
        container.className = containerClass;
        for (const logo of logos) container.appendChild(buildChip(logo));
        ctx.commitOverlay(el, container);
    }

    /** @type {Object} Factory spec — everything logo-specific lives here. */
    const spec = {
        logPrefix,
        settingKey: 'logoTagsEnabled',
        containerClass,
        taggedAttr: 'jeLogoTagged',
        styleId: 'jellyfin-enhanced-logo-tags-css',
        position: { userKey: 'logoTagsPosition', pluginKey: 'LogoTagsPosition', fallback: 'bottom-left' },
        cache: {
            key: 'JellyfinEnhanced-logoTagsCache',
            legacyPrefix: 'logoTagsCache',
            hotBucket: 'logos',
            saveOnUnload: false,
        },
        buildCss() {
            // Placement comes from the layout stylesheet (tags/tag-layout-styles.js).
            // Native Poster Tags mirror these sizes (PosterTagCss logo values).
            return `
                .${containerClass} {
                    display: flex;
                    flex-direction: column;
                    align-items: flex-start;
                    gap: calc(4px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1));
                    z-index: 10;
                    pointer-events: none;
                    max-width: calc(100% - 12px);
                }

                .${chipClass} {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    box-sizing: border-box;
                    height: calc(28px * var(--je-tag-scale, 1));
                    max-width: 100%;
                    padding: calc(3px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1));
                    overflow: hidden;
                    background-color: rgba(0, 0, 0, 0.6);
                    color: #ffffff;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 4px;
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                    font-size: calc(12px * var(--je-tag-scale, 1));
                    font-weight: 700;
                    line-height: 1;
                    letter-spacing: 0.02em;
                    white-space: nowrap;
                    pointer-events: none;
                }

                .${chipClass}[data-je-logo-style="provider"] { padding: calc(2px * var(--je-tag-scale, 1)); }

                .${chipClass}[data-je-logo-style="company"] {
                    background-color: rgba(255, 255, 255, 0.9);
                    color: #111111;
                    border-color: rgba(0, 0, 0, 0.12);
                }

                .${chipClass}[data-je-logo-style="text"] {
                    background-color: rgba(0, 0, 0, 0.75);
                    border-color: rgba(255, 255, 255, 0.25);
                    text-shadow: 0 0 2px rgba(0, 0, 0, 0.6);
                }

                .${imageClass} {
                    display: block;
                    height: 100%;
                    width: auto;
                    max-width: calc(72px * var(--je-tag-scale, 1));
                    object-fit: contain;
                    border-radius: 3px;
                }

                /* Card-width sizing, like the age rating chip */
                @supports (container-type: inline-size) {
                    html:not(.layout-mobile) .je-tag-host .${chipClass} {
                        height: calc(clamp(18px, 13cqw, 28px) * var(--je-tag-scale, 1));
                        font-size: calc(clamp(9px, 6.4cqw, 12px) * var(--je-tag-scale, 1));
                    }
                }

                .layout-mobile .${chipClass} { height: calc(22px * var(--je-tag-scale, 1)); font-size: calc(10px * var(--je-tag-scale, 1)); }
            `;
        },
        pipeline: {
            needsFirstEpisode: false,
            needsParentSeries: false,
            render(ctx, el, item) {
                if (ctx.shouldIgnore(el)) return;
                if (ctx.isTagged(el)) return;
                if (el.closest('.je-hidden')) return;
                // Every valid logo is cached, so changing Hidden tags needs no refetch.
                const entry = { l: validLogos(item?.Logos) };
                ctx.setPersistent(item.Id, entry);
                ctx.hot?.set(item.Id, entry);
                applyLogoTags(ctx, el, readLogos(entry.l));
            },
            renderFromCache(ctx, el, itemId) {
                if (ctx.isTagged(el)) return true;
                if (ctx.shouldIgnore(el)) return true;
                if (el.closest('.je-hidden')) return true;
                const cached = ctx.getPersistent(itemId) ?? ctx.hot?.get(itemId);
                if (!cached || typeof cached !== 'object' || !Array.isArray(cached.l)) return false;
                // A cached "no logos" is still a hit: nothing to fetch.
                applyLogoTags(ctx, el, readLogos(cached.l));
                return true;
            },
            renderFromServerCache(ctx, el, entry) {
                if (ctx.isTagged(el)) return;
                if (ctx.shouldIgnore(el)) return;
                applyLogoTags(ctx, el, readLogos(entry?.Logos));
            },
        },
    };

    JE.initializeLogoTags = function() {
        console.log(`${logPrefix} Starting...`);
        listenForImageErrors();
        const ctx = JE.core.tagRenderer.register('logos', spec);
        ctx.injectCss();
        console.log(`${logPrefix} Initialized successfully.`);
    };

    JE.reinitializeLogoTags = function() {
        JE.core.tagRenderer.reinitialize('logos', spec);
    };

    JE.logoTags = { buildChip, readLogos, shortName, logoUrl };

    // Previews may enable this group while the signed-in user has it off.
    JE.core.tagRenderer.registerStyles(spec);

})(window.JellyfinEnhanced);
