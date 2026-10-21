// Stage 1 fix round 6 (Q-REBUILD1FIX5-1): the per-user settings store writes a document only after one read of that
// document succeeded in this session. A boot whose read of settings.json failed used to leave the store on an empty
// document, and the next whole save (a panel toggle, the calendar's or reviews' legacy save) sent defaults for every field.
// Stage 1 fix round 7: writes are operations (only what changed), and a write to an unread document first reads it (the
// read publishes the stored document); only when that read fails is the write refused, with the reason.
// plugin.js, session.js and config.js run unchanged; the server is scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, jsRoot } from '../helpers/harness.mjs';

const en = JSON.parse(readFileSync(resolve(jsRoot, 'locales/en.json'), 'utf8'));
// Play edge (D46): config.js sends through the session-bound core transport, so the session action loads too.
const modules = ['core/navigation.js', 'core/session.js', 'core/session-action.js', 'core/mutation-queue.js', 'enhanced/config.js'];
const STORED = { DisplayLanguage: 'de', AutoPauseEnabled: false, QualityTagsEnabled: true, LastOpenedTab: 'settings' };

async function until(predicate) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 1));
  }
  assert.ok(predicate(), 'condition not reached');
}

/**
 * Boots the plugin. `boot`: 'ok' (bootstrap holds the documents), 'settings-failed' (the bootstrap could not read
 * settings.json: null), 'per-endpoint' (no bootstrap; settings.json GET fails, the rest load).
 * `reads`: how later GETs of settings.json answer ('ok' | 'fail').
 */
function boot(t, { mode = 'ok', reads = 'ok' } = {}) {
  const posts = [], gets = [], patches = [], consents = [];
  let readMode = reads;
  const documents = { Settings: { ...STORED }, Shortcuts: { Shortcuts: [] }, Bookmark: { Bookmarks: { one: { itemId: 'x' } } }, Elsewhere: {}, HiddenContent: { Items: {} }, Ddd: { Triggers: [3] } };
  const h = createHarness({
    html: '<script plugin="Jellyfin Enhanced" version="1.2.3"></script>',
    apiClient: { ajax: async request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/bootstrap')) {
        if (mode === 'per-endpoint') throw new Error('no bootstrap');
        const UserSettings = { ...documents };
        if (mode === 'settings-failed') UserSettings.Settings = null;
        return { UserId: 'user-a', Version: '1.2.3', PublicConfig: {}, PrivateConfig: null, UserSettings, ComponentScripts: modules };
      }
      if (path.endsWith('/component-scripts.json')) return modules;
      if (path === '/Plugins') return [];
      if (path.endsWith('/public-config') || path.endsWith('/version')) return {};
      const m = /\/user-settings\/user-a\/(.+)$/.exec(path);
      if (m && request.type === 'GET') {
        gets.push(m[1]);
        if (m[1] === 'settings.json' && (mode === 'per-endpoint' && gets.filter(g => g === 'settings.json').length === 1 || readMode === 'fail')) throw new Error('offline');
        const key = { 'settings.json': 'Settings', 'shortcuts.json': 'Shortcuts', 'bookmark.json': 'Bookmark', 'elsewhere.json': 'Elsewhere', 'hidden-content.json': 'HiddenContent', 'ddd-triggers.json': 'Ddd' }[m[1]];
        return key ? structuredClone(documents[key]) : {};
      }
      if (m && request.type === 'POST') { posts.push({ file: m[1], body: JSON.parse(request.data) }); return JSON.parse(request.data); }
      if (m && request.type === 'PATCH' && m[1] === 'consent') { consents.push(JSON.parse(request.data)); return { Consents: {} }; }
      if (m && request.type === 'PATCH') { patches.push({ file: m[1], body: JSON.parse(request.data) }); return { success: true }; }
      return {};
    } }
  });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  h.window.requestIdleCallback = callback => { queueMicrotask(() => callback({ didTimeout: false, timeRemaining: () => 100 })); return 1; };
  const append = h.document.head.appendChild.bind(h.document.head);
  h.document.head.appendChild = node => {
    const result = append(node);
    if (node.tagName !== 'SCRIPT') return result;
    queueMicrotask(() => {
      const path = new URL(node.src).pathname;
      if (path.endsWith('/translations.js')) {
        h.load('enhanced/translations.js');
        h.window.JellyfinEnhanced.loadTranslations = async () => ({});
      } else if (path.endsWith('/bundle.js')) {
        h.window.__JE_BUNDLE_TOTAL = modules.length;
        h.window.__JE_BUNDLE_MODULES = modules.map(name => () => h.load(name));
      }
      node.onload?.();
    });
    return result;
  };
  h.load('plugin.js');
  const toasts = [];
  return {
    ...h, posts, gets, patches, consents, toasts,
    get JE() { return h.window.JellyfinEnhanced; },
    setReads(value) { readMode = value; },
    async ready() {
      await until(() => h.window.JellyfinEnhanced.initialized);
      // The scripted server answers ApiClient.ajax: the core transport's legacy ajax forwards to it (as in harness.mjs).
      const core = h.window.JellyfinEnhanced.core;
      core.api = core.api || {};
      core.api.ajax = core.api.ajax || (options => h.window.ApiClient.ajax(options));
      h.window.JellyfinEnhanced.toast = (message, ms) => toasts.push({ message, ms });
      h.window.JellyfinEnhanced.t = key => en[key] ?? key;
    },
    settle: () => new Promise(r => setTimeout(r, 20))
  };
}

for (const mode of ['settings-failed', 'per-endpoint']) {
  test(`after a failed boot read (${mode}) nothing is written while reads fail; the person is told why; then a read comes first`, async t => {
    const h = boot(t, { mode, reads: 'fail' });
    await h.ready();
    await h.JE.updateSettings({ autoPauseEnabled: true });
    h.JE.currentSettings.reviewsExpandedByDefault = true;
    await h.JE.saveUserSettings('settings.json', h.JE.currentSettings); // a legacy whole save (calendar, reviews)
    assert.equal(h.patches.length + h.posts.length, 0, 'nothing was sent over the stored settings');
    await assert.rejects(h.JE.updateSettings({ qualityTagsEnabled: false }, { throwOnError: true }), /was not read/);
    assert.deepEqual([...h.JE.userConfig.unreadDocuments], ['settings.json']);
    assert.equal(h.toasts.length, 3);
    assert.equal(h.toasts.at(-1).message, en.settings_save_not_read);
    assert.ok(h.toasts.at(-1).ms >= 5000, 'shown long enough to read');
    // Once a read succeeds, the write waits for it and sends only its own change; the stored fields are shown.
    h.setReads('ok');
    const reads = h.gets.filter(g => g === 'settings.json').length;
    await h.JE.updateSettings({ autoPauseEnabled: true });
    assert.equal(h.gets.filter(g => g === 'settings.json').length, reads + 1, 'one read first');
    assert.equal(h.posts.length, 0);
    assert.deepEqual(h.patches, [{ file: 'settings.json', body: { Set: { AutoPauseEnabled: true } } }]);
    assert.equal(h.JE.currentSettings.displayLanguage, 'de');
    assert.equal(h.JE.currentSettings.qualityTagsEnabled, true);
    assert.equal(h.JE.currentSettings.autoPauseEnabled, true);
  });
}

test('while reads keep failing every write is refused; a personal consent (one field) still goes', async t => {
  const h = boot(t, { mode: 'settings-failed', reads: 'fail' });
  await h.ready();
  await h.JE.updateSettings({ autoPauseEnabled: true });
  await h.settle();
  await h.JE.updateSettings({ autoPauseEnabled: true });
  await h.settle();
  assert.equal(h.patches.length + h.posts.length, 0);
  await h.JE.setPersonalConsent('listSwapIn', true, { throwOnError: true });
  assert.equal(h.consents.length, 1);
  assert.deepEqual(h.consents[0], { Field: 'ListSwapIn', Value: true });
});

test('control: after a successful boot read a change goes at once, alone', async t => {
  const h = boot(t, { mode: 'ok' });
  await h.ready();
  await h.JE.updateSettings({ autoPauseEnabled: true });
  assert.deepEqual(h.patches, [{ file: 'settings.json', body: { Set: { AutoPauseEnabled: true } } }]);
  assert.equal(h.toasts.length, 0);
});

test('other documents follow the same rule: a bookmark added after a failed bookmark read reads first, then adds only itself', async t => {
  const h = boot(t, { mode: 'ok' });
  await h.ready();
  // As if the boot read of bookmark.json had failed (plugin.js marks it unread and records no copy of it; the store reads
  // the record when it first opens the document).
  h.JE.userConfig.unreadDocuments?.push('bookmark.json');
  delete h.JE.userConfig.readDocuments?.['bookmark.json'];
  h.setReads('ok');
  await h.JE.patchUserSettings('bookmark.json', { upsert: { two: { itemId: 'y' } } }, { throwOnError: true });
  assert.ok(h.gets.includes('bookmark.json'), 'the stored bookmarks were read first');
  assert.deepEqual(h.patches, [{ file: 'bookmark.json', body: { Upsert: { Two: { ItemId: 'y' } }, Remove: [] } }]);
  assert.deepEqual(Object.keys(h.JE.userConfig.bookmark.bookmarks).sort(), ['one', 'two']);
});

test('a document only a module reads (Does the Dog Die triggers): a change reads it first, refused while that read fails', async t => {
  const h = boot(t, { mode: 'ok' });
  await h.ready();
  h.setReads('fail');
  // The scripted server fails only settings.json reads: make the trigger read fail too.
  const ajax = h.window.ApiClient.ajax;
  h.window.ApiClient.ajax = async request => { if (request.type === 'GET' && request.url.includes('ddd-triggers.json')) throw new Error('offline'); return ajax(request); };
  await assert.rejects(h.JE.patchUserSettings('ddd-triggers.json', { add: [1] }, { throwOnError: true }), /was not read/);
  assert.equal(h.patches.length, 0);
  h.window.ApiClient.ajax = ajax;
  await h.JE.patchUserSettings('ddd-triggers.json', { add: [1] }, { throwOnError: true });
  assert.deepEqual(h.patches, [{ file: 'ddd-triggers.json', body: { Add: [1], Remove: [] } }]);
  assert.deepEqual([...h.JE.internals.userDocument('ddd-triggers.json').document.Triggers], [3, 1], 'the stored pick stays');
});

test('before the boot read every document is unread, and the marker never travels in a document', async t => {
  const h = boot(t, { mode: 'ok' });
  const early = h.JE.userConfig;
  assert.deepEqual([...(early.unreadDocuments || [])], ['settings.json', 'shortcuts.json', 'bookmark.json', 'elsewhere.json', 'hidden-content.json']);
  assert.equal(Object.keys(early).includes('unreadDocuments'), false);
  assert.equal(JSON.stringify(early).includes('unreadDocuments'), false);
  assert.equal(JSON.stringify(early).includes('readDocuments'), false, 'the read record never travels in a document either');
  await h.ready();
});
