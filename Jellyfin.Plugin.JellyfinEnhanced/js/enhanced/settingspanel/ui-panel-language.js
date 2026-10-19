/**
 * @file Display-language selector (locale enumeration + persistence) and the
 * clear-translation-cache button in the settings panel.
 * Split from ui.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    /**
     * Wires the language dropdown and translation-cache controls.
     * @param {object} ctx Shared panel context assembled in ui-panel.js.
     */
    internal.wireLanguageControls = function(ctx) {
        const scope = JE.internals.settingsPanelScope(ctx);
        const { listen } = scope;
        const { resetAutoCloseTimer } = ctx;

        // --- Language Settings ---
        const displayLanguageSelect = document.getElementById('displayLanguageSelect');
        if (displayLanguageSelect) {
            const CUSTOM_DISPLAY_NAMES = {
                'pr': 'Pirate',
                'en-GB': 'English (United Kingdom)',
                'en-US': 'English (United States)',
                'zh-CN': 'Chinese (Simplified)',
                'zh-HK': 'Chinese (Hong Kong)',
                'pt-BR': 'Portuguese (Brazil)'
            };
            // Jellyfin's cultures by two-letter code, and the locale codes listed (filled by the enumeration below).
            const cultureMap = {};
            const localeSet = new Set();
            const labelFor = code => {
                let displayName = CUSTOM_DISPLAY_NAMES[code] || cultureMap[code.toLowerCase()]?.DisplayName;
                if (!displayName && code.includes('-')) {
                    const baseName = cultureMap[code.split('-')[0].toLowerCase()]?.DisplayName;
                    // Append region qualifier when the base code also exists to avoid duplicate labels
                    displayName = baseName && localeSet.has(code.split('-')[0].toLowerCase())
                        ? `${baseName} (${code.split('-')[1]})`
                        : baseName;
                }
                return displayName || code;
            };

            // The stored display language, exactly: the server's canonical tag (en-AU, de-Latn-CH), never truncated to a
            // base language. A tag without an option of its own gets one, labelled by the bundle the policy resolves it to
            // ("English (en-AU)"). Runs once the languages are listed and on every update of the settings store (a save of
            // another setting, a read), so the select never ends up showing nothing or another language.
            const renderStoredLanguage = () => {
                const select = document.getElementById('displayLanguageSelect');
                if (!select) return;
                const stored = typeof JE.supportedLanguageCode === 'function' ? JE.supportedLanguageCode(JE.currentSettings?.displayLanguage) : '';
                if (stored && ![...select.options].some(option => option.value === stored)) {
                    const bundle = JE.languageBundle?.(stored) || '';
                    const option = document.createElement('option');
                    option.value = stored;
                    option.dataset.jeStoredLanguage = 'true';
                    option.textContent = bundle && bundle !== stored ? `${labelFor(bundle)} (${stored})` : labelFor(stored);
                    option.style.background = 'rgba(30,30,30,1)';
                    option.style.color = '#fff';
                    const after = [...select.options].find(o => o.value && o.textContent.localeCompare(option.textContent) > 0);
                    select.insertBefore(option, after || null);
                }
                select.value = stored;
            };

            // Populate language options from server-side locale enumeration
            (async () => {
                try {
                    const [localeCodes, cultures] = await Promise.all([
                        ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/JellyfinEnhanced/locales'), dataType: 'json' }),
                        ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/Localization/Cultures'), dataType: 'json' })
                    ]);

                    if (!scope.isCurrent()) return;

                    // Check GitHub for any new locale files added since the last plugin release (1 request)
                    try {
                        const ghResp = await fetch('https://api.github.com/repos/n00bcodr/Jellyfin-Enhanced/contents/Jellyfin.Plugin.JellyfinEnhanced/js/locales');
                        if (ghResp.ok) {
                            const files = await ghResp.json();
                            const serverSet = new Set(localeCodes.map(c => c.toLowerCase()));
                            files.forEach(f => {
                                if (f.name.endsWith('.json') && f.name !== 'en.json') {
                                    const code = f.name.replace('.json', '');
                                    // Only a language the shared policy accepts (a shipped bundle, exactly or by base
                                    // language): anything else would be saved as Auto.
                                    const accepted = typeof JE.supportedLanguageCode === 'function' && JE.supportedLanguageCode(code) !== '';
                                    if (accepted && !serverSet.has(code.toLowerCase())) {
                                        localeCodes.push(code);
                                    }
                                }
                            });
                        }
                    } catch (_) { /* GitHub unavailable, server list is sufficient */ }

                    if (!scope.isCurrent()) return;
                    cultures.forEach(c => {
                        cultureMap[c.TwoLetterISOLanguageName.toLowerCase()] = c;
                    });
                    localeCodes.forEach(code => localeSet.add(code.toLowerCase()));

                    const options = localeCodes.map(code => ({
                        // Each option's value in the canonical case the server stores (a select shows a stored tag exactly).
                        code: (typeof JE.languageCode === 'function' && JE.languageCode(code)) || code,
                        displayName: labelFor(code)
                    }));

                    options.sort((a, b) => a.displayName.localeCompare(b.displayName));
                    // An option added for the stored tag before the list arrived is added again, labelled from the list.
                    displayLanguageSelect.querySelectorAll('option[data-je-stored-language]').forEach(option => option.remove());
                    options.forEach(({ code, displayName }) => {
                        if ([...displayLanguageSelect.options].some(option => option.value === code)) return;
                        const option = document.createElement('option');
                        option.value = code;
                        option.textContent = displayName;
                        option.style.background = 'rgba(30,30,30,1)';
                        option.style.color = '#fff';
                        displayLanguageSelect.appendChild(option);
                    });
                } catch (err) {
                    console.warn('🪼 Jellyfin Enhanced: Failed to load language options:', err);
                }

                if (!scope.isCurrent()) return;
                renderStoredLanguage();
            })();
            JE.internals.observeSettingsDocument('panel-language', renderStoredLanguage);

            // Save language on change
            listen(displayLanguageSelect, 'change', async (e) => {
                const newLang = e.target.value;

                // The store mirrors the persisted document (what the server stored) and schedules its session-owned reload.
                // Only a tag of a shipped bundle is saved, in canonical case; anything else ("undefined", "null", a malformed
                // value, a language JE ships no bundle for) is Auto (''), never written to the shared language key.
                const languageTag = typeof JE.supportedLanguageCode === 'function' ? JE.supportedLanguageCode(newLang) : '';
                try {
                    await JE.updateSettings({ displayLanguage: languageTag }, { throwOnError: true });
                } catch (err) {
                    if (scope.session.isCurrent()) console.warn('🪼 Jellyfin Enhanced: language settings save failed', err);
                    return;
                }
            });
        }

        // Clear translation cache button
        const clearTranslationCacheButton = document.getElementById('clearTranslationCacheButton');
        if (clearTranslationCacheButton) {
            listen(clearTranslationCacheButton, 'click', () => {
                const cacheKeys = [];
                const CACHE_PREFIX = 'JE_translation_';
                const CACHE_TIMESTAMP_PREFIX = 'JE_translation_ts_';

                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (key && (key.startsWith(CACHE_PREFIX) || key.startsWith(CACHE_TIMESTAMP_PREFIX))) {
                        cacheKeys.push(key);
                    }
                }

                cacheKeys.forEach(key => localStorage.removeItem(key));

                JE.toast(JE.t('toast_translation_cache_cleared', { count: cacheKeys.length }));
                JE.internals.scheduleReloadWhenIdle(scope.session, 2000);
                resetAutoCloseTimer();
            });
        }
    };

})(window.JellyfinEnhanced);
