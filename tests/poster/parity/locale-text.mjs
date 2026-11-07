// A web string as JE.t resolves it for a locale (js/plugin.js): the locale's own file (the language file when the
// regional one is missing), English where it has no such string, a plural form for a counted parameter. Native
// posters read the same files (StatusRules.Text), so the parity fixtures and the web run use this instead of
// assuming a locale falls back to English.
import { existsSync, readFileSync } from 'node:fs';

const dir = new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/', import.meta.url);
const cache = new Map();

/** @param {string} name A locale name such as 'de-DE'. @returns {Record<string, string>} Its strings, {} when none. */
export function strings(name) {
    if (cache.has(name)) return cache.get(name);
    let found = {};
    for (const candidate of [name, name.split('-')[0]]) {
        const file = new URL(`${candidate}.json`, dir);
        if (existsSync(file)) { found = JSON.parse(readFileSync(file, 'utf8')); break; }
    }
    cache.set(name, found);
    return found;
}

const COUNTED = ['count', 'days', 'n', 'items', 'hours', 'minutes', 'seconds'];

/** A locale native posters can resolve: a real culture. The pirate locale is not one, so native speaks English for it. */
const cultureOrEnglish = locale => {
    try { return locale && Intl.DateTimeFormat.supportedLocalesOf(locale).length ? locale : 'en'; } catch { return 'en'; }
};

/**
 * @param {string} locale
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 * @returns {string}
 */
export function tr(locale, key, params = {}) {
    const name = cultureOrEnglish(locale);
    const own = strings(name);
    const english = strings('en');
    const keyIsOwn = typeof own[key] === 'string' && own[key] !== '';
    const source = keyIsOwn ? own : english;
    const language = keyIsOwn ? name : 'en';
    let text = source[key] ?? key;
    const counted = COUNTED.find(p => typeof params[p] === 'number' && Number.isFinite(params[p]));
    if (counted && key in source) {
        let category = 'other';
        try { category = new Intl.PluralRules([language, 'en']).select(params[counted]); } catch { /* malformed tag */ }
        const variant = [`${key}_${category}`, `${key}_other`].find(v => typeof source[v] === 'string' && source[v] !== '');
        if (variant) text = source[variant];
    }
    return Object.entries(params).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, String(v)), text);
}
