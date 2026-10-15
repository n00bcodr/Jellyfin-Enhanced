// Requests & downloads, phase 3: the Discover tab of the Requests page and the "Not in your library"
// row on the search page (JE request backend), rendered by the real modules from server answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createHarness, jsRoot, deferred, plain } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const MODULES = [
  'arr/status/status-core.js',
  'arr/hub/hub-styles.js', 'arr/hub/hub-render.js', 'arr/hub/hub-discover.js', 'arr/hub/hub-page.js',
  'arr/ask/ask-core.js', 'arr/ask/ask-search.js'
];
const USER = '0123456789abcdef0123456789abcdef';
const MEMBER = { role: 'member', canRequest: true, canApprove: false, asksFirst: false, backend: 'je', contact: 'Dad' };
const KID = { role: 'kid', canRequest: true, canApprove: false, asksFirst: true, backend: 'je', contact: 'Dad' };

function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

const card = (key, title, extra = {}) => ({
  key, kind: key.startsWith('tv:') ? 'tv' : 'movie', tmdbId: Number(key.split(':').pop()), title, year: 2024, poster: '/p.jpg',
  overview: 'Text', inLibrary: false, itemId: null, requested: false, mine: null, ...extra
});
const page = (results, extra = {}) => ({ outcome: 'accepted', reason: 'discover', certainty: 'Succeeded', message: 'Discover', answer: { list: 'x', type: 'movie', page: 1, totalPages: 1, results, ...extra } });
const DEFAULT_ROWS = {
  'trending:movie': page([
    card('movie:tmdb:1', 'In my library', { inLibrary: true, itemId: 'aa11' }),
    card('movie:tmdb:2', 'Asked one', { requested: true, mine: 'asked' }),
    card('movie:tmdb:3', 'Waiting one', { requested: true, mine: 'waiting' }),
    card('movie:tmdb:4', 'Someone asked', { requested: true }),
    card('movie:tmdb:5', '<img src=x onerror=alert(1)>')
  ]),
  'upcoming:movie': page([]),
  'popular:tv': page([card('tv:tmdb:20', 'A show')]),
  'because:movie': page([], { groups: [{ basedOn: 'Arrival', key: 'movie:tmdb:9', results: [card('movie:tmdb:10', 'Sicario')] }, { basedOn: 'Empty', key: 'movie:tmdb:8', results: [] }] })
};

/**
 * A harness with the hub, the Discover tab, the ask core and the search row.
 * routes(url, init) answers fetches (an object: JSON 200; {status, body}; a promise of either).
 */
function setup(t, { hash = '#/home', config = {}, me = MEMBER, routes = () => undefined, html = '', JE: extraJE = {}, modules = [] } = {}) {
  const fetches = [];
  const toasts = [];
  const navigation = [];
  const mutations = [];
  let epoch = 0;
  const userChange = [];
  const h = createHarness({
    html: `<div class="mainDrawer"><div class="jellyfinEnhancedSection"></div></div><div class="mainAnimatedPages"><div class="mainAnimatedPage" id="homePage"></div></div>${html}`,
    url: `http://jellyfin.test/web/index.html${hash}`,
    apiClient: { getCurrentUserId: () => USER },
    fetch: async (url, init = {}) => {
      const u = new URL(String(url));
      const entry = { path: u.pathname.replace('/JellyfinEnhanced', ''), params: u.searchParams, init, aborted: false };
      fetches.push(entry);
      init.signal?.addEventListener('abort', () => { entry.aborted = true; });
      let answer = routes(entry);
      if (answer === undefined && entry.path === '/acquire/requests/me') answer = me === null ? { status: 403, body: { outcome: 'denied', reason: 'feature_disabled' } } : { status: 200, body: { me } };
      if (answer === undefined && entry.path === '/acquire/discover') answer = DEFAULT_ROWS[`${u.searchParams.get('list')}:${u.searchParams.get('type')}`];
      answer = await answer;
      if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (answer === undefined) throw new Error(`no fixture for ${url}`);
      const shaped = answer && typeof answer.status === 'number' && 'body' in answer ? answer : { status: 200, body: answer };
      return new Response(JSON.stringify(shaped.body), { status: shaped.status, headers: { 'Content-Type': 'application/json' } });
    },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrRequestsHubEnabled: true, ArrRequestsEnabled: true, ...config },
      t: translate,
      toast: (html) => toasts.push(html),
      escapeHtml: s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`),
      helpers: { onSidebarRebuilt: () => {}, onBodyMutation: (id, fn) => { mutations.push(fn); return () => {}; } },
      core: {
        api: { plugin: async (path) => (path === '/acquire/hub' ? { mine: [], soon: [], ready: [] } : null) },
        navigation: { onNavigate: fn => { navigation.push(fn); return () => {}; }, onViewPage: () => () => {} },
        lifecycle: { register: () => ({ track: x => x }) }
      },
      arr: { live: { position: () => ({ epoch: 'e1', cursor: 1 }) }, onStatusChange: () => () => {} },
      session: { getEpoch: () => epoch, isCurrent: e => e === epoch, onUserChange: (name, fn) => userChange.push(fn) },
      ...extraJE
    }
  });
  t.after(() => h.close());
  for (const m of [...MODULES, ...modules]) h.load(m);
  return {
    ...h, fetches, toasts, navigation, mutations,
    switchUser() { epoch++; userChange.forEach(fn => fn()); },
    discoverReads: () => fetches.filter(f => f.path === '/acquire/discover'),
    searches: () => fetches.filter(f => f.path === '/acquire/search')
  };
}

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await wait(10);
}

const hubPage = h => h.document.getElementById('je-requests-hub-page');
const tabIds = h => [...hubPage(h).querySelectorAll('.je-hub-tab')].map(b => b.dataset.tab);
const cardOf = (root, key) => [...root.querySelectorAll('.je-discover-card')].find(c => c.dataset.key === key);

test('every key the Discover tab and the search row use exists in en.json', () => {
  const source = ['arr/hub/hub-discover.js', 'arr/ask/ask-search.js'].map(m => readFileSync(resolve(jsRoot, m), 'utf8')).join('\n');
  const keys = [...source.matchAll(/tr\('([a-z0-9_]+)'/g), ...source.matchAll(/'(arr_(?:discover|search)_[a-z0-9_]+)'/g)].map(m => m[1]);
  assert.ok(keys.length >= 15);
  for (const key of keys) assert.ok(key in en, key);
});

test('the Discover tab is offered in JE mode to people who may ask, and waits for that answer on a deep link', async t => {
  for (const [name, me, config, expected] of [
    ['member in JE mode', MEMBER, {}, true],
    ['Seerr mode', { ...MEMBER, backend: 'seerr' }, {}, false],
    ['watcher', { ...MEMBER, role: 'watcher', canRequest: false }, {}, false],
    ['request controls off', MEMBER, { ArrRequestsEnabled: false }, false]
  ]) {
    await t.test(name, async t2 => {
      const h = setup(t2, { hash: '#/requests', me, config });
      h.JE.initializeArrHub();
      await until(() => tabIds(h).length >= 3 && (!expected || tabIds(h).includes('discover')));
      await wait(30);
      assert.equal(tabIds(h).includes('discover'), expected, tabIds(h).join(','));
      if (expected) assert.deepEqual(tabIds(h), ['mine', 'soon', 'ready', 'discover']);
      if (config.ArrRequestsEnabled === false) assert.equal(h.fetches.length, 0);
      if (!expected) assert.equal(h.discoverReads().length, 0);
    });
  }

  // A deep link to the tab isn't sent back to My requests while the capabilities are on their way.
  const me = deferred();
  const h = setup(t, { hash: '#/requests?tab=discover', routes: f => (f.path === '/acquire/requests/me' ? me.promise : undefined) });
  h.JE.initializeArrHub();
  await wait(30);
  assert.equal(h.window.location.hash, '#/requests?tab=discover');
  assert.equal(h.discoverReads().length, 0);
  me.resolve({ status: 200, body: { me: MEMBER } });
  await until(() => h.discoverReads().length === 4);
  assert.equal(hubPage(h).querySelector('.je-hub-tab[aria-selected="true"]').dataset.tab, 'discover');
  assert.equal(hubPage(h).querySelector('.je-hub-tab[data-tab="discover"]').textContent, 'Discover');
});

test('rows render once each with state chips, titles as text and Because you watched groups', async t => {
  const h = setup(t, { hash: '#/requests?tab=discover' });
  h.JE.initializeArrHub();
  await until(() => hubPage(h).querySelectorAll('.je-discover-card').length >= 7);
  const reads = h.discoverReads().map(f => `${f.params.get('list')}:${f.params.get('type')}:${f.params.get('page')}`);
  assert.deepEqual(reads.sort(), ['because:movie:1', 'popular:tv:1', 'trending:movie:1', 'upcoming:movie:1']);
  const root = hubPage(h);
  const titles = [...root.querySelectorAll('.je-discover-row:not([hidden]) .je-discover-row-title')].map(e => e.textContent);
  assert.deepEqual(titles, ['Trending', 'Popular TV', 'Because you watched Arrival']);   // empty rows and groups are left out
  const chip = key => cardOf(root, key).querySelector('.je-discover-chip')?.textContent ?? null;
  assert.equal(chip('movie:tmdb:1'), 'check_circleIn your library');
  assert.equal(chip('movie:tmdb:2'), 'sendAsked!');
  assert.equal(chip('movie:tmdb:3'), 'hourglass_emptyWaiting for OK');
  assert.equal(chip('movie:tmdb:4'), 'groupSomeone asked');
  assert.equal(chip('movie:tmdb:5'), null);
  // Request only where the caller can still ask; titles are text, never HTML.
  assert.equal(cardOf(root, 'movie:tmdb:1').querySelector('.je-discover-request'), null);
  assert.equal(cardOf(root, 'movie:tmdb:2').querySelector('.je-discover-request'), null);
  assert.ok(cardOf(root, 'movie:tmdb:4').querySelector('.je-discover-request'));
  assert.equal(root.querySelectorAll('img[src="x"]').length, 0);
  assert.equal(cardOf(root, 'movie:tmdb:5').querySelector('bdi').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(cardOf(root, 'movie:tmdb:5').querySelector('img').getAttribute('src'), 'https://image.tmdb.org/t/p/w342/p.jpg');
  // The card body opens the Jellyfin item the caller has; without Seerr, other cards aren't links.
  const shown = [];
  h.window.Emby = { Page: { showItem: id => shown.push(id) } };
  cardOf(root, 'movie:tmdb:1').querySelector('button.je-discover-poster-box').click();
  assert.deepEqual(shown, ['aa11']);
  assert.equal(cardOf(root, 'movie:tmdb:4').querySelector('button.je-discover-poster-box'), null);
  // Re-rendering the page (a feed change) redraws from memory without reading again.
  h.JE.internals.arrHub.selectTab('discover');
  await wait(20);
  assert.equal(h.discoverReads().length, 4);
  assert.equal(hubPage(h).querySelectorAll('.je-discover-card').length, 7);
});

test('with Seerr set up, cards the caller does not have open its more-info window', async t => {
  const opened = [];
  const h = setup(t, { hash: '#/requests?tab=discover', config: { JellyseerrEnabled: true }, JE: { jellyseerrMoreInfo: { open: (id, type) => opened.push([id, type]) } } });
  h.JE.initializeArrHub();
  await until(() => hubPage(h).querySelectorAll('.je-discover-card').length >= 7);
  cardOf(hubPage(h), 'tv:tmdb:20').querySelector('button.je-discover-poster-box').click();
  assert.deepEqual(opened, [[20, 'tv']]);
});

test('with native details offered, a card the caller does not have opens the title\'s page (no Seerr needed)', async t => {
  const opened = [], native = [];
  const h = setup(t, { hash: '#/requests?tab=discover', config: { JellyseerrEnabled: false }, JE: { jellyseerrMoreInfo: { open: (id, type) => opened.push([id, type]) } } });
  h.JE.titleDetails = { available: () => true, open: (id, type) => { native.push([id, type]); return true; } };
  h.JE.initializeArrHub();
  await until(() => hubPage(h).querySelectorAll('.je-discover-card').length >= 7);
  cardOf(hubPage(h), 'tv:tmdb:20').querySelector('button.je-discover-poster-box').click();
  assert.deepEqual(native, [[20, 'tv']]);
  assert.deepEqual(opened, []);
});

test('Request on a movie asks once with the movie input, toasts the honest outcome and updates every card of the title', async t => {
  const posts = [];
  const h = setup(t, {
    hash: '#/requests?tab=discover',
    routes: f => {
      if (f.path === '/acquire/requests' && f.init.method === 'POST') {
        posts.push(JSON.parse(f.init.body));
        return { status: 201, body: { outcome: 'accepted', reason: 'queued', certainty: 'Succeeded', message: 'Asked!', requestId: 'r1' } };
      }
      if (f.path === '/acquire/discover' && f.params.get('list') === 'popular') return page([card('movie:tmdb:4', 'Someone asked', { requested: true })]);
      return undefined;
    }
  });
  h.JE.initializeArrHub();
  await until(() => hubPage(h).querySelectorAll('.je-discover-request').length >= 2);
  const root = hubPage(h);
  const cards4 = [...root.querySelectorAll('.je-discover-card')].filter(c => c.dataset.key === 'movie:tmdb:4');
  assert.equal(cards4.length, 2);
  const button = cards4[0].querySelector('.je-discover-request');
  assert.equal(button.textContent, 'addRequest');
  assert.equal(button.getAttribute('aria-label'), 'Request Someone asked');
  button.focus();
  button.click();
  button.click();                                         // a double tap is one ask
  await until(() => h.toasts.length === 1);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].input, { key: 'movie:tmdb:4', scope: 'movie', variant: 'standard', seasons: [], episodes: [] });
  assert.match(posts[0].clientRequestId, /\S{8,}/);
  assert.equal(h.toasts[0], 'Asked! We&#39;ll let you know.');
  for (const c of cards4) {
    assert.equal(c.querySelector('.je-discover-chip').textContent, 'sendAsked!');
    assert.equal(c.querySelector('.je-discover-request'), null);
  }
  assert.ok(cards4[0].contains(h.document.activeElement));    // focus stays on the card
  // The page redraws after an ask (a feed change): focus comes back to the same title's card, not the tab strip.
  h.JE.internals.arrHub.selectTab('discover');
  await until(() => h.document.activeElement?.dataset?.jeFocus === 'discover:card:movie:tmdb:4');
  assert.equal(h.document.activeElement.dataset.jeFocus, 'discover:card:movie:tmdb:4');
  assert.notEqual(h.document.activeElement, cards4[0]);       // a new card (the old one was replaced)

  // A refusal says so and leaves the button.
  const h2 = setup(t, {
    hash: '#/requests?tab=discover',
    routes: f => (f.path === '/acquire/requests' ? { status: 429, body: { outcome: 'quota_exceeded', reason: 'quota_exceeded', certainty: 'Rejected', message: '' } }
      : f.path === '/acquire/requests/quota' ? { status: 200, body: { quota: { nextSlotAt: null } } } : undefined)
  });
  h2.JE.initializeArrHub();
  await until(() => hubPage(h2).querySelectorAll('.je-discover-request').length >= 2);
  cardOf(hubPage(h2), 'movie:tmdb:5').querySelector('.je-discover-request').click();
  await until(() => h2.toasts.length === 1);
  assert.equal(h2.toasts[0], 'You&#39;ve used this week&#39;s requests.');
  assert.ok(cardOf(hubPage(h2), 'movie:tmdb:5').querySelector('.je-discover-request:not([aria-busy])'));
});

test('series get Notify me without the request sheet and the sheet when it is loaded; kids are told who they ask', async t => {
  const notify = { rowButton: (entry, box) => { const b = h.document.createElement('button'); b.className = 'je-hub-btn je-notify-follow'; b.dataset.key = entry.key; b.textContent = 'Notify me'; box.appendChild(b); } };
  let h = setup(t, { hash: '#/requests?tab=discover', JE: { arrNotify: { enabled: () => true }, internals: { arrNotify: notify } } });
  h.JE.initializeArrHub();
  await until(() => hubPage(h).querySelectorAll('.je-discover-card').length >= 7);
  const show = cardOf(hubPage(h), 'tv:tmdb:20');
  assert.equal(show.querySelector('.je-discover-request'), null);
  assert.ok(show.querySelector('.je-notify-follow'));
  assert.equal(cardOf(hubPage(h), 'movie:tmdb:1').querySelector('.je-notify-follow'), null);   // nothing to wait for
  assert.ok(cardOf(hubPage(h), 'movie:tmdb:5').querySelector('.je-notify-follow'));

  const sheets = [];
  h = setup(t, { hash: '#/requests?tab=discover', me: KID, JE: { arrAskSheet: { open: arg => sheets.push(arg) } } });
  h.JE.initializeArrHub();
  await until(() => hubPage(h).querySelectorAll('.je-discover-card').length >= 7);
  const kidShow = cardOf(hubPage(h), 'tv:tmdb:20').querySelector('.je-discover-request');
  assert.equal(kidShow.textContent, 'chatAsk Dad');
  assert.equal(kidShow.getAttribute('aria-label'), 'Ask Dad for A show');
  kidShow.click();
  assert.deepEqual(plain(sheets), [{ key: 'tv:tmdb:20', kind: 'series', name: 'A show', year: 2024, poster: '/p.jpg' }]);
  assert.equal(h.fetches.filter(f => f.init.method === 'POST').length, 0);
  assert.equal(cardOf(hubPage(h), 'movie:tmdb:5').querySelector('.je-discover-request').textContent, 'chatAsk Dad');
});

test('a row answer is published only while its intent is current (tab left, user switched, More replaced)', async t => {
  const gates = new Map();
  const h = setup(t, {
    hash: '#/requests?tab=discover',
    routes: f => {
      if (f.path !== '/acquire/discover') return undefined;
      const d = deferred();
      gates.set(`${f.params.get('list')}:${f.params.get('page')}:${gates.size}`, { d, f });
      return d.promise;
    }
  });
  h.JE.initializeArrHub();
  await until(() => gates.size === 4);
  // Leave the tab: the reads are aborted and their late answers dropped.
  h.JE.internals.arrHub.selectTab('mine');
  for (const { d, f } of gates.values()) {
    assert.equal(f.aborted, true);
    d.resolve(DEFAULT_ROWS[`${f.params.get('list')}:${f.params.get('type')}`]);
  }
  await wait(20);
  assert.equal(h.document.querySelectorAll('.je-discover-card').length, 0);
  // Back on the tab: a fresh read per row.
  gates.clear();
  h.JE.internals.arrHub.selectTab('discover');
  await until(() => gates.size === 4);
  // A user switch makes the answers on their way stale.
  const pending = [...gates.values()];
  h.switchUser();
  for (const { d, f } of pending) d.resolve(DEFAULT_ROWS[`${f.params.get('list')}:${f.params.get('type')}`]);
  await wait(20);
  assert.equal(h.document.querySelectorAll('.je-discover-card').length, 0);
});

test('More reads the next page of a row and appends it, also across a redraw while it is on its way', async t => {
  const answers = [];
  const h = setup(t, {
    hash: '#/requests?tab=discover',
    routes: f => {
      if (f.path !== '/acquire/discover' || f.params.get('list') !== 'trending') return undefined;
      const d = deferred();
      answers.push({ d, f });
      return d.promise;
    }
  });
  h.JE.initializeArrHub();
  await until(() => answers.length === 1);
  answers[0].d.resolve(page([card('movie:tmdb:1', 'One')], { totalPages: 3 }));
  await until(() => hubPage(h).querySelector('.je-discover-more'));
  hubPage(h).querySelector('.je-discover-more').click();
  await until(() => answers.length === 2);
  assert.equal(answers[1].f.params.get('page'), '2');
  // The page redraws (a feed change) while page 2 is on its way: the read still lands.
  const internals = h.JE.internals.arrHub;
  internals.selectTab('discover');
  await wait(10);
  const more = hubPage(h).querySelector('.je-discover-more');
  assert.equal(more.disabled, true);
  answers[1].d.resolve(page([card('movie:tmdb:2', 'Two')], { totalPages: 3, page: 2 }));
  await until(() => cardOf(hubPage(h), 'movie:tmdb:2'));
  assert.deepEqual([...hubPage(h).querySelectorAll('[data-je-discover-row="trending"] .je-discover-card')].map(c => c.dataset.key), ['movie:tmdb:1', 'movie:tmdb:2']);
  assert.ok(hubPage(h).querySelector('.je-discover-more'));
});

// ------------------------------------------------------------------ search row

const SEARCH_HTML = `<div id="searchPage" class="page"><input id="searchTextInput" /><div class="searchResults">
  <div class="verticalSection" id="movies"><div class="card" data-type="Movie"></div></div>
  <div class="verticalSection" id="people"><div class="card" data-type="Person"></div></div></div></div>`;

function typeInto(h, value) {
  const input = h.document.getElementById('searchTextInput');
  input.value = value;
  input.dispatchEvent(new h.window.Event('input'));
}

test('the search row is debounced, drops stale answers by intent token and sits after Jellyfin\'s Movies row', async t => {
  const answers = [];
  const h = setup(t, {
    html: SEARCH_HTML,
    routes: f => {
      if (f.path !== '/acquire/search') return undefined;
      const d = deferred();
      answers.push({ d, f });
      return d.promise;
    }
  });
  h.JE.initializeArrAskSearch();
  h.JE.initializeArrAskSearch();                          // once
  typeInto(h, 'd');
  typeInto(h, 'du');
  typeInto(h, 'dune');
  await wait(200);
  assert.equal(h.searches().length, 0);                   // still typing
  await until(() => answers.length === 1);
  assert.equal(answers[0].f.params.get('q'), 'dune');
  // The viewer types on before the answer: the old read is aborted, its late answer never drawn.
  typeInto(h, 'dune part two');
  assert.equal(answers[0].f.aborted, true);
  await until(() => answers.length === 2);
  answers[1].d.resolve(page([card('movie:tmdb:2', 'Dune: Part Two'), card('movie:tmdb:3', 'In library', { inLibrary: true, itemId: 'bb' })]));
  answers[0].d.resolve(page([card('movie:tmdb:1', 'Dune (old answer)')]));
  await until(() => h.document.querySelector('.je-ask-search-section'));
  await wait(20);
  const section = h.document.querySelector('.je-ask-search-section');
  assert.equal(section.querySelector('.sectionTitle').textContent, 'Not in your library');
  assert.deepEqual([...section.querySelectorAll('.je-discover-card')].map(c => c.dataset.key), ['movie:tmdb:2']);
  assert.equal(h.document.getElementById('movies').nextElementSibling, section);
  assert.ok(section.querySelector('.je-discover-request'));

  // Jellyfin re-renders the results and drops our row: it comes back without a new search.
  section.remove();
  h.mutations.forEach(fn => fn());
  assert.equal(h.document.getElementById('movies').nextElementSibling, section);
  assert.equal(h.searches().length, 2);

  // Clearing the box removes the row; leaving the search page too.
  typeInto(h, '');
  assert.equal(h.document.querySelector('.je-ask-search-section'), null);
  typeInto(h, 'arrival');
  await until(() => answers.length === 3);
  answers[2].d.resolve(page([card('movie:tmdb:4', 'Arrival')]));
  await until(() => h.document.querySelector('.je-ask-search-section'));
  h.document.getElementById('searchPage').classList.add('hide');
  h.mutations.forEach(fn => fn());
  assert.equal(h.document.querySelector('.je-ask-search-section'), null);
});

test('no search row for kids when search is hidden from them, in Seerr mode, or while Seerr\'s own row is on', async t => {
  for (const [name, me, config, expected] of [
    ['member', MEMBER, { ArrKidsHideSearch: true }, true],
    ['kid', KID, {}, true],
    ['kid with search hidden', KID, { ArrKidsHideSearch: true }, false],
    ['Seerr mode', { ...MEMBER, backend: 'seerr' }, {}, false],
    ['Seerr search row on', MEMBER, { JellyseerrEnabled: true }, false],
    ['Seerr on, its row off', MEMBER, { JellyseerrEnabled: true, JellyseerrShowSearchResults: false }, true]
  ]) {
    await t.test(name, async t2 => {
      const h = setup(t2, { html: SEARCH_HTML, me, config, routes: f => (f.path === '/acquire/search' ? page([card('movie:tmdb:7', 'Seven')]) : undefined) });
      h.JE.initializeArrAskSearch();
      typeInto(h, 'seven');
      await wait(380);
      await until(() => !expected || h.document.querySelector('.je-ask-search-section'), 1000);
      assert.equal(h.searches().length, expected ? 1 : 0);
      assert.equal(!!h.document.querySelector('.je-ask-search-section'), expected);
      if (expected && me === KID) assert.equal(h.document.querySelector('.je-ask-search-section .je-discover-request').textContent, 'chatAsk Dad');
    });
  }
});

test('the search row starts itself on the first navigation once the request controls are on, and a failed search says so', async t => {
  const h = setup(t, { html: SEARCH_HTML, routes: f => (f.path === '/acquire/search' ? { status: 503, body: { outcome: 'unavailable', reason: 'discover_unavailable' } } : undefined) });
  assert.equal(h.navigation.length, 1);                   // registered at load, nothing else ran
  assert.equal(h.fetches.length, 0);
  h.navigation[0]();
  typeInto(h, 'dune');
  await until(() => h.document.querySelector('.je-ask-search-section'), 1500);
  assert.equal(h.document.querySelector('.je-ask-search-section .je-discover-note').textContent, 'Couldn\'t search for titles that aren\'t in your library right now.');
  // A user switch drops the row.
  h.switchUser();
  assert.equal(h.document.querySelector('.je-ask-search-section'), null);
});

// ------------------------------------------------------------------ review round 1

const SHEET = ['arr/ask/ask-sheet-styles.js', 'arr/ask/ask-sheet.js'];

test('cards use the request sheet: a series has its seasons read first, a movie follows the one-tap rules (4K holders choose)', async t => {
  const posts = [];
  const tmdb = { seasons: [{ season_number: 1, episode_count: 8, air_date: '2019-01-01' }, { season_number: 2, episode_count: 8, air_date: '2021-01-01' }] };
  const routes = f => {
    if (f.path === '/tmdb/tv/20') return tmdb;
    if (f.path === '/acquire/requests/quota') return { quota: { used: 0, limit: 7, remaining: 7, nextSlotAt: null, usedGb: 0, available: true } };
    if (f.path === '/acquire/requests' && f.init.method === 'POST') {
      posts.push(JSON.parse(f.init.body));
      return { status: 201, body: { outcome: 'accepted', reason: 'queued', certainty: 'Succeeded', message: 'Asked!', requestId: `r${posts.length}` } };
    }
    return undefined;
  };
  const h = setup(t, { hash: '#/requests?tab=discover', me: { ...MEMBER, can4kMovies: true }, routes, modules: SHEET });
  h.JE.initializeArrHub();
  await until(() => hubPage(h).querySelectorAll('.je-discover-card').length >= 7);

  cardOf(hubPage(h), 'movie:tmdb:5').querySelector('.je-discover-request').click();
  await until(() => h.document.querySelector('.je-sheet'));
  assert.ok(h.document.querySelector('.je-sheet-variant-option[data-variant="4k"]'), 'a 4K holder chooses');
  assert.equal(posts.length, 0, 'nothing is asked before the choice');
  h.document.querySelector('.je-sheet-primary').click();
  await until(() => posts.length === 1 && cardOf(hubPage(h), 'movie:tmdb:5').querySelector('.je-discover-chip'));
  assert.deepEqual(posts[0].input, { key: 'movie:tmdb:5', scope: 'movie', variant: 'standard', seasons: [], episodes: [] });
  assert.equal(cardOf(hubPage(h), 'movie:tmdb:5').querySelector('.je-discover-chip').textContent, 'sendAsked!');

  cardOf(hubPage(h), 'tv:tmdb:20').querySelector('.je-discover-request').click();
  await until(() => h.document.querySelector('.je-sheet-card'));
  assert.ok(h.fetches.some(f => f.path === '/tmdb/tv/20'));
  const choices = [...h.document.querySelectorAll('.je-sheet-card')].map(c => c.dataset.choice);
  assert.ok(choices.includes('everything') && choices.includes('pick'), `season choices: ${choices}`);
  h.document.querySelector('.je-sheet-card[data-choice="everything"]').click();
  h.document.querySelector('.je-sheet-primary').click();
  await until(() => posts.length === 2);
  assert.deepEqual(posts[1].input, { key: 'tv:tmdb:20', scope: 'seasons', variant: 'standard', seasons: [1, 2], episodes: [] });

  // Nothing needs the sheet: one tap and a toast.
  const posts2 = [];
  const m = setup(t, {
    hash: '#/requests?tab=discover', modules: SHEET,
    routes: f => (f.path === '/acquire/requests' ? (posts2.push(1), { status: 201, body: { outcome: 'accepted', reason: 'queued', certainty: 'Succeeded', message: 'Asked!', requestId: 'r' } })
      : f.path === '/acquire/requests/quota' ? { quota: { used: 0, limit: 7, remaining: 7, available: true } } : undefined)
  });
  m.JE.initializeArrHub();
  await until(() => hubPage(m).querySelectorAll('.je-discover-request').length >= 2);
  cardOf(hubPage(m), 'movie:tmdb:5').querySelector('.je-discover-request').click();
  await until(() => m.toasts.length === 1);
  assert.equal(posts2.length, 1);
  assert.equal(m.document.querySelector('.je-sheet'), null);
  assert.equal(m.toasts[0], 'Asked! We&#39;ll let you know.');
});

// ------------------------------------------------------------------ review round 2

test('a partial ask keeps Request more: other seasons of a series, the other copy of a movie for a 4K holder', async t => {
  const posts = [];
  const tmdb = { seasons: [1, 2, 3].map(n => ({ season_number: n, episode_count: 8, air_date: `20${10 + n}-01-01` })) };
  const rows = {
    'trending:movie': page([
      card('tv:tmdb:20', 'One season asked', { requested: true, mine: 'asked', mineVariants: ['standard'], mineSeasons: [1] }),
      card('movie:tmdb:6', 'Asked in HD', { requested: true, mine: 'asked', mineVariants: ['standard'] }),
      card('movie:tmdb:7', 'Asked in 4K', { requested: true, mine: 'waiting', mineVariants: ['4k'] })
    ]),
    'upcoming:movie': page([]), 'popular:tv': page([]), 'because:movie': page([], { groups: [] })
  };
  const routes = f => {
    if (f.path === '/acquire/discover') return rows[`${f.params.get('list')}:${f.params.get('type')}`];
    if (f.path === '/tmdb/tv/20') return tmdb;
    if (f.path === '/acquire/requests/quota') return { quota: { used: 0, limit: 7, remaining: 7, nextSlotAt: null, usedGb: 0, available: true } };
    if (f.path === '/acquire/requests' && f.init.method === 'POST') {
      posts.push(JSON.parse(f.init.body));
      return { status: 201, body: { outcome: 'accepted', reason: 'queued', certainty: 'Succeeded', message: 'Asked!', requestId: `r${posts.length}` } };
    }
    return undefined;
  };
  const h = setup(t, { hash: '#/requests?tab=discover', routes, modules: SHEET });
  h.JE.initializeArrHub();
  await until(() => hubPage(h).querySelectorAll('.je-discover-card').length >= 3);
  const root = hubPage(h);
  const series = cardOf(root, 'tv:tmdb:20');
  assert.equal(series.querySelector('.je-discover-chip').textContent, 'sendAsked!', 'the chip still says what was asked');
  const more = series.querySelector('.je-discover-request');
  assert.ok(more, 'a series asked for in part keeps its button');
  assert.equal(more.textContent, 'addRequest more');
  assert.equal(more.getAttribute('aria-label'), 'Request more of One season asked');
  assert.equal(cardOf(root, 'movie:tmdb:6').querySelector('.je-discover-request'), null, 'a movie asked for in the only copy they may ask for: nothing more');
  assert.ok(cardOf(root, 'movie:tmdb:7').querySelector('.je-discover-request'), 'a 4K ask leaves the standard copy requestable');

  more.click();
  await until(() => h.document.querySelector('.je-sheet-card'));
  const checks = [...h.document.querySelectorAll('.je-sheet-pick .je-sheet-check')];
  assert.deepEqual(checks.map(c => [c.querySelector('input').disabled, c.querySelector('.je-sheet-check-facts')?.textContent]),
    [[true, 'Already asked for'], [false, '8 episodes'], [false, '8 episodes']]);
  h.document.querySelector('.je-sheet-card[data-choice="everything"]').click();
  h.document.querySelector('.je-sheet-primary').click();
  await until(() => posts.length === 1);
  assert.deepEqual(posts[0].input.seasons, [2, 3], 'Everything is what is left');
  await until(() => cardOf(hubPage(h), 'tv:tmdb:20').querySelector('.je-discover-request'));

  // A 4K holder who asked for the standard copy can ask for 4K from the card: the sheet starts on 4K.
  const k = setup(t, { hash: '#/requests?tab=discover', me: { ...MEMBER, can4kMovies: true }, routes, modules: SHEET });
  k.JE.initializeArrHub();
  await until(() => hubPage(k).querySelectorAll('.je-discover-card').length >= 3);
  const hd = cardOf(hubPage(k), 'movie:tmdb:6').querySelector('.je-discover-request');
  assert.equal(hd.textContent, 'addRequest more');
  hd.click();
  await until(() => k.document.querySelector('.je-sheet'));
  assert.equal(k.document.querySelector('.je-sheet-variant-option[aria-pressed="true"]').dataset.variant, '4k');
});

test('storage full: a card says "Paused: storage full" only when the server marks that very title (its own folder, else the default root) and opens the sheet, which says why; the household\'s new-add pause is never used', async t => {
  const posts = [];
  const checks = [];
  const FULL = { reason: 'low_disk' };
  const rows = {
    'trending:movie': page([
      card('movie:tmdb:4', 'On a full drive', { blocked: FULL }),
      card('movie:tmdb:7', 'Held on a roomy drive'),
      card('movie:tmdb:905', 'Here', { inLibrary: true, itemId: 'i905', blocked: FULL }),
      card('movie:tmdb:6', 'Asked in HD', { requested: true, mine: 'asked', mineVariants: ['standard'], blocked: FULL }),
      card('movie:tmdb:9', 'Asked in 4K', { requested: true, mine: 'asked', mineVariants: ['4k'], blocked: FULL }),
      card('movie:tmdb:8', 'Someone asked', { requested: true, blocked: FULL })
    ]),
    'upcoming:movie': page([]),
    'popular:tv': page([card('tv:tmdb:20', 'One season asked', { requested: true, mine: 'asked', mineVariants: ['standard'], mineSeasons: [1], blocked: FULL }), card('tv:tmdb:21', 'New show', { blocked: FULL }), card('tv:tmdb:22', 'Held show')]),
    'because:movie': page([], { groups: [] })
  };
  const h = setup(t, {
    hash: '#/requests?tab=discover', modules: SHEET,
    // The household's new-add pause (default roots full) is on: it must not decide any card.
    me: { ...MEMBER, can4kMovies: true, pausedMovies: FULL, pausedSeries: FULL },
    routes: f => {
      if (f.path === '/acquire/discover') return rows[`${f.params.get('list')}:${f.params.get('type')}`];
      if (f.path === '/acquire/requests' && f.init.method === 'POST') posts.push(f);
      if (f.path === '/acquire/requests/quota') return { quota: { used: 0, limit: 7, remaining: 7, nextSlotAt: null, usedGb: 0, available: true } };
      if (f.path === '/acquire/requests/check') {
        checks.push(`${f.params.get('key')}|${f.params.get('variant')}`);
        return { outcome: 'accepted', reason: 'check', check: { key: f.params.get('key'), variant: f.params.get('variant'), canRequest: false, blocked: FULL } };
      }
      return undefined;
    }
  });
  h.JE.initializeArrHub();
  await until(() => hubPage(h).querySelectorAll('.je-discover-card').length >= 9);
  const root = hubPage(h);
  const sentence = "There's no room for new downloads right now, so asking is paused. Dad can free up some space.";
  const paused = cardOf(root, 'movie:tmdb:4').querySelector('.je-discover-paused');
  assert.equal(paused.tagName, 'BUTTON', 'touch, keyboard and D-pad reach it');
  assert.equal(paused.textContent, 'storagePaused: storage full');
  assert.equal(paused.getAttribute('aria-label'), `Paused: storage full. ${sentence}`);
  assert.equal(cardOf(root, 'movie:tmdb:4').querySelector('.je-discover-request'), null);
  // The standard edition of a marked title: new, someone asked, the copy not asked yet, more seasons of a series.
  for (const key of ['tv:tmdb:21', 'movie:tmdb:8', 'movie:tmdb:9', 'tv:tmdb:20']) assert.ok(cardOf(root, key).querySelector('.je-discover-paused'), key);
  // Titles the server doesn't mark keep Request although new titles are paused (e.g. held on a roomy drive).
  assert.equal(cardOf(root, 'movie:tmdb:7').querySelector('.je-discover-request').textContent, 'addRequest');
  assert.equal(cardOf(root, 'tv:tmdb:22').querySelector('.je-discover-request').textContent, 'addRequest');
  // The 4K copy goes to another instance (another drive): Request more, the sheet checks it.
  assert.equal(cardOf(root, 'movie:tmdb:6').querySelector('.je-discover-request').textContent, 'addRequest more');
  assert.equal(cardOf(root, 'movie:tmdb:6').querySelector('.je-discover-paused'), null);
  assert.equal(cardOf(root, 'movie:tmdb:905').querySelector('.je-discover-paused, .je-discover-request'), null, 'nothing to ask for a title in the library');

  // Pressed: the sheet opens on that title, checks it and says why; nothing is asked.
  paused.click();
  await until(() => h.document.querySelector('.je-sheet-note-paused'));
  assert.deepEqual(checks, ['movie:tmdb:4|standard']);
  assert.equal(h.document.querySelector('.je-sheet-note-paused').textContent, `storagePaused: storage full · ${sentence}`);
  assert.equal(posts.length, 0);
});

test('JE mode with native details: a search-row card opens the title\'s native page and its Request asks through JE without leaving the search page; without native details the card keeps Seerr\'s window', async t => {
  for (const nativeOn of [true, false]) {
    await t.test(nativeOn ? 'native details offered' : 'native details off', async t2 => {
      const posts = [], native = [], opened = [];
      const h = setup(t2, {
        html: SEARCH_HTML,
        config: { ArrRequestsJeMode: true, JellyseerrEnabled: true },
        // Seerr's request controls in JE mode (their capture listener is on the page too).
        modules: ['arr/ask/ask-seerr.js'],
        JE: { jellyseerrMoreInfo: { open: (id, type) => opened.push([id, type]) } },
        routes: f => {
          if (f.path === '/acquire/search') return page([card('movie:tmdb:2', 'Dune: Part Two'), card('tv:tmdb:20', 'A show')]);
          if (f.path === '/acquire/requests' && f.init.method === 'POST') {
            posts.push(JSON.parse(f.init.body));
            return { status: 201, body: { outcome: 'accepted', reason: 'queued', certainty: 'Succeeded', message: 'Asked!', requestId: 'r1' } };
          }
          return undefined;
        }
      });
      h.JE.titleDetails = { available: () => nativeOn, open: (id, type) => { if (!nativeOn) return false; native.push([id, type]); return true; } };
      h.JE.initializeArrAskSearch();
      typeInto(h, 'dune');
      await until(() => h.document.querySelectorAll('.je-ask-search-section .je-discover-card').length === 2);
      const section = h.document.querySelector('.je-ask-search-section');
      cardOf(section, 'tv:tmdb:20').querySelector('button.je-discover-poster-box').click();
      if (nativeOn) {
        assert.deepEqual(native, [[20, 'tv']], 'the card body opens the native page');
        assert.deepEqual(opened, [], 'not Seerr\'s window');
      } else {
        assert.deepEqual(opened, [[20, 'tv']], 'without native details: Seerr\'s window, as before');
      }
      cardOf(section, 'movie:tmdb:2').querySelector('.je-discover-request').click();
      await until(() => h.toasts.length === 1);
      assert.equal(posts.length, 1);
      assert.deepEqual(posts[0].input, { key: 'movie:tmdb:2', scope: 'movie', variant: 'standard', seasons: [], episodes: [] });
      assert.equal(native.length, nativeOn ? 1 : 0, 'Request never opens the page');
      assert.equal(opened.length, nativeOn ? 0 : 1, 'Request never opens Seerr\'s window');
    });
  }
});
