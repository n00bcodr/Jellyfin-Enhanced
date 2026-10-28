import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';

// A visit to an absent title's native details page with the real transport (core/api-client.js), item owner
// (enhanced/helpers.js) and page adapter (native-details.js): the page's JE readers share one read of the item, a
// read that a policy change overtook is not kept, and the page's artwork is loaded once.

const SERVER = '0202511b0eac4284ab045b3ba556d72e';
const MOVIE = '4a45ad11000a938e00000000f9c67720'; // the server's own vector (ApiNativeDetailsTests)
const LIBRARY = '0123456789abcdef0123456789abcdef';
const SERVER_ID = SERVER;
const DETAILS = `#/details?id=${MOVIE}&serverId=${SERVER}`;
const PAGE = `<div id="itemDetailPage" class="page libraryPage itemDetailPage"><div class="detailPageContent"><div class="detailPagePrimaryContainer">
  <div class="mainDetailButtons"><button class="btnPlay detailButton">Play</button></div>
  <div class="detailImageContainer"><div class="card"><div class="cardPadder"></div><canvas class="lazy-hidden"></canvas><div class="cardImageContainer lazy" id="poster"></div></div></div></div>
  <div class="detailPagePrimaryContent"><div class="detailSection"><div class="overview">Overview</div></div></div>
  <div class="itemsContainer"><div class="card"><div class="cardPadder"></div><div class="cardImageContainer lazy" id="library"></div></div><img class="lazy" id="img"></div></div></div>`;
const ITEM_PATH = `/Users/user-a/Items/${MOVIE}`;
const tick = () => new Promise(r => setTimeout(r, 0));
const art = id => `http://jellyfin.test/Items/${id}/Images/Primary?fillHeight=293&fillWidth=195&quality=96&tag=signed`;

/**
 * The page adapter with the real transport and item owner.
 * @param {object} t Test context.
 * @returns {object} Harness and probes.
 */
function setup(t, realSession = false, realNavigation = false) {
  const reads = [], getItem = [], userChanges = [];
  let epoch = 1;
  const h = createHarness({
    html: PAGE, url: `http://jellyfin.test/web/index.html${DETAILS}`,
    // Item reads are held until the test answers them; the page's other JE reads answer at once.
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === ITEM_PATH) {
        const read = { init, answer: deferred() };
        reads.push(read);
        const item = await read.answer.promise;
        return new Response(JSON.stringify(item), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    JE: {
      pluginConfig: { NativeAbsentDetails: { Enabled: true, ContractVersion: 1, Source: 'tmdb' } },
      t: key => key,
      session: { onUserChange: (_name, fn) => userChanges.push(fn), getEpoch: () => epoch, isCurrent: e => e === epoch },
      arrStatus: { enabled: () => true },
      arrAsk: { enabled: () => false },
      core: { navigation: { onNavigate: () => {}, onViewPage: () => {} } },
    },
    // jellyfin-web's client (the base transport) answers from the same held reads, so a base run fails on behaviour.
    apiClient: { serverId: () => SERVER, getItem: (...args) => { getItem.push(args); const read = { init: { via: 'ApiClient.getItem' }, answer: deferred() }; reads.push(read); return read.answer.promise; } },
  });
  h.window.Emby = { Page: { show: () => {} } };
  t.after(() => h.close());
  if (realSession) {
    // The real session owner (it tells a new person from refreshed credentials of the same one).
    h.window.ApiClient.setAuthenticationInfo = function (value, user) { this.accessToken = () => value; this.getCurrentUserId = () => user; };
    h.load('core/session.js');
  }
  // The real view hooks (a route change keeps the page state until the next details view is shown).
  if (realNavigation) h.load('core/navigation.js');
  h.load('core/ui-kit.js');
  h.load('core/api-client.js');
  h.load('enhanced/helpers.js');
  h.load('jellyseerr/nativedetails/native-details.js');
  return {
    ...h, reads, getItem,
    nd: h.JE.internals.nativeDetails,
    page: h.document.getElementById('itemDetailPage'),
    answer(index, item = { Id: MOVIE, Type: 'Movie', Name: 'Dune' }) { reads[index].answer.resolve(item); },
    switchUser() { epoch++; userChanges.forEach(fn => fn()); },
  };
}

test('the page\'s JE readers join one uncached read of the item: overlapping looks and another module asking together', async t => {
  const h = setup(t);
  const first = h.nd.onView();
  const second = h.nd.onView();
  const other = h.JE.helpers.getItemCached(MOVIE);
  await tick();
  assert.equal(h.reads.length, 1, 'one JE read in flight for the page');
  assert.deepEqual(h.getItem, [], 'not through ApiClient.getItem (jellyfin-web\'s own read of the same URL)');
  // jellyfin-web reads this URL as it opens the page; the browser's HTTP cache would hold one of the two until the other ended.
  assert.equal(h.reads[0].init.cache, 'no-store');
  h.answer(0);
  await Promise.all([first, second]);
  assert.equal((await other).Name, 'Dune');
  assert.ok(h.page.classList.contains('je-native-absent'));
  assert.equal(h.page.dataset.jeNativeShown, MOVIE);
  assert.equal(h.reads.length, 1);
});

test('a page shown again is read again: no finished read is reused by a look, on the same route or after coming back', async t => {
  const h = setup(t);
  const first = h.nd.onView();
  await tick();
  h.answer(0);
  await first;
  // The same view shown again (a restore without a route change): checked again.
  const again = h.nd.onView();
  await tick();
  assert.equal(h.reads.length, 2);
  h.answer(1);
  await again;
  // Away and back: a new route generation, read again too.
  h.window.location.hash = '#/home';
  h.window.dispatchEvent(new h.window.HashChangeEvent('hashchange', { newURL: 'http://jellyfin.test/web/index.html#/home' }));
  h.window.location.hash = DETAILS;
  h.window.dispatchEvent(new h.window.HashChangeEvent('hashchange', { newURL: `http://jellyfin.test/web/index.html${DETAILS}` }));
  const back = h.nd.onView();
  await tick();
  assert.equal(h.reads.length, 3);
  h.answer(2);
  await back;
  // Another module's read within its short TTL still answers from the last read (unchanged).
  const cached = h.JE.helpers.getItemCached(MOVIE);
  await tick();
  assert.equal(h.reads.length, 3);
  assert.equal((await cached).Name, 'Dune');
});

test('A, away, A again before the first read ends: the newer read draws the page and is the one kept', async t => {
  const h = setup(t);
  const first = h.nd.onView();
  await tick();
  h.window.location.hash = '#/home';
  h.window.dispatchEvent(new h.window.HashChangeEvent('hashchange', { newURL: 'http://jellyfin.test/web/index.html#/home' }));
  h.window.location.hash = DETAILS;
  h.window.dispatchEvent(new h.window.HashChangeEvent('hashchange', { newURL: `http://jellyfin.test/web/index.html${DETAILS}` }));
  const second = h.nd.onView();
  await tick();
  assert.equal(h.reads.length, 2, 'the look on the new route does not join the old route\'s read');
  h.answer(1, { Id: MOVIE, Type: 'Movie', Name: 'newer' });
  await second;
  h.answer(0, { Id: MOVIE, Type: 'Movie', Name: 'older' });
  await first;
  assert.equal(h.nd.current().item.Name, 'newer');
  const cached = h.JE.helpers.getItemCached(MOVIE);
  await tick();
  assert.equal(h.reads.length, 2);
  assert.equal((await cached).Name, 'newer', 'the older completion is not kept');
});

test('a look in flight when Hidden Content changes reads again and draws the page from the new answer', async t => {
  const h = setup(t);
  const look = h.nd.onView();
  await tick();
  h.window.dispatchEvent(new h.window.CustomEvent('je-hidden-content-changed'));
  h.answer(0, { Id: MOVIE, Type: 'Movie', Name: 'Before the change' });
  for (let i = 0; i < 20 && h.reads.length < 2; i++) await tick();
  assert.equal(h.reads.length, 2, 'asked again under the new policy');
  h.answer(1, { Id: MOVIE, Type: 'Movie', Name: 'After the change' });
  await look;
  assert.equal(h.nd.current().item.Name, 'After the change');
  assert.equal(h.document.querySelector('.je-native-absent-refusal'), null, 'a policy change is not an outage');
});

test('a read overtaken by an access change or a session restart hands on nothing of its own and is never kept or joined', async t => {
  for (const change of ['access', 'user']) {
    const h = setup(t);
    const old = h.JE.helpers.getItemCached(MOVIE);
    await tick();
    if (change === 'access') h.document.dispatchEvent(new h.window.CustomEvent('je-access-revision', { detail: { before: 'a', revision: 'b' } }));
    else h.switchUser();
    const fresh = h.JE.helpers.getItemCached(MOVIE);
    await tick();
    assert.equal(h.reads.length, 2, `${change}: a new read, not the one in flight`);
    h.answer(0, { Id: MOVIE, Name: 'stale' });
    h.answer(1, { Id: MOVIE, Name: 'current' });
    assert.equal((await fresh).Name, 'current');
    // Overtaken: not even its own caller is answered with it (review rounds 1-2, PDR-1/2); the same person is answered
    // by the read under what holds now (joined, no third read).
    const outcome = await old.then(value => ({ value }), error => ({ error }));
    assert.notEqual(outcome.value?.Name, 'stale', `${change}: the overtaken read publishes nothing`);
    assert.equal(outcome.value?.Name, 'current', `${change}: its caller gets the current answer`);
    // The stale completion did not replace the current answer.
    assert.equal((await h.JE.helpers.getItemCached(MOVIE)).Name, 'current');
    assert.equal(h.reads.length, 2);
  }
});

test('the page\'s own artwork loads once: jellyfin-web\'s preloader and its background assignment share one load', async t => {
  const h = setup(t);
  const look = h.nd.onView();
  await tick();
  h.answer(0);
  await look;
  const poster = h.document.getElementById('poster');
  const url = art(MOVIE);
  poster.setAttribute('data-src', url);
  // jellyfin-web's lazy loader: the preloader starts and the element is hidden until it has loaded.
  poster.classList.add('lazy-hidden');
  await tick();
  assert.equal(poster.style.backgroundImage, `url("${url}")`, 'the same URL, while still hidden');
  assert.ok(poster.classList.contains('lazy-hidden'));
  const declared = poster.getAttribute('style');
  // Its own assignment once the preloader has loaded is then no change.
  poster.style.backgroundImage = "url('" + url + "')";
  assert.equal(poster.getAttribute('style'), declared);
  // A library card, an <img> and an unsigned URL are jellyfin-web's alone.
  const library = h.document.getElementById('library');
  library.setAttribute('data-src', art(LIBRARY));
  library.classList.add('lazy-hidden');
  const img = h.document.getElementById('img');
  img.setAttribute('data-src', url);
  img.classList.add('lazy-hidden');
  await tick();
  assert.equal(library.style.backgroundImage, '');
  assert.equal(img.getAttribute('src'), null);
  assert.equal(img.style.backgroundImage, '');
});

test('an image of the page scrolled out of view stays loaded, so coming back fetches nothing; other pages are left alone', async t => {
  const h = setup(t);
  const look = h.nd.onView();
  await tick();
  h.answer(0);
  await look;
  const poster = h.document.getElementById('poster');
  const canvas = poster.previousElementSibling;
  const padder = poster.parentNode.querySelector('.cardPadder');
  const url = art(MOVIE);
  // Loaded by jellyfin-web's lazy loader on this page: the preloader starts, then the image fades in.
  poster.setAttribute('data-src', url);
  poster.classList.add('lazy-hidden');
  await tick();
  poster.style.backgroundImage = "url('" + url + "')";
  poster.removeAttribute('data-src');
  poster.classList.add('lazy-image-fadein', 'blurhashed');
  poster.classList.remove('lazy-hidden');
  canvas.classList.add('lazy-hidden');
  padder.classList.add('lazy-hidden-children');
  await tick();
  // Out of view: jellyfin-web empties it (and would load it again, preloader and background, on the way back).
  canvas.classList.remove('lazy-hidden');
  padder.classList.remove('lazy-hidden-children');
  const shown = poster.style.backgroundImage.slice(4, -1).replace(/"/g, '');
  poster.style.backgroundImage = 'none';
  poster.setAttribute('data-src', shown);
  poster.classList.remove('lazy-image-fadein-fast', 'lazy-image-fadein');
  poster.classList.add('lazy-hidden');
  await tick();
  assert.equal(poster.style.backgroundImage, `url("${url}")`);
  assert.equal(poster.getAttribute('data-src'), null, 'nothing left for the lazy loader to load again');
  assert.equal(poster.classList.contains('lazy-hidden'), false);
  assert.ok(canvas.classList.contains('lazy-hidden'), 'the placeholder stays behind the image');
  assert.ok(padder.classList.contains('lazy-hidden-children'));
  // Once the viewer has left for an ordinary page, its images are jellyfin-web's alone.
  h.window.location.hash = `#/details?id=${LIBRARY}`;
  await h.nd.onView();
  poster.style.backgroundImage = 'none';
  poster.setAttribute('data-src', shown);
  poster.classList.add('lazy-hidden');
  await tick();
  assert.equal(poster.style.backgroundImage, 'none');
  assert.equal(poster.getAttribute('data-src'), shown);
});

// Review round 1 (PDR-1..3): a read answers only for the session and policy it started under, and artwork shown
// under an earlier policy is asked for again.

for (const mode of ['epoch', 'server', 'token-body']) test(`an item read started under one session never answers for another (${mode} moves)`, async t => {
  let epoch = 1, server = 'server-a', token = 'fixture-a';
  const headers = deferred(), body = deferred(), bodyStarted = deferred();
  const hooks = [], tokens = [];
  let calls = 0;
  // The first read is held (headers, then body); a read made after it answers for the session that holds then.
  const answer = async () => {
    if (calls++ === 0) { const r = await headers.promise; return r; }
    return { ok: true, status: 200, json: async () => ({ Id: MOVIE, Name: 'current-session' }) };
  };
  const h = createHarness({
    JE: { core: { navigation: { onNavigate: () => {} } }, session: { getEpoch: () => epoch, isCurrent: e => e === epoch, onUserChange: (_n, fn) => hooks.push(fn) } },
    // jellyfin-web's client (the base transport) gets the same held answer.
    apiClient: { serverId: () => server, accessToken: () => token, getItem: async () => { tokens.push(token); return (await answer()).json(); } },
    fetch: (_url, init) => { tokens.push(init?.headers?.['X-Emby-Token']); return answer(); }
  });
  t.after(() => h.close());
  h.load('core/api-client.js');
  h.load('enhanced/helpers.js');
  const result = h.JE.helpers.getItemCached(MOVIE).then(value => ({ value }), error => ({ error }));
  if (mode === 'epoch') { epoch++; hooks.forEach(fn => fn()); }
  if (mode === 'server') server = 'server-b';
  headers.resolve({ ok: true, status: 200, json: () => { bodyStarted.resolve(); return body.promise; } });
  if (mode === 'token-body') {
    // The headers came under the old session; it changes while the body is still being read.
    await bodyStarted.promise;
    token = 'fixture-b'; epoch++; hooks.forEach(fn => fn());
  }
  body.resolve({ Id: MOVIE, Name: 'previous-session' });
  const outcome = await result;
  assert.notEqual(outcome.value?.Name, 'previous-session', 'the previous session\'s answer is not published');
  assert.equal(outcome.error, undefined);
  if (mode === 'server') {
    // Another server: nothing, and nothing read for it on the caller's behalf.
    assert.equal(outcome.value, null);
    assert.equal(calls, 1);
  } else {
    // The same person on the same server: answered by one read under the session that holds now.
    assert.equal(outcome.value?.Name, 'current-session');
    assert.equal(calls, 2);
    if (mode === 'token-body') assert.deepEqual(tokens, ['fixture-a', 'fixture-b']);
  }
});

test('credentials refreshed while the answer\'s body is read: nothing of the old answer is drawn, the page reads once more under the new ones', async t => {
  const h = setup(t);
  const first = deferred(), started = deferred();
  const tokens = [];
  let calls = 0;
  const item = async (token) => {
    tokens.push(token);
    if (calls++ === 0) { started.resolve(); return first.promise; }
    return { Id: MOVIE, Type: 'Movie', Name: 'refreshed' };
  };
  h.window.fetch = async (url, init) => String(url).includes(ITEM_PATH)
    ? { ok: true, status: 200, json: () => item(init?.headers?.['X-Emby-Token']) }
    : new Response('null', { status: 200 });
  // jellyfin-web's client (the base transport) gets the same answers.
  h.window.ApiClient.getItem = async () => item(h.window.ApiClient.accessToken());
  const look = h.nd.onView();
  await started.promise;
  h.window.ApiClient.accessToken = () => 'changed-fixture';
  first.resolve({ Id: MOVIE, Type: 'Movie', Name: 'old-session-drawn' });
  await look;
  assert.notEqual(h.nd.current()?.item?.Name, 'old-session-drawn');
  for (let i = 0; i < 20 && h.nd.current()?.item?.Name !== 'refreshed'; i++) await tick();
  assert.equal(h.nd.current().item.Name, 'refreshed', 'drawn from the read under the new credentials');
  assert.deepEqual(tokens.slice(1), ['changed-fixture']);
  assert.equal(h.document.querySelector('.je-native-absent-refusal'), null, 'a credential refresh is not an outage');
});

test('a same-user credential refresh on a restored page recovers it: read again under the new credentials, shown (review round 2, PDR2-1)', async t => {
  const h = setup(t, true);
  // The one startup look, then a later view of the same page (a restore).
  await new Promise(r => setTimeout(r, 380));
  for (let i = 0; i < 50 && h.reads.length < 1; i++) await tick();
  h.answer(0);
  for (let i = 0; i < 50 && h.page.dataset.jeNativeShown !== MOVIE; i++) await tick();
  assert.equal(h.page.dataset.jeNativeShown, MOVIE);
  const epoch = h.JE.session.getEpoch();
  let changes = 0;
  h.document.addEventListener('je:user-changed', () => changes++);
  const body = deferred(), started = deferred();
  let bodyCalls = 0;
  h.window.fetch = async url => String(url).includes('/Users/')
    ? { ok: true, status: 200, json: () => { bodyCalls++; started.resolve(); return bodyCalls === 1 ? body.promise : { Id: MOVIE, Type: 'Movie', Name: 'after-refresh' }; } }
    : new Response('null', { status: 200 });
  h.window.ApiClient.getItem = async () => { bodyCalls++; started.resolve(); return bodyCalls === 1 ? body.promise : { Id: MOVIE, Type: 'Movie', Name: 'after-refresh' }; };
  const look = h.nd.onView();
  await started.promise;
  assert.ok(h.page.classList.contains('je-native-absent-checking'), 'the restored page is hidden while it is checked');
  h.window.ApiClient.setAuthenticationInfo('refreshed-fixture', 'user-a');
  body.resolve({ Id: MOVIE, Type: 'Movie', Name: 'old-session' });
  await look;
  h.JE.session.checkNow('refresh');
  assert.equal(changes, 0, 'same-user refresh produces no identity notification');
  assert.equal(h.JE.session.getEpoch(), epoch);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(bodyCalls > 1, 'read again under the new credentials');
  assert.equal(h.page.classList.contains('je-native-absent-checking'), false, 'not left hidden');
  assert.equal(h.nd.current()?.item?.Name, 'after-refresh');
});

test('a fenced look that cannot be read again ends in the outage state, never a page left hidden', async t => {
  for (const kind of ['another viewer', 'refreshed twice']) {
    const h = setup(t);
    const first = h.nd.onView();
    await tick();
    h.answer(0);
    await first;
    const bodies = [];
    h.window.fetch = async url => String(url).includes(ITEM_PATH)
      ? { ok: true, status: 200, json: () => { const d = deferred(); bodies.push(d); return d.promise; } }
      : new Response('null', { status: 200 });
    h.window.ApiClient.getItem = async () => { const d = deferred(); bodies.push(d); return d.promise; };
    // A restored view: hidden while it is checked.
    const look = h.nd.onView();
    for (let i = 0; i < 20 && bodies.length < 1; i++) await tick();
    assert.ok(h.page.classList.contains('je-native-absent-checking'));
    if (kind === 'another viewer') h.window.ApiClient.getCurrentUserId = () => 'user-b';
    else h.window.ApiClient.accessToken = () => 'second';
    bodies[0].resolve({ Id: MOVIE, Type: 'Movie', Name: 'stale' });
    await look;
    if (kind === 'refreshed twice') {
      for (let i = 0; i < 20 && bodies.length < 2; i++) await tick();
      assert.equal(bodies.length, 2, 'the one re-read');
      h.window.ApiClient.accessToken = () => 'third';
      bodies[1].resolve({ Id: MOVIE, Type: 'Movie', Name: 'stale-again' });
    }
    for (let i = 0; i < 20 && !h.document.querySelector('.je-native-absent-refusal'); i++) await tick();
    assert.ok(h.document.querySelector('.je-native-absent-refusal'), `${kind}: the outage state`);
    assert.equal(h.page.classList.contains('je-native-absent-checking'), false, `${kind}: not hidden`);
    assert.equal(h.document.documentElement.classList.contains('je-native-absent-checking'), false);
    assert.notEqual(h.nd.current()?.item?.Name, 'stale');
    assert.equal(bodies.length, kind === 'another viewer' ? 1 : 2, `${kind}: no work replayed for another viewer`);
  }
});

test('two policy changes during one look: neither overtaken answer is drawn, the page asks again under the latest', async t => {
  const h = setup(t);
  const look = h.nd.onView();
  await tick();
  h.window.dispatchEvent(new h.window.CustomEvent('je-hidden-content-changed'));
  h.answer(0, { Id: MOVIE, Type: 'Movie', Name: 'first-stale' });
  for (let i = 0; i < 20 && h.reads.length < 2; i++) await tick();
  assert.equal(h.reads.length, 2);
  h.document.dispatchEvent(new h.window.CustomEvent('je-access-revision'));
  h.answer(1, { Id: MOVIE, Type: 'Movie', Name: 'second-stale' });
  await look;
  assert.notEqual(h.nd.current()?.item?.Name, 'second-stale', 'the retry belongs to its policy generation too');
  assert.notEqual(h.nd.current()?.item?.Name, 'first-stale');
  // The page looks again under the policy that holds now and draws that answer.
  for (let i = 0; i < 20 && h.reads.length < 3; i++) await tick();
  assert.equal(h.reads.length, 3);
  h.answer(2, { Id: MOVIE, Type: 'Movie', Name: 'current' });
  for (let i = 0; i < 20 && h.nd.current()?.item?.Name !== 'current'; i++) await tick();
  assert.equal(h.nd.current().item.Name, 'current');
  assert.equal(h.document.querySelector('.je-native-absent-refusal'), null);
});

test('a policy change during a default read: its callers never get the overtaken answer, but one read under the new policy (no console error for them)', async t => {
  const h = setup(t);
  const read = h.JE.helpers.getItemCached(MOVIE).then(value => ({ value }), error => ({ error }));
  await tick();
  h.window.dispatchEvent(new h.window.CustomEvent('je-hidden-content-changed'));
  h.answer(0, { Id: MOVIE, Name: 'overtaken' });
  for (let i = 0; i < 20 && h.reads.length < 2; i++) await tick();
  assert.equal(h.reads.length, 2, 'read once more under the new policy');
  h.window.dispatchEvent(new h.window.CustomEvent('je-hidden-content-changed'));
  h.answer(1, { Id: MOVIE, Name: 'overtaken-again' });
  const outcome = await read;
  assert.equal(outcome.error, undefined, 'nothing for the caller to report');
  assert.equal(outcome.value, null, 'overtaken twice: nothing, never an overtaken answer');
  assert.equal(h.reads.length, 2);
  // Another person by the time it is overtaken: nothing either, and no read for them.
  const other = setup(t);
  const theirs = other.JE.helpers.getItemCached(MOVIE).then(value => ({ value }), error => ({ error }));
  await tick();
  other.window.ApiClient.getCurrentUserId = () => 'user-b';
  other.window.dispatchEvent(new other.window.CustomEvent('je-hidden-content-changed'));
  other.answer(0, { Id: MOVIE, Name: 'overtaken' });
  assert.deepEqual(await theirs, { value: null });
  assert.equal(other.reads.length, 1);
});

test('early artwork keeps jellyfin-web\'s gate, and a changed grant is left to jellyfin-web', async t => {
  const h = setup(t);
  const look = h.nd.onView();
  await tick();
  const poster = h.document.getElementById('poster');
  poster.setAttribute('data-src', art(MOVIE));
  poster.classList.add('lazy-hidden');
  await tick();
  assert.ok(poster.classList.contains('lazy-hidden'), 'still hidden until jellyfin-web\'s preloader has loaded');
  h.answer(0);
  await look;
  poster.classList.remove('lazy-hidden');
  await tick();
  const old = poster.style.backgroundImage;
  const next = art(MOVIE).replace('tag=signed', 'tag=changed');
  poster.setAttribute('data-src', next);
  poster.classList.add('lazy-hidden');
  await tick();
  assert.equal(poster.getAttribute('data-src'), next);
  assert.ok(poster.classList.contains('lazy-hidden'));
  assert.equal(poster.style.backgroundImage, old);
  poster.style.backgroundImage = "url('" + next + "')";
  poster.removeAttribute('data-src');
  poster.classList.remove('lazy-hidden');
  assert.equal(poster.style.backgroundImage, `url("${next}")`);
});

test('after an access change, artwork shown before it is not kept: emptied, it goes back to jellyfin-web to ask again', async t => {
  const h = setup(t);
  const look = h.nd.onView();
  await tick();
  h.answer(0);
  await look;
  const poster = h.document.getElementById('poster');
  const url = art(MOVIE);
  poster.setAttribute('data-src', url);
  poster.classList.add('lazy-hidden');
  await tick();
  poster.style.backgroundImage = "url('" + url + "')";
  poster.removeAttribute('data-src');
  poster.classList.remove('lazy-hidden');
  await tick();
  h.document.dispatchEvent(new h.window.CustomEvent('je-access-revision'));
  const shown = poster.style.backgroundImage.slice(4, -1).replace(/"/g, '');
  poster.style.backgroundImage = 'none';
  poster.setAttribute('data-src', shown);
  poster.classList.add('lazy-hidden');
  await tick();
  assert.ok(poster.classList.contains('lazy-hidden'), 'the old grant is checked before it is shown again');
  assert.equal(poster.style.backgroundImage, 'none');
  assert.equal(poster.getAttribute('data-src'), shown);
});

test('an access or Hidden Content change asks for the shown artwork again, even at an unchanged address, and drops an early background still loading', async t => {
  for (const [target, name] of [['document', 'je-access-revision'], ['window', 'je-hidden-content-changed']]) {
    const h = setup(t);
    const look = h.nd.onView();
    await tick();
    h.answer(0);
    await look;
    const poster = h.document.getElementById('poster');
    const card = h.document.getElementById('library');
    const url = art(MOVIE);
    poster.style.backgroundImage = "url('" + url + "')";
    // A second synthetic card whose preloader is still running, with the background joined to it.
    card.setAttribute('data-src', art(MOVIE).replace('Primary', 'Backdrop'));
    card.classList.add('lazy-hidden');
    await tick();
    assert.match(card.style.backgroundImage, /Backdrop/);
    (target === 'document' ? h.document : h.window).dispatchEvent(new h.window.CustomEvent(name));
    const again = poster.style.backgroundImage;
    assert.notEqual(again, `url("${url}")`, `${name}: a new request for the shown image`);
    assert.ok(again.startsWith(`url("${url}&_sbcb=`), `${name}: the same signed grant, asked again: ${again}`);
    assert.equal(card.style.backgroundImage, '', `${name}: jellyfin-web's own assignment fetches it anew`);
    // A library image of the same page is not touched.
    assert.equal(h.document.getElementById('img').style.backgroundImage, '');
  }
});

test('nodes this page did not load under the current policy are never kept when jellyfin-web empties them', async t => {
  const h = setup(t);
  const look = h.nd.onView();
  await tick();
  h.answer(0);
  await look;
  const nodes = Array.from({ length: 200 }, () => {
    const n = h.document.createElement('div');
    h.page.append(n);
    n.style.backgroundImage = 'none';
    n.setAttribute('data-src', art(MOVIE));
    n.classList.add('lazy-hidden');
    return n;
  });
  await tick();
  assert.equal(nodes.filter(n => n.style.backgroundImage === 'none' && n.hasAttribute('data-src') && n.classList.contains('lazy-hidden')).length, 200);
});

// Review round 3 (PDR3-1): the checking gate lives as long as the page state's check. Whatever ends that state (sign
// out, another viewer or server, no page shown when it looks again) settles the page that owned the check, fail closed.

const held = name => ({ Id: MOVIE, Type: 'Movie', Name: name });
const until = async fn => { for (let i = 0; i < 80 && !fn(); i++) await tick(); assert.ok(fn(), 'held stage reached'); };

/** A restored view of a page shown once, with the real session owner; its item reads are held. */
async function restoredPage(t, realNavigation = false) {
  const h = setup(t, true, realNavigation);
  let loading = false;
  h.window.Dashboard = { showLoadingMsg: () => { loading = true; }, hideLoadingMsg: () => { loading = false; } };
  // The startup look is spent first, so it cannot rescue a page later.
  await new Promise(r => setTimeout(r, 380));
  await until(() => h.reads.length === 1);
  h.answer(0);
  await until(() => h.page.dataset.jeNativeShown === MOVIE);
  const reads = [];
  const hold = init => { const body = deferred(); reads.push({ body, init }); return body.promise; };
  h.window.ApiClient.getItem = async () => hold({ headers: { 'X-Emby-Token': h.window.ApiClient.accessToken() } });
  h.window.fetch = async (url, init) => {
    if (!String(url).includes('/Users/')) return new Response('null', { status: 200 });
    const body = hold(init);
    return { ok: true, status: 200, json: () => body };
  };
  return { ...h, held: reads, loading: () => loading };
}

/** The page that owned the check, the page-wide gate and Jellyfin's loading indicator are all let go. */
function settled(h) {
  assert.deepEqual({
    page: h.page.classList.contains('je-native-absent-checking'),
    html: h.document.documentElement.classList.contains('je-native-absent-checking'),
    loading: h.loading(),
  }, { page: false, html: false, loading: false }, 'the page, backdrop and loading indicator settle');
}

for (const mode of ['once', 'twice-before-completion', 'during-rerun', 'signed-out', 'other-viewer', 'other-server', 'hidden-page']) {
  test(`a restored page checked across a credential change settles (${mode})`, async t => {
    const h = await restoredPage(t);
    const epoch = h.JE.session.getEpoch();
    let events = 0;
    h.document.addEventListener('je:user-changed', () => events++);
    const look = h.nd.onView();
    await until(() => h.held.length === 1);
    assert.ok(h.page.classList.contains('je-native-absent-checking'));
    h.window.ApiClient.setAuthenticationInfo('credential-b', 'user-a');
    if (mode === 'twice-before-completion') h.window.ApiClient.setAuthenticationInfo('credential-c', 'user-a');
    if (mode === 'signed-out') { h.window.ApiClient.setAuthenticationInfo('', null); h.window.ApiClient.setAuthenticationInfo('refreshed-while-out', null); }
    if (mode === 'other-viewer') h.window.ApiClient.setAuthenticationInfo('credential-other', 'user-b');
    if (mode === 'other-server') { h.window.ApiClient.serverId = () => 'server-b'; h.JE.session.checkNow('server'); }
    if (mode === 'hidden-page') h.page.classList.add('hide');
    h.held[0].body.resolve(held('overtaken-first'));
    await look;
    await tick();
    await tick();
    assert.notEqual(h.nd.current()?.item?.Name, 'overtaken-first');
    if (['once', 'twice-before-completion', 'during-rerun'].includes(mode)) {
      await until(() => h.held.length === 2);
      assert.equal(h.held[1].init.headers['X-Emby-Token'], mode === 'twice-before-completion' ? 'credential-c' : 'credential-b');
      if (mode === 'during-rerun') h.window.ApiClient.setAuthenticationInfo('credential-c', 'user-a');
      h.held[1].body.resolve(held(mode === 'during-rerun' ? 'overtaken-rerun' : 'current'));
      await until(() => (mode === 'during-rerun' ? !!h.document.querySelector('.je-native-absent-refusal') : h.nd.current()?.item?.Name === 'current'));
      assert.notEqual(h.nd.current()?.item?.Name, 'overtaken-rerun');
      assert.equal(h.held.length, 2, 'one rerun only');
      assert.equal(events, 0);
      assert.equal(h.JE.session.getEpoch(), epoch);
    } else {
      assert.equal(h.held.length, 1, 'no replay for another identity or a page not shown');
    }
    settled(h);
    if (['signed-out', 'other-viewer', 'other-server'].includes(mode)) assert.ok(h.page.querySelector('.je-native-absent-refusal'), 'the outage state');
    // Nothing of the earlier content shows: an ended check leaves the page refused, not merely unhidden.
    if (mode !== 'once' && mode !== 'twice-before-completion') assert.ok(h.page.classList.contains('je-native-absent-refused'));
  });
}

test('signed out between the stale answer and its queued look: the look is dropped and the page settles', async t => {
  const h = await restoredPage(t);
  const look = h.nd.onView();
  await until(() => h.held.length === 1);
  h.window.ApiClient.setAuthenticationInfo('credential-b', 'user-a');
  h.held[0].body.resolve(held('overtaken'));
  // The look again is queued and has not run: the viewer signs out first.
  await look;
  h.window.ApiClient.setAuthenticationInfo('', null);
  await tick();
  await tick();
  assert.equal(h.held.length, 1);
  assert.notEqual(h.nd.current()?.item?.Name, 'overtaken');
  settled(h);
  assert.ok(h.page.classList.contains('je-native-absent-refused'));
});

test('a page no longer shown when it would be looked at again lets its check go (it is checked anew when shown)', async t => {
  const h = await restoredPage(t);
  const look = h.nd.onView();
  await until(() => h.held.length === 1);
  h.page.classList.add('hide');
  h.window.ApiClient.setAuthenticationInfo('credential-b', 'user-a');
  h.held[0].body.resolve(held('held'));
  await look;
  await tick();
  await tick();
  assert.equal(h.held.length, 1, 'no look for a page not shown');
  settled(h);
  assert.ok(h.page.classList.contains('je-native-absent-refused'), 'its earlier content stays hidden');
  assert.equal(h.document.documentElement.classList.contains('je-native-absent-refused-view'), false, 'whatever is shown now keeps its backdrop');
  // Shown again: checked anew and drawn.
  h.page.classList.remove('hide');
  const back = h.nd.onView();
  await until(() => h.held.length === 2);
  assert.ok(h.page.classList.contains('je-native-absent-checking'));
  h.held[1].body.resolve(held('current'));
  await back;
  assert.equal(h.nd.current()?.item?.Name, 'current');
  assert.equal(h.page.classList.contains('je-native-absent-refused'), false);
  settled(h);
});

// Review round 4 (PDR4-1): a page refused while it is not shown changes nothing shared. The backdrop, the page-wide
// gate it does not hold and the loading indicator belong to the page that is shown.

const named = (name, id = MOVIE) => ({ Id: id, Type: 'Movie', Name: name });
function gatesOff(h, page = h.page) {
  assert.equal(page.classList.contains('je-native-absent-checking'), false, 'own page gate');
  assert.equal(h.document.documentElement.classList.contains('je-native-absent-checking'), false, 'page-wide gate');
  assert.equal(h.loading(), false, 'loading indicator');
}
/** The restored page's first read is overtaken by a credential refresh; its one look again is held. */
async function lookingAgain(h) {
  const look = h.nd.onView();
  await until(() => h.held.length === 1);
  h.window.ApiClient.setAuthenticationInfo('credential-b', 'user-a');
  h.held[0].body.resolve(named('overtaken-first'));
  await look;
  await until(() => h.held.length === 2);
  assert.ok(h.page.classList.contains('je-native-absent-checking'));
}

for (const ending of ['refresh', 'access', 'http403', 'empty', 'success']) {
  test(`a page no longer shown whose look again ends (${ending}) leaves the shown page's backdrop alone`, async t => {
    const h = await restoredPage(t);
    await lookingAgain(h);
    // jellyfin-web has hidden the cached page while its read is out; no view has been shown yet.
    h.page.classList.add('hide');
    const backdrop = h.document.createElement('div');
    backdrop.className = 'backdropContainer';
    h.document.body.append(backdrop);
    if (ending === 'refresh') h.window.ApiClient.setAuthenticationInfo('credential-c', 'user-a');
    if (ending === 'access') h.document.dispatchEvent(new h.window.CustomEvent('je-access-revision'));
    if (ending === 'http403') h.held[1].body.reject(Object.assign(new Error('HTTP 403'), { status: 403 }));
    else h.held[1].body.resolve(ending === 'empty' ? null : named(ending === 'refresh' ? 'overtaken-rerun' : 'current'));
    await tick(); await tick(); await tick();
    if (ending === 'access') {
      // The one read under the new policy, overtaken too.
      await until(() => h.held.length === 3);
      h.document.dispatchEvent(new h.window.CustomEvent('je-access-revision'));
      h.held[2].body.resolve(named('overtaken-policy'));
      await tick(); await tick(); await tick();
    }
    assert.notEqual(h.nd.current()?.item?.Name, 'overtaken-rerun');
    assert.notEqual(h.nd.current()?.item?.Name, 'overtaken-policy');
    gatesOff(h);
    assert.equal(h.document.documentElement.classList.contains('je-native-absent-refused-view'), false, 'nothing page-wide');
    assert.notEqual(h.window.getComputedStyle(backdrop).display, 'none', 'the shown page keeps its backdrop');
    if (ending !== 'success') {
      assert.ok(h.page.classList.contains('je-native-absent-refused'));
      assert.ok(h.page.querySelector('.je-native-absent-refusal'));
      assert.equal(h.window.getComputedStyle(h.page.querySelector('.detailPageContent')).display, 'none', 'its earlier content stays hidden');
    }
    // Shown again: checked anew.
    h.page.classList.remove('hide');
    const count = h.held.length;
    const back = h.nd.onView();
    await until(() => h.held.length === count + 1);
    h.held[count].body.resolve(named('current-on-show'));
    await back;
    assert.equal(h.nd.current()?.item?.Name, 'current-on-show');
    gatesOff(h);
    assert.equal(h.document.documentElement.classList.contains('je-native-absent-refused-view'), false);
  });
}

test('the outgoing page refused before the incoming details page is shown leaves the incoming backdrop alone (real navigation)', async t => {
  const h = await restoredPage(t, true);
  await lookingAgain(h);
  h.page.classList.add('hide');
  const holder = h.document.createElement('div');
  holder.innerHTML = PAGE;
  const nextPage = holder.firstElementChild;
  const id = h.JE.titleDetails.syntheticId('movie', 998);
  h.document.body.append(nextPage);
  h.window.location.hash = `#/details?id=${id}&serverId=${SERVER_ID}`;
  await tick();
  assert.equal(h.nd.current()?.page, h.page, 'the route change keeps the old state until the next details view');
  const backdrop = h.document.createElement('div');
  backdrop.className = 'backdropContainer';
  h.document.body.append(backdrop);
  h.window.ApiClient.setAuthenticationInfo('credential-c', 'user-a');
  h.held[1].body.resolve(named('overtaken-rerun'));
  await tick(); await tick();
  gatesOff(h);
  assert.equal(h.nd.current(), null);
  assert.equal(h.window.getComputedStyle(h.page.querySelector('.detailPageContent')).display, 'none');
  assert.notEqual(h.window.getComputedStyle(nextPage.querySelector('.detailPageContent')).display, 'none');
  assert.notEqual(h.window.getComputedStyle(backdrop).display, 'none', 'only the outgoing page failed: the incoming page keeps its backdrop');
  const count = h.held.length;
  h.window.Emby.Page.onViewShow('itemDetailPage', nextPage, h.window.location.hash);
  await until(() => h.held.length === count + 1);
  h.held[count].body.resolve(named('incoming-current', id));
  await until(() => h.nd.current()?.item?.Name === 'incoming-current');
  gatesOff(h, nextPage);
  assert.equal(h.document.documentElement.classList.contains('je-native-absent-refused-view'), false);
});

test('a second view of a page hidden while its read is overtaken again leaves the shared backdrop shown', async t => {
  const h = await restoredPage(t);
  const first = h.nd.onView();
  await until(() => h.held.length === 1);
  h.window.ApiClient.setAuthenticationInfo('credential-b', 'user-a');
  h.held[0].body.resolve(named('overtaken-first'));
  await first;
  await tick(); await tick();
  const second = h.nd.onView();
  await until(() => h.held.length === 2);
  const backdrop = h.document.createElement('div');
  backdrop.className = 'backdropContainer';
  h.document.body.append(backdrop);
  h.page.classList.add('hide');
  h.window.ApiClient.setAuthenticationInfo('credential-c', 'user-a');
  h.held[1].body.resolve(named('overtaken-second'));
  await second;
  await tick(); await tick();
  assert.equal(h.held.length, 2);
  gatesOff(h);
  assert.equal(h.document.documentElement.classList.contains('je-native-absent-refused-view'), false);
  assert.notEqual(h.window.getComputedStyle(backdrop).display, 'none');
});

// Review round 5 (PDR5-1): the gate belongs to the check that set it (page and look). An earlier look of the same page
// that ends later (its destination answered after a newer look started) changes nothing while the newer one holds it.

const CHECKING = 'je-native-absent-checking';
function gateHeld(h, page = h.page) {
  assert.equal(page.classList.contains(CHECKING), true, 'page gate');
  assert.equal(h.document.documentElement.classList.contains(CHECKING), true, 'page-wide gate');
  assert.equal(h.loading(), true, 'loading indicator');
}

for (const move of ['none', 'refresh', 'access']) {
  test(`an earlier look of the same page cannot release a newer look's gate (${move})`, async t => {
    const h = await restoredPage(t);
    const destinations = [];
    const fetchItem = h.window.fetch;
    h.window.fetch = (url, init) => {
      if (!String(url).includes('/native-details/resolve?')) return fetchItem(url, init);
      const read = deferred();
      destinations.push(read);
      return read.promise;
    };
    const first = h.nd.onView();
    await until(() => h.held.length === 1 && destinations.length === 1);
    h.held[0].body.resolve(held('first-authorized'));
    await until(() => h.nd.current()?.item?.Name === 'first-authorized');
    gateHeld(h);
    if (move === 'refresh') h.window.ApiClient.setAuthenticationInfo('credential-b', 'user-a');
    if (move === 'access') h.document.dispatchEvent(new h.window.CustomEvent('je-access-revision'));
    const second = h.nd.onView();
    await until(() => h.held.length === 2);
    gateHeld(h);
    // The first look's destination answers while the newer look's read is still out.
    for (const read of destinations) read.resolve(new Response('null', { status: 200 }));
    await first;
    gateHeld(h);
    assert.equal(h.window.getComputedStyle(h.page.querySelector('.detailPageContent')).visibility, 'hidden', 'the earlier content stays hidden');
    // The newer look decides: refused, its content stays hidden and the gate goes.
    h.held[1].body.reject(Object.assign(new Error('HTTP 403'), { status: 403 }));
    for (const read of destinations) read.resolve(new Response('null', { status: 200 }));
    await second;
    assert.ok(h.page.classList.contains('je-native-absent-refused'));
    assert.equal(h.window.getComputedStyle(h.page.querySelector('.detailPageContent')).display, 'none');
    assert.equal(h.page.classList.contains(CHECKING), false);
    assert.equal(h.document.documentElement.classList.contains(CHECKING), false);
    assert.equal(h.loading(), false);
  });
}

test('the startup look overlapping a restored page\'s look cannot release its gate early (real startup timer)', async t => {
  const h = setup(t, true, true);
  let loading = false;
  h.window.Dashboard = { showLoadingMsg: () => { loading = true; }, hideLoadingMsg: () => { loading = false; } };
  const items = [], destinations = [];
  h.page.dataset.jeNativeShown = MOVIE;
  h.window.fetch = async url => {
    const list = String(url).includes('/Users/') ? items : String(url).includes('/native-details/resolve?') ? destinations : null;
    if (!list) return new Response('null', { status: 200 });
    const body = deferred();
    list.push(body);
    if (list === destinations) { await body.promise; return new Response('null', { status: 200 }); }
    return { ok: true, status: 200, json: () => body.promise };
  };
  h.window.ApiClient.getItem = async () => { const body = deferred(); items.push(body); return body.promise; };
  const first = h.nd.onView();
  await until(() => items.length === 1 && destinations.length === 1);
  items[0].resolve({ Id: MOVIE, Type: 'Movie', Name: 'first-authorized' });
  await until(() => h.nd.current()?.item?.Name === 'first-authorized');
  // The second look is native-details' own 350 ms startup look.
  for (let i = 0; i < 60 && items.length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(items.length, 2);
  assert.equal(h.page.classList.contains(CHECKING), true);
  destinations.forEach(body => body.resolve(null));
  await first;
  const observed = { checking: h.page.classList.contains(CHECKING), documentChecking: h.document.documentElement.classList.contains(CHECKING), loading };
  items[1].reject(Object.assign(new Error('HTTP 403'), { status: 403 }));
  await until(() => h.page.classList.contains('je-native-absent-refused'));
  await tick();
  assert.deepEqual(observed, { checking: true, documentChecking: true, loading: true });
});

// Phase 2 F30 (PDR-5): a long page keeps at most the last 32 images that left view loaded; older ones go back to
// jellyfin-web's own unloaded state (it loads them again when they come back), and are kept again once it has.
/** jellyfin-web's lazy loader on `node`: the preloader starts, then the image fades in. */
async function hostLoads(h, node, url) {
  node.setAttribute('data-src', url);
  node.classList.add('lazy-hidden');
  await tick();
  node.style.backgroundImage = "url('" + url + "')";
  node.removeAttribute('data-src');
  node.classList.add('lazy-image-fadein');
  node.classList.remove('lazy-hidden');
  await tick();
}
/** jellyfin-web emptying a loaded `node` as it leaves the viewport. */
async function hostUnloads(h, node) {
  const shown = node.style.backgroundImage.slice(4, -1).replace(/"/g, '');
  node.style.backgroundImage = 'none';
  node.setAttribute('data-src', shown);
  node.classList.remove('lazy-image-fadein-fast', 'lazy-image-fadein');
  node.classList.add('lazy-hidden');
  await tick();
}
const kept = n => !n.hasAttribute('data-src') && !n.classList.contains('lazy-hidden') && n.style.backgroundImage.startsWith('url(');
const handedBack = n => n.hasAttribute('data-src') && n.classList.contains('lazy-hidden') && n.style.backgroundImage === 'none';

test('F30: a page keeps only the last 32 images that left view; older ones are jellyfin-web\'s to load again', async t => {
  const h = setup(t);
  const look = h.nd.onView();
  await tick();
  h.answer(0);
  await look;
  const nodes = [];
  for (let i = 0; i < 60; i++) {
    const n = h.document.createElement('div');
    n.className = 'cardImageContainer lazy';
    h.page.append(n);
    await hostLoads(h, n, art(MOVIE).replace('quality=96', `quality=${i}`));
    nodes.push(n);
  }
  for (const n of nodes) await hostUnloads(h, n);
  await tick();
  assert.equal(nodes.filter(kept).length, 32, 'the last 32 stay loaded');
  assert.ok(nodes.slice(28).every(kept), 'the ones that left view last');
  assert.ok(nodes.slice(0, 28).every(handedBack), 'the older ones are as jellyfin-web left them');
  assert.ok(nodes.slice(0, 28).every((n, i) => n.getAttribute('data-src').includes(`quality=${i}`)), 'each with its own address back');
});

test('F30: an image handed back is kept again once jellyfin-web has loaded it again; a policy change still ends all keeping', async t => {
  const h = setup(t);
  const look = h.nd.onView();
  await tick();
  h.answer(0);
  await look;
  const nodes = [];
  for (let i = 0; i < 33; i++) {
    const n = h.document.createElement('div');
    h.page.append(n);
    await hostLoads(h, n, art(MOVIE).replace('quality=96', `quality=${i}`));
    nodes.push(n);
  }
  for (const n of nodes) await hostUnloads(h, n);
  await tick();
  const first = nodes[0];
  assert.ok(handedBack(first));
  // Back in view: jellyfin-web loads it (its preloader, the class already there), then it leaves view again.
  const url = first.getAttribute('data-src');
  first.style.backgroundImage = "url('" + url + "')";
  first.removeAttribute('data-src');
  first.classList.add('lazy-image-fadein');
  first.classList.remove('lazy-hidden');
  await tick();
  await hostUnloads(h, first);
  await tick();
  assert.ok(kept(first), 'kept again');
  assert.ok(handedBack(nodes[1]), 'the next oldest made room for it');
  // The person's access moved: nothing kept from before is kept when it leaves view next.
  h.document.dispatchEvent(new h.window.CustomEvent('je-access-revision'));
  const last = nodes.at(-1);
  last.style.backgroundImage = "url('" + art(MOVIE) + "')";
  await hostUnloads(h, last);
  await tick();
  assert.ok(handedBack(last), 'not kept across a policy change');
});
