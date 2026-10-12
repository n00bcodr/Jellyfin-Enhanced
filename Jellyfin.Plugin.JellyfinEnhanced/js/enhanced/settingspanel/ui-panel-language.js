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
        const { resetAutoCloseTimer } = ctx;

        // --- Language Settings ---
        const displayLanguageSelect = document.getElementById('displayLanguageSelect');
        if (displayLanguageSelect) {
            // Get current user ID for localStorage key
            const userId = ApiClient.getCurrentUserId();
            const languageKey = `${userId}-language`;

            // Get saved language from localStorage as well
            const localStorageLang = localStorage.getItem(languageKey);
            const savedLanguage = JE.currentSettings.displayLanguage || localStorageLang || '';
            // The value shown for the language in use; a refused change goes back to it.
            let appliedLanguage = displayLanguageSelect.value;

            console.log('🪼 Jellyfin Enhanced: Current language setting:', {
                fromSettings: JE.currentSettings.displayLanguage,
                fromLocalStorage: localStorageLang,
                willUse: savedLanguage
            });

            // Populate language options from server-side locale enumeration
            (async () => {
                const CUSTOM_DISPLAY_NAMES = {
                    'pr': 'Pirate',
                    'en-GB': 'English (United Kingdom)',
                    'en-US': 'English (United States)',
                    'zh-CN': 'Chinese (Simplified)',
                    'zh-HK': 'Chinese (Hong Kong)',
                    'pt-BR': 'Portuguese (Brazil)'
                };

                try {
                    const [localeCodes, cultures] = await Promise.all([
                        ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/JellyfinEnhanced/locales'), dataType: 'json' }),
                        ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('/Localization/Cultures'), dataType: 'json' })
                    ]);

                    // Check GitHub for any new locale files added since the last plugin release (1 request)
                    try {
                        const ghResp = await fetch('https://api.github.com/repos/n00bcodr/Jellyfin-Enhanced/contents/Jellyfin.Plugin.JellyfinEnhanced/js/locales');
                        if (ghResp.ok) {
                            const files = await ghResp.json();
                            const serverSet = new Set(localeCodes.map(c => c.toLowerCase()));
                            files.forEach(f => {
                                if (f.name.endsWith('.json') && f.name !== 'en.json') {
                                    const code = f.name.replace('.json', '');
                                    if (!serverSet.has(code.toLowerCase())) {
                                        localeCodes.push(code);
                                    }
                                }
                            });
                        }
                    } catch (_) { /* GitHub unavailable, server list is sufficient */ }

                    const cultureMap = {};
                    cultures.forEach(c => {
                        cultureMap[c.TwoLetterISOLanguageName.toLowerCase()] = c;
                    });

                    const localeSet = new Set(localeCodes.map(c => c.toLowerCase()));
                    const options = localeCodes.map(code => {
                        let displayName = CUSTOM_DISPLAY_NAMES[code]
                            || cultureMap[code.toLowerCase()]?.DisplayName;
                        if (!displayName && code.includes('-')) {
                            const baseName = cultureMap[code.split('-')[0].toLowerCase()]?.DisplayName;
                            // Append region qualifier when the base code also exists to avoid duplicate labels
                            displayName = baseName && localeSet.has(code.split('-')[0].toLowerCase())
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
                        option.style.background = 'rgba(30,30,30,1)';
                        option.style.color = '#fff';
                        displayLanguageSelect.appendChild(option);
                    });
                } catch (err) {
                    console.warn('🪼 Jellyfin Enhanced: Failed to load language options:', err);
                }

                // Normalize saved language code with region support (e.g., zh-HK) when available
                let normalizedLanguage = '';
                if (savedLanguage) {
                    // Normalize the saved language to match dropdown format (e.g., en-GB, zh-HK)
                    const normalizedSaved = savedLanguage.includes('-')
                        ? `${savedLanguage.split('-')[0].toLowerCase()}-${savedLanguage.split('-')[1].toUpperCase()}`
                        : savedLanguage.toLowerCase();

                    const hasExactOption = Array.from(displayLanguageSelect.options)
                        .some(option => option.value.toLowerCase() === normalizedSaved.toLowerCase());
                    normalizedLanguage = hasExactOption ? normalizedSaved : normalizedSaved.split('-')[0];
                }

                // Set the saved language after options are added
                if (normalizedLanguage) {
                    displayLanguageSelect.value = normalizedLanguage;
                }
                appliedLanguage = displayLanguageSelect.value;
                console.log('🪼 Jellyfin Enhanced: Set language dropdown to:', savedLanguage || 'Auto', 'Normalized to:', normalizedLanguage, 'Select element value is now:', displayLanguageSelect.value);
            })();

            // Save language on change
            displayLanguageSelect.addEventListener('change', async (e) => {
                const newLang = e.target.value;

                const normalizeLangCode = (code) => {
                    if (!code) return code;
                    const parts = code.split('-');
                    if (parts.length === 1) return parts[0].toLowerCase();
                    if (parts.length === 2) return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
                    return code;
                };

                // Use the language code as-is, no special mapping
                const fullCultureCode = normalizeLangCode(newLang);

                // All dropdown options come from /JellyfinEnhanced/locales, so they are guaranteed valid
                const translationExists = true;

                // Save to settings.json (use base language code)
                const previousLang = JE.currentSettings.displayLanguage;
                JE.currentSettings.displayLanguage = newLang;
                // A failed request still switches this device (the language is also kept in
                // localStorage below), but says it was not saved instead of "Language changed".
                let saveFailed = false;
                // The server refused the pick because an administrator locks the language.
                let lockRefused = false;
                try {
                    await JE.saveUserSettings('settings.json', JE.currentSettings, { throwOnError: true, notifyOnError: true });
                } catch (err) {
                    // The stored settings did not load, so the save was refused: change nothing
                    // rather than switch the language here and report it as saved.
                    const status = JE.userConfig?.settingsStatus;
                    if (status === 'unavailable' || status === 'loading') {
                        JE.currentSettings.displayLanguage = previousLang;
                        displayLanguageSelect.value = appliedLanguage;
                        JE.toast(JE.settings.unavailableText('panel_settings_unavailable'));
                        return;
                    }
                    lockRefused = Array.isArray(err?.rejected) && err.rejected.some(r => r?.key === 'displayLanguage' && r.reason === 'locked');
                    // A refusal because of a lock that arrived meanwhile is handled below (config.js warns).
                    if (!lockRefused && JE.settings?.isLocked?.('displayLanguage') !== true) {
                        console.error('🪼 Jellyfin Enhanced: Failed to save settings.json:', err);
                    }
                    saveFailed = true;
                }

                // Locked while the change was saved: the server refused it and the lock already
                // put its language on this device (plugin.js). Keep that and the record of what the
                // lock replaced; storing the refused pick would bring it back after the unlock.
                if (JE.settings?.isLocked?.('displayLanguage') === true) {
                    const lockedLanguage = normalizeLangCode(JE.currentSettings.displayLanguage || '');
                    const shown = Array.from(displayLanguageSelect.options).find(option => option.value.toLowerCase() === lockedLanguage.toLowerCase());
                    displayLanguageSelect.value = shown ? shown.value : appliedLanguage;
                    return;
                }
                // Refused for a lock whose Meta the answer did not bring (a fresh document was taken
                // while it was in flight; the next focus check brings it): nothing changed, so keep
                // the language in use and do not store or seed the refused pick.
                if (lockRefused) {
                    if (JE.currentSettings.displayLanguage === newLang) JE.currentSettings.displayLanguage = previousLang;
                    displayLanguageSelect.value = appliedLanguage;
                    return;
                }

                // The menu is usable only while the language is unlocked, so a lock is over: drop
                // what it replaced, or the next load would put that back over this pick.
                try {
                    localStorage.removeItem(`JE_lockedLanguage_${userId}`);
                } catch (e) {
                    console.warn('🪼 Jellyfin Enhanced: Could not clear the display language lock record:', e);
                }

                // Save to localStorage (use the same code)
                if (fullCultureCode) {
                    localStorage.setItem(languageKey, fullCultureCode);
                } else {
                    // Set empty value instead of removing key
                    localStorage.setItem(languageKey, '');
                }
                // The language is the settings' one: a server default it follows later may replace it
                // (a language picked in jellyfin-web may not; see seedDisplayLanguage in plugin.js).
                try {
                    localStorage.setItem(`JE_seededLanguage_${userId}`, fullCultureCode || '');
                } catch (e) {
                    console.warn('🪼 Jellyfin Enhanced: Could not record the display language:', e);
                }

                if (saveFailed) {
                    // The "couldn't save" message is already up; leave time to read it.
                    setTimeout(() => window.location.reload(), 4000);
                    return;
                }
                if (newLang && !translationExists) {
                    JE.toast(`${JE.icon(JE.IconName.WARNING)} Translation file not available for selected language. Falling back to English.`);
                } else {
                    JE.toast(JE.t('toast_language_changed'));
                }
                setTimeout(() => window.location.reload(), 1500);
            });
        }

        // Clear translation cache button
        const clearTranslationCacheButton = document.getElementById('clearTranslationCacheButton');
        if (clearTranslationCacheButton) {
            clearTranslationCacheButton.addEventListener('click', () => {
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
                setTimeout(() => window.location.reload(), 2000);
                resetAutoCloseTimer();
            });
        }
    };

})(window.JellyfinEnhanced);
