import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

const KIDS = '22222222222222222222222222222222';
const MOVIE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SERIES = 'cccccccccccccccccccccccccccccccc';

/**
 * The real "Where each look applies" section (and the detail-page lock
 * button) over the real layout controller and tag look module, with the
 * Jellyfin API mocked: /UserViews, /Genres and /Users/{id}/Items. With realSave
 * the real JE.saveUserSettings posts the settings, failing with HTTP 500
 * while saveStatus is 500.
 */
function setup(t, { settings = {}, genresFail = false, html = '', realSave = false } = {}) {
  const writes = [], toasts = [], requests = [], reinit = [];
  const io = { saveStatus: 200 };
  const h = createHarness({
    html: '<select id="tagLayoutSelect"><option value="corners">corners</option><option value="bands">bands</option></select><div id="jeTagLooksMount"></div>' + html,
    JE: {
      currentSettings: { tagLayoutSettingsVersion: 1, tagLayout: 'corners', qualityTagsEnabled: true, ...settings },
      pluginConfig: {},
      t: (key, params) => params ? `${key}:${Object.values(params).join('|')}` : key,
      ...(realSave ? {} : { saveUserSettings: (file, doc) => { writes.push(plain(doc)); return Promise.resolve(); } }),
      session: { onUserChange() {} },
    },
    apiClient: {
      getUrl: (path, query) => `http://jellyfin.test/${path}${query ? `?${new URLSearchParams(query)}` : ''}`,
      ajax: async ({ url, data }) => {
        requests.push(url);
        const u = new URL(url);
        if (u.pathname.includes('/JellyfinEnhanced/user-settings/')) {
          if (io.saveStatus !== 200) throw Object.assign(new Error('Internal Server Error'), { status: io.saveStatus });
          writes.push(JSON.parse(data));
          return null;
        }
        if (u.pathname.endsWith('/UserViews')) return { Items: [{ Id: KIDS, Name: 'Kids' }, { Id: '33333333-3333-3333-3333-333333333333', Name: 'Movies' }] };
        if (u.pathname.endsWith('/Genres')) { if (genresFail) throw new Error('nope'); return { Items: [{ Name: 'Animation' }, { Name: 'Drama' }] }; }
        if (u.pathname.includes('/Items')) return { Items: u.searchParams.get('Ids').split(',').filter(id => !id.startsWith('f')).map(id => ({ Id: id, Name: `Title ${id.slice(-2)}`, Type: 'Movie' })) };
        if (u.pathname.includes(`/Items/`)) return null;
        throw new Error(`unexpected ${url}`);
      },
      getItem: async (userId, id) => ({ Id: id, Type: 'Movie', Genres: ['Drama'] }),
    },
  });
  t.after(() => h.close());
  const files = ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'enhanced/settingspanel/ui-panel-tag-looks.js', 'tags/tag-look-lock.js'];
  if (realSave) files.unshift('enhanced/config.js');
  for (const file of files) h.load(file);
  h.JE.toast = message => toasts.push(message);
  const real = h.JE.reinitializeTagLayout;
  h.JE.reinitializeTagLayout = () => { reinit.push(1); return real(); };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const mount = () => h.document.getElementById('jeTagLooksMount');
  const rows = () => Array.from(mount().querySelectorAll('.je-tag-looks-list > li'), li => li.dataset.jeRow === 'rule' ? li.querySelector('.je-tag-looks-text').textContent : li.dataset.jeRow);
  const click = el => el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  const buttonIn = (root, label) => Array.from(root.querySelectorAll('button')).find(b => b.textContent === label);
  return { ...h, writes, toasts, requests, reinit, settle, mount, rows, click, buttonIn, io,
    async open() { h.JE.internals.enhancedUi.wireTagLooks({ resetAutoCloseTimer() {} }); await settle(); await settle(); } };
}

const kidsRule = { id: 'kids', enabled: true, when: [{ field: 'library', value: KIDS }, { field: 'type', value: 'Episode' }], layout: 'caption', density: 'compact', colourPreset: null, slots: null };

test('the list shows locked items first, the rules in order with their outcome, then the default', async t => {
  const h = setup(t, { settings: { tagLookRules: [kidsRule, { ...kidsRule, id: 'off', enabled: false, when: [{ field: 'genre', value: 'Drama' }], layout: 'bands', density: 'full' }],
    tagLayoutLocks: { [MOVIE]: { layout: 'minimal', density: 'full', lockedAt: 1 } } } });
  await h.open();
  assert.deepEqual(h.rows(), [
    'locked',
    'tag_looks_when:tag_looks_cond_library:Kids' + 'tag_looks_and' + 'tag_looks_cond_type:tag_looks_type_episode→ tag_looks_outcome:tag_looks_layout_caption|panel_settings_ui_tag_density_compact',
    'tag_looks_when:tag_looks_cond_genre:Drama→ tag_looks_outcome:tag_looks_layout_bands|panel_settings_ui_tag_density_full',
    'otherwise',
  ]);
  assert.match(h.mount().querySelector('[data-je-row="locked"]').textContent, /tag_looks_locked_count:1/);
  const off = h.mount().querySelector('[data-je-rule-id="off"]');
  assert.equal(off.dataset.off, '1');
  assert.equal(off.querySelector('.je-tag-looks-pill').getAttribute('aria-pressed'), 'false');
  assert.match(h.mount().querySelector('[data-je-row="otherwise"]').textContent, /tag_looks_layout_corners/);
});

test('reorder, switch off and delete save the rules and re-present the cards', async t => {
  const second = { ...kidsRule, id: 'second', when: [{ field: 'type', value: 'Movie' }] };
  const h = setup(t, { settings: { tagLookRules: [kidsRule, second] } });
  await h.open();
  h.click(h.mount().querySelector('[data-je-rule-id="second"] [aria-label^="tag_looks_move_up"]'));
  await h.settle();
  assert.deepEqual(h.writes.at(-1).tagLookRules.map(r => r.id), ['second', 'kids']);
  h.click(h.mount().querySelector('[data-je-rule-id="kids"] .je-tag-looks-pill'));
  await h.settle();
  assert.equal(h.writes.at(-1).tagLookRules.find(r => r.id === 'kids').enabled, false);
  h.click(h.buttonIn(h.mount().querySelector('[data-je-rule-id="second"]'), 'tag_looks_delete'));
  await h.settle();
  assert.deepEqual(h.writes.at(-1).tagLookRules.map(r => r.id), ['kids']);
  assert.equal(h.writes.at(-1).tagLayoutSettingsVersion, 1);
  assert.ok(h.reinit.length >= 3, 'each change re-presents the cards');
});

test('the add-rule form builds conditions from libraries, types and genres, validates, and saves', async t => {
  const h = setup(t, { settings: { tagLookRules: [] } });
  await h.open();
  h.click(h.buttonIn(h.mount(), 'tag_looks_add_rule'));
  await h.settle();
  const form = h.mount().querySelector('form');
  assert.ok(form);
  assert.equal(h.document.activeElement, form.querySelector('[data-je-cond-field]'), 'focus moves into the form');
  // Library is the first condition: its options come from /UserViews.
  const libSelect = form.querySelector('[data-je-cond-value]');
  assert.deepEqual(Array.from(libSelect.options, o => o.textContent), ['tag_looks_choose', 'Kids', 'Movies']);
  for (const control of form.querySelectorAll('select, input')) {
    assert.ok(form.querySelector(`label[for="${control.id}"]`) || control.closest('label'), `${control.outerHTML.slice(0, 40)} is labelled`);
  }
  // Saving with an empty value is refused with a message.
  form.dispatchEvent(new h.window.Event('submit', { cancelable: true }));
  assert.equal(form.querySelector('[role="alert"]').textContent, 'tag_looks_error_value');
  assert.equal(h.writes.length, 0);

  libSelect.value = KIDS;
  // + condition (genre: a select of /Genres), up to five rows.
  const add = h.buttonIn(form, 'tag_looks_add_condition');
  h.click(add);
  const field = form.querySelectorAll('[data-je-cond-field]')[1];
  field.value = 'genre';
  field.dispatchEvent(new h.window.Event('change'));
  const genre = form.querySelectorAll('[data-je-cond-value]')[1];
  assert.equal(genre.tagName, 'SELECT');
  genre.value = 'Animation';
  for (let i = 0; i < 3; i++) h.click(add);
  assert.equal(form.querySelectorAll('[data-je-cond]').length, 5);
  assert.equal(add.disabled, true, 'at most five conditions');
  for (let i = 0; i < 3; i++) h.click(form.querySelectorAll('[data-je-cond-remove]')[4 - i]);
  form.querySelector('[data-je-rule-layout]').value = 'bands';
  form.querySelector('[data-je-rule-density]').value = 'compact';
  form.dispatchEvent(new h.window.Event('submit', { cancelable: true }));
  await h.settle();
  const saved = h.writes.at(-1).tagLookRules;
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].when, [{ field: 'library', value: KIDS }, { field: 'genre', value: 'Animation' }]);
  assert.equal(saved[0].layout, 'bands');
  assert.equal(saved[0].density, 'compact');
  assert.equal(h.mount().querySelector('form'), null, 'the form closes');
  assert.equal(h.toasts.at(-1), 'tag_looks_saved_toast');

  // Editing reuses the form with the rule's values.
  h.click(h.buttonIn(h.mount().querySelector('[data-je-row="rule"]'), 'tag_looks_edit'));
  await h.settle();
  const edit = h.mount().querySelector('form');
  assert.equal(edit.querySelectorAll('[data-je-cond]').length, 2);
  assert.equal(edit.querySelector('[data-je-rule-layout]').value, 'bands');
  edit.querySelector('[data-je-rule-layout]').value = 'minimal';
  edit.dispatchEvent(new h.window.Event('submit', { cancelable: true }));
  await h.settle();
  assert.equal(h.writes.at(-1).tagLookRules.length, 1);
  assert.equal(h.writes.at(-1).tagLookRules[0].layout, 'minimal');
  assert.equal(h.writes.at(-1).tagLookRules[0].id, saved[0].id);
});

test('genre falls back to a text box when /Genres fails; age rating is a text box', async t => {
  const h = setup(t, { genresFail: true, settings: { tagLookRules: [] } });
  await h.open();
  h.click(h.buttonIn(h.mount(), 'tag_looks_add_rule'));
  await h.settle();
  const form = h.mount().querySelector('form');
  const field = form.querySelector('[data-je-cond-field]');
  for (const name of ['genre', 'ageRating']) {
    field.value = name;
    field.dispatchEvent(new h.window.Event('change'));
    const value = form.querySelector('[data-je-cond-value]');
    assert.equal(value.tagName, 'INPUT', name);
    assert.equal(value.type, 'text');
  }
});

test('the locked list loads titles lazily in batches of 50 and unlocks one or all', async t => {
  const locks = {};
  for (let i = 0; i < 60; i++) locks[i.toString(16).padStart(32, i % 2 ? 'a' : 'f')] = { layout: 'bands', density: 'full', lockedAt: i };
  const h = setup(t, { settings: { tagLayoutLocks: locks } });
  await h.open();
  assert.equal(h.requests.filter(u => u.includes('/Items')).length, 0, 'no titles until the list is opened');
  const toggle = h.buttonIn(h.mount(), 'tag_looks_show');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  h.click(toggle);
  await h.settle(); await h.settle();
  const itemRequests = h.requests.filter(u => u.includes('/Items'));
  assert.equal(itemRequests.length, 2);
  assert.deepEqual(itemRequests.map(u => new URL(u).searchParams.get('Ids').split(',').length), [50, 10]);
  const items = Array.from(h.mount().querySelectorAll('.je-tag-looks-locked-list li'));
  assert.equal(items.length, 60);
  assert.match(items[0].textContent, /^Title 3b/, 'newest first, titled');
  assert.ok(items.some(li => /tag_looks_unknown_item/.test(li.textContent)), 'an id the server did not return');
  assert.match(items[0].textContent, /tag_looks_outcome:tag_looks_layout_bands/);

  h.click(items[0].querySelector('button'));
  await h.settle();
  assert.equal(Object.keys(h.writes.at(-1).tagLayoutLocks).length, 59);
  assert.equal(h.toasts.at(-1), 'tag_look_unlocked_toast');

  const all = h.buttonIn(h.mount(), 'tag_looks_unlock_all');
  h.click(all);
  assert.equal(all.textContent, 'tag_looks_unlock_all_confirm', 'asks for a second click');
  assert.equal(h.writes.length, 1);
  h.click(all);
  await h.settle();
  assert.equal(h.writes.at(-1).tagLayoutLocks, null);
  assert.match(h.mount().querySelector('[data-je-row="locked"]').textContent, /tag_looks_locked_count:0/);
});

test('names from the server are text, never markup', async t => {
  const h = setup(t, { settings: { tagLookRules: [{ ...kidsRule, when: [{ field: 'genre', value: '<img src=x onerror=alert(1)>' }] }] } });
  await h.open();
  assert.equal(h.mount().querySelector('img'), null);
  assert.match(h.mount().textContent, /<img src=x/);
});

const detailPage = (id = MOVIE) => `<div id="itemDetailPage"><div class="detailButtons"><button class="btnMoreCommands"></button></div></div>`;

test('the detail-page button locks the item with its current look and unlocks it again', async t => {
  const h = setup(t, { html: detailPage(), settings: { tagLayout: 'bands', tagLookRules: [{ ...kidsRule, when: [{ field: 'genre', value: 'drama' }], layout: 'caption' }] } });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.tagLookLock.addLockButton(MOVIE, page, 'Movie');
  const button = page.querySelector('.je-tag-look-lock-btn');
  assert.ok(button);
  assert.equal(button.nextElementSibling.className, 'btnMoreCommands', 'before the overflow menu');
  assert.equal(button.getAttribute('aria-label'), 'tag_look_lock_button');
  assert.equal(button.querySelector('.detailButton-icon').textContent, 'lock_open');

  h.click(button);
  await h.settle(); await h.settle();
  const lock = h.writes.at(-1).tagLayoutLocks[MOVIE];
  assert.equal(lock.layout, 'caption', 'the look the matching rule gives the item now');
  assert.equal(lock.density, 'compact');
  assert.ok(Array.isArray(lock.slots) && lock.slots.length === 6, 'the whole slot profile');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.querySelector('.detailButton-icon').textContent, 'lock');
  assert.match(h.toasts.at(-1), /^tag_look_locked_toast:/);

  h.click(button);
  await h.settle(); await h.settle();
  assert.equal(h.writes.at(-1).tagLayoutLocks, null);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(h.toasts.at(-1), 'tag_look_unlocked_toast');
});

test('the detail-page button is absent with every poster tag off or for non-media items', t => {
  const h = setup(t, { html: detailPage(), settings: { qualityTagsEnabled: false } });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.tagLookLock.addLockButton(SERIES, page, 'Series');
  assert.equal(page.querySelector('.je-tag-look-lock-btn'), null);
  h.JE.currentSettings.qualityTagsEnabled = true;
  h.JE.tagLookLock.addLockButton(SERIES, page, 'Person');
  assert.equal(page.querySelector('.je-tag-look-lock-btn'), null);
  h.JE.tagLookLock.addLockButton(SERIES, page, 'Series');
  assert.ok(page.querySelector('.je-tag-look-lock-btn'));
  h.JE.tagLookLock.addLockButton('not-an-id', page, 'Series');
  assert.equal(page.querySelector('.je-tag-look-lock-btn'), null);
});

test('a save that fails with HTTP 500 resolves false, restores the locks and rules and says so', async t => {
  const h = setup(t, { html: detailPage(), realSave: true, settings: { tagLookRules: [kidsRule] } });
  h.io.saveStatus = 500;
  const before = plain(h.JE.currentSettings);

  // Straight through the module: false, the previous locks back, cards re-presented again.
  const reinitBefore = h.reinit.length;
  assert.equal(await h.JE.core.tagLook.lockItem(MOVIE, { layout: 'bands', density: 'full' }), false);
  assert.equal(h.JE.currentSettings.tagLayoutLocks, before.tagLayoutLocks ?? undefined);
  assert.equal(h.JE.core.tagLook.read().locks.size, 0);
  assert.ok(h.reinit.length >= reinitBefore + 2, 'presented with the lock, then without it');
  assert.equal(await h.JE.core.tagLook.saveRules([]), false);
  assert.deepEqual(plain(h.JE.currentSettings.tagLookRules), before.tagLookRules);

  // The detail-page button: no "locked" toast, an error one, still unlocked.
  const page = h.document.getElementById('itemDetailPage');
  h.JE.tagLookLock.addLockButton(MOVIE, page, 'Movie');
  const button = page.querySelector('.je-tag-look-lock-btn');
  h.click(button);
  await h.settle(); await h.settle(); await h.settle();
  assert.deepEqual(h.toasts, ['tag_look_error_toast']);
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(h.JE.core.tagLook.read().locks.size, 0);

  // The panel: deleting the rule shows at once, then comes back with a toast.
  await h.open();
  assert.equal(h.rows().length, 3);
  h.click(h.buttonIn(h.mount(), 'tag_looks_delete'));
  assert.equal(h.rows().length, 2, 'optimistic');
  await h.settle(); await h.settle();
  assert.equal(h.toasts.at(-1), 'tag_looks_save_failed_toast');
  assert.equal(h.rows().length, 3, 'the rule is back');
  assert.equal(h.writes.length, 0, 'nothing reached the server');

  // Once the server answers again the same change saves.
  h.io.saveStatus = 200;
  h.click(h.buttonIn(h.mount(), 'tag_looks_delete'));
  await h.settle(); await h.settle();
  assert.deepEqual(h.writes.at(-1).TagLookRules ?? h.writes.at(-1).tagLookRules, []);
  assert.equal(h.rows().length, 2);
});
