// Phase 4c3b1: list authoring input and actions. Validation as the server enforces it (notes <=300, titles <=200, <=100
// distinct episodes of one season, custom type/year/date/note), link targets, who may edit versus who may ask, the
// confirmation identity of a write (a definite conflict refreshes and is never resent; only the exact confirmation
// whose answer was lost is sent again with the same id), the entry menu and the note/custom presenters through the
// paint gate. Sends go through the real list transport against a route table.
import test from 'node:test';
import { setupAuthoring, ph, view, LIST, P, ITEM, json, PROPOSED_KEYS, surfaceOf, owner, deferred, assert } from './fixtures/arr-list-authoring.mjs';

const ROLE_VIEWS = {
  // Owner of a playlist: edits, reorders and may ask.
  owner: view([ph(P(1), { actions: ['request', 'remove', 'note'] }), ph(P(2), { kind: 'custom', tmdbId: null, actions: ['remove', 'note', 'link'] })], [], { canEdit: true, nativeCanEdit: true, actions: ['edit', 'reorder', 'request'] }),
  // Shared read-only: may ask, never edits.
  share: view([ph(P(1), { actions: ['request'] })], [], { canEdit: false, actions: ['request'] }),
  // An administrator on another person's playlist: the server grants editing through the owner.
  adminOtherOwner: view([ph(P(1), { actions: ['remove', 'note'] })], [], { canEdit: true, nativeCanEdit: false, actions: ['edit', 'reorder'] }),
  // A collection manager: edits a collection, whose order is the server's (no reorder).
  collectionManager: view([ph(P(1), { actions: ['remove', 'note'] })], [], { listKind: 'collection', canEdit: true, actions: ['edit'] }),
  // A restricted Kid: nothing.
  kid: view([ph(P(1), { actions: [] })], [], { canEdit: false, actions: [] })
};

test('notes, titles, custom type/year/date are validated as the server does', t => {
  const { lp } = setupAuthoring(t);
  const a = lp().authoring;
  assert.deepEqual(a.LIMITS, { title: 200, note: 300, episodes: 100, yearMin: 1870, yearMax: 2100 });
  assert.deepEqual(a.validateNote('  hello  '), { ok: true, note: 'hello' });
  assert.deepEqual(a.validateNote(''), { ok: true, note: '' }, 'an empty note clears it');
  assert.equal(a.validateNote('x'.repeat(300)).ok, true);
  assert.deepEqual(a.validateNote('x'.repeat(301)), { ok: false, field: 'note', key: 'arr_lists_author_err_note' });
  const base = { type: 'movie', title: 'Cars 4' };
  assert.deepEqual(a.validateCustom(base), { ok: true, dto: { kind: 'custom', mediaType: 'movie', title: 'Cars 4' } });
  assert.equal(a.validateCustom({ ...base, title: 'x'.repeat(200) }).ok, true);
  for (const title of ['', '   ', 'x'.repeat(201)]) assert.deepEqual(a.validateCustom({ ...base, title }), { ok: false, field: 'title', key: 'arr_lists_author_err_title' }, JSON.stringify(title));
  for (const year of ['1869', '2101', '19x9', '2000.5']) assert.deepEqual(a.validateCustom({ ...base, year }), { ok: false, field: 'year', key: 'arr_lists_author_err_year' }, year);
  assert.equal(a.validateCustom({ ...base, year: '1870' }).dto.year, 1870);
  assert.equal(a.validateCustom({ ...base, year: '2100' }).dto.year, 2100);
  for (const date of ['2026-2-1', '2026-02-30', 'tomorrow', '2026-13-01']) assert.deepEqual(a.validateCustom({ ...base, date }), { ok: false, field: 'date', key: 'arr_lists_author_err_date' }, date);
  assert.deepEqual(a.validateCustom({ ...base, date: '2027-06-01' }).dto, { kind: 'custom', mediaType: 'movie', title: 'Cars 4', releaseDate: '2027-06-01', year: 2027 });
  assert.deepEqual(a.validateCustom({ ...base, type: 'book' }), { ok: false, field: 'type', key: 'arr_lists_author_err_type' });
  assert.equal(a.validateCustom({ ...base, type: 'tv' }).dto.mediaType, 'tv');
  assert.deepEqual(a.validateCustom({ ...base, note: 'x'.repeat(301) }), { ok: false, field: 'note', key: 'arr_lists_author_err_note' });
  assert.equal(a.validateCustom({ ...base, note: ' see it ' }).dto.note, 'see it');
});

test('episodes: one season, at most 100 distinct (0, 1, 100 and 101), duplicates collapsed before the cap', t => {
  const { lp } = setupAuthoring(t);
  const a = lp().authoring;
  const eps = n => Array.from({ length: n }, (_, i) => ({ s: 2, e: i + 1 }));
  assert.deepEqual(a.validateEpisodes(2, []), { ok: false, reason: 'empty' });
  assert.deepEqual(a.validateEpisodes(2, eps(1)), { ok: true, episodes: [{ s: 2, e: 1 }] });
  assert.equal(a.validateEpisodes(2, eps(100)).episodes.length, 100);
  assert.deepEqual(a.validateEpisodes(2, eps(101)), { ok: false, reason: 'too_many' });
  // 101 picks with one repeated: 100 distinct is fine, and what is sent is the 100 (the server bounds the raw input).
  const repeated = [...eps(100), { s: 2, e: 5 }];
  assert.deepEqual(a.validateEpisodes(2, repeated).episodes.length, 100);
  assert.deepEqual(a.validateEpisodes(2, [{ s: 2, e: 5 }, { s: 3, e: 1 }]), { ok: false, reason: 'mixed_season' });
  assert.deepEqual(a.validateEpisodes(2, [{ s: 2, e: -1 }]), { ok: false, reason: 'invalid' });
  assert.deepEqual(a.validateEpisodes(0, [{ s: 0, e: 3 }, { s: 0, e: 1 }]), { ok: true, episodes: [{ s: 0, e: 1 }, { s: 0, e: 3 }] }, 'specials are season 0, sorted');
});

test('linking a custom entry: only to a title with a real identity the person can use', t => {
  const { lp } = setupAuthoring(t);
  const a = lp().authoring;
  const custom = ph(P(1), { kind: 'custom', tmdbId: null, actions: ['remove', 'note', 'link'] });
  const candidate = { identity: { mediaType: 'movie', tmdbId: 55 }, title: 'Cars', year: 2006, releaseDate: '2006-06-09', posterPath: '/c.jpg', inert: false };
  assert.deepEqual(a.linkTarget(custom, candidate), { ok: true, link: { kind: 'movie', mediaType: 'movie', tmdbId: 55, title: 'Cars', year: 2006, releaseDate: '2006-06-09', posterPath: '/c.jpg' } });
  assert.deepEqual(a.linkTarget(ph(P(2)), candidate), { ok: false, reason: 'not_custom' });
  assert.deepEqual(a.linkTarget({ ...custom, actions: ['remove'] }, candidate), { ok: false, reason: 'not_custom' }, 'the entry must offer link');
  assert.deepEqual(a.linkTarget(custom, { ...candidate, identity: null, inert: true }), { ok: false, reason: 'inert' });
  assert.deepEqual(a.linkTarget(custom, { ...candidate, identity: { mediaType: 'movie', tmdbId: 0 } }), { ok: false, reason: 'no_identity' });
  assert.deepEqual(a.linkTarget(custom, { ...candidate, accessible: false }), { ok: false, reason: 'inaccessible' });
});

test('editing and asking are separate rights, from the server\'s actions for each person', t => {
  const { lp } = setupAuthoring(t);
  const a = lp().authoring;
  const of = (v, i = 0) => a.capabilities(v, v.placeholders[i]);
  assert.deepEqual(of(ROLE_VIEWS.owner), { edit: true, reorder: true, note: true, link: false, remove: true, request: true });
  assert.deepEqual(of(ROLE_VIEWS.owner, 1), { edit: true, reorder: true, note: true, link: true, remove: true, request: false });
  assert.deepEqual(of(ROLE_VIEWS.share), { edit: false, reorder: false, note: false, link: false, remove: false, request: true });
  assert.deepEqual(of(ROLE_VIEWS.adminOtherOwner), { edit: true, reorder: true, note: true, link: false, remove: true, request: false });
  assert.deepEqual(of(ROLE_VIEWS.collectionManager), { edit: true, reorder: false, note: true, link: false, remove: true, request: false });
  assert.deepEqual(of(ROLE_VIEWS.kid), { edit: false, reorder: false, note: false, link: false, remove: false, request: false });
  // A saved canEdit without the server's action grants nothing.
  assert.equal(a.capabilities({ ...ROLE_VIEWS.share, canEdit: true }, ROLE_VIEWS.share.placeholders[0]).edit, false);
});

test('the entry menu offers what the person may do; Move up/down only where the row can\'t be dragged', t => {
  const { lp } = setupAuthoring(t);
  const actions = lp().actions;
  const v = { ...ROLE_VIEWS.owner, order: ['e:' + ITEM(1) + ':0', 'p:' + P(1), 'p:' + P(2)] };
  const ids = (vv, i, o) => actions.menuItems(vv, vv.placeholders[i], o).map(m => m.id);
  assert.deepEqual(ids(v, 0, { canDrag: false }), ['move-up', 'move-down', 'note', 'remove']);
  assert.deepEqual(ids(v, 1, { canDrag: false }), ['move-up', 'note', 'link', 'remove']);
  assert.deepEqual(ids(v, 0, { canDrag: true }), ['note', 'remove']);
  assert.deepEqual(ids(ROLE_VIEWS.share, 0, {}), [], 'Request stays on the row; nothing to edit');
  assert.deepEqual(ids(ROLE_VIEWS.collectionManager, 0, { canDrag: false }), ['note', 'remove']);
  assert.deepEqual(ids(ROLE_VIEWS.kid, 0, {}), []);
  assert.equal(actions.menuItems(v, v.placeholders[0], {}).find(m => m.id === 'remove').danger, true);
});

/** A list route table for PATCH/DELETE answers. */
function routes(answers) {
  const sent = [];
  return {
    sent,
    route: async (method, path, body) => {
      if (method === 'GET') return null;
      sent.push({ method, path, body });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ? json(...next) : null;
    }
  };
}

test('a definite conflict refreshes the entry and sends nothing more; the next press is a new confirmation', async t => {
  const fresh = view([ph(P(1), { note: 'theirs', actions: ['remove', 'note'] })], ['p:' + P(1)], { rev: 7, canEdit: true, actions: ['edit'] });
  const r = routes([[{ error: true, code: 'rev_conflict', message: 'x', view: fresh }, 409], [fresh, 200]]);
  const s = setupAuthoring(t, { route: r.route });
  const { lp, JE, settle } = s;
  const a = lp().authoring;
  const o = surfaceOf(s);
  const intents = a.intents();
  const send = conf => JE.arrLists.patchItem(LIST, P(1), conf.body);
  const first = intents.confirm('note', LIST, { rev: 6, note: 'mine' }, { entry: P(1) });
  const out = await a.submit(intents, first, send, o);
  await settle();
  assert.equal(out.outcome, 'conflict');
  assert.equal(out.view.rev, 7);
  assert.equal(out.resubmits, 0);
  assert.equal(r.sent.length, 1, 'no automatic resend after rev_conflict');
  assert.equal(intents.replay(first), null, 'a definite answer is not replayable');
  // The person presses again on the refreshed view: new body, new id.
  const second = intents.confirm('note', LIST, { rev: 7, note: 'mine' }, { entry: P(1) });
  assert.notEqual(second.body.requestId, first.body.requestId);
  assert.equal((await a.submit(intents, second, send, o)).outcome, 'ok');
  assert.equal(r.sent.length, 2);
  // Even an identical body pressed again after a definite answer is a new confirmation.
  const third = intents.confirm('note', LIST, { rev: 7, note: 'mine' }, { entry: P(1) });
  assert.notEqual(third.body.requestId, second.body.requestId);
});

test('only the exact confirmation whose answer was lost is sent again, with the same body and id', async t => {
  const ok = view([], [], { rev: 8, canEdit: true, actions: ['edit'] });
  const r = routes([new TypeError('Failed to fetch'), [ok, 200]]);
  const s = setupAuthoring(t, { route: r.route });
  const { lp, JE } = s;
  const a = lp().authoring;
  const o = surfaceOf(s);
  const intents = a.intents();
  const send = conf => JE.arrLists.removeItem(LIST, P(1), conf.body);
  const conf = intents.confirm('remove', LIST, { rev: 7 }, { entry: P(1) });
  const lost = await a.submit(intents, conf, send, o);
  assert.equal(lost.outcome, 'uncertain');
  assert.equal(r.sent.length, 1);
  const again = intents.replay(conf);
  assert.deepEqual(again, conf, 'same body, same id');
  assert.equal((await a.submit(intents, again, send, o)).outcome, 'ok');
  assert.equal(r.sent.length, 2);
  assert.equal(r.sent[0].path, r.sent[1].path, 'the same request id in the query');
  assert.match(r.sent[0].path, new RegExp(`requestId=${conf.body.requestId}`));
  // While a confirmation is uncertain, a changed intent can't silently take its place.
  const r2 = routes([new TypeError('Failed to fetch')]);
  const s2 = setupAuthoring(t, { route: r2.route });
  const i2 = s2.lp().authoring.intents();
  const c2 = i2.confirm('note', LIST, { rev: 7, note: 'a' }, { entry: P(1) });
  await s2.lp().authoring.submit(i2, c2, conf => s2.JE.arrLists.patchItem(LIST, P(1), conf.body), surfaceOf(s2));
  assert.deepEqual(i2.confirm('note', LIST, { rev: 7, note: 'b' }, { entry: P(1) }), { ok: false, reason: 'uncertain_pending' });
  assert.equal(i2.confirm('note', LIST, { rev: 7, note: 'a' }, { entry: P(1) }).body.requestId, c2.body.requestId, 'the identical press replays');
  assert.notEqual(i2.confirm('note', LIST, { rev: 7, note: 'b' }, { entry: P(1), fresh: true }).body.requestId, c2.body.requestId, 'a deliberate new confirmation');
});

test('an entry deleted or swapped in meanwhile: the canonical view is shown, nothing is resent', async t => {
  const gone = view([], ['e:' + ITEM(1) + ':0'], { rev: 9, canEdit: true, actions: ['edit'] });
  const r = routes([[{ error: true, code: 'rev_conflict', view: gone }, 409]]);
  const s = setupAuthoring(t, { route: r.route });
  const { lp, JE } = s;
  const a = lp().authoring;
  const intents = a.intents();
  const conf = intents.confirm('remove', LIST, { rev: 8 }, { entry: P(1) });
  const out = await a.submit(intents, conf, c => JE.arrLists.removeItem(LIST, P(1), c.body), surfaceOf(s));
  assert.deepEqual([out.outcome, out.entryGone, out.view.order], ['conflict', true, ['e:' + ITEM(1) + ':0']]);
  assert.equal(a.present(out.view, P(1)), false);
  assert.equal(r.sent.length, 1);
});

test('answers are classified by status and code (create_uncertain is never a success or a new list)', t => {
  const { lp } = setupAuthoring(t);
  const a = lp().authoring;
  assert.equal(a.classify({ status: 200, body: {} }), 'ok');
  assert.equal(a.classify({ status: 201, body: {} }), 'ok');
  assert.equal(a.classify({ status: 409, body: { code: 'rev_conflict' } }), 'conflict');
  assert.equal(a.classify({ status: 409, body: { code: 'create_uncertain' } }), 'uncertain_create');
  assert.equal(a.classify({ status: 409, body: { code: 'name_taken' } }), 'refused');
  assert.equal(a.classify({ status: 400, body: {} }), 'refused');
  for (const s of [401, 403, 404]) assert.equal(a.classify({ status: s, body: null }), 'denied');
  for (const s of [500, 502, 503, 504]) assert.equal(a.classify({ status: s, body: null }), 'uncertain');
  assert.equal(a.classify(null), 'uncertain');
});

test('the note editor follows Spoiler Guard: a guarded entry\'s note and title stay out of text and labels', t => {
  const { lp, mount, document } = setupAuthoring(t);
  const L = lp();
  const plain = ph(P(1), { kind: 'episodes', mediaType: 'tv', title: 'Twin Peaks', seasonNumber: 2, episodes: [{ s: 2, e: 9, title: 'Arbitrary Law' }], note: 'the reveal' });
  const guarded = L.gate.issue(null, () => true, L.gate.policy(() => true, true));
  const root = mount();
  const editor = L.actions.noteEditor({ ticket: guarded, root, ph: plain });
  const area = root.querySelector('textarea');
  assert.equal(area.value, '', 'a guarded note is not shown for editing');
  assert.equal(area.getAttribute('maxlength'), '300');
  assert.doesNotMatch(root.textContent + area.getAttribute('aria-label') + (root.querySelector('[title]')?.title || ''), /Arbitrary|reveal|Twin Peaks/);
  assert.match(root.textContent, /Note hidden by Spoiler Guard/);
  editor.destroy();
  // Not guarded: the note is there to edit and the label names the title (no episode title is ever in the label).
  const open = L.gate.issue(null, () => true, L.gate.policy(() => false, false));
  const root2 = mount();
  const editor2 = L.actions.noteEditor({ ticket: open, root: root2, ph: plain });
  assert.equal(root2.querySelector('textarea').value, 'the reveal');
  assert.match(root2.querySelector('textarea').getAttribute('aria-label'), /Twin Peaks/);
  root2.querySelector('textarea').value = 'x'.repeat(301);
  assert.deepEqual(editor2.read(), { ok: false, field: 'note', key: 'arr_lists_author_err_note' });
  assert.match(root2.querySelector('[role="alert"]').textContent, /at most 300/);
  assert.equal(root2.querySelector('textarea').getAttribute('aria-invalid'), 'true');
  root2.querySelector('textarea').value = 'ok';
  assert.deepEqual(editor2.read(), { ok: true, note: 'ok' });
  assert.equal(root2.querySelector('[role="alert"]').textContent, '');
  // A revoked ticket paints nothing (the editor stays as it was).
  open.revoke();
  root2.querySelector('textarea').value = 'x'.repeat(301);
  editor2.read();
  assert.equal(root2.querySelector('[role="alert"]').textContent, '', 'nothing painted after revoke');
  assert.ok(document.body.contains(root2));
});

test('the custom entry form reports each field\'s error in words, never painting after its ticket ends', t => {
  const { lp, mount } = setupAuthoring(t);
  const L = lp();
  const ticket = L.gate.issue(null, () => true, L.gate.policy(() => false, false));
  const root = mount();
  const form = L.actions.customForm({ ticket, root });
  const field = name => root.querySelector(`[name="${name}"]`);
  assert.deepEqual([...root.querySelectorAll('[name]')].map(n => n.name), ['type', 'title', 'year', 'date', 'note']);
  field('title').value = 'Cars 4';
  field('year').value = '1800';
  assert.deepEqual(form.read(), { ok: false, field: 'year', key: 'arr_lists_author_err_year' });
  assert.equal(field('year').getAttribute('aria-invalid'), 'true');
  assert.match(root.querySelector('[role="alert"]').textContent, /1870 and 2100/);
  field('year').value = '2027';
  assert.deepEqual(form.read(), { ok: true, dto: { kind: 'custom', mediaType: 'movie', title: 'Cars 4', year: 2027 } });
  assert.equal(field('year').hasAttribute('aria-invalid'), false);
  // Prefill from an inert candidate (an arr result without TMDB): words only, never an identity.
  form.prefill({ title: 'Lost Show', year: 1999, mediaType: 'tv', tmdbId: 42 });
  assert.deepEqual(form.read(), { ok: true, dto: { kind: 'custom', mediaType: 'tv', title: 'Lost Show', year: 1999 } });
});

test('every string the presenters use is in en.json or the English handoff list', t => {
  const { lp } = setupAuthoring(t);
  const used = new Set([...lp().actions.KEYS, ...lp().search.KEYS, ...lp().granularity.KEYS, ...lp().picker.KEYS]);
  const missing = [...used].filter(k => !(k in PROPOSED_KEYS) && (() => { try { return !lp().render.tr(k); } catch { return true; } })());
  assert.deepEqual(missing, []);
  // The handoff list holds nothing unused.
  assert.deepEqual(Object.keys(PROPOSED_KEYS).filter(k => !used.has(k)), []);
});

test('a write\'s answer is read under its surface: no binding sends nothing; an owner ending mid-send settles nothing', async t => {
  const answer = deferred();
  const sent = [];
  const s = setupAuthoring(t);
  const a = s.lp().authoring;
  const intents = a.intents();
  const send = conf => { sent.push(conf.body.requestId); return answer.promise; };
  const conf = intents.confirm('remove', LIST, { rev: 7 }, { entry: P(1) });
  assert.deepEqual(await a.submit(intents, conf, send), { outcome: 'refused', reason: 'unbound', resubmits: 0 }, 'no surface: nothing is sent');
  assert.deepEqual(sent, []);
  const op = owner();
  const o = surfaceOf(s, op);
  const pending = a.submit(intents, conf, send, o);
  assert.equal(sent.length, 1, 'sent once while the owner is current');
  op.end();
  answer.resolve({ status: 503, body: null });
  assert.deepEqual(await pending, { outcome: 'stale', resubmits: 0 });
  assert.equal(intents.replay(conf), null, 'an ended owner\'s uncertain answer is not kept for a replay');
  // An ended surface sends nothing.
  assert.deepEqual(await a.submit(intents, intents.confirm('remove', LIST, { rev: 7 }, { entry: P(1) }), send, o), { outcome: 'stale', resubmits: 0 });
  assert.equal(sent.length, 1);
});
