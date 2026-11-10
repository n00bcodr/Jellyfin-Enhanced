// /js/tags/statustags.js
// Jellyfin Status Tags - Badge posters with one status badge: what is new
// ("Just Added", "New Movie" / "New Series" / "New Episode"), popular ("#3
// Today"), a milestone ("New Season", "Season Premiere", "Season Finale",
// "Series Finale", "Complete Season"), on the schedule ("Airing Today",
// "Airs Thursday", "Returns Oct 4", "Coming Soon") or, when switched on, the
// series status ("Returning", "Ended", "Cancelled"), and two opt-in
// families: "Leaving in 5d" / "Leaving soon" (Maintainerr or the
// administrator's leaving collections, resolved by the server into the tag
// cache entry's Leaving) and a "Transcode" / "Won't direct play" warning for
// this browser (tags/tag-direct-play.js). The badge is drawn over
// the card, so the poster image itself (e.g. a custom poster set) is never
// replaced.
// A spec over the core tag-renderer factory (js/core/tag-renderer-base.js),
// which owns the cache/ignore/tagged/CSS/reinitialize plumbing. This module
// supplies only the status-specific parts: reading the item's facts, picking
// the one badge a card shows, the live TMDB data and the badge markup.
//
// One badge per card, first match wins (Leaving soon, when on, before all of
// them; the direct-play warning, when on, after all of them):
//   Movie   Trending → Coming Soon → New Movie → Just Added
//   Series  Trending → Airing Today → Series Finale → New Season → Airs {date}
//           → Returns {date} → New Episode → Coming Soon → New Series
//           → Just Added → Returning / Ended / Cancelled
//   Season  Complete Season → Season Premiere → Season Finale → New Episode
//           → Just Added
//   Episode Season Premiere → Series Finale / Season Finale → New Episode
//           → Just Added
//   BoxSet: Just Added (its newest member's added date)
//   Video: Just Added
// Library facts come from the server tag cache (DateCreated, PremiereDate,
// LatestEpisodeAdded/Aired/Index, SeasonPremiere, SeasonAddedSpan, Status;
// Unix ms) or the /tag-data batch fallback. Two live sources come on top:
// trending ranks from /JellyfinEnhanced/status-tags/trending (one shared list,
// refreshed after 30 minutes) and TMDB schedule facts per series from
// /JellyfinEnhanced/status-tags/series (asked for the series cards drawn, and
// the series of season/episode cards, in batches of up to 50; kept for an
// hour). Whenever either brings different data, one pass re-badges the cards
// on the page that depend on it (cards drawn before it arrives get their
// library-fact badge until then). Without a TMDB key only the library-fact
// badges show (and trending through Seerr).
//
// Spoiler Guard: dates are not spoilers (Jellyfin lists Date Added), so a
// guarded item gets the normal date-based evaluation, and a trending rank is
// not plot information, so a guarded Movie/Series keeps it: the server cache's
// strip keeps TmdbId and the /tag-data Series/Movie stubs carry it as TmdbId.
// Season/Episode stubs never get a rank anyway. A guarded Season/Episode
// loses its air dates and numbers (the strip drops them), so it never shows a
// premiere or finale badge. Nothing extra is fetched.
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Status Tags:';
    const containerClass = 'status-overlay-container';
    const tagClass = 'status-tag';
    const vocabulary = JE.statusVocabulary;
    const DAY_MS = vocabulary.thresholds.dayMs;
    // A cached entry's dates (a series' latest episode above all) can move, so
    // the persistent cache only answers for this long before a re-fetch.
    const CACHE_FRESH_MS = 60 * 60 * 1000;
    // Shape of the fallback cache entries; older entries count as misses.
    // v6: a collection's entry carries its newest member's added date.
    const CACHE_ENTRY_VERSION = 6;
    const TRENDING_TTL_MS = 30 * 60 * 1000;
    // A failed or empty trending fetch is retried sooner than a good list expires.
    const TRENDING_RETRY_MS = 5 * 60 * 1000;
    // TMDB schedule facts per series: kept this long (the server keeps its
    // TMDB answers 6 hours), retried sooner after a failed request.
    const SERIES_TTL_MS = 60 * 60 * 1000;
    const SERIES_RETRY_MS = 5 * 60 * 1000;
    /** Most series ids per /status-tags/series request (the server's cap). */
    const SERIES_BATCH = 50;
    // Ids asked for while cards are drawn are collected this long, then sent together.
    const SERIES_FLUSH_MS = 30;
    /** Parent refreshes use the tag pipeline's 200-id /tag-data limit. */
    const PARENT_FACTS_BATCH = 200;
    // Schedule badge windows: "Airs {date}" up to a week ahead; "Returns {date}"
    // when the next episode is more than two weeks after the last one and at
    // most a month ahead.
    const AIRS_WITHIN_DAYS = vocabulary.thresholds.airsWithinDays;
    const WEEKDAY_WITHIN_DAYS = vocabulary.thresholds.weekdayWithinDays;
    const RETURN_GAP_DAYS = vocabulary.thresholds.returnGapDays;
    const RETURNS_WITHIN_DAYS = vocabulary.thresholds.returnsWithinDays;
    // Placeholder for the rank inside the translated trending label, so the
    // number can sit in its own span whatever the locale's word order.
    const RANK_TOKEN = '\u0001';
    /** Shorter label for compact density, per badge key (the layout controller swaps it in). */
    const COMPACT_LABEL_KEYS = Object.fromEntries(Object.entries(vocabulary.badges)
        .filter(([, badge]) => badge.compact).map(([key, badge]) => [key, badge.compact]));
    // TMDB series statuses that mean no more episodes.
    const TMDB_ENDED = new Set(['Ended', 'Canceled']);

    // Which badges may show. Each resolves user override -> admin default ->
    // its built-in default, like the rating tag scope switches.
    const BADGE_SCOPES = {
        trending: { userKey: 'statusTagsTrending', pluginKey: 'StatusTagsTrending', fallback: true },
        newRelease: { userKey: 'statusTagsNewRelease', pluginKey: 'StatusTagsNewRelease', fallback: true },
        justAdded: { userKey: 'statusTagsJustAdded', pluginKey: 'StatusTagsJustAdded', fallback: true },
        schedule: { userKey: 'statusTagsSchedule', pluginKey: 'StatusTagsSchedule', fallback: true },
        milestones: { userKey: 'statusTagsMilestones', pluginKey: 'StatusTagsMilestones', fallback: true },
        scenes: { userKey: 'statusTagsScenes', pluginKey: 'StatusTagsScenes', fallback: false },
        seriesStatus: { userKey: 'statusTagsSeriesStatus', pluginKey: 'StatusTagsSeriesStatus', fallback: false },
        leaving: { userKey: 'statusTagsLeaving', pluginKey: 'StatusTagsLeaving', fallback: false },
        directPlay: { userKey: 'statusTagsDirectPlay', pluginKey: 'StatusTagsDirectPlay', fallback: false },
    };
    /** Item types the Leaving soon badge shows on (Maintainerr collects movies, shows, seasons and episodes). */
    const LEAVING_TYPES = new Set(['Movie', 'Series', 'Season', 'Episode']);
    /** The largest distance from 1970 a Date holds (ms). */
    const MAX_DATE_MS = 8.64e15;
    /** Item types that play, and so can have a direct-play warning. */
    const PLAYABLE_TYPES = new Set(['Movie', 'Episode', 'Video', 'MusicVideo']);

    /**
     * Trending list shared by every card of this page lifetime.
     * @type {{data: {source: string|null, movies: Object<string, number>, series: Object<string, number>}|null,
     *   fetchedAt: number, retryAt: number, promise: Promise<void>|null}}
     */
    const trending = { data: null, fetchedAt: 0, retryAt: 0, promise: null };

    /**
     * TMDB schedule facts per series item id (normalised, see normId), with
     * when they expire and whether a request for them is running.
     * @type {Map<string, {facts: SeriesFacts|null, expires: number, loading?: boolean, retry?: boolean}>}
     */
    const seriesInfo = new Map();
    /** @type {Set<string>} series ids waiting for the next batched request */
    const seriesQueue = new Set();
    /** @type {Set<string>} Expired parents waiting for a shared lookup. */
    const parentFactsQueue = new Set();
    /** @type {Set<string>} Parent ids already queued or loading. */
    const parentFactsLoads = new Set();
    /** @type {ReturnType<typeof setTimeout>|null} */
    let parentFactsTimer = null;
    /** @type {boolean} A single drain stays in flight even across reinitialisation. */
    let parentFactsLoading = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let seriesTimer = null;
    /** @type {ReturnType<typeof setTimeout>|null} One timer for failed visible lookups. */
    let seriesRetryTimer = null;
    /** @type {number} bumped on a user switch: answers for the previous user are dropped */
    let seriesEpoch = 0;
    /** @type {ReturnType<typeof setTimeout>|null} Single local-midnight refresh timer. */
    let midnightTimer = null;
    /** @type {number|null} Local day used by the last live pass. */
    let renderedDay = null;
    let calendarEventsRegistered = false;
    /** @type {boolean} False between teardown/user reset/pagehide and the next activation. */
    let statusActive = false;
    /** @type {IntersectionObserver|null} One observer for all schedule-reading cards. */
    let seriesObserver = null;
    /** @type {WeakSet<HTMLElement>} Cards currently intersecting the viewport. */
    let intersectingCards = new WeakSet();
    /** @type {Set<HTMLElement>} Targets explicitly released when removed or recycled. */
    const observedSeriesCards = new Set();
    /** @type {MutationObserver|null} Shared removal/identity watcher for schedule targets. */
    let seriesTargetObserver = null;

    /**
     * Every drawn card whose badge live data can change (a Movie/Series with
     * a TMDB id for trending, or a card that reads its series' TMDB schedule),
     * with its item id and data, the badge it shows and the revision it was
     * recorded under. The cards are found again through LIVE_ATTR, so
     * detached ones need no pruning. A record is only trusted while it is
     * current (see isCurrentRecord): a live pass leaves a stale card alone
     * until the pipeline renders it again.
     * @type {WeakMap<HTMLElement, {id: string|null, data: Object, shown: string, rev: number}>}
     */
    const liveCards = new WeakMap();
    /** @type {number} bumped whenever recorded data stops being trusted */
    let trackRev = 0;
    /** @type {number} records older than this are stale, whatever their item */
    let staleBelowRev = 0;
    /**
     * Item id → revision a delta replaced it at; a record older than that is
     * stale. Cleared whenever everything is marked stale at once, and when it
     * reaches REPLACED_AT_CAP (then everything is simply marked stale instead).
     * @type {Map<string, number>}
     */
    const replacedAt = new Map();
    const REPLACED_AT_CAP = 2000;
    const LIVE_ATTR = 'jeStatusLive';
    const LIVE_SELECTOR = '[data-je-status-live]';

    /**
     * @typedef {Object} StatusData
     * @property {number} [fetchedAt] - Original /tag-data fetch time, retained by cached snapshots.
     * @property {string|null} type - Jellyfin item type.
     * @property {string|null} tmdb - The item's TMDB id (trending).
     * @property {number|null} created - DateCreated (ms).
     * @property {number|null} premiere - PremiereDate (ms; Movie/Series/Episode).
     * @property {number|null} latest - Series/Season: newest episode DateCreated (ms); BoxSet: newest member DateCreated (ms).
     * @property {string|null} status - Series: Jellyfin status (Continuing/Ended/Unreleased).
     * @property {number|null} latestAired - Series/Season: newest episode air date (ms).
     * @property {{s: number, e: number, isLast: boolean}|null} latestIndex - Its season/episode numbers.
     * @property {{s: number, aired: number}|null} seasonPremiere - Series: newest season; Season: itself.
     * @property {{first: number, last: number, count: number, coveredThrough: number|null}|null} addedSpan - Season: episode added dates
     *   and the highest N with every episode 1..N in the library (null when not read).
     * @property {number|null} season - Season/Episode: season number.
     * @property {number|null} episode - Episode: episode number.
     * @property {number|null} episodeEnd - Episode: the last episode a combined file covers (S01E09-E10 → 10), else null.
     * @property {string} [media] - A fingerprint of the item's versions and streams (direct-play answers follow it).
     * @property {string[]} [versions] - The item's version ids, first one first (the direct-play lookup asks about the picked one).
     * @property {boolean|null} isLast - Whether this is the last locally available episode in its season.
     * @property {string|null} seriesId - The series whose TMDB schedule applies (Series: itself).
     * @property {string|null|undefined} seriesTmdb - That series' TMDB id; undefined when unknown.
     * @property {{deleteAt: number|null}|null} [leaving] - Leaving soon facts (deleteAt: Unix ms, or null when undated).
     * @property {boolean|null} [probed] - Video items: whether its first media source lists a video stream (false: Jellyfin would probe it); null when the data doesn't say.
     * @property {boolean} [strm] - Whether its file (or one of its sources) is a .strm, which Jellyfin probes on every playback lookup.
     */

    /**
     * @typedef {Object} SeriesFacts
     * @property {string|null} status - TMDB status ("Returning Series", "Ended", "Canceled", ...).
     * @property {{date: string, season: number|null, episode: number|null, type: string|null}|null} last
     * @property {{date: string, season: number|null, episode: number|null, type: string|null}|null} regular
     * @property {{date: string, season: number|null, episode: number|null}|null} next
     * @property {Object<string, number>|null} seasonEpisodes - TMDB's episode count per regular season.
     */

    /**
     * Resolve one badge switch: user override, then admin default, then its
     * built-in default.
     * @param {{userKey: string, pluginKey: string, fallback: boolean}} scope
     * @returns {boolean}
     */
    function isScopeEnabled(scope) {
        const u = JE.currentSettings?.[scope.userKey];
        if (typeof u === 'boolean') return u;
        const a = JE.pluginConfig?.[scope.pluginKey];
        return typeof a === 'boolean' ? a : scope.fallback;
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
     * Whether the Leaving soon badge can show: the user's switch, while the
     * server has a Leaving soon source (it resolves the facts).
     * @returns {boolean}
     */
    function isLeavingWanted() {
        return JE.pluginConfig?.LeavingSoonAvailable === true && isScopeEnabled(BADGE_SCOPES.leaving);
    }

    /**
     * Whether a card can get a direct-play warning: the user's switch and a
     * playable item type that Jellyfin's PlaybackInfo would not probe
     * (tags/tag-direct-play.js does the lookups). Jellyfin refreshes the item
     * with a remote probe when its file is a .strm, probed before or not, or
     * when its first source lists no video stream; those are skipped.
     * @param {StatusData} data
     * @returns {boolean}
     */
    function wantsDirectPlay(data) {
        return !!JE.tagDirectPlay && PLAYABLE_TYPES.has(data.type || '') && data.probed !== false && !data.strm && isScopeEnabled(BADGE_SCOPES.directPlay);
    }

    /**
     * Leaving soon facts from a cache entry or /tag-data item, or null.
     * @param {*} raw - { DeleteAt } (Unix ms or null).
     * @returns {{deleteAt: number|null}|null}
     */
    function readLeaving(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const deleteAt = toMs(raw.DeleteAt ?? raw.deleteAt ?? null);
        // A time no Date can hold reads as undated (the server bounds what it stores).
        return { deleteAt: deleteAt !== null && Math.abs(deleteAt) <= MAX_DATE_MS ? deleteAt : null };
    }

    /**
     * Whether a card's badge can depend on its series' TMDB schedule: the
     * admin's Status Tags switch and a TMDB key (both gate the endpoint), a
     * known series, and a badge switch that reads it for this card type.
     * @param {StatusData} data
     * @returns {boolean}
     */
    function wantsSeriesFacts(data) {
        if (JE.pluginConfig?.StatusTagsEnabled !== true || JE.pluginConfig?.TmdbEnabled !== true) return false;
        if (!data.seriesId || data.seriesTmdb === null) return false;
        if (data.type === 'Series') {
            return isScopeEnabled(BADGE_SCOPES.schedule) || isScopeEnabled(BADGE_SCOPES.milestones)
                || isScopeEnabled(BADGE_SCOPES.seriesStatus);
        }
        return (data.type === 'Season' || data.type === 'Episode') && isScopeEnabled(BADGE_SCOPES.milestones);
    }

    /**
     * Translate a badge label through the shared locale loader.
     * @param {string} key - Translation key.
     * @param {Object} [params] - Placeholder values, e.g. { rank }.
     * @returns {string}
     */
    function label(key, params) {
        return JE.t(key, params);
    }

    /**
     * An admin day window in ms, clamped to 1-365 days.
     * @param {string} pluginKey - e.g. 'StatusTagsJustAddedDays'.
     * @param {number} fallback - Default in days.
     * @returns {number}
     */
    function windowMs(pluginKey, fallback) {
        const raw = parseInt(JE.pluginConfig?.[pluginKey], 10);
        const days = Number.isFinite(raw) ? Math.min(vocabulary.thresholds.maxWindowDays, Math.max(vocabulary.thresholds.minWindowDays, raw)) : fallback;
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
     * A whole number, or null.
     * @param {*} value
     * @returns {number|null}
     */
    function toInt(value) {
        return typeof value === 'number' && Number.isInteger(value) ? value : null;
    }

    /**
     * An item id in one form (lowercase, no dashes), so ids from cards, cache
     * entries and server answers compare equal.
     * @param {*} id
     * @returns {string|null}
     */
    function normId(id) {
        if (id === null || id === undefined || id === '') return null;
        return String(id).replace(/-/g, '').toLowerCase();
    }

    /**
     * Read the episode-derived facts shared by server entries and /tag-data items.
     * @param {Object} src - TagCacheEntry or /tag-data item (PascalCase).
     * @returns {Pick<StatusData, 'status'|'latestAired'|'latestIndex'|'seasonPremiere'|'addedSpan'>}
     */
    function readFacts(src) {
        const index = src.LatestEpisodeIndex;
        const premiere = src.SeasonPremiere;
        const span = src.SeasonAddedSpan;
        return {
            scenes: src.Scenes || null,
            status: typeof src.Status === 'string' && src.Status ? src.Status : null,
            latestAired: toMs(src.LatestEpisodeAired),
            isLast: typeof src.EpisodeIndex?.IsLast === 'boolean' ? src.EpisodeIndex.IsLast : null,
            latestIndex: index && toInt(index.Season) !== null && toInt(index.Episode) !== null
                ? { s: index.Season, e: index.Episode, isLast: index.IsLast === true } : null,
            seasonPremiere: premiere && toInt(premiere.Season) !== null && toMs(premiere.Aired) !== null
                ? { s: premiere.Season, aired: toMs(premiere.Aired) } : null,
            addedSpan: span && toMs(span.First) !== null && toMs(span.Last) !== null && toInt(span.Count) !== null
                ? { first: toMs(span.First), last: toMs(span.Last), count: span.Count, coveredThrough: toInt(span.CoveredThrough) } : null,
        };
    }

    /**
     * The fields the badge rules read, from a server tag cache entry.
     * @param {Object} entry - TagCacheEntry.
     * @param {string|null} [itemId] - The entry's item id (a Series is its own series).
     * @returns {StatusData}
     */
    function fromServerEntry(entry, itemId) {
        const type = entry.Type || null;
        const tmdb = entry.TmdbId ? String(entry.TmdbId) : null;
        return {
            type,
            tmdb,
            created: toMs(entry.DateCreated),
            premiere: toMs(entry.PremiereDate),
            latest: toMs(entry.LatestEpisodeAdded),
            ...readFacts(entry),
            season: toInt(entry.EpisodeIndex?.Season ?? entry.SeasonNumber),
            episode: type === 'Episode' ? toInt(entry.EpisodeIndex?.Episode ?? entry.EpisodeNumber) : null,
            episodeEnd: type === 'Episode' ? toInt(entry.EpisodeIndex?.EpisodeEnd) : null,
            seriesId: type === 'Series' ? normId(itemId) : normId(entry.SeriesId),
            // The cache records the series' TMDB id on its seasons and episodes,
            // so a missing one means the series has none.
            seriesTmdb: type === 'Series' ? tmdb : (entry.SeriesTmdbId ? String(entry.SeriesTmdbId) : null),
            leaving: readLeaving(entry.Leaving),
            probed: probedOf(entry.StreamData?.Streams, entry.StreamData?.Sources),
            media: mediaKeyOf(entry.StreamData?.Streams, entry.StreamData?.Sources),
            versions: versionIds(entry.StreamData?.Sources),
            // The cache keeps the file name in ItemPath only when no source names it.
            strm: isStrm([entry.StreamData?.ItemPath, ...sourcePaths(entry.StreamData?.Sources)]),
        };
    }

    /**
     * The fields the badge rules read, from a /tag-data item (or a raw
     * BaseItemDto on the per-item fallback).
     * @param {Object} item
     * @returns {StatusData}
     */
    function fromItem(item) {
        const type = item.Type || null;
        // A Spoiler Guard strip stub has no ProviderIds, only the bare TmdbId.
        const tmdbRaw = item.ProviderIds?.Tmdb || item.TmdbId;
        const tmdb = tmdbRaw ? String(tmdbRaw) : null;
        return {
            type,
            tmdb,
            created: toMs(item.DateCreated),
            premiere: toMs(item.PremiereDate),
            latest: toMs(item.LatestEpisodeAdded),
            ...readFacts(item),
            season: type === 'Episode' ? toInt(item.EpisodeIndex?.Season ?? item.ParentIndexNumber) : type === 'Season' ? toInt(item.IndexNumber) : null,
            episode: type === 'Episode' ? toInt(item.EpisodeIndex?.Episode ?? item.IndexNumber) : null,
            episodeEnd: type === 'Episode' ? toInt(item.EpisodeIndex?.EpisodeEnd ?? item.IndexNumberEnd) : null,
            seriesId: type === 'Series' ? normId(item.Id) : normId(item.SeriesId),
            // A season/episode item does not say whether its series has a TMDB
            // id; the server answers only for those that do.
            seriesTmdb: type === 'Series' ? tmdb : undefined,
            leaving: readLeaving(item.Leaving),
            probed: probedOf(item.MediaStreams, item.MediaSources),
            media: mediaKeyOf(item.MediaStreams, item.MediaSources),
            versions: versionIds(item.MediaSources),
            strm: isStrm([item.Path, ...sourcePaths(item.MediaSources)]),
        };
    }

    /**
     * Whether a video item's media was probed as Jellyfin's PlaybackInfo
     * checks it: its first media source lists a video stream (streams are
     * matched to it by SourceId when they carry one). Jellyfin probes the
     * item otherwise, so the direct-play lookup skips it.
     * @param {*} streams - The item's streams (cache entry StreamData.Streams or /tag-data MediaStreams).
     * @param {*} [sources] - Its media sources, first one first (StreamData.Sources or /tag-data MediaSources).
     * @returns {boolean|null} null when the data has no stream list (stripped or not sent).
     */
    function probedOf(streams, sources) {
        if (!Array.isArray(streams)) return null;
        const first = Array.isArray(sources) ? sources[0]?.Id : null;
        const ofFirst = first && streams.some((stream) => stream?.SourceId) ? streams.filter((stream) => stream?.SourceId === first) : streams;
        return ofFirst.some((stream) => stream?.Type === 'Video');
    }

    /**
     * A short fingerprint of what a direct-play verdict depends on. The server gives each version a
     * Revision over every stream fact a device profile condition can read (bitrates, bit depth, level,
     * scan type, frame rate, codec tag, anamorphic, reference frames, rotation, Dolby Vision facts…);
     * without one, the version ids and paths and the same facts of the streams at hand.
     * A replaced or re-encoded file changes it, so an old verdict is never shown for new media; score
     * or review changes do not.
     * @param {*} streams
     * @param {*} [sources]
     * @returns {string}
     */
    function mediaKeyOf(streams, sources) {
        const parts = [];
        const list = Array.isArray(sources) ? sources : [];
        const revised = list.length > 0 && list.every(source => typeof source?.Revision === 'string' && source.Revision);
        // The inputs the server's Revision hashes (tag-direct-play.js INPUTS); without that module there is no warning.
        const inputs = JE.tagDirectPlay?.INPUTS || { source: ['Id', 'Path'], stream: [] };
        for (const source of list) {
            parts.push(revised ? `${source?.Id || ''}:${source?.Path || ''}:${source.Revision}` : inputs.source.map(field => source?.[field] ?? '').join(','));
        }
        for (const stream of !revised && Array.isArray(streams) ? streams : []) {
            parts.push([stream?.SourceId, ...inputs.stream.map(field => stream?.[field])].map(v => v ?? '').join(','));
        }
        let hash = 0x811c9dc5;
        for (const char of parts.join('|')) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
        return hash.toString(36);
    }

    /**
     * @param {*} sources
     * @returns {string[]} The item's version ids, first one first.
     */
    function versionIds(sources) {
        return Array.isArray(sources) ? sources.map((source) => source?.Id).filter((id) => typeof id === 'string' && id) : [];
    }

    /**
     * The version a card stands for: the user's pick (qualitytags.js) when it is one of the item's versions,
     * else '' (the default one Jellyfin plays).
     * @param {StatusData} data
     * @param {string} itemId
     * @returns {string}
     */
    function versionOf(data, itemId) {
        const picked = JE.selectedMediaSource?.(itemId) || '';
        return picked && (data.versions || []).includes(picked) ? picked : '';
    }

    /**
     * @param {*} sources
     * @returns {Array<*>} The sources' file names (unknown entries included as undefined).
     */
    function sourcePaths(sources) {
        return Array.isArray(sources) ? sources.map((source) => source?.Path) : [];
    }

    /**
     * Whether any of the given file names is a .strm (Jellyfin compares
     * without case).
     * @param {Array<*>} paths
     * @returns {boolean}
     */
    function isStrm(paths) {
        return paths.some((path) => typeof path === 'string' && path.toLowerCase().endsWith('.strm'));
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
     * A local calendar day as a day number (days since 1970-01-01), so two
     * days compare without time zones.
     * @param {number} ms
     * @returns {number}
     */
    function localDay(ms) {
        const d = new Date(ms);
        return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
    }

    /**
     * A TMDB air date ("2026-10-04", a calendar date) as a day number, or null.
     * @param {string|null|undefined} date
     * @returns {number|null}
     */
    function airDay(date) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
        return m ? Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS) : null;
    }

    /**
     * The locale dates are written in: the user's Jellyfin display language
     * (the one JE's strings follow), else JE's display language setting, else
     * the page's, else the browser's.
     * @returns {string|undefined}
     */
    function dateLocale() {
        let uiLanguage = null;
        try {
            const userId = JE.session?.getUserId?.();
            if (userId) uiLanguage = localStorage.getItem(`${userId}-language`);
        } catch {
            // Storage blocked: fall through to the other sources.
        }
        const candidates = [uiLanguage, JE.currentSettings?.displayLanguage, document.documentElement?.getAttribute('lang')];
        for (const candidate of candidates) {
            if (!candidate) continue;
            try {
                if (Intl.DateTimeFormat.supportedLocalesOf(candidate).length > 0) return candidate;
            } catch {
                // Not a valid language tag; try the next one.
            }
        }
        return undefined;
    }

    /** Remember the web user's date context for static native posters on a personal save.
     * @returns {{locale: string, timeZone: string}}
     */
    JE.getStatusDateContext = function() {
        const options = new Intl.DateTimeFormat(dateLocale()).resolvedOptions();
        return { locale: options.locale, timeZone: options.timeZone };
    };

    /**
     * The {date} of "Airs {date}" / "Returns {date}": "Tomorrow", a weekday
     * name up to WEEKDAY_WITHIN_DAYS days ahead, else a short date ("Oct 4"),
     * in the user's locale.
     * @param {number} day - The air date as a day number.
     * @param {number} daysAhead - Days from today (1 or more).
     * @returns {string}
     */
    function formatAirDay(day, daysAhead) {
        if (daysAhead === 1) return label('calendar_tomorrow');
        // The day number is a UTC midnight, so format it in UTC.
        const date = new Date(day * DAY_MS);
        const options = daysAhead <= WEEKDAY_WITHIN_DAYS
            ? { weekday: 'long', timeZone: 'UTC' }
            : { month: 'short', day: 'numeric', timeZone: 'UTC' };
        try {
            return new Intl.DateTimeFormat(dateLocale(), /** @type {Intl.DateTimeFormatOptions} */ (options)).format(date);
        } catch {
            return new Intl.DateTimeFormat('en', /** @type {Intl.DateTimeFormatOptions} */ (options)).format(date);
        }
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
     * The TMDB schedule facts of a card's series, when they have arrived.
     * @param {StatusData} data
     * @returns {SeriesFacts|null}
     */
    function seriesFactsFor(data) {
        return data.seriesId ? seriesInfo.get(data.seriesId)?.facts ?? null : null;
    }

    /**
     * Complete Season needs proof (StatusRules.SeasonComplete): TMDB's episode count for the season, every one of
     * them aired (no next episode in it), and the library covering every episode number 1..N.
     * @param {StatusData} data
     * @param {SeriesFacts|null} facts
     * @returns {boolean}
     */
    function seasonComplete(data, facts) {
        const season = data.season ?? data.latestIndex?.s ?? null;
        const expected = season !== null ? toInt(facts?.seasonEpisodes?.[season]) : null;
        if (!expected || expected <= 0) return false;
        if (facts.next && facts.next.season !== null && facts.next.season <= season) return false;
        const last = facts.last;
        if (!last || last.season === null || last.season < season || (last.season === season && (last.episode ?? 0) < expected)) return false;
        // Duplicates and extra numbers cannot fill a gap; a multi-episode file covers its range.
        return (data.addedSpan?.coveredThrough ?? 0) >= expected;
    }

    /**
     * Whether TMDB's newest aired episode ended its season: TMDB marks it a
     * finale (episode_type, since 2023), or, without a type, nothing more is
     * scheduled in that season and the local episode is its season’s last.
     * @param {SeriesFacts} facts
     * @param {boolean|null} isLast - Local season-boundary confirmation for the fallback.
     * @returns {boolean}
     */
    function lastAiredEndsSeason(facts, isLast) {
        const last = facts.last;
        if (!last) return false;
        if (last.type) return last.type === 'finale';
        return isLast === true && (!facts.next || (facts.next.season !== null && last.season !== null && facts.next.season > last.season));
    }

    /**
     * A badge from its key ('new_season', 'airs_date', ...): the en.json key is
     * `status_tag_<key>`, the compact label comes from COMPACT_LABEL_KEYS.
     * @param {'trending'|'new'|'added'|'schedule'|'milestone'|'status'} kind - Chip modifier class.
     * @param {string} key
     * @param {Object} [params]
     * @returns {{kind: string, key: string, label: string, compact?: string}}
     */
    function makeBadge(kind, key, params) {
        const definition = vocabulary.badges[key];
        const badge = { kind: definition.kind, key, label: label(definition.label, params) };
        if (COMPACT_LABEL_KEYS[key]) badge.compact = label(COMPACT_LABEL_KEYS[key], params);
        return badge;
    }

    /**
     * The Leaving soon badge: "Leaving in {days}d" by local calendar days (a
     * DST day is not 24 hours), "Leaving tomorrow", "Leaving today", and
     * "Leaving soon" without a date or once it has passed (Maintainerr
     * removes it on its next run). Mirrors StatusRules.LeavingBadge.
     * @param {{deleteAt: number|null}} leaving
     * @param {number} now
     * @returns {{kind: string, key: string, label: string, compact?: string}}
     */
    function leavingBadge(leaving, now) {
        if (leaving.deleteAt === null) return makeBadge('leaving', 'leaving_soon');
        const days = localDay(leaving.deleteAt) - localDay(now);
        if (days < 0) return makeBadge('leaving', 'leaving_soon');
        if (days === 0) return makeBadge('leaving', 'leaving_today');
        if (days === 1) return makeBadge('leaving', 'leaving_tomorrow');
        return makeBadge('leaving', 'leaving_days', { days });
    }

    /**
     * The direct-play warning for a playable card, once its lookup answered.
     * @param {StatusData} data
     * @param {string|null} itemId
     * @returns {{kind: string, key: string, label: string, compact?: string, title?: string}|null}
     */
    function directPlayBadge(data, itemId) {
        if (!itemId || !wantsDirectPlay(data)) return null;
        const result = JE.tagDirectPlay.peek(String(itemId), data.media || '', versionOf(data, String(itemId)));
        if (!result || result.directPlay) return null;
        const badge = makeBadge('playback', result.remux ? 'direct_play_remux' : 'direct_play_transcode');
        badge.title = JE.tagDirectPlay.describe(result, badge.label);
        return badge;
    }

    /**
     * Resolve one regular finale for both card types: caller-filtered series
     * aggregate, regular TMDB last episode, season enrichment, local aggregate.
     * Never infer a series boundary from an episode's season-local IsLast flag.
     * @param {StatusData} data
     * @param {SeriesFacts|null} facts
     * @returns {SeriesFacts['last']}
     */
    function finalRegularEpisode(data, facts) {
        if (!facts) return null;
        const parent = JE.tagPipeline?.peekItemFacts?.(data.seriesId)
            || JE.tagPipeline?.peekServerEntry?.(data.seriesId);
        const aggregate = parent ? readFacts(parent) : data.type === 'Series' ? data : readFacts({});
        // The library's latest episode only stands in for TMDB's finale when TMDB's per-season counts show it is the
        // last episode of the last season (StatusRules.FinalRegularEpisode).
        const counts = facts.seasonEpisodes || {};
        const lastSeason = Math.max(0, ...Object.keys(counts).map(Number).filter(Number.isFinite));
        /** @param {Object} local @returns {SeriesFacts['last']} */
        const regular = local => {
            if (!(local.latestIndex?.s > 0) || local.latestAired === null) return null;
            if (local.latestIndex.s !== lastSeason || toInt(counts[lastSeason]) !== local.latestIndex.e) return null;
            // The air date is a calendar date (stored at midnight UTC): keep its day, as TMDB's own dates are kept.
            const date = new Date(local.latestAired);
            const day = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
            return { date: day, season: local.latestIndex.s, episode: local.latestIndex.e, type: null };
        };
        // TMDB's final regular episode first: local S1E3 is not the finale of a ten-episode season TMDB has ended.
        return (facts.last?.season > 0 ? facts.last : null)
            || (facts.regular?.season > 0 ? facts.regular : null)
            || regular(aggregate)
            || regular(readFacts(JE.tagPipeline?.peekSeasonFacts?.(data.seriesId, data.season) || {}))
            || regular(data);
    }

    /**
     * Pick the one badge a card shows (first match wins), or null.
     * @param {StatusData} data - Card snapshot, refreshed from shared facts when available.
     * @param {string|null} itemId - The card's own item id (never its parent id).
     * @param {Element|null} [el] - The card, whose played check says the viewer has watched it all.
     * @returns {{kind: string, key: string, label: string, compact?: string, rank?: number}|null}
     */
    function pickBadge(data, itemId, el) {
        const current = JE.tagPipeline?.peekItemFacts?.(normId(itemId));
        if (current) {
            // Shared caller-filtered facts are authoritative, including removed fields.
            Object.assign(data, readFacts(current), { latest: toMs(current.LatestEpisodeAdded) });
        }
        // An admin switch: no status badge on collections at all.
        if (data.type === 'BoxSet' && JE.pluginConfig?.StatusTagsOnCollections === false) return null;
        const now = Date.now();
        const today = localDay(now);
        const justAddedMs = windowMs('StatusTagsJustAddedDays', vocabulary.thresholds.justAddedDays);
        const newReleaseMs = windowMs('StatusTagsNewReleaseDays', vocabulary.thresholds.newReleaseDays);
        const showNew = isScopeEnabled(BADGE_SCOPES.newRelease);
        const showAdded = isScopeEnabled(BADGE_SCOPES.justAdded);
        const showSchedule = isScopeEnabled(BADGE_SCOPES.schedule);
        const showMilestones = isScopeEnabled(BADGE_SCOPES.milestones);
        const showStatus = isScopeEnabled(BADGE_SCOPES.seriesStatus);
        const facts = wantsSeriesFacts(data) ? seriesFactsFor(data) : null;

        if (data.leaving && LEAVING_TYPES.has(data.type || '') && isLeavingWanted()) return leavingBadge(data.leaving, now);

        // Match the series aggregate: specials never identify a final regular episode.
        const finalRegular = finalRegularEpisode(data, facts);
        const BINGE_DROP_DAYS = 3;
        const finalDay = airDay(finalRegular?.date);
        const finalAiredRecently = finalDay !== null && finalDay <= today && (today - finalDay) * DAY_MS <= newReleaseMs;
        // A premiere date is a calendar day (Jellyfin stores it at midnight UTC): it is compared with
        // the viewer's own today, so release day starts at local midnight in every time zone.
        const premiereDay = (ms) => (ms === null || ms === undefined ? null : Math.floor(ms / DAY_MS));
        const airedWithin = (ms, windowMs) => { const day = premiereDay(ms); return day !== null && day <= today && (today - day) * DAY_MS <= windowMs; };
        const isNewRelease = airedWithin(data.premiere, newReleaseMs);
        const comingSoon = data.premiere !== null && premiereDay(data.premiere) > today;
        // A collection is recreated by library scans (a fresh DateCreated every time), so its
        // newest member's added date stands in; without that fact it shows no badge.
        const addedRecently = isWithin(data.type === 'BoxSet' ? data.latest : data.created, now, justAddedMs);
        // "New Episode" on a container: an episode arrived recently in a
        // container that was itself already there before the window (else it
        // is just added).
        // Not for a viewer who has watched everything in it: Jellyfin shows that as the card's played check.
        const watchedAll = !!(el?.closest('.card') || el)?.querySelector('.playedIndicator');
        const newEpisode = isWithin(data.latest, now, justAddedMs)
            && data.created !== null && now - data.created > justAddedMs && !watchedAll;
        // TMDB's next/last episode, as day numbers and days from today.
        const nextDay = airDay(facts?.next?.date);
        const lastDay = airDay(facts?.last?.date);
        const daysToNext = nextDay === null ? null : nextDay - today;
        // TMDB's newest aired episode aired within the new-release window.
        const lastAiredRecently = lastDay !== null && lastDay <= today && (today - lastDay) * DAY_MS <= newReleaseMs;

        if ((data.type === 'Movie' || data.type === 'Series') && isTrendingWanted()) {
            const rank = trendingRank(data);
            if (rank !== null) {
                const key = trending.data?.source === 'seerr-week' ? 'trending_week' : 'trending_today';
                return { kind: 'trending', key, label: label(vocabulary.badges[key].label, { rank: RANK_TOKEN }), rank };
            }
        }
        switch (data.type) {
            case 'Movie':
                if (showSchedule && comingSoon) return makeBadge('schedule', 'coming_soon');
                if (showNew && isNewRelease) return makeBadge('new', 'new_movie');
                break;
            case 'Series': {
                if (showSchedule && daysToNext === 0) return makeBadge('schedule', 'airing_today');
                // The finale of an ended show, aired recently and in the library.
                if (showMilestones && finalRegular && TMDB_ENDED.has(facts.status || '') && finalAiredRecently
                    && data.latestIndex && data.latestIndex.s === finalRegular.season && data.latestIndex.e === finalRegular.episode) {
                    // A show released in one drop (premiere and finale days apart) is binge ready, not finishing a run.
                    const first = premiereDay(data.premiere);
                    return makeBadge('milestone', first !== null && finalDay - first <= BINGE_DROP_DAYS ? 'binge_ready' : 'series_finale');
                }
                const sp = data.seasonPremiere;
                if (showMilestones && sp && sp.s > 1 && airedWithin(sp.aired, newReleaseMs)) return makeBadge('milestone', 'new_season');
                if (showSchedule && daysToNext !== null && daysToNext >= 1 && daysToNext <= AIRS_WITHIN_DAYS) {
                    return makeBadge('schedule', 'airs_date', { date: formatAirDay(/** @type {number} */ (nextDay), daysToNext) });
                }
                if (showSchedule && daysToNext !== null && daysToNext >= 1 && daysToNext <= RETURNS_WITHIN_DAYS
                    && lastDay !== null && /** @type {number} */ (nextDay) - lastDay > RETURN_GAP_DAYS) {
                    return makeBadge('schedule', 'returns_date', { date: formatAirDay(/** @type {number} */ (nextDay), daysToNext) });
                }
                if (showNew && newEpisode) return makeBadge('new', 'new_episode');
                if (showSchedule && comingSoon) return makeBadge('schedule', 'coming_soon');
                if (showNew && isNewRelease) return makeBadge('new', 'new_series');
                break;
            }
            case 'Season': {
                const span = data.addedSpan;
                // Every available episode arrived within the just-added window, and they are the whole season.
                if (showMilestones && span && span.count > 0 && span.first <= span.last && isWithin(span.first, now, justAddedMs) && isWithin(span.last, now, justAddedMs)
                    && seasonComplete(data, facts)) {
                    return makeBadge('milestone', 'complete_season');
                }
                if (showMilestones && data.seasonPremiere && airedWithin(data.seasonPremiere.aired, newReleaseMs)) {
                    return makeBadge('milestone', 'season_premiere');
                }
                const season = data.season ?? data.seasonPremiere?.s ?? data.latestIndex?.s ?? null;
                if (showMilestones && facts?.last && lastAiredRecently && season !== null && facts.last.season === season
                    && data.latestIndex && data.latestIndex.s === season && data.latestIndex.e === facts.last.episode
                    && lastAiredEndsSeason(facts, data.latestIndex.isLast)) {
                    return makeBadge('milestone', 'season_finale');
                }
                if (showNew && newEpisode) return makeBadge('new', 'new_episode');
                break;
            }
            case 'Episode': {
                // Its own air date: a guarded (stripped) episode has none.
                const airedRecently = data.premiere !== null && premiereDay(data.premiere) <= today;
                if (showMilestones && airedRecently && data.episode === 1 && data.season !== null && data.season > 0
                    && airedWithin(data.premiere, justAddedMs)) {
                    return makeBadge('milestone', 'season_premiere');
                }
                // A combined file (S01E09-E10) is the finale when it holds the final episode.
                const holds = number => data.episode !== null && number >= data.episode && number <= (data.episodeEnd ?? data.episode);
                if (showMilestones && airedRecently && finalRegular && finalAiredRecently
                    && data.season === finalRegular.season && holds(finalRegular.episode)
                    && TMDB_ENDED.has(facts.status || '')) return makeBadge('milestone', 'series_finale');
                if (showMilestones && airedRecently && facts?.last && lastAiredRecently
                    && data.season === facts.last.season && holds(facts.last.episode)) {
                    if (lastAiredEndsSeason(facts, data.isLast)) return makeBadge('milestone', 'season_finale');
                }
                if (showNew && airedWithin(data.premiere, justAddedMs)) return makeBadge('new', 'new_episode');
                break;
            }
            case 'BoxSet':
            case 'Video':
                break;
            default:
                return null;
        }
        if (showAdded && addedRecently) return makeBadge('added', 'just_added');
        if (data.type === 'Movie' && isScopeEnabled(BADGE_SCOPES.scenes)) {
            if (data.scenes?.PostCredits === true) return makeBadge('scenes', 'post_credits');
            if (data.scenes?.MidCredits === true) return makeBadge('scenes', 'mid_credits');
        }
        if (data.type === 'Series' && showStatus) return seriesStatusBadge(data, facts);
        return directPlayBadge(data, itemId);
    }

    /**
     * The lowest-priority Series badge: Jellyfin first, with TMDB refining
     * an ended series to cancelled or supplying an absent Jellyfin status.
     * @param {StatusData} data
     * @param {SeriesFacts|null} facts
     * @returns {{kind: string, key: string, label: string}|null}
     */
    function seriesStatusBadge(data, facts) {
        if (data.status === 'Continuing') return makeBadge('status', 'returning');
        if (data.status === 'Ended') return makeBadge('status', facts?.status === 'Canceled' ? 'cancelled' : 'ended');
        switch (facts?.status || '') {
            case 'Returning Series': return makeBadge('status', 'returning');
            case 'Ended': return makeBadge('status', 'ended');
            case 'Canceled': return makeBadge('status', 'cancelled');
            default: break;
        }
        return null;
    }

    /**
     * Retrieve a fresh cached entry from localStorage or hot cache.
     * @param {Object} ctx - Factory context.
     * @param {string} itemId - Jellyfin item ID.
     * @returns {StatusData|null} Cached data, or null when unknown, too old to
     *   trust, or stored in an older shape.
     */
    function getCachedEntry(ctx, itemId) {
        const entry = ctx.getPersistent(itemId) ?? ctx.hot?.get(itemId);
        if (!entry || typeof entry !== 'object' || entry.v !== CACHE_ENTRY_VERSION) return null;
        if (typeof entry.timestamp !== 'number' || Date.now() - entry.timestamp > CACHE_FRESH_MS) return null;
        return {
            fetchedAt: entry.timestamp,
            type: entry.t ?? null,
            tmdb: entry.m ?? null,
            created: entry.c ?? null,
            premiere: entry.p ?? null,
            latest: entry.l ?? null,
            status: entry.st ?? null,
            scenes: entry.sc ?? null,
            latestAired: entry.la ?? null,
            isLast: entry.il ?? null,
            latestIndex: Array.isArray(entry.li) ? { s: entry.li[0], e: entry.li[1], isLast: entry.li[2] === true } : null,
            seasonPremiere: Array.isArray(entry.sp) ? { s: entry.sp[0], aired: entry.sp[1] } : null,
            addedSpan: Array.isArray(entry.as) ? { first: entry.as[0], last: entry.as[1], count: entry.as[2], coveredThrough: entry.as[3] ?? null } : null,
            season: entry.sn ?? null,
            episode: entry.en ?? null,
            episodeEnd: entry.ee ?? null,
            media: entry.mk ?? '',
            seriesId: entry.si ?? null,
            // Stored only when known (null and undefined both mean "unknown" here).
            seriesTmdb: entry.stm ?? (entry.t === 'Series' ? null : undefined),
            leaving: Array.isArray(entry.lv) ? readLeaving({ DeleteAt: typeof entry.lv[0] === 'number' ? entry.lv[0] : null }) : null,
        };
    }

    /**
     * Store an entry in both localStorage cache and hot cache. Null fields are
     * left out to keep the stored copy small.
     * @param {Object} ctx - Factory context.
     * @param {string} itemId - Jellyfin item ID.
     * @param {StatusData} data
     * @returns {void}
     */
    function setCachedEntry(ctx, itemId, data) {
        const entry = { v: CACHE_ENTRY_VERSION, t: data.type, timestamp: data.fetchedAt ?? Date.now() };
        if (data.tmdb) entry.m = data.tmdb;
        if (data.created !== null) entry.c = data.created;
        if (data.premiere !== null) entry.p = data.premiere;
        if (data.latest !== null) entry.l = data.latest;
        if (data.status) entry.st = data.status;
        if (data.scenes) entry.sc = data.scenes;
        if (data.latestAired !== null) entry.la = data.latestAired;
        if (data.isLast !== null) entry.il = data.isLast;
        if (data.latestIndex) entry.li = [data.latestIndex.s, data.latestIndex.e, data.latestIndex.isLast];
        if (data.seasonPremiere) entry.sp = [data.seasonPremiere.s, data.seasonPremiere.aired];
        if (data.addedSpan) entry.as = [data.addedSpan.first, data.addedSpan.last, data.addedSpan.count, data.addedSpan.coveredThrough];
        if (data.season !== null) entry.sn = data.season;
        if (data.episode !== null) entry.en = data.episode;
        if (data.episodeEnd != null) entry.ee = data.episodeEnd;
        if (data.media) entry.mk = data.media;
        if (data.seriesId) entry.si = data.seriesId;
        if (data.seriesTmdb) entry.stm = data.seriesTmdb;
        if (data.leaving) entry.lv = [data.leaving.deleteAt];
        ctx.setPersistent(itemId, entry);
        ctx.hot?.set(itemId, entry);
    }

    /**
     * Create and append the status badge to a card.
     * @param {Object} ctx - Factory context.
     * @param {HTMLElement} el - The card container to receive the overlay.
     * @param {{kind: string, key: string, label: string, compact?: string, rank?: number, title?: string}|null} badge - From pickBadge.
     * @returns {void}
     */
    function applyStatusTag(ctx, el, badge) {
        if (!badge) return;

        ctx.removeExistingOverlay(el);

        const container = document.createElement('div');
        container.className = containerClass;

        const tag = document.createElement('div');
        tag.className = `${tagClass} ${tagClass}--${badge.kind}`;
        // Preserve the existing Tag Styles selectors; new vocabulary uses its badge key.
        const status = vocabulary.badges[badge.key].style;
        tag.dataset.jeStatus = status;
        // The layout controller shows this instead in compact density.
        if (badge.compact) tag.dataset.jeCompact = badge.compact;
        // The direct-play warning says why (and takes hover for its tooltip).
        if (badge.title) {
            tag.title = badge.title;
            tag.setAttribute('aria-label', badge.title);
            tag.dataset.jeDp = '1';
        }
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
     * @param {{kind: string, key: string, label: string, rank?: number}|null} badge
     * @returns {string}
     */
    function badgeKey(badge) {
        return `${localDay(Date.now())}|${badge ? `${badge.kind}|${badge.key}|${badge.label}|${badge.rank ?? ''}|${badge.title ?? ''}` : ''}`;
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
     * Draw a card's badge, and remember a card live data can re-badge (a
     * Movie/Series with a TMDB id for trending, a card reading its series'
     * TMDB schedule) for the pass that runs when that data changes. Asks for
     * the series' schedule when it is not known or has expired.
     * @param {Object} ctx - Factory context.
     * @param {HTMLElement} el - Render target.
     * @param {StatusData} data - Normalized item data.
     * @param {string|null} [itemId] - Jellyfin item id the data came from.
     * @returns {void}
     */
    function renderData(ctx, el, data, itemId) {
        // Cheap when fresh; refreshes a list that expired during a long session.
        activateStatus(ctx);
        ensureTrending(ctx);
        const readsSeries = wantsSeriesFacts(data);
        const badge = pickBadge(data, itemId, el);
        // All date badges can change when a local day passes.
        const previous = liveCards.get(el);
        if (!readsSeries || (previous && (previous.id !== normId(itemId) || previous.domId !== cardIdentity(el)))) {
            unobserveSeriesCard(el);
        }
        liveCards.set(el, { domId: cardIdentity(el), id: normId(itemId), data, shown: badgeKey(badge), rev: trackRev });
        el.dataset[LIVE_ATTR] = '1';
        if (readsSeries) observeSeriesCard(ctx, el);
        // A direct-play lookup only for a card that would show nothing else,
        // and only once it is on screen (the module's idle slices).
        if (wantsDirectPlay(data) && itemId && (!badge || badge.kind === 'playback')) JE.tagDirectPlay.track(el, String(itemId), onDirectPlayAnswer, data.media || '', versionOf(data, String(itemId)));
        else JE.tagDirectPlay?.untrack(el);
        applyStatusTag(ctx, el, badge);
    }

    /**
     * Observe schedule readers through one viewport observer, retaining identity guards.
     * @param {Object} ctx @param {HTMLElement} el
     * @returns {void}
     */
    function observeSeriesCard(ctx, el) {
        if (!seriesObserver && typeof IntersectionObserver !== 'undefined') {
            const observer = new IntersectionObserver(entries => {
                if (seriesObserver !== observer) return; // A queued callback from before cleanup.
                for (const { target, isIntersecting } of entries) {
                    const host = /** @type {HTMLElement} */ (target);
                    if (!observedSeriesCards.has(host)) continue;
                    const card = liveCards.get(host);
                    if (!host.isConnected || card?.domId !== cardIdentity(host)) {
                        forgetSeriesCard(host);
                        continue;
                    }
                    if (isIntersecting) intersectingCards.add(host);
                    else intersectingCards.delete(host);
                    if (isIntersecting && eligibleSeriesCard(host, card)) {
                        requestSeries(ctx, card.data.seriesId);
                        armSeriesRetry(ctx);
                    }
                }
            });
            seriesObserver = observer;
            seriesTargetObserver = new MutationObserver(() => {
                for (const host of observedSeriesCards) {
                    const card = liveCards.get(host);
                    if (!host.isConnected || card?.domId !== cardIdentity(host)) forgetSeriesCard(host);
                }
            });
            seriesTargetObserver.observe(document.body, {
                subtree: true, childList: true, attributes: true, attributeFilter: ['data-id', 'data-itemid'],
            });
        }
        if (seriesObserver && !observedSeriesCards.has(el)) {
            observedSeriesCards.add(el);
            seriesObserver.observe(el);
        }
        const card = liveCards.get(el);
        if (eligibleSeriesCard(el, card)) requestSeries(ctx, card.data.seriesId);
    }

    /** @param {HTMLElement} el @returns {string|null} Current pipeline card identity. */
    function cardIdentity(el) {
        const card = el.closest('[data-id], [data-itemid]');
        return card?.getAttribute('data-id') || card?.getAttribute('data-itemid') || null;
    }

    /** @param {HTMLElement} el @returns {void} Release a target and its previous visibility. */
    function unobserveSeriesCard(el) {
        seriesObserver?.unobserve(el);
        observedSeriesCards.delete(el);
        intersectingCards.delete(el);
    }

    /** @param {HTMLElement} el @returns {void} Forget a removed or recycled card's live data. */
    function forgetSeriesCard(el) {
        unobserveSeriesCard(el);
        liveCards.delete(el);
        delete el.dataset[LIVE_ATTR];
    }

    /** @returns {void} Release all targets; the next schedule render creates observers lazily. */
    function releaseSeriesObservers() {
        for (const el of observedSeriesCards) forgetSeriesCard(el);
        seriesObserver?.disconnect();
        seriesObserver = null;
        seriesTargetObserver?.disconnect();
        seriesTargetObserver = null;
        intersectingCards = new WeakSet();
    }

    /** @param {HTMLElement} el @param {Object|undefined} card @returns {boolean} */
    function eligibleSeriesCard(el, card) {
        return el.isConnected && intersectingCards.has(el) && card && isCurrentRecord(card)
            && card.domId === cardIdentity(el)
            && !el.closest('.je-hidden') && wantsSeriesFacts(card.data);
    }

    /** @param {string} id @returns {boolean} Whether any current visible card still needs this id. */
    function hasVisibleSeries(id) {
        return [...document.querySelectorAll(LIVE_SELECTOR)].some(el => {
            const card = liveCards.get(el);
            return card?.data.seriesId === id && eligibleSeriesCard(el, card);
        });
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
     * live pass never redraws a card from data that is no longer trusted.
     *
     * A delta (id list) marks the records of those items stale: the card keeps
     * the badge it shows, like every other tag group does until the card is
     * rendered again, but a trending refresh no longer re-badges it from the
     * outdated dates.
     *
     * No id list means the whole cache went, and every record is marked stale.
     * Usually the pipeline dropped it ahead of re-rendering everything (a
     * Spoiler Guard or access change, a user switch), which records the cards
     * again. When it instead swapped a replacement download in under the
     * cards (info.replaced: a version change or rollback, possibly to an
     * empty cache) nothing would redraw them, so the status badges are
     * reinitialized: every one is removed and the pipeline is asked to render
     * the cards again from whatever it now has, for every card type.
     *
     * The module's own fallback caches (localStorage and the hot bucket, used
     * when a card has no server entry) hold the same dates and go the same
     * way, so a re-render cannot be served the outdated entry as a hit.
     * @param {Object} ctx - Factory context.
     * @param {string[]|null} updatedIds - Item ids a delta replaced, or null for everything.
     * @param {{replaced?: boolean}} [info] - What the pipeline did with the cache.
     * @returns {void}
     */
    function onCacheReplaced(ctx, updatedIds, info) {
        trackRev++;
        if (Array.isArray(updatedIds)) {
            for (const id of updatedIds) {
                ctx.deletePersistent(String(id));
                ctx.hot?.delete(String(id));
            }
            if (replacedAt.size + updatedIds.length > REPLACED_AT_CAP) {
                staleBelowRev = trackRev;
                replacedAt.clear();
                return;
            }
            for (const id of updatedIds) replacedAt.set(normId(id), trackRev);
            return;
        }
        staleBelowRev = trackRev;
        replacedAt.clear();
        seriesEpoch++;
        seriesInfo.clear();
        seriesQueue.clear();
        parentFactsQueue.clear();
        parentFactsLoads.clear();
        ctx.clearPersistent();
        ctx.hot?.clear();
        if (info?.replaced && JE.currentSettings?.statusTagsEnabled) JE.reinitializeStatusTags();
    }

    /**
     * After a fetch brought different live data (a trending list, or TMDB
     * schedules for some series): re-badge every recorded card on the page
     * whose badge changes with it (a new or changed rank or schedule badge,
     * or a card that falls back to its library badge or none). Each badge
     * goes through the layout controller, which re-presents its card;
     * overlays it does not manage are re-stacked in one pass.
     * @param {Object} ctx - Factory context.
     * @returns {void}
     */
    function applyLivePass(ctx) {
        if (!statusActive || !JE.currentSettings?.statusTagsEnabled) return;
        renderedDay = localDay(Date.now());
        const hosts = [];
        document.querySelectorAll(LIVE_SELECTOR).forEach((el) => {
            const card = liveCards.get(/** @type {HTMLElement} */ (el));
            if (!card || ctx.shouldIgnore(el) || el.closest('.je-hidden')) return;
            if (!isCurrentRecord(card) || card.domId !== cardIdentity(el)) {
                forgetSeriesCard(/** @type {HTMLElement} */ (el));
                return;
            }
            const badge = pickBadge(card.data, card.id, el);
            const key = badgeKey(badge);
            if (key === card.shown) return;
            card.shown = key;
            // No badge now: removing the overlay is enough, a tagged marker
            // without one counts as untagged (ctx.isTagged).
            if (badge) applyStatusTag(ctx, el, badge);
            else ctx.removeExistingOverlay(el);
            hosts.push(el);
        });
        if (hosts.length > 0 && !JE.core.tagLayout) JE.core.tagRenderer.applyCornerStacking(hosts);
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
            if (trendingKey(trending.data) !== previous) applyLivePass(ctx);
        })();
    }

    /**
     * Queue a series for the next batched schedule request, unless its facts
     * are fresh or already being fetched.
     * @param {Object} ctx - Factory context.
     * @param {string} seriesId - Normalised series item id.
     * @returns {void}
     */
    function requestSeries(ctx, seriesId) {
        if (!statusActive || !JE.currentSettings?.statusTagsEnabled) return;
        const known = seriesInfo.get(seriesId);
        if (known && (known.loading || Date.now() < known.expires)) {
            if (!known.loading && TMDB_ENDED.has(known.facts?.status) && JE.tagPipeline?.lookupItemFacts
                && !JE.tagPipeline.peekItemFacts(seriesId) && !parentFactsLoads.has(seriesId)) {
                parentFactsLoads.add(seriesId);
                parentFactsQueue.add(seriesId);
                scheduleParentFacts(ctx);
            }
            return;
        }
        if (seriesQueue.has(seriesId) || typeof ApiClient === 'undefined') return;
        seriesInfo.set(seriesId, { facts: known?.facts ?? null, expires: known?.expires ?? 0, loading: true });
        seriesQueue.add(seriesId);
        if (!seriesTimer) seriesTimer = setTimeout(() => { flushSeries(ctx); }, SERIES_FLUSH_MS);
    }

    /**
     * Collect visible expired parents before starting a single serial drain.
     * @param {Object} ctx - Factory context.
     * @returns {void}
     */
    function scheduleParentFacts(ctx) {
        if (parentFactsLoading || parentFactsTimer !== null || !parentFactsQueue.size || !statusActive) return;
        parentFactsTimer = setTimeout(() => { flushParentFacts(ctx); }, SERIES_FLUSH_MS);
    }

    /**
     * Refresh parents through the pipeline in bounded batches, with one live
     * recomputation per completed batch. New ids join the running drain; ids
     * already queued or loading cannot start duplicate requests. Cleanup drops
     * queued work and stale completions without opening another in-flight drain.
     * @param {Object} ctx - Factory context.
     * @returns {Promise<void>}
     */
    async function flushParentFacts(ctx) {
        parentFactsTimer = null;
        const epoch = seriesEpoch;
        parentFactsLoading = true;
        try {
            while (parentFactsQueue.size && statusActive && epoch === seriesEpoch) {
                const ids = [...parentFactsQueue].slice(0, PARENT_FACTS_BATCH);
                for (const id of ids) parentFactsQueue.delete(id);
                const visible = new Set();
                for (const el of observedSeriesCards) {
                    const card = liveCards.get(el);
                    if (eligibleSeriesCard(el, card)) visible.add(card.data.seriesId);
                }
                const batch = ids.filter(id => visible.has(id));
                if (batch.length) await JE.tagPipeline.lookupItemFacts(batch);
                if (epoch !== seriesEpoch) return;
                for (const id of ids) parentFactsLoads.delete(id);
                if (batch.some(id => JE.tagPipeline.peekItemFacts(id))) applyLivePass(ctx);
            }
        } finally {
            parentFactsLoading = false;
            scheduleParentFacts(ctx);
        }
    }

    /**
     * The facts of one series in a /status-tags/series answer, or null.
     * @param {*} raw
     * @returns {SeriesFacts|null}
     */
    function readSeriesFacts(raw) {
        if (!raw || typeof raw !== 'object') return null;
        /** @param {*} ep @param {boolean} withType */
        const episode = (ep, withType) => (ep && typeof ep === 'object' && airDay(ep.date) !== null
            ? { date: ep.date, season: toInt(ep.season), episode: toInt(ep.episode), ...(withType ? { type: typeof ep.type === 'string' ? ep.type : null } : {}) }
            : null);
        return {
            status: typeof raw.status === 'string' ? raw.status : null,
            last: /** @type {SeriesFacts['last']} */ (episode(raw.lastAired, true)),
            regular: /** @type {SeriesFacts['last']} */ (episode(raw.lastRegularAired, true)),
            next: /** @type {SeriesFacts['next']} */ (episode(raw.nextAired, false)),
            seasonEpisodes: raw.seasonEpisodes && typeof raw.seasonEpisodes === 'object' ? raw.seasonEpisodes : null,
        };
    }

    /**
     * Send the queued series ids, SERIES_BATCH per request, one request at a
     * time. Every id asked about is kept for SERIES_TTL_MS (an id the server
     * left out has no facts), or SERIES_RETRY_MS after a failed request. When
     * any series' facts changed, one pass re-badges the cards on the page. An
     * answer that lands after a user switch is dropped.
     * @param {Object} ctx - Factory context.
     * @returns {Promise<void>}
     */
    async function flushSeries(ctx) {
        seriesTimer = null;
        const epoch = seriesEpoch;
        const ids = [...seriesQueue];
        seriesQueue.clear();
        let changed = false;
        for (let i = 0; i < ids.length; i += SERIES_BATCH) {
            const batch = ids.slice(i, i + SERIES_BATCH).filter(id => {
                if (hasVisibleSeries(id)) return true;
                const known = seriesInfo.get(id);
                if (known) known.loading = false;
                return false;
            });
            if (batch.length === 0) continue;
            for (const id of batch) {
                const known = seriesInfo.get(id);
                seriesInfo.set(id, { facts: known?.facts ?? null, expires: known?.expires ?? 0, loading: true });
            }
            let answer = null;
            let ok = false;
            try {
                answer = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('JellyfinEnhanced/status-tags/series', { ids: batch.join(',') }),
                    dataType: 'json'
                });
                ok = true;
            } catch (e) {
                console.warn(`${logPrefix} Could not load series schedules; showing library badges only.`, e);
            }
            if (epoch !== seriesEpoch) return;
            const byId = new Map();
            if (answer && typeof answer === 'object') {
                for (const [key, value] of Object.entries(answer)) byId.set(normId(key), value);
            }
            const now = Date.now();
            for (const id of batch) {
                const previous = seriesInfo.get(id)?.facts ?? null;
                const failed = !ok || byId.get(id)?.retry === true;
                const facts = failed ? previous : readSeriesFacts(byId.get(id));
                seriesInfo.set(id, { facts, expires: now + (failed ? SERIES_RETRY_MS : SERIES_TTL_MS), retry: failed });
                if (JSON.stringify(previous) !== JSON.stringify(facts)) changed = true;
            }
            // Episode-only pages may have restored just their visible entries
            // from IndexedDB. Warm the confirmed caller-filtered parent aggregates
            // before resolving the same regular finale as a series card.
            const endedIds = batch.filter(id => TMDB_ENDED.has(seriesInfo.get(id)?.facts?.status));
            if (endedIds.length) {
                if (JE.tagPipeline?.lookupItemFacts) await JE.tagPipeline.lookupItemFacts(endedIds);
                else await JE.tagPipeline?.lookupServerEntries?.(endedIds);
            }
            if (epoch !== seriesEpoch) return;
        }
        if (changed || renderedDay !== localDay(Date.now())) applyLivePass(ctx);
        armSeriesRetry(ctx);
    }

    /**
     * Retry failed lookups still represented by visible cards, using one shared timer.
     * @param {Object} ctx @returns {void}
     */
    function armSeriesRetry(ctx) {
        if (seriesRetryTimer) clearTimeout(seriesRetryTimer);
        seriesRetryTimer = null;
        if (!statusActive || !JE.currentSettings?.statusTagsEnabled) return;
        const due = [...seriesInfo].filter(([id, value]) => value.retry && !value.loading && hasVisibleSeries(id))
            .map(([, value]) => value.expires);
        if (!due.length) return;
        seriesRetryTimer = setTimeout(() => {
            seriesRetryTimer = null;
            for (const [id, value] of seriesInfo) {
                if (value.retry && Date.now() >= value.expires && hasVisibleSeries(id)) requestSeries(ctx, id);
            }
        }, Math.max(0, Math.min(...due) - Date.now()));
    }

    /**
     * Re-evaluate current cards at local midnight, including after suspended tabs return.
     * Date arithmetic uses the local calendar so DST days need not be 24 hours.
     * @param {Object} ctx @returns {void}
     */
    function armMidnight(ctx) {
        if (midnightTimer) clearTimeout(midnightTimer);
        midnightTimer = null;
        if (!statusActive || !JE.currentSettings?.statusTagsEnabled) return;
        const now = Date.now();
        const next = new Date(now);
        next.setHours(24, 0, 0, 0);
        midnightTimer = setTimeout(() => {
            midnightTimer = null;
            applyLivePass(ctx);
            armMidnight(ctx);
        }, Math.max(1, next.getTime() - now));
    }

    /** @param {Object} ctx @returns {void} Refresh a tab returning from background/sleep. */
    function refreshCalendar(ctx) {
        if (!statusActive || !JE.currentSettings?.statusTagsEnabled) return;
        applyLivePass(ctx);
        for (const [id] of seriesInfo) if (hasVisibleSeries(id)) requestSeries(ctx, id);
        armMidnight(ctx);
        armSeriesRetry(ctx);
    }

    /**
     * Cancel page-owned timers and invalidate pending answers before releasing cards.
     * @returns {void}
     */
    function stopStatus() {
        statusActive = false;
        seriesEpoch++;
        for (const timer of [midnightTimer, seriesTimer, seriesRetryTimer, parentFactsTimer]) {
            if (timer !== null) clearTimeout(timer);
        }
        midnightTimer = seriesTimer = seriesRetryTimer = parentFactsTimer = null;
        seriesQueue.clear();
        parentFactsQueue.clear();
        parentFactsLoads.clear();
        for (const value of seriesInfo.values()) value.loading = false;
        releaseSeriesObservers();
        document.querySelectorAll(LIVE_SELECTOR).forEach(el => {
            liveCards.delete(el);
            delete el.dataset[LIVE_ATTR];
        });
        renderedDay = null;
    }

    /** @param {Object} ctx @returns {void} Arm a new active rendering lifetime once. */
    function activateStatus(ctx) {
        if (statusActive || !JE.currentSettings?.statusTagsEnabled) return;
        statusActive = true;
        armMidnight(ctx);
    }

    /** One live pass for the direct-play answers a slice applied (one stable callback, so a slice runs it once). */
    function onDirectPlayAnswer() {
        if (statusCtx) applyLivePass(statusCtx);
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
            // Placement comes from the layout stylesheet (tags/tag-layout-styles.js).
            return `
                .${containerClass} {
                    display: flex;
                    flex-direction: column;
                    align-items: flex-end;
                    z-index: 10;
                    pointer-events: none;
                    max-width: calc(100% - 12px);
                }

                .${tagClass} {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.25em;
                    padding: calc(4px * var(--je-tag-scale, 1)) calc(10px * var(--je-tag-scale, 1));
                    background-color: rgba(15, 15, 15, 0.72);
                    -webkit-backdrop-filter: blur(6px);
                    backdrop-filter: blur(6px);
                    color: #ffffff;
                    border: 1px solid rgba(255, 255, 255, 0.18);
                    border-radius: 6px;
                    font-size: calc(13px * var(--je-tag-scale, 1));
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
                /* Only the direct-play warning takes hover, for its tooltip. */
                .${tagClass}[data-je-dp] { pointer-events: auto; cursor: help; }

                /* Card-width sizing, matching the rating tag rules in tag-pipeline.js */
                @supports (container-type: inline-size) {
                    html:not(.layout-mobile) .je-tag-host .${tagClass} {
                        font-size: calc(clamp(9px, 6.8cqw, 13px) * var(--je-tag-scale, 1));
                        padding: calc(clamp(2px, 2cqw, 4px) * var(--je-tag-scale, 1)) calc(clamp(5px, 5cqw, 10px) * var(--je-tag-scale, 1));
                        border-radius: clamp(4px, 3cqw, 6px);
                    }
                }

                .layout-mobile .${tagClass} {
                    padding: calc(2px * var(--je-tag-scale, 1)) calc(7px * var(--je-tag-scale, 1));
                    font-size: calc(11px * var(--je-tag-scale, 1));
                    border-radius: 5px;
                }

                @media (max-width: 768px) {
                    .${tagClass} { padding: calc(3px * var(--je-tag-scale, 1)) calc(8px * var(--je-tag-scale, 1)); font-size: calc(12px * var(--je-tag-scale, 1)); }
                }

                @media (max-width: 480px) {
                    .${tagClass} { padding: calc(2px * var(--je-tag-scale, 1)) calc(6px * var(--je-tag-scale, 1)); font-size: calc(clamp(10px, 2vw, 11px) * var(--je-tag-scale, 1)); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
                }
            `;
        },
        pipeline: {
            needsFirstEpisode: false,
            needsParentSeries: false,
            // Series/Season "New Episode" and the schedule/milestone facts on
            // the /tag-data fallback path.
            needsLatestEpisode: true,
            render(ctx, el, item, extras) {
                if (ctx.shouldIgnore(el)) return;
                if (ctx.isTagged(el)) return;
                if (el.closest('.je-hidden')) return;

                JE.tagPipeline?.rememberItemFacts?.(item);
                const data = { ...fromItem(item), fetchedAt: Date.now() };
                // The shared factory stamps this accepted answer with its own strip revision.
                // Empty guarded answers are page-local hits; only unstripped answers persist.
                setCachedEntry(ctx, item.Id, data);
                renderData(ctx, el, data, item.Id);
            },
            renderFromCache(ctx, el, itemId) {
                if (ctx.isTagged(el)) return true;
                if (ctx.shouldIgnore(el)) return true;
                if (el.closest('.je-hidden')) return true;
                const cached = getCachedEntry(ctx, itemId);
                if (!cached) return false;
                if ((cached.type === 'Series' || cached.type === 'Season') && JE.tagPipeline?.rememberItemFacts
                    && !JE.tagPipeline.peekItemFacts(itemId)) {
                    // Restore the filtered projection with its original age, never the redraw time.
                    JE.tagPipeline.rememberItemFacts({
                        Type: cached.type, SeriesId: cached.seriesId, SeasonNumber: cached.season,
                        Status: cached.status, LatestEpisodeAdded: cached.latest, LatestEpisodeAired: cached.latestAired,
                        LatestEpisodeIndex: cached.latestIndex ? {
                            Season: cached.latestIndex.s, Episode: cached.latestIndex.e, IsLast: cached.latestIndex.isLast,
                        } : null,
                        SeasonPremiere: cached.seasonPremiere ? { Season: cached.seasonPremiere.s, Aired: cached.seasonPremiere.aired } : null,
                        SeasonAddedSpan: cached.addedSpan ? {
                            First: cached.addedSpan.first, Last: cached.addedSpan.last, Count: cached.addedSpan.count, CoveredThrough: cached.addedSpan.coveredThrough,
                        } : null,
                    }, itemId, cached.fetchedAt);
                    // Misses join the pipeline's existing batch instead of renewing stale facts.
                    if (!JE.tagPipeline.peekItemFacts(itemId)) return false;
                }
                renderData(ctx, el, cached, itemId);
                // A cached "no badge" is still a cache hit — nothing to fetch.
                return true;
            },
            renderFromServerCache(ctx, el, entry, itemId) {
                if (ctx.isTagged(el)) return;
                if (ctx.shouldIgnore(el)) return;
                if (el.closest('.je-hidden')) return;
                renderData(ctx, el, fromServerEntry(entry, itemId), itemId);
            },
            cleanup() {
                stopStatus();
                JE.tagDirectPlay?.reset();
            },
            onServerCacheRefresh(ctx, updatedIds, info) {
                onCacheReplaced(ctx, updatedIds, info);
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
        stopStatus();

        if (!userChangeRegistered) {
            userChangeRegistered = true;
            // The outgoing user's cards and dates must not be redrawn by a
            // trending or schedule answer that lands during the switch; the
            // pipeline re-renders everything for the incoming user, whose
            // series lookups (resolved through them) start over.
            JE.session?.onUserChange?.('status-tags', () => {
                trackRev++;
                staleBelowRev = trackRev;
                replacedAt.clear();
                stopStatus();
                seriesInfo.clear();
            });
        }
        statusCtx = JE.core.tagRenderer.register('status', spec);
        statusCtx.injectCss();
        activateStatus(statusCtx);
        ensureTrending(statusCtx);
        if (!calendarEventsRegistered) {
            calendarEventsRegistered = true;
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) refreshCalendar(statusCtx);
            });
            window.addEventListener('focus', () => refreshCalendar(statusCtx));
            window.addEventListener('pagehide', stopStatus);
            window.addEventListener('pageshow', () => JE.reinitializeStatusTags());
        }

        console.log(`${logPrefix} Initialized successfully.`);
    };

    /**
     * Remove every status badge and redraw them with the current settings
     * (position, badge switches), fetching the trending list and series
     * schedules if now needed.
     * @returns {void}
     */
    JE.reinitializeStatusTags = function() {
        JE.core.tagRenderer.reinitialize('status', spec);
        if (statusCtx && JE.currentSettings?.statusTagsEnabled) {
            activateStatus(statusCtx);
            ensureTrending(statusCtx);
        }
    };

    // Previews may enable this group while the signed-in user has it off.
    JE.core.tagRenderer.registerStyles(spec);

})(window.JellyfinEnhanced);
