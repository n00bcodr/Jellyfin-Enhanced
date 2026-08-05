// /js/tags/languagetags.js
// Jellyfin Language Flags Overlay — a spec over the core tag-renderer factory
// (js/core/tag-renderer-base.js), which owns the cache/ignore/tagged/CSS/
// reinitialize plumbing. This module supplies only the language-specific
// parts: the language→country map, audio-stream extraction and flag markup.
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Language Tags:';
    const containerClass = 'language-overlay-container';
    const flagClass = 'language-flag';
    const langDisplayNames = new Intl.DisplayNames(['en'], { type: 'language' });
    // Flag resolution lives in the shared core module (js/core/media-language.js)
    // so this overlay and the details-page audio-language row can never disagree.
    // It understands region subtags: pt-BR → Brazilian flag, es-419 → Mexican,
    // zh-Hant → Taiwanese — while a bare pt/es/zh keeps its default flag.

    /**
     * Extracts audio languages from a Jellyfin item's media sources.
     * @param {Object} sourceItem - The item (or first episode) to extract languages from.
     * @returns {Array<{name: string, code: string}>} Normalized array of language objects.
     */
    function extractLanguagesFromItem(sourceItem) {
        if (!sourceItem) return [];
        const languages = new Set();

        // Process audio streams from a flat list
        const processStreams = function(streams) {
            if (!streams) return;
            streams.filter(function(s) { return s.Type === 'Audio'; }).forEach(function(stream) {
                var langCode = stream.Language;
                if (langCode && !['und', 'root'].includes(langCode.toLowerCase())) {
                    try {
                        var langName = langDisplayNames.of(langCode);
                        languages.add(JSON.stringify({ name: langName, code: langCode }));
                    } catch (e) {
                        languages.add(JSON.stringify({ name: langCode.toUpperCase(), code: langCode }));
                    }
                }
            });
        };

        // Handle both formats: nested MediaSources[].MediaStreams[] and flat MediaStreams[]
        if (sourceItem.MediaSources) {
            sourceItem.MediaSources.forEach(function(source) {
                processStreams(source.MediaStreams);
            });
        }
        if (sourceItem.MediaStreams) {
            processStreams(sourceItem.MediaStreams);
        }

        return normalizeLanguages(Array.from(languages).map(JSON.parse));
    }

    // Normalize different shapes of language arrays into [{ name, code }] and de-duplicate
    function normalizeLanguages(languages) {
        if (!Array.isArray(languages)) return [];
        const norm = [];
        const seen = new Set();
        for (const entry of languages) {
            let obj = null;
            if (!entry) continue;
            if (typeof entry === 'string') {
                // Handle legacy cache that stored ["en", "fr", ...]. Keep the
                // full tag — a region subtag (pt-BR) is meaningful and must
                // survive normalization so the region flag can render.
                const code = entry.toLowerCase();
                let name = null;
                try { name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code.toUpperCase(); }
                catch { name = code.toUpperCase(); }
                obj = { name, code };
            } else if (typeof entry === 'object') {
                // Same here: never strip the region from the code.
                const code = (entry.code || entry.Code || '').toString();
                const name = entry.name || entry.Name || null;
                if (code) {
                    let resolvedName = name;
                    try { if (!resolvedName) resolvedName = new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code.toUpperCase(); }
                    catch { resolvedName = (name || code.toUpperCase()); }
                    obj = { name: resolvedName, code };
                }
            }
            if (!obj) continue;
            const key = `${obj.code.toLowerCase()}|${(obj.name || '').toLowerCase()}`;
            if (!seen.has(key)) { seen.add(key); norm.push(obj); }
        }
        return norm;
    }

    /**
     * Build and attach the flag overlay for a card.
     * @param {Object} ctx - Factory context (tagged/ignore/cache helpers).
     * @param {HTMLElement} container - The render target element.
     * @param {Array} languages - Languages in any supported shape.
     */
    function insertLanguageTags(ctx, container, languages) {
        if (!container) return;
        if (ctx.isTagged(container)) return;
        // Always re-render to handle cache migrations or setting changes
        ctx.removeExistingOverlay(container);
        container.style.position = 'relative'; // Avoid forced reflow from getComputedStyle

        const wrap = document.createElement('div');
        wrap.className = containerClass;
        const pos = JE.core.tagRenderer.resolvePosition('languageTagsPosition', 'LanguageTagsPosition', 'bottom-left');
        wrap.style.position = 'absolute';
        wrap.style.top = pos.topVal; wrap.style.right = pos.rightVal; wrap.style.bottom = pos.bottomVal; wrap.style.left = pos.leftVal;
        // If positioned top-right and the card has indicators, add a top margin to avoid overlap
        const hasIndicators = !!container.querySelector('.cardIndicators');
        if (hasIndicators && pos.needsTopRightOffset) {
            wrap.style.marginTop = 'clamp(20px, 3vw, 30px)';
        }

        const normalized = normalizeLanguages(languages);
        const maxToShow = 3;
        const seenCountries = new Set();
        const uniqueFlags = [];

        // Deduplicate by flag while preserving language info for tooltips.
        // Regional variants resolve to distinct flags (pt vs pt-BR), so a
        // movie carrying both tracks correctly shows both.
        normalized.forEach(lang => {
            const codeKey = (lang.code || '').toString();
            const nameKey = (lang.name || '').toString();
            const countryCode = JE.core.mediaLanguage.resolveFlag(lang);
            if (countryCode && !seenCountries.has(countryCode)) {
                seenCountries.add(countryCode);
                uniqueFlags.push({ countryCode, name: nameKey || codeKey.toUpperCase(), allLanguages: [nameKey || codeKey.toUpperCase()] });
            } else if (countryCode && seenCountries.has(countryCode)) {
                // Add language name to existing country's tooltip
                const existingFlag = uniqueFlags.find(f => f.countryCode === countryCode);
                if (existingFlag && !existingFlag.allLanguages.includes(nameKey || codeKey.toUpperCase())) {
                    existingFlag.allLanguages.push(nameKey || codeKey.toUpperCase());
                }
            }
        });

        uniqueFlags.slice(0, maxToShow).forEach(flagInfo => {
            const img = document.createElement('img');
            img.src = JE.cdn.flagSvg(flagInfo.countryCode);
            img.className = flagClass;
            img.alt = flagInfo.allLanguages.join(', ');
            img.title = flagInfo.allLanguages.join(', ');
            img.loading = 'lazy';
            img.dataset.lang = flagInfo.countryCode.toLowerCase();
            img.dataset.langName = flagInfo.allLanguages.join(', ');
            // A region subtag from the wild can name a country the flag set
            // lacks; drop the broken image rather than showing it.
            img.onerror = () => img.remove();
            wrap.appendChild(img);
        });
        ctx.commitOverlay(container, wrap);
    }

    /** @type {Object} Factory spec — everything language-specific lives here. */
    const spec = {
        logPrefix,
        settingKey: 'languageTagsEnabled',
        containerClass,
        taggedAttr: 'jeLanguageTagged',
        styleId: 'language-tags-styles',
        cache: {
            // v2: entries now keep region subtags (pt-BR) instead of stripped
            // base codes; the old key is cleaned up via legacyPrefix so stale
            // stripped entries can't pin the wrong flag for the 30-day TTL.
            // Both prior generations are listed — dropping the ancient
            // un-namespaced stem would leave its keys orphaned forever.
            key: 'JellyfinEnhanced-languageTagsCache-v2',
            legacyPrefix: ['JellyfinEnhanced-languageTagsCache', 'languageTagsCache'],
            hotBucket: 'language',
        },
        buildCss() {
            return `
                .${containerClass} {
                    display: flex;
                    flex-direction: column;
                    gap: 3px;
                    z-index: 101;
                    pointer-events: none;
                    max-height: 90%;
                    overflow: hidden;
                }
                .${flagClass} {
                    width: clamp(24px, 6vw, 32px);
                    height: auto;
                    border-radius: 2px;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.4);
                    flex-shrink: 0;
                    object-fit: cover;
                }
                .layout-mobile .${flagClass} {
                    width: clamp(20px, 5vw, 26px);
                }
                .layout-mobile .${containerClass} { gap: 2px; }
                @media (max-width: 768px) {
                    .${flagClass} {
                        width: clamp(20px, 5vw, 26px);
                        gap: 2px;
                    }
                }
                @media (max-width: 480px) {
                    .${flagClass} {
                        width: clamp(16px, 4vw, 20px);
                    }
                    .${containerClass} {
                        gap: 2px;
                    }
                }
            `;
        },
        pipeline: {
            needsFirstEpisode: true,
            needsParentSeries: false,
            render(ctx, el, item, extras) {
                if (ctx.shouldIgnore(el)) return;
                if (ctx.isTagged(el)) return;
                // Skip cards hidden by hidden-content module
                if (el.closest('.je-hidden')) return;

                const itemId = item.Id;
                // Check hot cache first
                const hot = ctx.hot?.get(itemId);
                if (hot && (Date.now() - hot.timestamp) < ctx.cacheTtl) {
                    if (hot.value && hot.value.length) insertLanguageTags(ctx, el, hot.value);
                    return;
                }

                var sourceItem = item;
                if (item.Type === 'Series' || item.Type === 'Season') {
                    if (extras.firstEpisode) {
                        sourceItem = extras.firstEpisode;
                    } else {
                        return; // No first episode available, skip
                    }
                }

                var languages = extractLanguagesFromItem(sourceItem);

                if (languages.length > 0) {
                    ctx.setPersistent(itemId, languages);
                    ctx.hot?.set(itemId, { value: languages, timestamp: Date.now() });
                    insertLanguageTags(ctx, el, languages);
                }
            },
            renderFromCache(ctx, el, itemId) {
                if (ctx.isTagged(el)) return true;
                if (ctx.shouldIgnore(el)) return true;
                if (el.closest('.je-hidden')) return true;
                const hot = ctx.hot?.get(itemId);
                const cached = hot || ctx.getPersistent(itemId);
                if (cached) {
                    const languages = Array.isArray(cached) ? cached : (cached.value || cached.languages);
                    if (languages && languages.length > 0) {
                        insertLanguageTags(ctx, el, languages);
                        return true;
                    }
                }
                return false;
            },
            renderFromServerCache(ctx, el, entry) {
                if (ctx.isTagged(el)) return;
                if (ctx.shouldIgnore(el)) return;
                var codes = entry.AudioLanguages;
                if (!codes || codes.length === 0) return;
                var languages = codes.map(function(code) {
                    try {
                        return { name: langDisplayNames.of(code), code: code };
                    } catch (e) {
                        return { name: code.toUpperCase(), code: code };
                    }
                });
                insertLanguageTags(ctx, el, languages);
            },
        },
    };

    JE.initializeLanguageTags = function() {
        JE.core.tagRenderer.register('language', spec);
    };

    /**
     * Re-initializes the Language Tags feature
     * Cleans up existing state and re-applies tags.
     */
    JE.reinitializeLanguageTags = function() {
        JE.core.tagRenderer.reinitialize('language', spec);
    };

})(window.JellyfinEnhanced);
