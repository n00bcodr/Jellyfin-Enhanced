import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, jsRoot } from '../helpers/harness.mjs';
import { setup as titleSetup, delivered } from '../helpers/title-actions-scopes.mjs';

// Phase 2 UX task 5. UX-13: the JE settings panel is a modal surface on the one surface stack (named dialog, Tab stays
// inside it, the page behind is inert, Escape closes the topmost surface only and focus goes back to the opener).
// UX-18: an absent title's page (and its episode rows) shows no "Ends at" estimate. UX-20: a synthetic episode page has
// one status: Jellyfin's own Missing marker is not shown while JE's status pill is. UX-22: Hide on a title that is not
// in the library says it hides the title, not "from my library".

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
const tr = (key, params) => {
  let text = key in en ? en[key] : key;
  for (const [k, v] of Object.entries(params || {})) text = text.replace(`{${k}}`, v);
  return text;
};
const tick = () => new Promise(r => setImmediate(r));
async function settle(n = 20) { for (let i = 0; i < n; i++) await tick(); }
const preset = { name: 'p', previewText: 'Aa', size: 1, family: 'sans-serif', bgColor: '#000', textColor: '#fff' };
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ UX-13: the settings panel on the surface stack

/** The real panel (template, settings store, ui-panel.js) over a page with a Request button, on the real core. */
function panelPage(t) {
  const h = createHarness({
    html: '<div class="page mainAnimatedPage"><button id="opener">Enhanced Panel</button><button class="btnPlay" id="behind">Request</button></div>',
    JE: {
      pluginConfig: { Shortcuts: [] }, userConfig: { settings: {}, shortcuts: { Shortcuts: [] }, bookmark: { bookmarks: {} } }, currentSettings: {},
      t: tr, toast() {}, escapeHtml, icon: () => '', IconName: new Proxy({}, { get: (_, k) => String(k) }),
      icons: { wrapEmoji: s => s }, state: { activeShortcuts: {} }, pluginVersion: '0.0.0',
      themer: { getThemeVariables: () => ({}) },
      fontSizePresets: [preset, preset, preset, preset], fontFamilyPresets: [preset], subtitlePresets: [preset], subtitleTextEffectPresets: [preset],
      decodeSubtitleColor: () => ({ swatch: '#FFFFFF', alpha: 255, alphaValue: 255 }), getSubtitleTextShadow: () => 'none',
    },
    apiClient: { ajax: async () => ({}) },
  });
  t.after(() => h.close());
  // A desktop-width window (jsdom has no media queries).
  h.window.matchMedia = media => ({ matches: false, media, addEventListener() {}, removeEventListener() {} });
  for (const m of ['core/navigation.js', 'core/session.js', 'core/session-action.js', 'core/mutation-queue.js', 'enhanced/translations.js', 'enhanced/config.js']) h.load(m);
  h.JE.currentSettings = h.JE.loadSettings();
  h.load('enhanced/settingspanel/ui-panel-template.js');
  h.load('enhanced/settingspanel/ui-panel.js');
  // The sections' own wiring is other tests' (bootstrap-settings-*): here only the panel's surface matters.
  const internal = h.JE.internals.enhancedUi;
  for (const name of ['wireShortcutEditor', 'wireSettingsListeners', 'wireHiddenContentListeners', 'wireMiscSettingsControls', 'wireLanguageControls']) internal[name] = () => {};
  const opener = h.document.getElementById('opener');
  opener.addEventListener('click', e => { h.JE.showEnhancedPanel(e); });
  return { ...h, opener, behind: h.document.getElementById('behind'), panel: () => h.document.getElementById('jellyfin-enhanced-panel') };
}

async function openPanel(h) {
  h.opener.focus();
  h.click(h.opener);
  await settle();
  const panel = h.panel();
  assert.ok(panel, 'the panel opened');
  return panel;
}

test('UX-13: the settings panel is a named modal dialog; the page behind it is inert', async t => {
  const h = panelPage(t);
  const panel = await openPanel(h);
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.equal(panel.getAttribute('aria-modal'), 'true');
  assert.equal(panel.getAttribute('aria-label'), 'Jellyfin Enhanced');
  assert.ok(h.behind.closest('[inert]'), 'the Request button under the panel is inert');
  assert.ok(panel.contains(h.document.activeElement), 'focus moved into the panel');
  // Its icon-only controls have names.
  assert.equal(panel.querySelector('#closeSettingsPanel').getAttribute('aria-label'), tr('panel_close'));
  assert.equal(panel.querySelector('#jePanelBack').getAttribute('aria-label'), tr('panel_back_to_sections'));
  assert.equal(panel.querySelector('#jePanelSearch').getAttribute('aria-label'), tr('panel_search_placeholder'));
});

test('UX-13: Shift+Tab from the close button and Tab past the last control wrap inside the panel; focus sent behind it comes back', async t => {
  const h = panelPage(t);
  const panel = await openPanel(h);
  const close = panel.querySelector('#closeSettingsPanel');
  close.focus();
  // The close button is the panel's first control: Shift+Tab wraps to its last one (a browser would leave for the page).
  h.key(close, 'Tab', { shiftKey: true }); await tick();
  const last = h.document.activeElement;
  assert.ok(panel.contains(last) && last !== close, 'Shift+Tab from the first control wraps to the panel\'s last');
  h.key(last, 'Tab'); await tick();
  assert.equal(h.document.activeElement, close, 'Tab past the last control wraps to the first');
  for (let i = 0; i < 8; i++) {
    h.key(h.document.activeElement, 'Tab', { shiftKey: true }); await tick();
    assert.ok(panel.contains(h.document.activeElement), `Shift+Tab ${i + 1} stays in the panel`);
  }
  // Something moving focus to the page behind (a script, a click that got through) is undone.
  h.behind.focus(); await tick();
  assert.ok(panel.contains(h.document.activeElement), 'focus does not stay on the covered Request button');
});

test('UX-13: Escape closes the panel and gives focus back to its opener; the page is live again', async t => {
  const h = panelPage(t);
  const panel = await openPanel(h);
  assert.ok(panel.contains(h.document.activeElement), 'focus is in the panel');
  h.key(h.document.activeElement, 'Escape', { keyCode: 27 }); await settle();
  assert.equal(h.panel(), null, 'Escape closed the panel');
  assert.equal(h.document.activeElement, h.opener, 'focus went back to the opener');
  assert.equal(h.behind.closest('[inert]'), null, 'nothing is inert any more');
});

test('UX-13 control: Escape with a surface over the panel closes that surface only', async t => {
  const h = panelPage(t);
  const panel = await openPanel(h);
  const inner = h.document.createElement('div');
  inner.innerHTML = '<h2>Over</h2><button id="inner">OK</button>';
  let closed = 0;
  const button = panel.querySelector('#closeSettingsPanel');
  let release;
  button.addEventListener('click', e => { e.stopImmediatePropagation(); release = h.JE.openSurface(inner, () => { closed++; inner.remove(); }, h.JE.ownerOf(e)); }, { capture: true, once: true });
  h.click(button);
  h.document.body.append(inner); await settle();
  assert.ok(release, 'the inner surface opened over the panel');
  h.key(inner.querySelector('#inner'), 'Escape', { keyCode: 27 }); await settle();
  assert.equal(closed, 1, 'the surface over the panel closed');
  assert.ok(h.panel(), 'the panel stayed open');
  h.key(h.document.activeElement, 'Escape', { keyCode: 27 }); await settle();
  assert.equal(h.panel(), null, 'the next Escape closes the panel');
});

// ------------------------------------------------------------------ UX-18 / UX-20: an absent episode page

const SERVER = '0202511b0eac4284ab045b3ba556d72e';
const PAGE = `<div id="itemDetailPage" class="page libraryPage itemDetailPage"><div class="detailPageContent"><div class="detailPagePrimaryContainer">
  <div class="itemMiscInfo itemMiscInfo-primary"><div class="mediaInfoItem">43m</div><div class="mediaInfoItem endsAt">Ends at 9:43 PM</div><div class="missingIndicator">Missing</div></div>
  <div class="mainDetailButtons"><button class="btnPlay detailButton">Play</button></div></div>
  <div class="detailPagePrimaryContent"><div class="detailSection"><div class="overview">Overview</div></div></div>
  <div class="listItem" data-id="ROW"><div class="listItemMediaInfo"><div class="mediaInfoItem">46m</div><div class="mediaInfoItem endsAt">Ends at 10:20 PM</div></div></div></div></div>`;

/** The page adapter on an absent episode's (or season's) page (Firefly S1E1); its row is S1E2, also absent. */
async function episodePage(t, kind = 'episode') {
  const h = createHarness({
    html: PAGE, url: 'http://jellyfin.test/web/index.html#/home',
    JE: {
      pluginConfig: { NativeAbsentDetails: { Enabled: true, ContractVersion: 1 } }, t: key => key,
      core: { api: { plugin: async () => null } }, session: { onUserChange() {} },
      arrStatus: { enabled: () => true, subscribe: () => () => {} }, arrAsk: { enabled: () => true },
    },
    apiClient: { serverId: () => SERVER, getItem: async (_u, id) => ({ Id: id, Type: kind === 'season' ? 'Season' : 'Episode', Name: 'The Train Job', SeriesName: 'Firefly', ParentIndexNumber: 1, IndexNumber: 1, ProviderIds: {} }) },
  });
  h.window.Emby = { Page: { show() {} } };
  t.after(() => h.close());
  h.load('core/ui-kit.js');
  h.load('jellyseerr/nativedetails/native-details.js');
  const id = kind === 'season' ? h.JE.titleDetails.syntheticId('season', 1437, 1) : h.JE.titleDetails.syntheticId('episode', 1437, 1, 1);
  h.document.querySelector('.listItem').dataset.id = h.JE.titleDetails.syntheticId('episode', 1437, 1, 2);
  h.window.location.hash = `#/details?id=${id}&serverId=${SERVER}`;
  await h.JE.internals.nativeDetails.onView();
  const page = h.document.getElementById('itemDetailPage');
  assert.ok(page.classList.contains('je-native-absent'));
  return { ...h, page };
}

const shown = (h, node) => h.window.getComputedStyle(node).display !== 'none';

test('UX-18: an absent title\'s page shows its runtime but no "Ends at", on the title and its episode rows', async t => {
  const h = await episodePage(t);
  for (const ends of h.page.querySelectorAll('.endsAt')) assert.equal(shown(h, ends), false, ends.textContent);
  assert.equal(shown(h, h.page.querySelector('.itemMiscInfo .mediaInfoItem')), true, 'the runtime stays');
  assert.equal(shown(h, h.page.querySelector('.listItemMediaInfo .mediaInfoItem')), true, 'a row\'s runtime stays');
});

test('UX-20: one status on an absent episode page: Jellyfin\'s Missing marker goes while JE\'s status shows, and comes back when it goes', async t => {
  const h = await episodePage(t);
  const marker = h.page.querySelector('.missingIndicator');
  assert.equal(shown(h, marker), true, 'no JE status yet: Jellyfin\'s marker is the page\'s status');
  // The details surface draws its status (as status-details does) and tells the page.
  const pill = Object.assign(h.document.createElement('div'), { className: 'je-arr-status', textContent: 'Missing' });
  pill.dataset.jeArrSurface = 'details';
  h.page.querySelector('.detailSection').append(pill);
  h.JE.internals.nativeDetails.statusShown(h.page, { key: 'episode:tmdb:1437:1:1', stage: 'notHere' });
  assert.equal(pill.parentElement.className, 'je-native-absent-status');
  assert.equal(shown(h, marker), false, 'JE\'s status is the one status');
  // The status surface takes its block away (no status any more): Jellyfin's own marker is back.
  pill.remove(); await settle(3);
  assert.equal(shown(h, marker), true);
});

// ------------------------------------------------------------------ UX-22: Hide on a title that is not in the library

for (const absent of [true, false]) test(`UX-22: the More sheet's Hide on ${absent ? 'an absent' : 'a library'} title reads "${tr(absent ? 'title_actions_hide_title' : 'title_actions_hide')}"`, async t => {
  const h = titleSetup(t, { asks: false });
  const c = h.JE.titleActions.context(absent ? { tmdbId: 603, mediaType: 'movie', title: 'The Matrix' } : { Id: '0123456789abcdef0123456789abcdef', Type: 'Movie', Name: 'The Matrix', ProviderIds: { Tmdb: '603' }, absent: false });
  assert.equal(c.absent, absent);
  const control = h.document.createElement('button');
  control.className = 'je-detail-hide-btn'; control.title = 'Hide';
  h.document.body.append(control);
  const opener = h.document.createElement('button');
  h.document.body.append(opener);
  let shownSheet;
  opener.addEventListener('click', e => { shownSheet = h.JE.titleActions.show(c, [{ id: 'hide', group: 'view', label: 'Hide', icon: 'visibility', control }], opener, h.JE.ownerOf(e)); });
  h.click(opener); await delivered();
  assert.notEqual(shownSheet, false);
  const entry = h.document.querySelector('.je-actions-entry[data-action="hide"] .je-actions-entry-label');
  assert.ok(entry, 'the sheet offers Hide');
  assert.equal(entry.firstChild.textContent, h.JE.t(absent ? 'title_actions_hide_title' : 'title_actions_hide'));
  if (absent) assert.notEqual(entry.firstChild.textContent, h.JE.t('title_actions_hide'), 'never "from my library" for a title that is not in it');
});

// ------------------------------------------------------------------ found on the rig: Manage hidden content

for (const nativeTab of [true, false]) test(`the panel's Manage hidden content ${nativeTab ? 'goes to the Hidden Content Home tab (native-tab mode)' : 'control: still opens the page of its own'}`, t => {
  const h = createHarness({
    html: '<button id="manageHiddenContentBtn">Manage</button>',
    JE: { pluginConfig: { HiddenContentEnabled: true, HiddenContentUseNativeTab: nativeTab }, t: key => key, nativeTabs: { register() {} } },
  });
  t.after(() => h.close());
  let pages = 0;
  h.JE.hiddenContent = { updateSettings() {}, getSettings: () => ({}) };
  h.JE.hiddenContentPage = { showPage() { pages++; } };
  h.load('enhanced/settingspanel/ui-panel-hidden-content.js');
  h.JE.internals.enhancedUi.wireHiddenContentListeners({ resetAutoCloseTimer() {} });
  h.click(h.document.getElementById('manageHiddenContentBtn'));
  if (nativeTab) {
    assert.equal(h.window.location.hash, '#/home?tab=0&jeTab=hidden-content');
    assert.equal(pages, 0);
  } else {
    assert.equal(pages, 1);
  }
});

// ------------------------------------------------------------------ fix round 2 (review UX5R-1, UX5R-2)

/**
 * Captures the panel's 15-second auto-close timers. `expire()` runs every pending one at its deadline (none when the
 * panel has turned auto-close off) and returns how many ran; `pending()` counts them.
 */
function capturePanelTimer(h) {
  const nativeSet = h.window.setTimeout.bind(h.window);
  const nativeClear = h.window.clearTimeout.bind(h.window);
  const timers = new Map();
  h.window.setTimeout = (callback, ms, ...args) => {
    const id = nativeSet(callback, ms, ...args);
    if (ms === 15000) timers.set(id, callback);
    return id;
  };
  h.window.clearTimeout = id => { timers.delete(id); nativeClear(id); };
  const expire = () => {
    const due = [...timers];
    for (const [id, callback] of due) { nativeClear(id); timers.delete(id); callback(); }
    return due.length;
  };
  expire.pending = () => timers.size;
  return expire;
}
const later = (h, ms = 5) => new Promise(r => h.window.setTimeout(r, ms));

test('UX5R-1 control: a panel opened with the pointer that never takes the focus still closes at its deadline', async t => {
  const h = panelPage(t), expire = capturePanelTimer(h);
  await openPanel(h); await later(h);
  assert.equal(expire(), 1, 'its auto-close was pending');
  await settle();
  assert.equal(h.panel(), null);
});

test('UX5R-1: keyboard use inside the panel turns auto-close off for that open; moving the pointer does not turn it back on', async t => {
  const h = panelPage(t), expire = capturePanelTimer(h);
  const panel = await openPanel(h); await later(h);
  h.key(panel.querySelector('#jePanelSearch'), 'ArrowDown'); await settle();
  for (let i = 0; i < 10; i++) expire();
  assert.ok(h.panel(), 'a keyboard reader is not dismissed');
  h.document.dispatchEvent(new h.window.MouseEvent('mousemove', { bubbles: true }));
  panel.dispatchEvent(new h.window.MouseEvent('mouseleave'));
  for (let i = 0; i < 3; i++) expire();
  assert.equal(expire.pending(), 0, 'no deadline is armed again');
  assert.ok(h.panel(), 'still open after the pointer moved and left');
});

test('UX5R-1: the auto-close deadline does not close the panel under the release notes it opened', async t => {
  const h = panelPage(t), expire = capturePanelTimer(h);
  const panel = await openPanel(h);
  h.window.fetch = async () => ({ ok: true, json: async () => ({ body: 'Notes', tag_name: 'v1', published_at: '2026-01-01', html_url: 'https://example.test/release' }) });
  h.load('enhanced/settingspanel/ui-release-notes.js');
  const opener = panel.querySelector('#releaseNotesBtn'); opener.focus();
  h.pressIn(opener, e => h.JE.internals.enhancedUi.showReleaseNotesNotification(e));
  await settle();
  const notes = h.document.getElementById('jellyfin-release-notes-notification');
  assert.ok(h.JE.isTopmostSurface(notes));
  assert.ok(panel.hasAttribute('inert'));
  h.document.dispatchEvent(new h.window.MouseEvent('mousemove', { bubbles: true }));
  for (let i = 0; i < 5; i++) expire();
  await settle();
  assert.ok(h.panel(), 'the settings panel stays under its child');
  assert.ok(h.JE.isTopmostSurface(notes));
});

test('UX5R2-1: a panel opened from the keyboard stays open for a reader that sends no further event (screen reader)', async t => {
  const h = panelPage(t), expire = capturePanelTimer(h);
  h.opener.focus();
  h.opener.addEventListener('keydown', e => h.JE.showEnhancedPanel(e), { once: true });
  h.key(h.opener, '?', { shiftKey: true });
  await settle();
  const panel = h.panel();
  assert.ok(panel, 'the keyboard opened it');
  await later(h);
  assert.ok(panel.contains(h.document.activeElement));
  // A screen reader's browse cursor reads the accessibility tree: no keydown or focus reaches the page.
  for (let i = 0; i < 3; i++) expire();
  assert.ok(h.panel(), 'the dialog stays while its reader reads');
});

test('UX5R2-1: a boundary Shift+Tab the surface stack takes, right after dragging the panel, turns auto-close off', async t => {
  const h = panelPage(t), expire = capturePanelTimer(h);
  const panel = await openPanel(h); await later(h);
  const close = panel.querySelector('#closeSettingsPanel');
  h.trusted(panel.querySelector('.panel-header'), new h.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  h.document.dispatchEvent(new h.window.MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }));
  h.document.dispatchEvent(new h.window.MouseEvent('mouseup', { bubbles: true }));
  panel.dispatchEvent(new h.window.MouseEvent('mouseleave'));
  close.focus();
  h.key(close, 'Tab', { shiftKey: true });
  assert.notEqual(h.document.activeElement, close, 'the stack moved focus inside the dialog');
  for (let i = 0; i < 3; i++) expire();
  assert.ok(h.panel(), 'keyboard navigation right after a drag keeps it open');
});

test('UX5R-2: a real episode listed on an absent season keeps its "Ends at"; the missing ones do not show one', async t => {
  const h = await episodePage(t, 'season');
  const missing = h.page.querySelector('.listItem');
  const real = missing.cloneNode(true);
  real.dataset.id = '1234567890abcdef1234567890abcdef'; real.removeAttribute('data-je-absent');
  missing.after(real); await settle(3);
  assert.equal(shown(h, missing.querySelector('.endsAt')), false, 'a missing episode has no estimate');
  assert.equal(shown(h, real.querySelector('.endsAt')), true, 'a real file among absent season rows keeps its estimate');
  // A missing row Jellyfin turns into the library episode that arrived (status-episodes points it there) gets its own.
  missing.dataset.id = 'fedcba0987654321fedcba0987654321'; await settle(3);
  assert.equal(shown(h, missing.querySelector('.endsAt')), true);
});

test('UX5R-2 control: a library page shown after an absent one keeps the title\'s and rows\' "Ends at"', async t => {
  const h = await episodePage(t);
  h.window.location.hash = '#/details?id=1234567890abcdef1234567890abcdef';
  await h.JE.internals.nativeDetails.onView();
  assert.equal(h.page.classList.contains('je-native-absent'), false);
  assert.equal(h.page.querySelectorAll('[data-je-absent]').length, 0, 'no absent marks left behind');
  for (const ends of h.page.querySelectorAll('.endsAt')) assert.equal(shown(h, ends), true);
});

// ------------------------------------------------------------------ Phase 2 batch 3 UI leftovers (F54, F56, F58)

/** The panel's Hidden Content wiring alone, with a Manage button, in the delivery mode `config` names. */
function manageButton(t, config, { html = '', apiClient } = {}) {
  const h = createHarness({
    html: `${html}<button id="manageHiddenContentBtn">Manage</button>`,
    JE: { pluginConfig: { HiddenContentEnabled: true, ...config }, t: key => key, nativeTabs: { register() {} } },
    ...(apiClient ? { apiClient } : {}),
  });
  t.after(() => h.close());
  const calls = { pages: 0, manager: 0 };
  h.JE.hiddenContent = { updateSettings() {}, getSettings: () => ({}), showManagementPanel() { calls.manager++; } };
  h.JE.hiddenContentPage = { showPage() { calls.pages++; } };
  h.load('enhanced/settingspanel/ui-panel-hidden-content.js');
  h.JE.internals.enhancedUi.wireHiddenContentListeners({ resetAutoCloseTimer() {} });
  return { ...h, calls, button: h.document.getElementById('manageHiddenContentBtn') };
}

test('F54: in Plugin Pages mode Manage hidden content opens the companion\'s Hidden Content page', async t => {
  const href = '#/userpluginsettings.html?pageUrl=/JellyfinEnhanced/hiddenContentPage';
  const h = manageButton(t, { HiddenContentUsePluginPages: true },
    { html: `<div class="mainDrawer"><a is="emby-linkbutton" data-itemid="Jellyfin.Plugin.JellyfinEnhanced.HiddenContentPage" href="${href}" data-plugin-pages="true">Hidden Content</a></div>` });
  h.click(h.button);
  await settle();
  assert.equal(h.window.location.hash, href);
  assert.deepEqual(h.calls, { pages: 0, manager: 0 });
});

test('F54: in Plugin Pages mode on Jellyfin 12\'s Modern layout (the companion\'s entry is a user-menu item) Manage opens that page', async t => {
  const href = '#/userpluginsettings.html?pageUrl=/JellyfinEnhanced/hiddenContentPage';
  const h = manageButton(t, { HiddenContentUsePluginPages: true },
    { html: `<div role="menu" hidden><a class="MuiMenuItem-root" role="menuitem" href="#/userpluginsettings.html?pageUrl=/Other/page" data-plugin-pages="true">Other</a><a class="MuiMenuItem-root" role="menuitem" href="${href}" data-plugin-pages="true">Hidden Content</a></div>` });
  h.click(h.button);
  await settle();
  assert.equal(h.window.location.hash, href);
  assert.deepEqual(h.calls, { pages: 0, manager: 0 });
});

test('F54 control: in Plugin Pages mode with no companion entry drawn, Manage opens JE\'s own page (which then shows)', async t => {
  const h = manageButton(t, { HiddenContentUsePluginPages: true });
  h.click(h.button);
  await settle();
  assert.deepEqual(h.calls, { pages: 1, manager: 0 });
});

test('F54: in Custom Tabs mode Manage hidden content opens the Home tab whose entry holds the Hidden Content marker', async t => {
  const reads = [];
  const h = manageButton(t, { HiddenContentUseCustomTabs: true }, { apiClient: {
    getUrl: path => `http://jellyfin.test/${path}`,
    fetch: async (request) => { reads.push(request.url); return [{ Title: 'Bookmarks', ContentHtml: '<div class="sections bookmarks"></div>' }, { Title: 'Hidden', ContentHtml: '<div class="jellyfinenhanced hidden-content"></div>' }]; },
  } });
  h.click(h.button);
  await settle();
  assert.deepEqual(reads, ['http://jellyfin.test/CustomTabs/Config']);
  assert.equal(h.window.location.hash, '#/home?tab=3', 'Custom Tabs puts its entries at tab 2 onwards, in order');
  assert.deepEqual(h.calls, { pages: 0, manager: 0 });
});

for (const [name, fetch] of [['no entry holds the marker', async () => [{ ContentHtml: '<div class="sections bookmarks"></div>' }]], ['the entries can\'t be read', async () => { throw new Error('403'); }]]) {
  test(`F54: in Custom Tabs mode, when ${name}, Manage hidden content opens the manager window`, async t => {
    const h = manageButton(t, { HiddenContentUseCustomTabs: true }, { apiClient: { getUrl: path => path, fetch } });
    const before = h.window.location.hash;
    h.click(h.button);
    await settle();
    assert.equal(h.window.location.hash, before);
    assert.deepEqual(h.calls, { pages: 0, manager: 1 });
  });
}

test('F56 (UX5R-3 probe): the fallback Hidden Content manager is on top of the settings panel both on the stack and as painted', async t => {
  const h = panelPage(t);
  h.JE.pluginConfig.HiddenContentEnabled = true;
  h.JE.hiddenContent = { getSettings: () => ({}), getHiddenCount: () => 0 };
  h.JE.internals.hiddenContent = { getHiddenData: () => ({ items: {} }) };
  h.JE.helpers = { addCSS: (id, css) => { const style = h.document.createElement('style'); style.textContent = css; h.document.head.append(style); } };
  h.load('enhanced/hiddencontent/hidden-content-styles.js');
  h.JE.internals.hiddenContent.injectCSS();
  h.load('enhanced/hiddencontent/hidden-content-panel.js');
  const panel = await openPanel(h);
  const opener = panel.querySelector('#manageHiddenContentBtn'); opener.focus();
  h.pressIn(opener, e => h.JE.internals.hiddenContent.showManagementPanel(e)); await settle();
  const overlay = h.document.querySelector('.je-hidden-management-overlay');
  assert.ok(h.JE.isTopmostSurface(overlay));
  assert.ok(panel.hasAttribute('inert'));
  const overlayZ = Number(h.window.getComputedStyle(overlay).zIndex), panelZ = Number(h.window.getComputedStyle(panel).zIndex);
  assert.ok(overlayZ > panelZ, `manager z-index ${overlayZ} must exceed settings ${panelZ}`);
});

// F58 (UX5R2-2 probes, ported): a mark lasts only while its reason does.
test('F58: a row that loses its id loses its absent mark', async t => {
  const h = await episodePage(t, 'season');
  const row = h.page.querySelector('.listItem');
  assert.ok(row.hasAttribute('data-je-absent'));
  row.removeAttribute('data-id'); await settle(3);
  assert.equal(row.hasAttribute('data-je-absent'), false, 'unidentified row retained absent classification');
  // The same synthetic id back: marked again.
  row.dataset.id = h.JE.titleDetails.syntheticId('episode', 1437, 1, 2); await settle(3);
  assert.ok(row.hasAttribute('data-je-absent'));
});

test('F58: a marked row moved under a library card can\'t hide that card\'s estimate', async t => {
  const h = await episodePage(t, 'season');
  const row = h.page.querySelector('.listItem');
  const card = h.document.createElement('div'); card.className = 'card'; card.dataset.id = '1234567890abcdef1234567890abcdef';
  h.page.append(card); row.removeAttribute('data-id'); card.append(row); await settle(3);
  assert.equal(shown(h, row.querySelector('.endsAt')), true, 'stale absent descendant hides physical-card estimate');
});

test('F58: a marked row taken off the page keeps no mark, during the page and after it is disposed', async t => {
  const h = await episodePage(t, 'season');
  const row = h.page.querySelector('.listItem');
  const line = h.page.querySelector('.itemMiscInfo-primary');
  assert.ok(line.hasAttribute('data-je-absent'));
  row.remove(); await settle(3);
  assert.equal(row.hasAttribute('data-je-absent'), false, 'detached while the page is shown');
  const detachedLine = line; detachedLine.remove();
  h.window.location.hash = '#/details?id=1234567890abcdef1234567890abcdef';
  await h.JE.internals.nativeDetails.onView();
  assert.equal(row.hasAttribute('data-je-absent'), false, 'detached row retained a mark across page disposal');
  assert.equal(detachedLine.hasAttribute('data-je-absent'), false, 'detached information line keeps no mark');
});
