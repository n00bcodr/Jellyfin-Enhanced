import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, jsonResponse } from '../helpers/harness.mjs';
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
      return response;
    }
  });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  for (const path of ['core/navigation.js', 'core/session.js', 'core/api-client.js']) h.load(path);
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
    extra: ['core/api-client.js'],
    fetch: async () => { const response = jsonResponse({ ok: true }); response.headers.set('X-JE-Build', '1.2.4'); return response; }
  });
  assert.equal(h.JE.serverBuild, '1.2.3', 'the bootstrap\'s build is the one the page booted against');
  assert.equal(notice(h).length, 0);
  await h.JE.core.api.plugin('/version', { skipCache: true });
  assert.equal(notice(h).length, 1);
});
