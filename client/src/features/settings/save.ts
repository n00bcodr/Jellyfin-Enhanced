import type { SettingsSaveReceipt } from '../../contracts/generated';
import { bootstrapSchema } from '../../contracts/schema';
import { validateSchema } from '../../contracts/validate';
function isReceipt(value: unknown): value is SettingsSaveReceipt {
    return validateSchema(value, bootstrapSchema.$defs.SettingsSaveReceipt, bootstrapSchema.$defs);
}
import type { SettingsBridge, SettingsClient, SettingsContext, SettingsDocument } from './host';
import { withInheritance } from './inheritance';
export function installSave(JE: SettingsBridge, getClient: () => SettingsClient | undefined, ctx: SettingsContext): void {
const _lastSavedJson: Record<string, string | null | undefined> = {};
const acknowledgedSettings = new WeakMap<SettingsDocument, { json: string | null; revision: string; identity: string; origin: SettingsBridge['userConfig'] }>();
const _saveChain: Record<string, Promise<void>> = {};
let epoch = 0;
const loaded = new WeakMap<object, { identity: string; origin: SettingsBridge['userConfig'] }>();
const identityOf = () => {
    const client = getClient();
    return `${client?.getUrl('/')}|${client?.getCurrentUserId()}|${client?.accessToken?.() || ''}|${typeof client?.serverId === 'function' ? client.serverId() : client?.serverId}|${epoch}`;
};
const load = JE.loadSettings;
JE.loadSettings = () => {
    const settings = load();
    const binding = { identity: identityOf(), origin: JE.userConfig };
    loaded.set(settings, binding);
    for (const doc of [JE.userConfig?.shortcuts, JE.userConfig?.bookmark, JE.userConfig?.elsewhere, JE.userConfig?.hiddenContent]) {
        if (doc) loaded.set(doc, binding);
    }
    return settings;
};
if (typeof document !== 'undefined') document.addEventListener('je:user-changed', () => { epoch++; });
    const saveUserSettings: SettingsBridge['saveUserSettings'] = async (fileName, settings, options = {}) => {
        const isCurrentSettings = settings === JE.currentSettings;
        const throwOnError = options?.throwOnError === true;
        let failureCurrent = () => !options.isCurrent || options.isCurrent();
        /** Finish failure handling before releasing this document's save queue. */
        const handleError = async (e: unknown) => {
            if (!failureCurrent()) {
                if (throwOnError) throw e;
                return;
            }
            await options.onError?.(e);
            if (fileName === 'settings.json' && failureCurrent() && (!options.notifyOnError || options.notifyOnError())) JE.toast?.('Settings could not be saved. They may have changed in another tab or on the server. Reload before trying again.');
            if (throwOnError) throw e;
            console.error(`🪼 Jellyfin Enhanced: Failed to save ${fileName}:`, e);
        };
        try {
            const ApiClient = getClient();
            if (!ApiClient) {
                throw new Error('ApiClient not available');
            }
            const userId = ApiClient.getCurrentUserId();
            if (!userId) {
                throw new Error('User ID not available');
            }

            const identity = identityOf();
            const origin = JE.userConfig;
            const binding = loaded.get(settings);
            if (binding && (binding.identity !== identity || binding.origin !== origin)) return;
            const current = () => getClient() === ApiClient && identity === identityOf() && origin === JE.userConfig && (!options.isCurrent || options.isCurrent());
            failureCurrent = current;
            /** Build a document only after earlier saves and rollbacks have finished. */
            const serialize = () => {
                // Capture browser date context at this save's turn, after queued changes/rollbacks.
                let source = settings;
                const getStatusDateContext = fileName === 'settings.json' && isCurrentSettings && settings.statusTagsEnabled
                    ? ctx.peer('getStatusDateContext') : undefined;
                if (typeof getStatusDateContext === 'function') {
                    const context = getStatusDateContext();
                    source = { ...settings, nativePosterDateLocale: context.locale, nativePosterTimeZone: context.timeZone };
                }
                // Convert data back to PascalCase for server C# deserialization
                let dataToSave = source;
                // currentSettings carries the resolved native-poster value (on). Leave it
                // unset on disk until the user explicitly switches it in the panel.
                if (fileName === 'settings.json' && isCurrentSettings
                    && JE.userConfig?.settings?.useNativePosterTags == null) {
                    dataToSave = { ...source, useNativePosterTags: null };
                }
                if (fileName === 'settings.json') dataToSave = withInheritance(settings, dataToSave);
                if ((fileName === 'bookmark.json' || fileName === 'settings.json') && typeof JE.toPascalCase === 'function') {
                    dataToSave = JE.toPascalCase(dataToSave);
                }
                return JSON.stringify(dataToSave);
            };
            const snapshot = fileName === 'settings.json' ? null : serialize();
            const cacheKey = `${identity}:${fileName}`;

            const post = async () => {
                if (!current()) return;
                options.beforeSave?.();
                if (!current()) return;
                const serialized = fileName === 'settings.json' ? serialize() : snapshot;
                const revision = origin?.settingsRevision;
                if (fileName === 'settings.json') {
                    if (!revision) throw new Error('Settings were not loaded with a revision. Reload before saving.');
                    // Acknowledgement belongs to this loaded document and revision.
                    // An authoritative refresh invalidates content-only deduplication.
                    const saved = acknowledgedSettings.get(settings);
                    if (saved && saved.json === serialized && saved.revision === revision
                        && saved.identity === identity && saved.origin === origin) return;
                } else if (_lastSavedJson[cacheKey] === serialized) return;
                const response = await ApiClient.ajax({
                    type: 'POST',
                    url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/${fileName === 'settings.json' ? 'settings-document' : fileName}`),
                    data: fileName === 'settings.json' ? JSON.stringify({ Revision: revision, Settings: JSON.parse(serialized || '{}') }) : serialized || '{}',
                    ...(fileName === 'settings.json' ? { dataType: 'json' } : {}),
                    contentType: 'application/json'
                });

                if (!current()) return;
                if (fileName === 'settings.json') {
                    if (!isReceipt(response) || !response.Revision)
                        throw new Error('Invalid settings save response. Reload before saving again.');
                    if (origin) origin.settingsRevision = response.Revision;
                    acknowledgedSettings.set(settings, { json: serialized, revision: response.Revision, identity, origin });
                } else {
                    _lastSavedJson[cacheKey] = serialized;
                }
            };
            const save = (_saveChain[cacheKey] || Promise.resolve()).then(post).catch(e => {
                if (current()) return handleError(e);
                // A stale failure must not run callbacks for the incoming account,
                // but callers opting into errors still need the actual write outcome.
                if (throwOnError) throw e;
            });
            _saveChain[cacheKey] = save.catch(() => {});
            return save;
        } catch (e) {
            return handleError(e);
        }
    };

    // Refresh cannot replace a document while any save from it is queued or in flight.
    // Per-object state keeps an old account's hung write from blocking a new document.
    const saveStates = new WeakMap<SettingsDocument, { version: number; pending: number }>();
    JE.getSettingsSaveState = () => {
        const state = JE.currentSettings && saveStates.get(JE.currentSettings);
        return state ? { ...state } : { version: 0, pending: 0 };
    };
    JE.saveUserSettings = async (fileName, settings, options) => {
        if (fileName !== 'settings.json') return saveUserSettings(fileName, settings, options);
        let state = saveStates.get(settings);
        if (!state) { state = { version: 0, pending: 0 }; saveStates.set(settings, state); }
        state.version++;
        state.pending++;
        try { await saveUserSettings(fileName, settings, options); }
        finally { state.pending--; }
    };
}
