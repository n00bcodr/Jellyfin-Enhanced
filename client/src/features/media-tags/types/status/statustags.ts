import { apiClient, hasApiClient, type TagRuntimeBridge } from '../../host';
import { finite, isRecord, own, record, stringList, text, type JsonRecord } from '../../pipeline/dto';
import { fromItem, fromServerEntry, normId, readFacts, readLeaving, toInt, toMs, type EpisodeFacts, type LeavingFacts, type MediaInputs, type StatusData } from './status-facts';
import type { RefreshInfo, TagCtx, TagSpec } from '../../pipeline/contract';

interface BadgeDefinition { kind: string; style: string; label: string; compact?: string }
interface StatusBadge { kind: string; key: string; label: string; compact?: string; rank?: number; title?: string }
interface EpisodeRef { date: string; season: number | null; episode: number | null; type?: string | null }
interface SeriesFacts {
    /** TMDB status ("Returning Series", "Ended", "Canceled", ...). */
    status: string | null;
    last: EpisodeRef | null;
    regular: EpisodeRef | null;
    next: EpisodeRef | null;
    /** TMDB's episode count per regular season. */
    seasonEpisodes: JsonRecord | null;
}
interface SeriesInfo { facts: SeriesFacts | null; expires: number; loading?: boolean; retry?: boolean }
interface TrendingList { source: string | null; movies: JsonRecord; series: JsonRecord }
interface LiveCard { domId: string | null; id: string | null; data: StatusData; shown: string; rev: number }
interface SeriesCard extends LiveCard { data: StatusData & { seriesId: string } }
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
export function createStatusTags(JE: TagRuntimeBridge) {

    const logPrefix = '🪼 Jellyfin Enhanced: Status Tags:';
    const containerClass = 'status-overlay-container';
    const tagClass = 'status-tag';
    const vocabulary = JE.statusVocabulary;
    const badgeDefinitions: Readonly<Record<string, BadgeDefinition>> = vocabulary.badges;
    const DAY_MS = vocabulary.thresholds.dayMs;
    // A cached entry's dates (a series' latest episode above all) can move, so
    // the persistent cache only answers for this long before a re-fetch.
    const CACHE_FRESH_MS = 60 * 60 * 1000;
    // Shape of the fallback cache entries; older entries count as misses.
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
    const COMPACT_LABEL_KEYS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(badgeDefinitions)
        .flatMap(([key, badge]) => (badge.compact ? [[key, badge.compact]] : [])));
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
    /** Item types that play, and so can have a direct-play warning. */
    const PLAYABLE_TYPES = new Set(['Movie', 'Episode', 'Video', 'MusicVideo']);

    /**
     * Trending list shared by every card of this page lifetime.
     * 
     */
    const trending: { data: TrendingList | null; fetchedAt: number; retryAt: number; promise: Promise<void> | null } = { data: null, fetchedAt: 0, retryAt: 0, promise: null };

    /**
     * TMDB schedule facts per series item id (normalised, see normId), with
     * when they expire and whether a request for them is running.
     * 
     */
    const seriesInfo = new Map<string, SeriesInfo>();
    /** series ids waiting for the next batched request */
    const seriesQueue: Set<string> = new Set();
    /** Expired parents waiting for a shared lookup. */
    const parentFactsQueue: Set<string> = new Set();
    /** Parent ids already queued or loading. */
    const parentFactsLoads: Set<string> = new Set();
    let parentFactsTimer: ReturnType<typeof setTimeout>|null = null;
    /** A single drain stays in flight even across reinitialisation. */
    let parentFactsLoading: boolean = false;
    let seriesTimer: ReturnType<typeof setTimeout>|null = null;
    /** One timer for failed visible lookups. */
    let seriesRetryTimer: ReturnType<typeof setTimeout>|null = null;
    /** bumped on a user switch: answers for the previous user are dropped */
    let seriesEpoch: number = 0;
    /** Single local-midnight refresh timer. */
    let midnightTimer: ReturnType<typeof setTimeout>|null = null;
    /** Local day used by the last live pass. */
    let renderedDay: number|null = null;
    let calendarEventsRegistered = false;
    /** False between teardown/user reset/pagehide and the next activation. */
    let statusActive: boolean = false;
    /** One observer for all schedule-reading cards. */
    let seriesObserver: IntersectionObserver|null = null;
    /** Cards currently intersecting the viewport. */
    let intersectingCards: WeakSet<HTMLElement> = new WeakSet();
    /** Targets explicitly released when removed or recycled. */
    const observedSeriesCards: Set<HTMLElement> = new Set();
    /** Shared removal/identity watcher for schedule targets. */
    let seriesTargetObserver: MutationObserver|null = null;

    /**
     * Every drawn card whose badge live data can change (a Movie/Series with
     * a TMDB id for trending, or a card that reads its series' TMDB schedule),
     * with its item id and data, the badge it shows and the revision it was
     * recorded under. The cards are found again through LIVE_ATTR, so
     * detached ones need no pruning. A record is only trusted while it is
     * current (see isCurrentRecord): a live pass leaves a stale card alone
     * until the pipeline renders it again.
     * 
     */
    const liveCards = new WeakMap<HTMLElement, LiveCard>();
    /** bumped whenever recorded data stops being trusted */
    let trackRev: number = 0;
    /** records older than this are stale, whatever their item */
    let staleBelowRev: number = 0;
    /**
     * Item id → revision a delta replaced it at; a record older than that is
     * stale. Cleared whenever everything is marked stale at once, and when it
     * reaches REPLACED_AT_CAP (then everything is simply marked stale instead).
     * 
     */
    const replacedAt: Map<string, number> = new Map();
    const REPLACED_AT_CAP = 2000;
    const LIVE_ATTR = 'jeStatusLive';
    const LIVE_SELECTOR = '[data-je-status-live]';

    /**
     * Resolve one badge switch: user override, then admin default, then its
     * built-in default.
     * */
    function isScopeEnabled(scope: {userKey: string, pluginKey: string, fallback: boolean}): boolean {
        const u = JE.currentSettings?.[scope.userKey];
        if (typeof u === 'boolean') return u;
        const a = JE.pluginConfig?.[scope.pluginKey];
        return typeof a === 'boolean' ? a : scope.fallback;
    }

    /**
     * Whether the trending badge can show at all: the user's switch, and the
     * admin's Status Tags + trending switches, which also gate the endpoint.
     * */
    function isTrendingWanted(): boolean {
        return JE.pluginConfig?.StatusTagsEnabled === true
            && JE.pluginConfig?.StatusTagsTrending !== false
            && isScopeEnabled(BADGE_SCOPES.trending);
    }

    /**
     * Whether the Leaving soon badge can show: the user's switch, while the
     * server has a Leaving soon source (it resolves the facts).
     * */
    function isLeavingWanted(): boolean {
        return JE.pluginConfig?.LeavingSoonAvailable === true && isScopeEnabled(BADGE_SCOPES.leaving);
    }

    /**
     * Whether a card can get a direct-play warning: the user's switch and a
     * playable item type that Jellyfin's PlaybackInfo would not probe
     * (tags/tag-direct-play.js does the lookups). Jellyfin refreshes the item
     * with a remote probe when its file is a .strm, probed before or not, or
     * when its first source lists no video stream; those are skipped.
     * */
    function wantsDirectPlay(data: StatusData): boolean {
        return !!JE.tagDirectPlay && PLAYABLE_TYPES.has(data.type || '') && data.probed !== false && !data.strm && isScopeEnabled(BADGE_SCOPES.directPlay);
    }

    /**
     * Whether a card's badge can depend on its series' TMDB schedule: the
     * admin's Status Tags switch and a TMDB key (both gate the endpoint), a
     * known series, and a badge switch that reads it for this card type.
     * */
    function wantsSeriesFacts(data: StatusData): boolean {
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
     * @param key - Translation key.
     * @param [params] - Placeholder values, e.g. { rank }.
     * */
    function label(key: string, params?: JsonRecord): string {
        return JE.t(key, params);
    }

    /**
     * An admin day window in ms, clamped to 1-365 days.
     * @param pluginKey - e.g. 'StatusTagsJustAddedDays'.
     * @param fallback - Default in days.
     * */
    function windowMs(pluginKey: string, fallback: number): number {
        const raw = parseInt(String(JE.pluginConfig?.[pluginKey]), 10);
        const days = Number.isFinite(raw) ? Math.min(vocabulary.thresholds.maxWindowDays, Math.max(vocabulary.thresholds.minWindowDays, raw)) : fallback;
        return days * DAY_MS;
    }

    /** The inputs the server's Revision hashes; without the direct-play module there is no warning. */
    function mediaInputs(): MediaInputs { return JE.tagDirectPlay?.INPUTS || { source: ['Id', 'Path'], stream: [] }; }

    /**
     * The version a card stands for: the user's pick (qualitytags.js) when it is one of the item's versions,
     * else '' (the default one Jellyfin plays).
     * */
    function versionOf(data: StatusData, itemId: string): string {
        const picked = JE.selectedMediaSource?.(itemId) || '';
        return picked && (data.versions || []).includes(picked) ? picked : '';
    }

    /**
     * Whether a date lies within the last `windowLength` ms. A date slightly in
     * the future (server/browser clock skew) still counts; a premiere date in
     * the future does not (see isNewRelease).
     * */
    function isWithin(ms: number|null, now: number, windowLength: number): boolean {
        return ms !== null && ms <= now + DAY_MS && now - ms <= windowLength;
    }

    /**
     * A local calendar day as a day number (days since 1970-01-01), so two
     * days compare without time zones.
     * */
    function localDay(ms: number): number {
        const d = new Date(ms);
        return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
    }

    /**
     * A TMDB air date ("2026-10-04", a calendar date) as a day number, or null.
     * */
    function airDay(date: unknown): number | null {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
        return m ? Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS) : null;
    }

    /**
     * The locale dates are written in: the user's Jellyfin display language
     * (the one JE's strings follow), else JE's display language setting, else
     * the page's, else the browser's.
     * */
    function dateLocale(): string|undefined {
        let uiLanguage = null;
        try {
            const userId = JE.session?.getUserId?.();
            if (userId) uiLanguage = localStorage.getItem(`${userId}-language`);
        } catch {
            // Storage blocked: fall through to the other sources.
        }
        const candidates: unknown[] = [uiLanguage, JE.currentSettings?.displayLanguage, document.documentElement?.getAttribute('lang')];
        for (const candidate of candidates) {
            if (typeof candidate !== 'string' || !candidate) continue;
            try {
                if (Intl.DateTimeFormat.supportedLocalesOf(candidate).length > 0) return candidate;
            } catch {
                // Not a valid language tag; try the next one.
            }
        }
        return undefined;
    }

    /** Remember the web user's date context for static native posters on a personal save.
     * */
    JE.getStatusDateContext = function(): {locale: string, timeZone: string} {
        const options = new Intl.DateTimeFormat(dateLocale()).resolvedOptions();
        return { locale: options.locale, timeZone: options.timeZone };
    };

    /**
     * The {date} of "Airs {date}" / "Returns {date}": "Tomorrow", a weekday
     * name up to WEEKDAY_WITHIN_DAYS days ahead, else a short date ("Oct 4"),
     * in the user's locale.
     * @param day - The air date as a day number.
     * @param daysAhead - Days from today (1 or more).
     * */
    function formatAirDay(day: number, daysAhead: number): string {
        if (daysAhead === 1) return label('calendar_tomorrow');
        // The day number is a UTC midnight, so format it in UTC.
        const date = new Date(day * DAY_MS);
        const options: Intl.DateTimeFormatOptions = daysAhead <= WEEKDAY_WITHIN_DAYS
            ? { weekday: 'long', timeZone: 'UTC' }
            : { month: 'short', day: 'numeric', timeZone: 'UTC' };
        try {
            return new Intl.DateTimeFormat(dateLocale(), options).format(date);
        } catch {
            return new Intl.DateTimeFormat('en', options).format(date);
        }
    }

    /**
     * The trending rank of an item, when the list has it.
     * */
    function trendingRank(data: {type: string|null, tmdb: string|null}): number|null {
        const list = trending.data;
        if (!list || !data.tmdb) return null;
        const map = data.type === 'Movie' ? list.movies : data.type === 'Series' ? list.series : null;
        const rank = map ? own(map, data.tmdb) : null;
        return typeof rank === 'number' && rank > 0 ? rank : null;
    }

    /**
     * The TMDB schedule facts of a card's series, when they have arrived.
     * */
    function seriesFactsFor(data: StatusData): SeriesFacts|null {
        return data.seriesId ? seriesInfo.get(data.seriesId)?.facts ?? null : null;
    }

    /**
     * Complete Season needs proof (StatusRules.SeasonComplete): TMDB's episode count for the season, every one of
     * them aired (no next episode in it), and the library covering every episode number 1..N.
     * */
    function seasonComplete(data: StatusData, facts: SeriesFacts|null): boolean {
        const season = data.season ?? data.latestIndex?.s ?? null;
        const expected = season !== null ? toInt(facts?.seasonEpisodes?.[season]) : null;
        if (season === null || !facts || !expected || expected <= 0) return false;
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
     * @param isLast - Local season-boundary confirmation for the fallback.
     * */
    function lastAiredEndsSeason(facts: SeriesFacts, isLast: boolean|null): boolean {
        const last = facts.last;
        if (!last) return false;
        if (last.type) return last.type === 'finale';
        return isLast === true && (!facts.next || (facts.next.season !== null && last.season !== null && facts.next.season > last.season));
    }

    /**
     * A badge from its key ('new_season', 'airs_date', ...): the en.json key is
     * `status_tag_<key>`, the compact label comes from COMPACT_LABEL_KEYS.
     * @param kind - Chip modifier class.
     * */
    /** The vocabulary row of a badge the rules below name. */
    function badgeDefinition(key: string): BadgeDefinition {
        const definition = own(badgeDefinitions, key);
        if (!definition) throw new Error(`Unknown status badge ${key}`);
        return definition;
    }

    function makeBadge(key: string, params?: Readonly<Record<string, unknown>>): StatusBadge {
        const definition = badgeDefinition(key);
        const badge: StatusBadge = { kind: definition.kind, key, label: label(definition.label, params) };
        const compact = own(COMPACT_LABEL_KEYS, key);
        if (compact) badge.compact = label(compact, params);
        return badge;
    }

    /**
     * The Leaving soon badge: "Leaving in {days}d" by local calendar days (a
     * DST day is not 24 hours), "Leaving tomorrow", "Leaving today", and
     * "Leaving soon" without a date or once it has passed (Maintainerr
     * removes it on its next run). Mirrors StatusRules.LeavingBadge.
     * */
    function leavingBadge(leaving: LeavingFacts, now: number): StatusBadge {
        if (leaving.deleteAt === null) return makeBadge('leaving_soon');
        const days = localDay(leaving.deleteAt) - localDay(now);
        if (days < 0) return makeBadge('leaving_soon');
        if (days === 0) return makeBadge('leaving_today');
        if (days === 1) return makeBadge('leaving_tomorrow');
        return makeBadge('leaving_days', { days });
    }

    /**
     * The direct-play warning for a playable card, once its lookup answered.
     * */
    function directPlayBadge(data: StatusData, itemId: string | null | undefined): StatusBadge | null {
        const player = JE.tagDirectPlay;
        if (!player || !itemId || !wantsDirectPlay(data)) return null;
        const result = player.peek(String(itemId), data.media || '', versionOf(data, String(itemId)));
        if (!result || result.directPlay) return null;
        const badge = makeBadge(result.remux ? 'direct_play_remux' : 'direct_play_transcode');
        badge.title = player.describe(result, badge.label);
        return badge;
    }

    /**
     * Resolve one regular finale for both card types: caller-filtered series
     * aggregate, regular TMDB last episode, season enrichment, local aggregate.
     * Never infer a series boundary from an episode's season-local IsLast flag.
     * */
    function finalRegularEpisode(data: StatusData, facts: SeriesFacts | null): EpisodeRef | null {
        if (!facts) return null;
        const seriesId = data.seriesId;
        const parent = seriesId ? JE.tagPipeline?.peekItemFacts?.(seriesId) || JE.tagPipeline?.peekServerEntry?.(seriesId) : null;
        const aggregate: EpisodeFacts = parent ? readFacts(parent) : data.type === 'Series' ? data : readFacts({});
        // The library's latest episode only stands in for TMDB's finale when TMDB's per-season counts show it is the
        // last episode of the last season (StatusRules.FinalRegularEpisode).
        const counts = facts.seasonEpisodes || {};
        const lastSeason = Math.max(0, ...Object.keys(counts).map(Number).filter(Number.isFinite));
        /** @param local */
        const regular = (local: EpisodeFacts): EpisodeRef | null => {
            if (!local.latestIndex || !(local.latestIndex.s > 0) || local.latestAired === null) return null;
            if (local.latestIndex.s !== lastSeason || toInt(counts[lastSeason]) !== local.latestIndex.e) return null;
            // The air date is a calendar date (stored at midnight UTC): keep its day, as TMDB's own dates are kept.
            const date = new Date(local.latestAired);
            const day = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
            return { date: day, season: local.latestIndex.s, episode: local.latestIndex.e, type: null };
        };
        // TMDB's final regular episode first: local S1E3 is not the finale of a ten-episode season TMDB has ended.
        const regularSeason = (episode: EpisodeRef | null) => ((episode?.season ?? 0) > 0 ? episode : null);
        return regularSeason(facts.last)
            || regularSeason(facts.regular)
            || regular(aggregate)
            || regular(readFacts((seriesId && data.season !== null ? JE.tagPipeline?.peekSeasonFacts?.(seriesId, data.season) : null) || {}))
            || regular(data);
    }

    /**
     * Pick the one badge a card shows (first match wins), or null.
     * @param data - Card snapshot, refreshed from shared facts when available.
     * @param itemId - The card's own item id (never its parent id).
     * */
    function pickBadge(data: StatusData, itemId: string | null | undefined): StatusBadge | null {
        const normalizedId = normId(itemId);
        const current = normalizedId ? JE.tagPipeline?.peekItemFacts?.(normalizedId) : null;
        if (current) {
            // Shared caller-filtered facts are authoritative, including removed fields.
            Object.assign(data, readFacts(current), { latest: toMs(current.LatestEpisodeAdded) });
        }
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
        const finalDay = airDay(finalRegular?.date);
        const finalAiredRecently = finalDay !== null && finalDay <= today && (today - finalDay) * DAY_MS <= newReleaseMs;
        // A premiere date is a calendar day (Jellyfin stores it at midnight UTC): it is compared with
        // the viewer's own today, so release day starts at local midnight in every time zone.
        const premiereDay = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : Math.floor(ms / DAY_MS));
        const airedWithin = (ms: number | null, windowMs: number) => { const day = premiereDay(ms); return day !== null && day <= today && (today - day) * DAY_MS <= windowMs; };
        const isNewRelease = airedWithin(data.premiere, newReleaseMs);
        const releaseDay = premiereDay(data.premiere);
        const comingSoon = releaseDay !== null && releaseDay > today;
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
                return { kind: 'trending', key, label: label(badgeDefinition(key).label, { rank: RANK_TOKEN }), rank };
            }
        }
        switch (data.type) {
            case 'Movie':
                if (showSchedule && comingSoon) return makeBadge('coming_soon');
                if (showNew && isNewRelease) return makeBadge('new_movie');
                break;
            case 'Series': {
                if (showSchedule && daysToNext === 0) return makeBadge('airing_today');
                // The finale of an ended show, aired recently and in the library.
                if (showMilestones && finalRegular && TMDB_ENDED.has(facts?.status || '') && finalAiredRecently
                    && data.latestIndex && data.latestIndex.s === finalRegular.season && data.latestIndex.e === finalRegular.episode) {
                    return makeBadge('series_finale');
                }
                const sp = data.seasonPremiere;
                if (showMilestones && sp && sp.s > 1 && airedWithin(sp.aired, newReleaseMs)) return makeBadge('new_season');
                if (showSchedule && nextDay !== null && daysToNext !== null && daysToNext >= 1 && daysToNext <= AIRS_WITHIN_DAYS) {
                    return makeBadge('airs_date', { date: formatAirDay(nextDay, daysToNext) });
                }
                if (showSchedule && nextDay !== null && daysToNext !== null && daysToNext >= 1 && daysToNext <= RETURNS_WITHIN_DAYS
                    && lastDay !== null && nextDay - lastDay > RETURN_GAP_DAYS) {
                    return makeBadge('returns_date', { date: formatAirDay(nextDay, daysToNext) });
                }
                if (showNew && newEpisode) return makeBadge('new_episode');
                if (showSchedule && comingSoon) return makeBadge('coming_soon');
                if (showNew && isNewRelease) return makeBadge('new_series');
                break;
            }
            case 'Season': {
                const span = data.addedSpan;
                // Every available episode arrived within the just-added window, and they are the whole season.
                if (showMilestones && span && span.count > 0 && span.first <= span.last && isWithin(span.first, now, justAddedMs) && isWithin(span.last, now, justAddedMs)
                    && seasonComplete(data, facts)) {
                    return makeBadge('complete_season');
                }
                if (showMilestones && data.seasonPremiere && airedWithin(data.seasonPremiere.aired, newReleaseMs)) {
                    return makeBadge('season_premiere');
                }
                const season = data.season ?? data.seasonPremiere?.s ?? data.latestIndex?.s ?? null;
                if (showMilestones && facts?.last && lastAiredRecently && season !== null && facts.last.season === season
                    && data.latestIndex && data.latestIndex.s === season && data.latestIndex.e === facts.last.episode
                    && lastAiredEndsSeason(facts, data.latestIndex.isLast)) {
                    return makeBadge('season_finale');
                }
                if (showNew && newEpisode) return makeBadge('new_episode');
                break;
            }
            case 'Episode': {
                // Its own air date: a guarded (stripped) episode has none.
                const airedRecently = releaseDay !== null && releaseDay <= today;
                if (showMilestones && airedRecently && data.episode === 1 && data.season !== null && data.season > 0
                    && airedWithin(data.premiere, justAddedMs)) {
                    return makeBadge('season_premiere');
                }
                // A combined file (S01E09-E10) is the finale when it holds the final episode.
                const holds = (number: number | null | undefined) => data.episode !== null && typeof number === 'number' && number >= data.episode && number <= (data.episodeEnd ?? data.episode);
                if (showMilestones && airedRecently && finalRegular && finalAiredRecently
                    && data.season === finalRegular.season && holds(finalRegular.episode)
                    && TMDB_ENDED.has(facts?.status || '')) return makeBadge('series_finale');
                if (showMilestones && airedRecently && facts?.last && lastAiredRecently
                    && data.season === facts.last.season && holds(facts.last.episode)) {
                    if (lastAiredEndsSeason(facts, data.isLast)) return makeBadge('season_finale');
                }
                if (showNew && airedWithin(data.premiere, justAddedMs)) return makeBadge('new_episode');
                break;
            }
            case 'BoxSet':
            case 'Video':
                break;
            default:
                return null;
        }
        if (showAdded && addedRecently) return makeBadge('just_added');
        if (data.type === 'Movie' && isScopeEnabled(BADGE_SCOPES.scenes)) {
            if (data.scenes?.PostCredits === true) return makeBadge('post_credits');
            if (data.scenes?.MidCredits === true) return makeBadge('mid_credits');
        }
        if (data.type === 'Series' && showStatus) return seriesStatusBadge(data, facts);
        return directPlayBadge(data, itemId);
    }

    /**
     * The lowest-priority Series badge: Jellyfin first, with TMDB refining
     * an ended series to cancelled or supplying an absent Jellyfin status.
     * */
    function seriesStatusBadge(data: StatusData, facts: SeriesFacts | null): StatusBadge | null {
        if (data.status === 'Continuing') return makeBadge('returning');
        if (data.status === 'Ended') return makeBadge(facts?.status === 'Canceled' ? 'cancelled' : 'ended');
        switch (facts?.status || '') {
            case 'Returning Series': return makeBadge('returning');
            case 'Ended': return makeBadge('ended');
            case 'Canceled': return makeBadge('cancelled');
            default: break;
        }
        return null;
    }

    /**
     * Retrieve a fresh cached entry from localStorage or hot cache.
     * @param ctx - Factory context.
     * @param itemId - Jellyfin item ID.
     * @returns Cached data, or null when unknown, too old to
     *   trust, or stored in an older shape.
     */
    function getCachedEntry(ctx: TagCtx, itemId: string): StatusData | null {
        const entry = ctx.getPersistent(itemId) ?? ctx.hot?.get(itemId);
        if (!isRecord(entry) || entry.v !== CACHE_ENTRY_VERSION) return null;
        if (typeof entry.timestamp !== 'number' || Date.now() - entry.timestamp > CACHE_FRESH_MS) return null;
        return {
            fetchedAt: entry.timestamp,
            type: text(entry.t),
            tmdb: text(entry.m),
            created: finite(entry.c),
            premiere: finite(entry.p),
            latest: finite(entry.l),
            status: text(entry.st),
            scenes: isRecord(entry.sc) ? entry.sc : null,
            latestAired: finite(entry.la),
            isLast: typeof entry.il === 'boolean' ? entry.il : null,
            latestIndex: Array.isArray(entry.li) ? { s: Number(entry.li[0]), e: Number(entry.li[1]), isLast: entry.li[2] === true } : null,
            seasonPremiere: Array.isArray(entry.sp) ? { s: Number(entry.sp[0]), aired: Number(entry.sp[1]) } : null,
            addedSpan: Array.isArray(entry.as) ? { first: Number(entry.as[0]), last: Number(entry.as[1]), count: Number(entry.as[2]), coveredThrough: finite(entry.as[3]) } : null,
            season: finite(entry.sn),
            episode: finite(entry.en),
            episodeEnd: finite(entry.ee),
            media: text(entry.mk) ?? '',
            // Whether a direct-play lookup may probe this item, and which versions it can ask about.
            probed: typeof entry.pr === 'boolean' ? entry.pr : null,
            strm: entry.sm === true,
            versions: stringList(entry.vs),
            seriesId: text(entry.si),
            // Stored only when known (null and undefined both mean "unknown" here).
            seriesTmdb: text(entry.stm) ?? (entry.t === 'Series' ? null : undefined),
            leaving: Array.isArray(entry.lv) ? readLeaving({ DeleteAt: typeof entry.lv[0] === 'number' ? entry.lv[0] : null }) : null,
        };
    }

    /**
     * Store an entry in both localStorage cache and hot cache. Null fields are
     * left out to keep the stored copy small.
     * @param ctx - Factory context.
     * @param itemId - Jellyfin item ID.
     * */
    function setCachedEntry(ctx: TagCtx, itemId: string, data: StatusData): void {
        const entry: Record<string, unknown> = { v: CACHE_ENTRY_VERSION, t: data.type, timestamp: data.fetchedAt ?? Date.now() };
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
        if (typeof data.probed === 'boolean') entry.pr = data.probed;
        if (data.strm) entry.sm = true;
        if (data.versions?.length) entry.vs = data.versions;
        if (data.seriesId) entry.si = data.seriesId;
        if (data.seriesTmdb) entry.stm = data.seriesTmdb;
        if (data.leaving) entry.lv = [data.leaving.deleteAt];
        ctx.setPersistent(itemId, entry);
        ctx.hot?.set(itemId, entry);
    }

    /**
     * Create and append the status badge to a card.
     * @param ctx - Factory context.
     * @param el - The card container to receive the overlay.
     * @param badge - From pickBadge.
     * */
    function applyStatusTag(ctx: TagCtx, el: HTMLElement, badge: StatusBadge | null): void {
        if (!badge) return;

        ctx.removeExistingOverlay(el);

        const container = document.createElement('div');
        container.className = containerClass;

        const tag = document.createElement('div');
        tag.className = `${tagClass} ${tagClass}--${badge.kind}`;
        // Preserve the existing Tag Styles selectors; new vocabulary uses its badge key.
        const status = badgeDefinition(badge.key).style;
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
            const [before = '', after = ''] = badge.label.split(RANK_TOKEN);
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
     * */
    function badgeKey(badge: StatusBadge | null): string {
        return `${localDay(Date.now())}|${badge ? `${badge.kind}|${badge.key}|${badge.label}|${badge.rank ?? ''}|${badge.title ?? ''}` : ''}`;
    }

    /**
     * A trending list as a comparable string; an empty list (or none) is ''.
     * */
    function trendingKey(list: TrendingList | null): string {
        if (!list || !list.source) return '';
        return JSON.stringify([list.source, list.movies, list.series]);
    }

    /**
     * Draw a card's badge, and remember a card live data can re-badge (a
     * Movie/Series with a TMDB id for trending, a card reading its series'
     * TMDB schedule) for the pass that runs when that data changes. Asks for
     * the series' schedule when it is not known or has expired.
     * @param ctx - Factory context.
     * @param el - Render target.
     * @param data - Normalized item data.
     * @param [itemId] - Jellyfin item id the data came from.
     * */
    function renderData(ctx: TagCtx, el: HTMLElement, data: StatusData, itemId?: string | null): void {
        // Cheap when fresh; refreshes a list that expired during a long session.
        activateStatus(ctx);
        ensureTrending(ctx);
        const readsSeries = wantsSeriesFacts(data);
        const badge = pickBadge(data, itemId);
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
        if (wantsDirectPlay(data) && itemId && (!badge || badge.kind === 'playback')) JE.tagDirectPlay?.track(el, String(itemId), onDirectPlayAnswer, data.media || '', versionOf(data, String(itemId)));
        else JE.tagDirectPlay?.untrack(el);
        applyStatusTag(ctx, el, badge);
    }

    /**
     * Observe schedule readers through one viewport observer, retaining identity guards.
     * @param ctx @param {HTMLElement} el
     * */
    function observeSeriesCard(ctx: TagCtx, el: HTMLElement): void {
        if (!seriesObserver && typeof IntersectionObserver !== 'undefined') {
            const observer = new IntersectionObserver(entries => {
                if (seriesObserver !== observer) return; // A queued callback from before cleanup.
                for (const { target, isIntersecting } of entries) {
                    if (!(target instanceof HTMLElement)) continue;
                    const host = target;
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

    /** @param el @returns Current pipeline card identity. */
    function cardIdentity(el: HTMLElement): string|null {
        const card = el.closest('[data-id], [data-itemid]');
        return card?.getAttribute('data-id') || card?.getAttribute('data-itemid') || null;
    }

    /** @param el @returns Release a target and its previous visibility. */
    function unobserveSeriesCard(el: HTMLElement): void {
        seriesObserver?.unobserve(el);
        observedSeriesCards.delete(el);
        intersectingCards.delete(el);
    }

    /** @param el @returns Forget a removed or recycled card's live data. */
    function forgetSeriesCard(el: HTMLElement): void {
        unobserveSeriesCard(el);
        liveCards.delete(el);
        delete el.dataset[LIVE_ATTR];
    }

    /** @returns Release all targets; the next schedule render creates observers lazily. */
    function releaseSeriesObservers(): void {
        for (const el of observedSeriesCards) forgetSeriesCard(el);
        seriesObserver?.disconnect();
        seriesObserver = null;
        seriesTargetObserver?.disconnect();
        seriesTargetObserver = null;
        intersectingCards = new WeakSet();
    }

    /** @param el @param {Object|undefined} card */
    function eligibleSeriesCard(el: HTMLElement, card: LiveCard | undefined): card is SeriesCard {
        return el.isConnected && intersectingCards.has(el) && !!card && isCurrentRecord(card)
            && card.domId === cardIdentity(el)
            && !el.closest('.je-hidden') && wantsSeriesFacts(card.data);
    }

    /** @param id @returns Whether any current visible card still needs this id. */
    function hasVisibleSeries(id: string): boolean {
        return [...document.querySelectorAll<HTMLElement>(LIVE_SELECTOR)].some(el => {
            const card = liveCards.get(el);
            return card?.data.seriesId === id && eligibleSeriesCard(el, card);
        });
    }

    /**
     * Whether a card's record was made after everything that replaced the
     * data it holds. Checked at use, so a card that was detached while its
     * item was replaced, then put back, is caught as well.
     * */
    function isCurrentRecord(card: LiveCard): boolean {
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
     * @param ctx - Factory context.
     * @param updatedIds - Item ids a delta replaced, or null for everything.
     * @param [info] - What the pipeline did with the cache.
     * */
    function onCacheReplaced(ctx: TagCtx, updatedIds: readonly string[] | null, info?: RefreshInfo): void {
        trackRev++;
        if (updatedIds) {
            for (const id of updatedIds) {
                ctx.deletePersistent(String(id));
                ctx.hot?.delete(String(id));
            }
            if (replacedAt.size + updatedIds.length > REPLACED_AT_CAP) {
                staleBelowRev = trackRev;
                replacedAt.clear();
                return;
            }
            for (const id of updatedIds) replacedAt.set(normId(id) ?? '', trackRev);
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
        if (info?.replaced && JE.currentSettings?.statusTagsEnabled) reinitializeStatusTags();
    }

    /**
     * After a fetch brought different live data (a trending list, or TMDB
     * schedules for some series): re-badge every recorded card on the page
     * whose badge changes with it (a new or changed rank or schedule badge,
     * or a card that falls back to its library badge or none). Each badge
     * goes through the layout controller, which re-presents its card;
     * overlays it does not manage are re-stacked in one pass.
     * @param ctx - Factory context.
     * */
    function applyLivePass(ctx: TagCtx): void {
        if (!statusActive || !JE.currentSettings?.statusTagsEnabled) return;
        renderedDay = localDay(Date.now());
        const hosts: HTMLElement[] = [];
        document.querySelectorAll<HTMLElement>(LIVE_SELECTOR).forEach((el) => {
            const card = liveCards.get(el);
            if (!card || ctx.shouldIgnore(el) || el.closest('.je-hidden')) return;
            if (!isCurrentRecord(card) || card.domId !== cardIdentity(el)) {
                forgetSeriesCard(el);
                return;
            }
            const badge = pickBadge(card.data, card.id);
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
     * @param ctx - Factory context.
     * */
    function ensureTrending(ctx: TagCtx): void {
        if (!isTrendingWanted() || trending.promise) return;
        const now = Date.now();
        if (now < trending.retryAt) return;
        if (trending.data?.source && now - trending.fetchedAt < TRENDING_TTL_MS) return;
        if (!hasApiClient()) return;

        const previous = trendingKey(trending.data);
        trending.promise = (async () => {
            try {
                const response = record(await apiClient().ajax({
                    type: 'GET',
                    url: apiClient().getUrl('JellyfinEnhanced/status-tags/trending'),
                    dataType: 'json'
                }));
                const movies = record(response.movies);
                const series = record(response.series);
                trending.data = { source: typeof response.source === 'string' ? response.source : null, movies, series };
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
     * @param ctx - Factory context.
     * @param seriesId - Normalised series item id.
     * */
    function requestSeries(ctx: TagCtx, seriesId: string): void {
        if (!statusActive || !JE.currentSettings?.statusTagsEnabled) return;
        const known = seriesInfo.get(seriesId);
        if (known && (known.loading || Date.now() < known.expires)) {
            if (!known.loading && TMDB_ENDED.has(known.facts?.status ?? '') && JE.tagPipeline?.lookupItemFacts
                && !JE.tagPipeline.peekItemFacts(seriesId) && !parentFactsLoads.has(seriesId)) {
                parentFactsLoads.add(seriesId);
                parentFactsQueue.add(seriesId);
                scheduleParentFacts(ctx);
            }
            return;
        }
        if (seriesQueue.has(seriesId) || !hasApiClient()) return;
        seriesInfo.set(seriesId, { facts: known?.facts ?? null, expires: known?.expires ?? 0, loading: true });
        seriesQueue.add(seriesId);
        if (!seriesTimer) seriesTimer = setTimeout(() => { flushSeries(ctx); }, SERIES_FLUSH_MS);
    }

    /**
     * Collect visible expired parents before starting a single serial drain.
     * @param ctx - Factory context.
     * */
    function scheduleParentFacts(ctx: TagCtx): void {
        if (parentFactsLoading || parentFactsTimer !== null || !parentFactsQueue.size || !statusActive) return;
        parentFactsTimer = setTimeout(() => { flushParentFacts(ctx); }, SERIES_FLUSH_MS);
    }

    /**
     * Refresh parents through the pipeline in bounded batches, with one live
     * recomputation per completed batch. New ids join the running drain; ids
     * already queued or loading cannot start duplicate requests. Cleanup drops
     * queued work and stale completions without opening another in-flight drain.
     * @param ctx - Factory context.
     * */
    async function flushParentFacts(ctx: TagCtx): Promise<void> {
        parentFactsTimer = null;
        const epoch = seriesEpoch;
        parentFactsLoading = true;
        try {
            while (parentFactsQueue.size && statusActive && epoch === seriesEpoch) {
                const ids = [...parentFactsQueue].slice(0, PARENT_FACTS_BATCH);
                for (const id of ids) parentFactsQueue.delete(id);
                const visible = new Set<string>();
                for (const el of observedSeriesCards) {
                    const card = liveCards.get(el);
                    if (eligibleSeriesCard(el, card)) visible.add(card.data.seriesId);
                }
                const batch = ids.filter(id => visible.has(id));
                if (batch.length) await JE.tagPipeline?.lookupItemFacts(batch);
                if (epoch !== seriesEpoch) return;
                for (const id of ids) parentFactsLoads.delete(id);
                if (batch.some(id => JE.tagPipeline?.peekItemFacts(id))) applyLivePass(ctx);
            }
        } finally {
            parentFactsLoading = false;
            scheduleParentFacts(ctx);
        }
    }

    /**
     * The facts of one series in a /status-tags/series answer, or null.
     * */
    function readSeriesFacts(raw: unknown): SeriesFacts | null {
        if (!isRecord(raw)) return null;
        /** @param ep @param {boolean} withType */
        const episode = (ep: unknown, withType: boolean): EpisodeRef | null => (isRecord(ep) && airDay(ep.date) !== null
            ? { date: String(ep.date), season: toInt(ep.season), episode: toInt(ep.episode), ...(withType ? { type: typeof ep.type === 'string' ? ep.type : null } : {}) }
            : null);
        return {
            status: typeof raw.status === 'string' ? raw.status : null,
            last: episode(raw.lastAired, true),
            regular: episode(raw.lastRegularAired, true),
            next: episode(raw.nextAired, false),
            seasonEpisodes: isRecord(raw.seasonEpisodes) ? raw.seasonEpisodes : null,
        };
    }

    /**
     * Send the queued series ids, SERIES_BATCH per request, one request at a
     * time. Every id asked about is kept for SERIES_TTL_MS (an id the server
     * left out has no facts), or SERIES_RETRY_MS after a failed request. When
     * any series' facts changed, one pass re-badges the cards on the page. An
     * answer that lands after a user switch is dropped.
     * @param ctx - Factory context.
     * */
    async function flushSeries(ctx: TagCtx): Promise<void> {
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
            let answer: unknown = null;
            let ok = false;
            try {
                answer = await apiClient().ajax({
                    type: 'GET',
                    url: apiClient().getUrl('JellyfinEnhanced/status-tags/series', { ids: batch.join(',') }),
                    dataType: 'json'
                });
                ok = true;
            } catch (e) {
                console.warn(`${logPrefix} Could not load series schedules; showing library badges only.`, e);
            }
            if (epoch !== seriesEpoch) return;
            const byId = new Map<string | null, unknown>();
            for (const [key, value] of Object.entries(record(answer))) byId.set(normId(key), value);
            const now = Date.now();
            for (const id of batch) {
                const previous = seriesInfo.get(id)?.facts ?? null;
                const failed = !ok || record(byId.get(id)).retry === true;
                const facts = failed ? previous : readSeriesFacts(byId.get(id));
                seriesInfo.set(id, { facts, expires: now + (failed ? SERIES_RETRY_MS : SERIES_TTL_MS), retry: failed });
                if (JSON.stringify(previous) !== JSON.stringify(facts)) changed = true;
            }
            // Episode-only pages may have restored just their visible entries
            // from IndexedDB. Warm the confirmed caller-filtered parent aggregates
            // before resolving the same regular finale as a series card.
            const endedIds = batch.filter(id => TMDB_ENDED.has(seriesInfo.get(id)?.facts?.status ?? ''));
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
     * @param ctx */
    function armSeriesRetry(ctx: TagCtx): void {
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
     * @param ctx */
    function armMidnight(ctx: TagCtx): void {
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

    /** @param ctx @returns Refresh a tab returning from background/sleep. */
    function refreshCalendar(ctx: TagCtx): void {
        if (!statusActive || !JE.currentSettings?.statusTagsEnabled) return;
        applyLivePass(ctx);
        for (const [id] of seriesInfo) if (hasVisibleSeries(id)) requestSeries(ctx, id);
        armMidnight(ctx);
        armSeriesRetry(ctx);
    }

    /**
     * Cancel page-owned timers and invalidate pending answers before releasing cards.
     * */
    function stopStatus(): void {
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
        document.querySelectorAll<HTMLElement>(LIVE_SELECTOR).forEach(el => {
            liveCards.delete(el);
            delete el.dataset[LIVE_ATTR];
        });
        renderedDay = null;
    }

    /** @param ctx @returns Arm a new active rendering lifetime once. */
    function activateStatus(ctx: TagCtx): void {
        if (statusActive || !JE.currentSettings?.statusTagsEnabled) return;
        statusActive = true;
        armMidnight(ctx);
    }

    /** One live pass for the direct-play answers a slice applied (one stable callback, so a slice runs it once). */
    function onDirectPlayAnswer() {
        if (statusCtx) applyLivePass(statusCtx);
    }

    /** Factory spec — everything status-specific lives here. */
    const spec: TagSpec = {
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
            render(ctx: TagCtx, el, item) {
                if (ctx.shouldIgnore(el)) return;
                if (ctx.isTagged(el)) return;
                if (el.closest('.je-hidden')) return;

                const itemId = String(item.Id);
                JE.tagPipeline?.rememberItemFacts?.(item);
                const data = { ...fromItem(item, mediaInputs()), fetchedAt: Date.now() };
                // The shared factory stamps this accepted answer with its own strip revision.
                // Empty guarded answers are page-local hits; only unstripped answers persist.
                setCachedEntry(ctx, itemId, data);
                renderData(ctx, el, data, itemId);
            },
            renderFromCache(ctx: TagCtx, el, itemId) {
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
            renderFromServerCache(ctx: TagCtx, el, entry, itemId) {
                if (ctx.isTagged(el)) return;
                if (ctx.shouldIgnore(el)) return;
                if (el.closest('.je-hidden')) return;
                renderData(ctx, el, fromServerEntry(entry, itemId, mediaInputs()), itemId);
            },
            cleanup() {
                stopStatus();
                JE.tagDirectPlay?.reset();
            },
            onServerCacheRefresh(ctx: TagCtx, updatedIds, info) {
                onCacheReplaced(ctx, updatedIds, info);
            },
        },
    };

    /** ctx handle from the first registration */
    let statusCtx: TagCtx | null = null;
    /** the session user-change hook is registered once per page */
    let userChangeRegistered: boolean = false;

    /**
     * Register the Status Tags renderer with the tag pipeline and start the
     * trending fetch. Idempotent: a repeat call re-registers with fresh settings.
     * */
    JE.initializeStatusTags = function(): void {
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
        const registered = JE.core.tagRenderer.register('status', spec);
        statusCtx = registered;
        registered.injectCss();
        activateStatus(registered);
        ensureTrending(registered);
        if (!calendarEventsRegistered) {
            calendarEventsRegistered = true;
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden && statusCtx) refreshCalendar(statusCtx);
            });
            window.addEventListener('focus', () => { if (statusCtx) refreshCalendar(statusCtx); });
            window.addEventListener('pagehide', stopStatus);
            window.addEventListener('pageshow', () => reinitializeStatusTags());
        }

        console.log(`${logPrefix} Initialized successfully.`);
    };

    /**
     * Remove every status badge and redraw them with the current settings
     * (position, badge switches), fetching the trending list and series
     * schedules if now needed.
     * */
    function reinitializeStatusTags(): void {
        JE.core.tagRenderer.reinitialize('status', spec);
        if (statusCtx && JE.currentSettings?.statusTagsEnabled) {
            activateStatus(statusCtx);
            ensureTrending(statusCtx);
        }
    }
    JE.reinitializeStatusTags = reinitializeStatusTags;

    // Previews may enable this group while the signed-in user has it off.
    JE.core.tagRenderer.registerStyles(spec);
}
