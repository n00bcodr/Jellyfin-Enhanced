// /js/enhanced/translations.js
(function(JE) {
    'use strict';

    const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/n00bcodr/Jellyfin-Enhanced/main/Jellyfin.Plugin.JellyfinEnhanced/js/locales';
    const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

    function normalizeLangCode(code) {
        if (!code) return code;
        const parts = code.split('-');
        if (parts.length === 1) return parts[0].toLowerCase();
        if (parts.length === 2) return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
        return code;
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

    async function tryLoadSingleLanguage(code, pluginVersion) {
        const cacheKey = `JE_translation_${code}_${pluginVersion}`;
        const timestampKey = `JE_translation_ts_${code}_${pluginVersion}`;
        const cachedTranslations = localStorage.getItem(cacheKey);
        const cachedTimestamp = localStorage.getItem(timestampKey);

        if (cachedTranslations && cachedTimestamp) {
            const age = Date.now() - parseInt(cachedTimestamp, 10);
            if (age < CACHE_DURATION) {
                console.log(`🪼 Jellyfin Enhanced: Using cached translations for ${code} (age: ${Math.round(age / 1000 / 60)} minutes, version: ${pluginVersion})`);
                try {
                    return { translations: JSON.parse(cachedTranslations), usedLang: code };
                } catch (e) {
                    console.warn('🪼 Jellyfin Enhanced: Failed to parse cached translations, will fetch fresh', e);
                }
            }
        }

        console.log(`🪼 Jellyfin Enhanced: Loading bundled translations for ${code}...`);
        try {
            const bundledResponse = await fetch(ApiClient.getUrl(`/JellyfinEnhanced/locales/${code}.json`));
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
            const githubResponse = await fetch(`${GITHUB_RAW_BASE}/${code}.json`, {
                method: 'GET',
                cache: 'no-cache',
                headers: { 'Accept': 'application/json' }
            });

            if (githubResponse.ok) {
                const translations = await githubResponse.json();
                try {
                    localStorage.setItem(cacheKey, JSON.stringify(translations));
                    localStorage.setItem(timestampKey, Date.now().toString());
                    console.log(`🪼 Jellyfin Enhanced: Successfully fetched and cached translations for ${code} from GitHub (version: ${pluginVersion})`);
                } catch (storageError) {
                    console.warn('🪼 Jellyfin Enhanced: Failed to cache translations (localStorage full?)', storageError);
                }
                return { translations, usedLang: code };
            }

            if (githubResponse.status === 404 && code !== 'en') {
                console.warn(`🪼 Jellyfin Enhanced: Language ${code} not found on GitHub, falling back to English`);
                const englishResponse = await fetch(`${GITHUB_RAW_BASE}/en.json`, {
                    method: 'GET',
                    cache: 'no-cache',
                    headers: { 'Accept': 'application/json' }
                });

                if (englishResponse.ok) {
                    const translations = await englishResponse.json();
                    try {
                        const enCacheKey = `JE_translation_en_${pluginVersion}`;
                        const enTimestampKey = `JE_translation_ts_en_${pluginVersion}`;
                        localStorage.setItem(enCacheKey, JSON.stringify(translations));
                        localStorage.setItem(enTimestampKey, Date.now().toString());
                    } catch (e) { /* ignore */ }
                    return { translations, usedLang: 'en' };
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
            const pluginVersion = await getPluginVersion();

            let user = ApiClient.getCurrentUser ? ApiClient.getCurrentUser() : null;
            if (user instanceof Promise) {
                user = await user;
            }

            const userId = user?.Id;
            let lang = 'en';
            if (userId) {
                const storageKey = `${userId}-language`;
                const storedLang = localStorage.getItem(storageKey);
                if (storedLang) {
                    lang = normalizeLangCode(storedLang);
                }
            }

            cleanOldTranslationCache(pluginVersion);

            const langCodes = buildLanguageChain(lang);
            for (const code of langCodes) {
                try {
                    const result = await tryLoadSingleLanguage(code, pluginVersion);
                    if (result && result.translations) {
                        return result.translations;
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
