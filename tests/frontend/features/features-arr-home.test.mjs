// Phase 4d (S01): the home rows "Your requests", "Coming soon for you" and "Just arrived for you", drawn from
// GET /JellyfinEnhanced/acquire/home on Jellyfin's home page; Home Screen Sections decoration instead of
// injection; the administrators' ops strip; live re-reads through the change feed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createHarness, jsRoot } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const MODULES = ['arr/status/status-core.js', 'arr/status/status-styles.js', 'arr/home/home-styles.js', 'arr/home/home-render.js', 'arr/home/home-hss.js', 'arr/home/home-rows.js'];
const USER = '0123456789abcdef0123456789abcdef';
const ID = c => c.repeat(32);

function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

function deferred() {
  let resolveIt;
  const promise = new Promise(r => { resolveIt = r; });
  return { promise, resolve: resolveIt };
}

async function until(check, ms = 15000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await wait(10);
}

/** A local calendar day n days from today ("yyyy-MM-dd"). */
function day(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function answer(overrides = {}) {
  return {
    requests: [
      { key: 'movie:tmdb:1', kind: 'movie', tmdbId: 1, title: 'Andor Film', poster: '/andor.jpg', hssId: ID('a'),
        status: { key: 'movie:tmdb:1', kind: 'movie', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 30 } } },
      { key: 'tv:tvdb:2', kind: 'tv', tmdbId: 2, title: 'Peacemaker', itemId: ID('b'), hssId: ID('b'),
        status: { key: 'tv:tvdb:2', kind: 'series', stage: 'notOut', reason: { code: 'not_aired', params: { date: day(1) } } } },
      { key: 'movie:tmdb:9', kind: 'movie', tmdbId: 9, title: 'Asked Film', hssId: ID('9'),
        status: { key: 'movie:tmdb:9', kind: 'movie', stage: 'asked', reason: { code: 'awaiting_approval' } } }
    ],
    soon: [{ key: 'tv:tvdb:3', kind: 'tv', tmdbId: 3, title: 'Severance', day: day(1), season: 3, episode: 6, hssId: ID('c') }],
    arrived: [
      { key: 'movie:tmdb:4', kind: 'movie', tmdbId: 4, title: 'Dune: Part Two', year: 2024, itemId: ID('d'), hssId: ID('d') },
      { key: 'tv:tvdb:5', liveKey: 'tv:tvdb:5:s9:e5', kind: 'tv', tmdbId: 5, title: 'The Flash', poster: '/flash.jpg', season: 9, episode: 5, episodeTitle: 'Mask of the Red Death', itemId: ID('e'), hssId: ID('e') }
    ],
    hss: false,
    ops: false,
    ...overrides
  };
}

const MY_MEDIA = '<div class="verticalSection section0">My Media</div><div class="verticalSection section1">Continue Watching</div>';

/**
 * The home page with the real home-row modules over a fetch fixture. `routes(path, headers)` answers
 * {status, body, etag} (or a promise of one) for /acquire/home and /arr/admin/home/ops.
 */
function setup(t, { home = MY_MEDIA, hash = '#/home', routes, config = {}, globals = {} } = {}) {
  const fetches = [];
  const subscriptions = [];
  const navigation = [];
  const userChange = [];
  const opened = [];
  let epoch = 0;
  let user = USER;
  const fetch = async (url, options = {}) => {
    const path = String(url).replace('http://jellyfin.test/JellyfinEnhanced', '');
    fetches.push({ path, headers: { ...(options.headers || {}) }, signal: options.signal });
    const a = (await routes(path, options.headers || {}, fetches.length)) || { status: 404, body: { outcome: 'refused', reason: 'disabled' } };
    if (options.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return { status: a.status, headers: { get: name => (name.toLowerCase() === 'etag' ? a.etag || null : null) }, text: async () => (a.body == null ? '' : JSON.stringify(a.body)) };
  };
  const h = createHarness({
    html: `<div class="mainAnimatedPages"><div class="page homePage" id="indexPage"><div class="tabContent is-active"><div class="sections homeSectionsContainer">${home}</div></div></div></div>`,
    url: `http://jellyfin.test/web/index.html${hash}`,
    apiClient: { getCurrentUserId: () => user, getImageUrl: (id, o) => `http://jellyfin.test/Items/${id}/Images/${o.type}?maxHeight=${o.maxHeight}` },
    fetch,
    globals: { Emby: { Page: { showItem: id => opened.push(['item', id]) } }, ...globals },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrHomeRowsEnabled: true, ...config },
      t: translate,
      titleDetails: { show: (id, type) => opened.push(['tmdb', id, type]), openKey: key => opened.push(['key', key]) },
      core: {
        navigation: { onNavigate: fn => { navigation.push(fn); return () => {}; } },
        lifecycle: { register: () => ({ track: x => x }) }
      },
      arr: {
        live: { position: () => ({ epoch: 'e1', cursor: 1 }) },
        onStatusChange(keys, cb, opts) {
          const sub = { keys: [...keys], cb, opts, active: true };
          subscriptions.push(sub);
          return () => { sub.active = false; };
        }
      },
      session: { getEpoch: () => epoch, isCurrent: () => true, onUserChange: (name, fn) => userChange.push(fn) }
    }
  });
  t.after(async () => { await wait(50); h.close(); });
  for (const m of MODULES) h.load(m);
  return {
    ...h, fetches, subscriptions, opened,
    homeReads: () => fetches.filter(f => f.path === '/acquire/home'),
    opsReads: () => fetches.filter(f => f.path === '/arr/admin/home/ops'),
    live: () => subscriptions.filter(s => s.active),
    bump(key) { for (const s of subscriptions.filter(x => x.active && x.keys.includes(key))) s.cb([key]); },
    navigate(to) {
      h.window.history.replaceState(null, '', to);
      navigation.forEach(fn => fn());
    },
    viewshow() { h.document.dispatchEvent(new h.window.Event('viewshow')); },
    switchUser(next) { user = next; epoch++; userChange.forEach(fn => fn()); },
    rows: () => [...h.document.querySelectorAll('.je-home-row')].map(r => r.dataset.jeHomeRow),
    container: () => h.document.querySelector('.homeSectionsContainer')
  };
}

const ok = (body, etag = '"v1"') => ({ status: 200, body, etag });

test('draws the three rows after My Media, with native-looking cards, their words and overlays, after the first moment', async t => {
  const h = setup(t, { routes: path => (path === '/acquire/home' ? ok(answer()) : null) });
  assert.equal(h.fetches.length, 0, 'nothing is read while the page loads');
  await wait(250);
  assert.equal(h.fetches.length, 0, 'nothing is read in the first 300 ms');
  await until(() => h.rows().length === 3);
  assert.deepEqual(h.rows(), ['requests', 'soon', 'arrived']);
  const wrap = h.document.querySelector('.je-home-rows');
  assert.equal(wrap.previousElementSibling.className, 'verticalSection section0', 'right after My Media');
  assert.equal(wrap.nextElementSibling.className, 'verticalSection section1');
  assert.deepEqual([...h.document.querySelectorAll('.je-home-row .sectionTitle')].map(n => n.textContent), ['Your requests', 'Coming soon for you', 'Just arrived for you']);

  const cards = [...h.document.querySelectorAll('.je-home-row-requests .je-home-card')];
  assert.equal(cards.length, 3);
  for (const card of h.document.querySelectorAll('.je-home-card')) {
    assert.equal(card.tagName, 'BUTTON');
    assert.ok(card.classList.contains('card') && card.classList.contains('overflowPortraitCard'));
    assert.equal(card.hasAttribute('data-id'), false, 'no data-id: the poster-badge scanner leaves the card alone');
    assert.equal(card.hasAttribute('data-type'), false);
    assert.ok(card.querySelector('.cardBox .cardScalable .cardPadder-overflowPortrait'));
  }
  const text = card => [...card.querySelectorAll('.cardText')].map(n => n.textContent);
  assert.deepEqual(text(cards[0]), ['Andor Film', 'Downloading']);
  assert.ok(cards[0].querySelector('.je-home-overlay .je-arr-ring'), 'download ring');
  assert.equal(cards[0].querySelector('.je-arr-ring-text').textContent, '30');
  assert.equal(cards[0].querySelector('.je-home-poster img').getAttribute('src'), 'https://image.tmdb.org/t/p/w300/andor.jpg');
  assert.deepEqual(text(cards[1]), ['Peacemaker', 'Airs Tomorrow']);
  assert.equal(cards[1].querySelector('.je-home-pill-date').textContent.replace('event', ''), 'Tomorrow');
  assert.match(cards[1].querySelector('.je-home-poster img').getAttribute('src'), new RegExp(`/Items/${ID('b')}/Images/Primary`));
  // No background-image Jellyfin URL and no cardImageContainer: JE's poster tags and card features leave these cards alone.
  assert.equal(h.document.querySelectorAll('.je-home-rows .cardImageContainer, .je-home-rows [style*="background-image"]').length, 0);
  assert.deepEqual(text(cards[2]), ['Asked Film', 'Needs OK']);
  assert.ok(cards[2].querySelector('.je-home-poster-empty'), 'neutral placeholder without a poster');

  const soon = h.document.querySelector('.je-home-row-soon .je-home-card');
  assert.deepEqual(text(soon), ['Severance', 'S3E6 · Tomorrow']);
  assert.equal(soon.querySelector('.je-home-pill-date').textContent, 'Tomorrow');
  const arrived = [...h.document.querySelectorAll('.je-home-row-arrived .je-home-card')];
  assert.deepEqual(text(arrived[0]), ['Dune: Part Two', '2024']);
  assert.deepEqual(text(arrived[1]), ['The Flash', 'S9E5 · Mask of the Red Death']);
  assert.equal(arrived[0].querySelector('.je-home-pill-new').textContent, 'New');
  assert.match(arrived[0].querySelector('img').getAttribute('src'), new RegExp(`/Items/${ID('d')}/Images/Primary`));
  assert.equal(arrived[1].querySelector('img').getAttribute('src'), 'https://image.tmdb.org/t/p/w300/flash.jpg', 'an arrived episode shows the series poster, not its still');
  assert.equal(h.document.getElementById('je-arr-home-styles') !== null, true);

  // Opening: the Jellyfin item when there is one, else native details by TMDB id.
  arrived[1].click();
  cards[0].click();
  assert.deepEqual(h.opened, [['item', ID('e')], ['tmdb', 1, 'movie']]);
});

test('rows switched off (null) or empty are not drawn; with none left nothing is injected', async t => {
  const h = setup(t, { routes: path => (path === '/acquire/home' ? ok(answer({ requests: null, soon: [] })) : null) });
  await until(() => h.rows().length);
  assert.deepEqual(h.rows(), ['arrived']);
  const none = setup(t, { routes: path => (path === '/acquire/home' ? ok(answer({ requests: [], soon: null, arrived: [] })) : null) });
  await until(() => none.homeReads().length);
  await wait(100);
  assert.equal(none.document.querySelector('.je-home-rows'), null);
});

test('without home sections yet the rows go first (after the chip bar); a 404 (switched off) draws nothing', async t => {
  const h = setup(t, { home: '<div class="je-chipbar"></div>', routes: path => (path === '/acquire/home' ? ok(answer()) : null) });
  await until(() => h.rows().length === 3);
  assert.equal(h.document.querySelector('.je-home-rows').previousElementSibling.className, 'je-chipbar');
  // With the chip bar and My Media: the chip bar keeps its place at the top, the rows follow My Media.
  const both = setup(t, { home: `<div class="je-chipbar"></div>${MY_MEDIA}`, routes: path => (path === '/acquire/home' ? ok(answer()) : null) });
  await until(() => both.rows().length === 3);
  assert.equal(both.container().firstElementChild.className, 'je-chipbar');
  assert.equal(both.document.querySelector('.je-home-rows').previousElementSibling.className, 'verticalSection section0');
  const off = setup(t, { routes: () => ({ status: 404, body: { outcome: 'refused', reason: 'disabled' } }) });
  await until(() => off.homeReads().length);
  await wait(100);
  assert.equal(off.document.querySelector('.je-home-rows'), null);
});

test('repeated views mount one copy only, reading once per view with If-None-Match', async t => {
  const h = setup(t, { routes: (path, headers) => (path === '/acquire/home' ? (headers['If-None-Match'] === '"v1"' ? { status: 304 } : ok(answer())) : null) });
  await until(() => h.rows().length === 3);
  assert.equal(h.homeReads()[0].headers['If-None-Match'], undefined);
  h.viewshow();
  h.viewshow();
  h.navigate('#/home?tab=0');
  await until(() => h.homeReads().length >= 2);
  await wait(500);
  assert.equal(h.document.querySelectorAll('.je-home-rows').length, 1);
  assert.equal(h.document.querySelectorAll('.je-home-row').length, 3);
  assert.equal(h.homeReads().length, 2, 'one read for the burst of views');
  assert.equal(h.homeReads()[1].headers['If-None-Match'], '"v1"');
  // Jellyfin drawing its sections again takes the rows with them: they come back, still once.
  h.container().innerHTML = MY_MEDIA;
  await until(() => h.document.querySelector('.je-home-rows'));
  assert.equal(h.document.querySelectorAll('.je-home-rows').length, 1);
  assert.equal(h.document.querySelector('.je-home-rows').previousElementSibling.className, 'verticalSection section0');
});

test('an answer that arrives after leaving home is dropped, and leaving home takes the rows away', async t => {
  let gate = null;
  const h = setup(t, { routes: async path => {
    if (path !== '/acquire/home') return null;
    if (gate) await gate.promise;
    return ok(answer());
  } });
  await until(() => h.rows().length === 3);
  h.navigate('#/details?id=' + ID('f'));
  assert.equal(h.document.querySelector('.je-home-rows'), null, 'gone when leaving home');
  assert.equal(h.live().length, 0, 'no feed after leaving');
  gate = deferred();
  h.navigate('#/home');
  await until(() => h.homeReads().length === 2);
  h.navigate('#/list?type=movies');
  gate.resolve();
  await wait(200);
  assert.equal(h.document.querySelector('.je-home-rows'), null, 'stale answer not drawn');
  assert.ok(h.homeReads()[1].signal.aborted, 'the read in flight was aborted');
});

test('a user switch takes the rows away at once and reads again for the new user', async t => {
  const second = 'fedcba9876543210fedcba9876543210';
  const h = setup(t, { routes: (path, headers) => {
    if (path !== '/acquire/home') return null;
    return ok(h?.whoAsked === second ? answer({ requests: null, soon: null }) : answer());
  } });
  await until(() => h.rows().length === 3);
  h.whoAsked = second;
  h.switchUser(second);
  assert.equal(h.document.querySelector('.je-home-rows'), null);
  await until(() => h.homeReads().length === 2 && h.rows().length === 1);
  assert.deepEqual(h.rows(), ['arrived']);
  assert.equal(h.homeReads()[1].headers['If-None-Match'], undefined, 'no entity tag from the other user');
  assert.ok(h.live().some(s => s.keys.includes(`req:u:${second}`)));
});

const HSS_HOME = `<div id="hssLoadingIndicator" class="verticalSection"></div>
  <div class="verticalSection MyMedia section0" data-page="1" style="order: 0">My Media</div>
  <div class="verticalSection JellyfinEnhancedYourRequests section1" data-page="1" style="order: 1">
    <div class="sectionTitleContainer"><h2 class="sectionTitle">Your requests</h2></div>
    <div class="itemsContainer">
      <div class="card overflowPortraitCard" data-id="${ID('a')}" data-type="Movie"><div class="cardBox"><div class="cardScalable"><div class="cardPadder"></div></div><div class="cardText cardText-first">Andor Film</div><div class="cardText cardText-secondary">2026</div></div></div>
      <div class="card overflowPortraitCard" data-id="${ID('7')}" data-type="Movie"><div class="cardBox"><div class="cardScalable"></div><div class="cardText cardText-first">Someone else</div></div></div>
    </div>
  </div>
  <div class="verticalSection JellyfinEnhancedJustArrived section2" data-page="1" style="order: 2">
    <div class="itemsContainer"><div class="card" data-id="${ID('d')}"><div class="cardBox"><div class="cardScalable"></div><div class="cardText cardText-first">Dune</div></div></div></div>
  </div>
  <div class="verticalSection LatestMovies section3" data-page="1" style="order: 3">Latest</div>`;

test('on a home drawn by Home Screen Sections with the rows registered there, nothing is injected and the JE sections are decorated by hssId', async t => {
  const h = setup(t, { home: HSS_HOME, config: { ArrHomeHssSections: true }, routes: path => (path === '/acquire/home' ? ok(answer({ hss: true })) : null) });
  h.JE.currentSettings = { genreTagsEnabled: true, qualityTagsEnabled: true };
  await until(() => h.document.querySelector('.je-home-hss-card'));
  assert.ok(h.document.querySelector('.je-home-overlay').classList.contains('je-home-overlay-bottom-left'), 'a corner the poster tags leave free');
  await wait(100);
  assert.equal(h.document.querySelector('.je-home-rows'), null, 'no JE rows on an HSS home');
  const andor = h.document.querySelector(`.card[data-id="${ID('a')}"]`);
  assert.ok(andor.querySelector('.cardScalable > .je-home-overlay .je-arr-ring'), 'ring inside cardScalable');
  assert.equal(andor.querySelector('.je-home-line').textContent, 'Downloading');
  assert.ok(andor.querySelector('.cardText-secondary:not(.je-home-line)').classList.contains('je-home-replaced'));
  assert.equal(h.document.querySelector(`.card[data-id="${ID('7')}"]`), null, 'stale HSS card removed');
  const dune = h.document.querySelector(`.card[data-id="${ID('d')}"]`);
  assert.equal(dune.querySelector('.je-home-pill-new').textContent, 'New');
  assert.equal(dune.querySelector('.je-home-line').textContent, '2024');

  // HSS draws the section again (new card elements): decorated again, once.
  const items = h.document.querySelector('.JellyfinEnhancedYourRequests .itemsContainer');
  items.innerHTML = `<div class="card" data-id="${ID('a')}"><div class="cardBox"><div class="cardScalable"></div><div class="cardText cardText-first">Andor Film</div></div></div>`;
  await until(() => items.querySelector('.je-home-overlay'));
  await wait(150);
  assert.equal(items.querySelectorAll('.card[data-id]').length, 3, 'the full current row is reconciled after HSS redraws');
  assert.equal(items.querySelector(`[data-id="${ID('a')}"]`).querySelectorAll('.je-home-overlay').length, 1);
  assert.equal(items.querySelector(`[data-id="${ID('a')}"]`).querySelectorAll('.je-home-line').length, 1);
});

test('with HSS installed but not drawn yet, JE waits for it instead of injecting, then decorates', async t => {
  const h = setup(t, { home: '', config: { ArrHomeHssSections: true }, routes: path => (path === '/acquire/home' ? ok(answer({ hss: true })) : null) });
  await until(() => h.homeReads().length);
  await wait(200);
  assert.equal(h.document.querySelector('.je-home-rows'), null);
  h.container().innerHTML = HSS_HOME;
  await until(() => h.document.querySelector('.je-home-hss-card'));
  assert.equal(h.document.querySelector('.je-home-rows'), null);
});

test('when the rows are not HSS sections (hss false), they are injected on an HSS home after its first section', async t => {
  const h = setup(t, { home: HSS_HOME, globals: { HssPageMeta: { Page: 1 } }, routes: path => (path === '/acquire/home' ? ok(answer({ hss: false })) : null) });
  await until(() => h.rows().length === 3);
  const wrap = h.document.querySelector('.je-home-rows');
  assert.ok(wrap.previousElementSibling.classList.contains('MyMedia'));
  assert.equal(wrap.style.order, '0', 'same order as the section it follows');
  assert.equal(h.document.querySelector('.je-home-hss-card'), null, 'no decoration');
});

test('the ops strip shows when actionable, links to Overview, hides when not, and follows admin:ops', async t => {
  let ops = { actionable: true, downloading: 6, importBlocked: 1, attention: 0, disks: [{ name: '/movies4k', usedPercent: 94 }] };
  const h = setup(t, { config: { ArrRequestsHubEnabled: true }, routes: path => {
    if (path === '/acquire/home') return ok(answer({ ops: true }));
    if (path === '/arr/admin/home/ops') return { status: 200, body: ops };
    return null;
  } });
  await until(() => h.document.querySelector('.je-home-ops'));
  const link = h.document.querySelector('.je-home-ops-link');
  assert.equal(link.getAttribute('href'), '#/requests?tab=overview');
  assert.deepEqual([...link.querySelectorAll('.je-home-ops-part span:last-child')].map(n => n.textContent), ['6 downloading', '1 import blocked', '/movies4k 94%']);
  assert.equal(h.document.querySelector('.je-home-rows').firstElementChild.className, 'je-home-ops', 'above the rows');
  assert.ok(h.live().some(s => s.keys.includes('admin:ops')));
  ops = { actionable: false, downloading: 2, importBlocked: 0, attention: 0, disks: [] };
  h.bump('admin:ops');
  await until(() => !h.document.querySelector('.je-home-ops'));
  assert.equal(h.opsReads().length, 2);
  assert.equal(h.rows().length, 3, 'rows stay');
});

test('no ops read and no strip when the answer says ops false', async t => {
  const h = setup(t, { routes: path => (path === '/acquire/home' ? ok(answer()) : { status: 200, body: { actionable: true, downloading: 3 } }) });
  await until(() => h.rows().length === 3);
  await wait(100);
  assert.equal(h.opsReads().length, 0);
  assert.equal(h.document.querySelector('.je-home-ops'), null);
  assert.ok(!h.live().some(s => s.keys.includes('admin:ops')));
});

test('live: the card keys and own keys are followed; a burst of changes reads the one route once, and changes show', async t => {
  let body = answer();
  const h = setup(t, { routes: (path, headers) => {
    if (path !== '/acquire/home') return null;
    return headers['If-None-Match'] === `"${JSON.stringify(body).length}"` ? { status: 304 } : ok(body, `"${JSON.stringify(body).length}"`);
  } });
  await until(() => h.rows().length === 3);
  const keys = h.live().flatMap(s => s.keys);
  for (const key of ['movie:tmdb:1', 'tv:tvdb:2', 'tv:tvdb:3', 'movie:tmdb:4', 'tv:tvdb:5:s9:e5', `req:u:${USER}`, `ntf:u:${USER}`, 'req:state']) assert.ok(keys.includes(key), key);
  assert.equal(JSON.stringify(h.live()[0].opts), JSON.stringify({ since: { epoch: 'e1', cursor: 1 } }));
  body = answer({ requests: [{ ...answer().requests[0], status: { ...answer().requests[0].status, progress: { percent: 80 } } }] });
  h.bump('movie:tmdb:1');
  h.bump(`req:u:${USER}`);
  h.bump('req:state');
  await until(() => h.document.querySelector('.je-arr-ring-text')?.textContent === '80');
  await wait(400);
  assert.equal(h.homeReads().length, 2, 'one read for the burst');
  assert.equal(h.fetches.filter(f => f.path !== '/acquire/home').length, 0, 'never one call per card');
  assert.equal(h.document.querySelectorAll('.je-home-row-requests .je-home-card').length, 1);
});

test('hidden titles stay off the rows when Hidden Content filters requests', async t => {
  const h = setup(t, { routes: path => (path === '/acquire/home' ? ok(answer()) : null) });
  h.JE.hiddenContent = { getSettings: () => ({ enabled: true, filterRequests: true }), getAllHiddenItems: () => [{ itemId: ID('d'), hideScope: 'global' }, { tmdbId: 1, type: 'Movie' }] };
  await until(() => h.rows().length === 3);
  assert.deepEqual([...h.document.querySelectorAll('.je-home-card .cardText-first')].map(n => n.textContent), ['Peacemaker', 'Asked Film', 'Severance', 'The Flash']);
});

test('with the home rows off the module reads nothing and draws nothing', async t => {
  const h = setup(t, { config: { ArrHomeRowsEnabled: false }, routes: () => ok(answer()) });
  h.viewshow();
  await wait(700);
  assert.equal(h.fetches.length, 0);
  assert.equal(h.document.querySelector('.je-home-rows'), null);
  assert.equal(h.JE.arrHome.state.started, false);
});

test('logout clears the rows and never starts an anonymous home read', async t => {
  const h = setup(t, { routes: path => path === '/acquire/home' ? ok(answer()) : null });
  await until(() => h.rows().length === 3);
  const before = h.homeReads().length;
  h.switchUser(null);
  await wait(600);
  assert.equal(h.rows().length, 0);
  assert.equal(h.homeReads().length, before);
});

for (const change of ['add', 'remove', 'empty', 'opt-out', 'return']) {
  test(`HSS reconciles ${change} against a fresh answer without navigation or an observer loop`, async t => {
    let data = answer({ hss: true });
    const h = setup(t, { home: HSS_HOME, config: { ArrHomeHssSections: true }, routes: path => path === '/acquire/home' ? ok(data) : null });
    await until(() => h.document.querySelector('.je-home-hss-card'));
    const section = h.document.querySelector('.JellyfinEnhancedYourRequests');
    const added = { ...data.requests[0], key: 'movie:tmdb:6', title: 'New arrival', hssId: ID('6') };
    if (change === 'add') data = { ...data, requests: [...data.requests, added] };
    if (change === 'remove') data = { ...data, requests: data.requests.slice(1) };
    if (change === 'empty' || change === 'return') data = { ...data, requests: [] };
    if (change === 'opt-out') data = { ...data, requests: null };
    await h.JE.arrHome.refresh({ fresh: true });
    if (change === 'return') {
      data = { ...data, requests: [added] };
      await h.JE.arrHome.refresh({ fresh: true });
    }
    const expected = (data.requests || []).map(c => c.hssId);
    assert.deepEqual([...section.querySelectorAll('.card[data-id]')].map(c => c.dataset.id), expected);
    assert.equal(section.hidden || section.classList.contains('hide') || section.style.display === 'none', expected.length === 0);
    await wait(250);
    assert.equal(h.homeReads().length, change === 'return' ? 3 : 2, 'no self-triggered reads');
    assert.equal(h.document.querySelector('.je-home-rows'), null);
  });
}
