const { test, expect } = require('@playwright/test');
const path = require('node:path');

const js = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js');
const load = async (page, files) => { await page.addScriptTag({ url: '/tests/browser/shared-modules.js' }); for (const file of files) await page.addScriptTag({ path: path.join(js, file) }); }; // canopy K1b: shared modules (client/shared-modules.json) whose providers these fixtures do not load
const A = 'a0000000000000000000000000000000';
const B = 'b0000000000000000000000000000000';
const card = id => `<div class="card" data-id="${id}" data-type="Movie"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer" style="background:#334"></div><div class="cardOverlayContainer"></div></div></div></div>`;

test('stored direct-play answers come back with the media they were asked about', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { window.JellyfinEnhanced = {}; });
  await load(page, ['tags/tag-cache-store.js']);
  const stored = await page.evaluate(async () => {
    const store = window.JellyfinEnhanced.tagCacheStore;
    await store.putDirectPlay('server:user', 'hash', new Map([['item', { r: { directPlay: false }, t: 100, m: 'media-1' }]]), 10);
    return (await store.getDirectPlay('server:user', 'hash')).get('item');
  });
  expect(stored).toMatchObject({ t: 100, m: 'media-1', r: { directPlay: false } });
});

test('the stored cache refuses older snapshots, lost claims and deltas for another base', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => { window.JellyfinEnhanced = {}; });
  await load(page, ['tags/tag-cache-store.js']);
  const result = await page.evaluate(async () => {
    const store = window.JellyfinEnhanced.tagCacheStore;
    const scope = 'server:user';
    const claimed = await store.beginFullWrite(scope, 'newer', { servedAt: 200 });
    await store.putManyIfOwner(scope, 'newer', [['a', { Type: 'Movie' }]]);
    const committed = await store.commitFullWrite(scope, 'newer', { version: 2, timestamp: 20, filterRevision: 'f', count: 1, servedAt: 200 });
    const older = await store.beginFullWrite(scope, 'older', { servedAt: 100 });
    const lostClaim = await store.putManyIfOwner(scope, 'older', [['b', { Type: 'Movie' }]]);
    const lostCommit = await store.commitFullWrite(scope, 'older', { version: 9, timestamp: 90, filterRevision: 'x', count: 1, servedAt: 900 });
    const otherFilter = await store.applyDelta(scope, { timestamp: 20, version: 2, filterRevision: 'other' }, [['c', { Type: 'Movie' }]], 30, 210);
    const otherVersion = await store.applyDelta(scope, { timestamp: 20, version: 3, filterRevision: 'f' }, [['c', { Type: 'Movie' }]], 30, 210);
    const otherCursor = await store.applyDelta(scope, { timestamp: 19, version: 2, filterRevision: 'f' }, [['c', { Type: 'Movie' }]], 30, 210);
    const applied = await store.applyDelta(scope, { timestamp: 20, version: 2, filterRevision: 'f' }, [['d', { Type: 'Movie' }]], 30, 210, ['a']);
    const { entries, meta } = await store.getMany(scope, ['a', 'b', 'c', 'd']);
    return { claimed, committed, older, lostClaim, lostCommit, otherFilter, otherVersion, otherCursor, applied, ids: [...entries.keys()], timestamp: meta.timestamp, servedAt: meta.servedAt, version: meta.version };
  });
  expect(result).toEqual({ claimed: true, committed: true, older: false, lostClaim: false, lostCommit: false, otherFilter: false, otherVersion: false, otherCursor: false, applied: true, ids: ['d'], timestamp: 30, servedAt: 210, version: 2 });
});

test('a library page draws real tags from the server cache, and a user switch leaves nothing of the old account', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(({ html, A, B }) => {
    document.body.innerHTML = html;
    const hooks = new Map();
    const css = (id, text) => { const style = document.createElement('style'); style.id = id; style.textContent = text; document.head.append(style); };
    const session = { user: 'user-a', epoch: 1 };
    const entries = {
      'user-a': { [A]: { Type: 'Movie', Genres: ['Drama'], OfficialRating: 'PG-13', CommunityRating: 7.5, StreamData: { Streams: [{ Type: 'Video', Height: 2160, Width: 3840, Codec: 'hevc' }] } } },
      'user-b': { [A]: { Type: 'Movie', Genres: ['Comedy'], StreamData: { Streams: [{ Type: 'Video', Height: 720, Width: 1280, Codec: 'h264' }] } } },
    };
    window.__session = session;
    window.__hooks = hooks;
    window.JellyfinEnhanced = {
      core: {}, internals: {}, t: key => key, escapeHtml: value => String(value),
      pluginConfig: { TagCacheServerMode: true, TagLayout: 'corners' },
      currentSettings: { tagLayoutSettingsVersion: 1, tagLayout: 'corners', genreTagsEnabled: true, qualityTagsEnabled: true, ratingTagsEnabled: true, ageRatingTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none' },
      cdn: { url: (bucket, file) => `/${bucket}/${file}`, flagSvg: code => `/${code}.svg` },
      session: { getUserId: () => session.user, getServerId: () => 'server', getEpoch: () => session.epoch, isCurrent: epoch => epoch === session.epoch, onUserChange: (name, fn) => hooks.set(name, fn) },
      helpers: { onBodyMutation() {}, onNavigate() {}, addCSS: css },
    };
    window.ApiClient = {
      getCurrentUserId: () => session.user, serverId: () => 'server',
      getUrl: (url, params) => (params ? `${url}?${new URLSearchParams(params)}` : url),
      ajax: async ({ url }) => {
        const since = url.includes('since=');
        return { items: since ? {} : entries[session.user], version: 1, timestamp: 10, servedAt: Date.now(), filterRevision: session.user, filterBase: 'base' };
      },
    };
  }, { html: card(A), A, B });
  await load(page, ['core/ui-kit.js', 'core/dom-observer.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/rating-sources.js',
    'tags/tag-cache-store.js', 'tags/tag-pipeline.js', 'tags/tag-layout-styles.js', 'tags/genretags.js', 'tags/qualitytags.js', 'tags/ratingtags.js', 'tags/ageratingtags.js']);
  await page.evaluate(() => {
    const JE = window.JellyfinEnhanced;
    for (const init of ['initializeGenreTags', 'initializeQualityTags', 'initializeRatingTags', 'initializeAgeRatingTags']) JE[init]();
    JE.tagPipeline.initialize();
  });
  await expect(page.locator('.genre-tag').first()).toHaveAttribute('title', 'Drama');
  await expect(page.locator('.quality-overlay-label[data-quality="4K"]').first()).toBeAttached();
  await expect(page.locator('.age-rating-tag[rating="PG-13"]').first()).toBeAttached();
  await expect(page.locator('.rating-tag').first()).toBeAttached();

  await page.evaluate(() => {
    window.__session.user = 'user-b';
    window.__session.epoch = 2;
    for (const hook of window.__hooks.values()) hook({ userId: 'user-b', serverId: 'server' });
    document.dispatchEvent(new Event('je:user-data-loaded'));
  });
  await expect(page.locator('.genre-tag').first()).toHaveAttribute('title', 'Comedy');
  await expect(page.locator('.quality-overlay-label[data-quality="720p"]').first()).toBeAttached();
  await expect(page.locator('.quality-overlay-label[data-quality="4K"]')).toHaveCount(0);
  await expect(page.locator('.age-rating-tag')).toHaveCount(0);
  await expect(page.locator('.rating-tag')).toHaveCount(0);
});
