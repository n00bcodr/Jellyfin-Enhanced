import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

// hidden-content.json is saved whole. These tests drive the real data, save, dialog and filter
// modules against a fake server that keeps the stored list, so what a save writes is observable.

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

  h.hc.hideItem(item('new'));
  h.hc.updateSettings({ filterLibrary: false });
  h.hc.unhideAll();
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
  h.hc.hideItem(item('b'));
  await h.timers.advance(30000);
  assert.deepEqual(h.api.stored, list('a'));
  assert.equal(h.api.posts().length, 0);
});
