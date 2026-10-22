import test from 'node:test';
import assert from 'node:assert/strict';
import { tab, settingsServer, route, until } from '../helpers/settings-tabs.mjs';
import { deferred } from '../helpers/harness.mjs';

// Stage 1 fix round 11: the server's newer document wins. An answer whose revision is older than the document the store
// holds never puts its operation or its fields back over it: the newer document is the baseline, so a later explicit save
// of the old value is a change (RBS1-R11-3; round 10 had kept the late answer's operation on top, Q-REBUILD1FIX10-3,
// reversed: a delayed hide resurrected an item another tab had unhidden, an older settings answer replaced the newer
// display language, and choosing NZ again sent nothing while the server kept DE).

const docs = () => ({ Settings: {}, Shortcuts: { Shortcuts: [] }, Bookmark: { Bookmarks: {} }, Elsewhere: { Region: 'US' }, HiddenContent: { Items: {}, Settings: {} } });

/** A tab whose PATCH answers of `file` are applied by the server at once but answered only when `held` resolves. */
async function lateAnswers(t, s, file, held, edit = answer => answer) {
  let applied = false;
  const h = await tab(t, s, { ajax: request => {
    if (request.type === 'PATCH' && request.url.includes(`/${file}`)) {
      const answer = edit(route(s, request));
      applied = true;
      return held.promise.then(() => answer);
    }
  } });
  return { h, applied: () => applied };
}

/** The same person's next boot read, with the server's documents and revisions now. */
function rebootWith(h, s, view, file, doc) {
  const next = { ...h.JE.userConfig, [view]: doc };
  Object.defineProperty(next, 'readDocuments', { value: { [file]: structuredClone(doc) } });
  Object.defineProperty(next, 'readRevisions', { value: { [file]: s.revision(file) } });
  h.JE.userConfig = next;
}

test('R11-3: after an older answer, saving the value it set again is a change, and is sent', async t => {
  const s = settingsServer(docs());
  const held = deferred();
  const { h: a, applied } = await lateAnswers(t, s, 'elsewhere.json', held);
  const b = await tab(t, s);
  const save = a.JE.patchUserSettings('elsewhere.json', { set: { Region: 'NZ' } }, { throwOnError: true });
  await until(applied);
  await b.JE.patchUserSettings('elsewhere.json', { set: { Region: 'DE' } }, { throwOnError: true });
  rebootWith(a, s, 'elsewhere', 'elsewhere.json', { Region: 'DE' });
  held.resolve();
  await save;
  assert.equal(s.documents.Elsewhere.Region, 'DE');
  assert.equal(a.JE.internals.userDocument('elsewhere.json').document.Region, 'DE', 'the newer document is what the page shows');
  await a.JE.saveUserSettings('elsewhere.json', { Region: 'NZ' }, { throwOnError: true });
  assert.equal(s.documents.Elsewhere.Region, 'NZ', 'the explicit choice is sent');
});

test('R11-3: an older hide answer does not bring back an item another tab unhid (read in the next boot)', async t => {
  const s = settingsServer(docs());
  const held = deferred();
  const { h: a, applied } = await lateAnswers(t, s, 'hidden-content.json', held);
  const b = await tab(t, s);
  const save = a.JE.patchUserSettings('hidden-content.json', { upsert: { movie: { itemId: 'movie' } } }, { throwOnError: true });
  await until(applied);
  await b.JE.patchUserSettings('hidden-content.json', { remove: ['movie'] }, { throwOnError: true });
  rebootWith(a, s, 'hiddenContent', 'hidden-content.json', { items: {}, settings: {} });
  held.resolve();
  await save;
  assert.deepEqual(Object.keys(s.documents.HiddenContent.Items), []);
  assert.deepEqual(Object.keys(b.JE.internals.userDocument('hidden-content.json').document.items), []);
  assert.deepEqual(Object.keys(a.JE.internals.userDocument('hidden-content.json').document.items), [], 'both tabs agree with the server');
});

test('R11-3: an older unhide answer keeps a home-row hide acknowledged after it', async t => {
  const s = settingsServer(docs());
  s.documents.HiddenContent.Items.movie = { ItemId: 'movie' };
  const held = deferred();
  const { h, applied } = await lateAnswers(t, s, 'hidden-content.json', held);
  const save = h.JE.patchUserSettings('hidden-content.json', { remove: ['movie'] }, { throwOnError: true });
  await until(applied);
  // Another route of the server (the home-row removal) hides it again and is acknowledged before the unhide is answered.
  s.apply('hidden-content.json', 'PATCH', { Upsert: { movie: { ItemId: 'movie' } } });
  h.JE.internals.userDocumentHandle('hidden-content.json', h.JE.core.userWrite.origin()).acknowledge({ upsert: { movie: { itemId: 'movie' } } }, s.revision('hidden-content.json'));
  held.resolve();
  await save;
  assert.ok(s.documents.HiddenContent.Items.movie);
  assert.ok(h.JE.internals.userDocument('hidden-content.json').document.items.movie, 'the later hide stays');
});

test('R11-3: an older settings answer does not put its display language over the newer one', async t => {
  const s = settingsServer(docs());
  const held = deferred();
  const { h: a, applied } = await lateAnswers(t, s, 'settings.json', held, answer => ({ ...answer, displayLanguage: 'de' }));
  a.JE.internals.scheduleReloadWhenIdle = () => {};
  const b = await tab(t, s);
  b.JE.internals.scheduleReloadWhenIdle = () => {};
  const save = a.JE.updateSettings({ displayLanguage: 'de' }, { throwOnError: true });
  await until(applied);
  await b.JE.updateSettings({ displayLanguage: 'fr' }, { throwOnError: true });
  rebootWith(a, s, 'settings', 'settings.json', { displayLanguage: 'fr' });
  held.resolve();
  await save;
  assert.equal(s.documents.Settings.DisplayLanguage, 'fr');
  assert.equal(a.JE.currentSettings.displayLanguage, 'fr', 'the server already holds the other tab\'s newer choice');
  assert.equal(a.window.localStorage.getItem('user-a-language'), 'fr');
});

test('R11-3 control: an answer with nothing newer since is taken whole', async t => {
  const s = settingsServer(docs());
  const held = deferred();
  const { h, applied } = await lateAnswers(t, s, 'elsewhere.json', held);
  const save = h.JE.patchUserSettings('elsewhere.json', { set: { Region: 'NZ' } }, { throwOnError: true });
  await until(applied);
  held.resolve();
  await save;
  assert.equal(h.JE.internals.userDocument('elsewhere.json').document.Region, 'NZ');
});
