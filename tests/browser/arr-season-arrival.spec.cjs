// F102: a season page open while an episode arrives shows the episode once. Jellyfin replaces a missing (virtual)
// episode with a playable item under another id, can draw both for a moment, and does not tell the page the missing
// one went (its LibraryChanged filters pathless items out). Production status modules on the mock host's native list.
const { test: base, expect } = require('@playwright/test');
const { installArrRoutes, ITEM } = require('./arr-fixtures.cjs');

const id = n => String(n).padStart(32, '0');
const VIRTUAL_ONE = id(1), MISSING_TWO = id(2), LATER = id(3), PLAYABLE_ONE = id(501);

const test = base.extend({
  arr: async ({ page, baseURL }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const arr = await installArrRoutes(page, { origin: baseURL });
    // Jellyfin's item reads as the viewer: the season (its series) and the playable episode.
    await page.route(/\/Users\/[0-9a-f]{32}\/Items\/[0-9a-f]{32}$/, route => {
      const itemId = new URL(route.request().url()).pathname.split('/').at(-1);
      if (itemId === PLAYABLE_ONE) return route.fulfill({ json: { Id: PLAYABLE_ONE, Type: 'Episode', Name: 'The Real One', Overview: 'Overview of the playable episode', SeriesId: id(800), IndexNumber: 1 } });
      return route.fulfill({ json: { Id: itemId, Type: 'Season', Name: 'Season 1', SeriesId: id(800) } });
    });
    await use(arr);
    arr.check();
    expect(errors, 'unexpected browser errors').toEqual([]);
  }
});

/** A season status: E1 and E2 have Jellyfin's missing rows, E3 plays; E1 can be ready under its playable item. */
function seasonStatus(one = null) {
  const ep = (n, itemId, stage) => ({ key: `tv:tvdb:9:s1:e${n}`, season: 1, episode: n, itemId, row: true, stage,
    reason: { code: stage === 'ready' ? 'ready' : stage === 'almostReady' ? 'importing' : 'downloading' }, progress: stage === 'downloading' ? { percent: 40 } : null });
  return { key: 'tv:tvdb:9:s1', itemId: ITEM, kind: 'season', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 40 },
    summary: { aired: 3, ready: one ? 2 : 1, downloading: 1, almostReady: one ? 0 : 1, missing: 0 },
    episodes: [one ? ep(1, one, 'ready') : ep(1, VIRTUAL_ONE, 'almostReady'), ep(2, MISSING_TWO, 'downloading'), ep(3, LATER, 'ready')] };
}

/** Jellyfin-web's legacy list rows: virtual E1 (TMDB rating and overview, "Missing"), missing E2, playable E3. */
async function drawList(page, { physical = false } = {}) {
  await page.evaluate(({ physical, ids }) => {
    const row = (itemId, n, { missing = false, name = `Episode ${n}`, overview = `TMDB overview ${n}`, heart = false } = {}) =>
      `<div class="listItem listItem-largeImage listItem-withContentWrapper" data-type="Episode" data-id="${itemId}" data-action="link">`
      + `<div class="listItem-content"><div class="listItemImage listItemImage-large itemAction" data-action="link"></div><div class="listItemBody itemAction">`
      + `<div class="listItemBodyText"><bdi>${n}. ${name}</bdi></div><div class="secondary listItemMediaInfo listItemBodyText">`
      + (missing ? '<div class="mediaInfoItem starRatingContainer">7.9</div><div class="missingIndicator">Missing</div>' : '<div class="mediaInfoItem">45m</div>')
      + `</div></div>${heart ? `<button is="emby-ratingbutton" class="listItemButton paper-icon-button-light itemAction" data-id="${itemId}" title="Favorite">♥</button>` : ''}</div>`
      + `<div class="listItem-bottomoverview secondary"><bdi>${overview}</bdi></div></div>`;
    document.querySelector('#childrenContent .itemsContainer').innerHTML = [
      row(ids.virtualOne, 1, { missing: true }),
      ...(physical ? [row(ids.playableOne, 1, { name: 'The Real One', overview: 'Overview of the playable episode', heart: true })] : []),
      row(ids.missingTwo, 2, { missing: true }),
      row(ids.later, 3, { overview: 'Overview 3' })].join('');
  }, { physical, ids: { virtualOne: VIRTUAL_ONE, playableOne: PLAYABLE_ONE, missingTwo: MISSING_TWO, later: LATER } });
}

/** Opens the phone-width season page on a status. */
async function open(page, arr, status) {
  arr.data.status = { contact: 'Dad', lookingHours: 24, items: [status] };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/arr?view=season#/details?id=${ITEM}`);
  await expect(page.locator('body')).toHaveAttribute('data-arr-ready', 'true');
}

/** The status read again (the change feed's job), with a new answer. */
async function answer(page, arr, status) {
  arr.data.status = { contact: 'Dad', lookingHours: 24, items: [status] };
  await page.evaluate(() => JellyfinEnhanced.internals.arrStatusDetails.update(true));
}

/** Exactly one E1 row, the playable item's, at E1's place before E2; no missing E1 left. */
async function expectOneEpisodeOne(page, { nativeControls }) {
  const rows = page.locator('#childrenContent .itemsContainer > .listItem');
  await expect.poll(() => rows.evaluateAll(list => list.map(row => row.dataset.id))).toEqual([PLAYABLE_ONE, MISSING_TWO, LATER]);
  const first = rows.first();
  await expect(first.locator('.missingIndicator')).toHaveCount(0);
  await expect(first.locator('.listItemBodyText bdi').first()).toHaveText('1. The Real One');
  await expect(first.locator('.listItem-bottomoverview')).toHaveText('Overview of the playable episode');
  await expect(page.locator('#childrenContent')).not.toContainText('TMDB overview 1');
  if (nativeControls) await expect(first.locator('button.listItemButton')).toBeVisible();
  await expect(rows.nth(1).locator('.missingIndicator')).toHaveCount(1);
  const scroll = await page.evaluate(() => [document.scrollingElement.scrollWidth, document.scrollingElement.clientWidth]);
  expect(scroll[0], 'no horizontal overflow on a phone').toBeLessThanOrEqual(scroll[1]);
}

test('F102: the host redraws its list, then E1 arrives under a new id: one E1 row at its place', async ({ page, arr }) => {
  await open(page, arr, seasonStatus());
  await drawList(page);
  await expect(page.locator(`[data-id="${VIRTUAL_ONE}"] .je-arr-chip`)).toHaveCount(1);
  // The host replaces its list (a native redraw): JE's earlier row references are gone.
  await drawList(page);
  await page.waitForTimeout(150);
  await answer(page, arr, seasonStatus(PLAYABLE_ONE));
  await expectOneEpisodeOne(page, { nativeControls: false });
});

test('F102: the host draws E1\'s missing row beside its playable one, before and after the arrival is read', async ({ page, arr }) => {
  await open(page, arr, seasonStatus());
  await drawList(page);
  await expect(page.locator(`[data-id="${VIRTUAL_ONE}"] .je-arr-chip`)).toHaveCount(1);
  await answer(page, arr, seasonStatus(PLAYABLE_ONE));
  // Jellyfin's one redraw lists both items for E1 (its cleanup of the missing one not done yet).
  await drawList(page, { physical: true });
  await expectOneEpisodeOne(page, { nativeControls: true });
  const heart = page.locator('#childrenContent .itemsContainer > .listItem').first().locator('button.listItemButton');
  await heart.focus();
  await answer(page, arr, seasonStatus(PLAYABLE_ONE));
  await expect(heart).toBeFocused();
  await expectOneEpisodeOne(page, { nativeControls: true });
});

test('F102: a season Jellyfin first drew with both E1 items converges once its missing E1 is gone', async ({ page, arr }) => {
  await page.addInitScript(({ ids }) => {
    // Jellyfin's season list as the viewer: E1's missing item is gone, its playable item is listed.
    window.__episodes = [];
    const define = () => {
      if (!window.ApiClient) return setTimeout(define, 5);
      window.ApiClient.getEpisodes = async (seriesId, query) => {
        window.__episodes.push([seriesId, query.seasonId]);
        return { Items: [[ids.playableOne, 1, 'FileSystem'], [ids.missingTwo, 2, 'Virtual'], [ids.later, 3, 'FileSystem']]
          .map(([Id, IndexNumber, LocationType]) => ({ Id, IndexNumber, ParentIndexNumber: 1, SeasonId: ids.season, LocationType })) };
      };
    };
    define();
  }, { ids: { playableOne: PLAYABLE_ONE, missingTwo: MISSING_TWO, later: LATER, season: ITEM } });
  arr.data.status = { contact: 'Dad', lookingHours: 24, items: [seasonStatus(PLAYABLE_ONE)] };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/arr?view=season#/details?id=${ITEM}`);
  await expect(page.locator('body')).toHaveAttribute('data-arr-ready', 'true');
  await drawList(page, { physical: true });
  await expect.poll(() => page.locator('#childrenContent .itemsContainer > .listItem').evaluateAll(list => list.map(row => row.dataset.id))).toEqual([PLAYABLE_ONE, MISSING_TWO, LATER]);
  await expect(page.locator('#childrenContent .itemsContainer > .listItem').first().locator('button.listItemButton')).toBeVisible();
  expect(await page.evaluate(() => window.__episodes)).toEqual([[id(800), ITEM]]);
});
