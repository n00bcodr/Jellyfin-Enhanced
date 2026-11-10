import { isIsoDate } from './dates';
import { filled, idText, list, num, record, records, str, type JsonRecord } from './json';

export function seasonNumberOf(season: JsonRecord): number | undefined {
    return num(season.seasonNumber);
}

/** A season's own row in the media record, by season number. Specials have none. */
export function seasonStatus(details: unknown, seasonNumber: number): JsonRecord | null {
    if (!seasonNumber) return null;
    return records(record(record(details)?.mediaInfo)?.seasons).find(season => Number(season.seasonNumber) === Number(seasonNumber)) ?? null;
}

export function seasonJellyfinId(season: JsonRecord | null, is4k = false): string | null {
    if (!season) return null;
    return is4k
        ? filled(season.jellyfinMediaId4k) ?? filled(season.jellyfinSeasonId4k) ?? filled(season.jellyfinId4k)
        : filled(season.jellyfinMediaId) ?? filled(season.jellyfinSeasonId) ?? filled(season.jellyfinId);
}

/**
 * The label on a season card. TheTVDB can name a season with its bare number, which
 * is replaced; a year-named season matches too, an accepted trade-off.
 */
export function seasonDisplayName(season: JsonRecord, specials: string, numbered: (number: number) => string): string {
    const number = seasonNumberOf(season) ?? 0;
    const trimmed = (str(season.name) ?? '').trim();
    const numericOnly = trimmed === String(number) || /^0*\d+$/.test(trimmed);
    if (trimmed && !numericOnly) return trimmed;
    return number === 0 ? specials : numbered(number);
}

export function seasonYear(season: JsonRecord): string {
    const guarded = idText(season.jeYear);
    if (guarded) return guarded;
    const date = str(season.airDate);
    return date && isIsoDate(date) ? date.slice(0, 4) : '';
}

/** The strongest status each season reached, across requests and the media record. */
export function mergeSeasonStatuses(requests: readonly unknown[], tmdbId: unknown, mediaSeasons: unknown): Map<number, number | undefined> {
    const statuses = new Map<number, number | undefined>();
    const note = (season: JsonRecord) => {
        const number = num(season.seasonNumber);
        if (number === undefined) return;
        const status = num(season.status);
        const previous = statuses.get(number);
        if (!previous || (status !== undefined && status > previous)) statuses.set(number, status);
    };
    for (const request of records(requests)) {
        const media = record(request.media);
        if (request.type !== 'tv' || !media || String(media.tmdbId) !== String(tmdbId)) continue;
        records(request.seasons).forEach(note);
    }
    records(mediaSeasons).forEach(note);
    return statuses;
}

/** The numbered seasons with episodes: only those can be requested. */
export function requestableSeasons(details: JsonRecord): number[] {
    const numbers: number[] = [];
    for (const season of records(details.seasons)) {
        const number = num(season.seasonNumber);
        if (number !== undefined && number > 0 && (num(season.episodeCount) ?? 0) > 0) numbers.push(number);
    }
    return numbers;
}

/** Jellyfin's seasons of a series by number; the numberless and specials are left out. */
export function jellyfinSeasonMap(reply: unknown): Record<number, { id: string; name: string | null }> {
    const map: Record<number, { id: string; name: string | null }> = {};
    for (const season of records(record(reply)?.Items)) {
        const number = Number(season.IndexNumber);
        const id = filled(season.Id);
        if (id && Number.isFinite(number) && number > 0) map[number] = { id, name: filled(season.Name) };
    }
    return map;
}

/** Which seasons exist in the library, specials included. */
export function seasonPresence(reply: unknown): Record<number, boolean> {
    const presence: Record<number, boolean> = {};
    for (const season of list(record(reply)?.Items)) {
        const number = Number(record(season)?.IndexNumber);
        if (Number.isFinite(number) && number >= 0) presence[number] = true;
    }
    return presence;
}
