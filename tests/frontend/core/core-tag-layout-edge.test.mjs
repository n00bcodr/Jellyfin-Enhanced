import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// Corners edge spacing: Default (6px), Tight (3px) and Flush (0px) for all
// nine anchors, settings resolution and legacy promotion, the host marker the
// stylesheet keys off, and the fitting pass's per-card inset and radius.

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ANCHORS = ['tl', 'tc', 'tr', 'ml', 'c', 'mr', 'bl', 'bc', 'br'];

const card = (id = ID) => `<div class="card overflowPortraitCard" data-id="${id}" data-type="Movie"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer coveredImage cardContent" style="border-radius: 5px"></div><div class="je-tag-host"></div><div class="cardOverlayContainer"></div></div><div class="cardText cardText-first">Title</div></div></div>`;

/** A tag-cache entry with something for every group. */
const entry = () => ({
  Type: 'Movie', TmdbId: '42', Genres: ['Drama', 'Crime'], CommunityRating: 8.12, CriticRating: 91, OfficialRating: 'PG-13', AudioLanguages: ['en'],
  StreamData: { Streams: [{ Type: 'Video', Codec: 'hevc', Height: 2160, DisplayTitle: '4K HEVC' }], Sources: [{ Path: 'Movie (2020).mkv', Name: 'Movie (2020)' }], ItemName: 'Movie', ItemPath: 'Movie (2020).mkv' },
});

/** The real renderers and layout controller over one card. */
function setup(t, { settings = {}, plugin = {} } = {}) {
  const renderers = new Map();
  const h = createHarness({
    html: card(),
    JE: {
      currentSettings: { qualityTagsEnabled: true, ratingTagsEnabled: true, ageRatingTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none', ...settings },
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
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js',
    'tags/rating-sources.js', 'tags/qualitytags.js', 'tags/ratingtags.js', 'tags/ageratingtags.js']) h.load(file);
  const JE = h.JE;
  JE.initializeQualityTags(); JE.initializeRatingTags(); JE.initializeAgeRatingTags();
  const host = () => h.document.querySelector('.je-tag-host');
  return Object.assign(h, {
    layout: JE.core.tagLayout, host,
    render() { for (const [, r] of renderers) if (r.isEnabled() && r.renderFromServerCache) r.renderFromServerCache(host(), entry(), ID); },
    async apply(changes) { Object.assign(JE.currentSettings, changes); await JE.reinitializeTagLayout(); },
  });
}

/** Corners profile putting quality on one anchor, the other groups off. */
const onAnchor = slot => ({ corners: { groups: [{ group: 'quality', slot }, { group: 'rating', slot: 'off' }, { group: 'ageRating', slot: 'off' }] } });

test('edge spacing resolves own → admin → default, unknown values are Default and legacy documents ignore it', t => {
  const h = setup(t);
  const edge = (settings, plugin = {}) => h.layout.normalizeSettings(settings, plugin).edge;
  assert.equal(edge({ tagLayoutSettingsVersion: 1 }), 'default');
  assert.equal(edge({ tagLayoutSettingsVersion: 1 }, { TagEdgeSpacing: 'flush' }), 'flush');
  assert.equal(edge({ tagLayoutSettingsVersion: 1, tagEdgeSpacing: 'Tight' }, { TagEdgeSpacing: 'flush' }), 'tight');
  assert.equal(edge({ tagLayoutSettingsVersion: 1, tagEdgeSpacing: 'default' }, { TagEdgeSpacing: 'flush' }), 'default');
  assert.equal(edge({ tagLayoutSettingsVersion: 1, tagEdgeSpacing: 'huge' }, { TagEdgeSpacing: 'flush' }), 'default');
  assert.equal(edge({ tagLayoutSettingsVersion: 1 }, { TagEdgeSpacing: 'bogus' }), 'default');
  // Saved before layouts: the inset it always had, whatever is stored or set by the administrator.
  assert.equal(edge({ tagEdgeSpacing: 'flush' }, { TagEdgeSpacing: 'tight' }), 'default');
  assert.deepEqual({ ...h.layout.EDGE_SPACINGS }, { default: 6, tight: 3, flush: 0 });
});

test('promoting a legacy document pins the default edge so the administrator\'s does not take over', t => {
  const h = setup(t);
  const doc = { qualityTagsPosition: 'top-left' };
  assert.equal(h.layout.promoteLegacySettings(doc), true);
  assert.equal(doc.tagEdgeSpacing, 'default');
  assert.equal(h.layout.normalizeSettings(doc, { TagEdgeSpacing: 'flush' }).edge, 'default');
  const own = { tagEdgeSpacing: 'tight' };
  h.layout.promoteLegacySettings(own);
  assert.equal(own.tagEdgeSpacing, 'tight');
});

test('only a corners card with a non-default edge carries data-je-edge, on every anchor', async t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1 } });
  h.render();
  assert.equal(h.host().hasAttribute('data-je-edge'), false);
  for (const slot of ANCHORS) {
    for (const value of ['tight', 'flush']) {
      await h.apply({ tagEdgeSpacing: value, tagLayouts: onAnchor(slot) });
      assert.equal(h.host().dataset.jeEdge, value, `${slot} ${value}`);
      assert.ok(h.host().querySelector(`.je-tag-slot[data-je-slot="${slot}"] .quality-overlay-label`), `${slot} has its chip`);
    }
  }
  await h.apply({ tagEdgeSpacing: 'default' });
  assert.equal(h.host().hasAttribute('data-je-edge'), false);
  await h.apply({ tagEdgeSpacing: 'flush', tagLayout: 'bands' });
  assert.equal(h.host().dataset.jeLayout, 'bands');
  assert.equal(h.host().hasAttribute('data-je-edge'), false);
});

test('a legacy viewer keeps the original host markup even with an administrator edge default', t => {
  const h = setup(t, { plugin: { TagEdgeSpacing: 'flush' } });
  h.render();
  assert.equal(h.host().dataset.jeLegacy, '1');
  assert.equal(h.host().hasAttribute('data-je-edge'), false);
});

test('the stylesheet restates every anchor with the edge inset and leaves the default rules alone', t => {
  const h = setup(t);
  const css = h.layout.buildStyles();
  const EDGE = '.je-tag-host[data-je-layout="corners"][data-je-edge] > .je-tag-slot';
  assert.match(css, /\.je-tag-host\[data-je-layout="corners"\]\[data-je-edge="tight"\] \{ --je-edge: 3px; \}/);
  assert.match(css, /\[data-je-edge="flush"\] \{\s*--je-edge: 0px;\s*overflow: hidden;\s*border-radius: var\(--je-card-radius, 0px\);/);
  for (const slot of ['tl', 'tr', 'bl', 'br']) assert.ok(css.includes(`[data-je-slot="${slot}"]`) && css.includes(`${EDGE}:is([data-je-slot="tl"], [data-je-slot="tr"], [data-je-slot="bl"], [data-je-slot="br"]) { inset: var(--je-edge); }`));
  assert.ok(css.includes(`${EDGE}[data-je-slot="tc"] { top: var(--je-anchor-top, var(--je-edge)); }`));
  assert.ok(css.includes(`${EDGE}[data-je-slot="bc"] { bottom: var(--je-anchor-bottom, var(--je-edge)); }`));
  assert.ok(css.includes(`${EDGE}[data-je-slot="c"] { max-width: calc(100% - 2 * var(--je-edge)); }`));
  assert.ok(css.includes(`${EDGE}[data-je-slot="ml"] { left: var(--je-edge); }`));
  assert.ok(css.includes(`${EDGE}[data-je-slot="mr"] { right: var(--je-edge); }`));
  assert.match(css, /\[data-je-indicator-gap\]\[data-je-edge\] > \.je-tag-slot\[data-je-slot="tr"\] \{\s*top: calc\(var\(--je-edge\) \+ calc\(clamp\(20px, 3vw, 30px\) \* var\(--je-tag-scale, 1\)\)\);/);
  // The default inset and the legacy phone offsets are untouched.
  assert.match(css, /\[data-je-slot="br"\] \{\s*inset: 6px;/);
  assert.match(css, /margin-left: -2px;/);
});

test('a flush card measures the artwork radius once and centre budgets start at the edge', async t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagEdgeSpacing: 'flush', tagLayouts: onAnchor('tc') } });
  h.render();
  const proto = h.window.Element.prototype;
  const width = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
  const height = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get() { return 180; } });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return 270; } });
  const rect = h.window.HTMLElement.prototype.getBoundingClientRect;
  h.window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains('je-tag-host') ? { left: 0, right: 180, top: 0, bottom: 270, width: 180, height: 270 } : { left: 0, right: 20, top: 0, bottom: 18, width: 20, height: 18 };
  };
  try {
    h.layout.refreshPresentation(h.host());
    h.layout.flushFit();
    assert.equal(h.host().style.getPropertyValue('--je-card-radius'), '5px');
    const tc = h.host().querySelector('[data-je-slot="tc"]');
    assert.equal(tc.style.getPropertyValue('--je-anchor-top'), '0px');
    assert.equal(tc.style.getPropertyValue('--je-anchor-reserve'), '0px');
    await h.apply({ tagEdgeSpacing: 'tight' });
    h.layout.flushFit();
    const tight = h.host().querySelector('[data-je-slot="tc"]');
    assert.equal(tight.style.getPropertyValue('--je-anchor-top'), '3px');
    assert.equal(tight.style.getPropertyValue('--je-anchor-reserve'), '3px');
    await h.apply({ tagEdgeSpacing: 'default' });
    h.layout.flushFit();
    assert.equal(h.host().querySelector('[data-je-slot="tc"]').style.getPropertyValue('--je-anchor-top'), '6px');
  } finally {
    Object.defineProperty(proto, 'clientWidth', width);
    Object.defineProperty(proto, 'clientHeight', height);
    h.window.HTMLElement.prototype.getBoundingClientRect = rect;
  }
});

for (const edge of ['tight', 'flush']) for (const [scale, gap] of [['smaller', 'tight'], ['largest', 'roomy']]) {
  test(`${edge} edge remains independent of ${scale}/${gap}, including shape looks`, async t => {
    const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagEdgeSpacing: edge, tagScale: scale, tagGap: gap,
      tagShapeOverrides: { landscape: { layout: 'corners', tagScale: 'default', tagGap: 'default' } } } });
    h.render();
    for (const slot of ANCHORS) {
      await h.apply({ tagLayouts: onAnchor(slot) });
      assert.equal(h.host().dataset.jeEdge, edge);
      assert.equal(h.host().style.getPropertyValue('--je-tag-scale'), scale === 'smaller' ? '0.85' : '1.3');
      assert.equal(h.host().style.getPropertyValue('--je-tag-gap'), gap === 'tight' ? '0.75' : '1.5');
    }
    const conf = h.layout.resolveLayout(h.host());
    assert.equal(conf.edge, edge);
    const landscape = h.layout.normalizeSettings(h.JE.currentSettings, h.JE.pluginConfig).shapes.landscape;
    assert.equal(landscape.tagScale, 'default');
    assert.equal(landscape.tagGap, 'default');
  });
}
