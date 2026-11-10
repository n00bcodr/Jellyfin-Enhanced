import type { MediaType, TmdbId } from '../../host-details';
import { calendarYear } from './dates';
import { filled, idText, isRecord, num, record, records, str, type JsonRecord } from './json';

export function parseMediaType(value: unknown): MediaType | null {
    return value === 'movie' || value === 'tv' ? value : null;
}

/** A title's TMDB id as Seerr sent it, which lookups and request bodies keep. */
export function tmdbIdOf(details: JsonRecord): TmdbId {
    return num(details.id) ?? idText(details.id) ?? '';
}

/** The title a details reply is known by: movies have `title`, shows `name`. */
export function titleOf(details: JsonRecord, mediaType: MediaType): string {
    return str(mediaType === 'movie' ? details.title : details.name) ?? '';
}
/** Either name, for the request dialogs that accept both. */
export function anyTitle(details: JsonRecord): string {
    return filled(details.title) ?? filled(details.name) ?? '';
}

/** One side of a title's Seerr state, with the defaults the request logic expects. */
export interface MediaState {
    status: number; status4k: number;
    downloads: readonly unknown[]; downloads4k: readonly unknown[];
    jellyfinId: string | null; jellyfinId4k: string | null;
}
export function mediaState(details: JsonRecord): MediaState {
    const info = record(details.mediaInfo) ?? {};
    return {
        status: num(info.status) ?? 1, status4k: num(info.status4k) ?? 1,
        downloads: Array.isArray(info.downloadStatus) ? info.downloadStatus : [],
        downloads4k: Array.isArray(info.downloadStatus4k) ? info.downloadStatus4k : [],
        jellyfinId: filled(info.jellyfinMediaId), jellyfinId4k: filled(info.jellyfinMediaId4k),
    };
}

/** The media record of a details reply, created on first use for a local status change. */
export function ownMediaInfo(details: JsonRecord): JsonRecord {
    if (isRecord(details.mediaInfo)) return details.mediaInfo;
    const info: JsonRecord = {};
    details.mediaInfo = info;
    return info;
}

/** The server's verdict that 4K is really available needs a library item of its own. */
export function clearPhantom4k(details: unknown, available: number, unknown: number): void {
    const info = isRecord(details) ? record(details.mediaInfo) : null;
    if (!info || info.status4k !== available) return;
    const distinct = filled(info.jellyfinMediaId4k) && info.jellyfinMediaId4k !== info.jellyfinMediaId;
    if (!distinct) info.status4k = unknown;
}

/** Fields the client adds to a reply; everything else belongs to the latest reply. */
const CLIENT_FIELDS = new Set(['ratings']);

/** Fresh replies replace older ones whole: Seerr omits what no longer exists. */
export function replaceDetails(details: JsonRecord, fresh: JsonRecord): void {
    for (const key of Object.keys(details)) {
        if (!CLIENT_FIELDS.has(key) && !(key in fresh)) delete details[key];
    }
    Object.assign(details, fresh);
}

function pickByRegion(entries: readonly JsonRecord[], region: string): JsonRecord | undefined {
    return entries.find(entry => entry.iso_3166_1 === region) ?? entries.find(entry => entry.iso_3166_1 === 'US') ?? entries[0];
}

/** The certification for a region: movies nest it per release, shows give one rating. */
export function contentRating(details: JsonRecord, mediaType: MediaType, region: string): string {
    if (mediaType === 'movie') {
        const results = record(details.releases)?.results;
        if (!Array.isArray(results)) return 'N/A';
        const dates = records(pickByRegion(records(results), region)?.release_dates);
        if (!dates.length) return 'N/A';
        const release = dates.find(date => date.type === 3 && filled(date.certification)) ?? dates.find(date => filled(date.certification));
        return filled(release?.certification) ?? 'N/A';
    }
    const results = record(details.contentRatings)?.results;
    if (!Array.isArray(results)) return 'N/A';
    return filled(pickByRegion(records(results), region)?.rating) ?? 'N/A';
}

/** Up to six flat-rate providers for a region, each once. */
export function streamingProviders(details: JsonRecord, region: string): JsonRecord[] {
    if (!Array.isArray(details.watchProviders)) return [];
    const unique: JsonRecord[] = [];
    const seen = new Set<unknown>();
    for (const provider of records(pickByRegion(records(details.watchProviders), region)?.flatrate)) {
        if (seen.has(provider.id)) continue;
        seen.add(provider.id);
        unique.push(provider);
        if (unique.length >= 6) break;
    }
    return unique;
}

export function formatRuntime(minutes: number): string {
    return `${minutes >= 60 ? `${Math.floor(minutes / 60)}h ` : ''}${minutes % 60 ? `${minutes % 60}m` : ''}`.trim();
}

export function runtimeText(details: JsonRecord, mediaType: MediaType): string {
    if (mediaType === 'movie') {
        const runtime = num(details.runtime);
        return runtime ? formatRuntime(runtime) : 'N/A';
    }
    const first = Array.isArray(details.episodeRunTime) ? num(details.episodeRunTime[0]) : undefined;
    return first !== undefined ? `${first} min episodes` : 'N/A';
}

/** The year shown in the title. Spoiler Guard can leave only this of a hidden date. */
export function headerYear(details: JsonRecord, releaseDate: string | undefined): string | number {
    return idText(details.jeYear) ?? (releaseDate ? calendarYear(releaseDate) ?? 'N/A' : 'N/A');
}

/** Directors first, then up to three writers, as Seerr lists them. */
export function crewSummary(details: JsonRecord): { director: JsonRecord | undefined; writers: JsonRecord[] } | null {
    const credits = record(details.credits);
    if (!credits || !Array.isArray(credits.crew)) return null;
    const crew = records(credits.crew);
    return {
        director: crew.find(person => person.job === 'Director'),
        writers: crew.filter(person => person.job === 'Screenplay' || person.job === 'Writer' || person.job === 'Story').slice(0, 3),
    };
}

/** Who asked for a title, each name once; a 4K request is its own entry. */
export function requesters(info: unknown): Array<{ label: string; avatar: string | null }> {
    const seen = new Set<string>();
    const entries: Array<{ label: string; avatar: string | null }> = [];
    for (const request of records(record(info)?.requests)) {
        const user = record(request.requestedBy);
        const name = filled(user?.displayName) ?? filled(user?.username);
        if (!name) continue;
        const label = request.is4k ? `${name} (4K)` : name;
        if (seen.has(label)) continue;
        seen.add(label);
        entries.push({ label, avatar: filled(user?.avatar) });
    }
    return entries;
}

/** Keeps the first report of each download; both quality lists can name one transfer. */
export function uniqueDownloads(downloads: readonly unknown[], downloads4k: readonly unknown[]): JsonRecord[] {
    const grouped = new Map<string, JsonRecord>();
    for (const download of [...downloads, ...downloads4k]) {
        if (!isRecord(download)) continue;
        const id = idText(download.downloadId) ?? 'unknown';
        if (!grouped.has(id)) grouped.set(id, download);
    }
    return [...grouped.values()];
}

/** Whole-percent progress of a transfer that reports its sizes. */
export function downloadPercent(download: JsonRecord): number | null {
    const size = num(download.size);
    const left = num(download.sizeLeft);
    if (size === undefined || left === undefined || size <= 0) return null;
    return Math.max(0, Math.min(100, Math.round(100 * (1 - left / size))));
}
