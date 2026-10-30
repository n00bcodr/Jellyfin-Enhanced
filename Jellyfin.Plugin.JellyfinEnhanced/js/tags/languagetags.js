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
    // Series/Season flag for a language that only some episodes carry (#557).
    const partialFlagClass = 'language-flag-partial';
    const langDisplayNames = new Intl.DisplayNames(['en'], { type: 'language' });
    /** @type {Map<string, string>} language code → display name; an Intl lookup per flag per card adds up */
    const displayNameByCode = new Map();

    /**
     * English display name of a language code (the code upper-cased when Intl
     * has no name for it), memoised per code.
     * @param {string} code
     * @returns {string}
     */
    function displayName(code) {
        let name = displayNameByCode.get(code);
        if (name === undefined) {
            try {
                name = langDisplayNames.of(code) || code.toUpperCase();
            } catch (e) {
                name = code.toUpperCase();
            }
            displayNameByCode.set(code, name);
        }
        return name;
    }
    // Flag resolution lives in the shared core module (js/core/media-language.js)
    // so this overlay and the details-page audio-language row can never disagree.
    // It understands region subtags: pt-BR → Brazilian flag, es-419 → Mexican,
    // zh-Hant → Taiwanese — while a bare pt/es/zh keeps its default flag.

    /**
     * Extracts audio languages from a Jellyfin item's media sources.
     * @param {Object} sourceItem - The item (or first episode) to extract languages from.
     * @returns {Array<{name: string, code: string}>} Normalized array of language objects.
     */
    function extractLanguagesFromItem(sourceItem, type = 'Audio') {
        if (!sourceItem) return [];
        const languages = new Set();

        // Process audio streams from a flat list
        const processStreams = function(streams) {
            if (!streams) return;
            streams.filter(function(s) { return s.Type === type; }).forEach(function(stream) {
                var langCode = stream.Language;
                if (langCode && !['und', 'root'].includes(langCode.toLowerCase())) {
                    languages.add(JSON.stringify({ name: displayName(langCode), code: langCode }));
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

    // Normalize different shapes of language arrays into [{ name, code, partial }]
    // and de-duplicate. `partial` marks a language a Series/Season only carries
    // on some episodes; it is only ever set by the server cache path.
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
                obj = { name: displayName(code), code };
            } else if (typeof entry === 'object') {
                // Same here: never strip the region from the code.
                const code = (entry.code || entry.Code || '').toString();
                const name = entry.name || entry.Name || null;
                if (code) {
                    obj = { name: name || displayName(code), code };
                    // Only the server cache path sets it, so the localStorage
                    // cache (legacy per-page mode) never carries the field.
                    if (entry.partial) obj.partial = true;
                }
            }
            if (!obj) continue;
            const key = `${obj.code.toLowerCase()}|${(obj.name || '').toLowerCase()}`;
            if (!seen.has(key)) { seen.add(key); norm.push(obj); }
        }
        return norm;
    }

    /**
     * Tooltip line for one language: the display name, suffixed for a language
     * that is only on some of a Series/Season's episodes.
     * @param {{name: string, partial?: boolean}} lang
     * @returns {string}
     */
    function languageLabel(lang) {
        return lang.partial ? `${lang.name} (${JE.t('language_tags_partial_tooltip')})` : lang.name;
    }

    /**
     * Reads the admin-configured priority language list (comma-separated
     * language codes and/or names, e.g. "en, Japanese, fr") and returns it
     * as a lowercase array. Empty when unset, preserving the unprioritized
     * default behavior. Accepting names too matters because the flag shown
     * for a language is a *country* code (e.g. Telugu resolves to India's
     * "in" flag, shared with Hindi, Tamil, etc.) — an admin can't reliably
     * guess the underlying language code, but they do know the language name.
     * @returns {Array<string>}
     */
    function getPriorityTerms() {
        const raw = JE.pluginConfig?.LanguageTagsPriority || '';
        return raw.split(',').map(c => c.trim().toLowerCase()).filter(Boolean);
    }

    /**
     * Reorders deduplicated flags so that ones matching the admin's priority
     * list come first (in priority order), with the rest following in their
     * original detection order. Only the first few (the layout's language
     * cap, 3 by default) end up visible, so this is what actually decides
     * which flags a card shows. A flag can
     * match the priority list by language code (en, pt-BR), its base code
     * (pt), or its display name (English, Portuguese) — whichever the admin
     * typed.
     * When LanguageTagsPriorityStrict is on, non-matching flags are dropped
     * entirely instead of just being pushed to the back — a card can then
     * show fewer flags than the cap, or none, if it has no matching audio track.
     * @param {Array<{code: string, allLanguages: Array<string>}>} flags
     * @returns {Array}
     */
    function orderByPriority(flags) {
        const priority = getPriorityTerms();
        if (!priority.length) return flags;

        const rank = (flag) => {
            const code = (flag.code || '').toLowerCase();
            const base = code.split('-')[0];
            const names = (flag.allLanguages || []).map(n => n.toLowerCase());
            const candidates = [code, base, ...names];
            let best = -1;
            for (const candidate of candidates) {
                const idx = priority.indexOf(candidate);
                if (idx !== -1 && (best === -1 || idx < best)) best = idx;
            }
            return best;
        };

        const strict = !!JE.pluginConfig?.LanguageTagsPriorityStrict;
        return flags
            .map((flag, i) => ({ flag, i, rank: rank(flag) }))
            .filter(entry => !strict || entry.rank !== -1)
            .sort((a, b) => {
                const ra = a.rank === -1 ? priority.length : a.rank;
                const rb = b.rank === -1 ? priority.length : b.rank;
                return ra - rb || a.i - b.i;
            })
            .map(entry => entry.flag);
    }

    /** Effective display settings: user override, admin default, built-in default. */
    function readSettings() {
        const value = (key, fallback) => JE.currentSettings?.[key] ?? JE.pluginConfig?.[key[0].toUpperCase() + key.slice(1)] ?? fallback;
        const style = String(value('languageTagsStyle', 'flags')).trim().toLowerCase();
        const badge = String(value('languageTagsCountBadge', 'off')).trim().toLowerCase();
        return {
            audio: value('languageTagsShowAudio', true) !== false,
            subtitles: value('languageTagsShowSubtitles', false) === true,
            style: style === 'codes' ? 'codes' : 'flags',
            badge: ['only', 'both'].includes(badge) ? badge : 'off',
        };
    }

    /** ISO 639-1 when available, otherwise the canonical three-letter base. @param {string} code */
    function shortCode(code) {
        const parsed = JE.core.mediaLanguage.parseLanguageTag(code);
        return parsed?.base ? JE.core.mediaLanguage.canonicalBase(parsed.base).toUpperCase() : '';
    }

    /**
     * Deduplicated chips for one track type, full coverage first, then admin priority.
     * Flags preserve country grouping; codes group canonical languages, retaining
     * explicit regions unless the administrator merges regional variants.
     * @param {Array} languages
     * @param {string} style
     * @returns {Array}
     */
    function resolveChips(languages, style) {
        const unique = new Map();
        for (const lang of normalizeLanguages(languages)) {
            const countryCode = JE.core.mediaLanguage.resolveFlag(lang);
            const code = shortCode(lang.code);
            const parsed = JE.core.mediaLanguage.parseLanguageTag(lang.code);
            const key = style === 'codes' ? code + (JE.pluginConfig?.LanguageTagsMergeRegions ? '' : ':' + (parsed?.region || parsed?.script || '')) : countryCode;
            if (!key || (style === 'codes' && !code)) continue;
            const name = lang.name || lang.code.toUpperCase();
            const existing = unique.get(key);
            if (!existing) unique.set(key, { countryCode, code: lang.code, text: code, partial: !!lang.partial, allLanguages: [name], labels: [languageLabel({ name, partial: lang.partial })] });
            else {
                existing.partial = existing.partial && !!lang.partial;
                if (!existing.allLanguages.includes(name)) existing.allLanguages.push(name);
                const label = languageLabel({ name, partial: lang.partial });
                if (!existing.labels.includes(label)) existing.labels.push(label);
            }
        }
        return orderByPriority(Array.from(unique.values()).sort((a, b) => Number(a.partial) - Number(b.partial)));
    }

    /**
     * Build the real language group, also used by the hub preview. The layout
     * applies the combined cap to its children: badge, audio, then subtitles.
     * @param {Array|Object} languages - Legacy audio array or {audio, subtitles}.
     * @param {number} [cap] - Used only to preserve the invalid-flag guard.
     * @param {Function} [flagSource] - Preview's inline flag source.
     * @returns {HTMLElement}
     */
    function buildGroup(languages, cap = 3, flagSource = JE.core.mediaLanguage.flagSrc) {
        const data = Array.isArray(languages) ? { audio: languages } : (languages || {});
        const conf = readSettings();
        const audio = conf.audio ? resolveChips(data.audio, conf.style) : [];
        const subtitles = conf.subtitles ? resolveChips(data.subtitles, conf.style) : [];
        // Count languages rather than countries: Hindi and Tamil share a flag.
        const count = conf.audio && conf.badge !== 'off' ? new Set(resolveChips(data.audio, 'codes').map(chip => chip.text).filter(code => code !== 'ZXX')).size : 0;
        const badge = conf.badge !== 'off' && count >= 2;
        const chips = [];
        if (badge) chips.push({ badge: count === 2 ? 'dual' : 'multi' });
        if (!badge || conf.badge !== 'only') chips.push(...audio);
        chips.push(...subtitles.map(chip => ({ ...chip, subtitle: true })));
        const wrap = document.createElement('div');
        wrap.className = containerClass;
        const visible = cap > 0 ? chips.slice(0, cap) : chips;
        if (conf.style === 'flags' && visible.some(chip => !chip.badge && typeof chip.countryCode !== 'string')) return wrap;
        for (const info of chips) {
            if (!info.badge && conf.style === 'flags' && typeof info.countryCode !== 'string') continue;
            const chip = document.createElement(info.badge || info.subtitle || conf.style === 'codes' ? 'span' : 'img');
            chip.className = info.badge ? 'language-count-badge language-chip' : conf.style === 'codes' ? 'language-code language-chip' : info.subtitle ? 'language-subtitle language-chip' : flagClass;
            if (info.partial) { chip.classList.add(partialFlagClass); chip.dataset.partial = 'true'; }
            chip.dataset.jeLanguage = info.badge ? 'countBadge' : info.subtitle ? 'subtitles' : 'flag';
            if (info.badge) {
                chip.textContent = JE.t(`language_tags_${info.badge}`);
                chip.title = JE.t('language_tags_count_tooltip', { count });
            } else {
                const label = info.labels.join(', ');
                chip.title = info.subtitle ? `${JE.t('language_tags_subtitles')}: ${label}` : label;
                chip.dataset.langName = info.allLanguages.join(', ');
                chip.dataset.lang = conf.style === 'codes' ? info.text.toLowerCase() : info.countryCode.toLowerCase();
                if (info.subtitle) {
                    const cc = document.createElement('span');
                    cc.className = 'language-cc';
                    cc.textContent = 'CC';
                    cc.setAttribute('aria-hidden', 'true');
                    chip.appendChild(cc);
                }
                if (conf.style === 'codes') chip.appendChild(document.createTextNode(info.text));
                else {
                    const img = info.subtitle ? document.createElement('img') : chip;
                    img.src = flagSource(info.countryCode);
                    img.className = info.subtitle ? flagClass : chip.className;
                    img.alt = chip.title;
                    img.loading = 'lazy';
                    img.onerror = () => chip.remove();
                    if (info.subtitle) chip.appendChild(img);
                }
            }
            wrap.appendChild(chip);
        }
        return wrap;
    }

    /** Attach the language group through the shared renderer/layout controller. */
    function insertLanguageTags(ctx, container, languages) {
        if (!container || ctx.isTagged(container)) return;
        ctx.removeExistingOverlay(container);
        if (container.style.position !== 'relative') container.style.position = 'relative';
        const cap = JE.core.tagLayout ? JE.core.tagLayout.resolveLayout(container).caps.language : 3;
        ctx.commitOverlay(container, buildGroup(languages, cap));
    }

    JE.core.languageTags = { readSettings, buildGroup };

    /** @type {Object} Factory spec — everything language-specific lives here. */
    const spec = {
        logPrefix,
        settingKey: 'languageTagsEnabled',
        containerClass,
        taggedAttr: 'jeLanguageTagged',
        styleId: 'language-tags-styles',
        position: { userKey: 'languageTagsPosition', pluginKey: 'LanguageTagsPosition', fallback: 'bottom-left' },
        cache: {
            // v3: entries keep both audio and subtitle facts. v2 kept region subtags instead of stripped
            // base codes; the old key is cleaned up via legacyPrefix so stale
            // stripped entries can't pin the wrong flag for the 30-day TTL.
            // Both prior generations are listed — dropping the ancient
            // un-namespaced stem would leave its keys orphaned forever.
            key: 'JellyfinEnhanced-languageTagsCache-v3',
            legacyPrefix: ['JellyfinEnhanced-languageTagsCache-v2', 'JellyfinEnhanced-languageTagsCache', 'languageTagsCache'],
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
                .${containerClass} > * { pointer-events: auto; }
                .language-chip {
                    display: inline-flex; align-items: center; gap: 3px;
                    align-self: flex-start; flex-shrink: 0; width: max-content;
                    padding: 2px 4px; border: 1px solid rgba(255,255,255,0.8);
                    border-radius: 3px; background: rgba(0,0,0,0.75); color: #fff;
                    font: 700 clamp(9px, 6cqw, 12px)/1 sans-serif;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.4);
                }
                .language-cc { font-size: 0.7em; }
                .language-subtitle .language-flag { box-shadow: none; }
                /* Dub that doesn't cover every episode: dimmed, washed out and
                   dash-outlined so it reads as "incomplete" next to a full flag.
                   The dark ring keeps the white dashes (and a white flag's edge)
                   visible on light posters. */
                .${partialFlagClass} {
                    opacity: 0.55;
                    filter: saturate(0.5);
                    outline: 1px dashed rgba(255, 255, 255, 0.95);
                    outline-offset: -1px;
                    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
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
                    if (hot.value) insertLanguageTags(ctx, el, hot.value);
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

                var languages = { audio: extractLanguagesFromItem(sourceItem), subtitles: item.SubtitleLanguages || extractLanguagesFromItem(sourceItem, 'Subtitle') };

                if (languages.audio.length || languages.subtitles.length) {
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
                    if (languages && !Array.isArray(languages)) {
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
                codes = codes || [];
                // Series/Season: AudioLanguages is the union over all episodes and
                // PartialAudioLanguages the ones missing from some of them.
                var partial = new Set(entry.PartialAudioLanguages || []);
                var languages = codes.map(function(code) {
                    return { name: displayName(code), code: code, partial: partial.has(code) };
                });
                insertLanguageTags(ctx, el, { audio: languages, subtitles: entry.SubtitleLanguages || [] });
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
