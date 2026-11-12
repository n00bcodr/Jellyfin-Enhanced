// The ShowPlaybackInfo shortcut (upstream c55c758e): jellyfin-web's own stats panel first, opened through the OSD
// settings menu while that menu is kept invisible; the plugin overlay only when the menu cannot do it. Driven from
// the key press through enhanced/events.js into enhanced/player/playback.js, with the real core/dom-observer.js wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, loadKeyCombo } from '../../helpers/harness.mjs';

const OSD = '<div class="videoOsdBottom"><button is="paper-icon-button-light" class="btnVideoOsdSettings" title="Settings"></button></div>';
const HIDING = /\.dialogContainer,\s*\.dialogBackdrop,\s*\.actionSheet\s*\{\s*opacity:\s*0/;

function setup(t, { button = true } = {}) {
  const navigations = [];
  const h = createHarness({ html: `<video></video>${button ? OSD : ''}`,
    JE: { pluginConfig: {}, currentSettings: {}, state: { activeShortcuts: { ShowPlaybackInfo: 'I' } }, internals: {},
      t: key => key, toast() {}, escapeHtml: String, isVideoPage: () => true, icons: { wrapEmoji: x => x }, icon: () => '', IconName: {},
      injectGlobalStyles() {}, addPluginMenuButton() {}, addUserMenuLink() {}, addRandomButton() {}, applySavedStylesWhenReady() {},
      helpers: { createObserver() {}, throttle: fn => fn, onBodyMutation: () => ({ unsubscribe() {} }) },
      core: { navigation: { onNavigate: fn => { navigations.push(fn); return () => {}; } } },
      session: { createLease: () => ({ isCurrent: () => true }), onUserChange: () => () => {} } } });
  t.after(() => h.close());
  h.window.PointerEvent = h.window.MouseEvent; // jsdom has no PointerEvent; the browsers this runs in all do
  h.load('core/dom-observer.js');
  loadKeyCombo(h);
  h.load('enhanced/player/playback.js');
  h.load('enhanced/events.js');
  h.JE.initializeEnhancedScript();
  const press = () => h.document.body.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true }));
  const state = () => {
    const stats = h.document.querySelector('.playerStats');
    return {
      stats: stats ? (stats.classList.contains('hide') ? 'hidden' : 'shown') : 'absent',
      overlay: h.document.querySelectorAll('[data-je-playback-info]').length,
      sheets: h.document.querySelectorAll('.actionSheet').length,
      hiding: [...h.document.querySelectorAll('style')].filter(s => HIDING.test(s.textContent)).length,
    };
  };
  const until = async (check, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (check()) return true; await new Promise(r => h.window.setTimeout(r, 10)); }
    return check();
  };
  return { ...h, press, state, until, navigate: () => navigations.forEach(fn => fn()) };
}

// jellyfin-web 12.4's video OSD as the lab showed it (step-log evidence p34-sheet-dom): the settings button opens an
// action sheet after an import, inside a .dialogContainer whose .dialogBackdrop is its previous sibling; the sheet
// closes only on a click whose mousedown also landed on the container; the "stats" entry toggles .playerStats.
// firefox: video/index.js's capture-phase guard, which drops a click whose target does not contain the target of
// the last keydown or pointerdown.
function webClient(h, { entries = ['aspectratio', 'playbackrate', 'quality', 'stats'], firefox = false } = {}) {
  const d = h.document, log = { menus: 0, closedByOutsideClick: 0, hiddenWhileOpen: [] };
  if (firefox) {
    let clicked = null;
    for (const type of ['keydown', 'pointerdown']) d.addEventListener(type, e => { clicked = e.target; }, true);
    d.addEventListener('click', e => { if (!e.target.contains(clicked)) { e.preventDefault(); e.stopPropagation(); } }, true);
  }
  const toggleStats = () => {
    const stats = d.querySelector('.playerStats');
    if (stats) stats.classList.toggle('hide');
    else d.body.append(Object.assign(d.createElement('div'), { className: 'playerStats' }));
  };
  d.querySelector('button.btnVideoOsdSettings')?.addEventListener('click', () => {
    log.menus++;
    h.window.setTimeout(() => {
      const backdrop = Object.assign(d.createElement('div'), { className: 'dialogBackdrop dialogBackdropOpened' });
      const container = Object.assign(d.createElement('div'), { className: 'dialogContainer' });
      const sheet = Object.assign(d.createElement('div'), { className: 'focuscontainer dialog actionSheet opened' });
      const content = Object.assign(d.createElement('div'), { className: 'actionSheetContent' });
      const close = () => { container.remove(); backdrop.remove(); };
      for (const id of entries) {
        const entry = Object.assign(d.createElement('button'), { className: 'listItem actionSheetMenuItem' });
        entry.setAttribute('data-id', id);
        entry.addEventListener('click', () => { close(); if (id === 'stats') toggleStats(); });
        content.append(entry);
      }
      let pressed = false;
      container.addEventListener('mousedown', e => { pressed = e.target === container; });
      container.addEventListener('click', e => { if (pressed && e.target === container) { log.closedByOutsideClick++; close(); } pressed = false; });
      sheet.append(content); container.append(sheet);
      d.body.append(backdrop, container);
      log.hiddenWhileOpen.push([...d.querySelectorAll('style')].some(s => HIDING.test(s.textContent)));
    }, 20);
  });
  return log;
}

test('the I shortcut toggles jellyfin-web\'s own stats panel through the settings menu, which is never shown', async t => {
  const h = setup(t), web = webClient(h);
  h.press();
  assert.ok(await h.until(() => h.state().stats === 'shown'), `native stats did not open: ${JSON.stringify(h.state())}`);
  assert.deepEqual(web.hiddenWhileOpen, [true], 'the menu opens while the hiding style is in place');
  assert.equal(h.state().overlay, 0);
  assert.equal(h.state().sheets, 0);
  assert.ok(await h.until(() => h.state().hiding === 0, 1000), 'the hiding style is removed again');
  h.press();
  assert.ok(await h.until(() => h.state().stats === 'hidden'), `native stats did not close: ${JSON.stringify(h.state())}`);
  assert.deepEqual({ overlay: h.state().overlay, sheets: h.state().sheets, menus: web.menus, hiddenWhileOpen: web.hiddenWhileOpen },
    { overlay: 0, sheets: 0, menus: 2, hiddenWhileOpen: [true, true] });
  assert.ok(await h.until(() => h.state().hiding === 0, 1000));
});

test('Firefox: the OSD click guard does not swallow the clicks that open the stats panel', async t => {
  const h = setup(t), web = webClient(h, { firefox: true });
  h.press();
  assert.ok(await h.until(() => h.state().stats === 'shown'), `native stats did not open: ${JSON.stringify(h.state())}`);
  assert.deepEqual({ overlay: h.state().overlay, sheets: h.state().sheets, menus: web.menus }, { overlay: 0, sheets: 0, menus: 1 });
});

test('a menu without the Playback Info entry is closed unseen and the plugin overlay opens instead', async t => {
  const h = setup(t), web = webClient(h, { entries: ['aspectratio', 'playbackrate'], firefox: true });
  h.press();
  assert.ok(await h.until(() => h.state().overlay === 1), `overlay did not open: ${JSON.stringify(h.state())}`);
  assert.deepEqual({ stats: h.state().stats, sheets: h.state().sheets, menus: web.menus, closed: web.closedByOutsideClick },
    { stats: 'absent', sheets: 0, menus: 1, closed: 1 });
  assert.ok(await h.until(() => h.state().hiding === 0, 1000), 'the hiding style is removed again');
  h.press();
  await h.until(() => h.state().overlay === 0, 500);
  assert.deepEqual({ ...h.state(), menus: web.menus }, { stats: 'absent', overlay: 0, sheets: 0, hiding: 0, menus: 1 },
    'the open overlay closes without opening the menu');
});

test('without the OSD settings button the plugin overlay toggles at once and nothing is hidden', async t => {
  const h = setup(t, { button: false });
  h.press();
  await h.until(() => h.state().overlay === 1, 500);
  assert.deepEqual(h.state(), { stats: 'absent', overlay: 1, sheets: 0, hiding: 0 });
  h.press();
  await h.until(() => h.state().overlay === 0, 500);
  assert.deepEqual(h.state(), { stats: 'absent', overlay: 0, sheets: 0, hiding: 0 });
});

test('a second press while the menu is still opening does not open a second menu', async t => {
  const h = setup(t), web = webClient(h);
  h.press(); h.press();
  assert.ok(await h.until(() => h.state().stats === 'shown'));
  await new Promise(r => h.window.setTimeout(r, 100));
  assert.deepEqual({ stats: h.state().stats, overlay: h.state().overlay, sheets: h.state().sheets, menus: web.menus },
    { stats: 'shown', overlay: 0, sheets: 0, menus: 1 });
});

test('leaving the player while the menu opens leaves no overlay and no hidden dialogs behind', async t => {
  const h = setup(t), web = webClient(h, { entries: ['aspectratio'] });
  h.press(); h.navigate();
  assert.ok(await h.until(() => h.state().hiding === 0, 2000), 'the hiding style is removed after leaving');
  await new Promise(r => h.window.setTimeout(r, 200));
  assert.equal(web.menus, 1);
  assert.equal(h.state().overlay, 0);
});
