// Review round 1 (g1): placeholder request flows on collection cards and playlist rows. Collection cards use JE's
// real Seerr request buttons (ui-buttons.js) and 4K popup (ui-popover.js) here, not fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred } from '../../helpers/harness.mjs';
import { setup, ph, view, playlistPage, tick, LIST, COLLECTION, ITEM_A } from './lp-harness.mjs';

const PAGE = '<div class="itemDetailPage page"><div class="detailSection"><div class="collectionItems"><div class="verticalSection"><div class="itemsContainer collectionItemsContainer"></div></div></div></div></div>';
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

/**
 * Collection page whose placeholder cards carry the real request button / 4K split button.
 * @returns {Promise<object>}
 */
async function mountCollection(t, placeholders, { config = {}, userStatus, api = {} } = {}) {
  const modals = [];
  const requests = [];
  let doc;
  const h = setup(t, {
    html: PAGE,
    config,
    plugin: async () => view({ listId: COLLECTION, listKind: 'collection', order: null, placeholders }),
    jellyseerrAPI: {
      ...(userStatus ? { checkUserStatus: userStatus } : {}),
      requestMedia: async (...args) => {
        requests.push(args);
        doc.dispatchEvent(new doc.defaultView.CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: String(args[0]), mediaType: args[1], is4k: !!args[3] } }));
        return { id: 1 };
      },
      ...api
    },
    jellyseerrUI: {
      showSeasonSelectionModal: async (...args) => { modals.push(args); },
      showMovieRequestModal: async (...args) => { modals.push(['movie', ...args]); }
    }
  });
  doc = h.document;
  h.JE.core.ui.addTouchTapListener = () => {};
  for (const file of ['ui/ui-icons.js', 'ui/ui-popover.js', 'ui/ui-buttons.js']) h.load(`jellyseerr/${file}`);
  const cardArgs = [];
  h.JE.jellyseerrUI.createJellyseerrCard = (item, active, found) => {
    cardArgs.push([active, found]);
    const card = doc.createElement('div');
    card.className = 'card overflowPortraitCard jellyseerr-card';
    card.innerHTML = '<div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div><div class="jellyseerr-overview">'
      + `<button type="button" class="jellyseerr-request-button" data-tmdb-id="${item.id}" data-media-type="${item.mediaType}"></button></div></div>`
      + '<div class="jellyseerr-meta"><bdi>y</bdi></div></div>';
    h.JE.jellyseerrUI.configureRequestButton(card.querySelector('.jellyseerr-request-button'), item, active, found);
    return card;
  };
  h.JE.initializeListPlaceholders();
  const page = doc.querySelector('.itemDetailPage');
  const ctrl = h.lp.collection.attach(page, { Id: COLLECTION, Name: 'Cars Collection', Type: 'BoxSet' });
  await settle();
  const card = id => page.querySelector(`.je-lp-card[data-je-lp-id="${id}"]`);
  const button = id => card(id).querySelector('.jellyseerr-request-button');
  return { ...h, page, ctrl, modals, requests, card, button, cardArgs };
}

/** Playlist page with placeholder rows. */
async function mountPlaylist(t, placeholders, { userStatus, api = {}, ui = {} } = {}) {
  const modals = [];
  const requests = [];
  const h = setup(t, {
    html: playlistPage([ITEM_A]),
    plugin: async () => view({ placeholders, order: [`e:${ITEM_A}:0`, ...placeholders.map(p => `p:${p.id}`)] }),
    jellyseerrUI: { showSeasonSelectionModal: async (...args) => { modals.push(args); }, showMovieRequestModal: async (...args) => { modals.push(['movie', ...args]); }, ...ui },
    jellyseerrAPI: { ...(userStatus ? { checkUserStatus: userStatus } : {}), requestMedia: async (...args) => { requests.push(args); return { id: 9 }; }, ...api }
  });
  h.JE.initializeListPlaceholders();
  const page = h.document.querySelector('.itemDetailPage');
  const ctrl = h.lp.playlist.attach(page, { Id: LIST, Name: 'Marathon', Type: 'Playlist' });
  await settle();
  const row = id => page.querySelector(`.je-lp-row[data-je-lp-id="${id}"]`);
  return { ...h, page, ctrl, modals, requests, row };
}

// F40: the 4K popup lives on document.body, outside the section, so the section's capture handler never saw it.
test('collection TV placeholder: "Request in 4K" opens the 4K season modal with the placeholder season pre-ticked', async t => {
  const h = await mountCollection(t, [ph('s', { kind: 'season', mediaType: 'tv', tmdbId: 114502, seasonNumber: 2, title: 'Cars on the Road' })],
    { config: { JellyseerrEnable4KTvRequests: true } });
  let global = 0;
  h.document.body.addEventListener('click', e => { if (e.target.closest('.jellyseerr-4k-popup-item')) global++; });
  h.card('s').querySelector('.jellyseerr-split-arrow').click();
  const item = h.document.querySelector('body > .jellyseerr-4k-popup .jellyseerr-4k-popup-item');
  assert.ok(item, 'the popup opened on document.body');
  item.click();
  await settle();
  assert.equal(h.modals.length, 1);
  assert.deepEqual([h.modals[0][0], h.modals[0][1], h.modals[0][2], h.modals[0][4]], [114502, 'tv', 'Cars on the Road', true]);
  assert.deepEqual([...h.modals[0][5].preselectedSeasons], [2]);
  assert.equal(h.modals[0][5].treatExistingAsRequested, true);
  assert.equal(h.document.querySelector('.jellyseerr-4k-popup'), null, 'popup closed');
  assert.equal(global, 0, 'the global Seerr handler does not run as well');
});

test('collection movie placeholder: "Request in 4K" submits a 4K request', async t => {
  const h = await mountCollection(t, [ph('m', { tmdbId: 7, title: 'Cars 4' })], { config: { JellyseerrEnable4KRequests: true } });
  h.card('m').querySelector('.jellyseerr-split-arrow').click();
  h.document.querySelector('body > .jellyseerr-4k-popup .jellyseerr-4k-popup-item').click();
  await settle();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0].slice(0, 4))), [7, 'movie', {}, true]);
  assert.match(h.toasts.at(-1), /^listPlaceholders_requested_4k/);
  // advanced options: the 4K movie modal instead
  const adv = await mountCollection(t, [ph('m', { tmdbId: 7, title: 'Cars 4' })], { config: { JellyseerrEnable4KRequests: true }, api: { shouldShowAdvanced: () => true } });
  adv.card('m').querySelector('.jellyseerr-split-arrow').click();
  adv.document.querySelector('body > .jellyseerr-4k-popup .jellyseerr-4k-popup-item').click();
  await settle();
  assert.equal(adv.requests.length, 0);
  assert.deepEqual([adv.modals[0][0], adv.modals[0][1], adv.modals[0][4]], ['movie', 7, true]);
});

// F44: season cards got whole-show TV rules (PROCESSING → enabled "Request", PENDING → enabled "Pending").
for (const split of [false, true]) test(`season/episodes cards already requested in Seerr show a disabled button (4K split=${split})`, async t => {
  const h = await mountCollection(t, [
    ph('pending', { kind: 'season', mediaType: 'tv', tmdbId: 50, seasonNumber: 1, status: 2 }),
    ph('processing', { kind: 'season', mediaType: 'tv', tmdbId: 50, seasonNumber: 2, status: 3 }),
    ph('episodes', { kind: 'episodes', mediaType: 'tv', tmdbId: 50, seasonNumber: 3, status: 3, episodes: [{ s: 3, e: 1 }] }),
    ph('open', { kind: 'season', mediaType: 'tv', tmdbId: 50, seasonNumber: 4, status: 1 }),
    ph('series', { kind: 'series', mediaType: 'tv', tmdbId: 60, status: 3 })
  ], { config: { JellyseerrEnable4KTvRequests: split } });
  for (const id of ['pending', 'processing', 'episodes']) assert.equal(h.button(id).disabled, true, id);
  assert.match(h.button('pending').textContent, /jellyseerr_btn_pending/);
  assert.match(h.button('processing').textContent, /jellyseerr_btn_requested/);
  assert.equal(h.button('open').disabled, false);
  assert.equal(h.button('series').disabled, false, 'a series keeps Seerr\'s "request more seasons" button');
  h.button('pending').click();
  assert.equal(h.modals.length, 0);
  // requested this session: the rebuilt card is disabled too (the synthetic status becomes PROCESSING)
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: '50', mediaType: 'tv', seasons: [4] } }));
  assert.equal(h.button('open').disabled, true);
  assert.match(h.button('open').textContent, /jellyseerr_btn_requested/);
});

// F41: a failed/negative Seerr user status was kept for the whole SPA session.
test('a negative Seerr user status is not cached: the next load asks again and rebuilds the cards', async t => {
  let calls = 0;
  let answer = { active: false, userFound: false };
  const h = await mountCollection(t, [ph('m', { tmdbId: 7 })], { userStatus: async () => { calls++; return answer; } });
  assert.deepEqual(h.cardArgs.at(-1), [false, false]);
  assert.equal(h.button('m').disabled, true);
  answer = { active: true, userFound: true };
  await h.ctrl.load();
  await settle();
  assert.equal(calls, 2);
  assert.deepEqual(h.cardArgs.at(-1), [true, true], 'cards rebuilt with the working status');
  assert.equal(h.button('m').disabled, false);
  // positive answers stay cached
  await h.ctrl.load();
  assert.equal(calls, 2);
});

test('requests.userStatus caches positive answers only (a rejected check is retried)', async t => {
  let calls = 0;
  const answers = [() => Promise.reject(new Error('down')), () => ({ active: true, userFound: false }), () => ({ active: true, userFound: true })];
  const h = setup(t, { jellyseerrAPI: { checkUserStatus: async () => answers[calls++]() } });
  const status = async () => ({ ...(await h.lp.requests.userStatus()) });
  assert.deepEqual(await status(), { active: false, userFound: false });
  assert.deepEqual(await status(), { active: true, userFound: false });
  assert.deepEqual(await status(), { active: true, userFound: true });
  assert.deepEqual(await status(), { active: true, userFound: true });
  assert.equal(calls, 3);
});

test('playlist rows: an inactive Seerr user status is re-queried on the next load', async t => {
  let answer = { active: false, userFound: false };
  const h = await mountPlaylist(t, [ph('m', { tmdbId: 7 })], { userStatus: async () => answer });
  assert.match(h.row('m').querySelector('.je-lp-status').textContent, /jellyseerr_btn_offline/);
  answer = { active: true, userFound: true };
  await h.ctrl.load();
  await settle();
  const button = h.row('m').querySelector('.je-lp-request');
  assert.equal(button.disabled, false);
  assert.match(button.textContent, /jellyseerr_btn_request/);
});

// F46: no in-flight guard before the first await.
test('a second click while a movie request is loading starts no second flow', async t => {
  const details = deferred();
  let fetches = 0;
  const h = await mountPlaylist(t, [ph('m', { tmdbId: 7 }), ph('m2', { tmdbId: 7 })], { api: { fetchMovieDetails: () => { fetches++; return details.promise; } } });
  const button = h.row('m').querySelector('.je-lp-request');
  button.click();
  assert.equal(button.disabled, true, 'disabled before the first await');
  button.click();
  h.lp.requests.requestPlaceholder(h.ctrl.byId('m'), button);
  h.row('m2').querySelector('.je-lp-request').click(); // another row for the same title
  details.resolve({ id: 7, mediaType: 'movie', mediaInfo: { status: 1 } });
  await settle();
  assert.equal(fetches, 1);
  assert.equal(h.requests.length, 1);
});

test('TV: clicks while the season modal is still opening are ignored; the button comes back afterwards', async t => {
  const opening = deferred();
  const modals = [];
  const h = await mountPlaylist(t, [ph('s', { kind: 'season', mediaType: 'tv', tmdbId: 50, seasonNumber: 1 })],
    { ui: { showSeasonSelectionModal: (...args) => { modals.push(args); return opening.promise; } } });
  const button = h.row('s').querySelector('.je-lp-request');
  button.click();
  h.lp.requests.requestPlaceholder(h.ctrl.byId('s'), null);
  assert.equal(modals.length, 1);
  assert.equal(modals[0][5].treatExistingAsRequested, true);
  opening.resolve();
  await settle();
  assert.equal(button.disabled, false);
  h.lp.requests.requestPlaceholder(h.ctrl.byId('s'), null);
  assert.equal(modals.length, 2, 'a later click opens it again');
});

// F47: the session epoch was not checked after awaiting the details.
test('a user switch while the movie details load drops the request', async t => {
  const details = deferred();
  const h = await mountPlaylist(t, [ph('m', { tmdbId: 7 })], { api: { fetchMovieDetails: () => details.promise, shouldShowAdvanced: () => false } });
  h.row('m').querySelector('.je-lp-request').click();
  h.switchUser();
  details.resolve({ id: 7, mediaType: 'movie', mediaInfo: { status: 1 } });
  await settle();
  assert.equal(h.requests.length, 0);
  assert.equal(h.modals.length, 0);
  // the advanced modal is not opened for the next user either
  const adv = deferred();
  const h2 = await mountPlaylist(t, [ph('m', { tmdbId: 7 })], { api: { fetchMovieDetails: () => adv.promise, shouldShowAdvanced: () => true } });
  h2.row('m').querySelector('.je-lp-request').click();
  h2.switchUser();
  adv.resolve({ id: 7, mediaType: 'movie' });
  await settle();
  assert.equal(h2.modals.length, 0);
});

// Review round 2: the TV flow hands the season modal the session check, so a user switch while it loads stops it.
test('the season modal of a TV placeholder stops when the user changed while it loaded', async t => {
  const h = await mountPlaylist(t, [ph('s', { tmdbId: 9, mediaType: 'tv', kind: 'season', seasonNumber: 2 })]);
  h.row('s').querySelector('.je-lp-request').click();
  await settle();
  assert.equal(h.modals.length, 1);
  const isCurrent = h.modals[0][5]?.isCurrent;
  assert.equal(typeof isCurrent, 'function');
  assert.equal(isCurrent(), true);
  h.switchUser();
  assert.equal(isCurrent(), false);
});

// Review round 2: "Request in 4K" reports Seerr's errors like JE's request buttons, and reads as requested afterwards.
test('collection movie placeholder: after a 4K request the popup offers no second one', async t => {
  const h = await mountCollection(t, [ph('m', { tmdbId: 7, title: 'Cars 4', status: 1 })], { config: { JellyseerrEnable4KRequests: true } });
  const popupItem = () => h.document.querySelector('body > .jellyseerr-4k-popup .jellyseerr-4k-popup-item');
  h.card('m').querySelector('.jellyseerr-split-arrow').click();
  popupItem().click();
  await settle();
  assert.equal(h.requests.length, 1);
  h.card('m').querySelector('.jellyseerr-split-arrow').click();
  assert.equal(popupItem().disabled, true);
  assert.notEqual(popupItem().dataset.action, 'request4k');
});

for (const [label, error, expected] of [
  ['a 403 without 4K permission', { status: 403, responseJSON: { code: 'Forbidden', message: 'Seerr declined the request.' } }, /^Seerr declined the request\.$/],
  ['a 404 (user not linked)', { status: 404, responseJSON: { message: 'User not found' } }, /^jellyseerr_btn_user_not_found/],
  ['a 409 (already requested)', { status: 409, responseJSON: { message: 'exists' } }, /^listPlaceholders_already_requested_4k/],
  ['Seerr\'s own message', { status: 500, responseJSON: { message: 'Radarr <down>' } }, /^Radarr &lt;down&gt;$/]
]) test(`collection movie placeholder: "Request in 4K" reports ${label} as Seerr's error`, async t => {
  const h = await mountCollection(t, [ph('m', { tmdbId: 7, title: 'Cars 4', status: 1 })], {
    config: { JellyseerrEnable4KRequests: true },
    api: { requestMedia: async () => { throw Object.assign(new Error('HTTP'), error); } }
  });
  h.card('m').querySelector('.jellyseerr-split-arrow').click();
  h.document.querySelector('body > .jellyseerr-4k-popup .jellyseerr-4k-popup-item').click();
  await settle();
  assert.match(h.toasts.at(-1), expected);
  assert.doesNotMatch(h.toasts.at(-1), /listPlaceholders_err_/);
});

test('collection movie placeholder: a quota error on "Request in 4K" opens the quota dialog', async t => {
  const quota = [];
  const h = await mountCollection(t, [ph('m', { tmdbId: 7, title: 'Cars 4', status: 1 })], {
    config: { JellyseerrEnable4KRequests: true },
    api: { requestMedia: async () => { throw Object.assign(new Error('HTTP 403'), { status: 403, responseJSON: { code: 'quota' } }); } }
  });
  h.JE.jellyseerrUI.isQuotaError = e => e?.responseJSON?.code === 'quota';
  h.JE.jellyseerrUI.showQuotaErrorDialog = async (...args) => { quota.push(args); };
  h.card('m').querySelector('.jellyseerr-split-arrow').click();
  h.document.querySelector('body > .jellyseerr-4k-popup .jellyseerr-4k-popup-item').click();
  await settle();
  assert.equal(quota.length, 1);
});
