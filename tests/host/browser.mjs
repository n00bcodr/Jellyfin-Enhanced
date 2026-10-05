import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { url, password, artifacts, users } = JSON.parse(input);
const browser = await chromium.launch(process.env.JE_CHROMIUM_PATH ? { executablePath: process.env.JE_CHROMIUM_PATH } : {});
const results = [];
try {
  for (const username of users) {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort('blockedbyclient'));
    context.setDefaultTimeout(30000);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
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
      expect(payload.UserId).toBeTruthy();
      await page.waitForFunction(() => window.JellyfinEnhanced?.currentSettings && typeof window.JellyfinEnhanced?.showEnhancedPanel === 'function', null, { timeout: 60000 });
      await page.locator('body').click({ position: { x: 1000, y: 950 } });
      await page.keyboard.press('?');
      const panel = page.locator('#jellyfin-enhanced-panel');
      await expect(panel).toBeVisible({ timeout: 30000 });
      await panel.locator('[data-tab="playback"]').click();
      const toggle = page.locator('#autoPauseToggle');
      const before = await toggle.isChecked();
      const saved = page.waitForResponse(r => r.url().includes('/settings.json') && r.request().method() === 'POST' && r.request().postDataJSON()?.AutoPauseEnabled === !before && r.status() === 200);
      await toggle.setChecked(!before);
      await saved;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.JellyfinEnhanced?.currentSettings && typeof window.JellyfinEnhanced?.showEnhancedPanel === 'function', null, { timeout: 60000 });
      await page.locator('body').click({ position: { x: 1000, y: 950 } });
      await page.keyboard.press('?');
      await expect(page.locator('#jellyfin-enhanced-panel')).toBeVisible({ timeout: 30000 });
      await page.locator('#jellyfin-enhanced-panel [data-tab="playback"]').click();
      await expect(page.locator('#autoPauseToggle')).toBeChecked({ checked: !before });
      expect(errors, 'Uncaught browser errors').toEqual([]);
      results.push({ username, status: 'passed', checks: ['real login', 'injected bootstrap', 'keyboard panel', 'save preference', 'reload persistence', 'no uncaught errors'] });
      console.log(`PASS real browser ${username}: login, bootstrap, panel, save/reload`);
    } catch (error) {
      results.push({ username, status: 'failed', error: error.message, pageErrors: errors });
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
