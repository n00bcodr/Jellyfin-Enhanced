// Phase 2 UX task 4 (UX-10, UX-11, UX-16, UX-21): one status word for a request on Home and the Requests page,
// the search page never says "no results" above JE's "Not in your library" titles, a failed external search
// has a focusable Try again that keeps the query and focus (stale answers dropped), and an empty My requests
// leads to Discover and Search.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createHarness, jsRoot, deferred } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const USER = '0123456789abcdef0123456789abcdef';
const MEMBER = { role: 'member', canRequest: true, canApprove: false, asksFirst: false, backend: 'je', contact: 'Dad' };

function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await wait(10);
}

const card = (key, title) => ({
  key, kind: key.startsWith('tv:') ? 'tv' : 'movie', tmdbId: Number(key.split(':').pop()), title, year: 2024, poster: '/p.jpg',
  overview: 'Text', inLibrary: false, itemId: null, requested: false, mine: null
});
const page = results => ({ outcome: 'accepted', reason: 'search', certainty: 'Succeeded', message: 'Search', answer: { page: 1, totalPages: 1, results } });

/**
 * The hub, Discover, the ask core and the search row (as features-arr-discover), with the search calls' options
 * recorded. routes(entry) answers fetches (an object: JSON 200; {status, body}; a promise of either).
 */
function setup(t, { hash = '#/home', me = MEMBER, routes = () => undefined, html = '', config = {}, realObserver = false, realTransport = false } = {}) {
  const fetches = [];
  const calls = [];
  const mutations = [];
  const navigation = [];
  const h = createHarness({
    html: `<div class="mainAnimatedPages"><div class="mainAnimatedPage" id="homePage"></div></div>${html}`,
    url: `http://jellyfin.test/web/index.html${hash}`,
    apiClient: { getCurrentUserId: () => USER },
    fetch: async (url, init = {}) => {
      const u = new URL(String(url));
      const entry = { path: u.pathname.replace('/JellyfinEnhanced', ''), params: u.searchParams, init, aborted: false };
      fetches.push(entry);
      init.signal?.addEventListener('abort', () => { entry.aborted = true; });
      let answer = routes(entry);
      if (answer === undefined && entry.path === '/acquire/requests/me') answer = { status: 200, body: { me } };
      if (answer === undefined && entry.path === '/acquire/discover') answer = page([]);
      answer = await answer;
      if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (answer === undefined) throw new Error(`no fixture for ${url}`);
      const shaped = answer && typeof answer.status === 'number' && 'body' in answer ? answer : { status: 200, body: answer };
      return new Response(JSON.stringify(shaped.body), { status: shaped.status, headers: { 'Content-Type': 'application/json' } });
    },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrRequestsHubEnabled: true, ArrRequestsEnabled: true, ArrRequestsJeMode: true, ...config },
      t: translate,
      toast: () => {},
      escapeHtml: s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`),
      helpers: { onSidebarRebuilt: () => {}, onBodyMutation: (id, fn) => { mutations.push(fn); return () => {}; } },
      core: {
        api: { plugin: async (path) => (path === '/acquire/hub' ? { mine: [], soon: [], ready: [] } : null) },
        navigation: { onNavigate: fn => { navigation.push(fn); return () => {}; }, onViewPage: () => () => {} },
        lifecycle: { register: () => ({ track: x => x }) }
      },
      arr: { live: { position: () => ({ epoch: 'e1', cursor: 1 }) }, onStatusChange: () => () => {} },
      session: { getEpoch: () => 0, isCurrent: e => e === 0, onUserChange: () => {} }
    }
  });
  t.after(() => h.close());
  // The production body observer (priority subscribers before paint, the rest after it) and transport.
  if (realObserver) {
    h.load('core/dom-observer.js');
    h.JE.helpers.onBodyMutation = h.JE.core.dom.onBodyMutation;
  }
  if (realTransport) h.load('core/api-client.js');
  // Records what each plugin read was asked with (the harness's transport stub ignores timeoutMs).
  const transport = h.JE.core.api.pluginResponse;
  h.JE.core.api.pluginResponse = (path, options) => {
    calls.push({ path, options });
    return transport(path, options);
  };
  for (const m of ['arr/status/status-core.js', 'arr/hub/hub-styles.js', 'arr/hub/hub-render.js', 'arr/hub/hub-discover.js', 'arr/hub/hub-page.js',
    'arr/ask/ask-core.js', 'arr/ask/ask-search.js']) h.load(m);
  return {
    ...h, fetches, calls, mutations, navigation,
    searches: () => fetches.filter(f => f.path === '/acquire/search'),
    observe: () => mutations.forEach(fn => fn())
  };
}

// Jellyfin 12's search page with no local matches: its own "no results" message, no Movies/Shows rows.
const EMPTY_SEARCH = `<div id="searchPage" class="page"><input id="searchTextInput" /><div class="searchResults padded-top padded-bottom-page">
  <div class="noItemsMessage centerMessage" id="native-empty">Sorry! No results found for "x"</div></div></div>`;

function typeInto(h, value) {
  const input = h.document.getElementById('searchTextInput');
  input.value = value;
  input.dispatchEvent(new h.window.Event('input'));
}

const shown = (h, node) => {
  if (!node.isConnected || node.hidden) return false;
  const style = h.window.getComputedStyle(node);
  return style.display !== 'none' && style.visibility !== 'hidden';
};

// ------------------------------------------------------------------ UX-10

test('UX-10: a request with nothing grabbed past the stale-search threshold reads Missing on Home, as on the Requests page', t => {
  const h = createHarness({ JE: { pluginConfig: {}, t: translate } });
  t.after(() => h.close());
  for (const m of ['arr/status/status-core.js', 'arr/home/home-render.js', 'arr/hub/hub-render.js']) h.load(m);
  const R = h.JE.internals.arrHome;
  const H = h.JE.internals.arrHub;
  const word = status => {
    const home = R.buildCard('requests', { key: 'movie:tmdb:1477104', kind: 'movie', tmdbId: 1477104, title: 'Shaun the Sheep', status });
    const panel = h.document.createElement('div');
    H.renderMine(panel, { mine: [{ key: 'movie:tmdb:1477104', kind: 'movie', group: 'onTheWay', title: 'Shaun the Sheep', status }] }, { open() {}, play() {} });
    const line = R.lineText('requests', { kind: 'movie', status });
    assert.equal(home.getAttribute('aria-label'), `Shaun the Sheep, ${line}`, 'the card says (and is named by) that word');
    return { home: line, hub: panel.querySelector('.je-arr-pill-text').textContent };
  };
  const stale = { key: 'movie:tmdb:1477104', kind: 'movie', stage: 'looking', reason: { code: 'no_release_yet', params: { since: '2026-10-24T00:00:00Z' } } };
  assert.deepEqual(word(stale), { home: 'Missing', hub: 'Missing' });
  // Before the threshold both still say it is being looked for; a delayed one is Delayed on Home, not Missing.
  assert.deepEqual(word({ ...stale, reason: { code: 'looking' } }), { home: 'Looking', hub: 'Looking for it' });
  assert.equal(word({ ...stale, attention: true }).home, 'Delayed');
});

// ------------------------------------------------------------------ UX-11

test('UX-11: with JE titles and no local matches, Jellyfin\'s "no results" gives way to a "nothing in your library" line, and comes back with the row', async t => {
  const h = setup(t, { html: EMPTY_SEARCH, routes: f => (f.path === '/acquire/search' ? page([card('movie:tmdb:1', 'The Third Man')]) : undefined) });
  h.JE.initializeArrAskSearch();
  const native = h.document.getElementById('native-empty');
  typeInto(h, 'the third man');
  await until(() => h.document.querySelector('.je-ask-search-section .je-discover-card'));
  const section = h.document.querySelector('.je-ask-search-section');
  assert.equal(shown(h, native), false, 'no global "no results" above the titles');
  assert.equal(native.textContent, 'Sorry! No results found for "x"', 'Jellyfin\'s node is never rewritten');
  const line = section.querySelector('.je-ask-search-local-none');
  assert.equal(shown(h, line), true);
  assert.equal(line.textContent, 'Nothing in your library matches "the third man".');
  assert.ok(line.compareDocumentPosition(section.querySelector('.sectionTitle')) & h.window.Node.DOCUMENT_POSITION_FOLLOWING);

  // Jellyfin then finds something itself (its message goes, a Movies row appears): the line goes too.
  native.remove();
  h.document.querySelector('.searchResults').insertAdjacentHTML('afterbegin', '<div class="verticalSection" id="movies"><div class="card" data-type="Movie"></div></div>');
  h.observe();
  assert.equal(h.document.getElementById('movies').nextElementSibling, section);
  assert.equal(shown(h, line), false);

  // A message Jellyfin draws after the row (React renders late) is hidden on the next observation, and the
  // row leaving (box cleared) gives it back.
  h.document.getElementById('movies').remove();
  const late = h.document.createElement('div');
  late.className = 'noItemsMessage centerMessage';
  late.textContent = 'Sorry! No results found';
  h.document.querySelector('.searchResults').prepend(late);
  h.observe();
  assert.equal(shown(h, late), false);
  assert.equal(shown(h, line), true);
  typeInto(h, '');
  assert.equal(h.document.querySelector('.je-ask-search-section'), null);
  assert.equal(shown(h, late), true);
});

test('UX-11: no JE titles either: Jellyfin\'s own message stays, and no row is drawn', async t => {
  const h = setup(t, { html: EMPTY_SEARCH, routes: f => (f.path === '/acquire/search' ? page([]) : undefined) });
  h.JE.initializeArrAskSearch();
  typeInto(h, 'zzzz');
  await until(() => h.searches().length === 1);
  await wait(30);
  h.observe();
  assert.equal(h.document.querySelector('.je-ask-search-section'), null);
  assert.equal(shown(h, h.document.getElementById('native-empty')), true);
});

// ------------------------------------------------------------------ UX-16

test('UX-16: a failed search offers Try again: same query, bounded, focus kept, one row after recovery', async t => {
  const answers = [];
  const h = setup(t, {
    html: EMPTY_SEARCH,
    routes: f => {
      if (f.path !== '/acquire/search') return undefined;
      const d = deferred();
      answers.push({ d, f });
      return d.promise;
    }
  });
  h.JE.initializeArrAskSearch();
  typeInto(h, 'ux-audit-unavailable');
  await until(() => answers.length === 1);
  answers[0].d.resolve({ status: 503, body: {} });
  await until(() => h.document.querySelector('.je-ask-search-retry'));
  const section = () => h.document.querySelector('.je-ask-search-section');
  assert.equal(section().querySelector('.je-discover-note').textContent, 'Couldn\'t search for titles that aren\'t in your library right now.');
  assert.equal(section().querySelector('.je-ask-search-error').getAttribute('role'), 'alert');
  assert.equal(shown(h, h.document.getElementById('native-empty')), false, 'the error row, not a global "no results"');
  const retry = section().querySelector('.je-ask-search-retry');
  assert.equal(retry.tagName, 'BUTTON');
  assert.equal(retry.type, 'button');
  assert.equal(retry.textContent, 'Try again');
  assert.equal(retry.getAttribute('aria-label'), 'Search again for titles not in your library matching "ux-audit-unavailable"');
  // Every search is bounded by the transport's timeout (the in-progress state can't spin forever).
  const searchCalls = () => h.calls.filter(c => c.path.startsWith('/acquire/search'));
  assert.equal(searchCalls().length, 1);
  const bound = searchCalls()[0].options.timeoutMs;
  assert.ok(Number.isFinite(bound) && bound > 0 && bound <= 30000, `bounded: ${bound}`);

  // Keyboard: focus on Try again, press it; a second press while it is on its way sends nothing.
  retry.focus();
  retry.click();
  retry.click();
  await until(() => answers.length === 2);
  await wait(20);
  assert.equal(answers.length, 2, 'one search per Try again');
  assert.equal(answers[1].f.params.get('q'), 'ux-audit-unavailable', 'the same query');
  assert.equal(h.document.getElementById('searchTextInput').value, 'ux-audit-unavailable', 'the box is untouched');
  assert.equal(retry.getAttribute('aria-busy'), 'true');
  assert.equal(retry.textContent, 'Trying again…');
  assert.equal(h.document.activeElement, retry, 'focus stays on the button while it works');
  // The retry's own deadline: what is left of 15 s after its capabilities read.
  assert.ok(searchCalls()[1].options.timeoutMs > 0 && searchCalls()[1].options.timeoutMs <= h.JE.internals.arrAskSearch.SEARCH_TIMEOUT_MS);

  // It fails again: a fresh Try again, focused.
  answers[1].d.resolve({ status: 503, body: {} });
  await until(() => h.document.querySelector('.je-ask-search-retry') !== retry && h.document.querySelector('.je-ask-search-retry'));
  const again = h.document.querySelector('.je-ask-search-retry');
  assert.equal(again.getAttribute('aria-busy'), null);
  assert.equal(h.document.activeElement, again);

  // Recovery: one row of titles, focus on its heading (still in the row), the box unchanged.
  again.click();
  await until(() => answers.length === 3);
  answers[2].d.resolve(page([card('movie:tmdb:1', 'Found'), card('movie:tmdb:2', 'Also found')]));
  await until(() => h.document.querySelector('.je-ask-search-section .je-discover-card'));
  assert.equal(h.document.querySelectorAll('.je-ask-search-section').length, 1);
  assert.deepEqual([...section().querySelectorAll('.je-discover-card')].map(c => c.dataset.key), ['movie:tmdb:1', 'movie:tmdb:2']);
  assert.equal(section().querySelector('.je-ask-search-retry'), null);
  assert.equal(h.document.activeElement, section().querySelector('.sectionTitle'));
  assert.equal(h.document.getElementById('searchTextInput').value, 'ux-audit-unavailable');
});

test('UX-16: Try again that finds nothing removes the row and gives focus back to the search box', async t => {
  const answers = [];
  const h = setup(t, {
    html: EMPTY_SEARCH,
    routes: f => {
      if (f.path !== '/acquire/search') return undefined;
      const d = deferred();
      answers.push({ d, f });
      return d.promise;
    }
  });
  h.JE.initializeArrAskSearch();
  typeInto(h, 'nothing like it');
  await until(() => answers.length === 1);
  answers[0].d.resolve({ status: 503, body: {} });
  await until(() => h.document.querySelector('.je-ask-search-retry'));
  const retry = h.document.querySelector('.je-ask-search-retry');
  retry.focus();
  retry.click();
  await until(() => answers.length === 2);
  answers[1].d.resolve(page([]));
  await until(() => !h.document.querySelector('.je-ask-search-section'));
  assert.equal(h.document.activeElement, h.document.getElementById('searchTextInput'));
  assert.equal(h.document.getElementById('searchTextInput').value, 'nothing like it');
  assert.equal(shown(h, h.document.getElementById('native-empty')), true, 'Jellyfin\'s own "no results" is true again');
});

test('UX-16: typing while Try again is on its way aborts it; its late answer is never drawn and the button never sticks busy', async t => {
  const answers = [];
  const h = setup(t, {
    html: EMPTY_SEARCH,
    routes: f => {
      if (f.path !== '/acquire/search') return undefined;
      const d = deferred();
      answers.push({ d, f });
      return d.promise;
    }
  });
  h.JE.initializeArrAskSearch();
  typeInto(h, 'dune');
  await until(() => answers.length === 1);
  answers[0].d.resolve({ status: 503, body: {} });
  await until(() => h.document.querySelector('.je-ask-search-retry'));
  const retry = h.document.querySelector('.je-ask-search-retry');
  retry.click();
  await until(() => answers.length === 2);
  // A keystroke and back to the same query inside the debounce: the retry's read is aborted and the row's
  // button is at rest again.
  typeInto(h, 'dun');
  assert.equal(answers[1].f.aborted, true);
  typeInto(h, 'dune');
  assert.equal(retry.getAttribute('aria-busy'), null);
  assert.equal(retry.textContent, 'Try again');
  answers[1].d.resolve(page([card('movie:tmdb:9', 'Stale answer')]));
  await wait(30);
  assert.equal(h.document.querySelector('.je-ask-search-section .je-discover-card'), null, 'the aborted answer is dropped');
  // A changed query: Try again searches what the box holds now, through the normal debounce.
  typeInto(h, 'arrival');
  retry.click();
  await until(() => answers.length === 3);
  assert.equal(answers[2].f.params.get('q'), 'arrival');
  answers[2].d.resolve(page([card('movie:tmdb:4', 'Arrival')]));
  await until(() => h.document.querySelector('.je-ask-search-section .je-discover-card'));
  assert.equal(h.document.querySelectorAll('.je-ask-search-section').length, 1);
  assert.equal(h.searches().length, 3);
});

// ------------------------------------------------------------------ UX-21

const hubPage = h => h.document.getElementById('je-requests-hub-page');

test('UX-21: an empty My requests offers Discover and Search; Discover opens that tab with focus on it', async t => {
  const h = setup(t, { hash: '#/requests' });
  h.JE.initializeArrHub();
  await until(() => hubPage(h)?.querySelector('.je-hub-empty-discover'));
  const panel = hubPage(h).querySelector('.je-hub-panel');
  assert.equal(panel.querySelector('.je-hub-empty').textContent, 'Nothing requested yet. Find something in Discover or with search and ask for it there.');
  const discover = panel.querySelector('.je-hub-empty-discover');
  const search = panel.querySelector('.je-hub-empty-search');
  assert.deepEqual([discover.tagName, discover.type, discover.textContent], ['BUTTON', 'button', 'exploreDiscover']);
  assert.deepEqual([search.tagName, search.type, search.textContent], ['BUTTON', 'button', 'searchSearch']);
  discover.focus();
  discover.click();
  await until(() => h.window.location.hash === '#/requests?tab=discover');
  assert.equal(hubPage(h).querySelector('.je-hub-tab[aria-selected="true"]').dataset.tab, 'discover');
  assert.equal(h.document.activeElement, hubPage(h).querySelector('.je-hub-tab[aria-selected="true"]'), 'focus is not dropped to the page');
  // The tab's rows (all empty here) finish loading before the page closes.
  await until(() => {
    const rows = [...hubPage(h).querySelectorAll('.je-discover-row')];
    return rows.length > 0 && rows.every(r => r.hidden);
  });
});

test('UX-21: without the Discover tab (someone who may not ask) the empty state keeps its words and offers Search', async t => {
  const h = setup(t, { hash: '#/requests', me: { ...MEMBER, role: 'watcher', canRequest: false } });
  h.JE.initializeArrHub();
  await until(() => hubPage(h)?.querySelector('.je-hub-empty-search'));
  await wait(30);
  const panel = hubPage(h).querySelector('.je-hub-panel');
  assert.equal(panel.querySelector('.je-hub-empty-discover'), null);
  assert.equal(panel.querySelector('.je-hub-empty').textContent, 'Nothing requested yet. Find something with search and ask for it there.');
  panel.querySelector('.je-hub-empty-search').click();
  assert.equal(h.window.location.hash, '#/search');
});

test('UX-21: at phone width the tab strip scrolls the selected tab into view (Discover chosen from the empty state)', async t => {
  const h = setup(t, { hash: '#/requests' });
  // jsdom has no layout: a 390 px strip whose tabs sit 110 px apart, the fourth one (Discover) past its right edge.
  const proto = h.window.HTMLElement.prototype;
  const strip = node => node.classList?.contains('je-hub-tabs');
  const scrolled = new WeakMap();
  Object.defineProperty(proto, 'scrollWidth', { configurable: true, get() { return strip(this) ? 560 : 0; } });
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get() { return strip(this) ? 390 : 0; } });
  Object.defineProperty(proto, 'scrollLeft', { configurable: true, get() { return scrolled.get(this) || 0; }, set(v) { scrolled.set(this, v); } });
  const rect = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function () {
    if (strip(this)) return { left: 0, right: 390, top: 0, bottom: 40, width: 390, height: 40 };
    if (this.classList?.contains('je-hub-tab')) {
      const i = [...this.parentElement.children].indexOf(this);
      const left = i * 110 - (scrolled.get(this.parentElement) || 0);
      return { left, right: left + 100, top: 0, bottom: 40, width: 100, height: 40 };
    }
    return rect.call(this);
  };
  h.JE.initializeArrHub();
  await until(() => hubPage(h)?.querySelector('.je-hub-empty-discover'));
  assert.equal(hubPage(h).querySelector('.je-hub-tabs').scrollLeft, 0, 'My requests is already in view');
  hubPage(h).querySelector('.je-hub-empty-discover').click();
  await until(() => hubPage(h).querySelector('.je-hub-tab[aria-selected="true"]')?.dataset.tab === 'discover');
  // Discover (index 3) spans 330–430: scrolled by 430 - 390 + 8.
  assert.equal(hubPage(h).querySelector('.je-hub-tabs').scrollLeft, 48);
  await until(() => {
    const rows = [...hubPage(h).querySelectorAll('.je-discover-row')];
    return rows.length > 0 && rows.every(r => r.hidden);
  });
});

// ------------------------------------------------------------------ fix round 2 (review UX4R-1..3)

test('UX4R-1: Try again with a stalled capabilities read ends in the error within the same 15 s deadline', async t => {
  let now = 0;
  let meReads = 0;
  const pendingMe = deferred();
  const h = setup(t, { realTransport: true, html: EMPTY_SEARCH, routes: f => {
    if (f.path === '/acquire/requests/me') { meReads++; return meReads === 1 ? { me: MEMBER } : pendingMe.promise; }
    if (f.path === '/acquire/search') return { status: 503, body: {} };
    return undefined;
  } });
  h.window.Date.now = () => now;
  h.JE.initializeArrAskSearch();
  typeInto(h, 'found');
  await until(() => h.document.querySelector('.je-ask-search-retry'));
  const retry = h.document.querySelector('.je-ask-search-retry');
  now = 61000;                                            // the capabilities cache (60 s) has expired
  retry.focus();
  // The deadline's own timer (the only one of ~15 s) is run at once; everything else keeps its delay.
  const timers = [];
  const originalTimer = h.window.setTimeout.bind(h.window);
  h.window.setTimeout = (fn, delay, ...args) => { timers.push(delay); return originalTimer(fn, delay >= 14000 && delay <= 15000 ? 25 : delay, ...args); };
  retry.click();
  await until(() => meReads === 2);
  assert.equal(retry.getAttribute('aria-busy'), 'true');
  assert.ok(timers.some(d => d >= 14000 && d <= 15000), 'the retry has a deadline while its capabilities are read');
  await until(() => h.document.querySelector('.je-ask-search-retry') !== retry && h.document.querySelector('.je-ask-search-retry'));
  const again = h.document.querySelector('.je-ask-search-retry');
  assert.equal(again.getAttribute('aria-busy'), null, 'the busy state ended');
  assert.equal(h.document.activeElement, again, 'focus stays on Try again');
  assert.equal(h.searches().length, 1, 'no search was sent without capabilities');
  // A late capabilities answer draws nothing more; a new Try again works.
  pendingMe.resolve({ status: 200, body: { me: MEMBER } });
  await wait(30);
  assert.equal(h.document.querySelector('.je-ask-search-retry'), again);
});

test('UX4R-2: a native "no results" Jellyfin draws late is hidden before paint (production observer)', async t => {
  const h = setup(t, { realObserver: true, html: EMPTY_SEARCH, routes: f => (f.path === '/acquire/search' ? page([card('movie:tmdb:1', 'Found')]) : undefined) });
  h.JE.initializeArrAskSearch();
  typeInto(h, 'found');
  await until(() => h.document.querySelector('.je-discover-card'));
  const native = h.document.getElementById('native-empty');
  assert.equal(shown(h, native), false, 'hidden in the same task the row was drawn');
  native.remove();
  await wait(80);
  // The next frame is held: anything left for after paint has not run.

  h.window.requestAnimationFrame = () => 100;
  h.document.querySelector('.searchResults').prepend(native);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(shown(h, native), false, 'hidden in the observer microtask, before the frame');
  assert.equal(shown(h, h.document.querySelector('.je-ask-search-local-none')), true);
});

test('UX4R-2: a re-search never shows the native message between the keystroke and the new row', async t => {
  const answers = [];
  const h = setup(t, { realObserver: true, html: EMPTY_SEARCH, routes: f => {
    if (f.path !== '/acquire/search') return undefined;
    const d = deferred();
    answers.push(d);
    return d.promise;
  } });
  h.JE.initializeArrAskSearch();
  typeInto(h, 'dune');
  await until(() => answers.length === 1);
  answers[0].resolve(page([card('movie:tmdb:1', 'Dune')]));
  await until(() => h.document.querySelector('.je-discover-card'));
  const visible = [];
  const watch = new h.window.MutationObserver(() => {
    const n = h.document.querySelector('.noItemsMessage');
    if (n) visible.push(shown(h, n));
  });
  watch.observe(h.document.body, { childList: true, subtree: true, attributes: true });
  typeInto(h, 'dune part two');
  // Jellyfin re-renders its message for the new query (a new node), then JE's answer arrives.
  const old = h.document.getElementById('native-empty');
  const fresh = old.cloneNode(true);
  fresh.className = 'noItemsMessage centerMessage';
  old.replaceWith(fresh);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(shown(h, fresh), false, 'the re-rendered message is hidden before paint');
  await until(() => answers.length === 2);
  answers[1].resolve(page([card('movie:tmdb:2', 'Dune: Part Two')]));
  await until(() => h.document.querySelector('.je-discover-card[data-key="movie:tmdb:2"]'));
  await wait(20);
  watch.disconnect();
  assert.equal(shown(h, fresh), false);
  assert.equal(visible.includes(true), false, 'the native message was never shown while a row was up');
});

test('UX4R-3: the "nothing in your library" line follows the query and goes when Jellyfin\'s own results arrive (retained node)', async t => {
  const answers = [];
  const h = setup(t, { realObserver: true, html: EMPTY_SEARCH, routes: f => {
    if (f.path !== '/acquire/search') return undefined;
    const d = deferred();
    answers.push(d);
    return d.promise;
  } });
  h.JE.initializeArrAskSearch();
  typeInto(h, 'found');
  await until(() => answers.length === 1);
  answers[0].resolve(page([card('movie:tmdb:1', 'Found')]));
  await until(() => h.document.querySelector('.je-discover-card'));
  const line = () => h.document.querySelector('.je-ask-search-local-none');
  assert.equal(shown(h, line()), true);
  assert.equal(line().textContent, 'Nothing in your library matches "found".');

  // The query changes: the old sentence goes at once (no stale text), until the new row is drawn.
  typeInto(h, 'found it');
  assert.equal(shown(h, line()), false, 'no sentence about the old query');
  await until(() => answers.length === 2);
  answers[1].resolve(page([card('movie:tmdb:2', 'Found it')]));
  await until(() => h.document.querySelector('.je-discover-card[data-key="movie:tmdb:2"]'));
  assert.equal(shown(h, line()), true);
  assert.equal(line().textContent, 'Nothing in your library matches "found it".');

  // Jellyfin's adapter keeps its message node and hides it with its own class as local results arrive.
  const native = h.document.getElementById('native-empty');
  const style = h.document.createElement('style');
  style.textContent = '.native-has-results { display:none !important; }';
  h.document.head.appendChild(style);
  native.classList.add('native-has-results');
  h.document.querySelector('.searchResults').insertAdjacentHTML('afterbegin', '<div class="verticalSection" id="movies"><div class="card" data-type="Movie"></div></div>');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(shown(h, line()), false, 'no false "nothing matches" above local results');
  assert.equal(native.classList.contains('je-ask-search-native-hidden'), false, 'the owner hides its own node now');
  // Even a retained node the owner leaves shown counts as stale once local results are on the page.
  native.classList.remove('native-has-results');
  h.JE.internals.arrAskSearch.check();
  assert.equal(shown(h, line()), false);
});

test('UX-11 (lab, round 2): a row drawn before Jellyfin had local rows moves after its Movies row when they arrive, before paint', async t => {
  const h = setup(t, { realObserver: true, html: EMPTY_SEARCH, routes: f => (f.path === '/acquire/search' ? page([card('movie:tmdb:1', 'Toy Story 6')]) : undefined) });
  h.JE.initializeArrAskSearch();
  typeInto(h, 'toy story');
  await until(() => h.document.querySelector('.je-discover-card'));
  const section = h.document.querySelector('.je-ask-search-section');
  // Jellyfin's search answers later: its message goes and its Movies row is added after the JE row.
  h.window.requestAnimationFrame = () => 100;             // nothing after paint runs
  h.document.getElementById('native-empty').remove();
  h.document.querySelector('.searchResults').insertAdjacentHTML('beforeend', '<div class="verticalSection" id="movies"><div class="card" data-type="Movie"></div></div>');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.document.getElementById('movies').nextElementSibling, section, 'Jellyfin\'s own results come first');
  assert.equal(shown(h, section.querySelector('.je-ask-search-local-none')), false);
});

// ------------------------------------------------------------------ fix round 3 (review UX4R2-1, UX4R2-2)

test('UX4R2-1: a Try again waiting in the client request queue is cancelled at its 15 s deadline and never sent', async t => {
  const holds = Array.from({ length: 4 }, () => deferred());
  const h = setup(t, { realTransport: true, html: EMPTY_SEARCH, routes: f => {
    if (f.path.startsWith('/hold')) return holds[Number(f.path.slice(5))].promise;
    if (f.path === '/acquire/search') return { status: 503, body: {} };
    return undefined;
  } });
  h.JE.initializeArrAskSearch();
  typeInto(h, 'dune');
  await until(() => h.document.querySelector('.je-ask-search-retry'));
  const retry = h.document.querySelector('.je-ask-search-retry');
  // Four normal requests hold every slot of the core transport.
  const holding = holds.map((_, i) => h.JE.core.api.pluginResponse(`/hold${i}`).catch(() => null));
  await until(() => h.fetches.filter(f => f.path.startsWith('/hold')).length === 4);
  // The search's own deadline (the only ~15 s timer) is run at once; every other timer keeps its delay.
  const timers = [];
  const original = h.window.setTimeout.bind(h.window);
  h.window.setTimeout = (fn, delay, ...args) => { timers.push(delay); return original(fn, delay >= 14000 && delay <= 15000 ? 25 : delay, ...args); };
  retry.focus();
  retry.click();
  assert.ok(timers.some(d => d >= 14000 && d <= 15000), 'the deadline starts at the press');
  await until(() => h.document.querySelector('.je-ask-search-retry') !== retry && h.document.querySelector('.je-ask-search-retry'));
  const again = h.document.querySelector('.je-ask-search-retry');
  assert.equal(again.getAttribute('aria-busy'), null, 'the busy state ended at the deadline');
  assert.equal(h.document.activeElement, again, 'focus is on the fresh Try again');
  assert.equal(h.searches().length, 1, 'the queued search was not sent');
  // The slots free up: the cancelled search never goes out afterwards.
  holds.forEach(d => d.resolve({ ok: true }));
  await Promise.all(holding);
  await wait(40);
  assert.equal(h.searches().length, 1, 'no search after its deadline');
  assert.equal(h.document.querySelector('.je-ask-search-retry'), again);
});

const nativeRow = (id, type) => `<div class="verticalSection" id="${id}"><div class="card" data-type="${type}"></div></div>`;

test('UX4R2-2: the row never moves above any of Jellyfin\'s rows (Movies, Episodes, People; before and after it, added and removed)', async t => {
  const h = setup(t, { realObserver: true, html: EMPTY_SEARCH, routes: f => (f.path === '/acquire/search' ? page([card('movie:tmdb:1', 'Found')]) : undefined) });
  h.JE.initializeArrAskSearch();
  typeInto(h, 'found');
  await until(() => h.document.querySelector('.je-discover-card'));
  await wait(80);
  const results = h.document.querySelector('.searchResults');
  const section = h.document.querySelector('.je-ask-search-section');
  const order = () => [...results.children].map(n => n.id || (n === section ? 'JE' : n.className.split(' ')[0]));
  h.window.requestAnimationFrame = () => 100;             // only before-paint work runs
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

  // Jellyfin inserts Movies and Episodes before the row: the already-correct order is kept.
  results.insertAdjacentHTML('afterbegin', nativeRow('movies', 'Movie') + nativeRow('episodes', 'Episode'));
  await settle();
  assert.deepEqual(order().filter(x => x !== 'native-empty'), ['movies', 'episodes', 'JE']);

  // A People row arrives after the row: the row moves below it.
  results.insertAdjacentHTML('beforeend', nativeRow('people', 'Person'));
  await settle();
  assert.deepEqual(order().filter(x => x !== 'native-empty'), ['movies', 'episodes', 'people', 'JE']);

  // Rows go away (Movies, then the last one): the row stays below the rest and never moves up past one.
  h.document.getElementById('movies').remove();
  await settle();
  assert.deepEqual(order().filter(x => x !== 'native-empty'), ['episodes', 'people', 'JE']);
  h.document.getElementById('people').remove();
  await settle();
  assert.deepEqual(order().filter(x => x !== 'native-empty'), ['episodes', 'JE']);

  // A future kind of row Jellyfin adds between: still above the row.
  h.document.getElementById('episodes').insertAdjacentHTML('afterend', nativeRow('musicvideos', 'MusicVideo'));
  await settle();
  assert.deepEqual(order().filter(x => x !== 'native-empty'), ['episodes', 'musicvideos', 'JE']);
});
