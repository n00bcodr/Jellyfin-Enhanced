const { test, expect } = require('@playwright/test');
const { readFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
// Optional real Jellyfin run (redeploy before invoking):
// JE_PANEL_LAB_URL=http://127.0.0.1:18520 JE_PANEL_LAB_USER=real-admin \
// npx playwright test -c tests/browser/playwright.config.cjs settings-panel --project=chromium --workers=1
// The lab password comes from JE_PANEL_LAB_PASSWORD or the local lab accounts file.
const lab = process.env.JE_PANEL_LAB_URL;
const user = process.env.JE_PANEL_LAB_USER || 'real-admin';

/** Load the production panel host in a fixture, or the deployed bundle in the lab. */
async function setup(page) {
  if (lab) {
    const accounts = process.env.JE_PANEL_LAB_PASSWORD ? '' : readFileSync('/home/jake/.config/je-lab/lab-accounts.env', 'utf8');
    const key = user === 'real-admin' ? 'JE_LAB_ADMIN_PASS' : 'JE_LAB_VIEWER_PASS';
    const password = process.env.JE_PANEL_LAB_PASSWORD || accounts.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1];
    if (!password) throw new Error(`Missing lab password for ${user}`);
    await page.goto(`${lab}/web/index.html#/login`, { waitUntil: 'domcontentloaded' });
    const manual = page.getByRole('button', { name: 'Manual Login', exact: true });
    // The host renders the button before attaching its handler on some starts.
    // Retry the entry point until the form is actually visible, as the lab helper does.
    await expect.poll(async () => {
      if (await page.locator('#txtManualName').isVisible()) return true;
      if (await manual.isVisible()) await manual.click({ timeout: 3000 }).catch(() => {});
      return page.locator('#txtManualName').isVisible();
    }, { timeout: 30000, intervals: [250, 500] }).toBe(true);
    await page.locator('#txtManualName').fill(user);
    await page.locator('#txtManualPassword').fill(password);
    await page.locator('#txtManualPassword').press('Enter');
    await page.waitForFunction(() => !!window.JellyfinEnhanced?.showEnhancedPanel, null, { timeout: 30000 });
    await page.evaluate(() => {
      const id = ApiClient.getCurrentUserId();
      localStorage.setItem(`${id}-language`, 'en');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.JellyfinEnhanced?.showEnhancedPanel, null, { timeout: 30000 });
    // Check the deployed host, rather than accidentally testing another worker's bundle.
    expect(await page.evaluate(() => JellyfinEnhanced.showEnhancedPanel.toString())).toContain('guardBlur');
  } else {
    await page.goto('/');
    await page.evaluate(() => {
      document.body.innerHTML = '<button id="opener">Open settings</button>';
      window.ApiClient = { getCurrentUserId: () => 'user-a', getUrl: x => x, ajax: async () => null };
      const ui = { buildPanelHtml: () => '<div class="panel-header"><h2 id="jePanelTitle">Settings</h2><button id="closeSettingsPanel">Close</button></div>' };
      for (const name of ['wireShortcutEditor', 'wireSettingsListeners', 'wireHiddenContentListeners', 'wireMiscSettingsControls', 'wireTagGroupEditor', 'wireLanguageControls']) ui[name] = () => {};
      window.JellyfinEnhanced = { core: { navigation: window.JellyfinEnhanced.core.navigation }, internals: { enhancedUi: ui }, pluginConfig: {}, currentSettings: {}, state: { activeShortcuts: { x: 1 } },
        CONFIG: { HELP_PANEL_AUTOCLOSE_DELAY: 60000 }, keyListener() {}, themer: { getThemeVariables: () => ({}) } };
    });
    await page.addScriptTag({ path: path.join(root, 'enhanced/settingspanel/ui-panel.js') });
  }
}

/** Capture proof only when explicitly requested; normal CI keeps failure artifacts. */
async function shot(page, name, testInfo) {
  if (!process.env.JE_PANEL_SHOTS) return;
  mkdirSync(process.env.JE_PANEL_SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.JE_PANEL_SHOTS, `${user}-${testInfo.project.name}-${name}.png`) });
}

test('settings dialog keeps focus after real background clicks, late controls and a destinationless blur', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && (!lab || /Jellyfin Enhanced|JellyfinEnhanced|🪼/.test(m.text()))) errors.push(m.text()); });
  await setup(page);
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'panel-background-probe'; button.textContent = 'Background';
    button.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:10px;z-index:1000000';
    document.body.append(button);
    button.focus();
  });
  await page.evaluate(() => JellyfinEnhanced.showEnhancedPanel());
  const inside = page.locator('#closeSettingsPanel');
  await inside.focus();
  // Coordinate clicks are required: locator.click correctly refuses to click inert content.
  await page.mouse.click(4, 4);
  await expect(inside).toBeFocused();
  await shot(page, 'background-focus', testInfo);
  await page.evaluate(() => {
    const button = document.createElement('button'); button.id = 'panel-late-probe'; button.textContent = 'Late';
    button.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:10px;z-index:1000000';
    button.onclick = () => { window.lateActivated = true; };
    document.body.append(button);
  });
  await page.mouse.click(4, 4);
  await expect(inside).toBeFocused();
  expect(await page.evaluate(() => !!window.lateActivated)).toBe(false);
  await page.locator('#panel-late-probe').evaluate(el => el.focus());
  await expect(inside).toBeFocused();
  await inside.evaluate(el => el.blur());
  await expect(inside).toBeFocused();
  await inside.click();
  await expect(page.locator('#jellyfin-enhanced-panel')).toHaveCount(0);
  await expect(page.locator('#panel-background-probe')).not.toHaveAttribute('inert');
  await page.locator('#panel-late-probe').click();
  expect(await page.evaluate(() => window.lateActivated)).toBe(true);
  expect(errors, 'JE console/page errors').toEqual([]);
});


test('settings dialog tears down on pushState, back and forward', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && (!lab || /Jellyfin Enhanced|JellyfinEnhanced|🪼/.test(m.text()))) errors.push(m.text()); });
  await setup(page);
  const panel = page.locator('#jellyfin-enhanced-panel');
  await page.evaluate(() => JellyfinEnhanced.showEnhancedPanel());
  await page.evaluate(() => history.pushState({}, '', '#/home?panel-regression=1'));
  await expect(panel).toHaveCount(0);
  await expect(page.locator('body > [inert]')).toHaveCount(0);
  await page.evaluate(() => JellyfinEnhanced.showEnhancedPanel());
  await page.goBack();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('body > [inert]')).toHaveCount(0);
  await page.evaluate(() => JellyfinEnhanced.showEnhancedPanel());
  await page.goForward();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('body > [inert]')).toHaveCount(0);
  await shot(page, 'navigation-released', testInfo);
  expect(errors, 'JE console/page errors').toEqual([]);
});
