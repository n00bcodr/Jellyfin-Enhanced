/**
 * @file Display-language selector (locale enumeration + persistence) and the
 * clear-translation-cache button in the settings panel.
 * Strict TypeScript replacement of the module split from ui.js (same markup, ids and behaviour).
 */
import { apiClient, panelHost, registry, type PanelBridge } from './host';
import type { PanelContext } from './context';
import { selectById } from '../shared/dom';
import { decodeCultures, decodeLocaleCodes, displayLanguageOptions, normalizeLangCode, normalizeSavedLanguage, type Culture } from './language-options';

type Deps = Pick<PanelBridge, 'internals' | 'currentSettings' | 'userConfig' | 'session' | 'saveUserSettings' | 'toast' | 't'>;

const CACHE_PREFIX = 'JE_translation_';
const CACHE_TIMESTAMP_PREFIX = 'JE_translation_ts_';

export function installUiPanelLanguage(JE: Deps): void {
    const internal = registry(JE);

    /**
     * Wires the language dropdown and translation-cache controls.
     * @param ctx Shared panel context assembled in ui-panel.ts.
     */
    internal.wireLanguageControls = function(ctx: Pick<PanelContext, 'resetAutoCloseTimer'> & Partial<Pick<PanelContext, 'onClose'>>) {
        const { resetAutoCloseTimer } = ctx;

        // --- Language Settings ---
        const candidateSelect = selectById('displayLanguageSelect');
        if (candidateSelect) {
            const displayLanguageSelect = candidateSelect;
            const client = apiClient();
            const userId = client.getCurrentUserId();
            const languageKey = `${userId}-language`;
            const origin = JE.userConfig;
            const settings = JE.currentSettings;
            const epoch = JE.session?.getEpoch();
            const serverRoot = client.getUrl('/');
            const token = client.accessToken?.();
            const serverId = () => typeof client.serverId === 'function' ? client.serverId() : client.serverId;
            const server = serverId();
            let closed = false;
            let reloadTimer: ReturnType<typeof setTimeout> | null = null;
            const sameDocument = () => apiClient() === client
                && client.getCurrentUserId() === userId && client.getUrl('/') === serverRoot
                && client.accessToken?.() === token && serverId() === server && JE.session?.getEpoch() === epoch
                && JE.userConfig === origin && JE.currentSettings === settings;
            const current = () => !closed && displayLanguageSelect.isConnected && sameDocument();
            const dispose = () => {
                closed = true;
                if (reloadTimer !== null) clearTimeout(reloadTimer);
                displayLanguageSelect.removeEventListener('change', saveLanguage);
            };
            ctx.onClose?.(dispose);
            const localStorageLang = localStorage.getItem(languageKey);
            const fromSettings = settings.displayLanguage;
            const savedLanguage = (typeof fromSettings === 'string' && fromSettings) || localStorageLang || '';
            let userChanged = false;
            let saving = false;
            let localeCodes: string[] = [];
            let cultures: Culture[] = [];
            const renderOptions = () => {
                if (!current()) return;
                const selected = userChanged ? displayLanguageSelect.value : savedLanguage;
                Array.from(displayLanguageSelect.options).forEach(option => { if (option.value) option.remove(); });
                displayLanguageOptions(localeCodes, cultures).forEach(({ code, displayName }) => {
                    const option = document.createElement('option');
                    option.value = code;
                    option.textContent = displayName;
                    option.style.background = 'rgba(30,30,30,1)';
                    option.style.color = '#fff';
                    displayLanguageSelect.appendChild(option);
                });
                const normalized = normalizeSavedLanguage(selected, Array.from(displayLanguageSelect.options, option => option.value));
                displayLanguageSelect.value = Array.from(displayLanguageSelect.options).find(option => option.value.toLowerCase() === normalized.toLowerCase())?.value ?? '';
            };
            // The choices are the plugin's embedded locales only (BUG-015: no runtime GitHub
            // listing). Each response enhances the selector independently: the culture-name
            // lookup must never hold the bundled language choices hostage.
            void client.ajax({ type: 'GET', url: client.getUrl('/JellyfinEnhanced/locales'), dataType: 'json' })
                .then(response => { if (current()) { localeCodes = decodeLocaleCodes(response); renderOptions(); } })
                .catch(err => { if (current()) console.warn('🪼 Jellyfin Enhanced: Failed to load language options:', err); });
            void client.ajax({ type: 'GET', url: client.getUrl('/Localization/Cultures'), dataType: 'json' })
                .then(response => { if (current()) { cultures = decodeCultures(response); renderOptions(); } })
                .catch(() => undefined);

            async function saveLanguage(): Promise<void> {
                if (!current() || saving) return;
                userChanged = true;
                saving = true;
                const newLang = displayLanguageSelect.value;
                const previous = settings.displayLanguage;
                const hadValue = Object.prototype.hasOwnProperty.call(settings, 'displayLanguage');
                displayLanguageSelect.disabled = true;
                settings.displayLanguage = newLang;
                const rollback = () => {
                    if (!sameDocument() || settings.displayLanguage !== newLang) return;
                    if (hadValue) settings.displayLanguage = previous;
                    else delete settings.displayLanguage;
                    displayLanguageSelect.value = typeof previous === 'string' ? previous : '';
                };
                try {
                    await JE.saveUserSettings('settings.json', settings, { throwOnError: true, isCurrent: sameDocument, notifyOnError: current, onError: rollback });
                    if (!sameDocument()) return;
                    // A user-requested write may finish after close; reconcile its saved
                    // preference, while toast/reload remain owned by the visible panel.
                    localStorage.setItem(languageKey, normalizeLangCode(newLang) || '');
                    if (!current()) return;
                    JE.toast(JE.t('toast_language_changed'));
                    reloadTimer = setTimeout(() => { if (current()) window.location.reload(); }, 1500);
                } catch (_) {
                    rollback();
                    // The settings writer reports the failure; no success or reload follows.
                } finally {
                    saving = false;
                    if (current()) displayLanguageSelect.disabled = false;
                }
            }
            displayLanguageSelect.addEventListener('change', saveLanguage);

        }

        // Clear translation cache button
        const clearTranslationCacheButton = document.getElementById('clearTranslationCacheButton');
        if (clearTranslationCacheButton) {
            clearTranslationCacheButton.addEventListener('click', () => {
                const cacheKeys: string[] = [];
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
}

installUiPanelLanguage(panelHost());
