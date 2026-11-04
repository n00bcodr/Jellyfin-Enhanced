#!/usr/bin/env node
/**
 * Media Tags translation coverage per shipped locale: how many of the English Media Tags strings each
 * locale translates, and any translated string whose {placeholders} differ from English.
 * Usage: node scripts/tag-translation-coverage.mjs [--json]
 */
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../Jellyfin.Plugin.JellyfinEnhanced/js/locales/', import.meta.url);
/** Key families the Media Tags feature (cards, panel, admin page, native posters) uses. */
export const TAG_KEY = /^(tag_|tags_|admin_tags_|admin_status_tags_|status_tag|quality_|series_quality_|language_tags_|rating_tags_|awards_tags_|logo_tags|custom_tags|media_tags_|native_poster|panel_settings_ui_tag|tag_look|panel_media_tags_|panel_settings_ui_[a-z_]*tags|toast_tag_|feature_[a-z_]*tags|rating_sources_|language_priority_|audio_language_no_dialogue)/;
const placeholders = text => [...String(text).matchAll(/\{[a-zA-Z]+\}/g)].map(m => m[0]).sort().join(' ');

/**
 * @returns {{locale: string, translated: number, total: number, placeholderErrors: string[]}[]}
 */
export function coverage() {
    const english = JSON.parse(readFileSync(new URL('en.json', dir), 'utf8'));
    const keys = Object.keys(english).filter(key => TAG_KEY.test(key));
    return readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'en.json').sort().map(file => {
        const strings = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
        const present = keys.filter(key => typeof strings[key] === 'string' && strings[key] !== '');
        return {
            locale: file.slice(0, -5),
            translated: present.length,
            total: keys.length,
            placeholderErrors: present.filter(key => placeholders(strings[key]) !== placeholders(english[key])),
        };
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const rows = coverage();
    if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
    else {
        console.log('| Locale | Media Tags strings translated |\n|---|---|');
        for (const row of rows) console.log(`| ${row.locale} | ${row.translated} / ${row.total} (${Math.round(row.translated * 100 / row.total)}%)${row.placeholderErrors.length ? `, ${row.placeholderErrors.length} placeholder mismatches` : ''} |`);
    }
}
