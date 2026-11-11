/** Details-page media-info chips: watch progress, file size and audio languages. */
import { api, bridge, currentUserId, detailsContext, serverId } from './host';
import type { ChipSelection, DetailsFeatures, MediaInfoBridge, MediaLanguage, VisitHandle } from './host';
import { lookupItem } from './page';
import { decodeDetailsItem, field, isRecord, list, num, str } from './wire';
import type { DetailsItem, MediaStream } from './wire';
import { formatSize, nextWatchProgressMode, progressIconSvg, resolveWatchProgressMode, watchProgressText } from './media-info-domain';
import type { ItemStats, WatchProgress } from './media-info-domain';
import { navigateRoute, tagListRoute } from './links';

const JE = bridge<MediaInfoBridge>('Media info chips');
const ctx = detailsContext(JE);
const internal: DetailsFeatures = ctx.own.features ??= {};

const HOUR = 60 * 60 * 1000;
const WATCHPROGRESS_CACHE_TTL = HOUR;
const FILESIZE_CACHE_TTL = HOUR;
const LANGUAGE_CACHE_TTL = HOUR;
const ITEMSTATS_CACHE_TTL = HOUR;
interface CachedProgress extends WatchProgress { ts: number }
interface CachedSize { size: number | null; unavailable: boolean; ts: number }
interface Language { name: string; code: string }
interface CachedLanguages { languages: Language[]; unavailable: boolean; ts: number }
const watchProgressCache = new Map<string, CachedProgress>();
const fileSizeCache = new Map<string, CachedSize>();
const audioLanguageCache = new Map<string, CachedLanguages>();
/**
 * The watch-progress and file-size chips of one page share a single
 * /item-stats request. `prefetched` marks a details-visit prefetch; `visit`
 * and `ctl` are only kept until a chip takes it over (the entry outlives the
 * visit, which holds its view and item).
 */
interface StatsEntry { promise: Promise<unknown>; ts: number; prefetched: boolean; visit: VisitHandle | null; ctl: AbortController | null }
const itemStatsRequests = new Map<string, StatsEntry>();

const epochNow = () => JE.session ? JE.session.getEpoch() : 0;
const isEpochCurrent = (epoch: number) => !JE.session || JE.session.isCurrent(epoch);

// Watch progress is per-user (and item metadata is fetched with the signed-in
// user's access): never carry it across a user switch.
JE.session?.onUserChange('details-media-info', () => {
    watchProgressCache.clear();
    fileSizeCache.clear();
    audioLanguageCache.clear();
    // A prefetch no chip has taken over belongs to the previous user.
    for (const entry of itemStatsRequests.values()) {
        if (entry.visit) entry.ctl?.abort();
    }
    itemStatsRequests.clear();
});

function decodeStats(value: unknown): ItemStats {
    return {
        size: num(field(value, 'size')) ?? 0,
        progress: num(field(value, 'progress')) ?? 0,
        totalPlaybackTicks: num(field(value, 'totalPlaybackTicks')) ?? 0,
        totalRuntimeTicks: num(field(value, 'totalRuntimeTicks')) ?? 0
    };
}

/**
 * Size and watch progress of an item (and its children) in one request,
 * shared by every caller asking for the same item and media source.
 * Rejects on a failed request.
 */
function fetchItemStats(itemId: string, mediaSourceId: string | null, prefetchVisit: VisitHandle | null = null): Promise<unknown> {
    const key = `${itemId}|${mediaSourceId || ''}`;
    const now = Date.now();
    const existing = itemStatsRequests.get(key);
    if (existing && (now - existing.ts) < ITEMSTATS_CACHE_TTL) {
        if (existing.prefetched && !prefetchVisit) {
            // A chip takes over a details-visit prefetch. A failed prefetch is
            // never shown: the chip asks again (not after a user switch, where
            // the chip discards the answer anyway).
            existing.visit = null;
            existing.ctl = null;
            const claimEpoch = epochNow();
            return existing.promise.catch((error: unknown) => {
                if (!isEpochCurrent(claimEpoch)) throw error;
                return fetchItemStats(itemId, mediaSourceId);
            });
        }
        return existing.promise;
    }

    const path = `/item-stats/${currentUserId()}/${itemId}${mediaSourceId ? `?mediaSourceId=${encodeURIComponent(mediaSourceId)}` : ''}`;
    // Through JE's request limiter, which keeps sockets free for jellyfin-web's
    // own requests. A prefetch can be aborted, so one still queued when its
    // visit ends is never sent.
    const ctl = prefetchVisit ? new AbortController() : null;
    const plugin = JE.core?.api?.plugin;
    const promise = plugin
        ? plugin(path, ctl ? { skipRetry: true, signal: ctl.signal } : { skipRetry: true })
        : api().ajax({ type: 'GET', url: api().getUrl(`/JellyfinEnhanced${path}`), dataType: 'json' });
    const entry: StatsEntry = { promise, ts: now, prefetched: !!prefetchVisit, visit: prefetchVisit, ctl };
    itemStatsRequests.set(key, entry);
    // A failed request is not kept: the next visit may try again.
    promise.catch(() => {
        if (itemStatsRequests.get(key) === entry) itemStatsRequests.delete(key);
    });
    return promise;
}

/** Starts a visit's item-stats request when an enabled chip would request. */
function prefetchItemStats(itemId: string, mediaSourceId: string | null, { watchProgress, fileSize }: ChipSelection, visit: VisitHandle): void {
    if (!JE.core?.api?.plugin) return;
    const now = Date.now();
    const progress = watchProgressCache.get(itemId);
    const size = fileSizeCache.get(`${itemId}|${mediaSourceId || ''}`);
    const needed = (watchProgress && !(progress && (now - progress.ts) < WATCHPROGRESS_CACHE_TTL))
        || (fileSize && !(size && (now - size.ts) < FILESIZE_CACHE_TTL));
    if (needed) fetchItemStats(itemId, mediaSourceId, visit).catch(() => {});
}

/** Drops (and aborts, while queued) a visit's prefetches no chip took over. */
function discardItemStatsPrefetch(visit: VisitHandle): void {
    for (const [key, entry] of itemStatsRequests) {
        if (entry.visit !== visit) continue;
        entry.ctl?.abort();
        itemStatsRequests.delete(key);
    }
}

/** Resolves in the next animation frame, so a chip's small write lands with its layout pass. */
function nextFrame(): Promise<void> {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

const LOADING_HTML = `<span class="material-icons" style="font-size: inherit; margin-right: 0.3em;">hourglass_empty</span> ...`;
const timeFormat = () => JE.currentSettings?.watchProgressTimeFormat || 'hours';

function persistWatchProgressMode(mode: string): void {
    const settings = JE.currentSettings ??= {};
    settings.watchProgressMode = mode;
    if (typeof JE.saveUserSettings === 'function') JE.saveUserSettings('settings.json', settings);
}

/** Total watch progress (in %) of an item and its children. */
async function displayWatchProgress(itemId: string, container: HTMLElement, mediaSourceId: string | null = null): Promise<void> {
    // show itemMiscInfo if hidden like on season pages
    if (container.classList.contains('hide')) container.classList.remove('hide');

    const existing = container.querySelector<HTMLElement>('.mediaInfoItem-watchProgress');
    if (existing) {
        if (existing.dataset.itemId === itemId) return;
        existing.remove();
    }

    const now = Date.now();
    const cached = watchProgressCache.get(itemId);

    const placeholder = document.createElement('div');
    placeholder.className = 'mediaInfoItem mediaInfoItem-watchProgress';
    placeholder.dataset.itemId = itemId;
    placeholder.title = JE.t('watch_progress_tooltip');
    placeholder.style.display = 'flex';
    placeholder.style.verticalAlign = 'middle';
    placeholder.style.alignItems = 'center';
    placeholder.style.margin = '0 1em 0 0 !important';
    placeholder.style.cursor = 'pointer';

    // Cycles percentage → time → remaining on this chip (not another view's).
    placeholder.addEventListener('click', () => {
        const watchProgress = watchProgressCache.get(itemId);
        if (!watchProgress) return;
        const div = placeholder.querySelector<HTMLElement>('.mediaInfoItem-watchProgress-value');
        if (!div) return;
        const newMode = nextWatchProgressMode(div.dataset.type || 'percentage');
        div.dataset.type = newMode;
        div.innerHTML = watchProgressText(watchProgress, newMode, timeFormat());
        persistWatchProgressMode(newMode);
    });
    placeholder.innerHTML = LOADING_HTML;
    // Insert first so subsequent observer runs dedupe against it.
    container.appendChild(placeholder);

    const valueElement = (watchProgress: WatchProgress) => {
        const valueDiv = document.createElement('div');
        valueDiv.className = 'mediaInfoItem-watchProgress-value';
        const mode = resolveWatchProgressMode(JE.currentSettings?.watchProgressMode);
        valueDiv.dataset.type = mode;
        valueDiv.innerHTML = watchProgressText(watchProgress, mode, timeFormat());
        return valueDiv;
    };
    const render = (watchProgress: WatchProgress) => {
        placeholder.innerHTML = progressIconSvg(watchProgress.progress);
        placeholder.appendChild(valueElement(watchProgress));
    };
    const renderUnavailable = () => render({ progress: 0, totalPlaybackTicks: 0, totalRuntimeTicks: 0 });

    // The request starts right away; only the tiny DOM write waits for a frame.
    const useCached = !!(cached && (now - cached.ts) < WATCHPROGRESS_CACHE_TTL);
    const statsPromise = useCached ? null : fetchItemStats(itemId, mediaSourceId);
    // Handled below; keeps an early failure from being reported as unhandled.
    statsPromise?.catch(() => {});
    const performFetch = async () => {
        if (cached && useCached) {
            // Known value: fill it in straight away, so a re-placed chip never flashes "...".
            if (!cached.progress) {
                renderUnavailable();
                return;
            }
            render(cached);
            return;
        }
        // A response resolving after a user switch must not repopulate the reset cache.
        const requestEpoch = epochNow();
        try {
            const stats = decodeStats(await statsPromise);
            await nextFrame();
            const watchProgress: CachedProgress = {
                progress: stats.progress, totalPlaybackTicks: stats.totalPlaybackTicks, totalRuntimeTicks: stats.totalRuntimeTicks, ts: now
            };
            if (!isEpochCurrent(requestEpoch)) return;
            render(watchProgress);
            watchProgressCache.set(itemId, watchProgress);
        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: Error fetching watch progress for ID %s:', itemId, error);
            if (!isEpochCurrent(requestEpoch)) return;
            // The placeholder stays so this page does not ask again; a failure is not cached, the next visit does.
            renderUnavailable();
        }
    };
    void performFetch();
}

const SAVE_ICON = `<span class="material-icons" style="font-size: inherit; margin-right: 0.3em;">save</span>`;

/** Total file size of an item (for the selected media source) on its details page. */
async function displayItemSize(itemId: string, container: HTMLElement, mediaSourceId: string | null = null): Promise<void> {
    const requestEpoch = epochNow();
    const isCurrent = () => isEpochCurrent(requestEpoch);
    const cacheKey = `${itemId}|${mediaSourceId || ''}`;
    const existing = container.querySelector<HTMLElement>('.mediaInfoItem-fileSize');
    if (existing) {
        if (existing.dataset.itemId === itemId && existing.dataset.sourceId === (mediaSourceId || '')) return;
        existing.remove();
    }

    const now = Date.now();
    const cached = fileSizeCache.get(cacheKey);

    const placeholder = document.createElement('div');
    placeholder.className = 'mediaInfoItem mediaInfoItem-fileSize';
    placeholder.dataset.itemId = itemId;
    placeholder.dataset.sourceId = mediaSourceId || '';
    placeholder.title = JE.t('file_size_tooltip');
    placeholder.style.display = 'flex';
    placeholder.style.alignItems = 'center';
    placeholder.style.margin = '0 1em 0 0 !important';
    placeholder.innerHTML = LOADING_HTML;
    container.appendChild(placeholder);

    const renderUnavailable = () => { placeholder.innerHTML = `${SAVE_ICON} -`; };
    const renderSize = (size: number) => {
        placeholder.style.verticalAlign = 'middle';
        placeholder.innerHTML = `${SAVE_ICON}${formatSize(size)}`;
    };

    const useCached = !!(cached && (now - cached.ts) < FILESIZE_CACHE_TTL);
    const statsPromise = useCached ? null : fetchItemStats(itemId, mediaSourceId);
    statsPromise?.catch(() => {});
    const performFetch = async () => {
        if (cached && useCached) {
            if (cached.unavailable || !cached.size) {
                renderUnavailable();
                return;
            }
            renderSize(cached.size);
            return;
        }
        try {
            const stats = decodeStats(await statsPromise);
            await nextFrame();
            if (!isCurrent()) return;
            if (stats.size > 0) {
                renderSize(stats.size);
                fileSizeCache.set(cacheKey, { size: stats.size, unavailable: false, ts: now });
            } else {
                renderUnavailable();
                fileSizeCache.set(cacheKey, { size: null, unavailable: true, ts: now });
            }
        } catch (error) {
            if (!isCurrent()) return;
            console.error('🪼 Jellyfin Enhanced: Error fetching item size for ID %s:', itemId, error);
            renderUnavailable();
        }
    };
    void performFetch();
}

// Flag resolution is shared with the Language Tags overlay (core media-language).
function mediaLanguage(): MediaLanguage {
    const language = JE.core?.mediaLanguage;
    if (!language) throw new Error('Jellyfin Enhanced media-language module unavailable');
    return language;
}

/** One item through Enhanced's region-aware tag-data projection, or null. */
async function fetchTagDataItem(userId: string | null, itemId: string, mediaSourceId: string | null = null): Promise<DetailsItem | null> {
    try {
        const client = api();
        const response = await client.ajax({
            type: 'POST',
            url: client.getUrl(`/JellyfinEnhanced/tag-data/${userId}`, mediaSourceId ? { mediaSourceId } : {}),
            data: JSON.stringify([itemId]),
            contentType: 'application/json',
            dataType: 'json'
        });
        return decodeDetailsItem(list(field(response, 'Items'))[0]);
    } catch {
        return null;
    }
}

/** The first episode of a series or season, for language detection. */
async function fetchFirstEpisodeForLanguage(userId: string | null, parentId: string, firstEpisodeId: string | null = null): Promise<DetailsItem | null> {
    // The parent /tag-data response normally identifies its first episode.
    if (firstEpisodeId) {
        const enriched = await fetchTagDataItem(userId, firstEpisodeId);
        if (enriched) return enriched;
    }
    // Native lookup is retained only as a compatibility fallback. A failed one rejects: unknown is not "no episode".
    const client = api();
    const response = await client.ajax({
        type: 'GET',
        url: client.getUrl('/Items', {
            ParentId: parentId, IncludeItemTypes: 'Episode', IsVirtualItem: false, Recursive: true,
            SortBy: 'PremiereDate', SortOrder: 'Ascending', Limit: 1, Fields: 'MediaStreams,MediaSources', userId: userId ?? ''
        }),
        dataType: 'json'
    });
    const episode = decodeDetailsItem(list(field(response, 'Items'))[0]);
    if (!episode?.Id) return episode;
    return await fetchTagDataItem(userId, episode.Id) || episode;
}

// Language code -> { baseTag, variantTag }
interface LanguageTagNames { baseTag: string | null; variantTag: string | null }
const languageTagNameCache = new Map<string, LanguageTagNames>();

/** Language code → the item's regional tag, else its base tag (links feature on only). */
async function loadLanguageTagMap(itemId: string, languages: Language[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const cfg = JE.pluginConfig;
    if (!cfg?.AudioLanguageTagSyncEnabled || !cfg.AudioLanguageTagShowAsLinks) return map;
    try {
        const codes = [...new Set(languages.map(language => language.code))];
        const unknown = codes.filter(code => !languageTagNameCache.has(code));
        const client = api();
        const [item, names] = await Promise.all([
            lookupItem(JE.helpers, itemId, false),
            unknown.length
                ? client.ajax({ type: 'GET', url: client.getUrl('/JellyfinEnhanced/audio-language-tags', { codes: unknown.join(',') }), dataType: 'json' })
                : Promise.resolve({})
        ]);
        if (isRecord(names)) {
            for (const [code, tags] of Object.entries(names)) {
                languageTagNameCache.set(code, {
                    baseTag: str(field(tags, 'baseTag')) ?? str(field(tags, 'BaseTag')) ?? null,
                    variantTag: str(field(tags, 'variantTag')) ?? str(field(tags, 'VariantTag')) ?? null
                });
            }
        }
        const itemTags = new Map((decodeDetailsItem(item)?.Tags ?? []).map(tag => [tag.toLowerCase(), tag]));
        for (const code of codes) {
            const tags = languageTagNameCache.get(code);
            if (!tags) continue;
            const found = [tags.variantTag, tags.baseTag]
                .filter((tag): tag is string => !!tag)
                .map(tag => itemTags.get(tag.toLowerCase()))
                .find((tag): tag is string => !!tag);
            if (found) map.set(code, found);
        }
    } catch {
        // Chips render as plain text without links
    }
    return map;
}

function createLanguageTagLink(tag: string): HTMLAnchorElement {
    const route = tagListRoute(tag, serverId());
    const link = document.createElement('a');
    link.className = 'audio-language-link';
    link.href = `#!/${route}`;
    link.title = tag;
    link.style.color = 'inherit';
    link.style.textDecoration = 'none';
    link.addEventListener('mouseenter', () => { link.style.textDecoration = 'underline'; });
    link.addEventListener('mouseleave', () => { link.style.textDecoration = 'none'; });
    link.addEventListener('click', event => {
        event.preventDefault();
        navigateRoute(route);
    });
    return link;
}

/** Distinct audio languages of the streams, in first-seen order. */
function collectLanguages(groups: (MediaStream[] | undefined)[]): Language[] {
    const languages = new Map<string, Language>();
    for (const streams of groups) {
        for (const stream of streams ?? []) {
            if (stream.Type !== 'Audio') continue;
            const code = stream.Language;
            if (!code || mediaLanguage().isLanguageless(code)) continue;
            let name: string;
            try {
                name = mediaLanguage().displayName(code);
            } catch {
                name = code.toUpperCase();
            }
            const language = { name, code };
            const key = JSON.stringify(language);
            if (!languages.has(key)) languages.set(key, language);
        }
    }
    return [...languages.values()];
}

/** Audio languages of an item (and its children) on its details page. */
async function displayAudioLanguages(itemId: string, container: HTMLElement, mediaSourceId: string | null = null): Promise<void> {
    const requestEpoch = epochNow();
    const isCurrent = () => isEpochCurrent(requestEpoch);
    const cacheKey = `${itemId}|${mediaSourceId || ''}`;
    if (container.classList.contains('hide')) container.classList.remove('hide');

    const existing = container.querySelector<HTMLElement>('.mediaInfoItem-audioLanguage');
    if (existing) {
        if (existing.dataset.itemId === itemId && existing.dataset.sourceId === (mediaSourceId || '')) return;
        existing.remove();
    }

    const placeholder = document.createElement('div');
    placeholder.className = 'mediaInfoItem mediaInfoItem-audioLanguage';
    placeholder.dataset.itemId = itemId;
    placeholder.dataset.sourceId = mediaSourceId || '';
    placeholder.title = JE.t('audio_language_tooltip');
    placeholder.style.display = 'flex';
    placeholder.style.verticalAlign = 'middle';
    placeholder.style.alignItems = 'center';
    placeholder.style.margin = '0 1em 0 0 !important';
    placeholder.innerHTML = LOADING_HTML;
    container.appendChild(placeholder);

    const applyLangStyles = (el: HTMLElement) => {
        el.title = JE.t('audio_language_tooltip');
        el.style.display = 'flex';
        el.style.verticalAlign = 'middle';
        el.style.alignItems = 'center';
        el.style.flexDirection = 'row';
        el.style.justifyContent = 'center';
        el.style.flexWrap = 'wrap';
        el.style.textAlign = 'center';
        el.style.gap = '0.1em';
        try { el.style.setProperty('white-space', 'normal', 'important'); } catch { el.style.whiteSpace = 'normal'; }
    };
    const renderUnavailable = () => {
        applyLangStyles(placeholder);
        placeholder.innerHTML = `<span class="material-icons" style="font-size: inherit; margin-right: 0.3em;">translate</span> -`;
    };
    const renderLanguages = (languages: Language[], tagMap: Map<string, string> = new Map()) => {
        placeholder.innerHTML = '';
        placeholder.style.display = 'flex';
        placeholder.style.alignItems = 'center';
        placeholder.style.gap = '0.5em';
        placeholder.title = JE.t('audio_language_tooltip');

        const icon = document.createElement('span');
        icon.className = 'material-icons';
        icon.style.fontSize = 'inherit';
        icon.style.flexShrink = '0';
        icon.textContent = 'translate';
        placeholder.appendChild(icon);

        const scrollContainer = document.createElement('div');
        scrollContainer.className = 'audio-languages-container';
        scrollContainer.style.display = 'flex';
        scrollContainer.style.flexWrap = 'nowrap';
        scrollContainer.style.gap = '0.1em';
        scrollContainer.style.alignItems = 'center';
        scrollContainer.style.overflowY = 'hidden';

        if (languages.length > 3) { // more than 3 languages: scrollable
            scrollContainer.style.overflowX = 'auto';
            scrollContainer.style.scrollBehavior = 'smooth';
            scrollContainer.style.whiteSpace = 'nowrap';
            scrollContainer.style.maxWidth = '20em';
            scrollContainer.style.paddingBottom = '2px';
            scrollContainer.style.touchAction = 'pan-x';
            scrollContainer.style.setProperty('-webkit-overflow-scrolling', 'touch');
            // Hide scrollbar
            scrollContainer.style.setProperty('scrollbar-width', 'none');
            scrollContainer.style.setProperty('-ms-overflow-style', 'none');
            scrollContainer.style.overflowY = 'hidden';
            scrollContainer.addEventListener('wheel', event => {
                if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
                    scrollContainer.scrollLeft += event.deltaY;
                    event.preventDefault();
                }
            }, { passive: false });
            scrollContainer.style.setProperty('::-webkit-scrollbar', 'display: none');

            const indicator = document.createElement('span');
            indicator.className = 'scroll-indicator';
            indicator.style.display = 'inline-block';
            indicator.style.opacity = '0.7';
            indicator.style.fontSize = '0.9em';
            // Glyph is outside Jellyfin's web fonts; a direct generic family
            // avoids the body stack's CJK fallback walk (see icons.js).
            indicator.style.fontFamily = 'sans-serif';
            indicator.textContent = '⇆';
            placeholder.appendChild(indicator);
        }

        languages.forEach((language, index) => {
            const langSpan = document.createElement('span');
            langSpan.className = 'audio-language-item';
            langSpan.dataset.lang = language.code;
            langSpan.dataset.langName = language.name;
            langSpan.style.whiteSpace = 'nowrap';

            const countryCode = mediaLanguage().resolveFlag(language);
            if (countryCode) {
                const flag = document.createElement('img');
                flag.src = mediaLanguage().flagSrc(countryCode);
                flag.alt = `${language.name} flag`;
                flag.style.width = '18px';
                flag.style.marginRight = '0.3em';
                flag.style.borderRadius = '2px';
                // An unknown region subtag would 404 on the flag CDN.
                flag.onerror = () => flag.remove();
                langSpan.appendChild(flag);
            }

            const languageTag = tagMap.get(language.code);
            if (languageTag) {
                const link = createLanguageTagLink(languageTag);
                link.textContent = language.name;
                langSpan.appendChild(link);
            } else {
                langSpan.appendChild(document.createTextNode(language.name));
            }
            scrollContainer.appendChild(langSpan);

            if (index < languages.length - 1) {
                const separator = document.createElement('span');
                separator.style.margin = '0 0.25em';
                separator.textContent = ', ';
                separator.style.whiteSpace = 'nowrap';
                scrollContainer.appendChild(separator);
            }
        });
        placeholder.appendChild(scrollContainer);
    };

    // The lookups start right away; the chip is built in the next animation frame.
    const renderUnavailableInFrame = () => nextFrame().then(() => { if (isCurrent() && placeholder.isConnected) renderUnavailable(); });
    const renderLanguagesInFrame = async (languages: Language[]) => {
        const tagMap = await loadLanguageTagMap(itemId, languages);
        await nextFrame();
        if (isCurrent() && placeholder.isConnected) renderLanguages(languages, tagMap);
    };
    const cacheUnavailable = () => audioLanguageCache.set(cacheKey, { languages: [], unavailable: true, ts: Date.now() });
    const performFetch = async () => {
        const now = Date.now();
        const cached = audioLanguageCache.get(cacheKey);
        if (cached && (now - cached.ts) < LANGUAGE_CACHE_TTL) {
            if (cached.unavailable || cached.languages.length === 0) {
                renderUnavailable();
                return;
            }
            const tagMap = await loadLanguageTagMap(itemId, cached.languages);
            if (isCurrent() && placeholder.isConnected) renderLanguages(cached.languages, tagMap);
            return;
        }
        try {
            const userId = currentUserId();
            // Always prefer Enhanced's region-aware projection, including for a
            // selected version: native MediaStreams can reduce en-US to eng. The
            // native item stays only as a compatibility fallback.
            const item = await fetchTagDataItem(userId, itemId, mediaSourceId)
                || decodeDetailsItem(await lookupItem(JE.helpers, itemId, true, userId));
            if (!isCurrent()) return;
            if (!item) throw new TypeError(`Item ${itemId} is unavailable`);
            let sourceItem: DetailsItem = item;

            // Series/Season: the first episode carries the language info.
            if (item.Type === 'Series' || item.Type === 'Season') {
                const episode = item.Id ? await fetchFirstEpisodeForLanguage(userId, item.Id, item.FirstEpisodeId ?? null) : null;
                if (!isCurrent()) return;
                if (!episode) {
                    await renderUnavailableInFrame();
                    if (!isCurrent()) return;
                    cacheUnavailable();
                    return;
                }
                sourceItem = episode;
            }

            // /tag-data exposes its trimmed streams directly on MediaStreams;
            // native items keep them inside each MediaSource.
            const mediaSources = sourceItem.MediaSources;
            const selectedSource = mediaSourceId && mediaSources
                ? mediaSources.find(source => source.Id === mediaSourceId)
                : undefined;
            // For a selected version /tag-data lists each MediaSource by Id only and puts
            // that version's streams on the top level.
            const languages = selectedSource
                ? collectLanguages([selectedSource.MediaStreams ?? sourceItem.MediaStreams])
                : collectLanguages([sourceItem.MediaStreams, ...(mediaSources ?? []).map(source => source.MediaStreams)]);

            if (languages.length > 0) {
                await renderLanguagesInFrame(languages);
                if (!isCurrent()) return;
                audioLanguageCache.set(cacheKey, { languages, unavailable: false, ts: Date.now() });
            } else {
                await renderUnavailableInFrame();
                if (!isCurrent()) return;
                cacheUnavailable();
            }
        } catch (error) {
            if (!isCurrent()) return;
            console.error('🪼 Jellyfin Enhanced: Error fetching audio languages for %s:', itemId, error);
            await renderUnavailableInFrame();
        }
    };
    void performFetch();
}

// Shared with the details-page dispatcher (features-details-page.js).
internal.displayWatchProgress = displayWatchProgress;
internal.displayItemSize = displayItemSize;
internal.displayAudioLanguages = displayAudioLanguages;
internal.prefetchItemStats = prefetchItemStats;
internal.discardItemStatsPrefetch = discardItemStatsPrefetch;
