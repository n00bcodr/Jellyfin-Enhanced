// Requests & downloads, phase 3: the Approvals tab of the Requests page (#/requests?tab=approvals),
// rendered by the real modules from server answers: cards in the Manager shape, approve, decline
// with a reason chip or a note, approve with changes, bulk approve with per-item outcomes, the
// stuck filter, read-only cards, intent tokens (stale and other-user answers are dropped) and
// keyboard / TV focus across redraws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { jsRoot } from '../helpers/harness.mjs';
import { en, translate, deferred, until, setupHub } from '../helpers/arr-hub-extra.mjs';

const iso = hours => new Date(Date.now() - hours * 3600000).toISOString();
const id = n => String(n).padStart(32, 'a');
const card = (n, over = {}) => ({
  id: id(n), key: `movie:tmdb:${n}`, kind: 'movie', scope: 'movie', variant: 'standard', seasons: [], episodes: [], createdAt: iso(2),
  reason: 'awaiting_approval', overQuota: false, stuck: false, cost: 1, title: `Film ${n}`, year: 2026, poster: '/p.jpg',
  requester: { name: 'Leo', role: 'kid', quota: { used: 3, limit: 7, available: true } }, alsoWanted: [], canApprove: true, canSwitchVariant: false, ...over
});
const approvals = items => ({ status: 200, body: { outcome: 'accepted', reason: 'approvals', certainty: 'Succeeded', more: false, items } });

test('every key the household tabs use exists in en.json and every key is prefixed for its slice', () => {
  const source = ['hub-extra-core.js', 'hub-approvals.js', 'hub-household.js', 'hub-mine-ledger.js', 'hub-chipbar.js']
    .map(m => readFileSync(resolve(jsRoot, 'arr/hub', m), 'utf8')).join('\n');
  const keys = [...source.matchAll(/tr\('([a-z0-9_]+)'/g), ...source.matchAll(/'(arr_(?:approvals|household|mine|chipbar)_[a-z0-9_]+)'/g)].map(m => m[1]);
  assert.ok(keys.length > 80);
  for (const key of keys) assert.ok(key in en, key);
  for (const role of ['watcher', 'kid', 'member', 'manager', 'admin']) assert.ok(`arr_approvals_role_${role}` in en, role);
  for (const preset of ['ask_first', 'open_house', 'approve_everything']) {
    assert.ok(`arr_household_preset_${preset}` in en && `arr_household_preset_${preset}_help` in en, preset);
  }
  // Family words only: nothing names an arr, an instance, a profile, a folder or a path.
  const words = Object.entries(en).filter(([k]) => /^arr_(approvals|household|mine|chipbar)_/.test(k)).map(([, v]) => v).join(' ');
  assert.doesNotMatch(words, /Sonarr|Radarr|instance|profile|root folder|quality profile|\btags?\b|path/i);
});

test('a Manager gets the Approvals tab with a count; the deep link waits for the capabilities, then shows phone-first cards', async t => {
  const me = deferred();
  const h = setupHub(t, {
    hash: '#/requests?tab=approvals',
    routes: async (method, path) => {
      if (path === '/acquire/requests/me') return { status: 200, body: { me: await me.promise } };
      if (path === '/acquire/requests/approvals') {
        return approvals([
          card(1, { title: 'Toy Story 5', rating: { label: 'G', within: true }, alsoWanted: ['Emma'], estimateGb: 7.6, itemId: 'b'.repeat(32) }),
          card(2, { title: 'Andor', kind: 'tv', key: 'tv:tvdb:2', scope: 'seasons', seasons: [1, 2], requester: { name: 'Emma', role: 'member', quota: { used: 7, limit: 7, available: true } }, overQuota: true, reason: 'over_quota' }),
          card(3, { title: '<img src=x onerror=alert(1)>', scope: 'episodes', kind: 'tv', key: 'tv:tvdb:3', episodes: [{ season: 2, episode: 8 }], requester: { name: null, role: 'member', quota: { used: 0, limit: null, available: true } } })
        ]);
      }
      return null;
    }
  });
  h.JE.initializeArrStatus();
  await wait(10);
  const page = h.page();
  // The tab named in the URL waits for the capabilities instead of falling back to My requests.
  assert.equal(page.querySelector('.je-hub-empty').textContent, translate('arr_hub_loading'));
  assert.equal(h.calls('GET', '/acquire/requests/approvals').length, 0);
  me.resolve({ role: 'manager', contact: 'Dad' });
  await until(() => page.querySelectorAll('.je-approval').length === 3);
  assert.equal(h.window.location.hash, '#/requests?tab=approvals');
  assert.deepEqual([...page.querySelectorAll('.je-hub-tab')].map(b => b.dataset.tab), ['mine', 'approvals', 'household', 'soon', 'ready']);
  assert.equal(page.querySelector('.je-hub-tab[data-tab="approvals"]').getAttribute('aria-selected'), 'true');
  assert.equal(page.querySelector('.je-hub-tab[data-tab="approvals"] .je-hub-tab-count').textContent, '3');

  const [toy, andor, odd] = page.querySelectorAll('.je-approval');
  assert.equal(toy.querySelector('.je-approval-title').textContent, 'Toy Story 5 (2026)');
  assert.equal(toy.querySelector('.je-approval-meta').textContent, 'Leo · 2 h ago · Movie');
  assert.equal(toy.querySelector('.je-approval-role').textContent, 'Kid · 3 of 7 used');
  assert.equal(toy.querySelector('.je-approval-rating').textContent.replace('verified_user', ''), "G · within Leo's limit");
  assert.ok(toy.querySelector('.je-approval-rating .material-icons'), 'an icon, not colour alone');
  assert.equal(toy.querySelector('.je-approval-also').textContent.replace('group', ''), 'Also wanted by: Emma');
  assert.match(toy.querySelector('.je-approval-chip-estimate').textContent, /Est\. ~8 GB \(estimate\)$/);
  assert.equal(toy.querySelector('.je-approval-poster').getAttribute('src'), `/Items/${'b'.repeat(32)}/Images/Primary`);
  assert.equal(andor.querySelector('.je-approval-meta').textContent, 'Emma · 2 h ago · Seasons 1–2');
  assert.match(andor.querySelector('.je-approval-chip-quota').textContent, /Over quota$/);
  assert.equal(andor.querySelector('.je-approval-poster').getAttribute('src'), 'https://image.tmdb.org/t/p/w185/p.jpg');
  // A name the server doesn't give is "Someone in your household"; titles never become HTML.
  assert.equal(odd.querySelector('.je-approval-meta').textContent, 'Someone in your household · 2 h ago · S2E8');
  assert.equal(page.querySelectorAll('img[src="x"]').length, 0);
  assert.equal(odd.querySelector('.je-approval-title').textContent, '<img src=x onerror=alert(1)> (2026)');
  // Real buttons with labels.
  const approve = toy.querySelector('.je-approval-approve');
  assert.equal(approve.tagName, 'BUTTON');
  assert.equal(approve.getAttribute('aria-label'), 'Approve Toy Story 5 (2026)');
  assert.equal(toy.querySelector('.je-approval-decline').getAttribute('aria-expanded'), 'false');
  // It follows the shared request list on the feed.
  assert.ok(h.live().some(s => s.keys.includes('req:state')));
});

test('a card shows where the part asked for already is (on its way or here), and nothing more than "waiting" otherwise', async t => {
  const h = setupHub(t, {
    hash: '#/requests?tab=approvals',
    routes: (method, path) => (path === '/acquire/requests/approvals'
      ? approvals([
        card(1, { title: 'Firefly', kind: 'tv', key: 'tv:tvdb:1', scope: 'episodes', episodes: [{ season: 1, episode: 4 }],
          partStatus: { key: 'tv:tvdb:1', kind: 'series', stage: 'downloading', reason: { code: 'downloading' }, progress: { percent: 30 }, admin: { variants: [{ instance: 'Sonarr' }] } } }),
        card(2, { title: 'Bluey', partStatus: { key: 'movie:tmdb:2', kind: 'movie', stage: 'asked', reason: { code: 'awaiting_approval' } } })
      ])
      : null)
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelectorAll('.je-approval').length === 2);
  const [firefly, bluey] = page.querySelectorAll('.je-approval');
  const part = firefly.querySelector('.je-approval-part');
  assert.ok(part, 'a part already downloading shows its status');
  assert.match(part.textContent, /Downloading · 30%/);
  assert.doesNotMatch(part.textContent, /Sonarr/, 'no administrators\' lines on the card');
  assert.equal(bluey.querySelector('.je-approval-part'), null, 'waiting for an OK says nothing new');
});

test('members and kids get no Approvals or Household tab and never read them', async t => {
  const h = setupHub(t, { me: { role: 'member' }, routes: () => null });
  h.JE.initializeArrStatus();
  await until(() => h.calls('GET', '/acquire/requests/me').length > 0);
  await wait(20);
  assert.deepEqual([...h.page().querySelectorAll('.je-hub-tab')].map(b => b.dataset.tab), ['mine', 'soon', 'ready']);
  assert.equal(h.calls('GET', /approvals|household|attention/).length, 0);
});

test('Approve says how it went honestly, and administrators find the reason code of a refusal under Details', async t => {
  let items = [card(1), card(2)];
  const answers = { [id(1)]: { status: 200, body: { outcome: 'accepted', reason: 'queued_outage', certainty: 'Succeeded', requestId: id(1) } },
    [id(2)]: { status: 409, body: { outcome: 'denied', reason: 'request_changed', certainty: 'Rejected' } } };
  const h = setupHub(t, {
    hash: '#/requests?tab=approvals',
    me: { role: 'admin' },
    routes: (method, path) => {
      if (path === '/acquire/requests/approvals') return approvals(items);
      const m = /^\/acquire\/requests\/([a-z0-9]+)\/approve$/.exec(path);
      if (m && method === 'POST') {
        items = items.filter(i => i.id !== m[1] || answers[m[1]].status !== 200);
        return answers[m[1]];
      }
      return null;
    }
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelectorAll('.je-approval').length === 2);
  page.querySelector(`[data-je-focus="approve:${id(1)}"]`).click();
  await until(() => page.querySelectorAll('.je-approval').length === 1);
  assert.deepEqual(h.calls('POST', `/acquire/requests/${id(1)}/approve`).map(c => c.body), [{}]);
  assert.equal(page.querySelector('.je-approvals-banner').textContent, "Film 1 (2026): Approved. It's on its way.");
  assert.equal(page.querySelector('.je-approvals-banner').getAttribute('role'), 'status');

  page.querySelector(`[data-je-focus="approve:${id(2)}"]`).click();
  await until(() => page.querySelector('.je-approval-result')?.textContent.includes('changed'));
  assert.equal(page.querySelector('.je-approval-result').textContent, 'That changed while you looked. Showing the latest.');
  const details = page.querySelector('.je-approval details.je-approval-admin');
  assert.equal(details.querySelector('summary').textContent, 'Details');
  assert.equal(details.querySelector('.je-approval-admin-line').textContent, 'Last answer: request_changed');
  // The card stays (it was not approved) and the list was read again.
  assert.equal(page.querySelectorAll('.je-approval').length, 1);
  assert.ok(h.calls('GET', '/acquire/requests/approvals').length >= 3);
});

test('an approval of unknown outcome is never called done', async t => {
  const h = setupHub(t, {
    hash: '#/requests?tab=approvals',
    routes: (method, path) => {
      if (path === '/acquire/requests/approvals') return approvals([card(1)]);
      if (method === 'POST') return { status: 200, body: { outcome: 'accepted', reason: 'maybe_sent', certainty: 'Unknown' } };
      return null;
    }
  });
  h.JE.initializeArrStatus();
  await until(() => h.page().querySelector('.je-approval-approve'));
  h.page().querySelector('.je-approval-approve').click();
  await until(() => h.page().querySelector('.je-approval-result'));
  assert.equal(h.page().querySelector('.je-approval-result').textContent, translate('arr_approvals_result_unknown'));
  // The banner (the card may leave the list) says the same, never "on its way".
  const banner = h.page().querySelector('.je-approvals-banner');
  assert.equal(banner.textContent, `Film 1 (2026): ${translate('arr_approvals_result_unknown')}`);
  assert.ok(banner.classList.contains('je-approvals-tone-attention'));
});

test('Decline opens the reasons; a chip declines with its words, a note goes with it, and TV has no text field', async t => {
  const declines = [];
  const h = setupHub(t, {
    hash: '#/requests?tab=approvals',
    routes: (method, path, body) => {
      if (path === '/acquire/requests/approvals') return approvals([card(1), card(2)]);
      if (method === 'POST' && path.endsWith('/decline')) { declines.push([path, body]); return { status: 200, body: { outcome: 'accepted', reason: 'declined', certainty: 'Succeeded' } }; }
      return null;
    }
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelectorAll('.je-approval').length === 2);
  const decline = page.querySelector(`[data-je-focus="decline:${id(1)}"]`);
  decline.focus();
  decline.click();
  // The redraw keeps focus on the same button, now expanded.
  assert.equal(h.document.activeElement.dataset.jeFocus, `decline:${id(1)}`);
  assert.equal(h.document.activeElement.getAttribute('aria-expanded'), 'true');
  const reasons = [...page.querySelectorAll('.je-approval-reason')].map(b => b.textContent);
  assert.deepEqual(reasons, ['Not for kids', 'We have something similar', 'Too big right now', "Let's watch it together"]);
  const note = page.querySelector(`[data-je-focus="note:${id(1)}"]`);
  assert.equal(note.maxLength, 200);
  note.value = 'maybe at the weekend';
  note.dispatchEvent(new h.window.Event('input'));
  page.querySelector(`[data-je-focus="reason:${id(1)}:0"]`).click();
  await until(() => declines.length === 1);
  assert.deepEqual(declines[0], [`/acquire/requests/${id(1)}/decline`, { reason: 'Not for kids · maybe at the weekend' }]);

  // Declining without a reason still says something kind.
  page.querySelector(`[data-je-focus="decline:${id(2)}"]`).click();
  page.querySelector(`[data-je-focus="plain:${id(2)}"]`).click();
  await until(() => declines.length === 2);
  assert.deepEqual(declines[1][1], { reason: 'Not this time' });
  await until(() => page.querySelector('.je-approvals-banner'));
  assert.equal(page.querySelector('.je-approvals-banner').textContent, "Film 2 (2026): Declined. They'll see your reason.");
});

test('on TV the decline reasons are buttons only (no text field)', async t => {
  const h = setupHub(t, { hash: '#/requests?tab=approvals', layoutTv: true, routes: (m, path) => (path === '/acquire/requests/approvals' ? approvals([card(1)]) : null) });
  h.JE.initializeArrStatus();
  await until(() => h.page().querySelector('.je-approval-decline'));
  h.page().querySelector('.je-approval-decline').click();
  assert.equal(h.page().querySelectorAll('.je-approval-reasons input').length, 0);
  assert.equal(h.page().querySelectorAll('.je-approval-reason').length, 4);
  assert.ok([...h.page().querySelectorAll('.je-approval-reasons button')].every(b => b.type === 'button'));
});

test('Change and approve narrows seasons, switches to 4K only when the approver may, and needs at least one', async t => {
  const posts = [];
  const h = setupHub(t, {
    hash: '#/requests?tab=approvals',
    routes: (method, path, body) => {
      if (path === '/acquire/requests/approvals') {
        return approvals([
          card(1, { kind: 'tv', key: 'tv:tvdb:1', scope: 'seasons', seasons: [1, 2, 3], canSwitchVariant: true }),
          card(2, { canSwitchVariant: false }),
          card(3, { kind: 'tv', key: 'tv:tvdb:3', scope: 'episodes', episodes: [{ season: 1, episode: 4 }, { season: 1, episode: 7 }] })
        ]);
      }
      if (method === 'POST') { posts.push([path, body]); return { status: 200, body: { outcome: 'accepted', reason: 'queued_outage', certainty: 'Succeeded' } }; }
      return null;
    }
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelectorAll('.je-approval').length === 3);
  // A movie the approver can't switch has nothing to change.
  assert.equal(page.querySelector(`[data-je-focus="edit:${id(2)}"]`), null);
  page.querySelector(`[data-je-focus="edit:${id(1)}"]`).click();
  const sheet = () => page.querySelector(`[data-request-id="${id(1)}"] .je-approval-sheet`);
  assert.deepEqual([...sheet().querySelectorAll('legend')].map(l => l.textContent), ['Seasons', 'Quality']);
  for (const n of [1, 2, 3]) page.querySelector(`[data-je-focus="edit-season:${id(1)}:Season ${n}"]`).click();
  assert.equal(sheet().querySelector('.je-approval-result').textContent, 'Pick at least one.');
  assert.ok(page.querySelector(`[data-je-focus="edit-approve:${id(1)}"]`).disabled);
  page.querySelector(`[data-je-focus="edit-season:${id(1)}:Season 3"]`).click();
  page.querySelector(`[data-je-focus="edit-season:${id(1)}:Season 1"]`).click();
  page.querySelector(`[data-je-focus="edit-variant:${id(1)}:4k"]`).click();
  page.querySelector(`[data-je-focus="edit-approve:${id(1)}"]`).click();
  await until(() => posts.length === 1);
  assert.deepEqual(posts[0], [`/acquire/requests/${id(1)}/approve`, { input: { key: 'tv:tvdb:1', scope: 'seasons', variant: '4k', seasons: [1, 3], episodes: [] } }]);

  // Episodes narrow the same way (no quality switch for this approver).
  page.querySelector(`[data-je-focus="edit:${id(3)}"]`).click();
  const third = page.querySelector(`[data-request-id="${id(3)}"] .je-approval-sheet`);
  assert.deepEqual([...third.querySelectorAll('legend')].map(l => l.textContent), ['Episodes']);
  page.querySelector(`[data-je-focus="edit-episode:${id(3)}:S1E4"]`).click();
  page.querySelector(`[data-je-focus="edit-approve:${id(3)}"]`).click();
  await until(() => posts.length === 2);
  assert.deepEqual(posts[1][1].input.episodes, [{ season: 1, episode: 7 }]);
});

test('bulk approve sends the selected ids once; a 207 puts each card\'s own outcome on it and the failed one stays', async t => {
  let items = [card(1), card(2), card(3)];
  const bulk = [];
  const h = setupHub(t, {
    hash: '#/requests?tab=approvals',
    routes: (method, path, body) => {
      if (path === '/acquire/requests/approvals') return approvals(items);
      if (path === '/acquire/requests/bulk-approve') {
        bulk.push(body);
        items = items.filter(i => i.id !== id(1));
        return { status: 207, body: { outcome: 'accepted', reason: 'bulk_checked', certainty: 'Succeeded', items: [
          { outcome: 'accepted', reason: 'queued_outage', certainty: 'Succeeded', requestId: id(1) },
          { outcome: 'denied', reason: 'not_visible_to_user', certainty: 'Rejected' }
        ] } };
      }
      return null;
    }
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelectorAll('.je-approval').length === 3);
  page.querySelector('[data-je-focus="approvals:select"]').click();
  assert.equal(page.querySelector('[data-je-focus="approvals:select"]').getAttribute('aria-pressed'), 'true');
  assert.ok(page.querySelector('[data-je-focus="approvals:bulk"]').disabled);
  for (const n of [1, 2]) {
    const box = page.querySelector(`[data-je-focus="select:${id(n)}"]`);
    box.checked = true;
    box.dispatchEvent(new h.window.Event('change'));
  }
  assert.equal(page.querySelector('[data-je-focus="approvals:bulk"]').textContent, 'done_allApprove 2 selected');
  page.querySelector('[data-je-focus="approvals:bulk"]').click();
  await until(() => page.querySelectorAll('.je-approval').length === 2);
  assert.deepEqual(bulk, [{ ids: [id(1), id(2)] }]);
  assert.equal(page.querySelector('.je-approvals-banner').textContent, '1 approved · 1 not approved');
  const failed = page.querySelector(`[data-request-id="${id(2)}"] .je-approval-result`);
  assert.equal(failed.textContent, "You can't OK this one.");
  // Selection mode ends after the bulk action.
  assert.equal(page.querySelectorAll('.je-approval-check').length, 0);
});

test('bulk approve allows at most 20 at once', async t => {
  const many = Array.from({ length: 22 }, (_, i) => card(i + 1));
  const h = setupHub(t, { hash: '#/requests?tab=approvals', routes: (m, path) => (path === '/acquire/requests/approvals' ? approvals(many) : null) });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelectorAll('.je-approval').length === 22);
  page.querySelector('[data-je-focus="approvals:select"]').click();
  for (let n = 1; n <= 20; n++) {
    const box = page.querySelector(`[data-je-focus="select:${id(n)}"]`);
    box.checked = true;
    box.dispatchEvent(new h.window.Event('change'));
  }
  assert.ok(page.querySelector(`[data-je-focus="select:${id(21)}"]`).disabled);
  assert.equal(page.querySelector('.je-approvals-limit').textContent, 'You can approve up to 20 at once.');
  assert.equal(page.querySelector('[data-je-focus="approvals:bulk"]').disabled, false);
});

test('cards the approver can\'t act on are read-only, and ?show=stuck lists only the stuck ones', async t => {
  const h = setupHub(t, {
    hash: '#/requests?tab=approvals&show=stuck',
    me: { role: 'manager', contact: 'Jake' },
    routes: (m, path) => (path === '/acquire/requests/approvals'
      ? approvals([card(1, { stuck: true, reason: 'authorization_changed', canApprove: false }), card(2)])
      : null)
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelectorAll('.je-approval').length === 1);
  assert.equal(page.querySelector('.je-approvals-filter').textContent, 'Showing stuck requests');
  const stuck = page.querySelector('.je-approval');
  assert.match(stuck.querySelector('.je-approval-chip-stuck').textContent, /Stuck · needs a look$/);
  assert.equal(stuck.querySelector('.je-approval-readonly').textContent, 'Needs Jake to OK');
  assert.equal(stuck.querySelectorAll('button').length, 0);
  page.querySelector('[data-je-focus="approvals:all"]').click();
  await until(() => page.querySelectorAll('.je-approval').length === 2);
  assert.equal(h.window.location.hash, '#/requests?tab=approvals');
});

test('intent tokens: an older read answering last, or an answer for the previous user, is never shown', async t => {
  const reads = [];
  const h = setupHub(t, {
    hash: '#/requests?tab=approvals',
    routes: (m, path) => {
      if (path !== '/acquire/requests/approvals') return null;
      const d = deferred();
      reads.push(d);
      return d.promise;
    }
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => reads.length === 1);
  // A feed change starts a newer read while the first is still out.
  h.bump('req:state');
  await until(() => reads.length === 2);
  reads[1].resolve(approvals([card(2, { title: 'Newer' })]));
  await until(() => page.querySelector('.je-approval-title'));
  reads[0].resolve(approvals([card(1, { title: 'Older' })]));
  await wait(20);
  assert.deepEqual([...page.querySelectorAll('.je-approval-title')].map(e => e.textContent), ['Newer (2026)']);

  // Another read is out when the user changes: its answer belongs to the previous user. The tab
  // waits for the new user's capabilities, then reads for them.
  h.bump('req:state');
  await until(() => reads.length === 3);
  h.switchUser();
  await until(() => reads.length === 4);
  assert.equal(h.calls('GET', '/acquire/requests/me').length, 2);
  reads[2].resolve(approvals([card(3, { title: 'Previous user' })]));
  await wait(20);
  assert.ok(![...page.querySelectorAll('.je-approval-title')].some(e => e.textContent.startsWith('Previous user')));
  reads[3].resolve(approvals([card(4, { title: 'This user' })]));
  await until(() => page.querySelector('.je-approval-title')?.textContent === 'This user (2026)');

  // Leaving the tab drops the read under way; coming back reads again.
  h.page().querySelector('.je-hub-tab[data-tab="mine"]').click();
  h.page().querySelector('.je-hub-tab[data-tab="approvals"]').click();
  await until(() => reads.length === 5);
  reads[4].resolve(approvals([card(5, { title: 'Back again' })]));
  await until(() => page.querySelector('.je-approval-title')?.textContent === 'Back again (2026)');
});

test('keyboard and D-pad focus stays on the same control across a re-read, and moves to the next card when one leaves', async t => {
  let items = [card(1), card(2), card(3)];
  const h = setupHub(t, {
    hash: '#/requests?tab=approvals',
    routes: (method, path) => {
      if (path === '/acquire/requests/approvals') return approvals(items);
      if (method === 'POST') { items = items.filter(i => i.id !== id(2)); return { status: 200, body: { outcome: 'accepted', reason: 'queued_outage', certainty: 'Succeeded' } }; }
      return null;
    }
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelectorAll('.je-approval').length === 3);
  page.querySelector(`[data-je-focus="decline:${id(3)}"]`).focus();
  h.bump('req:state');
  await until(() => h.calls('GET', '/acquire/requests/approvals').length === 2);
  await wait(20);
  assert.equal(h.document.activeElement.dataset.jeFocus, `decline:${id(3)}`);
  const second = page.querySelector(`[data-je-focus="approve:${id(2)}"]`);
  second.focus();
  second.click();
  await until(() => page.querySelectorAll('.je-approval').length === 2);
  assert.ok(page.contains(h.document.activeElement));
  assert.match(h.document.activeElement.dataset.jeFocus, /^approve:/);
});

test('the tab count comes from the cheap counts route before the list is read', async t => {
  const h = setupHub(t, {
    routes: (m, path) => (path === '/acquire/requests/attention' ? { status: 200, body: { outcome: 'accepted', needOk: 4, stuck: 1 } } : null)
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelector('.je-hub-tab[data-tab="approvals"] .je-hub-tab-count'));
  assert.equal(page.querySelector('.je-hub-tab[data-tab="approvals"] .je-hub-tab-count').textContent, '4');
  assert.equal(h.calls('GET', '/acquire/requests/approvals').length, 0);
  assert.equal(h.calls('GET', '/acquire/requests/attention').length, 1);
});

test('cards say where the title would land (library and free space, never a path) and whether a 4K copy is here', async t => {
  for (const role of ['manager', 'admin']) {
    const h = setupHub(t, {
      hash: '#/requests?tab=approvals',
      me: { role, contact: 'Dad' },
      routes: async (method, path) => {
        if (path !== '/acquire/requests/approvals') return null;
        return approvals([
          card(1, { space: { library: 'Movies', freeGb: 1234.4 }, already4k: true, already4kIn: role === 'admin' ? 'Radarr 4K' : undefined }),
          card(2, { space: { library: null, freeGb: 512.6 } }),
          card(3)
        ]);
      }
    });
    h.JE.initializeArrStatus();
    await until(() => h.page().querySelectorAll('.je-approval').length === 3);
    const [one, two, three] = h.page().querySelectorAll('.je-approval');
    assert.equal(one.querySelector('.je-approval-space').textContent.replace('storage', ''), 'Movies drive: 1.2 TB free');
    assert.equal(one.querySelector('.je-approval-4k').textContent.replace(/^4k/, ''), role === 'admin' ? 'Already in Radarr 4K' : 'Already in 4K');
    assert.equal(two.querySelector('.je-approval-space').textContent.replace('storage', ''), '513 GB free where it would go');
    assert.equal(two.querySelector('.je-approval-4k'), null);
    assert.equal(three.querySelector('.je-approval-space'), null, 'nothing known: no line');
  }
});

test('a stuck card says why in plain words; the reason code is only in an administrator\'s Details', async t => {
  const items = [card(1, { stuck: true, reason: 'authorization_changed', admin: { reason: 'authorization_changed', jobs: [] } }),
    card(2, { stuck: true, reason: 'something_new', admin: { reason: 'something_new', jobs: [] } })];
  const h = setupHub(t, { hash: '#/requests?tab=approvals', me: { role: 'admin' }, routes: (m, path) => (path === '/acquire/requests/approvals' ? approvals(items) : null) });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelectorAll('.je-approval').length === 2);
  const [one, two] = page.querySelectorAll('.je-approval');
  assert.match(one.querySelector('.je-approval-chip-stuck').textContent, /Stuck · their access changed since the OK$/);
  assert.match(two.querySelector('.je-approval-chip-stuck').textContent, /Stuck · needs a look$/, 'an unknown code reads neutrally');
  for (const node of [one, two]) {
    const visible = [...node.childNodes].filter(n => !(n.matches && n.matches('details'))).map(n => n.textContent).join(' ');
    assert.doesNotMatch(visible, /authorization_changed|something_new/, 'no code on the card itself');
  }
  assert.equal(one.querySelector('details.je-approval-admin .je-approval-admin-line').textContent, 'Reason code: authorization_changed');

  const m = setupHub(t, { hash: '#/requests?tab=approvals', me: { role: 'manager', contact: 'Jake' }, routes: (x, path) => (path === '/acquire/requests/approvals' ? approvals([card(1, { stuck: true, reason: 'authorization_changed' })]) : null) });
  m.JE.initializeArrStatus();
  await until(() => m.page().querySelectorAll('.je-approval').length === 1);
  assert.match(m.page().querySelector('.je-approval-chip-stuck').textContent, /Stuck · needs a look$/);
  assert.equal(m.page().querySelector('details.je-approval-admin'), null, 'no Details for managers');
});

// ------------------------------------------------------------------ review round 2

test('an approve, decline or bulk answer that arrives after someone else signed in is dropped', async t => {
  const pending = [];
  let list = [card(1, { title: 'Adult film' }), card(2), card(3)];
  const h = setupHub(t, {
    hash: '#/requests?tab=approvals',
    me: { role: 'admin' },
    routes: (method, path) => {
      if (path === '/acquire/requests/approvals') return approvals(list);
      if (method === 'POST') {
        const d = deferred();
        pending.push({ path, d });
        return d.promise;
      }
      return null;
    }
  });
  h.JE.initializeArrStatus();
  const page = h.page();
  await until(() => page.querySelectorAll('.je-approval').length === 3);
  const S = h.JE.internals.arrHub.approvals.state;
  // Approve one, decline another and bulk-approve the third, all still out when the user changes.
  page.querySelector(`[data-je-focus="approve:${id(1)}"]`).click();
  page.querySelector(`[data-je-focus="decline:${id(2)}"]`).click();
  page.querySelector('.je-approval-reason').click();
  page.querySelector('[data-je-focus="approvals:select"]').click();
  const box = page.querySelector(`[data-je-focus="select:${id(3)}"]`);
  box.checked = true;
  box.dispatchEvent(new h.window.Event('change'));
  page.querySelector('[data-je-focus="approvals:bulk"]').click();
  await until(() => pending.length === 3);
  list = [card(4, { title: 'Theirs' })];
  h.switchUser();
  const ok = { status: 200, body: { outcome: 'accepted', reason: 'queued_outage', certainty: 'Succeeded', requestId: id(1) } };
  pending[0].d.resolve(ok);
  pending[1].d.resolve({ status: 200, body: { outcome: 'accepted', reason: 'declined', certainty: 'Succeeded' } });
  pending[2].d.resolve({ status: 207, body: { outcome: 'accepted', reason: 'bulk_checked', certainty: 'Succeeded', items: [ok.body] } });
  await until(() => page.querySelector('.je-approval-title')?.textContent === 'Theirs (2026)');
  await wait(30);
  assert.equal(S.banner, null, 'no banner with the previous person\'s title');
  assert.equal(S.results.size, 0, 'no outcomes on cards for the next person');
  assert.equal(S.busy.size, 0);
  assert.ok(!page.textContent.includes('Adult film'), 'the old title is not shown');
});

test('on a light theme the green and amber words of the cards take the darker shades (4.5:1 on white)', async t => {
  const h = setupHub(t, {
    hash: '#/requests?tab=approvals',
    routes: async (method, path) => (path === '/acquire/requests/approvals' ? approvals([card(1, { rating: { label: 'G', within: true } })]) : null)
  });
  h.load('arr/ask/ask-sheet-styles.js');
  h.document.body.style.color = 'rgb(20, 20, 20)';   // a light theme writes dark text
  h.JE.initializeArrStatus();
  await until(() => h.page()?.querySelectorAll('.je-approval').length === 1);
  const box = h.page().querySelector('.je-approvals');
  assert.ok(box.classList.contains('je-approvals-light'));
  assert.ok(box.querySelector('.je-approval-rating-ok'));
  const css = [...h.document.querySelectorAll('style')].map(s => s.textContent).join('\n');
  assert.match(css, /\.je-approvals-light \.je-approval-rating-ok, \.je-approvals-light \.je-approvals-tone-done \{ color: #1a7431; \}/);
  assert.match(css, /\.je-approvals-light \.je-approval-rating-warn, \.je-approvals-light \.je-approvals-tone-attention \{ color: #9a4d00; \}/);
  // The dark theme keeps the brighter ones.
  h.document.body.style.color = 'rgb(240, 240, 240)';
  h.bump('req:state');
  await wait(30);
  await until(() => h.page()?.querySelector('.je-approvals') && !h.page().querySelector('.je-approvals').classList.contains('je-approvals-light'));
  assert.equal(h.page().querySelector('.je-approvals').classList.contains('je-approvals-light'), false);
});
