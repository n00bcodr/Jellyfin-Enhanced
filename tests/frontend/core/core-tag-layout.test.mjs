import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { createHarness, deferred, plain } from '../helpers/harness.mjs';

const DAY = 24 * 60 * 60 * 1000;
const ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** Jellyfin 12 Modern card: title block directly after .cardScalable. */
const modernCard = (id = ID) => `<div class="card overflowPortraitCard card-hoverable card-withuserdata" data-id="${id}" data-type="Movie"><div class="cardBox cardBox-bottompadded"><div class="cardScalable"><div class="cardPadder cardPadder-overflowPortrait"></div><canvas class="blurhash-canvas"></canvas><a class="cardImageContainer coveredImage cardContent itemAction lazy" style="background-image:url(&quot;http://jellyfin.test/Items/${id}/Images/Primary&quot;)"></a><div class="je-tag-host"></div><div class="cardOverlayContainer itemAction"><div class="cardOverlayButton-br flex"></div></div></div><div class="cardText cardTextCentered cardText-first">Title</div><div class="cardText cardTextCentered cardText-secondary">2026</div></div></div>`;
/** Legacy visual card: title block inside a .cardFooter. */
const legacyCard = (id = ID) => `<div class="card portraitCard" data-id="${id}" data-type="Movie"><div class="cardBox visualCardBox"><div class="cardScalable"><div class="cardPadder cardPadder-portrait"></div><div class="cardImageContainer coveredImage cardContent"></div><div class="je-tag-host"></div><div class="cardOverlayContainer"></div></div><div class="cardFooter visualCardBox-cardFooter"><div class="cardText cardText-first">Title</div></div></div></div>`;
/** Large list row: the tag target is the image itself. */
const listRow = (id = ID) => `<div class="listItem" data-id="${id}" data-type="Movie"><div class="listItemImage listItemImage-large"></div><div class="listItemBody"><div class="listItemBodyText">Title</div></div></div>`;

/** A tag-cache entry with something for every group. */
function entry(overrides = {}) {
  return {
    Type: 'Movie', TmdbId: '42',
    Genres: ['Drama', 'Crime', 'Thriller', 'Comedy', 'War'],
    CommunityRating: 8.12, CriticRating: 91, OfficialRating: 'PG-13',
    AudioLanguages: ['en', 'fr', 'de', 'ja'],
    DateCreated: new Date(Date.UTC(2026, 9, 29)).toISOString(),
    PremiereDate: new Date(Date.UTC(2001, 0, 1)).toISOString(),
    StreamData: {
      Streams: [
        { Type: 'Video', Codec: 'hevc', Height: 2160, VideoRangeType: 'DOVIWithHDR10', DisplayTitle: '4K HEVC Dolby Vision' },
        { Type: 'Audio', Language: 'eng', Codec: 'truehd', Channels: 8, ChannelLayout: '7.1', DisplayTitle: 'English - TrueHD Atmos 7.1' },
      ],
      Sources: [{ Path: 'Movie (2020).mkv', Name: 'Movie (2020)' }], ItemName: 'Movie', ItemPath: 'Movie (2020).mkv',
    },
    ...overrides,
  };
}

/**
 * The real tag renderers, factory and layout controller over one page of
 * cards, rendering tag-cache entries the way the pipeline's server-cache path
 * does (every enabled renderer into the card's host, in registration order).
 */
function setup(t, { html = modernCard(), settings = {}, plugin = {}, reviews = null, reviewSource = null } = {}) {
  const renderers = new Map();
  const userChange = new Map();
  const reviewListeners = [];
  const h = createHarness({
    html,
    JE: {
      currentSettings: {
        qualityTagsEnabled: true, genreTagsEnabled: true, languageTagsEnabled: true, ratingTagsEnabled: true,
        ageRatingTagsEnabled: true, statusTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none', ...settings,
      },
      pluginConfig: { TagCacheServerMode: true, ...(reviews || reviewSource ? { ShowUserReviews: true, ShowUserRatingOnPosters: true } : {}), ...plugin },
      t: key => key,
      cdn: { flagSvg: code => `http://jellyfin.test/flags/${code}.svg` },
      session: { getUserId: () => 'a', getServerId: () => 's', getEpoch: () => 0, isCurrent: () => true, onUserChange: (name, fn) => userChange.set(name, fn) },
      _cacheManager: { register() {}, markDirty() {} },
      tagPipeline: {
        registerRenderer: (name, r) => renderers.set(name, r), getRenderer: name => renderers.get(name),
        clearProcessed() {}, scheduleScan() {},
        peekReviewRatings: () => (reviewSource ? reviewSource.peek() : reviews), getReviewRatingsRequestedAt: () => 1,
        getReviewRatings: async () => (reviewSource ? reviewSource.get() : reviews), onReviewRatingsChanged: fn => reviewListeners.push(fn),
      },
    },
  });
  t.after(() => h.close());
  h.window.Date.now = () => Date.UTC(2026, 9, 30);
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js',
    'tags/qualitytags.js', 'tags/genretags.js', 'tags/languagetags.js', 'tags/rating-sources.js', 'tags/ratingtags.js', 'tags/ageratingtags.js', 'tags/status-vocabulary.js', 'tags/statustags.js', 'tags/userreviewtags.js']) h.load(file);
  const JE = h.JE;
  JE.initializeQualityTags(); JE.initializeGenreTags(); JE.initializeRatingTags(); JE.initializeAgeRatingTags(); JE.initializeStatusTags(); JE.initializeLanguageTags();
  if (reviews || reviewSource) JE.initializeUserReviewTags();
  const layout = JE.core.tagLayout;
  const targetOf = (root = h.document) => root.querySelector('.je-tag-host') || root.querySelector('.listItemImage');
  return Object.assign(h, {
    renderers, userChange, layout, reviewListeners,
    /** Render an entry into a card (default: the first) through every enabled renderer. */
    render(e = entry(), target = targetOf(), id = ID) {
      for (const [, r] of renderers) if (r.isEnabled() && r.renderFromServerCache) r.renderFromServerCache(target, e, id);
      return target;
    },
    host: () => h.document.querySelector('.je-tag-host'),
    target: targetOf,
    /** Group ids in a slot, in DOM order. */
    slot(name, root = h.document) {
      const el = name === 'caption' ? root.querySelector('.je-tag-caption') : root.querySelector(`.je-tag-host > .je-tag-slot[data-je-slot="${name}"]`);
      return el ? Array.from(el.children, c => c.dataset.jeGroup || c.className) : null;
    },
    /** Apply new settings the way the panel does. */
    async apply(changes) { Object.assign(JE.currentSettings, changes); await JE.reinitializeTagLayout(); },
  });
}

const groupEl = (root, group, slot) => root.querySelector(`.je-tag-slot[data-je-slot="${slot}"] > [data-je-group="${group}"]`);

test('a legacy document keeps corners, its positions, arrival order and the original limits whatever the admin defaults are', t => {
  const plugin = { TagLayout: 'summary', TagLabelDensity: 'compact', TagGroupOrder: ['genre'], TagGroupCaps: { Genre: 9 }, GenreTagsPosition: 'bottom-left' };
  const h = setup(t, { settings: { tagLayout: 'bands', tagLabelDensity: 'compact', qualityTagsPosition: 'bottom-right', ratingTagsPosition: 'top-left' }, plugin });
  const s = h.layout.normalizeSettings();
  assert.equal(s.legacy, true);
  assert.equal(s.layout, 'corners');
  assert.equal(s.density, 'full');
  assert.equal(s.order, null, 'legacy documents keep arrival order');
  assert.deepEqual(plain(s.caps), { quality: 0, genre: 3, language: 3, rating: 0, ageRating: 1, status: 1, awards: 2 });
  assert.deepEqual(plain(s.slots), { status: 'tr', quality: 'br', rating: 'tl', ageRating: 'br', language: 'bl', genre: 'bl', awards: 'tl' },
    'positions map user → admin → built-in (genre inherits the admin bottom-left)');
});

test('a normalized document inherits admin profiles and caps, overrides them per value, and keeps its own order', t => {
  const h = setup(t, {
    settings: {
      tagLayoutSettingsVersion: 1, tagLayout: 'BANDS', tagLabelDensity: 'compact',
      tagLayouts: { bands: { groups: [{ Group: 'agerating', Slot: 'BOTTOM' }, { group: 'quality', slot: 'middle' }, { group: 'genre', slot: 'top' }] } },
      tagGroupOrder: ['genre', 'nope', 'genre'], tagGroupCaps: { language: 40, status: -1 },
    },
    plugin: { TagLayouts: { Bands: { Groups: [{ Group: 'Rating', Slot: 'top' }] } }, TagGroupOrder: ['quality'], TagGroupCaps: { Genre: 2, Rating: 'x' } },
  });
  const s = h.layout.normalizeSettings();
  assert.equal(s.legacy, false);
  assert.equal(s.layout, 'bands');
  assert.equal(s.density, 'compact');
  assert.deepEqual(plain(s.slots), { status: 'top', quality: 'bottom', rating: 'top', ageRating: 'bottom', language: 'bottom', genre: 'top', awards: 'bottom' },
    'own valid slots win, the admin profile fills in, then the built-in profile (invalid "middle" ignored)');
  assert.deepEqual(plain(s.order), ['genre', 'status', 'quality', 'rating', 'ageRating', 'language', 'awards'], 'own order wins and is completed in default order');
  assert.deepEqual(plain(s.caps), { quality: 0, genre: 2, language: 10, rating: 0, ageRating: 1, status: 0, awards: 2 }, 'clamped 0..10; admin caps fill gaps');
  // The admin order only reaches users by being copied in (seeding, apply to all, Reset).
  h.JE.currentSettings.tagGroupOrder = null;
  h.layout.invalidateSettings();
  assert.deepEqual(plain(h.layout.normalizeSettings().order), ['status', 'quality', 'rating', 'ageRating', 'language', 'genre', 'awards'],
    'without an own order bands uses the default order, not the admin order');
  h.JE.currentSettings.tagLayout = 'corners';
  h.layout.invalidateSettings();
  assert.equal(h.layout.normalizeSettings().order, null, 'without an own order corners keeps arrival order');
});

test('config.js keeps structured layout values as stored and drops malformed ones', t => {
  const h = createHarness({ JE: { pluginConfig: { TagLayout: 'caption' }, userConfig: { settings: {
    tagLayoutSettingsVersion: 1, tagLayout: 'minimal', tagLayouts: { minimal: { groups: [{ Group: 'quality', Slot: 'dots' }] } },
    tagGroupOrder: ['status'], tagGroupCaps: [1, 2],
  } } } });
  t.after(() => h.close());
  h.load('tags/rating-sources.js'); h.load('enhanced/config.js');
  const merged = h.JE.loadSettings();
  assert.equal(merged.tagLayout, 'minimal');
  assert.equal(merged.tagLayoutSettingsVersion, 1);
  assert.equal(merged.tagLabelDensity, 'full');
  assert.deepEqual(JSON.parse(JSON.stringify(merged.tagLayouts)), { minimal: { groups: [{ Group: 'quality', Slot: 'dots' }] } });
  assert.deepEqual(Array.from(merged.tagGroupOrder), ['status']);
  assert.equal(merged.tagGroupCaps, null, 'an array is not a caps object');
  h.JE.userConfig.settings = {};
  const fresh = h.JE.loadSettings();
  assert.equal(fresh.tagLayoutSettingsVersion, 0);
  assert.equal(fresh.tagLayouts, null);
});

test('corners keep each group wrapper and corner marker, stack shared corners in arrival order and apply the caps', t => {
  const h = setup(t);
  const host = h.render();
  assert.equal(host.dataset.jeLayout, 'corners');
  assert.equal(Array.from(host.children).some(c => !c.classList.contains('je-tag-slot')), false, 'every group lives in a named slot');
  assert.deepEqual(h.slot('tl'), ['quality']);
  assert.deepEqual(h.slot('tr'), ['genre', 'status'], 'registration order: genre, then status');
  assert.deepEqual(h.slot('br'), ['rating', 'ageRating']);
  assert.deepEqual(h.slot('bl'), ['language']);
  const quality = groupEl(host, 'quality', 'tl');
  assert.ok(quality.classList.contains('quality-overlay-container'));
  assert.equal(quality.dataset.jeCorner, 'top-left');
  assert.equal(groupEl(host, 'ageRating', 'br').dataset.jeCorner, 'bottom-right');
  assert.deepEqual(Array.from(quality.children, c => c.textContent), ['4K', 'Dolby Vision', 'HEVC', 'ATMOS 7.1']);
  assert.equal(host.querySelectorAll('.genre-overlay-container .genre-tag').length, 3, 'genre cap 3 of 5');
  assert.equal(host.querySelectorAll('.language-overlay-container .language-flag').length, 3, 'language cap 3 of 4');
  assert.equal(host.querySelectorAll('.rating-tag').length, 2);
  assert.equal(h.document.querySelector('.je-tag-caption'), null);
  assert.ok(h.document.getElementById('je-tag-layout'), 'the layout stylesheet is injected with the first host');
});

test('an explicit order re-sorts shared corners and the indicator gap follows an exact top-right group', async t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagGroupOrder: ['status', 'ageRating'] } });
  const host = h.render();
  assert.deepEqual(h.slot('tr'), ['status', 'genre']);
  assert.deepEqual(h.slot('br'), ['ageRating', 'rating']);
  assert.equal(host.dataset.jeIndicatorGap, '1');
  await h.apply({ genreTagsPosition: 'top', statusTagsPosition: 'bottom-left' });
  assert.deepEqual(h.slot('tr'), ['genre'], 'a stray "top" is still drawn top-right');
  assert.equal(host.dataset.jeIndicatorGap, undefined, 'only exactly "top-right" earns the indicator gap');
});

test('bands put status and age rating in the top band, the rest in the bottom band, genre off', async t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'bands' } });
  const host = h.render();
  assert.equal(host.dataset.jeLayout, 'bands');
  assert.deepEqual(h.slot('top'), ['status', 'ageRating'], 'priority order: first group on the left');
  assert.deepEqual(h.slot('bottom'), ['quality', 'rating', 'language']);
  assert.equal(host.querySelector('.genre-overlay-container'), null);
  assert.equal(h.layout.hasGroup(host, 'genre'), true, 'an off group is still held (and not re-rendered)');
  assert.equal(groupEl(host, 'quality', 'bottom').dataset.jeCorner, undefined, 'corner markers belong to corners only');
});

test('caption inserts its outlet between the image block and the title on Modern and legacy cards', t => {
  for (const html of [modernCard(), legacyCard()]) {
    const h = setup(t, { html, settings: { tagLayoutSettingsVersion: 1, tagLayout: 'caption' } });
    h.render();
    const outlet = h.document.querySelector('.je-tag-caption');
    assert.ok(outlet, 'outlet created');
    assert.equal(outlet.previousElementSibling.className, 'cardScalable');
    assert.ok(outlet.nextElementSibling.matches('.cardText-first, .cardFooter'));
    assert.equal(outlet.parentElement.classList.contains('cardBox'), true);
    assert.equal(h.document.querySelector('.cardImageContainer').children.length, 0, 'nothing inside the image');
    assert.deepEqual(h.slot('caption'), ['quality', 'rating', 'ageRating', 'language'], 'priority order; genre off');
    assert.deepEqual(h.slot('poster'), ['status']);
    assert.equal(h.document.querySelectorAll('.je-tag-caption').length, 1);
  }
});

test('caption space is reserved before the data arrives, and never in ignored contexts', t => {
  const html = modernCard() + `<div id="itemDetailPage"><div class="infoWrapper">${modernCard('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')}</div></div>`;
  const h = setup(t, { html, settings: { tagLayoutSettingsVersion: 1, tagLayout: 'caption' } });
  const [first, detail] = h.document.querySelectorAll('.je-tag-host');
  h.layout.prepareCard(first);
  h.layout.prepareCard(detail);
  assert.equal(h.document.querySelectorAll('.je-tag-caption').length, 1);
  assert.equal(first.closest('.cardBox').querySelector('.je-tag-caption').children.length, 0, 'empty, reserved');
  h.render(entry(), first);
  assert.equal(h.document.querySelectorAll('.je-tag-caption').length, 1, 'the reserved outlet is filled, not duplicated');
  assert.equal(h.slot('caption').length, 4);
});

test('list rows have no caption topology: caption groups fall back to the poster slot', t => {
  const h = setup(t, { html: listRow(), settings: { tagLayoutSettingsVersion: 1, tagLayout: 'caption' } });
  const image = h.document.querySelector('.listItemImage');
  h.render(entry(), image);
  assert.equal(h.document.querySelector('.je-tag-caption'), null);
  const host = image.querySelector(':scope > .je-tag-host');
  assert.ok(host, 'a host is created inside the row image');
  assert.deepEqual(h.slot('poster'), ['status', 'quality', 'rating', 'ageRating', 'language']);
});

test('summary shows up to three facts in priority order in one pill and every group on hover', t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'summary' } });
  const host = h.render();
  const pill = host.querySelector('.je-tag-slot[data-je-slot="pill"] .je-tag-pill');
  assert.equal(pill.textContent, 'status_tag_just_added·4K DV·★ 8.1'.replace('status_tag_just_added', pill.querySelector('[data-je-group="status"]').textContent));
  assert.deepEqual(Array.from(pill.querySelectorAll('.je-tag-pill-fact'), f => f.dataset.jeGroup), ['status', 'quality', 'rating']);
  assert.equal(pill.querySelector('.je-tag-pill-glyph').getAttribute('aria-hidden'), 'true');
  assert.match(pill.getAttribute('aria-label'), /4K DV, 8\.1$/);
  assert.deepEqual(h.slot('hover'), ['status', 'quality', 'rating', 'ageRating', 'language', 'genre'], 'full chips of every non-off group');
  assert.equal(host.querySelectorAll('.je-tag-slot[data-je-slot="hover"] .genre-tag').length, 3, 'hover chips are capped too');
});

test('summary pill displays named-source rating text with an accessible label', t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'summary',
    ratingTagsSources: ['imdb'], statusTagsEnabled: false, qualityTagsEnabled: false } });
  const host = h.render(entry({ Ratings: { imdb: 8.1 } }));
  const source = host.querySelector('.rating-tag--source');
  const fact = host.querySelector('.je-tag-pill-fact[data-je-group="rating"]');
  assert.equal(fact.textContent, source.getAttribute('aria-label'));
  assert.match(fact.textContent, /8\.1/);
  assert.ok(host.querySelector('.je-tag-pill').getAttribute('aria-label').includes(fact.textContent));
  assert.ok(!host.querySelector('.je-tag-pill').textContent.includes('undefined'));
});

test('summary pill facts for language and genre, and the three-fact limit', async t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'summary', statusTagsEnabled: false, qualityTagsEnabled: false,
    tagLayouts: { summary: { groups: [{ group: 'language', slot: 'pill' }, { group: 'genre', slot: 'pill' }, { group: 'ageRating', slot: 'pill' }] } } } });
  const host = h.render();
  const facts = Array.from(host.querySelectorAll('.je-tag-pill-fact'));
  assert.deepEqual(facts.map(f => f.dataset.jeGroup), ['rating', 'ageRating', 'language'], 'genre is the fourth pill group: left out');
  assert.equal(facts[1].textContent, 'PG-13');
  assert.ok(facts[2].querySelector('img.je-tag-pill-flag'), 'language contributes its first flag');
  await h.apply({ tagLayouts: { summary: { groups: [{ group: 'genre', slot: 'pill' }, { group: 'rating', slot: 'off' }] } } });
  assert.equal(host.querySelector('.je-tag-pill-fact[data-je-group="genre"]').textContent, 'Drama');
  assert.equal(host.querySelector('.rating-overlay-container'), null, 'an off group shows nowhere, not even on hover');
});

test('minimal draws quality dots with one label, rating in the corner, status on top', t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'minimal' } });
  const host = h.render();
  const dots = host.querySelector('.je-tag-slot[data-je-slot="dots"] .je-tag-dots');
  assert.deepEqual(Array.from(dots.children, d => d.dataset.jeDot), ['resolution', 'range', 'codec', 'audio']);
  assert.deepEqual(Array.from(dots.children, d => d.title), ['4K', 'Dolby Vision', 'HEVC', 'ATMOS 7.1']);
  assert.equal(dots.getAttribute('role'), 'img');
  assert.equal(dots.getAttribute('aria-label'), '4K, Dolby Vision, HEVC, ATMOS 7.1');
  assert.ok(Array.from(dots.children).every(d => d.getAttribute('aria-hidden') === 'true'));
  assert.deepEqual(h.slot('corner'), ['rating']);
  assert.deepEqual(h.slot('top'), ['status']);
  assert.deepEqual(h.slot('hover'), ['quality', 'rating', 'ageRating', 'language', 'genre'], 'summaries keep full chips for the reveal; status is already full');
  const css = h.document.getElementById('je-tag-layout').textContent;
  assert.match(css, /\[data-je-dot="resolution"\] \{ background: #1e88e5; \}/);
  assert.match(css, /\[data-je-dot="range"\] \{ background: #ef6c00; \}/);
  assert.match(css, /\[data-je-dot="audio"\] \{ background: #2e7d32; \}/);
  assert.match(css, /\[data-je-dot="codec"\] \{ background: #546e7a; \}/);
});

test('compact density shortens quality labels and drops the critic chip; caps cut the final chips; full comes back', async t => {
  const audio = (title, codec) => entry({ StreamData: { Streams: [
    { Type: 'Video', Codec: 'hevc', Height: 2160, VideoRangeType: 'HDR10Plus', DisplayTitle: '4K HEVC HDR10+' },
    { Type: 'Audio', Language: 'eng', Codec: codec, Channels: 6, ChannelLayout: '5.1', DisplayTitle: title }] } });
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLabelDensity: 'compact' } });
  const host = h.render(audio('English - Dolby Digital+ 5.1', 'eac3'));
  const labels = () => Array.from(host.querySelectorAll('.quality-overlay-label'), l => l.textContent);
  assert.deepEqual(labels(), ['4K', 'HDR+', 'HEVC', '5.1']);
  assert.equal(host.querySelector('.rating-tag-critic'), null);
  assert.ok(host.querySelector('.rating-tag-tmdb'));
  assert.equal(h.layout.compactQualityLabel('Dolby Vision'), 'DV');
  assert.equal(h.layout.compactQualityLabel('ATMOS 7.1'), 'ATMOS');
  await h.apply({ tagLabelDensity: 'full', tagGroupCaps: { quality: 2, language: 1, genre: 0 } });
  assert.deepEqual(labels(), ['4K', 'HDR10+'], 'full labels restored from the master copy, then capped to 2');
  assert.equal(host.querySelectorAll('.language-flag').length, 1);
  assert.equal(host.querySelectorAll('.genre-tag').length, 5, '0 = unlimited');
  assert.ok(host.querySelector('.rating-tag-critic'), 'critic chip back in full density');
});

test('hide-on-hover keeps the summary and minimal reveal; reveal follows hover and focus; the body class follows the user', async t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'summary', tagsHideOnHover: true } });
  h.render();
  const css = h.document.getElementById('je-tag-layout').textContent;
  assert.match(css, /body\.je-tags-hide-on-hover \.card:hover \.je-tag-host > \.je-tag-slot:not\(\[data-je-slot="hover"\]\)/);
  assert.match(css, /:is\(\.card, \.listItem\):is\(:hover, :focus-within\) \.je-tag-host > \.je-tag-slot\[data-je-slot="hover"\] \{ opacity: 1; \}/,
    'cards and list rows (a season\'s episodes) alike');
  assert.match(css, /:is\(\.card, \.listItem\):is\(:hover, :focus-within\) \.je-tag-host:not\(:has\(> \.je-tag-slot\[data-je-slot="hover"\]\[data-je-overflow\]\)\) > \.je-tag-slot:is\(\[data-je-slot="pill"\], \[data-je-slot="dots"\], \[data-je-slot="corner"\]\) \{ opacity: 0; \}/,
    'the summaries stay when the reveal had no room for a row');
  assert.match(css, /prefers-reduced-motion: reduce/);
  await h.JE.reinitializeTagLayout();
  assert.equal(h.document.body.classList.contains('je-tags-hide-on-hover'), true);
  await h.apply({ tagsHideOnHover: false });
  assert.equal(h.document.body.classList.contains('je-tags-hide-on-hover'), false);
  assert.equal(h.document.querySelectorAll('.je-tag-host [tabindex], .je-tag-caption [tabindex]').length, 0, 'no tab stop per chip');
});

test('switching layouts re-presents from the held facts and removes pills, dots, hover copies and outlets', async t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'summary' } });
  const host = h.render();
  assert.ok(host.querySelector('.je-tag-pill'));
  await h.apply({ tagLayout: 'minimal' });
  assert.equal(host.querySelector('.je-tag-pill'), null);
  assert.ok(host.querySelector('.je-tag-dots'));
  await h.apply({ tagLayout: 'caption' });
  assert.equal(host.querySelector('.je-tag-dots, .je-tag-slot[data-je-slot="hover"]'), null);
  assert.equal(h.document.querySelectorAll('.je-tag-caption').length, 1);
  await h.apply({ tagLayout: 'corners' });
  assert.equal(h.document.querySelector('.je-tag-caption'), null, 'outlet removed with the caption layout');
  assert.deepEqual(h.slot('tl'), ['quality']);
  assert.equal(host.dataset.jeLayout, 'corners');
});

test('a renderer reinitialize and the pipeline-wide cleanup remove every derived representation', async t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'summary' } });
  const host = h.render();
  h.JE.currentSettings.qualityTagsEnabled = false;
  h.JE.reinitializeQualityTags();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(host.querySelector('.je-tag-pill-fact[data-je-group="quality"]'), null, 'pill fact gone with its group');
  assert.equal(host.querySelector('.quality-overlay-container'), null, 'hover copy gone');
  assert.ok(host.querySelector('.je-tag-pill-fact[data-je-group="status"]'));
  await h.apply({ tagLayout: 'caption' });
  h.layout.clearAll();
  assert.equal(h.document.querySelector('.je-tag-caption, .je-tag-slot, .je-tag-pill'), null);
  assert.equal(h.layout.hasGroup(host, 'status'), false);
});

test('a user switch drops the outgoing user\'s facts; the incoming user\'s layout applies to new renders', async t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'caption' } });
  const host = h.render();
  assert.ok(h.document.querySelector('.je-tag-caption'));
  h.userChange.get('tag-layout')({ userId: 'b' });
  assert.equal(h.document.querySelector('.je-tag-caption, .je-tag-slot'), null);
  assert.equal(h.layout.hasGroup(host, 'quality'), false, 'renderers see the card as untagged and render it again');
  h.JE.currentSettings = { ...h.JE.currentSettings, tagLayout: 'bands' };
  await h.JE.reinitializeTagLayout();
  for (const name of ['jeQualityTagged', 'jeGenreTagged', 'jeLanguageTagged', 'jeRatingTagged', 'jeAgeRatingTagged', 'jeStatusTagged']) delete h.document.querySelector('.card').dataset[name];
  h.render();
  assert.equal(host.dataset.jeLayout, 'bands');
  assert.deepEqual(h.slot('bottom'), ['quality', 'rating', 'language']);
});

/**
 * The real tag pipeline (batch path, no server cache), shared DOM observer,
 * layout controller and genre renderer over one page of cards. Idle slices,
 * the fetch debounce and each /tag-data response are driven by the test.
 */
async function setupPipeline(t, { html = modernCard(), settings = {} } = {}) {
  const idle = [], timers = new Map(), calls = [];
  let seq = 0;
  const h = createHarness({
    html,
    globals: { requestIdleCallback: fn => idle.push(fn), setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimeout: id => timers.delete(id) },
    apiClient: { ajax: options => { const d = deferred(); calls.push({ ids: JSON.parse(options.data), resolve: d.resolve }); return d.promise; } },
    JE: {
      currentSettings: { genreTagsEnabled: true, ...settings },
      pluginConfig: { TagCacheServerMode: false },
      t: key => key,
      session: { getUserId: () => 'a', getServerId: () => 's', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} },
      helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} },
    },
  });
  t.after(() => h.close());
  for (const file of ['core/dom-observer.js', 'core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-pipeline.js', 'tags/tag-layout-styles.js', 'tags/genretags.js']) h.load(file);
  h.JE.initializeGenreTags();
  h.JE.tagPipeline.initialize();
  await settle(); // the start-up rescan once the (disabled) server cache "loaded"
  return Object.assign(h, {
    calls,
    /** Run every queued idle slice (scan chunks), including ones they queue. */
    scan() { while (idle.length) idle.shift()({ timeRemaining: () => 50 }); },
    /** Fire the batch fetch debounce. */
    fetch() { for (const [id, timer] of [...timers]) if (timer.ms === 150) { timers.delete(id); timer.fn(); } },
    genres: () => Array.from(h.document.querySelectorAll('.je-tag-host .genre-tag'), g => g.title),
  });
}

const OTHER = 'cccccccccccccccccccccccccccccccc';
/** Rewrite a card in place for another item (id and artwork), the way a virtualised list reuses it. */
function reuseCard(h, id) {
  h.document.querySelector('.card').setAttribute('data-id', id);
  h.document.querySelector('.cardImageContainer').style.backgroundImage = `url("http://jellyfin.test/Items/${id}/Images/Primary")`;
}

test('a card reused in place for another item drops the old item\'s tags and the pipeline renders the new one', async t => {
  const h = await setupPipeline(t);
  h.scan(); h.fetch();
  assert.deepEqual(h.calls[0].ids, [ID]);
  h.calls[0].resolve({ Items: [{ Id: ID, Type: 'Movie', Genres: ['Drama'] }] });
  await settle();
  assert.deepEqual(h.genres(), ['Drama']);
  reuseCard(h, OTHER);
  await settle();
  assert.deepEqual(h.genres(), [], 'the previous item\'s chips are gone as soon as the card changes');
  assert.equal(h.document.querySelector('.je-tag-slot'), null, 'and so are its slots');
  h.scan(); h.fetch();
  assert.deepEqual(h.calls[1].ids, [OTHER], 'the reused card is scanned again for its new item');
  h.calls[1].resolve({ Items: [{ Id: OTHER, Type: 'Movie', Genres: ['War'] }] });
  await settle();
  assert.deepEqual(h.genres(), ['War']);
});

test('a lookup still in flight when its card is reused never lands on the new item; a caption outlet goes with the old item', async t => {
  const h = await setupPipeline(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'caption', tagLayouts: { caption: { groups: [{ group: 'genre', slot: 'caption' }] } } } });
  h.scan(); h.fetch();
  assert.equal(h.document.querySelectorAll('.je-tag-caption').length, 1, 'caption space reserved at discovery');
  reuseCard(h, OTHER);
  await settle();
  h.calls[0].resolve({ Items: [{ Id: ID, Type: 'Movie', Genres: ['Drama'] }] });
  await settle();
  assert.deepEqual(h.genres(), []);
  assert.equal(h.document.querySelector('.je-tag-caption .genre-tag'), null, 'the late answer for the old item is dropped');
  h.scan(); h.fetch();
  assert.deepEqual(h.calls[1].ids, [OTHER]);
  h.calls[1].resolve({ Items: [{ Id: OTHER, Type: 'Movie', Genres: ['War'] }] });
  await settle();
  assert.deepEqual(Array.from(h.document.querySelectorAll('.je-tag-caption .genre-tag'), g => g.title), ['War']);
  assert.equal(h.document.querySelectorAll('.je-tag-caption').length, 1);
});

test('a large list row reused with only its artwork rewritten drops the old item\'s tags and renders the new one', async t => {
  const art = id => `background-image: url(&quot;http://jellyfin.test/Items/${id}/Images/Primary&quot;)`;
  const h = await setupPipeline(t, { html: listRow().replace(`data-id="${ID}"`, 'data-id="unresolved"').replace('class="listItemImage listItemImage-large"', `class="listItemImage listItemImage-large" style="${art(ID)}"`) });
  h.scan(); h.fetch();
  assert.deepEqual(h.calls[0].ids, [ID]);
  h.calls[0].resolve({ Items: [{ Id: ID, Type: 'Movie', Genres: ['Drama'] }] });
  await settle();
  assert.deepEqual(h.genres(), ['Drama']);
  assert.ok(h.document.querySelector('.listItemImage-large > .je-tag-host'), 'the tags live on the row image');
  // Without a valid Jellyfin data-id, only the artwork identifies the item.
  h.document.querySelector('.listItemImage-large').style.backgroundImage = `url("http://jellyfin.test/Items/${OTHER}/Images/Primary")`;
  await settle();
  assert.deepEqual(h.genres(), [], 'the previous item\'s chips are gone as soon as the artwork changes');
  h.scan(); h.fetch();
  assert.deepEqual(h.calls[1].ids, [OTHER], 'the reused row is scanned again for its new item');
  h.calls[1].resolve({ Items: [{ Id: OTHER, Type: 'Movie', Genres: ['War'] }] });
  await settle();
  assert.deepEqual(h.genres(), ['War']);
});

for (const earlyFacts of [false, true]) test(`artwork-only reuse drops library facts when the replacement lookup is empty (early facts=${earlyFacts})`, async t => {
  const library = '22222222222222222222222222222222';
  const html = (earlyFacts ? modernCard().replace('<div class="je-tag-host"></div>', '') : modernCard())
    .replace(`data-id="${ID}"`, 'data-id="unresolved"');
  const h = await setupPipeline(t, { html,
    settings: { tagLayoutSettingsVersion: 1, tagLayout: 'corners', tagLookRules: [
      { id: 'library', enabled: true, when: [{ field: 'library', value: library }], layout: 'bands', density: 'compact' },
    ] } });
  const layout = h.JE.core.tagLayout;
  if (earlyFacts) layout.setCardContext(h.document.querySelector('.cardScalable'), { Type: 'Movie', LibraryId: library }, ID);
  // A renderer cache can still supply chips when /tag-data returns no item.
  const render = target => {
    const chip = h.document.createElement('div');
    chip.innerHTML = '<span class="quality-overlay-label">4K</span>';
    layout.commitGroup(target, 'quality', chip);
    return true;
  };
  h.JE.tagPipeline.registerRenderer('quality', { isEnabled: () => true, renderFromCache: render, render });
  h.scan(); h.fetch();
  h.calls[0].resolve({ Items: [{ Id: ID, Type: 'Movie', LibraryId: library, Genres: ['Drama'] }] });
  await settle();
  const host = h.document.querySelector('.je-tag-host');
  assert.equal(host.dataset.jeLayout, 'bands');
  h.document.querySelector('.cardImageContainer').style.backgroundImage = `url("http://jellyfin.test/Items/${OTHER}/Images/Primary")`;
  await settle();
  assert.equal(h.document.querySelector('.card').dataset.id, 'unresolved', 'the non-item DOM identity is unchanged');
  h.scan(); h.fetch();
  assert.deepEqual(h.calls[1].ids, [OTHER]);
  h.calls[1].resolve({ Items: [] });
  await settle();
  assert.ok(host.querySelector('[data-je-group="quality"]'), 'cached chips are released after the empty lookup');
  assert.equal(host.dataset.jeLayout, 'corners', 'the replacement uses the default look');
  assert.equal(layout.resolveLayout(host).layout, 'corners', 'neither host nor original target retains old facts');
});

test('an episode keeps its own facts when its borrowed poster changes', async t => {
  const html = modernCard().replace('data-type="Movie"', 'data-type="Episode"');
  const h = await setupPipeline(t, { html });
  h.scan(); h.fetch();
  assert.deepEqual(h.calls[0].ids, [ID]);
  h.calls[0].resolve({ Items: [{ Id: ID, Type: 'Episode', Genres: ['Drama'] }] });
  await settle();
  h.document.querySelector('.cardImageContainer').style.backgroundImage = `url("http://jellyfin.test/Items/${OTHER}/Images/Primary")`;
  await settle();h.scan();h.fetch();
  assert.ok(h.calls.every(call => call.ids.every(id => id === ID)), 'artwork never supplies the episode identity');
  for (const call of h.calls.slice(1)) call.resolve({ Items: [{ Id: ID, Type: 'Episode', Genres: ['Drama'] }] });
  await settle();
  assert.deepEqual(h.genres(), ['Drama']);
});

test('artwork loading for the first time is not a reuse', async t => {
  const h = await setupPipeline(t, { html: modernCard().replace(/ style="[^"]*"/, '') });
  h.scan(); h.fetch();
  h.calls[0].resolve({ Items: [{ Id: ID, Type: 'Movie', Genres: ['Drama'] }] });
  await settle();
  h.document.querySelector('.cardImageContainer').style.backgroundImage = `url("http://jellyfin.test/Items/${OTHER}/Images/Primary")`;
  await settle();
  assert.deepEqual(h.genres(), ['Drama'], 'an episode card\'s artwork may name its series');
  h.scan(); h.fetch();
  assert.equal(h.calls.length, 1);
});

test('the user review chip joins the rating group and follows its slot and summary', async t => {
  const h = setup(t, { reviews: new Map([['movie:42', 4.5]]), settings: { tagLayoutSettingsVersion: 1, tagLayout: 'minimal' } });
  const host = h.render();
  assert.deepEqual(Array.from(host.querySelectorAll('.je-tag-slot[data-je-slot="corner"] .rating-tag'), c => c.className.split(' ')[1]),
    ['rating-tag-critic', 'rating-tag-tmdb', 'rating-tag-userreview']);
  assert.equal(host.querySelector('.je-tag-slot[data-je-slot="corner"] .je-userreview-tag .rating-text').textContent, '9');
  // Review-only card (no TMDB/RT rating): the chip creates the rating group.
  await h.apply({ tagLayout: 'summary', tagLayouts: { summary: { groups: [{ group: 'status', slot: 'off' }, { group: 'quality', slot: 'off' }] } } });
  h.layout.clearAll();
  delete h.document.querySelector('.card').dataset.jeRatingTagged;
  h.renderers.get('rating').renderFromServerCache(host, entry({ CommunityRating: null, CriticRating: null }), ID);
  assert.equal(host.querySelector('.je-tag-pill-fact[data-je-group="rating"]').textContent, '♥ 9');
});

test('a review lookup that answers after its card was reused for another item adds nothing to the new item', async t => {
  // The averages are still loading when A renders, so A's chip waits on them.
  const loading = deferred();
  let averages = null;
  const h = setup(t, { reviewSource: { peek: () => averages, get: () => loading.promise.then(() => averages) } });
  const host = h.render();
  assert.equal(host.querySelector('.je-userreview-tag'), null, 'A\'s lookup is still out');
  assert.equal(host.dataset.jeReviewKey, 'movie:42');
  h.document.querySelector('.card').setAttribute('data-id', OTHER);
  h.render(entry({ TmdbId: null, CommunityRating: 6.5 }), host, OTHER);
  averages = new Map([['movie:42', 4.5]]);
  loading.resolve();
  await settle();
  assert.equal(host.querySelector('.je-userreview-tag'), null, 'A\'s answer is not committed to B');
  for (const listener of h.reviewListeners) listener(null);
  assert.equal(host.querySelector('.je-userreview-tag'), null, 'nor does a later change to A\'s average reach B');
  assert.equal(host.dataset.jeReviewKey, undefined, 'A\'s stale key is dropped');
  assert.deepEqual(Array.from(host.querySelectorAll('.rating-tag .rating-text'), r => r.textContent), ['91%', '6.5'], 'B\'s own ratings');
});

test('a review lookup cut short by clearing the card adds nothing', async t => {
  const loading = deferred();
  let averages = null;
  const h = setup(t, { reviewSource: { peek: () => averages, get: () => loading.promise.then(() => averages) } });
  const host = h.render();
  h.layout.clearCard(host);
  assert.equal(host.dataset.jeReviewKey, undefined, 'cleanup drops the review key');
  delete h.document.querySelector('.card').dataset.jeRatingTagged;
  averages = new Map([['movie:42', 4.5]]);
  loading.resolve();
  await settle();
  assert.equal(host.querySelector('.je-userreview-tag'), null);
});

test('summary pill facts come from the capped chips, not the full group', t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'summary', tagGroupCaps: { quality: 1, rating: 1 } } });
  const host = h.render();
  const fact = group => host.querySelector(`.je-tag-pill-fact[data-je-group="${group}"]`).textContent;
  assert.equal(fact('quality'), '4K', 'Dolby Vision is past the quality cap of 1');
  assert.equal(fact('rating'), '91%', 'the community score is past the rating cap of 1; the critic chip is first');
  assert.deepEqual(Array.from(host.querySelectorAll('.je-tag-slot[data-je-slot="hover"] .quality-overlay-label'), l => l.textContent), ['4K'],
    'the pill names what the chips show');
});

/** Give an element fixed layout metrics (JSDOM lays nothing out). */
function measure(el, { width = 0, clientWidth = width, scrollWidth = clientWidth } = {}) {
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => clientWidth });
  Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => scrollWidth });
  el.getBoundingClientRect = () => ({ width, height: 18, top: 0, left: 0, right: width, bottom: 18 });
}

test('a summary pill too wide for its card drops its lowest-priority facts whole and keeps the full text accessible', t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'summary' } });
  const host = h.render();
  const pill = host.querySelector('.je-tag-pill');
  const css = h.document.getElementById('je-tag-layout').textContent;
  assert.match(css, /\.je-tag-pill \{\s*display: block;\s*min-width: 0;/, 'one constrained text run');
  assert.match(css, /\.je-tag-pill-fact \{ display: inline; \}/, 'facts are inline, not shrink-proof flex items');
  measure(host, { width: 150 });
  measure(pill, { clientWidth: 120, scrollWidth: 170 });
  const [status, quality, rating] = pill.querySelectorAll('.je-tag-pill-fact');
  measure(status, { width: 50 }); measure(quality, { width: 40 }); measure(rating, { width: 60 });
  for (const sep of pill.querySelectorAll('.je-tag-pill-sep')) measure(sep, { width: 10 });
  h.layout.flushFit();
  assert.deepEqual(Array.from(pill.querySelectorAll('[data-je-overflow]'), el => el.className), ['je-tag-pill-sep', 'je-tag-pill-fact'],
    'the rating fact (and the separator before it) is dropped; no fact is cut in half');
  assert.equal(rating.hasAttribute('data-je-overflow'), true);
  assert.match(pill.title, /4K DV · 8\.1$/, 'the title keeps every fact');
  assert.match(pill.getAttribute('aria-label'), /4K DV, 8\.1$/);
  h.layout.refreshPresentation(host);
  const wider = host.querySelector('.je-tag-pill');
  measure(wider, { clientWidth: 200, scrollWidth: 200 });
  h.layout.flushFit();
  assert.equal(wider.querySelector('[data-je-overflow]'), null, 'everything fits on a wider card');
});

test('chipsThatFit wraps like flex-wrap and leaves room for the "+N" chip', t => {
  const h = setup(t);
  const fit = (...args) => h.layout.chipsThatFit(...args).map(Number).join('');
  assert.equal(fit([30, 30, 30, 30], 100, 3, 2, 20), '1111', 'three on row one, one on row two: everything fits');
  assert.equal(fit([30, 30, 30, 30, 30, 30, 30], 100, 3, 2, 20), '1111100', 'row two keeps room for "+2"');
  assert.equal(fit([30, 30, 30, 30, 30, 30], 100, 3, 2, 20), '111111', 'exactly two full rows need no "+N"');
  assert.equal(fit([30, 150, 30, 30], 100, 3, 1, 20), '1010', 'a chip wider than the row can never be shown whole: it goes behind "+N" and the rest still fill the rows');
  assert.equal(fit([150], 100, 3, 2, 20), '0', 'only "+1" is left');
  // Measured in the lab: a bottom band 0.4px short of room for "+2" wraps it to a third row.
  assert.equal(fit([36.5, 33.5, 24.5, 34.6, 50, 16.9, 16.9, 16.9], 101, 3, 2, 24), '11110100', 'the second flag goes behind "+N" instead');
  // Measured in the lab: a 113px caption strip, full labels.
  assert.equal(fit([37, 34, 93, 40, 35, 36, 19.2, 20, 20, 20], 109, 3, 2, 22), '1101100000',
    '"Dolby Digital+ 5.1" fits a row only without "+N" after it: the rating chips fill row two instead of leaving it empty');
});

test('chipsThatFit reports the row the "+N" chip lands on, and rowsHeight counts it', t => {
  const h = setup(t);
  const more = { row: -1 };
  const rows = [];
  // Three narrow chips fill row one (96 of 101px); both wide chips are hidden, so "+2" has
  // no room after the chips and wraps onto a second row of its own.
  assert.equal(h.layout.chipsThatFit([30, 30, 30, 80, 80], 101, 3, 2, 20, rows, more).map(Number).join(''), '11100');
  assert.deepEqual(rows, [1, 1, 1, 0, 0]);
  assert.equal(more.row, 2, '"+N" wraps below the shown chips');
  assert.equal(h.layout.rowsHeight([true, true, true, false, false], rows, [18, 18, 18, 18, 18], 18, 3, more.row), 39, 'two rows: the chips and the "+N" row');
  // With room after the last shown chip, "+N" shares its row.
  rows.length = 0;
  assert.equal(h.layout.chipsThatFit([30, 30, 80, 80], 101, 3, 2, 20, rows, more).map(Number).join(''), '1100');
  assert.equal(more.row, 1);
  assert.equal(h.layout.rowsHeight([true, true, false, false], rows, [18, 18, 18, 18], 18, 3, more.row), 18);
  // On the last allowed row the room was reserved, so it always shares the row.
  rows.length = 0;
  h.layout.chipsThatFit([30, 30, 30, 30, 30, 30, 30], 100, 3, 2, 20, rows, more);
  assert.equal(more.row, 2);
  // Everything shown: no "+N" row.
  h.layout.chipsThatFit([30, 30], 100, 3, 2, 20, [], more);
  assert.equal(more.row, 0);
});

/** Give a card's wrapping slot (default: the caption strip), its chips and "+N" chip fixed widths, then run the fitting pass. */
function fitCaption(h, { card = 120, outlet = 100, chip = 30, more = 20, slot = () => h.document.querySelector('.je-tag-caption') } = {}) {
  const host = h.host();
  h.layout.refreshPresentation(host); // queues the card for the fitting pass
  const strip = slot();
  measure(host, { width: card });
  measure(strip, { width: outlet });
  for (const el of strip.querySelectorAll(':scope > [data-je-group] > *')) measure(el, { width: chip });
  // The pass adds the "+N" chip before measuring: size it as it appears.
  const proto = h.window.HTMLElement.prototype;
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function () { return this.classList.contains('je-tag-more') ? { width: more, height: 18 } : original.call(this); };
  try { h.layout.flushFit(); } finally { proto.getBoundingClientRect = original; }
  return strip;
}

test('the caption strip keeps two rows, hides the lowest-priority chips whole and counts them in a "+N" chip', t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'caption' } });
  h.render();
  const strip = fitCaption(h);
  const chips = Array.from(strip.querySelectorAll(':scope > [data-je-group] > *'));
  assert.equal(chips.length, 10, 'quality 4, rating 2, age 1, language 3');
  const shown = chips.filter(c => !c.hasAttribute('data-je-overflow'));
  assert.deepEqual(shown.map(c => c.closest('[data-je-group]').dataset.jeGroup), ['quality', 'quality', 'quality', 'quality', 'rating'],
    'priority order: the lowest-priority groups go first');
  const more = strip.lastElementChild;
  assert.ok(more.classList.contains('je-tag-more'));
  assert.equal(more.textContent, '+5');
  assert.equal(more.hasAttribute('data-je-overflow'), false);
  assert.match(more.title, /^rating_source_community: 8\.1, PG-13, /, 'the title names the hidden chips');
  // A wide card shows everything: no "+N".
  const wide = fitCaption(h, { outlet: 400 });
  assert.equal(wide.querySelectorAll('[data-je-group] [data-je-overflow]').length, 0);
  assert.equal(wide.lastElementChild.hasAttribute('data-je-overflow'), true, 'the "+N" chip is hidden');
  assert.equal(h.document.getElementById('je-tag-layout').textContent.includes('.je-tag-host [data-je-overflow], .je-tag-caption [data-je-overflow] { display: none !important; }'), true);
});

test('compact caption chips get the same two-row treatment, and a late group lands before the "+N" chip', t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'caption', tagLabelDensity: 'compact', statusTagsEnabled: false } });
  h.render();
  const strip = fitCaption(h);
  assert.equal(strip.lastElementChild.textContent, '+4', 'compact drops the critic chip: 9 chips, 5 shown');
  h.layout.commitGroup(h.host(), 'language', h.layout.getGroup(h.host(), 'language'));
  assert.ok(strip.lastElementChild.classList.contains('je-tag-more'), 'the overflow chip stays last');
  assert.equal(strip.lastElementChild.previousElementSibling.dataset.jeGroup, 'language');
});

test('the summary and minimal reveal uses compact labels, keeps to two rows with "+N" and to the bottom of the card', t => {
  for (const tagLayout of ['summary', 'minimal']) {
    const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout } });
    const host = h.render();
    const reveal = () => host.querySelector('.je-tag-slot[data-je-slot="hover"]');
    assert.deepEqual(Array.from(reveal().querySelectorAll('.quality-overlay-label'), l => l.textContent), ['4K', 'DV', 'HEVC', 'ATMOS'],
      `${tagLayout}: compact labels whatever the user's density`);
    assert.equal(reveal().querySelector('.rating-tag-critic'), null, 'compact drops the critic chip next to the community score');
    if (tagLayout === 'minimal') {
      assert.equal(host.querySelector('.je-tag-slot[data-je-slot="corner"] .rating-tag-critic') !== null, true, 'the corner score keeps the user\'s density');
    }
    const fitted = fitCaption(h, { slot: reveal, outlet: 112 }); // 6px side padding: 100px for chips
    const more = fitted.lastElementChild;
    assert.ok(more.classList.contains('je-tag-more'));
    assert.equal(fitted.querySelectorAll(':scope > [data-je-group] > :not([data-je-overflow])').length, 5, 'two rows of 30px chips in 100px, one place for "+N"');
    assert.equal(more.textContent, `+${fitted.querySelectorAll(':scope > [data-je-group] > [data-je-overflow]').length}`);
    const css = h.document.getElementById('je-tag-layout').textContent;
    assert.match(css, /\[data-je-slot="hover"\] \{\s*left: 0; right: 0; bottom: 0;\s*max-height: 40%;/, 'the reveal never grows past the bottom 40% of the card');
    assert.match(css, /\.je-tag-more \{[^}]*pointer-events: none;/, 'nothing in the reveal takes a click from Jellyfin\'s buttons');
  }
});

/**
 * Lay a page out by rule while the fitting pass runs: the host and slots get
 * the card width, chips and the "+N" chip fixed widths.
 */
function withLayout(h, { card, chip = 30, more = 20 }, fn) {
  const proto = h.window.HTMLElement.prototype;
  const rect = proto.getBoundingClientRect;
  const client = Object.getOwnPropertyDescriptor(h.window.Element.prototype, 'clientWidth');
  proto.getBoundingClientRect = function () {
    const width = this.classList.contains('je-tag-more') ? more : this.parentElement?.dataset?.jeGroup ? chip : 0;
    return { width, height: 18, top: 0, left: 0, right: width, bottom: 18 };
  };
  Object.defineProperty(h.window.Element.prototype, 'clientWidth', { configurable: true,
    get() { return this.matches('.je-tag-host, .je-tag-slot, .je-tag-caption') ? card : 0; } });
  try { return fn(); } finally {
    proto.getBoundingClientRect = rect;
    Object.defineProperty(h.window.Element.prototype, 'clientWidth', client);
  }
}

/**
 * Fit a card of the given size: the host, its slots and the caption strip get
 * the card width, the host the card height (the reveal's 40% resolves against
 * it), chips 30x18 and the "+N" chip 20x18.
 */
function fitCard(h, { width, height, chip = 30, more = 20, tall = null }) {
  const proto = h.window.HTMLElement.prototype;
  const rect = proto.getBoundingClientRect;
  const client = Object.getOwnPropertyDescriptor(h.window.Element.prototype, 'clientWidth');
  const clientH = Object.getOwnPropertyDescriptor(h.window.Element.prototype, 'clientHeight');
  proto.getBoundingClientRect = function () {
    const w = this.classList.contains('je-tag-more') ? more : this.parentElement?.dataset?.jeGroup ? chip : 0;
    const ht = !w ? 0 : tall && this.parentElement?.dataset?.jeGroup === tall ? 26 : 18;
    return { width: w, height: ht, top: 0, left: 0, right: w, bottom: ht };
  };
  Object.defineProperty(h.window.Element.prototype, 'clientWidth', { configurable: true,
    get() { return this.matches('.je-tag-host, .je-tag-slot, .je-tag-caption') ? width : 0; } });
  Object.defineProperty(h.window.Element.prototype, 'clientHeight', { configurable: true,
    get() { return this.matches('.je-tag-host') ? height : 0; } });
  try { h.layout.refreshPresentation(h.host()); h.layout.flushFit(); } finally {
    proto.getBoundingClientRect = rect;
    Object.defineProperty(h.window.Element.prototype, 'clientWidth', client);
    Object.defineProperty(h.window.Element.prototype, 'clientHeight', clientH);
  }
}

test('the reveal keeps only the chip rows its height has room for: one on a landscape thumbnail, two on a poster', t => {
  for (const tagLayout of ['summary', 'minimal']) {
    const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout } });
    h.render();
    const reveal = () => h.host().querySelector('.je-tag-slot[data-je-slot="hover"]');
    const shown = () => reveal().querySelectorAll(':scope > [data-je-group] > :not([data-je-overflow])').length;
    const more = () => reveal().lastElementChild;
    // A 113x64 episode thumbnail: 40% is 25.6px, less 18px + 6px padding leaves
    // no room for an 18px row; one row still fits above the bottom padding.
    fitCard(h, { width: 113, height: 64 });
    assert.equal(shown(), 2, `${tagLayout}: one row of 30px chips in 101px, with room for "+N"`);
    assert.ok(more().classList.contains('je-tag-more'));
    assert.equal(more().hasAttribute('data-je-overflow'), false, 'the "+N" chip shares the row that fits');
    assert.equal(more().textContent, `+${reveal().querySelectorAll(':scope > [data-je-group] > [data-je-overflow]').length}`);
    // A 113x170 poster: 68px less padding holds both rows.
    fitCard(h, { width: 113, height: 170 });
    assert.equal(shown(), 5, 'two rows on a portrait card');
    assert.equal(more().hasAttribute('data-je-overflow'), false);
    // 40% of 113x120 is 48px, 24px for chips: one 18px row. 135 → 54px less 24: 30px, still one row,
    // and 140 → 56px less 24: 32px is not two rows (18 + 18) either; 160 → 64 - 24 = 40px is.
    for (const [height, rows] of [[120, 1], [140, 1], [160, 2]]) {
      fitCard(h, { width: 113, height });
      assert.equal(shown(), rows === 1 ? 2 : 5, `${height}px tall: ${rows} row(s)`);
    }
    // Each row is as tall as its own tallest shown chip: 26px flags behind "+N" do not cost a row.
    fitCard(h, { width: 113, height: 160, tall: 'language' });
    assert.equal(shown(), 5, 'two 18px rows still fit in 40px');
    assert.equal(reveal().querySelectorAll(':scope > [data-je-group="language"] > :not([data-je-overflow])').length, 0);
    // Too short for any row: nothing is half shown, and the empty scrim stays away.
    fitCard(h, { width: 113, height: 40 });
    assert.equal(shown(), 0);
    assert.equal(reveal().hasAttribute('data-je-overflow'), true, 'the reveal is not shown at all');
    // A wide landscape card fits everything on its rows again.
    fitCard(h, { width: 400, height: 225 });
    assert.equal(reveal().hasAttribute('data-je-overflow'), false);
    assert.equal(reveal().querySelectorAll(':scope > [data-je-group] > [data-je-overflow]').length, 0);
  }
});

test('the caption strip and the bottom band are not limited by the card height', t => {
  for (const [tagLayout, slot] of [['caption', '.je-tag-caption'], ['bands', '.je-tag-slot[data-je-slot="bottom"]']]) {
    const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout } });
    h.render();
    fitCard(h, { width: 172, height: 40 }); // a bottom band wider than 160px keeps full labels
    const el = h.document.querySelector(slot);
    assert.ok(el.querySelectorAll(':scope > [data-je-group] > :not([data-je-overflow])').length > 5, `${tagLayout}: two rows whatever the card height`);
  }
});

test('the chips behind "+N" are named by the card link\'s description and a hover / focus tooltip; "+N" takes no pointer', async t => {
  const card = modernCard().replace('<a class="cardImageContainer', '<a href="#/details?id=x" aria-describedby="jellyfin-own" class="cardImageContainer');
  for (const [tagLayout, slot, size] of [['summary', '.je-tag-slot[data-je-slot="hover"]', { width: 113, height: 64 }],
    ['bands', '.je-tag-slot[data-je-slot="bottom"]', { width: 120, height: 180 }], ['caption', '.je-tag-caption', { width: 113, height: 170 }]]) {
    const h = setup(t, { html: card, settings: { tagLayoutSettingsVersion: 1, tagLayout } });
    h.render();
    fitCard(h, size);
    const link = h.document.querySelector('.cardImageContainer');
    const more = h.document.querySelector(`${slot} > .je-tag-more`);
    const hidden = Array.from(h.document.querySelectorAll(`${slot} > [data-je-group] > [data-je-overflow]`));
    assert.ok(hidden.length > 0, `${tagLayout}: some chips are behind "+N"`);
    const tip = h.host().querySelector(':scope > .je-tag-more-tip');
    assert.ok(tip, 'one names element inside the host');
    const ids = link.getAttribute('aria-describedby').split(' ');
    assert.deepEqual(ids, ['jellyfin-own', tip.id], 'appended to the link\'s own description');
    assert.equal(h.document.getElementById(tip.id), tip);
    assert.equal(tip.textContent, more.title, 'it names exactly the hidden chips');
    assert.ok(tip.textContent.split(', ').length >= hidden.length - 1);
    assert.equal(tip.getAttribute('aria-hidden'), 'true', 'read once, as the description');
    assert.equal(h.window.getComputedStyle(more).pointerEvents, 'none', `${tagLayout}: the "+N" chip receives no pointer events`);
    assert.equal(more.hasAttribute('tabindex'), false);
    assert.equal(h.window.getComputedStyle(tip).pointerEvents, 'none', 'nor does the tooltip');
    // Everything fits on a wider card: no names, the link's own description is left as it was.
    fitCard(h, { width: 600, height: 900 });
    assert.equal(h.host().querySelector('.je-tag-more-tip'), null);
    assert.equal(link.getAttribute('aria-describedby'), 'jellyfin-own');
    fitCard(h, size);
    assert.ok(link.getAttribute('aria-describedby').includes('je-tag-more-'));
    await h.apply({ tagLayout: 'corners' });
    assert.equal(h.document.querySelector('.je-tag-more-tip'), null, 'another layout drops the names');
    assert.equal(link.getAttribute('aria-describedby'), 'jellyfin-own');
  }
  const h = setup(t);
  h.render();
  const css = h.document.getElementById('je-tag-layout').textContent;
  assert.match(css, /\.je-tag-host > \.je-tag-more-tip \{[^}]*pointer-events: none;[^}]*opacity: 0;/);
  assert.match(css, /:is\(\.card, \.listItem\):is\(:hover, :focus-within\) \.je-tag-host > \.je-tag-more-tip \{\s*opacity: 1;/, 'shown while the card is hovered or focused');
  assert.doesNotMatch(css, /\.je-tag-more \{[^}]*pointer-events: auto/);
});

test('the hidden chip names use the translated label when there is one', t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'caption' } });
  h.JE.t = (key, params) => (key === 'tag_layout_more_tags' ? `More tags: ${params.tags}` : key);
  h.render();
  fitCard(h, { width: 113, height: 170 });
  assert.match(h.host().querySelector('.je-tag-more-tip').textContent, /^More tags: \S/);
});

test('bands on a card under 160px switch to compact labels and keep the bottom band to two rows with "+N"', t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'bands' } });
  const host = h.render();
  const bottom = () => host.querySelector('.je-tag-slot[data-je-slot="bottom"]');
  const labels = () => Array.from(host.querySelectorAll('.quality-overlay-label'), l => l.textContent);
  assert.deepEqual(labels(), ['4K', 'Dolby Vision', 'HEVC', 'ATMOS 7.1'], 'full labels until the card is measured');
  withLayout(h, { card: 112 }, () => h.layout.flushFit()); // 6px side padding: 100px for chips
  assert.deepEqual(labels(), ['4K', 'DV', 'HEVC', 'ATMOS'], 'compact labels on a narrow card');
  assert.equal(host.querySelector('.rating-tag-critic'), null);
  const chips = Array.from(bottom().querySelectorAll(':scope > [data-je-group] > *'));
  assert.equal(chips.length, 8, 'quality 4, rating 1, language 3');
  assert.equal(chips.filter(c => !c.hasAttribute('data-je-overflow')).length, 5, 'two rows, room for "+N"');
  assert.equal(bottom().lastElementChild.textContent, '+3');
  assert.equal(bottom().lastElementChild.title.split(', ').length, 3);
  // A wider card (the window grew) gets its full labels back.
  h.layout.refreshPresentation(host);
  withLayout(h, { card: 400 }, () => h.layout.flushFit());
  assert.deepEqual(labels(), ['4K', 'Dolby Vision', 'HEVC', 'ATMOS 7.1']);
  assert.equal(bottom().querySelectorAll('[data-je-overflow]').length, 1, 'only the unneeded "+N" chip is hidden');
  assert.ok(bottom().lastElementChild.hasAttribute('data-je-overflow'));
});

test('genre names are always in the group; layout CSS decides where they show, with Hide Tags on Hover on or off', async t => {
  for (const tagsHideOnHover of [true, false]) {
    const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout: 'summary', tagsHideOnHover } });
    const host = h.render();
    const names = Array.from(host.querySelectorAll('.je-tag-slot[data-je-slot="hover"] .genre-tag .genre-text'), n => n.textContent);
    assert.deepEqual(names, ['Drama', 'Crime', 'Thriller'], `the reveal names each genre (hide on hover ${tagsHideOnHover})`);
    await h.apply({ tagLayout: 'corners' });
    assert.equal(host.querySelectorAll('.genre-overlay-container .genre-text').length, 3, 'corners keep the spans too');
    const css = h.document.getElementById('je-tag-layout').textContent;
    assert.match(css, /body\.je-tags-hide-on-hover \.je-tag-host > \.je-tag-slot:not\(\[data-je-slot="hover"\]\) \.genre-text \{\s*display: none;/,
      'Hide Tags on Hover keeps names off the poster slots, not the reveal');
    assert.match(css, /\.je-tag-slot\[data-je-slot="hover"\] \.genre-tag \.genre-text \{\s*position: static;\s*opacity: 1;/, 'the reveal shows them inline');
    assert.doesNotMatch(css, /\.je-tag-caption \.genre-text \{\s*display: none/, 'the caption strip shows them on hover');
  }
});

const ALL_TAGS_OFF = { qualityTagsEnabled: false, genreTagsEnabled: false, languageTagsEnabled: false, ratingTagsEnabled: false, ageRatingTagsEnabled: false, statusTagsEnabled: false };

test('no caption space is reserved when no enabled group can fill the strip', async t => {
  const caption = { tagLayoutSettingsVersion: 1, tagLayout: 'caption' };
  for (const settings of [ALL_TAGS_OFF, { ...ALL_TAGS_OFF, statusTagsEnabled: true }]) {
    const h = setup(t, { settings: { ...caption, ...settings } });
    h.layout.prepareCard(h.host());
    assert.equal(h.document.querySelector('.je-tag-caption'), null, 'nothing reserved at discovery');
    await h.JE.reinitializeTagLayout();
    assert.equal(h.document.querySelector('.je-tag-caption'), null, 'nor on reinitialisation');
  }
  const h = setup(t, { settings: { ...caption, ...ALL_TAGS_OFF, languageTagsEnabled: true } });
  h.layout.prepareCard(h.host());
  assert.ok(h.document.querySelector('.je-tag-caption'), 'one enabled caption group is enough');
});

test('the memoised layout settings follow the tag toggles and a reloaded settings document without an explicit invalidation', t => {
  const h = setup(t, { html: modernCard() + modernCard(OTHER), settings: { tagLayoutSettingsVersion: 1, tagLayout: 'caption', ...ALL_TAGS_OFF, languageTagsEnabled: true } });
  const [first, second] = h.document.querySelectorAll('.je-tag-host');
  h.layout.prepareCard(first);
  assert.equal(first.closest('.cardBox').querySelector('.je-tag-caption') !== null, true);
  h.JE.currentSettings.languageTagsEnabled = false; // any caller, not only the panel
  h.layout.prepareCard(second);
  assert.equal(second.closest('.cardBox').querySelector('.je-tag-caption'), null, 'no group left to fill the strip');
  h.JE.currentSettings = { ...h.JE.currentSettings, ratingTagsEnabled: true }; // the panel reloads the document from the server
  h.layout.prepareCard(second);
  assert.ok(second.closest('.cardBox').querySelector('.je-tag-caption'), 'the reloaded document is read');
  h.JE.currentSettings = { ...h.JE.currentSettings, tagLayout: 'bands' };
  assert.equal(h.layout.resolveLayout(first).layout, 'bands');
});

test('turning every tag type off removes the caption strips, also from cards whose data never came', async t => {
  const h = setup(t, { html: modernCard() + modernCard(OTHER), settings: { tagLayoutSettingsVersion: 1, tagLayout: 'caption' } });
  const [first, second] = h.document.querySelectorAll('.je-tag-host');
  h.render(entry(), first);
  h.layout.prepareCard(second);
  assert.equal(h.document.querySelectorAll('.je-tag-caption').length, 2);
  Object.assign(h.JE.currentSettings, ALL_TAGS_OFF);
  for (const name of ['Quality', 'Genre', 'Language', 'Rating', 'AgeRating', 'Status']) h.JE[`reinitialize${name}Tags`]();
  assert.equal(h.document.querySelectorAll('.je-tag-caption').length, 0, 'each renderer\'s reinitialise gives the space back once none is left');
  await h.JE.reinitializeTagLayout();
  assert.equal(h.document.querySelectorAll('.je-tag-caption, .je-tag-slot').length, 0);
});

test('settings saved before layouts keep the original indicator rule: only a container set to exactly top-right moves', async t => {
  const indicated = host => Array.from(host.querySelectorAll('[data-je-indicator-gap]'), el => el.dataset.jeGroup);
  // No group set to exactly top-right ("top" is still drawn top-right).
  let h = setup(t, { settings: { genreTagsPosition: 'top', statusTagsPosition: 'top' } });
  let host = h.render();
  assert.deepEqual(h.slot('tr'), ['genre', 'status']);
  assert.deepEqual(indicated(host), []);
  assert.equal(host.dataset.jeIndicatorGap, undefined);
  // A displayed exact match: that container alone carries the gap, not the whole corner.
  h = setup(t, { settings: { genreTagsPosition: 'top-right', statusTagsPosition: 'top' } });
  host = h.render();
  assert.deepEqual(indicated(host), ['genre']);
  assert.equal(host.dataset.jeIndicatorGap, undefined, 'the corner itself does not move (that is the native rule)');
  assert.equal(host.dataset.jeLegacy, '1');
  // The exact-match group absent (switched off): nothing moves.
  h = setup(t, { settings: { genreTagsEnabled: false, genreTagsPosition: 'top-right', statusTagsPosition: 'top' } });
  host = h.render();
  assert.deepEqual(h.slot('tr'), ['status']);
  assert.deepEqual(indicated(host), []);
  // A normalized document follows the native rule instead.
  await h.apply({ tagLayoutSettingsVersion: 1, genreTagsEnabled: true });
  h.JE.reinitializeGenreTags();
  delete h.document.querySelector('.card').dataset.jeGenreTagged;
  h.render();
  assert.equal(host.dataset.jeLegacy, undefined);
  assert.equal(host.dataset.jeIndicatorGap, '1');
  assert.deepEqual(indicated(host).filter(Boolean), []);
  const css = h.document.getElementById('je-tag-layout').textContent;
  assert.match(css, /\.cardScalable:has\(\.countIndicator, \.playedIndicator\) > \.je-tag-host\[data-je-legacy\] > \.je-tag-slot\[data-je-slot="tr"\] > \[data-je-indicator-gap\],/);
});

test('settings saved before layouts: an exact top-right container below a malformed one still clears the indicator', t => {
  const h = setup(t, { settings: { genreTagsPosition: 'top', statusTagsPosition: 'top-right' } });
  const host = h.render();
  assert.deepEqual(h.slot('tr'), ['genre', 'status'], 'the malformed "top" genre container arrived first');
  const genre = groupEl(h.document, 'genre', 'tr');
  const status = groupEl(h.document, 'status', 'tr');
  assert.equal(genre.dataset.jeIndicatorGap, undefined);
  assert.equal(status.dataset.jeIndicatorGap, '1');
  const css = h.document.getElementById('je-tag-layout').textContent;
  const rule = (groups = '') => new RegExp(`\\.cardScalable:has\\(\\.countIndicator, \\.playedIndicator\\) > \\.je-tag-host\\[data-je-legacy\\] > \\.je-tag-slot\\[data-je-slot="tr"\\] > ${groups}\\[data-je-indicator-gap\\],\\s*`
    + `\\.cardIndicators ~ \\.je-tag-host\\[data-je-legacy\\] > \\.je-tag-slot\\[data-je-slot="tr"\\] > ${groups}\\[data-je-indicator-gap\\] \\{\\s*margin-top: max\\(0px, clamp\\(20px, 3vw, 30px\\)( - 2px)? - var\\(--je-indicator-before, 0px\\)\\);`);
  assert.match(css, rule(), 'every exact container, not only the first in the stack: at least the offset down, or right below the one before');
  assert.match(css, rule(':is\\(\\[data-je-group="rating"\\], \\[data-je-group="ageRating"\\], \\[data-je-group="status"\\]\\)'), 'the 4px phone edge groups too');
  assert.doesNotMatch(css, /\[data-je-indicator-gap\]:first-child/);
  assert.match(css, /\.je-tag-host\[data-je-legacy\] > \.je-tag-slot\[data-je-slot="tr"\] > \[data-je-indicator-gap\]:not\(:first-child\) \{\s*--je-indicator-before: 9999px;/,
    'unmeasured, a lower container just follows the one before');
  // The fitting pass measures where the status container sits unmoved: right below genre.
  const slot = status.parentElement;
  measure(host, { width: 150 });
  slot.getBoundingClientRect = () => ({ top: 106, bottom: 331, width: 138, height: 225, left: 0, right: 138 });
  genre.getBoundingClientRect = () => ({ top: 106, bottom: 132, width: 26, height: 26, left: 0, right: 26 });
  h.layout.flushFit();
  const gap = parseFloat(h.window.getComputedStyle(slot).rowGap) || 0; // 4px in a browser
  assert.equal(status.style.getPropertyValue('--je-indicator-before'), `${26 + gap}px`);
  // The malformed container goes: the exact one is first again and takes the whole offset.
  h.layout.removeGroup(host, 'genre');
  h.layout.flushFit();
  assert.equal(h.slot('tr').join(), 'status');
  assert.equal(groupEl(h.document, 'status', 'tr').style.getPropertyValue('--je-indicator-before'), '');
});

test('settings saved before layouts: two exact top-right containers need no measuring, the lower one follows the upper', t => {
  const h = setup(t, { settings: { genreTagsPosition: 'top-right', statusTagsPosition: 'top-right' } });
  const host = h.render();
  assert.deepEqual(h.slot('tr'), ['genre', 'status']);
  measure(host, { width: 150 });
  let reads = 0;
  for (const el of host.querySelectorAll('.je-tag-slot, [data-je-group]')) el.getBoundingClientRect = () => { reads++; return { top: 0, bottom: 20, width: 20, height: 20, left: 0, right: 20 }; };
  h.layout.refreshPresentation(host);
  h.layout.flushFit();
  assert.equal(reads, 0, 'no fitting pass for the default corners');
  assert.equal(groupEl(h.document, 'status', 'tr').style.getPropertyValue('--je-indicator-before'), '');
});

test('settings saved before layouts keep the 4px phone edge offsets of rating, age rating and status', t => {
  const h = setup(t);
  h.render();
  const css = h.document.getElementById('je-tag-layout').textContent;
  const phone = css.slice(css.indexOf('@media (max-width: 480px)'));
  const groups = ':is\\(\\[data-je-group="rating"\\], \\[data-je-group="ageRating"\\], \\[data-je-group="status"\\]\\)';
  for (const [slot, rule] of [['tl', 'margin-left: -2px'], ['bl', 'margin-left: -2px'], ['tr', 'margin-right: -2px'], ['br', 'margin-right: -2px']]) {
    assert.match(phone, new RegExp(`\\.je-tag-host\\[data-je-legacy\\] > \\.je-tag-slot\\[data-je-slot="${slot}"\\] > ${groups} \\{ ${rule}; \\}`), `${slot}: 6px slot inset - 2px = the old 4px`);
  }
  assert.match(phone, new RegExp(`\\[data-je-slot="tl"\\] > ${groups}:first-child, [^{]*\\[data-je-slot="tr"\\] > ${groups}:first-child \\{ margin-top: -2px; \\}`), 'the edge chip of a top stack');
  assert.match(phone, new RegExp(`\\[data-je-slot="bl"\\] > ${groups}:first-child, [^{]*\\[data-je-slot="br"\\] > ${groups}:first-child \\{ margin-bottom: -2px; \\}`), 'and of a bottom stack');
  assert.match(phone, /margin-top: max\(0px, clamp\(20px, 3vw, 30px\) - 2px - var\(--je-indicator-before, 0px\)\);/, 'a rating set to exactly top-right keeps 4px + the indicator offset');
  assert.match(css.slice(0, css.indexOf('@media (max-width: 480px)')), /\[data-je-slot="tl"\], .*\[data-je-slot="tr"\],\s*.*\[data-je-slot="bl"\], .*\[data-je-slot="br"\] \{\s*inset: 6px;/, 'everything else keeps 6px');
  assert.equal(h.host().dataset.jeLegacy, '1');
});

test('corner slots restate the containers\' card-relative size limits, so narrow cards clip chips where they always did', t => {
  const h = setup(t);
  h.render();
  const css = h.document.getElementById('je-tag-layout').textContent;
  const corner = '\\.je-tag-host > \\.je-tag-slot:is\\(\\[data-je-slot="tl"\\], \\[data-je-slot="tr"\\], \\[data-je-slot="bl"\\], \\[data-je-slot="br"\\]\\)';
  assert.match(css, new RegExp(`${corner} > :is\\(\\.quality-overlay-container, \\.rating-overlay-container, \\.age-rating-overlay-container, \\.status-overlay-container\\) \\{\\s*max-width: 100%;`),
    'calc(100% - 12px) of the card is the whole 6px-inset slot');
  assert.match(css, new RegExp(`${corner} > :is\\(\\.quality-overlay-container, \\.language-overlay-container, \\.genre-overlay-container\\) \\{\\s*max-height: calc\\(90% \\+ 10\\.8px\\);`),
    '90% of the card, against a slot 12px shorter');
  assert.match(css, /@media \(max-width: 480px\) \{\s*[^{]+> :is\(\.quality-overlay-container, \.genre-overlay-container\) \{ max-height: calc\(85% \+ 10\.2px\); \}/);
});


test('all centre anchors accept legacy values, survive promotion and retain their CSS and corner hooks', t => {
  const positions = { tc: 'top-center', bc: 'bottom-center', ml: 'center-left', mr: 'center-right', c: 'center' };
  for (const [slot, position] of Object.entries(positions)) {
    const h = setup(t, { settings: { qualityTagsPosition: position } });
    const host = h.render();
    assert.equal(h.layout.normalizeSettings().slots.quality, slot);
    assert.equal(groupEl(host, 'quality', slot).dataset.jeCorner, position);
    h.layout.promoteLegacySettings(h.JE.currentSettings);
    h.layout.invalidateSettings();
    assert.equal(h.layout.normalizeSettings().slots.quality, slot);
    assert.equal(h.layout.POSITION_TO_SLOT[position], slot);
    assert.equal(h.layout.SLOT_TO_POSITION[slot], position);
    assert.ok(h.layout.buildStyles().includes(`[data-je-slot="${slot}"]`));
  }
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayouts: { corners: { groups: [{group: 'quality', slot: 'unknown'}] } } } });
  assert.equal(h.layout.normalizeSettings().slots.quality, 'tl');
});

test('position and layout lookups reject inherited property names and preserve the legacy fallback', t => {
  const h = setup(t);
  for (const value of ['constructor', '__proto__', 'toString', 'unknown']) {
    for (const version of [0, 1]) {
      const conf = h.layout.normalizeSettings({ tagLayoutSettingsVersion: version, tagLayout: value, qualityTagsPosition: value });
      assert.equal(conf.layout, 'corners', value);
      assert.equal(conf.slots.quality, 'br', value);
      assert.equal(h.layout.normalizeSettings({ qualityTagsPosition: '' }, { QualityTagsPosition: value }).slots.quality, 'br');
    }
    assert.equal(h.layout.POSITION_TO_SLOT[value], undefined);
    assert.equal(h.layout.SLOT_TO_POSITION[value], undefined);
    assert.equal(h.layout.LAYOUT_SLOTS[value], undefined);
  }
  assert.equal(h.layout.normalizeSettings({ qualityTagsPosition: 'stray-top' }).slots.quality, 'tr');
  assert.equal(h.layout.normalizeSettings({ qualityTagsPosition: 'middle-left' }).slots.quality, 'bl');
});

test('compact quality labels do not resolve inherited dictionary members', t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLabelDensity: 'compact' } });
  for (const text of ['constructor', '__proto__', 'toString', 'unknown']) {
    const wrapper = h.document.createElement('div');
    wrapper.innerHTML = '<span class="quality-overlay-label"></span>';
    wrapper.firstElementChild.textContent = text;
    h.layout.commitGroup(h.host(), 'quality', wrapper);
    assert.equal(groupEl(h.host(), 'quality', 'tl').textContent, text);
  }
});

test('top and bottom centre overflow counts eligible chips after the group cap and refits on short cards', t => {
  for (const slot of ['tc', 'bc']) {
    const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayouts: { corners: { groups: [
      ...['genre', 'rating', 'ageRating', 'language', 'status'].map(group => ({group, slot: 'off'})), {group: 'quality', slot},
    ] } }, tagGroupCaps: {quality: 3} } });
    h.render();
    fitCard(h, {width: 40, height: 180});
    const el = h.host().querySelector(`[data-je-slot="${slot}"]`);
    assert.equal(el.querySelectorAll('[data-je-group] > *').length, 3);
    assert.equal(el.lastElementChild.textContent, '+2');
    assert.equal(el.querySelectorAll('[data-je-group] > [data-je-overflow]').length, 2);
    fitCard(h, {width: 140, height: 180});
    assert.equal(h.host().querySelector(`[data-je-slot="${slot}"]`).lastElementChild.hasAttribute('data-je-overflow'), true);
  }
});

test('centre budgets reserve occupied corners, top-centre overlays and progress bars in the batched pass', t => {
  const h = setup(t, {settings: {tagLayoutSettingsVersion: 1, tagLayouts: {corners: {groups: [
    {group:'quality',slot:'tl'}, {group:'rating',slot:'br'}, {group:'status',slot:'tc'},
    {group:'language',slot:'ml'}, {group:'genre',slot:'bc'}, {group:'ageRating',slot:'off'},
  ]}}}});
  const scalable = h.document.querySelector('.cardScalable');
  scalable.insertAdjacentHTML('beforeend','<div class="itemProgressBar"></div><div class="cardIndicators"><span></span><span class="countIndicator"></span></div>');
  h.render();
  const proto = h.window.HTMLElement.prototype;
  const rect = proto.getBoundingClientRect;
  const width = Object.getOwnPropertyDescriptor(h.window.Element.prototype,'clientWidth');
  const height = Object.getOwnPropertyDescriptor(h.window.Element.prototype,'clientHeight');
  proto.getBoundingClientRect = function () {
    if (this.classList.contains('je-tag-host')) return {left:0,right:180,top:0,bottom:270,width:180,height:270};
    if (this.dataset.jeGroup === 'quality') return {left:6,right:66,top:6,bottom:86,width:60,height:80};
    if (this.dataset.jeGroup === 'rating') return {left:134,right:174,top:224,bottom:264,width:40,height:40};
    if (this.classList.contains('itemProgressBar')) return {top:260,bottom:270};
    if (this.classList.contains('countIndicator')) return {left:90,right:174,top:6,bottom:30};
    if (this.parentElement?.classList.contains('cardIndicators')) return {left:80,right:100,top:6,bottom:24};
    return {left:0,right:20,top:0,bottom:18,width:20,height:18};
  };
  Object.defineProperty(h.window.Element.prototype,'clientWidth',{configurable:true,get(){return 180;}});
  Object.defineProperty(h.window.Element.prototype,'clientHeight',{configurable:true,get(){return 270;}});
  try {
    h.layout.refreshPresentation(h.host());
    h.layout.flushFit();
    const slot = name => h.host().querySelector(`[data-je-slot="${name}"]`);
    assert.equal(slot('tc').style.getPropertyValue('--je-anchor-reserve'),'94px');
    assert.equal(slot('bc').style.getPropertyValue('--je-anchor-reserve'),'50px');
    assert.equal(slot('ml').style.getPropertyValue('--je-anchor-reserve'),'90px');
    assert.equal(slot('tc').style.getPropertyValue('--je-anchor-top'),'28px');
    assert.equal(slot('bc').style.getPropertyValue('--je-anchor-bottom'),'14px');
    Object.assign(h.JE.currentSettings, { tagScale: 'largest', tagGap: 'roomy' });
    h.layout.invalidateSettings();
    h.layout.refreshPresentation(h.host());
    h.layout.flushFit();
    assert.ok(Math.abs(parseFloat(slot('tc').style.getPropertyValue('--je-anchor-reserve')) - 97.8) < .001);
    assert.ok(Math.abs(parseFloat(slot('tc').style.getPropertyValue('--je-anchor-top')) - 31.8) < .001);
    assert.ok(Math.abs(parseFloat(slot('bc').style.getPropertyValue('--je-anchor-bottom')) - 17.8) < .001);

  } finally {
    proto.getBoundingClientRect = rect;
    Object.defineProperty(h.window.Element.prototype,'clientWidth',width);
    Object.defineProperty(h.window.Element.prototype,'clientHeight',height);
  }
});

test('side-centre columns fit whole chips and an overflow count inside short cards', t => {
  for (const slot of ['ml','mr']) {
    const h = setup(t, {settings: {tagLayoutSettingsVersion:1, tagLayouts:{corners:{groups:[
      ...['quality','rating','ageRating','status','genre'].map(group=>({group,slot:'off'})), {group:'language',slot},
    ]}}}});
    h.render();
    fitCard(h,{width:113,height:64});
    const column = h.host().querySelector(`[data-je-slot="${slot}"]`);
    assert.equal(column.querySelectorAll('[data-je-group] > :not([data-je-overflow])').length,1);
    assert.equal(column.lastElementChild.textContent,'+2');
    assert.equal(column.lastElementChild.hasAttribute('data-je-overflow'),false);
    fitCard(h,{width:113,height:16});
    assert.equal(h.host().querySelector(`[data-je-slot="${slot}"]`).hasAttribute('data-je-overflow'),true);
  }
});

// Tag size and gap: defaults, inheritance, promotion and every presentation.
test('size and gap inherit admin values only after promotion and sanitize untrusted input', async t => {
  const h = setup(t, { plugin: { TagScale: 'largest', TagGap: 'roomy' } });
  assert.equal(h.layout.normalizeSettings().tagScale, 'default');
  assert.equal(h.layout.normalizeSettings().tagGap, 'default');
  h.layout.promoteLegacySettings(h.JE.currentSettings);
  assert.equal(h.JE.currentSettings.tagScale, 'default');
  assert.equal(h.JE.currentSettings.tagGap, 'default');
  await h.apply({ tagScale: null, tagGap: null });
  assert.equal(h.layout.normalizeSettings().tagScale, 'largest');
  assert.equal(h.layout.normalizeSettings().tagGap, 'roomy');
  await h.apply({ tagScale: ' SMALLER ', tagGap: ' TIGHT ' });
  assert.equal(h.layout.normalizeSettings().tagScale, 'smaller');
  assert.equal(h.layout.normalizeSettings().tagGap, 'tight');
  await h.apply({ tagScale: 'huge', tagGap: 'wide' });
  assert.equal(h.layout.normalizeSettings().tagScale, 'default', 'invalid personal values normalize to default rather than admin choices');
  assert.equal(h.layout.normalizeSettings().tagGap, 'default');
  for (const value of ['constructor', '__proto__', {}, 130, 'huge']) {
    assert.equal(h.layout.readScale(value), null);
    assert.equal(h.layout.readGap(value), null);
  }
});

for (const tagLayout of ['corners', 'bands', 'caption', 'summary', 'minimal']) {
  test(`size/gap variables reach ${tagLayout}, caption outlets and reset on user switch`, async t => {
    const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagLayout } });
    h.render();
    for (const [tagScale, factor] of Object.entries(h.layout.TAG_SCALES)) {
      for (const [tagGap, gap] of Object.entries(h.layout.TAG_GAPS)) {
        await h.apply({ tagScale, tagGap });
        const host = h.host();
        assert.equal(host.style.getPropertyValue('--je-tag-scale'), String(factor));
        assert.equal(host.style.getPropertyValue('--je-tag-gap'), String(gap));
        if (tagLayout === 'caption') {
          const caption = h.document.querySelector('.je-tag-caption');
          assert.equal(caption.style.getPropertyValue('--je-tag-scale'), String(factor));
          assert.equal(caption.style.getPropertyValue('--je-tag-gap'), String(gap));
        }
      }
    }
    h.layout.clearAll();
    assert.equal(h.host().style.getPropertyValue('--je-tag-scale'), '');
    assert.equal(h.host().style.getPropertyValue('--je-tag-gap'), '');
    assert.equal(h.document.querySelector('.je-tag-caption'), null);
  });
}

test('shape-specific size and gap survive wire conversion and apply independently', t => {
  const h = setup(t, { settings: { tagLayoutSettingsVersion: 1, tagScale: 'larger', tagGap: 'tight',
    tagShapeOverrides: { landscape: { tagScale: 'smaller', tagGap: 'roomy' }, list: { tagScale: 'largest' } } } });
  const portrait = h.layout.resolveLayout({ shape: 'portrait' });
  const landscape = h.layout.resolveLayout({ shape: 'landscape' });
  const list = h.layout.resolveLayout({ shape: 'list' });
  assert.deepEqual([portrait.tagScale, portrait.tagGap], ['larger', 'tight']);
  assert.deepEqual([landscape.tagScale, landscape.tagGap], ['smaller', 'roomy']);
  assert.deepEqual([list.tagScale, list.tagGap], ['largest', 'tight']);
  const wire = h.layout.shapesToWire(h.layout.normalizeSettings().shapes);
  assert.equal(wire.landscape.tagScale, 'smaller');
  assert.equal(wire.landscape.tagGap, 'roomy');
  assert.equal(wire.list.tagScale, 'largest');
});

test('legacy sizing retains original responsive expressions while normalized cards keep multiplier hooks', t => {
  const h = setup(t);
  const css = h.layout.preserveLegacySizing('@supports (container-type: inline-size) { html:not(.layout-mobile) .je-tag-host .genre-tag { width: calc(clamp(18px, 15cqw, 30px) * var(--je-tag-scale, 1)); gap: calc(4px * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); background: red; } }');
  assert.match(css, /\.je-tag-host\[data-je-legacy\] \.genre-tag \{ width: clamp\(18px, 15cqw, 30px\); gap: 4px;/);
  assert.match(css, /width: calc\(clamp\(18px, 15cqw, 30px\) \* var\(--je-tag-scale, 1\)\)/);
  assert.equal((css.match(/background: red/g) || []).length, 1, 'only sizing declarations gain legacy specificity; colors and other custom CSS stay untouched');
  const mobile = h.layout.preserveLegacySizing('@media (max-width: 480px) { .layout-mobile .rating-tag { font-size: calc(11px * var(--je-tag-scale, 1)); } }');
  assert.match(mobile, /\.je-tag-host\[data-je-legacy\] :is\(\.layout-mobile \.rating-tag\) \{ font-size: 11px;/);
  h.render();
  assert.equal(h.host().dataset.jeLegacy, '1');
});
test('Bands shared native/web width and height fixtures retain later chips after a rejection', t => {
  const h = setup(t);
  const fixtures = JSON.parse(readFileSync(new URL('../../fixtures/native-band-fit.json', import.meta.url), 'utf8'));
  for (const f of fixtures) {
    const rows = [], more = { row: 0 };
    const shown = h.layout.chipsThatFit(f.widths, f.available, f.gap, f.maxRows, f.moreWidths?.[String(f.widths.length)] ?? f.moreWidth, rows, more);
    assert.deepEqual(shown, f.shown, f.name);
    assert.equal(shown.filter(v => !v).length, f.hidden, f.name);
    assert.equal(h.layout.rowsHeight(shown, rows, f.heights, 18, f.gap, more.row), f.height, f.name);
  }
});
