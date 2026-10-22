// The mock host page shared by the title actions' Chromium specs (title-actions-trust, title-actions-surfaces): the
// production modules on an offline page (every request is intercepted; fetch is the test's fixture), the title actions
// started, two search cards (603, 604), a More Info opener and a live page control; jellyfin-web's own input modules
// (tests/fixtures/host-input) loaded into the page on request.
const { readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = file => readFileSync(path.join(root, file), 'utf8');
const en = JSON.parse(read('Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json'));
const MODULES = ['core/navigation.js', 'core/session.js', 'core/session-action.js', 'core/lifecycle.js', 'core/api-client.js', 'core/ui-kit.js',
  'jellyseerr/seerr-status.js', 'jellyseerr/api.js', 'jellyseerr/modal.js', 'jellyseerr/ui/ui-icons.js', 'jellyseerr/ui/ui-styles.js', 'jellyseerr/ui/ui-quota.js',
  'jellyseerr/ui/ui-popover.js', 'jellyseerr/ui/ui-buttons.js', 'jellyseerr/ui/ui-badges.js', 'jellyseerr/ui/ui-cards.js', 'jellyseerr/ui/ui-results.js',
  'jellyseerr/ui/ui-request-modals.js', 'jellyseerr/ui/ui-season-modal.js', 'jellyseerr/issue-reporter.js',
  'jellyseerr/moreinfo/more-info-modal-data.js', 'jellyseerr/moreinfo/more-info-modal-seasons.js', 'jellyseerr/moreinfo/more-info-modal-badges.js',
  'jellyseerr/moreinfo/more-info-modal-render.js', 'jellyseerr/moreinfo/more-info-modal-actions-tv.js', 'jellyseerr/moreinfo/more-info-modal-actions.js',
  'jellyseerr/moreinfo/more-info-modal-init.js', 'jellyseerr/moreinfo/more-info-modal-styles.js',
  'arr/status/status-core.js', 'arr/notify/notify-core.js', 'arr/actions/title-actions.js', 'arr/actions/title-actions-sheet.js', 'arr/actions/title-actions-hosts.js']
  .map(file => read('Jellyfin.Plugin.JellyfinEnhanced/js/' + file));
const css = read('tests/browser/arr-fixture.html').match(/<style>([\s\S]*?)<\/style>/)[1];
const HOST_INPUT = Object.fromEntries(['12.2', '10.11.11'].map(host => [host, {
  modules: ['focus-manager', 'input-manager', 'keyboard-navigation', 'events', 'server-notifications'].map(name => read(`tests/fixtures/host-input/${host}/${name}.module.js`)),
  gamepad: read(`tests/fixtures/host-input/${host}/gamepadtokey.chunk.js`),
}]));

/** The mock host page with the production modules, the title actions started and two search cards (603, 604). */
async function boot(page, { layout = 'desktop' } = {}) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().isNavigationRequest()
    ? route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html class="layout-${layout}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="page" class="page mainAnimatedPage"><button id="pagePlay">Page play</button><div class="mainDetailButtons"></div></div></body></html>` })
    : route.abort());
  await page.goto('http://title-actions.invalid/web/index.html#/search?query=matrix');
  await page.evaluate(en => {
    const movie = id => ({ id, title: 'Movie ' + id, mediaInfo: { id: 70 + id % 10, status: 1, status4k: 1 } });
    window.sent = [];
    window.__user = 'user-a';
    window.ApiClient = { getCurrentUserId: () => window.__user, accessToken: () => 'token-' + window.__user, serverId: () => 'server', getUrl: p => location.origin + (p.startsWith('/') ? '' : '/') + p };
    window.Emby = { Page: { onViewShow() {} } };
    window.Dashboard = { alert(options) {
      const box = document.createElement('div'); box.className = 'dialogContainer';
      box.innerHTML = '<div class="dialog opened"><div class="text"></div><button class="btnOption">OK</button></div>';
      box.querySelector('.text').textContent = options.message; box.style.cssText = 'position:fixed;inset:20%;background:#222;color:#fff;z-index:99999999';
      box.querySelector('button').onclick = () => box.remove();
      document.body.append(box); box.querySelector('button').focus();
    } };
    window.JellyfinEnhanced = {
      strictOwners: 'record', t: (key, params = {}) => Object.entries(params).reduce((s, [k, v]) => s.split('{' + k + '}').join(v), en[key] || key), toast() {}, icon: () => '',
      escapeHtml: s => String(s ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';'), IconName: { VIDEO: 'v', AUDIO: 'a', SUBTITLES: 's', QUESTION: 'q' },
      pluginConfig: { NativeAbsentDetailsEnabled: true, ArrStatusEnabled: true, JellyseerrEnabled: true, JellyseerrShowReportButton: true, JellyseerrEnable4KRequests: true, JellyseerrShowAdvanced: false },
      helpers: { debounce: fn => fn, trackUsage() {}, getItemCached: async () => null, onBodyMutation: () => ({ unsubscribe() {} }) },
      arr: { live: { position: () => null, prime: async () => ({ epoch: 'e1', cursor: 1 }) }, onStatusChange: () => () => {} },
      internals: {}, cdn: { url: () => 'data:,' }, titleDetails: { openKey: async () => true, openItem() {} },
    };
    window.fetch = async (url, options = {}) => {
      const p = String(url).replace(location.origin, '').replace('/JellyfinEnhanced', '');
      const method = options.method || 'GET';
      let body = null; try { body = options.body ? JSON.parse(options.body) : null; } catch (_) { /* as sent */ }
      window.sent.push([method, p, body, options.headers?.['X-Jellyfin-User-Id']]);
      const id = Number((/\/jellyseerr\/movie\/(\d+)/.exec(p) || [])[1]);
      let data = {};
      if (p.startsWith('/title-actions/')) data = { allowed: true, itemId: null };
      else if (p.startsWith('/jellyseerr/user-status')) data = { active: true, userFound: true, canReportIssues: true, canRequestAdvanced: true };
      else if (id) data = movie(id);
      else if (p.startsWith('/jellyseerr/issue')) data = { results: [] };
      else if (p === '/jellyseerr/request') data = { id: 2, media: { status: 2, status4k: 1 } };
      else if (p.startsWith('/jellyseerr/overrideRule')) data = [];
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  }, en);
  for (const content of MODULES) await page.addScriptTag({ content });
  await page.evaluate(() => {
    const JE = window.JellyfinEnhanced;
    JE.jellyseerrUI.addMainStyles(); JE.titleActions.initialize();
    for (const id of [603, 604]) {
      const card = document.createElement('div'); card.className = 'jellyseerr-card'; card.id = 'card' + id;
      card.style.cssText = 'display:inline-block;margin:24px;width:180px';
      card.innerHTML = `<button class="jellyseerr-request-button" data-tmdb-id="${id}" data-media-type="movie"></button>`;
      document.body.append(card);
      JE.jellyseerrUI.configureRequestButton(card.firstChild, { id, mediaType: 'movie', title: 'Movie ' + id, mediaInfo: { status: 1, status4k: 1 } }, true, true);
    }
    const opener = document.createElement('button'); opener.id = 'openInfo'; opener.textContent = 'Open More Info';
    opener.onclick = e => JE.jellyseerrMoreInfo.open(603, 'movie', undefined, JE.ownerOf(e));
    document.body.append(opener);
    const behind = document.createElement('button'); behind.id = 'behind'; behind.textContent = 'A card behind'; document.body.append(behind);
  });
  return { errors, requests: () => page.evaluate(() => window.sent.filter(([m, p]) => m === 'POST' && p === '/jellyseerr/request').map(r => [r[2].mediaId, r[3]])) };
}
const request = (page, id) => page.locator(`#card${id} .jellyseerr-split-main, #card${id} .jellyseerr-request-button`).first();
/** The viewer's own press: a tap on a touch device, else a mouse click (both Chromium's own, trusted). */
const press = async (page, locator, isMobile) => (isMobile ? locator.tap() : locator.click());


/**
 * Loads jellyfin-web's own input modules for `version` into the page (keyboard navigation enabled; `tv`: its TV layout),
 * plus, with `remote`, its serverNotifications wired to a REAL WebSocket to `remote` (a loopback server the test runs):
 * every server message reaches the page as Chromium delivers one (a trusted MessageEvent), and the host turns a
 * GeneralCommand into inputManager.handleCommand. `history`: its router's back() goes back in the browser's history
 * (jellyfin-web's appRouter does), else it only counts (window.backs). Resolves once the socket is open.
 */
async function loadHost(page, version, { tv = false, remote = null, history = false } = {}) {
  await page.evaluate(async ({ modules, version, tv, remote, history }) => {
    // `history`: the router goes back through the browser's history, as jellyfin-web's appRouter.back() does.
    const stubs = { 22622: { g: { supports: () => false, exit() {}, getWindowState: () => 'Normal' } }, 70267: { appRouter: { canGoBack: () => true, back() {
      // jellyfin-web's appRouter.back(): one pending back at a time, settled when its history step lands.
      window.backs = (window.backs || 0) + 1;
      if (!history) return undefined;
      if (window.pendingBack) return window.pendingBack;
      window.pendingBack = new Promise(resolve => { window.addEventListener('popstate', () => { window.pendingBack = null; resolve(); }, { once: true }); window.history.back(); });
      return window.pendingBack;
    } } },
      97339: { Y: { Exit: 'Exit' } }, 36300: { Ay: { addEventListener: (t, ty, f, o) => t.addEventListener(ty, f, o), removeEventListener: (t, ty, f, o) => t.removeEventListener(ty, f, o), parentWithClass: (n, c) => n.closest?.('.' + c) } },
      34789: { A: { tv }, default: { tv } }, 46782: { A: { tv }, default: { tv } }, 90381: { A: { enableGamepad: () => false }, default: { enableGamepad: () => false } }, 93599: { Ay: { isEnabled: () => false } } };
    const factories = {}, exports = {};
    const inert = () => new Proxy(function () { return inert(); }, { get: (t, k) => k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : inert() });
    const require = id => { if (id in exports) return exports[id]; if (factories[id]) { const m = { exports: {} }; exports[id] = m.exports; factories[id].call(m.exports, m, m.exports, require); return exports[id]; } return stubs[id] || inert(); };
    require.r = t => Object.defineProperty(t, '__esModule', { value: true });
    require.d = (t, g) => { for (const k of Object.keys(g)) if (!(k in t)) Object.defineProperty(t, k, { enumerable: true, get: g[k] }); };
    require.n = m => () => m; require.o = (o, k) => Object.prototype.hasOwnProperty.call(o, k); require.e = () => Promise.resolve();
    for (const text of modules) { const box = new Function(`const module = {}; ${text.replace(/^\/\/.*\n/, '')}\n return module.exports;`)(); factories[box.id] = box.module; }
    const keyboard = require(74550); (keyboard.Ay || keyboard.default).enable();
    const input = require(38490);
    window.hostInput = (input.Ay || input.default);
    window.backs = 0;
    if (!remote) return;
    const socket = new WebSocket(remote);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    const events = require(44797).A;
    const apiClient = { serverId: () => 'server', serverInfo: () => ({ Id: 'server' }), getCurrentUserId: () => window.__user };
    if (version === '12.2') {
      const subscriptions = new Map();
      apiClient.subscribe = (types, callback) => { for (const type of types) { if (!subscriptions.has(type)) subscriptions.set(type, []); subscriptions.get(type).push(callback); } return () => {}; };
      socket.addEventListener('message', event => { const message = JSON.parse(event.data); subscriptions.get(message.MessageType)?.forEach(callback => callback(message)); });
      stubs[4935] = { De: { Play: 'Play', Playstate: 'Playstate', GeneralCommand: 'GeneralCommand', SyncPlayCommand: 'SyncPlayCommand', SyncPlayGroupUpdate: 'SyncPlayGroupUpdate' } };
    } else socket.onmessage = event => events.trigger(apiClient, 'message', [JSON.parse(event.data)]);
    stubs[67430] = { tF: { getApiClients: () => [apiClient] } };
    const notifications = require(10736);
    (notifications.D || notifications.initializeServerConnections)();
    window.remoteMessages = 0;
    socket.addEventListener('message', () => { window.remoteMessages++; });
  }, { modules: HOST_INPUT[version].modules, version, tv, remote, history });
}

/** A loopback WebSocket server (this process): send(command) delivers GeneralCommand `command` to every client. */
async function remoteServer() {
  const { WebSocketServer } = require('ws');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const clients = new Set();
  server.on('connection', ws => clients.add(ws));
  return { url: `ws://127.0.0.1:${server.address().port}/socket`,
    command: name => { for (const ws of clients) ws.send(JSON.stringify({ MessageType: 'GeneralCommand', Data: { Name: name, Arguments: {} } })); },
    close: () => new Promise(resolve => { for (const ws of clients) ws.terminate(); server.close(resolve); }) };
}

module.exports = { read, MODULES, HOST_INPUT, boot, request, press, loadHost, remoteServer };
