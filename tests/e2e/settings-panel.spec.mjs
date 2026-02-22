import { test, expect, openSettingsPanel, closeSettingsPanel, openSpoilerSection } from './fixtures.mjs';

test.describe('Settings Panel — Rendering', () => {
    test.beforeEach(async ({ page }) => {
        await openSettingsPanel(page);
    });

    test('panel opens and has correct structure', async ({ page }) => {
        const panel = page.locator('#jellyfin-enhanced-panel');
        await expect(panel).toBeVisible();

        // Should have tab buttons
        const tabs = panel.locator('.tab-button');
        await expect(tabs).toHaveCount(2); // shortcuts + settings
    });

    test('settings tab is visible and has content', async ({ page }) => {
        const settingsContent = page.locator('#settings-content');
        await expect(settingsContent).toBeVisible();

        // Should have at least one details section (collapsible)
        const detailsSections = settingsContent.locator('details');
        const count = await detailsSections.count();
        expect(count).toBeGreaterThanOrEqual(1);
    });

    test('spoiler mode section exists and can be expanded', async ({ page }) => {
        await openSpoilerSection(page);

        // Master enable toggle should be present
        await expect(page.locator('#spoilerEnabledToggle')).toBeVisible();
    });

    test('all spoiler mode controls render', async ({ page }) => {
        await openSpoilerSection(page);

        // Master toggles
        await expect(page.locator('#spoilerEnabledToggle')).toBeVisible();
        await expect(page.locator('#spoilerShowButtons')).toBeVisible();
        await expect(page.locator('#spoilerConfirmDisable')).toBeVisible();

        // Protection toggles
        await expect(page.locator('#spoilerProtectHome')).toBeVisible();
        await expect(page.locator('#spoilerProtectSearch')).toBeVisible();
        await expect(page.locator('#spoilerProtectOverlay')).toBeVisible();
        await expect(page.locator('#spoilerProtectCalendar')).toBeVisible();
        await expect(page.locator('#spoilerProtectRecentlyAdded')).toBeVisible();
        await expect(page.locator('#spoilerProtectEpisodeDetails')).toBeVisible();

        // Hide toggles
        await expect(page.locator('#spoilerHideRuntime')).toBeVisible();
        await expect(page.locator('#spoilerHideAirDate')).toBeVisible();
        await expect(page.locator('#spoilerHideGuestStars')).toBeVisible();
        await expect(page.locator('#spoilerShowOverview')).toBeVisible();

        // Artwork policy
        await expect(page.locator('#spoilerArtworkPolicy')).toBeVisible();

        // Reveal duration
        await expect(page.locator('#spoilerRevealDuration')).toBeVisible();

        // Watched threshold
        await expect(page.locator('#spoilerWatchedThreshold')).toBeVisible();

        // Auto-enable on first play
        await expect(page.locator('#spoilerAutoEnableFirstPlay')).toBeVisible();

        // Tag auto-enable input
        await expect(page.locator('#spoilerTagAutoEnable')).toBeVisible();
    });

    test('artwork policy selector has expected options', async ({ page }) => {
        await openSpoilerSection(page);
        const artwork = page.locator('#spoilerArtworkPolicy');
        const options = artwork.locator('option');
        const values = await options.evaluateAll(opts => opts.map(o => o.value));
        expect(values).toContain('blur');
        expect(values).toContain('generic');
    });

    test('reveal duration selector has expected options', async ({ page }) => {
        await openSpoilerSection(page);
        const select = page.locator('#spoilerRevealDuration');
        const options = select.locator('option');

        // Should have 5s, 10s, 15s, 30s, 60s
        const values = await options.evaluateAll(opts => opts.map(o => o.value));
        expect(values).toContain('5000');
        expect(values).toContain('10000');
        expect(values).toContain('30000');
        expect(values).toContain('60000');
    });

    test('watched threshold has expected options', async ({ page }) => {
        await openSpoilerSection(page);
        const select = page.locator('#spoilerWatchedThreshold');
        const values = await select.locator('option').evaluateAll(opts => opts.map(o => o.value));
        expect(values).toContain('played');
        expect(values).toContain('90percent');
    });

    test('panel closes on Escape', async ({ page }) => {
        const panel = page.locator('#jellyfin-enhanced-panel');
        await expect(panel).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(panel).not.toBeVisible({ timeout: 3000 });
    });

    test('panel closes on ? key (toggle)', async ({ page }) => {
        const panel = page.locator('#jellyfin-enhanced-panel');
        await expect(panel).toBeVisible();
        await page.keyboard.press('?');
        await expect(panel).not.toBeVisible({ timeout: 3000 });
    });

    test('protected items count is displayed', async ({ page }) => {
        await openSpoilerSection(page);
        // The protected count text should be in the spoiler section
        const countText = page.locator('#settings-content').getByText(/protected/i);
        await expect(countText).toBeVisible();
    });
});
