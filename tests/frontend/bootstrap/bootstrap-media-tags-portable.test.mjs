import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHarness } from '../helpers/harness.mjs';

// Media Tags import, export and presets in the settings panel hub
// (settingspanel/ui-panel-tag-portable.js): the real panel host, hub and
// settings save path over a mocked server that answers the portable
// endpoints the way Helpers/MediaTagsPortable.cs does.

const otherToggles = ['autoPauseToggle', 'autoResumeToggle', 'autoPipToggle', 'autoSkipIntroToggle', 'autoSkipOutroToggle',
  'randomButtonToggle', 'randomUnwatchedOnly', 'randomScopeCurrentContainer', 'showWatchProgressToggle', 'showFileSizesToggle', 'showAudioLanguagesToggle',
  'removeContinueWatchingToggle', 'pauseScreenToggle', 'disableCustomSubtitleStyles', 'longPress2xEnabled', 'randomIncludeMovies', 'randomIncludeShows'];

/** plugin.js's key converters (object keys, arrays as they are). */
const convert = (first) => function walk(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [first(k.charAt(0)) + k.slice(1), walk(v)]));
};

const CINEPHILE = { v: 1, kind: 'je-media-tags-preset', id: 'cinephile', name: 'Cinephile', description: 'English text', settings: { TagLayout: 'corners', AwardsTagsEnabled: true } };

/**
 * The panel with the hub, over a server that stores settings.json (PascalCase)
 * and answers the media-tags endpoints.
 * @param {import('node:test').TestContext} t
 * Each user (and server) has its own store; `flags` hold or fail requests:
 * saveGate holds settings.json POSTs until it resolves, failSave answers them
 * with a 500, exportGate answers the export with what it resolves to.
 * @param {{stored?: object, plugin?: object, mine?: object[], offered?: object[], preview?: (doc: object) => object}} [options]
 */
function setup(t, { stored = {}, plugin = {}, mine = [], offered = [], preview } = {}) {
  const requests = [];
  const server = {
    settings: { TagLayoutSettingsVersion: 1, QualityTagsEnabled: true, RatingTagsEnabled: true, StatusTagsEnabled: true, TagLayout: 'corners', ...stored },
    mine: structuredClone(mine),
  };
  /** @type {{saveGate: Promise<void>|null, failSave: boolean, exportGate: Promise<object>|null}} */
  const flags = { saveGate: null, failSave: false, exportGate: null };
  const identity = { user: 'user-a', server: 'server-a' };
  const accounts = new Map([['server-a/user-a', server]]);
  /** The store a request is for (by the user id in its path and the current server). */
  const accountOf = (path) => accounts.get(`${identity.server}/${path.split('/user-settings/')[1]?.split('/')[0]}`) || server;
  /** What the server's preview answers: each posted field changes from the stored value; Foo is unknown. */
  const defaultPreview = (doc) => {
    const changes = [];
    const skipped = [];
    const imported = {};
    for (const [field, to] of Object.entries(doc.settings || {})) {
      if (field === 'Foo') { skipped.push({ field, reason: 'unknown', detail: null }); continue; }
      imported[field] = to;
      const from = server.settings[field] ?? null;
      if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ field, from, to });
    }
    return { kind: doc.kind, v: 1, name: doc.name ?? null, description: doc.description ?? null, imported, changes, skipped };
  };
  const copies = [];
  const clicks = [];
  const h = createHarness({
    html: otherToggles.map(id => `<input type="checkbox" id="${id}">`).join('') + '<input id="pauseScreenDelayInput"><button id="releaseNotesBtn"></button>',
    JE: {
      pluginConfig: { HelpPanelAutocloseDelay: 60000, ...plugin },
      userConfig: { settings: convert(c => c.toLowerCase())(server.settings), shortcuts: { Shortcuts: [] } },
      currentSettings: {},
      t: (key, params) => (params ? `${key}:${Object.values(params).join('|')}` : key),
      toast() {}, keyListener() {}, initializeShortcuts() {}, state: { activeShortcuts: {} }, pauseScreenInstance: {},
      themer: { getThemeVariables: () => ({ panelBg: '#000', secondaryBg: '#111', primaryAccent: '#0af', altAccent: '#222', blur: '0px', textColor: '#fff', logo: '' }) },
    },
    apiClient: {
      getCurrentUserId: () => identity.user,
      serverId: () => identity.server,
      getUrl: (path) => `http://jellyfin.test/${path.replace(/^\//, '')}`,
      ajax: async (request) => {
        const url = new URL(request.url);
        const path = url.pathname;
        const body = request.data ? JSON.parse(request.data) : null;
        requests.push({ type: request.type, path, body, server: identity.server });
        const account = accountOf(path);
        if (path.endsWith('/settings.json')) {
          if (request.type === 'POST') {
            if (flags.saveGate) await flags.saveGate;
            if (flags.failSave) throw { status: 500 };
            account.settings = body;
            return { success: true };
          }
          return structuredClone(account.settings);
        }
        if (path.endsWith('/media-tags/export')) {
          if (flags.exportGate) return await flags.exportGate;
          return { v: 1, kind: 'je-media-tags-user', settings: { TagLayout: account.settings.TagLayout, QualityTagsEnabled: account.settings.QualityTagsEnabled } };
        }
        if (path.endsWith('/media-tags/preview')) {
          const answer = (preview || defaultPreview)(body);
          if (answer.error) throw { status: 400, json: async () => answer };
          return answer;
        }
        if (path.endsWith('/media-tags/presets') && request.type === 'GET') return { max: 10, builtIn: [CINEPHILE], offered, mine: structuredClone(account.mine) };
        if (path.endsWith('/media-tags/presets') && request.type === 'POST') {
          if (account.mine.length >= 10) throw { status: 400, json: async () => ({ error: 'full', max: 10 }) };
          const preset = { v: 1, kind: 'je-media-tags-preset', id: `p${account.mine.length + 1}`, name: body.name.trim(), description: body.description || '', settings: body.settings };
          account.mine.push(preset);
          return { preset, skipped: body.settings.Foo !== undefined ? [{ field: 'Foo', reason: 'unknown', detail: null }] : [] };
        }
        if (request.type === 'DELETE' && path.includes('/media-tags/presets/')) {
          account.mine = account.mine.filter(p => p.id !== decodeURIComponent(path.split('/').pop()));
          return { success: true };
        }
        if (path.endsWith('/tag-styles')) return {};
        return null;
      },
    },
    globals: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
  });
  t.after(() => h.close());
  h.window.Element.prototype.getClientRects = function () { return [{ width: 1, height: 1 }]; };
  h.window.Element.prototype.scrollIntoView = function () {};
  Object.defineProperty(h.window.navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { copies.push(text); } } });
  h.window.URL.createObjectURL = () => 'blob:je-test';
  h.window.URL.revokeObjectURL = () => {};
  h.window.HTMLAnchorElement.prototype.click = function () { clicks.push(this.download); };
  h.JE.toCamelCase = convert(c => c.toLowerCase());
  h.JE.toPascalCase = convert(c => c.toUpperCase());
  for (const file of ['core/ui-kit.js', 'core/media-language.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-layout-styles.js', 'tags/rating-sources.js', 'enhanced/config.js', 'enhanced/icons.js', 'enhanced/helpers.js']) h.load(file);
  h.JE.currentSettings = h.JE.loadSettings();
  h.JE.core.navigation = { onNavigate: () => () => {} };
  h.load('core/session.js');
  h.JE.escapeHtml = h.JE.core.ui.escapeHtml;
  for (const file of ['ui-panel-settings.js', 'ui-panel-tag-editor.js', 'ui-panel-tag-looks.js', 'ui-panel-tag-preview.js', 'ui-panel-tag-portable.js', 'ui-panel-media-tags.js']) h.load(`enhanced/settingspanel/${file}`);
  const ui = h.JE.internals.enhancedUi;
  ui.buildPanelHtml = ctx => '<div class="panel-header"><div id="jePanelTitle">JE</div><button id="closeSettingsPanel">x</button></div>'
    + '<div class="je-panel-dock"><select id="jePanelSection"></select></div><div class="je-panel-body"><nav class="je-panel-nav"><input id="jePanelSearch" type="search"><ul id="jePanelSearchResults" hidden></ul><div class="je-panel-nav-items"></div></nav>'
    + `<div class="je-panel-main"><button id="jePanelBack"></button>${ui.buildMediaTagsHubHtml(ctx)}</div></div>`;
  for (const name of ['wireShortcutEditor', 'wireHiddenContentListeners', 'wireLanguageControls']) ui[name] = () => {};
  h.load('enhanced/settingspanel/ui-panel.js');
  const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
  const $ = selector => h.document.querySelector(selector);
  const click = (el) => { assert.ok(el, 'control exists'); el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true })); };
  const dialog = () => $('.je-pt-dialog');
  const action = (name) => dialog()?.querySelector(`[data-pt-action="${name}"]`);
  const paste = (text) => {
    const area = dialog().querySelector('[data-pt-paste]');
    area.value = text;
    area.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  };
  return {
    ...h, server, accounts, flags, requests, copies, clicks, settle, $, click, dialog, action, paste,
    /**
     * Sign in as another user (or the same user on another server) in this tab, as
     * plugin.js does: the session resets, then the new user's settings load. The
     * open panel stays on screen unless `closePanel`.
     * @param {string} user @param {object} [settings] - Their stored settings (a new account).
     * @param {{server?: string, closePanel?: boolean}} [opts]
     */
    switchUser(user, settings, { server: serverName = identity.server, closePanel = false } = {}) {
      const key = `${serverName}/${user}`;
      if (settings) accounts.set(key, { settings: structuredClone(settings), mine: [] });
      identity.user = user;
      identity.server = serverName;
      h.JE.session.checkNow('test-switch');
      h.JE.userConfig = { settings: convert(c => c.toLowerCase())(accounts.get(key).settings), shortcuts: { Shortcuts: [] } };
      h.JE.currentSettings = h.JE.loadSettings();
      if (closePanel) $('#closeSettingsPanel')?.click();
    },
    account: (user, serverName = 'server-a') => accounts.get(`${serverName}/${user}`),
    async open() { await h.JE.showEnhancedPanel(); await settle(); },
    key(el, key) { el.dispatchEvent(new h.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); },
    status: () => dialog()?.querySelector('.je-pt-status').textContent,
    names: (source) => Array.from(h.document.querySelectorAll(`[data-tp-source="${source}"] .je-mth-tp-name`), el => el.textContent),
  };
}

test('the Layout tab lists built-in, offered and own presets and the import and export actions', async t => {
  const h = setup(t, { mine: [{ id: 'p1', name: 'Mine', description: 'Saved here', settings: { TagGap: 'tight' } }], offered: [{ id: 'family', name: 'Family', description: '', settings: { TagScale: 'larger' } }] });
  await h.open();
  const layout = h.$('#jeMthPanel-layout');
  assert.ok(layout.querySelector('#jeMthPresets') && layout.querySelector('#jeMthPortable'), 'both cards are on the Layout tab');
  // Built-ins are translated by id; offered and own presets show their own names.
  assert.deepEqual(h.names('builtIn'), ['tag_presets_builtin_cinephile']);
  assert.deepEqual(h.names('offered'), ['Family']);
  assert.deepEqual(h.names('mine'), ['Mine']);
  assert.match(h.$('[data-tp-source="mine"] .je-mth-tp-count').textContent, /tag_looks_condition_count:1\|10/);
  assert.equal(h.$('[data-tp-source="builtIn"] [data-tp="delete"]'), null, 'only your own presets can be deleted');
  assert.ok(h.$('[data-tp-source="mine"] [data-tp="delete"]'));
  assert.equal(h.$('[data-tp-source="builtIn"] [data-tp="apply"]').getAttribute('aria-label'), 'tag_presets_apply_named:tag_presets_builtin_cinephile');
  // The settings search finds the new controls too.
  const labels = h.JE.internals.enhancedUi.mediaTagsHub.searchIndex().map(e => e.label);
  for (const label of ['tag_portable_export', 'tag_portable_import', 'tag_presets_save', 'tag_presets_import']) assert.ok(labels.includes(label), label);
});

test('export shows the server document, downloads it and copies it; Escape closes only the dialog', async t => {
  const h = setup(t);
  await h.open();
  const button = h.$('[data-tp="export"]');
  button.focus();
  h.click(button);
  await h.settle();
  const dialog = h.dialog();
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.ok(h.$('#jellyfin-enhanced-panel').contains(dialog), 'drawn inside the panel');
  const text = dialog.querySelector('textarea').value;
  assert.deepEqual(JSON.parse(text), { v: 1, kind: 'je-media-tags-user', settings: { TagLayout: 'corners', QualityTagsEnabled: true } });
  assert.ok(h.requests.some(r => r.path.endsWith('/media-tags/export')));
  h.click(h.action('download'));
  assert.match(h.clicks[0], /^jellyfin-media-tags-\d{4}-\d{2}-\d{2}\.json$/);
  h.click(h.action('copy'));
  await h.settle();
  assert.equal(h.copies[0], text);
  assert.equal(h.status(), 'tag_portable_copied');
  h.key(dialog, 'Escape');
  assert.equal(h.dialog(), null, 'the dialog closed');
  assert.ok(h.$('#jellyfin-enhanced-panel'), 'the panel stayed open');
  assert.equal(h.document.activeElement, button, 'focus went back to Export');
});

test('import checks the document on the server, shows changes and skipped fields, applies after a confirmation and undoes', async t => {
  const h = setup(t);
  await h.open();
  h.click(h.$('[data-tp="import"]'));
  await h.settle();
  // Not JSON: refused here, nothing sent.
  h.paste('{nope');
  h.click(h.action('next'));
  assert.equal(h.status(), 'tag_portable_error_not_json');
  assert.ok(!h.requests.some(r => r.path.endsWith('/preview')));

  const document = { v: 1, kind: 'je-media-tags-user', settings: { TagLayout: 'bands', TagGroupCaps: { Genre: 2 }, QualityTagsEnabled: true, Foo: 1 } };
  h.paste(JSON.stringify(document));
  h.click(h.action('next'));
  await h.settle();
  assert.deepEqual(h.requests.find(r => r.path.endsWith('/preview')).body, document, 'the document goes to the server as it is');
  const changed = Array.from(h.dialog().querySelectorAll('.je-pt-change .je-pt-field'), el => el.textContent);
  assert.deepEqual(changed, ['Tag Layout', 'Tag Group Caps']);
  assert.equal(h.dialog().querySelector('.je-pt-summary').textContent, 'tag_portable_changes_count:2');
  assert.deepEqual(Array.from(h.dialog().querySelectorAll('.je-pt-skip .je-pt-field'), el => el.textContent), ['Foo']);
  assert.equal(h.dialog().querySelector('.je-pt-skip .je-pt-reason').textContent.trim(), 'tag_portable_skip_unknown');
  assert.equal(h.server.settings.TagLayout, 'corners', 'nothing saved before Apply');

  h.click(h.action('apply'));
  await h.settle(8);
  // Saved through the normal settings save, only the changed fields different.
  assert.equal(h.server.settings.TagLayout, 'bands');
  assert.deepEqual(h.server.settings.TagGroupCaps, { Genre: 2 });
  assert.equal(h.server.settings.QualityTagsEnabled, true);
  assert.equal(h.server.settings.Foo, undefined, 'skipped fields are never applied');
  // The panel opened again on the new settings, with Undo.
  assert.equal(h.dialog(), null);
  assert.equal(h.JE.currentSettings.tagLayout, 'bands');
  const undo = h.$('[data-tp-undo]');
  assert.equal(undo.hidden, false);
  assert.match(undo.textContent, /tag_portable_applied:2/);
  assert.equal(h.document.activeElement, undo.querySelector('button'), 'focus is on Undo');
  assert.ok(h.$('input[name="jeTagLayout"][value="bands"]').checked, 'the layout tiles read the imported layout');

  h.click(undo.querySelector('button'));
  await h.settle(8);
  assert.equal(h.server.settings.TagLayout, 'corners');
  assert.equal(h.server.settings.TagGroupCaps, null);
  assert.equal(h.$('[data-tp-undo]').hidden, true, 'Undo is offered once');
});

test('a document the server refuses as a whole says why and applies nothing', async t => {
  const h = setup(t, { preview: () => ({ error: 'newer' }) });
  await h.open();
  h.click(h.$('[data-tp="import"]'));
  await h.settle();
  h.paste(JSON.stringify({ v: 9, kind: 'je-media-tags-user', settings: { TagLayout: 'bands' } }));
  h.click(h.action('next'));
  await h.settle();
  assert.equal(h.status(), 'tag_portable_error_newer');
  assert.equal(h.action('apply'), null);
  // The panel's own settings are saved before the check (as for Export); nothing of the document is.
  assert.ok(!h.requests.some(r => r.type === 'POST' && r.path.endsWith('/settings.json') && r.body.TagLayout !== 'corners'));
  assert.equal(h.server.settings.TagLayout, 'corners');
});

test('applying a preset previews it first; Share copies it under its shown name', async t => {
  const h = setup(t);
  await h.open();
  h.click(h.$('[data-tp-source="builtIn"] [data-tp="apply"]'));
  await h.settle();
  const posted = h.requests.find(r => r.path.endsWith('/preview')).body;
  assert.deepEqual(posted, { v: 1, kind: 'je-media-tags-preset', name: 'tag_presets_builtin_cinephile', description: 'tag_presets_builtin_cinephile_desc', settings: CINEPHILE.settings });
  assert.deepEqual(Array.from(h.dialog().querySelectorAll('.je-pt-change .je-pt-field'), el => el.textContent), ['Awards Tags Enabled']);
  h.click(h.action('cancel'));
  assert.equal(h.dialog(), null);
  assert.notEqual(h.server.settings.AwardsTagsEnabled, true, 'cancelled: nothing applied');

  h.click(h.$('[data-tp-source="builtIn"] [data-tp="share"]'));
  await h.settle();
  const shared = JSON.parse(h.copies.at(-1));
  assert.equal(shared.kind, 'je-media-tags-preset');
  assert.equal(shared.name, 'tag_presets_builtin_cinephile');
  assert.equal(shared.id, undefined, 'a shared preset carries no server id');
});

test('save as preset needs a name, stores the export and lists it; delete removes it; a full list stops saving', async t => {
  const h = setup(t);
  await h.open();
  h.click(h.$('[data-tp="save-preset"]'));
  h.click(h.action('save'));
  await h.settle();
  assert.equal(h.status(), 'tag_portable_error_name');
  h.dialog().querySelector('#jePtName').value = '  Evening ';
  h.dialog().querySelector('#jePtDesc').value = 'Dim and quiet';
  h.click(h.action('save'));
  await h.settle(8);
  const saved = h.requests.find(r => r.type === 'POST' && r.path.endsWith('/media-tags/presets')).body;
  assert.deepEqual(saved, { v: 1, kind: 'je-media-tags-preset', name: 'Evening', description: 'Dim and quiet', settings: { TagLayout: 'corners', QualityTagsEnabled: true } });
  assert.equal(h.dialog(), null);
  assert.deepEqual(h.names('mine'), ['Evening']);

  h.click(h.$('[data-tp-source="mine"] [data-tp="delete"]'));
  await h.settle(6);
  assert.ok(h.requests.some(r => r.type === 'DELETE' && r.path.endsWith('/media-tags/presets/p1')));
  assert.deepEqual(h.names('mine'), []);
  assert.ok(h.$('[data-tp-source="mine"]').textContent.includes('tag_presets_none_yet'));

  // Ten presets: Save and Import are off.
  h.server.mine = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, name: `P${i}`, description: '', settings: { TagGap: 'tight' } }));
  h.JE.internals.enhancedUi.mediaTagsHub.dispose();
  h.$('#closeSettingsPanel').click();
  await h.open();
  assert.equal(h.$('[data-tp="save-preset"]').disabled, true);
  assert.equal(h.$('[data-tp="import-preset"]').disabled, true);
  assert.match(h.$('[data-tp="save-preset"]').title, /tag_presets_full:10/);
});

test('import preset adds a shared preset to your list and reports what it dropped', async t => {
  const h = setup(t);
  await h.open();
  h.click(h.$('[data-tp="import-preset"]'));
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-preset', settings: { TagScale: 'larger' } }));
  h.click(h.action('next'));
  await h.settle();
  assert.equal(h.status(), 'tag_portable_error_name', 'a preset needs a name');
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-preset', name: 'Shared', settings: { TagScale: 'larger', Foo: 1 } }));
  h.click(h.action('next'));
  await h.settle(8);
  assert.deepEqual(h.names('mine'), ['Shared']);
  // Something was dropped: the dialog stays to say what.
  assert.ok(h.dialog().textContent.includes('tag_presets_saved:Shared'));
  assert.deepEqual(Array.from(h.dialog().querySelectorAll('.je-pt-skip .je-pt-field'), el => el.textContent), ['Foo']);
  assert.equal(h.dialog().querySelector('.je-pt-summary[data-je-summary]'), null);
});

const pluginRoot = new URL('../../../Jellyfin.Plugin.JellyfinEnhanced/', import.meta.url);

/**
 * The nullable personal fields a user document carries: Helpers/MediaTagsPortable.cs
 * UserFields that JellyfinEnhancedUserSettings declares nullable (null = follow the
 * server). Read from the sources so a new nullable field is covered here too.
 * @returns {string[]}
 */
function nullablePortableFields() {
  const portable = readFileSync(new URL('Helpers/MediaTagsPortable.cs', pluginRoot), 'utf8');
  const fields = [...portable.match(/UserFields = new\[\]\s*\{([\s\S]*?)\};/)[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
  const config = readFileSync(new URL('Configuration/UserConfiguration.cs', pluginRoot), 'utf8');
  const start = config.indexOf('class JellyfinEnhancedUserSettings');
  const body = config.slice(start, config.indexOf('\n    public class ', start));
  const nullable = new Set([...body.matchAll(/public\s+[\w<>[\], ]+\?\s+(\w+)\s*\{/g)].map(m => m[1]));
  // Rules/locks are server-specific; date context is captured by the browser, not a portable preference.
  const excluded = new Set(['TagLookRules', 'TagLayoutLocks', 'NativePosterDateLocale', 'NativePosterTimeZone']);
  const expected = [...nullable].filter(f => !excluded.has(f));
  assert.deepEqual(fields.filter(f => nullable.has(f)).sort(), expected.sort(), 'every nullable Media Tags preference is portable');
  return fields.filter(f => nullable.has(f));
}

/** An explicit value for every nullable portable field, unlike the administrator's below. */
const EXPLICIT = {
  UseNativePosterTags: false,
  ShowEditionTag: false, EditionTagOrder: 1, ShowLowQualitySourceTag: true,
  ResolutionTagOrder: 7, SourceTagOrder: 6, DynamicRangeTagOrder: 5, SpecialFormatTagOrder: 4, VideoCodecTagOrder: 3, AudioInfoTagOrder: 2,
  ShowRuntimeTag: true, ShowAspectRatioTag: true, ShowFrameRateTag: true,
  RuntimeTagOrder: 10, AspectRatioTagOrder: 9, FrameRateTagOrder: 8,
  QualityAudioDisplayMode: 'all', QualityVideoCodecDisplayMode: 'all', QualityHdrDisplayMode: 'all', QualityMinimumResolution: '4k', QualityHideSdr: true,
  SeriesQualityAggregation: 'mixed',
  RatingTagsSources: ['community'],
  LanguageTagsPriority: ['ja', 'en'], LanguageTagsPriorityStrict: true,
  TagLayouts: { Summary: { Groups: [{ Group: 'language', Slot: 'pill' }] } }, TagGroupOrder: ['genre', 'quality'], TagGroupCaps: { Genre: 2 },
  TagScale: 'larger', TagGap: 'roomy', TagEdgeSpacing: 'tight', TagStylePreset: 'poster',
  TagShapeOverrides: { Landscape: { Layout: 'bands', Density: 'compact' } },
};

/** Administrator values the inherited fields resolve to (none the built-in fallback). */
const ADMIN = {
  ShowEditionTag: true, EditionTagOrder: 3, ShowLowQualitySourceTag: false,
  ResolutionTagOrder: 2, SourceTagOrder: 1, DynamicRangeTagOrder: 4, SpecialFormatTagOrder: 5, VideoCodecTagOrder: 7, AudioInfoTagOrder: 6,
  ShowRuntimeTag: false, ShowAspectRatioTag: false, ShowFrameRateTag: false, RuntimeTagOrder: 8, AspectRatioTagOrder: 10, FrameRateTagOrder: 9,
  QualityAudioDisplayMode: 'highest', QualityVideoCodecDisplayMode: 'highest', QualityHdrDisplayMode: 'highest', QualityMinimumResolution: '1080p', QualityHideSdr: false,
  SeriesQualityAggregation: 'best', LanguageTagsPriority: 'fr', LanguageTagsPriorityStrict: true, TagScale: 'smaller', TagGap: 'tight',
};

/** Import a document through the hub's dialog and apply it. */
async function importAndApply(h, settings) {
  h.click(h.$('[data-tp="import"]'));
  await h.settle();
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-user', settings }));
  h.click(h.action('next'));
  await h.settle();
  h.click(h.action('apply'));
  await h.settle(12);
}

test('Undo of an import over an inherited aggregation leaves it inherited after the panel reopens and saves', async t => {
  const h = setup(t, { stored: { SeriesQualityAggregation: null, TagGap: null }, plugin: { SeriesQualityAggregation: 'best' } });
  await h.open();
  assert.equal(h.JE.currentSettings.seriesQualityAggregation, 'best', 'shown as the administrator\'s');
  await importAndApply(h, { SeriesQualityAggregation: 'mixed', TagGap: 'roomy' });
  assert.equal(h.server.settings.SeriesQualityAggregation, 'mixed');
  assert.equal(h.server.settings.TagGap, 'roomy');

  h.click(h.$('[data-tp-undo] button'));
  // The reopened panel opens the Media Tags pane, which saves the whole document.
  await h.settle(16);
  assert.equal(h.server.settings.SeriesQualityAggregation, null, 'inherited again, not pinned to "best"');
  assert.equal(h.server.settings.TagGap, null);
  assert.equal(h.JE.currentSettings.seriesQualityAggregation, 'best', 'still shown resolved');

  // Any later save keeps it inherited; the administrator's next choice applies.
  h.JE.currentSettings.tagsHideOnHover = true;
  await h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  assert.equal(h.server.settings.TagsHideOnHover, true);
  assert.equal(h.server.settings.SeriesQualityAggregation, null);

  // The next import reads it as the server default.
  h.click(h.$('[data-tp="import"]'));
  await h.settle();
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-user', settings: { SeriesQualityAggregation: 'mixed' } }));
  h.click(h.action('next'));
  await h.settle();
  assert.equal(h.dialog().querySelector('.je-pt-from').textContent, 'tag_portable_value_inherit');
});

test('every nullable personal field stays inherited through opening, an import, Undo, reopening and later saves', async t => {
  const fields = nullablePortableFields();
  assert.deepEqual(fields.slice().sort(), Object.keys(EXPLICIT).sort(), 'EXPLICIT names every nullable field of a user document');
  const stored = Object.fromEntries(fields.map(f => [f, null]));
  const h = setup(t, { stored, plugin: ADMIN });
  await h.open();
  const unset = () => fields.filter(f => h.server.settings[f] !== null && h.server.settings[f] !== undefined);

  // Ordinary saves (a pane switch, another setting) never pin today's defaults.
  h.click(h.$('.je-panel-nav-items .tab-button'));
  h.JE.currentSettings.tagsHideOnHover = true;
  await h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  assert.equal(h.server.settings.TagsHideOnHover, true, 'the document was saved');
  assert.deepEqual(unset(), [], 'nothing pinned by an ordinary save');

  await importAndApply(h, EXPLICIT);
  for (const field of fields) assert.deepEqual(h.server.settings[field], EXPLICIT[field], `${field} imported`);

  h.click(h.$('[data-tp-undo] button'));
  await h.settle(16);
  assert.deepEqual(unset(), [], 'Undo restores inheritance for every nullable field');

  // Reopen once more and save again: still inherited.
  h.$('#closeSettingsPanel').click();
  await h.open();
  h.click(h.$('.je-panel-nav-items .tab-button'));
  h.JE.currentSettings.tagsHideOnHover = false;
  await h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  assert.equal(h.server.settings.TagsHideOnHover, false);
  assert.deepEqual(unset(), []);
  // Shown as the administrator's choices meanwhile.
  assert.equal(h.JE.currentSettings.seriesQualityAggregation, 'best');
  assert.equal(h.JE.currentSettings.resolutionTagOrder, 2);
  assert.equal(h.JE.currentSettings.showLowQualitySourceTag, false);
});

test('an import of the administrator\'s own value is kept as the user\'s choice', async t => {
  const h = setup(t, { stored: { SeriesQualityAggregation: null, ResolutionTagOrder: null }, plugin: { SeriesQualityAggregation: 'best', ResolutionTagOrder: 2 } });
  await h.open();
  await importAndApply(h, { SeriesQualityAggregation: 'best', ResolutionTagOrder: 2 });
  assert.equal(h.server.settings.SeriesQualityAggregation, 'best', 'explicit even though it equals the default');
  assert.equal(h.server.settings.ResolutionTagOrder, 2);
  h.JE.currentSettings.tagsHideOnHover = true;
  await h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  assert.equal(h.server.settings.SeriesQualityAggregation, 'best');
});

// ── Late answers after a sign-in change (astra R4-1) ─────────────────

/** Paste a user document into a fresh Import dialog and ask for its preview. */
async function importDocument(h, settings) {
  h.click(h.$('[data-tp="import"]'));
  await h.settle();
  h.paste(JSON.stringify({ v: 1, kind: 'je-media-tags-user', settings }));
  h.click(h.action('next'));
  await h.settle(12);
}

test('save as preset whose export answers after another user signed in posts nothing for either user', async t => {
  const h = setup(t, { stored: { TagLayout: 'bands' } });
  await h.open();
  let release;
  h.flags.exportGate = new Promise(resolve => { release = resolve; });
  h.click(h.$('[data-tp="save-preset"]'));
  h.dialog().querySelector('#jePtName').value = 'A private preset';
  h.click(h.action('save'));
  await h.settle(10);
  assert.ok(h.requests.some(r => r.path.includes('/user-a/media-tags/export')), 'the export is on its way for user A');

  h.switchUser('user-b', { TagLayoutSettingsVersion: 1, TagLayout: 'minimal' });
  await h.settle(6);
  release({ v: 1, kind: 'je-media-tags-user', settings: { TagLayout: 'bands' } });
  await h.settle(15);
  assert.deepEqual(h.requests.filter(r => r.type === 'POST' && r.path.endsWith('/media-tags/presets')), [], 'no preset is posted, least of all into B\'s list');
  assert.deepEqual(h.account('user-b').mine, []);
  assert.deepEqual(h.account('user-a').mine, []);
});

for (const [name, back] of [
  ['another user', (h) => h.switchUser('user-b', { TagLayoutSettingsVersion: 1, TagLayout: 'minimal' })],
  ['another user and back again', (h) => { h.switchUser('user-b', { TagLayoutSettingsVersion: 1, TagLayout: 'minimal' }); h.switchUser('user-a'); }],
  ['the same user id on another server', (h) => h.switchUser('user-a', { TagLayoutSettingsVersion: 1, TagLayout: 'minimal' }, { server: 'server-b' })],
]) {
  test(`an import whose save answers after a sign-in change (${name}) offers no Undo to the next session`, async t => {
    const h = setup(t);
    await h.open();
    await importDocument(h, { TagLayout: 'bands' });
    let release;
    h.flags.saveGate = new Promise(resolve => { release = resolve; });
    h.click(h.action('apply'));
    await h.settle(8);
    back(h);
    await h.settle(6);
    h.flags.saveGate = null;
    release();
    await h.settle(12);
    assert.equal(h.account('user-a').settings.TagLayout, 'bands', 'A\'s own save still lands in A\'s settings');

    // The next session opens the panel (and the stale one is still on screen too).
    const posts = h.requests.length;
    h.$('#closeSettingsPanel')?.click();
    await h.open();
    const bar = h.$('[data-tp-undo]');
    assert.equal(bar.hidden, true, 'no Undo from the previous session');
    assert.equal(bar.querySelector('[data-tp="undo"]'), null);
    assert.equal(h.requests.slice(posts).filter(r => r.type === 'POST').length, 0, 'nothing written for the next session');
  });
}

test('an import save that fails after another user signed in leaves that user\'s settings alone', async t => {
  const h = setup(t);
  await h.open();
  await importDocument(h, { UseNativePosterTags: false });
  let release;
  h.flags.saveGate = new Promise(resolve => { release = resolve; });
  h.click(h.action('apply'));
  await h.settle(8);
  h.switchUser('user-b', { TagLayoutSettingsVersion: 1, TagLayout: 'minimal', UseNativePosterTags: true });
  const userB = h.JE.userConfig;
  await h.settle(4);
  h.flags.saveGate = null;
  h.flags.failSave = true;
  release();
  await h.settle(12);
  h.flags.failSave = false;
  assert.equal(userB.settings.useNativePosterTags, true, 'the rollback of A\'s import never reaches B\'s configuration');
  assert.equal(h.JE.currentSettings.tagLayout, 'minimal');
});

test('an import that finishes after its panel was closed still offers Undo in the same session', async t => {
  const h = setup(t);
  await h.open();
  await importDocument(h, { TagLayout: 'bands' });
  let release;
  h.flags.saveGate = new Promise(resolve => { release = resolve; });
  h.click(h.action('apply'));
  await h.settle(8);
  h.$('#closeSettingsPanel').click();
  await h.settle(4);
  h.flags.saveGate = null;
  release();
  await h.settle(12);
  assert.equal(h.server.settings.TagLayout, 'bands');
  if (!h.$('#jeMediaTagsHub')) await h.open();
  const bar = h.$('[data-tp-undo]');
  assert.equal(bar.hidden, false, 'Undo is offered to the session that imported');
  h.click(bar.querySelector('[data-tp="undo"]'));
  await h.settle(12);
  assert.equal(h.server.settings.TagLayout, 'corners', 'and it undoes');
});

// ── Settings not saved yet (astra R4-2, R4-3 = opus 2) ───────────────

/** Choose a layout tile on the Layout tab, as a click does (it saves at once). */
async function chooseLayout(h, value) {
  const tile = h.$(`input[name="jeTagLayout"][value="${value}"]`);
  assert.ok(tile, `the ${value} tile exists`);
  tile.checked = true;
  tile.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await h.settle(8);
}

const fieldsListed = (h) => Array.from(h.dialog().querySelectorAll('.je-pt-change .je-pt-field'), el => el.textContent);

test('import waits for a layout save still on its way before asking for the preview, then applies the document', async t => {
  const h = setup(t);
  await h.open();
  let release;
  h.flags.saveGate = new Promise(resolve => { release = resolve; });
  await chooseLayout(h, 'bands');
  await importDocument(h, { TagLayout: 'corners', TagGap: 'tight' });
  assert.ok(!h.requests.some(r => r.path.endsWith('/preview')), 'no preview while the save is on its way');
  assert.equal(h.status(), 'tag_portable_checking');
  h.flags.saveGate = null;
  release();
  await h.settle(12);
  assert.deepEqual(fieldsListed(h), ['Tag Layout', 'Tag Gap'], 'compared with the settings the panel shows');
  h.click(h.action('apply'));
  await h.settle(20);
  assert.equal(h.server.settings.TagLayout, 'corners', 'the document\'s layout is applied');
  assert.equal(h.server.settings.TagGap, 'tight');
  assert.equal(h.JE.currentSettings.tagLayout, 'corners');
  assert.equal(h.$('[data-tp-undo]').hidden, false);
});

test('import refuses while a layout save failed, says so, and checks again once it saves', async t => {
  const h = setup(t);
  h.expectConsoleError(/Failed to save settings.json/);
  await h.open();
  h.flags.failSave = true;
  await chooseLayout(h, 'bands');
  await importDocument(h, { TagLayout: 'corners', TagGap: 'tight' });
  assert.equal(h.status(), 'tag_portable_import_unsaved');
  assert.ok(!h.requests.some(r => r.path.endsWith('/preview')), 'not previewed against settings the panel does not show');
  assert.ok(h.dialog().querySelector('[data-pt-paste]'), 'the pasted document stays for another try');
  assert.equal(h.JE.currentSettings.tagLayout, 'bands', 'the panel keeps the edit');

  h.flags.failSave = false;
  h.click(h.action('next'));
  await h.settle(12);
  assert.deepEqual(fieldsListed(h), ['Tag Layout', 'Tag Gap']);
  h.click(h.action('apply'));
  await h.settle(20);
  assert.equal(h.server.settings.TagLayout, 'corners');
  assert.equal(h.server.settings.TagGap, 'tight');
});

test('applying a preset while a save failed offers Retry, then previews', async t => {
  const h = setup(t);
  h.expectConsoleError(/Failed to save settings.json/);
  await h.open();
  h.flags.failSave = true;
  await chooseLayout(h, 'bands');
  h.click(h.$('[data-tp-source="builtIn"] [data-tp="apply"]'));
  await h.settle(10);
  assert.equal(h.status(), 'tag_portable_import_unsaved');
  assert.ok(!h.requests.some(r => r.path.endsWith('/preview')));
  assert.equal(h.dialog().querySelector('[data-pt-loading]').hidden, true, 'no "Loading" beside the status');
  h.flags.failSave = false;
  h.click(h.action('retry'));
  await h.settle(12);
  assert.deepEqual(fieldsListed(h), ['Tag Layout', 'Awards Tags Enabled']);
});

test('export after a failed save says the settings are not saved, exports nothing, and Retry exports the shown settings', async t => {
  const h = setup(t);
  h.expectConsoleError(/Failed to save settings.json/);
  await h.open();
  h.flags.failSave = true;
  await chooseLayout(h, 'bands');
  h.click(h.$('[data-tp="export"]'));
  await h.settle(12);
  assert.equal(h.status(), 'tag_portable_export_unsaved');
  assert.ok(!h.requests.some(r => r.path.endsWith('/media-tags/export')), 'no export of the stored settings');
  assert.equal(h.dialog().querySelector('[data-pt-loading]').hidden, true, 'no "Loading" beside the status');
  assert.equal(h.action('download'), null);
  assert.equal(h.dialog().querySelector('textarea'), null);
  assert.equal(h.document.activeElement, h.action('retry'));

  h.flags.failSave = false;
  h.click(h.action('retry'));
  await h.settle(12);
  assert.equal(JSON.parse(h.dialog().querySelector('textarea').value).settings.TagLayout, 'bands');
  assert.ok(h.action('download'));
  assert.equal(h.status(), '');
});

test('save as preset after a failed save stores nothing until the settings save, then stores what the panel shows', async t => {
  const h = setup(t);
  h.expectConsoleError(/Failed to save settings.json/);
  await h.open();
  h.flags.failSave = true;
  await chooseLayout(h, 'bands');
  h.click(h.$('[data-tp="save-preset"]'));
  h.dialog().querySelector('#jePtName').value = 'Current';
  h.click(h.action('save'));
  await h.settle(15);
  assert.equal(h.status(), 'tag_presets_save_unsaved');
  assert.deepEqual(h.server.mine, [], 'no preset of the old settings');
  assert.ok(!h.requests.some(r => r.path.endsWith('/media-tags/export')));
  assert.equal(h.action('save').disabled, false, 'Save is the retry');

  h.flags.failSave = false;
  h.click(h.action('save'));
  await h.settle(15);
  assert.equal(h.dialog(), null);
  assert.deepEqual(h.server.mine.map(p => [p.name, p.settings.TagLayout]), [['Current', 'bands']]);
});

test('a layout change after the preview shows the preview again instead of applying the old one', async t => {
  const h = setup(t);
  await h.open();
  // The document's layout is already the user's: only the gap is listed.
  await importDocument(h, { TagLayout: 'corners', TagGap: 'tight' });
  assert.deepEqual(fieldsListed(h), ['Tag Gap']);
  await chooseLayout(h, 'bands');
  h.click(h.action('apply'));
  await h.settle(20);
  assert.equal(h.status(), 'tag_portable_import_changed');
  assert.deepEqual(fieldsListed(h), ['Tag Layout', 'Tag Gap'], 'compared again with the settings the panel shows');
  assert.notEqual(h.server.settings.TagGap, 'tight', 'nothing applied from the old preview');
  h.click(h.action('apply'));
  await h.settle(20);
  assert.equal(h.server.settings.TagLayout, 'corners', 'the document\'s layout, not the edit the old preview missed');
  assert.equal(h.server.settings.TagGap, 'tight');
});

// ── A failed import save and a newer edit (astra R5-1) ───────────────

test('a failed import rolls back only its own fields: a layout chosen while its save was on its way is kept', async t => {
  const h = setup(t);
  await h.open();
  const gapBefore = h.JE.currentSettings.tagGap;
  await importDocument(h, { TagLayout: 'bands', TagGap: 'tight' });
  // Only the import's settings POST is held, then refused.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ajax = h.window.ApiClient.ajax;
  let failNext = true;
  h.window.ApiClient.ajax = async (request) => {
    if (request.type === 'POST' && new URL(request.url).pathname.endsWith('/settings.json') && failNext) {
      failNext = false;
      await gate;
      throw { status: 500 };
    }
    return ajax(request);
  };
  h.click(h.action('apply'));
  await h.settle(6);
  // The dialog's own close: the Apply already posted goes on.
  h.click(h.dialog().querySelector('[data-pt-close]'));
  await chooseLayout(h, 'minimal');
  release();
  await h.settle(20);
  assert.equal(h.server.settings.TagLayout, 'minimal', 'the newer edit is saved');
  assert.equal(h.JE.currentSettings.tagLayout, 'minimal', 'and kept: the rollback does not take it back');
  assert.equal(h.$('input[name="jeTagLayout"]:checked').value, 'minimal');
  assert.equal(h.JE.currentSettings.tagGap, gapBefore, 'a field only the import changed is rolled back');
  assert.notEqual(h.server.settings.TagGap, 'tight');
  // The hub announces after 30 ms (a fresh text each time).
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(h.$('#jeMthLive').textContent, 'tag_portable_apply_failed', 'the failure is said on the panel when the dialog is closed');

  // The next unrelated edit saves the layout the panel shows.
  h.JE.currentSettings.tagScale = 'larger';
  await h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  await h.settle(8);
  assert.equal(h.server.settings.TagLayout, 'minimal');
  assert.equal(h.server.settings.TagScale, 'larger');
});

// ── A failed preset deletion (astra R5-6) ─────────────────────────────

test('a preset whose deletion fails stays listed, is never announced as deleted, and Retry deletes it', async t => {
  const h = setup(t, { mine: [{ id: 'p1', name: 'Keep', description: '', settings: { TagLayout: 'bands' } }] });
  await h.open();
  const ajax = h.window.ApiClient.ajax;
  let refuse = 500;
  h.window.ApiClient.ajax = async (request) => {
    if (request.type === 'DELETE' && refuse) throw { status: refuse };
    return ajax(request);
  };
  const announced = [];
  const live = h.$('#jeMthLive');
  new h.window.MutationObserver(() => { if (live.textContent) announced.push(live.textContent); }).observe(live, { childList: true, characterData: true, subtree: true });
  h.click(h.$('[data-tp-source="mine"] [data-tp="delete"]'));
  await new Promise(resolve => setTimeout(resolve, 80));
  await h.settle(6);
  assert.deepEqual(h.server.mine.map(p => p.name), ['Keep']);
  assert.deepEqual(h.names('mine'), ['Keep'], 'the row stays');
  assert.deepEqual(announced, [], 'never announced as deleted');
  const error = h.$('[data-tp-error]');
  assert.equal(error?.hidden, false, 'a visible failure status');
  assert.equal(error.textContent.includes('tag_presets_delete_failed:Keep'), true);
  const retry = error.querySelector('[data-tp="delete-retry"]');
  assert.equal(h.document.activeElement, retry, 'focus on Retry');

  // A second failure keeps the same Retry focused.
  h.click(retry);
  await new Promise(resolve => setTimeout(resolve, 80));
  await h.settle(6);
  assert.equal(h.document.activeElement, retry);
  assert.deepEqual(announced, []);

  refuse = 0;
  h.click(retry);
  await new Promise(resolve => setTimeout(resolve, 80));
  await h.settle(6);
  assert.deepEqual(h.server.mine, []);
  assert.deepEqual(h.names('mine'), []);
  assert.equal(error.hidden, true);
  assert.deepEqual(announced, ['tag_presets_deleted:Keep']);
  assert.equal(h.document.activeElement, h.$('[data-tp="save-preset"]'));
});

test('a preset another device already deleted (404) is announced as deleted', async t => {
  const h = setup(t, { mine: [{ id: 'p1', name: 'Gone', description: '', settings: { TagLayout: 'bands' } }] });
  await h.open();
  const ajax = h.window.ApiClient.ajax;
  h.window.ApiClient.ajax = async (request) => {
    if (request.type === 'DELETE') { h.server.mine = []; throw { status: 404 }; }
    return ajax(request);
  };
  h.click(h.$('[data-tp-source="mine"] [data-tp="delete"]'));
  await new Promise(resolve => setTimeout(resolve, 80));
  await h.settle(6);
  assert.deepEqual(h.names('mine'), []);
  assert.notEqual(h.$('[data-tp-error]')?.hidden, false, 'no failure status');
  assert.equal(h.$('#jeMthLive').textContent, 'tag_presets_deleted:Gone');
});

// ── Export Retry keeps focus in the dialog (opus R5 4) ────────────────

/** Export while the settings save fails: the not-saved status with Retry focused. */
async function exportUnsaved(h) {
  h.expectConsoleError(/Failed to save settings.json/);
  await h.open();
  h.flags.failSave = true;
  await chooseLayout(h, 'bands');
  h.click(h.$('[data-tp="export"]'));
  await h.settle(12);
  assert.equal(h.status(), 'tag_portable_export_unsaved');
  assert.equal(h.document.activeElement, h.action('retry'));
  h.flags.failSave = false;
}

test('export Retry keeps keyboard focus inside the dialog while it works and when the read fails; Escape closes only the dialog', async t => {
  const h = setup(t);
  await exportUnsaved(h);
  let reject;
  h.flags.exportGate = new Promise((resolve, no) => { reject = no; });
  const retry = h.action('retry');
  h.click(retry);
  await h.settle(8);
  assert.equal(h.status(), 'tag_portable_checking');
  assert.ok(h.dialog().contains(h.document.activeElement), 'focus stays in the dialog while the export loads');
  reject({ status: 500 });
  await h.settle(8);
  assert.equal(h.status(), 'tag_portable_export_failed');
  const active = h.document.activeElement;
  assert.ok(h.dialog().contains(active), 'and after the read failed');
  h.key(active, 'Escape');
  await h.settle();
  assert.equal(h.dialog(), null, 'Escape closes the dialog');
  assert.ok(h.$('#jellyfin-enhanced-panel'), 'and not the settings panel');
});

test('export Retry while the save is still on its way keeps focus on Retry; another not-saved answer keeps it there', async t => {
  const h = setup(t);
  await exportUnsaved(h);
  let release;
  h.flags.saveGate = new Promise(resolve => { release = resolve; });
  h.flags.failSave = true;
  const retry = h.action('retry');
  h.click(retry);
  await h.settle(8);
  assert.equal(h.document.activeElement, retry, 'focus stays on Retry while the save is held');
  h.flags.saveGate = null;
  release();
  await h.settle(12);
  assert.equal(h.status(), 'tag_portable_export_unsaved');
  assert.equal(h.document.activeElement, h.action('retry'));
  h.flags.failSave = false;
  h.click(h.action('retry'));
  await h.settle(12);
  assert.equal(h.document.activeElement, h.action('download'), 'Download takes focus once exported');
});

// ── No "Loading" beside an error, and Retry, on every failure (opus R5 7) ──

/** The dialog's loading line is shown (by its text, not only its hook). */
const loadingShown = (h) => Array.from(h.dialog().querySelectorAll('.je-pt-hint'))
  .some(el => el.textContent === 'hidden_content_admin_loading' && !el.closest('[hidden]'));

test('export whose read fails hides the loading line and offers Retry, which exports', async t => {
  const h = setup(t);
  await h.open();
  let reject;
  h.flags.exportGate = new Promise((resolve, no) => { reject = no; });
  h.click(h.$('[data-tp="export"]'));
  await h.settle(8);
  assert.equal(loadingShown(h), true, 'loading while the read is on its way');
  reject({ status: 500 });
  await h.settle(8);
  assert.equal(h.status(), 'tag_portable_export_failed');
  assert.equal(loadingShown(h), false, 'no "Loading" beside the error');
  assert.equal(h.document.activeElement, h.action('retry'), 'Retry in the same dialog');
  h.flags.exportGate = null;
  h.click(h.action('retry'));
  await h.settle(12);
  assert.equal(JSON.parse(h.dialog().querySelector('textarea').value).settings.TagLayout, 'corners');
});

test('a preset whose preview fails hides the loading line and offers Retry, which previews', async t => {
  let refuse = true;
  const h = setup(t, { preview: (doc) => (refuse ? { error: 'settings' } : { kind: doc.kind, v: 1, name: doc.name, imported: doc.settings, changes: [{ field: 'AwardsTagsEnabled', from: false, to: true }], skipped: [] }) });
  await h.open();
  h.click(h.$('[data-tp-source="builtIn"] [data-tp="apply"]'));
  await h.settle(12);
  assert.equal(h.status(), 'tag_portable_error_settings');
  assert.equal(loadingShown(h), false, 'no "Loading" beside the error');
  assert.equal(h.document.activeElement, h.action('retry'));
  refuse = false;
  h.click(h.action('retry'));
  await h.settle(12);
  assert.deepEqual(fieldsListed(h), ['Awards Tags Enabled']);
  assert.ok(h.action('apply'));
});
