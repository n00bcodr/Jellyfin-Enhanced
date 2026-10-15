import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

const SERVER = '0202511b0eac4284ab045b3ba556d72e';
const MOVIE = '4a45ad11000a938e00000000f9c67720'; // the server's own vector (ApiNativeDetailsTests)
const wait = ms => new Promise(r => setTimeout(r, ms));
const PAGE = `<div id="itemDetailPage" class="page libraryPage itemDetailPage"><div class="detailPageContent"><div class="detailPagePrimaryContainer">
  <div class="mainDetailButtons"><button class="btnPlay detailButton">Play</button></div></div>
  <div class="detailPagePrimaryContent"><div class="detailSection"><div class="overview">Overview</div></div></div>
  <div class="card" data-id="PERSON"><a class="cardImageContainer" href="#">cast</a></div>
  <div class="card" data-id="0123456789abcdef0123456789abcdef"><a class="cardImageContainer" href="#">real</a></div></div></div>`;

/**
 * The navigator/adapter module in a fresh realm.
 * @param {object} t Test context.
 * @param {object} options Options.
 * @returns {object} Harness and probes.
 */
function setup(t, { cap = { Enabled: true, ContractVersion: 1 }, url = 'http://jellyfin.test/web/index.html#/home', getItem, html = '', ask = true, status = true, resolve, seerr = false, modalData, inApp = false } = {}) {
  const shown = [], modal = [], mounts = [], fetched = [], back = [], resolved = [], toggles = [], userChanges = [];
  const internal = modalData ? {
    fetchMediaDetails: async (id, type) => ({ ...modalData, id, mediaType: type }),
    fetchRatings: async () => ({ rt: { criticsScore: 92 } }),
    buildRatingLogos: () => '<span class="je-rating">92%</span>',
    buildRightPanel: (data, type, extra) => `<div class="je-more-info-right-panel">${data.status}|${extra.budget}|${data.mediaInfo === null ? 'no-media' : 'media'}<button class="je-collection-card-button" data-collection-id="726871" data-collection-name="Dune">View</button></div>`,
    buildTrailersSection: data => (data.relatedVideos?.length ? '<div class="trailers-section"><div class="trailers-grid"><a class="trailer-item">T</a></div></div>' : ''),
    formatCurrency: n => `$${n}`,
    buildStatusChip: () => Object.assign(h.document.createElement('span'), { className: 'seerr-chip', textContent: 'Requested' }),
    buildDownloadBars: () => null,
  } : undefined;
  const collections = [];
  const h = createHarness({
    html, url,
    JE: {
      pluginConfig: { NativeAbsentDetails: cap, JellyseerrEnabled: seerr || !!modalData },
      t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
      escapeHtml: text => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`),
      jellyseerrMoreInfo: { open: (...args) => modal.push(args) },
      jellyseerrUI: { showCollectionRequestModal: (...args) => collections.push(args) },
      seerrStatus: { hasStatus: s => s > 1 },
      internals: internal ? { moreInfoModal: internal, spoilerGuard: { appendSeerrToggle: (mount, data, type) => { toggles.push([data.id, type]); mount.append('spoiler'); } } } : {},
      core: { api: { plugin: async path => { resolved.push(path); return resolve ? resolve(path) : null; } } },
      session: { onUserChange: (_name, fn) => userChanges.push(fn) },
      arrStatus: {
        enabled: () => status,
        fetchKey: async key => { fetched.push(key); return { items: [{ key, stage: 'notHere' }], since: null }; },
        buildPill: s => Object.assign(h.document.createElement('div'), { className: 'je-arr-status', textContent: s.stage }),
        subscribe: () => () => {},
      },
      arrAsk: { enabled: () => ask },
      arrAskSheet: ask ? { mount: (container, title, options) => { const m = { title, options, updates: [], destroyed: false }; mounts.push(m); container.append('Request'); return { update: s => m.updates.push(s), destroy: () => { m.destroyed = true; } }; } } : undefined,
    },
    apiClient: { serverId: () => SERVER, getItem: getItem || (async () => { throw new Error('unexpected getItem'); }) },
  });
  h.window.Emby = { Page: { show: path => shown.push(path) } };
  h.window.history.back = () => back.push(true);
  // jellyfin-web's router numbers its entries: idx > 0 is a page reached from inside Jellyfin.
  if (inApp) h.window.history.replaceState({ usr: null, key: 'k', idx: 1 }, '');
  t.after(() => h.close());
  h.load('jellyseerr/nativedetails/native-details.js');
  return { ...h, td: h.JE.titleDetails, shown, modal, mounts, fetched, back, resolved, toggles, collections, userChanges };
}

test('synthetic ids match the server codec, parse back and stay on their server', t => {
  const h = setup(t);
  assert.equal(h.td.syntheticId('movie', 693134), MOVIE);
  assert.deepEqual({ ...h.td.parse(MOVIE) }, { kind: 'movie', tmdbId: 693134, season: 0, episode: 0 });
  const episode = h.td.syntheticId('episode', 83867, 1, 12);
  assert.deepEqual({ ...h.td.parse(episode.replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-').toUpperCase()) }, { kind: 'episode', tmdbId: 83867, season: 1, episode: 12 });
  assert.equal(h.td.isSynthetic('0123456789abcdef0123456789abcdef'), false);
  assert.equal(h.td.isSynthetic(MOVIE.slice(0, 31) + (MOVIE.endsWith('0') ? '1' : '0')), false);
  assert.equal(h.td.parse(MOVIE, '1111111b0eac4284ab045b3ba556d72e'), null);
  assert.equal(h.td.syntheticId('movie', -1), null);
  assert.equal(h.td.syntheticId('collection', 5), null);
  // The pages a title links to share the codec (the server's vectors, ApiNativeDetailsTests).
  assert.equal(h.td.syntheticId('person', 3810), '4a45ad1500000ee200000000f845f0a8');
  assert.equal(h.td.syntheticId('genre', 10765), '4a45ad1600002a0d0000000061de6198');
  for (const kind of ['person', 'genre', 'studio', 'network']) assert.equal(h.td.parse(h.td.syntheticId(kind, 77)).kind, kind);
  assert.equal(h.td.syntheticId('genre', 77, 1), h.td.syntheticId('genre', 77, 1), 'stable');
});

for (const [name, cap] of [['missing', null], ['off', { Enabled: false, ContractVersion: 1 }], ['unknown contract', { Enabled: true, ContractVersion: 2 }]]) {
  test(`capability ${name}: open() leaves the caller its own destination`, t => {
    const h = setup(t, { cap });
    assert.equal(h.td.available(), false);
    assert.equal(h.td.open(693134, 'movie'), false);
    assert.deepEqual(h.shown, []);
  });
}

test('open() goes to the native details route on this server', t => {
  const h = setup(t);
  assert.equal(h.td.available(), true);
  assert.equal(h.td.open(693134, 'movie'), true);
  assert.equal(h.td.open('83867', 'tv'), true);
  assert.equal(h.td.open(5, 'collection'), false);
  assert.deepEqual(h.shown, [`/details?id=${MOVIE}&serverId=${SERVER}`, `/details?id=${h.td.syntheticId('series', 83867)}&serverId=${SERVER}`]);
});

test('a synthetic movie page hides native actions and holds the request controls by key', async t => {
  const item = { Id: MOVIE, Type: 'Movie', Name: 'Dune: Part Two', ProductionYear: 2024, ProviderIds: { Tmdb: '693134' } };
  const h = setup(t, { html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`, getItem: async (user, id) => (assert.equal(id, MOVIE), item) });
  await h.JE.internals.nativeDetails.onView();
  const page = h.document.getElementById('itemDetailPage');
  assert.ok(page.classList.contains('je-native-absent'));
  const css = h.document.getElementById('je-native-absent-style').textContent;
  for (const sel of ['.btnPlay', '.btnShuffle', '.btnPlaystate', '.btnUserRating', '.btnMoreCommands', '.je-detail-hide-btn', '.je-spoiler-blur-btn', '[data-id^="4a45ad1"] .je-hide-btn']) assert.ok(css.includes(`.je-native-absent ${sel}`), sel);
  // Where it opens is asked once (a copy here would win).
  assert.deepEqual(h.resolved, [`/native-details/resolve?id=${MOVIE}`]);
  assert.equal(h.mounts.length, 1);
  assert.deepEqual({ ...h.mounts[0].title }, { key: 'movie:tmdb:693134', kind: 'movie', name: 'Dune: Part Two', year: 2024 });
  // The details surface has its own Notify me button and reads the status: the mount leaves both to it.
  assert.deepEqual({ ...h.mounts[0].options }, { notify: false });
  assert.deepEqual(h.fetched, []);
  const actions = page.querySelector('.je-native-absent-actions');
  assert.ok(actions && actions.parentElement.classList.contains('detailSection') && actions === actions.parentElement.firstElementChild);
  assert.deepEqual([...actions.children].map(n => n.className), ['je-native-absent-status', 'je-native-absent-row je-native-absent-request', 'je-native-absent-ratings']);
  // Leaving the page disposes the mount.
  h.window.location.hash = '#/home';
  await h.JE.internals.nativeDetails.onView();
  assert.equal(h.mounts[0].destroyed, true);
  assert.equal(page.querySelector('.je-native-absent-actions'), null);
});

test('without the details surface the mount reads and follows the status itself, with its Notify me', async t => {
  const item = { Id: MOVIE, Type: 'Movie', Name: 'Dune: Part Two', ProviderIds: { Tmdb: '693134' } };
  const h = setup(t, { status: false, html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`, getItem: async () => item });
  await h.JE.internals.nativeDetails.onView();
  await wait(10);
  assert.deepEqual({ ...h.mounts[0].options }, { notify: true });
  assert.deepEqual(h.fetched, ['movie:tmdb:693134']);
  assert.equal(h.mounts[0].updates[0].stage, 'notHere');
});

test('series and seasons leave Request to the smart actions; the request feature off gives Request through the modal', async t => {
  const series = 'S';
  const h0 = setup(t);
  const id = h0.td.syntheticId('series', 83867);
  const item = { Id: id, Type: 'Series', Name: 'Andor', ProviderIds: { Tmdb: '83867', Tvdb: '393189' } };
  const on = setup(t, { html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${id}&serverId=${SERVER}`, getItem: async () => item });
  await on.JE.internals.nativeDetails.onView();
  assert.equal(on.mounts.length, 0);
  assert.equal(on.document.querySelector('.je-native-absent-legacy-request'), null);
  assert.equal(on.JE.internals.nativeDetails.current().key, 'tv:tvdb:393189');
  const off = setup(t, { ask: false, seerr: true, html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${id}&serverId=${SERVER}`, getItem: async () => item });
  await off.JE.internals.nativeDetails.onView();
  const legacy = off.document.querySelector('.je-native-absent-legacy-request');
  assert.ok(legacy, series);
  legacy.click();
  assert.deepEqual(off.modal, [[83867, 'tv']]);
});

test('the modal\'s information, trailers, ratings, collection and spoiler switch are drawn on the page by its own builders', async t => {
  const item = { Id: MOVIE, Type: 'Movie', Name: 'Dune: Part Two', ProviderIds: { Tmdb: '693134' } };
  const h = setup(t, {
    html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`, getItem: async () => item,
    modalData: { status: 'Released', budget: 190000000, releaseDate: '2024-02-27', relatedVideos: [{ type: 'Trailer' }], mediaInfo: { jellyfinMediaId: 'abc' } },
  });
  await h.JE.internals.nativeDetails.onView();
  await wait(20);
  const extras = h.document.querySelector('.je-native-absent-extras');
  assert.ok(extras);
  // Seerr's own library id is never offered as Open: only the server-checked copy is.
  assert.match(extras.textContent, /Released\|\$190000000\|no-media/);
  assert.ok(extras.querySelector('.trailer-item'));
  assert.ok(extras.querySelector('.je-native-absent-spoiler'));
  assert.deepEqual(h.toggles, [[693134, 'movie']]);
  assert.ok(h.document.querySelector('.je-native-absent-ratings .je-rating'));
  extras.querySelector('.je-collection-card-button').click();
  assert.deepEqual(h.collections, [[726871, 'Dune']]);
});

test('a deep link to a title that is in the library now goes to its copy in the page\'s place', async t => {
  const copy = '0123456789abcdef0123456789abcdef';
  const h = setup(t, {
    html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`,
    getItem: async () => ({ Id: MOVIE, Type: 'Movie', Name: 'Dune: Part Two' }), resolve: () => ({ itemId: copy }),
  });
  await h.JE.internals.nativeDetails.onView();
  assert.equal(h.window.location.hash, `#/details?id=${copy}&serverId=${SERVER}`);
  assert.equal(h.mounts.length, 0);
  assert.equal(h.document.querySelector('.je-native-absent-actions'), null);
});

test('a copy that arrives while the page is open gets Open; the page and its request state stay', async t => {
  const copy = '0123456789abcdef0123456789abcdef';
  const h = setup(t, { html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`, getItem: async () => ({ Id: MOVIE, Type: 'Movie', Name: 'Dune: Part Two' }) });
  await h.JE.internals.nativeDetails.onView();
  const page = h.document.getElementById('itemDetailPage');
  const nd = h.JE.internals.nativeDetails;
  // A status block the details surface rendered before the slot existed moves into the slot.
  const block = h.document.createElement('div');
  block.className = 'je-arr-status';
  block.dataset.jeArrSurface = 'details';
  page.querySelector('.detailSection').appendChild(block);
  nd.statusShown(page, { stage: 'notHere' });
  assert.equal(page.querySelector('.je-native-absent-status').firstElementChild, block);
  assert.equal(page.querySelector('.je-native-absent-open'), null);
  nd.statusShown(page, { stage: 'ready', openItemId: MOVIE }); // a page id is never a copy
  assert.equal(page.querySelector('.je-native-absent-open'), null);
  nd.statusShown(page, { stage: 'ready', openItemId: copy });
  // The Request mount follows the status the details surface read.
  assert.deepEqual(h.mounts[0].updates.map(u => u.stage), ['notHere', 'ready', 'ready']);
  const open = page.querySelector('.je-native-absent-open');
  assert.ok(open);
  assert.equal(h.mounts[0].destroyed, false);
  open.click();
  assert.deepEqual(h.shown, [`/details?id=${copy}&serverId=${SERVER}`]);
  nd.statusShown(page, { stage: 'ready', openItemId: null });
  assert.equal(page.querySelector('.je-native-absent-open'), null);
});

test('a page shown again (Back, restore) is checked again and refused when it may no longer be opened', async t => {
  let calls = 0;
  let allowed = true;
  const h = setup(t, {
    html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`,
    getItem: async () => { calls++; if (!allowed) throw Object.assign(new Error('gone'), { status: 404 }); return { Id: MOVIE, Type: 'Movie', Name: 'Dune' }; },
  });
  await h.JE.internals.nativeDetails.onView();
  assert.equal(h.mounts.length, 1);
  allowed = false;
  await h.JE.internals.nativeDetails.onView();
  assert.equal(calls, 2);
  assert.equal(h.resolved.length, 1); // where it opens is asked once per page
  const page = h.document.getElementById('itemDetailPage');
  const box = h.document.querySelector('.je-native-absent-refusal');
  assert.ok(box);
  assert.equal(h.mounts[0].destroyed, true);
  assert.deepEqual(h.modal, []);
  // The restored view's own content (title, overview, cast) is hidden: only the refusal shows.
  const display = n => h.window.getComputedStyle(n).display;
  assert.equal(box.parentElement, page);
  assert.equal(display(page.querySelector('.detailPageContent')), 'none');
  assert.notEqual(display(box), 'none');
  // Only the page's content: the rest of Jellyfin (header, drawer) stays.
  assert.notEqual(display(h.document.body), 'none');
  assert.ok(h.document.documentElement.classList.contains('je-native-absent-refused-view'));
  // A later check that passes shows the page again.
  allowed = true;
  await h.JE.internals.nativeDetails.onView();
  assert.equal(h.document.querySelector('.je-native-absent-refusal'), null);
  assert.notEqual(display(page.querySelector('.detailPageContent')), 'none');
  assert.equal(h.document.documentElement.classList.contains('je-native-absent-refused-view'), false);
  // Leaving for an ordinary page ends the page-wide part of a refusal too.
  allowed = false;
  await h.JE.internals.nativeDetails.onView();
  assert.ok(h.document.documentElement.classList.contains('je-native-absent-refused-view'));
  h.window.location.hash = '#/details?id=0123456789abcdef0123456789abcdef';
  await h.JE.internals.nativeDetails.onView();
  assert.equal(h.document.documentElement.classList.contains('je-native-absent-refused-view'), false);
});

test('a status read before the Request mount exists is where the mount starts', async t => {
  let release;
  const gate = new Promise(r => { release = r; });
  const h = setup(t, {
    html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`,
    getItem: async () => { await gate; return { Id: MOVIE, Type: 'Movie', Name: 'Dune' }; },
  });
  const nd = h.JE.internals.nativeDetails;
  const viewing = nd.onView();
  await wait(5);
  // The details surface answers first (the item read is slow): Asked.
  const page = h.document.getElementById('itemDetailPage');
  nd.statusShown(page, { stage: 'asked', reason: { code: 'awaiting_approval' } });
  assert.equal(h.mounts.length, 0);
  release();
  await viewing;
  assert.equal(h.mounts.length, 1);
  assert.deepEqual(h.mounts[0].updates.map(u => u?.stage), ['asked']);
});

test('the navigator: native page, scoped pages, the modal as fallback, provider keys through the server', async t => {
  const h = setup(t, { resolve: path => (path.includes('movie%3Atmdb%3A45745') ? { itemId: '0123456789abcdef0123456789abcdef' } : path.includes('tv%3Atvdb%3A393189') ? { id: '4a45ad130001479b0001000092805890' } : null) });
  assert.equal(h.td.show(83867, 'tv', { season: 1, episode: 3 }), true);
  assert.equal(h.shown[0], `/details?id=${h.td.syntheticId('episode', 83867, 1, 3)}&serverId=${SERVER}`);
  assert.equal(h.td.open(83867, 'tv', { season: 2 }), true);
  assert.equal(h.shown[1], `/details?id=${h.td.syntheticId('season', 83867, 2)}&serverId=${SERVER}`);
  assert.equal(await h.td.openKey('movie:tmdb:45745'), true);
  assert.equal(h.shown[2], `/details?id=0123456789abcdef0123456789abcdef&serverId=${SERVER}`);
  assert.equal(await h.td.openKey('tv:tvdb:393189', { season: 1 }), true);
  assert.ok(h.resolved.at(-1).includes('season=1'));
  // A forged answer is never followed; the modal opens once instead when the TMDB id is known.
  assert.equal(await h.td.openKey('movie:tmdb:438631'), true);
  assert.deepEqual(h.modal, [[438631, 'movie']]);
  assert.equal(await h.td.openKey('tv:tvdb:5', { modal: false }), false);
  assert.equal(h.shown.length, 4);
  // Capability off: show() is the modal, open() leaves the caller its way.
  const off = setup(t, { cap: null });
  assert.equal(off.td.show(693134, 'movie'), true);
  assert.deepEqual(off.modal, [[693134, 'movie']]);
  assert.equal(await off.td.openKey('tv:tvdb:393189'), false);
  assert.deepEqual(off.resolved, []);
});

for (const status of [404, 403]) test(`a refused title (${status}) shows a neutral refusal, never the modal`, async t => {
  const h = setup(t, { html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`, getItem: async () => { throw Object.assign(new Error('no'), { status }); } });
  await h.JE.internals.nativeDetails.onView();
  await wait(400);
  const box = h.document.querySelector('.je-native-absent-refusal');
  assert.ok(box && box.textContent.includes('native_details_unavailable'));
  assert.deepEqual(h.modal, []);
  assert.deepEqual(h.back, []);
  assert.equal(h.mounts.length, 0);
});

test('an outage goes back and opens the modal once', async t => {
  const h = setup(t, { inApp: true, html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`, getItem: async () => { throw Object.assign(new Error('down'), { status: 503 }); } });
  await h.JE.internals.nativeDetails.onView();
  await wait(400);
  assert.deepEqual(h.back, [true]);
  assert.deepEqual(h.modal, [[693134, 'movie']]);
});

test('the modal after an outage opens only over the page Back landed on, for the same viewer, with no refusal since', async t => {
  const outage = async () => { throw Object.assign(new Error('down'), { status: 503 }); };
  const at = `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`;
  // Back lands on Home: the modal opens over it.
  let h = setup(t, { inApp: true, html: PAGE, url: at, getItem: outage });
  h.window.history.back = () => { h.back.push(true); h.window.location.hash = '#/home'; };
  await h.JE.internals.nativeDetails.onView();
  await wait(400);
  assert.deepEqual(h.modal, [[693134, 'movie']]);
  // The viewer moves on from where Back took them before it fires: no modal over the other page.
  h = setup(t, { inApp: true, html: PAGE, url: at, getItem: outage });
  h.window.history.back = () => { h.back.push(true); h.window.location.hash = '#/home'; };
  await h.JE.internals.nativeDetails.onView();
  await wait(30);
  h.window.location.hash = '#/movies';
  await wait(400);
  assert.deepEqual(h.back, [true]);
  assert.deepEqual(h.modal, []);
  // Back lands on a page that is refused now: the refusal stands, no modal over it.
  let reads = 0;
  h = setup(t, { inApp: true, html: PAGE, url: at, getItem: async () => { reads++; throw Object.assign(new Error('x'), { status: reads === 1 ? 503 : 404 }); } });
  h.window.history.back = () => { h.back.push(true); h.window.location.hash = `#/details?id=${h.td.syntheticId('series', 83867)}&serverId=${SERVER}`; };
  await h.JE.internals.nativeDetails.onView();
  await wait(30);
  await h.JE.internals.nativeDetails.onView();
  await wait(400);
  assert.ok(h.document.querySelector('.je-native-absent-refusal'));
  assert.deepEqual(h.modal, []);
  // Another viewer signs in meanwhile: nothing opens for them (told by JE, or seen at the time).
  h = setup(t, { inApp: true, html: PAGE, url: at, getItem: outage });
  await h.JE.internals.nativeDetails.onView();
  h.userChanges.forEach(fn => fn());
  await wait(400);
  assert.deepEqual(h.back, [true]);
  assert.deepEqual(h.modal, []);
  h = setup(t, { inApp: true, html: PAGE, url: at, getItem: outage });
  h.window.ApiClient.getCurrentUserId = () => 'viewer-a';
  await h.JE.internals.nativeDetails.onView();
  h.window.ApiClient.getCurrentUserId = () => 'viewer-b';
  await wait(400);
  assert.deepEqual(h.back, [true]);
  assert.deepEqual(h.modal, []);
});

test('an outage on a page opened from outside Jellyfin stays in Jellyfin: the message, the modal over it, Home', async t => {
  const home = [];
  const h = setup(t, { html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`, getItem: async () => { throw Object.assign(new Error('down'), { status: 503 }); } });
  h.window.Emby.Page.goHome = () => home.push(true);
  await h.JE.internals.nativeDetails.onView();
  await wait(400);
  // Never Back (it would leave Jellyfin, or do nothing and leave the spinner).
  assert.deepEqual(h.back, []);
  assert.deepEqual(h.modal, [[693134, 'movie']]);
  const box = h.document.querySelector('.je-native-absent-refusal');
  assert.ok(box && box.textContent.includes('native_details_failed'));
  const button = box.querySelector('button');
  assert.equal(button.textContent, 'native_details_home');
  button.click();
  assert.deepEqual(home, [true]);
  assert.deepEqual(h.back, []);
});

test('a page reached by a plain hash change after Jellyfin moved between pages still goes back', async t => {
  const h = setup(t, { html: PAGE, url: 'http://jellyfin.test/web/index.html#/home', getItem: async () => { throw Object.assign(new Error('down'), { status: 503 }); } });
  h.window.location.hash = `#/details?id=${MOVIE}&serverId=${SERVER}`;
  await wait(20);
  await h.JE.internals.nativeDetails.onView();
  await wait(400);
  assert.deepEqual(h.back, [true]);
  assert.deepEqual(h.modal, [[693134, 'movie']]);
});

test('a second failure soon after says so on the page: no second fallback, no endless spinner', async t => {
  let hidden = 0;
  const h = setup(t, { inApp: true, html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`, getItem: async () => { throw Object.assign(new Error('down'), { status: 503 }); } });
  h.window.Dashboard = { hideLoadingMsg: () => { hidden++; } };
  await h.JE.internals.nativeDetails.onView();
  assert.equal(h.document.querySelector('.je-native-absent-refusal'), null);
  // The user closes the modal and clicks the same card again within the window.
  await h.JE.internals.nativeDetails.onView();
  await wait(400);
  assert.deepEqual(h.back, [true]);
  assert.deepEqual(h.modal, [[693134, 'movie']]);
  const box = h.document.querySelector('.je-native-absent-refusal');
  assert.ok(box && box.textContent.includes('native_details_failed'));
  assert.ok(box.querySelector('button'));
  assert.ok(hidden >= 1); // the loader is hidden (the module's own 350 ms first look may run once more)
  // A third try keeps one message, not a stack of them.
  await h.JE.internals.nativeDetails.onView();
  assert.equal(h.document.querySelectorAll('.je-native-absent-refusal').length, 1);
});

for (const [name, cap] of [['off', { Enabled: false, ContractVersion: 1 }], ['missing (10.11 server)', null]]) test(`capability ${name}: a synthetic deep link is left to native (no read, class, style or guard)`, async t => {
  let reads = 0;
  const h = setup(t, { cap, html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`, getItem: async () => { reads++; return {}; } });
  await h.JE.internals.nativeDetails.onView();
  await wait(400);
  assert.equal(reads, 0);
  assert.equal(h.document.getElementById('itemDetailPage').classList.contains('je-native-absent'), false);
  assert.equal(h.document.getElementById('je-native-absent-style'), null);
  assert.equal(h.document.querySelector('.je-native-absent-refusal'), null);
  assert.deepEqual(h.back, []);
  const card = h.document.querySelector('[data-id="0123456789abcdef0123456789abcdef"]');
  card.setAttribute('data-id', MOVIE);
  const menu = new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  card.dispatchEvent(menu);
  assert.equal(menu.defaultPrevented, false);
});

test('ordinary pages are left alone', async t => {
  let reads = 0;
  const h = setup(t, { html: PAGE, url: 'http://jellyfin.test/web/index.html#/details?id=0123456789abcdef0123456789abcdef', getItem: async () => { reads++; return {}; } });
  await h.JE.internals.nativeDetails.onView();
  assert.equal(reads, 0);
  assert.equal(h.document.getElementById('itemDetailPage').classList.contains('je-native-absent'), false);
  assert.equal(h.document.getElementById('je-native-absent-style'), null);
});

test('context menus on synthetic cards are blocked; a person card opens their page; real cards are left alone', t => {
  const h = setup(t, { html: PAGE });
  const person = h.td.syntheticId('person', 1190668);
  h.document.querySelector('[data-id="PERSON"]').setAttribute('data-id', person);
  const fire = (sel, type) => {
    const e = new h.window.MouseEvent(type, { bubbles: true, cancelable: true });
    h.document.querySelector(sel).dispatchEvent(e);
    return e.defaultPrevented;
  };
  // A cast member Jellyfin has no page for leads to their own page (the click goes through to jellyfin-web).
  assert.equal(fire(`[data-id="${person}"] a`, 'click'), false);
  assert.equal(fire(`[data-id="${person}"] a`, 'contextmenu'), true);
  assert.equal(fire('[data-id="0123456789abcdef0123456789abcdef"] a', 'click'), false);
  assert.equal(fire('[data-id="0123456789abcdef0123456789abcdef"] a', 'contextmenu'), false);
});

/**
 * Real Seerr result cards with the navigator.
 * @param {object} t Test context.
 * @param {object} options Options.
 * @returns {object} Harness and probes.
 */
function cards(t, { cap, useModal = true, item, resolve } = {}) {
  const shown = [], modal = [], resolved = [];
  const h = createHarness({
    html: '<div id="results"></div>',
    JE: {
      pluginConfig: { NativeAbsentDetails: cap, JellyseerrUseMoreInfoModal: useModal },
      t: key => key,
      escapeHtml: text => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`),
      seerrStatus: { MEDIA: { BLOCKED: 6 } },
      cdn: { url: (host, path) => `https://cdn.test/${host}/${path}`, selfhst: path => `https://cdn.test/selfhst/${path}` },
      jellyseerrMoreInfo: { open: (...args) => modal.push(args) },
      jellyseerrAPI: { resolveJellyseerrBaseUrl: () => 'https://seerr.test' },
      hiddenContent: { getSettings: () => ({ enabled: false }) },
      core: { ui: { addTouchTapListener: () => {}, addDelegatedTouchTapListener: () => {} }, api: { plugin: async path => { resolved.push(path); return resolve ? resolve(path) : null; } } },
    },
    apiClient: { serverId: () => SERVER },
  });
  h.window.Emby = { Page: { show: path => shown.push(path) } };
  t.after(() => h.close());
  for (const file of ['seerr-status', 'ui/ui-icons', 'ui/ui-popover', 'ui/ui-badges', 'ui/ui-cards', 'nativedetails/native-details']) h.load(`jellyseerr/${file}.js`);
  const card = h.JE.jellyseerrUI.createJellyseerrCard(item || { id: 693134, mediaType: 'movie', title: 'Dune: Part Two', posterPath: '/p.jpg', releaseDate: '2024-02-27', voteAverage: 8.1 }, true, true);
  h.document.getElementById('results').appendChild(card);
  return { ...h, card, shown, modal, resolved };
}

test('Seerr cards open the native page when it is offered', t => {
  const h = cards(t, { cap: { Enabled: true, ContractVersion: 1 } });
  const link = h.card.querySelector('a[data-tmdb-id]');
  const e = new h.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  link.dispatchEvent(e);
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(h.shown, [`/details?id=${MOVIE}&serverId=${SERVER}`]);
  assert.deepEqual(h.modal, []);
});

test('Seerr cards keep the modal when native details are off', t => {
  const h = cards(t, { cap: { Enabled: false, ContractVersion: 1 } });
  h.card.querySelector('a[data-tmdb-id]').dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  assert.deepEqual(h.shown, []);
  assert.deepEqual(h.modal, [[693134, 'movie']]);
});

test('the native page also wins over a Seerr link when the modal setting is off', t => {
  const h = cards(t, { cap: { Enabled: true, ContractVersion: 1 }, useModal: false });
  const e = new h.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  h.card.querySelector('a[data-tmdb-id]').dispatchEvent(e);
  assert.equal(e.defaultPrevented, true);
  assert.equal(h.shown.length, 1);
});

test('Enter on a focused Seerr poster opens the native page (Space keeps showing the overview with Request)', t => {
  const h = cards(t, { cap: { Enabled: true, ContractVersion: 1 } });
  const poster = h.card.querySelector('.jellyseerr-poster-image');
  const press = key => poster.dispatchEvent(new h.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  press('Enter');
  assert.deepEqual(h.shown, [`/details?id=${MOVIE}&serverId=${SERVER}`]);
});

test('a card Seerr says is in the library is checked for this viewer before it opens', async t => {
  const copy = '0123456789abcdef0123456789abcdef';
  const h = cards(t, {
    cap: { Enabled: true, ContractVersion: 1 },
    item: { id: 693134, mediaType: 'movie', title: 'Dune: Part Two', posterPath: '/p.jpg', mediaInfo: { status: 5, jellyfinMediaId: 'deadbeefdeadbeefdeadbeefdeadbeef' } },
    resolve: () => ({ itemId: copy })
  });
  const link = h.card.querySelector('.cardText-first a');
  link.setAttribute('href', '#!/details?id=deadbeefdeadbeefdeadbeefdeadbeef');
  const e = new h.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  link.dispatchEvent(e);
  assert.equal(e.defaultPrevented, true);
  await wait(10);
  assert.deepEqual(h.resolved, ['/native-details/resolve?key=movie%3Atmdb%3A693134']);
  assert.deepEqual(h.shown, [`/details?id=${copy}&serverId=${SERVER}`]);
});

test('a person page made from public data: Known for in place of the tagline, no request controls, no title lookups', async t => {
  const PERSON = '4a45ad1500000ee200000000f845f0a8';
  const item = { Id: PERSON, Type: 'Person', Name: 'Javier Bardem', Taglines: ['Acting'] };
  const h = setup(t, { html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${PERSON}&serverId=${SERVER}`, getItem: async (user, id) => (assert.equal(id, PERSON), item), modalData: { status: 'Released' } });
  await h.JE.internals.nativeDetails.onView();
  const page = h.document.getElementById('itemDetailPage');
  assert.ok(page.classList.contains('je-native-absent'));
  assert.ok(page.classList.contains('je-native-absent-person'));
  assert.ok(h.document.getElementById('je-native-absent-style').textContent.includes('#itemDetailPage.je-native-absent-person .tagline { display: none !important; }'));
  const line = page.querySelector('.je-native-absent-actions .je-native-absent-knownfor');
  assert.equal(line?.textContent, 'native_details_known_for:{"department":"Acting"}');
  // No where-it-opens lookup, request mount, status read or information panel: a person isn't a title.
  assert.deepEqual(h.resolved, []);
  assert.deepEqual(h.mounts, []);
  assert.deepEqual(h.fetched, []);
  await wait(10);
  assert.equal(page.querySelector('.je-native-absent-extras'), null);
  // Shown again (Back): checked again, Known for stays once.
  await h.JE.internals.nativeDetails.onView();
  assert.equal(page.querySelectorAll('.je-native-absent-knownfor').length, 1);
  // Leaving for a library title takes the person class away.
  h.window.location.hash = '#/details?id=0123456789abcdef0123456789abcdef';
  await h.JE.internals.nativeDetails.onView();
  assert.equal(page.classList.contains('je-native-absent-person'), false);
  assert.equal(page.querySelector('.je-native-absent-knownfor'), null);
});

test('a person page without a known department shows no line; refused or unloadable person pages say "page", no modal, no back', async t => {
  const PERSON = '4a45ad1500000ee200000000f845f0a8';
  let answer = { Id: PERSON, Type: 'Person', Name: 'Someone', Taglines: [] };
  const h = setup(t, { html: PAGE, inApp: true, url: `http://jellyfin.test/web/index.html#/details?id=${PERSON}&serverId=${SERVER}`, getItem: async () => { if (answer instanceof Error) throw answer; return answer; } });
  await h.JE.internals.nativeDetails.onView();
  assert.equal(h.document.querySelector('.je-native-absent-knownfor'), null);
  answer = Object.assign(new Error('404'), { status: 404 });
  await h.JE.internals.nativeDetails.onView();
  assert.match(h.document.querySelector('.je-native-absent-refusal').textContent, /^native_details_page_unavailable/);
  answer = Object.assign(new Error('503'), { status: 503 });
  h.window.location.hash = `#/details?id=${h.td.syntheticId('person', 77)}&serverId=${SERVER}`;
  await h.JE.internals.nativeDetails.onView();
  assert.match(h.document.querySelector('.je-native-absent-refusal').textContent, /^native_details_page_failed/);
  await wait(400);
  assert.deepEqual(h.modal, []);
  assert.deepEqual(h.back, []);
});

test('a discovery list page (a synthetic genre, studio or network) hides the empty list controls; library list pages are left alone', async t => {
  const LIST = '<div class="page libraryPage" id="listPage"><div class="itemsViewSettingsContainer"><div class="paging">0-0 of 0</div><button class="btnPlay">Play</button></div><div class="itemsContainer"></div></div>';
  const h = setup(t, { html: LIST, url: `http://jellyfin.test/web/index.html#/list?genreId=PLACEHOLDER&serverId=${SERVER}` });
  const list = h.document.getElementById('listPage');
  for (const [param, kind] of [['genreId', 'genre'], ['studioId', 'studio'], ['studioId', 'network']]) {
    h.window.location.hash = `#/list?${param}=${h.td.syntheticId(kind, 878)}&serverId=${SERVER}`;
    await h.JE.internals.nativeDetails.onView();
    assert.ok(list.classList.contains('je-native-absent-list'), kind);
  }
  const css = h.document.getElementById('je-native-absent-style').textContent;
  for (const sel of ['.itemsViewSettingsContainer', '.paging', '.alphaPicker']) assert.ok(css.includes(`.je-native-absent-list ${sel}`), sel);
  // A library genre, a synthetic title id in the list URL, or another page: not a discovery page.
  for (const hash of [`#/list?genreId=0123456789abcdef0123456789abcdef&serverId=${SERVER}`, `#/list?studioId=${MOVIE}&serverId=${SERVER}`, '#/home']) {
    h.window.location.hash = hash;
    await h.JE.internals.nativeDetails.onView();
    assert.equal(list.classList.contains('je-native-absent-list'), false, hash);
  }
});
