#!/usr/bin/env node
/** Generate native short-date data with statustags.js's exact Intl formatter options. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.versions.icu !== '78.3' || process.versions.cldr !== '48.0') {
    throw new Error('Status date generation requires ICU 78.3 / CLDR 48.0 (see poster parity README).');
}
const root = new URL('../', import.meta.url);
const locales = readdirSync(new URL('Jellyfin.Plugin.JellyfinEnhanced/js/locales/', root)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
// Intl has no available-locale enumeration API. Enumerate CLDR's named
// territories for every shipped language/script (plus Chinese script parents).
// supportedLocalesOf alone accepts invented regions by falling back to language.
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
for (const parent of parents) {
    locales.push(parent, ...regions.map(region => `${parent}-${region}`));
}
const formats = {}, mappings = {}, fixtures = {};
const representatives = new Map();
// Gregorian month identities repeat annually; the sample includes Persian year
// boundaries. Cache identical resolved Intl contexts before walking 400 dates.
const resolvedContexts = new Map();
for (const locale of [...new Set(locales)].sort()) {
    const effective = Intl.DateTimeFormat.supportedLocalesOf(locale).length ? locale : 'en';
    const formatter = new Intl.DateTimeFormat(effective, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const { calendar, numberingSystem, locale: resolvedLocale } = formatter.resolvedOptions();
    const context = `${resolvedLocale}|${calendar}|${numberingSystem}`;
    if (resolvedContexts.has(context)) {
        mappings[locale] = resolvedContexts.get(context);
        fixtures[locale] = fixtures[mappings[locale]];
        continue;
    }
    const numeric = new Intl.DateTimeFormat(`en-u-ca-${calendar}-nu-latn`, { month: 'numeric', timeZone: 'UTC' });
    const numbers = new Intl.NumberFormat(`en-u-nu-${numberingSystem}`, { useGrouping: false });
    const months = Array(12).fill(null);
    let dayDigits = 2;
    // Cover every month of both Gregorian and Persian calendars, including their year boundary.
    for (let offset = 0; offset < 400; offset++) {
        const date = new Date(Date.UTC(2026, 0, 1 + offset));
        const month = Number(numeric.formatToParts(date).find(p => p.type === 'month').value);
        const parts = formatter.formatToParts(date);
        dayDigits = Math.min(dayDigits, [...parts.find(p => p.type === 'day').value].length);
        const value = {
            template: parts.map(p => p.type === 'month' ? '{month}' : p.type === 'day' ? '{day}' : p.value).join(''),
            month: parts.find(p => p.type === 'month').value
        };
        if (months[month - 1] && JSON.stringify(months[month - 1]) !== JSON.stringify(value)) throw new Error(`Variable short-date pattern: ${locale}`);
        months[month - 1] = value;
    }
    if (months.some(m => !m)) throw new Error(`Incomplete months: ${locale}`);
    const format = { calendar, dayDigits, digits: Array.from({ length: 10 }, (_, i) => numbers.format(i)).join(''), months };
    const signature = JSON.stringify(format);
    if (!representatives.has(signature)) {
        representatives.set(signature, locale);
        formats[locale] = format;
    }
    mappings[locale] = representatives.get(signature);
    resolvedContexts.set(context, mappings[locale]);
    fixtures[locale] = ['2026-01-04', '2026-03-20', '2026-03-21', '2026-10-04'].map(date =>
        formatter.format(new Date(`${date}T00:00:00Z`)));
}
const path = new URL('Jellyfin.Plugin.JellyfinEnhanced/js/tags/status-short-dates.json', root);
const text = JSON.stringify({ formats, locales: mappings }, null, 2) + '\n';
if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== text) throw new Error(`Status short dates are stale: node ${fileURLToPath(import.meta.url)}`);
} else {
    writeFileSync(path, text);
}
// Each enumerated region gets independent browser expectations for four dates.
const fixturesPath = new URL('tests/fixtures/native-status-dates.json', root);
const fixturesText = JSON.stringify(fixtures, null, 2) + '\n';
if (process.argv.includes('--check')) {
    if (readFileSync(fixturesPath, 'utf8') !== fixturesText) throw new Error('Status regional fixtures are stale.');
} else {
    writeFileSync(fixturesPath, fixturesText);
}
console.log(`Status dates: ${Object.keys(mappings).length} locales, ${Object.keys(formats).length} distinct formats`);
