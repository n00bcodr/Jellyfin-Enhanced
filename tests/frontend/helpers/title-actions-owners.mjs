import assert from 'node:assert/strict';
import { createHarness, deferred } from './harness.mjs';

// The action bar on an absent title's details page (and a retained card), with the REAL owners it invokes:
// the issue reporter, Seerr API and modal shell, the ask core and request sheet, the Manage drawer, Seerr's
// More Info window and the title actions. Only the server is scripted. Shared by the owner (D46S2-R3) and
// lifecycle (D46S2-R4) tests.

export const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
export const MEMBER = { role: 'member', canRequest: true, canRequestMovies: true, canRequestSeries: true, canApprove: false, asksFirst: false,
  can4kMovies: false, can4kSeries: false, backend: 'je', contact: 'Dad', freeEpisodes: 5 };
export const QUOTA = { used: 0, limit: 10, remaining: 10, nextSlotAt: null, usedGb: 0, available: true };
export const OVERVIEW = { key: 'movie:tmdb:603', kind: 'movie', title: 'The Matrix', tmdbId: 603, instances: [], requests: [] };
export const HOME = '#/details?id=x';

/**
 * An absent title's details page with the action bar and the real owners. `requests` records every server call
 * as [user, method, path]; `hold(method, prefix)` holds the next matching call until released. `card` adds a
 * card for the same title outside the page (kept connected across navigation, as Jellyfin's view cache does).
 */
export function setup(t, { asks = true, seerrMoreInfo = false, card = false, overview = OVERVIEW } = {}) {
  let user = 'user-a'; let epoch = 1; const switches = [];
  const requests = []; const gates = []; const toasts = [];
  let prime = null;
  async function answer(method, path, body) {
    requests.push([user, method, path, body]);
    const index = gates.findIndex(g => g.method === method && path.startsWith(g.prefix));
    if (index >= 0) { const [gate] = gates.splice(index, 1); await gate.d.promise; }
    if (path.startsWith('/title-actions/')) return { allowed: true, itemId: null };
    if (path.startsWith('/acquire/status')) return { items: [{ key: 'movie:tmdb:603', stage: 'notHere', admin: { instances: [] } }] };
    if (path.startsWith('/jellyseerr/user-status')) return { active: true, userFound: true, canReportIssues: true };
    if (path.startsWith('/jellyseerr/movie/603')) return { id: 603, title: 'The Matrix', mediaInfo: { id: 77 } };
    if (path.startsWith('/jellyseerr/issue') && method === 'GET') return { results: [] };
    if (path === '/jellyseerr/issue' && method === 'POST') return { id: 1 };
    if (path === '/jellyseerr/request' && method === 'POST') return { id: 2 };
    if (path.startsWith('/jellyseerr/overrideRule')) return [];
    if (path.startsWith('/arr/admin/manage?')) return overview;
    if (path === '/acquire/requests/me') return { me: MEMBER };
    if (path.startsWith('/acquire/requests/quota')) return { quota: QUOTA };
    if (path.startsWith('/acquire/requests/check')) return { check: { canRequest: true, blocked: null } };
    if (path === '/acquire/requests' && method === 'POST') return { outcome: 'accepted', reason: 'looking', certainty: 'Succeeded', message: 'Asked', requestId: 'a'.repeat(32) };
    return null;
  }
  const status = (method, path) => method === 'POST' && path === '/acquire/requests' ? 201 : 200;
  const h = createHarness({
    url: 'http://jellyfin.test/web/index.html' + HOME,
    html: '<div id="page"><div class="mainDetailButtons"></div></div>' +
      (card ? '<div id="home"><div class="card" data-je-hide-title="movie:tmdb:603" data-je-hide-name="The Matrix"></div></div>' : ''),
    apiClient: { getCurrentUserId: () => user },
    JE: {
      t: (k, p) => p?.n ? k + ':' + p.n : k, toast: m => toasts.push(m), icon: () => '', escapeHtml: s => String(s),
      IconName: { VIDEO: 'v', AUDIO: 'a', SUBTITLES: 's', QUESTION: 'q' },
      pluginConfig: { NativeAbsentDetailsEnabled: true, ArrManageDrawerEnabled: true, ArrStatusEnabled: true, ArrRequestsEnabled: asks,
        JellyseerrEnabled: true, JellyseerrShowReportButton: true },
      session: { getEpoch: () => epoch, isCurrent: e => e === epoch, onUserChange: (_name, fn) => { switches.push(fn); return () => {}; }, userScopedKey: k => k + ':' + user },
      helpers: { debounce: fn => fn, trackUsage() {}, addCSS() {}, getItemCached: async () => null },
      arr: { live: { position: () => null, prime: () => prime ? prime.promise : Promise.resolve({ epoch: 'e1', cursor: 1 }) }, onStatusChange: () => () => {} },
      internals: { arrNotify: { attachModal() {} }, ...(seerrMoreInfo ? { moreInfoModal: {
        state: { currentModal: null }, buildModalContent: () => '<div data-mount="ratings"></div><a class="je-test-link" href="https://www.themoviedb.org/movie/603" target="_blank">TMDB</a>', renderActions() {},
        enrichSeasonCardsWithJellyfinLinks() {}, backfillSeasonMetadata() {}, buildRatingLogos: () => '' } } : {}) },
      seerrStatus: { MEDIA: { UNKNOWN: 1, AVAILABLE: 5 } },
      core: {
        api: {
          plugin: async (path, options = {}) => answer(options.method || 'GET', path, options.body),
          pluginResponse: async (path, options = {}) => ({ status: status(options.method || 'GET', path), body: await answer(options.method || 'GET', path, options.body) }),
          fetch: async (url, options = {}) => answer(options.method || 'GET', url.replace('http://jellyfin.test/JellyfinEnhanced', ''), options.body),
        },
        navigation: { onNavigate: () => () => {}, onViewPage: () => () => {} },
        lifecycle: { register: () => ({ track: x => x }) },
      },
      titleDetails: { openKey: async () => true, openItem() {} },
    },
  });
  h.allowConsoleError(/could not load|Failed to load|Error opening more info/);
  t.after(() => { h.JE.titleActions?.dispose?.(); h.JE.arrManage?.close?.(); h.JE.arrAskSheet?.close?.(); h.close(); });
  h.load('jellyseerr/api.js');
  h.load('jellyseerr/modal.js');
  h.load('jellyseerr/issue-reporter.js');
  h.load('arr/status/status-core.js');
  h.load('arr/manage/manage-styles.js');
  h.load('arr/manage/manage-drawer.js');
  if (asks) for (const m of ['arr/ask/ask-core.js', 'arr/ask/ask-episodes.js', 'arr/ask/ask-sheet-styles.js', 'arr/ask/ask-sheet.js']) h.load(m);
  if (seerrMoreInfo) { h.load('jellyseerr/moreinfo/more-info-modal-data.js'); h.load('jellyseerr/moreinfo/more-info-modal-init.js'); }
  h.load('arr/actions/title-actions.js');
  h.load('arr/actions/title-actions-sheet.js');
  h.load('arr/actions/title-actions-hosts.js');
  h.JE.initializeArrStatus?.();
  const a = h.JE.titleActions;
  const page = h.document.querySelector('#page');
  const row = () => h.document.querySelector('.mainDetailButtons');
  return {
    ...h, a, page, row, requests, toasts,
    /** A viewer's native owner minted now (the harness getter, kept live through the spread). */
    get NATIVE() { return h.NATIVE; },
    hold(method, prefix) { const d = deferred(); gates.push({ method, prefix, d }); return d; },
    holdFeed() { prime = deferred(); return prime; },
    sent: (method, prefix) => requests.filter(r => r[1] === method && r[2].startsWith(prefix)),
    switchUser() { user = 'user-b'; epoch++; switches.forEach(fn => fn({ userId: user })); },
    /** The signed-in user changes before the session module notices (no epoch or handlers yet). */
    signedInAs(next) { user = next; },
    navigate(hash = '#/movies') { h.window.location.hash = hash; },
    featureOff() { h.JE.pluginConfig.NativeAbsentDetailsEnabled = false; a.scan(); },
  };
}

/** Mounts the absent title's row in its compact (phone) layout. */
export function mount(h, width = 390) {
  Object.defineProperty(h.window, 'innerWidth', { value: width, writable: true, configurable: true });
  const row = h.row(); row.getBoundingClientRect = () => ({ width: 100 });
  h.a.mountRow(row, h.page, h.a.fromKey('movie:tmdb:603'));
}

export function remount(h) {
  const row = h.row(); const clone = row.cloneNode(true); row.replaceWith(clone);
  clone.getBoundingClientRect = () => ({ width: 100 });
  h.a.mountRow(clone, h.page, h.a.fromKey('movie:tmdb:603'));
}

export const INTERRUPTS = [
  ['navigation', h => h.navigate()],
  ['remount (cloned row)', remount],
  ['session switch', h => h.switchUser()],
  ['feature-off', h => h.featureOff()],
];

/** Opens the row's More sheet and presses `id`. */
export async function press(h, id) {
  h.click(h.row().querySelector('.je-actions-more')); await settle();
  const entry = h.document.querySelector(`.je-actions-entry[data-action="${id}"]`);
  assert.ok(entry, 'the sheet offers ' + id);
  h.click(entry); await settle();
}

/** ask-core reads capabilities once a minute: the next read goes to the server again. */
export function expireCapabilities(h) {
  const now = h.window.Date.now.bind(h.window.Date); let skew = 0;
  h.window.Date.now = () => now() + skew;
  return () => { skew += 120000; };
}

/** Picks an issue type in the open Report form and submits it. */
export async function submitReport(h) {
  // The newest form: a closed one stays in the document for its 300 ms exit animation.
  const modal = [...h.document.querySelectorAll('.jellyseerr-season-modal')].at(-1);
  assert.ok(modal, 'the Report form is open');
  modal.querySelector('input[name="issue-type"]').checked = true;
  h.click(modal.querySelector('.jellyseerr-modal-button-primary')); await settle();
}

export const sheet = h => h.document.querySelector('.je-sheet');
export const drawer = h => h.document.querySelector('.je-manage-overlay');
export const moreInfo = h => h.document.querySelector('.je-more-info-modal');

/** An operation of a mounted row, as the action bar submits it. */
export function operationOf(h) {
  let live = true;
  return { op: h.a.generation(() => live), end: () => { live = false; } };
}

export { deferred };
