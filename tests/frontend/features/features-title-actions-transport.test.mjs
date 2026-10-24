import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createHarness, deferred, jsonResponse, jsRoot } from '../helpers/harness.mjs';

// D46 slice 2 review round 4, Part B (D46S2-R4-1): checked at the send. Every write an action-bar operation owns
// goes through D46's bound-request primitive with current() = the operation, so the REAL core transport checks it
// right before the bytes go out, after its queue (4 slots) has released it. Here the pool is full, the write is
// submitted under a current operation (so every owner's own checks pass and it waits in the queue), the operation
// ends (the person leaves the page), and the pool is released: nothing is sent. The control sends once. Real core
// modules (navigation, session, session-action, api-client), the real owners and title actions; fetch is the only fixture.

const tick = () => new Promise(r => setImmediate(r));
async function settle(n = 40) { for (let i = 0; i < n; i++) await tick(); }
const delivered = async () => { await wait(0); await settle(); };
const OVERVIEW = { key: 'movie:tmdb:603', kind: 'movie', title: 'The Matrix', tmdbId: 603, requests: [],
  instances: [{ id: 'r1', name: 'Radarr', role: 'standard', url: 'http://radarr.test', readable: true, inArr: true, monitored: true }] };
const MEMBER = { role: 'member', canRequest: true, canRequestMovies: true, canRequestSeries: true, canApprove: false, asksFirst: false,
  can4kMovies: false, can4kSeries: false, backend: 'je', contact: 'Dad', freeEpisodes: 5 };

function setup(t) {
  const sent = [];
  const hooks = {};
  const h = createHarness({
    url: 'http://jellyfin.test/web/index.html#/details?id=x',
    html: '<div id="page"><div class="mainDetailButtons"></div></div>',
    JE: {
      t: k => k, toast() {}, icon: () => '', escapeHtml: s => String(s),
      pluginConfig: { ArrStatusEnabled: true, ArrRequestsEnabled: true, ArrManageDrawerEnabled: true, ArrNotificationsEnabled: true,
        JellyseerrEnabled: true, SpoilerBlurEnabled: true, HiddenContentEnabled: true },
      userConfig: { hiddenContent: { items: {}, settings: {} } },
      helpers: { debounce: fn => fn, trackUsage() {}, addCSS() {}, getItemCached: async () => null, onBodyMutation: () => ({ unsubscribe() {} }) },
      arr: { live: { position: () => null, prime: () => Promise.resolve({ epoch: 'e1', cursor: 1 }) }, onStatusChange: () => () => {} },
      internals: { arrNotify: { attachModal() {} } },
      core: { lifecycle: { register: () => ({ track: x => x }) } },
      titleDetails: { openKey: async () => true, openItem() {} },
    },
    fetch: async (url, options = {}) => {
      const path = String(url).replace('http://jellyfin.test', '').replace('/JellyfinEnhanced', '');
      const method = options.method || 'GET';
      sent.push([method, path]);
      hooks.answer?.(method, path);
      if (path.startsWith('/acquire/requests/me')) return jsonResponse({ me: MEMBER });
      if (path.startsWith('/acquire/requests/quota')) return jsonResponse({ quota: { used: 0, limit: 10, remaining: 10, available: true } });
      if (path.startsWith('/acquire/requests/check')) return jsonResponse({ check: { canRequest: true, blocked: null } });
      if (path === '/acquire/requests' && method === 'POST') return jsonResponse({ outcome: 'accepted', reason: 'looking', certainty: 'Succeeded', requestId: 'a'.repeat(32) }, 201);
      if (path.startsWith('/arr/admin/manage?')) return jsonResponse(OVERVIEW);
      if (path.startsWith('/jellyseerr/movie/603')) return jsonResponse({ id: 603, mediaInfo: { id: 77 } });
      if (path.startsWith('/spoiler-blur')) return jsonResponse({});
      return jsonResponse({});
    },
  });
  h.allowConsoleError(/./);
  t.after(() => { h.JE.titleActions?.dispose?.(); h.JE.arrManage?.close?.(); h.JE.arrAskSheet?.close?.(); h.close(); });
  for (const m of ['navigation', 'session', 'mutation-queue', 'api-client']) h.load('core/' + m + '.js');
  // Every call into the transport, with whether it carries a binding (the write reached the queue, and how).
  const entered = [];
  for (const name of ['plugin', 'pluginResponse', 'ajax']) {
    const real = h.JE.core.api[name];
    h.JE.core.api[name] = (target, options = {}) => {
      const opts = name === 'ajax' ? target : options;
      entered.push([String((name === 'ajax' ? target.url : target) || '').replace(/^.*\/JellyfinEnhanced/, ''), opts?.type || opts?.method || 'GET', !!opts?.bound]);
      return real(target, options);
    };
  }
  const manager = h.JE.core.api.manager;
  manager.CONFIG.retry.baseDelayMs = 1; manager.CONFIG.retry.maxDelayMs = 2;
  h.load('arr/actions/title-actions.js');
  return {
    ...h, sent, entered, hooks,
    get NATIVE() { return h.NATIVE; },
    writes: (method, prefix) => sent.filter(([m, p]) => m === method && p.startsWith(prefix)),
    /** An action-bar operation (a title action's press on this page); it ends when the person leaves the page. */
    operation: () => h.JE.titleActions.generation(),
    async leave() { h.window.location.hash = '#/movies'; await delivered(); },
    /** Holds every pool slot so the next request waits in the queue until the returned release(). */
    holdPool() {
      const gates = Array.from({ length: manager.CONFIG.concurrency.maxConcurrent }, deferred);
      const busy = gates.map(g => manager.withConcurrencyLimit(() => g.promise));
      return async () => { gates.forEach(g => g.resolve()); await Promise.all(busy); await settle(); };
    },
  };
}

/**
 * Each operation-owned write: `load` the owner, `submit` it under the operation (returns its promise), `sent` counts
 * the write itself. `ready` runs before the pool is held (UI the write is pressed in).
 */
const OWNERS = {
  'Seerr requestMedia (POST /jellyseerr/request)': {
    path: '/jellyseerr/request',
    load: h => h.load('jellyseerr/api.js'),
    // Every caller passes its operation's binding (D46S2-R5, shape 2), as the window's buttons and modals do.
    submit: (h, op) => h.JE.jellyseerrAPI.requestMedia(603, 'movie', { serverId: 1 }, false, null, null, { bound: h.JE.captureSubmitted(op).bound() }),
    sent: h => h.writes('POST', '/jellyseerr/request').length,
  },
  'Seerr requestTvSeasons (POST /jellyseerr/request)': {
    path: '/jellyseerr/request',
    load: h => h.load('jellyseerr/api.js'),
    submit: (h, op) => h.JE.jellyseerrAPI.requestTvSeasons(1399, [1], { serverId: 1 }, null, false, null, { bound: h.JE.captureSubmitted(op).bound() }),
    sent: h => h.writes('POST', '/jellyseerr/request').length,
  },
  'Report (POST /jellyseerr/issue)': {
    path: '/jellyseerr/issue',
    load: h => h.load('jellyseerr/api.js'),
    // The report reads its record under its owner first (D46S2 audit S3; the core transport keeps no copy of it), so the
    // pool fills the moment that read has been answered: the POST is then the queued request.
    ready: async h => {
      h.hooks.answer = (method, path) => { if (method === 'GET' && path.startsWith('/jellyseerr/movie/603') && !h.release) h.release = h.holdPool(); };
    },
    holdsItself: true,
    submit: (h, op) => h.JE.jellyseerrAPI.reportIssue(603, 'movie', 4, 'x', 0, 0, op),
    sent: h => h.writes('POST', '/jellyseerr/issue').length,
  },
  'Follow (PUT /acquire/follows)': {
    path: '/acquire/follows',
    load: h => h.load('arr/notify/notify-core.js'),
    submit: (h, op) => h.JE.arrNotify.setFollow('movie:tmdb:603', true, op),
    sent: h => h.writes('PUT', '/acquire/follows').length,
  },
  'Hide (PUT hidden-content rule)': {
    path: '/user-settings/',
    load: h => {
      h.load('enhanced/hiddencontent/hidden-content-data.js');
      const hidden = h.JE.internals.hiddenContent;
      Object.assign(hidden, { refreshNativeCardVisibility() {}, restoreNativeCardsForIds() {}, debouncedSave() {}, showUndoToast() {} });
      hidden.resetFromUserConfig();
    },
    submit: (h, op) => h.JE.internals.hiddenContent.saveTitleRule({ type: 'movie', tmdbId: 603, name: 'The Matrix' }, true, op),
    sent: h => h.writes('PUT', '/user-settings/').length,
  },
  'Spoiler Guard (POST /spoiler-blur/pending)': {
    path: '/spoiler-blur/pending/',
    load: h => {
      h.JE.internals.spoilerGuard = h.JE.internals.spoilerGuard || {};
      h.load('enhanced/spoilerguard/ids.js'); h.load('enhanced/spoilerguard/state.js');
    },
    submit: (h, op) => h.JE.internals.spoilerGuard.enableForTmdb('movie', 603, 'The Matrix', op),
    sent: h => h.writes('POST', '/spoiler-blur/pending/').length,
  },
  'JE ask from the request sheet (POST /acquire/requests)': {
    path: '/acquire/requests',
    load: h => { h.load('arr/status/status-core.js'); for (const m of ['ask-core', 'ask-episodes', 'ask-sheet-styles', 'ask-sheet']) h.load(`arr/ask/${m}.js`); h.JE.initializeArrStatus?.(); },
    ready: async (h, op) => {
      h.opened = h.JE.arrAskSheet.open({ key: 'movie:tmdb:603', kind: 'movie', name: 'The Matrix' }, { operation: op });
      await settle(); assert.ok(h.document.querySelector('.je-sheet .je-sheet-primary'), 'the request sheet is open');
    },
    submit: h => { h.document.querySelector('.je-sheet .je-sheet-primary').click(); return h.opened; },
    sent: h => h.writes('POST', '/acquire/requests').length,
  },
  'JE one-tap ask (POST /acquire/requests)': {
    path: '/acquire/requests',
    load: h => { h.load('arr/status/status-core.js'); for (const m of ['ask-core', 'ask-episodes', 'ask-sheet-styles', 'ask-sheet']) h.load(`arr/ask/${m}.js`); h.JE.initializeArrStatus?.(); },
    // Capabilities are cached; the allowance is read on each tap, so the pool fills the moment it has been answered:
    // the ask itself is then the queued request.
    ready: async h => {
      await h.JE.arrAsk.me();
      h.hooks.answer = (method, path) => { if (path.startsWith('/acquire/requests/quota') && !h.release) h.release = h.holdPool(); };
    },
    holdsItself: true,
    submit: (h, op) => h.JE.arrAskSheet.openOrAsk({ key: 'movie:tmdb:603', kind: 'movie', name: 'The Matrix' }, { operation: op }),
    sent: h => h.writes('POST', '/acquire/requests').length,
  },
  'Manage drawer Search now (POST /arr/admin/manage/search)': {
    path: '/arr/admin/manage/search',
    load: h => { h.load('arr/status/status-core.js'); h.load('arr/manage/manage-styles.js'); h.load('arr/manage/manage-drawer.js'); h.JE.initializeArrStatus?.(); },
    ready: async (h, op) => {
      await h.JE.arrManage.open({ key: 'movie:tmdb:603' }, { operation: op }); await settle();
      assert.ok(h.document.querySelector('.je-manage [data-je-focus="search-r1"]'), 'the drawer shows Search now');
    },
    submit: async h => { h.document.querySelector('.je-manage [data-je-focus="search-r1"]').click(); },
    sent: h => h.writes('POST', '/arr/admin/manage/search').length,
  },
};

for (const [name, owner] of Object.entries(OWNERS)) {
  for (const ends of [true, false]) {
    test(`${name}: pool full, write submitted, ${ends ? 'the operation ends while it is queued, released → 0 sends' : 'control: released → 1 send'}`, async t => {
      const h = setup(t);
      owner.load(h);
      const op = h.operation();
      await owner.ready?.(h, op);
      const release = owner.holdsItself ? null : h.holdPool();
      const done = Promise.resolve(owner.submit(h, op)).then(v => ({ v }), e => ({ e }));
      await settle();
      assert.equal(owner.sent(h), 0, 'the write waits in the queue');
      const write = h.entered.filter(([path, method]) => method !== 'GET' && path.startsWith(owner.path));
      assert.equal(write.length, 1, 'the write has reached the transport');
      if (ends) { await h.leave(); assert.equal(op.current(), false, 'the operation ended'); }
      await (release || h.release)(); await settle(); await wait(20);
      assert.equal(owner.sent(h), ends ? 0 : 1);
      if (ends) assert.equal(write[0][2], true, 'the write carried its operation\'s binding');
      const outcome = await Promise.race([done, wait(200).then(() => ({ pending: true }))]);
      if (outcome.e) assert.equal(outcome.e.name, "AbortError", "only an abort, nothing else: " + outcome.e.stack);
    });
  }
}

test('natively (no operation) the same writes carry the viewer\'s session binding: a page change while queued still sends', async t => {
  const h = setup(t);
  h.load('jellyseerr/api.js');
  const release = h.holdPool();
  const done = h.JE.jellyseerrAPI.requestMedia(603, 'movie', { serverId: 1 }, false, null, null, { bound: h.NATIVE.bound() }).catch(e => e);
  await settle();
  await h.leave();
  await release(); await done;
  assert.equal(h.writes('POST', '/jellyseerr/request').length, 1);
});

// ---- Source scan: no operation-owned write bypasses the primitive (the behaviour is tested above). ----

const WRITES = {
  'jellyseerr/api.js': [/async function post\(path, body, bound, origin\)[\s\S]*?JE\.core\.api\.plugin\(`\/jellyseerr\$\{path\}`, \{ method: 'POST', body, skipRetry: true, bound, session: origin \}\)/,
    /post\('\/issue', body, submitted\.bound\(\), origin\)/, /post\('\/request', body, bound, origin\)/],
  'arr/ask/ask-core.js': [/call\('\/acquire\/requests', \{ method: 'POST', body: options\?\.expect \? \{ clientRequestId, input, expect: options\.expect \} : \{ clientRequestId, input \}, signal: options\?\.signal, bound: options\?\.bound, session: origin \}\)/],
  'arr/ask/ask-sheet.js': [/JE\.arrAsk\.ask\(input, \{ bound: state\.submitted\.bound\(\), session: state\.origin \}\)/],
  'arr/manage/manage-drawer.js': [/JE\.core\.api\.plugin\(path, \{ \.\.\.options, bound: state\.action\.bound\(/],
  'arr/notify/notify-core.js': [/api\('\/acquire\/follows', \{ method: 'PUT', body: \{ key, on \}, bound: submitted\.bound\(\), session: origin \}\)/],
  'enhanced/hiddencontent/hidden-content-data.js': [/JE\.core\.api\.ajax\(\{ type: hidden \? 'PUT' : 'DELETE', dataType: 'json', session: origin, bound: submitted\.operationBound\(\)/],
  'enhanced/spoilerguard/state.js': [/const bound = submitted\.bound\(\);[\s\S]*?request\(path, \{ \.\.\.options, bound, session: origin \}\)/],
};
test('source scan: every operation-owned write passes its operation to the transport', () => {
  for (const [file, patterns] of Object.entries(WRITES)) {
    const source = readFileSync(resolve(jsRoot, file), 'utf8');
    for (const pattern of patterns) assert.match(source, pattern, `${file}: ${pattern}`);
  }
  // Every ask an action-bar owner sends carries a binding; every POST to /jellyseerr goes through post().
  const sheet = readFileSync(resolve(jsRoot, 'arr/ask/ask-sheet.js'), 'utf8');
  assert.equal((sheet.match(/JE\.arrAsk\.ask\(/g) || []).length, (sheet.match(/JE\.arrAsk\.ask\([^;]*bound:/g) || []).length, 'every ask in the sheet is bound');
  const seerr = readFileSync(resolve(jsRoot, 'jellyseerr/api.js'), 'utf8');
  assert.equal((seerr.match(/method: 'POST'/g) || []).length, 1, 'jellyseerr/api.js POSTs only through post()');
  assert.equal((seerr.match(/await post\(/g) || []).length, (seerr.match(/await post\([^)]*, (submitted\.bound\(\)|bound), origin\)/g) || []).length, 'every Seerr write is bound');
  const drawer = readFileSync(resolve(jsRoot, 'arr/manage/manage-drawer.js'), 'utf8');
  assert.equal((drawer.match(/JE\.core\.api\.(plugin|ajax|fetch|pluginResponse)\(/g) || []).length, 1, 'the drawer reaches the transport only through boundApi');
});

// ---- D46-R17-3 for slice 2 (D46 r18 merged): a bound read never shares an in-flight request across bindings. ----

test('Manage drawer: an ended operation\'s queued overview read is not adopted by a fresh drawer for the same title (one read sent, the fresh drawer renders)', async t => {
  const h = setup(t);
  h.load('arr/status/status-core.js'); h.load('arr/manage/manage-styles.js'); h.load('arr/manage/manage-drawer.js'); h.JE.initializeArrStatus?.();
  const reads = () => h.sent.filter(([m, p]) => m === 'GET' && p.startsWith('/arr/admin/manage?')).length;
  const release = h.holdPool();
  // The first operation's owning row goes (its mount ends) while its read is queued, on the same page: no navigation
  // clears the transport's in-flight table, so only the request identity keeps the two drawers apart.
  let mounted = true;
  const first = h.JE.titleActions.generation(() => mounted);
  h.JE.arrManage.open({ key: 'movie:tmdb:603' }, { operation: first }); await settle();
  mounted = false;
  assert.equal(first.current(), false, 'the first operation ended while its read was queued');
  const fresh = h.operation();
  h.JE.arrManage.open({ key: 'movie:tmdb:603' }, { operation: fresh }); await settle();
  assert.equal(reads(), 0, 'both reads wait in the queue');
  await release(); await settle(); await wait(20);
  assert.equal(reads(), 1, 'only the fresh drawer\'s read is sent');
  assert.ok(h.document.querySelector('.je-manage [data-je-focus="search-r1"]'), 'the fresh drawer shows its overview');
});

test('control: the same drawer\'s binding is honoured once released (one read, rendered)', async t => {
  const h = setup(t);
  h.load('arr/status/status-core.js'); h.load('arr/manage/manage-styles.js'); h.load('arr/manage/manage-drawer.js'); h.JE.initializeArrStatus?.();
  const release = h.holdPool();
  h.JE.arrManage.open({ key: 'movie:tmdb:603' }, { operation: h.operation() }); await settle();
  await release(); await settle(); await wait(20);
  assert.equal(h.sent.filter(([m, p]) => m === 'GET' && p.startsWith('/arr/admin/manage?')).length, 1);
  assert.ok(h.document.querySelector('.je-manage [data-je-focus="search-r1"]'));
});
