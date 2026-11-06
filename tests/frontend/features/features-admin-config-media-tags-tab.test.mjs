// The Media Tags tab of the schema-driven configuration page: the real page (configPage.html markup and script,
// jeAdmin.js, Configuration/admin/*.js) and the real tab (js/enhanced/admintags/ with every section module) in one
// browser realm, over a mocked server that answers the whole-configuration PUT and the field patch as the plugin does.
// It checks how the tab opens (lazily, in place, from links and addresses), the sidebar, and that the page's own
// whole-configuration writes and the tab's field saves never undo each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { createHarness, jsRoot } from '../helpers/harness.mjs';
import { BASE, catalog, serverPatch } from '../helpers/admin-tags-page.mjs';

const config = resolve(jsRoot, '../Configuration');
const html = readFileSync(join(config, 'configPage.html'), 'utf8');
const DEFAULTS = JSON.parse(readFileSync(resolve(jsRoot, '../../docs/advanced/config-flag-groups.json'), 'utf8')).defaults;
const PAGE_URL = 'http://jellyfin.test/web/index.html#/configurationpage?name=Jellyfin%20Enhanced';
const SECTIONS = ['overview', 'layout', 'groups', 'rules', 'colours', 'badges', 'server'];

const clone = (v) => structuredClone(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Boot the configuration page with the Media Tags tab available.
 * @param {import('node:test').TestContext} t
 * @param {{url?: string, config?: object, patch?: Function, put?: Function, lazy?: boolean, session?: Object<string, string>}} [options]
 *   patch(body, server): the field patch's answer (default: the plugin's). put(body, server): the PUT's.
 *   lazy: the tab's scripts load only when the page asks for them, as in production (default: already loaded).
 *   session: sessionStorage entries the browser kept (the tab shown last).
 */
function boot(t, { url = PAGE_URL, config: extra = {}, patch, put, lazy = false, session = {} } = {}) {
  const server = clone({ ...DEFAULTS, ...BASE, ...extra });
  const calls = [];
  const markup = html.slice(html.indexOf('<div class="page'), html.lastIndexOf('</body>'));
  const h = createHarness({
    html: markup,
    url,
    // The page's own fetches (branding status, the locale list): answered empty.
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
    JE: { t: (key, params) => (params ? `${key}:${Object.values(params).join('|')}` : key), pluginConfig: {}, currentSettings: {} },
    apiClient: {
      getUrl: (path, query) => `http://jellyfin.test/${path.replace(/^\//, '')}${query ? `?${new URLSearchParams(query)}` : ''}`,
      getPluginConfiguration: async () => clone(server),
      updatePluginConfiguration: async (id, body) => {
        calls.push({ kind: 'put', body: clone(body) });
        return put ? put(body, server) : (Object.keys(server).forEach((k) => delete server[k]), Object.assign(server, clone(body)), {});
      },
      ajax: async (request) => {
        const path = new URL(request.url).pathname;
        const body = typeof request.data === 'string' ? (() => { try { return JSON.parse(request.data); } catch { return request.data; } })() : request.data;
        if (request.type === 'POST' && path.endsWith('/JellyfinEnhanced/admin/configuration')) {
          calls.push({ kind: 'patch', body: clone(body) });
          return (patch || ((b) => serverPatch(server, b)))(body, server);
        }
        if (request.type === 'POST') {
          calls.push({ kind: 'post', path, body });
          if (path.endsWith('/apply-user-settings')) return { applied: (body.properties || []).length, userCount: 1, unsupported: [] };
          return {};
        }
        if (path.endsWith('/tag-cache/summary')) return { enabled: true, entries: 12, lastModified: 0, rebuilding: false };
        if (path.endsWith('/tag-styles/catalog')) return catalog;
        if (path.endsWith('/Localization/Cultures')) return [{ TwoLetterISOLanguageName: 'en', DisplayName: 'English' }];
        if (path.endsWith('/tag-styles')) return {};
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
  t.after(() => { const ctx = h.JE.adminTags?.current?.(); if (ctx) ctx.dispose(); h.close(); });
  const { window, document } = h;
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = function () {};
  window.HTMLCanvasElement.prototype.getContext = () => ({ fillStyle: '#000000' });
  // The page's network-dependent diagnostics (no plugins, no Seerr) may log; the tab's own errors may not.
  h.allowConsoleError(/^\[JE\]/);
  // The tab's stylesheet is in place; scripts the tab asks for are already loaded below (report them as loaded).
  const css = document.createElement('link');
  css.id = 'jeTagAdminCss';
  document.head.appendChild(css);
  for (const [key, value] of Object.entries(session)) window.sessionStorage.setItem(key, value);
  const append = document.head.appendChild.bind(document.head);
  document.head.appendChild = (node) => {
    const r = append(node);
    if (node.tagName !== 'SCRIPT') return r;
    // Lazy: the script the page appends is evaluated now (admin-tags.js, then each section module), then reports loaded.
    const src = lazy && /\/js\/(enhanced\/admintags\/[\w/.-]+\.js)/.exec(node.src || '');
    window.setTimeout(() => { if (src) h.load(src[1]); if (node.onload) node.onload(); }, 0);
    return r;
  };
  // The JE client bundle the dashboard runs, then (unless lazy) the tab's own modules.
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/rating-sources.js', 'enhanced/settingspanel/ui-panel-tag-editor.js']) h.load(file);
  h.JE.escapeHtml = h.JE.core.ui.escapeHtml;
  if (!lazy) {
    h.load('enhanced/admintags/admin-tags.js');
    for (const file of h.JE.adminTags.SECTION_FILES) h.load(`enhanced/admintags/${file}`);
  }
  h.JE.internals = h.JE.internals || {};
  h.JE.internals.enhancedUi = h.JE.internals.enhancedUi || {};
  // The configuration page: its engine, its section definitions, then its own script.
  window.eval(readFileSync(join(config, 'jeAdmin.js'), 'utf8'));
  for (const name of readdirSync(join(config, 'admin')).filter((f) => f.endsWith('.js')).sort()) window.eval(readFileSync(join(config, 'admin', name), 'utf8'));
  window.JEAdmin.confirm = async () => true;
  window.JEAdmin.alert = async () => {};
  const script = html.slice(html.indexOf('<script type="text/javascript">') + '<script type="text/javascript">'.length, html.lastIndexOf('</script>'));
  window.eval(script);
  const page = document.getElementById('JellyfinEnhancedPage');
  const tab = document.getElementById('media-tags');
  const root = tab.querySelector('.je-tag-admin');
  const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => window.setTimeout(r, 0)); };
  /** Wait until the tab is drawn (or `fn` holds). */
  const until = async (fn = () => root.querySelector('.je-ta-tabs'), what = 'the Media Tags tab drew') => {
    for (let i = 0; i < 200 && !fn(); i++) await sleep(5);
    assert.ok(fn(), what);
  };
  const change = (el, value) => {
    assert.ok(el, 'control exists');
    if (el.type === 'checkbox') el.checked = value === undefined ? !el.checked : value; else el.value = value;
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const tabButton = (id) => document.querySelector(`.jellyfin-tab-button[data-tab="${id}"]`);
  return { ...h, server, calls, page, tab, root, settle, until, change, tabButton, form: document.getElementById('JellyfinEnhancedForm') };
}

test('the tab: after the form, between Display and Elsewhere in the sidebar with its sections, drawn the first time it opens', async (t) => {
  const h = boot(t);
  const { document } = h;
  await h.settle();
  assert.equal(h.tab.closest('form'), null, 'not part of the form its Save reads');
  assert.equal(h.form.compareDocumentPosition(h.tab) & h.window.Node.DOCUMENT_POSITION_FOLLOWING, h.window.Node.DOCUMENT_POSITION_FOLLOWING);
  const order = Array.from(document.querySelectorAll('.jea-nav .jellyfin-tab-button'), (b) => b.dataset.tab);
  assert.deepEqual(order.slice(order.indexOf('display'), order.indexOf('display') + 3), ['display', 'media-tags', 'elsewhere']);
  const leaves = Array.from(document.querySelectorAll('[data-je-mt-tree] .jea-nav-leaf'));
  assert.deepEqual(leaves.map((a) => a.dataset.jeMtSection), SECTIONS);
  assert.equal(h.tabButton('media-tags').nextElementSibling, document.querySelector('[data-je-mt-tree]'));
  assert.match(leaves[2].getAttribute('href'), /#\/configurationpage\?name=Jellyfin%20Enhanced&jeSection=media-tags&tab=groups$/);
  // Not drawn (no settings requested) until it opens.
  assert.equal(h.root.querySelector('.je-ta-tabs'), null);
  assert.equal(h.calls.length, 0);

  h.tabButton('media-tags').click();
  await h.until();
  assert.ok(h.page.classList.contains('je-mt-active'), 'the page knows the tab is shown (Save dock, refresh hint)');
  assert.ok(h.tab.classList.contains('active'));
  assert.equal(h.root.querySelector('.je-ta-back'), null, 'no way "back": it is the page');
  // A sidebar section opens it there and is marked.
  leaves[3].click();
  await h.settle();
  assert.equal(h.root.dataset.tab, 'rules');
  assert.deepEqual(leaves.filter((a) => a.classList.contains('on')).map((a) => a.dataset.jeMtSection), ['rules']);
  assert.equal(leaves[3].getAttribute('aria-current'), 'true');
  // The tab's own tabs mark the sidebar too.
  h.root.querySelector('#jeTaTab-colours').click();
  assert.deepEqual(leaves.filter((a) => a.classList.contains('on')).map((a) => a.dataset.jeMtSection), ['colours']);
  // Another tab: the page leaves Media Tags mode; coming back keeps the section.
  h.tabButton('display').click();
  await h.settle();
  assert.equal(h.page.classList.contains('je-mt-active'), false);
  h.tabButton('media-tags').click();
  await h.settle(40);
  assert.equal(h.root.dataset.tab, 'colours');
});

test('addresses open the tab at their section: the tab\'s own, older jeSection ids, and tab= for any tab', async (t) => {
  const groups = boot(t, { url: `${PAGE_URL}&jeSection=media-tags&tab=groups&group=rating` });
  await groups.until(() => groups.root.querySelector('.je-ta-grow[data-group="rating"][data-open="true"]'), 'Groups › Rating opened');
  assert.equal(groups.root.dataset.tab, 'groups');
  assert.ok(groups.tab.classList.contains('active'));
  // The phone menu's label names the tab shown, also when no one clicked it.
  await groups.until(() => groups.document.querySelector('.jea-nav-current').textContent === 'Media Tags', 'the phone menu says Media Tags');

  const legacy = boot(t, { url: `${PAGE_URL}&jeSection=awardsTagsAdminDetails` });
  await legacy.until(() => legacy.root.querySelector('.je-ta-grow[data-group="awards"][data-open="true"]'), 'an older Awards link opens Groups › Awards');

  const display = boot(t, { url: `${PAGE_URL}&tab=display` });
  await display.settle();
  assert.ok(display.document.getElementById('display').classList.contains('active'));
  assert.equal(display.root.querySelector('.je-ta-tabs'), null, 'Media Tags is not drawn for another tab');
});

test('links to the page itself (the Display card, the tab\'s own links) open in place, without navigating', async (t) => {
  const h = boot(t);
  await h.settle();
  const before = h.window.location.hash;
  const link = h.document.querySelector('#mediaTagsCard .je-media-tags-card-link[href$="tab=colours"]');
  assert.ok(link, 'the Display card links to the Colours section');
  link.click();
  await h.until(() => h.root.dataset.tab === 'colours', 'the card link opened Colours');
  assert.equal(h.window.location.hash, before, 'the page was not navigated (unsaved changes elsewhere would be lost)');
  // The tab's link to a main-page setting (Status badges → TMDB key) jumps there in place too.
  h.root.querySelector('#jeTaTab-badges').click();
  const tmdb = h.root.querySelector('a[href*="jeSection=TMDB_API_KEY"]');
  assert.ok(tmdb);
  tmdb.click();
  await h.settle();
  assert.equal(h.window.location.hash, before);
  assert.ok(h.document.getElementById('TMDB_API_KEY').closest('.jellyfin-tab-content').classList.contains('active'));
  // The Enhanced panel's pointer (outside the page, over it): opened in place too.
  const hub = h.document.createElement('a');
  hub.href = 'http://jellyfin.test/web/index.html#/configurationpage?name=Jellyfin%20Enhanced&jeSection=media-tags&tab=server';
  h.document.body.appendChild(hub);
  hub.click();
  await h.until(() => h.root.dataset.tab === 'server', 'the panel pointer opened Server');
  assert.equal(h.window.location.hash, before);
  // A link inside another (older) view of a page is that view's business.
  const other = h.document.createElement('div');
  other.dataset.role = 'page';
  const inOther = h.document.createElement('a');
  inOther.href = '#/configurationpage?name=Jellyfin%20Enhanced&jeSection=media-tags&tab=rules';
  other.appendChild(inOther);
  h.document.body.appendChild(other);
  const otherClick = new h.window.MouseEvent('click', { bubbles: true, cancelable: true });
  inOther.dispatchEvent(otherClick);
  await h.settle();
  assert.equal(otherClick.defaultPrevented, false, 'left to that view');
  assert.equal(h.root.dataset.tab, 'server', 'not opened here');
  // A modified click (new browser tab) is left alone.
  const event = new h.window.MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
  link.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
});

test('Save never puts an older Media Tags value back: a pending field save goes first, and one made during the write waits for it', async (t) => {
  let release = null;
  const h = boot(t, {
    // The second whole-configuration write is held open until the test lets it finish.
    put: async (body, server) => {
      if (h.holdNextPut) { h.holdNextPut = false; await new Promise((r) => { release = r; }); }
      Object.keys(server).forEach((k) => delete server[k]);
      Object.assign(server, clone(body));
      return {};
    },
  });
  h.holdNextPut = false;
  h.tabButton('media-tags').click();
  await h.until();
  h.root.querySelector('#jeTaTab-layout').click();
  // A Media Tags change, and Save pressed before the tab's own save went out (it waits 400 ms).
  h.change(h.root.querySelector('#tagsHideOnHover'), true);
  h.change(h.document.getElementById('showFileSizes'), !h.server.ShowFileSizes);
  h.form.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await h.until(() => h.calls.some((c) => c.kind === 'put'), 'Save wrote the configuration');
  await h.settle();
  const kinds = h.calls.filter((c) => c.kind !== 'post').map((c) => c.kind);
  assert.deepEqual(kinds.slice(0, 2), ['patch', 'put'], 'the field was saved before Save read the configuration');
  const put = h.calls.find((c) => c.kind === 'put').body;
  assert.equal(put.TagsHideOnHover, true, 'Save carries the field the tab saved');
  assert.equal(h.server.TagsHideOnHover, true);
  assert.equal(h.server.ShowFileSizes, put.ShowFileSizes);

  // A change made while Save's write is on its way waits for it, then saves on top of it.
  h.calls.length = 0;
  h.holdNextPut = true;
  h.form.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await h.until(() => release, 'the second Save is writing');
  h.change(h.root.querySelector('#disableTagsOnSearchPage'), true);
  await sleep(600);
  assert.deepEqual(h.calls.filter((c) => c.kind === 'patch'), [], 'no field save while the whole configuration is being written');
  assert.equal(h.root.querySelector('#jeTaSaved').dataset.state, 'saving');
  release();
  await h.until(() => h.calls.some((c) => c.kind === 'patch'), 'the held field save went out');
  await h.until(() => h.root.querySelector('#jeTaSaved').dataset.state === 'saved', 'and was accepted (no conflict)');
  const patch = h.calls.find((c) => c.kind === 'patch').body;
  assert.deepEqual(patch, { Changes: { DisableTagsOnSearchPage: true }, Expected: { DisableTagsOnSearchPage: false } });
  assert.equal(h.server.DisableTagsOnSearchPage, true);
  assert.equal(h.server.TagsHideOnHover, true, 'still the tab\'s value');
});

test('Apply all plugin settings and Apply the above save a pending Media Tags change first and never write one', async (t) => {
  const h = boot(t);
  h.tabButton('media-tags').click();
  await h.until();
  h.root.querySelector('#jeTaTab-layout').click();
  h.change(h.root.querySelector('#tagsHideOnHover'), true);
  h.document.getElementById('resetAllUserSettingsBtn').click();
  await h.until(() => h.calls.some((c) => c.kind === 'post' && c.path.endsWith('/reset-all-users-settings')), 'Apply all plugin settings ran');
  const order = h.calls.map((c) => c.kind);
  assert.ok(order.indexOf('patch') >= 0 && order.indexOf('patch') < order.indexOf('put'), `the field save went first: ${order}`);
  assert.equal(h.calls.find((c) => c.kind === 'put').body.TagsHideOnHover, true);

  h.calls.length = 0;
  h.change(h.root.querySelector('#disableTagsOnSearchPage'), true);
  h.document.dispatchEvent(new h.window.CustomEvent('jea-apply-selected', { detail: { props: ['ShowFileSizes'], labels: ['Show file sizes'] } }));
  await h.until(() => h.calls.some((c) => c.kind === 'post' && c.path.endsWith('/apply-user-settings')), 'Apply the above ran');
  const kinds = h.calls.map((c) => c.kind);
  assert.ok(kinds.indexOf('patch') < kinds.indexOf('put'), `the field save went first: ${kinds}`);
  assert.equal(h.calls.find((c) => c.kind === 'put').body.DisableTagsOnSearchPage, true);
  assert.deepEqual(h.calls.find((c) => c.kind === 'post').body.properties, ['ShowFileSizes']);
});

test('the sidebar marks a Media Tags change that is not saved, and a saved change updates the Display card', async (t) => {
  let refuse = true;
  const h = boot(t, {
    patch: (body, server) => {
      if (refuse && 'QualityTagsEnabled' in body.Changes) throw { status: 409, json: async () => ({ conflicts: { QualityTagsEnabled: true } }) };
      return serverPatch(server, body);
    },
  });
  // Jellyfin shows the page: it loads the configuration (and fills the Display card).
  h.page.dispatchEvent(new h.window.Event('pageshow'));
  const facts = () => h.document.getElementById('jeMediaTagsCardFacts').textContent;
  await h.until(() => facts(), 'the Display card shows its summary');
  assert.match(facts(), /On for new users.*Quality/);
  h.tabButton('media-tags').click();
  await h.until();
  h.root.querySelector('#jeTaTab-groups').click();
  h.change(h.root.querySelector('#qualityTagsEnabled'), false);
  const button = h.tabButton('media-tags');
  await h.until(() => button.getAttribute('data-je-mt-state') === 'conflict', 'the sidebar entry is marked');
  assert.match(button.textContent, /changed by someone else, not saved/);
  refuse = false;
  h.root.querySelector('#jeTaSaved [data-je-keep]').click();
  await h.until(() => h.root.querySelector('#jeTaSaved').dataset.state === 'saved', 'Keep mine saved it');
  assert.equal(button.hasAttribute('data-je-mt-state'), false, 'the mark is gone');
  assert.equal(button.querySelector('.je-mt-state-text').textContent, '');
  assert.equal(h.server.QualityTagsEnabled, false);
  assert.doesNotMatch(facts(), /On for new users[^]*Quality/, 'the card summary follows the saved value');
});

test('searching and clearing the search leaves the Media Tags tab as it was', async (t) => {
  const h = boot(t);
  h.tabButton('media-tags').click();
  await h.until();
  const input = h.document.getElementById('settingsSearchInput');
  input.value = 'rating';
  input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  await sleep(250);
  assert.ok(h.form.classList.contains('je-search-mode'));
  input.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await h.settle();
  assert.equal(h.form.classList.contains('je-search-mode'), false);
  assert.equal(h.tab.style.display, '', 'no display left over from the search');
  assert.equal(h.tab.querySelector(':scope > .je-search-tab-label'), null, 'no leftover tab label');
  assert.ok(h.tab.classList.contains('active'));
});

test('an address naming a Media Tags section, with Media Tags the tab restored from the session, opens it while the tab loads, without an error', async (t) => {
  // The restored tab starts the mount as the page opens; the address then asks for a section while admin-tags.js and
  // its modules are still loading (as in production).
  const h = boot(t, { url: `${PAGE_URL}&jeSection=media-tags&tab=groups&group=rating`, lazy: true, session: { jellyfinEnhancedActiveTab: 'media-tags' } });
  await h.until(() => h.root.querySelector('.je-ta-grow[data-group="rating"][data-open="true"]'), 'Media Tags › Groups › Rating opened');
  await h.settle();
  assert.ok(h.tab.classList.contains('active'));
  assert.equal(h.root.dataset.tab, 'groups');
  assert.deepEqual(h.errors.map(String), [], 'no page error');
});

test('the Media Tags tab keeps no transform once shown: its Undo bar stays fixed to the window', () => {
  // slideUpFade ends on transform: translateY(0) and keeps it (forwards); any transform makes the tab the containing
  // block of the tab's position: fixed Undo bar, which then sits at the bottom of the tab, often below the window.
  const css = readFileSync(join(config, 'jeAdmin.css'), 'utf8');
  const rule = /#JellyfinEnhancedPage \.jea-main \.jellyfin-tab-content\.je-mt-tab\.active \{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the tab has its own rule');
  const name = /animation(?:-name)?:\s*([\w-]+)/.exec(rule[1]);
  assert.ok(name && name[1] !== 'slideUpFade', 'the tab does not run slideUpFade');
  const frames = new RegExp(`@keyframes ${name[1]} \\{([^}]*\\}[^}]*)\\}`).exec(css);
  assert.ok(frames, `@keyframes ${name[1]} exists`);
  assert.doesNotMatch(frames[1], /transform/, 'its keyframes leave no transform');
});

test('at a 1400px window (896px for the tab beside the drawer and the sidebar) the live preview stays beside the settings', () => {
  // The tab folds its preview into a toggle above the settings below a container width; that width must be under what
  // the tab gets in a 1400px window, as the separate page had (the preview beside the settings).
  const css = readFileSync(resolve(jsRoot, 'enhanced/admintags/admin-tags.css'), 'utf8');
  const narrow = [...css.matchAll(/@container je-ta \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g)]
    .filter((m) => /\.je-ta-preview-toggle \{ display: flex/.test(m[2]));
  assert.equal(narrow.length, 1, 'one container rule folds the preview');
  assert.ok(Number(narrow[0][1]) < 896, `folds below ${narrow[0][1]}px`);
});

test('the tab is a section of the page: the sidebar navigates it on a desktop, the page\'s chip row on a phone, no title row of its own', async (t) => {
  const h = boot(t);
  await h.settle();
  h.tabButton('media-tags').click();
  await h.until();
  // No second title or ADMIN chip: the page's header and sidebar say where this is.
  assert.equal(h.root.querySelector('.je-ta-head, .je-ta-title, .je-ta-admin-chip'), null);
  // Each section is named by its own visible heading (the section tabs are hidden on a desktop).
  for (const id of SECTIONS) {
    const panel = h.root.querySelector(`#jeTaPanel-${id}`);
    const title = h.root.querySelector(`#${panel.getAttribute('aria-labelledby')}`);
    assert.equal(title?.tagName, 'H2', `${id} is named by its heading`);
    assert.equal(title.closest('.je-ta-panel'), panel);
  }
  // The save status sits beside the open section's heading; a change that is not saved floats where the page's Save dock does.
  const saved = h.root.querySelector('#jeTaSaved');
  assert.equal(saved.closest('.je-ta-panel-head'), h.root.querySelector(`#jeTaPanel-${h.root.dataset.tab} > .je-ta-panel-head`), 'beside the open section\'s heading');
  const css = readFileSync(resolve(jsRoot, 'enhanced/admintags/admin-tags.css'), 'utf8');
  assert.match(css, /@media \(min-width: 901px\) \{ \.je-ta-tabs \{ display: none; \} \}/, 'the section row is hidden where the page shows its sidebar (jeAdmin.css: drawer below 901px)');
  assert.match(css, /\.je-ta-saved:is\(\[data-state="error"\], \[data-state="conflict"\]\) \{\n    position: fixed; left: 50%; bottom: 30px;/, 'a change that is not saved floats where the page\'s Save dock does');
  assert.doesNotMatch(css, /\.je-ta-tabs \{[^}]*position: sticky/, 'the phone chip row stays in the flow (the page\'s menu bar is the sticky one)');
  // A section that opens with its cards starts at the first card: keyboard focus lands on that card's title, which shows it.
  const leaf = (id) => h.document.querySelector(`[data-je-mt-tree] .jea-nav-leaf[data-je-mt-section="${id}"]`);
  leaf('layout').click();
  await h.settle();
  assert.equal(h.document.activeElement, h.root.querySelector('#jeTaPanel-layout .je-ta-card-title'), 'Layout defaults: its first card');
  assert.equal(h.root.querySelector('#jeTaPanel-layout').dataset.lead, 'card');
  leaf('groups').click();
  await h.settle();
  assert.equal(h.document.activeElement, h.root.querySelector('#jeTaPanel-groups .je-ta-card-title'), 'Groups: the card holding its rows');
  // A group row is the page's setting row: name first, then the sample, the switch and Edit (the same order for the keyboard).
  const head = h.root.querySelector('.je-ta-grow[data-group="quality"] > .je-ta-grow-head');
  assert.deepEqual(Array.from(head.children, (c) => c.className), ['je-ta-grow-text', 'je-ta-grow-sample', 'je-ta-grow-check', 'je-ta-expand']);
  // Its switch is named by the row's visible name and scope, and described by the summary.
  const sw = head.querySelector('.je-ta-grow-check input');
  assert.equal(h.root.querySelector(`#${sw.getAttribute('aria-labelledby')}`), head.querySelector('.je-ta-grow-name'));
  assert.equal(h.root.querySelector(`#${sw.getAttribute('aria-describedby')}`), head.querySelector('.je-ta-grow-sum'));
  // A card whose settings reach different people marks each one: Hide tags on hover is a new-user default, the search page is everyone's.
  assert.deepEqual(['tagsHideOnHover', 'disableTagsOnSearchPage'].map((id) => h.root.querySelector(`[data-field-row="${id}"] .je-ta-scope`)?.dataset.scope), ['new', 'all']);
  // Collapsed groups summarise their current choice, not their whole description (which stays inside the group).
  for (const g of ['awards', 'logos', 'custom']) assert.match(h.root.querySelector(`#jeTaSum-group-${g}`).textContent, new RegExp(`^admin_tags_${g}_summary:`), g);
  // An explanation with nothing to set (Rules' locked items) is a closed disclosure, not a card.
  const note = h.root.querySelector('[data-section="rules-locks"]');
  assert.equal(note.tagName, 'DETAILS');
  assert.equal(note.open, false);
  // The switches other settings depend on take the page's master-switch look.
  assert.deepEqual(Array.from(h.root.querySelectorAll('.je-ta-switch--master'), (l) => l.dataset.fieldRow).sort(), ['nativePosterTagsEnabled', 'tagCacheServerMode', 'tagStylesEnabled']);
  // Quality's display and audio-language options sit under two closed disclosures after its category list.
  const more = Array.from(h.root.querySelectorAll('#jeTaGroup-quality details.je-ta-more'));
  assert.deepEqual(more.map((d) => [d.dataset.more, d.open]), [['admin_tags_quality_more_display', false], ['admin_tags_quality_more_audio', false]]);
  assert.ok(more[0].querySelector('#qualityHdrDisplayMode') && more[1].querySelector('#qualityTagsPreferredAudioLanguage'));
});

test('a tab that cannot be drawn says so, and its message and button name the same action (Retry)', async (t) => {
  const h = boot(t);
  h.expectConsoleError(/the Media Tags tab failed to load/);
  const real = h.JE.adminTags.mountTab;
  let fail = true;
  h.JE.adminTags.mountTab = (...args) => (fail ? Promise.reject(new Error('not ready')) : real(...args));
  await h.settle();
  h.tabButton('media-tags').click();
  await h.until(() => h.root.querySelector('[role="alert"]'), 'the not-ready message shows');
  const alert = h.root.querySelector('[role="alert"]');
  const button = alert.querySelector('[data-je-mt-retry]');
  assert.equal(button.textContent, 'Retry');
  assert.match(alert.textContent, /cannot be shown\. Retry, and if this stays/);
  assert.doesNotMatch(alert.textContent, /Reload the page|Try again/);
  fail = false;
  button.click();
  await h.until();
  assert.equal(h.root.querySelector('[role="alert"]'), null, 'Retry draws the tab');
});
