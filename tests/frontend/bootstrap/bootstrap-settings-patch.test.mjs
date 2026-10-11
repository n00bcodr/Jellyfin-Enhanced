import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain, deferred } from '../helpers/harness.mjs';

// Design item C1: JE.saveUserSettings('settings.json', …) sends only what differs from the last
// server-confirmed values, merged over a 250 ms window, to POST settings.json/patch; pending edits
// survive refreshes; servers without the route get the whole document as before.

/** Window timers the test advances by hand (the code under test runs in the jsdom window). */
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

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

/** The document GET settings.json serves (PascalCase), here a small one. */
const served = (overrides = {}) => ({
  AutoPipEnabled: false, AutoPauseEnabled: true, QualityTagsEnabled: false, ResolutionTagOrder: null, UseNativePosterTags: null,
  WatchProgressMode: 'percentage', SubtitleVerticalPosition: 85, DisplayLanguage: '', LastOpenedTab: 'shortcuts', IsAdmin: false, ...overrides
});
const camel = object => Object.fromEntries(Object.entries(object).map(([key, value]) => [key.charAt(0).toLowerCase() + key.slice(1), value]));

/**
 * config.js on its own, signed in as user-a with a loaded settings document. `respond(request)`
 * answers each request (default: the patch applied to the server copy, all keys accepted).
 */
function setup(t, { capabilities = ['settingsPatch'], document = served(), respond, pluginConfig = { ResolutionTagOrder: 4 } } = {}) {
  const requests = [], toasts = [], events = [];
  const timers = manualTimers();
  let userId = 'user-a';
  let server = { ...document };
  const h = createHarness({
    globals: { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    JE: { pluginConfig, serverCapabilities: capabilities, userConfig: { settings: camel(document), settingsStatus: 'ok' },
      t: key => key, toast: message => toasts.push(message),
      // plugin.js's converter (exercised by the bootstrap tests); config.js uses it for patch answers.
      camelCaseSettingsMeta: meta => Object.fromEntries(Object.entries(meta).map(([key, value]) => [key.charAt(0).toLowerCase() + key.slice(1),
        Array.isArray(value) ? value.map(name => name.charAt(0).toLowerCase() + name.slice(1)) : value])) },
    apiClient: {
      getCurrentUserId: () => userId,
      ajax: async request => {
        const entry = { url: new URL(request.url).pathname, body: JSON.parse(request.data), dataType: request.dataType };
        requests.push(entry);
        if (respond) return respond(entry, server);
        if (entry.url.endsWith('/patch')) {
          Object.assign(server, entry.body.Set);
          return { success: true, Revision: 'r', Applied: Object.keys(entry.body.Set), Rejected: [], Settings: { ...server }, Meta: { Chosen: Object.keys(entry.body.Set) } };
        }
        server = { ...entry.body };
        return undefined;
      }
    }
  });
  t.after(() => h.close());
  h.load('enhanced/config.js');
  h.JE.currentSettings = h.JE.loadSettings();
  h.document.addEventListener('je:settings-changed', e => events.push(plain(e.detail)));
  return { ...h, requests, toasts, events, timers, get server() { return server; }, set server(value) { server = value; },
    switchUser(id) { userId = id; } };
}

test('a whole-document save sends only the changed key to /patch after the merge window', async t => {
  const h = setup(t);
  // The tag order is null on the server (inherits the admin order 4); the client shows 4.
  assert.equal(h.JE.currentSettings.resolutionTagOrder, 4);
  assert.equal(h.JE.currentSettings.useNativePosterTags, true);
  h.JE.currentSettings.autoPipEnabled = true;
  const saved = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  await settle();
  assert.equal(h.requests.length, 0, 'nothing is sent inside the window');
  assert.equal([...h.timers.pending.values()][0].ms, 250);
  h.timers.runAll();
  await saved;
  assert.deepEqual(h.requests, [{ url: '/JellyfinEnhanced/user-settings/user-a/settings.json/patch', body: { Set: { AutoPipEnabled: true } }, dataType: 'json' }],
    'the inherited tag order, the unset native-tags choice, IsAdmin and LastOpenedTab are not sent');
  assert.equal(h.JE.userConfig.settings.autoPipEnabled, true, 'the answer becomes the new baseline');
  assert.deepEqual(plain(h.JE.settingsMeta), { chosen: ['autoPipEnabled'] });

  // Saving the same document again sends nothing.
  await h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  h.timers.runAll(); await settle();
  assert.equal(h.requests.length, 1);
});

test('saves within the window go out as one request and every caller is resolved', async t => {
  const h = setup(t);
  const order = [];
  h.JE.currentSettings.autoPipEnabled = true;
  const first = h.JE.saveUserSettings('settings.json', h.JE.currentSettings).then(() => order.push('first'));
  h.JE.currentSettings.subtitleVerticalPosition = 40;
  const second = h.JE.saveUserSettings('settings.json', h.JE.currentSettings).then(() => order.push('second'));
  h.JE.currentSettings.autoPipEnabled = false; // toggled back before the window closed
  const third = h.JE.saveUserSettings('settings.json', h.JE.currentSettings).then(() => order.push('third'));
  await settle();
  assert.equal(h.timers.pending.size, 1, 'one window for the three saves');
  h.timers.runAll();
  await Promise.all([first, second, third]);
  assert.deepEqual(order, ['first', 'second', 'third']);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.requests[0].body, { Set: { AutoPipEnabled: false, SubtitleVerticalPosition: 40 } });
});

test('edits made while a patch is in flight go in the next request, in order', async t => {
  const gate = deferred();
  const h = setup(t, { respond: async (entry, server) => {
    if (h.requests.length === 1) await gate.promise;
    Object.assign(server, entry.body.Set);
    return { success: true, Rejected: [], Settings: { ...server } };
  } });
  h.JE.currentSettings.autoPipEnabled = true;
  const first = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  h.timers.runAll(); await settle();
  h.JE.currentSettings.autoPauseEnabled = false;
  const second = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  h.timers.runAll(); await settle();
  assert.equal(h.requests.length, 1, 'the second request waits for the first');
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(h.requests.map(r => r.body.Set), [{ AutoPipEnabled: true }, { AutoPauseEnabled: false }]);
  assert.equal(h.server.AutoPipEnabled, true);
  assert.equal(h.server.AutoPauseEnabled, false);
});

test('a refresh lands beneath pending edits and another device\'s change is not sent back', async t => {
  const gate = deferred();
  const h = setup(t, { respond: async (entry, server) => {
    await gate.promise;
    Object.assign(server, entry.body.Set);
    return { success: true, Rejected: [], Settings: { ...server } };
  } });
  h.JE.currentSettings.autoPipEnabled = true;
  const saved = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  h.timers.runAll(); await settle();

  // The panel opens while the patch is in flight and refreshes from the server, which another
  // device has changed meanwhile (quality tags on); the refresh does not yet have our edit.
  h.server = { ...h.server, QualityTagsEnabled: true };
  h.JE.userConfig.settings = camel(h.server);
  h.JE.currentSettings = h.JE.loadSettings();
  assert.equal(h.JE.currentSettings.autoPipEnabled, true, 'the pending edit stays on top');
  assert.equal(h.JE.currentSettings.qualityTagsEnabled, true, "the other device's value lands");

  gate.resolve(); await saved;
  h.JE.currentSettings.subtitleVerticalPosition = 60;
  const next = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  h.timers.runAll(); await next;
  assert.deepEqual(h.requests.map(r => r.body.Set), [{ AutoPipEnabled: true }, { SubtitleVerticalPosition: 60 }]);
  assert.equal(h.server.QualityTagsEnabled, true, 'not reverted');
});

test('a value changed elsewhere arrives with the patch answer and is announced', async t => {
  const h = setup(t, { respond: (entry, server) => {
    Object.assign(server, entry.body.Set, { QualityTagsEnabled: true, WatchProgressMode: 'time' });
    return { success: true, Rejected: [], Settings: { ...server } };
  } });
  h.JE.currentSettings.autoPipEnabled = true;
  const saved = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  h.timers.runAll(); await saved;
  assert.equal(h.JE.currentSettings.qualityTagsEnabled, true);
  assert.equal(h.JE.currentSettings.watchProgressMode, 'time');
  assert.deepEqual(h.events, [{ keys: ['qualityTagsEnabled', 'watchProgressMode'], rejected: [] }]);
  // Nothing of that is sent back by the next save.
  h.JE.currentSettings.autoPauseEnabled = false;
  const next = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  h.timers.runAll(); await next;
  assert.deepEqual(h.requests[1].body, { Set: { AutoPauseEnabled: false } });
});

test('a rejected key goes back to the server value, is announced, and fails a throwOnError caller', async t => {
  const h = setup(t, { respond: (entry, server) => {
    const { SubtitleVerticalPosition, ...accepted } = entry.body.Set;
    Object.assign(server, accepted);
    return { success: true, Rejected: SubtitleVerticalPosition === undefined ? [] : [{ Key: 'SubtitleVerticalPosition', Reason: 'invalid' }], Settings: { ...server } };
  } });
  h.allowConsoleError(/./);
  h.JE.currentSettings.subtitleVerticalPosition = 500;
  h.JE.currentSettings.autoPipEnabled = true;
  const saved = h.JE.saveUserSettings('settings.json', h.JE.currentSettings, { throwOnError: true });
  h.timers.runAll();
  await assert.rejects(saved, /subtitleVerticalPosition \(invalid\)/);
  assert.equal(h.JE.currentSettings.subtitleVerticalPosition, 85);
  assert.equal(h.JE.currentSettings.autoPipEnabled, true);
  assert.deepEqual(h.events, [{ keys: ['subtitleVerticalPosition'], rejected: [{ key: 'subtitleVerticalPosition', reason: 'invalid' }] }]);
});

test('a server without /patch (404 or 405) gets the whole document, now and for later saves', async t => {
  for (const status of [404, 405]) {
    await t.test(`status ${status}`, async t => {
      const h = setup(t, { respond: (entry, server) => {
        if (entry.url.endsWith('/patch')) { const error = new Error('Not Found'); error.status = status; throw error; }
        Object.assign(server, entry.body);
        return undefined;
      } });
      h.JE.currentSettings.autoPipEnabled = true;
      const saved = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
      h.timers.runAll(); await saved;
      assert.deepEqual(h.requests.map(r => r.url), ['/JellyfinEnhanced/user-settings/user-a/settings.json/patch', '/JellyfinEnhanced/user-settings/user-a/settings.json']);
      // (camelCase here: config.js converts with plugin.js's JE.toPascalCase, not loaded in this harness)
      const whole = h.requests[1].body;
      assert.equal(whole.autoPipEnabled, true);
      assert.equal(whole.useNativePosterTags, null, 'the old route keeps the unset native-tags rule');
      assert.equal(whole.subtitleVerticalPosition, 85);

      h.JE.currentSettings.autoPauseEnabled = false;
      await h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
      assert.equal(h.timers.pending.size, 0, 'no merge window on the old route');
      assert.deepEqual(h.requests.map(r => r.url).slice(2), ['/JellyfinEnhanced/user-settings/user-a/settings.json']);
    });
  }
});

test('without the settingsPatch capability saves use the whole-document route', async t => {
  const h = setup(t, { capabilities: null });
  h.JE.currentSettings.autoPipEnabled = true;
  await h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/JellyfinEnhanced/user-settings/user-a/settings.json');
  assert.equal(h.requests[0].body.autoPipEnabled, true);
  assert.equal(h.requests[0].body.autoPauseEnabled, true);
});

test('a failed patch shows the error and the next save sends the key again', async t => {
  let fail = true;
  const h = setup(t, { respond: (entry, server) => {
    if (fail) throw new Error('500 Internal Server Error');
    Object.assign(server, entry.body.Set);
    return { success: true, Rejected: [], Settings: { ...server } };
  } });
  h.expectConsoleError(/Failed to save settings\.json/);
  h.JE.currentSettings.autoPipEnabled = true;
  const saved = h.JE.saveUserSettings('settings.json', h.JE.currentSettings, { notifyOnError: true });
  h.timers.runAll(); await saved;
  assert.equal(h.toasts.length, 1);
  assert.equal(h.JE.currentSettings.autoPipEnabled, true, 'the control keeps the new value (no revert, design 5.3)');

  fail = false;
  h.JE.currentSettings.autoPauseEnabled = false;
  const retry = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  h.timers.runAll(); await retry;
  assert.deepEqual(h.requests[1].body, { Set: { AutoPipEnabled: true, AutoPauseEnabled: false } });
});

test('leaving the page sends a waiting batch at once', async t => {
  const h = setup(t);
  h.JE.currentSettings.autoPipEnabled = true;
  const saved = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  h.window.dispatchEvent(new h.window.Event('pagehide'));
  await saved;
  assert.equal(h.requests.length, 1);
  assert.equal(h.timers.pending.size, 0);

  h.JE.currentSettings.autoPauseEnabled = false;
  const hidden = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  Object.defineProperty(h.document, 'visibilityState', { configurable: true, value: 'hidden' });
  h.document.dispatchEvent(new h.window.Event('visibilitychange'));
  await hidden;
  assert.equal(h.requests.length, 2);
});

test('edits waiting when the user switches are dropped, not sent for the next user', async t => {
  const h = setup(t);
  h.JE.currentSettings.autoPipEnabled = true;
  const saved = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  h.switchUser('user-b');
  h.timers.runAll(); await saved;
  assert.deepEqual(h.requests, []);
});

test('an edit written into the loaded document itself (the native poster tags row) is still sent', async t => {
  const h = setup(t);
  // ui-panel-settings.js records the explicit choice in JE.userConfig.settings before saving.
  h.JE.userConfig.settings.useNativePosterTags = false;
  h.JE.currentSettings.useNativePosterTags = false;
  const saved = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  h.timers.runAll(); await saved;
  assert.deepEqual(h.requests.map(r => r.body), [{ Set: { UseNativePosterTags: false } }]);
});

test('A-B-A over three requests: the first answer does not settle the last edit, and a refresh keeps it on top', async t => {
  const gates = [deferred(), deferred(), deferred()];
  const h = setup(t, { document: served({ AutoPipEnabled: true }), respond: async (entry, server) => {
    const index = h.requests.length - 1;
    if (gates[index]) await gates[index].promise;
    Object.assign(server, entry.body.Set);
    return { success: true, Rejected: [], Settings: { ...server }, Meta: { Chosen: ['AutoPipEnabled'] } };
  } });
  const saves = [];
  for (const value of [false, true, false]) {
    h.JE.currentSettings.autoPipEnabled = value;
    saves.push(h.JE.saveUserSettings('settings.json', h.JE.currentSettings));
    h.timers.runAll(); await settle();
  }
  gates[0].resolve(); await saves[0]; await settle();
  gates[1].resolve(); await saves[1]; await settle();
  assert.deepEqual(h.requests.map(r => r.body.Set), [{ AutoPipEnabled: false }, { AutoPipEnabled: true }, { AutoPipEnabled: false }]);
  assert.equal(h.server.AutoPipEnabled, true, 'the third request is still in flight');

  // The panel reopens and refreshes from the server, which has the second request's value.
  h.JE.userConfig.settings = camel(h.server);
  h.JE.currentSettings = h.JE.loadSettings();
  assert.equal(h.JE.currentSettings.autoPipEnabled, false, 'the last edit stays on top of the refresh');

  gates[2].resolve(); await saves[2];
  assert.equal(h.server.AutoPipEnabled, false);
  assert.equal(h.JE.currentSettings.autoPipEnabled, false);

  // An unrelated save does not send the key back.
  h.JE.currentSettings.autoPauseEnabled = false;
  const next = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  h.timers.runAll(); await next;
  assert.deepEqual(h.requests[3].body, { Set: { AutoPauseEnabled: false } });
  assert.equal(h.server.AutoPipEnabled, false, "the user's last choice stands");
});

test('a patch answer older than a refresh taken while it was in flight does not replace it', async t => {
  const gate = deferred();
  let answer;
  const h = setup(t, { respond: async (entry, server) => {
    const { SubtitleVerticalPosition, ...accepted } = entry.body.Set;
    Object.assign(server, accepted);
    // The answer is built now; another device changes a key before it arrives.
    answer = { success: true, Rejected: [{ Key: 'SubtitleVerticalPosition', Reason: 'invalid' }], Settings: { ...server }, Meta: { Chosen: ['AutoPipEnabled'] } };
    await gate.promise;
    return answer;
  } });
  h.allowConsoleError(/./);
  h.JE.userConfig.settingsMeta = { chosen: ['qualityTagsEnabled'] };
  h.JE.currentSettings.autoPipEnabled = true;
  h.JE.currentSettings.subtitleVerticalPosition = 500;
  const saved = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  h.timers.runAll(); await settle();

  h.server = { ...h.server, QualityTagsEnabled: true, SubtitleVerticalPosition: 70 };
  const refreshed = camel(h.server);
  h.JE.userConfig.settings = refreshed;
  h.JE.currentSettings = h.JE.loadSettings();
  gate.resolve(); await saved;

  assert.equal(h.JE.currentSettings.qualityTagsEnabled, true, "the older answer's value is not applied");
  assert.equal(h.JE.currentSettings.autoPipEnabled, true);
  assert.equal(h.JE.currentSettings.subtitleVerticalPosition, 70, "a rejected key goes back to the newer document's value");
  assert.equal(h.JE.userConfig.settings, refreshed, 'the refresh stays the loaded document');
  assert.equal(refreshed.autoPipEnabled, true, 'with the value this request wrote');
  assert.deepEqual(plain(h.JE.settingsMeta), { chosen: ['qualityTagsEnabled'] }, 'the Meta is left as it was');
  assert.deepEqual(h.events, [{ keys: ['subtitleVerticalPosition'], rejected: [{ key: 'subtitleVerticalPosition', reason: 'invalid' }] }]);

  h.JE.currentSettings.autoPauseEnabled = false;
  const next = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  h.timers.runAll(); await next;
  assert.deepEqual(h.requests[1].body.Set, { AutoPauseEnabled: false }, 'nothing stale is sent back');
  assert.equal(h.server.QualityTagsEnabled, true);
});

test('a 404 from /patch after the user switched posts nothing to the old route', async t => {
  const h = setup(t, { respond: entry => {
    if (entry.url.endsWith('/patch')) {
      // The session switches to another user while the request is in flight.
      h.switchUser('user-b');
      h.JE.currentSettings = { ...h.JE.currentSettings, autoPipEnabled: false, qualityTagsEnabled: true };
      const error = new Error('Not Found'); error.status = 404; throw error;
    }
    return undefined;
  } });
  h.JE.currentSettings.autoPipEnabled = true;
  const saved = h.JE.saveUserSettings('settings.json', h.JE.currentSettings);
  h.timers.runAll(); await saved;
  assert.deepEqual(h.requests.map(r => r.url), ['/JellyfinEnhanced/user-settings/user-a/settings.json/patch']);
});
