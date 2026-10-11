// Review round 6: the advanced movie modal a placeholder opens gets the click's session check (isCurrent), so its
// late answers after a sign-out / user switch stay silent (the modal itself is covered in requests/request-modals-r6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ph } from './lp-harness.mjs';

for (const is4k of [true, false]) {
  test(`the advanced movie modal gets the click's session check (4K ${is4k})`, async t => {
    let options;
    const h = setup(t, {
      jellyseerrAPI: { shouldShowAdvanced: () => true, fetchMovieDetails: async id => ({ id, mediaInfo: { status: 1, status4k: 1 } }) },
      jellyseerrUI: { showMovieRequestModal: async (...args) => { options = args[4]; }, showSeasonSelectionModal: async () => {} }
    });
    await h.lp.requests.requestPlaceholder(ph('m', { tmdbId: 7 }), null, { is4k });
    assert.equal(typeof options?.isCurrent, 'function');
    assert.equal(options.isCurrent(), true);
    h.switchUser();
    assert.equal(options.isCurrent(), false);
  });
}
