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
function setup(t, { jeMode = true, me = MEMBER, check = null, config = {}, realCollectionUi = false } = {}) {
  const posts = [];
  const checks = [];
  const toasts = [];
  const seerr = { movie: [], seasons: [], collection: [], advanced: 0, details: [], publicReads: [], modals: [] };
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
      if (path.startsWith('/acquire/requests/check')) {
        const said = { key: u.searchParams.get('key'), variant: u.searchParams.get('variant') };
        checks.push(said);
        return jsonResponse({ outcome: 'accepted', reason: 'check', check: check ? check(said.key, said.variant) : { key: said.key, variant: said.variant, canRequest: true } });
      }
      if (path.startsWith('/acquire/requests/quota')) return jsonResponse({ outcome: 'accepted', reason: 'quota', quota: { used: 0, limit: 7, remaining: 7, nextSlotAt: null, usedGb: 0, available: true } });
      if (path === '/tmdb/tv/1437') return jsonResponse({ seasons: [{ season_number: 1, episode_count: 14, air_date: '2002-09-20' }] });
      return jsonResponse({ outcome: 'denied', reason: 'not_found' }, 404);
    },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrRequestsEnabled: true, ArrRequestsJeMode: jeMode, JellyseerrEnabled: true, JellyseerrShowSearchResults: true, ...config },
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
        // Seerr's own collection (JE mode must never read it, A1) and Jellyfin Enhanced's public one.
        fetchCollectionDetails: async (id) => { seerr.details.push(id); return matrix(id); },
        fetchPublic: async (path) => { seerr.publicReads.push(path); return matrix(Number(/^\/collection\/(\d+)$/.exec(path)?.[1])); }
      },
      // Seerr's request window (recorded; its body is the HTML the window would show).
      jellyseerrModal: { create: (options) => { const m = { options, shown: 0, closed: 0 }; seerr.modals.push(m); return { show: () => { m.shown++; }, close: () => { m.closed++; } }; } }
    }
  });
  function matrix(id) {
    return { id, name: 'The Matrix Collection', parts: [
      { id: 603, title: 'The Matrix', releaseDate: '1999-03-31', posterPath: '/m.jpg', mediaInfo: { status: 5 } },
      { id: 604, title: 'The Matrix Reloaded', releaseDate: '2003-05-15' },
      { id: 605, title: 'The Matrix <Revolutions>', releaseDate: '2003-11-05', posterPath: '/x" onerror="evil()' }
    ] };
  }
  t.after(() => h.close());
  // Seerr's own collection window (the original the wrapper falls back to), over the recorded Seerr API.
  if (realCollectionUi) for (const m of ['jellyseerr/seerr-status.js', 'jellyseerr/ui/ui-request-modals.js']) h.load(m);
  for (const m of MODULES) h.load(m);
  return { ...h, get NATIVE() { return h.NATIVE; }, posts, toasts, seerr, checks };
}

async function settle(n = 20) {
  for (let i = 0; i < n; i++) await nextTurn();
}

// The viewer's click: a trusted event, as the browser dispatches it (native owners are minted only from those).
const click = (h, node) => h.trusted(node, new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));

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
  await h.JE.jellyseerrUI.showMovieRequestModal(605, 'The Matrix Revolutions', { id: 605, title: 'The Matrix Revolutions' }, false, h.NATIVE);
  await settle();
  assert.equal(h.seerr.movie.length, 0, "Seerr's movie modal never opens");
  assert.equal(h.posts.at(-1).body.input.key, 'movie:tmdb:605');
  h.JE.jellyseerrUI.showSeasonSelectionModal(1437, 'tv', 'Firefly', { id: 1437, name: 'Firefly' }, false, h.NATIVE);
  await settle();
  assert.equal(h.seerr.seasons.length, 0, "Seerr's season picker never opens");
  assert.ok(h.document.querySelector('.je-sheet'));
  h.JE.arrAskSheet.close();
  await h.JE.jellyseerrUI.showCollectionRequestModal(10, 'The Matrix Collection', {}, { operation: h.NATIVE });
  await settle();
  assert.equal(h.seerr.collection.length, 0, "Seerr's collection window never opens");
  assert.equal(h.seerr.modals.length, 1, 'the collection movies are listed to ask for');
});

test('native more-info season Request forwards its validated episode hint to the same JE sheet owner', async t => {
  const h = setup(t); const opened = [];
  h.JE.arrAskSheet = { open: async input => { opened.push(input); } };
  await h.JE.jellyseerrUI.showSeasonSelectionModal(1437, 'tv', 'Firefly', { id: 1437, name: 'Firefly', jeActionScope: { season: 1, episode: 2 } }, false, h.NATIVE);
  assert.equal(opened[0].initialSeason, 1);
  assert.equal(opened[0].initialEpisode, 2);
  assert.equal(opened[0].key, 'tv:tmdb:1437');
});

test('JE mode: a collection Request lists its movies and asks Jellyfin Enhanced for the ticked ones (no Seerr write)', async t => {
  const h = setup(t);
  let seerrRan = 0;
  const button = seerrCard(h, { id: 10, mediaType: 'collection', name: 'The Matrix Collection' }, () => seerrRan++);
  click(h, button);
  await settle();
  assert.equal(seerrRan, 0);
  assert.deepEqual(h.seerr.publicReads, ['/collection/10']);
  assert.deepEqual(h.seerr.details, [], 'JE mode never reads Seerr\'s collection');
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
  h.JE.openSurface(body, () => {}, modal.options.operation); // as the real modal shell registers it
  await h.pressIn(body, e => modal.options.onSave(body, save, () => { closed++; }, e));
  await settle();
  assert.deepEqual(h.posts.map(p => p.body.input.key), ['movie:tmdb:604', 'movie:tmdb:605']);
  assert.equal(closed, 1);
  assert.equal(h.toasts.at(-1), translate('arr_collection_summary_asked', { n: 2 }));
  assert.equal(h.seerr.collection.length, 0);
});

test('JE mode: a collection with more than 20 movies to ask for ticks 20, says so, and asks for exactly the ticked ones', async t => {
  const h = setup(t);
  // One movie is here; 22 could be asked for.
  const parts = [{ id: 1, title: 'Dr. No', releaseDate: '1962-10-05', mediaInfo: { status: 5 } }, ...Array.from({ length: 22 }, (_, i) => ({ id: 100 + i, title: `Bond ${i + 1}`, releaseDate: `${1963 + i}-01-01` }))];
  h.JE.jellyseerrAPI.fetchPublic = async () => ({ id: 645, name: 'James Bond Collection', parts });
  let modalElement = null;
  let options = null;
  h.JE.jellyseerrModal.create = (o) => {
    options = o;
    modalElement = h.document.createElement('div');
    modalElement.innerHTML = o.bodyHtml;
    h.document.body.appendChild(modalElement);
    return { modalElement, show() {}, close() {} };
  };
  await h.JE.jellyseerrUI.showCollectionRequestModal(645, 'James Bond Collection', {}, { operation: h.NATIVE });
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
  h.JE.openSurface(modalElement, () => {}, options.operation); // as the real modal shell registers it
  await h.pressIn(modalElement, e => options.onSave(modalElement, h.document.createElement('button'), () => { closed++; }, e));
  assert.deepEqual([h.posts.length, closed, h.toasts.at(-1)], [0, 0, translate('arr_seerr_collection_cap', { n: 20 })]);
  boxes[20].checked = false;
  change(boxes[20]);
  h.JE.openSurface(modalElement, () => {}, options.operation); // as the real modal shell registers it
  await h.pressIn(modalElement, e => options.onSave(modalElement, h.document.createElement('button'), () => { closed++; }, e));
  await settle(60);
  assert.deepEqual(h.posts.map(p => p.body.input.key), [...boxes.slice(1, 20), boxes[21]].map(b => `movie:tmdb:${b.dataset.tmdbId}`));
  assert.equal(closed, 1);
});

test('JE mode: the collection picker leaves out movies that are not out yet (no date or a later one), as a collection page does', async t => {
  const h = setup(t);
  const later = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  h.JE.jellyseerrAPI.fetchPublic = async () => ({ id: 2344, name: 'Avatar Collection', parts: [
    { id: 19995, title: 'Avatar', releaseDate: '2009-12-15' },
    { id: 76600, title: 'Avatar: The Way of Water', releaseDate: '2022-12-14', mediaInfo: { status: 5 } },
    { id: 83533, title: 'Avatar: Fire and Ash', releaseDate: later },
    { id: 216527, title: 'Avatar 4' }
  ] });
  let options = null;
  h.JE.jellyseerrModal.create = (o) => { options = o; return { show() {}, close() {} }; };
  await h.JE.jellyseerrUI.showCollectionRequestModal(2344, 'Avatar Collection', {}, { operation: h.NATIVE });
  await settle();
  const body = h.document.createElement('div');
  body.innerHTML = options.bodyHtml;
  const rows = [...body.querySelectorAll('.jellyseerr-collection-movie-row')];
  assert.deepEqual(rows.map(r => { const b = r.querySelector('.jellyseerr-collection-checkbox'); return [b.dataset.tmdbId, b.disabled, b.checked, 'jeAskable' in b.dataset]; }),
    [['19995', false, true, true], ['76600', true, false, false], ['83533', true, false, false], ['216527', true, false, false]]);
  assert.deepEqual(rows.map(r => r.lastElementChild.textContent), ['', translate('jellyseerr_btn_available'), translate('arr_collection_not_out'), translate('arr_collection_not_out')]);
  h.JE.openSurface(body, () => {}, options.operation); // as the real modal shell registers it
  await h.pressIn(body, e => options.onSave(body, h.document.createElement('button'), () => {}, e));
  await settle();
  assert.deepEqual(h.posts.map(p => p.body.input.key), ['movie:tmdb:19995'], 'only the movie that is out is asked for');
  const { released } = h.JE.internals.arrAskSeerr;
  assert.deepEqual(['2026-10-17', '2026-10-18', '', '2026-10', null].map(d => released({ releaseDate: d }, '2026-10-17')), [true, false, false, false, false]);
});

test('JE mode: the collection picker says Paused for movies whose drive is full, leaves them unticked and asks only for the others', async t => {
  // Mixed storage: The Matrix Reloaded is held on a full drive (the server pauses it); Revolutions would land on a roomy one.
  const block = { reason: 'low_disk', instance: 'Radarr (full)', folder: '/data/full/The Matrix Reloaded (2003)', free: 2097152, freePercent: 3, limitPercent: 10 };
  const h = setup(t, { check: (key, variant) => (key === 'movie:tmdb:604' ? { key, variant, canRequest: false, blocked: { reason: 'low_disk' } } : { key, variant, canRequest: true }) });
  let options = null;
  h.JE.jellyseerrModal.create = (o) => { options = o; return { show() {}, close() {} }; };
  await h.JE.jellyseerrUI.showCollectionRequestModal(2344, 'The Matrix Collection', {}, { operation: h.NATIVE });
  await settle();
  assert.deepEqual(h.checks, [{ key: 'movie:tmdb:604', variant: 'standard' }, { key: 'movie:tmdb:605', variant: 'standard' }],
    'every movie that could be asked for is checked first (not the one in the library)');
  const body = h.document.createElement('div');
  body.innerHTML = options.bodyHtml;
  const rows = [...body.querySelectorAll('.jellyseerr-collection-movie-row')];
  assert.deepEqual(rows.map(r => { const b = r.querySelector('.jellyseerr-collection-checkbox'); return [b.dataset.tmdbId, b.disabled, b.checked, 'jeAskable' in b.dataset]; }),
    [['603', true, false, false], ['604', true, false, false], ['605', false, true, true]]);
  assert.deepEqual(rows.map(r => r.lastElementChild.textContent), [translate('jellyseerr_btn_available'), translate('arr_ask_paused_storage'), '']);
  const notes = [...body.querySelectorAll('.je-ask-paused-note')];
  assert.equal(notes.length, 1, 'the paused line says why, once');
  assert.equal(notes[0].querySelector('.je-ask-paused-title').textContent, translate('arr_ask_paused_storage'));
  assert.equal(notes[0].querySelector('.je-ask-paused-text').textContent, translate('arr_ask_paused_storage_text', { contact: 'Dad' }));
  h.JE.openSurface(body, () => {}, options.operation); // as the real modal shell registers it
  await h.pressIn(body, e => options.onSave(body, h.document.createElement('button'), () => {}, e));
  await settle();
  assert.deepEqual(h.posts.map(p => p.body.input.key), ['movie:tmdb:605'], 'the paused movie is not asked for');

  // An administrator reads where and how much is free; every movie paused: nothing is ticked.
  const admin = setup(t, { me: { ...MEMBER, role: 'admin' }, check: (key, variant) => ({ key, variant, canRequest: false, blocked: block }) });
  let adminOptions = null;
  admin.JE.jellyseerrModal.create = (o) => { adminOptions = o; return { show() {}, close() {} }; };
  await admin.JE.jellyseerrUI.showCollectionRequestModal(2344, 'The Matrix Collection', {}, { operation: admin.NATIVE });
  await settle();
  const adminBody = admin.document.createElement('div');
  adminBody.innerHTML = adminOptions.bodyHtml;
  assert.equal(adminBody.querySelectorAll('.jellyseerr-collection-checkbox:checked').length, 0);
  assert.equal(adminBody.querySelectorAll('.je-ask-paused-note').length, 1, 'one line for one drive');
  assert.match(adminBody.querySelector('.je-ask-paused-text').textContent, /\/data\/full\/The Matrix Reloaded \(2003\)/);
});

test('JE mode: the collection picker shows a movie already asked for (on its way) as such and does not offer it again', async t => {
  const h = setup(t);
  // The status read (JE.arrStatus, through the plugin API): Reloaded is already asked for and looked for; Revolutions isn't.
  const statuses = {
    'movie:tmdb:604': { key: 'movie:tmdb:604', kind: 'movie', stage: 'looking', reason: { code: 'looking' }, attention: false, quiet: false, actions: [] },
    'movie:tmdb:605': { key: 'movie:tmdb:605', kind: 'movie', stage: 'notHere', reason: { code: 'not_in_arr' }, attention: false, quiet: true, actions: [] }
  };
  const reads = [];
  h.JE.core.api.plugin = async (path) => {
    reads.push(path);
    const keys = decodeURIComponent((/[?&]keys=([^&]*)/.exec(path) || [])[1] || '').split(',').filter(Boolean);
    return path.startsWith('/acquire/status?') ? { contact: 'Dad', lookingHours: 24, items: keys.map(key => statuses[key]).filter(Boolean) } : null;
  };
  let options = null;
  h.JE.jellyseerrModal.create = (o) => { options = o; return { show() {}, close() {} }; };
  await h.JE.jellyseerrUI.showCollectionRequestModal(2344, 'The Matrix Collection', {}, { operation: h.NATIVE });
  await settle();
  const body = h.document.createElement('div');
  body.innerHTML = options.bodyHtml;
  const rows = [...body.querySelectorAll('.jellyseerr-collection-movie-row')];
  assert.deepEqual(rows.map(r => { const b = r.querySelector('.jellyseerr-collection-checkbox'); return [b.dataset.tmdbId, b.disabled, b.checked]; }),
    [['603', true, false], ['604', true, false], ['605', false, true]]);
  assert.equal(rows[1].lastElementChild.textContent, translate('arr_status_looking'));
  assert.deepEqual(reads, ['/acquire/status?keys=movie%3Atmdb%3A604,movie%3Atmdb%3A605'], 'one status read for the movies that could be asked for');
  h.JE.openSurface(body, () => {}, options.operation); // as the real modal shell registers it
  await h.pressIn(body, e => options.onSave(body, h.document.createElement('button'), () => {}, e));
  await settle();
  assert.deepEqual(h.posts.map(p => p.body.input.key), ['movie:tmdb:605']);
});

test('JE mode: the collection picker still offers a movie whose status is unknown (the arrs can\'t be read) or a stage it doesn\'t know', async t => {
  const h = setup(t);
  // No request and Radarr's library can't be read: "nothing known" (service down), not an ask. A newer server's stage: not one either.
  const statuses = {
    'movie:tmdb:604': { key: 'movie:tmdb:604', kind: 'movie', stage: 'none', reason: { code: 'service_down' }, attention: false, quiet: true, actions: [] },
    'movie:tmdb:605': { key: 'movie:tmdb:605', kind: 'movie', stage: 'someNewStage', reason: { code: 'some_new_reason' }, attention: false, quiet: true, actions: [] }
  };
  h.JE.core.api.plugin = async (path) => {
    const keys = decodeURIComponent((/[?&]keys=([^&]*)/.exec(path) || [])[1] || '').split(',').filter(Boolean);
    return path.startsWith('/acquire/status?') ? { contact: 'Dad', lookingHours: 24, items: keys.map(key => statuses[key]).filter(Boolean) } : null;
  };
  let options = null;
  h.JE.jellyseerrModal.create = (o) => { options = o; return { show() {}, close() {} }; };
  await h.JE.jellyseerrUI.showCollectionRequestModal(2344, 'The Matrix Collection', {}, { operation: h.NATIVE });
  await settle();
  const body = h.document.createElement('div');
  body.innerHTML = options.bodyHtml;
  const rows = [...body.querySelectorAll('.jellyseerr-collection-movie-row')];
  assert.deepEqual(rows.map(r => { const b = r.querySelector('.jellyseerr-collection-checkbox'); return [b.dataset.tmdbId, b.disabled, b.checked]; }),
    [['603', true, false], ['604', false, true], ['605', false, true]]);
  assert.equal(body.querySelector('.je-arr-collection-known'), null, 'no status words for a movie nobody asked for');
  assert.deepEqual(h.checks.map(c => c.key), ['movie:tmdb:604', 'movie:tmdb:605'], 'the title check decides');
  h.JE.openSurface(body, () => {}, options.operation); // as the real modal shell registers it
  await h.pressIn(body, e => options.onSave(body, h.document.createElement('button'), () => {}, e));
  await settle();
  assert.deepEqual(h.posts.map(p => p.body.input.key), ['movie:tmdb:604', 'movie:tmdb:605']);
});

test('JE mode: a collection with 20 or fewer movies to ask for ticks them all and has no limit note', async t => {
  const h = setup(t);
  let options = null;
  h.JE.jellyseerrModal.create = (o) => { options = o; return { show() {}, close() {} }; };
  await h.JE.jellyseerrUI.showCollectionRequestModal(10, 'The Matrix Collection', {}, { operation: h.NATIVE });
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
  h.JE.internals.jellyseerrUi.show4KPopup(group, { id: 604, mediaType: 'movie', title: 'The Matrix Reloaded', mediaInfo: { status4k: 1 } }, h.NATIVE);
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
  h.JE.jellyseerrUI.showMovieRequestModal(603, 'The Matrix', {}, false, h.NATIVE);
  h.JE.jellyseerrUI.showSeasonSelectionModal(1437, 'tv', 'Firefly', {}, false, h.NATIVE);
  h.JE.jellyseerrUI.showCollectionRequestModal(1, 'x', {}, { operation: h.NATIVE });
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

/**
 * Seerr's more-info window (its action modules over a bare window with the mounts renderActions fills).
 * @param {Object} h Harness (setup).
 * @returns {{internal: Object, actions: HTMLElement}} The window's internals and its action mount.
 */
function moreInfoWindow(h) {
  for (const m of ['jellyseerr/seerr-status.js', 'jellyseerr/moreinfo/more-info-modal-data.js', 'jellyseerr/moreinfo/more-info-modal-badges.js', 'jellyseerr/moreinfo/more-info-modal-actions-tv.js', 'jellyseerr/moreinfo/more-info-modal-actions.js']) h.load(m);
  const modal = h.document.createElement('div');
  modal.className = 'je-more-info-modal';
  modal.innerHTML = ['je-status-chip', 'je-actions', 'je-downloads', 'je-secondary-actions', 'je-requested-by'].map(m => `<div data-mount="${m}"></div>`).join('');
  h.document.body.appendChild(modal);
  const internal = h.JE.internals.moreInfoModal;
  internal.state.currentModal = modal;
  return { internal, actions: modal.querySelector('[data-mount="je-actions"]') };
}

const PAUSED = (paused) => (key, variant) => (paused.includes(variant)
  ? { key, variant, canRequest: false, blocked: { reason: 'low_disk' } }
  : { key, variant, canRequest: true });

test('ordinary host pass recovers the SAME retained request node after a failed check, with bounded retries', async t => {
  const h = setup(t);
  const { internal, actions } = moreInfoWindow(h);
  const modal = actions.parentElement;
  modal.dataset.tmdbId = '604';
  let now = 10000, reads = 0;
  h.window.Date.now = () => now;
  const owner = h.JE.arrAsk;
  h.JE.arrAsk = { ...owner, check: async (...args) => {
    reads++;
    if (reads === 1) throw Error('transient');
    return owner.check(...args);
  } };
  for (const file of ['arr/actions/title-actions.js', 'arr/actions/title-actions-sheet.js', 'arr/actions/title-actions-hosts.js']) h.load(file);
  t.after(() => h.JE.titleActions.dispose());
  internal.renderActions({ id: 604, title: 'The Matrix Reloaded', mediaInfo: { status: 1 } }, 'movie');
  await settle();
  const control = actions.querySelector('.je-more-info-actions-row, .jellyseerr-request-button');
  assert.ok(control);
  assert.equal(control.dataset.jePauseChecked, undefined, 'failed check is not a final verdict');
  h.JE.initializeTitleActions();
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-more-info-opened', { detail: { modal, data: { id: 604 }, mediaType: 'movie' } }));
  for (let i = 0; i < 20; i++) h.JE.titleActions.scan();
  await settle();
  assert.equal(reads, 1, 'ordinary mutation passes respect the retry cooldown');
  now += 1000;
  h.JE.titleActions.scan();
  h.JE.titleActions.scan();
  await settle();
  assert.equal(reads, 2, 'one retry shared by overlapping ordinary passes');
  assert.equal(actions.querySelector('.je-more-info-actions-row, .jellyseerr-request-button'), control);
  assert.equal(control.dataset.jePauseChecked, '1');
});

test('a cloned final pause marker does not stand in for the owner verdict on a new node', async t => {
  const h = setup(t);
  const { internal, actions } = moreInfoWindow(h);
  let now = 10000;
  h.window.Date.now = () => now;
  internal.renderActions({ id: 604, title: 'The Matrix Reloaded', mediaInfo: { status: 1 } }, 'movie');
  await settle();
  const source = actions.querySelector('.je-more-info-actions-row, .jellyseerr-request-button');
  assert.equal(source.dataset.jePauseChecked, '1');
  const clone = source.cloneNode(true);
  source.replaceWith(clone);
  let release;
  h.JE.arrAsk = { ...h.JE.arrAsk, check: () => new Promise(resolve => { release = resolve; }) };
  now += 1000;
  const pending = internal.reconcilePaused(actions);
  await settle();
  assert.equal(clone.dataset.jePauseChecked, undefined, 'pending work on a new node is not a final marker');
  release({ canRequest: true });
  await pending;
  assert.equal(clone.dataset.jePauseChecked, '1');
});

test('failed pause work cannot retry as a later user and stops after three failed attempts', async t => {
  const h = setup(t);
  const { internal, actions } = moreInfoWindow(h);
  let now = 10000, reads = 0;
  h.window.Date.now = () => now;
  h.JE.arrAsk = { ...h.JE.arrAsk, me: async () => { reads++; throw Error('offline'); } };
  internal.renderActions({ id: 604, title: 'The Matrix Reloaded', mediaInfo: { status: 1 } }, 'movie');
  await settle();
  for (let i = 0; i < 6; i++) {
    now += 30000;
    await internal.reconcilePaused(actions).catch(() => {});
  }
  assert.equal(reads, 3, 'at most three attempts per render/session identity');
  internal.renderActions({ id: 604, title: 'The Matrix Reloaded', mediaInfo: { status: 1 } }, 'movie');
  await settle();
  const before = reads;
  h.window.ApiClient.getCurrentUserId = () => 'different-user';
  now += 30000;
  await internal.reconcilePaused(actions).catch(() => {});
  assert.equal(reads, before, 'abandoned work never captures the replacement identity');
});

test('JE mode: the more-info window says Paused before Request is pressed (movie, with the 4K choice kept when 4K can still be asked for)', async t => {
  const h = setup(t, { check: PAUSED(['standard']) });
  h.JE.pluginConfig.JellyseerrEnable4KRequests = true;
  const { internal, actions } = moreInfoWindow(h);
  internal.renderActions({ id: 604, title: 'The Matrix Reloaded', mediaInfo: { status: 1, status4k: 1 } }, 'movie');
  await settle();
  const note = actions.querySelector('.je-ask-paused-note');
  assert.ok(note, 'the paused line is shown up front');
  assert.equal(note.querySelector('.je-ask-paused-title').textContent, translate('arr_ask_paused_storage'));
  assert.equal(note.querySelector('.je-ask-paused-text').textContent, translate('arr_ask_paused_storage_text', { contact: 'Dad' }));
  assert.equal(actions.querySelector('.jellyseerr-split-main'), null, 'no standard Request to press');
  const buttons = [...actions.querySelectorAll('.jellyseerr-request-button')];
  assert.deepEqual(buttons.map(b => b.lastElementChild.textContent), [translate('jellyseerr_btn_request_4k')], '4K can still be asked for');
  assert.deepEqual(h.checks, [{ key: 'movie:tmdb:604', variant: 'standard' }, { key: 'movie:tmdb:604', variant: '4k' }]);
  assert.equal(h.toasts.length, 0, 'no refusal toast');
});

test('JE mode: the more-info window says Paused for a series and for a 4K-only button; nothing changes when asking works', async t => {
  const h = setup(t, { check: PAUSED(['standard', '4k']) });
  const { internal, actions } = moreInfoWindow(h);
  internal.renderActions({ id: 1437, name: 'Firefly', mediaInfo: { status: 1 } }, 'tv');
  await settle();
  assert.equal(actions.querySelector('.jellyseerr-request-button'), null);
  assert.equal(actions.querySelector('.je-ask-paused-title').textContent, translate('arr_ask_paused_storage'));
  assert.deepEqual(h.checks.at(-1), { key: 'tv:tmdb:1437', variant: 'standard' });

  // Standard copy here already, 4K offered alone: the 4K check says it is paused too.
  h.JE.pluginConfig.JellyseerrEnable4KRequests = true;
  internal.renderActions({ id: 605, title: 'The Matrix Revolutions', mediaInfo: { status: 5, jellyfinMediaId: 'x', status4k: 1 } }, 'movie');
  await settle();
  assert.equal(actions.querySelector('.jellyseerr-request-button'), null);
  assert.equal(actions.querySelectorAll('.je-ask-paused-note').length, 1);
  assert.deepEqual(h.checks.at(-1), { key: 'movie:tmdb:605', variant: '4k' });

  const ok = setup(t);
  const open = moreInfoWindow(ok);
  open.internal.renderActions({ id: 604, title: 'The Matrix Reloaded', mediaInfo: { status: 1 } }, 'movie');
  await settle();
  assert.equal(open.actions.querySelector('.je-ask-paused-note'), null);
  assert.equal(open.actions.querySelector('.jellyseerr-request-button').lastElementChild.textContent, translate('jellyseerr_btn_request'));
});

test('Seerr mode: the more-info window keeps its Request and checks nothing with Jellyfin Enhanced', async t => {
  const h = setup(t, { jeMode: false, me: { ...MEMBER, backend: 'seerr' }, check: PAUSED(['standard']) });
  const { internal, actions } = moreInfoWindow(h);
  internal.renderActions({ id: 604, title: 'The Matrix Reloaded', mediaInfo: { status: 1 } }, 'movie');
  await settle();
  assert.equal(actions.querySelector('.je-ask-paused-note'), null);
  assert.ok(actions.querySelector('.jellyseerr-request-button'));
  assert.equal(h.checks.length, 0);
});

test('JE mode: a viewer without a Seerr account gets the collection picker from Jellyfin Enhanced\'s public collection, not their Seerr account', async t => {
  const h = setup(t);
  const publicReads = [];
  h.JE.jellyseerrAPI.accountRefusal = async () => 'unlinked';
  h.JE.jellyseerrAPI.fetchPublic = async (path) => {
    publicReads.push(path);
    return { id: 2344, name: 'The Matrix Collection', parts: [
      { id: 603, mediaType: 'movie', title: 'The Matrix', releaseDate: '1999-03-31', mediaInfo: { status: 5, jellyfinMediaId: 'abc' } },
      { id: 604, mediaType: 'movie', title: 'The Matrix Reloaded', releaseDate: '2003-05-15' }
    ] };
  };
  await h.JE.jellyseerrUI.showCollectionRequestModal(2344, 'The Matrix Collection', null, { operation: h.NATIVE });
  await settle();
  assert.deepEqual(publicReads, ['/collection/2344']);
  assert.deepEqual(h.seerr.details, [], 'nothing read through the viewer\'s Seerr account');
  const body = h.seerr.modals.at(-1).options.bodyHtml;
  assert.match(body, /data-tmdb-id="603"[^>]*disabled/);
  assert.match(body, /data-tmdb-id="604"[^>]*data-je-askable="1" checked/);
  assert.equal(h.toasts.length, 0);

  // With a Seerr account, or Seerr off altogether: still Jellyfin Enhanced's public collection (JE mode never reads Seerr, A1).
  h.JE.jellyseerrAPI.accountRefusal = async () => null;
  await h.JE.jellyseerrUI.showCollectionRequestModal(2344, 'The Matrix Collection', null, { operation: h.NATIVE });
  await settle();
  assert.deepEqual([publicReads, h.seerr.details], [['/collection/2344', '/collection/2344'], []]);
});

test('JE mode: the more-info window with public details says in one line that Seerr\'s own request details need a Seerr account', async t => {
  const h = setup(t);
  const { internal } = moreInfoWindow(h);
  const note = () => h.document.querySelector('[data-mount="je-requested-by"] .je-more-info-public-note');
  internal.renderActions({ id: 604, title: 'The Matrix Reloaded', jePublicDetails: true }, 'movie');
  await settle();
  assert.equal(note()?.textContent, translate('jellyseerr_modal_public_details'));
  internal.renderActions({ id: 604, title: 'The Matrix Reloaded', jePublicDetails: false, mediaInfo: { status: 1 } }, 'movie');
  await settle();
  assert.equal(note(), null, 'details read through the viewer\'s own account: no line');
});

test('UX-12: with Seerr off the JE-mode more-info window shows no Seerr-account line and never asks Seerr for a quota', async t => {
  const h = setup(t, { config: { JellyseerrEnabled: false, SeerrAvailable: false } });
  const { internal } = moreInfoWindow(h);
  const quotaReads = [];
  h.JE.jellyseerrAPI.fetchUserQuota = async () => { quotaReads.push('quota'); return null; };
  const note = () => h.document.querySelector('[data-mount="je-requested-by"] .je-more-info-public-note');
  for (const mediaType of ['movie', 'tv']) {
    internal.renderActions({ id: 604, title: 'The Matrix Reloaded', name: 'Firefly', jePublicDetails: true, mediaInfo: { status: 1 } }, mediaType);
    await settle();
    assert.equal(note(), null, `${mediaType}: no "needs a Seerr account" line`);
  }
  assert.deepEqual(quotaReads, [], 'no Seerr quota read for public details');
});

test('UX-12 control: Seerr on, details read through the viewer\'s own Seerr account still draw Seerr\'s quota chip; public details keep the account line', async t => {
  const h = setup(t, { jeMode: false, config: { SeerrAvailable: true } });
  const { internal } = moreInfoWindow(h);
  const quotaReads = [];
  h.JE.jellyseerrAPI.fetchUserQuota = async () => { quotaReads.push('quota'); return null; };
  internal.renderActions({ id: 604, title: 'The Matrix Reloaded', jePublicDetails: false, mediaInfo: { status: 1 } }, 'movie');
  await settle();
  assert.deepEqual(quotaReads, ['quota']);
  internal.renderActions({ id: 604, title: 'The Matrix Reloaded', jePublicDetails: true, mediaInfo: { status: 1 } }, 'movie');
  await settle();
  assert.equal(h.document.querySelector('[data-mount="je-requested-by"] .je-more-info-public-note')?.textContent, translate('jellyseerr_modal_public_details'));
  assert.deepEqual(quotaReads, ['quota'], 'public details: no quota read');
});

test('a request toast shows a translation\'s icon as its emoji, never as escaped markup (A1 live finding)', async t => {
  const h = setup(t);
  h.JE.arrAsk.toast('<span class="je-emoji">❌</span> Failed to load collection details');
  assert.equal(h.toasts.at(-1), '❌ Failed to load collection details');
  // Anything else stays text.
  h.JE.arrAsk.toast('<b>bold</b>');
  assert.equal(h.toasts.at(-1), '<b>bold</b>');
});

// A1 fix round 1 (A1-SOUND-02): with Jellyfin Enhanced the request backend (public config NativeAbsentDetails.Source
// "tmdb") a collection's View reads Jellyfin Enhanced's public collection whatever the request switches say; the request
// controls are gated apart. Seerr's window (Seerr's details) never opens for it.
const JE_BACKEND_ASKING_OFF = { ArrRequestsEnabled: false, NativeAbsentDetails: { Enabled: true, ContractVersion: 1, Source: 'tmdb' } };

test('JE backend, request controls off: the collection View is Jellyfin Enhanced\'s public collection to look at, never Seerr\'s window', async t => {
  for (const JellyseerrEnabled of [false, true]) {
    const h = setup(t, { jeMode: false, config: { ...JE_BACKEND_ASKING_OFF, JellyseerrEnabled } });
    const opened = [];
    h.JE.titleDetails = { show: (id, type, scope, owner) => { opened.push(['show', id, type, !!owner]); return true; }, openItem: (id) => { opened.push(['item', id]); } };
    h.JE.jellyseerrAPI.fetchPublic = async (path) => { h.seerr.publicReads.push(path); return { id: 2344, name: 'The Matrix Collection', parts: [
      { id: 603, title: 'The Matrix', releaseDate: '1999-03-31', mediaInfo: { status: 5, jellyfinMediaId: 'a'.repeat(32) } },
      { id: 604, title: 'The Matrix Reloaded', releaseDate: '2003-05-15', posterPath: '/r.jpg' },
      { id: 605, title: 'The Matrix Later', releaseDate: '2999-01-01' }
    ] }; };
    await h.JE.jellyseerrUI.showCollectionRequestModal(2344, 'The Matrix Collection', null, { operation: h.NATIVE });
    await settle();
    assert.deepEqual([h.seerr.collection.length, h.seerr.details.length], [0, 0], `Seerr's window and details stay shut (Seerr ${JellyseerrEnabled ? 'kept' : 'off'})`);
    assert.deepEqual(h.seerr.publicReads, ['/collection/2344']);
    const modal = h.seerr.modals.at(-1);
    assert.equal(modal.shown, 1);
    assert.equal(modal.options.closeOnly, true, 'nothing to submit');
    assert.equal(modal.options.subtitle, 'The Matrix Collection');
    const body = h.document.createElement('div');
    body.innerHTML = modal.options.bodyHtml;
    assert.equal(body.querySelector('input, .jellyseerr-collection-checkbox'), null, 'no ask controls');
    assert.deepEqual([...body.querySelectorAll('.je-arr-collection-view-row')].map(r => r.dataset.tmdbId), ['603', '604', '605']);
    assert.match(body.innerHTML, new RegExp(translate('jellyseerr_btn_available')));
    assert.match(body.innerHTML, new RegExp(translate('arr_collection_not_out')));
    assert.equal(h.posts.length, 0, 'nothing asked for');
  }
});

test('JE backend, request controls off: a row of the collection View opens its movie (the library copy, else its own page)', async t => {
  const h = setup(t, { jeMode: false, config: { ...JE_BACKEND_ASKING_OFF, JellyseerrEnabled: false } });
  const opened = [];
  h.JE.titleDetails = { show: (id, type, scope, owner) => { opened.push(['show', id, type, !!owner]); return true; }, openItem: (id) => { opened.push(['item', id]); } };
  h.JE.jellyseerrAPI.fetchPublic = async () => ({ id: 2344, name: 'The Matrix Collection', parts: [
    { id: 603, title: 'The Matrix', releaseDate: '1999-03-31', mediaInfo: { status: 5, jellyfinMediaId: 'a'.repeat(32) } },
    { id: 604, title: 'The Matrix Reloaded', releaseDate: '2003-05-15' }
  ] });
  // The real window shell around the recorded options, so its rows take the viewer's clicks.
  h.JE.jellyseerrModal.create = (options) => {
    const m = { options, shown: 0, closed: 0 };
    h.seerr.modals.push(m);
    const modalElement = h.document.createElement('div');
    modalElement.innerHTML = options.bodyHtml;
    h.document.body.appendChild(modalElement);
    return { modalElement, show: () => { m.shown++; }, close: () => { m.closed++; modalElement.remove(); } };
  };
  await h.JE.jellyseerrUI.showCollectionRequestModal(2344, 'The Matrix Collection', null, { operation: h.NATIVE });
  await settle();
  click(h, h.document.querySelector('.je-arr-collection-view-row[data-tmdb-id="604"] .title'));
  assert.deepEqual(opened, [['show', 604, 'movie', true]]);
  assert.equal(h.seerr.modals.at(-1).closed, 1);
  await h.JE.jellyseerrUI.showCollectionRequestModal(2344, 'The Matrix Collection', null, { operation: h.NATIVE });
  await settle();
  click(h, h.document.querySelector('.je-arr-collection-view-row[data-tmdb-id="603"]'));
  assert.deepEqual(opened.at(-1), ['item', 'a'.repeat(32)]);
});

test('JE backend, request controls off, through Seerr\'s real collection window module: Seerr\'s collection is never read', async t => {
  for (const JellyseerrEnabled of [false, true]) {
    const h = setup(t, { jeMode: false, realCollectionUi: true, config: { ...JE_BACKEND_ASKING_OFF, JellyseerrEnabled } });
    await h.JE.jellyseerrUI.showCollectionRequestModal(10, 'The Matrix Collection', null, { operation: h.NATIVE });
    await settle();
    assert.deepEqual(h.seerr.details, [], `fetchCollectionDetails never runs (Seerr ${JellyseerrEnabled ? 'kept' : 'off'})`);
    assert.deepEqual(h.seerr.publicReads, ['/collection/10']);
  }
  // Seerr mode: Seerr's own window and details, as before.
  const seerr = setup(t, { jeMode: false, realCollectionUi: true, config: { NativeAbsentDetails: { Enabled: true, ContractVersion: 1, Source: 'seerr' } } });
  // (Only its read is looked at: the rest of the window needs Seerr's form pieces, which are not loaded here.)
  await seerr.JE.jellyseerrUI.showCollectionRequestModal(10, 'The Matrix Collection', null, { operation: seerr.NATIVE }).catch(() => {});
  await settle();
  assert.deepEqual([seerr.seerr.details, seerr.seerr.publicReads], [[10], []]);
});

test('JE mode, a viewer who can\'t ask for movies: the collection View shows the collection to look at instead of a refusal', async t => {
  const WATCHER = { ...MEMBER, role: 'watcher', canRequest: false, canRequestMovies: false, canRequestSeries: false };
  const h = setup(t, { me: WATCHER, config: { NativeAbsentDetails: { Enabled: true, ContractVersion: 1, Source: 'tmdb' } } });
  await h.JE.jellyseerrUI.showCollectionRequestModal(10, 'The Matrix Collection', null, { operation: h.NATIVE });
  await settle();
  assert.deepEqual([h.seerr.collection.length, h.seerr.details.length, h.toasts.length], [0, 0, 0]);
  assert.equal(h.seerr.modals.at(-1)?.options.closeOnly, true);
  assert.equal(h.posts.length, 0);
});
