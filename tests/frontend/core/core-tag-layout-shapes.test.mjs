import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, jsRoot, plain } from '../helpers/harness.mjs';

// Per-shape looks: landscape cards (episode thumbnails, backdrop cards) and
// large list rows can have their own layout, density, slots and caps.

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ID2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ID3 = 'cccccccccccccccccccccccccccccccc';

/** A Jellyfin 12 card with the given shape class ('' = none the controller knows). */
const card = (id, cls, type = 'Movie') => `<div class="card ${cls} card-hoverable" data-id="${id}" data-type="${type}"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer coveredImage cardContent"></div><div class="je-tag-host"></div><div class="cardOverlayContainer"></div></div><div class="cardText cardText-first">Title</div></div></div>`;
const poster = (id = ID) => card(id, 'overflowPortraitCard');
const thumb = (id = ID2, type = 'Episode') => card(id, 'overflowBackdropCard', type);
/** Large list row (a season's episode list): the tag target is the image itself. */
const listRow = (id = ID3) => `<div class="listItem listItem-largeImage" data-id="${id}" data-type="Episode"><div class="listItemImage listItemImage-large itemAction"></div><div class="listItemBody"><div class="listItemBodyText">Title</div></div></div>`;

/** A tag-cache entry with something for every group. */
const entry = (overrides = {}) => ({
  Type: 'Movie', TmdbId: '42', Genres: ['Drama', 'Crime', 'Thriller'], CommunityRating: 8.12, CriticRating: 91, OfficialRating: 'PG-13',
  AudioLanguages: ['en', 'fr'], DateCreated: new Date(Date.UTC(2026, 9, 29)).toISOString(), PremiereDate: new Date(Date.UTC(2001, 0, 1)).toISOString(),
  StreamData: {
    Streams: [
      { Type: 'Video', Codec: 'hevc', Height: 2160, VideoRangeType: 'DOVIWithHDR10', DisplayTitle: '4K HEVC Dolby Vision' },
      { Type: 'Audio', Language: 'eng', Codec: 'truehd', Channels: 8, ChannelLayout: '7.1', DisplayTitle: 'English - TrueHD Atmos 7.1' },
    ],
    Sources: [{ Path: 'Movie (2020).mkv', Name: 'Movie (2020)' }], ItemName: 'Movie', ItemPath: 'Movie (2020).mkv',
  },
  ...overrides,
});

/** The "Use recommended" looks in the wire form the panel writes. */
const RECOMMENDED = {
  landscape: { layout: 'bands', density: 'compact', slots: [{ group: 'status', slot: 'top' }, { group: 'ageRating', slot: 'top' }, { group: 'quality', slot: 'bottom' }, { group: 'rating', slot: 'bottom' }, { group: 'language', slot: 'off' }, { group: 'genre', slot: 'off' }], caps: null },
  list: { layout: 'corners', density: 'compact', slots: [{ group: 'quality', slot: 'tl' }, { group: 'status', slot: 'tr' }, { group: 'rating', slot: 'br' }, { group: 'ageRating', slot: 'off' }, { group: 'language', slot: 'off' }, { group: 'genre', slot: 'off' }], caps: { quality: 2, status: 2, rating: 2 } },
};

/** The real renderers, layout controller and tag look module over one page of cards. */
function setup(t, { html = poster() + thumb() + listRow(), settings = {}, plugin = {} } = {}) {
  const renderers = new Map();
  const h = createHarness({
    html,
    JE: {
      currentSettings: {
        qualityTagsEnabled: true, genreTagsEnabled: true, languageTagsEnabled: true, ratingTagsEnabled: true,
        ageRatingTagsEnabled: true, statusTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none', ...settings,
      },
      pluginConfig: { TagCacheServerMode: true, ...plugin },
      t: key => key,
      cdn: { flagSvg: code => `http://jellyfin.test/flags/${code}.svg` },
      session: { getUserId: () => 'a', getServerId: () => 's', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} },
      tagPipeline: {
        registerRenderer: (name, r) => renderers.set(name, r), getRenderer: name => renderers.get(name), clearProcessed() {}, scheduleScan() {},
        peekReviewRatings: () => null, getReviewRatingsRequestedAt: () => 1, getReviewRatings: async () => null, onReviewRatingsChanged() {},
      },
    },
  });
  t.after(() => h.close());
  h.window.Date.now = () => Date.UTC(2026, 9, 30);
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-layout-styles.js',
    'tags/qualitytags.js', 'tags/genretags.js', 'tags/languagetags.js', 'tags/ratingtags.js', 'tags/ageratingtags.js', 'tags/statustags.js']) h.load(file);
  const JE = h.JE;
  JE.initializeQualityTags(); JE.initializeGenreTags(); JE.initializeRatingTags(); JE.initializeAgeRatingTags(); JE.initializeStatusTags(); JE.initializeLanguageTags();
  const layout = JE.core.tagLayout;
  /** The render target of the card holding an id. */
  const target = id => {
    const holder = h.document.querySelector(`[data-id="${id}"]`);
    return holder.querySelector('.je-tag-host') || holder.querySelector('.listItemImage');
  };
  return Object.assign(h, {
    layout, target,
    /** Render an entry into the card with this id through every enabled renderer. */
    render(id, e = entry()) {
      const el = target(id);
      for (const [, r] of renderers) if (r.isEnabled() && r.renderFromServerCache) r.renderFromServerCache(el, e, id);
      return el;
    },
    renderAll() { for (const id of [ID, ID2, ID3]) if (h.document.querySelector(`[data-id="${id}"]`)) this.render(id); },
    host: id => h.document.querySelector(`[data-id="${id}"] .je-tag-host`),
    /** Group ids in one of a card's slots, in DOM order. */
    slot(id, name) {
      const el = h.document.querySelector(`[data-id="${id}"] .je-tag-host > .je-tag-slot[data-je-slot="${name}"]`);
      return el ? Array.from(el.children, c => c.dataset.jeGroup || c.className) : null;
    },
    async apply(changes) { Object.assign(JE.currentSettings, changes); await JE.reinitializeTagLayout(); },
  });
}

/** Give elements a rendered size for the duration of fn (jsdom lays nothing out). */
function withSize(h, sizeOf, fn) {
  const proto = h.window.Element.prototype;
  const saved = ['clientWidth', 'clientHeight'].map(key => [key, Object.getOwnPropertyDescriptor(proto, key)]);
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get() { return sizeOf(this)?.[0] ?? 0; } });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return sizeOf(this)?.[1] ?? 0; } });
  try { return fn(); } finally { for (const [key, desc] of saved) Object.defineProperty(proto, key, desc); }
}

test('card shapes come from Jellyfin\'s card classes and the list row selector, never from a layout read', t => {
  const html = poster() + thumb() + listRow() + card('d'.repeat(32), 'squareCard') + card('e'.repeat(32), 'smallBackdropCard')
    + card('f'.repeat(32), 'bannerCard') + card('1'.repeat(32), '') + `<div data-je-shape="landscape"><div class="cardScalable" id="sample"></div></div>`;
  const h = setup(t, { html });
  const shapeOf = id => h.layout.shapeOfCard(h.document.querySelector(`[data-id="${id}"] .cardScalable, [data-id="${id}"] .listItemImage`));
  assert.equal(shapeOf(ID), 'portrait');
  assert.equal(shapeOf(ID2), 'landscape');
  assert.equal(shapeOf(ID3), 'list');
  assert.equal(shapeOf('d'.repeat(32)), 'portrait', 'square cards (music, people) count as portrait');
  assert.equal(shapeOf('e'.repeat(32)), 'landscape');
  assert.equal(shapeOf('f'.repeat(32)), 'landscape');
  assert.equal(shapeOf('1'.repeat(32)), null, 'unknown markup is measured instead');
  assert.equal(h.layout.shapeOfCard(h.document.getElementById('sample')), 'landscape', 'an explicit data-je-shape wins (the panel samples)');
  // A plain item description resolves as a portrait unless it names a shape.
  assert.equal(h.layout.shapeOf({ itemId: ID }), 'portrait');
  assert.equal(h.layout.shapeOf({ itemId: ID, shape: 'list' }), 'list');
});

test('without shape looks every card resolves to the default settings object and nothing is marked or measured', t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'corners' } });
  h.renderAll();
  const base = h.layout.normalizeSettings();
  assert.deepEqual(plain(base.shapes), { landscape: null, list: null });
  for (const id of [ID, ID2]) assert.equal(h.layout.resolveLayout(h.host(id)), h.layout.resolveLayout(h.host(ID)));
  assert.equal(h.layout.lookSource(h.host(ID2)).source, 'default');
  assert.equal(h.document.querySelectorAll('[data-je-shape]').length, 0, 'no shape marker without shape looks');
  assert.deepEqual(h.slot(ID2, 'tl'), h.slot(ID, 'tl'), 'the episode thumbnail shows the poster layout');
});

test('the recommended landscape and list looks apply to their shapes only, with their own density and caps', async t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'corners', tagShapeOverrides: RECOMMENDED } });
  h.renderAll();
  // Portrait poster: the default corners look, full labels.
  assert.equal(h.host(ID).dataset.jeLayout, 'corners');
  assert.equal(h.host(ID).dataset.jeShape, 'portrait');
  assert.ok(h.host(ID).querySelector('[data-je-group="genre"]'), 'the poster keeps every group');
  assert.ok(Array.from(h.host(ID).querySelectorAll('.quality-overlay-label')).some(c => c.textContent === 'Dolby Vision'));
  // Landscape thumbnail: bands, compact; status and age on top, quality and rating below, language and genre hidden.
  const thumbConf = h.layout.resolveLayout(h.host(ID2));
  assert.equal(h.layout.lookSource(h.host(ID2)).source, 'shape');
  assert.equal(thumbConf.layout, 'bands');
  assert.equal(thumbConf.density, 'compact');
  assert.equal(h.host(ID2).dataset.jeLayout, 'bands');
  assert.equal(h.host(ID2).dataset.jeShape, 'landscape');
  assert.deepEqual(h.slot(ID2, 'top'), ['status', 'ageRating']);
  assert.deepEqual(h.slot(ID2, 'bottom'), ['quality', 'rating']);
  assert.equal(h.host(ID2).querySelector('[data-je-group="genre"], [data-je-group="language"]'), null);
  assert.ok(Array.from(h.host(ID2).querySelectorAll('.quality-overlay-label')).some(c => c.textContent === 'DV'), 'compact labels on the thumbnail');
  // List row: corners, compact, at most two chips per group.
  const rowHost = h.document.querySelector(`[data-id="${ID3}"] .je-tag-host`);
  assert.equal(rowHost.dataset.jeLayout, 'corners');
  assert.equal(rowHost.dataset.jeShape, 'list');
  assert.deepEqual(h.layout.resolveLayout(rowHost).caps.quality, 2);
  assert.equal(rowHost.querySelector('[data-je-group="quality"]').children.length, 2);
  assert.equal(rowHost.querySelector('.je-tag-slot[data-je-slot="tl"] > [data-je-group="quality"]').dataset.jeCorner, 'top-left');
  assert.ok(rowHost.querySelector('.je-tag-slot[data-je-slot="br"] > [data-je-group="rating"]'));
  assert.equal(rowHost.querySelector('[data-je-group="genre"]'), null);
  assert.equal(h.layout.resolveLayout(h.host(ID)).caps.quality, 0, 'the poster keeps the default caps');

  // Switching the landscape look off re-presents the thumbnail in the default look.
  await h.apply({ tagShapeOverrides: { landscape: null, list: RECOMMENDED.list } });
  assert.equal(h.host(ID2).dataset.jeLayout, 'corners');
  assert.ok(h.host(ID2).querySelector('[data-je-group="genre"]'));
});

test('precedence per card: lock, then the first matching rule, then the shape look, then the default', async t => {
  const h = setup(t, {
    settings: {
      tagLayoutSettingsVersion: 1, tagLayout: 'corners', tagShapeOverrides: RECOMMENDED,
      tagLookRules: [{ id: 'eps', enabled: true, when: [{ field: 'type', value: 'Episode' }], layout: 'summary', density: 'full' }],
    },
  });
  h.renderAll();
  assert.equal(h.layout.lookSource(h.host(ID2)).source, 'rule');
  assert.equal(h.layout.resolveLayout(h.host(ID2)).layout, 'summary', 'a rule beats the shape look');
  assert.equal(h.layout.resolveLayout(h.host(ID)).layout, 'corners', 'the movie poster matches neither');

  // A rule may carry its own per-shape looks, laid over its look on that shape.
  await h.apply({ tagLookRules: [{ id: 'eps', enabled: true, when: [{ field: 'type', value: 'Episode' }], layout: 'summary', density: 'full',
    shapes: { landscape: { layout: null, density: 'compact', slots: [{ group: 'genre', slot: 'pill' }], caps: { genre: 1 } } } }] });
  const ruled = h.layout.resolveLayout(h.host(ID2));
  assert.deepEqual([ruled.layout, ruled.density, ruled.slots.genre, ruled.caps.genre], ['summary', 'compact', 'pill', 1]);
  assert.equal(h.layout.resolveLayout(h.host(ID3)).layout, 'summary', 'the list row matches the rule too; the rule has no list look');

  // A lock beats both; its shape look applies the same way.
  await h.apply({ tagLayoutLocks: { [ID2]: { layout: 'minimal', density: 'full', slots: null, lockedAt: 1, shapes: { landscape: { layout: 'caption', density: null, slots: null, caps: null } } } } });
  assert.equal(h.layout.lookSource(h.host(ID2)).source, 'lock');
  assert.equal(h.layout.resolveLayout(h.host(ID2)).layout, 'caption');
  assert.equal(h.layout.resolveLayout(h.host(ID2)).locked, true);
  await h.apply({ tagLayoutLocks: { [ID2]: { layout: 'minimal', density: 'full', slots: null, lockedAt: 1 } } });
  assert.equal(h.layout.resolveLayout(h.host(ID2)).layout, 'minimal', 'a lock without shape looks keeps its look on every shape');
});

test('normalized documents inherit the administrator\'s shape looks; their own value, even all off, replaces them; legacy documents never inherit', t => {
  const plugin = { TagShapeOverrides: { Landscape: { Layout: 'caption', Density: 'compact', Slots: [{ Group: 'status', Slot: 'poster' }], Caps: { Genre: 1 } }, List: null } };
  const inherits = setup(t, { settings: { tagLayoutSettingsVersion: 1 }, plugin });
  const shapes = inherits.layout.normalizeSettings().shapes;
  assert.deepEqual(plain(shapes.landscape), { layout: 'caption', density: 'compact', slots: { status: 'poster' }, caps: { genre: 1 } });
  assert.equal(shapes.list, null);

  const off = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagShapeOverrides: { landscape: null, list: null } }, plugin });
  assert.deepEqual(plain(off.layout.normalizeSettings().shapes), { landscape: null, list: null }, 'switched off stays off');

  const legacy = setup(t, { settings: { qualityTagsPosition: 'top-left' }, plugin });
  const legacyConf = legacy.layout.normalizeSettings();
  assert.equal(legacyConf.legacy, true);
  assert.deepEqual(plain(legacyConf.shapes), { landscape: null, list: null }, 'a legacy document never takes the admin\'s shape looks');
  legacy.renderAll();
  assert.equal(legacy.host(ID2).dataset.jeLayout, 'corners');
  assert.equal(legacy.host(ID2).dataset.jeLegacy, '1');
  assert.equal(legacy.host(ID2).dataset.jeShape, undefined);
});

test('shape looks are validated: unknown shapes, layouts and slots dropped, caps clamped, slots checked against the layout the card resolves to', t => {
  const h = setup(t, { html: thumb() });
  const read = h.layout.readShapeOverrides({
    Portrait: { layout: 'bands' }, landscape: { Layout: 'GRID', density: 'tiny', slots: { quality: 'dots', genre: 'dots', mood: 'top', rating: 'nowhere', status: 'TR' }, caps: { Quality: 40, genre: -2, nope: 3 } },
    list: 'bands',
  });
  assert.deepEqual(plain(read), { landscape: { layout: null, density: null, slots: { quality: 'dots', status: 'tr' }, caps: { quality: 10, genre: 0 } }, list: null });
  assert.deepEqual(plain(h.layout.readShapeOverrides(null)), { landscape: null, list: null });

  // The default layout is bands: "dots" and "tr" are not bands slots, so the
  // bands profile stays; the caps apply.
  h.JE.currentSettings.tagLayoutSettingsVersion = 1;
  h.JE.currentSettings.tagLayout = 'bands';
  h.JE.currentSettings.tagShapeOverrides = { landscape: read.landscape };
  h.layout.invalidateSettings();
  const conf = h.layout.resolveLayout(h.host(ID2));
  assert.equal(conf.layout, 'bands');
  assert.deepEqual(plain(conf.slots), plain(h.layout.normalizeSettings().slots));
  assert.equal(conf.caps.quality, 10);
  // Wire form: slots as [{group, slot}] values, untouched by the key converter.
  assert.deepEqual(plain(h.layout.shapesToWire(read)), { landscape: { layout: null, density: null, slots: [{ group: 'quality', slot: 'dots' }, { group: 'status', slot: 'tr' }], caps: { quality: 10, genre: 0 } }, list: null });
  assert.equal(h.layout.shapesToWire({ landscape: null, list: null }), null);
});

test('a card its markup does not classify waits for the batched measurement, then shows its measured shape\'s look', t => {
  const unknown = id => card(id, '');
  const h = setup(t, { html: unknown(ID) + unknown(ID2) + unknown(ID3), settings: { tagLayoutSettingsVersion: 1, tagShapeOverrides: RECOMMENDED } });
  h.renderAll();
  for (const id of [ID, ID2, ID3]) assert.equal(h.host(id).querySelector('.je-tag-slot'), null, 'no chips before the measurement');
  const size = { [ID]: [168, 253], [ID2]: [306, 172] };
  let reads = 0;
  withSize(h, el => {
    if (!el.classList?.contains('je-tag-host')) return null;
    reads++;
    return size[el.closest('[data-id]').dataset.id] || [0, 0];
  }, () => h.layout.flushFit());
  assert.ok(reads <= 6 + 6, 'one batch of reads for the three cards (plus the fitting pass\'s own)');
  assert.equal(h.host(ID).dataset.jeShape, 'portrait');
  assert.equal(h.host(ID).dataset.jeLayout, 'corners');
  assert.ok(h.host(ID).querySelector('[data-je-group="genre"]'));
  assert.equal(h.host(ID2).dataset.jeShape, 'landscape');
  assert.equal(h.host(ID2).dataset.jeLayout, 'bands');
  assert.deepEqual(h.slot(ID2, 'top'), ['status', 'ageRating']);
  // Not laid out (a hidden tab): shown as a portrait, measured again next time.
  assert.equal(h.host(ID3).dataset.jeShape, 'portrait');
  assert.ok(h.host(ID3).querySelector('.je-tag-slot'));
  h.layout.refreshPresentation(h.host(ID3));
  withSize(h, el => (el.classList?.contains('je-tag-host') && el.closest('[data-id]').dataset.id === ID3 ? [300, 160] : null), () => h.layout.flushFit());
  assert.equal(h.host(ID3).dataset.jeShape, 'landscape');
  assert.equal(h.host(ID3).dataset.jeLayout, 'bands');
});

test('the fitting pass fits each card in its own shape\'s look (per-shape density included)', t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'corners', tagShapeOverrides: RECOMMENDED } });
  h.renderAll();
  // The poster is corners (never fitted); the thumbnail is bands, compact.
  withSize(h, el => (el.classList?.contains('je-tag-host') || el.classList?.contains('je-tag-slot') ? [300, 170] : null), () => h.layout.flushFit());
  assert.ok(h.host(ID2).querySelector('.je-tag-slot[data-je-slot="bottom"] > .je-tag-more'), 'the thumbnail\'s bottom band is fitted');
  assert.equal(h.host(ID).querySelector('.je-tag-more'), null, 'the corners poster is not');
  // A narrow thumbnail keeps its compact labels.
  withSize(h, el => (el.classList?.contains('je-tag-host') ? [120, 68] : null), () => h.layout.flushFit());
  assert.ok(Array.from(h.host(ID2).querySelectorAll('.quality-overlay-label')).every(c => c.textContent !== 'Dolby Vision'));
});

test('rules and locks keep their shape looks through normalisation and saving', async t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1 } });
  const saved = [];
  h.JE.saveUserSettings = (file, doc) => { saved.push(JSON.parse(JSON.stringify(doc))); return Promise.resolve(); };
  const look = h.JE.core.tagLook;
  const [rule] = look.normalizeRules([{ id: 'r', when: [{ field: 'type', value: 'Episode' }], layout: 'bands', density: 'full',
    shapes: { list: { layout: 'corners', slots: [{ Group: 'quality', Slot: 'tl' }] }, landscape: null } }]);
  assert.deepEqual(plain(rule.shapes), { landscape: null, list: { layout: 'corners', density: null, slots: { quality: 'tl' }, caps: null } });
  assert.equal(look.normalizeRules([{ id: 'r', when: [{ field: 'type', value: 'Movie' }], layout: 'bands', shapes: {} }])[0].shapes, null);
  await look.saveRules([rule]);
  assert.deepEqual(saved.at(-1).tagLookRules[0].shapes, { landscape: null, list: { layout: 'corners', density: null, slots: [{ group: 'quality', slot: 'tl' }], caps: null } });
  // Locking stores the portrait look the item resolves to, without shapes.
  await look.lockItem(ID, { layout: 'caption', density: 'full', slots: { status: 'poster' } });
  assert.equal(saved.at(-1).tagLayoutLocks[ID].shapes, null);
});

test('configPage.html offers the same recommended looks as the layout controller', t => {
  const h = setup(t, { html: '' });
  const page = readFileSync(resolve(jsRoot, '../Configuration/configPage.html'), 'utf8');
  const literal = /var JE_TAG_SHAPE_RECOMMENDED = (\{[\s\S]*?\n\s*\});/.exec(page)?.[1];
  assert.ok(literal, 'configPage.html declares JE_TAG_SHAPE_RECOMMENDED');
  const admin = JSON.parse(literal);
  for (const shape of h.layout.SHAPES) {
    assert.deepEqual(plain(h.layout.readShapeOverrides(admin)[shape]), plain(h.layout.readShapeOverrides(h.layout.RECOMMENDED_SHAPES)[shape]), shape);
  }
  assert.deepEqual(plain(h.layout.readShapeOverrides(RECOMMENDED)), plain(h.layout.readShapeOverrides(h.layout.RECOMMENDED_SHAPES)), 'the tests\' copy too');
});


test('promoting a legacy document pins shape inheritance off until an explicit shape edit', t => {
  const h = setup(t, { plugin: { TagShapeOverrides: RECOMMENDED } });
  assert.equal(h.layout.promoteLegacySettings(), true);
  assert.deepEqual(plain(h.JE.currentSettings.tagShapeOverrides), { landscape: null, list: null });
  assert.deepEqual(plain(h.layout.normalizeSettings().shapes), { landscape: null, list: null });
});

test('measured shapes are re-read in a batch when the image aspect changes; the host marker is never input', t => {
  const h = setup(t, { html: card(ID, ''), settings: { tagLayoutSettingsVersion: 1, tagShapeOverrides: RECOMMENDED } });
  h.renderAll();
  withSize(h, el => el.classList?.contains('je-tag-host') ? [300, 160] : null, () => h.layout.flushFit());
  assert.equal(h.host(ID).dataset.jeLayout, 'bands');
  assert.equal(h.layout.shapeOfCard(h.host(ID)), null);
  h.layout.refreshPresentation();
  withSize(h, el => el.classList?.contains('je-tag-host') ? [160, 240] : null, () => h.layout.flushFit());
  assert.equal(h.host(ID).dataset.jeLayout, 'corners');
  const cardEl = h.document.querySelector('.card');
  cardEl.classList.add('overflowBackdropCard');
  h.layout.refreshPresentation();
  assert.equal(h.host(ID).dataset.jeLayout, 'bands', 'a new declared class takes effect');
  cardEl.dataset.id = ID2;
  cardEl.classList.replace('overflowBackdropCard', 'portraitCard');
  h.render(ID2);
  assert.equal(h.host(ID2).dataset.jeLayout, 'corners', 'recycled cards drop the old shape and look');
});
