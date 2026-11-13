import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../../helpers/harness.mjs';

// hidden-content.json is saved whole. These tests drive the real data, save, dialog and filter
// modules against a fake server that keeps the stored list, so what a save writes is observable.
// Upstream's tests/frontend/features/features-hidden-save.test.mjs (n00bcodr/Jellyfin-Enhanced 7649dda9), run against
// this tree's built modules. Differences, each marked where it is: an edit refused because the list is not loaded
// throws here (after the same message), where upstream's returns false; and an unhide removes every entry stored for
// the same item ID (this tree keeps one entry per item: `GUID unhide removes equivalent storage aliases` in
// features-hidden-rewrite.test.mjs), so upstream's two tests that keep a second entry for the same item are not here.

/** Manual clock for the debounce and retry timers. */
function clock() {
  let now = 0, next = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms = 0) => { const id = ++next; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: id => { timers.delete(id); },
    /** Runs every timer due within `ms`, letting the requests each one starts settle. */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await settle();
        const [id, timer] = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0] || [];
        if (!timer) break;
        timers.delete(id); now = timer.at; timer.fn();
      }
      now = end;
      await settle();
    }
  };
}
async function settle() { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); }

/**
 * The plugin's hidden-content routes over one stored list. `failGets`/`failPosts` count down failures.
 */
function server(initial) {
  const state = { stored: plain(initial), requests: [], failGets: 0, failPosts: 0 };
  state.ajax = async request => {
    const url = new URL(request.url);
    state.requests.push({ type: request.type, path: url.pathname, data: request.data });
    if (url.pathname === '/JellyfinEnhanced/user-settings/user-a/hidden-content.json') {
      if (request.type === 'GET') {
        if (state.failGets > 0) { state.failGets--; throw Object.assign(new Error('read failed'), { status: 500 }); }
        return plain(state.stored);
      }
      if (state.failPosts > 0) { state.failPosts--; throw Object.assign(new Error('write failed'), { status: 500 }); }
      state.stored = JSON.parse(request.data);
      return { success: true };
    }
    throw new Error(`Unexpected request ${request.type} ${url.pathname}`);
  };
  state.posts = () => state.requests.filter(r => r.type === 'POST');
  return state;
}

/** Real hidden-content modules with the given boot-time list (null = it failed to load). */
export function setup(t, { loadedList = { items: {}, settings: {} }, stored = loadedList ?? { items: {}, settings: {} }, html = '' } = {}) {
  const timers = clock(), api = server(stored), toasts = [];
  let epoch = 0; const handlers = new Map();
  const h = createHarness({ html, apiClient: { ajax: request => api.ajax(request) },
    globals: { requestAnimationFrame: fn => fn(), setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout },
    JE: { userConfig: { hiddenContent: loadedList && plain(loadedList) }, t: key => key, toast: message => toasts.push(message),
      session: { getEpoch: () => epoch, isCurrent: e => e === epoch, onUserChange: (key, fn) => handlers.set(key, fn), userScopedKey: key => `${key}:user-a` } } });
  t.after(() => h.close());
  // Every confirmation is skipped, as after "Don't ask again for 15 minutes".
  h.window.localStorage.setItem('je_hide_confirm_suppressed_until:user-a', new Date(Date.now() + 3600000).toISOString());
  for (const name of ['data', 'save', 'dialogs', 'filter']) h.load(`enhanced/hiddencontent/hidden-content-${name}.js`);
  const hc = h.JE.internals.hiddenContent;
  hc.resetFromUserConfig();
  return { ...h, hc, api, timers, toasts,
    switchUser() { epoch++; h.JE.userConfig = { hiddenContent: { items: {}, settings: {} } }; for (const fn of handlers.values()) fn({ userId: 'next' }); } };
}

const item = id => ({ itemId: id, name: `Title ${id}`, type: 'Movie', hideScope: 'global' });
const list = (...ids) => ({ items: Object.fromEntries(ids.map(id => [id, item(id)])), settings: { filterSearch: true } });

test('a hidden list that failed to load is not saved over the stored one', async t => {
  const h = setup(t, { loadedList: null, stored: list('a', 'b', 'c') });
  assert.equal(h.hc.getHiddenCount(), 0, 'nothing shows as hidden');

  // This tree's edits throw when refused (upstream's return false); the message is the same.
  assert.throws(() => h.hc.hideItem(item('new')), /unavailable/);
  assert.throws(() => h.hc.updateSettings({ filterLibrary: false }), /unavailable/);
  assert.throws(() => h.hc.unhideAll(), /unavailable/);
  let hidden = false;
  h.hc.confirmAndHide(item('other'), () => { hidden = true; });
  await h.timers.advance(30000);

  assert.deepEqual(h.api.stored, list('a', 'b', 'c'));
  assert.equal(h.api.posts().length, 0);
  assert.equal(hidden, false);
  assert.equal(h.document.querySelector('.je-hide-confirm-overlay'), null, 'nothing is asked');
  assert.equal(h.hc.getHiddenCount(), 0);
  assert.ok(h.toasts.length >= 1 && h.toasts.every(message => message === 'hidden_content_not_loaded'), h.toasts.join());
});

for (const loaded of [false, true]) test(`a settings panel switch ${loaded ? 'saves its change' : 'goes back when the change is refused'} (${loaded ? 'list loaded' : 'list not loaded'})`, async t => {
  const switches = { hiddenContentEnabledToggle: true, hiddenShowHideButtons: true, hiddenShowButtonLibrary: false, hiddenFilterSearch: false, hiddenShowConfirmation: true, hiddenExperimentalCollections: false };
  const html = Object.entries(switches).map(([id, on]) => `<input type="checkbox" id="${id}"${on ? ' checked' : ''}>`).join('');
  const h = setup(t, { loadedList: loaded ? list('a') : null, stored: list('a'), html });
  const calls = [];
  h.JE.hiddenContent = { updateSettings: h.hc.updateSettings, getSettings: h.hc.getSettings,
    addLibraryHideButtons: () => calls.push('add'), removeLibraryHideButtons: () => calls.push('remove') };
  h.window.localStorage.setItem('je_hide_confirm_suppressed_until', 'later');
  h.load('enhanced/settingspanel/ui-panel-hidden-content.js');
  h.JE.internals.enhancedUi.wireHiddenContentListeners({ resetAutoCloseTimer() {}, closePanel() {} });

  for (const id of Object.keys(switches)) h.document.getElementById(id).click();
  await h.timers.advance(1000);

  for (const [id, on] of Object.entries(switches)) assert.equal(h.document.getElementById(id).checked, loaded ? !on : on, id);
  if (loaded) {
    assert.equal(h.api.stored.settings.filterSearch, true);
    assert.equal(h.api.stored.settings.enabled, false);
  } else {
    assert.deepEqual(h.api.stored, list('a'));
    assert.deepEqual(calls, [], 'no hide buttons added or removed');
    assert.equal(h.window.localStorage.getItem('je_hide_confirm_suppressed_until'), 'later');
    assert.ok(h.toasts.length >= 1 && h.toasts.every(message => message === 'hidden_content_not_loaded'), h.toasts.join());
  }
});

test('a list that loads later becomes writable', async t => {
  const h = setup(t, { loadedList: null, stored: list('a') });
  assert.equal(await h.hc.refresh(), true);
  h.hc.hideItem(item('b'));
  await h.timers.advance(1000);
  assert.deepEqual(Object.keys(h.api.stored.items).sort(), ['a', 'b']);
});

test('a loaded list, empty or not, is writable', async t => {
  for (const loadedList of [{ items: {}, settings: {} }, list('a')]) {
    const h = setup(t, { loadedList });
    h.hc.hideItem(item('b'));
    await h.timers.advance(1000);
    assert.equal(h.api.posts().length, 1);
    assert.ok(h.api.stored.items.b);
    assert.equal(h.toasts.length, 0);
  }
});

test('between a user switch and the incoming list loading, nothing is saved', async t => {
  const h = setup(t, { loadedList: list('a') });
  h.switchUser();
  assert.throws(() => h.hc.hideItem(item('b')), /unavailable/); // upstream's returns false
  await h.timers.advance(30000);
  assert.deepEqual(h.api.stored, list('a'));
  assert.equal(h.api.posts().length, 0);
});

// Every save writes the whole list. It must carry only this session's changes onto the list as stored now:
// other devices, an administrator and the server itself write the same file while a tab stays open.
const keys = doc => Object.keys(doc.items).sort();

test('a hide on another device is kept when this tab saves', async t => {
  const h = setup(t, { loadedList: list('a') });
  h.api.stored.items.b = item('b'); // the phone, after this tab loaded
  h.hc.hideItem(item('c'));
  await h.timers.advance(1000);
  assert.deepEqual(keys(h.api.stored), ['a', 'b', 'c']);
  assert.equal(h.hc.isHidden('b'), true, 'the tab now shows what the save read');
});

test('an unhide on another device is not undone when this tab saves', async t => {
  const h = setup(t, { loadedList: list('a', 'b') });
  delete h.api.stored.items.b;
  h.hc.hideItem(item('c'));
  await h.timers.advance(1000);
  assert.deepEqual(keys(h.api.stored), ['a', 'c']);
  assert.equal(h.hc.isHidden('b'), false);
});

test("an administrator's hides and unhides for the user survive the user's next change", async t => {
  const h = setup(t, { loadedList: list('a', 'b') });
  // "Add items" and "Unhide" for this user from the administrator's Hidden Content page (server read-modify-write).
  h.api.stored.items.admin = { ...item('admin'), hiddenAt: '2026-01-01T00:00:00.000Z' };
  delete h.api.stored.items.a;
  h.hc.updateSettings({ filterLibrary: false });
  await h.timers.advance(1000);
  assert.deepEqual(keys(h.api.stored), ['admin', 'b']);
  assert.equal(h.api.stored.settings.filterLibrary, false);
  assert.equal(h.api.stored.settings.filterSearch, true);
});

test('a setting changed elsewhere is kept; this tab writes only the settings it changed', async t => {
  const h = setup(t, { loadedList: list('a') });
  h.api.stored.settings.filterCalendar = false;
  h.hc.updateSettings({ filterSearch: false });
  await h.timers.advance(1000);
  assert.deepEqual(h.api.stored.settings, { filterSearch: false, filterCalendar: false });
});

test('unhiding an item this tab knew removes it; items added elsewhere stay', async t => {
  const h = setup(t, { loadedList: list('a', 'b') });
  h.api.stored.items.c = item('c');
  h.hc.unhideItem('a');
  await h.timers.advance(1000);
  assert.deepEqual(keys(h.api.stored), ['b', 'c']);
  h.hc.unhideAll();
  await h.timers.advance(1000);
  assert.deepEqual(keys(h.api.stored), [], 'Unhide All clears what the tab shows, which now includes c');
});

/** Answers the next request of this type (the read as of now, or the write) only when released. */
function holdNext(h, type = 'GET') {
  let answer, deliver;
  const ajax = h.api.ajax;
  h.api.ajax = request => {
    if (request.type !== type || answer) return ajax(request);
    answer = ajax(request);
    return new Promise(resolve => { deliver = resolve; });
  };
  return () => deliver(answer);
}

for (const step of ['GET', 'POST']) test(`a change made while a save's ${step === 'GET' ? 'read' : 'write'} is in flight is kept and saved`, async t => {
  const h = setup(t, { loadedList: list('a') });
  const release = holdNext(h, step);
  h.hc.hideItem(item('b'));
  await h.timers.advance(500); // the save has started
  h.hc.hideItem(item('c'));
  release();
  await h.timers.advance(2000);
  assert.deepEqual(keys(h.api.stored), ['a', 'b', 'c']);
  for (const id of ['a', 'b', 'c']) assert.equal(h.hc.isHidden(id), true, id);
});

test('a save whose read fails writes nothing and retries onto the list stored then', async t => {
  const h = setup(t, { loadedList: list('a') });
  h.api.failGets = 1;
  h.hc.hideItem(item('b'));
  await h.timers.advance(600);
  assert.equal(h.api.posts().length, 0);
  h.api.stored.items.c = item('c');
  await h.timers.advance(2000);
  assert.deepEqual(keys(h.api.stored), ['a', 'b', 'c']);
});

test('a change undone before it is saved writes nothing', async t => {
  const h = setup(t, { loadedList: list('a') });
  h.hc.hideItem(item('b'));
  h.hc.unhideItem('b');
  await h.timers.advance(1000);
  assert.equal(h.api.posts().length, 0);
  assert.deepEqual(h.api.stored, list('a'));
});

/** Continue Watching removal through the real remove-home module and the server's scoped write. */
function withContinueWatching(h) {
  h.load('enhanced/homeremoval/features-remove-home.js');
  h.JE.hiddenContent = { flushPendingSave: h.hc.flushPendingSave, markScopedHidden: h.hc.markScopedHidden };
  const ajax = h.api.ajax;
  h.api.ajax = async request => {
    const match = /\/JellyfinEnhanced\/continue-watching\/hide\/(\w+)$/.exec(new URL(request.url).pathname);
    if (!match) return ajax(request);
    h.api.requests.push({ type: request.type, path: match[0] });
    // As the server does: a read-modify-write that stores the entry under the dashed id.
    const n = match[1], dashed = `${n.slice(0, 8)}-${n.slice(8, 12)}-${n.slice(12, 16)}-${n.slice(16, 20)}-${n.slice(20)}`;
    h.api.stored.items[dashed] = { itemId: dashed, name: 'Episode', type: 'Episode', hideScope: 'continuewatching', hiddenAt: '2026-11-13T00:00:00.0000000Z' };
    return { success: true };
  };
  return h.JE.internals.features.removeFromHomeSurface;
}
const episode = '0123456789abcdef0123456789abcdef', episodeDashed = '01234567-89ab-cdef-0123-456789abcdef';

test('a Continue Watching hide the server dropped on playback is not written back by the next save', async t => {
  const h = setup(t, { loadedList: list('a') });
  const remove = withContinueWatching(h);
  assert.equal(await remove(episode, 'continuewatching'), true);
  assert.equal(h.hc.isHiddenOnSurface(episode, 'continuewatching'), true);
  delete h.api.stored.items[episodeDashed]; // the user resumed it: the playback consumer dropped the hide
  h.hc.hideItem(item('b'));
  await h.timers.advance(1000);
  assert.deepEqual(keys(h.api.stored), ['a', 'b']);
  assert.equal(h.hc.isHiddenOnSurface(episode, 'continuewatching'), false, 'the tab shows it in Continue Watching again');
});

test('adding back to Continue Watching right after removing it sticks', async t => {
  const h = setup(t, { loadedList: list('a') });
  const remove = withContinueWatching(h);
  assert.equal(await remove(episode, 'continuewatching'), true);
  h.hc.unhideItem(episode);
  await h.timers.advance(1000);
  assert.deepEqual(keys(h.api.stored), ['a']);
});

test('a save in flight when Continue Watching removal starts finishes first and keeps the entry', async t => {
  const h = setup(t, { loadedList: list('a') });
  const remove = withContinueWatching(h);
  const release = holdNext(h);
  h.hc.hideItem(item('b'));
  await h.timers.advance(500);
  const removed = remove(episode, 'continuewatching');
  await h.timers.advance(0);
  release();
  assert.equal(await removed, true);
  await h.timers.advance(2000);
  assert.deepEqual(keys(h.api.stored), [episodeDashed, 'a', 'b']);
});

for (const step of ['GET', 'POST']) test(`a save whose ${step === 'GET' ? 'read' : 'write'} never gets an answer gives up, so later saves and Continue Watching removal go ahead`, async t => {
  const h = setup(t, { loadedList: list('a') });
  const alerts = [];
  // Set before remove-home loads: this tree's module reads Dashboard when it loads.
  h.window.Dashboard = { alert: message => alerts.push(message) };
  const remove = withContinueWatching(h);
  holdNext(h, step); // never released
  h.hc.hideItem(item('b'));
  await h.timers.advance(500); // the save has started
  let removed = 'waiting';
  remove(episode, 'continuewatching').then(result => { removed = result; });
  await h.timers.advance(29000);
  assert.equal(removed, 'waiting', 'a removal waits for the save in flight');
  await h.timers.advance(1000); // 30 seconds without an answer
  assert.equal(removed, false, 'the removal is refused: that save may still land');
  assert.deepEqual(alerts, ['remove_continue_watching_error_api']);

  await h.timers.advance(1000); // the save's retry
  assert.deepEqual(keys(h.api.stored), ['a', 'b']);
  h.hc.hideItem(item('c'));
  await h.timers.advance(1000);
  assert.deepEqual(keys(h.api.stored), ['a', 'b', 'c']);
  assert.equal(await remove(episode, 'continuewatching'), true);
  assert.deepEqual(keys(h.api.stored), [episodeDashed, 'a', 'b', 'c']);
  assert.deepEqual(h.toasts, []);
});

test('a row-only hide made here does not replace a global hide another device stored for the same title', async t => {
  const h = setup(t, { loadedList: list('a') });
  h.api.stored.items[episodeDashed] = { ...item(episodeDashed), hideScope: 'global' };
  h.hc.hideItem({ ...item(episode), hideScope: 'nextup' });
  await h.timers.advance(1000);
  assert.deepEqual(keys(h.api.stored), [episodeDashed, episode, 'a']);
  assert.equal(h.api.stored.items[episodeDashed].hideScope, 'global');
});

// Upstream's two tests here ("removing the Continue Watching entry keeps the separate hide of the same item" and the
// reverse) are not ported: this tree's unhide removes every entry stored for one item ID (see the header).

test('unhiding one entry leaves a separate TMDB entry for the same title alone', async t => {
  const h = setup(t, { loadedList: { items: { abc: item('abc'), 'tmdb-42': { ...item(''), tmdbId: '42', name: 'Seerr hide' } }, settings: {} } });
  h.hc.unhideItem('abc');
  await h.timers.advance(1000);
  assert.deepEqual(keys(h.api.stored), ['tmdb-42']);
});

// jellyfin-web dispatches a bubbling legacy `pagehide` on each view it leaves; only the page's own pagehide
// (not persisted in the back/forward cache) means the retry can never run.
for (const [label, hide, retried] of [
  ['a view jellyfin-web leaves', h => h.document.querySelector('#view').dispatchEvent(new h.window.CustomEvent('pagehide', { bubbles: true })), true],
  ['a back/forward cache hide', h => h.window.dispatchEvent(new h.window.PageTransitionEvent('pagehide', { persisted: true })), true],
  ['the page being unloaded', h => h.window.dispatchEvent(new h.window.PageTransitionEvent('pagehide', { persisted: false })), false],
]) test(`a save waiting to retry is ${retried ? 'still retried after' : 'dropped on'} the pagehide of ${label}`, async t => {
  const h = setup(t, { loadedList: list('a'), html: '<div id="view" class="page"></div>' });
  h.api.failPosts = 1;
  h.hc.hideItem(item('b'));
  await h.timers.advance(600);
  assert.equal(h.api.posts().length, 1, 'the first attempt failed');
  hide(h);
  await h.timers.advance(2000);
  assert.deepEqual(keys(h.api.stored), retried ? ['a', 'b'] : ['a']);
});

// Seerr cards used to pass the title HTML-escaped, and it was stored that way.
test('a name stored HTML-escaped reads as its title, and is not rewritten by other changes', async t => {
  const escaped = { itemId: '', tmdbId: '7', name: 'Tom &amp; Jerry&#039;s &lt;Show&gt; &quot;Live&quot; &amp;amp;', type: 'Series', hideScope: 'global' };
  const h = setup(t, { loadedList: { items: { 'tmdb-7': escaped }, settings: {} } });
  assert.equal(h.hc.getAllHiddenItems()[0].name, 'Tom & Jerry\'s <Show> "Live" &amp;');
  assert.equal(h.hc.filterCalendarEvents([{ title: 'Tom & Jerry\'s <Show> "Live" &amp;' }]).length, 0, 'the calendar matches the title');

  h.hc.hideItem(item('b'));
  await h.timers.advance(5000);
  assert.equal(h.api.stored.items['tmdb-7'].name, escaped.name, 'the stored text is left as it is');
  assert.equal(h.api.requests.filter(r => r.type === 'GET').length, 1, 'one save, no repeat');
  assert.equal(h.hc.getAllHiddenItems().find(i => i._key === 'tmdb-7').name, 'Tom & Jerry\'s <Show> "Live" &amp;');
});

// A change not saved yet (the save waits 500 ms) stays when the list is read again before it is saved.
test('a refresh keeps a change this tab has not saved yet', async t => {
  const h = setup(t, { loadedList: list('a') });
  h.api.stored.items.c = item('c'); // another device, after this tab loaded
  h.hc.hideItem(item('b'));
  assert.equal(await h.hc.refresh(), true);
  assert.equal(h.hc.isHidden('b'), true, 'the hide still shows');
  assert.equal(h.hc.isHidden('c'), true, 'and so does what the refresh read');
  await h.timers.advance(1000);
  assert.deepEqual(keys(h.api.stored), ['a', 'b', 'c']);
});
