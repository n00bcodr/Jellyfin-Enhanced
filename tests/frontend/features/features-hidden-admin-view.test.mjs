import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';

// Stage 1 fix round 12 (P32): an administrator's unhide for a viewed user changes the page (the cached list, the user's
// count, the cards) only in the view it was made in. Before, its late answer pruned whichever user was viewed by then:
// the administrator unhid "k1" for Ann, switched to Ben (whose list also had "k1") and Ben's row disappeared and his count
// dropped, though nothing of his was changed.

function rig(t) {
  const sent = [];
  const answer = deferred();
  const h = createHarness({ JE: { t: key => key, toast() {} } });
  h.allowConsoleError(/./);
  t.after(() => h.close());
  h.load('core/mutation-queue.js');
  h.load('enhanced/hiddencontent/hidden-content-page-state.js');
  const page = h.JE.internals.hiddenContentPage;
  page.renderPage = () => {};
  h.JE.hiddenContent = {
    adminUnhideForUser: (uid, keys) => { sent.push({ uid, keys }); return answer.promise; },
    unhideItem: () => {}
  };
  h.load('enhanced/hiddencontent/hidden-content-page-admin.js');
  const { state } = page;
  Object.assign(state, {
    adminEditMode: true,
    selectedAdminUserId: 'ann',
    adminItems: [{ _key: 'k1' }, { _key: 'k2' }],
    adminUsers: [{ userId: 'ann', count: 2 }, { userId: 'ben', count: 1 }]
  });
  return { h, page, state, sent, answer };
}

test('an unhide answered after the administrator viewed another user leaves that user\'s list and count alone', async t => {
  const { page, state, sent, answer } = rig(t);
  // The click, in Ann's view (its scope taken at the click).
  page.handleUnhide('k1', page.adminActionScope?.());
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ uid: 'ann', keys: ['k1'] }]);
  // Ben is viewed now: his own list (which also has k1) and a new load.
  state.selectedAdminUserId = 'ben';
  state.adminItems = [{ _key: 'k1' }];
  state.adminLoadToken++;
  answer.resolve(true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(state.adminItems.map(i => i._key), ['k1'], 'Ben\'s row stays');
  assert.equal(state.adminUsers.find(u => u.userId === 'ben').count, 1);
  assert.equal(state.adminUsers.find(u => u.userId === 'ann').count, 2, 'the cached count is not guessed from another view either');
});

test('control: an unhide answered in its own view prunes that user\'s list and count', async t => {
  const { page, state, answer } = rig(t);
  page.handleUnhide('k1', page.adminActionScope?.());
  answer.resolve(true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(state.adminItems.map(i => i._key), ['k2']);
  assert.equal(state.adminUsers.find(u => u.userId === 'ann').count, 1);
});
