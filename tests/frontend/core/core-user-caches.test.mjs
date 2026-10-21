// Review round 4 of the user-change caches (browser side): every browser cache of a server answer is listed with how it
// follows the signed-in person's access (tests/fixtures/user-caches/js-caches.tsv), the core response cache keeps only
// answers that are the same for everyone, and an answer the server projected for the person (Seerr details under their
// parental limits) is asked for again after a restriction, through the real clients.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createHarness, jsonResponse, jsRoot } from '../helpers/harness.mjs';
import { cachesIn, inventory, problems, registry, responseCacheKeys } from '../helpers/browser-caches.mjs';

test('every browser cache of a server answer is listed with how it follows the person\'s access', () => {
  const found = problems(inventory(), registry());
  assert.deepEqual(found, []);
});

test('a planted memo of a server answer fails the inventory, and so does a revisioned row that follows nothing', () => {
  const file = 'jellyseerr/api.js';
  const source = readFileSync(resolve(jsRoot, file), 'utf8').replace("    const logPrefix = '🪼 Jellyfin Enhanced: Seerr API:';",
    "    const logPrefix = '🪼 Jellyfin Enhanced: Seerr API:';\n    const plantedDetails = new Map();\n    async function plantedRead(id) { plantedDetails.set(id, await JE.core.api.plugin(`/jellyseerr/movie/${id}`)); }");
  const planted = inventory().filter(c => c.file !== file).concat(cachesIn(file, source));
  assert.ok(problems(planted, registry()).some(p => p.includes('plantedDetails (Map): a browser cache of a server answer nobody listed')));
  // The same memo written as an expression-bodied arrow and through `.then`.
  const arrow = readFileSync(resolve(jsRoot, file), 'utf8').replace("    const logPrefix = '🪼 Jellyfin Enhanced: Seerr API:';",
    "    const logPrefix = '🪼 Jellyfin Enhanced: Seerr API:';\n    let plantedStatus = null;\n    const plantedLoad = () => get('/user-status').then(s => { plantedStatus = s; });");
  assert.ok(problems(inventory().filter(c => c.file !== file).concat(cachesIn(file, arrow)), registry()).some(p => p.includes('plantedStatus (let)')));
  // A row said to follow the access revision in a file that never does.
  const rows = registry().map(r => r.file === 'arr/ask/ask-sheet.js' && r.name === 'inflight' ? { ...r, class: 'revisioned' } : r);
  assert.ok(problems(inventory(), rows).some(p => p.includes('ask-sheet.js inflight: listed as revisioned, but the file never follows')));
});

/** The core API client and the Seerr module over a recording fetch. */
function realClients(t, answer) {
  const reads = [];
  const h = createHarness({
    JE: { pluginConfig: { JellyseerrEnabled: true, TmdbEnabled: true } },
    fetch: async url => { reads.push(String(url)); return answer(String(url)); }
  });
  t.after(() => h.close());
  for (const m of ['core/navigation.js', 'core/session.js', 'core/api-client.js', 'jellyseerr/api.js']) h.load(m);
  return { h, reads, api: h.JE.jellyseerrAPI, manager: h.JE.core.api.manager };
}

test('the core response cache keeps only answers that are the same for everyone', t => {
  const { manager } = realClients(t, () => jsonResponse({}));
  const keys = responseCacheKeys();
  assert.ok(keys.length > 0);
  for (const { file, prefix } of keys) {
    const shared = ['awards:', 'mdblist-ratings:', 'ddd:'].includes(prefix);
    assert.equal(manager.isSharedKey(prefix + 'x'), shared, `${file} ${prefix}`);
    manager.setCache(prefix + 'x', { kept: true });
    assert.equal(manager.getCached(prefix + 'x') !== null, shared, `${file} ${prefix}: kept`);
  }
});

test('Seerr movie details are asked for again after a parental restriction, and the refusal is honoured (real clients)', async t => {
  let restricted = false;
  const { api, reads } = realClients(t, url => url.includes('/JellyfinEnhanced/jellyseerr/movie/603')
    ? (restricted ? jsonResponse({ error: true, code: 'parental_block' }, 403) : jsonResponse({ id: 603, title: 'The Matrix' }))
    : jsonResponse({}, 404));
  assert.equal((await api.fetchMovieDetails(603, { throwOnError: true })).title, 'The Matrix');
  // The Dashboard lowers the person's parental limit: the next More Info asks the server, which refuses.
  restricted = true;
  await assert.rejects(api.fetchMovieDetails(603, { throwOnError: true }), error => error.status === 403);
  assert.equal(reads.filter(u => u.includes('/jellyseerr/movie/603')).length, 2);
});

test('TMDB proxy answers are asked for again too (a title the restriction blocks)', async t => {
  let restricted = false;
  const { api, reads } = realClients(t, url => url.includes('/JellyfinEnhanced/tmdb/tv/1399')
    ? (restricted ? jsonResponse({ error: true, code: 'parental_block' }, 403) : jsonResponse({ id: 1399, name: 'Show' }))
    : jsonResponse({}, 404));
  assert.equal((await api.fetchTmdbTvDetails(1399)).name, 'Show');
  restricted = true;
  assert.equal(await api.fetchTmdbTvDetails(1399), null);
  assert.equal(reads.filter(u => u.includes('/tmdb/tv/1399')).length, 2);
});

test('collection membership is per call: a later search asks the server again', async t => {
  let calls = 0;
  const { api } = realClients(t, url => {
    if (!url.includes('/movie-collections')) return jsonResponse({}, 404);
    calls++;
    return jsonResponse({ results: { 603: calls === 1 ? { id: 2344, name: 'The Matrix Collection' } : null } });
  });
  const first = await api.addCollections([{ id: 603, mediaType: 'movie' }]);
  assert.equal(first[0].collection?.id, 2344);
  const second = await api.addCollections([{ id: 603, mediaType: 'movie' }]);
  assert.equal(second[0].collection, undefined);
  assert.equal(calls, 2);
});

test('a moved filter revision in a tag answer asks for the person\'s revisions at once (the core announces the move)', async t => {
  let revision = 'r1';
  let access = 'a1';
  const probes = [];
  const h = createHarness({
    globals: { requestIdleCallback: () => {} },
    apiClient: { ajax: async () => ({ items: { aabb: { Type: 'Movie' } }, count: 1, version: 1, timestamp: 1, filterRevision: revision }) },
    fetch: async url => {
      probes.push(String(url));
      const value = `a=${access};hc=h1;sg=s1`;
      return new Response(JSON.stringify({ revision: value }), { headers: { 'Content-Type': 'application/json', 'X-JE-Revision': value } });
    },
    JE: { pluginConfig: { TagCacheServerMode: true }, currentSettings: { qualityTagsEnabled: true },
      helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} },
      core: { tagRenderer: { applyCornerStacking() {}, scheduleCornerStacking() {} } },
      session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} } }
  });
  t.after(() => h.close());
  const seen = [];
  h.document.addEventListener('je-access-revision', e => seen.push(e.detail));
  h.load('core/access-revision.js');
  await h.JE.core.revision.probe('start', true);
  h.load('tags/tag-pipeline.js');
  h.JE.tagPipeline.initialize();
  await h.JE.tagPipeline.invalidateServerCache();
  // The same revision again: nothing asked, nothing to drop.
  await h.JE.tagPipeline.invalidateServerCache();
  assert.equal(probes.length, 1);
  assert.deepEqual(seen, []);
  revision = 'r2';
  access = 'a2';
  await h.JE.tagPipeline.invalidateServerCache();
  await nextTurn();
  await nextTurn();
  assert.equal(probes.length, 2, 'the move is checked at once');
  assert.deepEqual(seen.map(s => ({ ...s })), [{ revision: 'a2', before: 'a1' }]);
});

test('status cards drop every kept status when the access revision moves, and read the cards again', async t => {
  const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
  const observers = [];
  const calls = [];
  const id = '0'.repeat(31) + '1';
  const h = createHarness({
    html: `<div class="card" data-id="${id}" data-type="Movie"><div class="cardBox"><div class="cardScalable"></div></div></div>`,
    url: 'http://jellyfin.test/web/index.html#/home',
    globals: { IntersectionObserver: class { constructor(fn) { this.fn = fn; this.observed = new Set(); observers.push(this); } observe(el) { this.observed.add(el); } unobserve(el) { this.observed.delete(el); } disconnect() { this.observed.clear(); } } },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrStatusPosterBadges: true },
      currentSettings: {},
      t: (key, params) => Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), en[key] ?? key),
      helpers: { debounce: fn => fn, onBodyMutation: () => ({ unsubscribe() {} }) },
      core: { api: { plugin: async path => { calls.push(path); return { items: [{ itemId: id, key: 'movie:tmdb:1', kind: 'movie', stage: 'ready' }] }; } },
        navigation: { onNavigate: () => () => {} }, lifecycle: { register: () => ({ track: x => x }) } },
      session: { getEpoch: () => 0, isCurrent: () => true, onUserChange() {} }
    }
  });
  t.after(() => h.close());
  for (const m of ['arr/status/status-core.js', 'arr/status/status-cards.js', 'arr/status/status-styles.js']) h.load(m);
  const cards = h.JE.internals.arrStatusCards;
  h.JE.initializeArrStatus();
  cards.scan();
  observers[0].fn([...observers[0].observed].map(target => ({ isIntersecting: true, target })));
  await cards.flush();
  assert.equal(cards.cache.size, 1);
  const before = calls.length;
  h.document.dispatchEvent(new h.window.CustomEvent('je-access-revision', { detail: { revision: 'r2', before: 'r1' } }));
  assert.equal(cards.cache.size, 0);
  cards.scan();
  for (const io of observers) io.fn([...io.observed].map(target => ({ isIntersecting: true, target })));
  await cards.flush();
  await nextTurn();
  assert.ok(calls.length > before, 'the card is read again');
});
