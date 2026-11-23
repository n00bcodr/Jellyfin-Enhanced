// Upstream 7762f8e1 (tests/frontend/features/features-admin-config-reclaimerr-audit.test.mjs), re-homed: the Reclaimerr card's
// User audit on the generated configuration page, over a mocked server that answers the audit as the plugin does. It checks
// what an administrator is shown for a trusted-proxy sign-in Reclaimerr refuses for everyone (upstream issue 1095: the users must
// not read as flagged for not being administrators) and for one it refuses for a single account. Here the page is
// client/src/admin/config (page/service-status.ts draws the audit) and its harness is helpers/admin-config-page.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootGenerated, settle } from '../../helpers/admin-config-page.mjs';

const REFUSED = 'Reclaimerr answered an account and a name no account can have the same way (HTTP 401: Not authenticated). It does that for every name while its trusted-proxy sign-in is off, so no user\'s Request permission was checked and Request removal fails for everyone, whatever their account.';

/** One user of the audit's answer, as the plugin gives it. */
const user = (name, account, extra = {}) => ({ jellyfinUsername: name, jellyfinUserId: name.toLowerCase(), admin: false, linked: true, reclaimerrUsername: account, issues: [], checked: true, ...extra });

/**
 * The configuration page with Reclaimerr on and the audit answering `audit`.
 * @param {import('node:test').TestContext} t
 * @param {object|Function} audit The body of GET JellyfinEnhanced/reclaimerr/user-audit, or a function that gives a promise of it.
 */
async function boot(t, audit) {
  const asked = [];
  const h = bootGenerated({
    saved: { ReclaimerrEnabled: true, LeavingSoonMaintainerrEnabled: false, ReclaimerrUrl: 'http://reclaimerr.test', ReclaimerrToken: 'rcl_token', ReclaimerrUserRequests: true },
    ajax: (request) => {
      if (request.url.includes('/admin/leaving-soon')) return { Configured: true, Maintainerr: true, Provider: 'reclaimerr', HomeRow: 'off', Items: 0, Dated: 0 };
      if (request.url.includes('/reclaimerr/user-audit')) { asked.push(request.type); return typeof audit === 'function' ? audit() : structuredClone(audit); }
      return undefined;
    },
  });
  t.after(() => h.close());
  await h.ready();
  h.show();
  await settle(h.window);
  /** Press Run Audit and wait for the result to be drawn. */
  const run = async () => {
    const button = h.document.getElementById('reclaimerrAuditBtn');
    assert.ok(button, 'the audit button is on the page');
    button.click();
    for (let i = 0; i < 200 && button.textContent !== 'Run Audit'; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(button.textContent, 'Run Audit', 'the audit finished');
    return h.document.getElementById('reclaimerrAuditResult');
  };
  return { ...h, asked, run };
}

/** The folded name lists of an audit result: each list's title, the names in it, and whether it is drawn as not checked. */
const lists = (out) => Array.from(out.querySelectorAll('details.je-audit-ok-section'), (d) => ({
  title: d.querySelector('summary').textContent,
  names: Array.from(d.querySelectorAll('li'), (li) => li.textContent),
  unchecked: d.querySelector('ul').classList.contains('je-audit-unchecked-names'),
}));

test('a sign-in Reclaimerr refuses for everyone is one Setup item: the users are listed as linked and not checked, the administrator apart, and nobody as OK', async (t) => {
  const h = await boot(t, {
    version: '0.6.16', requestsEnabled: true, issues: [REFUSED],
    users: [user('Alba', 'Alba_user', { checked: false }), user('server', 'server', { admin: true }), user('Teken', 'Teken', { checked: false })],
  });
  const out = await h.run();
  assert.deepEqual(h.asked, ['GET']);
  assert.equal(out.querySelector('.je-audit-summary-title').textContent, 'Audit complete (Reclaimerr 0.6.16), review the items below.');
  // Nobody was shown to be able to request: the administrator is not checked, so they are not counted as OK (issue 1095).
  assert.deepEqual(Array.from(out.querySelectorAll('.je-audit-summary-chips .je-audit-chip'), (c) => c.lastChild.textContent), ['1 setup', '2 not checked', '1 administrator(s)']);
  // Only the Setup card: no user has a card of their own for a setting on Reclaimerr.
  const cards = Array.from(out.querySelectorAll('.je-audit-card'));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].querySelector('.je-audit-card-user').lastChild.textContent, 'Setup');
  assert.deepEqual(Array.from(cards[0].querySelectorAll('li'), (li) => li.textContent), [REFUSED]);
  assert.deepEqual(lists(out), [
    { title: 'Show 2 linked user(s) whose Request permission was not checked (see Setup)', names: ['Alba → Alba_user', 'Teken → Teken'], unchecked: true },
    { title: 'Show 1 administrator(s), not checked: they mark with the API token', names: ['server → server'], unchecked: true },
  ]);
  // The Services tab's copy of the card shows the same.
  assert.deepEqual(lists(h.document.getElementById('reclaimerrAuditResult--mirror')), lists(out));
});

test('an account Reclaimerr refuses on its own gets its own card, and everyone else is checked', async (t) => {
  const refused = 'Reclaimerr\'s trusted-proxy sign-in refused the account gone_user (Trusted proxy user is not configured), so Request removal is refused for them.';
  const h = await boot(t, {
    version: '0.6.16', requestsEnabled: true, issues: [],
    users: [user('Gone', 'gone_user', { issues: [refused] }), user('server', null, { admin: true, linked: false }), user('Teken', 'Teken')],
  });
  const out = await h.run();
  assert.deepEqual(Array.from(out.querySelectorAll('.je-audit-summary-chips .je-audit-chip'), (c) => c.lastChild.textContent), ['1 with issues', '1 OK', '1 administrator(s)']);
  const cards = Array.from(out.querySelectorAll('.je-audit-card'));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].querySelector('.je-audit-card-user').lastChild.textContent, 'Gone → gone_user');
  assert.deepEqual(Array.from(cards[0].querySelectorAll('.je-audit-card-issues li'), (li) => li.textContent), [refused]);
  assert.deepEqual(lists(out), [
    { title: 'Show 1 user(s) with no issues', names: ['Teken → Teken'], unchecked: false },
    { title: 'Show 1 administrator(s), not checked: they mark with the API token', names: ['server'], unchecked: true },
  ]);
});

test('with every user set up the audit says so in one line, counting the administrators it did not check apart', async (t) => {
  const h = await boot(t, { version: '0.6.16', requestsEnabled: true, issues: [], users: [user('server', 'server', { admin: true }), user('Alba', 'Alba_user'), user('Teken', 'Teken')] });
  const out = await h.run();
  assert.equal(out.querySelector('.je-audit-summary-title').textContent, 'All 2 user(s) are set up; 1 administrator(s) not checked. Reclaimerr 0.6.16.');
  assert.equal(out.querySelector('.je-audit-summary-chips'), null);
  assert.equal(out.querySelectorAll('.je-audit-card, details').length, 0);
});

test('a clean audit without administrators, and one with nobody but administrators', async (t) => {
  const plain = await boot(t, { version: '0.6.16', requestsEnabled: true, issues: [], users: [user('Alba', 'Alba_user'), user('Teken', 'Teken')] });
  assert.equal((await plain.run()).querySelector('.je-audit-summary-title').textContent, 'All 2 user(s) are set up. Reclaimerr 0.6.16.');
  // Nobody was checked: an administrator without a Reclaimerr account is not "set up", there was nothing to check.
  const admins = await boot(t, { version: null, requestsEnabled: true, issues: [], users: [user('server', null, { admin: true, linked: false })] });
  assert.equal((await admins.run()).querySelector('.je-audit-summary-title').textContent, 'Nothing to check: all 1 user(s) are administrators.');
});

// Upstream checks a redrawn page by swapping the button; here the view is dropped (viewdestroy) while Reclaimerr is asked.
test('an answer that arrives after the page was dropped is not drawn', async (t) => {
  let answer;
  const h = await boot(t, () => new Promise((resolve) => { answer = resolve; }));
  const button = h.document.getElementById('reclaimerrAuditBtn');
  const out = h.document.getElementById('reclaimerrAuditResult');
  button.click();
  await settle(h.window);
  assert.equal(button.textContent, 'Running…');
  h.page().dispatchEvent(new h.window.Event('viewdestroy'));
  answer({ version: '0.6.16', requestsEnabled: true, issues: [REFUSED], users: [] });
  await settle(h.window);
  assert.equal(out.textContent, '');
  assert.equal(out.style.display, 'none');
});
