/** Details-page release/air-date chips resolved from TMDB via the plugin proxy. */
import { api, bridge, currentUserId, detailsContext } from './host';
import type { DetailsFeatures, ReleaseBridge, VisitHandle } from './host';
import { lookupDetailsItem, sessionLease } from './page';
import { decodeDetailsItem } from './wire';
import type { DetailsItem } from './wire';
import { pathSegment } from './links';
import {
    episodeInfo, episodeReleaseInfo, formatReleaseDate, movieReleaseInfo, premiereDate,
    seasonReleaseInfo, seriesReleaseInfo, todayIso
} from './release-domain';
import type { ReleaseInfo } from './release-domain';

const JE = bridge<ReleaseBridge>('Release dates');
const ctx = detailsContext(JE);
const internal: DetailsFeatures = ctx.own.features ??= {};

const RELEASEDATE_CACHE_TTL = 60 * 60 * 1000; // 1 hour
// With guards on, an answer also depends on what this user has played, and
// nothing announces a change to that. Long enough to dedupe repeat calls.
const RELEASEDATE_GUARDED_CACHE_TTL = 30 * 1000;
const cacheTtl = () => (ctx.peer('spoilerBlur')?.hasAnyState?.() ? RELEASEDATE_GUARDED_CACHE_TTL : RELEASEDATE_CACHE_TTL);
const releaseDateCache = new Map<string, { infos: ReleaseInfo[]; ts: number }>();
/**
 * Lookups in flight, so a chip takes one over instead of starting another. A
 * details visit's prefetch has `visit` set and `claimed` once a chip took it
 * over; a chip's own lookup has no visit.
 */
interface ReleaseLookup { promise: Promise<ReleaseInfo[]>; visit: VisitHandle | null; claimed: boolean; ctl: AbortController | null }
const releaseLookups = new Map<string, ReleaseLookup>();

// Spoiler Guard shapes these answers per user and per title; a lookup started
// before a guard change compares this before it caches or draws anything.
let guardRevision = 0;
let releaseOwner: (() => boolean) | null = null;
function resetReleaseOwner(): void {
    guardRevision++;
    releaseOwner = null;
    releaseDateCache.clear();
    dropUnclaimedLookups();
    document.querySelectorAll('.mediaInfoItem-releaseDate').forEach(chip => chip.remove());
}
function currentReleaseOwner(): () => boolean {
    if (!releaseOwner || !releaseOwner()) {
        resetReleaseOwner();
        releaseOwner = sessionLease(JE.session);
    }
    return releaseOwner;
}

function dropUnclaimedLookups(): void {
    for (const entry of releaseLookups.values()) {
        if (entry.visit && !entry.claimed) entry.ctl?.abort();
    }
    releaseLookups.clear();
}
window.addEventListener('je:spoiler-state-changed', () => {
    guardRevision++;
    releaseDateCache.clear();
    dropUnclaimedLookups();
    document.querySelectorAll('.mediaInfoItem-releaseDate').forEach(chip => chip.remove());
});
// Prefetches no chip has taken over are aborted with their visit's.
JE.session?.onUserChange('release-dates', resetReleaseOwner);

/** A TMDB request that failed, already logged: unknown, so never kept as "no dates". */
class TmdbFailure extends Error {}
/** TMDB data, null when TMDB has no such title; rejects with a TmdbFailure when the request failed. */
function tmdbGet(path: string): Promise<unknown> {
    const client = api();
    const url = client.getUrl(`/JellyfinEnhanced/tmdb${path}`);
    return fetch(url, { headers: { Authorization: `MediaBrowser Token="${client.accessToken()}"`, 'X-Emby-Token': client.accessToken() } })
        .then((response): Promise<unknown> => response.ok ? response.json()
            : response.status === 404 ? Promise.resolve(null) : Promise.reject(`API Error: ${response.status}`))
        .catch((error: unknown) => {
            console.error(`🪼 Jellyfin Enhanced: Release Date: TMDB request failed for ${path}`, error);
            throw new TmdbFailure(String(error));
        });
}

async function resolveReleaseInfo(item: DetailsItem | null, userId: string | null): Promise<ReleaseInfo[]> {
    const mediaType = item?.Type;
    if (!item) return [];
    if (mediaType === 'Movie') {
        const tmdbId = item.ProviderIds.Tmdb;
        return tmdbId ? movieReleaseInfo(await tmdbGet(`/movie/${pathSegment(tmdbId)}/release_dates`), JE.pluginConfig?.DEFAULT_REGION) : [];
    }
    if (mediaType === 'Series') {
        const tmdbId = item.ProviderIds.Tmdb;
        return tmdbId ? seriesReleaseInfo(await tmdbGet(`/tv/${pathSegment(tmdbId)}`)) : [];
    }
    if (mediaType === 'Season' || mediaType === 'Episode') {
        // The show's TMDB id lives on the parent Series; the shared item cache
        // hands every module on the page the same fetch.
        // A series that could not be read rejects: unknown is not "no dates".
        const seriesTmdbId = item.SeriesId ? (await lookupDetailsItem(JE.helpers, item.SeriesId, true, userId))?.ProviderIds.Tmdb : undefined;
        if (!seriesTmdbId) return [];
        const show = pathSegment(seriesTmdbId);
        if (mediaType === 'Season') {
            return item.IndexNumber != null
                ? seasonReleaseInfo(await tmdbGet(`/tv/${show}/season/${item.IndexNumber}`), todayIso(new Date()))
                : [];
        }
        // An episode's own PremiereDate wins; TMDB only when it has none.
        const premiere = premiereDate(item.PremiereDate);
        if (premiere) return [episodeInfo(premiere)];
        return (item.ParentIndexNumber != null && item.IndexNumber != null)
            ? episodeReleaseInfo(await tmdbGet(`/tv/${show}/season/${item.ParentIndexNumber}/episode/${item.IndexNumber}`))
            : [];
    }
    return [];
}

/**
 * No dates is a valid outcome (most back-catalog items lack digital/physical
 * dates), so no chip is rendered rather than a dash. The hidden placeholder is
 * inserted synchronously so repeated observer calls dedupe against it.
 */
async function displayReleaseDate(itemId: string, container: HTMLElement): Promise<void> {
    const owner = currentReleaseOwner();
    const existing = container.querySelectorAll<HTMLElement>('.mediaInfoItem-releaseDate');
    if (existing.length > 0) {
        if (existing[0]?.dataset.itemId === itemId) return;
        existing.forEach(element => element.remove());
    }

    const now = Date.now();
    const cached = releaseDateCache.get(itemId);
    if (cached && (now - cached.ts) < cacheTtl()) {
        if (cached.infos.length > 0) renderReleaseDateChips(container, itemId, cached.infos);
        return;
    }

    const placeholder = document.createElement('div');
    placeholder.className = 'mediaInfoItem mediaInfoItem-releaseDate';
    placeholder.dataset.itemId = itemId;
    placeholder.style.display = 'none';
    container.appendChild(placeholder);

    const performFetch = async () => {
        let entry: ReleaseLookup | undefined;
        // A taken-over prefetch that fails after a user switch is not
        // retried as the previous user; no failure is cached as "no dates".
        const epoch = JE.session ? JE.session.getEpoch() : 0;
        const revision = guardRevision;
        let cutShort = false;
        try {
            const userId = currentUserId();
            const lookupNow = async () => resolveReleaseInfo(await lookupDetailsItem(JE.helpers, itemId, true, userId), userId);
            // Take over the visit's prefetch (or a lookup in flight) instead of
            // starting another; register this one so a later prefetch joins it.
            entry = releaseLookups.get(itemId);
            if (entry) entry.claimed = true;
            else releaseLookups.set(itemId, entry = { promise: lookupNow(), visit: null, claimed: true, ctl: null });
            const claimed = entry;
            // A failed prefetch is never shown: look it up now instead.
            const infos = claimed.visit
                ? await claimed.promise.catch((error: unknown) => {
                    if (!owner() || (JE.session && !JE.session.isCurrent(epoch))) {
                        cutShort = true;
                        throw error;
                    }
                    return lookupNow();
                })
                : await claimed.promise;
            if (releaseLookups.get(itemId) === claimed) releaseLookups.delete(itemId);
            const superseded = !owner() || revision !== guardRevision || (JE.session && !JE.session.isCurrent(epoch));
            if (superseded) {
                placeholder.remove();
                return;
            }
            releaseDateCache.set(itemId, { infos, ts: now });
            // The chips' small DOM write lands with the next frame's layout pass.
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            if (!owner() || revision !== guardRevision || !placeholder.isConnected) { placeholder.remove(); return; } // navigated away while fetching
            if (infos.length > 0) fillReleaseDateChips(placeholder, infos);
            else placeholder.remove();
        } catch (error) {
            if (entry && releaseLookups.get(itemId) === entry) releaseLookups.delete(itemId);
            placeholder.remove();
            if (cutShort || !owner() || revision !== guardRevision || (JE.session && !JE.session.isCurrent(epoch))) return;
            // Not cached: the next visit asks again.
            if (!(error instanceof TmdbFailure)) console.error(`🪼 Jellyfin Enhanced: Release Date: Error fetching release info for ${itemId}:`, error);
        }
    };
    void performFetch();
}

let releaseDateIconFontInjected = false;
function ensureReleaseDateIconFont(): void {
    if (releaseDateIconFontInjected) return;
    const addCSS = JE.helpers?.addCSS;
    if (!addCSS) throw new Error('Jellyfin Enhanced helpers unavailable');
    releaseDateIconFontInjected = true;
    addCSS('je-release-date-symbols', `
            .je-release-date-icon {
                font-family: 'JE Material Symbols Rounded';
                font-weight: normal;
                font-style: normal;
                line-height: 1;
                letter-spacing: normal;
                text-transform: none;
                display: inline-block;
                white-space: nowrap;
                word-wrap: normal;
                direction: ltr;
                -webkit-font-feature-settings: 'liga';
                -moz-font-feature-settings: 'liga';
                font-feature-settings: 'liga';
                -webkit-font-smoothing: antialiased;
            }
        `);
}

function fillReleaseDateChip(chip: HTMLElement, info: ReleaseInfo): void {
    ensureReleaseDateIconFont();
    chip.classList.add(`je-release-date-${info.type}`);
    chip.title = JE.t(info.titleKey);
    chip.style.display = 'inline-flex';
    chip.style.alignItems = 'center';
    chip.style.gap = '0.3em';
    chip.style.whiteSpace = 'nowrap';
    chip.style.margin = '0 1em 0 0 !important';
    const icon = document.createElement('span');
    icon.className = 'je-release-date-icon';
    icon.style.fontSize = 'inherit';
    icon.textContent = info.icon;
    const date = document.createElement('span');
    date.textContent = formatReleaseDate(info.date);
    chip.replaceChildren(icon, date);
}
// Each date is its own flex sibling (like every other stat chip in this row),
// so the row's flex-wrap breaks lines between whole chips.
function fillReleaseDateChips(placeholder: HTMLElement, infos: ReleaseInfo[]): void {
    const [first, ...rest] = infos;
    if (!first) return;
    fillReleaseDateChip(placeholder, first);
    let anchor: HTMLElement = placeholder;
    for (const info of rest) {
        const chip = document.createElement('div');
        chip.className = 'mediaInfoItem mediaInfoItem-releaseDate';
        chip.dataset.itemId = placeholder.dataset.itemId ?? '';
        fillReleaseDateChip(chip, info);
        anchor.after(chip);
        anchor = chip;
    }
}
/** Cache-hit path, where there's no placeholder to fill. */
function renderReleaseDateChips(container: HTMLElement, itemId: string, infos: ReleaseInfo[]): void {
    for (const info of infos) {
        const chip = document.createElement('div');
        chip.className = 'mediaInfoItem mediaInfoItem-releaseDate';
        chip.dataset.itemId = itemId;
        fillReleaseDateChip(chip, info);
        container.appendChild(chip);
    }
}

/**
 * Starts a details visit's release lookup before the chip is placed (the chip
 * takes it over). Nothing when a fresh answer is cached or a lookup is
 * already running. Through JE's request limiter.
 */
function prefetchReleaseDate(itemId: string, rawItem: unknown, visit: VisitHandle): void {
    currentReleaseOwner();
    const cached = releaseDateCache.get(itemId);
    if ((cached && (Date.now() - cached.ts) < cacheTtl()) || releaseLookups.has(itemId)) return;
    const ctl = new AbortController();
    const userId = currentUserId();
    const item = decodeDetailsItem(rawItem);
    const lookup = () => resolveReleaseInfo(item, userId);
    const manager = JE.core?.api?.manager;
    const promise = typeof manager?.withConcurrencyLimit === 'function'
        ? manager.withConcurrencyLimit(lookup, { signal: ctl.signal })
        : lookup();
    // A chip that takes it over handles a failure itself.
    promise.catch(() => {});
    releaseLookups.set(itemId, { promise, visit, claimed: false, ctl });
}

/** Drops (aborting while queued) a visit's prefetches no chip took over. */
function discardReleasePrefetch(visit: VisitHandle): void {
    for (const [itemId, entry] of releaseLookups) {
        if (entry.visit !== visit || entry.claimed) continue;
        entry.ctl?.abort();
        releaseLookups.delete(itemId);
    }
}

internal.displayReleaseDate = displayReleaseDate;
internal.prefetchReleaseDate = prefetchReleaseDate;
internal.discardReleasePrefetch = discardReleasePrefetch;
