import type {
    AdvancedRequestData, AdvancedServer, IssuePage, MovieCollection, OverrideRule, QualityProfile, QuotaSide,
    RelatedPage, RequestSettings, RootFolder, SearchPage, SeerrCollectionRef, SeerrDownload, SeerrIssue,
    SeerrMediaInfo, SeerrMediaItem, SeerrRequestSummary, SeerrSeasonStatus, SonarrCandidate, TvDetailsView,
    TvSeason, UserQuota, UserStatus
} from './types';

/**
 * Runtime boundary for every Seerr/TMDB proxy response. Guards check the
 * fields this feature consumes and return the same object, so cached results
 * keep their identity. A guard's check table is keyed by every field of its
 * interface, so a new field cannot be added to the type without a check.
 */
export type Check = (value: unknown) => boolean;
type Checks<T> = { readonly [K in keyof Required<T>]: Check };

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const isString = (value: unknown): value is string => typeof value === 'string';
/** A leading-slash TMDB file name of a known image type, safe in an image URL and a CSS url(). */
export const isSafeTmdbImagePath = (path: unknown): path is string =>
    typeof path === 'string' && /^\/[A-Za-z0-9_\-.]+\.(jpg|jpeg|png|webp|avif)$/i.test(path);
export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const optional = (check: Check): Check => value => value === undefined || check(value);
const nullable = (check: Check): Check => value => value === undefined || value === null || check(value);
const listOf = (check: Check): Check => value => Array.isArray(value) && value.every(check);
const either = (...checks: Check[]): Check => value => checks.some(check => check(value));

function matches<T>(value: unknown, checks: Checks<T>): value is T & Record<string, unknown> {
    if (!isRecord(value)) return false;
    const table: Readonly<Record<string, Check>> = checks;
    for (const [key, check] of Object.entries(table)) {
        if (!check(value[key])) return false;
    }
    return true;
}

const seasonStatusChecks: Checks<SeerrSeasonStatus> = {
    seasonNumber: optional(isNumber), status: nullable(isNumber), status4k: nullable(isNumber)
};
const isSeasonStatus = (value: unknown): value is SeerrSeasonStatus => matches<SeerrSeasonStatus>(value, seasonStatusChecks);
const downloadChecks: Checks<SeerrDownload> = {
    title: nullable(isString), status: nullable(isString), size: nullable(isNumber), sizeLeft: nullable(isNumber),
    estimatedCompletionTime: nullable(isString),
    episode: nullable(value => matches<{ seasonNumber?: number | null }>(value, { seasonNumber: nullable(isNumber) }))
};
const isDownload = (value: unknown): value is SeerrDownload => matches<SeerrDownload>(value, downloadChecks);
const requestSummaryChecks: Checks<SeerrRequestSummary> = {
    is4k: nullable(isBoolean),
    seasons: nullable(listOf(value => matches<{ seasonNumber?: number; status?: number | null }>(value, {
        seasonNumber: optional(isNumber), status: nullable(isNumber)
    })))
};
const mediaInfoChecks: Checks<SeerrMediaInfo> = {
    id: nullable(isNumber), tvdbId: nullable(isNumber), status: nullable(isNumber), status4k: nullable(isNumber),
    jellyfinMediaId: nullable(isString), jellyfinMediaId4k: nullable(isString),
    seasons: nullable(listOf(isSeasonStatus)), downloadStatus: nullable(listOf(isDownload)),
    downloadStatus4k: nullable(listOf(isDownload)),
    requests: nullable(listOf(value => matches<SeerrRequestSummary>(value, requestSummaryChecks)))
};
export const isMediaInfo = (value: unknown): value is SeerrMediaInfo => matches<SeerrMediaInfo>(value, mediaInfoChecks);
const collectionChecks: Checks<SeerrCollectionRef> = {
    id: nullable(isNumber), name: nullable(isString), posterPath: nullable(isString), backdropPath: nullable(isString)
};
export const isCollectionRef = (value: unknown): value is SeerrCollectionRef => matches<SeerrCollectionRef>(value, collectionChecks);
const mediaItemChecks: Checks<SeerrMediaItem> = {
    id: isNumber, mediaType: isString, title: nullable(isString), name: nullable(isString),
    originalTitle: nullable(isString), originalName: nullable(isString), posterPath: nullable(isString),
    backdropPath: nullable(isString), overview: nullable(isString), voteAverage: nullable(isNumber),
    releaseDate: nullable(isString), firstAirDate: nullable(isString), mediaInfo: nullable(isMediaInfo),
    collection: nullable(isCollectionRef)
};
/** A result whose consumed fields are well-formed; the object itself is returned unchanged. */
export const isMediaItem = (value: unknown): value is SeerrMediaItem => matches<SeerrMediaItem>(value, mediaItemChecks);

/** Keeps well-formed results (identity preserved); malformed ones are counted, not rendered. */
export function mediaItems(value: unknown): { items: SeerrMediaItem[]; dropped: number } {
    if (!Array.isArray(value)) return { items: [], dropped: 0 };
    const items: SeerrMediaItem[] = [];
    let dropped = 0;
    for (const entry of value) {
        if (isMediaItem(entry)) items.push(entry); else dropped++;
    }
    return { items, dropped };
}

export class SeerrDecodeError extends Error {
    override readonly name = 'SeerrDecodeError';
    constructor(what: string) { super(`Seerr response did not match the expected ${what}`); }
}

/** A search response: people are left out, malformed results are dropped. */
export function decodeSearchPage(value: unknown): SearchPage {
    if (!isRecord(value)) throw new SeerrDecodeError('search page');
    if (value.results !== undefined && !Array.isArray(value.results)) throw new SeerrDecodeError('search results');
    const raw: unknown[] = Array.isArray(value.results) ? value.results : [];
    const { items } = mediaItems(raw.filter(entry => !(isRecord(entry) && entry.mediaType === 'person')));
    const page: SearchPage = { totalResults: items.length, results: items };
    if (isNumber(value.page)) page.page = value.page;
    if (isNumber(value.totalPages)) page.totalPages = value.totalPages;
    return page;
}
export function decodeRelatedPage(value: unknown): RelatedPage {
    if (!isRecord(value)) throw new SeerrDecodeError('related page');
    const { items } = mediaItems(value.results);
    return {
        page: isNumber(value.page) ? value.page : 1,
        totalPages: isNumber(value.totalPages) ? value.totalPages : 0,
        totalResults: isNumber(value.totalResults) ? value.totalResults : items.length,
        results: items
    };
}

const userStatusChecks: Checks<UserStatus> = {
    active: isBoolean, userFound: isBoolean, reason: optional(isString), message: optional(isString),
    jellyseerrUserId: optional(either(isString, isNumber)), canRequestAdvanced: optional(isBoolean)
};
export const isUserStatus = (value: unknown): value is UserStatus => matches<UserStatus>(value, userStatusChecks);

const quotaSideChecks: Checks<QuotaSide> = {
    limit: nullable(isNumber), used: nullable(isNumber), remaining: nullable(isNumber), days: nullable(isNumber),
    restricted: nullable(isBoolean), nextResetAt: nullable(isString)
};
const quotaChecks: Checks<UserQuota> = {
    movie: nullable(value => matches<QuotaSide>(value, quotaSideChecks)),
    tv: nullable(value => matches<QuotaSide>(value, quotaSideChecks))
};
export const isUserQuota = (value: unknown): value is UserQuota => matches<UserQuota>(value, quotaChecks);

export function decodeRequestSettings(value: unknown): RequestSettings {
    if (!isRecord(value)) throw new SeerrDecodeError('request settings');
    return { partialRequestsEnabled: value.partialRequestsEnabled === true, enableSpecialEpisodes: value.enableSpecialEpisodes === true };
}

const overrideRuleChecks: Checks<OverrideRule> = {
    id: nullable(either(isNumber, isString)), radarrServiceId: nullable(isNumber), sonarrServiceId: nullable(isNumber),
    language: nullable(isString), genre: nullable(isString), keywords: nullable(isString), users: nullable(isString),
    profileId: nullable(isNumber), rootFolder: nullable(isString),
    tags: nullable(either(listOf(either(isNumber, isString)), isNumber, isString))
};
/** Rules with a malformed consumed field are left out rather than half-applied. */
export function decodeOverrideRules(value: unknown): OverrideRule[] {
    if (!Array.isArray(value)) return [];
    return value.filter((rule): rule is OverrideRule => matches<OverrideRule>(rule, overrideRuleChecks));
}

const profileChecks: Checks<QualityProfile> = { id: isNumber, name: nullable(isString) };
const folderChecks: Checks<RootFolder> = { path: isString, freeSpace: nullable(isNumber) };
export function decodeProfiles(value: unknown): QualityProfile[] {
    return Array.isArray(value) ? value.filter((entry): entry is QualityProfile => matches<QualityProfile>(entry, profileChecks)) : [];
}
export function decodeFolders(value: unknown): RootFolder[] {
    return Array.isArray(value) ? value.filter((entry): entry is RootFolder => matches<RootFolder>(entry, folderChecks)) : [];
}
interface ServiceListing { id: number; name?: string | null; isDefault?: boolean | null; is4k?: boolean | null; activeProfileId?: number | null; activeDirectory?: string | null }
const serviceChecks: Checks<ServiceListing> = {
    id: isNumber, name: nullable(isString), isDefault: nullable(isBoolean), is4k: nullable(isBoolean),
    activeProfileId: nullable(isNumber), activeDirectory: nullable(isString)
};
export const isServiceListing = (value: unknown): value is ServiceListing & Record<string, unknown> => matches<ServiceListing>(value, serviceChecks);
/** Advanced-options data handed to the modal from any caller; malformed servers are omitted. */
export function decodeAdvancedData(value: unknown): AdvancedRequestData {
    if (!isRecord(value) || !Array.isArray(value.servers)) return { servers: [], tags: [] };
    const servers: AdvancedServer[] = [];
    for (const entry of value.servers) {
        if (!isServiceListing(entry)) continue;
        servers.push({ ...entry, qualityProfiles: decodeProfiles(entry.qualityProfiles), rootFolders: decodeFolders(entry.rootFolders) });
    }
    return { servers, tags: Array.isArray(value.tags) ? value.tags.filter(isNumber) : [] };
}

const candidateChecks: Checks<SonarrCandidate> = {
    tvdbId: isNumber, title: nullable(isString), year: nullable(either(isNumber, isString)),
    overview: nullable(isString), remotePoster: nullable(isString)
};
export function decodeSonarrCandidates(value: unknown): SonarrCandidate[] {
    return Array.isArray(value) ? value.filter((entry): entry is SonarrCandidate => matches<SonarrCandidate>(entry, candidateChecks)) : [];
}

const movieCollectionChecks: Checks<MovieCollection> = {
    id: isNumber, name: nullable(isString), posterPath: nullable(isString), backdropPath: nullable(isString)
};
export const isMovieCollection = (value: unknown): value is MovieCollection => matches<MovieCollection>(value, movieCollectionChecks);

const issueChecks: Checks<SeerrIssue> = {
    id: nullable(isNumber),
    media: nullable(value => matches<{ tmdbId?: unknown; mediaType?: unknown }>(value, {
        tmdbId: nullable(either(isNumber, isString)), mediaType: nullable(isString)
    }))
};
export function decodeIssuePage(value: unknown): IssuePage & Record<string, unknown> {
    if (!isRecord(value)) return { results: [] };
    const results = Array.isArray(value.results)
        ? value.results.filter((issue): issue is SeerrIssue => matches<SeerrIssue>(issue, issueChecks))
        : [];
    return { ...value, results };
}

const tvSeasonChecks: Checks<TvSeason> = {
    seasonNumber: isNumber, name: nullable(isString), episodeCount: nullable(isNumber),
    airDate: nullable(isString), jeYear: nullable(isString)
};
const isTvSeason = (value: unknown): value is TvSeason => matches<TvSeason>(value, tvSeasonChecks);
/** The fields the season-selection modal reads from a TV details document. */
export function decodeTvDetails(value: unknown): TvDetailsView | null {
    if (!isRecord(value) || !Array.isArray(value.seasons)) return null;
    const externalIds = value.externalIds;
    const externalTvdbId = isRecord(externalIds) && isNumber(externalIds.tvdbId) && externalIds.tvdbId > 0 ? externalIds.tvdbId : null;
    const view: TvDetailsView = {
        seasons: value.seasons.filter(isTvSeason),
        externalTvdbId,
        mediaInfo: isMediaInfo(value.mediaInfo) ? value.mediaInfo : null
    };
    if (isString(value.name)) view.name = value.name;
    if (isString(value.title)) view.title = value.title;
    if (isString(value.backdropPath)) view.backdropPath = value.backdropPath;
    if (value.jeSpoilerGuard === true) view.jeSpoilerGuard = true;
    return view;
}

/** Seerr-or-TMDB "belongs to collection" shapes (snake and camel case). */
export function decodeBelongsToCollection(value: unknown): MovieCollection | null {
    if (!isRecord(value)) return null;
    const belongs = isRecord(value.belongs_to_collection) ? value.belongs_to_collection
        : isRecord(value.belongsToCollection) ? value.belongsToCollection : null;
    if (!belongs) return null;
    const id = isNumber(belongs.id) && belongs.id ? belongs.id : isNumber(belongs.tmdbId) && belongs.tmdbId ? belongs.tmdbId : null;
    if (id === null) return null;
    const pick = (a: unknown, b: unknown): string | null => isString(a) && a ? a : isString(b) && b ? b : null;
    return {
        id,
        name: isString(belongs.name) ? belongs.name : null,
        posterPath: pick(belongs.poster_path, belongs.posterPath),
        backdropPath: pick(belongs.backdrop_path, belongs.backdropPath)
    };
}

/** Parses a JSON copy of a result kept on a DOM attribute; null when absent or malformed. */
export function parseItemAttribute(raw: string | undefined): SeerrMediaItem | null {
    if (!raw) return null;
    try {
        const value: unknown = JSON.parse(raw);
        return isMediaItem(value) ? value : null;
    } catch {
        return null;
    }
}

export interface CollectionPart {
    id: number;
    title?: string | null;
    posterPath?: string | null;
    releaseDate?: string | null;
    mediaInfo?: SeerrMediaInfo | null;
}
const collectionPartChecks: Checks<CollectionPart> = {
    id: isNumber, title: nullable(isString), posterPath: nullable(isString), releaseDate: nullable(isString), mediaInfo: nullable(isMediaInfo)
};
/** A collection's movies (a details document's `parts`); malformed entries are left out. */
export function decodeCollectionParts(details: unknown): CollectionPart[] {
    if (!isRecord(details) || !Array.isArray(details.parts)) return [];
    return details.parts.filter((part): part is CollectionPart => matches<CollectionPart>(part, collectionPartChecks));
}
