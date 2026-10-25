// D46 slice 2 review round 11: the action bar's trust boundary where trust is real. Chromium's own input (CDP: a mouse
// click, a phone tap, a key press) is the viewer's; a script's click() or a re-dispatched event is not, whatever has
// focus. jellyfin-web's own gamepad activation of the focused control (its real gamepad-to-key and keyboard navigation
// modules, 12.2 and 10.11.11) is the viewer's too. The production modules run on a mock host page; only the server
// (fetch) is scripted. Desktop Chromium and mobile Chromium (Pixel 7: touch, 390 px).
const { test, expect } = require('@playwright/test');
const { HOST_INPUT, boot, request, press } = require('./title-actions-host.cjs');

test.skip(({ browserName }) => browserName !== 'chromium', 'the trust boundary is checked with Chromium\'s own (CDP) input');

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
