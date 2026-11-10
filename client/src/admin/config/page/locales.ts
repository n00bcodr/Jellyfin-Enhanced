import type { PageModules } from './modules';
import { asObjects, stringList, text } from '../domain/config';
import type { JsonObject } from '../domain/config';
import { asHtml } from './dom';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type LocalesDeps = Pick<PageModules, 'context'>;

export function createLocales(m: LocalesDeps) {
    const { ApiClient } = m.context;

        // Jellyfin's culture list feeds both the UI language and the sound-tag audio language dropdowns.
        const culturesPromise = ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/Localization/Cultures'), dataType: 'json' });

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
        // Populate language options dynamically
        (async () => {
            const defaultLanguageSelect = document.getElementById('DefaultLanguage');
            if (!defaultLanguageSelect) return;

            const CUSTOM_DISPLAY_NAMES: Readonly<Record<string, string>> = {
                'pr': 'Pirate',
                'en-GB': 'English (United Kingdom)',
                'en-US': 'English (United States)',
                'zh-CN': 'Chinese (Simplified)',
                'zh-HK': 'Chinese (Hong Kong)',
                'pt-BR': 'Portuguese (Brazil)'
            };

            try {
                const [localeList, cultures] = await Promise.all([
                    ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/JellyfinEnhanced/locales'), dataType: 'json' }),
                    culturesPromise
                ]);
                // The choices are the plugin's embedded locales only (BUG-014): the list never
                // waits on, or asks, a third-party host.
                const localeCodes = stringList(localeList);

                const cultureMap: Record<string, JsonObject> = {};
                asObjects(cultures).forEach(c => {
                    cultureMap[text(c.TwoLetterISOLanguageName).toLowerCase()] = c;
                });

                const localeSet = new Set(localeCodes.map(c => c.toLowerCase()));
                const options = localeCodes.map(code => {
                    let displayName = CUSTOM_DISPLAY_NAMES[code]
                        || text(cultureMap[code.toLowerCase()]?.DisplayName);
                    if (!displayName && code.includes('-')) {
                        const baseCode = (code.split('-')[0] ?? '').toLowerCase();
                        const baseName = text(cultureMap[baseCode]?.DisplayName);
                        displayName = baseName && localeSet.has(baseCode)
                            ? `${baseName} (${code.split('-')[1]})`
                            : baseName;
                    }
                    return { code, displayName: displayName || code };
                });

                options.sort((a, b) => a.displayName.localeCompare(b.displayName));
                options.forEach(({ code, displayName }) => {
                    const option = document.createElement('option');
                    option.value = code;
                    option.textContent = displayName;
                    defaultLanguageSelect.appendChild(option);
                });
            } catch (err) {
                console.warn('Jellyfin Enhanced: Failed to load language options:', err);
            }
        })();
    }

    return {
        wire,

    };
}
