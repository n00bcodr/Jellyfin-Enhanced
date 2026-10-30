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
async function setup(t, { cache = false, cards = [aggregate, finale], parent = aggregate, parents = [], facts = schedule, parentResponse = null, scanCost = 0 } = {}) {
  const changes = new Map(), calls = [], idle = [], timers = new Map();
  let clock = 0, timerId = 0;
  /** Drive idle slices and their debounce timers in order, independent of CPU load. */
  const flush = async (ms = 0) => {
    const until = clock + ms;
    for (let steps = 0; steps < 10000; steps++) {
      // Let async fixture responses enqueue their continuation before deciding we are idle.
      await delay(0);
      if (idle.length) {
        idle.shift()({ timeRemaining: () => 50 });
        continue;
      }
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) { clock = until; return; }
      const [id, timer] = next;
      timers.delete(id);
      clock = timer.at;
      timer.run();
    }
    assert.fail('tag scheduler did not settle');
  };
  const items = new Map(cards.map(item => [item.Id, item]));
  if (parent) items.set(SERIES, parent);
  for (const item of parents) items.set(item.Id, item);
  let epoch = 0;
  const h = createHarness({
    html: cards.map(item => card(item.Id, item.Type)).join(''),
    globals: {
      setTimeout: (fn, ms = 0, ...args) => { const id = ++timerId; timers.set(id, { at: clock + ms, run: () => fn(...args) }); return id; },
      clearTimeout: id => timers.delete(id),
      requestIdleCallback: fn => idle.push(fn), IntersectionObserver: class {
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
        if (options.url.includes('/status-tags/series')) {
          const ids = new URL(options.url, 'http://jellyfin.test').searchParams.get('ids').split(',');
          return Object.fromEntries(ids.map(id => [id, facts]));
        }
        throw new Error(`Unexpected URL: ${options.url}`);
      }
    }
  });
  t.after(() => h.close());
  h.window.Date.now = () => NOW;
  if (scanCost) { let elapsed = 0; h.window.performance.now = () => (elapsed += scanCost); }
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'tags/tag-pipeline.js', 'tags/statustags.js']) h.load(file);
  h.JE.initializeStatusTags();
  h.JE.tagPipeline.initialize();
  await flush(500);
  return Object.assign(h, { calls, changes, idle, items, flush, key(id) { return h.document.querySelector(`[data-id="${id}"] .status-tag`)?.dataset.jeStatus ?? null; },
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
    assert.equal(h.key(EPISODE), 'newEpisode');
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
  await h.flush(10);
  assert.equal(h.JE.tagPipeline.peekItemFacts?.(SERIES) ?? null, null);
});


test('an episode hot-cache hit refreshes expired parent facts while its schedule is still fresh', async t => {
  const h = await setup(t, { cards: [finale] });
  assert.equal(h.key(EPISODE), 'series_finale');
  h.window.Date.now = () => NOW + 11 * 60 * 1000;
  h.JE.reinitializeStatusTags();
  while (h.idle.length) h.idle.shift()({ timeRemaining: () => 50 });
  await h.flush(60);
  assert.equal(h.key(EPISODE), 'series_finale');
  assert.equal(h.calls.filter(c => c.url.includes('/status-tags/series')).length, 1, 'schedule remains fresh');
});

for (const count of [30, 230]) {
  test(`expired parents on a ${count}-series episode-only page use bounded batches and one live pass per batch`, async t => {
    const parents = Array.from({ length: count }, (_, i) => ({ ...aggregate, Id: (i + 1).toString(16).padStart(32, '0') }));
    const episodes = parents.map((parent, i) => ({ ...finale, Id: (i + 1001).toString(16).padStart(32, '0'), SeriesId: parent.Id }));
    // Two cards for one episode also exercise parent-id deduplication.
    const h = await setup(t, { parent: null, parents, cards: [...episodes, episodes[0]], scanCost: 100 });
    assert.ok(episodes.every(item => h.key(item.Id) === 'series_finale'));
    if (count === 30) assert.equal(h.calls.filter(c => c.url.includes('/tag-data/')).length, 2, 'initial episodes and parent facts each use one batch');
    const initialRequests = h.calls.length;
    const ajax = h.window.ApiClient.ajax;
    let inFlight = 0, maxInFlight = 0;
    h.window.ApiClient.ajax = async options => {
      if (!options.url.includes('/tag-data/')) return ajax(options);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        await Promise.resolve();
        return await ajax(options);
      } finally { inFlight--; }
    };
    h.window.Date.now = () => NOW + 11 * 60 * 1000;
    h.JE.reinitializeStatusTags();
    while (h.idle.length) h.idle.shift()({ timeRemaining: () => 50 });
    let passes = 0;
    const querySelectorAll = h.document.querySelectorAll.bind(h.document);
    h.document.querySelectorAll = selector => {
      const nodes = querySelectorAll(selector);
      // Visibility checks iterate the list; a live recomputation walks it with forEach.
      if (selector === '[data-je-status-live]') {
        const forEach = nodes.forEach.bind(nodes);
        nodes.forEach = callback => { passes++; return forEach(callback); };
      }
      return nodes;
    };
    await h.flush(500);
    while (h.idle.length) {
      while (h.idle.length) h.idle.shift()({ timeRemaining: () => 50 });
      await h.flush(60);
    }
    const refreshed = h.calls.slice(initialRequests).filter(c => c.url.includes('/tag-data/'));
    assert.equal(refreshed.length, Math.ceil(count / 200), 'expired parents share the existing 200-id lookup batches');
    assert.ok(refreshed.every(c => JSON.parse(c.data).length <= 200), 'no request exceeds the pipeline limit');
    assert.equal(maxInFlight, 1, 'parent batches drain serially');
    const ids = refreshed.flatMap(c => JSON.parse(c.data));
    assert.equal(ids.length, parents.length, 'each parent is fetched exactly once');
    assert.deepEqual(new Set(ids), new Set(parents.map(item => item.Id)));
    assert.equal(passes, refreshed.length, 'one live recomputation per completed batch');
    assert.equal(h.calls.slice(initialRequests).filter(c => c.url.includes('/status-tags/series')).length, 0, 'schedules remain fresh');
    assert.ok(episodes.every(item => h.key(item.Id) === 'series_finale'));
  });
}

test('reinitialising during a parent refresh keeps one drain and recomputes the new cards', async t => {
  const h = await setup(t, { cards: [finale] });
  const response = deferred(), ajax = h.window.ApiClient.ajax;
  let requests = 0;
  h.window.ApiClient.ajax = async options => {
    if (options.url.includes('/tag-data/')) {
      requests++;
      await response.promise;
    }
    return ajax(options);
  };
  h.window.Date.now = () => NOW + 11 * 60 * 1000;
  h.JE.reinitializeStatusTags();
  while (h.idle.length) h.idle.shift()({ timeRemaining: () => 50 });
  await h.flush(50);
  assert.equal(requests, 1);
  h.JE.reinitializeStatusTags();
  while (h.idle.length) h.idle.shift()({ timeRemaining: () => 50 });
  await h.flush(50);
  assert.equal(requests, 1, 'cleanup must not open a second drain while the old one is in flight');
  response.resolve();
  await h.flush(100);
  assert.equal(requests, 1, 'the new drain reuses facts completed by the previous lifetime');
  assert.equal(h.key(EPISODE), 'series_finale', 'the current cards are recomputed after the stale completion');
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
  assert.equal(h.key(EPISODE), 'newEpisode');
  assert.equal(h.key(SERIES), 'newEpisode');
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
  await h.flush(200);
  assert.equal(batches().length, 1, 'a fresh snapshot needs no request and retains its age');
  h.window.Date.now = () => NOW + 11 * 60 * 1000;
  h.items.set(SERIES, { ...aggregate, LatestEpisodeIndex: { Season: 1, Episode: 11 } });
  h.JE.reinitializeStatusTags();
  while (h.idle.length) h.idle.shift()({ timeRemaining: () => 50 });
  assert.equal(h.JE.tagPipeline.peekItemFacts(SERIES), null, 'the old snapshot cannot renew expired facts');
  await h.flush(200);
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
