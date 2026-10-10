import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../../helpers/harness.mjs';
import { setup, ph, view, tick, playlistPage, MODULES, esc, LIST, COLLECTION, ITEM_A } from './lp-harness.mjs';

test('feature off: nothing starts, nothing renders and no network in the first 300 ms', async t => {
  const calls = [];
  const h = createHarness({
    html: playlistPage([ITEM_A]),
    url: `http://jellyfin.test/web/index.html#/details?id=${LIST}`,
    JE: {
      pluginConfig: { ListPlaceholdersEnabled: false, JellyseerrEnabled: true }, t: k => k, escapeHtml: esc,
      core: { api: { plugin: async (...args) => { calls.push(args); return {}; } }, navigation: { onViewPage: () => { calls.push(['onViewPage']); } } },
      session: { getEpoch: () => 0, isCurrent: () => true, onUserChange: () => calls.push(['onUserChange']) }
    },
    apiClient: { subscribe: () => { calls.push(['subscribe']); return () => {}; } }
  });
  t.after(() => h.close());
  h.load('jellyseerr/seerr-status.js');
  for (const file of MODULES) h.load(`jellyseerr/listplaceholders/${file}`);
  h.JE.initializeListPlaceholders();
  const card = h.document.createElement('div');
  card.innerHTML = '<div class="cardBox"><div class="jellyseerr-meta"></div></div>';
  h.JE.listPlaceholders.appendCardAction(card, { id: 1, mediaType: 'movie' });
  const mount = h.document.createElement('div');
  h.JE.listPlaceholders.appendModalAction(mount, { id: 1 }, 'movie');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(calls, []);
  assert.equal(card.querySelector('.je-lp-card-add'), null);
  assert.equal(mount.children.length, 0);
  assert.equal(h.document.querySelector('[class^="je-lp"], #je-list-placeholders-styles'), null);
});

test('feature on: loading the modules alone makes no request until a list page is shown', async t => {
  const items = { [LIST]: { Id: LIST, Name: 'M', Type: 'Playlist' }, [COLLECTION]: { Id: COLLECTION, Name: 'C', Type: 'BoxSet' } };
  const unsub = [];
  const h = setup(t, {
    html: playlistPage([ITEM_A]),
    plugin: async () => view({ placeholders: [ph('x')], order: [`e:${ITEM_A}:0`, 'p:x'] }),
    globals: {}
  });
  h.window.ApiClient.subscribe = (types, fn) => { unsub.push([...types]); h.JE.__library = fn; return () => {}; };
  h.JE.__items = items;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(h.calls.length, 0);
  h.JE.initializeListPlaceholders();
  h.JE.initializeListPlaceholders();
  assert.deepEqual(unsub, [['LibraryChanged']], 'subscribes once');
  assert.equal(h.JE.__viewOptions.immediate, true);
  // a non-list details page does nothing
  h.JE.__items.ffffffffffffffffffffffffffffffff = { Id: 'ffffffffffffffffffffffffffffffff', Type: 'Movie' };
  await h.lp.onViewShow(h.document.querySelector('.itemDetailPage'), '#/details?id=ffffffffffffffffffffffffffffffff');
  assert.equal(h.calls.length, 0);
  // the playlist page attaches and loads its view once
  await h.lp.onViewShow(h.document.querySelector('.itemDetailPage'), `#/details?id=${LIST}&serverId=s`);
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], `/list-placeholders/${LIST}`);
  assert.equal(h.lp.controllers.size, 1);
  // LibraryChanged for this playlist re-fetches (debounced); for others it doesn't
  h.JE.__library({ MessageType: 'LibraryChanged', Data: { ItemsUpdated: ['11111111111111111111111111111111'] } });
  h.JE.__library({ MessageType: 'LibraryChanged', Data: { ItemsUpdated: [LIST.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')] } });
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(h.calls.length, 2);
  // user switch forgets controllers and caches
  h.switchUser();
  assert.equal(h.lp.controllers.size, 0);
  assert.equal(h.lp.idFromHash('#/home'), null);
  assert.equal(h.lp.idFromHash('#/details?id=nope'), null);
});

test('api: views are shared while in flight, reused within maxAge, and mutations publish fresh views', async t => {
  let resolveGet;
  const h = setup(t, { plugin: (path, options = {}) => {
    if (!options.method) return new Promise(resolve => { resolveGet = resolve; });
    if (options.method === 'PUT') throw Object.assign(new Error('HTTP 409'), { status: 409, responseJSON: { code: 'rev_conflict', view: view({ rev: 7 }) } });
    return Promise.resolve({ listId: COLLECTION, listKind: 'collection', name: 'N', result: { added: [], addedAsItems: [], skipped: [], view: view({ listId: COLLECTION, rev: 2 }) } });
  } });
  const published = [];
  h.document.addEventListener(h.lp.events.VIEW, e => published.push(e.detail.view.rev));
  const a = h.lp.api.getView(LIST);
  const b = h.lp.api.getView(LIST.toUpperCase());
  assert.equal(h.calls.length, 1);
  resolveGet(view());
  assert.equal(await a, await b);
  await h.lp.api.getView(LIST, { maxAgeMs: 5000 });
  assert.equal(h.calls.length, 1);
  await assert.rejects(h.lp.api.getView('../etc'));
  await assert.rejects(h.lp.api.reorder(LIST, 1, ['p:x'], null), e => e.status === 409);
  assert.deepEqual(published, [7]);
  const created = await h.lp.api.createList('collection', { name: 'N', entries: [] });
  assert.equal(created.listId, COLLECTION);
  assert.equal(h.calls.at(-1)[0], '/list-placeholders/collections');
  assert.equal(h.calls.at(-1)[1].skipRetry, true);
  assert.ok(h.calls.at(-1)[1].body.requestId);
  assert.deepEqual(published, [7, 2]);
  assert.equal(h.lp.errorMessage({ status: 500 }), 'listPlaceholders_err_generic');
  assert.equal(h.lp.errorMessage({ status: 403 }), 'listPlaceholders_err_forbidden');
  assert.equal(h.lp.errorMessage({ responseJSON: { code: 'stale_anchor' } }), 'listPlaceholders_err_changed');
  assert.equal(h.lp.skipReasonText('alreadyInList'), 'listPlaceholders_skip_already_in_list');
  assert.equal(h.lp.skipReasonText('weird'), 'listPlaceholders_skip_other');
});

function seasonModalHarness(t, { partial = true } = {}) {
  const requests = [];
  const h = createHarness({
    JE: {
      pluginConfig: {}, t: (k, p) => k + (p ? JSON.stringify(p) : ''), escapeHtml: esc, toast: () => {},
      cdn: { url: () => '' },
      jellyseerrAPI: {
        fetchRequestSettings: async () => ({ partialRequestsEnabled: partial, enableSpecialEpisodes: false }),
        fetchTvShowDetails: async () => ({ id: 1399, name: 'GoT', externalIds: { tvdbId: 1 }, seasons: [1, 2, 3].map(n => ({ seasonNumber: n, episodeCount: 10, airDate: '2011-04-17' })) }),
        fetchTvSeasonDetails: async () => null, fetchTmdbTvDetails: async () => null, fetchUserQuota: async () => null,
        shouldShowAdvanced: () => false,
        requestTvSeasons: async (...args) => { requests.push(args); return {}; }
      }
    }
  });
  t.after(() => h.close());
  h.load('jellyseerr/seerr-status.js');
  h.load('jellyseerr/ui/ui-icons.js');
  h.load('jellyseerr/modal.js');
  h.load('jellyseerr/ui/ui-season-modal.js');
  // ui-results.js / ui-request-modals.js provide these in production
  h.JE.internals.jellyseerrUi.markCardRequested = () => {};
  h.JE.internals.jellyseerrUi.handleRequestError = async (error) => { throw error; };
  return { ...h, requests };
}

test('season modal ticks the preselected seasons before it opens', async t => {
  const h = seasonModalHarness(t);
  await h.JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'GoT', null, false, { preselectedSeasons: [2] });
  const checked = [...h.document.querySelectorAll('.jellyseerr-season-item .jellyseerr-season-checkbox')].filter(c => c.checked).map(c => c.dataset.seasonNumber);
  assert.deepEqual(checked, ['2']);
  assert.equal(h.document.querySelector('.jellyseerr-season-preselect-note'), null);
  const events = [];
  h.document.addEventListener('jellyseerr-media-requested', e => events.push(JSON.parse(JSON.stringify(e.detail))));
  h.document.querySelector('.jellyseerr-modal-button-primary').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(h.requests[0].slice(0, 2).map(x => JSON.parse(JSON.stringify(x))), [1399, [2]]);
  assert.deepEqual(events, [{ tmdbId: 1399, mediaType: 'tv', is4k: false, seasons: [2] }]);
  // without options the modal behaves as before (nothing ticked)
  const plain = seasonModalHarness(t);
  await plain.JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'GoT');
  assert.equal([...plain.document.querySelectorAll('.jellyseerr-season-checkbox')].some(c => c.checked), false);
});

test('season modal says every season is requested when partial requests are off', async t => {
  const h = seasonModalHarness(t, { partial: false });
  await h.JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'GoT', null, false, { preselectedSeasons: [2] });
  assert.ok(h.document.querySelector('.jellyseerr-season-preselect-note'));
  assert.equal([...h.document.querySelectorAll('.jellyseerr-season-checkbox')].some(c => c.checked), false);
  // the request covers the regular seasons only, and the event says which (not 'all', which would include specials)
  const events = [];
  h.document.addEventListener('jellyseerr-media-requested', e => events.push(JSON.parse(JSON.stringify(e.detail))));
  h.document.querySelector('.jellyseerr-modal-button-primary').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0][1])), [1, 2, 3]);
  assert.deepEqual(events, [{ tmdbId: 1399, mediaType: 'tv', is4k: false, seasons: [1, 2, 3] }]);
});

function cardHarness(t, { enabled = true } = {}) {
  const h = setup(t, { config: { ListPlaceholdersEnabled: enabled }, load: false, extraJE: {
    core: { ui: { addTouchTapListener: () => {} }, api: { plugin: async () => ({}) } },
    hiddenContent: { getSettings: () => ({ enabled: true }), isHiddenByTmdbId: () => false }
  } });
  h.JE.cdn.selfhst = path => `http://cdn.test/${path}`;
  h.JE.jellyseerrAPI.resolveJellyseerrBaseUrl = () => '';
  h.load('jellyseerr/seerr-status.js');
  h.load('jellyseerr/ui/ui-icons.js');
  h.load('jellyseerr/ui/ui-badges.js');
  h.load('jellyseerr/ui/ui-cards.js');
  for (const file of MODULES) h.load(`jellyseerr/listplaceholders/${file}`);
  return h;
}

test('Seerr cards get the persistent add action; placeholder cards get neither it nor the hide button', t => {
  const h = cardHarness(t);
  const card = h.JE.jellyseerrUI.createJellyseerrCard({ id: 862, mediaType: 'movie', title: 'Toy Story' }, true, true);
  assert.ok(card.querySelector('.jellyseerr-meta .je-lp-card-add'));
  assert.ok(card.querySelector('.je-hide-btn'));
  const placeholder = h.JE.jellyseerrUI.createJellyseerrCard({ id: 862, mediaType: 'movie', title: 'Toy Story', __jeLp: true }, true, true);
  assert.equal(placeholder.querySelector('.je-lp-card-add'), null);
  assert.equal(placeholder.querySelector('.je-hide-btn'), null);
  const collection = h.JE.jellyseerrUI.createJellyseerrCard({ id: 1, mediaType: 'collection', name: 'C' }, true, true);
  assert.equal(collection.querySelector('.je-lp-card-add'), null);
  h.JE.jellyseerrUI.releasePosters();
});

test('Seerr cards are unchanged while the feature is off', t => {
  const h = cardHarness(t, { enabled: false });
  const card = h.JE.jellyseerrUI.createJellyseerrCard({ id: 862, mediaType: 'movie', title: 'Toy Story' }, true, true);
  assert.equal(card.querySelector('.je-lp-card-add'), null);
  h.JE.jellyseerrUI.releasePosters();
});

test('a mutation answer that arrives after a user switch is dropped: no view event, no cache, no toast, no retry', async t => {
  let resolvePost;
  let rejectDelete;
  const h = setup(t, { plugin: (path, options = {}) => {
    if (options.method === 'POST') return new Promise((resolve) => { resolvePost = resolve; });
    if (options.method === 'DELETE') {
      if (rejectDelete) return Promise.resolve(view({ rev: 10 })); // a (wrong) retry would land here
      return new Promise((_, reject) => { rejectDelete = reject; });
    }
    return Promise.resolve(view({ rev: 1, canEdit: false }));
  } });
  h.JE.initializeListPlaceholders();
  const published = [];
  h.document.addEventListener(h.lp.events.VIEW, e => published.push(e.detail.view.rev));
  const add = h.lp.api.addPlaceholders(LIST, [{ kind: 'custom', title: 'x' }]);
  const removal = h.lp.actions.remove({ listId: LIST, view: view({ rev: 3, placeholders: [ph('x')] }) }, ph('x'));
  h.switchUser();
  resolvePost({ added: ['x'], addedAsItems: [], skipped: [], view: view({ rev: 9, canEdit: true }) });
  await assert.rejects(add, e => h.lp.isStaleIdentityError(e) && e.name === 'AbortError');
  rejectDelete(Object.assign(new Error('HTTP 409'), { status: 409, responseJSON: { code: 'rev_conflict', view: view({ rev: 9, placeholders: [ph('x')] }) } }));
  await removal;
  assert.deepEqual(published, []);
  assert.equal(h.toasts.length, 0);
  assert.equal(h.calls.filter(([, o]) => o.method === 'DELETE').length, 1, 'no rev-conflict retry under the new identity');
  // nothing was cached: a maxAge read asks the server and gets the new user's view
  const fresh = await h.lp.api.getView(LIST, { maxAgeMs: 5000 });
  assert.equal(fresh.canEdit, false);
  assert.equal(fresh.rev, 1);
});
