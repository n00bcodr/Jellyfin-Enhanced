// /js/tags/statustags.js
// Jellyfin Status Tags - Badge posters with one status badge: what is new
// ("Just Added", "New Movie" / "New Series" / "New Episode"), popular ("#3
// Today"), a milestone ("New Season", "Season Premiere", "Season Finale",
// "Series Finale", "Complete Season"), on the schedule ("Airing Today",
// "Airs Thursday", "Returns Oct 4", "Coming Soon") or, when switched on, the
// series status ("Returning", "Ended", "Cancelled"). The badge is drawn over
// the card, so the poster image itself (e.g. a custom poster set) is never
// replaced.
// A spec over the core tag-renderer factory (js/core/tag-renderer-base.js),
// which owns the cache/ignore/tagged/CSS/reinitialize plumbing. This module
// supplies only the status-specific parts: reading the item's facts, picking
// the one badge a card shows, the live TMDB data and the badge markup.
//
// One badge per card, first match wins:
//   Movie   Trending → Coming Soon → New Movie → Just Added
//   Series  Trending → Airing Today → Series Finale → New Season → Airs {date}
//           → Returns {date} → New Episode → Coming Soon → New Series
//           → Just Added → Returning / Ended / Cancelled
//   Season  Complete Season → Season Premiere → Season Finale → New Episode
//           → Just Added
//   Episode Season Premiere → Series Finale / Season Finale → New Episode
//           → Just Added
//   BoxSet, Video: Just Added
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
    const DAY_MS = 24 * 60 * 60 * 1000;
    // A cached entry's dates (a series' latest episode above all) can move, so
    // the persistent cache only answers for this long before a re-fetch.
    const CACHE_FRESH_MS = 60 * 60 * 1000;
    // Shape of the fallback cache entries; older entries count as misses.
    const CACHE_ENTRY_VERSION = 2;
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
    // Schedule badge windows: "Airs {date}" up to a week ahead; "Returns {date}"
    // when the next episode is more than two weeks after the last one and at
    // most a month ahead.
    const AIRS_WITHIN_DAYS = 7;
    const WEEKDAY_WITHIN_DAYS = 5;
    const RETURN_GAP_DAYS = 14;
    const RETURNS_WITHIN_DAYS = 30;
    // Placeholder for the rank inside the translated trending label, so the
    // number can sit in its own span whatever the locale's word order.
    const RANK_TOKEN = '\u0001';
    /** Shorter label for compact density, per badge key (the layout controller swaps it in). */
    const COMPACT_LABEL_KEYS = {
        season_premiere: 'status_tag_compact_premiere',
        season_finale: 'status_tag_compact_finale',
        series_finale: 'status_tag_compact_finale',
        complete_season: 'status_tag_compact_complete',
        airing_today: 'status_tag_compact_today',
        coming_soon: 'status_tag_compact_soon',
        just_added: 'status_tag_compact_added',
        new_episode: 'status_tag_compact_new_episode',
    };
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
        seriesStatus: { userKey: 'statusTagsSeriesStatus', pluginKey: 'StatusTagsSeriesStatus', fallback: false },
    };

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
     * @property {string|null} type - Jellyfin item type.
     * @property {string|null} tmdb - The item's TMDB id (trending).
     * @property {number|null} created - DateCreated (ms).
     * @property {number|null} premiere - PremiereDate (ms; Movie/Series/Episode).
     * @property {number|null} latest - Series/Season: newest episode DateCreated (ms).
     * @property {string|null} status - Series: Jellyfin status (Continuing/Ended/Unreleased).
     * @property {number|null} latestAired - Series/Season: newest episode air date (ms).
     * @property {{s: number, e: number, isLast: boolean}|null} latestIndex - Its season/episode numbers.
     * @property {{s: number, aired: number}|null} seasonPremiere - Series: newest season; Season: itself.
     * @property {{first: number, last: number, count: number}|null} addedSpan - Season: episode added dates.
     * @property {number|null} season - Season/Episode: season number.
     * @property {number|null} episode - Episode: episode number.
     * @property {boolean|null} isLast - Whether this is the last locally available episode in its season.
     * @property {string|null} seriesId - The series whose TMDB schedule applies (Series: itself).
     * @property {string|null|undefined} seriesTmdb - That series' TMDB id; undefined when unknown.
     */

    /**
     * @typedef {Object} SeriesFacts
     * @property {string|null} status - TMDB status ("Returning Series", "Ended", "Canceled", ...).
     * @property {{date: string, season: number|null, episode: number|null, type: string|null}|null} last
     * @property {{date: string, season: number|null, episode: number|null}|null} next
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
            status: typeof src.Status === 'string' && src.Status ? src.Status : null,
            latestAired: toMs(src.LatestEpisodeAired),
            isLast: typeof src.EpisodeIndex?.IsLast === 'boolean' ? src.EpisodeIndex.IsLast : null,
            latestIndex: index && toInt(index.Season) !== null && toInt(index.Episode) !== null
                ? { s: index.Season, e: index.Episode, isLast: index.IsLast === true } : null,
            seasonPremiere: premiere && toInt(premiere.Season) !== null && toMs(premiere.Aired) !== null
                ? { s: premiere.Season, aired: toMs(premiere.Aired) } : null,
            addedSpan: span && toMs(span.First) !== null && toMs(span.Last) !== null && toInt(span.Count) !== null
                ? { first: toMs(span.First), last: toMs(span.Last), count: span.Count } : null,
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
            seriesId: type === 'Series' ? normId(itemId) : normId(entry.SeriesId),
            // The cache records the series' TMDB id on its seasons and episodes,
            // so a missing one means the series has none.
            seriesTmdb: type === 'Series' ? tmdb : (entry.SeriesTmdbId ? String(entry.SeriesTmdbId) : null),
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
            seriesId: type === 'Series' ? normId(item.Id) : normId(item.SeriesId),
            // A season/episode item does not say whether its series has a TMDB
            // id; the server answers only for those that do.
            seriesTmdb: type === 'Series' ? tmdb : undefined,
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

    /**
     * The {date} of "Airs {date}" / "Returns {date}": "Tomorrow", a weekday
     * name up to WEEKDAY_WITHIN_DAYS days ahead, else a short date ("Oct 4"),
     * in the user's locale.
     * @param {number} day - The air date as a day number.
     * @param {number} daysAhead - Days from today (1 or more).
     * @returns {string}
     */
    function formatAirDay(day, daysAhead) {
        if (daysAhead === 1) return label('status_tag_tomorrow');
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
        const badge = { kind, key, label: label(`status_tag_${key}`, params) };
        if (COMPACT_LABEL_KEYS[key]) badge.compact = label(COMPACT_LABEL_KEYS[key]);
        return badge;
    }

    /**
     * Resolve the last aired regular episode. TMDB's regular last episode wins;
     * a later special falls back to the caller-filtered library series aggregate.
     * Never infer a series boundary from an individual episode's IsLast flag.
     * @param {StatusData} data
     * @param {SeriesFacts|null} facts
     * @returns {SeriesFacts['last']}
     */
    function finalRegularEpisode(data, facts) {
        if (facts?.last?.season > 0) return facts.last;
        if (facts?.last?.season !== 0) return null;
        const aggregate = data.type === 'Series' ? data
            : fromServerEntry(JE.tagPipeline?.peekServerEntry?.(data.seriesId) || {});
        if (!(aggregate.latestIndex?.s > 0) || aggregate.latestAired === null) return null;
        // Convert the library instant to a local calendar date, just like badge windows.
        const date = new Date(aggregate.latestAired);
        const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        return { date: day, season: aggregate.latestIndex.s, episode: aggregate.latestIndex.e, type: null };
    }

    /**
     * Pick the one badge a card shows (first match wins), or null.
     * @param {StatusData} data
     * @returns {{kind: string, key: string, label: string, compact?: string, rank?: number}|null}
     */
    function pickBadge(data) {
        const now = Date.now();
        const today = localDay(now);
        const justAddedMs = windowMs('StatusTagsJustAddedDays', 7);
        const newReleaseMs = windowMs('StatusTagsNewReleaseDays', 30);
        const showNew = isScopeEnabled(BADGE_SCOPES.newRelease);
        const showAdded = isScopeEnabled(BADGE_SCOPES.justAdded);
        const showSchedule = isScopeEnabled(BADGE_SCOPES.schedule);
        const showMilestones = isScopeEnabled(BADGE_SCOPES.milestones);
        const showStatus = isScopeEnabled(BADGE_SCOPES.seriesStatus);
        const facts = wantsSeriesFacts(data) ? seriesFactsFor(data) : null;

        // Match the series aggregate: specials never identify a final regular episode.
        const finalRegular = finalRegularEpisode(data, facts);
        const finalDay = airDay(finalRegular?.date);
        const finalAiredRecently = finalDay !== null && finalDay <= today && (today - finalDay) * DAY_MS <= newReleaseMs;
        const isNewRelease = data.premiere !== null && data.premiere <= now && now - data.premiere <= newReleaseMs;
        const comingSoon = data.premiere !== null && data.premiere > now;
        const addedRecently = isWithin(data.created, now, justAddedMs);
        // "New Episode" on a container: an episode arrived recently in a
        // container that was itself already there before the window (else it
        // is just added).
        const newEpisode = isWithin(data.latest, now, justAddedMs)
            && data.created !== null && now - data.created > justAddedMs;
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
                return { kind: 'trending', key, label: label(`status_tag_${key}`, { rank: RANK_TOKEN }), rank };
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
                    return makeBadge('milestone', 'series_finale');
                }
                const sp = data.seasonPremiere;
                if (showMilestones && sp && sp.s > 1 && sp.aired <= now && isWithin(sp.aired, now, newReleaseMs)) return makeBadge('milestone', 'new_season');
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
                // Every available episode arrived within the just-added window.
                if (showMilestones && span && span.count > 0 && span.first <= span.last && isWithin(span.first, now, justAddedMs) && isWithin(span.last, now, justAddedMs)) {
                    return makeBadge('milestone', 'complete_season');
                }
                if (showMilestones && data.seasonPremiere && data.seasonPremiere.aired <= now && isWithin(data.seasonPremiere.aired, now, newReleaseMs)) {
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
                const airedRecently = data.premiere !== null && data.premiere <= now;
                if (showMilestones && airedRecently && data.episode === 1 && data.season !== null && data.season > 0
                    && isWithin(data.premiere, now, justAddedMs)) {
                    return makeBadge('milestone', 'season_premiere');
                }
                if (showMilestones && airedRecently && finalRegular && finalAiredRecently
                    && data.season === finalRegular.season && data.episode === finalRegular.episode
                    && TMDB_ENDED.has(facts.status || '')) return makeBadge('milestone', 'series_finale');
                if (showMilestones && airedRecently && facts?.last && lastAiredRecently
                    && data.season === facts.last.season && data.episode === facts.last.episode) {
                    if (lastAiredEndsSeason(facts, data.isLast)) return makeBadge('milestone', 'season_finale');
                }
                if (showNew && ((airedRecently && isWithin(data.premiere, now, justAddedMs)) || addedRecently)) return makeBadge('new', 'new_episode');
                break;
            }
            case 'BoxSet':
            case 'Video':
                break;
            default:
                return null;
        }
        if (showAdded && addedRecently) return makeBadge('added', 'just_added');
        if (data.type === 'Series' && showStatus) return seriesStatusBadge(data, facts);
        return null;
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
            type: entry.t ?? null,
            tmdb: entry.m ?? null,
            created: entry.c ?? null,
            premiere: entry.p ?? null,
            latest: entry.l ?? null,
            status: entry.st ?? null,
            latestAired: entry.la ?? null,
            isLast: entry.il ?? null,
            latestIndex: Array.isArray(entry.li) ? { s: entry.li[0], e: entry.li[1], isLast: entry.li[2] === true } : null,
            seasonPremiere: Array.isArray(entry.sp) ? { s: entry.sp[0], aired: entry.sp[1] } : null,
            addedSpan: Array.isArray(entry.as) ? { first: entry.as[0], last: entry.as[1], count: entry.as[2] } : null,
            season: entry.sn ?? null,
            episode: entry.en ?? null,
            seriesId: entry.si ?? null,
            // Stored only when known (null and undefined both mean "unknown" here).
            seriesTmdb: entry.stm ?? (entry.t === 'Series' ? null : undefined),
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
        const entry = { v: CACHE_ENTRY_VERSION, t: data.type, timestamp: Date.now() };
        if (data.tmdb) entry.m = data.tmdb;
        if (data.created !== null) entry.c = data.created;
        if (data.premiere !== null) entry.p = data.premiere;
        if (data.latest !== null) entry.l = data.latest;
        if (data.status) entry.st = data.status;
        if (data.latestAired !== null) entry.la = data.latestAired;
        if (data.isLast !== null) entry.il = data.isLast;
        if (data.latestIndex) entry.li = [data.latestIndex.s, data.latestIndex.e, data.latestIndex.isLast];
        if (data.seasonPremiere) entry.sp = [data.seasonPremiere.s, data.seasonPremiere.aired];
        if (data.addedSpan) entry.as = [data.addedSpan.first, data.addedSpan.last, data.addedSpan.count];
        if (data.season !== null) entry.sn = data.season;
        if (data.episode !== null) entry.en = data.episode;
        if (data.seriesId) entry.si = data.seriesId;
        if (data.seriesTmdb) entry.stm = data.seriesTmdb;
        ctx.setPersistent(itemId, entry);
        ctx.hot?.set(itemId, entry);
    }

    /**
     * Create and append the status badge to a card.
     * @param {Object} ctx - Factory context.
     * @param {HTMLElement} el - The card container to receive the overlay.
     * @param {{kind: string, key: string, label: string, compact?: string, rank?: number}|null} badge - From pickBadge.
     * @returns {void}
     */
    function applyStatusTag(ctx, el, badge) {
        if (!badge) return;

        ctx.removeExistingOverlay(el);

        const container = document.createElement('div');
        container.className = containerClass;

        const tag = document.createElement('div');
        tag.className = `${tagClass} ${tagClass}--${badge.kind}`;
        // Which badge it is, for Tag Styles and custom CSS ("new_season", "airs_date", ...).
        tag.dataset.jeStatus = badge.key;
        // The layout controller shows this instead in compact density.
        if (badge.compact) tag.dataset.jeCompact = badge.compact;
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
        return `${localDay(Date.now())}|${badge ? `${badge.kind}|${badge.key}|${badge.label}|${badge.rank ?? ''}` : ''}`;
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
        ensureTrending(ctx);
        const readsSeries = wantsSeriesFacts(data);
        const badge = pickBadge(data);
        // All date badges can change when a local day passes.
        const previous = liveCards.get(el);
        if (!readsSeries || (previous && (previous.id !== normId(itemId) || previous.domId !== cardIdentity(el)))) {
            unobserveSeriesCard(el);
        }
        liveCards.set(el, { domId: cardIdentity(el), id: normId(itemId), data, shown: badgeKey(badge), rev: trackRev });
        el.dataset[LIVE_ATTR] = '1';
        if (readsSeries) observeSeriesCard(ctx, el);
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
        if (!JE.currentSettings?.statusTagsEnabled) return;
        renderedDay = localDay(Date.now());
        const hosts = [];
        document.querySelectorAll(LIVE_SELECTOR).forEach((el) => {
            const card = liveCards.get(/** @type {HTMLElement} */ (el));
            if (!card || ctx.shouldIgnore(el) || el.closest('.je-hidden')) return;
            if (!isCurrentRecord(card) || card.domId !== cardIdentity(el)) {
                forgetSeriesCard(/** @type {HTMLElement} */ (el));
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
        const known = seriesInfo.get(seriesId);
        if (known && (known.loading || Date.now() < known.expires)) return;
        if (seriesQueue.has(seriesId) || typeof ApiClient === 'undefined') return;
        seriesInfo.set(seriesId, { facts: known?.facts ?? null, expires: known?.expires ?? 0, loading: true });
        seriesQueue.add(seriesId);
        if (!seriesTimer) seriesTimer = setTimeout(() => { flushSeries(ctx); }, SERIES_FLUSH_MS);
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
            next: /** @type {SeriesFacts['next']} */ (episode(raw.nextAired, false)),
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
            // before resolving a regular finale behind TMDB's latest special.
            const specialIds = batch.filter(id => seriesInfo.get(id)?.facts?.last?.season === 0);
            if (specialIds.length) await JE.tagPipeline?.lookupServerEntries?.(specialIds);
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
        applyLivePass(ctx);
        for (const [id] of seriesInfo) if (hasVisibleSeries(id)) requestSeries(ctx, id);
        armMidnight(ctx);
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
                    .${tagClass} { padding: 2px 6px; font-size: clamp(10px, 2vw, 11px); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
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
                renderData(ctx, el, fromServerEntry(entry, itemId), itemId);
            },
            cleanup() {
                releaseSeriesObservers();
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
        releaseSeriesObservers();

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
                releaseSeriesObservers();
                seriesEpoch++;
                seriesInfo.clear();
                seriesQueue.clear();
            });
        }
        statusCtx = JE.core.tagRenderer.register('status', spec);
        statusCtx.injectCss();
        ensureTrending(statusCtx);
        armMidnight(statusCtx);
        if (!calendarEventsRegistered) {
            calendarEventsRegistered = true;
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) refreshCalendar(statusCtx);
            });
            window.addEventListener('focus', () => refreshCalendar(statusCtx));
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
        if (statusCtx && JE.currentSettings?.statusTagsEnabled) ensureTrending(statusCtx);
    };

})(window.JellyfinEnhanced);
