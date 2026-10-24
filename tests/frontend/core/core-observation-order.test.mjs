// The browser follows the person's revisions in the order it asked for them, inside one sign-in: an answer asked for
// before a newer one was taken (or before a sign-in) can't roll the tab back, a read asked for after the access moved
// never joins an older one, and nothing an older read brought is kept, drawn or saved. Document reloads and their
// retries belong to the sign-in that started them, back off when they fail, and a whole-document save waits for the
// document known to be current. Through the real production modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createHarness, deferred, jsRoot } from '../helpers/harness.mjs';

/** A JSON answer of JE's API carrying the person's revisions. */
const revised = (data, revision, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'X-JE-Revision': revision }
});
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await nextTurn(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Loads the core layer in bundle order, then the given modules. */
function loadCore(h, extra = []) {
  for (const m of ['core/navigation.js', 'core/session.js', 'core/access-revision.js', 'core/api-client.js', ...extra]) h.load(m);
}

/**
 * Holds every timer of at least `min` ms (a back-off) so the test decides when it fires; shorter ones run as usual.
 * @returns {{held: Array<{fn: Function, ms: number}>, fire: (index?: number) => void}}
 */
function holdSlowTimers(h, min = 1000) {
  const real = h.window.setTimeout.bind(h.window);
  const realClear = h.window.clearTimeout.bind(h.window);
  const held = [];
  let next = 1e6;
  h.window.setTimeout = (fn, ms, ...args) => {
    if ((Number(ms) || 0) < min) return real(fn, ms, ...args);
    const id = next++;
    held.push({ id, fn: () => fn(...args), ms: Number(ms) });
    return id;
  };
  h.window.clearTimeout = (id) => {
    const at = held.findIndex(t => t.id === id);
    if (at !== -1) held.splice(at, 1);
    else realClear(id);
  };
  return { held, fire(index = 0) { const [timer] = held.splice(index, 1); timer.fn(); } };
}

test('a Discover page asked for after the access moved never joins an older read, and the older answer is neither kept nor drawn', async t => {
  let calls = 0;
  const held = deferred();
  const h = createHarness({ fetch: async () => { calls++; return calls === 1 ? held.promise : revised({ results: [] }, 'a=a2;hc=h1;sg=s1'); } });
  t.after(() => { held.resolve(revised({ results: [] }, 'a=a1;hc=h1;sg=s1')); h.close(); });
  loadCore(h, ['jellyseerr/request-manager.js', 'jellyseerr/discovery/discovery-filter-utils.js']);
  h.JE.core.revision.noteRevision('a=a1;hc=h1;sg=s1');
  const page = () => h.JE.discoveryFilter.fetchWithManagedRequest('/JellyfinEnhanced/jellyseerr/discover/movies/genre/28?page=2', 'genre');
  const old = page().then(value => value, error => error);
  await flush();
  h.JE.core.revision.noteRevision('a=a2;hc=h1;sg=s1');
  const next = page();
  await flush();
  assert.equal(calls, 2, 'the page asked for under the new access is read on its own');
  assert.deepEqual((await next).results, []);
  held.resolve(revised({ results: [{ id: 603, title: 'Now forbidden', mediaType: 'movie' }] }, 'a=a1;hc=h1;sg=s1'));
  const late = await old;
  assert.ok(!(late?.results || []).some(r => r.id === 603), 'the answer worked out for the old access is not handed out to be drawn');
  assert.equal(h.JE.core.revision.access(), 'a2', 'the older answer does not roll the tab back');
  const later = await page();
  assert.deepEqual(later.results, [], 'a later call is never served the pre-restriction page');
});

test('an answer asked for before a newer revision was taken does not roll the tab back or announce a second change', async t => {
  const old = deferred();
  const h = createHarness({ fetch: async () => old.promise });
  t.after(() => h.close());
  loadCore(h);
  h.JE.core.revision.noteRevision('a=old;hc=h1;sg=s1');
  const changes = [];
  h.document.addEventListener('je-access-revision', e => changes.push(e.detail.revision));
  const pending = h.JE.core.api.plugin('/overlap', { headers: { Accept: 'application/json' } });
  await flush();
  h.JE.core.revision.noteRevision('a=new;hc=h1;sg=s1');
  old.resolve(revised({}, 'a=old;hc=h1;sg=s1'));
  await pending;
  assert.equal(h.JE.core.revision.access(), 'new');
  assert.deepEqual(changes, ['new'], 'one access change is announced once');
});

test('an identical read started after the access moved does not join the read started before it', async t => {
  let calls = 0;
  const first = deferred();
  const h = createHarness({ fetch: async () => { calls++; return calls === 1 ? first.promise : revised({ n: 2 }, 'a=a2;hc=h1;sg=s1'); } });
  t.after(() => { first.resolve(revised({ n: 1 }, 'a=a1;hc=h1;sg=s1')); h.close(); });
  loadCore(h);
  h.JE.core.revision.noteRevision('a=a1;hc=h1;sg=s1');
  const a = h.JE.core.api.plugin('/same');
  await flush();
  h.JE.core.revision.noteRevision('a=a2;hc=h1;sg=s1');
  const b = h.JE.core.api.plugin('/same');
  await flush();
  assert.equal(calls, 2, 'not joined to the read made under the old access');
  assert.deepEqual(await b, { n: 2 });
  first.resolve(revised({ n: 1 }, 'a=a1;hc=h1;sg=s1'));
  await a;
});

test('an answer that comes in after a sign-in neither becomes the next person\'s baseline nor reads their capabilities again', async t => {
  const old = deferred();
  let count = 0;
  let user = 'user-a';
  const h = createHarness({
    apiClient: { getCurrentUserId: () => user },
    JE: { pluginConfig: { ArrRequestsEnabled: true }, arrStatus: { enabled: () => true } },
    fetch: async () => { count++; return count === 1 ? old.promise : revised({ me: { canRequest: false } }, 'a=userB;hc=b;sg=b'); }
  });
  t.after(() => h.close());
  loadCore(h, ['arr/ask/ask-core.js']);
  const pending = h.JE.arrAsk.me();
  await flush();
  user = 'user-b';
  h.JE.session.checkNow('sign-in');
  assert.equal((await h.JE.arrAsk.me()).canRequest, false);
  assert.equal(count, 2);
  old.resolve(revised({ me: { canRequest: true } }, 'a=userA;hc=a;sg=a'));
  await pending;
  assert.equal(h.JE.core.revision.access(), 'userB', 'the previous person\'s answer is not this person\'s revision');
  assert.equal((await h.JE.arrAsk.me()).canRequest, false);
  assert.equal((await h.JE.arrAsk.me()).canRequest, false);
  assert.equal(count, 2, 'their capabilities, unchanged, are not read again');
});

test('a filmography read again under an access that moved again while it ran is not drawn: the newest read is', async t => {
  const h = createHarness({ html: '<main id="detail"></main>' });
  let more;
  let controller;
  let access = 'a1';
  let reads = 0;
  const held = deferred();
  t.after(() => { controller?.cleanup(); h.close(); });
  h.JE.core = { revision: { access: () => access } };
  h.JE.jellyseerrUI = { createJellyseerrCard(item) { const c = h.document.createElement('div'); c.className = 'card'; c.dataset.id = String(item.id); return c; } };
  h.load('jellyseerr/seerr-status.js');
  h.load('jellyseerr/discovery/discovery-filter-utils.js');
  h.JE.discoveryFilter.waitForPageReady = async () => h.document.querySelector('#detail');
  h.JE.discoveryFilter.setupInfiniteScroll = (_s, _q, cb) => { more = cb; };
  h.JE.discoveryFilter.cleanupScrollObserver = () => {};
  h.load('jellyseerr/discovery/discovery-base.js');
  const rows = ids => ({ title: 'Person', items: ids.map(id => ({ id, mediaType: 'movie' })) });
  controller = h.JE.discoveryBase.createDiscovery({
    key: 'person', mode: 'client-paged', logLabel: 'Person', configKey: 'JellyseerrShowPersonDiscovery', pageSize: 2,
    getIdFromUrl: () => '1',
    resolveItems: async () => { reads++; return reads === 1 ? rows([1, 2, 3, 4, 5]) : reads === 2 ? held.promise : rows([1, 5]); }
  });
  await controller.render();
  const move = revision => { access = revision; h.document.dispatchEvent(new h.window.CustomEvent('je-access-revision', { detail: { revision } })); };
  move('a2');
  const pending = more();
  move('a3');
  held.resolve(rows([1, 3, 4, 5]));
  await pending;
  assert.equal(h.document.querySelector('.card[data-id="3"]'), null, 'a title the newest access hides is not drawn');
  assert.equal(reads, 3, 'the list is read again under the newest access');
});

test('the previous person\'s Hidden Content reload can\'t swallow the next person\'s document move', async t => {
  let user = 'user-a';
  let reads = 0;
  const held = deferred();
  const movie = 'c'.repeat(32);
  const h = createHarness({
    JE: { userConfig: { hiddenContent: { items: {}, settings: {} } } },
    apiClient: { getCurrentUserId: () => user, ajax: async () => { reads++; return reads === 1 ? held.promise : { items: { [movie]: { itemId: movie, hideScope: 'global' } }, settings: {} }; } }
  });
  t.after(() => h.close());
  for (const m of ['core/navigation.js', 'core/session.js', 'core/access-revision.js', 'enhanced/hiddencontent/hidden-content-data.js']) h.load(m);
  const content = h.JE.internals.hiddenContent;
  content.refreshNativeCardVisibility = () => {};
  content.restoreNativeCardsForIds = () => {};
  h.JE.core.revision.noteRevision('a=a1;hc=hA1;sg=s1');
  content.resetFromUserConfig();
  h.JE.core.revision.noteRevision('a=a1;hc=hA2;sg=s1');
  assert.equal(reads, 1);
  user = 'user-b';
  h.JE.session.checkNow('sign-in');
  h.JE.userConfig = { hiddenContent: { items: {}, settings: {} } };
  h.JE.core.revision.noteRevision('a=b1;hc=hB1;sg=s1');
  content.resetFromUserConfig();
  h.JE.core.revision.noteRevision('a=b1;hc=hB2;sg=s1');
  held.resolve({ items: {}, settings: {} });
  await sleep(25);
  assert.equal(content.isHidden(movie), true, 'the next person\'s moved document is read');
  assert.equal(reads, 2);
});

test('a Hidden Content reload that fails backs off (no request loop), gives up after a few tries, recovers on the next page, and a sign-in ends it', async t => {
  let user = 'user-a';
  let reads = 0;
  let failing = true;
  const movie = 'd'.repeat(32);
  const h = createHarness({
    JE: { userConfig: { hiddenContent: { items: {}, settings: {} } } },
    apiClient: { getCurrentUserId: () => user, ajax: async () => { reads++; if (failing) throw new Error('offline'); return { items: { [movie]: { itemId: movie, hideScope: 'global' } }, settings: {} }; } },
    fetch: async () => revised({ revision: 'a=a1;hc=h2;sg=s1' }, 'a=a1;hc=h2;sg=s1')
  });
  t.after(() => h.close());
  h.allowConsoleError(/./);
  const timers = holdSlowTimers(h);
  for (const m of ['core/navigation.js', 'core/session.js', 'core/access-revision.js', 'enhanced/hiddencontent/hidden-content-data.js']) h.load(m);
  const content = h.JE.internals.hiddenContent;
  content.refreshNativeCardVisibility = () => {};
  content.restoreNativeCardsForIds = () => {};
  h.JE.core.revision.noteRevision('a=a1;hc=h1;sg=s1');
  content.resetFromUserConfig();
  h.JE.core.revision.noteRevision('a=a1;hc=h2;sg=s1');
  await sleep(60);
  assert.equal(reads, 1, 'one failure is not retried at once');
  const delays = [];
  for (let i = 0; i < 6 && timers.held.length; i++) {
    delays.push(timers.held[0].ms);
    timers.fire();
    await sleep(10);
  }
  assert.ok(delays.length >= 1 && delays.length <= 4, `a bounded number of retries (${delays.length})`);
  for (let i = 1; i < delays.length; i++) assert.ok(delays[i] > delays[i - 1], `each retry waits longer (${delays})`);
  assert.ok(delays[0] >= 1000, 'the first retry waits');
  assert.equal(reads, 1 + delays.length, 'one request per try');
  assert.equal(timers.held.length, 0, 'nothing more is scheduled once it gave up');
  await sleep(60);
  assert.equal(reads, 1 + delays.length);
  // The next page: read again, and this time it works.
  failing = false;
  h.window.history.pushState({}, '', '#!/details?id=1');
  await sleep(60);
  assert.equal(content.isHidden(movie), true, 'the moved document is in after the next page');
  // A retry of the previous person never runs for the next one.
  failing = true;
  h.JE.core.revision.noteRevision('a=a1;hc=h3;sg=s1');
  await sleep(30);
  assert.equal(timers.held.length, 1, 'a retry waits');
  const before = reads;
  user = 'user-b';
  h.JE.session.checkNow('sign-in');
  assert.equal(timers.held.length, 0, 'the sign-in ends the previous person\'s retry');
  await sleep(30);
  assert.equal(reads, before);
});

test('a revision while a card\'s first badge read is out reads it again and paints it; a badge already shown stays in place', async t => {
  const shown = '1'.repeat(32);
  const first = '2'.repeat(32);
  const observers = [];
  let reads = 0;
  const held = deferred();
  const answer = ids => ({ items: ids.map(id => ({ itemId: id, key: `movie:tmdb:${id.slice(0, 1)}`, kind: 'movie', stage: 'downloading', progress: 40 })) });
  const card = id => `<div class="card" data-id="${id}" data-type="Movie"><div class="cardBox"><div class="cardScalable"></div></div></div>`;
  const h = createHarness({
    html: card(shown) + card(first),
    globals: { IntersectionObserver: class { constructor(fn) { this.fn = fn; this.observed = new Set(); observers.push(this); } observe(el) { this.observed.add(el); } unobserve(el) { this.observed.delete(el); } disconnect() { this.observed.clear(); } } },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrStatusPosterBadges: true }, currentSettings: {}, t: x => x,
      helpers: { debounce: fn => fn, onBodyMutation: () => ({ unsubscribe() {} }) },
      core: {
        api: { plugin: async (path) => {
          reads++;
          const ids = decodeURIComponent(String(path)).match(/[0-9a-f]{32}/g) || [];
          return reads === 2 ? held.promise : answer(ids.length ? ids : [shown, first]);
        } },
        navigation: { onNavigate: () => () => {} }, lifecycle: { register: () => ({ track: x => x }) }
      },
      session: { getEpoch: () => 0, isCurrent: () => true, onUserChange() {} }
    }
  });
  t.after(() => { held.resolve(answer([first])); h.close(); });
  for (const m of ['arr/status/status-core.js', 'arr/status/status-cards.js', 'arr/status/status-styles.js']) h.load(m);
  h.JE.initializeArrStatus();
  const cards = h.JE.internals.arrStatusCards;
  cards.scan();
  const target = id => [...observers[0].observed].find(el => el.getAttribute('data-id') === id);
  const shownCard = target(shown);
  const firstCard = target(first);
  observers[0].fn([{ isIntersecting: true, target: shownCard }]);
  await cards.flush();
  const badge = shownCard.querySelector('.je-arr-badge');
  assert.ok(badge, 'the first card has its badge');
  observers[0].fn([{ isIntersecting: true, target: firstCard }]);
  const pending = cards.flush();
  await flush();
  assert.equal(reads, 2, 'the second card\'s first read is out');
  const removed = [];
  new h.window.MutationObserver(records => records.forEach(r => r.removedNodes.forEach(n => removed.push(n)))).observe(h.document.body, { subtree: true, childList: true });
  h.document.dispatchEvent(new h.window.CustomEvent('je-access-revision', { detail: { before: 'a1', revision: 'a2' } }));
  held.resolve(answer([first]));
  await pending;
  await sleep(400);
  await cards.flush();
  await flush();
  assert.equal(reads, 3, 'one replacement read for both cards');
  assert.ok(firstCard.querySelector('.je-arr-badge'), 'the card whose first read was fenced gets its badge without a navigation');
  assert.equal(shownCard.querySelector('.je-arr-badge'), badge, 'the badge already shown is the same element');
  assert.deepEqual(removed.filter(n => n.classList?.contains('je-arr-badge')), [], 'no badge came off and back on');
});

/** The Spoiler Guard state + settings tab over a server whose preferences the test holds. */
function spoilerGuard(t, { reload, session } = {}) {
  const state = { sg: 's1', gets: 0, posted: null, order: [], server: { HideCast: true, HideRatings: true } };
  const h = createHarness({
    html: '<div id="help"><input type="checkbox" id="sbPrefHideRatings" data-pref="HideRatings" checked></div>',
    JE: {
      pluginConfig: { SpoilerBlurEnabled: true },
      session,
      core: { revision: { document: () => state.sg }, api: { plugin: async (path, opt) => {
        if (opt?.method === 'POST') { state.order.push('post'); state.posted = JSON.parse(JSON.stringify(opt.body)); state.server = state.posted; return { prefs: state.posted }; }
        state.gets++;
        state.order.push('get');
        if (state.gets === 1) return { Prefs: { ...state.server } };
        return reload.promise;
      } } },
      internals: { spoilerGuard: { normalizeId: id => id } }
    }
  });
  t.after(() => h.close());
  h.load('enhanced/spoilerguard/state.js');
  h.load('enhanced/spoilerguard/settings-tab.js');
  return { h, state, sg: h.JE.internals.spoilerGuard };
}

test('a Spoiler Guard preference saved while a newer document is being read waits for it: both devices\' changes survive', async t => {
  const reload = deferred();
  const { h, state, sg } = spoilerGuard(t, { reload });
  await sg.loadState();
  sg.wireSettings({ help: h.document.querySelector('#help'), resetAutoCloseTimer() {} });
  await flush();
  // Another device turns cast hiding off; this tab sees the new revision and starts a slow read.
  state.server = { HideCast: false, HideRatings: true };
  state.sg = 's2';
  h.document.dispatchEvent(new h.window.CustomEvent('je-document-revision', { detail: { document: 'spoiler-guard', revision: 's2' } }));
  await flush();
  assert.equal(state.gets, 2);
  const box = h.document.querySelector('input');
  box.checked = false;
  box.dispatchEvent(new h.window.Event('change'));
  await flush();
  assert.equal(state.posted, null, 'nothing is saved before the current document is in');
  reload.resolve({ Prefs: { HideCast: false, HideRatings: true } });
  await flush();
  assert.deepEqual(state.order, ['get', 'get', 'post'], 'the current document is read before the save');
  assert.equal(state.posted.HideRatings, false, 'this tab\'s change is saved');
  assert.equal(state.posted.HideCast, false, 'the other device\'s change is kept');
  assert.equal(box.checked, false);
});

test('a Spoiler Guard preference is not saved over a document whose newer read failed', async t => {
  const reload = deferred();
  const { h, state, sg } = spoilerGuard(t, { reload });
  h.expectConsoleError(/preference save failed/);
  await sg.loadState();
  sg.wireSettings({ help: h.document.querySelector('#help'), resetAutoCloseTimer() {} });
  await flush();
  state.server = { HideCast: false, HideRatings: true };
  state.sg = 's2';
  h.document.dispatchEvent(new h.window.CustomEvent('je-document-revision', { detail: { document: 'spoiler-guard', revision: 's2' } }));
  await flush();
  const box = h.document.querySelector('input');
  box.checked = false;
  box.dispatchEvent(new h.window.Event('change'));
  await flush();
  reload.reject(new Error('offline'));
  await flush();
  assert.equal(state.posted, null, 'the old document is never saved over the newer one');
  assert.equal(box.checked, true, 'the box shows what is saved');
  assert.equal(state.server.HideCast, false);
});

test('a Spoiler Guard preference save started before a sign-in is never sent for the next person', async t => {
  const reload = deferred();
  let epoch = 1;
  const handlers = [];
  const session = { getEpoch: () => epoch, isCurrent: e => e === epoch, onUserChange(_name, fn) { handlers.push(fn); } };
  const { h, state, sg } = spoilerGuard(t, { reload, session });
  h.allowConsoleError(/preference save failed/);
  await sg.loadState();
  sg.wireSettings({ help: h.document.querySelector('#help'), resetAutoCloseTimer() {} });
  await flush();
  state.sg = 's2';
  h.document.dispatchEvent(new h.window.CustomEvent('je-document-revision', { detail: { document: 'spoiler-guard', revision: 's2' } }));
  await flush();
  const box = h.document.querySelector('input');
  box.checked = false;
  box.dispatchEvent(new h.window.Event('change'));
  await flush();
  epoch = 2;
  handlers.forEach(fn => fn({ epoch }));
  reload.resolve({ Prefs: { HideCast: true, HideRatings: true } });
  await flush();
  assert.equal(state.posted, null, 'nothing of the previous person is saved for the next one');
});

test('a Hidden Content save made while the other device\'s newer rules are known keeps both: the current document is read first', async t => {
  const local = 'e'.repeat(32);
  const remote = 'f'.repeat(32);
  let hc = 'h1';
  let reads = 0;
  const posts = [];
  const order = [];
  const server = { items: {}, settings: {} };
  const h = createHarness({
    JE: { userConfig: { hiddenContent: { items: {}, settings: {} } } },
    apiClient: { ajax: async (req) => {
      if (req.type === 'POST') { order.push('post'); posts.push(JSON.parse(req.data)); Object.assign(server, JSON.parse(req.data)); hc = 'h3'; return {}; }
      reads++;
      order.push('get');
      return JSON.parse(JSON.stringify(server));
    } },
    fetch: async () => revised({ revision: `a=a1;hc=${hc};sg=s1` }, `a=a1;hc=${hc};sg=s1`)
  });
  t.after(() => h.close());
  loadCore(h, ['enhanced/hiddencontent/hidden-content-data.js', 'enhanced/hiddencontent/hidden-content-save.js']);
  const content = h.JE.internals.hiddenContent;
  content.refreshNativeCardVisibility = () => {};
  content.restoreNativeCardsForIds = () => {};
  content.showUndoToast = () => {};
  await h.JE.core.revision.probe('start', true);
  content.resetFromUserConfig();
  // This tab hides a title (its save waits a moment); meanwhile another device hides another one.
  content.hideItem({ itemId: local, name: 'Local', type: 'Movie', hideScope: 'global' });
  server.items = { [remote]: { itemId: remote, name: 'Remote', type: 'Movie', hideScope: 'global' } };
  hc = 'h2';
  await h.JE.core.revision.probe('navigation', true);
  await sleep(750);
  await flush();
  assert.equal(posts.length, 1);
  assert.equal(order[0], 'get', 'the current document is read before the save');
  assert.ok(posts[0].items[local], 'this tab\'s hide is saved');
  assert.ok(posts[0].items[remote], 'the other device\'s hide is kept');
  assert.equal(content.isHidden(remote), true, 'and applies here');
  assert.equal(content.isHidden(local), true);
});

test('every answer whose revision the tab takes is matched to the read that asked for it', () => {
  const files = [];
  const walk = dir => { for (const name of readdirSync(dir)) { const p = resolve(dir, name); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(jsRoot);
  const unmatched = [];
  for (const file of files) {
    const rel = relative(jsRoot, file);
    if (rel === 'core/access-revision.js') continue;
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/noteResponse\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)) {
      if (!m[1].includes(',')) unmatched.push(`${rel}: noteResponse(${m[1]})`);
    }
  }
  assert.deepEqual(unmatched, [], 'each noteResponse names the observation taken when its read was asked for');
});
