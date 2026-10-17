// Phase 4c3a: list pages draw the entries that aren't in the library — playlist rows inline in list order (also with no
// real items), the collection section, per-entry status and Request (the shared sheet, the list's own route), the
// Playlists grid's incomplete mark from the summary route, Spoiler Guard before paint, and the lifecycle: repeated
// views, clones, Back, person switch, late and reversed answers, settings. The real modules against a fake server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHarness, jsRoot, jsonResponse, deferred } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const MODULES = [
  'arr/status/status-core.js', 'arr/status/status-styles.js',
  'arr/ask/ask-core.js', 'arr/ask/ask-sheet-styles.js', 'arr/ask/ask-sheet.js',
  'arr/lists/list-api.js', 'arr/lists/list-render.js', 'arr/lists/list-request.js', 'arr/lists/list-playlist.js',
  'arr/lists/list-collection.js', 'arr/lists/list-grid.js', 'arr/lists/list-pages.js'
];

/** JE.t as the real one behaves: the English string with {name} parameters filled in (a missing key fails the test). */
function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

const LIST = 'a'.repeat(32);
const COLL = 'c'.repeat(32);
const ITEM = n => n.toString(16).padStart(32, '0');
const MEMBER = { role: 'member', canRequest: true, canRequestMovies: true, canRequestSeries: true, asksFirst: false, can4kMovies: false, can4kSeries: false, backend: 'je', contact: 'Dad', freeEpisodes: 5 };
const CONFIG = {
  ArrStatusEnabled: true, ArrRequestsEnabled: true, ArrListsEnabled: true, ArrListPlaylistUiEnabled: true,
  ArrListCollectionUiEnabled: true, ArrListRequestsEnabled: true, ArrListStatusEnabled: true
};

/** An entry as GET acquire/lists/{id} answers it. */
function ph(id, extra = {}) {
  return {
    id, token: `p:${id}`, kind: 'movie', mediaType: 'movie', tmdbId: 100, title: `Title ${id.slice(0, 4)}`, year: 2001,
    releaseDate: '2001-05-01', released: true, posterPath: '/p.jpg', episodes: [], filledCount: 0, addedByMe: false,
    addedAt: '2026-10-10T00:00:00Z', titleKey: 'movie:tmdb:100', edition: 'standard', status: null, actions: [],
    expectedCount: 0, airedCount: 0, ...extra
  };
}

const P = n => 'f' + String(n).padStart(31, '0');

/** A playlist view. */
function view(placeholders, order, extra = {}) {
  return { listId: LIST, listKind: 'playlist', rev: 1, canEdit: false, nativeCanEdit: false, actions: [], statusShown: true, swapIn: false, reconciling: false, placeholders, order, ...extra };
}

/**
 * A harness with the list pages loaded against fake routes.
 * @returns {Object} Harness pieces.
 */
function setup(t, { config = {}, prefs = {}, views, summaries, preview, submit, items = {}, spoiler = null, getItems, html = '', me = MEMBER } = {}) {
  const calls = [];
  const toasts = [];
  const viewHooks = [];
  const bodySubs = new Map();
  const userChange = [];
  const state = { epoch: 1 };
  const h = createHarness({
    html,
    url: 'http://jellyfin.test/web/index.html#/details?id=' + LIST,
    apiClient: { getItems: getItems || (async () => ({ Items: [] })) },
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      const path = u.pathname.replace(/^\/JellyfinEnhanced/, '');
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ method, path, body, headers: init.headers });
      let m;
      if (method === 'POST' && path === '/acquire/lists/summaries') return jsonResponse(...await summaries(body, calls));
      if (method === 'POST' && (m = /^\/acquire\/lists\/([0-9a-f]{32})\/requests\/preview$/.exec(path))) return jsonResponse(...await preview(m[1], body));
      if (method === 'POST' && (m = /^\/acquire\/lists\/([0-9a-f]{32})\/requests$/.exec(path))) return jsonResponse(...await submit(m[1], body));
      if (method === 'GET' && (m = /^\/acquire\/lists\/([0-9a-f]{32})$/.exec(path))) {
        const [b, s = 200] = await views(m[1], calls.filter(c => c.path === path).length);
        return { status: s, headers: { get: () => null }, text: async () => (b == null ? '' : JSON.stringify(b)) };
      }
      if (path === '/acquire/requests/me') return jsonResponse({ outcome: 'accepted', reason: 'me', me });
      if (path.startsWith('/acquire/requests/quota')) return jsonResponse({ outcome: 'accepted', reason: 'quota', quota: { available: false } });
      if (path.startsWith('/acquire/requests/check')) return jsonResponse({ check: { canRequest: true, blocked: null } });
      return jsonResponse({ error: true, code: 'not_found' }, 404);
    },
    JE: {
      pluginConfig: { ...CONFIG, ...config },
      t: translate,
      toast: text => toasts.push(text),
      currentSettings: { ...prefs },
      helpers: { getItemCached: async id => items[id] || null },
      core: {
        navigation: { onViewPage: (fn, opts) => { viewHooks.push(fn); if (opts?.immediate) fn('x', null, h.window.location.hash); return () => {}; } },
        dom: { onBodyMutation: (id, fn) => { bodySubs.set(id, fn); return { unsubscribe() { bodySubs.delete(id); } }; }, removeBodySubscriber: id => bodySubs.delete(id) }
      },
      session: { getEpoch: () => state.epoch, isCurrent: e => e === state.epoch, onUserChange: (name, fn) => userChange.push(fn) },
      spoilerBlur: spoiler || undefined
    }
  });
  t.after(() => h.close());
  for (const m of MODULES) h.load(m);
  const doc = h.document;
  /** Shows a page through the captured view hook. */
  const show = async (page, hash) => {
    if (hash) h.window.location.hash = hash;
    for (const fn of viewHooks) fn('x', page, h.window.location.hash);
    await settle();
  };
  /** Lets reads, renders and timers run. */
  const settle = async (ms = 30) => { for (let i = 0; i < 6; i++) await sleep(ms / 6); };
  /** A playlist details page with real rows. */
  const playlistPage = (rows = [], { ready = true } = {}) => {
    const page = doc.createElement('div');
    page.className = 'page itemDetailPage';
    page.innerHTML = '<div id="childrenContent"><div class="itemsContainer vertical-list"></div></div>';
    const container = page.querySelector('.itemsContainer');
    for (const id of rows) {
      const row = doc.createElement('div');
      row.className = 'listItem listItem-border';
      row.setAttribute('data-id', id);
      row.setAttribute('data-playlistitemid', id);
      row.setAttribute('data-action', 'playallfromhere');
      row.textContent = `real ${id.slice(-2)}`;
      container.appendChild(row);
    }
    if (ready) container.fetchData = () => Promise.resolve();
    doc.body.appendChild(page);
    return { page, container };
  };
  /** The DOM order of the container as tokens (real rows by data-id, JE rows by entry id). */
  const order = container => [...container.children].map(n => n.classList.contains('listItem') ? `e:${n.getAttribute('data-id').slice(-2)}` : n.classList.contains('je-list-row') ? `p:${n.dataset.jeListId.slice(-2)}` : '?');
  /** Starts the pages (the delayed first look, at once). */
  const start = async () => { h.JE.arrListPages.settingsChanged(); await settle(); };
  return { ...h, calls, toasts, state, show, settle, start, playlistPage, order, bodySubs, userChange, viewHooks };
}

const PLAYLIST_ITEM = { Id: LIST, Type: 'Playlist' };

test('a playlist with no real items gets its rows (in list order) once jellyfin-web has set up its container', async t => {
  const entries = [ph(P(1)), ph(P(2)), ph(P(3))];
  const h = setup(t, { views: () => [view(entries, entries.map(e => e.token))], items: { [LIST]: PLAYLIST_ITEM } });
  await h.start();
  const { page, container } = h.playlistPage([], { ready: false });
  await h.show(page);
  assert.equal(container.querySelectorAll('.je-list-row').length, 0, 'nothing before the container is set up');
  await sleep(380); // jellyfin-web still setting the page up past the first wait
  assert.equal(container.querySelectorAll('.je-list-row').length, 0);
  container.fetchData = () => Promise.resolve();
  await sleep(320);
  assert.deepEqual(h.order(container), ['p:01', 'p:02', 'p:03']);
  // Nothing of them is a playable Jellyfin row.
  for (const row of container.querySelectorAll('.je-list-row')) {
    assert.equal(row.classList.contains('listItem'), false);
    assert.equal(row.hasAttribute('data-id'), false);
    assert.equal(row.querySelector('[data-action], .itemAction, [data-id]'), null);
  }
  assert.equal(h.calls.filter(c => c.path === `/acquire/lists/${LIST}`).length, 1, 'waiting for the container reads nothing again');
});

test('rows go between the real rows in the projected order: duplicates, hidden anchors and entries at the start', async t => {
  const [a, b, c] = [ITEM(0xa1), ITEM(0xb2), ITEM(0xc3)];
  const entries = [ph(P(1)), ph(P(2)), ph(P(3)), ph(P(4))];
  // p1 first; a; p2; b (first copy); a hidden-from-this-person item; p3 (its anchor is hidden: follows b); b again; p4.
  const projected = ['p:' + P(1), `e:${a}:0`, 'p:' + P(2), `e:${b}:0`, `e:${ITEM(0xdd)}:0`, 'p:' + P(3), `e:${b}:1`, 'p:' + P(4), `e:${c}:0`];
  const h = setup(t, { views: () => [view(entries, projected)], items: { [LIST]: PLAYLIST_ITEM } });
  await h.start();
  const { page, container } = h.playlistPage([a, b, b, c]);
  await h.show(page);
  assert.deepEqual(h.order(container), ['p:01', 'e:a1', 'p:02', 'e:b2', 'p:03', 'e:b2', 'p:04', 'e:c3']);
  // Jellyfin's own selectors (play from here, select, its drag) see exactly its rows.
  assert.equal(container.querySelectorAll('.listItem').length, 4);
  assert.equal(container.querySelectorAll('[data-action="playallfromhere"]').length, 4);
});

test('a real row dropped among the rows gets the drop index of real rows only (Jellyfin moves the right item)', async t => {
  const [a, b, c] = [ITEM(0xa1), ITEM(0xb2), ITEM(0xc3)];
  const entries = [ph(P(1)), ph(P(2))];
  const h = setup(t, { views: () => [view(entries, ['p:' + P(1), `e:${a}:0`, 'p:' + P(2), `e:${b}:0`, `e:${c}:0`])], items: { [LIST]: PLAYLIST_ITEM } });
  await h.start();
  const { page, container } = h.playlistPage([a, b, c]);
  await h.show(page);
  // Sortable moved c to just after p1 (DOM index 1); among real rows that is index 0.
  const rowC = [...container.querySelectorAll('.listItem')].find(r => r.getAttribute('data-id') === c);
  container.insertBefore(rowC, container.children[1]);
  const end = new h.window.Event('end');
  end.item = rowC;
  end.newIndex = 1;
  container.dispatchEvent(end);
  assert.equal(end.newIndex, 0);
});

test('Jellyfin re-rendering its rows (afterRefresh), a cloned row and a second view of the page leave exactly one set', async t => {
  const a = ITEM(0xa1);
  const entries = [ph(P(1)), ph(P(2))];
  const h = setup(t, { views: () => [view(entries, ['p:' + P(1), `e:${a}:0`, 'p:' + P(2)])], items: { [LIST]: PLAYLIST_ITEM } });
  await h.start();
  const { page, container } = h.playlistPage([a]);
  await h.show(page);
  await h.show(page);
  assert.deepEqual(h.order(container), ['p:01', 'e:a1', 'p:02']);
  // Jellyfin replaces its rows (innerHTML) and calls its hook.
  container.innerHTML = `<div class="listItem" data-id="${a}" data-playlistitemid="${a}"></div>`;
  container.afterRefresh();
  assert.deepEqual(h.order(container), ['p:01', 'e:a1', 'p:02']);
  // A copy of a row (cloned node) is removed by the next draw.
  container.appendChild(container.querySelector('.je-list-row').cloneNode(true));
  container.afterRefresh();
  assert.equal(container.querySelectorAll('.je-list-row').length, 2);
  // A re-render that bypasses the hook: the observer puts them back.
  container.innerHTML = `<div class="listItem" data-id="${a}" data-playlistitemid="${a}"></div>`;
  await h.settle(60);
  assert.deepEqual(h.order(container), ['p:01', 'e:a1', 'p:02']);
});

test('late and reversed answers: the newest read wins and a lower revision never replaces a higher one', async t => {
  const first = deferred();
  const second = deferred();
  const reads = [first, second];
  const h = setup(t, { views: (_, n) => reads[n - 1].promise, items: { [LIST]: PLAYLIST_ITEM } });
  await h.start();
  const { page, container } = h.playlistPage([]);
  await h.show(page);
  await h.show(page); // a second look starts a newer read
  second.resolve([view([ph(P(2))], ['p:' + P(2)], { rev: 5 })]);
  await h.settle();
  first.resolve([view([ph(P(1))], ['p:' + P(1)], { rev: 4 })]);
  await h.settle();
  assert.deepEqual(h.order(container), ['p:02']);
  // Two reads answered in reverse with the same revision (another person's limits changed what they see, not the
  // list): the older read's answer never replaces the newer one.
  const third = deferred();
  const fourth = deferred();
  reads.push(third, fourth);
  await h.show(page);
  await h.show(page);
  fourth.resolve([view([ph(P(4))], ['p:' + P(4)], { rev: 6 })]);
  await h.settle();
  third.resolve([view([ph(P(3))], ['p:' + P(3)], { rev: 6 })]);
  await h.settle();
  assert.deepEqual(h.order(container), ['p:04']);
  // A change's answer with an older revision is ignored too.
  h.JE.internals.arrListPages.pages.controllers.forEach(c => c.applyView(view([ph(P(9))], ['p:' + P(9)], { rev: 3 }), { fromChange: true }));
  assert.deepEqual(h.order(container), ['p:04']);
});

test('a person switch removes every row at once and drops answers to reads made before it', async t => {
  const pending = deferred();
  let n = 0;
  const h = setup(t, {
    views: () => { n += 1; return n === 1 ? [view([ph(P(1))], ['p:' + P(1)])] : n === 2 ? pending.promise : [view([ph(P(3))], ['p:' + P(3)])]; },
    items: { [LIST]: PLAYLIST_ITEM }
  });
  await h.start();
  const { page, container } = h.playlistPage([]);
  await h.show(page);
  assert.deepEqual(h.order(container), ['p:01']);
  await h.show(page); // a read that will answer after the switch
  h.state.epoch = 2;
  h.userChange.forEach(fn => fn());
  assert.equal(h.document.querySelectorAll('.je-list-row').length, 0, 'gone at the switch');
  pending.resolve([view([ph(P(7))], ['p:' + P(7)], { rev: 9 })]);
  await h.settle(60);
  // The new person's own read (after the switch) is what the page shows; the old answer never.
  assert.deepEqual(h.order(container), ['p:03']);
});

test('leaving the page pauses it (no reads, timers or status subscriptions); Back reads again and focuses the opened entry', async t => {
  const opened = [];
  const entries = [ph(P(1)), ph(P(2), { kind: 'episodes', mediaType: 'tv', titleKey: 'tv:tvdb:5', tmdbId: 55, seasonNumber: 2, episodes: [{ s: 2, e: 3, title: 'Ep' }] })];
  const h = setup(t, { views: () => [view(entries, entries.map(e => e.token))], items: { [LIST]: PLAYLIST_ITEM } });
  h.JE.titleDetails = { openKey: (key, options) => { opened.push({ key, options }); return Promise.resolve(true); } };
  await h.start();
  const { page, container } = h.playlistPage([]);
  await h.show(page);
  container.querySelectorAll('.je-list-row-main')[1].click();
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ key: 'tv:tvdb:5', options: { mediaType: 'tv', tmdbId: 55, season: 2, episode: 3 } }]);
  const other = h.document.createElement('div');
  other.className = 'page itemDetailPage';
  h.document.body.appendChild(other);
  page.classList.add('hide');
  await h.show(other, '#/details?id=' + 'e'.repeat(32));
  const ctrl = [...h.JE.internals.arrListPages.pages.controllers][0];
  assert.equal(ctrl.paused, true);
  assert.equal(ctrl.statusOff, null);
  const reads = h.calls.filter(c => c.path === `/acquire/lists/${LIST}`).length;
  // Back.
  other.classList.add('hide');
  page.classList.remove('hide');
  await h.show(page, '#/details?id=' + LIST);
  assert.equal(h.calls.filter(c => c.path === `/acquire/lists/${LIST}`).length, reads + 1);
  assert.equal(h.document.activeElement, container.querySelectorAll('.je-list-row-main')[1]);
});

test('each entry shows its own exact status (episodes and 4K), and an unknown status or an outage never reads Ready', async t => {
  const ep = (id, e, stage) => ph(id, { kind: 'episodes', mediaType: 'tv', titleKey: 'tv:tvdb:9', seasonNumber: 1, episodes: [{ s: 1, e }], status: { key: `tv:tvdb:9:s1:e${e}`, kind: 'episode', stage, reason: { code: stage === 'ready' ? 'ready' : 'not_in_arr' } } });
  const entries = [
    ep(P(1), 1, 'ready'),
    ep(P(2), 2, 'notHere'),
    ph(P(3), { edition: '4k', status: { key: 'movie:tmdb:100@4k', kind: 'movie', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 40 } } }),
    ph(P(4), { status: null }),
  ];
  const h = setup(t, { views: () => [view(entries, entries.map(e => e.token))], items: { [LIST]: PLAYLIST_ITEM } });
  await h.start();
  const { page, container } = h.playlistPage([]);
  await h.show(page);
  const rows = [...container.querySelectorAll('.je-list-row')];
  const text = n => rows[n].querySelector('.je-arr-pill-text')?.textContent || null;
  assert.equal(text(0), en.arr_status_ready);
  assert.equal(text(1), en.arr_status_not_here);
  assert.match(text(2), /40/);
  assert.equal(text(3), null, 'no status: no pill');
  assert.ok(rows[3].textContent.includes(en.arr_lists_not_in_library));
  assert.ok(!rows[3].textContent.includes(en.arr_status_ready));
  assert.ok(!rows[0].textContent.includes(en.arr_lists_not_in_library), 'ready by its status: not said to be missing');
  // The whole page with statuses switched off for the person (statusShown false): no pill anywhere, nothing Ready.
  const off = setup(t, { views: () => [view(entries, entries.map(e => e.token), { statusShown: false })], items: { [LIST]: PLAYLIST_ITEM } });
  await off.start();
  const second = off.playlistPage([]);
  await off.show(second.page);
  assert.equal(second.container.querySelectorAll('.je-arr-pill').length, 0);
  assert.ok(!second.container.textContent.includes(en.arr_status_ready));
});

test('fill progress is said apart from the request status, and dates read as year, coming or TBA', async t => {
  const entries = [
    ph(P(1), { kind: 'season', mediaType: 'tv', titleKey: 'tv:tvdb:9', seasonNumber: 2, filledCount: 3, expectedCount: 8, airedCount: 6, releaseDate: null, released: false }),
    ph(P(2), { releaseDate: '2099-01-02', released: false }),
    ph(P(3), { kind: 'custom', titleKey: null, tmdbId: null, releaseDate: null, year: null, title: 'Fan edit' }),
  ];
  const h = setup(t, { views: () => [view(entries, entries.map(e => e.token))], items: { [LIST]: PLAYLIST_ITEM } });
  await h.start();
  const { page, container } = h.playlistPage([]);
  await h.show(page);
  const subs = [...container.querySelectorAll('.je-list-sub')].map(n => n.textContent);
  assert.match(subs[0], /Season 2 · 3 of 6 aired in the list · 2 to come · Date to be announced/);
  assert.match(subs[1], /Coming /);
  assert.equal(subs[2], en.arr_lists_kind_custom);
  // A custom entry opens nothing.
  assert.equal(container.querySelectorAll('.je-list-row')[2].querySelector('button.je-list-row-main'), null);
});

test('Request uses the list preview and the shared sheet in its fixed mode, and sends the list confirmation with one id', async t => {
  const entries = [
    ph(P(1), { actions: ['request'], status: { key: 'movie:tmdb:100', kind: 'movie', stage: 'notHere', reason: { code: 'not_in_arr' } } }),
    ph(P(2), { actions: ['request'], status: { key: 'movie:tmdb:101', kind: 'movie', stage: 'downloading', reason: { code: 'downloading' } } }),
    ph(P(3), { actions: [], status: null }),
  ];
  const submits = [];
  let fail = true;
  const h = setup(t, {
    views: () => [view(entries, entries.map(e => e.token), { actions: ['request'] })],
    items: { [LIST]: PLAYLIST_ITEM },
    preview: (_, body) => [{ items: [{ placeholderId: body.placeholderIds[0], title: 'x', outcome: 'request', reason: 'looking', cost: 1 }], askable: 1, cost: 1, maxBatch: 20 }],
    submit: (_, body) => {
      submits.push(body);
      if (fail) { fail = false; throw new TypeError('network'); }
      return [{ operationId: 'op', replayed: false, results: [{ placeholderId: P(1), result: { outcome: 'accepted', reason: 'looking', certainty: 'Succeeded', message: 'ok', requestId: 'r' } }], view: null }];
    }
  });
  await h.start();
  const { page, container } = h.playlistPage([]);
  await h.show(page);
  const buttons = container.querySelectorAll('.je-list-request');
  assert.equal(buttons.length, 1, 'only an askable entry the server offers Request on gets the button');
  buttons[0].click();
  await h.settle(60);
  const sheet = h.document.querySelector('.je-sheet');
  assert.ok(sheet, 'the shared sheet opened');
  assert.equal(sheet.querySelectorAll('.je-sheet-card').length, 0, 'fixed scope: no scope cards');
  assert.match(sheet.textContent, /Uses 1 request/);
  const preview = h.calls.find(c => c.path.endsWith('/requests/preview'));
  assert.deepEqual(preview.body, { placeholderIds: [P(1)] });
  sheet.querySelector('.je-sheet-primary').click();
  await h.settle(60);
  assert.ok(h.document.querySelector('.je-sheet'), 'a lost answer keeps the sheet open');
  h.document.querySelector('.je-sheet-primary').click();
  await h.settle(60);
  assert.equal(h.document.querySelector('.je-sheet'), null);
  assert.equal(submits.length, 2);
  assert.equal(submits[0].clientId, submits[1].clientId, 'the same confirmation is sent again with its id');
  assert.deepEqual(submits[1].placeholderIds, [P(1)]);
  assert.ok(h.toasts.some(text => text.startsWith('Asked')), h.toasts.join(' / '));
});

test('a season entry asks for exactly that season: the sheet shows its scope, no scope cards or 4K toggle, and reads no seasons', async t => {
  const entry = ph(P(5), { kind: 'season', mediaType: 'tv', titleKey: 'tv:tvdb:42', tmdbId: 42, seasonNumber: 2, actions: ['request'] });
  const submits = [];
  const h = setup(t, {
    me: { ...MEMBER, can4kSeries: true },
    views: () => [view([entry], [entry.token], { actions: ['request'] })],
    items: { [LIST]: PLAYLIST_ITEM },
    preview: (_, body) => [{ items: [{ placeholderId: body.placeholderIds[0], title: 'x', outcome: 'approval', reason: 'awaiting_approval', cost: 0 }], askable: 1, cost: 0, maxBatch: 20 }],
    submit: (_, body) => { submits.push(body); return [{ operationId: 'op', replayed: false, results: [{ placeholderId: P(5), result: { outcome: 'accepted', reason: 'awaiting_approval', certainty: 'Succeeded', message: 'ok', requestId: 'r' } }], view: null }]; }
  });
  await h.start();
  const { page, container } = h.playlistPage([]);
  await h.show(page);
  container.querySelector('.je-list-request').click();
  await h.settle(60);
  const sheet = h.document.querySelector('.je-sheet');
  assert.ok(sheet);
  assert.equal(sheet.querySelectorAll('.je-sheet-card, .je-sheet-variant').length, 0);
  assert.match(sheet.querySelector('.je-sheet-facts').textContent, /^Season 2$/);
  assert.match(sheet.textContent, new RegExp(en.arr_lists_preview_approval.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(h.calls.filter(c => /tmdb|season/i.test(c.path) && !c.path.includes('/acquire/lists/')).length, 0, 'no season list read for a fixed entry');
  sheet.querySelector('.je-sheet-primary').click();
  await h.settle(60);
  assert.deepEqual(submits.map(b => b.placeholderIds), [[P(5)]]);
});

test('request rights are not edit rights: a viewer may ask, an editor whose role may not ask gets no button', async t => {
  const entry = ph(P(1), { actions: ['request'] });
  const viewer = setup(t, { views: () => [view([entry], [entry.token], { canEdit: false, actions: ['request'] })], items: { [LIST]: PLAYLIST_ITEM } });
  await viewer.start();
  const a = viewer.playlistPage([]);
  await viewer.show(a.page);
  assert.equal(a.container.querySelectorAll('.je-list-request').length, 1);
  const editor = setup(t, { views: () => [view([{ ...entry, actions: ['remove', 'note'] }], [entry.token], { canEdit: true, actions: ['edit', 'reorder'] })], items: { [LIST]: PLAYLIST_ITEM } });
  await editor.start();
  const b = editor.playlistPage([]);
  await editor.show(b.page);
  assert.equal(b.container.querySelectorAll('.je-list-request').length, 0);
});

test('Spoiler Guard: nothing is painted before its state is known; guarded titles lose episode titles and notes; a failed load guards all', async t => {
  const loaded = deferred();
  const sg = { whenLoaded: () => loaded.promise, isLoadOk: () => true, isTmdbEnabled: (media, id) => media === 'tv' && Number(id) === 77, isCollectionEnabledFor: () => false, guardedIds: () => ({ series: [], movies: [] }) };
  const entries = [
    ph(P(1), { kind: 'episodes', mediaType: 'tv', tmdbId: 77, titleKey: 'tv:tvdb:7', seasonNumber: 1, episodes: [{ s: 1, e: 9, title: 'The Big Twist' }], note: 'Laura dies here' }),
    ph(P(2), { kind: 'episodes', mediaType: 'tv', tmdbId: 88, titleKey: 'tv:tvdb:8', seasonNumber: 1, episodes: [{ s: 1, e: 1, title: 'Pilot' }], note: 'Start here' }),
  ];
  const h = setup(t, { config: { SpoilerBlurEnabled: true }, spoiler: sg, views: () => [view(entries, entries.map(e => e.token))], items: { [LIST]: PLAYLIST_ITEM } });
  await h.start();
  const { page, container } = h.playlistPage([]);
  await h.show(page);
  assert.equal(container.querySelectorAll('.je-list-row').length, 0, 'nothing before Spoiler Guard answered');
  loaded.resolve();
  await h.settle();
  const [guarded, open] = container.querySelectorAll('.je-list-row');
  assert.ok(!guarded.textContent.includes('The Big Twist'));
  assert.ok(!guarded.textContent.includes('Laura'));
  assert.ok(!(guarded.querySelector('.je-list-row-main').getAttribute('aria-label') || '').includes('Twist'));
  assert.ok(guarded.textContent.includes(en.arr_lists_note_hidden));
  assert.ok(open.textContent.includes('Pilot'));
  assert.ok(open.textContent.includes('Start here'));
  // A library series the person guards (by its Jellyfin id) guards its entries too.
  const mapped = setup(t, {
    config: { SpoilerBlurEnabled: true },
    spoiler: { ...sg, whenLoaded: async () => {}, isTmdbEnabled: () => false, guardedIds: () => ({ series: ['9'.repeat(32)], movies: [] }) },
    getItems: async () => ({ Items: [{ Id: '9'.repeat(32), Type: 'Series', ProviderIds: { Tmdb: '88' } }] }),
    views: () => [view(entries, entries.map(e => e.token))], items: { [LIST]: PLAYLIST_ITEM }
  });
  await mapped.start();
  const m = mapped.playlistPage([]);
  await mapped.show(m.page);
  assert.ok(!m.container.textContent.includes('Pilot'));
  // The state couldn't be read: every entry is guarded.
  const failed = setup(t, { config: { SpoilerBlurEnabled: true }, spoiler: { ...sg, whenLoaded: async () => {}, isLoadOk: () => false }, views: () => [view(entries, entries.map(e => e.token))], items: { [LIST]: PLAYLIST_ITEM } });
  await failed.start();
  const f = failed.playlistPage([]);
  await failed.show(f.page);
  assert.ok(!f.container.textContent.includes('Pilot'));
  assert.ok(!f.container.textContent.includes('Start here'));
});

test('the collection section follows the server order (release date, TBA last), and covered keys come from this view only', async t => {
  const entries = [
    ph(P(1), { title: 'Early', releaseDate: '1999-01-01' }),
    ph(P(2), { title: 'Season', kind: 'season', mediaType: 'tv', titleKey: 'tv:tvdb:4', seasonNumber: 1, filledCount: 2, expectedCount: 10, airedCount: 10 }),
    ph(P(3), { title: 'Late 4K', releaseDate: '2010-01-01', edition: '4k', titleKey: 'movie:tmdb:300' }),
    ph(P(4), { title: 'Untitled', releaseDate: null, released: false, year: null }),
  ];
  const coll = { listId: COLL, listKind: 'collection', rev: 2, canEdit: false, actions: [], statusShown: false, placeholders: entries, order: null };
  const h = setup(t, { views: () => [coll], items: { [COLL]: { Id: COLL, Type: 'BoxSet' } } });
  const page = h.document.createElement('div');
  page.className = 'page itemDetailPage';
  page.innerHTML = '<div class="detailSection"><div class="collectionItems"><div class="verticalSection"></div></div><div class="nextUpSection"></div></div>';
  h.document.body.appendChild(page);
  await h.start();
  await h.show(page, '#/details?id=' + COLL);
  const section = page.querySelector('.collectionItems + .je-list-section');
  assert.ok(section, 'right after the collection items');
  assert.deepEqual([...section.querySelectorAll('.je-list-card-title')].map(n => n.textContent), ['Early', 'Season', 'Late 4K', 'Untitled']);
  assert.match(section.querySelectorAll('.je-list-card')[1].textContent, /2 of 10 aired in the list/);
  assert.match(section.querySelectorAll('.je-list-card')[3].textContent, /Date to be announced/);
  const covered = await h.JE.arrListPages.coveredKeys(COLL);
  assert.deepEqual([...covered.keys].sort(), ['movie:tmdb:100', 'movie:tmdb:100', 'movie:tmdb:300@4k', 'tv:tvdb:4:s1'].filter((k, i, a) => a.indexOf(k) === i).sort());
  // With the collection page off for the person nothing is covered.
  h.JE.currentSettings.listCollectionUi = false;
  h.JE.arrListPages.settingsChanged();
  await h.settle();
  assert.equal(await h.JE.arrListPages.coveredKeys(COLL), null);
  assert.equal(page.querySelector('.je-list-section'), null, 'and the section went at once');
});

test('the Playlists grid asks once for 170 cards, marks incomplete lists instead of the played check, and re-decorates a re-used card', async t => {
  const ids = Array.from({ length: 170 }, (_, i) => ITEM(0x1000 + i));
  const asked = [];
  const h = setup(t, {
    views: () => [null, 404],
    summaries: (body) => { asked.push(body.listIds); return [{ lists: body.listIds.filter((_, i) => i % 2 === 0).map(listId => ({ listId, listKind: 'playlist', missing: 3 })), pending: [] }]; }
  });
  const grid = h.document.createElement('div');
  grid.className = 'page libraryPage';
  grid.innerHTML = '<div class="itemsContainer vertical-wrap">' + ids.map(id => `<div class="card" data-id="${id}" data-type="Playlist"><div class="cardImageContainer"><div class="cardIndicators"><div class="playedIndicator indicator"></div></div></div></div>`).join('') + '</div>';
  h.document.body.appendChild(grid);
  h.window.location.hash = '#/list?parentId=x';
  await h.start();
  await h.settle(200);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].length, 170);
  const cards = [...grid.querySelectorAll('.card')];
  assert.ok(cards[0].classList.contains('je-list-incomplete'));
  assert.equal(cards[0].querySelector('.je-list-grid-indicator').getAttribute('aria-label'), '3 titles not in your library');
  assert.ok(!cards[1].classList.contains('je-list-incomplete'));
  assert.equal(cards[1].querySelector('.je-list-grid-indicator'), null);
  // Jellyfin re-uses a card for another list: it follows the new list, and nothing is asked again for known lists.
  cards[0].setAttribute('data-id', ids[1]);
  h.bodySubs.get('arr-list-grid')([{ addedNodes: [cards[0]] }]);
  await h.settle(200);
  assert.ok(!cards[0].classList.contains('je-list-incomplete'));
  assert.equal(asked.length, 1);
  // Opting out removes every mark.
  h.JE.currentSettings.listPlaylistUi = false;
  h.JE.arrListPages.settingsChanged();
  assert.equal(grid.querySelectorAll('.je-list-incomplete, .je-list-grid-indicator').length, 0);
});

test('with the pages off (server or person) nothing is read or drawn, and turning them off removes what is drawn', async t => {
  const entries = [ph(P(1))];
  const off = setup(t, { config: { ArrListPlaylistUiEnabled: false, ArrListCollectionUiEnabled: false }, views: () => [view(entries, [entries[0].token])], items: { [LIST]: PLAYLIST_ITEM } });
  await off.start();
  const a = off.playlistPage([]);
  await off.show(a.page);
  assert.equal(off.calls.length, 0);
  const hidden = setup(t, { prefs: { listPlaceholders: false }, views: () => [view(entries, [entries[0].token])], items: { [LIST]: PLAYLIST_ITEM } });
  await hidden.start();
  const b = hidden.playlistPage([]);
  await hidden.show(b.page);
  assert.equal(hidden.calls.length, 0);
  const on = setup(t, { views: () => [view(entries, [entries[0].token])], items: { [LIST]: PLAYLIST_ITEM } });
  await on.start();
  const c = on.playlistPage([]);
  await on.show(c.page);
  assert.equal(c.container.querySelectorAll('.je-list-row').length, 1);
  on.JE.currentSettings.listPlaylistUi = false;
  on.JE.arrListPages.settingsChanged();
  assert.equal(c.container.querySelectorAll('.je-list-row').length, 0);
  // Both kinds off (entries hidden altogether): everything stops, even a row put back by hand goes.
  on.JE.currentSettings.listPlaylistUi = null;
  on.JE.arrListPages.settingsChanged();
  await on.settle();
  assert.equal(c.container.querySelectorAll('.je-list-row').length, 1);
  on.JE.currentSettings.listPlaceholders = false;
  on.JE.arrListPages.settingsChanged();
  assert.equal(c.container.querySelectorAll('.je-list-row').length, 0);
  const reads = on.calls.length;
  c.container.afterRefresh?.();
  await on.show(c.page);
  assert.equal(c.container.querySelectorAll('.je-list-row').length, 0);
  assert.equal(on.calls.length, reads, 'nothing read while off');
});

test('a list the person can no longer see (404) takes its rows away', async t => {
  let gone = false;
  const entries = [ph(P(1))];
  const h = setup(t, { views: () => (gone ? [{ error: true, code: 'not_found' }, 404] : [view(entries, [entries[0].token])]), items: { [LIST]: PLAYLIST_ITEM } });
  await h.start();
  const { page, container } = h.playlistPage([]);
  await h.show(page);
  assert.equal(container.querySelectorAll('.je-list-row').length, 1);
  gone = true;
  await h.show(page);
  assert.equal(container.querySelectorAll('.je-list-row').length, 0);
});
