import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain, deferred } from '../helpers/harness.mjs';

const KIDS = '22222222222222222222222222222222';
const MOVIE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SERIES = 'cccccccccccccccccccccccccccccccc';

/**
 * The real "Where each look applies" section (and the detail-page lock
 * button) over the real layout controller and tag look module, with the
 * Jellyfin API mocked: /UserViews, /Genres, /Users/{id}/Items and the
 * tag pipeline's /tag-data (batch mode: no server tag cache). With realSave
 * the real JE.saveUserSettings posts the settings, failing with HTTP 500
 * while saveStatus is 500.
 */
function setup(t, { settings = {}, genresFail = false, html = '', tagData = id => ({ Id: id, Type: 'Movie', Genres: ['Drama'] }), realSave = false } = {}) {
  const writes = [], toasts = [], requests = [], reinit = [];
  const io = { saveStatus: 200, user: 'user-a', epoch: 0 };
  const h = createHarness({
    html: '<div id="jeTagLayoutChoice"><input type="radio" name="jeTagLayout" value="corners" checked><input type="radio" name="jeTagLayout" value="bands"></div><div id="jeTagLooksMount"></div>' + html,
    JE: {
      currentSettings: { tagLayoutSettingsVersion: 1, tagLayout: 'corners', qualityTagsEnabled: true, ...settings },
      pluginConfig: {},
      t: (key, params) => params ? `${key}:${Object.values(params).join('|')}` : key,
      ...(realSave ? {} : { saveUserSettings: (file, doc) => { writes.push(plain(doc)); return Promise.resolve(); } }),
      session: { onUserChange() {}, getEpoch: () => io.epoch, getUserId: () => io.user },
    },
    apiClient: {
      getCurrentUserId: () => io.user,
      getUrl: (path, query) => `http://jellyfin.test/${path}${query ? `?${new URLSearchParams(query)}` : ''}`,
      ajax: async ({ url, data }) => {
        requests.push(url);
        const u = new URL(url);
        if (u.pathname.includes('/JellyfinEnhanced/tag-data/')) return { Items: (await Promise.all(JSON.parse(data).map(tagData))).filter(Boolean) };
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
  const files = ['core/ui-kit.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'enhanced/settingspanel/ui-panel-tag-looks.js', 'tags/tag-pipeline.js', 'tags/tag-look-lock.js'];
  if (realSave) files.unshift('enhanced/config.js');
  for (const file of files) h.load(file);
  h.JE.toast = message => toasts.push(message);
  const real = h.JE.reinitializeTagLayout;
  h.JE.reinitializeTagLayout = () => { reinit.push(1); return real(); };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const mount = () => h.document.getElementById('jeTagLooksMount');
  const rows = () => Array.from(mount().querySelectorAll('.je-tag-looks-list > li'), li => li.querySelector('.je-tag-looks-text').textContent);
  const click = el => el.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  const buttonIn = (root, label) => Array.from(root.querySelectorAll('button')).find(b => b.textContent === label);
  return { ...h, writes, toasts, requests, reinit, settle, mount, rows, click, buttonIn, io,
    form: () => mount().querySelector('form'),
    /** Wire the section; `show` also tells it its tab is on screen (the hub does on the Rules & locks tab). */
    async open({ show = true } = {}) {
      h.JE.internals.enhancedUi.wireTagLooks({ resetAutoCloseTimer() {} });
      if (show) h.JE.internals.enhancedUi.tagLooksPanel.show();
      await settle(); await settle();
    } };
}

const kidsRule = { id: 'kids', enabled: true, when: [{ field: 'library', value: KIDS }, { field: 'type', value: 'Episode' }], layout: 'caption', density: 'compact', colourPreset: null, slots: null };

test('closing or rewiring the rules panel removes its layout subscription', async t => {
  const h = setup(t);
  const cleanups = [];
  const wire = () => h.JE.internals.enhancedUi.wireTagLooks({ onClose: fn => cleanups.push(fn) });
  wire();
  await h.settle(); await h.settle();
  wire();
  await h.settle(); await h.settle();
  cleanups[0](); // Closing the previous panel cannot unsubscribe its replacement.
  Object.assign(h.JE.currentSettings, { tagLayout: 'bands', tagLabelDensity: 'compact' });
  await h.JE.reinitializeTagLayout();
  const outcome = h.mount().querySelector('[data-je-row="otherwise"] .je-tag-looks-outcome');
  assert.match(outcome.textContent, /tag_looks_layout_bands/);
  const before = outcome.textContent;
  cleanups[1]();
  h.JE.currentSettings.tagLayout = 'caption';
  await h.JE.reinitializeTagLayout();
  assert.equal(outcome.textContent, before, 'closed panels receive no further layout updates');
});

test('the rules list in order with their outcome, the default after them and the locked items with their count', async t => {
  const h = setup(t, { settings: { tagLookRules: [kidsRule, { ...kidsRule, id: 'off', enabled: false, when: [{ field: 'genre', value: 'Drama' }], layout: 'bands', density: 'full' }],
    tagLayoutLocks: { [MOVIE]: { layout: 'minimal', density: 'full', lockedAt: 1 } } } });
  await h.open();
  assert.deepEqual(h.rows(), [
    '1. tag_looks_when:tag_looks_cond_library:Kids' + 'tag_looks_and' + 'tag_looks_cond_type:tag_looks_type_episode → tag_looks_outcome:tag_looks_layout_caption|panel_settings_ui_tag_density_compact',
    '2. tag_looks_when:tag_looks_cond_genre:Drama → tag_looks_outcome:tag_looks_layout_bands|panel_settings_ui_tag_density_full',
  ]);
  assert.equal(h.mount().querySelector('.je-tag-looks-main [data-je-row="locked"] .je-tag-looks-count').textContent, '1');
  assert.ok(h.mount().querySelector('[data-je-row="otherwise"]').compareDocumentPosition(h.mount().querySelector('[data-je-row="locked"]')) & h.window.Node.DOCUMENT_POSITION_FOLLOWING, 'the locked items follow the rules and the default');
  const off = h.mount().querySelector('[data-je-rule-id="off"]');
  assert.equal(off.dataset.off, '1');
  assert.equal(off.querySelector('.je-tag-looks-pill').getAttribute('aria-pressed'), 'false');
  assert.match(h.mount().querySelector('[data-je-row="otherwise"]').textContent, /tag_looks_layout_corners/);
  assert.ok(h.form(), 'the add form is open next to the list');
  assert.equal(h.form().closest('.je-tag-looks-side')?.parentElement, h.mount().querySelector('.je-tag-looks-cols'), 'in its own column');
});

test('reorder, switch off and delete save the rules and re-present the cards', async t => {
  const second = { ...kidsRule, id: 'second', when: [{ field: 'type', value: 'Movie' }] };
  const h = setup(t, { settings: { tagLookRules: [kidsRule, second] } });
  await h.open();
  const up = h.mount().querySelector('[data-je-rule-id="second"] [aria-label^="tag_looks_move_up"]');
  const row = up.closest('li');
  up.focus();
  h.click(up);
  await h.settle();
  assert.deepEqual(h.writes.at(-1).tagLookRules.map(r => r.id), ['second', 'kids']);
  assert.equal(h.mount().querySelector('.je-tag-looks-list > li'), row, 'the same row node moved to the top');
  assert.equal(h.document.activeElement, row.querySelector('[aria-label^="tag_looks_move_down"]'), 'at the top its up button is off: focus moves to its down button');
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
  const form = h.form();
  assert.ok(form, 'always open: no Add rule button to press first');
  assert.equal(form.querySelector('[data-je-rule-layout]').value, 'caption', 'new rules start as Caption');
  assert.equal(form.querySelector('[data-je-rule-density]').value, 'compact', 'and Compact');
  // Library is the first condition: its options come from /UserViews.
  const libSelect = form.querySelector('[data-je-cond-value]');
  assert.deepEqual(Array.from(libSelect.options, o => o.textContent), ['tag_looks_choose', 'Kids', 'Movies']);
  for (const control of form.querySelectorAll('select, input')) {
    assert.ok(form.querySelector(`label[for="${control.id}"]`) || control.closest('label'), `${control.outerHTML.slice(0, 40)} is labelled`);
  }
  assert.equal(form.querySelector(`label[for="${libSelect.id}"]`).textContent, 'tag_looks_condition_value:1');
  // Saving with an empty value is refused: an alert, the value marked invalid and focused.
  form.dispatchEvent(new h.window.Event('submit', { cancelable: true }));
  const alert = form.querySelector('[role="alert"]');
  assert.equal(alert.textContent, 'tag_looks_error_value');
  assert.equal(libSelect.getAttribute('aria-invalid'), 'true');
  assert.equal(libSelect.getAttribute('aria-describedby'), alert.id);
  assert.equal(h.document.activeElement, libSelect);
  assert.equal(h.writes.length, 0);

  libSelect.value = KIDS;
  libSelect.dispatchEvent(new h.window.Event('change'));
  assert.equal(libSelect.hasAttribute('aria-invalid'), false, 'cleared once a value is chosen');
  // + condition (genre: a select of /Genres), up to five rows.
  const add = h.buttonIn(form, 'tag_looks_add_condition');
  h.click(add);
  const field = form.querySelectorAll('[data-je-cond-field]')[1];
  assert.equal(h.document.activeElement, field, 'focus moves to the new condition');
  field.value = 'genre';
  field.dispatchEvent(new h.window.Event('change'));
  const genre = form.querySelectorAll('[data-je-cond-value]')[1];
  assert.equal(genre.tagName, 'SELECT');
  genre.value = 'Animation';
  for (let i = 0; i < 3; i++) h.click(add);
  assert.equal(form.querySelectorAll('[data-je-cond]').length, 5);
  assert.equal(add.disabled, true, 'at most five conditions');
  assert.match(form.textContent, /tag_looks_condition_count:5\|5/);
  for (let i = 0; i < 3; i++) h.click(form.querySelectorAll('[data-je-cond-remove]')[4 - i]);
  assert.equal(form.querySelectorAll('[data-je-cond-remove]')[1].getAttribute('aria-label'), 'tag_looks_remove_condition_named:2');
  form.querySelector('[data-je-rule-layout]').value = 'bands';
  form.dispatchEvent(new h.window.Event('submit', { cancelable: true }));
  await h.settle();
  const saved = h.writes.at(-1).tagLookRules;
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].when, [{ field: 'library', value: KIDS }, { field: 'genre', value: 'Animation' }]);
  assert.equal(saved[0].layout, 'bands');
  assert.equal(saved[0].density, 'compact');
  assert.equal(h.toasts.at(-1), 'tag_looks_saved_toast');
  const fresh = h.form();
  assert.notEqual(fresh, form, 'a fresh add form takes its place');
  assert.equal(fresh.querySelectorAll('[data-je-cond]').length, 1);
  const newRow = h.mount().querySelector(`[data-je-rule-id="${saved[0].id}"]`);
  assert.equal(h.document.activeElement, h.buttonIn(newRow, 'tag_looks_edit'), 'focus moves to the new rule');

  // Editing reuses the form with the rule's values; Cancel goes back to adding.
  h.click(h.buttonIn(newRow, 'tag_looks_edit'));
  await h.settle();
  const edit = h.form();
  assert.equal(edit.querySelectorAll('[data-je-cond]').length, 2);
  assert.equal(edit.querySelector('[data-je-rule-layout]').value, 'bands');
  assert.equal(h.document.activeElement, edit.querySelector('[data-je-cond-field]'));
  h.click(h.buttonIn(edit, 'tag_looks_cancel'));
  assert.equal(h.form().querySelectorAll('[data-je-cond]').length, 1, 'back to a new rule');
  assert.equal(h.document.activeElement, h.buttonIn(newRow, 'tag_looks_edit'));
  h.click(h.buttonIn(newRow, 'tag_looks_edit'));
  const again = h.form();
  again.querySelector('[data-je-rule-layout]').value = 'minimal';
  again.dispatchEvent(new h.window.Event('submit', { cancelable: true }));
  await h.settle();
  assert.equal(h.writes.at(-1).tagLookRules.length, 1);
  assert.equal(h.writes.at(-1).tagLookRules[0].layout, 'minimal');
  assert.equal(h.writes.at(-1).tagLookRules[0].id, saved[0].id);
});

test('at the 50-rule limit Add rule is off; deleting one turns it back on and keeps what was typed; a submit at 50 is refused', async t => {
  const fifty = Array.from({ length: 50 }, (_, i) => ({ ...kidsRule, id: `r${String(i).padStart(2, '0')}`, when: [{ field: 'genre', value: `G${i}` }] }));
  const h = setup(t, { settings: { tagLookRules: fifty } });
  await h.open();
  const form = h.form();
  const save = () => form.querySelector('.je-tag-looks-save');
  const hint = () => form.querySelector('.je-tag-looks-buttons-hint').textContent;
  assert.equal(save().disabled, true);
  assert.equal(hint(), 'tag_looks_limit:50');
  const value = form.querySelector('[data-je-cond-value]');
  value.value = KIDS;
  form.querySelector('[data-je-rule-layout]').value = 'bands';

  // Delete the first rule: the form is not rebuilt, and it may add again.
  h.click(h.buttonIn(h.mount().querySelector('[data-je-rule-id="r00"]'), 'tag_looks_delete'));
  await h.settle();
  assert.equal(h.writes.at(-1).tagLookRules.length, 49);
  assert.equal(h.form(), form, 'the form keeps its values');
  assert.equal(value.value, KIDS);
  assert.equal(save().disabled, false, 'Add rule is enabled again');
  assert.equal(hint(), 'tag_looks_add_hint:50');

  form.dispatchEvent(new h.window.Event('submit', { cancelable: true }));
  await h.settle();
  const rules = h.writes.at(-1).tagLookRules;
  assert.equal(rules.length, 50);
  assert.deepEqual(rules.at(-1).when, [{ field: 'library', value: KIDS }]);
  assert.equal(rules.at(-1).layout, 'bands');
  const fresh = h.form();
  assert.equal(fresh.querySelector('.je-tag-looks-save').disabled, true, 'full again');

  // A submit that gets past the disabled button (Enter in a field, a script) adds nothing.
  const writes = h.writes.length;
  fresh.querySelector('.je-tag-looks-save').disabled = false;
  const v = fresh.querySelector('[data-je-cond-value]');
  v.value = KIDS;
  fresh.dispatchEvent(new h.window.Event('submit', { cancelable: true }));
  await h.settle();
  assert.equal(h.writes.length, writes, 'nothing saved at 50');
  assert.equal(fresh.querySelector('.je-tag-looks-save').disabled, true);
  assert.equal(h.JE.core.tagLook.read().rules.length, 50);
});

test('editing a switched-off rule saves its edits and keeps it off', async t => {
  const h = setup(t, { settings: { tagLookRules: [{ ...kidsRule, enabled: false }] } });
  await h.open();
  h.click(h.buttonIn(h.mount().querySelector('[data-je-rule-id="kids"]'), 'tag_looks_edit'));
  const form = h.form();
  form.querySelector('[data-je-rule-layout]').value = 'bands';
  form.dispatchEvent(new h.window.Event('submit', { cancelable: true }));
  await h.settle();
  const [rule] = h.writes.at(-1).tagLookRules;
  assert.equal(rule.layout, 'bands', 'the edit is saved');
  assert.equal(rule.enabled, false, 'the rule stays off');
  assert.equal(h.mount().querySelector('[data-je-rule-id="kids"]').dataset.off, '1');
});

test('focus recovers after every rule change: moves to an end, deletes in the middle and of the last rule', async t => {
  const rules = ['a', 'b', 'c'].map(id => ({ ...kidsRule, id, when: [{ field: 'genre', value: id }] }));
  const h = setup(t, { settings: { tagLookRules: rules } });
  await h.open();
  const row = id => h.mount().querySelector(`[data-je-rule-id="${id}"]`);
  // Moving the first rule down to the last place: focus stays on that rule.
  const down = row('a').querySelector('[aria-label^="tag_looks_move_down"]');
  down.focus();
  h.click(down); h.click(down);
  assert.deepEqual(h.writes.at(-1).tagLookRules.map(r => r.id), ['b', 'c', 'a']);
  assert.equal(h.document.activeElement, row('a').querySelector('[aria-label^="tag_looks_move_up"]'), 'at the bottom: its up button');
  // Deleting a middle rule: the next rule's Delete.
  h.click(h.buttonIn(row('c'), 'tag_looks_delete'));
  assert.equal(h.document.activeElement, h.buttonIn(row('a'), 'tag_looks_delete'));
  // Deleting the last one left: the previous rule's, then the empty list.
  h.click(h.buttonIn(row('a'), 'tag_looks_delete'));
  assert.equal(h.document.activeElement, h.buttonIn(row('b'), 'tag_looks_delete'));
  h.click(h.buttonIn(row('b'), 'tag_looks_delete'));
  const empty = h.mount().querySelector('.je-tag-looks-empty');
  assert.equal(h.document.activeElement, empty, 'a named empty state, never the page body');
  assert.equal(empty.hidden, false);
  assert.equal(empty.textContent, 'tag_looks_no_rules');
  await h.settle();
  assert.deepEqual(h.writes.at(-1).tagLookRules, []);
});

test('genre falls back to a text box when /Genres fails; age rating is a text box', async t => {
  const h = setup(t, { genresFail: true, settings: { tagLookRules: [] } });
  await h.open();
  const form = h.form();
  const field = form.querySelector('[data-je-cond-field]');
  for (const name of ['genre', 'ageRating']) {
    field.value = name;
    field.dispatchEvent(new h.window.Event('change'));
    const value = form.querySelector('[data-je-cond-value]');
    assert.equal(value.tagName, 'INPUT', name);
    assert.equal(value.type, 'text');
  }
});

test('the locked list loads titles once its tab shows, in batches of 50, and unlocks one or all', async t => {
  const locks = {};
  for (let i = 0; i < 60; i++) locks[i.toString(16).padStart(32, i % 2 ? 'a' : 'f')] = { layout: 'bands', density: 'full', lockedAt: i };
  const h = setup(t, { settings: { tagLayoutLocks: locks } });
  await h.open({ show: false });
  assert.equal(h.requests.filter(u => u.includes('/Items')).length, 0, 'no titles until the Rules & locks tab shows');
  h.JE.internals.enhancedUi.tagLooksPanel.show();
  await h.settle(); await h.settle();
  const itemRequests = h.requests.filter(u => u.includes('/Items'));
  assert.equal(itemRequests.length, 2);
  assert.deepEqual(itemRequests.map(u => new URL(u).searchParams.get('Ids').split(',').length), [50, 10]);
  const items = () => Array.from(h.mount().querySelectorAll('.je-tag-looks-locked-list li'));
  assert.equal(items().length, 60);
  assert.match(items()[0].textContent, /^Title 3b/, 'newest first, titled');
  assert.ok(items().some(li => /tag_looks_unknown_item/.test(li.textContent)), 'an id the server did not return');
  assert.match(items()[0].textContent, /tag_looks_outcome:tag_looks_layout_bands/);

  // A narrow pane folds the list into "Locked items · N": Unlock all is inside what unfolds.
  const toggle = h.mount().querySelector('.je-tag-looks-locks-toggle');
  const body = h.mount().querySelector('#jeTagLooksLocksBody');
  assert.equal(toggle.getAttribute('aria-controls'), body.id);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), 'tag_looks_locks_show:60');
  h.click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(h.mount().querySelector('[data-je-row="locked"]').classList.contains('je-open'));
  const all = h.buttonIn(h.mount(), 'tag_looks_unlock_all');
  assert.ok(body.contains(all), 'bulk unlock lives in the unfolded list, reachable on a phone');

  const second = items()[1].querySelector('button');
  items()[0].querySelector('button').focus();
  h.click(items()[0].querySelector('button'));
  await h.settle();
  assert.equal(Object.keys(h.writes.at(-1).tagLayoutLocks).length, 59);
  assert.equal(h.toasts.at(-1), 'tag_look_unlocked_toast');
  assert.equal(h.document.activeElement?.dataset.jeFocusKey, second.dataset.jeFocusKey, 'focus moves to the next item\'s Unlock');

  h.click(all);
  assert.equal(all.textContent, 'tag_looks_unlock_all_confirm', 'asks for a second click');
  assert.equal(h.writes.length, 1);
  h.click(all);
  await h.settle();
  assert.equal(h.writes.at(-1).tagLayoutLocks, null);
  assert.equal(h.mount().querySelector('[data-je-row="locked"] .je-tag-looks-count').textContent, '0');
  assert.equal(h.document.activeElement, h.mount().querySelector('.je-tag-looks-locks .je-tag-looks-empty'), 'focus goes to the empty list');
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

test('locking without a cached entry waits for /tag-data and stores the library rule\'s look, not the default', async t => {
  const answer = deferred();
  const h = setup(t, {
    html: detailPage(),
    settings: { tagLayout: 'corners', tagLookRules: [{ ...kidsRule, when: [{ field: 'library', value: KIDS }] }] },
    tagData: () => answer.promise,
  });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.tagLookLock.addLockButton(MOVIE, page, 'Movie');
  const button = page.querySelector('.je-tag-look-lock-btn');
  h.click(button);
  await h.settle();
  assert.equal(button.disabled, true, 'disabled while the item data loads');
  assert.equal(button.getAttribute('aria-label'), 'tag_looks_loading');
  h.JE.tagLookLock.addLockButton(MOVIE, page, 'Movie');
  assert.equal(button.getAttribute('aria-label'), 'tag_looks_loading', 'a details re-run keeps the busy state');
  assert.equal(h.writes.length, 0, 'nothing saved before the data is known');
  assert.ok(h.requests.some(u => u.includes(`/JellyfinEnhanced/tag-data/`)), 'fetched through the tag pipeline');

  answer.resolve({ Id: MOVIE, Type: 'Movie', LibraryId: KIDS, Genres: [] });
  await h.settle(); await h.settle();
  const lock = h.writes.at(-1).tagLayoutLocks[MOVIE];
  assert.equal(lock.layout, 'caption', 'the library rule\'s look (the grid shows caption)');
  assert.equal(lock.density, 'compact');
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-label'), 'tag_look_unlock_button');
});

test('locking an item the server has no tag data for saves nothing and says it failed', async t => {
  const h = setup(t, { html: detailPage(), tagData: () => null });
  const page = h.document.getElementById('itemDetailPage');
  h.JE.tagLookLock.addLockButton(MOVIE, page, 'Movie');
  const button = page.querySelector('.je-tag-look-lock-btn');
  h.click(button);
  await h.settle(); await h.settle();
  assert.equal(h.writes.length, 0);
  assert.equal(h.toasts.at(-1), 'tag_look_error_toast');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(button.disabled, false);
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
  assert.equal(h.rows().length, 1);
  h.click(h.buttonIn(h.mount(), 'tag_looks_delete'));
  assert.equal(h.rows().length, 0, 'optimistic');
  await h.settle(); await h.settle();
  assert.equal(h.toasts.at(-1), 'tag_looks_save_failed_toast');
  assert.equal(h.rows().length, 1, 'the rule is back');
  assert.equal(h.writes.length, 0, 'nothing reached the server');

  // Once the server answers again the same change saves.
  h.io.saveStatus = 200;
  h.click(h.buttonIn(h.mount(), 'tag_looks_delete'));
  await h.settle(); await h.settle();
  assert.deepEqual(h.writes.at(-1).TagLookRules ?? h.writes.at(-1).tagLookRules, []);
  assert.equal(h.rows().length, 0);
});

for (const switchedBack of [false, true]) test(`a detail lock drops facts and saves nothing after a session change (back=${switchedBack})`, async t => {
  const answer = deferred();
  const h = setup(t, { html: detailPage(), tagData: () => answer.promise });
  h.JE.pluginConfig.TagCacheServerMode = false;
  const page = h.document.getElementById('itemDetailPage');
  h.JE.tagLookLock.addLockButton(MOVIE, page, 'Movie');
  h.click(page.querySelector('.je-tag-look-lock-btn'));
  await h.settle();
  h.io.user = switchedBack ? 'user-a' : 'user-b';
  h.io.epoch += switchedBack ? 2 : 1;
  h.JE.currentSettings = { tagLayoutSettingsVersion: 1, qualityTagsEnabled: true };
  answer.resolve({ Id: MOVIE, Type: 'Movie', Genres: ['private'] });
  await h.settle(); await h.settle();
  assert.equal(h.writes.length, 0, 'no lock saved for the incoming session');
  assert.equal(h.JE.currentSettings.tagLayoutLocks, undefined);
  assert.equal(h.toasts.length, 0, 'no stale-session toast');
  // A fresh request must still reach the API: the old response was not remembered.
  await h.JE.tagPipeline.itemLookFacts(MOVIE);
  assert.equal(h.requests.filter(u => u.includes('/tag-data/')).length, 2);
});

for (const available of [true, false]) for (const explicitSource of [false, true]) test(`a plain remembered DTO cannot freeze the default look (retry available=${available}, source=${explicitSource})`, async t => {
  const h = setup(t, { html: detailPage(), tagData: () => available ? { Id: MOVIE, Type: 'Movie', LibraryId: KIDS } : null,
    settings: { tagLookRules: [{ ...kidsRule, when: [{ field: 'library', value: KIDS }] }] } });
  h.JE.pluginConfig.TagCacheServerMode = false;
  h.window.localStorage.setItem('JE_tagLookFacts:identity-owner', ':user-a');
  // Also covers persisted facts written before source provenance was recorded.
  h.window.localStorage.setItem('JE_tagLookFacts', JSON.stringify({ [MOVIE]: { Type: 'Movie', Genres: ['Drama'], at: Date.now(), ...(explicitSource ? { source: 'item', LibraryId: '33333333333333333333333333333333' } : {}) } }));
  const page = h.document.getElementById('itemDetailPage');
  h.JE.tagLookLock.addLockButton(MOVIE, page, 'Movie');
  h.click(page.querySelector('.je-tag-look-lock-btn'));
  await h.settle(); await h.settle();
  assert.equal(h.requests.filter(u => u.includes('/tag-data/')).length, 1, 'plain facts require an enriched retry');
  if (available) assert.equal(h.writes.at(-1).tagLayoutLocks[MOVIE].layout, 'caption');
  else { assert.equal(h.writes.length, 0); assert.equal(h.toasts.at(-1), 'tag_look_error_toast'); }
});

test('rule actions only stick when the entire form fits in the visible scroller', async t => {
  const h = setup(t);
  const scroller = h.document.createElement('div');
  scroller.className = 'je-panel-main';
  h.mount().before(scroller);
  scroller.append(h.mount());
  let bottom = 700, resizeForm;
  const observed = new Set();
  h.window.ResizeObserver = class {
    constructor(callback) { resizeForm = callback; }
    observe(node) { observed.add(node); }
    disconnect() { observed.clear(); }
  };
  scroller.getBoundingClientRect = () => ({ top: 100, bottom });
  await h.open();
  assert.ok(observed.has(scroller), 'panel resizing also rechecks visibility');
  let rect = { top: 400, bottom: 900, height: 500 };
  h.form().getBoundingClientRect = () => rect;
  const sync = async () => {
    scroller.dispatchEvent(new h.window.Event('scroll'));
    await new Promise(resolve => h.window.requestAnimationFrame(resolve));
  };
  await sync();
  assert.equal(h.form().classList.contains('je-form-visible'), false, 'no bar over offscreen fields');
  rect = { top: 150, bottom: 650, height: 500 };
  await sync();
  assert.equal(h.form().classList.contains('je-form-visible'), true);
  bottom = 600;
  resizeForm();
  await new Promise(resolve => h.window.requestAnimationFrame(resolve));
  assert.equal(h.form().classList.contains('je-form-visible'), false, 'shrinking the panel removes stickiness without a window resize');
  bottom = 700;
  rect = { top: 50, bottom: 550, height: 500 };
  await sync();
  assert.equal(h.form().classList.contains('je-form-visible'), false, 'partly above scroller returns actions to flow');
});


test('the phone landing puts the form before saved rules, and restores desktop order without losing focus', async t => {
  const h = setup(t, { settings: { tagLookRules: [kidsRule] } });
  let change;
  const media = { matches: true, addEventListener: (_, fn) => { change = fn; }, removeEventListener() {} };
  h.window.matchMedia = () => media;
  await h.open();
  const side = h.form().parentElement;
  assert.equal(side.parentElement.firstElementChild, side);
  const field = h.form().querySelector('select');
  field.focus();
  media.matches = false;
  change();
  assert.equal(side.parentElement.lastElementChild, side);
  assert.equal(h.document.activeElement, field);
});
