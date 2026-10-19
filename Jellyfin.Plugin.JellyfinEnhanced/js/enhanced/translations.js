// /js/enhanced/translations.js
(function(JE) {
    'use strict';

    // Newer-than-bundled locales are fetched via the plugin's local CDN route
    // (JE.cdn source 'locales'), which server-side proxies + caches the upstream repo's
    // raw locale JSON. The client never contacts raw.githubusercontent.com directly.
    const remoteLocaleUrl = (code) => JE.cdn.url('locales', `${code}.json`);
    const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

    function normalizeLangCode(code) {
        if (!code) return code;
        const parts = code.split('-');
        if (parts.length === 1) return parts[0].toLowerCase();
        if (parts.length === 2) return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
        return code;
    }

    // The display-language rule, the same data as the server's (Helpers/LanguageTags.cs): what JE stores, seeds or writes
    // into Jellyfin's shared language key is a language tag that resolves to a locale bundle JE ships, exactly or by its
    // base language. The server writes the policy in on the next line when it serves this file: the tag syntax
    // (js/language-policy.json) and the locale bundles this build ships (its embedded js/locales). Carried here because
    // translations load before the public configuration. Unserved (null), JE has no rule: JE.languageCode and
    // JE.supportedLanguageCode stay undefined, and nothing writes or removes a language.
    const LANGUAGE_POLICY = null; // je:language-policy
    const LANGUAGE_TAG = LANGUAGE_POLICY ? new RegExp(LANGUAGE_POLICY.tag) : null;
    const SHIPPED_LANGUAGES = new Map((LANGUAGE_POLICY ? LANGUAGE_POLICY.shipped : []).map(code => [code.toLowerCase(), code]));

    /** The value without the policy's space characters at either end (ASCII only, as on the server). */
    function trimSpace(value) {
        let start = 0, end = value.length;
        while (start < end && LANGUAGE_POLICY.space.includes(value[start])) start++;
        while (end > start && LANGUAGE_POLICY.space.includes(value[end - 1])) end--;
        return value.slice(start, end);
    }

    /**
     * A complete language tag in canonical case (`en-au` → `en-AU`, `zh-hant-tw` → `zh-Hant-TW`), or '' for anything
     * else: a literal "undefined" or "null" (a value stringified by mistake), an empty or malformed value (`en-12`,
     * `en-US-US`). The policy's syntax rule only: whether JE ships the language isn't checked (reading stays lenient).
     * @param {*} raw A stored or configured value.
     * @returns {string} The tag, or ''.
     */
    function languageCode(raw) {
        if (!LANGUAGE_POLICY || typeof raw !== 'string') return '';
        const code = trimSpace(raw);
        if (LANGUAGE_POLICY.reserved.includes(code.toLowerCase())) return '';
        const match = LANGUAGE_TAG.exec(code);
        if (!match || match[0].length !== code.length) return '';
        const { language, script, region, variants } = match.groups;
        const list = (variants || '').split('-').filter(Boolean).map(v => v.toLowerCase());
        if (new Set(list).size !== list.length) return '';
        return [language.toLowerCase(), script ? script[0].toUpperCase() + script.slice(1).toLowerCase() : '',
            region ? region.toUpperCase() : '', ...list].filter(Boolean).join('-');
    }

    /**
     * The shipped locale bundle a value resolves to (the tag's own, else its base language's), as the build names it
     * (`pt-br` → `pt-BR`, `de-Latn-CH` → `de`), or '' when JE ships none for it.
     * @param {*} raw A stored, configured or chosen value.
     * @returns {string} The bundle's code, or ''.
     */
    function languageBundle(raw) {
        const lower = languageCode(raw).toLowerCase();
        return lower ? SHIPPED_LANGUAGES.get(lower) || SHIPPED_LANGUAGES.get(lower.split('-')[0]) || '' : '';
    }

    /**
     * The language tag JE may WRITE (Jellyfin's shared `${userId}-language` key, its own displayLanguage): a tag
     * {@link languageCode} accepts whose bundle JE ships (exactly, or its base language), else '' (Auto). Never what the
     * browser happens to know (the server stores the same: a save answers what it stored).
     * @param {*} raw A stored, configured or chosen value.
     * @returns {string} The tag, or ''.
     */
    function supportedLanguageCode(raw) {
        return languageBundle(raw) ? languageCode(raw) : '';
    }

    if (LANGUAGE_POLICY) {
        JE.languageCode = languageCode;
        JE.languageBundle = languageBundle;
        JE.supportedLanguageCode = supportedLanguageCode;
    }

    function buildLanguageChain(primaryLang) {
        const normalizedLang = normalizeLangCode(primaryLang);
        const langCodes = [];

        if (normalizedLang) {
            langCodes.push(normalizedLang);
        }

        if (normalizedLang && normalizedLang.includes('-')) {
            const baseLang = normalizedLang.split('-')[0];
            if (!langCodes.includes(baseLang)) {
                langCodes.push(baseLang);
            }
        }

        if (langCodes[langCodes.length - 1] !== 'en') {
            langCodes.push('en');
        }

        return Array.from(new Set(langCodes.filter(Boolean)));
    }

    async function getPluginVersion() {
        let pluginVersion = JE?.pluginVersion;
        if (pluginVersion && pluginVersion !== 'unknown') return pluginVersion;

        try {
            const versionResponse = await fetch(ApiClient.getUrl('/JellyfinEnhanced/version'));
            if (versionResponse.ok) {
                pluginVersion = await versionResponse.text();
                if (JE) {
                    JE.pluginVersion = pluginVersion;
                }
                return pluginVersion;
            }
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Failed to fetch plugin version', e);
        }

        return 'unknown';
    }

    /**
     * Returns the build identity the translation cache is keyed by: the injected script
     * tag's `version` attribute, `{version}-{dllTimestamp}` (the same value the script URLs
     * use). It changes with every build even when the plugin version does not, so entries an
     * earlier build wrote (older locale files, or upstream English the previous loader stored
     * under `en`) are dropped by cleanOldTranslationCache instead of being reused. Falls back
     * to the bare plugin version when the tag is missing.
     * @returns {Promise<string>} The translation cache version.
     */
    async function getTranslationCacheVersion() {
        const scriptEl = document.querySelector('script[plugin="Jellyfin Enhanced"]');
        const buildKey = scriptEl?.getAttribute('version');
        if (buildKey) return buildKey;
        return getPluginVersion();
    }

    function cleanOldTranslationCache(pluginVersion) {
        try {
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const key = localStorage.key(i);
                if (key && (key.startsWith('JE_translation_') || key.startsWith('JE_translation_ts_'))) {
                    if (!key.includes(`_${pluginVersion}`)) {
                        localStorage.removeItem(key);
                        console.log(`🪼 Jellyfin Enhanced: Removed old translation cache: ${key}`);
                    }
                }
            }
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Failed to clean up old translation caches', e);
        }
    }

    /**
     * Reads one language's strings from the versioned localStorage cache.
     * @param {string} code - Normalized language code (e.g. `en`, `en-GB`).
     * @param {string} pluginVersion - Translation cache version (build identity) the entry is keyed by.
     * @returns {object|null} The cached strings, or null when absent, expired or unreadable.
     */
    function readCachedTranslations(code, pluginVersion) {
        const cachedTranslations = localStorage.getItem(`JE_translation_${code}_${pluginVersion}`);
        const cachedTimestamp = localStorage.getItem(`JE_translation_ts_${code}_${pluginVersion}`);

        if (cachedTranslations && cachedTimestamp) {
            const age = Date.now() - parseInt(cachedTimestamp, 10);
            if (age < CACHE_DURATION) {
                console.log(`🪼 Jellyfin Enhanced: Using cached translations for ${code} (age: ${Math.round(age / 1000 / 60)} minutes, version: ${pluginVersion})`);
                try {
                    return JSON.parse(cachedTranslations);
                } catch (e) {
                    console.warn('🪼 Jellyfin Enhanced: Failed to parse cached translations, will fetch fresh', e);
                }
            }
        }
        return null;
    }

    /**
     * Loads this build's bundled English strings, the per-key fallback for every other
     * locale. Shares the build-keyed 24 h cache entry of `en`, which only ever holds this
     * build's bundled en.json: this loader never stores remote upstream copies under it,
     * and entries from earlier builds (including the previous loader's) carry another key.
     * @param {string} pluginVersion - Translation cache version (build identity) the entry is keyed by.
     * @returns {Promise<object|null>} The bundled English strings, or null when they cannot be loaded.
     */
    async function loadBundledEnglish(pluginVersion) {
        const cached = readCachedTranslations('en', pluginVersion);
        if (cached) return cached;

        try {
            const response = await fetch(ApiClient.getUrl('/JellyfinEnhanced/locales/en.json'));
            if (!response.ok) return null;
            const translations = await response.json();
            try {
                localStorage.setItem(`JE_translation_en_${pluginVersion}`, JSON.stringify(translations));
                localStorage.setItem(`JE_translation_ts_en_${pluginVersion}`, Date.now().toString());
            } catch (e) { /* ignore */ }
            return translations;
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Failed to load bundled English fallback strings', e);
            return null;
        }
    }

    /**
     * Fills the keys a resolved locale lacks (e.g. an older Weblate file or upstream's
     * remote copy, which miss strings added in this build) with bundled English, so
     * JE.t never falls back to the raw key. Bundled English itself is returned as-is.
     * @param {{translations: object, usedLang: string, remote?: boolean}} result - Locale chosen by the language chain.
     * @param {string} pluginVersion - Translation cache version (build identity) the English entry is keyed by.
     * @returns {Promise<object>} The locale's strings layered over bundled English.
     */
    async function withEnglishFallback(result, pluginVersion) {
        if (result.usedLang === 'en' && !result.remote) return result.translations;
        const english = await loadBundledEnglish(pluginVersion);
        return english ? { ...english, ...result.translations } : result.translations;
    }

    async function tryLoadSingleLanguage(code, pluginVersion) {
        const cacheKey = `JE_translation_${code}_${pluginVersion}`;
        const timestampKey = `JE_translation_ts_${code}_${pluginVersion}`;
        const cachedTranslations = readCachedTranslations(code, pluginVersion);
        if (cachedTranslations) {
            return { translations: cachedTranslations, usedLang: code };
        }

        console.log(`🪼 Jellyfin Enhanced: Loading bundled translations for ${code}...`);
        // Only a definitive 404 means this build ships no file for the code; a thrown error or
        // another status may be transient, so the locale must be retried on the next load.
        let bundledMissing = false;
        try {
            const bundledResponse = await fetch(ApiClient.getUrl(`/JellyfinEnhanced/locales/${code}.json`));
            bundledMissing = bundledResponse.status === 404;
            if (bundledResponse.ok) {
                const translations = await bundledResponse.json();
                try {
                    localStorage.setItem(cacheKey, JSON.stringify(translations));
                    localStorage.setItem(timestampKey, Date.now().toString());
                    console.log(`🪼 Jellyfin Enhanced: Successfully loaded and cached bundled translations for ${code} (version: ${pluginVersion})`);
                } catch (e) { /* ignore */ }
                return { translations, usedLang: code };
            }
        } catch (bundledError) {
            console.warn('🪼 Jellyfin Enhanced: Bundled translations failed, falling back to GitHub:', bundledError.message);
        }

        try {
            console.log(`🪼 Jellyfin Enhanced: Fetching translations for ${code} from GitHub...`);
            const githubResponse = await fetch(remoteLocaleUrl(code), {
                method: 'GET',
                cache: 'no-cache',
                headers: { 'Accept': 'application/json' }
            });

            if (githubResponse.ok) {
                const translations = await githubResponse.json();
                // The `en` entry is reserved for the bundled en.json (the per-key fallback base).
                if (code !== 'en') {
                    try {
                        localStorage.setItem(cacheKey, JSON.stringify(translations));
                        localStorage.setItem(timestampKey, Date.now().toString());
                        console.log(`🪼 Jellyfin Enhanced: Successfully fetched and cached translations for ${code} from GitHub (version: ${pluginVersion})`);
                    } catch (storageError) {
                        console.warn('🪼 Jellyfin Enhanced: Failed to cache translations (localStorage full?)', storageError);
                    }
                }
                return { translations, usedLang: code, remote: true };
            }

            if (githubResponse.status === 404 && code !== 'en') {
                console.warn(`🪼 Jellyfin Enhanced: Language ${code} not found on GitHub, falling back to English`);
                const englishResponse = await fetch(remoteLocaleUrl('en'), {
                    method: 'GET',
                    cache: 'no-cache',
                    headers: { 'Accept': 'application/json' }
                });

                if (englishResponse.ok) {
                    const translations = await englishResponse.json();
                    // Cached for the requested code (the `en` entry is reserved for the bundled
                    // en.json), and only when the locale is definitively missing from this build.
                    if (bundledMissing) {
                        try {
                            localStorage.setItem(cacheKey, JSON.stringify(translations));
                            localStorage.setItem(timestampKey, Date.now().toString());
                        } catch (e) { /* ignore */ }
                    }
                    return { translations, usedLang: 'en', remote: true };
                }
            }

            if (githubResponse.status === 403) {
                console.warn('🪼 Jellyfin Enhanced: GitHub rate limit detected, using bundled fallback');
            } else if (githubResponse.status >= 500) {
                console.warn(`🪼 Jellyfin Enhanced: GitHub server error (${githubResponse.status}), using bundled fallback`);
            }

            throw new Error(`GitHub fetch failed with status ${githubResponse.status}`);
        } catch (githubError) {
            console.warn('🪼 Jellyfin Enhanced: GitHub fetch failed, falling back to bundled translations:', githubError.message);
        }

        console.log(`🪼 Jellyfin Enhanced: Loading bundled translations for ${code}...`);
        let response = await fetch(ApiClient.getUrl(`/JellyfinEnhanced/locales/${code}.json`));

        if (response.ok) {
            const translations = await response.json();
            try {
                localStorage.setItem(cacheKey, JSON.stringify(translations));
                localStorage.setItem(timestampKey, Date.now().toString());
            } catch (e) { /* ignore */ }
            return { translations, usedLang: code };
        }

        console.warn(`🪼 Jellyfin Enhanced: Bundled ${code} not found, falling back to bundled English`);
        response = await fetch(ApiClient.getUrl('/JellyfinEnhanced/locales/en.json'));
        if (response.ok) {
            return { translations: await response.json(), usedLang: 'en' };
        }

        throw new Error('Failed to load English fallback translations');
    }

    JE.loadTranslations = async function() {
        try {
            const pluginVersion = await getTranslationCacheVersion();

            let user = ApiClient.getCurrentUser ? ApiClient.getCurrentUser() : null;
            if (user instanceof Promise) {
                user = await user;
            }

            const userId = user?.Id;
            let lang = 'en';
            if (userId) {
                const storageKey = `${userId}-language`;
                // A junk value ("undefined", "null", malformed) is no language: fall back as if none were set.
                const storedLang = languageCode(localStorage.getItem(storageKey));
                if (storedLang) {
                    lang = storedLang;
                } else {
                    // Fall back to the HTML lang attribute set by Jellyfin's web client.
                    // This covers the Android app and other clients where the localStorage
                    // key may not exist but Jellyfin has already resolved the user's
                    // preferred language from server-side settings.
                    const docLang = languageCode(document.documentElement.lang);
                    if (docLang) {
                        lang = docLang;
                    }
                }
            }

            cleanOldTranslationCache(pluginVersion);

            const langCodes = buildLanguageChain(lang);
            for (const code of langCodes) {
                try {
                    const result = await tryLoadSingleLanguage(code, pluginVersion);
                    if (result && result.translations) {
                        return await withEnglishFallback(result, pluginVersion);
                    }
                } catch (e) {
                    console.warn(`🪼 Jellyfin Enhanced: Failed to load translations for ${code}`, e);
                }
            }

            console.error('🪼 Jellyfin Enhanced: Failed to load translations from any source');
            return {};
        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: Failed to load translations:', error);
            return {};
        }
    };
})(window.JellyfinEnhanced);
