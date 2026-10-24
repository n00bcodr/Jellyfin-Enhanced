import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';
import { tab, settingsServer, en } from '../helpers/settings-tabs.mjs';

// Stage 1 fix round 12: a write ends stored, refused/unsent, or uncertain, and only a proven outcome is said as such.
// An uncertain write (its attempt went out, its answer was lost) is never sent again unless it is idempotent, is never
// said to be "not saved", and one bounded read of the same document says what the server holds.

function loadCore(h) {
  for (const path of ['core/navigation.js', 'core/session.js', 'core/mutation-queue.js', 'core/api-client.js']) h.load(path);
}

function core(t, fetch, user = () => 'a') {
  const notices = [];
  const h = createHarness({
    JE: { t: key => en[key] ?? key, toast: message => notices.push(message) },
    apiClient: { getCurrentUserId: () => user(), accessToken: () => 'fixture-' + user() },
    fetch
  });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  loadCore(h);
  h.JE.core.api.manager.CONFIG.retry.baseDelayMs = 1;
  h.JE.core.api.manager.CONFIG.retry.maxDelayMs = 2;
  return { h, notices };
}

// The session now, as the action's origin (also how the base took a write's binding, so the case runs there too).
const originNow = h => (h.JE.core.userWrite.origin || h.JE.core.userWrite.bind)();

const docs = () => ({ Settings: { AutoResumeEnabled: false }, Shortcuts: { Shortcuts: [] }, Bookmark: { Bookmarks: {} }, Elsewhere: {}, HiddenContent: { Items: {}, Settings: {} } });
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

test('a non-idempotent write whose answer was lost is never sent again; the error says uncertain', async t => {
  let attempts = 0;
  const { h } = core(t, async () => { attempts++; throw new TypeError('connection lost'); });
  const error = await h.JE.core.api.plugin('/acquire/requests', { method: 'POST', body: { x: 1 }, session: originNow(h) }).catch(e => e);
  assert.equal(attempts, 1, 'a POST that may be stored is not repeated');
  assert.equal(h.JE.core.userWrite.outcome(error), 'uncertain');
});

test('an idempotent write may be retried after a lost answer, and then is stored', async t => {
  let attempts = 0;
  const { h } = core(t, async () => {
    attempts++;
    if (attempts === 1) throw new TypeError('connection lost');
    return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const answer = await h.JE.core.api.plugin('/acquire/follows', { method: 'PUT', body: { key: 'k', on: true }, session: originNow(h) });
  assert.equal(attempts, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(answer)), { ok: true });
});

test('a DELETE whose first attempt was lost and whose retry an account switch cancelled stays uncertain', async t => {
  let user = 'a', attempts = 0;
  const { h, notices } = core(t, async () => {
    attempts++;
    user = 'b';
    h.JE.session.checkNow('switch after the attempt went out');
    throw new TypeError('connection lost');
  }, () => user);
  const error = await h.JE.core.api.plugin('/acquire/follows/k', { method: 'DELETE', session: originNow(h) }).catch(e => e);
  assert.equal(attempts, 1, 'the retry is never sent as the next person');
  h.JE.core.userWrite.notSent(error);
  assert.ok(!notices.includes(en.settings_not_saved_account_changed), 'a cancelled retry does not prove the first attempt missed');
  assert.ok(notices.includes(en.settings_unconfirmed_account_changed));
  assert.equal(h.JE.core.userWrite.outcome(error), 'uncertain');
});

test('a refusal is proven: the page says not saved and shows the stored value', async t => {
  const s = settingsServer(docs());
  const h = await tab(t, s, { ajax: request => {
    if (request.type === 'PATCH') throw Object.assign(new Error('refused'), { status: 422 });
  } });
  await h.JE.updateSettings({ autoResumeEnabled: true });
  await settle();
  assert.ok(h.toasts.some(x => x.message === en.settings_not_saved));
  assert.equal(h.JE.currentSettings.autoResumeEnabled, false);
});

test('a lost answer of a stored PATCH is confirmed by one read: "saved", and the change stays', async t => {
  const s = settingsServer(docs());
  let reads = 0;
  const h = await tab(t, s, { ajax: request => {
    if (request.type === 'GET' && request.url.includes('/settings.json')) reads++;
    if (request.type === 'PATCH' && request.url.endsWith('/settings.json')) {
      s.apply('settings.json', 'PATCH', JSON.parse(request.data));
      throw new TypeError('connection lost after commit');
    }
  } });
  const before = reads;
  await h.JE.updateSettings({ autoResumeEnabled: true });
  await settle(12);
  assert.equal(reads - before, 1, 'one reconciliation read, never repeated');
  assert.ok(h.toasts.some(x => x.message === en.settings_save_unconfirmed), 'first: it could not be confirmed');
  assert.ok(h.toasts.some(x => x.message === en.settings_save_confirmed), 'then: the read shows it was saved');
  assert.ok(!h.toasts.some(x => x.message === en.settings_not_saved));
  assert.equal(h.JE.currentSettings.autoResumeEnabled, true);
  assert.equal(s.writes.filter(w => w.type === 'PATCH').length, 1, 'the write itself is never sent again');
});

test('a lost answer of a PATCH that was not stored is never said as "not saved": the page shows what the server holds', async t => {
  const s = settingsServer(docs());
  const h = await tab(t, s, { ajax: request => {
    if (request.type === 'PATCH' && request.url.endsWith('/settings.json')) throw new TypeError('connection lost before commit');
  } });
  await h.JE.updateSettings({ autoResumeEnabled: true });
  await settle(12);
  assert.ok(!h.toasts.some(x => x.message === en.settings_not_saved));
  assert.ok(h.toasts.some(x => x.message === en.settings_save_unconfirmed_read));
  assert.equal(h.JE.currentSettings.autoResumeEnabled, false, 'the server\'s document is shown');
});

test('a reconciliation read is cancelled by an account switch: nothing is read or said as the next person', async t => {
  const s = settingsServer(docs());
  let user = 'user-a', readsAsB = 0;
  const h = await tab(t, s, { ajax: request => {
    // The next person's own documents load as theirs; the previous person's document is never read as them.
    if (request.type === 'GET' && user !== 'user-a' && request.url.includes('/user-settings/user-a/')) readsAsB++;
    if (request.type === 'PATCH' && request.url.endsWith('/settings.json')) {
      user = 'user-b';
      h.window.ApiClient.getCurrentUserId = () => user;
      h.JE.session?.checkNow?.('switch while the answer was lost');
      throw new TypeError('connection lost');
    }
  } });
  await h.JE.updateSettings({ autoResumeEnabled: true });
  await settle(12);
  assert.ok(!h.toasts.some(x => x.message === en.settings_save_confirmed || x.message === en.settings_save_unconfirmed_read));
  assert.ok(!h.toasts.some(x => x.message === en.settings_not_saved));
  assert.equal(readsAsB, 0);
});
