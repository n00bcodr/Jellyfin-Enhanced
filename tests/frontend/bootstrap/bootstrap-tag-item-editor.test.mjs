import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain, deferred } from '../helpers/harness.mjs';

const KIDS = '22222222222222222222222222222222';
const MOVIE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SERIES = 'cccccccccccccccccccccccccccccccc';
const EPISODE = 'dddddddddddddddddddddddddddddddd';
const PERSON = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

const ITEMS = {
  [MOVIE]: { Id: MOVIE, Name: 'Movie <b>One</b>', Type: 'Movie' },
  [SERIES]: { Id: SERIES, Name: 'Series One', Type: 'Series' },
  [EPISODE]: { Id: EPISODE, Name: 'Pilot', Type: 'Episode', SeriesId: 'cccccccc-cccc-cccc-cccc-cccccccccccc' },
  [PERSON]: { Id: PERSON, Name: 'Someone', Type: 'Person' },
};

/** A Jellyfin 12 card with its ⋮ button. */
const card = (id, type) => `<div class="card overflowPortraitCard" data-id="${id}" data-type="${type}"><div class="cardBox"><div class="cardScalable"><a class="cardImageContainer"></a><div class="cardOverlayContainer"><button is="paper-icon-button-light" data-action="menu" class="cardOverlayButton">⋮</button></div></div><div class="cardText">t</div></div></div>`;
const detailPage = '<div id="itemDetailPage" class="page"><div class="detailButtons"><button class="btnMoreCommands detailButton">⋮</button></div></div>';

/**
 * The item menu row and the item editor over the real layout controller,
 * tag look module and tag pipeline (batch mode: /tag-data), with the
 * Jellyfin API mocked: items, the current user, the user settings save,
 * the plugin configuration and the Media Tags field patch.
 */
function setup(t, { settings = {}, plugin = {}, html = '', admin = false, tagData = (id) => ({ Id: id, Type: ITEMS[id]?.Type || 'Movie', LibraryId: KIDS, Genres: [] }), url } = {}) {
  const writes = [], toasts = [], requests = [], patches = [];
  const io = { saveStatus: 200, user: 'user-a', server: 'server-a', epoch: 0, config: { TagLookItemOverrides: null }, conflict: 0 };
  const userChange = [];
  const h = createHarness({
    html: html + '<div id="sheets"></div>',
    url,
    JE: {
      currentSettings: { tagLayoutSettingsVersion: 1, tagLayout: 'corners', qualityTagsEnabled: true, genreTagsEnabled: true, ...settings },
      pluginConfig: { ...plugin },
      t: (key, params) => params ? `${key}:${Object.values(params).join('|')}` : key,
      escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      saveUserSettings: (file, doc) => io.save ? io.save(doc) : io.saveStatus === 200 ? (writes.push(plain(doc)), Promise.resolve()) : Promise.reject(Object.assign(new Error('Internal Server Error'), { status: io.saveStatus })),
      session: { onUserChange: (name, fn) => userChange.push(fn), getEpoch: () => io.epoch, getUserId: () => io.user },
    },
    apiClient: {
      getCurrentUserId: () => io.user,
      serverId: () => io.server,
      getUrl: (path, query) => `http://jellyfin.test/${path.replace(/^\//, '')}${query ? `?${new URLSearchParams(query)}` : ''}`,
      getItem: async (userId, id) => { requests.push(`item:${id}`); return ITEMS[id] ? { ...ITEMS[id] } : null; },
      getCurrentUser: async () => ({ Policy: { IsAdministrator: admin } }),
      getPluginConfiguration: async () => io.get ? io.get() : structuredClone(io.config),
      getScaledImageUrl: (id) => `http://jellyfin.test/Items/${id}/Images/Primary`,
      ajax: async ({ url: target, data }) => {
        requests.push(target);
        const u = new URL(target);
        if (u.pathname.includes('/JellyfinEnhanced/tag-data/')) return { Items: (await Promise.all(JSON.parse(data).map(tagData))).filter(Boolean) };
        if (u.pathname.endsWith('/JellyfinEnhanced/admin/configuration')) {
          const body = JSON.parse(data);
          patches.push(body);
          if (io.patch) return io.patch(body);
          if (io.conflict-- > 0) throw Object.assign(new Error('Conflict'), { status: 409 });
          io.config = { ...io.config, ...body.Changes };
          return { values: body.Changes };
        }
        throw new Error(`unexpected ${target}`);
      },
    },
  });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/dom-observer.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-pipeline.js', 'tags/tag-item-editor.js', 'tags/tag-item-menu.js']) h.load(file);
  h.JE.toast = (message) => toasts.push(message);
  const settle = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  const frame = () => new Promise((resolve) => h.window.requestAnimationFrame(() => resolve()));
  const $ = (sel) => h.document.querySelector(sel);
  const click = (el) => el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const change = (el, value) => {
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = value;
    else el.value = value;
    el.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  };
  /** Jellyfin's actionsheet: the sheet markup with the given rows, as actionsheet.show() writes it. */
  const openSheet = (rows) => {
    const sheet = h.document.createElement('div');
    sheet.className = 'dialog actionSheet';
    sheet.innerHTML = `<div class="actionSheetContent"><div class="actionSheetScroller scrollY">${rows.map((id) => `<button is="emby-button" type="button" class="listItem listItem-button actionSheetMenuItem actionsheet-xlargeFont" data-id="${id}"><span class="actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons add" aria-hidden="true"></span><div class="listItemBody actionsheetListItemBody"><div class="listItemBodyText actionSheetItemText">${id}</div></div></button>`).join('')}</div></div>`;
    $('#sheets').appendChild(sheet);
    return sheet;
  };
  const row = () => $('[data-id="je-media-tags"]');
  return { ...h, writes, toasts, requests, patches, io, settle, frame, $, click, change, openSheet, row,
    switchUser() { for (const fn of userChange) fn(); },
    editor: () => $('.je-tie'),
    async open(id, options) { const r = await h.JE.tagItemEditor.open(id, options); await settle(); return r; },
    checked: (name) => $(`.je-tie input[name$="${name}"]:checked`)?.value,
  };
}

const kidsRule = { id: 'kids', enabled: true, when: [{ field: 'library', value: KIDS }], layout: 'caption', density: 'compact', colourPreset: null, slots: null };

// ── The menu row ───────────────────────────────────────────────────────

test('the detail page ⋮ gets a native-looking Media Tags row before Share, which opens the editor for the page\'s item', async t => {
  const h = setup(t, { html: detailPage, url: `http://jellyfin.test/web/index.html#/details?id=${MOVIE}&serverId=s` });
  const opened = [];
  h.JE.tagItemEditor.open = (id, options) => { opened.push([id, options]); return Promise.resolve(true); };
  h.click(h.$('.btnMoreCommands'));
  assert.ok(h.requests.includes(`item:${MOVIE}`), 'the item type is read as the menu opens');
  h.openSheet(['addtocollection', 'edit', 'share']);
  await h.frame(); await h.settle();
  const row = h.row();
  assert.ok(row, 'the row is there');
  assert.equal(row.nextElementSibling.dataset.id, 'share', 'before Share');
  assert.equal(row.className, 'listItem listItem-button actionSheetMenuItem actionsheet-xlargeFont', 'the native rows\' classes');
  assert.equal(row.querySelector('.actionSheetItemText').textContent, 'tag_item_editor_menu');
  assert.ok(row.querySelector('.material-icons.local_offer'));
  h.click(row);
  await h.settle();
  assert.deepEqual(opened.map(([id]) => id), [MOVIE]);
  assert.equal(opened[0][1].opener, h.$('.btnMoreCommands'), 'focus goes back to ⋮');
});

test('a card ⋮ gets the row for its own item and type; a reused sheet swaps a stale row', async t => {
  const h = setup(t, { html: card(SERIES, 'Series') + card(MOVIE, 'Movie') });
  h.click(h.$(`[data-id="${SERIES}"] [data-action="menu"]`));
  const sheet = h.openSheet(['playallfromhere', 'addtoplaylist']);
  await h.frame(); await h.settle();
  assert.equal(h.row()?.dataset.jeItemId, SERIES);
  assert.equal(h.row().parentElement.lastElementChild, h.row(), 'at the end without Share');
  assert.ok(!h.requests.some((r) => r.startsWith('item:')), 'the card says its type');
  h.click(h.$(`[data-id="${MOVIE}"] [data-action="menu"]`));
  sheet.querySelector('.actionSheetScroller').appendChild(h.document.createElement('span'));
  await h.frame(); await h.settle();
  assert.equal(h.document.querySelectorAll('[data-id="je-media-tags"]').length, 1);
  assert.equal(h.row().dataset.jeItemId, MOVIE);
});

test('no row on other menus, for items without poster tags, with every tag off, or without a fresh ⋮ press', async t => {
  const h = setup(t, { html: card(MOVIE, 'Movie') + card(PERSON, 'Person') });
  // A sort menu: none of the item menu's rows.
  h.click(h.$(`[data-id="${MOVIE}"] [data-action="menu"]`));
  h.openSheet(['SortName', 'DateCreated']);
  await h.frame(); await h.settle();
  assert.equal(h.row(), null, 'not on a sort menu');
  h.$('#sheets').replaceChildren();
  // A person card.
  h.click(h.$(`[data-id="${PERSON}"] [data-action="menu"]`));
  h.openSheet(['addtoplaylist', 'share']);
  await h.frame(); await h.settle();
  assert.equal(h.row(), null, 'people have no poster tags');
  h.$('#sheets').replaceChildren();
  // Every tag type off.
  h.JE.currentSettings.qualityTagsEnabled = false;
  h.JE.currentSettings.genreTagsEnabled = false;
  h.click(h.$(`[data-id="${MOVIE}"] [data-action="menu"]`));
  h.openSheet(['addtoplaylist', 'share']);
  await h.frame(); await h.settle();
  assert.equal(h.row(), null, 'tags off');
  h.$('#sheets').replaceChildren();
  // A sheet nobody pressed ⋮ for (multi-select's menu, another feature's sheet).
  h.JE.currentSettings.qualityTagsEnabled = true;
  h.openSheet(['addtoplaylist', 'share']);
  await h.frame(); await h.settle();
  assert.equal(h.row(), null, 'no fresh item');
});

// ── The editor ─────────────────────────────────────────────────────────

test('the editor starts from the look the item has now, shows it live and keeps it only with Keep on', async t => {
  const h = setup(t, { settings: { tagLookRules: [kidsRule] } });
  assert.equal(await h.open(MOVIE), true);
  const dialog = h.editor();
  assert.ok(dialog, 'open');
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.match(h.$('.je-tie-title').textContent, /^tag_item_editor_title:Movie <b>One<\/b>/, 'the name is text');
  assert.equal(h.$('.je-tie-title b'), null);
  assert.equal(h.checked('Layout'), 'caption', 'the library rule\'s look (found through /tag-data)');
  assert.equal(h.checked('Density'), 'compact');
  assert.match(h.$('[data-tie-source]').textContent, /panel_media_tags_preview_source_rule:1/);
  assert.equal(h.$('[data-tie-everyone]'), null, 'no server-wide switch for a non-administrator');
  assert.equal(h.$('[data-tie-keep]').checked, false);
  assert.equal(h.$('.je-tie-scope'), null, 'a movie has no series choice');

  // Live: the sample card follows the draft.
  h.change(h.$('.je-tie input[value="bands"]'), true);
  await h.settle();
  assert.equal(h.JE.core.tagLayout.resolveLayout(h.$('.je-tie-card .je-tag-host')).layout, 'bands');
  assert.equal(h.$('[data-tie-status]').textContent, 'tag_item_editor_not_kept', 'says it will not stick');

  // Save without Keep: nothing written.
  h.click(h.$('[data-tie-save]'));
  await h.settle();
  assert.equal(h.writes.length, 0);
  assert.equal(h.editor(), null);
  assert.deepEqual(h.toasts, ['tag_item_editor_nothing_kept']);
});

test('Keep saves layout, density, every slot, hidden groups, Show up to, size, gap and edge spacing as the item\'s lock', async t => {
  const h = setup(t, { html: card(MOVIE, 'Movie'), settings: { tagGroupCaps: { genre: 3 } } });
  await h.open(MOVIE);
  h.change(h.$('.je-tie input[value="minimal"]'), true);
  h.change(h.$('.je-tie input[value="compact"]'), true);
  // Genre hidden, quality on the top slot, two languages… quality's Show up to: 2.
  h.change(h.$('.je-tie-group[data-group="genre"] [data-tie-on]'), false);
  h.change(h.$('.je-tie-group[data-group="quality"] input[value="top"]'), true);
  const fewer = h.$('.je-tie-group[data-group="quality"] [data-tie-step="-1"]');
  h.click(fewer); // All → 10
  for (let i = 0; i < 8; i++) h.click(h.$('.je-tie-group[data-group="quality"] [data-tie-step="-1"]'));
  assert.equal(h.$('.je-tie-group[data-group="quality"] output').textContent, '2');
  assert.equal(h.$('.je-tie-group[data-group="status"] [data-tie-step]'), null, 'status always shows one: no stepper');
  h.change(h.$('[data-tie-select="tagScale"]'), 'largest');
  h.change(h.$('[data-tie-select="tagGap"]'), 'tight');
  h.change(h.$('[data-tie-select="edge"]'), 'flush');
  h.change(h.$('[data-tie-keep]'), true);
  h.click(h.$('[data-tie-save]'));
  await h.settle();
  const lock = h.writes.at(-1).tagLayoutLocks[MOVIE];
  assert.equal(lock.layout, 'minimal');
  assert.equal(lock.density, 'compact');
  const slots = Object.fromEntries(lock.slots.map((s) => [s.group, s.slot]));
  assert.equal(Object.keys(slots).length, 9, 'the whole slot profile');
  assert.equal(slots.genre, 'off');
  assert.equal(slots.quality, 'top');
  assert.deepEqual(lock.caps, { quality: 2 });
  assert.deepEqual([lock.tagScale, lock.tagGap, lock.edgeSpacing, lock.scope], ['largest', 'tight', 'flush', null]);
  assert.deepEqual(h.toasts, ['tag_item_editor_kept:Movie &lt;b&gt;One&lt;/b&gt;'], 'the toast is escaped');
  assert.equal(h.editor(), null);
  // The editor opens again on the kept look.
  await h.open(MOVIE);
  assert.equal(h.checked('Layout'), 'minimal');
  assert.equal(h.$('[data-tie-keep]').checked, true);
  assert.equal(h.$('[data-tie-select="edge"]').value, 'flush');
  assert.match(h.$('[data-tie-source]').textContent, /tag_item_editor_source_lock$/);
});

test('turning Keep off unlocks the item, with Undo', async t => {
  const h = setup(t, { settings: { tagLayoutLocks: { [MOVIE]: { layout: 'bands', density: 'full', lockedAt: 1 } } } });
  await h.open(MOVIE);
  assert.equal(h.$('[data-tie-keep]').checked, true);
  h.change(h.$('[data-tie-keep]'), false);
  h.click(h.$('[data-tie-save]'));
  await h.settle();
  assert.equal(h.writes.at(-1).tagLayoutLocks, null);
  const toast = h.$('.je-tie-toast');
  assert.match(toast.textContent, /tag_item_editor_unlocked:Movie <b>One<\/b>/);
  assert.equal(toast.querySelector('b'), null, 'text, never markup');
  h.click(toast.querySelector('button'));
  await h.settle();
  assert.equal(h.writes.at(-1).tagLayoutLocks[MOVIE].layout, 'bands', 'Undo puts the lock back');
  assert.equal(h.$('.je-tie-toast'), null);
});

test('an episode can keep its own look or move it to its series in one save; a series can keep it to its poster', async t => {
  const h = setup(t, { settings: { tagLayoutLocks: { [EPISODE]: { layout: 'bands', density: 'full', lockedAt: 1 } } } });
  await h.open(EPISODE);
  assert.equal(h.checked('Scope'), 'item', 'its own lock: this episode only');
  assert.equal(h.$('.je-tie-card').dataset.jeShape, 'landscape');
  h.change(h.$('.je-tie input[value="series"]'), true);
  h.click(h.$('[data-tie-save]'));
  await h.settle();
  assert.equal(h.writes.length, 1, 'one save');
  assert.deepEqual(Object.keys(h.writes[0].tagLayoutLocks), [SERIES], 'the series holds the look, the episode\'s own lock is gone');
  assert.equal(h.writes[0].tagLayoutLocks[SERIES].layout, 'bands');

  await h.open(EPISODE);
  assert.equal(h.checked('Scope'), 'series', 'it inherits its series\' look now');
  assert.match(h.$('[data-tie-source]').textContent, /tag_item_editor_source_lock_series/);
  h.click(h.$('[data-tie-close]'));

  await h.open(SERIES);
  assert.equal(h.checked('Scope'), 'series');
  h.change(h.$('.je-tie input[name$="Scope"][value="item"]'), true);
  h.click(h.$('[data-tie-save]'));
  await h.settle();
  assert.equal(h.writes.at(-1).tagLayoutLocks[SERIES].scope, 'item', 'the series poster only');
});

test('administrators also keep the look for everyone, through the field patch with the value read before', async t => {
  const h = setup(t, { admin: true, plugin: { TagLookItemOverrides: null } });
  h.io.config.TagLookItemOverrides = [{ ItemId: SERIES, Layout: 'caption', Density: 'full', LockedAt: 4 }];
  h.io.conflict = 1;
  await h.open(MOVIE);
  const everyone = h.$('[data-tie-everyone]');
  assert.ok(everyone, 'the server-wide switch');
  assert.equal(everyone.checked, false);
  h.change(h.$('.je-tie input[value="summary"]'), true);
  h.change(everyone, true);
  h.click(h.$('[data-tie-save]'));
  await h.settle(6);
  assert.equal(h.writes.length, 0, 'no personal lock');
  assert.equal(h.patches.length, 2, 'a conflict is read again and written once more');
  const last = h.patches.at(-1);
  assert.deepEqual(Object.keys(last.Changes), ['TagLookItemOverrides']);
  assert.deepEqual(last.Expected.TagLookItemOverrides.map((o) => o.ItemId), [SERIES]);
  assert.deepEqual(last.Changes.TagLookItemOverrides.map((o) => [o.ItemId, o.Layout]), [[MOVIE, 'summary'], [SERIES, 'caption']]);
  assert.deepEqual(plain(h.JE.pluginConfig.TagLookItemOverrides.map((o) => o.ItemId)), [MOVIE, SERIES], 'the page uses it at once');
  assert.deepEqual(h.toasts, ['tag_item_editor_everyone_saved:Movie &lt;b&gt;One&lt;/b&gt;']);

  // Off again removes it, with Undo.
  await h.open(MOVIE);
  assert.equal(h.$('[data-tie-everyone]').checked, true);
  assert.match(h.$('[data-tie-source]').textContent, /tag_item_editor_source_override$/);
  h.change(h.$('[data-tie-everyone]'), false);
  h.click(h.$('[data-tie-save]'));
  await h.settle(6);
  assert.deepEqual(h.patches.at(-1).Changes.TagLookItemOverrides.map((o) => o.ItemId), [SERIES]);
  h.click(h.$('.je-tie-toast button'));
  await h.settle(6);
  assert.deepEqual(h.patches.at(-1).Changes.TagLookItemOverrides.map((o) => [o.ItemId, o.Layout]), [[MOVIE, 'summary'], [SERIES, 'caption']]);
});

test('a failed save keeps the dialog open and says so; nothing changed', async t => {
  const h = setup(t);
  h.io.saveStatus = 500;
  await h.open(MOVIE);
  h.change(h.$('[data-tie-keep]'), true);
  h.click(h.$('[data-tie-save]'));
  await h.settle();
  assert.ok(h.editor(), 'still open');
  assert.equal(h.$('[data-tie-status]').textContent, 'tag_item_editor_error');
  assert.equal(h.$('[data-tie-save]').disabled, false, 'try again');
  assert.equal(h.JE.core.tagLook.read().locks.size, 0, 'the lock was rolled back');
});

test('the editor waits for the item data before it opens; a session change meanwhile opens nothing', async t => {
  for (const switched of [false, true]) {
    const answer = deferred();
    const h = setup(t, { settings: { tagLookRules: [kidsRule] }, tagData: () => answer.promise });
    const opening = h.JE.tagItemEditor.open(MOVIE);
    await h.settle();
    assert.equal(h.editor(), null, 'not before the data');
    if (switched) { h.io.user = 'user-b'; h.io.epoch += 1; }
    answer.resolve({ Id: MOVIE, Type: 'Movie', LibraryId: KIDS, Genres: [] });
    assert.equal(await opening, !switched);
    await h.settle();
    if (switched) {
      assert.equal(h.editor(), null, 'nothing for the incoming session');
    } else {
      assert.equal(h.checked('Layout'), 'caption');
    }
  }
});

test('without the item data the editor says its current look is not known instead of guessing', async t => {
  const h = setup(t, { settings: { tagLookRules: [kidsRule] }, tagData: () => null });
  await h.open(MOVIE);
  assert.match(h.$('[data-tie-source]').textContent, /tag_item_editor_source_unknown/);
  assert.equal(h.checked('Layout'), 'corners', 'the user\'s default to start from');
});

test('items without poster tags do not open; Escape closes and gives focus back; a user switch closes it', async t => {
  const h = setup(t, { html: '<button id="opener">x</button>' });
  assert.equal(await h.open(PERSON), false);
  assert.equal(h.editor(), null);
  assert.deepEqual(h.toasts, ['tag_item_editor_unsupported']);

  const opener = h.$('#opener');
  opener.focus();
  await h.open(MOVIE, { opener });
  assert.ok(h.editor().contains(h.document.activeElement), 'focus inside');
  // Focus taken outside (Jellyfin's closing sheet restores its button) comes back.
  opener.focus();
  assert.ok(h.editor().contains(h.document.activeElement), 'focus kept inside');
  h.editor().dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.editor(), null);
  assert.equal(h.document.activeElement, opener);
  assert.equal(h.writes.length, 0);

  await h.open(MOVIE);
  h.switchUser();
  assert.equal(h.editor(), null, 'closed for the incoming user');
});

test('the sample shows the item\'s real tags copied from its card on the page, in the draft look', async t => {
  const h = setup(t, { html: card(MOVIE, 'Movie') });
  const L = h.JE.core.tagLayout;
  const target = h.$(`[data-id="${MOVIE}"] .cardScalable`);
  L.ensureHost(target);
  const master = h.document.createElement('div');
  master.className = 'quality-overlay-container';
  master.innerHTML = '<div class="quality-overlay-label resolution">4K</div>';
  L.commitGroup(target, 'quality', master);
  await h.open(MOVIE);
  const sample = h.$('.je-tie-card .je-tag-host');
  assert.equal(sample.querySelectorAll('.quality-overlay-label').length, 1, 'the card\'s chip');
  assert.equal(h.$('[data-tie-note]').hidden, true);
  h.change(h.$('.je-tie input[value="caption"]'), true);
  await h.settle();
  assert.ok(h.$('.je-tie-card .je-tag-caption .quality-overlay-label'), 'in the caption strip');
  assert.equal(h.$(`[data-id="${MOVIE}"] .je-tag-host`).dataset.jeLayout, 'corners', 'the card itself is untouched until Save');
  h.click(h.$('[data-tie-close]'));
  assert.equal(h.$('.je-tie-card'), null);
});

test('server mode (the admin page) edits the server-wide look and hands it back without saving anything itself', async t => {
  const h = setup(t);
  const saved = [];
  await h.open(SERIES, { mode: 'server', look: { Layout: 'bands', Density: 'compact', Scope: 'item', LockedAt: 2 }, onSave: (look, target) => saved.push([plain(look), target]) });
  assert.equal(h.$('[data-tie-keep]'), null);
  assert.equal(h.$('[data-tie-everyone]'), null);
  assert.equal(h.checked('Layout'), 'bands');
  assert.equal(h.checked('Scope'), 'item');
  assert.match(h.$('.je-tie-title').textContent, /^tag_item_editor_title_server:Series One/);
  h.change(h.$('.je-tie input[value="full"]'), true);
  h.click(h.$('[data-tie-save]'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0][1], SERIES);
  assert.equal(saved[0][0].density, 'full');
  assert.equal(saved[0][0].scope, 'item');
  assert.equal(h.writes.length + h.patches.length, 0);
  assert.equal(h.editor(), null);
});

test('Show up to steps like the hub: All → 10 … 1, and back up to All only for groups that may show every tag', t => {
  const h = setup(t);
  const step = h.JE.tagItemEditor.stepCap;
  assert.equal(step(0, -1, { capAll: true }), 10);
  assert.equal(step(1, -1, { capAll: true }), null);
  assert.equal(step(10, 1, { capAll: true }), 0);
  assert.equal(step(10, 1, {}), null);
  assert.equal(step(3, 1, { capFixed: true }), null);
});

test('groups that draw for the user come first; groups switched off in their settings follow and say so', async t => {
  const h = setup(t, { settings: { qualityTagsEnabled: false, genreTagsEnabled: true, ratingTagsEnabled: true } });
  await h.open(MOVIE);
  const rows = Array.from(h.document.querySelectorAll('.je-tie-group'), (li) => [li.dataset.group, !!li.querySelector('small')]);
  assert.deepEqual(rows.slice(0, 2), [['rating', false], ['genre', false]]);
  assert.ok(rows.slice(2).every(([, off]) => off), 'the rest are off for this user');
  assert.ok(rows.some(([g]) => g === 'quality'), 'still editable for the item');
});

test('focus goes back to the redrawn control when the opener was replaced meanwhile', async t => {
  const h = setup(t, { html: '<div id="list"><button data-je-focus-key="edit-x">Edit</button></div>' });
  const opener = h.$('[data-je-focus-key="edit-x"]');
  await h.open(MOVIE, { opener });
  h.$('#list').innerHTML = '<button data-je-focus-key="edit-x">Edit</button>';
  h.click(h.$('[data-tie-close]'));
  assert.equal(h.document.activeElement, h.$('[data-je-focus-key="edit-x"]'));
  assert.notEqual(h.document.activeElement, opener);
});

for (const phase of ['get', 'patch']) for (const identity of ['user', 'server', 'epoch']) {
  test(`item-look save abandons a ${identity} switch during ${phase}`, async t => {
    const h = setup(t, { admin: true });
    const answer = deferred();
    h.io[phase] = () => answer.promise;
    await h.open(MOVIE);
    h.change(h.$('[data-tie-everyone]'), true);
    h.click(h.$('[data-tie-save]'));
    await h.settle();
    const patches = h.patches.length;
    if (identity === 'epoch') h.io.epoch++;
    else h.io[identity] += '-next';
    h.JE.pluginConfig = { incoming: true };
    answer.resolve(phase === 'get' ? { TagLookItemOverrides: null } : { values: { TagLookItemOverrides: [{ ItemId: MOVIE, Layout: 'bands' }] } });
    await h.settle();
    assert.equal(h.patches.length, patches, 'no PATCH or retry with incoming credentials');
    assert.deepEqual(plain(h.JE.pluginConfig), { incoming: true }, 'incoming config stays intact');
    assert.deepEqual(h.toasts, [], 'stale saves are silent');
  });
}

test('a stale failed personal save cannot roll back incoming settings', async t => {
  const h = setup(t);
  const answer = deferred();
  h.io.save = () => answer.promise;
  await h.open(MOVIE);
  h.change(h.$('[data-tie-keep]'), true);
  h.click(h.$('[data-tie-save]'));
  const pendingLocks = h.JE.currentSettings.tagLayoutLocks;
  h.io.epoch++;
  h.JE.currentSettings = { tagLayoutLocks: pendingLocks, incoming: true };
  answer.reject(new Error('old request failed'));
  await h.settle();
  assert.equal(h.JE.currentSettings.tagLayoutLocks, pendingLocks);
  assert.deepEqual(h.toasts, []);
});

for (const everyone of [false, true]) test(`Undo belongs to its originating session (${everyone ? 'server' : 'personal'})`, async t => {
  const entry = { layout: 'bands', density: 'full', lockedAt: 1 };
  const h = setup(t, { admin: everyone, settings: { tagLayoutLocks: everyone ? null : { [MOVIE]: entry } }, plugin: { TagLookItemOverrides: everyone ? [{ ItemId: MOVIE, ...entry }] : null } });
  h.io.config.TagLookItemOverrides = h.JE.pluginConfig.TagLookItemOverrides;
  await h.open(MOVIE);
  h.change(h.$(everyone ? '[data-tie-everyone]' : '[data-tie-keep]'), false);
  h.click(h.$('[data-tie-save]'));
  await h.settle();
  const undo = h.$('.je-tie-toast button');
  assert.ok(undo);
  const count = h.writes.length + h.patches.length;
  // The reset hook fires BEFORE the host replaces its credentials.
  h.io.epoch++;
  h.switchUser();
  assert.equal(h.$('.je-tie-toast'), null, 'outstanding Undo removed synchronously');
  h.io.user = 'incoming';
  h.click(undo); // Even a retained reference is inert.
  await h.settle();
  assert.equal(h.writes.length + h.patches.length, count);
});

for (const changedTarget of [false, true]) test(`personal Undo merges only removed entries, preserving intervening changes (target edited: ${changedTarget})`, async t => {
  const old = { layout: 'bands', density: 'full', lockedAt: 1 };
  const removed = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const h = setup(t, { settings: { tagLayoutLocks: { [MOVIE]: old, [SERIES]: old, [removed]: old } } });
  await h.open(MOVIE);
  h.change(h.$('[data-tie-keep]'), false);
  h.click(h.$('[data-tie-save]'));
  await h.settle();
  await h.JE.core.tagLook.editLocks({ [SERIES]: { layout: 'minimal' }, [EPISODE]: { layout: 'summary' }, ...(changedTarget ? { [MOVIE]: { layout: 'caption' } } : {}) }, [removed]);
  h.click(h.$('.je-tie-toast button'));
  await h.settle();
  const locks = h.JE.core.tagLook.read().locks;
  assert.equal(locks.get(MOVIE).layout, changedTarget ? 'caption' : 'bands');
  assert.equal(locks.get(SERIES).layout, 'minimal');
  assert.equal(locks.get(EPISODE).layout, 'summary');
  assert.equal(locks.has(removed), false);
});

test('server-wide Undo preserves a newer look saved on its removed target', async t => {
  const entry = { ItemId: MOVIE, Layout: 'bands', LockedAt: 1 };
  const h = setup(t, { admin: true, plugin: { TagLookItemOverrides: [entry] } });
  h.io.config.TagLookItemOverrides = [entry];
  await h.open(MOVIE);
  h.change(h.$('[data-tie-everyone]'), false);
  h.click(h.$('[data-tie-save]'));
  await h.settle();
  h.io.config.TagLookItemOverrides = [{ ItemId: MOVIE, Layout: 'caption', LockedAt: 10 }];
  h.click(h.$('.je-tie-toast button'));
  await h.settle();
  assert.equal(h.io.config.TagLookItemOverrides[0].Layout, 'caption');
});

for (const type of ['Season', 'Episode']) test(`For everyone moves a ${type} look to its series atomically`, async t => {
  const h = setup(t, { admin: true, plugin: { TagLookItemOverrides: [{ ItemId: EPISODE, Layout: 'bands', LockedAt: 4 }, { ItemId: SERIES, Layout: 'caption', LockedAt: 2 }] } });
  h.io.config.TagLookItemOverrides = plain(h.JE.pluginConfig.TagLookItemOverrides);
  await h.open(EPISODE, { item: { ...ITEMS[EPISODE], Type: type } });
  h.change(h.$('.je-tie input[name$="Scope"][value="series"]'), true);
  h.change(h.$('.je-tie input[value="summary"]'), true);
  h.change(h.$('[data-tie-everyone]'), true);
  h.click(h.$('[data-tie-save]'));
  await h.settle();
  assert.equal(h.patches.length, 1);
  const looks = h.JE.core.tagLook.normalizeItemOverrides(h.io.config.TagLookItemOverrides);
  assert.equal(looks.has(EPISODE), false, 'no winning child entry left');
  assert.equal(looks.get(SERIES).layout, 'summary');
  h.JE.core.tagLayout.invalidateSettings();
  assert.equal(h.JE.core.tagLayout.resolveLayout({ itemId: EPISODE, SeriesId: SERIES, Type: type }).layout, 'summary');
});

for (const source of ['shape', 'rule', 'lock', 'override']) test(`opening and locking a ${source}-derived look keeps the effective preview and appearance`, async t => {
  const shaped = { layout: 'bands', density: 'compact', tagScale: 'largest', tagGap: 'roomy', caps: { quality: 1 }, slots: { genre: 'off', rating: 'top' } };
  const look = { layout: 'corners', density: 'full', tagScale: 'smaller', edgeSpacing: 'flush', shapes: { landscape: shaped }, lockedAt: 1 };
  const settings = source === 'shape' ? { tagShapeOverrides: { landscape: shaped } }
    : source === 'rule' ? { tagLookRules: [{ ...kidsRule, ...look }] }
    : source === 'lock' ? { tagLayoutLocks: { [EPISODE]: look } } : {};
  const h = setup(t, { settings, plugin: source === 'override' ? { TagLookItemOverrides: [{ ItemId: EPISODE, ...look }] } : {} });
  const L = h.JE.core.tagLayout;
  const context = { Id: EPISODE, itemId: EPISODE, Type: 'Episode', LibraryId: KIDS, SeriesId: SERIES, shape: 'landscape' };
  const appearance = (c) => plain({ layout: c.layout, density: c.density, slots: c.slots, caps: c.caps, tagScale: c.tagScale, tagGap: c.tagGap, edge: c.edge });
  const before = appearance(L.resolveLayout(context));
  await h.open(EPISODE);
  assert.deepEqual(appearance(L.resolveLayout(h.$('.je-tie-card .je-tag-host'))), before, 'opening does not change the preview');
  h.change(h.$('[data-tie-keep]'), true);
  h.click(h.$('[data-tie-save]'));
  await h.settle();
  L.invalidateSettings();
  assert.deepEqual(appearance(L.resolveLayout(context)), before, 'the saved lock has the same effective appearance');
});
