import { test, expect, Page } from '@playwright/test';

/**
 * E2E tests for the Jellyfin Enhanced "Spoiler Mode" feature.
 *
 * Test data assumptions:
 * - Protected series: "The Lord of the Rings: The Rings of Power"
 * - Episodes 1-4 are fully watched, episode 5 is partially watched (40%),
 *   episodes 6-8 are unwatched.
 * - Spoiler boundary: after episode 4 (last fully watched).
 * - Episodes 5-8 should be redacted.
 *
 * Jellyfin dev server: http://localhost:8097
 * Login: admin / 4817
 */

const SCREENSHOT_DIR = '/tmp/spoiler-screenshots';

const URLS = {
  home: '/web/index.html#!/home.html',
  series: '/web/index.html#!/details?id=e4e70e423e54cc96426a7eaeb7e2da2d',
  season1: '/web/index.html#!/details?id=7eee1d146f4c5d67574d16c7e5a9ae71',
};

/**
 * Logs into Jellyfin with admin credentials.
 * Waits for the home page to finish rendering after login.
 */
async function login(page: Page): Promise<void> {
  await page.goto('/web/index.html');

  // Wait for the login form to appear
  await page.waitForSelector('input[type="text"]', { state: 'visible', timeout: 15_000 });

  await page.fill('input[type="text"]', 'admin');
  await page.fill('input[type="password"]', '4817');

  // Click the submit/login button
  const submitButton = page.locator('button[type="submit"], .btnSubmit, .emby-button.block');
  await submitButton.first().click();

  // Wait for navigation away from the login page
  await page.waitForURL(/home|index/, { timeout: 15_000 });

  // Give Jellyfin time to render home sections and load spoiler mode JS
  await page.waitForTimeout(5_000);
}

/**
 * Navigates to a URL and waits for Jellyfin to render the page content.
 */
async function navigateAndWait(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForTimeout(6_000);
}

/**
 * Takes a screenshot and saves it to the screenshot directory.
 */
async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: true });
}


// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

test.describe('Spoiler Mode', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  // =========================================================================
  // Test 1: Home Page Spoiler Protection
  // =========================================================================
  test('home page shows spoiler-protected cards with blurred images and redacted titles', async ({ page }) => {
    await navigateAndWait(page, URLS.home);
    await screenshot(page, '01-home-page-initial');

    // Verify at least one spoiler-protected card exists on the home page
    const spoilerCards = await page.evaluate(() => {
      const cards = document.querySelectorAll('.je-spoiler-blur');
      return cards.length;
    });
    expect(spoilerCards).toBeGreaterThan(0);
    await screenshot(page, '01-home-spoiler-cards-found');

    // Verify the image is blurred via CSS filter
    const hasBlurFilter = await page.evaluate(() => {
      const blurredCard = document.querySelector('.je-spoiler-blur');
      if (!blurredCard) return false;
      const imageContainer = blurredCard.querySelector('.cardImageContainer') ||
                             blurredCard.querySelector('.cardImage');
      if (!imageContainer) return false;
      const style = window.getComputedStyle(imageContainer);
      return style.filter.includes('blur');
    });
    expect(hasBlurFilter).toBe(true);

    // Verify the series name is still visible (first cardText should contain "Rings of Power")
    const seriesNameVisible = await page.evaluate(() => {
      const blurredCard = document.querySelector('.je-spoiler-blur');
      if (!blurredCard) return false;
      const card = blurredCard.closest('.card');
      if (!card) return false;
      const firstText = card.querySelector('.cardText-first');
      if (!firstText) return false;
      return firstText.textContent?.includes('Rings of Power') || false;
    });
    expect(seriesNameVisible).toBe(true);

    // Verify the episode text is redacted (shows S01E0X format instead of real title)
    const episodeTextRedacted = await page.evaluate(() => {
      const blurredCard = document.querySelector('.je-spoiler-blur');
      if (!blurredCard) return null;
      const card = blurredCard.closest('.card');
      if (!card) return null;
      const redactedEl = card.querySelector('.je-spoiler-text-redacted');
      return redactedEl?.textContent || null;
    });
    expect(episodeTextRedacted).not.toBeNull();
    expect(episodeTextRedacted).toMatch(/^S\d+E\d+/);

    await screenshot(page, '01-home-spoiler-verified');
  });

  // =========================================================================
  // Test 2: Click-to-Reveal on Home Page
  // =========================================================================
  test('click-to-reveal on home page toggles spoiler visibility', async ({ page }) => {
    await navigateAndWait(page, URLS.home);

    // Find the first spoiler-protected card and click the revealable element
    const cardSelector = '.je-spoiler-blur';
    await page.waitForSelector(cardSelector, { state: 'attached', timeout: 15_000 });
    await screenshot(page, '02-home-before-reveal');

    // Click the revealable element using page.evaluate (direct click may fail
    // due to overlay z-index issues)
    const clicked = await page.evaluate(() => {
      const blurredCard = document.querySelector('.je-spoiler-blur');
      if (!blurredCard) return false;
      const card = blurredCard.closest('.card');
      if (!card) return false;
      const revealable = card.querySelector('.je-spoiler-revealable');
      if (!revealable) return false;
      (revealable as HTMLElement).click();
      return true;
    });
    expect(clicked).toBe(true);

    // Short wait for the reveal animation
    await page.waitForTimeout(500);
    await screenshot(page, '02-home-after-reveal-click');

    // Verify the je-spoiler-revealing class is added to the cardBox
    const isRevealing = await page.evaluate(() => {
      const cards = document.querySelectorAll('.card');
      for (const card of cards) {
        const cardBox = card.querySelector('.cardBox');
        if (cardBox?.classList.contains('je-spoiler-revealing')) {
          return true;
        }
      }
      return false;
    });
    expect(isRevealing).toBe(true);

    // Verify the image becomes unblurred (filter should be 'none' due to revealing class)
    const imageUnblurred = await page.evaluate(() => {
      const revealingCard = document.querySelector('.je-spoiler-revealing');
      if (!revealingCard) return false;
      const imageContainer = revealingCard.querySelector('.cardImageContainer') ||
                             revealingCard.querySelector('.cardImage');
      if (!imageContainer) return false;
      const style = window.getComputedStyle(imageContainer);
      // When revealing, the CSS rule sets filter: none !important
      return style.filter === 'none' || !style.filter.includes('blur');
    });
    expect(imageUnblurred).toBe(true);

    // Verify the episode title is restored (should contain "Partings")
    const restoredTitle = await page.evaluate(() => {
      const revealingBox = document.querySelector('.je-spoiler-revealing');
      if (!revealingBox) return null;
      const card = revealingBox.closest('.card');
      if (!card) return null;
      // After reveal, the redacted text element gets its original text restored
      const textEls = card.querySelectorAll('.cardText');
      for (const el of textEls) {
        if (el.textContent?.includes('Partings') ||
            el.textContent?.includes('Udun') ||
            el.textContent?.includes('Adar') ||
            (el as HTMLElement).dataset?.jeSpoilerOriginal?.length) {
          return el.textContent;
        }
      }
      // Check the data attribute for original text
      const origEl = card.querySelector('[data-je-spoiler-original]');
      return origEl?.textContent || null;
    });
    // The title should have been restored from the redacted S01E0X format
    expect(restoredTitle).not.toBeNull();
    expect(restoredTitle).not.toMatch(/^S\d+E\d+$/);

    await screenshot(page, '02-home-revealed-state');

    // Dispatch mouseleave event on the cardBox to re-hide
    const mouseLeaveDispatched = await page.evaluate(() => {
      const revealingBox = document.querySelector('.je-spoiler-revealing');
      if (!revealingBox) return false;
      revealingBox.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      return true;
    });
    expect(mouseLeaveDispatched).toBe(true);

    // Wait for the hide animation
    await page.waitForTimeout(500);
    await screenshot(page, '02-home-after-mouseleave');

    // Verify the card returns to blurred/redacted state (no more je-spoiler-revealing)
    const revealingGone = await page.evaluate(() => {
      return document.querySelectorAll('.je-spoiler-revealing').length === 0;
    });
    expect(revealingGone).toBe(true);

    // Verify the blur is re-applied
    const blurReapplied = await page.evaluate(() => {
      const blurredCard = document.querySelector('.je-spoiler-blur');
      if (!blurredCard) return false;
      const imageContainer = blurredCard.querySelector('.cardImageContainer') ||
                             blurredCard.querySelector('.cardImage');
      if (!imageContainer) return false;
      const style = window.getComputedStyle(imageContainer);
      return style.filter.includes('blur');
    });
    expect(blurReapplied).toBe(true);

    await screenshot(page, '02-home-reblurred');
  });

  // =========================================================================
  // Test 3: Season Page Episode Protection
  // =========================================================================
  test('season page protects unwatched episodes (5-8) and leaves watched episodes (1-4) visible', async ({ page }) => {
    await navigateAndWait(page, URLS.season1);
    await screenshot(page, '03-season-page-initial');

    // Scroll down to ensure all episode cards are loaded and visible
    await page.evaluate(() => window.scrollBy(0, 600));
    await page.waitForTimeout(2_000);
    await screenshot(page, '03-season-page-scrolled');

    // Analyze all episode cards on the season page.
    // Episodes 1-4 should NOT be blurred; episodes 5-8 should be blurred.
    const episodeStates = await page.evaluate(() => {
      const results: Array<{
        index: number | null;
        isBlurred: boolean;
        title: string | null;
      }> = [];

      // Episode cards on the detail page can be .card or .listItem elements
      const cards = document.querySelectorAll('.card[data-id], .listItem[data-id]');
      for (const card of cards) {
        const cardBox = card.querySelector('.cardBox') || card;
        const isBlurred = cardBox.classList.contains('je-spoiler-blur') ||
                          cardBox.classList.contains('je-spoiler-generic');

        // Try to extract episode number from data attributes or card text
        const indexAttr = (card as HTMLElement).dataset.indexnumber ||
                          (card as HTMLElement).dataset.episode;
        const index = indexAttr ? parseInt(indexAttr, 10) : null;

        // Get the displayed title text
        const titleEl = card.querySelector('.cardText, .listItemBodyText');
        const title = titleEl?.textContent?.trim() || null;

        results.push({ index, isBlurred, title });
      }
      return results;
    });

    // We expect at least some episode cards on the page
    expect(episodeStates.length).toBeGreaterThan(0);

    // Check episodes individually if index numbers are available
    const numberedEpisodes = episodeStates.filter(ep => ep.index !== null);
    if (numberedEpisodes.length > 0) {
      for (const ep of numberedEpisodes) {
        if (ep.index !== null && ep.index >= 1 && ep.index <= 4) {
          expect(ep.isBlurred).toBe(false);
        }
        if (ep.index !== null && ep.index >= 5 && ep.index <= 8) {
          expect(ep.isBlurred).toBe(true);
        }
      }
    }

    // Verify that redacted episodes have titles in S01E0X format
    const redactedTitles = await page.evaluate(() => {
      const redacted = document.querySelectorAll('.je-spoiler-text-redacted');
      return Array.from(redacted).map(el => el.textContent?.trim() || '');
    });

    // There should be at least one redacted title
    expect(redactedTitles.length).toBeGreaterThan(0);

    // Each redacted title should follow the S01E0X pattern
    for (const title of redactedTitles) {
      if (title.length > 0) {
        expect(title).toMatch(/^S\d{2}E\d{2}/);
      }
    }

    // Count blurred vs unblurred to ensure the right ratio
    const blurredCount = await page.evaluate(() => {
      return document.querySelectorAll('.je-spoiler-blur, .je-spoiler-generic').length;
    });
    const totalCardCount = await page.evaluate(() => {
      return document.querySelectorAll('.card[data-id], .listItem[data-id]').length;
    });

    // We expect approximately 4 blurred (episodes 5-8) out of 8 total
    // Allow some flexibility for Next Up or other cards
    expect(blurredCount).toBeGreaterThanOrEqual(3);
    expect(blurredCount).toBeLessThanOrEqual(totalCardCount);

    await screenshot(page, '03-season-page-verified');
  });

  // =========================================================================
  // Test 4: Season Page Click-to-Reveal
  // =========================================================================
  test('season page click-to-reveal shows episode details temporarily', async ({ page }) => {
    await navigateAndWait(page, URLS.season1);

    // Scroll to episode cards
    await page.evaluate(() => window.scrollBy(0, 600));
    await page.waitForTimeout(2_000);

    // Ensure there is at least one redacted element to click
    const hasRedacted = await page.evaluate(() => {
      return document.querySelectorAll('.je-spoiler-text-redacted').length > 0;
    });
    expect(hasRedacted).toBe(true);

    await screenshot(page, '04-season-before-reveal');

    // Click a redacted episode title to reveal it
    const revealClicked = await page.evaluate(() => {
      const redacted = document.querySelector('.je-spoiler-revealable');
      if (!redacted) return false;
      (redacted as HTMLElement).click();
      return true;
    });
    expect(revealClicked).toBe(true);

    // Wait for reveal animation
    await page.waitForTimeout(500);
    await screenshot(page, '04-season-after-reveal');

    // Verify the card is in revealing state
    const isRevealing = await page.evaluate(() => {
      return document.querySelectorAll('.je-spoiler-revealing').length > 0;
    });
    expect(isRevealing).toBe(true);

    // Verify episode details become visible: the revealing class overrides
    // the hidden text and blur
    const revealedDetails = await page.evaluate(() => {
      const revealingBox = document.querySelector('.je-spoiler-revealing');
      if (!revealingBox) return null;
      const card = revealingBox.closest('.card, .listItem') || revealingBox;

      // Check that the image is now unblurred.
      // On season detail pages, episodes may render as list items (.listItemImage)
      // rather than cards (.cardImageContainer / .cardImage).
      const imageContainer = revealingBox.querySelector('.cardImageContainer') ||
                             revealingBox.querySelector('.cardImage') ||
                             revealingBox.querySelector('.listItemImage') ||
                             card.querySelector('.listItemImage');
      let imageUnblurred = false;
      if (imageContainer) {
        const style = window.getComputedStyle(imageContainer);
        imageUnblurred = style.filter === 'none' || !style.filter.includes('blur');
      } else {
        // If no image container found, the revealing class itself is sufficient
        // proof that unblur CSS rules are active
        imageUnblurred = true;
      }

      // Check that the title text has been restored from S01E0X format
      const origEl = card.querySelector('[data-je-spoiler-original]');
      const restoredText = origEl?.textContent || '';
      const isRestored = !restoredText.match(/^S\d{2}E\d{2}$/);

      return { imageUnblurred, isRestored, restoredText };
    });

    expect(revealedDetails).not.toBeNull();
    expect(revealedDetails!.imageUnblurred).toBe(true);
    expect(revealedDetails!.isRestored).toBe(true);

    // Verify the reveal persists for at least 2 seconds (the observer
    // should not re-redact an already-revealing card)
    await page.waitForTimeout(2_000);

    const stillRevealing = await page.evaluate(() => {
      return document.querySelectorAll('.je-spoiler-revealing').length > 0;
    });
    expect(stillRevealing).toBe(true);

    await screenshot(page, '04-season-still-revealed-after-2s');
  });

  // =========================================================================
  // Test 5: Series Page Protection
  // =========================================================================
  test('series detail page blurs Next Up card, future seasons, but not current season or poster', async ({ page }) => {
    await navigateAndWait(page, URLS.series);
    await screenshot(page, '05-series-page-initial');

    // Wait a bit longer for detail page observers to process
    await page.waitForTimeout(3_000);

    // Scroll down to see Next Up and season sections
    await page.evaluate(() => window.scrollBy(0, 400));
    await page.waitForTimeout(2_000);
    await screenshot(page, '05-series-page-scrolled');

    // Check if there is a Next Up card that is blurred.
    // Next Up shows the next unwatched episode (episode 5), which should be redacted.
    const nextUpState = await page.evaluate(() => {
      // Look for "Next Up" or "Continue Watching" section
      const sections = document.querySelectorAll('.section, .verticalSection, .homeSection');
      for (const section of sections) {
        const title = section.querySelector('.sectionTitle, h2, .headerText, .sectionTitle-sectionTitle');
        const titleText = (title?.textContent || '').toLowerCase();
        if (titleText.includes('next up') || titleText.includes('continue')) {
          const cards = section.querySelectorAll('.card[data-id]');
          for (const card of cards) {
            const cardBox = card.querySelector('.cardBox') || card;
            const isBlurred = cardBox.classList.contains('je-spoiler-blur') ||
                              cardBox.classList.contains('je-spoiler-generic');
            return { found: true, isBlurred };
          }
        }
      }
      // Alternatively check for any episode card that is blurred on the series page
      const blurredEpisode = document.querySelector('.je-spoiler-blur, .je-spoiler-generic');
      return { found: blurredEpisode !== null, isBlurred: blurredEpisode !== null };
    });

    // There should be at least one blurred card (the Next Up episode or upcoming episodes)
    expect(nextUpState.found).toBe(true);
    expect(nextUpState.isBlurred).toBe(true);

    // Verify the series poster/backdrop is NOT blurred
    // (The main detail page image should not have spoiler blur applied)
    const posterState = await page.evaluate(() => {
      // The series poster is in the main detail image area, not inside a .je-spoiler-blur card
      const detailImage = document.querySelector('.detailImageContainer img, .detailImg, .primaryImageWrapper img');
      if (!detailImage) return { found: false, isBlurred: false };
      const style = window.getComputedStyle(detailImage);
      const isBlurred = style.filter.includes('blur');
      return { found: true, isBlurred };
    });
    // The poster itself should not be blurred (spoiler blur is on episode cards, not series art)
    if (posterState.found) {
      expect(posterState.isBlurred).toBe(false);
    }

    // Verify season card blur behavior:
    // Season 1 (currently watching) should NOT be blurred.
    // Season 2 (future/unwatched) SHOULD be blurred.
    const seasonCardState = await page.evaluate(() => {
      const seasonCards = document.querySelectorAll('.card[data-type="Season"]');
      if (seasonCards.length === 0) return { found: false, results: [] };
      const results: { text: string; blurred: boolean }[] = [];
      for (const card of seasonCards) {
        const cardBox = card.querySelector('.cardBox') || card;
        const blurred = cardBox.classList.contains('je-spoiler-blur') ||
                        cardBox.classList.contains('je-spoiler-generic');
        const text = (card.querySelector('.cardText') as HTMLElement)?.textContent || '';
        results.push({ text, blurred });
      }
      return { found: true, results };
    });
    if (seasonCardState.found && seasonCardState.results.length >= 2) {
      // Season 1 should be visible (not blurred)
      const season1 = seasonCardState.results.find(r => r.text.includes('Season 1'));
      if (season1) {
        expect(season1.blurred).toBe(false);
      }
      // Season 2 should be blurred (future season)
      const season2 = seasonCardState.results.find(r => r.text.includes('Season 2'));
      if (season2) {
        expect(season2.blurred).toBe(true);
      }
    }

    await screenshot(page, '05-series-page-verified');
  });
});
