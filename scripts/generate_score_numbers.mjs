#!/usr/bin/env node
/** Generate native score-number data (decimal separator and digits) with the web's exact Intl formatter. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.versions.icu !== '78.3' || process.versions.cldr !== '48.0') {
    throw new Error('Score number generation requires ICU 78.3 / CLDR 48.0 (see poster parity README).');
}
const root = new URL('../', import.meta.url);
// The same locale set as scripts/generate_status_dates.mjs: every CLDR territory for each shipped
// language/script, plus the Chinese script parents.
const locales = readdirSync(new URL('Jellyfin.Plugin.JellyfinEnhanced/js/locales/', root)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
const regions = ['419'];
const names = new Intl.DisplayNames('en', { type: 'region' });
for (let first = 65; first <= 90; first++) {
    for (let second = 65; second <= 90; second++) {
        const region = String.fromCharCode(first, second);
        if (names.of(region) !== region) regions.push(region);
    }
}
const parents = new Set(['zh', 'zh-Hans', 'zh-Hant']);
for (const locale of locales) {
    const parsed = new Intl.Locale(locale);
    parents.add([parsed.language, parsed.script].filter(Boolean).join('-'));
}
for (const parent of parents) locales.push(parent, ...regions.map(region => `${parent}-${region}`));
const formats = {}, mappings = {};
const representatives = new Map();
for (const locale of [...new Set(locales)].sort()) {
    const effective = Intl.NumberFormat.supportedLocalesOf(locale).length ? locale : 'en';
    // JE.core.mediaLanguage.formatNumberText uses exactly this formatter.
    const formatter = new Intl.NumberFormat(effective, { useGrouping: false });
    const format = {
        decimal: formatter.formatToParts(1.5).find(p => p.type === 'decimal').value,
        digits: Array.from({ length: 10 }, (_, i) => formatter.format(i)).join(''),
    };
    const signature = JSON.stringify(format);
    if (!representatives.has(signature)) {
        representatives.set(signature, locale);
        formats[locale] = format;
    }
    mappings[locale] = representatives.get(signature);
}
const path = new URL('Jellyfin.Plugin.JellyfinEnhanced/js/tags/score-numbers.json', root);
const text = JSON.stringify({ formats, locales: mappings }) + '\n';
if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== text) throw new Error(`Score numbers are stale: node ${fileURLToPath(import.meta.url)}`);
} else {
    writeFileSync(path, text);
}
