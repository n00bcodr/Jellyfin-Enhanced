// Stage 1 fix round 7: the per-user settings store writes operations, never whole documents, and every caller (panel,
// legacy whole-document writers, bookmarks, Does the Dog Die) reads and writes through its one document. Another tab or
// device that changed something else between this page's read and its save keeps its change. plugin.js, session.js,
// config.js and the feature modules run unchanged against a scripted server that stores what it is sent: a whole document
// replaces the stored one (as the server's POST does), an operation changes only what it names (the PATCH routes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';
import { en, route, settingsServer, tab } from '../helpers/settings-tabs.mjs';

const STORED = { DisplayLanguage: 'de', AutoPauseEnabled: false, PauseScreenDelaySeconds: 5, ShowFileSizes: false, CalendarDisplayMode: 'list' };
const documents = extra => ({ Settings: { ...STORED }, Shortcuts: { Shortcuts: [] }, Bookmark: { Bookmarks: { Bm_one: { ItemId: 'x', Label: 'stored' } } }, Elsewhere: {}, HiddenContent: { Items: {} }, Ddd: { Triggers: [1] }, ...extra });

// RBS1-R7-4: a field-scoped panel change used to POST the whole (stale) settings document.
test('R7-4: a panel change saves only its field; another tab\'s newer delay (12) stays', async t => {
  const server = settingsServer(documents());
  const h = await tab(t, server);
  server.documents.Settings.PauseScreenDelaySeconds = 12; // another tab, after this one's read
  await h.JE.updateSettings({ autoPauseEnabled: true }, { throwOnError: true });
  assert.equal(server.documents.Settings.PauseScreenDelaySeconds, 12);
  assert.equal(server.documents.Settings.AutoPauseEnabled, true);
  assert.equal(server.documents.Settings.DisplayLanguage, 'de');
  // The answer brings the other tab's value into this tab's one document.
  assert.equal(h.JE.currentSettings.pauseScreenDelaySeconds, 12);
});

test('R7-4: a legacy whole-document writer (calendar, reviews, media info) sends only what it changed', async t => {
  const server = settingsServer(documents());
  const h = await tab(t, server);
  server.documents.Settings.PauseScreenDelaySeconds = 12;
  server.documents.Settings.ShowFileSizes = true;
  h.JE.currentSettings.calendarDisplayMode = 'grid';
  await h.JE.saveUserSettings('settings.json', h.JE.currentSettings, { throwOnError: true });
  assert.equal(server.documents.Settings.CalendarDisplayMode, 'grid');
  assert.equal(server.documents.Settings.PauseScreenDelaySeconds, 12);
  assert.equal(server.documents.Settings.ShowFileSizes, true);
});

test('the panel in two tabs: each tab\'s change survives, saved in either order', async t => {
  for (const order of [['a', 'b'], ['b', 'a']]) {
    const server = settingsServer(documents());
    const tabs = { a: await tab(t, server), b: await tab(t, server) };
    const change = { a: () => tabs.a.JE.updateSettings({ showFileSizes: true }, { throwOnError: true }), b: () => tabs.b.JE.updateSettings({ pauseScreenDelaySeconds: 9 }, { throwOnError: true }) };
    for (const name of order) await change[name]();
    assert.equal(server.documents.Settings.ShowFileSizes, true, order.join());
    assert.equal(server.documents.Settings.PauseScreenDelaySeconds, 9, order.join());
  }
});

// RBS1-R7-6: bookmarks after a blocked startup read: the read publishes the stored bookmarks before anything is written.
test('R7-6: a bookmark added after the startup read of bookmarks failed keeps the stored bookmark', async t => {
  const server = settingsServer(documents());
  const items = async () => ({ Items: [{ Id: 'item', Name: 'Movie', Type: 'Movie', ProviderIds: {} }] });
  const h = await tab(t, server, { unread: ['bookmark.json'], items });
  h.JE.pluginConfig.BookmarksEnabled = true;
  h.load('enhanced/bookmarks/bookmarks.js');
  h.document.body.insertAdjacentHTML('beforeend', '<div class="videoOsdBottom"><button class="btnUserRating" data-id="item"></button></div>');
  assert.deepEqual(Object.keys(h.JE.userConfig.bookmark.bookmarks), [], 'the failed read left no bookmarks in the page');
  // The person adds a bookmark; if the first try is refused they try again (as before round 7).
  let added = await h.JE.bookmarks.add(42, 'new').catch(() => null);
  if (!added) added = await h.JE.bookmarks.add(43, 'again').catch(() => null);
  assert.ok(added, 'a bookmark was added');
  assert.ok(server.documents.Bookmark.Bookmarks.Bm_one, 'the stored bookmark is still there');
  assert.equal(Object.keys(server.documents.Bookmark.Bookmarks).length, 2);
  assert.deepEqual(Object.keys(h.JE.userConfig.bookmark.bookmarks).sort(), Object.keys(server.documents.Bookmark.Bookmarks).map(k => k.charAt(0).toLowerCase() + k.slice(1)).sort(), 'the page shows what the server holds');
});

test('R7-6: a bookmark another tab added meanwhile survives this tab\'s add, delete and delete-all', async t => {
  const server = settingsServer(documents({ Bookmark: { Bookmarks: { Bm_one: { ItemId: 'x' }, Bm_two: { ItemId: 'y' } } } }));
  const items = async () => ({ Items: [{ Id: 'item', Name: 'Movie', Type: 'Movie', ProviderIds: {} }] });
  const h = await tab(t, server, { items });
  h.JE.pluginConfig.BookmarksEnabled = true;
  h.load('enhanced/bookmarks/bookmarks.js');
  h.document.body.insertAdjacentHTML('beforeend', '<div class="videoOsdBottom"><button class="btnUserRating" data-id="item"></button></div>');
  server.documents.Bookmark.Bookmarks.Bm_e1 = { ItemId: 'z' }; // another tab, before this tab's add
  await h.JE.bookmarks.add(5, 'mine');
  assert.ok(server.documents.Bookmark.Bookmarks.Bm_e1, 'kept by the add');
  await h.JE.bookmarks.delete('bm_one');
  assert.ok(server.documents.Bookmark.Bookmarks.Bm_e1, 'kept by the delete');
  assert.equal(server.documents.Bookmark.Bookmarks.Bm_one, undefined);
  server.documents.Bookmark.Bookmarks.Bm_e2 = { ItemId: 'w' }; // another tab, after this tab's last answer
  await h.JE.bookmarks.deleteAll();
  assert.deepEqual(Object.keys(server.documents.Bookmark.Bookmarks), ['Bm_e2'], 'delete-all removes what this page showed');
});

// RBS1-R7-6: the Does the Dog Die picker after a blocked startup read of the picks.
test('R7-6: trigger picks changed after the picks could not be read keep the stored pick', async t => {
  const server = settingsServer(documents());
  server.failGets.add('ddd-triggers.json');
  const topics = [{ Id: 1, Name: 'one', Group: 'G', Category: 'C' }, { Id: 2, Name: 'two', Group: 'G', Category: 'C' }];
  const entry = { Found: true, Confirmed: true, ItemId: 123, Guarded: false, PolicyRevision: 'p', Topics: [{ Id: 1, Name: 'one', Yes: 9, No: 1 }, { Id: 2, Name: 'two', Yes: 9, No: 1 }] };
  let view;
  const h = createHarness({ html: '<div id="itemDetailPage"><div class="itemExternalLinks"></div></div>',
    url: 'http://jellyfin.test/web/index.html#/details?id=movie',
    apiClient: { getItem: async () => ({ Type: 'Movie', ProviderIds: { Tmdb: '123' } }), ajax: async request => route(server, request) ?? {} },
    JE: { pluginConfig: { DoesTheDogDieEnabled: true }, userConfig: { settings: {} }, t: key => en[key] || key, toast() {},
      helpers: { onViewPage: cb => { view = cb; return () => {}; } },
      core: { api: { manager: { clearCacheMatching() {} }, plugin: async path => path.startsWith('/ddd/topics') ? { Topics: topics } : entry } } } });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  h.load('enhanced/config.js');
  h.load('others/doesthedogdie.js');
  h.JE.initializeDoesTheDogDieScript();
  const settle = () => new Promise(r => setTimeout(r, 30));
  const render = async () => { await view(null, h.document.getElementById('itemDetailPage'), h.window.location.hash); await settle(); };
  await render();
  server.failGets.delete('ddd-triggers.json'); // the read works again
  // The person ticks topic 2 and saves; if refused they try once more (as before round 7).
  for (let attempt = 0; attempt < 2 && !(server.documents.Ddd.Triggers || []).includes(2); attempt++) {
    h.document.querySelector('.je-ddd-gear').dispatchEvent(new h.window.Event('click', { bubbles: true }));
    await settle();
    const box = [...h.document.querySelectorAll('.je-ddd-row')].find(row => row.textContent.includes('Two'))?.querySelector('input');
    if (!box.checked) { box.checked = true; box.dispatchEvent(new h.window.Event('change')); }
    h.document.querySelector('.je-ddd-save').click();
    await settle();
  }
  assert.deepEqual([...server.documents.Ddd.Triggers].sort(), [1, 2], 'the stored pick (1) stays, the new one (2) is added');
});
