import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, plain } from '../helpers/harness.mjs';

// The Requests page's Remove request button (upstream 6916b31b, #1050): shown from the server's canRemove flag,
// one confirmed non-retried DELETE, then a list refresh.

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

/**
 * The real data module with this account's list loaded (the two requests above), the plugin API and
 * Jellyfin's confirm dialog stubbed, and the page's button for request 5 in the document.
 * @param {{confirm?: boolean|((answer: (ok: boolean) => void) => void), fail?: unknown, title?: string}} [options]
 *   confirm: the dialog's answer, or a function that keeps the dialog open and gets its answer callback.
 */
async function data(t, { confirm = true, fail = null, title = 'Mine' } = {}) {
  const calls = [], toasts = [];
  let epoch = 0, changed = () => {};
  const h = createHarness({
    globals: { Dashboard: { confirm: (text, dialogTitle, cb) => { calls.push(['confirm', dialogTitle, text]); if (typeof confirm === 'function') confirm(cb); else cb(confirm); } } },
    JE: { pluginConfig: { JellyseerrEnabled: true }, t: () => undefined, escapeHtml: v => String(v), toast: (...a) => toasts.push(a),
      helpers: { clearAvatarObjectUrlCache() {}, hydrateAvatarImages() {} },
      session: { getEpoch: () => epoch, isCurrent: value => value === epoch, onUserChange: (_key, fn) => { changed = fn; } },
      core: { api: { plugin: async (url, options) => {
        calls.push([url, plain(options ?? {})]);
        if (fail && options?.method === 'DELETE') throw fail;
        return { requests: [{ ...own, title }, theirs], totalPages: 1, canApproveRequests: false };
      } } } },
    apiClient: { getUrl: path => path } });
  t.after(() => h.close());
  h.load('arr/requests/requests-page-data.js');
  const P = h.JE.internals.requestsPage;
  P.renderPage = () => {};
  await P.fetchRequests();
  calls.length = 0;
  const button = (id, buttonTitle) => {
    const el = h.document.createElement('button');
    el.dataset.requestId = id; el.dataset.requestTitle = buttonTitle;
    el.innerHTML = '<span class="material-icons">delete</span>';
    h.document.body.append(el);
    return el;
  };
  return { ...h, P, calls, toasts, button: button('5', title), other: button('6', 'Theirs'), switchUser() { epoch++; changed(); } };
}

test('a confirmed removal sends one DELETE without retry and refreshes the list', async t => {
  const h = await data(t);
  await h.P.handleRemoveRequest(h.button);
  assert.equal(h.calls[0][0], 'confirm');
  assert.match(h.calls[0][2], /Mine/);
  assert.deepEqual(h.calls[1], ['/arr/requests/5', { method: 'DELETE', skipRetry: true }]);
  assert.match(h.calls[2][0], /^\/arr\/requests\?/);
  assert.equal(h.calls.length, 3);
  assert.equal(h.toasts.length, 1);
});

test('a cancelled removal sends nothing', async t => {
  const h = await data(t, { confirm: false });
  await h.P.handleRemoveRequest(h.button);
  assert.equal(h.calls.length, 1);
  assert.equal(h.button.disabled, false);
});

test('a refused removal re-enables the button and tells the user', async t => {
  const h = await data(t, { fail: Object.assign(new Error('403'), { status: 403 }) });
  h.expectConsoleError(/Failed to remove request 5/);
  await h.P.handleRemoveRequest(h.button);
  assert.equal(h.button.disabled, false);
  assert.equal(h.button.querySelector('.material-icons').textContent, 'delete');
  assert.equal(h.toasts.length, 1);
  assert.equal(h.calls.filter(([url]) => url === '/arr/requests/5').length, 1, 'not retried');
});

test('a title with replacement patterns is shown as written in the confirmation', async t => {
  const h = await data(t, { title: "Cats $& Dogs $' $1" });
  await h.P.handleRemoveRequest(h.button);
  assert.ok(h.calls[0][2].includes("Cats $& Dogs $' $1"), h.calls[0][2]);
});

// The rewrite's rules for a request action: it acts only on what this account's list says, as Approve and Decline do.
test('a button for a request the list does not say the caller may remove asks nothing and sends nothing', async t => {
  const h = await data(t);
  await h.P.handleRemoveRequest(h.other);
  const stale = h.document.createElement('button');
  stale.dataset.requestId = '77';
  h.document.body.append(stale);
  await h.P.handleRemoveRequest(stale);
  assert.deepEqual(h.calls, []);
});

test('a sign-in change while the confirmation is open removes nothing for the new account', async t => {
  const answer = deferred();
  const h = await data(t, { confirm: cb => answer.promise.then(cb) });
  const run = h.P.handleRemoveRequest(h.button);
  h.switchUser();
  answer.resolve(true);
  await run;
  assert.deepEqual(h.calls.map(call => call[0]), ['confirm']);
  assert.equal(h.toasts.length, 0);
});

test('a second click while the removal is on its way does not send it again', async t => {
  const pending = deferred();
  const h = await data(t, { fail: null });
  const original = h.JE.core.api.plugin;
  h.JE.core.api.plugin = async (url, options) => (options?.method === 'DELETE' ? (h.calls.push([url, plain(options)]), pending.promise) : original(url, options));
  const first = h.P.handleRemoveRequest(h.button);
  await new Promise(resolve => setTimeout(resolve, 0));
  const again = h.document.createElement('button');
  again.dataset.requestId = '5';
  h.document.body.append(again);
  await h.P.handleRemoveRequest(again);
  pending.resolve({});
  await first;
  assert.equal(h.calls.filter(([url, options]) => url === '/arr/requests/5' && options?.method === 'DELETE').length, 1);
});
