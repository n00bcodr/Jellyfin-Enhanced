import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, deferred, plain, jsRoot } from '../helpers/harness.mjs';

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

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * POST JellyfinEnhanced/admin/configuration as the server answers it
 * (Helpers/PluginConfigurationPatch.cs): refused with the server's values when
 * an expected field moved on (and is not already the requested value),
 * otherwise only the changed fields are written.
 * @param {object} server
 * @param {{Changes: object, Expected?: object}} body
 */
function serverPatch(server, body) {
  const conflicts = {};
  for (const [key, before] of Object.entries(body.Expected || {})) {
    if (!same(server[key], before) && !same(server[key], body.Changes[key])) conflicts[key] = structuredClone(server[key] ?? null);
  }
  if (Object.keys(conflicts).length) throw { status: 409, json: async () => ({ conflicts }) };
  Object.assign(server, structuredClone(body.Changes));
  return { values: structuredClone(body.Changes) };
}

/**
 * A browser realm with the page core and every section module loaded, over a
 * mocked server (`server`), without a page built yet. Field saves go through
 * `patch` (default: serverPatch) and are recorded in `patches`.
 * @param {import('node:test').TestContext} t
 * @param {{server: object, url?: string, apiClient?: object, globals?: object, patch?: Function, routes?: Object<string, Function>}} options
 *   routes: GET path suffix → answer, before the defaults.
 */
function boot(t, { server, url, apiClient = {}, globals = {}, patch, routes = {} }) {
  const posts = [];
  const patches = [];
  const h = createHarness({
    html: '<div id="jeTaRoot"></div>',
    url: url || 'http://jellyfin.test/web/index.html#/configurationpage?name=JellyfinEnhancedMediaTags',
    JE: { t: (key, params) => (params ? `${key}:${Object.values(params).join('|')}` : key), pluginConfig: {}, currentSettings: {} },
    apiClient: {
      getUrl: (path, query) => `http://jellyfin.test/${path.replace(/^\//, '')}${query ? `?${new URLSearchParams(query)}` : ''}`,
      getJSON: async () => [{ ItemId: LIBRARY, Name: 'Movies' }, { ItemId: OTHER_LIBRARY, Name: 'Shows' }],
      getPluginConfiguration: async () => structuredClone(server),
      ajax: async (request) => {
        const path = new URL(request.url).pathname;
        if (request.type === 'POST' && path.endsWith('/JellyfinEnhanced/admin/configuration')) {
          const body = JSON.parse(request.data);
          patches.push(structuredClone(body));
          return (patch || ((b) => serverPatch(server, b)))(body);
        }
        if (request.type === 'POST') { posts.push(path); return { message: 'started' }; }
        for (const [suffix, answer] of Object.entries(routes)) if (path.endsWith(suffix)) return answer(request);
        if (path.endsWith('/tag-cache/summary')) return { enabled: true, entries: 1234, lastModified: 0, rebuilding: false };
        if (path.endsWith('/Localization/Cultures')) return [{ TwoLetterISOLanguageName: 'en', DisplayName: 'English' }, { TwoLetterISOLanguageName: 'ja', DisplayName: 'Japanese' }];
        if (path.endsWith('/tag-styles/catalog')) return catalog;
        return null;
      },
      ...apiClient,
    },
    // mediaTagsPage.html defines the local CDN route (flags in the colour editor).
    globals: { jeCdnUrl: (path) => `http://jellyfin.test/JellyfinEnhanced/cdn/${path}`, Dashboard: {}, ...globals },
  });
  // Views are disposed before the realm closes.
  const cleanup = [];
  t.after(() => { for (const fn of cleanup.reverse()) fn(); h.close(); });
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
  const settle = () => new Promise((r) => setTimeout(r, 0));
  /** Set a control's value and fire change as a user would. */
  const change = (el, value) => {
    assert.ok(el, 'control exists');
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = value === undefined ? !el.checked : value;
    else el.value = value;
    el.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  };
  return Object.assign(h, { A, posts, patches, settle, change, cleanup });
}

/**
 * The page over a mocked server.
 * @param {import('node:test').TestContext} t
 * @param {{config?: object, url?: string, confirm?: boolean}} [options]
 */
function setup(t, { config = {}, url, confirm = true } = {}) {
  const server = structuredClone({ ...BASE, ...config });
  const confirms = [];
  const h = boot(t, { server, url });
  const root = h.document.getElementById('jeTaRoot');
  // The page's own host: ApiClient.getPluginConfiguration and the field patch above.
  const ctx = h.A.createPage(root, structuredClone(server), { confirm: (text, title) => { confirms.push(title); return confirm; } });
  h.cleanup.push(() => ctx.dispose());
  const $ = (sel) => root.querySelector(sel);
  return { ...h, ctx, root, server, confirms, $, $$: (sel) => [...root.querySelectorAll(sel)], save: async () => { await ctx.flush(); } };
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

/**
 * The binding oracle, independent of the page's own declarations: every
 * control id of the old main form's Media Tags and Tag Cache fieldsets
 * (configPage.html at aa1354dd) and the PluginConfiguration field its own
 * load/save line used there.
 */
const OLD_FORM = JSON.parse(readFileSync(new URL('./features-admin-tags-page.old-form-fields.json', import.meta.url), 'utf8'));
/** Positions are the nine anchors on Layout defaults now (Corners). */
const POSITION_GROUPS = { qualityTagsPosition: 'quality', genreTagsPosition: 'genre', languageTagsPosition: 'language', ratingTagsPosition: 'rating', ageRatingTagsPosition: 'ageRating', statusTagsPosition: 'status' };
/** Fields the new page writes with a control on purpose: without the server cache the browser cache is always on. */
const ALSO_WRITES = { tagCacheServerMode: ['EnableTagsLocalStorageFallback'] };

test('every old-form control writes exactly its own field (oracle from the old form, payload delta per control)', async t => {
  const declared = new Map();
  const driven = [];
  const displayOnly = [];
  // Two starting points, so every control is enabled in one: server cache on, then off.
  for (const serverMode of [true, false]) {
    const h = setup(t, { config: { NativePosterTagsEnabled: true, TagStylesEnabled: true, TagCacheServerMode: serverMode, StatusTagsEnabled: true } });
    await h.settle(); await h.settle();
    for (const s of h.A.sections) for (const f of s.fields || []) declared.set(f.id, f.key);
    for (const [id, key] of Object.entries(OLD_FORM.fields)) {
      assert.equal(declared.get(id), key, `${id} is declared for ${key}, as on the old form`);
      if (driven.includes(id)) continue;
      const before = structuredClone(h.server);
      const count = h.patches.length;
      let expected;
      if (POSITION_GROUPS[id]) {
        if (!serverMode) continue;
        h.$(`.je-ta-lrow[data-group="${POSITION_GROUPS[id]}"] .je-ta-anchor[data-slot="bc"]`).click();
        expected = 'bottom-center';
      } else {
        const el = h.$(`[data-je-setting-id="${id}"]`);
        assert.ok(el, `${id} is on the page`);
        assert.equal(el.dataset.jeField, key, `${id} is bound to ${key}`);
        const inputs = el.matches('input, select, textarea') ? [el] : [...el.querySelectorAll('input')];
        if (inputs.every((i) => i.disabled) || el.closest('[data-field-row]')?.hidden) continue;
        if (el.type === 'checkbox') { expected = !el.checked; h.change(el, expected); }
        else if (el.tagName === 'SELECT') { expected = [...el.options].find((o) => o.value !== el.value && !o.disabled).value; h.change(el, expected); }
        else if (el.type === 'number') { expected = Number(el.value) >= Number(el.max) ? Number(el.value) - 1 : Number(el.value) + 1; h.change(el, String(expected)); }
        else if (el.tagName === 'TEXTAREA' || el.type === 'text') { h.change(el, `  ${id}  `); expected = id; }
        else { const radio = inputs.find((r) => !r.checked); expected = radio.value; h.change(radio, true); }
      }
      await h.ctx.flush();
      assert.equal(h.patches.length, count + 1, `${id}: one save`);
      const delta = h.patches.at(-1).Changes;
      assert.deepEqual(Object.keys(delta).sort(), [key, ...(ALSO_WRITES[id] || [])].sort(), `${id} changes exactly ${key}`);
      assert.equal(String(delta[key]), String(expected), `${id} saves the value chosen`);
      for (const other of Object.keys(before)) if (other !== key && !(ALSO_WRITES[id] || []).includes(other)) assert.deepEqual(h.server[other], before[other], `${id} leaves ${other} alone`);
      driven.push(id);
      // Switch it back, so switches that enable others (the server cache) leave them as they were.
      const el = h.$(`[data-je-setting-id="${id}"]`);
      if (el?.type === 'checkbox') { h.change(el, !expected); await h.ctx.flush(); }
    }
  }
  for (const id of Object.keys(OLD_FORM.fields)) if (!driven.includes(id)) displayOnly.push(id);
  // Shown but not editable on its own: the browser cache follows the server cache switch.
  assert.deepEqual(displayOnly, ['enableTagsLocalStorageFallback']);
  assert.equal(driven.length, Object.keys(OLD_FORM.fields).length - 1);
  // Ids the old form bound with custom code, or actions: each still has its control.
  assert.deepEqual(OLD_FORM.unmapped, ['ratingTagsSources', 'tagLayout', 'tagShapeLandscapeDefault', 'tagShapeListDefault', 'tagLookRulesJson', 'clearTagsCacheBtn', 'tagStyleResetAll', 'rebuildTagCacheBtn']);
});

/** The fields the page owns, which the server's patch also allows (tests/fixtures/admin-tags-page-fields.json). */
const PAGE_FIELDS = JSON.parse(readFileSync(new URL('../../fixtures/admin-tags-page-fields.json', import.meta.url), 'utf8')).fields;

test('the page writes only the fields its sections declare, the list the server allows', async t => {
  const h = setup(t);
  assert.deepEqual(plain([...h.A.pageFields()].sort()), PAGE_FIELDS);
  // Every old-form field is one of them.
  for (const key of Object.values(OLD_FORM.fields)) assert.ok(PAGE_FIELDS.includes(key), key);
  // A section writing a field it did not declare: refused here, before the server would refuse it.
  h.expectConsoleError(/does not declare TMDB_API_KEY/);
  h.ctx.setMany({ TMDB_API_KEY: 'other', TagsHideOnHover: true });
  await h.save();
  assert.deepEqual(h.patches.map((p) => p.Changes), [{ TagsHideOnHover: true }]);
  assert.equal(h.server.TMDB_API_KEY, 'key');
});

test('a save sends only the changed fields, each with the value read before the edit', async t => {
  const h = setup(t);
  // Another admin (or the main configuration page) changed two fields meanwhile.
  h.server.DevMode = true;
  h.server.GenreTagsEnabled = true;
  h.change(h.$('#tagsHideOnHover'), true);
  assert.equal(h.$('#jeTaSaved').dataset.state, 'saving');
  await h.save();
  assert.deepEqual(h.patches, [{ Changes: { TagsHideOnHover: true }, Expected: { TagsHideOnHover: false } }]);
  assert.equal(h.server.TagsHideOnHover, true);
  assert.equal(h.server.DevMode, true, 'untouched fields keep the newer server value');
  assert.equal(h.server.GenreTagsEnabled, true);
  assert.equal(h.$('#jeTaSaved').dataset.state, 'saved');
  // The next edit of the same field expects what the last save stored.
  h.change(h.$('#tagsHideOnHover'), false);
  await h.save();
  assert.deepEqual(h.patches[1], { Changes: { TagsHideOnHover: false }, Expected: { TagsHideOnHover: true } });
});

test('another administrator\'s save between this page\'s read and its write is kept (different fields)', async t => {
  const server = structuredClone(BASE);
  const gate = deferred();
  let first = true;
  const h = boot(t, {
    server,
    // Hold this page's request until a second administrator saved another field.
    patch: async (body) => { if (first) { first = false; await gate.promise; } return serverPatch(server, body); },
  });
  const root = h.document.getElementById('jeTaRoot');
  const ctx = h.A.createPage(root, structuredClone(server));
  h.cleanup.push(() => ctx.dispose());
  h.change(root.querySelector('#tagsHideOnHover'), true);
  const saved = ctx.flush();
  await h.settle();
  serverPatch(server, { Changes: { DisableTagsOnSearchPage: true }, Expected: { DisableTagsOnSearchPage: false } });
  gate.resolve();
  assert.equal(await saved, true);
  assert.equal(server.TagsHideOnHover, true);
  assert.equal(server.DisableTagsOnSearchPage, true, 'the other administrator\'s field is not written back');
});

test('both administrators editing the same field: Changed elsewhere, nothing overwritten, Keep mine or Take theirs', async t => {
  const h = setup(t);
  h.server.StatusTagsJustAddedDays = 9;   // saved by someone else after this page loaded 7
  h.change(h.$('#statusTagsJustAddedDays'), '8');
  h.change(h.$('#tagsHideOnHover'), true);
  assert.equal(await h.ctx.flush(), false);
  assert.equal(h.server.StatusTagsJustAddedDays, 9, 'theirs is not overwritten');
  assert.equal(h.server.TagsHideOnHover, true, 'the other field in the refused request still saves');
  const chip = h.$('#jeTaSaved');
  assert.equal(chip.dataset.state, 'conflict');
  assert.match(chip.textContent, /admin_tags_conflict:admin_tags_badges_just_added_days/);
  // A later edit elsewhere saves without touching the refused field.
  h.change(h.$('#disableTagsOnSearchPage'), true);
  assert.equal(await h.ctx.flush(), false);
  assert.equal(h.server.DisableTagsOnSearchPage, true);
  assert.ok(!('StatusTagsJustAddedDays' in h.patches.at(-1).Changes));
  // Keep mine: saved over theirs, against their value.
  chip.querySelector('[data-je-keep]').click();
  assert.equal(await h.ctx.flush(), true);
  assert.deepEqual(h.patches.at(-1), { Changes: { StatusTagsJustAddedDays: 8 }, Expected: { StatusTagsJustAddedDays: 9 } });
  assert.equal(h.server.StatusTagsJustAddedDays, 8);
  assert.equal(chip.dataset.state, 'saved');
  // Take theirs: the page shows their value and sends nothing for it.
  h.server.StatusTagsJustAddedDays = 12;
  h.change(h.$('#statusTagsJustAddedDays'), '3');
  assert.equal(await h.ctx.flush(), false);
  const count = h.patches.length;
  chip.querySelector('[data-je-theirs]').click();
  assert.equal(await h.ctx.flush(), true);
  assert.equal(h.patches.length, count, 'nothing more is sent');
  assert.equal(h.server.StatusTagsJustAddedDays, 12);
  assert.equal(h.ctx.config.StatusTagsJustAddedDays, 12);
  assert.equal(h.$('#statusTagsJustAddedDays').value, '12');
  assert.equal(chip.dataset.state, 'saved');
});

test('a failed save says so, keeps the change and retries', async t => {
  const h = setup(t);
  h.expectConsoleError(/could not save the Media Tags settings/);
  let fail = true;
  // A second page over a server that fails once.
  h.ctx.dispose();
  const server = structuredClone(BASE);
  const root = h.document.getElementById('jeTaRoot');
  const ctx = h.A.createPage(root, structuredClone(server), { api: { get: async () => structuredClone(server), patch: async (changes, expected) => { if (fail) throw new Error('offline'); return serverPatch(server, { Changes: changes, Expected: expected }); } }, confirm: () => true });
  h.cleanup.push(() => ctx.dispose());
  h.change(root.querySelector('#disableTagsOnSearchPage'), true);
  assert.equal(await ctx.flush(), false);
  assert.equal(root.querySelector('#jeTaSaved').dataset.state, 'error');
  fail = false;
  root.querySelector('[data-je-retry]').click();
  await ctx.flush();
  assert.equal(server.DisableTagsOnSearchPage, true);
  assert.equal(root.querySelector('#jeTaSaved').dataset.state, 'saved');
});

/** Two retained Jellyfin page elements for the Media Tags page, as Jellyfin keeps them for distinct URLs. */
const TWO_PAGES = '<div class="page" id="JellyfinEnhancedMediaTagsPage"><div class="je-tag-admin"></div></div><div class="page" id="JellyfinEnhancedMediaTagsPage"><div class="je-tag-admin"></div></div>';

test('a failed save survives navigating to another Media Tags view: still pending there, and Retry saves it', async t => {
  const server = structuredClone(BASE);
  let fail = true;
  const writes = [];
  const asked = [];
  const h = boot(t, {
    server,
    url: 'http://jellyfin.test/web/index.html#/configurationpage?name=JellyfinEnhancedMediaTags&tab=layout',
    patch: (body) => { if (fail) throw new Error('offline'); writes.push(body); return serverPatch(server, body); },
    globals: { Dashboard: { confirm: (text, title, cb) => { asked.push(title); cb(false); } } },
  });
  h.expectConsoleError(/could not save the Media Tags settings/);
  h.document.body.innerHTML = TWO_PAGES;
  const [first, second] = h.document.querySelectorAll('.page');
  const a = await h.A.activate(first);
  h.cleanup.push(() => a.dispose());
  h.change(first.querySelector('#tagsHideOnHover'), true);
  assert.equal(await a.flush(), false, 'the save failed');
  assert.equal(first.querySelector('#jeTaSaved').dataset.state, 'error');
  assert.match(first.querySelector('#jeTaSaved').textContent, /admin_tags_save_failed_fields:admin_tags_hide_on_hover/);
  // Another Media Tags deep link: the first view is torn down, the edit is not.
  h.window.location.hash = '#/configurationpage?name=JellyfinEnhancedMediaTags&tab=groups';
  const b = await h.A.activate(second);
  h.cleanup.push(() => b.dispose());
  assert.equal(first.querySelector('.je-ta-tabs'), null, 'the old view is emptied');
  assert.equal(server.TagsHideOnHover, false);
  assert.equal(second.querySelector('#tagsHideOnHover').checked, true, 'the new view shows the unsaved edit');
  assert.equal(b.config.TagsHideOnHover, true);
  const chip = second.querySelector('#jeTaSaved');
  assert.equal(chip.dataset.state, 'error', 'not "All changes saved"');
  assert.match(chip.textContent, /admin_tags_save_failed_fields:admin_tags_hide_on_hover/);
  assert.deepEqual(plain(h.A.pendingState()), { state: 'error', fields: ['TagsHideOnHover'], failed: ['TagsHideOnHover'] });
  // Leaving Media Tags altogether while it is still failing asks; the edit stays either way.
  h.window.location.hash = '#/dashboard';
  await h.A.leaveWithPending();
  assert.deepEqual(asked, ['admin_tags_leave_title']);
  assert.deepEqual(plain(h.A.pendingState().fields), ['TagsHideOnHover']);
  // Back on the page with the server healthy again: Retry saves it.
  h.window.location.hash = '#/configurationpage?name=JellyfinEnhancedMediaTags&tab=groups';
  fail = false;
  chip.querySelector('[data-je-retry]').click();
  await b.flush();
  assert.equal(server.TagsHideOnHover, true);
  assert.equal(writes.length, 1);
  assert.equal(chip.dataset.state, 'saved');
  assert.deepEqual(plain(h.A.pendingState()), { state: 'saved', fields: [], failed: [] });
});

test('a torn-down page saves nothing: a reused root has one set of listeners, and Back/Forward saves a change once', async t => {
  const server = structuredClone(BASE);
  const h = boot(t, { server, url: 'http://jellyfin.test/web/index.html#/configurationpage?name=JellyfinEnhancedMediaTags&tab=layout' });
  h.document.body.innerHTML = TWO_PAGES;
  const [first, second] = h.document.querySelectorAll('.page');
  // A view torn down while its controls are still in the document: an event saves nothing.
  const root = first.querySelector('.je-tag-admin');
  const gone = h.A.createPage(root, structuredClone(server));
  const control = root.querySelector('#tagsHideOnHover');
  gone.dispose();
  h.change(control, true);
  assert.equal(gone.pending(), false);
  assert.equal(await gone.flush(), true);
  assert.equal(h.patches.length, 0);
  root.replaceChildren();
  // Back/Forward over two retained views: the first root is rebuilt, its old listeners are gone.
  const a = await h.A.activate(first);
  h.window.location.hash = '#/configurationpage?name=JellyfinEnhancedMediaTags&tab=groups';
  const b = await h.A.activate(second);
  h.window.location.hash = '#/configurationpage?name=JellyfinEnhancedMediaTags&tab=layout';
  const again = await h.A.activate(first);
  h.cleanup.push(() => { a.dispose(); b.dispose(); again.dispose(); });
  assert.equal(a.disposed, true);
  h.change(first.querySelector('#disableTagsOnSearchPage'), true);
  await again.flush();
  assert.equal(h.patches.length, 1, 'one change, one save');
  assert.deepEqual(h.patches[0].Changes, { DisableTagsOnSearchPage: true });
});

test('a cache summary that answers after the page was torn down starts no polling', async t => {
  const answer = deferred();
  let summaries = 0;
  const server = structuredClone(BASE);
  const h = boot(t, {
    server,
    apiClient: {
      ajax: async (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith('/tag-cache/summary')) { summaries++; return answer.promise; }
        if (path.endsWith('/tag-styles/catalog')) return catalog;
        return null;
      },
    },
  });
  const delays = [];
  const realSetTimeout = h.window.setTimeout;
  h.window.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, ms, ...rest); };
  const ctx = h.A.createPage(h.document.getElementById('jeTaRoot'), structuredClone(server));
  assert.equal(h.document.getElementById('jeTaRoot').dataset.tab, 'overview', 'Overview asks for the summary when shown');
  assert.equal(summaries, 1);
  ctx.dispose();
  answer.resolve({ enabled: true, entries: 5, lastModified: 0, rebuilding: true });
  await h.settle(); await h.settle();
  assert.ok(!delays.includes(3000), 'no poll was scheduled');
  assert.equal(summaries, 1);
});

test('the page shown again while a save is on its way keeps the value being saved, and a later edit saves after it', async t => {
  const server = structuredClone(BASE);
  const gate = deferred();
  let held = true;
  const h = boot(t, {
    server,
    patch: async (body) => { if (held) { held = false; await gate.promise; } return serverPatch(server, body); },
  });
  h.document.body.innerHTML = TWO_PAGES;
  const page = h.document.querySelector('.page');
  const ctx = await h.A.activate(page);
  h.cleanup.push(() => ctx.dispose());
  h.change(page.querySelector('#tagsHideOnHover'), true);
  const saved = ctx.flush();
  await h.settle();
  assert.equal(h.patches.length, 1, 'the save is on its way');
  // viewshow on the same view: a reload with the server's (old) configuration.
  assert.equal(await h.A.activate(page), ctx);
  assert.equal(ctx.config.TagsHideOnHover, true, 'the value being saved is not replaced');
  assert.equal(page.querySelector('#tagsHideOnHover').checked, true);
  // An edit made meanwhile belongs to the next save.
  h.change(page.querySelector('#disableTagsOnSearchPage'), true);
  gate.resolve();
  assert.equal(await saved, true);
  await ctx.flush();
  assert.deepEqual(h.patches.map((p) => p.Changes), [{ TagsHideOnHover: true }, { DisableTagsOnSearchPage: true }]);
  assert.equal(server.TagsHideOnHover, true);
  assert.equal(server.DisableTagsOnSearchPage, true);
  assert.equal(page.querySelector('#jeTaSaved').dataset.state, 'saved');
  assert.equal(ctx.pending(), false);
});

test('the settings failing to load show an error with Retry, not an endless loading line', async t => {
  const server = structuredClone(BASE);
  let fail = true;
  const h = boot(t, { server, apiClient: { getPluginConfiguration: async () => { if (fail) throw new Error('offline'); return structuredClone(server); } } });
  h.expectConsoleError(/could not load the Media Tags settings/);
  h.document.body.innerHTML = '<div class="page" id="JellyfinEnhancedMediaTagsPage"><div class="je-tag-admin"><p class="je-ta-wait" role="status">Loading Media Tags settings…</p></div></div>';
  const page = h.document.querySelector('.page');
  const root = page.querySelector('.je-tag-admin');
  assert.equal(await h.A.activate(page), null);
  assert.equal(root.querySelector('[role="status"]'), null, 'the loading line is gone');
  assert.match(root.querySelector('[role="alert"]').textContent, /admin_tags_load_failed/);
  fail = false;
  root.querySelector('[data-je-reload]').click();
  for (let i = 0; i < 50 && !root.querySelector('.je-ta-tabs'); i++) await h.settle();
  assert.ok(root.querySelector('.je-ta-tabs'), 'Retry builds the page');
  assert.equal(root.querySelector('[role="alert"]'), null);
  const ctx = await h.A.activate(page);
  h.cleanup.push(() => ctx.dispose());
  assert.equal(ctx.root, root);
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

test('the preview draws the saved server Tag Styles, scoped to it, whatever this browser\'s own styles are', async t => {
  const server = structuredClone({ ...BASE, TagStylesEnabled: true, TagStylePreset: 'default' });
  let fetches = 0;
  const h = boot(t, {
    server,
    // GET tag-styles without a preset: the server's model for its own preset (empty while Tag Styles are off).
    routes: { '/JellyfinEnhanced/tag-styles': () => { fetches++; return server.TagStylesEnabled ? { quality: { '4K': { color: server.TagStylePreset === 'glass' ? 'rgba(10, 20, 30, 1)' : 'rgba(40, 50, 60, 1)' } } } : {}; } },
  });
  h.load('tags/tag-styles.js');
  h.load('enhanced/settingspanel/ui-panel-tag-preview.js');
  // The signed-in administrator's own page-wide styles (their preset): red 4K chips.
  h.JE.core.ui.injectCss('je-tag-style-overrides', h.JE.tagStyles.buildCss({ quality: { '4K': { color: 'rgba(255, 0, 0, 1)' } } }));
  h.document.body.insertAdjacentHTML('beforeend', '<div class="quality-overlay-container"><span class="quality-overlay-label resolution" data-quality="4K" id="libraryChip">4K</span></div>');
  const root = h.document.getElementById('jeTaRoot');
  const ctx = h.A.createPage(root, structuredClone(server), { confirm: () => true });
  h.cleanup.push(() => ctx.dispose());
  await h.settle(); await h.settle();
  const chip = () => root.querySelector('#jeTaPreviewBody [data-sample="movie"] .quality-overlay-label[data-quality="4K"]');
  const colour = (el) => h.window.getComputedStyle(el).color;
  assert.ok(chip(), 'the preview draws a 4K chip');
  assert.equal(fetches, 1);
  assert.match(h.document.getElementById('je-tag-admin-preview-styles').textContent, /^#jeTaPreviewBody \.quality-overlay-container/);
  assert.equal(colour(chip()), 'rgb(40, 50, 60)', 'the server default, not the browser\'s red');
  assert.equal(colour(h.document.getElementById('libraryChip')), 'rgb(255, 0, 0)', 'the page-wide styles are untouched');
  // A Colours save refreshes the preview's styles.
  root.querySelector('#jeTaTab-colours').click();
  await h.settle(); await h.settle();
  root.querySelector('.je-ts-preset[data-preset="glass"]').click();
  await ctx.flush();
  await h.settle();
  assert.equal(server.TagStylePreset, 'glass');
  assert.equal(fetches, 2);
  assert.equal(colour(chip()), 'rgb(10, 20, 30)');
  // Tag Styles off: no preview styles, and the browser's own still stay out of the preview.
  h.change(root.querySelector('#tagStylesEnabled'), false);
  await ctx.flush();
  await h.settle();
  assert.equal(h.document.getElementById('je-tag-admin-preview-styles'), null);
  assert.notEqual(colour(chip()), 'rgb(255, 0, 0)');
  assert.equal(colour(h.document.getElementById('libraryChip')), 'rgb(255, 0, 0)');
  // A save of an unrelated field fetches nothing.
  h.change(root.querySelector('#tagsHideOnHover'), true);
  await ctx.flush();
  await h.settle();
  assert.equal(fetches, 3);
});

/** WCAG 2 contrast for the page's colour tokens (admin-tags.css), dark and light. */
function themeTokens(css, light) {
  const block = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, selector);
    const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
    return Object.fromEntries([...body.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  const tokens = { ...block('.je-tag-admin'), ...(light ? block('.je-tag-admin.je-ta-light') : {}) };
  const resolve = (value) => value.replace(/var\((--[\w-]+)(?:,\s*([^)]+))?\)/g, (m, name, fallback) => (tokens[name] ? resolve(tokens[name]) : fallback.trim()));
  return (name) => resolve(tokens[name] ?? assert.fail(`${name} is defined`));
}
function rgba(value) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(value);
  assert.ok(m, `a colour: ${value}`);
  const parts = m[1].split(',').map(Number);
  return parts.length === 3 ? [...parts, 1] : parts;
}
/** @returns {number[]} fg drawn over an opaque bg. */
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const luminance = (c) => c.slice(0, 3).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('selected pills, tabs, status text and the preview\'s captions are legible in the dark and light themes', () => {
  const css = readFileSync(resolve(jsRoot, 'enhanced/admintags/admin-tags.css'), 'utf8');
  // The selected controls draw from the checked tokens.
  assert.match(css, /\.je-ta-pill:has\(input:checked\)[^{]*\{ background: var\(--je-ta-selected-bg\); border-color: var\(--je-ta-selected-bg\); color: var\(--je-ta-selected-text\);/);
  assert.match(css, /\.je-ts-pill\.active \{ background: var\(--je-ta-selected-bg\);[^}]*color: var\(--je-ta-selected-text\);/);
  assert.match(css, /\.je-ta-tab\[aria-selected="true"\] \{ color: var\(--je-ta-accent-text\); \}/);
  for (const light of [false, true]) {
    const theme = light ? 'light' : 'dark';
    const token = themeTokens(css, light);
    const page = rgba(token('--je-ta-page-bg'));
    const card = over(rgba(token('--je-ta-surface')), page);   // cards and the preview column
    const on = (name, bg) => over(rgba(token(name)), bg);
    const check = (fg, bg, min, what) => {
      const ratio = contrast(fg, bg);
      assert.ok(ratio >= min, `${theme}: ${what} ${ratio.toFixed(2)}:1 < ${min}:1`);
    };
    const selected = on('--je-ta-selected-bg', card);
    check(on('--je-ta-selected-text', selected), selected, 4.5, 'selected pill text');
    check(selected, page, 3, 'selected pill against the page');
    check(selected, card, 3, 'selected pill against a card');
    check(on('--je-ta-accent', card), card, 3, 'accent outline against a card');
    check(on('--je-ta-accent', page), page, 3, 'accent outline against the page');
    check(on('--je-ta-accent-text', page), page, 4.5, 'selected tab text');
    for (const name of ['--je-ta-text', '--je-ta-muted', '--je-ta-faint', '--je-ta-bad', '--je-ta-warn']) {
      check(on(name, card), card, 4.5, `${name} on a card`);
      check(on(name, page), page, 4.5, `${name} on the page`);
    }
    for (const name of ['--je-mtp-text', '--je-mtp-muted', '--je-mtp-strong', '--je-mtp-lock', '--je-mtp-rule']) check(on(name, card), card, 4.5, `preview ${name}`);
    const pressed = on('--je-mtp-pressed-bg', card);
    check(on('--je-mtp-pressed-text', pressed), pressed, 4.5, 'preview Resting/Hover pressed');
  }
  // The shared preview's captions take those tokens (no fixed white text on the admin page).
  const preview = readFileSync(resolve(jsRoot, 'enhanced/settingspanel/ui-panel-tag-preview.js'), 'utf8');
  const sheet = preview.slice(preview.indexOf('const PREVIEW_CSS'), preview.indexOf('function spotlightCss'));
  for (const m of sheet.matchAll(/(?<![-\w])color: ([^;]+);/g)) assert.match(m[1], /^var\(--je-mtp-/, `preview text colour ${m[1]}`);
});

test('What\'s New on the main page lists new Media Tags settings with a link to their tab', () => {
  // configPage.html's own helpers, run as the page runs them.
  const page = readFileSync(resolve(jsRoot, '../Configuration/configPage.html'), 'utf8');
  const humanize = /function jeHumanizeSettingId\(id\) \{[\s\S]*?\n        \}/.exec(page)[0];
  const helper = page.slice(page.indexOf('// jeMediaTagsWhatsNewEntries: begin'), page.indexOf('// jeMediaTagsWhatsNewEntries: end'));
  assert.ok(helper.includes('function jeMediaTagsWhatsNewEntries'));
  const h = createHarness({ JE: {} });
  try {
    h.window.eval(`${humanize}\n${helper}\nwindow.entries = jeMediaTagsWhatsNewEntries;`);
    const names = { admin_tags_title: 'Media Tags', admin_tags_tab_layout: 'Layout defaults', admin_tags_tab_groups: 'Groups', admin_tags_tab_badges: 'Status badges', panel_settings_ui_tag_group_rating: 'Rating', panel_settings_ui_tag_group_age_rating: 'Age Rating' };
    const t = (key) => names[key] || key;
    const where = {
      tagLayout: { page: 'JellyfinEnhancedMediaTags', tab: 'layout', group: null },
      tagsHideOnHover: { page: 'JellyfinEnhancedMediaTags', tab: 'layout', group: null },
      ratingTagsOnNextUp: { page: 'JellyfinEnhancedMediaTags', tab: 'groups', group: 'rating' },
      ageRatingTagsEnabled: { page: 'JellyfinEnhancedMediaTags', tab: 'groups', group: 'ageRating' },
      // A setting new in a later release, on a tab this build has no name for.
      tagFutureThing: { page: 'JellyfinEnhancedMediaTags', tab: 'extras', group: null },
    };
    const entries = plain(h.window.entries(Object.keys(where).concat('notOnAnyPage'), where, t));
    assert.deepEqual(entries, [
      { tab: 'layout', tabLabel: 'Media Tags', title: 'Layout defaults', href: '#/configurationpage?name=JellyfinEnhancedMediaTags&tab=layout', ids: ['tagLayout', 'tagsHideOnHover'] },
      { tab: 'groups', tabLabel: 'Media Tags', title: 'Groups › Rating', href: '#/configurationpage?name=JellyfinEnhancedMediaTags&tab=groups&group=rating', ids: ['ratingTagsOnNextUp'] },
      { tab: 'groups', tabLabel: 'Media Tags', title: 'Groups › Age Rating', href: '#/configurationpage?name=JellyfinEnhancedMediaTags&tab=groups&group=ageRating', ids: ['ageRatingTagsEnabled'] },
      { tab: 'extras', tabLabel: 'Media Tags', title: 'Extras', href: '#/configurationpage?name=JellyfinEnhancedMediaTags&tab=extras', ids: ['tagFutureThing'] },
    ]);
    // Without the client bundle the names fall back to English.
    assert.equal(plain(h.window.entries(['ratingTagsOnNextUp'], where, null))[0].title, 'Groups › Rating');
  } finally { h.close(); }
  // checkWhatsNew routes the ids the main page has no control for through it, and the chip follows the link.
  assert.match(page, /var movedEntries = jeMediaTagsWhatsNewEntries\(moved, mediaTags,/);
  assert.match(page, /renderWhatsNewBanner\(\(perSetting\.length \? groupWhatsNewByFieldset\(perSetting\) : \[\]\)\.concat\(movedEntries\)/);
  assert.match(page, /if \(f\.href\) window\.location\.href = f\.href;/);
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
      // Helpers/MediaTagsPageFields.cs reads a section's own writes from one line too.
      if (/^\s*writes:/.test(line)) assert.match(line, /^\s*writes: \['\w+'(, '\w+')*\],$/, `${file}: ${line.trim()}`);
    }
  }
});
