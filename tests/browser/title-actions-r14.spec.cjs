// D46 slice 2 review round 14, in Chromium: another Jellyfin client's remote Back (jellyfin-web's real server-message →
// input-manager path on a real loopback WebSocket, its router published as window.Emby.Page with the real routers' gate)
// closes only the top JE surface opened on HOME — where the router itself cannot go back — with no router step and no
// Exit; and Hide started from More Info's own managed controls (its original Hide, and More → Hide) offers an Undo
// inside More Info that the viewer reaches, focuses and presses. Offline: only the server (fetch) is scripted.
const { test, expect } = require('@playwright/test');
const { read, boot, press, loadHost, remoteServer } = require('./title-actions-host.cjs');

test.skip(({ browserName }) => browserName !== 'chromium', 'checked with Chromium\'s own input and accessibility tree');

for (const version of ['12.2', '10.11.11']) {
  for (const surface of ['More Info', 'More sheet']) {
    test(`another client's remote Back on Home (jellyfin-web ${version}) closes the top ${surface}; no router step, no Exit`, async ({ page, isMobile }) => {
      const host = await boot(page, { layout: 'tv', home: true });
      expect(await page.evaluate(() => [location.hash, history.length > 1])).toEqual(['#/home', true]);
      const server = await remoteServer();
      try {
        await loadHost(page, version, { tv: true, remote: server.url, history: true, exit: true });
        expect(await page.evaluate(() => window.Emby.Page.canGoBack())).toBe(false);
        if (surface === 'More Info') { await press(page, page.locator('#openInfo'), isMobile); await page.locator('.je-more-info-modal.active').waitFor(); }
        else { await press(page, page.locator('#card603 .je-card-more'), isMobile); await page.locator('.je-actions-backdrop').waitFor(); }
        const open = () => page.evaluate(s => s === 'More Info' ? !!document.querySelector('.je-more-info-modal.active:not([inert])') : !!document.querySelector('.je-actions-backdrop'), surface);
        server.command('Back');
        await expect.poll(() => page.evaluate(() => window.remoteMessages)).toBe(1);
        await expect.poll(open).toBe(false);
        await page.waitForTimeout(100);
        expect(await page.evaluate(() => ({ hash: location.hash, backs: window.backs, exits: window.exits }))).toEqual({ hash: '#/home', backs: 0, exits: 0 });
        // With no JE surface, the host keeps its own Back: on Home its router cannot go back, so the app exits.
        server.command('Back');
        await expect.poll(() => page.evaluate(() => window.exits)).toBe(1);
        expect(host.errors).toEqual([]);
      } finally { await server.close(); }
    });
  }
}

/** The hidden-content modules with More Info's own Hide, and More Info opened by the viewer (the action bar is on). */
async function managedInfo(page, isMobile) {
  await page.evaluate(() => { window.JellyfinEnhanced.userConfig = { hiddenContent: { items: {}, settings: { enabled: true, showHideButtons: true, showButtonDetails: true, showButtonJellyseerr: true, showHideConfirmation: true } } }; });
  for (const file of ['enhanced/hiddencontent/hidden-content-data.js', 'enhanced/hiddencontent/hidden-content-dialogs.js']) await page.addScriptTag({ content: read('Jellyfin.Plugin.JellyfinEnhanced/js/' + file) });
  await page.evaluate(() => {
    const JE = window.JellyfinEnhanced; const hc = JE.internals.hiddenContent; hc.refreshNativeCardVisibility = () => {};
    JE.hiddenContent = { buildTitleControl: hc.buildTitleControl };
  });
  await press(page, page.locator('#openInfo'), isMobile);
  await page.locator('.je-more-info-modal.active [data-mount="je-secondary-actions"] .je-detail-hide-btn').waitFor({ state: 'attached' });
  await page.locator('.je-more-info-modal.active .je-actions-more').waitFor();
}

// More → Hide is the viewer's path to More Info's own Hide: its row is compact (as on 12.2's More Info at every width
// checked live), so the original is kept but not shown. 'its original Hide (constructed: shown)' shows that original as a
// wider row would and presses it, the action bar's bound direct path.
for (const via of ['its original Hide (constructed: shown)', 'More → Hide']) {
  test(`Hide from More Info via ${via}: one PUT, and its Undo inside More Info is in the accessibility tree, takes focus and undoes`, async ({ page, isMobile }) => {
    const host = await boot(page);
    await managedInfo(page, isMobile);
    const original = page.locator('.je-more-info-modal.active [data-mount="je-secondary-actions"] .je-detail-hide-btn').first();
    if (via.startsWith('its original Hide')) {
      await page.evaluate(() => document.querySelector('.je-more-info-modal.active [data-mount="je-secondary-actions"] .je-detail-hide-btn').classList.remove('je-actions-external-original'));
      await press(page, original, isMobile);
    } else {
      expect(await original.isVisible()).toBe(false);
      await press(page, page.locator('.je-more-info-modal.active .je-actions-wide-more, .je-more-info-modal.active .je-actions-more').filter({ visible: true }).first(), isMobile);
      await press(page, page.locator('.je-actions-entry[data-action="hide"]'), isMobile);
    }
    await press(page, page.locator('.je-hide-confirm-hide'), isMobile);
    const writes = method => page.evaluate(m => window.sent.filter(([x, p]) => x === m && p.includes('/hidden-content/rule/')).length, method);
    await expect.poll(() => writes('PUT')).toBe(1);
    const undo = page.locator('.je-more-info-modal.active .je-undo-toast .je-undo-btn');
    await undo.waitFor();
    expect(await page.evaluate(() => !document.querySelector('.je-undo-toast').closest('[inert]'))).toBe(true);
    const cdp = await page.context().newCDPSession(page);
    const { nodes } = await cdp.send('Accessibility.getFullAXTree'); await cdp.detach();
    const label = (await undo.textContent()).trim();
    expect(nodes.some(n => !n.ignored && n.role?.value === 'button' && n.name?.value === label)).toBe(true);
    await undo.focus();
    expect(await page.evaluate(() => document.activeElement?.classList.contains('je-undo-btn'))).toBe(true);
    await press(page, undo, isMobile);
    await expect.poll(() => writes('DELETE')).toBe(1);
    expect(await page.evaluate(() => !!document.querySelector('.je-more-info-modal.active'))).toBe(true);
    expect(host.errors).toEqual([]);
  });
}
