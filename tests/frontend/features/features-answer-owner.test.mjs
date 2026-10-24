import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';
import { tab, settingsServer, route } from '../helpers/settings-tabs.mjs';

// Stage 1 fix round 12: an answer takes effect only in the document and session of the action it answers (RBS1-R12-3).
// A's home-row hide was sent before the account switch, correctly as A; its late answer then hid B's card and acknowledged
// A's change into B's store (looked up by file name), installing A's revision in B's document, so B's own fresh read was
// rejected as older. B's server document was never changed.

test('R12-3: a home-row removal answered after switching must not acknowledge A\'s document into B\'s store', async t => {
  const docs = () => ({ Settings: {}, Shortcuts: { Shortcuts: [] }, Bookmark: { Bookmarks: {} }, Elsewhere: { Region: 'US' }, HiddenContent: { Items: {}, Settings: {} } });
  const a = settingsServer(docs()), b = settingsServer(docs());
  a.counters['hidden-content.json'] = 9;
  let user = 'user-a', started = false;
  const held = deferred();
  const h = await tab(t, a, { ajax: request => {
    if (request.type === 'POST' && request.url.includes('/continue-watching/hide/')) {
      assert.equal(user, 'user-a');
      a.apply('hidden-content.json', 'PATCH', { Upsert: { movie: { ItemId: 'movie', HideScope: 'continuewatching' } } });
      const revision = a.revision('hidden-content.json');
      started = true;
      return held.promise.then(() => ({ success: true, revision }));
    }
    if (request.type === 'GET' && request.url.includes('/user-settings/')) return route(user === 'user-a' ? a : b, { ...request, url: request.url.replace('/user-b/', '/user-a/') });
  } });
  h.window.ApiClient.getCurrentUserId = () => user;
  for (const f of ['enhanced/hiddencontent/hidden-content-data.js', 'enhanced/hiddencontent/hidden-content-save.js', 'enhanced/homeremoval/features-remove-home.js']) h.load(f);
  const hc = h.JE.internals.hiddenContent;
  hc.refreshNativeCardVisibility = () => {};
  hc.restoreNativeCardsForIds = () => {};
  h.JE.hiddenContent = { markScopedHidden: hc.markScopedHidden };
  const pending = h.JE.internals.features.removeFromHomeSurface('movie', 'continuewatching');
  for (let n = 0; n < 100 && !started; n++) await new Promise(r => setTimeout(r, 1));
  assert.ok(started, 'A\'s request was transmitted before the switch');
  user = 'user-b'; h.JE.session.checkNow('account switch');
  await h.JE.readUserSettings('hidden-content.json');
  assert.deepEqual(Object.keys(h.JE.internals.userDocument('hidden-content.json').document.items), []);
  held.resolve(); await pending;
  assert.deepEqual(Object.keys(b.documents.HiddenContent.Items), [], 'B\'s server document is empty');
  assert.deepEqual(Object.keys(h.JE.internals.userDocument('hidden-content.json').document.items), [], 'A\'s delayed acknowledgement must not hide a title for B');
});

test('R12-3: a successful home-removal answer for the previous account cannot enter the next account document', async t => {
  let user = 'a', release, reached;
  const held = new Promise(r => { release = r; });
  const arrived = new Promise(r => { reached = r; });
  const h = createHarness({
    JE: { pluginConfig: {}, userConfig: { hiddenContent: { items: {}, settings: {} } }, t: key => key, toast() {} },
    apiClient: { getCurrentUserId: () => user, ajax: async req => {
      if (req.type === 'POST') { reached(); await held; return { success: true, revision: '000000000001.1' }; }
      return { document: { items: {}, settings: {} }, revision: '000000000001.0' };
    } }
  });
  t.after(() => h.close());
  for (const path of ['core/navigation.js', 'core/session.js', 'core/mutation-queue.js', 'enhanced/config.js', 'enhanced/hiddencontent/hidden-content-data.js', 'enhanced/homeremoval/features-remove-home.js']) h.load(path);
  h.JE.hiddenContent = { markScopedHidden: h.JE.internals.hiddenContent.markScopedHidden };
  const result = h.JE.internals.features.removeFromHomeSurface('movie-a', 'continuewatching');
  await arrived;
  user = 'b';
  h.JE.session.checkNow('switch after a request was sent');
  h.JE.userConfig = { hiddenContent: { items: {}, settings: {} } };
  assert.deepEqual(Object.keys(h.JE.internals.userDocument('hidden-content.json').document.items), []);
  release();
  await result;
  await h.JE.readUserSettings('hidden-content.json');
  assert.deepEqual(Object.keys(h.JE.internals.userDocument('hidden-content.json').document.items), [], "b never removed this movie; even a fresh read must not be rejected using a different person's revision");
});

// Each layer of the answer guard on its own (stage 1 fix round 12): the next person's page keeps the card A's late answer
// named, and a document handle taken in A's session acknowledges nothing once that session ended.
function homeRemoval(t) {
  let user = 'a', release, reached;
  const held = new Promise(r => { release = r; });
  const arrived = new Promise(r => { reached = r; });
  const h = createHarness({
    html: '<div class="card" data-id="movie-a"></div>',
    JE: { pluginConfig: {}, userConfig: { hiddenContent: { items: {}, settings: {} } }, t: key => key, toast() {} },
    apiClient: { getCurrentUserId: () => user, ajax: async req => {
      if (req.type === 'POST') { reached(); await held; return { success: true, revision: '000000000001.1' }; }
      return { document: { items: {}, settings: {} }, revision: '000000000001.0' };
    } }
  });
  t.after(() => h.close());
  for (const path of ['core/navigation.js', 'core/session.js', 'core/mutation-queue.js', 'enhanced/config.js', 'enhanced/hiddencontent/hidden-content-data.js', 'enhanced/homeremoval/features-remove-home.js']) h.load(path);
  h.JE.hiddenContent = { markScopedHidden: h.JE.internals.hiddenContent.markScopedHidden };
  return { h, arrived, release, switchTo(next) { user = next; h.JE.session.checkNow('account switch'); } };
}

test('a home-row answer after the switch leaves the card on the next person\'s page', async t => {
  const r = homeRemoval(t);
  const card = r.h.document.querySelector('.card');
  const result = r.h.JE.internals.features.removeFromHomeSurface('movie-a', 'continuewatching', card);
  await r.arrived;
  r.switchTo('b');
  r.release();
  await result;
  assert.notEqual(card.style.display, 'none', "B's page still shows the card");
});

test('control: a home-row answer in its own session hides the card', async t => {
  const r = homeRemoval(t);
  const card = r.h.document.querySelector('.card');
  const result = r.h.JE.internals.features.removeFromHomeSurface('movie-a', 'continuewatching', card);
  await r.arrived;
  r.release();
  await result;
  assert.equal(card.style.display, 'none');
});

test('a document handle taken in A\'s session acknowledges nothing once that session ended', async t => {
  const r = homeRemoval(t);
  await r.h.JE.readUserSettings('hidden-content.json');
  const handle = r.h.JE.internals.userDocumentHandle('hidden-content.json', r.h.JE.core.userWrite.origin());
  r.switchTo('b');
  await r.h.JE.readUserSettings('hidden-content.json');
  assert.equal(handle.acknowledge({ upsert: { 'movie-a': { itemId: 'movie-a', hideScope: 'continuewatching' } } }, '000000000001.1'), false);
  assert.deepEqual(Object.keys(r.h.JE.internals.userDocument('hidden-content.json').document.items), []);
  // Control: a handle of the signed-in session acknowledges.
  const own = r.h.JE.internals.userDocumentHandle('hidden-content.json', r.h.JE.core.userWrite.origin());
  assert.equal(own.acknowledge({ upsert: { 'movie-b': { itemId: 'movie-b', hideScope: 'continuewatching' } } }, '000000000001.1'), true);
});
