// Theme selector, plugin icons and plugin revisions (preferences/dashboard chrome).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';
import { chromeJs, fakeClock, until } from './helpers.mjs';

function theme(t) {
  const clock = fakeClock();
  let user = 'user-a';
  const h = createHarness({ html: '<section class="verticalSection"><span class="headerUsername">User</span><a class="lnkUserProfile"></a></section>',
    apiClient: { getCurrentUserId: () => user }, globals: clock.globals,
    JE: { cdn: { url: (source, path) => `/JellyfinEnhanced/cdn/${source}/${path}` } } });
  t.after(() => h.close());
  h.load(chromeJs('extras/theme-selector.js'));
  return { ...h, clock, signIn(next) { user = next; } };
}
const changeBody = h => h.document.body.appendChild(h.document.createElement('i'));

test('theme selector: native-body fallback mounts once and the post-reload notice is shown', async t => {
  const h = theme(t);
  h.window.sessionStorage.setItem('jellyfin-theme-applied', 'Ocean');
  const alerts = []; h.window.Dashboard = { alert: message => alerts.push(message) };
  h.JE.initializeThemeSelector();
  changeBody(h); await h.clock.advance(100);
  changeBody(h); await h.clock.advance(100);
  assert.equal(h.document.querySelectorAll('#jellyfin-theme-selector').length, 1);
  await h.clock.advance(1000);
  assert.deepEqual(alerts, ['Theme applied: Ocean']);
  assert.equal(h.window.sessionStorage.getItem('jellyfin-theme-applied'), null);
});

// CHR-THEME-1: a retained preferences view built for one account cannot write another account's theme.
test('CHR-THEME-1 theme selector: after an account switch the old control neither writes nor reloads', async t => {
  const h = theme(t);
  h.JE.initializeThemeSelector();
  changeBody(h); await h.clock.advance(100);
  const select = h.document.querySelector('#theme-selector-select');
  h.signIn('user-b');
  select.value = 'Forest';
  select.dispatchEvent(new h.window.Event('change'));
  assert.equal(h.window.localStorage.getItem('user-a-customCss'), null, 'previous account untouched');
  assert.equal(h.window.localStorage.getItem('user-b-customCss'), null, 'new account not adopted silently');
  assert.equal(h.window.sessionStorage.getItem('jellyfin-theme-applied'), null);
  assert.equal(select.disabled, false);
  await h.clock.advance(100);
  const fresh = h.document.querySelector('#jellyfin-theme-selector');
  assert.ok(fresh && fresh.querySelector('select') !== select, 'selector rebuilt for the signed-in account');
  assert.equal(fresh.dataset.jeThemeUser, 'user-b');
});

function icons(t, { html, config = async () => ({ CustomPluginLinks: 'Alpha|star' }), session } = {}) {
  const clock = fakeClock();
  let server = 'server-a';
  const calls = [];
  const h = createHarness({ html: html ?? `<ul aria-labelledby="plugins-subheader">
      <a href="#/configurationpage?name=Jellyfin%20Enhanced"><div class="MuiListItemIcon-root"><svg></svg></div></a>
      <a href="#/configurationpage?name=Intro%20Skipper"><div class="MuiListItemIcon-root"><span class="material-icons">folder</span></div></a>
    </ul>`, globals: clock.globals,
    apiClient: { serverId: () => server, getPluginConfiguration: id => { calls.push([server, id]); return config(server); } },
    JE: { cdn: { url: (source, path) => `/cdn/${source}/${path}` }, ...(session ? { session } : {}),
      core: { lifecycle: { register: () => ({ track: r => r, teardown() {} }) }, navigation: { onNavigate: () => () => {} } },
      helpers: { onBodyMutation: (id, callback) => { const mo = new h.window.MutationObserver(callback); mo.observe(h.document.body, { childList: true, subtree: true }); return { unsubscribe: () => mo.disconnect() }; } } } });
  t.after(() => { h.JE.stopPluginIconsMonitoring?.(); h.close(); });
  h.document.body.classList.add('dashboardDocument');
  h.load(chromeJs('extras/plugin-icons.js'));
  return { ...h, clock, calls, switchServer(next) { server = next; },
    link: name => [...h.document.querySelectorAll('[data-jellyfin-enhanced-plugin-id]')].find(a => a.querySelector('.MuiListItemText-primary')?.textContent === name) };
}

test('plugin icons: built-in icons are replaced once and custom links point at configuration pages', async t => {
  const h = icons(t);
  await h.JE.initializePluginIcons(); await h.clock.advance(1000);
  const img = h.document.querySelector('a[href*="Jellyfin%20Enhanced"] img.plugin-custom-icon-img');
  assert.equal(img.getAttribute('src'), '/cdn/jellyfish/logos/favicon.ico');
  assert.equal(h.document.querySelector('a[href*="Intro%20Skipper"] .plugin-material-icon').textContent, 'redo');
  assert.match(h.link('Alpha').href, /#\/configurationpage\?name=Alpha$/);
  assert.equal(h.document.querySelectorAll('.plugin-custom-icon-img, .plugin-material-icon').length, 3);
  await h.clock.advance(1000);
  assert.equal(h.calls.length, 1, 'configuration cached for the same server');
  assert.equal(h.document.querySelectorAll('[data-jellyfin-enhanced-plugin-id]').length, 1);
});

// CHR-ICONS-1: unchanged test links were removed and re-added each pass, re-triggering the observer forever.
test('CHR-ICONS-1 plugin icons: configuration-page test links settle instead of churning every 100 ms', async t => {
  const h = icons(t);
  h.window.testCustomPluginLinks = [{ name: 'Preview', icon: 'bolt' }];
  await h.JE.initializePluginIcons(); await h.clock.advance(500);
  const first = h.link('Preview');
  assert.ok(first);
  // Any later dashboard mutation (here: an unrelated body child) starts a pass.
  h.document.body.appendChild(h.document.createElement('div'));
  await h.clock.advance(2000);
  assert.equal(h.link('Preview'), first, 'the same element remains; no remove/re-add loop');
  assert.equal(h.clock.pending, 0, 'no perpetual debounce timer');
  h.window.testCustomPluginLinks = [{ name: 'Preview', icon: 'star' }];
  h.JE.customPlugins.refresh(); await h.clock.advance(200);
  assert.equal(h.link('Preview').querySelector('.plugin-material-icon').textContent, 'star', 'a changed preview is still replaced');
});

// CHR-ICONS-2: CustomPluginLinks is server configuration; a server switch must not reuse the previous server's links.
test('CHR-ICONS-2 plugin icons: custom links are re-read after a server switch and stale replies are dropped', async t => {
  const pending = deferred();
  const h = icons(t, { config: async server => server === 'server-a' ? { CustomPluginLinks: 'Alpha|star' } : server === 'server-b' ? pending.promise : { CustomPluginLinks: 'Gamma|bolt' } });
  await h.JE.initializePluginIcons(); await h.clock.advance(500);
  assert.ok(h.link('Alpha'));
  h.switchServer('server-b');
  h.document.querySelector('ul').remove();
  h.document.body.insertAdjacentHTML('beforeend', '<ul aria-labelledby="plugins-subheader"></ul>');
  await h.clock.advance(200);
  h.switchServer('server-c');
  pending.resolve({ CustomPluginLinks: 'Beta|bolt' });
  await h.clock.advance(200);
  assert.equal(h.link('Beta'), undefined, 'server-b reply is not applied to server-c');
  assert.equal(h.link('Alpha'), undefined, 'server-a links are not reused');
  assert.ok(h.link('Gamma'), 'the signed-in server\'s links are shown');
  assert.deepEqual(h.calls.map(([server]) => server), ['server-a', 'server-b', 'server-c']);
});

function revisions(t, hash = '#/dashboard/plugins/abc') {
  const h = createHarness({ url: `http://jellyfin.test/web/index.html${hash}`, JE: {},
    html: `<div id="addPluginPage"><div class="list">${['1.2.0.0 — b', '1.2.0.0 — a', '1.1.0.0', 'notes'].map(label =>
      `<div class="MuiAccordion-root"><div class="MuiAccordion-heading"><div class="MuiAccordionSummary-root"><div class="MuiAccordionSummary-content">${label}</div></div></div></div>`).join('')}</div></div>` });
  t.after(() => h.close());
  for (const file of ['core/navigation.js', 'core/lifecycle.js', 'core/dom-observer.js']) h.load(file);
  h.load(chromeJs('extras/plugin-revisions.js'));
  return { ...h, rows: () => [...h.document.querySelectorAll('.MuiAccordion-root')].map(row => row.classList.contains('je-duplicate-plugin-revision')) };
}

test('plugin revisions: only the first row per version stays visible and re-initialization restores rows', async t => {
  const h = revisions(t);
  h.JE.initializePluginRevisions();
  await until(() => h.rows().some(Boolean));
  assert.deepEqual(h.rows(), [false, true, false, false]);
  const styles = h.document.querySelectorAll('style').length;
  h.JE.initializePluginRevisions();
  assert.equal(h.document.querySelectorAll('style').length, styles, 're-init replaces its stylesheet');
  await until(() => h.rows()[1]);
  assert.deepEqual(h.rows(), [false, true, false, false]);
});

test('plugin revisions: other routes are never scanned', async t => {
  const h = revisions(t, '#/home');
  h.JE.initializePluginRevisions();
  await new Promise(resolve => h.window.requestAnimationFrame(() => h.window.requestAnimationFrame(resolve)));
  assert.deepEqual(h.rows(), [false, false, false, false]);
});
