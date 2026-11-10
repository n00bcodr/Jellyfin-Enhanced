// Details-providers TypeScript replacement: boundary, lifecycle and mutation
// regressions against the production emitted scripts (DETAILS-PROVIDERS-*).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createHarness, deferred, jsRoot, jsonResponse, plain } from '../../helpers/harness.mjs';
import sharedRuntime from '../../helpers/feature-context.cjs';
const { provideSharedRuntime } = sharedRuntime;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const flush = async () => { for (let i = 0; i < 6; i++) await nextTurn(); };
function sessionStub() {
  let epoch = 0; const handlers = [];
  return { session: { getEpoch: () => epoch, isCurrent: e => e === epoch, onUserChange: (_name, fn) => handlers.push(fn) },
    switchUser() { epoch++; for (const fn of handlers) fn(); } };
}

// ── Shared details sections (reviews, awards, MDBList, DoesTheDogDie) ────────
function detailsHarness(t, { html = '<div class="tagline"></div>', url = 'http://jellyfin.test/web/index.html#!/details?id=one', getItem, JE = {}, apiClient = {} } = {}) {
  let hook;
  const h = createHarness({ html: `<div id="itemDetailPage">${html}</div>`, url, apiClient: { getItem, getCurrentUser: async () => ({ Id: 'user-a', Policy: { IsAdministrator: false } }), ...apiClient },
    JE: { escapeHtml, t: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key, icon: () => '<span>star</span>', IconName: { STAR: 'star' },
      cdn: { url: (source, file) => `https://cdn.test/${source}/${file}` },
      helpers: { onViewPage: fn => { hook = fn; return () => {}; }, createExternalLink: (href, options = {}) => {
        // The shared helper's contract: class, title and the setup callback.
        const anchor = Object.assign(h.document.createElement('a'), { href, className: options.className || '', title: options.title || '' });
        options.setup?.(anchor);
        return anchor;
      } },
      ...JE } });
  t.after(() => h.close());
  // The page-visibility delay runs without sleeping.
  h.window.setTimeout = fn => { queueMicrotask(fn); return 1; };
  return { ...h, page: () => h.document.querySelector('#itemDetailPage'),
    async show() { await hook(null, h.document.querySelector('#itemDetailPage'), h.window.location.hash); },
    route(id) { h.window.history.replaceState({}, '', `#!/details?id=${id}`); } };
}
const movie = (id, tmdb = '7') => ({ Id: id, Type: 'Movie', ProviderIds: { Tmdb: tmdb } });
const sectionCases = [
  ['reviews', 'elsewhere/reviews.js', 'initializeReviewsScript', '.tmdb-reviews-section',
    { pluginConfig: { ShowUserReviews: true }, core: { api: { fetch: async () => ({ results: [] }), plugin: async () => ({ reviews: [{ userId: 'x', userName: 'Old', content: 'about item one' }] }) } } }],
  ['awards', 'awards/awards.js', 'initializeAwardsScript', '.je-awards-section',
    { pluginConfig: { ShowAwards: true }, core: { api: { plugin: async () => ({ Found: true, Confirmed: true, Wins: 1, Nominations: 0, Awards: [{ Name: 'Academy Award for X', Result: 'Won', Year: 2020 }] }), manager: { clearCacheMatching() {} } } } }],
  ['MDBList', 'others/mdblist-ratings.js', 'initializeMdblistRatingsScript', '.je-mdblist-ratings-section',
    { pluginConfig: { MdblistRatingsEnabled: true, MdblistRatingsShowOnItemDetails: true }, core: { api: { plugin: async () => ({ Found: true, Confirmed: true, Ratings: [{ Source: 'imdb', Score: 72 }], Ids: { imdb: 'tt1' } }), manager: { clearCacheMatching() {} } } } }],
  ['DoesTheDogDie', 'others/doesthedogdie.js', 'initializeDoesTheDogDieScript', '.je-ddd-section',
    { pluginConfig: { DoesTheDogDieEnabled: true }, saveUserSettings: async () => {}, core: { ui: { skeletonGridHtml: () => '' }, api: { plugin: async () => ({ Found: true, Confirmed: true, ItemId: 3, Topics: [{ Id: 1, Name: 'dog dies', Yes: 9, No: 1 }] }), manager: { clearCacheMatching() {} } } } }],
];
for (const [name, file, init, selector, JE] of sectionCases) {
  test(`DETAILS-PROVIDERS-007 ${name}: a result for the previous item never decorates the reused page`, async t => {
    const first = deferred();
    const h = detailsHarness(t, { JE, getItem: async (_user, id) => id === 'one' ? first.promise : movie(id, '8'),
      apiClient: { ajax: async () => ({ Triggers: [] }) } });
    h.load(file); h.JE[init]();
    const requests = [];
    for (const method of ['plugin', 'fetch']) {
      const original = h.JE.core.api[method];
      if (original) h.JE.core.api[method] = (path, ...rest) => { requests.push(path); return original(path, ...rest); };
    }
    await h.show();
    // Jellyfin reuses the same detail view for the next item before the lookup returns.
    h.route('two');
    first.resolve(movie('one'));
    await flush();
    assert.equal(h.document.querySelector(selector), null);
    assert.deepEqual(requests, [], 'the superseded visit made no provider request');
    // The current item still renders on its own visit.
    await h.show(); await flush();
    assert.ok(h.document.querySelector(selector));
  });
  test(`DETAILS-PROVIDERS-007 ${name}: an account switch during the lookup drops the result`, async t => {
    const first = deferred(); const { session, switchUser } = sessionStub();
    const h = detailsHarness(t, { JE: { ...JE, session }, getItem: async () => first.promise, apiClient: { ajax: async () => ({ Triggers: [] }) } });
    h.load(file); h.JE[init]();
    await h.show();
    switchUser();
    first.resolve(movie('one'));
    await flush();
    assert.equal(h.document.querySelector(selector), null);
  });
}

test('DETAILS-PROVIDERS-012 provider ids are encoded into plugin request paths, cache keys keep the raw id', async t => {
  const paths = [];
  const h = detailsHarness(t, { getItem: async () => movie('one', '../../user-settings/victim/settings.json'),
    JE: { pluginConfig: { ShowAwards: true }, core: { api: { plugin: async (path, options) => { paths.push([path, options?.cacheKey]); return { Found: false }; }, manager: { clearCacheMatching() {} } } } } });
  h.load('awards/awards.js'); h.JE.initializeAwardsScript(); await h.show(); await flush();
  assert.deepEqual(paths, [['/awards/movie/..%2F..%2Fuser-settings%2Fvictim%2Fsettings.json', 'awards:/movie/../../user-settings/victim/settings.json']]);
});

test('DETAILS-PROVIDERS-008 TMDB review ratings are numbers, never markup', async t => {
  const h = detailsHarness(t, { getItem: async () => movie('one'),
    JE: { pluginConfig: { ShowReviews: true, TmdbEnabled: true }, core: { api: { plugin: async () => ({ reviews: [] }),
      fetch: async () => ({ results: [{ author: 'A', content: 'Fine', author_details: { rating: '<img src=x onerror=alert(1)>' } }, { author: 'B', content: 'Good', author_details: { rating: 8 } }] }) } } } });
  h.load('elsewhere/reviews.js'); h.JE.initializeReviewsScript(); await h.show(); await flush();
  assert.equal(h.document.querySelectorAll('.tmdb-review-card').length, 2);
  assert.equal(h.document.querySelector('img[src="x"]'), null);
  assert.deepEqual([...h.document.querySelectorAll('.tmdb-review-rating')].map(node => node.textContent.trim()), ['star 8']);
});

test('DETAILS-PROVIDERS-014 read more expands each TMDB card to its own review, even with the same author', async t => {
  const long = label => `${label} `.repeat(120);
  const h = detailsHarness(t, { getItem: async () => movie('one'),
    JE: { pluginConfig: { ShowReviews: true, TmdbEnabled: true }, core: { api: { plugin: async () => ({ reviews: [] }),
      fetch: async () => ({ results: [{ author: 'Tom & Jerry', content: long('first') }, { author: 'Tom & Jerry', content: long('second') }] }) } } } });
  h.load('elsewhere/reviews.js'); h.JE.initializeReviewsScript(); await h.show(); await flush();
  const cards = [...h.document.querySelectorAll('.tmdb-review-card')];
  cards[1].querySelector('.tmdb-review-toggle').click();
  const text = cards[1].querySelector('.tmdb-review-text');
  assert.ok(text.classList.contains('expanded'));
  assert.match(text.textContent, /second second/);
  assert.doesNotMatch(text.textContent, /first/);
  assert.ok(text.textContent.length > 600);
});

test('DETAILS-PROVIDERS-013 MDBList scores render as text: a non-numeric upstream value is dropped', async t => {
  const h = detailsHarness(t, { html: '<div class="itemMiscInfo"><div class="mediaInfoItem mediaInfoOfficialRating">PG</div></div><div class="itemExternalLinks"></div>', getItem: async () => movie('one'),
    JE: { pluginConfig: { MdblistRatingsEnabled: true, MdblistRatingsShowOnItemDetails: true, MdblistRatingsShowPercentSymbol: true }, t: key => key,
      core: { api: { plugin: async () => ({ Found: true, Confirmed: true, Ids: { imdb: 'tt42' },
        Ratings: [{ Source: 'rogerebert', Value: '<img src=x onerror=alert(1)>', Score: null }, { Source: 'imdb', Score: 71.6, Votes: 10 }, { Source: 'tomatoes', Score: 55, Fresh: 1 }] }), manager: { clearCacheMatching() {} } } } } });
  h.load('others/mdblist-ratings.js'); h.JE.initializeMdblistRatingsScript(); await h.show(); await flush();
  const section = h.document.querySelector('.je-mdblist-ratings-section');
  assert.equal(section.nextElementSibling.className, 'itemExternalLinks');
  assert.equal(section.querySelector('img[src="x"]'), null);
  const badges = [...section.querySelectorAll('.je-mdblist-badge')];
  assert.deepEqual(badges.map(b => b.textContent), ['55%', '72%']);
  // RT rule: a score below 60 is Rotten whatever the fresh flag says.
  assert.match(badges[0].querySelector('img').src, /rottentomatoes_rotten\.png$/);
  assert.equal(badges[1].href, 'https://www.imdb.com/title/tt42/');
  assert.equal(badges[1].title, 'IMDb: 71.6 (mdblist_ratings_votes)');
});

test('MDBList unconfirmed failure placeholders are dropped from the response cache', async t => {
  const cleared = [];
  const h = detailsHarness(t, { getItem: async (_user, id) => id === 'one' ? { Id: 'one', Type: 'Episode', SeriesId: 'series', SeriesName: 'Show' } : { Id: 'series', Type: 'Series', ProviderIds: { Tmdb: '9' } },
    JE: { pluginConfig: { MdblistRatingsEnabled: true, MdblistRatingsShowOnItemDetails: true }, core: { api: { plugin: async path => { assert.equal(path, '/mdblist-ratings/tv/9'); return { Found: false, Confirmed: false }; }, manager: { clearCacheMatching: key => cleared.push(key) } } } } });
  h.load('others/mdblist-ratings.js'); h.JE.initializeMdblistRatingsScript(); await h.show(); await flush();
  assert.deepEqual(cleared, ['mdblist-ratings:/tv/9']);
  assert.equal(h.document.querySelector('.je-mdblist-ratings-section'), null);
});

// ── DoesTheDogDie trigger picks ─────────────────────────────────────────────
function dddHarness(t, { triggers, withSession = true }) {
  const stub = sessionStub(); const session = withSession ? stub.session : undefined; const switchUser = stub.switchUser; const saved = []; let user = 'user-a';
  const h = detailsHarness(t, { getItem: async () => movie('one'),
    apiClient: { getCurrentUserId: () => user, ajax: async ({ url }) => triggers(url) },
    JE: { session, pluginConfig: { DoesTheDogDieEnabled: true }, saveUserSettings: async (file, doc) => { saved.push([file, doc]); },
      core: { ui: { skeletonGridHtml: () => '<div class="je-skeleton-grid"></div>' }, api: { manager: { clearCacheMatching() {} },
        plugin: async path => path === '/ddd/topics'
          ? { Topics: [{ Id: 1, Name: 'dog dies', Category: 'Animals', Group: 'Violence' }, { Id: 2, Name: 'spiders', Category: 'Animals', Group: 'Phobia' }] }
          : { Found: true, Confirmed: true, ItemId: 3, Topics: [{ Id: 1, Name: 'dog dies', Yes: 9, No: 1 }, { Id: 2, Name: 'spiders', Yes: 8, No: 2 }] } } } } });
  h.load('others/doesthedogdie.js'); h.JE.initializeDoesTheDogDieScript();
  return { ...h, saved, switchUser(next) { user = next; switchUser(); },
    async openPicker() { h.document.querySelector('.je-ddd-gear').click(); await flush(); },
    checked: () => [...h.document.querySelectorAll('.je-ddd-row input')].map(box => box.checked) };
}
test('DETAILS-PROVIDERS-009 trigger picks follow the signed-in account and are saved for that account only', async t => {
  const h = dddHarness(t, { triggers: url => url.includes('/user-a/') ? { Triggers: [1] } : { Triggers: [2] } });
  await h.show(); await flush();
  assert.equal(h.document.querySelector('.je-ddd-sum').textContent, 'ddd_summary_mine:{"hits":1,"total":1}');
  h.switchUser('user-b');
  await h.show(); await flush();
  await h.openPicker();
  assert.deepEqual(h.checked(), [true, false], 'Phobia/spiders checked for user B only (groups sort Phobia first)');
  assert.equal(h.document.querySelector('.je-ddd-row span').textContent, 'Spiders');
  h.document.querySelector('.je-ddd-save').click(); await flush();
  assert.deepEqual(plain(h.saved), [['ddd-triggers.json', { Triggers: [2] }]]);
});
test('DETAILS-PROVIDERS-009 picks are re-read when the signed-in user changes even without a session reset', async t => {
  const h = dddHarness(t, { withSession: false, triggers: url => url.includes('/user-a/') ? { Triggers: [1] } : { Triggers: [2] } });
  await h.show(); await flush();
  h.switchUser('user-b');
  await h.openPicker();
  assert.deepEqual(h.checked(), [true, false]);
});
test('DETAILS-PROVIDERS-009 picks that failed to load are retried and never overwritten from an empty draft', async t => {
  let fail = true;
  const h = dddHarness(t, { triggers: async () => { if (fail) throw new Error('offline'); return { Triggers: [1] }; } });
  await h.show(); await flush();
  assert.equal(h.document.querySelector('.je-ddd-sum').textContent, 'ddd_summary_all:{"count":2}');
  await h.openPicker();
  assert.equal(h.document.querySelector('.je-ddd-list').textContent, 'ddd_picker_failed');
  h.document.querySelector('.je-ddd-save').click(); await flush();
  assert.deepEqual(h.saved, []);
  h.document.querySelector('.je-ddd-modal')?.remove();
  fail = false;
  await h.openPicker();
  assert.deepEqual(h.checked(), [false, true]);
});

// ── Elsewhere ─────────────────────────────────────────────────────────────
function elsewhereHarness(t, { html, watch = { results: { GB: { link: 'https://www.justwatch.com/gb', flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/n.png' }] } } }, getItem = async () => null } = {}) {
  const idle = []; const saved = []; const { session, switchUser } = sessionStub();
  const h = createHarness({ url: 'http://jellyfin.test/web/index.html#!/details?id=one',
    html: html ?? '<div id="itemDetailPage"><div class="detailSectionContent"><div class="itemExternalLinks"><a href="https://www.themoviedb.org/movie/7">TMDB</a></div></div></div>',
    apiClient: { getItem, ajax: async () => h.JE.userConfig.elsewhere },
    fetch: async url => String(url).endsWith('regions.txt')
      ? new Response('US\tUnited States\nGB\t<img src=x onerror=alert(1)>\nDE\tGermany')
      : new Response('Netflix\nHulu'),
    globals: { requestIdleCallback: fn => idle.push(fn) },
    JE: { session, pluginConfig: { ElsewhereEnabled: true, TmdbEnabled: true, DEFAULT_REGION: 'US' },
      userConfig: { elsewhere: { Region: 'GB', Regions: ['DE'], Services: ['Netflix'], SeasonProviders: true } },
      saveUserSettings: async (file, doc) => { saved.push([file, doc]); },
      t: (key, params) => params ? `${key}:${Object.values(params).join(',')}` : key, cdn: { url: (source, file) => `/cdn/${source}/${file}` },
      helpers: { createObserver() {}, onViewPage() {}, getItemCached: id => getItem('user-a', id) },
      core: { api: { fetch: async url => { if (String(url).includes('/watch/providers')) return watch; throw new Error(`HTTP 404 ${url}`); } } } } });
  t.after(() => h.close());
  h.load('elsewhere/elsewhere.js'); h.JE.initializeElsewhereScript();
  return { ...h, saved, switchUser, async runIdle() { await flush(); while (idle.length) { idle.shift()(); await flush(); } } };
}
test('DETAILS-PROVIDERS-005 an upstream JustWatch link that is not navigable is neutralised', async t => {
  const h = elsewhereHarness(t, { watch: { results: { GB: { link: 'javascript:alert(1)', flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/n.png' }] } } } });
  await h.runIdle();
  const title = h.document.querySelector('.streaming-lookup-container a');
  assert.equal(title.textContent, 'elsewhere_panel_available_in:<img src=x onerror=alert(1)>');
  assert.equal(title.getAttribute('href'), '#');
  assert.equal(h.document.querySelector('img[src="x"]'), null);
  assert.equal(h.document.querySelector('.streaming-lookup-container img').getAttribute('src'), 'https://image.tmdb.org/t/p/w92/n.png');
});
test('DETAILS-PROVIDERS-002/003 the settings form shows remote names as text and the signed-in user\'s saved choices', async t => {
  const h = elsewhereHarness(t);
  await h.runIdle();
  h.document.querySelector('.elsewhere-settings-button').click(); await flush();
  const modal = h.document.getElementById('streaming-settings-modal');
  assert.equal(modal.style.display, 'flex');
  assert.equal(modal.querySelector('img[src="x"]'), null);
  assert.equal(modal.querySelector('#region-select').value, 'GB');
  assert.equal(modal.querySelector('#region-select option[value="GB"]').textContent, '<img src=x onerror=alert(1)>');
  assert.deepEqual([...modal.querySelectorAll('.selected-tag')].map(tag => tag.dataset.value), ['Germany (DE)', 'Netflix']);
  // Another account signs in; its saved choices replace the previous user's.
  h.switchUser();
  assert.equal(modal.style.display, 'none');
  h.JE.userConfig.elsewhere = { Region: 'DE', Regions: [], Services: ['Hulu'], SeasonProviders: false };
  h.document.dispatchEvent(new h.window.CustomEvent('je:user-data-loaded')); await flush();
  h.document.querySelector('.elsewhere-settings-button').click(); await flush();
  assert.equal(modal.querySelector('#region-select').value, 'DE');
  assert.deepEqual([...modal.querySelectorAll('.selected-tag')].map(tag => tag.dataset.value), ['Hulu']);
  assert.equal(modal.querySelector('#season-providers-checkbox').checked, false);
  modal.querySelector('#save-settings').click();
  assert.deepEqual(plain(h.saved), [['elsewhere.json', { Region: 'DE', Regions: [], Services: ['Hulu'], SeasonProviders: false }]]);
});
test('DETAILS-PROVIDERS-004 lookup errors are shown as text (automatic and manual search)', async t => {
  const h = elsewhereHarness(t);
  await h.runIdle();
  h.JE.core.api.fetch = async () => { throw new Error('<img src=x onerror=alert(1)>'); };
  h.document.querySelector('.elsewhere-search-button').click(); await flush();
  const error = h.document.querySelector('#streaming-result-container div');
  assert.equal(error.textContent, 'elsewhere_panel_error:<img src=x onerror=alert(1)>');
  assert.equal(h.document.querySelector('img[src="x"]'), null);
  assert.equal(h.document.querySelector('.elsewhere-search-button').disabled, false);
  const auto = elsewhereHarness(t);
  // Browser fetch rejects with the page realm's TypeError.
  auto.JE.core.api.fetch = async () => { throw new auto.window.TypeError('Failed to fetch'); };
  await auto.runIdle();
  assert.equal(auto.document.querySelector('.streaming-lookup-container div').textContent, 'elsewhere_panel_error:TMDB API is unreachable.');
});
test('Elsewhere manual search lists the chosen regions, unavailable ones first, filtered by the chosen services', async t => {
  const h = elsewhereHarness(t, { watch: { results: {
    GB: { link: 'https://www.justwatch.com/gb', flatrate: [{ provider_id: 8, provider_name: 'Netflix', logo_path: '/n.png' }] },
    DE: { link: 'https://www.justwatch.com/de', flatrate: [{ provider_id: 9, provider_name: 'Hulu', logo_path: '/h.png' }] } } } });
  await h.runIdle();
  h.JE.userConfig.elsewhere = { Region: 'GB', Regions: ['DE', 'GB'], Services: ['Netflix'] };
  h.document.dispatchEvent(new h.window.CustomEvent('je:user-data-loaded')); await flush();
  h.document.querySelector('.elsewhere-search-button').click(); await flush();
  const results = h.document.querySelector('#streaming-result-container');
  assert.deepEqual([...results.children].map(child => child.textContent.trim()), ['elsewhere_panel_not_available_in_regions:Germanyclose', 'elsewhere_panel_available_in_region:<img src=x onerror=alert(1)>closeNetflix']);
});
test('DETAILS-PROVIDERS-006 the season-page fallback mounts on the visible page despite a hidden cached view', async t => {
  const html = '<div id="itemDetailPage" class="hide"><div class="detailSectionContent"><div class="streaming-lookup-container"></div></div></div>'
    + '<div id="itemDetailPage"><div class="detailSectionContent"><div class="itemExternalLinks"></div></div></div>';
  const items = { one: { Id: 'one', Type: 'Season', SeriesId: 'series', IndexNumber: 1 }, series: { Id: 'series', Type: 'Series', ProviderIds: { Tmdb: '9' } } };
  const h = elsewhereHarness(t, { html, getItem: async (_user, id) => items[id] ?? null,
    watch: { results: { GB: { link: 'https://www.justwatch.com/gb/s1', flatrate: [{ provider_id: 337, provider_name: 'Disney Plus', logo_path: '/d.png' }] } } } });
  await h.runIdle();
  const visible = h.document.querySelector('#itemDetailPage:not(.hide)');
  const panel = visible.querySelector('.streaming-lookup-container');
  assert.ok(panel, 'mounted on the visible season page');
  assert.match(panel.textContent, /Disney Plus/);
  assert.equal(h.document.querySelectorAll('.streaming-lookup-container').length, 2);
});

test('DETAILS-PROVIDERS-006 a hidden cached season view never receives the visible page\'s fallback panel', async t => {
  const html = '<div id="itemDetailPage" class="hide"><div class="detailSectionContent"></div></div>'
    + '<div id="itemDetailPage"><div class="detailSectionContent"><div class="itemExternalLinks"></div></div></div>';
  const items = { one: { Id: 'one', Type: 'Season', SeriesId: 'series', IndexNumber: 1 }, series: { Id: 'series', Type: 'Series', ProviderIds: { Tmdb: '9' } } };
  const h = elsewhereHarness(t, { html, getItem: async (_user, id) => items[id] ?? null });
  await h.runIdle();
  const [hidden, visible] = h.document.querySelectorAll('#itemDetailPage');
  assert.equal(hidden.querySelector('.streaming-lookup-container'), null);
  assert.ok(visible.querySelector('.streaming-lookup-container'));
});

// ── Media info chips ──────────────────────────────────────────────────────
test('DETAILS-PROVIDERS-001 the watch-progress toggle changes the clicked chip, not another view\'s', async t => {
  const h = createHarness({ html: '<div id="hidden" class="hide"></div><div id="visible"></div>', globals: { requestAnimationFrame: fn => { fn(); return 1; } },
    JE: { currentSettings: {}, t: key => key, saveUserSettings: async () => {}, core: { api: { plugin: async () => ({ progress: 50, totalPlaybackTicks: 600000000, totalRuntimeTicks: 1200000000 }) } } } });
  t.after(() => h.close());
  h.load('enhanced/itemdetails/features-details-media-info.js');
  const api = h.JE.internals.features;
  const crafted = 'id"] , body [x="';
  for (const id of ['hidden', 'visible']) api.displayWatchProgress(crafted, h.document.getElementById(id));
  await flush();
  const [hiddenChip, visibleChip] = h.document.querySelectorAll('.mediaInfoItem-watchProgress');
  visibleChip.click();
  assert.equal(visibleChip.querySelector('.mediaInfoItem-watchProgress-value').dataset.type, 'time');
  assert.equal(hiddenChip.querySelector('.mediaInfoItem-watchProgress-value').dataset.type, 'percentage');
});
test('media info: a non-numeric upstream progress or size is never markup', async t => {
  const h = createHarness({ html: '<div id="info"></div>', globals: { requestAnimationFrame: fn => { fn(); return 1; } },
    JE: { currentSettings: {}, t: key => key, core: { api: { plugin: async () => ({ progress: '<img src=x onerror=alert(1)>', size: '<b>9</b>' }) } } } });
  t.after(() => h.close());
  h.load('enhanced/itemdetails/features-details-media-info.js');
  const info = h.document.getElementById('info');
  h.JE.internals.features.displayWatchProgress('item', info);
  h.JE.internals.features.displayItemSize('item', info);
  await flush();
  assert.equal(info.querySelector('img[src="x"], b'), null);
  assert.match(info.textContent, /0%/);
  assert.match(info.textContent, /save -/);
});

// ── Details page dispatcher: hide button ─────────────────────────────────
test('details page: the Hide button offers hiding the whole show on an episode, with the item metadata', async t => {
  const views = [], debounced = {}, hidden = [], confirms = [];
  const items = { ep: { Id: 'ep', Type: 'Episode', SeriesId: 'show', SeriesName: 'Show', ParentIndexNumber: 2, IndexNumber: 5, ProviderIds: { Tmdb: '55' } },
    show: { Id: 'show', Type: 'Series', ProviderIds: { Tmdb: '99' } } };
  const h = createHarness({ url: 'http://jellyfin.test/web/index.html#!/details?id=ep',
    html: '<div id="itemDetailPage"><h1 class="itemName">Pilot</h1><div class="itemMiscInfo itemMiscInfo-primary"><div class="mediaInfoItem">2020</div></div><div class="detailButtons"><button class="btnMoreCommands"></button></div></div>',
    apiClient: { getItem: async (_user, id) => items[id] },
    JE: { t: key => key, currentSettings: {}, pluginConfig: {},
      hiddenContent: { getSettings: () => ({ enabled: true, showHideButtons: true }), isHidden: () => false, unhideItem() {},
        hideItem: item => hidden.push(item), confirmAndHide: (item, done, options) => confirms.push({ item, done, options }) },
      helpers: { debounce: (fn, wait) => { debounced[wait] = fn; return () => {}; }, createObserver() {}, onViewPage() {} },
      core: { navigation: { onViewPage: fn => views.push(fn), onNavigate() {} } } } });
  t.after(() => h.close());
  h.load('enhanced/itemdetails/features-details-page.js');
  debounced[100](); await flush(); // type lookup, then the re-run places the button
  const button = h.document.querySelector('.je-detail-hide-btn');
  assert.ok(button);
  assert.equal(button.nextElementSibling.className, 'btnMoreCommands', 'the overflow menu stays last');
  button.click(); await flush();
  assert.deepEqual(plain(confirms[0].item), { itemId: 'ep', name: 'Pilot', type: 'Episode', tmdbId: '55', seriesId: 'show', seriesName: 'Show', seasonNumber: 2, episodeNumber: 5 });
  assert.equal(confirms[0].options.showEpisodeChoice, true);
  await confirms[0].options.onChooseShow();
  assert.deepEqual(plain(hidden), [{ itemId: 'show', name: 'Show', type: 'Series', tmdbId: '99', posterPath: '' }]);
  assert.ok(button.classList.contains('je-already-hidden'));
});

// ── Arr links ─────────────────────────────────────────────────────────────
function arrHarness(t, { admin = true, plugin, config = {}, session } = {}) {
  let observe;
  const h = createHarness({ url: 'http://jellyfin.test/web/index.html#!/details?id=film',
    html: '<div id="itemDetailPage"><div class="itemExternalLinks"><a href="https://www.themoviedb.org/movie/603">TMDB</a></div></div>',
    apiClient: { getItem: async () => ({ Id: 'film', Type: 'Movie', Name: 'Film', ProviderIds: { Tmdb: '603' } }), serverAddress: () => 'http://jellyfin.test' },
    JE: { session, pluginConfig: { ArrLinksEnabled: true, ShowArrLinksAsText: true, ...config }, toast() {},
      cdn: { selfhst: path => `/cdn/${path}` }, core: { api: { plugin } },
      helpers: { isAdmin: () => admin, getExternalLinkIconSize: () => 20, createObserver: (_name, fn) => { observe = fn; return { disconnect() {} }; } } } });
  t.after(() => h.close());
  h.load('arr/arr-links.js');
  return { ...h, async scan() { observe(); await new Promise(done => h.window.setTimeout(done, 120)); await flush(); } };
}
test('arr links: one Radarr match is a plain link, several are a dropdown; non-admins get nothing', async t => {
  const one = arrHarness(t, { config: { RadarrInstances: [{ Name: 'Main', Url: 'http://radarr.lan/', Enabled: true }] },
    plugin: async path => { assert.equal(path, '/arr/movie-instances?tmdbId=603'); return { matches: [{ instanceName: 'Main', instanceUrl: 'http://radarr.lan/', hasFile: true, sizeOnDisk: 2147483648 }], errors: [] }; } });
  await one.JE.initializeArrLinksScript(); await one.scan();
  const link = one.document.querySelector('.arr-link');
  assert.equal(link.href, 'http://radarr.lan/movie/603');
  assert.equal(link.title, 'Main\nDownloaded\n2.0 GB');
  const many = arrHarness(t, { config: { RadarrInstances: [{ Name: 'A', Url: 'http://a/' }, { Name: 'B', Url: 'http://b/' }] },
    plugin: async () => ({ matches: [{ instanceName: 'A', instanceUrl: 'http://a', hasFile: true }, { instanceName: 'B', instanceUrl: 'http://b', hasFile: false }] }) });
  await many.JE.initializeArrLinksScript(); await many.scan();
  assert.deepEqual([...many.document.querySelectorAll('.arr-dropdown-item')].map(a => [a.href, a.textContent]), [['http://a/movie/603', 'ADownloaded'], ['http://b/movie/603', 'BMissing']]);
  const user = arrHarness(t, { admin: false, config: { RadarrUrl: 'http://radarr' }, plugin: async () => { throw new Error('not admin'); } });
  await user.JE.initializeArrLinksScript();
  assert.equal(user.document.querySelector('.arr-link'), null);
});
test('DETAILS-PROVIDERS-016 an admin lookup in flight across an account switch appends no links', async t => {
  const pending = deferred(); const { session, switchUser } = sessionStub();
  const h = arrHarness(t, { session, config: { RadarrInstances: [{ Name: 'Main', Url: 'http://radarr.lan' }] }, plugin: () => pending.promise });
  await h.JE.initializeArrLinksScript(); await h.scan();
  switchUser();
  pending.resolve({ matches: [{ instanceName: 'Main', instanceUrl: 'http://radarr.lan', hasFile: true }] });
  await flush();
  assert.equal(h.document.querySelector('.arr-link'), null);
});
test('arr links: instance errors toast once, escaped', async t => {
  const toasts = [];
  const h = arrHarness(t, { config: { RadarrInstances: [{ Name: 'Main', Url: 'http://radarr.lan' }] },
    plugin: async () => ({ matches: [], errors: [{ instanceName: '<b>Main</b>', reason: 'HTTP 401' }] }) });
  h.JE.toast = message => toasts.push(message);
  await h.JE.initializeArrLinksScript(); await h.scan();
  assert.deepEqual(toasts, ['⚠ Radarr instance "&lt;b&gt;Main&lt;/b&gt;" failed: HTTP 401']);
});

// ── Arr tag links ─────────────────────────────────────────────────────────
function tagHarness(t, getItem) {
  let view;
  const h = createHarness({ url: 'http://jellyfin.test/web/index.html#!/details?id=a', html: '<div id="itemDetailPage"><div class="itemExternalLinks"></div></div>',
    JE: { pluginConfig: { ArrTagsShowAsLinks: true, ArrTagsLinksHideFilter: 'hidden' }, icon: () => '<i></i>', IconName: { TAG: 'tag' },
      helpers: { getItemCached: getItem, debounce: fn => fn, createObserver() {} },
      core: { lifecycle: { register: () => ({ track: value => value }) }, navigation: { onNavigate() {}, onViewPage: fn => { view = fn; } } } } });
  t.after(() => h.close());
  h.load('arr/arr-tag-links.js');
  return { ...h, async check() { view(); await flush(); }, links: () => [...h.document.querySelectorAll('.arr-tag-link')].map(a => [a.dataset.itemId, a.textContent]) };
}
test('DETAILS-PROVIDERS-010 tag links return when Jellyfin re-renders the row for the same item', async t => {
  let lookups = 0;
  const h = tagHarness(t, async () => { lookups++; return { Tags: ['JE Arr Tag: anime', 'JE Arr Tag: hidden', 'Other'] }; });
  await h.JE.initializeArrTagLinksScript(); await h.check();
  assert.deepEqual(h.links(), [['a', 'JE Arr Tag: anime']]);
  assert.match(h.document.querySelector('.arr-tag-link').getAttribute('href'), /^#!\/list\.html\?type=tag&tag=JE%20Arr%20Tag%3A%20anime&serverId=server-a$/);
  await h.check();
  assert.equal(h.links().length, 1, 'no duplicate on a repeat scan');
  h.document.querySelector('.itemExternalLinks').replaceChildren();
  await h.check();
  assert.deepEqual(h.links(), [['a', 'JE Arr Tag: anime']]);
  assert.equal(lookups, 2);
});
test('DETAILS-PROVIDERS-010 a pending tag lookup cannot decorate the next item; the dropped scan runs after it', async t => {
  const first = deferred();
  const h = tagHarness(t, id => id === 'a' ? first.promise : Promise.resolve({ Tags: ['JE Arr Tag: b-tag'] }));
  await h.JE.initializeArrTagLinksScript(); await h.check();
  h.window.history.replaceState({}, '', '#!/details?id=b');
  await h.check(); // dropped while a's lookup runs
  first.resolve({ Tags: ['JE Arr Tag: a-tag'] }); await flush();
  assert.deepEqual(h.links(), [['b', 'JE Arr Tag: b-tag']]);
});

// ── Letterboxd ────────────────────────────────────────────────────────────
test('DETAILS-PROVIDERS-011 a Letterboxd scan dropped while a stale lookup ran is retried for the current item', async t => {
  const idle = [], views = [], first = deferred();
  const h = createHarness({ url: 'http://jellyfin.test/web/#!/details?id=one', html: '<div id="itemDetailPage"><div class="itemExternalLinks"></div></div>', globals: { requestIdleCallback: fn => idle.push(fn) },
    JE: { pluginConfig: { LetterboxdEnabled: true, ShowLetterboxdLinkAsText: true }, cdn: { selfhst: path => `/cdn/${path}` },
      helpers: { getItemCached: id => id === 'one' ? first.promise : Promise.resolve({ Type: 'Movie', ProviderIds: { Imdb: 'tt2' } }), getExternalLinkIconSize: () => 25,
        createObserver: () => ({ disconnect() {} }), onViewPage: fn => views.push(fn) } } });
  t.after(() => h.close());
  h.load('others/letterboxd-links.js'); await h.JE.initializeLetterboxdLinksScript();
  const stale = idle.shift()(); // item one's lookup is now pending
  // Jellyfin shows item two in the same view; its scan arrives while one's lookup runs.
  h.window.history.replaceState({}, '', '#!/details?id=two');
  views[0](); idle.shift()();
  first.resolve({ Type: 'Movie', ProviderIds: { Imdb: 'tt1' } }); await stale;
  assert.equal(h.document.querySelector('.letterboxd-link'), null, 'the stale answer adds nothing');
  assert.equal(idle.length, 1, 'the dropped scan is scheduled again');
  idle.shift()(); await flush();
  assert.equal(h.document.querySelector('.letterboxd-link').href, 'https://letterboxd.com/imdb/tt2');
});

// ── Colored ratings ───────────────────────────────────────────────────────
test('colored ratings normalize official ratings and decorate the details rating box', async t => {
  const h = createHarness({ html: '<div class="mediaInfoOfficialRating">DE-12</div><div class="mediaInfoOfficialRating" title="kept">Not Rated</div>',
    JE: { pluginConfig: { ColoredRatingsEnabled: true }, cdn: { url: (source, file) => `/cdn/${source}/${file}` }, helpers: { createObserver: () => ({ disconnect() {} }) } } });
  t.after(() => h.close());
  h.load('extras/colored-ratings.js');
  const normalize = h.JE.normalizeOfficialRating;
  assert.deepEqual(['fsk 16', ' PG-13 ', 'unrated', 'constructor', ''].map(normalize), ['FSK-16', 'PG-13', 'NR', 'constructor', '']);
  h.JE.initializeColoredRatings();
  const [fsk, nr] = h.document.querySelectorAll('.mediaInfoOfficialRating');
  assert.equal(h.document.getElementById('jellyfin-ratings-style').getAttribute('href'), '/cdn/je-css/ratings.css');
  assert.deepEqual([fsk.getAttribute('rating'), fsk.textContent, fsk.getAttribute('aria-label'), fsk.title], ['FSK-12', 'FSK-12', 'Content rated FSK-12', 'Rating: FSK-12']);
  assert.deepEqual([nr.getAttribute('rating'), nr.textContent, nr.title], ['NR', 'Not Rated', 'kept']);
  assert.equal(typeof h.JE.pauseRatingsPolling, 'function');
  h.JE.resumeRatingsPolling();
});
test('colored ratings still load in the poster-parity sandbox (minimal VM globals)', () => {
  const JE = { pluginConfig: {}, cdn: { url: (a, b) => `cdn/${a}/${b}` }, helpers: {} };
  const context = { console: { log() {}, warn() {}, error() {} }, JellyfinEnhanced: JE,
    document: { visibilityState: 'visible', addEventListener() {}, getElementById: () => null, querySelectorAll: () => [] },
    MutationObserver: class { observe() {} disconnect() {} }, setTimeout, clearTimeout, WeakSet, Map, Set, Object, String, RegExp, Boolean, addEventListener() {} };
  context.window = context;
  vm.createContext(context);
  const source = readFileSync(resolve(jsRoot, 'extras/colored-ratings.js'), 'utf8');
  // As web-expected.mjs does: the shared modules other scripts publish in the bundle (canopy K1b).
  provideSharedRuntime(code => vm.runInContext(code, context), source, 'extras/colored-ratings.js');
  vm.runInContext(source, context, { filename: 'colored-ratings.js' });
  assert.equal(JE.normalizeOfficialRating('FSK 0'), 'FSK-0');
});

// ── Random button ─────────────────────────────────────────────────────────
test('DETAILS-PROVIDERS-015 a random pick made for the previous account is not opened', async t => {
  const pending = deferred(), toasts = [], { session, switchUser } = sessionStub();
  const h = createHarness({ html: '<div id="tray"></div>', apiClient: { ajax: () => pending.promise },
    JE: { session, currentSettings: { randomButtonEnabled: true, randomIncludeMovies: true }, t: key => key, toast: text => toasts.push(text), icon: () => '!', IconName: { ERROR: 'e' }, escapeHtml, helpers: {} } });
  t.after(() => h.close());
  h.JE.helpers.getHeaderButtonTray = () => h.document.getElementById('tray');
  h.load('enhanced/features-random-button.js'); h.JE.addRandomButton();
  h.document.getElementById('randomItemButton').click();
  switchUser();
  pending.resolve({ Items: [{ Id: 'old-account-item', Type: 'Movie' }] }); await flush();
  assert.doesNotMatch(h.window.location.hash, /old-account-item/);
  assert.deepEqual(toasts, []);
});
test('random button: a failure toast shows the error message as text', async t => {
  const toasts = [];
  const h = createHarness({ html: '<div id="tray"></div>', apiClient: { ajax: async () => { throw new Error('<img src=x onerror=alert(1)>'); } },
    JE: { currentSettings: { randomButtonEnabled: true, randomIncludeShows: true }, t: key => key, toast: text => toasts.push(text), icon: () => '!', IconName: { ERROR: 'e' }, escapeHtml, helpers: {} } });
  t.after(() => h.close());
  h.expectConsoleError(/Error fetching random item/);
  h.JE.helpers.getHeaderButtonTray = () => h.document.getElementById('tray');
  h.load('enhanced/features-random-button.js'); h.JE.addRandomButton();
  h.document.getElementById('randomItemButton').click(); await flush();
  assert.deepEqual(toasts, ['! &lt;img src=x onerror=alert(1)&gt;']);
});

// ── Release dates (decoding of the prefetch item) ────────────────────────
test('release dates: a details visit hands the raw item to the prefetch, which decodes it', async t => {
  const fetched = [];
  const h = createHarness({ html: '<div id="info"></div>', fetch: async url => { fetched.push(String(url)); return jsonResponse({ next_episode_to_air: { air_date: '2030-01-02' } }); },
    globals: { requestAnimationFrame: fn => { fn(); return 1; } }, JE: { pluginConfig: {}, t: key => key, helpers: { addCSS() {} } } });
  t.after(() => h.close());
  h.load('enhanced/itemdetails/features-release-dates.js');
  h.JE.internals.features.prefetchReleaseDate('show', { Type: 'Series', ProviderIds: { Tmdb: 12 }, MediaSources: 'not-a-list' }, {});
  h.JE.internals.features.displayReleaseDate('show', h.document.getElementById('info')); await flush();
  assert.deepEqual(fetched, ['http://jellyfin.test/JellyfinEnhanced/tmdb/tv/12']);
  assert.equal(h.document.querySelectorAll('.je-release-date-episode').length, 1);
});


// Independent-review remediation: exercise public controls in emitted scripts.
function dispatcherHarness(t,getItem){
 const debounced={},confirms=[],hidden=[];const stub=sessionStub();
 let user='user-a',token='token-a';
 const h=createHarness({url:'http://jellyfin.test/web/index.html#!/details?id=ep',
 html:'<div id="itemDetailPage"><h1 class="itemName">Pilot</h1><div class="itemMiscInfo itemMiscInfo-primary"><div class="mediaInfoItem">2020</div></div><div class="detailButtons"><button class="btnMoreCommands"></button></div></div>',
 apiClient:{getCurrentUserId:()=>user,accessToken:()=>token,getItem},
 JE:{session:stub.session,t:k=>k,currentSettings:{},pluginConfig:{},
 hiddenContent:{getSettings:()=>({enabled:true,showHideButtons:true}),isHidden:()=>false,unhideItem(){},hideItem:item=>hidden.push(item),confirmAndHide:(item,done,options)=>confirms.push({item,done,options})},
 helpers:{debounce:(fn,wait)=>{debounced[wait]=fn;return()=>{};},createObserver(){},onViewPage(){}},
 core:{navigation:{onViewPage(){},onNavigate(){}}}}});
 t.after(()=>h.close());h.load('enhanced/itemdetails/features-details-page.js');
 return {...h,confirms,hidden,scan:()=>debounced[100](),change(){user='user-b';stub.switchUser();},changeToken(){token='token-b';}};
}
const episode={Id:'ep',Type:'Episode',SeriesId:'show',SeriesName:'Show',ProviderIds:{Tmdb:'55'}};
for(const value of [null,{Id:'ep'}])test('R2 providers: absent item metadata does not self-retry ('+JSON.stringify(value)+')',async t=>{
 let calls=0,reply=value;const cap=deferred();
 const h=dispatcherHarness(t,async()=>++calls>=8?cap.promise:reply);h.scan();await flush();
 assert.equal(calls,1,'one lifecycle trigger makes one lookup');
 reply=episode;h.scan();await flush();assert.equal(calls,2);assert.ok(h.document.querySelector('.je-detail-hide-btn'),'later lifecycle trigger can recover');
});
test('R2 providers: a Hide click awaiting metadata cannot open a dialog under the incoming account',async t=>{
 const pending=deferred();let calls=0;const h=dispatcherHarness(t,async()=>++calls===1?episode:pending.promise);
 h.scan();await flush();h.document.querySelector('.je-detail-hide-btn').click();await flush();h.change();pending.resolve(episode);await flush();
 assert.deepEqual(h.confirms,[]);assert.deepEqual(h.hidden,[]);
});
test('R2 providers: delayed episode choice cannot hide a show under the incoming account',async t=>{
 const pending=deferred();const h=dispatcherHarness(t,async(_u,id)=>id==='show'?pending.promise:episode);
 h.scan();await flush();h.document.querySelector('.je-detail-hide-btn').click();await flush();assert.equal(h.confirms.length,1);
 const choice=h.confirms[0].options.onChooseShow();await flush();h.change();pending.resolve({Id:'show',Type:'Series',ProviderIds:{Tmdb:'99'}});await choice;
 assert.deepEqual(h.hidden,[]);
});
test('R2 providers: a silently replaced token cannot reuse an old Hide button',async t=>{
 let calls=0;const h=dispatcherHarness(t,async()=>{calls++;return episode;});h.scan();await flush();const before=calls;
 h.changeToken();h.document.querySelector('.je-detail-hide-btn').click();await flush();assert.equal(calls,before);assert.deepEqual(h.confirms,[]);
});
test('R2 providers: DDD failed POST retains its draft and acknowledged picks until retry succeeds',async t=>{
 const h=dddHarness(t,{triggers:()=>({Triggers:[1]})});await h.show();await flush();
 h.load('enhanced/config.js');h.JE.userConfig={settings:{},shortcuts:{Shortcuts:[]}};h.JE.currentSettings=h.JE.loadSettings();
 let fail=true;const stored={Triggers:[1]},posts=[];
 h.window.ApiClient.ajax=async req=>{if(req.type!=='POST')return stored;posts.push(JSON.parse(req.data));if(fail)throw Error('storage error');stored.Triggers=JSON.parse(req.data).Triggers;return {};};
 await h.openPicker();const boxes=[...h.document.querySelectorAll('.je-ddd-row input')];boxes[0].checked=true;boxes[0].dispatchEvent(new h.window.Event('change'));boxes[1].checked=false;boxes[1].dispatchEvent(new h.window.Event('change'));
 h.document.querySelector('.je-ddd-save').click();await flush();
 assert.ok(h.document.querySelector('.je-ddd-modal'));assert.match(h.document.querySelector('.je-ddd-save-error').textContent,/Could not save/);assert.deepEqual(stored.Triggers,[1]);
 assert.equal(h.document.querySelector('.je-ddd-save').disabled,false);assert.equal(h.document.querySelector('.je-ddd-sum').textContent,'ddd_summary_mine:{"hits":1,"total":1}');
 h.document.querySelector('.je-ddd-modal').remove();await h.openPicker();assert.deepEqual(h.checked(),[false,true],'reopened form starts from acknowledged picks');
 const retry=[...h.document.querySelectorAll('.je-ddd-row input')];retry[0].checked=true;retry[0].dispatchEvent(new h.window.Event('change'));retry[1].checked=false;retry[1].dispatchEvent(new h.window.Event('change'));
 fail=false;h.document.querySelector('.je-ddd-save').click();await flush();
 assert.equal(h.document.querySelector('.je-ddd-modal'),null);assert.deepEqual(stored.Triggers,[2]);assert.equal(posts.length,2);
});
test('R2 providers: Elsewhere requires a successful settings read before exposing Save',async t=>{
 const h=elsewhereHarness(t);await h.runIdle();const load=deferred();h.window.ApiClient.ajax=()=>load.promise;
 h.document.querySelector('.elsewhere-settings-button').click();await flush();const modal=h.document.getElementById('streaming-settings-modal');
 assert.equal(modal.querySelector('#save-settings'),null);load.reject(Error('offline'));await flush();assert.equal(modal.querySelector('#save-settings'),null);assert.match(modal.textContent,/could not be loaded/);
 h.window.ApiClient.ajax=async()=>({Region:'US',Regions:[],Services:['Hulu'],SeasonProviders:false,Future:{keep:'exact'}});
 [...modal.querySelectorAll('button')].find(b=>b.textContent==='Retry').click();await flush();
 assert.equal(modal.querySelector('#region-select').value,'US');modal.querySelector('#save-settings').click();await flush();
 assert.equal(h.saved.length,1);assert.equal(h.saved[0][1].Future.keep,'exact');
});
test('R2 providers: a stale Elsewhere read cannot reopen a form after incoming data',async t=>{
 const h=elsewhereHarness(t);await h.runIdle();const load=deferred();h.window.ApiClient.ajax=()=>load.promise;
 h.document.querySelector('.elsewhere-settings-button').click();await flush();
 h.JE.userConfig.elsewhere={Region:'US',Services:[],Regions:[],SeasonProviders:false};h.document.dispatchEvent(new h.window.CustomEvent('je:user-data-loaded'));
 load.resolve({Region:'GB',Services:['Netflix'],Regions:[],SeasonProviders:true});await flush();
 const modal=h.document.getElementById('streaming-settings-modal');assert.equal(modal.style.display,'none');assert.equal(modal.querySelector('#save-settings'),null);assert.deepEqual(h.saved,[]);
});
test('R2 providers: incoming Elsewhere preferences rebuild the already mounted provider panel',async t=>{
 const provider=name=>({provider_id:1,provider_name:name,logo_path:'/x.png'});
 const h=elsewhereHarness(t,{watch:{results:{GB:{link:'https://example.test/gb',flatrate:[provider('Netflix')]},US:{link:'https://example.test/us',flatrate:[provider('Hulu')]}}}});
 await h.runIdle();assert.match(h.document.querySelector('.streaming-lookup-container').textContent,/Netflix/);
 h.switchUser();assert.equal(h.document.querySelector('.streaming-lookup-container'),null);
 h.JE.userConfig.elsewhere={Region:'US',Services:['Hulu'],Regions:[],SeasonProviders:false};h.document.dispatchEvent(new h.window.CustomEvent('je:user-data-loaded'));await h.runIdle();
 const current=h.document.querySelector('.streaming-lookup-container');assert.match(current.textContent,/Hulu/);assert.doesNotMatch(current.textContent,/Netflix/);
});
test('R2 providers: failed Elsewhere POST preserves saved preferences and allows a retry',async t=>{
 const h=elsewhereHarness(t);await h.runIdle();h.load('enhanced/config.js');h.JE.currentSettings=h.JE.loadSettings();const stored={...h.JE.userConfig.elsewhere};let fail=true;
 h.window.ApiClient.ajax=async req=>{if(req.type!=='POST')return stored;if(fail)throw Error('storage error');Object.assign(stored,JSON.parse(req.data));return {};};
 h.document.querySelector('.elsewhere-settings-button').click();await flush();const modal=h.document.getElementById('streaming-settings-modal');
 modal.querySelector('#region-select').value='US';modal.querySelector('#save-settings').click();await flush();
 assert.equal(modal.style.display,'flex');assert.match(modal.querySelector('.je-elsewhere-save-error').textContent,/Could not save/);
 assert.equal(stored.Region,'GB');assert.equal(h.JE.userConfig.elsewhere.Region,'GB');assert.equal(modal.querySelector('#save-settings').disabled,false);
 fail=false;modal.querySelector('#save-settings').click();await flush();assert.equal(stored.Region,'US');assert.equal(h.JE.userConfig.elsewhere.Region,'US');assert.equal(modal.style.display,'none');
});
function renderedReviewHarness(t,extra={}){
 const stub=sessionStub();let guarded=false;
 const h=detailsHarness(t,{getItem:async(_u,id)=>movie(id,id==='one'?'7':'8'),
 JE:{session:stub.session,pluginConfig:{ShowUserReviews:true,SpoilerBlurEnabled:true},spoilerBlur:{whenLoaded:async()=>{},isLoadOk:()=>true,getUserPrefs:()=>({HideReviews:true}),isMovieInScope:async()=>guarded},
 core:{api:{plugin:async path=>({reviews:[{userId:'x',userName:'Reviewer',content:'Review of '+path}]}),fetch:async()=>({results:[]})}},...extra}});
 h.load('elsewhere/reviews.js');h.JE.initializeReviewsScript();
 return {...h,switchUser:stub.switchUser,guard:()=>{guarded=true;}};
}
test('R2 providers: a reused detail page replaces already-rendered reviews for its new item',async t=>{
 const h=renderedReviewHarness(t);await h.show();await flush();assert.match(h.page().textContent,/reviews\/movie\/7/);
 h.route('two');await h.show();await flush();assert.match(h.page().textContent,/reviews\/movie\/8/);assert.doesNotMatch(h.page().textContent,/reviews\/movie\/7/);
});
test('R2 providers: account reset removes already-rendered review content synchronously',async t=>{
 const h=renderedReviewHarness(t);await h.show();await flush();assert.ok(h.document.querySelector('.tmdb-reviews-section'));h.switchUser();assert.equal(h.document.querySelector('.tmdb-reviews-section'),null);
});
test('R2 providers: a rendered review section cannot bypass newly applied spoiler policy',async t=>{
 const h=renderedReviewHarness(t);await h.show();await flush();assert.ok(h.document.querySelector('.tmdb-reviews-section'));h.guard();await h.show();await flush();assert.equal(h.document.querySelector('.tmdb-reviews-section'),null);
});
test('R2 providers: review URLs preserve underscores while emphasis and safe markup still work',async t=>{
 const text='[**My review**](https://example.test/a_b_c?q=x_y_z) https://example.test/plain_a_b. **bold** _italic_ '+String.fromCharCode(96)+'_code_'+String.fromCharCode(96)+' [bad](javascript:alert(1))';
 const h=detailsHarness(t,{getItem:async()=>movie('one'),JE:{pluginConfig:{ShowReviews:true,TmdbEnabled:true},core:{api:{plugin:async()=>({reviews:[]}),fetch:async()=>({results:[{author:'A',content:text,author_details:{rating:8}}]})}}}});
 h.load('elsewhere/reviews.js');h.JE.initializeReviewsScript();await h.show();await flush();
 const content=h.document.querySelector('.tmdb-review-text');assert.ok(content);
 const links=[...content.querySelectorAll('a')];assert.deepEqual(links.map(a=>a.getAttribute('href')),['https://example.test/a_b_c?q=x_y_z','https://example.test/plain_a_b']);
 assert.equal(links[0].querySelector('strong').textContent,'My review');assert.ok([...content.querySelectorAll('strong')].some(n=>n.textContent==='bold'));assert.ok([...content.querySelectorAll('em')].some(n=>n.textContent==='italic'));assert.equal(content.querySelector('code').textContent,'_code_');assert.equal(content.querySelector('[href^="javascript:"]'),null);
});

for(const change of ['account','navigation'])test('R2 providers: pending review delete confirmation is cancelled on '+change,async t=>{
 const stub=sessionStub(),mutations=[];let confirm,user='user-a';
 const h=detailsHarness(t,{getItem:async()=>movie('one'),apiClient:{getCurrentUserId:()=>user},JE:{session:stub.session,pluginConfig:{ShowUserReviews:true},
 core:{api:{plugin:async(path,options)=>{if(options?.method)mutations.push({path,user,method:options.method});return {reviews:[{userId:'user-a',userName:'Mine',content:'My review'}]};}}}}});
 h.window.Dashboard={confirm:(_body,_title,done)=>{confirm=done;}};
 h.load('elsewhere/reviews.js');h.JE.initializeReviewsScript();await h.show();await flush();
 h.document.querySelector('.je-review-delete-btn').click();await flush();assert.equal(typeof confirm,'function');
 if(change==='account'){user='user-b';stub.switchUser();}else h.route('two');
 confirm(true);await flush();assert.deepEqual(mutations,[],'old confirmation cannot authorize a new-session/item mutation');
});
test('R2 providers: account reset removes the old average review rating as well as the section',async t=>{
 const stub=sessionStub();const h=detailsHarness(t,{html:'<div class="mediaInfoItems"></div><div class="tagline"></div>',getItem:async()=>movie('one'),JE:{session:stub.session,pluginConfig:{ShowUserReviews:true},core:{api:{plugin:async()=>({reviews:[{userId:'x',userName:'Reviewer',content:'A review',rating:5}]})}}}});
 h.load('elsewhere/reviews.js');h.JE.initializeReviewsScript();await h.show();await flush();assert.ok(h.document.querySelector('.je-avg-user-rating-chip'));
 stub.switchUser();assert.equal(h.document.querySelector('.je-avg-user-rating-chip'),null);assert.equal(h.document.querySelector('.tmdb-reviews-section'),null);
});
