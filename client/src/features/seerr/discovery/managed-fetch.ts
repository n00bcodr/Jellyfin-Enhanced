import type { DiscoveryApiClient, SeerrDiscoveryHost } from '../host-discovery';
import { abortError, decodeGenreList, isGenreEntry, isRecord, throwIfAborted } from './domain';
import type { FeedKind, GenreListEntry, ManagedFetchOptions } from './types';

const userChanged = () => abortError('User changed during request');

/** Identity epoch at request start: a response landing after a switch was fetched under old permissions. */
function currentCheck(JE: SeerrDiscoveryHost): () => boolean {
    const session = JE.session;
    if (!session) return () => true;
    const epoch = session.getEpoch();
    return () => session.isCurrent(epoch);
}

/** Managed GET through the shared request manager: cached, deduplicated and pool-limited. */
export function createManagedFetch(JE: SeerrDiscoveryHost, client: () => DiscoveryApiClient | undefined) {
    return async function fetchWithManagedRequest(path: string, cachePrefix: string,
        options: ManagedFetchOptions = {}): Promise<unknown> {
        const api = client();
        if (!api) throw new Error('Jellyfin ApiClient is unavailable');
        const url = api.getUrl(path);
        const { signal } = options;
        const manager = JE.requestManager;
        const stillCurrent = currentCheck(JE);
        if (!manager) {
            if (!api.ajax) throw new Error('Jellyfin ApiClient cannot issue requests');
            const data = await api.ajax({
                type: 'GET', url, headers: { 'X-Jellyfin-User-Id': api.getCurrentUserId() }, dataType: 'json'
            });
            if (!stillCurrent()) throw userChanged();
            throwIfAborted(signal);
            return data;
        }
        const cacheKey = `${cachePrefix}:${path}`;
        const cached = manager.getCached(cacheKey);
        if (cached) return cached;

        const fetchPage = async () => {
            const requestedAt = manager.cacheStamp?.();
            const token = api.accessToken();
            const response = await manager.fetchWithRetry(url, {
                method: 'GET',
                headers: {
                    'X-Jellyfin-User-Id': api.getCurrentUserId(),
                    Authorization: `MediaBrowser Token="${token}"`,
                    'X-Emby-Token': token,
                    Accept: 'application/json'
                },
                ...(signal ? { signal } : {})
            });
            const data: unknown = await response.json();
            if (!stillCurrent()) throw userChanged();
            manager.setCache(cacheKey, data, requestedAt);
            return data;
        };
        // Dedup outside the pool (only the unique fetch holds a slot) and re-check the cache
        // after acquiring the slot, so a prefetch that finished while we queued is not repeated.
        return manager.deduplicatedFetch(cacheKey, () => manager.withConcurrencyLimit(() => {
            if (!stillCurrent()) return Promise.reject(userChanged());
            const hit = manager.getCached(cacheKey);
            return hit ? Promise.resolve(hit) : fetchPage();
        }), signal);
    };
}

// The TMDB genre lists are prefetched at startup so genre discovery has them at once. They rarely
// change, so they are also kept in sessionStorage, per server and user, for as long as the in-memory
// response cache keeps them: a reload in the same tab reuses them instead of asking again.
const GENRE_LIST_PREFIX = 'je-tmdb-genres:';
const GENRE_LIST_TTL_MS = 30 * 60 * 1000;

export interface GenreListDependencies {
    storage(): Storage;
    now(): number;
    fetchWithManagedRequest(path: string, cachePrefix: string, options?: ManagedFetchOptions): Promise<unknown>;
}
function readStoredGenreList(deps: GenreListDependencies, key: string): GenreListEntry[] | null {
    try {
        const raw = deps.storage().getItem(key);
        if (!raw) return null;
        const entry: unknown = JSON.parse(raw);
        if (!isRecord(entry) || typeof entry.storedAt !== 'number') return null;
        const age = deps.now() - entry.storedAt;
        if (!(age >= 0 && age < GENRE_LIST_TTL_MS)) return null;
        const { genres } = entry;
        if (!Array.isArray(genres) || genres.length === 0 || !genres.every(isGenreEntry)) return null;
        return genres;
    } catch { return null; }
}
/** One genre list, from this tab's fresh copy, otherwise fetched and stored for its own identity. */
export function createGenreListFetch(JE: SeerrDiscoveryHost, deps: GenreListDependencies) {
    return async function fetchTmdbGenreList(mediaType: FeedKind, options: ManagedFetchOptions = {}): Promise<GenreListEntry[]> {
        const serverId = JE.session?.getServerId?.();
        const userId = JE.session?.getUserId?.();
        const key = serverId && userId ? `${GENRE_LIST_PREFIX}${serverId}:${userId}:${mediaType}` : null;
        const stored = key ? readStoredGenreList(deps, key) : null;
        if (stored) return stored;
        const stillCurrent = currentCheck(JE);
        const data = await deps.fetchWithManagedRequest(`/JellyfinEnhanced/tmdb/genres/${mediaType}`, 'genre', options);
        const genres = decodeGenreList(data);
        if (key && genres.length > 0 && stillCurrent()) {
            try { deps.storage().setItem(key, JSON.stringify({ storedAt: deps.now(), genres })); }
            catch { /* Storage full or unavailable: the next page load fetches again. */ }
        }
        return genres;
    };
}
