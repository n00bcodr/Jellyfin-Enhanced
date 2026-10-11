// Review round 6: the season modal and the advanced movie modal opened for a list placeholder check the caller's
// session again when Request is pressed and when Seerr answers. An answer that arrives after a sign-out / user switch
// belongs to the user who opened the modal: the modal just closes (no toast, no "requested" event, no card update, no
// error or quota dialog).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred } from '../helpers/harness.mjs';

const tvSeasons = [{ seasonNumber: 1, episodeCount: 3, airDate: '2020-01-01' }, { seasonNumber: 2, episodeCount: 3, airDate: '2021-01-01' }];

/**
 * The real season / movie request modals over a stubbed modal shell and Seerr API whose POST the test settles.
 * @returns {object} Harness: toasts, events, errors (handleRequestError calls), marks, closes, post, epoch control.
 */
function modals(t, { partial = true } = {}) {
  const toasts = [], events = [], errors = [], marks = [];
  let post = null, current = null, closes = 0;
  const h = createHarness({ JE: {
    pluginConfig: {}, t: (key, args) => key + (args ? JSON.stringify(args) : ''),
    escapeHtml: value => String(value), toast: (...args) => toasts.push(args), helpers: { trackUsage() {} },
    session: { getEpoch: () => 0, isCurrent: value => value === 0, onUserChange() {} }
  } });
  t.after(() => h.close());
  for (const file of ['seerr-status.js', 'ui/ui-icons.js', 'ui/ui-quota.js', 'ui/ui-season-modal.js', 'ui/ui-request-modals.js']) h.load(`jellyseerr/${file}`);
  const pending = () => { post = deferred(); return post.promise; };
  h.JE.jellyseerrAPI = {
    shouldShowAdvanced: () => false, fetchRequestSettings: async () => ({ partialRequestsEnabled: partial, enableSpecialEpisodes: false }),
    fetchTvShowDetails: async () => ({ seasons: tvSeasons, externalIds: { tvdbId: 1 } }), fetchSonarrLookup: async () => [],
    fetchUserQuota: async () => null, fetchTvSeasonDetails: async () => ({}), fetchAdvancedRequestData: async () => ({}),
    requestTvSeasons: pending, requestMedia: pending
  };
  const internal = h.JE.internals.jellyseerrUi;
  internal.markCardRequested = (...args) => marks.push(args);
  internal.handleRequestError = async (...args) => { errors.push(args); };
  const values = { 'movie-server': 2, 'movie-quality': 5, 'movie-folder': '/movies' };
  const select = id => `<select id="${id}"><option value="${values[id]}" selected>x</option></select>`;
  h.JE.jellyseerrModal = {
    createAdvancedOptionsHTML: type => (type === 'movie' ? ['movie-server', 'movie-quality', 'movie-folder'].map(select).join('') : ''),
    populateAdvancedOptions() {},
    create(o) {
      const el = h.document.createElement('div');
      el.innerHTML = `<div class="jellyseerr-modal-body">${o.bodyHtml}</div>`;
      h.document.body.append(el);
      current = { el, o };
      return { modalElement: el, show() {} };
    }
  };
  for (const event of ['jellyseerr-media-requested', 'jellyseerr-tv-requested']) h.document.addEventListener(event, e => events.push(event));
  let epoch = 0;
  const opened = epoch;
  return {
    ...h, toasts, events, errors, marks,
    get post() { return post; },
    get closes() { return closes; },
    isCurrent: () => epoch === opened,
    switchUser() { epoch++; },
    save: () => current.o.onSave(current.el, h.document.createElement('button'), () => { closes++; })
  };
}

const answers = {
  success: post => post.resolve({ id: 1 }),
  conflict: post => post.reject(Object.assign(new Error('HTTP 409'), { status: 409, responseJSON: {} })),
  quota: post => post.reject(Object.assign(new Error('HTTP 403'), { status: 403, responseJSON: { code: 'quota' } }))
};

for (const partial of [true, false]) {
  for (const [name, answer] of Object.entries(answers)) {
    test(`season modal: a ${name} answer after a user switch shows and marks nothing (partial ${partial})`, async t => {
      const h = modals(t, { partial });
      await h.JE.jellyseerrUI.showSeasonSelectionModal(42, 'tv', 'Secret A Show', null, false, { preselectedSeasons: [1], treatExistingAsRequested: true, isCurrent: h.isCurrent });
      const saving = h.save();
      await Promise.resolve();
      assert.ok(h.post, 'the request is in flight');
      h.switchUser();
      answer(h.post);
      await saving;
      assert.deepEqual(h.toasts, []);
      assert.deepEqual(h.events, []);
      assert.deepEqual(h.marks, []);
      assert.deepEqual(h.errors, []);
      assert.equal(h.closes, 1);
    });
  }
}

test('season modal: Request pressed after a user switch sends nothing', async t => {
  const h = modals(t);
  await h.JE.jellyseerrUI.showSeasonSelectionModal(42, 'tv', 'Secret A Show', null, false, { preselectedSeasons: [1], isCurrent: h.isCurrent });
  h.switchUser();
  const saving = h.save();
  await Promise.resolve();
  const sent = h.post;
  sent?.resolve({ id: 1 });
  await saving;
  assert.equal(sent, null);
  assert.equal(h.closes, 1);
  assert.deepEqual(h.toasts, []);
});

test('season modal: without a user switch the answer is shown as before', async t => {
  const h = modals(t);
  await h.JE.jellyseerrUI.showSeasonSelectionModal(42, 'tv', 'Show', null, false, { preselectedSeasons: [1], isCurrent: h.isCurrent });
  const saving = h.save();
  await Promise.resolve();
  answers.success(h.post);
  await saving;
  assert.equal(h.toasts.length, 1);
  assert.deepEqual(h.events, ['jellyseerr-tv-requested', 'jellyseerr-media-requested']);
  assert.equal(h.marks.length, 1);
});

for (const [name, answer] of Object.entries(answers)) {
  test(`advanced movie modal: a ${name} answer after a user switch shows and marks nothing`, async t => {
    const h = modals(t);
    let already = 0;
    await h.JE.jellyseerrUI.showMovieRequestModal(7, 'Secret A Title', null, false, { onAlreadyRequested: () => { already++; }, isCurrent: h.isCurrent });
    const button = h.document.createElement('button');
    button.className = 'jellyseerr-request-button';
    button.dataset.tmdbId = '7';
    button.textContent = 'Request';
    h.document.body.append(button);
    const saving = h.save();
    await Promise.resolve();
    assert.ok(h.post, 'the request is in flight');
    h.switchUser();
    answer(h.post);
    await saving;
    assert.equal(already, 0);
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.toasts, []);
    assert.equal(button.textContent, 'Request');
    assert.equal(h.closes, 1);
  });
}
