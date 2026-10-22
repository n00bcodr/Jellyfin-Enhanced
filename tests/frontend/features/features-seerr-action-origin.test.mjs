import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, jsonResponse } from '../helpers/harness.mjs';

// Stage 1 fix round 12: a Seerr request or issue report belongs to the session the person acted in, through the reads it
// makes first (the override rules, the media id), and its answer's effects (cache invalidation, the requested events, the
// usage count) belong to that session only. Before, requestMedia/requestTvSeasons evaluated the override rules and
// reportIssue read the internal media id before the POST was bound, so a switch in between sent A's request as B.

function rig(t) {
  let user = 'a';
  const posts = [], usage = [], events = [];
  let readHold = null, postHold = null;
  const h = createHarness({
    JE: { pluginConfig: { JellyseerrEnabled: true }, t: key => key, toast() {} },
    apiClient: { getCurrentUserId: () => user, accessToken: () => 'fixture-' + user },
    fetch: async (url, init = {}) => {
      const method = init.method || 'GET';
      const who = init.headers?.['X-Jellyfin-User-Id'];
      if (method === 'GET') {
        if (readHold) await readHold;
        return jsonResponse({ mediaInfo: { id: 5 } });
      }
      if (postHold) await postHold;
      posts.push({ url: String(url), who, body: JSON.parse(init.body || 'null') });
      return jsonResponse({ id: 7 });
    }
  });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  for (const file of ['core/navigation.js', 'core/session.js', 'core/mutation-queue.js', 'core/api-client.js']) h.load(file);
  h.JE.helpers = { ...(h.JE.helpers || {}), trackUsage: key => usage.push(key) };
  h.load('jellyseerr/api.js');
  for (const event of ['jellyseerr-media-requested', 'jellyseerr-tv-requested']) h.document.addEventListener(event, () => events.push(event));
  return {
    h, api: h.JE.jellyseerrAPI, posts, usage, events,
    hold(kind) { const d = deferred(); if (kind === 'read') readHold = d.promise; else postHold = d.promise; return () => { readHold = postHold = null; d.resolve(); }; },
    switchTo(next) { user = next; h.JE.session.checkNow('account switch'); }
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

for (const kind of ['movie', 'seasons']) test(`a Seerr ${kind} request waiting for its override rules is never sent as the next person; B's own request is`, async t => {
  const r = rig(t);
  const rules = deferred();
  r.api.evaluateOverrideRules = () => rules.promise;
  const asked = kind === 'movie'
    ? r.api.requestMedia(42, 'movie', {}, false, { originalLanguage: 'ja' })
    : r.api.requestTvSeasons(42, [1], {}, { originalLanguage: 'ja' });
  r.switchTo('b');
  rules.resolve({ serverId: 2 });
  await asked.catch(() => {});
  await settle();
  assert.deepEqual(r.posts, [], "A's request is cancelled, never sent as B");
  assert.deepEqual(r.events, []);
  assert.deepEqual(r.usage, []);
  // A fresh gesture after the switch is B's own and goes out.
  r.api.evaluateOverrideRules = async () => null;
  await r.api.requestMedia(43, 'movie');
  assert.deepEqual(r.posts.map(p => p.who), ['b']);
});

test('an issue report waiting for its media id read is never sent as the next person', async t => {
  const r = rig(t);
  const release = r.hold('read');
  const reported = r.api.reportIssue(42, 'movie', 1, 'no sound');
  r.switchTo('b');
  release();
  await reported.catch(() => {});
  await settle();
  assert.deepEqual(r.posts, []);
  await r.api.reportIssue(42, 'movie', 1, 'no sound');
  assert.deepEqual(r.posts.map(p => p.who), ['b']);
});

test("a request answered after the switch is A's: nothing is invalidated, announced or counted for B", async t => {
  const r = rig(t);
  const release = r.hold('post');
  const asked = r.api.requestMedia(42, 'movie');
  await new Promise(resolve => setImmediate(resolve));
  r.switchTo('b');
  release();
  await asked.catch(() => {});
  await settle();
  assert.deepEqual(r.posts.map(p => p.who), ['a'], 'sent as A before the switch');
  assert.deepEqual(r.events, [], 'no requested event for B');
  assert.deepEqual(r.usage, [], 'not counted as B');
});

test('a Seerr request handed a stale origin is never re-bound to the next person', async t => {
  const r = rig(t);
  const origin = r.h.JE.core.userWrite.origin();
  r.switchTo('b');
  await r.api.requestMedia(42, 'movie', {}, false, null, null, origin).catch(() => {});
  await r.api.reportIssue(42, 'movie', 1, 'no sound', 0, 0, origin).catch(() => {});
  await settle();
  assert.deepEqual(r.posts, []);
});
