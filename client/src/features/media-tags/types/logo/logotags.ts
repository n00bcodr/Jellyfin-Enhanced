import { apiClient, hasApiClient, type TagRuntimeBridge } from '../../host';
import { isRecord, record } from '../../pipeline/dto';
import type { TagCtx, TagSpec } from '../../pipeline/contract';

export interface LogoFact { kind: string; name: string; logo: string | null }
export interface LogoTags {
    buildChip(logo: LogoFact, src?: string): HTMLElement;
    readLogos(raw: unknown): LogoFact[];
    shortName(name: unknown): string;
    logoUrl(path: unknown): string | null;
}
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
export function createLogoTags(JE: TagRuntimeBridge) {

    const logPrefix = '🪼 Jellyfin Enhanced: Logos Tags:';
    const containerClass = 'logo-overlay-container';
    const chipClass = 'je-logo-chip';
    const imageClass = 'je-logo-img';
    /** Names longer than this show as an initialism (TagCacheService.LogoTextMaxLength). */
    const TEXT_MAX_LENGTH = 12;
    const KINDS = new Set(['provider', 'network', 'studio']);
    const LOGO_PATH = /^\/[A-Za-z0-9_-]{1,80}\.(?:png|jpe?g|webp)$/;
    /** Image URLs that failed to load (shown as names) → when. Retried after FAILED_RETRY_MS; at most FAILED_MAX. */
    const failedUrls: Map<string, number> = new Map();
    const FAILED_RETRY_MS = 5 * 60 * 1000;
    const FAILED_MAX = 500;
    /** Whether the URL failed recently; an older failure is forgotten so the image is tried again. */
    function recentlyFailed(url: string): boolean {
        const at = failedUrls.get(url);
        if (at === undefined) return false;
        if (Date.now() - at < FAILED_RETRY_MS) return true;
        failedUrls.delete(url);
        return false;
    }
    let errorListener = false;

    /**
     * The text a name chip shows: the name itself up to TEXT_MAX_LENGTH
     * characters, else the initials of its words (up to four: "Home Box
     * Office" → "HBO"), else the name cut to fit with an ellipsis.
     * Native posters use the same rule (LogoTagRules.ShortName).
     * */
    function shortName(name: string): string {
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
     * @param path - "/abc.png".
     * */
    function logoUrl(path: unknown): string|null {
        if (typeof path !== 'string' || !LOGO_PATH.test(path)) return null;
        const route = `JellyfinEnhanced/logo/w92${path}`;
        return hasApiClient() && typeof apiClient().getUrl === 'function' ? apiClient().getUrl(route) : `/${route}`;
    }

    /**
     * Valid logos from a cache entry or batch item, at most two.
     * @param raw - `Logos` as the server sends it.
     * */
    function readLogos(raw: unknown): LogoFact[] {
        if (!Array.isArray(raw)) return [];
        const out: LogoFact[] = [];
        for (const entry of raw) {
            const fact = record(entry);
            const kind = String(fact.kind ?? fact.Kind ?? '');
            const name = String(fact.name ?? fact.Name ?? '').trim();
            if (!KINDS.has(kind) || !name) continue;
            const logo = fact.logo ?? fact.Logo;
            out.push({ kind, name, logo: typeof logo === 'string' && LOGO_PATH.test(logo) ? logo : null });
            if (out.length === 2) break;
        }
        return out;
    }

    /**
     * Turn a chip into a name chip (no image, or the image failed).
     */
    function asText(chip: HTMLElement, name: string) {
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
     * @param [src] - Image URL to use instead of the proxy's (the settings preview's inline samples).
     * */
    function buildChip(logo: {kind: string, name: string, logo: string|null}, src?: string): HTMLElement {
        const chip = document.createElement('span');
        chip.className = chipClass;
        chip.dataset.jeLogoKind = logo.kind;
        chip.title = logo.name;
        const url = src || logoUrl(logo.logo);
        if (!url || recentlyFailed(url)) {
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
            const img = event.target;
            if (!(img instanceof HTMLImageElement) || !img.classList.contains(imageClass)) return;
            const src = img.getAttribute('src') || '';
            failedUrls.delete(src);
            failedUrls.set(src, Date.now());
            if (failedUrls.size > FAILED_MAX) failedUrls.delete(failedUrls.keys().next().value ?? '');
            const chip = img.closest<HTMLElement>(`.${chipClass}`);
            if (chip) asText(chip, img.alt);
        }, true);
    }

    /**
     * The Spoiler Guard Hide tags policy the server strips this user's logos
     * under ('off' when it strips nothing), or null while it is not known.
     * Fallback-cache entries are stamped with it: one stamped under another
     * policy (a guard added or removed, Hide tags switched, a copy from
     * before stamping) is a miss, so the batch lookup asks the server again.
     * */


    /**
     * Build the group wrapper and hand it to the layout controller.
     * @param ctx - Factory context.
     * @param el - The card's tag host.
     */
    function applyLogoTags(ctx: TagCtx, el: HTMLElement, logos: Array<{kind: string, name: string, logo: string|null}>) {
        if (!logos.length) return;
        ctx.removeExistingOverlay(el);
        const container = document.createElement('div');
        container.className = containerClass;
        for (const logo of logos) container.appendChild(buildChip(logo));
        ctx.commitOverlay(el, container);
    }

    /** Factory spec — everything logo-specific lives here. */
    const spec: TagSpec = {
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
            render(ctx: TagCtx, el, item) {
                if (ctx.shouldIgnore(el)) return;
                if (ctx.isTagged(el)) return;
                if (el.closest('.je-hidden')) return;
                const logos = readLogos(item.Logos);
                const entry = { l: logos };
                ctx.setPersistent(String(item.Id), entry);
                ctx.hot?.set(String(item.Id), entry);
                applyLogoTags(ctx, el, logos);
            },
            renderFromCache(ctx: TagCtx, el, itemId) {
                if (ctx.isTagged(el)) return true;
                if (ctx.shouldIgnore(el)) return true;
                if (el.closest('.je-hidden')) return true;
                const cached = ctx.getPersistent(itemId) ?? ctx.hot?.get(itemId);
                if (!isRecord(cached) || !Array.isArray(cached.l)) return false;
                // A cached "no logos" is still a hit: nothing to fetch.
                applyLogoTags(ctx, el, readLogos(cached.l));
                return true;
            },
            renderFromServerCache(ctx: TagCtx, el, entry) {
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
}
