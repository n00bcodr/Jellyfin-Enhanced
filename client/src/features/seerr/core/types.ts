/**
 * Seerr domain values as this feature consumes them. Network data enters as
 * `unknown` and only becomes one of these types through the guards in
 * decode.ts. Fields are the consumed ones; a result object can carry more
 * (other features read them), which the guards leave untouched so cached
 * results keep their identity (a request updates the cached result itself).
 */
export type MediaType = 'movie' | 'tv';

export interface SeerrSeasonStatus {
    seasonNumber?: number;
    status?: number | null;
    status4k?: number | null;
}
export interface SeerrDownload {
    title?: string | null;
    status?: string | null;
    size?: number | null;
    sizeLeft?: number | null;
    estimatedCompletionTime?: string | null;
    episode?: { seasonNumber?: number | null } | null;
}
export interface SeerrSeasonRequest { seasonNumber?: number; status?: number | null }
export interface SeerrRequestSummary { is4k?: boolean | null; seasons?: SeerrSeasonRequest[] | null }
export interface SeerrMediaInfo {
    id?: number | null;
    tvdbId?: number | null;
    status?: number | null;
    status4k?: number | null;
    jellyfinMediaId?: string | null;
    jellyfinMediaId4k?: string | null;
    seasons?: SeerrSeasonStatus[] | null;
    downloadStatus?: SeerrDownload[] | null;
    downloadStatus4k?: SeerrDownload[] | null;
    requests?: SeerrRequestSummary[] | null;
}
/** A movie's collection; the badge needs only its name, the collection card and modal its id. */
export interface SeerrCollectionRef {
    id?: number | null;
    name?: string | null;
    posterPath?: string | null;
    backdropPath?: string | null;
}
/** A search/discovery result, or a synthetic collection card. */
export interface SeerrMediaItem {
    id: number;
    mediaType: string;
    title?: string | null;
    name?: string | null;
    originalTitle?: string | null;
    originalName?: string | null;
    posterPath?: string | null;
    backdropPath?: string | null;
    overview?: string | null;
    voteAverage?: number | null;
    releaseDate?: string | null;
    firstAirDate?: string | null;
    mediaInfo?: SeerrMediaInfo | null;
    collection?: SeerrCollectionRef | null;
}
export interface SearchPage {
    page?: number;
    totalPages?: number;
    totalResults: number;
    results: SeerrMediaItem[];
}
export interface RelatedPage {
    page: number;
    totalPages: number;
    totalResults: number;
    results: SeerrMediaItem[];
}
export interface UserStatus {
    active: boolean;
    userFound: boolean;
    reason?: string;
    message?: string;
    jellyseerrUserId?: string | number;
    canRequestAdvanced?: boolean;
}
export interface QuotaSide {
    limit?: number | null;
    used?: number | null;
    remaining?: number | null;
    days?: number | null;
    restricted?: boolean | null;
    nextResetAt?: string | null;
}
export interface UserQuota { movie?: QuotaSide | null; tv?: QuotaSide | null }
export interface RequestSettings { partialRequestsEnabled: boolean; enableSpecialEpisodes: boolean }
export interface OverrideRule {
    id?: number | string | null;
    radarrServiceId?: number | null;
    sonarrServiceId?: number | null;
    language?: string | null;
    genre?: string | null;
    keywords?: string | null;
    users?: string | null;
    profileId?: number | null;
    rootFolder?: string | null;
    tags?: (number | string)[] | number | string | null;
}
/** Explicit settings a request carries; empty means "let override rules decide". */
export interface RequestSettingsOverride {
    serverId?: number;
    profileId?: number;
    rootFolder?: string;
    tags?: number[];
}
export interface QualityProfile { id: number; name?: string | null }
export interface RootFolder { path: string; freeSpace?: number | null }
export interface AdvancedServer {
    id: number;
    name?: string | null;
    isDefault?: boolean | null;
    is4k?: boolean | null;
    activeProfileId?: number | null;
    activeDirectory?: string | null;
    qualityProfiles: QualityProfile[];
    rootFolders: RootFolder[];
}
export interface AdvancedRequestData { servers: AdvancedServer[]; tags: number[] }
export interface SonarrCandidate {
    tvdbId: number;
    title?: string | null;
    year?: number | string | null;
    overview?: string | null;
    remotePoster?: string | null;
}
export interface MovieCollection {
    id: number;
    name?: string | null;
    posterPath?: string | null;
    backdropPath?: string | null;
}
export interface IssueMedia { tmdbId?: number | string | null; mediaType?: string | null }
export interface SeerrIssue { id?: number | null; media?: IssueMedia | null }
export interface IssuePage { pageInfo?: unknown; results: SeerrIssue[] }
/** A Seerr details document. Its consumers decode the parts they read. */
export type SeerrDetails = object;

/** The season-selection view of a TV details document. */
export interface TvSeason {
    seasonNumber: number;
    name?: string | null;
    episodeCount?: number | null;
    airDate?: string | null;
    jeYear?: string | null;
}
export interface TvDetailsView {
    seasons: TvSeason[];
    name?: string | null;
    title?: string | null;
    backdropPath?: string | null;
    jeSpoilerGuard?: boolean | null;
    externalTvdbId: number | null;
    mediaInfo: SeerrMediaInfo | null;
}
