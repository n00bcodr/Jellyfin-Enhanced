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
import { installDomWriteSpy } from '../helpers/dom-write-spy.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const MODULES = [
  'arr/status/status-core.js', 'arr/status/status-styles.js',
  'arr/ask/ask-core.js', 'arr/ask/ask-sheet-styles.js', 'arr/ask/ask-sheet.js',
  'arr/lists/list-api.js', 'arr/lists/list-paint.js', 'arr/lists/list-render.js', 'arr/lists/list-request.js', 'arr/lists/list-playlist.js',
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
function setup(t, { config = {}, prefs = {}, views, summaries, preview, submit, items = {}, spoiler = null, getItems, html = '', me = MEMBER, route = null, realBody = false, plant = {} } = {}) {
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
      if (route) {
        const answer = await route(method, path, body);
        if (answer) return answer;
      }
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
        // realBody: the subscriber hears the document's real mutations (childList, subtree), as JE's shared observer does.
        dom: {
          onBodyMutation: (id, fn) => {
            bodySubs.set(id, fn);
            const mo = realBody ? new h.window.MutationObserver(records => { if (bodySubs.get(id) === fn) fn(records); }) : null;
            mo?.observe(h.document.body, { childList: true, subtree: true });
            return { unsubscribe() { mo?.disconnect(); bodySubs.delete(id); } };
          },
          removeBodySubscriber: id => bodySubs.delete(id)
        }
      },
      session: { getEpoch: () => state.epoch, isCurrent: e => e === state.epoch, onUserChange: (name, fn) => userChange.push(fn) },
      spoilerBlur: spoiler || undefined
    }
  });
  t.after(() => h.close());
  // Every DOM write by a list module must go through the paint gate (paint / erase); the test fails otherwise.
  const spy = installDomWriteSpy(h.window);
  t.after(() => { assert.equal(spy.violations.length, 0, 'list DOM writes outside paint(): ' + JSON.stringify(spy.violations.slice(0, 2))); assert.equal(spy.overflow(), 0); });
  for (const m of MODULES) {
    if (!plant[m]) { h.load(m); continue; }
    // A planted copy of a module (same file name in its stack frames), to prove the spy catches what it should.
    const file = resolve(jsRoot, m);
    const source = plant[m](readFileSync(file, 'utf8'));
    h.window.eval(`[function () {\n${source}\n}][0]();\n//# sourceURL=${file}`);
  }
  spy.watchSheet(h.JE);
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
  /** A collection details page. */
  const collectionPage = () => {
    const page = doc.createElement('div');
    page.className = 'page itemDetailPage';
    page.innerHTML = '<div class="detailSection"><div class="collectionItems"><div class="verticalSection"></div></div></div>';
    doc.body.appendChild(page);
    return page;
  };
  /** Shows a page without waiting (jellyfin-web's view hook only). */
  const showNow = (page, hash) => {
    if (hash) h.window.location.hash = hash;
    for (const fn of viewHooks) fn('x', page, h.window.location.hash);
  };
  /** Starts the pages (the delayed first look, at once). */
  const start = async () => { h.JE.arrListPages.settingsChanged(); await settle(); };
  return { ...h, calls, toasts, state, show, showNow, settle, start, playlistPage, collectionPage, order, bodySubs, userChange, viewHooks, spy };
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

test('a 699-entry list (Arrowverse) draws every row in list order, built in slices so no single task builds them all', async t => {
  const a = ITEM(0xa1);
  const entries = Array.from({ length: 699 }, (_, i) => ph('e' + String(i).padStart(31, '0'), { title: `E${i}` }));
  const projected = entries.slice(0, 300).map(e => e.token).concat([`e:${a}:0`], entries.slice(300).map(e => e.token));
  const h = setup(t, { views: () => [view(entries, projected)], items: { [LIST]: PLAYLIST_ITEM } });
  await h.start();
  const { page, container } = h.playlistPage([a]);
  const built = [];
  const original = h.JE.internals.arrListPages.render.row;
  let inTask = 0;
  h.JE.internals.arrListPages.render.row = (...args) => { inTask += 1; return original(...args); };
  const tick = setInterval(() => { if (inTask) built.push(inTask); inTask = 0; }, 0);
  await h.show(page);
  await h.settle(120);
  clearInterval(tick);
  if (inTask) built.push(inTask);
  const rows = [...container.children];
  assert.equal(rows.filter(n => n.classList.contains('je-list-row')).length, 699);
  assert.equal(rows[300].classList.contains('listItem'), true, 'the real row sits after the 300th entry');
  assert.equal(rows[0].querySelector('.je-list-title').textContent, 'E0');
  assert.equal(rows[699].querySelector('.je-list-title').textContent, 'E698');
  assert.ok(Math.max(...built) <= 150, `rows built per task: ${built.join(',')}`);
  // Jellyfin replacing its rows: the rows come back without being built again.
  let rebuilt = 0;
  h.JE.internals.arrListPages.render.row = (...args) => { rebuilt += 1; return original(...args); };
  container.innerHTML = `<div class="listItem" data-id="${a}" data-playlistitemid="${a}"></div>`;
  container.afterRefresh();
  assert.equal(container.querySelectorAll('.je-list-row').length, 699);
  assert.equal(rebuilt, 0);
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

test('the Playlists grid asks about 170 cards in two calls (the first cards first), marks incomplete lists instead of the played check, and re-decorates a re-used card', async t => {
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
  for (let i = 0; i < 100 && !(asked.length === 2 && grid.querySelector('.card').classList.contains('je-list-incomplete')); i++) await sleep(20);
  await h.settle(60);
  // The cards seen first are asked about alone (marked quickly), then the rest in one call.
  assert.equal(asked.length, 2);
  assert.equal(asked[0].length, 24);
  assert.equal(asked[1].length, 146);
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
  assert.equal(asked.length, 2);
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

// ------------------------------------------------------------------ review round 1

const LIST_B = 'b'.repeat(32);

/** A response whose body arrives when the test says so (the account can change while it is being read). */
function slowBody(gate, status = 200) {
  return { status, ok: status < 300, headers: { get: () => null }, text: () => gate.promise.then(v => JSON.stringify(v)), json: () => gate.promise };
}

test('r1 S1: a change answer still being read when the account switches is never cached, announced or drawn', async t => {
  const body = deferred();
  let reads = 0;
  const h = setup(t, {
    views: () => { reads += 1; return reads === 1 ? [view([ph(P(1))], ['p:' + P(1)])] : [view([ph(P(3))], ['p:' + P(3)], { rev: 2 })]; },
    items: { [LIST]: PLAYLIST_ITEM },
    route: (method, path) => (method === 'PATCH' && path.startsWith(`/acquire/lists/${LIST}/items/`) ? slowBody(body) : null)
  });
  const heard = [];
  h.JE.arrLists.onChange((listId, v, origin) => heard.push({ listId, rev: v?.rev, origin }));
  await h.start();
  const { page, container } = h.playlistPage([]);
  await h.show(page);
  assert.deepEqual(h.order(container), ['p:01']);
  const pending = h.JE.arrLists.patchItem(LIST, P(1), { requestId: 'x1', rev: 1, note: 'n' });
  await h.settle();
  // The previous viewer's answer is still being read when another person signs in on this page.
  h.state.epoch = 2;
  h.userChange.forEach(fn => fn());
  await h.settle();
  await h.show(page);
  assert.deepEqual(h.order(container), ['p:03'], 'the new person sees their own view');
  // The old answer (an entry only the previous viewer may see) finishes arriving.
  body.resolve({ ...view([ph(P(1)), ph(P(8), { title: 'Adults only' })], ['p:' + P(1), 'p:' + P(8)], { rev: 9 }) });
  await assert.rejects(pending, e => e?.stale === true);
  await h.settle(60);
  assert.deepEqual(h.order(container), ['p:03']);
  assert.ok(!container.textContent.includes('Adults only'));
  assert.equal(heard.length, 0, 'nothing was announced to the new person\'s pages');
});

test('r1 S1: a list change from another session is refused by the pages (the change carries its session)', async t => {
  const h = setup(t, { views: () => [view([ph(P(1))], ['p:' + P(1)])], items: { [LIST]: PLAYLIST_ITEM } });
  await h.start();
  const { page, container } = h.playlistPage([]);
  await h.show(page);
  const onListChange = h.JE.internals.arrListPages.pages.onListChange;
  onListChange(LIST, view([ph(P(8))], ['p:' + P(8)], { rev: 50 }), { epoch: 0 });
  onListChange(LIST, view([ph(P(8))], ['p:' + P(8)], { rev: 50 }));
  // A view of another list, announced under this list's id, is refused too.
  onListChange(LIST, view([ph(P(7))], ['p:' + P(7)], { rev: 50, listId: LIST_B }), { epoch: 1 });
  assert.deepEqual(h.order(container), ['p:01']);
  onListChange(LIST, view([ph(P(9))], ['p:' + P(9)], { rev: 51 }), { epoch: 1 });
  assert.deepEqual(h.order(container), ['p:09'], 'this session\'s own change is drawn');
});

test('r1 B1: a page element re-used for another list ignores the late identity lookup of the list shown before', async t => {
  const lookupA = deferred();
  const h = setup(t, {
    views: id => [id === LIST ? view([ph(P(1))], ['p:' + P(1)]) : view([ph(P(2))], ['p:' + P(2)], { listId: LIST_B })],
    items: { [LIST]: lookupA.promise, [LIST_B]: { Id: LIST_B, Type: 'Playlist' } }
  });
  await h.start();
  const { page, container } = h.playlistPage([]);
  // List A is shown; its identity lookup hangs.
  h.window.location.hash = '#/details?id=' + LIST;
  for (const fn of h.viewHooks) fn('x', page, h.window.location.hash);
  await h.settle();
  // jellyfin-web re-uses the same page element for list B.
  await h.show(page, '#/details?id=' + LIST_B);
  assert.deepEqual(h.order(container), ['p:02']);
  lookupA.resolve(PLAYLIST_ITEM);
  await h.settle(60);
  assert.deepEqual(h.order(container), ['p:02'], 'B stays on B\'s page');
  const ctrls = [...h.JE.internals.arrListPages.pages.controllers];
  assert.deepEqual(ctrls.map(c => c.listId), [LIST_B]);
  assert.equal(h.calls.filter(c => c.path === `/acquire/lists/${LIST}`).length, 0, 'A was never read');
});

test('r1 S1/B1: the one acceptance rule (session, view-show generation, route, list) is the controller\'s one ticket', async t => {
  const h = setup(t, { views: () => [view([ph(P(1))], ['p:' + P(1)])], items: { [LIST]: PLAYLIST_ITEM } });
  await h.start();
  const { page } = h.playlistPage([]);
  await h.show(page);
  // The transport's rule: session and list.
  const ticket = h.JE.arrLists.ticket(LIST);
  assert.equal(ticket.current(), true);
  assert.equal(ticket.accepts(view([], [])), true);
  assert.equal(ticket.accepts(view([], [], { listId: LIST_B })), false, 'another list\'s view');
  // The controller's ticket adds the page show and its route.
  const lp = h.JE.internals.arrListPages;
  const ctrl = [...lp.pages.controllers][0];
  const pageTicket = ctrl.ticket;
  assert.equal(pageTicket.current(), true);
  assert.equal(pageTicket.accepts(view([], [])), true);
  h.window.location.hash = '#/details?id=' + LIST_B;
  assert.equal(pageTicket.current(), false, 'route changed');
  h.window.location.hash = '#/details?id=' + LIST;
  assert.equal(pageTicket.current(), true);
  await h.show(page);
  assert.equal(pageTicket.current(), false, 'a newer view show');
  assert.notEqual(ctrl.ticket, pageTicket, 'the show gave the controller a new ticket');
  const second = ctrl.ticket;
  assert.equal(second.current(), true);
  h.state.epoch = 5;
  assert.equal(second.current(), false, 'another session');
  assert.equal(ticket.current(), false);
});

test('r1 S2: Spoiler Guard hides a guarded entry\'s air dates (rows, cards and labels) when air dates are hidden', async t => {
  const sg = prefs => ({ whenLoaded: async () => {}, isLoadOk: () => true, isTmdbEnabled: (media, id) => media === 'tv' && Number(id) === 77, isCollectionEnabledFor: () => false, guardedIds: () => ({ series: [], movies: [] }), getUserPrefs: () => ({ ...prefs }) });
  const entries = [
    ph(P(1), { kind: 'episodes', mediaType: 'tv', tmdbId: 77, titleKey: 'tv:tvdb:7', seasonNumber: 3, episodes: [{ s: 3, e: 1 }], releaseDate: '2099-01-02', released: false }),
    ph(P(2), { kind: 'season', mediaType: 'tv', tmdbId: 77, titleKey: 'tv:tvdb:7', seasonNumber: 4, releaseDate: '2098-03-04', released: true }),
    ph(P(3), { kind: 'episodes', mediaType: 'tv', tmdbId: 88, titleKey: 'tv:tvdb:8', seasonNumber: 1, episodes: [{ s: 1, e: 2 }], releaseDate: '2099-01-02', released: false }),
  ];
  const rowsOf = async (config, prefs) => {
    const h = setup(t, { config: { SpoilerBlurEnabled: true, ...config }, spoiler: sg(prefs), views: () => [view(entries, entries.map(e => e.token))], items: { [LIST]: PLAYLIST_ITEM } });
    await h.start();
    const { page, container } = h.playlistPage([]);
    await h.show(page);
    return [...container.querySelectorAll('.je-list-row')].map(r => r.textContent + ' | ' + r.querySelector('.je-list-row-main').getAttribute('aria-label'));
  };
  const hidden = await rowsOf({}, {});
  assert.ok(!/2099|2098|Coming/.test(hidden[0]), hidden[0]);
  assert.ok(!/2098/.test(hidden[1]), hidden[1]);
  assert.match(hidden[2], /Coming/, 'an entry that isn\'t guarded keeps its date');
  // The person shows air dates (their own Spoiler Guard setting), or the admin doesn't strip them: dates stay.
  assert.match((await rowsOf({}, { HideAirDate: false }))[0], /Coming/);
  assert.match((await rowsOf({ SpoilerStripPremiereDate: false }, {}))[0], /Coming/);
  // The collection section the same (card text and its label).
  const coll = { listId: COLL, listKind: 'collection', rev: 2, canEdit: false, actions: [], statusShown: false, placeholders: entries, order: null };
  const c = setup(t, { config: { SpoilerBlurEnabled: true }, spoiler: sg({}), views: () => [coll], items: { [COLL]: { Id: COLL, Type: 'BoxSet' } } });
  const page = c.document.createElement('div');
  page.className = 'page itemDetailPage';
  page.innerHTML = '<div class="detailSection"><div class="collectionItems"></div></div>';
  c.document.body.appendChild(page);
  await c.start();
  await c.show(page, '#/details?id=' + COLL);
  const cards = [...page.querySelectorAll('.je-list-card')];
  assert.equal(cards.length, 3);
  for (const card of cards.slice(0, 2)) {
    const text = card.textContent + ' | ' + card.querySelector('.je-list-card-main').getAttribute('aria-label');
    assert.ok(!/2099|2098|Coming/.test(text), text);
  }
  assert.match(cards[2].textContent, /Coming/);
});

test('r1 B2: Playlists grid cards that jellyfin-web replaces, re-uses for another list or gives a new played check keep the right mark', async t => {
  const ids = Array.from({ length: 6 }, (_, i) => ITEM(0x2000 + i));
  const missing = { [ids[0]]: 4, [ids[2]]: 2, [ids[4]]: 1 };
  const asked = [];
  const h = setup(t, {
    realBody: true,
    views: () => [null, 404],
    summaries: body => { asked.push(...body.listIds); return [{ lists: body.listIds.filter(id => missing[id]).map(listId => ({ listId, listKind: 'playlist', missing: missing[listId] })), pending: [] }]; }
  });
  const cardHtml = id => `<div class="card squareCard card-withuserdata" data-id="${id}" data-type="Playlist"><div class="cardBox"><div class="cardScalable"><a class="cardImageContainer itemAction"><div class="cardIndicators"><div class="playedIndicator indicator"><span class="material-icons indicatorIcon check"></span></div></div></a></div></div></div>`;
  const grid = h.document.createElement('div');
  grid.className = 'page libraryPage';
  grid.innerHTML = '<div class="itemsContainer vertical-wrap">' + ids.slice(0, 3).map(cardHtml).join('') + '</div>';
  h.document.body.appendChild(grid);
  h.window.location.hash = '#/list?parentId=x';
  await h.start();
  await h.settle(300);
  const marked = () => [...grid.querySelectorAll('.card')].map(c => `${c.getAttribute('data-id').slice(-1)}:${c.classList.contains('je-list-incomplete') ? c.querySelector('.je-list-grid-count')?.textContent : '-'}`);
  assert.deepEqual(marked(), ['0:4', '1:-', '2:2']);
  // Sort / filter / next page: jellyfin-web replaces the container's cards with new ones.
  grid.querySelector('.itemsContainer').innerHTML = [ids[4], ids[0], ids[3]].map(cardHtml).join('');
  await h.settle(300);
  assert.deepEqual(marked(), ['4:1', '0:4', '3:-']);
  // The same card element re-used for another list (its data-id and contents change in place).
  const first = grid.querySelector('.card');
  first.setAttribute('data-id', ids[1]);
  first.querySelector('.cardImageContainer').innerHTML = '<div class="cardIndicators"><div class="playedIndicator indicator"></div></div>';
  await h.settle(300);
  assert.deepEqual(marked(), ['1:-', '0:4', '3:-'], 'the re-used card follows its new list');
  assert.equal(first.querySelector('.je-list-grid-indicator'), null);
  first.setAttribute('data-id', ids[2]);
  await h.settle(300);
  assert.deepEqual(marked(), ['2:2', '0:4', '3:-']);
  // jellyfin-web's user-data update rebuilds a card's indicators (played check back): the mark comes back with them.
  const second = grid.querySelectorAll('.card')[1];
  second.querySelector('.cardImageContainer').innerHTML = '<div class="cardIndicators"><div class="playedIndicator indicator"></div></div>';
  await h.settle(300);
  assert.ok(second.classList.contains('je-list-incomplete'));
  assert.equal(second.querySelector('.je-list-grid-count')?.textContent, '4');
  // A card re-used for something with the empty id is no list: never asked about (the server refuses a batch with it).
  first.setAttribute('data-id', '0'.repeat(32));
  await h.settle(300);
  assert.equal(first.classList.contains('je-list-incomplete'), false);
  assert.ok(!asked.includes('0'.repeat(32)), 'the empty id was sent');
});

test('r1 B3: an entry swapped into the playlist refreshes Jellyfin\'s rows first, then the entries are placed around the new row', async t => {
  const [a, b] = [ITEM(0xa1), ITEM(0xb2)];
  let reads = 0;
  const h = setup(t, {
    views: () => {
      reads += 1;
      return reads === 1
        ? [view([ph(P(1)), ph(P(2)), ph(P(3))], ['p:' + P(1), `e:${a}:0`, 'p:' + P(2), 'p:' + P(3)])]
        // P(2) became the library item b, in its place.
        : [view([ph(P(1)), ph(P(3))], ['p:' + P(1), `e:${a}:0`, `e:${b}:0`, 'p:' + P(3)], { rev: 2 })];
    },
    items: { [LIST]: PLAYLIST_ITEM }
  });
  await h.start();
  const { page, container } = h.playlistPage([a]);
  const refreshes = [];
  const realRow = id => `<div class="listItem" data-id="${id}" data-playlistitemid="${id}"></div>`;
  container.notifyRefreshNeeded = () => {
    refreshes.push(h.order(container).join(','));
    setTimeout(() => { container.innerHTML = realRow(a) + realRow(b); container.afterRefresh(); }, 30);
  };
  await h.show(page);
  assert.deepEqual(h.order(container), ['p:01', 'e:a1', 'p:02', 'p:03']);
  assert.equal(refreshes.length, 0, 'the first view refreshes nothing');
  h.JE.internals.arrListPages.pages.onLibraryChanged({ ItemsUpdated: [LIST] });
  await sleep(1150);
  await h.settle(120);
  assert.equal(refreshes.length, 1, 'Jellyfin\'s rows were refreshed once');
  assert.deepEqual(h.order(container), ['p:01', 'e:a1', 'e:b2', 'p:03']);
});

test('r1 B4: a library match reads "In your library" when nothing is being added, "adding it" only while swap-in runs', async t => {
  const match = ITEM(0x77);
  const entries = [ph(P(1), { inLibraryItemId: match, actions: ['request'] })];
  const rowOf = async extra => {
    const h = setup(t, { views: () => [view(entries, [entries[0].token], { actions: ['request'], ...extra })], items: { [LIST]: PLAYLIST_ITEM } });
    await h.start();
    const { page, container } = h.playlistPage([]);
    await h.show(page);
    return container.querySelector('.je-list-row');
  };
  const imported = await rowOf({ swapIn: false });
  assert.ok(imported.textContent.includes(en.arr_lists_in_library), imported.textContent);
  assert.ok(!imported.textContent.includes(en.arr_lists_adding));
  assert.equal(imported.querySelector('a').getAttribute('href'), `#/details?id=${match}`);
  assert.equal(imported.querySelector('.je-list-request'), null, 'nothing to request: it is in the library');
  const reconciling = await rowOf({ swapIn: true, reconciling: true });
  assert.ok(!reconciling.textContent.includes(en.arr_lists_adding), 'nothing is inserted while the list reconciles');
  const swapping = await rowOf({ swapIn: true });
  assert.ok(swapping.textContent.includes(en.arr_lists_adding));
});

test('r1: a list whose real items are all played but has entries missing does not show the header as played', async t => {
  const button = '<div class="mainDetailButtons"><button is="emby-playstatebutton" type="button" class="button-flat btnPlaystate detailButton emby-button playstatebutton-played" title="Watched" data-played="true"><div class="detailButton-content"><span class="material-icons detailButton-icon check playstatebutton-icon-played" aria-hidden="true"></span></div></button></div>';
  let entries = [ph(P(1)), ph(P(2))];
  const h = setup(t, { views: () => [view(entries, entries.map(e => e.token), { rev: entries.length ? 1 : 2 })], items: { [LIST]: PLAYLIST_ITEM } });
  await h.start();
  const { page } = h.playlistPage([]);
  page.insertAdjacentHTML('afterbegin', button);
  const btn = page.querySelector('.btnPlaystate');
  await h.show(page);
  const label = tnEn('arr_lists_header_incomplete', 2);
  assert.ok(page.classList.contains('je-list-incomplete-page'));
  assert.equal(btn.title, label);
  assert.ok(btn.classList.contains('playstatebutton-played'), 'Jellyfin\'s own state is left alone');
  assert.equal(h.calls.filter(c => /PlayedItems|UserData/i.test(c.path)).length, 0, 'played state never written');
  assert.ok(h.document.getElementById('je-arr-list-pages-styles').textContent.includes('.je-list-incomplete-page .btnPlaystate .playstatebutton-icon-played'));
  // jellyfin-web sets its state again (user data changed): still not shown as played.
  btn.title = 'Watched';
  await h.settle();
  assert.equal(btn.title, label);
  // The person marks it unplayed: Jellyfin's words stay.
  btn.classList.remove('playstatebutton-played');
  btn.title = 'Mark played';
  await h.settle();
  assert.equal(btn.title, 'Mark played');
  btn.classList.add('playstatebutton-played');
  btn.title = 'Watched';
  await h.settle();
  assert.equal(btn.title, label);
  // No entries left: Jellyfin's header is back as it was.
  entries = [];
  await h.show(page);
  assert.ok(!page.classList.contains('je-list-incomplete-page'));
  assert.equal(btn.title, 'Watched');
});

/** en.json's "one|many" string for a count, the way list-render's tn reads it. */
function tnEn(key, count) {
  const forms = translate(key, { count }).split('|');
  return (count === 1 ? forms[0] : forms[forms.length - 1]).trim();
}

// ------------------------------------------------------------------ review round 2: the paint gate

const HEADER_BUTTON = '<div class="mainDetailButtons"><button is="emby-playstatebutton" type="button" class="button-flat btnPlaystate detailButton emby-button playstatebutton-played" title="Watched" data-played="true"><div class="detailButton-content"><span class="material-icons detailButton-icon check playstatebutton-icon-played" aria-hidden="true"></span></div></button></div>';
const realRow = id => `<div class="listItem" data-id="${id}" data-playlistitemid="${id}"></div>`;

test('r2 gate: paint() runs only for a current ticket with a resolved Spoiler policy, re-queues until it resolves, drops after revoke', async t => {
  const h = setup(t, { views: () => [view([], [])] });
  const gate = h.JE.internals.arrListPages.gate;
  const policy = deferred();
  let live = true;
  const ticket = gate.issue(LIST, () => live, () => policy.promise);
  const ran = [];
  assert.equal(gate.paint(ticket, () => ran.push('a'), 'k'), false, 'no policy yet');
  assert.equal(gate.paint(ticket, () => ran.push('b'), 'k'), false);
  assert.deepEqual(ran, []);
  policy.resolve(gate.policy(() => false, false));
  await h.settle();
  assert.deepEqual(ran, ['b'], 'the queued paint ran once, the newest of its key');
  assert.equal(gate.paint(ticket, () => ran.push('c')), true);
  live = false;
  assert.equal(gate.paint(ticket, () => ran.push('d')), false, 'scope gone');
  live = true;
  ticket.revoke();
  assert.equal(gate.paint(ticket, () => ran.push('e')), false, 'revoked');
  assert.equal(ticket.current(), false);
  // A ticket revoked while its policy loads never paints what was queued.
  const slow = deferred();
  const other = gate.issue(LIST, () => true, () => slow.promise);
  gate.paint(other, () => ran.push('f'), 'k');
  other.revoke();
  slow.resolve(gate.policy(() => false, false));
  await h.settle();
  // A transport ticket (no policy) never paints; nor does a missing one.
  assert.equal(gate.paint(h.JE.arrLists.ticket(LIST), () => ran.push('g')), false);
  assert.equal(gate.paint(null, () => ran.push('h')), false);
  assert.deepEqual(ran, ['b', 'c']);
  // A policy that fails to load is a resolved one that guards everything (dates too).
  const failing = gate.issue(LIST, () => true, () => Promise.reject(new Error('x')));
  await h.settle();
  assert.equal(failing.policy.resolved, true);
  assert.equal(failing.policy({ kind: 'movie', tmdbId: 1 }), true);
  assert.equal(failing.policy.airDates, true);
});

test('r2 gate: a dropped paint is held at most once per key, runs once when the policy resolves, and can never re-queue itself', async t => {
  const h = setup(t, { views: () => [view([], [])] });
  const gate = h.JE.internals.arrListPages.gate;
  // A loader that "resolves" to a policy that isn't resolved (the fail-closed one): taken as guard-everything, resolved.
  const odd = deferred();
  const ticket = gate.issue(LIST, () => true, () => odd.promise);
  let runs = 0;
  // A paint that paints again from inside itself: held once before the policy, then it runs and its inner paint runs at
  // once (a resolved ticket never holds anything), so it can't loop through the queue.
  const again = () => { runs += 1; if (runs < 3) gate.paint(ticket, again, 'k'); };
  for (let i = 0; i < 50; i++) gate.paint(ticket, again, 'k');
  // More keys than the queue keeps: the extra ones are dropped, not kept.
  const keyed = [];
  for (let i = 0; i < 40; i++) gate.paint(ticket, () => keyed.push(i), 'key' + i);
  odd.resolve(gate.FAIL_CLOSED);
  await h.settle();
  assert.equal(ticket.policy.resolved, true);
  assert.equal(ticket.policy({ kind: 'movie' }), true);
  assert.equal(ticket.policy.airDates, true);
  assert.equal(runs, 3, 'the held paint ran once, its own re-paints ran directly');
  assert.ok(keyed.length > 0 && keyed.length <= 16, `held keys: ${keyed.length}`);
  await h.settle();
  assert.equal(runs, 3, 'nothing more later');
  // A ticket that goes stale while held: its held paints never run, and later paints are dropped (not held).
  const slow = deferred();
  let scopeOk = true;
  const stale = gate.issue(LIST, () => scopeOk, () => slow.promise);
  let staleRuns = 0;
  gate.paint(stale, () => { staleRuns += 1; }, 'k');
  scopeOk = false;
  slow.resolve(gate.policy(() => false, false));
  await h.settle();
  scopeOk = true;
  assert.equal(staleRuns, 0, 'held for a ticket that was not current when its policy came');
  // Writes inside paint/erase are scoped; nothing is left scoped after a throw.
  assert.throws(() => gate.paint(gate.issue(LIST, () => true, gate.policy(() => false, false)), () => { throw new Error('boom'); }));
  assert.equal(gate.scope(), '');
});

test('r2 policy: the policy before it is resolved fails closed (no air dates, no episode titles, no notes)', async t => {
  const h = setup(t, { views: () => [view([], [])] });
  const lp = h.JE.internals.arrListPages;
  const closed = lp.gate.FAIL_CLOSED;
  assert.equal(closed.resolved, false);
  const entry = ph(P(1), { kind: 'episodes', mediaType: 'tv', tmdbId: 5, seasonNumber: 2, episodes: [{ s: 2, e: 4, title: 'The Twist' }], releaseDate: '2099-01-02', released: false, note: 'dies' });
  const ctx = { guarded: closed };
  assert.equal(lp.render.subtitle(entry, ctx), 'S02E04');
  assert.equal(lp.render.dateLabel(ph(P(2), { releaseDate: '2099-01-02', released: false }), ctx), '');
  assert.equal(lp.render.signature(entry, ctx).includes('|g|d|'), true);
});

test('r2 S1: nothing is painted before the Spoiler policy is resolved, a change notification included; then the newest view is painted with it', async t => {
  const loaded = deferred();
  const sg = { whenLoaded: () => loaded.promise, isLoadOk: () => true, isTmdbEnabled: (media, id) => media === 'tv' && Number(id) === 77, isCollectionEnabledFor: () => false, guardedIds: () => ({ series: [], movies: [] }), getUserPrefs: () => ({}) };
  const guardedEp = ph(P(1), { kind: 'episodes', mediaType: 'tv', tmdbId: 77, titleKey: 'tv:tvdb:7', seasonNumber: 3, episodes: [{ s: 3, e: 1, title: 'The Reveal' }], releaseDate: '2099-01-02', released: false, note: 'She was the killer' });
  const open = ph(P(2), { title: 'Open movie', releaseDate: '2099-03-04', released: false });
  const h = setup(t, { config: { SpoilerBlurEnabled: true }, spoiler: sg, views: () => [view([guardedEp], [guardedEp.token])], items: { [LIST]: PLAYLIST_ITEM } });
  await h.start();
  const { page, container } = h.playlistPage([]);
  page.insertAdjacentHTML('afterbegin', HEADER_BUTTON);
  await h.show(page);
  assert.equal(container.querySelectorAll('.je-list-row').length, 0, 'the read answered, the policy did not: nothing');
  // A change of this list, from this session, while Spoiler Guard is still loading.
  h.JE.internals.arrListPages.pages.onListChange(LIST, view([guardedEp, open], [guardedEp.token, open.token], { rev: 2 }), { epoch: 1 });
  await h.settle();
  assert.equal(container.querySelectorAll('.je-list-row').length, 0, 'the change is not painted either');
  assert.ok(!container.textContent.includes('2099') && !container.textContent.includes('Coming'));
  assert.equal(page.classList.contains('je-list-incomplete-page'), false, 'nor the header');
  loaded.resolve();
  await h.settle();
  const rows = [...container.querySelectorAll('.je-list-row')];
  assert.equal(rows.length, 2, 'the newest view, once the policy is known');
  const text = rows[0].textContent + ' | ' + rows[0].querySelector('.je-list-row-main').getAttribute('aria-label');
  assert.ok(!/Reveal|killer|2099|Coming/.test(text), text);
  assert.match(rows[1].textContent, /Coming/, 'an unguarded entry keeps its date');
  assert.ok(page.classList.contains('je-list-incomplete-page'));
});

test('r2 S2/B5 notification: a change for list A after A\'s page was re-used for B (B\'s lookup pending) paints nothing; A\'s rows go at once', async t => {
  const lookupB = deferred();
  const h = setup(t, {
    views: id => [id === LIST ? view([ph(P(1))], ['p:' + P(1)]) : view([ph(P(2))], ['p:' + P(2)], { listId: LIST_B })],
    items: { [LIST]: PLAYLIST_ITEM, [LIST_B]: lookupB.promise }
  });
  await h.start();
  const { page, container } = h.playlistPage([]);
  page.insertAdjacentHTML('afterbegin', HEADER_BUTTON);
  await h.show(page, '#/details?id=' + LIST);
  assert.deepEqual(h.order(container), ['p:01']);
  await h.show(page, '#/details?id=' + LIST_B);
  assert.deepEqual(h.order(container), [], 'A\'s rows go as soon as the page shows another list');
  assert.equal(page.querySelector('.btnPlaystate').title, 'Watched', 'and A\'s header mark');
  h.JE.internals.arrListPages.pages.onListChange(LIST, view([ph(P(1)), ph(P(8), { title: 'Only on A' })], ['p:' + P(1), 'p:' + P(8)], { rev: 7 }), { epoch: 1 });
  await h.settle();
  assert.deepEqual(h.order(container), []);
  assert.ok(!container.textContent.includes('Only on A'));
  lookupB.resolve({ Id: LIST_B, Type: 'Playlist' });
  await h.settle(60);
  assert.deepEqual(h.order(container), ['p:02']);
});

test('r2 response: A\'s read answering after A\'s page was re-used for B paints nothing', async t => {
  const readA = deferred();
  const lookupB = deferred();
  const h = setup(t, {
    views: id => (id === LIST ? readA.promise : [view([ph(P(2))], ['p:' + P(2)], { listId: LIST_B })]),
    items: { [LIST]: PLAYLIST_ITEM, [LIST_B]: lookupB.promise }
  });
  await h.start();
  const { page, container } = h.playlistPage([]);
  await h.show(page, '#/details?id=' + LIST);
  await h.show(page, '#/details?id=' + LIST_B);
  readA.resolve([view([ph(P(1))], ['p:' + P(1)])]);
  await h.settle(60);
  assert.deepEqual(h.order(container), []);
  lookupB.resolve({ Id: LIST_B, Type: 'Playlist' });
  await h.settle(60);
  assert.deepEqual(h.order(container), ['p:02']);
});

test('r2 S3 slice: collection cards still to come are dropped when the page is left between two slices', async t => {
  const entries = Array.from({ length: 50 }, (_, i) => ph('d' + String(i).padStart(31, '0'), { title: `C${i}` }));
  const coll = { listId: COLL, listKind: 'collection', rev: 1, canEdit: false, actions: [], statusShown: false, placeholders: entries, order: null };
  const h = setup(t, { views: () => [coll], items: { [COLL]: { Id: COLL, Type: 'BoxSet' } } });
  const page = h.collectionPage();
  const other = h.document.createElement('div');
  other.className = 'page itemDetailPage hide';
  h.document.body.appendChild(other);
  await h.start();
  const lp = h.JE.internals.arrListPages;
  const original = lp.render.card;
  let built = 0;
  // Navigation right after the first slice, before the next one runs.
  lp.render.card = (...args) => {
    built += 1;
    if (built === 24) queueMicrotask(() => { page.classList.add('hide'); other.classList.remove('hide'); h.showNow(other, '#/details?id=' + 'e'.repeat(32)); });
    return original(...args);
  };
  h.showNow(page, '#/details?id=' + COLL);
  await h.settle(150);
  assert.equal(built, 24, 'no card built after the page was left');
  assert.equal(page.querySelectorAll('.je-list-card').length, 24);
});

test('r2 slice: a 699-row playlist still being built when its page is re-used for another list never lands there', async t => {
  const entries = Array.from({ length: 699 }, (_, i) => ph('e' + String(i).padStart(31, '0'), { title: `E${i}` }));
  const lookupB = deferred();
  const h = setup(t, { views: () => [view(entries, entries.map(e => e.token))], items: { [LIST]: PLAYLIST_ITEM, [LIST_B]: lookupB.promise } });
  await h.start();
  const { page, container } = h.playlistPage([]);
  const lp = h.JE.internals.arrListPages;
  const original = lp.render.row;
  let built = 0;
  lp.render.row = (...args) => {
    built += 1;
    if (built === 150) queueMicrotask(() => h.showNow(page, '#/details?id=' + LIST_B));
    return original(...args);
  };
  h.showNow(page, '#/details?id=' + LIST);
  await h.settle(200);
  assert.equal(container.querySelectorAll('.je-list-row').length, 0);
  assert.equal(built, 150);
});

test('r2 observer: Jellyfin re-rendering a page re-used for B never gets A\'s rows back, and a hidden page\'s header is not relabelled', async t => {
  const x = ITEM(0x99);
  const lookupB = deferred();
  const h = setup(t, { views: () => [view([ph(P(1))], ['p:' + P(1)])], items: { [LIST]: PLAYLIST_ITEM, [LIST_B]: lookupB.promise } });
  await h.start();
  const { page, container } = h.playlistPage([]);
  await h.show(page, '#/details?id=' + LIST);
  assert.deepEqual(h.order(container), ['p:01']);
  await h.show(page, '#/details?id=' + LIST_B);
  // jellyfin-web draws B's rows, bypassing afterRefresh.
  container.innerHTML = realRow(x);
  await h.settle(60);
  assert.equal(container.querySelectorAll('.je-list-row').length, 0);
  // The header: list A shown, then left (its page hidden); Jellyfin sets its button again while it is hidden.
  const second = setup(t, { views: () => [view([ph(P(1)), ph(P(2))], ['p:' + P(1), 'p:' + P(2)])], items: { [LIST]: PLAYLIST_ITEM } });
  await second.start();
  const a = second.playlistPage([]);
  a.page.insertAdjacentHTML('afterbegin', HEADER_BUTTON);
  const btn = a.page.querySelector('.btnPlaystate');
  await second.show(a.page, '#/details?id=' + LIST);
  assert.equal(btn.title, tnEn('arr_lists_header_incomplete', 2));
  const other = second.document.createElement('div');
  other.className = 'page itemDetailPage';
  second.document.body.appendChild(other);
  a.page.classList.add('hide');
  await second.show(other, '#/details?id=' + 'e'.repeat(32));
  btn.title = 'Watched';
  await second.settle();
  assert.equal(btn.title, 'Watched', 'no relabel on a page not shown');
  // Back: the mark comes back with the page.
  other.classList.add('hide');
  a.page.classList.remove('hide');
  await second.show(a.page, '#/details?id=' + LIST);
  assert.equal(btn.title, tnEn('arr_lists_header_incomplete', 2));
});

test('r2 timer: the wait for a not-yet-ready container never draws A after its page was re-used for B', async t => {
  const lookupB = deferred();
  const h = setup(t, { views: () => [view([ph(P(1))], ['p:' + P(1)])], items: { [LIST]: PLAYLIST_ITEM, [LIST_B]: lookupB.promise } });
  await h.start();
  const { page, container } = h.playlistPage([], { ready: false });
  await h.show(page, '#/details?id=' + LIST);
  assert.equal(container.querySelectorAll('.je-list-row').length, 0, 'waiting for the container');
  await h.show(page, '#/details?id=' + LIST_B);
  container.fetchData = () => Promise.resolve();
  await sleep(320);
  assert.equal(container.querySelectorAll('.je-list-row').length, 0);
});

test('r2 B6: while Jellyfin refreshes its rows (slower than the 1 s re-read) later views wait; the entries move once its rows are in', async t => {
  const [a, b] = [ITEM(0xa1), ITEM(0xb2)];
  const v1 = view([ph(P(1)), ph(P(2)), ph(P(3))], ['p:' + P(1), `e:${a}:0`, 'p:' + P(2), 'p:' + P(3)]);
  const v2 = view([ph(P(1)), ph(P(3))], ['p:' + P(1), `e:${a}:0`, `e:${b}:0`, 'p:' + P(3)], { rev: 2 });
  let reads = 0;
  const h = setup(t, { views: () => { reads += 1; return [reads === 1 ? v1 : v2]; }, items: { [LIST]: PLAYLIST_ITEM } });
  await h.start();
  const { page, container } = h.playlistPage([a]);
  let refreshes = 0;
  container.notifyRefreshNeeded = () => {
    refreshes += 1;
    setTimeout(() => { container.innerHTML = realRow(a) + realRow(b); container.afterRefresh(); }, 1600);
  };
  await h.show(page);
  assert.deepEqual(h.order(container), ['p:01', 'e:a1', 'p:02', 'p:03']);
  // P(2) swapped in as b: the change's view, then its re-read 1 s later (same members).
  h.JE.internals.arrListPages.pages.onListChange(LIST, v2, { epoch: 1 });
  assert.equal(refreshes, 1);
  await sleep(1300);
  assert.equal(reads, 2, 'the re-read came back while Jellyfin was still refreshing');
  assert.deepEqual(h.order(container), ['p:01', 'e:a1', 'p:02', 'p:03'], 'nothing moves before Jellyfin\'s rows are in');
  await sleep(500);
  await h.settle();
  assert.deepEqual(h.order(container), ['p:01', 'e:a1', 'e:b2', 'p:03']);
  assert.equal(refreshes, 1);
});

test('r2 B7: the header keeps Jellyfin\'s own title across JE count changes (2, 1, then none)', async t => {
  let entries = [ph(P(1)), ph(P(2))];
  let rev = 0;
  const h = setup(t, { views: () => [view(entries, entries.map(e => e.token), { rev: ++rev })], items: { [LIST]: PLAYLIST_ITEM } });
  await h.start();
  const { page } = h.playlistPage([]);
  page.insertAdjacentHTML('afterbegin', HEADER_BUTTON);
  const btn = page.querySelector('.btnPlaystate');
  await h.show(page);
  assert.equal(btn.title, tnEn('arr_lists_header_incomplete', 2));
  entries = [ph(P(1))];
  await h.show(page);
  assert.equal(btn.title, tnEn('arr_lists_header_incomplete', 1));
  entries = [];
  await h.show(page);
  assert.equal(btn.title, 'Watched', 'Jellyfin\'s own title is back');
  assert.ok(!page.classList.contains('je-list-incomplete-page'));
});

test('r2 spy: a list module writing to the DOM outside paint() is caught (planted), and the spy sees the real writes', async t => {
  // The real modules: many list writes, none outside the gate.
  const entries = Array.from({ length: 30 }, (_, i) => ph('d' + String(i).padStart(31, '0')));
  const coll = { listId: COLL, listKind: 'collection', rev: 1, canEdit: false, actions: [], statusShown: false, placeholders: entries, order: null };
  const clean = setup(t, { views: () => [coll], items: { [COLL]: { Id: COLL, Type: 'BoxSet' } } });
  const cleanPage = clean.collectionPage();
  await clean.start();
  await clean.show(cleanPage, '#/details?id=' + COLL);
  assert.equal(cleanPage.querySelectorAll('.je-list-card').length, 30);
  assert.ok(clean.spy.writes() > 100, `writes seen: ${clean.spy.writes()}`);
  assert.deepEqual(clean.spy.violations, []);
  // Planted: the collection's next slice scheduled outside the gate (the r2 S3 bug).
  const marker = 'setTimeout(() => lp.gate.paint(t, step, \'slice\'), 0)';
  const planted = setup(t, {
    views: () => [coll],
    items: { [COLL]: { Id: COLL, Type: 'BoxSet' } },
    plant: { 'arr/lists/list-collection.js': src => { assert.ok(src.includes(marker), 'the slice scheduling is where the plant expects it'); return src.replace(marker, 'setTimeout(step, 0)'); } }
  });
  const page = planted.collectionPage();
  await planted.start();
  await planted.show(page, '#/details?id=' + COLL);
  assert.equal(page.querySelectorAll('.je-list-card').length, 30);
  const caught = planted.spy.take();
  assert.ok(caught.length > 0, 'the planted write was caught');
  assert.ok(caught.every(v => /list-(collection|render)\.js/.test(v.frame)), JSON.stringify(caught.slice(0, 3)));
  // Planted: a removal path that puts something in (erase() only takes away).
  const eraseMarker = 'ctrl.section?.remove();';
  const inserting = setup(t, {
    views: () => [coll],
    items: { [COLL]: { Id: COLL, Type: 'BoxSet' } },
    plant: { 'arr/lists/list-collection.js': src => { assert.ok(src.includes(eraseMarker)); return src.replace(eraseMarker, eraseMarker + ' page.appendChild(document.createElement(\'i\'));'); } }
  });
  const third = inserting.collectionPage();
  await inserting.start();
  await inserting.show(third, '#/details?id=' + COLL);
  inserting.JE.currentSettings.listCollectionUi = false;
  inserting.JE.arrListPages.settingsChanged();
  const inserted = inserting.spy.take();
  assert.ok(inserted.some(v => v.scope === 'erase' && v.op === 'appendChild'), JSON.stringify(inserted));
});


for (const loader of ['me', 'quota', 'check']) test(`r3 B1: revoke while sheet ${loader} loads cancels the pending open`, async t => {
  const held = deferred();
  let loading = false;
  const entry = ph(P(1), { actions: ['request'] });
  const h = setup(t, {
    views: () => [view([entry], [entry.token], { actions: ['request'] })], items: { [LIST]: PLAYLIST_ITEM },
    preview: () => [{ items: [{ placeholderId: entry.id, outcome: 'request', cost: 1 }] }],
    route: async (_, path) => {
      if (!path.startsWith('/acquire/requests/' + loader)) return null;
      loading = true;
      await held.promise;
      return null;
    }
  });
  await h.start();
  const { page, container } = h.playlistPage();
  await h.show(page);
  const pending = h.JE.internals.arrListPages.request.open({ listId: LIST, ticket: () => [...h.JE.internals.arrListPages.pages.controllers].find(c => c.page === page).ticket }, entry, container.querySelector('.je-list-request'));
  await h.settle();
  assert.equal(loading, true);
  h.showNow(page, '#/home');
  await h.settle();
  const cancelled = await Promise.race([pending.then(() => true), sleep(150).then(() => false)]);
  held.resolve();
  await h.settle();
  assert.equal(h.document.querySelector('.je-sheet-backdrop'), null, 'no sheet over the destination page');
  assert.equal(cancelled, true, 'the pending open ends without waiting for its loader');
});

test('r3 B1: revoke closes an active sheet and a late send paints nothing', async t => {
  const held = deferred();
  const entry = ph(P(1), { actions: ['request'] });
  const h = setup(t, {
    views: () => [view([entry], [entry.token], { actions: ['request'] })], items: { [LIST]: PLAYLIST_ITEM },
    preview: () => [{ items: [{ placeholderId: entry.id, outcome: 'request', cost: 1 }] }],
    submit: async () => { await held.promise; return [{ results: [{ placeholderId: entry.id, result: { outcome: 'accepted', reason: 'looking', certainty: 'Succeeded' } }] }]; }
  });
  await h.start();
  const { page, container } = h.playlistPage();
  await h.show(page);
  container.querySelector('.je-list-request').click();
  await h.settle();
  assert.ok(h.document.querySelector('.je-sheet-primary'));
  h.document.querySelector('.je-sheet-primary').click();
  await h.settle();
  h.showNow(page, '#/home');
  await h.settle();
  assert.equal(h.document.querySelector('.je-sheet-backdrop'), null);
  const before = h.toasts.length;
  held.resolve();
  await h.settle();
  assert.equal(h.toasts.length, before);
});

for (const midflight of [false, true]) test(`r3 B2: visible grid invalidation refreshes (in flight: ${midflight})`, async t => {
  const held = deferred();
  let count = 0;
  const h = setup(t, { summaries: async () => {
    count++;
    if (midflight && count === 1) await held.promise;
    return [{ lists: [{ listId: LIST, missing: count === 1 ? 3 : 1 }], pending: [] }];
  }});
  h.document.body.innerHTML = `<div class="card" data-id="${LIST}" data-type="Playlist"><div class="cardImageContainer"></div></div>`;
  await h.start();
  await sleep(200);
  const grid = h.JE.internals.arrListPages.grid;
  grid.invalidate(LIST);
  if (midflight) held.resolve();
  await sleep(400);
  assert.equal(count, 2, 'one new batch after invalidation');
  assert.equal(h.document.querySelector('.je-list-grid-count')?.textContent, '1');
  await sleep(200);
  assert.equal(count, 2, 'no observer retry storm');
});

test('r3 grid: a revoked batch never repaints or queues its dirty cards in the next session', async t => {
  const held = deferred();
  let count = 0;
  const h = setup(t, { summaries: async () => { count++; await held.promise; return [{ lists: [{ listId: LIST, missing: 9 }] }]; } });
  h.document.body.innerHTML = `<div class="card" data-id="${LIST}" data-type="Playlist"><div class="cardImageContainer"></div></div>`;
  await h.start();
  await sleep(200);
  const grid = h.JE.internals.arrListPages.grid;
  grid.invalidate(LIST);
  h.JE.currentSettings.listPlaylistUi = false;
  h.JE.arrListPages.settingsChanged();
  held.resolve();
  await sleep(350);
  assert.equal(h.document.querySelector('.je-list-grid-indicator'), null);
  assert.equal(count, 1);
});

test('r3 Q13: an unanswered Spoiler policy paints fully guarded after eight seconds and ignores a late answer', { timeout: 11000 }, async t => {
  const held = deferred();
  const entry = ph(P(1), { kind: 'episodes', mediaType: 'tv', seasonNumber: 2, episodes: [{ s: 2, e: 1, title: 'SECRET EPISODE', airDate: '2001-05-01' }], note: 'SECRET NOTE' });
  const movie = ph(P(2), { kind: 'movie', releaseDate: '1999-05-01', year: 1999, released: true });
  const h = setup(t, { config: { SpoilerBlurEnabled: true }, spoiler: { whenLoaded: () => held.promise, isLoadOk: () => true, isTmdbEnabled: () => false, guardedIds: () => ({ series: [], movies: [] }), getUserPrefs: () => ({}) }, views: () => [view([entry, movie], [entry.token, movie.token])], items: { [LIST]: PLAYLIST_ITEM } });
  await h.start();
  const { page, container } = h.playlistPage();
  await h.show(page);
  assert.equal(container.querySelectorAll('.je-list-row').length, 0);
  await sleep(8150);
  assert.equal(container.querySelectorAll('.je-list-row').length, 2);
  assert.doesNotMatch(container.textContent, /SECRET|2001|1999/);
  const lp = h.JE.internals.arrListPages;
  assert.notEqual(lp.render.signature(movie, { guarded: lp.gate.GUARD_ALL }), lp.render.signature(movie, { guarded: lp.gate.policy(() => true, true) }), 'a later visit with known policy rebuilds the year');
  held.resolve();
  await h.settle();
  assert.doesNotMatch(container.textContent, /SECRET|2001|1999/);
});


test('r3 S2: the spy sees delayed list-sheet writes with no list stack frame (planted)', async t => {
  const h = setup(t, { views: () => [view([], [])], plant: {
    'arr/ask/ask-sheet.js': src => src.replace('document.body.appendChild(backdrop);', "document.body.appendChild(backdrop); setTimeout(() => { backdrop.dataset.unguardedSheetWrite = 'x'; }, 0);")
  } });
  const gate = h.JE.internals.arrListPages.gate;
  const ticket = gate.issue(LIST, () => true, gate.policy(() => false, false));
  const opening = h.JE.arrAskSheet.open({ key: 'movie:tmdb:100', kind: 'movie', name: 'Probe' }, { listTicket: ticket, fixed: { scope: 'Movie', input: {}, send: async () => null } });
  await h.settle();
  const writes = h.spy.take();
  assert.ok(writes.some(w => /ask-sheet\.js/.test(w.frame) && w.scope === 'none'), JSON.stringify(writes.slice(0, 2)));
  h.JE.arrAskSheet.close();
  await opening;
  h.spy.take();
});


// Review round 4: a denied refresh revokes the sheet's ticket without leaving the page.
for (const collection of [false, true]) for (const status of [403, 404]) for (const active of [false, true]) {
  test(`r4 S1: ${collection ? 'collection' : 'playlist'} refresh ${status} cancels ${active ? 'active' : 'pending'} Request and recovers only on success`, async t => {
    const held = deferred();
    t.after(() => held.resolve());
    let response = 200;
    let loading = false;
    const id = collection ? COLL : LIST;
    const entry = ph(P(1), { actions: ['request'] });
    const body = view([entry], [entry.token], { listId: id, listKind: collection ? 'collection' : 'playlist', actions: ['request'] });
    const h = setup(t, {
      views: () => [response === 200 ? body : null, response],
      items: { [id]: { Id: id, Type: collection ? 'BoxSet' : 'Playlist' } },
      preview: () => [{ items: [{ placeholderId: entry.id, outcome: 'request', cost: 1 }] }],
      route: async (_, path) => {
        if (active || !path.startsWith('/acquire/requests/quota')) return null;
        loading = true;
        await held.promise;
        return null;
      }
    });
    await h.start();
    const page = collection ? h.collectionPage() : h.playlistPage().page;
    await h.show(page, '#/details?id=' + id);
    const lp = h.JE.internals.arrListPages;
    const ctrl = [...lp.pages.controllers].find(c => c.page === page);
    const ticket = ctrl.ticket;
    let ended = false;
    const pending = lp.request.open({ listId: id, ticket: () => ctrl.ticket }, entry, page.querySelector('.je-list-request')).then(() => { ended = true; });
    await h.settle();
    if (active) assert.ok(h.document.querySelector('.je-sheet-backdrop'));
    else assert.equal(loading, true, 'the real quota loader is held');
    response = status;
    await ctrl.load(); // Same page show and route: no navigation to revoke it for us.
    await h.settle();
    const cancelledBeforeRelease = ended;
    held.resolve();
    await Promise.race([pending, sleep(150)]);
    await h.settle();
    assert.equal(h.document.querySelector('.je-sheet-backdrop'), null, 'no sheet after the denied refresh or late loader');
    assert.equal(ticket.current(), false, 'the originating ticket is revoked');
    if (!active) assert.equal(cancelledBeforeRelease, true, 'pending open settles before its loader');
    assert.equal(page.querySelectorAll('.je-list-row, .je-list-card').length, 0);
    response = 503;
    await ctrl.load();
    assert.ok(!ctrl.ticket?.current(), 'an outage cannot issue a replacement ticket');
    response = 200;
    await ctrl.load();
    await h.settle();
    assert.ok(ctrl.ticket.current(), 'access restored without navigating');
    assert.notEqual(ctrl.ticket, ticket);
    assert.equal(ticket.current(), false, 'the old sheet can never acquire the new ticket');
    assert.equal(page.querySelectorAll('.je-list-row, .je-list-card').length, 1);
  });
}
