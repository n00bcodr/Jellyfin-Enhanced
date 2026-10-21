// Stage 1 fix round 9: a per-user editor compares what the person wants with what the server will hold once the saves
// still out are answered (acknowledged + in flight), so a change made back while a save is out is sent too; and every
// change to a document the page knows of (a save queued or answered, another route's write it acknowledges) moves the
// document's revision on, so a read that began before it is not taken over it. Real plugin.js, session.js, config.js and
// feature modules against a scripted server (helpers/settings-tabs) that can hold a request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';
import { route, settingsServer, tab, until } from '../helpers/settings-tabs.mjs';

const documents = extra => ({ Settings: {}, Shortcuts: { Shortcuts: [] }, Bookmark: { Bookmarks: {} }, Elsewhere: { Region: 'US', Regions: [], Services: [] }, HiddenContent: { Items: {}, Settings: {} }, Ddd: { Triggers: [] }, ...extra });
const settle = (ms = 20) => new Promise(r => setTimeout(r, ms));
const PAGE_CORE = ['core/lifecycle.js', 'core/dom-observer.js', 'core/ui-kit.js', 'enhanced/helpers.js'];

// ---- RBS1-R9-1: a change made back while a save is out ----

async function elsewhereTab(t, server) {
  const h = await tab(t, server, { extra: [...PAGE_CORE, 'elsewhere/elsewhere.js'], publicConfig: { ElsewhereEnabled: true, TmdbEnabled: true } });
  await until(() => h.document.getElementById('region-select'));
  const select = h.document.getElementById('region-select');
  for (const [code, name] of [['DE', 'Germany'], ['FR', 'France'], ['US', 'United States']]) {
    if (![...select.options].some(o => o.value === code)) select.insertAdjacentHTML('beforeend', `<option value="${code}">${name}</option>`);
  }
  return { h, choose: region => { select.value = region; h.document.getElementById('save-settings').onclick(); } };
}
const elsewhereWrites = server => server.writes.filter(w => w.file === 'elsewhere.json');

test('R9-1 Elsewhere: US, save DE, and back to US while that save is out: the server ends with US', async t => {
  const server = settingsServer(documents());
  const { h, choose } = await elsewhereTab(t, server);
  const held = server.hold('elsewhere.json', 'PATCH');
  choose('DE');
  await held.reached;
  choose('US');
  held.release();
  await h.JE.internals.userDocumentSettled('elsewhere.json');
  await settle();
  assert.equal(server.documents.Elsewhere.Region, 'US', 'the dialog shows US: the server holds US');
  assert.equal(h.JE.userConfig.elsewhere.Region, 'US');
  assert.deepEqual(elsewhereWrites(server).map(w => w.body.Set.Region), ['DE', 'US']);
});

test('R9-1 Elsewhere control: the same choice again while its save is out sends nothing more; a third choice is sent', async t => {
  const server = settingsServer(documents());
  const { h, choose } = await elsewhereTab(t, server);
  const held = server.hold('elsewhere.json', 'PATCH');
  choose('DE');
  await held.reached;
  choose('DE');
  held.release();
  await h.JE.internals.userDocumentSettled('elsewhere.json');
  await settle();
  assert.deepEqual(elsewhereWrites(server).map(w => w.body.Set.Region), ['DE']);
  const again = server.hold('elsewhere.json', 'PATCH');
  choose('FR');
  await again.reached;
  choose('US');
  again.release();
  await h.JE.internals.userDocumentSettled('elsewhere.json');
  await settle();
  assert.equal(server.documents.Elsewhere.Region, 'US');
});

test('R9-1 Elsewhere: a save out that fails, then the person\'s choice again: what the dialog shows is saved', async t => {
  const server = settingsServer(documents());
  const { h, choose } = await elsewhereTab(t, server);
  server.failWrites.add('elsewhere.json');
  const held = server.hold('elsewhere.json', 'PATCH');
  choose('DE');
  await held.reached;
  held.release();
  await h.JE.internals.userDocumentSettled('elsewhere.json');
  server.failWrites.delete('elsewhere.json');
  choose('DE');
  await h.JE.internals.userDocumentSettled('elsewhere.json');
  await settle();
  assert.equal(server.documents.Elsewhere.Region, 'DE');
});

/** One tab's Spoiler Guard state module and its panel section (the real modules), against `server`. */
function spoilerTab(t, server) {
  const html = '<div id="help">' + ['HideTags', 'HideCast'].map(pref => `<input type="checkbox" id="sbPref${pref}" data-pref="${pref}">`).join('') + '</div>';
  const h = createHarness({ html, JE: {
    pluginConfig: { SpoilerBlurEnabled: true }, t: key => key, toast() {},
    core: { api: { plugin: async (path, options = {}) => {
      if (path === '/spoiler-blur/series') {
        const prefs = structuredClone(server.spoilerPrefs);
        const held = server.holds.findIndex(gate => gate.file === 'spoiler-state');
        if (held >= 0) {
          const [gate] = server.holds.splice(held, 1);
          gate.arrived();
          await gate.released;
        }
        return { Prefs: prefs };
      }
      return route(server, { url: 'http://jellyfin.test/JellyfinEnhanced' + path, type: options.method || 'GET', data: JSON.stringify(options.body) });
    } } } } });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  h.load('core/mutation-queue.js');
  for (const name of ['ids', 'state', 'settings-tab']) h.load(`enhanced/spoilerguard/${name}.js`);
  return h;
}
const wire = h => h.JE.internals.spoilerGuard.wireSettings({ help: h.document.getElementById('help'), resetAutoCloseTimer() {} });
const toggle = (h, pref) => { const box = h.document.getElementById(`sbPref${pref}`); box.checked = !box.checked; box.dispatchEvent(new h.window.Event('change')); };

test('R9-1 Spoiler Guard: an override changed and changed back while the first save is out: the server ends with the second', async t => {
  const server = settingsServer(documents());
  server.spoilerPrefs = { HideTags: null, HideCast: null };
  const h = spoilerTab(t, server);
  const sg = h.JE.internals.spoilerGuard;
  await sg.loadState();
  const held = server.hold('spoiler-prefs', 'PATCH');
  const first = sg.setUserPrefs({ HideTags: false });
  await held.reached;
  const second = sg.setUserPrefs({ HideTags: null });
  held.release();
  await Promise.allSettled([first, second]);
  await settle();
  assert.equal(server.spoilerPrefs.HideTags, null);
  assert.equal(sg.getUserPrefs().HideTags, null);
});

test('R9-1 Spoiler Guard: a panel toggle while another override\'s save is out sends only its own override', async t => {
  const server = settingsServer(documents());
  server.spoilerPrefs = { HideTags: null, HideCast: null };
  const h = spoilerTab(t, server);
  wire(h);
  const sg = h.JE.internals.spoilerGuard;
  await sg.loadState();
  await settle();
  const held = server.hold('spoiler-prefs', 'PATCH');
  const other = sg.setUserPrefs({ HideCast: false }); // another surface of this page
  await held.reached;
  toggle(h, 'HideTags');
  held.release();
  await other;
  await until(() => server.spoilerPrefs.HideTags === false);
  await settle();
  assert.equal(server.spoilerPrefs.HideCast, false, 'the panel did not send HideCast back as it was before that save');
  assert.deepEqual(server.writes.filter(w => w.file === 'spoiler-prefs').map(w => Object.keys(w.body.Set)), [['HideCast'], ['HideTags']]);
});

// The direct-operation editors: each change is its own operation, so a change back is sent as well (controls).
test('R9-1 panel field: on, and off again while the first save is out: the server ends off', async t => {
  const server = settingsServer(documents({ Settings: { ShowFileSizes: false } }));
  const h = await tab(t, server);
  const held = server.hold('settings.json', 'PATCH');
  h.JE.updateSettings({ showFileSizes: true });
  await held.reached;
  h.JE.updateSettings({ showFileSizes: false });
  held.release();
  await h.JE.internals.userDocumentSettled('settings.json');
  assert.equal(server.documents.Settings.ShowFileSizes, false);
  assert.equal(h.JE.currentSettings.showFileSizes, false);
});

test('R9-1 legacy whole-document caller: a change and its reversal while the first save is out: the server ends with the reversal', async t => {
  const server = settingsServer(documents({ Settings: { CalendarDisplayMode: 'list' } }));
  const h = await tab(t, server);
  const held = server.hold('settings.json', 'PATCH');
  h.JE.currentSettings.calendarDisplayMode = 'grid';
  h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  await held.reached;
  h.JE.currentSettings.calendarDisplayMode = 'list';
  h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  held.release();
  await h.JE.internals.userDocumentSettled('settings.json');
  assert.equal(server.documents.Settings.CalendarDisplayMode, 'list');
});

const SHORTCUTS = [{ Name: 'CycleAudioTracks', Key: 'A', Label: 'Cycle Audio Tracks', Category: 'Player' }];
test('R9-1 shortcut editor: rebound, then restored while the rebind\'s save is out: no override is left', async t => {
  const server = settingsServer(documents());
  const h = await tab(t, server, { extra: ['enhanced/settingspanel/ui-panel-shortcut-editor.js'], publicConfig: { Shortcuts: SHORTCUTS } });
  h.document.body.insertAdjacentHTML('beforeend', '<div id="help"><div style="justify-content: space-between"><div><kbd tabindex="0" class="shortcut-key" data-action="CycleAudioTracks">A</kbd></div><div></div></div></div>');
  h.JE.initializeShortcuts();
  h.JE.internals.enhancedUi.wireShortcutEditor({ help: h.document.getElementById('help'), pluginShortcuts: SHORTCUTS, primaryAccentColor: 'blue', kbdBackground: 'black' });
  const key = h.document.querySelector('kbd[data-action="CycleAudioTracks"]');
  const press = name => { key.focus(); key.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })); };
  const held = server.hold('shortcuts.json', 'PATCH');
  press('q');
  await held.reached;
  press('Backspace');
  held.release();
  await h.JE.internals.userDocumentSettled('shortcuts.json');
  assert.deepEqual(server.documents.Shortcuts.Shortcuts, []);
});

const HIDDEN_MODULES = ['data', 'save', 'styles', 'dialogs', 'panel', 'filter', 'buttons', 'init'].map(name => `enhanced/hiddencontent/hidden-content-${name}.js`);
test('R9-1 Hidden Content setting: on, and off again while the first save is out: the server ends off', async t => {
  const server = settingsServer(documents({ HiddenContent: { Items: {}, Settings: { FilterSearch: false } } }));
  const h = await tab(t, server, { extra: [...PAGE_CORE, ...HIDDEN_MODULES], publicConfig: { HiddenContentEnabled: true } });
  const held = server.hold('hidden-content.json', 'PATCH');
  h.JE.hiddenContent.updateSettings({ filterSearch: true });
  await held.reached;
  h.JE.hiddenContent.updateSettings({ filterSearch: false });
  held.release();
  await h.JE.internals.userDocumentSettled('hidden-content.json');
  assert.equal(server.documents.HiddenContent.Settings.FilterSearch, false);
});

// ---- RBS1-R9-3: every change source moves the revision on; a read that began before it is not taken ----

const ITEM = '0a0b0c0d0e0f40008000a0b0c0d0e0f0';
const dashed = id => `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
/** The server's home-row hide route (HiddenContentController): a scoped entry in the person's hidden-content.json. */
const homeHideRoute = server => async request => {
  const m = /\/(continue-watching|next-up)\/hide\/([^/?]+)/.exec(new URL(request.url).pathname);
  if (!m) return undefined;
  const items = server.documents.HiddenContent.Items = server.documents.HiddenContent.Items || {};
  items[dashed(m[2])] = { ItemId: dashed(m[2]), Name: '', HideScope: m[1] === 'next-up' ? 'nextup' : 'continuewatching', HiddenAt: '2026-10-21T00:00:00Z' };
  return { success: true };
};

test('R9-3: a home-row hide while a Hidden Content read is out stays listed when that older read arrives', async t => {
  const server = settingsServer(documents());
  const h = await tab(t, server, { extra: [...PAGE_CORE, ...HIDDEN_MODULES, 'enhanced/homeremoval/features-remove-home.js'],
    publicConfig: { HiddenContentEnabled: true, RemoveContinueWatchingEnabled: true }, ajax: homeHideRoute(server) });
  const read = server.hold('hidden-content.json', 'GET');
  const refreshed = h.JE.hiddenContent.refresh();
  await read.reached; // the read is taken now: no hide yet
  assert.equal(await h.JE.internals.features.removeFromHomeSurface(ITEM, 'continuewatching'), true);
  assert.ok(h.JE.hiddenContent.getAllHiddenItems().some(item => item._key === ITEM), 'the hide\'s answer is in the document');
  read.release();
  await refreshed;
  await settle();
  assert.ok(h.JE.hiddenContent.getAllHiddenItems().some(item => item._key === ITEM), 'the older read did not take the hide away');
  assert.ok(Object.keys(server.documents.HiddenContent.Items).includes(dashed(ITEM)));
});

test('R9-3: a read that began before a save was answered is not taken over that answer (the save\'s value stays shown)', async t => {
  const server = settingsServer(documents({ Settings: { ShowFileSizes: false } }));
  const h = await tab(t, server);
  const read = server.hold('settings.json', 'GET');
  const reading = h.JE.readUserSettings('settings.json');
  await read.reached;
  await h.JE.updateSettings({ showFileSizes: true }, { throwOnError: true });
  read.release();
  await reading;
  assert.equal(h.JE.currentSettings.showFileSizes, true);
});

test('R9-3: a read that began after the last change is taken (another tab\'s change arrives)', async t => {
  const server = settingsServer(documents({ Settings: { ShowFileSizes: false } }));
  const h = await tab(t, server);
  await h.JE.updateSettings({ showFileSizes: true }, { throwOnError: true });
  server.documents.Settings.ShowWatchProgress = true; // another tab
  await h.JE.readUserSettings('settings.json');
  assert.equal(h.JE.currentSettings.showWatchProgress, true);
  assert.equal(h.JE.currentSettings.showFileSizes, true);
});

test('R9-3: a document handed out with a new userConfig object is not taken over a newer answer of the same session', async t => {
  const server = settingsServer(documents({ Settings: { ShowFileSizes: false } }));
  const h = await tab(t, server);
  const older = structuredClone(h.JE.userConfig);
  await h.JE.updateSettings({ showFileSizes: true }, { throwOnError: true });
  h.JE.userConfig = older; // a userConfig built from a read that began before the answer
  assert.equal(h.JE.internals.userDocument('settings.json').document.showFileSizes, true);
  assert.equal(h.JE.userConfig.settings.showFileSizes, true, 'the new object shows the store\'s document');
});

test('R9-3 Spoiler Guard: a state read that began before an override\'s save was answered does not put the old override back', async t => {
  const server = settingsServer(documents());
  server.spoilerPrefs = { HideTags: null };
  const h = spoilerTab(t, server);
  const sg = h.JE.internals.spoilerGuard;
  const read = server.hold('spoiler-state', 'GET');
  const loading = sg.loadState();
  await read.reached;
  await sg.setUserPrefs({ HideTags: false });
  read.release();
  await loading;
  assert.equal(sg.getUserPrefs().HideTags, false);
  assert.equal(server.spoilerPrefs.HideTags, false);
});
