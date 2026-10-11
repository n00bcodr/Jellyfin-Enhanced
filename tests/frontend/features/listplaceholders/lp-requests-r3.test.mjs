// Review round 3: "Request in 4K" checks Seerr's 4K status before offering a request (the advanced modal only
// reports a 409 as a failure), and request errors never show a raw locale key or hide Seerr's own reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, ph, tick } from './lp-harness.mjs';

const en = JSON.parse(readFileSync(new URL('../../../../Jellyfin.Plugin.JellyfinEnhanced/js/locales/en.json', import.meta.url), 'utf8'));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

/**
 * List placeholder modules with JE's real English strings; records modals, requests and announcements.
 * @returns {object}
 */
function mount(t, { api = {} } = {}) {
  const modals = [], requests = [], events = [];
  const h = setup(t, {
    jellyseerrAPI: { requestMedia: async (...args) => { requests.push(args); return { id: 1 }; }, ...api },
    jellyseerrUI: { showMovieRequestModal: async (...args) => { modals.push(args); }, showSeasonSelectionModal: async () => {} }
  });
  h.JE.t = (key, params) => Object.entries(params || {}).reduce((s, [k, v]) => s.replace(`{${k}}`, v), en[key] || key);
  h.document.addEventListener('jellyseerr-media-requested', e => events.push({ ...e.detail }));
  return { ...h, modals, requests, events };
}

for (const advanced of [true, false]) {
  test(`"Request in 4K" on a title Seerr already has in 4K announces it instead of requesting (advanced ${advanced})`, async t => {
    const h = mount(t, { api: { shouldShowAdvanced: () => advanced,
      fetchMovieDetails: async id => ({ id, mediaType: 'movie', mediaInfo: { status: 1, status4k: 2 } }) } });
    await h.lp.requests.requestPlaceholder(ph('m', { tmdbId: 7, title: 'Cars <4>' }), null, { is4k: true });
    await settle();
    assert.equal(h.modals.length, 0, 'no modal');
    assert.equal(h.requests.length, 0, 'no request');
    assert.deepEqual(h.events, [{ tmdbId: '7', mediaType: 'movie', is4k: true }]);
    assert.match(h.toasts.at(-1), /Cars &lt;4&gt;/);
  });
}

test('"Request in 4K" still opens the advanced modal (or requests) when Seerr has no 4K request yet', async t => {
  const advanced = mount(t, { api: { shouldShowAdvanced: () => true, fetchMovieDetails: async id => ({ id, mediaInfo: { status: 2, status4k: 1 } }) } });
  await advanced.lp.requests.requestPlaceholder(ph('m', { tmdbId: 7 }), null, { is4k: true });
  assert.equal(advanced.modals.length, 1);
  assert.equal(advanced.modals[0][3], true, 'the 4K modal');
  const simple = mount(t, { api: { fetchMovieDetails: async () => null } });
  await simple.lp.requests.requestPlaceholder(ph('m', { tmdbId: 7 }), null, { is4k: true });
  assert.equal(simple.requests.length, 1);
  assert.equal(simple.requests[0][3], true);
});

test('"Request in 4K" stops when the user changed while the details loaded', async t => {
  let h;
  h = mount(t, { api: { shouldShowAdvanced: () => true, fetchMovieDetails: async id => { h.switchUser(); return { id, mediaInfo: {} }; } } });
  await h.lp.requests.requestPlaceholder(ph('m', { tmdbId: 7 }), null, { is4k: true });
  assert.equal(h.modals.length, 0);
  assert.equal(h.requests.length, 0);
});

// The bodies JE's proxy really sends on a 403 (SeerrHttpHelper.ToResponseShape, the controller's own gates) and
// Seerr's own quota answer when the quota dialog is off.
for (const [label, body, expected] of [
  ['an upstream Seerr 403 (code Forbidden)', { error: true, code: 'Forbidden', httpStatus: 403, message: 'Seerr declined the request. Ask your administrator to check your account permissions.' }, 'Seerr declined the request. Ask your administrator to check your account permissions.'],
  ['a blocked user', { error: true, code: 'blocked', message: 'Your administrator has disabled Seerr for your account.' }, 'Your administrator has disabled Seerr for your account.'],
  ['a parental block', { error: true, code: 'parental_block', message: 'Blocked by parental controls.' }, 'Blocked by parental controls.'],
  ['JE\'s permission gate', { code: 'no_request_permission', message: 'You do not have permission to make requests in Seerr.' }, en.jellyseerr_err_no_request_permission],
  ['Seerr\'s quota message (quota dialog off)', { message: 'Movie Quota exceeded.' }, 'Movie Quota exceeded.'],
  ['a bare 403', {}, en.jellyseerr_err_no_request_permission]
]) {
  for (const is4k of [false, true]) {
    test(`a request error shows ${label} without a raw locale key (4K ${is4k})`, async t => {
      const h = mount(t, { api: { fetchMovieDetails: async id => ({ id, mediaInfo: { status: 1 } }),
        requestMedia: async () => { throw Object.assign(new Error('HTTP 403'), { status: 403, responseJSON: body }); } } });
      h.JE.jellyseerrUI.isQuotaError = () => false;
      await h.lp.requests.requestPlaceholder(ph('m', { tmdbId: 7 }), null, { is4k });
      assert.equal(h.toasts.at(-1), expected);
      assert.doesNotMatch(h.toasts.at(-1), /jellyseerr_err_/);
    });
  }
}
