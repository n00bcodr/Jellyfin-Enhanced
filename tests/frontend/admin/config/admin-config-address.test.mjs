// Upstream b0a8a963 on the generated configuration page: an icon on every setting the usage report carries (the list
// comes from GET usage/fields), and the page's address keeping the tab and card shown, so a reload or a shared link
// returns there. The page runs as the host runs it (bootGenerated): engine, sections, page script.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootGenerated, settle } from '../../helpers/admin-config-page.mjs';

const ICON_HREF = '#/configurationpage?name=Jellyfin%20Enhanced&tab=admin&card=usage-statistics';

const params = window => new URLSearchParams(window.location.hash.split('?')[1] || '');
const labelOf = (document, id) => document.getElementById(id).closest('label') || document.querySelector(`label[for="${id}"]`);
const tabButton = (document, id) => document.querySelector(`.jea-nav .jellyfin-tab-button[data-tab="${id}"]`);
const activeTab = document => document.querySelector('.jellyfin-tab-content.active')?.id ?? null;
/** The card(s) shown alone, by their legend. */
const focusedCards = document => [...document.querySelectorAll('.jellyfin-tab-content.active.jea-focused > fieldset.jea-focus > legend')]
  .map(legend => [...legend.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim());
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function reporting(names) {
  return request => (/\/JellyfinEnhanced\/usage\/fields$/.test(request.url) ? names : undefined);
}

test('settings the usage report carries get an icon that opens the Usage Statistics card, without changing the setting', async t => {
  const h = bootGenerated({ ajax: reporting(['ShowWatchProgress', 'IconStyle', 'NotASettingOnThisPage']) });
  t.after(h.close);
  await h.ready();
  const { document, window } = h;
  assert.equal(h.calls.ajax.filter(r => /\/JellyfinEnhanced\/usage\/fields$/.test(r.url)).length, 1, 'the list is read once');
  assert.equal(h.calls.ajax.find(r => /usage\/fields$/.test(r.url)).type, 'GET');

  const badges = [...document.querySelectorAll('.jea-analytics')];
  assert.deepEqual(badges.map(b => b.closest('label')).sort((a, b) => a.compareDocumentPosition(b) & 2 ? 1 : -1),
    [labelOf(document, 'showWatchProgress'), labelOf(document, 'iconStyle')], 'a toggle and a select, each once');
  for (const badge of badges) {
    assert.equal(badge.tagName, 'A');
    assert.equal(badge.getAttribute('href'), ICON_HREF);
    assert.equal(badge.textContent, 'insights');
    assert.equal(badge.getAttribute('title'), 'Shared in Analytics if opted in');
    assert.equal(badge.getAttribute('aria-label'), 'Shared in Analytics if opted in');
  }
  assert.equal(labelOf(document, 'showFileSizes').querySelector('.jea-analytics'), null, 'a setting the report does not carry has none');

  tabButton(document, 'display').click();
  await settle(window);
  const toggle = document.getElementById('showWatchProgress');
  const was = toggle.checked;
  labelOf(document, 'showWatchProgress').querySelector('.jea-analytics').click();
  await settle(window);
  assert.equal(toggle.checked, was, 'the setting beside the icon is not changed');
  assert.equal(activeTab(document), 'admin');
  assert.deepEqual(focusedCards(document), ['Usage Statistics']);
  assert.equal(params(window).get('tab'), 'admin');
  assert.equal(params(window).get('card'), 'usage-statistics');
});

test('no icon, and no error, when the list cannot be read or is not a list', async t => {
  for (const answer of [() => Promise.reject(new Error('offline')), () => ({}), () => null]) {
    const h = bootGenerated({ ajax: request => (/usage\/fields$/.test(request.url) ? answer() : undefined) });
    t.after(h.close);
    await h.ready();
    assert.equal(h.document.querySelectorAll('.jea-analytics').length, 0);
    assert.ok(h.document.querySelector('.jea-layout'), 'the page still starts');
    assert.deepEqual(h.logged.filter(line => /usage|analytics/i.test(line)), []);
  }
});

test('the address names the tab and the card shown, and loses the card when a whole tab is shown', async t => {
  const h = bootGenerated();
  t.after(h.close);
  await h.ready();
  const { document, window } = h;

  tabButton(document, 'seerr').click();
  await settle(window);
  assert.equal(params(window).get('name'), 'Jellyfin Enhanced');
  assert.equal(params(window).get('tab'), 'seerr');
  assert.equal(params(window).get('card'), null);
  assert.equal(params(window).get('jeSection'), null);

  const leaves = [...tabButton(document, 'seerr').nextElementSibling.querySelectorAll(':scope > .jea-nav-leaf')];
  assert.ok(leaves.length >= 2);
  leaves[1].click();
  await settle(window);
  assert.deepEqual(focusedCards(document), [leaves[1].textContent.trim()]);
  assert.equal(params(window).get('card'), slug(leaves[1].textContent));
  assert.equal(params(window).get('tab'), 'seerr');

  // A group inside a card: the address names that card.
  const sub = [...document.querySelectorAll('.jea-nav-subtree')].find(s => s.closest('.jea-nav-tree') === tabButton(document, 'seerr').nextElementSibling)
    ?? document.querySelector('.jea-nav-subtree');
  const subButton = sub.closest('.jea-nav-tree').previousElementSibling;
  subButton.click();
  await settle(window);
  sub.querySelector('.jea-nav-leaf').click();
  await settle(window);
  assert.equal(params(window).get('tab'), subButton.dataset.tab);
  assert.equal(params(window).get('card'), slug(sub.previousElementSibling.textContent));

  tabButton(document, 'display').click();
  await settle(window);
  assert.equal(params(window).get('tab'), 'display');
  assert.equal(params(window).get('card'), null);
  assert.deepEqual(focusedCards(document), []);
});

test('an address with a tab and a card opens that card, also when the session kept another tab', async t => {
  for (const session of [{}, { jellyfinEnhancedActiveTab: 'display' }]) {
    const h = bootGenerated({ hash: '#/configurationpage?name=Jellyfin%20Enhanced&tab=admin&card=usage-statistics', session });
    t.after(h.close);
    await h.ready();
    assert.equal(activeTab(h.document), 'admin', JSON.stringify(session));
    assert.deepEqual(focusedCards(h.document), ['Usage Statistics'], JSON.stringify(session));
    assert.equal(params(h.window).get('tab'), 'admin');
    assert.equal(params(h.window).get('card'), 'usage-statistics');
  }
  // A card is looked for on the tab the address names only.
  const other = bootGenerated({ hash: '#/configurationpage?name=Jellyfin%20Enhanced&tab=display&card=usage-statistics' });
  t.after(other.close);
  await other.ready();
  assert.equal(activeTab(other.document), 'display');
  assert.deepEqual(focusedCards(other.document), []);
});

test('a link to a setting opens its tab, not the tab the session kept', async t => {
  const h = bootGenerated({ hash: '#/configurationpage?name=Jellyfin%20Enhanced&jeSection=TMDB_API_KEY', session: { jellyfinEnhancedActiveTab: 'display' } });
  t.after(h.close);
  await h.ready();
  const holder = h.document.getElementById('TMDB_API_KEY').closest('.jellyfin-tab-content').id;
  assert.notEqual(holder, 'display');
  assert.equal(activeTab(h.document), holder);
  assert.equal(params(h.window).get('tab'), holder, 'the address now names the tab shown');
});
