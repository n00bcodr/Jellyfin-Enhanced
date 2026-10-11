// Review round 5: a placeholder request's late answer (success, 409, quota 403) after a sign-out / user switch shows
// nothing to the next user and marks nothing as requested for them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ph, tick } from './lp-harness.mjs';

const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

/**
 * List placeholder modules with a Seerr POST the test settles by hand.
 * @returns {object}
 */
function mount(t, { api = {}, ui = {} } = {}) {
  const post = {}, events = [], quota = [];
  const h = setup(t, {
    jellyseerrAPI: {
      fetchMovieDetails: async id => ({ id, mediaInfo: { status: 1, status4k: 1 } }),
      requestMedia: () => new Promise((resolve, reject) => { post.resolve = resolve; post.reject = reject; }),
      ...api
    },
    jellyseerrUI: {
      showMovieRequestModal: async () => {},
      showSeasonSelectionModal: async () => {},
      isQuotaError: error => error?.status === 403 && error?.responseJSON?.code === 'quota',
      showQuotaErrorDialog: async (...args) => { quota.push(args); },
      ...ui
    }
  });
  h.document.addEventListener('jellyseerr-media-requested', e => events.push({ ...e.detail }));
  return { ...h, post, events, quota };
}

const answers = {
  success: post => post.resolve({ id: 1 }),
  conflict: post => post.reject(Object.assign(new Error('HTTP 409'), { status: 409, responseJSON: {} })),
  quota: post => post.reject(Object.assign(new Error('HTTP 403'), { status: 403, responseJSON: { code: 'quota', message: 'Movie Quota exceeded.' } }))
};

for (const is4k of [true, false]) {
  for (const [name, answer] of Object.entries(answers)) {
    test(`a ${name} answer after a user switch shows and marks nothing (4K ${is4k})`, async t => {
      const h = mount(t);
      const placeholder = ph('m', { tmdbId: 7, title: 'Secret A Title' });
      const flow = h.lp.requests.requestPlaceholder(placeholder, null, { is4k });
      await settle();
      assert.equal(typeof h.post.resolve, 'function', 'the POST is in flight');
      h.switchUser();
      answer(h.post);
      await flow;
      await settle();
      assert.deepEqual(h.toasts, []);
      assert.deepEqual(h.quota, []);
      assert.deepEqual(h.events, []);
      assert.equal(h.lp.requests.isRequested(placeholder), false);
    });
  }
}

test('a 409 answer without a user switch still announces the placeholder as requested', async t => {
  const h = mount(t);
  const placeholder = ph('m', { tmdbId: 7 });
  const flow = h.lp.requests.requestPlaceholder(placeholder, null);
  await settle();
  answers.conflict(h.post);
  await flow;
  assert.equal(h.events.length, 1);
});

for (const is4k of [true, false]) {
  test(`the advanced modal's late 409 after a user switch announces nothing (4K ${is4k})`, async t => {
    let already;
    const h = mount(t, {
      api: { shouldShowAdvanced: () => true },
      ui: { showMovieRequestModal: async (...args) => { already = args[4]?.onAlreadyRequested; } }
    });
    await h.lp.requests.requestPlaceholder(ph('m', { tmdbId: 7 }), null, { is4k });
    assert.equal(typeof already, 'function');
    h.switchUser();
    already();
    await settle();
    assert.deepEqual(h.events, []);
    assert.deepEqual(h.toasts, []);
  });
}
