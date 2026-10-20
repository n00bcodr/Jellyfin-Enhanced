// Phase 4c3b1: who owns list authoring work, at the surface boundary. Explicit, bounded cases (not a generated operation
// model): the r5 triggers (document pagehide / bfcache restore, away-and-back on the same title, a held collection read
// that must not open a form after its owner ended) and the r6 classes (a refresh reopen and an async fallback keep the
// owner captured before the close; the same surface's older read never wins), plus person/server/mount/flag changes,
// publication of non-DOM effects and an inert load. The writes and portals these surfaces will make need the shared
// transport binding and surface registry; those cases are the separate integration contract patch.
import test from 'node:test';
import { setupAuthoring, json, deferred, owner, LIST, COLL, view, AUTHORING_MODULES, BASE_MODULES, assert } from './fixtures/arr-list-authoring.mjs';
import { createHarness } from '../helpers/harness.mjs';
import { installDomWriteSpy } from '../helpers/dom-write-spy.mjs';

function origin(s, { op = owner(), live = () => true, mount = s.mount() } = {}) {
  const L = s.lp();
  return L.surface.origin({ owner: op, mount, live, policy: () => L.gate.policy(() => false, false) });
}

test('R5-1: pagehide ends the surface and its held paints; a bfcache restore does not revive it', async t => {
  const s = setupAuthoring(t);
  const L = s.lp();
  const policy = deferred();
  const o = L.surface.origin({ owner: owner(), mount: s.mount(), live: () => true, policy: () => policy.promise });
  const node = s.mount();
  L.gate.paint(o.ticket, () => { node.textContent = 'held'; }, 'k');
  let ended = 0;
  o.onEnd(() => { ended++; });
  s.window.dispatchEvent(new s.window.Event('pagehide'));
  assert.equal(o.current(), false);
  assert.equal(ended, 1);
  policy.resolve(L.gate.policy(() => false, false));
  await s.settle();
  assert.equal(node.textContent, '', 'the held paint never runs');
  const shown = new s.window.Event('pageshow');
  shown.persisted = true;
  s.window.dispatchEvent(shown);
  assert.equal(o.current(), false, 'restored from the back-forward cache: still ended');
  // Document freeze too.
  const o2 = origin(s);
  s.document.dispatchEvent(new s.window.Event('freeze'));
  assert.equal(o2.current(), false);
});

test('R5-2: away and back on the same title: B starts on its own and A\'s cleanup cannot remove B\'s work', t => {
  const s = setupAuthoring(t);
  const inflight = s.lp().surface.inflight;
  const key = 'add|movie:tmdb:5|' + LIST;
  const a = owner('A');
  const workA = inflight.claim(key, a);
  assert.ok(workA);
  assert.equal(inflight.claim(key, a), null, 'a second press of the same owner joins nothing new');
  a.end();
  const b = owner('B');
  const workB = inflight.claim(key, b);
  assert.ok(workB, 'B is not joined to A\'s old work');
  workA.release();
  assert.equal(inflight.active(key, b), true, 'A\'s late cleanup leaves B\'s entry');
  assert.equal(inflight.claim(key, b), null);
  workB.release();
  assert.equal(inflight.active(key, b), false);
  // An ended owner can't claim.
  assert.equal(inflight.claim(key, a), null);
  // Bounded: claims never grow without limit.
  for (let i = 0; i < 300; i++) inflight.claim('k' + i, owner());
  assert.ok(inflight.size() <= 256);
});

test('R5-4: a held collection read must not open its form or send after its owner ended', async t => {
  const gate = deferred();
  const s = setupAuthoring(t, { route: async (m, path) => (m === 'GET' && path === `/acquire/lists/${COLL}` ? gate.promise : null) });
  const L = s.lp();
  const op = owner();
  const o = origin(s, { op });
  const target = o.selectTarget(COLL, { listKind: 'collection' });
  const check = o.intent('details');
  const read = s.JE.arrLists.getList(COLL, { ticket: target.ticket });
  op.end();
  gate.resolve(json(view([], [], { listId: COLL, listKind: 'collection' })));
  await assert.rejects(read, e => e?.stale === true);
  const form = s.mount();
  assert.equal(o.paint(check, target.ticket, () => { form.textContent = 'form'; }), false);
  assert.equal(form.textContent, '');
  assert.equal(s.calls.filter(c => c.method !== 'GET').length, 0, 'nothing sent');
  // A fresh owner reads and opens normally.
  const s2 = setupAuthoring(t, { route: async (m, path) => (path === `/acquire/lists/${COLL}` ? json(view([], [], { listId: COLL, listKind: 'collection' })) : null) });
  const o2 = origin(s2);
  const t2 = o2.selectTarget(COLL, { listKind: 'collection' });
  const c2 = o2.intent('details');
  assert.equal((await s2.JE.arrLists.getList(COLL, { ticket: t2.ticket })).status, 200);
  const form2 = s2.mount();
  assert.equal(o2.paint(c2, t2.ticket, () => { form2.textContent = 'form'; }), true);
});

test('r6: a refresh reopen keeps the owner captured before the close; an ended owner reopens nothing', async t => {
  const s = setupAuthoring(t);
  const L = s.lp();
  const op = owner();
  const o = origin(s, { op });
  const handoff = o.handoff();
  o.end('replaced');
  await s.settle();
  const replacement = L.surface.origin(handoff);
  assert.equal(replacement.owner, op, 'the same owner, never NATIVE or none');
  assert.equal(replacement.current(), true);
  // The owner ends while the replacement is prepared: nothing reopens.
  const op2 = owner();
  const o2 = origin(s, { op: op2 });
  const h2 = o2.handoff();
  o2.end('replaced');
  op2.end();
  assert.equal(L.surface.origin(h2), null);
  // A handoff of an origin that already ended carries nothing to reopen.
  assert.equal(o2.handoff(), null);
});

test('r6: an async fallback after a rejection opens only for the owner captured before the await', async t => {
  const s = setupAuthoring(t);
  const L = s.lp();
  const run = async (op, endDuring) => {
    const o = origin(s, { op });
    const handoff = o.handoff();
    try {
      await Promise.reject(new Error('share failed'));
    } catch {
      if (endDuring) op.end();
      o.end('fallback');
      return L.surface.origin(handoff);
    }
    return null;
  };
  const live = await run(owner(), false);
  assert.equal(live.current(), true);
  assert.equal(await run(owner(), true), null);
});

test('r6: the same surface\'s older read never publishes over a newer one; channels are independent', async t => {
  const s = setupAuthoring(t);
  const o = origin(s);
  const older = o.intent('details');
  const newer = o.intent('details');
  const shown = [];
  assert.equal(o.publish(newer, () => shown.push('new')), true);
  assert.equal(o.publish(older, () => shown.push('old')), false);
  assert.deepEqual(shown, ['new']);
  // A reload intent does not cancel the query or season intents of the same surface.
  const query = o.intent('query');
  const season = o.intent('season');
  o.intent('reload');
  assert.equal(query(), true);
  assert.equal(season(), true);
  o.intent('query');
  assert.equal(query(), false, 'a newer query wins');
  assert.equal(season(), true);
  // Target-bound intents end when the target changes; others don't.
  o.selectTarget(LIST, { listKind: 'playlist' });
  const episodes = o.intent('episodes', { target: true });
  const lists = o.intent('lists');
  o.selectTarget(COLL, { listKind: 'collection' });
  assert.equal(episodes(), false);
  assert.equal(lists(), true);
});

test('non-DOM effects (cache, events, toast, navigation, remembered choice) publish only for the current owner and newest intent', t => {
  const s = setupAuthoring(t);
  const op = owner();
  const o = origin(s, { op });
  const effects = [];
  const check = o.intent('result');
  for (const name of ['cache', 'event', 'toast', 'navigation', 'choice']) o.publish(check, () => effects.push(name));
  assert.deepEqual(effects, ['cache', 'event', 'toast', 'navigation', 'choice']);
  op.end();
  for (const name of ['cache', 'event', 'toast', 'navigation', 'choice']) o.publish(check, () => effects.push('late-' + name));
  assert.equal(effects.length, 5, 'nothing after the owner ended');
  const o2 = origin(s);
  assert.equal(o2.publish(o2.intent('result'), () => effects.push('fresh')), true);
  assert.equal(o.publish(o.intent('result'), () => effects.push('again')), false, 'an ended surface makes no new intents');
});

test('a person switch, a server switch, an unmounted origin or a flag/access loss ends the surface for good', t => {
  const s = setupAuthoring(t);
  const o = origin(s);
  const target = o.selectTarget(LIST, { listKind: 'playlist' });
  s.signIn('user-b');
  assert.equal(o.current(), false);
  assert.equal(target.ticket.current(), false);
  s.signIn('user-a');
  assert.equal(o.current(), false, 'back to the first person: still ended');
  const o2 = origin(s);
  s.signIn('user-a', 'server-b');
  assert.equal(o2.current(), false);
  const mount = s.mount();
  const o3 = origin(s, { mount });
  mount.remove();
  assert.equal(o3.current(), false);
  s.document.body.appendChild(mount);
  assert.equal(o3.current(), false);
  let flag = true;
  const o4 = origin(s, { live: () => flag });
  flag = false;
  assert.equal(o4.current(), false);
  flag = true;
  assert.equal(o4.current(), false);
});

test('closing returns focus only to an opener that is still connected, and only for a live surface', t => {
  const s = setupAuthoring(t);
  const opener = s.document.createElement('button');
  s.document.body.appendChild(opener);
  const o = origin(s);
  o.close({ opener });
  assert.equal(s.document.activeElement, opener);
  assert.equal(o.current(), false);
  const other = s.document.createElement('button');
  s.document.body.appendChild(other);
  other.focus();
  const gone = s.document.createElement('button');
  const o2 = origin(s);
  o2.close({ opener: gone });
  assert.equal(s.document.activeElement, other, 'a detached opener gets nothing');
  const op = owner();
  const o3 = origin(s, { op });
  op.end();
  o3.close({ opener });
  assert.equal(s.document.activeElement, other, 'an ended surface restores nothing');
});

test('the listeners a surface adds are removed when it ends', t => {
  const s = setupAuthoring(t);
  const added = [];
  const removed = [];
  for (const target of [s.window, s.document]) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type, fn, o) => { added.push(type); return add(type, fn, o); };
    target.removeEventListener = (type, fn, o) => { removed.push(type); return remove(type, fn, o); };
  }
  const o = origin(s);
  assert.deepEqual(added.sort(), ['freeze', 'pagehide']);
  o.end();
  o.end();
  assert.deepEqual(removed.sort(), ['freeze', 'pagehide'], 'released once');
});

test('loading the authoring modules does nothing: no network, DOM, listeners, timers or registration', t => {
  const fetches = [];
  const h = createHarness({ JE: { pluginConfig: { ArrListsEnabled: true, ArrListAuthoringEnabled: true, ArrListAddToListEnabled: true }, t: k => k }, fetch: async url => { fetches.push(url); throw new Error('no'); } });
  t.after(() => h.close());
  for (const m of BASE_MODULES) h.load(m);
  const spy = installDomWriteSpy(h.window);
  const listeners = [];
  const timers = [];
  for (const target of [h.window, h.document]) {
    const add = target.addEventListener.bind(target);
    target.addEventListener = (type, fn, o) => { listeners.push(type); return add(type, fn, o); };
  }
  const setTimeout0 = h.window.setTimeout;
  h.window.setTimeout = (...args) => { timers.push(args[1]); return setTimeout0(...args); };
  const setInterval0 = h.window.setInterval;
  h.window.setInterval = (...args) => { timers.push(args[1]); return setInterval0(...args); };
  const before = Object.keys(h.JE).sort();
  const writes = spy.writes();
  for (const m of AUTHORING_MODULES) h.load(m);
  assert.deepEqual(fetches, []);
  assert.deepEqual(listeners, []);
  assert.deepEqual(timers, []);
  assert.equal(spy.writes(), writes, 'no DOM writes');
  assert.equal(h.document.head.querySelectorAll('style').length, 0, 'no styles injected');
  assert.deepEqual(Object.keys(h.JE).sort(), before, 'no public globals, no registration');
  const lp = h.JE.internals.arrListPages;
  for (const name of ['order', 'authoring', 'metadata', 'surface', 'actions', 'search', 'granularity', 'picker']) assert.ok(lp[name], name);
});
