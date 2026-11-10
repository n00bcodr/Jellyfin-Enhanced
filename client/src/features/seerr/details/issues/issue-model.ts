import { filled, idText, isRecord, list, num, record, records, str, type JsonRecord } from '../domain/json';
import type { MediaType } from '../../host-details';

/** Jellyfin items carry their numbering under several names, depending on the version. */
function firstInt(...values: unknown[]): number {
    const value = values.find(Boolean);
    return parseInt(String(value ?? 0), 10) || 0;
}

export function isSeasonOrEpisode(item: JsonRecord | null): boolean {
    return item?.Type === 'Season' || item?.Type === 'Episode';
}

/** The series a Season or Episode belongs to. An Episode's ParentId is its season. */
export function seriesIdOf(item: JsonRecord): string | null {
    return filled(item.SeriesId) ?? filled(record(item.Series)?.Id) ?? (item.Type === 'Season' ? filled(item.ParentId) : null);
}

/** Season 0 holds the specials, which Seerr has no media record for. */
export function isSpecial(item: JsonRecord): boolean {
    if (item.Type === 'Season') return firstInt(item.IndexNumber, item.SeasonNumber, item.Index) === 0;
    if (item.Type === 'Episode') return firstInt(item.ParentIndexNumber, item.SeasonIndex, item.ParentIndex, item.SeasonNumber) === 0;
    return false;
}

/** Which season and episode the current page is about, if any. */
export function currentPosition(item: JsonRecord | null): { season: number | null; episode: number | null } {
    if (item?.Type === 'Season') return { season: firstInt(item.IndexNumber, item.SeasonNumber) || null, episode: null };
    if (item?.Type === 'Episode') {
        return {
            season: firstInt(item.ParentIndexNumber, item.SeasonIndex, item.ParentIndex, item.SeasonNumber) || null,
            episode: firstInt(item.IndexNumber, item.EpisodeNumber) || null,
        };
    }
    return { season: null, episode: null };
}

export interface ReportSeason { seasonNumber: number; id: string | null; episodes: Array<{ episodeNumber: number; title: string }> }

export function reportSeasons(reply: unknown): ReportSeason[] {
    return records(record(reply)?.Items)
        .map(season => ({ seasonNumber: firstInt(season.IndexNumber, season.SeasonNumber, season.ParentIndexNumber), id: filled(season.Id), episodes: [] }))
        .filter(season => season.seasonNumber > 0);
}

export function reportEpisodes(reply: unknown): ReportSeason['episodes'] {
    return records(record(reply)?.Items).map(episode => ({
        episodeNumber: firstInt(episode.IndexNumber, episode.ParentIndexNumber, episode.Index),
        title: filled(episode.Name) ?? filled(episode.Title) ?? '',
    }));
}

/** A numbered stand-in when the server has no season list to offer. */
export function inferredSeasons(item: JsonRecord | null): ReportSeason[] {
    const count = num(item?.SeasonCount) || list(item?.Seasons).length;
    return Array.from({ length: count }, (_, index) => ({ seasonNumber: index + 1, id: null, episodes: [] }));
}

/** The backdrop to show, from the item or from a parent it inherited one from. */
export function backdropSource(item: JsonRecord): { itemId: string; tag: string } | null {
    const own = filled(list(item.BackdropImageTags)[0]);
    const id = filled(item.Id);
    if (own && id) return { itemId: id, tag: own };
    const inherited = filled(list(item.ParentBackdropImageTags)[0]);
    const parent = filled(item.ParentBackdropItemId) ?? filled(item.ParentId) ?? filled(item.SeriesId);
    return inherited && parent ? { itemId: parent, tag: inherited } : null;
}

const typeKey = (issue: JsonRecord): string => {
    const key = String(issue.issueType || issue.problemType || 'unknown');
    return ['1', '2', '3', '4'].includes(key) ? key : 'unknown';
};

/** Issues by category, newest first; a type Seerr added later still shows under Other. */
export function groupIssues(issues: readonly JsonRecord[]): Array<{ key: string; issues: JsonRecord[] }> {
    const time = (issue: JsonRecord): number => new Date(str(issue.createdAt) ?? 0).getTime() || 0;
    return ['1', '2', '3', '4', 'unknown'].map(key => ({
        key,
        issues: issues.filter(issue => typeKey(issue) === key).sort((a, b) => time(b) - time(a)),
    })).filter(group => group.issues.length > 0);
}

export function isResolved(status: unknown): boolean {
    return String(status) === '2' || String(status).toLowerCase() === 'resolved';
}

/** Who a person is in Seerr, by the first name it has for them. */
export function personName(person: unknown): string {
    const user = record(person);
    return filled(user?.jellyfinUsername) ?? filled(user?.displayName) ?? filled(user?.username) ?? filled(user?.email) ?? '';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 04-Mar-2026 7:15 PM, in the viewer's time zone. */
export function issueDate(value: unknown): string {
    const text = filled(value);
    if (!text) return '';
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return '';
    const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `${String(date.getDate()).padStart(2, '0')}-${MONTHS[date.getMonth()]}-${date.getFullYear()} ${time}`;
}

/** A TMDB id out of a URL-like field, in any of the shapes ExternalUrls has taken. */
export function tmdbIdFromExternalUrls(urls: unknown): string | null {
    const entries = Array.isArray(urls) ? urls : Object.values(record(urls) ?? {});
    for (const entry of entries) {
        let url: string | null = null;
        if (typeof entry === 'string') {
            url = entry;
        } else if (isRecord(entry)) {
            url = filled(entry.Url) ?? filled(entry.url) ?? filled(entry.Value) ?? filled(entry.value) ?? filled(entry.Href) ?? filled(entry.href)
                ?? filled(entry.Link) ?? filled(entry.link) ?? filled(entry.Path) ?? filled(entry.path)
                ?? filled(Object.values(entry).find(value => typeof value === 'string' && value.includes('tmdb')));
        }
        if (url?.includes('tmdb')) {
            const match = /\/(\d+)/.exec(url);
            if (match?.[1]) return match[1];
        }
    }
    return null;
}

const matchesType = (result: JsonRecord, mediaType: MediaType): boolean => result.mediaType === mediaType || !result.mediaType;

/** From a search by IMDb id: an issue must never land on a title of another kind. */
export function matchFromImdbSearch(results: readonly JsonRecord[], mediaType: MediaType): string | null {
    return idText(results.find(result => result.id && result.mediaType === mediaType)?.id) ?? idText(results.find(result => result.id && matchesType(result, mediaType))?.id);
}

/** From a search by title: the exact title and year, else the first of the right kind. */
export function matchFromTitleSearch(results: readonly JsonRecord[], mediaType: MediaType, title: string, year: string): string | null {
    const wanted = title.toLowerCase();
    const exact = results.find(result => {
        const name = (filled(result.title) ?? filled(result.name) ?? '').toLowerCase();
        const released = (filled(result.releaseDate) ?? filled(result.firstAirDate) ?? '').slice(0, 4);
        return result.id && matchesType(result, mediaType) && name === wanted && (year === '' || released === '' || released === year);
    });
    return idText(exact?.id) ?? idText(results.find(result => result.id && matchesType(result, mediaType))?.id);
}

/** The year Jellyfin knows a title by, for a title search. */
export function itemYear(item: JsonRecord): string {
    return idText(item.ProductionYear) ?? filled(item.PremiereDate)?.slice(0, 4) ?? '';
}
