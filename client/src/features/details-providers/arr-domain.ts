/** Pure logic for the admin *arr links and the *arr tag links. */
import { field, int, isRecord, list, num, str } from './wire';
import type { ArrInstanceConfig } from './host';

export interface UrlMapping { jellyfinUrl: string; arrUrl: string }
/** `jellyfinUrl|arrUrl` lines. */
export function parseUrlMappings(mappingsString: string | undefined): UrlMapping[] {
    const mappings: UrlMapping[] = [];
    if (!mappingsString) return mappings;
    for (const line of mappingsString.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split('|').map(part => part.trim());
        const [jellyfinUrl, arrUrl] = parts;
        if (parts.length === 2 && jellyfinUrl && arrUrl) mappings.push({ jellyfinUrl, arrUrl });
    }
    return mappings;
}
/** The *arr URL for the address Jellyfin is being accessed through. */
export function mappedUrl(mappings: readonly UrlMapping[], defaultUrl: string | undefined | null, serverAddress: string): string | null {
    if (!defaultUrl) return null;
    if (mappings.length === 0) return defaultUrl;
    const currentUrl = serverAddress.replace(/\/+$/, '').toLowerCase();
    for (const mapping of mappings) {
        if (currentUrl === mapping.jellyfinUrl.replace(/\/+$/, '').toLowerCase()) return mapping.arrUrl.replace(/\/$/, '');
    }
    return defaultUrl;
}
export interface ArrInstance { name: string; url: string }
/** Enabled configured instances with a usable URL. */
export function enabledInstances(instances: readonly ArrInstanceConfig[] | undefined, fallbackName: string, serverAddress: string): ArrInstance[] {
    return (instances || [])
        .filter((instance): instance is NonNullable<ArrInstanceConfig> => !!instance && instance.Enabled !== false)
        .map(instance => ({ name: instance.Name || fallbackName, url: mappedUrl(parseUrlMappings(instance.UrlMappings || ''), instance.Url, serverAddress) }))
        .filter((instance): instance is ArrInstance => !!instance.url);
}

export function formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(0) + ' MB';
    return (bytes / 1073741824).toFixed(1) + ' GB';
}
export type ArrStatus = 'missing' | 'complete' | 'partial';
export function episodeStatus(episodeFileCount: number, episodeCount: number): ArrStatus {
    if (episodeFileCount === 0) return 'missing';
    if (episodeFileCount >= episodeCount) return 'complete';
    return 'partial';
}

export interface InstanceError { instanceName: string | undefined; reason: string | undefined }
export interface SonarrMatch {
    instanceName: string | undefined; instanceUrl: string | null; titleSlug: string;
    episodeFileCount: number; episodeCount: number; sizeOnDisk: number; rootFolderPath: string;
}
export interface RadarrMatch { name: string | undefined; url: string | null; hasFile: boolean; sizeOnDisk: number; rootFolderPath: string }
export function decodeInstanceErrors(value: unknown): InstanceError[] | undefined {
    const errors = field(value, 'errors');
    if (!Array.isArray(errors)) return undefined;
    return errors.map(error => ({ instanceName: str(field(error, 'instanceName')), reason: str(field(error, 'reason')) }));
}
export function decodeSonarrMatches(value: unknown, serverAddress: string): SonarrMatch[] {
    return list(field(value, 'matches')).filter(isRecord).map(match => ({
        instanceName: str(match.instanceName),
        instanceUrl: mappedUrl(parseUrlMappings(str(match.urlMappings) || ''), str(match.instanceUrl), serverAddress),
        titleSlug: str(match.titleSlug) ?? '',
        episodeFileCount: int(match.episodeFileCount) || 0,
        episodeCount: int(match.episodeCount) || 0,
        sizeOnDisk: num(match.sizeOnDisk) || 0,
        rootFolderPath: str(match.rootFolderPath) || ''
    }));
}
export function decodeRadarrMatches(value: unknown, serverAddress: string): RadarrMatch[] {
    return list(field(value, 'matches')).filter(isRecord).map(match => ({
        name: str(match.instanceName),
        url: mappedUrl(parseUrlMappings(str(match.urlMappings) || ''), str(match.instanceUrl), serverAddress),
        hasFile: match.hasFile === true,
        sizeOnDisk: num(match.sizeOnDisk) || 0,
        rootFolderPath: str(match.rootFolderPath) || ''
    }));
}

export interface DropdownItem { name: string; url: string; status: ArrStatus | null; badge: string; size: string; tip: string }
const trimSlash = (url: string) => url.replace(/\/$/, '');
export function sonarrSeriesUrl(match: SonarrMatch & { instanceUrl: string }): string {
    return `${trimSlash(match.instanceUrl)}/series/${match.titleSlug}`;
}
export function radarrMovieUrl(match: RadarrMatch & { url: string }, tmdbId: string): string {
    return `${trimSlash(match.url)}/movie/${tmdbId}`;
}
/** The single Sonarr instance: status only when the admin opts in. */
export function singleSonarrLink(match: SonarrMatch & { instanceUrl: string }, showStatusOnSingle: boolean) {
    const haveStats = match.episodeFileCount >= 0;
    const size = formatBytes(match.sizeOnDisk);
    const tipParts = [match.instanceName ?? ''];
    if (haveStats) tipParts.push(`${match.episodeFileCount}/${match.episodeCount} episodes`);
    if (size) tipParts.push(size);
    if (match.rootFolderPath) tipParts.push(match.rootFolderPath);
    return {
        url: sonarrSeriesUrl(match),
        status: showStatusOnSingle && haveStats ? episodeStatus(match.episodeFileCount, match.episodeCount) : null,
        badge: showStatusOnSingle && haveStats ? `${match.episodeFileCount}/${match.episodeCount}` : '',
        tip: tipParts.join('\n')
    };
}
export function sonarrDropdownItems(matches: readonly (SonarrMatch & { instanceUrl: string })[]): DropdownItem[] {
    return matches.map(match => {
        const status = match.episodeFileCount < 0 ? null : episodeStatus(match.episodeFileCount, match.episodeCount);
        const badge = match.episodeFileCount < 0 ? '' : `${match.episodeFileCount}/${match.episodeCount}`;
        const size = formatBytes(match.sizeOnDisk);
        const tip = [badge ? `${badge} episodes` : null, size, match.rootFolderPath].filter(Boolean).join(' • ');
        return { name: match.instanceName ?? '', url: sonarrSeriesUrl(match), status, badge, size, tip };
    });
}
export function singleRadarrLink(match: RadarrMatch & { url: string }, tmdbId: string, showStatusOnSingle: boolean) {
    const statusValue: ArrStatus = match.hasFile ? 'complete' : 'missing';
    const badgeValue = match.hasFile ? 'Downloaded' : 'Missing';
    return {
        url: radarrMovieUrl(match, tmdbId),
        status: showStatusOnSingle ? statusValue : null,
        badge: showStatusOnSingle ? badgeValue : '',
        // The tooltip keeps the detail even when the visible badge is hidden.
        tip: [match.name, badgeValue, formatBytes(match.sizeOnDisk), match.rootFolderPath].filter(Boolean).join('\n')
    };
}
export function radarrDropdownItems(matches: readonly (RadarrMatch & { url: string })[], tmdbId: string): DropdownItem[] {
    return matches.map(match => {
        const status: ArrStatus = match.hasFile ? 'complete' : 'missing';
        const badge = match.hasFile ? 'Downloaded' : 'Missing';
        const size = formatBytes(match.sizeOnDisk);
        return { name: match.name ?? '', url: radarrMovieUrl(match, tmdbId), status, badge, size, tip: [badge, size, match.rootFolderPath].filter(Boolean).join(' • ') };
    });
}

/** TMDB id and kind from Jellyfin's own external links on the page. */
export function externalTmdbIds(hrefs: readonly string[]): { tmdb: string | null; hasTmdbLink: boolean } {
    const ids: { tmdb: string | null; hasTmdbLink: boolean } = { tmdb: null, hasTmdbLink: false };
    for (const href of hrefs) {
        if (href.includes('themoviedb.org/movie/')) {
            ids.tmdb = href.match(/\/movie\/(\d+)/)?.[1] ?? null;
            ids.hasTmdbLink = true;
        } else if (href.includes('themoviedb.org/tv/')) {
            ids.tmdb = href.match(/\/tv\/(\d+)/)?.[1] ?? null;
            ids.hasTmdbLink = true;
        }
    }
    return ids;
}

// ── *arr tag links ────────────────────────────────────────────────────────
export function slugifyTagName(name: string): string {
    try {
        return name.toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
            .replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '-').replace(/--+/g, '-').replace(/^-+|-+$/g, '');
    } catch {
        return name;
    }
}
const lines = (raw: string, prefix: string) => raw.split('\n').map(line => line.trim()).filter(line => line.length > 0).map(line => `${prefix}${line}`);
/** Item tags carrying the *arr prefix, minus hidden ones, limited to the allowlist when set. */
export function relevantArrTags(tags: readonly string[], prefix: string, allowRaw: string, hideRaw: string): string[] {
    const allowed = lines(allowRaw, prefix).map(tag => tag.toLowerCase());
    const hidden = lines(hideRaw, prefix).map(tag => tag.toLowerCase());
    let relevant = tags.filter(tag => tag.startsWith(prefix));
    if (hidden.length > 0) relevant = relevant.filter(tag => !hidden.includes(tag.toLowerCase()));
    if (allowed.length > 0) relevant = relevant.filter(tag => allowed.includes(tag.toLowerCase()));
    return relevant;
}
