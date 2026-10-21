import test from 'node:test';
import assert from 'node:assert/strict';
import { tab, settingsServer, en } from '../helpers/settings-tabs.mjs';
import { createHarness, jsonResponse } from '../helpers/harness.mjs';

// Stage 1 fix round 11: every write JE sends for the signed-in person goes out through JE.core.userWrite.send, which
// checks the session the change was made in immediately before the request is built: after the API limiter, every await
// and every queue hop. RBS1-R11-1: a Spoiler Guard preference save whose limiter slot was granted just before an account
// switch went out with the next person's credentials (the queue had checked the session before the limiter). RBS1-R11-2:
// Remove from Continue Watching waited for a Hidden Content save, then was sent as the next person. A write cancelled
// that way is shown as not saved, once per account change.

const docs = () => ({ Settings: {}, Shortcuts: { Shortcuts: [] }, Bookmark: { Bookmarks: {} }, Elsewhere: { Region: 'US' }, HiddenContent: { Items: {}, Settings: {} } });

/** A page with the real session, queue and API client, against a server answering per person (by the user header). */
function preferencesPage(t) {
  let user = 'a';
  const writes = [];
  const prefs = { a: { HideCast: null }, b: { HideCast: null } };
  const toasts = [];
  const h = createHarness({
    JE: { pluginConfig: { SpoilerBlurEnabled: true }, t: key => en[key] ?? key, toast: message => toasts.push(message) },
    apiClient: { getCurrentUserId: () => user, accessToken: () => `token-${user}` },
    fetch: async (url, init) => {
      const owner = init.headers['X-Jellyfin-User-Id'];
      if (String(url).endsWith('/spoiler-blur/series')) return jsonResponse({ Prefs: structuredClone(prefs[owner]) });
      const body = JSON.parse(init.body);
      writes.push({ user: owner, token: init.headers['X-Emby-Token'], body });
      Object.assign(prefs[owner], body.Set);
      return jsonResponse({ success: true, prefs: structuredClone(prefs[owner]) });
    }
  });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  for (const file of ['core/navigation.js', 'core/session.js', 'core/mutation-queue.js', 'core/api-client.js', 'enhanced/spoilerguard/state.js']) h.load(file);
  return { h, writes, prefs, toasts, switchTo: next => { user = next; h.JE.session.checkNow('account switch'); } };
}

/** Takes every limiter slot with requests that wait until released. */
function fillLimiter(h) {
  const releases = [];
  const blockers = Array.from({ length: h.JE.core.api.manager.CONFIG.concurrency.maxConcurrent }, () =>
    h.JE.core.api.manager.withConcurrencyLimit(() => new h.window.Promise(resolve => { releases.push(resolve); })));
  return { releases, blockers };
}

test('R11-1: a preference save granted its API slot just before an account switch is not sent as the next person', async t => {
  const { h, writes, prefs, toasts, switchTo } = preferencesPage(t);
  const sg = h.JE.internals.spoilerGuard;
  await sg.whenLoaded();
  const { releases, blockers } = fillLimiter(h);
  const save = sg.setUserPrefs({ HideCast: false });
  // The queue has handed the save to the core fetch, which waits for a slot.
  await new Promise(r => setImmediate(r));
  releases[0]();
  // The account changes after the limiter granted the slot, before the waiting save resumes.
  queueMicrotask(() => switchTo('b'));
  await Promise.allSettled([save]);
  releases.slice(1).forEach(release => release());
  await Promise.allSettled(blockers);
  assert.deepEqual(writes, [], 'nothing was sent');
  assert.equal(prefs.b.HideCast, null);
  assert.equal(prefs.a.HideCast, null);
  assert.ok(toasts.includes(en.settings_not_saved_account_changed), `the person is told; toasts ${JSON.stringify(toasts)}`);
  await assert.rejects(save, error => error.sessionChanged === true);
});

test('R11-1 control: without a switch the save waits for its slot and is sent as the person who made it', async t => {
  const { h, writes, prefs } = preferencesPage(t);
  const sg = h.JE.internals.spoilerGuard;
  await sg.whenLoaded();
  const { releases, blockers } = fillLimiter(h);
  const save = sg.setUserPrefs({ HideCast: false });
  await new Promise(r => setImmediate(r));
  releases.forEach(release => release());
  await save;
  await Promise.allSettled(blockers);
  assert.deepEqual(writes.map(w => [w.user, w.token]), [['a', 'token-a']]);
  assert.equal(prefs.a.HideCast, false);
});

test('R11-1: a write retried after an account switch is not sent again (as anyone)', async t => {
  let user = 'a';
  const sent = [];
  const h = createHarness({
    JE: { t: key => key, toast() {} },
    apiClient: { getCurrentUserId: () => user, accessToken: () => `token-${user}` },
    fetch: async (url, init) => {
      sent.push(init.headers['X-Jellyfin-User-Id']);
      // The first attempt meets a busy server; the person changes before the retry.
      user = 'b';
      h.JE.session.checkNow('account switch');
      return new Response('busy', { status: 503 });
    }
  });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  for (const file of ['core/navigation.js', 'core/session.js', 'core/mutation-queue.js', 'core/api-client.js']) h.load(file);
  h.JE.core.api.manager.CONFIG.retry.baseDelayMs = 1;
  h.JE.core.api.manager.CONFIG.retry.maxDelayMs = 2;
  await assert.rejects(h.JE.core.api.plugin('/acquire/follows', { method: 'PUT', body: { key: 'k', on: true } }), error => error.sessionChanged === true);
  assert.deepEqual(sent, ['a'], 'one attempt, as the person who made the change');
});

test('R11-2: Remove from Continue Watching waiting behind a Hidden Content save is never sent as the next person', async t => {
  const s = settingsServer(docs());
  let user = 'user-a';
  const hides = [];
  const h = await tab(t, s, { ajax: request => {
    if (request.type === 'POST' && request.url.includes('/continue-watching/hide/')) { hides.push(user); return { success: true }; }
  } });
  h.window.ApiClient.getCurrentUserId = () => user;
  h.load('enhanced/hiddencontent/hidden-content-save.js');
  h.JE.hiddenContent = { flushPendingSave: h.JE.internals.hiddenContent.flushPendingSave };
  h.load('enhanced/homeremoval/features-remove-home.js');
  const held = s.hold('hidden-content.json', 'PATCH');
  const first = h.JE.patchUserSettings('hidden-content.json', { set: { enabled: true } }, { throwOnError: true });
  await held.reached;
  const hide = h.JE.internals.features.removeFromHomeSurface('movie', 'continuewatching');
  await new Promise(r => setImmediate(r));
  user = 'user-b';
  h.JE.session.checkNow('account switch');
  held.release();
  await Promise.allSettled([first, hide]);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(hides, [], 'the previous person\'s hide was cancelled, not written as user-b');
  assert.equal(await hide, false);
  assert.ok(h.toasts.some(toast => toast.message === h.JE.t('settings_not_saved_account_changed')), 'and the page says it wasn\'t saved');
});

test('R11-2 control: the hide goes out after the Hidden Content save it waited for, and is acknowledged', async t => {
  const s = settingsServer(docs());
  const order = [];
  const h = await tab(t, s, { ajax: request => {
    if (request.type === 'POST' && request.url.includes('/continue-watching/hide/')) {
      order.push('hide');
      s.apply('hidden-content.json', 'PATCH', { Upsert: { movie: { ItemId: 'movie', HideScope: 'continuewatching' } } });
      return { success: true, revision: s.revision('hidden-content.json') };
    }
    if (request.type === 'PATCH' && request.url.includes('/hidden-content.json')) order.push('save');
  } });
  h.load('enhanced/hiddencontent/hidden-content-save.js');
  h.load('enhanced/hiddencontent/hidden-content-data.js');
  h.JE.hiddenContent = { flushPendingSave: h.JE.internals.hiddenContent.flushPendingSave, markScopedHidden: h.JE.internals.hiddenContent.markScopedHidden };
  h.load('enhanced/homeremoval/features-remove-home.js');
  const held = s.hold('hidden-content.json', 'PATCH');
  const first = h.JE.patchUserSettings('hidden-content.json', { set: { enabled: true } }, { throwOnError: true });
  await held.reached;
  const hide = h.JE.internals.features.removeFromHomeSurface('movie', 'continuewatching');
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(order, ['save'], 'the hide waits for the save that is out');
  held.release();
  await first;
  assert.equal(await hide, true);
  assert.deepEqual(order, ['save', 'hide']);
  assert.ok(h.JE.internals.userDocument('hidden-content.json').document.items.movie, 'the hide is part of the document');
  assert.equal(s.documents.HiddenContent.Settings.enabled ?? s.documents.HiddenContent.Settings.Enabled, true);
});
