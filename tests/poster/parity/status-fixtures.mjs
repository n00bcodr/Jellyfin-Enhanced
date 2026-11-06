import { readdirSync } from 'node:fs';

// Fixed-clock fixtures consumed by both the real web renderer and native StatusRules.
const now = Date.UTC(2026, 9, 30, 12);
const day = 86400000;
const ago = n => now - n * day;
const old = ago(400);
const movie = (e = {}) => ({ Type: 'Movie', TmdbId: '1', DateCreated: old, PremiereDate: old, ...e });
const show = (e = {}) => ({ ...movie(), Type: 'Series', ...e });
const season = (e = {}) => ({ Type: 'Season', SeriesId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', SeriesTmdbId: '1', SeasonNumber: 2, DateCreated: old, ...e });
const episode = (e = {}) => ({ ...season(), Type: 'Episode', EpisodeNumber: 5, PremiereDate: ago(2), ...e });
const schedule = (lastAired = null, nextAired = null, status = 'Returning Series') => ({ status, lastAired, nextAired });
const ep = (date, season = 2, episode = 5, type = 'finale') => ({ date, season, episode, type });
const rows = [];
const add = (name, entry, key, text, extra = {}) => rows.push({ name, now, entry, expected: key ? { key, text } : null, ...extra });
add('post-credits-default-off', movie({ Scenes: { PostCredits: true, MidCredits: true } }), null, null);
add('post-credits', movie({ Scenes: { PostCredits: true, MidCredits: true } }), 'post_credits', 'Post-credits', { settings: { StatusTagsScenes: true } });
add('mid-credits', movie({ Scenes: { PostCredits: false, MidCredits: true } }), 'mid_credits', 'Mid-credits', { settings: { StatusTagsScenes: true } });
add('scenes-after-added', movie({ DateCreated: ago(1), Scenes: { PostCredits: true } }), 'just_added', 'Just Added', { settings: { StatusTagsScenes: true } });
add('scenes-movie-only', show({ Scenes: { PostCredits: true } }), null, null, { settings: { StatusTagsScenes: true } });
add('added-video', { Type: 'Video', DateCreated: ago(1) }, 'just_added', 'Just Added');
add('added-collection', { Type: 'BoxSet', DateCreated: ago(1) }, 'just_added', 'Just Added');
add('new-movie', movie({ PremiereDate: ago(2), DateCreated: ago(1) }), 'new_movie', 'New Movie');
add('new-series', show({ PremiereDate: ago(2) }), 'new_series', 'New Series');
add('new-episode', episode({ PremiereDate: old, DateCreated: ago(1) }), 'new_episode', 'New Episode');
add('container-new-episode', show({ LatestEpisodeAdded: ago(1) }), 'new_episode', 'New Episode');
add('coming-soon', movie({ PremiereDate: now + day }), 'coming_soon', 'Coming Soon');
add('popular', movie({ PremiereDate: now + day }), 'trending_today', '#3 Today', { rank: 3 });
add('no-key-no-popular', movie(), null, null, { rank: 3, plugin: { TMDB_API_KEY: '' } });
// Seerr's weekly list (TMDB failed or no key): "#N This Week" on web and native alike.
add('popular-week-seerr', movie(), 'trending_week', '#2 This Week', { rank: 2, rankSource: 'seerr-week', plugin: { TMDB_API_KEY: '', JellyseerrEnabled: true, JellyseerrUrls: 'http://seerr.test', JellyseerrApiKey: 'key' } });
add('trending-off', movie(), null, null, { rank: 3, settings: { StatusTagsTrending: false } });
add('admin-trending-off', movie(), null, null, { rank: 3, plugin: { StatusTagsTrending: false } });
add('native-master-does-not-enable-status', movie({ PremiereDate: ago(2) }), null, null, { settings: { StatusTagsEnabled: false } });
add('status-slot-off', movie({ PremiereDate: ago(2) }), null, null, { settings: { TagLayoutSettingsVersion: 1, TagLayouts: { Corners: { Groups: [{ Group: 'status', Slot: 'off' }] } } } });
add('new-season', show({ SeasonPremiere: { Season: 2, Aired: ago(3) } }), 'new_season', 'New Season');
add('season-premiere', season({ SeasonPremiere: { Season: 2, Aired: ago(3) } }), 'season_premiere', 'Season Premiere');
add('episode-premiere', episode({ EpisodeNumber: 1 }), 'season_premiere', 'Season Premiere');
// Complete Season needs TMDB's episode count, every episode aired and as many in the library, up to the last.
const complete = (lastAired, nextAired = null, count = 8) => ({ ...schedule(lastAired, nextAired), seasonEpisodes: { 2: count } });
add('complete-season', season({ SeasonAddedSpan: { First: ago(2), Last: ago(1), Count: 8, CoveredThrough: 8 }, LatestEpisodeIndex: { Season: 2, Episode: 8 } }), 'complete_season', 'Complete Season', { schedule: complete(ep('2026-10-20', 2, 8, null)) });
add('complete-season-needs-tmdb', season({ SeasonAddedSpan: { First: ago(2), Last: ago(1), Count: 8, CoveredThrough: 8 }, LatestEpisodeIndex: { Season: 2, Episode: 8 } }), null, null);
add('complete-season-one-of-ten', season({ SeasonAddedSpan: { First: ago(1), Last: ago(1), Count: 1 }, LatestEpisodeIndex: { Season: 2, Episode: 1 } }), null, null, { schedule: complete(ep('2026-10-20', 2, 10, null), null, 10) });
add('complete-season-future-episode', season({ SeasonAddedSpan: { First: ago(2), Last: ago(1), Count: 3 }, LatestEpisodeIndex: { Season: 2, Episode: 3 } }), null, null, { schedule: complete(ep('2026-10-20', 2, 3, null), ep('2026-11-04', 2, 4, null), 4) });
add('complete-season-duplicate-for-missing', season({ SeasonAddedSpan: { First: ago(2), Last: ago(1), Count: 8, CoveredThrough: 1 }, LatestEpisodeIndex: { Season: 2, Episode: 8 } }), null, null, { schedule: complete(ep('2026-10-20', 2, 8, null)) });
add('complete-season-missing-middle', season({ SeasonAddedSpan: { First: ago(2), Last: ago(1), Count: 7, CoveredThrough: 3 }, LatestEpisodeIndex: { Season: 2, Episode: 8 } }), null, null, { schedule: complete(ep('2026-10-20', 2, 8, null)) });
add('complete-season-later-season-airing', season({ SeasonAddedSpan: { First: ago(2), Last: ago(1), Count: 8, CoveredThrough: 8 }, LatestEpisodeIndex: { Season: 2, Episode: 8 } }), 'complete_season', 'Complete Season', { schedule: { ...complete(ep('2026-10-20', 3, 2, null), ep('2026-11-04', 3, 3, null)), seasonEpisodes: { 2: 8, 3: 8 } } });
// TMDB's final episode, not the library's latest: local S2E3 of an ended season whose finale is E10 is no finale.
add('series-finale-tmdb-identity', show({ LatestEpisodeIndex: { Season: 2, Episode: 3 } }), null, null, { schedule: schedule(ep('2026-10-29', 2, 10), null, 'Ended') });
add('episode-series-finale-tmdb-identity', episode({ EpisodeNumber: 3 }), 'new_episode', 'New Episode', { schedule: schedule(ep('2026-10-29', 2, 10), null, 'Ended'), parent: { LatestEpisodeIndex: { Season: 2, Episode: 3 }, LatestEpisodeAired: ago(2) } });
add('season-finale', season({ LatestEpisodeIndex: { Season: 2, Episode: 5, IsLast: true } }), 'season_finale', 'Season Finale', { schedule: schedule(ep('2026-10-29')) });
add('episode-finale', episode(), 'season_finale', 'Season Finale', { schedule: schedule(ep('2026-10-29')) });
add('series-finale', show({ LatestEpisodeIndex: { Season: 2, Episode: 5 } }), 'series_finale', 'Series Finale', { schedule: schedule(ep('2026-10-29'), null, 'Ended') });
add('episode-series-finale', episode(), 'series_finale', 'Series Finale', { schedule: schedule(ep('2026-10-29'), null, 'Ended') });
// A combined file (S02E04-E05) holds the final episode on its own card; its premiere identity stays E04.
add('combined-file-series-finale', episode({ EpisodeNumber: 4, EpisodeIndex: { Season: 2, Episode: 4, EpisodeEnd: 5, IsLast: true } }), 'series_finale', 'Series Finale', { schedule: schedule(ep('2026-10-29'), null, 'Ended') });
add('combined-file-season-finale', episode({ EpisodeNumber: 4, EpisodeIndex: { Season: 2, Episode: 4, EpisodeEnd: 5, IsLast: true } }), 'season_finale', 'Season Finale', { schedule: schedule(ep('2026-10-29')) });
add('combined-file-before-finale', episode({ EpisodeNumber: 3, EpisodeIndex: { Season: 2, Episode: 3, EpisodeEnd: 4 } }), 'new_episode', 'New Episode', { schedule: schedule(ep('2026-10-29'), null, 'Ended') });
add('combined-file-premiere', episode({ EpisodeNumber: 1, EpisodeIndex: { Season: 2, Episode: 1, EpisodeEnd: 2 } }), 'season_premiere', 'Season Premiere');
add('regular-finale-before-special', episode(), 'series_finale', 'Series Finale', { schedule: { ...schedule(ep('2026-10-29', 0, 1), null, 'Ended'), lastRegularAired: ep('2026-10-28') } });
add('parent-regular-aggregate-wins', episode(), 'series_finale', 'Series Finale', { parent: { LatestEpisodeIndex: { Season: 2, Episode: 5 }, LatestEpisodeAired: ago(2) }, schedule: { ...schedule(ep('2026-10-29', 0, 1), null, 'Ended'), seasonEpisodes: { 1: 8, 2: 5 } } });
// Without TMDB's counts the library's latest episode proves nothing.
add('parent-aggregate-needs-counts', episode(), 'new_episode', 'New Episode', { parent: { LatestEpisodeIndex: { Season: 2, Episode: 5 }, LatestEpisodeAired: ago(2) }, schedule: schedule(ep('2026-10-29', 0, 1), null, 'Ended') });
add('airing-today', show(), 'airing_today', 'Airing Today', { schedule: schedule(null, ep('2026-10-30')) });
add('tomorrow', show(), 'airs_date', 'Airs Tomorrow', { schedule: schedule(null, ep('2026-10-31')) });
add('weekday', show(), 'airs_date', 'Airs Sunday', { schedule: schedule(null, ep('2026-11-01')) });
add('airs-seven-days', show(), 'airs_date', 'Airs Nov 6', { schedule: schedule(null, ep('2026-11-06')) });
add('returns', show(), 'returns_date', 'Returns Nov 9', { schedule: schedule(ep('2026-09-01'), ep('2026-11-09')) });
add('returning', show({ Status: 'Continuing' }), 'returning', 'Returning', { settings: { StatusTagsSeriesStatus: true } });
add('ended', show({ Status: 'Ended' }), 'ended', 'Ended', { settings: { StatusTagsSeriesStatus: true } });
add('cancelled', show({ Status: 'Ended' }), 'cancelled', 'Cancelled', { settings: { StatusTagsSeriesStatus: true }, schedule: schedule(null, null, 'Canceled') });
add('series-status-off', show({ Status: 'Ended' }), null, null);
add('schedule-family-off', show(), null, null, { settings: { StatusTagsSchedule: false }, schedule: schedule(null, ep('2026-10-30')) });
add('milestone-family-off', season({ SeasonAddedSpan: { First: ago(1), Last: ago(1), Count: 2 } }), null, null, { settings: { StatusTagsMilestones: false } });
add('new-family-off', movie({ PremiereDate: ago(1) }), null, null, { settings: { StatusTagsNewRelease: false } });
add('added-family-off', movie({ DateCreated: ago(1) }), null, null, { settings: { StatusTagsJustAdded: false } });
add('release-window-boundary', movie({ PremiereDate: ago(30) }), 'new_movie', 'New Movie');
// Premiere dates are calendar days: 30 days ago is the last day of a 30-day window, 31 days ago is out.
add('release-window-expired', movie({ PremiereDate: ago(31) }), null, null);
add('admin-window', movie({ PremiereDate: ago(3) }), null, null, { plugin: { StatusTagsNewReleaseDays: 2 } });
add('added-clock-skew-limit', { Type: 'Video', DateCreated: now + day }, 'just_added', 'Just Added');
add('added-clock-skew-exceeded', { Type: 'Video', DateCreated: now + day + 1 }, null, null);
add('utc-midnight', show(), 'airing_today', 'Airing Today', { now: Date.UTC(2026, 9, 30, 23, 30), schedule: schedule(null, ep('2026-10-30')) });
add('perth-next-calendar-day', show(), 'airing_today', 'Airing Today', { now: Date.UTC(2026, 9, 30, 23, 30), zone: 'Australia/Perth', schedule: schedule(null, ep('2026-10-31')) });
add('new-york-before-midnight', show(), 'airing_today', 'Airing Today', { now: Date.UTC(2026, 10, 1, 3, 30), zone: 'America/New_York', schedule: schedule(null, ep('2026-10-31')) });
add('compact-corners-added', movie({ DateCreated: ago(1) }), 'just_added', 'Added', { settings: { TagLayoutSettingsVersion: 1, TagLayout: 'corners', TagLabelDensity: 'compact' } });
add('compact-corners-premiere', episode({ EpisodeNumber: 1 }), 'season_premiere', 'Premiere', { settings: { TagLayoutSettingsVersion: 1, TagLayout: 'corners', TagLabelDensity: 'compact' } });
add('compact-bands-premiere', episode({ EpisodeNumber: 1 }), 'season_premiere', 'Premiere', { settings: { TagLayoutSettingsVersion: 1, TagLayout: 'bands', TagLabelDensity: 'compact' } });
add('bands-profile-off', movie({ PremiereDate: ago(2) }), null, null, { settings: { TagLayoutSettingsVersion: 1, TagLayout: 'bands', TagLayouts: { Bands: { Groups: [{ Group: 'status', Slot: 'off' }] } } } });
add('german-weekday-locale', show(), 'airs_date', 'Airs Sonntag', { locale: 'de-DE', schedule: schedule(null, ep('2026-11-01')) });
add('french-weekday-locale', show(), 'airs_date', 'Airs dimanche', { locale: 'fr-FR', schedule: schedule(null, ep('2026-11-01')) });
add('new-york-before-dst-fallback', show(), 'airing_today', 'Airing Today', { now: Date.UTC(2026, 10, 1, 5, 30), zone: 'America/New_York', schedule: schedule(null, ep('2026-11-01')) });
add('new-york-after-dst-fallback', show(), 'airing_today', 'Airing Today', { now: Date.UTC(2026, 10, 1, 6, 30), zone: 'America/New_York', schedule: schedule(null, ep('2026-11-01')) });
// Leaving soon (Maintainerr or leaving collections): first match, local calendar days.
const leavingOn = { settings: { StatusTagsLeaving: true }, plugin: { LeavingSoonCollections: 'Leaving Soon' } };
const leaving = (deleteAt) => ({ Leaving: deleteAt === undefined ? {} : { DeleteAt: deleteAt } });
add('leaving-days', movie(leaving(now + 5 * day)), 'leaving_days', 'Leaving in 5d', leavingOn);
add('leaving-tomorrow', show(leaving(now + day)), 'leaving_tomorrow', 'Leaving tomorrow', leavingOn);
add('leaving-today-episode', episode(leaving(now + 3600000)), 'leaving_today', 'Leaving today', leavingOn);
add('leaving-undated-season', season(leaving()), 'leaving_soon', 'Leaving soon', leavingOn);
add('leaving-overdue', movie(leaving(now - day)), 'leaving_soon', 'Leaving soon', leavingOn);
add('leaving-before-trending', movie(leaving(now + 9 * day)), 'leaving_days', 'Leaving in 9d', { ...leavingOn, rank: 3 });
add('leaving-before-new-movie', movie({ ...leaving(now + 2 * day), PremiereDate: ago(2) }), 'leaving_days', 'Leaving in 2d', leavingOn);
add('leaving-family-off', movie(leaving(now + 5 * day)), null, null, { plugin: leavingOn.plugin });
add('leaving-without-source', movie(leaving(now + 5 * day)), null, null, { settings: leavingOn.settings });
add('leaving-not-on-collections', { Type: 'BoxSet', DateCreated: old, ...leaving(now + 5 * day) }, null, null, leavingOn);
add('leaving-perth-same-local-day', movie(leaving(Date.UTC(2026, 9, 31, 15, 30))), 'leaving_today', 'Leaving today', { ...leavingOn, now: Date.UTC(2026, 9, 30, 23, 30), zone: 'Australia/Perth' });
add('leaving-utc-next-day', movie(leaving(Date.UTC(2026, 9, 31, 15, 30))), 'leaving_tomorrow', 'Leaving tomorrow', { ...leavingOn, now: Date.UTC(2026, 9, 30, 23, 30) });
add('leaving-new-york-across-dst', movie(leaving(Date.UTC(2026, 10, 2, 5))), 'leaving_days', 'Leaving in 2d', { ...leavingOn, now: Date.UTC(2026, 10, 1, 3, 30), zone: 'America/New_York' });
add('leaving-compact-bands', movie(leaving(now + 5 * day)), 'leaving_days', '5d left', { plugin: leavingOn.plugin, settings: { ...leavingOn.settings, TagLayoutSettingsVersion: 1, TagLayout: 'bands', TagLabelDensity: 'compact' } });
add('leaving-german-falls-back-to-english', movie(leaving(now + 5 * day)), 'leaving_days', 'Leaving in 5d', { ...leavingOn, locale: 'de-DE' });
// Every shipped locale, plus Persian calendar boundaries; the six review cases stay literal below.
const dates = ['2026-01-04', '2026-03-20', '2026-03-21', '2026-10-04'];
for (const file of readdirSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/', import.meta.url)).filter(f => f.endsWith('.json'))) {
    const locale = file.slice(0, -5);
    const effective = Intl.DateTimeFormat.supportedLocalesOf(locale).length ? locale : 'en';
    for (const date of dates) {
        const instant = Date.parse(date + 'T00:00:00Z');
        const short = new Intl.DateTimeFormat(effective, {month:'short', day:'numeric', timeZone:'UTC'}).format(new Date(instant));
        add(`short-date-${locale}-${date}`, show(), 'returns_date', `Returns ${short}`, {
            now: instant - 14 * day, locale, schedule: schedule(ep(new Date(instant - 60 * day).toISOString().slice(0,10)), ep(date))
        });
    }
}
for (const [locale, short] of Object.entries({bg:'4.10', cs:'4. 10.', es:'4 oct', fa:'۱۲ مهر', fi:'4.10.', sk:'4. 10.'})) {
    add(`review-short-date-${locale}`, show(), 'returns_date', `Returns ${short}`, {
        now: Date.UTC(2026,8,20), locale, schedule: schedule(ep('2026-08-01'), ep('2026-10-04'))
    });
}
for (const locale of ['en-GB','en-AU','en-IN','en-CA','en-NZ','en-IE','en-ZA','es-MX','es-419','fr-CA','pt-BR','pt-PT','zh-TW','zh-HK', 'en-GB-u-ca-gregory', 'de-DE-u-co-phonebk']) {
    const short = new Intl.DateTimeFormat(locale, {month:'short', day:'numeric', timeZone:'UTC'}).format(new Date('2026-10-04T00:00:00Z'));
    add(`regional-short-date-${locale}`, show(), 'returns_date', `Returns ${short}`, {
        now: Date.UTC(2026,8,20), locale, schedule: schedule(ep('2026-08-01'), ep('2026-10-04'))
    });
}
export default rows;
