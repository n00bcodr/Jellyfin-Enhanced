// Requests & downloads, phase 3: asking from the client (ask-core.js) and missing episodes on season
// pages (ask-episodes.js): Get it on missing rows, JE-drawn rows for episodes Jellyfin has no row for,
// Jellyfin's own missing rows decorated, Get them on the banner, honest outcomes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createHarness, jsRoot, jsonResponse } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const MODULES = ['arr/status/status-core.js', 'arr/status/status-episodes.js', 'arr/status/status-details.js', 'arr/status/status-styles.js',
  'core/mutation-queue.js', 'arr/ask/ask-core.js', 'arr/ask/ask-episodes.js', 'arr/ask/ask-styles.js'];

function translate(key, params) {
  const text = en[key];
  if (text === undefined) throw new Error(`missing en.json key ${key}`);
  return Object.entries(params || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
}

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await nextTurn(); };
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

const ID = n => `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa${n}`;
const SEASON_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1';

function row(n, { virtual = false, phone = false } = {}) {
  return `<div class="listItem" data-type="Episode" data-id="${ID(n)}"><div class="listItem-content"><div class="listItemImage"></div>`
    + `<div class="listItemBody"><div class="listItemBodyText"><bdi>${n}. Ep ${n}</bdi></div>`
    + `<div class="listItemMediaInfo"${phone ? ' style="display:none"' : ''}>${virtual ? '<div class="missingIndicator">Missing</div>' : '<div class="mediaInfoItem">45m</div>'}</div></div></div>`
    + `${phone ? '<div class="listItem-bottomoverview"></div>' : ''}</div>`;
}

function page(rows) {
  return '<div id="itemDetailPage" class="page libraryPage"><div class="detailPagePrimaryContent"><div class="detailSection"></div></div>'
    + `<div id="childrenContent"><div class="itemsContainer">${rows}</div></div></div>`;
}

/** A season status: E1 ready (row), E2 missing and not monitored (row only when virtual), E3 downloading (no row), E4 missing (no row). */
function season({ e2row = false } = {}) {
  return {
    key: 'tv:tvdb:1:s1', itemId: SEASON_ID, kind: 'season', stage: 'downloading', reason: { code: 'downloading' },
    summary: { aired: 4, ready: 1, downloading: 1, missing: 2, attention: 0 },
    episodes: [
      { key: 'tv:tvdb:1:s1:e1', season: 1, episode: 1, itemId: ID(1), row: true, stage: 'ready', reason: { code: 'ready' } },
      { key: 'tv:tvdb:1:s1:e2', season: 1, episode: 2, itemId: e2row ? ID(2) : null, row: e2row, stage: 'notHere', reason: { code: 'unmonitored' } },
      { key: 'tv:tvdb:1:s1:e3', season: 1, episode: 3, row: false, stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 60 } },
      { key: 'tv:tvdb:1:s1:e4', season: 1, episode: 4, row: false, stage: 'notHere', reason: { code: 'unmonitored' }, airDate: '2014-06-22T00:00:00Z' }
    ]
  };
}

function rowsBody({ displayMissing = true, canRequest = true, requests = {}, seasonRequest = null, blocked = null } = {}) {
  return {
    outcome: 'accepted', reason: 'season', certainty: 'Succeeded', message: 'Season',
    rows: {
      key: 'tv:tvdb:1:s1', series: 'tv:tvdb:1', season: 1, seriesId: 'ccccccccccccccccccccccccccccccc1', displayMissing, canRequest, seasonRequest, blocked,
      episodes: [
        { episode: 1, request: requests[1] || null },
        { episode: 2, title: 'Two', overview: 'Second one.', runtime: 44, airDate: '2014-06-08', still: '/b2.jpg', request: requests[2] || null },
        { episode: 3, title: 'Three', overview: 'Third one.', runtime: 43, airDate: '2014-06-15', still: '/c3.jpg', request: requests[3] || null },
        { episode: 4, title: 'Four', overview: 'Fourth one.', runtime: 42, airDate: '2014-06-22', still: 'https://evil.example/x.jpg', request: requests[4] || null }
      ]
    }
  };
}

function setup(t, { rows = row(1), status = season(), config = {}, server = {}, spoiler = false, html = null, observe = null } = {}) {
  const posts = [];
  const searches = [];
  const gets = [];
  const toasts = [];
  const bodyObservers = [];
  const userChange = [];
  const navigations = [];
  let epoch = 0;
  let shownStatus = status;
  let rowsAnswer = server.rows || (() => rowsBody());
  const h = createHarness({
    html: html ?? page(rows),
    url: `http://jellyfin.test/web/index.html#/details?id=${SEASON_ID}`,
    fetch: async (url, init = {}) => {
      const path = String(url).replace('http://jellyfin.test/JellyfinEnhanced', '');
      if ((init.method || 'GET') === 'POST' && path === '/acquire/requests/search') {
        // Search for something no request sent yet: the server says to ask instead (unless a test answers).
        const body = JSON.parse(init.body);
        searches.push({ path, body });
        const answer = server.search ? server.search(body, searches.length) : { status: 200, body: { outcome: 'skipped', reason: 'not_requested', certainty: 'Rejected', message: 'Nothing was asked for here yet.' } };
        if (answer instanceof Error) throw answer;
        return jsonResponse(answer.body, answer.status);
      }
      if ((init.method || 'GET') === 'POST') {
        const body = JSON.parse(init.body);
        posts.push({ path, body });
        const answer = server.post ? server.post(path, body, posts.length) : { status: 201, body: { outcome: 'accepted', reason: 'awaiting_approval', certainty: 'Succeeded', message: 'Asked!', requestId: 'f'.repeat(32) } };
        if (answer instanceof Error) throw answer;
        return jsonResponse(answer.body, answer.status);
      }
      gets.push(path);
      if (path.startsWith('/acquire/requests/season/')) {
        const answer = rowsAnswer(gets.length, path);
        if (answer instanceof Error) throw answer;
        return jsonResponse(answer);
      }
      if (path === '/acquire/requests/me' && server.meGate) await server.meGate();
      if (path === '/acquire/requests/me') return jsonResponse({ outcome: 'accepted', me: server.me || { role: 'kid', canRequest: true, contact: 'Dad', asksFirst: true } });
      if (path.startsWith('/acquire/requests/quota')) return jsonResponse({ outcome: 'accepted', quota: { used: 7, limit: 7, remaining: 0, nextSlotAt: null } });
      throw new Error(`unexpected GET ${path}`);
    },
    JE: {
      pluginConfig: { ArrStatusEnabled: true, ArrRequestsEnabled: true, ...config },
      t: translate,
      toast: html => toasts.push(html),
      escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
      spoilerBlur: spoiler ? { isEnabledFor: id => id === 'ccccccccccccccccccccccccccccccc1' } : undefined,
      helpers: {
        debounce: fn => fn,
        addCSS: (id, css) => { const s = h.document.createElement('style'); s.id = id; s.textContent = css; h.document.head.appendChild(s); },
        onBodyMutation: (id, fn) => { bodyObservers.push(fn); if (observe) observe(fn, h.window, h.document); return { unsubscribe() {} }; }
      },
      core: {
        api: { plugin: async () => ({ contact: 'Dad', items: [shownStatus] }) },
        navigation: {
          onNavigate: (fn) => { navigations.push(fn); return () => { const at = navigations.indexOf(fn); if (at >= 0) navigations.splice(at, 1); }; },
          onViewPage: () => () => {}
        },
        lifecycle: { register: () => ({ track: x => x }) }
      },
      session: { getEpoch: () => epoch, isCurrent: () => true, onUserChange: (k, fn) => userChange.push(fn) }
    }
  });
  t.after(() => h.close());
  for (const m of MODULES) h.load(m);
  h.JE.initializeArrStatus();
  return {
    ...h, posts, searches, gets, toasts, userChange,
    setRows(fn) { rowsAnswer = fn; },
    setStatus(next) { shownStatus = next; },
    /** Moves to another hash and tells the navigation listeners. */
    navigate(hash) { h.window.location.hash = hash; [...navigations].forEach(fn => fn()); },
    /** Someone else signs in (the session epoch changes and the user-change hooks run). */
    switchUser() { epoch++; userChange.forEach(fn => fn()); },
    async open() { await h.JE.internals.arrStatusDetails.update(false); await settle(); },
    list() { return h.document.querySelector('.itemsContainer'); },
    episodes() { return [...this.list().children].map(r => r.dataset.jeAskEpisode ? `JE${r.dataset.jeAskEpisode}` : `N${r.dataset.id.slice(-1)}`); }
  };
}

/**
 * A status with one episode's stage changed: what the server says for an episode a request covers (OK'd and on its way:
 * approved; sent and the arr looking: looking). An episode left "not here" with a request on it is one nobody fetches.
 */
function withEpisode(status, episode, stage, code) {
  return { ...status, episodes: status.episodes.map(e => (e.episode === episode ? { ...e, stage, reason: { code } } : e)) };
}

test('ask-core maps every request outcome to an honest family state and words', t => {
  const h = setup(t);
  const A = h.JE.arrAsk;
  const state = (status, body) => A.interpret(status, body).state;
  assert.equal(state(201, { outcome: 'accepted', reason: 'awaiting_approval' }), 'waiting');
  assert.equal(state(201, { outcome: 'accepted', reason: 'over_quota' }), 'waiting');
  assert.equal(state(201, { outcome: 'accepted', reason: 'queued_outage' }), 'asked');
  // An ask split at the series threshold: the part under it went ahead, the named seasons wait for an OK.
  const split = A.interpret(201, { outcome: 'split', reason: 'queued_outage', requestId: 'a', heldRequestId: 'b', heldSeasons: [6, 5] });
  assert.equal(split.state, 'split');
  assert.equal(A.describe(split, { contact: 'Dad' }).chip, 'Asked!');
  assert.equal(A.describe(split, { contact: 'Dad' }).text, "Asked! The rest (Seasons 5–6) is over the household's series limit and waits for Dad to OK it.");
  assert.equal(A.describe(A.interpret(200, { outcome: 'split', reason: 'queued_outage', heldSeasons: [7] }), {}).text, "Asked! The rest (Season 7) is over the household's series limit and waits for the admin to OK it.");
  assert.equal(state(200, { outcome: 'merged', reason: 'looking' }), 'merged');
  assert.equal(state(200, { outcome: 'nothing_to_request', reason: 'nothing_to_request' }), 'nothing');
  assert.equal(state(202, { outcome: 'maybe_sent', certainty: 'Unknown' }), 'unknown');
  assert.equal(state(429, { outcome: 'quota_exceeded', reason: 'quota_exceeded' }), 'quota');
  assert.equal(state(403, { outcome: 'blocked', reason: 'decline_cooldown' }), 'blocked');
  assert.equal(state(403, { outcome: 'denied', reason: 'requests_create_required' }), 'denied');
  assert.equal(state(409, { reason: 'idempotency_conflict' }), 'changed');
  assert.equal(state(409, { reason: 'request_in_flight' }), 'busy');
  assert.equal(state(503, { outcome: 'unavailable' }), 'unavailable');
  assert.equal(state(400, { reason: 'invalid_input' }), 'invalid');
  const caps = { contact: 'Dad' };
  assert.equal(A.describe({ state: 'waiting', reason: 'awaiting_approval' }, caps).text, 'Asked! Dad will take a look.');
  assert.equal(A.describe({ state: 'waiting', reason: 'awaiting_approval' }, caps).chip, 'Waiting for OK');
  assert.equal(A.describe({ state: 'waiting', reason: 'over_quota' }, caps).text, "Sent to Dad for an OK (you've used this week's requests).");
  assert.equal(A.describe({ state: 'asked' }, caps).chip, 'Asked!');
  assert.equal(A.describe({ state: 'merged' }, caps).text, "Someone in your household already asked, we'll tell you both.");
  assert.equal(A.describe({ state: 'unknown' }, caps).text, "Asked! We'll confirm shortly.");
  assert.equal(A.describe({ state: 'blocked', reason: 'decline_cooldown' }, caps).text, 'Dad said no to this one recently. You can ask again later.');
  assert.equal(A.describe({ state: 'failed' }, {}).text, "Couldn't ask right now. Try again later.");
  assert.equal(A.describe({ state: 'waiting', reason: 'awaiting_approval' }, {}).text, 'Asked! the admin will take a look.');
  for (const s of ['quota', 'denied', 'changed', 'busy', 'gone', 'unavailable', 'invalid']) {
    assert.ok(!/Asked/.test(A.describe({ state: s }, caps).text), `${s} never claims it was asked`);
    assert.equal(A.describe({ state: s }, caps).chip, '', `${s} shows no state chip`);
  }
  same(A.episodesInput('tv:tvdb:1:s1', [{ season: 1, episode: 4 }]), { key: 'tv:tvdb:1', scope: 'episodes', variant: 'standard', seasons: [], episodes: [{ season: 1, episode: 4 }] });
  same(A.seasonsInput('tv:tvdb:1', [3, 1, 3]), { key: 'tv:tvdb:1', scope: 'seasons', variant: 'standard', seasons: [1, 3], episodes: [] });
});

test('a retry after a lost answer reuses the clientRequestId; a definitive answer ends it', async t => {
  let mode = 'network';
  const h = setup(t, {
    server: {
      post: () => mode === 'network' ? new TypeError('Failed to fetch')
        : mode === '503' ? { status: 503, body: { outcome: 'unavailable', reason: 'database_unavailable' } }
          : { status: 201, body: { outcome: 'accepted', reason: 'queued_outage', requestId: 'a'.repeat(32) } }
    }
  });
  const A = h.JE.arrAsk;
  const changes = [];
  A.onChange(c => changes.push(c.type));
  const input = A.movieInput('movie:tmdb:603');
  assert.equal((await A.ask(input)).state, 'failed');
  mode = '503';
  assert.equal((await A.ask({ ...input })).state, 'unavailable');
  mode = 'ok';
  const done = await A.ask(input);
  assert.equal(done.state, 'asked');
  const ids = h.posts.map(p => p.body.clientRequestId);
  assert.equal(new Set(ids).size, 1, 'the same ask kept its id through a network failure and a 503');
  await A.ask(input);
  assert.notEqual(h.posts[3].body.clientRequestId, ids[0], 'a new ask after the definitive answer gets a new id');
  same(changes, ['ask', 'ask']);
  // A user switch forgets open ids.
  mode = 'network';
  await A.ask(A.movieInput('movie:tmdb:1'));
  h.userChange.forEach(fn => fn());
  await A.ask(A.movieInput('movie:tmdb:1'));
  assert.notEqual(h.posts[4].body.clientRequestId, h.posts[5].body.clientRequestId);
});

test('rows mode: JE draws native-looking rows for missing episodes Jellyfin has no row for, in order, and no banner', async t => {
  const h = setup(t);
  await h.open();
  same(h.episodes(), ['N1', 'JE2', 'JE3', 'JE4']);
  assert.equal(h.document.querySelector('.je-arr-banner'), null, 'never both rows and the banner');
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  assert.ok(two.classList.contains('listItem'), 'looks like the native rows');
  assert.equal(two.querySelector('.je-ask-row-title bdi').textContent, '2. Two');
  same([...two.querySelectorAll('.mediaInfoItem')].map(n => n.textContent).slice(0, 1), ['44m']);
  assert.equal(two.querySelector('.je-arr-chip').textContent, 'Missing');
  assert.equal(two.querySelector('.je-ask-get').textContent, 'addGet it');
  assert.ok(two.classList.contains('je-ask-dim'), 'missing thumbnail is dimmed');
  assert.match(two.querySelector('.listItemImage').style.backgroundImage, /image\.tmdb\.org\/t\/p\/w300\/b2\.jpg/);
  assert.equal(two.querySelector('.listItem-overview').textContent, 'Second one.');
  // E3 downloads: ring on the thumbnail, its chip stays, no Get it, not dimmed.
  const three = h.list().querySelector('.je-ask-row[data-je-ask-episode="3"]');
  assert.equal(three.querySelector('.je-arr-chip').textContent, 'Downloading 60%');
  assert.equal(three.querySelector('.je-ask-get'), null);
  assert.ok(!three.classList.contains('je-ask-dim'));
  assert.equal(three.querySelector('.listItemImage .je-ask-ring').getAttribute('aria-label'), 'Downloading 60%');
  // E4: an unmonitored episode is "Missing" with Get it; a foreign image URL is never used.
  const four = h.list().querySelector('.je-ask-row[data-je-ask-episode="4"]');
  assert.equal(four.querySelector('.je-arr-chip').textContent, 'Missing');
  assert.equal(four.querySelector('.listItemImage').style.backgroundImage, '');
  // Clicks inside a JE row never reach Jellyfin's list handlers.
  let reached = 0;
  h.list().addEventListener('click', () => reached++);
  four.querySelector('.listItem-content').click();
  assert.equal(reached, 0);
  // One read of the season rows.
  assert.equal(h.gets.filter(p => p.startsWith('/acquire/requests/season/')).length, 1);
  assert.match(h.gets[0], /^\/acquire\/requests\/season\/b+1\?language=/);
});

test('Get it asks for that one episode and the chip says what the server answered', async t => {
  const h = setup(t, {
    server: { post: () => ({ status: 201, body: { outcome: 'accepted', reason: 'awaiting_approval', certainty: 'Succeeded', message: 'Asked!', requestId: 'f'.repeat(32) } }) }
  });
  await h.open();
  h.setRows(() => rowsBody({ requests: { 2: 'waiting' } }));
  h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get').click();
  await settle(20);
  assert.equal(h.posts.length, 1);
  same(h.posts[0].body.input, { key: 'tv:tvdb:1', scope: 'episodes', variant: 'standard', seasons: [], episodes: [{ season: 1, episode: 2 }] });
  assert.match(h.posts[0].body.clientRequestId, /\S{8,}/);
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  assert.equal(two.querySelector('.je-arr-chip').textContent, 'Waiting for OK');
  assert.equal(two.querySelector('.je-ask-get'), null, 'no second ask from the same row');
  same(h.toasts, ['Asked! Dad will take a look.']);
  assert.ok(h.gets.filter(p => p.startsWith('/acquire/requests/season/')).length >= 2, 'the season is read again after the ask');
  // The other missing episode still offers Get it.
  assert.ok(h.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-ask-get'));
});

test('a refused or failed ask keeps Get it and says so honestly', async t => {
  let answer = { status: 429, body: { outcome: 'quota_exceeded', reason: 'quota_exceeded', certainty: 'Rejected' } };
  const h = setup(t, { server: { post: () => answer } });
  await h.open();
  h.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-ask-get').click();
  await settle(20);
  const four = h.list().querySelector('.je-ask-row[data-je-ask-episode="4"]');
  assert.equal(four.querySelector('.je-arr-chip').textContent, 'Missing');
  assert.ok(four.querySelector('.je-ask-get:not([disabled])'), 'Get it is back');
  assert.equal(h.toasts.at(-1), "You've used this week's requests.");
  answer = new TypeError('Failed to fetch');
  four.querySelector('.je-ask-get').click();
  await settle(20);
  assert.equal(h.toasts.at(-1), "Couldn't ask right now. Try again later.");
  assert.equal(h.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-arr-chip').textContent, 'Missing');
});

test('Jellyfin\'s own missing row is decorated: one label, dimmed, runtime and date, Get it', async t => {
  const h = setup(t, { rows: row(1) + row(2, { virtual: true }), status: season({ e2row: true }) });
  await h.open();
  same(h.episodes(), ['N1', 'N2', 'JE3', 'JE4']);
  const native = h.list().querySelector(`.listItem[data-id="${ID(2)}"]`);
  assert.ok(native.classList.contains('je-ask-native-label-off'), "Jellyfin's own Missing label is replaced by the one chip");
  assert.ok(native.classList.contains('je-ask-dim'));
  assert.equal(native.querySelectorAll('.je-arr-chip').length, 1);
  assert.equal(native.querySelector('.je-arr-chip').textContent, 'Missing');
  assert.equal(native.querySelector('.je-arr-chip + .je-ask-get').dataset.jeAskEpisode, '2');
  same([...native.querySelectorAll('.je-ask-meta')].map(n => n.textContent).slice(0, 1), ['44m']);
  // Re-applying (Jellyfin re-rendering) is idempotent.
  h.JE.internals.arrStatusEpisodes.apply();
  h.JE.internals.arrStatusEpisodes.apply();
  assert.equal(native.querySelectorAll('.je-ask-get').length, 1);
  assert.equal(native.querySelectorAll('.je-ask-meta').length, 2);
  assert.equal(h.list().querySelectorAll('.je-ask-row').length, 2);
  // A real episode row is never dimmed and never offers Get it.
  const real = h.list().querySelector(`.listItem[data-id="${ID(1)}"]`);
  assert.ok(!real.classList.contains('je-ask-dim'));
  assert.equal(real.querySelector('.je-ask-get'), null);
});

test('banner mode (missing episodes not shown as rows): states per episode and Get them for the rest', async t => {
  const h = setup(t, { status: withEpisode(season(), 2, 'looking', 'looking'), server: { rows: () => rowsBody({ displayMissing: false, requests: { 2: 'household' } }) } });
  await h.open();
  same(h.episodes(), ['N1'], 'no JE rows without the display setting');
  const banner = h.document.querySelector('.je-arr-banner');
  assert.equal(banner.querySelector('.je-arr-banner-title').textContent, 'Missing: E2, E4');
  const action = banner.querySelector('.je-ask-banner-action');
  same([...action.querySelectorAll('.je-arr-chip')].map(c => c.textContent), ['E2 · Someone asked']);
  const btn = action.querySelector('.je-ask-get');
  assert.equal(btn.textContent, 'downloadGet E4');
  assert.equal(btn.getAttribute('aria-label'), 'Get the missing episodes: E4');
  btn.click();
  await settle(20);
  same(h.posts[0].body.input.episodes, [{ season: 1, episode: 4 }]);
  assert.match(h.document.querySelector('.je-ask-banner-action').textContent, /E4 · Waiting for OK/);
});

test('a season that is not in the library at all: the banner lists it and leaves asking to Get Season N', async t => {
  const absent = {
    key: 'tv:tvdb:1:s1', itemId: SEASON_ID, kind: 'season', stage: 'notHere', reason: { code: 'not_in_arr' }, summary: { aired: 2 },
    episodes: [
      { key: 'tv:tvdb:1:s1:e2', season: 1, episode: 2, row: false, stage: 'notHere', reason: { code: 'not_in_arr' } },
      { key: 'tv:tvdb:1:s1:e4', season: 1, episode: 4, row: false, stage: 'notHere', reason: { code: 'not_in_arr' } }
    ]
  };
  const h = setup(t, { status: absent, server: { rows: () => rowsBody({ displayMissing: false }) } });
  h.JE.titleDetails = { isSynthetic: id => id === SEASON_ID };
  await h.open();
  const banner = h.document.querySelector('.je-arr-banner');
  assert.equal(banner.querySelector('.je-arr-banner-title').textContent, 'Missing: E2, E4');
  assert.equal(banner.querySelector('.je-ask-get'), null, 'Get Season 1 on the page asks for the season');
  // Once part of it was asked for, the rest is offered on the banner again.
  const partly = setup(t, { status: withEpisode(absent, 2, 'approved', 'approved'), server: { rows: () => rowsBody({ displayMissing: false, requests: { 2: 'asked' } }) } });
  partly.JE.titleDetails = { isSynthetic: id => id === SEASON_ID };
  await partly.open();
  assert.equal(partly.document.querySelector('.je-arr-banner .je-ask-get').textContent, 'downloadGet E4');
});

test('people who cannot ask see the rows and states but no Get it; with phase 3 off nothing changes', async t => {
  const watcher = setup(t, { server: { rows: () => rowsBody({ canRequest: false }) } });
  await watcher.open();
  same(watcher.episodes(), ['N1', 'JE2', 'JE3', 'JE4']);
  assert.equal(watcher.document.querySelector('.je-ask-get'), null);
  assert.equal(watcher.document.querySelector('.je-ask-paused, .je-ask-paused-note'), null, 'nothing to explain to someone whose role can\'t ask');
  assert.equal(watcher.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-arr-chip').textContent, 'Missing · not being fetched', 'the phase-1 wording stays');

  const off = setup(t, { config: { ArrRequestsEnabled: false } });
  await off.open();
  same(off.episodes(), ['N1']);
  assert.equal(off.gets.length, 0, 'no request of phase 3');
  assert.equal(off.document.querySelector('.je-arr-banner .je-arr-banner-title').textContent, 'Missing: E2, E4');
  assert.equal(off.document.querySelector('.je-ask-get'), null);
});

test('a failed season read brings the banner back; spoiler-protected series hide overviews', async t => {
  const failing = setup(t, { server: { rows: () => new TypeError('Failed to fetch') } });
  failing.allowConsoleError(/season rows unavailable/);
  await failing.open();
  assert.ok(failing.document.querySelector('.je-arr-banner'), 'banner when the rows cannot be read');
  same(failing.episodes(), ['N1']);

  const guarded = setup(t, { spoiler: true });
  await guarded.open();
  const two = guarded.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  assert.equal(two.querySelector('.listItem-overview'), null);
  assert.ok(two.querySelector('.listItemImage').classList.contains('je-ask-row-spoiler'));
});

test('the episode dialog shows the status and Get it, traps focus and gives it back', async t => {
  const h = setup(t);
  await h.open();
  const title = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-row-title');
  title.focus();
  title.click();
  const dialog = h.document.querySelector('.je-ask-dialog');
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.querySelector('.je-ask-dialog-title').textContent, '2. Two');
  assert.match(dialog.querySelector('.je-arr-pill-text').textContent, /Not being fetched/);
  assert.equal(dialog.getAttribute('aria-describedby'), null, 'nothing paused to read out');
  assert.equal(h.document.activeElement, dialog.querySelector('.je-ask-get'));
  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.document.querySelector('.je-ask-dialog'), null);
  assert.equal(h.document.activeElement, title);
});

/** The base season with E2 monitored and wanted a moment ago: Sonarr is looking for it right now. */
function freshLooking() {
  const status = season();
  Object.assign(status.episodes[1], { stage: 'looking', reason: { code: 'looking' } });
  return status;
}

test('an episode the arr is looking for right now: "Looking for it", dimmed and listed, but no Get it in its row, the banner or its dialog', async t => {
  const h = setup(t, { status: freshLooking() });
  await h.open();
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  assert.equal(two.querySelector('.je-arr-chip').textContent, 'Looking for it');
  assert.ok(two.querySelector('.je-arr-chip').classList.contains('je-arr-tone-looking'));
  assert.equal(two.querySelector('.je-ask-get'), null, 'nothing to ask for: Sonarr is on it');
  assert.ok(two.classList.contains('je-ask-dim'), 'still missing: dimmed');
  // E4 (not monitored) still offers Get it.
  assert.ok(h.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-ask-get'));
  two.querySelector('.je-ask-row-title').click();
  const dialog = h.document.querySelector('.je-ask-dialog');
  assert.match(dialog.querySelector('.je-arr-pill-text').textContent, /Looking for it/);
  assert.equal(dialog.querySelector('.je-ask-get'), null, 'the dialog offers nothing either');
  h.JE.internals.arrAskEpisodes.closeDialog();

  // Banner mode: listed as missing, its own chip says it is being looked for; Get E4 only.
  const banner = setup(t, { status: freshLooking(), server: { rows: () => rowsBody({ displayMissing: false }) } });
  await banner.open();
  const b = banner.document.querySelector('.je-arr-banner');
  assert.equal(b.querySelector('.je-arr-banner-title').textContent, 'Missing: E2, E4');
  same([...b.querySelectorAll('.je-ask-banner-action .je-arr-chip')].map(c => c.textContent), ['E2 · Looking for it']);
  assert.equal(b.querySelector('.je-ask-get').textContent, 'downloadGet E4');

  // Every missing episode is being looked for: one "Looking for it" for all of them, nothing to ask for.
  const allFresh = freshLooking();
  Object.assign(allFresh.episodes[3], { stage: 'looking', reason: { code: 'looking' } });
  const quiet = setup(t, { status: allFresh, server: { rows: () => rowsBody({ displayMissing: false }) } });
  await quiet.open();
  const qb = quiet.document.querySelector('.je-arr-banner');
  same([...qb.querySelectorAll('.je-ask-banner-action .je-arr-chip')].map(c => c.textContent), ['Looking for it']);
  assert.equal(qb.querySelector('.je-ask-get'), null);

  // Asking paused (storage full): nothing to explain on an episode nobody could ask for anyway.
  const paused = setup(t, { status: freshLooking(), server: { rows: () => rowsBody({ canRequest: false, blocked: { reason: 'storage_full' } }) } });
  await paused.open();
  const pausedTwo = paused.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  assert.equal(pausedTwo.querySelector('.je-arr-chip').textContent, 'Looking for it');
  assert.equal(pausedTwo.querySelector('.je-ask-paused'), null);
  assert.ok(paused.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-ask-paused'), 'E4 says why it can\'t be asked for now');
});

test('phones: the chip and Get it of a JE row move to their own line above the overview', async t => {
  const h = setup(t);
  await h.open();
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  two.querySelector('.listItemMediaInfo').style.display = 'none';
  h.JE.internals.arrStatusEpisodes.apply();
  const holder = two.querySelector('.je-arr-chip-row');
  assert.ok(holder);
  assert.equal(holder.nextElementSibling.className, 'listItem-bottomoverview secondary');
  same([...holder.children].map(c => c.className.split(' ')[0]), ['je-arr-chip', 'je-ask-get']);
});

test('TV layout: a JE row is one focusable button that opens the dialog; arrows stay inside the dialog', async t => {
  const h = setup(t);
  h.document.documentElement.classList.add('layout-tv');
  await h.open();
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  assert.equal(two.tagName, 'BUTTON');
  assert.ok(two.classList.contains('listItem-focusscale'));
  assert.equal(two.querySelector('button, .je-ask-get'), null, 'no buttons inside a TV row');
  assert.equal(h.document.querySelector('.je-ask-get'), null, 'Get it is never inside a row on TV');
  two.focus();
  two.click();
  const dialog = h.document.querySelector('.je-ask-dialog');
  const buttons = [...dialog.querySelectorAll('button')];
  assert.equal(h.document.activeElement, buttons[0]);
  assert.equal(buttons[0].className.split(' ')[0], 'je-ask-get');
  let jellyfinSaw = 0;
  h.window.addEventListener('keydown', () => jellyfinSaw++);
  h.document.activeElement.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(h.document.activeElement, buttons[1]);
  h.document.activeElement.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(h.document.activeElement, buttons[0], 'wraps around');
  assert.equal(jellyfinSaw, 0, 'the page behind never sees the arrows');
  buttons[0].click();
  await settle(20);
  assert.equal(h.posts.length, 1);
  same(h.posts[0].body.input.episodes, [{ season: 1, episode: 2 }]);
  assert.equal(h.document.querySelector('.je-ask-dialog'), null);
  assert.equal(h.document.activeElement.dataset.jeAskEpisode, '2', 'focus is back on the row');
});

// ------------------------------------------------------------------ Search (missing for a long while)

/** The season with E2 and E4 monitored and missing for a long while (nothing grabbed past LookingHours). */
function longMissing({ admin = false } = {}) {
  const status = season();
  for (const ep of status.episodes) {
    if (ep.episode === 2 || ep.episode === 4) {
      ep.stage = 'looking';
      ep.reason = { code: 'no_release_yet' };
    }
  }
  if (admin) {
    status.admin = {
      variants: [
        { instance: 'Sonarr 4K', instanceId: 'son4k', kind: 'Sonarr', role: '4k', stage: 'ready', reason: { code: 'ready' } },
        { instance: 'Sonarr', instanceId: 'son1', kind: 'Sonarr', role: 'standard', stage: 'downloading', reason: { code: 'downloading' } }
      ]
    };
  }
  return status;
}

const ADMIN_ME = { role: 'admin', canRequest: true, canApprove: true, contact: 'Dad', asksFirst: false };

test('missing for a long while: the pill says Missing without a journey; fresh ones keep Looking for it', t => {
  const h = setup(t);
  const S = h.JE.arrStatus;
  const journey = [{ stage: 'looking', state: 'current' }, { stage: 'downloading', state: 'next' }, { stage: 'ready', state: 'next' }];
  const old = S.buildPill({ key: 'tv:tvdb:1:s10:e1', stage: 'looking', reason: { code: 'no_release_yet' }, journey }, { contact: 'Dad' });
  assert.equal(old.querySelector('.je-arr-pill-text').textContent, 'Missing');
  assert.equal(old.querySelector('.je-arr-pill').tagName, 'DIV', 'no journey to open');
  assert.equal(old.querySelector('.je-arr-journey'), null);
  assert.ok(old.querySelector('.je-arr-pill').classList.contains('je-arr-tone-notHere'));
  const fresh = S.buildPill({ key: 'k', stage: 'looking', reason: { code: 'looking' }, journey }, { contact: 'Dad' });
  assert.equal(fresh.querySelector('.je-arr-pill-text').textContent, 'Looking for it');
  assert.equal(fresh.querySelector('.je-arr-pill').tagName, 'BUTTON');
  assert.ok(S.searchable({ stage: 'looking', reason: { code: 'no_release_yet' } }));
  assert.ok(!S.searchable({ stage: 'looking', reason: { code: 'no_release_yet' }, attention: true }));
  assert.ok(!S.searchable({ stage: 'notHere', reason: { code: 'unmonitored' } }), 'unmonitored stays Not being fetched');
  // The admin line says when the arr last searched.
  const lines = S.adminLines({ admin: { variants: [{ instance: 'Sonarr', stage: 'looking', reason: { code: 'no_release_yet' }, fix: 'search_now', since: new Date(Date.now() - 9 * 86400000).toISOString(), lastSearch: new Date(Date.now() - 3 * 3600000).toISOString() }] } });
  assert.match(lines[0].text, /^Sonarr · Monitored; still nothing grabbed · since .* · last searched 3 h ago$/);
});

test('rows: a long-missing episode gets Search instead of Get it; a Kid\'s Search asks for it and waits for an OK', async t => {
  const h = setup(t, { status: longMissing() });
  await h.open();
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  assert.equal(two.querySelector('.je-arr-chip').textContent, 'Missing');
  const btn = two.querySelector('.je-ask-get');
  assert.ok(btn.classList.contains('je-ask-search'));
  assert.equal(btn.querySelector('.je-ask-get-text').textContent, 'Search');
  assert.equal(btn.getAttribute('aria-label'), 'Search for episode 2: Two');
  h.setRows(() => rowsBody({ requests: { 2: 'waiting' } }));
  btn.click();
  await settle(20);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].path, '/acquire/requests');
  same(h.posts[0].body.input.episodes, [{ season: 1, episode: 2 }]);
  assert.equal(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-arr-chip').textContent, 'Waiting for OK');
  same(h.toasts, ['Asked! Dad will take a look.']);
});

test('rows: an administrator\'s Search runs the arr search for exactly that episode and says what it found', async t => {
  let found = false;
  const h = setup(t, {
    status: longMissing({ admin: true }),
    config: { ArrManageDrawerEnabled: true },
    server: {
      me: ADMIN_ME,
      post: (path) => (path === '/arr/admin/manage/search' ? { status: 200, body: { status: 'Succeeded', found, readBack: 'Search finished.' } } : { status: 500, body: {} })
    }
  });
  await h.open();
  h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get').click();
  await settle(20);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].path, '/arr/admin/manage/search');
  same({ instanceId: h.posts[0].body.instanceId, key: h.posts[0].body.key }, { instanceId: 'son1', key: 'tv:tvdb:1:s1:e2' }, 'the standard Sonarr, the episode only');
  assert.match(h.posts[0].body.idempotencyKey, /\S{8,}/);
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  assert.equal(two.querySelector('.je-ask-searched').textContent, 'Nothing found yet · searched just now');
  assert.equal(two.querySelector('.je-ask-get'), null, 'the outcome takes the button\'s place for a while');
  same(h.toasts, ['Nothing found yet · searched just now']);
  found = true;
  h.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-ask-get').click();
  await settle(20);
  assert.equal(h.posts[1].body.key, 'tv:tvdb:1:s1:e4');
  assert.equal(h.toasts.at(-1), 'Found a copy — downloading');
  assert.ok(!h.posts.some(p => p.path === '/acquire/requests'), 'an administrator\'s Search is not a request');
});

test('rows: someone else\'s Search on an episode a request already sent searches again (no new request) and says what it found; otherwise it asks', async t => {
  let answer = { status: 200, body: { outcome: 'accepted', reason: 'searched', certainty: 'Succeeded', message: 'Searched for it.', found: false } };
  const h = setup(t, { status: longMissing(), server: { rows: () => rowsBody({ requests: { 2: 'household' } }), search: () => answer } });
  await h.open();
  h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get').click();
  await settle(20);
  same(h.searches.map(s => s.body.key), ['tv:tvdb:1:s1:e2']);
  assert.match(h.searches[0].body.idempotencyKey, /\S{8,}/);
  same(h.posts, [], 'not a request');
  assert.equal(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-searched').textContent, 'Nothing found yet · searched just now');
  same(h.toasts, ['Nothing found yet · searched just now']);

  // Nothing sent for E4 yet: the server says so, and the Search asks for it like Get it.
  answer = { status: 200, body: { outcome: 'skipped', reason: 'not_requested', certainty: 'Rejected', message: 'Nothing was asked for here yet.' } };
  h.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-ask-get').click();
  await settle(20);
  assert.equal(h.searches.at(-1).body.key, 'tv:tvdb:1:s1:e4');
  assert.equal(h.posts.length, 1);
  same(h.posts[0].body.input.episodes, [{ season: 1, episode: 4 }]);
});

test('banner: someone else\'s Search searches the season again when requests sent all of it, with no new request', async t => {
  const h = setup(t, {
    status: longMissing(),
    server: {
      rows: () => rowsBody({ displayMissing: false }),
      search: () => ({ status: 200, body: { outcome: 'accepted', reason: 'searched', certainty: 'Succeeded', message: 'Searched for it.', found: false } })
    }
  });
  await h.open();
  h.document.querySelector('.je-arr-banner .je-ask-get').click();
  await settle(30);
  same(h.searches.map(s => s.body.key), ['tv:tvdb:1:s1'], 'one search for the season, not one per episode');
  same(h.posts, [], 'not a request');
  assert.equal(h.document.querySelector('.je-arr-banner .je-ask-searched').textContent, 'Nothing found yet · searched just now');
  same(h.toasts, ['Nothing found yet · searched just now']);
});

test('banner: someone else\'s Search searches again each episode a request sent and asks for the others', async t => {
  const h = setup(t, {
    status: longMissing(),
    server: {
      rows: () => rowsBody({ displayMissing: false }),
      search: (body) => (body.key.endsWith(':e2') ? { status: 200, body: { outcome: 'accepted', reason: 'searched', certainty: 'Succeeded', message: 'Found it.', found: true } } : { status: 200, body: { outcome: 'skipped', reason: 'not_requested', certainty: 'Rejected', message: 'Ask.' } })
    }
  });
  await h.open();
  h.document.querySelector('.je-arr-banner .je-ask-get').click();
  await settle(30);
  // The season as a whole first (not every episode was sent), then episode by episode.
  same(h.searches.map(s => s.body.key), ['tv:tvdb:1:s1', 'tv:tvdb:1:s1:e2', 'tv:tvdb:1:s1:e4']);
  assert.equal(h.posts.length, 1, 'one ask, for the episode no request sent');
  same(h.posts[0].body.input.episodes, [{ season: 1, episode: 4 }]);
  assert.ok(h.toasts.includes('Found a copy — downloading'));
});

test('rows: without the Manage drawer an administrator\'s Search asks like everyone else', async t => {
  const h = setup(t, { status: longMissing({ admin: true }), server: { me: ADMIN_ME } });
  await h.open();
  h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get').click();
  await settle(20);
  assert.equal(h.posts[0].path, '/acquire/requests');
});

test('banner: long-missing episodes get Search; an administrator\'s searches the season, a Kid\'s asks for them', async t => {
  const admin = setup(t, {
    status: longMissing({ admin: true }),
    config: { ArrManageDrawerEnabled: true },
    server: { me: ADMIN_ME, rows: () => rowsBody({ displayMissing: false }), post: () => ({ status: 200, body: { status: 'Succeeded', found: null } }) }
  });
  await admin.open();
  const btn = admin.document.querySelector('.je-arr-banner .je-ask-get');
  assert.equal(btn.querySelector('.je-ask-get-text').textContent, 'Search');
  assert.equal(btn.getAttribute('aria-label'), 'Search for the missing episodes: E2, E4');
  btn.click();
  await settle(20);
  same({ path: admin.posts[0].path, key: admin.posts[0].body.key }, { path: '/arr/admin/manage/search', key: 'tv:tvdb:1:s1' });
  assert.equal(admin.document.querySelector('.je-arr-banner .je-ask-searched').textContent, 'Searching…');
  assert.equal(admin.toasts.at(-1), 'Search started; it shows here when a copy turns up');

  const kid = setup(t, { status: longMissing(), server: { rows: () => rowsBody({ displayMissing: false }) } });
  await kid.open();
  kid.document.querySelector('.je-arr-banner .je-ask-get').click();
  await settle(20);
  same(kid.posts[0].body.input.episodes, [{ season: 1, episode: 2 }, { season: 1, episode: 4 }]);
});

// ------------------------------------------------------------------ review round 1

test('the banner is built once: re-applying the page keeps the banner, Get them and its focus (no rebuild loop)', async t => {
  let calls = 0;
  const h = setup(t, {
    server: { rows: () => rowsBody({ displayMissing: false }) },
    // A real body observer, as JE.helpers.onBodyMutation is: every added node re-applies the page.
    observe: (fn, win, doc) => new win.MutationObserver((m) => { if (++calls < 25) fn(m); }).observe(doc.body, { childList: true, subtree: true })
  });
  await h.open();
  const banner = h.document.querySelector('.je-arr-banner');
  const btn = banner.querySelector('.je-ask-banner-action .je-ask-get');
  assert.equal(btn.textContent, 'downloadGet them');
  btn.focus();
  for (let i = 0; i < 3; i++) h.JE.internals.arrStatusEpisodes.apply();
  await settle(30);
  assert.equal(h.document.querySelectorAll('.je-arr-banner').length, 1);
  assert.equal(h.document.querySelector('.je-arr-banner'), banner, 'the same banner node');
  assert.equal(banner.querySelector('.je-ask-get'), btn, 'the same Get them button');
  assert.equal(h.document.activeElement, btn, 'keyboard / TV focus stays on Get them');
  assert.ok(calls < 25, `the page settles (the observer ran ${calls} times)`);
});

test('a season without episode rows of Jellyfin\'s own: JE rows go in its empty list once it is shown; no list at all brings the banner back', async t => {
  const html = (list) => '<div id="itemDetailPage" class="page libraryPage"><div class="detailPagePrimaryContent"><div class="detailSection"></div></div>'
    + (list ? '<div id="listChildrenCollapsible" class="hide verticalSection detailVerticalSection"><div id="childrenContent"><div class="itemsContainer"></div></div></div>' : '') + '</div>';
  const h = setup(t, { html: html(true) });
  await h.open();
  assert.equal(h.document.querySelectorAll('.je-ask-row').length, 0, 'jellyfin-web has not rendered the season yet');
  assert.equal(h.document.querySelector('.je-arr-banner'), null, 'and the banner waits for it');
  h.document.getElementById('listChildrenCollapsible').classList.remove('hide');
  h.JE.internals.arrStatusEpisodes.apply();
  await settle();
  same(h.episodes(), ['JE2', 'JE3', 'JE4']);
  assert.equal(h.document.querySelector('.je-arr-banner'), null, 'never both rows and the banner');
  assert.equal(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get').textContent, 'addGet it');

  const none = setup(t, { html: html(false) });
  await none.open();
  assert.equal(none.document.querySelectorAll('.je-ask-row').length, 0);
  const banner = none.document.querySelector('.je-arr-banner');
  assert.ok(banner, 'nowhere to draw rows: the banner says it');
  assert.equal(banner.querySelector('.je-arr-banner-title').textContent, 'Missing: E2, E4');
  assert.equal(banner.querySelector('.je-ask-get').textContent, 'downloadGet them');
});

test('a request already sent gives way to Search once the episode is missing for a long while; waiting, declined and fresh ones keep their chip', async t => {
  const h = setup(t, { status: longMissing(), server: { rows: () => rowsBody({ requests: { 2: 'asked', 4: 'waiting' } }) } });
  await h.open();
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  assert.equal(two.querySelector('.je-arr-chip').textContent, 'Missing');
  assert.equal(two.querySelector('.je-ask-get .je-ask-get-text').textContent, 'Search');
  const four = h.list().querySelector('.je-ask-row[data-je-ask-episode="4"]');
  assert.equal(four.querySelector('.je-arr-chip').textContent, 'Waiting for OK');
  assert.equal(four.querySelector('.je-ask-get'), null);

  // Someone else's ask, and the dialog of a JE row, follow the same rule.
  const household = setup(t, { status: longMissing(), server: { rows: () => rowsBody({ requests: { 2: 'household', 4: 'declined' } }) } });
  await household.open();
  assert.equal(household.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get .je-ask-get-text').textContent, 'Search');
  assert.equal(household.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-arr-chip').textContent, 'Said no');
  household.JE.internals.arrAskEpisodes.openDetails(longMissing().episodes[1], { contact: 'Dad' });
  await settle();
  const dialog = household.document.querySelector('.je-ask-dialog');
  assert.equal(dialog.querySelector('.je-ask-get .je-ask-get-text').textContent, 'Search', 'the dialog offers Search too');

  // The banner: Search for E2 next to E4's waiting chip.
  const banner = setup(t, { status: longMissing(), server: { rows: () => rowsBody({ displayMissing: false, requests: { 2: 'asked', 4: 'waiting' } }) } });
  await banner.open();
  const action = banner.document.querySelector('.je-arr-banner .je-ask-banner-action');
  same([...action.querySelectorAll('.je-arr-chip')].map(c => c.textContent), ['E4 · Waiting for OK']);
  assert.equal(action.querySelector('.je-ask-get .je-ask-get-text').textContent, 'Search for E2');

  // Still fresh (Looking for it): the sent ask keeps its chip.
  const fresh = setup(t, { status: withEpisode(season(), 2, 'looking', 'looking'), server: { rows: () => rowsBody({ requests: { 2: 'asked' } }) } });
  await fresh.open();
  assert.equal(fresh.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-arr-chip').textContent, 'Asked!');
  assert.equal(fresh.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get'), null);

  // Seen live: unmonitored in Sonarr after the ask went out (nobody fetches it): not "Asked!", but Get it again.
  const dropped = setup(t, { server: { rows: () => rowsBody({ requests: { 2: 'asked' } }) } });
  await dropped.open();
  const two2 = dropped.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  assert.equal(two2.querySelector('.je-arr-chip').textContent, 'Missing');
  assert.ok(two2.querySelector('.je-ask-get'));
});

test('a Search pressed by someone who asks shows its answer for a while, even after the season is read again', async t => {
  const h = setup(t, {
    status: longMissing(),
    server: {
      me: { role: 'member', canRequest: true, contact: 'Dad', asksFirst: false },
      post: () => ({ status: 201, body: { outcome: 'accepted', reason: 'queued', certainty: 'Succeeded', message: 'Asked!', requestId: 'e'.repeat(32) } })
    }
  });
  await h.open();
  h.setRows(() => rowsBody({ requests: { 2: 'asked' } }));
  h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get').click();
  await settle(20);
  assert.equal(h.posts[0].path, '/acquire/requests');
  const two = () => h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  assert.equal(two().querySelector('.je-arr-chip').textContent, 'Asked!');
  // A new status read (the ask refreshes the title) reads the rows again: the server says "asked".
  h.JE.internals.arrStatusEpisodes.render(h.document.getElementById('itemDetailPage'), longMissing(), { contact: 'Dad' });
  await settle(20);
  assert.ok(h.gets.filter(p => p.startsWith('/acquire/requests/season/')).length >= 2, 'the rows were read again');
  assert.equal(two().querySelector('.je-arr-chip').textContent, 'Asked!');
  assert.equal(two().querySelector('.je-ask-get'), null, 'no Search right after the person searched');
});

test('Get it and Search are 44 px on every touch screen, not only on phones', t => {
  const h = setup(t);
  const css = h.JE.internals.arrAskStyles.CSS;
  const coarse = /@media \(any-pointer: coarse\)\s*\{([^@]*?)\n\}/.exec(css);
  assert.ok(coarse, 'a rule for touch screens of any width');
  assert.match(coarse[1], /\.je-ask-get\s*\{[^}]*min-height:\s*44px/);
  const outside = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const after = /\.je-ask-get::after\s*\{([^}]*)\}/.exec(outside);
  assert.match(after[1], /height:\s*max\(44px/, 'and a 44 px hit area around the compact button elsewhere');
});

// ------------------------------------------------------------------ review round 2

const SEASON_B = 'ddddddddddddddddddddddddddddddd2';

/** Season 1 of another series (same episode layout as {@link season}). */
function otherSeason() {
  const status = season();
  status.key = 'tv:tvdb:2:s1';
  status.itemId = SEASON_B;
  for (const ep of status.episodes) ep.key = ep.key.replace('tv:tvdb:1:', 'tv:tvdb:2:');
  return status;
}

function otherRows() {
  const body = rowsBody();
  body.rows.key = 'tv:tvdb:2:s1';
  body.rows.series = 'tv:tvdb:2';
  return body;
}

function openDialog(h, episode = 2) {
  const title = h.list().querySelector(`.je-ask-row[data-je-ask-episode="${episode}"] .je-ask-row-title`);
  title.focus();
  title.click();
  return { title, get: h.document.querySelector('.je-ask-dialog .je-ask-get') };
}

test('the episode dialog closes when another season is shown, and its Get it never asks for that season', async t => {
  const h = setup(t);
  await h.open();
  const { get } = openDialog(h);
  assert.ok(get, 'the dialog offers Get it');
  // Another series' season is shown under the dialog (the router changed the page without a
  // navigation event JE saw): the dialog goes with the season it was opened for.
  h.setStatus(otherSeason());
  h.setRows((n, path) => (path.includes(SEASON_B) ? otherRows() : rowsBody()));
  h.window.location.hash = `#/details?id=${SEASON_B}`;
  await h.open();
  assert.ok(h.gets.some(p => p.includes(SEASON_B)), 'the new season was read');
  assert.equal(h.document.querySelector('.je-ask-dialog-backdrop'), null, 'the dialog closed with its season');
  // A press that still reaches the old button (it was on screen a moment ago) asks for nothing.
  get.click();
  await settle(20);
  same(h.posts, [], 'no request for the other series');
});

test('the episode dialog closes on a navigation (Back gesture) and its keys stop being taken', async t => {
  const h = setup(t);
  await h.open();
  openDialog(h);
  assert.ok(h.document.querySelector('.je-ask-dialog'));
  h.navigate('#/home.html');
  assert.equal(h.document.querySelector('.je-ask-dialog-backdrop'), null, 'closed by the navigation');
  const key = new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  h.document.dispatchEvent(key);
  assert.equal(key.defaultPrevented, false, 'the dialog\'s key handler is gone');
});

test('a sign-out closes the episode dialog (no episode details left for the next person)', async t => {
  const h = setup(t);
  await h.open();
  const { title } = openDialog(h);
  h.document.body.focus?.();
  h.switchUser();
  assert.equal(h.document.querySelector('.je-ask-dialog-backdrop'), null);
  assert.notEqual(h.document.activeElement, title, 'focus is not handed to the previous person\'s page');
  const key = new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  h.document.dispatchEvent(key);
  assert.equal(key.defaultPrevented, false);
});

test('an administrator\'s Search waiting for capabilities is dropped when someone else signs in', async t => {
  let release;
  const gate = new Promise(r => { release = r; });
  const rowsSearch = setup(t, {
    status: longMissing({ admin: true }),
    config: { ArrManageDrawerEnabled: true },
    server: { me: ADMIN_ME, meGate: () => gate, post: () => ({ status: 200, body: { status: 'Succeeded', found: false } }) }
  });
  await rowsSearch.open();
  rowsSearch.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get').click();
  await settle();
  rowsSearch.switchUser();
  release();
  await settle(20);
  same(rowsSearch.posts, [], 'no search with the next person\'s token');
  same(rowsSearch.toasts, []);
});

test('the banner\'s Search waiting for capabilities is dropped when someone else signs in', async t => {
  let release;
  const gate = new Promise(r => { release = r; });
  const h = setup(t, {
    status: longMissing({ admin: true }),
    config: { ArrManageDrawerEnabled: true },
    server: { me: ADMIN_ME, meGate: () => gate, rows: () => rowsBody({ displayMissing: false }), post: () => ({ status: 200, body: { status: 'Succeeded', found: false } }) }
  });
  await h.open();
  h.document.querySelector('.je-arr-banner .je-ask-get').click();
  await settle();
  h.switchUser();
  release();
  await settle(20);
  same(h.posts, []);
  same(h.toasts, []);
});

test('Get it and Search: at least 24 px with a mouse (the row clips the wider hit area), 48 px in the TV layout', t => {
  const h = setup(t);
  const css = h.JE.internals.arrAskStyles.CSS;
  const outside = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const base = /(?:^|\n)\.je-ask-get\s*\{([^}]*)\}/.exec(outside);
  assert.match(base[1], /min-height:\s*max\([^)]*24px\)/, 'never below the 24 px minimum target');
  const tv = /\.layout-tv \.je-ask-get\s*\{([^}]*)\}/.exec(outside);
  assert.ok(tv, 'a TV rule outside any media query (TV browsers often report a fine pointer)');
  assert.match(tv[1], /min-height:\s*48px/);
  assert.match(tv[1], /min-width:\s*48px/);
});

// ------------------------------------------------------------------ phase 3g: never a bare "Missing" with nothing to do

const MEMBER_ME = { role: 'member', canRequest: true, contact: 'Dad', asksFirst: false };
const FULL = { reason: 'low_disk' };
const FULL_ADMIN = { reason: 'low_disk', instance: 'Sonarr', folder: '/tv/Show', free: 2e9, freePercent: 0, limitPercent: 10 };
const ADMIN_DETAIL = 'Sonarr: /tv/Show has 2 GB free (0%), under the 10% low-disk limit. Requests are paused; Search still runs for you.';
const FAMILY_TEXT = "There's no room for new downloads right now, so asking is paused. Dad can free up some space.";

/** E2 monitored and missing for a long while (Search), E4 not monitored (Get it would ask for it). */
function adminMixed() {
  const status = longMissing({ admin: true });
  const e4 = status.episodes.find(e => e.episode === 4);
  e4.stage = 'notHere';
  e4.reason = { code: 'unmonitored' };
  return status;
}

test('storage full: an administrator still gets Search (the arr\'s own search, no request); the rest say "Paused: storage full" with where and how much is free', async t => {
  const h = setup(t, {
    status: adminMixed(),
    config: { ArrManageDrawerEnabled: true },
    server: {
      me: ADMIN_ME,
      rows: () => rowsBody({ canRequest: false, blocked: FULL_ADMIN }),
      post: path => (path === '/arr/admin/manage/search' ? { status: 200, body: { status: 'Succeeded', found: false } } : { status: 403, body: { outcome: 'blocked', reason: 'low_disk' } })
    }
  });
  await h.open();
  const row = n => h.list().querySelector(`.je-ask-row[data-je-ask-episode="${n}"]`);
  assert.equal(row(2).querySelector('.je-arr-chip').textContent, 'Missing');
  assert.equal(row(2).querySelector('.je-ask-get').dataset.mode, 'search', 'Search whatever the request policy says');
  assert.equal(row(2).querySelector('.je-ask-paused'), null);
  assert.equal(row(4).querySelector('.je-arr-chip').textContent, 'Missing');
  assert.equal(row(4).querySelector('.je-ask-get'), null, 'no Get it: asking is paused');
  assert.equal(row(4).querySelector('.je-ask-paused').textContent, 'Paused: storage full');
  assert.equal(row(4).querySelector('.je-ask-paused').title, ADMIN_DETAIL);
  const note = h.document.querySelector('.je-ask-season-note');
  assert.ok(note && note.nextElementSibling === h.list(), 'one line for the season, above its episodes');
  same([note.querySelector('.je-ask-paused-title').textContent, note.querySelector('.je-ask-paused-text').textContent], ['Paused: storage full', ADMIN_DETAIL]);
  // The dialog of an episode the administrator can search: Search stays, under the same line (the grab may not fit).
  openDialog(h, 2);
  let dialog = h.document.querySelector('.je-ask-dialog');
  assert.equal(dialog.querySelector('.je-ask-get').dataset.mode, 'search');
  assert.equal(dialog.querySelector('.je-ask-paused-note .je-ask-paused-text').textContent, ADMIN_DETAIL);
  dialog.querySelector('.je-ask-dialog-close').click();
  assert.equal(h.document.querySelector('.je-ask-dialog'), null);
  row(2).querySelector('.je-ask-get').click();
  await settle(20);
  same(h.posts.map(p => p.path), ['/arr/admin/manage/search'], 'only the arr\'s own search, never a request');
  same({ instanceId: h.posts[0].body.instanceId, key: h.posts[0].body.key }, { instanceId: 'son1', key: 'tv:tvdb:1:s1:e2' });
  assert.equal(row(2).querySelector('.je-ask-searched').textContent, 'Nothing found yet · searched just now');
  // The paused episode's dialog says why instead of offering Get it.
  openDialog(h, 4);
  dialog = h.document.querySelector('.je-ask-dialog');
  assert.equal(dialog.querySelector('.je-ask-get'), null);
  assert.equal(dialog.querySelector('.je-ask-paused-note .je-ask-paused-text').textContent, ADMIN_DETAIL);
  // Read out with the dialog's name (focus lands on Close; the reason is plain text).
  assert.ok(dialog.querySelector('.je-ask-paused-note').id);
  assert.equal(dialog.getAttribute('aria-describedby'), dialog.querySelector('.je-ask-paused-note').id);
  dialog.querySelector('.je-ask-dialog-close').click();
});

test('storage full in the banner: an administrator\'s Search for the long-missing ones and the paused line; once, not again above the list', async t => {
  const h = setup(t, {
    status: adminMixed(),
    config: { ArrManageDrawerEnabled: true },
    server: { me: ADMIN_ME, rows: () => rowsBody({ displayMissing: false, canRequest: false, blocked: FULL_ADMIN }), post: () => ({ status: 200, body: { status: 'Succeeded', found: null } }) }
  });
  await h.open();
  const action = h.document.querySelector('.je-arr-banner .je-ask-banner-action');
  const btn = action.querySelector('.je-ask-get');
  same([btn.querySelector('.je-ask-get-text').textContent, btn.getAttribute('aria-label')], ['Search for E2', 'Search for the missing episodes: E2']);
  assert.equal(action.querySelector('.je-ask-paused-note .je-ask-paused-text').textContent, ADMIN_DETAIL);
  assert.equal(h.document.querySelector('.je-ask-season-note'), null, 'said once, in the banner');
  btn.click();
  await settle(20);
  same({ path: h.posts[0].path, key: h.posts[0].body.key }, { path: '/arr/admin/manage/search', key: 'tv:tvdb:1:s1:e2' });
  // Applying the page again keeps the banner as it is (no rebuild loop).
  const kept = h.document.querySelector('.je-arr-banner .je-ask-banner-action');
  h.JE.internals.arrStatusEpisodes.apply();
  await settle();
  assert.equal(h.document.querySelector('.je-arr-banner .je-ask-banner-action'), kept);
});

test('storage full: someone who may ask sees "Paused: storage full" and a plain sentence where Get it and Search would be, never a path', async t => {
  const h = setup(t, { status: longMissing(), server: { me: MEMBER_ME, rows: () => rowsBody({ canRequest: false, blocked: FULL }) } });
  await h.open();
  for (const n of [2, 4]) {
    const row = h.list().querySelector(`.je-ask-row[data-je-ask-episode="${n}"]`);
    assert.equal(row.querySelector('.je-arr-chip').textContent, 'Missing', 'not the bare phase-1 chip');
    assert.equal(row.querySelector('.je-ask-get'), null);
    assert.equal(row.querySelector('.je-ask-paused').textContent, 'Paused: storage full');
    assert.equal(row.querySelector('.je-ask-paused').title, FAMILY_TEXT);
  }
  assert.equal(h.document.querySelector('.je-ask-season-note .je-ask-paused-text').textContent, FAMILY_TEXT);
  assert.ok(!h.document.body.textContent.includes('/tv'), 'no paths for the family');
  same(h.posts, []);
  same(h.searches, []);

  const banner = setup(t, { status: longMissing(), server: { me: MEMBER_ME, rows: () => rowsBody({ displayMissing: false, canRequest: false, blocked: FULL }) } });
  await banner.open();
  const action = banner.document.querySelector('.je-arr-banner .je-ask-banner-action');
  assert.equal(action.querySelector('.je-ask-get'), null, 'no Get them, no Search');
  same([action.querySelector('.je-ask-paused-title').textContent, action.querySelector('.je-ask-paused-text').textContent], ['Paused: storage full', FAMILY_TEXT]);

  // An administrator without the Manage drawer has no Search of their own: paused like everyone else.
  const noDrawer = setup(t, { status: adminMixed(), server: { me: ADMIN_ME, rows: () => rowsBody({ canRequest: false, blocked: FULL_ADMIN }) } });
  await noDrawer.open();
  assert.equal(noDrawer.document.querySelector('.je-ask-get'), null);
  assert.equal(noDrawer.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-paused').textContent, 'Paused: storage full');

  // Room again: Get it and Search as before, nothing paused.
  const roomy = setup(t, { status: longMissing(), server: { me: MEMBER_ME, rows: () => rowsBody() } });
  await roomy.open();
  same([...roomy.list().querySelectorAll('.je-ask-get')].map(b => b.dataset.mode), ['search', 'search']);
  assert.equal(roomy.document.querySelector('.je-ask-paused, .je-ask-paused-note'), null);
});

test('other refusals the request controls explain read "Can\'t ask right now"; an administrator learns which part needs a look', async t => {
  const member = setup(t, { status: longMissing(), server: { me: MEMBER_ME, rows: () => rowsBody({ canRequest: false, blocked: { reason: 'instance_changed' } }) } });
  await member.open();
  assert.equal(member.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-paused').textContent, "Can't ask right now");
  assert.equal(member.document.querySelector('.je-ask-season-note .je-ask-paused-text').textContent, "This can't be asked for right now. Dad can sort it out.");
  const A = member.JE.arrAsk;
  assert.equal(A.blockWords({ reason: 'instance_changed' }, ADMIN_ME).detail, "The Sonarr/Radarr this would go to can't take it (instance_changed). Check that instance and its add defaults.");
  assert.equal(A.blockWords(null, ADMIN_ME), null);
  assert.equal(A.blockWords({ reason: 'low_disk' }, MEMBER_ME).detail, '', 'no detail without the server\'s administrator fields');
  same(A.paused({ pausedMovies: FULL, pausedSeries: null }, 'movie'), FULL);
  assert.equal(A.paused({ pausedMovies: FULL, pausedSeries: null }, 'series'), null);
});

test('a refusal for storage is said in plain words: the ask\'s toast, and a Search that would fail to import isn\'t turned into an ask', async t => {
  const h = setup(t, {
    status: longMissing(),
    server: {
      me: MEMBER_ME,
      search: () => ({ status: 403, body: { outcome: 'blocked', reason: 'low_disk', certainty: 'Rejected', message: "This one can't be asked for here." } })
    }
  });
  const A = h.JE.arrAsk;
  assert.equal(A.interpret(403, { outcome: 'blocked', reason: 'low_disk' }).state, 'blocked');
  assert.equal(A.describe({ state: 'blocked', reason: 'low_disk' }, MEMBER_ME).text, "Paused: storage full. There's no room for new downloads right now.");
  await h.open();
  h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get').click();
  await settle(20);
  same(h.searches.length, 1);
  same(h.posts, [], 'no ask after the refused Search');
  assert.equal(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-searched').textContent, 'Paused: storage full');
  same(h.toasts, ["Paused: storage full. There's no room for new downloads right now."]);
});

// ------------------------------------------------------------------ Seerr mode: Seerr takes whole seasons

const SEERR_MEMBER = { role: 'member', canRequest: true, contact: 'Dad', asksFirst: false, backend: 'seerr' };

test('Seerr mode: an episode\'s Get it reads "Get Season 1" and says why, asks for the whole season, and every missing episode of it shows the answer', async t => {
  const h = setup(t, { server: { me: SEERR_MEMBER } });
  await h.open();
  await settle();
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  const btn = two.querySelector('.je-ask-get');
  assert.equal(btn.querySelector('.je-ask-get-text').textContent, 'Get Season 1', 'the button says what it asks for before it is pressed');
  assert.equal(btn.getAttribute('aria-label'), 'Get Season 1. Seerr takes whole seasons, so this asks for all of Season 1.');
  assert.equal(btn.title, 'Seerr takes whole seasons, so this asks for all of Season 1.');
  btn.click();
  await settle(20);
  assert.equal(h.posts.length, 1);
  same(h.posts[0].body.input, { key: 'tv:tvdb:1', scope: 'seasons', variant: 'standard', seasons: [1], episodes: [] });
  for (const n of [2, 4]) {
    const r = h.list().querySelector(`.je-ask-row[data-je-ask-episode="${n}"]`);
    assert.equal(r.querySelector('.je-arr-chip').textContent, 'Waiting for OK', `E${n} is part of the season asked for`);
    assert.equal(r.querySelector('.je-ask-get'), null);
  }
  // The episode dialog says it too, above its button.
  const h2 = setup(t, { server: { me: SEERR_MEMBER } });
  await h2.open();
  await settle();
  h2.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-ask-row-title').click();
  const dialog = h2.document.querySelector('.je-ask-dialog');
  assert.equal(dialog.querySelector('.je-ask-dialog-note').textContent, 'Seerr takes whole seasons, so this asks for all of Season 1.');
  assert.equal(dialog.querySelector('.je-ask-get .je-ask-get-text').textContent, 'Get Season 1');
});

test('Seerr mode: the banner\'s Get them reads "Get Season 1" and asks for the season', async t => {
  const h = setup(t, { server: { me: SEERR_MEMBER, rows: () => rowsBody({ displayMissing: false }) } });
  await h.open();
  await settle();
  const btn = h.document.querySelector('.je-arr-banner .je-ask-banner-action .je-ask-get');
  assert.equal(btn.querySelector('.je-ask-get-text').textContent, 'Get Season 1');
  assert.equal(btn.getAttribute('aria-label'), 'Get Season 1. Seerr takes whole seasons, so this asks for all of Season 1.');
  btn.click();
  await settle(20);
  same(h.posts.map(p => p.body.input), [{ key: 'tv:tvdb:1', scope: 'seasons', variant: 'standard', seasons: [1], episodes: [] }]);
});

test('Seerr with partial requests off: the episode\'s button reads "Get the whole series" and asks for every season', async t => {
  const h = setup(t, { server: { me: { ...SEERR_MEMBER, seerrWholeSeries: true } } });
  h.JE.core.api.plugin = async (path) => (String(path).startsWith('/acquire/status?keys=')
    ? { items: [{ key: 'tv:tvdb:1', kind: 'series', seasons: [{ season: 0 }, { season: 1 }, { season: 2 }] }] }
    : { contact: 'Dad', items: [season()] });
  await h.open();
  await settle();
  const btn = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get');
  assert.equal(btn.querySelector('.je-ask-get-text').textContent, 'Get the whole series');
  assert.equal(btn.title, 'Seerr takes whole series only, so this asks for every season.');
  btn.click();
  await settle(30);
  same(h.posts.map(p => p.body.input), [{ key: 'tv:tvdb:1', scope: 'seasons', variant: 'standard', seasons: [1, 2], episodes: [] }]);
});

test('Seerr mode: a button that did not say "Season" (drawn before the capabilities arrived, or a Search that would ask) never asks for the season', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = setup(t, { server: { me: SEERR_MEMBER, meGate: () => gate } });
  await h.open();
  const btn = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get');
  assert.equal(btn.querySelector('.je-ask-get-text').textContent, 'Get it', 'capabilities not known yet');
  btn.click();
  release();
  await settle(30);
  assert.equal(h.posts.length, 0, 'nothing is asked behind a "Get it" label');
  assert.equal(h.toasts.at(-1), "Seerr takes whole seasons, so single episodes can't be asked for. Ask for the season instead.");
  assert.equal(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get .je-ask-get-text').textContent, 'Get Season 1', 'drawn again with the season on it');
  // Someone else's Search on an episode nothing was sent for yet is the season's ask in Seerr mode (it would ask).
  const s = setup(t, { status: longMissing(), server: { me: SEERR_MEMBER } });
  await s.open();
  await settle();
  const two = s.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get');
  assert.equal(two.querySelector('.je-ask-get-text').textContent, 'Get Season 1');
});

test('one season at a time: a server refusal of several seasons reads in plain words, and the capability is read', t => {
  const h = setup(t);
  const refused = h.JE.arrAsk.interpret(409, { outcome: 'blocked', reason: 'single_season_only' });
  assert.equal(refused.state, 'blocked', 'not "busy": asking again would be refused the same way');
  assert.equal(h.JE.arrAsk.describe(refused, MEMBER_ME, null).text, 'Only one season can be asked for at a time.');
  assert.equal(h.JE.arrAsk.singleSeasonOnly({ ...MEMBER_ME, singleSeason: true }), true);
  assert.equal(h.JE.arrAsk.singleSeasonOnly(MEMBER_ME), false);
  // Seerr taking the whole series only wins: the option has no effect there.
  assert.equal(h.JE.arrAsk.singleSeasonOnly({ ...SEERR_MEMBER, singleSeason: true, seerrWholeSeries: true }), false);
});

test('Seerr mode: a server refusal of single episodes reads in plain words', t => {
  const h = setup(t);
  const refused = h.JE.arrAsk.interpret(409, { outcome: 'blocked', reason: 'seerr_whole_season_only' });
  assert.equal(refused.state, 'blocked', 'not "busy": asking again would be refused the same way');
  assert.equal(h.JE.arrAsk.describe(refused, SEERR_MEMBER, null).text, "Seerr takes whole seasons, so single episodes can't be asked for. Ask for the season instead.");
});
