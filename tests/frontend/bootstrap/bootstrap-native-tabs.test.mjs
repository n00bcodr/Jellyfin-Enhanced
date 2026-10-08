import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';

async function until(fn) {
  const deadline = performance.now() + 3000;
  while (!fn() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(fn(), 'native tab reconciliation did not finish');
}
const home = `<div class="page" id="home"><div class="tabContent pageTabContent is-active" data-index="0"></div><div class="tabContent pageTabContent" data-index="1"></div></div>`;
function setup(t, { count = 0, hash = '#/home', configRequest } = {}) {
  const h = createHarness({ url: `http://jellyfin.test/web/index.html${hash}`, html: `<div is="emby-tabs"><div class="emby-tabs-slider"><button class="emby-tab-button emby-tab-button-active" data-index="0"></button><button class="emby-tab-button" data-index="1"></button></div></div>${home}`,
    JE: { pluginConfig: {}, hasCustomTabs: count > 0 || !!configRequest }, apiClient: { fetch: configRequest || (async () => Array(count).fill({})) } });
  t.after(() => h.close());
  Object.defineProperty(h.window.HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return this.parentElement; } });
  for (const file of ['core/navigation.js', 'core/lifecycle.js', 'core/dom-observer.js', 'core/ui-kit.js', 'enhanced/helpers.js', 'enhanced/native-tabs.js']) h.load(file);
  const tabs = h.document.querySelector('[is="emby-tabs"]');
  let refreshes = 0, selections = 0;
  tabs.refresh = () => refreshes++;
  tabs.selectedTabIndex = 0;
  tabs.selectedIndex = function(index) {
    if (index === undefined) return this.selectedTabIndex;
    selections++;
    this.dispatchEvent(new h.window.CustomEvent('beforetabchange', { detail: { selectedTabIndex: index } }));
    this.selectedTabIndex = index;
    h.document.querySelectorAll('.emby-tab-button')[index]?.classList.add('emby-tab-button-active');
    h.document.querySelector('#home').querySelectorAll('.tabContent')[index]?.classList.add('is-active');
  };
  const mountCounts = {};
  function register(id = 'requests') {
    h.JE.nativeTabs.register(id, `<${id}>`, panel => { mountCounts[id] = (mountCounts[id] || 0) + 1; panel.textContent = 'Mounted ' + id; });
  }
  const panel = (id = 'requests') => h.document.getElementById(`je-native-tab-panel-${id}`);
  const button = (id = 'requests') => h.document.getElementById(`je-native-tab-btn-${id}`);
  const reconcile = () => h.window.history.replaceState({}, '', h.window.location.href);
  return { ...h, tabs, register, panel, button, mountCounts, reconcile, get refreshes() { return refreshes; }, get selections() { return selections; } };
}

function assertAligned(h) {
  for (const selector of ['.emby-tabs-slider .emby-tab-button', '#home > .tabContent']) {
    const nodes = [...h.document.querySelectorAll(selector)];
    assert.deepEqual(nodes.map(node => Number(node.dataset.index)), nodes.map((_, index) => index));
  }
}

test('native tabs mount once, escape labels, and remain stable across duplicate registration and mutations', async t => {
  const h = setup(t); h.register(); h.register();
  await until(() => h.panel());
  const panel = h.panel(); const button = h.button();
  assert.equal(button.textContent, '<requests>'); assert.equal(button.querySelector('requests'), null);
  h.register(); panel.appendChild(h.document.createElement('span'));
  h.document.dispatchEvent(new h.window.CustomEvent('viewshow'));
  await until(() => h.refreshes === 1);
  assert.equal(h.panel(), panel); assert.equal(h.button(), button);
  assert.equal(h.mountCounts.requests, 1); assertAligned(h);
});

test('Custom Tabs count reserves positional slots before JE tabs', async t => {
  const h = setup(t, { count: 3 }); h.register(); h.register('calendar');
  await until(() => h.panel('calendar'));
  assert.equal(h.button().dataset.index, '5'); assert.equal(h.panel('calendar').dataset.index, '6');
  assert.equal(h.document.querySelectorAll('[id^="je-native-tab-reserved-btn-"]').length, 3);
  assertAligned(h);
});

test('late Custom Tabs DOM collision moves existing JE panels without remounting or losing content', async t => {
  const h = setup(t); h.register(); await until(() => h.panel());
  const original = h.panel();
  const foreignButton = h.document.createElement('button'); foreignButton.className = 'emby-tab-button'; foreignButton.dataset.index = '2';
  h.document.querySelector('.emby-tabs-slider').appendChild(foreignButton);
  const foreignPanel = h.document.createElement('div'); foreignPanel.className = 'tabContent pageTabContent'; foreignPanel.dataset.index = '2';
  h.document.querySelector('#home').appendChild(foreignPanel);
  await until(() => h.button().dataset.index === '3');
  assert.equal(h.panel(), original); assert.equal(h.mountCounts.requests, 1); assertAligned(h);
});

test('header-only external tab claims get placeholders to preserve positional selection', async t => {
  const h = setup(t); const external = h.document.createElement('a'); external.href = '#/home?tab=4'; h.document.body.appendChild(external);
  h.register(); await until(() => h.panel());
  assert.equal(h.button().dataset.index, '5'); assertAligned(h);
});

test('stable JE deep link rewrites stale index and clears partially selected host panels', async t => {
  const h = setup(t, { count: 2, hash: '#/home?tab=2&jeTab=requests' }); h.register();
  await until(() => h.panel()?.classList.contains('is-active'));
  assert.equal(h.window.location.hash, '#/home?tab=4&jeTab=requests');
  assert.equal(h.tabs.selectedIndex(), 4);
  assert.equal(h.document.querySelectorAll('.tabContent.is-active').length, 1);
  assert.equal(h.document.querySelectorAll('.emby-tab-button-active').length, 1);
});

test('user selection consumes deep link so later mutations do not steal the chosen tab', async t => {
  const h = setup(t, { hash: '#/home?tab=2&jeTab=requests' }); h.register();
  await until(() => h.panel()?.classList.contains('is-active'));
  h.tabs.selectedIndex(1);
  h.panel().appendChild(h.document.createElement('span'));
  await until(() => h.tabs.selectedIndex() === 1);
  // Let the actual DOM observer and after-paint reconciliation complete.
  await new Promise(resolve => h.JE.core.dom.afterNextPaint(() => h.JE.core.dom.afterNextPaint(resolve)));
  assert.equal(h.tabs.selectedIndex(), 1); assert.equal(h.selections, 2);
});

test('unregister removes button, panel and allows a clean future mount', async t => {
  const h = setup(t); h.register(); await until(() => h.panel());
  h.JE.nativeTabs.unregister('requests');
  assert.equal(h.panel(), null); assert.equal(h.button(), null);
  h.register(); await until(() => h.panel());
  assert.equal(h.mountCounts.requests, 2); assertAligned(h);
});

test('unknown Custom Tabs state waits for response and recovers from provider failure', async t => {
  const response = deferred(); const h = setup(t, { configRequest: () => response.promise }); h.register();
  await new Promise(resolve => h.JE.core.dom.afterNextPaint(() => h.JE.core.dom.afterNextPaint(resolve)));
  assert.equal(h.panel(), null);
  response.reject(new Error('plugin unavailable'));
  await until(() => h.panel()); assert.equal(h.button().dataset.index, '2'); assertAligned(h);
});
