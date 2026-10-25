import { clickAsViewer } from '../helpers/harness.mjs';
// Phase 4e (D29): each person's acquisition-badge preferences in the JE settings panel. Both are display preferences:
// unset/null follows the household, "Hide" is false. The box only exists while acquisition badges are on; the native
// select only while the native stamps are on too; untouched choices are never written; the web choice reaches the
// poster cards without a reload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, deferred, jsRoot } from '../helpers/harness.mjs';
import { shippedLocales } from '../helpers/served-scripts.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const tr = key => (key in en ? en[key] : key);
const preset = { name: 'p', previewText: 'Aa', size: 1, family: 'sans-serif', bgColor: '#000', textColor: '#fff' };
// Stage 1 fix round 7: a settings save is a PATCH of the fields it changes ({ Set }), never a whole document.
/** A settings save (a field PATCH, or a whole POST of another file), not the consent operation or a read. */
const isSave = request => request.type === 'POST' || (request.type === 'PATCH' && !String(request.url).endsWith('/consent'));
/** The fields a settings save sent. */
const sent = request => { const body = JSON.parse(request.data); return body.Set || body; };
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The real panel template (and, when wired, the real settings listeners) with the panel's helpers stubbed. */
function panel(tt, { config = {}, settings = {}, translate = tr, policy = 'served' } = {}) {
  const writes = [], toasts = [], panelCleanups = [];
  const h = createHarness({
    JE: {
      pluginConfig: { Shortcuts: [], ...config }, userConfig: { settings: { ...settings }, shortcuts: { Shortcuts: [] }, bookmark: { bookmarks: {} } }, currentSettings: {},
      t: translate, toast: message => toasts.push(message), escapeHtml, icon: () => '', IconName: new Proxy({}, { get: (_, k) => String(k) }),
      icons: { wrapEmoji: s => s }, state: { activeShortcuts: {} }, pluginVersion: '0.0.0',
      fontSizePresets: [preset, preset, preset, preset], fontFamilyPresets: [preset], subtitlePresets: [preset], subtitleTextEffectPresets: [preset],
      decodeSubtitleColor: () => ({ swatch: '#FFFFFF', alpha: 255, alphaValue: 255 }), getSubtitleTextShadow: () => 'none'
    },
    // Settings saves are PATCHes; the panel also reads the server's cultures (answered empty).
    apiClient: { ajax: async request => { if (isSave(request)) writes.push(request); return []; } }
  });
  tt.after(() => h.close());
  // The language rule the store's mirror and the language panel write by (loaded before the settings store, as in
  // production). Without it: 'blocked' (the script never loaded) or 'unserved' (the file as committed, no policy line).
  if (policy === 'served') h.load('enhanced/translations.js');
  else if (policy === 'unserved') h.window.eval(`[function () {\n${readFileSync(resolve(jsRoot, 'enhanced/translations.js'), 'utf8')}\n}][0]();`);
  h.load('core/mutation-queue.js'); h.load('enhanced/config.js');
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
  let saved = sent(h.writes.at(-1));
  assert.equal(saved.acquisitionBadges, false);
  assert.ok(!('nativeAcquisitionStamps' in saved));
  assert.equal(h.JE.userConfig.settings.acquisitionBadges, false);
  assert.deepEqual(h.toasts, [tr('toast_badge_settings_saved')]);
  assert.deepEqual(h.resets, [false], 'the poster cards are reset with the new choice in place');
  await h.choose('nativeAcquisitionStampsSelect', 'off');
  saved = sent(h.writes.at(-1));
  assert.equal(saved.nativeAcquisitionStamps, false);
  assert.equal(h.resets.length, 1, 'the native choice does not touch the web cards');
  await h.choose('acquisitionBadgesSelect', '');
  assert.equal(sent(h.writes.at(-1)).acquisitionBadges, null);
  assert.deepEqual(h.resets, [false, null]);
  await h.choose('nativeAcquisitionStampsSelect', '');
  assert.equal(sent(h.writes.at(-1)).nativeAcquisitionStamps, null);
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
      if (!isSave(request)) return [];
      const n = posted.length;
      posted.push(sent(request));
      await held[n].promise;
      persisted = { ...persisted, ...posted[n] };
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
  h.load('core/mutation-queue.js'); h.load('enhanced/config.js');
  h.JE.currentSettings = h.JE.loadSettings();
  h.wire();
  const held = deferred();
  const posted = [];
  h.window.ApiClient.ajax = request => {
    if (!isSave(request)) return Promise.resolve([]);
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
      // The incoming session's boot read hands out a new userConfig object (plugin.js).
      h.JE.userConfig = { ...h.JE.userConfig, settings: { acquisitionBadges: false } };
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
  ['homeRowSoonSelect', 'homeRowSoon', 'off', null],
  ['pauseScreenDelayInput', 'pauseScreenDelaySeconds', '12', 5]
]) test(`shared settings store rolls back the other queued control ${id}`, async t => {
  const h = panel(t, { config: { ...badges, NativePosterTagsEnabled: true, ArrAutomationEngineEnabled: true, ArrListsEnabled: true, ArrListStatusEnabled: true, ArrHomeRowsEnabled: true }, settings: { [key]: initial } });
  h.wire();
  const held = deferred();
  // The automatic-request choice is a consent: it goes through the consent operation (PATCH), never a whole document.
  h.window.ApiClient.ajax = request => (request.type === 'POST' || request.type === 'PATCH') ? held.promise : Promise.resolve([]);
  if (!['listStatusSelect', 'autoSeasonRequestsSelect', 'homeRowSoonSelect'].includes(id)) h.expectConsoleError(/Failed to save settings.json/);
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
    if (isSave(request)) calls.push(request.url);
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
    h.load('core/mutation-queue.js'); h.load('enhanced/config.js');
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
      h.JE.userConfig = { ...h.JE.userConfig, settings: { subtitleHorizontalPosition: 70, subtitleVerticalPosition: 80 } };
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
// Dashcrash §7 (integration rebuild): the language panel saves only a supported language tag; anything else is Auto.
// Stage 1 fix round 3 (RBS1-R3-2): by the shared policy (a shipped bundle, exactly or by base language), saved in canonical
// case, whatever the browser knows.
for (const [chosen, saved] of [['zz-ZZ', ''], ['fr', 'fr'], ['', ''], ['haw-AU', ''], ['kok-GB', ''], ['ja', ''], ['pt-br', 'pt-BR']]) test(`choosing ${JSON.stringify(chosen)} in the language panel saves ${JSON.stringify(saved)}`, async t => {
  const h = panel(t, { config: badges, settings: { displayLanguage: 'en' } });
  h.window.fetch = async () => ({ ok: false });
  h.window.ApiClient.ajax = async request => request.url.includes('/locales') ? ['en-US', 'fr', 'zz-ZZ'] : [];
  h.load('enhanced/settingspanel/ui-panel-language.js');
  h.JE.internals.enhancedUi.wireLanguageControls({ panelCleanups: h.panelCleanups, resetAutoCloseTimer() {} });
  await tick();
  const select = h.document.getElementById('displayLanguageSelect');
  for (const code of ['', chosen]) if (![...select.options].some(o => o.value === code)) select.appendChild(Object.assign(h.document.createElement('option'), { value: code, textContent: code || 'Auto' }));
  h.window.ApiClient.ajax = async request => { if (isSave(request)) h.writes.push(request); return []; };
  await h.choose('displayLanguageSelect', chosen);
  // Fix round 4 (RBS1-R4-2): the select shows what the store holds (the saved tag), never the tampered option chosen.
  assert.equal(select.value, saved);
  assert.equal(sent(h.writes.at(-1)).displayLanguage, saved);
});

// The panel shows what the server stored once the save is answered, and offers only languages the policy accepts: a
// locale newer than this build on GitHub is listed only when it resolves to a shipped bundle (en-AU; not ja or haw).
for (const [chosen, stored] of [['haw-AU', ''], ['kok-GB', ''], ['en-AU', 'en-AU']]) test(`after choosing ${chosen} the panel shows the stored ${JSON.stringify(stored)}`, async t => {
  const h = panel(t, { config: badges, settings: { displayLanguage: 'fr' } });
  h.wire();
  h.window.fetch = async () => ({ ok: true, json: async () => ['ja.json', 'haw.json', 'en-AU.json', 'fr.json'].map(name => ({ name })) });
  h.window.ApiClient.ajax = async request => request.url.includes('/locales') ? ['en-US', 'fr'] : [];
  h.load('enhanced/settingspanel/ui-panel-language.js');
  h.JE.internals.enhancedUi.wireLanguageControls({ panelCleanups: h.panelCleanups, resetAutoCloseTimer() {} });
  await tick();
  const select = h.document.getElementById('displayLanguageSelect');
  const offered = [...select.options].map(o => o.value);
  assert.ok(offered.includes('en-AU') && offered.includes('fr'), offered.join());
  assert.ok(!offered.includes('ja') && !offered.includes('haw'), offered.join());
  if (!offered.includes(chosen)) select.appendChild(Object.assign(h.document.createElement('option'), { value: chosen, textContent: chosen }));
  h.window.ApiClient.ajax = async request => { if (!isSave(request)) return []; h.writes.push(request); return { success: true, consents: {}, displayLanguage: stored }; };
  await h.choose('displayLanguageSelect', chosen);
  await tick();
  assert.equal(select.value, stored);
  assert.equal(h.window.localStorage.getItem('user-a-language'), stored);
});

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
    clickAsViewer(h.document.getElementById('clearTranslationCacheButton'));
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

// Review round 9, stage 1 fix round 7: effects follow the committed document. A save sends only its own fields, so a
// later save never carries an earlier choice: the language is saved by its own save or not at all.
for (const [initial, target] of [['en', 'fr'], ['fr', 'en-US']]) {
  for (const firstSuccess of [false, true]) for (const secondSuccess of [false, true]) {
    test(`persisted language ${initial}→${target} follows its own commit, never a later one: ${firstSuccess}/${secondSuccess}`, async t => {
      const h = await languagePanel(t, initial, target), second = deferred();
      h.wire();
      h.window.ApiClient.ajax = request => { h.writes.push(request); return second.promise; };
      await h.choose('nativeAcquisitionStampsSelect', 'off');
      assert.equal(h.writes.length, 1, 'the second save is queued');
      if (firstSuccess) h.held.resolve(); else h.held.reject(new Error('first fails'));
      await tick();
      assert.equal(h.writes.length, 2);
      assert.deepEqual(sent(h.writes[1]), { nativeAcquisitionStamps: false }, 'the later save carries only its own field');
      if (secondSuccess) second.resolve(); else second.reject(new Error('second fails'));
      await tick();
      const saved = firstSuccess;
      assert.equal(h.window.localStorage.getItem('user-a-language'), saved ? target : initial);
      assert.equal(h.JE.userConfig.settings.displayLanguage, saved ? target : initial);
      assert.equal(h.toasts.filter(message => message === tr('toast_language_changed')).length, saved ? 1 : 0);
      assert.equal(h.timers.filter(timer => timer.ms === 1500).length, saved ? 1 : 0);
      expectReload(h, saved);
    });
  }
  for (const boundary of ['close', 'user switch', 'same-user new epoch', 'server switch']) {
    test(`a failed language ${target} is not carried by a later save completing after ${boundary}`, async t => {
      const h = await languagePanel(t, initial, target), second = deferred();
      h.wire();
      h.window.ApiClient.ajax = request => { h.writes.push(request); return second.promise; };
      await h.choose('nativeAcquisitionStampsSelect', 'off');
      h.held.reject(new Error('language save fails')); await tick();
      assert.equal(h.writes.length, 2);
      h.transition(boundary);
      second.resolve(); await tick();
      assert.equal(h.window.localStorage.getItem('user-a-language'), initial);
      assert.equal(h.window.localStorage.getItem('user-b-language'), 'en');
      assert.equal(h.toasts.filter(message => message === tr('toast_language_changed')).length, 0);
      expectReload(h, false);
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
  ['homeRowSoonSelect', 'homeRowSoon', null, 'off', 'panel_settings_home_saved']
]) for (const laterSaved of [false, true]) {
  test(`${key} saved notification: a failed choice is not carried by a later save (later ${laterSaved ? 'saved' : 'failed'})`, async t => {
    const h = panel(t, { config: { ...badges, NativePosterTagsEnabled: true, ArrListsEnabled: true,
      ArrListStatusEnabled: true, ArrAutomationEngineEnabled: true, ArrHomeRowsEnabled: true }, settings: { [key]: initial } });
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
    if (laterSaved) held[1].resolve(); else held[1].reject(new Error('later fails'));
    await later;
    assert.deepEqual(sent(h.writes[1]), { showFileSizes: true });
    assert.deepEqual(h.toasts, []);
    assert.equal(h.JE.currentSettings[key], initial, 'the failed choice is shown undone');
  });
}

// Consents (one rule for every consent, Q-REBUILD1-1 (b)): a failed choice is never carried by a later whole document,
// and only the consent operation's own success says saved.
for (const [id, key, initial, target, toast] of [
  ['autoSeasonRequestsSelect', 'autoSeasonRequests', null, 'off', 'toast_auto_requests_saved'],
  ['autoMovieRequestsSelect', 'autoMovieRequests', null, 'off', 'toast_auto_requests_saved'],
  ['listSwapInSelect', 'listSwapIn', false, 'on', 'toast_list_settings_saved']
]) for (const consentSaved of [false, true]) {
  test(`${key} is never carried by a later whole save; its notification follows the consent operation (${consentSaved ? 'saved' : 'failed'})`, async t => {
    const h = panel(t, { config: { ...badges, ArrListsEnabled: true, ArrListSwapInEnabled: true, ArrAutomationEngineEnabled: true }, settings: { [key]: initial } });
    const held = [deferred(), deferred()];
    h.window.ApiClient.ajax = request => {
      if (request.type === 'GET') return Promise.resolve([]);
      h.writes.push(request); return held[h.writes.length - 1].promise;
    };
    h.wire();
    const control = h.document.getElementById(id);
    control.value = target;
    control.dispatchEvent(new h.window.Event('change', { bubbles: true })); await tick();
    assert.equal(h.writes[0].type, 'PATCH');
    assert.equal(h.toasts.length, 0, 'never claim saved before persistence');
    const later = h.JE.updateSettings({ showFileSizes: true }, { throwOnError: true }).catch(() => {});
    if (consentSaved) held[0].resolve({ consents: { [key[0].toUpperCase() + key.slice(1)]: target === 'on' ? true : false } });
    else held[0].reject(new Error('consent fails'));
    await tick();
    held[1].resolve();
    await later;
    const expected = consentSaved ? (target === 'on') : initial;
    assert.equal(h.JE.currentSettings[key] ?? null, expected);
    assert.equal(h.writes[1].type, 'PATCH');
    assert.deepEqual(sent(h.writes[1]), { showFileSizes: true });
    assert.deepEqual(h.toasts, consentSaved ? [tr(toast)] : []);
  });
}

for (const laterSaved of [false, true]) test(`applied subtitle styles and position follow their own failed save (later ${laterSaved ? 'saved' : 'failed'})`, async t => {
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
  if (laterSaved) held[1].resolve(); else held[1].reject(new Error('later fails'));
  await Promise.all([first, second]);
  assert.deepEqual(applied.slice(-2), [['style', 2], ['position', 50]]);
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

// Stage 1 fix round 3 (found live): Jellyfin's own Display settings write the same `${userId}-language` key. JE writes it
// only when its own display language changes, so an unrelated JE save or a settings read keeps a language chosen there
// (this test used to assert the opposite: an unrelated commit wrote JE's Auto as '' over the person's Jellyfin choice, which
// put Jellyfin back in the browser's language after a reload). A JE language change, including back to Auto, still writes.
test('an unrelated settings commit or read keeps a language chosen in Jellyfin; a JE language change writes it', async t => {
  const h = panel(t, { settings: { displayLanguage: '' } });
  h.window.localStorage.setItem('user-a-language', 'fr');
  await h.JE.updateSettings({ showFileSizes: true }, { throwOnError: true });
  assert.equal(h.window.localStorage.getItem('user-a-language'), 'fr');
  h.window.ApiClient.ajax = async () => ({ displayLanguage: '', showFileSizes: true });
  await h.JE.readUserSettings('settings.json');
  assert.equal(h.window.localStorage.getItem('user-a-language'), 'fr');
  h.JE.internals.scheduleReloadWhenIdle = () => {};
  h.window.ApiClient.ajax = async () => [];
  await h.JE.updateSettings({ displayLanguage: 'de' }, { throwOnError: true });
  assert.equal(h.window.localStorage.getItem('user-a-language'), 'de');
  await h.JE.updateSettings({ showFileSizes: false }, { throwOnError: true });
  assert.equal(h.window.localStorage.getItem('user-a-language'), 'de');
  // Another browser changed JE's language: a read brings it.
  h.window.ApiClient.ajax = async () => ({ displayLanguage: 'pt-BR', showFileSizes: false });
  await h.JE.readUserSettings('settings.json');
  assert.equal(h.window.localStorage.getItem('user-a-language'), 'pt-BR');
  h.window.ApiClient.ajax = async () => [];
  await h.JE.updateSettings({ displayLanguage: '' }, { throwOnError: true });
  assert.equal(h.window.localStorage.getItem('user-a-language'), '');
});

for (const kind of ['quality tags', 'tag hover', 'random button', 'subtitle styles']) {
  for (const laterSaved of [false, true]) test(`document projection restores ${kind} after its own failed save (later ${laterSaved ? 'saved' : 'failed'})`, async t => {
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
    if (laterSaved) held[1].resolve();else held[1].reject(new Error('second fails'));
    await later;
    assert.equal(h.JE.currentSettings[key], true);
    if (kind === 'quality tags') assert.equal(!!h.document.querySelector('.quality-overlay-container'), true);
    if (kind === 'tag hover') assert.equal(h.document.body.classList.contains('je-tags-hide-on-hover'), true);
    if (kind === 'random button') assert.equal(!!h.document.getElementById('randomItemButtonContainer'), true);
    if (kind === 'subtitle styles') assert.equal(applied, true);
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
  clickAsViewer(h.document.querySelector('#font-size-presets-container [data-preset-index="1"]'));await tick();
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
 clickAsViewer(group.querySelector('.je-cat-down'));await tick();assert.notDeepEqual(order(),before);
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

// Round 10: page destruction waits for all queued work, and storage is never a commit dependency.
/** Drive real reload timers with bounded virtual time, including timers queued by a completion. */
function reloadClock(h) {
  let now = 0, nextId = 0, reloads = 0;
  const timers = new Map();
  h.window.setTimeout = (callback, ms = 0) => { const id = ++nextId; timers.set(id, { callback, at: now + ms }); return id; };
  h.window.clearTimeout = id => timers.delete(id);
  return {
    get reloads() { return reloads; },
    advance(ms) {
      const until = now + ms;
      for (let steps = 0; steps < 100; steps++) {
        const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) { now = until; return; }
        const [id, timer] = due; timers.delete(id); now = timer.at;
        const before = h.errors.length; timer.callback();
        for (const error of h.errors.splice(before)) {
          assert.match(error.message, /Not implemented: navigation/); reloads++;
        }
      }
      assert.fail('reload timers must not poll or spin');
    }
  };
}
async function reloadPanel(t) {
  const h = panel(t, { config: badges, settings: { displayLanguage: 'en-US' } });
  const transition = completionSession(h), clock = reloadClock(h);
  h.window.localStorage.setItem('user-a-language', 'en-US');
  h.window.fetch = async () => ({ ok: false });
  h.window.ApiClient.ajax = async request => request.url.includes('/locales') ? ['en-US', 'fr'] : [];
  h.wire();
  h.load('enhanced/settingspanel/ui-panel-language.js');
  h.JE.internals.enhancedUi.wireLanguageControls({ panelCleanups: h.panelCleanups, resetAutoCloseTimer() {} });
  await tick();
  const held = [];
  h.window.ApiClient.ajax = request => {
    if (request.type === 'GET') return Promise.resolve([]);
    const response = deferred(); h.writes.push(request); held.push(response); return response.promise;
  };
  return { ...h, transition, clock, held };
}
for (const trigger of ['language', 'cache', 'both']) {
  for (const switchSession of [false, true]) {
    test(`${trigger} reload waits for held and unsent saves; session switch=${switchSession}`, async t => {
      const h = await reloadPanel(t);
      if (trigger !== 'cache') {
        await h.choose('displayLanguageSelect', 'fr'); h.held[0].resolve(); await tick();
      }
      if (trigger !== 'language') clickAsViewer(h.document.getElementById('clearTranslationCacheButton'));
      const first = h.writes.length;
      await h.choose('nativeAcquisitionStampsSelect', 'off');
      await h.choose('acquisitionBadgesSelect', 'off');
      assert.equal(h.writes.length, first + 1, 'third save is still unsent');
      h.clock.advance(2500);
      assert.equal(h.clock.reloads, 0, 'a held POST and unsent save must survive either reload timer');
      if (switchSession) {
        h.transition('same-user new epoch');
        // Establish the incoming session's store while the outgoing transport is still outstanding.
        h.JE.userConfig = { ...h.JE.userConfig, settings: { displayLanguage: 'en-US' } }; h.JE.loadSettings();
      }
      h.held[first].resolve(); await tick(); h.clock.advance(0);
      if (switchSession) {
        assert.equal(h.writes.length, first + 1, 'old unsent save cannot reach the incoming credentials');
      } else {
        assert.equal(h.writes.length, first + 2, 'third save transports before any reload');
        assert.equal(h.clock.reloads, 0);
        assert.equal(sent(h.writes.at(-1)).acquisitionBadges, false);
        h.held[first + 1].resolve(); await tick(); h.clock.advance(0);
      }
      h.clock.advance(10000);
      assert.equal(h.clock.reloads, switchSession ? 0 : 1, 'one coalesced reload only after draining');
    });
  }
}
test('language reload also waits for an independent per-user file transport', async t => {
  const h = await reloadPanel(t);
  await h.choose('displayLanguageSelect', 'fr'); h.held[0].resolve(); await tick();
  const other = h.JE.patchUserSettings('bookmark.json', { upsert: { one: { label: 'scene' } } }, { throwOnError: true });
  await tick(); h.clock.advance(2500); assert.equal(h.clock.reloads, 0);
  h.held[1].resolve(); await other; h.clock.advance(0); assert.equal(h.clock.reloads, 1);
});
test('reload is released after the final queued save fails, retaining committed state', async t => {
  const h = await reloadPanel(t);
  await h.choose('displayLanguageSelect', 'fr'); h.held[0].resolve(); await tick();
  await h.choose('acquisitionBadgesSelect', 'off'); h.clock.advance(2500);
  assert.equal(h.clock.reloads, 0);
  h.held[1].reject(new Error('save failed')); await tick(); h.clock.advance(0);
  assert.equal(h.JE.currentSettings.acquisitionBadges, undefined);
  assert.equal(h.clock.reloads, 1);
});
for (const mode of ['quota', 'setItem', 'accessor']) {
  test(`language mirror ${mode} failure cannot reject a canonical commit or skip observers and retries next commit`, async t => {
    const h = panel(t, { config: { ...badges, ArrListsEnabled: true, ArrListSwapInEnabled: true }, settings: { displayLanguage: 'en-US', listSwapIn: true } });
    h.wire();
    const storage = h.window.localStorage, original = Object.getOwnPropertyDescriptor(h.window, 'localStorage');
    storage.setItem('user-a-language', 'de');
    let attempts = 0, warnings = 0, observed = 0;
    h.window.console.warn = () => warnings++;
    if (mode === 'accessor') Object.defineProperty(h.window, 'localStorage', { configurable: true, get() { attempts++; throw new Error('storage disabled'); } });
    let restore = () => Object.defineProperty(h.window, 'localStorage', original);
    if (mode !== 'accessor') {
      // jsdom Storage is exotic: patch the prototype, as a browser quota failure does.
      const prototype = Object.getPrototypeOf(storage), setItem = prototype.setItem;
      prototype.setItem = () => { attempts++; throw mode === 'quota' ? new h.window.DOMException('full', 'QuotaExceededError') : new Error('setItem disabled'); };
      restore = () => { prototype.setItem = setItem; };
      t.after(restore);
    }
    h.JE.internals.observeSettingsDocument('r10-proof', () => observed++);
    h.window.ApiClient.ajax = async () => ({ Consents: { ListSwapIn: false } });
    // The commit changes JE's language (stage 1 fix round 3: JE writes the shared key only then; an unrelated commit
    // no longer does, see above), so the mirror has something to write. The page reload a language change schedules
    // isn't what this test is about.
    h.JE.internals.scheduleReloadWhenIdle = () => {};
    await assert.doesNotReject(h.JE.updateSettings({ acquisitionBadges: false, displayLanguage: 'fr' }, { throwOnError: true }));
    assert.equal(h.JE.currentSettings.listSwapIn, false);
    assert.equal(h.document.getElementById('listSwapInSelect').value, '');
    assert.ok(h.toasts.includes(tr('toast_badge_settings_saved')));
    // Round 7: only what this save set is announced (the answer's consent value is shown, not announced).
    assert.ok(!h.toasts.includes(tr('toast_list_settings_saved')));
    assert.equal(observed, 3, 'initial, queued and committed publications all run');
    assert.ok(attempts > 0);
    const failedAttempts = attempts;
    await h.JE.updateSettings({ showFileSizes: true }, { throwOnError: true });
    assert.ok(attempts > failedAttempts, 'retry at the next commit');
    assert.equal(warnings, 1, 'a failed mirror warns once per session');
    restore();
    await h.JE.updateSettings({ showAudioLanguages: false }, { throwOnError: true });
    assert.equal(storage.getItem('user-a-language'), 'fr', 'mirror recovers after storage is available');
  });
}
test('unchanged language does not rewrite its mirror on unrelated saves or accepted reads', async t => {
  const h = panel(t, { settings: { displayLanguage: 'en-US' } });
  const storage = h.window.localStorage, prototype = Object.getPrototypeOf(storage), setItem = prototype.setItem;
  storage.setItem('user-a-language', 'en-US');
  let writes = 0;
  prototype.setItem = function(...args) { writes++; return setItem.apply(this, args); };
  t.after(() => { prototype.setItem = setItem; });
  await h.JE.updateSettings({ showFileSizes: true }, { throwOnError: true });
  h.window.ApiClient.ajax = async () => ({ displayLanguage: 'en-US', showFileSizes: true });
  await h.JE.readUserSettings('settings.json');
  assert.equal(writes, 0);
});

test('a due reload re-checks work enqueued after the idle wakeup', async t => {
  const h = await reloadPanel(t);
  await h.choose('displayLanguageSelect', 'fr'); h.held[0].resolve(); await tick();
  await h.choose('nativeAcquisitionStampsSelect', 'off'); h.clock.advance(2500);
  h.held[1].resolve(); await tick(); // schedules the idle wakeup
  await h.choose('acquisitionBadgesSelect', 'off');
  h.clock.advance(0); assert.equal(h.clock.reloads, 0, 'new work wins over the already armed wakeup');
  h.held[2].resolve(); await tick(); h.clock.advance(0); assert.equal(h.clock.reloads, 1);
});
test('a canonical settings read still publishes its views when browser storage is unavailable', async t => {
  const h = panel(t, { config: { ArrListsEnabled: true, ArrListSwapInEnabled: true }, settings: { listSwapIn: true } });
  h.wire();
  Object.defineProperty(h.window, 'localStorage', { configurable: true, get() { throw new Error('storage disabled'); } });
  let observed = 0; h.JE.internals.observeSettingsDocument('r10-read', () => observed++);
  h.window.ApiClient.ajax = async () => ({ listSwapIn: false });
  assert.equal(await h.JE.readUserSettings('settings.json'), true);
  assert.equal(h.JE.currentSettings.listSwapIn, false);
  assert.equal(h.document.getElementById('listSwapInSelect').value, '');
  assert.equal(observed, 2);
});
test('language controls wire from the document even when the storage accessor throws', async t => {
  const h = panel(t, { settings: { displayLanguage: 'fr' } });
  Object.defineProperty(h.window, 'localStorage', { configurable: true, get() { throw new Error('storage disabled'); } });
  h.window.fetch = async () => ({ ok: false });
  h.window.ApiClient.ajax = async request => request.url.includes('/locales') ? ['fr', 'en-US'] : [];
  h.load('enhanced/settingspanel/ui-panel-language.js');
  assert.doesNotThrow(() => h.JE.internals.enhancedUi.wireLanguageControls({ panelCleanups: h.panelCleanups, resetAutoCloseTimer() {} }));
  await tick(); assert.equal(h.document.getElementById('displayLanguageSelect').value, 'fr');
});

// Round 11: a publication failure must never become a queue/commit failure.
for (const fault of ['disabled storage', 'clear timestamp quota']) test(`real Quality Tags ${fault} cannot orphan a queued save`, async t => {
  const h = await reloadPanel(t);
  h.JE.session.onUserChange = () => {};
  h.JE.session.getUserId = () => 'user-a';
  h.JE.pluginConfig.TagCacheServerMode = false;
  h.JE.pluginConfig.ClearLocalStorageTimestamp = 1000;
  const renderers = new Map();
  h.JE.tagPipeline = { registerRenderer: (name, renderer) => renderers.set(name, renderer) };
  h.load('core/ui-kit.js'); h.load('core/tag-renderer-base.js'); h.load('tags/qualitytags.js');
  const descriptor = Object.getOwnPropertyDescriptor(h.window, 'localStorage');
  const storage = h.window.localStorage, prototype = Object.getPrototypeOf(storage), setItem = prototype.setItem;
  if (fault === 'disabled storage') Object.defineProperty(h.window, 'localStorage', { configurable: true, get() { throw new Error('storage disabled'); } });
  else prototype.setItem = function(key, value) {
    if (key.endsWith('Timestamp')) throw new h.window.DOMException('full', 'QuotaExceededError');
    return setItem.call(this, key, value);
  };
  t.after(() => { Object.defineProperty(h.window, 'localStorage', descriptor); prototype.setItem = setItem; });
  const first = h.JE.updateSettings({ qualityTagsEnabled: true }, { throwOnError: true });
  // Attach immediately so the broken baseline rejection is observed, not an unhandled test promise.
  const settled = first.then(() => 'saved', error => error.message);
  await tick(); h.held[0].resolve(); await tick();
  assert.equal(await settled, 'saved', 'a renderer failure cannot reject a successful POST');
  assert.ok(renderers.has('quality'), 'cache failure must still register the real renderer');
  const later = h.JE.updateSettings({ showFileSizes: true }, { throwOnError: true });
  h.JE.internals.scheduleReloadWhenIdle(h.JE.internals.settingsSessionScope(), 0);
  await tick(); h.clock.advance(0); assert.equal(h.clock.reloads, 0);
  h.held[1].resolve(); await later;
  assert.equal(h.JE.currentSettings.showFileSizes, true);
  assert.equal(h.document.getElementById('showFileSizesToggle').checked, true);
  h.clock.advance(0); assert.equal(h.clock.reloads, 1, 'all pending entries were removed');
});

/** Capture every observer installed by the actual main/misc/language panels; inject before its body. */
async function faultPanel(t) {
  const h = panel(t, { config: { ...badges, ArrListsEnabled: true, ArrListSwapInEnabled: true }, settings: { displayLanguage: 'en-US', listSwapIn: false } });
  const clock = reloadClock(h), observers = new Map(), observe = h.JE.internals.observeSettingsDocument;
  let fault, warnings = 0;
  h.window.console.warn = () => warnings++;
  h.JE.internals.observeSettingsDocument = (name, observer) => {
    observers.set(name, observer);
    observe(name, (shown, reason) => {
      if (fault?.name === name && fault.reason === reason) { fault.hits++; throw new Error('injected observer ' + name); }
      return observer(shown, reason);
    });
  };
  h.window.fetch = async () => ({ ok: false });
  h.window.ApiClient.ajax = async request => request.url.includes('/locales') ? ['en-US', 'fr'] : [];
  h.wire();
  const ctx = { help: h.document.body, primaryAccentColor: '#123456', panelCleanups: h.panelCleanups, resetAutoCloseTimer() {} };
  h.JE.internals.enhancedUi.wireMiscSettingsControls(ctx);
  h.load('enhanced/settingspanel/ui-panel-language.js'); h.JE.internals.enhancedUi.wireLanguageControls(ctx);
  await tick();
  return { ...h, clock, observers, arm(value) { fault = value; }, get warnings() { return warnings; } };
}

/** One bounded real-transport cycle for every publication reason; no orphan may outlive its save. */
async function publicationFault(h, reason) {
  const held = [], persisted = { ...h.JE.userConfig.settings };
  let published = 0;
  h.JE.internals.observeSettingsDocument('r11-tail', () => published++);
  h.window.ApiClient.ajax = request => {
    if (request.type === 'GET') return Promise.resolve({ ...persisted });
    const response = deferred(); held.push({ ...response, request });
    return response.promise.then(() => {
      if (request.url.endsWith('/consent')) {
        const patch = JSON.parse(request.data); persisted[patch.Field[0].toLowerCase() + patch.Field.slice(1)] = patch.Value;
      } else Object.assign(persisted, sent(request));
      return { Consents: { ListSwapIn: persisted.listSwapIn } };
    });
  };
  h.JE.internals.scheduleReloadWhenIdle(h.JE.internals.settingsSessionScope(), 0);
  // A held legacy save plus an unsent PATCH exercise the shared queue on every injected publication.
  const first = h.JE.saveUserSettings('settings.json', { ...h.JE.currentSettings, acquisitionBadges: false }, { throwOnError: true });
  const outcome = first.then(() => 'saved', () => 'failed');
  const consent = h.JE.setPersonalConsent('listSwapIn', true, { throwOnError: true });
  const consentOutcome = consent.then(() => 'saved', () => 'failed');
  await tick(); h.clock.advance(0); assert.equal(h.clock.reloads, 0);
  assert.equal(held.length, 1);
  if (reason === 'failed') held[0].reject(new Error('transport rejected')); else held[0].resolve();
  assert.equal(await outcome, reason === 'failed' ? 'failed' : 'saved', 'effect failures cannot alter transport outcome');
  await tick(); assert.equal(held.length, 2); held[1].resolve();
  assert.equal(await consentOutcome, 'saved');
  if (reason === 'read') { persisted.showAudioLanguages = false; assert.equal(await h.JE.readUserSettings('settings.json'), true); }
  const later = h.JE.updateSettings({ showFileSizes: true }, { throwOnError: true });
  await tick(); assert.equal(held.length, 3); held[2].resolve(); await later;
  assert.equal(h.JE.currentSettings.showFileSizes, persisted.showFileSizes);
  assert.equal(h.JE.userConfig.settings.listSwapIn, persisted.listSwapIn);
  assert.equal(h.JE.currentSettings.acquisitionBadges, persisted.acquisitionBadges);
  // The tail observer runs even if an earlier projector or panel observer fails.
  assert.ok(published >= 7);
  h.clock.advance(0); h.clock.advance(5000); assert.equal(h.clock.reloads, 1);
}

for (const reason of ['queued', 'saved', 'failed', 'read']) test(`generic observer fault injection preserves store invariants on ${reason}`, async t => {
  const probe = await faultPanel(t);
  assert.ok(probe.observers.size >= 10, 'enumerate actual main/misc panel registrations');
  for (const name of probe.observers.keys()) await t.test(name, async tt => {
    const h = await faultPanel(tt), fault = { name, reason, hits: 0 };
    h.arm(fault); await publicationFault(h, reason);
    assert.ok(fault.hits > 0); assert.equal(h.warnings, 1, 'warn once for a repeatedly failing observer');
  });
});

// The effect registry is populated by production config.js, rather than a copied list of projectors.
for (const reason of ['queued', 'saved', 'failed', 'read']) test(`generic registered effect fault injection preserves store invariants on ${reason}`, async t => {
  const probe = await faultPanel(t), effects = probe.JE.internals.settingsDocumentEffects;
  assert.ok(effects?.size >= 20, 'all independently fallible projectors/mirrors/toasts are registered');
  for (const name of effects.keys()) await t.test(name, async tt => {
    const h = await faultPanel(tt), original = h.JE.internals.settingsDocumentEffects.get(name);
    let hits = 0;
    h.JE.internals.settingsDocumentEffects.set(name, context => {
      if (context.reason === reason) { hits++; throw new Error('injected effect ' + name); }
      return original(context);
    });
    await publicationFault(h, reason);
    assert.ok(hits > 0); assert.equal(h.warnings, 1, 'warn once per effect kind');
  });
});

for (const phase of ['initialize', 'reinitialize']) test(`async Quality Tags ${phase} rejection is isolated at the real settings boundary`, async t => {
  const h = panel(t, { settings: { qualityTagsEnabled: phase === 'reinitialize', qualityTagsPreferredAudioLanguage: 'auto' } });
  h.load('core/ui-kit.js'); h.load('core/tag-renderer-base.js'); h.load('tags/qualitytags.js');
  h.window.ApiClient.getUser = async () => ({ Configuration: { AudioLanguagePreference: 'eng' } });
  let hits = 0, warnings = 0;
  h.window.console.warn = () => warnings++;
  h.JE.core.tagRenderer[phase === 'initialize' ? 'register' : 'reinitialize'] = () => { hits++; throw Error('injected deferred renderer'); };
  await h.JE.updateSettings(phase === 'initialize' ? { qualityTagsEnabled: true } : { qualityTagsPosition: 'bottom-right' }, { throwOnError: true });
  await tick(); await tick();
  assert.equal(hits, 1); assert.equal(warnings, 1);
  await h.JE.updateSettings({ showFileSizes: true }, { throwOnError: true });
  assert.equal(h.JE.currentSettings.showFileSizes, true);
});

for (const consumer of ['effect', 'observer']) test(`rejected async ${consumer} is caught without blocking later publications`, async t => {
  const h = await faultPanel(t); let hits = 0;
  const fail = () => { hits++; return h.window.Promise.reject(Error('injected async consumer')); };
  if (consumer === 'effect') h.JE.internals.settingsDocumentEffects.set('pause-delay', fail);
  else h.JE.internals.observeSettingsDocument('async-proof', fail);
  await publicationFault(h, 'saved'); await tick();
  assert.ok(hits > 1); assert.equal(h.warnings, 1);
});

test('a throwing language toast cannot skip its reload, other notifications or panel observers', async t => {
  const h = await faultPanel(t), original = h.JE.toast;
  h.JE.toast = message => { if (message === tr('toast_language_changed')) throw Error('toast unavailable'); return original(message); };
  await h.JE.updateSettings({ displayLanguage: 'fr', acquisitionBadges: false }, { throwOnError: true });
  assert.equal(h.window.localStorage.getItem('user-a-language'), 'fr');
  assert.ok(h.toasts.includes(tr('toast_badge_settings_saved')));
  assert.equal(h.document.getElementById('acquisitionBadgesSelect').value, 'off');
  h.clock.advance(1500); assert.equal(h.clock.reloads, 1); assert.equal(h.warnings, 1);
});

// Stage 1 fix round 4 (RBS1-R4-2): the panel shows the display language the server stored, exactly (en-AU, de-Latn-CH: no
// truncation to en or de, no base-language substitution), from the real locale enumeration: the server's list of the
// locale files this build ships (GET /JellyfinEnhanced/locales leaves out the base English) and Jellyfin 12.2's own
// /Localization/Cultures answer (captured from a 12.2 server). A stored tag without its own option gets one, labelled by
// the bundle the policy resolves it to; on enumeration and on every store update (a save of another setting, a read).
const SERVER_LOCALES = shippedLocales().filter(code => code !== 'en');
const CULTURES = JSON.parse(readFileSync(new URL('../helpers/jellyfin-12.2-cultures.json', import.meta.url), 'utf8'));
async function storedLanguagePanel(t, stored, { policy } = {}) {
  const h = panel(t, { config: badges, settings: { displayLanguage: stored }, policy });
  h.wire();
  let persisted = { displayLanguage: stored };
  h.window.fetch = async () => ({ ok: false }); // no locale newer than this build
  h.window.ApiClient.ajax = async request => {
    if (request.url.includes('/JellyfinEnhanced/locales')) return [...SERVER_LOCALES];
    if (request.url.includes('/Localization/Cultures')) return structuredClone(CULTURES);
    if (isSave(request)) { h.writes.push(request); persisted = { ...persisted, ...sent(request) }; return { success: true, consents: {}, displayLanguage: persisted.displayLanguage }; }
    return { ...persisted };
  };
  h.load('enhanced/settingspanel/ui-panel-language.js');
  h.JE.internals.enhancedUi.wireLanguageControls({ panelCleanups: h.panelCleanups, resetAutoCloseTimer() {} });
  await tick(); await tick();
  const select = h.document.getElementById('displayLanguageSelect');
  return { ...h, select, persisted: () => persisted, setPersisted(value) { persisted = { ...persisted, ...value }; } };
}
function shows(h, tag, label) {
  const { select } = h;
  assert.ok(select.selectedIndex >= 0, `nothing selected (value ${JSON.stringify(select.value)})`);
  assert.equal(select.value, tag);
  assert.equal(select.options[select.selectedIndex].value, tag);
  assert.equal([...select.options].filter(o => o.value.toLowerCase() === tag.toLowerCase()).length, 1, 'one option per language');
  if (label) assert.equal(select.options[select.selectedIndex].textContent, label);
}
const STORED = [['en-AU', 'English (en-AU)'], ['de-Latn-CH', 'German (de-Latn-CH)'], ['pt-BR', 'Portuguese (Brazil)'], ['zh-HK', 'Chinese (Hong Kong)'], ['fr', 'French'], ['', null]];
for (const [stored, label] of STORED) test(`the panel shows the stored language ${JSON.stringify(stored)} exactly, from the real enumeration`, async t => {
  const h = await storedLanguagePanel(t, stored);
  shows(h, stored, label);
  // Every shipped language is still offered once, the real list untouched.
  for (const code of SERVER_LOCALES) assert.equal([...h.select.options].filter(o => o.value === code).length, 1, code);
});
for (const [stored, label] of STORED) test(`an unrelated save keeps the stored language ${JSON.stringify(stored)} selected`, async t => {
  const h = await storedLanguagePanel(t, stored);
  await h.JE.updateSettings({ showFileSizes: true }, { throwOnError: true });
  await tick();
  // Round 7: the save sends only its own field; the server keeps the stored language.
  assert.equal(sent(h.writes.at(-1)).displayLanguage, undefined, 'the save sends only its own field');
  assert.equal(h.persisted().displayLanguage, stored);
  shows(h, stored, label);
  h.document.getElementById('showFileSizesToggle')?.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await tick(); await tick();
  shows(h, stored, label);
});
for (const [from, to, label] of [['fr', 'de-Latn-CH', 'German (de-Latn-CH)'], ['en-AU', 'pt-BR', 'Portuguese (Brazil)'], ['pt-BR', 'en-AU', 'English (en-AU)'], ['en-AU', '', null]]) test(`a read that brings ${JSON.stringify(to)} (stored elsewhere) shows it exactly`, async t => {
  const h = await storedLanguagePanel(t, from);
  h.setPersisted({ displayLanguage: to });
  assert.equal(await h.JE.readUserSettings('settings.json'), true);
  await tick();
  shows(h, to, label);
});
test('a stored language the panel shows can be chosen away from and back, saved as stored', async t => {
  const h = await storedLanguagePanel(t, 'en-AU');
  await h.choose('displayLanguageSelect', 'fr'); await tick();
  assert.equal(sent(h.writes.at(-1)).displayLanguage, 'fr');
  shows(h, 'fr', 'French');
  await h.choose('displayLanguageSelect', 'en-AU'); await tick();
  assert.equal(sent(h.writes.at(-1)).displayLanguage, 'en-AU');
  shows(h, 'en-AU', 'English (en-AU)');
});


// Stage 1 fix round 5 (RBS1-R5-1): no writer of the display language acts without the policy. When translations.js didn't
// load (blocked) or came without the policy line (unserved), JE has no rule to write a language by: the panel still shows
// the stored language, exactly, but offers no change (the select is disabled, with a note why) and saves nothing for that
// field; a choice that reaches it anyway (a scripted change) is undone and saves nothing; unrelated saves and reads keep
// and show the stored language; Jellyfin's shared language key is never written.
const UNAVAILABLE_NOTE = en.panel_settings_language_unavailable;
const NO_POLICY_STORED = [['de', 'German'], ['en-AU', 'English (en-AU)'], ['de-Latn-CH', 'German (de-Latn-CH)'], ['pt-BR', 'Portuguese (Brazil)'], ['', null]];
function offersNoChange(h) {
  assert.equal(h.select.disabled, true, 'the select is disabled');
  const note = h.document.getElementById('displayLanguageUnavailableNote');
  assert.ok(note && !note.hidden, 'the note says why');
  assert.equal(note.textContent, UNAVAILABLE_NOTE);
}
for (const policy of ['blocked', 'unserved']) {
  for (const [stored, label] of NO_POLICY_STORED) test(`without the language policy (${policy}) the panel shows the stored language ${JSON.stringify(stored)} and offers no change`, async t => {
    const h = await storedLanguagePanel(t, stored, { policy });
    assert.equal(h.JE.supportedLanguageCode, undefined);
    shows(h, stored, label);
    offersNoChange(h);
  });
  for (const [stored, label] of NO_POLICY_STORED) test(`without the language policy (${policy}) choosing another language for ${JSON.stringify(stored)} saves nothing and keeps showing it`, async t => {
    const h = await storedLanguagePanel(t, stored, { policy });
    for (const choice of ['fr', '', 'en-AU', 'undefined']) {
      if (choice === stored) continue;
      if (![...h.select.options].some(o => o.value === choice)) {
        const option = h.document.createElement('option'); option.value = choice; h.select.appendChild(option);
      }
      await h.choose('displayLanguageSelect', choice); await tick(); await tick();
      assert.equal(h.writes.length, 0, `choosing ${JSON.stringify(choice)} wrote ${h.writes.map(w => w.data).join(' ')}`);
      shows(h, stored, label);
      offersNoChange(h);
    }
    assert.equal(h.persisted().displayLanguage, stored, 'the server keeps the stored language');
    assert.equal(h.JE.currentSettings.displayLanguage, stored);
    assert.equal(h.window.localStorage.getItem('user-a-language'), null, 'the shared language key is never written');
  });
  test(`without the language policy (${policy}) unrelated saves keep the stored "de" and show it`, async t => {
    const h = await storedLanguagePanel(t, 'de', { policy });
    await h.JE.updateSettings({ showFileSizes: true }, { throwOnError: true });
    await tick();
    // Round 7: a save sends only its own field; the stored language is never part of it.
    assert.equal(sent(h.writes.at(-1)).DisplayLanguage ?? sent(h.writes.at(-1)).displayLanguage, undefined);
    shows(h, 'de', 'German');
    await h.choose('displayLanguageSelect', 'fr'); await tick();
    h.document.getElementById('showFileSizesToggle')?.dispatchEvent(new h.window.Event('change', { bubbles: true }));
    await tick(); await tick();
    for (const write of h.writes) assert.equal(sent(write).DisplayLanguage ?? sent(write).displayLanguage, undefined, write.data);
    assert.equal(h.persisted().displayLanguage, 'de');
    shows(h, 'de', 'German');
    offersNoChange(h);
    assert.equal(h.window.localStorage.getItem('user-a-language'), null, 'the shared language key is never written');
  });
  test(`without the language policy (${policy}) a read that brings another stored language shows it, still unchangeable`, async t => {
    const h = await storedLanguagePanel(t, 'de', { policy });
    h.setPersisted({ displayLanguage: 'en-AU' });
    assert.equal(await h.JE.readUserSettings('settings.json'), true);
    await tick();
    shows(h, 'en-AU', 'English (en-AU)');
    offersNoChange(h);
    assert.equal(h.writes.length, 0);
    assert.equal(h.window.localStorage.getItem('user-a-language'), null);
  });
}
test('with the language policy the select can be changed and carries no note (normal path unchanged)', async t => {
  const h = await storedLanguagePanel(t, 'de');
  assert.equal(h.select.disabled, false);
  assert.equal(h.document.getElementById('displayLanguageUnavailableNote'), null);
  await h.choose('displayLanguageSelect', 'fr'); await tick();
  assert.equal(sent(h.writes.at(-1)).displayLanguage, 'fr');
  shows(h, 'fr', 'French');
});
