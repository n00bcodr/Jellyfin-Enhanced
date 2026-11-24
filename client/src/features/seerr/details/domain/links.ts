import { str } from './json';

/** Only absolute web links leave the page; a reply can carry any scheme. */
export function safeHttpUrl(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0) return null;
    try {
        const { protocol } = new URL(value);
        return protocol === 'http:' || protocol === 'https:' ? value : null;
    } catch {
        return null;
    }
}

/** Paths land inside CSS url('…') as well as attributes; quoting cannot end either. */
function urlSafePath(path: string): string {
    return path.replace(/[\s'"()\\<>]/g, character => encodeURIComponent(character).replace(/[()']/g,
        escaped => `%${escaped.charCodeAt(0).toString(16).toUpperCase()}`));
}

export function tmdbImage(size: string, path: unknown): string {
    const value = str(path);
    return value ? `https://image.tmdb.org/t/p/${size}${urlSafePath(value)}` : '';
}

/** A TMDB poster path, e.g. /abc123.jpg, in the only form that may load from TMDB. */
export function isPosterPath(value: unknown): value is string {
    return typeof value === 'string' && /^\/[a-zA-Z0-9._-]+\.[a-zA-Z]+$/.test(value);
}

/**
 * The attributes of a link out of the app: a new window, or on the TV layout an inert `href="#"` with no target,
 * which Jellyfin's link button ignores. A TV app has only the one window, so the site would replace Jellyfin and
 * Back could not return.
 */
export function externalLinkAttrs(href: string, escapeHtml: (value: string) => string, tvLayout: boolean): string {
    return tvLayout ? 'href="#"' : `href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"`;
}

/** The hash route of a Jellyfin item; relative to the page, so it keeps any server base path. */
export function detailsHref(itemId: string): string {
    return `#!/details?id=${encodeURIComponent(itemId)}`;
}

/** Seerr's own page for a title. The base can carry a sub-path, which `new URL` would drop. */
export function seerrPage(base: string, mediaType: string, tmdbId: string | number): string {
    return `${base}/${mediaType}/${tmdbId}`;
}
