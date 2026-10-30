#!/usr/bin/env node
/** Generate native short-date data with statustags.js's exact Intl formatter options. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.versions.icu !== '78.3' || process.versions.cldr !== '48.0') {
    throw new Error('Status date generation requires ICU 78.3 / CLDR 48.0 (see poster parity README).');
}
const root = new URL('../', import.meta.url);
const locales = readdirSync(new URL('Jellyfin.Plugin.JellyfinEnhanced/js/locales/', root)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
// Include common saved regional contexts in addition to every shipped UI locale.
locales.push('en-AU', 'en-CA', 'en-NZ', 'es-MX', 'fr-CA', 'ar-SA', 'fa-AF', 'pt-PT');
const output = {};
for (const locale of [...new Set(locales)].sort()) {
    const effective = Intl.DateTimeFormat.supportedLocalesOf(locale).length ? locale : 'en';
    const formatter = new Intl.DateTimeFormat(effective, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const { calendar, numberingSystem } = formatter.resolvedOptions();
    const numeric = new Intl.DateTimeFormat(`en-u-ca-${calendar}-nu-latn`, { month: 'numeric', timeZone: 'UTC' });
    const numbers = new Intl.NumberFormat(`en-u-nu-${numberingSystem}`, { useGrouping: false });
    const months = Array(12).fill(null);
    // Cover every month of both Gregorian and Persian calendars, including their year boundary.
    for (let offset = 0; offset < 400; offset++) {
        const date = new Date(Date.UTC(2026, 0, 1 + offset));
        const month = Number(numeric.formatToParts(date).find(p => p.type === 'month').value);
        const parts = formatter.formatToParts(date);
        const value = {
            template: parts.map(p => p.type === 'month' ? '{month}' : p.type === 'day' ? '{day}' : p.value).join(''),
            month: parts.find(p => p.type === 'month').value
        };
        if (months[month - 1] && JSON.stringify(months[month - 1]) !== JSON.stringify(value)) throw new Error(`Variable short-date pattern: ${locale}`);
        months[month - 1] = value;
    }
    if (months.some(m => !m)) throw new Error(`Incomplete months: ${locale}`);
    output[locale] = { calendar, digits: Array.from({ length: 10 }, (_, i) => numbers.format(i)).join(''), months };
}
const path = new URL('Jellyfin.Plugin.JellyfinEnhanced/js/tags/status-short-dates.json', root);
const text = JSON.stringify(output, null, 2) + '\n';
if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== text) throw new Error(`Status short dates are stale: node ${fileURLToPath(import.meta.url)}`);
} else {
    writeFileSync(path, text);
}
