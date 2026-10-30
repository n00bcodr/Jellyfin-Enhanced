import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

const MOVIE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const SERIES = 'cccccccccccccccccccccccccccccccc';
const EPISODE = 'dddddddddddddddddddddddddddddddd';
const SEASON = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const MOVIES_LIB = '11111111111111111111111111111111';
const KIDS_LIB = '22222222222222222222222222222222';

/** Jellyfin 12 Modern card. */
const card = (id, type = 'Movie') => `<div class="card overflowPortraitCard" data-id="${id}" data-type="${type}"><div class="cardBox cardBox-bottompadded"><div class="cardScalable"><div class="cardPadder"></div><a class="cardImageContainer coveredImage cardContent" style="background-image:url(&quot;http://jellyfin.test/Items/${id}/Images/Primary&quot;)"></a><div class="je-tag-host"></div><div class="cardOverlayContainer"></div></div><div class="cardText cardText-first">Title</div></div></div>`;

/** A tag-cache entry with quality, rating, age rating and genres. */
function entry(overrides = {}) {
  return {
    Type: 'Movie', Genres: ['Drama', 'Animation'], CommunityRating: 8.1, OfficialRating: 'PG-13', LibraryId: MOVIES_LIB,
    StreamData: { Streams: [{ Type: 'Video', Codec: 'hevc', Height: 2160, VideoRangeType: 'HDR10', DisplayTitle: '4K HEVC HDR10' }], Sources: [], ItemName: 'Movie', ItemPath: 'm.mkv' },
    ...overrides,
  };
}

/**
 * The real renderers, layout controller and tag look module over a page of
 * cards, rendering through the pipeline's server-cache path
 * (setCardContext, then every enabled renderer).
 */
function setup(t, { html = card(MOVIE), settings = {}, plugin = {}, withLook = true } = {}) {
  const renderers = new Map();
  const writes = [];
  const toasts = [];
  let renderCalls = 0;
  const h = createHarness({
    html,
    JE: {
      currentSettings: {
        qualityTagsEnabled: true, ratingTagsEnabled: true, ageRatingTagsEnabled: true, genreTagsEnabled: true,
        qualityTagsPreferredAudioLanguage: 'none', tagLayoutSettingsVersion: 1, ...settings,
      },
      pluginConfig: { TagCacheServerMode: true, ...plugin },
      t: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key,
      cdn: { flagSvg: code => `http://jellyfin.test/flags/${code}.svg` },
      session: { getUserId: () => 'a', getServerId: () => 's', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} },
      saveUserSettings: (file, doc) => { writes.push(plain(doc)); return Promise.resolve(); },
      tagPipeline: {
        registerRenderer: (name, r) => renderers.set(name, r), getRenderer: name => renderers.get(name),
        clearProcessed() {}, scheduleScan() {}, peekReviewRatings: () => null, getReviewRatingsRequestedAt: () => 0,
        getReviewRatings: async () => null, onReviewRatingsChanged() {},
      },
    },
  });
  t.after(() => h.close());
  const files = ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js'];
  if (withLook) files.push('core/tag-look.js');
  files.push('tags/tag-layout-styles.js', 'tags/qualitytags.js', 'tags/genretags.js', 'tags/ratingtags.js', 'tags/ageratingtags.js');
  for (const file of files) h.load(file);
  const JE = h.JE;
  JE.toast = message => toasts.push(message);
  JE.initializeQualityTags(); JE.initializeGenreTags(); JE.initializeRatingTags(); JE.initializeAgeRatingTags();
  const layout = JE.core.tagLayout;
  const hostOf = id => h.document.querySelector(`[data-id="${id}"] .je-tag-host`);
  return Object.assign(h, {
    layout, look: JE.core.tagLook, writes, toasts, hostOf,
    get renderCalls() { return renderCalls; },
    /** Render an entry into a card the way the pipeline's server-cache path does. */
    render(id = MOVIE, e = entry()) {
      const target = hostOf(id);
      layout.setCardContext(target, e, id);
      for (const [, r] of renderers) if (r.isEnabled() && r.renderFromServerCache) { renderCalls++; r.renderFromServerCache(target, e, id); }
      return target;
    },
    /** Layout the card is presented in. */
    layoutOf: id => hostOf(id).dataset.jeLayout,
    async settle() { await JE.reinitializeTagLayout(); },
  });
}

const rule = (when, layout, density = 'full', extra = {}) => ({ id: `r${Math.abs(JSON.stringify(when).split('').reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7))}`, enabled: true, when, layout, density, ...extra });

test('with no rules and no locks every card follows the default exactly as before rules existed', t => {
  const without = setup(t, { withLook: false, settings: { tagLayout: 'bands' } });
  without.render();
  const withLook = setup(t, { settings: { tagLayout: 'bands', tagLookRules: [], tagLayoutLocks: null } });
  withLook.render();
  assert.equal(withLook.hostOf(MOVIE).outerHTML, without.hostOf(MOVIE).outerHTML);
  const conf = withLook.layout.resolveLayout(withLook.hostOf(MOVIE));
  assert.equal(conf, withLook.layout.resolveLayout(withLook.hostOf(OTHER)), 'every card gets the one memoised default');
  assert.equal(conf.locked, false);
  assert.equal(withLook.hostOf(MOVIE).dataset.jeLocked, undefined);
});

test('a lock beats a matching rule, which beats the default; unlocking restores the rule, then the default', async t => {
  const h = setup(t, { settings: { tagLayout: 'corners', tagLookRules: [rule([{ field: 'library', value: MOVIES_LIB }], 'caption', 'compact')] } });
  h.render();
  assert.equal(h.layoutOf(MOVIE), 'caption', 'library rule');
  assert.ok(h.document.querySelector('.je-tag-caption'), 'caption outlet placed');

  await h.look.lockItem(MOVIE, { layout: 'minimal', density: 'full' });
  await h.settle();
  assert.equal(h.layoutOf(MOVIE), 'minimal', 'lock wins');
  assert.equal(h.hostOf(MOVIE).dataset.jeLocked, '1');
  assert.equal(h.document.querySelector('.je-tag-caption'), null, 'the rule\'s outlet is gone');

  await h.look.unlockItems([MOVIE]);
  await h.settle();
  assert.equal(h.layoutOf(MOVIE), 'caption', 'back to the rule');
  assert.equal(h.hostOf(MOVIE).dataset.jeLocked, undefined);

  await h.look.saveRules([]);
  await h.settle();
  assert.equal(h.layoutOf(MOVIE), 'corners', 'back to the default');
  assert.deepEqual(h.writes.at(-1).tagLookRules, []);
});

test('rules match library, type, genre and age rating, ANDed, first enabled match wins', async t => {
  const html = card(MOVIE) + card(OTHER) + card(EPISODE, 'Episode');
  const h = setup(t, { html, settings: { tagLayout: 'corners' } });
  const cases = [
    [[{ field: 'library', value: KIDS_LIB }], 'bands', OTHER],
    [[{ field: 'type', value: 'episode' }], 'bands', EPISODE],
    [[{ field: 'genre', value: 'ANIMATION' }], 'bands', MOVIE],
    [[{ field: 'ageRating', value: ' tv-ma ' }], 'bands', OTHER],
  ];
  for (const [when, layout, expected] of cases) {
    h.JE.currentSettings.tagLookRules = [rule(when, layout)];
    h.layout.invalidateSettings();
    h.render(MOVIE, entry());
    h.render(OTHER, entry({ Genres: ['Comedy'], OfficialRating: 'TV-MA', LibraryId: KIDS_LIB }));
    h.render(EPISODE, entry({ Type: 'Episode', Genres: [], OfficialRating: 'PG', LibraryId: KIDS_LIB.replace(/2/g, '3') }));
    await h.settle();
    for (const id of [MOVIE, OTHER, EPISODE]) {
      assert.equal(h.layoutOf(id), id === expected ? layout : 'corners', `${JSON.stringify(when)} on ${id}`);
    }
  }

  // AND: both must hold; a disabled first rule is skipped; invalid rules ignored.
  h.JE.currentSettings.tagLookRules = [
    { id: 'off', enabled: false, when: [{ field: 'type', value: 'Movie' }], layout: 'summary', density: 'full' },
    { id: 'junk-layout', enabled: true, when: [{ field: 'type', value: 'Movie' }], layout: 'grid', density: 'full' },
    { id: 'no-when', enabled: true, when: [], layout: 'summary', density: 'full' },
    { id: 'bad-field', enabled: true, when: [{ field: 'mood', value: 'x' }], layout: 'summary', density: 'full' },
    rule([{ field: 'type', value: 'Movie' }, { field: 'library', value: KIDS_LIB }], 'minimal'),
    rule([{ field: 'type', value: 'Movie' }], 'caption'),
  ];
  await h.settle();
  assert.equal(h.layoutOf(OTHER), 'minimal', 'both conditions hold');
  assert.equal(h.layoutOf(MOVIE), 'caption', 'only the type holds: the next rule');
  assert.equal(h.layoutOf(EPISODE), 'corners');
});

test('the card type wins over the fetched entry (an episode card showing series artwork)', async t => {
  const h = setup(t, { html: card(EPISODE, 'Episode'), settings: { tagLookRules: [rule([{ field: 'type', value: 'Series' }], 'bands')] } });
  h.render(EPISODE, entry({ Type: 'Series' }));
  assert.equal(h.layoutOf(EPISODE), 'corners');
  h.JE.currentSettings.tagLookRules = [rule([{ field: 'type', value: 'Episode' }], 'bands')];
  await h.settle();
  assert.equal(h.layoutOf(EPISODE), 'bands');
});

test('a series lock is inherited by its season and episode cards; their own lock wins', async t => {
  const html = card(SERIES, 'Series') + card(SEASON, 'Season') + card(EPISODE, 'Episode') + card(OTHER, 'Episode');
  const h = setup(t, { html });
  h.render(SERIES, entry({ Type: 'Series' }));
  h.render(SEASON, entry({ Type: 'Season', SeriesId: SERIES }));
  h.render(EPISODE, entry({ Type: 'Episode', SeriesId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }));
  h.render(OTHER, entry({ Type: 'Episode', SeriesId: OTHER }));
  await h.look.lockItem(SERIES, { layout: 'bands', density: 'compact' });
  await h.settle();
  assert.deepEqual([SERIES, SEASON, EPISODE, OTHER].map(h.layoutOf), ['bands', 'bands', 'bands', 'corners']);
  await h.look.lockItem(EPISODE, { layout: 'summary', density: 'full' });
  await h.settle();
  assert.equal(h.layoutOf(EPISODE), 'summary');
});

test('a lock keeps the slot profile it was locked with when the profile is edited later', async t => {
  const h = setup(t, { settings: { tagLayout: 'bands' } });
  h.render();
  const conf = h.layout.resolveLayout(h.hostOf(MOVIE));
  await h.look.lockItem(MOVIE, { layout: conf.layout, density: conf.density, slots: conf.slots });
  const saved = h.writes.at(-1).tagLayoutLocks[MOVIE];
  assert.equal(saved.layout, 'bands');
  assert.ok(saved.slots.some(s => s.group === 'quality' && s.slot === 'bottom'), 'whole profile stored as [{group, slot}]');

  h.JE.currentSettings.tagLayouts = { bands: { groups: [{ group: 'quality', slot: 'top' }] } };
  h.JE.currentSettings.tagLayout = 'caption';
  await h.settle();
  assert.equal(h.layoutOf(MOVIE), 'bands');
  assert.ok(h.hostOf(MOVIE).querySelector('.je-tag-slot[data-je-slot="bottom"] [data-je-group="quality"]'), 'quality stays at the bottom');
  assert.equal(h.hostOf(MOVIE).querySelector('.je-tag-slot[data-je-slot="top"] [data-je-group="quality"]'), null);
});

test('rule slot overrides are honoured for the rule\'s layout', async t => {
  const h = setup(t, { settings: { tagLookRules: [rule([{ field: 'type', value: 'Movie' }], 'bands', 'full', { slots: [{ Group: 'quality', Slot: 'top' }] })] } });
  h.render();
  assert.ok(h.hostOf(MOVIE).querySelector('.je-tag-slot[data-je-slot="top"] [data-je-group="quality"]'));
});

test('locks are capped at 500, the oldest dropped first', async t => {
  const h = setup(t);
  const locks = {};
  for (let i = 0; i < 500; i++) locks[i.toString(16).padStart(32, '0')] = { layout: 'bands', density: 'full', lockedAt: 1000 + i };
  h.JE.currentSettings.tagLayoutLocks = locks;
  await h.look.lockItem(MOVIE, { layout: 'caption', density: 'full' });
  const saved = h.writes.at(-1).tagLayoutLocks;
  assert.equal(Object.keys(saved).length, 500);
  assert.ok(saved[MOVIE], 'the new lock is kept');
  assert.equal(saved['0'.padStart(32, '0')], undefined, 'the oldest went');
  assert.ok(saved['1'.padStart(32, '0')]);
});

test('rule and lock changes re-present the cards without refetching or re-rendering', async t => {
  const h = setup(t);
  h.render();
  const calls = h.renderCalls;
  await h.look.saveRules([rule([{ field: 'genre', value: 'drama' }], 'summary')]);
  await h.settle();
  assert.equal(h.layoutOf(MOVIE), 'summary');
  assert.ok(h.document.querySelector('.je-tag-pill'), 'pill built from the facts on the card');
  assert.equal(h.renderCalls, calls, 'no renderer ran again');
});

test('item data arriving after the groups re-presents the card when its look changes', t => {
  const h = setup(t, { settings: { tagLookRules: [rule([{ field: 'library', value: KIDS_LIB }], 'bands')] } });
  h.render(MOVIE, entry());
  assert.equal(h.layoutOf(MOVIE), 'corners');
  h.layout.setCardContext(h.hostOf(MOVIE), entry({ LibraryId: KIDS_LIB }), MOVIE);
  assert.equal(h.layoutOf(MOVIE), 'bands');
});

test('item data for a card that now shows another item is ignored', async t => {
  const h = setup(t, { settings: { tagLookRules: [rule([{ field: 'library', value: KIDS_LIB }], 'bands')] } });
  h.render(MOVIE, entry({ LibraryId: KIDS_LIB }));
  assert.equal(h.layoutOf(MOVIE), 'bands');
  h.document.querySelector('.card').setAttribute('data-id', OTHER);
  assert.equal(h.layout.resolveLayout(h.hostOf(OTHER)).layout, 'corners');
});

test('a document from before layouts ignores the admin default rules but keeps its own', t => {
  const plugin = { TagLookRules: [{ Id: 'a', Enabled: true, When: [{ Field: 'type', Value: 'Movie' }], Layout: 'bands', Density: 'full' }] };
  const legacy = setup(t, { settings: { tagLayoutSettingsVersion: 0 }, plugin });
  legacy.render();
  assert.equal(legacy.layoutOf(MOVIE), 'corners');
  const normalized = setup(t, { plugin });
  normalized.render();
  assert.equal(normalized.layoutOf(MOVIE), 'bands', 'null rules inherit the admin rules');
  const own = setup(t, { settings: { tagLayoutSettingsVersion: 0, tagLookRules: [rule([{ field: 'type', value: 'Movie' }], 'minimal')] }, plugin });
  own.render();
  assert.equal(own.layoutOf(MOVIE), 'minimal');
});
