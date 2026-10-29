// /js/tags/statustags.js
// Jellyfin Status Tags - Badge posters with "Just Added", "New Movie" /
// "New Series" / "New Episode" and the daily trending rank ("#3 Today"),
// drawn over the card so the poster image itself (e.g. a custom poster set)
// is never replaced.
// A spec over the core tag-renderer factory (js/core/tag-renderer-base.js),
// which owns the cache/ignore/tagged/CSS/reinitialize plumbing. This module
// supplies only the status-specific parts: reading the item's dates, picking
// the one badge a card shows, the trending list and the badge markup.
//
// One badge per card, first match wins:
//   Movie   Trending → New Movie (premiered within the new-release window) → Just Added
//   Series  Trending → New Series → New Episode (latest episode added within the
//           just-added window, the series itself earlier) → Just Added
//   Season  New Episode → Just Added
//   Episode, BoxSet, Video: Just Added
// Dates come from the server tag cache (DateCreated / PremiereDate /
// LatestEpisodeAdded, Unix ms) or the /tag-data batch fallback. Trending ranks
// come from /JellyfinEnhanced/status-tags/trending, fetched on first use and
// refreshed after 30 minutes; whenever a fetch brings a different list, one
// pass re-badges the Movie/Series cards on the page (cards drawn before the
// first list arrives get their date badge until then).
//
// Spoiler Guard: dates are not spoilers (Jellyfin lists Date Added), so a
// guarded item gets the normal date-based evaluation, and a trending rank is
// not plot information, so a guarded Movie/Series keeps it: the server cache's
// strip keeps TmdbId and the /tag-data Series/Movie stubs carry it as TmdbId.
// Season/Episode stubs never get a rank anyway. Nothing extra is fetched.
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Status Tags:';
    const containerClass = 'status-overlay-container';
    const tagClass = 'status-tag';
    const DAY_MS = 24 * 60 * 60 * 1000;
    // A cached entry's dates (a series' latest episode above all) can move, so
    // the persistent cache only answers for this long before a re-fetch.
    const CACHE_FRESH_MS = 60 * 60 * 1000;
    const TRENDING_TTL_MS = 30 * 60 * 1000;
    // A failed or empty trending fetch is retried sooner than a good list expires.
    const TRENDING_RETRY_MS = 5 * 60 * 1000;
    // Placeholder for the rank inside the translated trending label, so the
    // number can sit in its own span whatever the locale's word order.
    const RANK_TOKEN = '\u0001';
    // English labels, used only while a locale file does not have the key yet
    // (a new string reaches the other locales through Weblate, and a cached or
    // remote locale file can predate it); JE.t returns the bare key then.
    const FALLBACK_LABELS = {
        status_tag_just_added: 'Just Added',
        status_tag_new_movie: 'New Movie',
        status_tag_new_series: 'New Series',
        status_tag_new_episode: 'New Episode',
        status_tag_trending_today: '#{rank} Today',
        status_tag_trending_week: '#{rank} This Week',
    };

    // Which badges may show. Each resolves user override -> admin default ->
    // on, like the rating tag scope switches.
    const BADGE_SCOPES = {
        trending: { userKey: 'statusTagsTrending', pluginKey: 'StatusTagsTrending' },
        newRelease: { userKey: 'statusTagsNewRelease', pluginKey: 'StatusTagsNewRelease' },
        justAdded: { userKey: 'statusTagsJustAdded', pluginKey: 'StatusTagsJustAdded' },
    };

    /**
     * Trending list shared by every card of this page lifetime.
     * @type {{data: {source: string|null, movies: Object<string, number>, series: Object<string, number>}|null,
     *   fetchedAt: number, retryAt: number, promise: Promise<void>|null}}
     */
    const trending = { data: null, fetchedAt: 0, retryAt: 0, promise: null };

    /**
     * Every drawn Movie/Series card with a TMDB id (the only cards a trending
     * list can change), with its item id and data, the badge it shows and the
     * revision it was recorded under. The cards are found again through
     * TRENDABLE_ATTR, so detached ones need no pruning. A record is only
     * trusted while it is current (see isCurrentRecord): the trending pass
     * leaves a stale card alone until the pipeline renders it again.
     * @type {WeakMap<HTMLElement, {id: string|null, data: Object, shown: string, rev: number}>}
     */
    const trendableCards = new WeakMap();
    /** @type {number} bumped whenever recorded data stops being trusted */
    let trackRev = 0;
    /** @type {number} records older than this are stale, whatever their item */
    let staleBelowRev = 0;
    /**
     * Item id → revision a delta replaced it at; a record older than that is
     * stale. Cleared whenever everything is marked stale at once.
     * @type {Map<string, number>}
     */
    const replacedAt = new Map();
    const TRENDABLE_ATTR = 'jeStatusTrendable';
    const TRENDABLE_SELECTOR = '[data-je-status-trendable]';

    /**
     * Resolve one badge switch: user override, then admin default, then on.
     * @param {{userKey: string, pluginKey: string}} scope
     * @returns {boolean}
     */
    function isScopeEnabled(scope) {
        const u = JE.currentSettings?.[scope.userKey];
        if (typeof u === 'boolean') return u;
        const a = JE.pluginConfig?.[scope.pluginKey];
        return typeof a === 'boolean' ? a : true;
    }

    /**
     * Whether the trending badge can show at all: the user's switch, and the
     * admin's Status Tags + trending switches, which also gate the endpoint.
     * @returns {boolean}
     */
    function isTrendingWanted() {
        return JE.pluginConfig?.StatusTagsEnabled === true
            && JE.pluginConfig?.StatusTagsTrending !== false
            && isScopeEnabled(BADGE_SCOPES.trending);
    }

    /**
     * Translate a badge label, falling back to its English text when the
     * loaded locale does not have the key.
     * @param {string} key - Translation key.
     * @param {Object} [params] - Placeholder values, e.g. { rank }.
     * @returns {string}
     */
    function label(key, params) {
        const text = JE.t(key, params);
        if (text && text !== key) return text;
        let fallback = FALLBACK_LABELS[key] || key;
        for (const [name, value] of Object.entries(params || {})) fallback = fallback.split(`{${name}}`).join(String(value));
        return fallback;
    }

    /**
     * An admin day window in ms, clamped to 1-365 days.
     * @param {string} pluginKey - e.g. 'StatusTagsJustAddedDays'.
     * @param {number} fallback - Default in days.
     * @returns {number}
     */
    function windowMs(pluginKey, fallback) {
        const raw = parseInt(JE.pluginConfig?.[pluginKey], 10);
        const days = Number.isFinite(raw) ? Math.min(365, Math.max(1, raw)) : fallback;
        return days * DAY_MS;
    }

    /**
     * A date as Unix ms: the server sends numbers, a raw BaseItemDto ISO strings.
     * @param {*} value
     * @returns {number|null}
     */
    function toMs(value) {
        if (value === null || value === undefined || value === '') return null;
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        const parsed = Date.parse(String(value));
        return Number.isFinite(parsed) ? parsed : null;
    }

    /**
     * The fields the badge rules read, from a server tag cache entry.
     * @param {Object} entry - TagCacheEntry.
     * @returns {{type: string|null, tmdb: string|null, created: number|null, premiere: number|null, latest: number|null}}
     */
    function fromServerEntry(entry) {
        return {
            type: entry.Type || null,
            tmdb: entry.TmdbId ? String(entry.TmdbId) : null,
            created: toMs(entry.DateCreated),
            premiere: toMs(entry.PremiereDate),
            latest: toMs(entry.LatestEpisodeAdded),
        };
    }

    /**
     * The fields the badge rules read, from a /tag-data item (or a raw
     * BaseItemDto on the per-item fallback).
     * @param {Object} item
     * @returns {{type: string|null, tmdb: string|null, created: number|null, premiere: number|null, latest: number|null}}
     */
    function fromItem(item) {
        // A Spoiler Guard strip stub has no ProviderIds, only the bare TmdbId.
        const tmdb = item.ProviderIds?.Tmdb || item.TmdbId;
        return {
            type: item.Type || null,
            tmdb: tmdb ? String(tmdb) : null,
            created: toMs(item.DateCreated),
            premiere: toMs(item.PremiereDate),
            latest: toMs(item.LatestEpisodeAdded),
        };
    }

    /**
     * Whether a date lies within the last `windowLength` ms. A date slightly in
     * the future (server/browser clock skew) still counts; a premiere date in
     * the future does not (see isNewRelease).
     * @param {number|null} ms
     * @param {number} now
     * @param {number} windowLength
     * @returns {boolean}
     */
    function isWithin(ms, now, windowLength) {
        return ms !== null && ms <= now + DAY_MS && now - ms <= windowLength;
    }

    /**
     * The trending rank of an item, when the list has it.
     * @param {{type: string|null, tmdb: string|null}} data
     * @returns {number|null}
     */
    function trendingRank(data) {
        const list = trending.data;
        if (!list || !data.tmdb) return null;
        const map = data.type === 'Movie' ? list.movies : data.type === 'Series' ? list.series : null;
        const rank = map ? map[data.tmdb] : null;
        return typeof rank === 'number' && rank > 0 ? rank : null;
    }

    /**
     * Pick the one badge a card shows (first match wins), or null.
     * @param {{type: string|null, tmdb: string|null, created: number|null, premiere: number|null, latest: number|null}} data
     * @returns {{kind: 'trending'|'new'|'added', label: string, rank?: number}|null}
     */
    function pickBadge(data) {
        const now = Date.now();
        const justAddedMs = windowMs('StatusTagsJustAddedDays', 7);
        const newReleaseMs = windowMs('StatusTagsNewReleaseDays', 30);
        const showNew = isScopeEnabled(BADGE_SCOPES.newRelease);
        const showAdded = isScopeEnabled(BADGE_SCOPES.justAdded);
        const isNewRelease = data.premiere !== null && data.premiere <= now && now - data.premiere <= newReleaseMs;
        const addedRecently = isWithin(data.created, now, justAddedMs);
        // "New Episode": an episode arrived recently in a container that was
        // itself already there before the window (else it is just added).
        const newEpisode = isWithin(data.latest, now, justAddedMs)
            && data.created !== null && now - data.created > justAddedMs;

        if ((data.type === 'Movie' || data.type === 'Series') && isTrendingWanted()) {
            const rank = trendingRank(data);
            if (rank !== null) {
                const key = trending.data?.source === 'seerr-week' ? 'status_tag_trending_week' : 'status_tag_trending_today';
                return { kind: 'trending', label: label(key, { rank: RANK_TOKEN }), rank };
            }
        }
        switch (data.type) {
            case 'Movie':
                if (showNew && isNewRelease) return { kind: 'new', label: label('status_tag_new_movie') };
                break;
            case 'Series':
                if (showNew && isNewRelease) return { kind: 'new', label: label('status_tag_new_series') };
                if (showNew && newEpisode) return { kind: 'new', label: label('status_tag_new_episode') };
                break;
            case 'Season':
                if (showNew && newEpisode) return { kind: 'new', label: label('status_tag_new_episode') };
                break;
            case 'Episode':
            case 'BoxSet':
            case 'Video':
                break;
            default:
                return null;
        }
        if (showAdded && addedRecently) return { kind: 'added', label: label('status_tag_just_added') };
        return null;
    }

    /**
     * Retrieve a fresh cached entry from localStorage or hot cache.
     * @param {Object} ctx - Factory context.
     * @param {string} itemId - Jellyfin item ID.
     * @returns {{type: string|null, tmdb: string|null, created: number|null, premiere: number|null, latest: number|null}|null}
     *   Cached data, or null when unknown or too old to trust.
     */
    function getCachedEntry(ctx, itemId) {
        const entry = ctx.getPersistent(itemId) ?? ctx.hot?.get(itemId);
        if (!entry || typeof entry !== 'object') return null;
        if (typeof entry.timestamp !== 'number' || Date.now() - entry.timestamp > CACHE_FRESH_MS) return null;
        return {
            type: entry.t ?? null,
            tmdb: entry.m ?? null,
            created: entry.c ?? null,
            premiere: entry.p ?? null,
            latest: entry.l ?? null,
        };
    }

    /**
     * Store an entry in both localStorage cache and hot cache. Null fields are
     * left out to keep the stored copy small.
     * @param {Object} ctx - Factory context.
     * @param {string} itemId - Jellyfin item ID.
     * @param {{type: string|null, tmdb: string|null, created: number|null, premiere: number|null, latest: number|null}} data
     * @returns {void}
     */
    function setCachedEntry(ctx, itemId, data) {
        const entry = { t: data.type, timestamp: Date.now() };
        if (data.tmdb) entry.m = data.tmdb;
        if (data.created !== null) entry.c = data.created;
        if (data.premiere !== null) entry.p = data.premiere;
        if (data.latest !== null) entry.l = data.latest;
        ctx.setPersistent(itemId, entry);
        ctx.hot?.set(itemId, entry);
    }

    /**
     * Create and append the status badge to a card.
     * @param {Object} ctx - Factory context.
     * @param {HTMLElement} el - The card container to receive the overlay.
     * @param {{kind: string, label: string, rank?: number}|null} badge - From pickBadge.
     * @returns {void}
     */
    function applyStatusTag(ctx, el, badge) {
        if (!badge) return;

        ctx.removeExistingOverlay(el);

        const container = document.createElement('div');
        container.className = containerClass;

        const tag = document.createElement('div');
        tag.className = `${tagClass} ${tagClass}--${badge.kind}`;
        if (badge.kind === 'trending') {
            // "#{rank} Today": the "#N" goes in its own span (warmer colour).
            const [before, after = ''] = badge.label.split(RANK_TOKEN);
            const hash = before.endsWith('#') ? '#' : '';
            const rank = document.createElement('span');
            rank.className = `${tagClass}-rank`;
            rank.textContent = `${hash}${badge.rank}`;
            tag.append(before.slice(0, before.length - hash.length), rank, after);
        } else {
            tag.textContent = badge.label;
        }
        container.appendChild(tag);

        ctx.commitOverlay(el, container);
    }

    /**
     * A badge as a comparable string ('' for none).
     * @param {{kind: string, label: string, rank?: number}|null} badge
     * @returns {string}
     */
    function badgeKey(badge) {
        return badge ? `${badge.kind}|${badge.label}|${badge.rank ?? ''}` : '';
    }

    /**
     * A trending list as a comparable string; an empty list (or none) is ''.
     * @param {{source: string|null, movies: Object, series: Object}|null} list
     * @returns {string}
     */
    function trendingKey(list) {
        if (!list || !list.source) return '';
        return JSON.stringify([list.source, list.movies, list.series]);
    }

    /**
     * Draw a card's badge, and remember a Movie/Series card for the pass that
     * re-badges them when a different trending list arrives.
     * @param {Object} ctx - Factory context.
     * @param {HTMLElement} el - Render target.
     * @param {Object} data - Normalized item data.
     * @param {string|null} [itemId] - Jellyfin item id the data came from.
     * @returns {void}
     */
    function renderData(ctx, el, data, itemId) {
        // Cheap when fresh; refreshes a list that expired during a long session.
        ensureTrending(ctx);
        const badge = pickBadge(data);
        if (data.tmdb && (data.type === 'Movie' || data.type === 'Series')) {
            trendableCards.set(el, { id: itemId ? String(itemId) : null, data, shown: badgeKey(badge), rev: trackRev });
            el.dataset[TRENDABLE_ATTR] = '1';
        }
        applyStatusTag(ctx, el, badge);
    }

    /**
     * Whether a card's record was made after everything that replaced the
     * data it holds. Checked at use, so a card that was detached while its
     * item was replaced, then put back, is caught as well.
     * @param {{id: string|null, rev: number}} card
     * @returns {boolean}
     */
    function isCurrentRecord(card) {
        if (card.rev < staleBelowRev) return false;
        if (card.id === null) return true;
        const replaced = replacedAt.get(card.id);
        return replaced === undefined || replaced <= card.rev;
    }

    /**
     * React to the pipeline replacing or dropping its server cache, so the
     * trending pass never redraws a card from data that is no longer trusted.
     *
     * A delta (id list) marks the records of those items stale: the card keeps
     * the badge it shows, like every other tag group does until the card is
     * rendered again, but a trending refresh no longer re-badges it from the
     * outdated dates.
     *
     * No id list means the whole cache went. When the pipeline is about to
     * re-render everything (a Spoiler Guard or access change, a user switch:
     * the cache is dropped first, so nothing can be read from it) every record
     * is marked stale and the pipeline's re-render records the cards again.
     * When the pipeline swapped in a replacement download without
     * re-rendering (a version change or rollback) the cards on the page are
     * instead re-synced from the entries now in memory: their dates are
     * refreshed, a badge that changed is redrawn, and a card whose entry is
     * gone loses its badge.
     * @param {Object} ctx - Factory context.
     * @param {string[]|null} updatedIds - Item ids a delta replaced, or null for everything.
     * @returns {void}
     */
    function onCacheReplaced(ctx, updatedIds) {
        trackRev++;
        if (Array.isArray(updatedIds)) {
            for (const id of updatedIds) replacedAt.set(String(id), trackRev);
            return;
        }
        staleBelowRev = trackRev;
        replacedAt.clear();
        const peek = JE.tagPipeline?.peekServerEntry;
        if (typeof peek !== 'function' || peek('') === undefined) return;
        const hosts = [];
        document.querySelectorAll(TRENDABLE_SELECTOR).forEach((el) => {
            const card = trendableCards.get(/** @type {HTMLElement} */ (el));
            if (!card || card.rev >= trackRev || !card.id) return;
            const entry = peek(card.id);
            if (!entry) {
                // Not in the replacement cache (removed, or no longer accessible).
                trendableCards.delete(/** @type {HTMLElement} */ (el));
                ctx.removeExistingOverlay(el);
                hosts.push(el);
                return;
            }
            const data = fromServerEntry(entry);
            const badge = pickBadge(data);
            const key = badgeKey(badge);
            trendableCards.set(el, { id: card.id, data, shown: key, rev: trackRev });
            if (key === card.shown) return;
            if (badge) applyStatusTag(ctx, el, badge);
            else ctx.removeExistingOverlay(el);
            hosts.push(el);
        });
        if (hosts.length > 0) JE.core.tagRenderer.applyCornerStacking(hosts);
    }

    /**
     * After a fetch brought a different trending list: re-badge every
     * Movie/Series card on the page whose badge changes with it (a new or
     * changed rank, or a title that dropped off and falls back to its date
     * badge or none), then re-stack their corners in one pass.
     * @param {Object} ctx - Factory context.
     * @returns {void}
     */
    function applyTrendingPass(ctx) {
        if (!JE.currentSettings?.statusTagsEnabled) return;
        const hosts = [];
        document.querySelectorAll(TRENDABLE_SELECTOR).forEach((el) => {
            const card = trendableCards.get(/** @type {HTMLElement} */ (el));
            if (!card || ctx.shouldIgnore(el) || el.closest('.je-hidden')) return;
            if (!isCurrentRecord(card)) {
                trendableCards.delete(/** @type {HTMLElement} */ (el));
                return;
            }
            const badge = pickBadge(card.data);
            const key = badgeKey(badge);
            if (key === card.shown) return;
            card.shown = key;
            // No badge now: removing the overlay is enough, a tagged marker
            // without one counts as untagged (ctx.isTagged).
            if (badge) applyStatusTag(ctx, el, badge);
            else ctx.removeExistingOverlay(el);
            hosts.push(el);
        });
        if (hosts.length > 0) JE.core.tagRenderer.applyCornerStacking(hosts);
    }

    /**
     * Fetch the trending list unless it is fresh, already loading, switched
     * off, or recently failed or empty (retried after TRENDING_RETRY_MS; only a
     * usable list is kept for TRENDING_TTL_MS). Stale data keeps being used
     * while a refresh runs; when the answer differs from the list in use, one
     * pass re-badges the cards on the page.
     * @param {Object} ctx - Factory context.
     * @returns {void}
     */
    function ensureTrending(ctx) {
        if (!isTrendingWanted() || trending.promise) return;
        const now = Date.now();
        if (now < trending.retryAt) return;
        if (trending.data?.source && now - trending.fetchedAt < TRENDING_TTL_MS) return;
        if (typeof ApiClient === 'undefined') return;

        const previous = trendingKey(trending.data);
        trending.promise = (async () => {
            try {
                const response = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('JellyfinEnhanced/status-tags/trending'),
                    dataType: 'json'
                });
                const movies = response?.movies && typeof response.movies === 'object' ? response.movies : {};
                const series = response?.series && typeof response.series === 'object' ? response.series : {};
                trending.data = { source: response?.source ?? null, movies, series };
                trending.fetchedAt = Date.now();
                trending.retryAt = trending.data.source ? 0 : trending.fetchedAt + TRENDING_RETRY_MS;
            } catch (e) {
                console.warn(`${logPrefix} Could not load the trending list; showing date badges only.`, e);
                trending.data = trending.data || { source: null, movies: {}, series: {} };
                trending.retryAt = Date.now() + TRENDING_RETRY_MS;
            } finally {
                trending.promise = null;
            }
            if (trendingKey(trending.data) !== previous) applyTrendingPass(ctx);
        })();
    }

    /** @type {Object} Factory spec — everything status-specific lives here. */
    const spec = {
        logPrefix,
        settingKey: 'statusTagsEnabled',
        containerClass,
        taggedAttr: 'jeStatusTagged',
        styleId: 'jellyfin-enhanced-status-tags-css',
        position: { userKey: 'statusTagsPosition', pluginKey: 'StatusTagsPosition', fallback: 'top-right' },
        cache: {
            key: 'JellyfinEnhanced-statusTagsCache',
            legacyPrefix: 'statusTagsCache',
            hotBucket: 'status',
            pruneOnSave: true,
            saveOnUnload: false,
        },
        buildCss() {
            const pos = JE.core.tagRenderer.resolvePosition('statusTagsPosition', 'StatusTagsPosition', 'top-right');
            return `
                .${containerClass} {
                    position: absolute;
                    top: ${pos.topVal};
                    right: ${pos.rightVal};
                    bottom: ${pos.bottomVal};
                    left: ${pos.leftVal};
                    display: flex;
                    flex-direction: column;
                    align-items: ${pos.isLeft ? 'flex-start' : 'flex-end'};
                    z-index: 10;
                    pointer-events: none;
                    max-width: calc(100% - 12px);
                }

                ${pos.needsTopRightOffset ? `.cardImageContainer .cardIndicators ~ .${containerClass} { margin-top: clamp(20px, 3vw, 30px); }` : ''}
                .${tagClass} {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.25em;
                    padding: 4px 10px;
                    background-color: rgba(15, 15, 15, 0.72);
                    -webkit-backdrop-filter: blur(6px);
                    backdrop-filter: blur(6px);
                    color: #ffffff;
                    border: 1px solid rgba(255, 255, 255, 0.18);
                    border-radius: 6px;
                    font-size: 13px;
                    font-weight: 600;
                    line-height: 1.15;
                    letter-spacing: 0.01em;
                    text-transform: none;
                    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: 100%;
                    pointer-events: none;
                }
                .${tagClass}--trending .${tagClass}-rank { color: #ffd166; }

                /* Card-width sizing, matching the rating tag rules in tag-pipeline.js */
                @supports (container-type: inline-size) {
                    html:not(.layout-mobile) .je-tag-host .${tagClass} {
                        font-size: clamp(9px, 6.8cqw, 13px);
                        padding: clamp(2px, 2cqw, 4px) clamp(5px, 5cqw, 10px);
                        border-radius: clamp(4px, 3cqw, 6px);
                    }
                }

                .layout-mobile .${tagClass} {
                    padding: 2px 7px;
                    font-size: 11px;
                    border-radius: 5px;
                }

                @media (max-width: 768px) {
                    .${tagClass} { padding: 3px 8px; font-size: 12px; }
                }

                @media (max-width: 480px) {
                    .${containerClass} { top: ${pos.isTop ? '4px' : 'auto'}; bottom: ${pos.isTop ? 'auto' : '4px'}; left: ${pos.isLeft ? '4px' : 'auto'}; right: ${pos.isLeft ? 'auto' : '4px'}; }
                    .${tagClass} { padding: 2px 6px; font-size: clamp(10px, 2vw, 11px); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
                }
            `;
        },
        pipeline: {
            needsFirstEpisode: false,
            needsParentSeries: false,
            // Series/Season "New Episode" on the /tag-data fallback path.
            needsLatestEpisode: true,
            render(ctx, el, item, extras) {
                if (ctx.shouldIgnore(el)) return;
                if (ctx.isTagged(el)) return;
                if (el.closest('.je-hidden')) return;

                const data = fromItem(item);
                // A Spoiler Guard strip stub (no ProviderIds) is only cached when
                // it carries the TMDB id, so a full item's id is never lost to it.
                if (item.ProviderIds || data.tmdb || (data.type !== 'Movie' && data.type !== 'Series')) {
                    setCachedEntry(ctx, item.Id, data);
                }
                renderData(ctx, el, data, item.Id);
            },
            renderFromCache(ctx, el, itemId) {
                if (ctx.isTagged(el)) return true;
                if (ctx.shouldIgnore(el)) return true;
                if (el.closest('.je-hidden')) return true;
                const cached = getCachedEntry(ctx, itemId);
                if (!cached) return false;
                renderData(ctx, el, cached, itemId);
                // A cached "no badge" is still a cache hit — nothing to fetch.
                return true;
            },
            renderFromServerCache(ctx, el, entry, itemId) {
                if (ctx.isTagged(el)) return;
                if (ctx.shouldIgnore(el)) return;
                if (el.closest('.je-hidden')) return;
                renderData(ctx, el, fromServerEntry(entry), itemId);
            },
            onServerCacheRefresh(ctx, updatedIds) {
                onCacheReplaced(ctx, updatedIds);
            },
        },
    };

    /** @type {Object|null} ctx handle from the first registration */
    let statusCtx = null;
    /** @type {boolean} the session user-change hook is registered once per page */
    let userChangeRegistered = false;

    /**
     * Register the Status Tags renderer with the tag pipeline and start the
     * trending fetch. Idempotent: a repeat call re-registers with fresh settings.
     * @returns {void}
     */
    JE.initializeStatusTags = function() {
        console.log(`${logPrefix} Starting...`);

        if (!userChangeRegistered) {
            userChangeRegistered = true;
            // The outgoing user's cards and dates must not be redrawn by a
            // trending answer that lands during the switch; the pipeline
            // re-renders everything for the incoming user.
            JE.session?.onUserChange?.('status-tags', () => { trackRev++; staleBelowRev = trackRev; replacedAt.clear(); });
        }
        statusCtx = JE.core.tagRenderer.register('status', spec);
        statusCtx.injectCss();
        ensureTrending(statusCtx);

        console.log(`${logPrefix} Initialized successfully.`);
    };

    /**
     * Remove every status badge and redraw them with the current settings
     * (position, badge switches), fetching the trending list if now needed.
     * @returns {void}
     */
    JE.reinitializeStatusTags = function() {
        JE.core.tagRenderer.reinitialize('status', spec);
        if (statusCtx && JE.currentSettings?.statusTagsEnabled) ensureTrending(statusCtx);
    };

})(window.JellyfinEnhanced);
