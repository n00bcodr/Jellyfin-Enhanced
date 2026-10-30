import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

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
function setup(t, { html = modernCard(), settings = {}, plugin = {}, reviews = null } = {}) {
  const renderers = new Map();
  const userChange = new Map();
  const h = createHarness({
    html,
    JE: {
      currentSettings: {
        qualityTagsEnabled: true, genreTagsEnabled: true, languageTagsEnabled: true, ratingTagsEnabled: true,
        ageRatingTagsEnabled: true, statusTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none', ...settings,
      },
      pluginConfig: { TagCacheServerMode: true, ...(reviews ? { ShowUserReviews: true, ShowUserRatingOnPosters: true } : {}), ...plugin },
      t: key => key,
      cdn: { flagSvg: code => `http://jellyfin.test/flags/${code}.svg` },
      session: { getUserId: () => 'a', getServerId: () => 's', getEpoch: () => 0, isCurrent: () => true, onUserChange: (name, fn) => userChange.set(name, fn) },
      _cacheManager: { register() {}, markDirty() {} },
      tagPipeline: {
        registerRenderer: (name, r) => renderers.set(name, r), getRenderer: name => renderers.get(name),
        clearProcessed() {}, scheduleScan() {},
        peekReviewRatings: () => reviews, getReviewRatingsRequestedAt: () => 1,
        getReviewRatings: async () => reviews, onReviewRatingsChanged() {},
      },
    },
  });
  t.after(() => h.close());
  h.window.Date.now = () => Date.UTC(2026, 9, 30);
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js',
    'tags/qualitytags.js', 'tags/genretags.js', 'tags/languagetags.js', 'tags/ratingtags.js', 'tags/ageratingtags.js', 'tags/statustags.js', 'tags/userreviewtags.js']) h.load(file);
  const JE = h.JE;
  JE.initializeQualityTags(); JE.initializeGenreTags(); JE.initializeRatingTags(); JE.initializeAgeRatingTags(); JE.initializeStatusTags(); JE.initializeLanguageTags();
  if (reviews) JE.initializeUserReviewTags();
  const layout = JE.core.tagLayout;
  const targetOf = (root = h.document) => root.querySelector('.je-tag-host') || root.querySelector('.listItemImage');
  return Object.assign(h, {
    renderers, userChange, layout,
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
  assert.deepEqual(plain(s.caps), { quality: 0, genre: 3, language: 3, rating: 0, ageRating: 1, status: 1 });
  assert.deepEqual(plain(s.slots), { status: 'tr', quality: 'br', rating: 'tl', ageRating: 'br', language: 'bl', genre: 'bl' },
    'positions map user → admin → built-in (genre inherits the admin bottom-left)');
});

test('a normalized document inherits admin profiles, order and caps and overrides them per value', t => {
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
  assert.deepEqual(plain(s.slots), { status: 'top', quality: 'bottom', rating: 'top', ageRating: 'bottom', language: 'bottom', genre: 'top' },
    'own valid slots win, the admin profile fills in, then the built-in profile (invalid "middle" ignored)');
  assert.deepEqual(plain(s.order), ['genre', 'status', 'quality', 'rating', 'ageRating', 'language'], 'own order wins and is completed in default order');
  assert.deepEqual(plain(s.caps), { quality: 0, genre: 2, language: 10, rating: 0, ageRating: 1, status: 0 }, 'clamped 0..10; admin caps fill gaps');
  h.JE.currentSettings.tagGroupOrder = null;
  h.layout.invalidateSettings();
  assert.deepEqual(plain(h.layout.normalizeSettings().order.slice(0, 2)), ['quality', 'status'], 'admin order when the user has none');
});

test('config.js keeps structured layout values as stored and drops malformed ones', t => {
  const h = createHarness({ JE: { pluginConfig: { TagLayout: 'caption' }, userConfig: { settings: {
    tagLayoutSettingsVersion: 1, tagLayout: 'minimal', tagLayouts: { minimal: { groups: [{ Group: 'quality', Slot: 'dots' }] } },
    tagGroupOrder: ['status'], tagGroupCaps: [1, 2],
  } } } });
  t.after(() => h.close());
  h.load('enhanced/config.js');
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
  assert.match(css, /\.card:is\(:hover, :focus-within\) \.je-tag-host > \.je-tag-slot\[data-je-slot="hover"\] \{ opacity: 1; \}/);
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

test('a virtualised card reused for another item sheds the previous item\'s groups', t => {
  const h = setup(t);
  const host = h.render();
  assert.ok(host.querySelector('.quality-overlay-container'));
  const card = h.document.querySelector('.card');
  card.setAttribute('data-id', 'cccccccccccccccccccccccccccccccc');
  assert.equal(h.layout.hasGroup(host, 'quality'), false, 'the old item\'s quality is not "tagged" for the new one');
  assert.equal(host.querySelector('.quality-overlay-container'), null, 'and no longer shown');
  h.renderers.get('genre').renderFromServerCache(host, entry({ Genres: ['War'] }), 'cccccccccccccccccccccccccccccccc');
  assert.deepEqual(h.slot('tr'), ['genre']);
  assert.equal(host.querySelectorAll('.genre-tag').length, 1);
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
