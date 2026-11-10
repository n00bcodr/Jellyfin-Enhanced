/** Jellyfin culture fields the language pickers read (from /Localization/Cultures). */
export interface Culture { twoLetter: string; threeLetter: string; displayName: string; name: string }

const text = (record: object, key: string): string => {
    const value: unknown = Reflect.get(record, key);
    return typeof value === 'string' ? value : '';
};

/** Decode an untrusted cultures response; entries that are not objects are dropped. */
export function decodeCultures(value: unknown): Culture[] {
    if (!Array.isArray(value)) throw new TypeError('Cultures response is not a list');
    return value.filter((entry): entry is object => entry !== null && typeof entry === 'object').map((entry) => ({
        twoLetter: text(entry, 'TwoLetterISOLanguageName'),
        threeLetter: text(entry, 'ThreeLetterISOLanguageName'),
        displayName: text(entry, 'DisplayName'),
        name: text(entry, 'Name'),
    }));
}

/** Decode the plugin's locale list (/JellyfinEnhanced/locales): string codes only. */
export function decodeLocaleCodes(value: unknown): string[] {
    if (!Array.isArray(value)) throw new TypeError('Locale response is not a list');
    return value.filter((code): code is string => typeof code === 'string');
}

export const CUSTOM_DISPLAY_NAMES: Readonly<Record<string, string>> = {
    'pr': 'Pirate',
    'en-GB': 'English (United Kingdom)',
    'en-US': 'English (United States)',
    'zh-CN': 'Chinese (Simplified)',
    'zh-HK': 'Chinese (Hong Kong)',
    'pt-BR': 'Portuguese (Brazil)'
};

/**
 * Display-language options: custom names, then the culture's display name,
 * then the base culture with a region qualifier when the base code also
 * exists (to avoid duplicate labels); sorted by name.
 */
export function displayLanguageOptions(localeCodes: string[], cultures: Culture[]): Array<{ code: string; displayName: string }> {
    const cultureMap = new Map<string, Culture>();
    for (const c of cultures) cultureMap.set(c.twoLetter.toLowerCase(), c);
    const localeSet = new Set(localeCodes.map(c => c.toLowerCase()));
    const options = localeCodes.map(code => {
        let displayName = (Object.prototype.hasOwnProperty.call(CUSTOM_DISPLAY_NAMES, code) ? CUSTOM_DISPLAY_NAMES[code] : undefined)
            || cultureMap.get(code.toLowerCase())?.displayName;
        if (!displayName && code.includes('-')) {
            const [base = '', region = ''] = code.split('-');
            const baseName = cultureMap.get(base.toLowerCase())?.displayName;
            displayName = baseName && localeSet.has(base.toLowerCase()) ? `${baseName} (${region})` : baseName;
        }
        return { code, displayName: displayName || code };
    });
    options.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return options;
}

/** Match a saved language to the dropdown's format (en-GB, zh-HK), falling back to its base code. */
export function normalizeSavedLanguage(saved: string, optionValues: string[]): string {
    if (!saved) return '';
    const [base = '', region = ''] = saved.split('-');
    const normalized = saved.includes('-') ? `${base.toLowerCase()}-${region.toUpperCase()}` : saved.toLowerCase();
    const exact = optionValues.some(value => value.toLowerCase() === normalized.toLowerCase());
    return exact ? normalized : normalized.split('-')[0] ?? '';
}

/** Canonical culture code casing (xx or xx-YY); other shapes are returned unchanged. */
export function normalizeLangCode(code: string): string {
    if (!code) return code;
    const parts = code.split('-');
    if (parts.length === 1) return (parts[0] ?? '').toLowerCase();
    if (parts.length === 2) return `${(parts[0] ?? '').toLowerCase()}-${(parts[1] ?? '').toUpperCase()}`;
    return code;
}

/** Audio-language choices for the quality sound tag: one per code, sorted by name. */
export function audioLanguageOptions(cultures: Culture[]): Array<{ code: string; name: string }> {
    const seen = new Set<string>();
    return cultures
        .map(c => ({ code: c.twoLetter || c.threeLetter, name: c.displayName || c.name }))
        .filter(o => o.code && o.name && !seen.has(o.code) && seen.add(o.code))
        .sort((a, b) => a.name.localeCompare(b.name));
}
