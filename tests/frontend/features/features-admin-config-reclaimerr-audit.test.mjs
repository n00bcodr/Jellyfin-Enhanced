// The Reclaimerr card's User audit on the configuration page: the real page (configPage.html markup and script, jeAdmin.js,
// Configuration/admin/*.js) in one browser realm, over a mocked server that answers the audit as the plugin does. It checks
// what an administrator is shown for a trusted-proxy sign-in Reclaimerr refuses for everyone (issue 1095: the users must not
// read as flagged for not being administrators) and for one it refuses for a single account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createHarness, jsRoot } from '../helpers/harness.mjs';

const config = resolve(jsRoot, '../Configuration');
const html = readFileSync(join(config, 'configPage.html'), 'utf8');
const DEFAULTS = JSON.parse(readFileSync(resolve(jsRoot, '../../docs/advanced/config-flag-groups.json'), 'utf8')).defaults;
const PAGE_URL = 'http://jellyfin.test/web/index.html#/configurationpage?name=Jellyfin%20Enhanced';
const REFUSED = 'Reclaimerr answered an account and a name no account can have the same way (HTTP 401: Not authenticated). It does that for every name while its trusted-proxy sign-in is off, so no user\'s Request permission was checked and Request removal fails for everyone, whatever their account.';

/** One user of the audit's answer, as the plugin gives it. */
const user = (name, account, extra = {}) => ({ jellyfinUsername: name, jellyfinUserId: name.toLowerCase(), admin: false, linked: true, reclaimerrUsername: account, issues: [], checked: true, ...extra });

/**
 * Boot the configuration page with Reclaimerr on and the audit answering `audit`.
 * @param {import('node:test').TestContext} t
 * @param {object|Function} audit The body of GET JellyfinEnhanced/reclaimerr/user-audit, or a function that gives a promise of it.
 */
function boot(t, audit) {
  const server = structuredClone({ ...DEFAULTS, ReclaimerrEnabled: true, ReclaimerrUrl: 'http://reclaimerr.test', ReclaimerrToken: 'rcl_token', ReclaimerrUserRequests: true });
  const asked = [];
  const markup = html.slice(html.indexOf('<div class="page'), html.lastIndexOf('</body>'));
  const h = createHarness({
    html: markup,
    url: PAGE_URL,
    // The page's own fetches (branding status, the locale list): answered empty.
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    JE: { t: (key) => key, pluginConfig: {}, currentSettings: {} },
    apiClient: {
      getUrl: (path, query) => `http://jellyfin.test/${path.replace(/^\//, '')}${query ? `?${new URLSearchParams(query)}` : ''}`,
      getPluginConfiguration: async () => structuredClone(server),
      updatePluginConfiguration: async () => ({}),
      ajax: async (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith('/reclaimerr/user-audit')) { asked.push(request.type); return typeof audit === 'function' ? audit() : structuredClone(audit); }
        // Lists (plugins, users, libraries) come back empty; everything else as an empty object.
        return request.type === 'GET' || !request.type ? [] : {};
      },
      getJSON: async () => [],
      fetch: async () => ({}),
      serverAddress: () => 'http://jellyfin.test',
      getCurrentUser: async () => ({ Id: 'user-a', Policy: { IsAdministrator: true } }),
      getUsers: async () => [],
      getServerConfiguration: async () => ({}),
      getInstalledPlugins: async () => [],
      getPluginConfigurationPages: async () => [],
      getPlugins: async () => [],
    },
    globals: {
      jeCdnUrl: (p) => `http://jellyfin.test/JellyfinEnhanced/cdn/${p}`,
      Dashboard: { showLoadingMsg() {}, hideLoadingMsg() {}, processPluginConfigurationUpdateResult() {}, alert() {}, confirm() {}, navigate() {} },
    },
  });
  t.after(() => h.close());
  const { window, document } = h;
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = function () {};
  window.HTMLCanvasElement.prototype.getContext = () => ({ fillStyle: '#000000' });
  // The page's network-dependent diagnostics (no plugins, no Seerr) may log.
  h.allowConsoleError(/^\[JE\]/);
  // Scripts the page asks for (the Media Tags tab's) are not under test: report them as loaded.
  const append = document.head.appendChild.bind(document.head);
  document.head.appendChild = (node) => {
    const r = append(node);
    if (node.tagName === 'SCRIPT') window.setTimeout(() => { if (node.onload) node.onload(); }, 0);
    return r;
  };
  h.load('core/ui-kit.js');
  h.JE.escapeHtml = h.JE.core.ui.escapeHtml;
  // The configuration page: its engine, its section definitions, then its own script.
  window.eval(readFileSync(join(config, 'jeAdmin.js'), 'utf8'));
  for (const name of readdirSync(join(config, 'admin')).filter((f) => f.endsWith('.js')).sort()) window.eval(readFileSync(join(config, 'admin', name), 'utf8'));
  window.JEAdmin.confirm = async () => true;
  window.JEAdmin.alert = async () => {};
  const script = html.slice(html.indexOf('<script type="text/javascript">') + '<script type="text/javascript">'.length, html.lastIndexOf('</script>'));
  window.eval(script);
  const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => window.setTimeout(r, 0)); };
  /** Press Run Audit and wait for the result to be drawn. */
  const run = async () => {
    await settle();
    const button = document.getElementById('reclaimerrAuditBtn');
    assert.ok(button, 'the audit button is on the page');
    button.click();
    for (let i = 0; i < 200 && button.textContent !== 'Run Audit'; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(button.textContent, 'Run Audit', 'the audit finished');
    return document.getElementById('reclaimerrAuditResult');
  };
  return { ...h, asked, run, settle };
}

/** The folded name lists of an audit result: each list's title, the names in it, and whether it is drawn as not checked. */
const lists = (out) => Array.from(out.querySelectorAll('details.je-audit-ok-section'), (d) => ({
  title: d.querySelector('summary').textContent,
  names: Array.from(d.querySelectorAll('li'), (li) => li.textContent),
  unchecked: d.querySelector('ul').classList.contains('je-audit-unchecked-names'),
}));

test('a sign-in Reclaimerr refuses for everyone is one Setup item: the users are listed as linked and not checked, the administrator apart, and nobody as OK', async (t) => {
  const h = boot(t, {
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
});

test('an account Reclaimerr refuses on its own gets its own card, and everyone else is checked', async (t) => {
  const refused = 'Reclaimerr\'s trusted-proxy sign-in refused the account gone_user (Trusted proxy user is not configured), so Request removal is refused for them.';
  const h = boot(t, {
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
  const h = boot(t, { version: '0.6.16', requestsEnabled: true, issues: [], users: [user('server', 'server', { admin: true }), user('Alba', 'Alba_user'), user('Teken', 'Teken')] });
  const out = await h.run();
  assert.equal(out.querySelector('.je-audit-summary-title').textContent, 'All 2 user(s) are set up; 1 administrator(s) not checked. Reclaimerr 0.6.16.');
  assert.equal(out.querySelector('.je-audit-summary-chips'), null);
  assert.equal(out.querySelectorAll('.je-audit-card, details').length, 0);
});

test('a clean audit without administrators, and one with nobody but administrators', async (t) => {
  const plain = boot(t, { version: '0.6.16', requestsEnabled: true, issues: [], users: [user('Alba', 'Alba_user'), user('Teken', 'Teken')] });
  assert.equal((await plain.run()).querySelector('.je-audit-summary-title').textContent, 'All 2 user(s) are set up. Reclaimerr 0.6.16.');
  // Nobody was checked: an administrator without a Reclaimerr account is not "set up", there was nothing to check.
  const admins = boot(t, { version: null, requestsEnabled: true, issues: [], users: [user('server', null, { admin: true, linked: false })] });
  assert.equal((await admins.run()).querySelector('.je-audit-summary-title').textContent, 'Nothing to check: all 1 user(s) are administrators.');
});

test('an answer that arrives after the page was drawn again is not put into the new page', async (t) => {
  let answer;
  const h = boot(t, () => new Promise((resolve) => { answer = resolve; }));
  await h.settle();
  const button = h.document.getElementById('reclaimerrAuditBtn');
  const out = h.document.getElementById('reclaimerrAuditResult');
  button.click();
  await h.settle();
  assert.equal(button.textContent, 'Running…');
  // The page is taken down and drawn again while Reclaimerr is asked: a new button under the same id, and the same result box id.
  const fresh = button.cloneNode(true);
  fresh.textContent = 'Run Audit';
  fresh.disabled = false;
  button.replaceWith(fresh);
  answer({ version: '0.6.16', requestsEnabled: true, issues: [REFUSED], users: [] });
  await h.settle();
  assert.equal(out.textContent, '');
  assert.equal(out.style.display, 'none');
  assert.equal(fresh.textContent, 'Run Audit');
});
