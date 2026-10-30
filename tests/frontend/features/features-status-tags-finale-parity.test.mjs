import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarness, deferred } from '../helpers/harness.mjs';

const SERIES = 'a'.repeat(32), EPISODE = 'b'.repeat(32), SEASON = 'c'.repeat(32);
const DAY = 86400000, NOW = Date.UTC(2026, 9, 30), OLD = NOW - 400 * DAY;
const en = JSON.parse(readFileSync(new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json', import.meta.url)));
const aggregate = { Id: SERIES, Type: 'Series', TmdbId: '100', ProviderIds: { Tmdb: '100' }, DateCreated: OLD,
  LatestEpisodeIndex: { Season: 1, Episode: 10 }, LatestEpisodeAired: NOW - 2 * DAY, LatestEpisodeAdded: NOW - DAY };
const finale = { Id: EPISODE, Type: 'Episode', SeriesId: SERIES, SeriesTmdbId: '100', ParentIndexNumber: 1,
  IndexNumber: 10, SeasonNumber: 1, EpisodeNumber: 10, PremiereDate: NOW - 2 * DAY, DateCreated: NOW - DAY };
const schedule = { status: 'Ended', lastAired: { date: '2026-10-29', season: 0, episode: 8 } };
const card = (id, type) => `<div class="card" data-id="${id}" data-type="${type}"><div class="cardScalable"><div class="cardImageContainer"></div><div class="cardOverlayContainer"></div></div></div>`;

/** Real pipeline + renderer, with only the HTTP boundaries replaced by caller-filtered fixtures. */
async function setup(t, { cache = false, cards = [aggregate, finale], parent = aggregate, facts = schedule, parentResponse = null } = {}) {
  const changes = new Map(), calls = [], idle = [];
  const items = new Map(cards.map(item => [item.Id, item]));
  if (parent) items.set(SERIES, parent);
  let epoch = 0;
  const h = createHarness({
    html: cards.map(item => card(item.Id, item.Type)).join(''),
    globals: { requestIdleCallback: fn => idle.push(fn), IntersectionObserver: class {
      constructor(fn) { this.fn = fn; } observe(target) { queueMicrotask(() => this.fn([{ target, isIntersecting: true }])); }
      unobserve() {} disconnect() {}
    } },
    JE: {
      currentSettings: { statusTagsEnabled: true, statusTagsTrending: false },
      pluginConfig: { StatusTagsEnabled: true, TmdbEnabled: true, TagCacheServerMode: cache },
      t: key => en[key] || key,
      _cacheManager: { register() {}, markDirty() {} },
      helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} },
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => epoch,
        isCurrent: e => e === epoch, onUserChange: (key, fn) => changes.set(key, fn) }
    },
    apiClient: {
      getUrl: (path, params) => `${path}${params ? '?' + new URLSearchParams(params) : ''}`,
      getItem: async (_, id) => items.get(id) || null,
      ajax: async options => {
        calls.push(options);
        if (options.url.includes('/tag-cache/')) return { items: Object.fromEntries(items), count: items.size, version: 1, timestamp: 1, filterRevision: 'caller' };
        if (options.url.includes('/tag-data/')) {
          const ids = JSON.parse(options.data);
          if (parentResponse && ids.length === 1 && ids[0] === SERIES) return parentResponse.promise;
          return { Items: ids.map(id => items.get(id)).filter(Boolean) };
        }
        if (options.url.includes('/status-tags/series')) return { [SERIES]: facts };
        throw new Error(`Unexpected URL: ${options.url}`);
      }
    }
  });
  t.after(() => h.close());
  h.window.Date.now = () => NOW;
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'tags/tag-pipeline.js', 'tags/statustags.js']) h.load(file);
  h.JE.initializeStatusTags();
  h.JE.tagPipeline.initialize();
  await delay(0);
  while (idle.length) idle.shift()({ timeRemaining: () => 50 });
  await delay(240);
  return Object.assign(h, { calls, changes, idle, items, key(id) { return h.document.querySelector(`[data-id="${id}"] .status-tag`)?.dataset.jeStatus ?? null; },
    switchUser() { epoch++; for (const fn of changes.values()) fn({ userId: 'user-b' }); } });
}

for (const cache of [false, true]) {
  test(`series and final regular episode agree with server cache ${cache ? 'on' : 'off'}`, async t => {
    // Episode first proves the batch preloads parent facts before any renderer runs.
    const h = await setup(t, { cache, cards: [finale, aggregate] });
    assert.equal(h.key(SERIES), 'series_finale');
    assert.equal(h.key(EPISODE), 'series_finale');
    const batches = h.calls.filter(c => c.url.includes('/tag-data/'));
    assert.equal(batches.length, cache ? 0 : 1, 'an already fetched parent needs no extra request');
    if (!cache) assert.match(batches[0].url, /latestEpisode=true/);
  });
  test(`episode-only page resolves caller-filtered parent with cache ${cache ? 'on' : 'off'}`, async t => {
    const h = await setup(t, { cache, cards: [finale] });
    assert.equal(h.key(EPISODE), 'series_finale');
    if (!cache) assert.ok(h.calls.some(c => c.url.includes('/tag-data/') && JSON.parse(c.data).includes(SERIES)));
  });
}

for (const parent of [null, { ...aggregate, LatestEpisodeAired: null, LatestEpisodeIndex: null }]) {
  test(`batch finale cannot use an ${parent ? 'aggregate-stripped' : 'inaccessible'} parent`, async t => {
    const h = await setup(t, { cards: [finale], parent });
    assert.equal(h.key(EPISODE), 'new_episode');
  });
}

test('library aggregate precedes a different regular TMDB last episode', async t => {
  const h = await setup(t, { facts: { status: 'Ended', lastAired: { date: '2026-10-29', season: 1, episode: 11 } } });
  assert.equal(h.key(SERIES), 'series_finale');
  assert.equal(h.key(EPISODE), 'series_finale');
});

test('season enrichment precedes the local season aggregate when the series aggregate is absent', async t => {
  const season = { ...aggregate, Id: SEASON, Type: 'Season', SeriesId: SERIES, IndexNumber: 1,
    LatestEpisodeIndex: { Season: 1, Episode: 9 } };
  const h = await setup(t, { cards: [finale, season], parent: null,
    facts: { ...schedule, lastRegularAired: { date: '2026-10-28', season: 1, episode: 10 } } });
  assert.equal(h.key(EPISODE), 'series_finale');
});

test('a fetched local season aggregate is the final fallback', async t => {
  const season = { ...aggregate, Id: SEASON, Type: 'Season', SeriesId: SERIES, IndexNumber: 1 };
  const h = await setup(t, { cards: [finale, season], parent: null });
  assert.equal(h.key(EPISODE), 'series_finale');
});

test('a parent response arriving after user change cannot populate the facts store', async t => {
  const response = deferred();
  const h = await setup(t, { cards: [finale], parentResponse: response });
  h.switchUser();
  response.resolve({ Items: [aggregate] });
  await delay(10);
  assert.equal(h.JE.tagPipeline.peekItemFacts?.(SERIES) ?? null, null);
});


test('an episode hot-cache hit refreshes expired parent facts while its schedule is still fresh', async t => {
  const h = await setup(t, { cards: [finale] });
  assert.equal(h.key(EPISODE), 'series_finale');
  h.window.Date.now = () => NOW + 11 * 60 * 1000;
  h.JE.reinitializeStatusTags();
  while (h.idle.length) h.idle.shift()({ timeRemaining: () => 50 });
  await delay(60);
  assert.equal(h.key(EPISODE), 'series_finale');
  assert.equal(h.calls.filter(c => c.url.includes('/status-tags/series')).length, 1, 'schedule remains fresh');
});

test('cache invalidation cannot reuse the previous parent aggregate', async t => {
  const h = await setup(t, { cards: [finale] });
  assert.equal(h.JE.tagPipeline.peekItemFacts(SERIES)?.LatestEpisodeIndex.Episode, 10);
  h.JE.currentSettings.statusTagsEnabled = false;
  await h.JE.tagPipeline.invalidateServerCache();
  assert.equal(h.JE.tagPipeline.peekItemFacts(SERIES), null);
});


test('live recomputation refreshes the series snapshot from authoritative parent facts', async t => {
  const h = await setup(t);
  assert.equal(h.key(SERIES), 'series_finale');
  assert.equal(h.key(EPISODE), 'series_finale');
  // A corrected library aggregate identifies E11, outside the finale window.
  // E10 remains newly added; the series must use the same corrected aggregate.
  h.JE.tagPipeline.rememberItemFacts({ ...aggregate,
    LatestEpisodeIndex: { Season: 1, Episode: 11 }, LatestEpisodeAired: NOW - 40 * DAY });
  h.window.dispatchEvent(new h.window.Event('focus'));
  assert.equal(h.key(EPISODE), 'new_episode');
  assert.equal(h.key(SERIES), 'new_episode');
  // Stripped/replaced facts must also clear the matching snapshot fields.
  h.JE.tagPipeline.rememberItemFacts({ Id: SERIES, Type: 'Series' });
  h.window.dispatchEvent(new h.window.Event('focus'));
  assert.equal(h.key(SERIES), null);
});


test('a series hot-cache redraw fetches expired facts in the existing card batch', async t => {
  const h = await setup(t, { facts: {} });
  const batches = () => h.calls.filter(c => c.url.includes('/tag-data/'));
  assert.equal(batches().length, 1);
  h.window.Date.now = () => NOW + 5 * 60 * 1000;
  h.JE.reinitializeStatusTags();
  while (h.idle.length) h.idle.shift()({ timeRemaining: () => 50 });
  await delay(200);
  assert.equal(batches().length, 1, 'a fresh snapshot needs no request and retains its age');
  h.window.Date.now = () => NOW + 11 * 60 * 1000;
  h.items.set(SERIES, { ...aggregate, LatestEpisodeIndex: { Season: 1, Episode: 11 } });
  h.JE.reinitializeStatusTags();
  while (h.idle.length) h.idle.shift()({ timeRemaining: () => 50 });
  assert.equal(h.JE.tagPipeline.peekItemFacts(SERIES), null, 'the old snapshot cannot renew expired facts');
  await delay(200);
  assert.equal(batches().length, 2, 'expiry queues one normal /tag-data batch without a schedule lookup');
  assert.deepEqual(JSON.parse(batches()[1].data), [SERIES], 'fresh episode snapshots need no refetch');
  assert.equal(h.JE.tagPipeline.peekItemFacts(SERIES).LatestEpisodeIndex.Episode, 11);
});


test('a cached projection retains its original fetch timestamp when restoring parent facts', async t => {
  const h = await setup(t, { cards: [] });
  const pipeline = h.JE.tagPipeline;
  h.window.Date.now = () => NOW + 5 * 60 * 1000;
  pipeline.rememberItemFacts(aggregate, SERIES, NOW);
  assert.equal(pipeline.peekItemFacts(SERIES).LatestEpisodeIndex.Episode, 10);
  pipeline.rememberItemFacts({ ...aggregate, LatestEpisodeIndex: { Season: 1, Episode: 11 } }, SERIES, NOW - 1000);
  assert.equal(pipeline.peekItemFacts(SERIES).LatestEpisodeIndex.Episode, 10, 'older cached facts cannot replace newer facts');
  h.window.Date.now = () => NOW + 11 * 60 * 1000;
  pipeline.rememberItemFacts(aggregate, SERIES, NOW);
  assert.equal(pipeline.peekItemFacts(SERIES), null, 'restoring the snapshot never extends the fetch TTL');
});
