// Keyboard-only and D-pad checks of the Enhanced panel on real jellyfin-web (design item A10):
// a 375 px phone viewport driven by the keyboard alone, and layout=tv driven by the arrow keys,
// where jellyfin-web's own focusManager moves focus. Run by browser.mjs after the login journey;
// exported so a lab server can be checked the same way.
import { expect } from '@playwright/test';

const PANEL = '#jellyfin-enhanced-panel';
const JE_READY = () => window.JellyfinEnhanced?.currentSettings && typeof window.JellyfinEnhanced?.showEnhancedPanel === 'function';

/**
 * Signs in through the real login form and waits for JE to finish booting.
 * @param {import('@playwright/test').Page} page
 * @param {{url: string, username: string, password: string}} options
 */
async function signIn(page, { url, username, password }) {
  await page.goto(`${url}/web/index.html#!/login.html`, { waitUntil: 'domcontentloaded' });
  // The login page shows either the form or (with visible users) user cards and a manual button.
  const manual = page.getByRole('button', { name: /manual login|sign in manually/i });
  const name = page.getByLabel(/^User(name)?$/i);
  await expect(manual.or(name).filter({ visible: true }).first()).toBeVisible({ timeout: 45000 });
  if (await manual.isVisible()) await manual.click();
  await name.fill(username, { timeout: 45000 });
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.waitForFunction(JE_READY, null, { timeout: 60000 });
}

/**
 * Where focus is now, relative to the panel.
 * @param {import('@playwright/test').Page} page
 */
function focusState(page) {
  return page.evaluate((selector) => {
    const panel = document.querySelector(selector);
    const active = document.activeElement;
    return {
      open: !!panel,
      inside: !!(panel && active && panel.contains(active)),
      tab: active?.dataset?.tab || null,
      id: active?.id || null,
      shortcutKey: !!active?.classList?.contains('shortcut-key'),
      listening: !!active?.hasAttribute?.('data-listening'),
      text: active?.textContent?.trim() || '',
      describe: active ? `${active.tagName}#${active.id}.${active.className}`.slice(0, 80) : 'none'
    };
  }, PANEL);
}

/**
 * Presses a key `times` times and asserts that focus is inside the open panel after every press.
 * @param {import('@playwright/test').Page} page
 * @param {string} key
 * @param {number} times
 */
async function pressStayingInside(page, key, times) {
  for (let i = 1; i <= times; i++) {
    await page.keyboard.press(key);
    const state = await focusState(page);
    expect(state.open, `${key} #${i} closed the panel`).toBe(true);
    expect(state.inside, `${key} #${i} moved focus out of the panel to ${state.describe}`).toBe(true);
  }
}

/**
 * Focuses a visible header control (the element focus returns to) and opens the panel with `?`.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>} The opener's selector.
 */
async function openWithKeyboard(page) {
  // The page header (MUI AppBar on Jellyfin 12, .skinHeader on the legacy layout).
  const opener = await page.waitForFunction(() => [...document.querySelectorAll('header button, .skinHeader button')]
    .find(element => element.getClientRects().length && !element.disabled));
  await opener.evaluate(element => {
    element.setAttribute('data-je-test-opener', '');
    element.focus();
  });
  await page.keyboard.press('?');
  await expect(page.locator(PANEL)).toBeVisible({ timeout: 30000 });
  return '[data-je-test-opener]';
}

/**
 * 375 px, keyboard only: the Tab trap, Enter into a section and Back out of it, shortcut capture
 * only after Enter (Escape cancels it without closing the panel), focus back on the opener, and a
 * failed save shown where the full-screen sheet cannot cover it.
 * @param {import('@playwright/test').Browser} browser
 * @param {{url: string, username: string, password: string}} options
 */
async function phoneKeyboardOnly(browser, options) {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 375, height: 812 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(options.url).origin ? route.continue() : route.abort('blockedbyclient'));
  context.setDefaultTimeout(30000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await signIn(page, options);
    const opener = await openWithKeyboard(page);
    let state = await focusState(page);
    expect(state.inside, 'initial focus is inside the panel').toBe(true);
    const start = state;

    // Tab and Shift+Tab wrap inside the panel; as many steps back return to the start.
    await pressStayingInside(page, 'Tab', 40);
    await pressStayingInside(page, 'Shift+Tab', 40);
    state = await focusState(page);
    expect([state.tab, state.id], 'Tab order wraps symmetrically').toEqual([start.tab, start.id]);

    // Enter on the Shortcuts section opens it and moves focus to Back.
    await page.locator(`${PANEL} .tab-button[data-tab="shortcuts"]`).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator(`${PANEL} .je-panel-body`)).toHaveClass(/je-pane-open/);
    state = await focusState(page);
    expect(state.id).toBe('jePanelBack');

    // The first key: focus alone does not capture, a typed key is not bound.
    await page.keyboard.press('Tab');
    state = await focusState(page);
    expect(state.shortcutKey, `Tab after Back reaches a shortcut key, not ${state.describe}`).toBe(true);
    const bound = state.text;
    await page.keyboard.press('q');
    state = await focusState(page);
    expect([state.shortcutKey, state.listening, state.text]).toEqual([true, false, bound]);

    // Enter starts the capture, Escape cancels it and leaves the panel open.
    await page.keyboard.press('Enter');
    expect((await focusState(page)).listening, 'Enter starts listening').toBe(true);
    await page.keyboard.press('Escape');
    state = await focusState(page);
    expect([state.open, state.shortcutKey, state.listening, state.text]).toEqual([true, true, false, bound]);

    // Back returns to the section list.
    await page.keyboard.press('Shift+Tab');
    expect((await focusState(page)).id).toBe('jePanelBack');
    await page.keyboard.press('Enter');
    await expect(page.locator(`${PANEL} .je-panel-body`)).not.toHaveClass(/je-pane-open/);
    state = await focusState(page);
    expect([state.inside, !!state.tab], 'focus is back on a section in the list').toEqual([true, true]);

    // Escape closes the panel and focus returns to the opener.
    await page.keyboard.press('Escape');
    await expect(page.locator(PANEL)).toHaveCount(0);
    expect(await page.evaluate(selector => document.activeElement === document.querySelector(selector), opener), 'focus returns to the opener').toBe(true);

    // A failed save is visible over the full-screen sheet (nothing is stored: the POST is aborted).
    await page.route('**/JellyfinEnhanced/user-settings/**', route => route.request().method() === 'POST' ? route.abort() : route.continue());
    await openWithKeyboard(page);
    await page.locator(`${PANEL} .tab-button[data-tab="playback"]`).click();
    const toggle = page.locator('#autoPauseToggle');
    await toggle.setChecked(!(await toggle.isChecked()));
    const strip = page.locator(`${PANEL} .je-save-error[role="alert"]`);
    await expect(strip).toBeVisible();
    await expect(strip).toHaveText(/save/i);
    const onTop = await strip.evaluate(element => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return box.top >= 0 && box.bottom <= innerHeight && !!hit && element.contains(hit);
    });
    expect(onTop, 'the failure message is on screen and not covered').toBe(true);
    expect(errors, 'Uncaught browser errors').toEqual([]);
  } finally {
    await context.close();
  }
}

/**
 * layout=tv, with the panel open: Enter on Release notes moves focus into the notification, the
 * arrow keys keep it there (not on the page behind), Escape closes only the notification and
 * focus is back on the button.
 * @param {import('@playwright/test').Page} page
 */
async function tvReleaseNotes(page) {
  // The browser context blocks other origins; answer the GitHub release lookup locally.
  await page.route('https://api.github.com/**', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ tag_name: 'v99.0.0', published_at: '2026-10-01T00:00:00Z', html_url: 'https://github.com/n00bcodr/Jellyfin-Enhanced/releases',
      body: '## Notes\n- [a link](https://example.com/one)\n- item\n- [another link](https://example.com/two)' }) }));
  const NOTES = '#jellyfin-release-notes-notification';
  await page.locator(`${PANEL} .tab-button[data-tab="about"]`).focus();
  await page.keyboard.press('Enter');
  await page.locator('#releaseNotesBtn').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(NOTES)).toBeVisible();
  const inNotes = () => page.evaluate(selector => {
    const active = document.activeElement;
    const notes = document.querySelector(selector);
    return { inside: !!notes?.contains(active), control: !!active && active !== notes && !!notes?.contains(active),
      describe: active ? `${active.tagName}.${active.className} ${active.textContent.trim().slice(0, 20)}`.slice(0, 80) : 'none' };
  }, NOTES);
  expect((await inNotes()).inside, 'Enter on Release notes moves focus into them').toBe(true);
  const visited = new Set();
  for (const key of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowUp']) {
    for (let i = 1; i <= 6; i++) {
      await page.keyboard.press(key);
      const state = await inNotes();
      expect(state.inside, `${key} #${i} in the release notes moved focus to ${state.describe}`).toBe(true);
      expect(state.control, `${key} #${i} left focus on the notification itself, not on a control`).toBe(true);
      visited.add(state.describe);
    }
  }
  expect(visited.size, `the D-pad reaches more than one control in the notes: ${[...visited].join(' | ')}`).toBeGreaterThan(1);
  await page.keyboard.press('Escape');
  await expect(page.locator(NOTES)).toHaveCount(0);
  await expect(page.locator(PANEL)).toBeVisible();
  expect(await page.evaluate(() => document.activeElement?.id), 'focus is back on Release notes').toBe('releaseNotesBtn');
}

/**
 * layout=tv: jellyfin-web moves focus on the arrow keys; it must stay inside the panel, and inside
 * the release notes once they are open.
 * @param {import('@playwright/test').Browser} browser
 * @param {{url: string, username: string, password: string}} options
 */
async function tvArrowKeys(browser, options) {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 720 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(options.url).origin ? route.continue() : route.abort('blockedbyclient'));
  context.setDefaultTimeout(30000);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await signIn(page, options);
    await page.evaluate(() => localStorage.setItem('layout', 'tv'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(JE_READY, null, { timeout: 60000 });
    await expect(page.locator('html')).toHaveClass(/layout-tv/);
    await page.evaluate(() => window.JellyfinEnhanced.showEnhancedPanel());
    await expect(page.locator(PANEL)).toBeVisible();
    expect((await focusState(page)).inside, 'initial focus is inside the panel').toBe(true);
    for (const key of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft']) await pressStayingInside(page, key, 12);
    await pressStayingInside(page, 'ArrowDown', 20);
    await pressStayingInside(page, 'ArrowUp', 30);
    await tvReleaseNotes(page);
    expect(errors, 'Uncaught browser errors').toEqual([]);
  } finally {
    await page.evaluate(() => localStorage.removeItem('layout')).catch(() => {});
    await context.close();
  }
}

/**
 * Runs both checks for one user.
 * @param {import('@playwright/test').Browser} browser
 * @param {{url: string, username: string, password: string}} options
 * @returns {Promise<string[]>} Names of the checks that passed.
 */
export async function checkPanelKeyboard(browser, options) {
  await phoneKeyboardOnly(browser, options);
  await tvArrowKeys(browser, options);
  return ['375 px keyboard-only panel', 'save failure visible on the phone sheet', 'layout=tv arrow keys stay in the panel and in its release notes'];
}
