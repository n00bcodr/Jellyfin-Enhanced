// Review round 6: the "Add to collection or playlist" picker and the Add title / Link modal belong to the user who
// opened them. A user switch closes them, and a click that still reaches their primary button sends nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, view, tick, LIST, COLLECTION } from './lp-harness.mjs';

const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };

function mount(t, { initialize }) {
  const posts = [];
  const h = setup(t, {
    plugin: async (path, options = {}) => {
      if (path === '/list-placeholders/editable-lists') return { playlists: [{ id: LIST, name: 'Private of A', isOwn: true }], collections: [{ id: COLLECTION, name: 'Cars' }], canManageCollections: true };
      posts.push(path);
      return { added: ['n'], addedAsItems: [], skipped: [], view: view() };
    },
    jellyseerrAPI: { search: async () => ({ results: [] }) }
  });
  h.load('jellyseerr/modal.js');
  if (initialize) h.JE.initializeListPlaceholders();
  return { h, posts };
}

const openers = {
  picker: h => h.lp.picker.openPicker({ item: { id: 151960, title: 'Planes', releaseDate: '2013-08-09' }, mediaType: 'movie' }),
  search: (h) => {
    const modal = h.lp.search.open({ listId: COLLECTION, listKind: 'collection', listName: 'Cars', view: view() });
    const root = modal.modalElement;
    root.querySelector('.je-lp-tab[data-tab="custom"]').click();
    root.querySelector('.je-lp-custom-title').value = 'Clayface';
    return modal;
  }
};

for (const [name, open] of Object.entries(openers)) {
  test(`R6: a user switch closes the ${name}; its primary button sends nothing`, async t => {
    const { h, posts } = mount(t, { initialize: true });
    const modal = await open(h);
    const root = modal.modalElement;
    modal.show?.();
    await settle();
    h.switchUser();
    assert.equal(root.classList.contains('show'), false);
    root.querySelector('.jellyseerr-modal-button-primary').click();
    await settle();
    assert.deepEqual(posts, []);
  });

  test(`R6: the ${name} sends nothing for a user who changed, even while it is still shown`, async t => {
    const { h, posts } = mount(t, { initialize: false });
    const modal = await open(h);
    modal.show?.();
    await settle();
    h.switchUser();
    modal.modalElement.querySelector('.jellyseerr-modal-button-primary').click();
    await settle();
    assert.deepEqual(posts, []);
    assert.deepEqual(h.toasts, []);
  });

  test(`R6: without a user switch the ${name} sends its add`, async t => {
    const { h, posts } = mount(t, { initialize: true });
    const modal = await open(h);
    modal.show?.();
    await settle();
    modal.modalElement.querySelector('.jellyseerr-modal-button-primary').click();
    await settle();
    assert.equal(posts.length, 1);
  });
}
