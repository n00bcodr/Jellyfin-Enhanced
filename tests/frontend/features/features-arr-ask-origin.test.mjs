import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, jsonResponse } from '../helpers/harness.mjs';

// Stage 1 fix round 12: a cancel, a search for the administrator and a family search belong to the session the person
// acted in, and so do their answers (RBS1-R12-3, P19/P20). Before, they published their success events without the check
// ask() made, so A's late answer refreshed B's surfaces; and a family search whose answer arrived after the switch
// resolved "ask instead", so its caller went on to ask as B.

function rig(t, answer) {
  let user = 'a';
  const posts = [], changes = [];
  let hold = null;
  const h = createHarness({
    JE: { pluginConfig: { ArrRequestsEnabled: true }, arrStatus: { enabled: () => true, tr: key => key }, t: key => key, toast() {} },
    apiClient: { getCurrentUserId: () => user, accessToken: () => 'fixture-' + user },
    fetch: async (url, init = {}) => {
      const path = String(url).replace('http://jellyfin.test/JellyfinEnhanced', '');
      // The raw adapter authenticates with the person's token: who sent it.
      posts.push({ path, who: /fixture-(\w+)/.exec(init.headers?.Authorization || '')?.[1] });
      if (hold) await hold;
      const { status, body } = answer(path);
      return jsonResponse(body, status);
    }
  });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  for (const file of ['core/navigation.js', 'core/session.js', 'core/mutation-queue.js', 'core/api-client.js', 'arr/ask/ask-core.js']) h.load(file);
  h.JE.arrAsk.onChange(change => changes.push(change.type));
  return {
    h, A: h.JE.arrAsk, posts, changes,
    hold() { const d = deferred(); hold = d.promise; return () => { hold = null; d.resolve(); }; },
    switchTo(next) { user = next; h.JE.session.checkNow('account switch'); }
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const ID = 'a'.repeat(32);

const CASES = [
  ['cancel', A => A.cancel(ID), () => ({ status: 200, body: { outcome: 'accepted', reason: 'cancelled', certainty: 'Succeeded', requestId: ID } })],
  ['administrator search', A => A.adminSearch('movie:tmdb:603', 'radarr-1'), () => ({ status: 200, body: { status: 'Succeeded', found: true } })],
  ['family search', A => A.familySearch('movie:tmdb:603'), () => ({ status: 200, body: { outcome: 'accepted', found: true } })],
];

for (const [name, run, answer] of CASES) test(`a ${name} answered after the account switch publishes nothing into the next person's page`, async t => {
  const r = rig(t, answer);
  const release = r.hold();
  const pending = run(r.A);
  await new Promise(resolve => setImmediate(resolve));
  r.switchTo('b');
  release();
  const result = await pending;
  await settle();
  assert.deepEqual(r.posts.map(p => p.who), ['a'], 'sent as A, before the switch');
  assert.deepEqual(r.changes, [], 'no change event for B');
  assert.equal(result?.stale, true, 'the caller learns it is stale');
  // Control: the same action as B, now, publishes for B.
  await run(r.A);
  assert.equal(r.changes.length, 1);
});

test('a family search whose "ask instead" arrives after the switch never lets its caller ask as the next person', async t => {
  const r = rig(t, path => path.endsWith('/search')
    ? { status: 200, body: { outcome: 'skipped', reason: 'not_requested', certainty: 'Rejected' } }
    : { status: 201, body: { outcome: 'accepted', reason: 'awaiting_approval', certainty: 'Succeeded', requestId: ID } });
  const release = r.hold();
  const pending = r.A.familySearch('movie:tmdb:603');
  await new Promise(resolve => setImmediate(resolve));
  r.switchTo('b');
  release();
  const result = await pending;
  assert.notEqual(result, null, 'null means "ask instead": a stale search must not say that');
  assert.equal(result.stale, true);
  // Control: B's own search that may not run still says "ask instead".
  assert.equal(await r.A.familySearch('movie:tmdb:603'), null);
});

test('an ask, cancel or search handed a stale origin is never re-bound to the next person', async t => {
  const r = rig(t, () => ({ status: 201, body: { outcome: 'accepted', reason: 'awaiting_approval', certainty: 'Succeeded', requestId: ID } }));
  const session = r.h.JE.core.userWrite.origin();
  r.switchTo('b');
  await r.A.ask(r.A.movieInput('movie:tmdb:603'), { session });
  await r.A.cancel(ID, { session });
  await r.A.familySearch('movie:tmdb:603', { session });
  await r.A.adminSearch('movie:tmdb:603', 'radarr-1', { session });
  assert.deepEqual(r.posts, [], 'nothing is sent for A after the switch, as anyone');
  assert.deepEqual(r.changes, []);
});
