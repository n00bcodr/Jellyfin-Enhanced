/** Pure logic for "Jellyfin Elsewhere" streaming-provider lookups. */
import { field, int, isRecord, list, str, text } from './wire';

export interface StreamingService { provider_id?: number; provider_name: string; logo_path: string }
export interface RegionProviders { link?: string; flatrate?: StreamingService[] }
/** TMDB `/watch/providers`: region code → that region's offers. */
export interface WatchProviders { results: Record<string, RegionProviders> }

/** Admin provider lists: comma/newline separated, quotes stripped. */
export function parseProviderList(raw: string | undefined): string[] {
    return raw ? raw.replace(/'/g, '').replace(/\n/g, ',').split(',').map(s => s.trim()).filter(s => s) : [];
}

function decodeService(value: unknown): StreamingService | null {
    if (!isRecord(value)) return null;
    const service: StreamingService = { provider_name: str(value.provider_name) ?? '', logo_path: str(value.logo_path) ?? '' };
    const id = int(value.provider_id);
    if (id !== undefined) service.provider_id = id;
    return service;
}
function decodeRegion(value: unknown): RegionProviders {
    const region: RegionProviders = {};
    const link = text(field(value, 'link'));
    if (link !== undefined) region.link = link;
    const flatrate = field(value, 'flatrate');
    if (Array.isArray(flatrate)) region.flatrate = flatrate.map(decodeService).filter((service): service is StreamingService => service !== null);
    return region;
}
export function decodeWatchProviders(value: unknown): WatchProviders {
    const results: Record<string, RegionProviders> = {};
    const raw = field(value, 'results');
    if (isRecord(raw)) for (const [code, region] of Object.entries(raw)) results[code] = decodeRegion(region);
    return { results };
}
export function regionOf(data: WatchProviders | null, region: string): RegionProviders | undefined {
    return data && Object.prototype.hasOwnProperty.call(data.results, region) ? data.results[region] : undefined;
}

export interface ProviderFilters { defaults: readonly string[]; ignore: readonly string[] }
/**
 * Admin default-provider allowlist, then ignore patterns (regular
 * expressions; an invalid pattern list is reported and skipped).
 */
export function applyProviderFilters(services: StreamingService[] | undefined, filters: ProviderFilters, report: (error: unknown) => void): StreamingService[] {
    let filtered = services || [];
    if (filters.defaults.length > 0) filtered = filtered.filter(service => filters.defaults.includes(service.provider_name));
    if (filters.ignore.length > 0) {
        try {
            const patterns = filters.ignore.map(pattern => new RegExp(pattern, 'i'));
            filtered = filtered.filter(service => !patterns.some(regex => regex.test(service.provider_name)));
        } catch (error) {
            report(error);
        }
    }
    return filtered;
}

export function isDefaultSeasonOrder(order: string | undefined): boolean {
    const value = (order || '').toString().trim().toLowerCase();
    return value === '' || value === 'aired' || value === 'airdate' || value === 'default';
}

/** Concurrency-limited ordered map. */
export async function mapWithLimit<T, R>(items: readonly T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            const item = items[index];
            if (item !== undefined) results[index] = await mapper(item);
        }
    });
    await Promise.all(workers);
    return results;
}

/** Ranges of consecutive season numbers ("1–3, 5"), specials separate. */
export interface SeasonLabelParts { single: number | null; specialsOnly: boolean; ranges: string[]; hasSpecials: boolean }
export function seasonLabelParts(seasonNumbers: readonly number[]): SeasonLabelParts {
    const numbers = seasonNumbers.filter(n => n > 0);
    const ranges: string[] = [];
    for (let i = 0; i < numbers.length;) {
        let j = i;
        while (j + 1 < numbers.length && numbers[j + 1] === (numbers[j] ?? NaN) + 1) j++;
        ranges.push(j > i ? `${numbers[i]}–${numbers[j]}` : String(numbers[i]));
        i = j + 1;
    }
    const hasSpecials = seasonNumbers.includes(0);
    return {
        single: ranges.length === 1 && !hasSpecials && numbers.length === 1 ? (numbers[0] ?? null) : null,
        specialsOnly: ranges.length === 0 && hasSpecials,
        ranges, hasSpecials
    };
}

export interface SeasonEntry { number: number; services: StreamingService[]; link: string | undefined }
export interface SeasonGroup { numbers: number[]; services: StreamingService[] }
/** Seasons grouped by identical provider sets; null when every season matches. */
export function groupSeasonsByProviders(seasons: readonly SeasonEntry[]): SeasonGroup[] | null {
    const byProviders = new Map<string, SeasonGroup>();
    for (const season of seasons) {
        const key = season.services.map(service => service.provider_id ?? NaN).sort((a, b) => a - b).join(',');
        let group = byProviders.get(key);
        if (!group) byProviders.set(key, group = { services: season.services, numbers: [] });
        group.numbers.push(season.number);
    }
    if (byProviders.size <= 1) return null;
    const groups = [...byProviders.values()].filter(group => group.services.length > 0);
    return groups.length > 0 ? groups : null;
}

/** "A", "A and B", "A, B and C". */
export function joinRegionNames(names: readonly string[]): string {
    if (names.length === 1) return names[0] ?? '';
    if (names.length === 2) return names.join(' and ');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

/** regions.txt: `CODE<TAB>Name` lines, `#` comments. */
export function parseRegions(textContent: string): Record<string, string> {
    const regions: Record<string, string> = {};
    for (const line of textContent.trim().split('\n')) {
        if (line.startsWith('#')) continue;
        const [code, name] = line.split('\t');
        if (code && name) regions[code] = name;
    }
    return regions;
}
export function parseProviders(textContent: string): string[] {
    return textContent.trim().split('\n').filter(line => !line.startsWith('#') && line.trim() !== '');
}
export const FALLBACK_REGIONS: Readonly<Record<string, string>> = {
    US: 'United States', GB: 'United Kingdom', IN: 'India', CA: 'Canada',
    DE: 'Germany', FR: 'France', JP: 'Japan', AU: 'Australia',
    BR: 'Brazil', MX: 'Mexico', IE: 'Ireland', IT: 'Italy',
    ES: 'Spain', NL: 'Netherlands', SE: 'Sweden', NO: 'Norway',
    DK: 'Denmark', FI: 'Finland'
};
export const FALLBACK_PROVIDERS: readonly string[] = [
    'Netflix', 'Amazon Prime Video', 'Disney Plus', 'HBO Max',
    'Hulu', 'Apple TV Plus', 'Paramount Plus', 'Peacock',
    'JioCinema', 'Disney+ Hotstar', 'ZEE5', 'SonyLIV'
];

/** The user-facing reason for a failed TMDB lookup. */
export function streamingErrorMessage(error: unknown): string {
    const message = str(field(error, 'message')) || '';
    if (error instanceof TypeError && message === 'Failed to fetch') return 'TMDB API is unreachable.';
    // A non-JSON 200 (reverse proxy error page or middleware intercept).
    if (error instanceof SyntaxError) return 'Received an unexpected response from the server. Check your reverse proxy or Jellyfin configuration.';
    if (message.includes('401')) return 'Invalid TMDB API Key.';
    if (message.includes('404')) return 'The requested item could not be found on TMDB.';
    if (message.includes('429')) return 'Too many requests. Please wait a moment and try again.';
    // JE.core.api throws Error('HTTP <status>') for non-OK responses.
    if (message.startsWith('HTTP 5')) return 'The TMDB service is temporarily unavailable. Please try again later.';
    return message || 'An unknown error occurred';
}

/** Saved per-user settings, with the admin region as the default. */
export interface UserElsewhere { region: string; regions: string[]; services: string[]; seasonProviders: boolean }
export function readUserElsewhere(value: unknown, defaultRegion: string): UserElsewhere {
    return {
        region: text(field(value, 'Region')) || defaultRegion,
        regions: Array.isArray(field(value, 'Regions')) ? list(field(value, 'Regions')).filter((code): code is string => typeof code === 'string') : [],
        services: Array.isArray(field(value, 'Services')) ? list(field(value, 'Services')).filter((name): name is string => typeof name === 'string') : [],
        seasonProviders: field(value, 'SeasonProviders') !== false
    };
}
