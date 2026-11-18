import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';

async function until(fn) {
  const deadline = performance.now() + 3000;
  while (!fn() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(fn(), 'native tab reconciliation did not finish');
}
const home = `<div class="page" id="home"><div class="tabContent pageTabContent is-active" data-index="0"></div><div class="tabContent pageTabContent" data-index="1"></div></div>`;
function setup(t, { count = 0, hash = '#/home', configRequest, appBack, canGoBack = false } = {}) {
  const h = createHarness({ url: `http://jellyfin.test/web/index.html${hash}`, html: `<div is="emby-tabs"><div class="emby-tabs-slider"><button class="emby-tab-button emby-tab-button-active" data-index="0"></button><button class="emby-tab-button" data-index="1"></button></div></div>${home}`,
    JE: { pluginConfig: {}, hasCustomTabs: count > 0 || !!configRequest }, apiClient: { fetch: configRequest || (async () => Array(count).fill({})) } });
  t.after(() => h.close());
  Object.defineProperty(h.window.HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return this.parentElement; } });
  // The Android app's shell: Back calls NavigationHelper.goBack(), which exits when the router cannot go back.
  if (appBack) { h.window.NavigationHelper = { goBack: appBack }; h.window.Emby = { Page: { canGoBack: () => canGoBack } }; }
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

/** Two after-paint turns: the DOM observer and the after-paint reconciliation have run. */
const settled = h => new Promise(resolve => h.JE.core.dom.afterNextPaint(() => h.JE.core.dom.afterNextPaint(resolve)));

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

// JE tabs mount at once from the live tabs and are relabelled when the Custom Tabs count arrives
// (native-tabs.ts: a hung optional request must never block JE's own navigation).
test('Custom Tabs count reserves positional slots before JE tabs', async t => {
  const h = setup(t, { count: 3 }); h.register(); h.register('calendar');
  await until(() => h.panel('calendar') && h.button().dataset.index === '5');
  assert.equal(h.button().dataset.index, '5'); assert.equal(h.panel('calendar').dataset.index, '6');
  assert.equal(h.mountCounts.requests, 1, 'relabelled, not remounted'); assert.equal(h.mountCounts.calendar, 1);
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
  // The tab mounts at index 2 first; the late count moves it to 4 and the deep link follows it.
  await until(() => h.window.location.hash === '#/home?tab=4&jeTab=requests' && h.panel()?.classList.contains('is-active'));
  await settled(h);
  assert.equal(h.window.location.hash, '#/home?tab=4&jeTab=requests');
  assert.equal(h.tabs.selectedIndex(), 4);
  assert.equal(h.document.querySelectorAll('.tabContent.is-active').length, 1);
  assert.equal(h.document.querySelectorAll('.emby-tab-button-active').length, 1);
});

test("a stale index is corrected without the address's other pairs (a Recommendations category, its filters) being lost", async t => {
  const h = setup(t, { count: 2, hash: '#/home?tab=2&jeTab=requests&jeCategory=trending&jeType=movies' }); h.register();
  // (Here the tab mounts at index 2 first; the late count moves it to 4 and the deep link follows it, as above.)
  await until(() => h.window.location.hash.startsWith('#/home?tab=4') && h.panel()?.classList.contains('is-active'));
  await settled(h);
  assert.equal(h.window.location.hash, '#/home?tab=4&jeTab=requests&jeCategory=trending&jeType=movies');
});

test("Home with only the Recommendations filters' fragment after it (a tab reached by clicking, then reloaded) is Home: the tabs are added", async t => {
  const h = setup(t, { hash: '#/home#jeType=movies' }); h.register();
  await until(() => h.panel());
  assert.ok(h.button());
});

test("a stale index is corrected with the Recommendations filters' fragment kept after the query", async t => {
  const h = setup(t, { count: 2, hash: '#/home?tab=2&jeTab=requests#jeCategory=trending&jeType=movies' }); h.register();
  // (As above: the late count moves the tab to 4.)
  await until(() => h.window.location.hash.startsWith('#/home?tab=4') && h.panel()?.classList.contains('is-active'));
  await settled(h);
  assert.equal(h.window.location.hash, '#/home?tab=4&jeTab=requests#jeCategory=trending&jeType=movies');
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

test('unknown Custom Tabs state never blocks the JE tab and recovers from provider failure', async t => {
  const response = deferred(); const h = setup(t, { configRequest: () => response.promise }); h.register();
  // The request hangs: the tab is already there, after the live tabs.
  await until(() => h.panel());
  await settled(h);
  assert.equal(h.button().dataset.index, '2'); assertAligned(h);
  const panel = h.panel();
  response.reject(new Error('plugin unavailable'));
  await settled(h);
  assert.equal(h.panel(), panel); assert.equal(h.button().dataset.index, '2'); assertAligned(h);
  assert.equal(h.mountCounts.requests, 1);
});

test('a Custom Tabs count that arrives late relabels the mounted JE tab without remounting it', async t => {
  const response = deferred(); const h = setup(t, { configRequest: () => response.promise }); h.register();
  await until(() => h.panel());
  const panel = h.panel();
  assert.equal(h.button().dataset.index, '2');
  response.resolve([{}, {}, {}]);
  await until(() => h.button().dataset.index === '5');
  assert.equal(h.panel(), panel); assert.equal(panel.dataset.index, '5'); assert.equal(h.mountCounts.requests, 1);
  assert.equal(h.document.querySelectorAll('[id^="je-native-tab-reserved-btn-"]').length, 3);
  assertAligned(h);
});

// Upstream c165a07b: header scripts (KefinTweaks' header tabs) keep the old jeTab in the URL after the user left our tab.
for (const hash of ['#/home?jeTab=requests', '#/home?tab=1&jeTab=requests', '#/home?tab=0&jeTab=requests']) {
  test(`a jeTab left in ${hash} without our tab index is not a deep link`, async t => {
    const h = setup(t, { hash }); h.register();
    await until(() => h.panel());
    await settled(h);
    assert.equal(h.window.location.hash, hash);
    assert.equal(h.selections, 0);
    assert.equal(h.panel().classList.contains('is-active'), false);
  });
}

test("the Android app's Back on a JE tab selects the Home tab instead of exiting the app", async t => {
  let exits = 0;
  const h = setup(t, { hash: '#/home?tab=2&jeTab=requests', appBack: () => { exits++; return 'exit'; } }); h.register();
  await until(() => h.panel()?.classList.contains('is-active'));
  await settled(h);
  const home = h.document.querySelector('.emby-tab-button[data-index="0"]');
  let homeClicks = 0;
  // Jellyfin's own click handler selects the tab; the URL keeps ?tab=2 as on the real client.
  home.addEventListener('click', () => {
    homeClicks++;
    h.document.querySelectorAll('.tabContent.is-active').forEach(el => el.classList.remove('is-active'));
    h.document.querySelector('#home .tabContent[data-index="0"]').classList.add('is-active');
    h.tabs.selectedTabIndex = 0;
  });
  const selectionsBefore = h.selections;
  assert.equal(h.window.NavigationHelper.goBack(), undefined);
  assert.equal(exits, 0); assert.equal(homeClicks, 1);
  // The spent deep link is not followed again by later reconciliations.
  h.panel().appendChild(h.document.createElement('span'));
  await settled(h);
  assert.equal(h.selections, selectionsBefore);
  assert.equal(h.panel().classList.contains('is-active'), false);
  // On Jellyfin's own Home tab the app's Back is untouched.
  assert.equal(h.window.NavigationHelper.goBack(), 'exit');
  assert.equal(exits, 1); assert.equal(homeClicks, 1);
});

test("the Android app's Back closes an open category page or More Info modal through history, and is left alone when the router can go back", async t => {
  let exits = 0;
  const h = setup(t, { appBack: () => { exits++; } }); h.register();
  await until(() => h.panel());
  let backs = 0;
  h.window.history.back = () => { backs++; };
  const category = h.document.createElement('div');
  category.id = 'je-recommendations-category-page'; category.className = 'hide';
  h.document.body.appendChild(category);
  h.window.NavigationHelper.goBack();
  assert.deepEqual([backs, exits], [0, 1], 'a hidden category page is not an overlay');
  category.classList.remove('hide');
  h.window.NavigationHelper.goBack();
  assert.deepEqual([backs, exits], [1, 1]);
  category.remove();
  const modal = h.document.createElement('div');
  modal.className = 'je-more-info-modal';
  h.document.body.appendChild(modal);
  h.window.NavigationHelper.goBack();
  assert.deepEqual([backs, exits], [2, 1]);
});

test("the Android app's Back goes through the router when it can go back, even on a JE tab", async t => {
  let backs = 0;
  const h = setup(t, { hash: '#/home?tab=2&jeTab=requests', appBack: () => { backs++; }, canGoBack: true }); h.register();
  await until(() => h.panel()?.classList.contains('is-active'));
  let homeClicks = 0;
  h.document.querySelector('.emby-tab-button[data-index="0"]').addEventListener('click', () => homeClicks++);
  h.window.NavigationHelper.goBack();
  assert.deepEqual([backs, homeClicks], [1, 0]);
});

test('the app Back wrapper finds a NavigationHelper that the app defines after the page scripts', async t => {
  const h = setup(t, { hash: '#/home?tab=2&jeTab=requests' }); h.register();
  await until(() => h.panel()?.classList.contains('is-active'));
  let exits = 0;
  const original = () => { exits++; };
  h.window.NavigationHelper = { goBack: original };
  h.window.Emby = { Page: { canGoBack: () => false } };
  await until(() => h.window.NavigationHelper.goBack !== original);
  let homeClicks = 0;
  h.document.querySelector('.emby-tab-button[data-index="0"]').addEventListener('click', () => homeClicks++);
  h.window.NavigationHelper.goBack();
  assert.deepEqual([exits, homeClicks], [0, 1]);
});

for (const fragment of ['', '#jeType=movies']) {
  test(`a tab the user picked stays picked when a jellyfin-web dialog opens over it (the deep link${fragment ? " with the filters' fragment" : ''})`, async t => {
    const link = '#/home?tab=2&jeTab=requests';
    const h = setup(t, { hash: link + fragment }); h.register();
    await until(() => h.panel()?.classList.contains('is-active'));
    const paints = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => h.JE.core.dom.afterNextPaint(resolve)); };
    await paints();
    // The user clicks Home (tab 0): the address stays as it was.
    h.tabs.selectedIndex(0);
    await paints();
    assert.equal(h.tabs.selectedIndex(), 0);
    // dialogHelper: an entry at the router's address (no fragment), the open dialogs in the router's state, and its DOM.
    h.window.history.pushState({ usr: { dialogs: ['dlg1'] }, key: 'k1', idx: 1 }, '', `http://jellyfin.test/web/index.html${link}`);
    const dialog = h.document.createElement('div');
    dialog.className = 'dialogContainer';
    h.document.body.appendChild(dialog);
    await paints();
    assert.equal(h.tabs.selectedIndex(), 0, 'still on the tab the user picked');
    // Closed by Back, then Forward onto its entry left behind (no dialog open): still the picked tab.
    dialog.remove();
    h.window.history.back();
    await until(() => !h.window.history.state?.usr);
    h.window.history.forward();
    await until(() => h.window.history.state?.usr?.dialogs);
    await paints();
    assert.equal(h.tabs.selectedIndex(), 0, 'still on the tab the user picked after Forward');
    assert.equal(h.window.location.hash, link + fragment);
    // A second dialog opened on that entry and closed.
    h.window.history.pushState({ usr: { dialogs: ['dlg1', 'dlg2'] }, key: 'k2', idx: 2 }, '', `http://jellyfin.test/web/index.html${link}`);
    h.document.body.appendChild(dialog);
    await paints();
    dialog.remove();
    h.window.history.back();
    await until(() => h.window.history.state?.key === 'k1');
    await paints();
    assert.equal(h.tabs.selectedIndex(), 0, 'still on the tab the user picked after a second dialog');
  });
}

