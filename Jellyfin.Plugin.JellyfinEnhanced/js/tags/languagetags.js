// /js/tags/languagetags.js
// Jellyfin Language Flags Overlay
(function(JE) {
    'use strict';

    JE.initializeLanguageTags = function() {
        const logPrefix = '🪼 Jellyfin Enhanced: Language Tags:';
        const containerClass = 'language-overlay-container';
        const flagClass = 'language-flag';
        const TAGGED_ATTR = 'jeLanguageTagged';
        const CACHE_KEY = 'JellyfinEnhanced-languageTagsCache';
        const CACHE_TIMESTAMP_KEY = 'JellyfinEnhanced-languageTagsCacheTimestamp';
        const CACHE_TTL = (JE.pluginConfig?.TagsCacheTtlDays || 30) * 24 * 60 * 60 * 1000;
        const MEDIA_TYPES = new Set(['Movie', 'Episode', 'Series', 'Season']);

        // CSS selectors for elements that should NOT have language tags applied.
        // This is used to ignore certain views like the cast & crew list.
        const IGNORE_SELECTORS = [
            '#itemDetailPage .infoWrapper .cardImageContainer',
            '#itemDetailPage #castCollapsible .cardImageContainer',
            '#indexPage .verticalSection.MyMedia .cardImageContainer',
            '.formDialog .cardImageContainer',
            '#itemDetailPage .chapterCardImageContainer',
            // Admin/dashboard pages
            '#pluginsPage .cardImageContainer',
            '#pluginsPage .card',
            '#pluginCatalogPage .cardImageContainer',
            '#pluginCatalogPage .card',
            '#devicesPage .cardImageContainer',
            '#devicesPage .card',
            '#mediaLibraryPage .cardImageContainer',
            '#mediaLibraryPage .card'
        ];

        // Add search page to ignore list if configured (Gelato compatibility)
        if (JE.pluginConfig?.DisableTagsOnSearchPage === true) {
            IGNORE_SELECTORS.push('#searchPage .cardImageContainer');
        }

        let langCache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        const Hot = (JE._hotCache = JE._hotCache || { ttl: CACHE_TTL });
        Hot.language = Hot.language || new Map();

        function saveCache() {
            try { localStorage.setItem(CACHE_KEY, JSON.stringify(langCache)); }
            catch (e) { console.warn(`${logPrefix} Failed to save cache`, e); }
        }

        function cleanupOldCaches() {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.startsWith('languageTagsCache-') || key === 'languageTagsCache' || key === 'languageTagsCacheTimestamp') && key !== CACHE_KEY && key !== CACHE_TIMESTAMP_KEY) {
                    localStorage.removeItem(key);
                }
            }
            const serverClearTimestamp = JE.pluginConfig?.ClearLocalStorageTimestamp || 0;
            const localCacheTimestamp = parseInt(localStorage.getItem(CACHE_TIMESTAMP_KEY) || '0', 10);
            if (serverClearTimestamp > localCacheTimestamp) {
                console.log(`${logPrefix} Server triggered cache clear (${new Date(serverClearTimestamp).toISOString()})`);
                localStorage.removeItem(CACHE_KEY);
                localStorage.setItem(CACHE_TIMESTAMP_KEY, serverClearTimestamp.toString());
                langCache = {};
                if (JE._hotCache?.language) JE._hotCache.language.clear();
            }
        }

        // NOTE: getUserId removed - the unified tag pipeline handles user context.

        // Language to country code mapping (shared with features.js)
        const languageToCountryMap = {
            English: 'gb', eng: 'gb', Japanese: 'jp', jpn: 'jp', Spanish: 'es', spa: 'es', French: 'fr', fre: 'fr', fra: 'fr',
            German: 'de', ger: 'de', deu: 'de', Italian: 'it', ita: 'it', Korean: 'kr', kor: 'kr', Chinese: 'cn', chi: 'cn',
            zho: 'cn', Russian: 'ru', rus: 'ru', Portuguese: 'pt', por: 'pt', Hindi: 'in', hin: 'in', Dutch: 'nl', dut: 'nl',
            nld: 'nl', Arabic: 'sa', ara: 'sa', Bengali: 'in', ben: 'in', Czech: 'cz', ces: 'cz', Danish: 'dk',
            dan: 'dk', Greek: 'gr', ell: 'gr', Finnish: 'fi', fin: 'fi', Hebrew: 'il', heb: 'il', Hungarian: 'hu',
            hun: 'hu', Indonesian: 'id', ind: 'id', Norwegian: 'no', nor: 'no', Polish: 'pl', pol: 'pl', Persian: 'ir',
            per: 'ir', fas: 'ir', Romanian: 'ro', ron: 'ro', rum: 'ro', Swedish: 'se', swe: 'se', Thai: 'th', tha: 'th',
            Turkish: 'tr', tur: 'tr', Ukrainian: 'ua', ukr: 'ua', Vietnamese: 'vn', vie: 'vn', Malay: 'my', msa: 'my',
            may: 'my', Swahili: 'ke', swa: 'ke', Tagalog: 'ph', tgl: 'ph', Filipino: 'ph', Tamil: 'in', tam: 'in',
            Telugu: 'in', tel: 'in', Marathi: 'in', mar: 'in', Punjabi: 'in', pan: 'in', Urdu: 'pk', urd: 'pk',
            Gujarati: 'in', guj: 'in', Kannada: 'in', kan: 'in', Malayalam: 'in', mal: 'in', Sinhala: 'lk', sin: 'lk',
            Nepali: 'np', nep: 'np', Pashto: 'af', pus: 'af', Kurdish: 'iq', kur: 'iq', Slovak: 'sk', slk: 'sk',
            Slovenian: 'si', slv: 'si', Serbian: 'rs', srp: 'rs', Croatian: 'hr', hrv: 'hr', Bulgarian: 'bg', bul: 'bg',
            Macedonian: 'mk', mkd: 'mk', Albanian: 'al', sqi: 'al', Estonian: 'ee', est: 'ee', Latvian: 'lv', lav: 'lv',
            Lithuanian: 'lt', lit: 'lt', Icelandic: 'is', isl: 'is', Georgian: 'ge', kat: 'ge', Armenian: 'am',
            hye: 'am', Mongolian: 'mn', mon: 'mn', Kazakh: 'kz', kaz: 'kz', Uzbek: 'uz', uzb: 'uz', Azerbaijani: 'az',
            aze: 'az', Belarusian: 'by', bel: 'by', Amharic: 'et', amh: 'et', Zulu: 'za', zul: 'za', Afrikaans: 'za',
            afr: 'za', Hausa: 'ng', hau: 'ng', Yoruba: 'ng', yor: 'ng', Igbo: 'ng', ibo: 'ng', Brazilian: 'br', bra: 'br',
            Catalan: 'es-ct', cat: 'es-ct', ca: 'es-ct', Galician: 'es-ga', glg: 'es-ga', gl: 'es-ga', Basque: 'es-pv',
            baq: 'es-pv', eus: 'es-pv'
        };

        // NOTE: fetchFirstEpisode removed - the unified tag pipeline handles first episode fetching.

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
                            var langName = new Intl.DisplayNames(['en'], { type: 'language' }).of(langCode);
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

        /**
         * Legacy fallback: Fetches language info for a given item ID from the Jellyfin API.
         * NOTE: The primary path is through the tag pipeline renderer.
         */
        async function fetchItemLanguages(userId, itemId) {
            try {
                // Use cached item data (populated by batch prefetch) to avoid individual API calls
                var item;
                if (JE.helpers?.getItemCached) {
                    item = await JE.helpers.getItemCached(itemId, { userId });
                } else {
                    var result = await ApiClient.ajax({
                        type: 'GET',
                        url: ApiClient.getUrl(`/Users/${userId}/Items`, {
                            Ids: itemId,
                            Fields: 'MediaStreams,MediaSources,MediaInfo,Type'
                        }),
                        dataType: 'json'
                    });
                    item = result?.Items?.[0];
                }
                if (!item) return [];

                // Series/Season first-episode resolution is handled by the tag pipeline.
                // This fallback only processes items that have direct media streams.
                if (item.Type === 'Series' || item.Type === 'Season') return [];

                return extractLanguagesFromItem(item);
            } catch (e) {
                console.warn(`${logPrefix} Failed to fetch item language for ${itemId}`, e);
                return [];
            }
        }

        // NOTE: processRequestQueue removed - the unified tag pipeline handles queue processing.

        function computePositionStyles(position) {
            const pos = (position || JE.currentSettings?.languageTagsPosition || JE.pluginConfig?.LanguageTagsPosition || 'bottom-left');
            const styles = { top: 'auto', right: 'auto', bottom: 'auto', left: 'auto' };
            if (pos.includes('top')) styles.top = '6px'; else styles.bottom = '6px';
            if (pos.includes('left')) styles.left = '6px'; else styles.right = '6px';
            return styles;
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
                    // Handle legacy cache that stored ["en", "fr", ...]
                    const code = entry.split('-')[0].toLowerCase();
                    let name = null;
                    try { name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code.toUpperCase(); }
                    catch { name = code.toUpperCase(); }
                    obj = { name, code };
                } else if (typeof entry === 'object') {
                    const code = (entry.code || entry.Code || '').toString().split('-')[0];
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

        function insertLanguageTags(container, languages) {
            if (!container) return;
            if (isCardAlreadyTagged(container)) return;
            const existing = container.querySelector(`.${containerClass}`);
            // Always re-render to handle cache migrations or setting changes
            if (existing) existing.remove();
            if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

            const wrap = document.createElement('div');
            wrap.className = containerClass;
            const pos = computePositionStyles();
            wrap.style.position = 'absolute';
            wrap.style.top = pos.top; wrap.style.right = pos.right; wrap.style.bottom = pos.bottom; wrap.style.left = pos.left;
            // If positioned top-right and the card has indicators, add a top margin to avoid overlap
            const hasIndicators = !!container.querySelector('.cardIndicators');
            const isTopRight = pos.top !== 'auto' && pos.right !== 'auto';
            if (hasIndicators && isTopRight) {
                wrap.style.marginTop = 'clamp(20px, 3vw, 30px)';
            }

            const normalized = normalizeLanguages(languages);
            const maxToShow = 3;
            const seenCountries = new Set();
            const uniqueFlags = [];

            // Deduplicate by country code while preserving language info for tooltips
            normalized.forEach(lang => {
                const codeKey = (lang.code || '').toString().split('-')[0];
                const nameKey = (lang.name || '').toString();
                const countryCode = languageToCountryMap[nameKey] || languageToCountryMap[codeKey];
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
                img.src = `https://cdnjs.cloudflare.com/ajax/libs/flag-icons/7.2.1/flags/4x3/${flagInfo.countryCode.toLowerCase()}.svg`;
                img.className = flagClass;
                img.alt = flagInfo.allLanguages.join(', ');
                img.title = flagInfo.allLanguages.join(', ');
                img.loading = 'lazy';
                img.dataset.lang = flagInfo.countryCode.toLowerCase();
                img.dataset.langName = flagInfo.allLanguages.join(', ');
                wrap.appendChild(img);
            });
            if (wrap.children.length > 0) {
                container.appendChild(wrap);
                markCardTagged(container);
            }
        }

        // NOTE: getItemIdFromElement removed - the unified tag pipeline handles DOM -> itemId extraction.

        function shouldIgnoreElement(el) {
            return IGNORE_SELECTORS.some(selector => {
                try {
                    if (el.matches(selector)) return true;
                    return el.closest(selector) !== null;
                } catch {
                    return false; // Silently handle potential errors with complex selectors
                }
            });
        }

        function isCardAlreadyTagged(el) {
            const card = el.closest('.card');
            if (!card) return false;
            const hasAttr = card.dataset?.[TAGGED_ATTR] === '1';
            const hasOverlay = !!card.querySelector(`.${containerClass}`);
            return hasAttr && hasOverlay;
        }

        function markCardTagged(el) {
            const card = el.closest('.card');
            if (card) card.dataset[TAGGED_ATTR] = '1';
        }

        // NOTE: processElement, scanAndProcess, debouncedScan removed -
        // the unified tag pipeline handles DOM scanning, visibility observation,
        // queue processing, and navigation detection.

        function injectCss() {
            const styleId = 'language-tags-styles';
            if (document.getElementById(styleId)) return;
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
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
            document.head.appendChild(style);
        }

        // --- INITIALIZATION VIA TAG PIPELINE ---
        cleanupOldCaches();

        // Register with unified cache manager for periodic saves
        if (JE._cacheManager) {
            JE._cacheManager.register(saveCache);
        }
        window.addEventListener('beforeunload', saveCache);

        if (JE.tagPipeline) {
            JE.tagPipeline.registerRenderer('language', {
                render: function(el, item, extras) {
                    if (shouldIgnoreElement(el)) return;
                    if (isCardAlreadyTagged(el)) return;
                    // Skip cards hidden by hidden-content module
                    if (el.closest('.je-hidden')) return;

                    const itemId = item.Id;
                    // Check hot cache first
                    const hot = Hot.language.get(itemId);
                    if (hot && (Date.now() - hot.timestamp) < Hot.ttl) {
                        if (hot.value && hot.value.length) insertLanguageTags(el, hot.value);
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
                        langCache[itemId] = languages;
                        Hot.language.set(itemId, { value: languages, timestamp: Date.now() });
                        if (JE._cacheManager) JE._cacheManager.markDirty();
                        insertLanguageTags(el, languages);
                    }
                },
                renderFromCache: function(el, itemId) {
                    if (isCardAlreadyTagged(el)) return true;
                    if (shouldIgnoreElement(el)) return true;
                    if (el.closest('.je-hidden')) return true;
                    const hot = Hot.language.get(itemId);
                    const cached = hot || langCache[itemId];
                    if (cached) {
                        const languages = Array.isArray(cached) ? cached : cached.languages;
                        if (languages && languages.length > 0) {
                            insertLanguageTags(el, languages);
                            return true;
                        }
                    }
                    return false;
                },
                isEnabled: function() { return !!JE.currentSettings?.languageTagsEnabled; },
                needsFirstEpisode: true,
                needsParentSeries: false,
                injectCss: injectCss,
            });
            console.log(`${logPrefix} Registered with unified tag pipeline.`);
        } else {
            console.warn(`${logPrefix} Tag pipeline not available, language tags will not render.`);
        }
    };

    /**
     * Re-initializes the Language Tags feature
     * Cleans up existing state and re-applies tags.
     */
    JE.reinitializeLanguageTags = function() {
        const logPrefix = '🪼 Jellyfin Enhanced: Language Tags:';
        console.log(`${logPrefix} Re-initializing...`);

        // Always remove existing tags first
        document.querySelectorAll('.language-overlay-container').forEach(el => el.remove());

        if (!JE.currentSettings.languageTagsEnabled) {
            console.log(`${logPrefix} Feature is disabled after reinit.`);
            return;
        }

        // Trigger pipeline re-scan with current settings
        JE.tagPipeline?.scheduleScan();
    };

})(window.JellyfinEnhanced);
