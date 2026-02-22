import { test, expect, openSettingsPanel, closeSettingsPanel, openSpoilerSection, getSpoilerSetting } from './fixtures.mjs';

test.describe('Spoiler Mode — Enable/Disable Toggle', () => {
    test.beforeEach(async ({ page }) => {
        await openSettingsPanel(page);
        await openSpoilerSection(page);
    });

    test('enabled toggle reflects current state', async ({ page }) => {
        const toggle = page.locator('#spoilerEnabledToggle');
        const isChecked = await toggle.isChecked();
        const settingValue = await getSpoilerSetting(page, 'enabled');

        // If enabled is not explicitly false, the toggle should be checked
        if (settingValue === false) {
            expect(isChecked).toBe(false);
        } else {
            expect(isChecked).toBe(true);
        }
    });

    test('toggling enabled updates the setting', async ({ page }) => {
        const toggle = page.locator('#spoilerEnabledToggle');
        const wasBefore = await toggle.isChecked();

        await toggle.click();
        await page.waitForTimeout(500);

        const isAfter = await toggle.isChecked();
        expect(isAfter).toBe(!wasBefore);

        const setting = await getSpoilerSetting(page, 'enabled');
        expect(setting).toBe(!wasBefore);

        // Restore original state
        await toggle.click();
        await page.waitForTimeout(500);
    });

    test('show buttons toggle updates the setting', async ({ page }) => {
        const toggle = page.locator('#spoilerShowButtons');
        const before = await toggle.isChecked();
        await toggle.click();
        await page.waitForTimeout(500);

        const setting = await getSpoilerSetting(page, 'showButtons');
        expect(setting).toBe(!before);

        // Restore
        await toggle.click();
        await page.waitForTimeout(500);
    });

    test('confirm disable toggle updates the setting', async ({ page }) => {
        const toggle = page.locator('#spoilerConfirmDisable');
        const before = await toggle.isChecked();
        await toggle.click();
        await page.waitForTimeout(500);

        const setting = await getSpoilerSetting(page, 'showDisableConfirmation');
        expect(setting).toBe(!before);

        // Restore
        await toggle.click();
        await page.waitForTimeout(500);
    });
});

test.describe('Spoiler Mode — Artwork Policy Selection', () => {
    test.beforeEach(async ({ page }) => {
        await openSettingsPanel(page);
        await openSpoilerSection(page);
    });

    test('artwork policy selector reflects current value', async ({ page }) => {
        const select = page.locator('#spoilerArtworkPolicy');
        const selectedValue = await select.inputValue();
        const setting = await getSpoilerSetting(page, 'artworkPolicy');
        expect(selectedValue).toBe(setting || selectedValue);
    });

    test('changing artwork policy updates the setting', async ({ page }) => {
        const select = page.locator('#spoilerArtworkPolicy');
        const originalValue = await select.inputValue();

        // Get all option values
        const options = await select.locator('option').evaluateAll(opts => opts.map(o => o.value));
        const newValue = options.find(v => v !== originalValue) || options[0];

        await select.selectOption(newValue);
        await page.waitForTimeout(500);

        const setting = await getSpoilerSetting(page, 'artworkPolicy');
        expect(setting).toBe(newValue);

        // Restore
        await select.selectOption(originalValue);
        await page.waitForTimeout(500);
    });
});

test.describe('Spoiler Mode — Protection Toggles', () => {
    const protectionToggles = [
        ['spoilerProtectHome', 'protectHome'],
        ['spoilerProtectSearch', 'protectSearch'],
        ['spoilerProtectOverlay', 'protectOverlay'],
        ['spoilerProtectCalendar', 'protectCalendar'],
        ['spoilerProtectRecentlyAdded', 'protectRecentlyAdded'],
        ['spoilerProtectEpisodeDetails', 'protectEpisodeDetails'],
    ];

    for (const [elementId, settingKey] of protectionToggles) {
        test(`${settingKey} toggle updates the setting`, async ({ page }) => {
            await openSettingsPanel(page);
            await openSpoilerSection(page);

            const toggle = page.locator(`#${elementId}`);
            const before = await toggle.isChecked();

            await toggle.click();
            await page.waitForTimeout(500);

            const setting = await getSpoilerSetting(page, settingKey);
            expect(setting).toBe(!before);

            // Restore
            await toggle.click();
            await page.waitForTimeout(500);
        });
    }
});

test.describe('Spoiler Mode — Hide/Show Toggles', () => {
    const hideToggles = [
        ['spoilerHideRuntime', 'hideRuntime'],
        ['spoilerHideAirDate', 'hideAirDate'],
        ['spoilerHideGuestStars', 'hideGuestStars'],
        ['spoilerShowOverview', 'showSeriesOverview'],
    ];

    for (const [elementId, settingKey] of hideToggles) {
        test(`${settingKey} toggle updates the setting`, async ({ page }) => {
            await openSettingsPanel(page);
            await openSpoilerSection(page);

            const toggle = page.locator(`#${elementId}`);
            const before = await toggle.isChecked();

            await toggle.click();
            await page.waitForTimeout(500);

            const setting = await getSpoilerSetting(page, settingKey);
            expect(setting).toBe(!before);

            // Restore
            await toggle.click();
            await page.waitForTimeout(500);
        });
    }
});

test.describe('Spoiler Mode — Select Controls', () => {
    test.beforeEach(async ({ page }) => {
        await openSettingsPanel(page);
        await openSpoilerSection(page);
    });

    test('artwork policy selector updates the setting', async ({ page }) => {
        const select = page.locator('#spoilerArtworkPolicy');
        const original = await select.inputValue();
        const options = await select.locator('option').evaluateAll(opts => opts.map(o => o.value));
        const other = options.find(v => v !== original) || options[0];

        await select.selectOption(other);
        await page.waitForTimeout(500);

        const setting = await getSpoilerSetting(page, 'artworkPolicy');
        expect(setting).toBe(other);

        // Restore
        await select.selectOption(original);
        await page.waitForTimeout(500);
    });

    test('reveal duration selector updates the setting', async ({ page }) => {
        const select = page.locator('#spoilerRevealDuration');
        const original = await select.inputValue();

        await select.selectOption('30000');
        await page.waitForTimeout(500);

        const setting = await getSpoilerSetting(page, 'revealDuration');
        expect(setting).toBe(30000);

        // Restore
        await select.selectOption(original);
        await page.waitForTimeout(500);
    });

    test('watched threshold selector updates the setting', async ({ page }) => {
        const select = page.locator('#spoilerWatchedThreshold');
        const original = await select.inputValue();
        const other = original === 'played' ? '90percent' : 'played';

        await select.selectOption(other);
        await page.waitForTimeout(500);

        const setting = await getSpoilerSetting(page, 'watchedThreshold');
        expect(setting).toBe(other);

        // Restore
        await select.selectOption(original);
        await page.waitForTimeout(500);
    });
});

test.describe('Spoiler Mode — Auto-Enable First Play', () => {
    test('auto-enable toggle updates the data', async ({ page }) => {
        await openSettingsPanel(page);
        await openSpoilerSection(page);

        const toggle = page.locator('#spoilerAutoEnableFirstPlay');
        const before = await toggle.isChecked();

        await toggle.click();
        await page.waitForTimeout(500);

        const data = await page.evaluate(
            () => window.JellyfinEnhanced?.spoilerMode?.getSpoilerData()?.autoEnableOnFirstPlay
        );
        expect(data).toBe(!before);

        // Restore
        await toggle.click();
        await page.waitForTimeout(500);
    });
});

test.describe('Spoiler Mode — Settings Persistence', () => {
    test('settings persist after closing and reopening panel', async ({ page }) => {
        await openSettingsPanel(page);
        await openSpoilerSection(page);

        // Change reveal duration to a known value
        const select = page.locator('#spoilerRevealDuration');
        const originalValue = await select.inputValue();
        await select.selectOption('15000');
        await page.waitForTimeout(500);

        // Close and reopen
        await closeSettingsPanel(page);
        await page.waitForTimeout(500);
        await openSettingsPanel(page);
        await openSpoilerSection(page);

        const newValue = await page.locator('#spoilerRevealDuration').inputValue();
        expect(newValue).toBe('15000');

        // Restore
        await page.locator('#spoilerRevealDuration').selectOption(originalValue);
        await page.waitForTimeout(500);
    });

    test('settings persist after page reload', async ({ page }) => {
        await openSettingsPanel(page);
        await openSpoilerSection(page);

        // Read current state
        const select = page.locator('#spoilerRevealDuration');
        const originalValue = await select.inputValue();

        // Change to a distinct value
        const targetValue = originalValue === '30000' ? '15000' : '30000';
        await select.selectOption(targetValue);
        await page.waitForTimeout(1000); // Wait for save

        // Reload the page
        await page.reload();
        await page.waitForFunction(
            () => window.JellyfinEnhanced?.spoilerMode != null,
            { timeout: 15_000 }
        );

        // Open the panel again and verify
        await openSettingsPanel(page);
        await openSpoilerSection(page);
        const afterReload = await page.locator('#spoilerRevealDuration').inputValue();
        expect(afterReload).toBe(targetValue);

        // Restore
        await page.locator('#spoilerRevealDuration').selectOption(originalValue);
        await page.waitForTimeout(500);
    });
});
