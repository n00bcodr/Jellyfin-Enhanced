import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain, deferred } from '../../helpers/harness.mjs';

// Behaviour mutation testing found no test pinning: the anniversary rule of people's ages, a people answer landing in
// the gap between an identity change and its reset, and an editor Save pressed in that same gap. Each drives the
// emitted production scripts.

const person = n => n.toString(16).padStart(32, '0');
const detailsPage = id => `<div id="itemDetailPage" class="page" data-item="${id}"><div class="itemMiscInfo itemMiscInfo-primary"></div><div id="castCollapsible"><div id="castContent"></div></div><div id="guestCastCollapsible"><div id="guestCastContent"></div></div></div>`;
const personCard = n => `<div class="card personCard" data-id="${person(n)}"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer"></div></div></div></div>`;
const castOf = people => ({ Type: 'Movie', People: people.map(n => ({ Id: person(n), Type: 'Actor' })) });
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

/** The details page with its cast; the debounced quiet run and the session are driven by hand. */
function peoplePage(t, { facts, premiere = '2000-06-15T00:00:00.0000000Z', server } = {}) {
  const calls = [], tracked = new Set();
  let epoch = 1, onMutation = null, quietRun = null;
  const h = createHarness({
    html: detailsPage('movie'),
    url: 'http://jellyfin.test/web/index.html#/details?id=movie',
    JE: {
      currentSettings: { peopleTagsEnabled: true },
      pluginConfig: {},
      cdn: { flagPng: code => `/flags/${code}.png` },
      helpers: {
        debounce: fn => () => { quietRun = fn; },
        createObserver: (_name, fn) => { onMutation = fn; },
        getItemCached: id => Promise.resolve({ Id: id, PremiereDate: premiere }),
      },
      core: {
        lifecycle: { register: () => ({
          track: resource => { tracked.add(resource); return resource; },
          untrack: resource => { tracked.delete(resource); },
          teardown: () => { for (const resource of tracked) resource.abort?.(); tracked.clear(); },
        }) },
        ui: { injectCss() {} },
        api: { plugin: (path, options) => {
          const ids = path.slice('/people/info?ids='.length).split(',').map(decodeURIComponent);
          calls.push(ids);
          const answer = { people: Object.fromEntries(ids.map(id => [id, facts(id)])) };
          return server && calls.length === 1 ? server(answer, options) : Promise.resolve(answer);
        } },
      },
      session: { getEpoch: () => epoch, isCurrent: value => value === epoch, onUserChange() {}, getServerId: () => 'server-a', getUserId: () => 'user-a' },
    },
  });
  t.after(() => h.close());
  h.load('tags/peopletags.js');
  h.JE.initializePeopleTags();
  const view = () => h.document.querySelector('#itemDetailPage:not(.hide)');
  const mount = async cast => {
    view().querySelector('#castContent').insertAdjacentHTML('beforeend', cast.map(personCard).join(''));
    onMutation([{ addedNodes: [h.document.createElement('div')] }]);
    await flush();
    const run = quietRun;
    quietRun = null;
    run?.();
    await flush();
  };
  return { ...h, calls, mount, view,
    changeIdentity() { epoch++; },
    navigate(id) {
      for (const page of h.document.querySelectorAll('#itemDetailPage')) page.classList.add('hide');
      h.document.body.insertAdjacentHTML('beforeend', detailsPage(id));
      h.window.location.hash = `#/details?id=${id}`;
    },
    releaseAge: () => view().querySelector('.je-people-age-release .je-people-age-text')?.textContent ?? null,
  };
}

for (const [born, released, age] of [
  ['1980-06-15', '2000-06-15', '20y'],
  ['1980-06-16', '2000-06-15', '19y'],
  ['1980-07-01', '2000-06-15', '19y'],
  ['1980-05-30', '2000-06-15', '20y'],
  ['2000-02-29', '2001-02-28', '1y'],
  ['2000-02-29', '2001-02-27', '0y'],
]) test(`someone born ${born} is ${age} on ${released}: an age counts from that year's anniversary`, async t => {
  const h = peoplePage(t, { facts: () => ({ birthDate: born, birthPlace: 'Paris, France' }), premiere: `${released}T00:00:00.0000000Z` });
  await h.mount([1]);
  assert.equal(h.releaseAge(), age);
});

test('a people answer landing between an identity change and its reset is not reused for the incoming identity', async t => {
  const pending = deferred();
  const h = peoplePage(t, { facts: () => ({ birthDate: '1980-06-15', birthPlace: 'Paris, France' }), server: () => pending.promise });
  await h.mount([1]);
  assert.equal(h.calls.length, 1);
  h.changeIdentity();
  pending.resolve({ people: { [person(1)]: { birthDate: '1950-01-01', birthPlace: 'Old Identity, Town' } } });
  await flush();

  h.navigate('next');
  await h.mount([1]);
  assert.equal(h.calls.length, 2, 'the incoming identity asks for itself');
  assert.notEqual(h.releaseAge(), '50y', "the previous identity's answer is not shown");
});

const MOVIE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** The item editor over the real layout, look and pipeline modules; the session moves by hand. */
function editorPage(t) {
  const writes = [], io = { user: 'user-a', epoch: 0 };
  const h = createHarness({
    html: '<div id="sheets"></div>',
    JE: {
      currentSettings: { tagLayoutSettingsVersion: 1, tagLayout: 'corners', qualityTagsEnabled: true, genreTagsEnabled: true },
      pluginConfig: {},
      t: key => key,
      escapeHtml: value => String(value),
      saveUserSettings: async (file, doc) => { writes.push(plain(doc)); },
      session: { onUserChange() {}, getEpoch: () => io.epoch, getUserId: () => io.user },
    },
    apiClient: {
      getCurrentUserId: () => io.user,
      serverId: () => 'server-a',
      getUrl: path => `http://jellyfin.test/${path.replace(/^\//, '')}`,
      getItem: async (user, id) => ({ Id: id, Name: 'Movie', Type: 'Movie' }),
      getCurrentUser: async () => ({ Policy: { IsAdministrator: false } }),
      getPluginConfiguration: async () => ({}),
      getScaledImageUrl: id => `http://jellyfin.test/Items/${id}/Images/Primary`,
      ajax: async ({ url, data }) => {
        if (new URL(url).pathname.includes('/tag-data/')) return { Items: JSON.parse(data).map(id => ({ Id: id, Type: 'Movie', LibraryId: 'library' })) };
        throw new Error(`unexpected ${url}`);
      },
    },
  });
  t.after(() => h.close());
  for (const file of ['core/ui-kit.js', 'core/dom-observer.js', 'core/tag-renderer-base.js', 'core/tag-layout.js', 'core/tag-look.js', 'tags/tag-pipeline.js', 'enhanced/settingspanel/ui-panel-tag-preview.js', 'tags/tag-item-editor.js']) h.load(file);
  h.JE.toast = () => {};
  const press = element => element.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const keep = () => {
    const box = h.document.querySelector('[data-tie-keep]');
    box.checked = true;
    box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  };
  return { ...h, io, writes, keep, save: () => press(h.document.querySelector('[data-tie-save]')) };
}

test('Save writes for the session that opened the editor', async t => {
  const h = editorPage(t);
  await h.JE.tagItemEditor.open(MOVIE);
  await flush();
  h.keep();
  h.save();
  await flush();
  assert.equal(h.writes.length, 1);
  assert.ok(h.writes[0].tagLayoutLocks[MOVIE], 'the look is kept for the item');
});

test('Save pressed after the session moved on writes nothing for the incoming user', async t => {
  const h = editorPage(t);
  await h.JE.tagItemEditor.open(MOVIE);
  await flush();
  h.keep();
  h.io.user = 'user-b';
  h.io.epoch++;
  h.save();
  await flush();
  assert.deepEqual(h.writes, [], 'the look the previous user edited stays out of the incoming settings');
});
