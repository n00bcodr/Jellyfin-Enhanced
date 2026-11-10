// Seerr core group (TypeScript rewrite): browser journeys through the emitted
// production scripts and the real core API client, with routed network only.
const { test, expect } = require('@playwright/test');
const path = require('node:path');
const js = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const SCRIPTS = ['core/navigation', 'core/session', 'core/lifecycle', 'core/dom-observer', 'core/ui-kit', 'core/api-client',
  'jellyseerr/seerr-status', 'jellyseerr/request-manager', 'jellyseerr/api', 'jellyseerr/ui/ui-icons', 'jellyseerr/ui/ui-styles',
  'jellyseerr/ui/ui-popover', 'jellyseerr/ui/ui-badges', 'jellyseerr/ui/ui-cards', 'jellyseerr/ui/ui-buttons', 'jellyseerr/ui/ui-quota',
  'jellyseerr/ui/ui-results', 'jellyseerr/ui/ui-request-modals', 'jellyseerr/ui/ui-season-modal', 'jellyseerr/modal'];
const ORIGIN = 'http://seerr.fixture';

/** A page with the Seerr core group on the real client; `answers` maps Seerr proxy paths to JSON or a handler. */
async function setup(page, answers = {}) {
  const errors = []; const posts = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${ORIGIN}/JellyfinEnhanced/jellyseerr/**`, async route => {
    const url = new URL(route.request().url());
    const key = url.pathname.replace('/JellyfinEnhanced/jellyseerr', '');
    if (route.request().method() === 'POST') posts.push({ path: key, body: route.request().postDataJSON() });
    const answer = answers[`${route.request().method()} ${key}`] ?? answers[key];
    if (typeof answer === 'function') return answer(route);
    return route.fulfill({ json: answer ?? {} });
  });
  await page.route(`${ORIGIN}/`, route => route.fulfill({ contentType: 'text/html',
    // Jellyfin's card geometry is not part of the group: a fixed card box stands in for it.
    body: '<!doctype html><html><head><style>.jellyseerr-card{width:220px;display:inline-block}.cardScalable{position:relative;height:330px}'
      + '.cardImageContainer{position:absolute;inset:0}</style></head><body><div id="row"><div class="itemsContainer"></div></div></body></html>' }));
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(origin => {
    window.identity = { user: 'user-a', token: 'token-a' };
    window.seen = [];
    const strings = { jellyseerr_btn_request: 'Request', jellyseerr_btn_requested: 'Requested', jellyseerr_btn_requesting: 'Requesting',
      jellyseerr_modal_request: 'Request', jellyseerr_modal_cancel: 'Cancel', jellyseerr_modal_request_selected: 'Request Selected Season(s)',
      jellyseerr_quota_label_tv: 'Series', jellyseerr_quota_usage: '{label}: {used} of {limit} used' };
    window.JellyfinEnhanced = { pluginConfig: { JellyseerrEnabled: true }, helpers: { trackUsage() {} },
      cdn: { url: () => `${origin}/none.png`, selfhst: () => `${origin}/seerr.svg` },
      t: (key, params = {}) => Object.entries(params).reduce((text, [k, v]) => text.replace(`{${k}}`, String(v)), strings[key] || key) };
    window.ApiClient = { getCurrentUserId: () => window.identity.user, accessToken: () => window.identity.token, serverId: () => 'server-one',
      serverAddress: () => origin, getUrl: p => `${origin}${p}` };
    document.addEventListener('jellyseerr-media-requested', e => window.seen.push(e.detail));
  }, ORIGIN);
  await page.addScriptTag({ content: require('../frontend/helpers/feature-context.cjs').sharedModulesInstaller() }); for (const script of SCRIPTS) await page.addScriptTag({ path: path.join(js, `${script}.js`) }); // canopy K1b: shared modules (client/shared-modules.json) whose providers these fixtures do not load
  return { errors, posts };
}
async function card(page) {
  await page.evaluate(() => {
    const card = window.JellyfinEnhanced.jellyseerrUI.createJellyseerrCard({ id: 603, mediaType: 'movie', title: 'The Matrix', overview: 'Neo' }, true, true);
    document.querySelector('#row .itemsContainer').append(card);
  });
  await page.locator('.jellyseerr-card .cardScalable').hover();
  await expect(page.locator('.jellyseerr-overview .jellyseerr-request-button')).toBeVisible();
  return page.locator('.jellyseerr-overview .jellyseerr-request-button');
}
const held = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

test('a card request is sent once through the real client and shown as requested', async ({ page }) => {
  const gate = held();
  const { errors, posts } = await setup(page, { '/overrideRule': [], 'POST /request': async route => { await gate.promise; await route.fulfill({ status: 201, json: { id: 9 } }); } });
  const button = await card(page);
  await button.click(); await button.click({ force: true });
  await expect(button).toBeDisabled();
  gate.release();
  await expect(button).toHaveText('Requested');
  expect(posts).toEqual([{ path: '/request', body: { mediaType: 'movie', mediaId: 603 } }]);
  expect(await page.evaluate(() => window.seen)).toEqual([{ tmdbId: '603', mediaType: 'movie', is4k: false }]);
  expect(errors).toEqual([]);
});

test('a request lost in transport is not retried and its outcome is shown as unknown', async ({ page }) => {
  const { errors, posts } = await setup(page, { '/overrideRule': [], 'POST /request': route => route.abort('failed') });
  const button = await card(page);
  await button.click();
  await expect(button).toContainText('Request status unknown');
  await expect(button).toBeEnabled();
  expect(posts).toHaveLength(1);
  expect(await page.evaluate(() => window.JellyfinEnhanced.internals.jellyseerrUi.outcomes.map(o => o.kind))).toEqual(['uncertain']);
  expect(errors).toEqual([]);
});

test('an account change while a request is in flight leaves the next account\'s view untouched', async ({ page }) => {
  const gate = held();
  const { errors, posts } = await setup(page, { '/overrideRule': [], 'POST /request': async route => { await gate.promise; await route.fulfill({ status: 201, json: { id: 9 } }); } });
  const button = await card(page);
  await button.click();
  await expect.poll(() => posts.length).toBe(1);
  await page.evaluate(() => { window.identity = { user: 'user-b', token: 'token-b' }; window.JellyfinEnhanced.session.checkNow('test'); });
  gate.release();
  await expect(button).toHaveText('Request');
  await expect(button).toBeEnabled();
  expect(await page.evaluate(() => window.seen)).toEqual([]);
  expect(errors).toEqual([]);
});

test('the season modal requests the chosen season with its quota shown, then closes', async ({ page }) => {
  const { errors, posts } = await setup(page, {
    '/settings/partial-requests': { partialRequestsEnabled: true, enableSpecialEpisodes: false },
    '/tv/42': { name: 'Show', externalIds: { tvdbId: 5 },
      seasons: [{ seasonNumber: 1, name: 'Season 1', episodeCount: 3, airDate: '2020-01-01' }, { seasonNumber: 2, name: 'Season 2', episodeCount: 4, airDate: '2021-01-01' }],
      mediaInfo: { seasons: [{ seasonNumber: 1, status: 3 }] } },
    '/quota': { tv: { limit: 5, used: 1, remaining: 4 } },
    '/overrideRule': [],
    'POST /request': { id: 1 }
  });
  await page.evaluate(() => window.JellyfinEnhanced.jellyseerrUI.showSeasonSelectionModal(42, 'tv', 'Show'));
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.jellyseerr-quota-chip')).toHaveText('Series: 1 of 5 used');
  await expect(dialog.locator('.jellyseerr-season-checkbox[data-season-number="1"]')).toBeDisabled();
  await dialog.locator('.jellyseerr-season-checkbox[data-season-number="2"]').check();
  await dialog.getByRole('button', { name: 'Request', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(posts).toEqual([{ path: '/request', body: { mediaType: 'tv', mediaId: 42, seasons: [2] } }]);
  expect(errors).toEqual([]);
});
