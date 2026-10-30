import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

/**
 * The real panel host (ui-panel.js) with the real Media Tags hub in it (its
 * group editor and live preview); the other sections are stubbed out. A
 * fake IntersectionObserver records what the hub watches so tests can fire
 * it or check it was released.
 * @param {import('node:test').TestContext} t
 */
function setup(t) {
  const observers = [];
  const writes = [];
  class FakeIntersectionObserver {
    constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
    observe(el) { this.targets.push(el); }
    disconnect() { this.disconnected = true; this.targets = []; }
    /** Report the watched element as on screen (as the browser would). */
    fire() { this.callback(this.targets.map(target => ({ target, isIntersecting: true }))); }
  }
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  const h = createHarness({
    JE: {
      pluginConfig: { HelpPanelAutocloseDelay: 60000 }, userConfig: { settings: { qualityTagsEnabled: true, ratingTagsEnabled: true }, shortcuts: { Shortcuts: [] } }, currentSettings: {},
      t: key => key, toast() {}, keyListener() {}, initializeShortcuts() {}, state: { activeShortcuts: { x: 1 } },
      themer: { getThemeVariables: () => ({ panelBg: '#000', secondaryBg: '#111', primaryAccent: '#0af', altAccent: '#222', blur: '0px', textColor: '#fff', logo: '' }) },
    },
    apiClient: { getUrl: path => path, ajax: async request => { if (request.type === 'GET') return null; writes.push(request); } },
    globals: { IntersectionObserver: FakeIntersectionObserver, matchMedia: () => media },
  });
  t.after(() => h.close());
  // Count re-registrations of the global shortcut listener (each close path restores it).
  let shortcutRestores = 0;
  const addEventListener = h.document.addEventListener.bind(h.document);
  h.document.addEventListener = (type, fn, options) => {
    if (fn === h.JE.keyListener) shortcutRestores++;
    return addEventListener(type, fn, options);
  };
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'tags/tag-layout-styles.js', 'tags/rating-sources.js', 'enhanced/config.js', 'enhanced/icons.js']) h.load(file);
  h.JE.currentSettings = h.JE.loadSettings();
  h.JE.escapeHtml = h.JE.core.ui.escapeHtml;
  for (const file of ['ui-panel-tag-editor.js', 'ui-panel-tag-preview.js', 'ui-panel-media-tags.js']) h.load(`enhanced/settingspanel/${file}`);
  const ui = h.JE.internals.enhancedUi;
  ui.buildPanelHtml = ctx => `<div class="panel-header"><button id="closeSettingsPanel">x</button></div>${ui.buildMediaTagsHubHtml(ctx)}`;
  for (const name of ['wireShortcutEditor', 'wireSettingsListeners', 'wireHiddenContentListeners', 'wireMiscSettingsControls', 'wireLanguageControls']) ui[name] = () => {};
  h.load('enhanced/settingspanel/ui-panel.js');
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    ...h, ui, observers, writes, settle,
    shortcutRestores: () => shortcutRestores,
    panel: () => h.document.getElementById('jellyfin-enhanced-panel'),
    async open() { await h.JE.showEnhancedPanel(); return observers.at(-1); },
  };
}

/** The ways a user closes the panel. */
const closePaths = {
  escape: async h => { h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); },
  'close button': async h => { h.document.getElementById('closeSettingsPanel').click(); },
  toggle: async h => { await h.JE.showEnhancedPanel(); },
  'auto-close': async h => {
    // The pointer leaves the panel and the (shortened) auto-close delay runs out.
    h.JE.pluginConfig.HelpPanelAutocloseDelay = 10;
    h.panel().dispatchEvent(new h.window.MouseEvent('mouseleave'));
    await new Promise(resolve => setTimeout(resolve, 50));
    h.JE.pluginConfig.HelpPanelAutocloseDelay = 60000;
  },
};

for (const [path, close] of Object.entries(closePaths)) {
  test(`closing the panel (${path}) before Media Tags was on screen releases the hub and its preview; reopening works`, async t => {
    const h = setup(t);
    const first = await h.open();
    assert.ok(h.panel());
    assert.equal(first.targets[0]?.id, 'jeMediaTagsHub', 'the preview waits for the Media Tags section to be on screen');
    assert.equal(h.document.querySelector('.je-mtp-card'), null, 'nothing drawn before that');
    const firstHub = h.ui.mediaTagsHub;
    assert.ok(firstHub && h.ui.tagGroupEditor);

    await close(h);
    assert.equal(h.panel(), null, 'panel removed');
    assert.equal(first.disconnected, true, 'observer disconnected');
    assert.equal(h.ui.mediaTagsHub, null, 'no hub retained after close');
    assert.equal(h.ui.tagGroupEditor, null, 'no editor (or its rows) retained after close');
    assert.equal(h.shortcutRestores(), 1, 'keyboard shortcuts restored');
    first.fire();
    assert.equal(h.document.querySelector('.je-mtp-card'), null, 'a late observer callback builds nothing');

    // Open again: a fresh hub whose preview builds once it is on screen and follows edits.
    const second = await h.open();
    assert.notEqual(second, first);
    assert.notEqual(h.ui.mediaTagsHub, firstHub);
    second.fire();
    assert.equal(second.disconnected, true, 'the observer is released once the preview is built');
    assert.equal(h.panel().querySelectorAll('.je-mtp-card .je-tag-host').length, 3, 'three samples are drawn');
    h.panel().querySelector('.je-tge-row[data-group="quality"] [data-slot="br"]').click();
    await h.settle();
    assert.equal(JSON.parse(h.writes.at(-1).data).qualityTagsPosition, 'bottom-right');
    assert.ok(h.panel().querySelector('.je-mtp-sample[data-sample="movie"] .je-tag-slot[data-je-slot="br"] .quality-overlay-container'), 'the preview follows the edit');
  });
}

test('preview work queued just before the panel closes is dropped', async t => {
  const h = setup(t);
  const io = await h.open();
  io.fire();
  const card = h.panel().querySelector('.je-mtp-card');
  assert.ok(card);
  // A pill click queues a preview refresh for the next microtask; close first.
  h.panel().querySelector('.je-tge-row[data-group="rating"] [data-slot="tl"]').click();
  h.document.getElementById('closeSettingsPanel').click();
  await h.settle();
  assert.equal(card.isConnected, false);
  assert.equal(card.querySelector('.je-tag-host .je-tag-slot'), null, 'the dropped preview was cleared, not re-drawn');
  assert.equal(h.ui.mediaTagsHub, null);
  assert.equal(h.ui.tagGroupEditor, null);
});

test('wiring the hub or the editor again disposes the previous one even without a panel close', async t => {
  const h = setup(t);
  const io = await h.open();
  const oldHub = h.ui.mediaTagsHub;
  const oldEditor = h.ui.tagGroupEditor;
  h.ui.wireMediaTagsHub({ resetAutoCloseTimer() {} });
  assert.equal(io.disconnected, true);
  assert.notEqual(h.ui.mediaTagsHub, oldHub);
  h.ui.wireTagGroupEditor({ resetAutoCloseTimer() {} });
  assert.notEqual(h.ui.tagGroupEditor, oldEditor);
});
