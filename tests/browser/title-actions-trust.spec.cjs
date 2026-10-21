// D46 slice 2 review round 11: the action bar's trust boundary where trust is real. Chromium's own input (CDP: a mouse
// click, a phone tap, a key press) is the viewer's; a script's click() or a re-dispatched event is not, whatever has
// focus. jellyfin-web's own gamepad activation of the focused control (its real gamepad-to-key and keyboard navigation
// modules, 12.2 and 10.11.11) is the viewer's too. The production modules run on a mock host page; only the server
// (fetch) is scripted. Desktop Chromium and mobile Chromium (Pixel 7: touch, 390 px).
const { test, expect } = require('@playwright/test');
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
  modules: ['focus-manager', 'input-manager', 'keyboard-navigation'].map(name => read(`tests/fixtures/host-input/${host}/${name}.module.js`)),
  gamepad: read(`tests/fixtures/host-input/${host}/gamepadtokey.chunk.js`),
}]));

test.skip(({ browserName }) => browserName !== 'chromium', 'the trust boundary is checked with Chromium\'s own (CDP) input');

/** The mock host page with the production modules, the title actions started and two search cards (603, 604). */
async function boot(page, { layout = 'desktop' } = {}) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().isNavigationRequest()
    ? route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><html class="layout-${layout}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="page"><div class="mainDetailButtons"></div></div></body></html>` })
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

test('the viewer\'s click (or tap) and a real Enter send Request; a JE timer\'s click() on the focused Request sends nothing', async ({ page, isMobile }) => {
  const host = await boot(page);
  await request(page, 603).focus();
  await page.evaluate(() => new Promise(resolve => setTimeout(() => { document.activeElement.click(); resolve(); }, 0)));
  await page.waitForTimeout(150);
  expect(await host.requests()).toEqual([]);
  await press(page, request(page, 603), isMobile);
  await expect.poll(host.requests).toEqual([[603, 'user-a']]);
  await request(page, 604).focus();
  await page.keyboard.press('Enter');
  await expect.poll(host.requests).toEqual([[603, 'user-a'], [604, 'user-a']]);
  expect(host.errors).toEqual([]);
});

test('the viewer\'s real click on 603, re-dispatched onto 604\'s Request, requests only 603', async ({ page, isMobile }) => {
  const host = await boot(page);
  await page.evaluate(() => document.querySelector('#card603').addEventListener('click', e => { window.original = e; }, true));
  await press(page, request(page, 603), isMobile);
  await expect.poll(host.requests).toEqual([[603, 'user-a']]);
  const trust = await page.evaluate(() => { document.querySelector('#card604 .jellyseerr-split-main, #card604 .jellyseerr-request-button').dispatchEvent(window.original); return window.original.isTrusted; });
  await page.waitForTimeout(150);
  expect(trust).toBe(false);
  expect(await host.requests()).toEqual([[603, 'user-a']]);
});

test('a Request drawn before an account switch: the viewer\'s press afterwards sends nothing as the new account', async ({ page, isMobile }) => {
  const host = await boot(page);
  await page.evaluate(() => { window.__user = 'user-b'; window.JellyfinEnhanced.session.checkNow('test'); });
  await press(page, request(page, 603), isMobile);
  await page.waitForTimeout(200);
  expect(await host.requests()).toEqual([]);
});

for (const version of ['12.2', '10.11.11']) {
  test(`jellyfin-web ${version}'s own gamepad OK (its real gamepad-to-key) on a focused Request sends it once`, async ({ page }) => {
    const host = await boot(page);
    await page.evaluate(({ modules, gamepad }) => {
      const pad = window.pad = { index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad] });
      document.hasFocus = () => true;
      const stubs = { 22622: { g: { supports: () => false, exit() {}, getWindowState: () => 'Normal' } }, 70267: { appRouter: { canGoBack: () => true, back() { window.backs = (window.backs || 0) + 1; } } },
        97339: { Y: { Exit: 'Exit' } }, 36300: { Ay: { addEventListener: (t, ty, f, o) => t.addEventListener(ty, f, o), removeEventListener: (t, ty, f, o) => t.removeEventListener(ty, f, o), parentWithClass: (n, c) => n.closest?.('.' + c) } },
        34789: { A: { tv: false }, default: { tv: false } }, 46782: { A: { tv: false }, default: { tv: false } }, 90381: { A: { enableGamepad: () => false }, default: { enableGamepad: () => false } }, 93599: { Ay: { isEnabled: () => false } } };
      const factories = {}, exports = {};
      const inert = () => new Proxy(function () { return inert(); }, { get: (t, k) => k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : inert() });
      const require = id => { if (id in exports) return exports[id]; if (factories[id]) { const m = { exports: {} }; exports[id] = m.exports; factories[id].call(m.exports, m, m.exports, require); return exports[id]; } return stubs[id] || inert(); };
      require.r = t => Object.defineProperty(t, '__esModule', { value: true });
      require.d = (t, g) => { for (const k of Object.keys(g)) if (!(k in t)) Object.defineProperty(t, k, { enumerable: true, get: g[k] }); };
      require.n = m => () => m; require.o = (o, k) => Object.prototype.hasOwnProperty.call(o, k); require.e = () => Promise.resolve();
      for (const text of modules) { const box = new Function(`const module = {}; ${text.replace(/^\/\/.*\n/, '')}\n return module.exports;`)(); factories[box.id] = box.module; }
      const keyboard = require(74550); (keyboard.Ay || keyboard.default).enable();
      const chunks = []; window.webpackChunk = { push: c => chunks.push(c) };
      new Function(gamepad)();
      for (const [id, factory] of Object.entries(chunks[0][1])) factories[id] = factory;
      require(84348);
      window.dispatchEvent(new Event('gamepadconnected'));
    }, HOST_INPUT[version]);
    await request(page, 603).focus();
    await page.evaluate(() => { window.pad.buttons[0].pressed = true; });
    await page.waitForTimeout(80);
    await page.evaluate(() => { window.pad.buttons[0].pressed = false; });
    await expect.poll(host.requests).toEqual([[603, 'user-a']]);
    await page.evaluate(() => { window.pad.connected = false; window.dispatchEvent(new Event('gamepaddisconnected')); });
  });
}

test('More Info: focus moves inside; Tab stays inside; Escape closes it and focus is back on its opener', async ({ page, isMobile }) => {
  const host = await boot(page);
  await press(page, page.locator('#openInfo'), isMobile);
  await page.locator('.je-more-info-modal.active').waitFor();
  await page.waitForTimeout(60);
  expect(await page.evaluate(() => !!document.activeElement.closest('.je-more-info-modal'))).toBe(true);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(i % 3 === 2 ? 'Shift+Tab' : 'Tab');
    expect(await page.evaluate(() => !!document.activeElement.closest('.je-more-info-modal')), `Tab ${i} stays inside`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => !!document.querySelector('.je-more-info-modal')?._isClosing)).toBe(true);
  expect(await page.evaluate(() => document.activeElement.id)).toBe('openInfo');
  expect(host.errors).toEqual([]);
});

test('a quota dialog over More Info takes the Escape: the window under it stays open', async ({ page, isMobile }) => {
  await boot(page);
  await press(page, page.locator('#openInfo'), isMobile);
  await page.locator('.je-more-info-modal.active').waitFor();
  await page.evaluate(() => window.JellyfinEnhanced.jellyseerrUI.showQuotaErrorDialog({ status: 403, responseJSON: { code: 'quota_exceeded' } }, 'movie', window.JellyfinEnhanced.ownerOf(document.querySelector('.je-more-info-modal'))));
  await page.locator('.dialogContainer').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => !!document.querySelector('.je-more-info-modal')._isClosing)).toBe(false);
});

test('jellyfin-web 12.2 on a TV: the remote\'s Back (10009, a real key event) closes More Info only; the router never sees it', async ({ page, isMobile }) => {
  await boot(page, { layout: 'tv' });
  await page.evaluate(({ modules }) => {
    const stubs = { 22622: { g: { supports: () => false } }, 70267: { appRouter: { canGoBack: () => true, back() { window.backs = (window.backs || 0) + 1; } } }, 97339: { Y: { Exit: 'Exit' } },
      36300: { Ay: { addEventListener: (t, ty, f, o) => t.addEventListener(ty, f, o), removeEventListener: (t, ty, f, o) => t.removeEventListener(ty, f, o), parentWithClass: (n, c) => n.closest?.('.' + c) } },
      34789: { A: { tv: true } }, 46782: { A: { tv: true } }, 90381: { A: { enableGamepad: () => false } }, 93599: { Ay: { isEnabled: () => false } } };
    const factories = {}, exports = {};
    const inert = () => new Proxy(function () { return inert(); }, { get: (t, k) => k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : inert() });
    const require = id => { if (id in exports) return exports[id]; if (factories[id]) { const m = { exports: {} }; exports[id] = m.exports; factories[id].call(m.exports, m, m.exports, require); return exports[id]; } return stubs[id] || inert(); };
    require.r = t => Object.defineProperty(t, '__esModule', { value: true });
    require.d = (t, g) => { for (const k of Object.keys(g)) if (!(k in t)) Object.defineProperty(t, k, { enumerable: true, get: g[k] }); };
    require.n = m => () => m; require.o = (o, k) => Object.prototype.hasOwnProperty.call(o, k); require.e = () => Promise.resolve();
    for (const text of modules) { const box = new Function(`const module = {}; ${text.replace(/^\/\/.*\n/, '')}\n return module.exports;`)(); factories[box.id] = box.module; }
    (require(74550).Ay).enable();
    window.backs = 0;
  }, HOST_INPUT['12.2']);
  await press(page, page.locator('#openInfo'), isMobile);
  await page.locator('.je-more-info-modal.active').waitFor();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 10009, nativeVirtualKeyCode: 10009, key: 'Unidentified', code: '' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 10009, nativeVirtualKeyCode: 10009, key: 'Unidentified', code: '' });
  await expect.poll(() => page.evaluate(() => !!document.querySelector('.je-more-info-modal')?._isClosing)).toBe(true);
  expect(await page.evaluate(() => window.backs)).toBe(0);
  expect(await page.evaluate(() => location.hash)).toBe('#/search?query=matrix');
});
