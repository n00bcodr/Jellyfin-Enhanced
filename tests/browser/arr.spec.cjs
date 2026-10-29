const { test: base, expect } = require('@playwright/test');
const { installArrRoutes, en, ITEM } = require('./arr-fixtures.cjs');

const test = base.extend({
  arr: async ({ page, baseURL }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // A failed load names its resource (Chromium's message text alone does not).
    page.on('console', message => { if (message.type() === 'error') errors.push([message.text(), message.location()?.url].filter(Boolean).join(' ')); });
    const arr = await installArrRoutes(page, { origin: baseURL });
    await use(arr);
    arr.check();
    expect(errors, 'unexpected browser errors').toEqual([]);
  }
});
const roots = '.je-arr-status, .je-manage, .je-hub, .je-notify-panel, .je-notify-bell, .je-manage-open, .je-notify-follow, .je-notify-remind';
const interactive = 'button, a[href], [role="button"], [role="tab"], input, select, summary, [tabindex]';

/** Opens the mock host with an explicit viewport and waits for production bootstrap. */
async function visit(page, width = 390, member = false) {
  await page.setViewportSize({ width, height: 844 });
  await page.goto(`/arr${member ? '?user=member' : ''}#/details?id=${ITEM}`);
  await expect(page.locator('body')).toHaveAttribute('data-arr-ready', 'true');
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('#itemDetailPage .je-arr-status')).toBeVisible();
}
/** Opens the production hub via its public navigation surface. */
async function hub(page) {
  await page.evaluate(() => JellyfinEnhanced.arrHub.show());
  await expect(page.locator('.je-hub-row')).toHaveCount(3);
}
/** Activates a production tab (native buttons support Tab + Enter/Space, not arrow roving). */
async function selectTab(page, tab, keyboard = false) {
  const button = page.locator(`.je-hub-tab[data-tab="${tab}"]`);
  if (keyboard) { await button.focus(); await page.keyboard.press('Enter'); }
  else await button.click();
  await expect(button).toHaveAttribute('aria-selected', 'true');
  const selected = await page.locator('.je-hub-tab').evaluateAll(nodes => nodes.map(n => [n.dataset.tab, n.getAttribute('aria-selected')]));
  expect(selected.every(([id, value]) => value === String(id === tab))).toBe(true);
}
// Product bugs this suite found and does not fix (it tests the product as it is): listed in the test-infra report and
// .notes/phase-end-followups.md. Each one is matched exactly and must still occur where it is listed, so a fix makes
// this test fail until its entry is removed; any other small control still fails.
const KNOWN_SMALL_CONTROLS = [
  // P1: at ≤600 px the Activity tab's "Technical details" disclosure (admin-styles.js .je-ops-diag summary) is about
  // 35 px tall, under the 44×44 phone target.
  { surface: 'hub activity', tag: 'SUMMARY', text: en.arr_ops_diag_title },
  { surface: 'hub audit', tag: 'SUMMARY', text: en.arr_ops_diag_title },
];
/** Measures all visible arr descendants, including focusable rows, links and disabled controls. */
async function geometry(page, width, surface) {
  const result = await page.evaluate(({ roots, interactive, phone }) => {
    const scope = [...document.querySelectorAll(roots)].filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden');
    const elements = [...new Set(scope.flatMap(root => [root, ...root.querySelectorAll('*')]))]
      .filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden');
    const describe = n => ({ tag: n.tagName, class: n.className?.baseVal ?? n.className, text: n.textContent.trim().slice(0, 70),
      width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height });
    const controls = elements.filter(n => n.matches(interactive) && (!n.hasAttribute('tabindex') || n.tabIndex >= 0 || n.matches('button, a[href], [role="button"], [role="tab"], input, select, summary')));
    return { scroll: document.scrollingElement.scrollWidth, client: document.scrollingElement.clientWidth,
      wide: elements.filter(n => n.getBoundingClientRect().width > innerWidth).map(describe),
      small: phone ? controls.filter(n => n.getBoundingClientRect().width < 44 || n.getBoundingClientRect().height < 44).map(describe) : [],
      controls: controls.length, measurements: controls.map(describe) };
  }, { roots, interactive, phone: width <= 600 });
  await test.info().attach(`${surface} ${width}px geometry`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect(result.controls, `${surface}: controls were measured`).toBeGreaterThan(0);
  expect(result.scroll, `${surface}: document overflow`).toBeLessThanOrEqual(result.client);
  expect(result.wide, `${surface}: elements wider than viewport`).toEqual([]);
  const known = KNOWN_SMALL_CONTROLS.filter(bug => bug.surface === surface);
  const isKnown = control => known.some(bug => bug.tag === control.tag && bug.text === control.text);
  expect(result.small.filter(control => !isKnown(control)), `${surface}: controls below 44×44 CSS px`).toEqual([]);
  if (width <= 600) for (const bug of known) {
    expect(result.small.some(control => bug.tag === control.tag && bug.text === control.text),
      `${surface}: known product bug "${bug.text}" no longer reproduces; remove its KNOWN_SMALL_CONTROLS entry`).toBe(true);
  }
}

// Two engines cover the explicit width matrix. Pixel 7 runs the interaction cases at 390px;
// duplicating every layout case there would exercise Chromium's same CSS engine a third time.
for (const width of [1440, 390, 360]) {
  test(`arr surfaces fit ${width}px${width <= 600 ? ' with 44px controls' : ''}`, async ({ page, arr }, info) => {
    test.skip(info.project.name === 'mobile-chromium', 'Explicit layout matrix covered by Chromium and Firefox');
    await visit(page, width);
    await geometry(page, width, 'details status');
    await hub(page);
    await geometry(page, width, 'hub My requests');
    await page.locator('.je-hub-row[data-je-arr-key="movie:tmdb:2"] .je-hub-manage').click();
    await expect(page.locator('.je-manage-title')).toContainText('Importing Film');
    await geometry(page, width, 'manage drawer');
    await page.keyboard.press('Escape');
    await page.locator('#je-notify-bell').click();
    await expect(page.locator('.je-notify-item')).toHaveCount(2);
    await geometry(page, width, 'bell panel');
    await page.keyboard.press('Escape');
    for (const tab of ['soon', 'ready', 'overview', 'activity', 'system', 'audit']) {
      await selectTab(page, tab);
      if (['overview', 'activity', 'system', 'audit'].includes(tab)) {
        await expect(page.locator('.je-hub-panel .je-ops-box').first()).toBeVisible();
        await expect.poll(() => arr.requests.includes(`GET ${tab === 'audit' ? '/arr/admin/audit' : '/arr/admin/hub/' + tab}`)).toBe(true);
      } else await expect(page.locator('.je-hub-row')).toHaveCount(1);
      await geometry(page, width, `hub ${tab}`);
    }
  });
}

// Interaction behavior runs once with phone touch emulation; engine layout coverage is above.
test.beforeEach(async ({}, info) => {
  if (!info.title.startsWith('arr surfaces fit')) test.skip(info.project.name !== 'mobile-chromium', 'Interaction cases run on Pixel 7');
});

test('Escape closes manage and bell and returns focus to their openers', async ({ page, arr }) => {
  await visit(page);
  await hub(page);
  const opener = page.locator('.je-hub-row[data-je-arr-key="movie:tmdb:2"] .je-hub-manage');
  await opener.click();
  await expect(page.locator('.je-manage-title')).toContainText('Importing Film');
  await page.keyboard.press('Escape');
  await expect(page.locator('.je-manage')).toHaveCount(0);
  await expect(opener).toBeFocused();
  const bell = page.locator('#je-notify-bell');
  await bell.click();
  await expect(page.locator('.je-notify-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.je-notify-panel')).toHaveCount(0);
  await expect(bell).toBeFocused();
});

test('hub and admin tabs expose exclusive selection after click and keyboard activation', async ({ page, arr }) => {
  await visit(page);
  await hub(page);
  for (const [i, tab] of ['soon', 'ready', 'overview', 'activity', 'system', 'audit', 'mine'].entries()) {
    await selectTab(page, tab, i % 2 === 1);
  }
});

test('family importing says Almost ready without Play; ready copy says Ready to watch', async ({ page, arr }) => {
  await visit(page);
  await expect(page.locator('#itemDetailPage .je-arr-pill-text')).toHaveText(en.arr_status_almost_ready);
  await hub(page);
  const importing = page.locator('.je-hub-row[data-je-arr-key="movie:tmdb:2"]');
  await expect(importing.locator('.je-arr-pill-text')).toHaveText(en.arr_status_almost_ready);
  await expect(importing.getByRole('button', { name: en.arr_hub_play, exact: true })).toHaveCount(0);
  await expect(page.locator('.je-hub-row[data-je-arr-key="movie:tmdb:4"] .je-arr-pill-text')).toHaveText(en.arr_status_stalled);
  await selectTab(page, 'ready');
  const ready = page.locator('.je-hub-row[data-je-arr-key="movie:tmdb:3"]');
  await expect(ready.locator('.je-arr-pill-text')).toHaveText(en.arr_status_ready);
  await expect(ready.getByRole('button', { name: en.arr_hub_play, exact: true })).toBeVisible();
});

test('stale sources and truncated lists disclose notes across hub manage and admin', async ({ page, arr }) => {
  await visit(page);
  await hub(page);
  await expect(page.locator('.je-hub-more')).toHaveText(en.arr_hub_more);
  await expect(page.locator('.je-hub-arr-unavailable')).toHaveText(en.arr_hub_arr_unavailable);
  // A structurally unusable refresh (HTTP 200/null) exercises production failure handling
  // without a browser-generated HTTP console error; the previous successful DTO stays visible.
  arr.data.hub = null;
  await page.evaluate(() => JellyfinEnhanced.arrHub.refresh());
  await expect(page.locator('.je-hub-refresh-failed')).toContainText(en.arr_hub_refresh_failed.split('{time}')[0]);
  await expect(page.locator('.je-hub-row')).toHaveCount(3);
  await page.locator('.je-hub-row[data-je-arr-key="movie:tmdb:2"] .je-hub-manage').click();
  await expect(page.locator('.je-manage-more')).toHaveText(en.arr_manage_and_more.replace('{n}', '3'));
  await expect(page.locator('.je-manage-event-queue-asof')).toContainText(en.arr_ops_as_of.split('{time}')[0]);
  await page.keyboard.press('Escape');
  await selectTab(page, 'activity');
  await expect(page.locator('.je-hub-panel')).toContainText(en.arr_ops_queue_truncated);
  await selectTab(page, 'system');
  await expect(page.locator('.je-hub-panel')).toContainText(en.arr_ops_seerr_truncated.replace('{total}', '250').replace('{n}', '200'));
  await expect(page.locator('.je-hub-panel')).toContainText(en.arr_hub_admin_seerr_error.replace('{error}', 'Fixture read failed'));
});

test('held hub response shows loading then renders content without browser errors', async ({ page, arr }) => {
  await visit(page);
  const held = arr.hold('GET /acquire/hub');
  try {
    await page.evaluate(() => JellyfinEnhanced.arrHub.show());
    await held.requested;
    await expect(page.locator('.je-hub-empty')).toHaveText(en.arr_hub_loading);
    await expect(page.locator('.je-hub-row')).toHaveCount(0);
    await geometry(page, 390, 'held loading hub');
  } finally { held.release(); }
  await expect(page.locator('.je-hub-row')).toHaveCount(3);
});

test('member variant shows family status and only personal hub tabs', async ({ page, arr, baseURL }) => {
  // Replace the route fixture before navigation, using the same strict error checks.
  await page.unrouteAll({ behavior: 'wait' });
  const member = await installArrRoutes(page, { admin: false, origin: baseURL });
  try {
    await visit(page, 390, true);
    await hub(page);
    await expect(page.locator('.je-hub-tab')).toHaveCount(3);
    expect(await page.locator('.je-hub-tab').evaluateAll(nodes => nodes.map(n => n.dataset.tab))).toEqual(['mine', 'soon', 'ready']);
    await expect(page.locator('.je-hub-manage')).toHaveCount(0);
    expect(member.requests.filter(path => path.includes('/arr/admin/'))).toEqual([]);
    await geometry(page, 390, 'member hub');
  } finally { member.check(); }
});
