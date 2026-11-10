import { apiClient, hasApiClient, type TagRuntimeBridge } from '../../host';
import { isRecord, own, record, stringList, type JsonRecord } from '../../pipeline/dto';
import type { TagCtx, TagSpec } from '../../pipeline/contract';
import { CATEGORY_BY_KEY, EDITIONS, EDITION_PREFIX, audioOrder, codecOrder, dynamicRangeOrder, qualityCss, resolutionOrder, specialFormatOrder } from './quality-data';
import { createQualityRules } from './quality-rules';

/** A computed set of labels and everything that could make it stale. */
interface QualityRecord extends JsonRecord {
    qualities: string[];
}
const CACHE_NAMING_VERSION = 26;
// /js/tags/qualitytags.js
// Jellyfin Quality Tags
// This is a modified version of the Jellyfin Quality Tags script by by BobHasNoSoul. - https://github.com/BobHasNoSoul/Jellyfin-Qualitytags/
//
// A spec over the core tag-renderer factory (js/core/tag-renderer-base.js),
// which owns the cache/ignore/tagged/CSS/reinitialize plumbing. The quality
// resolution engine (stream analysis, category bucketing/ordering, colors)
// is quality-specific and intentionally stays in this module.
export function createQualityTags(JE: TagRuntimeBridge) {

    const rules = createQualityRules({
        setting: key => JE.currentSettings?.[key] ?? JE.pluginConfig?.[key.charAt(0).toUpperCase() + key.slice(1)],
        preferredAudioLanguage: resolvePreferredAudioLanguage,
        legacyAudio: () => JE.core.tagLayout?.isLegacySettings() ?? true,
        language: () => JE.core.mediaLanguage,
    });
    const { aggregateQualities, aggregationCategoriesKey, aggregationPolicy, allValues, categorize, displayModeKey, distinctRank, getEnhancedQuality, legacyFullAudio, meetsMinimum, normalizeQualityLabel, readBool, readInt } = rules;
    const logPrefix = '🪼 Jellyfin Enhanced: Quality Tags:';
    const overlayClass = 'quality-overlay-label';
    const containerClass = 'quality-overlay-container';



    // Computed quality labels derived from server cache entries
    const serverQualityCache = new Map<string, QualityRecord>();

    // Jellyfin audio-language preference (user.Configuration.AudioLanguagePreference)
    // of the signed-in user, loaded by primeJellyfinAudioPreference(). Only
    // trusted while jellyfinAudioPreferenceUserId is still the current user.
    let jellyfinAudioPreference: string | null = null;
    let jellyfinAudioPreferenceUserId: string | null = null;
    let jellyfinAudioPreferencePromise: Promise<void> | null = null;
    let jellyfinAudioPreferencePromiseUserId: string | null = null;
    const currentUserId = (): string | null => (hasApiClient() ? apiClient().getCurrentUserId?.() || null : null);

    /**
     * Effective preferred audio language for the sound tag, or null for
     * "best track overall" (the pre-existing behaviour). Resolution order:
     * the user's own choice (a language code, "auto" = their Jellyfin audio
     * language, "none" = no preference), then the server default — each
     * user's Jellyfin audio language when the admin enabled that and the
     * user has one, else the admin's fixed language.
     * */
    function resolvePreferredAudioLanguage(): string|null {
        const choice = String(JE.currentSettings?.qualityTagsPreferredAudioLanguage || '').trim();
        const lowered = choice.toLowerCase();
        if (lowered === 'none') return null;
        const userId = currentUserId();
        const jellyfinPref = (userId && userId === jellyfinAudioPreferenceUserId)
            ? jellyfinAudioPreference
            : null;
        if (lowered === 'auto') return jellyfinPref;
        if (choice) return choice;
        if (JE.pluginConfig?.QualityTagsAudioLanguageFromUser && jellyfinPref) return jellyfinPref;
        return String(JE.pluginConfig?.QualityTagsPreferredAudioLanguage || '').trim() || null;
    }

    /**
     * Whether the effective preference depends on the user's Jellyfin audio
     * language: they picked "auto", or they inherit the server default and
     * the admin turned on "use each user's Jellyfin audio language".
     * */
    function usesJellyfinAudioPreference(): boolean {
        const choice = String(JE.currentSettings?.qualityTagsPreferredAudioLanguage || '').trim().toLowerCase();
        if (choice === 'auto') return true;
        return !choice && !!JE.pluginConfig?.QualityTagsAudioLanguageFromUser;
    }

    /**
     * Loads the signed-in user's Jellyfin audio language preference when the
     * effective setting needs it (no request otherwise). One request per
     * user at a time; a failure is logged and keeps whatever was loaded
     * (no preference for a user with nothing loaded yet).
     * */
    function primeJellyfinAudioPreference(): Promise<void> {
        const userId = currentUserId();
        if (!userId || !usesJellyfinAudioPreference()) return Promise.resolve();
        // Reuse a request already in flight for this user; one started for a
        // previous user (switch mid-flight) resolves as a no-op below.
        if (jellyfinAudioPreferencePromise && jellyfinAudioPreferencePromiseUserId === userId) {
            return jellyfinAudioPreferencePromise;
        }
        // apiClient().getCurrentUser() hands back a memoised copy that Jellyfin's
        // playback-settings page never refreshes, so a preference changed in
        // this session would stay stale until reload; getUser() always fetches.
        const request = Promise.resolve()
            .then(() => apiClient().getUser(userId))
            .then((user) => {
                // A user switch while the request was in flight: the incoming
                // user's own initialization loads its value.
                if (currentUserId() !== userId) return;
                jellyfinAudioPreference = String(record(record(user).Configuration).AudioLanguagePreference || '').trim() || null;
                jellyfinAudioPreferenceUserId = userId;
            })
            .catch((err) => {
                console.warn(`${logPrefix} Could not read the Jellyfin audio language preference`, err);
                // A user with nothing loaded yet counts as having no preference,
                // so the tags render (and a later refresh is not held up).
                if (currentUserId() === userId && jellyfinAudioPreferenceUserId !== userId) {
                    jellyfinAudioPreference = null;
                    jellyfinAudioPreferenceUserId = userId;
                }
            })
            .finally(() => {
                if (jellyfinAudioPreferencePromise === request) {
                    jellyfinAudioPreferencePromise = null;
                    jellyfinAudioPreferencePromiseUserId = null;
                }
            });
        jellyfinAudioPreferencePromise = request;
        jellyfinAudioPreferencePromiseUserId = userId;
        return request;
    }

    /**
     * Whether the sound tag depends on the signed-in user's Jellyfin audio
     * language and that value is still being fetched for them (right after a
     * user switch). Cards stay untagged meanwhile instead of being judged by
     * no preference: tagged cards are skipped on rescan, so a wrong tag would
     * otherwise stick. The registration that follows the request rescans them.
     * */
    function isAudioPreferencePending(): boolean {
        const userId = currentUserId();
        return !!userId
            && jellyfinAudioPreferencePromiseUserId === userId
            && jellyfinAudioPreferenceUserId !== userId
            && usesJellyfinAudioPreference();
    }

    let playbackPreferencesWatched = false;

    /**
     * Re-reads the Jellyfin audio language when the user leaves Jellyfin's
     * playback settings page (where it is changed) and re-renders the tags if
     * it changed, so a new preference applies without a page reload. Costs one
     * request per visit, and only when the effective setting follows it.
     */
    function watchPlaybackPreferencesPage() {
        if (playbackPreferencesWatched || typeof JE.core?.navigation?.onNavigate !== 'function') return;
        playbackPreferencesWatched = true;
        const isPlaybackPreferences = () => /mypreferencesplayback/i.test(window.location.href);
        let onPage = isPlaybackPreferences();
        JE.core.navigation.onNavigate(() => {
            const wasOnPage = onPage;
            onPage = isPlaybackPreferences();
            if (!wasOnPage || onPage) return;
            if (!JE.currentSettings?.qualityTagsEnabled || !usesJellyfinAudioPreference()) return;
            const before = resolvePreferredAudioLanguage();
            primeJellyfinAudioPreference().then(() => {
                if (resolvePreferredAudioLanguage() !== before) JE.core.tagRenderer.reinitialize('quality', spec);
            });
        });
    }

    /**
     * Cache stamp for the preference a set of qualities was computed under.
     * Old entries carry none, which equals "no preference".
     * */
    function audioPreferenceKey(): string {
        return resolvePreferredAudioLanguage() || '';
    }

    /**
     * Whether a cached entry was computed under the current preference; one
     * computed under another is a miss and gets recomputed.
     * */
    function matchesAudioPreference(entry: JsonRecord): boolean {
        return entry.namingVersion === CACHE_NAMING_VERSION && entry.legacyAudio === legacyFullAudio() && entry.displayModeKey === displayModeKey() && (entry.audioLang || '') === audioPreferenceKey();
    }

    // The version (media source) the user last picked for an item, remembered
    // in this browser for each server and user (`je-quality-source:<server>:<user>`).
    // Library posters and the details poster show that version's badges; an item
    // with no pick keeps showing its first version. The earlier browser-wide key
    // belonged to no one in particular, so it is retired rather than inherited.
    const SOURCE_PREF_KEY = 'je-quality-source';
    const SOURCE_PREF_MAX = 500;

    /** @returns The signed-in user's storage key, or '' without one (picks then last until reload). */
    function sourcePrefKey(): string {
        const userId = JE.session?.getUserId?.() || '';
        return userId ? `${SOURCE_PREF_KEY}:${JE.session?.getServerId?.() || ''}:${userId}` : '';
    }

    /** @returns Lowercase hexadecimal item id, or '' when unusable. */
    function normItemId(id: unknown): string {
        return String(id || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    }

    let sourcePrefs = new Map<string, string>();
    let sourcePrefsMemoryOnly = false;
    let sourcePrefsOwner: string | null = null;
    /** @returns The current user's valid picks, from the JSON object format. */
    function readSourcePrefs(): Map<string, string> {
        const key = sourcePrefKey();
        if (key !== sourcePrefsOwner) {
            // Another user (or none): nothing of the previous user's picks carries over.
            sourcePrefsOwner = key;
            sourcePrefs = new Map();
            sourcePrefsMemoryOnly = !key;
            try { localStorage.removeItem(SOURCE_PREF_KEY); } catch { /* storage unavailable */ }
        }
        if (sourcePrefsMemoryOnly) return sourcePrefs;
        try {
            const parsed = JSON.parse(localStorage.getItem(key) || '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                sourcePrefs = new Map();
                for (const [key, value] of Object.entries(parsed)) {
                    if (typeof value !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key.toLowerCase())) continue;
                    const id = normItemId(key);
                    if (id) sourcePrefs.set(id, value);
                }
            }
            return sourcePrefs;
        } catch {
            return sourcePrefs;
        }
    }

    /** @returns The remembered media source id, or '' for the default. */
    function selectedSourceFor(itemId: unknown): string {
        const id = normItemId(itemId);
        return id ? readSourcePrefs().get(id) || '' : '';
    }

    // Status Tags' direct-play warning asks about the version the card shows.
    JE.selectedMediaSource = selectedSourceFor;

    /** Remember a pick as the newest entry, keeping the stored JSON object format. */
    function rememberSource(itemId: unknown, sourceId: string): void {
        const id = normItemId(itemId);
        if (!id) return;
        const prefs = readSourcePrefs();
        prefs.delete(id); // re-insert so the newest pick sits last
        prefs.set(id, sourceId);
        for (const oldest of prefs.keys()) {
            if (prefs.size <= SOURCE_PREF_MAX) break;
            prefs.delete(oldest);
        }
        if (sourcePrefsMemoryOnly || !sourcePrefsOwner) return;
        try {
            localStorage.setItem(sourcePrefsOwner, JSON.stringify(Object.fromEntries(prefs)));
        } catch { sourcePrefsMemoryOnly = true; /* the pick lasts until reload */ }
    }

    /**
     * Whether a cached entry matches both the audio preference and the item's
     * remembered version.
     * */
    function matchesCache(entry: JsonRecord, itemId: string): boolean {
        return matchesAudioPreference(entry) && (entry.srcId || '') === selectedSourceFor(itemId);
    }

    /**
     * Creates a single quality tag element.
     * @param label The text for the tag (e.g., "4K", "HDR").
     * @returns The created div element for the tag.
     */
    function createResponsiveLabel(label: string): HTMLElement {
        const normalizedLabel = normalizeQualityLabel(label);
        const badge = document.createElement('div');
        const category = categorize(label);
        const technical = category !== null && ['runtime', 'aspectRatio', 'frameRate', 'versions'].includes(category);
        const edition = label.startsWith(EDITION_PREFIX);
        const displayLabel = edition || technical ? label.slice(label.indexOf(':') + 1) : label;
        badge.textContent = edition ? editionLabel(displayLabel) : category === 'versions' ? versionsText(displayLabel) : category === 'runtime' ? runtimeText(displayLabel, false) : displayLabel;
        if (technical && category) {
            badge.dataset.jeQualityCategory = category;
            badge.dataset.jeCompact = category === 'versions' ? `×${displayLabel}` : compactTechnical(displayLabel, category);
            badge.title = badge.textContent;
        }
        badge.className = overlayClass;
        if (label === 'Mixed') badge.textContent = JE.t('series_quality_mixed');
        if (label === 'Mixed') {
            badge.classList.add('mixed');
            badge.dataset.jeCompact = JE.t('series_quality_mixed_compact');
            badge.title = JE.t('series_quality_mixed');
        }

        // Existing class names preserved for backward-compat with user CSS.
        // Source tags (BluRay/DVD/etc.) keep `.other-quality` from the
        // pre-PR behavior so user CSS targeting that class still matches.
        if (resolutionOrder.includes(normalizedLabel)) {
            badge.classList.add('resolution');
        } else if (codecOrder.includes(normalizedLabel)) {
            badge.classList.add('video-format');
        } else if (dynamicRangeOrder.includes(normalizedLabel) || specialFormatOrder.includes(normalizedLabel)) {
            badge.classList.add('video-codec');
        } else if (audioOrder.includes(normalizedLabel)) {
            badge.classList.add('audio-codec');
        } else {
            badge.classList.add('other-quality');
        }
        badge.dataset.quality = (technical ? category : edition ? displayLabel : normalizedLabel) ?? '';
        if (edition) {
            badge.dataset.jeEdition = 'true';
            badge.dataset.jeCompact = compactEditionLabel(displayLabel);
        }
        return badge;
    }

    /** @param label Canonical edition. @returns Its full display name. */
    function editionLabel(label: string): string {
        const row = own(EDITIONS, label);
        return row?.[0] ? JE.t(row[0]) : label;
    }
    /** @param label Canonical edition. @returns A compact code or translated word. */
    function compactEditionLabel(label: string): string {
        const row = own(EDITIONS, label);
        return row?.[1] ? row[1].startsWith('quality_') ? JE.t(row[1]) : row[1] : editionLabel(label);
    }

    /**
     * "2 versions" in the user's language (native posters: PosterTagResolver, quality_versions_count).
     * @param count Number of versions.
     * */
    function versionsText(count: string): string {
        // A number, so JE.t picks the plural form; the label keeps its digits as they are.
        const n = Number(count);
        const text = JE.t('quality_versions_count', { count: Number.isFinite(n) ? n : count });
        return (text === 'quality_versions_count' ? '{count} versions' : text).replace('{count}', count);
    }

    /**
     * A runtime label ("1h 52m", "47m", the chip's identity) as the user reads it: the hour and minute
     * abbreviations come from the locale files; Compact joins hours and minutes ("1h52")
     * (TechnicalQualityRules.RuntimeText on posters).
     * */
    function runtimeText(label: string, compact: boolean): string {
        const say = (key: string, params: Readonly<Record<string, string>>, fallback: string) => {
            const text = JE.t(key, params);
            return text === key ? fallback : Object.entries(params).reduce((out, [name, value]) => out.replace(`{${name}}`, value), text);
        };
        const hours = /^(\d+)h (\d+)m$/.exec(label);
        if (hours?.[1] && hours[2]) return say(compact ? 'quality_runtime_hours_compact' : 'quality_runtime_hours', { hours: hours[1], minutes: hours[2] }, compact ? `${hours[1]}h${hours[2]}` : label);
        const minutes = /^(\d+)m$/.exec(label);
        return minutes?.[1] ? say('quality_runtime_minutes', { minutes: minutes[1] }, label) : label;
    }

    /** Compact technical text; values stay identical across densities. */
    function compactTechnical(label: string, category: string): string {
        if (category === 'runtime') return runtimeText(label, true);
        if (category === 'aspectRatio') return label.replace(/^IMAX /, '').replace(/:1$/, '');
        return label;
    }

    /**
     * Reapply a policy to retained batch facts. A policy change must not fetch
     * episodes again while the language preference and cache lifetime still match.
     * @param cached - A computed local/hot cache record.
     * @returns Resolved labels, including a known empty result, or a cache miss.
     */
    function qualitiesFromCache(cached: unknown, itemId: string): string[] | null {
        if (!isRecord(cached) || !matchesCache(cached, itemId)) return null;
        if ((cached.aggregationPolicy === aggregationPolicy() && cached.aggregationCategories === aggregationCategoriesKey()) || (cached.type && cached.type !== 'Series' && cached.type !== 'Season')) return stringList(cached.qualities);
        if (!cached.qualitySummary) return null;
        return aggregateQualities({ Type: cached.type, QualitySummary: cached.qualitySummary }, stringList(cached.representativeQualities));
    }

    /**
     * Renders the quality tag overlay onto a poster card
     * @param ctx - Factory context (tagged/overlay helpers).
     * @param container - The card element to receive the overlay
     * @param qualities - Detected quality tags, unfiltered
     */
    function insertOverlay(ctx: TagCtx, container: HTMLElement, qualities: string[]): void {
        if (!container) return;

        // Remove any old tags before adding new ones
        ctx.removeExistingOverlay(container);

        // Bucket each tag by category. Disabled categories drop their tags.
        // Uncategorized labels (e.g. stale cache entries from a prior plugin
        // version) collect in `otherBucket` so they still render — preserves
        // the pre-PR `.other-quality` rendering behavior.
        const buckets = new Map<string, string[]>();
        const otherBucket: string[] = [];
        for (const q of new Set(qualities)) {
            if (q === 'SDR' && readBool('qualityHideSdr', false)) continue;
            if (categorize(q) === 'resolution' && !meetsMinimum(q)) continue;
            if (['CAM', 'TS', 'TC', 'SCR'].includes(q) && !readBool('showLowQualitySourceTag', false)) continue;
            if (q === EDITION_PREFIX + 'IMAX' && qualities.includes('IMAX') && readBool('showSpecialFormatTag', true)) continue;
            const catKey = categorize(q);
            if (catKey) {
                const cat = CATEGORY_BY_KEY.get(catKey);
                if (cat && !readBool(cat.settingKey, cat.fallback ?? true)) continue;
                const bucket = buckets.get(catKey);
                if (bucket) bucket.push(q);
                else buckets.set(catKey, [q]);
            } else {
                otherBucket.push(q);
            }
        }
        if (buckets.size === 0 && otherBucket.length === 0) {
            // Clear stale dataset attribute so a future re-init / re-render
            // can rebuild the overlay rather than treating the card as tagged.
            const card = container.closest('.card');
            if (card instanceof HTMLElement) delete card.dataset[ctx.taggedAttr];
            return;
        }

        // Sort each bucket by within-category priority and keep only the best resolution
        for (const [catKey, tags] of buckets) {
            const cat = CATEGORY_BY_KEY.get(catKey);
            tags.sort((a, b) => {
                if (allValues(catKey)) return distinctRank(a, catKey) - distinctRank(b, catKey) || (a < b ? -1 : a > b ? 1 : 0);
                const aKey = normalizeQualityLabel(a);
                const bKey = normalizeQualityLabel(b);
                const aIdx = cat?.items.indexOf(aKey) ?? -1;
                const bIdx = cat?.items.indexOf(bKey) ?? -1;
                return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
            });
            if (catKey === 'resolution' && tags.length > 1) tags.length = 1;
        }

        // Sort categories by user stack order, tie-broken by defaultOrder for determinism
        const categoriesSorted = [...buckets.keys()].map((key) => {
            const cat = CATEGORY_BY_KEY.get(key);
            const defaultOrder = cat?.defaultOrder ?? 0;
            return { key, defaultOrder, order: cat ? readInt(cat.orderUserKey, defaultOrder) : defaultOrder };
        }).sort((a, b) => {
            if (a.order !== b.order) return a.order - b.order;
            return a.defaultOrder - b.defaultOrder;
        });

        // Ensure container is positioned (avoids forced reflow from getComputedStyle,
        // and a style write per card when it already is)
        if (container.style.position !== 'relative') container.style.position = 'relative';

        const qualityContainer = document.createElement('div');
        qualityContainer.className = containerClass;

        for (const { key } of categoriesSorted) {
            for (const q of buckets.get(key) ?? []) {
                qualityContainer.appendChild(createResponsiveLabel(q));
            }
        }
        // Render any uncategorized tags last, in original input order.
        for (const q of otherBucket) {
            qualityContainer.appendChild(createResponsiveLabel(q));
        }

        ctx.commitOverlay(container, qualityContainer);
    }

    /** Factory spec — quality-specific config and renderers. */
    const spec: TagSpec = {
        logPrefix,
        settingKey: 'qualityTagsEnabled',
        containerClass,
        taggedAttr: 'jeQualityTagged',
        styleId: 'quality-tag-enhanced-style',
        position: { userKey: 'qualityTagsPosition', pluginKey: 'QualityTagsPosition', fallback: 'top-left' },
        cache: {
            // Static cache key (not version-based) to persist across plugin updates
            key: 'JellyfinEnhanced-qualityTagsCache',
            legacyPrefix: 'qualityOverlayCache',
            hotBucket: 'quality',
            pruneOnSave: true,
        },
        buildCss() {
            return qualityCss(overlayClass, containerClass, JE.core.tagRenderer.chipBaseCss);
        },
        pipeline: {
            needsFirstEpisode: true,
            needsParentSeries: false,
            render(ctx: TagCtx, el, item, extras) {
                if (ctx.shouldIgnore(el)) return;
                if (ctx.isTagged(el)) return;
                // Skip cards hidden by hidden-content module
                if (el.closest('.je-hidden')) return;
                if (isAudioPreferencePending()) return;

                const itemId = String(item.Id);
                // Check hot cache first
                const hot = record(ctx.hot?.get(itemId));
                const hotQualities = typeof hot.timestamp === 'number' && (Date.now() - hot.timestamp) < ctx.cacheTtl ? qualitiesFromCache(hot, itemId) : null;
                if (hotQualities) {
                    if (hotQualities.length) insertOverlay(ctx, el, hotQualities);
                    return;
                }

                let qualities: string[] = [];
                const srcId = selectedSourceFor(itemId);
                if (item.Type === 'Series' || item.Type === 'Season') {
                    if (extras.firstEpisode) {
                        // A version count would describe the first episode, not the series or season.
                        qualities = getEnhancedQuality(extras.firstEpisode.MediaStreams, extras.firstEpisode.MediaSources, extras.firstEpisode)
                            .filter(label => !label.startsWith('versions:'));
                    }
                } else {
                    qualities = getEnhancedQuality(item.MediaStreams, item.MediaSources, item, false, srcId);
                }

                const representativeQualities = qualities;
                qualities = aggregateQualities(item, qualities);
                {
                    const audioLang = audioPreferenceKey();
                    const record = { qualities, representativeQualities, type: item.Type, qualitySummary: item.QualitySummary,
                        namingVersion: CACHE_NAMING_VERSION, legacyAudio: legacyFullAudio(), displayModeKey: displayModeKey(), timestamp: Date.now(), audioLang, srcId, aggregationPolicy: aggregationPolicy(), aggregationCategories: aggregationCategoriesKey() };
                    ctx.setPersistent(itemId, record);
                    ctx.hot?.set(itemId, record);
                    if (qualities.length) insertOverlay(ctx, el, qualities);
                }
            },
            renderFromCache(ctx: TagCtx, el, itemId) {
                if (ctx.isTagged(el)) return true;
                if (ctx.shouldIgnore(el)) return true;
                if (el.closest('.je-hidden')) return true;
                // No fetch while the preference loads; the rescan after it renders the card.
                if (isAudioPreferencePending()) return true;
                const hot = ctx.hot?.get(itemId);
                const cached = hot || ctx.getPersistent(itemId);
                const qualities = qualitiesFromCache(cached, itemId);
                if (qualities) {
                    if (qualities.length) insertOverlay(ctx, el, qualities);
                    return true;
                }
                return false;
            },
            renderFromServerCache(ctx: TagCtx, el, entry, itemId) {
                if (ctx.isTagged(el)) return;
                if (ctx.shouldIgnore(el)) return;
                if (isAudioPreferencePending()) return;
                // Check local computed cache first (avoids re-running quality detection)
                const cached = serverQualityCache.get(itemId);
                if (cached && cached.entry === entry && matchesCache(cached, itemId) && cached.aggregationPolicy === aggregationPolicy() && cached.aggregationCategories === aggregationCategoriesKey()) {
                    if (cached.qualities.length > 0) insertOverlay(ctx, el, cached.qualities);
                    return;
                }
                const audioLang = audioPreferenceKey();
                const srcId = selectedSourceFor(itemId);
                const sd = record(entry.StreamData);
                const representative = getEnhancedQuality(sd.Streams, sd.Sources, { Name: sd.ItemName, Path: sd.ItemPath, RunTimeTicks: sd.RunTimeTicks, Source: entry.Source, Edition: entry.Edition, DistinctQualities: sd.DistinctQualities }, false, srcId)
                    // A version count would describe the representative episode, not the series or season.
                    .filter(label => !(entry.Type === 'Series' || entry.Type === 'Season') || !label.startsWith('versions:'));
                const qualities = aggregateQualities(entry, representative);
                serverQualityCache.set(itemId, { audioLang, srcId, qualities, entry, namingVersion: CACHE_NAMING_VERSION, legacyAudio: legacyFullAudio(), displayModeKey: displayModeKey(), aggregationPolicy: aggregationPolicy(), aggregationCategories: aggregationCategoriesKey() });
                if (qualities.length > 0) insertOverlay(ctx, el, qualities);
            },
            onServerCacheRefresh(ctx: TagCtx, updatedIds) {
                if (!updatedIds) { serverQualityCache.clear(); return; }
                updatedIds.forEach(function(id) { serverQualityCache.delete(id); });
            },
        },
    };

    /**
     * Runs `render` once the Jellyfin audio preference is known when the
     * effective setting depends on it (one request; none otherwise), so the
     * first pass is not judged under "no preference" and redone when the
     * value arrives. The request never rejects, so a failure still renders.
     */
    function withJellyfinAudioPreference(render: () => void): void {
        if (!usesJellyfinAudioPreference()) { render(); return; }
        primeJellyfinAudioPreference().then(render);
    }

    let versionPickerWatched = false;
    let versionPickerTimer: ReturnType<typeof setInterval> | undefined;

    /**
     * Makes the details page's version picker drive the badges: a pick is
     * remembered (so library posters follow it) and re-renders the poster, and
     * on opening the page the remembered version is selected again.
     */
    function watchVersionPicker() {
        if (versionPickerWatched) return;
        versionPickerWatched = true;
        const detailId = () => new URLSearchParams(location.hash.split('?')[1] || '').get('id');
        // A restore in flight belongs to the user who opened the page.
        JE.session?.onUserChange?.('quality-version-picker', () => clearInterval(versionPickerTimer));

        document.addEventListener('change', (e) => {
            const select = e.target;
            if (!(select instanceof HTMLSelectElement) || !select.classList.contains('selectSource') || !select.value) return;
            const id = detailId();
            if (!id || selectedSourceFor(id) === select.value) return;
            rememberSource(id, select.value);
            JE.core.tagRenderer.reinitialize('quality', spec);
        });

        document.addEventListener('viewshow', () => {
            clearInterval(versionPickerTimer);
            const id = detailId();
            const want = id && selectedSourceFor(id);
            if (!want) return;
            const owner = sourcePrefKey();
            // Jellyfin fills the picker after the page shows.
            let tries = 0;
            const timer: ReturnType<typeof setInterval> = versionPickerTimer = setInterval(() => {
                if (detailId() !== id || sourcePrefKey() !== owner) { clearInterval(timer); return; }
                const select = document.querySelector<HTMLSelectElement>('#itemDetailPage:not(.hide) .selectSource');
                if (select && select.options.length > 1) {
                    clearInterval(timer);
                    if (select.value !== want && [...select.options].some((o) => o.value === want)) {
                        select.value = want;
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                } else if (++tries > 20) {
                    clearInterval(timer);
                }
            }, 300);
        });
    }

    /**
     * Initializes the Quality Tags feature.
     */
    JE.initializeQualityTags = function() {
        watchPlaybackPreferencesPage();
        watchVersionPicker();
        withJellyfinAudioPreference(() => JE.core.tagRenderer.register('quality', spec));
    };

    /**
     * Re-initializes the Quality Tags feature
     * Cleans up existing state and re-applies tags.
     */
    JE.reinitializeQualityTags = function() {
        watchPlaybackPreferencesPage();
        withJellyfinAudioPreference(() => JE.core.tagRenderer.reinitialize('quality', spec));
    };

    // Previews may enable this group while the signed-in user has it off.
    JE.core.tagRenderer.registerStyles(spec);
}
