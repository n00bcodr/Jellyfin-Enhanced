export function normalizeId(id: unknown) {
        if (!id) return '';
        if (typeof id !== 'string' && typeof id !== 'number' && typeof id !== 'bigint') return '';
        return String(id).replace(/-/g, '').toLowerCase();
    };

export function pendingKey(mediaType: unknown, tmdbId: unknown) {
        const type = typeof mediaType === 'string' ? mediaType.toLowerCase() : '';
        const id = (typeof tmdbId === 'string' || typeof tmdbId === 'number')
            ? String(tmdbId).trim()
            : '';
        if (!id || (type !== 'tv' && type !== 'movie')) return '';
        return `${type}:${id}`;
    };

export function kindOf(itemType: unknown) {
        if (itemType === 'Movie') return 'movie';
        if (itemType === 'BoxSet') return 'collection';
        return 'series';
    };
