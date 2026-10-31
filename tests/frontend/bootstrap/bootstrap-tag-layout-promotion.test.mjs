import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

// A legacy (version 0) document must show exactly the same posters after its
// first layout edit, except for what that edit changes: the promotion keeps
// corners, full labels, arrival order and the original limits, whatever the
// administrator's new defaults are (they only seed new users / apply to all).

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LIBRARY = '22222222222222222222222222222222';
const ADMIN_RULE = { id: 'movies', enabled: true, when: [{ field: 'library', value: LIBRARY }], layout: 'caption', density: 'compact' };
const card = `<div class="card overflowPortraitCard" data-id="${ID}" data-type="Movie"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer coveredImage cardContent"></div><div class="je-tag-host"></div><div class="cardOverlayContainer"></div></div><div class="cardText cardText-first">Title</div></div></div>`;

// Panel controls outside the Media Tags hub that the settings wiring binds by id.
const otherToggles = ['autoPauseToggle', 'autoResumeToggle', 'autoPipToggle', 'autoSkipIntroToggle', 'autoSkipOutroToggle',
  'randomButtonToggle', 'randomUnwatchedOnly', 'randomScopeCurrentContainer', 'showWatchProgressToggle', 'showFileSizesToggle',
  'removeContinueWatchingToggle', 'pauseScreenToggle', 'disableCustomSubtitleStyles', 'longPress2xEnabled', 'randomIncludeMovies', 'randomIncludeShows'];

/** Administrator defaults that differ from the legacy view in every layout dimension. */
const ADMIN = {
  TagCacheServerMode: true, TagLayout: 'bands', TagLabelDensity: 'compact',
  TagGroupOrder: ['genre', 'rating'], TagGroupCaps: { Quality: 1, Language: 1 },
  TagLookRules: [ADMIN_RULE],
};

/**
 * A stored legacy document: every group on, groups sharing corners so a
 * priority order would visibly restack them, age rating alone bottom-right.
 */
const LEGACY = {
  qualityTagsEnabled: true, genreTagsEnabled: true, languageTagsEnabled: true, ratingTagsEnabled: true,
  ageRatingTagsEnabled: true, statusTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none',
  qualityTagsPosition: 'bottom-left', languageTagsPosition: 'bottom-left', ratingTagsPosition: 'bottom-left',
  genreTagsPosition: 'top-right', statusTagsPosition: 'top-right', ageRatingTagsPosition: 'bottom-right',
};

/** A tag-cache entry with more chips than every admin cap allows. */
const entry = () => ({
  Type: 'Movie', LibraryId: LIBRARY, TmdbId: '42',
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
});

/**
 * The real renderers and layout controller drawing one card, plus the real
 * settings panel modules (tag group editor and settings wiring) over the
 * real config loader; writes are captured.
 * @param {import('node:test').TestContext} t
 */
function setup(t, settings = {}) {
  const renderers = new Map();
  const writes = [];
  const html = card + otherToggles.map(id => `<input type="checkbox" id="${id}">`).join('')
    + '<input id="pauseScreenDelayInput"><button id="releaseNotesBtn"></button><div id="jellyfin-enhanced-panel"></div>';
  const h = createHarness({
    html,
    JE: {
      pluginConfig: ADMIN, userConfig: { settings: { ...LEGACY, ...settings }, shortcuts: { Shortcuts: [] } }, currentSettings: {},
      t: key => key, toast() {}, pauseScreenInstance: {},
      cdn: { flagSvg: code => `http://jellyfin.test/flags/${code}.svg` },
      session: { getUserId: () => 'a', getServerId: () => 's', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
      _cacheManager: { register() {}, markDirty() {} },
      tagPipeline: {
        registerRenderer: (name, r) => renderers.set(name, r), getRenderer: name => renderers.get(name),
        clearProcessed() {}, scheduleScan() {},
        peekReviewRatings: () => null, getReviewRatingsRequestedAt: () => 1,
        getReviewRatings: async () => null, onReviewRatingsChanged() {},
      },
    },
    apiClient: { getUrl: path => path, ajax: async request => { if (request.type === 'GET') return []; writes.push(request); } },
  });
  t.after(() => h.close());
  h.window.Date.now = () => Date.UTC(2026, 9, 30);
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-layout-styles.js',
    'tags/qualitytags.js', 'tags/genretags.js', 'tags/languagetags.js', 'tags/rating-sources.js', 'tags/ratingtags.js', 'tags/ageratingtags.js', 'tags/status-vocabulary.js', 'tags/statustags.js',
    'tags/rating-sources.js', 'enhanced/config.js', 'enhanced/icons.js']) h.load(file);
  const JE = h.JE;
  JE.currentSettings = JE.loadSettings();
  JE.escapeHtml = JE.core.ui.escapeHtml;
  JE.initializeQualityTags(); JE.initializeGenreTags(); JE.initializeRatingTags(); JE.initializeAgeRatingTags(); JE.initializeStatusTags(); JE.initializeLanguageTags();
  h.load('enhanced/settingspanel/ui-panel-settings.js');
  h.load('enhanced/settingspanel/ui-panel-tag-editor.js');
  h.load('enhanced/settingspanel/ui-panel-media-tags.js');
  const ui = JE.internals.enhancedUi;
  const ctx = { createToast: () => '', resetAutoCloseTimer() {}, help: h.document.getElementById('jellyfin-enhanced-panel'),
    primaryAccentColor: '#fff', toggleAccentColor: '#0af', detailsBackground: '#222', presetBoxBackground: '#111' };
  // The Media Tags hub holds the group editor, the layout tiles and the density pills.
  ctx.help.innerHTML = ui.buildMediaTagsHubHtml(ctx);
  ui.wireSettingsListeners(ctx);
  ui.wireMiscSettingsControls(ctx);
  ui.wireTagGroupEditor(ctx);

  const host = h.document.querySelector('.je-tag-host');
  /** Render the entry through every enabled renderer, as the pipeline's server-cache path does. */
  const render = () => {
    JE.core.tagLayout.setCardContext(host, entry(), ID);
    for (const [, r] of renderers) if (r.isEnabled() && r.renderFromServerCache) r.renderFromServerCache(host, entry(), ID);
  };
  render();
  /** Let the click handler, the coalesced re-present and the preview run. */
  const settle = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await JE.core.tagLayout.reinitialize();
  };
  const row = group => h.document.querySelector(`.je-tge-row[data-group="${group}"]`);
  return {
    ...h, host, writes, row, render,
    saved: () => JSON.parse(writes.at(-1).data),
    async click(el) { el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true })); await settle(); },
    async change(el, value) {
      if (typeof value === 'boolean') el.checked = value; else el.value = value;
      el.dispatchEvent(new h.window.Event('change', { bubbles: true })); await settle();
    },
  };
}

/**
 * What the card shows: its layout markers and, per group, the slot it is in,
 * the groups sharing that slot before it, and its full markup.
 * @param {HTMLElement} host
 */
function snapshot(host) {
  const groups = {};
  let gap = host.dataset.jeIndicatorGap === '1';
  for (const slot of host.querySelectorAll(':scope > .je-tag-slot')) {
    const members = Array.from(slot.children);
    members.forEach((el, index) => {
      // The indicator offset is marked per container on a legacy document and
      // on the host once promoted; both place the stack the same way, so the
      // snapshot records only whether the offset applies.
      if (el.dataset.jeIndicatorGap === '1') gap = true;
      const html = el.outerHTML.replace(/ data-je-indicator-gap="1"/g, '');
      groups[el.dataset.jeGroup] = { slot: slot.dataset.jeSlot, before: members.slice(0, index).map(m => m.dataset.jeGroup), html };
    });
  }
  return { layout: host.dataset.jeLayout, gap: gap ? '1' : null, caption: !!host.ownerDocument.querySelector('.je-tag-caption'), groups };
}

/**
 * Assert two snapshots are identical except for the listed groups.
 * @param {ReturnType<typeof snapshot>} before
 * @param {ReturnType<typeof snapshot>} after
 * @param {string[]} changed
 */
function assertOnlyChanged(before, after, changed) {
  const strip = s => ({
    ...s,
    groups: Object.fromEntries(Object.entries(s.groups).filter(([g]) => !changed.includes(g))
      .map(([g, v]) => [g, { ...v, before: v.before.filter(b => !changed.includes(b)) }])),
  });
  assert.deepEqual(strip(after), strip(before));
  for (const group of changed) assert.notDeepEqual(after.groups[group], before.groups[group], `${group} changed`);
}

test('the legacy view ignores every admin layout default (baseline)', t => {
  const h = setup(t);
  const s = h.JE.core.tagLayout.normalizeSettings();
  assert.equal(s.legacy, true);
  const view = snapshot(h.host);
  assert.equal(view.layout, 'corners');
  assert.deepEqual(view.groups.quality.before, [], 'arrival order: quality first bottom-left');
  assert.deepEqual(view.groups.language.before, ['quality', 'rating'], 'arrival order, not the admin order (rating first)');
  assert.deepEqual(view.groups.status.before, ['genre']);
  assert.equal(h.host.querySelectorAll('.quality-overlay-label').length, 4, 'quality shows all, not the admin cap 1');
  assert.equal(h.host.querySelectorAll('.language-flag').length, 3, 'language shows 3, not the admin cap 1');
});

test('one slot pill on a legacy document changes only that group, on the web and in what is saved', async t => {
  const h = setup(t);
  const before = snapshot(h.host);
  await h.click(h.row('ageRating').querySelector('[data-slot="tl"]'));
  const after = snapshot(h.host);
  assertOnlyChanged(before, after, ['ageRating']);
  assert.equal(after.groups.ageRating.slot, 'tl');

  const saved = h.saved();
  assert.equal(saved.tagLayoutSettingsVersion, 1);
  assert.deepEqual(saved.tagLookRules, [], 'promotion must not activate the admin rules');
  assert.equal(saved.tagLayout, 'corners', 'not the admin layout');
  assert.equal(saved.tagLabelDensity, 'full', 'not the admin density');
  assert.equal(saved.tagGroupOrder, null, 'arrival order, not the admin order');
  assert.deepEqual(saved.tagGroupCaps, { quality: 0, genre: 3, language: 3, rating: 0, ageRating: 1, status: 1, awards: 2, logos: 0, custom: 3 }, 'the legacy limits, explicitly');
  assert.equal(saved.ageRatingTagsPosition, 'top-left');
});

for (const personal of [undefined, [], [{ ...ADMIN_RULE, id: 'personal', layout: 'minimal' }]]) {
  test(`Reset copies layout defaults without importing admin rules (personal=${personal?.length ?? 'missing'})`, async t => {
    const h = setup(t, personal === undefined ? {} : { tagLookRules: personal });
    await h.click(h.document.getElementById('jeTgeReset'));
    const saved = h.saved();
    assert.deepEqual(saved.tagLookRules, personal || []);
    assert.equal(saved.tagLayout, 'bands');
    assert.equal(saved.tagLabelDensity, 'compact');
    assert.equal(h.host.dataset.jeLayout, personal?.length ? 'minimal' : 'bands');
  });
}

test('promotion keeps existing personal rules untouched', async t => {
  const personal = [{ ...ADMIN_RULE, id: 'personal', layout: 'minimal' }];
  const h = setup(t, { tagLookRules: personal });
  await h.click(h.row('ageRating').querySelector('[data-slot="tl"]'));
  assert.deepEqual(h.saved().tagLookRules, personal);
});

test('one cap step on a legacy document changes only that group', async t => {
  const h = setup(t);
  const before = snapshot(h.host);
  await h.click(h.row('genre').querySelector('.je-tge-step[data-step="-1"]'));
  // A genre cap change re-renders genre tags (older cache entries hold three); the pipeline redraws the card.
  h.render();
  const after = snapshot(h.host);
  assertOnlyChanged(before, after, ['genre']);
  assert.equal(h.host.querySelectorAll('.genre-tag').length, 2);
  assert.deepEqual(h.saved().tagGroupCaps, { quality: 0, genre: 2, language: 3, rating: 0, ageRating: 1, status: 1, awards: 2, logos: 0, custom: 3 });
});

test('one density change on a legacy document changes only the labels it shortens', async t => {
  const h = setup(t);
  const before = snapshot(h.host);
  await h.change(h.document.querySelector('input[name="jeTagDensity"][value="compact"]'), true);
  const after = snapshot(h.host);
  // Compact shortens quality/status labels and drops the critic chip beside a community one.
  assertOnlyChanged(before, after, ['quality', 'rating', 'status']);
  assert.equal(h.host.querySelector('.status-tag').textContent, 'status_tag_compact_added');
  assert.equal(after.groups.rating.slot, before.groups.rating.slot);
  assert.deepEqual(after.groups.rating.before, before.groups.rating.before);
  const saved = h.saved();
  assert.equal(saved.tagLabelDensity, 'compact');
  assert.equal(saved.tagLayout, 'corners');
  assert.equal(saved.tagGroupOrder, null);
});

test('a layout change on a legacy document keeps the legacy limits and full labels', async t => {
  const h = setup(t);
  await h.change(h.document.querySelector('input[name="jeTagLayout"][value="bands"]'), true);
  const s = h.JE.core.tagLayout.normalizeSettings();
  assert.equal(s.layout, 'bands');
  assert.equal(s.density, 'full', 'not the admin density');
  assert.deepEqual(plain(s.caps), { quality: 0, genre: 3, language: 3, rating: 0, ageRating: 1, status: 1, awards: 2, logos: 0, custom: 3 }, 'not the admin caps');
  assert.equal(h.host.querySelectorAll('.quality-overlay-label').length, 4);
});

test('the first move on a legacy document writes the shown order and nothing else', async t => {
  const h = setup(t);
  await h.click(h.row('genre').querySelector('[data-dir="up"]'));
  const saved = h.saved();
  assert.deepEqual(saved.tagGroupOrder, ['status', 'quality', 'rating', 'ageRating', 'genre', 'language', 'awards', 'logos', 'custom']);
  assert.equal(saved.tagLabelDensity, 'full');
  assert.deepEqual(saved.tagGroupCaps, { quality: 0, genre: 3, language: 3, rating: 0, ageRating: 1, status: 1, awards: 2, logos: 0, custom: 3 });
});
