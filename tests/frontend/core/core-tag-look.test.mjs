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
  const userChange = [];
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
      session: { getUserId: () => 'a', getServerId: () => 's', getEpoch: () => 0, isCurrent: () => true, onUserChange: (name, fn) => userChange.push(fn) },
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
  files.push('tags/tag-layout-styles.js', 'tags/qualitytags.js', 'tags/genretags.js', 'tags/rating-sources.js', 'tags/ratingtags.js', 'tags/ageratingtags.js');
  for (const file of files) h.load(file);
  const JE = h.JE;
  JE.toast = message => toasts.push(message);
  JE.initializeQualityTags(); JE.initializeGenreTags(); JE.initializeRatingTags(); JE.initializeAgeRatingTags();
  const layout = JE.core.tagLayout;
  const hostOf = id => h.document.querySelector(`[data-id="${id}"] .je-tag-host`);
  return Object.assign(h, {
    layout, look: JE.core.tagLook, writes, toasts, hostOf,
    /** Run the session's user-change handlers (a user switch). */
    switchUser() { for (const fn of userChange) fn(); },
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

test('look slot normalization rejects inherited and unknown layout names without throwing', t => {
  const h = setup(t);
  for (const layout of ['constructor', '__proto__', 'toString', 'unknown']) {
    assert.equal(h.look.normalizeSlots({ quality: 'tc' }, layout), null);
    assert.deepEqual(plain(h.look.normalizeRules([rule([{field:'type',value:'Movie'}], layout)])), []);
  }
  assert.deepEqual(plain(h.look.normalizeSlots({ quality: 'tc' }, 'corners')), { quality: 'tc' });
  assert.deepEqual(plain(h.look.normalizeRules([Object.create({ layout: 'bands', when: [{field:'type',value:'Movie'}] })])), []);
});

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

test('a late answer for the item a reused card showed before never overwrites the item it shows now', t => {
  const h = setup(t, { settings: { tagLookRules: [rule([{ field: 'library', value: KIDS_LIB }], 'bands')] } });
  const host = h.hostOf(MOVIE);
  // The pipeline asks for MOVIE's data and captures the card's identity.
  const askedFor = h.layout.cardIdentity(host);
  assert.equal(askedFor, MOVIE);
  // Meanwhile the virtualised card is reused for OTHER, whose data arrives first.
  h.document.querySelector('.card').setAttribute('data-id', OTHER);
  h.render(OTHER, entry({ LibraryId: MOVIES_LIB }));
  assert.equal(h.layoutOf(OTHER), 'corners');
  // MOVIE's (kids library) answer lands late: dropped, OTHER keeps its facts.
  assert.equal(h.layout.setCardContext(host, entry({ LibraryId: KIDS_LIB }), MOVIE, askedFor), false);
  assert.equal(h.layoutOf(OTHER), 'corners');
  assert.equal(h.layout.resolveLayout(host).layout, 'corners');
  // Its own (late) answer still applies.
  assert.equal(h.layout.setCardContext(host, entry({ LibraryId: KIDS_LIB }), OTHER, OTHER), true);
  assert.equal(h.layoutOf(OTHER), 'bands');
});

test('the card identity is the item the card shows, not the artwork it borrows', t => {
  const html = card(EPISODE, 'Episode').replace(`Items/${EPISODE}/Images`, `Items/${SERIES}/Images`);
  const h = setup(t, { html, settings: { tagLookRules: [rule([{ field: 'library', value: KIDS_LIB }], 'bands')] } });
  const host = h.hostOf(EPISODE);
  assert.equal(h.layout.cardIdentity(host), EPISODE);
  // The pipeline resolved the series artwork id; the data is still the episode card's.
  assert.equal(h.layout.setCardContext(host, entry({ Type: 'Episode', LibraryId: KIDS_LIB }), SERIES, EPISODE), true);
  assert.equal(h.layout.resolveLayout(host).layout, 'bands');
});

test('a user switch forgets every card\'s item data, also on hosts without a controller', async t => {
  const html = card(MOVIE) + card(OTHER);
  const h = setup(t, { html, settings: { tagLookRules: [rule([{ field: 'library', value: KIDS_LIB }], 'bands')] } });
  h.render(MOVIE, entry({ LibraryId: KIDS_LIB }));
  // OTHER has data but no groups yet (its tags are a fetch away): no controller.
  h.layout.setCardContext(h.hostOf(OTHER), entry({ LibraryId: KIDS_LIB }), OTHER);
  assert.equal(h.layout.resolveLayout(h.hostOf(MOVIE)).layout, 'bands');
  assert.equal(h.layout.resolveLayout(h.hostOf(OTHER)).layout, 'bands');

  h.switchUser();
  assert.ok(h.hostOf(MOVIE) && h.hostOf(OTHER), 'the hosts stay in the page');
  assert.equal(h.layout.resolveLayout(h.hostOf(MOVIE)).layout, 'corners', 'the outgoing user\'s facts are gone');
  assert.equal(h.layout.resolveLayout(h.hostOf(OTHER)).layout, 'corners');
  await h.settle();
  assert.equal(h.hostOf(OTHER).dataset.jeLayout, undefined);
});


test('centre slots travel unchanged through rules, locks and a saved lock snapshot', async t => {
  const slots = [{group: 'quality', slot: 'tc'}, {group: 'rating', slot: 'bc'}, {group: 'ageRating', slot: 'mr'}, {group: 'genre', slot: 'c'}, {group: 'language', slot: 'ml'}];
  const h = setup(t, {settings: {tagLookRules: [rule([{field: 'type', value: 'Movie'}], 'corners', 'full', {slots})]}});
  h.render();
  const conf = h.layout.resolveLayout(h.hostOf(MOVIE));
  for (const {group, slot} of slots) assert.equal(conf.slots[group], slot);
  await h.look.lockItem(MOVIE, {layout: 'corners', density: 'full', slots: conf.slots});
  const saved = h.writes.at(-1).tagLayoutLocks[MOVIE];
  for (const {group, slot} of slots) assert.ok(saved.slots.some(s => s.group === group && s.slot === slot));
  h.JE.currentSettings.tagLookRules = [];
  await h.settle();
  for (const {group, slot} of slots) assert.equal(h.layout.resolveLayout(h.hostOf(MOVIE)).slots[group], slot);
});

test('the user\'s lock beats the administrator\'s item look, which beats every rule; removing each falls back in order', async t => {
  const h = setup(t, {
    settings: { tagLayout: 'corners', tagLookRules: [rule([{ field: 'library', value: MOVIES_LIB }], 'caption', 'compact')] },
    plugin: { TagLookItemOverrides: [{ ItemId: MOVIE, Layout: 'bands', Density: 'compact', LockedAt: 1 }] },
  });
  h.render();
  assert.equal(h.layoutOf(MOVIE), 'bands', 'the item look wins over the rule');
  assert.equal(h.hostOf(MOVIE).dataset.jeLocked, undefined, 'an item look is not the user\'s lock');
  assert.equal(h.layout.lookSource(h.hostOf(MOVIE)).source, 'override');

  await h.look.lockItem(MOVIE, { layout: 'minimal', density: 'full' });
  await h.settle();
  assert.equal(h.layoutOf(MOVIE), 'minimal', 'the user\'s lock wins over the item look');

  await h.look.unlockItems([MOVIE]);
  await h.settle();
  assert.equal(h.layoutOf(MOVIE), 'bands', 'back to the item look');

  h.JE.pluginConfig.TagLookItemOverrides = null;
  h.layout.invalidateSettings();
  await h.settle();
  assert.equal(h.layoutOf(MOVIE), 'caption', 'back to the rule');
});

test('an item look applies to documents saved before layouts too, with their legacy sizing kept', async t => {
  const h = setup(t, {
    settings: { tagLayoutSettingsVersion: 0, tagLayout: undefined },
    plugin: { TagLookItemOverrides: [{ ItemId: MOVIE, Layout: 'bands', Density: 'full', LockedAt: 1 }], TagLookRules: [rule([{ field: 'type', value: 'Movie' }], 'caption')] },
  });
  h.render();
  assert.equal(h.layoutOf(MOVIE), 'bands');
  const conf = h.layout.resolveLayout(h.hostOf(MOVIE));
  assert.equal(conf.legacy, true);
  assert.equal(conf.order.join(','), h.layout.DEFAULT_ORDER.join(','), 'bands use the built-in order, as for any layout but corners');
  assert.deepEqual(plain(h.look.read().rules), [], 'the administrator\'s rules still do not reach a legacy document');
});

test('a series lock scoped to the series poster stays off its seasons and episodes', async t => {
  const html = card(SERIES, 'Series') + card(SEASON, 'Season') + card(EPISODE, 'Episode');
  const h = setup(t, { html, plugin: { TagLookItemOverrides: [{ ItemId: SERIES, Layout: 'summary', Density: 'full', LockedAt: 1 }] } });
  h.render(SERIES, entry({ Type: 'Series' }));
  h.render(SEASON, entry({ Type: 'Season', SeriesId: SERIES }));
  h.render(EPISODE, entry({ Type: 'Episode', SeriesId: SERIES }));
  assert.deepEqual([SERIES, SEASON, EPISODE].map(h.layoutOf), ['summary', 'summary', 'summary'], 'the series item look reaches its children');
  await h.look.lockItem(SERIES, { layout: 'bands', density: 'compact', scope: 'item' });
  await h.settle();
  assert.deepEqual([SERIES, SEASON, EPISODE].map(h.layoutOf), ['bands', 'summary', 'summary'], 'the item-scoped lock stays on the series; the children keep the series item look');
  assert.equal(h.writes.at(-1).tagLayoutLocks[SERIES].scope, 'item');
  await h.look.lockItem(SERIES, { layout: 'bands', density: 'compact' });
  await h.settle();
  assert.deepEqual([SERIES, SEASON, EPISODE].map(h.layoutOf), ['bands', 'bands', 'bands'], 'a series-wide lock reaches them');
});

test('a lock carries its own caps, size, gap and edge spacing over the user\'s', async t => {
  const h = setup(t, { settings: { tagLayout: 'corners', tagEdgeSpacing: 'default', tagGroupCaps: { genre: 3 } } });
  h.render();
  await h.look.lockItem(MOVIE, { layout: 'corners', density: 'full', caps: { genre: 1 }, tagScale: 'larger', tagGap: 'roomy', edge: 'flush' });
  await h.settle();
  const conf = h.layout.resolveLayout(h.hostOf(MOVIE));
  assert.equal(conf.caps.genre, 1);
  assert.equal(conf.tagScale, 'larger');
  assert.equal(conf.tagGap, 'roomy');
  assert.equal(conf.edge, 'flush');
  assert.equal(h.hostOf(MOVIE).dataset.jeEdge, 'flush');
  assert.equal(h.hostOf(MOVIE).querySelectorAll('.genre-tag').length, 1, 'one genre chip');
  const saved = h.writes.at(-1).tagLayoutLocks[MOVIE];
  assert.deepEqual(plain({ caps: saved.caps, tagScale: saved.tagScale, tagGap: saved.tagGap, edgeSpacing: saved.edgeSpacing }), { caps: { genre: 1 }, tagScale: 'larger', tagGap: 'roomy', edgeSpacing: 'flush' });
  assert.equal(saved.edge, undefined, 'stored under the server\'s name');
  // Read back in the server's casing.
  const read = h.look.normalizeLocks({ [MOVIE]: { Layout: 'corners', Density: 'full', Caps: { Genre: 2, AgeRating: 1 }, TagScale: 'Smaller', EdgeSpacing: 'tight', Scope: 'item', LockedAt: 3 } }).get(MOVIE);
  assert.deepEqual(plain({ caps: read.caps, tagScale: read.tagScale, edge: read.edge, scope: read.scope }), { caps: { genre: 2, ageRating: 1 }, tagScale: 'smaller', edge: 'tight', scope: 'item' });
  assert.equal(h.look.normalizeLocks({ [MOVIE]: { layout: 'corners', tagScale: 'huge', edgeSpacing: 'wide', caps: { genre: 99 } } }).get(MOVIE).caps.genre, 10, 'caps clamp; unknown sizes inherit');
});

test('editLocks moves a season\'s own look to its series in one save', async t => {
  const h = setup(t, { settings: { tagLayoutLocks: { [SEASON]: { layout: 'bands', density: 'full', lockedAt: 1 } } } });
  assert.equal(await h.look.editLocks({ [SERIES]: { layout: 'minimal', density: 'compact' } }, [SEASON]), true);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(Object.keys(h.writes[0].tagLayoutLocks), [SERIES]);
  assert.equal(await h.look.editLocks({ [SERIES]: { layout: 'nope' } }), false, 'an invalid look saves nothing');
  assert.equal(h.writes.length, 1);
});

test('saveItemOverride keeps the per-user projection: the stored answer never adds items the user was not served', async t => {
  const HIDDEN = 'c'.repeat(32);
  const h = setup(t, { plugin: { TagLookItemOverrides: [{ ItemId: OTHER, Layout: 'caption', LockedAt: 5 }] } });
  h.render();
  const stored = [{ ItemId: HIDDEN, Layout: 'minimal', LockedAt: 4 }, { ItemId: OTHER, Layout: 'caption', LockedAt: 5 }];
  const api = { get: async () => ({ TagLookItemOverrides: stored }),
    patch: async (changes) => ({ values: { TagLookItemOverrides: [...changes.TagLookItemOverrides.Set, ...stored] } }) };
  assert.equal(await h.look.saveItemOverride(MOVIE, { layout: 'bands' }, { api }), true);
  assert.deepEqual(h.JE.pluginConfig.TagLookItemOverrides.map((o) => o.ItemId).sort(), [MOVIE, OTHER].sort(),
    'the edited item and the items already served, not the item this user cannot see');
  assert.equal(await h.look.saveItemOverride(MOVIE, null, { api: { get: async () => ({ TagLookItemOverrides: [stored[0], ...h.JE.pluginConfig.TagLookItemOverrides] }), patch: async () => ({ values: { TagLookItemOverrides: [stored[0]] } }) } }), true);
  assert.equal(h.JE.pluginConfig.TagLookItemOverrides, null);
});

test('saveItemOverride sends only affected entries, retries once on a conflict and re-presents', async t => {
  const h = setup(t, { plugin: { TagLookItemOverrides: null } });
  h.render();
  const stored = [{ ItemId: OTHER, Layout: 'caption', Density: 'full', LockedAt: 5 }];
  const patches = [];
  let conflicts = 1;
  const api = {
    get: async () => ({ TagLookItemOverrides: stored }),
    patch: async (changes, expected) => {
      patches.push(plain({ changes, expected }));
      if (conflicts-- > 0) throw Object.assign(new Error('conflict'), { status: 409 });
      return { values: { TagLookItemOverrides: [...changes.TagLookItemOverrides.Set, ...stored] } };
    },
  };
  assert.equal(await h.look.saveItemOverride(MOVIE, { layout: 'bands', density: 'compact', caps: { quality: 2 } }, { api }), true);
  assert.equal(patches.length, 2, 'once more after the conflict');
  const mutation = patches[1].changes.TagLookItemOverrides;
  const list = mutation.Set;
  assert.deepEqual(mutation.Expected, { [MOVIE]: null });
  assert.deepEqual(list.map((o) => o.ItemId), [MOVIE], 'unrelated entries never sent');
  assert.deepEqual(list[0].Caps, { Quality: 2 }, 'the configuration\'s casing');
  assert.ok(list[0].LockedAt > 5);
  await h.settle();
  assert.equal(h.layoutOf(MOVIE), 'bands', 'the stored list is in the plugin configuration now');

  assert.equal(await h.look.saveItemOverride(MOVIE, null, { api: { get: async () => ({ TagLookItemOverrides: h.JE.pluginConfig.TagLookItemOverrides }), patch: async () => ({ values: { TagLookItemOverrides: stored } }) } }), true);
  await h.settle();
  assert.equal(h.layoutOf(MOVIE), 'corners');
  assert.equal(await h.look.saveItemOverride(MOVIE, { layout: 'bands' }, { api: { get: async () => ({}), patch: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); } } }), false);
  assert.equal(await h.look.saveItemOverride('nope', { layout: 'bands' }, { api }), false);
});

test('a rule with an invalid or surplus condition is dropped instead of widened', t => {
  const h = setup(t);
  const rule = (when) => ({ id: 'r', when, layout: 'bands', density: 'full' });
  assert.deepEqual(plain(h.look.normalizeRules([rule([{ field: 'type', value: 'Movie' }, { field: 'watched', value: 'true' }])])), []);
  assert.deepEqual(plain(h.look.normalizeRules([rule(Array.from({ length: 6 }, (_, i) => ({ field: 'genre', value: `G${i}` })))])), []);
  assert.equal(h.look.normalizeRules([rule(Array.from({ length: 5 }, (_, i) => ({ field: 'genre', value: `G${i}` })))])[0].when.length, 5);
});
