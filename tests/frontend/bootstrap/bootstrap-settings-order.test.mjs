import test from 'node:test';
import assert from 'node:assert/strict';
import { tab, settingsServer, route, until } from '../helpers/settings-tabs.mjs';

// Stage 1 fix round 10: the settings store takes what the server hands out in the server's order. Every answer, read and
// boot read carries the document's revision (a count of its writes), and an answer older than what the store already
// holds never replaces it: the operation it answers is kept on top instead. A boot read's documents are adopted when the
// new userConfig object is assigned, through the same rule, so a read that began before them is not taken over them.
// (RBS1-R10-5: a delayed answer {a} replaced an acknowledged {a, b}; RBS1-R10-6: a held read replaced a newer boot document.)

const docs = () => ({ Settings: {}, Shortcuts: { Shortcuts: [] }, Bookmark: { Bookmarks: {} }, Elsewhere: { Region: 'US' }, HiddenContent: { Items: {}, Settings: {} } });
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };

for (const withRevision of [false, true]) {
  test(`R10-5: a late answer keeps a newer acknowledged home-row hide (acknowledgement ${withRevision ? 'with' : 'without'} its revision)`, async t => {
    const s = settingsServer(docs());
    const reply = gate();
    let applied = false;
    const h = await tab(t, s, { ajax: request => {
      if (request.type === 'PATCH' && request.url.includes('/hidden-content.json')) {
        const answer = route(s, request);
        applied = true;
        return reply.promise.then(() => answer);
      }
    } });
    const save = h.JE.patchUserSettings('hidden-content.json', { upsert: { a: { itemId: 'a' } } }, { throwOnError: true });
    await until(() => applied);
    // Another route of the server (the home-row removal) stores b after a and answers first.
    s.apply('hidden-content.json', 'PATCH', { Upsert: { b: { ItemId: 'b' } } });
    h.JE.internals.acknowledgeUserDocumentChange('hidden-content.json', { upsert: { b: { itemId: 'b' } } }, withRevision ? s.revision('hidden-content.json') : undefined);
    assert.ok(h.JE.internals.userDocument('hidden-content.json').document.items.b);
    reply.release();
    await save;
    assert.ok(s.documents.HiddenContent.Items.b, 'the server holds both');
    const shown = h.JE.internals.userDocument('hidden-content.json').document.items;
    assert.ok(shown.b, 'the late answer does not take the acknowledged hide away');
    assert.ok(shown.a, 'and its own item is kept');
  });
}

test('R10-5: an answer newer than an acknowledgement is taken whole', async t => {
  const s = settingsServer(docs());
  const h = await tab(t, s);
  s.apply('hidden-content.json', 'PATCH', { Upsert: { b: { ItemId: 'b' } } });
  const acknowledged = s.revision('hidden-content.json');
  // Another tab removed b and added c (the server's newer document); this tab's save answers with it.
  s.apply('hidden-content.json', 'PATCH', { Remove: ['b'], Upsert: { c: { ItemId: 'c' } } });
  await h.JE.patchUserSettings('hidden-content.json', { upsert: { a: { itemId: 'a' } } }, { throwOnError: true });
  h.JE.internals.acknowledgeUserDocumentChange('hidden-content.json', { upsert: { b: { itemId: 'b' } } }, acknowledged);
  const shown = h.JE.internals.userDocument('hidden-content.json').document.items;
  assert.deepEqual(Object.keys(shown).sort(), ['a', 'c'], 'an acknowledgement older than the answer held changes nothing');
});

test('R10-6: a read that began before a new boot document is assigned is not taken over it', async t => {
  const s = settingsServer(docs());
  const h = await tab(t, s);
  const held = s.hold('elsewhere.json', 'GET');
  const read = h.JE.readUserSettings('elsewhere.json');
  await held.reached;
  s.documents.Elsewhere.Region = 'DE';
  const next = structuredClone(h.JE.userConfig);
  next.elsewhere = { Region: 'DE' };
  // Nothing looks at the store between the assignment and the read's answer: the document is adopted when assigned.
  h.JE.userConfig = next;
  held.release();
  await read;
  assert.equal(h.JE.internals.userDocument('elsewhere.json').document.Region, 'DE');
});

test('R10-6 control: a boot read from before a save that was answered since is not adopted', async t => {
  const s = settingsServer(docs());
  const h = await tab(t, s);
  const before = structuredClone(h.JE.userConfig);
  await h.JE.patchUserSettings('elsewhere.json', { set: { Region: 'NZ' } }, { throwOnError: true });
  h.JE.userConfig = before;
  assert.equal(h.JE.internals.userDocument('elsewhere.json').document.Region, 'NZ');
});

test('R10-6 control: a read answered with an older revision than the store holds is not taken', async t => {
  const s = settingsServer(docs());
  const h = await tab(t, s, { ajax: request => {
    // A read served from before the save below (a replica's or a proxy's late answer): its revision says so.
    if (request.type === 'GET' && request.url.includes('/elsewhere.json') && request.url.includes('withRevision=true')) {
      return { document: { Region: 'US' }, revision: '000000000001.0' };
    }
  } });
  await h.JE.patchUserSettings('elsewhere.json', { set: { Region: 'NZ' } }, { throwOnError: true });
  await h.JE.readUserSettings('elsewhere.json');
  assert.equal(h.JE.internals.userDocument('elsewhere.json').document.Region, 'NZ');
});
