import { CATEGORIES, TAG_TO_CATEGORY } from '../types/quality/quality-data';
import { DEFAULT_ORDER, type Group, hasOwn, pick } from './layout-rules';

/**
 * Tag kinds: the unit a user sets opacity and size for. Every quality category (resolution, source, HDR, special
 * format, video codec, sound, edition, runtime, aspect ratio, frame rate, versions) is a kind of its own, and every
 * other card tag group (status, rating, age rating, language, genre, awards, logos, custom) is one kind. Built from
 * the group list and the quality category table, so a group or category added there is a kind without more work.
 */
export interface TagKind { id: string; group: Group; /** A quality category's show setting (showResolutionTag), naming it. */ setting?: string }
export const TAG_KINDS: readonly TagKind[] = DEFAULT_ORDER.flatMap((group): TagKind[] =>
    group === 'quality' ? CATEGORIES.map(category => ({ id: category.key, group, setting: category.settingKey })) : [{ id: group, group }]);
const KIND_IDS: ReadonlySet<string> = new Set(TAG_KINDS.map(kind => kind.id));

/** Percent ranges: opacity 10–100 (a tag is never invisible), size 50–200 of today's size; 100 is today's look. */
export const KIND_LOOK_LIMITS = {
    opacity: { min: 10, max: 100, step: 5, fallback: 100 },
    scale: { min: 50, max: 200, step: 5, fallback: 100 },
} as const;
export type KindLookField = keyof typeof KIND_LOOK_LIMITS;
const FIELDS: readonly KindLookField[] = ['opacity', 'scale'];

/** A kind's own values (either may be missing: it then follows the administrator, then 100). */
export type KindLook = Partial<Record<KindLookField, number>>;
/** Effective values of the kinds that differ from today's look, by kind id. */
export type KindLooks = Record<string, { opacity: number; scale: number }>;

/** A whole percent in the field's range, or undefined for anything that is not a finite number. */
export function readKindValue(value: unknown, field: KindLookField): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    const { min, max } = KIND_LOOK_LIMITS[field];
    return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * A stored list (`[{ kind, opacity, scale }]`, either spelling) as the values of known kinds, clamped. The first entry
 * for a kind wins; unknown kinds, non-numbers and entries without a value are left out.
 */
export function readKindLooks(raw: unknown): Record<string, KindLook> {
    const out: Record<string, KindLook> = Object.create(null);
    if (!Array.isArray(raw)) return out;
    for (const entry of raw) {
        const kind = pick(entry, 'kind');
        if (typeof kind !== 'string' || !KIND_IDS.has(kind) || hasOwn(out, kind)) continue;
        const look: KindLook = {};
        for (const field of FIELDS) {
            const value = readKindValue(pick(entry, field), field);
            if (value !== undefined) look[field] = value;
        }
        if (Object.keys(look).length) out[kind] = look;
    }
    return out;
}

/**
 * The effective looks: per kind and per value the user's own, else the administrator's, else 100. Only kinds that
 * differ from today's look are listed, so an empty object draws every card exactly as before.
 */
export function effectiveKindLooks(own: Record<string, KindLook>, admin: Record<string, KindLook>): KindLooks {
    const out: KindLooks = {};
    for (const { id } of TAG_KINDS) {
        const opacity = own[id]?.opacity ?? admin[id]?.opacity ?? KIND_LOOK_LIMITS.opacity.fallback;
        const scale = own[id]?.scale ?? admin[id]?.scale ?? KIND_LOOK_LIMITS.scale.fallback;
        if (opacity !== KIND_LOOK_LIMITS.opacity.fallback || scale !== KIND_LOOK_LIMITS.scale.fallback) out[id] = { opacity, scale };
    }
    return out;
}

/**
 * The looks a settings document draws with: its own values over the administrator's (`tagKindLooks` /
 * `TagKindLooks`). A document saved before layouts keeps the look it always had, like its size and spacing.
 */
export function kindLooksOf(settings: unknown, plugin: unknown, legacy: boolean): KindLooks {
    return legacy ? {} : effectiveKindLooks(readKindLooks(pick(settings, 'tagKindLooks')), readKindLooks(pick(plugin, 'tagKindLooks')));
}

/**
 * Promoting a legacy document (any layout control does) must not opt it into the administrator's looks: the kinds
 * the administrator set are pinned at 100% in the document's own list, after any values it already has.
 * @returns Whether the document changed.
 */
export function pinKindLooks(doc: { tagKindLooks?: unknown }, plugin: unknown): boolean {
    const admin = readKindLooks(pick(plugin, 'tagKindLooks'));
    const list: unknown[] = Array.isArray(doc.tagKindLooks) ? doc.tagKindLooks.slice() : [];
    const own = readKindLooks(list);
    const pins = TAG_KINDS.filter(({ id }) => hasOwn(admin, id) && !hasOwn(own, id))
        .map(({ id }) => ({ kind: id, opacity: KIND_LOOK_LIMITS.opacity.fallback, scale: KIND_LOOK_LIMITS.scale.fallback }));
    if (!pins.length) return false;
    doc.tagKindLooks = [...list, ...pins];
    return true;
}

/** The stored form of some kinds' own values (known kinds, kind order, valid values only). */
export function kindLooksToWire(looks: Readonly<Record<string, KindLook>>): Array<{ kind: string; opacity?: number; scale?: number }> {
    const out: Array<{ kind: string; opacity?: number; scale?: number }> = [];
    for (const { id } of TAG_KINDS) {
        if (!hasOwn(looks, id)) continue;
        const entry: { kind: string; opacity?: number; scale?: number } = { kind: id };
        for (const field of FIELDS) {
            const value = readKindValue(looks[id]?.[field], field);
            if (value !== undefined) entry[field] = value;
        }
        if (entry.opacity !== undefined || entry.scale !== undefined) out.push(entry);
    }
    return out;
}

/**
 * A quality chip's kind when its maker did not stamp one (data-je-tag-kind; the quality renderer does): its technical
 * category, else the category its label belongs to. Chips drawn elsewhere (the settings previews) get their kind here.
 */
export function qualityKindOf(chip: HTMLElement): string {
    return chip.dataset.jeTagKind || chip.dataset.jeQualityCategory || TAG_TO_CATEGORY.get(chip.dataset.quality || '') || '';
}

/** The marker the layout puts on a card host (and caption strip): a plain number naming one set of looks. */
export const KIND_LOOKS_ATTR = 'data-je-kind-looks';

/**
 * The rules drawing one set of looks on the hosts marked with its id. A group kind styles each chip of its group,
 * a quality kind the chips of its category (data-je-tag-kind); summaries (the Summary pill, Minimal's dots) and
 * the "+N" chip keep the card's look. Size multiplies the card's tag size on the chip (its text, padding and icons;
 * spacing follows the card). Opacity is a filter: the chips' own `opacity` (1, or a partial dub's dimmed flag, and
 * any fade) stays theirs and multiplies with it. Selectors use only known kind ids and the values are clamped numbers.
 * @param looks - Effective looks (effectiveKindLooks).
 * @param id - The set's id: a whole number (or its digits).
 */
export function kindLooksCss(looks: KindLooks, id: number | string): string {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n < 0 || String(n) !== String(id)) throw new TypeError('kind looks: the id must be a number');
    const hosts = [`.je-tag-host[${KIND_LOOKS_ATTR}="${n}"] > .je-tag-slot`, `.je-tag-caption[${KIND_LOOKS_ATTR}="${n}"]`];
    const rules: string[] = [];
    for (const { id: kind, group } of TAG_KINDS) {
        const look = hasOwn(looks, kind) ? looks[kind] : undefined;
        if (!look) continue;
        const opacity = readKindValue(look.opacity, 'opacity') ?? KIND_LOOK_LIMITS.opacity.fallback;
        const scale = readKindValue(look.scale, 'scale') ?? KIND_LOOK_LIMITS.scale.fallback;
        const body = [opacity !== 100 ? `filter: opacity(${opacity / 100});` : '', scale !== 100 ? `--je-tag-scale: calc(var(--je-tag-base-scale, 1) * ${scale / 100});` : ''].filter(Boolean).join(' ');
        if (!body) continue;
        const chip = group === 'quality' ? `[data-je-group="quality"] > [data-je-tag-kind="${kind}"]` : `[data-je-group="${group}"] > *`;
        rules.push(`${hosts.map(host => `${host} > ${chip}`).join(', ')} { ${body} }`);
    }
    if (!rules.length) return '';
    // The card's own size, read where it is set (inline on the host and the caption strip), before a chip changes it.
    return [`:is(.je-tag-host, .je-tag-caption)[${KIND_LOOKS_ATTR}="${n}"] { --je-tag-base-scale: var(--je-tag-scale, 1); }`, ...rules].join('\n');
}
