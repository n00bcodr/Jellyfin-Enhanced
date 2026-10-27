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
    apiClient: { serverId: () => SERVER, getItem: async (...args) => { getItem.push(args); throw new Error('the page read the item past its owner'); } },
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
  assert.equal((await h.JE.helpers.getItemCached(MOVIE)).Name, 'Dune');
  assert.equal(h.reads.length, 3);
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
  assert.equal((await h.JE.helpers.getItemCached(MOVIE)).Name, 'newer', 'the older completion is not kept');
  assert.equal(h.reads.length, 2);
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

test('a read overtaken by an access change or a user switch answers its caller but is never kept or joined', async t => {
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
    if (change === 'access') assert.equal((await old).Name, 'stale');
    else await old.catch(() => null);
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
  // Loaded and faded in, as jellyfin-web leaves it.
  poster.style.backgroundImage = "url('" + url + "')";
  poster.classList.add('lazy-image-fadein', 'blurhashed');
  padder.classList.add('lazy-hidden-children');
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
