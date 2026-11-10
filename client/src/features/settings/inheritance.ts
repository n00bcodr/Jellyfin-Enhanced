import type { SettingsBridge, SettingsDocument } from './host';
    export const INHERITED_KEYS = [
        'showEditionTag', 'editionTagOrder', 'showLowQualitySourceTag',
        'resolutionTagOrder', 'sourceTagOrder', 'dynamicRangeTagOrder', 'specialFormatTagOrder',
        'videoCodecTagOrder', 'audioInfoTagOrder', 'seriesQualityAggregation',
        'showRuntimeTag', 'showAspectRatioTag', 'showFrameRateTag', 'showVersionsTag',
        'runtimeTagOrder', 'aspectRatioTagOrder', 'frameRateTagOrder', 'versionsTagOrder',
        'qualityAudioDisplayMode', 'qualityVideoCodecDisplayMode', 'qualityHdrDisplayMode', 'qualityMinimumResolution', 'qualityHideSdr'
    ];
    // Per loaded settings object: the value each INHERITED_KEYS field shows when
    // it is not set, and which fields follow the administrator. Following is a
    // state, not a value comparison: a field unset at load follows until the user
    // changes it in any way (even to the administrator's own value), and only an
    // explicit "server default" action (setSettingInherited(..., true)) makes it
    // follow again. A following field is saved as null, so a save never pins
    // today's administrator default.
    export const inheritance = new WeakMap<SettingsDocument, { defaults: SettingsDocument; inherited: Set<string> }>();
export function installInheritance(JE: SettingsBridge): void {
    /** The fields that follow the administrator while unset (read-only). */
    JE.inheritedSettingKeys = Object.freeze(INHERITED_KEYS.slice());

    /**
     * Whether a field of a loaded settings object follows the administrator
     * (saved as null) rather than holding the user's own choice. A value
     * written without setSettingInherited (any other value than the default)
     * counts as the user's.
     * @param {object} settings A document from loadSettings (JE.currentSettings).
     * @param {string} key camelCase settings key.
     * @returns {boolean}
     */
    JE.isSettingInherited = (settings: SettingsDocument, key: string) => {
        const state = inheritance.get(settings);
        return !!state && state.inherited.has(key) && settings[key] === state.defaults[key];
    };

    /**
     * Make a field follow the administrator again (shown resolved, saved as
     * null) or mark it as the user's own choice (saved as it is, even when it
     * equals the default). Every control that changes one of these fields
     * marks it as the user's before saving; only a "server default" or reset
     * action passes true.
     * @param {object} settings A document from loadSettings (JE.currentSettings).
     * @param {string} key camelCase settings key.
     * @param {boolean} inherit
     * @returns {boolean} Whether the field is one loadSettings resolves (false: the caller stores null itself).
     */
    JE.setSettingInherited = (settings: SettingsDocument, key: string, inherit: boolean) => {
        const state = inheritance.get(settings);
        if (!state || !INHERITED_KEYS.includes(key)) return false;
        if (inherit) {
            state.inherited.add(key);
            settings[key] = state.defaults[key];
        } else {
            state.inherited.delete(key);
        }
        return true;
    };

    /**
     * The administrator's value a field shows while it follows the
     * administrator (what "server default" means for it).
     * @param {object} settings A document from loadSettings (JE.currentSettings).
     * @param {string} key camelCase settings key.
     * @returns {*} undefined for a field loadSettings does not resolve.
     */
    JE.inheritedSettingDefault = (settings: SettingsDocument, key: string) => inheritance.get(settings)?.defaults[key];

    /**
     * The document as saved: fields that follow the administrator go back to
     * null. One that a caller changed without marking it (it no longer shows
     * the default) has become the user's and stays so.
     * @param {object} settings
     * @param {object} source The object being serialized (settings or a copy of it).
     * @returns {object}
     */
}
    export const withInheritance = (settings: SettingsDocument, source: SettingsDocument) => {
        const state = inheritance.get(settings);
        if (!state) return source;
        let out = source;
        for (const key of [...state.inherited]) {
            if (settings[key] !== state.defaults[key]) {
                state.inherited.delete(key);
                continue;
            }
            if (out === source) out = { ...source };
            out[key] = null;
        }
        return out;
    };

