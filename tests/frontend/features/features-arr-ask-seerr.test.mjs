// Requests & downloads, phase 3f: Seerr's request controls in JE mode open JE's request sheet (cards, 4K menu,
// more-info modal entry points, collection, Home Screen Sections), and do exactly what they did before in Seerr
// mode; JE's search row replaces Seerr's in JE mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createHarness, jsRoot, jsonResponse } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const MODULES = ['arr/status/status-core.js', 'arr/ask/ask-core.js', 'arr/ask/ask-search.js', 'arr/ask/ask-sheet-styles.js', 'arr/ask/ask-sheet.js', 'arr/ask/ask-collection.js', 'arr/ask/ask-seerr.js'];

function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

const MEMBER = { role: 'member', canRequest: true, canRequestMovies: true, canRequestSeries: true, canApprove: false, asksFirst: false, can4kMovies: false, can4kSeries: false, backend: 'je', contact: 'Dad', freeEpisodes: 5 };

/**
 * The request modules over a fake request API, with Seerr's UI and API entry points stubbed (they record calls).
 * @param {import('node:test').TestContext} t Test.
 * @param {{jeMode?: boolean, me?: Object}} [options] JE mode, capabilities.
 */
function setup(t, { jeMode = true, me = MEMBER } = {}) {
  const posts = [];
  const toasts = [];
  const seerr = { movie: [], seasons: [], collection: [], advanced: 0, details: [], modals: [] };
  const h = createHarness({
    url: 'http://jellyfin.test/web/index.html#/search.html',
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/JellyfinEnhanced/, '') + u.search;
      if ((init.method || 'GET') === 'POST') {
        const body = JSON.parse(init.body);
        posts.push({ path, body });
        return jsonResponse({ outcome: 'accepted', reason: 'looking', certainty: 'Succeeded', message: 'Asked!', requestId: 'a'.repeat(32) }, 201);
      }
      if (path === '/acquire/requests/me') return jsonResponse({ outcome: 'accepted', reason: 'me', me });
      if (path.startsWith('/acquire/requests/quota')) return jsonResponse({ outcome: 'accepted', reason: 'quota', quota: { used: 0, limit: 7, remaining: 7, nextSlotAt: null, usedGb: 0, available: true } });
      if (path === '/tmdb/tv/1437') return jsonResponse({ seasons: [{ season_number: 1, episode_count: 14, air_date: '2002-09-20' }] });
      return jsonResponse({ outcome: 'denied', reason: 'not_found' }, 404);
    },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrRequestsEnabled: true, ArrRequestsJeMode: jeMode, JellyseerrEnabled: true, JellyseerrShowSearchResults: true },
      t: translate,
      toast: text => toasts.push(text),
      escapeHtml: s => s,
      helpers: { debounce: fn => fn, addCSS: () => {} },
      core: { api: { plugin: async () => null }, navigation: { onNavigate: () => () => {}, onViewPage: () => () => {} }, lifecycle: { register: () => ({ track: x => x }) } },
      session: { epoch: 0, getEpoch() { return this.epoch; }, isCurrent: () => true, onUserChange: () => {} },
      jellyseerrUI: {
        showMovieRequestModal: (...args) => { seerr.movie.push(args); },
        showSeasonSelectionModal: (...args) => { seerr.seasons.push(args); },
        showCollectionRequestModal: (...args) => { seerr.collection.push(args); }
      },
      jellyseerrAPI: {
        shouldShowAdvanced: () => { seerr.advanced++; return false; },
        fetchCollectionDetails: async (id) => {
          seerr.details.push(id);
          return { id, name: 'The Matrix Collection', parts: [
            { id: 603, title: 'The Matrix', releaseDate: '1999-03-31', posterPath: '/m.jpg', mediaInfo: { status: 5 } },
            { id: 604, title: 'The Matrix Reloaded', releaseDate: '2003-05-15' },
            { id: 605, title: 'The Matrix <Revolutions>', releaseDate: '2003-11-05', posterPath: '/x" onerror="evil()' }
          ] };
        }
      },
      // Seerr's request window (recorded; its body is the HTML the window would show).
      jellyseerrModal: { create: (options) => { const m = { options, shown: 0, closed: 0 }; seerr.modals.push(m); return { show: () => { m.shown++; }, close: () => { m.closed++; } }; } }
    }
  });
  t.after(() => h.close());
  for (const m of MODULES) h.load(m);
  return { ...h, posts, toasts, seerr };
}

async function settle(n = 20) {
  for (let i = 0; i < n; i++) await nextTurn();
}

const click = (h, node) => node.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));

/** A Seerr card with its request button (and the button's own Seerr handler, which must not run in JE mode). */
function seerrCard(h, item, onSeerr) {
  const card = h.document.createElement('div');
  card.className = 'jellyseerr-card';
  card.innerHTML = `<div class="cardText-first"><bdi>${item.title || item.name}</bdi></div>`;
  const button = h.document.createElement('button');
  button.className = 'jellyseerr-request-button jellyseerr-button-request';
  button.dataset.tmdbId = String(item.id);
  button.dataset.mediaType = item.mediaType;
  button.dataset.searchResultItem = JSON.stringify(item);
  button.innerHTML = '<span>Request</span>';
  button.addEventListener('click', onSeerr);
  card.appendChild(button);
  h.document.body.appendChild(card);
  return button;
}

test('JE mode: a Seerr movie card asks through JE with one tap, never Seerr, and shows the outcome on the button', async t => {
  const h = setup(t);
  let seerrRan = 0;
  const button = seerrCard(h, { id: 603, mediaType: 'movie', title: 'The Matrix', releaseDate: '1999-03-31', posterPath: '/m.jpg' }, () => seerrRan++);
  click(h, button);
  await settle();
  assert.equal(seerrRan, 0, "Seerr's own handler didn't run");
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].path, '/acquire/requests');
  assert.equal(h.posts[0].body.input.key, 'movie:tmdb:603');
  assert.equal(button.textContent, translate('arr_ask_chip_asked'));
  assert.equal(button.disabled, true);
  assert.ok(h.toasts.length > 0);
});

test('JE mode: a Seerr series card opens the JE sheet with its seasons; the 4K menu item asks for the 4K edition', async t => {
  const h = setup(t);
  let seerrRan = 0;
  const button = seerrCard(h, { id: 1437, mediaType: 'tv', name: 'Firefly', firstAirDate: '2002-09-20' }, () => seerrRan++);
  click(h, button);
  await settle();
  assert.equal(seerrRan, 0);
  const sheet = h.document.querySelector('.je-sheet');
  assert.ok(sheet, 'the JE request sheet is open');
  assert.match(sheet.textContent, /Firefly/);
  assert.equal(h.posts.length, 0, 'nothing is asked before a choice');
  h.JE.arrAskSheet.close();
  await settle();

  const movie = seerrCard(h, { id: 604, mediaType: 'movie', title: 'The Matrix Reloaded' }, () => seerrRan++);
  const item = h.document.createElement('button');
  item.className = 'jellyseerr-4k-popup-item';
  item.dataset.action = 'request4k';
  item.dataset.tmdbId = '604';
  item.dataset.mediaType = 'movie';
  movie.closest('.jellyseerr-card').appendChild(item);
  click(h, item);
  await settle();
  const sheet4k = h.document.querySelector('.je-sheet');
  assert.ok(sheet4k, '4K goes through the sheet');
  assert.equal(seerrRan, 0);
});

test("JE mode: Seerr's modal entry points open the JE sheet; the one-tap paths are sent to them; a collection is explained", async t => {
  const h = setup(t);
  assert.equal(h.JE.jellyseerrAPI.shouldShowAdvanced(), true, 'one-tap Seerr paths go to the (wrapped) modal');
  assert.equal(h.seerr.advanced, 0);
  await h.JE.jellyseerrUI.showMovieRequestModal(605, 'The Matrix Revolutions', { id: 605, title: 'The Matrix Revolutions' }, false);
  await settle();
  assert.equal(h.seerr.movie.length, 0, "Seerr's movie modal never opens");
  assert.equal(h.posts.at(-1).body.input.key, 'movie:tmdb:605');
  h.JE.jellyseerrUI.showSeasonSelectionModal(1437, 'tv', 'Firefly', { id: 1437, name: 'Firefly' }, false);
  await settle();
  assert.equal(h.seerr.seasons.length, 0, "Seerr's season picker never opens");
  assert.ok(h.document.querySelector('.je-sheet'));
  h.JE.arrAskSheet.close();
  await h.JE.jellyseerrUI.showCollectionRequestModal(10, 'The Matrix Collection', {});
  await settle();
  assert.equal(h.seerr.collection.length, 0, "Seerr's collection window never opens");
  assert.equal(h.seerr.modals.length, 1, 'the collection movies are listed to ask for');
});

test('JE mode: a collection Request lists its movies and asks Jellyfin Enhanced for the ticked ones (no Seerr write)', async t => {
  const h = setup(t);
  let seerrRan = 0;
  const button = seerrCard(h, { id: 10, mediaType: 'collection', name: 'The Matrix Collection' }, () => seerrRan++);
  click(h, button);
  await settle();
  assert.equal(seerrRan, 0);
  assert.deepEqual(h.seerr.details, [10]);
  const modal = h.seerr.modals.at(-1);
  assert.equal(modal.shown, 1);
  assert.equal(modal.options.subtitle, 'The Matrix Collection');
  const body = h.document.createElement('div');
  body.innerHTML = modal.options.bodyHtml;
  const boxes = [...body.querySelectorAll('.jellyseerr-collection-checkbox')];
  assert.deepEqual(boxes.map(b => [b.dataset.tmdbId, b.disabled, b.checked]), [['603', true, false], ['604', false, true], ['605', false, true]], 'what is here already is not asked for');
  assert.equal(body.querySelector('img[onerror]'), null, 'odd poster paths are left out');
  assert.equal(body.querySelector('.advanced, select'), null, "no Seerr servers, profiles or folders");
  const save = h.document.createElement('button');
  let closed = 0;
  await modal.options.onSave(body, save, () => { closed++; });
  await settle();
  assert.deepEqual(h.posts.map(p => p.body.input.key), ['movie:tmdb:604', 'movie:tmdb:605']);
  assert.equal(closed, 1);
  assert.equal(h.toasts.at(-1), translate('arr_collection_summary_asked', { n: 2 }));
  assert.equal(h.seerr.collection.length, 0);
});

test('JE mode: a collection with more than 20 movies to ask for ticks 20, says so, and asks for exactly the ticked ones', async t => {
  const h = setup(t);
  // One movie is here; 22 could be asked for.
  const parts = [{ id: 1, title: 'Dr. No', mediaInfo: { status: 5 } }, ...Array.from({ length: 22 }, (_, i) => ({ id: 100 + i, title: `Bond ${i + 1}` }))];
  h.JE.jellyseerrAPI.fetchCollectionDetails = async () => ({ id: 645, name: 'James Bond Collection', parts });
  let modalElement = null;
  let options = null;
  h.JE.jellyseerrModal.create = (o) => {
    options = o;
    modalElement = h.document.createElement('div');
    modalElement.innerHTML = o.bodyHtml;
    h.document.body.appendChild(modalElement);
    return { modalElement, show() {}, close() {} };
  };
  await h.JE.jellyseerrUI.showCollectionRequestModal(645, 'James Bond Collection', {});
  await settle();
  const boxes = [...modalElement.querySelectorAll('.jellyseerr-collection-checkbox')].slice(1);
  const change = box => box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.equal(boxes.filter(b => b.checked).length, 20, 'the first 20 are ticked');
  assert.deepEqual(boxes.slice(20).map(b => [b.checked, b.disabled]), [[false, true], [false, true]], 'no more can be ticked while 20 are');
  assert.equal(modalElement.querySelector('.je-arr-collection-cap').textContent, translate('arr_seerr_collection_cap', { n: 20 }));
  // Unticking one frees a tick for another; then the rest are held again.
  boxes[0].checked = false;
  change(boxes[0]);
  assert.equal(boxes[21].disabled, false);
  boxes[21].checked = true;
  change(boxes[21]);
  assert.deepEqual([boxes[0].disabled, boxes[20].disabled], [true, true]);
  // Ticked past 20 some other way: nothing is asked, the picker stays open and says why.
  boxes[20].disabled = false;
  boxes[20].checked = true;
  let closed = 0;
  await options.onSave(modalElement, h.document.createElement('button'), () => { closed++; });
  assert.deepEqual([h.posts.length, closed, h.toasts.at(-1)], [0, 0, translate('arr_seerr_collection_cap', { n: 20 })]);
  boxes[20].checked = false;
  change(boxes[20]);
  await options.onSave(modalElement, h.document.createElement('button'), () => { closed++; });
  await settle(60);
  assert.deepEqual(h.posts.map(p => p.body.input.key), [...boxes.slice(1, 20), boxes[21]].map(b => `movie:tmdb:${b.dataset.tmdbId}`));
  assert.equal(closed, 1);
});

test('JE mode: a collection with 20 or fewer movies to ask for ticks them all and has no limit note', async t => {
  const h = setup(t);
  let options = null;
  h.JE.jellyseerrModal.create = (o) => { options = o; return { show() {}, close() {} }; };
  await h.JE.jellyseerrUI.showCollectionRequestModal(10, 'The Matrix Collection', {});
  await settle();
  const body = h.document.createElement('div');
  body.innerHTML = options.bodyHtml;
  assert.equal(body.querySelector('.je-arr-collection-cap'), null);
  assert.equal(body.querySelectorAll('.jellyseerr-collection-checkbox:checked').length, 2);
});

test('JE mode: the 4K menu (Seerr puts it under <body>, outside its card) opens the 4K sheet for its own title', async t => {
  const h = setup(t);
  h.JE.core.ui = { addTouchTapListener() {} };
  h.JE.cdn = { url: () => '' };
  for (const file of ['seerr-status.js', 'ui/ui-icons.js', 'ui/ui-popover.js']) h.load(`jellyseerr/${file}`);
  let seerrRan = 0;
  const main = seerrCard(h, { id: 604, mediaType: 'movie', title: 'The Matrix Reloaded' }, () => seerrRan++);
  const group = h.document.createElement('div');
  group.className = 'jellyseerr-button-group';
  main.replaceWith(group);
  group.appendChild(main);
  h.JE.internals.jellyseerrUi.show4KPopup(group, { id: 604, mediaType: 'movie', title: 'The Matrix Reloaded', mediaInfo: { status4k: 1 } });
  const item = h.document.querySelector('body > .jellyseerr-4k-popup .jellyseerr-4k-popup-item[data-action="request4k"]');
  assert.ok(item, 'the menu is a child of <body>');
  let bodyRan = 0;
  h.document.body.addEventListener('click', () => bodyRan++);
  click(h, item);
  await settle();
  const sheet = h.document.querySelector('.je-sheet');
  assert.ok(sheet, 'the JE sheet opens');
  assert.match(sheet.textContent, /The Matrix Reloaded/);
  assert.equal(bodyRan + seerrRan, 0, "Seerr's handlers never see the click");
  assert.equal(h.document.querySelector('.jellyseerr-4k-popup'), null, 'the menu closes');
});

test('JE mode: after an ask a series card keeps its button (Request more reopens the sheet); a 4K ask leaves the standard button alone', async t => {
  const h = setup(t);
  h.JE.arrAskSheet = { open: async () => ({ ok: true, state: 'asked' }), openOrAsk: async () => ({ ok: true, state: 'asked' }), close() {} };
  const series = seerrCard(h, { id: 1437, mediaType: 'tv', name: 'Firefly' }, () => {});
  click(h, series);
  await settle();
  assert.equal(series.disabled, false);
  assert.equal(series.textContent, translate('arr_discover_request_more'));
  const movie = seerrCard(h, { id: 604, mediaType: 'movie', title: 'The Matrix Reloaded' }, () => {});
  const item = h.document.createElement('button');
  item.className = 'jellyseerr-4k-popup-item';
  item.dataset.action = 'request4k';
  item.dataset.tmdbId = '604';
  item.dataset.mediaType = 'movie';
  movie.closest('.jellyseerr-card').appendChild(item);
  click(h, item);
  await settle();
  assert.equal(movie.disabled, false);
  assert.equal(movie.textContent, 'Request');
});

test('JE mode: a Home Screen Sections request button opens the JE sheet for its card', async t => {
  const h = setup(t);
  let hssRan = 0;
  const card = h.document.createElement('div');
  card.className = 'discover-card';
  card.dataset.tmdbId = '1437';
  card.dataset.mediaType = 'tv';
  card.innerHTML = '<div class="cardText">Firefly</div>';
  const button = h.document.createElement('button');
  button.className = 'discover-requestbutton';
  button.addEventListener('click', () => hssRan++);
  card.appendChild(button);
  h.document.body.appendChild(card);
  click(h, button);
  await settle();
  assert.equal(hssRan, 0);
  assert.ok(h.document.querySelector('.je-sheet'));
});

test('Seerr mode: every Seerr control keeps its own behaviour', async t => {
  const h = setup(t, { jeMode: false, me: { ...MEMBER, backend: 'seerr' } });
  let seerrRan = 0;
  const button = seerrCard(h, { id: 603, mediaType: 'movie', title: 'The Matrix' }, () => seerrRan++);
  click(h, button);
  await settle();
  assert.equal(seerrRan, 1);
  assert.equal(h.posts.length, 0);
  assert.equal(h.JE.jellyseerrAPI.shouldShowAdvanced(), false);
  assert.equal(h.seerr.advanced, 1);
  h.JE.jellyseerrUI.showMovieRequestModal(603, 'The Matrix', {}, false);
  h.JE.jellyseerrUI.showSeasonSelectionModal(1437, 'tv', 'Firefly', {}, false);
  h.JE.jellyseerrUI.showCollectionRequestModal(1, 'x', {});
  assert.deepEqual([h.seerr.movie.length, h.seerr.seasons.length, h.seerr.collection.length], [1, 1, 1]);
  assert.equal(h.document.querySelector('.je-sheet'), null);
});

test("search: in JE mode JE's row replaces Seerr's (shown even with Seerr's search results on); Seerr mode is unchanged", async t => {
  const je = setup(t);
  const S = je.JE.internals.arrAskSearch;
  assert.equal(S.replacesSeerr(), true);
  assert.equal(S.allowed(MEMBER), true, "Seerr's search setting doesn't hide JE's row in JE mode");
  assert.equal(S.allowed({ ...MEMBER, canRequest: false }), false, 'Watchers get no row');
  const seerr = setup(t, { jeMode: false });
  assert.equal(seerr.JE.internals.arrAskSearch.replacesSeerr(), false);
  assert.equal(seerr.JE.internals.arrAskSearch.allowed(MEMBER), false, "in Seerr mode Seerr's row stays the only one");
});

test("the request sheet opens above Seerr's details window (it is opened from there in JE mode)", () => {
  const zIndexes = file => [...readFileSync(resolve(jsRoot, file), 'utf8').matchAll(/z-index:\s*(\d+)/g)].map(m => Number(m[1]));
  const sheet = /\.je-sheet-backdrop \{[^}]*z-index:\s*(\d+)/.exec(readFileSync(resolve(jsRoot, 'arr/ask/ask-sheet-styles.js'), 'utf8'));
  assert.ok(sheet, 'the backdrop has a z-index');
  assert.ok(Number(sheet[1]) > Math.max(...zIndexes('jellyseerr/moreinfo/more-info-modal-styles.js')), `sheet ${sheet[1]} vs the window's layers`);
});
