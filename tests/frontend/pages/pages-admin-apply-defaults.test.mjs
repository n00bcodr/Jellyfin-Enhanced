import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, deferred, jsonResponse } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';

// Design item C4: the policy table's Follow / Kept / Changed counts (loaded only when the table is
// opened), the per-user list, the "Apply defaults to users" dialog (preview, apply, undo; gated on
// unsaved changes and the preview's ConfigEpoch) and the one-time upgrade card, all in
// js/admin/user-settings-policy.js, run against the real admin page markup.

const pagePath = resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html');
const pageSource = readFileSync(pagePath, 'utf8');
const pageMarkup = pageSource.slice(pageSource.indexOf('<div class="page'), pageSource.lastIndexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '');
const registryDefault = JSON.parse(readFileSync(resolve(repositoryRoot, 'tests/fixtures/settings/admin-registry-default.json'), 'utf8'));
const adminKeys = registryDefault.map(entry => entry.Key);

const XSS = '<img src=x onerror="window.__xss=1">';

function overviewFor({ adoptable = 2 } = {}) {
  return {
    ConfigEpoch: 'epoch-1',
    Users: { Total: 4, WithSettings: 3, WithoutSettings: 1, Orphans: 1, LiveListed: true, DirectoriesListed: true },
    Adoptable: { Users: adoptable, Keys: 40 },
    Settings: adminKeys.map(key => ({ Key: key, Following: 1, Existing: 1, ExistingSameAsDefault: 1, Chosen: 1, Kept: 1, Changed: key === 'AutoPipEnabled' ? 1 : 0 })),
    Corrupt: [], Oversized: [], Unavailable: [],
    UserList: [
      { Id: 'a'.repeat(32), Name: 'alice', Live: true, Orphan: false, Settings: 'settings' },
      { Id: 'b'.repeat(32), Name: XSS, Live: true, Orphan: false, Settings: 'settings' },
      { Id: 'c'.repeat(32), Name: 'fresh', Live: true, Orphan: false, Settings: 'none' },
      { Id: 'd'.repeat(32), Name: null, Live: false, Orphan: true, Settings: 'settings' }
    ]
  };
}

function applyAnswer(body, overrides = {}) {
  return {
    success: true, DryRun: body.DryRun, ConfigEpoch: 'epoch-1', Mode: body.Mode, Keys: body.Keys,
    Users: 4, Updated: 2, Unchanged: 1, KeysChanged: 40, VisibleChanges: 0, KeptChoices: 1,
    Skipped: [{ Id: 'c'.repeat(32), Name: 'fresh', Reason: 'no-settings' }, { Id: 'e'.repeat(32), Name: XSS, Reason: 'corrupt' }],
    Failed: [{ Id: 'f'.repeat(32), Name: null, Document: 'HiddenContent', Reason: 'unavailable' }],
    PerKey: {}, PerUser: [{ Id: 'a'.repeat(32), Name: XSS, Changed: ['AutoPipEnabled'], Visible: [], Kept: ['ShowFileSizes'], Documents: [] }],
    UndoId: body.DryRun ? null : '20261012000000000-abcdef12',
    ...overrides
  };
}

/**
 * The page with the policy script and a scripted admin API. `routes` answers by path; every
 * request is recorded as { type, path, body }.
 */
function setup(t, { dismissed = false, overview = overviewFor(), apply, undo, perUser } = {}) {
  const requests = [];
  const h = createHarness({
    html: pageMarkup,
    apiClient: {
      ajax: async (request) => {
        const path = request.url.replace('http://jellyfin.test', '');
        const body = request.data ? JSON.parse(request.data) : undefined;
        requests.push({ type: request.type, path, body });
        if (path.endsWith('/registry')) return structuredClone(registryDefault);
        if (path.endsWith('/upgrade-card')) return dismissed ? { Dismissed: true } : { Dismissed: false, Adoptable: structuredClone(overview.Adoptable) };
        if (path.endsWith('/upgrade-card/dismiss')) return { Dismissed: true };
        if (path.endsWith('/overview')) return structuredClone(overview);
        if (path.includes('/overview/')) return perUser ? perUser(path) : { Key: 'AutoPipEnabled', Default: false, Locked: false, Users: [] };
        if (path.endsWith('/apply')) return apply ? apply(body) : applyAnswer(body);
        if (path.includes('/undo/')) return undo ? undo(path) : { success: true, Restored: 40, Kept: 2, FailedUsers: 0, PerUser: [] };
        throw new Error('unexpected ' + path);
      }
    }
  });
  t.after(() => h.close());
  h.allowConsoleError(/Could not parse CSS stylesheet/);
  const page = h.document.querySelector('#JellyfinEnhancedPage');
  h.load('admin/user-settings-policy.js');
  const policy = h.window.JellyfinEnhancedAdminPolicy;
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
  const paths = () => requests.map(r => r.path.replace('/JellyfinEnhanced/admin/user-settings', ''));
  // jsdom fires the details element's toggle event itself, like a browser.
  const openDetails = async () => {
    const details = h.document.querySelector('#jeUserSettingsPolicyDetails');
    if (details.open) {
      details.open = false;
      await settle();
    }
    details.open = true;
    await settle();
  };
  const dialog = () => h.document.querySelector('.je-apply-dialog');
  const button = text => [...dialog().querySelectorAll('.je-apply-buttons button')].find(b => b.textContent === text);
  return { ...h, page, policy, requests, settle, paths, openDetails, dialog, button };
}

test('counts are read only when the policy table is opened; Changed opens the per-user list', async t => {
  const h = setup(t, {
    dismissed: true,
    perUser: () => ({
      Key: 'AutoPipEnabled', Default: false, Locked: false, Users: [
        { UserId: 'a'.repeat(32), Name: 'alice', Live: true, Orphan: false, Value: false, State: 'Existing', SameAsDefault: true },
        { UserId: 'b'.repeat(32), Name: XSS, Live: true, Orphan: false, Value: true, State: 'Chosen', SameAsDefault: false },
        { UserId: 'c'.repeat(32), Name: 'fresh', Live: true, Orphan: false, Value: null, State: 'NoSettings', SameAsDefault: false },
        { UserId: 'd'.repeat(32), Name: null, Live: false, Orphan: true, Value: XSS, State: 'Existing', SameAsDefault: false, Invalid: true }
      ]
    })
  });
  await h.policy.decorate(h.page);
  await h.settle();
  assert.deepEqual(h.paths(), ['/registry', '/upgrade-card'], 'no user files are read while the table is closed and the card was dismissed');
  const header = [...h.document.querySelectorAll('#jeUserSettingsPolicyTable thead th')].map(th => th.textContent);
  assert.deepEqual(header, ['Setting', 'Server default', 'Reach', 'Lock', 'Follow', 'Kept', 'Changed']);
  assert.equal(h.document.querySelector('#jeUserSettingsPolicyTable tr.je-policy-group th').colSpan, 7);

  await h.openDetails();
  assert.deepEqual(h.paths(), ['/registry', '/upgrade-card', '/overview']);
  const row = h.document.querySelector('#jePolicyRow-AutoPipEnabled');
  assert.deepEqual([...row.querySelectorAll('td[data-count]')].map(td => td.textContent), ['1', '1', '1 ›']);
  assert.equal(h.document.querySelector('#jePolicyRow-ShowFileSizes td[data-count="Changed"]').textContent, '0');
  assert.match(h.document.querySelector('#jeUserSettingsPolicyCountsStatus').textContent, /3 users with settings · 1 user hasn't used Jellyfin Enhanced yet · 1 folder with no Jellyfin user/);

  row.querySelector('.je-policy-users-toggle').click();
  await h.settle();
  const list = row.nextElementSibling;
  assert.ok(list.classList.contains('je-policy-users'));
  const rows = [...list.querySelectorAll('.je-policy-users-table > tbody > tr')].map(tr => [...tr.children].map(cell => cell.textContent));
  assert.deepEqual(rows, [
    [XSS, 'On', 'Their own choice', 'Make follow default'],
    ['Folder with no Jellyfin user (' + 'd'.repeat(32) + ')', '(invalid value)', 'Kept from before', 'Make follow default'],
    ['alice', 'Off', 'Copy of your default', 'Make follow default'],
    ['fresh', '–', 'Hasn\'t used Jellyfin Enhanced yet (will get your current defaults)', '']
  ]);
  assert.equal(list.querySelector('img'), null, 'user-sourced names and values are text, never markup');
  assert.equal(h.window.__xss, undefined);

  // Reopening the table reads again only after something changed.
  await h.openDetails();
  assert.equal(h.paths().filter(p => p === '/overview').length, 1);
});

test('"Make follow default" follows one key for one user with the overview epoch, and offers undo', async t => {
  const h = setup(t, {
    dismissed: true,
    apply: body => applyAnswer(body, { Skipped: [], Failed: [], PerUser: [{ Id: 'b'.repeat(32), Name: 'bob', Changed: ['AutoPipEnabled'], Visible: ['AutoPipEnabled'], Kept: [], Documents: [] }] }),
    perUser: () => ({ Key: 'AutoPipEnabled', Default: false, Locked: false, Users: [{ UserId: 'b'.repeat(32), Name: 'bob', Live: true, Orphan: false, Value: true, State: 'Chosen', SameAsDefault: false }] })
  });
  await h.policy.decorate(h.page);
  await h.openDetails();
  const row = h.document.querySelector('#jePolicyRow-AutoPipEnabled');
  row.querySelector('.je-policy-users-toggle').click();
  await h.settle();

  // Not while the page has unsaved changes.
  h.page.querySelector('.je-save-dock').classList.add('je-dirty');
  row.nextElementSibling.querySelector('.je-policy-follow-btn').click();
  await h.settle();
  assert.match(row.nextElementSibling.querySelector('.je-policy-users-message').textContent, /Save your changes first/);
  assert.equal(h.requests.filter(r => r.path.endsWith('/apply')).length, 0);

  h.page.querySelector('.je-save-dock').classList.remove('je-dirty');
  row.nextElementSibling.querySelector('.je-policy-follow-btn').click();
  await h.settle();
  const sent = h.requests.find(r => r.path.endsWith('/apply'));
  assert.deepEqual(sent.body, { Keys: ['AutoPipEnabled'], UserIds: ['b'.repeat(32)], Mode: 'FollowAll', DryRun: false, ConfigEpoch: 'epoch-1' });
  const note = row.nextElementSibling.querySelector('.je-policy-users-note');
  assert.match(note.textContent, /^bob now follows your default for Auto Picture-in-Picture on tab switch\./);
  note.querySelector('.je-apply-undo').click();
  await h.settle();
  assert.ok(h.requests.some(r => r.type === 'POST' && r.path === '/JellyfinEnhanced/admin/user-settings/undo/20261012000000000-abcdef12'));
  assert.match(note.textContent, /Undone: 40 restored, 2 changed since and kept as they are\./);
});

test('after "Make follow default" and its undo, the open list shows each user\'s value and state again', async t => {
  const bob = 'b'.repeat(32);
  let bobFollows = false;
  let gate = null;
  const h = setup(t, {
    dismissed: true,
    apply: body => { bobFollows = true; return applyAnswer(body, { Skipped: [], Failed: [], PerUser: [{ Id: bob, Name: 'bob', Changed: ['AutoPipEnabled'], Visible: ['AutoPipEnabled'], Kept: [], Documents: [] }] }); },
    undo: () => { bobFollows = false; return { success: true, Restored: 1, Kept: 0, FailedUsers: 0, Pending: false, PerUser: [] }; },
    perUser: async () => {
      if (gate) await gate.promise;
      return {
        Key: 'AutoPipEnabled', Default: false, Locked: false, Users: [
          bobFollows
            ? { UserId: bob, Name: 'bob', Live: true, Orphan: false, Value: false, State: 'Following', SameAsDefault: true }
            : { UserId: bob, Name: 'bob', Live: true, Orphan: false, Value: true, State: 'Chosen', SameAsDefault: false },
          { UserId: 'a'.repeat(32), Name: 'alice', Live: true, Orphan: false, Value: true, State: 'Chosen', SameAsDefault: false }
        ]
      };
    }
  });
  await h.policy.decorate(h.page);
  await h.openDetails();
  const row = h.document.querySelector('#jePolicyRow-AutoPipEnabled');
  row.querySelector('.je-policy-users-toggle').click();
  await h.settle();
  const list = row.nextElementSibling;
  const rows = () => [...list.querySelectorAll('.je-policy-users-table > tbody > tr')].map(tr => [...tr.children].map(cell => cell.textContent));
  assert.deepEqual(rows(), [['bob', 'On', 'Their own choice', 'Make follow default'], ['alice', 'On', 'Their own choice', 'Make follow default']]);

  // While the list reloads, bob's row already shows the default he now follows, not his old value.
  gate = deferred();
  list.querySelector('.je-policy-follow-btn').click();
  await h.settle();
  assert.deepEqual(rows()[0], ['bob', 'Off', 'Follows your default', '']);
  gate.resolve();
  gate = null;
  await h.settle();
  assert.deepEqual(rows(), [['alice', 'On', 'Their own choice', 'Make follow default'], ['bob', 'Off', 'Follows your default', '']]);
  const note = list.querySelector('.je-policy-users-note');
  assert.match(note.textContent, /^bob now follows your default/);

  // The undo restores bob's own choice: the list shows it again, with the button, and keeps the note.
  note.querySelector('.je-apply-undo').click();
  await h.settle();
  assert.deepEqual(rows(), [['bob', 'On', 'Their own choice', 'Make follow default'], ['alice', 'On', 'Their own choice', 'Make follow default']]);
  assert.equal(list.querySelector('.je-policy-users-note'), note);
  assert.match(note.textContent, /Undone: 1 restored\./);
  assert.equal(h.paths().filter(p => p === '/overview/AutoPipEnabled').length, 3);
});

test('a list whose last changed user was made to follow can still be closed and opened again', async t => {
  const bob = 'b'.repeat(32);
  const overview = overviewFor();
  const autoPip = overview.Settings.find(entry => entry.Key === 'AutoPipEnabled');
  let bobFollows = false;
  const setFollows = (follows) => {
    bobFollows = follows;
    autoPip.Changed = follows ? 0 : 1;
  };
  const h = setup(t, {
    dismissed: true,
    overview,
    apply: body => { setFollows(true); return applyAnswer(body, { Skipped: [], Failed: [], PerUser: [{ Id: bob, Name: 'bob', Changed: ['AutoPipEnabled'], Visible: ['AutoPipEnabled'], Kept: [], Documents: [] }] }); },
    undo: () => { setFollows(false); return { success: true, Restored: 1, Kept: 0, FailedUsers: 0, Pending: false, PerUser: [] }; },
    perUser: () => ({
      Key: 'AutoPipEnabled', Default: false, Locked: false, Users: [bobFollows
        ? { UserId: bob, Name: 'bob', Live: true, Orphan: false, Value: false, State: 'Following', SameAsDefault: true }
        : { UserId: bob, Name: 'bob', Live: true, Orphan: false, Value: true, State: 'Chosen', SameAsDefault: false }]
    })
  });
  await h.policy.decorate(h.page);
  await h.openDetails();
  const row = h.document.querySelector('#jePolicyRow-AutoPipEnabled');
  const changed = () => row.querySelector('td[data-count="Changed"]');
  const isList = el => !!el && el.classList.contains('je-policy-users');
  changed().querySelector('.je-policy-users-toggle').click();
  await h.settle();
  const list = row.nextElementSibling;
  list.querySelector('.je-policy-follow-btn').click();
  await h.settle();

  // Changed is now 0, but the open list keeps its toggle.
  let toggle = changed().querySelector('.je-policy-users-toggle');
  assert.ok(toggle, 'the open list can still be closed');
  assert.equal(toggle.textContent, '0 ›');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(isList(row.nextElementSibling));

  // The undo brings the count back while the list stays open.
  list.querySelector('.je-apply-undo').click();
  await h.settle();
  assert.equal(changed().querySelector('.je-policy-users-toggle').textContent, '1 ›');
  list.querySelector('.je-policy-follow-btn').click();
  await h.settle();

  toggle = changed().querySelector('.je-policy-users-toggle');
  toggle.click();
  await h.settle();
  assert.equal(isList(row.nextElementSibling), false, 'closed');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  toggle.click();
  await h.settle();
  assert.ok(isList(row.nextElementSibling), 'opened again');
  assert.deepEqual([...row.nextElementSibling.querySelectorAll('.je-policy-users-table > tbody > tr')].map(tr => [...tr.children].map(cell => cell.textContent)), [['bob', 'Off', 'Follows your default', '']]);

  // Once closed, a recount shows a plain 0 again.
  toggle.click();
  await h.openDetails();
  assert.equal(changed().querySelector('.je-policy-users-toggle'), null);
  assert.equal(changed().textContent, '0');
});

test('"Make follow default" reports a user the run skipped, failed or did not need to change, and keeps the button', async t => {
  const bob = 'b'.repeat(32);
  const answers = [
    { Skipped: [{ Id: bob, Name: 'bob', Reason: 'corrupt' }], Failed: [], PerUser: [] },
    { Skipped: [], Failed: [{ Id: bob, Name: 'bob', Document: 'Settings', Reason: 'unavailable' }], PerUser: [] },
    { Skipped: [], Failed: [], PerUser: [], UndoId: null }, // already following: nothing to change
    // Another user's change is not this user's success.
    { Skipped: [], Failed: [], PerUser: [{ Id: 'a'.repeat(32), Name: 'alice', Changed: ['AutoPipEnabled'], Visible: [], Kept: [], Documents: [] }] }
  ];
  const h = setup(t, {
    dismissed: true,
    apply: body => applyAnswer(body, answers.shift()),
    perUser: () => ({ Key: 'AutoPipEnabled', Default: false, Locked: false, Users: [{ UserId: bob, Name: 'bob', Live: true, Orphan: false, Value: true, State: 'Chosen', SameAsDefault: false }] })
  });
  await h.policy.decorate(h.page);
  await h.openDetails();
  const row = h.document.querySelector('#jePolicyRow-AutoPipEnabled');
  row.querySelector('.je-policy-users-toggle').click();
  await h.settle();
  const list = row.nextElementSibling;
  const note = list.querySelector('.je-policy-users-message');
  const expected = [
    /^bob: not changed, settings file is corrupt, left untouched\.$/,
    /^bob: not changed \(the file could not be read or written\)\.$/,
    /^Nothing changed for bob: this setting changed since the list was loaded/,
    /^Nothing changed for bob/
  ];
  for (const message of expected) {
    const button = list.querySelector('.je-policy-follow-btn');
    assert.ok(button, 'the button stays');
    button.click();
    await h.settle();
    assert.match(note.textContent, message);
    assert.equal(button.disabled, false);
    assert.equal(list.querySelector('tbody tr td:nth-of-type(2)').textContent, 'Their own choice', 'the state is not shown as following');
    assert.equal(list.querySelector('.je-apply-undo'), null);
  }
});

test('each "Make follow default" keeps its own Undo: a later follow, a message or closing the list does not remove it', async t => {
  const bob = 'b'.repeat(32);
  const alice = 'a'.repeat(32);
  let undoId = 0;
  const h = setup(t, {
    dismissed: true,
    apply: body => applyAnswer(body, { Skipped: [], Failed: [], UndoId: '20261012000000000-abcdef1' + (++undoId),
      PerUser: [{ Id: body.UserIds[0], Name: body.UserIds[0] === bob ? 'bob' : 'alice', Changed: ['AutoPipEnabled'], Visible: [], Kept: [], Documents: [] }] }),
    perUser: () => ({ Key: 'AutoPipEnabled', Default: false, Locked: false, Users: [
      { UserId: bob, Name: 'bob', Live: true, Orphan: false, Value: true, State: 'Chosen', SameAsDefault: false },
      { UserId: alice, Name: 'alice', Live: true, Orphan: false, Value: true, State: 'Chosen', SameAsDefault: false }
    ] })
  });
  await h.policy.decorate(h.page);
  await h.openDetails();
  // The table is rendered again further down: always the current row.
  const row = { get nextElementSibling() { return h.document.querySelector('#jePolicyRow-AutoPipEnabled').nextElementSibling; },
    querySelector: selector => h.document.querySelector('#jePolicyRow-AutoPipEnabled').querySelector(selector) };
  const toggle = () => row.querySelector('.je-policy-users-toggle');
  toggle().click();
  await h.settle();
  const followButton = name => [...row.nextElementSibling.querySelectorAll('tbody tr')].find(tr => tr.firstElementChild.textContent === name).querySelector('.je-policy-follow-btn');
  followButton('bob').click();
  await h.settle();
  followButton('alice').click();
  await h.settle();
  const lines = () => [...row.nextElementSibling.querySelectorAll('.je-policy-users-note .je-policy-follow-line')];
  assert.deepEqual(lines().map(line => line.firstChild.textContent), ['bob now follows your default for Auto Picture-in-Picture on tab switch. ', 'alice now follows your default for Auto Picture-in-Picture on tab switch. ']);
  assert.equal(lines().filter(line => line.querySelector('.je-apply-undo')).length, 2);

  // A refused follow says so in the message line; the Undo buttons stay.
  h.page.querySelector('.je-save-dock').classList.add('je-dirty');
  followButton('bob').click();
  await h.settle();
  assert.match(row.nextElementSibling.querySelector('.je-policy-users-message').textContent, /Save your changes first/);
  assert.equal(lines().filter(line => line.querySelector('.je-apply-undo')).length, 2);
  h.page.querySelector('.je-save-dock').classList.remove('je-dirty');

  // Closed and opened again, and after the table is rendered again: still there.
  toggle().click();
  await h.settle();
  toggle().click();
  await h.settle();
  assert.equal(lines().length, 2);
  await h.policy.decorate(h.page);
  await h.openDetails();
  toggle().click();
  await h.settle();
  assert.equal(lines().length, 2);

  // Bob's Undo undoes bob's run.
  lines()[0].querySelector('.je-apply-undo').click();
  await h.settle();
  assert.ok(h.requests.some(r => r.path === '/JellyfinEnhanced/admin/user-settings/undo/20261012000000000-abcdef11'));
  assert.match(lines()[0].textContent, /Undone: 40 restored/);
  assert.ok(lines()[1].querySelector('.je-apply-undo'), 'alice keeps hers');
});

test('the dialog previews the saved settings, applies with the preview\'s epoch, and undoes', async t => {
  const h = setup(t, { dismissed: true });
  await h.policy.decorate(h.page);
  h.document.querySelector('#jeApplyDefaultsBtn').click();
  await h.settle();
  assert.ok(h.dialog());
  assert.equal(h.dialog().getAttribute('role'), 'dialog');
  assert.equal(h.button('Apply').disabled, true, 'Apply needs a preview first');

  // Unsaved changes: neither Preview nor Apply.
  h.page.querySelector('.je-save-dock').classList.add('je-dirty');
  h.dialog().querySelector('.je-apply-mode input[value="FollowAll"]').click();
  assert.equal(h.button('Preview').disabled, true);
  assert.equal(h.dialog().querySelector('.je-policy-status-error').hidden, false);
  h.page.querySelector('.je-save-dock').classList.remove('je-dirty');
  h.dialog().querySelector('.je-apply-mode input[value="FollowIfUnchanged"]').click();
  assert.equal(h.button('Preview').disabled, false);

  h.button('Preview').click();
  await h.settle();
  const preview = h.requests.filter(r => r.path.endsWith('/apply'))[0].body;
  assert.equal(preview.DryRun, true);
  assert.equal(preview.Mode, 'FollowIfUnchanged');
  assert.equal(preview.UserIds, null);
  assert.deepEqual([...preview.Keys].sort(), [...adminKeys].sort());
  const summary = h.dialog().querySelector('.je-apply-summary');
  assert.match(summary.textContent, /^2 users will follow your defaults for 40 settings in all · 0 visible changes · 1 user keeps their own value for some settings/);
  assert.match(summary.textContent, /1 user hasn't used Jellyfin Enhanced yet/);
  assert.match(summary.textContent, /: skipped, settings file is corrupt, left untouched/);
  assert.match(summary.textContent, /Folder with no Jellyfin user \(f+\): hidden-content settings not changed \(the file could not be read or written\)/);
  assert.equal(summary.querySelector('img'), null);
  assert.equal(h.button('Apply').disabled, false);

  h.button('Apply').click();
  await h.settle();
  const run = h.requests.filter(r => r.path.endsWith('/apply'))[1].body;
  assert.deepEqual(run, { ...preview, DryRun: false, ConfigEpoch: 'epoch-1' });
  assert.equal(summary.textContent, '', 'the result moves to the list of runs');
  const done = h.dialog().querySelector('.je-apply-runs .je-apply-run');
  assert.match(done.textContent, /^2 users now follow your defaults for 40 settings in all · 0 visible changes/);
  assert.equal(done.querySelector('img'), null);
  assert.equal(h.button('Apply').disabled, true, 'a run needs a new preview');
  done.querySelector('.je-apply-undo').click();
  await h.settle();
  assert.ok(h.requests.some(r => r.path.endsWith('/undo/20261012000000000-abcdef12')));
  assert.match(done.textContent, /Undone: 40 restored/);

  // Escape closes the dialog.
  h.dialog().closest('.je-apply-backdrop').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.dialog(), null);
});

test('while a real run is in flight the dialog cannot be closed, so its result and Undo are shown', async t => {
  const gate = deferred();
  const h = setup(t, {
    dismissed: true,
    apply: async (body) => {
      if (!body.DryRun) await gate.promise;
      return applyAnswer(body);
    }
  });
  await h.policy.decorate(h.page);
  h.policy.openApplyDialog({ mode: 'FollowAll' });
  await h.settle();
  h.button('Preview').click();
  await h.settle();
  h.button('Apply').click();
  await h.settle();
  assert.equal(h.button('Close').disabled, true);
  h.button('Close').click();
  h.dialog().closest('.je-apply-backdrop').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok(h.dialog(), 'still open while the run is in flight');

  gate.resolve();
  await h.settle();
  const done = h.dialog().querySelector('.je-apply-run');
  assert.match(done.textContent, /^2 users now follow your defaults/);
  assert.ok(done.querySelector('.je-apply-undo'));
  assert.equal(h.button('Close').disabled, false);
  h.button('Close').click();
  assert.equal(h.dialog(), null);
});

test('changing the selection after a preview, or a stale epoch, needs a new preview', async t => {
  let stale = false;
  const h = setup(t, {
    dismissed: true,
    apply: body => (stale && !body.DryRun ? Promise.reject(jsonResponse({ success: false, ConfigEpoch: 'epoch-2' }, 409)) : applyAnswer(body))
  });
  await h.policy.decorate(h.page);
  h.policy.openApplyDialog({ mode: 'Overwrite' });
  await h.settle();
  h.button('Preview').click();
  await h.settle();
  assert.match(h.dialog().querySelector('.je-apply-summary').textContent, /^2 users will be updated: 40 settings overwritten in all · 0 visible changes/);
  assert.equal(h.button('Apply').disabled, false);

  // Untick one group: the preview no longer matches.
  const group = h.dialog().querySelector('.je-apply-group summary input');
  group.click();
  assert.equal(h.button('Apply').disabled, true);
  assert.match(h.dialog().querySelector('.je-apply-summary').textContent, /The selection changed: preview again/);
  h.button('Preview').click();
  await h.settle();
  const keys = h.requests.filter(r => r.path.endsWith('/apply')).at(-1).body.Keys;
  assert.ok(keys.length < adminKeys.length && keys.length > 0);

  // Selected users only.
  const selected = [...h.dialog().querySelectorAll('input[name="jeApplyUsers"]')][1];
  selected.click();
  assert.equal(h.button('Preview').disabled, true, 'no user picked yet');
  h.dialog().querySelector('.je-apply-users input').click();
  h.button('Preview').click();
  await h.settle();
  assert.deepEqual(h.requests.filter(r => r.path.endsWith('/apply')).at(-1).body.UserIds, ['a'.repeat(32)]);
  assert.match(h.dialog().querySelector('.je-apply-users').textContent, /Folder with no Jellyfin user \(d+\)/);
  assert.equal(h.dialog().querySelector('.je-apply-users img'), null);

  stale = true;
  h.button('Apply').click();
  await h.settle();
  assert.match(h.dialog().querySelector('.je-apply-summary').textContent, /saved since the preview\. Preview again/);
  assert.equal(h.button('Apply').disabled, true);
});

test('the result line counts users first and calls the setting count a total only for several users', async t => {
  const answers = [];
  const h = setup(t, { dismissed: true, apply: body => applyAnswer(body, answers.shift() || {}) });
  await h.policy.decorate(h.page);
  h.policy.openApplyDialog({ mode: 'FollowIfUnchanged' });
  await h.settle();
  const summary = () => h.dialog().querySelector('.je-apply-summary strong').textContent;
  const preview = async (overrides) => {
    answers.push(overrides);
    h.button('Preview').click();
    await h.settle();
    return summary();
  };

  assert.equal(await preview({ Updated: 1, KeysChanged: 3, VisibleChanges: 0, KeptChoices: 0 }), '1 user will follow your defaults for 3 settings · 0 visible changes');
  answers.push({ Updated: 1, KeysChanged: 3, VisibleChanges: 0, KeptChoices: 0 });
  h.button('Apply').click();
  await h.settle();
  assert.equal(h.dialog().querySelector('.je-apply-run strong').textContent, '1 user now follows your defaults for 3 settings · 0 visible changes');
  assert.equal(await preview({ Updated: 2, KeysChanged: 107, VisibleChanges: 0, KeptChoices: 2 }),
    '2 users will follow your defaults for 107 settings in all · 0 visible changes · 2 users keep their own values for some settings');
  assert.equal(await preview({ Updated: 0, KeysChanged: 0, VisibleChanges: 0, KeptChoices: 1 }), 'Nothing to change: 1 user keeps their own value for some settings.');
  assert.equal(await preview({ Updated: 0, KeysChanged: 0, VisibleChanges: 0, KeptChoices: 0 }), 'Nothing to change.');
});

test('the upgrade card shows while some users still have copies, previews FollowIfUnchanged, and can be dismissed for good', async t => {
  const h = setup(t);
  await h.policy.decorate(h.page);
  await h.settle();
  assert.deepEqual(h.paths(), ['/registry', '/upgrade-card'], 'the card route counts; the page reads no overview for it');
  const cards = [...h.page.querySelectorAll('.je-upgrade-card')];
  assert.equal(cards.length, 2, 'one on Overview, one on Admin');
  assert.ok(cards[0].closest('#overview') && cards[1].closest('#admin'));
  for (const card of cards) {
    assert.equal(card.hidden, false);
    assert.match(card.querySelector('div > div').textContent, /^2 users still have copies of your defaults/);
  }

  [...cards[0].querySelectorAll('button')].find(b => b.textContent === 'Preview').click();
  await h.settle();
  const preview = h.requests.filter(r => r.path.endsWith('/apply')).at(-1).body;
  assert.equal(preview.Mode, 'FollowIfUnchanged');
  assert.equal(preview.DryRun, true);
  h.dialog().querySelector('.je-apply-buttons button:last-child').click(); // Close
  assert.equal(h.dialog(), null);

  [...cards[1].querySelectorAll('button')].find(b => b.textContent === 'Don\'t show again').click();
  await h.settle();
  assert.ok(h.requests.some(r => r.type === 'POST' && r.path.endsWith('/upgrade-card/dismiss')));
  assert.ok(cards.every(card => card.hidden));

  // Nothing left to adopt: no card.
  const none = setup(t, { overview: overviewFor({ adoptable: 0 }) });
  await none.policy.decorate(none.page);
  await none.settle();
  assert.ok([...none.page.querySelectorAll('.je-upgrade-card')].every(card => card.hidden));
});

test('a preview answered after the selection changed is dropped, and Apply sends only the selection shown', async t => {
  const gate = deferred();
  let held = true;
  const h = setup(t, {
    dismissed: true,
    apply: async (body) => {
      if (body.DryRun && held) { held = false; await gate.promise; }
      return applyAnswer(body);
    }
  });
  await h.policy.decorate(h.page);
  h.policy.openApplyDialog({ mode: 'FollowIfUnchanged' });
  await h.settle();
  h.button('Preview').click();
  await h.settle();
  // While the preview is in flight the admin picks Overwrite.
  h.dialog().querySelector('.je-apply-mode input[value="Overwrite"]').click();
  gate.resolve();
  await h.settle();
  const summary = h.dialog().querySelector('.je-apply-summary');
  assert.match(summary.textContent, /The selection changed: preview again/);
  assert.equal(h.button('Apply').disabled, true);
  h.button('Apply').click();
  await h.settle();
  assert.equal(h.requests.filter(r => r.path.endsWith('/apply') && !r.body.DryRun).length, 0);

  // A preview for what is shown can be applied; Apply re-checks the selection as well.
  h.button('Preview').click();
  await h.settle();
  assert.equal(h.button('Apply').disabled, false);
  const radio = h.dialog().querySelector('.je-apply-mode input[value="FollowAll"]');
  radio.checked = true; // changed without an event reaching the dialog
  h.button('Apply').click();
  await h.settle();
  assert.equal(h.requests.filter(r => r.path.endsWith('/apply') && !r.body.DryRun).length, 0);
  assert.match(summary.textContent, /The selection changed: preview again/);
  h.button('Preview').click();
  await h.settle();
  h.button('Apply').click();
  await h.settle();
  const run = h.requests.filter(r => r.path.endsWith('/apply') && !r.body.DryRun);
  assert.equal(run.length, 1);
  assert.equal(run[0].body.Mode, 'FollowAll');
});

test('a run whose undo record could not be saved says so, and an undo that left files pending can be retried', async t => {
  let undos = 0;
  let runs = 0;
  const h = setup(t, {
    dismissed: true,
    apply: body => applyAnswer(body, body.DryRun ? {} : ++runs === 1 ? { UndoId: null, UndoUnavailable: true } : {}),
    undo: () => (++undos === 1
      ? { success: true, Restored: 3, Kept: 0, FailedUsers: 1, Pending: true, PerUser: [] }
      : { success: true, Restored: 1, Kept: 0, FailedUsers: 0, Pending: false, PerUser: [] })
  });
  await h.policy.decorate(h.page);
  h.policy.openApplyDialog();
  await h.settle();
  h.button('Preview').click();
  await h.settle();
  const summary = h.dialog().querySelector('.je-apply-summary');
  assert.doesNotMatch(summary.textContent, /cannot be undone/);
  h.button('Apply').click();
  await h.settle();
  const runLines = () => [...h.dialog().querySelectorAll('.je-apply-run')];
  assert.match(runLines()[0].textContent, /These changes cannot be undone: the undo record could not be saved/);
  assert.equal(runLines()[0].querySelector('.je-apply-undo'), null);

  h.button('Preview').click();
  await h.settle();
  h.button('Apply').click();
  await h.settle();
  const second = runLines()[1];
  assert.doesNotMatch(second.textContent, /cannot be undone/);
  const button = second.querySelector('.je-apply-undo');
  button.click();
  await h.settle();
  assert.match(second.textContent, /1 user could not be restored \(see the server log\)\. Press Undo again to retry them\./);
  assert.equal(button.isConnected, true);
  assert.equal(button.disabled, false);
  button.click();
  await h.settle();
  assert.equal(undos, 2);
  assert.equal(button.isConnected, false);
});

test('a finished run keeps its Undo through a later preview, a selection change and closing and reopening the dialog', async t => {
  let runs = 0;
  const h = setup(t, {
    dismissed: true,
    apply: body => applyAnswer(body, body.DryRun ? {} : { UndoId: '2026101200000000' + (++runs) + '-abcdef12' })
  });
  await h.policy.decorate(h.page);
  h.policy.openApplyDialog({ mode: 'FollowAll' });
  await h.settle();
  const runLines = () => [...h.dialog().querySelectorAll('.je-apply-runs .je-apply-run')];
  assert.equal(h.dialog().querySelector('.je-apply-runs').hidden, true, 'no runs yet');
  h.button('Preview').click();
  await h.settle();
  h.button('Apply').click();
  await h.settle();
  assert.equal(runLines().length, 1);
  assert.equal(h.dialog().querySelector('.je-apply-runs').hidden, false);

  // A later preview and a selection change replace only the summary.
  h.button('Preview').click();
  await h.settle();
  assert.match(h.dialog().querySelector('.je-apply-summary').textContent, /will be updated|will follow/);
  h.dialog().querySelector('.je-apply-group summary input').click();
  assert.match(h.dialog().querySelector('.je-apply-summary').textContent, /The selection changed: preview again/);
  assert.equal(runLines().length, 1);
  assert.ok(runLines()[0].querySelector('.je-apply-undo'));

  // A second run adds its own line; closing and reopening keeps both Undo buttons.
  h.button('Preview').click();
  await h.settle();
  h.button('Apply').click();
  await h.settle();
  assert.equal(runLines().length, 2);
  h.button('Close').click();
  assert.equal(h.dialog(), null);
  h.policy.openApplyDialog();
  await h.settle();
  assert.equal(runLines().length, 2);
  assert.equal(h.dialog().querySelector('.je-apply-summary').textContent, '', 'the new dialog starts without a preview');
  runLines()[0].querySelector('.je-apply-undo').click();
  await h.settle();
  assert.ok(h.requests.some(r => r.path.endsWith('/undo/20261012000000001-abcdef12')), 'the first run is undone');
  assert.match(runLines()[0].textContent, /Undone: 40 restored/);
  assert.ok(runLines()[1].querySelector('.je-apply-undo'), 'the second run keeps its Undo');

  // Another page (the admin page rendered again from scratch) starts without runs.
  const fresh = h.page.cloneNode(true);
  h.page.replaceWith(fresh);
  fresh.querySelectorAll('.je-apply-backdrop').forEach(element => element.remove());
  await h.policy.decorate(fresh);
  h.policy.openApplyDialog();
  await h.settle();
  assert.equal(runLines().length, 0);
});

test('the Quick Actions button opens the dialog; without the policy script it says so', async t => {
  assert.match(pageSource, /resetAllUserSettingsBtn\.addEventListener\('click', jeOpenApplyDefaults\)/);
  assert.doesNotMatch(pageSource, /reset-all-users-settings/, 'the page no longer overwrites everyone without a preview');
  const opener = /function jeOpenApplyDefaults\(\) \{[\s\S]*?\n        \}/.exec(pageSource)?.[0];
  assert.ok(opener);

  const h = setup(t, { dismissed: true });
  const alerts = [];
  h.window.Dashboard = { alert: options => alerts.push(options) };
  const open = h.window.eval(`(${opener})`);
  open();
  assert.equal(alerts.length, 1, 'policy not loaded yet');
  assert.equal(h.dialog(), null);
  await h.policy.decorate(h.page);
  open();
  assert.ok(h.dialog());
  assert.equal(alerts.length, 1);
});

test('a pending overview is shared, and a failed one is retried on the next open', async t => {
  const gate = deferred();
  let calls = 0;
  const h = setup(t, { dismissed: true });
  const original = h.window.ApiClient.ajax;
  h.window.ApiClient.ajax = async (request) => {
    if (request.url.endsWith('/overview')) {
      calls += 1;
      if (calls === 1) { await gate.promise; throw jsonResponse({}, 500); }
    }
    return original(request);
  };
  await h.policy.decorate(h.page);
  await h.openDetails(); // the counts request is still pending
  h.policy.openApplyDialog();
  await h.settle();
  assert.equal(calls, 1, 'the table and the dialog share one request');
  gate.resolve();
  await h.settle();
  assert.equal(calls, 1);
  assert.match(h.document.querySelector('#jeUserSettingsPolicyCountsStatus').textContent, /could not be loaded/);
  h.dialog().querySelector('.je-apply-buttons button:last-child').click();
  await h.openDetails();
  assert.equal(calls, 2);
  assert.equal(h.document.querySelector('#jePolicyRow-AutoPipEnabled td[data-count="Kept"]').textContent, '1');
});
