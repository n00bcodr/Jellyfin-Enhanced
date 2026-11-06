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
  // failSave: the next field saves fail (an error other than a conflict).
  // saveGate: a promise each field save waits for before it writes (a save on its way).
  const flags = { failSave: false, saveGate: null };
  const h = createHarness({
    html: '<div id="jeTaRoot"></div>',
    url: 'http://jellyfin.test/web/index.html#/configurationpage?name=Jellyfin%20Enhanced&jeSection=media-tags&tab=server',
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
          if (flags.saveGate) await flags.saveGate;
          if (flags.failSave) throw { status: 500 };
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
  return { ...h, A, ctx, root, server, flags, patches, requests, copies, confirms, settle, $, click, dialog, action, paste, status: () => dialog()?.querySelector('.je-pt-status').textContent };
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

test('export refuses while a pending edit is refused by a conflict, and exports it once settled', async t => {
  const h = setup(t);
  h.ctx.set('TagLayout', 'bands');
  h.server.TagLayout = 'minimal'; // another administrator saved the layout meanwhile
  h.click(h.$('#jeTaExport'));
  await h.settle(10);
  assert.equal(h.A.pendingState().state, 'conflict');
  assert.ok(!h.requests.some((r) => r.path.endsWith('/admin/media-tags/export')), 'the stored settings were not read');
  assert.equal(h.dialog().querySelector('textarea'), null, 'no document is offered');
  assert.equal(h.action('download'), null);
  assert.equal(h.status(), 'admin_tags_portable_export_unsaved');
  // Keep mine, then export again: the document has this page's value.
  h.click(h.$('#jeTaSaved [data-je-keep]'));
  await h.ctx.flush();
  h.click(h.$('#jeTaExport'));
  await h.settle(10);
  assert.equal(JSON.parse(h.dialog().querySelector('textarea').value).settings.TagLayout, 'bands');
});

test('export refuses while a pending edit failed to save, and exports after a successful retry', async t => {
  const h = setup(t);
  h.expectConsoleError(/could not save the Media Tags settings/);
  h.flags.failSave = true;
  h.ctx.set('TagsHideOnHover', true);
  h.click(h.$('#jeTaExport'));
  await h.settle(10);
  assert.equal(h.A.pendingState().state, 'error');
  assert.ok(!h.requests.some((r) => r.path.endsWith('/admin/media-tags/export')));
  assert.equal(h.action('download'), null);
  assert.equal(h.status(), 'admin_tags_portable_export_unsaved');
  h.flags.failSave = false;
  h.click(h.$('#jeTaExport'));
  await h.settle(10);
  assert.equal(JSON.parse(h.dialog().querySelector('textarea').value).settings.TagsHideOnHover, true);
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

test('import after another administrator changed a field this page never edited writes every listed change, and Undo restores theirs', async t => {
  const h = setup(t);
  await h.settle(10);
  // Another administrator (or another tab) saved the layout after this page read it.
  h.server.TagLayout = 'bands';
  h.click(h.$('#jeTaImport'));
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-admin', settings: { TagLayout: 'corners', StatusTagsJustAddedDays: 9 } }));
  h.click(h.action('next'));
  await h.settle(10);
  assert.deepEqual(Array.from(h.dialog().querySelectorAll('.je-pt-change .je-pt-field'), (el) => el.textContent), ['Tag Layout', 'Status Tags Just Added Days']);
  const n = h.patches.length;
  h.click(h.action('apply'));
  await h.settle(20);
  assert.deepEqual(plain(h.patches.slice(n)), [{ Changes: { TagLayout: 'corners', StatusTagsJustAddedDays: 9 }, Expected: { TagLayout: 'bands', StatusTagsJustAddedDays: 7 } }], 'both listed changes are written');
  assert.equal(h.server.TagLayout, 'corners');
  assert.equal(h.server.StatusTagsJustAddedDays, 9);
  assert.equal(h.dialog(), null);
  assert.equal(h.A.pendingState().state, 'saved');
  assert.equal(h.ctx.config.TagLayout, 'corners');
  const snack = h.root.querySelector('.je-ta-snack');
  assert.match(snack.textContent, /admin_tags_portable_applied:2/);

  h.click(snack.querySelector('button'));
  await h.ctx.flush();
  await h.settle(20);
  assert.deepEqual(plain(h.patches.at(-1)), { Changes: { TagLayout: 'bands', StatusTagsJustAddedDays: 7 }, Expected: { TagLayout: 'corners', StatusTagsJustAddedDays: 9 } }, 'Undo puts back the value before the import');
  assert.equal(h.server.TagLayout, 'bands');
});

test('import: a field changed by another administrator to another value after the preview is a conflict, not a skipped change', async t => {
  const h = setup(t);
  await h.settle(10);
  h.server.TagLayout = 'bands';
  h.click(h.$('#jeTaImport'));
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-admin', settings: { TagLayout: 'corners', StatusTagsJustAddedDays: 9 } }));
  h.click(h.action('next'));
  await h.settle(10);
  // Changed again after the preview.
  h.server.TagLayout = 'minimal';
  h.click(h.action('apply'));
  await h.settle(20);
  assert.equal(h.server.TagLayout, 'minimal', 'their value is kept');
  assert.equal(h.server.StatusTagsJustAddedDays, 9);
  assert.equal(h.status(), 'admin_tags_portable_apply_refused');
  assert.equal(h.A.pendingState().state, 'conflict');
});

test('import saves an edit still on its way before the preview, so the document\'s value of that field is applied', async t => {
  const h = setup(t);
  let release;
  h.flags.saveGate = new Promise((r) => { release = r; });
  h.ctx.set('TagLayout', 'bands');
  const saving = h.ctx.flush();
  h.click(h.$('#jeTaImport'));
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-admin', settings: { TagLayout: 'corners', StatusTagsJustAddedDays: 9 } }));
  h.click(h.action('next'));
  await h.settle(10);
  assert.ok(!h.requests.some((r) => r.path.endsWith('/admin/media-tags/preview')), 'no preview while the save is on its way');
  h.flags.saveGate = null;
  release();
  await saving;
  await h.settle(10);
  assert.equal(h.server.TagLayout, 'bands');
  assert.deepEqual(Array.from(h.dialog().querySelectorAll('.je-pt-change .je-pt-field'), (el) => el.textContent), ['Tag Layout', 'Status Tags Just Added Days'], 'compared with the saved edit');
  h.click(h.action('apply'));
  await h.settle(10);
  assert.equal(h.server.TagLayout, 'corners', 'the document\'s layout');
  assert.equal(h.server.StatusTagsJustAddedDays, 9);
  assert.equal(h.dialog(), null);
  assert.equal(h.A.pendingState().state, 'saved');
});

test('import refuses while an edit failed to save, and previews and applies after a successful retry', async t => {
  const h = setup(t);
  h.expectConsoleError(/could not save the Media Tags settings/);
  h.flags.failSave = true;
  h.ctx.set('TagLayout', 'bands');
  await h.ctx.flush();
  assert.equal(h.A.pendingState().state, 'error');
  h.click(h.$('#jeTaImport'));
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-admin', settings: { TagLayout: 'corners', StatusTagsJustAddedDays: 9 } }));
  h.click(h.action('next'));
  await h.settle(10);
  assert.ok(!h.requests.some((r) => r.path.endsWith('/admin/media-tags/preview')), 'not previewed against settings the page does not show');
  assert.equal(h.status(), 'admin_tags_portable_import_unsaved');
  assert.equal(h.action('apply'), null);
  h.flags.failSave = false;
  h.click(h.action('next'));
  await h.settle(10);
  assert.equal(h.server.TagLayout, 'bands', 'the retained edit was saved first');
  h.click(h.action('apply'));
  await h.settle(10);
  assert.equal(h.server.TagLayout, 'corners');
  assert.equal(h.server.StatusTagsJustAddedDays, 9);
  assert.equal(h.A.pendingState().state, 'saved');
});

test('import: an edit on the page after the preview to a field the document sets shows the preview again instead of applying', async t => {
  const h = setup(t);
  h.click(h.$('#jeTaImport'));
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-admin', settings: { TagLayout: 'corners', StatusTagsJustAddedDays: 9 } }));
  h.click(h.action('next'));
  await h.settle(10);
  assert.deepEqual(Array.from(h.dialog().querySelectorAll('.je-pt-change .je-pt-field'), (el) => el.textContent), ['Status Tags Just Added Days'], 'the layout is already corners');
  h.ctx.set('TagLayout', 'bands');
  h.click(h.action('apply'));
  await h.settle(10);
  assert.equal(h.server.TagLayout, 'bands', 'the edit was saved first');
  assert.equal(h.server.StatusTagsJustAddedDays, 7, 'nothing applied from the old preview');
  assert.equal(h.status(), 'admin_tags_portable_import_changed');
  assert.deepEqual(Array.from(h.dialog().querySelectorAll('.je-pt-change .je-pt-field'), (el) => el.textContent), ['Tag Layout', 'Status Tags Just Added Days']);
  h.click(h.action('apply'));
  await h.settle(10);
  assert.equal(h.server.TagLayout, 'corners');
  assert.equal(h.server.StatusTagsJustAddedDays, 9);
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

test('offered presets: Offer again after a failed save stores the preset once', async t => {
  const h = setup(t);
  h.expectConsoleError(/could not save the Media Tags settings/);
  h.click(h.$('#jeTaOfferImport'));
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-preset', name: 'Retry preset', settings: { TagLayout: 'bands' } }));
  h.click(h.action('next'));
  await h.settle();
  h.flags.failSave = true;
  h.click(h.action('offer'));
  await h.settle(10);
  assert.equal(h.status(), 'admin_tags_presets_save_failed');
  assert.equal(h.action('offer').disabled, false, 'Offer can be pressed again');
  h.flags.failSave = false;
  h.click(h.action('offer'));
  await h.settle(10);
  const stored = JSON.parse(h.server.TagOfferedPresets);
  assert.deepEqual(stored.map((p) => p.name), ['Retry preset']);
  assert.equal(h.dialog(), null);
  assert.equal(h.root.querySelectorAll('[data-offer-id]').length, 1);
  assert.match(h.$('[data-section="server-presets"]').textContent, /admin_tags_presets_count:1\|20/);
});

test('offered presets: Offer again while the save is refused, then Keep mine, stores the preset once', async t => {
  const h = setup(t);
  h.click(h.$('#jeTaOfferImport'));
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-preset', name: 'Family night', settings: { TagScale: 'larger' } }));
  h.click(h.action('next'));
  await h.settle();
  // Another administrator offered one meanwhile.
  h.server.TagOfferedPresets = JSON.stringify([{ v: 1, kind: 'je-media-tags-preset', id: 'theirs-1', name: 'Theirs', description: '', settings: { TagGap: 'tight' } }]);
  h.click(h.action('offer'));
  await h.settle(10);
  assert.equal(h.A.pendingState().state, 'conflict');
  h.dialog().querySelector('#jeTaOfferName').value = 'Family night (big)';
  h.click(h.action('offer'));
  await h.settle(10);
  assert.equal(JSON.parse(h.ctx.config.TagOfferedPresets).length, 1, 'the pending list holds this dialog\'s preset once');
  h.click(h.$('#jeTaSaved [data-je-keep]'));
  await h.ctx.flush();
  const stored = JSON.parse(h.server.TagOfferedPresets);
  assert.deepEqual(stored.map((p) => p.name), ['Family night (big)']);
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

// ── No "Loading" beside an error, and Retry, on every failure (opus R5 7) ──

/** The dialog's loading line is shown (by its text, not only its hook). */
const loadingShown = (h) => Array.from(h.dialog().querySelectorAll('.je-pt-hint'))
  .some((el) => el.textContent === 'hidden_content_admin_loading' && !el.closest('[hidden]'));

test('offer my settings: a failed read of my settings hides the loading line and Retry reads them again', async t => {
  const h = setup(t);
  await h.settle(8);
  const ajax = h.window.ApiClient.ajax;
  let refuse = true;
  h.window.ApiClient.ajax = async (request) => {
    if (refuse && new URL(request.url).pathname.endsWith('/user-settings/user-a/media-tags/export')) throw { status: 500 };
    return ajax(request);
  };
  h.click(h.$('#jeTaOfferMine'));
  await h.settle(10);
  assert.equal(h.status(), 'tag_portable_export_failed');
  assert.equal(loadingShown(h), false, 'no "Loading" beside the error');
  assert.equal(h.document.activeElement, h.action('retry'), 'Retry in the same dialog');
  refuse = false;
  h.click(h.action('retry'));
  await h.settle(10);
  assert.ok(h.dialog().querySelector('#jeTaOfferName'), 'the name step');
});

test('offer my settings: a refused check hides the loading line and offers Retry', async t => {
  let refuse = true;
  const h = setup(t, { userPreview: (doc) => { if (refuse) throw { status: 500 }; return { kind: doc.kind, v: 1, imported: { TagLayout: 'bands' }, changes: [], skipped: [] }; } });
  await h.settle(8);
  h.click(h.$('#jeTaOfferMine'));
  await h.settle(10);
  assert.notEqual(h.status(), '');
  assert.equal(loadingShown(h), false);
  assert.equal(h.document.activeElement, h.action('retry'));
  refuse = false;
  h.click(h.action('retry'));
  await h.settle(10);
  assert.ok(h.dialog().querySelector('#jeTaOfferName'));
});

test('export: a failed read offers Retry in the same dialog, which exports', async t => {
  const h = setup(t);
  await h.settle(8);
  const ajax = h.window.ApiClient.ajax;
  let refuse = true;
  h.window.ApiClient.ajax = async (request) => {
    if (refuse && new URL(request.url).pathname.endsWith('/admin/media-tags/export')) throw { status: 500 };
    return ajax(request);
  };
  h.click(h.$('#jeTaExport'));
  await h.settle(10);
  assert.equal(h.status(), 'tag_portable_export_failed');
  assert.equal(loadingShown(h), false);
  assert.equal(h.document.activeElement, h.action('retry'));
  refuse = false;
  h.click(h.action('retry'));
  await h.settle(10);
  assert.equal(JSON.parse(h.dialog().querySelector('textarea').value).kind, 'je-media-tags-admin');
});

// ── Offer my settings after a failed save of my own settings (astra R5-3 = opus R5 2) ──

test('offer my settings stops when my own settings fail to save, offers nothing, and Retry offers what the panel shows', async t => {
  const h = setup(t);
  await h.settle(8);
  h.load('enhanced/config.js');
  // The panel shows Minimal; the stored settings still say Bands.
  const stored = { TagLayout: 'bands', TagScale: 'larger' };
  h.JE.currentSettings = { tagLayout: 'minimal' };
  const ajax = h.window.ApiClient.ajax;
  let refuse = true;
  const posted = [];
  h.window.ApiClient.ajax = async (request) => {
    const path = new URL(request.url).pathname;
    if (request.type === 'POST' && path.endsWith('/settings.json')) {
      if (refuse) throw { status: 500 };
      // This page has no key converter loaded: the document is posted as the panel holds it.
      const body = JSON.parse(request.data);
      posted.push(body);
      stored.TagLayout = body.TagLayout ?? body.tagLayout;
      return { success: true };
    }
    if (path.endsWith('/user-settings/user-a/media-tags/export')) return { v: 1, kind: 'je-media-tags-user', settings: { ...stored } };
    return ajax(request);
  };
  h.click(h.$('#jeTaOfferMine'));
  await h.settle(15);
  assert.equal(h.status(), 'admin_tags_presets_mine_unsaved');
  assert.ok(!h.requests.some((r) => r.path.endsWith('/media-tags/export')), 'the stored settings are not read');
  assert.equal(h.dialog().querySelector('#jeTaOfferName'), null, 'no name step');
  assert.equal(h.document.activeElement, h.action('retry'));
  assert.equal(h.server.TagOfferedPresets, '', 'nothing offered');

  refuse = false;
  h.click(h.action('retry'));
  await h.settle(15);
  assert.equal(posted.at(-1).tagLayout, 'minimal');
  h.dialog().querySelector('#jeTaOfferName').value = 'My current layout';
  h.click(h.action('offer'));
  await h.settle(15);
  assert.equal(JSON.parse(h.server.TagOfferedPresets)[0].settings.TagLayout, 'minimal', 'the offered preset is what the panel shows');
});

test('offer my settings: a page view closed while my settings save posts nothing for it', async t => {
  const h = setup(t);
  await h.settle(8);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  h.JE.saveUserSettings = async () => { await gate; };
  h.click(h.$('#jeTaOfferMine'));
  await h.settle(4);
  h.ctx.dispose();
  release();
  await h.settle(10);
  assert.ok(!h.requests.some((r) => r.path.endsWith('/user-settings/user-a/media-tags/export')), 'no read for a view that ended');
});

// ── A field another administrator cleared (astra R5-4 = opus R5 1) ────

test('import after another administrator cleared a field (omitted by the configuration API) writes that listed change too', async t => {
  const h = setup(t, {
    config: { TagGroupCaps: { Quality: 2 } },
    // As PreviewAdmin compares: from the stored value, null when unset.
    adminPreview: (doc) => ({ kind: doc.kind, v: 1, imported: doc.settings, skipped: [],
      changes: Object.entries(doc.settings).filter(([k, v]) => !same(h.server[k], v)).map(([field, to]) => ({ field, from: h.server[field] ?? null, to })) }),
  });
  await h.settle(10);
  delete h.server.TagGroupCaps; // reset elsewhere: the API omits the null value
  h.click(h.$('#jeTaImport'));
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-admin', settings: { TagGroupCaps: { Quality: 2 }, StatusTagsJustAddedDays: 9 } }));
  h.click(h.action('next'));
  await h.settle(12);
  assert.deepEqual(Array.from(h.dialog().querySelectorAll('.je-pt-change .je-pt-field'), (el) => el.textContent), ['Tag Group Caps', 'Status Tags Just Added Days']);
  assert.equal(h.ctx.config.TagGroupCaps, null, 'the page read the cleared field as cleared');
  const n = h.patches.length;
  h.click(h.action('apply'));
  await h.settle(20);
  assert.deepEqual(plain(h.patches.slice(n)), [{ Changes: { TagGroupCaps: { Quality: 2 }, StatusTagsJustAddedDays: 9 }, Expected: { TagGroupCaps: null, StatusTagsJustAddedDays: 7 } }], 'both listed changes are written');
  assert.deepEqual(h.server.TagGroupCaps, { Quality: 2 });
  assert.equal(h.server.StatusTagsJustAddedDays, 9);
  assert.equal(h.dialog(), null);
});

test('import Apply writes a listed change against the value the preview compared, even when the page\'s copy already equals the new value', async t => {
  // The server changed the layout between the page's read and the preview: the preview says bands → corners.
  const h = setup(t, { adminPreview: (doc) => ({ kind: doc.kind, v: 1, imported: doc.settings, skipped: [], changes: [{ field: 'TagLayout', from: 'bands', to: 'corners' }] }) });
  await h.settle(10);
  h.click(h.$('#jeTaImport'));
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-admin', settings: { TagLayout: 'corners' } }));
  h.click(h.action('next'));
  await h.settle(12);
  h.server.TagLayout = 'bands';
  assert.equal(h.ctx.config.TagLayout, 'corners');
  const n = h.patches.length;
  h.click(h.action('apply'));
  await h.settle(20);
  assert.deepEqual(plain(h.patches.slice(n)), [{ Changes: { TagLayout: 'corners' }, Expected: { TagLayout: 'bands' } }], 'sent with the compared value as Expected');
  assert.equal(h.server.TagLayout, 'corners');
});

test('a full configuration read again clears a page field the server omits, but keeps an edit not saved yet', async t => {
  const h = setup(t, { config: { TagGroupCaps: { Quality: 2 }, TagShapeOverrides: { Landscape: { Layout: 'bands' } } } });
  await h.settle(10);
  let release;
  h.flags.saveGate = new Promise((resolve) => { release = resolve; });
  h.ctx.set('TagShapeOverrides', { Landscape: { Layout: 'minimal' } });
  const fresh = structuredClone(h.server);
  delete fresh.TagGroupCaps;
  delete fresh.TagShapeOverrides;
  h.ctx.reload(fresh);
  assert.equal(h.ctx.config.TagGroupCaps, null, 'cleared on the server');
  assert.deepEqual(h.ctx.config.TagShapeOverrides, { Landscape: { Layout: 'minimal' } }, 'the pending edit is kept');
  h.flags.saveGate = null;
  release();
  await h.ctx.flush();
});

// ── The Undo snackbar hands focus on when it goes (astra R6-3) ───────

test('Undo of an import used with the keyboard hands focus to Import; a replaced bar never steals focus moved elsewhere', async t => {
  const h = setup(t);
  await h.settle(10);
  h.click(h.$('#jeTaImport'));
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-admin', settings: { TagLayout: 'bands' } }));
  h.click(h.action('next'));
  await h.settle(12);
  h.click(h.action('apply'));
  await h.settle(20);
  assert.equal(h.server.TagLayout, 'bands');
  const undo = h.$('.je-ta-snack button');
  undo.focus();
  assert.equal(h.document.activeElement, undo);
  h.click(undo);
  assert.equal(undo.isConnected, false);
  assert.equal(h.document.activeElement, h.$('#jeTaImport'), 'focus on Import, not dropped to the page');
  await h.ctx.flush();
  await h.settle(12);
  assert.equal(h.server.TagLayout, 'corners');

  // The same removal replaces a bar: focus in it moves to a control on the page...
  h.ctx.snack('first', () => {});
  h.$('.je-ta-snack button').focus();
  h.ctx.snack('second');
  assert.notEqual(h.document.activeElement, h.document.body, 'not dropped to the page');
  assert.ok(h.root.contains(h.document.activeElement));
  // ...and focus the user moved away stays where it is.
  h.ctx.snack('third', () => {});
  const elsewhere = h.$('#jeTaImport');
  elsewhere.focus();
  h.ctx.snack('fourth');
  assert.equal(h.document.activeElement, elsewhere);
});
