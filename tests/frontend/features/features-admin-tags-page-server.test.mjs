import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, deferred, plain, jsRoot } from '../helpers/harness.mjs';
import { LIBRARY, OTHER_LIBRARY, BASE, catalog, same, serverPatch, boot, setup, TWO_PAGES, signedIn } from '../helpers/admin-tags-page.mjs';

test('a save sends only the changed fields, each with the value read before the edit', async t => {
  const h = setup(t);
  // Another admin (or the main configuration page) changed two fields meanwhile.
  h.server.DevMode = true;
  h.server.GenreTagsEnabled = true;
  h.change(h.$('#tagsHideOnHover'), true);
  assert.equal(h.$('#jeTaSaved').dataset.state, 'saving');
  await h.save();
  assert.deepEqual(h.patches, [{ Changes: { TagsHideOnHover: true }, Expected: { TagsHideOnHover: false } }]);
  assert.equal(h.server.TagsHideOnHover, true);
  assert.equal(h.server.DevMode, true, 'untouched fields keep the newer server value');
  assert.equal(h.server.GenreTagsEnabled, true);
  assert.equal(h.$('#jeTaSaved').dataset.state, 'saved');
  // The next edit of the same field expects what the last save stored.
  h.change(h.$('#tagsHideOnHover'), false);
  await h.save();
  assert.deepEqual(h.patches[1], { Changes: { TagsHideOnHover: false }, Expected: { TagsHideOnHover: true } });
});

test('another administrator\'s save between this page\'s read and its write is kept (different fields)', async t => {
  const server = structuredClone(BASE);
  const gate = deferred();
  let first = true;
  const h = boot(t, {
    server,
    // Hold this page's request until a second administrator saved another field.
    patch: async (body) => { if (first) { first = false; await gate.promise; } return serverPatch(server, body); },
  });
  const root = h.document.getElementById('jeTaRoot');
  const ctx = h.A.createPage(root, structuredClone(server));
  h.cleanup.push(() => ctx.dispose());
  h.change(root.querySelector('#tagsHideOnHover'), true);
  const saved = ctx.flush();
  await h.settle();
  serverPatch(server, { Changes: { DisableTagsOnSearchPage: true }, Expected: { DisableTagsOnSearchPage: false } });
  gate.resolve();
  assert.equal(await saved, true);
  assert.equal(server.TagsHideOnHover, true);
  assert.equal(server.DisableTagsOnSearchPage, true, 'the other administrator\'s field is not written back');
});

test('both administrators editing the same field: Changed elsewhere, nothing overwritten, Keep mine or Take theirs', async t => {
  const h = setup(t);
  h.server.StatusTagsJustAddedDays = 9;   // saved by someone else after this page loaded 7
  h.change(h.$('#statusTagsJustAddedDays'), '8');
  h.change(h.$('#tagsHideOnHover'), true);
  assert.equal(await h.ctx.flush(), false);
  assert.equal(h.server.StatusTagsJustAddedDays, 9, 'theirs is not overwritten');
  assert.equal(h.server.TagsHideOnHover, true, 'the other field in the refused request still saves');
  const chip = h.$('#jeTaSaved');
  assert.equal(chip.dataset.state, 'conflict');
  assert.match(chip.textContent, /admin_tags_conflict:admin_tags_badges_just_added_days/);
  // A later edit elsewhere saves without touching the refused field.
  h.change(h.$('#disableTagsOnSearchPage'), true);
  assert.equal(await h.ctx.flush(), false);
  assert.equal(h.server.DisableTagsOnSearchPage, true);
  assert.ok(!('StatusTagsJustAddedDays' in h.patches.at(-1).Changes));
  // Keep mine: saved over theirs, against their value.
  chip.querySelector('[data-je-keep]').click();
  assert.equal(await h.ctx.flush(), true);
  assert.deepEqual(h.patches.at(-1), { Changes: { StatusTagsJustAddedDays: 8 }, Expected: { StatusTagsJustAddedDays: 9 } });
  assert.equal(h.server.StatusTagsJustAddedDays, 8);
  assert.equal(chip.dataset.state, 'saved');
  // Take theirs: the page shows their value and sends nothing for it.
  h.server.StatusTagsJustAddedDays = 12;
  h.change(h.$('#statusTagsJustAddedDays'), '3');
  assert.equal(await h.ctx.flush(), false);
  const count = h.patches.length;
  chip.querySelector('[data-je-theirs]').click();
  assert.equal(await h.ctx.flush(), true);
  assert.equal(h.patches.length, count, 'nothing more is sent');
  assert.equal(h.server.StatusTagsJustAddedDays, 12);
  assert.equal(h.ctx.config.StatusTagsJustAddedDays, 12);
  assert.equal(h.$('#statusTagsJustAddedDays').value, '12');
  assert.equal(chip.dataset.state, 'saved');
});

test('a failed save says so, keeps the change and retries', async t => {
  const h = setup(t);
  h.expectConsoleError(/could not save the Media Tags settings/);
  let fail = true;
  // A second page over a server that fails once.
  h.ctx.dispose();
  const server = structuredClone(BASE);
  const root = h.document.getElementById('jeTaRoot');
  const ctx = h.A.createPage(root, structuredClone(server), { api: { get: async () => structuredClone(server), patch: async (changes, expected) => { if (fail) throw new Error('offline'); return serverPatch(server, { Changes: changes, Expected: expected }); } }, confirm: () => true });
  h.cleanup.push(() => ctx.dispose());
  h.change(root.querySelector('#disableTagsOnSearchPage'), true);
  assert.equal(await ctx.flush(), false);
  assert.equal(root.querySelector('#jeTaSaved').dataset.state, 'error');
  fail = false;
  root.querySelector('[data-je-retry]').click();
  await ctx.flush();
  assert.equal(server.DisableTagsOnSearchPage, true);
  assert.equal(root.querySelector('#jeTaSaved').dataset.state, 'saved');
});

/** Two retained Jellyfin page elements for the Media Tags page, as Jellyfin keeps them for distinct URLs. */

test('a failed save survives navigating to another Media Tags view: still pending there, and Retry saves it', async t => {
  const server = structuredClone(BASE);
  let fail = true;
  const writes = [];
  const asked = [];
  const h = boot(t, {
    server,
    url: 'http://jellyfin.test/web/index.html#/configurationpage?name=JellyfinEnhancedMediaTags&tab=layout',
    patch: (body) => { if (fail) throw new Error('offline'); writes.push(body); return serverPatch(server, body); },
    globals: { Dashboard: { confirm: (text, title, cb) => { asked.push(title); cb(false); } } },
  });
  h.expectConsoleError(/could not save the Media Tags settings/);
  h.document.body.innerHTML = TWO_PAGES;
  const [first, second] = h.document.querySelectorAll('.page');
  const a = await h.A.activate(first);
  h.cleanup.push(() => a.dispose());
  h.change(first.querySelector('#tagsHideOnHover'), true);
  assert.equal(await a.flush(), false, 'the save failed');
  assert.equal(first.querySelector('#jeTaSaved').dataset.state, 'error');
  assert.match(first.querySelector('#jeTaSaved').textContent, /admin_tags_save_failed_fields:admin_tags_hide_on_hover/);
  // Another Media Tags deep link: the first view is torn down, the edit is not.
  h.window.location.hash = '#/configurationpage?name=JellyfinEnhancedMediaTags&tab=groups';
  const b = await h.A.activate(second);
  h.cleanup.push(() => b.dispose());
  assert.equal(first.querySelector('.je-ta-tabs'), null, 'the old view is emptied');
  assert.equal(server.TagsHideOnHover, false);
  assert.equal(second.querySelector('#tagsHideOnHover').checked, true, 'the new view shows the unsaved edit');
  assert.equal(b.config.TagsHideOnHover, true);
  const chip = second.querySelector('#jeTaSaved');
  assert.equal(chip.dataset.state, 'error', 'not "All changes saved"');
  assert.match(chip.textContent, /admin_tags_save_failed_fields:admin_tags_hide_on_hover/);
  assert.deepEqual(plain(h.A.pendingState()), { state: 'error', fields: ['TagsHideOnHover'], failed: ['TagsHideOnHover'] });
  // Leaving Media Tags altogether while it is still failing asks; the edit stays either way.
  h.window.location.hash = '#/dashboard';
  await h.A.leaveWithPending();
  assert.deepEqual(asked, ['admin_tags_leave_title']);
  assert.deepEqual(plain(h.A.pendingState().fields), ['TagsHideOnHover']);
  // Back on the page with the server healthy again: Retry saves it.
  h.window.location.hash = '#/configurationpage?name=JellyfinEnhancedMediaTags&tab=groups';
  fail = false;
  chip.querySelector('[data-je-retry]').click();
  await b.flush();
  assert.equal(server.TagsHideOnHover, true);
  assert.equal(writes.length, 1);
  assert.equal(chip.dataset.state, 'saved');
  assert.deepEqual(plain(h.A.pendingState()), { state: 'saved', fields: [], failed: [] });
});

test('a torn-down page saves nothing: a reused root has one set of listeners, and Back/Forward saves a change once', async t => {
  const server = structuredClone(BASE);
  const h = boot(t, { server, url: 'http://jellyfin.test/web/index.html#/configurationpage?name=JellyfinEnhancedMediaTags&tab=layout' });
  h.document.body.innerHTML = TWO_PAGES;
  const [first, second] = h.document.querySelectorAll('.page');
  // A view torn down while its controls are still in the document: an event saves nothing.
  const root = first.querySelector('.je-tag-admin');
  const gone = h.A.createPage(root, structuredClone(server));
  const control = root.querySelector('#tagsHideOnHover');
  gone.dispose();
  h.change(control, true);
  assert.equal(gone.pending(), false);
  assert.equal(await gone.flush(), false);
  assert.equal(h.patches.length, 0);
  root.replaceChildren();
  // Back/Forward over two retained views: the first root is rebuilt, its old listeners are gone.
  const a = await h.A.activate(first);
  h.window.location.hash = '#/configurationpage?name=JellyfinEnhancedMediaTags&tab=groups';
  const b = await h.A.activate(second);
  h.window.location.hash = '#/configurationpage?name=JellyfinEnhancedMediaTags&tab=layout';
  const again = await h.A.activate(first);
  h.cleanup.push(() => { a.dispose(); b.dispose(); again.dispose(); });
  assert.equal(a.disposed, true);
  h.change(first.querySelector('#disableTagsOnSearchPage'), true);
  await again.flush();
  assert.equal(h.patches.length, 1, 'one change, one save');
  assert.deepEqual(h.patches[0].Changes, { DisableTagsOnSearchPage: true });
});

test('a cache summary that answers after the page was torn down starts no polling', async t => {
  const answer = deferred();
  let summaries = 0;
  const server = structuredClone(BASE);
  const h = boot(t, {
    server,
    apiClient: {
      ajax: async (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith('/tag-cache/summary')) { summaries++; return answer.promise; }
        if (path.endsWith('/tag-styles/catalog')) return catalog;
        return null;
      },
    },
  });
  const delays = [];
  const realSetTimeout = h.window.setTimeout;
  h.window.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, ms, ...rest); };
  const ctx = h.A.createPage(h.document.getElementById('jeTaRoot'), structuredClone(server));
  assert.equal(h.document.getElementById('jeTaRoot').dataset.tab, 'overview', 'Overview asks for the summary when shown');
  assert.equal(summaries, 1);
  ctx.dispose();
  answer.resolve({ enabled: true, entries: 5, lastModified: 0, rebuilding: true });
  await h.settle(); await h.settle();
  assert.ok(!delays.includes(3000), 'no poll was scheduled');
  assert.equal(summaries, 1);
});

test('the cache rebuild poll redraws only the cache card: a focused Layout or Rules control keeps keyboard focus', async t => {
  const polls = [];
  let rebuilding = true;
  const rules = [{ Enabled: true, When: [{ Field: 'type', Value: 'Episode' }], Layout: 'bands', Density: 'full' }, { Enabled: true, When: [{ Field: 'type', Value: 'Movie' }], Layout: 'minimal', Density: 'full' }];
  const h = boot(t, { server: { ...BASE, TagLookRules: rules }, routes: { '/tag-cache/summary': () => ({ enabled: true, entries: 123, lastModified: 0, rebuilding }) } });
  const realSetTimeout = h.window.setTimeout;
  h.window.setTimeout = (fn, ms, ...rest) => (ms === 3000 ? (polls.push(fn), 777) : realSetTimeout(fn, ms, ...rest));
  const root = h.document.getElementById('jeTaRoot');
  const ctx = h.A.createPage(root, structuredClone({ ...BASE, TagLookRules: rules }));
  h.cleanup.push(() => ctx.dispose());
  for (let i = 0; i < 5; i++) await h.settle();
  assert.equal(root.querySelector('[data-ov="cache-state"]').textContent, 'admin_tags_rebuilding');
  assert.equal(polls.length, 1, 'following the rebuild');
  ctx.openTab('layout');
  const selector = '#tagGroupAdminRows [data-group="quality"] [data-slot="tc"]';
  const focused = root.querySelector(selector);
  focused.focus();
  polls.shift()();
  for (let i = 0; i < 5; i++) await h.settle();
  assert.equal(h.document.activeElement, focused, 'the poll left the Layout control alone');
  assert.equal(focused.isConnected, true);
  assert.equal(polls.length, 1, 'still following the rebuild');

  // Any other redraw (another view's save, a late answer): the same control of the new rows has focus.
  ctx.refresh({ controls: false });
  assert.equal(focused.isConnected, false, 'the rows were redrawn');
  assert.equal(h.document.activeElement, root.querySelector(selector));
  ctx.openTab('rules');
  root.querySelector('.je-ta-rule[data-index="1"] [data-act="move"][data-dir="-1"]').focus();
  ctx.refresh({ controls: false });
  assert.equal(h.document.activeElement, root.querySelector('.je-ta-rule[data-index="1"] [data-act="move"][data-dir="-1"]'));

  // The rebuild finishes: the cache card says so and the poll stops.
  rebuilding = false;
  polls.shift()();
  for (let i = 0; i < 5; i++) await h.settle();
  assert.equal(root.querySelector('[data-ov="cache-state"]').textContent, 'common_on');
  assert.equal(root.querySelector('[data-ov="rebuild"]').disabled, false);
  assert.equal(polls.length, 0);
});

test('the page shown again while a save is on its way keeps the value being saved, and a later edit saves after it', async t => {
  const server = structuredClone(BASE);
  const gate = deferred();
  let held = true;
  const h = boot(t, {
    server,
    patch: async (body) => { if (held) { held = false; await gate.promise; } return serverPatch(server, body); },
  });
  h.document.body.innerHTML = TWO_PAGES;
  const page = h.document.querySelector('.page');
  const ctx = await h.A.activate(page);
  h.cleanup.push(() => ctx.dispose());
  h.change(page.querySelector('#tagsHideOnHover'), true);
  const saved = ctx.flush();
  await h.settle();
  assert.equal(h.patches.length, 1, 'the save is on its way');
  // viewshow on the same view: a reload with the server's (old) configuration.
  assert.equal(await h.A.activate(page), ctx);
  assert.equal(ctx.config.TagsHideOnHover, true, 'the value being saved is not replaced');
  assert.equal(page.querySelector('#tagsHideOnHover').checked, true);
  // An edit made meanwhile belongs to the next save.
  h.change(page.querySelector('#disableTagsOnSearchPage'), true);
  gate.resolve();
  assert.equal(await saved, true);
  await ctx.flush();
  assert.deepEqual(h.patches.map((p) => p.Changes), [{ TagsHideOnHover: true }, { DisableTagsOnSearchPage: true }]);
  assert.equal(server.TagsHideOnHover, true);
  assert.equal(server.DisableTagsOnSearchPage, true);
  assert.equal(page.querySelector('#jeTaSaved').dataset.state, 'saved');
  assert.equal(ctx.pending(), false);
});

test('the settings failing to load show an error with Retry, not an endless loading line', async t => {
  const server = structuredClone(BASE);
  let fail = true;
  const h = boot(t, { server, apiClient: { getPluginConfiguration: async () => { if (fail) throw new Error('offline'); return structuredClone(server); } } });
  h.expectConsoleError(/could not load the Media Tags settings/);
  h.document.body.innerHTML = '<div class="page" id="JellyfinEnhancedMediaTagsPage"><div class="je-tag-admin"><p class="je-ta-wait" role="status">Loading Media Tags settings…</p></div></div>';
  const page = h.document.querySelector('.page');
  const root = page.querySelector('.je-tag-admin');
  assert.equal(await h.A.activate(page), null);
  assert.equal(root.querySelector('[role="status"]'), null, 'the loading line is gone');
  assert.match(root.querySelector('[role="alert"]').textContent, /admin_tags_load_failed/);
  fail = false;
  root.querySelector('[data-je-reload]').click();
  for (let i = 0; i < 50 && !root.querySelector('.je-ta-tabs'); i++) await h.settle();
  assert.ok(root.querySelector('.je-ta-tabs'), 'Retry builds the page');
  assert.equal(root.querySelector('[role="alert"]'), null);
  const ctx = await h.A.activate(page);
  h.cleanup.push(() => ctx.dispose());
  assert.equal(ctx.root, root);
});


test('Server: cache off keeps the browser cache on, excluded libraries and the clear signal are saved', async t => {
  const h = setup(t, { config: { TagCacheExcludeLibraries: true, TagCacheExcludedLibraryIds: OTHER_LIBRARY } });
  await h.settle(); await h.settle();
  const boxes = h.$$('[data-libs] input');
  assert.deepEqual(boxes.map((b) => [b.dataset.libraryId, b.checked]), [[LIBRARY, false], [OTHER_LIBRARY, true]]);
  h.change(boxes[0], true);
  await h.save();
  // Only the ticked library is added; the stored ids stay as they were.
  assert.equal(h.server.TagCacheExcludedLibraryIds, `${OTHER_LIBRARY},${LIBRARY}`);
  assert.equal(h.$('[data-field-row="enableTagsLocalStorageFallback"]').hidden, true);
  h.change(h.$('#tagCacheServerMode'), false);
  await h.save();
  assert.equal(h.server.TagCacheServerMode, false);
  assert.equal(h.server.EnableTagsLocalStorageFallback, true, 'without the server cache the browser cache is always on');
  assert.equal(h.$('[data-field-row="enableTagsLocalStorageFallback"]').hidden, false);
  assert.equal(h.$('#tagCacheExcludeLibraries').disabled, true);
  h.$('#clearTagsCacheBtn').click();
  await h.settle(); await h.settle();
  assert.ok(h.server.ClearLocalStorageTimestamp > 0);
  assert.equal(h.$('#nativePosterTagsWebClientNames').disabled, true, 'client names need native posters on');
});


test('each section module is a self-contained file the page loads, and every declaration is one line', () => {
  const dir = resolve(jsRoot, 'enhanced/admintags/sections');
  const h = createHarness({ JE: {} });
  try {
    h.load('enhanced/admintags/admin-tags.js');
    const listed = h.JE.adminTags.SECTION_FILES.filter((f) => f.startsWith('sections/')).map((f) => f.slice(9)).sort();
    assert.deepEqual(plain(listed), readdirSync(dir).filter((f) => f.endsWith('.js')).sort(), 'SECTION_FILES lists every section module');
  } finally { h.close(); }
  // The generators (scripts/generate_config_flag_groups.py, WhatsNewService) read field declarations lexically.
  for (const file of readdirSync(dir)) {
    const text = readFileSync(resolve(dir, file), 'utf8');
    for (const line of text.split('\n')) {
      if (/^\s*\{ id: '/.test(line)) assert.match(line, /^\s*\{ id: '\w+', key: '\w+', type: '\w+'.*label: '\w+'/, `${file}: ${line.trim().slice(0, 60)}`);
      // Helpers/MediaTagsPageFields.cs reads a section's own writes from one line too.
      if (/^\s*writes:/.test(line)) assert.match(line, /^\s*writes: \['\w+'(, '\w+')*\],$/, `${file}: ${line.trim()}`);
    }
  }
});

for (const action of ['#jeTaApplyAll', '#rebuildTagCacheBtn']) {
  test(`a session switch while ${action} flushes pending fields prevents its POST`, async t => {
    let user = 'admin-a';
    const held = deferred();
    const h = setup(t, { apiClient: { getCurrentUserId: () => user }, patch: () => held.promise });
    h.ctx.set('TagsHideOnHover', true);
    h.$(action).click();
    await h.settle();
    assert.equal(h.patches.length, 1, 'action is waiting for its save');
    user = 'admin-b';
    held.resolve({ values: { TagsHideOnHover: true } });
    await h.settle(); await h.settle();
    assert.deepEqual(h.posts, []);
    assert.equal(h.ctx.isCurrent(), false);
  });
}




// Session ownership of pending server mutations.
test('signing out drops the pending edits and the view; the next administrator sees none of them', async t => {
  const server = structuredClone(BASE);
  let fail = true;
  const { who, apiClient } = signedIn();
  const h = boot(t, { server, session: true, apiClient, patch: (body) => { if (fail) throw new Error('offline'); return serverPatch(server, body); } });
  h.expectConsoleError(/could not save the Media Tags settings/);
  h.document.body.innerHTML = TWO_PAGES;
  const [first, second] = h.document.querySelectorAll('.page');
  const a = await h.A.activate(first);
  h.cleanup.push(() => a.dispose());
  h.change(first.querySelector('#tagsHideOnHover'), true);
  assert.equal(await a.flush(), false);
  assert.deepEqual(plain(h.A.pendingState()), { state: 'error', fields: ['TagsHideOnHover'], failed: ['TagsHideOnHover'] });
  // Jellyfin's logout: the credentials go, the document stays.
  h.window.ApiClient.setAuthenticationInfo(null, null);
  assert.equal(h.JE.session.getUserId(), null);
  assert.deepEqual(plain(h.A.pendingState()), { state: 'saved', fields: [], failed: [] });
  assert.equal(a.disposed, true);
  assert.equal(first.querySelector('.je-ta-tabs'), null, 'the view is emptied');
  // Another administrator signs in and opens the page: nothing of the first one's.
  h.window.ApiClient.setAuthenticationInfo('token-b', 'admin-b');
  assert.equal(who.user, 'admin-b');
  fail = false;
  const b = await h.A.activate(second);
  h.cleanup.push(() => b.dispose());
  assert.equal(second.querySelector('#tagsHideOnHover').checked, false);
  assert.equal(b.config.TagsHideOnHover, false);
  assert.equal(second.querySelector('#jeTaSaved').dataset.state, 'saved');
  assert.equal(await b.flush(), true);
  assert.equal(h.patches.length, 1, 'only the failed attempt, made while the first administrator was signed in');
  assert.equal(server.TagsHideOnHover, false, 'the first administrator\'s edit was never sent with the new credentials');
  // Their own edits save as usual.
  h.change(second.querySelector('#disableTagsOnSearchPage'), true);
  await b.flush();
  assert.deepEqual(h.patches.at(-1).Changes, { DisableTagsOnSearchPage: true });
});

test('answers for the signed-out session are ignored: a save on its way, and settings still loading', async t => {
  const server = structuredClone(BASE);
  const held = deferred();
  const load = deferred();
  let holdLoad = false;
  const { apiClient } = signedIn();
  const h = boot(t, {
    server, session: true,
    apiClient: { ...apiClient, getPluginConfiguration: async () => { if (holdLoad) { holdLoad = false; await load.promise; } return structuredClone(server); } },
    patch: async () => { await held.promise; throw new Error('offline'); },
  });
  h.document.body.innerHTML = TWO_PAGES;
  const [first, second] = h.document.querySelectorAll('.page');
  const a = await h.A.activate(first);
  h.cleanup.push(() => a.dispose());
  h.change(first.querySelector('#tagsHideOnHover'), true);
  const saving = a.flush();
  await h.settle();
  assert.equal(h.patches.length, 1, 'the save is on its way');
  h.window.ApiClient.setAuthenticationInfo(null, null);
  // The old request fails after the sign-out: no error, no retry, nothing pending.
  held.resolve();
  assert.equal(await saving, false);
  await h.settle();
  assert.deepEqual(plain(h.A.pendingState()), { state: 'saved', fields: [], failed: [] });
  assert.equal(h.patches.length, 1);
  // The page opened while signed in as A, its settings answering after A signed out: not built.
  h.window.ApiClient.setAuthenticationInfo('token-a', 'admin-a');
  holdLoad = true;
  const opening = h.A.activate(second);
  await h.settle();
  h.window.ApiClient.setAuthenticationInfo(null, null);
  load.resolve();
  assert.equal(await opening, null);
  assert.equal(second.querySelector('.je-ta-tabs'), null);
});

test('another server (or a missed sign-out) is noticed before saving or showing the page', async t => {
  const server = structuredClone(BASE);
  let fail = true;
  const { who, apiClient } = signedIn();
  // No core/session.js: the page compares the ApiClient identity itself.
  const h = boot(t, { server, apiClient, patch: (body) => { if (fail) throw new Error('offline'); return serverPatch(server, body); } });
  h.expectConsoleError(/could not save the Media Tags settings/);
  h.document.body.innerHTML = TWO_PAGES;
  const [first, second] = h.document.querySelectorAll('.page');
  const a = await h.A.activate(first);
  h.cleanup.push(() => a.dispose());
  h.change(first.querySelector('#tagsHideOnHover'), true);
  assert.equal(await a.flush(), false);
  fail = false;
  // Same administrator id, another server.
  who.server = 'server-b';
  first.querySelector('[data-je-retry]')?.click();
  await h.settle();
  assert.equal(h.patches.length, 1, 'Retry sends nothing to the other server');
  assert.deepEqual(plain(h.A.pendingState()), { state: 'saved', fields: [], failed: [] });
  const b = await h.A.activate(second);
  h.cleanup.push(() => b.dispose());
  assert.equal(second.querySelector('#tagsHideOnHover').checked, false);
  assert.equal(server.TagsHideOnHover, false);
});

for (const session of [false, true]) {
  test(`a server switch while the settings load is noticed when they answer: the old server's are dropped and the page is built from the new one (${session ? 'core/session.js' : 'no session module'})`, async t => {
    // Three servers, each with its own value; the ApiClient switches server with no sign-out and no hook (a replaced client).
    const servers = {
      'server-a': structuredClone({ ...BASE, TagsHideOnHover: true }),
      'server-b': structuredClone({ ...BASE, TagsHideOnHover: false }),
      'server-c': structuredClone({ ...BASE, TagsHideOnHover: false }),
    };
    const { who, apiClient } = signedIn();
    const loads = [];
    let held = null;
    const h = boot(t, {
      server: servers['server-a'], session,
      apiClient: {
        ...apiClient,
        getPluginConfiguration: async () => {
          const from = who.server;
          loads.push(from);
          if (held) { const gate = held; held = null; await gate.promise; }
          return structuredClone(servers[from]);
        },
      },
    });
    h.document.body.innerHTML = TWO_PAGES;
    const page = h.document.querySelector('.page');
    // First load: asked of A, answered after the switch to B.
    let gate = held = deferred();
    const opening = h.A.activate(page);
    await h.settle();
    who.server = 'server-b';
    gate.resolve();
    const b = await opening;
    h.cleanup.push(() => b?.dispose());
    assert.deepEqual(loads, ['server-a', 'server-b'], 'A\'s answer is dropped and B is asked');
    assert.ok(b, 'the page is built for B');
    assert.equal(b.config.TagsHideOnHover, false);
    assert.equal(page.querySelector('#tagsHideOnHover').checked, false, 'nothing of A\'s settings shows');
    if (session) {
      // JE.session's reconcile catches up with the switch later: the page already belongs to B and stays.
      h.JE.session.checkNow('reconcile');
      assert.equal(b.disposed, false);
      assert.ok(page.querySelector('#tagsHideOnHover'));
    }
    // A retained view shown again: its reload is asked of B and answered after the switch to C.
    servers['server-b'].TagsHideOnHover = true;
    gate = held = deferred();
    const reloading = h.A.activate(page);
    await h.settle();
    who.server = 'server-c';
    gate.resolve();
    const c = await reloading;
    h.cleanup.push(() => c?.dispose());
    assert.deepEqual(loads, ['server-a', 'server-b', 'server-b', 'server-c']);
    assert.equal(b.disposed, true, 'B\'s view is torn down, not reloaded with B\'s answer');
    assert.ok(c && c !== b, 'a new view is built for C');
    assert.equal(c.config.TagsHideOnHover, false);
    assert.equal(page.querySelector('#tagsHideOnHover').checked, false);
    assert.equal(h.patches.length, 0);
  });
}

test('the preview\'s Tag Styles from the previous server are not drawn after a server switch', async t => {
  const server = structuredClone({ ...BASE, TagStylesEnabled: true });
  const { who, apiClient } = signedIn();
  const styles = deferred();
  const h = boot(t, {
    server, apiClient,
    routes: { '/JellyfinEnhanced/tag-styles': async () => { await styles.promise; return { quality: { '4K': { color: 'rgba(40, 50, 60, 1)' } } }; } },
  });
  h.load('tags/tag-styles.js');
  h.load('enhanced/settingspanel/ui-panel-tag-preview.js');
  h.document.body.innerHTML = TWO_PAGES;
  const page = h.document.querySelector('.page');
  const a = await h.A.activate(page);
  h.cleanup.push(() => a.dispose());
  // A's styles answer after the client switched to another server.
  who.server = 'server-b';
  styles.resolve();
  await h.settle(); await h.settle();
  assert.equal(h.document.getElementById('je-tag-admin-preview-styles'), null);
  assert.equal(a.disposed, true, 'the view of the previous server is torn down');
});

test('a leave prompt answered after the administrator changed takes no one back to the page', async t => {
  const server = structuredClone(BASE);
  const { apiClient } = signedIn();
  const prompts = [];
  const h = boot(t, {
    server, session: true, apiClient,
    patch: () => { throw new Error('offline'); },
    // The dashboard's confirm dialog, answered when the test says.
    globals: { Dashboard: { confirm: (text, title, answer) => { prompts.push(answer); } } },
  });
  h.expectConsoleError(/could not save the Media Tags settings/);
  h.document.body.innerHTML = TWO_PAGES;
  const page = h.document.querySelector('.page');
  const a = await h.A.activate(page);
  h.cleanup.push(() => a.dispose());
  h.change(page.querySelector('#tagsHideOnHover'), true);
  // The same administrator answering "go back": the page opens again.
  h.window.location.hash = '#/home';
  let leaving = h.A.leaveWithPending();
  await h.settle(); await h.settle();
  assert.equal(prompts.length, 1);
  prompts[0](true);
  await leaving;
  assert.match(h.window.location.hash, /name=JellyfinEnhancedMediaTags/);
  // Asked again; while the prompt is open, A signs out and B signs in.
  h.window.location.hash = '#/home';
  leaving = h.A.leaveWithPending();
  await h.settle(); await h.settle();
  assert.equal(prompts.length, 2);
  h.window.ApiClient.setAuthenticationInfo(null, null);
  h.window.ApiClient.setAuthenticationInfo('token-b', 'admin-b');
  prompts[1](true);
  await leaving;
  assert.equal(h.window.location.hash, '#/home', 'A\'s answer does not move B');
  assert.deepEqual(plain(h.A.pendingState()), { state: 'saved', fields: [], failed: [] });
});

test('a destructive action confirmed after the administrator changed does not run for the next one', async t => {
  const server = structuredClone(BASE);
  const { apiClient } = signedIn();
  const prompts = [];
  const h = boot(t, {
    server, session: true, apiClient,
    globals: { Dashboard: { confirm: (text, title, answer) => { prompts.push(answer); } } },
  });
  h.document.body.innerHTML = TWO_PAGES;
  const [first, second] = h.document.querySelectorAll('.page');
  const a = await h.A.activate(first);
  h.cleanup.push(() => a.dispose());
  // The same administrator confirming: the action runs.
  first.querySelector('#jeTaApplyAll').click();
  await h.settle(); await h.settle();
  assert.equal(prompts.length, 1);
  prompts[0](true);
  await h.settle(); await h.settle(); await h.settle();
  assert.deepEqual(h.posts.filter(p => p.endsWith('/reset-all-users-settings')).length, 1);
  // Asked again; while the prompt is open, A signs out and B signs in. A's "yes" runs nothing.
  first.querySelector('#jeTaApplyAll').click();
  await h.settle(); await h.settle();
  assert.equal(prompts.length, 2);
  h.window.ApiClient.setAuthenticationInfo(null, null);
  h.window.ApiClient.setAuthenticationInfo('token-b', 'admin-b');
  prompts[1](true);
  await h.settle(); await h.settle(); await h.settle();
  assert.equal(h.posts.filter(p => p.endsWith('/reset-all-users-settings')).length, 1, 'A\'s answer applies nothing with B\'s credentials');
  // The same for a cache rebuild started from B's own view, confirmed after B signs out.
  const b = await h.A.activate(second);
  h.cleanup.push(() => b.dispose());
  const rebuilding = h.A.rebuildCache(b);
  await h.settle(); await h.settle();
  assert.equal(prompts.length, 3);
  h.window.ApiClient.setAuthenticationInfo(null, null);
  prompts[2](true);
  await rebuilding;
  assert.equal(h.posts.filter(p => p.endsWith('/tag-cache/rebuild')).length, 0, 'no rebuild is started for a signed-out session');
});

// ── Focus kept on lists redrawn by an answer or another view (opus R4-3) ──

test('Rules: the item titles arriving keep keyboard focus on a look\'s Remove and Edit buttons', async t => {
  const looks = Array.from({ length: 60 }, (_, i) => ({ ItemId: (i + 1).toString(16).padStart(32, '0'), Layout: 'bands', Density: 'full', LockedAt: 100 - i }));
  for (const act of ['remove', 'edit']) {
    await t.test(act, async (st) => {
      const held = deferred();
      const requests = [];
      const h = setup(st, {
        config: { TagLookItemOverrides: looks },
        apiClient: {
          getJSON: async (url) => {
            if (!url.includes('/Items')) return [];
            const ids = new URL(url).searchParams.get('Ids').split(',');
            requests.push(ids);
            const answer = { Items: ids.map((id) => ({ Id: id, Name: `Title ${id}`, Type: 'Movie' })) };
            return requests.length === 2 ? held.promise.then(() => answer) : answer;
          },
        },
      });
      for (let i = 0; i < 5; i++) await h.settle();
      h.ctx.openTab('rules');
      for (let i = 0; i < 5; i++) await h.settle();
      assert.equal(requests.length, 2, 'the second batch of titles is on its way');
      const button = h.$(`[data-item="${looks[0].ItemId}"] [data-act="${act}"]`);
      button.focus();
      assert.equal(h.document.activeElement, button);
      held.resolve();
      for (let i = 0; i < 8; i++) await h.settle();
      const again = h.$(`[data-item="${looks[0].ItemId}"] [data-act="${act}"]`);
      assert.equal(button.isConnected, false, 'the list was redrawn');
      assert.equal(h.document.activeElement, again, 'focus stays on the same control of the redrawn row');
    });
  }
});

test('Server: a redraw of the offered presets keeps keyboard focus on a preset\'s Share or Remove', async t => {
  const list = [{ v: 1, kind: 'je-media-tags-preset', id: 'family-ab12cd', name: 'Family', description: '', settings: { TagScale: 'larger' } },
    { v: 1, kind: 'je-media-tags-preset', id: 'night-ef34gh', name: 'Night', description: '', settings: { TagGap: 'tight' } }];
  const h = setup(t, { config: { TagOfferedPresets: JSON.stringify(list) }, url: 'http://jellyfin.test/web/index.html#/configurationpage?name=JellyfinEnhancedMediaTags&tab=server' });
  for (let i = 0; i < 5; i++) await h.settle();
  for (const action of ['share', 'remove']) {
    const button = h.$(`[data-offer-id="night-ef34gh"] [data-offer-action="${action}"]`);
    button.focus();
    h.ctx.refresh();
    assert.equal(button.isConnected, false, 'the list was redrawn');
    assert.equal(h.document.activeElement, h.$(`[data-offer-id="night-ef34gh"] [data-offer-action="${action}"]`), `focus stays on ${action}`);
  }
});

test('Overview: a redraw of the group buttons keeps keyboard focus on the same group', async t => {
  const h = setup(t);
  for (let i = 0; i < 5; i++) await h.settle();
  const button = h.$('.je-ta-ov-group[data-group="rating"]');
  button.focus();
  h.ctx.refresh();
  assert.equal(button.isConnected, false, 'the buttons were redrawn');
  assert.equal(h.document.activeElement, h.$('.je-ta-ov-group[data-group="rating"]'));
});

// ── Excluded libraries belong to their own view (astra R5-2 = opus R5 3) ──

const THIRD_LIBRARY = 'cccccccccccccccccccccccccccccccc';
const settleMany = async (h, n = 8) => { for (let i = 0; i < n; i++) await h.settle(); };
const libraryBoxes = (root) => [...root.querySelectorAll('[data-libs] input')].map((b) => ({ id: b.dataset.libraryId, checked: b.checked }));

test('Server: a replacement view never shows or writes the previous view\'s library list; ticking one keeps a newly excluded library', async t => {
  const old = [{ ItemId: LIBRARY, Name: 'Movies' }];
  const h = setup(t, { config: { TagCacheExcludeLibraries: true }, apiClient: { getJSON: async () => old } });
  await settleMany(h);
  h.ctx.openTab('server');
  assert.deepEqual(libraryBoxes(h.root), [{ id: LIBRARY, checked: false }]);
  h.ctx.dispose();
  // While away, another library was added and excluded.
  h.server.TagCacheExcludedLibraryIds = OTHER_LIBRARY;
  const gate = deferred();
  h.window.ApiClient.getJSON = () => gate.promise;
  const next = h.A.createPage(h.root, structuredClone(h.server));
  h.cleanup.push(() => next.dispose());
  next.openTab('server');
  await settleMany(h);
  assert.deepEqual(libraryBoxes(h.root), [], 'no list until this view\'s own answer');
  assert.match(h.root.querySelector('[data-libs]').textContent, /hidden_content_admin_loading/);
  gate.resolve([...old, { ItemId: OTHER_LIBRARY, Name: 'New library' }]);
  await settleMany(h);
  assert.deepEqual(libraryBoxes(h.root), [{ id: LIBRARY, checked: false }, { id: OTHER_LIBRARY, checked: true }]);
  h.change(h.root.querySelector(`[data-library-id="${LIBRARY}"]`), true);
  await next.flush();
  assert.equal(h.server.TagCacheExcludedLibraryIds, `${OTHER_LIBRARY},${LIBRARY}`, 'the new exclusion is kept');
  assert.deepEqual(h.patches.at(-1).Expected, { TagCacheExcludedLibraryIds: OTHER_LIBRARY });
});

test('Server: ticking or unticking a library changes only that id; ids the list does not show are kept', async t => {
  const h = setup(t, { config: { TagCacheExcludeLibraries: true, TagCacheExcludedLibraryIds: `${THIRD_LIBRARY},${OTHER_LIBRARY}` } });
  await settleMany(h);
  h.ctx.openTab('server');
  h.change(h.root.querySelector(`[data-library-id="${LIBRARY}"]`), true);
  await h.save();
  assert.equal(h.server.TagCacheExcludedLibraryIds, `${THIRD_LIBRARY},${OTHER_LIBRARY},${LIBRARY}`);
  h.change(h.root.querySelector(`[data-library-id="${OTHER_LIBRARY}"]`), false);
  await h.save();
  assert.equal(h.server.TagCacheExcludedLibraryIds, `${THIRD_LIBRARY},${LIBRARY}`, 'the library this list does not show stays excluded');
  assert.deepEqual(h.patches.map((p) => Object.keys(p.Changes)), [['TagCacheExcludedLibraryIds'], ['TagCacheExcludedLibraryIds']]);
});

test('Server: after a same-tab server switch the new view shows only its own libraries; a failed list writes nothing', async t => {
  const server = structuredClone({ ...BASE, TagCacheExcludeLibraries: true, TagCacheExcludedLibraryIds: OTHER_LIBRARY });
  const { who, apiClient } = signedIn('admin-a', 'server-1');
  let answer = async () => [{ ItemId: '11111111111111111111111111111111', Name: 'Server 1 Movies' }];
  const h = boot(t, { server, session: true, apiClient: { ...apiClient, getJSON: (url) => (url.includes('VirtualFolders') ? answer() : Promise.resolve([])) } });
  h.document.body.innerHTML = TWO_PAGES;
  const [first, second] = h.document.querySelectorAll('.page');
  const a = await h.A.activate(first);
  h.cleanup.push(() => a.dispose());
  a.openTab('server');
  await settleMany(h);
  assert.deepEqual(libraryBoxes(first), [{ id: '11111111111111111111111111111111', checked: false }]);
  // Signed out and into server 2, whose list is slow and then fails.
  window_signOut(h, who, 'server-2');
  const gate = deferred();
  answer = () => gate.promise;
  const b = await h.A.activate(second);
  h.cleanup.push(() => b.dispose());
  b.openTab('server');
  await settleMany(h);
  assert.deepEqual(libraryBoxes(second), [], 'server 1\'s libraries are not shown');
  gate.reject(new Error('offline'));
  await settleMany(h);
  assert.deepEqual(libraryBoxes(second), []);
  assert.match(second.querySelector('[data-libs]').textContent, /admin_tags_server_libraries_failed/);
  assert.equal(server.TagCacheExcludedLibraryIds, OTHER_LIBRARY, 'the stored exclusion stays');
  assert.equal(h.patches.length, 0);
});

/** Sign out and in on another server in the same tab, as Jellyfin does. */
function window_signOut(h, who, serverName) {
  h.window.ApiClient.setAuthenticationInfo(null, null);
  who.server = serverName;
  h.window.ApiClient.setAuthenticationInfo('token-b', 'admin-b');
}

test('Server: a library list redrawn while a box has focus updates it in place, so it keeps focus', async t => {
  const h = setup(t, { config: { TagCacheExcludeLibraries: true } });
  await settleMany(h);
  h.ctx.openTab('server');
  const box = h.root.querySelector(`[data-library-id="${OTHER_LIBRARY}"]`);
  box.focus();
  // Another view saved an exclusion: the same box shows it and keeps focus.
  h.ctx.reload({ ...structuredClone(h.server), TagCacheExcludedLibraryIds: OTHER_LIBRARY });
  assert.equal(box.isConnected, true, 'updated in place');
  assert.equal(box.checked, true);
  assert.equal(h.document.activeElement, box);
});

test('Overview: a new view shows its own cache summary, never the previous view\'s counts', async t => {
  let summary = async () => ({ enabled: true, entries: 1234, lastModified: 0, rebuilding: false });
  const h = setup(t, { routes: { '/tag-cache/summary': () => summary() } });
  await settleMany(h);
  h.ctx.openTab('overview');
  await settleMany(h);
  assert.match(h.root.querySelector('[data-ov="cache"]').textContent, /1,234|1234/);
  h.ctx.dispose();
  const gate = deferred();
  summary = () => gate.promise;
  const next = h.A.createPage(h.root, structuredClone(h.server));
  h.cleanup.push(() => next.dispose());
  next.openTab('overview');
  await settleMany(h);
  assert.doesNotMatch(h.root.querySelector('[data-ov="cache"]').textContent, /1,234|1234/, 'not the previous view\'s count');
  gate.resolve({ enabled: true, entries: 7, lastModified: 0, rebuilding: false });
  await settleMany(h);
  assert.match(h.root.querySelector('[data-ov="cache"]').textContent, /^7admin_tags_overview_cached/);
});
