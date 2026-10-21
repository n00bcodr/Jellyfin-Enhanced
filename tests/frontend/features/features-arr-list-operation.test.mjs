// Phase 4c3b1: who owns list authoring work, at the surface boundary. Explicit, bounded cases (not a generated operation
// model): the r5 triggers (document pagehide / bfcache restore, away-and-back on the same title, a held collection read
// that must not open a form after its owner ended) and the r6 classes (a refresh reopen and an async fallback keep the
// owner captured before the close; the same surface's older read never wins), plus person/server/mount/flag changes,
// publication of non-DOM effects and an inert load. The writes and portals these surfaces will make need the shared
// transport binding and surface registry; those cases are the separate integration contract patch.
import test from 'node:test';
import { setupAuthoring, json, deferred, owner, ph, P, LIST, COLL, view, AUTHORING_MODULES, BASE_MODULES, assert } from './fixtures/arr-list-authoring.mjs';
import { createHarness, jsRoot } from '../helpers/harness.mjs';
import { installDomWriteSpy } from '../helpers/dom-write-spy.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

test('surfaces share one document-lifecycle listener pair, added on first use; an ended surface leaves no subscription', t => {
  const s = setupAuthoring(t);
  const added = [];
  const removed = [];
  for (const target of [s.window, s.document]) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type, fn, o) => { added.push(type); return add(type, fn, o); };
    target.removeEventListener = (type, fn, o) => { removed.push(type); return remove(type, fn, o); };
  }
  const L = s.lp();
  const o = origin(s);
  assert.deepEqual(added.sort(), ['freeze', 'pagehide'], 'one pair, on first use (never on load)');
  const others = Array.from({ length: 20 }, () => origin(s));
  assert.equal(added.length, 2, 'no pair per surface');
  assert.equal(L.surface.subscribers(), 21);
  o.end();
  o.end();
  for (const other of others) other.end();
  assert.equal(L.surface.subscribers(), 0, 'every ended surface unsubscribed, once');
  assert.deepEqual(removed, [], 'the shared pair stays for the next surface');
  // A surface ended by pagehide unsubscribes too, and the next one still hears the next pagehide.
  const a = origin(s);
  s.window.dispatchEvent(new s.window.Event('pagehide'));
  assert.equal(a.current(), false);
  assert.equal(L.surface.subscribers(), 0);
  const b = origin(s);
  s.document.dispatchEvent(new s.window.Event('freeze'));
  assert.equal(b.current(), false);
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

// ------------------------------------------------------------------ review round 1: lifetimes carried, checked when run

test('4C3B1-R1-1: a handoff carries the session and document lifecycle it was taken in; it never opens under another', async t => {
  const s = setupAuthoring(t);
  const L = s.lp();
  const op = owner();
  const o = origin(s, { op });
  const handoff = o.handoff();
  o.end('replaced');
  s.signIn('user-b');
  assert.equal(L.surface.origin(handoff), null, 'taken as A, never opened as B');
  s.signIn('user-a');
  assert.equal(L.surface.origin(handoff), null, 'back to A is another session');
  // A pagehide between taking and using the handoff ends the lifecycle it carries.
  const o2 = origin(s, { op: owner() });
  const h2 = o2.handoff();
  o2.end('replaced');
  s.window.dispatchEvent(new s.window.Event('pagehide'));
  const shown = new s.window.Event('pageshow');
  shown.persisted = true;
  s.window.dispatchEvent(shown);
  assert.equal(L.surface.origin(h2), null, 'restored from the back-forward cache: the old lifecycle stays ended');
  // Positive control: same person, same document lifecycle → one replacement, current, with the same owner.
  const op3 = owner();
  const o3 = origin(s, { op: op3 });
  const h3 = o3.handoff();
  o3.end('replaced');
  const replacement = L.surface.origin(h3);
  assert.equal(replacement.current(), true);
  assert.equal(replacement.owner, op3);
  assert.equal(L.surface.origin(h3), null, 'a handoff opens one replacement');
  assert.equal(L.surface.origin({ ...h3 }), null, 'a copied handoff is not a handoff');
  // The replacement may have its own mount (a new root); everything else is carried.
  const m4 = s.mount();
  const o4 = origin(s, { op: owner(), mount: m4 });
  const h4 = o4.handoff();
  o4.end('replaced');
  m4.remove();
  assert.equal(L.surface.origin(h4), null, 'the old root is gone: the replacement needs its own');
  const h5 = (() => { const m5 = s.mount(); const o5 = origin(s, { op: owner(), mount: m5 }); const h = o5.handoff(); o5.end('replaced'); m5.remove(); return h; })();
  const fresh = s.mount();
  const moved = L.surface.origin(h5, { mount: fresh });
  assert.equal(moved.current(), true);
  fresh.remove();
  assert.equal(moved.current(), false, 'the replacement lives with its own mount');
});

test('4C3B1-R1-2: a paint held for the Spoiler policy runs only if its intent is still the newest when it runs', async t => {
  const s = setupAuthoring(t);
  const L = s.lp();
  const policy = deferred();
  const o = L.surface.origin({ owner: owner(), mount: s.mount(), live: () => true, policy: () => policy.promise });
  const node = s.mount();
  const older = o.intent('details');
  o.paint(older, o.ticket, () => { node.textContent = 'OLD DETAILS'; }, 'old');
  const newer = o.intent('details');
  o.paint(newer, o.ticket, () => { node.dataset.shown = 'new'; }, 'new');
  // A target-bound paint held on the target's ticket, then the target changes.
  const target = o.selectTarget(LIST, { listKind: 'playlist' });
  const bound = o.intent('details', { target: true });
  const other = s.mount();
  o.paint(bound, target.ticket, () => { other.textContent = 'OLD TARGET'; }, 'target');
  o.selectTarget(COLL, { listKind: 'collection' });
  policy.resolve(L.gate.policy(() => false, false));
  await s.settle();
  assert.equal(node.textContent, '', 'the superseded intent painted nothing when the policy resolved');
  assert.equal(node.dataset.shown, 'new', 'the newest intent painted');
  assert.equal(other.textContent, '', 'nothing for the old target');
});

/** The five ways a deferred effect's binding ends before it runs, and how each is made. */
const ENDINGS = {
  owner: ({ op }) => op.end(),
  session: ({ s }) => s.signIn('user-b'),
  lifecycle: ({ s }) => s.window.dispatchEvent(new s.window.Event('pagehide')),
  intent: ({ fx }) => fx.intent('query'),
  destroyed: ({ fx }) => fx.destroy()
};

test('check at execution: held paints, awaited continuations and listeners re-check owner, session, lifecycle, intent and destroyed state when they run', async t => {
  for (const [name, endIt] of Object.entries(ENDINGS)) {
    const s = setupAuthoring(t);
    const L = s.lp();
    const op = owner();
    const policy = deferred();
    const o = L.surface.origin({ owner: op, mount: s.mount(), live: () => true, policy: () => policy.promise });
    const fx = o.effects();
    const check = fx.intent('query');
    const node = s.mount();
    const read = deferred();
    const ran = [];
    fx.paint(check, () => { node.textContent = 'held'; }, 'k');
    const continued = fx.task(check, async step => { const r = await step(read.promise); ran.push('continued:' + r.value); return 'done'; });
    const button = s.document.createElement('button');
    s.document.body.appendChild(button);
    fx.on(button, 'click', () => ran.push('clicked'));
    endIt({ s, op, fx });
    policy.resolve(L.gate.policy(() => false, false));
    read.resolve('late');
    button.click();
    assert.equal(await continued, null, `${name}: the continuation stops`);
    await s.settle();
    // A listener is the person's own input (it makes the next intent): only a newer intent leaves it working.
    assert.deepEqual(ran, name === 'intent' ? ['clicked'] : [], `${name}: nothing ran that the ending forbids`);
    assert.equal(node.textContent, '', `${name}: the held paint wrote nothing`);
  }
  // Positive control: nothing ended, everything runs once.
  const s = setupAuthoring(t);
  const L = s.lp();
  const o = L.surface.origin({ owner: owner(), mount: s.mount(), live: () => true, policy: () => L.gate.policy(() => false, false) });
  const fx = o.effects();
  const check = fx.intent('query');
  const node = s.mount();
  const ran = [];
  assert.equal(fx.paint(check, () => { node.textContent = 'now'; }, 'k'), true);
  assert.equal(await fx.task(check, async step => { const r = await step(Promise.resolve(7)); ran.push(r.value); const e = await step(Promise.reject(new Error('x'))); ran.push(e.ok); return 'done'; }), 'done');
  const button = s.document.createElement('button');
  s.document.body.appendChild(button);
  fx.on(button, 'click', () => ran.push('clicked'));
  button.click();
  assert.deepEqual(ran, [7, false, 'clicked']);
  assert.equal(node.textContent, 'now');
  // A presenter's destroyed state is its own: the shared ticket stays current for others.
  fx.destroy();
  assert.equal(o.ticket.current(), true, 'destroying a presenter revokes no shared ticket');
  const other = o.effects();
  assert.equal(other.paint(null, () => { node.dataset.other = '1'; }, 'k'), true);
});

// ------------------------------------------------------------------ review round 1: dependencies invalidate

/** Every declared edge of the origin's dependency table and the test that covers it. */
const ORIGIN_EDGE_TESTS = { 'target -> target:*': 'origin edge: a target change ends target-bound intents, the old target\'s reads and its results' };

test('origin edge: a target change ends target-bound intents, the old target\'s reads and its results', async t => {
  const gate = deferred();
  const s = setupAuthoring(t, { route: async (m, path) => (path === `/acquire/lists/${LIST}` ? gate.promise : null) });
  const L = s.lp();
  const o = origin(s);
  const a = o.selectTarget(LIST, { listKind: 'playlist' });
  const intent = o.intent('details', { target: true });
  const read = s.JE.arrLists.getList(LIST, { ticket: a.ticket });
  const free = o.intent('lists');
  let closed = 0;
  a.ticket.onRevoke(() => { closed++; });
  o.clearTarget();
  assert.equal(closed, 1, 'the old target\'s ticket is revoked: what it opened (a sheet, a form) closes');
  assert.equal(o.target(), null);
  assert.equal(intent(), false, 'target-bound intent ended');
  assert.equal(a.current(), false, 'the old target ended (results check it)');
  assert.equal(free(), true, 'an intent not bound to the target lives on');
  gate.resolve(json(view([], [])));
  await assert.rejects(read, e => e?.stale === true, 'the old target\'s read is dropped');
  assert.equal(o.current(), true, 'the origin lives on');
});

test('the origin\'s dependency table is declared and every edge has its test', t => {
  const s = setupAuthoring(t);
  const edges = Object.entries(s.lp().surface.ORIGIN_DEPENDS).flatMap(([up, downs]) => downs.map(d => `${up} -> ${d}`));
  assert.deepEqual(edges.sort(), Object.keys(ORIGIN_EDGE_TESTS).sort());
});

// ------------------------------------------------------------------ review round 1: scans (check at execution, guarded text)

/**
 * A module's code without comments, with regex literals emptied (string and template text kept, so literal arguments
 * stay visible). Not a parser: the eight modules are plain ES2020; a construct it can't follow fails the scan's
 * positive controls.
 * @param {string} src Source.
 * @returns {string} Code.
 */
function codeOf(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; out += ' '; continue; }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (depth === 0 && src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (depth > 0 && src[j] === '{') depth++;
        if (depth > 0 && src[j] === '}') depth--;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/') {
      const before = out.replace(/\s+$/, '');
      if (!before || /[(,=:[!&|?{};+\-*%<>~^]$/.test(before) || /\b(return|typeof|case|in|of|void|delete|instanceof|new)$/.test(before)) {
        let j = i + 1;
        let cls = false;
        while (j < n) {
          const ch = src[j];
          if (ch === '\\') { j += 2; continue; }
          if (ch === '[') cls = true;
          else if (ch === ']') cls = false;
          else if ((ch === '/' && !cls) || ch === '\n') break;
          j++;
        }
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        out += '/R/';
        i = j;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const GUARD_BEGIN = '// @je-guard-begin';
const GUARD_END = '// @je-guard-end';
/** Deferred APIs: a callback handed to any of them runs later, so it must be made by the one wrapper (lp.surface). */
const DEFERRED_SINKS = [
  ['await outside a checked step', /\bawait\s+(?!step\()/g],
  ['promise callback', /\.(then|catch|finally)\s*\(/g],
  ['promise executor', /\bnew\s+Promise\s*\(/g],
  ['timer', /\b(setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|queueMicrotask)\s*\(/g],
  ['listener', /\.(addEventListener|onRevoke)\s*\(/g],
  ['observer', /\bnew\s+(MutationObserver|ResizeObserver|IntersectionObserver|PerformanceObserver)\b/g],
  ['paint gate', /\bgate\.paint\s*\(|\.hold\s*\(/g],
  ['surface registry', /openSurface\s*\)?\s*\(/g]
];
/** Non-text attributes a module may set directly; every other attribute (or a computed name) is a text sink. */
const PLAIN_ATTRIBUTES = 'role|maxlength|inputmode|href|aria-invalid|aria-live|aria-hidden|aria-checked|aria-selected|aria-expanded|aria-disabled|aria-busy|tabindex|type|name|for';
/** Text sinks: anything a person reads (text, labels, tooltips, field values) must come from the guarded words. */
const TEXT_SINKS = [
  ['text property', /\.(textContent|innerText|innerHTML|outerHTML|nodeValue)\s*\+?=(?!=)/g],
  ['text-bearing property', /\.(title|placeholder|label|alt|ariaLabel|ariaDescription|value)\s*\+?=(?!=)/g],
  ['text method', /\b(insertAdjacentHTML|insertAdjacentText|createTextNode)\s*\(|\bdocument\.write(ln)?\s*\(|\bnew\s+Option\s*\(/g],
  ['text attribute', new RegExp(`\\.setAttribute\\s*\\(\\s*(?!'(?:${PLAIN_ATTRIBUTES})'\\s*,)`, 'g')],
  ['unguarded words helper', /\blp\.render\b|\bJE\.t\s*\(|\bJE\.arrStatus\b/g]
];
const INSERT_CALL = /\.(append|prepend|replaceChildren|before|after|replaceWith|appendChild|insertBefore)\s*\(/g;

/**
 * The top-level arguments of the call whose '(' is at index `open`, each with its nested (...), [...] and {...}
 * contents left out (so a literal inside a nested call, such as a tag name, is not the inserted text itself).
 * @returns {string[]} Arguments.
 */
function argsAt(code, open) {
  const args = [];
  let depth = 0;
  let current = '';
  for (let j = open; j < code.length; j++) {
    const ch = code[j];
    if (ch === '(' || ch === '[' || ch === '{') { depth++; if (depth === 1) continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; if (depth === 0) { args.push(current); return args; } }
    if (depth === 1 && ch === ',') { args.push(current); current = ''; continue; }
    if (depth === 1) current += ch;
  }
  args.push(current);
  return args;
}

/**
 * Scans one module: violations of the deferred and text rules outside the one helper region (list-surface.js only).
 * @param {string} file Module path.
 * @param {string} src Source.
 * @param {{unrestricted?: boolean}} [opts] Scan the helper region too (positive control).
 * @returns {Array<{file: string, rule: string, kind: string, at: string}>} Violations.
 */
function scan(file, src, opts = {}) {
  const lines = src.split('\n');
  const begins = lines.filter(l => l.trim() === GUARD_BEGIN).length;
  const ends = lines.filter(l => l.trim() === GUARD_END).length;
  const out = [];
  const owner = file.endsWith('list-surface.js');
  if ((begins || ends) && (!owner || begins !== 1 || ends !== 1)) out.push({ file, rule: 'helper region', kind: 'region', at: 'marker' });
  let inside = false;
  const kept = [];
  for (const line of lines) {
    if (line.trim() === GUARD_BEGIN) { inside = true; continue; }
    if (line.trim() === GUARD_END) { inside = false; continue; }
    kept.push(inside && owner && !opts.unrestricted ? '' : line);
  }
  const code = codeOf(kept.join('\n'));
  const find = (rules, kind) => {
    for (const [rule, re] of rules) for (const m of code.matchAll(re)) out.push({ file, rule, kind, at: code.slice(m.index, m.index + 60) });
  };
  find(DEFERRED_SINKS, 'deferred');
  find(TEXT_SINKS, 'text');
  for (const m of code.matchAll(INSERT_CALL)) {
    const args = argsAt(code, m.index + m[0].length - 1);
    // Inserted text: a literal, a concatenation or a conversion to text at the top level of an argument.
    if (args.some(a => /['"`+]|^\s*(\.\.\.)?\s*String\b|\.(join|toString)\s*$/.test(a))) out.push({ file, rule: 'text inserted', kind: 'text', at: code.slice(m.index, m.index + 60) });
  }
  return out;
}

const sourceOf = m => readFileSync(resolve(jsRoot, m), 'utf8');
const PLANT_AT = '})(window.JellyfinEnhanced);';
const plant = (src, line) => src.replace(PLANT_AT, `    ${line}\n${PLANT_AT}`);

const DEFERRED_PLANTS = [
  'lp.gate.paint(ticket, () => { root.appendChild(node); }, \'planted\');',
  'setTimeout(() => draw(), 0);',
  'Promise.resolve(read()).then(answer => draw(answer));',
  'async function planted(read) { const answer = await read(); draw(answer); }',
  'root.addEventListener(\'click\', () => draw());',
  'queueMicrotask(() => draw());',
  '(options.openSurface || JE.openSurface)(root, close, owner);'
];
const TEXT_PLANTS = [
  'row.textContent = c.title;',
  'node.setAttribute(\'aria-label\', ph.title);',
  'node.setAttribute(name, value);',
  'const span = lp.render.el(\'span\', \'x\', String(c.year));',
  'const when = lp.render.formatDate(ep.airDate);',
  'box.append(\' \' + c.year);',
  'option.value = item.name;',
  'group.label = item.ownerName;'
];

test('scan: no deferred effect in the eight modules bypasses the one checked wrapper (planted bypasses are caught)', t => {
  const found = AUTHORING_MODULES.flatMap(m => scan(m, sourceOf(m)).filter(v => v.kind !== 'text'));
  assert.deepEqual(found, [], 'deferred effects outside lp.surface\'s checked wrapper');
  // Positive control: the wrapper itself is seen making each kind of deferred call the rules name.
  const region = scan('arr/lists/list-surface.js', sourceOf('arr/lists/list-surface.js'), { unrestricted: true }).filter(v => v.kind === 'deferred').map(v => v.rule);
  for (const rule of ['promise callback', 'listener', 'paint gate', 'surface registry']) assert.ok(region.includes(rule), `the scan sees the wrapper's ${rule}`);
  for (const m of AUTHORING_MODULES) {
    for (const line of DEFERRED_PLANTS) {
      const caught = scan(m, plant(sourceOf(m), line)).filter(v => v.kind === 'deferred');
      assert.ok(caught.length >= 1, `planted in ${m}: ${line}`);
    }
  }
});

test('scan: every text sink in the eight modules goes through the guarded words (planted bypasses are caught)', t => {
  const found = AUTHORING_MODULES.flatMap(m => scan(m, sourceOf(m)).filter(v => v.kind !== 'deferred'));
  assert.deepEqual(found, [], 'text sinks outside lp.surface\'s guarded words');
  const region = scan('arr/lists/list-surface.js', sourceOf('arr/lists/list-surface.js'), { unrestricted: true }).filter(v => v.kind === 'text').map(v => v.rule);
  for (const rule of ['text property', 'text attribute', 'text-bearing property', 'unguarded words helper']) assert.ok(region.includes(rule), `the scan sees the words' ${rule}`);
  for (const m of AUTHORING_MODULES) {
    for (const line of TEXT_PLANTS) {
      const caught = scan(m, plant(sourceOf(m), line)).filter(v => v.kind === 'text');
      assert.ok(caught.length >= 1, `planted in ${m}: ${line}`);
    }
  }
  // A marker anywhere but list-surface.js is itself a violation (no second helper region).
  assert.ok(scan('arr/lists/list-search.js', `${GUARD_BEGIN}\nrow.textContent = c.title;\n${GUARD_END}\n`).some(v => v.rule === 'helper region'));
});

test('the guarded words refuse raw text at run time: a text sink or a word parameter given a plain string', t => {
  const s = setupAuthoring(t);
  const L = s.lp();
  const ticket = L.gate.issue(null, () => true, L.gate.policy(() => false, false));
  const w = L.surface.words(ticket);
  const node = s.mount();
  assert.throws(() => L.gate.paint(ticket, () => L.surface.put.text(node, 'raw')), /unguarded/);
  assert.throws(() => w.key('arr_lists_picker_added', { list: 'raw name' }), /unguarded/);
  assert.throws(() => L.gate.paint(ticket, () => L.surface.put.attr(node, 'aria-label', 'raw')), /unguarded/);
  assert.throws(() => L.gate.paint(ticket, () => L.surface.put.data(node, 'two words')), /not an identity value/);
  L.gate.paint(ticket, () => L.surface.put.text(node, w.key('arr_lists_picker_added', { list: w.name('Mine') })));
  assert.equal(node.textContent, 'Added to Mine.');
  // Production: logged, and nothing raw is written.
  const p = setupAuthoring(t, { strict: false });
  p.h.expectConsoleError(/unguarded/);
  const P2 = p.lp();
  const t2 = P2.gate.issue(null, () => true, P2.gate.policy(() => false, false));
  const n2 = p.mount();
  P2.gate.paint(t2, () => P2.surface.put.text(n2, 'raw'));
  assert.equal(n2.textContent, '');
});

test('4C3B1-R1-5: a destroyed presenter stays destroyed: a paint held for the policy never re-creates it; the shared ticket lives on', async t => {
  const makers = {
    noteEditor: (L, ticket, root) => L.actions.noteEditor({ ticket, root, ph: ph(P(1), { note: 'old note', title: 'Old Title' }) }),
    customForm: (L, ticket, root) => L.actions.customForm({ ticket, root }),
    search: (L, ticket, root) => L.search.create({ ticket, root, source: 'je', read: async () => ({ status: 200, body: { answer: { results: [] } } }), lang: 'en' }),
    granularity: (L, ticket, root) => L.granularity.create({ ticket, root, media: { mediaType: 'tv', tmdbId: 1, title: 'A Show' } })
  };
  for (const [name, make] of Object.entries(makers)) {
    const s = setupAuthoring(t);
    const L = s.lp();
    const policy = deferred();
    const ticket = L.gate.issue(null, () => true, () => policy.promise);
    const root = s.mount();
    make(L, ticket, root).destroy();
    policy.resolve(L.gate.policy(() => false, false));
    await s.settle();
    assert.equal(root.childNodes.length, 0, `${name}: nothing drawn into the root after destroy`);
    assert.equal(ticket.current(), true, `${name}: the shared ticket is not revoked`);
    const again = s.mount();
    make(L, ticket, again);
    assert.ok(again.childNodes.length > 0, `${name}: another presenter on the same ticket still draws`);
  }
});
