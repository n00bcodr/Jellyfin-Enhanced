import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

// The Media Tags admin page's Server tab: export and import of the server
// settings and the presets offered to users (admintags/sections/portable.js),
// with the real page core, every section module and the settings panel's
// dialogs, over a mocked server.

/** The configuration the page reads (the fields the sections need). */
const BASE = {
  QualityTagsEnabled: true, GenreTagsEnabled: false, LanguageTagsEnabled: false, RatingTagsEnabled: true, AgeRatingTagsEnabled: false, StatusTagsEnabled: true, PeopleTagsEnabled: false,
  AwardsTagsEnabled: false, AwardsTagsPosition: 'top-left', AwardsTagsImdbList: 'owner/imdb', AwardsTagsLetterboxdList: 'owner/letterboxd', AwardsTagsRefreshHours: 24,
  LogoTagsEnabled: false, LogoTagsPosition: 'bottom-left', LogoTagsMovieMode: 'provider', LogoTagsSeriesMode: 'network', LogoTagsRegion: '', LogoTagsMaxLogos: 1,
  CustomTagsEnabled: false, CustomTagsPosition: 'top-left', CustomTagRules: [],
  QualityTagsPosition: 'top-left', GenreTagsPosition: 'top-right', LanguageTagsPosition: 'bottom-left', RatingTagsPosition: 'bottom-right', AgeRatingTagsPosition: 'bottom-right', StatusTagsPosition: 'top-right',
  ResolutionTagOrder: 1, SourceTagOrder: 2, DynamicRangeTagOrder: 3, SpecialFormatTagOrder: 4, VideoCodecTagOrder: 5, AudioInfoTagOrder: 6, EditionTagOrder: 7,
  LanguageTagsPriority: '', LanguageTagsStyle: 'flags', LanguageTagsCountBadge: 'off', RatingTagsSources: null, RatingTagsMinScore: 0,
  StatusTagsJustAddedDays: 7, StatusTagsNewReleaseDays: 30,
  TagLayout: 'corners', TagLabelDensity: 'full', TagScale: 'default', TagGap: 'default', TagEdgeSpacing: 'default', TagLayouts: null, TagGroupOrder: null, TagGroupCaps: null, TagLookRules: null, TagShapeOverrides: null,
  TagStylesEnabled: true, TagStyleTarget: 'both', TagStyleOverrides: '', TagStylePreset: 'default', TagStylesAllowUserPreset: false,
  TagCacheServerMode: true, TagCacheExcludeLibraries: false, TagCacheExcludedLibraryIds: '', TagsCacheTtlDays: 30,
  NativePosterTagsEnabled: false, NativePosterTagsWebClientNames: '', TagOfferedPresets: '',
  CustomTagRuleKey: 'secret-key', DevMode: false,
};

const catalog = { presets: ['default'], age: [], groups: { quality: [], ageRating: [], rating: [], genre: [], status: [], language: [] }, palettes: { default: {} } };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The page on its Server tab over a mocked server.
 * @param {import('node:test').TestContext} t
 * @param {{config?: object, confirm?: boolean, adminPreview?: (doc: object) => object, userPreview?: (doc: object) => object}} [options]
 */
function setup(t, { config = {}, confirm = true, adminPreview, userPreview } = {}) {
  const server = structuredClone({ ...BASE, ...config });
  const patches = [];
  const requests = [];
  const copies = [];
  const confirms = [];
  const h = createHarness({
    html: '<div id="jeTaRoot"></div>',
    url: 'http://jellyfin.test/web/index.html#/configurationpage?name=JellyfinEnhancedMediaTags&tab=server',
    JE: { t: (key, params) => (params ? `${key}:${Object.values(params).join('|')}` : key), pluginConfig: {}, currentSettings: {}, saveUserSettings: async () => {} },
    apiClient: {
      getUrl: (path, query) => `http://jellyfin.test/${path.replace(/^\//, '')}${query ? `?${new URLSearchParams(query)}` : ''}`,
      getJSON: async () => [],
      getPluginConfiguration: async () => structuredClone(server),
      ajax: async (request) => {
        const path = new URL(request.url).pathname;
        const body = request.data ? JSON.parse(request.data) : null;
        requests.push({ type: request.type, path, body });
        if (path.endsWith('/admin/configuration')) {
          patches.push(structuredClone(body));
          const conflicts = {};
          for (const [key, before] of Object.entries(body.Expected || {})) if (!same(server[key], before) && !same(server[key], body.Changes[key])) conflicts[key] = server[key];
          if (Object.keys(conflicts).length) throw { status: 409, json: async () => ({ conflicts }) };
          Object.assign(server, structuredClone(body.Changes));
          return { values: structuredClone(body.Changes) };
        }
        if (path.endsWith('/admin/media-tags/export')) {
          const settings = Object.fromEntries(Object.entries(server).filter(([k]) => !['CustomTagRuleKey', 'DevMode'].includes(k)));
          return { v: 1, kind: 'je-media-tags-admin', settings };
        }
        if (path.endsWith('/admin/media-tags/preview')) {
          if (adminPreview) return adminPreview(body);
          const changes = Object.entries(body.settings).filter(([k, v]) => k in server && !same(server[k], v)).map(([field, to]) => ({ field, from: server[field], to }));
          return { kind: body.kind, v: 1, imported: body.settings, changes, skipped: [] };
        }
        if (path.endsWith('/media-tags/export')) return { v: 1, kind: 'je-media-tags-user', settings: { TagLayout: 'bands', TagScale: 'larger' } };
        if (path.endsWith('/media-tags/preview')) {
          if (userPreview) return userPreview(body);
          return { kind: body.kind, v: 1, name: body.name ?? null, description: body.description ?? null, imported: body.settings, changes: [], skipped: [] };
        }
        if (path.endsWith('/tag-styles/catalog')) return catalog;
        if (path.endsWith('/tag-cache/summary')) return { enabled: true, entries: 0, lastModified: 0, rebuilding: false };
        if (path.endsWith('/Localization/Cultures')) return [];
        return null;
      },
    },
    globals: { jeCdnUrl: (p) => `http://jellyfin.test/JellyfinEnhanced/cdn/${p}`, Dashboard: {} },
  });
  const cleanup = [];
  t.after(() => { for (const fn of cleanup.reverse()) fn(); h.close(); });
  h.window.HTMLCanvasElement.prototype.getContext = () => ({ fillStyle: '#000000' });
  h.window.Element.prototype.scrollIntoView = function () {};
  Object.defineProperty(h.window.navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { copies.push(text); } } });
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/rating-sources.js', 'enhanced/settingspanel/ui-panel-tag-editor.js', 'enhanced/settingspanel/ui-panel-tag-portable.js']) h.load(file);
  h.load('enhanced/admintags/admin-tags.js');
  h.JE.escapeHtml = h.JE.core.ui.escapeHtml;
  const A = h.JE.adminTags;
  for (const file of A.SECTION_FILES) h.load(`enhanced/admintags/${file}`);
  const root = h.document.getElementById('jeTaRoot');
  const ctx = A.createPage(root, structuredClone(server), { confirm: (text, title) => { confirms.push(text); return confirm; } });
  cleanup.push(() => ctx.dispose());
  const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
  const $ = (sel) => root.querySelector(sel);
  const click = (el) => { assert.ok(el, 'control exists'); el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true })); };
  const dialog = () => root.querySelector('.je-pt-dialog');
  const action = (name) => dialog()?.querySelector(`[data-pt-action="${name}"]`);
  const paste = (text) => { dialog().querySelector('[data-pt-paste]').value = text; };
  return { ...h, A, ctx, root, server, patches, requests, copies, confirms, settle, $, click, dialog, action, paste, status: () => dialog()?.querySelector('.je-pt-status').textContent };
}

test('the Server tab has the import and export block and the offered presets, declared as a page field', async t => {
  const h = setup(t);
  assert.equal(h.root.dataset.tab, 'server');
  const portable = h.$('[data-section="server-portable"]');
  const presets = h.$('[data-section="server-presets"]');
  assert.ok(portable.querySelector('#jeTaExport') && portable.querySelector('#jeTaImport'));
  assert.ok(presets.querySelector('#jeTaOfferMine') && presets.querySelector('#jeTaOfferImport'));
  assert.ok(h.A.pageFields().has('TagOfferedPresets'));
  assert.match(presets.textContent, /admin_tags_presets_count:0\|20/);
  assert.match(presets.textContent, /admin_tags_presets_none/);
});

test('export saves pending edits first and shows the server document, without secrets', async t => {
  const h = setup(t);
  h.ctx.set('TagsHideOnHover', true);
  h.click(h.$('#jeTaExport'));
  await h.settle();
  assert.deepEqual(h.patches.map((p) => Object.keys(p.Changes)), [['TagsHideOnHover']], 'the pending edit was saved before the export was read');
  const document = JSON.parse(h.dialog().querySelector('textarea').value);
  assert.equal(document.kind, 'je-media-tags-admin');
  assert.equal(document.settings.TagsHideOnHover, true);
  assert.equal(document.settings.CustomTagRuleKey, undefined);
  h.click(h.action('copy'));
  await h.settle();
  assert.equal(JSON.parse(h.copies[0]).kind, 'je-media-tags-admin');
});

test('import previews, confirms and writes the changed fields through the locked patch with the values read; Undo restores them', async t => {
  const h = setup(t);
  h.click(h.$('#jeTaImport'));
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-admin', settings: { TagLayout: 'bands', StatusTagsJustAddedDays: 9, QualityTagsEnabled: true } }));
  h.click(h.action('next'));
  await h.settle();
  assert.deepEqual(Array.from(h.dialog().querySelectorAll('.je-pt-change .je-pt-field'), (el) => el.textContent), ['Tag Layout', 'Status Tags Just Added Days']);
  h.click(h.action('apply'));
  await h.settle(10);
  assert.equal(h.confirms.length, 1, 'asked first');
  assert.deepEqual(plain(h.patches.at(-1)), { Changes: { TagLayout: 'bands', StatusTagsJustAddedDays: 9 }, Expected: { TagLayout: 'corners', StatusTagsJustAddedDays: 7 } });
  assert.equal(h.server.TagLayout, 'bands');
  assert.equal(h.dialog(), null);
  const snack = h.root.querySelector('.je-ta-snack');
  assert.match(snack.textContent, /admin_tags_portable_applied:2/);
  h.click(snack.querySelector('button'));
  await h.ctx.flush();
  await h.settle(6);
  assert.deepEqual(plain(h.patches.at(-1)), { Changes: { TagLayout: 'corners', StatusTagsJustAddedDays: 7 }, Expected: { TagLayout: 'bands', StatusTagsJustAddedDays: 9 } });
  assert.equal(h.server.TagLayout, 'corners');
});

test('a field another administrator changed meanwhile waits for Keep mine / Take theirs; the others save', async t => {
  const h = setup(t);
  h.click(h.$('#jeTaImport'));
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-admin', settings: { TagLayout: 'bands', TagGap: 'roomy' } }));
  h.click(h.action('next'));
  await h.settle();
  // Someone else saved the layout after this page read it.
  h.server.TagLayout = 'minimal';
  h.click(h.action('apply'));
  await h.settle(10);
  assert.equal(h.server.TagLayout, 'minimal', 'their value is kept');
  assert.equal(h.patches[0].Expected.TagLayout, 'corners', 'the import expected what this page read');
  assert.equal(h.server.TagGap, 'roomy', 'the field nobody else touched is saved');
  assert.equal(h.status(), 'admin_tags_portable_apply_refused');
  assert.equal(h.$('#jeTaSaved').dataset.state, 'conflict', 'the page offers Keep mine / Take theirs');
  // Keep mine: the imported layout is saved over theirs.
  h.click(h.$('#jeTaSaved [data-je-keep]'));
  await h.ctx.flush();
  assert.equal(h.server.TagLayout, 'bands');
});

test('declining the confirmation or a refused document writes nothing', async t => {
  const h = setup(t, { confirm: false, adminPreview: () => ({ kind: 'je-media-tags-admin', v: 1, imported: {}, changes: [{ field: 'TagLayout', from: 'corners', to: 'bands' }], skipped: [{ field: 'CustomTagRuleKey', reason: 'secret', detail: null }, { field: 'DevMode', reason: 'unknown', detail: null }] }) });
  h.click(h.$('#jeTaImport'));
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-admin', settings: { TagLayout: 'bands', CustomTagRuleKey: 'x', DevMode: true } }));
  h.click(h.action('next'));
  await h.settle();
  const reasons = Array.from(h.dialog().querySelectorAll('.je-pt-skip .je-pt-reason'), (el) => el.textContent.trim());
  assert.deepEqual(reasons, ['tag_portable_skip_secret', 'tag_portable_skip_unknown']);
  h.click(h.action('apply'));
  await h.settle(6);
  assert.equal(h.patches.length, 0);
  assert.equal(h.server.CustomTagRuleKey, 'secret-key');
});

test('offered presets: offer one from a file, list it, share it and remove it, capped at 20', async t => {
  const h = setup(t);
  h.click(h.$('#jeTaOfferImport'));
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-preset', name: 'Family night', description: 'Big tags', settings: { TagScale: 'larger' } }));
  h.click(h.action('next'));
  await h.settle();
  assert.ok(h.requests.some((r) => r.path.endsWith('/user-settings/user-a/media-tags/preview')), 'checked with the settings save path validators');
  assert.equal(h.dialog().querySelector('#jeTaOfferName').value, 'Family night');
  h.click(h.action('offer'));
  await h.settle(8);
  const stored = JSON.parse(h.server.TagOfferedPresets);
  assert.equal(stored.length, 1);
  assert.match(stored[0].id, /^family-night-[a-z0-9]+$/);
  assert.deepEqual({ ...stored[0], id: 'x' }, { v: 1, kind: 'je-media-tags-preset', id: 'x', name: 'Family night', description: 'Big tags', settings: { TagScale: 'larger' } });
  assert.deepEqual(Object.keys(h.patches.at(-1).Changes), ['TagOfferedPresets']);
  const row = h.$('[data-offer-id]');
  assert.match(row.textContent, /Family night/);
  h.click(row.querySelector('[data-offer-action="share"]'));
  await h.settle();
  assert.equal(JSON.parse(h.copies[0]).name, 'Family night');
  h.click(h.$('[data-offer-id] [data-offer-action="remove"]'));
  await h.settle();
  await h.ctx.flush();
  assert.equal(h.server.TagOfferedPresets, '');
  assert.equal(h.$('[data-offer-id]'), null);

  // Twenty offered: no more can be added.
  const twenty = Array.from({ length: 20 }, (_, i) => ({ v: 1, kind: 'je-media-tags-preset', id: `p${i}`, name: `P${i}`, description: '', settings: { TagGap: 'tight' } }));
  h.ctx.set('TagOfferedPresets', JSON.stringify(twenty));
  assert.equal(h.$('#jeTaOfferMine').disabled, true);
  assert.equal(h.$('#jeTaOfferImport').disabled, true);
});

test('offer my settings uses the administrator\'s own export, and settings the server drops are shown', async t => {
  const h = setup(t, { userPreview: (doc) => ({ kind: doc.kind, v: 1, imported: { TagLayout: 'bands' }, changes: [], skipped: [{ field: 'TagScale', reason: 'invalid', detail: 'must be one of smaller, default, larger, largest' }] }) });
  h.click(h.$('#jeTaOfferMine'));
  await h.settle(6);
  assert.ok(h.requests.some((r) => r.path.endsWith('/user-settings/user-a/media-tags/export')));
  assert.deepEqual(Array.from(h.dialog().querySelectorAll('.je-pt-skip .je-pt-field'), (el) => el.textContent), ['Tag Scale']);
  h.click(h.action('offer'));
  await h.settle();
  assert.equal(h.status(), 'tag_portable_error_name', 'a name is required');
  h.dialog().querySelector('#jeTaOfferName').value = 'Admin look';
  h.click(h.action('offer'));
  await h.settle(8);
  assert.deepEqual(JSON.parse(h.server.TagOfferedPresets)[0].settings, { TagLayout: 'bands' });
});
