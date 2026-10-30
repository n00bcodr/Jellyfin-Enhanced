import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, plain, jsRoot } from '../helpers/harness.mjs';

// The Media Tags admin page (Configuration/mediaTagsPage.html): the real page
// core and every real section module over a mocked plugin configuration and
// server. Each test changes controls the way an administrator does and reads
// back what the page saved.

const LIBRARY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_LIBRARY = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** A configuration as the server hands it out (only the fields the page reads). */
const BASE = {
  QualityTagsEnabled: true, GenreTagsEnabled: false, LanguageTagsEnabled: true, RatingTagsEnabled: true, AgeRatingTagsEnabled: false, StatusTagsEnabled: true, PeopleTagsEnabled: false,
  ShowResolutionTag: true, ShowSourceTag: true, ShowDynamicRangeTag: true, ShowSpecialFormatTag: true, ShowVideoCodecTag: true, ShowAudioInfoTag: true, ShowEditionTag: true, ShowLowQualitySourceTag: false,
  ResolutionTagOrder: 1, SourceTagOrder: 2, DynamicRangeTagOrder: 3, SpecialFormatTagOrder: 4, VideoCodecTagOrder: 5, AudioInfoTagOrder: 6, EditionTagOrder: 7,
  SeriesQualityAggregation: 'representative', QualityTagsPreferredAudioLanguage: '', QualityTagsAudioLanguageFromUser: false,
  QualityTagsPosition: 'top-left', GenreTagsPosition: 'top-right', LanguageTagsPosition: 'bottom-left', RatingTagsPosition: 'bottom-right', AgeRatingTagsPosition: 'bottom-right', StatusTagsPosition: 'top-right',
  LanguageTagsPriority: '', LanguageTagsPriorityStrict: false, LanguageTagsMergeRegions: false, LanguageTagsShowAudio: true, LanguageTagsShowSubtitles: false, LanguageTagsStyle: 'flags', LanguageTagsCountBadge: 'off',
  RatingTagsOnMovies: true, RatingTagsOnSeries: true, RatingTagsOnSeasons: true, RatingTagsOnEpisodes: true, RatingTagsOnContinueWatching: true, RatingTagsOnNextUp: true,
  RatingTagsShowCommunity: true, RatingTagsShowCritic: true, RatingTagsSources: null, RatingTagsMinScore: 0, RatingTagsColorByScore: false, ShowRatingInPlayer: true,
  StatusTagsJustAdded: true, StatusTagsNewRelease: true, StatusTagsTrending: true, StatusTagsSchedule: true, StatusTagsMilestones: true, StatusTagsSeriesStatus: false, StatusTagsJustAddedDays: 7, StatusTagsNewReleaseDays: 30,
  TagLayout: 'corners', TagLabelDensity: 'full', TagLayouts: null, TagGroupOrder: null, TagGroupCaps: null, TagLookRules: null, TagShapeOverrides: null,
  TagsHideOnHover: false, DisableTagsOnSearchPage: false,
  TagStylesEnabled: true, TagStyleTarget: 'both', TagStyleOverrides: '', TagStylePreset: 'default', TagStylesAllowUserPreset: false,
  TagCacheServerMode: true, TagCacheExcludeLibraries: false, TagCacheExcludedLibraryIds: '', EnableTagsLocalStorageFallback: false, TagsCacheTtlDays: 30,
  NativePosterTagsEnabled: false, NativePosterTagsWebClientNames: '',
  MdblistApiKey: '', MdblistRatingsEnabled: false, MdblistRatingsFetchEnabled: false, TMDB_API_KEY: 'key',
  // A field this page never touches: saves must keep the server's value.
  DevMode: false,
};

const catalog = { presets: ['default', 'glass'], age: [], groups: { quality: [{ key: '4K', name: '4K' }], ageRating: [], rating: [{ key: 'community', name: 'Community' }], genre: [{ key: 'genre', name: 'Genre' }], status: [{ key: 'added', name: 'Just Added' }], language: [{ key: 'flag', name: 'Flag' }] }, palettes: { default: {}, glass: {} } };

/**
 * The page over a mocked server.
 * @param {import('node:test').TestContext} t
 * @param {{config?: object, url?: string, confirm?: boolean}} [options]
 */
function setup(t, { config = {}, url, confirm = true } = {}) {
  const server = structuredClone({ ...BASE, ...config });
  const puts = [];
  const posts = [];
  const confirms = [];
  const h = createHarness({
    html: '<div id="jeTaRoot"></div>',
    url: url || 'http://jellyfin.test/web/index.html#/configurationpage?name=JellyfinEnhancedMediaTags',
    JE: { t: (key, params) => (params ? `${key}:${Object.values(params).join('|')}` : key), pluginConfig: {}, currentSettings: {} },
    apiClient: {
      getUrl: (path, query) => `http://jellyfin.test/${path.replace(/^\//, '')}${query ? `?${new URLSearchParams(query)}` : ''}`,
      getJSON: async () => [{ ItemId: LIBRARY, Name: 'Movies' }, { ItemId: OTHER_LIBRARY, Name: 'Shows' }],
      ajax: async (request) => {
        const path = new URL(request.url).pathname;
        if (request.type === 'POST') { posts.push(path); return { message: 'started' }; }
        if (path.endsWith('/tag-cache/summary')) return { enabled: true, entries: 1234, lastModified: 0, rebuilding: false };
        if (path.endsWith('/Localization/Cultures')) return [{ TwoLetterISOLanguageName: 'en', DisplayName: 'English' }, { TwoLetterISOLanguageName: 'ja', DisplayName: 'Japanese' }];
        if (path.endsWith('/tag-styles/catalog')) return catalog;
        return null;
      },
    },
    // mediaTagsPage.html defines the local CDN route (flags in the colour editor).
    globals: { jeCdnUrl: (path) => `http://jellyfin.test/JellyfinEnhanced/cdn/${path}` },
  });
  t.after(() => { ctx?.dispose(); h.close(); });
  // jsdom has no canvas: the colour editor's parser gets a minimal 2D context.
  h.window.HTMLCanvasElement.prototype.getContext = () => {
    let fill = '#000000';
    return { get fillStyle() { return fill; }, set fillStyle(v) { if (/^(#[0-9a-f]{6}|rgba?\([\d.,\s]+\))$/i.test(String(v).trim())) fill = String(v).trim().toLowerCase(); } };
  };
  h.window.Element.prototype.scrollIntoView = function () {};
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/rating-sources.js', 'enhanced/settingspanel/ui-panel-tag-editor.js', 'enhanced/admintags/admin-tags.js']) h.load(file);
  h.JE.escapeHtml = h.JE.core.ui.escapeHtml;
  const A = h.JE.adminTags;
  for (const file of A.SECTION_FILES) h.load(`enhanced/admintags/${file}`);
  const root = h.document.getElementById('jeTaRoot');
  let ctx = A.createPage(root, structuredClone(server), {
    api: { get: async () => structuredClone(server), put: async (c) => { puts.push(structuredClone(c)); Object.assign(server, structuredClone(c)); } },
    confirm: (text, title) => { confirms.push(title); return confirm; },
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const $ = (sel) => root.querySelector(sel);
  /** Set a control's value and fire change as a user would. */
  const change = (el, value) => {
    assert.ok(el, 'control exists');
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = value === undefined ? !el.checked : value;
    else el.value = value;
    el.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  };
  return { ...h, A, ctx, root, server, puts, posts, confirms, settle, $, $$: (sel) => [...root.querySelectorAll(sel)], change, save: async () => { await ctx.flush(); } };
}

test('every declared field reads its configuration field and saves the new value through the plugin configuration', async t => {
  const h = setup(t, { config: { NativePosterTagsEnabled: true } });
  await h.settle();
  const checked = [];
  for (const section of h.A.sections) {
    for (const f of section.fields || []) {
      if (f.type === 'custom') continue;
      const el = h.$(`[data-je-setting-id="${f.id}"]`);
      assert.ok(el, `${f.id} is on the page`);
      assert.equal(el.dataset.jeField, f.key, `${f.id} is bound to ${f.key}`);
      if (f.when && !f.when(h.ctx.config)) continue;
      let control = el;
      if (f.type === 'pills') {
        control = [...el.querySelectorAll('input')].find((r) => !r.checked);
        h.change(control, true);
      } else if (f.type === 'select') {
        h.change(el, [...el.options].find((o) => !o.selected && !o.disabled).value);
      } else if (f.type === 'number') h.change(el, String((f.min || 0) + 2));
      else if (f.type === 'text' || f.type === 'textarea') h.change(el, '  changed  ');
      else h.change(el);
      const expected = h.A.controlValue(f, el, h.ctx.config);
      await h.save();
      assert.deepEqual(plain(h.server[f.key]), plain(expected), `${f.id} saved ${f.key}`);
      checked.push(f.id);
    }
  }
  assert.ok(checked.length >= 50, `${checked.length} fields exercised`);
  assert.equal(h.server.LanguageTagsPriority, 'changed', 'text is trimmed');
  assert.equal(h.server.DevMode, false, 'fields the page does not own keep the server value');
});

test('a save copies only the changed fields into a fresh configuration', async t => {
  const h = setup(t);
  // Another admin (or the main configuration page) changed two fields meanwhile.
  h.server.DevMode = true;
  h.server.GenreTagsEnabled = true;
  h.change(h.$('#tagsHideOnHover'), true);
  assert.equal(h.$('#jeTaSaved').dataset.state, 'saving');
  await h.save();
  assert.equal(h.puts.length, 1);
  assert.equal(h.server.TagsHideOnHover, true);
  assert.equal(h.server.DevMode, true, 'untouched fields keep the newer server value');
  assert.equal(h.server.GenreTagsEnabled, true);
  assert.equal(h.$('#jeTaSaved').dataset.state, 'saved');
});

test('a failed save says so, keeps the change and retries', async t => {
  const h = setup(t);
  h.expectConsoleError(/could not save the Media Tags settings/);
  let fail = true;
  // A second page over a server that fails once.
  h.ctx.dispose();
  const server = structuredClone(BASE);
  const root = h.document.getElementById('jeTaRoot');
  const ctx = h.A.createPage(root, structuredClone(server), { api: { get: async () => structuredClone(server), put: async (c) => { if (fail) throw new Error('offline'); Object.assign(server, c); } }, confirm: () => true });
  t.after(() => ctx.dispose());
  h.change(root.querySelector('#disableTagsOnSearchPage'), true);
  assert.equal(await ctx.flush(), false);
  assert.equal(root.querySelector('#jeTaSaved').dataset.state, 'error');
  fail = false;
  root.querySelector('[data-je-retry]').click();
  await ctx.flush();
  assert.equal(server.DisableTagsOnSearchPage, true);
  assert.equal(root.querySelector('#jeTaSaved').dataset.state, 'saved');
});

test('tabs follow the WAI pattern and deep links open a tab and a group', async t => {
  const h = setup(t, { url: 'http://jellyfin.test/web/index.html#/configurationpage?name=JellyfinEnhancedMediaTags&tab=groups&group=rating' });
  assert.equal(h.root.dataset.tab, 'groups');
  assert.equal(h.$('.je-ta-grow[data-group="rating"]').dataset.open, 'true');
  assert.equal(h.$('#jeTaGroup-rating').hidden, false);
  assert.equal(h.$('#jeTaGroup-quality').hidden, true);
  const tab = h.$('#jeTaTab-groups');
  tab.focus();
  tab.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(h.root.dataset.tab, 'rules');
  assert.equal(h.document.activeElement, h.$('#jeTaTab-rules'));
  assert.equal(h.$('#jeTaPanel-groups').hidden, true);
  h.$('#jeTaTab-rules').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(h.root.dataset.tab, 'server');
  assert.deepEqual(h.$$('[role="tab"]').map((t) => t.tabIndex), [-1, -1, -1, -1, -1, -1, 0]);
  // data-je-goto links: Overview's group chips, the Status row's way to its badges.
  h.$('#jeTaTab-groups').click();
  h.$('#jeTaGroup-status [data-je-goto="badges"]').click();
  assert.equal(h.root.dataset.tab, 'badges');
});

test('Overview shows the defaults, the cache state, and rebuilds after a confirmation', async t => {
  const h = setup(t, { config: { TagLookRules: [{ Enabled: true, When: [{ Field: 'type', Value: 'Episode' }], Layout: 'bands', Density: 'compact' }] } });
  await h.settle();
  const groups = h.$$('.je-ta-ov-group');
  assert.deepEqual(groups.map((b) => [b.dataset.group, b.dataset.on]), [['quality', 'true'], ['genre', 'false'], ['language', 'true'], ['rating', 'true'], ['ageRating', 'false'], ['status', 'true'], ['people', 'false']]);
  assert.match(h.$('[data-ov="cache"]').textContent, /1,234|1234/);
  assert.match(h.$('[data-ov="look"]').textContent, /admin_tags_overview_rules_n:1/);
  groups[3].click();
  assert.equal(h.root.dataset.tab, 'groups');
  assert.equal(h.$('.je-ta-grow[data-group="rating"]').dataset.open, 'true');
  h.$('#jeTaTab-overview').click();
  h.$('[data-ov="rebuild"]').click();
  await h.settle(); await h.settle();
  assert.deepEqual(h.confirms, ['admin_tags_rebuild_title']);
  assert.deepEqual(h.posts, ['/JellyfinEnhanced/tag-cache/rebuild']);
});

test('Layout defaults: tiles, density, order, limits, nine anchors and per-layout slots write the old fields', async t => {
  const h = setup(t);
  h.change(h.$('input[name="jeTaLayout"][value="bands"]'), true);
  await h.save();
  assert.equal(h.server.TagLayout, 'bands');
  h.change([...h.$$('#tagLabelDensity input')].find((r) => r.value === 'compact'), true);
  await h.save();
  assert.equal(h.server.TagLabelDensity, 'compact');
  // Bands: a slot pick is stored as an explicit profile entry.
  h.$('.je-ta-lrow[data-group="genre"] [data-slot="top"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagLayouts.Bands), { Groups: [{ Group: 'genre', Slot: 'top' }] });
  assert.equal(h.server.TagLayouts.Corners, null);
  // Order: only written once changed, as a complete list.
  h.$('.je-ta-lrow[data-group="quality"] [data-act="move"][data-dir="-1"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagGroupOrder), ['quality', 'status', 'rating', 'ageRating', 'language', 'genre']);
  assert.equal(h.document.activeElement?.dataset.act, 'move', 'focus stays on the move button');
  // Limits: genre 3 → 4; fixed groups have no stepper.
  h.$('.je-ta-lrow[data-group="genre"] [data-act="cap"][data-dir="1"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagGroupCaps), { Genre: 4 });
  assert.ok(h.$('.je-ta-lrow[data-group="status"] [data-act="cap"][data-dir="1"]').disabled);
  // Corners: an anchor writes the old position setting; Hidden is the only stored corners entry.
  h.change(h.$('input[name="jeTaLayout"][value="corners"]'), true);
  h.$('.je-ta-lrow[data-group="genre"] .je-ta-anchor[data-slot="bc"]').click();
  await h.save();
  assert.equal(h.server.GenreTagsPosition, 'bottom-center');
  h.$('.je-ta-lrow[data-group="genre"] [data-slot="off"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagLayouts.Corners), { Groups: [{ Group: 'genre', Slot: 'off' }] });
  assert.equal(h.server.GenreTagsPosition, 'bottom-center', 'Hidden keeps the position for later');
  h.$('.je-ta-lrow[data-group="genre"] .je-ta-anchor[data-slot="tl"]').click();
  await h.save();
  assert.equal(h.server.TagLayouts.Corners, null, 'a corner pick shows the group again');
  assert.equal(h.server.GenreTagsPosition, 'top-left');
});

test('Layout defaults: card shapes write the recommended look, keep a custom one and inherit with null', async t => {
  const custom = { Layout: 'summary', Density: 'full', Slots: [{ Group: 'rating', Slot: 'pill' }], Caps: { Rating: 1 } };
  const h = setup(t, { config: { TagShapeOverrides: { Landscape: custom, List: null } } });
  const L = h.JE.core.tagLayout;
  assert.equal(h.$('#tagShapeLandscapeDefault').value, 'custom');
  assert.equal(h.$('#tagShapeListDefault').value, 'inherit');
  assert.equal(h.$('#tagShapeListDefault option[value="custom"]').hidden, true);
  h.change(h.$('#tagShapeListDefault'), 'recommended');
  await h.save();
  assert.deepEqual(plain(h.server.TagShapeOverrides.Landscape), custom, 'the custom look is kept untouched');
  assert.deepEqual(plain(L.readShapeOverrides(h.server.TagShapeOverrides).list), plain(L.readShapeOverrides(L.RECOMMENDED_SHAPES).list));
  assert.equal(h.server.TagShapeOverrides.List.Caps.Quality, 2);
  h.change(h.$('#tagShapeLandscapeDefault'), 'inherit');
  h.change(h.$('#tagShapeListDefault'), 'inherit');
  await h.save();
  assert.equal(h.server.TagShapeOverrides, null);
});

test('Layout defaults: Apply defaults to all users saves first, then asks the server to copy them', async t => {
  const h = setup(t);
  h.change(h.$('#tagsHideOnHover'), true);
  h.$('#jeTaApplyAll').click();
  await h.settle(); await h.settle(); await h.settle();
  assert.deepEqual(h.confirms, ['admin_tags_apply_all']);
  assert.equal(h.server.TagsHideOnHover, true, 'pending changes are saved before the copy');
  assert.deepEqual(h.posts, ['/JellyfinEnhanced/reset-all-users-settings']);
});

test('Groups › Quality: reordering writes every order key, and the saved audio language survives the culture list', async t => {
  const h = setup(t, { config: { QualityTagsPreferredAudioLanguage: 'pt-BR', ShowEditionTag: false } });
  await h.settle(); await h.settle();
  const select = h.$('#qualityTagsPreferredAudioLanguage');
  assert.equal(select.value, 'pt-BR', 'a code the list does not offer stays selected');
  assert.ok([...select.options].some((o) => o.value === 'ja'), 'the named list is in');
  h.$('li[data-ordered="showAudioInfoTag"] [data-move="-1"]').click();
  await h.save();
  assert.equal(h.server.AudioInfoTagOrder, 5);
  assert.equal(h.server.VideoCodecTagOrder, 6);
  assert.equal(h.server.ResolutionTagOrder, 1);
  assert.match(h.$('.je-ta-grow[data-group="quality"] .je-ta-grow-sum').textContent, /admin_tags_quality_summary:6\|7/);
  h.change(h.$('#qualityTagsEnabled'), false);
  await h.save();
  assert.equal(h.server.QualityTagsEnabled, false);
  assert.equal(h.$('.je-ta-grow[data-group="quality"]').dataset.enabled, 'false');
});

test('Groups › Rating: sources keep their order and an empty choice, legacy switches seed the list, MDBList state shows', async t => {
  const h = setup(t, { config: { RatingTagsShowCritic: false, MdblistRatingsEnabled: true } });
  const rows = () => h.$$('#ratingTagsSourceRows [data-source]');
  assert.deepEqual(rows().filter((r) => r.querySelector('input').checked).map((r) => r.dataset.source), ['community']);
  h.change(rows().find((r) => r.dataset.source === 'imdb').querySelector('input'), true);
  rows().find((r) => r.dataset.source === 'imdb').querySelector('[data-step="-1"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.RatingTagsSources), ['community', 'imdb']);
  rows().find((r) => r.dataset.source === 'imdb').querySelector('[data-step="-1"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.RatingTagsSources), ['imdb', 'community']);
  for (const r of rows()) h.change(r.querySelector('input'), false);
  await h.save();
  assert.deepEqual(plain(h.server.RatingTagsSources), [], 'an empty list is a choice');
  h.change(h.$('#ratingTagsMinScore'), '7');
  await h.save();
  assert.equal(h.server.RatingTagsMinScore, 7);
  assert.match(h.$('[data-mdblist]').textContent, /admin_tags_mdblist_no_key/);
  assert.match(h.$('[data-mdblist] a').href, /name=Jellyfin%20Enhanced&jeSection=mdblistRatingsEnabled$/);
});

test('Groups › Language, Genre, Age rating, Status and People write their switches and fields', async t => {
  const h = setup(t);
  for (const [id, key] of [['genreTagsEnabled', 'GenreTagsEnabled'], ['ageRatingTagsEnabled', 'AgeRatingTagsEnabled'], ['peopleTagsEnabled', 'PeopleTagsEnabled'], ['statusTagsEnabled', 'StatusTagsEnabled']]) {
    const before = h.server[key];
    h.change(h.$(`#${id}`));
    await h.save();
    assert.equal(h.server[key], !before, key);
  }
  h.change([...h.$$('#languageTagsStyle input')].find((r) => r.value === 'codes'), true);
  h.change(h.$('#languageTagsCountBadge'), 'both');
  h.change(h.$('#languageTagsPriority'), ' English, ja ');
  await h.save();
  assert.equal(h.server.LanguageTagsStyle, 'codes');
  assert.equal(h.server.LanguageTagsCountBadge, 'both');
  assert.equal(h.server.LanguageTagsPriority, 'English, ja');
  assert.match(h.$('.je-ta-grow[data-group="language"] .je-ta-grow-sum').textContent, /admin_tags_language_priority_summary:English, ja/);
});

test('Rules: add, switch off, reorder, delete with undo, and JSON with the old checks', async t => {
  const h = setup(t);
  await h.settle();
  h.change(h.$('[data-rule="field"]'), 'type');
  h.$('[data-rule="value"]').value = 'Episode';
  h.$('[data-rule="layout"]').value = 'bands';
  h.$('[data-rule="density"]').value = 'compact';
  h.$('[data-rule="add"]').click();
  h.change(h.$('[data-rule="field"]'), 'library');
  h.$('[data-rule="value"]').value = LIBRARY;
  h.$('[data-rule="layout"]').value = 'corners';
  h.$('[data-rule="density"]').value = 'full';
  h.$('[data-rule="add"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagLookRules.map((r) => [r.When[0].Field, r.When[0].Value, r.Layout, r.Density])), [['type', 'Episode', 'bands', 'compact'], ['library', LIBRARY, 'corners', 'full']]);
  assert.match(h.$('.je-ta-rule[data-index="1"]').textContent, /admin_tags_rules_condition:tag_looks_field_library\|Movies/, 'library rules show the library name');
  h.change(h.$('.je-ta-rule[data-index="0"] [data-act="enable"]'), false);
  h.$('.je-ta-rule[data-index="1"] [data-act="move"][data-dir="-1"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagLookRules.map((r) => [r.When[0].Field, r.Enabled])), [['library', true], ['type', false]]);
  h.$('.je-ta-rule[data-index="0"] [data-act="delete"]').click();
  await h.save();
  assert.equal(h.server.TagLookRules.length, 1);
  h.$('.je-ta-snack .je-ta-button').click();
  await h.save();
  assert.equal(h.server.TagLookRules.length, 2, 'undo restores the deleted rule');
  // JSON: invalid input is refused with the reason; valid input replaces the rules (per-shape looks kept).
  const box = h.$('#tagLookRulesJson');
  box.value = '[{"when": [{"field": "library", "value": "nope"}], "layout": "bands"}]';
  box.dispatchEvent(new h.window.Event('input'));
  h.$('[data-rule="json-save"]').click();
  assert.match(h.$('#tagLookRulesJsonStatus').textContent, /admin_tags_rules_json_library:1/);
  box.value = JSON.stringify([{ when: [{ field: 'genre', value: 'Anime' }], layout: 'minimal', shapes: { landscape: { layout: 'bands' } } }]);
  box.dispatchEvent(new h.window.Event('input'));
  h.$('[data-rule="json-save"]').click();
  await h.save();
  assert.deepEqual(plain(h.server.TagLookRules), [{ Id: '', Enabled: true, When: [{ Field: 'genre', Value: 'Anime' }], Layout: 'minimal', Density: 'full', ColourPreset: null, Slots: null, Shapes: { landscape: { layout: 'bands' } } }]);
});

test('Colours: editor edits save the Tag Styles document; Reset all asks, saves and can be undone', async t => {
  const stored = JSON.stringify({ v: 2, preset: 'default', groups: { quality: { background: 'rgba(255, 0, 0, 1)' } } });
  const h = setup(t, { config: { TagStyleOverrides: stored } });
  await h.settle(); await h.settle();
  h.$('#jeTaTab-colours').click();
  h.$('.je-ts-preset[data-preset="glass"]').click();
  await h.save();
  assert.equal(h.server.TagStylePreset, 'glass');
  assert.equal(JSON.parse(h.server.TagStyleOverrides).preset, 'glass');
  h.$('#tagStyleResetAll').click();
  await h.settle();
  await h.save();
  assert.deepEqual(h.confirms, ['admin_tags_colours_reset']);
  assert.equal(h.server.TagStyleOverrides, '');
  assert.equal(h.server.TagStylePreset, 'default');
  h.$('.je-ta-snack .je-ta-button').click();
  await h.save();
  assert.equal(JSON.parse(h.server.TagStyleOverrides).groups.quality.background, 'rgba(255, 0, 0, 1)');
  assert.equal(h.server.TagStylePreset, 'glass');
  // Off hides the editor; Apply to is disabled with it.
  h.change(h.$('#tagStylesEnabled'), false);
  assert.equal(h.$('#tagStylesBody').style.display, 'none');
  assert.ok([...h.$$('#tagStyleTarget input')].every((r) => r.disabled));
});

test('Status badges: family switches and windows (clamped to 1-365)', async t => {
  const h = setup(t, { config: { StatusTagsEnabled: false } });
  assert.equal(h.$('[data-badges-off]').hidden, false);
  h.change(h.$('#statusTagsSeriesStatus'), true);
  h.change(h.$('#statusTagsJustAddedDays'), '500');
  h.change(h.$('#statusTagsNewReleaseDays'), '0');
  await h.save();
  assert.equal(h.server.StatusTagsSeriesStatus, true);
  assert.equal(h.server.StatusTagsJustAddedDays, 365);
  assert.equal(h.server.StatusTagsNewReleaseDays, 1);
  assert.equal(h.$('#statusTagsJustAddedDays').value, '365');
});

test('Server: cache off keeps the browser cache on, excluded libraries and the clear signal are saved', async t => {
  const h = setup(t, { config: { TagCacheExcludeLibraries: true, TagCacheExcludedLibraryIds: OTHER_LIBRARY } });
  await h.settle(); await h.settle();
  const boxes = h.$$('[data-libs] input');
  assert.deepEqual(boxes.map((b) => [b.dataset.libraryId, b.checked]), [[LIBRARY, false], [OTHER_LIBRARY, true]]);
  h.change(boxes[0], true);
  await h.save();
  assert.equal(h.server.TagCacheExcludedLibraryIds, `${LIBRARY},${OTHER_LIBRARY}`);
  assert.equal(h.$('[data-field-row="enableTagsLocalStorageFallback"]').hidden, true);
  h.change(h.$('#tagCacheServerMode'), false);
  await h.save();
  assert.equal(h.server.TagCacheServerMode, false);
  assert.equal(h.server.EnableTagsLocalStorageFallback, true, 'without the server cache the browser cache is always on');
  assert.equal(h.$('[data-field-row="enableTagsLocalStorageFallback"]').hidden, false);
  assert.equal(h.$('#tagCacheExcludeLibraries').disabled, true);
  h.$('#clearTagsCacheBtn').click();
  await h.settle(); await h.settle();
  assert.ok(h.server.ClearLocalStorageTimestamp > 0);
  assert.equal(h.$('#nativePosterTagsWebClientNames').disabled, true, 'client names need native posters on');
});

test('a new user\'s preview document carries every tag setting the server seeds from the configuration', () => {
  // Lexical cross-check against LoadUserSettingsDocument: every tag setting it copies
  // straight from the configuration must reach the preview's seeded document.
  const controller = readFileSync(resolve(jsRoot, '../Controllers/JellyfinEnhancedController.cs'), 'utf8');
  const block = controller.slice(controller.indexOf('var defaultUserSettings = new JellyfinEnhancedUserSettings'), controller.indexOf('TagLayoutRules.ApplyDefaults(defaultUserSettings'));
  const copied = [...block.matchAll(/(\w+) = (?:[\w.]+\()?defaultConfig\.(\w+)/g)].map((m) => m[2]).filter((k) => /Tag|Rating|Quality|Language|Status|Aggregation|^Show(Resolution|Source|Edition|LowQuality|DynamicRange|SpecialFormat|VideoCodec|AudioInfo)/.test(k));
  const h = createHarness({ JE: {} });
  try {
    h.load('enhanced/admintags/admin-tags.js');
    const seeded = h.JE.adminTags.SEEDED_KEYS;
    for (const key of copied) if (!['ShowAudioLanguages', 'DefaultLanguage'].includes(key)) assert.ok(seeded.includes(key), `${key} is seeded`);
    const user = h.JE.adminTags.seedUser({ QualityTagsEnabled: true, TagLayout: 'bands', TagGroupCaps: { Genre: 2 } });
    assert.deepEqual(plain(user), { qualityTagsEnabled: true, tagLayout: 'bands', tagGroupCaps: { Genre: 2 }, tagLayoutSettingsVersion: 1, tagStylePreset: null, useNativePosterTags: null });
  } finally { h.close(); }
});

test('the hub preview draws a supplied document and hands the signed-in user\'s settings back', t => {
  const h = setup(t, { config: { GenreTagsEnabled: false } });
  const own = h.JE.currentSettings;
  const plugin = h.JE.pluginConfig;
  h.load('enhanced/settingspanel/ui-panel-tag-preview.js');
  const mount = h.document.createElement('div');
  h.root.appendChild(mount);
  const seed = { ...h.A.seedUser(h.ctx.config), qualityTagsEnabled: true };
  const preview = h.JE.internals.enhancedUi.createTagPreview(mount, { source: () => ({ settings: seed, plugin: h.ctx.config }) });
  assert.equal(h.JE.currentSettings, own, 'the user\'s settings are back after drawing');
  assert.equal(h.JE.pluginConfig, plugin);
  assert.ok(mount.querySelector('[data-sample="movie"] .quality-overlay-container'), 'drawn from the supplied document');
  assert.equal(mount.querySelector('[data-sample="movie"] .genre-overlay-container'), null);
  assert.match(h.document.getElementById('je-tag-preview').textContent, /:is\(#jellyfin-enhanced-panel, \.je-tag-admin\) \.je-mtp-samples/);
  preview.dispose();
});

test('each section module is a self-contained file the page loads, and every declaration is one line', () => {
  const dir = resolve(jsRoot, 'enhanced/admintags/sections');
  const h = createHarness({ JE: {} });
  try {
    h.load('enhanced/admintags/admin-tags.js');
    const listed = h.JE.adminTags.SECTION_FILES.filter((f) => f.startsWith('sections/')).map((f) => f.slice(9)).sort();
    assert.deepEqual(plain(listed), readdirSync(dir).filter((f) => f.endsWith('.js')).sort(), 'SECTION_FILES lists every section module');
  } finally { h.close(); }
  // The generators (scripts/generate_config_flag_groups.py, WhatsNewService) read field declarations lexically.
  for (const file of readdirSync(dir)) {
    const text = readFileSync(resolve(dir, file), 'utf8');
    for (const line of text.split('\n')) {
      if (/^\s*\{ id: '/.test(line)) assert.match(line, /^\s*\{ id: '\w+', key: '\w+', type: '\w+'.*label: '\w+'/, `${file}: ${line.trim().slice(0, 60)}`);
    }
  }
});
