import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

const DAY = 24 * 60 * 60 * 1000;
// Friday 30 October 2026, 00:00 UTC (the harness runs in UTC).
const NOW = Date.UTC(2026, 9, 30);
const OLD = NOW - 400 * DAY;
const SERIES = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const en = JSON.parse(readFileSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json', import.meta.url), 'utf8'));
const translate = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), en[key] || key);
const card = id => `<div class="card" data-id="${id}"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div><div class="je-tag-host"></div></div><div class="cardText">Title</div></div></div>`;

/**
 * Status Tags over the real tag-renderer factory (and, with `layout`, the
 * layout controller), a fixed clock, and a /status-tags/series endpoint that
 * answers from `series` (TMDB facts per series id) and records each request.
 */
function setup(t, { settings = {}, plugin = {}, series = {}, cards = 2, layout = false, failSeries = false, autoIntersect = true, captureTimers = false, seriesAggregate = null, storedSeriesAggregate = null } = {}) {
  const renderers = new Map();
  const seriesCalls = [];
  const userChange = new Map();
  const observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); if (autoIntersect) queueMicrotask(() => this.callback([{ target, isIntersecting: true }])); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  const h = createHarness({
    html: Array.from({ length: cards }, (_, i) => card(`c${i}`)).join(''),
    globals: { IntersectionObserver: Observer },
    JE: {
      currentSettings: { statusTagsEnabled: true, statusTagsTrending: false, ...settings },
      pluginConfig: { StatusTagsEnabled: true, TmdbEnabled: true, TagCacheServerMode: true, ...plugin },
      t: translate,
      session: { getUserId: () => 'a', getServerId: () => 's', getEpoch: () => 0, isCurrent: () => true, onUserChange: (name, fn) => userChange.set(name, fn) },
      _cacheManager: { register() {}, markDirty() {} },
      tagPipeline: { tagStripRevision: () => 'none', registerRenderer: (name, r) => renderers.set(name, { ...r, render: (el,item,extras={}) => r.render(el,item,{stripRevision:'none',...extras}) }), getRenderer: name => renderers.get(name), peekServerEntry: id => id === SERIES ? seriesAggregate : null, lookupServerEntries: async () => { seriesAggregate ||= await storedSeriesAggregate; }, clearProcessed() {}, scheduleScan() {} }
    },
    apiClient: {
      getUrl: (path, params) => (params ? `${path}?${new URLSearchParams(params)}` : path),
      ajax: async ({ url }) => {
        if (url.includes('status-tags/trending')) return { source: null, movies: {}, series: {} };
        const ids = new URLSearchParams(url.split('?')[1]).get('ids').split(',');
        seriesCalls.push(ids);
        if (failSeries) throw new Error('down');
        if (typeof series === 'function') return series(ids, seriesCalls.length);
        return Object.fromEntries(ids.filter(id => series[id]).map(id => [id, series[id]]));
      }
    }
  });
  t.after(() => h.close());
  h.window.Date.now = () => NOW;
  const timers = new Map();
  if (captureTimers) {
    const set = h.window.setTimeout.bind(h.window);
    const clear = h.window.clearTimeout.bind(h.window);
    h.window.setTimeout = (fn, ms) => {
      if (ms < 1000) return set(fn, ms);
      const id = Symbol(); timers.set(id, { fn, ms }); return id;
    };
    h.window.clearTimeout = id => { if (!timers.delete(id)) clear(id); };
  }
  // Dates in English unless a test picks a language.
  h.document.documentElement.setAttribute('lang', 'en-US');
  const files = layout
    ? ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/status-vocabulary.js', 'tags/statustags.js']
    : ['core/ui-kit.js', 'core/tag-renderer-base.js', 'tags/status-vocabulary.js', 'tags/statustags.js'];
  for (const file of files) h.load(file);
  h.JE.initializeStatusTags();
  const hosts = [...h.document.querySelectorAll('.je-tag-host')];
  const renderer = renderers.get('status');
  return Object.assign(h, {
    hosts, seriesCalls, userChange, renderer, observers, timers,
    intersect(host, isIntersecting = true) { observers.forEach(o => o.callback([{ target: host, isIntersecting }])); },
    /** Render a server tag-cache entry into a card the way the pipeline does. */
    show(entry, host = hosts[0], id = 'item1') {
      delete host.closest('.card').dataset.jeStatusTagged;
      host.querySelectorAll('.status-overlay-container').forEach(n => n.remove());
      renderer.renderFromServerCache(host, entry, id);
      return host;
    },
    chip: (host = hosts[0]) => host.querySelector('.status-tag'),
    badge: (host = hosts[0]) => host.querySelector('.status-tag')?.textContent ?? null,
    key: (host = hosts[0]) => host.querySelector('.status-tag')?.dataset.jeStatus ?? null,
    /** Let the batched series request (30 ms) go out and its answer land. */
    flush: () => new Promise(resolve => setTimeout(resolve, 60))
  });
}

const movie = fields => ({ Type: 'Movie', TmdbId: '1', DateCreated: OLD, PremiereDate: OLD, ...fields });
const show = fields => ({ Type: 'Series', TmdbId: '100', DateCreated: OLD, PremiereDate: OLD, ...fields });
const season = fields => ({ Type: 'Season', SeriesId: SERIES, SeriesTmdbId: '100', SeasonNumber: 2, DateCreated: OLD, ...fields });
const episode = fields => ({ Type: 'Episode', SeriesId: SERIES, SeriesTmdbId: '100', SeasonNumber: 3, EpisodeNumber: 5, DateCreated: OLD, PremiereDate: OLD, ...fields });
const ago = days => NOW - days * DAY;
const facts = (fields = {}) => ({ status: 'Returning Series', lastAired: null, nextAired: null, ...fields });

/**
 * One row per rule: the entry, optional settings and TMDB facts for the
 * series, and the badge expected ([key, text], null for none, or
 * 'NOT_COMPLETE' for any badge but Complete Season).
 */
const ROWS = [
  // Movie: Trending → Coming Soon → New Movie → Just Added
  ['movie: coming soon', movie({ PremiereDate: NOW + 10 * DAY }), {}, null, ['coming_soon', 'Coming Soon']],
  ['movie: coming soon off with the schedule switch', movie({ PremiereDate: NOW + 10 * DAY }), { statusTagsSchedule: false }, null, null],
  ['movie: new movie', movie({ PremiereDate: ago(5) }), {}, null, ['newMovie', 'New Movie']],
  ['movie: just added', movie({ DateCreated: ago(1) }), {}, null, ['added', 'Just Added']],
  // Series: Trending → Airing Today → Series Finale → New Season → Airs → Returns → New Episode → Coming Soon → New Series → Just Added → status
  ['series: airing today', show(), {}, facts({ nextAired: { date: '2026-10-30', season: 2, episode: 3 } }), ['airing_today', 'Airing Today']],
  ['series: airing today off with the schedule switch', show(), { statusTagsSchedule: false }, facts({ nextAired: { date: '2026-10-30', season: 2, episode: 3 } }), null],
  ['series: series finale of an ended show, in the library', show({ LatestEpisodeIndex: { Season: 2, Episode: 8 } }), {},
    facts({ status: 'Ended', lastAired: { date: '2026-10-25', season: 2, episode: 8, type: 'finale' } }), ['series_finale', 'Series Finale']],
  ['series: no series finale before the library has it', show({ LatestEpisodeIndex: { Season: 2, Episode: 7 } }), {},
    facts({ status: 'Ended', lastAired: { date: '2026-10-25', season: 2, episode: 8, type: 'finale' } }), null],
  ['series: airing today beats the finale', show({ LatestEpisodeIndex: { Season: 2, Episode: 8 } }), {},
    facts({ status: 'Ended', lastAired: { date: '2026-10-25', season: 2, episode: 8 }, nextAired: { date: '2026-10-30', season: 3, episode: 1 } }), ['airing_today', 'Airing Today']],
  ['series: new season', show({ SeasonPremiere: { Season: 2, Aired: ago(10) } }), {}, null, ['new_season', 'New Season']],
  ['series: a first season is not a new season', show({ SeasonPremiere: { Season: 1, Aired: ago(10) } }), {}, null, null],
  ['series: new season off with the milestones switch', show({ SeasonPremiere: { Season: 2, Aired: ago(10) } }), { statusTagsMilestones: false }, null, null],
  ['series: new season beats airs', show({ SeasonPremiere: { Season: 2, Aired: ago(10) } }), {}, facts({ nextAired: { date: '2026-10-31', season: 2, episode: 3 } }), ['new_season', 'New Season']],
  ['series: airs tomorrow', show(), {}, facts({ nextAired: { date: '2026-10-31', season: 2, episode: 3 } }), ['airs_date', 'Airs Tomorrow']],
  ['series: airs on a weekday up to five days out', show(), {}, facts({ nextAired: { date: '2026-11-02', season: 2, episode: 3 } }), ['airs_date', 'Airs Monday']],
  ['series: airs on a short date six or seven days out', show(), {}, facts({ nextAired: { date: '2026-11-06', season: 2, episode: 3 } }), ['airs_date', 'Airs Nov 6']],
  ['series: returns after a break', show(), {}, facts({ lastAired: { date: '2026-06-01', season: 1, episode: 10 }, nextAired: { date: '2026-11-20', season: 2, episode: 1 } }), ['returns_date', 'Returns Nov 20']],
  ['series: no returns badge for a short gap', show(), {}, facts({ lastAired: { date: '2026-10-29', season: 2, episode: 2 }, nextAired: { date: '2026-11-08', season: 2, episode: 3 } }), null],
  ['series: no returns badge more than a month out', show(), {}, facts({ lastAired: { date: '2026-06-01', season: 1, episode: 10 }, nextAired: { date: '2026-12-15', season: 2, episode: 1 } }), null],
  ['series: new episode', show({ LatestEpisodeAdded: ago(1) }), {}, null, ['newEpisode', 'New Episode']],
  ['series: airs beats new episode', show({ LatestEpisodeAdded: ago(1) }), {}, facts({ nextAired: { date: '2026-10-31', season: 2, episode: 3 } }), ['airs_date', 'Airs Tomorrow']],
  ['series: coming soon', show({ PremiereDate: NOW + 20 * DAY }), {}, null, ['coming_soon', 'Coming Soon']],
  ['series: new series', show({ PremiereDate: ago(3) }), {}, null, ['newSeries', 'New Series']],
  ['series: just added', show({ DateCreated: ago(2) }), {}, null, ['added', 'Just Added']],
  ['series: status is off by default', show({ Status: 'Continuing' }), {}, null, null],
  ['series: returning from Jellyfin', show({ Status: 'Continuing' }), { statusTagsSeriesStatus: true }, null, ['returning', 'Returning']],
  ['series: ended from Jellyfin', show({ Status: 'Ended' }), { statusTagsSeriesStatus: true }, null, ['ended', 'Ended']],
  ['series: cancelled from TMDB over Jellyfin', show({ Status: 'Ended' }), { statusTagsSeriesStatus: true }, facts({ status: 'Canceled' }), ['cancelled', 'Cancelled']],
  ['series: status is the lowest priority', show({ Status: 'Ended', DateCreated: ago(1) }), { statusTagsSeriesStatus: true }, null, ['added', 'Just Added']],
  // Season: Complete Season → Season Premiere → Season Finale → New Episode → Just Added
  ['season: complete season (TMDB lists eight, all eight aired and in the library)', season({ SeasonAddedSpan: { First: ago(2), Last: ago(1), Count: 8, CoveredThrough: 8 }, LatestEpisodeIndex: { Season: 2, Episode: 8 }, LatestEpisodeAdded: ago(1) }), {},
    facts({ lastAired: { date: '2026-10-20', season: 2, episode: 8 }, seasonEpisodes: { 2: 8 } }), ['complete_season', 'Complete Season']],
  ['season: a later season airing also proves completion', season({ SeasonAddedSpan: { First: ago(6), Last: ago(1), Count: 2, CoveredThrough: 2 }, LatestEpisodeIndex: { Season: 2, Episode: 2 }, LatestEpisodeAdded: ago(1) }), {},
    facts({ lastAired: { date: '2026-10-20', season: 3, episode: 4 }, nextAired: { date: '2026-11-06', season: 3, episode: 5 }, seasonEpisodes: { 2: 2, 3: 8 } }), ['complete_season', 'Complete Season']],
  ['season: a verified one episode season', season({ SeasonAddedSpan: { First: ago(1), Last: ago(1), Count: 1, CoveredThrough: 1 }, LatestEpisodeIndex: { Season: 2, Episode: 1 }, DateCreated: ago(1) }), {},
    facts({ status: 'Ended', lastAired: { date: '2026-10-01', season: 2, episode: 1 }, seasonEpisodes: { 2: 1 } }), ['complete_season', 'Complete Season']],
  ['season: no completion claim without TMDB facts', season({ SeasonAddedSpan: { First: ago(2), Last: ago(1), Count: 8 }, LatestEpisodeIndex: { Season: 2, Episode: 8 }, LatestEpisodeAdded: ago(1) }), {}, null, 'NOT_COMPLETE'],
  ['season: one of ten episodes is not complete', season({ SeasonAddedSpan: { First: ago(1), Last: ago(1), Count: 1 }, LatestEpisodeIndex: { Season: 2, Episode: 1 }, DateCreated: ago(1) }), {},
    facts({ status: 'Ended', lastAired: { date: '2026-10-01', season: 2, episode: 10 }, seasonEpisodes: { 2: 10 } }), 'NOT_COMPLETE'],
  ['season: a known future episode in the season is not complete', season({ SeasonAddedSpan: { First: ago(2), Last: ago(1), Count: 3 }, LatestEpisodeIndex: { Season: 2, Episode: 3 }, LatestEpisodeAdded: ago(1) }), {},
    facts({ lastAired: { date: '2026-10-28', season: 2, episode: 3 }, nextAired: { date: '2026-11-05', season: 2, episode: 4 }, seasonEpisodes: { 2: 3 } }), 'NOT_COMPLETE'],
  ['season: a duplicate cannot stand in for a missing episode', season({ SeasonAddedSpan: { First: ago(2), Last: ago(1), Count: 10, CoveredThrough: 1 }, LatestEpisodeIndex: { Season: 2, Episode: 10 }, LatestEpisodeAdded: ago(1) }), {},
    facts({ lastAired: { date: '2026-10-20', season: 2, episode: 10 }, seasonEpisodes: { 2: 10 } }), 'NOT_COMPLETE'],
  ['season: a missing middle episode is not complete', season({ SeasonAddedSpan: { First: ago(2), Last: ago(1), Count: 7, CoveredThrough: 1 }, LatestEpisodeIndex: { Season: 2, Episode: 8 }, LatestEpisodeAdded: ago(1) }), {},
    facts({ lastAired: { date: '2026-10-20', season: 2, episode: 8 }, seasonEpisodes: { 2: 8 } }), 'NOT_COMPLETE'],
  ['season: season premiere', season({ SeasonPremiere: { Season: 2, Aired: ago(10) } }), {}, null, ['season_premiere', 'Season Premiere']],
  ['season: season finale (TMDB episode type)', season({ LatestEpisodeIndex: { Season: 2, Episode: 10 } }), {},
    facts({ lastAired: { date: '2026-10-28', season: 2, episode: 10, type: 'finale' }, nextAired: { date: '2027-03-01', season: 3, episode: 1 } }), ['season_finale', 'Season Finale']],
  ['season: no finale for a standard episode', season({ LatestEpisodeIndex: { Season: 2, Episode: 10 } }), {},
    facts({ lastAired: { date: '2026-10-28', season: 2, episode: 10, type: 'standard' } }), null],
  ['season: finale fallback without a type: nothing more scheduled', season({ LatestEpisodeIndex: { Season: 2, Episode: 10, IsLast: true } }), {},
    facts({ lastAired: { date: '2026-10-28', season: 2, episode: 10 } }), ['season_finale', 'Season Finale']],
  ['season: no fallback finale while the season continues', season({ LatestEpisodeIndex: { Season: 2, Episode: 10 } }), {},
    facts({ lastAired: { date: '2026-10-28', season: 2, episode: 10 }, nextAired: { date: '2026-11-04', season: 2, episode: 11 } }), null],
  ['season: an old finale is not news', season({ LatestEpisodeIndex: { Season: 2, Episode: 10 } }), {},
    facts({ lastAired: { date: '2026-01-28', season: 2, episode: 10, type: 'finale' } }), null],
  ['season: new episode', season({ LatestEpisodeAdded: ago(1) }), {}, null, ['newEpisode', 'New Episode']],
  // Episode: Season Premiere → Series/Season Finale → New Episode → Just Added
  ['episode: season premiere', episode({ EpisodeNumber: 1, PremiereDate: ago(2) }), {}, null, ['season_premiere', 'Season Premiere']],
  ['episode: a special is not a premiere', episode({ SeasonNumber: 0, EpisodeNumber: 1, PremiereDate: ago(2) }), {}, null, ['newEpisode', 'New Episode']],
  ['episode: an ended show special is never its series finale', episode({ SeasonNumber: 0, EpisodeNumber: 8, PremiereDate: ago(2) }), {},
    facts({ status: 'Ended', lastAired: { date: '2026-10-28', season: 0, episode: 8, type: 'standard' } }), ['newEpisode', 'New Episode']],
  ['series: a special cannot supply its series finale', show({ LatestEpisodeIndex: { Season: 0, Episode: 8 } }), {},
    facts({ status: 'Ended', lastAired: { date: '2026-10-28', season: 0, episode: 8, type: 'standard' } }), null],
  ['episode: the final regular episode can be standard on an ended show', episode({ EpisodeNumber: 10, PremiereDate: ago(2) }), {},
    facts({ status: 'Ended', lastAired: { date: '2026-10-28', season: 3, episode: 10, type: 'standard' } }), ['series_finale', 'Series Finale']],
  ['episode: series finale', episode({ EpisodeNumber: 10, PremiereDate: ago(2) }), {},
    facts({ status: 'Ended', lastAired: { date: '2026-10-28', season: 3, episode: 10, type: 'finale' } }), ['series_finale', 'Series Finale']],
  ['episode: season finale', episode({ EpisodeNumber: 10, PremiereDate: ago(2) }), {},
    facts({ lastAired: { date: '2026-10-28', season: 3, episode: 10, type: 'finale' } }), ['season_finale', 'Season Finale']],
  ['episode: a guarded episode (no air date) gets no finale', episode({ EpisodeNumber: 10, PremiereDate: null }), {},
    facts({ status: 'Ended', lastAired: { date: '2026-10-28', season: 3, episode: 10, type: 'finale' } }), null],
  ['episode: new episode by air date', episode({ PremiereDate: ago(2) }), {}, null, ['newEpisode', 'New Episode']],
  ['episode: new episode by added date', episode({ DateCreated: ago(1) }), {}, null, ['newEpisode', 'New Episode']],
  ['episode: just added when release badges are off', episode({ DateCreated: ago(1) }), { statusTagsNewRelease: false }, null, ['added', 'Just Added']],
  ['season: no fallback finale without a local last episode', season({ LatestEpisodeIndex: { Season: 2, Episode: 10, IsLast: false } }), {},
    facts({ lastAired: { date: '2026-10-28', season: 2, episode: 10 } }), null],
  ['episode: no fallback finale without a local last episode', episode({ PremiereDate: ago(2), EpisodeIndex: { Season: 3, Episode: 5, IsLast: false } }), {},
    facts({ lastAired: { date: '2026-10-28', season: 3, episode: 5 } }), ['newEpisode', 'New Episode']],
  ['episode: future air date is not a premiere', episode({ EpisodeNumber: 1, PremiereDate: NOW + 2 * DAY }), {}, null, null],
  ['series: future season premiere is not a new season', show({ SeasonPremiere: { Season: 2, Aired: NOW + 2 * DAY } }), {}, null, null],
  ['series: Jellyfin continuing is authoritative', show({ Status: 'Continuing' }), { statusTagsSeriesStatus: true }, facts({ status: 'Ended' }), ['returning', 'Returning']],
  // Others: Just Added only
  ['boxset: just added', { Type: 'BoxSet', DateCreated: ago(1) }, {}, null, ['added', 'Just Added']],
  ['boxset: no release badges', { Type: 'BoxSet', DateCreated: OLD, PremiereDate: ago(1) }, {}, null, null],
];

for (const [name, entry, settings, seriesFacts, expected] of ROWS) {
  test(`badge rule: ${name}`, async t => {
    const h = setup(t, { settings, series: seriesFacts ? { [SERIES]: seriesFacts } : {} });
    // A Series is its own series; seasons and episodes name theirs.
    const id = entry.Type === 'Series' ? SERIES : 'item1';
    h.show(entry, h.hosts[0], id);
    await h.flush();
    // NOT_COMPLETE: whatever badge follows, never a completion claim.
    if (expected === 'NOT_COMPLETE') return assert.notEqual(h.chip() ? h.key() : null, 'complete_season');
    assert.deepEqual(h.chip() ? [h.key(), h.badge()] : null, expected);
    if (expected) assert.ok(h.chip().classList.contains('status-tag'));
  });
}

test('chips carry their kind as a modifier class and their compact label', async t => {
  const h = setup(t, { series: { [SERIES]: facts({ nextAired: { date: '2026-10-30', season: 1, episode: 2 } }) } });
  h.show(show(), h.hosts[0], SERIES);
  await h.flush();
  assert.ok(h.chip().classList.contains('status-tag--schedule'));
  assert.equal(h.chip().dataset.jeCompact, 'Today');
  h.show(season({ SeasonPremiere: { Season: 2, Aired: ago(3) } }), h.hosts[1]);
  assert.ok(h.chip(h.hosts[1]).classList.contains('status-tag--milestone'));
  assert.equal(h.chip(h.hosts[1]).dataset.jeCompact, 'Premiere');
  h.show(show({ Status: 'Ended' }), h.hosts[1], 'other');
  assert.equal(h.chip(h.hosts[1]), null);
});

test('compact density swaps in the short labels; full density keeps the long ones', async t => {
  const expected = [
    [season({ SeasonPremiere: { Season: 2, Aired: ago(3) } }), 'Season Premiere', 'Premiere'],
    [season({ SeasonAddedSpan: { First: ago(1), Last: ago(1), Count: 6, CoveredThrough: 6 }, LatestEpisodeIndex: { Season: 2, Episode: 6 } }), 'Complete Season', 'Complete'],
    [movie({ PremiereDate: NOW + 3 * DAY }), 'Coming Soon', 'Soon'],
    [movie({ DateCreated: ago(1) }), 'Just Added', 'Added'],
    [season({ LatestEpisodeAdded: ago(1) }), 'New Episode', 'New Ep'],
    [movie({ PremiereDate: ago(2) }), 'New Movie', 'New Movie'],
  ];
  for (const density of ['full', 'compact']) {
    const h = setup(t, { layout: true, settings: { tagLayoutSettingsVersion: 1, tagLabelDensity: density },
      series: { [SERIES]: facts({ lastAired: { date: '2026-10-20', season: 2, episode: 6 }, seasonEpisodes: { 2: 6 } }) } });
    for (const [entry, full, compact] of expected) {
      h.show(entry);
      await h.flush(); // the series facts Complete Season needs
      assert.equal(h.badge(), density === 'full' ? full : compact, `${density}: ${full}`);
    }
    h.close();
  }
});

test('finale chips shorten to "Finale" in compact density', async t => {
  const h = setup(t, {
    layout: true, settings: { tagLayoutSettingsVersion: 1, tagLabelDensity: 'compact' },
    series: { [SERIES]: facts({ status: 'Ended', lastAired: { date: '2026-10-28', season: 3, episode: 10, type: 'finale' } }) }
  });
  h.show(episode({ EpisodeNumber: 10, PremiereDate: ago(2) }));
  await h.flush();
  assert.equal(h.key(), 'series_finale');
  assert.equal(h.badge(), 'Finale');
});

test('air dates follow the user locale: the Jellyfin display language first, then the JE setting', async t => {
  const answer = { [SERIES]: facts({ nextAired: { date: '2026-11-02', season: 1, episode: 2 } }) };
  const h = setup(t, { settings: { displayLanguage: 'de' }, series: answer });
  h.show(show(), h.hosts[0], SERIES);
  await h.flush();
  assert.equal(h.badge(), 'Airs Montag');
  h.window.localStorage.setItem('a-language', 'fr');
  h.show(show(), h.hosts[0], SERIES);
  assert.equal(h.badge(), 'Airs lundi');
});

test('series schedules are fetched in one batch per 50 visible series, then not again within the hour', async t => {
  const ids = Array.from({ length: 60 }, (_, i) => `${String(i).padStart(2, '0')}${'b'.repeat(30)}`);
  const h = setup(t, { cards: 60, series: Object.fromEntries(ids.map(id => [id, facts({ nextAired: { date: '2026-10-30', season: 1, episode: 2 } })])) });
  ids.forEach((id, i) => h.show(show({ TmdbId: String(i + 1) }), h.hosts[i], id));
  assert.equal(h.badge(h.hosts[0]), null, 'drawn before the answer: no schedule badge yet');
  await h.flush();
  assert.deepEqual(h.seriesCalls.map(batch => batch.length), [50, 10], 'capped at 50 ids per request');
  assert.equal(h.badge(h.hosts[0]), 'Airing Today', 'the cards on the page are re-badged when the answer lands');
  assert.equal(h.badge(h.hosts[59]), 'Airing Today');

  h.window.Date.now = () => NOW + 59 * 60 * 1000;
  h.show(show(), h.hosts[0], ids[0]);
  await h.flush();
  assert.equal(h.seriesCalls.length, 2, 'no refetch within the TTL');
  assert.equal(h.badge(h.hosts[0]), 'Airing Today', 'drawn straight from the facts in hand');

  h.window.Date.now = () => NOW + 61 * 60 * 1000;
  h.show(show(), h.hosts[0], ids[0]);
  await h.flush();
  assert.deepEqual(h.seriesCalls.at(-1), [ids[0]], 'expired: asked again');
});

test('seasons and episodes ask for their series once; a series without a TMDB id is never asked about', async t => {
  const h = setup(t, { cards: 3 });
  h.show(season({ LatestEpisodeIndex: { Season: 2, Episode: 1 } }), h.hosts[0], 's1');
  h.show(episode(), h.hosts[1], 'e1');
  h.show(season({ SeriesId: 'cccccccccccccccccccccccccccccccc', SeriesTmdbId: null }), h.hosts[2], 's2');
  await h.flush();
  assert.deepEqual(h.seriesCalls, [[SERIES]]);
});

test('no series lookups without a TMDB key, with Status Tags off for the server, or with every reading switch off', async t => {
  for (const [plugin, settings] of [[{ TmdbEnabled: false }, {}], [{ StatusTagsEnabled: false }, {}], [{}, { statusTagsSchedule: false, statusTagsMilestones: false }]]) {
    const h = setup(t, { plugin, settings });
    h.show(show(), h.hosts[0], SERIES);
    await h.flush();
    assert.deepEqual(h.seriesCalls, [], JSON.stringify({ plugin, settings }));
    h.close();
  }
});

test('a failed series lookup keeps the library badge and is retried after 5 minutes', async t => {
  const h = setup(t, { failSeries: true });
  h.allowConsoleError(/series schedules/);
  h.show(show({ LatestEpisodeAdded: ago(1) }), h.hosts[0], SERIES);
  await h.flush();
  assert.equal(h.badge(), 'New Episode');
  h.window.Date.now = () => NOW + 4 * 60 * 1000;
  h.show(show({ LatestEpisodeAdded: ago(1) }), h.hosts[0], SERIES);
  await h.flush();
  assert.equal(h.seriesCalls.length, 1);
  h.window.Date.now = () => NOW + 6 * 60 * 1000;
  h.show(show({ LatestEpisodeAdded: ago(1) }), h.hosts[0], SERIES);
  await h.flush();
  assert.equal(h.seriesCalls.length, 2);
});

test('a schedule answer does not redraw a card whose record went stale, nor one from before a user switch', async t => {
  const answer = facts({ nextAired: { date: '2026-10-30', season: 1, episode: 2 } });
  const h = setup(t, { series: () => {
    h.renderer.onServerCacheRefresh([SERIES]);
    return { [SERIES]: answer };
  } });
  h.show(show(), h.hosts[0], SERIES);
  await h.flush();
  assert.equal(h.badge(), null, 'replaced by a delta: left for the pipeline to render again');
  h.show(show(), h.hosts[0], SERIES);
  assert.equal(h.badge(), 'Airing Today', 'rendered again: drawn from the facts in hand');

  const other = 'dddddddddddddddddddddddddddddddd';
  h.show(show(), h.hosts[1], other);
  h.userChange.get('status-tags')();
  await h.flush();
  assert.equal(h.badge(h.hosts[1]), null, 'the answer for the previous user is dropped');
  h.show(show(), h.hosts[0], SERIES);
  await h.flush();
  assert.equal(h.seriesCalls.at(-1)?.[0], SERIES, 'the incoming user asks again');
});

test('series lookups key on normalised ids whatever form the card and the server use', async t => {
  const dashed = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA';
  const h = setup(t, { series: { [SERIES]: facts({ nextAired: { date: '2026-10-31', season: 1, episode: 2 } }) } });
  h.show(episode({ SeriesId: dashed, EpisodeNumber: 2 }), h.hosts[0], 'e1');
  await h.flush();
  assert.deepEqual(h.seriesCalls, [[SERIES]]);
});

test('the /tag-data fallback reads the same facts (episode numbers from IndexNumber/ParentIndexNumber)', async t => {
  const h = setup(t, { series: { [SERIES]: facts({ status: 'Ended', lastAired: { date: '2026-10-28', season: 3, episode: 10 }, seasonEpisodes: { 3: 10 } }) } });
  h.renderer.render(h.hosts[0], { Id: 'e1', Type: 'Episode', SeriesId: SERIES, ParentIndexNumber: 3, IndexNumber: 10, DateCreated: OLD, PremiereDate: new Date(ago(2)).toISOString() });
  await h.flush();
  assert.equal(h.key(), 'series_finale');
  h.renderer.render(h.hosts[1], { Id: 's9', Type: 'Season', SeriesId: SERIES, IndexNumber: 3, DateCreated: OLD, SeasonAddedSpan: { First: ago(1), Last: ago(1), Count: 10, CoveredThrough: 10 },
    LatestEpisodeIndex: { Season: 3, Episode: 10 } });
  assert.equal(h.key(h.hosts[1]), 'complete_season');
  // The fallback cache keeps every fact: a cache hit draws the same badge.
  h.hosts[1].querySelector('.status-overlay-container').remove();
  delete h.hosts[1].closest('.card').dataset.jeStatusTagged;
  assert.equal(h.renderer.renderFromCache(h.hosts[1], 's9'), true);
  assert.equal(h.key(h.hosts[1]), 'complete_season');
});

test('fallback cache entries from before the new facts are refetched', t => {
  const h = setup(t);
  const store = JSON.parse(h.window.localStorage.getItem('JellyfinEnhanced-statusTagsCache') || '{}');
  store.old = { t: 'Season', timestamp: NOW, c: OLD, l: ago(1) };
  h.window.localStorage.setItem('JellyfinEnhanced-statusTagsCache', JSON.stringify(store));
  h.JE.initializeStatusTags();
  assert.equal(h.renderer.renderFromCache(h.hosts[0], 'old'), false);
});


test('a schedule answer cannot badge a recycled card identity', async t => {
  const h = setup(t, { series: { [SERIES]: facts({ nextAired: { date: '2026-10-30', season: 1, episode: 2 } }) } });
  h.show(show(), h.hosts[0], SERIES);
  h.hosts[0].closest('.card').dataset.id = 'another-item';
  await h.flush();
  assert.equal(h.badge(), null);
});

test('a filtered cache entry with no episode aggregates cannot recreate milestone badges', async t => {
  const h = setup(t, { series: { [SERIES]: facts({ lastAired: { date: '2026-10-28', season: 2, episode: 10 } }) } });
  h.show(season({ LatestEpisodeAdded: null, LatestEpisodeAired: null, LatestEpisodeIndex: null, SeasonPremiere: null, SeasonAddedSpan: null }));
  await h.flush();
  assert.equal(h.badge(), null);
});


test('cache replacement guards compare dashed and compact item ids equally', async t => {
  const h = setup(t, { series: { [SERIES]: facts({ nextAired: { date: '2026-10-30', season: 1, episode: 2 } }) } });
  h.show(show(), h.hosts[0], 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA');
  h.renderer.onServerCacheRefresh([SERIES]);
  await h.flush();
  assert.equal(h.badge(), null);
});


test('one schedule observer gates offscreen, detached and recycled cards, including queued dispatch', async t => {
  const h = setup(t, { cards: 4, autoIntersect: false });
  const ids = Array.from({ length: 4 }, (_, i) => String(i + 1).repeat(32));
  ids.forEach((id, i) => h.show(show(), h.hosts[i], id));
  await h.flush();
  assert.deepEqual(h.seriesCalls, [], 'offscreen cards produce no schedule request');
  assert.equal(h.observers.length, 1, 'one observer shared by all cards');
  h.intersect(h.hosts[0]);
  h.intersect(h.hosts[1]);
  h.intersect(h.hosts[1], false);
  h.hosts[2].remove();
  h.intersect(h.hosts[2]);
  h.hosts[3].closest('.card').dataset.id = 'recycled';
  h.intersect(h.hosts[3]);
  await h.flush();
  assert.deepEqual(h.seriesCalls, [[ids[0]]], 'only a connected, visible, current identity is dispatched');
  h.intersect(h.hosts[1]);
  await h.flush();
  assert.deepEqual(h.seriesCalls.at(-1), [ids[1]], 'scrolling into view dispatches the deferred lookup');
});


test('a per-id upstream retry marker preserves prior facts and schedules a five-minute retry', async t => {
  let now = NOW;
  const timers = new Map();
  const h = setup(t, { series: (ids, call) => Object.fromEntries(ids.map(id => [id, call === 1
    ? facts({ nextAired: { date: '2026-10-31', season: 1, episode: 2 } }) : { retry: true }])) });
  const originalSetTimeout = h.window.setTimeout.bind(h.window);
  h.window.setTimeout = (fn, ms) => {
    if (ms >= 5 * 60 * 1000 && ms <= 60 * 60 * 1000) { const id = Symbol(); timers.set(id, { fn, ms }); return id; }
    return originalSetTimeout(fn, ms);
  };
  h.window.clearTimeout = id => timers.delete(id);
  h.window.Date.now = () => now;
  h.show(show(), h.hosts[0], SERIES);
  await h.flush();
  assert.equal(h.badge(), 'Airs Tomorrow');
  now += 61 * 60 * 1000;
  h.show(show(), h.hosts[0], SERIES);
  await h.flush();
  assert.equal(h.badge(), 'Airs Tomorrow', 'a retry marker must keep the previous schedule');
  const retry = [...timers.values()].find(timer => timer.ms === 5 * 60 * 1000);
  assert.ok(retry, 'one timer is armed for the five-minute retry');
  now += 5 * 60 * 1000;
  retry.fn();
  await h.flush();
  assert.equal(h.seriesCalls.length, 3, 'retry runs without another card render');
});


for (const trigger of ['midnight', 'visible', 'focus', 'identical lookup']) {
  test(`schedule labels advance to the local day on ${trigger}`, async t => {
    const h = setup(t, { captureTimers: true, series: { [SERIES]: facts({ nextAired: { date: '2026-10-31', season: 1, episode: 2 } }) } });
    h.show(show(), h.hosts[0], SERIES);
    await h.flush();
    assert.equal(h.badge(), 'Airs Tomorrow');
    h.window.Date.now = () => NOW + DAY;
    if (trigger === 'midnight') {
      const nextMidnight = new h.window.Date(NOW);
      nextMidnight.setHours(24, 0, 0, 0);
      const midnight = [...h.timers.values()].find(timer => timer.ms === nextMidnight.getTime() - NOW);
      assert.ok(midnight, 'one timer is armed to the next local midnight');
      h.timers.clear();
      midnight.fn();
      assert.equal(h.timers.size, 1, 'midnight timer is rearmed');
    } else if (trigger === 'visible') h.document.dispatchEvent(new h.window.Event('visibilitychange'));
    else if (trigger === 'focus') h.window.dispatchEvent(new h.window.Event('focus'));
    else {
      // Same card remains rendered; the observer dispatches a fresh lookup of identical facts.
      h.intersect(h.hosts[0]);
      await h.flush();
    }
    assert.equal(h.badge(), 'Airing Today', 'the card updates without rendering again');
  });
}

for (const type of ['Series', 'Episode']) {
  test(`final regular ${type} remains a series finale when TMDB latest is a special`, async t => {
    const aggregate = show({ LatestEpisodeIndex: { Season: 1, Episode: 10 }, LatestEpisodeAired: ago(2), LatestEpisodeAdded: ago(1) });
    // TMDB's counts prove S1E10 ends the show.
    const h = setup(t, { seriesAggregate: aggregate, series: { [SERIES]: facts({ status: 'Ended',
      lastAired: { date: '2026-10-29', season: 0, episode: 8, type: 'standard' }, seasonEpisodes: { 1: 10 } }) } });
    h.show(type === 'Series' ? aggregate : episode({ SeasonNumber: 1, EpisodeNumber: 10, PremiereDate: ago(2) }), h.hosts[0], type === 'Series' ? SERIES : 'final');
    h.show(episode({ SeasonNumber: 0, EpisodeNumber: 8, PremiereDate: ago(1) }), h.hosts[1], 'special');
    await h.flush();
    assert.equal(h.key(), 'series_finale');
    assert.equal(h.key(h.hosts[1]), 'newEpisode', 'the special is never a finale');
  });
}

test('a recent special cannot freshen an old final regular episode', async t => {
  const aggregate = show({ LatestEpisodeIndex: { Season: 1, Episode: 10 }, LatestEpisodeAired: OLD });
  const h = setup(t, { seriesAggregate: aggregate, series: { [SERIES]: facts({ status: 'Ended',
    lastAired: { date: '2026-10-29', season: 0, episode: 8, type: 'standard' } }) } });
  h.show(aggregate, h.hosts[0], SERIES);
  h.show(episode({ SeasonNumber: 1, EpisodeNumber: 10, PremiereDate: OLD }), h.hosts[1], 'final');
  await h.flush();
  assert.equal(h.key(), null);
  assert.equal(h.key(h.hosts[1]), null);
});

test('an episode-only page resolves its final regular episode from the confirmed stored parent aggregate', async t => {
  const h = setup(t, { storedSeriesAggregate: Promise.resolve(show({
    LatestEpisodeIndex: { Season: 1, Episode: 10 }, LatestEpisodeAired: ago(2) })),
    series: { [SERIES]: facts({ status: 'Ended', lastAired: { date: '2026-10-29', season: 0, episode: 8 }, seasonEpisodes: { 1: 10 } }) } });
  h.show(episode({ SeasonNumber: 1, EpisodeNumber: 10, PremiereDate: ago(2) }));
  await h.flush();
  assert.equal(h.key(), 'series_finale');
});

for (const operation of ['remove', 'reuse', 'movie', 'user switch', 'cleanup', 'reinitialise', 'initialise']) {
  test(`schedule observer releases targets on ${operation}`, async t => {
    const h = setup(t, { autoIntersect: false });
    const host = h.hosts[0];
    h.show(show(), host, SERIES);
    h.intersect(host);
    assert.equal(h.observers[0].targets.size, 1);
    if (operation === 'remove') host.closest('.card').remove();
    else if (operation === 'reuse') host.closest('.card').dataset.id = 'next';
    else if (operation === 'movie') h.show(movie(), host, 'movie');
    else if (operation === 'user switch') h.userChange.get('status-tags')();
    else if (operation === 'cleanup') h.renderer.cleanup?.();
    else if (operation === 'reinitialise') h.JE.reinitializeStatusTags();
    else h.JE.initializeStatusTags();
    await Promise.resolve();
    assert.ok(h.observers.every(observer => observer.targets.size === 0), 'no retained observer target');
    if (operation !== 'remove') {
      h.show(show(), host, SERIES);
      await h.flush();
      assert.deepEqual(h.seriesCalls, [], 'released cards need a fresh intersection before dispatch');
      h.intersect(host);
      await h.flush();
      assert.deepEqual(h.seriesCalls, [[SERIES]], 'active cards can be observed again');
    }
  });
}

test('late observer callbacks cannot reintroduce released intersection membership', async t => {
  const h = setup(t, { autoIntersect: false });
  h.show(show(), h.hosts[0], SERIES);
  const old = h.observers[0];
  h.userChange.get('status-tags')();
  h.show(show(), h.hosts[0], SERIES);
  old.callback([{ target: h.hosts[0], isIntersecting: true }]);
  await h.flush();
  assert.deepEqual(h.seriesCalls, []);
  assert.equal(h.observers.length, 2, 'user switch disconnects and recreates lazily');
  assert.equal(old.targets.size, 0);
});

test('rendering another series into a host resets its previous intersection', async t => {
  const h = setup(t, { autoIntersect: false });
  h.show(show(), h.hosts[0], SERIES);
  h.intersect(h.hosts[0]);
  h.show(show(), h.hosts[0], 'other');
  await h.flush();
  assert.deepEqual(h.seriesCalls, []);
  h.intersect(h.hosts[0]);
  await h.flush();
  assert.deepEqual(h.seriesCalls, [['other']]);
});

for (const operation of ['user switch', 'pagehide', 'cleanup', 'disabled reinitialise']) {
  test(`midnight and retry timers stop on ${operation} and restart on initialisation`, async t => {
    const h = setup(t, { captureTimers: true, series: { [SERIES]: { retry: true } } });
    h.show(show(), h.hosts[0], SERIES);
    await h.flush();
    assert.equal(h.timers.size, 2, 'midnight plus one schedule retry');
    if (operation === 'user switch') h.userChange.get('status-tags')();
    else if (operation === 'pagehide') h.window.dispatchEvent(new h.window.Event('pagehide'));
    else if (operation === 'cleanup') h.renderer.cleanup();
    else { h.JE.currentSettings.statusTagsEnabled = false; h.JE.reinitializeStatusTags(); }
    assert.equal(h.timers.size, 0, 'all date/schedule timers cleared');
    h.window.dispatchEvent(new h.window.Event('focus'));
    h.document.dispatchEvent(new h.window.Event('visibilitychange'));
    assert.equal(h.timers.size, 0, 'return events do not restart an inactive renderer');
    h.JE.currentSettings.statusTagsEnabled = true;
    h.JE.initializeStatusTags();
    assert.equal(h.timers.size, 1, 'exactly one midnight timer after reinitialisation');
    h.show(show(), h.hosts[0], SERIES);
    await h.flush();
    assert.equal(h.timers.size, 2, 'retry timer rearmed for the active card');
  });
}

for (const operation of ['user switch', 'pagehide', 'cleanup']) {
  test(`queued schedule flush is cancelled on ${operation}`, async t => {
    const h = setup(t, { autoIntersect: false });
    const cleared = [];
    const clear = h.window.clearTimeout.bind(h.window);
    h.window.clearTimeout = id => { cleared.push(id); clear(id); };
    h.show(show(), h.hosts[0], SERIES);
    h.intersect(h.hosts[0]);
    if (operation === 'user switch') h.userChange.get('status-tags')();
    else if (operation === 'pagehide') h.window.dispatchEvent(new h.window.Event('pagehide'));
    else h.renderer.cleanup();
    assert.equal(cleared.length, 2, 'pending batch and midnight timer explicitly cancelled');
    await h.flush();
    assert.deepEqual(h.seriesCalls, []);
  });
}

test('pagehide drops late schedule answers and pageshow resumes with a fresh lifecycle', async t => {
  let answer;
  const h = setup(t, { captureTimers: true, series: () => new Promise(resolve => { answer = resolve; }) });
  h.show(show(), h.hosts[0], SERIES);
  await h.flush();
  h.window.dispatchEvent(new h.window.Event('pagehide'));
  answer({ [SERIES]: { retry: true } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.timers.size, 0, 'late answer cannot restart timers');
  h.window.dispatchEvent(new h.window.Event('pageshow'));
  assert.equal(h.timers.size, 1, 'bfcache return rearms midnight');
});
