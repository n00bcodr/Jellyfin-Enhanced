import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../../helpers/harness.mjs';

// Regressions for the defects found while moving the tag runtime to TypeScript. Each drives the
// emitted production scripts, so a mistaken source edit or a stale build fails here.

const DAY = 24 * 60 * 60 * 1000;
const OLD = Date.now() - 400 * DAY;
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const card = id => `<div class="card" data-id="${id}" data-type="Movie"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div><div class="cardOverlayContainer"></div></div></div></div>`;

/** Status + direct play over a stub pipeline, with idle slices and timers driven by hand. */
function statusPage(t, { settings = {}, plugin = {}, store, cards = 2, stored } = {}) {
  const renderers = new Map();
  const requests = [];
  const idle = [];
  const timers = new Map();
  let timerId = 0;
  class Observer {
    constructor(callback) { this.callback = callback; }
    observe(target) { this.callback([{ target, isIntersecting: true }]); }
    unobserve() {}
    disconnect() {}
  }
  const h = createHarness({
    html: Array.from({ length: cards }, (_, i) => card(`c${i}`)).join(''),
    globals: {
      IntersectionObserver: Observer,
      requestIdleCallback: fn => { idle.push(fn); return idle.length; },
      setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
      clearTimeout: id => { timers.delete(id); },
    },
    JE: {
      currentSettings: { statusTagsEnabled: true, statusTagsTrending: false, statusTagsDirectPlay: true, ...settings },
      pluginConfig: { StatusTagsEnabled: true, TmdbEnabled: false, TagCacheServerMode: true, ...plugin },
      t: key => key,
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} },
      tagCacheStore: store,
      tagPipeline: { tagStripRevision: () => 'none', registerRenderer: (name, r) => renderers.set(name, r), getRenderer: name => renderers.get(name), clearProcessed() {}, scheduleScan() {} },
      core: { ui: { injectCss() {}, removeCss() {} } },
    },
    apiClient: { getUrl: (path, params) => (params ? `${path}?${new URLSearchParams(params)}` : path) },
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ MediaSources: [{ Id: 's', SupportsDirectPlay: false, TranscodeReasons: ['VideoCodecNotSupported'] }] }) };
    },
  });
  t.after(() => h.close());
  if (stored) {
    h.window.localStorage.setItem('JellyfinEnhanced-statusTagsCache', JSON.stringify(stored));
    h.window.localStorage.setItem('JellyfinEnhanced-statusTagsCache:identity-owner', 'server-a:user-a');
  }
  for (const file of ['core/tag-renderer-base.js', 'tags/status-vocabulary.js', 'tags/tag-direct-play.js', 'tags/statustags.js']) h.load(file);
  h.JE.initializeStatusTags();
  const slices = async () => {
    for (let i = 0; i < 8; i++) {
      await settle();
      for (const fn of idle.splice(0)) fn({ timeRemaining: () => 50, didTimeout: false });
    }
    await settle();
  };
  const fire = delay => {
    for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); }
  };
  const hosts = [...h.document.querySelectorAll('.cardScalable')];
  return { ...h, renderer: () => renderers.get('status'), requests, slices, fire, hosts };
}

test('TAG-RUNTIME-003: a cached redraw never asks PlaybackInfo about a .strm item or an unprobed one', async t => {
  const h = statusPage(t);
  const items = [
    { Id: 'strm', Type: 'Movie', Path: 'Film.strm', DateCreated: OLD, PremiereDate: OLD, MediaStreams: [{ Type: 'Video' }] },
    { Id: 'bare', Type: 'Movie', Path: 'Film.mkv', DateCreated: OLD, PremiereDate: OLD, MediaStreams: [{ Type: 'Audio' }] },
  ];
  for (const item of items) h.renderer().render(h.hosts[0], item, { stripRevision: 'none' });
  await h.slices();
  assert.deepEqual(h.requests, [], 'the fetched item is not probed');
  for (const item of items) {
    assert.equal(h.renderer().renderFromCache(h.hosts[1], item.Id), true, `${item.Id} is a fallback hit`);
    await h.slices();
    h.JE.tagDirectPlay.untrack(h.hosts[1]);
  }
  assert.deepEqual(h.requests, [], 'neither is probed from the cached copy');
});

test('TAG-RUNTIME-003: a status entry stored in an older shape is a miss, so it cannot skip the checks that shape lacks', async t => {
  const entry = version => ({ older: { v: 1, stripRevision: 'none', timestamp: Date.now(),
    payload: { v: version, t: 'Movie', timestamp: Date.now(), c: OLD, p: OLD } } });
  const plugin = { TagCacheServerMode: false };
  const current = statusPage(t, { plugin, stored: entry(6) });
  assert.equal(current.renderer().renderFromCache(current.hosts[0], 'older'), true, 'the current shape is a hit');
  const previous = statusPage(t, { plugin, stored: entry(5) });
  assert.equal(previous.renderer().renderFromCache(previous.hosts[0], 'older'), false, 'version 5 is read as unknown');
});

test('TAG-RUNTIME-003: a cached redraw keeps the version the user picked', async t => {
  const h = statusPage(t);
  h.JE.selectedMediaSource = () => 'version-b';
  const item = { Id: 'multi', Type: 'Movie', Path: 'a.mkv', DateCreated: OLD, PremiereDate: OLD,
    MediaStreams: [{ Type: 'Video', SourceId: 'version-a' }, { Type: 'Video', SourceId: 'version-b' }], MediaSources: [{ Id: 'version-a', Path: 'a.mkv' }, { Id: 'version-b', Path: 'b.mkv' }] };
  h.renderer().render(h.hosts[0], item, { stripRevision: 'none' });
  h.JE.tagDirectPlay.untrack(h.hosts[0]);
  assert.equal(h.renderer().renderFromCache(h.hosts[1], 'multi'), true);
  await h.slices();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.MediaSourceId, 'version-b', 'asks about the picked version, not the default');
});

test('a null source stays part of the media key that stored verdicts are filed under', async t => {
  const puts = [];
  const store = { available: () => true, getDirectPlay: async () => new Map(), putDirectPlay: async (scope, hash, values) => { puts.push(...values); } };
  const h = statusPage(t, { store, cards: 2 });
  const source = { Id: 'one', Path: 'one.mkv', Revision: 'r1' };
  const movie = (id, MediaSources) => ({ Id: id, Type: 'Movie', Path: `${id}.mkv`, DateCreated: OLD, PremiereDate: OLD, MediaStreams: [{ Type: 'Video' }], MediaSources });
  h.renderer().render(h.hosts[0], movie('clean', [source]), { stripRevision: 'none' });
  h.renderer().render(h.hosts[1], movie('holed', [null, source]), { stripRevision: 'none' });
  await h.slices();
  h.fire(2000);
  await h.slices();
  const media = name => puts.find(([id]) => id.endsWith(name))?.[1].m;
  assert.equal(typeof media('clean'), 'string', `stored ${JSON.stringify(puts)}`);
  assert.equal(typeof media('holed'), 'string', `stored ${JSON.stringify(puts)}`);
  assert.notEqual(media('holed'), media('clean'));
});

test('TAG-RUNTIME-004: answers landing after a reset survive the retired persist timer', async t => {
  const puts = [];
  const store = {
    available: () => true,
    getDirectPlay: async () => new Map(),
    putDirectPlay: async (scope, hash, values) => { puts.push([...values.keys()]); },
  };
  const h = statusPage(t, { store });
  const movie = id => ({ Id: id, Type: 'Movie', Path: `${id}.mkv`, DateCreated: OLD, PremiereDate: OLD, MediaStreams: [{ Type: 'Video' }] });
  h.renderer().render(h.hosts[0], movie('first'), { stripRevision: 'none' });
  await h.slices();
  assert.equal(h.requests.length, 1);
  h.JE.tagDirectPlay.reset();
  h.renderer().render(h.hosts[1], movie('second'), { stripRevision: 'none' });
  await h.slices();
  assert.equal(h.requests.length, 2);
  h.fire(2000); // The timer armed before the reset.
  h.fire(2000); // Its replacement, for this session's answers.
  await h.slices();
  assert.ok(puts.flat().some(id => id.endsWith('second')), `stored ${JSON.stringify(puts)}`);
});

test('TAG-RUNTIME-005: a review batch settling after a user switch draws nothing', async t => {
  let epoch = 1;
  let answer;
  const h = createHarness({
    html: card('reviewed'),
    JE: {
      currentSettings: { ratingTagsEnabled: true },
      pluginConfig: { ShowUserReviews: true, ShowUserRatingOnPosters: true },
      session: { getEpoch: () => epoch, isCurrent: value => value === epoch, onUserChange() {} },
      core: {
        ui: { injectCss() {} },
        api: { plugin: () => new Promise(resolve => { answer = resolve; }) },
      },
    },
  });
  t.after(() => h.close());
  h.load('tags/userreviewtags.js');
  const host = h.document.querySelector('.cardScalable');
  h.JE.appendUserRatingToContainer(host, { Type: 'Movie', ProviderIds: { Tmdb: '7' } });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(typeof answer, 'function', 'the batch went out');
  epoch = 2; // The transport ignored the abort: its answer still arrives.
  answer({ ratings: { 'movie:7': { average: 4 } } });
  await settle();
  assert.equal(h.document.querySelector('.je-userreview-tag'), null, "the previous viewer's rating is not drawn");
});

function storedCopyPage(t, { ajax, storedMeta = { version: 3, filterRevision: 'old', servedAt: 45 } }) {
  const reads = [];
  const stored = new Map([['item', { Type: 'Movie', Genres: ['Stale'] }]]);
  const h = createHarness({
    apiClient: { getCurrentUserId: () => 'user-a', ajax },
    JE: {
      pluginConfig: { TagCacheServerMode: true }, currentSettings: { genreTagsEnabled: true },
      helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} },
      core: { tagRenderer: { applyCornerStacking() {}, scheduleCornerStacking() {} } },
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      tagCacheStore: {
        ENTRY_SCHEMA: 10,
        available: () => true,
        getMeta: async () => ({ scope: 'server-a:user-a', version: 3, timestamp: 40, filterRevision: 'old', count: 1, clearStamp: 0, servedAt: 45, savedAt: 1, schema: 10, entrySchema: 10 }),
        getMany: async () => { reads.push('getMany'); return { entries: stored, meta: storedMeta }; },
        clearScope: async () => {}, clearOtherScopes: async () => {},
        beginFullWrite: async () => false, putManyIfOwner: async () => false, commitFullWrite: async () => false, applyDelta: async () => true,
      },
    },
    globals: { requestIdleCallback: () => {} },
  });
  t.after(() => h.close());
  h.load('tags/tag-pipeline.js');
  return { ...h, reads };
}

test('TAG-RUNTIME-006: an unconfirmed stored copy stays unreadable when its replacement never arrives', async t => {
  const h = storedCopyPage(t, {
    ajax: async ({ url }) => (url.includes('since=')
      ? { items: {}, version: 4, timestamp: 50, filterRevision: 'new' } // The copy is out of date...
      : null), // ...and the full download brings nothing.
  });
  h.JE.tagPipeline.initialize();
  await settle();
  const entries = await h.JE.tagPipeline.lookupServerEntries(['item']);
  assert.equal(entries.size, 0, 'nothing from a strip that was never confirmed');
  assert.deepEqual(h.reads, [], 'the copy is not even read');
});

test('TAG-RUNTIME-006: a copy the delta confirms still serves its entries', async t => {
  const h = storedCopyPage(t, { ajax: async () => ({ items: {}, version: 3, timestamp: 50, filterRevision: 'old' }) });
  h.JE.tagPipeline.initialize();
  await settle();
  const entries = await h.JE.tagPipeline.lookupServerEntries(['item']);
  assert.deepEqual(entries.get('item').Genres, ['Stale']);
});

for (const [change, storedMeta] of [
  ['rewrote it under another filter', { version: 3, filterRevision: 'other', servedAt: 45 }],
  ['moved it to another cache generation', { version: 4, filterRevision: 'old', servedAt: 45 }],
  ['is rewriting it', { version: 3, filterRevision: 'old', servedAt: 45, pending: 'token' }],
  ['restored an older capture', { version: 3, filterRevision: 'old', servedAt: 44 }],
]) test(`entries are not used once another tab ${change}`, async t => {
  const h = storedCopyPage(t, { storedMeta, ajax: async () => ({ items: {}, version: 3, timestamp: 50, filterRevision: 'old' }) });
  h.JE.tagPipeline.initialize();
  await settle();
  const entries = await h.JE.tagPipeline.lookupServerEntries(['item']);
  assert.equal(h.reads.length, 1, 'the copy was read');
  assert.equal(entries.size, 0);
});

test('TAG-RUNTIME-007: a cached card under pending Spoiler Guard state still gets its rating after the rescan', async t => {
  let loaded = true;
  const renderers = new Map();
  const h = createHarness({
    html: card('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    JE: {
      currentSettings: { ratingTagsEnabled: true },
      pluginConfig: { SpoilerBlurEnabled: true, ShowUserReviews: true, ShowUserRatingOnPosters: true, TagCacheServerMode: true },
      t: key => key,
      cdn: { url: (bucket, file) => `/${bucket}/${file}`, flagSvg: code => `/flags/${code}.svg` },
      spoilerBlur: { isLoaded: () => loaded, isLoadOk: () => loaded, isEnabledFor: () => false, getUserPrefs: () => ({}) },
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      tagPipeline: { tagStripRevision: () => 'none', registerRenderer: (name, r) => renderers.set(name, r), getRenderer: name => renderers.get(name),
        peekReviewRatings: () => new Map(), getReviewRatingsRequestedAt: () => 1, clearProcessed() {}, scheduleScan() {} },
      core: { ui: { injectCss() {}, removeCss() {} } },
    },
  });
  t.after(() => h.close());
  for (const file of ['core/tag-renderer-base.js', 'core/media-language.js', 'tags/rating-sources.js', 'tags/ratingtags.js', 'tags/userreviewtags.js']) h.load(file);
  h.JE.initializeRatingTags();
  h.JE.initializeUserReviewTags();
  const renderer = renderers.get('rating');
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const scratch = h.document.createElement('div');
  h.document.body.append(scratch);
  renderer.render(scratch, { Id: id, Type: 'Series', CommunityRating: 8.1, ProviderIds: { Tmdb: '9' } }, { stripRevision: 'none' });
  const host = h.document.querySelector('.card .cardScalable');
  loaded = false;
  assert.equal(renderer.renderFromCache(host, id), true);
  assert.equal(host.querySelector('.rating-overlay-container'), null, 'nothing is drawn while the state loads');
  loaded = true;
  assert.equal(renderer.renderFromCache(host, id), true);
  assert.ok(host.querySelector('.rating-tag:not(.je-userreview-tag)'), 'the rescan draws the rating');
});

test('a stored copy is only reused while nothing is stripped for this user', t => {
  const id = 'c0000000000000000000000000000000';
  const stored = new Map([['JellyfinEnhanced-testTagsCache:identity-owner', 'server-a:user-a'],
    ['JellyfinEnhanced-testTagsCache', JSON.stringify({ [id]: { v: 1, stripRevision: 'guard-1', payload: { genres: ['Plot'] }, timestamp: Date.now() } })]]);
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)), removeItem: key => stored.delete(key), key: index => [...stored.keys()][index] ?? null, get length() { return stored.size; } };
  const renderers = new Map();
  const h = createHarness({
    globals: {},
    JE: {
      currentSettings: { testEnabled: true }, pluginConfig: { TagCacheServerMode: false },
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} },
      tagPipeline: { tagStripRevision: () => 'guard-1', registerRenderer: (name, r) => renderers.set(name, r), getRenderer: name => renderers.get(name) },
      core: { ui: { injectCss() {} } },
    },
  });
  t.after(() => h.close());
  Object.defineProperty(h.window, 'localStorage', { configurable: true, value: storage });
  h.load('core/tag-renderer-base.js');
  const ctx = h.JE.core.tagRenderer.register('test', {
    logPrefix: 'test', settingKey: 'testEnabled', containerClass: 'test-container', taggedAttr: 'jeTestTagged',
    cache: { key: 'JellyfinEnhanced-testTagsCache', legacyPrefix: 'testTagsCache', hotBucket: 'test' },
    pipeline: { render() {} },
  });
  assert.equal(ctx.getPersistent(id), undefined, 'a page load under a strip fetches again');
  ctx.deletePersistent('other');
});

test('a card recycled for another item while its answer was on the way never shows that answer', async t => {
  const A = 'a0000000000000000000000000000000';
  const B = 'b0000000000000000000000000000000';
  const drawn = [];
  let observe;
  let answerEpisode;
  const h = createHarness({
    html: card(A),
    globals: { requestIdleCallback: fn => { fn({ timeRemaining: () => 50, didTimeout: true }); return 1; } },
    apiClient: {
      getCurrentUserId: () => 'user-a',
      ajax: ({ url, data }) => {
        if (url.includes('/tag-cache/')) return Promise.resolve({ items: {}, count: 0, version: 1, timestamp: 1 });
        if (JSON.parse(data).includes(A)) return Promise.resolve({ Items: [{ Id: A, Type: 'Series', FirstEpisode: { Id: 'e', NeedsStreamFetch: true } }], StripRevision: 'none' });
        return new Promise(resolve => { answerEpisode = resolve; });
      },
    },
    JE: {
      pluginConfig: { TagCacheServerMode: false }, currentSettings: { genreTagsEnabled: true },
      helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} },
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      core: { tagRenderer: { applyCornerStacking() {}, scheduleCornerStacking() {} }, dom: { createObserver: (name, callback) => { observe = callback; } } },
    },
  });
  t.after(() => h.close());
  h.load('tags/tag-pipeline.js');
  h.JE.tagPipeline.registerRenderer('genre', { render: (el, item) => drawn.push(item.Id), renderFromCache: () => false, isEnabled: () => true, needsFirstEpisode: true });
  h.JE.tagPipeline.initialize();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(typeof answerEpisode, 'function', 'the first episode is being looked up');
  const element = h.document.querySelector('.card');
  element.setAttribute('data-id', B);
  observe([{ target: element, attributeName: 'data-id', oldValue: A }]);
  answerEpisode({ Items: [{ Id: 'e', Type: 'Episode' }] });
  await settle();
  assert.deepEqual(drawn, [], "the old item's tags stay off the recycled card");
});

test('TAG-RUNTIME-008: a native shell profile without codec rules still takes the width limit', async t => {
  const h = statusPage(t, { cards: 1 });
  h.window.localStorage.setItem('maxVideoWidth', '1920');
  h.window.localStorage.setItem('limitSupportedVideoResolution', 'true');
  h.window.NativeShell = { AppHost: { getDeviceProfile: () => Promise.resolve({ DirectPlayProfiles: [] }) } };
  h.JE.tagDirectPlay.setProfile(null);
  h.JE.tagDirectPlay.profile();
  await settle();
  const limits = (h.JE.tagDirectPlay.profile().CodecProfiles || []).flatMap(profile => profile.Conditions.map(condition => `${condition.Property}:${condition.Value}`));
  assert.ok(limits.includes('Width:1920'), `limits ${JSON.stringify(limits)}`);
});

test('a delta answered after the cache was replaced never lands in the new memory', async t => {
  const A = 'a0000000000000000000000000000000';
  const deltas = [];
  let navigate;
  const h = createHarness({
    url: 'http://jellyfin.test/web/index.html#!/home',
    globals: { requestIdleCallback: fn => { fn({ timeRemaining: () => 50, didTimeout: true }); return 1; } },
    apiClient: {
      getCurrentUserId: () => 'user-a',
      ajax: ({ url }) => (url.includes('since=')
        ? new Promise(resolve => deltas.push(resolve))
        : Promise.resolve({ items: { [A]: { Type: 'Movie', Genres: ['Current'] } }, version: 1, timestamp: 10, filterRevision: 'f', filterBase: 'b' })),
    },
    JE: {
      pluginConfig: { TagCacheServerMode: true }, currentSettings: { genreTagsEnabled: true },
      helpers: { onBodyMutation() {}, onNavigate: callback => { navigate = callback; }, addCSS() {} },
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      core: { tagRenderer: { applyCornerStacking() {}, scheduleCornerStacking() {} } },
    },
  });
  t.after(() => h.close());
  h.load('tags/tag-pipeline.js');
  h.JE.tagPipeline.initialize();
  await settle();
  h.window.location.hash = '#!/details?id=1';
  navigate();
  await settle();
  assert.equal(deltas.length, 1, 'the navigation asked what changed');
  await h.JE.tagPipeline.invalidateServerCache();
  await settle();
  deltas[0]({ items: { stale: { Type: 'Movie', Genres: ['Old'] } }, version: 1, timestamp: 20, filterRevision: 'f' });
  await settle();
  assert.equal(h.JE.tagPipeline.peekServerEntry('stale'), null);
  assert.deepEqual(h.JE.tagPipeline.peekServerEntry(A).Genres, ['Current']);
});
