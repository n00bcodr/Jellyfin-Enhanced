// Stage 1 fix round 8: what a per-user save compares against is the document as the server last handed it out (a read or
// a save's answer), never the page's own state; every edit is an operation on that document; no per-user document is
// written whole. Real plugin.js, session.js, config.js and feature modules against a scripted server (helpers/settings-tabs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';
import { route, settingsServer, tab, until } from '../helpers/settings-tabs.mjs';

const SHORTCUTS = [{ Name: 'CycleAudioTracks', Key: 'A', Label: 'Cycle Audio Tracks', Category: 'Player' }, { Name: 'GoToHome', Key: 'Shift+H', Label: 'Go to Home', Category: 'Global' }];
const documents = extra => ({ Settings: {}, Shortcuts: { Shortcuts: [] }, Bookmark: { Bookmarks: {} }, Elsewhere: { Region: 'US', Regions: [], Services: [] }, HiddenContent: { Items: {}, Settings: {} }, Ddd: { Triggers: [] }, ...extra });
const settle = (ms = 20) => new Promise(r => setTimeout(r, ms));

/** The panel's Shortcuts tab: the real editor wired to one key chip. */
function shortcutEditor(h, action = 'CycleAudioTracks') {
  h.document.body.insertAdjacentHTML('beforeend', `<div id="help"><div style="justify-content: space-between"><div><kbd tabindex="0" class="shortcut-key" data-action="${action}">A</kbd></div><div></div></div></div>`);
  h.JE.initializeShortcuts();
  h.JE.internals.enhancedUi.wireShortcutEditor({ help: h.document.getElementById('help'), pluginShortcuts: SHORTCUTS, primaryAccentColor: 'blue', kbdBackground: 'black' });
  const key = h.document.querySelector(`kbd[data-action="${action}"]`);
  return name => { key.focus(); key.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })); };
}
const shortcutTab = (t, server) => tab(t, server, { extra: ['enhanced/settingspanel/ui-panel-shortcut-editor.js'], publicConfig: { Shortcuts: SHORTCUTS } });

// RBS1-R8-1: the editor changed JE.userConfig.shortcuts before the store first held shortcuts.json, so the store took the
// changed object as the document: nothing differed, nothing was sent, the rebind was gone after a reload.
test('R8-1: a shortcut rebound in the panel is saved, and is there after a reload', async t => {
  const server = settingsServer(documents());
  const h = await shortcutTab(t, server);
  shortcutEditor(h)('q');
  await until(() => (server.documents.Shortcuts.Shortcuts || []).some(s => s.Name === 'CycleAudioTracks'));
  assert.equal(server.documents.Shortcuts.Shortcuts.find(s => s.Name === 'CycleAudioTracks').Key, 'Q');
  const reloaded = await shortcutTab(t, server);
  reloaded.JE.initializeShortcuts();
  assert.equal(reloaded.JE.state.activeShortcuts.CycleAudioTracks, 'Q');
  assert.equal(reloaded.JE.state.activeShortcuts.GoToHome, 'Shift+H', 'an untouched binding keeps the default');
});

test('R8-1: disabling and restoring a shortcut are saved; another tab\'s rebind of another shortcut stays', async t => {
  const server = settingsServer(documents());
  const h = await shortcutTab(t, server);
  const press = shortcutEditor(h);
  server.documents.Shortcuts.Shortcuts.push({ Name: 'GoToHome', Key: 'G' }); // another tab, after this one's read
  press('Delete');
  await until(() => (server.documents.Shortcuts.Shortcuts || []).some(s => s.Name === 'CycleAudioTracks'));
  assert.equal(server.documents.Shortcuts.Shortcuts.find(s => s.Name === 'CycleAudioTracks').Key, '');
  press('Backspace');
  await until(() => !server.documents.Shortcuts.Shortcuts.some(s => s.Name === 'CycleAudioTracks'));
  assert.deepEqual(server.documents.Shortcuts.Shortcuts.map(s => [s.Name, s.Key]), [['GoToHome', 'G']]);
  assert.equal(h.JE.userConfig.shortcuts.Shortcuts.some(s => s.Name === 'CycleAudioTracks'), false, 'the page shows what the server holds');
});

// The baseline is the document as read even when a caller changed the page's copy before the store first held it.
test('R8-1 control: a legacy whole-document caller that changed the page\'s copy first still sends its change', async t => {
  const server = settingsServer(documents({ Settings: { CalendarDisplayMode: 'list', ShowFileSizes: false } }));
  const h = await tab(t, server);
  h.JE.userConfig.settings.calendarDisplayMode = 'grid'; // before anything asked the store for settings.json
  await h.JE.saveUserSettings('settings.json', { ...h.JE.userConfig.settings }, { throwOnError: true });
  assert.equal(server.documents.Settings.CalendarDisplayMode, 'grid');
});

const PAGE_CORE = ['core/lifecycle.js', 'core/dom-observer.js', 'core/ui-kit.js', 'enhanced/helpers.js'];
const HIDDEN_MODULES = ['data', 'save', 'styles', 'dialogs', 'panel', 'filter', 'buttons', 'init'].map(name => `enhanced/hiddencontent/hidden-content-${name}.js`);
const hiddenTab = (t, server) => tab(t, server, { extra: [...PAGE_CORE, ...HIDDEN_MODULES], publicConfig: { HiddenContentEnabled: true } });
const hiddenKeys = server => Object.keys(server.documents.HiddenContent.Items || {}).sort();
const movie = (id, name) => ({ itemId: id, name, type: 'Movie' });

// RBS1-R8-3: Hidden Content posted its whole document, and the server replaced the stored one.
test('R8-3: items hidden in two tabs are both kept, in either order', async t => {
  for (const order of [['a', 'b'], ['b', 'a']]) {
    const server = settingsServer(documents());
    const tabs = { a: await hiddenTab(t, server), b: await hiddenTab(t, server) };
    const ids = { a: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', b: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
    for (const name of order) {
      tabs[name].JE.hiddenContent.hideItem(movie(ids[name], name));
      await until(() => hiddenKeys(server).includes(ids[name]));
    }
    await settle(700); // past any delayed whole-document save
    assert.deepEqual(hiddenKeys(server), [ids.a, ids.b].sort(), order.join());
  }
});

test('R8-3: an unhide in one tab and a hide and a setting in another all stay', async t => {
  const stored = { Items: { cccccccccccccccccccccccccccccccc: { ItemId: 'cccccccccccccccccccccccccccccccc', Name: 'c', HideScope: 'global' } }, Settings: { FilterSearch: false } };
  const server = settingsServer(documents({ HiddenContent: stored }));
  const a = await hiddenTab(t, server), b = await hiddenTab(t, server);
  a.JE.hiddenContent.unhideItem('cccccccccccccccccccccccccccccccc');
  await until(() => !hiddenKeys(server).includes('cccccccccccccccccccccccccccccccc'));
  b.JE.hiddenContent.hideItem(movie('dddddddddddddddddddddddddddddddd', 'd'));
  b.JE.hiddenContent.updateSettings({ filterSearch: true });
  await until(() => hiddenKeys(server).includes('dddddddddddddddddddddddddddddddd') && server.documents.HiddenContent.Settings.FilterSearch === true);
  await settle(700);
  assert.deepEqual(hiddenKeys(server), ['dddddddddddddddddddddddddddddddd'], 'tab b did not put back what tab a unhid');
  assert.equal(server.documents.HiddenContent.Settings.FilterSearch, true);
  assert.ok(server.writes.filter(w => w.file === 'hidden-content.json').every(w => w.type === 'PATCH'), 'only item and setting operations were sent');
});

test('R8-3: "Unhide all" removes what this tab showed; an item another tab hid meanwhile stays', async t => {
  const stored = { Items: { eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee: { ItemId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', Name: 'e' } }, Settings: {} };
  const server = settingsServer(documents({ HiddenContent: stored }));
  const h = await hiddenTab(t, server);
  server.documents.HiddenContent.Items.ffffffffffffffffffffffffffffffff = { ItemId: 'ffffffffffffffffffffffffffffffff', Name: 'f' };
  h.JE.hiddenContent.unhideAll();
  await until(() => !hiddenKeys(server).includes('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'));
  assert.deepEqual(hiddenKeys(server), ['ffffffffffffffffffffffffffffffff']);
  assert.deepEqual(Object.keys(h.JE.userConfig.hiddenContent.items), ['ffffffffffffffffffffffffffffffff'], 'the answer brings the other tab\'s item');
});

test('R8-3: a hide the server refuses shows the item again and says so', async t => {
  const server = settingsServer(documents());
  const h = await hiddenTab(t, server);
  server.failWrites.add('hidden-content.json');
  h.JE.hiddenContent.hideItem(movie('abababababababababababababababab', 'x'));
  await until(() => h.toasts.length > 0);
  assert.equal(h.JE.hiddenContent.isHidden('abababababababababababababababab'), false);
  assert.deepEqual(hiddenKeys(server), []);
});

const PAGE_MODULES = ['state', 'styles', 'admin', 'cards', 'render', 'nav', 'init'].map(name => `enhanced/hiddencontent/hidden-content-page-${name}.js`);
// Found live (round 8): the management page showed the tab's own copy; another tab's hides appeared only after a reload.
test('the Hidden Content page, opened, reads the list: an item another tab hid since shows', async t => {
  const server = settingsServer(documents());
  const a = await tab(t, server, { extra: [...PAGE_CORE, ...HIDDEN_MODULES, ...PAGE_MODULES], publicConfig: { HiddenContentEnabled: true }, html: '<div class="mainAnimatedPages"><div class="mainAnimatedPage" id="home"></div></div>' });
  const b = await hiddenTab(t, server);
  a.JE.hiddenContent.hideItem(movie('a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1', 'mine'));
  await until(() => hiddenKeys(server).length === 1);
  b.JE.hiddenContent.hideItem(movie('b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', 'other tab'));
  await until(() => hiddenKeys(server).length === 2);
  assert.equal(a.JE.hiddenContent.getHiddenCount(), 1, 'before opening the page, tab a holds its own answer');
  a.JE.hiddenContentPage.showPage();
  await until(() => a.JE.hiddenContent.getHiddenCount() === 2);
  await until(() => (a.document.getElementById('je-hidden-content-page')?.textContent || '').includes('other tab'));
});

// RBS1-R8-4: a failed Elsewhere save moved the dialog's "what it showed" on, so the retry sent nothing.
test('R8-4: an Elsewhere region change whose save failed is saved by the retry', async t => {
  const server = settingsServer(documents());
  const h = await tab(t, server, { extra: [...PAGE_CORE, 'elsewhere/elsewhere.js'], publicConfig: { ElsewhereEnabled: true, TmdbEnabled: true } });
  await until(() => h.document.getElementById('region-select'));
  const select = h.document.getElementById('region-select');
  if (![...select.options].some(o => o.value === 'DE')) select.insertAdjacentHTML('beforeend', '<option value="DE">Germany</option>');
  select.value = 'DE';
  server.failWrites.add('elsewhere.json');
  h.document.getElementById('save-settings').onclick();
  await until(() => server.writes.length > 0 || h.JE.userConfig.elsewhere.Region === 'US');
  await settle();
  assert.equal(server.documents.Elsewhere.Region, 'US');
  server.failWrites.delete('elsewhere.json');
  assert.equal(select.value, 'DE', 'the dialog still shows the person\'s choice');
  h.document.getElementById('save-settings').onclick();
  await until(() => server.documents.Elsewhere.Region === 'DE');
  assert.equal(h.JE.userConfig.elsewhere.Region, 'DE');
});

test('R8-4 control: a saved Elsewhere change is not sent again, and another tab\'s services stay', async t => {
  const server = settingsServer(documents());
  const h = await tab(t, server, { extra: [...PAGE_CORE, 'elsewhere/elsewhere.js'], publicConfig: { ElsewhereEnabled: true, TmdbEnabled: true } });
  await until(() => h.document.getElementById('region-select'));
  const select = h.document.getElementById('region-select');
  if (![...select.options].some(o => o.value === 'FR')) select.insertAdjacentHTML('beforeend', '<option value="FR">France</option>');
  select.value = 'FR';
  server.documents.Elsewhere.Services = ['Other tab'];
  h.document.getElementById('save-settings').onclick();
  await until(() => server.documents.Elsewhere.Region === 'FR');
  const writes = server.writes.length;
  h.document.getElementById('save-settings').onclick();
  await settle(50);
  assert.equal(server.writes.length, writes, 'nothing changed since the saved answer: nothing sent');
  assert.deepEqual(server.documents.Elsewhere.Services, ['Other tab']);
});

/** One tab's Spoiler Guard state module and its panel section (the real modules), against `server`. */
function spoilerTab(t, server) {
  const html = '<div id="help">' + ['HideTags', 'HideCast'].map(pref => `<input type="checkbox" id="sbPref${pref}" data-pref="${pref}">`).join('') + '</div>';
  const h = createHarness({ html, JE: {
    pluginConfig: { SpoilerBlurEnabled: true }, t: key => key, toast() {},
    core: { api: { plugin: async (path, options = {}) => {
      if (path === '/spoiler-blur/series') return { Prefs: structuredClone(server.spoilerPrefs) };
      return route(server, { url: 'http://jellyfin.test/JellyfinEnhanced' + path, type: options.method || 'GET', data: JSON.stringify(options.body) });
    } } } } });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  for (const name of ['ids', 'state', 'settings-tab']) h.load(`enhanced/spoilerguard/${name}.js`);
  h.JE.internals.spoilerGuard.wireSettings({ help: h.document.getElementById('help'), resetAutoCloseTimer() {} });
  return h;
}
const toggle = (h, pref) => { const box = h.document.getElementById(`sbPref${pref}`); box.checked = !box.checked; box.dispatchEvent(new h.window.Event('change')); };

// Found by the whole-document writer scan (round 8): Spoiler Guard's panel overrides were posted whole.
test('Spoiler Guard overrides changed in two tabs are both kept', async t => {
  const server = settingsServer(documents());
  server.spoilerPrefs = { HideTags: null, HideCast: null };
  const a = spoilerTab(t, server), b = spoilerTab(t, server);
  await settle();
  toggle(a, 'HideTags');
  await until(() => server.spoilerPrefs.HideTags === false);
  toggle(b, 'HideCast');
  await until(() => server.spoilerPrefs.HideCast === false);
  await settle();
  assert.equal(server.spoilerPrefs.HideTags, false, 'tab b did not put back tab a\'s choice');
  assert.equal(server.spoilerPrefs.HideCast, false);
});
