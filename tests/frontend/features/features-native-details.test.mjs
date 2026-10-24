import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

/** Runs `fn` as a viewer's click does (D46S2-R9-4: a native opener names JE.NATIVE at the gesture) and returns its result. */
function gesture(h, fn) {
  let result;
  const button = h.document.createElement('button');
  // The viewer's click: what opens is its owner's (JE.ownerOf(event)), passed explicitly.
  button.addEventListener('click', e => { result = fn(h.JE.ownerOf(e)); });
  h.document.body.append(button); button.click(); button.remove();
  return result;
}

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
      jellyseerrMoreInfo: { open: (...args) => { if (!args[3]) throw new Error('the More Info window opened without an owner'); modal.push(args.slice(0, args[2] === undefined ? 2 : 3)); } },
      jellyseerrUI: { showCollectionRequestModal: (...args) => { if (!args[3]?.operation) throw new Error('the Collection modal opened without an owner'); collections.push(args.slice(0, 2)); } },
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
  h.load('core/ui-kit.js');
  h.load('jellyseerr/nativedetails/native-details.js');
  return { ...h, get NATIVE() { return h.NATIVE; }, td: h.JE.titleDetails, shown, modal, mounts, fetched, back, resolved, toggles, collections, userChanges };
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
    assert.equal(h.td.open(693134, 'movie', undefined, h.NATIVE), false);
    assert.deepEqual(h.shown, []);
  });
}

test('open() goes to the native details route on this server', t => {
  const h = setup(t);
  assert.equal(h.td.available(), true);
  assert.equal(h.td.open(693134, 'movie', undefined, h.NATIVE), true);
  assert.equal(h.td.open('83867', 'tv', undefined, h.NATIVE), true);
  assert.equal(h.td.open(5, 'collection', undefined, h.NATIVE), false);
  assert.deepEqual(h.shown, [`/details?id=${MOVIE}&serverId=${SERVER}`, `/details?id=${h.td.syntheticId('series', 83867)}&serverId=${SERVER}`]);
});

test('a synthetic movie page hides native actions and holds the request controls by key', async t => {
  const item = { Id: MOVIE, Type: 'Movie', Name: 'Dune: Part Two', ProductionYear: 2024, ProviderIds: { Tmdb: '693134' } };
  const h = setup(t, { html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`, getItem: async (user, id) => (assert.equal(id, MOVIE), item) });
  await h.JE.internals.nativeDetails.onView();
  const page = h.document.getElementById('itemDetailPage');
  assert.ok(page.classList.contains('je-native-absent'));
  const css = h.document.getElementById('je-native-absent-style').textContent;
  for (const sel of ['.btnPlay', '.btnShuffle', '.btnPlaystate', '.btnUserRating', '.btnMoreCommands', '.je-spoiler-blur-btn']) assert.ok(css.includes(`.je-native-absent ${sel}`), sel);
  // Where it opens is asked once (a copy here would win).
  assert.deepEqual(h.resolved, [`/native-details/resolve?id=${MOVIE}`]);
  assert.equal(h.mounts.length, 1);
  assert.deepEqual({ ...h.mounts[0].title }, { key: 'movie:tmdb:693134', kind: 'movie', name: 'Dune: Part Two', year: 2024 });
  // The details surface has its own Notify me button and status pill and reads the status: the mount leaves them to it.
  assert.deepEqual({ ...h.mounts[0].options }, { notify: false, state: false });
  assert.deepEqual(h.fetched, []);
  const actions = page.querySelector('.je-native-absent-actions');
  assert.ok(actions && actions.parentElement.classList.contains('detailSection') && actions === actions.parentElement.firstElementChild);
  // The status heads the details section (the request's cost lines under it); Request itself leads the
  // native action row, in Play's place, as on a library title.
  assert.deepEqual([...actions.children].map(n => n.className), ['je-native-absent-status', 'je-native-absent-notes', 'je-native-absent-ratings']);
  const row = page.querySelector('.mainDetailButtons');
  assert.ok(row.firstElementChild.classList.contains('je-native-absent-primary'));
  assert.equal(row.firstElementChild.querySelector('.je-native-absent-request').textContent, 'Request');
  // Leaving the page disposes the mount.
  h.window.location.hash = '#/home';
  await h.JE.internals.nativeDetails.onView();
  assert.equal(h.mounts[0].destroyed, true);
  assert.equal(page.querySelector('.je-native-absent-actions'), null);
  assert.equal(row.querySelector('.je-native-absent-primary'), null);
});

const ROW_PAGE = `<div id="itemDetailPage" class="page libraryPage itemDetailPage"><div class="detailPageContent"><div class="detailPagePrimaryContainer">
  <div class="mainDetailButtons focuscontainer-x"><button class="btnPlay detailButton">Play</button><button class="btnPlayTrailer detailButton">Trailer</button>
  <button class="jellyseerr-report-issue-icon detailButton">Report</button><button class="btnMoreCommands detailButton">More</button><button class="btnManage detailButton">Manage</button></div></div>
  <div class="detailPagePrimaryContent"><div class="detailSection"><div class="overview">Overview</div><div class="itemExternalLinks">IMDb TMDB</div></div></div></div></div>`;

/**
 * A smart-actions box as ask-actions draws it.
 * @param {Document} document Document.
 * @param {Array<[string, string, boolean]>} buttons [icon, text, secondary].
 * @param {string[]} [costs] Cost lines.
 * @returns {HTMLElement} Box.
 */
function askBox(document, buttons, costs = []) {
  const box = document.createElement('div');
  box.className = 'je-ask-actions';
  box.dataset.jeAskSurface = 'details';
  for (const [icon, text, secondary] of buttons) {
    const b = document.createElement('button');
    b.className = `je-ask-action${secondary ? ' je-ask-action-secondary' : ''}`;
    b.innerHTML = `<span class="material-icons je-ask-action-icon">${icon}</span><span class="je-ask-action-text">${text}</span>`;
    box.appendChild(b);
  }
  for (const text of costs) box.appendChild(Object.assign(document.createElement('span'), { className: 'je-ask-action-cost', textContent: text }));
  return box;
}

test('a series page: Get Season N leads the native action row where Play sits, Request follows as an icon button, the cost line goes under the status', async t => {
  const h0 = setup(t);
  const id = h0.td.syntheticId('series', 1849);
  const h = setup(t, { html: ROW_PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${id}&serverId=${SERVER}`, getItem: async () => ({ Id: id, Type: 'Series', Name: 'Benson', ProviderIds: { Tmdb: '1849' } }) });
  const nd = h.JE.internals.nativeDetails;
  await nd.onView();
  const page = h.document.getElementById('itemDetailPage');
  const row = page.querySelector('.mainDetailButtons');
  const primary = row.firstElementChild;
  assert.ok(primary.classList.contains('je-native-absent-primary'));
  // Nothing to show yet: no gap in the row.
  assert.ok(primary.classList.contains('je-native-absent-primary-empty'));
  const box = askBox(h.document, [['download', 'Get Season 1'], ['add', 'Request', true]], ['Uses 1 of your 5 requests']);
  assert.equal(nd.placeActions(page, box, null), true);
  assert.equal(box.parentElement, primary);
  assert.equal(primary.classList.contains('je-native-absent-primary-empty'), false);
  const [lead, more] = box.querySelectorAll('button');
  assert.ok(lead.classList.contains('je-native-absent-lead'));
  assert.equal(lead.classList.contains('je-native-absent-icon'), false);
  // The secondary one is an icon button like the row's own; its label stays its name and tooltip.
  assert.ok(more.classList.contains('je-native-absent-icon') && more.classList.contains('detailButton'));
  assert.equal(more.title, 'Request');
  assert.equal(more.querySelector('.je-ask-action-text').textContent, 'Request');
  assert.equal(box.querySelector('.je-ask-action-cost'), null);
  assert.equal(page.querySelector('.je-native-absent-status + .je-native-absent-notes').textContent, 'Uses 1 of your 5 requests');
  // A redraw replaces the box and its cost lines; none at all leaves the row as it was.
  const next = askBox(h.document, [['add', 'Request', true]]);
  assert.equal(nd.placeActions(page, next, box), true);
  assert.equal(box.isConnected, false);
  assert.equal(page.querySelector('.je-native-absent-notes').textContent, '');
  // Alone, the secondary action leads with its label.
  assert.ok(next.querySelector('button').classList.contains('je-native-absent-lead'));
  assert.equal(nd.placeActions(page, null, next), true);
  assert.equal(next.isConnected, false);
  await wait(0);
  assert.ok(primary.classList.contains('je-native-absent-primary-empty'));
  // Taken away by another path (ask-actions' clear): its cost lines go with it.
  const again = askBox(h.document, [['download', 'Get Season 1']], ['Uses 1 of your 5 requests']);
  nd.placeActions(page, again, null);
  again.remove();
  await wait(0);
  assert.equal(page.querySelector('.je-native-absent-notes').textContent, '');
  // A library page is ask-actions' own.
  h.window.location.hash = '#/details?id=0123456789abcdef0123456789abcdef';
  await nd.onView();
  assert.equal(row.querySelector('.je-native-absent-primary'), null);
  assert.equal(nd.placeActions(page, askBox(h.document, [['add', 'More…']]), null), false);
});

test('smart actions drawn under the status before the page\'s controls existed move into the action row', async t => {
  const h0 = setup(t);
  const id = h0.td.syntheticId('season', 1849, 1);
  const h = setup(t, { html: ROW_PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${id}&serverId=${SERVER}`, getItem: async () => ({ Id: id, Type: 'Season', Name: 'Season 1' }) });
  const page = h.document.getElementById('itemDetailPage');
  const early = askBox(h.document, [['download', 'Get Season 1']], ['Uses 1 of your 5 requests']);
  page.querySelector('.detailSection').prepend(early);
  await h.JE.internals.nativeDetails.onView();
  const primary = page.querySelector('.mainDetailButtons > .je-native-absent-primary');
  assert.equal(early.parentElement, primary);
  assert.ok(early.querySelector('button').classList.contains('je-native-absent-lead'));
  assert.equal(page.querySelector('.je-native-absent-notes').textContent, 'Uses 1 of your 5 requests');
  // One the details surface put next to its status block afterwards is moved there too.
  const late = askBox(h.document, [['search', 'Search']]);
  early.remove();
  page.querySelector('.je-native-absent-status').appendChild(late);
  h.JE.internals.nativeDetails.statusShown(page, { stage: 'notHere' });
  assert.equal(late.parentElement, primary);
});

test('controls the request mount draws later get the row look too: the first leads, the rest are icon buttons', async t => {
  const h = setup(t, { html: ROW_PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`, getItem: async () => ({ Id: MOVIE, Type: 'Movie', Name: 'Dune' }) });
  await h.JE.internals.nativeDetails.onView();
  const slot = h.document.querySelector('.mainDetailButtons > .je-native-absent-primary .je-native-absent-request');
  const request = Object.assign(h.document.createElement('button'), { className: 'je-ask-action je-ask-mount-request', innerHTML: '<span class="material-icons">add</span><span>Request</span>' });
  const fourK = Object.assign(h.document.createElement('button'), { className: 'je-ask-action', innerHTML: '<span class="material-icons">4k</span><span>Get 4K</span>' });
  slot.append(request, fourK);
  await wait(0);
  assert.ok(request.classList.contains('je-native-absent-lead'));
  assert.ok(fourK.classList.contains('je-native-absent-icon'));
  assert.equal(fourK.title, 'Get 4K');
  // Open (a copy arrived) takes the lead.
  h.JE.internals.nativeDetails.statusShown(h.document.getElementById('itemDetailPage'), { stage: 'ready', openItemId: '0123456789abcdef0123456789abcdef' });
  await wait(0);
  const open = slot.querySelector('.je-native-absent-open');
  assert.equal(slot.firstElementChild, open);
  assert.ok(open.classList.contains('je-native-absent-lead'));
  assert.ok(request.classList.contains('je-native-absent-icon'));
});

test('TV layout: the request action takes the page\'s first focus where Play would have it, unless the remote moved on first', async t => {
  for (const pressed of [false, true]) {
    const h = setup(t, { html: ROW_PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`, getItem: async () => ({ Id: MOVIE, Type: 'Movie', Name: 'Dune' }) });
    h.document.documentElement.classList.add('layout-tv');
    await h.JE.internals.nativeDetails.onView();
    // Jellyfin focused the first button it shows (Trailer: Play is hidden here).
    const trailer = h.document.querySelector('.btnPlayTrailer');
    trailer.focus();
    if (pressed) h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowRight' }));
    const request = Object.assign(h.document.createElement('button'), { className: 'je-ask-action je-ask-mount-request', textContent: 'Request' });
    h.document.querySelector('.je-native-absent-primary .je-native-absent-request').appendChild(request);
    await wait(0);
    assert.equal(h.document.activeElement, pressed ? trailer : request, pressed ? 'moved on' : 'first focus');
  }
});

test('Spoiler Guard is an icon button in the native action row before More…, where a library title has it, not a pill under the page', async t => {
  const built = [];
  const details = { id: 693134, status: 'Released', relatedVideos: [] };
  const h = setup(t, {
    html: ROW_PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`,
    getItem: async () => ({ Id: MOVIE, Type: 'Movie', Name: 'Dune: Part Two', ProviderIds: { Tmdb: '693134' } }),
    modalData: {}, resolve: path => (path === '/native-details/title/movie/693134' ? details : path.endsWith('/ratings') ? { rt: { criticsScore: 92 } } : null),
  });
  h.JE.internals.spoilerGuard.buildSeerrToggle = (data, type, options) => {
    built.push([data.id, data.name, type, options]);
    return Object.assign(h.document.createElement('button'), { className: 'button-flat detailButton je-spoiler-pending-detail' });
  };
  await h.JE.internals.nativeDetails.onView();
  await wait(20);
  const page = h.document.getElementById('itemDetailPage');
  const button = page.querySelector('.je-spoiler-pending-detail');
  assert.ok(button);
  assert.equal(button.parentElement, page.querySelector('.mainDetailButtons'));
  // After Report issue, just before More…, the order a library title's row has.
  assert.ok(button.previousElementSibling.classList.contains('jellyseerr-report-issue-icon'));
  assert.ok(button.nextElementSibling.classList.contains('btnMoreCommands'));
  assert.deepEqual(JSON.parse(JSON.stringify(built)), [[693134, 'Dune: Part Two', 'movie', { detail: true }]]);
  // Not a second switch under the page.
  assert.equal(page.querySelector('.je-native-absent-spoiler'), null);
  assert.deepEqual(h.toggles, []);
  // The ratings sit where JE's MDBList ratings sit on a library title: just above the external links.
  const ratings = page.querySelector('.je-native-absent-ratings');
  assert.ok(ratings.querySelector('.je-rating'));
  assert.ok(ratings.nextElementSibling.classList.contains('itemExternalLinks'));
  h.window.location.hash = '#/home';
  await h.JE.internals.nativeDetails.onView();
  assert.equal(page.querySelector('.je-spoiler-pending-detail'), null);
  assert.equal(page.querySelector('.je-native-absent-ratings'), null);
});

test('season and episode pages have no Spoiler Guard button, as their library pages have none', async t => {
  const h0 = setup(t);
  for (const id of [h0.td.syntheticId('season', 1849, 1), h0.td.syntheticId('episode', 1849, 1, 1)]) {
    const built = [];
    const h = setup(t, { html: ROW_PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${id}&serverId=${SERVER}`, getItem: async () => ({ Id: id, Type: 'Season', Name: 'Season 1' }), modalData: {} });
    h.JE.internals.spoilerGuard.buildSeerrToggle = (...args) => { built.push(args); return h.document.createElement('button'); };
    await h.JE.internals.nativeDetails.onView();
    assert.deepEqual(built, []);
  }
});

test('a page without a native action row keeps its request controls and Spoiler Guard on the page', async t => {
  const details = { id: 693134, status: 'Released', relatedVideos: [] };
  const h = setup(t, {
    html: PAGE.replace(/<div class="mainDetailButtons">.*?<\/div>/, ''), url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`,
    getItem: async () => ({ Id: MOVIE, Type: 'Movie', Name: 'Dune' }), modalData: {}, resolve: path => (path === '/native-details/title/movie/693134' ? details : null),
  });
  h.JE.internals.spoilerGuard.buildSeerrToggle = () => h.document.createElement('button');
  await h.JE.internals.nativeDetails.onView();
  await wait(20);
  const actions = h.document.querySelector('.je-native-absent-actions');
  assert.equal(actions.querySelector('.je-native-absent-request').textContent, 'Request');
  assert.ok(h.document.querySelector('.je-native-absent-extras .je-native-absent-spoiler'));
});

test('without the details surface the mount reads and follows the status itself, with its Notify me', async t => {
  const item = { Id: MOVIE, Type: 'Movie', Name: 'Dune: Part Two', ProviderIds: { Tmdb: '693134' } };
  const h = setup(t, { status: false, html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`, getItem: async () => item });
  await h.JE.internals.nativeDetails.onView();
  await wait(10);
  assert.deepEqual({ ...h.mounts[0].options }, { notify: true, state: true });
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
  // The page's own server routes (JE's Seerr key, this page's rule): no Seerr account needed.
  const details = { id: 693134, status: 'Released', budget: 190000000, releaseDate: '2024-02-27', relatedVideos: [{ type: 'Trailer' }], mediaInfo: { jellyfinMediaId: 'abc' } };
  const h = setup(t, {
    html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`, getItem: async () => item,
    modalData: { status: 'From the proxy' },
    resolve: path => (path === '/native-details/title/movie/693134' ? details : path === '/native-details/title/movie/693134/ratings' ? { rt: { criticsScore: 92 } } : null),
  });
  const proxied = [];
  h.JE.internals.moreInfoModal.fetchMediaDetails = async () => { proxied.push('details'); return { status: 'From the proxy' }; };
  h.JE.internals.moreInfoModal.fetchRatings = async () => { proxied.push('ratings'); return null; };
  await h.JE.internals.nativeDetails.onView();
  await wait(20);
  assert.ok(h.resolved.includes('/native-details/title/movie/693134'));
  assert.ok(h.resolved.includes('/native-details/title/movie/693134/ratings'));
  // The per-user Seerr proxy (which refuses viewers without a Seerr account) isn't asked for the extras.
  assert.deepEqual(proxied.filter(p => p === 'ratings'), []);
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

test('a deep link to a title here now goes by the one arrival rule: held while a dialog is open, the page drawn meanwhile', async t => {
  const copy = '0123456789abcdef0123456789abcdef';
  const h = setup(t, {
    html: PAGE + '<div class="dialogContainer"><div class="dialog opened"></div></div>', url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`,
    getItem: async (user, id) => ({ Id: id, Type: 'Movie', Name: 'Dune: Part Two' }), resolve: () => ({ itemId: copy }),
  });
  h.load('arr/status/status-arrival.js');
  Object.assign(h.JE.internals.arrStatusArrival.timing, { recheck: 5 });
  await h.JE.internals.nativeDetails.onView();
  await wait(30);
  assert.equal(h.window.location.hash, `#/details?id=${MOVIE}&serverId=${SERVER}`, 'not while the dialog is open');
  assert.equal(h.mounts.length, 1, 'the native page is drawn meanwhile');
  h.document.querySelector('.dialogContainer').remove();
  // The copy is read again as the viewer right before the move.
  for (let i = 0; i < 100 && !h.window.location.hash.includes(copy); i++) await wait(5);
  assert.equal(h.window.location.hash, `#/details?id=${copy}&serverId=${SERVER}`);

  // Nothing open: at once, the page not drawn.
  const now = setup(t, {
    html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`,
    getItem: async (user, id) => ({ Id: id, Type: 'Movie', Name: 'Dune: Part Two' }), resolve: () => ({ itemId: copy }),
  });
  now.load('arr/status/status-arrival.js');
  await now.JE.internals.nativeDetails.onView();
  for (let i = 0; i < 100 && !now.window.location.hash.includes(copy); i++) await wait(5);
  assert.equal(now.window.location.hash, `#/details?id=${copy}&serverId=${SERVER}`);
  assert.equal(now.mounts.length, 0);
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
  assert.equal(h.resolved.length, 2); // where it opens is asked again: the title may be in the library now
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

test('two looks at a fresh page that overlap (viewshow and the first look) draw its Request and Spoiler Guard once', async t => {
  const gates = [];
  const built = [];
  const h = setup(t, {
    html: ROW_PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`,
    getItem: () => new Promise(r => gates.push(() => r({ Id: MOVIE, Type: 'Movie', Name: 'Dune', ProviderIds: { Tmdb: '693134' } }))),
  });
  h.JE.internals.spoilerGuard = { buildSeerrToggle: () => { built.push(1); return Object.assign(h.document.createElement('button'), { className: 'button-flat detailButton je-spoiler-pending-detail' }); } };
  const nd = h.JE.internals.nativeDetails;
  const first = nd.onView();
  await wait(5);
  const second = nd.onView();
  await wait(5);
  gates.splice(0).forEach(open => open());
  await Promise.all([first, second]);
  const page = h.document.getElementById('itemDetailPage');
  assert.equal(h.mounts.length, 1);
  assert.equal(page.querySelector('.je-native-absent-request').textContent, 'Request');
  assert.equal(built.length, 1);
  assert.equal(page.querySelectorAll('.je-spoiler-pending-detail').length, 1);
});

test('a page shown again whose action row was drawn anew gets its Request and Spoiler Guard back, still live, with one current smart-actions box', async t => {
  const built = [];
  const h = setup(t, {
    html: ROW_PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`,
    getItem: async () => ({ Id: MOVIE, Type: 'Movie', Name: 'Dune', ProviderIds: { Tmdb: '693134' } }),
  });
  h.JE.internals.spoilerGuard = { buildSeerrToggle: () => { built.push(1); return Object.assign(h.document.createElement('button'), { className: 'button-flat detailButton je-spoiler-pending-detail' }); } };
  const nd = h.JE.internals.nativeDetails;
  const page = h.document.getElementById('itemDetailPage');
  const fresh = () => {
    const row = h.document.createElement('div');
    row.className = 'mainDetailButtons focuscontainer-x';
    row.innerHTML = '<button class="btnPlay detailButton">Play</button><button class="jellyseerr-report-issue-icon detailButton">Report</button><button class="btnMoreCommands detailButton">More</button>';
    return row;
  };
  const check = () => {
    const row = page.querySelector('.mainDetailButtons');
    const primary = row.firstElementChild;
    assert.ok(primary.classList.contains('je-native-absent-primary'));
    assert.equal(primary.querySelector('.je-native-absent-request').textContent, 'Request');
    assert.equal(nd.current().primary, primary);
    assert.equal(row.querySelectorAll('.je-native-absent-primary').length, 1);
    assert.equal(row.querySelectorAll('.je-spoiler-pending-detail').length, 1);
    // Where a library title has it: after Report issue, just before More….
    const spoiler = row.querySelector('.je-spoiler-pending-detail');
    assert.ok(spoiler.previousElementSibling.classList.contains('jellyseerr-report-issue-icon'));
    assert.ok(spoiler.nextElementSibling.classList.contains('btnMoreCommands'));
    return primary;
  };
  // What ask-actions' place does with each status read: the page's box (found in the page only) is
  // replaced; the native hook takes it into the row, or else it goes under the status.
  const draw = (box) => {
    const old = page.querySelector('.je-ask-actions[data-je-ask-surface="details"]');
    const native = nd.placeActions(page, box, old);
    if (!box) {
      if (old && !native) old.remove();
      return;
    }
    if (!native && old) old.replaceWith(box);
    else if (!native) page.querySelector('.je-native-absent-status').appendChild(box);
  };
  const notes = () => page.querySelector('.je-native-absent-notes').textContent;
  await nd.onView();
  check();
  // Smart actions in the row before it is drawn anew.
  const first = askBox(h.document, [['add', 'Request', false]], ['Old cost']);
  draw(first);
  assert.equal(first.parentElement, nd.current().primary);
  assert.equal(notes(), 'Old cost');
  // The row's contents drawn anew while the page (and the status under the title) stays.
  const row = page.querySelector('.mainDetailButtons');
  row.replaceChildren(...fresh().childNodes);
  // Smart actions drawn anew while the row was without its controls (under the status) replace the
  // row's earlier box when they go back with them, and only their cost line shows.
  const box = askBox(h.document, [['search', 'Search', false]], ['New cost']);
  draw(box);
  await nd.onView();
  let primary = check();
  assert.equal(box.parentElement, primary);
  assert.equal(page.querySelectorAll('.je-ask-actions').length, 1, primary.textContent);
  assert.equal(first.isConnected, false);
  assert.equal(notes(), 'New cost');
  await wait(5);
  assert.equal(notes(), 'New cost');
  // Then the row element itself, with no smart actions drawn meanwhile: the earlier box doesn't come back.
  page.querySelector('.mainDetailButtons').replaceWith(fresh());
  draw(null);
  await nd.onView();
  primary = check();
  assert.equal(page.querySelectorAll('.je-ask-actions').length, 0);
  assert.equal(notes(), '');
  // A row drawn anew from a copy of its old self (copies of the request controls, their smart actions
  // and Spoiler Guard in it), and a box that reached the status by another way meanwhile: the live
  // controls go back, the dead copies go, and that box replaces the one the controls held.
  const third = askBox(h.document, [['add', 'Request', false]], ['Third cost']);
  draw(third);
  assert.equal(third.parentElement, primary);
  const copy = page.querySelector('.mainDetailButtons').cloneNode(true);
  page.querySelector('.mainDetailButtons').replaceWith(copy);
  const fourth = askBox(h.document, [['search', 'Search', false]], ['Fourth cost']);
  page.querySelector('.je-native-absent-status').appendChild(fourth);
  await nd.onView();
  assert.equal(check(), primary);
  assert.equal(copy.querySelector('.je-spoiler-pending-detail'), nd.current().spoiler);
  assert.equal(page.querySelectorAll('.je-ask-actions').length, 1, primary.textContent);
  assert.equal(fourth.parentElement, primary);
  assert.equal(notes(), 'Fourth cost');
  // The same controls: no second mount, Spoiler Guard built once, and they still follow the page.
  assert.equal(h.mounts.length, 1);
  assert.equal(h.mounts[0].destroyed, false);
  assert.equal(built.length, 1);
  const later = Object.assign(h.document.createElement('button'), { textContent: 'Search' });
  primary.querySelector('.je-native-absent-request').appendChild(later);
  await wait(5);
  assert.ok(later.classList.contains('je-native-absent-lead'));
  // Leaving the page still takes them away.
  h.window.location.hash = '#/home';
  await nd.onView();
  assert.equal(page.querySelector('.je-native-absent-primary'), null);
  assert.equal(page.querySelector('.je-spoiler-pending-detail'), null);
});

test('a row copied and left before the next look has one live Request when the page is shown again', async t => {
  // Codex's 3i-R5-1: the request feature off, the action row replaced by a copy of itself, the page left
  // before a look; on return the copy's dead Request stood beside the new one.
  const h = setup(t, { html: PAGE, ask: false, seerr: true, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`, getItem: async () => ({ Id: MOVIE, Type: 'Movie', Name: 'Dune', ProviderIds: { Tmdb: '693134' } }) });
  const nd = h.JE.internals.nativeDetails;
  const page = h.document.querySelector('#itemDetailPage');
  await nd.onView();
  const row = page.querySelector('.mainDetailButtons');
  row.replaceWith(row.cloneNode(true));
  h.window.location.hash = '#/home';
  await nd.onView();
  // Nothing of the page's controls stays behind it, copies included.
  assert.equal(h.document.querySelectorAll('.je-native-absent-primary, .je-native-absent-legacy-request, .je-native-absent-actions').length, 0);
  h.window.location.hash = `#/details?id=${MOVIE}&serverId=${SERVER}`;
  await nd.onView();
  const buttons = h.document.querySelectorAll('.je-native-absent-legacy-request');
  assert.equal(buttons.length, 1, 'one Request after return');
  assert.equal(h.document.querySelectorAll('.je-native-absent-primary').length, 1);
  assert.equal(page.querySelector('.mainDetailButtons').firstElementChild, nd.current().primary);
  const before = h.modal.length;
  buttons[0].click();
  assert.equal(h.modal.length, before + 1, 'the Request is live');
});

/**
 * The issue reporter on the same page: Seerr up, the viewer has an account, and each click on a
 * Report issue icon recorded (the issue dialog is not drawn).
 * @param {object} h Harness from setup().
 * @returns {{reporter: object, opened: Array}} The reporter and the dialogs its icons opened.
 */
function withReporter(h) {
  const opened = [];
  Object.assign(h.JE.pluginConfig, { JellyseerrEnabled: true, JellyseerrShowReportButton: true });
  h.JE.jellyseerrAPI = { checkUserStatus: async () => ({ active: true, userFound: true }) };
  h.window.ApiClient.ajax = async () => ({ active: true });
  h.load('jellyseerr/issue-reporter.js');
  const reporter = h.JE.jellyseerrIssueReporter;
  reporter.showReportModal = (...args) => opened.push(args);
  return { reporter, opened };
}

test('a native row replaced by a copy of itself gets one working Report issue icon at the next look, before Spoiler Guard', async t => {
  // Q-3I-10: the copy's icon is dead; the reporter counted it and drew none.
  const h = setup(t, {
    html: PAGE, ask: false, seerr: true, modalData: {}, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`,
    getItem: async () => ({ Id: MOVIE, Type: 'Movie', Name: 'Dune', ProviderIds: { Tmdb: '693134' } }),
    resolve: path => (path === '/native-details/title/movie/693134' ? { id: 693134, status: 'Released', relatedVideos: [] } : null),
  });
  h.JE.internals.spoilerGuard.buildSeerrToggle = () => Object.assign(h.document.createElement('button'), { className: 'button-flat detailButton je-spoiler-pending-detail' });
  const { reporter, opened } = withReporter(h);
  const nd = h.JE.internals.nativeDetails;
  // Jellyfin's viewshow reaches both.
  const look = () => Promise.all([nd.onView(), reporter.tryAddButton()]);
  await look();
  const row = () => h.document.querySelector('.mainDetailButtons');
  const kinds = () => [...row().children].map(n => n.className.split(' ').find(c => /^(btn|je-|jellyseerr-)/.test(c)));
  const expected = ['je-native-absent-primary', 'btnPlay', 'jellyseerr-report-issue-icon', 'je-spoiler-pending-detail'];
  assert.deepEqual(kinds(), expected);
  row().replaceWith(row().cloneNode(true));
  await look();
  assert.deepEqual(kinds(), expected, 'one icon, in its place');
  assert.equal(h.document.querySelectorAll('.jellyseerr-report-issue-icon').length, 1);
  h.document.querySelector('.jellyseerr-report-issue-icon').click();
  assert.deepEqual(opened.map(a => a[0]), ['693134'], 'the icon opens the issue dialog');
});

/**
 * A small seeded generator (mulberry32), so a failing sequence can be replayed from its seed.
 * @param {number} seed Seed.
 * @returns {() => number} Numbers in [0, 1).
 */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

for (const ask of [false, true]) {
  test(`whatever happens to the action row (drawn anew, replaced, copied, emptied, left and shown again), the page has one of each of its controls and its Request works (request feature ${ask ? 'on' : 'off'})`, async t => {
    const details = { id: 693134, status: 'Released', relatedVideos: [] };
    const h = setup(t, {
      html: ROW_PAGE, ask, seerr: true, modalData: {}, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`,
      getItem: async () => ({ Id: MOVIE, Type: 'Movie', Name: 'Dune', ProviderIds: { Tmdb: '693134' } }),
      resolve: path => (path === '/native-details/title/movie/693134' ? details : path.endsWith('/ratings') ? { rt: { criticsScore: 92 } } : null),
    });
    const nd = h.JE.internals.nativeDetails;
    const page = h.document.getElementById('itemDetailPage');
    const doc = h.document;
    const spoilerClicks = [];
    const { reporter, opened } = withReporter(h);
    h.JE.internals.spoilerGuard.buildSeerrToggle = () => {
      const b = Object.assign(doc.createElement('button'), { className: 'button-flat detailButton je-spoiler-pending-detail' });
      b.addEventListener('click', () => spoilerClicks.push(b));
      return b;
    };
    // The request mount draws a real button; a click says which mount answered.
    const asked = [];
    const mounts = [];
    if (ask) {
      h.JE.arrAskSheet.mount = (container) => {
        const m = { destroyed: false };
        mounts.push(m);
        const b = Object.assign(doc.createElement('button'), { className: 'je-ask-action je-ask-mount-request', textContent: 'Request' });
        b.addEventListener('click', () => asked.push(m));
        container.append(b);
        return { update: () => {}, destroy: () => { m.destroyed = true; } };
      };
    }
    const fresh = () => {
      const row = doc.createElement('div');
      row.className = 'mainDetailButtons focuscontainer-x';
      row.innerHTML = '<button class="btnPlay detailButton">Play</button><button class="jellyseerr-report-issue-icon detailButton">Report</button><button class="btnMoreCommands detailButton">More</button>';
      return row;
    };
    const rowNow = () => page.querySelector('.mainDetailButtons');
    // ask-actions' place for each status read (see the r4 test).
    let lastBox;
    let boxes = 0;
    const draw = (box) => {
      const old = page.querySelector('.je-ask-actions[data-je-ask-surface="details"]');
      const native = nd.placeActions(page, box, old);
      lastBox = box;
      if (!box) {
        if (old && !native) old.remove();
        return;
      }
      if (!native && old) old.replaceWith(box);
      else if (!native) page.querySelector('.je-native-absent-status')?.appendChild(box);
    };
    const all = sel => [...doc.querySelectorAll(sel)];
    // The page's own controls, once each, where they belong.
    const structure = (step) => {
      const state = nd.current();
      const row = rowNow();
      assert.ok(state, step);
      assert.deepEqual(all('.je-native-absent-primary'), [state.primary], `${step}: one request slot`);
      assert.equal(row.firstElementChild, state.primary, `${step}: it leads the row`);
      assert.deepEqual(all('.je-native-absent-actions'), [state.container], `${step}: one status container`);
      assert.deepEqual(all('.je-spoiler-pending-detail'), [state.spoiler], `${step}: one Spoiler Guard`);
      assert.equal(state.spoiler.parentElement, row, `${step}: Spoiler Guard in the row`);
      const more = row.querySelector('.btnMoreCommands');
      if (more) assert.equal(state.spoiler.nextElementSibling, more, `${step}: Spoiler Guard before More…`);
    };
    let trail = [];
    const look = async () => {
      const drawn = nd.current()?.drawn && nd.current().id === MOVIE && h.window.location.hash.includes(MOVIE);
      const pending = Promise.all([nd.onView(), reporter.tryAddButton()]);
      // A page shown again starts its look from its live controls, before its item is read again.
      if (drawn) structure(`${trail.join(' → ')} (look starts)`);
      await pending;
      await wait(1);
    };
    // After a look: exactly one Report issue icon, in the row before Spoiler Guard, and it opens the dialog.
    const reportWorks = (step) => {
      const icons = all('.jellyseerr-report-issue-icon, .jellyseerr-report-unavailable-icon');
      assert.equal(icons.length, 1, `${step}: one Report issue icon (${icons.length})`);
      assert.equal(icons[0].parentElement, rowNow(), `${step}: the icon is in the row`);
      assert.equal(icons[0].nextElementSibling, nd.current().spoiler, `${step}: the icon stands just before Spoiler Guard`);
      const n = opened.length;
      icons[0].click();
      assert.equal(opened.length, n + 1, `${step}: the icon opens the issue dialog`);
    };
    const check = async (step) => {
      structure(step);
      const state = nd.current();
      assert.ok(all('.je-native-absent-extras').length <= 1, `${step}: one extras`);
      assert.ok(all('.je-native-absent-ratings').length <= 1, `${step}: one ratings row`);
      assert.ok(all('.je-native-absent-request').length === 1 && state.primary.contains(all('.je-native-absent-request')[0]), `${step}: one request mount, in the slot`);
      // Exactly one Request, and it works.
      const sel = ask ? '.je-ask-mount-request' : '.je-native-absent-legacy-request';
      const requests = all(sel);
      assert.equal(requests.length, 1, `${step}: one Request`);
      assert.ok(state.primary.contains(requests[0]), `${step}: Request in the slot`);
      if (ask) {
        assert.equal(mounts.filter(m => !m.destroyed).length, 1, `${step}: one live mount`);
        const n = asked.length;
        requests[0].click();
        assert.equal(asked.length, n + 1, `${step}: Request answers`);
        assert.equal(asked.at(-1).destroyed, false, `${step}: the live mount answered`);
        // At most one smart-actions box: the newest one drawn, in the row; only its cost line shows.
        const shown = all('.je-ask-actions');
        assert.ok(shown.length <= 1, `${step}: one smart-actions box (${shown.length})`);
        // Never a dead copy in its place.
        assert.ok(shown.every(b => b === lastBox), `${step}: no copy of a box`);
        if (lastBox && lastBox.isConnected) {
          assert.deepEqual(shown, [lastBox], `${step}: the newest box`);
          assert.ok(state.primary.contains(lastBox), `${step}: the box is in the row`);
        }
        const notes = state.container.querySelector('.je-native-absent-notes').textContent;
        assert.ok(notes === '' || (lastBox && notes === lastBox.dataset.cost), `${step}: its cost line only (${notes})`);
      } else {
        const n = h.modal.length;
        requests[0].click();
        assert.equal(h.modal.length, n + 1, `${step}: Request opens the modal`);
      }
      const s = spoilerClicks.length;
      state.spoiler.click();
      assert.equal(spoilerClicks.at(-1), state.spoiler, `${step}: Spoiler Guard answers`);
      assert.equal(spoilerClicks.length, s + 1);
    };
    const ops = {
      contents: () => { const row = rowNow(); row.innerHTML = row.innerHTML; },
      clone: () => { const row = rowNow(); row.replaceWith(row.cloneNode(true)); },
      replace: () => rowNow().replaceWith(fresh()),
      empty: () => rowNow().replaceChildren(),
      refill: () => rowNow().replaceChildren(...fresh().childNodes),
      leave: async (rnd) => {
        h.window.location.hash = '#/home';
        await look();
        // Copies made while away, then back.
        if (rnd() < 0.5) ops.clone();
        h.window.location.hash = `#/details?id=${MOVIE}&serverId=${SERVER}`;
      },
      overlap: async () => { await Promise.all([nd.onView(), nd.onView()]); },
      status: (rnd) => {
        if (!ask) return;
        if (rnd() < 0.25) return draw(null);
        boxes += 1;
        const box = askBox(doc, [['add', `Request ${boxes}`, false]], [`Cost ${boxes}`]);
        box.dataset.cost = `Cost ${boxes}`;
        draw(box);
      },
      shown: () => nd.statusShown(page, { stage: 'notHere' }),
    };
    const names = Object.keys(ops);
    await look();
    await check('first look');
    reportWorks('first look');
    for (const seed of [1, 7, 42, 2026]) {
      const rnd = seeded(seed);
      trail = [];
      for (let i = 0; i < 60; i++) {
        const name = names[Math.floor(rnd() * names.length)];
        trail.push(name);
        await ops[name](rnd);
        // A status read puts the page's controls right too, before any look.
        if ((name === 'shown' || (name === 'status' && ask)) && nd.current()?.drawn) await check(`seed ${seed}: ${trail.join(' → ')} (status read)`);
        // Sometimes several changes come before the next look.
        if (rnd() < 0.3) continue;
        await look();
        await check(`seed ${seed}: ${trail.join(' → ')}`);
        reportWorks(`seed ${seed}: ${trail.join(' → ')}`);
      }
      await look();
      await check(`seed ${seed}: ${trail.join(' → ')} → look`);
      reportWorks(`seed ${seed}: ${trail.join(' → ')} → look`);
    }
    // Leaving the page takes everything away, copies included.
    ops.clone();
    h.window.location.hash = '#/home';
    await look();
    assert.equal(doc.querySelectorAll('.je-native-absent-primary, .je-spoiler-pending-detail, .je-native-absent-actions, .je-native-absent-extras, .je-native-absent-ratings, [data-je-native]').length, 0);
    if (ask) assert.equal(mounts.filter(m => !m.destroyed).length, 0);
  });
}

test('the navigator: native page, scoped pages, the modal as fallback, provider keys through the server', async t => {
  const h = setup(t, { resolve: path => (path.includes('movie%3Atmdb%3A45745') ? { itemId: '0123456789abcdef0123456789abcdef' } : path.includes('tv%3Atvdb%3A393189') ? { id: '4a45ad130001479b0001000092805890' } : null) });
  assert.equal(gesture(h, owner => h.td.show(83867, 'tv', { season: 1, episode: 3 }, owner)), true);
  assert.equal(h.shown[0], `/details?id=${h.td.syntheticId('episode', 83867, 1, 3)}&serverId=${SERVER}`);
  assert.equal(h.td.open(83867, 'tv', { season: 2 }, h.NATIVE), true);
  assert.equal(h.shown[1], `/details?id=${h.td.syntheticId('season', 83867, 2)}&serverId=${SERVER}`);
  assert.equal(await h.td.openKey('movie:tmdb:45745', { owner: h.NATIVE }), true);
  assert.equal(h.shown[2], `/details?id=0123456789abcdef0123456789abcdef&serverId=${SERVER}`);
  assert.equal(await h.td.openKey('tv:tvdb:393189', { season: 1, owner: h.NATIVE }), true);
  assert.ok(h.resolved.at(-1).includes('season=1'));
  // A forged answer is never followed; the modal opens once instead when the TMDB id is known.
  assert.equal(await h.td.openKey('movie:tmdb:438631', { owner: h.NATIVE }), true);
  assert.deepEqual(h.modal, [[438631, 'movie']]);
  assert.equal(await h.td.openKey('tv:tvdb:5', { modal: false, owner: h.NATIVE }), false);
  assert.equal(h.shown.length, 4);
  // Capability off: show() is the modal, open() leaves the caller its way.
  const off = setup(t, { cap: null });
  assert.equal(gesture(off, owner => off.td.show(693134, 'movie', undefined, owner)), true);
  assert.deepEqual(off.modal, [[693134, 'movie']]);
  assert.equal(await off.td.openKey('tv:tvdb:393189', { owner: off.NATIVE }), false);
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
      jellyseerrMoreInfo: { open: (...args) => { if (!args[3]) throw new Error('the More Info window opened without an owner'); modal.push(args.slice(0, args[2] === undefined ? 2 : 3)); } },
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
  return { ...h, get NATIVE() { return h.NATIVE; }, card, shown, modal, resolved };
}

test('Seerr cards open the native page when it is offered', t => {
  const h = cards(t, { cap: { Enabled: true, ContractVersion: 1 } });
  const link = h.card.querySelector('a[data-tmdb-id]');
  const e = new h.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  h.trusted(link, e);
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(h.shown, [`/details?id=${MOVIE}&serverId=${SERVER}`]);
  assert.deepEqual(h.modal, []);
});

test('Seerr cards keep the modal when native details are off', t => {
  const h = cards(t, { cap: { Enabled: false, ContractVersion: 1 } });
  h.trusted(h.card.querySelector('a[data-tmdb-id]'), new h.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  assert.deepEqual(h.shown, []);
  assert.deepEqual(h.modal, [[693134, 'movie']]);
});

test('the native page also wins over a Seerr link when the modal setting is off', t => {
  const h = cards(t, { cap: { Enabled: true, ContractVersion: 1 }, useModal: false });
  const e = new h.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  h.trusted(h.card.querySelector('a[data-tmdb-id]'), e);
  assert.equal(e.defaultPrevented, true);
  assert.equal(h.shown.length, 1);
});

test('Enter on a focused Seerr poster opens the native page (Space keeps showing the overview with Request)', t => {
  const h = cards(t, { cap: { Enabled: true, ContractVersion: 1 } });
  const poster = h.card.querySelector('.jellyseerr-poster-image');
  const press = key => h.trusted(poster, new h.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
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
  h.trusted(link, e);
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

test('a series page\'s ratings come from its native route and are drawn as Rotten Tomatoes', async t => {
  const ratings = [];
  let id = '';
  const h = setup(t, {
    modalData: {},
    getItem: async () => ({ Id: id, Type: 'Series', Name: 'Andor', ProviderIds: { Tmdb: '83867' } }),
    resolve: path => (path === '/native-details/title/tv/83867' ? { id: 83867, name: 'Andor' } : path === '/native-details/title/tv/83867/ratings' ? { criticsScore: 96 } : null),
  });
  id = h.td.syntheticId('series', 83867);
  h.document.body.innerHTML = PAGE;
  h.window.location.hash = `#/details?id=${id}&serverId=${SERVER}`;
  h.JE.internals.moreInfoModal.buildRatingLogos = r => { ratings.push(r); return '<span class="je-rating">96%</span>'; };
  await h.JE.internals.nativeDetails.onView();
  await wait(20);
  assert.deepEqual(JSON.parse(JSON.stringify(ratings)), [{ rt: { criticsScore: 96 } }]);
});

test('a restored page shows none of its earlier content while it is checked again, and a copy that arrived since wins', async t => {
  let release;
  let gate = null;
  let resolveTo = null;
  const copy = '0123456789abcdef0123456789abcdef';
  const h = setup(t, {
    html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`,
    getItem: async () => { if (gate) await gate; return { Id: MOVIE, Type: 'Movie', Name: 'Dune' }; },
    resolve: () => resolveTo,
  });
  await h.JE.internals.nativeDetails.onView();
  const page = h.document.getElementById('itemDetailPage');
  const html = h.document.documentElement;
  assert.equal(page.classList.contains('je-native-absent-checking'), false);
  // Back to the same page: hidden (backdrop too) until the check passes, then shown as it was.
  gate = new Promise(r => { release = r; });
  const again = h.JE.internals.nativeDetails.onView();
  await wait(5);
  assert.ok(page.classList.contains('je-native-absent-checking'));
  assert.ok(html.classList.contains('je-native-absent-checking'));
  assert.equal(h.window.getComputedStyle(page.querySelector('.detailPageContent')).visibility, 'hidden');
  release();
  await again;
  assert.equal(page.classList.contains('je-native-absent-checking'), false);
  assert.equal(html.classList.contains('je-native-absent-checking'), false);
  assert.ok(h.document.querySelector('.je-native-absent-actions'));
  // Back again after the title arrived: its library page replaces this one, never shown in between.
  gate = null;
  resolveTo = { itemId: copy };
  await h.JE.internals.nativeDetails.onView();
  assert.equal(h.window.location.hash, `#/details?id=${copy}&serverId=${SERVER}`);
  assert.equal(html.classList.contains('je-native-absent-checking'), false);
});

test('a native page shown again after the setting was turned off keeps nothing of the title on screen', async t => {
  const cap = { Enabled: true, ContractVersion: 1 };
  const h = setup(t, { cap, html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`, getItem: async () => ({ Id: MOVIE, Type: 'Movie', Name: 'Dune' }) });
  await h.JE.internals.nativeDetails.onView();
  cap.Enabled = false;
  await h.JE.internals.nativeDetails.onView();
  const page = h.document.getElementById('itemDetailPage');
  assert.ok(h.document.querySelector('.je-native-absent-refusal'));
  assert.equal(h.window.getComputedStyle(page.querySelector('.detailPageContent')).display, 'none');
});

test('Back to a native page after leaving it (its module state ended) is hidden until checked again too', async t => {
  let release;
  let gate = null;
  const h = setup(t, {
    html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`,
    getItem: async () => { if (gate) await gate; return { Id: MOVIE, Type: 'Movie', Name: 'Dune' }; },
  });
  const nd = h.JE.internals.nativeDetails;
  await nd.onView();
  const page = h.document.getElementById('itemDetailPage');
  // Leaving for Home ends the page's state; jellyfin-web keeps the details page's element for Back.
  h.window.location.hash = '#/home';
  await nd.onView();
  assert.equal(nd.current(), null);
  gate = new Promise(r => { release = r; });
  h.window.location.hash = `#/details?id=${MOVIE}&serverId=${SERVER}`;
  const back = nd.onView();
  await wait(5);
  assert.ok(page.classList.contains('je-native-absent-checking'));
  release();
  await back;
  assert.equal(page.classList.contains('je-native-absent-checking'), false);
});

test('a discovery list page whose row is switched off says the page isn\'t available instead of staying blank', async t => {
  const LIST = '<div class="page libraryPage" id="listPage"><div class="itemsContainer"></div></div>';
  const h = setup(t, { html: LIST, url: `http://jellyfin.test/web/index.html#/list?genreId=PLACEHOLDER&serverId=${SERVER}` });
  const list = h.document.getElementById('listPage');
  const show = async (param, kind) => {
    h.window.location.hash = `#/list?${param}=${h.td.syntheticId(kind, 878)}&serverId=${SERVER}`;
    await h.JE.internals.nativeDetails.onView();
    return list.querySelector('.je-native-absent-list-off');
  };
  // Rows on (genre discovery is on unless switched off; network discovery only when switched on): no box.
  h.JE.pluginConfig.JellyseerrShowNetworkDiscovery = true;
  assert.equal(await show('genreId', 'genre'), null);
  assert.equal(await show('studioId', 'network'), null);
  h.JE.pluginConfig.JellyseerrShowGenreDiscovery = false;
  h.JE.pluginConfig.JellyseerrShowNetworkDiscovery = false;
  const box = await show('genreId', 'genre');
  assert.ok(box);
  assert.match(box.textContent, /native_details_page_unavailable/);
  assert.ok(await show('studioId', 'studio'));
  assert.equal(list.querySelectorAll('.je-native-absent-list-off').length, 1);   // one box, redrawn per view
  h.window.location.hash = '#/home';
  await h.JE.internals.nativeDetails.onView();
  assert.equal(list.querySelector('.je-native-absent-list-off'), null);
});

test('Seerr mode: a viewer Seerr won\'t answer for goes to the window\'s message, not a native page that would refuse every title', t => {
  const h = setup(t);
  let refusal = 'unlinked';
  let jeMode = false;
  h.JE.jellyseerrAPI = { knownAccountRefusal: () => refusal };
  h.JE.internals.arrAskSeerr = { jeMode: () => jeMode };
  assert.equal(h.td.open(693134, 'movie', undefined, h.NATIVE), false);
  assert.equal(gesture(h, owner => h.td.show(693134, 'movie', undefined, owner)), true);
  assert.deepEqual([h.shown, h.modal], [[], [[693134, 'movie']]]);
  // JE mode: native pages open without a Seerr account.
  jeMode = true;
  assert.equal(h.td.open(693134, 'movie', undefined, h.NATIVE), true);
  // A linked viewer (or a status not loaded yet): the native page, as before.
  jeMode = false;
  refusal = null;
  assert.equal(h.td.open(83867, 'tv', undefined, h.NATIVE), true);
  assert.equal(h.shown.length, 2);
});

test('absent Hide survives action-row cloning with exactly one live provider control',async t=>{
 const h=setup(t,{url:`http://jellyfin.test/web/index.html#/details?id=${MOVIE}`,html:PAGE,getItem:async()=>({Id:MOVIE,Type:'Movie',Name:'Absent'})});
 h.JE.userConfig={hiddenContent:{items:{},settings:{enabled:true,showHideButtons:true,showButtonDetails:true,showHideConfirmation:false}}};
 h.window.ApiClient.getCurrentUserId=()=> 'viewer';h.window.ApiClient.getUrl=p=>p;
 const writes=[];h.window.ApiClient.ajax=async request=>{writes.push(request);return {success:true};};
 h.load('enhanced/hiddencontent/hidden-content-data.js');
 const api=h.JE.internals.hiddenContent;api.resetFromUserConfig();Object.assign(api,{refreshNativeCardVisibility:()=>{},showUndoToast:()=>{}});h.JE.hiddenContent=api;
 await h.JE.internals.nativeDetails.onView();await wait(0);
 const page=h.document.querySelector('#itemDetailPage');
 for(let i=0;i<3;i++){
  const row=page.querySelector('.mainDetailButtons');row.replaceWith(row.cloneNode(true));await wait(0);
  assert.equal(page.querySelectorAll('.je-detail-hide-btn').length,1);
 }
 const button=page.querySelector('.je-detail-hide-btn');
 await button.onclick({type:'click',target:button,preventDefault(){},stopPropagation(){}});
 assert.equal(writes.length,1);assert.equal(JSON.parse(writes[0].data).tmdbId,'693134');assert.equal(JSON.stringify(writes).includes(MOVIE),false);
 assert.equal(button.getAttribute('aria-label'),'hidden_content_unhide');
});

// Requests & downloads, A1: in Jellyfin Enhanced mode the pages read TMDB (public config NativeAbsentDetails.Source "tmdb")
// and Seerr's More Info window, which reads Seerr, is never their fallback.
const TMDB_CAP = { Enabled: true, ContractVersion: 1, Source: 'tmdb' };

test('JE mode: a page that can\'t be loaded says so on the page; no Back, no Seerr window', async t => {
  for (const inApp of [true, false]) {
    const h = setup(t, { cap: TMDB_CAP, inApp, html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`, getItem: async () => { throw Object.assign(new Error('down'), { status: 503 }); } });
    await h.JE.internals.nativeDetails.onView();
    await wait(400);
    assert.deepEqual(h.back, []);
    assert.deepEqual(h.modal, []);
    const box = h.document.querySelector('.je-native-absent-refusal');
    assert.ok(box && box.textContent.includes('native_details_failed'));
    assert.ok(box.querySelector('button'));
  }
});

test('JE mode: a title TMDB doesn\'t know (404) shows the page\'s unavailable state, never the Seerr window', async t => {
  const h = setup(t, { cap: TMDB_CAP, inApp: true, html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=${SERVER}`, getItem: async () => { throw Object.assign(new Error('no'), { status: 404 }); } });
  await h.JE.internals.nativeDetails.onView();
  await wait(400);
  const box = h.document.querySelector('.je-native-absent-refusal');
  assert.ok(box && box.textContent.includes('native_details_unavailable'));
  assert.deepEqual(h.modal, []);
  assert.deepEqual(h.back, []);
});

test('JE mode: a provider key the server can\'t place opens its TMDB page when the id is known, never the Seerr window', async t => {
  const h = setup(t, { cap: TMDB_CAP, resolve: () => null });
  assert.equal(await h.td.openKey('movie:tmdb:438631', { owner: h.NATIVE }), true);
  assert.equal(h.shown.at(-1), `/details?id=${h.td.syntheticId('movie', 438631)}&serverId=${SERVER}`);
  assert.equal(await h.td.openKey('tv:tvdb:393189', { tmdbId: 83867, season: 1, owner: h.NATIVE }), true);
  assert.equal(h.shown.at(-1), `/details?id=${h.td.syntheticId('season', 83867, 1)}&serverId=${SERVER}`);
  // No TMDB id at all: the caller keeps its own way.
  assert.equal(await h.td.openKey('tv:tvdb:5', { owner: h.NATIVE }), false);
  assert.deepEqual(h.modal, []);
  // Seerr's source (the default) keeps its one window for such a key, as before.
  const seerr = setup(t, { resolve: () => null });
  assert.equal(await seerr.td.openKey('movie:tmdb:438631', { owner: seerr.NATIVE }), true);
  assert.deepEqual(seerr.modal, [[438631, 'movie']]);
});

test('the JE backend with Seerr settings kept (A1/BEH-02): no Seerr Request window on the page, and Seerr\'s account state never keeps a title off its page', async t => {
  const h0 = setup(t);
  const id = h0.td.syntheticId('series', 83867);
  const item = { Id: id, Type: 'Series', Name: 'Andor', ProviderIds: { Tmdb: '83867', Tvdb: '393189' } };
  // Request feature off and JellyseerrEnabled still stored: the Seerr source would offer Seerr's window; TMDB's never does.
  const off = setup(t, { cap: TMDB_CAP, ask: false, seerr: true, html: PAGE, url: `http://jellyfin.test/web/index.html#/details?id=${id}&serverId=${SERVER}`, getItem: async () => item });
  await off.JE.internals.nativeDetails.onView();
  assert.equal(off.document.querySelector('.je-native-absent-legacy-request'), null);
  assert.deepEqual(off.modal, []);
  // A Seerr account refusal in the loaded user status doesn't send the viewer to Seerr's window instead of the page.
  const h = setup(t, { cap: TMDB_CAP });
  h.JE.jellyseerrAPI = { knownAccountRefusal: () => 'unlinked' };
  assert.equal(gesture(h, owner => h.td.show(693134, 'movie', undefined, owner)), true);
  assert.equal(h.shown.at(-1), `/details?id=${h.td.syntheticId('movie', 693134)}&serverId=${SERVER}`);
  assert.deepEqual(h.modal, []);
});
