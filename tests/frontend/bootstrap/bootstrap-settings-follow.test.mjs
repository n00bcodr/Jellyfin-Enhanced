import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

// Design item C3: following the server default. JE.settings.follow sends a Follow operation (never
// today's default as a choice); the panel rows say how they relate to the server default only when
// that tells the user something, "Use server default" follows one row, and "Use server defaults for
// everything" first says how many values will visibly change.

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const camel = object => Object.fromEntries(Object.entries(object).map(([key, value]) => [key.charAt(0).toLowerCase() + key.slice(1), value]));
const pascal = key => key.charAt(0).toUpperCase() + key.slice(1);
const camelMeta = meta => Object.fromEntries(Object.entries(meta).map(([key, value]) => [key.charAt(0).toLowerCase() + key.slice(1),
  Array.isArray(value) ? value.map(name => name.charAt(0).toLowerCase() + name.slice(1))
    : value && typeof value === 'object' ? camel(value) : value]));

/** Window timers advanced by hand. */
function manualTimers() {
  let nextId = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++nextId; pending.set(id, { fn, ms }); return id; },
    clearTimeout: id => { pending.delete(id); },
    pending,
    runAll() { for (const [id, { fn }] of [...pending]) { pending.delete(id); fn(); } }
  };
}

/**
 * A small server: its stored values, the admin defaults, and which keys follow or were chosen.
 * /patch applies Set (Chosen) and Follow (Following, value = default) like the real route.
 */
function fakeServer({ values, defaults, following = [], chosen = [], changedByAdmin = [], locked = [] }) {
  const state = { values: { ...values }, defaults: { ...defaults }, following: [...following], chosen: [...chosen], changedByAdmin: [...changedByAdmin], locked: [...locked] };
  const resolved = () => {
    const result = { ...state.values };
    for (const key of state.following.concat(state.locked)) result[key] = state.defaults[key];
    return result;
  };
  const meta = () => {
    const current = resolved();
    return {
      Following: state.following.slice(), Chosen: state.chosen.slice(), ChangedByAdmin: state.changedByAdmin.slice(), Locked: state.locked.slice(),
      Defaults: { ...state.defaults },
      Differs: Object.keys(state.defaults).filter(key => !state.locked.includes(key) && !state.following.includes(key) && current[key] !== state.defaults[key])
    };
  };
  return {
    state, resolved, meta,
    patch(body) {
      const rejected = [];
      for (const [key, value] of Object.entries(body.Set || {})) {
        if (state.locked.includes(key)) { rejected.push({ Key: key, Reason: 'locked' }); continue; }
        state.values[key] = value;
        state.following = state.following.filter(name => name !== key);
        if (!state.chosen.includes(key)) state.chosen.push(key);
      }
      for (const key of body.Follow || []) {
        if (state.locked.includes(key)) { rejected.push({ Key: key, Reason: 'locked' }); continue; }
        if (!Object.prototype.hasOwnProperty.call(state.defaults, key)) { rejected.push({ Key: key, Reason: 'invalid' }); continue; }
        state.values[key] = state.defaults[key];
        state.chosen = state.chosen.filter(name => name !== key);
        state.changedByAdmin = state.changedByAdmin.filter(name => name !== key);
        if (!state.following.includes(key)) state.following.push(key);
      }
      return { success: true, Revision: 'r', Applied: [], Rejected: rejected, Settings: { ...resolved(), IsAdmin: false }, Meta: meta() };
    }
  };
}

const presets = [{ name: 'Small', size: 0.8, family: 'Arial', previewText: 'Aa', textColor: '#FFFFFFFF', bgColor: 'transparent' },
  { name: 'Normal', size: 1, family: 'Arial', previewText: 'Aa', textColor: '#FFFFFFFF', bgColor: 'transparent' },
  { name: 'Large', size: 1.2, family: 'Arial', previewText: 'Aa', textColor: '#FFFFFFFF', bgColor: 'transparent' }];

/**
 * The real config.js, panel template and provenance module over a fake server. `server` holds
 * PascalCase keys; the client sees them camelCased like the real bootstrap does.
 */
function buildPanel(t, serverOptions, { capabilities = ['settingsPatch'], failPatch = false } = {}) {
  const server = fakeServer(serverOptions);
  const timers = manualTimers();
  const requests = [];
  const h = createHarness({
    globals: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    JE: { pluginConfig: { Shortcuts: [], NativePosterTagsEnabled: true }, serverCapabilities: capabilities,
      userConfig: { shortcuts: { Shortcuts: [] }, settings: camel({ ...server.resolved(), IsAdmin: false }), settingsStatus: 'ok', settingsMeta: camelMeta(server.meta()) },
      state: { activeShortcuts: {} }, pluginVersion: '1.0',
      t: (key, params) => params ? `${key}(${Object.values(params).join(',')})` : `[${key}]`,
      toast: () => {}, camelCaseSettingsMeta: camelMeta,
      escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
      icon: () => '', IconName: new Proxy({}, { get: (target, name) => String(name) }), icons: { wrapEmoji: value => value },
      subtitlePresets: presets, fontSizePresets: presets, fontFamilyPresets: presets, subtitleTextEffectPresets: presets,
      getSubtitleTextShadow: () => 'none', decodeSubtitleColor: () => ({ swatch: '#FFFFFF', alphaValue: 255 }),
      getSubtitleColors: () => ({ text: '#FFFFFFFF', bg: '#00000000' }),
      internals: { enhancedUi: { GITHUB_REPO: 'owner/repo' } } },
    apiClient: {
      ajax: async (request) => {
        const entry = { url: new URL(request.url).pathname, body: JSON.parse(request.data) };
        requests.push(entry);
        if (failPatch) throw Object.assign(new Error('offline'), { status: 0 });
        if (entry.url.endsWith('/patch')) return server.patch(entry.body);
        return undefined;
      }
    }
  });
  t.after(() => h.close());
  h.load('enhanced/config.js');
  h.load('enhanced/settingspanel/ui-panel-template.js');
  h.load('enhanced/settingspanel/ui-panel-provenance.js');
  h.JE.currentSettings = h.JE.loadSettings();
  const root = h.document.createElement('div');
  root.id = 'jellyfin-enhanced-panel';
  root.innerHTML = h.JE.internals.enhancedUi.buildPanelHtml({});
  h.document.body.appendChild(root);
  const closers = [];
  h.JE.internals.enhancedUi.decorateSettingsProvenance({ help: root, onPanelClose: fn => closers.push(fn) });
  const notesOf = (selector) => {
    const row = root.querySelector(selector).closest('[data-setting-row]');
    return [...(row.querySelector(':scope > .je-setting-provenance')?.children || [])];
  };
  /** Sends the waiting batch and lets its answer land. */
  const flush = async () => { await settle(); timers.runAll(); await settle(); };
  return { ...h, root, server, requests, timers, flush, notesOf, close: () => closers.forEach(fn => fn()) };
}

test('rows say how they relate to the server default only when it tells the user something', t => {
  const h = buildPanel(t, {
    values: { AutoPipEnabled: false, AutoPauseEnabled: false, AutoResumeEnabled: true, LongPress2xEnabled: false, ShowFileSizes: true,
      PauseScreenEnabled: true, PauseScreenDelaySeconds: 8, SubtitleVerticalPosition: 40, RandomSourceId: '' },
    defaults: { AutoPipEnabled: false, AutoPauseEnabled: true, AutoResumeEnabled: false, LongPress2xEnabled: false, ShowFileSizes: false,
      PauseScreenEnabled: true, PauseScreenDelaySeconds: 5 },
    following: ['AutoPipEnabled', 'PauseScreenEnabled'], chosen: ['AutoPauseEnabled', 'ShowFileSizes'], changedByAdmin: ['ShowFileSizes']
  });
  const line = selector => h.notesOf(selector).map(row => row.querySelector('span').textContent);
  const button = selector => h.notesOf(selector)[0]?.querySelector('button.je-provenance-follow');

  assert.deepEqual(line('#autoPipToggle'), ['[panel_provenance_following]'], 'following: "Server default", no button');
  assert.equal(button('#autoPipToggle'), null);
  assert.deepEqual(line('#autoPauseToggle'), ['panel_provenance_chosen([panel_provenance_on])']);
  assert.equal(button('#autoPauseToggle').dataset.followKeys, 'autoPauseEnabled');
  assert.equal(button('#autoPauseToggle').textContent, '[panel_provenance_use_default]');
  assert.deepEqual(line('#showFileSizesToggle'), ['[panel_provenance_changed_by_admin]']);
  assert.deepEqual(line('#autoResumeToggle'), ['panel_provenance_differs([panel_provenance_off])']);
  assert.equal(button('#autoResumeToggle').dataset.followKeys, 'autoResumeEnabled');
  assert.deepEqual(line('#longPress2xEnabled'), [], 'an older value equal to the default has no label');
  // A nested key is named with its label; the row's own (following) key still says so.
  assert.deepEqual(line('#pauseScreenDelayInput'), ['[panel_provenance_following]', '[panel_settings_pause_screen_delay_name]: panel_provenance_differs(5)']);
  // Keys without a server default never get a label.
  assert.equal(h.root.querySelectorAll('[data-setting-key="randomSourceId"] .je-setting-provenance').length, 0);
  // Every follow button is a real, named button outside the row's own controls.
  for (const element of h.root.querySelectorAll('button.je-provenance-follow')) assert.equal(element.type, 'button');
});

test('the tag order group is described once and its button follows all six orders', t => {
  const orders = ['ResolutionTagOrder', 'SourceTagOrder', 'DynamicRangeTagOrder', 'SpecialFormatTagOrder', 'VideoCodecTagOrder', 'AudioInfoTagOrder'];
  const h = buildPanel(t, {
    values: { QualityTagsEnabled: true, ...Object.fromEntries(orders.map((key, index) => [key, 6 - index])) },
    defaults: { QualityTagsEnabled: true, ...Object.fromEntries(orders.map((key, index) => [key, index + 1])) },
    following: ['QualityTagsEnabled'], chosen: ['ResolutionTagOrder']
  });
  const lines = h.notesOf('#qualityTagsToggle');
  assert.deepEqual(lines.map(row => row.querySelector('span').textContent), ['[panel_provenance_following]', '[panel_settings_ui_quality_tags_order_label]: [panel_provenance_chosen_plain]']);
  assert.deepEqual(lines[1].querySelector('button').dataset.followKeys.split(',').sort(), orders.map(key => key.charAt(0).toLowerCase() + key.slice(1)).sort());
  assert.match(lines[1].querySelector('button').getAttribute('aria-label'), /^\[panel_settings_ui_quality_tags_order_label\]: /);
  // The follow button is not one of the row's controls: locking still disables only the real ones.
  h.JE.userConfig.settingsMeta = { ...h.JE.userConfig.settingsMeta, locked: ['qualityTagsEnabled'] };
  h.document.dispatchEvent(new h.window.CustomEvent('je:settings-changed', { detail: { keys: [], rejected: [] } }));
  assert.equal(h.root.querySelector('#qualityTagsToggle').disabled, true);
});

test('"Use server default" sends a Follow operation, shows the default and runs the row\'s own change handler', async t => {
  const h = buildPanel(t, {
    values: { AutoPipEnabled: true, AutoPauseEnabled: true },
    defaults: { AutoPipEnabled: false, AutoPauseEnabled: true },
    chosen: ['AutoPipEnabled']
  });
  const toggle = h.root.querySelector('#autoPipToggle');
  assert.equal(toggle.checked, true);
  const changes = [];
  toggle.addEventListener('change', () => changes.push(toggle.checked));
  const events = [];
  h.document.addEventListener('je:settings-changed', e => events.push(plain(e.detail)));

  h.notesOf('#autoPipToggle')[0].querySelector('button').click();
  await h.flush();
  assert.deepEqual(h.requests.map(r => r.body), [{ Set: {}, Follow: ['AutoPipEnabled'] }], 'a Follow, never the default as a Set');
  assert.equal(h.JE.currentSettings.autoPipEnabled, false);
  assert.equal(toggle.checked, false);
  assert.deepEqual(changes, [false], 'the row\'s change handler applies the new value live');
  assert.deepEqual(events.map(e => [e.keys, e.meta === true]), [[['autoPipEnabled'], true]]);
  assert.deepEqual(h.notesOf('#autoPipToggle').map(row => row.textContent), ['[panel_provenance_following]']);

  // The handler's own save finds nothing to send.
  await h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  await h.flush();
  assert.equal(h.requests.length, 1);
});

test('"Use server default" on a preset row redraws it from the default (je:setting-sync)', async t => {
  const h = buildPanel(t, { values: { SelectedStylePresetIndex: 0 }, defaults: { SelectedStylePresetIndex: 2 }, chosen: ['SelectedStylePresetIndex'] });
  const row = [...h.root.querySelectorAll('[data-setting-key]')].find(el => el.dataset.settingKey === 'selectedStylePresetIndex');
  const synced = [];
  row.addEventListener('je:setting-sync', () => synced.push(h.JE.currentSettings.selectedStylePresetIndex));
  h.notesOf('#subtitle-style-presets-container')[0].querySelector('button').click();
  await h.flush();
  assert.deepEqual(h.requests.map(r => r.body), [{ Set: {}, Follow: ['SelectedStylePresetIndex'] }]);
  assert.equal(h.JE.currentSettings.selectedStylePresetIndex, 2);
  assert.ok(synced.length >= 1 && synced.every(value => value === 2), 'the row redraws with the default it now follows');
});

test('a failed "Use server default" leaves the row as it was and says so', async t => {
  const h = buildPanel(t, { values: { AutoPipEnabled: true }, defaults: { AutoPipEnabled: false }, chosen: ['AutoPipEnabled'] }, { failPatch: true });
  t.mock.method(h.window.console, 'warn', () => {});
  h.allowConsoleError(/Failed to save|Could not/);
  const button = h.notesOf('#autoPipToggle')[0].querySelector('button');
  button.click();
  assert.equal(button.disabled, true, 'no second click while it is in flight');
  await h.flush();
  assert.equal(button.disabled, false);
  assert.equal(h.JE.currentSettings.autoPipEnabled, true);
  assert.equal(h.root.querySelector('#autoPipToggle').checked, true);
  assert.equal(h.root.querySelector('[role="alert"]').textContent, '[panel_provenance_follow_failed]');
});

test('"Use server defaults for everything" says how many values change, then makes every unlocked key follow', async t => {
  const h = buildPanel(t, {
    values: { AutoPipEnabled: true, AutoPauseEnabled: true, AutoResumeEnabled: false, ShowFileSizes: true, LongPress2xEnabled: false },
    defaults: { AutoPipEnabled: false, AutoPauseEnabled: true, AutoResumeEnabled: false, ShowFileSizes: false, LongPress2xEnabled: false },
    following: ['AutoResumeEnabled'], chosen: ['AutoPauseEnabled'], locked: ['LongPress2xEnabled']
  });
  const block = h.root.querySelector('.je-panel-nav .je-provenance-follow-all');
  const part = name => block.querySelector(`[data-follow-all="${name}"]`);
  assert.equal(part('start').hidden, false);
  assert.equal(part('confirm').hidden, true);
  part('start').click();
  assert.equal(part('confirm').hidden, false);
  assert.equal(part('start').hidden, true);
  // AutoPip and ShowFileSizes change; AutoPause (a choice equal to the default) only starts following.
  assert.equal(part('summary').textContent, 'panel_provenance_follow_all_confirm(2,3)');
  assert.equal(h.document.activeElement, part('apply'));
  part('cancel').click();
  assert.equal(part('confirm').hidden, true);
  assert.equal(h.requests.length, 0, 'nothing happens before the confirmation');

  part('start').click();
  part('apply').click();
  await h.flush();
  assert.deepEqual(h.requests.map(r => r.body), [{ Set: {}, Follow: ['AutoPipEnabled', 'AutoPauseEnabled', 'ShowFileSizes'] }]);
  assert.equal(h.JE.currentSettings.autoPipEnabled, false);
  assert.equal(h.root.querySelector('#autoPipToggle').checked, false, 'the rows show the defaults');
  assert.equal(h.root.querySelector('#showFileSizesToggle').checked, false);
  assert.equal(part('status').textContent, '[panel_provenance_follow_all_done]');
  assert.equal(part('start').hidden, true, 'nothing left to follow');
  assert.equal(part('confirm').hidden, true);
});

test('without changes the confirmation says nothing changes; with everything following there is no control', t => {
  const h = buildPanel(t, { values: { AutoPipEnabled: false }, defaults: { AutoPipEnabled: false } });
  const block = h.root.querySelector('.je-provenance-follow-all');
  block.querySelector('[data-follow-all="start"]').click();
  assert.equal(block.querySelector('[data-follow-all="summary"]').textContent, 'panel_provenance_follow_all_confirm_none(1)');

  const following = buildPanel(t, { values: { AutoPipEnabled: false }, defaults: { AutoPipEnabled: false }, following: ['AutoPipEnabled'] });
  assert.equal(following.root.querySelector('.je-provenance-follow-all'), null);
  // A server without Meta defaults (older) shows no provenance and no control.
  const old = buildPanel(t, { values: { AutoPipEnabled: true }, defaults: {} });
  assert.equal(old.root.querySelector('.je-provenance-follow-all'), null);
  assert.equal(old.root.querySelectorAll('.je-setting-provenance').length, 0);
});

test('a value set and "use the server default" in the same window: the later one wins', async t => {
  const h = buildPanel(t, { values: { AutoPipEnabled: true, AutoPauseEnabled: true }, defaults: { AutoPipEnabled: false, AutoPauseEnabled: false } });
  h.JE.currentSettings.autoPipEnabled = false;
  const set = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  const follow = h.JE.settings.follow(['AutoPipEnabled', 'autoPauseEnabled']);
  await h.flush();
  await Promise.all([set, follow]);
  assert.deepEqual(h.requests.map(r => r.body), [{ Set: {}, Follow: ['autoPipEnabled', 'autoPauseEnabled'].map(pascal) }]);

  h.requests.length = 0;
  const again = h.JE.settings.follow(['autoPauseEnabled']);
  h.JE.currentSettings.autoPauseEnabled = true;
  const setAfter = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  await h.flush();
  await Promise.all([again, setAfter]);
  assert.deepEqual(h.requests.map(r => r.body), [{ Set: { AutoPauseEnabled: true } }]);
  assert.deepEqual(h.server.state.chosen, ['AutoPauseEnabled']);
});

test('a value set and then "use the server default" in one window shows the default even when the baseline already had it', async t => {
  const h = buildPanel(t, { values: { AutoPipEnabled: true, AutoPauseEnabled: true }, defaults: { AutoPipEnabled: true, AutoPauseEnabled: true }, chosen: ['AutoPipEnabled'] });
  const events = [];
  h.document.addEventListener('je:settings-changed', e => events.push(plain(e.detail.keys)));
  h.JE.currentSettings.autoPipEnabled = false;
  const set = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  const follow = h.JE.settings.follow(['autoPipEnabled']);
  await h.flush();
  await Promise.all([set, follow]);
  assert.deepEqual(h.requests.map(r => r.body), [{ Set: {}, Follow: ['AutoPipEnabled'] }]);
  assert.equal(h.JE.currentSettings.autoPipEnabled, true, 'the followed default is shown, not the dropped Set');
  assert.ok(events.some(keys => keys.includes('autoPipEnabled')));

  // The next unrelated save does not pin the dropped value as a choice.
  h.requests.length = 0;
  h.JE.currentSettings.autoPauseEnabled = false;
  await Promise.all([h.JE.saveUserSettings('settings.json', h.JE.currentSettings), h.flush()]);
  assert.deepEqual(h.requests.map(r => r.body), [{ Set: { AutoPauseEnabled: false } }]);
  assert.deepEqual(h.server.state.following, ['AutoPipEnabled']);
});

test('a value set, "use the server default" and an unrelated save in one window keep the Follow', async t => {
  const h = buildPanel(t, { values: { AutoPipEnabled: true, AutoPauseEnabled: true }, defaults: { AutoPipEnabled: false, AutoPauseEnabled: true }, chosen: ['AutoPipEnabled'] });
  h.JE.currentSettings.autoPipEnabled = false;
  const set = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  const follow = h.JE.settings.follow(['autoPipEnabled']);
  h.JE.currentSettings.autoPauseEnabled = false;
  const unrelated = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  await h.flush();
  await Promise.all([set, follow, unrelated]);
  assert.deepEqual(h.requests.map(r => r.body), [{ Set: { AutoPauseEnabled: false }, Follow: ['AutoPipEnabled'] }]);
  assert.deepEqual(h.server.state.following, ['AutoPipEnabled']);
  assert.equal(h.JE.currentSettings.autoPipEnabled, false);

  // A value set after the Follow in the same window still wins.
  h.requests.length = 0;
  const again = h.JE.settings.follow(['autoPauseEnabled']);
  h.JE.currentSettings.autoPauseEnabled = true;
  const setAfter = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  await h.flush();
  await Promise.all([again, setAfter]);
  assert.deepEqual(h.requests.map(r => r.body), [{ Set: { AutoPauseEnabled: true } }]);
});

test('JE.settings.follow reports refused keys, and refuses when the server cannot follow', async t => {
  const h = buildPanel(t, { values: { AutoPipEnabled: true }, defaults: { AutoPipEnabled: false }, locked: ['AutoPipEnabled'] });
  const pending = h.JE.settings.follow(['autoPipEnabled', 'subtitleVerticalPosition']);
  await h.flush();
  assert.deepEqual(plain((await pending).rejected), [{ key: 'autoPipEnabled', reason: 'locked' }, { key: 'subtitleVerticalPosition', reason: 'invalid' }]);
  assert.deepEqual(plain(await h.JE.settings.follow([])), { rejected: [] });

  const legacy = buildPanel(t, { values: { AutoPipEnabled: true }, defaults: { AutoPipEnabled: false } }, { capabilities: [] });
  await assert.rejects(legacy.JE.settings.follow(['autoPipEnabled']), /cannot make settings follow/);
  legacy.JE.userConfig.settingsStatus = 'unavailable';
  await assert.rejects(legacy.JE.settings.follow(['autoPipEnabled']), /not loaded/);
  assert.equal(legacy.requests.length, 0);
});

test('a /patch route that disappears (404) reports the follow as not applied', async t => {
  const server = fakeServer({ values: { AutoPipEnabled: true }, defaults: { AutoPipEnabled: false } });
  const timers = manualTimers();
  const requests = [];
  const h = createHarness({
    globals: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    JE: { pluginConfig: {}, serverCapabilities: ['settingsPatch'], t: key => key, toast: () => {},
      userConfig: { settings: camel(server.resolved()), settingsStatus: 'ok' } },
    apiClient: {
      ajax: async (request) => {
        requests.push(new URL(request.url).pathname);
        if (request.url.endsWith('/patch')) throw Object.assign(new Error('gone'), { status: 404 });
        return undefined;
      }
    }
  });
  t.after(() => h.close());
  h.load('enhanced/config.js');
  h.JE.currentSettings = h.JE.loadSettings();
  const pending = h.JE.settings.follow(['autoPipEnabled']);
  await settle(); timers.runAll(); await settle();
  assert.deepEqual(plain((await pending).rejected), [{ key: 'autoPipEnabled', reason: 'unsupported' }]);
  assert.deepEqual(requests, ['/JellyfinEnhanced/user-settings/user-a/settings.json/patch', '/JellyfinEnhanced/user-settings/user-a/settings.json']);
});
