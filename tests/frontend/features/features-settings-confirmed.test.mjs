import test from 'node:test';
import assert from 'node:assert/strict';
import { tab, settingsServer, en } from '../helpers/settings-tabs.mjs';
import { createHarness, deferred } from '../helpers/harness.mjs';

// Stage 1 fix round 11: a control says "saved" or "updated" only after the server stored the change, and a change cancelled
// or refused after it was shown is shown as not saved (RBS1-R11-4: the panel's toggles and position pickers confirmed at
// once, while an account switch cancelled the change and only a console line said so).

const docs = () => ({ Settings: {}, Shortcuts: { Shortcuts: [] }, Bookmark: { Bookmarks: {} }, Elsewhere: { Region: 'US' }, HiddenContent: { Items: {}, Settings: {} } });
const TOGGLES = ['autoPauseToggle', 'autoResumeToggle', 'autoPipToggle', 'autoSkipIntroToggle', 'autoSkipOutroToggle',
  'randomButtonToggle', 'randomUnwatchedOnly', 'randomScopeCurrentContainer', 'showWatchProgressToggle', 'showFileSizesToggle',
  'showAudioLanguagesToggle', 'removeContinueWatchingToggle', 'qualityTagsToggle', 'genreTagsToggle', 'pauseScreenToggle',
  'languageTagsToggle', 'ratingTagsToggle', 'ageRatingTagsToggle', 'peopleTagsToggle', 'tagsHideOnHoverToggle',
  'disableCustomSubtitleStyles', 'longPress2xEnabled', 'nativePosterTagsToggle'];

async function panelTab(t, s) {
  const h = await tab(t, s, { extra: ['enhanced/settingspanel/ui-panel-settings.js'],
    html: TOGGLES.map(id => `<input type="checkbox" id="${id}">`).join('') });
  h.allowConsoleError(/./);
  h.JE.internals.enhancedUi.wireSettingsListeners({ createToast: (key, enabled) => `${key}:${enabled}`, resetAutoCloseTimer() {} });
  return h;
}

test('R11-4: a panel toggle says it is on only once the server stored it', async t => {
  const s = settingsServer(docs());
  const h = await panelTab(t, s);
  const held = s.hold('settings.json', 'PATCH');
  const input = h.document.getElementById('autoPauseToggle');
  input.checked = false;
  input.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await held.reached;
  assert.ok(!h.toasts.some(toast => toast.message.startsWith('feature_auto_pause')), 'no confirmation before the answer');
  held.release();
  await h.JE.internals.userDocumentSettled('settings.json');
  await new Promise(r => setImmediate(r));
  assert.ok(h.toasts.some(toast => toast.message === 'feature_auto_pause:false'), 'confirmed after it was stored');
  assert.equal(s.documents.Settings.AutoPauseEnabled, false);
});

test('R11-4: a toggle cancelled by an account switch is shown as not saved, never confirmed', async t => {
  const s = settingsServer(docs());
  s.documents.Settings.AutoPauseEnabled = false;
  const h = await panelTab(t, s);
  const held = s.hold('settings.json', 'PATCH');
  const first = h.JE.updateSettings({ autoResumeEnabled: true }, { throwOnError: true });
  await held.reached;
  const input = h.document.getElementById('autoPauseToggle');
  input.checked = true;
  input.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  const settled = h.JE.internals.userDocumentSettled('settings.json');
  h.window.ApiClient.getCurrentUserId = () => 'user-b';
  h.JE.session.checkNow('account switch');
  held.release();
  await Promise.allSettled([first, settled]);
  await new Promise(r => setImmediate(r));
  assert.notEqual(s.documents.Settings.AutoPauseEnabled, true, 'the cancelled change was not sent');
  assert.ok(!h.toasts.some(toast => toast.message === 'feature_auto_pause:true'), 'never confirmed');
  assert.ok(h.toasts.some(toast => toast.message === en.settings_not_saved_account_changed), 'shown as not saved');
});

test('R11-4: a change the server refuses is shown as not saved, never confirmed', async t => {
  const s = settingsServer(docs());
  const h = await panelTab(t, s);
  s.failWrites.add('settings.json');
  const input = h.document.getElementById('autoResumeToggle');
  input.checked = true;
  input.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await h.JE.internals.userDocumentSettled('settings.json');
  await new Promise(r => setImmediate(r));
  assert.ok(!h.toasts.some(toast => toast.message.startsWith('feature_auto_resume')), 'never confirmed');
  assert.ok(h.toasts.some(toast => toast.message === en.settings_not_saved), 'shown as not saved');
  assert.equal(h.JE.currentSettings.autoResumeEnabled, false, 'the stored value is shown again');
});

test('R11-4: a position change cancelled at an account switch is shown as not saved, not "updated"', async t => {
  const held = deferred(), sent = [], toasts = [];
  let user = 'a';
  const h = createHarness({ html: TOGGLES.map(id => `<input type="checkbox" id="${id}">`).join('')
      + '<div class="position-selector" data-setting="qualityTagsPosition"><button data-pos="bottom-right">position</button></div>',
    JE: { pluginConfig: {}, userConfig: { settings: {}, shortcuts: { Shortcuts: [] } }, currentSettings: {}, t: key => en[key] ?? key, toast: m => toasts.push(m) },
    apiClient: { getCurrentUserId: () => user, ajax: async request => { sent.push({ user, request }); await held.promise; return {}; } }
  });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  for (const p of ['core/navigation.js', 'core/session.js', 'core/mutation-queue.js', 'enhanced/config.js', 'enhanced/settingspanel/ui-panel-settings.js']) h.load(p);
  h.JE.currentSettings = h.JE.loadSettings();
  h.JE.internals.enhancedUi.wireSettingsListeners({ help: h.document.body, createToast: (k, v) => `${k}:${v}`, resetAutoCloseTimer() {} });
  h.JE.internals.enhancedUi.wireMiscSettingsControls({ help: h.document.body, primaryAccentColor: '#fff', resetAutoCloseTimer() {} });
  const first = h.JE.updateSettings({ autoPauseEnabled: true });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(sent.length, 1);
  h.document.querySelector('[data-pos]').click();
  assert.ok(!toasts.includes(en.toast_position_updated), 'no confirmation before the answer');
  user = 'b';
  h.JE.session.checkNow('account switch');
  held.resolve();
  await first;
  await new Promise(r => setTimeout(r, 30));
  assert.equal(sent.length, 1, 'the position change was cancelled unsent');
  assert.ok(!toasts.includes(en.toast_position_updated), 'never "updated"');
  assert.ok(toasts.includes(en.settings_not_saved_account_changed), `shown as not saved; got ${JSON.stringify(toasts)}`);
});

test('R11-4 control: a position change the server stores says "updated" once stored', async t => {
  const s = settingsServer(docs());
  const h = await tab(t, s, { extra: ['enhanced/settingspanel/ui-panel-settings.js'],
    html: TOGGLES.map(id => `<input type="checkbox" id="${id}">`).join('') + '<div class="position-selector" data-setting="qualityTagsPosition"><button data-pos="bottom-right">position</button></div>' });
  h.allowConsoleError(/./);
  h.JE.internals.enhancedUi.wireMiscSettingsControls({ help: h.document.body, primaryAccentColor: '#fff', resetAutoCloseTimer() {} });
  h.document.querySelector('[data-pos]').click();
  await h.JE.internals.userDocumentSettled('settings.json');
  await new Promise(r => setImmediate(r));
  assert.equal(s.documents.Settings.QualityTagsPosition, 'bottom-right');
  assert.ok(h.toasts.some(toast => toast.message === en.toast_position_updated));
});
