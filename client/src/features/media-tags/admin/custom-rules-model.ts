/**
 * @file The Custom tag rules as the server stores them (Configuration/CustomTagRuleSet.cs):
 * the table's rows, their clean-up and the reserved-label rule. Pure.
 */
import type { JsonValue } from '../../../contracts/generated';
import type { CustomRule } from './types';
import { pick } from './values';

export const MAX_RULES = 20;
export const MAX_LABEL = 24;
// The genre icons the bundled Material Symbols subset carries (js/tags/customtags.js ICONS).
export const ICONS = ['theaters', 'sports_martial_arts', 'explore', 'animation', 'mood', 'local_police', 'article', 'theater_comedy',
    'family_restroom', 'auto_awesome', 'history_edu', 'skull', 'music_note', 'psychology_alt', 'favorite', 'science', 'tv',
    'psychology', 'military_tech', 'landscape', 'domino_mask', 'music_video', 'menu_book', 'sports_soccer', 'quiz', 'live_tv'];

/** One table row as the editor holds it. */
export interface Row { match: string; value: string; label: string; icon: string | null }

/**
 * Trimmed, with runs of white space and control characters as one space, as
 * the server stores names and labels (CustomTagRuleSet.Collapse).
 * @param value
 * @returns {string}
 */
export function clean(value: unknown): string {
    return String(value || '').replace(/[\p{White_Space}\p{Cc}]+/gu, ' ').replace(/^ | $/g, '');
}

/**
 * A label of punctuation only, such as "*" (Tag Styles' whole-group key): the
 * server drops such rules. The definition is CustomTagRuleSet.IsReservedLabel's:
 * every Unicode scalar value is in general category P or has the White_Space property.
 * @param value
 * @returns {boolean}
 */
export function isReservedLabel(value: unknown): boolean {
    const label = clean(value);
    return label !== '' && /^[\p{P}\p{White_Space}]+$/u.test(label);
}

/**
 * The rows as the server stores them: complete rows only, labels cut to 24
 * characters, repeated match/name pairs dropped (the first wins), at most 20.
 * @param rows
 * @returns {CustomRule[]}
 */
export function collectRules(rows: readonly Row[]): CustomRule[] {
    const seen = new Set<string>();
    const out: CustomRule[] = [];
    rows.forEach((r) => {
        const value = clean(r.value);
        const label = clean(r.label).slice(0, MAX_LABEL).replace(/ $/, '');
        const key = r.match + ':' + value.toLowerCase();
        if (!value || !label || isReservedLabel(label) || seen.has(key) || out.length >= MAX_RULES) return;
        seen.add(key);
        out.push({ Match: r.match, Value: value, Label: label, Icon: r.icon !== null && ICONS.indexOf(r.icon) >= 0 ? r.icon : null });
    });
    return out;
}

/**
 * The stored rules as table rows (at most 20; either key case).
 * @param stored - CustomTagRules.
 * @returns {Row[]}
 */
export function readRows(stored: JsonValue | undefined): Row[] {
    return (Array.isArray(stored) ? stored : []).slice(0, MAX_RULES).map((r) => {
        const match = String(pick(r, 'match') || '').toLowerCase();
        const icon = String(pick(r, 'icon') || '');
        return {
            match: match === 'collection' ? 'collection' : 'tag',
            value: String(pick(r, 'value') || ''),
            label: String(pick(r, 'label') || ''),
            icon: ICONS.indexOf(icon) >= 0 ? icon : null,
        };
    });
}
