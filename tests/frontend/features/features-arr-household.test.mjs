// Requests & downloads, phase 3: the Household tab (Managers read, administrators edit roles,
// limits and house rules with a confirmation), the request ledger's rows in My requests (merged
// with the page's own entries, with Cancel) and the Managers' chip bar on the home page, rendered
// by the real modules from server answers, with intent-token interleavings and focus checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { translate, deferred, until, setupHub, USER } from '../helpers/arr-hub-extra.mjs';

const pid = n => String(n).padStart(32, 'c');
const person = (n, over = {}) => ({
  id: pid(n), name: `Person ${n}`, role: 'member', you: false, quota: { used: 1, limit: 7, available: true }, active: 0, waiting: 0, requests: [], ...over
});
const household = (people, settings) => ({ status: 200, body: { outcome: 'accepted', reason: 'household', certainty: 'Succeeded', canEdit: !!settings, people, settings } });
const settings = (over = {}) => ({ backend: 'je', preset: 'ask_first', defaultRole: 'member', quotaLimit: 0, windowDays: 7, roles: { watcher: {}, kid: { quotaLimit: 3 }, member: {}, manager: {} }, ...over });

test('a Manager sees cards (role, request use, open requests) and no controls', async t => {
  const h = setupHub(t, {
    hash: '#/requests?tab=household',
    routes: (m, path) => (path === '/acquire/household'
      ? household([
        person(1, { name: 'Leo', role: 'kid', active: 2, waiting: 1, quota: { used: 2, limit: 3, available: true },
          requests: [{ id: 'r1', key: 'movie:tmdb:9', kind: 'movie', scope: 'movie', status: 'pending', group: 'needsOk', title: 'Bluey', year: 2025, poster: '/b.jpg' }] }),
        person(2, { name: 'Mum', role: 'manager', you: true, quota: { used: 0, limit: null, available: true } })
      ])
      : null)
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelectorAll('.je-household-person').length === 2);
  const [leo, mum] = page.querySelectorAll('.je-household-person');
  assert.equal(leo.querySelector('.je-household-name').textContent, 'Leo');
  assert.equal(leo.querySelector('.je-household-role').textContent, 'child_careKid');
  assert.equal(leo.querySelector('.je-approval-meta').textContent, '2 of 3 used · 2 open · 1 waiting for an OK');
  assert.equal(leo.querySelector('.je-household-request-title').textContent, 'Bluey (2025)');
  assert.equal(leo.querySelector('.je-household-request .je-approval-meta').textContent, 'Movie · Waiting for an OK');
  assert.equal(mum.querySelector('.je-household-you').textContent, '(you)');
  assert.equal(mum.querySelector('.je-approval-meta').textContent, '0 used · no limit · 0 open · 0 waiting for an OK');
  assert.equal(page.querySelectorAll('select').length, 0);
  assert.equal(page.querySelector('.je-household-rules'), null);
  assert.equal(page.querySelector('.je-household-save'), null);
});

test('an administrator edits roles, limits and house rules; Save confirms, sends only the changes and says how it went', async t => {
  let saved = null;
  let reads = 0;
  const h = setupHub(t, {
    hash: '#/requests?tab=household',
    me: { role: 'admin' },
    routes: (method, path, body) => {
      if (path !== '/acquire/household') return null;
      if (method === 'POST') { saved = body; return { status: 200, body: { outcome: 'accepted', reason: 'saved', certainty: 'Succeeded', message: 'Household saved.' } }; }
      reads++;
      return household([
        person(1, { name: 'Leo', role: 'member', admin: { jellyfinAdmin: false, roleOverride: null, quotaOverride: null, fourK: false, parentalLimit: true } }),
        person(2, { name: 'Jake', role: 'admin', you: true, admin: { jellyfinAdmin: true, roleOverride: null, quotaOverride: null, fourK: true, parentalLimit: false } })
      ], settings());
    }
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelectorAll('.je-household-person').length === 2);
  // House rules first, then people. A Jellyfin administrator has no role picker.
  assert.equal(page.querySelector('.je-household-rules .je-hub-group-title').textContent, 'House rules');
  assert.equal(page.querySelector('[data-je-focus="household:preset"]').value, 'ask_first');
  assert.equal(page.querySelector('[data-je-focus="household:role-limit:kid"]').value, '3');
  assert.equal(page.querySelector(`[data-je-focus="household:role:${pid(2)}"]`), null);
  assert.equal(page.querySelector('.je-household-person:nth-child(2) .je-household-help').textContent, 'Jellyfin administrators are always Admin.');
  assert.ok(page.querySelector('.je-household-person:nth-child(2) .je-household-4k'));
  // The parental-limit hint suggests Kid (it never sets it).
  assert.match(page.querySelector('.je-household-person .je-household-help').textContent, /Kid may suit them/);
  assert.equal(page.querySelector('.je-household-save'), null);

  const pick = (focus, value) => {
    const select = page.querySelector(`[data-je-focus="${focus}"]`);
    select.focus();
    select.value = value;
    select.dispatchEvent(new h.window.Event('change'));
  };
  pick(`household:role:${pid(1)}`, 'kid');
  // Focus stays on the select across the redraw (keyboard and D-pad).
  assert.equal(h.document.activeElement.dataset.jeFocus, `household:role:${pid(1)}`);
  pick(`household:quota:${pid(1)}`, '-1');
  pick('household:preset', 'approve_everything');
  assert.equal(page.querySelector('.je-household-rules .je-household-help').textContent, translate('arr_household_preset_approve_everything_help'));
  pick('household:role-limit:kid', '');
  // Changing something back to what was served is no change.
  pick('household:default-role', 'kid');
  pick('household:default-role', 'member');

  page.querySelector('[data-je-focus="household:save"]').click();
  assert.equal(page.querySelector('.je-household-confirm').textContent, translate('arr_household_confirm'));
  assert.equal(saved, null, 'nothing is sent before the confirmation');
  page.querySelector('[data-je-focus="household:confirm"]').click();
  await until(() => saved !== null);
  assert.deepEqual(saved, { preset: 'approve_everything', roles: { kid: { quotaLimit: null } }, users: { [pid(1)]: { role: 'kid', quotaLimit: -1 } } });
  await until(() => reads === 2);
  await until(() => page.querySelector('.je-household-save .je-approval-result'));
  assert.equal(page.querySelector('.je-household-save .je-approval-result').textContent, 'Saved.');
  assert.equal(page.querySelector('[data-je-focus="household:save"]'), null);
});

test('a refused save keeps the edits and shows the administrator the reason code', async t => {
  const h = setupHub(t, {
    hash: '#/requests?tab=household',
    me: { role: 'admin' },
    routes: (method, path) => {
      if (path !== '/acquire/household') return null;
      if (method === 'POST') return { status: 400, body: { outcome: 'denied', reason: 'unknown_user', certainty: 'Rejected' } };
      return household([person(1, { admin: { jellyfinAdmin: false, roleOverride: 'member', quotaOverride: 5, fourK: false, parentalLimit: false } })], settings());
    }
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelector(`[data-je-focus="household:quota:${pid(1)}"]`));
  // The served override shows; an unusual limit is listed as a choice.
  assert.equal(page.querySelector(`[data-je-focus="household:quota:${pid(1)}"]`).value, '5');
  const role = page.querySelector(`[data-je-focus="household:role:${pid(1)}"]`);
  assert.equal(role.value, 'member');
  role.value = '';
  role.dispatchEvent(new h.window.Event('change'));
  page.querySelector('[data-je-focus="household:save"]').click();
  page.querySelector('[data-je-focus="household:confirm"]').click();
  await until(() => page.querySelector('.je-household-save .je-approval-result'));
  assert.equal(page.querySelector('.je-household-save .je-approval-result').textContent, "Some of those changes can't be saved. (unknown_user)");
  assert.ok(page.querySelector('[data-je-focus="household:save"]'), 'the edits are still there to fix or undo');
  assert.deepEqual(h.calls('POST', '/acquire/household')[0].body, { users: { [pid(1)]: { role: null, quotaLimit: 5 } } });
});

test('household reads: a feed change re-reads a clean tab, never throws away unsaved edits, and older answers are dropped', async t => {
  const reads = [];
  const h = setupHub(t, {
    hash: '#/requests?tab=household',
    me: { role: 'admin' },
    routes: (method, path) => {
      if (path !== '/acquire/household' || method !== 'GET') return null;
      const d = deferred();
      reads.push(d);
      return d.promise;
    }
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => reads.length === 1);
  h.bump('req:state');
  await until(() => reads.length === 2);
  reads[1].resolve(household([person(1, { name: 'Newer', admin: { jellyfinAdmin: false, fourK: false, parentalLimit: false } })], settings()));
  await until(() => page.querySelector('.je-household-name')?.textContent === 'Newer');
  reads[0].resolve(household([person(1, { name: 'Older' })], settings()));
  await wait(20);
  assert.equal(page.querySelector('.je-household-name').textContent, 'Newer');

  // With an unsaved edit a change only says so.
  const select = page.querySelector('[data-je-focus="household:preset"]');
  select.value = 'open_house';
  select.dispatchEvent(new h.window.Event('change'));
  h.bump('req:state');
  await until(() => page.querySelector('.je-hub-note-warn'));
  assert.equal(page.querySelector('.je-hub-note-warn').textContent, translate('arr_household_changed'));
  assert.equal(reads.length, 2);
  // Undo reads the latest.
  page.querySelector('[data-je-focus="household:discard"]').click();
  await until(() => reads.length === 3);
  reads[2].resolve(household([person(1, { name: 'Latest' })], settings()));
  await until(() => page.querySelector('.je-household-name')?.textContent === 'Latest');
});

// ------------------------------------------------------------------ My requests (ledger rows)

const own = (n, over = {}) => ({
  id: String(n).padStart(32, 'd'), key: `movie:tmdb:${n}`, kind: 'movie', scope: 'movie', variant: 'standard', seasons: [], episodes: [],
  status: 'pending', reason: 'awaiting_approval', group: 'needsOk', createdAt: new Date(Date.now() - n * 60000).toISOString(), canCancel: true,
  title: `Own ${n}`, year: 2026, poster: '/o.jpg', ...over
});
const mine = items => ({ status: 200, body: { outcome: 'accepted', reason: 'mine', certainty: 'Succeeded', items } });
const seerrEntry = (n, group = 'onTheWay') => ({
  key: `movie:tmdb:${n}`, kind: 'movie', tmdbId: n, title: `Seerr ${n}`, year: 2024, poster: '/s.jpg', request: 'approved', askedAt: new Date().toISOString(), group,
  status: { key: `movie:tmdb:${n}`, kind: 'movie', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 40 }, quiet: false, actions: [] }
});

test('My requests merges the ledger with the page\'s entries: one row per title, Cancel on unsent ones, said-no kept, cancelled left out', async t => {
  let items = [own(1), own(2, { status: 'queued', group: 'onTheWay' }), own(3, { status: 'declined', group: 'declined', canCancel: false, declineReason: 'Not for kids' }),
    own(4, { status: 'cancelled', group: 'cancelled', canCancel: false }), own(5, { canCancel: true })];
  const cancels = [];
  const h = setupHub(t, {
    me: { role: 'kid', contact: 'Dad' },
    hub: { contact: 'Dad', seerr: { configured: true, loaded: true }, mine: [seerrEntry(5)], soon: [], ready: [] },
    routes: (method, path) => {
      if (path === '/acquire/requests/mine') return mine(items);
      const m = /^\/acquire\/requests\/([a-z0-9]+)\/cancel$/.exec(path);
      if (m) {
        cancels.push(m[1]);
        items = items.map(i => (i.id === m[1] ? { ...i, status: 'cancelled', group: 'cancelled', canCancel: false } : i));
        return { status: 200, body: { outcome: 'accepted', reason: 'cancelled', certainty: 'Succeeded', requestId: m[1] } };
      }
      return null;
    }
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelectorAll('.je-hub-row').length === 4);
  const rows = [...page.querySelectorAll('.je-hub-row')];
  // Groups in order, newest first within a group.
  assert.deepEqual(rows.map(r => r.dataset.jeArrKey), ['movie:tmdb:1', 'movie:tmdb:5', 'movie:tmdb:2', 'movie:tmdb:3']);
  assert.deepEqual([...page.querySelectorAll('.je-hub-group-title')].map(e => e.textContent), ['Waiting for Dad to OK', 'On the way', 'Said no']);
  // The page's own entry keeps its row and status; the ledger adds Cancel to it.
  const seerr = rows[1];
  assert.equal(seerr.querySelector('.je-hub-name').textContent, 'Seerr 5 (2024)');
  assert.match(seerr.querySelector('.je-arr-pill-text').textContent, /^Downloading · 40%/);
  assert.ok(seerr.querySelector('.je-hub-cancel'));
  // Ledger-only rows say their state in family words.
  assert.equal(rows[0].querySelector('.je-arr-pill-text').textContent, translate('arr_status_awaiting_approval', { contact: 'Dad' }));
  assert.equal(rows[0].querySelector('.je-hub-name').textContent, 'Own 1 (2026)');
  assert.ok(!rows[3].querySelector('.je-hub-cancel'), 'nothing to cancel on a declined request');
  // The tab count includes the ledger rows (said-no not counted).
  assert.equal(page.querySelector('.je-hub-tab[data-tab="mine"] .je-hub-tab-count').textContent, '3');

  const cancel = rows[0].querySelector('.je-hub-cancel');
  assert.equal(cancel.getAttribute('aria-label'), 'Cancel the request for Own 1 (2026)');
  cancel.click();
  await until(() => h.toasts.length === 1);
  assert.deepEqual(cancels, [own(1).id]);
  assert.equal(h.toasts[0], 'Request cancelled.');
  await until(() => page.querySelectorAll('.je-hub-row').length === 3);
  assert.ok(!page.querySelector('.je-hub-row[data-je-arr-key="movie:tmdb:1"]'));
});

test('JE mode: no "Requests aren\'t set up" note above the ledger rows; Seerr mode without a Seerr keeps it', async t => {
  for (const ledger of [true, false]) {
    const h = setupHub(t, {
      me: { role: 'kid', contact: 'Dad' },
      hub: { contact: 'Dad', seerr: { configured: false, loaded: false, ledger }, mine: [], soon: [], ready: [] },
      routes: (method, path) => (path === '/acquire/requests/mine' ? mine([own(1)]) : null)
    });
    h.JE.initializeArrStatus();
    const page = h.page();
    await until(() => page.querySelectorAll('.je-hub-row').length === 1);
    const notes = [...page.querySelectorAll('.je-hub-note')].map(n => n.textContent);
    if (ledger) assert.ok(!notes.includes(translate('arr_hub_not_configured')), notes.join(' | '));
    else assert.ok(notes.includes(translate('arr_hub_not_configured')), notes.join(' | '));
  }
});

test('a cancel the server refuses says so honestly and the row stays', async t => {
  const h = setupHub(t, {
    me: { role: 'member' },
    routes: (method, path) => {
      if (path === '/acquire/requests/mine') return mine([own(1, { status: 'queued', group: 'onTheWay' })]);
      if (path.endsWith('/cancel')) return { status: 409, body: { outcome: 'denied', reason: 'request_in_flight', certainty: 'Rejected' } };
      return null;
    }
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelector('.je-hub-cancel'));
  page.querySelector('.je-hub-cancel').click();
  await until(() => h.toasts.length === 1);
  assert.equal(h.toasts[0], translate('arr_ask_toast_changed'));
  assert.ok(page.querySelector('.je-hub-row[data-je-arr-key="movie:tmdb:1"]'));
});

test('ledger reads: only the newest read is shown, and a read for the previous user never is', async t => {
  const reads = [];
  const h = setupHub(t, {
    me: { role: 'member' },
    routes: (m, path) => {
      if (path !== '/acquire/requests/mine') return null;
      const d = deferred();
      reads.push(d);
      return d.promise;
    }
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => reads.length === 1);
  h.bump(`req:u:${USER}`);
  await until(() => reads.length === 2);
  reads[1].resolve(mine([own(2, { title: 'Newer' })]));
  await until(() => page.querySelector('.je-hub-row'));
  reads[0].resolve(mine([own(1, { title: 'Older' })]));
  await wait(20);
  assert.deepEqual([...page.querySelectorAll('.je-hub-name')].map(e => e.textContent), ['Newer (2026)']);
  h.bump(`req:u:${USER}`);
  await until(() => reads.length === 3);
  h.switchUser();
  reads[2].resolve(mine([own(3, { title: 'Previous user' })]));
  await wait(30);
  assert.ok(![...page.querySelectorAll('.je-hub-name')].some(e => e.textContent.startsWith('Previous user')));
});

test('with the request controls off My requests is the page\'s own list and the ledger is never read', async t => {
  const h = setupHub(t, { config: { ArrRequestsEnabled: false }, hub: { contact: 'Dad', seerr: { configured: true, loaded: true }, mine: [seerrEntry(5)], soon: [], ready: [] } });
  h.JE.initializeArrStatus();
  await until(() => h.page()?.querySelector('.je-hub-row'));
  await wait(20);
  assert.equal(h.fetches.length, 0);
  assert.deepEqual([...h.page().querySelectorAll('.je-hub-tab')].map(b => b.dataset.tab), ['mine', 'soon', 'ready']);
  assert.equal(h.page().querySelectorAll('.je-hub-cancel').length, 0);
});

// ------------------------------------------------------------------ the home chip bar

const HOME = '<div class="homeSectionsContainer"><div class="verticalSection section0">My Media</div></div>';
const attention = (needOk, stuck) => ({ status: 200, body: { outcome: 'accepted', reason: 'attention', certainty: 'Succeeded', needOk, stuck } });

test('the chip bar shows "3 need your OK · 1 stuck" above the home rows for a Manager, after the first moment, and links to Approvals', async t => {
  let counts = attention(3, 1);
  const h = setupHub(t, { hash: '#/home', html: HOME, routes: (m, path) => (path === '/acquire/requests/attention' ? counts : null) });
  const started = Date.now();
  h.JE.initializeArrStatus();
  await wait(250);
  assert.equal(h.fetches.length, 0, 'nothing on the network in the first moment');
  await until(() => h.document.querySelector('.je-chipbar'));
  assert.ok(Date.now() - started >= 300);
  const bar = h.document.querySelector('.je-chipbar');
  assert.equal(bar.parentElement.className, 'homeSectionsContainer');
  assert.equal(bar.parentElement.firstElementChild, bar);
  assert.equal(bar.getAttribute('role'), 'group');
  const chips = [...bar.querySelectorAll('a')];
  assert.deepEqual(chips.map(a => a.querySelector('.je-chipbar-text').textContent), ['3 need your OK', '1 stuck']);
  assert.deepEqual(chips.map(a => a.getAttribute('href')), ['#/requests?tab=approvals', '#/requests?tab=approvals&show=stuck']);
  assert.ok(chips.every(a => a.querySelector('.material-icons')), 'an icon with the words, not colour alone');

  // It follows the shared request-list key instead of polling.
  chips[0].focus();
  counts = attention(1, 0);
  h.bump('req:state');
  await until(() => h.document.querySelectorAll('.je-chipbar a').length === 1);
  assert.equal(h.document.querySelector('.je-chipbar-text').textContent, '1 needs your OK');
  assert.equal(h.document.activeElement.dataset.jeFocus, 'chipbar:ok');
  counts = attention(0, 0);
  h.bump('req:state');
  await until(() => !h.document.querySelector('.je-chipbar'));
  assert.equal(h.calls('GET', '/acquire/requests/attention').length, 3);
});

test('a chip opens the Approvals tab (stuck: only the stuck cards)', async t => {
  const h = setupHub(t, {
    hash: '#/home', html: HOME,
    routes: (m, path) => (path === '/acquire/requests/attention' ? attention(0, 2)
      : path === '/acquire/requests/approvals' ? { status: 200, body: { items: [] } } : null)
  });
  h.JE.initializeArrStatus();
  await until(() => h.document.querySelector('.je-chipbar-stuck'));
  h.document.querySelector('.je-chipbar-stuck').click();
  await until(() => h.page() && !h.page().classList.contains('hide') && h.page().querySelector('.je-approvals-filter'));
  assert.equal(h.window.location.hash, '#/requests?tab=approvals&show=stuck');
  assert.equal(h.page().querySelector('.je-hub-tab[aria-selected="true"]').dataset.tab, 'approvals');
  assert.equal(h.page().querySelector('.je-hub-empty').textContent, 'Nothing is stuck.');
});

test('no chip bar for members, with both counts 0, or with the feature off', async t => {
  const member = setupHub(t, { hash: '#/home', html: HOME, me: { role: 'member' }, routes: () => null });
  member.JE.initializeArrStatus();
  await until(() => member.calls('GET', '/acquire/requests/me').length === 1);
  await wait(30);
  assert.equal(member.calls('GET', '/acquire/requests/attention').length, 0);
  assert.equal(member.document.querySelector('.je-chipbar'), null);

  const quiet = setupHub(t, { hash: '#/home', html: HOME, routes: (m, path) => (path === '/acquire/requests/attention' ? attention(0, 0) : null) });
  quiet.JE.initializeArrStatus();
  await until(() => quiet.calls('GET', '/acquire/requests/attention').length === 1);
  await wait(30);
  assert.equal(quiet.document.querySelector('.je-chipbar'), null);

  const off = setupHub(t, { hash: '#/home', html: HOME, config: { ArrRequestsEnabled: false } });
  off.JE.initializeArrStatus();
  await wait(500);
  assert.equal(off.fetches.length, 0);
  assert.equal(off.document.querySelector('.je-chipbar'), null);
});

test('chip bar reads: an older answer arriving last is dropped, and switching user takes the chips away', async t => {
  const reads = [];
  const h = setupHub(t, {
    hash: '#/home', html: HOME,
    routes: (m, path) => {
      if (path !== '/acquire/requests/attention') return null;
      const d = deferred();
      reads.push(d);
      return d.promise;
    }
  });
  h.JE.initializeArrStatus();
  await until(() => reads.length === 1);
  h.bump('req:state');
  await until(() => reads.length === 2);
  reads[1].resolve(attention(5, 0));
  await until(() => h.document.querySelector('.je-chipbar'));
  reads[0].resolve(attention(9, 9));
  await wait(20);
  assert.equal(h.document.querySelector('.je-chipbar-text').textContent, '5 need your OK');
  assert.equal(h.document.querySelectorAll('.je-chipbar a').length, 1);
  h.switchUser();
  assert.equal(h.document.querySelector('.je-chipbar'), null);
});
