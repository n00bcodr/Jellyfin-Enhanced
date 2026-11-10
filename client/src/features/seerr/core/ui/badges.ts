import type { SeerrCoreHost } from '../../host-core';
import type { SeasonAnalysis } from '../contract';
import { isRecord, isSafeTmdbImagePath, isString } from '../decode';
import { analyzeSeasonStatuses, hasDownloads } from '../display';
import { DISPLAY, getBadgeConfig, resolveDisplayStatus } from '../status';
import type { SeerrMediaItem } from '../types';
import { LOG_UI, escapeWith, firstInstall, groupInternals, isAbortError } from '../runtime';


export interface Provider { provider_name: string; logo_path: string }
/** Well-formed providers of one title, or null when the answer is not a list. */
export function sanitizeProviders(list: unknown): Provider[] | null {
    if (!Array.isArray(list)) return null;
    const providers: Provider[] = [];
    for (const entry of list) {
        if (isRecord(entry) && isString(entry.provider_name) && isSafeTmdbImagePath(entry.logo_path)) {
            providers.push({ ...entry, provider_name: entry.provider_name, logo_path: entry.logo_path });
        }
    }
    return providers;
}
const configList = (value: unknown): string[] => value
    ? String(value).replace(/'/g, '').replace(/\n/g, ',').split(',').map(s => s.trim()).filter(Boolean) : [];

// Lookups that fire close together (a screenful of cards) go out as one
// /watch-providers request returning only the region's flat-rate list per
// title, kept per title in the core cache. Each card waits on its own signal;
// a batch request is aborted only once no card waits on any of its titles.
const PROVIDER_BATCH_DELAY_MS = 50;
const PROVIDER_BATCH_MAX = 100;
interface Waiter { resolve(value: Provider[] | null): void; reject(error: Error): void; detach(): void }
interface Batch { controller: AbortController; lookups: Lookup[] }
interface Lookup { lookupKey: string; region: string; key: string; cacheKey: string; waiters: Set<Waiter>; batch: Batch | null }

export function installBadges(host: SeerrCoreHost): void {
    const { JE, document, window } = host;
    if (!firstInstall(JE, 'ui-badges')) return;
    const internals = groupInternals(JE);
    const escapeHtml = escapeWith(JE);

    const badgeIconTemplates = new Map<string, HTMLTemplateElement>();
    function appendBadgeIcon(badge: HTMLElement, iconHtml: string): void {
        let template = badgeIconTemplates.get(iconHtml);
        if (!template) {
            template = document.createElement('template');
            template.innerHTML = iconHtml;
            badgeIconTemplates.set(iconHtml, template);
        }
        badge.appendChild(document.importNode(template.content, true));
    }

    function setStatusBadge(card: HTMLElement, item: SeerrMediaItem, seasonAnalysis?: SeasonAnalysis | null): void {
        const badge = card.querySelector<HTMLElement>('.jellyseerr-status-badge');
        const info = item.mediaInfo;
        if (!badge || !info) {
            if (badge) badge.style.display = 'none';
            return;
        }
        let status: number | null | undefined;
        if (item.mediaType === 'tv' && info.seasons) {
            const analysis = seasonAnalysis || analyzeSeasonStatuses(info.seasons, JE.t);
            status = analysis ? analysis.overallStatus : info.status;
        } else {
            status = info.status || 1;
        }
        const downloads = hasDownloads(item);
        const displayStatus = resolveDisplayStatus(status, downloads);
        const config = getBadgeConfig(displayStatus);
        if (!config) {
            badge.style.display = 'none';
            return;
        }
        if (!badge.firstChild) appendBadgeIcon(badge, config.icon);
        else badge.innerHTML = config.icon;
        badge.className = `jellyseerr-status-badge ${config.cssClass}`;
        badge.style.display = 'flex';
        if (displayStatus === DISPLAY.PARTIAL && item.mediaType === 'tv' && downloads) {
            badge.style.cursor = 'pointer';
            internals.addDownloadProgressHover?.(badge, item);
        }
    }

    const providerLookups = new Map<string, Lookup>();
    let queuedLookups: Lookup[] = [];
    let providerFlushTimer: number | null = null;
    const providerRegion = (): string => {
        const region = String(JE.pluginConfig?.DEFAULT_REGION || 'US').trim().toUpperCase();
        return /^[A-Z]{2}$/.test(region) ? region : 'US';
    };
    const abortError = (): Error => {
        const error = new Error('Request aborted');
        error.name = 'AbortError';
        return error;
    };
    function settleLookup(lookup: Lookup, settle: (waiter: Waiter) => void): void {
        if (providerLookups.get(lookup.lookupKey) === lookup) providerLookups.delete(lookup.lookupKey);
        for (const waiter of [...lookup.waiters]) {
            lookup.waiters.delete(waiter);
            waiter.detach();
            settle(waiter);
        }
    }
    function releaseLookup(lookup: Lookup): void {
        if (lookup.waiters.size > 0) return;
        const batch = lookup.batch;
        if (!batch) {
            providerLookups.delete(lookup.lookupKey);
            queuedLookups = queuedLookups.filter(l => l !== lookup);
            return;
        }
        if (batch.lookups.some(l => l.waiters.size > 0)) return;
        for (const l of batch.lookups) if (providerLookups.get(l.lookupKey) === l) providerLookups.delete(l.lookupKey);
        batch.controller.abort();
    }
    function flushProviderBatch(): void {
        if (providerFlushTimer !== null) window.clearTimeout(providerFlushTimer);
        providerFlushTimer = null;
        const first = queuedLookups[0];
        if (!first) return;
        const region = first.region;
        const lookups: Lookup[] = [];
        const rest: Lookup[] = [];
        for (const lookup of queuedLookups) (lookup.region === region && lookups.length < PROVIDER_BATCH_MAX ? lookups : rest).push(lookup);
        queuedLookups = rest;
        if (rest.length > 0) providerFlushTimer = window.setTimeout(flushProviderBatch, PROVIDER_BATCH_DELAY_MS);
        const batch: Batch = { controller: new AbortController(), lookups };
        for (const lookup of lookups) lookup.batch = batch;
        // An answer that lands after a user switch reaches the cards that asked, but is not cached.
        const epoch = JE.session?.getEpoch();
        const items = lookups.map(l => l.key).join(',');
        const api = JE.core?.api;
        const pending = api ? api.plugin(`/watch-providers?items=${items}&region=${region}`, { signal: batch.controller.signal, priority: 'low' })
            : Promise.reject(new Error('core API unavailable'));
        pending.then(data => {
            const results = isRecord(data) && isRecord(data.results) ? data.results : {};
            const cacheable = !JE.session || epoch === undefined || JE.session.isCurrent(epoch);
            for (const lookup of lookups) {
                const providers = sanitizeProviders(results[lookup.key]);
                if (providers && cacheable) {
                    try { JE.core?.api?.manager?.setCache?.(lookup.cacheKey, providers); }
                    catch (error) { console.debug(`${LOG_UI} Provider cache write skipped:`, error); }
                }
                settleLookup(lookup, waiter => waiter.resolve(providers));
            }
        }, (error: unknown) => {
            // Every card left: nobody is waiting.
            if (batch.controller.signal.aborted) return;
            // Dropped by the transport (user switch, low-priority queue full) is expected.
            if (!isAbortError(error)) console.warn(`${LOG_UI} Could not fetch provider icons for ${lookups.length} title(s):`, error);
            for (const lookup of lookups) settleLookup(lookup, waiter => waiter.resolve(null));
        });
    }
    /** One title's flat-rate providers for the admin's region (cache, or the next batch). */
    function getFlatrateProviders(mediaType: string, tmdbId: number, signal?: AbortSignal): Promise<Provider[] | null> {
        const region = providerRegion();
        const key = `${mediaType}:${tmdbId}`;
        const cacheKey = `providers:${region}:${key}`;
        const cached = sanitizeProviders(JE.core?.api?.manager?.getCached?.(cacheKey));
        if (cached) return Promise.resolve(cached);
        if (signal?.aborted) return Promise.reject(abortError());
        return new Promise<Provider[] | null>((resolve, reject) => {
            const lookupKey = `${region}:${key}`;
            let lookup = providerLookups.get(lookupKey);
            if (!lookup) {
                lookup = { lookupKey, region, key, cacheKey, waiters: new Set(), batch: null };
                providerLookups.set(lookupKey, lookup);
                queuedLookups.push(lookup);
                if (queuedLookups.length >= PROVIDER_BATCH_MAX) flushProviderBatch();
                else if (providerFlushTimer === null) providerFlushTimer = window.setTimeout(flushProviderBatch, PROVIDER_BATCH_DELAY_MS);
            }
            const owner = lookup;
            const onAbort = () => {
                owner.waiters.delete(waiter);
                reject(abortError());
                releaseLookup(owner);
            };
            const waiter: Waiter = { resolve, reject, detach: () => signal?.removeEventListener('abort', onAbort) };
            owner.waiters.add(waiter);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }
    function setHasIcons(container: HTMLElement, hasIcons: boolean): void {
        container.classList.toggle('has-icons', hasIcons);
        container.closest('.cardImageContainer')?.classList.toggle('jellyseerr-has-provider-icons', hasIcons);
    }
    /** "Elsewhere" streaming icons on a card, filtered by the admin's provider lists. */
    async function fetchProviderIcons(container: HTMLElement, tmdbId: number, mediaType: string, signal?: AbortSignal): Promise<void> {
        if (!container || !tmdbId || !mediaType) return;
        const config = JE.pluginConfig;
        if (!config?.TmdbEnabled) return;
        const defaults = configList(config.DEFAULT_PROVIDERS);
        const ignored = configList(config.IGNORE_PROVIDERS);
        try {
            let providers = await getFlatrateProviders(mediaType, tmdbId, signal);
            // A signalled lookup starts only for an on-screen card: detached means torn down meanwhile.
            if (signal && !container.isConnected) return;
            if (!providers || providers.length === 0) return;
            if (defaults.length > 0) providers = providers.filter(p => defaults.includes(p.provider_name));
            if (ignored.length > 0) {
                try {
                    const patterns = ignored.map(pattern => new RegExp(pattern, 'i'));
                    providers = providers.filter(p => !patterns.some(regex => regex.test(p.provider_name)));
                } catch (error) {
                    console.error(`${LOG_UI} Invalid regex in IGNORE_PROVIDERS setting.`, error);
                }
            }
            providers = providers.filter(p => isSafeTmdbImagePath(p.logo_path));
            for (const provider of providers.slice(0, 4)) {
                const img = document.createElement('img');
                // Decorative, low-priority logos; width/height reserve the square w92 logo's space.
                img.loading = 'lazy';
                img.decoding = 'async';
                if ('fetchPriority' in img) img.fetchPriority = 'low';
                img.width = 92;
                img.height = 92;
                img.alt = provider.provider_name || '';
                img.src = `https://image.tmdb.org/t/p/w92${provider.logo_path}`;
                img.title = provider.provider_name;
                img.onerror = () => {
                    img.remove();
                    if (container.childElementCount === 0) setHasIcons(container, false);
                };
                container.appendChild(img);
            }
            if (container.childElementCount > 0) setHasIcons(container, true);
        } catch (error) {
            // Cancelled by the card or dropped on a user switch: expected.
            if (signal?.aborted || isAbortError(error)) return;
            console.warn(`${LOG_UI} Could not fetch provider icons for TMDB ID ${tmdbId}:`, error);
        }
    }

    function addMediaTypeBadge(card: HTMLElement, item: SeerrMediaItem, imageContainer?: HTMLElement, label?: string): void {
        if (item.mediaType !== 'movie' && item.mediaType !== 'tv' && item.mediaType !== 'collection') return;
        const container = imageContainer || card.querySelector<HTMLElement>('.cardImageContainer');
        if (!container) return;
        const badge = document.createElement('div');
        if (item.mediaType === 'movie') {
            badge.className = 'jellyseerr-media-badge jellyseerr-media-badge-movie';
            badge.textContent = label ?? JE.t('jellyseerr_card_badge_movie');
        } else if (item.mediaType === 'tv') {
            badge.className = 'jellyseerr-media-badge jellyseerr-media-badge-series';
            badge.textContent = label ?? JE.t('jellyseerr_card_badge_series');
        } else {
            badge.className = 'jellyseerr-media-badge jellyseerr-media-badge-collection';
            badge.textContent = label ?? JE.t('jellyseerr_card_badge_collection');
        }
        container.appendChild(badge);
    }
    /** "Part of a collection" badge; its click is handled by the card container's delegated listeners. */
    function addCollectionMembershipBadge(card: HTMLElement, item: SeerrMediaItem, imageContainer?: HTMLElement): void {
        if (!item.collection || item.mediaType !== 'movie') return;
        const container = imageContainer || card.querySelector<HTMLElement>('.cardImageContainer');
        if (!container) return;
        const badge = document.createElement('div');
        badge.className = 'jellyseerr-collection-badge';
        badge.innerHTML = `<span class="material-icons">collections</span><span>${escapeHtml(item.collection.name ?? '') || JE.t('jellyseerr_card_badge_collection')}</span>`;
        badge.title = `Part of ${item.collection.name || 'collection'}`;
        container.appendChild(badge);
    }

    internals.setStatusBadge = setStatusBadge;
    internals.fetchProviderIcons = fetchProviderIcons;
    internals.isSafeTmdbImagePath = isSafeTmdbImagePath;
    internals.addMediaTypeBadge = addMediaTypeBadge;
    internals.addCollectionMembershipBadge = addCollectionMembershipBadge;
}
