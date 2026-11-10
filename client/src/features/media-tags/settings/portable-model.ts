/**
 * Readers for the Media Tags import/export/preset answers
 * (Shared/MediaTags/MediaTagsPortable.cs). Values stay unknown: a change's from/to
 * are whatever JSON the server reports and are only shown or written back
 * through the settings save path, which validates them again.
 */
const record = (value: unknown): object => value !== null && typeof value === 'object' ? value : {};
const get = (value: unknown, key: string): unknown => Reflect.get(record(value), key);
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** One field a preview would change. */
export interface PortableChange { field: unknown; from: unknown; to: unknown }
/** One field a preview skipped, and why. */
export interface PortableSkip { field: unknown; reason: unknown; detail: unknown }
/** What a document would change (POST media-tags/preview). */
export interface PortablePreview { changes: PortableChange[]; skipped: PortableSkip[]; imported: string[]; name: unknown }

export const changesOf = (value: unknown): PortableChange[] => list(value).map((c) => ({ field: get(c, 'field'), from: get(c, 'from'), to: get(c, 'to') }));
export const skipsOf = (value: unknown): PortableSkip[] => list(value).map((s) => ({ field: get(s, 'field'), reason: get(s, 'reason'), detail: get(s, 'detail') }));

/** A preview answer, or the part of one a caller passes (the admin page passes its own). */
export function decodePreview(value: unknown): PortablePreview {
    const imported = get(value, 'imported');
    return {
        changes: changesOf(get(value, 'changes')),
        skipped: skipsOf(get(value, 'skipped')),
        imported: imported !== null && typeof imported === 'object' ? Object.keys(imported) : [],
        name: get(value, 'name'),
    };
}

/** A preset as listed (built-in, offered by the administrator, or the user's own). */
export interface Preset { id: unknown; name: unknown; description: unknown; v: unknown; settings: unknown }
export type PresetSource = 'builtIn' | 'offered' | 'mine';
export interface PresetList { max: number; builtIn: Preset[]; offered: Preset[]; mine: Preset[] }
const presetOf = (value: unknown): Preset => ({ id: get(value, 'id'), name: get(value, 'name'), description: get(value, 'description'), v: get(value, 'v'), settings: get(value, 'settings') });
export const isPresetSource = (value: unknown): value is PresetSource => value === 'builtIn' || value === 'offered' || value === 'mine';

/** The presets answer (GET media-tags/presets); at most 10 own presets when the server names no limit. */
export function decodePresets(value: unknown): PresetList {
    return {
        max: Number(get(value, 'max')) || 10,
        builtIn: list(get(value, 'builtIn')).map(presetOf),
        offered: list(get(value, 'offered')).map(presetOf),
        mine: list(get(value, 'mine')).map(presetOf),
    };
}

/** An exported document's version and settings (GET media-tags/export). */
export function exportedParts(value: unknown): { v: unknown; settings: unknown; fieldCount: number } {
    const settings = get(value, 'settings');
    return { v: get(value, 'v'), settings, fieldCount: Object.keys(record(settings)).length };
}

/** A saved preset's answer (POST media-tags/presets): its stored name and what was skipped. */
export function savedPreset(value: unknown): { name: unknown; skipped: PortableSkip[] } {
    return { name: get(get(value, 'preset'), 'name'), skipped: skipsOf(get(value, 'skipped')) };
}

/** The refusal code (and limit) in an error body, or 'save'. */
export function refusal(body: unknown): { code: string; max?: unknown } {
    const code = get(body, 'error');
    return typeof code === 'string' ? { code, max: get(body, 'max') } : { code: 'save' };
}

/** The HTTP status of a failed request (a fetch Response from ApiClient.ajax), when it has one. */
export const statusOf = (err: unknown): unknown => get(err, 'status');
