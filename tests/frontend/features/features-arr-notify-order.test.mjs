import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';

// Stage 1 fix round 10: notification preference changes go through one queue per person, bound to the signed-in session:
// they reach the server one at a time in the order they were made, the session is checked right before each is sent (an
// account switch cancels the previous person's), and a preference read that began before a change was queued or answered
// is not taken over it (RBS1-R10-8: a delayed first change landed after the second; a pre-save read put the old value back).

const until = async predicate => {
  const deadline = performance.now() + 3000;
  while (!predicate() && performance.now() < deadline) await new Promise(r => setTimeout(r, 1));
  assert.ok(predicate(), 'condition not reached');
};

function setup(t, plugin, session) {
  const h = createHarness({ JE: {
    pluginConfig: { ArrNotificationsEnabled: true },
    ...(session ? { session } : {}),
    core: { api: { plugin } }
  } });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  h.load('core/mutation-queue.js');
  h.load('arr/notify/notify-core.js');
  return h;
}

test('R10-8: preference changes reach the server in the order they were made, whatever answers first', async t => {
  const first = deferred();
  let writes = 0;
  let stored = { ready: true, autoFollowRequests: true };
  const sent = [];
  const h = setup(t, async (path, options = {}) => {
    if (options.method === 'PUT') {
      const index = ++writes;
      sent.push(options.body);
      if (index === 1) await first.promise;
      stored = { ...stored, ...options.body };
    }
    return { prefs: structuredClone(stored), channels: {} };
  });
  await h.JE.arrNotify.loadPrefs();
  const n = h.JE.internals.arrNotify;
  const off = n.prefsCall('/acquire/notify/prefs', 'PUT', { ready: false });
  await until(() => writes === 1);
  const on = n.prefsCall('/acquire/notify/prefs', 'PUT', { ready: true });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(writes, 1, 'the second change waits for the first to be answered');
  first.resolve();
  await Promise.all([off, on]);
  assert.deepEqual(sent, [{ ready: false }, { ready: true }]);
  assert.equal(stored.ready, true, 'the last choice is what the server holds');
  assert.equal(h.JE.arrNotify.prefs.ready, true);
});

test('R10-8: a preference read that began before a change is not taken over its answer', async t => {
  const held = deferred();
  let reads = 0;
  let stored = { ready: true, autoFollowRequests: true };
  const h = setup(t, async (path, options = {}) => {
    if (options.method === 'PUT') { stored = { ...stored, ...options.body }; return { prefs: structuredClone(stored) }; }
    const answer = { prefs: structuredClone(stored) };
    if (++reads === 2) await held.promise;
    return answer;
  });
  await h.JE.arrNotify.loadPrefs();
  const read = h.JE.arrNotify.loadPrefs(true);
  await until(() => reads === 2);
  await h.JE.internals.arrNotify.prefsCall('/acquire/notify/prefs', 'PUT', { ready: false });
  assert.equal(h.JE.arrNotify.prefs.ready, false);
  held.resolve();
  await read;
  assert.equal(stored.ready, false);
  assert.equal(h.JE.arrNotify.prefs.ready, false, 'the read from before the change does not put true back');
});

test('R10-8: a change queued by the previous person is never sent after an account switch', async t => {
  let epoch = 1;
  let user = 'a';
  const resets = new Map();
  const held = deferred();
  const writes = [];
  const h = setup(t, async (path, options = {}) => {
    if (options.method === 'PUT') {
      writes.push({ user, body: options.body });
      if (writes.length === 1) await held.promise;
    }
    return { prefs: { ready: true } };
  }, { getEpoch: () => epoch, isCurrent: e => e === epoch, onUserChange: (name, fn) => resets.set(name, fn) });
  await h.JE.arrNotify.loadPrefs();
  const n = h.JE.internals.arrNotify;
  const first = n.prefsCall('/acquire/notify/prefs', 'PUT', { ready: false });
  await until(() => writes.length === 1);
  const second = n.prefsCall('/acquire/notify/prefs', 'PUT', { episodes: false });
  user = 'b'; epoch++;
  for (const fn of [...resets.values()]) fn({ userId: 'b' });
  held.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(writes.map(w => w.user), ['a']);
  assert.equal(b.ok, false);
  assert.equal(a.ok, false, 'an answer for the previous person is not this person\'s');
});
