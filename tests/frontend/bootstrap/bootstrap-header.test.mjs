import { clickAsViewer } from '../helpers/harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

async function until(fn) {
  const deadline = performance.now() + 3000;
  while (!fn() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(fn(), 'header update did not finish');
}
function header(t, width = 170) {
  let reset, signedIn = true;
  const h = createHarness({ html: '<div class="headerTop"><div class="headerRight"><button class="headerButton" id="foreign">Other plugin</button></div></div>',
    JE: { t: key => key, session: { getUserId: () => signedIn ? 'user' : null, onUserChange: (_, callback) => { reset = callback; } }, helpers: {} },
    globals: { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } } });
  t.after(() => h.close());
  h.JE.helpers = { getHeaderRightContainer: () => h.document.querySelector('.headerRight'), onBodyMutation() {},
    addCSS(id, css) { const style = h.document.createElement('style'); style.id = id; style.textContent = css; h.document.head.appendChild(style); } };
  Object.defineProperty(h.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.classList.contains('headerTop') ? width : 40; } });
  h.window.HTMLElement.prototype.getClientRects = function() { return [this.getBoundingClientRect()]; };
  h.window.HTMLElement.prototype.getBoundingClientRect = function() { return { left: 0, right: 40, top: 0, bottom: 40, width: 40, height: 40 }; };
  h.window.HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); };
  h.window.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); };
  h.load('enhanced/header-actions.js');
  const tray = h.JE.headerActions.getTray();
  for (const id of ['randomItemButton', 'calendar', 'requests', 'bookmarks']) {
    const button = h.document.createElement('button'); button.id = id; button.className = 'headerButton'; button.title = `<${id}>`;
    button.innerHTML = `<span id="${id}-icon" class="material-icons">event</span>`; tray.appendChild(button);
  }
  return { ...h, get NATIVE() { return h.NATIVE; }, tray, resize(next) { width = next; h.window.dispatchEvent(new h.window.Event('resize')); }, logout() { signedIn = false; reset(); }, login() { signedIn = true; } };
}
function muiHeader(t, contents = '<div class="MuiBox-root" id="native"><button>SyncPlay</button><a>Search</a></div>') {
  let reset, userId = 'user';
  const h = createHarness({ html: `<div class="MuiAppBar-root"><div class="MuiToolbar-root"><button aria-label="Open Menu"></button>${contents}</div></div>`,
    JE: { t: key => key, session: { getUserId: () => userId, onUserChange: (name, callback) => { if (name === 'header-actions') reset = callback; } } },
    globals: { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } } });
  t.after(() => h.close());
  Object.defineProperty(h.window.HTMLElement.prototype, 'offsetParent', { configurable: true, get() { return this.parentElement; } });
  for (const file of ['core/dom-observer.js', 'core/ui-kit.js', 'enhanced/helpers.js', 'enhanced/header-actions.js']) h.load(file);
  const tray = h.JE.headerActions.getTray();
  const toolbar = h.document.querySelector('.MuiToolbar-root');
  const flush = () => new Promise(resolve => h.JE.core.dom.afterNextPaint(() => h.JE.core.dom.afterNextPaint(resolve)));
  return { ...h, tray, toolbar, flush, switchUser() { userId = 'next-user'; reset(); } };
}

test('narrow header preserves foreign plugin buttons and forwards overflow actions to mounted originals', async t => {
  const h = header(t, 130);
  await until(() => h.document.querySelector('[data-je-header-action="requests"]'));
  const original = h.document.getElementById('requests'); let clicks = 0; original.addEventListener('click', () => clicks++);
  const mirror = h.document.querySelector('[data-je-header-action="requests"]');
  assert.equal(mirror.querySelector('[id]'), null);
  assert.equal(mirror.querySelector('.je-launcher-label').textContent, '<requests>');
  assert.equal(mirror.querySelector('requests'), null);
  clickAsViewer(mirror); assert.equal(clicks, 1); assert.equal(h.document.getElementById('requests'), original);
  const foreign = h.document.getElementById('foreign');
  assert.equal(foreign.parentElement.className.includes('headerRight'), true);
  assert.equal(foreign.hasAttribute('aria-hidden'), false);
  assert.equal(h.document.querySelector('[data-je-header-action="foreign"]'), null);
  assert.equal(h.document.getElementById('randomItemButton').classList.contains('je-header-overflowed'), false);
});

test('expanding header restores original actions and clears obsolete mirrors without duplicate trays', async t => {
  const h = header(t, 130); await until(() => h.document.querySelector('.je-launcher-action'));
  assert.equal(h.JE.headerActions.getTray(), h.tray);
  h.resize(1000);
  await until(() => h.document.querySelectorAll('.je-launcher-action').length === 0);
  assert.equal(h.document.querySelectorAll('#je-header-buttons-group').length, 1);
  assert.equal(h.tray.querySelectorAll('.je-header-overflowed').length, 0);
  assert.equal(h.document.getElementById('je-header-launcher').style.display, 'none');
});

test('identity reset discards previous user actions and signed-out tray access', async t => {
  const h = header(t, 130); await until(() => h.document.querySelector('.je-launcher-action'));
  h.logout();
  assert.equal(h.JE.headerActions.getTray(), null);
  assert.equal(h.document.getElementById('requests'), null);
  assert.equal(h.document.querySelector('.je-launcher-action'), null);
  assert.ok(h.document.getElementById('foreign'));
  // The next user reuses the tray element: it must come back holding only the launcher.
  h.login();
  const next = h.JE.headerActions.getTray();
  assert.equal(next, h.tray);
  for (const id of ['randomItemButton', 'calendar', 'requests', 'bookmarks']) assert.equal(next.querySelector(`#${id}`), null, id);
  assert.deepEqual([...next.children].map(child => child.id), ['je-header-launcher']);
});

test('MUI header moves the fallback tray before native buttons when the user menu mounts late', async t => {
  const h = muiHeader(t);
  const { tray, toolbar, flush } = h;
  const fallback = toolbar.querySelector('.headerRight');
  assert.ok(tray); assert.ok(fallback);
  assert.equal(tray.parentElement, fallback);
  assert.equal(toolbar.lastElementChild, fallback);
  await flush();
  toolbar.insertAdjacentHTML('beforeend', '<div><button aria-controls="app-user-menu"></button></div>');
  await flush();
  assert.equal(h.document.getElementById('native').firstElementChild, tray);
  assert.equal(h.document.querySelector('[data-je-header-fallback]'), null);
});

test('MUI header moves all JE header buttons together when the user menu mounts late', async t => {
  const h = muiHeader(t);
  const fallback = h.tray.parentElement;
  assert.equal(fallback, h.toolbar.querySelector('.headerRight'));
  h.tray.insertAdjacentHTML('beforeend', '<div id="randomItemButtonContainer"><button id="randomItemButton" class="headerButton">Random</button></div><button id="je-active-streams" class="headerButton">Active streams</button><div id="je-native-tabs-group"><button id="je-native-tab-link-calendar" class="headerButton">Calendar tab</button><span id="je-native-tabs-separator" aria-hidden="true"></span></div>');
  for (const id of ['calendar', 'requests', 'bookmarks']) {
    const button = h.document.createElement('button'); button.id = id; button.className = 'headerButton'; h.tray.appendChild(button);
  }
  const actions = [...h.tray.querySelectorAll('.headerButton')];
  const groups = ['randomItemButtonContainer', 'je-native-tabs-group'].map(id => h.document.getElementById(id));
  for (const element of [...actions, ...groups]) assert.ok(fallback.contains(element), element.id);
  await h.flush();
  h.toolbar.insertAdjacentHTML('beforeend', '<div><button aria-controls="app-user-menu"></button></div>');
  await h.flush();
  const native = h.document.getElementById('native');
  assert.equal(native.firstElementChild, h.tray);
  for (const element of [...actions, ...groups]) {
    assert.ok(h.tray.contains(element), element.id);
    assert.ok(native.contains(element), element.id);
    assert.equal(element.closest('.headerRight, [data-je-header-fallback]'), null, element.id);
  }
  assert.equal(fallback.isConnected, false);
  assert.equal(h.document.querySelector('[data-je-header-fallback]'), null);
});

test('MUI header moves the fallback tray before native buttons when the native box mounts late', async t => {
  const h = muiHeader(t, '<div id="user-menu"><button aria-controls="app-user-menu"></button></div>');
  const userMenu = h.document.getElementById('user-menu');
  const fallback = h.toolbar.querySelector('.headerRight');
  assert.equal(h.tray.parentElement, fallback);
  assert.equal(fallback.nextElementSibling, userMenu);
  await h.flush();
  userMenu.insertAdjacentHTML('beforebegin', '<div class="MuiBox-root" id="native"><button>SyncPlay</button><a>Search</a></div>');
  await h.flush();
  assert.equal(h.document.getElementById('native').firstElementChild, h.tray);
  assert.equal(fallback.isConnected, false);
  assert.equal(h.document.querySelector('.headerRight, [data-je-header-fallback]'), null);
});

test('MUI header removes the empty fallback after a user switch and late user menu mount', async t => {
  const h = muiHeader(t);
  const fallback = h.toolbar.querySelector('.headerRight');
  assert.equal(h.tray.parentElement, fallback);
  await h.flush();
  h.switchUser();
  assert.equal(h.tray.isConnected, false);
  assert.equal(fallback.isConnected, true);
  assert.equal(fallback.children.length, 0);
  h.toolbar.insertAdjacentHTML('beforeend', '<div><button aria-controls="app-user-menu"></button></div>');
  const next = h.JE.headerActions.getTray();
  await h.flush();
  assert.equal(next, h.tray);
  assert.equal(h.document.getElementById('native').firstElementChild, next);
  assert.equal(fallback.isConnected, false);
  assert.equal(h.document.querySelector('[data-je-header-fallback]'), null);
});

test('MUI header keeps a stable fallback between a foreign button and the user menu', async t => {
  const h = muiHeader(t, '<div class="MuiBox-root" id="native"><button>SyncPlay</button><a>Search</a></div><button id="foreign">Moonfin</button><div id="user-menu"><button aria-controls="app-user-menu"></button></div>');
  const native = h.document.getElementById('native');
  const foreign = h.document.getElementById('foreign');
  const userMenu = h.document.getElementById('user-menu');
  const fallback = h.toolbar.querySelector('.headerRight');
  for (let frame = 0; frame < 2; frame++) {
    await h.flush();
    assert.equal(h.tray.parentElement, fallback);
    assert.equal(fallback.parentElement, h.toolbar);
    assert.equal(fallback.previousElementSibling, foreign);
    assert.equal(fallback.nextElementSibling, userMenu);
    assert.equal(foreign.previousElementSibling, native);
    assert.equal(foreign.contains(h.tray), false);
    assert.equal(native.contains(h.tray), false);
    assert.equal(h.JE.headerActions.getTray(), h.tray);
  }
});

test('injected icon stylesheet keeps public full fonts distinct from JE subsets and respects theme classes', t => {
  const h = createHarness({ html: '<i id="foreign" class="material-symbols-rounded">public_icon</i><div class="mediaInfoItem-fileSize"><i id="own" class="material-icons">storage</i></div>',
    JE: { cdn: { font: name => `/JellyfinEnhanced/fonts/${name}` } } });
  t.after(() => h.close()); h.load('enhanced/ui-styles.js'); h.JE.injectGlobalStyles(); h.JE.injectGlobalStyles();
  assert.equal(h.document.querySelectorAll('#jellyfin-enhanced-styles').length, 1);
  assert.equal(h.window.getComputedStyle(h.document.getElementById('foreign')).fontFamily, '"Material Symbols Rounded"');
  assert.equal(h.window.getComputedStyle(h.document.getElementById('own')).fontFamily, '"JE Material Symbols Rounded"');
  const faces = [...h.document.getElementById('jellyfin-enhanced-styles').sheet.cssRules].filter(rule => rule.type === 5);
  for (const face of faces) {
    const family = face.style.getPropertyValue('font-family');
    const src = face.style.getPropertyValue('src');
    assert.equal(src.includes('-subset.woff2'), family.includes('JE Material'));
  }
  assert.equal(faces.length, 4);
  const theme = h.document.createElement('style'); theme.textContent = '.material-symbols-rounded { font-family: ThemeIcons; }'; h.document.head.appendChild(theme);
  assert.equal(h.window.getComputedStyle(h.document.getElementById('foreign')).fontFamily, 'ThemeIcons');
  assert.equal(h.window.getComputedStyle(h.document.getElementById('own')).fontFamily, '"JE Material Symbols Rounded"');
});

// Model a MUI row whose native/custom actions leave less room than More needs.
function crowdedMuiHeader(t, width = 330) {
  const h = muiHeader(t, '<div class="MuiBox-root" id="native"><button title="SyncPlay">SyncPlay</button><button title="Cast">Cast</button><a href="#extra-b" title="Extra B">B</a><a href="#search" title="Search">Search</a><a href="#" title="Appearance" aria-haspopup="dialog">Appearance</a><a href="#extra-a" title="Extra A">A</a></div><div><button aria-controls="app-user-menu"></button></div>');
  Object.defineProperty(h.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this === h.toolbar ? width : 40; } });
  h.window.HTMLElement.prototype.getClientRects = function() { return [this.getBoundingClientRect()]; };
  h.window.HTMLElement.prototype.getBoundingClientRect = function() {
    const size = this === h.toolbar ? width : this.id === 'native' ? width - 80 : 40;
    return { left: 0, right: size, top: 0, bottom: 40, width: size, height: 40 };
  };
  for (const id of ['randomItemButton', 'calendar', 'requests', 'bookmarks']) {
    const button = h.document.createElement('button'); button.id = id; button.className = 'headerButton'; button.title = id;
    h.tray.appendChild(button);
  }
  return { ...h, resize(next) { width = next; h.window.dispatchEvent(new h.window.Event('resize')); } };
}

test('crowded MUI header shares More with native actions while preserving their originals and handlers', async t => {
  const h = crowdedMuiHeader(t);
  const original = h.document.querySelector('[href="#extra-a"]');
  let clicks = 0; original.addEventListener('click', event => { event.preventDefault(); clicks++; });
  await until(() => original.classList.contains('je-header-overflowed'));
  const mirror = [...h.document.querySelectorAll('.je-launcher-action')].find(button => button.querySelector('.je-launcher-label').textContent === 'Extra A');
  assert.ok(mirror);
  clickAsViewer(mirror);
  assert.equal(clicks, 1);
  assert.equal(original.parentElement.id, 'native');
  assert.equal(original.getAttribute('aria-hidden'), 'true');
  assert.equal(h.document.querySelector('[title="Appearance"]').classList.contains('je-header-overflowed'), false);
  assert.equal(h.document.querySelector('[aria-label="Open Menu"]').hasAttribute('aria-hidden'), false);
  assert.equal(h.document.querySelector('[aria-controls="app-user-menu"]').hasAttribute('aria-hidden'), false);
});

test('crowded MUI header restores native actions on expansion and can overflow them again', async t => {
  const h = crowdedMuiHeader(t);
  const original = h.document.querySelector('[href="#extra-a"]');
  await until(() => original.classList.contains('je-header-overflowed'));
  h.resize(1000);
  await until(() => !original.classList.contains('je-header-overflowed'));
  assert.equal(original.hasAttribute('aria-hidden'), false);
  assert.equal(h.document.querySelectorAll('.je-launcher-action').length, 0);
  h.resize(330);
  await until(() => original.classList.contains('je-header-overflowed'));
  assert.equal(h.document.querySelector('[href="#extra-a"]'), original);
  assert.equal(h.document.querySelectorAll('#je-header-buttons-group').length, 1);
});

test('user switch restores native actions borrowed by the previous header overflow', async t => {
  const h = crowdedMuiHeader(t);
  const original = h.document.querySelector('[href="#extra-a"]');
  await until(() => original.classList.contains('je-header-overflowed'));
  h.switchUser();
  assert.equal(original.classList.contains('je-header-overflowed'), false);
  assert.equal(original.hasAttribute('aria-hidden'), false);
  assert.equal(original.parentElement.id, 'native');
});

test('crowded MUI header includes native spacing when allocating inline actions', async t => {
  const h = crowdedMuiHeader(t);
  h.document.getElementById('native').style.columnGap = '8px';
  const original = h.document.querySelector('[href="#extra-a"]');
  await until(() => original.classList.contains('je-header-overflowed'));
  assert.equal(h.document.querySelector('[title="Appearance"]').classList.contains('je-header-overflowed'), false);
  assert.equal(h.document.querySelector('[href="#search"]').classList.contains('je-header-overflowed'), true);
});

test('crowded MUI header keeps the notification bell reachable in More under its own name, opening its inbox', async t => {
  const h = crowdedMuiHeader(t);
  const bell = h.document.createElement('button');
  bell.id = 'je-notify-bell'; bell.className = 'headerButton headerButtonRight je-notify-bell';
  bell.setAttribute('aria-haspopup', 'dialog'); bell.title = '3 unread notifications'; bell.dataset.headerLabel = 'Notifications';
  let opened = 0; bell.addEventListener('click', () => opened++);
  h.tray.insertBefore(bell, h.tray.firstChild);
  const original = h.document.querySelector('[href="#extra-a"]');
  await until(() => original.classList.contains('je-header-overflowed'));
  const mirror = [...h.document.querySelectorAll('.je-launcher-action')].find(button => button.querySelector('.je-launcher-label').textContent === 'Notifications');
  // At this width the bell goes into More with the other JE buttons, under its own name.
  assert.ok(bell.classList.contains('je-header-overflowed'));
  assert.ok(mirror, 'the overflowed bell is offered in More');
  clickAsViewer(mirror);
  assert.equal(opened, 1);
  assert.equal(bell.parentElement, h.tray, 'the bell stays in JE\'s tray');
});
