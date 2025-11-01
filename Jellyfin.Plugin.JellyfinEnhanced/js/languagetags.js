// /js/languagetags.js
// Jellyfin Language Flags Overlay
(function(JE) {
    'use strict';

    JE.initializeLanguageTags = function() {
        if (!JE.currentSettings.languageTagsEnabled) {
            console.log('🪼 Jellyfin Enhanced: Language Tags: Feature is disabled in settings.');
            return;
        }

        const logPrefix = '🪼 Jellyfin Enhanced: Language Tags:';
        const containerClass = 'language-overlay-container';
        const flagClass = 'language-flag';
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
            '.formDialog .cardImageContainer'
        ];

        let langCache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        const Hot = (JE._hotCache = JE._hotCache || { ttl: CACHE_TTL });
        Hot.language = Hot.language || new Map();

        let processedElements = new WeakSet();
        let requestQueue = [];
        let isProcessingQueue = false;
        const queuedItemIds = new Set();

        const visibilityObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => { if (entry.isIntersecting) processElement(entry.target, true); });
        }, { rootMargin: '200px', threshold: 0.1 });

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

        function getUserId() { return ApiClient.getCurrentUserId(); }

        // Language to country code mapping (shared with features.js)
        const languageToCountryMap = {
            English: 'gb', eng: 'gb', Japanese: 'jp', jpn: 'jp', Spanish: 'es', spa: 'es', French: 'fr', fre: 'fr', fra: 'fr',
            German: 'de', ger: 'de', deu: 'de', Italian: 'it', ita: 'it', Korean: 'kr', kor: 'kr', Chinese: 'cn', chi: 'cn',
            zho: 'cn', Russian: 'ru', rus: 'ru', Portuguese: 'pt', por: 'pt', Hindi: 'in', hin: 'in', Dutch: 'nl', dut: 'nl',
            nld: 'nl', Arabic: 'sa', ara: 'sa', Bengali: 'bd', ben: 'bd', Czech: 'cz', ces: 'cz', cze: 'cz', Danish: 'dk',
            dan: 'dk', Greek: 'gr', ell: 'gr', gre: 'gr', Finnish: 'fi', fin: 'fi', Hebrew: 'il', heb: 'il', Hungarian: 'hu',
            hun: 'hu', Indonesian: 'id', ind: 'id', Norwegian: 'no', nor: 'no', Polish: 'pl', pol: 'pl', Persian: 'ir',
            per: 'ir', fas: 'ir', Romanian: 'ro', ron: 'ro', rum: 'ro', Swedish: 'se', swe: 'se', Thai: 'th', tha: 'th',
            Turkish: 'tr', tur: 'tr', Ukrainian: 'ua', ukr: 'ua', Vietnamese: 'vn', vie: 'vn', Malay: 'my', msa: 'my',
            may: 'my', Swahili: 'ke', swa: 'ke', Tagalog: 'ph', tgl: 'ph', Filipino: 'ph', Tamil: 'in', tam: 'in',
            Telugu: 'in', tel: 'in', Marathi: 'in', mar: 'in', Punjabi: 'in', pan: 'in', Urdu: 'pk', urd: 'pk',
            Gujarati: 'in', guj: 'in', Kannada: 'in', kan: 'in', Malayalam: 'in', mal: 'in', Sinhala: 'lk', sin: 'lk',
            Nepali: 'np', nep: 'np', Pashto: 'af', pus: 'af', Kurdish: 'iq', kur: 'iq', Slovak: 'sk', slk: 'sk',
            Slovenian: 'si', slv: 'si', Serbian: 'rs', srp: 'rs', Croatian: 'hr', hrv: 'hr', Bulgarian: 'bg', bul: 'bg',
            Macedonian: 'mk', mkd: 'mk', Albanian: 'al', sqi: 'al', Estonian: 'ee', est: 'ee', Latvian: 'lv', lav: 'lv',
            Lithuanian: 'lt', lit: 'lt', Icelandic: 'is', ice: 'is', isl: 'is', Georgian: 'ge', kat: 'ge', Armenian: 'am',
            hye: 'am', Mongolian: 'mn', mon: 'mn', Kazakh: 'kz', kaz: 'kz', Uzbek: 'uz', uzb: 'uz', Azerbaijani: 'az',
            aze: 'az', Belarusian: 'by', bel: 'by', Amharic: 'et', amh: 'et', Zulu: 'za', zul: 'za', Afrikaans: 'za',
            afr: 'za', Hausa: 'ng', hau: 'ng', Yoruba: 'ng', yor: 'ng', Igbo: 'ng', ibo: 'ng'
        };

        async function fetchItemLanguages(userId, itemId) {
            try {
                const result = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`/Users/${userId}/Items`, {
                        Ids: itemId,
                        Fields: 'MediaStreams,MediaSources,MediaInfo'
                    }),
                    dataType: 'json'
                });
                const item = result?.Items?.[0];
                const languages = new Set();
                item?.MediaSources?.forEach(source => {
                    source.MediaStreams?.filter(stream => stream.Type === 'Audio').forEach(stream => {
                        const langCode = stream.Language;
                        if (langCode && !['und', 'root'].includes(langCode.toLowerCase())) {
                            try {
                                const langName = new Intl.DisplayNames(['en'], { type: 'language' }).of(langCode);
                                languages.add(JSON.stringify({ name: langName, code: langCode }));
                            } catch (e) {
                                languages.add(JSON.stringify({ name: langCode.toUpperCase(), code: langCode }));
                            }
                        }
                    });
                });
                return normalizeLanguages(Array.from(languages).map(JSON.parse));
            } catch (e) {
                console.warn(`${logPrefix} Failed to fetch item language for ${itemId}`, e);
                return [];
            }
        }

        async function processRequestQueue() {
            if (isProcessingQueue || requestQueue.length === 0) return;
            isProcessingQueue = true;
            const batch = requestQueue.splice(0, 6);
            const promises = batch.map(async ({ element, itemId, userId }) => {
                try {
                    const languages = await fetchItemLanguages(userId, itemId);
                    // Cache hot + persisted
                    Hot.language.set(itemId, { value: languages, timestamp: Date.now() });
                    langCache[itemId] = languages;
                    if (languages && languages.length) insertLanguageTags(element, languages);
                    queuedItemIds.delete(itemId);
                } catch (e) {
                    queuedItemIds.delete(itemId);
                }
            });
            await Promise.allSettled(promises);
            isProcessingQueue = false;
            if (requestQueue.length > 0) setTimeout(processRequestQueue, 200);
        }

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
            if (!container || processedElements.has(container)) return;
            const existing = container.querySelector(`.${containerClass}`);
            // Always re-render to handle cache migrations or setting changes
            if (existing) existing.remove();
            if (getComputedStyle(container).position === 'static') container.style.position = 'relative';

            const wrap = document.createElement('div');
            wrap.className = containerClass;
            const pos = computePositionStyles();
            wrap.style.position = 'absolute';
            wrap.style.top = pos.top; wrap.style.right = pos.right; wrap.style.bottom = pos.bottom; wrap.style.left = pos.left;

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
                img.src = `https://flagcdn.com/w160/${flagInfo.countryCode.toLowerCase()}.png`;
                img.className = flagClass;
                img.alt = flagInfo.allLanguages.join(', ');
                img.title = flagInfo.allLanguages.join(', ');
                img.loading = 'lazy';
                wrap.appendChild(img);
            });
            if (wrap.children.length > 0) {
                container.appendChild(wrap);
                processedElements.add(container);
            }
        }

        function getItemIdFromElement(el) {
            // Try href pattern ...id=<ID>
            if (el.href) {
                try {
                    const url = new URL(el.href, window.location.origin);
                    const idParam = url.searchParams.get('id');
                    if (idParam) return idParam;
                } catch {}
                // Fallback: parse from hash fragment
                const m = el.href.match(/[?#&]id=([^&#]+)/);
                if (m && m[1]) return m[1];
            }
            // Try background-image url containing /Items/<ID>
            if (el.style && el.style.backgroundImage) {
                const match = el.style.backgroundImage.match(/Items\/(.*?)\//);
                if (match && match[1]) return match[1];
            }
            if (el.dataset?.itemid) return el.dataset.itemid;
            let parent = el.closest('[data-itemid]');
            if (parent) return parent.dataset.itemid;
            // Fallback to legacy data-id
            let parent2 = el.closest('[data-id]');
            return parent2 ? parent2.dataset.id : null;
        }

        function shouldIgnoreElement(el) {
            return IGNORE_SELECTORS.some(selector => {
                try {
                    return el.closest(selector) !== null;
                } catch {
                    return false; // Silently handle potential errors with complex selectors
                }
            });
        }

        function processElement(element, isPriority = false) {
            if (shouldIgnoreElement(element) || processedElements.has(element)) return;
            const card = element.closest('.card');
            if (!card || !card.dataset.type || !MEDIA_TYPES.has(card.dataset.type)) return;
            const itemId = getItemIdFromElement(element);
            if (!itemId) return;

            // Hot cache
            const hot = Hot.language.get(itemId);
            if (hot && (Date.now() - hot.timestamp) < Hot.ttl) {
                if (hot.value && hot.value.length) insertLanguageTags(element, hot.value);
                processedElements.add(element);
                return;
            }
            // Persisted cache
            let cached = langCache[itemId];
            if (cached && cached.length) {
                const normalized = normalizeLanguages(cached);
                Hot.language.set(itemId, { value: normalized, timestamp: Date.now() });
                insertLanguageTags(element, normalized);
                processedElements.add(element);
                return;
            }

            const userId = getUserId(); if (!userId) return;
            if (queuedItemIds.has(itemId)) return;
            queuedItemIds.add(itemId);
            const req = { element, itemId, userId };
            if (isPriority) requestQueue.unshift(req); else requestQueue.push(req);
            if (!isProcessingQueue) setTimeout(processRequestQueue, 150);
            visibilityObserver.observe(element);
        }

        function scanAndProcess() {
            const elements = Array.from(document.querySelectorAll('.cardImageContainer, div.listItemImage'));
            elements.forEach(el => {
                if (!processedElements.has(el)) {
                    visibilityObserver.observe(el);
                    processElement(el);
                }
            });
        }

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
                }
                .${flagClass} {
                    width: 30px;
                    height: auto;
                    border-radius: 2px;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.4);
                }
            `;
            document.head.appendChild(style);
        }

        function initialize() {
            cleanupOldCaches();
            injectCss();
            setTimeout(scanAndProcess, 500);
            const mo = new MutationObserver(() => {
                // Check if feature is still enabled before processing
                if (!JE.currentSettings?.languageTagsEnabled) {
                    return;
                }
                setTimeout(scanAndProcess, 400);
            });
            mo.observe(document.body, { childList: true, subtree: true });
            window.addEventListener('beforeunload', saveCache);
            setInterval(saveCache, 120000);
        }

        initialize();
        console.log(`${logPrefix} Initialized successfully.`);
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

        // Trigger a fresh initialization which will set up everything with current settings
        JE.initializeLanguageTags();
    };

})(window.JellyfinEnhanced);
