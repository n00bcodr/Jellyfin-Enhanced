/** Pure release/air-date selection from TMDB responses (via the plugin proxy). */
import { field, int, list, str } from './wire';

export type ReleaseType = 'cinema' | 'digital' | 'physical' | 'episode';
export interface ReleaseInfo { date: string; icon: string; titleKey: string; type: ReleaseType }

/** Local calendar date "YYYY-MM-DD" (TMDB air dates are calendar dates). */
export function todayIso(now: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * A release or air date in the user's locale. These are calendar dates, not
 * instants: read as UTC midnight they would show the previous day west of
 * UTC, so the leading date is formatted as that local calendar day.
 * Returns the input unchanged when it is not a valid date.
 */
export function formatReleaseDate(dateStr: string): string {
    const parts = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(String(dateStr));
    let d: Date;
    if (parts) {
        const year = Number(parts[1]), month = Number(parts[2]) - 1, day = Number(parts[3]);
        d = new Date(year, month, day);
        // Out-of-range parts would otherwise roll over into another date.
        if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return dateStr;
    } else {
        d = new Date(dateStr);
    }
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// TMDB release_dates `type` values bucketed into the three moments shown;
// theatrical premiere/limited/wide (1-3) collapse into one "cinema" bucket.
interface Bucket { types: readonly number[]; icon: string; titleKey: string; type: ReleaseType }
const MOVIE_RELEASE_BUCKETS: readonly Bucket[] = [
    { types: [1, 2, 3], icon: 'local_movies', titleKey: 'calendar_cinema_release', type: 'cinema' },
    { types: [4], icon: 'ondemand_video', titleKey: 'calendar_digital_release', type: 'digital' },
    { types: [5], icon: 'album', titleKey: 'calendar_physical_release', type: 'physical' },
];
interface ReleaseDate { type: number; release_date: string }
interface CountryReleases { iso: string | undefined; dates: ReleaseDate[] }
function decodeCountries(value: unknown): CountryReleases[] {
    return list(field(value, 'results')).map(entry => ({
        iso: str(field(entry, 'iso_3166_1')),
        dates: list(field(entry, 'release_dates')).flatMap(date => {
            const type = int(field(date, 'type')), releaseDate = str(field(date, 'release_date'));
            return type !== undefined && releaseDate ? [{ type, release_date: releaseDate }] : [];
        })
    }));
}
function earliestOfBucket(dates: ReleaseDate[], bucket: Bucket): ReleaseDate | null {
    const matches = dates.filter(date => bucket.types.includes(date.type) && date.release_date);
    if (matches.length === 0) return null;
    return matches.reduce((a, b) => (a.release_date < b.release_date ? a : b));
}
/** Each bucket cascades through the configured region, then US, then any region. */
export function movieReleaseInfo(data: unknown, configuredRegion: string | undefined): ReleaseInfo[] {
    const results = decodeCountries(data);
    if (results.length === 0) return [];
    const region = (configuredRegion || 'US').toUpperCase();
    const preferredOrder = [region, 'US'].filter((iso, i, arr) => iso && arr.indexOf(iso) === i);
    const infos: ReleaseInfo[] = [];
    for (const bucket of MOVIE_RELEASE_BUCKETS) {
        let earliest: ReleaseDate | null = null;
        for (const iso of preferredOrder) {
            const entry = results.find(result => result.iso === iso);
            earliest = entry ? earliestOfBucket(entry.dates, bucket) : null;
            if (earliest) break;
        }
        if (!earliest) {
            for (const entry of results) {
                earliest = earliestOfBucket(entry.dates, bucket);
                if (earliest) break;
            }
        }
        if (earliest) infos.push({ date: earliest.release_date, icon: bucket.icon, titleKey: bucket.titleKey, type: bucket.type });
    }
    return infos;
}
export function episodeInfo(date: string): ReleaseInfo {
    return { date, icon: 'tv_guide', titleKey: 'calendar_episode', type: 'episode' };
}
export function seriesReleaseInfo(data: unknown): ReleaseInfo[] {
    const date = str(field(field(data, 'next_episode_to_air'), 'air_date')) || str(field(field(data, 'last_episode_to_air'), 'air_date'));
    return date ? [episodeInfo(date)] : [];
}
/** The next episode airing today or later (local date), else the season's last. */
export function seasonReleaseInfo(data: unknown, today: string): ReleaseInfo[] {
    const episodes = field(data, 'episodes');
    if (!Array.isArray(episodes) || episodes.length === 0) return [];
    const withDates = episodes.map(episode => str(field(episode, 'air_date'))).filter((date): date is string => !!date);
    if (withDates.length === 0) return [];
    const upcoming = withDates.find(date => date >= today);
    const date = upcoming ?? withDates[withDates.length - 1];
    return date ? [episodeInfo(date)] : [];
}
export function episodeReleaseInfo(data: unknown): ReleaseInfo[] {
    const date = str(field(data, 'air_date'));
    return date ? [episodeInfo(date)] : [];
}
/** An episode's own premiere, trimmed to its calendar date, when it has one. */
export function premiereDate(value: string | undefined): string | null {
    const premiere = typeof value === 'string' ? value.slice(0, 10) : '';
    return /^\d{4}-\d{2}-\d{2}$/.test(premiere) ? premiere : null;
}
