import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { url, password, artifacts, users, bookmarkFixture } = JSON.parse(input);
const browser = await chromium.launch(process.env.JE_CHROMIUM_PATH ? { executablePath: process.env.JE_CHROMIUM_PATH } : {});
const results = [];
try {
  for (const username of users) {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort('blockedbyclient'));
    context.setDefaultTimeout(30000);
    const page = await context.newPage();
    const errors = [];
    const consoleErrors = [];
    let bootstrapShape;
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') consoleErrors.push(message.text());
    });
    const settingsRequests = [];
    const bookmarkChecks = [];
    const fixture = bookmarkFixture?.username === username ? bookmarkFixture : null;
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      if (!/\/(settings-document|settings\.json)$/.test(pathname)) return;
      const request = response.request();
      let body;
      try { body = request.postDataJSON(); } catch { body = null; }
      settingsRequests.push({ route: pathname.split('/').at(-1), method: request.method(), status: response.status(),
        hasRevision: typeof body?.Revision === 'string', autoPause: body?.Settings?.AutoPauseEnabled,
        camelAutoPause: body?.Settings?.autoPauseEnabled, legacyAutoPause: body?.AutoPauseEnabled });
    });
    try {
      await page.goto(`${url}/web/index.html#!/login.html`, { waitUntil: 'domcontentloaded' });
      const manual = page.getByRole('button', { name: /manual login|sign in manually/i });
      if (await manual.isVisible()) await manual.click();
      await page.getByLabel(/^User(name)?$/i).fill(username, { timeout: 45000 });
      await page.getByLabel('Password', { exact: true }).fill(password);
      const bootstrap = page.waitForResponse(response => response.url().includes('/JellyfinEnhanced/bootstrap') && response.status() === 200, { timeout: 60000 });
      await page.getByRole('button', { name: 'Sign In', exact: true }).click();
      const response = await bootstrap;
      const payload = await response.json();
      bootstrapShape = {keys:Object.keys(payload),userSettingsKeys:Object.keys(payload.UserSettings||{}),
        bookmarkSnapshotKeys:Object.keys(payload.UserSettings?.BookmarkSnapshot||{})};
      expect(payload.UserId).toBeTruthy();
      await page.waitForFunction(() => window.JellyfinEnhanced?.currentSettings && typeof window.JellyfinEnhanced?.showEnhancedPanel === 'function', null, { timeout: 60000 });
      if (fixture) {
        await page.waitForFunction(id => typeof window.JellyfinEnhanced?.bookmarks?.update === 'function'
          && typeof window.JellyfinEnhanced?.userConfig?.bookmarkRevision === 'string'
          && !!window.JellyfinEnhanced?.userConfig?.bookmark?.bookmarks?.[id], fixture.id);
        const loaded = await page.evaluate(id => {
          const je = window.JellyfinEnhanced;
          return { label: je.userConfig.bookmark.bookmarks[id].label,
            timestamp: je.userConfig.bookmark.bookmarks[id].timestamp, revision: je.userConfig.bookmarkRevision };
        }, fixture.id);
        expect(loaded.label).toBe(fixture.label);expect(loaded.timestamp).toBe(fixture.timestamp);
        const savedBookmark = page.waitForResponse(r => r.url().endsWith('/bookmark-document')
          && r.request().method() === 'POST' && typeof r.request().postDataJSON()?.Revision === 'string'
          && r.status() === 200);
        const accepted = await page.evaluate(({id,savedLabel}) => window.JellyfinEnhanced.bookmarks.update(id,{label:savedLabel}), fixture);
        expect(accepted).toBe(true);
        const receipt = await (await savedBookmark).json();
        expect(receipt.Revision).toBeTruthy();expect(receipt.Revision).not.toBe(loaded.revision);
        bookmarkChecks.push('real bootstrap bookmark snapshot', 'public bookmark facade guarded mutation');
      }
      await page.locator('body').click({ position: { x: 1000, y: 950 } });
      await page.keyboard.press('?');
      const panel = page.locator('#jellyfin-enhanced-panel');
      await expect(panel).toBeVisible({ timeout: 30000 });
      await panel.locator('[data-tab="playback"]').click();
      const toggle = page.locator('#autoPauseToggle');
      const before = await toggle.isChecked();
      const saved = page.waitForResponse(r => r.url().includes('/settings-document') && r.request().method() === 'POST'
        && r.request().postDataJSON()?.Settings?.AutoPauseEnabled === !before
        && typeof r.request().postDataJSON()?.Revision === 'string' && r.status() === 200);
      await toggle.setChecked(!before);
      await saved;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.JellyfinEnhanced?.currentSettings && typeof window.JellyfinEnhanced?.showEnhancedPanel === 'function', null, { timeout: 60000 });
      await page.locator('body').click({ position: { x: 1000, y: 950 } });
      await page.keyboard.press('?');
      await expect(page.locator('#jellyfin-enhanced-panel')).toBeVisible({ timeout: 30000 });
      await page.locator('#jellyfin-enhanced-panel [data-tab="playback"]').click();
      await expect(page.locator('#autoPauseToggle')).toBeChecked({ checked: !before });
      if (fixture) {
        await page.waitForFunction(id => !!window.JellyfinEnhanced?.userConfig?.bookmark?.bookmarks?.[id],fixture.id);
        const label = await page.evaluate(id => window.JellyfinEnhanced.userConfig.bookmark.bookmarks[id].label,fixture.id);
        expect(label).toBe(fixture.savedLabel);
        bookmarkChecks.push('bookmark exact label persists after reload');
      }
      expect(errors, 'Uncaught browser errors').toEqual([]);
      results.push({ username, status: 'passed', checks: ['real login', 'injected bootstrap', 'keyboard panel', 'save preference', 'reload persistence', 'no uncaught errors', ...bookmarkChecks] });
      console.log(`PASS real browser ${username}: login, bootstrap, panel, save/reload`);
    } catch (error) {
      const settingsState = await page.evaluate(() => {
        const je = window.JellyfinEnhanced;
        return { hasRevision: typeof je?.userConfig?.settingsRevision === 'string',
          autoPause: je?.currentSettings?.autoPauseEnabled,
          saveFunction: typeof je?.saveUserSettings,
          userConfigKeys: Object.keys(je?.userConfig || {}),
          toast: document.querySelector('.jellyfin-enhanced-toast')?.textContent };
      }).catch(() => null);
      const token = await page.evaluate(() => window.ApiClient?.accessToken?.()).catch(() => null);
      const redact = value => {
        let text = value.replaceAll(password, '[REDACTED]');
        if (token) text = text.replaceAll(token, '[REDACTED]');
        return text;
      };
      results.push({ username, status: 'failed', error: error.message, pageErrors: errors.map(redact),
        consoleErrors:consoleErrors.map(redact),bootstrapShape,settingsRequests,settingsState });
      await page.screenshot({ path: `${artifacts}/browser-${username}-failure.png`, fullPage: true });
      // Deliberately do not capture traces/HAR/storage: those contain session credentials.
      throw new Error(`${username}: ${error.message}; page errors: ${JSON.stringify(errors)}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await fs.writeFile(`${artifacts}/browser-report.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
