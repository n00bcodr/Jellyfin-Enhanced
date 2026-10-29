// Requests & downloads, phase 3 (request controls) in a real browser: season rows with Get it, the
// banner's Get them, the episode dialog, the request sheet and the Approvals tab, at desktop and phone
// widths and in the TV layout. Production modules run against stubbed plugin routes (arr-fixtures.cjs).
const { test: base, expect } = require('@playwright/test');
const { installArrRoutes, en } = require('./arr-fixtures.cjs');

const SEASON_EP = n => 'e'.repeat(31) + n;
const ASKED = { outcome: 'accepted', reason: 'awaiting_approval', certainty: 'Succeeded', message: 'Asked!', requestId: 'f'.repeat(32) };

/**
 * A season status: E1 and E3 have rows (E1 ready, E3 downloading), E2 and E4 are missing without one and not monitored
 * (Get it is offered; an episode the arr is looking for right now offers none, see the frontend suite's ask tests).
 */
function seasonStatus() {
  return {
    key: 'tv:tvdb:9:s1', itemId: 'c'.repeat(32), kind: 'season', stage: 'downloading', reason: { code: 'downloading' },
    summary: { aired: 4, ready: 1, downloading: 1, missing: 2, attention: 0 }, actions: [],
    episodes: [
      { key: 'tv:tvdb:9:s1:e1', season: 1, episode: 1, itemId: SEASON_EP(1), row: true, stage: 'ready', reason: { code: 'ready' } },
      { key: 'tv:tvdb:9:s1:e2', season: 1, episode: 2, row: false, stage: 'notHere', reason: { code: 'unmonitored' } },
      { key: 'tv:tvdb:9:s1:e3', season: 1, episode: 3, itemId: SEASON_EP(3), row: true, stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 60 } },
      { key: 'tv:tvdb:9:s1:e4', season: 1, episode: 4, row: false, stage: 'notHere', reason: { code: 'unmonitored' } }
    ]
  };
}
/**
 * The season read: metadata for the episodes without a file, the viewer's request states. The rows carry the request
 * target's own numbering (SeasonRows.source `destination`, UX-3), so single episodes may be asked for by number.
 */
function seasonRows(displayMissing, requests = {}) {
  return { outcome: 'accepted', reason: 'season', certainty: 'Succeeded', message: 'Season', rows: {
    key: 'tv:tvdb:9:s1', series: 'tv:tvdb:9', season: 1, seriesId: 'd'.repeat(32), displayMissing, canRequest: true, seasonRequest: null, source: 'destination',
    episodes: [1, 2, 3, 4].map(n => ({ episode: n, title: n % 2 ? null : `Missing ${n}`, overview: n % 2 ? null : `Overview ${n}.`,
      runtime: n % 2 ? null : 44, airDate: n % 2 ? null : '2014-06-08', still: null, request: requests[n] || null })) } };
}
/** A series status whose second season is not in the library. */
function seriesStatus() {
  return { key: 'tv:tvdb:9', itemId: 'c'.repeat(32), kind: 'series', stage: 'ready', reason: { code: 'ready' }, actions: [],
    summary: { aired: 20, ready: 10, downloading: 0, almostReady: 0, missing: 0, attention: 0, readySeasons: [1] },
    seasons: [{ season: 1, itemId: 'a'.repeat(32), stage: 'ready', summary: { aired: 10, ready: 10, missing: 0 } },
      { season: 2, stage: 'none', summary: { aired: 10, ready: 0, missing: 0 } }] };
}
const card = (n, over = {}) => ({ id: String(n).padStart(32, 'a'), key: `movie:tmdb:${n}`, kind: 'movie', scope: 'movie', variant: 'standard',
  seasons: [], episodes: [], createdAt: '2026-10-12T08:00:00Z', reason: 'awaiting_approval', overQuota: false, stuck: false, cost: 1,
  title: `Film ${n}`, year: 2026, poster: null, requester: { name: 'Leo', role: 'kid', quota: { used: 3, limit: 7, available: true } },
  alsoWanted: [], canApprove: true, canSwitchVariant: false, ...over });

/** Phase-3 routes on top of the shared allow-list; `state` drives the answers and records the writes. */
function phase3(state) {
  const extra = [
    ['GET /acquire/requests/me', () => ({ outcome: 'accepted', reason: 'me', certainty: 'Succeeded', me: state.me })],
    ['GET /acquire/requests/quota', () => ({ outcome: 'accepted', reason: 'quota', certainty: 'Succeeded', quota: state.quota })],
    ['POST /acquire/requests', request => { state.asks.push(request.postDataJSON()); return { __status: 201, body: ASKED }; }],
    ['GET /acquire/requests/approvals', () => ({ outcome: 'accepted', reason: 'approvals', certainty: 'Succeeded', more: false, items: state.approvals })],
    ['GET /acquire/requests/mine', () => ({ outcome: 'accepted', reason: 'mine', certainty: 'Succeeded', items: [] })],
    // The title check (ask-core.js check): nothing blocks an ask for the title.
    ['GET /acquire/requests/check', (request, url) => ({ outcome: 'accepted', reason: 'check', certainty: 'Succeeded',
      check: { key: url.searchParams.get('key'), variant: url.searchParams.get('variant'), canRequest: true, blocked: null } })],
    ['GET /acquire/requests/attention', () => ({ outcome: 'accepted', reason: 'attention', certainty: 'Succeeded', needOk: state.approvals.length, stuck: 0 })],
    ['POST /acquire/requests/bulk-approve', request => {
      state.bulk.push(request.postDataJSON());
      return { __status: 207, body: { outcome: 'accepted', reason: 'bulk_checked', certainty: 'Succeeded', items: [
        { outcome: 'accepted', reason: 'queued_outage', certainty: 'Succeeded', requestId: card(1).id },
        { outcome: 'denied', reason: 'request_changed', certainty: 'Rejected', requestId: card(2).id }] } };
    }]
  ];
  const patterns = [
    ['GET', /^\/acquire\/requests\/season\/[a-z0-9]+$/, () => state.rows],
    // An approved or declined request leaves the list the server answers, as it does on a real server.
    ['POST', /^\/acquire\/requests\/[a-f0-9]{32}\/approve$/, (request, url) => { state.approved.push(url.pathname.split('/').at(-2)); state.approvals = state.approvals.filter(c => c.id !== url.pathname.split('/').at(-2)); return { outcome: 'accepted', reason: 'queued_outage', certainty: 'Succeeded', requestId: url.pathname.split('/').at(-2) }; }],
    ['POST', /^\/acquire\/requests\/[a-f0-9]{32}\/decline$/, (request, url) => { state.declined.push({ id: url.pathname.split('/').at(-2), ...request.postDataJSON() }); state.approvals = state.approvals.filter(c => c.id !== url.pathname.split('/').at(-2)); return { outcome: 'accepted', reason: 'declined', certainty: 'Succeeded', requestId: url.pathname.split('/').at(-2) }; }]
  ];
  return { extra, patterns };
}

const test = base.extend({
  ask: async ({ page, baseURL }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const state = { me: { role: 'kid', canRequest: true, canApprove: false, asksFirst: true, contact: 'Dad', backend: 'je', freeEpisodes: 5 },
      quota: { used: 2, limit: 7, remaining: 5, nextSlotAt: null, usedGb: 0, available: true },
      rows: seasonRows(true), asks: [], approvals: [], approved: [], declined: [], bulk: [] };
    const arr = await installArrRoutes(page, { origin: baseURL, ...phase3(state) });
    await use({ arr, state });
    arr.check();
    expect(errors, 'unexpected browser errors').toEqual([]);
  }
});

const interactive = 'button, a[href], [role="button"], [role="tab"], input, select, summary, [tabindex]';
/** Opens the fixture with the phase-3 modules on a given item status. */
async function open(page, ask, status, { width = 390, query = '' } = {}) {
  ask.arr.data.status = { contact: 'Dad', lookingHours: 24, items: [status] };
  await page.setViewportSize({ width, height: 844 });
  await page.goto(`/arr?ask=1${query}#/details?id=${'c'.repeat(32)}`);
  await expect(page.locator('body')).toHaveAttribute('data-arr-ready', 'true');
  await page.evaluate(() => document.fonts.ready);
}
/** Overflow and (on phones) 44 px checks over the phase-3 surfaces. */
async function geometry(page, width, surface, roots) {
  const result = await page.evaluate(({ roots, interactive, phone }) => {
    const scope = [...document.querySelectorAll(roots)].filter(n => n.getClientRects().length);
    const elements = [...new Set(scope.flatMap(root => [root, ...root.querySelectorAll('*')]))].filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden');
    const describe = n => ({ tag: n.tagName, class: n.className?.baseVal ?? n.className, text: n.textContent.trim().slice(0, 60), width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height });
    const controls = elements.filter(n => n.matches(interactive) && (!n.hasAttribute('tabindex') || n.tabIndex >= 0 || n.matches('button, a[href], [role="button"], input, select')));
    return { scroll: document.scrollingElement.scrollWidth, client: document.scrollingElement.clientWidth, controls: controls.length,
      wide: elements.filter(n => n.getBoundingClientRect().right > innerWidth + 1).map(describe),
      small: phone ? controls.filter(n => n.getBoundingClientRect().width < 44 || n.getBoundingClientRect().height < 44).map(describe) : [] };
  }, { roots, interactive, phone: width <= 600 });
  await test.info().attach(`${surface} ${width}px geometry`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect(result.controls, `${surface}: controls measured`).toBeGreaterThan(0);
  expect(result.scroll, `${surface}: document overflow`).toBeLessThanOrEqual(result.client);
  expect(result.wide, `${surface}: elements past the viewport`).toEqual([]);
  expect(result.small, `${surface}: controls below 44×44 CSS px`).toEqual([]);
}
const FAMILY_FORBIDDEN = /Sonarr|Radarr|instance|quality profile|root folder/i;

for (const width of [1440, 390, 360]) {
  test(`season rows, banner and sheet fit ${width}px${width <= 600 ? ' with 44px controls' : ''}`, async ({ page, ask }, info) => {
    test.skip(info.project.name === 'mobile-chromium', 'Explicit layout matrix covered by Chromium and Firefox');
    await open(page, ask, seasonStatus(), { width, query: '&view=season' });
    await expect(page.locator('.je-ask-row')).toHaveCount(2);
    await geometry(page, width, 'season rows', '.itemsContainer .je-ask-row, .itemsContainer .je-ask-get');
    expect(await page.locator('.itemsContainer').innerText()).not.toMatch(FAMILY_FORBIDDEN);
    // Banner mode: the same season for a viewer who doesn't show missing episodes.
    ask.state.rows = seasonRows(false);
    await page.reload();
    await expect(page.locator('body')).toHaveAttribute('data-arr-ready', 'true');
    await expect(page.locator('.je-arr-banner .je-ask-get')).toBeVisible();
    await expect(page.locator('.je-ask-row')).toHaveCount(0);
    await geometry(page, width, 'season banner', '.je-arr-banner');
    // The request sheet from a series page.
    await open(page, ask, seriesStatus());
    await page.locator('.je-ask-action', { hasText: en.arr_actions_more }).click();
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toBeVisible();
    await geometry(page, width, 'request sheet', '[role="dialog"][aria-modal="true"]');
    expect(await page.locator('[role="dialog"]').innerText()).not.toMatch(FAMILY_FORBIDDEN);
  });
}

test.beforeEach(async ({}, info) => {
  if (!info.title.includes(' fit ')) test.skip(info.project.name !== 'mobile-chromium', 'Interaction cases run on Pixel 7');
});

test('Get it asks once (a double tap is one request) and the row then says Waiting for OK', async ({ page, ask }) => {
  await open(page, ask, seasonStatus(), { query: '&view=season' });
  const row = page.locator('.je-ask-row[data-je-ask-episode="2"]');
  await expect(row.locator('.je-arr-chip')).toHaveText(en.arr_chip_missing);
  ask.state.rows = seasonRows(true, { 2: 'waiting' });
  await row.locator('.je-ask-get').dblclick();
  await expect(row.locator('.je-arr-chip')).toHaveText(en.arr_ask_chip_waiting);
  expect(ask.state.asks).toHaveLength(1);
  expect(ask.state.asks[0].input).toEqual({ key: 'tv:tvdb:9', scope: 'episodes', variant: 'standard', seasons: [], episodes: [{ season: 1, episode: 2 }] });
  expect(ask.state.asks[0].clientRequestId).toMatch(/\S{8,}/);
  await expect(row.locator('.je-ask-get')).toHaveCount(0);
  // The downloading episode keeps its chip and gets the ring on its thumbnail.
  await expect(page.locator(`.listItem[data-id="${SEASON_EP(3)}"] .je-ask-ring`)).toBeVisible();
});

test('the episode dialog traps focus, Escape closes it and focus returns to the row', async ({ page, ask }) => {
  await open(page, ask, seasonStatus(), { query: '&view=season' });
  const title = page.locator('.je-ask-row[data-je-ask-episode="4"] .je-ask-row-title');
  await title.click();
  const dialog = page.locator('.je-ask-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.je-ask-get')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.locator('.je-ask-dialog-close')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.locator('.je-ask-get')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(title).toBeFocused();
});

test('TV layout: JE rows are single buttons and the sheet is full-screen', async ({ page, ask }) => {
  await open(page, ask, seasonStatus(), { query: '&view=season&tv=1', width: 1440 });
  const rows = page.locator('.je-ask-row');
  await expect(rows).toHaveCount(2);
  expect(await rows.evaluateAll(nodes => nodes.map(n => [n.tagName, n.querySelectorAll('button').length]))).toEqual([['BUTTON', 0], ['BUTTON', 0]]);
  await expect(page.locator('.je-ask-get')).toHaveCount(0);
  await rows.first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.je-ask-dialog .je-ask-get')).toBeFocused();
  await page.keyboard.press('Escape');
  await open(page, ask, seriesStatus(), { query: '&tv=1', width: 1440 });
  await page.locator('.je-ask-action', { hasText: en.arr_actions_more }).click();
  const box = await page.locator('[role="dialog"][aria-modal="true"]').boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(1400);
});

test('the request sheet: keyboard choice, over-quota Send for an OK, Escape restores focus', async ({ page, ask }) => {
  ask.state.me = { ...ask.state.me, role: 'member', asksFirst: false };
  ask.state.quota = { used: 7, limit: 7, remaining: 0, nextSlotAt: '2026-10-20T09:00:00Z', usedGb: 0, available: true };
  await open(page, ask, seriesStatus());
  const more = page.locator('.je-ask-action', { hasText: en.arr_actions_more });
  await more.click();
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(en.arr_sheet_send_ok.replace('{contact}', 'Dad'));
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();
});

test('Approvals: approve, decline with a reason chip, bulk approve with per-item outcomes', async ({ page, ask }) => {
  ask.state.me = { role: 'admin', canRequest: true, canApprove: true, asksFirst: false, contact: 'Dad', backend: 'je', freeEpisodes: 5 };
  ask.state.approvals = [card(1), card(2, { title: 'Andor', kind: 'tv', key: 'tv:tvdb:2', scope: 'seasons', seasons: [1, 2] }), card(3)];
  await open(page, ask, seasonStatus(), { width: 390 });
  await page.evaluate(() => JellyfinEnhanced.arrHub.show());
  const tab = page.locator('.je-hub-tab[data-tab="approvals"]');
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const panel = page.locator('.je-hub-panel');
  await expect(panel.getByRole('button', { name: new RegExp(en.arr_approvals_approve) })).toHaveCount(3);
  await geometry(page, 390, 'approvals', '.je-hub-panel');
  await panel.getByRole('button', { name: new RegExp(en.arr_approvals_approve) }).first().click();
  await expect.poll(() => ask.state.approved).toEqual([card(1).id]);
  // The tab reads the list again after each answer: the cards it then draws, by request id.
  const listed = () => panel.locator('[data-request-id]').evaluateAll(nodes => nodes.map(n => n.dataset.requestId));
  await expect.poll(listed).toEqual([card(2).id, card(3).id]);
  await panel.getByRole('button', { name: new RegExp(en.arr_approvals_decline) }).last().click();
  await panel.getByRole('button', { name: en.arr_approvals_reason_together }).click();
  await expect.poll(() => ask.state.declined.length).toBe(1);
  expect(ask.state.declined[0].reason).toBe(en.arr_approvals_reason_together);
  // Bulk: two new cards arrive; the tab shown again reads them (a redraw of the page alone does not read the list).
  // Select both and approve them together; the 207 answer reports each one.
  ask.state.approvals = [card(1), card(2)];
  await page.locator('.je-hub-tab[data-tab="mine"]').click();
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect.poll(listed).toEqual([card(1).id, card(2).id]);
  // The refreshed list is drawn (the one before it had two cards too: Andor and Film 3).
  await expect.poll(() => panel.locator('[data-request-id]').evaluateAll(nodes => nodes.map(n => n.dataset.requestId))).toEqual([card(1).id, card(2).id]);
  await expect(panel.locator('.je-approvals-select')).toBeVisible();
  await panel.locator('.je-approvals-select').click();
  const boxes = panel.locator('input[type="checkbox"]');
  await expect(boxes).toHaveCount(2);
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await panel.locator('.je-approvals-bulk').click();
  await expect.poll(() => ask.state.bulk.length).toBe(1);
  expect(ask.state.bulk[0].ids).toEqual([card(1).id, card(2).id]);
  await expect(panel).toContainText(en.arr_approvals_bulk_summary.replace('{ok}', '1').replace('{failed}', '1'));
  expect(await panel.innerText()).not.toMatch(/Sonarr|Radarr|root folder|quality profile/);
});
