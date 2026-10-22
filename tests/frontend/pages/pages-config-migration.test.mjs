import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness } from '../helpers/harness.mjs';
import { repositoryRoot } from '../helpers/discovery.mjs';
// Stage 1 fix round 12: the fragments' writes go through the page's own origin contract (jeAdminSend and the rest).
import { adminOriginSource } from '../helpers/config-page.mjs';

// The configuration page's "Move requests from Seerr" panel (Requests & downloads, phase 3): run its real
// helpers in a fresh realm against a scripted admin API.
const page = readFileSync(resolve(repositoryRoot, 'Jellyfin.Plugin.JellyfinEnhanced/Configuration/configPage.html'), 'utf8');
function block(start, end) {
  const from = page.indexOf(start);
  const to = page.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`config page block not found: ${start}`);
  return page.slice(from, to);
}
const createEl = block('        function createEl(tag, attrs, children) {', '        // ==================== Stored credentials');
const helpers = block('        // ==================== Move requests from Seerr', '        /** Reconstructs a Sonarr/Radarr');
const plain = value => JSON.parse(JSON.stringify(value));

const preview = (over = {}) => ({
  outcome: 'accepted', reason: 'preview', message: 'Nothing has changed yet.', backend: 'seerr', complete: true, total: 15, digest: 'd1',
  pending: 2, processing: 13, skipped: { declined: 1, unmapped_user: 0, 'x<b>': 2 }, seerrRequesting: 'disabled', requestingUsers: 0, seerrAdmins: 1,
  defaultAllowsRequests: false, ...over,
});

function setup(t, { confirm = true, respond }) {
  const requests = [];
  const h = createHarness({
    html: '<select id="arrRequestBackend"><option value="seerr">Seerr</option><option value="je">JE</option></select><div id="arrSeerrMigrationResult"></div>',
    apiClient: { ajax: async options => { requests.push(plain({ type: options.type, url: options.url, data: options.data })); return respond(options); } },
  });
  h.window.confirm = message => { requests.push({ confirm: message }); return confirm; };
  t.after(() => h.close());
  h.window.eval(`${adminOriginSource()}
${createEl}\n${helpers}\nwindow.__je = { jeArrMigrationCheck, jeArrMigrationRollback };`);
  return { ...h, je: h.window.__je, requests, out: () => h.document.getElementById('arrSeerrMigrationResult'), backend: () => h.document.getElementById('arrRequestBackend').value };
}

const settle = () => new Promise(r => setTimeout(r, 0));

test('a complete check with requesting off offers the move; the move switches the page to JE and offers a rollback', async t => {
  let moved = false;
  const batch = { id: 'b1', createdAt: '2026-10-14T12:00:00Z', imported: 15, state: 'committed', rollbackUntil: '2026-10-28T12:00:00Z', canRollBack: true };
  const h = setup(t, { respond: async o => {
    if (o.url.endsWith('/acquire/migration/seerr')) return { backend: moved ? 'je' : 'seerr', batches: moved ? [batch] : [] };
    if (o.url.endsWith('/preview')) return moved ? preview({ backend: 'je', pending: 0, processing: 0, skipped: { already_imported: 15 } }) : preview();
    if (o.url.endsWith('/commit')) { moved = true; return { backend: 'je', imported: 15, batchId: 'b1', message: 'Requests moved; request handling is now Jellyfin Enhanced.' }; }
    if (o.url.endsWith('/rollback')) { moved = false; return { backend: 'seerr', removed: 14, kept: 1, message: 'Moved requests removed, except those changed in Jellyfin Enhanced since; request handling is back to Seerr.' }; }
    throw { status: 500 };
  } });
  await h.je.jeArrMigrationCheck();
  const text = h.out().textContent;
  assert.match(text, /Seerr holds 15 request\(s\): 2 waiting for an OK and 13 in progress can be moved\./);
  assert.match(text, /Left out: 1 declined, 2 x<b>\./);
  assert.equal(h.out().querySelector('b'), null);                 // text, never markup
  assert.match(text, /✓ Requesting is off in Seerr \(Seerr administrators can still ask there/);
  const move = h.document.getElementById('arrSeerrMigrationMove');
  assert.equal(move.textContent, 'Move 15 request(s) and switch to Jellyfin Enhanced');
  assert.equal(move.disabled, false);
  move.click(); for (let i = 0; i < 6; i++) await settle();
  const commit = h.requests.find(r => r.url && r.url.endsWith('/commit'));
  assert.deepEqual(JSON.parse(commit.data), { digest: 'd1', confirmRequestsDisabled: false });
  assert.equal(h.backend(), 'je');                                  // a later Save keeps the switch
  // The panel is checked again: the outcome first, the move with its Roll back button, nothing left to move.
  const after = h.out().textContent;
  assert.match(after, /^✓ Requests moved; request handling is now Jellyfin Enhanced \(15 moved\)\./);
  assert.match(after, /Nothing new to move; request handling is already Jellyfin Enhanced\./);
  assert.equal(h.document.getElementById('arrSeerrMigrationMove'), null);   // no second move
  const back = [...h.out().querySelectorAll('button')].find(b => b.textContent.startsWith('Roll back (until '));
  back.click(); for (let i = 0; i < 6; i++) await settle();
  assert.deepEqual(JSON.parse(h.requests.find(r => r.url && r.url.endsWith('/rollback')).data), { batchId: 'b1' });
  assert.equal(h.backend(), 'seerr');
  assert.match(h.out().textContent, /^✓ Moved requests removed, except those changed in Jellyfin Enhanced since; request handling is back to Seerr \(14 removed, 1 kept\)\./);
  assert.ok(h.document.getElementById('arrSeerrMigrationMove'));     // checked again: movable again
});

test('waiting asks from Watchers are called out', async t => {
  const h = setup(t, { respond: async o => o.url.endsWith('/preview') ? preview({ pendingWithoutRole: 2 }) : { batches: [] } });
  await h.je.jeArrMigrationCheck();
  assert.match(h.out().textContent, /2 of the waiting requests are from people whose household role \(Watcher\) can't ask in Jellyfin Enhanced/);
});

test('requesting still on in Seerr stops at the check; an unreadable list says nothing can be moved', async t => {
  const on = setup(t, { respond: async o => o.url.endsWith('/preview') ? preview({ seerrRequesting: 'enabled', requestingUsers: 3, defaultAllowsRequests: true }) : { batches: [] } });
  await on.je.jeArrMigrationCheck();
  assert.match(on.out().textContent, /✗ 3 Seerr user\(s\) can still ask, and new users would get the request permission\. Remove the request permissions in Seerr, then check again\./);
  assert.equal(on.document.getElementById('arrSeerrMigrationMove'), null);
  const partial = setup(t, { respond: async o => o.url.endsWith('/preview') ? preview({ complete: false, incompleteReason: 'total_changed', digest: null }) : { batches: [] } });
  await partial.je.jeArrMigrationCheck();
  assert.match(partial.out().textContent, /could not be read completely \(total_changed\)\. Nothing can be moved yet/);
  assert.equal(partial.document.getElementById('arrSeerrMigrationMove'), null);
});

test('when Seerr\'s permissions can\'t be checked the move needs the confirmation, which is sent', async t => {
  const h = setup(t, { respond: async o => {
    if (o.url.endsWith('/preview')) return preview({ seerrRequesting: 'unknown' });
    if (o.url.endsWith('/commit')) return { backend: 'je', imported: 15, batchId: null, message: 'Requests moved.' };
    return { batches: [] };
  } });
  await h.je.jeArrMigrationCheck();
  const move = h.document.getElementById('arrSeerrMigrationMove');
  const box = h.document.getElementById('arrSeerrMigrationConfirm');
  assert.equal(move.disabled, true);
  box.checked = true; box.dispatchEvent(new h.window.Event('change'));
  assert.equal(move.disabled, false);
  move.click(); await settle(); await settle();
  assert.equal(JSON.parse(h.requests.find(r => r.url && r.url.endsWith('/commit')).data).confirmRequestsDisabled, true);
  for (let i = 0; i < 4; i++) await settle();
  assert.match(h.out().textContent, /^✓ Requests moved \(15 moved\)\./);
});

test('a refused move shows the server\'s reason and nothing changes; declining the confirm sends nothing', async t => {
  const refused = { status: 409, json: async () => ({ outcome: 'denied', reason: 'seerr_changed', message: 'Seerr\'s requests changed since the check; check again.' }) };
  const h = setup(t, { respond: async o => {
    if (o.url.endsWith('/preview')) return preview();
    if (o.url.endsWith('/commit')) throw refused;
    return { batches: [] };
  } });
  await h.je.jeArrMigrationCheck();
  const move = h.document.getElementById('arrSeerrMigrationMove');
  move.click(); await settle(); await settle();
  assert.match(h.out().textContent, /✗ Seerr's requests changed since the check; check again\. Nothing was moved\./);
  assert.equal(move.disabled, false);
  assert.equal(h.backend(), 'seerr');

  const no = setup(t, { confirm: false, respond: async o => o.url.endsWith('/preview') ? preview() : { batches: [] } });
  await no.je.jeArrMigrationCheck();
  no.document.getElementById('arrSeerrMigrationMove').click(); await settle();
  assert.equal(no.requests.filter(r => r.url && r.url.endsWith('/commit')).length, 0);
});

test('earlier moves are listed with a rollback button only inside their window; a 403 explains who may move', async t => {
  const batches = [
    { id: 'b2', createdAt: '2026-10-14T12:00:00Z', imported: 4, state: 'committed', rollbackUntil: '2026-10-28T12:00:00Z', canRollBack: true, returnsTo: 'seerr' },
    { id: 'b1', createdAt: '2026-09-01T12:00:00Z', imported: 9, state: 'rolled_back', rollbackUntil: '2026-09-15T12:00:00Z', canRollBack: false, removed: 8, kept: 1, returnsTo: 'seerr' },
  ];
  const h = setup(t, { respond: async o => {
    if (o.url.endsWith('/acquire/migration/seerr')) return { backend: 'je', batches };
    if (o.url.endsWith('/preview')) throw { status: 403 };
    if (o.url.endsWith('/rollback')) return { backend: 'seerr', removed: 4, kept: 0, message: 'Moved requests removed; request handling is back to Seerr.' };
    throw { status: 500 };
  } });
  await h.je.jeArrMigrationCheck();
  const rows = h.out().querySelectorAll('.je-arr-migration-batch');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Moved 4 request\(s\) on /);
  assert.match(rows[1].textContent, /rolled back \(8 removed, 1 kept\)/);
  assert.equal(rows[1].querySelector('button'), null);
  assert.match(h.out().textContent, /✗ Only administrators can move requests/);
  rows[0].querySelector('button').click(); for (let i = 0; i < 6; i++) await settle();
  assert.deepEqual(JSON.parse(h.requests.find(r => r.url && r.url.endsWith('/rollback')).data), { batchId: 'b2' });
  assert.match(h.requests.find(r => r.confirm).confirm, /request handling goes back to Seerr\.$/);
  assert.equal(h.backend(), 'seerr');
  assert.match(h.out().textContent, /^✓ Moved requests removed; request handling is back to Seerr \(4 removed, 0 kept\)\./);
});

test('rolling back a later move made while JE already handled requests says request handling stays JE', async t => {
  const batches = [
    { id: 'b3', createdAt: '2026-10-15T12:00:00Z', imported: 1, state: 'committed', rollbackUntil: '2026-10-29T12:00:00Z', canRollBack: true, returnsTo: 'je' },
    { id: 'b2', createdAt: '2026-10-14T12:00:00Z', imported: 4, state: 'committed', rollbackUntil: '2026-10-28T12:00:00Z', canRollBack: false, returnsTo: 'seerr' },
  ];
  const h = setup(t, { respond: async o => {
    if (o.url.endsWith('/acquire/migration/seerr')) return { backend: 'je', batches };
    if (o.url.endsWith('/preview')) return preview({ backend: 'je' });
    if (o.url.endsWith('/rollback')) return { backend: 'je', removed: 1, kept: 0, message: 'Moved requests removed; request handling stays Jellyfin Enhanced.' };
    throw { status: 500 };
  } });
  h.document.getElementById('arrRequestBackend').value = 'je';
  await h.je.jeArrMigrationCheck();
  assert.equal(h.document.getElementById('arrSeerrMigrationMove').textContent, 'Move 15 request(s)');   // already JE: no switch
  const rows = h.out().querySelectorAll('.je-arr-migration-batch');
  assert.equal(rows[1].querySelector('button'), null);   // the earlier move waits for the later one
  rows[0].querySelector('button').click(); for (let i = 0; i < 6; i++) await settle();
  assert.match(h.requests.find(r => r.confirm).confirm, /removed from Jellyfin Enhanced, and request handling stays Jellyfin Enhanced\.$/);
  assert.deepEqual(JSON.parse(h.requests.find(r => r.url && r.url.endsWith('/rollback')).data), { batchId: 'b3' });
  assert.equal(h.backend(), 'je');
  assert.match(h.out().textContent, /^✓ Moved requests removed; request handling stays Jellyfin Enhanced \(1 removed, 0 kept\)\./);
});
