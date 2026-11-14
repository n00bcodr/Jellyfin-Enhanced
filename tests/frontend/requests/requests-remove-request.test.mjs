import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, plain } from '../helpers/harness.mjs';

/** Real card rendering and click wiring; the remove handler is recorded. */
function cards(t) {
  const removed = [];
  const state = { canApproveRequests: false, requestsFilter: 'all', requests: [], downloads: [], history: [], isLoading: false };
  const P = { state, clearAvatarObjectUrlCache() {}, hydrateAvatarImages() {}, hydrateExternalLinks() {},
    handleRequestAction() {}, handleRemoveRequest: button => removed.push(button.dataset.requestId) };
  const h = createHarness({ html: '<main id="je-downloads-container"></main>',
    JE: { pluginConfig: { JellyseerrEnabled: true, ShowDownloadsInRequests: false },
      internals: { requestsPage: P }, cdn: { selfhst: p => '/fixtures/' + p } } });
  t.after(() => h.close());
  h.load('core/ui-kit.js');
  h.JE.escapeHtml = h.JE.core.ui.escapeHtml;
  h.load('arr/requests/requests-page-render-helpers.js');
  h.load('arr/requests/requests-page-render-cards.js');
  h.load('arr/requests/requests-page-render.js');
  return { ...h, P, state, removed };
}

const own = { id: 5, title: 'Mine', type: 'movie', requestStatus: 2, mediaStatus: 'Approved', canRemove: true };
const theirs = { id: 6, title: 'Theirs', type: 'movie', requestStatus: 2, mediaStatus: 'Approved', canRemove: false };

test('the remove button shows only on requests the server says the caller may remove', t => {
  const h = cards(t);
  h.state.requests = [own, theirs]; h.P.renderPage();
  const buttons = [...h.document.querySelectorAll('.je-request-remove-btn')];
  assert.deepEqual(buttons.map(b => b.dataset.requestId), ['5']);
  assert.equal(buttons[0].dataset.requestTitle, 'Mine');
});

test('one click on the remove button dispatches one removal after rerenders', t => {
  const h = cards(t);
  h.state.requests = [own];
  for (let i = 0; i < 3; i++) h.P.renderPage();
  h.document.querySelector('.je-request-remove-btn .material-icons').click();
  assert.deepEqual(h.removed, ['5']);
});

/** The real data module, with the plugin API and Jellyfin's confirm dialog stubbed. */
function data(t, { confirm = true, fail = false } = {}) {
  const calls = [], toasts = [];
  const h = createHarness({
    globals: { Dashboard: { confirm: (text, title, cb) => { calls.push(['confirm', title, text]); cb(confirm); } } },
    JE: { t: () => undefined, escapeHtml: v => String(v), toast: (...a) => toasts.push(a),
      helpers: { clearAvatarObjectUrlCache() {}, hydrateAvatarImages() {} },
      core: { api: { plugin: async (url, options) => {
        calls.push([url, plain(options ?? {})]);
        if (fail && options?.method === 'DELETE') throw new Error('403');
        return { requests: [], totalPages: 1, canApproveRequests: false };
      } } } } });
  t.after(() => h.close());
  h.load('arr/requests/requests-page-data.js');
  const P = h.JE.internals.requestsPage;
  P.renderPage = () => {};
  const button = h.document.createElement('button');
  button.dataset.requestId = '5'; button.dataset.requestTitle = 'Mine';
  button.innerHTML = '<span class="material-icons">delete</span>';
  return { ...h, P, calls, toasts, button };
}

test('a confirmed removal sends one DELETE without retry and refreshes the list', async t => {
  const h = data(t);
  await h.P.handleRemoveRequest(h.button);
  assert.equal(h.calls[0][0], 'confirm');
  assert.match(h.calls[0][2], /Mine/);
  assert.deepEqual(h.calls[1], ['/arr/requests/5', { method: 'DELETE', skipRetry: true }]);
  assert.match(h.calls[2][0], /^\/arr\/requests\?/);
  assert.equal(h.toasts.length, 1);
});

test('a cancelled removal sends nothing', async t => {
  const h = data(t, { confirm: false });
  await h.P.handleRemoveRequest(h.button);
  assert.equal(h.calls.length, 1);
  assert.equal(h.button.disabled, false);
});

test('a refused removal re-enables the button and tells the user', async t => {
  const h = data(t, { fail: true });
  h.expectConsoleError(/Failed to remove request 5/);
  await h.P.handleRemoveRequest(h.button);
  assert.equal(h.button.disabled, false);
  assert.equal(h.button.querySelector('.material-icons').textContent, 'delete');
  assert.equal(h.toasts.length, 1);
});

test('a title with replacement patterns is shown as written in the confirmation', async t => {
  const h = data(t);
  h.button.dataset.requestTitle = "Cats $& Dogs $' $1";
  await h.P.handleRemoveRequest(h.button);
  assert.ok(h.calls[0][2].includes("Cats $& Dogs $' $1"), h.calls[0][2]);
});
