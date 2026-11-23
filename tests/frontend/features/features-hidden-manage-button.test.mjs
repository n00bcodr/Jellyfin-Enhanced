import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// The settings panel's "Manage Hidden Content" button closes the panel and opens the Hidden Content page.
// Placed as a native Home tab, a Custom Tabs tab or a Plugin Page, that page never opens over the current
// view, so the button opens the management dialog instead.
const pageModules = ['state', 'styles', 'admin', 'cards', 'render', 'nav', 'init'].map(name => `enhanced/hiddencontent/hidden-content-page-${name}.js`);

function setup(t, config, { pluginPagesLink = false } = {}) {
  const calls = [];
  const h = createHarness({
    html: `${pluginPagesLink ? '<div class="mainDrawer-scrollContainer"><a is="emby-linkbutton" data-itemid="Jellyfin.Plugin.JellyfinEnhanced.HiddenContentPage"></a></div>' : ''}<div class="mainAnimatedPage page" id="home"></div><button id="manageHiddenContentBtn"></button>`,
    JE: { pluginConfig: { HiddenContentEnabled: true, ...config }, t: key => key,
      hiddenContent: { showManagementPanel: () => calls.push('panel') } } });
  t.after(() => h.close());
  for (const file of [...pageModules, 'enhanced/settingspanel/ui-panel-hidden-content.js']) h.load(file);
  // The page's contents are not under test here.
  h.JE.internals.hiddenContentPage.renderPage = () => calls.push('page');
  h.JE.internals.enhancedUi.wireHiddenContentListeners({ resetAutoCloseTimer() {}, closePanel: () => calls.push('close') });
  h.document.getElementById('manageHiddenContentBtn').click();
  return { ...h, calls };
}

for (const [label, config, options] of [
  ['a native Home tab', { HiddenContentUseNativeTab: true }],
  ['a Custom Tabs tab', { HiddenContentUseCustomTabs: true }],
  ['a Plugin Page', { HiddenContentUsePluginPages: true }, { pluginPagesLink: true }],
]) test(`Manage Hidden Content opens the management dialog when the page is ${label}`, t => {
  const h = setup(t, config, options);
  assert.deepEqual(h.calls, ['close', 'panel']);
  assert.equal(h.document.getElementById('je-hidden-content-page'), null);
});

for (const [label, config] of [
  ['no placement is set', {}],
  ['Plugin Pages is chosen but not installed', { HiddenContentUsePluginPages: true }],
]) test(`Manage Hidden Content opens the page when ${label}`, t => {
  const h = setup(t, config);
  assert.deepEqual(h.calls, ['close', 'page']);
  assert.equal(h.document.getElementById('je-hidden-content-page').classList.contains('hide'), false);
});

test('Manage Hidden Content opens the management dialog when Hidden Content is off server-wide', t => {
  const h = setup(t, { HiddenContentEnabled: false });
  assert.deepEqual(h.calls, ['close', 'panel']);
});
