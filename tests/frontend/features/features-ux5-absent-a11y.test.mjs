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
  <div class="listItem"><div class="listItemMediaInfo"><div class="mediaInfoItem">46m</div><div class="mediaInfoItem endsAt">Ends at 10:20 PM</div></div></div></div></div>`;

/** The page adapter on an absent episode's page (Firefly S1E1). */
async function episodePage(t) {
  const h = createHarness({
    html: PAGE, url: 'http://jellyfin.test/web/index.html#/home',
    JE: {
      pluginConfig: { NativeAbsentDetails: { Enabled: true, ContractVersion: 1 } }, t: key => key,
      core: { api: { plugin: async () => null } }, session: { onUserChange() {} },
      arrStatus: { enabled: () => true, subscribe: () => () => {} }, arrAsk: { enabled: () => true },
    },
    apiClient: { serverId: () => SERVER, getItem: async (_u, id) => ({ Id: id, Type: 'Episode', Name: 'The Train Job', SeriesName: 'Firefly', ParentIndexNumber: 1, IndexNumber: 1, ProviderIds: {} }) },
  });
  h.window.Emby = { Page: { show() {} } };
  t.after(() => h.close());
  h.load('core/ui-kit.js');
  h.load('jellyseerr/nativedetails/native-details.js');
  const id = h.JE.titleDetails.syntheticId('episode', 1437, 1, 1);
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
