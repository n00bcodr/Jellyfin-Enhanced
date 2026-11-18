import { discoveryContext, discoveryHost, type SeerrDiscoveryHost } from '../host-discovery';
import type { RecommendationsInternals, RecommendationsStage } from './types';

export const LOG_PREFIX = '🪼 Jellyfin Enhanced: Recommendations:';
export const PAGE_ID = 'je-recommendations-page';
export const CATEGORY_PAGE_ID = 'je-recommendations-category-page';
export const PLUGIN_PAGE_LINK = 'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.RecommendationsPage"]';
/** The category pages' order (kept on its own: the page itself has none). */
export const SORT_MODULE = 'recommendationsCategory';
/**
 * All | Movies | Series and the further filters of the "More from" sections, kept under one module for the page and
 * every category page opened from it: what is set on one is set on the others. Where the page's address holds them
 * (Home's tab, the page of its own), it says what is set (discovery/address.ts).
 */
export const FILTER_MODULE = 'recommendations';
/** Any other visible main page, which a hidden recommendations page must not cover up by restoring. */
export const OTHER_PAGE = `.mainAnimatedPage:not(.hide):not(#${PAGE_ID}):not(#${CATEGORY_PAGE_ID})`;

export function recommendationsHost(): { JE: SeerrDiscoveryHost; P: RecommendationsStage } {
    const { JE } = discoveryHost();
    const own = discoveryContext(JE).own;
    return { JE, P: own.recommendationsPage ?? (own.recommendationsPage = {}) };
}
/** A part another entry published. Read at call time: the entries form a cycle at runtime. */
export function part<K extends keyof RecommendationsInternals>(P: RecommendationsStage, key: K): NonNullable<RecommendationsStage[K]> {
    const value = P[key];
    if (value === undefined || value === null) throw new Error(`Recommendations module "${key}" is not loaded`);
    return value;
}
