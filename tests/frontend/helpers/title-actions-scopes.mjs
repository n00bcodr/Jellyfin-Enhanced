import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { createHarness, deferred, jsonResponse } from './harness.mjs';

// D46 slice 2 review round 5: the action bar on an absent title's details page with the REAL core transport
// (navigation, session, session-action, api-client) and the REAL owners (Seerr API, modal shell, issue reporter, request
// modals, More Info window and its 4K popup, ask core and request sheet, Manage drawer, title actions). Only the server
// (fetch) is scripted: `requests` records [user, method, path]; `hold(method, prefix)` holds the next matching send.

export const tick = () => new Promise(resolve => setImmediate(resolve));
export async function settle(n = 40) { for (let i = 0; i < n; i++) await tick(); }
export const delivered = async () => { await wait(0); await settle(); };
export const MEMBER = { role: 'member', canRequest: true, canRequestMovies: true, canRequestSeries: true, canApprove: false, asksFirst: false,
  can4kMovies: false, can4kSeries: false, backend: 'je', contact: 'Dad', freeEpisodes: 5 };
const MOVIE = { id: 603, title: 'The Matrix', mediaInfo: { id: 77, status: 1, status4k: 1 }, collection: { id: 2344, name: 'The Matrix Collection' } };
export const SHOW = { id: 1399, name: 'Game of Thrones', mediaInfo: { id: 78, status: 1, status4k: 1 }, externalIds: { tvdbId: 121361 },
  seasons: [{ seasonNumber: 1, episodeCount: 10, airDate: '2011-04-17', posterPath: '/p.jpg' }] };

export function setup(t, { asks = true, seerr4k = true, card = false, advanced = false, stage = 'notHere' } = {}) {
  let user = 'user-a';
  const requests = []; const gates = []; const toasts = []; const feeds = [];
  async function answer(method, path, body) {
    requests.push([user, method, path, body]);
    const index = gates.findIndex(g => g.method === method && path.startsWith(g.prefix));
    // A held request answers with the value it is released with (when given), else as below.
    if (index >= 0) { const [gate] = gates.splice(index, 1); const value = await gate.d.promise; if (value !== undefined) return [200, value]; }
    if (path.startsWith('/title-actions/')) return [200, { allowed: true, itemId: null }];
    if (path.startsWith('/acquire/status')) return [200, { items: [{ key: 'movie:tmdb:603', stage, admin: { instances: [] } }] }];
    if (path.startsWith('/jellyseerr/user-status')) return [200, { active: true, userFound: true, canReportIssues: true, canRequestAdvanced: advanced }];
    if (path === '/jellyseerr/radarr') return [200, [{ id: 1, name: 'Radarr', isDefault: true, is4k: false }]];
    if (path === '/jellyseerr/radarr/1') return [200, { profiles: [{ id: 4, name: 'HD' }], rootFolders: [{ id: 1, path: '/movies' }] }];
    if (path.startsWith('/jellyseerr/movie/603')) return [200, MOVIE];
    if (/^\/jellyseerr\/tv\/\d+/.test(path)) return [200, { ...SHOW, id: Number(/^\/jellyseerr\/tv\/(\d+)/.exec(path)[1]) }];
    if (path.startsWith('/jellyseerr/collection/2344')) return [200, { id: 2344, name: 'The Matrix Collection', parts: [{ id: 604, title: 'The Matrix Reloaded', mediaInfo: { status: 1 } }] }];
    if (path.startsWith('/jellyseerr/collection/')) return [200, { id: 9, name: 'Another Collection', parts: [{ id: 605, title: 'Another Part', mediaInfo: { status: 1 } }] }];
    if (path.startsWith('/jellyseerr/issue') && method === 'GET') return [200, { results: [] }];
    if (path === '/jellyseerr/issue' && method === 'POST') return [200, { id: 1 }];
    if (path === '/jellyseerr/request' && method === 'POST') return [200, { id: 2, media: { status: 2, status4k: 2 } }];
    if (path.startsWith('/jellyseerr/overrideRule')) return [200, []];
    if (path.startsWith('/arr/admin/manage?')) return [200, { key: 'movie:tmdb:603', kind: 'movie', title: 'The Matrix', tmdbId: 603, instances: [], requests: [] }];
    if (path === '/acquire/requests/me') return [200, { me: MEMBER }];
    if (path.startsWith('/acquire/requests/quota')) return [200, { quota: { used: 0, limit: 10, remaining: 10, nextSlotAt: null, usedGb: 0, available: true } }];
    if (path.startsWith('/acquire/requests/check')) return [200, { check: { canRequest: true, blocked: null } }];
    if (path === '/acquire/requests' && method === 'POST') return [201, { outcome: 'accepted', reason: 'looking', certainty: 'Succeeded', message: 'Asked', requestId: 'a'.repeat(32) }];
    return [200, {}];
  }
  const h = createHarness({
    url: 'http://jellyfin.test/web/index.html#/details?id=x',
    html: '<div id="page"><div class="mainDetailButtons"></div></div>' +
      (card ? '<div id="home"><div class="card" data-je-hide-title="movie:tmdb:603" data-je-hide-name="The Matrix"></div></div>' : ''),
    apiClient: { getCurrentUserId: () => user },
    JE: {
      t: (k, p) => p?.n ? k + ':' + p.n : k, toast: m => toasts.push(m), icon: () => '', escapeHtml: s => String(s ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';'),
      IconName: { VIDEO: 'v', AUDIO: 'a', SUBTITLES: 's', QUESTION: 'q' },
      pluginConfig: { NativeAbsentDetailsEnabled: true, ArrManageDrawerEnabled: true, ArrStatusEnabled: true, ArrRequestsEnabled: asks,
        JellyseerrEnabled: true, JellyseerrShowReportButton: true, JellyseerrEnable4KRequests: seerr4k, JellyseerrShowAdvanced: advanced },
      helpers: { debounce: fn => fn, trackUsage() {}, addCSS() {}, getItemCached: async () => null, onBodyMutation: () => ({ unsubscribe() {} }) },
      arr: { live: { position: () => null, prime: () => Promise.resolve({ epoch: 'e1', cursor: 1 }) }, onStatusChange: (_keys, callback) => { feeds.push(callback); return () => feeds.splice(feeds.indexOf(callback) >>> 0, 1); } },
      internals: { arrNotify: { attachModal() {} } },
      cdn: { url: () => 'data:,' },
      titleDetails: { openKey: async () => true, openItem() {} },
    },
    fetch: async (url, options = {}) => {
      const path = String(url).replace('http://jellyfin.test', '').replace('/JellyfinEnhanced', '');
      let sentBody = options.body;
      try { sentBody = typeof sentBody === 'string' ? JSON.parse(sentBody) : sentBody; } catch (_) { /* as sent */ }
      const [status, body] = await answer(options.method || 'GET', path, sentBody);
      return jsonResponse(body, status);
    },
  });
  h.allowConsoleError(/./);
  t.after(() => { h.JE.titleActions?.dispose?.(); h.JE.arrManage?.close?.(); h.JE.arrAskSheet?.close?.(); h.JE.jellyseerrMoreInfo?.close?.(); h.close(); });
  // Production order: navigation, session, session-action (after session: it registers its user-change handler), the transport.
  for (const m of ['core/navigation.js', 'core/session.js', 'core/session-action.js', 'core/lifecycle.js', 'core/api-client.js']) h.load(m);
  const manager = h.JE.core.api.manager;
  manager.CONFIG.retry.baseDelayMs = 1; manager.CONFIG.retry.maxDelayMs = 2;
  for (const m of ['jellyseerr/seerr-status.js', 'jellyseerr/api.js', 'jellyseerr/modal.js', 'jellyseerr/ui/ui-icons.js', 'jellyseerr/ui/ui-quota.js',
    'jellyseerr/ui/ui-request-modals.js', 'jellyseerr/ui/ui-season-modal.js', 'jellyseerr/issue-reporter.js',
    'jellyseerr/moreinfo/more-info-modal-data.js', 'jellyseerr/moreinfo/more-info-modal-seasons.js', 'jellyseerr/moreinfo/more-info-modal-badges.js', 'jellyseerr/moreinfo/more-info-modal-render.js',
    'jellyseerr/moreinfo/more-info-modal-actions-tv.js', 'jellyseerr/moreinfo/more-info-modal-actions.js', 'jellyseerr/moreinfo/more-info-modal-init.js',
    'arr/status/status-core.js', 'arr/manage/manage-styles.js', 'arr/manage/manage-drawer.js']) h.load(m);
  for (const m of ['arr/ask/ask-core.js', 'arr/ask/ask-episodes.js', 'arr/ask/ask-sheet-styles.js', 'arr/ask/ask-sheet.js']) h.load(m);
  for (const m of ['arr/actions/title-actions.js', 'arr/actions/title-actions-sheet.js', 'arr/actions/title-actions-hosts.js']) h.load(m);
  h.JE.initializeArrStatus?.();
  const a = h.JE.titleActions;
  const page = h.document.querySelector('#page');
  const row = () => h.document.querySelector('.mainDetailButtons');
  return {
    ...h, a, page, row, requests, toasts, manager,
    /** The change feed reports a change for every followed key (the drawer's and status pill's subscriptions). */
    feed() { for (const callback of [...feeds]) callback(); },
    hold(method, prefix) { const d = deferred(); gates.push({ method, prefix, d }); return d; },
    sent: (method, prefix) => requests.filter(r => r[1] === method && r[2].startsWith(prefix)),
    /** Another user signs in (the session module notices at once, as its auth hook does). */
    switchUser() { user = 'user-b'; h.JE.session.checkNow('test'); },
    async leave(hash = '#/movies') { h.window.location.hash = hash; await delivered(); },
    async back() { h.window.location.hash = '#/details?id=x'; await delivered(); },
    /** The browser puts the page in the back/forward cache (pagehide persisted) and later restores it (pageshow). */
    pagehide(persisted = true) { h.window.dispatchEvent(new h.window.PageTransitionEvent('pagehide', { persisted })); },
    pageshow(persisted = true) { h.window.dispatchEvent(new h.window.PageTransitionEvent('pageshow', { persisted })); },
    freeze() { h.document.dispatchEvent(new h.window.Event('freeze')); },
    resume() { h.document.dispatchEvent(new h.window.Event('resume')); },
    /** Holds every pool slot so the next request waits in the queue until the returned release(). */
    holdPool() {
      const slots = Array.from({ length: manager.CONFIG.concurrency.maxConcurrent }, deferred);
      const busy = slots.map(g => manager.withConcurrencyLimit(() => g.promise));
      return async () => { slots.forEach(g => g.resolve()); await Promise.all(busy); await settle(); };
    },
  };
}

/** Mounts the absent title's row in its compact (phone) layout. */
export function mount(h, width = 390) {
  Object.defineProperty(h.window, 'innerWidth', { value: width, writable: true, configurable: true });
  const row = h.row(); row.getBoundingClientRect = () => ({ width: 100 });
  h.a.mountRow(row, h.page, h.a.fromKey('movie:tmdb:603'));
}

/** The host re-renders the row (a cloned node): the old row's mount, and the operations it owned, end. */
export function remount(h) {
  const row = h.row(); const clone = row.cloneNode(true); row.replaceWith(clone);
  clone.getBoundingClientRect = () => ({ width: 100 });
  h.a.mountRow(clone, h.page, h.a.fromKey('movie:tmdb:603'));
}

/** Opens the row's More sheet and presses `id`. */
export async function press(h, id) {
  h.row().querySelector('.je-actions-more').click(); await settle();
  const entry = h.document.querySelector(`.je-actions-entry[data-action="${id}"]`);
  assert.ok(entry, 'the sheet offers ' + id);
  entry.click(); await settle();
}

export const moreInfo = h => [...h.document.querySelectorAll('.je-more-info-modal')].find(m => !m._isClosing) || null;
export const popup = h => h.document.querySelector('.je-4k-popup');
export const sheet = h => h.document.querySelector('.je-sheet');
/** The newest Seerr modal (a closed one stays in the document for its 300 ms exit animation). */
export const seerrModal = h => [...h.document.querySelectorAll('.jellyseerr-season-modal')].at(-1) || null;
export { deferred };
