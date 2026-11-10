// Upstream ee1c92dc (#1029): cards already on the page redraw when a delta, an access change or a replacement changes their entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { createHarness, deferred, englishT } from '../../helpers/harness.mjs';

const movie = 'a'.repeat(32);
const other = 'b'.repeat(32);
const card = id => `<div class="card" data-id="${id}" data-type="Movie"><div class="cardScalable"><div class="cardImageContainer"></div><div class="cardOverlayContainer"></div></div></div>`;

/** Production pipeline, renderer and layout; only the server response is a fixture. */
async function setup(t, mode = 'delta') {
  const idle = [], calls = [], timers = new Map();
  const deltaResponse = deferred(), batchResponse = deferred(), storedResponse = deferred();
  let navigate, changed = false, now = 0, timerId = 0, retired = false, lookupItems = [];
  const h = createHarness({ html: card(movie) + card(movie) + card(other),
    globals: { requestIdleCallback: fn => idle.push(fn),
      setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
      clearTimeout: id => timers.delete(id) },
    apiClient: { ajax: async options => {
      calls.push(options.url);
      // The batch fallback: a lookup started before the removal waits on batchResponse
      // (late-batch); any other answers with what the server has now (lookupItems).
      if (options.url.includes('/tag-data/')) return mode === 'late-batch' && !retired ? batchResponse.promise : { Items: lookupItems };
      assert.ok(options.url.includes('/tag-cache'), options.url);
      const delta = options.url.includes('since=');
      if (mode === 'late-batch' && delta) return deltaResponse.promise;
      // Spoiler Guard re-sends every guarded entry with each delta, changed or not.
      if (mode === 'rider' && delta) return { items: { [other]: { Type: 'Movie', AudioLanguages: ['ja'] } }, removed: [], count: 2,
        version: 1, timestamp: 200 + now, filterRevision: 'all', filterBase: 'base' };
      const removed = (mode === 'removed' || mode === 'late-store') && changed;
      const hidden = mode === 'access' && changed;
      const items = delta
        ? !changed || mode === 'unchanged' || removed || hidden ? {} : { [movie]: { Type: 'Movie', AudioLanguages: ['en'] } }
        : { ...(mode === 'late-batch' ? {} : { [movie]: { Type: 'Movie', AudioLanguages: changed && mode !== 'unchanged' ? ['en'] : ['en', 'fr'] } }),
            [other]: { Type: 'Movie', AudioLanguages: ['ja'] } };
      return { items, removed: removed ? [movie] : [], count: 2, version: changed && mode === 'replacement' ? 2 : 1,
        timestamp: changed ? 200 + now : 100, filterRevision: hidden ? 'limited' : 'all', filterBase: 'base',
        ...(hidden ? { visible: [other] } : {}) };
    } },
    JE: { pluginConfig: { TagCacheServerMode: true }, currentSettings: { languageTagsEnabled: true },
      helpers: { onBodyMutation() {}, onNavigate(fn) { navigate = fn; }, addCSS() {} },
      t: englishT, cdn: { flagSvg: code => `/flags/${code}.svg` },
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} } } });
  t.after(() => h.close());
  h.window.performance.now = () => now;
  if (mode === 'late-store') h.JE.tagCacheStore = {
    ENTRY_SCHEMA: 10, available: () => true,
    getMeta: async () => ({ schema: 10, entrySchema: 10, version: 1, timestamp: 100,
      filterRevision: 'all', filterBase: 'base', servedAt: 100, count: 2 }),
    clearOtherScopes: async () => {}, applyDelta: async () => true,
    getMany: () => storedResponse.promise
  };
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/media-language.js', 'tags/tag-pipeline.js', 'tags/languagetags.js']) h.load(file);
  h.JE.initializeLanguageTags();
  h.JE.tagPipeline.initialize();
  const flush = async () => {
    for (let turn = 0; turn < 5; turn++) {
      await settle();
      while (idle.length) idle.shift()({ timeRemaining: () => 50 });
    }
  };
  await flush();
  const flags = el => [...el.querySelectorAll('.language-flag')].map(flag => flag.dataset.lang);
  return Object.assign(h, { calls, flags, flush, deltaResponse, batchResponse, storedResponse,
    retire() { retired = true; },
    setLookup(items) { lookupItems = items; },
    async fetchBatch() {
      for (const [id, timer] of [...timers]) if (timer.ms === 150) { timers.delete(id); timer.fn(); }
      await flush();
    }, async refresh(nextMode = mode) {
    mode = nextMode;
    changed = true;
    now += 21000;
    h.window.location.hash = `#/movies?visit=${now}`;
    navigate();
    await flush();
  } });
}

for (const mode of ['delta', 'replacement']) test(`a metadata ${mode} removes obsolete language flags from existing cards`, async t => {
  const h = await setup(t, mode);
  const cards = [...h.document.querySelectorAll('.card')];
  assert.deepEqual(cards.map(h.flags), [['gb', 'fr'], ['gb', 'fr'], ['jp']]);
  const unaffected = cards[2].querySelector('.language-flag');
  await h.refresh();
  assert.deepEqual([...h.JE.tagPipeline.peekServerEntry(movie).AudioLanguages], ['en'], 'the server cache has the refreshed metadata');
  assert.deepEqual(cards.map(h.flags), [['gb'], ['gb'], ['jp']], 'existing cards redraw after the audio track is removed');
  if (mode === 'delta') assert.equal(cards[2].querySelector('.language-flag'), unaffected, 'unrelated cards retain their presentation');
});

test('a removed item loses its flags when its fallback lookup finds nothing', async t => {
  const h = await setup(t, 'removed');
  const cards = [...h.document.querySelectorAll('.card')];
  await h.refresh();
  assert.equal(h.JE.tagPipeline.peekServerEntry(movie), null);
  assert.deepEqual(cards.map(h.flags), [[], [], ['jp']]);
  await h.fetchBatch();
  assert.equal(h.calls.filter(url => url.includes('/tag-data/')).length, 1, 'one fallback lookup for the removed item');
  assert.deepEqual(cards.map(h.flags), [[], [], ['jp']]);
});

test('an item removed from the cache keeps the tags its fallback lookup finds', async t => {
  // An item moved into a library excluded from the tag cache leaves the cache
  // but stays visible: the batch lookup still answers for it.
  const h = await setup(t, 'removed');
  h.setLookup([{ Id: movie, Type: 'Movie', MediaStreams: [{ Type: 'Audio', Language: 'en' }] }]);
  const cards = [...h.document.querySelectorAll('.card')];
  await h.refresh();
  await h.fetchBatch();
  assert.equal(h.JE.tagPipeline.peekServerEntry(movie), null);
  assert.deepEqual(cards.map(h.flags), [['gb'], ['gb'], ['jp']]);
});

test('a delta that re-sends an unchanged entry leaves its card alone', async t => {
  const h = await setup(t, 'rider');
  const kept = h.document.querySelectorAll('.card')[2].querySelector('.language-flag');
  await h.refresh();
  assert.equal(h.document.querySelectorAll('.card')[2].querySelector('.language-flag'), kept);
});

test('an empty metadata delta preserves the existing cards', async t => {
  const h = await setup(t, 'unchanged');
  const oldFlags = [...h.document.querySelectorAll('.language-flag')];
  await h.refresh();
  assert.deepEqual([...h.document.querySelectorAll('.language-flag')], oldFlags);
});

test('an access-only delta removes flags from cards the user can no longer see', async t => {
  const h = await setup(t, 'access');
  await h.refresh();
  assert.equal(h.JE.tagPipeline.peekServerEntry(movie), null);
  assert.deepEqual([...h.document.querySelectorAll('.card')].map(h.flags), [[], [], ['jp']]);
  await h.fetchBatch();
  assert.equal(h.calls.length, 2, 'access reconciliation needs neither a full download nor an item lookup');
});

test('a removed item can render again when a later delta restores it', async t => {
  const h = await setup(t, 'removed');
  await h.refresh();
  assert.deepEqual([...h.document.querySelectorAll('.card')].map(h.flags), [[], [], ['jp']]);
  await h.refresh('delta');
  assert.equal(h.calls.length, 3, JSON.stringify(h.calls));
  assert.deepEqual([...h.JE.tagPipeline.peekServerEntry(movie).AudioLanguages], ['en']);
  assert.deepEqual([...h.document.querySelectorAll('.card')].map(h.flags), [['gb'], ['gb'], ['jp']]);
});

for (const inFlight of [false, true]) test(`a removal delta retires stale batch work (in-flight=${inFlight})`, async t => {
  const h = await setup(t, 'late-batch');
  // Start the batch after navigation so its generation remains current when
  // the delta lands. Only the per-card invalidation can reject this response.
  await h.refresh();
  if (inFlight) {
    await h.fetchBatch();
    assert.equal(h.calls.filter(url => url.includes('/tag-data/')).length, 1);
  }
  h.retire();
  h.deltaResponse.resolve({ items: {}, removed: [movie], version: 1, timestamp: 200, filterRevision: 'all' });
  await h.flush();
  if (!inFlight) {
    await h.fetchBatch();
    assert.equal(h.calls.filter(url => url.includes('/tag-data/')).length, 1, 'the queued lookup is dropped; only the fresh one runs');
  }
  h.batchResponse.resolve({ Items: [{ Id: movie, Type: 'Movie', MediaStreams: [
    { Type: 'Audio', Language: 'en' }, { Type: 'Audio', Language: 'fr' }
  ] }] });
  await h.flush();
  assert.deepEqual([...h.document.querySelectorAll('.card')].map(h.flags), [[], [], ['jp']]);
});

test('a pending stored-cache read cannot release a card retired by a removal delta', async t => {
  const h = await setup(t, 'late-store');
  await h.refresh();
  h.storedResponse.resolve({ entries: new Map([
    [movie, { Type: 'Movie', AudioLanguages: ['en', 'fr'] }],
    [other, { Type: 'Movie', AudioLanguages: ['ja'] }]
  ]), meta: { version: 1, filterRevision: 'all', servedAt: 100 } });
  await h.flush();
  await h.fetchBatch();
  assert.deepEqual([...h.document.querySelectorAll('.card')].map(h.flags), [[], [], ['jp']]);
  // The stale stored copy draws nothing; the removed cards get one fresh lookup instead.
  assert.deepEqual(h.calls.filter(url => !url.includes('/tag-data/')).length, 2, 'confirmation and navigation deltas');
  assert.equal(h.calls.filter(url => url.includes('/tag-data/')).length, 1, 'one fallback lookup, which finds nothing');
});
