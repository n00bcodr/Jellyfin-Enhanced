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
  if (id !== 'listStatusSelect') h.expectConsoleError(/Failed to save settings.json/);
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

// Review round 8: a submitted write outlives its panel, but never its identity session.
const tick = () => new Promise(done => setImmediate(done));
function completionSession(h) {
  let epoch = 1, user = 'user-a', server = 'server-a';
  h.window.ApiClient.getCurrentUserId = () => user;
  h.JE.session = { getEpoch: () => epoch, getServerId: () => server, isCurrent: n => n === epoch };
  return boundary => {
    if (boundary === 'close') h.panelCleanups.forEach(cleanup => cleanup());
    else if (boundary === 'user switch') user = 'user-b';
    else if (boundary === 'server switch') server = 'server-b';
    else epoch++;
  };
}
async function languagePanel(t, initial = 'en', target = 'fr') {
  const h = panel(t, { config: badges, settings: { displayLanguage: initial } });
  const transition = completionSession(h), timers = [];
  h.window.localStorage.setItem('user-a-language', initial);
  h.window.localStorage.setItem('user-b-language', 'en');
  h.window.setTimeout = (callback, ms) => { timers.push({ callback, ms }); return timers.length; };
  h.window.fetch = async () => ({ ok: false });
  h.window.ApiClient.ajax = async request => request.url.includes('/locales') ? ['en-US', 'fr'] : [];
  h.load('enhanced/settingspanel/ui-panel-language.js');
  h.JE.internals.enhancedUi.wireLanguageControls({ panelCleanups: h.panelCleanups, resetAutoCloseTimer() {} });
  await tick();
  const held = deferred();
  h.window.ApiClient.ajax = request => { if (request.type === 'GET') return Promise.resolve([]); h.writes.push(request); return held.promise; };
  await h.choose('displayLanguageSelect', target);
  assert.equal(h.writes.length, 1, 'POST has been submitted before the boundary');
  assert.equal(h.window.localStorage.getItem('user-a-language'), initial);
  return { ...h, held, transition, timers };
}
function expectReload(h, expected) {
  const before = h.errors.length;
  h.timers.filter(timer => timer.ms === 1500).forEach(timer => timer.callback());
  const errors = h.errors.splice(before);
  assert.equal(errors.length, expected ? 1 : 0, 'reload reaches the browser only in the captured session');
  if (expected) assert.match(errors[0].message, /Not implemented: navigation/);
}
for (const boundary of ['close', 'user switch', 'same-user new epoch', 'server switch']) {
  test(`submitted French save completes under its session after ${boundary}`, async t => {
    const h = await languagePanel(t);
    h.transition(boundary);
    h.held.resolve();
    await tick();
    const current = boundary === 'close';
    assert.equal(h.window.localStorage.getItem('user-a-language'), current ? 'fr' : 'en');
    assert.equal(h.window.localStorage.getItem('user-b-language'), 'en');
    assert.equal(h.toasts.length, current ? 1 : 0);
    assert.equal(h.timers.filter(timer => timer.ms === 1500).length, current ? 1 : 0);
    expectReload(h, current);
  });
  test(`French reload scheduled after success respects later ${boundary}`, async t => {
    const h = await languagePanel(t);
    h.held.resolve(); await tick();
    assert.equal(h.window.localStorage.getItem('user-a-language'), 'fr');
    h.transition(boundary);
    expectReload(h, boundary === 'close');
  });
}
test('failed French save does not mirror or reload after close', async t => {
  const h = await languagePanel(t);
  h.transition('close');
  h.allowConsoleError('Failed to save settings.json');
  h.held.reject(new Error('save failed')); await tick();
  assert.equal(h.window.localStorage.getItem('user-a-language'), 'en');
  assert.equal(h.toasts.length, 0);
  assert.equal(h.timers.length, 0);
});
for (const id of ['listPlaceholdersSelect', 'listStatusSelect', 'listSwapInSelect', 'acquisitionBadgesSelect', 'nativeAcquisitionStampsSelect']) {
  for (const boundary of ['close', 'user switch', 'same-user new epoch', 'server switch']) {
    test(`${id} submitted save follow-up survives only panel close: ${boundary}`, async t => {
      const h = panel(t, { config: { ...badges, ArrListsEnabled: true, ArrListStatusEnabled: true, ArrListSwapInEnabled: true } });
      const transition = completionSession(h), held = deferred();
      h.window.ApiClient.ajax = request => { if (request.type === 'GET') return Promise.resolve([]); h.writes.push(request); return held.promise; };
      h.wire();
      await h.choose(id, id === 'listSwapInSelect' ? 'on' : 'off');
      assert.equal(h.writes.length, 1);
      transition(boundary); held.resolve(); await tick();
      assert.equal(h.toasts.length, boundary === 'close' ? 1 : 0);
    });
  }
}

test('failed French save in an open panel does not mirror or reload', async t => {
  const h = await languagePanel(t);
  h.allowConsoleError('Failed to save settings.json');
  h.held.reject(new Error('save failed')); await tick();
  assert.equal(h.window.localStorage.getItem('user-a-language'), 'en');
  assert.equal(h.toasts.length, 0);
  assert.equal(h.timers.length, 0);
});

for (const boundary of ['close', 'user switch', 'same-user new epoch', 'server switch']) {
  test(`clear translation cache reload respects its captured session after ${boundary}`, async t => {
    const h = panel(t), transition = completionSession(h), timers = [];
    h.window.setTimeout = callback => { timers.push(callback); return timers.length; };
    h.load('enhanced/settingspanel/ui-panel-language.js');
    // Isolate the cache button from unrelated locale enumeration.
    h.document.getElementById('displayLanguageSelect').remove();
    h.JE.internals.enhancedUi.wireLanguageControls({ panelCleanups: h.panelCleanups, resetAutoCloseTimer() {} });
    h.document.getElementById('clearTranslationCacheButton').click();
    transition(boundary);
    const before = h.errors.length;
    timers.forEach(callback => callback());
    const errors = h.errors.splice(before);
    assert.equal(errors.length, boundary === 'close' ? 1 : 0);
    if (errors.length) assert.match(errors[0].message, /Not implemented: navigation/);
  });
}
test('async view work cannot install a listener after cleanup', t => {
  const h = panel(t), ctx = { panelCleanups: h.panelCleanups };
  const scope = h.JE.internals.settingsPanelScope(ctx), target = h.document.createElement('input');
  let added = 0;
  target.addEventListener = () => added++;
  scope.close();
  scope.listen(target, 'change', () => {});
  assert.equal(added, 0);
});
for (const id of ['listPlaceholdersSelect', 'listStatusSelect', 'listSwapInSelect']) {
  test(`${id} failed submitted save never reports saved after close`, async t => {
    const h = panel(t, { config: { ArrListsEnabled: true, ArrListStatusEnabled: true, ArrListSwapInEnabled: true } });
    const held = deferred();
    h.wire();
    h.window.ApiClient.ajax = () => held.promise;
    h.allowConsoleError('Failed to save settings.json');
    await h.choose(id, id === 'listSwapInSelect' ? 'on' : 'off'); h.panelCleanups.forEach(cleanup => cleanup());
    held.reject(new Error('save failed')); await tick();
    assert.equal(h.toasts.length, 0);
  });
}

// Review round 9: effects follow the committed whole document, even when another input carries the choice.
for (const [initial, target] of [['en', 'fr'], ['fr', 'en-US']]) {
  for (const firstSuccess of [false, true]) for (const secondSuccess of [false, true]) {
    test(`persisted language ${initial}→${target} follows overlapping commits ${firstSuccess}/${secondSuccess}`, async t => {
      const h = await languagePanel(t, initial, target), second = deferred();
      h.wire();
      h.window.ApiClient.ajax = request => { h.writes.push(request); return second.promise; };
      await h.choose('nativeAcquisitionStampsSelect', 'off');
      assert.equal(h.writes.length, 1, 'second whole document is queued');
      if (firstSuccess) h.held.resolve(); else h.held.reject(new Error('first fails'));
      await tick();
      assert.equal(h.writes.length, 2);
      assert.equal(JSON.parse(h.writes[1].data).displayLanguage, target);
      if (secondSuccess) second.resolve(); else second.reject(new Error('second fails'));
      await tick();
      const saved = firstSuccess || secondSuccess;
      assert.equal(h.window.localStorage.getItem('user-a-language'), saved ? target : initial);
      assert.equal(h.JE.userConfig.settings.displayLanguage, saved ? target : initial);
      assert.equal(h.toasts.filter(message => message === tr('toast_language_changed')).length, saved ? 1 : 0);
      assert.equal(h.timers.filter(timer => timer.ms === 1500).length, saved ? 1 : 0);
      expectReload(h, saved);
    });
  }
  for (const boundary of ['close', 'user switch', 'same-user new epoch', 'server switch']) {
    test(`carried language ${target} respects ${boundary} before second completion`, async t => {
      const h = await languagePanel(t, initial, target), second = deferred();
      h.wire();
      h.window.ApiClient.ajax = request => { h.writes.push(request); return second.promise; };
      await h.choose('nativeAcquisitionStampsSelect', 'off');
      h.held.reject(new Error('language POST fails')); await tick();
      assert.equal(h.writes.length, 2);
      h.transition(boundary);
      second.resolve(); await tick();
      const current = boundary === 'close';
      assert.equal(h.window.localStorage.getItem('user-a-language'), current ? target : initial);
      assert.equal(h.window.localStorage.getItem('user-b-language'), 'en');
      assert.equal(h.toasts.filter(message => message === tr('toast_language_changed')).length, current ? 1 : 0);
      expectReload(h, current);
    });
  }
}

test('accepted server language read mirrors without a toast or reload, even without a language panel', async t => {
  const h = panel(t, { settings: { displayLanguage: 'en' } }), timers = [];
  h.window.localStorage.setItem('user-a-language', 'en');
  h.window.setTimeout = callback => { timers.push(callback); };
  h.window.ApiClient.ajax = async () => ({ displayLanguage: 'pt-br' });
  await h.JE.readUserSettings('settings.json');
  assert.equal(h.window.localStorage.getItem('user-a-language'), 'pt-BR');
  assert.equal(h.JE.currentSettings.displayLanguage, 'pt-br');
  assert.equal(h.toasts.length, 0);
  assert.equal(timers.length, 0);
});

for (const [id, key, initial, target, toast] of [
  ['acquisitionBadgesSelect', 'acquisitionBadges', false, '', 'toast_badge_settings_saved'],
  ['nativeAcquisitionStampsSelect', 'nativeAcquisitionStamps', null, 'off', 'toast_badge_settings_saved'],
  ['listPlaceholdersSelect', 'listPlaceholders', null, 'off', 'toast_list_settings_saved'],
  ['listStatusSelect', 'listStatus', null, 'off', 'toast_list_settings_saved'],
  ['nativePosterTagsToggle', 'useNativePosterTags', true, false, 'toast_native_poster_tags_saved'],
  ['autoSeasonRequestsSelect', 'autoSeasonRequests', null, 'off', 'toast_auto_requests_saved'],
  ['autoMovieRequestsSelect', 'autoMovieRequests', null, 'off', 'toast_auto_requests_saved']
]) for (const carried of [false, true]) {
  test(`${key} saved notification follows authoritative ${carried ? 'carried commit' : 'failure'}`, async t => {
    const h = panel(t, { config: { ...badges, NativePosterTagsEnabled: true, ArrListsEnabled: true,
      ArrListStatusEnabled: true, ArrAutomationEngineEnabled: true }, settings: { [key]: initial } });
    const held = [deferred(), deferred()];
    h.window.ApiClient.ajax = request => {
      if (request.type === 'GET') return Promise.resolve([]);
      h.writes.push(request); return held[h.writes.length - 1].promise;
    };
    h.wire();
    const control = h.document.getElementById(id);
    if (control.type === 'checkbox') control.checked = target; else control.value = target;
    control.dispatchEvent(new h.window.Event('change', { bubbles: true })); await tick();
    assert.equal(h.toasts.length, 0, 'never claim saved before persistence');
    const later = h.JE.updateSettings({ showFileSizes: true }, { throwOnError: true }).catch(() => {});
    h.allowConsoleError('Failed to save settings.json');
    held[0].reject(new Error('original fails')); await tick();
    assert.equal(h.toasts.length, 0, 'failed original never claims saved');
    if (carried) held[1].resolve(); else held[1].reject(new Error('later fails'));
    await later;
    assert.deepEqual(h.toasts, carried ? [tr(toast)] : []);
    if (key === 'acquisitionBadges' && carried) assert.equal(h.resets.at(-1), null, 'carried Show refreshes cards');
  });
}

for (const carried of [false, true]) test(`applied subtitle styles and position follow ${carried ? 'carried commit' : 'failed documents'}`, async t => {
  const h = panel(t, { settings: { subtitleHorizontalPosition: 50, subtitleVerticalPosition: 95, selectedFontSizePresetIndex: 2 } });
  const applied = [], held = [deferred(), deferred()];
  h.JE.applySavedStylesWhenReady = () => applied.push(['style', h.JE.currentSettings.selectedFontSizePresetIndex]);
  h.JE.applySubtitlePosition = () => applied.push(['position', h.JE.currentSettings.subtitleHorizontalPosition]);
  h.wire();
  let post = 0;
  h.window.ApiClient.ajax = () => held[post++].promise;
  const first = h.JE.updateSettings({ subtitleHorizontalPosition: 20, selectedFontSizePresetIndex: 1 }, { throwOnError: true }).catch(() => {});
  const second = h.JE.updateSettings({ showFileSizes: true }, { throwOnError: true }).catch(() => {});
  held[0].reject(new Error('style POST fails')); await tick();
  if (carried) held[1].resolve(); else held[1].reject(new Error('later fails'));
  await Promise.all([first, second]);
  assert.deepEqual(applied.slice(-2), [['style', carried ? 1 : 2], ['position', carried ? 20 : 50]]);
});

test('consent-only success cannot persist or mirror a failed display language', async t => {
  const h = await languagePanel(t), consent = deferred();
  h.window.ApiClient.ajax = request => { h.writes.push(request); return consent.promise; };
  const saving = h.JE.setPersonalConsent('listSwapIn', true, { throwOnError: true });
  h.held.reject(new Error('language fails')); await tick();
  assert.equal(h.writes[1].type, 'PATCH');
  consent.resolve({ consents: { ListSwapIn: true } }); await saving;
  assert.equal(h.JE.userConfig.settings.displayLanguage, 'en');
  assert.equal(h.window.localStorage.getItem('user-a-language'), 'en');
  assert.equal(h.toasts.filter(message => message === tr('toast_language_changed')).length, 0);
  expectReload(h, false);
});

test('a read while French is pending mirrors only persisted English, never the shown choice', async t => {
  const h = await languagePanel(t);
  h.window.ApiClient.ajax = async () => ({ displayLanguage: 'fr' });
  await h.JE.readUserSettings('settings.json');
  assert.equal(h.JE.currentSettings.displayLanguage, 'fr', 'pending choice still shown');
  assert.equal(h.window.localStorage.getItem('user-a-language'), 'en');
  assert.equal(h.toasts.length, 0);
  h.held.reject(new Error('language fails')); await tick();
  expectReload(h, false);
});

test('an unrelated settings commit mirrors Auto language as an empty value without a language panel', async t => {
  const h = panel(t, { settings: { displayLanguage: '' } });
  h.window.localStorage.setItem('user-a-language', 'fr');
  await h.JE.updateSettings({ showFileSizes: true }, { throwOnError: true });
  assert.equal(h.window.localStorage.getItem('user-a-language'), '');
});

for (const kind of ['quality tags', 'tag hover', 'random button', 'subtitle styles']) {
  for (const carried of [false, true]) test(`document projection restores ${kind} after overlapping ${carried ? 'carried commit' : 'failures'}`, async t => {
    const key = { 'quality tags': 'qualityTagsEnabled', 'tag hover': 'tagsHideOnHover', 'random button': 'randomButtonEnabled', 'subtitle styles': 'disableCustomSubtitleStyles' }[kind];
    const id = { 'quality tags': 'qualityTagsToggle', 'tag hover': 'tagsHideOnHoverToggle', 'random button': 'randomButtonToggle', 'subtitle styles': 'disableCustomSubtitleStyles' }[kind];
    const h = panel(t, { settings: { [key]: true } }), held = [deferred(), deferred()];
    h.document.body.classList.add('je-tags-hide-on-hover');
    h.document.body.insertAdjacentHTML('beforeend', '<div class="quality-overlay-container"></div><div id="randomItemButtonContainer"></div>');
    let applied = true;
    h.JE.initializeQualityTags = () => h.document.body.insertAdjacentHTML('beforeend', '<div class="quality-overlay-container"></div>');
    h.JE.addRandomButton = () => {
      h.document.getElementById('randomItemButtonContainer')?.remove();
      if (h.JE.currentSettings.randomButtonEnabled) h.document.body.insertAdjacentHTML('beforeend', '<div id="randomItemButtonContainer"></div>');
    };
    h.JE.applySavedStylesWhenReady = () => { applied = h.JE.currentSettings.disableCustomSubtitleStyles; };
    h.wire();
    h.window.ApiClient.ajax = req => {
      if (req.type === 'GET') return Promise.resolve([]);
      h.writes.push(req); return held[h.writes.length - 1].promise;
    };
    const input = h.document.getElementById(id);input.checked = false;
    input.dispatchEvent(new h.window.Event('change', { bubbles: true }));await tick();
    const later = h.JE.updateSettings({ showFileSizes: true }, { throwOnError: true }).catch(() => {});
    h.allowConsoleError('Failed to save settings.json');held[0].reject(new Error('first fails'));await tick();
    if (carried) held[1].resolve();else held[1].reject(new Error('second fails'));
    await later;
    assert.equal(h.JE.currentSettings[key], !carried);
    if (kind === 'quality tags') assert.equal(!!h.document.querySelector('.quality-overlay-container'), !carried);
    if (kind === 'tag hover') assert.equal(h.document.body.classList.contains('je-tags-hide-on-hover'), !carried);
    if (kind === 'random button') assert.equal(!!h.document.getElementById('randomItemButtonContainer'), !carried);
    if (kind === 'subtitle styles') assert.equal(applied, !carried);
  });
}

test('a legacy whole-document writer projects subtitle styles and pause delay without an open panel', async t => {
  const h = panel(t), calls = [];
  h.JE.pauseScreenInstance = {};
  h.JE.applySavedStylesWhenReady = () => calls.push(h.JE.currentSettings.selectedFontSizePresetIndex);
  h.JE.currentSettings.selectedFontSizePresetIndex = 1;
  h.JE.currentSettings.pauseScreenDelaySeconds = 12;
  await h.JE.saveUserSettings('settings.json', h.JE.currentSettings, { throwOnError: true });
  assert.equal(h.JE.pauseScreenInstance.pauseScreenDelayMs, 12000);
  assert.deepEqual(calls, [1]);
});

test('quality audio filter rolls back through document observers after close', async t => {
  const h = panel(t, { settings: { qualityTagsEnabled: true, qualityTagsPreferredAudioLanguage: '', selectedFontSizePresetIndex: 2 } });
  const applied = [];
  h.JE.reinitializeQualityTags = () => applied.push(h.JE.currentSettings.qualityTagsPreferredAudioLanguage);
  h.wire();
  const held = [deferred(), deferred()];let n = 0;
  h.window.ApiClient.ajax = () => held[n++].promise;
  await h.choose('qualityTagsAudioLanguageSelect', 'none');
  const later = h.JE.updateSettings({ showFileSizes: true }, { throwOnError: true }).catch(() => {});
  h.panelCleanups.forEach(fn => fn());h.allowConsoleError('Failed to save settings.json');
  held[0].reject(new Error('first fails'));await tick();held[1].reject(new Error('second fails'));await later;
  assert.equal(applied.at(-1), '');
});


test('subtitle preset preview rolls back through document observers after close', async t => {
  const h = panel(t, { settings: { selectedFontSizePresetIndex: 2 } });
  h.JE.fontSizePresets[1] = { ...preset, size: 0.5 };
  h.JE.applySubtitleStyles = () => {};
  h.wire();
  h.JE.internals.enhancedUi.wireMiscSettingsControls({ panelCleanups: h.panelCleanups, help: h.document.body, primaryAccentColor: '#123456', resetAutoCloseTimer() {} });
  await tick();
  const held = [deferred(), deferred()];let n = 0;
  h.window.ApiClient.ajax = () => held[n++].promise;
  h.document.querySelector('#font-size-presets-container [data-preset-index="1"]').click();await tick();
  assert.equal(h.document.getElementById('subtitlePositionPreview').style.fontSize, '8px');
  const later = h.JE.updateSettings({ showFileSizes: true }, { throwOnError: true }).catch(() => {});
  h.panelCleanups.forEach(fn => fn());h.allowConsoleError('Failed to save settings.json');
  held[0].reject(new Error('first fails'));await tick();held[1].reject(new Error('second fails'));await later;
  assert.equal(h.document.getElementById('subtitlePositionPreview').style.fontSize, '13px');
});

for (const type of ['quality', 'rating']) test(`${type} section visibility follows document rollback`, async t => {
  const h=panel(t,{settings:{[type+'TagsEnabled']:true}});h.wire();const held=deferred();
  h.window.ApiClient.ajax=()=>held.promise;h.allowConsoleError('Failed to save settings.json');
  const input=h.document.getElementById(type+'TagsToggle');input.checked=false;input.dispatchEvent(new h.window.Event('change',{bubbles:true}));await tick();
  assert.equal(h.document.getElementById(type+'TagsSubWrap').style.display,'none');
  held.reject(Error('save fails'));await tick();
  assert.equal(input.checked,true);assert.equal(h.document.getElementById(type+'TagsSubWrap').style.display,'block');
});

test('quality category DOM order follows a failed reorder',async t=>{
 const h=panel(t,{settings:{qualityTagsEnabled:true}});h.wire();const group=h.document.getElementById('qualityTagsSubToggles');
 const order=()=>[...group.querySelectorAll('.je-quality-cat-row')].map(r=>r.dataset.orderKey),before=order(),held=deferred();
 h.window.ApiClient.ajax=()=>held.promise;h.allowConsoleError('Failed to save settings.json');
 group.querySelector('.je-cat-down').click();await tick();assert.notDeepEqual(order(),before);
 held.reject(Error('reorder fails'));await tick();assert.deepEqual(order(),before);
});

test('subtitle warnings follow document rollback',async t=>{
 const h=panel(t,{settings:{disableCustomSubtitleStyles:false}});h.wire();const note=h.document.getElementById('je-subtitle-position-note'),held=deferred();
 h.window.ApiClient.ajax=()=>held.promise;h.allowConsoleError('Failed to save settings.json');
 const input=h.document.getElementById('disableCustomSubtitleStyles');input.checked=true;input.dispatchEvent(new h.window.Event('change',{bubbles:true}));await tick();
 assert.equal(note.style.display,'none');held.reject(Error('style disable fails'));await tick();assert.equal(note.style.display,'flex');
});

test('late language enumeration renders the current document rather than its opening snapshot',async t=>{
 const h=panel(t,{settings:{displayLanguage:'en-US'}}),locales=deferred();h.wire();h.window.fetch=async()=>({ok:false});h.window.setTimeout=()=>1;
 h.window.ApiClient.ajax=req=>req.url.includes('/locales')?locales.promise:Promise.resolve([]);
 h.load('enhanced/settingspanel/ui-panel-language.js');h.JE.internals.enhancedUi.wireLanguageControls({panelCleanups:h.panelCleanups,resetAutoCloseTimer(){}});
 await h.JE.updateSettings({displayLanguage:'fr'},{throwOnError:true});locales.resolve(['en-US','fr']);await tick();
 assert.equal(h.document.getElementById('displayLanguageSelect').value,'fr');
});

test('late random-source options render the current document rather than the opening source',async t=>{
 const h=panel(t,{settings:{randomSourceId:'old'}}),sources=deferred();h.wire();
 h.window.ApiClient.ajax=req=>req.type==='GET'?sources.promise:Promise.resolve([]);
 h.JE.internals.enhancedUi.wireMiscSettingsControls({panelCleanups:h.panelCleanups,help:h.document.body,primaryAccentColor:'#123456',resetAutoCloseTimer(){}});
 await h.JE.updateSettings({randomSourceId:'new'},{throwOnError:true});sources.resolve({Items:[{Id:'old',Name:'Old',Type:'Playlist'},{Id:'new',Name:'New',Type:'Playlist'}]});await tick();
 assert.equal(h.document.getElementById('randomSourceSelect').value,'new');
});
