import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, jsonResponse } from '../helpers/harness.mjs';
import { tab, settingsServer, en } from '../helpers/settings-tabs.mjs';

// Stage 1 fix round 12: an action belongs to the session it was started in, from the person's gesture on, through every
// wait it makes before its write (RBS1-R12-2). The round-11 send check compared the session the write was bound to with
// the signed-in one, but the binding itself was taken after the action's own preparation: Hide entire show awaited the
// series metadata and then bound its save to whoever was signed in by then; a Catch Up swipe awaited the seasons, then
// built B's PlayedItems URL and activity event; a Spoiler Guard choice made while its initial read was out was saved as B.

function loadCore(h) {
  for (const path of ['core/navigation.js', 'core/session.js', 'core/mutation-queue.js', 'core/api-client.js']) h.load(path);
}

test('R12-2: Hide entire show must keep the session from the confirmation before its metadata wait', async t => {
  const s = settingsServer({ Settings: {}, Shortcuts: { Shortcuts: [] }, Bookmark: { Bookmarks: {} }, Elsewhere: { Region: 'US' }, HiddenContent: { Items: {}, Settings: { ShowButtonLibrary: true } } });
  const h = await tab(t, s, { html: '<div class="card" data-id="ep"><div class="cardBox"></div></div>' });
  let user = 'user-a';
  const writes = [];
  h.window.ApiClient.getCurrentUserId = () => user;
  const ajax = h.window.ApiClient.ajax;
  h.window.ApiClient.ajax = req => { if (req.type === 'PATCH') writes.push({ user, url: req.url, body: JSON.parse(req.data) }); return ajax(req); };
  const held = deferred();
  h.window.ApiClient.getItem = async (owner, id) => id === 'ep' ? { Id: 'ep', Type: 'Episode', Name: 'Episode', SeriesId: 'show', SeriesName: 'Show' } : held.promise;
  for (const file of ['enhanced/hiddencontent/hidden-content-data.js', 'enhanced/hiddencontent/hidden-content-save.js', 'enhanced/hiddencontent/hidden-content-dialogs.js']) h.load(file);
  const hc = h.JE.internals.hiddenContent;
  hc.refreshNativeCardVisibility = () => {};
  hc.restoreNativeCardsForIds = () => {};
  hc.getCardSurface = () => 'continuewatching';
  hc.getCardItemId = () => 'ep';
  h.load('enhanced/hiddencontent/hidden-content-buttons.js');
  hc.addLibraryHideButtons();
  h.document.querySelector('.je-hide-btn').click();
  await new Promise(r => setImmediate(r));
  const choices = h.document.querySelectorAll('.je-hide-confirm-hide');
  assert.equal(choices.length, 3);
  choices[2].click(); // A confirms Hide entire show; the series metadata read now waits.
  user = 'user-b';
  h.JE.session.checkNow('account switch');
  await h.JE.readUserSettings('hidden-content.json');
  held.resolve({ Id: 'show', ProviderIds: { Tmdb: '42' } });
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(writes, [], "A's confirmed hide must be cancelled after the switch, not bound afresh to B");
});

test('R12-2: a Spoiler Guard control waiting for its initial read must not save as the next person', async t => {
  let user = 'a', releaseA, reachedA;
  const aHeld = new Promise(r => { releaseA = r; });
  const aReached = new Promise(r => { reachedA = r; });
  const writes = [];
  const h = createHarness({
    html: '<input type="checkbox" id="sbPrefHideCast" data-pref="HideCast">',
    JE: { pluginConfig: { SpoilerBlurEnabled: true }, t: key => en[key] ?? key, toast() {} },
    apiClient: { getCurrentUserId: () => user, accessToken: () => 'fixture-' + user },
    fetch: async (url, init) => {
      if (String(url).endsWith('/spoiler-blur/series')) {
        if (init.headers['X-Jellyfin-User-Id'] === 'a') { reachedA(); await aHeld; }
        return jsonResponse({ Prefs: { HideCast: null } });
      }
      writes.push({ user: init.headers['X-Jellyfin-User-Id'], body: JSON.parse(init.body) });
      return jsonResponse({ prefs: { HideCast: false } });
    }
  });
  t.after(() => h.close());
  loadCore(h);
  h.load('enhanced/spoilerguard/state.js');
  h.load('enhanced/spoilerguard/settings-tab.js');
  const sg = h.JE.internals.spoilerGuard;
  sg.wireSettings({ help: h.document.body, resetAutoCloseTimer() {} });
  await aReached;
  const box = h.document.getElementById('sbPrefHideCast');
  box.checked = false;
  box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  user = 'b';
  h.JE.session.checkNow('switch while old control awaits its read');
  await sg.whenLoaded();
  releaseA();
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(writes, [], 'the choice was made by a, before the initial read; it cannot be rebound to b');
});

test('R12-2: a Catch Up swipe waiting for season lookup must not be rebound to another account', async t => {
  let user = 'a', release, arrived;
  const held = new Promise(r => { release = r; });
  const reached = new Promise(r => { arrived = r; });
  const writes = [];
  let refills = 0;
  const h = createHarness({
    html: '<div id="root"><div id="main"></div></div>',
    JE: { pluginConfig: { CatchUpEnabled: true }, t: key => key, toast() {} },
    apiClient: { getCurrentUserId: () => user, accessToken: () => 'fixture-' + user },
    fetch: async (url, init) => {
      if (init.method !== 'GET') { writes.push({ url: String(url), user: init.headers['X-Jellyfin-User-Id'] }); return jsonResponse({}); }
      if (String(url).includes('/Shows/')) { arrived(); await held; return jsonResponse({ Items: [{ Id: 'season-a', IndexNumber: 1 }] }); }
      return jsonResponse({ Items: refills++ === 0 ? [{ Id: 'series-a', Type: 'Series', Name: 'A series', ImageTags: { Primary: 'image' } }] : [] });
    }
  });
  t.after(() => h.close());
  loadCore(h);
  h.window.localStorage.setItem('je-catchup-mode', 'Series');
  h.load('enhanced/catchup/catchup-core.js');
  h.load('enhanced/catchup/catchup-deck.js');
  const deck = h.JE.internals.catchUp.deck.mount(h.document.getElementById('root'), h.document.getElementById('main'));
  await deck.start();
  h.document.querySelector('.je-catchup-buttons .r').click();
  await reached;
  user = 'b';
  h.JE.session.checkNow('switch during season lookup');
  release();
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(writes, [], 'a swipe made as a cannot mark watched or log activity as b');
});

// P10 variant: the "skip the disable confirmation" choice (a plain true/false, not an override) made while the initial
// read is out is A's too, never saved as B. On the base the write is masked (the tab's first sync rewrites the control
// from B's stored preferences just before A's save reads it, so the save carries B's own value and sends nothing), but A's
// save still goes on as B: the save call made after the switch is what this checks too.
test('a Spoiler Guard "skip the confirmation" choice made before its initial read is never saved as the next person', async t => {
  let user = 'a', releaseA, reachedA;
  const aHeld = new Promise(r => { releaseA = r; });
  const aReached = new Promise(r => { reachedA = r; });
  const writes = [];
  const h = createHarness({
    html: '<input type="checkbox" id="sbPrefSkipDisableConfirm" data-pref="SkipDisableConfirm">',
    JE: { pluginConfig: { SpoilerBlurEnabled: true }, t: key => en[key] ?? key, toast() {} },
    apiClient: { getCurrentUserId: () => user, accessToken: () => 'fixture-' + user },
    fetch: async (url, init) => {
      if (String(url).endsWith('/spoiler-blur/series')) {
        if (init.headers['X-Jellyfin-User-Id'] === 'a') { reachedA(); await aHeld; }
        return jsonResponse({ Prefs: { SkipDisableConfirm: false } });
      }
      writes.push({ user: init.headers['X-Jellyfin-User-Id'], body: JSON.parse(init.body) });
      return jsonResponse({ prefs: { SkipDisableConfirm: true } });
    }
  });
  t.after(() => h.close());
  loadCore(h);
  h.load('enhanced/spoilerguard/state.js');
  h.load('enhanced/spoilerguard/settings-tab.js');
  const sg = h.JE.internals.spoilerGuard;
  const saves = [];
  const setUserPrefs = sg.setUserPrefs;
  sg.setUserPrefs = (next, owner, origin) => { saves.push({ user, origin: origin ? origin.userId : null }); return setUserPrefs(next, owner, origin); };
  sg.wireSettings({ help: h.document.body, resetAutoCloseTimer() {} });
  await aReached;
  const box = h.document.getElementById('sbPrefSkipDisableConfirm');
  box.checked = true;
  box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  user = 'b';
  h.JE.session.checkNow('switch while the old control awaits its read');
  await sg.whenLoaded();
  releaseA();
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(writes, [], 'the choice was made by a, before the initial read; it cannot be rebound to b');
  assert.deepEqual(saves.filter(x => x.origin !== 'a'), [], "A's save never goes on as anyone else");
  // A's old panel is revoked. B acts on a fresh settings view, with a trusted change of its own.
  const fresh = box.cloneNode(true); box.replaceWith(fresh);
  sg.wireSettings({ help: h.document.body, resetAutoCloseTimer() {} });
  fresh.checked = true;
  h.trusted(fresh, new h.window.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(writes.map(w => w.user), ['b']);
});
