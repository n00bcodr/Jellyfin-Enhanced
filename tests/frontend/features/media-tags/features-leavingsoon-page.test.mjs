import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../../helpers/harness.mjs';

// The Leaving soon page (upstream da0ea773, extras/leavingsoon-page.js): here client/src/features/media-tags/leaving-soon,
// shipped inside tags/tag-item-menu.js (the bundle's load order is pinned), after the item menu whose actions it reuses.

const DAY = 86400000;
const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32);

/** The Leaving soon page over the real UI kit, with the plugin's list route mocked. */
function setup(t, data, { enabled = true, fail = null, config = {} } = {}) {
  const calls = [];
  const h = createHarness({
    html: '<div id="host"></div>',
    JE: {
      pluginConfig: { LeavingSoonPageEnabled: enabled, LeavingSoonProvider: data.provider || 'reclaimerr', ToastDuration: 1500, ...config },
      t: (key, params) => params ? `${key}:${Object.values(params).join('|')}` : key,
      session: { onUserChange: () => {} },
    },
    apiClient: {
      getCurrentUser: async () => ({ Policy: { IsAdministrator: true } }),
      ajax: async ({ type, url, data: body }) => {
        const path = new URL(url).pathname.replace('/JellyfinEnhanced/', '');
        calls.push({ type, path, body: body ? JSON.parse(body) : null });
        if (path === 'leaving-soon/list') {
          if (fail) throw Object.assign(new Error('HTTP ' + fail), { status: fail });
          return data;
        }
        return { ok: true };
      },
    },
  });
  t.after(() => h.close());
  for (const file of ['enhanced/config.js', 'core/ui-kit.js', 'core/dom-observer.js', 'tags/tag-item-menu.js']) h.load(file);
  const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
  const $ = (sel) => h.document.querySelector(sel);
  const $$ = (sel) => Array.from(h.document.querySelectorAll(sel));
  const click = (el) => el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return { ...h, calls, settle, $, $$, click };
}

const list = (extra = {}) => ({
  provider: 'reclaimerr', admin: false, canRequest: true, actions: false, requests: [], mine: [],
  items: [
    { id: A, name: 'Jailer 2', type: 'Movie', year: 2026, deleteAt: Date.now() + 5 * DAY },
    { id: B, name: 'Sherlock', type: 'Series', year: 2010, deleteAt: Date.now() + DAY },
    { id: C, name: 'Old Show', detail: 'Season 1', type: 'Season', year: 2001, deleteAt: null },
  ],
  ...extra,
});

test('the page lists what is leaving with a days-left chip and filters movies and shows', async t => {
  const h = setup(t, list());
  assert.ok(h.JE.leavingSoonPage, 'the page registers itself');
  h.JE.leavingSoonPage.renderForCustomTab(h.$('#host'));
  await h.settle();
  assert.deepEqual(h.calls.map(c => c.path), ['leaving-soon/list']);
  assert.deepEqual(h.$$('.je-ls-name').map(e => e.textContent), ['Jailer 2', 'Sherlock', 'Old Show']);
  const chips = h.$$('.je-ls-chip').map(e => e.textContent);
  assert.equal(chips[0], 'leavingsoon_in_days:5');
  assert.equal(chips[1], 'leavingsoon_tomorrow');
  assert.equal(chips[2], 'leavingsoon_soon');
  assert.equal(h.$('.je-ls-count').textContent, '3 leavingsoon_items');
  assert.equal(h.$$('.je-ls-actions').length, 0, 'no admin actions for a user');

  const pill = (label) => h.$$('.je-ls-pill').find(b => b.textContent === label);
  h.click(pill('leavingsoon_movies'));
  assert.deepEqual(h.$$('.je-ls-name').map(e => e.textContent), ['Jailer 2']);
  h.click(pill('leavingsoon_shows'));
  assert.deepEqual(h.$$('.je-ls-name').map(e => e.textContent), ['Sherlock', 'Old Show']);
});

test('one version of a movie leaving says so, and item names are text, never markup', async t => {
  const h = setup(t, list({ items: [{ id: A, name: '<img src=x onerror=alert(1)>', type: 'Movie', year: 2026, deleteAt: Date.now() + 3 * DAY, versionOnly: true }] }));
  h.JE.leavingSoonPage.renderForCustomTab(h.$('#host'));
  await h.settle();
  assert.equal(h.$('.je-ls-name').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(h.$$('.je-ls-card img').length, 1, 'only the poster is an image');
  // Upstream 40738412: the year beside the title, the one-version note as a badge beside the days-left chip.
  assert.equal(h.$('.je-ls-year').textContent, '(2026)');
  assert.equal(h.$('.je-ls-scope').textContent, 'leavingsoon_one_version');
});

test('an empty list says nothing is leaving, and a page that is off registers nothing', async t => {
  const h = setup(t, list({ items: [] }));
  h.JE.leavingSoonPage.renderForCustomTab(h.$('#host'));
  await h.settle();
  assert.equal(h.$('.je-ls-empty').textContent, 'leavingsoon_none');
  const off = setup(t, list(), { enabled: false });
  assert.equal(off.JE.leavingSoonPage, undefined);
});

test('a list that cannot be read says so instead of showing nothing is leaving, and a failed reload keeps the last list', async t => {
  const h = setup(t, list(), { fail: 502 });
  h.JE.leavingSoonPage.renderForCustomTab(h.$('#host'));
  await h.settle();
  assert.equal(h.$('#host').textContent, 'leavingsoon_unavailable');
  assert.equal(h.$('.je-ls-empty'), null);
  const ok = setup(t, list());
  ok.JE.leavingSoonPage.renderForCustomTab(ok.$('#host'));
  await ok.settle();
  const ajax = ok.window.ApiClient.ajax;
  ok.window.ApiClient.ajax = async () => { throw Object.assign(new Error('HTTP 500'), { status: 500 }); };
  ok.window.dispatchEvent(new ok.window.CustomEvent('je-leaving-soon-changed'));
  await ok.settle();
  assert.deepEqual(ok.$$('.je-ls-name').map(e => e.textContent), ['Jailer 2', 'Sherlock', 'Old Show']);
  ok.window.ApiClient.ajax = ajax;
});

test('an administrator gets Keep and the date change on each card, and approves or denies pending requests', async t => {
  const h = setup(t, list({
    admin: true, actions: true,
    requests: [{ id: 7, title: '12th Fail', year: 2023, mediaType: 'movie', requestedBy: 'sam_user', note: 'Not my taste', jellyfinUser: 'Sam', jellyfinUserId: 'd'.repeat(32), itemId: 'e'.repeat(32), posterPath: '/p.jpg', status: 'pending', createdAt: '2026-11-16T10:00:00Z' }],
  }));
  h.JE.removalMenu = { act: (...args) => { h.acted = args; }, postpone: (...args) => { h.postponed = args; } };
  h.JE.leavingSoonPage.renderForCustomTab(h.$('#host'));
  await h.settle();
  const first = h.$$('.je-ls-card')[0];
  const keep = first.querySelector('.je-ls-icon-btn.keep');
  const change = first.querySelector('.je-ls-icon-btn.date');
  assert.equal(keep.title, 'maintainerr_keep');
  assert.equal(change.title, 'reclaimerr_change_date', 'Reclaimerr can set any day');
  assert.equal(keep.textContent.trim(), 'shield', 'icons, not text');
  keep.click();
  assert.equal(h.acted[0], 'unmark');
  assert.equal(JSON.stringify(h.acted[1]), JSON.stringify({ itemId: A }));
  assert.equal(h.acted[3], null, 'a Reclaimerr keep has no Undo');
  change.click();
  assert.equal(h.postponed[0], A);

  assert.ok(h.$('.je-ls-section h3').textContent.includes('leavingsoon_requests_title:1'));
  const row = h.$('.je-ls-reqcard');
  assert.match(row.textContent, /12th Fail/);
  assert.match(row.textContent, /leavingsoon_requested_by:Sam/, 'the Jellyfin person, not the Reclaimerr account');
  assert.match(row.textContent, /Not my taste/);
  assert.match(row.querySelector('.je-ls-poster img').getAttribute('src'), /Items\/e{32}\/Images\/Primary/, 'the Jellyfin item\'s own poster');
  assert.match(row.querySelector('.je-ls-avatar img').getAttribute('src'), /Users\/d{32}\/Images\/Primary/);
  assert.match(row.querySelector('.je-ls-who').getAttribute('title'), /sam_user/, 'the Reclaimerr account stays in the tooltip');
  assert.ok(row.querySelector('.je-ls-name[role="link"]'), 'the title opens the item');
  const approve = row.querySelector('.je-ls-icon-btn.approve');
  assert.equal(approve.title, 'leavingsoon_approve');
  assert.equal(approve.textContent.trim(), 'check', 'an icon, not text');

  // Approving deletes now, so it asks first: nothing is sent until "Delete now".
  approve.click();
  await h.settle();
  assert.equal(h.calls.some(c => c.path.startsWith('reclaimerr/requests')), false, 'no request yet');
  assert.equal(row.querySelector('.je-ls-warn').textContent, 'leavingsoon_confirm_delete');
  // Cancel goes back to the two buttons.
  Array.from(row.querySelectorAll('.je-ls-btn')).find(b => b.textContent === 'maintainerr_cancel').click();
  assert.ok(row.querySelector('.je-ls-icon-btn.approve'), 'back to Approve and Deny');
  row.querySelector('.je-ls-icon-btn.approve').click();
  row.querySelector('.je-ls-btn.danger').click();
  await h.settle();
  assert.deepEqual(h.calls.find(c => c.path.startsWith('reclaimerr/requests')), { type: 'POST', path: 'reclaimerr/requests/7/approve', body: {} });

  // Deny keeps the title, so it needs no confirmation.
  const again = setup(t, list({ admin: true, actions: true, requests: [{ id: 8, title: 'Crash', year: 2004, mediaType: 'movie', requestedBy: 'x', status: 'pending' }] }));
  again.JE.leavingSoonPage.renderForCustomTab(again.$('#host'));
  await again.settle();
  again.$('.je-ls-reqcard .je-ls-icon-btn.deny').click();
  await again.settle();
  assert.ok(again.calls.some(c => c.path === 'reclaimerr/requests/8/deny'));
});

test('a regular user sees their own requests with their state, and Maintainerr says postpone', async t => {
  const h = setup(t, list({ mine: [{ id: 3, title: 'Crash', year: 2004, mediaType: 'movie', status: 'denied', createdAt: '2026-11-01T00:00:00Z' }] }));
  h.JE.leavingSoonPage.renderForCustomTab(h.$('#host'));
  await h.settle();
  const row = h.$('.je-ls-reqcard');
  assert.match(row.textContent, /Crash/);
  assert.equal(row.querySelector('.je-ls-chip').textContent, 'leavingsoon_status_denied');
  assert.equal(row.querySelectorAll('.je-ls-icon-btn').length, 0, 'a user cannot review');
  const m = setup(t, list({ provider: 'maintainerr', admin: true, actions: true }));
  m.JE.removalMenu = { act(...args) { m.acted = args; }, postpone() {} };
  m.JE.leavingSoonPage.renderForCustomTab(m.$('#host'));
  await m.settle();
  const card = m.$$('.je-ls-card')[0];
  assert.equal(card.querySelector('.je-ls-icon-btn.date').title, 'maintainerr_postpone');
  card.querySelector('.je-ls-icon-btn.keep').click();
  assert.deepEqual(JSON.parse(JSON.stringify(m.acted[3])), { path: 'mark', body: { itemId: A }, doneKey: 'maintainerr_marked' }, 'a Maintainerr keep can be undone');
});

test('an action from the item menu reloads the page; stopping the page stops listening', async t => {
  const h = setup(t, list());
  h.JE.leavingSoonPage.renderForCustomTab(h.$('#host'));
  await h.settle();
  h.window.dispatchEvent(new h.window.CustomEvent('je-leaving-soon-changed'));
  await h.settle();
  assert.equal(h.calls.filter(c => c.path === 'leaving-soon/list').length, 2);
  h.JE.leavingSoonPage.stopPolling();
  h.window.dispatchEvent(new h.window.CustomEvent('je-leaving-soon-changed'));
  await h.settle();
  assert.equal(h.calls.filter(c => c.path === 'leaving-soon/list').length, 2);
});

test('the native Home tab is registered only when the page uses it', async t => {
  const tabs = [];
  const nativeTabs = { register: (id, title, mount, icon) => tabs.push({ id, title, icon, mount }) };
  const on = setup(t, list(), { config: { LeavingSoonPageUseNativeTab: true } });
  // The registry is read when the module loads: give it one and load the module again.
  on.JE.nativeTabs = nativeTabs;
  on.load('tags/tag-item-menu.js');
  assert.deepEqual(tabs.map(x => [x.id, x.title, x.icon]), [['leavingsoon', 'leavingsoon_title', 'auto_delete']]);
  const panel = on.document.createElement('div');
  tabs[0].mount(panel);
  assert.equal(panel.innerHTML, '<div class="jellyfinenhanced leavingsoon"></div>');
  const off = setup(t, list(), { config: { LeavingSoonPageUseNativeTab: false } });
  const none = [];
  off.JE.nativeTabs = { register: (...args) => none.push(args) };
  off.load('tags/tag-item-menu.js');
  assert.deepEqual(none, []);
});
