import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHarness, jsonResponse, jsRoot } from '../helpers/harness.mjs';
import { tab, settingsServer, en } from '../helpers/settings-tabs.mjs';

// Stage 1 fix round 10: the page learns when the server runs another JE build than the one it booted against (the server
// names its build in the bootstrap and on every JE answer): it shows a notice to reload, once, before a save can be lost to a
// contract the older page doesn't know (RBS1-R10-10: an older page's save was refused and its panel showed success).

const notice = h => h.document.querySelectorAll('.je-reload-notice');

function page(t, serverBuild) {
  const h = createHarness({
    html: '<script plugin="Jellyfin Enhanced" version="1.2.3-100"></script>',
    // The build the bootstrap named when this page booted.
    JE: { t: key => en[key] ?? key, serverBuild: '1.2.3-100' },
    fetch: async () => {
      const response = jsonResponse({ ok: true });
      if (serverBuild) response.headers.set('X-JE-Build', serverBuild);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }
  });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  for (const path of ['core/navigation.js', 'core/session.js', 'core/mutation-queue.js', 'core/api-client.js']) h.load(path);
  return h;
}

test('R10-10: a JE answer from another build shows one reload notice', async t => {
  const h = page(t, '1.2.4-200');
  await h.JE.core.api.plugin('/version', { skipCache: true });
  await h.JE.core.api.plugin('/version', { skipCache: true });
  assert.equal(notice(h).length, 1);
  assert.match(notice(h)[0].textContent, /reload/i);
  assert.ok(notice(h)[0].querySelector('button'), 'with a button that reloads');
});

test('R10-10 control: answers from the page\'s own build (or naming none) show nothing', async t => {
  for (const build of ['1.2.3-100', null]) {
    const h = page(t, build);
    await h.JE.core.api.plugin('/version', { skipCache: true });
    assert.equal(notice(h).length, 0);
  }
});

test('R10-10: after a bootstrap named one build, an answer naming another shows the notice', async t => {
  const docs = { Settings: {}, Shortcuts: { Shortcuts: [] }, Bookmark: { Bookmarks: {} }, Elsewhere: {}, HiddenContent: { Items: {}, Settings: {} } };
  const h = await tab(t, settingsServer(docs), {
    fetch: async () => { const response = jsonResponse({ ok: true }); response.headers.set('X-JE-Build', '1.2.4'); response.headers.set('Cache-Control', 'no-store'); return response; }
  });
  assert.equal(h.JE.serverBuild, '1.2.3', 'the bootstrap\'s build is the one the page booted against');
  assert.equal(notice(h).length, 0);
  await h.JE.core.api.plugin('/version', { skipCache: true });
  assert.equal(notice(h).length, 1);
});

// Stage 1 fix round 11: the page's build is the build of the code it runs (written into plugin.js as the server serves it;
// the page's script tag names it otherwise), never the one a fresh bootstrap names (RBS1-R11-10: a cached bundle of an
// earlier build booted against a newer server took the bootstrap's build as its own and never asked for a reload).
test('R11-10: a cached earlier bundle booted against a newer bootstrap asks for a reload', async t => {
  const docs = { Settings: {}, Shortcuts: { Shortcuts: [] }, Bookmark: { Bookmarks: {} }, Elsewhere: {}, HiddenContent: { Items: {}, Settings: {} } };
  // The page's script tag (and so its cached scripts) is build 1.2.3; the server answers 1.2.4.
  const h = await tab(t, settingsServer(docs), { build: '1.2.4' });
  assert.equal(h.document.querySelector('script[plugin]').getAttribute('version'), '1.2.3');
  assert.equal(h.JE.pageBuild, '1.2.3');
  assert.equal(h.JE.serverBuild, '1.2.4');
  assert.equal(notice(h).length, 1, 'the running code is 1.2.3, whatever the bootstrap says');
});

test('R11-10: the build written into the entry script is the page\'s, even when its tag names another', async t => {
  const h = createHarness({
    html: '<script plugin="Jellyfin Enhanced" version="1.2.4-new"></script>',
    JE: {}, apiClient: { ajax: async () => { throw new Error('offline'); } }
  });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  // As the server serves plugin.js: its build written in (an earlier build's copy, served from the browser's cache).
  const source = readFileSync(resolve(jsRoot, 'plugin.js'), 'utf8').replace("const EMBEDDED_BUILD = '__JE_PAGE_BUILD__';", "const EMBEDDED_BUILD = '1.2.3-old';");
  assert.notEqual(source, readFileSync(resolve(jsRoot, 'plugin.js'), 'utf8'));
  h.window.eval(`[function () {\n${source}\n}][0]();`);
  assert.equal(h.window.JellyfinEnhanced.pageBuild, '1.2.3-old');
});
