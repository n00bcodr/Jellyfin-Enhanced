import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { createHarness, deferred } from '../helpers/harness.mjs';

const card = '<div class="card" data-id="AA-BB" data-type="Episode"><div class="cardScalable"><div class="cardImageContainer"></div><div class="cardOverlayContainer"></div></div></div>';

/**
 * The real tag pipeline in batch mode with a stand-in layout controller that
 * records what item data reaches it, and when.
 */
function setup(t) {
  const idle = [], timers = new Map(), events = [];
  let seq = 0;
  const response = deferred();
  const h = createHarness({
    html: card,
    globals: { requestIdleCallback: fn => idle.push(fn), setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimeout: id => timers.delete(id) },
    apiClient: { ajax: () => response.promise },
    JE: {
      pluginConfig: { TagCacheServerMode: false }, currentSettings: {}, session: { onUserChange() {} },
      core: {
        tagRenderer: { applyCornerStacking() {}, scheduleCornerStacking() {} },
        tagLayout: { prepareCard() {}, setCardContext: (target, item, itemId) => events.push(['context', target.className, item.LibraryId, itemId]) },
      },
    },
  });
  t.after(() => h.close());
  h.load('tags/tag-pipeline.js');
  h.JE.tagPipeline.registerRenderer('probe', { isEnabled: () => true, render: (host, item) => events.push(['render', item.Id]) });
  return Object.assign(h, { events, response, scan() { while (idle.length) idle.shift()({ timeRemaining: () => 50 }); },
    fetch() { for (const [id, timer] of [...timers]) if (timer.ms === 150) { timers.delete(id); timer.fn(); } } });
}

test('the batch path hands the item data (library id included) to the layout controller before the renderers run', async t => {
  const h = setup(t);
  h.scan();
  h.fetch();
  h.response.resolve({ Items: [{ Id: 'aabb', Type: 'Episode', LibraryId: '22222222222222222222222222222222', SeriesId: 'cc' }] });
  await settle();
  assert.deepEqual(h.events, [['context', 'je-tag-host', '22222222222222222222222222222222', 'aabb'], ['render', 'aabb']]);
  assert.equal(h.JE.tagPipeline.peekServerEntry('aabb'), null, 'no server cache in batch mode');
  assert.deepEqual(Array.from(h.JE.tagPipeline.serverEntries()), []);
});

const SERIES = 'cccccccccccccccccccccccccccccccc';
const EPISODE = 'dddddddddddddddddddddddddddddddd';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const KIDS_LIB = '22222222222222222222222222222222';
const episodeCard = (id = EPISODE, type = 'Episode') => `<div class="card" data-id="${id}" data-type="${type}"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div><div class="cardOverlayContainer"></div></div><div class="cardText">Title</div></div></div>`;

/**
 * The real pipeline (batch mode: no server tag cache), layout controller and
 * tag look module, with one renderer whose local cache holds a quality chip
 * for every item (the localStorage fallback path; cached: false = a miss,
 * rendered from the batch) and a mocked /tag-data.
 */
function setupReal(t, { html = episodeCard(), settings = {}, storage = {}, cached = true, tagData = id => ({ Id: id, Type: 'Episode', SeriesId: SERIES }) } = {}) {
  user = 'a';
  const idle = [], timers = new Map(), requests = [], userChange = [];
  let seq = 0;
  const answers = [];
  const h = createHarness({
    html,
    globals: { requestIdleCallback: fn => idle.push(fn), setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimeout: id => timers.delete(id) },
    apiClient: {
      ajax: ({ url, data }) => {
        requests.push(url);
        const answer = deferred();
        answers.push(() => answer.resolve({ Items: JSON.parse(data).map(tagData).filter(Boolean) }));
        return answer.promise;
      },
    },
    JE: {
      pluginConfig: { TagCacheServerMode: false },
      currentSettings: { tagLayoutSettingsVersion: 1, tagLayout: 'corners', ...settings },
      session: { onUserChange: (name, fn) => userChange.push(fn), getUserId: () => user, getServerId: () => 's' },
      core: { tagRenderer: { applyCornerStacking() {}, scheduleCornerStacking() {} } },
      _cacheManager: { register(fn) { this.save = fn; }, markDirty() {} },
    },
  });
  t.after(() => h.close());
  for (const [key, value] of Object.entries(storage)) h.window.localStorage.setItem(key, value);
  for (const file of ['core/tag-layout.js', 'core/tag-look.js', 'tags/tag-pipeline.js']) h.load(file);
  const layout = h.JE.core.tagLayout;
  const chip = () => { const g = h.document.createElement('div'); g.className = 'quality-overlay-container'; g.innerHTML = '<span class="quality-overlay-label">4K</span>'; return g; };
  h.JE.tagPipeline.registerRenderer('quality', {
    isEnabled: () => true,
    renderFromCache: target => { if (!cached) return false; layout.commitGroup(target, 'quality', chip()); return true; },
    render: target => { layout.commitGroup(target, 'quality', chip()); },
  });
  const hostOf = id => h.document.querySelector(`[data-id="${id}"] .je-tag-host`);
  return Object.assign(h, {
    layout, requests, hostOf,
    timeout() { for (const [id, timer] of [...timers]) if (timer.ms === 8000) { timers.delete(id); timer.fn(); } },
    scan() { while (idle.length) idle.shift()({ timeRemaining: () => 50 }); },
    fetch() { for (const [id, timer] of [...timers]) if (timer.ms === 150) { timers.delete(id); timer.fn(); } },
    /** Answer every pending /tag-data request and let the batch finish (idle yields included). */
    async answer() {
      for (let i = 0; i < 6; i++) {
        while (answers.length) answers.shift()();
        await settle();
        while (idle.length) idle.shift()({ timeRemaining: () => 50 });
      }
    },
    switchUser() { for (const fn of userChange) fn(); },
    shown: id => !!h.document.querySelector(`[data-id="${id}"] [data-je-group="quality"]`),
  });
}

let user = 'a';
const seriesLock = { [SERIES]: { layout: 'bands', density: 'compact', lockedAt: 1 } };

test('an episode rendered from the local caches fetches its series once, then follows the series lock', async t => {
  const h = setupReal(t, { settings: { tagLayoutLocks: seriesLock } });
  h.scan();
  assert.equal(h.shown(EPISODE), false, 'its chips wait for the item data (they could move)');
  h.fetch();
  assert.equal(h.requests.filter(u => u.includes('/tag-data/')).length, 1, 'fetched although every renderer hit its cache');
  await h.answer();
  assert.equal(h.hostOf(EPISODE).dataset.jeLayout, 'bands', 'inherits the series lock');
  assert.equal(h.hostOf(EPISODE).dataset.jeLocked, '1');
  assert.ok(h.shown(EPISODE));

  // Remembered with the series id: stored beside the renderer caches.
  h.JE._cacheManager.save();
  const stored = JSON.parse(h.window.localStorage.getItem('JE_tagLookFacts'));
  assert.equal(stored[EPISODE].SeriesId, SERIES);
  assert.equal(h.window.localStorage.getItem('JE_tagLookFacts:identity-owner'), 's:a');
});

test('after a reload the remembered series id applies the lock at first paint, without a fetch', async t => {
  const storage = {
    JE_tagLookFacts: JSON.stringify({ [EPISODE]: { Type: 'Episode', SeriesId: SERIES, at: Date.now() } }),
    'JE_tagLookFacts:identity-owner': 's:a',
  };
  const h = setupReal(t, { settings: { tagLayoutLocks: seriesLock }, storage });
  h.scan();
  assert.equal(h.hostOf(EPISODE).dataset.jeLayout, 'bands');
  assert.ok(h.shown(EPISODE), 'shown at once');
  h.fetch();
  assert.equal(h.requests.length, 0, 'no fetch');
});

test('remembered facts of another user are never used', async t => {
  const storage = {
    JE_tagLookFacts: JSON.stringify({ [EPISODE]: { Type: 'Episode', SeriesId: SERIES, at: Date.now() } }),
    'JE_tagLookFacts:identity-owner': 's:someone-else',
  };
  const h = setupReal(t, { settings: { tagLayoutLocks: seriesLock }, storage });
  h.scan();
  assert.equal(h.shown(EPISODE), false);
  assert.equal(h.window.localStorage.getItem('JE_tagLookFacts'), null, 'their copy is dropped');
});

test('a library rule waits for the batch data instead of showing the default look first', async t => {
  const html = episodeCard(EPISODE, 'Movie') + episodeCard(OTHER, 'Movie');
  const rules = [{ id: 'kids', enabled: true, when: [{ field: 'library', value: KIDS_LIB }], layout: 'caption', density: 'compact' }];
  const h = setupReal(t, { html, settings: { tagLookRules: rules }, tagData: id => ({ Id: id, Type: 'Movie', LibraryId: id === EPISODE ? KIDS_LIB : undefined }) });
  h.scan();
  for (const id of [EPISODE, OTHER]) {
    assert.equal(h.shown(id), false, `${id}: no chips in a look that may change`);
    assert.equal(h.hostOf(id).dataset.jeLayout, 'corners');
  }
  h.fetch();
  await h.answer();
  assert.equal(h.hostOf(EPISODE).dataset.jeLayout, 'caption');
  assert.ok(h.document.querySelector(`[data-id="${EPISODE}"] .je-tag-caption [data-je-group="quality"]`), 'first chips land in the caption');
  assert.equal(h.hostOf(OTHER).dataset.jeLayout, 'corners');
  assert.ok(h.shown(OTHER));
});

test('a card whose data never comes shows its tags in the known look after the batch', async t => {
  const rules = [{ id: 'kids', enabled: true, when: [{ field: 'genre', value: 'Drama' }], layout: 'bands', density: 'full' }];
  const h = setupReal(t, { html: episodeCard(EPISODE, 'Movie'), settings: { tagLookRules: rules }, tagData: () => null });
  h.scan();
  assert.equal(h.shown(EPISODE), false);
  h.fetch();
  await h.answer();
  assert.ok(h.shown(EPISODE), 'released once the batch settled');
  assert.equal(h.hostOf(EPISODE).dataset.jeLayout, 'corners');
});

test('type-only rules and no rules never hold a typed card back or fetch', async t => {
  const rules = [{ id: 'eps', enabled: true, when: [{ field: 'type', value: 'Episode' }], layout: 'bands', density: 'full' }];
  const h = setupReal(t, { settings: { tagLookRules: rules } });
  h.scan();
  assert.ok(h.shown(EPISODE));
  assert.equal(h.hostOf(EPISODE).dataset.jeLayout, 'bands');
  h.fetch();
  assert.equal(h.requests.length, 0);
});

test('a batch answer for a card reused for another item meanwhile leaves the new item\'s facts alone', async t => {
  const rules = [{ id: 'kids', enabled: true, when: [{ field: 'library', value: KIDS_LIB }], layout: 'bands', density: 'full' }];
  const h = setupReal(t, { html: episodeCard(EPISODE, 'Movie'), settings: { tagLookRules: rules }, cached: false, tagData: id => ({ Id: id, Type: 'Movie', LibraryId: KIDS_LIB }) });
  h.scan();
  h.fetch();
  assert.equal(h.requests.length, 1);
  // Reused for OTHER (outside the kids library) while EPISODE's answer is in flight.
  const host = h.hostOf(EPISODE);
  h.document.querySelector('.card').setAttribute('data-id', OTHER);
  h.layout.setCardContext(host, { Id: OTHER, Type: 'Movie' }, OTHER, OTHER);
  await h.answer();
  assert.equal(h.layout.resolveLayout(host).layout, 'corners', 'OTHER keeps its own facts');
});

test('a user switch forgets the remembered facts and the stored copy of the outgoing user', async t => {
  const h = setupReal(t, { settings: { tagLayoutLocks: seriesLock } });
  h.scan(); h.fetch(); await h.answer();
  h.JE._cacheManager.save();
  assert.equal(h.hostOf(EPISODE).dataset.jeLayout, 'bands');
  const tagData = () => h.requests.filter(u => u.includes('/tag-data/')).length;
  const fetches = tagData();

  user = 'b';
  h.switchUser();
  assert.equal(h.layout.resolveLayout(h.hostOf(EPISODE)).layout, 'corners', 'the card\'s facts went with the outgoing user');
  h.JE.tagPipeline.scheduleScan();
  h.scan();
  assert.equal(h.shown(EPISODE), false, 'waits for its own data again');
  h.fetch();
  assert.equal(tagData(), fetches + 1, 'fetched for the incoming user');
  assert.equal(h.window.localStorage.getItem('JE_tagLookFacts:identity-owner'), 's:b');
  assert.equal(h.window.localStorage.getItem('JE_tagLookFacts'), null);
  await h.answer();
  assert.equal(h.hostOf(EPISODE).dataset.jeLayout, 'bands');
});

test('plain /Items fallback facts cannot complete a library rule and the next scan retries tag-data', async t => {
  const rules = [{ id: 'kids', enabled: true, when: [{ field: 'library', value: KIDS_LIB }], layout: 'bands', density: 'full' }];
  const h = setupReal(t, { html: episodeCard(EPISODE, 'Movie'), settings: { tagLookRules: rules } });
  h.window.ApiClient.ajax = async () => { throw new Error('tag-data unavailable'); };
  h.window.ApiClient.getItem = async () => ({ Id: EPISODE, Type: 'Movie' });
  h.scan(); h.fetch(); await h.answer();
  h.JE._cacheManager.save();
  const saved = JSON.parse(h.window.localStorage.getItem('JE_tagLookFacts'));
  assert.equal(saved[EPISODE].source, 'item');
  h.window.ApiClient.ajax = async () => ({ Items: [{ Id: EPISODE, Type: 'Movie', LibraryId: KIDS_LIB }] });
  h.layout.clearAll();
  h.JE.tagPipeline.clearProcessed(); h.JE.tagPipeline.scheduleScan(); h.scan();
  assert.equal(h.shown(EPISODE), false, 'plain facts do not release the new hold');
  h.fetch(); await h.answer();
  assert.equal(h.hostOf(EPISODE).dataset.jeLayout, 'bands');
});

test('an old batch cannot render into a reused card or release its new facts hold', async t => {
  const rules = [{ id: 'kids', enabled: true, when: [{ field: 'library', value: KIDS_LIB }], layout: 'bands', density: 'full' }];
  const h = setupReal(t, { html: episodeCard(EPISODE, 'Movie'), settings: { tagLookRules: rules } });
  h.scan(); h.fetch();
  const host = h.hostOf(EPISODE);
  h.document.querySelector('.card').setAttribute('data-id', OTHER);
  h.layout.awaitCardContext(host, OTHER, 'Movie');
  let staleRenders = 0;
  h.JE.tagPipeline.registerRenderer('probe', { isEnabled: () => true, render() { staleRenders++; } });
  const chip = h.document.createElement('div'); chip.innerHTML = '<span>4K</span>';
  h.layout.commitGroup(host, 'quality', chip);
  assert.equal(h.shown(OTHER), false);
  await h.answer();
  assert.equal(staleRenders, 0, 'rejected identity skips every renderer');
  assert.equal(h.shown(OTHER), false, 'B remains held after A settles');
  h.layout.setCardContext(host, { Id: OTHER, Type: 'Movie', LibraryId: KIDS_LIB }, OTHER, OTHER);
  assert.ok(h.shown(OTHER));
  assert.equal(host.dataset.jeLayout, 'bands');
});

test('clearing a waiting card ends its hold, so a replacement group shows at once', t => {
  const rules = [{ id: 'kids', enabled: true, when: [{ field: 'library', value: KIDS_LIB }], layout: 'bands', density: 'full' }];
  const h = setupReal(t, { html: episodeCard(EPISODE, 'Movie'), settings: { tagLookRules: rules } });
  h.scan(); h.fetch();
  const host = h.hostOf(EPISODE);
  h.layout.awaitCardContext(host, EPISODE, 'Movie');
  h.layout.clearCard(host);
  const chip = h.document.createElement('div'); chip.innerHTML = '<span>4K</span>';
  h.layout.commitGroup(host, 'quality', chip);
  assert.ok(h.shown(EPISODE), 'the old hold must not keep the replacement hidden until its timeout');
});

test('clearing every card ends every hold', t => {
  const rules = [{ id: 'kids', enabled: true, when: [{ field: 'library', value: KIDS_LIB }], layout: 'bands', density: 'full' }];
  const h = setupReal(t, { html: episodeCard(EPISODE, 'Movie'), settings: { tagLookRules: rules } });
  h.scan(); h.fetch();
  const host = h.hostOf(EPISODE);
  h.layout.awaitCardContext(host, EPISODE, 'Movie');
  h.layout.clearAll();
  const chip = h.document.createElement('div'); chip.innerHTML = '<span>4K</span>';
  h.layout.commitGroup(host, 'quality', chip);
  assert.ok(h.shown(EPISODE));
});

test('a wait token cannot release a newer hold for the same card identity', t => {
  const h = setupReal(t, { settings: { tagLayoutLocks: seriesLock } });
  h.scan();
  const host = h.hostOf(EPISODE);
  const old = h.layout.awaitCardContext(host, EPISODE, 'Episode');
  const current = h.layout.awaitCardContext(host, EPISODE, 'Episode');
  h.layout.releaseCardContext(host, old);
  assert.equal(h.shown(EPISODE), false);
  h.layout.releaseCardContext(host, current);
  assert.ok(h.shown(EPISODE));
});

test('a detached waiting card presents retained groups after timeout and reconnection without another fetch', t => {
  const h = setupReal(t, { settings: { tagLayoutLocks: seriesLock } });
  h.scan();
  const card = h.document.querySelector('.card');
  assert.equal(h.shown(EPISODE), false);
  card.remove(); h.timeout();
  h.document.body.append(card);
  h.JE.tagPipeline.scheduleScan(); h.scan();
  assert.ok(h.shown(EPISODE), 'reattachment presents the retained quality group');
  assert.equal(h.requests.length, 0, 'no response needed for safety-release presentation');
});

for (const keepFresh of [false, true]) test(`admin clear immediately removes stale facts from localStorage (fresh=${keepFresh})`, t => {
  const clearedAt = Date.now() - 1000;
  const facts = { [EPISODE]: { Type: 'Episode', SeriesId: SERIES, Genres: ['private'], at: clearedAt - 1 } };
  if (keepFresh) facts[OTHER] = { Type: 'Movie', Genres: ['public'], at: clearedAt + 1 };
  const h = setupReal(t, { storage: { JE_tagLookFacts: JSON.stringify(facts), 'JE_tagLookFacts:identity-owner': 's:a' } });
  h.JE.pluginConfig.ClearLocalStorageTimestamp = clearedAt;
  h.scan();
  const stored = JSON.parse(h.window.localStorage.getItem('JE_tagLookFacts') || '{}');
  assert.equal(stored[EPISODE], undefined, 'stale ids and genres are erased before any later cache save');
  assert.equal(JSON.stringify(stored).includes('private'), false);
  assert.deepEqual(Object.keys(stored), keepFresh ? [OTHER] : []);
});
