// What the badge rules read about an item, from a server tag-cache entry or a /tag-data item. No browser state.
import { isRecord, record, records, text, type JsonRecord } from '../../pipeline/dto';

/** The stream and version fields a direct-play answer depends on (tag-direct-play INPUTS). */
export interface MediaInputs { source: readonly string[]; stream: readonly string[] }
/** The largest distance from 1970 a Date holds (ms). */
const MAX_DATE_MS = 8.64e15;

export interface LatestIndex { s: number; e: number; isLast: boolean }
export interface SeasonPremiere { s: number; aired: number }
export interface AddedSpan { first: number; last: number; count: number; coveredThrough: number | null }
export interface LeavingFacts { deleteAt: number | null }
/** The episode-derived facts server entries and /tag-data items share. */
export interface EpisodeFacts {
    scenes: JsonRecord | null;
    /** Series: Jellyfin status (Continuing/Ended/Unreleased). */
    status: string | null;
    /** Series/Season: newest episode air date (ms). */
    latestAired: number | null;
    /** Whether this is the last locally available episode in its season. */
    isLast: boolean | null;
    /** The newest episode's season and episode numbers. */
    latestIndex: LatestIndex | null;
    /** Series: newest season; Season: itself. */
    seasonPremiere: SeasonPremiere | null;
    /** Season: episode added dates and the highest N with every episode 1..N in the library. */
    addedSpan: AddedSpan | null;
}
export interface StatusData extends EpisodeFacts {
    /** Original /tag-data fetch time, retained by cached snapshots. */
    fetchedAt?: number;
    type: string | null;
    /** The item's TMDB id (trending). */
    tmdb: string | null;
    created: number | null;
    /** PremiereDate (ms; Movie/Series/Episode). */
    premiere: number | null;
    /** Series/Season: newest episode DateCreated (ms). */
    latest: number | null;
    season: number | null;
    episode: number | null;
    /** The last episode a combined file covers (S01E09-E10 → 10), else null. */
    episodeEnd: number | null;
    /** A fingerprint of the item's versions and streams (direct-play answers follow it). */
    media?: string;
    /** The item's version ids, first one first. */
    versions?: string[];
    /** The series whose TMDB schedule applies (Series: itself). */
    seriesId: string | null;
    /** That series' TMDB id; undefined when unknown. */
    seriesTmdb: string | null | undefined;
    leaving?: LeavingFacts | null;
    /** Whether its first media source lists a video stream; null when the data doesn't say. */
    probed?: boolean | null;
    /** Whether its file (or one of its sources) is a .strm, which Jellyfin probes on every playback lookup. */
    strm?: boolean;
}

/**
 * Leaving soon facts from a cache entry or /tag-data item, or null.
 * @param raw - { DeleteAt } (Unix ms or null).
 * */
export function readLeaving(raw: unknown): LeavingFacts | null {
    if (!isRecord(raw)) return null;
    const deleteAt = toMs(raw.DeleteAt ?? raw.deleteAt ?? null);
    // A time no Date can hold reads as undated (the server bounds what it stores).
    return { deleteAt: deleteAt !== null && Math.abs(deleteAt) <= MAX_DATE_MS ? deleteAt : null };
}

/**
 * A date as Unix ms: the server sends numbers, a raw BaseItemDto ISO strings.
 * */
export function toMs(value: unknown): number|null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A whole number, or null.
 * */
export function toInt(value: unknown): number|null {
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * An item id in one form (lowercase, no dashes), so ids from cards, cache
 * entries and server answers compare equal.
 * */
export function normId(id: unknown): string|null {
    if (id === null || id === undefined || id === '') return null;
    return String(id).replace(/-/g, '').toLowerCase();
}

/**
 * Read the episode-derived facts shared by server entries and /tag-data items.
 * @param src - TagCacheEntry or /tag-data item (PascalCase).
 * */
export function readFacts(src: JsonRecord): EpisodeFacts {
    const index = record(src.LatestEpisodeIndex);
    const premiere = record(src.SeasonPremiere);
    const span = record(src.SeasonAddedSpan);
    const season = toInt(index.Season);
    const episode = toInt(index.Episode);
    const premiereSeason = toInt(premiere.Season);
    const aired = toMs(premiere.Aired);
    const first = toMs(span.First);
    const last = toMs(span.Last);
    const count = toInt(span.Count);
    const isLast = record(src.EpisodeIndex).IsLast;
    return {
        scenes: isRecord(src.Scenes) ? src.Scenes : null,
        status: typeof src.Status === 'string' && src.Status ? src.Status : null,
        latestAired: toMs(src.LatestEpisodeAired),
        isLast: typeof isLast === 'boolean' ? isLast : null,
        latestIndex: season !== null && episode !== null
            ? { s: season, e: episode, isLast: index.IsLast === true } : null,
        seasonPremiere: premiereSeason !== null && aired !== null
            ? { s: premiereSeason, aired } : null,
        addedSpan: first !== null && last !== null && count !== null
            ? { first, last, count, coveredThrough: toInt(span.CoveredThrough) } : null,
    };
}

/**
 * The fields the badge rules read, from a server tag cache entry.
 * @param entry - TagCacheEntry.
 * @param [itemId] - The entry's item id (a Series is its own series).
 * */
export function fromServerEntry(entry: JsonRecord, itemId: string | null | undefined, inputs: MediaInputs): StatusData {
    const type = text(entry.Type);
    const tmdb = entry.TmdbId ? String(entry.TmdbId) : null;
    const index = record(entry.EpisodeIndex);
    const stream = record(entry.StreamData);
    return {
        type,
        tmdb,
        created: toMs(entry.DateCreated),
        premiere: toMs(entry.PremiereDate),
        latest: toMs(entry.LatestEpisodeAdded),
        ...readFacts(entry),
        season: toInt(index.Season ?? entry.SeasonNumber),
        episode: type === 'Episode' ? toInt(index.Episode ?? entry.EpisodeNumber) : null,
        episodeEnd: type === 'Episode' ? toInt(index.EpisodeEnd) : null,
        seriesId: type === 'Series' ? normId(itemId) : normId(entry.SeriesId),
        // The cache records the series' TMDB id on its seasons and episodes,
        // so a missing one means the series has none.
        seriesTmdb: type === 'Series' ? tmdb : (entry.SeriesTmdbId ? String(entry.SeriesTmdbId) : null),
        leaving: readLeaving(entry.Leaving),
        probed: probedOf(stream.Streams, stream.Sources),
        media: mediaKeyOf(stream.Streams, stream.Sources, inputs),
        versions: versionIds(stream.Sources),
        // The cache keeps the file name in ItemPath only when no source names it.
        strm: isStrm([stream.ItemPath, ...sourcePaths(stream.Sources)]),
    };
}

/**
 * The fields the badge rules read, from a /tag-data item (or a raw
 * BaseItemDto on the per-item fallback).
 * */
export function fromItem(item: JsonRecord, inputs: MediaInputs): StatusData {
    const type = text(item.Type);
    const index = record(item.EpisodeIndex);
    // A Spoiler Guard strip stub has no ProviderIds, only the bare TmdbId.
    const tmdbRaw = record(item.ProviderIds).Tmdb || item.TmdbId;
    const tmdb = tmdbRaw ? String(tmdbRaw) : null;
    return {
        type,
        tmdb,
        created: toMs(item.DateCreated),
        premiere: toMs(item.PremiereDate),
        latest: toMs(item.LatestEpisodeAdded),
        ...readFacts(item),
        season: type === 'Episode' ? toInt(index.Season ?? item.ParentIndexNumber) : type === 'Season' ? toInt(item.IndexNumber) : null,
        episode: type === 'Episode' ? toInt(index.Episode ?? item.IndexNumber) : null,
        episodeEnd: type === 'Episode' ? toInt(index.EpisodeEnd ?? item.IndexNumberEnd) : null,
        seriesId: type === 'Series' ? normId(item.Id) : normId(item.SeriesId),
        // A season/episode item does not say whether its series has a TMDB
        // id; the server answers only for those that do.
        seriesTmdb: type === 'Series' ? tmdb : undefined,
        leaving: readLeaving(item.Leaving),
        probed: probedOf(item.MediaStreams, item.MediaSources),
        media: mediaKeyOf(item.MediaStreams, item.MediaSources, inputs),
        versions: versionIds(item.MediaSources),
        strm: isStrm([item.Path, ...sourcePaths(item.MediaSources)]),
    };
}

/**
 * Whether a video item's media was probed as Jellyfin's PlaybackInfo
 * checks it: its first media source lists a video stream (streams are
 * matched to it by SourceId when they carry one). Jellyfin probes the
 * item otherwise, so the direct-play lookup skips it.
 * @param streams - The item's streams (cache entry StreamData.Streams or /tag-data MediaStreams).
 * @param [sources] - Its media sources, first one first (StreamData.Sources or /tag-data MediaSources).
 * @returns null when the data has no stream list (stripped or not sent).
 */
export function probedOf(streams: unknown, sources?: unknown): boolean|null {
    if (!Array.isArray(streams)) return null;
    const first = Array.isArray(sources) ? record(sources[0]).Id : null;
    const all = records(streams);
    const ofFirst = first && all.some((stream) => stream.SourceId) ? all.filter((stream) => stream.SourceId === first) : all;
    return ofFirst.some((stream) => stream.Type === 'Video');
}

/**
 * A short fingerprint of what a direct-play verdict depends on. The server gives each version a
 * Revision over every stream fact a device profile condition can read (bitrates, bit depth, level,
 * scan type, frame rate, codec tag, anamorphic, reference frames, rotation, Dolby Vision facts…);
 * without one, the version ids and paths and the same facts of the streams at hand.
 * A replaced or re-encoded file changes it, so an old verdict is never shown for new media; score
 * or review changes do not.
 * */
export function mediaKeyOf(streams: unknown, sources: unknown, inputs: MediaInputs): string {
    const parts: string[] = [];
    // Null members stay in: this hash keys stored verdicts, and each one is a part of it.
    const list: JsonRecord[] = (Array.isArray(sources) ? sources : []).map(record);
    const revised = list.length > 0 && list.every(source => typeof source.Revision === 'string' && source.Revision);
    for (const source of list) {
        parts.push(revised ? `${String(source.Id || '')}:${String(source.Path || '')}:${String(source.Revision)}` : inputs.source.map(field => source[field] ?? '').join(','));
    }
    for (const stream of revised || !Array.isArray(streams) ? [] : streams.map(record)) {
        parts.push([stream.SourceId, ...inputs.stream.map(field => stream[field])].map(v => v ?? '').join(','));
    }
    let hash = 0x811c9dc5;
    for (const char of parts.join('|')) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
    return hash.toString(36);
}

/**
 * @returns The item's version ids, first one first.
 */
export function versionIds(sources: unknown): string[] {
    return records(sources).map((source) => source.Id).filter((id): id is string => typeof id === 'string' && !!id);
}

/**
 * @returns The sources' file names (unknown entries included as undefined).
 */
export function sourcePaths(sources: unknown): Array<unknown> {
    return Array.isArray(sources) ? sources.map((source: unknown) => record(source).Path) : [];
}

/**
 * Whether any of the given file names is a .strm (Jellyfin compares
 * without case).
 * */
export function isStrm(paths: Array<unknown>): boolean {
    return paths.some((path) => typeof path === 'string' && path.toLowerCase().endsWith('.strm'));
}

