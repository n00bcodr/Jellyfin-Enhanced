import type { SeerrCoreHost, SeerrFetchOptions } from '../host-core';
import type { FollowUpOptions, PageOrOptions, ReadOptions, SeerrApiFacade } from './contract';
import {
    SeerrDecodeError, decodeAdvancedData, decodeBelongsToCollection, decodeFolders, decodeIssuePage, decodeOverrideRules,
    decodeProfiles, decodeRelatedPage, decodeRequestSettings, decodeSearchPage, decodeSonarrCandidates, isCollectionRef,
    isMovieCollection, isNumber, isRecord, isServiceListing, isString, isUserQuota, isUserStatus
} from './decode';
import { matchOverrideRule, ruleMedia } from './override-rules';
import {
    RequestNotSentError, captureOrigin, classifyFailure, errorBody, errorStatus, escapeWith, firstInstall, isAbortError, recordOutcome
} from './runtime';
import type {
    AdvancedServer, MovieCollection, OverrideRule, RelatedPage, RequestSettings, RequestSettingsOverride,
    SeerrDetails, SeerrMediaItem, UserStatus
} from './types';

const LOG = '🪼 Jellyfin Enhanced: Seerr API:';
// Success is sticky for the SPA session; a negative answer expires so a transient outage recovers.
const NEGATIVE_USER_STATUS_TTL_MS = 60 * 1000;
const OVERRIDE_RULES_TTL_MS = 5 * 60 * 1000;
const MOVIE_COLLECTIONS_TTL_MS = 30 * 60 * 1000;
const MOVIE_COLLECTIONS_MAX_ENTRIES = 1000;
// The server answers up to 100 ids; 40 keep the query string inside strict proxy limits.
const MOVIE_COLLECTIONS_IDS_PER_REQUEST = 40;
const BANNER_REASONS: Readonly<Record<string, string>> = {
    blocked: 'Your administrator has disabled Seerr for your account.',
    unlinked: 'Your Seerr account isn\'t linked yet. Sign in to Seerr once to enable requests.',
    unreachable: 'Can\'t reach Seerr right now. Please try again in a moment.',
    no_user: 'Couldn\'t load your account. Try signing out and back in.'
};
/** Body keys a caller may set beside mediaType/mediaId/seasons/tvdbId; anything else is not forwarded. */
const SETTING_KEYS = ['serverId', 'profileId', 'rootFolder', 'languageProfileId', 'tags', 'is4k'] as const;
type ForwardedSettings = RequestSettingsOverride & { languageProfileId?: number; is4k?: boolean };

const segment = (value: number | string): string => encodeURIComponent(String(value));
function readOptions(options: ReadOptions | undefined): SeerrFetchOptions {
    const out: SeerrFetchOptions = {};
    if (!options) return out;
    if (options.signal) out.signal = options.signal;
    if (options.skipCache) out.skipCache = true;
    if (options.skipRetry) out.skipRetry = true;
    if (options.headers) out.headers = options.headers;
    return out;
}
/** Keeps the well-typed settings a caller supplied (modals, override rules, More Info). */
function forwardedSettings(value: object): ForwardedSettings {
    const out: ForwardedSettings = {};
    for (const key of SETTING_KEYS) {
        const entry: unknown = Reflect.get(value, key);
        if (key === 'rootFolder') { if (isString(entry)) out.rootFolder = entry; }
        else if (key === 'is4k') { if (typeof entry === 'boolean') out.is4k = entry; }
        else if (key === 'tags') { if (Array.isArray(entry)) out.tags = entry.filter(isNumber); }
        else if (isNumber(entry)) out[key] = entry;
    }
    return out;
}
function positiveInteger(value: unknown): number | null {
    const number = isNumber(value) ? value : isString(value) ? parseInt(value, 10) : NaN;
    return Number.isInteger(number) && number > 0 ? number : null;
}

export function installApi(host: SeerrCoreHost): void {
    const { JE } = host;
    if (!firstInstall(JE, 'api')) return;
    const escapeHtml = escapeWith(JE);

    let cachedUserStatus: UserStatus | null = null;
    let cachedUserStatusAt = 0;
    let cachedOverrideRules: OverrideRule[] | null = null;
    let overrideRulesCachedAt = 0;
    let lastRequestSettings: RequestSettings | null = null;
    const movieCollections = new Map<number, { collection: MovieCollection | null; at: number }>();

    const coreApi = () => {
        const api = JE.core?.api;
        if (!api) throw new Error('Seerr API used before the core API client');
        return api;
    };
    const url = (path: string): string => {
        const client = host.apiClient();
        if (!client) throw new Error('Jellyfin ApiClient is unavailable');
        return client.getUrl(path);
    };
    function get(path: string, options: SeerrFetchOptions = {}): Promise<unknown> {
        const fetchOptions: SeerrFetchOptions = { ...options };
        if (!options.skipCache) fetchOptions.cacheKey = `jellyseerr:${path}`;
        return coreApi().fetch(url(`/JellyfinEnhanced/jellyseerr${path}`), fetchOptions);
    }
    function tmdbGet(path: string, options: SeerrFetchOptions = {}): Promise<unknown> {
        const fetchOptions: SeerrFetchOptions = { ...options };
        if (!options.skipCache) fetchOptions.cacheKey = `tmdb:${path}`;
        return coreApi().fetch(url(`/JellyfinEnhanced/tmdb${path}`), fetchOptions);
    }
    /** POSTs are not idempotent: one attempt, never retried automatically. */
    function post(path: string, body: object): Promise<unknown> {
        return coreApi().plugin(`/jellyseerr${path}`, { method: 'POST', body, skipRetry: true });
    }
    const detailsOrNull = (value: unknown): SeerrDetails | null => isRecord(value) ? value : null;

    function recallMovieCollection(tmdbId: number): MovieCollection | null | undefined {
        const entry = movieCollections.get(tmdbId);
        if (!entry) return undefined;
        if (Date.now() - entry.at >= MOVIE_COLLECTIONS_TTL_MS) { movieCollections.delete(tmdbId); return undefined; }
        return entry.collection;
    }
    function rememberMovieCollection(tmdbId: number, collection: MovieCollection | null): void {
        movieCollections.delete(tmdbId);
        if (movieCollections.size >= MOVIE_COLLECTIONS_MAX_ENTRIES) {
            const oldest = movieCollections.keys().next();
            if (!oldest.done) movieCollections.delete(oldest.value);
        }
        movieCollections.set(tmdbId, { collection, at: Date.now() });
    }

    function invalidateRequestCaches(tmdbId: number, mediaType: string): void {
        const manager = JE.requestManager;
        if (!manager?.clearCacheMatching) return;
        const id = String(tmdbId);
        const type = mediaType.toLowerCase();
        if (!id || (type !== 'movie' && type !== 'tv')) return;
        const patterns = [`jellyseerr:/${type}/${id}`, 'jellyseerr:/search?', 'jellyseerr:/discover/',
            'jellyseerr:/request?', 'jellyseerr:/watchlist?', 'jellyseerr:/quota'];
        // Movie requests can affect collection rendering.
        if (type === 'movie') patterns.push(`tmdb:/movie/${id}`);
        for (const pattern of patterns) manager.clearCacheMatching(pattern);
    }
    function emitMediaRequested(tmdbId: number, mediaType: string, is4k: boolean): void {
        const type = mediaType.toLowerCase();
        host.document.dispatchEvent(new CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: String(tmdbId), mediaType: type, is4k } }));
        if (type === 'tv') host.document.dispatchEvent(new CustomEvent('jellyseerr-tv-requested', { detail: { tmdbId: String(tmdbId), mediaType: 'tv' } }));
    }

    /**
     * The one write path for media requests. The originating account/server is
     * captured when the request is initiated; if it changes before the POST is
     * sent nothing is sent, and an answer that arrives after it changed is
     * returned to its caller without updating the new account's surfaces.
     */
    async function submitRequest(tmdbIdValue: number | string, mediaType: string, advancedSettings: object,
        is4k: boolean, mediaData: unknown, extraBody: { seasons: number[] | 'all' } | null, tvdbId: number | null): Promise<unknown> {
        const origin = captureOrigin(host);
        const tmdbId = positiveInteger(tmdbIdValue);
        const outcomeBase = { mediaType, tmdbId: tmdbId ?? 0, is4k };
        if (tmdbId === null || (mediaType !== 'movie' && mediaType !== 'tv')) {
            recordOutcome(JE, { ...outcomeBase, kind: 'not-sent', stale: false });
            throw new RequestNotSentError('invalid-input', `Invalid Seerr request target: ${mediaType} ${String(tmdbIdValue)}`);
        }
        const supplied: object = isRecord(advancedSettings) ? advancedSettings : {};
        let settings: ForwardedSettings = forwardedSettings(supplied);
        // Rules apply only when the caller chose no settings at all (as before).
        if (Object.keys(supplied).length === 0 && mediaData) {
            const override = await api.evaluateOverrideRules(mediaData, mediaType, is4k);
            if (override) {
                console.debug(`${LOG} Applying override rule settings:`, override);
                settings = forwardedSettings(override);
            }
        }
        if (!origin.current()) {
            recordOutcome(JE, { ...outcomeBase, kind: 'not-sent', stale: true });
            throw new RequestNotSentError('identity-changed', 'The signed-in account changed before the request was sent');
        }
        const body: Record<string, unknown> = { mediaType, mediaId: tmdbId };
        if (extraBody && Array.isArray(extraBody.seasons)) Object.assign(body, extraBody, settings);
        else Object.assign(body, settings, extraBody ?? {});
        if (mediaType === 'tv' && tvdbId) body.tvdbId = tvdbId;
        if (is4k) body.is4k = true;

        let result: unknown;
        try {
            result = await post('/request', body);
        } catch (error) {
            const status = errorStatus(error);
            const failure = classifyFailure(error, true);
            recordOutcome(JE, { ...outcomeBase, kind: failure === 'uncertain' ? 'uncertain' : failure === 'not-sent' ? 'not-sent' : 'rejected', stale: !origin.current(),
                ...(status === null ? {} : { status }) });
            throw error;
        }
        const stale = !origin.current();
        recordOutcome(JE, { ...outcomeBase, kind: 'acknowledged', stale });
        if (result) {
            // Acknowledged by the server: nothing below may turn it into a failure.
            try { invalidateRequestCaches(tmdbId, mediaType); } catch (error) { console.warn(`${LOG} Cache invalidation failed:`, error); }
            if (!stale) {
                try { emitMediaRequested(tmdbId, mediaType, is4k); } catch (error) { console.warn(`${LOG} Request event failed:`, error); }
                try { JE.helpers?.trackUsage?.('seerr.request_submitted'); } catch (error) { console.debug(`${LOG} Usage tracking failed:`, error); }
                try { await api.addToWatchlist(tmdbId, mediaType); }
                catch (error) { console.warn(`${LOG} Failed to add to watchlist:`, error); }
            }
        }
        return result;
    }

    async function fetchRelated(mediaType: 'movie' | 'tv', tmdbId: number | string, relation: 'similar' | 'recommendations',
        pageOrOptions: PageOrOptions = 1): Promise<RelatedPage> {
        const page = typeof pageOrOptions === 'number' ? pageOrOptions : (pageOrOptions.page || 1);
        const options = typeof pageOrOptions === 'object' ? readOptions(pageOrOptions) : {};
        try {
            return decodeRelatedPage(await get(`/${mediaType}/${segment(tmdbId)}/${relation}?page=${page}`, options));
        } catch (error) {
            if (isAbortError(error)) throw error;
            console.error(`${LOG} Failed to fetch ${relation} ${mediaType} for TMDB ID ${tmdbId}:`, error);
            return { results: [], page: 1, totalPages: 0, totalResults: 0 };
        }
    }

    const api: SeerrApiFacade = {
        followUpOptions(details: unknown): FollowUpOptions | undefined {
            if (!isRecord(details) || !details.jeSpoilerGuard) return undefined;
            const items = Array.isArray(details.jeSpoilerGuardItems) ? details.jeSpoilerGuardItems.filter(isString) : [];
            return { skipCache: true, headers: { 'X-JE-Spoiler-Guarded': items.length ? items.join(',') : '1' } };
        },

        async checkUserStatus(): Promise<UserStatus> {
            if (cachedUserStatus !== null) {
                if (cachedUserStatus.active && cachedUserStatus.userFound) return cachedUserStatus;
                if (Date.now() - cachedUserStatusAt < NEGATIVE_USER_STATUS_TTL_MS) return cachedUserStatus;
            }
            // A status resolved after a user switch is returned to its caller, never cached.
            const origin = captureOrigin(host);
            try {
                // The page-load bootstrap carries this answer when it needed no lookup; handed out once.
                const prefetched = JE.takePrefetched?.('SeerrUserStatus');
                const raw = isUserStatus(prefetched) ? prefetched : await get('/user-status', { skipCache: true });
                if (!isUserStatus(raw)) throw new SeerrDecodeError('user status');
                if (origin.current()) {
                    cachedUserStatus = raw;
                    cachedUserStatusAt = Date.now();
                    api.surfaceUserStatusBanner(raw);
                }
                return raw;
            } catch (error) {
                console.warn(`${LOG} Status check failed:`, error);
                const body = errorBody(error);
                // An authentication failure is the account, not Seerr, being unavailable.
                const reason = body.code || (errorStatus(error) === 401 ? 'no_user' : 'unreachable');
                const fallback: UserStatus = { active: false, userFound: false, reason };
                if (body.message) fallback.message = body.message;
                if (origin.current()) {
                    cachedUserStatus = fallback;
                    cachedUserStatusAt = Date.now();
                    api.surfaceUserStatusBanner(fallback);
                }
                return fallback;
            }
        },

        surfaceUserStatusBanner(status: unknown): void {
            try {
                if (!isRecord(status) || (status.active && status.userFound)) return;
                const reason = isString(status.reason) ? status.reason : undefined;
                if (reason === 'disabled') return;
                // Once per reason per session (the flag resets on user change).
                if (host.window.__JE_userStatusBannerShown === reason) return;
                host.window.__JE_userStatusBannerShown = reason ?? null;
                // The server's UserMessage is plain English; it is still escaped (the toast renders HTML).
                const raw = (isString(status.message) && status.message) || (reason && BANNER_REASONS[reason]) || 'Seerr is unavailable right now.';
                if (typeof JE.toast === 'function') JE.toast(`Seerr: ${escapeHtml(raw)}`, 6000);
                else console.warn(`${LOG} ${raw}`);
            } catch (error) {
                console.debug(`${LOG} surfaceUserStatusBanner threw:`, error);
            }
        },

        shouldShowAdvanced(): boolean {
            return !!JE.pluginConfig?.JellyseerrShowAdvanced && cachedUserStatus?.canRequestAdvanced === true;
        },

        clearUserStatusCache(): void {
            cachedUserStatus = null;
            cachedUserStatusAt = 0;
        },

        async search(query, page = 1, options = {}) {
            const { skipCache = false, signal, throwOnError = false } = options;
            try {
                // Firefox with no configured locale reports navigator.language as the string "undefined".
                const browserLanguage = (navigator.language || '').split('-')[0] || '';
                const language = /^[a-z]{2,3}$/i.test(browserLanguage) ? browserLanguage : 'en';
                const fetchOptions: SeerrFetchOptions = { skipCache };
                if (signal) fetchOptions.signal = signal;
                const data = await get(`/search?query=${encodeURIComponent(query)}&page=${page}&language=${language}`, fetchOptions);
                return decodeSearchPage(data);
            } catch (error) {
                // A superseded search is dropped by its caller instead of rendering "no results".
                if (isAbortError(error) || throwOnError) throw error;
                console.error('%s Search failed for query "%s":', LOG, query, error);
                return { results: [], totalResults: 0 };
            }
        },

        async fetchMovieCollection(tmdbId, options = {}) {
            const signal = options.signal || undefined;
            const fetchOptions: SeerrFetchOptions = signal ? { signal } : {};
            try {
                const seerr = await get(`/movie/${segment(tmdbId)}`, fetchOptions);
                const c = isRecord(seerr) && isCollectionRef(seerr.collection) ? seerr.collection : null;
                if (c?.id) return { id: c.id, name: c.name ?? null, posterPath: c.posterPath ?? null, backdropPath: c.backdropPath ?? null };
                if (JE.pluginConfig?.TmdbEnabled) return decodeBelongsToCollection(await tmdbGet(`/movie/${segment(tmdbId)}`, fetchOptions));
                return null;
            } catch (error) {
                if (isAbortError(error)) throw error;
                console.debug(`${LOG} No collection found for movie ${tmdbId}:`, error);
                return null;
            }
        },

        async addCollections(results, options = {}) {
            if (!results || results.length === 0) return results;
            const signal = options.signal || undefined;
            const out = results.slice();
            const unknownIds = new Set<number>();
            for (const item of results) {
                const id = Number(item.id);
                if (item.mediaType === 'movie' && Number.isInteger(id) && id > 0 && recallMovieCollection(id) === undefined) unknownIds.add(id);
            }
            const ids = Array.from(unknownIds);
            // Answers that land after a user switch are used, never kept (permissions, parental gating).
            const origin = captureOrigin(host);
            const answered = new Map<number, MovieCollection | null>();
            try {
                for (let c = 0; c < ids.length; c += MOVIE_COLLECTIONS_IDS_PER_REQUEST) {
                    const chunk = ids.slice(c, c + MOVIE_COLLECTIONS_IDS_PER_REQUEST);
                    // skipCache: answers are kept per movie below rather than per id set.
                    const fetchOptions: SeerrFetchOptions = { skipCache: true };
                    if (signal) fetchOptions.signal = signal;
                    const data = await get(`/movie-collections?ids=${chunk.join(',')}`, fetchOptions);
                    const answers = isRecord(data) && isRecord(data.results) ? data.results : {};
                    for (const [key, collection] of Object.entries(answers)) {
                        const id = Number(key);
                        if (!Number.isInteger(id)) continue;
                        if (!collection) answered.set(id, null);
                        else if (isMovieCollection(collection)) answered.set(id, collection);
                    }
                }
            } catch (error) {
                // A superseded search or a failed lookup: unanswered movies get no collection this time.
                if (!isAbortError(error)) console.debug(`${LOG} Collection lookup failed:`, error);
            }
            if (origin.current()) answered.forEach((collection, id) => rememberMovieCollection(id, collection));
            results.forEach((item: SeerrMediaItem, i) => {
                if (item.mediaType !== 'movie') return;
                const id = Number(item.id);
                const collection = answered.has(id) ? answered.get(id) : recallMovieCollection(id);
                if (collection) out[i] = { ...item, collection };
            });
            return out;
        },

        async fetchTvShowDetails(tmdbId, options) {
            try {
                return detailsOrNull(await get(`/tv/${segment(tmdbId)}`, readOptions(options)));
            } catch (error) {
                console.error(`${LOG} Failed to fetch TV show details for TMDB ID ${tmdbId}:`, error);
                return null;
            }
        },

        async fetchSonarrLookup(tmdbId) {
            return decodeSonarrCandidates(await get(`/sonarr/lookup/${segment(tmdbId)}`));
        },

        async fetchTvSeasonDetails(tmdbId, seasonNumber, options) {
            try {
                return detailsOrNull(await get(`/tv/${segment(tmdbId)}/season/${segment(seasonNumber)}`, readOptions(options)));
            } catch (error) {
                console.debug(`${LOG} Failed to fetch season ${seasonNumber} for TMDB ID ${tmdbId}:`, error);
                return null;
            }
        },

        async fetchTmdbTvDetails(tmdbId, options) {
            try {
                return detailsOrNull(await tmdbGet(`/tv/${segment(tmdbId)}`, readOptions(options)));
            } catch (error) {
                console.debug(`${LOG} Failed to fetch TMDB TV details for ID ${tmdbId}:`, error);
                return null;
            }
        },

        async fetchOverrideRules() {
            if (cachedOverrideRules !== null && Date.now() - overrideRulesCachedAt < OVERRIDE_RULES_TTL_MS) return cachedOverrideRules;
            const origin = captureOrigin(host);
            try {
                const rules = decodeOverrideRules(await get('/overrideRule'));
                // A result that resolved after a user switch is not cached.
                if (origin.current()) {
                    cachedOverrideRules = rules;
                    overrideRulesCachedAt = Date.now();
                }
                return rules;
            } catch (error) {
                console.error(`${LOG} Failed to fetch override rules:`, error);
                return cachedOverrideRules || [];
            }
        },

        async getCurrentJellyseerrUserId() {
            try {
                const status = await api.checkUserStatus();
                const id = status?.jellyseerrUserId;
                return id || id === 0 ? String(id) : null;
            } catch (error) {
                console.warn(`${LOG} Failed to get current Seerr user ID:`, error);
                return null;
            }
        },

        async evaluateOverrideRules(mediaData, mediaType) {
            try {
                const rules = await api.fetchOverrideRules();
                if (!rules || rules.length === 0) {
                    console.debug(`${LOG} No override rules configured`);
                    return null;
                }
                const match = await matchOverrideRule(rules, ruleMedia(mediaData), mediaType, () => api.getCurrentJellyseerrUserId());
                if (!match) {
                    console.debug(`${LOG} No matching override rules found`);
                    return null;
                }
                const { rule, settings } = match;
                console.debug(`${LOG} Matched override rule ${String(rule.id)}:`, {
                    language: rule.language, genre: rule.genre, profileId: rule.profileId, rootFolder: rule.rootFolder
                });
                return settings;
            } catch (error) {
                console.error(`${LOG} Error evaluating override rules:`, error);
                return null;
            }
        },

        requestMedia(tmdbId, mediaType, advancedSettings = {}, is4k = false, mediaData = null, tvdbId = null) {
            return submitRequest(tmdbId, mediaType, advancedSettings, !!is4k, mediaData,
                mediaType === 'tv' ? { seasons: 'all' } : null, positiveInteger(tvdbId));
        },

        requestTvSeasons(tmdbId, seasonNumbers, advancedSettings = {}, mediaData = null, is4k = false, tvdbId = null) {
            const seasons = Array.isArray(seasonNumbers) ? seasonNumbers.filter(n => Number.isInteger(n) && n >= 0) : [];
            if (seasons.length === 0 || seasons.length !== seasonNumbers.length) {
                const id = positiveInteger(tmdbId) ?? 0;
                recordOutcome(JE, { kind: 'not-sent', mediaType: 'tv', tmdbId: id, is4k: !!is4k, stale: false });
                return Promise.reject(new RequestNotSentError('invalid-input', 'Season numbers must be non-negative integers'));
            }
            return submitRequest(tmdbId, 'tv', advancedSettings, !!is4k, mediaData, { seasons }, positiveInteger(tvdbId));
        },

        async fetchIssuesForMedia(tmdbId, mediaType, options = {}) {
            const { take = 20, skip = 0, filter = 'open', sort = 'added' } = options;
            // A failed list rejects: "no issues" would hide the failure from the issue dialog.
            const query = new URLSearchParams({ take: String(take), skip: String(skip), filter, sort });
            const page = decodeIssuePage(await get(`/issue?${query.toString()}`));
            const results = page.results.filter(issue => {
                const media = issue.media || {};
                const tmdbMatch = !!media.tmdbId && Number(media.tmdbId) === Number(tmdbId);
                const typeMatch = (media.mediaType || '').toLowerCase() === (mediaType || '').toLowerCase();
                return tmdbMatch && typeMatch;
            });
            return { ...page, results };
        },

        async fetchIssueById(issueId) {
            try {
                return detailsOrNull(await get(`/issue/${segment(issueId)}`));
            } catch (error) {
                console.warn(`${LOG} Failed to fetch issue ${issueId}:`, error);
                return null;
            }
        },

        async fetchAdvancedRequestData(mediaType) {
            const serverType = mediaType === 'movie' ? 'radarr' : 'sonarr';
            // A failed listing rejects: "no servers" would leave the callers' error toast unreachable.
            const listed = await get(`/${serverType}`);
            const serverList: unknown[] = Array.isArray(listed) ? listed : [listed];
            const servers = await Promise.all(serverList.filter(isServiceListing).map(async (server): Promise<AdvancedServer> => {
                try {
                    const details = await get(`/${serverType}/${server.id}`);
                    const record = isRecord(details) ? details : {};
                    return { ...server, qualityProfiles: decodeProfiles(record.profiles), rootFolders: decodeFolders(record.rootFolders) };
                } catch (error) {
                    console.error(`${LOG} Could not fetch details for ${serverType} server ID ${server.id}:`, error);
                    return { ...server, qualityProfiles: [], rootFolders: [] };
                }
            }));
            return decodeAdvancedData({ servers, tags: [] });
        },

        async fetchUserQuota(options = {}) {
            if (host.liveBridge()?.pluginConfig?.JellyseerrShowQuotaInfo === false) return null;
            try {
                const quota = await get('/quota', readOptions(options));
                if (isUserQuota(quota)) return quota;
                console.warn(`${LOG} Quota response was not a quota document`);
                return null;
            } catch (error) {
                // 404 = user not linked, 503 = Seerr disabled: expected. Anything else needs an admin's attention.
                const status = errorStatus(error);
                if (status === 404 || status === 503) console.debug(`${LOG} Quota fetch failed:`, error);
                else console.warn(`${LOG} Quota fetch failed:`, error);
                return null;
            }
        },

        async fetchRequestSettings() {
            try {
                const settings = decodeRequestSettings(await get('/settings/partial-requests', { skipCache: true }));
                lastRequestSettings = settings;
                return settings;
            } catch (error) {
                console.warn(`${LOG} Failed to fetch request settings:`, error);
                // Last known good beats flipping the modal to whole-show requests during a brief outage.
                return lastRequestSettings || { partialRequestsEnabled: false, enableSpecialEpisodes: false };
            }
        },

        async addToWatchlist(tmdbId, mediaType) {
            try {
                const config = host.liveBridge()?.pluginConfig;
                if (!config) {
                    console.debug(`${LOG} Plugin config not loaded yet`);
                    return false;
                }
                if (!config.AddRequestedMediaToWatchlist || !config.JellyseerrEnabled) {
                    console.debug(`${LOG} Watchlist auto-add is disabled (AddRequestedMediaToWatchlist: ${String(config.AddRequestedMediaToWatchlist)}, JellyseerrEnabled: ${String(config.JellyseerrEnabled)})`);
                    return false;
                }
                const id = parseInt(String(tmdbId), 10);
                if (!(id > 0) || (mediaType !== 'movie' && mediaType !== 'tv')) return false;
                // The Seerr watchlist now; the server's WatchlistMonitor fills the Jellyfin one when the title reaches the library.
                try {
                    await post('/watchlist', { tmdbId: id, mediaType });
                } catch (error) {
                    // 409: Seerr already has it on the user's watchlist.
                    if (errorStatus(error) === 409) return true;
                    throw error;
                }
                return true;
            } catch (error) {
                console.error(`${LOG} Error adding the request to the Seerr watchlist:`, error);
                return false;
            }
        },

        async reportIssue(mediaId, mediaType, problemType, message = '', problemSeason = 0, problemEpisode = 0) {
            const origin = captureOrigin(host);
            try {
                // A numeric issue type (1 video, 2 audio, 3 subtitles, 4 other) from the form.
                const issueType = parseInt(String(problemType), 10) || 4;
                let details: unknown = null;
                if (mediaType === 'movie') details = await get(`/movie/${segment(mediaId)}`);
                else if (mediaType === 'tv') details = await get(`/tv/${segment(mediaId)}`);
                const mediaInfo = isRecord(details) && isRecord(details.mediaInfo) ? details.mediaInfo : null;
                const internalId = mediaInfo ? positiveInteger(mediaInfo.id) : null;
                if (!internalId) throw new Error(`Could not find Jellyseerr media id (mediaInfo.id) for TMDB id ${mediaId} (${mediaType})`);
                if (!origin.current()) throw new RequestNotSentError('identity-changed', 'The signed-in account changed before the issue was sent');
                console.debug(`${LOG} Retrieved internal media id for issue report:`, internalId);
                const body = {
                    mediaId: internalId,
                    issueType,
                    problemSeason: parseInt(String(problemSeason), 10) || 0,
                    problemEpisode: parseInt(String(problemEpisode), 10) || 0,
                    message: message || ''
                };
                console.debug(`${LOG} Sending issue report with body:`, body);
                const result = await post('/issue', body);
                console.debug(`${LOG} Issue reported for Seerr media ID ${internalId} (TMDB ${mediaId}, ${mediaType}): ${String(problemType)}`);
                return result;
            } catch (error) {
                console.error(`${LOG} Failed to report issue for TMDB ID ${mediaId}:`, error);
                throw error;
            }
        },

        fetchSimilarMovies: (tmdbId, pageOrOptions) => fetchRelated('movie', tmdbId, 'similar', pageOrOptions),
        fetchRecommendedMovies: (tmdbId, pageOrOptions) => fetchRelated('movie', tmdbId, 'recommendations', pageOrOptions),
        fetchSimilarTvShows: (tmdbId, pageOrOptions) => fetchRelated('tv', tmdbId, 'similar', pageOrOptions),
        fetchRecommendedTvShows: (tmdbId, pageOrOptions) => fetchRelated('tv', tmdbId, 'recommendations', pageOrOptions),

        async fetchMovieDetails(tmdbId, options) {
            try {
                return detailsOrNull(await get(`/movie/${segment(tmdbId)}`, readOptions(options)));
            } catch (error) {
                console.error(`${LOG} Failed to fetch movie details for TMDB ID ${tmdbId}:`, error);
                return null;
            }
        },

        async fetchCollectionDetails(collectionId) {
            try {
                return detailsOrNull(await get(`/collection/${segment(collectionId)}`));
            } catch (error) {
                console.error(`${LOG} Failed to fetch collection details for ID ${collectionId}:`, error);
                return null;
            }
        },

        async fetchGenreSlider(mediaType) {
            const type = mediaType === 'movie' ? 'movie' : 'tv';
            try {
                const slider = await get(`/discover/genreslider/${type}`);
                return Array.isArray(slider) ? slider : [];
            } catch (error) {
                console.error(`${LOG} Failed to fetch genre slider for ${type}:`, error);
                return [];
            }
        },

        resolveJellyseerrBaseUrl(): string {
            const config = JE.pluginConfig;
            let baseUrl = '';
            if (config?.JellyseerrUrlMappings) {
                const client = host.apiClient();
                const address = client?.serverAddress ? client.serverAddress() : host.window.location.origin;
                const currentUrl = String(address).replace(/\/+$/, '').toLowerCase();
                const mappings = String(config.JellyseerrUrlMappings).split('\n').map(line => line.trim()).filter(Boolean);
                for (const mapping of mappings) {
                    const [jellyfinUrl, seerrUrl] = mapping.split('|').map(part => part.trim());
                    if (!jellyfinUrl || !seerrUrl) continue;
                    if (currentUrl === jellyfinUrl.replace(/\/+$/, '').toLowerCase()) {
                        baseUrl = seerrUrl.replace(/\/$/, '');
                        break;
                    }
                }
            }
            if (!baseUrl && config?.JellyseerrBaseUrl) baseUrl = String(config.JellyseerrBaseUrl).trim().replace(/\/$/, '');
            return baseUrl;
        }
    };

    JE.session?.onUserChange('jellyseerr-movie-collections', () => movieCollections.clear());
    // Linked user, permissions and override rules are per Jellyfin user (and server).
    JE.session?.onUserChange('jellyseerr-api', () => {
        cachedUserStatus = null;
        cachedUserStatusAt = 0;
        cachedOverrideRules = null;
        overrideRulesCachedAt = 0;
        lastRequestSettings = null;
        // The status banner may surface again for the new user.
        host.window.__JE_userStatusBannerShown = null;
    });
    JE.jellyseerrAPI = api;
}
