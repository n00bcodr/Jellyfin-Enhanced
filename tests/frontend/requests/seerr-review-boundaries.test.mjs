import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, plain } from '../helpers/harness.mjs';
const flush = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { await flush(); await flush(); };
// jsdom runs history.back() as chained zero-delay tasks (traverse, then fire popstate), and a popstate handler can
// start another. A starved event loop runs a fixed wait's timer between two links of that chain. So a wait first runs
// every zero-delay task already queued and those they queue (Node runs equal-delay timers in order), then waits the
// fixed time, then drains again. It never waits less than before.
const drain = async h => { for (let i = 0; i < 20; i++) await new Promise(resolve => h.window.setTimeout(resolve, 0)); };
const wait = async (h, ms = 30) => { await drain(h); await new Promise(resolve => h.window.setTimeout(resolve, ms)); await drain(h); };
function setup(t, files = [], options = {}) {
    let user = 'a', epoch = 0;
    const resets = [], posts = [], dialogs = [], advanced = [];
    const h = createHarness({ apiClient: { getCurrentUserId: () => user }, JE: {
        escapeHtml: value => String(value ?? ''), t: key => key, pluginConfig: { JellyseerrEnabled: true, ...options.config },
        toast() {}, session: { getEpoch: () => epoch, isCurrent: e => e === epoch, onUserChange: (name, fn) => resets.push(fn) },
        core: { api: { fetch: options.get || (async () => ({})), plugin: async (path, request) => {
            posts.push(plain(request.body)); return { id: 1 };
        } }, ui: { isTvLayout: () => false } },
        helpers: { trackUsage() {} }, cdn: { url: () => '', selfhst: () => '' }
    } });
    t.after(() => h.close());
    h.window.Dashboard = { alert: value => dialogs.push(value) };
    for (const file of [...new Set(['seerr-status.js', 'api.js', 'ui/ui-icons.js', ...files])]) h.load('jellyseerr/' + file);
    Object.assign(h.JE.jellyseerrUI, {
        showMovieRequestModal: (...args) => advanced.push(args),
        showSeasonSelectionModal: (...args) => advanced.push(args)
    });
    return { ...h, posts, dialogs, advanced, switchUser(silent = false) {
        user = 'b';
        if (!silent) { epoch++; for (const fn of resets) fn(); }
    } };
}
for (const mode of ['user', 'token', 'root', 'client']) {
    for (const advancedMode of [false, true]) test('SRC-R1-001: old movie button rejects silent ' + mode + ' replacement, advanced=' + advancedMode, async t => {
        const h = setup(t, ['ui/ui-buttons.js'], { config: { JellyseerrShowAdvanced: advancedMode }, get: async () => ({active:true,userFound:true,canRequestAdvanced:true}) });
        await h.JE.jellyseerrAPI.checkUserStatus();
        const button = h.document.createElement('button'); h.document.body.append(button);
        h.JE.jellyseerrUI.configureRequestButton(button, { id: 42, mediaType: 'movie', title: 'A' }, true, true);
        if (mode === 'user') h.switchUser(true);
        if (mode === 'token') h.window.ApiClient.accessToken = () => 'new-token';
        if (mode === 'root') h.window.ApiClient.getUrl = path => 'http://other.test' + path;
        if (mode === 'client') h.window.ApiClient = { ...h.window.ApiClient };
        button.click(); await settle();
        assert.equal(h.posts.length, 0); assert.equal(h.advanced.length, 0);
    });
}
test('SRC-R1-002: a delayed quota rejection does not present the previous account message', async t => {
    const pending = deferred();
    const h = setup(t, ['ui/ui-quota.js'], { get: () => pending.promise });
    const work = h.JE.jellyseerrUI.showQuotaErrorDialog({ status: 403, responseJSON: { message: 'private A quota' } }, 'movie');
    h.switchUser(); pending.reject(Object.assign(new Error('changed'), { name: 'AbortError' }));
    await work;
    assert.deepEqual(h.dialogs, []);
});
for (const [status, body, expected] of [
    [502, { code: 'unreachable' }, 'uncertain'],
    [502, { code: 'HtmlResponse', httpStatus: 200 }, 'uncertain'],
    [502, { requestOutcome: 'unknown' }, 'uncertain'],
    [502, { requestOutcome: 'not_sent' }, 'not-sent'],
    [503, { requestOutcome: 'rejected' }, 'rejected'],
    [403, { message: 'Movie Quota exceeded.' }, 'rejected']
]) test('SEERR-CORE-06: real core transport classifies HTTP ' + status + ' ' + JSON.stringify(body), async t => {
    let sends = 0;
    const h = createHarness({ JE: { t: key => key, pluginConfig: { JellyseerrEnabled: true } }, fetch: async () => {
        sends++; return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    } });
    t.after(() => h.close());
    for (const file of ['core/navigation.js', 'core/session.js', 'core/api-client.js', 'jellyseerr/api.js']) h.load(file);
    await assert.rejects(h.JE.jellyseerrAPI.requestMedia(42, 'movie'));
    assert.equal(sends, 1);
    const actual = h.JE.internals.jellyseerrUi.outcomes.at(-1).kind;
    assert.equal(actual, expected);
});
function seasons(h, mediaStatus, requestStatus, is4k = false) {
    const list = h.document.createElement('div');
    h.document.body.append(list);
    h.JE.internals.jellyseerrUi.updateSeasonList(list, {
        seasons: [{ seasonNumber: 1, episodeCount: 10 }],
        mediaInfo: { jellyfinMediaId: 'series', jellyfinMediaId4k: 'series',
            seasons: [{ seasonNumber: 1, status: mediaStatus, status4k: mediaStatus }],
            requests: [{ is4k, seasons: [{ seasonNumber: 1, status: requestStatus }] }] }
    }, true, false, is4k, null);
    return list;
}
for (const mode of [false, true]) for (const [media, request, label, disabled] of [
    [1, 1, 'requested', true], [1, 2, 'requested', true],
    [1, 3, 'not_requested', false], [1, 4, 'not_requested', false],
    [5, 1, 'available', true], [7, 5, 'not_requested', false]
]) test('SEERR-CORE-21: media ' + media + ' request ' + request + ' 4K=' + mode, t => {
    const h = setup(t, ['ui/ui-season-modal.js']); const list = seasons(h, media, request, mode);
    assert.equal(list.querySelector('.jellyseerr-season-item .jellyseerr-season-checkbox').disabled, disabled);
    assert.match(list.textContent, new RegExp('jellyseerr_season_status_' + label));
});
test('SRC-R1-003: refreshed pending selection is cleared and cannot submit', async t => {
    const details = { seasons: [{ seasonNumber: 1, episodeCount: 10, airDate: '2020-01-01' }],
        externalIds: { tvdbId: 123 }, mediaInfo: { jellyfinMediaId: 'series', seasons: [{ seasonNumber: 1, status: 1 }] } };
    const h = setup(t, ['modal.js', 'ui/ui-results.js', 'ui/ui-quota.js'], {
        get: async url => url.endsWith('/settings/partial-requests') ? { partialRequestsEnabled: true } : url.includes('/tv/') ? details : {}
    });
    // Install after setup so the production season-modal entry owns the public method.
    h.load('jellyseerr/ui/ui-season-modal.js');
    await h.JE.jellyseerrUI.showSeasonSelectionModal(42, 'tv', 'Show');
    const list = h.document.querySelector('.jellyseerr-season-list');
    list.querySelector('.jellyseerr-season-item .jellyseerr-season-checkbox').checked = true;
    details.mediaInfo.seasons[0].status = 2;
    h.JE.internals.jellyseerrUi.updateSeasonList(list, details, true, false, false, null);
    assert.equal(list.querySelector('.jellyseerr-season-item .jellyseerr-season-checkbox').checked, false);
    assert.equal(list.querySelector('.jellyseerr-season-item .jellyseerr-season-checkbox').disabled, true);
    h.document.querySelector('.jellyseerr-modal-button-primary').click(); await settle();
    assert.deepEqual(h.posts, []);
});
function modal(h, onClose = () => {}) {
    return h.JE.jellyseerrModal.create({ title: 'T', subtitle: 'S', bodyHtml: '', onSave: (_element, _button, close) => close(), onClose });
}
test('SEERR-CORE-22: Request consumes its history entry and preserves host state', async t => {
    const h = setup(t, ['modal.js']); const original = { hostRoute: 'home' };
    h.window.history.replaceState(original, '', h.window.location.href);
    const m = modal(h); m.show();
    m.modalElement.querySelector('.jellyseerr-modal-button-primary').click(); await wait(h);
    assert.deepEqual(plain(h.window.history.state), original);
    assert.equal(m.modalElement.getAttribute('aria-hidden'), 'true');
});
test('SEERR-CORE-22: repeated close restores history once', async t => {
    const h = setup(t, ['modal.js']);
    h.window.history.replaceState({ index: 0 }, '', '#/start'); h.window.history.pushState({ index: 1 }, '', '#/home');
    const m = modal(h); m.show(); m.close(); m.close(); await wait(h);
    assert.deepEqual(plain(h.window.history.state), { index: 1 });
});
test('SEERR-CORE-22: disposing after host navigation never goes Back', async t => {
    const h = setup(t, ['modal.js']); const m = modal(h); m.show();
    h.window.history.pushState({ route: 'next' }, '', '#/next'); m.close(); await wait(h);
    assert.equal(h.window.location.hash, '#/next'); assert.deepEqual(plain(h.window.history.state), { route: 'next' });
});
test('SEERR-CORE-22: nested modal close leaves parent active and next close returns to host', async t => {
    const h = setup(t, ['modal.js']); h.window.history.replaceState({ route: 'host' }, '', h.window.location.href);
    const outer = modal(h); outer.show(); const inner = modal(h); inner.show();
    inner.close(); await wait(h);
    assert.equal(outer.modalElement.getAttribute('aria-hidden'), null);
    assert.equal(h.document.body.classList.contains('jellyseerr-modal-is-open'), true);
    outer.close(); await wait(h); assert.deepEqual(plain(h.window.history.state), { route: 'host' });
});
test('SEERR-CORE-22: closing parent while nested modal is open leaves no dead parent entry', async t => {
    const h = setup(t, ['modal.js']); h.window.history.replaceState({ route: 'host' }, '', h.window.location.href);
    const outer = modal(h); outer.show(); const inner = modal(h); inner.show();
    outer.close(); inner.close(); await wait(h, 60);
    assert.deepEqual(plain(h.window.history.state), { route: 'host' });
});

test('SRC-R1-001: warm real request cache cannot adopt the next account credentials', async t => {
    let user = 'a'; const writes = [];
    const h = createHarness({ apiClient: { getCurrentUserId: () => user, accessToken: () => 'token-' + user },
        JE: { t: key => key, pluginConfig: { JellyseerrEnabled: true } }, fetch: async (url, options) => {
            if (options.method === 'GET') return new Response('[]', { status: 200 });
            writes.push(options); return new Response('{"id":7}', { status: 200 });
        } });
    t.after(() => h.close());
    for (const file of ['core/navigation.js', 'core/session.js', 'core/api-client.js', 'jellyseerr/api.js', 'jellyseerr/ui/ui-buttons.js']) h.load(file);
    await h.JE.jellyseerrAPI.fetchOverrideRules();
    const button = h.document.createElement('button'); h.document.body.append(button);
    h.JE.jellyseerrUI.configureRequestButton(button, { id: 42, mediaType: 'movie', title: 'A' }, true, true);
    user = 'b'; button.click(); await settle(); assert.equal(writes.length, 0);
});
