// Review round 4: the advanced movie modal counts Seerr's 409 as requested for placeholders (the status pre-check
// can read cached details), and no request is sent after a user switch while Seerr's override rules load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ph, tick } from './lp-harness.mjs';

const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

/**
 * List placeholder modules; records modal calls, requests and announcements.
 * @returns {object}
 */
function mount(t, { api = {}, ui = {} } = {}) {
  const modals = [], requests = [], events = [];
  const h = setup(t, {
    jellyseerrAPI: { requestMedia: async (...args) => { requests.push(args); return { id: 1 }; }, ...api },
    jellyseerrUI: { showMovieRequestModal: async (...args) => { modals.push(args); }, showSeasonSelectionModal: async () => {}, ...ui }
  });
  h.document.addEventListener('jellyseerr-media-requested', e => events.push({ ...e.detail }));
  return { ...h, modals, requests, events };
}

for (const is4k of [true, false]) {
  test(`the advanced movie modal's 409 announces the placeholder as requested (4K ${is4k})`, async t => {
    const h = mount(t, {
      api: { shouldShowAdvanced: () => true, fetchMovieDetails: async id => ({ id, mediaInfo: { status: 1, status4k: 1 } }) },
      // Seerr answers 409 to the modal's request: the modal hands it to the caller.
      ui: { showMovieRequestModal: async (...args) => { args[4]?.onAlreadyRequested?.(); } }
    });
    await h.lp.requests.requestPlaceholder(ph('m', { tmdbId: 7, title: 'Cars' }), null, { is4k });
    await settle();
    assert.equal(h.requests.length, 0);
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].tmdbId, '7');
    assert.equal(h.events[0].is4k, is4k);
    assert.equal(h.toasts.some(text => text.startsWith('listPlaceholders_already_requested_4k')), is4k);
  });
}

for (const is4k of [true, false]) {
  test(`no request is sent when the user changes while the override rules load (4K ${is4k})`, async t => {
    let h;
    let release;
    h = mount(t, {
      api: {
        fetchMovieDetails: async id => ({ id, mediaInfo: { status: 1, status4k: 1 } }),
        evaluateOverrideRules: () => new Promise((resolve) => { release = resolve; })
      }
    });
    const flow = h.lp.requests.requestPlaceholder(ph('m', { tmdbId: 7 }), null, { is4k });
    await settle();
    assert.equal(typeof release, 'function', 'the rules are read before the request');
    h.switchUser();
    release(null);
    await flow;
    assert.equal(h.requests.length, 0);
    assert.equal(h.toasts.length, 0);
  });
}

test('override rule settings go into the request itself', async t => {
  const h = mount(t, {
    api: { fetchMovieDetails: async id => ({ id, mediaInfo: { status: 1 } }), evaluateOverrideRules: async () => ({ serverId: 3, profileId: 9 }) }
  });
  await h.lp.requests.requestPlaceholder(ph('m', { tmdbId: 7 }), null);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.requests[0].slice(0, 5))), [7, 'movie', { serverId: 3, profileId: 9 }, false, null]);
});
