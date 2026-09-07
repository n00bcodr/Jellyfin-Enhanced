// Browser regression check against a running Jellyfin test server.
// Requires Playwright, an authenticated administrator storageState file, this
// JE build installed, and the unified Enhanced + Ani-Sync test repositories.
// JELLYFIN_URL=http://localhost:8096 JELLYFIN_STORAGE_STATE=/path/state.json node scripts/test-plugin-revisions.cjs
// Optional: CHROMIUM_PATH=/usr/bin/chromium. Install requests are intercepted.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

(async () => {
    const base = process.env.JELLYFIN_URL || 'http://localhost:8096';
    assert.ok(process.env.JELLYFIN_STORAGE_STATE, 'Set JELLYFIN_STORAGE_STATE to an authenticated admin browser state');
    const browser = await chromium.launch({
        headless: true,
        ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
    });
    try {
        const context = await browser.newContext({ storageState: process.env.JELLYFIN_STORAGE_STATE });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        const cases = [
            ['Jellyfin Enhanced', 'f69e946a4b3c4e9a8f0a8d7c1b2c4d9b'],
            ['Ani-Sync', 'c78f11cf93e644238c42d2c255b70e47'],
            ['JavaScript Injector', 'f5a34f7b2e8a4e6aa7223a216a81b374'],
            ['Jellyfin Enhanced', 'f69e946a4b3c4e9a8f0a8d7c1b2c4d9b']
        ];
        for (const [name, id] of cases) {
            await page.goto(`${base}/web/#/dashboard/plugins/${id}?name=${encodeURIComponent(name)}`);
            await page.waitForFunction(() => window.JellyfinEnhanced?.initialized, null, { timeout: 60000 });
            assert.equal(await page.evaluate(() => typeof window.JeRevisionPreview), 'undefined', 'Standalone preview must be removed');
            await page.waitForFunction(() => document.querySelector('#addPluginPage .je-duplicate-plugin-revision'));
            const result = await page.locator('#addPluginPage .MuiAccordion-root').evaluateAll(rows => {
                const version = row => row.querySelector('.MuiAccordionSummary-content').textContent.trim().split(/\s/)[0];
                const visible = rows.filter(row => getComputedStyle(row).display !== 'none');
                return { total: rows.length, unique: new Set(rows.map(version)).size, versions: visible.map(version) };
            });
            assert.equal(result.versions.length, result.unique);
            assert.equal(new Set(result.versions).size, result.versions.length);
            assert.ok(result.total > result.unique, `${name} needs duplicate revisions to exercise this test`);
            console.log(`${name}: ${result.total} rows, ${result.versions.length} visible`);
        }

        // Reinitialization must restore/reapply visibility without accumulating subscribers.
        const subscribers = await page.evaluate(() => JellyfinEnhanced.core.dom.getBodySubscriberCount());
        await page.evaluate(() => { JellyfinEnhanced.initializePluginRevisions(); JellyfinEnhanced.initializePluginRevisions(); });
        await page.waitForFunction(() => document.querySelector('#addPluginPage .je-duplicate-plugin-revision'));
        assert.equal(await page.evaluate(() => JellyfinEnhanced.core.dom.getBodySubscriberCount()), subscribers);

        // Expanding/installing the retained revision must keep its request parameters.
        let intercepted;
        await page.route('**/Packages/Installed/**', async route => {
            intercepted = route.request().url();
            await route.fulfill({ status: 204 });
        });
        const row = page.getByRole('button', { name: /^12\.4\.1\.0/ });
        assert.equal(await row.count(), 1);
        await row.click();
        const accordion = row.locator('xpath=ancestor::*[contains(@class,"MuiAccordion-root")][1]');
        await accordion.getByRole('button', { name: 'Install', exact: true }).click();
        const response = page.waitForResponse(r => r.url().includes('/Packages/Installed/'));
        await page.getByRole('dialog').getByRole('button', { name: 'Install', exact: true }).click();
        await response;
        assert.equal(new URL(intercepted).searchParams.get('version'), '12.4.1.0');
        assert.ok(new URL(intercepted).searchParams.get('repositoryUrl'));

        await page.evaluate(() => JellyfinEnhanced.core.lifecycle.get('plugin-revisions').teardown());
        assert.equal(await page.locator('.je-duplicate-plugin-revision').count(), 0);
        await page.goto(`${base}/web/#/configurationpage?name=Jellyfin%20Enhanced`);
        await page.locator('#JellyfinEnhancedPage').waitFor({ state: 'attached' });
        assert.equal(await page.locator('#je-host-mismatch').count(), 0);
        assert.deepEqual(errors, []);
        console.log('PASS: navigation, reinitialization, install request, teardown and banner removal');
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
