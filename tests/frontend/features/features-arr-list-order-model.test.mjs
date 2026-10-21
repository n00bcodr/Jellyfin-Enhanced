// Phase 4c3b1: the playlist order model of list authoring. One person's move is ONE logical reorder of the caller's
// projected order (`e:<item>:<k>` copies of library items, `p:<entry>` JE entries); the server keeps the slots the caller
// can't see and alone moves Jellyfin's rows (none for an entry, one or two for a library row). Named cases first, then a
// bounded seeded generator against a small independent occurrence-list oracle (never the production planner or the
// server's move search): four seeds, at most 500 cases each, at most 8 tokens and 12 commands per trace, at most 200
// recent effect records per case.
import test from 'node:test';
import { setupAuthoring, owner, ITEM, P, LIST, effectLog, assert } from './fixtures/arr-list-authoring.mjs';

const A = ITEM(0xa1), B = ITEM(0xb2), C = ITEM(0xc3), D = ITEM(0xd4);
const e = (id, k = 0) => `e:${id}:${k}`;
const p = id => `p:${id}`;
const EDIT = { canEdit: true, actions: ['edit', 'reorder'] };
const viewOf = (order, extra = {}) => ({ listId: LIST, listKind: 'playlist', rev: 3, placeholders: [], order, ...EDIT, ...extra });

function model(t) {
  const s = setupAuthoring(t);
  return { ...s, order: s.lp().order };
}

test('an entry moves among library rows as one reorder with no native move', t => {
  const { order } = model(t);
  const v = viewOf([e(A), p(P(1)), e(B), p(P(2))]);
  const plan = order.plan(v, { token: p(P(2)), to: 0 });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.body, { rev: 3, order: [p(P(2)), e(A), p(P(1)), e(B)], moved: null });
  assert.equal(plan.native, 'none', 'an entry-only move never moves a Jellyfin row');
  // Move up / Move down are the same reorder, one slot.
  const down = order.plan(v, { token: p(P(1)), delta: 1 });
  assert.deepEqual(down.body.order, [e(A), e(B), p(P(1)), p(P(2))]);
  assert.equal(down.native, 'none');
});

test('a library row moves as one reorder naming it; the server does the native move(s)', t => {
  const { order } = model(t);
  const v = viewOf([e(A), p(P(1)), e(B), e(C)]);
  const plan = order.plan(v, { token: e(C), to: 0 });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.body, { rev: 3, order: [e(C), e(A), p(P(1)), e(B)], moved: e(C) });
  assert.equal(plan.native, 'server');
  // A library row moved across entries only keeps Jellyfin's order: nothing native to do, no row named.
  const across = order.plan(v, { token: e(A), to: 1 });
  assert.deepEqual(across.body, { rev: 3, order: [p(P(1)), e(A), e(B), e(C)], moved: null });
  assert.equal(across.native, 'none');
});

test('only a later copy of a duplicated item is refused; the first copy and every other row still move', t => {
  const { order } = model(t);
  const v = viewOf([e(A), e(B), e(A, 1), p(P(1))]);
  assert.deepEqual(order.plan(v, { token: e(A, 1), to: 0 }), { ok: false, reason: 'duplicate_copy' });
  // Positive controls: the first copy of the duplicated item, another real row and an entry.
  assert.equal(order.plan(v, { token: e(A), to: 3 }).ok, true);
  assert.equal(order.plan(v, { token: e(B), to: 0 }).ok, true);
  assert.equal(order.plan(v, { token: p(P(1)), to: 1 }).ok, true);
  // An entry moved next to the later copy is fine too (no blanket refusal around duplicates).
  assert.deepEqual(order.plan(v, { token: p(P(1)), to: 2 }).body.order, [e(A), e(B), p(P(1)), e(A, 1)]);
});

test('no-op, out of range, unknown, malformed and empty orders are refused without a body', t => {
  const { order } = model(t);
  const v = viewOf([e(A), p(P(1))]);
  assert.deepEqual(order.plan(v, { token: p(P(1)), to: 1 }), { ok: false, reason: 'noop' });
  assert.deepEqual(order.plan(v, { token: p(P(1)), delta: 1 }), { ok: false, reason: 'out_of_range' });
  assert.deepEqual(order.plan(v, { token: p(P(9)), to: 0 }), { ok: false, reason: 'unknown_token' });
  assert.deepEqual(order.plan(viewOf([]), { token: p(P(1)), to: 0 }), { ok: false, reason: 'unknown_token' });
  assert.deepEqual(order.plan(viewOf([e(A), e(A)]), { token: e(A), to: 1 }), { ok: false, reason: 'invalid' });
  assert.deepEqual(order.plan(viewOf(null), { token: e(A), to: 0 }), { ok: false, reason: 'invalid' });
  assert.deepEqual(order.plan({ ...viewOf([e(A), p(P(1))]), rev: undefined }, { token: e(A), to: 1 }), { ok: false, reason: 'invalid' });
  // Parsing: real copies and entries; anything else is not a token.
  assert.deepEqual(order.parse(e(A, 2)), { kind: 'real', id: A, k: 2 });
  assert.deepEqual(order.parse(p(P(4))), { kind: 'entry', id: P(4) });
  for (const bad of ['e:xyz:0', `e:${A}`, `e:${A}:-1`, 'p:', 'x', null, 7]) assert.equal(order.parse(bad), null, String(bad));
});

test('who may reorder: the list action decides (read-only share, requester, collection order) ', t => {
  const { order } = model(t);
  const cmd = { token: p(P(1)), to: 0 };
  assert.deepEqual(order.plan(viewOf([e(A), p(P(1))], { canEdit: false, actions: [] }), cmd), { ok: false, reason: 'not_editable' });
  assert.deepEqual(order.plan(viewOf([e(A), p(P(1))], { canEdit: true, actions: ['edit', 'request'] }), cmd), { ok: false, reason: 'not_editable' });
  // A saved canEdit alone is not the action: the view's actions are.
  assert.deepEqual(order.plan(viewOf([e(A), p(P(1))], { canEdit: true, actions: [] }), cmd), { ok: false, reason: 'not_editable' });
  // Collections keep the server's release order.
  assert.deepEqual(order.plan(viewOf([p(P(2)), p(P(1))], { listKind: 'collection', actions: ['edit', 'reorder'] }), cmd), { ok: false, reason: 'not_editable' });
});

test('a same-revision membership refresh: the rows shown no longer match the view, so nothing is sent', t => {
  const { order } = model(t);
  const v = viewOf([e(A), p(P(1)), e(B)]);
  // Jellyfin refreshed its rows (another app added C) without a list revision: the projection shown is stale.
  const shown = [e(A), p(P(1)), e(B), e(C)];
  assert.equal(order.sameProjection(v, shown), false);
  assert.deepEqual(order.plan(v, { token: p(P(1)), to: 0, shown }), { ok: false, reason: 'stale_view' });
  assert.equal(order.sameProjection(v, [e(A), p(P(1)), e(B)]), true);
  assert.equal(order.plan(v, { token: p(P(1)), to: 0, shown: [e(A), p(P(1)), e(B)] }).ok, true);
});

test('settling the answer: applied, canonical restoration, typed conflicts with zero resubmits, denial and uncertainty', t => {
  const { order } = model(t);
  const v = viewOf([e(A), p(P(1)), e(B), e(A, 1)]);
  const entry = order.plan(v, { token: p(P(1)), to: 0 });
  const real = order.plan(v, { token: e(B), to: 0 });
  // Applied: the server's view shows the requested placement (real copies relabelled by the server).
  const applied = order.settle(real, { status: 200, body: { ...v, rev: 4, order: [e(B), e(A), p(P(1)), e(A, 1)] } });
  assert.equal(applied.outcome, 'applied');
  assert.equal(applied.resubmits, 0);
  // The first copy of A moved: the server relabels the copies; still the requested placement.
  const dup = order.plan(v, { token: e(A), to: 3 });
  assert.equal(order.settle(dup, { status: 200, body: { ...v, rev: 4, order: [p(P(1)), e(B), e(A), e(A, 1)] } }).outcome, 'applied');
  // Placeholder-only answered with Jellyfin rows in another order: shown as the server has it, not as "moved".
  const moved = order.settle(entry, { status: 200, body: { ...v, rev: 4, order: [p(P(1)), e(B), e(A), e(A, 1)] } });
  assert.deepEqual([moved.outcome, moved.reason], ['canonical', 'native_moved']);
  assert.deepEqual(moved.view.order, [p(P(1)), e(B), e(A), e(A, 1)]);
  // Another placement than asked: canonical restoration from the answer.
  const other = order.settle(entry, { status: 200, body: { ...v, rev: 4, order: [e(A), e(B), p(P(1)), e(A, 1)] } });
  assert.equal(other.outcome, 'canonical');
  // A definite conflict carries the fresh view; nothing is resubmitted automatically.
  for (const code of ['rev_conflict', 'not_permutation', 'real_order_changed', 'duplicate_copy', 'move_unsupported', 'move_failed', 'owner_missing']) {
    const fresh = { ...v, rev: 9 };
    const out = order.settle(real, { status: 409, body: { error: true, code, view: fresh } });
    assert.deepEqual([out.outcome, out.reason, out.view?.rev, out.resubmits], ['conflict', code, 9, 0], code);
  }
  assert.deepEqual(order.settle(real, { status: 409, body: { code: 'rev_conflict' } }).reload, true, 'no view: read it again');
  assert.equal(order.settle(real, { status: 404, body: null }).outcome, 'denied');
  assert.equal(order.settle(real, { status: 403, body: null }).outcome, 'denied');
  assert.equal(order.settle(real, { status: 400, body: { code: 'invalid' } }).outcome, 'refused');
  for (const lost of [null, { status: 0 }, { status: 502 }, { status: 503 }]) {
    const out = order.settle(real, lost);
    assert.deepEqual([out.outcome, out.resubmits, out.reload], ['uncertain', 0, true]);
  }
});

test('a drag is captured at gesture start and an ended drag writes nothing', t => {
  const { order, JE } = model(t);
  const v = viewOf([e(A), p(P(1)), e(B)]);
  let live = true;
  const op = owner();
  const drag = order.capture({ owner: op, view: v, token: p(P(1)), live: () => live });
  const plan = order.drop(drag, { to: 0, view: v });
  assert.equal(plan.ok, true);
  assert.deepEqual(order.drop(drag, { to: 2, view: v }), { ok: false, reason: 'ended' }, 'a drop is used once');
  // Owner ended between start and drop.
  const op2 = owner();
  const drag2 = order.capture({ owner: op2, view: v, token: p(P(1)), live: () => live });
  op2.end();
  assert.deepEqual(order.drop(drag2, { to: 0, view: v }), { ok: false, reason: 'ended' });
  op2.current = () => true; // a revived predicate cannot revive the drag
  assert.deepEqual(order.drop(drag2, { to: 0, view: v }), { ok: false, reason: 'ended' });
  // Live flags/access/mount at drop.
  const drag3 = order.capture({ owner: owner(), view: v, token: p(P(1)), live: () => live });
  live = false;
  assert.deepEqual(order.drop(drag3, { to: 0, view: v }), { ok: false, reason: 'ended' });
  live = true;
  // A newer view (another revision) than the one dragged on.
  const drag4 = order.capture({ owner: owner(), view: v, token: p(P(1)), live: () => live });
  assert.deepEqual(order.drop(drag4, { to: 0, view: { ...v, rev: 4 } }), { ok: false, reason: 'stale_view' });
  // Cancel.
  const drag5 = order.capture({ owner: owner(), view: v, token: p(P(1)), live: () => live });
  order.cancel(drag5);
  assert.deepEqual(order.drop(drag5, { to: 0, view: v }), { ok: false, reason: 'ended' });
  // No owner: a programming error (throws in tests; production opens nothing).
  assert.throws(() => order.capture({ view: v, token: p(P(1)), live: () => true }), /without an owner/);
  assert.throws(() => order.capture({ owner: {}, view: v, token: p(P(1)), live: () => true }), /without an owner/);
  assert.equal(JE.strictOwners, true);
});

test('a drop JE owns suppresses the host Move; a drop among Jellyfin rows only stays the host\'s', t => {
  const { order } = model(t);
  assert.deepEqual(order.dropOwner({ entriesShown: true, draggedEntry: false }), { owner: 'je', suppressHost: true });
  assert.deepEqual(order.dropOwner({ entriesShown: true, draggedEntry: true }), { owner: 'je', suppressHost: true });
  assert.deepEqual(order.dropOwner({ entriesShown: false, draggedEntry: false }), { owner: 'host', suppressHost: false });
});

test('without an owner in production a drag is not captured and logs once', t => {
  const s = setupAuthoring(t, { strict: false });
  s.h.expectConsoleError(/without an owner/);
  assert.equal(s.lp().order.capture({ view: viewOf([e(A), p(P(1))]), token: p(P(1)), live: () => true }), null);
});

// ------------------------------------------------------------------ named two-step core examples
// The server's move search (core tests) reaches some placements only with two Jellyfin moves, so hidden rows keep their
// slots. The client plans the same ONE reorder either way and accepts the server's view.
test('named core examples: zero, one and two native moves are all one accepted reorder', t => {
  const { order } = model(t);
  // Raw A H B (H hidden from the caller); the caller sees A B and moves B first.
  const v = viewOf([e(A), p(P(1)), e(B)]);
  const plan = order.plan(v, { token: e(B), to: 0 });
  assert.deepEqual(plan.body, { rev: 3, order: [e(B), e(A), p(P(1))], moved: e(B) });
  for (const receipt of [{ moves: 1 }, { moves: 2 }]) {
    // The view never shows H; both answers carry the same projection.
    const out = order.settle(plan, { status: 200, body: { ...v, rev: 4, order: [e(B), e(A), p(P(1))], receipt } });
    assert.equal(out.outcome, 'applied', JSON.stringify(receipt));
  }
  // The move the server can't do without moving hidden rows: a typed refusal with the canonical view.
  const out = order.settle(plan, { status: 409, body: { code: 'move_unsupported', view: v } });
  assert.deepEqual([out.outcome, out.reason, out.view.order], ['conflict', 'move_unsupported', v.order]);
});

// ------------------------------------------------------------------ the bounded generator

const SEEDS = [0x4c3b1, 0x9e3779b9, 0x1234567, 0xdeadbeef];
const CASES = 500;
const MAX_TOKENS = 8;
const MAX_COMMANDS = 12;

/** mulberry32. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The oracle's list: occurrences {id, entry, hidden}; tokens are derived by order of appearance (as the server relabels
 * real copies). Independent of the production planner and of the server's splice/move search.
 */
function tokensOf(slots) {
  const seen = new Map();
  return slots.map(s => {
    if (s.entry) return p(s.id);
    const k = seen.get(s.id) || 0;
    seen.set(s.id, k + 1);
    return e(s.id, k);
  });
}

/** A random raw list: library ids with duplicates, entries, some slots hidden from the caller. */
function randomSlots(next) {
  const n = 1 + Math.floor(next() * MAX_TOKENS);
  const ids = [A, B, C, D];
  const slots = [];
  let entries = 0;
  for (let i = 0; i < n; i++) {
    if (next() < 0.4) slots.push({ id: P(++entries), entry: true, hidden: next() < 0.15 });
    else slots.push({ id: ids[Math.floor(next() * ids.length)], entry: false, hidden: next() < 0.2 });
  }
  return slots;
}

/**
 * The oracle server: validates a requested projection, keeps hidden slots after their anchor (entries: the nearest
 * visible slot before them; library rows: the nearest visible library row; never the moved row), and reports how many native moves it made: 0 when the real rows keep their
 * order, 2 when the moved row lands right after one hidden library row (a detour), 1 otherwise; landing after two or
 * more hidden library rows in a row is unsupported.
 */
function oracleApply(state, body) {
  const tokens = tokensOf(state.slots);
  const visible = tokens.filter((_, i) => !state.slots[i].hidden);
  if (body.rev !== state.rev) return { status: 409, code: 'rev_conflict' };
  const set = new Set(body.order);
  if (set.size !== body.order.length || body.order.length !== visible.length || !visible.every(t => set.has(t))) return { status: 409, code: 'not_permutation' };
  const real = list => list.filter(t => t.startsWith('e:'));
  const without = (list, x) => list.filter(t => t !== x);
  if (body.moved == null) {
    if (real(visible).join() !== real(body.order).join()) return { status: 409, code: 'real_order_changed' };
  } else {
    if (without(real(visible), body.moved).join() !== without(real(body.order), body.moved).join()) return { status: 409, code: 'real_order_changed' };
    if (!body.moved.endsWith(':0')) return { status: 409, code: 'duplicate_copy' };
  }
  // Anchors of hidden slots: a hidden entry follows the nearest visible slot before it; a hidden library row follows
  // the nearest visible library row before it (it never travels with a moved entry), never the moved row.
  const anchorOf = new Map();
  let anchor = null;
  let realAnchor = null;
  tokens.forEach((t, i) => {
    if (!state.slots[i].hidden) {
      if (t !== body.moved) { anchor = t; if (t.startsWith('e:')) realAnchor = t; }
      return;
    }
    anchorOf.set(i, state.slots[i].entry ? anchor : realAnchor);
  });
  const slotOf = new Map(tokens.map((t, i) => [t, i]));
  const next = [];
  const emitHidden = a => anchorOf.forEach((value, i) => { if (value === a) next.push(state.slots[i]); });
  emitHidden(null);
  for (const t of body.order) { next.push(state.slots[slotOf.get(t)]); emitHidden(t); }
  const before = state.slots.filter(s => !s.entry).map(s => s.id).join();
  const after = next.filter(s => !s.entry).map(s => s.id).join();
  let moves = 0;
  if (before !== after) {
    // Hidden library rows right before the moved row's new place (entries between them don't count).
    const at = next.indexOf(state.slots[slotOf.get(body.moved)]);
    let hiddenRun = 0;
    for (const slot of next.slice(0, at).reverse()) {
      if (slot.entry) continue;
      if (!slot.hidden) break;
      hiddenRun++;
    }
    if (hiddenRun >= 2) return { status: 409, code: 'move_unsupported' };
    moves = hiddenRun === 1 ? 2 : 1;
  }
  state.slots = next;
  state.rev += 1;
  return { status: 200, moves };
}

function viewFor(state) {
  const tokens = tokensOf(state.slots);
  return viewOf(tokens.filter((_, i) => !state.slots[i].hidden), { rev: state.rev });
}

/** The requested placement, stated independently: the token taken out and put at `to`. */
function expectedOrder(order, token, to) {
  const rest = order.filter(t => t !== token);
  return [...rest.slice(0, to), token, ...rest.slice(to)];
}

test('generator: projected occurrences, duplicates and hidden neighbours keep the order contract', { timeout: 60000 }, t => {
  const { order } = model(t);
  const totals = { cases: 0, commands: 0, applied: 0, refused: 0, conflicts: 0, moves: [0, 0, 0], unsupported: 0, maxEffects: 0 };
  const started = Date.now();
  for (const seed of SEEDS) {
    const next = rng(seed);
    for (let c = 0; c < CASES; c++) {
      totals.cases++;
      const state = { slots: randomSlots(next), rev: 1 };
      const hiddenBefore = () => state.slots.filter(s => s.hidden);
      const log = effectLog(200);
      const trace = [];
      const commands = 1 + Math.floor(next() * MAX_COMMANDS);
      for (let k = 0; k < commands; k++) {
        const v = viewFor(state);
        if (!v.order.length) break;
        const token = v.order[Math.floor(next() * v.order.length)];
        const command = next() < 0.3 ? { token, delta: next() < 0.5 ? -1 : 1 } : { token, to: Math.floor(next() * v.order.length) };
        trace.push(command);
        totals.commands++;
        const fail = (message) => assert.fail(`seed ${seed} case ${c}: ${message}\nshortest failing trace (${trace.length} commands): ${JSON.stringify(trace)}\nslots: ${JSON.stringify(state.slots)}`);
        const plan = order.plan(v, command);
        const from = v.order.indexOf(token);
        const to = command.to ?? from + command.delta;
        const parsed = order.parse(token);
        if (to < 0 || to >= v.order.length) { if (plan.reason !== 'out_of_range') fail(`expected out_of_range, got ${JSON.stringify(plan)}`); totals.refused++; continue; }
        if (to === from) { if (plan.reason !== 'noop') fail(`expected noop, got ${JSON.stringify(plan)}`); totals.refused++; continue; }
        if (parsed.kind === 'real' && parsed.k > 0) { if (plan.reason !== 'duplicate_copy') fail(`later copy not refused: ${JSON.stringify(plan)}`); totals.refused++; continue; }
        if (!plan.ok) fail(`supported move refused: ${JSON.stringify(plan)}`);
        const want = expectedOrder(v.order, token, to);
        if (plan.body.order.join() !== want.join()) fail(`placement ${JSON.stringify(plan.body.order)} != ${JSON.stringify(want)}`);
        const realChanged = v.order.filter(x => x.startsWith('e:')).join() !== want.filter(x => x.startsWith('e:')).join();
        if ((plan.native === 'none') === realChanged || (plan.body.moved !== null) !== realChanged) fail(`native ${plan.native} moved ${plan.body.moved} for realChanged ${realChanged}`);
        if (plan.body.order.some(x => !v.order.includes(x))) fail('a hidden or unknown token was sent');
        // Occasionally another editor changes the list first (a definite conflict: refreshed, never resubmitted).
        const concurrent = next() < 0.1;
        if (concurrent) state.rev += 1;
        const hidden = hiddenBefore();
        const answer = oracleApply(state, plan.body);
        log.push({ k, command, status: answer.status, code: answer.code, moves: answer.moves });
        const settled = order.settle(plan, answer.status === 200
          ? { status: 200, body: viewFor(state) }
          : { status: answer.status, body: { error: true, code: answer.code, view: viewFor(state) } });
        if (settled.resubmits !== 0) fail('a reorder was resubmitted automatically');
        if (answer.status === 200) {
          totals.applied++;
          totals.moves[answer.moves]++;
          if (!realChanged && answer.moves !== 0) fail('an entry-only move made a native move');
          if (settled.outcome !== 'applied') fail(`server applied but model said ${settled.outcome}/${settled.reason}`);
          // Hidden slots: still there, still after the same anchor relation (none lost or added).
          if (state.slots.filter(s => s.hidden).length !== hidden.length || hidden.some(s => !state.slots.includes(s))) fail('a hidden slot was lost');
        } else {
          totals.conflicts++;
          if (answer.code === 'move_unsupported') totals.unsupported++;
          if (settled.outcome !== 'conflict' || settled.reason !== answer.code || !settled.view) fail(`conflict not settled as such: ${JSON.stringify(settled)}`);
          if (!concurrent && answer.code === 'rev_conflict') fail('rev conflict without a concurrent change');
        }
      }
      totals.maxEffects = Math.max(totals.maxEffects, log.records.length + log.dropped);
    }
  }
  const ms = Date.now() - started;
  t.diagnostic(`generator: ${JSON.stringify(totals)} in ${ms} ms (caps: ${SEEDS.length} seeds x ${CASES} cases, <=${MAX_TOKENS} tokens, <=${MAX_COMMANDS} commands, <=200 effects)`);
  assert.ok(totals.applied > 0 && totals.conflicts > 0 && totals.refused > 0, 'every outcome class reached');
  assert.ok(totals.moves[0] > 0 && totals.moves[1] > 0 && totals.moves[2] > 0, 'zero, one and two native moves reached: ' + totals.moves);
  assert.ok(totals.unsupported > 0, 'unsupported moves reached');
  assert.ok(totals.maxEffects <= MAX_COMMANDS);
});
