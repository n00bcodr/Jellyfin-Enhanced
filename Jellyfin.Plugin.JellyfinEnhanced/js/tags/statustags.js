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
// come from /JellyfinEnhanced/status-tags/trending, fetched once per page
// lifetime (30 min TTL); cards drawn before it arrives get their date badge and
// one targeted pass upgrades the trending ones when it does.
//
// Spoiler Guard: dates are not spoilers (Jellyfin lists Date Added), so a strip
// stub just gets the normal date-based evaluation. Stubs carry no provider ids,
// so they never get a trending rank, and nothing extra is fetched for them.
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
     * Cards drawn while the first trending fetch was still in flight, upgraded
     * in one pass when it lands. Only Movies/Series with a TMDB id are kept.
     * @type {Array<{el: HTMLElement, data: Object}>}
     */
    let awaitingTrending = [];

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
        const tmdb = item.ProviderIds?.Tmdb;
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
     * Draw a card's badge, and remember it for the trending pass when the
     * trending list is still on its way and could change its badge.
     * @param {Object} ctx - Factory context.
     * @param {HTMLElement} el - Render target.
     * @param {Object} data - Normalized item data.
     * @returns {void}
     */
    function renderData(ctx, el, data) {
        // Cheap when fresh; refreshes a list that expired during a long session.
        ensureTrending(ctx);
        if (!trending.data && trending.promise && data.tmdb
            && (data.type === 'Movie' || data.type === 'Series')) {
            awaitingTrending.push({ el, data });
        }
        applyStatusTag(ctx, el, pickBadge(data));
    }

    /**
     * Once the trending list lands, re-tag the cards drawn without it that
     * turn out to be trending, then re-stack their corners in one pass.
     * @param {Object} ctx - Factory context.
     * @returns {void}
     */
    function applyTrendingPass(ctx) {
        const pending = awaitingTrending;
        awaitingTrending = [];
        if (!JE.currentSettings?.statusTagsEnabled) return;
        const hosts = [];
        for (const { el, data } of pending) {
            if (!el.isConnected || el.closest('.je-hidden')) continue;
            const badge = pickBadge(data);
            if (!badge || badge.kind !== 'trending') continue;
            applyStatusTag(ctx, el, badge);
            hosts.push(el);
        }
        if (hosts.length > 0) JE.core.tagRenderer.applyCornerStacking(hosts);
    }

    /**
     * Fetch the trending list unless it is fresh, already loading, switched
     * off, or recently failed. Stale data keeps being used while a refresh
     * runs, so only the first load of a page lifetime holds cards back.
     * @param {Object} ctx - Factory context.
     * @returns {void}
     */
    function ensureTrending(ctx) {
        if (!isTrendingWanted() || trending.promise) return;
        const now = Date.now();
        if (trending.data && now - trending.fetchedAt < TRENDING_TTL_MS) return;
        if (now < trending.retryAt) return;
        if (typeof ApiClient === 'undefined') return;

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
            applyTrendingPass(ctx);
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
                // A Spoiler Guard strip stub (no provider ids) is rendered from its
                // dates but not cached, so the full item's TMDB id isn't lost to it.
                if (item.ProviderIds || (data.type !== 'Movie' && data.type !== 'Series')) {
                    setCachedEntry(ctx, item.Id, data);
                }
                renderData(ctx, el, data);
            },
            renderFromCache(ctx, el, itemId) {
                if (ctx.isTagged(el)) return true;
                if (ctx.shouldIgnore(el)) return true;
                if (el.closest('.je-hidden')) return true;
                const cached = getCachedEntry(ctx, itemId);
                if (!cached) return false;
                renderData(ctx, el, cached);
                // A cached "no badge" is still a cache hit — nothing to fetch.
                return true;
            },
            renderFromServerCache(ctx, el, entry) {
                if (ctx.isTagged(el)) return;
                if (ctx.shouldIgnore(el)) return;
                if (el.closest('.je-hidden')) return;
                renderData(ctx, el, fromServerEntry(entry));
            },
        },
    };

    /** @type {Object|null} ctx handle from the first registration */
    let statusCtx = null;

    /**
     * Register the Status Tags renderer with the tag pipeline and start the
     * trending fetch. Idempotent: a repeat call re-registers with fresh settings.
     * @returns {void}
     */
    JE.initializeStatusTags = function() {
        console.log(`${logPrefix} Starting...`);

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
        awaitingTrending = [];
        JE.core.tagRenderer.reinitialize('status', spec);
        if (statusCtx && JE.currentSettings?.statusTagsEnabled) ensureTrending(statusCtx);
    };

})(window.JellyfinEnhanced);
