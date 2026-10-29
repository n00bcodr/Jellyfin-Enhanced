import { clickAsViewer } from '../helpers/harness.mjs';
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

function rowsBody({ displayMissing = true, canRequest = true, requests = {}, seasonRequest = null, blocked = null, source } = {}) {
  return {
    outcome: 'accepted', reason: 'season', certainty: 'Succeeded', message: 'Season',
    rows: {
      key: 'tv:tvdb:1:s1', series: 'tv:tvdb:1', season: 1, seriesId: 'ccccccccccccccccccccccccccccccc1', displayMissing, canRequest, seasonRequest, blocked,
      // Whose numbering the rows carry (UX-3, SeasonRows.source); left out, the round-1 shape (no source).
      ...(source ? { source } : {}),
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
  let rowsAnswer = server.rows || (() => rowsBody({ source: 'destination' }));
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
        const answer = server.post ? await server.post(path, body, posts.length) : { status: 201, body: { outcome: 'accepted', reason: 'awaiting_approval', certainty: 'Succeeded', message: 'Asked!', requestId: 'f'.repeat(32) } };
        if (answer instanceof Error) throw answer;
        return jsonResponse(answer.body, answer.status);
      }
      gets.push(path);
      if (path.startsWith('/acquire/requests/season/')) {
        const answer = await rowsAnswer(gets.length, path);
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
  // Stage 1 fix round 12: a lost answer is uncertain (the ask may be recorded), never "failed".
  assert.equal((await A.ask(input)).state, 'unconfirmed');
  mode = '503';
  assert.equal((await A.ask({ ...input })).state, 'unavailable');
  mode = 'ok';
  const done = await A.ask(input);
  assert.equal(done.state, 'asked');
  const ids = h.posts.map(p => p.body.clientRequestId);
  assert.equal(new Set(ids).size, 1, 'the same ask kept its id through a network failure and a 503');
  await A.ask(input);
  assert.notEqual(h.posts[3].body.clientRequestId, ids[0], 'a new ask after the definitive answer gets a new id');
  same(changes, ['unconfirmed', 'ask', 'ask']);
  // A user switch forgets open ids.
  mode = 'network';
  await A.ask(A.movieInput('movie:tmdb:1'));
  h.userChange.forEach(fn => fn());
  await A.ask(A.movieInput('movie:tmdb:1'));
  assert.notEqual(h.posts[4].body.clientRequestId, h.posts[5].body.clientRequestId);
});

// Integration je12 (RBS1-R13-5): an answer that proves no outcome never reads as a definite failure, nor as "asked" without its
// body: a server error after the ask went out (5xx but 503, and 408) or a success whose body couldn't be read is unconfirmed,
// the id is kept (asking again is the same ask) and the title's status is read again.
test('an ask answered 502 after it went out, or a success without its body, is unconfirmed (never failed, never asked)', async t => {
  let mode = '502';
  const h = setup(t, {
    server: {
      post: () => mode === '502' ? { status: 502, body: { message: 'gateway lost the upstream answer' } }
        : mode === 'empty' ? { status: 201, body: null }
          : mode === '503' ? { status: 503, body: { outcome: 'unavailable', reason: 'database_unavailable' } }
            : { status: 201, body: { outcome: 'accepted', reason: 'queued_outage', requestId: 'b'.repeat(32) } }
    }
  });
  const A = h.JE.arrAsk;
  const changes = [];
  A.onChange(c => changes.push(c.type));
  const input = A.movieInput('movie:tmdb:42');
  const lost = await A.ask(input);
  assert.equal(lost.state, 'unconfirmed');
  assert.ok(!/Asked/.test(A.describe(lost).text), 'never says it was asked');
  mode = 'empty';
  assert.equal((await A.ask({ ...input })).state, 'unconfirmed', 'a 201 whose body could not be read proves nothing');
  mode = '503';
  assert.equal((await A.ask({ ...input })).state, 'unavailable', 'a 503 is refused before processing: a definite answer');
  mode = 'ok';
  assert.equal((await A.ask({ ...input })).state, 'asked');
  assert.equal(new Set(h.posts.map(p => p.body.clientRequestId)).size, 1, 'the same ask kept its id through the uncertain answers');
  same(changes, ['unconfirmed', 'unconfirmed', 'ask']);
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
  h.click(four.querySelector('.listItem-content'));
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
  h.setRows(() => rowsBody({ source: 'destination', requests: { 2: 'waiting' } }));
  h.click(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get'));
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
  h.click(h.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-ask-get'));
  await settle(20);
  const four = h.list().querySelector('.je-ask-row[data-je-ask-episode="4"]');
  assert.equal(four.querySelector('.je-arr-chip').textContent, 'Missing');
  assert.ok(four.querySelector('.je-ask-get:not([disabled])'), 'Get it is back');
  assert.equal(h.toasts.at(-1), "You've used this week's requests.");
  // Stage 1 fix round 12: a lost answer may have been recorded, so it is said as unconfirmed, never as not asked.
  answer = new TypeError('Failed to fetch');
  h.click(four.querySelector('.je-ask-get'));
  await settle(20);
  assert.equal(h.toasts.at(-1), "Couldn't confirm your ask reached the server. Asking again won't ask twice.");
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
  const h = setup(t, { status: withEpisode(season(), 2, 'looking', 'looking'), server: { rows: () => rowsBody({ source: 'destination', displayMissing: false, requests: { 2: 'household' } }) } });
  await h.open();
  same(h.episodes(), ['N1'], 'no JE rows without the display setting');
  const banner = h.document.querySelector('.je-arr-banner');
  assert.equal(banner.querySelector('.je-arr-banner-title').textContent, 'Missing: E2, E4');
  const action = banner.querySelector('.je-ask-banner-action');
  same([...action.querySelectorAll('.je-arr-chip')].map(c => c.textContent), ['E2 · Someone asked']);
  const btn = action.querySelector('.je-ask-get');
  assert.equal(btn.textContent, 'downloadGet E4');
  assert.equal(btn.getAttribute('aria-label'), 'Get the missing episodes: E4');
  h.click(btn);
  await settle(20);
  same(h.posts[0].body.input.episodes, [{ season: 1, episode: 4 }]);
  assert.match(h.document.querySelector('.je-ask-banner-action').textContent, /E4 · Waiting for OK/);
});

/** A status whose episodes in `gaps` another copy the viewer can open plays (the server's copyGap: this page's copy role). */
function withGaps(status, gaps, role = 'standard') {
  return { ...status, episodes: status.episodes.map(e => (gaps.includes(e.episode) ? { ...e, copyGap: role } : e)) };
}

test('a gap another copy plays is that copy\'s gap: the banner, Get them and the row chip name the copy; others stay plainly Missing', async t => {
  // E2 plays in the 4K copy right beside this standard copy's rows; nobody has E4.
  const h = setup(t, { status: withCopy(season(), [2], 'standard', { variant: 'standard', ask: true, search: true }), server: { rows: () => rowsBody({ source: 'destination', displayMissing: false }) } });
  await h.open();
  const banner = h.document.querySelector('.je-arr-banner');
  same([...banner.querySelectorAll('.je-arr-banner-title')].map(n => n.textContent), ['Missing: E4', 'Missing in the standard copy: E2']);
  const btn = banner.querySelector('.je-ask-get');
  assert.equal(btn.textContent, 'downloadGet them in standard');
  assert.equal(btn.getAttribute('aria-label'), 'Get the episodes missing in the standard copy: E2, E4');
  clickAsViewer(btn);
  await settle(20);
  same(h.posts[0].body.input.episodes, [{ season: 1, episode: 2 }, { season: 1, episode: 4 }]);

  // Only a copy's gap left: no title-wide "Missing" at all; one episode names it too. A 4K page says 4K; another role "this copy".
  const only = setup(t, { status: withCopy(season(), [2, 4], '4k', { variant: '4k', ask: true, search: false }), server: { me: KID_4K, rows: () => rowsByEdition({ displayMissing: false, requests4k: { 2: 'waiting' } }) } });
  await only.open();
  const b = only.document.querySelector('.je-arr-banner');
  same([...b.querySelectorAll('.je-arr-banner-title')].map(n => n.textContent), ['Missing in the 4K copy: E2, E4']);
  assert.equal(b.querySelector('.je-ask-get').textContent, 'downloadGet E4 in 4K');
  // A custom copy: no request names it (D53, edition round 15), so nothing is offered under its name.
  const custom = setup(t, { status: withCopy(season(), [2, 4], 'custom', { variant: null, ask: false, search: false }), server: { rows: () => rowsBody({ source: 'destination', displayMissing: false }) } });
  await custom.open();
  same([...custom.document.querySelectorAll('.je-arr-banner .je-arr-banner-title')].map(n => n.textContent), ['Missing in this copy: E2, E4']);
  assert.equal(custom.document.querySelector('.je-arr-banner .je-ask-get'), null);

  // Rows mode: the JE row of a copy's gap says so; the others keep "Missing".
  const rows = setup(t, { status: withCopy(season(), [2], 'standard', { variant: 'standard', ask: true, search: true }) });
  await rows.open();
  assert.equal(rows.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-arr-chip').textContent, 'Missing in standard');
  assert.equal(rows.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-arr-chip').textContent, 'Missing');
  // Phase 1 alone (no asking): the chips say it the same way.
  assert.equal(rows.JE.arrStatus.chipText({ stage: 'looking', reason: { code: 'no_release_yet' }, copyGap: 'standard' }), 'Missing in standard');
});

/** A status whose gaps are the page copy's (`role`), with the server's binding of that copy (null: an older server, none). */
function withCopy(status, gaps, role, copy) {
  const next = withGaps(status, gaps, role);
  return copy ? { ...next, copy: { role, ...copy } } : next;
}

const KID_4K = { role: 'kid', canRequest: true, contact: 'Dad', asksFirst: true, can4kSeries: true };

test('one binding decides wording and action: Get them in 4K asks for the 4K edition; a copy no ask reaches gets no button under its name', async t => {
  // The 4K page: E2 and E4 are its gaps (the standard copy plays them); a 4K request lands on its Sonarr.
  const h = setup(t, { status: withCopy(season(), [2, 4], '4k', { variant: '4k', ask: true, search: false }), server: { me: KID_4K, rows: () => rowsBody({ source: 'destination', displayMissing: false }) } });
  await h.open();
  const btn = h.document.querySelector('.je-arr-banner .je-ask-get');
  assert.equal(btn.textContent, 'downloadGet them in 4K');
  clickAsViewer(btn);
  await settle(20);
  same({ variant: h.posts[0].body.input.variant, episodes: h.posts[0].body.input.episodes }, { variant: '4k', episodes: [{ season: 1, episode: 2 }, { season: 1, episode: 4 }] }, 'the 4K edition, as the button says');

  // Rows mode: the row's Get it beside "Missing in 4K" asks for the 4K edition too.
  const rows = setup(t, { status: withCopy(season(), [2], '4k', { variant: '4k', ask: true, search: false }), server: { me: KID_4K } });
  await rows.open();
  const two = rows.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  assert.equal(two.querySelector('.je-arr-chip').textContent, 'Missing in 4K');
  assert.equal(two.querySelector('.je-ask-get').getAttribute('aria-label'), 'Get episode 2 for the 4K copy: Two');
  clickAsViewer(two.querySelector('.je-ask-get'));
  await settle(20);
  assert.equal(rows.posts[0].body.input.variant, '4k');
  // A title-wide gap on the same page keeps its plain Get it (a standard ask).
  clickAsViewer(rows.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-ask-get'));
  await settle(20);
  same({ variant: rows.posts[1].body.input.variant, label: rows.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-arr-chip').textContent }, { variant: 'standard', label: 'Waiting for OK' });

  // Someone who may not ask for 4K: nothing under the 4K copy's name.
  const no4k = setup(t, { status: withCopy(season(), [2, 4], '4k', { variant: '4k', ask: true, search: false }), server: { rows: () => rowsBody({ source: 'destination', displayMissing: false }) } });
  await no4k.open();
  assert.equal(no4k.document.querySelector('.je-arr-banner .je-ask-get'), null);
  // A copy no request reaches (an anime Sonarr: asks go to the standard one), or a server that names no binding: no button either.
  for (const copy of [{ variant: null, ask: false, search: false }, null]) {
    const h2 = setup(t, { status: withCopy(season(), [2, 4], 'anime', copy), server: { me: KID_4K, rows: () => rowsBody({ source: 'destination', displayMissing: false }) } });
    await h2.open();
    assert.equal(h2.document.querySelector('.je-arr-banner .je-ask-get'), null, `binding ${JSON.stringify(copy)}`);
    same([...h2.document.querySelectorAll('.je-arr-banner .je-arr-banner-title')].map(n => n.textContent), ['Missing in the anime copy: E2, E4'], 'the words stay');
  }
});

test('one binding decides Search: an administrator searches the copy\'s own instance; a household Search that can\'t reach it asks for that copy\'s edition', async t => {
  const fourK = { variant: '4k', ask: true, search: false };
  const admin = setup(t, {
    status: { ...withCopy(longMissing({ admin: true }), [2, 4], '4k', { ...fourK, instanceId: 'son4k' }) },
    config: { ArrManageDrawerEnabled: true },
    server: { me: ADMIN_ME, rows: () => rowsBody({ source: 'destination', displayMissing: false }), post: () => ({ status: 200, body: { status: 'Succeeded', found: null } }) }
  });
  await admin.open();
  const btn = admin.document.querySelector('.je-arr-banner .je-ask-get');
  assert.equal(btn.querySelector('.je-ask-get-text').textContent, 'Search in 4K');
  clickAsViewer(btn);
  await settle(20);
  same({ path: admin.posts[0].path, instanceId: admin.posts[0].body.instanceId }, { path: '/arr/admin/manage/search', instanceId: 'son4k' }, 'the 4K Sonarr, never the standard one');

  // A Kid's Search runs on standard copies only: under the 4K name the button asks for the 4K edition instead.
  const kid = setup(t, { status: withCopy(longMissing(), [2, 4], '4k', fourK), server: { me: KID_4K, rows: () => rowsBody({ source: 'destination', displayMissing: false }) } });
  await kid.open();
  const get = kid.document.querySelector('.je-arr-banner .je-ask-get');
  assert.equal(get.querySelector('.je-ask-get-text').textContent, 'Get them in 4K');
  clickAsViewer(get);
  await settle(20);
  same(kid.searches, [], 'no household Search (it would search the standard copy)');
  assert.equal(kid.posts[0].body.input.variant, '4k');
  // Its rows too.
  const rows = setup(t, { status: withCopy(longMissing(), [2], '4k', fourK), server: { me: KID_4K } });
  await rows.open();
  const row = rows.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get');
  assert.equal(row.querySelector('.je-ask-get-text').textContent, 'Get it');
  clickAsViewer(row);
  await settle(20);
  same({ searches: rows.searches.length, variant: rows.posts[0].body.input.variant }, { searches: 0, variant: '4k' });

  // The standard copy: a household Search reaches it (its request target), as before.
  const standard = setup(t, {
    status: withCopy(longMissing(), [2, 4], 'standard', { variant: 'standard', ask: true, search: true }),
    server: { rows: () => rowsBody({ source: 'destination', displayMissing: false }), search: () => ({ status: 200, body: { outcome: 'accepted', reason: 'searched', certainty: 'Succeeded', message: 'Searched.', found: false } }) }
  });
  await standard.open();
  const search = standard.document.querySelector('.je-arr-banner .je-ask-get');
  assert.equal(search.querySelector('.je-ask-get-text').textContent, 'Search in standard');
  clickAsViewer(search);
  await settle(30);
  same(standard.searches.map(x => x.body.key), ['tv:tvdb:1:s1']);
});

const MEMBER_4K = { role: 'member', canRequest: true, contact: 'Dad', asksFirst: false, can4kSeries: true };

test('check at click: "Search in 4K" for a 4K copy no ask reaches, after a permission change, refreshes the controls and sends nothing', async t => {
  // An administrator's page of a second 4K Sonarr's copy: a 4K ask goes to the default 4K Sonarr (another copy), so the
  // binding offers only the administrator's Search on the copy's own instance.
  const bound = { variant: '4k', ask: false, search: false };
  const server = { me: ADMIN_ME, rows: () => rowsBody({ source: 'destination', displayMissing: false }), post: () => ({ status: 200, body: { status: 'Succeeded', found: null } }) };
  const h = setup(t, { status: withCopy(longMissing({ admin: true }), [2, 4], '4k', { ...bound, instanceId: 'son4kB' }), config: { ArrManageDrawerEnabled: true }, server });
  await h.open();
  const btn = h.document.querySelector('.je-arr-banner .je-ask-get');
  assert.equal(btn.querySelector('.je-ask-get-text').textContent, 'Search in 4K');
  // They are no longer an administrator: the server names no instance now, and their capabilities are read again.
  server.me = MEMBER_4K;
  h.setStatus(withCopy(longMissing(), [2, 4], '4k', bound));
  await h.JE.arrAsk.me(true);
  clickAsViewer(btn);
  await settle(40);
  same({ posts: h.posts, searches: h.searches }, { posts: [], searches: [] }, 'nothing sent: no ask for the default 4K Sonarr in place of the Search');
  const now = h.document.querySelector('.je-arr-banner .je-ask-get');
  assert.ok(!now || now.querySelector('.je-ask-get-text').textContent !== 'Search in 4K', 'the controls are drawn again for what is allowed now');
  assert.equal(h.toasts.at(-1), translate('arr_ask_changed'), 'and the person is told why nothing happened');
});

test('check at click: a row\'s Search for that copy, after a permission change, sends nothing', async t => {
  const bound = { variant: '4k', ask: false, search: false };
  const server = { me: ADMIN_ME, post: () => ({ status: 200, body: { status: 'Succeeded', found: null } }) };
  const h = setup(t, { status: withCopy(longMissing({ admin: true }), [2], '4k', { ...bound, instanceId: 'son4kB' }), config: { ArrManageDrawerEnabled: true }, server });
  await h.open();
  const row = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get');
  assert.equal(row.dataset.mode, 'search');
  server.me = MEMBER_4K;
  h.setStatus(withCopy(longMissing(), [2], '4k', bound));
  await h.JE.arrAsk.me(true);
  clickAsViewer(row);
  await settle(40);
  same({ posts: h.posts, searches: h.searches }, { posts: [], searches: [] }, 'nothing sent: no ask for the default 4K Sonarr in place of the Search');
  assert.equal(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-search'), null, 'no Search under the copy\'s name any more');
});

test('check at click: "Get them in 4K" asks only while the 4K ask is still allowed and still reaches the copy', async t => {
  // The 4K permission is taken away after the page was drawn.
  const server = { me: KID_4K, rows: () => rowsBody({ source: 'destination', displayMissing: false }) };
  const h = setup(t, { status: withCopy(season(), [2, 4], '4k', { variant: '4k', ask: true, search: false }), server });
  await h.open();
  const btn = h.document.querySelector('.je-arr-banner .je-ask-get');
  assert.equal(btn.textContent, 'downloadGet them in 4K');
  server.me = { ...KID_4K, can4kSeries: false };
  clickAsViewer(btn);
  await settle(40);
  same(h.posts, [], 'no 4K ask once it is no longer allowed');
  assert.equal(h.document.querySelector('.je-arr-banner .je-ask-get'), null, 'nothing under the 4K copy\'s name any more');

  // The binding changed: a 4K ask no longer lands on this copy (the default 4K Sonarr is now another one).
  const moved = setup(t, { status: withCopy(season(), [2, 4], '4k', { variant: '4k', ask: true, search: false }), server: { me: KID_4K, rows: () => rowsBody({ source: 'destination', displayMissing: false }) } });
  await moved.open();
  moved.setStatus(withCopy(season(), [2, 4], '4k', { variant: '4k', ask: false, search: false }));
  clickAsViewer(moved.document.querySelector('.je-arr-banner .je-ask-get'));
  await settle(40);
  same(moved.posts, [], 'no ask for a copy it no longer reaches');

  // Nothing changed: it asks for exactly what it says.
  const kept = setup(t, { status: withCopy(season(), [2, 4], '4k', { variant: '4k', ask: true, search: false }), server: { me: KID_4K, rows: () => rowsBody({ source: 'destination', displayMissing: false }) } });
  await kept.open();
  clickAsViewer(kept.document.querySelector('.je-arr-banner .je-ask-get'));
  await settle(40);
  assert.equal(kept.posts[0]?.body.input.variant, '4k');
});

test('the season summary counts a copy\'s own gaps as the rows do ("1 missing" and "1 missing in standard")', t => {
  const h = setup(t);
  const pieces = h.JE.arrStatus.summaryPieces({ kind: 'season', summary: { aired: 4, ready: 2, missing: 2, longMissing: 2, missingInCopy: 1 }, copy: { role: 'standard' } }).map(p => p.text);
  assert.ok(pieces.includes('1 missing') && pieces.includes('1 missing in standard'), pieces.join(' | '));
  const all = h.JE.arrStatus.summaryPieces({ kind: 'season', summary: { aired: 4, ready: 2, missing: 2, longMissing: 2, missingInCopy: 2 }, copy: { role: '4k' } }).map(p => p.text);
  assert.ok(all.includes('2 missing in 4K') && !all.some(x => /^\d+ missing$/.test(x)), all.join(' | '));
});

test('phones: a chip on a row\'s thumbnail stays inside the thumbnail (it wraps), never over Jellyfin\'s title', t => {
  const h = setup(t);
  const css = [...h.document.querySelectorAll('style')].map(s => s.textContent).join('\n');
  const rule = /\.je-arr-chip-overlay\s*\{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(rule, /max-width:\s*calc\(100% - 12px\)/, rule);
  assert.match(rule, /white-space:\s*normal/, rule);
});

test('a season that is not in the library at all: the banner lists it and leaves asking to Get Season N', async t => {
  const absent = {
    key: 'tv:tvdb:1:s1', itemId: SEASON_ID, kind: 'season', stage: 'notHere', reason: { code: 'not_in_arr' }, summary: { aired: 2 },
    episodes: [
      { key: 'tv:tvdb:1:s1:e2', season: 1, episode: 2, row: false, stage: 'notHere', reason: { code: 'not_in_arr' } },
      { key: 'tv:tvdb:1:s1:e4', season: 1, episode: 4, row: false, stage: 'notHere', reason: { code: 'not_in_arr' } }
    ]
  };
  const h = setup(t, { status: absent, server: { rows: () => rowsBody({ source: 'destination', displayMissing: false }) } });
  h.JE.titleDetails = { isSynthetic: id => id === SEASON_ID };
  await h.open();
  const banner = h.document.querySelector('.je-arr-banner');
  assert.equal(banner.querySelector('.je-arr-banner-title').textContent, 'Missing: E2, E4');
  assert.equal(banner.querySelector('.je-ask-get'), null, 'Get Season 1 on the page asks for the season');
  // Once part of it was asked for, the rest is offered on the banner again.
  const partly = setup(t, { status: withEpisode(absent, 2, 'approved', 'approved'), server: { rows: () => rowsBody({ source: 'destination', displayMissing: false, requests: { 2: 'asked' } }) } });
  partly.JE.titleDetails = { isSynthetic: id => id === SEASON_ID };
  await partly.open();
  assert.equal(partly.document.querySelector('.je-arr-banner .je-ask-get').textContent, 'downloadGet E4');
});

test('people who cannot ask see the rows and states but no Get it; with phase 3 off nothing changes', async t => {
  const watcher = setup(t, { server: { rows: () => rowsBody({ source: 'destination', canRequest: false }) } });
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
  h.click(title);
  const dialog = h.document.querySelector('.je-ask-dialog');
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.querySelector('.je-ask-dialog-title').textContent, '2. Two');
  assert.match(dialog.querySelector('.je-arr-pill-text').textContent, /Not being fetched/);
  assert.equal(dialog.getAttribute('aria-describedby'), null, 'nothing paused to read out');
  assert.equal(h.document.activeElement, dialog.querySelector('.je-ask-get'));
h.key(h.document, 'Escape');
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
  h.click(two.querySelector('.je-ask-row-title'));
  const dialog = h.document.querySelector('.je-ask-dialog');
  assert.match(dialog.querySelector('.je-arr-pill-text').textContent, /Looking for it/);
  assert.equal(dialog.querySelector('.je-ask-get'), null, 'the dialog offers nothing either');
  h.JE.internals.arrAskEpisodes.closeDialog();

  // Banner mode: listed as missing, its own chip says it is being looked for; Get E4 only.
  const banner = setup(t, { status: freshLooking(), server: { rows: () => rowsBody({ source: 'destination', displayMissing: false }) } });
  await banner.open();
  const b = banner.document.querySelector('.je-arr-banner');
  assert.equal(b.querySelector('.je-arr-banner-title').textContent, 'Missing: E2, E4');
  same([...b.querySelectorAll('.je-ask-banner-action .je-arr-chip')].map(c => c.textContent), ['E2 · Looking for it']);
  assert.equal(b.querySelector('.je-ask-get').textContent, 'downloadGet E4');

  // Every missing episode is being looked for: one "Looking for it" for all of them, nothing to ask for.
  const allFresh = freshLooking();
  Object.assign(allFresh.episodes[3], { stage: 'looking', reason: { code: 'looking' } });
  const quiet = setup(t, { status: allFresh, server: { rows: () => rowsBody({ source: 'destination', displayMissing: false }) } });
  await quiet.open();
  const qb = quiet.document.querySelector('.je-arr-banner');
  same([...qb.querySelectorAll('.je-ask-banner-action .je-arr-chip')].map(c => c.textContent), ['Looking for it']);
  assert.equal(qb.querySelector('.je-ask-get'), null);

  // Asking paused (storage full): nothing to explain on an episode nobody could ask for anyway.
  const paused = setup(t, { status: freshLooking(), server: { rows: () => rowsBody({ source: 'destination', canRequest: false, blocked: { reason: 'storage_full' } }) } });
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
  h.click(two);
  const dialog = h.document.querySelector('.je-ask-dialog');
  const buttons = [...dialog.querySelectorAll('button')];
  assert.equal(h.document.activeElement, buttons[0]);
  assert.equal(buttons[0].className.split(' ')[0], 'je-ask-get');
  let jellyfinSaw = 0;
  h.window.addEventListener('keydown', () => jellyfinSaw++);
h.key(h.document.activeElement, 'ArrowRight');
  assert.equal(h.document.activeElement, buttons[1]);
h.key(h.document.activeElement, 'ArrowRight');
  assert.equal(h.document.activeElement, buttons[0], 'wraps around');
  assert.equal(jellyfinSaw, 0, 'the page behind never sees the arrows');
  h.click(buttons[0]);
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

// F24: a season row's (and the banner's) plain Search never asks in its place, like the title's Search (UX2R-4); only the
// title page's "Ask {contact} to search" asks. Nothing sent yet: it says so, and the title's Request asks.
test('rows: a long-missing episode gets Search instead of Get it; a Kid\'s Search with nothing sent asks for nothing and says so', async t => {
  const h = setup(t, { status: longMissing() });
  await h.open();
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  assert.equal(two.querySelector('.je-arr-chip').textContent, 'Missing');
  const btn = two.querySelector('.je-ask-get');
  assert.ok(btn.classList.contains('je-ask-search'));
  assert.equal(btn.querySelector('.je-ask-get-text').textContent, 'Search');
  assert.equal(btn.getAttribute('aria-label'), 'Search for episode 2: Two');
  h.click(btn);
  await settle(20);
  same(h.searches.map(s => s.body.key), ['tv:tvdb:1:s1:e2'], 'the household search, for that episode');
  assert.equal(h.posts.length, 0, 'no request');
  assert.equal(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-arr-chip').textContent, 'Missing');
  assert.ok(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get.je-ask-search'), 'Search stays');
  same(h.toasts, ["Nothing has been asked for here yet, so there's nothing to search again. Use Request to ask for it."]);
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
  h.click(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get'));
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
  h.click(h.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-ask-get'));
  await settle(20);
  assert.equal(h.posts[1].body.key, 'tv:tvdb:1:s1:e4');
  assert.equal(h.toasts.at(-1), 'Found a copy — downloading');
  assert.ok(!h.posts.some(p => p.path === '/acquire/requests'), 'an administrator\'s Search is not a request');
});

test('rows: someone else\'s Search on an episode a request already sent searches again (no new request) and says what it found; otherwise it says nothing was asked yet and asks for nothing (F24)', async t => {
  let answer = { status: 200, body: { outcome: 'accepted', reason: 'searched', certainty: 'Succeeded', message: 'Searched for it.', found: false } };
  const h = setup(t, { status: longMissing(), server: { rows: () => rowsBody({ source: 'destination', requests: { 2: 'household' } }), search: () => answer } });
  await h.open();
  h.click(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get'));
  await settle(20);
  same(h.searches.map(s => s.body.key), ['tv:tvdb:1:s1:e2']);
  assert.match(h.searches[0].body.idempotencyKey, /\S{8,}/);
  same(h.posts, [], 'not a request');
  assert.equal(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-searched').textContent, 'Nothing found yet · searched just now');
  same(h.toasts, ['Nothing found yet · searched just now']);

  // Nothing sent for E4 yet: the server says so, and the Search says so too; it asks for nothing (F24).
  answer = { status: 200, body: { outcome: 'skipped', reason: 'not_requested', certainty: 'Rejected', message: 'Nothing was asked for here yet.' } };
  h.click(h.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-ask-get'));
  await settle(20);
  assert.equal(h.searches.at(-1).body.key, 'tv:tvdb:1:s1:e4');
  assert.equal(h.posts.length, 0);
  assert.equal(h.toasts.at(-1), "Nothing has been asked for here yet, so there's nothing to search again. Use Request to ask for it.");
});

test('banner: someone else\'s Search searches the season again when requests sent all of it, with no new request', async t => {
  const h = setup(t, {
    status: longMissing(),
    server: {
      rows: () => rowsBody({ source: 'destination', displayMissing: false }),
      search: () => ({ status: 200, body: { outcome: 'accepted', reason: 'searched', certainty: 'Succeeded', message: 'Searched for it.', found: false } })
    }
  });
  await h.open();
  h.click(h.document.querySelector('.je-arr-banner .je-ask-get'));
  await settle(30);
  same(h.searches.map(s => s.body.key), ['tv:tvdb:1:s1'], 'one search for the season, not one per episode');
  same(h.posts, [], 'not a request');
  assert.equal(h.document.querySelector('.je-arr-banner .je-ask-searched').textContent, 'Nothing found yet · searched just now');
  same(h.toasts, ['Nothing found yet · searched just now']);
});

test('banner: someone else\'s Search searches again each episode a request sent and asks for none of the others', async t => {
  const h = setup(t, {
    status: longMissing(),
    server: {
      rows: () => rowsBody({ source: 'destination', displayMissing: false }),
      search: (body) => (body.key.endsWith(':e2') ? { status: 200, body: { outcome: 'accepted', reason: 'searched', certainty: 'Succeeded', message: 'Found it.', found: true } } : { status: 200, body: { outcome: 'skipped', reason: 'not_requested', certainty: 'Rejected', message: 'Ask.' } })
    }
  });
  await h.open();
  h.click(h.document.querySelector('.je-arr-banner .je-ask-get'));
  await settle(30);
  // The season as a whole first (not every episode was sent), then episode by episode.
  same(h.searches.map(s => s.body.key), ['tv:tvdb:1:s1', 'tv:tvdb:1:s1:e2', 'tv:tvdb:1:s1:e4']);
  assert.equal(h.posts.length, 0, 'no ask for the episode no request sent (F24)');
  assert.ok(h.toasts.includes('Found a copy — downloading'));
});

test('rows: without the Manage drawer an administrator\'s Search is the household search like everyone else\'s, and asks for nothing', async t => {
  const h = setup(t, { status: longMissing({ admin: true }), server: { me: ADMIN_ME } });
  await h.open();
  h.click(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get'));
  await settle(20);
  same(h.searches.map(s => s.body.key), ['tv:tvdb:1:s1:e2']);
  assert.ok(!h.posts.some(p => p.path === '/acquire/requests'), 'no request (F24)');
  assert.ok(!h.posts.some(p => p.path === '/arr/admin/manage/search'), 'no administrator\'s search without the drawer');
});

test('banner: long-missing episodes get Search; an administrator\'s searches the season, a Kid\'s with nothing sent asks for nothing', async t => {
  const admin = setup(t, {
    status: longMissing({ admin: true }),
    config: { ArrManageDrawerEnabled: true },
    server: { me: ADMIN_ME, rows: () => rowsBody({ source: 'destination', displayMissing: false }), post: () => ({ status: 200, body: { status: 'Succeeded', found: null } }) }
  });
  await admin.open();
  const btn = admin.document.querySelector('.je-arr-banner .je-ask-get');
  assert.equal(btn.querySelector('.je-ask-get-text').textContent, 'Search');
  assert.equal(btn.getAttribute('aria-label'), 'Search for the missing episodes: E2, E4');
  admin.click(btn);
  await settle(20);
  same({ path: admin.posts[0].path, key: admin.posts[0].body.key }, { path: '/arr/admin/manage/search', key: 'tv:tvdb:1:s1' });
  assert.equal(admin.document.querySelector('.je-arr-banner .je-ask-searched').textContent, 'Searching…');
  assert.equal(admin.toasts.at(-1), 'Search started; it shows here when a copy turns up');

  const kid = setup(t, { status: longMissing(), server: { rows: () => rowsBody({ source: 'destination', displayMissing: false }) } });
  await kid.open();
  kid.click(kid.document.querySelector('.je-arr-banner .je-ask-get'));
  await settle(20);
  same(kid.searches.map(s => s.body.key), ['tv:tvdb:1:s1', 'tv:tvdb:1:s1:e2', 'tv:tvdb:1:s1:e4']);
  assert.equal(kid.posts.length, 0, 'no request (F24)');
  assert.equal(kid.toasts.at(-1), "Nothing has been asked for here yet, so there's nothing to search again. Use Request to ask for it.");
});

// ------------------------------------------------------------------ review round 1

test('the banner is built once: re-applying the page keeps the banner, Get them and its focus (no rebuild loop)', async t => {
  let calls = 0;
  const h = setup(t, {
    server: { rows: () => rowsBody({ source: 'destination', displayMissing: false }) },
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
  const h = setup(t, { status: longMissing(), server: { rows: () => rowsBody({ source: 'destination', requests: { 2: 'asked', 4: 'waiting' } }) } });
  await h.open();
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  assert.equal(two.querySelector('.je-arr-chip').textContent, 'Missing');
  assert.equal(two.querySelector('.je-ask-get .je-ask-get-text').textContent, 'Search');
  const four = h.list().querySelector('.je-ask-row[data-je-ask-episode="4"]');
  assert.equal(four.querySelector('.je-arr-chip').textContent, 'Waiting for OK');
  assert.equal(four.querySelector('.je-ask-get'), null);

  // Someone else's ask, and the dialog of a JE row, follow the same rule.
  const household = setup(t, { status: longMissing(), server: { rows: () => rowsBody({ source: 'destination', requests: { 2: 'household', 4: 'declined' } }) } });
  await household.open();
  assert.equal(household.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get .je-ask-get-text').textContent, 'Search');
  assert.equal(household.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-arr-chip').textContent, 'Said no');
  household.JE.internals.arrAskEpisodes.openDetails(longMissing().episodes[1], { contact: 'Dad' }, household.NATIVE);
  await settle();
  const dialog = household.document.querySelector('.je-ask-dialog');
  assert.equal(dialog.querySelector('.je-ask-get .je-ask-get-text').textContent, 'Search', 'the dialog offers Search too');

  // The banner: Search for E2 next to E4's waiting chip.
  const banner = setup(t, { status: longMissing(), server: { rows: () => rowsBody({ source: 'destination', displayMissing: false, requests: { 2: 'asked', 4: 'waiting' } }) } });
  await banner.open();
  const action = banner.document.querySelector('.je-arr-banner .je-ask-banner-action');
  same([...action.querySelectorAll('.je-arr-chip')].map(c => c.textContent), ['E4 · Waiting for OK']);
  assert.equal(action.querySelector('.je-ask-get .je-ask-get-text').textContent, 'Search for E2');

  // Still fresh (Looking for it): the sent ask keeps its chip.
  const fresh = setup(t, { status: withEpisode(season(), 2, 'looking', 'looking'), server: { rows: () => rowsBody({ source: 'destination', requests: { 2: 'asked' } }) } });
  await fresh.open();
  assert.equal(fresh.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-arr-chip').textContent, 'Asked!');
  assert.equal(fresh.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get'), null);

  // Seen live: unmonitored in Sonarr after the ask went out (nobody fetches it): not "Asked!", but Get it again.
  const dropped = setup(t, { server: { rows: () => rowsBody({ source: 'destination', requests: { 2: 'asked' } }) } });
  await dropped.open();
  const two2 = dropped.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  assert.equal(two2.querySelector('.je-arr-chip').textContent, 'Missing');
  assert.ok(two2.querySelector('.je-ask-get'));
});

test('a Search pressed by someone who asks, with nothing sent, asks for nothing; after the season is read again it is still Search (F24)', async t => {
  const h = setup(t, {
    status: longMissing(),
    server: {
      me: { role: 'member', canRequest: true, contact: 'Dad', asksFirst: false },
      post: () => ({ status: 201, body: { outcome: 'accepted', reason: 'queued', certainty: 'Succeeded', message: 'Asked!', requestId: 'e'.repeat(32) } })
    }
  });
  await h.open();
  h.click(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get'));
  await settle(20);
  same(h.searches.map(s => s.body.key), ['tv:tvdb:1:s1:e2']);
  assert.equal(h.posts.length, 0, 'no request');
  same(h.toasts, ["Nothing has been asked for here yet, so there's nothing to search again. Use Request to ask for it."]);
  const two = () => h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  assert.equal(two().querySelector('.je-arr-chip').textContent, 'Missing');
  // The page drawn again: nothing was asked, so Search is still offered.
  h.JE.internals.arrStatusEpisodes.render(h.document.getElementById('itemDetailPage'), longMissing(), { contact: 'Dad' });
  await settle(20);
  assert.equal(two().querySelector('.je-arr-chip').textContent, 'Missing');
  assert.ok(two().querySelector('.je-ask-get.je-ask-search'), 'still Search');
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
  const body = rowsBody({ source: 'destination' });
  body.rows.key = 'tv:tvdb:2:s1';
  body.rows.series = 'tv:tvdb:2';
  return body;
}

function openDialog(h, episode = 2) {
  const title = h.list().querySelector(`.je-ask-row[data-je-ask-episode="${episode}"] .je-ask-row-title`);
  title.focus();
  h.click(title);
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
  h.setRows((n, path) => (path.includes(SEASON_B) ? otherRows() : rowsBody({ source: 'destination' })));
  h.window.location.hash = `#/details?id=${SEASON_B}`;
  await h.open();
  assert.ok(h.gets.some(p => p.includes(SEASON_B)), 'the new season was read');
  assert.equal(h.document.querySelector('.je-ask-dialog-backdrop'), null, 'the dialog closed with its season');
  // A press that still reaches the old button (it was on screen a moment ago) asks for nothing.
  h.click(get);
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
  rowsSearch.click(rowsSearch.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get'));
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
    server: { me: ADMIN_ME, meGate: () => gate, rows: () => rowsBody({ source: 'destination', displayMissing: false }), post: () => ({ status: 200, body: { status: 'Succeeded', found: false } }) }
  });
  await h.open();
  h.click(h.document.querySelector('.je-arr-banner .je-ask-get'));
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
      rows: () => rowsBody({ source: 'destination', canRequest: false, blocked: FULL_ADMIN }),
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
  h.click(dialog.querySelector('.je-ask-dialog-close'));
  assert.equal(h.document.querySelector('.je-ask-dialog'), null);
  h.click(row(2).querySelector('.je-ask-get'));
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
  h.click(dialog.querySelector('.je-ask-dialog-close'));
});

test('storage full in the banner: an administrator\'s Search for the long-missing ones and the paused line; once, not again above the list', async t => {
  const h = setup(t, {
    status: adminMixed(),
    config: { ArrManageDrawerEnabled: true },
    server: { me: ADMIN_ME, rows: () => rowsBody({ source: 'destination', displayMissing: false, canRequest: false, blocked: FULL_ADMIN }), post: () => ({ status: 200, body: { status: 'Succeeded', found: null } }) }
  });
  await h.open();
  const action = h.document.querySelector('.je-arr-banner .je-ask-banner-action');
  const btn = action.querySelector('.je-ask-get');
  same([btn.querySelector('.je-ask-get-text').textContent, btn.getAttribute('aria-label')], ['Search for E2', 'Search for the missing episodes: E2']);
  assert.equal(action.querySelector('.je-ask-paused-note .je-ask-paused-text').textContent, ADMIN_DETAIL);
  assert.equal(h.document.querySelector('.je-ask-season-note'), null, 'said once, in the banner');
  h.click(btn);
  await settle(20);
  same({ path: h.posts[0].path, key: h.posts[0].body.key }, { path: '/arr/admin/manage/search', key: 'tv:tvdb:1:s1:e2' });
  // Applying the page again keeps the banner as it is (no rebuild loop).
  const kept = h.document.querySelector('.je-arr-banner .je-ask-banner-action');
  h.JE.internals.arrStatusEpisodes.apply();
  await settle();
  assert.equal(h.document.querySelector('.je-arr-banner .je-ask-banner-action'), kept);
});

test('storage full: someone who may ask sees "Paused: storage full" and a plain sentence where Get it and Search would be, never a path', async t => {
  const h = setup(t, { status: longMissing(), server: { me: MEMBER_ME, rows: () => rowsBody({ source: 'destination', canRequest: false, blocked: FULL }) } });
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

  const banner = setup(t, { status: longMissing(), server: { me: MEMBER_ME, rows: () => rowsBody({ source: 'destination', displayMissing: false, canRequest: false, blocked: FULL }) } });
  await banner.open();
  const action = banner.document.querySelector('.je-arr-banner .je-ask-banner-action');
  assert.equal(action.querySelector('.je-ask-get'), null, 'no Get them, no Search');
  same([action.querySelector('.je-ask-paused-title').textContent, action.querySelector('.je-ask-paused-text').textContent], ['Paused: storage full', FAMILY_TEXT]);

  // An administrator without the Manage drawer has no Search of their own: paused like everyone else.
  const noDrawer = setup(t, { status: adminMixed(), server: { me: ADMIN_ME, rows: () => rowsBody({ source: 'destination', canRequest: false, blocked: FULL_ADMIN }) } });
  await noDrawer.open();
  assert.equal(noDrawer.document.querySelector('.je-ask-get'), null);
  assert.equal(noDrawer.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-paused').textContent, 'Paused: storage full');

  // Room again: Get it and Search as before, nothing paused.
  const roomy = setup(t, { status: longMissing(), server: { me: MEMBER_ME, rows: () => rowsBody({ source: 'destination' }) } });
  await roomy.open();
  same([...roomy.list().querySelectorAll('.je-ask-get')].map(b => b.dataset.mode), ['search', 'search']);
  assert.equal(roomy.document.querySelector('.je-ask-paused, .je-ask-paused-note'), null);
});

test('other refusals the request controls explain read "Can\'t ask right now"; an administrator learns which part needs a look', async t => {
  const member = setup(t, { status: longMissing(), server: { me: MEMBER_ME, rows: () => rowsBody({ source: 'destination', canRequest: false, blocked: { reason: 'instance_changed' } }) } });
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
  h.click(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get'));
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
  h.click(btn);
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
  h2.click(h2.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-ask-row-title'));
  const dialog = h2.document.querySelector('.je-ask-dialog');
  assert.equal(dialog.querySelector('.je-ask-dialog-note').textContent, 'Seerr takes whole seasons, so this asks for all of Season 1.');
  assert.equal(dialog.querySelector('.je-ask-get .je-ask-get-text').textContent, 'Get Season 1');
});

test('Seerr mode: the banner\'s Get them reads "Get Season 1" and asks for the season', async t => {
  const h = setup(t, { server: { me: SEERR_MEMBER, rows: () => rowsBody({ source: 'destination', displayMissing: false }) } });
  await h.open();
  await settle();
  const btn = h.document.querySelector('.je-arr-banner .je-ask-banner-action .je-ask-get');
  assert.equal(btn.querySelector('.je-ask-get-text').textContent, 'Get Season 1');
  assert.equal(btn.getAttribute('aria-label'), 'Get Season 1. Seerr takes whole seasons, so this asks for all of Season 1.');
  h.click(btn);
  await settle(20);
  same(h.posts.map(p => p.body.input), [{ key: 'tv:tvdb:1', scope: 'seasons', variant: 'standard', seasons: [1], episodes: [] }]);
});

// The real request changes the optimistic chip before the read model settles. Each refresh below
// uses the production details/status renderer, including its whole-banner replacement boundary.
for (const width of [1280, 390]) for (const replacement of ['action', 'banner']) for (const successor of ['button', 'chip']) {
  test(`focus: accepted season request survives ${replacement} replacement to ${successor} at ${width}px`, async t => {
    let holdRows = false;
    const pending = [];
    const server = {
      me: SEERR_MEMBER,
      rows: () => holdRows ? new Promise(resolve => pending.push(resolve)) : rowsBody({ displayMissing: false }),
      post: () => {
        holdRows = true;
        return { status: 201, body: { outcome: 'accepted', reason: 'queued_outage', certainty: 'Succeeded', message: 'Asked!', requestId: 'f'.repeat(32) } };
      }
    };
    const h = setup(t, { rows: row(1, { phone: width === 390 }), server });
    h.window.innerWidth = width;
    h.document.documentElement.classList.add(width === 390 ? 'layout-mobile' : 'layout-desktop');
    await h.open();
    const banner = h.document.querySelector('.je-arr-banner');
    const original = banner.querySelector('.je-ask-get-many');
    original.focus();
    assert.equal(h.document.activeElement, original);
    clickAsViewer(original);
    await settle(40);
    assert.equal(h.posts.length, 1, 'the real checked press reached the request endpoint');
    assert.equal(h.posts[0].body.expect.mode, 'get');
    assert.equal(original.isConnected, false, 'busy/result rendering replaced the initiating node');
    assert.ok(pending.length, 'the actual post-request season read is held');
    assert.match(banner.querySelector('.je-ask-banner-action').textContent, /Asked!/);
    // The server acknowledges this request, replacing the optimistic entry. A later complete
    // projection can offer another request or show its confirmed waiting state.
    holdRows = false;
    for (const resolve of pending.splice(0)) resolve(rowsBody({ displayMissing: false, seasonRequest: 'waiting' }));
    await settle(40);
    const oldAction = banner.querySelector('.je-ask-banner-action');
    const reads = h.gets.filter(path => path.startsWith('/acquire/requests/season/')).length;
    let settledRead = false;
    h.setRows(() => {
      settledRead = true;
      return rowsBody({ displayMissing: false, seasonRequest: successor === 'chip' ? 'declined' : null });
    });
    // The season's rows are read again when its status revision moves (play's in-place arrivals keep an unchanged status
    // from re-reading): the downloading episode gaining its library item keeps the banner, a regressed episode redraws it.
    h.setStatus(replacement === 'banner' ? withEpisode(withEpisode(season(), 3, 'notHere', 'unmonitored'), 1, 'notHere', 'unmonitored') : ({ ...season(), episodes: season().episodes.map(e => e.episode === 3 ? { ...e, itemId: ID(3) } : e) }));
    await h.JE.internals.arrStatusDetails.update(true);
    await settle(40);
    assert.ok(settledRead && h.gets.filter(path => path.startsWith('/acquire/requests/season/')).length > reads, 'a real settled season refresh completed');
    const currentBanner = h.document.querySelector('.je-arr-banner');
    assert.equal(currentBanner === banner, replacement === 'action', 'the designated replacement boundary ran');
    assert.equal(oldAction.isConnected, false, 'the earlier outcome subtree was replaced');
    const action = currentBanner.querySelector('.je-ask-banner-action');
    const expected = action.querySelector(successor === 'button' ? '.je-ask-get-many' : '.je-arr-chip');
    assert.ok(expected, 'the settled state has a deliberate focus successor');
    assert.equal(h.document.activeElement, expected, 'the semantic request origin survives settled redraws');
    assert.equal(h.posts.length, 1, 'focus recovery never sends another request');
  });
}

async function heldSeasonPress(t) {
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const server = { me: SEERR_MEMBER, rows: () => rowsBody({ displayMissing: false }), post: () => response };
  const h = setup(t, { server });
  await h.open();
  const original = h.document.querySelector('.je-arr-banner .je-ask-get-many');
  original.focus(); clickAsViewer(original);
  await settle(30);
  assert.equal(h.posts.length, 1, 'the actual request is pending');
  const other = h.document.createElement('button');
  other.textContent = 'Other action';
  h.document.querySelector('#itemDetailPage').prepend(other);
  return { h, server, original, other, finish: () => finish({ status: 201, body: { outcome: 'accepted', reason: 'queued_outage', certainty: 'Succeeded', requestId: 'f'.repeat(32) } }) };
}

for (const move of ['keyboard', 'activation']) test(`focus: accepted pending request respects deliberate ${move}`, async t => {
  const { h, other, finish } = await heldSeasonPress(t);
  if (move === 'keyboard') h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  other.focus();
  if (move === 'activation') clickAsViewer(other);
  finish(); await settle(40);
  h.setStatus(withEpisode(season(), 3, 'notHere', 'unmonitored'));
  await h.JE.internals.arrStatusDetails.update(true); await settle(30);
  assert.equal(h.document.activeElement, other, 'an old reply/redraw cannot reacquire focus');
});

for (const end of ['session', 'route', 'feature', 'container', 'stop']) test(`focus: accepted pending request ends ownership with ${end}`, async t => {
  const { h, other, finish } = await heldSeasonPress(t);
  if (end === 'session') h.switchUser();
  if (end === 'route') { h.navigate('#/home'); h.navigate(`#/details?id=${SEASON_ID}`); }
  if (end === 'feature') {
    h.JE.pluginConfig.ArrRequestsEnabled = false;
    h.JE.internals.arrStatusEpisodes.apply();
    h.JE.pluginConfig.ArrRequestsEnabled = true;
  }
  if (end === 'container') {
    h.document.body.appendChild(other);
    h.document.querySelector('#itemDetailPage').remove();
    h.document.body.insertAdjacentHTML('beforeend', page(row(1)));
  }
  if (end === 'stop') h.JE.internals.arrAskEpisodes.stop();
  other.focus(); finish(); await settle(40);
  h.setStatus(withEpisode(season(), 3, 'notHere', 'unmonitored'));
  await h.JE.internals.arrStatusDetails.update(true); await settle(30);
  assert.equal(h.document.activeElement, other, 'lifecycle-ended ownership cannot return on a reply');
});

test('focus: a pending request yields to another real episode modal', async t => {
  const { h, other, finish } = await heldSeasonPress(t);
  h.JE.internals.arrAskEpisodes.openDetails(season().episodes[2], {}, h.NATIVE);
  const modal = h.document.querySelector('[role="dialog"]');
  const active = h.document.activeElement;
  assert.ok(modal.contains(active));
  finish(); await settle(40);
  h.setStatus(withEpisode(season(), 3, 'notHere', 'unmonitored'));
  await h.JE.internals.arrStatusDetails.update(true); await settle(30);
  assert.equal(h.document.activeElement, active, 'the pending response leaves the modal in control');
  h.JE.internals.arrAskEpisodes.closeDialog();
  other.focus();
  await h.JE.internals.arrStatusDetails.update(true); await settle(30);
  assert.equal(h.document.activeElement, other, 'closing that modal does not revive the old press');
});

test('focus: a programmatic unfocused season request never takes another control\'s focus', async t => {
  const h = setup(t, { server: { me: SEERR_MEMBER, rows: () => rowsBody({ displayMissing: false }) } });
  await h.open();
  const other = h.document.createElement('button'); h.document.body.appendChild(other); other.focus();
  clickAsViewer(h.document.querySelector('.je-arr-banner .je-ask-get-many')); await settle(40);
  assert.equal(h.posts.length, 1);
  assert.equal(h.document.activeElement, other);
});

test('focus: an older accepted season response cannot supersede a different season\'s press', async t => {
  let finish;
  const first = new Promise(resolve => { finish = resolve; });
  const server = { post: () => first };
  const h = setup(t, { server });
  await h.open();
  const original = h.list().querySelector('[data-je-ask-episode="2"] .je-ask-get'); original.focus(); clickAsViewer(original); await settle(30);
  assert.equal(h.posts.length, 1);
  const nextId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2';
  const next = { ...season(), itemId: nextId, key: 'tv:tvdb:1:s2', episodes: season().episodes.map(ep => ({ ...ep, season: 2, key: ep.key.replace(':s1:', ':s2:') })) };
  h.setStatus(next);
  h.setRows(() => { const body = rowsBody({ requests: h.posts.length > 1 ? { 4: 'waiting' } : {}, source: 'destination' }); return { ...body, rows: { ...body.rows, season: 2, key: 'tv:tvdb:1:s2' } }; });
  h.navigate(`#/details?id=${nextId}`); await h.open();
  server.post = () => ({ status: 201, body: { outcome: 'accepted', reason: 'awaiting_approval', certainty: 'Succeeded', requestId: 'e'.repeat(32) } });
  const second = h.list().querySelector('[data-je-ask-episode="4"] .je-ask-get'); second.focus(); clickAsViewer(second); await settle(40);
  assert.equal(h.posts.length, 2);
  same(h.posts[1].body.input.episodes, [{ season: 2, episode: 4 }]);
  const current = h.document.activeElement;
  assert.ok(current.closest('[data-je-ask-episode="4"]'));
  finish({ status: 201, body: { outcome: 'accepted', reason: 'queued_outage', certainty: 'Succeeded', requestId: 'f'.repeat(32) } }); await settle(40);
  assert.equal(h.document.activeElement, current, 'the first season never takes focus from the second');
});

for (const [name, response] of [
  ['unavailable', { status: 503, body: { outcome: 'unavailable', reason: 'database_unavailable' } }],
  ['lost answer', new TypeError('Failed to fetch')],
  ['uncertain', { status: 202, body: { outcome: 'maybe_sent', certainty: 'Unknown' } }],
  ['unverified', { status: 409, body: { outcome: 'conflict', reason: 'press_unverified', certainty: 'Rejected' } }],
  ['changed', { status: 409, body: { outcome: 'conflict', reason: 'press_changed', certainty: 'Rejected' } }]
]) test(`focus: ${name} season result shares the checked press lifecycle`, async t => {
  const h = setup(t, { server: { me: SEERR_MEMBER, rows: () => rowsBody({ displayMissing: false }), post: () => response } });
  await h.open();
  const original = h.document.querySelector('.je-arr-banner .je-ask-get-many'); original.focus(); clickAsViewer(original); await settle(40);
  h.setStatus(withEpisode(season(), 3, 'notHere', 'unmonitored'));
  await h.JE.internals.arrStatusDetails.update(true); await settle(30);
  const active = h.document.activeElement;
  assert.ok(active !== h.document.body && active.isConnected && active.closest('.je-arr-banner'), 'result and later renderer preserve a reachable semantic place');
  assert.equal(h.posts.length, 1);
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
  h.click(btn);
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
  h.click(btn);
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

// ------------------------------------------------------------------ edition round 19: one press protocol, the server decides

/** The rows answer with each edition's request states: `requests` (standard asks) and `requests4k` (4K asks). */
function rowsByEdition({ requests = {}, requests4k = {}, displayMissing = true } = {}) {
  const body = rowsBody({ source: 'destination', displayMissing, requests });
  for (const e of body.rows.episodes) e.request4k = requests4k[e.episode] || null;
  return body;
}

test('press: Seerr turning to whole-series after "Get Season 1" was drawn never sends the whole series; nothing is widened behind the label', async t => {
  const server = { me: SEERR_MEMBER, rows: () => rowsBody({ source: 'destination', displayMissing: false }) };
  const h = setup(t, { server });
  h.JE.core.api.plugin = async (path) => (String(path).startsWith('/acquire/status?keys=')
    ? { items: [{ key: 'tv:tvdb:1', kind: 'series', seasons: [{ season: 0 }, { season: 1 }, { season: 2 }] }] }
    : { contact: 'Dad', items: [season()] });
  await h.open();
  await settle();
  const btn = h.document.querySelector('.je-arr-banner .je-ask-banner-action .je-ask-get');
  assert.equal(btn.querySelector('.je-ask-get-text').textContent, 'Get Season 1');
  // Seerr's partial-request setting is turned off after the page was drawn.
  server.me = { ...SEERR_MEMBER, seerrWholeSeries: true };
  clickAsViewer(btn);
  await settle(40);
  assert.ok(h.posts.every(p => JSON.stringify(p.body.input.seasons) === '[1]'), `posted ${JSON.stringify(h.posts.map(p => p.body.input))}`);
  assert.ok(h.posts.every(p => p.body.expect?.whole === false), 'whatever goes says what it was drawn as, so the server can refuse it');
  assert.ok(h.toasts.length > 0, 'the person is told');
});

test('press: a capabilities read that fails at the press sends nothing and says so', async t => {
  let fail = false;
  const server = { me: MEMBER_ME, rows: () => rowsBody({ source: 'destination', displayMissing: false }), meGate: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve()) };
  const h = setup(t, { server });
  await h.open();
  const btn = h.document.querySelector('.je-arr-banner .je-ask-get');
  assert.ok(btn, 'Get them drawn');
  fail = true;
  clickAsViewer(btn);
  await settle(40);
  same(h.posts, [], 'nothing sent on a failed check');
  assert.equal(h.toasts.at(-1), translate('arr_ask_check_failed'));
});

test('press: the episode dialog\'s Search and its row\'s Search for one episode run one search', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const server = { me: ADMIN_ME, post: () => ({ status: 200, body: { status: 'Succeeded', found: false } }) };
  const h = setup(t, { status: longMissing({ admin: true }), config: { ArrManageDrawerEnabled: true }, server });
  await h.open();
  const row = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get');
  const { get } = openDialog(h, 2);
  assert.ok(get && row, 'both offer Search for E2');
  // Both presses are checked while the first check's capability read is still out.
  server.meGate = () => gate;
  clickAsViewer(get);
  clickAsViewer(row);
  release();
  await settle(60);
  assert.equal(h.posts.filter(p => p.path === '/arr/admin/manage/search').length, 1, `posts ${JSON.stringify(h.posts.map(p => p.path))}`);
});

test('press: the same season read again while the press is checked still acts on what was drawn (never a silent drop)', async t => {
  let release;
  let held = false;
  const server = { me: KID_4K, rows: () => rowsBody({ source: 'destination', displayMissing: false }), meGate: () => (held ? new Promise(resolve => { release = resolve; }) : Promise.resolve()) };
  const status = withCopy(season(), [2, 4], '4k', { variant: '4k', ask: true, search: false, dest: 'd4k' });
  const h = setup(t, { status, server });
  await h.open();
  const btn = h.document.querySelector('.je-arr-banner .je-ask-get');
  held = true;
  clickAsViewer(btn);
  await settle(5);
  // The status of the same season is read again (a live update): a new state object, the same facts.
  h.setStatus(JSON.parse(JSON.stringify(status)));
  await h.JE.internals.arrStatusDetails.update(true);
  await settle();
  release();
  await settle(40);
  assert.ok(h.posts.length === 1 || h.toasts.length > 0, 'it acts, or says why not');
  assert.equal(h.posts.length, 1, 'nothing about the press changed: it is sent');
  assert.equal(h.posts[0].body.input.variant, '4k');
});

test('press: a refused press moves the focus to the control that replaced it, or a stable place on the page, never to nothing', async t => {
  const h = setup(t, { status: withCopy(season(), [2, 4], '4k', { variant: '4k', ask: true, search: false, dest: 'd4k' }), server: { me: KID_4K, rows: () => rowsBody({ source: 'destination', displayMissing: false }) } });
  await h.open();
  const btn = h.document.querySelector('.je-arr-banner .je-ask-get');
  btn.focus();
  // The binding moved after the page was drawn: a 4K ask no longer lands on this copy.
  h.setStatus(withCopy(season(), [2, 4], '4k', { variant: '4k', ask: false, search: false }));
  clickAsViewer(btn);
  await settle(40);
  same(h.posts, []);
  const active = h.document.activeElement;
  assert.ok(active && active !== h.document.body && h.document.contains(active), `focus on ${active?.tagName}.${active?.className}`);
  assert.ok(active.closest('#itemDetailPage'), 'on the season page');
});

test('press: a 4K copy\'s control reads the 4K asks; a standard ask never blocks a 4K gap', async t => {
  const status = withCopy(season(), [2, 4], '4k', { variant: '4k', ask: true, search: false, dest: 'd4k' });
  const h = setup(t, { status, server: { me: KID_4K, rows: () => rowsByEdition({ requests: { 2: 'waiting' }, requests4k: { 4: 'waiting' } }) } });
  await h.open();
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  const four = h.list().querySelector('.je-ask-row[data-je-ask-episode="4"]');
  assert.ok(two.querySelector('.je-ask-get'), 'E2: only a standard ask waits; the 4K gap can still be asked for');
  assert.match(two.querySelector('.je-ask-get').getAttribute('aria-label'), /4K/);
  assert.equal(four.querySelector('.je-arr-chip').textContent, translate('arr_ask_chip_waiting'), 'E4: its 4K ask waits for an OK');
  assert.equal(four.querySelector('.je-ask-get'), null);
});

test('press: an administrator\'s banner Search for E2 and E4 searches exactly E2 and E4', async t => {
  const h = setup(t, { status: longMissing({ admin: true }), config: { ArrManageDrawerEnabled: true }, server: {
    me: ADMIN_ME, rows: () => rowsBody({ source: 'destination', displayMissing: false }), post: () => ({ status: 200, body: { status: 'Succeeded', found: false } })
  } });
  await h.open();
  const button = h.document.querySelector('.je-arr-banner .je-ask-get');
  assert.match(button.getAttribute('aria-label'), /E2, E4/);
  clickAsViewer(button);
  await settle(24);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].path, '/arr/admin/manage/search');
  same(h.posts[0].body.episodes, [2, 4], 'the episodes it names, never the whole season');
});

test('press: every season-page control sends what it was drawn to do, and a server refusal redraws and says so', async t => {
  // Row Get it (title-wide).
  const a = setup(t);
  await a.open();
  clickAsViewer(a.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get'));
  await settle(20);
  same(a.posts[0].body.expect, { item: SEASON_ID, mode: 'get', episodes: [2], copy: null, variant: 'standard', dest: null, instance: null, whole: false, seasons: null });
  // Banner Get them in 4K (a copy's binding, with where the request lands).
  const b = setup(t, { status: withCopy(season(), [2, 4], '4k', { variant: '4k', ask: true, search: false, dest: 'd4k' }), server: { me: KID_4K, rows: () => rowsBody({ source: 'destination', displayMissing: false }) } });
  await b.open();
  clickAsViewer(b.document.querySelector('.je-arr-banner .je-ask-get'));
  await settle(20);
  same(b.posts[0].body.expect, { item: SEASON_ID, mode: 'get', episodes: [2, 4], copy: '4k', variant: '4k', dest: 'd4k', instance: null, whole: false, seasons: null });
  // An administrator's row Search (the instance it runs on).
  const c = setup(t, { status: longMissing({ admin: true }), config: { ArrManageDrawerEnabled: true }, server: { me: ADMIN_ME, post: () => ({ status: 200, body: { status: 'Succeeded', found: false } }) } });
  await c.open();
  clickAsViewer(c.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get'));
  await settle(20);
  same({ mode: c.posts[0].body.expect?.mode, instance: c.posts[0].body.expect?.instance, episodes: c.posts[0].body.expect?.episodes }, { mode: 'search', instance: 'son1', episodes: [2] });
  // A household Search.
  const d = setup(t, { status: longMissing(), server: { rows: () => rowsBody({ source: 'destination', requests: { 2: 'household' } }), search: () => ({ status: 200, body: { outcome: 'accepted', reason: 'searched', certainty: 'Succeeded', message: 'Searched.', found: false } }) } });
  await d.open();
  clickAsViewer(d.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get'));
  await settle(20);
  same({ mode: d.searches[0].body.expect?.mode, episodes: d.searches[0].body.expect?.episodes, item: d.searches[0].body.expect?.item }, { mode: 'search', episodes: [2], item: SEASON_ID });
  // The server refuses a press that no longer matches: the page is drawn again and the person told, nothing claimed as asked.
  const e = setup(t, { server: { post: () => ({ status: 409, body: { outcome: 'conflict', reason: 'press_changed', certainty: 'Rejected', message: 'Changed.' } }) } });
  await e.open();
  clickAsViewer(e.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get'));
  await settle(30);
  assert.equal(e.toasts.at(-1), translate('arr_ask_changed'));
  assert.notEqual(e.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-arr-chip').textContent, translate('arr_ask_chip_asked'));
});

// ------------------------------------------------------------------ edition round 20: per-edition capabilities, focus, Seerr mode

/** The rows answer with each edition's own policy answer: the standard edition's (`canRequest`, `blocked`) and the 4K one's. */
function rowsPerEdition({ canRequest = true, blocked = null, canRequest4k = true, blocked4k = null, displayMissing = true } = {}) {
  const body = rowsBody({ source: 'destination', displayMissing, canRequest, blocked });
  body.rows.canRequest4k = canRequest4k;
  body.rows.blocked4k = blocked4k;
  return body;
}

const FOUR_K_COPY = { variant: '4k', ask: true, search: false, dest: 'd4k' };

test('per edition: a 4K copy\'s Get it is offered while only the standard edition is paused (its drive is full)', async t => {
  const rows = setup(t, { status: withCopy(season(), [2, 4], '4k', FOUR_K_COPY), server: { me: KID_4K, rows: () => rowsPerEdition({ canRequest: false, blocked: FULL }) } });
  await rows.open();
  for (const n of [2, 4]) {
    const row = rows.list().querySelector(`.je-ask-row[data-je-ask-episode="${n}"]`);
    const get = row.querySelector('.je-ask-get');
    assert.ok(get, `E${n}: the 4K gap can be asked for in 4K`);
    assert.match(get.getAttribute('aria-label'), /4K/);
    assert.equal(row.querySelector('.je-ask-paused'), null, `E${n}: the standard edition's pause is not this control's`);
  }
  const banner = setup(t, { status: withCopy(season(), [2, 4], '4k', FOUR_K_COPY), server: { me: KID_4K, rows: () => rowsPerEdition({ canRequest: false, blocked: FULL, displayMissing: false }) } });
  await banner.open();
  const btn = banner.document.querySelector('.je-arr-banner .je-ask-get');
  assert.ok(btn, 'Get them in 4K drawn');
  assert.equal(btn.textContent, 'downloadGet them in 4K');
  clickAsViewer(btn);
  await settle(20);
  assert.equal(banner.posts.length, 1);
  assert.equal(banner.posts[0].body.input.variant, '4k');
});

test('per edition: a 4K copy\'s gap says the 4K edition\'s pause, and no 4K Get it, while the standard edition may still ask', async t => {
  const h = setup(t, { status: withCopy(season(), [2, 4], '4k', FOUR_K_COPY), server: { me: KID_4K, rows: () => rowsPerEdition({ canRequest4k: false, blocked4k: FULL }) } });
  await h.open();
  for (const n of [2, 4]) {
    const row = h.list().querySelector(`.je-ask-row[data-je-ask-episode="${n}"]`);
    assert.equal(row.querySelector('.je-ask-get'), null, `E${n}: no 4K ask while the 4K edition is paused`);
    assert.equal(row.querySelector('.je-ask-paused')?.textContent, 'Paused: storage full', `E${n}: the 4K edition's own pause`);
    assert.equal(row.querySelector('.je-ask-paused')?.title, FAMILY_TEXT);
  }
  // The 4K edition's own refusal is what the banner says too.
  const banner = setup(t, { status: withCopy(season(), [2, 4], '4k', FOUR_K_COPY), server: { me: KID_4K, rows: () => rowsPerEdition({ canRequest4k: false, blocked4k: FULL, displayMissing: false }) } });
  await banner.open();
  const action = banner.document.querySelector('.je-arr-banner .je-ask-banner-action');
  assert.equal(action?.querySelector('.je-ask-get') ?? null, null, 'no Get them in 4K');
  assert.equal(action?.querySelector('.je-ask-paused-title')?.textContent, 'Paused: storage full');
});

test('focus: a refused press keeps the focus on the page however long the redraw after it takes', async t => {
  let release = null;
  const server = { me: KID_4K, rows: () => rowsBody({ source: 'destination', displayMissing: false }) };
  const h = setup(t, { status: withCopy(season(), [2, 4], '4k', FOUR_K_COPY), server });
  await h.open();
  const plugin = h.JE.core.api.plugin;
  server.post = () => {
    // The server refuses (the binding moved), and the season's status read again is slow to come back.
    h.setStatus(withCopy(season(), [2, 4], '4k', { variant: '4k', ask: false, search: false }));
    const gate = new Promise(resolve => { release = resolve; });
    h.JE.core.api.plugin = async (...args) => { await gate; return plugin(...args); };
    return { status: 409, body: { outcome: 'conflict', reason: 'press_changed', certainty: 'Rejected', message: 'Changed.' } };
  };
  const btn = h.document.querySelector('.je-arr-banner .je-ask-get');
  btn.focus();
  clickAsViewer(btn);
  await settle(40);
  assert.ok(release, 'the press reached the server');
  // Five seconds pass before the status read comes back and the page is drawn without the button.
  const realNow = h.window.Date.now;
  h.window.Date.now = () => realNow() + 5000;
  release();
  await settle(40);
  h.JE.internals.arrStatusEpisodes.apply();
  await settle(10);
  assert.equal(h.document.querySelector('.je-arr-banner .je-ask-get'), null, 'the 4K button is gone after the redraw');
  const active = h.document.activeElement;
  assert.ok(active && active !== h.document.body && h.document.contains(active), `focus on ${active?.tagName}.${active?.className}`);
  assert.ok(active.closest('#itemDetailPage'), 'on the season page');
});

test('focus: a Get it refused from the episode dialog on a TV keeps the focus on the page after its row is gone', async t => {
  let release;
  const server = {};
  const h = setup(t, { server });
  h.document.documentElement.classList.add('layout-tv');
  await h.open();
  const plugin = h.JE.core.api.plugin;
  server.post = () => {
    // The episode arrived meanwhile: the server refuses, and the status read that redraws the page is slow.
    h.setStatus(withEpisode(season(), 2, 'ready', 'ready'));
    const gate = new Promise(resolve => { release = resolve; });
    h.JE.core.api.plugin = async (...args) => { await gate; return plugin(...args); };
    return { status: 409, body: { outcome: 'conflict', reason: 'press_changed', certainty: 'Rejected', message: 'Changed.' } };
  };
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  two.focus();
  clickAsViewer(two);
  clickAsViewer(h.document.querySelector('.je-ask-dialog .je-ask-get'));
  await settle(40);
  assert.ok(release, 'the press reached the server');
  assert.equal(h.document.activeElement.dataset.jeAskEpisode, '2', 'the dialog gave the focus back to its row');
  release();
  await settle(40);
  h.JE.internals.arrStatusEpisodes.apply();
  await settle(10);
  assert.equal(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]'), null, 'the row is gone after the redraw');
  const active = h.document.activeElement;
  assert.ok(active && active !== h.document.body && h.document.contains(active) && active.closest('#itemDetailPage'),
    `focus after the refusal and redraw: ${active?.tagName}.${active?.className}`);
});

test('focus: on a TV, a Get it refused after a live redraw removed its row while the dialog was open lands next to that row', async t => {
  const server = {};
  const h = setup(t, { server });
  h.document.documentElement.classList.add('layout-tv');
  await h.open();
  server.post = () => ({ status: 409, body: { outcome: 'conflict', reason: 'press_changed', certainty: 'Rejected', message: 'Changed.' } });
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  two.focus();
  clickAsViewer(two);
  const get = h.document.querySelector('.je-ask-dialog .je-ask-get');
  assert.ok(get, 'the dialog offers Get it');
  // The episode arrives and the page is drawn again (a live update) while the dialog is still open: its row goes.
  h.setStatus(withEpisode(season(), 2, 'ready', 'ready'));
  await h.JE.internals.arrStatusDetails.update(true);
  await settle(20);
  h.JE.internals.arrStatusEpisodes.apply();
  await settle(20);
  assert.equal(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]'), null, 'the row is gone before the press');
  assert.ok(h.document.querySelector('.je-ask-dialog .je-ask-get'), 'the dialog is still open');
  get.focus();
  clickAsViewer(get);
  await settle(40);
  h.JE.internals.arrStatusEpisodes.apply();
  await settle(10);
  const active = h.document.activeElement;
  assert.ok(active && active !== h.document.body && h.document.contains(active) && active.closest('#itemDetailPage'),
    `focus after the refusal: ${active?.tagName}.${active?.className}`);
});

test('focus: when the host draws the list again under the recovered focus and moves it to the top, the next redraw puts it back by the row', async t => {
  const server = {};
  const h = setup(t, { server });
  h.document.documentElement.classList.add('layout-tv');
  await h.open();
  server.post = () => {
    h.setStatus(withEpisode(season(), 2, 'ready', 'ready'));
    return { status: 409, body: { outcome: 'conflict', reason: 'press_changed', certainty: 'Rejected', message: 'Changed.' } };
  };
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  two.focus();
  clickAsViewer(two);
  clickAsViewer(h.document.querySelector('.je-ask-dialog .je-ask-get'));
  await settle(40);
  h.JE.internals.arrStatusEpisodes.apply();
  await settle(10);
  const recovered = h.document.activeElement;
  const row = recovered?.closest?.('.listItem');
  assert.ok(row && row.dataset.jeAskEpisode !== '2', `recovered next to the row: ${recovered?.className}`);
  // The host refreshes its page by itself: its focus manager takes the page's first button (no key or click of the person's),
  // then its list is drawn again (the row that had the focus is replaced).
  const page = h.document.querySelector('#itemDetailPage');
  const top = h.document.createElement('button');
  top.className = 'btnPlay';
  page.prepend(top);
  top.focus();
  row.replaceWith(row.cloneNode(true));
  h.JE.internals.arrStatusEpisodes.apply();
  await settle(10);
  const active = h.document.activeElement;
  assert.notEqual(active, top, 'not left on the top button');
  assert.equal(active?.closest?.('.listItem')?.dataset?.jeAskEpisode, row.dataset.jeAskEpisode, 'back by the row');
});

test('focus: a refused press never takes the focus back from where the person moved it', async t => {
  let release;
  const server = {};
  const h = setup(t, { server });
  h.document.documentElement.classList.add('layout-tv');
  await h.open();
  const plugin = h.JE.core.api.plugin;
  server.post = () => {
    h.setStatus(withEpisode(season(), 2, 'ready', 'ready'));
    const gate = new Promise(resolve => { release = resolve; });
    h.JE.core.api.plugin = async (...args) => { await gate; return plugin(...args); };
    return { status: 409, body: { outcome: 'conflict', reason: 'press_changed', certainty: 'Rejected', message: 'Changed.' } };
  };
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  two.focus();
  clickAsViewer(two);
  clickAsViewer(h.document.querySelector('.je-ask-dialog .je-ask-get'));
  await settle(40);
  // The person moves on to another row before the redraw.
  const other = h.list().querySelector('.je-ask-row:not([data-je-ask-episode="2"])') || h.list().firstElementChild;
  if (other.tagName !== 'BUTTON' && !other.hasAttribute('tabindex')) other.tabIndex = -1;
  h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  other.focus();
  release();
  await settle(40);
  h.JE.internals.arrStatusEpisodes.apply();
  await settle(10);
  assert.ok(h.document.contains(other), 'the row the person moved to is still there');
  assert.equal(h.document.activeElement, other, 'the deliberate move stands');
});

test('Seerr mode: a copy\'s gap gets no copy-qualified control, whatever an older server says about its binding', async t => {
  const status = withCopy(season(), [2], '4k', FOUR_K_COPY);
  const h = setup(t, { status, server: { me: { ...SEERR_MEMBER, can4kSeries: true } } });
  await h.open();
  await settle();
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  assert.equal(two.querySelector('.je-ask-get'), null, 'no "Get it in 4K" for the 4K copy in Seerr mode');
  // The title-wide control (an episode no copy plays) is Seerr's ordinary season request.
  const four = h.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-ask-get');
  assert.ok(four, 'the ordinary Seerr ask stays');
  assert.equal(four.querySelector('.je-ask-get-text').textContent, 'Get Season 1');
  clickAsViewer(four);
  await settle(20);
  assert.equal(h.posts.length, 1);
  same({ variant: h.posts[0].body.input.variant, scope: h.posts[0].body.input.scope, copy: h.posts[0].body.expect?.copy ?? null }, { variant: 'standard', scope: 'seasons', copy: null });
});

// Any deliberate activation ends focus recovery (D53, edition round 22): a screen reader synthesizes the click (and the focus
// it gives) without a key, pointer or mouse event first; a later row redraw must leave the focus where the person put it.
test('focus: an assistive-technology click ends the recovery before a later row redraw', async t => {
  const server = {};
  const h = setup(t, { server });
  h.document.documentElement.classList.add('layout-tv');
  await h.open();
  server.post = () => {
    h.setStatus(withEpisode(season(), 2, 'ready', 'ready'));
    return { status: 409, body: { outcome: 'conflict', reason: 'press_changed', certainty: 'Rejected', message: 'Changed.' } };
  };
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  two.focus(); clickAsViewer(two);
  clickAsViewer(h.document.querySelector('.je-ask-dialog .je-ask-get'));
  await settle(40);
  h.JE.internals.arrStatusEpisodes.apply();
  await settle(10);
  const recovered = h.document.activeElement;
  const priorRow = recovered.closest('.listItem');
  assert.ok(priorRow, 'focus recovery ran');
  const button = h.document.createElement('button');
  button.textContent = 'Show options';
  h.document.querySelector('#itemDetailPage').prepend(button);
  button.addEventListener('click', () => button.focus());
  clickAsViewer(button);
  assert.equal(h.document.activeElement, button, 'the person deliberately activated another control');
  priorRow.replaceWith(priorRow.cloneNode(true));
  h.JE.internals.arrStatusEpisodes.apply();
  await settle(10);
  assert.equal(h.document.activeElement, button, 'a later refresh must not take focus away from the new control');
});

// Activating the control the recovery put the focus on is deliberate too (it ends the recovery without any focus change):
// when the host then moves the focus by itself and redraws the row, nothing pulls it back.
test('focus: activating the recovered control itself ends the recovery', async t => {
  const server = {};
  const h = setup(t, { server });
  h.document.documentElement.classList.add('layout-tv');
  await h.open();
  server.post = () => {
    h.setStatus(withEpisode(season(), 2, 'ready', 'ready'));
    return { status: 409, body: { outcome: 'conflict', reason: 'press_changed', certainty: 'Rejected', message: 'Changed.' } };
  };
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  two.focus(); clickAsViewer(two);
  clickAsViewer(h.document.querySelector('.je-ask-dialog .je-ask-get'));
  await settle(40);
  h.JE.internals.arrStatusEpisodes.apply();
  await settle(10);
  const recovered = h.document.activeElement;
  const row = recovered.closest('.listItem');
  assert.ok(row, 'focus recovery ran');
  // The person activates the recovered control (Enter on a TV remote synthesizes this click; no focus change follows).
  recovered.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  h.document.querySelectorAll('.je-ask-dialog').forEach(d => d.remove());
  const top = h.document.createElement('button');
  top.className = 'btnPlay';
  h.document.querySelector('#itemDetailPage').prepend(top);
  top.focus();
  row.replaceWith(row.cloneNode(true));
  h.JE.internals.arrStatusEpisodes.apply();
  await settle(10);
  assert.equal(h.document.activeElement, top, 'the recovery ended at the activation; the later focus stands');
});

// ------------------------------------------------------------------ UX-3: one episode numbering across page, picker and arr

test('singleEpisodesAskable: only the target\'s own numbering, or TMDB\'s while no arr holds the season, lets single episodes be asked for', t => {
  const h = setup(t);
  const { episodeSource: source, singleEpisodesAskable: ok, heldReason: why } = h.JE.arrAsk;
  assert.equal(source({ source: 'destination' }), 'destination');
  assert.equal(source({ source: 'made-up' }), 'unknown');
  assert.equal(source(null), 'unknown');
  assert.equal(ok({ source: 'destination' }, { arrHolds: true }), true);
  assert.equal(ok({ source: 'provider' }, { arrHolds: false }), true);
  // TMDB's numbers on a season an arr numbers itself: held (the rows were read before the arr had it, say).
  assert.equal(ok({ source: 'provider' }, { arrHolds: true }), false);
  // UX2R2-5/-6 class: unread, unknown, unchecked or no source at all never let a number through.
  for (const rows of [null, {}, { source: 'unknown' }, { source: 'unchecked' }, { episodes: [{ episode: 1, title: 'One' }] }]) assert.equal(ok(rows, { arrHolds: false }), false, JSON.stringify(rows));
  assert.equal(why({ episodes: [{ episode: 1, title: 'One' }] }, { arrHolds: true }), 'differently');
  assert.equal(why({ source: 'provider', episodes: [{ episode: 1, title: 'One' }] }, { arrHolds: true }), 'differently');
  assert.equal(why({ episodes: [] }, { arrHolds: true }), 'unchecked');
  assert.equal(why({ source: 'unknown', episodes: [] }, { arrHolds: true }), 'unchecked');
  assert.equal(why(null, { arrHolds: true }), 'unchecked');
});

/** The season of a title that isn't in the library: TMDB lists E1–E3, the arr E1–E4 (E2 and E4 missing, nobody fetching). */
function absentSeason({ e2Day = '2014-06-08' } = {}) {
  return {
    key: 'tv:tvdb:1:s1', itemId: SEASON_ID, kind: 'season', stage: 'notHere', reason: { code: 'unmonitored' },
    summary: { aired: 4, ready: 1, missing: 2 },
    episodes: [
      { key: 'tv:tvdb:1:s1:e1', season: 1, episode: 1, row: false, stage: 'ready', reason: { code: 'ready' }, airDate: '2014-06-01T00:00:00Z' },
      { key: 'tv:tvdb:1:s1:e2', season: 1, episode: 2, row: false, stage: 'notHere', reason: { code: 'unmonitored' }, airDate: `${e2Day}T00:00:00Z` },
      { key: 'tv:tvdb:1:s1:e3', season: 1, episode: 3, row: false, stage: 'downloading', reason: { code: 'downloading' }, airDate: '2014-06-15T00:00:00Z' },
      { key: 'tv:tvdb:1:s1:e4', season: 1, episode: 4, row: false, stage: 'notHere', reason: { code: 'unmonitored' }, airDate: '2014-06-22T00:00:00Z' }
    ]
  };
}

function providerRows() {
  const body = rowsBody();
  body.rows.episodes = body.rows.episodes.filter(e => e.episode !== 4);
  body.rows.providerEpisodes = [1, 2, 3];
  return body;
}

test('UX-3 (round 3): when Sonarr holds an absent season its rows are Sonarr\'s, by Sonarr\'s numbers, titles and days, and ask for exactly those', async t => {
  // Sonarr's list: E2 "Sonarr Two", E4 "Sonarr Four" (TMDB has no E4); the page's own rows are TMDB's and give way.
  const status = absentSeason();
  status.episodes = status.episodes.map(e => ({ ...e, itemId: e.episode === 2 ? ID(2) : null, row: e.episode === 2 }));
  const sonarr = () => { const body = rowsBody({ source: 'destination' }); body.rows.source = 'destination';
    body.rows.episodes = [{ episode: 1 }, { episode: 2, title: 'Sonarr Two', airDate: '2014-06-08', aired: true }, { episode: 3 }, { episode: 4, title: 'Sonarr Four', airDate: '2014-06-22', aired: true }]; return body; };
  const h = setup(t, { rows: row(1) + row(2, { virtual: true }), status, server: { rows: sonarr } });
  h.JE.titleDetails = { isSynthetic: id => id === SEASON_ID };
  await h.open();
  assert.ok(h.list().querySelector(`.listItem[data-id="${ID(2)}"]`).classList.contains('je-ask-replaced'), 'the TMDB row gives way');
  assert.equal(h.list().querySelector(`.listItem[data-id="${ID(2)}"] .je-ask-get`), null);
  const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
  assert.equal(two.querySelector('.je-ask-row-title bdi').textContent, '2. Sonarr Two');
  assert.equal(h.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-ask-row-title bdi').textContent, '4. Sonarr Four');
  assert.ok(!h.list().textContent.includes('Second one.'), 'no TMDB facts on Sonarr\'s numbers');
  assert.equal(h.document.querySelector('.je-ask-numbering-note'), null);
  h.click(two.querySelector('.je-ask-get'));
  await settle();
  same(h.posts.map(p => p.body.input.episodes), [[{ season: 1, episode: 2 }]]);
});

test('UX-3 (round 3): an absent season no arr holds keeps its own TMDB rows, and they may be asked for by TMDB\'s numbers', async t => {
  const status = absentSeason();
  status.episodes = status.episodes.map(e => ({ ...e, reason: { code: 'not_in_arr' }, itemId: e.episode === 2 ? ID(2) : null, row: e.episode === 2 }));
  const provider = () => { const body = rowsBody({ source: 'destination' }); body.rows.source = 'provider'; return body; };
  const h = setup(t, { rows: row(1) + row(2, { virtual: true }), status, server: { rows: provider } });
  h.JE.titleDetails = { isSynthetic: id => id === SEASON_ID };
  await h.open();
  const native = h.list().querySelector(`.listItem[data-id="${ID(2)}"]`);
  assert.ok(!native.classList.contains('je-ask-replaced'));
  assert.ok(native.querySelector('.je-ask-get'), 'TMDB\'s numbers are what a request names');
});

test('UX-3: when the arr numbers a season differently, its episodes shown with TMDB\'s facts are held and say why; nothing is sent', async t => {
  const h = setup(t, { status: absentSeason({ e2Day: '2014-08-31' }), server: { rows: () => providerRows() } });
  h.JE.titleDetails = { isSynthetic: id => id === SEASON_ID };
  await h.open();
  for (const n of [2, 4]) {
    const r = h.list().querySelector(`.je-ask-row[data-je-ask-episode="${n}"]`);
    assert.equal(r.querySelector('.je-ask-get'), null, `E${n} has no Get it`);
    assert.equal(r.querySelector('.je-ask-paused').textContent, 'Numbered differently');
  }
  const note = h.document.querySelector('.je-ask-season-note.je-ask-numbering-note');
  assert.ok(note, 'the season says why above its episodes');
  assert.match(note.textContent, /numbered differently here and on TMDB/);
  // The episode's dialog holds it too.
  h.click(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-row-title'));
  await settle();
  const dialog = h.document.querySelector('.je-ask-dialog');
  assert.ok(dialog.querySelector('.je-ask-numbering-note'));
  assert.equal(dialog.querySelector('.je-ask-get'), null);
  assert.equal(h.posts.length, 0);
});

test('UX-3: a library season\'s own Jellyfin rows are not held by TMDB\'s numbering', async t => {
  const status = absentSeason({ e2Day: '2014-08-31' });
  status.episodes[1] = { ...status.episodes[1], itemId: ID(2), row: true };
  const h = setup(t, { rows: row(1) + row(2, { virtual: true }), status, server: { rows: () => providerRows() } });
  await h.open();
  const native = h.list().querySelector(`.listItem[data-id="${ID(2)}"]`);
  assert.ok(native.querySelector('.je-ask-get'), 'Jellyfin\'s row shows Jellyfin\'s facts for the arr\'s episode');
  assert.equal(h.list().querySelector('.je-ask-row[data-je-ask-episode="4"] .je-ask-get'), null, 'JE\'s TMDB-described row is held');
});

test('UX2R-3 / UX2R2-5: a season whose numbering can\'t be established holds the rows it describes (fail closed), and says so', async t => {
  for (const failure of ['error', 'no source', 'unknown', 'unchecked']) {
    const h = setup(t, { status: absentSeason(), server: { rows: () => {
      if (failure === 'error') return new Error('503');
      const body = rowsBody({ source: 'destination' });
      body.rows.episodes = body.rows.episodes.map(e => ({ episode: e.episode, request: e.request }));      // no facts to go by
      if (failure === 'no source') delete body.rows.source;
      else body.rows.source = failure;
      return body;
    } } });
    h.JE.titleDetails = { isSynthetic: id => id === SEASON_ID };
    await h.open();
    if (failure === 'error') {
      // No rows to draw JE's rows with: nothing is offered on a guess.
      assert.equal(h.document.querySelectorAll('.je-ask-get').length, 0, failure);
      // The page's own (TMDB) row of a missing episode isn't offered either while the season can't be read.
      const status = absentSeason();
      status.episodes[1] = { ...status.episodes[1], itemId: ID(2), row: true };
      const facade = setup(t, { rows: row(1) + row(2, { virtual: true }), status, server: { rows: () => new Error('503') } });
      facade.JE.titleDetails = { isSynthetic: id => id === SEASON_ID };
      await facade.open();
      assert.ok(facade.list().querySelector(`.listItem[data-id="${ID(2)}"] .je-arr-chip`), 'the row is decorated');
      assert.equal(facade.list().querySelector(`.listItem[data-id="${ID(2)}"] .je-ask-get`), null, 'held while unchecked');
      continue;
    }
    const two = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"]');
    assert.equal(two.querySelector('.je-ask-get'), null, failure);
    assert.equal(two.querySelector('.je-ask-paused').textContent, "Couldn't check", failure);
    assert.match(h.document.querySelector('.je-ask-numbering-note').textContent, /couldn't be checked right now/, failure);
    assert.equal(h.posts.length, 0);
  }
});

// Review round 2 probe (a control), updated for F24: season-row and banner Search, pressed twice, search once and ask for
// nothing (their former ask fallback is gone, like the title's Search).
test('UX2R2 probe: season row and banner Search, pressed twice, search once and ask for nothing', async t => {
  for (const surface of ['row', 'banner']) {
    const h = setup(t, { status: longMissing(), server: { rows: () => rowsBody({ source: 'destination', displayMissing: surface === 'row' }) } });
    await h.open();
    const button = surface === 'row' ? h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get') : h.document.querySelector('.je-arr-banner .je-ask-get');
    h.click(button); h.click(button); await settle(30);
    assert.equal(h.posts.length, 0, surface);
    assert.equal(h.searches.length, surface === 'row' ? 1 : 3, surface);
    same(h.toasts, ["Nothing has been asked for here yet, so there's nothing to search again. Use Request to ask for it."], surface);
  }
});

// Review round 3 probe (UX2R3-1), ported: a failed browser refresh never reuses the rows of an earlier read to authorize.
test('UX2R3-1 probe: a failed refresh cannot reuse a warm destination source to authorize single episodes', async t => {
  const h = setup(t, { status: absentSeason(), server: { rows: () => { const b = rowsBody({ source: 'destination' }); b.rows.episodes = [{ episode: 2, title: 'Destination Two', airDate: '2014-06-08', aired: true }, { episode: 4, title: 'Destination Four', airDate: '2014-06-22', aired: true }]; return b; } } });
  h.JE.titleDetails = { isSynthetic: id => id === SEASON_ID }; await h.open();
  assert.ok(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get'));
  const firstReads = h.gets.filter(p => p.startsWith('/acquire/requests/season/')).length;
  h.setRows(() => new Error('synthetic unavailable'));
  const updated = absentSeason(); updated.episodes[2] = { ...updated.episodes[2], row: true, itemId: ID(3) };
  h.setStatus(updated); await h.JE.internals.arrStatusDetails.update(true); await settle(30);
  assert.ok(h.gets.filter(p => p.startsWith('/acquire/requests/season/')).length > firstReads, 'a second rows read really failed');
  const button = h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get');
  if (button) h.click(button); await settle(30);
  assert.equal(h.posts.length, 0, 'unread current facts hold rather than authorize with the previous rows');
  assert.equal(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-paused').textContent, "Couldn't check");
  // A read that succeeds again re-establishes it.
  h.setRows(() => { const b = rowsBody({ source: 'destination' }); b.rows.episodes = [{ episode: 2, title: 'Destination Two', airDate: '2014-06-08', aired: true }, { episode: 4, title: 'Destination Four', airDate: '2014-06-22', aired: true }]; return b; });
  h.setStatus(absentSeason()); await h.JE.internals.arrStatusDetails.update(true); await settle(30);
  assert.ok(h.list().querySelector('.je-ask-row[data-je-ask-episode="2"] .je-ask-get'), 'established again');
});

// Review round 5 probe (UX2R5-1), ported: the provider season page answer the server gave for TMDB's placeholder date before the
// fix (status: aired, "not here"; rows: aired false). The page holds the episode as the picker does, and nothing is sent.
test('UX2R5-1 probe: a provider page never offers or posts an episode its rows say hasn\'t aired', async t => {
  const status = { key: 'tv:tvdb:100:s1', itemId: SEASON_ID, kind: 'season', stage: 'notHere', reason: { code: 'not_in_arr' }, summary: { aired: 1, ready: 0 },
    episodes: [{ key: 'tv:tvdb:100:s1:e1', season: 1, episode: 1, itemId: ID(1), row: true, stage: 'notHere', reason: { code: 'not_in_arr' }, airDate: '0001-01-01T00:00:00Z' }] };
  const rows = { key: 'tv:tvdb:100:s1', series: 'tv:tvdb:100', season: 1, seriesId: 'ccccccccccccccccccccccccccccccc1', displayMissing: false, canRequest: true, source: 'provider',
    episodes: [{ episode: 1, title: 'Episode', airDate: '0001-01-01', aired: false }] };
  const h = setup(t, { rows: row(1, { virtual: true }), status, server: { rows: () => ({ outcome: 'accepted', rows }) } });
  h.JE.titleDetails = { isSynthetic: id => id === SEASON_ID };
  await h.open();
  const button = h.list().querySelector('.je-ask-get');
  if (button) h.click(button);
  await settle(30);
  assert.equal(h.posts.length, 0, 'an episode refused as unaired in the picker is not requested by the page');
  assert.equal(button, null, 'no request action for the unknown date');
});
