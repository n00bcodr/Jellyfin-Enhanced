import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';
import { tab, settingsServer, en } from '../helpers/settings-tabs.mjs';

// Stage 1 fix round 12: a write has three outcomes: stored (acknowledged, or confirmed by a read), refused or not sent
// (proven), and uncertain (RBS1-R12-5). A PATCH the server committed lost its answer and the page rolled the change back
// with "wasn't saved"; a Catch Up write committed, lost its answer, the account changed and only the retry was cancelled,
// yet the page said the change wasn't saved. Neither a lost answer nor a cancelled retry proves the first attempt didn't land.

function loadCore(h) {
  for (const path of ['core/navigation.js', 'core/session.js', 'core/mutation-queue.js', 'core/api-client.js']) h.load(path);
}

test('R12-5: a write already stored before a lost response must not be declared unsaved when its retry is cancelled', async t => {
  let user = 'a', stored = false;
  const notices = [];
  const h = createHarness({
    JE: { pluginConfig: { CatchUpEnabled: true }, t: key => en[key] ?? key, toast: msg => notices.push(msg) },
    apiClient: { getCurrentUserId: () => user, accessToken: () => 'fixture-' + user },
    fetch: async () => {
      stored = true;
      user = 'b';
      h.JE.session.checkNow('switch after write was committed');
      throw new TypeError('connection lost after commit');
    }
  });
  t.after(() => h.close());
  loadCore(h);
  h.JE.core.api.manager.CONFIG.retry.baseDelayMs = 1;
  h.JE.core.api.manager.CONFIG.retry.maxDelayMs = 2;
  h.load('enhanced/catchup/catchup-core.js');
  await assert.rejects(h.JE.internals.catchUp.ACTIONS.right.run({ Id: 'movie-a' }));
  assert.equal(stored, true);
  assert.ok(!notices.includes(en.settings_not_saved_account_changed), 'the server stored the write; only its retry was not sent');
});

test('R12-5: a settings PATCH committed before the answer is lost must not be declared definitely unsaved', async t => {
  const s = settingsServer({ Settings: { AutoResumeEnabled: false }, Shortcuts: { Shortcuts: [] }, Bookmark: { Bookmarks: {} }, Elsewhere: {}, HiddenContent: { Items: {}, Settings: {} } });
  const h = await tab(t, s, { ajax: request => {
    if (request.type === 'PATCH' && request.url.endsWith('/settings.json')) {
      s.apply('settings.json', 'PATCH', JSON.parse(request.data));
      throw new TypeError('connection lost after commit');
    }
  } });
  await assert.rejects(h.JE.updateSettings({ autoResumeEnabled: true }, { throwOnError: true }));
  assert.equal(s.documents.Settings.AutoResumeEnabled, true, 'the stored bytes contain the change');
  assert.ok(!h.toasts.some(x => x.message === en.settings_not_saved), 'a lost acknowledgement is not proof that it was not saved');
});
