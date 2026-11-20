import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

const DAY = 86400000;
const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32);

/** The Leaving soon page over the real UI kit, with the plugin's list route mocked. */
function setup(t, data, { enabled = true } = {}) {
  const calls = [];
  const h = createHarness({
    html: '<div id="host"></div>',
    JE: {
      pluginConfig: { LeavingSoonPageEnabled: enabled, LeavingSoonProvider: data.provider || 'reclaimerr', ToastDuration: 1500 },
      t: (key, params) => params ? `${key}:${Object.values(params).join('|')}` : key,
      session: { onUserChange: () => {} },
    },
    apiClient: {
      ajax: async ({ type, url, data: body }) => {
        const path = new URL(url).pathname.replace('/JellyfinEnhanced/', '');
        calls.push({ type, path, body: body ? JSON.parse(body) : null });
        if (path === 'leaving-soon/list') return data;
        return { ok: true };
      },
    },
  });
  t.after(() => h.close());
  for (const file of ['enhanced/config.js', 'core/ui-kit.js', 'extras/leavingsoon-page.js']) h.load(file);
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

test('an empty list says nothing is leaving, and a page that is off registers nothing', async t => {
  const h = setup(t, list({ items: [] }));
  h.JE.leavingSoonPage.renderForCustomTab(h.$('#host'));
  await h.settle();
  assert.equal(h.$('.je-ls-empty').textContent, 'leavingsoon_none');
  const off = setup(t, list(), { enabled: false });
  assert.equal(off.JE.leavingSoonPage, undefined);
});

test('an administrator gets Keep and the date change on each card, and approves or denies pending requests', async t => {
  const h = setup(t, list({
    admin: true, actions: true, graceDays: 0,
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
  const deny = row.querySelector('.je-ls-icon-btn.deny');
  assert.equal(approve.title, 'leavingsoon_approve');
  assert.equal(approve.textContent.trim(), 'check', 'an icon, not text');

  // Approving deletes (now, with no grace period set in Reclaimerr), so it asks first: nothing is sent until "Approve".
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
  assert.deepEqual(h.calls.find(c => c.path.startsWith('reclaimerr/requests')), { type: 'POST', path: 'reclaimerr/requests/7/approve', body: { when: 'default' } });

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
  m.JE.removalMenu = { act() {}, postpone() {} };
  m.JE.leavingSoonPage.renderForCustomTab(m.$('#host'));
  await m.settle();
  assert.equal(m.$$('.je-ls-card')[0].querySelector('.je-ls-icon-btn.date').title, 'maintainerr_postpone');
});
