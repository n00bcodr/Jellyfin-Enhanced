/** Pure logic for the Awards, MDBList and DoesTheDogDie details sections. */
import { field, int, isRecord, list, num, str, stringList, text } from './wire';
import type { DetailsItem } from './wire';

// ── TMDB target of a details item ──────────────────────────────────────────
export type ProviderMediaType = 'movie' | 'tv' | 'person';
export interface ProviderTarget { tmdbId: string; mediaType: ProviderMediaType }
/**
 * Awards/ratings/warnings are recorded against the title: a Season's or
 * Episode's own ProviderIds.Tmdb is a season/episode id, so the show id comes
 * from the parent Series. Person is only offered where the feature has a
 * person mode (awards). Unsupported items resolve to `null` with `unsupported`.
 */
export async function resolveProviderTarget(item: DetailsItem | null, allowPerson: boolean,
    seriesLookup: (seriesId: string) => Promise<DetailsItem | null>): Promise<{ target: ProviderTarget | null; unsupported: boolean }> {
    const type = item?.Type;
    if (!item) return { target: null, unsupported: true };
    if (type === 'Movie') return { target: wrap(item.ProviderIds.Tmdb, 'movie'), unsupported: false };
    if (type === 'Person' && allowPerson) return { target: wrap(item.ProviderIds.Tmdb, 'person'), unsupported: false };
    if (type === 'Series' || type === 'Season' || type === 'Episode') {
        let tmdbId: string | undefined;
        if (type === 'Series') tmdbId = item.ProviderIds.Tmdb;
        else if (item.SeriesId) {
            try { tmdbId = (await seriesLookup(item.SeriesId))?.ProviderIds.Tmdb; } catch { /* the not-found path below */ }
        }
        return { target: wrap(tmdbId, 'tv'), unsupported: false };
    }
    return { target: null, unsupported: true };
}
function wrap(tmdbId: string | undefined, mediaType: ProviderMediaType): ProviderTarget | null {
    return tmdbId ? { tmdbId, mediaType } : null;
}
/** A server failure placeholder (Confirmed: false) must not stay in the response cache. */
export function isUnconfirmed(value: unknown): boolean {
    return field(value, 'Confirmed') === false;
}

// ── Awards ────────────────────────────────────────────────────────────────
export interface Award { name: string; result: string; year: number | undefined; recipients: string[]; works: string[] }
export interface AwardsData { found: boolean; wins: number; nominations: number; awards: Award[] }
/** The raw PascalCase AwardsCacheEntry, normalized once at the fetch boundary. */
export function normalizeAwardsData(data: unknown): AwardsData | null {
    if (!isRecord(data)) return null;
    return {
        found: !!data.Found,
        wins: num(data.Wins) || 0,
        nominations: num(data.Nominations) || 0,
        awards: list(data.Awards).filter(isRecord).map(award => ({
            name: str(award.Name) ?? '',
            result: str(award.Result) ?? '',
            year: num(award.Year),
            recipients: stringList(award.Recipients),
            works: stringList(award.Works)
        }))
    };
}
/** Wins first within a year, newest year first. */
export function sortAwards(awards: readonly Award[]): Award[] {
    return [...awards].sort((a, b) => {
        const yearDiff = (b.year || 0) - (a.year || 0);
        if (yearDiff !== 0) return yearDiff;
        return (a.result === 'Won' ? 0 : 1) - (b.result === 'Won' ? 0 : 1);
    });
}
// Award-body icons inferred from the Wikidata category name prefix; only
// bodies with a license-verified free logo (see CdnAssetService.cs
// "award-logos"). `invert`: a flat black silhouette forced white.
const AWARD_BODY_ICONS: readonly (readonly [string, string, boolean?])[] = [
    ['Academy Award', 'oscar'],
    ['Golden Globe Award', 'golden-globe'],
    ['BAFTA Award', 'bafta'],
    ['Primetime Emmy Award', 'emmy'],
    ['Daytime Emmy Award', 'emmy'],
    ['Screen Actors Guild Award', 'sag'],
    ['Critics\' Choice', 'critics-choice'],
    ['National Board of Review', 'national-board-of-review'],
    ['Saturn Award', 'saturn', true],
    ['Kids\' Choice Award', 'kids-choice'],
    ['Toronto Film Critics Association Award', 'toronto-critics', true],
    ['Palme d\'Or', 'cannes'],
    ['Cannes Film Festival Award', 'cannes'],
];
export function awardBodyIcon(awardName: string): { file: string; invert: boolean } | null {
    const match = AWARD_BODY_ICONS.find(([prefix]) => awardName.startsWith(prefix));
    return match ? { file: match[1], invert: !!match[2] } : null;
}
/** Decorative four-point stars; the "wide" set is CSS-hidden on narrow cards. */
export function sparklesSvg(): string {
    const star = (x: number, y: number, size: number, opacity: number, extraClass = '') =>
        `<svg class="${extraClass}" viewBox="0 0 24 24" width="${size}" height="${size}" style="left:${x}%; top:${y}%; opacity:${opacity};">
                    <path d="M12 0 L14 10 L24 12 L14 14 L12 24 L10 14 L0 12 L10 10 Z"/>
                </svg>`;
    const safe = star(38, 18, 8, 0.4) + star(50, 68, 12, 0.3) + star(28, 65, 7, 0.35);
    const wide = star(70, 20, 10, 0.5, 'je-spark-wide') + star(80, 60, 16, 0.35, 'je-spark-wide') + star(90, 25, 22, 0.9, 'je-spark-wide');
    return safe + wide;
}

// ── MDBList ───────────────────────────────────────────────────────────────
export interface MdblistRating { Source: string; Value: number | null; Score: number | null; Votes: number | null; Url: string | null; Fresh: number | null }
export interface MdblistEntry { Found: boolean; Ratings: MdblistRating[]; Ids: Record<string, string> }
/** null unless the server found the title and returned rating rows. */
export function decodeMdblistEntry(value: unknown): MdblistEntry | null {
    if (!isRecord(value) || !value.Found || !Array.isArray(value.Ratings) || value.Ratings.length === 0) return null;
    const ids: Record<string, string> = {};
    if (isRecord(value.Ids)) {
        for (const [key, id] of Object.entries(value.Ids)) {
            const decoded = typeof id === 'number' && Number.isFinite(id) ? String(id) : text(id);
            if (decoded !== undefined) ids[key] = decoded;
        }
    }
    return {
        Found: true,
        Ids: ids,
        Ratings: value.Ratings.filter(isRecord).map(rating => ({
            Source: str(rating.Source) ?? '',
            // Rendered into markup: only finite numbers are scores.
            Value: num(rating.Value) ?? null,
            Score: num(rating.Score) ?? null,
            Votes: num(rating.Votes) ?? null,
            Url: str(rating.Url) ?? null,
            Fresh: int(rating.Fresh) ?? null
        }))
    };
}
// Friendly labels for MDBList's raw source keys; others use the raw key.
export const MDBLIST_LABELS: Readonly<Record<string, string>> = {
    master: 'Master', imdb: 'IMDb', tmdb: 'TMDB', trakt: 'Trakt',
    letterboxd: 'Letterboxd', tomatoes: 'RT Critic', popcorn: 'RT Audience',
    metacritic: 'Metascore', metacriticuser: 'Metacritic User',
    rogerebert: 'Roger Ebert', myanimelist: 'MAL', anilist: 'AniList',
};
// Logo files served via the "mdblist-logos" CDN source (CdnAssetService.cs).
export const MDBLIST_LOGOS: Readonly<Record<string, string>> = {
    master: 'master.png', imdb: 'imdb.png', tmdb: 'tmdb.png', trakt: 'trakt.png',
    letterboxd: 'letterboxd.png', tomatoes: 'rottentomatoes.png', popcorn: 'rottentomatoes_audience.png',
    metacritic: 'metacritic.png', metacriticuser: 'metacritic_audience.png',
    rogerebert: 'rogerebert.png', myanimelist: 'myanimelist.png', anilist: 'anilist.png',
};
// Only 'tomatoes' (RT Critic) has a Fresh/Rotten splat.
const TOMATOES_STATUS_LOGOS: Readonly<Record<number, string>> = { 1: 'rottentomatoes_fresh.png', 0: 'rottentomatoes_rotten.png' };
export const MDBLIST_DEFAULT_ORDER: readonly string[] = ['tmdb', 'tomatoes', 'popcorn', 'imdb', 'trakt', 'metacritic'];
const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined => Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

const localSlug = (value: string) => (value || '').toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/**
 * Direct link to a rating's source site (ported from jellyfin_ratings'
 * generateLink): cross-provider ids, the per-source url MDBList returns when
 * usable, or a title-built url. null renders the badge as plain text.
 */
export function mdblistLink(sourceKey: string, ids: Readonly<Record<string, string>>, apiUrl: string | null, mediaType: string, title: string | undefined): string | null {
    const sLink = String(apiUrl || '');
    const safeTitle = encodeURIComponent(title || '');
    const safeType = mediaType === 'tv' ? 'tv' : 'movie';
    const id = (key: string) => own(ids, key);
    const path = (value: string) => encodeURIComponent(value);
    if (sLink.startsWith('http') && sourceKey !== 'metacriticuser' && sourceKey !== 'rogerebert') return sLink;
    switch (sourceKey) {
        case 'imdb': { const v = id('imdb'); return v ? `https://www.imdb.com/title/${path(v)}/` : null; }
        case 'tmdb': { const v = id('tmdb'); return v ? `https://www.themoviedb.org/${safeType}/${path(v)}` : null; }
        case 'trakt': { const v = id('trakt'); return v ? `https://trakt.tv/${safeType === 'tv' ? 'shows' : 'movies'}/${path(v)}` : null; }
        case 'letterboxd': return (sLink.includes('/film/') || sLink.includes('/slug/')) ? `https://letterboxd.com${sLink.startsWith('/') ? '' : '/'}${sLink}` : null;
        case 'metacritic':
        case 'metacriticuser': return title ? `https://www.metacritic.com/${safeType}/${localSlug(title)}` : null;
        case 'tomatoes':
        case 'popcorn':
            if (sLink.startsWith('/')) return `https://www.rottentomatoes.com${sLink}`;
            return sLink.length > 2 ? `https://www.rottentomatoes.com/m/${sLink}` : null;
        case 'anilist': { const v = id('anilist'); return v ? `https://anilist.co/anime/${path(v)}` : (title ? `https://anilist.co/search/anime?search=${safeTitle}` : null); }
        case 'myanimelist': { const v = id('mal'); return v ? `https://myanimelist.net/anime/${path(v)}` : (title ? `https://myanimelist.net/anime.php?q=${safeTitle}` : null); }
        case 'rogerebert': return sLink.length > 2 ? `https://www.rogerebert.com/reviews/${sLink}` : (title ? `https://duckduckgo.com/?q=!ducky+site:rogerebert.com/reviews+${safeTitle}` : null);
        default: return null; // e.g. "master" (MDBList's own aggregate) has no source site
    }
}
/** Admin source list (comma separated): empty shows every source in the default order. */
export function configuredSources(raw: string | undefined): string[] {
    return (raw || '').split(',').map(source => source.trim().toLowerCase()).filter(Boolean);
}
export interface MdblistBadge { label: string; logo: string | undefined; link: string | null; scoreText: string; score: number; votes: number | null }
export function mdblistBadges(entry: MdblistEntry, mediaType: string, title: string | undefined, sources: readonly string[], showPercent: boolean): MdblistBadge[] {
    const order = sources.length ? sources : MDBLIST_DEFAULT_ORDER;
    const rank = (rating: MdblistRating) => {
        const index = order.indexOf(rating.Source.toLowerCase());
        return index === -1 ? order.length : index;
    };
    return entry.Ratings
        .filter(rating => rating.Score !== null || rating.Value !== null)
        .filter(rating => sources.length === 0 || sources.includes(rating.Source.toLowerCase()))
        .sort((a, b) => rank(a) - rank(b))
        .map(rating => {
            // Score is MDBList's own 0-100 figure; "%" only fits a true Score.
            const normalized = rating.Score;
            const score = normalized ?? rating.Value ?? 0;
            const sourceKey = rating.Source.toLowerCase();
            const label = own(MDBLIST_LABELS, sourceKey) || rating.Source;
            // MDBList's fresh flag can contradict the score; RT rule: >= 60 is Fresh.
            const freshState = normalized !== null ? (normalized >= 60 ? 1 : 0) : rating.Fresh;
            const freshLogo = sourceKey === 'tomatoes' && freshState !== null ? own(TOMATOES_STATUS_LOGOS, String(freshState)) : undefined;
            return {
                label,
                logo: freshLogo || own(MDBLIST_LOGOS, sourceKey),
                link: mdblistLink(sourceKey, entry.Ids, rating.Url, mediaType, title),
                // A raw fallback Value keeps its precision (rogerebert's 3.5 stays 3.5).
                scoreText: normalized !== null ? Math.round(normalized) + (showPercent ? '%' : '') : String(score),
                score,
                votes: rating.Votes
            };
        });
}
export const RUNTIME_PATTERN = /^\d+\s*(?:h(?:ours?)?)?\s*\d*\s*m(?:inutes?)?$/i;

// ── DoesTheDogDie ─────────────────────────────────────────────────────────
export interface DddTopic { Id: number; Name: string; Yes: number; No: number }
export interface DddEntry { ItemId: number | undefined; Topics: DddTopic[] }
export interface DddCatalogTopic { Id: number; Name: string; Category: string; Group: string }
/** null unless the title was found with topics. */
export function decodeDddEntry(value: unknown): DddEntry | null {
    if (!isRecord(value) || !value.Found) return null;
    const topics = list(value.Topics).filter(isRecord).flatMap(topic => {
        const id = int(topic.Id);
        return id === undefined ? [] : [{ Id: id, Name: str(topic.Name) ?? '', Yes: num(topic.Yes) ?? 0, No: num(topic.No) ?? 0 }];
    });
    return topics.length ? { ItemId: int(value.ItemId), Topics: topics } : null;
}
export function decodeDddCatalog(value: unknown): DddCatalogTopic[] {
    return list(field(value, 'Topics')).filter(isRecord).flatMap(topic => {
        const id = int(topic.Id);
        return id === undefined ? [] : [{ Id: id, Name: str(topic.Name) ?? '', Category: str(topic.Category) ?? '', Group: str(topic.Group) ?? '' }];
    });
}
/** The saved trigger picks; null when the document is not a trigger document. */
export function decodeDddTriggers(value: unknown): number[] | null {
    if (!isRecord(value)) return null;
    if (!Object.prototype.hasOwnProperty.call(value, 'Triggers')) return [];
    if (!Array.isArray(value.Triggers)) return null;
    const ids = value.Triggers.map(int);
    if (ids.some(id => id === undefined)) return null;
    return ids.filter((id): id is number => id !== undefined);
}
// A topic counts as present when at least this share of votes say yes.
export const DDD_PRESENT_PCT = 50;
// Topics the user didn't pick need a few votes, so one stray vote doesn't headline.
export const DDD_MIN_VOTES = 3;
export const dddVotes = (topic: DddTopic) => topic.Yes + topic.No;
export const dddPercent = (topic: DddTopic) => Math.round((topic.Yes / (topic.Yes + topic.No)) * 100);
export const dddTone = (pct: number) => (pct >= 90 ? 'je-ddd-hi' : pct >= 75 ? 'je-ddd-mid' : 'je-ddd-low');
export const capitalize = (value: string) => value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
export interface DddView { hasPicks: boolean; present: DddTopic[]; mine: DddTopic[]; hits: DddTopic[]; misses: DddTopic[]; rest: DddTopic[] }
export function dddView(topics: readonly DddTopic[], picked: ReadonlySet<number>): DddView {
    const byVotes = (a: DddTopic, b: DddTopic) => dddVotes(b) - dddVotes(a);
    const present = topics.filter(topic => dddPercent(topic) >= DDD_PRESENT_PCT && dddVotes(topic) >= DDD_MIN_VOTES).sort(byVotes);
    const hasPicks = picked.size > 0;
    const mine = hasPicks ? topics.filter(topic => picked.has(topic.Id)) : [];
    return {
        hasPicks, present, mine,
        hits: mine.filter(topic => dddPercent(topic) >= DDD_PRESENT_PCT).sort(byVotes),
        misses: mine.filter(topic => dddPercent(topic) < DDD_PRESENT_PCT),
        rest: hasPicks ? present.filter(topic => !picked.has(topic.Id)) : []
    };
}
export function filterCatalog(topics: readonly DddCatalogTopic[], query: string): DddCatalogTopic[] {
    const q = query.trim().toLowerCase();
    return topics
        .filter(topic => !q || topic.Name.toLowerCase().includes(q) || topic.Category.toLowerCase().includes(q))
        .sort((a, b) => a.Group.localeCompare(b.Group) || a.Category.localeCompare(b.Category) || a.Name.localeCompare(b.Name));
}
