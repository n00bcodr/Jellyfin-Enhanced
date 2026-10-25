// D46 slice 2 review round 12, where trust is real: Chromium's own input (a CDP mouse click, a phone tap, a key press)
// is the viewer's; a script's click(), a re-dispatched event or a script's key is no one's — on a relay, on a
// surface's final control (the request sheet's Request, the Hide confirmation's Hide) and on its dismissal alike.
// Another Jellyfin client's remote "Select" is the viewer's through jellyfin-web's real path (its server
// notifications on a real WebSocket, its input manager). Closing More after its card went leaves focus on the live
// page; More Info is a named modal dialog whose covered page is out of the accessibility tree. Desktop Chromium and
// mobile Chromium (Pixel 7: touch, 390 px). Offline: only the server (fetch) is scripted; the remote server is a
// loopback WebSocket in this process.
const { test, expect } = require('@playwright/test');
const { read, boot, request, press, loadHost, remoteServer } = require('./title-actions-host.cjs');

test.skip(({ browserName }) => browserName !== 'chromium', 'checked with Chromium\'s own (CDP) input and accessibility tree');

const requests = page => page.evaluate(() => window.sent.filter(([m, p]) => m === 'POST' && p === '/jellyseerr/request').map(r => r[2].mediaId));

test('a title action\'s relayed press acts once on its own target; replayed onto 604 or 603 again, it is no one\'s', async ({ page, isMobile }) => {
  const host = await boot(page);
  await page.evaluate(() => {
    const JE = window.JellyfinEnhanced;
    const a = document.querySelector('#card603 .jellyseerr-split-main, #card603 .jellyseerr-request-button');
    a.addEventListener('click', event => { window.relayEvent = event; });
    const relay = document.createElement('button'); relay.id = 'relay'; relay.textContent = 'Request first';
    relay.onclick = e => JE.press(a, JE.operation({ parent: JE.ownerOf(e) })); document.body.append(relay);
  });
  await press(page, page.locator('#relay'), isMobile);
  await expect.poll(() => requests(page)).toEqual([603]);
  await page.evaluate(() => document.querySelector('#card604 .jellyseerr-split-main, #card604 .jellyseerr-request-button').dispatchEvent(window.relayEvent));
  await page.evaluate(() => { const b = document.querySelector('#card603 .jellyseerr-split-main, #card603 .jellyseerr-request-button'); b.disabled = false; b.dispatchEvent(window.relayEvent); });
  await page.waitForTimeout(200);
  expect(await requests(page)).toEqual([603]);
  expect(host.errors).toEqual([]);
});

/** The JE-mode request sheet's modules and an answering server for its reads and asks. */
async function askSheet(page) {
  await page.evaluate(() => {
    const old = window.fetch;
    window.fetch = async (url, init = {}) => {
      const p = String(url).replace(location.origin, '').replace('/JellyfinEnhanced', '');
      if (!p.startsWith('/acquire/requests')) return old(url, init);
      window.sent.push([init.method || 'GET', p, init.body ? JSON.parse(init.body) : null]);
      const body = p.endsWith('/me') ? { me: { role: 'member', canRequest: true, canRequestMovies: true, canRequestSeries: true, backend: 'je', contact: 'Dad' } }
        : p.includes('/quota') ? { quota: { available: true, limit: 10, used: 0, remaining: 10 } }
        : p.includes('/check') ? { check: { canRequest: true } } : { outcome: 'accepted', reason: 'looking', certainty: 'Succeeded', requestId: 'a'.repeat(32) };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    window.JellyfinEnhanced.pluginConfig.ArrRequestsEnabled = true;
  });
  for (const file of ['arr/ask/ask-core.js', 'arr/ask/ask-sheet-styles.js', 'arr/ask/ask-sheet.js']) await page.addScriptTag({ content: read('Jellyfin.Plugin.JellyfinEnhanced/js/' + file) });
  await page.evaluate(() => {
    const JE = window.JellyfinEnhanced;
    const b = document.createElement('button'); b.id = 'askSheet'; b.textContent = 'Open request choices';
    b.onclick = e => { JE.arrAskSheet.open({ key: 'movie:tmdb:603', kind: 'movie', name: 'Movie' }, { operation: JE.ownerOf(e) }); };
    document.body.append(b);
  });
}
const asks = page => page.evaluate(() => window.sent.filter(([m, p]) => m === 'POST' && p === '/acquire/requests').length);

test('the request sheet: a script\'s Request sends nothing and the sheet stays; the viewer\'s press asks once', async ({ page, isMobile }) => {
  const host = await boot(page);
  await askSheet(page);
  await press(page, page.locator('#askSheet'), isMobile);
  await page.waitForSelector('.je-sheet-primary');
  await page.evaluate(() => document.querySelector('.je-sheet-primary').click());
  await page.waitForTimeout(150);
  expect(await asks(page)).toBe(0);
  expect(await page.locator('.je-sheet').count()).toBe(1);
  await press(page, page.locator('.je-sheet-primary'), isMobile);
  await expect.poll(() => asks(page)).toBe(1);
  expect(host.errors).toEqual([]);
});

test('the Hide confirmation: a script\'s Hide writes nothing; the viewer\'s press hides the title', async ({ page, isMobile }) => {
  const host = await boot(page);
  await page.evaluate(() => { window.JellyfinEnhanced.userConfig = { hiddenContent: { items: {}, settings: { enabled: true, showHideButtons: true, showButtonJellyseerr: true, showHideConfirmation: true } } }; });
  for (const file of ['enhanced/hiddencontent/hidden-content-data.js', 'enhanced/hiddencontent/hidden-content-dialogs.js']) await page.addScriptTag({ content: read('Jellyfin.Plugin.JellyfinEnhanced/js/' + file) });
  await page.evaluate(() => {
    const hc = window.JellyfinEnhanced.internals.hiddenContent; hc.refreshNativeCardVisibility = () => {};
    const control = hc.buildTitleControl({ mediaType: 'movie', tmdbId: 603, name: 'Movie' }); control.id = 'hideMovie'; document.body.append(control);
  });
  await press(page, page.locator('#hideMovie'), isMobile);
  await page.waitForSelector('.je-hide-confirm-hide');
  const puts = () => page.evaluate(() => window.sent.filter(([m, p]) => m === 'PUT' && p.includes('/hidden-content/rule/')).length);
  await page.evaluate(() => document.querySelector('.je-hide-confirm-hide').click());
  await page.waitForTimeout(150);
  expect(await puts()).toBe(0);
  await press(page, page.locator('.je-hide-confirm-hide'), isMobile);
  await expect.poll(puts).toBe(1);
  expect(host.errors).toEqual([]);
});

for (const version of ['12.2', '10.11.11']) {
  test(`another client's remote Select (jellyfin-web ${version}: a real server message → its input manager) requests the focused title once; a script's click or command does not`, async ({ page }) => {
    const host = await boot(page);
    const server = await remoteServer();
    try {
      await loadHost(page, version, { remote: server.url });
      await request(page, 603).focus();
      await page.evaluate(() => {
        document.activeElement.click();
        document.activeElement.dispatchEvent(new CustomEvent('command', { detail: { command: 'select' }, bubbles: true, cancelable: true }));
        window.hostInput.handleCommand('select');
      });
      await page.waitForTimeout(150);
      expect(await requests(page)).toEqual([]);
      server.command('Select');
      await expect.poll(() => page.evaluate(() => window.remoteMessages)).toBe(1);
      await expect.poll(() => requests(page)).toEqual([603]);
      expect(host.errors).toEqual([]);
    } finally { await server.close(); }
  });
}

test('More closed after its card went: the page is live again and focus is on a live page control, never the body', async ({ page, isMobile }) => {
  const host = await boot(page);
  await press(page, page.locator('#card603 .je-card-more'), isMobile);
  await page.waitForSelector('.je-actions-backdrop');
  await page.evaluate(() => document.querySelector('#card603').remove());
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => !!document.querySelector('.je-actions-backdrop'))).toBe(false);
  const focus = await page.evaluate(() => ({ body: document.activeElement === document.body, id: document.activeElement.id, inert: [...document.body.children].filter(n => n.inert).map(n => n.id || n.className) }));
  expect(focus.body).toBe(false);
  expect(focus.id).toBe('pagePlay');
  expect(focus.inert).toEqual([]);
  expect(host.errors).toEqual([]);
});

/** The non-ignored accessibility tree's nodes (Chromium's own, through CDP). */
async function axTree(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const { result } = await cdp.send('Runtime.evaluate', { expression: "document.querySelector('#card604 .jellyseerr-split-main, #card604 .jellyseerr-request-button')" });
    const { node } = await cdp.send('DOM.describeNode', { objectId: result.objectId });
    const live = nodes.filter(n => !n.ignored);
    return { coveredRequest: live.some(n => n.backendDOMNodeId === node.backendNodeId), dialogs: live.filter(n => n.role?.value === 'dialog').map(n => n.name?.value || ''),
      behind: live.some(n => n.role?.value === 'button' && n.name?.value === 'A card behind') };
  } finally { await cdp.detach(); }
}

test('More Info is a named modal dialog; the covered page\'s Request is out of the accessibility tree, and back once it closes', async ({ page, isMobile }) => {
  const host = await boot(page);
  await press(page, page.locator('#openInfo'), isMobile);
  await page.locator('.je-more-info-modal.active').waitFor();
  const open = await axTree(page);
  expect(open.dialogs.length).toBe(1);
  expect(open.dialogs[0]).not.toBe('');
  expect(open.coveredRequest).toBe(false);
  expect(open.behind).toBe(false);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => !!document.querySelector('.je-more-info-modal')?._isClosing)).toBe(true);
  const closed = await axTree(page);
  expect(closed.coveredRequest).toBe(true);
  expect(closed.behind).toBe(true);
  expect(host.errors).toEqual([]);
});
