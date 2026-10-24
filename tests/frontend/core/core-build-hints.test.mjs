import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, jsonResponse } from '../helpers/harness.mjs';

// Stage 1 fix round 12: the build a page compares with comes only from answers no cache can have kept. A cacheable answer
// naming another build is a hint, confirmed by ONE handshake shared by every hint meanwhile; a failed handshake is tried
// again only after a growing delay; a handshake that finds the page's own build refutes that hint for good. The raw
// adapters (Lists, the administrator's user page) show every answer to the check before reading it.

function loadCore(h) {
  for (const path of ['core/navigation.js', 'core/session.js', 'core/mutation-queue.js', 'core/api-client.js']) h.load(path);
}

/** A fetch scripted per path; counts the handshakes (GET /JellyfinEnhanced/version) and what they were asked with. */
function server({ cachedBuild = 'previous', handshake = () => 'current' } = {}) {
  const calls = { handshakes: [], other: [] };
  const fetch = async (url, init = {}) => {
    const path = new URL(String(url), 'http://jellyfin.test').pathname;
    if (path.endsWith('/JellyfinEnhanced/version')) {
      calls.handshakes.push(init);
      const named = handshake();
      if (named instanceof Error) throw named;
      return new Response('1.0', { status: 200, headers: named ? { 'X-JE-Build': named, 'Cache-Control': 'no-store' } : {} });
    }
    calls.other.push({ path, init });
    const response = jsonResponse({ Awards: [] });
    response.headers.set('X-JE-Build', cachedBuild);
    response.headers.set('Cache-Control', 'private, max-age=1800');
    return response;
  };
  return { calls, fetch };
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

test('hints from several kept answers share one handshake, asked and answered no-store; it shows one notice', async t => {
  const s = server({ cachedBuild: 'newer', handshake: () => 'newer' });
  const h = createHarness({ JE: { pageBuild: 'current', serverBuild: 'current', t: key => key }, fetch: s.fetch });
  t.after(() => h.close());
  loadCore(h);
  await Promise.all([1, 2, 3].map(n => h.JE.core.api.plugin(`/kept-answer/${n}`, { cacheKey: `awards-${n}` })));
  await settle();
  assert.equal(s.calls.handshakes.length, 1, 'one handshake for every hint meanwhile');
  assert.equal(s.calls.handshakes[0].cache, 'no-store');
  assert.equal(h.document.querySelectorAll('.je-reload-notice').length, 1);
});

test('a handshake that finds the page\'s own build refutes the hint: the kept answer never asks again', async t => {
  const s = server({ cachedBuild: 'previous', handshake: () => 'current' });
  const h = createHarness({ JE: { pageBuild: 'current', serverBuild: 'current', t: key => key }, fetch: s.fetch });
  t.after(() => h.close());
  loadCore(h);
  await h.JE.core.api.plugin('/kept-answer/1', { cacheKey: 'awards-1' });
  await settle();
  await h.JE.core.api.plugin('/kept-answer/2', { cacheKey: 'awards-2' });
  await settle();
  assert.equal(s.calls.handshakes.length, 1);
  assert.equal(h.document.querySelector('.je-reload-notice'), null);
});

test('a failed handshake leaves the build unknown and is tried again only after its delay', async t => {
  let now = 1_000_000;
  let answer = new TypeError('offline');
  const s = server({ cachedBuild: 'newer', handshake: () => answer });
  const h = createHarness({ JE: { pageBuild: 'current', serverBuild: 'current', t: key => key }, fetch: s.fetch });
  t.after(() => h.close());
  h.window.Date.now = () => now;
  loadCore(h);
  const kept = async n => { await h.JE.core.api.plugin(`/kept-answer/${n}`, { cacheKey: `awards-${n}` }); await settle(); };
  await kept(1);
  assert.equal(s.calls.handshakes.length, 1);
  assert.equal(h.document.querySelector('.je-reload-notice'), null, 'a failed handshake shows nothing');
  now += 10_000;
  await kept(2);
  assert.equal(s.calls.handshakes.length, 1, 'not again within the first 30 seconds');
  now += 25_000;
  answer = 'newer';
  await kept(3);
  assert.equal(s.calls.handshakes.length, 2);
  assert.equal(h.document.querySelectorAll('.je-reload-notice').length, 1);
});

test('a handshake answer without a build header is a failed handshake, never "the same build"', async t => {
  let named = '';
  const s = server({ cachedBuild: 'newer', handshake: () => named });
  let now = 5_000_000;
  const h = createHarness({ JE: { pageBuild: 'current', serverBuild: 'current', t: key => key }, fetch: s.fetch });
  t.after(() => h.close());
  h.window.Date.now = () => now;
  loadCore(h);
  const kept = async n => { await h.JE.core.api.plugin(`/kept-answer/${n}`, { cacheKey: `awards-${n}` }); await settle(); };
  await kept(1);
  now += 31_000;
  named = 'newer';
  await kept(2);
  assert.equal(s.calls.handshakes.length, 2, 'the hint was not refuted by an answer that named nothing');
  assert.ok(h.document.querySelector('.je-reload-notice'));
});

test('an answer the server marked no-store is authoritative on its own (no handshake)', async t => {
  const s = server();
  const h = createHarness({ JE: { pageBuild: 'current', serverBuild: 'current', t: key => key }, fetch: s.fetch });
  t.after(() => h.close());
  loadCore(h);
  h.JE.core.build.noteAnswer(new Response('{}', { headers: { 'X-JE-Build': 'newer', 'Cache-Control': 'no-cache, no-store' } }));
  await settle();
  assert.equal(s.calls.handshakes.length, 0);
  assert.ok(h.document.querySelector('.je-reload-notice'));
});

test('a 304 revalidation names whatever build the kept copy had: only a hint', async t => {
  const s = server({ handshake: () => 'current' });
  const h = createHarness({ JE: { pageBuild: 'current', serverBuild: 'current', t: key => key }, fetch: s.fetch });
  t.after(() => h.close());
  loadCore(h);
  h.JE.core.build.noteAnswer(new Response(null, { status: 304, headers: { 'X-JE-Build': 'previous', 'Cache-Control': 'private, max-age=60' } }));
  await settle();
  assert.equal(s.calls.handshakes.length, 1);
  assert.equal(h.document.querySelector('.je-reload-notice'), null);
});

test('the Lists adapter shows every answer to the build check, a read\'s too', async t => {
  const h = createHarness({
    JE: { pageBuild: 'current', serverBuild: 'current', t: key => key, pluginConfig: { ArrListsEnabled: true } },
    fetch: async () => new Response(JSON.stringify({ lists: [] }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-JE-Build': 'newer' } })
  });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  loadCore(h);
  h.load('arr/lists/list-api.js');
  await h.JE.arrLists.editableLists();
  assert.ok(h.document.querySelector('.je-reload-notice'), 'asked with no-store: the server\'s build now');
});

test('the administrator\'s user page adapter shows a refused write\'s answer to the build check', async t => {
  const h = createHarness({
    JE: { pageBuild: 'current', serverBuild: 'current', t: key => key },
    fetch: async () => new Response(JSON.stringify({ code: 'invalid' }), { status: 400, headers: { 'Content-Type': 'application/json', 'X-JE-Build': 'newer' } })
  });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  loadCore(h);
  h.load('arr/adminusers/admin-users-api.js');
  await h.JE.arrAdminUsersApi.patch('user-b', 'requests', { quota: 2 }).catch(() => {});
  assert.ok(h.document.querySelector('.je-reload-notice'));
});

test('the reload notice spans the screen between gutters (a phone gets a full-width notice, not a half-width column)', async t => {
  const s = server();
  const h = createHarness({ JE: { pageBuild: 'current', serverBuild: 'current', t: key => key }, fetch: s.fetch });
  t.after(() => h.close());
  loadCore(h);
  h.JE.core.build.check('newer');
  const notice = h.document.querySelector('.je-reload-notice');
  assert.equal(notice.style.left, '16px');
  assert.equal(notice.style.right, '16px');
  assert.equal(notice.style.transform, '', 'not centred by a half-width transform');
});
