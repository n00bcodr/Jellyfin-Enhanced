/**
 * Details-page dispatcher: the debounced item-details observer, the Hide
 * button on detail pages, and the per-item-type feature gating.
 */
import { bridge, currentUserId, api, detailsContext } from './host';
import type { DetailsFeatures, DetailsPageBridge, HiddenContentFacade, HiddenItemData } from './host';
import { detailsLease, hashItemId, lookupDetailsItem, lookupItem, visibleDetailPage } from './page';
import { decodeDetailsItem, field } from './wire';
import type { DetailsItem } from './wire';

const JE = bridge<DetailsPageBridge>('Details page features');
const ctx = detailsContext(JE);
// `JE.internals ??= {}` at load, as before; media-tags' people tags are its `peopleTags` facade (ctx.peer, step C4).
void ctx.own.features;
const features = (): DetailsFeatures => ctx.own.features ??= {};

// Cache the last item id and type to avoid repeated lookups.
let lastDetailsItemId: string | null = null;
let lastDetailsLease: ReturnType<typeof detailsLease> | null = null;
let lastDetailsItemType: string | null = null;
// A single-version item's only media source: the id Jellyfin's `.selectSource`
// will hold once it fills it, used as the chips' source until it has.
let lastDetailsDefaultSourceId: string | null = null;
// The pending item lookup, keyed by item so navigating away while it is pending
// neither blocks the new item's lookup nor lets the old answer land in its state.
let itemTypeFetch: { itemId: string; current(): boolean } | null = null;

// Types that support file size and watch progress
const FEATURES_SUPPORTED_TYPES: readonly string[] = ['Episode', 'Season', 'Series', 'Movie', 'BoxSet', 'Playlist'];
// Types that support audio languages (excludes BoxSet and Playlist)
const AUDIO_LANGUAGES_SUPPORTED_TYPES: readonly string[] = ['Episode', 'Season', 'Series', 'Movie'];
// Types that support hiding
const HIDE_SUPPORTED_TYPES: readonly string[] = ['Movie', 'Series', 'Episode', 'Season'];

function label(key: string, fallback: string): string {
    const value = JE.t(key);
    return value !== key ? value : fallback;
}
function singleSourceId(item: DetailsItem | null): string | null {
    const sources = item?.MediaSources;
    return sources?.length === 1 ? (sources[0]?.Id || null) : null;
}

/**
 * A "Hide" button in the item's action buttons (Movies, Series, Episodes,
 * Seasons and, when enabled, People). Episodes offer hiding the whole show.
 */
function addHideContentButton(hidden: HiddenContentFacade, itemId: string, visiblePage: Element, itemType: string | null): void {
    const settings = hidden.getSettings();
    if (!settings.enabled || !settings.showHideButtons) return;
    if (itemType === 'Person') {
        if (!settings.showButtonCast) return;
    } else {
        if (settings.showButtonDetails === false) return;
        if (!itemType || !HIDE_SUPPORTED_TYPES.includes(itemType)) return;
    }
    if (visiblePage.querySelector('.je-detail-hide-btn')) return;

    let buttonContainer: Element | null = null;
    for (const selector of ['.detailButtons', '.itemActionsBottom', '.mainDetailButtons', '.detailButtonsContainer']) {
        buttonContainer = visiblePage.querySelector(selector);
        if (buttonContainer) break;
    }
    if (!buttonContainer) return;

    const buttonLease = detailsLease(JE.session, itemId, visiblePage);
    const button = document.createElement('button');
    button.setAttribute('is', 'emby-button');
    button.className = 'button-flat detailButton emby-button je-detail-hide-btn';
    button.type = 'button';

    const hideLabel = label('hidden_content_hide_button', 'Hide');
    const hiddenLabel = label('hidden_content_already_hidden', 'Hidden');
    const unhideLabel = label('hidden_content_unhide', 'Unhide');

    const content = document.createElement('div');
    content.className = 'detailButton-content';
    button.appendChild(content);

    const renderContent = (text: string, iconName: string) => {
        content.replaceChildren();
        const icon = document.createElement('span');
        icon.className = 'material-icons detailButton-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = iconName || 'visibility';
        content.appendChild(icon);
        if (text) {
            const textSpan = document.createElement('span');
            textSpan.className = 'detailButton-icon-text';
            textSpan.textContent = text;
            content.appendChild(textSpan);
        }
    };

    const setHiddenState = () => {
        button.classList.add('je-already-hidden');
        button.setAttribute('aria-label', hiddenLabel);
        button.title = hiddenLabel;
        renderContent('', 'visibility_off');
        button.onmouseenter = () => { button.title = unhideLabel; };
        button.onmouseleave = () => { button.title = hiddenLabel; };
        button.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            if (!buttonLease.current()) return;
            hidden.unhideItem(itemId);
            setHideState();
        };
    };

    const setHideState = () => {
        button.classList.remove('je-already-hidden');
        button.setAttribute('aria-label', hideLabel);
        button.title = hideLabel;
        renderContent('', 'visibility');
        button.onmouseenter = null;
        button.onmouseleave = null;
        button.onclick = async event => {
            event.preventDefault();
            event.stopPropagation();
            if (!buttonLease.current()) return;
            const clickLease = detailsLease(JE.session, itemId, visiblePage);
            const nameEl = visiblePage.querySelector('.itemName, h1, h2, [class*="itemName"]');
            const itemName = nameEl?.textContent?.trim() || 'Unknown';

            // Full item data for TMDb ID and episode/series metadata
            let tmdbId = '', seriesId = '', seriesName = '';
            let seasonNumber: number | null = null, episodeNumber: number | null = null;
            try {
                const item = await lookupDetailsItem(JE.helpers, itemId, true);
                tmdbId = item?.ProviderIds.Tmdb || '';
                seriesId = item?.SeriesId || '';
                seriesName = item?.SeriesName || '';
                seasonNumber = item?.ParentIndexNumber ?? null;
                episodeNumber = item?.IndexNumber ?? null;
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: Could not fetch item metadata for hide button', err);
            }

            if (!clickLease.current()) return;
            const baseItemData: HiddenItemData = {
                itemId, name: itemName, type: itemType ?? '', tmdbId, seriesId, seriesName, seasonNumber, episodeNumber
            };
            if (itemType === 'Episode' && seriesId) {
                // Episode on a detail page: choose between the episode and the whole show.
                hidden.confirmAndHide(baseItemData, () => { if (clickLease.current()) setHiddenState(); }, {
                    showEpisodeChoice: true,
                    onChooseShow: async () => {
                        if (!clickLease.current()) return;
                        let seriesTmdbId = '';
                        try {
                            const series = decodeDetailsItem(await api().getItem(currentUserId(), seriesId));
                            seriesTmdbId = series?.ProviderIds.Tmdb || '';
                        } catch (err) {
                            console.warn('🪼 Jellyfin Enhanced: Could not fetch series metadata for hide-show action', err);
                        }
                        if (!clickLease.current()) return;
                        hidden.hideItem({ itemId: seriesId, name: seriesName || itemName, type: 'Series', tmdbId: seriesTmdbId, posterPath: '' });
                        setHiddenState();
                    }
                });
            } else {
                // Season (with series metadata), Movie or Series: standard hide.
                hidden.confirmAndHide(baseItemData, () => { if (clickLease.current()) setHiddenState(); });
            }
        };
    };

    if (hidden.isHidden(itemId)) setHiddenState();
    else setHideState();

    // Keep Jellyfin's overflow menu (three-dots) as the last action button.
    const moreButton = buttonContainer.querySelector('.btnMoreCommands');
    if (moreButton) buttonContainer.insertBefore(button, moreButton);
    else buttonContainer.appendChild(button);
}

// The chips JE adds to Jellyfin's primary info row.
const JE_INFO_CHIP = /\bmediaInfoItem-(watchProgress|fileSize|audioLanguage|releaseDate)\b/;
/**
 * Whether Jellyfin has rendered its own items into the info row: chips added
 * before it has would be wiped by that render and re-added (a flicker).
 */
function hasJellyfinInfo(container: Element): boolean {
    for (const child of container.children) {
        if (!JE_INFO_CHIP.test(child.className)) return true;
    }
    return false;
}

/**
 * Places the details-page features for the visible item. Idempotent: every
 * feature skips an item it has already placed. Early (unsettled) runs place
 * the chips only once Jellyfin's own info items are in the row; the settled
 * run places them regardless (some pages, e.g. seasons, leave the row empty).
 */
function runItemDetails(settled: boolean): void {
    const visiblePage = visibleDetailPage();
    if (!visiblePage) return;
    const container = visiblePage.querySelector<HTMLElement>('.itemMiscInfo.itemMiscInfo-primary');
    if (!container) return;

    try {
        const itemId = hashItemId();
        if (!itemId) return;

        if (lastDetailsItemId !== itemId || !lastDetailsLease?.current()) {
            visiblePage.querySelectorAll('.je-detail-hide-btn').forEach(button => button.remove());
            lastDetailsLease = detailsLease(JE.session, itemId, visiblePage);
            lastDetailsItemId = itemId;
            lastDetailsItemType = null;
            lastDetailsDefaultSourceId = null;
        }

        // Fetch the item type once per item to decide applicability
        if (!lastDetailsItemType) {
            if (itemTypeFetch?.itemId !== itemId || !itemTypeFetch.current()) {
                const lease = detailsLease(JE.session, itemId, visiblePage);
                const lookup = { itemId, current: lease.current };
                itemTypeFetch = lookup;
                lookupItem(JE.helpers, itemId, true)
                    .then(raw => {
                        if (itemTypeFetch === lookup) itemTypeFetch = null;
                        // The page moved on to another item: not its type or source.
                        if (lastDetailsItemId !== itemId || !lease.current()) return;
                        const item = decodeDetailsItem(raw);
                        // Missing/cancelled metadata is unknown, not a reason to recursively retry.
                        if (!item?.Type) return;
                        lastDetailsItemType = item?.Type || null;
                        lastDetailsDefaultSourceId = singleSourceId(item);
                        // Re-run once the type is known, without waiting for quiet.
                        runItemDetails(false);
                    })
                    .catch(() => { if (itemTypeFetch === lookup) itemTypeFetch = null; });
            }
            return;
        }
        const itemType = lastDetailsItemType;

        // Hide button on detail pages (including Person pages)
        const hiddenContent = ctx.peer('hiddenContent');
        if (hiddenContent) addHideContentButton(hiddenContent, itemId, visiblePage, itemType);

        // Spoiler Guard supports Series, Movie and BoxSet detail pages. Kept
        // before the media-info gate so it stays available when other detail
        // enhancements are off.
        const spoilerBlur = ctx.peer('spoilerBlur');
        const addSpoilerButton = spoilerBlur?.addSpoilerBlurButton;
        if ((itemType === 'Series' || itemType === 'Movie' || itemType === 'BoxSet') && typeof addSpoilerButton === 'function') {
            addSpoilerButton.call(spoilerBlur, itemId, visiblePage, itemType);
        }

        if (!FEATURES_SUPPORTED_TYPES.includes(itemType)) return;
        if (!settled && !hasJellyfinInfo(container)) return;

        // Jellyfin has filled the info row: its cast comes next.
        if (visit && visit.itemId === itemId && visit.view === visiblePage) startPeoplePrefetch(visit);

        // For a single-version item an empty select will hold its only
        // source, so use that id now (one request instead of two).
        const sourceSelect = visiblePage.querySelector<HTMLSelectElement>('.selectSource');
        const selectedSourceId = sourceSelect?.value
            || (sourceSelect && sourceSelect.options.length === 0 ? lastDetailsDefaultSourceId : null);
        const settings = JE.currentSettings;
        const chips = features();
        if (settings?.showWatchProgress) chips.displayWatchProgress?.(itemId, container, selectedSourceId);
        if (settings?.showFileSizes) chips.displayItemSize?.(itemId, container, selectedSourceId);
        if (settings?.showAudioLanguages && AUDIO_LANGUAGES_SUPPORTED_TYPES.includes(itemType)) {
            chips.displayAudioLanguages?.(itemId, container, selectedSourceId);
        }
        if (JE.pluginConfig?.ShowReleaseDates && JE.pluginConfig.TmdbEnabled && AUDIO_LANGUAGES_SUPPORTED_TYPES.includes(itemType)) {
            chips.displayReleaseDate?.(itemId, container);
        }
    } catch (e) {
        console.warn('🪼 Jellyfin Enhanced: Error in item details handler', e);
    }
}

// Two schedules over the page's mutation bursts: the settled one waits for
// 100 ms of quiet; the early one runs within ~100 ms even while Jellyfin is
// still building the page, placing the chips once the info row is filled.
const settledItemDetails = JE.helpers.debounce(() => runItemDetails(true), 100);
const earlyItemDetails = JE.helpers.debounce(() => runItemDetails(false), 16, { maxWait: 100 });
const handleItemDetails = () => {
    earlyItemDetails();
    settledItemDetails();
};

// ── Details visits ──────────────────────────────────────────────────────
// A visit starts when Jellyfin shows a freshly built details view and, once
// the item is known (the same shared lookup runItemDetails makes), starts the
// chips' item-stats and release lookups, which the chips then take over. What
// no chip took over is dropped when the visit ends. Restored views start no
// visit. People tags' requests start once Jellyfin has filled the info row.
interface Visit { itemId: string; view: Element; epoch: number; item: unknown; peopleStarted: boolean }
let visit: Visit | null = null;

function endDetailsVisit(): void {
    const ended = visit;
    if (!ended) return;
    visit = null;
    features().discardItemStatsPrefetch?.(ended);
    features().discardReleasePrefetch?.(ended);
    ctx.peer('peopleTags')?.leave?.(ended.itemId);
}

function beginDetailsVisit(view: Element, detail: unknown): void {
    endDetailsVisit();
    const itemId = hashItemId();
    const paramsId = field(field(detail, 'params'), 'id');
    if (!itemId || (paramsId && paramsId !== itemId)) return;
    const settings = JE.currentSettings || {};
    const config = JE.pluginConfig || {};
    if (!(settings.showWatchProgress || settings.showFileSizes || (config.ShowReleaseDates && config.TmdbEnabled)
        || (settings.peopleTagsEnabled && ctx.peer('peopleTags')))) return;
    // runItemDetails already knows this item (A, home, A again): no lookup.
    if (lastDetailsItemId === itemId && lastDetailsItemType) return;
    const userId = currentUserId();
    const getItemCached = JE.helpers.getItemCached;
    if (!userId || !getItemCached) return;
    const current: Visit = visit = { itemId, view, epoch: JE.session ? JE.session.getEpoch() : 0, item: null, peopleStarted: false };
    // The same cached lookup (key and promise) runItemDetails and Seerr make.
    getItemCached.call(JE.helpers, itemId, { userId }).then(item => {
        if (visit !== current || !item) return;
        current.item = item;
        // Best effort: Seerr's lookups waiting on this item go first.
        setTimeout(() => prefetchChipData(current), 0);
    }).catch(() => { /* runItemDetails looks it up again */ });
}

function visitLive(current: Visit): boolean {
    return visit === current
        && (!JE.session || JE.session.isCurrent(current.epoch))
        && hashItemId() === current.itemId
        && current.view.isConnected
        && !current.view.classList.contains('hide');
}

/** Starts the lookups the chips will make, under runItemDetails' switches and gates. */
function prefetchChipData(current: Visit): void {
    if (!visitLive(current)) return;
    const item = decodeDetailsItem(current.item);
    const settings = JE.currentSettings || {};
    const config = JE.pluginConfig || {};
    const sources = item?.MediaSources;
    const type = item?.Type ?? '';
    // The chips get the single version's id (what the select will hold), or
    // none without a version; with several versions the selection is unknown.
    if (FEATURES_SUPPORTED_TYPES.includes(type) && (settings.showWatchProgress || settings.showFileSizes)
        && (!sources || sources.length <= 1)) {
        features().prefetchItemStats?.(current.itemId, sources?.length === 1 ? (sources[0]?.Id || null) : null,
            { watchProgress: !!settings.showWatchProgress, fileSize: !!settings.showFileSizes }, current);
    }
    if (config.ShowReleaseDates && config.TmdbEnabled && AUDIO_LANGUAGES_SUPPORTED_TYPES.includes(type)) {
        features().prefetchReleaseDate?.(current.itemId, current.item, current);
    }
    // The info row was filled before the item came back.
    const row = current.view.querySelector('.itemMiscInfo.itemMiscInfo-primary');
    if (row && hasJellyfinInfo(row)) startPeoplePrefetch(current);
}

/** Starts people tags' people/info requests for the visit's cast, once. */
function startPeoplePrefetch(current: Visit): void {
    if (current.peopleStarted || !current.item || !visitLive(current)) return;
    current.peopleStarted = true;
    ctx.peer('peopleTags')?.prefetch?.(current.itemId, current.item, current.view, current.epoch);
}

JE.core.navigation.onViewPage((_view, _element, _hash, _itemPromise, rawEvent) => {
    const target = rawEvent?.target;
    if (target instanceof Element && target.id === 'itemDetailPage' && field(eventDetail(rawEvent), 'isRestored') !== true) {
        beginDetailsVisit(target, eventDetail(rawEvent));
    }
});
JE.core.navigation.onNavigate(() => {
    if (visit && hashItemId() !== visit.itemId) endDetailsVisit();
});
JE.session?.onUserChange('details-prefetch', () => {
    endDetailsVisit();
    lastDetailsItemId = null;
    lastDetailsLease = null;
    lastDetailsItemType = null;
    lastDetailsDefaultSourceId = null;
    itemTypeFetch = null;
    document.querySelectorAll('.je-detail-hide-btn').forEach(button => button.remove());
});

function eventDetail(event: Event | null): unknown {
    return event && 'detail' in event ? event.detail : undefined;
}

// Managed observer for item details. childList-only routes it through the
// shared body observer (Jellyfin re-renders the detail page's children on
// navigation).
JE.helpers.createObserver('item-details-info', () => handleItemDetails(), document.body, { childList: true, subtree: true });
// A cached detail page re-shown by a class toggle alone produces no childList
// mutation, so re-run on view show as well.
JE.helpers.onViewPage(() => handleItemDetails());
