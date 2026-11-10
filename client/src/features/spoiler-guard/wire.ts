import type { MutationResult, Prefs } from './host';
export function record(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid Spoiler Guard object');
    return Object.fromEntries(Object.entries(value));
}
export function decodePrefs(value: unknown): Prefs {
    const input = record(value);
    const result: Record<string, boolean | null> = {};
    for (const [key, field] of Object.entries(input)) {
        if (typeof field !== 'boolean' && field !== null) throw new Error('Invalid Spoiler Guard preference');
        if (key === 'SkipDisableConfirm' && field === null) throw new Error('Invalid confirmation preference');
        Object.defineProperty(result, key, { value: field, enumerable: true, writable: true });
    }
    return result;
}
export function decodeState(value: unknown) {
    const input = record(value);
    function ids(key: string): Record<string, unknown> {
        const entries = record(input[key]);
        for (const item of Object.values(entries)) record(item);
        return entries;
    }
    return { Series: ids('Series'), Movies: ids('Movies'), Collections: ids('Collections'), PendingTmdb: ids('PendingTmdb'), Prefs: decodePrefs(input.Prefs) };
}
export function decodeMutation(value: unknown): MutationResult {
    const input = record(value);
    const result: MutationResult = {};
    for (const key of ['promoted', 'removedFrom', 'jellyfinId'] as const) {
        const field = input[key];
        if (key === 'jellyfinId' && field === null) continue;
        if (field !== undefined) { if (typeof field !== 'string') throw new Error('Invalid Spoiler Guard mutation'); result[key] = field; }
    }
    if (result.promoted !== undefined && !['pending', 'series', 'movie'].includes(result.promoted)) throw new Error('Invalid promotion');
    if (result.removedFrom !== undefined && !['none', 'pending', 'series', 'movie'].includes(result.removedFrom)) throw new Error('Invalid removal kind');
    if ((result.promoted === 'series' || result.promoted === 'movie' || result.removedFrom === 'series' || result.removedFrom === 'movie') && !result.jellyfinId) throw new Error('Missing promoted Jellyfin ID');
    if (input.removed !== undefined) { if (typeof input.removed !== 'boolean') throw new Error('Invalid removed verdict'); result.removed = input.removed; }
    if (input.prefs !== undefined) result.prefs = decodePrefs(input.prefs);
    return result;
}
export function decodeSeerr(value: unknown) {
    const input = record(value);
    const id = input.id;
    if (typeof id !== 'number' && typeof id !== 'string') throw new Error('Invalid Seerr ID');
    const media = input.mediaInfo == null ? {} : record(input.mediaInfo);
    const items = input.jeSpoilerGuardItems ?? [];
    if (!Array.isArray(items)) throw new Error('Invalid guarded item list');
    const guarded: string[] = [];
    for (const item of items) { if (typeof item !== 'string') throw new Error('Invalid guarded item'); guarded.push(item); }
    for (const key of ['jeSpoilerGuard', 'jeSpoilerGuardInherited'] as const) {
        if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error('Invalid guard verdict');
    }
    if (media.jellyfinMediaId != null && typeof media.jellyfinMediaId !== 'string') throw new Error('Invalid Jellyfin ID');
    return { id, title: typeof input.title === 'string' ? input.title : '', name: typeof input.name === 'string' ? input.name : '',
        mediaInfo: { jellyfinMediaId: typeof media.jellyfinMediaId === 'string' ? media.jellyfinMediaId : null },
        jeSpoilerGuard: input.jeSpoilerGuard === true, jeSpoilerGuardInherited: input.jeSpoilerGuardInherited === true, jeSpoilerGuardItems: guarded };
}
