import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, jsRoot } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));

const KIDS = '22222222222222222222222222222222';
const LOCKED = 'cccccccccccccccccccccccccccccccc';

// Panel controls outside the Media Tags hub that the settings wiring binds by id.
const otherToggles = ['autoPauseToggle', 'autoResumeToggle', 'autoPipToggle', 'autoSkipIntroToggle', 'autoSkipOutroToggle',
  'randomButtonToggle', 'randomUnwatchedOnly', 'randomScopeCurrentContainer', 'showWatchProgressToggle', 'showFileSizesToggle',
  'removeContinueWatchingToggle', 'pauseScreenToggle', 'disableCustomSubtitleStyles', 'longPress2xEnabled', 'randomIncludeMovies', 'randomIncludeShows'];

/**
 * The real panel host (ui-panel.js) around the real Media Tags hub with
 * every tag section in it (group editor, rules and locks, live preview) and
 * the real settings wiring; the other panel sections are stubbed. The panel
 * nav and search come from the host. jsdom has no layout, so element boxes
 * are faked (the host skips invisible controls when it keeps Tab inside).
 * @param {import('node:test').TestContext} t
 * @param {{stored?: object, plugin?: object, admin?: boolean, observer?: boolean}} [options]
 */
function setup(t, { stored = {}, plugin = {}, admin = false, observer = false } = {}) {
  const writes = [], requests = [], observers = [];
  class FakeIntersectionObserver {
    constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
    observe(el) { this.targets.push(el); }
    disconnect() { this.disconnected = true; this.targets = []; }
    fire() { this.callback(this.targets.map(target => ({ target, isIntersecting: true }))); }
  }
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  const h = createHarness({
    html: otherToggles.map(id => `<input type="checkbox" id="${id}">`).join('') + '<input id="pauseScreenDelayInput"><button id="releaseNotesBtn"></button><button id="opener">open</button>',
    JE: {
      pluginConfig: { HelpPanelAutocloseDelay: 60000, ...plugin },
      userConfig: { settings: { tagLayoutSettingsVersion: 1, qualityTagsEnabled: true, ratingTagsEnabled: true, statusTagsEnabled: true, ...stored, isAdmin: admin }, shortcuts: { Shortcuts: [] } },
      currentSettings: {},
      t: (key, params) => (params ? `${key}:${Object.values(params).join('|')}` : key),
      toast() {}, keyListener() {}, initializeShortcuts() {}, state: { activeShortcuts: { x: 1 } }, pauseScreenInstance: {},
      themer: { getThemeVariables: () => ({ panelBg: '#000', secondaryBg: '#111', primaryAccent: '#0af', altAccent: '#222', blur: '0px', textColor: '#fff', logo: '' }) },
    },
    apiClient: {
      getUrl: (path, query) => `http://jellyfin.test/${path}${query ? `?${new URLSearchParams(query)}` : ''}`,
      ajax: async request => {
        requests.push(request.url);
        if (request.type !== 'GET') { writes.push(JSON.parse(request.data)); return null; }
        const url = new URL(request.url);
        if (url.pathname.includes('/user-settings/')) return null;
        if (url.pathname.endsWith('/UserViews')) return { Items: [{ Id: KIDS, Name: 'Kids' }] };
        if (url.pathname.endsWith('/Genres')) return { Items: [{ Name: 'Drama' }] };
        if (url.pathname.includes('/Items')) return { Items: [{ Id: LOCKED, Name: 'Locked Show', Type: 'Series' }] };
        if (url.pathname.endsWith('/tag-styles')) return { quality: { '4K': { background: 'rgba(1, 2, 3, 0.5)', color: 'rgba(255, 255, 255, 1)' } } };
        return null;
      },
    },
    globals: { matchMedia: () => media, ...(observer ? { IntersectionObserver: FakeIntersectionObserver } : {}) },
  });
  t.after(() => h.close());
  // Boxes for every element: jsdom lays nothing out.
  h.window.Element.prototype.getClientRects = function () { return [{ width: 1, height: 1 }]; };
  for (const file of ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-layout-styles.js', 'enhanced/config.js', 'enhanced/icons.js', 'enhanced/helpers.js']) h.load(file);
  h.JE.currentSettings = h.JE.loadSettings();
  h.JE.escapeHtml = h.JE.core.ui.escapeHtml;
  for (const file of ['ui-panel-settings.js', 'ui-panel-tag-editor.js', 'ui-panel-tag-looks.js', 'ui-panel-tag-preview.js', 'ui-panel-media-tags.js']) h.load(`enhanced/settingspanel/${file}`);
  const ui = h.JE.internals.enhancedUi;
  // The host's frame (header, nav with search, main) around the real hub pane.
  ui.buildPanelHtml = ctx => `<div class="panel-header"><div id="jePanelTitle">JE</div><button id="closeSettingsPanel">x</button></div>`
    + '<div class="je-panel-body"><nav class="je-panel-nav"><input id="jePanelSearch" type="search"><ul id="jePanelSearchResults" hidden></ul><div class="je-panel-nav-items"></div></nav>'
    + `<div class="je-panel-main"><button id="jePanelBack"></button><section class="je-pane" data-pane="ui"><h3 class="je-pane-title">UI</h3></section>${ui.buildMediaTagsHubHtml(ctx)}</div></div>`;
  for (const name of ['wireShortcutEditor', 'wireHiddenContentListeners', 'wireLanguageControls']) ui[name] = () => {};
  h.load('enhanced/settingspanel/ui-panel.js');
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const $ = selector => h.document.querySelector(selector);
  return {
    ...h, ui, writes, requests, observers, settle, $,
    saved: () => writes.at(-1),
    async open() { await h.JE.showEnhancedPanel(); await settle(); await settle(); },
    tab: id => $(`#jeMthTab-${id}`),
    selected: () => $('[role="tab"][aria-selected="true"]')?.dataset.tab,
    key(el, key, init = {}) { el.dispatchEvent(new h.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); },
    click(el) { el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true })); },
    async change(el, value) {
      if (typeof value === 'boolean') el.checked = value; else el.value = value;
      el.dispatchEvent(new h.window.Event('change', { bubbles: true })); await settle();
    },
    async search(text) {
      const input = $('#jePanelSearch');
      input.value = text;
      input.dispatchEvent(new h.window.Event('input', { bubbles: true }));
      return Array.from(h.document.querySelectorAll('#jePanelSearchResults button'), b => ({ button: b, label: b.firstChild.textContent, path: b.querySelector('span').textContent }));
    },
  };
}

test('the hub is a real tablist: roles, names, roving tabindex and Left/Right/Home/End with automatic activation', async t => {
  const h = setup(t);
  await h.open();
  const tablist = h.$('#jeMediaTagsHub [role="tablist"]');
  assert.equal(tablist.getAttribute('aria-label'), 'panel_media_tags_title');
  const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
  assert.deepEqual(tabs.map(tab => tab.dataset.tab), ['layout', 'groups', 'badges', 'rules']);
  for (const tab of tabs) {
    const panel = h.$(`#${tab.getAttribute('aria-controls')}`);
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), tab.id);
    assert.equal(tab.tagName, 'BUTTON');
    // The phone's short label is part of the accessible name (checked on the English strings).
    const short = en[tab.querySelector('.je-mth-tab-short').textContent];
    const name = en[tab.getAttribute('aria-label')];
    assert.ok(short && name && name.toLowerCase().includes(short.toLowerCase()), `"${short}" is in "${name}"`);
  }
  assert.equal(h.tab('badges').getAttribute('aria-label'), 'panel_media_tags_tab_badges');
  assert.equal(h.tab('badges').querySelector('.je-mth-tab-short').textContent, 'panel_media_tags_tab_badges_short');
  assert.deepEqual(tabs.map(tab => tab.tabIndex), [0, -1, -1, -1], 'one tab stop');
  assert.equal(h.$('#jeMthPanel-layout').hidden, false);
  assert.equal(h.$('#jeMthPanel-groups').hidden, true);

  h.tab('layout').focus();
  h.key(h.tab('layout'), 'ArrowRight');
  assert.equal(h.document.activeElement, h.tab('groups'));
  assert.equal(h.selected(), 'groups');
  assert.deepEqual(tabs.map(tab => tab.tabIndex), [-1, 0, -1, -1]);
  assert.equal(h.$('#jeMthPanel-groups').hidden, false);
  assert.equal(h.$('#jeMthPanel-layout').hidden, true);
  h.key(h.tab('groups'), 'End');
  assert.equal(h.selected(), 'rules');
  h.key(h.tab('rules'), 'ArrowRight');
  assert.equal(h.selected(), 'layout', 'wraps around');
  h.key(h.tab('layout'), 'ArrowLeft');
  assert.equal(h.selected(), 'rules');
  h.key(h.tab('rules'), 'Home');
  assert.equal(h.document.activeElement, h.tab('layout'));
  h.click(h.tab('badges'));
  assert.equal(h.selected(), 'badges');
  assert.equal(h.$('#jeMediaTagsHub').dataset.tab, 'badges');
});

test('admin-only content is never rendered for a user; presets disallowed removes Colours', async t => {
  const user = setup(t, { plugin: { TagStylesAllowUserPreset: false } });
  await user.open();
  assert.equal(user.tab('server'), null);
  assert.equal(user.$('#jeMthPanel-server'), null);
  assert.equal(user.tab('colours'), null, 'no Colours tab without presets');
  assert.equal(user.$('[data-je-config-link]'), null, 'no configuration page link anywhere');
  assert.equal(user.$('.je-mth-admin'), null);
  assert.deepEqual(await user.search('server defaults'), []);
  assert.deepEqual(await user.search('colours editor'), []);
});

test('a user with presets allowed gets Colours with seven tiles painted from each preset\'s real palette', async t => {
  const h = setup(t, { plugin: { TagStylesAllowUserPreset: true, TagStylePreset: 'glass' }, stored: { tagStylePreset: 'mono' } });
  await h.open();
  assert.ok(h.tab('colours'));
  assert.equal(h.$('.je-mth-admin'), null, 'no colour editor card for a user');
  const tiles = Array.from(h.document.querySelectorAll('input[name="jeTagPreset"]'));
  assert.deepEqual(tiles.map(r => r.value), ['', 'default', 'glass', 'outline', 'dark', 'light', 'mono']);
  assert.equal(h.$('input[name="jeTagPreset"]:checked').value, 'mono');
  assert.match(h.$('#jeTagPresetChoice').textContent, /panel_settings_ui_tag_style_preset_server:panel_settings_ui_tag_style_preset_glass/);
  assert.equal(h.requests.filter(u => u.includes('/tag-styles')).length, 0, 'palettes load only when Colours shows');
  h.click(h.tab('colours'));
  await h.settle();
  const styleRequests = h.requests.filter(u => u.includes('/tag-styles'));
  assert.equal(styleRequests.length, 7);
  assert.ok(styleRequests.includes('http://jellyfin.test/JellyfinEnhanced/tag-styles?preset=glass'));
  assert.ok(styleRequests.includes('http://jellyfin.test/JellyfinEnhanced/tag-styles'), 'the server default tile asks for the admin\'s');
  const chip = h.$('.je-mth-preset-chips[data-preset="glass"] [data-chip="quality"]');
  assert.equal(chip.style.getPropertyValue('background'), 'rgba(1, 2, 3, 0.5)');
  assert.equal(chip.style.getPropertyPriority('background'), 'important', 'the user\'s own preset stylesheet cannot bleed into another tile');
  await h.change(h.$('input[name="jeTagPreset"][value="glass"]'), true);
  assert.equal(h.saved().tagStylePreset, 'glass');
});

test('an admin gets the Server tab with four configuration page pointers and the colour editor card', async t => {
  const h = setup(t, { admin: true, plugin: { TagStylesAllowUserPreset: false, StatusTagsJustAddedDays: 14 } });
  await h.open();
  assert.deepEqual(Array.from(h.document.querySelectorAll('[role="tab"]'), tab => tab.dataset.tab), ['layout', 'groups', 'badges', 'rules', 'colours', 'server']);
  assert.equal(h.tab('server').getAttribute('aria-label'), 'panel_media_tags_tab_server_name:panel_media_tags_tab_server');
  const links = Array.from(h.document.querySelectorAll('#jeMthPanel-server a[data-je-config-link]'));
  assert.deepEqual(links.map(a => new URLSearchParams(a.href.split('?')[1]).get('jeSection')),
    ['tagLayoutAdminDetails', 'tagStylesEnabled', 'tagCacheServerMode', 'nativePosterTagsEnabled']);
  for (const a of links) assert.match(a.href, /#\/configurationpage\?name=Jellyfin%20Enhanced&jeSection=/);
  assert.match(h.$('#jeMthPanel-colours').textContent, /panel_media_tags_colours_presets_off/, 'admins keep Colours for the editor even with presets off');
  assert.ok(h.$('#jeMthPanel-colours .je-mth-admin a[data-je-config-link]'));
  assert.match(h.$('#jeMthPanel-badges').textContent, /panel_media_tags_badge_window_added:14/, 'the admin\'s windows are shown');
  assert.ok(h.$('#jeMthPanel-badges a[href*="jeSection=statusTagsAdminDetails"]'), 'and admins can go and change them');
  // Following a pointer closes the panel (the configuration page replaces the view).
  links[0].addEventListener('click', e => e.preventDefault());
  h.click(links[0]);
  assert.equal(h.$('#jellyfin-enhanced-panel'), null);
});

test('a user sees the status windows read-only, without the configuration page link', async t => {
  const h = setup(t, { plugin: { StatusTagsNewReleaseDays: 21 } });
  await h.open();
  assert.match(h.$('#jeMthPanel-badges').textContent, /panel_media_tags_badge_window_new:21/);
  assert.match(h.$('#jeMthPanel-badges').textContent, /panel_media_tags_badge_window_added:7/, 'the built-in window when the admin set none');
  assert.equal(h.$('#jeMthPanel-badges a'), null);
});

test('every hub control keeps writing the setting it always did', async t => {
  const h = setup(t, { plugin: { NativePosterTagsEnabled: true, TagStylesAllowUserPreset: true } });
  await h.open();
  await h.change(h.$('input[name="jeTagLayout"][value="caption"]'), true);
  assert.equal(h.saved().tagLayout, 'caption');
  assert.equal(h.$('#jeMthLayoutDesc').textContent, 'panel_settings_ui_tag_layout_caption', 'the selected tile is described');
  await h.change(h.$('input[name="jeTagDensity"][value="compact"]'), true);
  assert.equal(h.saved().tagLabelDensity, 'compact');
  for (const [id, key] of [['tagsHideOnHoverToggle', 'tagsHideOnHover'], ['peopleTagsToggle', 'peopleTagsEnabled'], ['showAudioLanguagesToggle', 'showAudioLanguages']]) {
    const box = h.$(`#${id}`);
    await h.change(box, !box.checked);
    assert.equal(h.saved()[key], box.checked, key);
  }
  await h.change(h.$('#nativePosterTagsToggle'), false);
  assert.equal(h.saved().useNativePosterTags, false);
  // A badge switch re-initialises the status tags, which removes every status overlay on the page.
  const reinit = h.JE.reinitializeStatusTags = () => h.document.querySelectorAll('.status-overlay-container').forEach(el => el.remove());
  for (const key of ['statusTagsJustAdded', 'statusTagsNewRelease', 'statusTagsTrending', 'statusTagsSchedule', 'statusTagsMilestones', 'statusTagsSeriesStatus']) {
    const box = h.$(`#${key}Toggle`);
    await h.change(box, !box.checked);
    assert.equal(h.saved()[key], box.checked, key);
  }
  assert.ok(reinit);
  assert.equal(h.document.querySelectorAll('.je-mth-badge-sample .status-tag').length, 6, 'the badge samples survive it');
  assert.equal(h.$('.je-mtp-sample[data-sample="series"] .status-tag')?.textContent, 'status_tag_returning', 'and the preview redraws its badge (Series status is on now)');
  assert.equal(h.$('.je-mtp-sample[data-sample="movie"] .status-tag'), null, 'the movie\'s three families are all off');
  // The Status master switch is the Status row's box on Groups: the badges tab says when it is off.
  await h.change(h.$('#statusTagsToggle'), false);
  assert.equal(h.saved().statusTagsEnabled, false);
  assert.equal(h.$('#jeMthBadgesOff').hidden, false);
  await h.change(h.$('#statusTagsToggle'), true);
  assert.equal(h.$('#jeMthBadgesOff').hidden, true);
});

test('the native apps switch is not rendered while the server feature is off', async t => {
  const h = setup(t, { plugin: { NativePosterTagsEnabled: false } });
  await h.open();
  assert.equal(h.$('#nativePosterTagsToggle'), null);
  assert.equal(h.document.querySelectorAll('#jeMthPanel-layout .je-mth-switch').length, 3);
});

test('the settings search finds hub controls by their visible label, opens their tab (and group) and focuses them', async t => {
  const h = setup(t, { plugin: { TagStylesAllowUserPreset: true }, stored: { tagLookRules: [{ id: 'kids', enabled: true, when: [{ field: 'library', value: KIDS }], layout: 'caption', density: 'compact' }] } });
  await h.open();
  await h.settle();

  let results = await h.search('trending');
  const trending = results.find(r => r.label === 'panel_media_tags_badge_trending');
  assert.ok(trending, results.map(r => r.label).join(', '));
  assert.equal(trending.path, 'panel_media_tags_title › panel_media_tags_tab_badges');
  h.click(trending.button);
  assert.equal(h.selected(), 'badges');
  assert.equal(h.document.activeElement, h.$('#statusTagsTrendingToggle'));

  results = await h.search('show up to language');
  assert.equal(results[0].path, 'panel_media_tags_title › panel_media_tags_tab_groups › panel_settings_ui_tag_group_language');
  h.click(results[0].button);
  assert.equal(h.selected(), 'groups');
  const row = h.$('.je-tge-row[data-group="language"]');
  assert.equal(row.querySelector('.je-tge-expand').getAttribute('aria-expanded'), 'true', 'the group is opened');
  assert.ok(row.querySelector('.je-tge-stepper').contains(h.document.activeElement), 'its stepper has focus');

  // Enter runs the first match; contextual names are indexed too.
  results = await h.search('move language up');
  assert.equal(results[0].label, 'panel_settings_ui_tag_editor_move_up:panel_settings_ui_tag_group_language');
  h.key(h.$('#jePanelSearch'), 'Enter');
  assert.equal(h.document.activeElement, h.$('.je-tge-row[data-group="language"] [data-dir="up"]'));

  for (const [query, label, tab] of [['compact', 'panel_settings_ui_tag_density_compact', 'layout'], ['caption', 'tag_looks_layout_caption', 'layout'],
    ['people', 'panel_settings_ui_people_tags', 'layout'], ['edit rule', 'tag_looks_edit_named:tag_looks_when:tag_looks_cond_library:Kids', 'rules'],
    ['glass', 'panel_settings_ui_tag_style_preset_glass', 'colours'], ['critic', 'panel_settings_ui_tag_editor_rating_critic', 'groups'],
    ['condition 1 field', 'tag_looks_condition_field:1', 'rules']]) {
    results = await h.search(query);
    const hit = results.find(r => r.label === label);
    assert.ok(hit, `${query}: ${results.map(r => r.label).join(', ')}`);
    h.click(hit.button);
    assert.equal(h.selected(), tab, query);
    const active = h.document.activeElement;
    assert.ok(h.$(`#jeMthPanel-${tab}`).contains(active), `${query} focuses a control on its tab`);
  }
  // Every match opens the Media Tags pane itself first.
  h.$('.je-pane[data-pane="ui"]').classList.add('active');
  h.$('.je-pane[data-pane="media-tags"]').classList.remove('active');
  results = await h.search('trending');
  h.click(results.find(r => r.label === 'panel_media_tags_badge_trending').button);
  assert.ok(h.$('.je-pane[data-pane="media-tags"]').classList.contains('active'));
  assert.equal((await h.search('')).length, 0);
  assert.equal(h.$('#jePanelSearchResults').hidden, true);
});

test('search → Unlock on the first visit to Rules & locks focuses the live control, not the one the tab redrew', async t => {
  const h = setup(t, { stored: { tagLayoutLocks: { [LOCKED]: { layout: 'bands', density: 'full', lockedAt: 5 } } } });
  await h.open();
  assert.equal(h.selected(), 'layout', 'Rules & locks not visited yet');
  const results = await h.search('unlock');
  const hit = results.find(r => r.label === `tag_looks_unlock_named:${LOCKED}`);
  assert.ok(hit, results.map(r => r.label).join(', '));
  const captured = h.$(`[data-je-focus-key="unlock-${LOCKED}"]`);
  h.click(hit.button);
  assert.equal(h.selected(), 'rules');
  const live = h.$(`[data-je-focus-key="unlock-${LOCKED}"]`);
  assert.notEqual(live, captured, 'the first visit redrew the locked items');
  assert.equal(captured.isConnected, false);
  assert.equal(h.document.activeElement, live, 'focus is on the live Unlock');
  // The titles arrive and the list redraws again: focus follows the same item.
  await h.settle(); await h.settle();
  const titled = h.$(`[data-je-focus-key="unlock-${LOCKED}"]`);
  assert.equal(titled.getAttribute('aria-label'), 'tag_looks_unlock_named:Locked Show');
  assert.equal(h.document.activeElement, titled);
});

test('a search result whose control is gone falls back to a connected stand-in on its tab', async t => {
  const h = setup(t, { stored: { tagLayoutLocks: { [LOCKED]: { layout: 'bands', density: 'full', lockedAt: 5 } } } });
  await h.open();
  const results = await h.search('unlock');
  const hit = results.find(r => r.label === `tag_looks_unlock_named:${LOCKED}`);
  // The item is unlocked elsewhere before the result is chosen.
  h.JE.core.tagLook.unlockItems([LOCKED]);
  h.click(hit.button);
  await h.settle();
  const active = h.document.activeElement;
  assert.equal(h.selected(), 'rules');
  assert.ok(active.isConnected, 'focus is on a connected element');
  assert.ok(h.$('#jeMthPanel-rules').contains(active) || active === h.tab('rules'), `${active.outerHTML.slice(0, 60)} is on the Rules & locks tab`);
});

test('the preview names where each sample\'s look comes from, through the resolver the cards use', async t => {
  const rule = { id: 'r1', enabled: true, when: [{ field: 'library', value: KIDS }, { field: 'type', value: 'Episode' }], layout: 'caption', density: 'compact' };
  const h = setup(t, { stored: { tagLookRules: [rule], tagLayoutLocks: { [LOCKED]: { layout: 'bands', density: 'full', lockedAt: 5 } } } });
  await h.open();
  const meta = key => h.$(`.je-mtp-sample[data-sample="${key}"] .je-mtp-meta`).textContent;
  const host = key => h.$(`.je-mtp-sample[data-sample="${key}"] .je-tag-host`);
  assert.equal(meta('movie'), 'tag_looks_type_movie · panel_media_tags_preview_source_defaulttag_looks_outcome:tag_looks_layout_corners|panel_settings_ui_tag_density_full');
  assert.match(meta('series'), /🔒 panel_media_tags_preview_source_lock/);
  assert.equal(host('series').dataset.jeLayout, 'bands', 'the lock\'s look');
  assert.equal(h.$('.je-mtp-sample[data-sample="series"] .je-mtp-card').dataset.id, LOCKED, 'the series sample stands in for the locked item');
  assert.match(meta('episode'), /panel_media_tags_preview_source_rule:1/);
  assert.equal(host('episode').dataset.jeLayout, 'caption', 'the rule\'s look');
  assert.ok(h.$('.je-mtp-sample[data-sample="episode"] .je-tag-caption'), 'caption chips go under the still');
  assert.match(h.$('.je-mtp-foot').textContent, /panel_media_tags_preview_precedence/);
  assert.equal(h.document.querySelectorAll('.je-tag-host').length, 3, 'the strip draws no copy of a card the layout controller would manage');

  // Switching the rule off, then unlocking: each sample falls back to the next source.
  await h.JE.core.tagLook.saveRules([{ ...rule, enabled: false }]);
  await h.settle(); await h.settle();
  assert.match(meta('episode'), /panel_media_tags_preview_source_default/);
  assert.equal(host('episode').dataset.jeLayout, 'corners');
  await h.JE.core.tagLook.unlockItems([LOCKED]);
  await h.settle(); await h.settle();
  assert.match(meta('series'), /panel_media_tags_preview_source_default/);
  assert.equal(host('series').dataset.jeLayout, 'corners');

  // A lock wins over a rule that matches the same item.
  await h.JE.core.tagLook.saveRules([{ ...rule, when: [{ field: 'type', value: 'Movie' }] }]);
  await h.settle(); await h.settle();
  assert.match(meta('movie'), /panel_media_tags_preview_source_rule:1/);
  await h.JE.core.tagLook.lockItem(h.$('.je-mtp-sample[data-sample="movie"] .je-mtp-card').dataset.id, { layout: 'minimal', density: 'full' });
  await h.settle(); await h.settle();
  assert.match(meta('movie'), /🔒 panel_media_tags_preview_source_lock/);
  assert.equal(host('movie').dataset.jeLayout, 'minimal');
});

test('the preview spotlights the group being edited and the phone strip follows the edit', async t => {
  const h = setup(t);
  await h.open();
  const preview = h.$('.je-mtp');
  const stripText = () => h.$('.je-mth-strip-text').textContent;
  assert.equal(preview.dataset.spot, undefined);
  assert.match(stripText(), /^panel_media_tags_preview_summary:panel_media_tags_preview_title_movie/);
  h.click(h.tab('badges'));
  assert.equal(preview.dataset.spot, 'status', 'Status badges spotlights Status');
  await h.change(h.$('#statusTagsScheduleToggle'), false);
  assert.match(stripText(), /panel_media_tags_preview_title_series/, 'a schedule badge change shows the series');
  h.click(h.tab('groups'));
  assert.equal(preview.dataset.spot, undefined);
  h.click(h.$('.je-tge-row[data-group="quality"] .je-tge-expand'));
  assert.equal(preview.dataset.spot, 'quality');
  assert.match(h.$('.je-mth-strip-chips').textContent, /^4K · Dolby Vision/, 'the edited group\'s chips lead');
  h.click(h.tab('rules'));
  assert.match(stripText(), /panel_media_tags_preview_title_episode/);

  // The strip's Preview button unfolds the same preview component.
  const toggle = h.$('#jeMthStripToggle');
  assert.equal(toggle.getAttribute('aria-controls'), 'jeMthPreview');
  assert.ok(h.$('#jeMthPreview').contains(preview));
  h.click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(h.$('#jeMediaTagsHub').classList.contains('je-mth-strip-open'));
  h.click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
});

test('the preview is built only once Media Tags is on screen and torn down with the panel', async t => {
  const h = setup(t, { observer: true });
  await h.open();
  const io = h.observers.at(-1);
  assert.equal(io.targets[0].id, 'jeMediaTagsHub');
  assert.equal(h.$('.je-mtp'), null);
  io.fire();
  assert.equal(h.document.querySelectorAll('.je-mtp-card').length, 3);
  assert.equal(h.ui.mediaTagsHub.hasPreview(), true);
  h.$('#closeSettingsPanel').click();
  assert.equal(h.ui.mediaTagsHub, null);
  assert.equal(h.document.querySelectorAll('.je-tag-host').length, 0);
});

test('the last open tab comes back on the next open, per user; a tab the user no longer has falls back to Layout', async t => {
  const h = setup(t);
  await h.open();
  h.click(h.tab('rules'));
  assert.equal(h.window.localStorage.getItem('JE_mediaTagsTab:user-a'), 'rules');
  h.$('#closeSettingsPanel').click();
  await h.open();
  assert.equal(h.selected(), 'rules');
  assert.equal(h.$('#jeMthPanel-rules').hidden, false);
  h.$('#closeSettingsPanel').click();
  h.window.localStorage.setItem('JE_mediaTagsTab:user-a', 'server');
  await h.open();
  assert.equal(h.selected(), 'layout', 'Server is not rendered for this user');
});

test('Badges in the Status row and the way back to Groups move between the two places', async t => {
  const h = setup(t);
  await h.open();
  h.click(h.tab('groups'));
  const badges = h.$('.je-tge-row[data-group="status"] .je-tge-badges');
  assert.ok(badges);
  assert.equal(h.document.querySelectorAll('.je-tge-badges').length, 1, 'only the Status row has one');
  h.click(badges);
  assert.equal(h.selected(), 'badges');
  assert.equal(h.document.activeElement, h.$('#jeMthBadgesTitle'), 'focus lands on the tab\'s heading');
  h.click(h.$('[data-je-goto="groups:status"]'));
  assert.equal(h.selected(), 'groups');
  const expand = h.$('.je-tge-row[data-group="status"] .je-tge-expand');
  assert.equal(expand.getAttribute('aria-expanded'), 'true');
  assert.equal(h.document.activeElement, expand);
  // Otherwise → Change takes the user to the layout tiles.
  h.click(h.tab('rules'));
  h.click(h.$('[data-je-row="otherwise"] button'));
  assert.equal(h.selected(), 'layout');
  assert.equal(h.document.activeElement, h.$('input[name="jeTagLayout"]:checked'));
});

test('the panel host owns one dialog: semantics, focus in, Tab kept inside, focus back to the opener on close', async t => {
  const h = setup(t);
  const opener = h.$('#opener');
  opener.focus();
  await h.open();
  const panel = h.$('#jellyfin-enhanced-panel');
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.equal(panel.getAttribute('aria-modal'), 'true');
  assert.equal(panel.getAttribute('aria-labelledby'), 'jePanelTitle');
  assert.equal(h.document.activeElement, panel, 'focus starts inside the dialog');
  assert.equal(h.document.querySelectorAll('[aria-modal="true"]').length, 1, 'the hub adds no second modal');

  const close = h.$('#closeSettingsPanel');
  const tabbable = Array.from(panel.querySelectorAll('button:not([disabled]), input:not([disabled]), select, a[href]'))
    .filter(el => !el.closest('[hidden]') && !(el.type === 'radio' && !el.checked));
  const last = tabbable.at(-1);
  last.focus();
  h.key(last, 'Tab');
  assert.equal(h.document.activeElement, close, 'Tab past the last control wraps to the first');
  h.key(close, 'Tab', { shiftKey: true });
  assert.equal(h.document.activeElement, last, 'Shift+Tab before the first wraps to the last');

  // '?' typed in the search box does not close; Escape does, and focus goes back.
  const search = h.$('#jePanelSearch');
  h.key(search, '?');
  assert.ok(h.$('#jellyfin-enhanced-panel'));
  h.key(search, 'Escape');
  assert.equal(h.$('#jellyfin-enhanced-panel'), null);
  assert.equal(h.document.activeElement, opener);
});
