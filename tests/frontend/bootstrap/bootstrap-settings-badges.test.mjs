// Phase 4e (D29): each person's acquisition-badge preferences in the JE settings panel. Both are display preferences:
// unset/null follows the household, "Hide" is false. The box only exists while acquisition badges are on; the native
// select only while the native stamps are on too; untouched choices are never written; the web choice reaches the
// poster cards without a reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, deferred, jsRoot } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const tr = key => (key in en ? en[key] : key);
const preset = { name: 'p', previewText: 'Aa', size: 1, family: 'sans-serif', bgColor: '#000', textColor: '#fff' };
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The real panel template (and, when wired, the real settings listeners) with the panel's helpers stubbed. */
function panel(tt, { config = {}, settings = {}, translate = tr } = {}) {
  const writes = [], toasts = [], panelCleanups = [];
  const h = createHarness({
    JE: {
      pluginConfig: { Shortcuts: [], ...config }, userConfig: { settings: { ...settings }, shortcuts: { Shortcuts: [] } }, currentSettings: {},
      t: translate, toast: message => toasts.push(message), escapeHtml, icon: () => '', IconName: new Proxy({}, { get: (_, k) => String(k) }),
      icons: { wrapEmoji: s => s }, state: { activeShortcuts: {} }, pluginVersion: '0.0.0',
      fontSizePresets: [preset, preset, preset, preset], fontFamilyPresets: [preset], subtitlePresets: [preset], subtitleTextEffectPresets: [preset],
      decodeSubtitleColor: () => ({ swatch: '#FFFFFF', alpha: 255, alphaValue: 255 }), getSubtitleTextShadow: () => 'none'
    },
    // Settings saves are POSTs; the panel also reads the server's cultures (answered empty).
    apiClient: { ajax: async request => { if (request.type === 'POST') writes.push(request); return []; } }
  });
  tt.after(() => h.close());
  h.load('enhanced/config.js');
  h.JE.currentSettings = h.JE.loadSettings();
  h.load('enhanced/settingspanel/ui-panel-template.js');
  h.load('enhanced/settingspanel/ui-panel-settings.js');
  h.document.body.innerHTML = h.JE.internals.enhancedUi.buildPanelHtml({ presetBoxBackground: '#111', detailsBackground: '#222', toggleAccentColor: '#333' });
  const resets = [];
  h.JE.internals.arrStatusCards = { reset: () => resets.push(h.JE.currentSettings.acquisitionBadges) };
  return { ...h, writes, toasts, resets, panelCleanups,
    wire() { h.JE.internals.enhancedUi.wireSettingsListeners({ panelCleanups, createToast: (key, enabled) => `${key}:${enabled}`, resetAutoCloseTimer() {} }); },
    async choose(id, value) {
      const select = h.document.getElementById(id);
      select.value = value;
      select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
      await new Promise(done => setImmediate(done));
    } };
}

const badges = { ArrAcquisitionBadgesEnabled: true, ArrNativeStampsEnabled: true };

for (const config of [{}, { ArrAcquisitionBadgesEnabled: false }, { ArrAcquisitionBadgesEnabled: 'true' }, { ArrNativeStampsEnabled: true }]) test(`the Poster badges box is absent while acquisition badges are off (${JSON.stringify(config)})`, t => {
  const h = panel(t, { config });
  for (const id of ['acquisitionBadgesSelect', 'nativeAcquisitionStampsSelect']) assert.equal(h.document.getElementById(id), null);
  assert.ok(!h.document.body.textContent.includes(tr('panel_settings_badges_desc')));
});

test('with badges on, the box shows the web choice; the native-app choice only with native stamps on', t => {
  const only = panel(t, { config: { ArrAcquisitionBadgesEnabled: true } });
  assert.ok(only.document.getElementById('acquisitionBadgesSelect'));
  assert.equal(only.document.getElementById('nativeAcquisitionStampsSelect'), null);

  const h = panel(t, { config: badges, settings: { nativeAcquisitionStamps: false } });
  const pane = h.document.querySelector('section[data-pane="ui"]');
  const web = pane.querySelector('#acquisitionBadgesSelect');
  const native = pane.querySelector('#nativeAcquisitionStampsSelect');
  assert.ok(web && native);
  for (const select of [web, native]) {
    assert.deepEqual([...select.options].map(o => [o.value, o.textContent]), [['', tr('panel_settings_badges_follow')], ['off', tr('panel_settings_badges_hide')]]);
  }
  assert.equal(web.value, '');
  assert.equal(native.value, 'off');
  assert.equal(pane.querySelector('label[for="acquisitionBadgesSelect"]').textContent, tr('panel_settings_badges_web'));
  assert.equal(pane.querySelector('label[for="nativeAcquisitionStampsSelect"]').textContent, tr('panel_settings_badges_native'));
  assert.ok(pane.textContent.includes(tr('panel_settings_badges')));
  assert.ok(pane.textContent.includes(tr('panel_settings_badges_desc')));
});

test('choosing saves Hide as false and the household as null; untouched choices stay unwritten; the cards follow', async t => {
  const h = panel(t, { config: badges });
  h.wire();
  await h.choose('acquisitionBadgesSelect', 'off');
  let saved = JSON.parse(h.writes.at(-1).data);
  assert.equal(saved.acquisitionBadges, false);
  assert.ok(!('nativeAcquisitionStamps' in saved));
  assert.equal(h.JE.userConfig.settings.acquisitionBadges, false);
  assert.deepEqual(h.toasts, [tr('toast_badge_settings_saved')]);
  assert.deepEqual(h.resets, [false], 'the poster cards are reset with the new choice in place');
  await h.choose('nativeAcquisitionStampsSelect', 'off');
  saved = JSON.parse(h.writes.at(-1).data);
  assert.equal(saved.nativeAcquisitionStamps, false);
  assert.equal(h.resets.length, 1, 'the native choice does not touch the web cards');
  await h.choose('acquisitionBadgesSelect', '');
  assert.equal(JSON.parse(h.writes.at(-1).data).acquisitionBadges, null);
  assert.deepEqual(h.resets, [false, null]);
  await h.choose('nativeAcquisitionStampsSelect', '');
  assert.equal(JSON.parse(h.writes.at(-1).data).nativeAcquisitionStamps, null);
  assert.equal(h.writes.length, 4);
});

test('a select left on the page after badges were turned off saves nothing', async t => {
  const h = panel(t, { config: badges });
  h.wire();
  h.JE.pluginConfig.ArrAcquisitionBadgesEnabled = false;
  await h.choose('acquisitionBadgesSelect', 'off');
  assert.equal(h.writes.length, 0);
  assert.equal(h.resets.length, 0);
});

test('translated badge labels are escaped', t => {
  const h = panel(t, { config: badges, translate: key => (key.startsWith('panel_settings_badges') ? '<img src=x onerror=alert(1)>' : tr(key)) });
  assert.equal(h.document.querySelectorAll('img[src="x"]').length, 0);
  assert.equal(h.document.getElementById('nativeAcquisitionStampsSelect').options[1].textContent, '<img src=x onerror=alert(1)>');
});


for (const outcome of ['saved', 'failed', 'hidden', 'switched']) test(`show badges waits for persistence and ignores obsolete completion: ${outcome}`, async t => {
  const h = panel(t, { config: badges, settings: { acquisitionBadges: false } });
  const held = deferred();
  let epoch = 1;
  h.JE.session = { getEpoch: () => epoch, isCurrent: captured => captured === epoch };
  h.window.ApiClient.ajax = () => held.promise;
  h.wire();
  await h.choose('acquisitionBadgesSelect', '');
  assert.deepEqual(h.resets, [], 'no card refresh while the server still has Hide');
  assert.deepEqual(h.toasts, [], 'no saved toast before persistence');
  if (outcome === 'hidden') {
    await h.choose('acquisitionBadgesSelect', 'off');
    assert.deepEqual(h.resets, [false], 'Hide removes badges immediately, even with a pending save');
  }
  if (outcome === 'switched') epoch++;
  if (outcome === 'failed') held.reject(new Error('save failed'));
  else held.resolve();
  await new Promise(done => setImmediate(done));
  assert.deepEqual(h.resets, outcome === 'saved' ? [null] : outcome === 'hidden' || outcome === 'failed' ? [false] : []);
  if (outcome === 'failed') assert.deepEqual(h.toasts, [], 'failed persistence never claims success');
});

test('rewiring the panel while Show is pending still refreshes cards after the document saves', async t => {
  const h = panel(t, { config: badges, settings: { acquisitionBadges: false } });
  const held = deferred();
  h.window.ApiClient.ajax = () => held.promise;
  h.wire();
  await h.choose('acquisitionBadgesSelect', '');
  h.wire(); // a replacement panel observes the same in-flight document
  held.resolve();
  await new Promise(done => setImmediate(done));
  assert.deepEqual(h.resets, [null]);
});

/** Replace the panel and both settings views, as a panel-opening GET does. */
function reopen(h, server) {
  h.JE.userConfig.settings = { ...server };
  h.JE.currentSettings = h.JE.loadSettings();
  h.document.body.innerHTML = h.JE.internals.enhancedUi.buildPanelHtml({ presetBoxBackground: '#111', detailsBackground: '#222', toggleAccentColor: '#333' });
  h.wire();
}

for (const initial of [null, false]) for (const nativeFirst of [false, true]) {
  test(`R6 earlier success survives replaced settings and later failure: ${initial}, native first ${nativeFirst}`, async t => {
    const baseline = { acquisitionBadges: initial, nativeAcquisitionStamps: initial };
    const h = panel(t, { config: badges, settings: baseline });
    const held = [deferred(), deferred()];
    const posted = [];
    let persisted = baseline;
    h.window.ApiClient.ajax = async request => {
      if (request.type !== 'POST') return [];
      const n = posted.length;
      posted.push(JSON.parse(request.data));
      await held[n].promise;
      persisted = posted[n];
    };
    h.wire();
    const keys = nativeFirst ? ['nativeAcquisitionStamps', 'acquisitionBadges'] : ['acquisitionBadges', 'nativeAcquisitionStamps'];
    await h.choose(keys[0] + 'Select', initial === false ? '' : 'off');
    reopen(h, baseline);
    held[0].resolve();
    await new Promise(done => setImmediate(done));
    await h.choose(keys[1] + 'Select', initial === false ? '' : 'off');
    held[1].reject(new Error('later save fails'));
    await new Promise(done => setImmediate(done));
    assert.equal(posted.length, 2);
    for (const key of keys) {
      assert.equal(h.JE.currentSettings[key], persisted[key], key + ' active document follows earlier success');
      assert.equal(h.JE.userConfig.settings[key], persisted[key]);
      assert.equal(h.document.getElementById(key + 'Select').value, persisted[key] === false ? 'off' : '');
    }
  });
}

for (const sameUser of [false, true]) test(`session change cancels unsent saves and isolates in-flight completion, same user ${sameUser}`, async t => {
  const h = panel(t, { config: badges, settings: { acquisitionBadges: null, nativeAcquisitionStamps: null } });
  h.load('core/navigation.js');
  h.load('core/session.js');
  // Reload config after the real session module, matching the manifest order.
  h.load('enhanced/config.js');
  h.JE.currentSettings = h.JE.loadSettings();
  h.wire();
  const held = deferred();
  const posted = [];
  h.window.ApiClient.ajax = request => {
    if (request.type !== 'POST') return Promise.resolve([]);
    posted.push({ url: request.url, user: h.window.ApiClient.getCurrentUserId() });
    return held.promise;
  };
  await h.choose('acquisitionBadgesSelect', 'off');
  await h.choose('nativeAcquisitionStampsSelect', 'off');
  h.window.ApiClient.getCurrentUserId = () => null;
  h.JE.session.checkNow('test logout');
  h.window.ApiClient.getCurrentUserId = () => sameUser ? 'user-a' : 'user-b';
  h.JE.session.checkNow('test login');
  reopen(h, { acquisitionBadges: null, nativeAcquisitionStamps: null });
  const resetCount = h.resets.length, toastCount = h.toasts.length;
  held.resolve();
  await new Promise(done => setImmediate(done));
  assert.equal(posted.length, 1, 'the previous session must not send queued data using new credentials');
  assert.equal(h.JE.currentSettings.acquisitionBadges, null);
  assert.equal(h.JE.currentSettings.nativeAcquisitionStamps, null);
  assert.equal(h.resets.length, resetCount, 'old completions cannot repaint the new session');
  assert.equal(h.toasts.length, toastCount);
});

for (const scenario of ['pending save', 'save completed', 'session switch', 'fresh read']) {
  test(`panel GET cannot replace a newer document: ${scenario}`, async t => {
    const h = panel(t, { config: badges, settings: { acquisitionBadges: null } });
    let epoch = 1;
    h.JE.session = { getEpoch: () => epoch, isCurrent: value => value === epoch };
    const get = deferred(), save = deferred();
    h.window.ApiClient.ajax = request => request.url.includes('/Localization/Cultures') ? Promise.resolve([]) : request.type === 'GET' ? get.promise : save.promise;
    h.load('enhanced/settingspanel/ui-panel.js');
    h.JE.initializeShortcuts = () => {};
    h.document.body.insertAdjacentHTML('beforeend', '<div id="jellyfin-enhanced-panel"></div>');
    h.JE.toCamelCase = value => value;
    h.wire();
    const reading = h.JE.showEnhancedPanel();
    if (scenario === 'pending save' || scenario === 'save completed') await h.choose('acquisitionBadgesSelect', 'off');
    if (scenario === 'save completed') { save.resolve(); await new Promise(done => setImmediate(done)); }
    if (scenario === 'session switch') {
      epoch++;
      h.JE.userConfig.settings = { acquisitionBadges: false };
      h.JE.currentSettings = h.JE.loadSettings();
    }
    get.resolve({ acquisitionBadges: scenario === 'fresh read' ? false : null });
    await reading;
    assert.equal(h.JE.currentSettings.acquisitionBadges, false, 'only an uncontested current-session read may update persisted');
    save.resolve();
    await new Promise(done => setImmediate(done));
  });
}

for (const [id, key, value, initial] of [
  ['nativePosterTagsToggle', 'useNativePosterTags', false, true],
  ['autoSeasonRequestsSelect', 'autoSeasonRequests', 'on', null],
  ['listStatusSelect', 'listStatus', 'off', null],
  ['pauseScreenDelayInput', 'pauseScreenDelaySeconds', '12', 5]
]) test(`shared settings store rolls back the other queued control ${id}`, async t => {
  const h = panel(t, { config: { ...badges, NativePosterTagsEnabled: true, ArrAutomationEngineEnabled: true, ArrListsEnabled: true, ArrListStatusEnabled: true }, settings: { [key]: initial } });
  h.wire();
  const held = deferred();
  h.window.ApiClient.ajax = request => request.type === 'POST' ? held.promise : Promise.resolve([]);
  h.expectConsoleError(/Failed to save settings.json/);
  const input = h.document.getElementById(id);
  if (input.type === 'checkbox') input.checked = value; else input.value = value;
  input.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await new Promise(done => setImmediate(done));
  held.reject(new Error('save fails'));
  await new Promise(done => setImmediate(done));
  assert.equal(h.JE.currentSettings[key], initial);
  assert.equal(h.JE.userConfig.settings[key], initial);
  if (input.type === 'checkbox') assert.equal(input.checked, initial);
  else assert.equal(input.value, initial === null ? '' : String(initial));
});

for (const startedPending of [false, true]) test(`a GET cannot undo a save that completes before its response; started pending ${startedPending}`, async t => {
  const h = panel(t, { config: badges, settings: { acquisitionBadges: null } });
  const get = deferred(), save = deferred();
  h.window.ApiClient.ajax = request => request.url.includes('/Localization/Cultures') ? Promise.resolve([]) : request.type === 'GET' ? get.promise : save.promise;
  h.wire();
  let reading;
  if (!startedPending) reading = h.JE.readUserSettings('settings.json');
  await h.choose('acquisitionBadgesSelect', 'off');
  if (startedPending) reading = h.JE.readUserSettings('settings.json');
  save.resolve();
  await new Promise(done => setImmediate(done));
  get.resolve({ acquisitionBadges: null });
  assert.equal(await reading, true);
  assert.equal(h.JE.currentSettings.acquisitionBadges, false);
  assert.equal(h.document.getElementById('acquisitionBadgesSelect').value, 'off');
});

test('fresh GET updates every view and invalidates an earlier successful POST dedup value', async t => {
  const h = panel(t, { config: badges, settings: { acquisitionBadges: null } });
  h.wire();
  await h.choose('acquisitionBadgesSelect', 'off');
  let posts = 0;
  h.window.ApiClient.ajax = async request => {
    if (request.type === 'GET') return { acquisitionBadges: null };
    posts++;
  };
  await h.JE.readUserSettings('settings.json');
  assert.equal(h.JE.currentSettings.acquisitionBadges, null);
  assert.equal(h.document.getElementById('acquisitionBadgesSelect').value, '');
  await h.choose('acquisitionBadgesSelect', 'off');
  assert.equal(posts, 1, 'another browser changed persisted: identical old data must POST again');
});

test('only the newest uncontested server read may supply the persisted baseline', async t => {
  const h = panel(t, { config: badges, settings: { acquisitionBadges: null } });
  const reads = [deferred(), deferred()];
  let n = 0;
  h.window.ApiClient.ajax = request => request.url.includes('/Localization/Cultures') ? Promise.resolve([]) : reads[n++].promise;
  h.wire();
  const first = h.JE.readUserSettings('settings.json'), second = h.JE.readUserSettings('settings.json');
  reads[1].resolve({ acquisitionBadges: false });
  await second;
  reads[0].resolve({ acquisitionBadges: null });
  await first;
  assert.equal(h.JE.currentSettings.acquisitionBadges, false);
  assert.equal(h.document.getElementById('acquisitionBadgesSelect').value, 'off');
});

test('other settings files have independent queues and do not replace the active settings view', async t => {
  const h = panel(t, { config: badges, settings: { acquisitionBadges: null } });
  const held = deferred(), calls = [];
  h.window.ApiClient.ajax = async request => {
    if (request.type === 'POST') calls.push(request.url);
    if (request.url.endsWith('bookmark.json')) await held.promise;
  };
  h.wire();
  const bookmark = h.JE.saveUserSettings('bookmark.json', { bookmarks: { one: { label: 'scene' } } });
  await h.choose('acquisitionBadgesSelect', 'off');
  assert.equal(calls.length, 2);
  assert.equal(h.JE.currentSettings.acquisitionBadges, false);
  held.resolve();
  await bookmark;
  assert.equal(h.JE.currentSettings.acquisitionBadges, false);
});

test('session changes close the outgoing settings panel through its cleanup handler', t => {
  const h = panel(t, { config: badges });
  h.load('core/navigation.js');
  h.load('core/session.js');
  h.load('enhanced/settingspanel/ui-panel.js');
  const wrapper = h.document.createElement('div');
  wrapper.id = 'jellyfin-enhanced-panel';
  wrapper.append(...h.document.body.childNodes);
  h.document.body.append(wrapper);
  let cleanups = 0;
  // The host owns removal/media/key cleanup; the identity handler invokes that existing close path.
  h.document.getElementById('closeSettingsPanel').addEventListener('click', () => { cleanups++; wrapper.remove(); });
  h.window.ApiClient.getCurrentUserId = () => 'user-b';
  h.JE.session.checkNow('test switch with panel open');
  assert.equal(cleanups, 1);
  assert.equal(h.document.getElementById('jellyfin-enhanced-panel'), null);
});

// Review round 7: callbacks belong to the panel's opening identity, including unfinished gestures.
for (const touch of [false, true]) for (const boundary of ['user switch', 'same-user new epoch', 'close']) {
  test(`subtitle ${touch ? 'touchend' : 'mouseup'} cannot save after ${boundary}`, async t => {
    const h = panel(t, { config: badges });
    let epoch = 1, user = 'user-a';
    h.window.ApiClient.getCurrentUserId = () => user;
    h.JE.session = { getEpoch: () => epoch, getServerId: () => 'server-a', isCurrent: n => n === epoch };
    h.load('enhanced/config.js');
    h.wire();
    const grid = h.document.getElementById('subtitlePositionGrid');
    grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
    const event = type => {
      const ev = new h.window.MouseEvent(type, { clientX: 20, clientY: 30, bubbles: true });
      if (touch) Object.defineProperty(ev, 'touches', { value: [{ clientX: 20, clientY: 30 }] });
      return ev;
    };
    grid.dispatchEvent(event(touch ? 'touchstart' : 'mousedown'));
    if (boundary === 'close') h.panelCleanups.forEach(cleanup => cleanup());
    else {
      epoch++;
      if (boundary === 'user switch') user = 'user-b';
      h.JE.userConfig.settings = { subtitleHorizontalPosition: 70, subtitleVerticalPosition: 80 };
      h.JE.currentSettings = h.JE.loadSettings();
    }
    h.document.dispatchEvent(event(touch ? 'touchmove' : 'mousemove'));
    h.document.dispatchEvent(event(touch ? 'touchend' : 'mouseup'));
    await new Promise(done => setImmediate(done));
    assert.equal(h.writes.length, 0, 'outgoing release must write neither identity');
    if (boundary !== 'close') {
      assert.equal(h.JE.currentSettings.subtitleHorizontalPosition, 70);
      assert.equal(h.JE.currentSettings.subtitleVerticalPosition, 80);
    }
  });
}

test('closing removes every document gesture listener and stale callbacks cannot restart a gesture', async t => {
  const h = panel(t, { config: badges });
  const added = [], removed = [];
  const add = h.document.addEventListener.bind(h.document), remove = h.document.removeEventListener.bind(h.document);
  h.document.addEventListener = (type, fn, options) => { added.push([type, fn]); add(type, fn, options); };
  h.document.removeEventListener = (type, fn, options) => { removed.push([type, fn]); remove(type, fn, options); };
  h.wire();
  h.panelCleanups.forEach(cleanup => cleanup());
  for (const [type, fn] of added.filter(([type]) => /^(mouse|touch)/.test(type))) {
    assert.ok(removed.some(([rType, rFn]) => rType === type && rFn === fn), `${type} leaked`);
    fn(new h.window.MouseEvent(type, { clientX: 20, clientY: 30 }));
  }
  const grid = h.document.getElementById('subtitlePositionGrid');
  grid.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
  grid.dispatchEvent(new h.window.MouseEvent('mousedown', { clientX: 20, clientY: 30 }));
  h.document.dispatchEvent(new h.window.MouseEvent('mouseup'));
  await new Promise(done => setImmediate(done));
  assert.equal(h.writes.length, 0);
});

for (const id of ['acquisitionBadgesSelect', 'subtitlePositionReset', 'pauseScreenDelayInput']) {
  test(`detached ${id} handler cannot save in a later identity epoch`, async t => {
    const h = panel(t, { config: badges });
    let epoch = 1;
    h.JE.session = { getEpoch: () => epoch, isCurrent: n => n === epoch };
    h.wire();
    epoch++;
    const control = h.document.getElementById(id);
    control.value = id === 'acquisitionBadgesSelect' ? 'off' : '12';
    control.dispatchEvent(new h.window.Event(id === 'subtitlePositionReset' ? 'click' : 'change', { bubbles: true }));
    await new Promise(done => setImmediate(done));
    assert.equal(h.writes.length, 0);
  });
}
