import { IDS, COLORS } from './rating-data';
import type { RatingSourceId } from './rating-data';
import { createRatingView, sourceName } from './rating-view';
import type { RatingViewHost } from './rating-view';
export interface RatingSettings {
    ratingTagsSources?: unknown;
    ratingTagsShowCommunity?: unknown;
    ratingTagsShowCritic?: unknown;
    ratingTagsMinScore?: unknown;
    ratingTagsColorByScore?: unknown;
}
export interface RatingConfig {
    RatingTagsSources?: unknown;
    RatingTagsShowCommunity?: unknown;
    RatingTagsShowCritic?: unknown;
    RatingTagsMinScore?: unknown;
    RatingTagsColorByScore?: unknown;
}
export interface RatingPolicy {
    sources: RatingSourceId[];
    minimum: number;
    color: boolean;
}
export interface RatingFact {
    id: RatingSourceId;
    value: number;
    text: string;
    color: string | null;
}
export function isRatingSource(value: unknown): value is RatingSourceId {
    return typeof value === 'string' && IDS.some(id => id === value);
}
export function normalizeSources(value: unknown): RatingSourceId[] | null {
    return Array.isArray(value) ? [...new Set(value.filter(isRatingSource))] : null;
}
export function settings(user: RatingSettings = {}, admin: RatingConfig = {}): RatingPolicy {
    const enabled = (personal: unknown, server: unknown) => typeof personal === 'boolean' ? personal : server !== false;
    const minimum = Number(user.ratingTagsMinScore ?? admin.RatingTagsMinScore ?? 0);
    return {
        sources: normalizeSources(user.ratingTagsSources) ?? (['critic', 'community'] as const).filter(id => id === 'community'
            ? enabled(user.ratingTagsShowCommunity, admin.RatingTagsShowCommunity)
            : enabled(user.ratingTagsShowCritic, admin.RatingTagsShowCritic)),
        minimum: Number.isFinite(minimum) ? Math.max(0, Math.min(10, minimum)) : 0,
        color: (user.ratingTagsColorByScore ?? admin.RatingTagsColorByScore) === true,
    };
}
export function maximum(id: RatingSourceId): number {
    return id === 'community' || id === 'imdb' || id === 'myAnimeList' || id === 'metacriticUser' ? 10 : id === 'letterboxd' ? 5 : id === 'rogerEbert' ? 4 : 100;
}
export function scoreColor(score: number): string {
    if (score < 5)
        return '#ef5350';
    if (score >= 7.5)
        return '#66bb6a';
    const t = (score - 5) / 2.5;
    return '#' + [255 - 153 * t, 179 + 8 * t, 106 * t].map(n => Math.round(n).toString(16).padStart(2, '0')).join('');
}
function valueOf(ratings: unknown, id: RatingSourceId): unknown {
    if (!ratings || typeof ratings !== 'object')
        return null;
    const values: Record<string, unknown> = Object.fromEntries(Object.entries(ratings));
    return values[id] ?? values[id.charAt(0).toUpperCase() + id.slice(1)] ?? null;
}
export function resolve(community: unknown, critic: unknown, ratings: unknown, conf: RatingPolicy, localNumber: (text: string) => string = String): RatingFact[] {
    return conf.sources.flatMap(id => {
        const raw = id === 'community' ? community : id === 'critic' ? critic : valueOf(ratings, id);
        if (raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw)))
            return [];
        const value = Math.max(0, Math.min(maximum(id), Number(raw)));
        const score = value * 10 / maximum(id);
        if (score < conf.minimum)
            return [];
        const text = id === 'community' && value === 0 ? '—' : localNumber(maximum(id) <= 10
            ? value.toFixed(1) : Math.round(value) + (id === 'metacritic' ? '' : '%'));
        return [{ id, value, text, color: conf.color ? scoreColor(score) : null }];
    });
}
export interface RatingHost extends RatingViewHost {
    settings(): RatingSettings;
    config(): RatingConfig;
    localNumber(text: string): string;
}
export function createRatingSources(host: RatingHost) {
    const policy = (user = host.settings(), admin = host.config()) => settings(user, admin);
    return {
        IDS, COLORS, normalizeSources, settings: policy, scoreColor,
        name: (id: RatingSourceId) => sourceName(id, host.translate),
        resolve: (community: unknown, critic: unknown, ratings: unknown, conf = policy()) => resolve(community, critic, ratings, conf, host.localNumber),
        chip: createRatingView(host).chip,
    };
}
export type RatingSources = ReturnType<typeof createRatingSources>;
