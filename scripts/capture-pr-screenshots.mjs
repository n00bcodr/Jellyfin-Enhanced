#!/usr/bin/env node
/**
 * Capture PR screenshots for Spoiler Mode feature.
 * Uses Playwright to navigate a live Jellyfin instance and screenshot every visual surface.
 *
 * Usage:  node scripts/capture-pr-screenshots.mjs
 * Requires: Jellyfin running at localhost:8097 with admin/4817 credentials
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = resolve(__dirname, '..', 'docs', 'screenshots');
const BASE = 'http://localhost:8097';

// Protected item IDs (from live instance)
const IDS = {
    alteredCarbon:      'e2855c74234c19a4db0e1411bd4d4ff5',
    alteredS1:          '2a8021665bda0080a12bc89d09659bd9',
    thePitt:            '2f1edaed183097248476c81c8910b0f6',
    arcane:             '152c8771d7097253f178ad944e9d9989',
    futuramaCollection: '3f9c71224a92f9a27045b0929821f6ad',
    bodyDouble:         '2ca257811764564aac2172bda4fb0a07',
};

mkdirSync(SCREENSHOT_DIR, { recursive: true });

function shot(name) { return resolve(SCREENSHOT_DIR, name); }

async function login(page) {
    await page.goto(`${BASE}/web/#/login.html`);
    await page.waitForLoadState('networkidle');

    await page.evaluate(() => {
        Array.from(document.querySelectorAll('button'))
            .find(b => b.textContent.trim() === 'Manual Login')?.click();
    });
    await page.waitForTimeout(1000);

    await page.fill('#txtManualName', 'admin');
    await page.evaluate(() =>
        document.querySelector('.manualLoginForm .button-submit')?.click()
    );
    await page.waitForTimeout(1000);

    await page.fill('#txtManualPassword', '4817');
    await page.evaluate(() =>
        document.querySelector('.manualLoginForm .button-submit')?.click()
    );

    await page.waitForFunction(
        () => window.JellyfinEnhanced?.spoilerMode != null,
        { timeout: 25_000 }
    );
    await page.waitForTimeout(2000);
    console.log('  Logged in, plugin ready');
}

/** Mark first N episodes of a series as played to create a visible boundary. */
async function markEpisodesPlayed(page, seriesId, count) {
    await page.evaluate(async ({ seriesId, count }) => {
        const userId = ApiClient.getCurrentUserId();
        const resp = await ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl(`/Shows/${seriesId}/Episodes`, {
                UserId: userId, Fields: 'UserData', Limit: 100,
            }),
            dataType: 'json',
        });
        for (const ep of resp.Items.slice(0, count)) {
            if (!ep.UserData?.Played) {
                await ApiClient.ajax({
                    type: 'POST',
                    url: ApiClient.getUrl(`/Users/${userId}/PlayedItems/${ep.Id}`),
                });
            }
        }
    }, { seriesId, count });
}

async function wait(page, ms = 3000) {
    await page.waitForTimeout(ms);
    await page.evaluate(() => new Promise(r => setTimeout(r, 500)));
}

// ─── Screenshot Functions ───────────────────────────────────────────────────

async function captureHome(page) {
    console.log('\n[01] Home page — blurred spoiler cards');
    await page.goto(`${BASE}/web/#/home.html`);
    await page.waitForLoadState('networkidle');
    await wait(page, 5000);

    // Scroll down to show Continue Watching section
    await page.evaluate(() => {
        const section = document.querySelector('.section1, .homeSectionsContainer > div:nth-child(2)');
        if (section) section.scrollIntoView({ block: 'start' });
    });
    await page.waitForTimeout(500);

    await page.screenshot({ path: shot('01-home-blurred.png') });
    console.log('  saved');
}

async function captureSettings(page) {
    console.log('\n[02] Settings panel — Spoiler Mode controls');
    await page.evaluate(() => window.JellyfinEnhanced?.showEnhancedPanel?.());
    await page.waitForTimeout(1000);

    await page.evaluate(() =>
        document.querySelector('.tab-button[data-tab="settings"]')?.click()
    );
    await page.waitForTimeout(500);

    // Open spoiler details section
    await page.evaluate(() => {
        const det = document.querySelector('#settings-content details:has(#spoilerEnabledToggle)');
        if (det && !det.hasAttribute('open')) det.querySelector('summary')?.click();
    });
    await page.waitForTimeout(400);

    await page.evaluate(() => {
        const sc = document.querySelector('#settings-content');
        if (sc) sc.scrollTop = 0;
    });
    await page.waitForTimeout(300);

    const panel = page.locator('#jellyfin-enhanced-panel');
    await panel.screenshot({ path: shot('02-settings-top.png') });
    console.log('  saved');

    // Close panel
    await page.evaluate(() => document.getElementById('jellyfin-enhanced-panel')?.remove());
    await page.waitForTimeout(300);
}

async function captureAdminToggle(page) {
    console.log('\n[04] Admin config page — Spoiler Mode server toggle');
    // Must navigate to dashboard first, then click the plugin link
    await page.goto(`${BASE}/web/#/dashboard`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3000);

    await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        links.find(l => l.textContent.trim() === 'Jellyfin Enhanced')?.click();
    });

    try {
        await page.waitForSelector('#spoilerModeEnabled', { timeout: 15000 });
        await page.evaluate(() => {
            document.querySelector('#spoilerModeEnabled')?.scrollIntoView({ block: 'center' });
        });
        await page.waitForTimeout(500);
        await page.screenshot({ path: shot('04-admin-toggle.png') });
        console.log('  saved');
    } catch {
        console.log('  SKIP — config page did not load');
    }
}

async function captureDetailToggleOn(page) {
    console.log('\n[05] Series detail — toggle ON (orange shield)');
    await page.goto(`${BASE}/web/#/details?id=${IDS.alteredCarbon}`);
    await page.waitForLoadState('networkidle');
    await wait(page, 4000);
    await page.screenshot({ path: shot('05-detail-toggle-on.png') });
    console.log('  saved');
}

async function captureDetailToggleOff(page) {
    console.log('\n[06] Series detail — toggle OFF');
    // Disable confirmation for clean toggle
    await page.evaluate(() => {
        window.JellyfinEnhanced?.spoilerMode?.updateSettings({ showDisableConfirmation: false });
    });
    await page.waitForTimeout(300);

    // Click toggle via evaluate (emby-button requires it)
    await page.evaluate(() => document.querySelector('.je-spoiler-toggle-btn')?.click());
    await page.waitForTimeout(3000);

    await page.screenshot({ path: shot('06-detail-toggle-off.png') });
    console.log('  saved');

    // Re-enable
    await page.evaluate(() => document.querySelector('.je-spoiler-toggle-btn')?.click());
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
        window.JellyfinEnhanced?.spoilerMode?.updateSettings({ showDisableConfirmation: true });
    });
    await page.waitForTimeout(500);
}

async function captureConfirmDialog(page) {
    console.log('\n[07] Confirmation dialog (Reveal / Disable / Cancel)');
    await page.goto(`${BASE}/web/#/details?id=${IDS.alteredCarbon}`);
    await page.waitForLoadState('networkidle');
    await wait(page, 4000);

    // Click toggle (ON → triggers dialog)
    await page.evaluate(() => document.querySelector('.je-spoiler-toggle-btn')?.click());
    await page.waitForTimeout(1000);

    const hasDialog = await page.evaluate(() =>
        document.querySelector('.je-spoiler-confirm-overlay') !== null
    );

    if (hasDialog) {
        await page.screenshot({ path: shot('07-confirm-dialog.png') });
        console.log('  saved');
        await page.evaluate(() => document.querySelector('.je-spoiler-confirm-cancel')?.click());
        await page.waitForTimeout(500);
    } else {
        console.log('  SKIP — dialog not found');
    }
}

async function captureEpisodesBlurred(page) {
    console.log('\n[08] Season page — watched vs unwatched episode boundary');
    await page.goto(`${BASE}/web/#/details?id=${IDS.alteredS1}`);
    await page.waitForLoadState('networkidle');
    await wait(page, 4000);

    // Scroll to show the boundary area (episodes 4-6)
    await page.evaluate(() => {
        const episodes = document.querySelectorAll('.listItem, .episodeCard, .card[data-id]');
        if (episodes.length > 3) episodes[3].scrollIntoView({ block: 'start' });
    });
    await page.waitForTimeout(500);

    await page.screenshot({ path: shot('08-episodes-blurred.png') });
    console.log('  saved');
}

async function captureSeasonBoundary(page) {
    console.log('\n[09] Series page — future season cards blurred');
    await page.goto(`${BASE}/web/#/details?id=${IDS.alteredCarbon}`);
    await page.waitForLoadState('networkidle');
    await wait(page, 4000);

    // Scroll to season section
    await page.evaluate(() => {
        const sections = document.querySelectorAll('.verticalSection, .detailSection');
        for (const s of sections) {
            const title = s.querySelector('.sectionTitle, h2, h3');
            if (title && /season|next up|series/i.test(title.textContent)) {
                s.scrollIntoView({ block: 'start' });
                break;
            }
        }
    });
    await page.waitForTimeout(500);

    await page.screenshot({ path: shot('09-season-boundary.png') });
    console.log('  saved');
}

async function captureRevealBanner(page) {
    console.log('\n[10] Reveal All countdown banner');
    await page.goto(`${BASE}/web/#/details?id=${IDS.alteredCarbon}`);
    await page.waitForLoadState('networkidle');
    await wait(page, 4000);

    // Trigger reveal via the exposed API
    await page.evaluate(() => {
        window.JellyfinEnhanced?.spoilerMode?.activateRevealAll?.();
    });
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    await page.screenshot({ path: shot('10-reveal-banner.png') });
    console.log('  saved');

    // Deactivate
    await page.evaluate(() => {
        window.JellyfinEnhanced?.spoilerMode?.deactivateRevealAll?.();
    });
    await page.waitForTimeout(500);
}

async function captureMovieDetail(page) {
    console.log('\n[11] Movie detail — spoiler-protected movie');
    await page.goto(`${BASE}/web/#/details?id=${IDS.bodyDouble}`);
    await page.waitForLoadState('networkidle');
    await wait(page, 4000);
    await page.screenshot({ path: shot('11-movie-detail.png') });
    console.log('  saved');
}

async function captureCollectionPage(page) {
    console.log('\n[12] Collection page — watched/unwatched movies');
    await page.goto(`${BASE}/web/#/details?id=${IDS.futuramaCollection}`);
    await page.waitForLoadState('networkidle');
    await wait(page, 4000);

    await page.evaluate(() => {
        const cards = document.querySelectorAll('.card[data-id]');
        if (cards.length > 0) cards[0].scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(500);

    await page.screenshot({ path: shot('12-collection-page.png') });
    console.log('  saved');
}

async function captureSearchResults(page) {
    console.log('\n[13] Search results');
    await page.goto(`${BASE}/web/#/search.html`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    await page.evaluate(() => {
        const input = document.querySelector('input[type="text"], input[type="search"]');
        if (input) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(input, 'Altered Carbon');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
    await page.waitForTimeout(3000);
    await wait(page, 2000);

    await page.screenshot({ path: shot('13-search-results.png') });
    console.log('  saved');
}

// ─── Main ───────────────────────────────────────────────────────────────────

(async () => {
    console.log('Capturing PR screenshots for Spoiler Mode...');
    console.log(`Output: ${SCREENSHOT_DIR}\n`);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    try {
        await login(page);

        // Set up watch boundaries
        console.log('\nSetting up watch boundaries...');
        await markEpisodesPlayed(page, IDS.alteredCarbon, 5);

        // Ensure good settings
        await page.evaluate(() => {
            window.JellyfinEnhanced?.spoilerMode?.updateSettings({
                enabled: true,
                preset: 'balanced',
                protectHome: true,
                protectSearch: true,
                protectCalendar: true,
                showButtons: true,
                showDisableConfirmation: true,
                artworkPolicy: 'blur',
            });
        });
        await page.waitForTimeout(500);

        await captureHome(page);
        await captureSettings(page);
        await captureAdminToggle(page);
        await captureDetailToggleOn(page);
        await captureDetailToggleOff(page);
        await captureConfirmDialog(page);
        await captureEpisodesBlurred(page);
        await captureSeasonBoundary(page);
        await captureRevealBanner(page);
        await captureMovieDetail(page);
        await captureCollectionPage(page);
        await captureSearchResults(page);

        console.log('\nDone — captured all screenshots');
    } catch (err) {
        console.error('\nError:', err.message);
        await page.screenshot({ path: shot('error-diagnostic.png') }).catch(() => {});
        process.exitCode = 1;
    } finally {
        await browser.close();
    }
})();
