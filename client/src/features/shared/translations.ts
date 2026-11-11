import { decodeTranslations, type LocaleResult } from './locale-domain';
import type { TranslationsBridge, SharedClient } from './host';
export function createTranslations(JE: TranslationsBridge, api: () => SharedClient) {


    // The fallback route for a locale is the plugin's local CDN route (JE.cdn source
    // 'locales'), which serves only the plugin's embedded locale files (canopy #7); the
    // client never contacts a third-party host for translations.
    const remoteLocaleUrl = (code: string) => JE.cdn.url('locales', `${code}.json`);
    function storageGet(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
    // Firefox with no configured locale reports navigator.language "undefined", which jellyfin-web copies to <html lang>.
    const isLanguageTag = (code: string | null): code is string => !!code && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(code);
    const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

    function normalizeLangCode(code: string) {
        if (!code) return code;
        const parts = code.split('-');
        if (parts.length === 1) return (parts[0] || '').toLowerCase();
        if (parts.length === 2) return `${(parts[0] || '').toLowerCase()}-${(parts[1] || '').toUpperCase()}`;
        return code;
    }

    function buildLanguageChain(primaryLang: string) {
        const normalizedLang = normalizeLangCode(primaryLang);
        const langCodes: string[] = [];

        if (normalizedLang) {
            langCodes.push(normalizedLang);
        }

        if (normalizedLang && normalizedLang.includes('-')) {
            const baseLang = normalizedLang.split('-')[0] || 'en';
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
            const versionResponse = await fetch(api().getUrl('/JellyfinEnhanced/version'));
            if (versionResponse.ok) {
                pluginVersion = await versionResponse.text();
                
                return pluginVersion;
            }
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Failed to fetch plugin version', e);
        }

        return 'unknown';
    }

    function cleanOldTranslationCache(pluginVersion: string) {
        try {
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const key = localStorage.key(i);
                if (key && (key.startsWith('JE_translation_') || key.startsWith('JE_translation_ts_'))) {
                    if (!key.endsWith(`_${pluginVersion}`)) {
                        localStorage.removeItem(key);
                        console.log(`🪼 Jellyfin Enhanced: Removed old translation cache: ${key}`);
                    }
                }
            }
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Failed to clean up old translation caches', e);
        }
    }

    async function tryLoadSingleLanguage(code: string, pluginVersion: string): Promise<LocaleResult> {
        const cacheKey = `JE_translation_${code}_${pluginVersion}`;
        const timestampKey = `JE_translation_ts_${code}_${pluginVersion}`;
        const cachedTranslations = storageGet(cacheKey);
        const cachedTimestamp = storageGet(timestampKey);

        if (cachedTranslations && cachedTimestamp) {
            const age = Date.now() - parseInt(cachedTimestamp, 10);
            if (age >= 0 && age < CACHE_DURATION) {
                console.log(`🪼 Jellyfin Enhanced: Using cached translations for ${code} (age: ${Math.round(age / 1000 / 60)} minutes, version: ${pluginVersion})`);
                try {
                    return { translations: decodeTranslations(JSON.parse(cachedTranslations)), usedLang: code };
                } catch (e) {
                    console.warn('🪼 Jellyfin Enhanced: Failed to parse cached translations, will fetch fresh', e);
                }
            }
        }

        console.log(`🪼 Jellyfin Enhanced: Loading bundled translations for ${code}...`);
        try {
            const bundledResponse = await fetch(api().getUrl(`/JellyfinEnhanced/locales/${code}.json`));
            if (bundledResponse.ok) {
                const translations = decodeTranslations(await bundledResponse.json());
                try {
                    localStorage.setItem(cacheKey, JSON.stringify(translations));
                    localStorage.setItem(timestampKey, Date.now().toString());
                    console.log(`🪼 Jellyfin Enhanced: Successfully loaded and cached bundled translations for ${code} (version: ${pluginVersion})`);
                } catch (e) { /* ignore */ }
                return { translations, usedLang: code };
            }
        } catch (bundledError) {
            console.warn('🪼 Jellyfin Enhanced: Bundled translations failed, falling back to GitHub:', bundledError);
        }

        try {
            console.log(`🪼 Jellyfin Enhanced: Fetching translations for ${code} from GitHub...`);
            const githubResponse = await fetch(remoteLocaleUrl(code), {
                method: 'GET',
                cache: 'no-cache',
                headers: { 'Accept': 'application/json' }
            });

            if (githubResponse.ok) {
                const translations = decodeTranslations(await githubResponse.json());
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
                const englishResponse = await fetch(remoteLocaleUrl('en'), {
                    method: 'GET',
                    cache: 'no-cache',
                    headers: { 'Accept': 'application/json' }
                });

                if (englishResponse.ok) {
                    const translations = decodeTranslations(await englishResponse.json());
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
            console.warn('🪼 Jellyfin Enhanced: GitHub fetch failed, falling back to bundled translations:', githubError);
        }

        console.log(`🪼 Jellyfin Enhanced: Loading bundled translations for ${code}...`);
        let response = await fetch(api().getUrl(`/JellyfinEnhanced/locales/${code}.json`));

        if (response.ok) {
            const translations = decodeTranslations(await response.json());
            try {
                localStorage.setItem(cacheKey, JSON.stringify(translations));
                localStorage.setItem(timestampKey, Date.now().toString());
            } catch (e) { /* ignore */ }
            return { translations, usedLang: code };
        }

        console.warn(`🪼 Jellyfin Enhanced: Bundled ${code} not found, falling back to bundled English`);
        response = await fetch(api().getUrl('/JellyfinEnhanced/locales/en.json'));
        if (response.ok) {
            return { translations: decodeTranslations(await response.json()), usedLang: 'en' };
        }

        throw new Error('Failed to load English fallback translations');
    }

    /**
     * Fill the gaps of a non-English locale with the bundled English strings.
     * Weblate adds new keys to the other locales (en-GB included) only after a
     * release, so without this a key added in the same release shows up raw.
     * The locale's own strings always win; only missing keys come from English.
     * @param {{translations: Object, usedLang: string}} result - A loaded locale.
     * @param {string} pluginVersion - Cache key component.
     * @returns {Promise<Object>} The merged translations.
     */
    async function withEnglishFallback(result: LocaleResult, pluginVersion: string) {
        // JE.t picks plural forms by the language a string is written in (see plugin.js).
        let fromEnglish: Set<string> | null = null;
        if (result.usedLang === 'en') return {translations: result.translations, usedLang: result.usedLang, fromEnglish};
        try {
            const english = await tryLoadSingleLanguage('en', pluginVersion);
            if (english && english.translations) {
                fromEnglish = new Set(Object.keys(english.translations).filter((key) => !Object.prototype.hasOwnProperty.call(result.translations, key)));
                return {translations: {...english.translations, ...result.translations}, usedLang: result.usedLang, fromEnglish};
            }
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: English fallback strings unavailable', e);
        }
        return {translations: result.translations, usedLang: result.usedLang, fromEnglish};
    }

    const load = async function() {
        try {
            const pluginVersion = await getPluginVersion();

            const user = await api().getCurrentUser?.();

            const userId = user && typeof user === 'object' && 'Id' in user && typeof user.Id === 'string' ? user.Id : null;
            let lang = 'en';
            if (userId) {
                const storageKey = `${userId}-language`;
                const storedLang = storageGet(storageKey);
                if (isLanguageTag(storedLang)) {
                    lang = normalizeLangCode(storedLang);
                } else {
                    // Fall back to the HTML lang attribute set by Jellyfin's web client.
                    // This covers the Android app and other clients where the localStorage
                    // key may not exist but Jellyfin has already resolved the user's
                    // preferred language from server-side settings.
                    const docLang = document.documentElement.lang;
                    if (isLanguageTag(docLang)) {
                        lang = normalizeLangCode(docLang);
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
            return {translations: {}, usedLang: 'en', fromEnglish: null};
        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: Failed to load translations:', error);
            return {translations: {}, usedLang: 'en', fromEnglish: null};
        }
    };

let sequence = 0;
let latest: Promise<Record<string, string>> | undefined;
function identity(): string {
 const host = api();
 return JSON.stringify([host.getCurrentUserId(), typeof host.serverId === 'function' ? host.serverId() : host.serverId, host.accessToken?.(), document.documentElement.lang]);
}
function loadTranslations(): Promise<Record<string, string>> {
 const serial = ++sequence;
 const captured = identity();
 JE.session?.checkNow?.('shared-translations');
 const lease = JE.session?.createLease?.();
 // Capture all language preferences since getCurrentUser may be asynchronous and
 // its Id can differ from the host's synchronous identity during initialization.
 const preferences = languagePreferences();
 const pending = load().then(result => {
  if (serial !== sequence && latest) return latest;
  if (captured !== identity() || preferences !== languagePreferences() || (lease && !lease.isCurrent())) return loadTranslations();
  JE.translationsLang = result.usedLang;
  JE.translationsFromEnglish = result.fromEnglish;
  return result.translations;
 });
 latest = pending;
 return pending;
}
function languagePreferences(): string {
 try {
  const values: [string,string | null][] = [];
  for (let i = 0; i < localStorage.length; i++) {
   const key = localStorage.key(i);
   if (key?.endsWith('-language')) values.push([key, storageGet(key)]);
  }
  return JSON.stringify(values.sort(([a],[b]) => a.localeCompare(b)));
 } catch { return ''; }
}
return loadTranslations;
}
