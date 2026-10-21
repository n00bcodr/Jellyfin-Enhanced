// Phase 4c3b1: Add to a list before a list is chosen. The picker opens from a title with no list yet: its origin owns a
// real paint ticket with no list id (lp.gate.issue(null, ...)) and the full fail-closed Spoiler policy until it is read;
// choosing a list is a separate target with its own ticket and generation, so switching lists drops the old list's
// reads without touching the origin, and an ended origin stays ended. Lists are the person's editable ones, their own
// first; a new playlist is private unless they choose otherwise; a new collection only for collection managers; end or
// start only. A new list's confirmed body and id never change; an uncertain create is replayed as the same request,
// never made twice or looked up by name. The real list transport, paint gate and session, HTTP held by the test.
import test from 'node:test';
import { setupAuthoring, json, deferred, owner, LIST, LIST2, COLL, view, assert } from './fixtures/arr-list-authoring.mjs';

const EDITABLE = {
  playlists: [
    { id: LIST2, name: 'Shared with me', isOwn: false, nativeCanEdit: true, ownerName: 'Dad' },
    { id: LIST, name: 'Mine', isOwn: true, nativeCanEdit: true, ownerName: 'Me' }
  ],
  collections: [{ id: COLL, name: 'Cars', isOwn: false, nativeCanEdit: true, ownerName: null }],
  canManageCollections: true
};

function origin(s, { op = owner(), live = () => true, policy, extra = {} } = {}) {
  const L = s.lp();
  return L.surface.origin({ owner: op, mount: s.mount(), live, policy: policy || (() => L.gate.policy(() => false, false)), ...extra });
}

test('the picker\'s origin is a real list-less paint ticket, fail-closed until its policy is read', async t => {
  const s = setupAuthoring(t);
  const L = s.lp();
  const policy = deferred();
  const asked = [];
  const o = origin(s, { policy: target => { asked.push(target); return policy.promise; } });
  assert.equal(o.ticket.listId, null, 'no list yet, and no fake list id');
  assert.deepEqual(asked, [null]);
  assert.equal(o.ticket.policy.resolved, false);
  assert.equal(o.ticket.policy({ kind: 'movie' }), true, 'guard everything while it loads');
  const node = s.mount();
  assert.equal(L.gate.paint(o.ticket, () => { node.textContent = 'x'; }, 'k'), false, 'held, not painted');
  policy.resolve(L.gate.policy(() => false, false));
  await o.ticket.ready;
  assert.equal(node.textContent, 'x', 'painted once the policy is known');
  o.end();
});

test('a policy that fails resolves to guarding everything; a missing policy guards everything', async t => {
  const s = setupAuthoring(t);
  const o = origin(s, { policy: async () => { throw new Error('nope'); } });
  await o.ticket.ready;
  assert.equal(o.ticket.policy({ kind: 'movie' }), true);
  assert.equal(o.ticket.policy.allDates, true);
  const L = s.lp();
  const o2 = L.surface.origin({ owner: owner(), mount: s.mount(), live: () => true });
  await o2.ticket.ready;
  assert.equal(o2.ticket.policy({ kind: 'movie' }), true, 'no policy loader: guard everything');
});

test('no owner opens nothing: it throws in tests and logs in production; NATIVE only at a declared native root', t => {
  const s = setupAuthoring(t);
  const L = s.lp();
  const mount = s.mount();
  assert.throws(() => L.surface.origin({ mount, live: () => true }), /without an owner/);
  assert.throws(() => L.surface.origin({ owner: null, mount, live: () => true }), /without an owner/);
  assert.throws(() => L.surface.origin({ owner: { current: 'yes' }, mount, live: () => true }), /without an owner/);
  // A native-looking owner is not a substitute for a lost one.
  assert.throws(() => L.surface.origin({ owner: { native: true, current: () => true }, mount, live: () => true }), /native/);
  // No live predicate: the final decision input is missing, so nothing opens.
  assert.throws(() => L.surface.origin({ owner: owner(), mount }), /live/);
  // An owner that already ended opens nothing.
  const ended = owner();
  ended.end();
  assert.equal(L.surface.origin({ owner: ended, mount, live: () => true }), null);
  const p = setupAuthoring(t, { strict: false });
  p.h.expectConsoleError(/without an owner/);
  assert.equal(p.lp().surface.origin({ mount: p.mount(), live: () => true }), null);
});

test('without the shared surface registry a portal is not registered and must not be shown', t => {
  const s = setupAuthoring(t);
  const o = origin(s);
  const root = s.document.createElement('div');
  let closed = 0;
  // A host without the shared surface registry (the play edge has it: D46's JE.openSurface).
  s.JE.openSurface = undefined;
  assert.equal(o.register(root, () => { closed++; }), null, 'unavailable, not imitated');
  assert.equal(o.registrable(), false);
  assert.equal(closed, 0);
});

test('editable lists: own first, others labelled with their owner, a private new playlist by default', async t => {
  const s = setupAuthoring(t, { route: async (m, path) => path === '/acquire/lists/editable' ? json(EDITABLE) : null });
  const L = s.lp();
  const o = origin(s);
  const root = s.mount();
  const picker = L.picker.create({ origin: o, root, media: { mediaType: 'movie', tmdbId: 5, title: 'M' }, editableLists: signal => s.JE.arrLists.editableLists(signal) });
  await picker.ready;
  const options = [...root.querySelectorAll('select[name="list"] option')].map(n => [n.value, n.textContent]);
  assert.deepEqual(options, [
    [`playlist:${LIST}`, 'Mine'],
    [`playlist:${LIST2}`, 'Shared with me (Dad)'],
    [`collection:${COLL}`, 'Cars'],
    ['new-playlist', 'New playlist…'],
    ['new-collection', 'New collection…']
  ]);
  assert.deepEqual([...root.querySelectorAll('select[name="position"] option')].map(n => n.value), ['end', 'start'], 'end or start only');
  picker.choose('new-playlist');
  root.querySelector('input[name="name"]').value = '  Friday  ';
  assert.deepEqual(picker.form(), { create: 'playlist', name: 'Friday', isPublic: false, position: 'end' });
  root.querySelector('input[name="public"]').checked = true;
  assert.equal(picker.form().isPublic, true, 'public only as a deliberate choice');
  picker.choose(`collection:${COLL}`);
  assert.deepEqual(picker.form(), { listKind: 'collection', listId: COLL, position: null });
  assert.equal(root.querySelector('[data-je-position]').hidden, true, 'collections keep the server\'s order');
  // A person who can't manage collections gets no new-collection choice.
  const s2 = setupAuthoring(t, { route: async (m, path) => path === '/acquire/lists/editable' ? json({ ...EDITABLE, collections: [], canManageCollections: false }) : null });
  const root2 = s2.mount();
  const p2 = s2.lp().picker.create({ origin: origin(s2), root: root2, media: { mediaType: 'movie', tmdbId: 5 }, editableLists: signal => s2.JE.arrLists.editableLists(signal) });
  await p2.ready;
  assert.equal(root2.querySelector('option[value="new-collection"]'), null);
});

test('a failed list read says so and offers nothing to send to', async t => {
  const s = setupAuthoring(t, { route: async (m, path) => path === '/acquire/lists/editable' ? json({ error: true }, 503) : null });
  const root = s.mount();
  const picker = s.lp().picker.create({ origin: origin(s), root, media: { mediaType: 'movie', tmdbId: 5 }, editableLists: signal => s.JE.arrLists.editableLists(signal) });
  await picker.ready;
  assert.match(root.textContent, /can't be read right now/);
  assert.equal(root.querySelector('select[name="list"]'), null);
  assert.equal(picker.form(), null);
});

test('switching the target list drops the old list\'s reads; the origin lives on; an ended origin stays ended', async t => {
  const gets = new Map();
  const s = setupAuthoring(t, {
    route: async (m, path) => {
      const id = /^\/acquire\/lists\/([0-9a-f]{32})$/.exec(path)?.[1];
      if (!id) return null;
      const d = deferred();
      gets.set(id, d);
      return d.promise;
    }
  });
  const L = s.lp();
  const op = owner();
  const o = origin(s, { op });
  const a = o.selectTarget(LIST, { listKind: 'playlist' });
  const readA = s.JE.arrLists.getList(LIST, { ticket: a.ticket });
  await s.settle();
  const b = o.selectTarget(LIST2, { listKind: 'playlist' });
  assert.equal(a.ticket.current(), false, 'the old target is revoked at once');
  assert.equal(b.ticket.current(), true);
  assert.equal(o.current(), true, 'the origin is untouched by a target switch');
  gets.get(LIST).resolve(json(view([], [])));
  await assert.rejects(readA, err => err?.stale === true, 'the old list\'s answer is dropped');
  // The target's tickets carry the list id; the origin's never does.
  assert.equal(b.ticket.listId, LIST2);
  assert.equal(o.ticket.listId, null);
  // The origin ends (owner ended): the target ends with it, and nothing revives either.
  op.end();
  assert.equal(o.current(), false);
  assert.equal(b.ticket.current(), false);
  op.current = () => true;
  assert.equal(o.current(), false, 'ended is monotonic');
  assert.equal(o.selectTarget(LIST, { listKind: 'playlist' }), null, 'no new target on an ended origin');
  const node = s.mount();
  assert.equal(L.gate.paint(o.ticket, () => { node.textContent = 'late'; }), false);
});

test('a new list: confirmed body and id stay fixed; its id starts a separate read-back under the same origin', async t => {
  const created = { listId: LIST2, listKind: 'playlist', name: 'Friday', result: { added: [{ id: 'x' }], addedAsItems: [], skipped: [] } };
  const posts = [];
  const s = setupAuthoring(t, {
    route: async (m, path, body) => {
      if (m === 'POST' && path === '/acquire/lists/playlists') { posts.push(body); return json(created, 201); }
      if (m === 'GET' && path === `/acquire/lists/${LIST2}`) return json(view([], [], { listId: LIST2 }));
      return null;
    }
  });
  const L = s.lp();
  const o = origin(s);
  const intents = L.authoring.intents();
  const dto = { kind: 'movie', mediaType: 'movie', tmdbId: 5, title: 'M' };
  const conf = intents.confirm('create', null, L.picker.createBody({ create: 'playlist', name: 'Friday', isPublic: false }, dto));
  const frozen = JSON.stringify(conf);
  const out = await L.authoring.submit(intents, conf, c => s.JE.arrLists.createPlaylist(c.body), o);
  assert.equal(out.outcome, 'ok');
  assert.equal(JSON.stringify(conf), frozen, 'the confirmation never changes');
  assert.throws(() => { conf.body.name = 'other'; }, TypeError);
  const target = o.created(out.answer.body.listId, { listKind: 'playlist' });
  assert.equal(target.ticket.listId, LIST2);
  const back = await s.JE.arrLists.getList(LIST2, { ticket: target.ticket });
  assert.equal(back.status, 200);
  assert.deepEqual(posts, [{ requestId: conf.body.requestId, name: 'Friday', isPublic: false, entries: [{ type: 'placeholder', placeholder: dto }] }]);
});

test('an uncertain create is replayed as the same request, never a second list or a lookup by name', async t => {
  const posts = [];
  let call = 0;
  const s = setupAuthoring(t, {
    route: async (m, path, body) => {
      if (m === 'POST' && path === '/acquire/lists/playlists') {
        posts.push(body);
        call++;
        if (call === 1) throw new TypeError('Failed to fetch');
        if (call === 2) return json({ error: true, code: 'create_uncertain', message: 'x' }, 409);
        return json({ listId: LIST2, listKind: 'playlist', name: 'Friday', result: { added: [], addedAsItems: [], skipped: [] } }, 201);
      }
      return null;
    }
  });
  const L = s.lp();
  const o = origin(s);
  const intents = L.authoring.intents();
  const body = L.picker.createBody({ create: 'playlist', name: 'Friday', isPublic: false }, { kind: 'movie', mediaType: 'movie', tmdbId: 5, title: 'M' });
  const send = c => s.JE.arrLists.createPlaylist(c.body);
  const first = intents.confirm('create', null, body);
  assert.equal((await L.authoring.submit(intents, first, send, o)).outcome, 'uncertain');
  const again = intents.confirm('create', null, body);
  assert.equal(again.body.requestId, first.body.requestId, 'the identical press replays');
  assert.equal((await L.authoring.submit(intents, again, send, o)).outcome, 'uncertain_create');
  assert.equal(intents.replay(again).body.requestId, first.body.requestId, 'still the same request');
  assert.deepEqual(intents.confirm('create', null, { ...body, name: 'Saturday' }), { ok: false, reason: 'uncertain_pending' }, 'no other create while one may exist');
  assert.equal((await L.authoring.submit(intents, intents.replay(again), send, o)).outcome, 'ok');
  assert.equal(new Set(posts.map(p => p.requestId)).size, 1, 'one create request id throughout');
  assert.equal(s.calls.filter(c => c.path === '/acquire/lists/editable').length, 0, 'never looked up by name');
});

test('ending the origin then pressing the identical action again works as a fresh owner', async t => {
  const s = setupAuthoring(t, { route: async (m, path) => path === '/acquire/lists/editable' ? json(EDITABLE) : null });
  const L = s.lp();
  const first = owner('first');
  const o1 = origin(s, { op: first });
  const p1 = L.picker.create({ origin: o1, root: s.mount(), media: { mediaType: 'movie', tmdbId: 5 }, editableLists: signal => s.JE.arrLists.editableLists(signal) });
  first.end();
  await p1.ready;
  assert.equal(p1.form(), null, 'the ended origin drew nothing');
  const o2 = origin(s, { op: owner('second') });
  const root2 = s.mount();
  const p2 = L.picker.create({ origin: o2, root: root2, media: { mediaType: 'movie', tmdbId: 5 }, editableLists: signal => s.JE.arrLists.editableLists(signal) });
  await p2.ready;
  assert.equal(root2.querySelectorAll('select[name="list"] option').length, 5);
});

test('results say what happened (added, from the library, partly, skipped) with a guarded link back to the list', async t => {
  const s = setupAuthoring(t);
  const L = s.lp();
  const o = origin(s);
  const target = o.selectTarget(LIST, { listKind: 'playlist' });
  const cases = [
    [{ added: [{}], addedAsItems: [], skipped: [] }, /^Added to Mine\./],
    [{ added: [], addedAsItems: [{}], skipped: [] }, /^Added from your library to Mine\./],
    [{ added: [{}], addedAsItems: [{}], skipped: [] }, /^Added to Mine: some of it from your library\./],
    [{ added: [], addedAsItems: [], skipped: [{ reason: 'duplicate' }] }, /^Not added to Mine: it is already there\./]
  ];
  for (const [result, words] of cases) {
    const root = s.mount();
    assert.equal(L.picker.showResult({ origin: o, target, root, listId: LIST, name: 'Mine', result }), true);
    assert.match(root.textContent, words);
    const link = root.querySelector('a');
    assert.equal(link.getAttribute('href'), `#/details?id=${LIST}`);
    assert.equal(link.textContent, 'Open Mine');
  }
  // A switched target or an ended origin draws no result.
  o.selectTarget(LIST2, { listKind: 'playlist' });
  const late = s.mount();
  assert.equal(L.picker.showResult({ origin: o, target, root: late, listId: LIST, name: 'Mine', result: cases[0][0] }), false);
  assert.equal(late.textContent, '');
});

test('Add to list is offered only behind the admin gate, for titles not already real and accessible', t => {
  const s = setupAuthoring(t);
  const offer = s.lp().picker.canOffer;
  const ON = { ArrListsEnabled: true, ArrListAuthoringEnabled: true, ArrListAddToListEnabled: true };
  const absent = { type: 'movie', tmdbId: 5, absent: true };
  const real = { type: 'movie', tmdbId: 5, shownItemId: 'f'.repeat(32), absent: false };
  assert.deepEqual(offer(absent, ON), { offer: true });
  assert.deepEqual(offer(absent, {}), { offer: false, reason: 'off' }, 'default off');
  assert.deepEqual(offer(absent, { ...ON, ArrListAddToListEnabled: false }), { offer: false, reason: 'off' });
  assert.deepEqual(offer(absent, { ...ON, ArrListAuthoringEnabled: false }), { offer: false, reason: 'off' }, 'the child never outlives its parent');
  // A real, accessible library item keeps Jellyfin's own Add to playlist/collection (no duplicate control).
  assert.deepEqual(offer(real, ON), { offer: false, reason: 'native_real' });
  // Page display off (household or personal) does not hide the picker.
  assert.deepEqual(offer(absent, { ...ON, ArrListPlaylistUiEnabled: false, ArrListCollectionUiEnabled: false }), { offer: true });
  for (const bad of [{ type: 'person', tmdbId: 5, absent: true }, { type: 'movie', tmdbId: 0, absent: true }, null]) assert.equal(offer(bad, ON).offer, false);
  // The positions an external picker offers.
  assert.deepEqual(s.lp().picker.POSITIONS, ['end', 'start']);
});

test('4C3B1-R1-3: choosing a new playlist or collection ends the previous target, its reads, target-bound intents and results', async t => {
  const gets = new Map();
  const s = setupAuthoring(t, {
    route: async (m, path) => {
      if (path === '/acquire/lists/editable') return json(EDITABLE);
      const id = /^\/acquire\/lists\/([0-9a-f]{32})$/.exec(path)?.[1];
      if (!id) return null;
      const d = deferred();
      gets.set(id, d);
      return d.promise;
    }
  });
  const L = s.lp();
  const o = origin(s);
  const root = s.mount();
  const picker = L.picker.create({ origin: o, root, media: { mediaType: 'movie', tmdbId: 5 }, editableLists: signal => s.JE.arrLists.editableLists(signal) });
  await picker.ready;
  for (const fresh of ['new-playlist', 'new-collection']) {
    picker.choose(`playlist:${LIST}`);
    const target = o.target();
    assert.equal(target.listId, LIST);
    const bound = o.intent('details', { target: true });
    const read = s.JE.arrLists.getList(LIST, { ticket: target.ticket });
    await s.settle();
    picker.choose(fresh);
    assert.equal(o.target(), null, `${fresh}: no existing list is the target any more`);
    assert.equal(target.ticket.current(), false, `${fresh}: the old target's ticket is revoked`);
    assert.equal(bound(), false, `${fresh}: target-bound intents end`);
    gets.get(LIST).resolve(json(view([], [])));
    await assert.rejects(read, e => e?.stale === true, `${fresh}: the old target's read is dropped`);
    const late = s.mount();
    assert.equal(L.picker.showResult({ origin: o, target, root: late, listId: LIST, name: 'Mine', result: { added: [{}], addedAsItems: [], skipped: [] } }), false);
    assert.equal(o.publish(bound, () => assert.fail('published for the old target')), false);
    assert.equal(late.textContent, '');
    assert.equal(o.current(), true, 'the origin lives on');
  }
  // Positive control: an existing list chosen again is the current target.
  picker.choose(`collection:${COLL}`);
  assert.equal(o.target().listId, COLL);
  assert.equal(o.target().ticket.current(), true);
});

test('4C3B1-R1-5 (picker): a destroyed picker is never drawn by a paint held for the policy; its origin lives on', async t => {
  const s = setupAuthoring(t, { route: async (m, path) => path === '/acquire/lists/editable' ? json(EDITABLE) : null });
  const L = s.lp();
  const policy = deferred();
  const o = origin(s, { policy: () => policy.promise });
  const root = s.mount();
  const picker = L.picker.create({ origin: o, root, media: { mediaType: 'movie', tmdbId: 5 }, editableLists: signal => s.JE.arrLists.editableLists(signal) });
  await picker.ready;
  picker.destroy();
  policy.resolve(L.gate.policy(() => false, false));
  await s.settle();
  assert.equal(root.childNodes.length, 0, 'nothing drawn after destroy');
  assert.equal(o.current(), true);
  const again = s.mount();
  const p2 = L.picker.create({ origin: o, root: again, media: { mediaType: 'movie', tmdbId: 5 }, editableLists: signal => s.JE.arrLists.editableLists(signal) });
  await p2.ready;
  assert.equal(again.querySelectorAll('select[name="list"] option').length, 5, 'a new picker on the same origin draws');
});
