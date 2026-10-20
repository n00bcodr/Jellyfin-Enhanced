import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

// D46 slice 2 r6 (play prep finding PLAYR18-F1): More sheet → Hide on a LIBRARY movie, series or episode. The details
// page's Hide button reads the item first, then asks; before r6 its confirmation resolved its operation after that await
// from `window.event`, which in a browser is still the click on the closed sheet's entry (its microtask checkpoint runs
// inside that click's dispatch), so the dialog registered with the sheet's ENDED offer and closed at once: nothing asked,
// nothing hidden. Now the press carries its operation (JE.press) and the button takes it at the press.
// Real modules: core session-action, title actions (bar, sheet, hosts), Hidden Content data/dialogs, the details page.

const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle(n = 30) { for (let i = 0; i < n; i++) await tick(); }

function setup(t, kind) {
  const writes = [];
  const h = createHarness({
    html: '<div id="itemDetailPage"><h1 class="itemName">Library title</h1><div class="itemMiscInfo itemMiscInfo-primary"></div><div class="detailButtons mainDetailButtons"><button class="btnPlay detailButton" title="Play">Play</button></div></div>',
    url: 'http://jellyfin.test/web/index.html#/details?id=lib1',
    apiClient: { ajax: async o => { writes.push(o); return { success: true }; } },
    JE: {
      t: k => k, toast() {},
      pluginConfig: { HiddenContentEnabled: true, NativeAbsentDetailsEnabled: true },
      userConfig: { hiddenContent: { items: {}, settings: { enabled: true, showHideButtons: true, showButtonDetails: true, showHideConfirmation: true } } },
      session: { getEpoch: () => 1, isCurrent: () => true, onUserChange: () => () => {}, userScopedKey: k => k + ':viewer' },
    },
  });
  h.allowConsoleError(/./);
  t.after(() => { h.JE.titleActions?.dispose?.(); h.close(); });
  h.JE.core.api.plugin = async () => ({ allowed: true, itemId: null });
  h.load('enhanced/hiddencontent/hidden-content-data.js');
  const api = h.JE.internals.hiddenContent;
  Object.assign(api, { refreshNativeCardVisibility() {}, restoreNativeCardsForIds() {}, debouncedSave() { writes.push({ save: true }); }, showUndoToast() {} });
  api.resetFromUserConfig();
  h.load('enhanced/hiddencontent/hidden-content-dialogs.js');
  h.JE.hiddenContent = { ...api, confirmAndHide: api.confirmAndHide, hideItem: api.hideItem, unhideItem: api.unhideItem };
  const item = { Id: 'lib1', Type: kind, Name: 'Library title', ProviderIds: { Tmdb: '42' }, ...(kind === 'Episode' ? { SeriesId: 'ser1', SeriesName: 'Show', ParentIndexNumber: 1, IndexNumber: 2 } : {}) };
  const debounced = {};
  h.JE.helpers = { debounce: (fn, ms) => { debounced[ms] = fn; return () => {}; }, createObserver() {}, onViewPage() {}, getItemCached: async () => item };
  h.JE.core = { ...h.JE.core, ui: { placeDetailAction: (row, button) => row.appendChild(button) }, navigation: { onViewPage() {}, onNavigate() {} } };
  h.load('enhanced/itemdetails/features-details-page.js');
  debounced[100]();
  for (const m of ['arr/actions/title-actions.js', 'arr/actions/title-actions-sheet.js', 'arr/actions/title-actions-hosts.js']) h.load(m);
  return { ...h, writes, item };
}

/**
 * A browser runs a click's microtasks inside that click's dispatch, so `window.event` is still the click on the sheet
 * entry when the Hide button's continuation (after its awaited item read) runs. jsdom clears it when its synchronous
 * dispatch returns; this keeps it for the rest of the task, as the browser does (recorded live: "openSurface
 * event=click on je-actions-entry-label").
 */
function browserEventTiming(h) {
  let current;
  h.window.addEventListener('click', e => { if (e.target.closest?.('.je-actions-entry')) { current = e; setTimeout(() => { current = undefined; }, 0); } }, true);
  Object.defineProperty(h.window, 'event', { configurable: true, get: () => current });
}

async function mountRow(h) {
  await settle();
  const page = h.document.querySelector('#itemDetailPage');
  const row = page.querySelector('.mainDetailButtons');
  assert.ok(row.querySelector('.je-detail-hide-btn'), 'the details page drew its Hide button in the row');
  h.JE.titleActions.mountRow(row, page, h.JE.titleActions.context({ ...h.item, absent: false }));
  await settle();
  return row;
}
const dialog = h => h.document.querySelector('.je-hide-confirm-overlay');

for (const kind of ['Movie', 'Series', 'Episode']) {
  test(`PLAYR18-F1: More → Hide on a library ${kind.toLowerCase()} (after the awaited item read) asks, and confirming hides it`, async t => {
    const h = setup(t, kind);
    browserEventTiming(h);
    const row = await mountRow(h);
    row.querySelector('.je-actions-wide-more, .je-actions-more').click(); await settle();
    const entry = h.document.querySelector('.je-actions-entry[data-action="hide"]');
    assert.ok(entry, 'the sheet offers Hide');
    entry.click(); await settle();
    assert.ok(dialog(h), 'the confirmation stays open');
    const confirm = dialog(h).querySelector('.je-hide-confirm-hide, .je-hide-confirm-episode, button.je-hide-confirm-primary') || [...dialog(h).querySelectorAll('button')].at(-1);
    confirm.click(); await settle();
    assert.ok(h.writes.length > 0, 'the hide was saved');
  });
}

test('control: the row\'s own Hide button (a direct press) asks and hides', async t => {
  const h = setup(t, 'Movie');
  browserEventTiming(h);
  const row = await mountRow(h);
  row.querySelector('.je-detail-hide-btn').click(); await settle();
  assert.ok(dialog(h), 'the confirmation is open');
  [...dialog(h).querySelectorAll('button')].at(-1).click(); await settle();
  assert.ok(h.writes.length > 0, 'the hide was saved');
});

test('the confirmation still belongs to the press\'s operation: the row re-renders while it is open → it closes, nothing hidden', async t => {
  const h = setup(t, 'Movie');
  const row = await mountRow(h);
  row.querySelector('.je-actions-wide-more, .je-actions-more').click(); await settle();
  h.document.querySelector('.je-actions-entry[data-action="hide"]').click(); await settle();
  assert.ok(dialog(h), 'the confirmation is open');
  const button = dialog(h).querySelectorAll('button');
  row.replaceWith(row.cloneNode(true)); h.JE.titleActions.scan(); await settle();
  assert.equal(dialog(h), null, 'closed with its operation');
  [...button].at(-1).click(); await settle();
  assert.equal(h.writes.length, 0);
});
