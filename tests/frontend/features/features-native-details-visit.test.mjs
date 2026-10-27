import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';

// A visit to an absent title's native details page with the real transport (core/api-client.js), item owner
// (enhanced/helpers.js) and page adapter (native-details.js): the page's JE readers share one read of the item, a
// read that a policy change overtook is not kept, and the page's artwork is loaded once.

const SERVER = '0202511b0eac4284ab045b3ba556d72e';
const MOVIE = '4a45ad11000a938e00000000f9c67720'; // the server's own vector (ApiNativeDetailsTests)
const LIBRARY = '0123456789abcdef0123456789abcdef';
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
function setup(t) {
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

test('a read overtaken by an access change or a user switch answers no one and is never kept or joined', async t => {
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
    // Overtaken: not even its own caller is answered with it (review round 1, PDR-1/2).
    assert.equal((await old.then(() => null, error => error))?.name, 'AbortError', `${change}: the overtaken read publishes nothing`);
    h.answer(1, { Id: MOVIE, Name: 'current' });
    assert.equal((await fresh).Name, 'current');
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
  const hooks = [];
  const h = createHarness({
    JE: { core: { navigation: { onNavigate: () => {} } }, session: { getEpoch: () => epoch, isCurrent: e => e === epoch, onUserChange: (_n, fn) => hooks.push(fn) } },
    // jellyfin-web's client (the base transport) gets the same held answer.
    apiClient: { serverId: () => server, accessToken: () => token, getItem: async () => (await headers.promise).json() },
    fetch: () => headers.promise
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
  assert.equal(outcome.error?.name, 'AbortError', 'the previous session\'s answer is not published');
  assert.equal(outcome.value, undefined);
});

test('a session change while the answer\'s body is read draws nothing of it on the page', async t => {
  const h = setup(t);
  const body = deferred(), started = deferred();
  h.window.fetch = async url => String(url).includes(ITEM_PATH)
    ? { ok: true, status: 200, json: () => { started.resolve(); return body.promise; } }
    : new Response('null', { status: 200 });
  // jellyfin-web's client (the base transport) gets the same held body.
  h.window.ApiClient.getItem = async () => { started.resolve(); return body.promise; };
  const look = h.nd.onView();
  await started.promise;
  h.window.ApiClient.accessToken = () => 'changed-fixture';
  body.resolve({ Id: MOVIE, Type: 'Movie', Name: 'old-session-drawn' });
  await look;
  assert.notEqual(h.nd.current()?.item?.Name, 'old-session-drawn');
  assert.equal(h.document.querySelector('.je-native-absent-refusal'), null, 'a session change is not an outage');
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

test('a policy change during a default read: its callers get an AbortError, never the overtaken answer', async t => {
  const h = setup(t);
  const read = h.JE.helpers.getItemCached(MOVIE).then(value => ({ value }), error => ({ error }));
  await tick();
  h.window.dispatchEvent(new h.window.CustomEvent('je-hidden-content-changed'));
  h.answer(0, { Id: MOVIE, Name: 'overtaken' });
  const outcome = await read;
  assert.equal(outcome.error?.name, 'AbortError');
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
