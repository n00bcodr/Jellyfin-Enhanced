import { spoilerState as stateFixture } from '../../helpers/spoiler-state.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../../helpers/harness.mjs';

function setup(t, plugin = async () => stateFixture()) {
  let epoch = 0;
  const listeners = new Map();
  const calls = [];
  const h = createHarness({ JE: {
    pluginConfig: { SpoilerBlurEnabled: true },
    core: { api: { plugin: (...args) => { calls.push(args); return plugin(...args); } } },
    session: { getEpoch: () => epoch, isCurrent: e => e === epoch, onUserChange: (key, fn) => listeners.set(key, fn) },
  }});
  t.after(() => h.close());
  h.load('enhanced/spoilerguard/ids.js');
  h.load('enhanced/spoilerguard/state.js');
  return { ...h, calls, state: h.JE.internals.spoilerGuard, switchUser(userId = 'new-user') { epoch++; for (const fn of listeners.values()) fn({userId}); } };
}

for (const [input, expected] of [['AA-BB','aabb'], [null,''], [{},''], [42,'42']]) {
  test(`spoiler IDs normalize ${JSON.stringify(input)}`, t => {
    const {state} = setup(t);
    assert.equal(state.normalizeId(input), expected);
  });
}
test('spoiler state coalesces loading, normalizes IDs, copies preferences and resets on user change', async t => {
  const h = setup(t, async () => stateFixture({Series:{'AA-BB':{}},Movies:{'CC-DD':{}},Collections:{'EE-FF':{}},PendingTmdb:{'TV:42':{}},Prefs:{hideRatings:true}}));
  assert.equal(h.state.loadState(), h.state.loadState());
  await h.state.whenLoaded();
  assert.equal(h.calls.length,1);
  assert.equal(h.state.isEnabledFor('AABB'),true);
  assert.equal(h.state.isEnabledForKind('movie','CC-DD'),true);
  assert.equal(h.state.isEnabledForKind('collection','eeff'),true);
  assert.equal(h.state.isTmdbEnabled('tv',42),true);
  h.state.getUserPrefs().hideRatings = false;
  assert.equal(h.state.getUserPrefs().hideRatings,true);
  h.switchUser();
  assert.equal(h.state.hasAnyState(),false);
  assert.equal(h.state.isLoaded(),false);
  assert.deepEqual(Object.keys(h.state.getUserPrefs()),[]);
  await h.state.whenLoaded();
  assert.equal(h.calls.length,2);
});
test('spoiler load failure settles fail-closed and disabled feature makes no request', async t => {
  const h = setup(t, async () => {throw new Error('offline');});
  h.expectConsoleError(/state load failed/);
  await h.state.whenLoaded();
  assert.equal(h.state.isLoaded(),true);
  assert.equal(h.state.isLoadOk(),false);
  h.switchUser(); h.JE.pluginConfig.SpoilerBlurEnabled=false;
  await h.state.whenLoaded();
  assert.equal(h.calls.length,1);
});
test('a failed spoiler state load stays fail-closed and is retried later, with a growing delay, until it loads', async t => {
  let fail = true;
  const h = setup(t, async () => { if (fail) throw new Error('offline'); return stateFixture({Series:{'AA-BB':{}}}); });
  const timers = [];
  h.window.setTimeout = (fn, ms) => { timers.push({fn, ms}); return timers.length; };
  h.expectConsoleError(/state load failed/);
  await h.state.whenLoaded();
  assert.equal(h.state.isLoadOk(), false);
  assert.equal(h.calls.length, 1);
  assert.equal(timers.length, 1, 'one retry is scheduled, not run at once');
  const first = timers.shift();
  assert.ok(first.ms >= 1000, `retry waits (${first.ms} ms)`);
  first.fn();
  await h.state.loadState();
  assert.equal(h.calls.length, 2);
  assert.equal(h.state.isLoadOk(), false, 'still unknown, still fail-closed');
  assert.equal(timers.length, 1);
  const second = timers.shift();
  assert.ok(second.ms > first.ms, `the delay grows (${first.ms} then ${second.ms} ms)`);
  fail = false;
  second.fn();
  await h.state.loadState();
  assert.equal(h.calls.length, 3);
  assert.equal(h.state.isLoadOk(), true);
  assert.equal(h.state.isEnabledFor('aabb'), true);
  assert.equal(timers.length, 0, 'no retry after a successful load');
});
test('old-user spoiler load cannot populate the new session', async t => {
  let resolve;
  const h = setup(t, () => new Promise(r => {resolve=r;}));
  const pending = h.state.loadState(); h.switchUser();
  resolve(stateFixture({Series:{secret:{}}})); await pending;
  assert.equal(h.state.hasAnyState(),false);
  assert.equal(h.state.isLoaded(),false);
});
for (const kind of ['Series','Movie','Collection']) {
  test(`spoiler ${kind} mutation updates after success and preserves state on rejection`, async t => {
    let fail=false;
    const h=setup(t,async()=>{if(fail)throw new Error('denied'); return {};});
    await h.state[`enableFor${kind}`]('AA-BB','Title');
    const check=kind==='Series'?'isEnabledFor':`is${kind}EnabledFor`;
    assert.equal(h.state[check]('aabb'),true);
    assert.equal(h.calls[0][1].skipRetry,true);
    fail=true; await assert.rejects(h.state[`disableFor${kind}`]('aabb'),/denied/);
    assert.equal(h.state[check]('aabb'),true);
    fail=false; await h.state[`disableFor${kind}`]('aabb');
    assert.equal(h.state[check]('aabb'),false);
  });
  test(`old-user ${kind} mutation cannot populate the new session`, async t => {
    let resolve;
    const h=setup(t,()=>new Promise(r=>{resolve=r;}));
    const pending=h.state[`enableFor${kind}`]('secret');
    h.switchUser(); resolve({}); await pending;
    assert.equal(h.state.hasAnyState(),false);
  });
}
test('TMDB pending promotion, lookup without Jellyfin ID and removal remain consistent',async t=>{
  let response={promoted:'pending'};
  const h=setup(t,async()=>response);
  await h.state.enableForTmdb('TV',42,'A & B');
  assert.match(h.calls[0][0],/displayName=A%20%26%20B/);
  assert.equal(h.state.isTmdbEnabled('tv',42),true);
  response={promoted:'series',jellyfinId:'AA-BB'};
  await h.state.enableForTmdb('tv',42);
  assert.equal(h.state.isTmdbEnabled('tv',42),true);
  response={removedFrom:'series',jellyfinId:'AA-BB'};
  await h.state.disableForTmdb('tv',42);
  assert.equal(h.state.isTmdbEnabled('tv',42),false);
  await assert.rejects(h.state.enableForTmdb('person',42),/invalid/);
  await assert.rejects(h.state.disableForTmdb('tv',''),/invalid/);
});
for (const operation of ['enableForTmdb','setUserPrefs']) {
  test(`old-user ${operation} response cannot populate the new session`,async t=>{
    let resolve;
    const h=setup(t,()=>new Promise(r=>{resolve=r;}));
    const pending=operation==='enableForTmdb'?h.state.enableForTmdb('movie',42):h.state.setUserPrefs({secret:true});
    h.switchUser(); resolve({promoted:'movie',jellyfinId:'secret'}); await pending;
    assert.equal(h.state.hasAnyState(),false);
    assert.equal(Object.keys(h.state.getUserPrefs()).length,0);
  });
}
test('spoiler identity cookie follows login, switch and logout',t=>{
  const h=setup(t);
  h.window.ApiClient={getCurrentUserId:()=> 'first'};
  h.load('enhanced/spoilerguard/identity.js');
  assert.match(h.window.document.cookie,/je-spoiler-uid=first/);
  h.switchUser('second'); assert.match(h.window.document.cookie,/je-spoiler-uid=second/);
  h.switchUser(null); assert.equal(h.window.document.cookie,'');
});
test('spoiler identity cookie the server signed for this user is kept, and one for another user is replaced',t=>{
  // The server answers an unsigned cookie with its signed value ("<id>.<signature>"); writing the bare id over it
  // again would leave the browser with a value the server no longer trusts.
  const h=setup(t);
  h.window.document.cookie='je-spoiler-uid=0123456789abcdef0123456789abcdef.signed; path=/';
  h.window.ApiClient={getCurrentUserId:()=> '01234567-89ab-cdef-0123-456789abcdef'};
  h.load('enhanced/spoilerguard/identity.js');
  assert.equal(h.window.document.cookie,'je-spoiler-uid=0123456789abcdef0123456789abcdef.signed');
  h.switchUser('fedcba9876543210fedcba9876543210'); assert.equal(h.window.document.cookie,'je-spoiler-uid=fedcba9876543210fedcba9876543210');
});
test('Spoiler Guard exposes policy inputs for UI but no independent browser cache stamp', async t => {
  const h = setup(t, async () => stateFixture({ Series: { aabb: {} }, Prefs: {} }));
  await h.state.whenLoaded();
  assert.equal(h.state.isEnabledFor('aabb'), true);
  assert.equal(h.state.tagStripRevision, undefined);
  await h.state.setUserPrefs({ HideTags: false });
  assert.equal(h.state.getUserPrefs().HideTags, false);
});
