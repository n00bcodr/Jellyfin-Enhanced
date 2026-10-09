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
  return { ...h, tray, resize(next) { width = next; h.window.dispatchEvent(new h.window.Event('resize')); }, logout() { signedIn = false; reset(); }, login() { signedIn = true; } };
}

test('narrow header preserves foreign plugin buttons and forwards overflow actions to mounted originals', async t => {
  const h = header(t, 130);
  await until(() => h.document.querySelector('[data-je-header-action="requests"]'));
  const original = h.document.getElementById('requests'); let clicks = 0; original.addEventListener('click', () => clicks++);
  const mirror = h.document.querySelector('[data-je-header-action="requests"]');
  assert.equal(mirror.querySelector('[id]'), null);
  assert.equal(mirror.querySelector('.je-launcher-label').textContent, '<requests>');
  assert.equal(mirror.querySelector('requests'), null);
  mirror.click(); assert.equal(clicks, 1); assert.equal(h.document.getElementById('requests'), original);
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
