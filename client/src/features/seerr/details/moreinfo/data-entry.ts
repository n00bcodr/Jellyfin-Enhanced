import { apiClient, bridge, moreInfoRegistry, SEERR_LOG, type MediaType, type TmdbId } from '../../host-details';
import { isRecord, num } from '../domain/json';
import { clearPhantom4k, contentRating } from '../domain/media';

// This script loads first in the More Info group, so it seeds the shared registry.
const JE = bridge();
const internal = moreInfoRegistry(JE);
const logPrefix = `${SEERR_LOG} Jellyseerr More Info:`;

/** Ratings through the Seerr proxy. A TV reply is the Rotten Tomatoes record itself. */
async function fetchRatings(tmdbId: TmdbId, mediaType: MediaType, details: unknown, signal?: AbortSignal): Promise<unknown> {
    try {
        const client = apiClient();
        const endpoint = mediaType === 'tv' ? `/tv/${tmdbId}/ratings` : `/movie/${tmdbId}/ratingscombined`;
        const url = client.getUrl(`/JellyfinEnhanced/jellyseerr${endpoint}`);
        const followUp = JE.jellyseerrAPI?.followUpOptions?.(details)?.headers;
        let response: unknown;
        if (JE.requestManager) {
            const userId = client.getCurrentUserId() ?? '';
            const reply = await JE.requestManager.fetchWithRetry(url, {
                method: 'GET',
                headers: {
                    'X-Jellyfin-User-Id': userId,
                    Authorization: `MediaBrowser Token="${client.accessToken()}"`,
                    'X-Emby-Token': client.accessToken(),
                    Accept: 'application/json',
                    ...followUp,
                },
                ...(signal ? { signal } : {}),
            });
            response = await reply.json();
        } else {
            response = await client.ajax({
                type: 'GET', url, dataType: 'json',
                headers: { 'X-Jellyfin-User-Id': client.getCurrentUserId() ?? '', ...followUp },
            });
        }
        if (mediaType === 'tv') return response ? { rt: response } : null;
        return response;
    } catch (error) {
        console.warn(`${logPrefix} Failed to fetch ratings for ${mediaType} ${tmdbId}:`, error);
        return null;
    }
}

/** Fetch a title's details, uncached: Spoiler Guard shapes them per title and can change on another device. */
async function fetchMediaDetails(tmdbId: TmdbId, mediaType: MediaType): Promise<unknown> {
    try {
        let data: unknown;
        const api = JE.jellyseerrAPI;
        if (api) {
            data = mediaType === 'movie'
                ? await api.fetchMovieDetails(tmdbId, { skipCache: true })
                : await api.fetchTvShowDetails(tmdbId, { skipCache: true });
        } else {
            const client = apiClient();
            data = await client.ajax({
                type: 'GET', dataType: 'json',
                url: client.getUrl(`/JellyfinEnhanced/jellyseerr/${mediaType === 'movie' ? 'movie' : 'tv'}/${tmdbId}`),
                headers: { 'X-Jellyfin-User-Id': client.getCurrentUserId() ?? '' },
            });
        }
        const media = JE.seerrStatus?.MEDIA;
        if (media) clearPhantom4k(data, media.AVAILABLE, media.UNKNOWN);
        return data;
    } catch (error) {
        console.error(`${logPrefix} Failed to fetch ${mediaType} details for TMDB ID ${tmdbId}:`, error);
        throw error;
    }
}

/** The Elsewhere region, then the plugin default, then the US. */
function region(): string {
    return (JE.userConfig?.elsewhere?.Region || JE.pluginConfig?.DEFAULT_REGION || 'US').toUpperCase();
}

function getContentRating(details: unknown, mediaType: MediaType): string {
    return isRecord(details) ? contentRating(details, mediaType, region()) : 'N/A';
}

function showError(message: string): void {
    console.error(message);
    alert(message);
}

function formatCurrency(amount: unknown): string | null {
    const value = num(amount);
    if (!value) return null;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(value);
}

internal.fetchRatings = fetchRatings;
internal.fetchMediaDetails = fetchMediaDetails;
internal.getContentRating = getContentRating;
internal.showError = showError;
internal.formatCurrency = formatCurrency;
