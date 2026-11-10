// Native Home tabs and the adaptive header tray: identity-scoped caches and lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';
import { chromeJs, until } from './helpers.mjs';

const strip = '<div is="emby-tabs"><div class="emby-tabs-slider"><button class="emby-tab-button emby-tab-button-active" data-index="0"></button><button class="emby-tab-button" data-index="1"></button></div></div>';
const homePage = '<div class="page" id="indexPage"><div class="tabContent pageTabContent is-active" data-index="0"></div><div class="tabContent pageTabContent" data-index="1"></div></div>';

function tabs(t, { hash = '#/home', configs = async () => [], items } = {}) {
  let user = 'user-a', server = 'server-a';
  const requests = [], itemCalls = [];
  const h = createHarness({ url: `http://jellyfin.test/web/index.html${hash}`, JE: { pluginConfig: {} },
    html: `<div class="backgroundContainer"></div><div class="backdropContainer"></div>${strip}${homePage}`,
    apiClient: { getCurrentUserId: () => user, serverId: () => server,
      fetch: request => { requests.push(server); return configs(server, request); },
      getItems: (userId, query) => { itemCalls.push(userId); return items ? items(userId, query) : Promise.resolve({ Items: [] }); },
      getImageUrl: (id, options) => `http://jellyfin.test/Items/${id}/Images/${options.type}?tag=${options.tag}` } });
  t.after(() => h.close());
  Object.defineProperty(h.window.HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return this.parentElement; } });
  for (const file of ['core/navigation.js', 'core/lifecycle.js', 'core/dom-observer.js', 'core/ui-kit.js', 'enhanced/helpers.js']) h.load(file);
  h.load(chromeJs('enhanced/native-tabs.js'));
  const tabsEl = h.document.querySelector('[is="emby-tabs"]');
  tabsEl.refresh = () => {};
  tabsEl.selectedTabIndex = 0;
  tabsEl.selectedIndex = function(index) {
    if (index === undefined) return this.selectedTabIndex;
    this.selectedTabIndex = index;
    h.document.querySelectorAll('.emby-tab-button')[index]?.classList.add('emby-tab-button-active');
    h.document.querySelector('#indexPage').querySelectorAll('.tabContent')[index]?.classList.add('is-active');
  };
  const reconcile = () => h.window.history.replaceState({}, '', h.window.location.href);
  return { ...h, requests, itemCalls, reconcile, signIn(nextUser, nextServer = server) { user = nextUser; server = nextServer; },
    button: id => h.document.getElementById(`je-native-tab-btn-${id}`), panel: id => h.document.getElementById(`je-native-tab-panel-${id}`) };
}

// CHR-TABS-1 (Custom Tabs count): a reply for the previous server must not place the next server's tabs.
test('CHR-TABS-1 native tabs: a Custom Tabs count from the previous server is discarded after a server switch', async t => {
  const first = deferred();
  const h = tabs(t, { hasCustom: true, configs: server => server === 'server-a' ? first.promise : Promise.resolve([]) });
  h.JE.hasCustomTabs = true;
  h.JE.nativeTabs.register('requests', 'Requests', () => {});
  await until(() => h.requests.length === 1);
  h.signIn('user-b', 'server-b');
  h.document.querySelector('.emby-tabs-slider').replaceWith(Object.assign(h.document.createElement('div'), { className: 'emby-tabs-slider',
    innerHTML: '<button class="emby-tab-button emby-tab-button-active" data-index="0"></button><button class="emby-tab-button" data-index="1"></button>' }));
  h.reconcile();
  await until(() => h.requests.length === 2, 'the signed-in server is asked for its own count');
  first.resolve([{}, {}, {}]);
  await until(() => h.button('requests'));
  await new Promise(resolve => h.JE.core.dom.afterNextPaint(() => h.JE.core.dom.afterNextPaint(resolve)));
  assert.equal(h.button('requests').dataset.index, '2');
  assert.equal(h.document.querySelectorAll('[id^="je-native-tab-reserved-"]').length, 0);
});

// CHR-TABS-1 (backdrop): a random backdrop from one account's library must not decorate the next account's page.
test('CHR-TABS-1 native tabs: the borrowed backdrop is re-read for the signed-in account', async t => {
  const items = userId => Promise.resolve({ Items: [{ Id: `${userId}-movie`, BackdropImageTags: ['tag'] }] });
  const h = tabs(t, { hash: '#/home?tab=2&jeTab=requests', items });
  h.JE.nativeTabs.register('requests', 'Requests', panel => { panel.innerHTML = '<div class="jellyfinenhanced"></div>'; });
  const image = () => h.document.querySelector('.je-backdrop')?.style.backgroundImage || '';
  await until(() => image().includes('user-a-movie'), 'first account backdrop');
  h.signIn('user-b');
  h.document.querySelector('.backgroundContainer').classList.remove('withBackdrop'); // Jellyfin clears it on a tab change
  await until(() => h.itemCalls.length === 2 && image().includes('user-b-movie'), 'second account backdrop');
  assert.deepEqual(h.itemCalls, ['user-a', 'user-b']);
});

test('CHR-TABS-1 native tabs: an in-flight backdrop lookup for the previous account is not applied', async t => {
  const pending = deferred();
  const h = tabs(t, { hash: '#/home?tab=2&jeTab=requests', items: userId => userId === 'user-a' ? pending.promise : Promise.resolve({ Items: [] }) });
  h.JE.nativeTabs.register('requests', 'Requests', panel => { panel.innerHTML = '<div class="jellyfinenhanced"></div>'; });
  await until(() => h.itemCalls.length === 1);
  h.signIn('user-b');
  pending.resolve({ Items: [{ Id: 'user-a-movie', BackdropImageTags: ['tag'] }] });
  h.reconcile();
  await until(() => h.itemCalls.length === 2, 'the signed-in account is asked');
  await new Promise(resolve => h.JE.core.dom.afterNextPaint(() => h.JE.core.dom.afterNextPaint(resolve)));
  assert.equal(h.document.querySelector('.je-backdrop'), null);
  assert.equal(h.document.querySelector('.backgroundContainer').classList.contains('withBackdrop'), false);
});

test('CHR-TABS-2 native tabs: a failing tab mount is contained and later tabs still mount', async t => {
  const h = tabs(t);
  h.expectConsoleError(/"Broken" failed to mount/);
  h.JE.nativeTabs.register('broken', 'Broken', () => { throw new Error('boom'); });
  h.JE.nativeTabs.register('calendar', 'Calendar', panel => { panel.textContent = 'ok'; });
  await until(() => h.panel('calendar')?.textContent === 'ok');
  assert.equal(h.button('calendar').dataset.index, '3');
});

test('native tabs: hidden strip buttons get a header-tray deep link with the stable id', async t => {
  const h = tabs(t);
  Object.defineProperty(h.window.HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return this.classList.contains('emby-tab-button') ? null : this.parentElement; } });
  const tray = h.document.createElement('div'); h.document.body.appendChild(tray);
  h.JE.helpers.getHeaderButtonTray = () => tray;
  h.JE.nativeTabs.register('requests', 'Requests', () => {}, 'assignment');
  await until(() => h.document.getElementById('je-native-tab-link-requests'));
  const link = h.document.getElementById('je-native-tab-link-requests');
  assert.equal(link.textContent, 'assignment');
  link.click();
  assert.equal(h.window.location.hash, '#/home?tab=2&jeTab=requests');
  h.JE.nativeTabs.unregister('requests');
  assert.equal(h.document.getElementById('je-native-tabs-group'), null);
});

function header(t) {
  let reset, signedIn = true, css = 0;
  const h = createHarness({ html: '<div class="headerTop"><div class="headerRight"></div></div>',
    JE: { t: key => key, session: { getUserId: () => signedIn ? 'user' : null, onUserChange: (_, callback) => { reset = callback; } } },
    globals: { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } } });
  t.after(() => h.close());
  h.JE.helpers = { getHeaderRightContainer: () => h.document.querySelector('.headerRight'), onBodyMutation() {}, addCSS() { css++; } };
  Object.defineProperty(h.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.classList.contains('headerTop') ? 120 : 40; } });
  h.window.HTMLElement.prototype.getClientRects = function() { return [this.getBoundingClientRect()]; };
  h.window.HTMLElement.prototype.getBoundingClientRect = function() { return { left: 0, right: 40, top: 0, bottom: 40, width: 40, height: 40 }; };
  h.window.HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); this.dispatchEvent(new h.window.Event('close')); };
  h.window.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); };
  h.load(chromeJs('enhanced/header-actions.js'));
  return { ...h, css: () => css, logout() { signedIn = false; reset(); } };
}

test('header actions: the More dialog opens from the launcher, forwards to originals, and closes on a user switch', async t => {
  const h = header(t);
  const tray = h.JE.headerActions.getTray();
  assert.equal(h.JE.headerActions.getTray(), tray);
  assert.equal(h.css(), 1, 'stylesheet and global listeners are installed once');
  for (const id of ['randomItemButton', 'calendar', 'requests']) {
    const button = h.document.createElement('button'); button.id = id; button.className = 'headerButton'; button.title = id; tray.appendChild(button);
  }
  await until(() => h.document.querySelectorAll('.je-launcher-action').length > 0);
  const launcher = h.document.getElementById('je-header-launcher');
  launcher.click();
  const panel = h.document.getElementById('je-header-launcher-panel');
  assert.ok(panel.open);
  assert.equal(launcher.getAttribute('aria-expanded'), 'true');
  let opened = 0; h.document.getElementById('requests').addEventListener('click', () => opened++);
  h.document.querySelector('[data-je-header-action="requests"]').click();
  assert.equal(opened, 1);
  assert.equal(panel.open, false);
  launcher.click();
  h.logout();
  assert.equal(panel.open, false);
  assert.equal(launcher.getAttribute('aria-expanded'), 'false');
  assert.equal(h.JE.headerActions.getTray(), null);
});
