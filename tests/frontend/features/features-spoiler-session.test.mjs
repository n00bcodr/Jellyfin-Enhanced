import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, jsonResponse } from '../helpers/harness.mjs';

// Stage 1 fix round 10: Spoiler Guard's preference saves go through one queue bound to the signed-in session. The session
// is checked right before each save is sent, and a switch of account cancels every save the previous person queued: none
// is ever sent with the next person's credentials (RBS1-R10-1: the queued save ran after the switch, as the new user).

const until = async predicate => {
  const deadline = performance.now() + 3000;
  while (!predicate() && performance.now() < deadline) await new Promise(r => setTimeout(r, 1));
  assert.ok(predicate(), 'condition not reached');
};

function mockedSession(t) {
  let epoch = 1;
  let user = 'a';
  const resets = new Map();
  const held = deferred();
  const prefs = { a: { HideTags: null, HideCast: null }, b: { HideTags: null, HideCast: null } };
  const writes = [];
  const h = createHarness({ JE: {
    pluginConfig: { SpoilerBlurEnabled: true },
    session: { getEpoch: () => epoch, isCurrent: e => e === epoch, onUserChange: (name, fn) => resets.set(name, fn) },
    core: { api: { plugin: async (path, options = {}) => {
      if (path === '/spoiler-blur/series') return { Prefs: structuredClone(prefs[user]) };
      // The credentials the request goes out with are the signed-in person's at the time it is sent.
      const owner = user;
      writes.push({ user: owner, body: options.body });
      if (writes.length === 1) await held.promise;
      Object.assign(prefs[owner], options.body.Set);
      return { success: true, prefs: structuredClone(prefs[owner]) };
    } } }
  } });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  for (const path of ['core/mutation-queue.js', 'enhanced/spoilerguard/ids.js', 'enhanced/spoilerguard/state.js']) h.load(path);
  return {
    h, prefs, writes, held, sg: h.JE.internals.spoilerGuard,
    switchTo(next) { user = next; epoch++; for (const fn of [...resets.values()]) fn({ userId: next }); }
  };
}

for (const switched of [true, false]) {
  test(`R10-1: queued Spoiler Guard preferences stay with the person who chose them (account switch: ${switched})`, async t => {
    const s = mockedSession(t);
    await s.sg.whenLoaded();
    const first = s.sg.setUserPrefs({ HideTags: false }, s.h.NATIVE);
    await until(() => s.writes.length === 1);
    const second = s.sg.setUserPrefs({ HideCast: false }, s.h.NATIVE);
    if (switched) { s.switchTo('b'); await s.sg.whenLoaded(); }
    s.held.resolve();
    await Promise.allSettled([first, second]);
    if (switched) {
      assert.equal(s.prefs.b.HideCast, null, 'the next person never receives the previous person\'s queued choice');
      assert.ok(s.writes.every(w => w.user === 'a'), 'nothing queued by the previous person is sent as the next one');
      assert.deepEqual(JSON.parse(JSON.stringify(s.sg.getUserPrefs())), { HideTags: null, HideCast: null }, 'the next person sees their own preferences');
    } else {
      assert.equal(s.prefs.a.HideCast, false);
      assert.equal(s.writes.length, 2);
      assert.equal(s.sg.getUserPrefs().HideCast, false);
    }
  });
}

test('R10-1: a save queued by the previous person is refused, not sent, and its caller is told', async t => {
  const s = mockedSession(t);
  await s.sg.whenLoaded();
  const first = s.sg.setUserPrefs({ HideTags: false }, s.h.NATIVE);
  await until(() => s.writes.length === 1);
  const second = s.sg.setUserPrefs({ HideCast: false }, s.h.NATIVE);
  s.switchTo('b');
  s.held.resolve();
  const outcome = await Promise.allSettled([first, second]);
  assert.equal(outcome[1].status, 'rejected');
  assert.equal(s.writes.length, 1);
  // The next person's own choice goes out at once (it doesn't wait behind the previous person's queue).
  await s.sg.whenLoaded();
  await s.sg.setUserPrefs({ HideCast: true }, s.h.NATIVE);
  assert.equal(s.prefs.b.HideCast, true);
  assert.deepEqual(s.writes.map(w => w.user), ['a', 'b']);
});

test('R10-1: with the real session and API client, a queued preference is never sent as the incoming person', async t => {
  let user = 'a';
  const held = deferred();
  const prefs = { a: { HideTags: null, HideCast: null }, b: { HideTags: null, HideCast: null } };
  const writes = [];
  const h = createHarness({
    JE: { pluginConfig: { SpoilerBlurEnabled: true } },
    apiClient: { getCurrentUserId: () => user },
    fetch: async (url, init) => {
      const owner = user;
      if (String(url).endsWith('/spoiler-blur/series')) return jsonResponse({ Prefs: structuredClone(prefs[owner]) });
      const body = JSON.parse(init.body);
      writes.push({ user: owner, body });
      if (writes.length === 1) await held.promise;
      Object.assign(prefs[owner], body.Set);
      return jsonResponse({ success: true, prefs: structuredClone(prefs[owner]) });
    }
  });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  for (const path of ['core/navigation.js', 'core/session.js', 'core/mutation-queue.js', 'core/api-client.js', 'enhanced/spoilerguard/state.js']) h.load(path);
  const sg = h.JE.internals.spoilerGuard;
  await sg.whenLoaded();
  const first = sg.setUserPrefs({ HideTags: false }, h.NATIVE);
  await until(() => writes.length === 1);
  const second = sg.setUserPrefs({ HideCast: false }, h.NATIVE);
  user = 'b';
  h.JE.session.checkNow('account switch');
  await sg.whenLoaded();
  held.resolve();
  await Promise.allSettled([first, second]);
  assert.equal(prefs.b.HideCast, null);
  assert.ok(writes.every(w => w.user === 'a'));
});
