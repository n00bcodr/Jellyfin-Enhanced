import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ph, view, playlistPage, tick, LIST, ITEM_A } from './lp-harness.mjs';

const ITEM = { Id: LIST, Name: 'Marathon', Type: 'Playlist' };

async function mount(t, placeholders, options = {}) {
  const modals = [];
  const requests = [];
  const h = setup(t, {
    html: playlistPage([ITEM_A]),
    plugin: async () => view({ placeholders, order: [`e:${ITEM_A}:0`, ...placeholders.map(p => `p:${p.id}`)] }),
    jellyseerrUI: { showSeasonSelectionModal: async (...args) => { modals.push(args); }, showMovieRequestModal: async (...args) => { modals.push(['movie', ...args]); } },
    jellyseerrAPI: { requestMedia: async (...args) => {
      requests.push(args);
      if (options.requestError) throw options.requestError;
      h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: String(args[0]), mediaType: args[1], is4k: !!args[3] } }));
      return { id: 9 };
    }, ...(options.api || {}) }
  });
  h.JE.initializeListPlaceholders();
  const page = h.document.querySelector('.itemDetailPage');
  h.lp.playlist.attach(page, ITEM);
  await tick(); await tick(); await tick();
  const status = id => page.querySelector(`.je-lp-row[data-je-lp-id="${id}"] .je-lp-status`).textContent.trim();
  return { ...h, page, modals, requests, status };
}

const got = [
  ph('series', { kind: 'series', mediaType: 'tv', tmdbId: 1399 }),
  ph('s1', { kind: 'season', mediaType: 'tv', tmdbId: 1399, seasonNumber: 1 }),
  ph('s2', { kind: 'season', mediaType: 'tv', tmdbId: 1399, seasonNumber: 2 }),
  ph('e1', { kind: 'episodes', mediaType: 'tv', tmdbId: 1399, seasonNumber: 1, episodes: [{ s: 1, e: 8 }] }),
  ph('movie', { tmdbId: 213121 }),
  ph('other', { tmdbId: 5 })
];

test('a season request marks every row for that show and season (and the series), not other seasons', async t => {
  const h = await mount(t, got);
  for (const id of ['series', 's1', 's2', 'e1', 'movie']) assert.match(h.status(id), /jellyseerr_btn_request/);
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: 1399, mediaType: 'tv', is4k: false, seasons: [1] } }));
  for (const id of ['series', 's1', 'e1']) assert.match(h.status(id), /jellyseerr_btn_requested/, id);
  assert.match(h.status('s2'), /jellyseerr_btn_request$/);
  assert.match(h.status('movie'), /jellyseerr_btn_request$/);
  // a 4K request doesn't change the regular status
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: '213121', mediaType: 'movie', is4k: true } }));
  assert.match(h.status('movie'), /jellyseerr_btn_request$/);
  // a request without season detail ("all") marks every season
  h.document.dispatchEvent(new h.window.CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: '1399', mediaType: 'tv', seasons: 'all' } }));
  assert.match(h.status('s2'), /jellyseerr_btn_requested/);
});

test('movie rows request through JE flow, update every matching row and ask the server again', async t => {
  const h = await mount(t, got);
  const gets = () => h.calls.filter(([, o]) => !o.method).length;
  const before = gets();
  h.page.querySelector('.je-lp-row[data-je-lp-id="movie"] .je-lp-request').click();
  await tick(); await tick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0][0], 213121);
  assert.equal(h.requests[0][1], 'movie');
  assert.equal(h.requests[0][3], false);
  assert.match(h.status('movie'), /jellyseerr_btn_requested/);
  assert.match(h.status('other'), /jellyseerr_btn_request$/);
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(gets(), before + 1, 'statuses re-fetched once (debounced)');
});

test('409 from Seerr counts as already requested; other errors restore the button and toast', async t => {
  const conflict = await mount(t, got, { requestError: Object.assign(new Error('HTTP 409'), { status: 409 }) });
  conflict.page.querySelector('.je-lp-row[data-je-lp-id="movie"] .je-lp-request').click();
  await tick(); await tick();
  assert.match(conflict.status('movie'), /jellyseerr_btn_requested/);
  assert.equal(conflict.toasts.length, 0);
  const failing = await mount(t, got, { requestError: Object.assign(new Error('HTTP 403'), { status: 403, responseJSON: { code: 'no_request_permission' } }) });
  const button = failing.page.querySelector('.je-lp-row[data-je-lp-id="movie"] .je-lp-request');
  button.click();
  await tick(); await tick();
  assert.equal(button.disabled, false);
  assert.match(failing.toasts[0], /jellyseerr_err_no_request_permission/);
});

test('TV rows open the season modal pre-ticking the placeholder season (series: none)', async t => {
  const h = await mount(t, got);
  h.page.querySelector('.je-lp-row[data-je-lp-id="e1"] .je-lp-request').click();
  h.page.querySelector('.je-lp-row[data-je-lp-id="series"] .je-lp-request').click();
  await tick();
  assert.equal(h.modals.length, 2);
  assert.deepEqual([h.modals[0][0], h.modals[0][1], h.modals[0][2], h.modals[0][4]], [1399, 'tv', 'Title e1', false]);
  assert.deepEqual([...h.modals[0][5].preselectedSeasons], [1]);
  assert.deepEqual([...h.modals[1][5].preselectedSeasons], []);
});

test('advanced request options use the movie modal instead of a direct request', async t => {
  const h = await mount(t, got, { api: { shouldShowAdvanced: () => true } });
  h.page.querySelector('.je-lp-row[data-je-lp-id="movie"] .je-lp-request').click();
  await tick(); await tick();
  assert.equal(h.requests.length, 0);
  assert.equal(h.modals[0][0], 'movie');
  assert.equal(h.modals[0][1], 213121);
});

test('row clicks open the more-info modal; custom rows open the menu for editors', async t => {
  const opened = [];
  const h = await mount(t, [ph('m', { tmdbId: 42 }), ph('c', { kind: 'custom', tmdbId: null })]);
  h.JE.jellyseerrMoreInfo = { open: (...args) => opened.push(args) };
  h.page.querySelector('.je-lp-row[data-je-lp-id="m"] .je-lp-row-main').click();
  assert.deepEqual(opened, [[42, 'movie']]);
  h.page.querySelector('.je-lp-row[data-je-lp-id="c"] .je-lp-row-main').click();
  assert.ok(h.document.querySelector('.je-lp-menu'));
});

test('requested state is per user', async t => {
  const h = await mount(t, got);
  h.lp.requests.markRequested({ tmdbId: 213121, mediaType: 'movie' });
  assert.equal(h.lp.requests.isRequested(got[4]), true);
  h.switchUser();
  assert.equal(h.lp.requests.isRequested(got[4]), false);
  assert.equal(h.lp.requests.markRequested({ tmdbId: 'x', mediaType: 'movie' }), false);
  assert.equal(h.lp.requests.markRequested({ tmdbId: 1, mediaType: 'collection' }), false);
});

test('fresh Seerr details that already show a request mark the rows instead of requesting (advanced modal skipped too)', async t => {
  const h = await mount(t, got, { api: {
    fetchMovieDetails: async id => ({ id, title: 'details', mediaType: 'movie', mediaInfo: { status: 2 } }),
    shouldShowAdvanced: () => true
  } });
  h.page.querySelector('.je-lp-row[data-je-lp-id="movie"] .je-lp-request').click();
  await tick(); await tick(); await tick();
  assert.equal(h.modals.length, 0);
  assert.equal(h.requests.length, 0);
  assert.match(h.status('movie'), /jellyseerr_btn_requested/);
  assert.equal(h.toasts.length, 0);
});
