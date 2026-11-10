import { spoilerState as stateFixture } from '../../helpers/spoiler-state.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, plain } from '../../helpers/harness.mjs';

const entries = ['ids', 'state', 'image-refresh', 'snooze', 'dialog', 'identity', 'styles', 'settings-tab', 'seerr-toggle', 'detail-button', 'watched-refresh', 'index'];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function setup(t, plugin = async () => stateFixture(), options = {}) {
    const auth = { user: 'alice', server: 'one', fail: false };
    const calls = [], toasts = [], invalidations = [];
    const h = createHarness({ html: '<div id="itemDetailPage"><h1 class="itemName">Title</h1><div class="detailButtons"><button class="btnMoreCommands"></button></div></div>',
        JE: { pluginConfig: { SpoilerBlurEnabled: true }, t: key => key, icon: () => '', IconName: { BLUR_ON: 'blur_on' }, toast: text => toasts.push(text),
            core: { api: { plugin(path, opts) { calls.push({ path, opts, user: auth.user, server: auth.server }); return plugin(path, opts); }, manager: { clearCacheMatching: key => invalidations.push(key) } }, ui: { injectCss() {} } } },
        apiClient: { getCurrentUserId: () => auth.user, serverId: () => auth.server,
            setAuthenticationInfo(_token, user) { if (auth.fail) throw new Error('credential failure'); auth.user = user; } },
        ...options });
    t.after(() => h.close());
    for (const entry of ['navigation', 'session', 'lifecycle']) h.load(`core/${entry}.js`);
    for (const entry of entries) h.load(`enhanced/spoilerguard/${entry}.js`);
    return { ...h, auth, calls, toasts, invalidations, sg: h.JE.internals.spoilerGuard,
        change(user = 'bob') { h.window.ApiClient.setAuthenticationInfo('test-token', user); },
        server(server = 'two') { auth.server = server; h.JE.session.checkNow('test-server'); } };
}

test('all ordered emitted entries share the same state owner and retain the public facade', async t => {
    const h = setup(t, async path => path === '/spoiler-blur/series' ? stateFixture({ Series: { 'AA-BB': {} } }) : {});
    await h.sg.whenLoaded();
    assert.equal(h.JE.spoilerBlur.isEnabledFor('aabb'), true);
    await h.sg.disableForSeries('aabb');
    assert.equal(h.JE.spoilerBlur.isEnabledFor('aabb'), false);
    h.JE.spoilerBlur.init();
    assert.equal(h.calls.filter(call => call.path === '/spoiler-blur/series').length, 1);
});

for (const payload of [null, [], stateFixture({ Series: [] }), stateFixture({ Prefs: { HideRatings: 'false' } }), stateFixture({ Movies: { aa: null } })]) {
    test(`untrusted state fails closed: ${JSON.stringify(payload)}`, async t => {
        const h = setup(t, async () => payload);
        h.expectConsoleError(/state load failed/);
        await h.sg.whenLoaded();
        assert.equal(h.sg.isLoaded(), true);
        assert.equal(h.sg.isLoadOk(), false);
        h.sg.addSpoilerBlurButton('aa', h.document.querySelector('#itemDetailPage'), 'Movie');
        assert.equal(h.document.querySelector('.je-spoiler-blur-btn'), null);
    });
}

test('failed old-account response cannot settle or expose the new account state', async t => {
    const first = deferred(), second = deferred(); let loads = 0;
    const h = setup(t, () => ++loads === 1 ? first.promise : second.promise);
    const old = h.sg.whenLoaded();
    h.change();
    assert.equal(h.calls[0].opts.signal.aborted, true);
    const next = h.sg.whenLoaded();
    first.reject(new Error('old account denied'));
    await old;
    assert.equal(h.sg.isLoaded(), false);
    second.resolve(stateFixture({ Movies: { bb: {} } })); await next;
    assert.equal(h.sg.isMovieEnabledFor('bb'), true);
    assert.equal(h.sg.isLoadOk(), true);
});

test('server switch cancels mutation effects and guarded cache invalidation', async t => {
    const response = deferred();
    const h = setup(t, async (_path, opts) => opts?.method ? response.promise : stateFixture());
    await h.sg.whenLoaded();
    const write = h.sg.enableForMovie('aa');
    h.server(); response.resolve({}); await write;
    assert.equal(h.sg.isMovieEnabledFor('aa'), false);
    assert.deepEqual(h.invalidations, []);
    assert.equal(h.calls.at(-1).opts.signal.aborted, true);
});

test('failed authentication resets state and restores only the actual identity cookie', async t => {
    const h = setup(t, async () => stateFixture({ Series: { aa: {} } })); await h.sg.whenLoaded();
    h.auth.fail = true;
    assert.throws(() => h.change(), /credential failure/);
    assert.equal(h.JE.session.getUserId(), 'alice');
    assert.match(h.document.cookie, /je-spoiler-uid=alice/);
    assert.equal(h.sg.isLoaded(), false);
    assert.equal(h.sg.hasAnyState(), false);
    await h.sg.whenLoaded(); assert.equal(h.sg.isEnabledFor('aa'), true);
});

for (const cancel of ['identity', 'navigation']) {
    test(`open confirmation cancels on ${cancel} and a late callback cannot snooze or write`, async t => {
        const h = setup(t); await h.sg.whenLoaded();
        let finish;
        h.window.Dashboard = { confirm(html, _title, callback) { h.document.body.insertAdjacentHTML('beforeend', html); finish = callback; } };
        const pending = h.sg.confirmDisableSpoiler(); await tick();
        const box = h.document.querySelector('input[type=checkbox]'); box.checked = true;
        box.dispatchEvent(new h.window.Event('change', { bubbles: true }));
        if (cancel === 'identity') h.change(); else h.JE.core.lifecycle.get('spoiler-guard-dialog').teardown();
        assert.equal(await pending, false);
        finish(true);
        assert.equal(h.window.localStorage.length, 0);
        assert.equal(h.calls.filter(call => call.opts?.method).length, 0);
    });
}

test('detail confirmation cannot disable an old title as the next user', async t => {
    const h = setup(t, async () => stateFixture({ Series: { aa: {} } })); await h.sg.whenLoaded();
    let finish; h.window.Dashboard = { confirm(_html, _title, callback) { finish = callback; } };
    h.sg.addSpoilerBlurButton('aa', h.document.querySelector('#itemDetailPage'), 'Series');
    h.document.querySelector('.je-spoiler-blur-btn').click(); await tick();
    h.change(); finish(true); await tick();
    assert.equal(h.calls.filter(call => call.opts?.method).length, 0);
    assert.equal(h.document.querySelector('.je-spoiler-blur-btn'), null);
});

test('settings waiting for state never write on a switched identity; rebinding has one listener', async t => {
    const pending = deferred();
    const h = setup(t, () => pending.promise);
    const ctx = { presetBoxBackground: 'black', toggleAccentColor: 'white', help: h.document.body, resetAutoCloseTimer() {} };
    h.document.body.innerHTML = h.sg.buildSettingsHtml(ctx);
    h.sg.wireSettings(ctx); h.sg.wireSettings(ctx);
    const box = h.document.querySelector('#sbPrefHideRatings'); box.checked = false;
    box.dispatchEvent(new h.window.Event('change')); h.change();
    pending.resolve(stateFixture()); await tick();
    assert.equal(h.calls.filter(call => call.opts?.method).length, 0);
    h.JE.core.api.plugin = async (path, opts) => { h.calls.push({ path, opts }); return opts?.method ? {} : stateFixture(); };
    await h.sg.whenLoaded(); h.sg.wireSettings(ctx); h.sg.wireSettings(ctx); await tick();
    box.checked = false; box.dispatchEvent(new h.window.Event('change')); await tick();
    assert.equal(h.calls.filter(call => call.opts?.method).length, 1);
});

test('settings keep the server-returned canonical preferences', async t => {
    const h = setup(t, async (_path, opts) => opts?.method ? { prefs: { HideRatings: null, HideReviews: false } } : stateFixture());
    await h.sg.whenLoaded(); await h.sg.setUserPrefs({ HideRatings: false });
    assert.deepEqual(plain(h.sg.getUserPrefs()), { HideRatings: null, HideReviews: false });
});

test('Seerr pending enable has no stale toast or modal refresh after a user switch', async t => {
    const response = deferred(); const opened = [];
    const h = setup(t, async (_path, opts) => opts?.method ? response.promise : stateFixture()); await h.sg.whenLoaded();
    h.JE.jellyseerrMoreInfo = { open: (...args) => opened.push(args) };
    const modal = h.document.createElement('div'); modal.className = 'je-more-info-modal';
    const button = h.sg.buildSeerrToggle({ id: 42 }, 'tv'); modal.append(button); h.document.body.append(modal);
    button.click(); await tick(); h.change(); response.resolve({ promoted: 'pending' }); await tick();
    assert.deepEqual(h.toasts, []); assert.deepEqual(opened, []);
    assert.equal(button.disabled, true); assert.equal(h.sg.hasAnyState(), false);
});

test('malformed Seerr provider fields never reach write routes', async t => {
    const h = setup(t); await h.sg.whenLoaded();
    for (const data of [{ id: 42, jeSpoilerGuardItems: ['aa', {}] }, { id: {}, jeSpoilerGuard: true }, { id: 42, jeSpoilerGuardInherited: 'false' }]) {
        assert.throws(() => h.sg.buildSeerrToggle(data, 'movie'), /Invalid/);
    }
    assert.equal(h.calls.filter(call => call.opts?.method).length, 0);
});

test('snooze migrates its old deadline once and is isolated by server', async t => {
    const h = setup(t); await h.sg.whenLoaded();
    h.window.Date.now = () => 1000;
    h.window.localStorage.setItem('je-spoiler-disable-snooze:alice', '2000');
    assert.equal(h.sg.isDisableSnoozed(), true);
    h.server(); assert.equal(h.sg.isDisableSnoozed(), false);
    h.server('one'); assert.equal(h.sg.isDisableSnoozed(), true);
    h.window.Date.now = () => 2000; assert.equal(h.sg.isDisableSnoozed(), false);
});

test('watched fetch responses and scheduled refreshes are cancelled by identity changes', async t => {
    const response = deferred();
    const h = setup(t, async () => stateFixture({ Series: { aa: {} } }), { fetch: () => response.promise });
    await h.sg.whenLoaded(); let refreshed = 0;
    h.sg.refreshSpoilerableImages = () => refreshed++;
    const request = h.window.fetch('/UserPlayedItems/aa', { method: 'POST' });
    h.change(); response.resolve({ ok: true }); await request;
    await new Promise(resolve => setTimeout(resolve, 240));
    assert.equal(refreshed, 0);
});

test('watched installation restores host hooks on teardown and reinitializes once', async t => {
    const h = setup(t); await h.sg.whenLoaded();
    const wrapped = h.window.fetch;
    h.JE.core.lifecycle.teardownAll();
    assert.notEqual(h.window.fetch, wrapped);
    const original = h.window.fetch;
    h.JE.spoilerBlur.init();
    assert.notEqual(h.window.fetch, original);
    const installed = h.window.fetch; h.JE.spoilerBlur.init(); assert.equal(h.window.fetch, installed);
});

test('real pending response null Jellyfin IDs preserve pending enable and disable', async t => {
    const h = setup(t, async (_path, opts) => opts?.method === 'POST'
        ? { success: true, promoted: 'pending', jellyfinId: null, name: 'Title' }
        : opts?.method === 'DELETE' ? { success: true, removed: true, removedFrom: 'pending', jellyfinId: null } : stateFixture());
    await h.sg.whenLoaded();
    await h.sg.enableForTmdb('tv', 42); assert.equal(h.sg.isTmdbPending('tv', 42), true);
    await h.sg.disableForTmdb('tv', 42); assert.equal(h.sg.isTmdbPending('tv', 42), false);
});

test('malformed promotion does not add a pending or promoted policy entry', async t => {
    const h = setup(t, async (_path, opts) => opts?.method ? { promoted: 'movie', jellyfinId: null } : stateFixture());
    await h.sg.whenLoaded();
    await assert.rejects(h.sg.enableForTmdb('movie', 42), /Missing promoted/);
    assert.equal(h.sg.hasAnyState(), false);
});

test('movie scope fails closed while loading and rejects unavailable or stale policy', async t => {
    const pending = deferred();
    const h = setup(t, () => pending.promise);
    h.expectConsoleError(/state load failed/);
    const scope = h.sg.isMovieInScope('aa');
    pending.reject(new Error('offline'));
    await assert.rejects(scope, /state unavailable/);
    assert.equal(await h.sg.confirmDisableSpoiler(), false);
});

test('teardown invalidates delayed state success even when the transport ignores abort', async t => {
    const pending = deferred(); const h = setup(t, () => pending.promise);
    const load = h.sg.whenLoaded(); h.JE.core.lifecycle.teardownAll();
    pending.resolve(stateFixture({ Series: { aa: {} } })); await load;
    assert.equal(h.sg.isLoaded(), false); assert.equal(h.sg.hasAnyState(), false);
});

test('watched refresh timer is cancelled on navigation and XHR hooks restore cleanly', async t => {
    const h = setup(t, async () => stateFixture({ Series: { aa: {} } }), { fetch: async () => ({ ok: true }) });
    await h.sg.whenLoaded(); let refreshed = 0; h.sg.refreshSpoilerableImages = () => refreshed++;
    await h.window.fetch('/UserPlayedItems/aa', { method: 'DELETE' }); await tick();
    h.JE.core.lifecycle.get('spoiler-guard-watched').teardown();
    await new Promise(resolve => setTimeout(resolve, 240)); assert.equal(refreshed, 0);
    const open = h.window.XMLHttpRequest.prototype.open;
    h.JE.core.lifecycle.teardownAll(); assert.notEqual(h.window.XMLHttpRequest.prototype.open, open);
});

test('closing settings cancels a pending save and releases checkbox listeners', async t => {
    const pending = deferred(); const h = setup(t, () => pending.promise); let close;
    const panel = h.document.createElement('div'); h.document.body.append(panel);
    const ctx = { presetBoxBackground: 'black', toggleAccentColor: 'white', help: panel, resetAutoCloseTimer() {}, onClose(fn) { close = fn; } };
    panel.innerHTML = h.sg.buildSettingsHtml(ctx); h.sg.wireSettings(ctx);
    const box = panel.querySelector('#sbPrefHideRatings'); box.checked = false;
    box.dispatchEvent(new h.window.Event('change')); close(); panel.remove();
    pending.resolve(stateFixture()); await tick();
    box.dispatchEvent(new h.window.Event('change')); await tick();
    assert.equal(h.calls.filter(call => call.opts?.method).length, 0);
});

test('closing Seerr during disable confirmation cancels the mutation', async t => {
    const h = setup(t); await h.sg.whenLoaded(); let confirm;
    h.window.Dashboard = { confirm(_html, _title, callback) { confirm = callback; } };
    const modal = h.document.createElement('div'); modal.className = 'je-more-info-modal';
    const button = h.sg.buildSeerrToggle({ id: 42, jeSpoilerGuard: true }, 'tv'); modal.append(button); h.document.body.append(modal);
    button.click(); await tick(); modal.remove(); confirm(true); await tick();
    assert.equal(h.calls.filter(call => call.opts?.method).length, 0);
});

test('watched XHR refreshes only successful writes and cancels pending listeners on teardown', async t => {
    const h = setup(t, async () => stateFixture({ Series: { aa: {} } })); await h.sg.whenLoaded();
    h.JE.core.lifecycle.get('spoiler-guard-watched-installation').teardown();
    class FakeXHR extends h.window.EventTarget {
        status = 0;
        open(method, url, async, username, password) { this.args = [method, url, async, username, password]; }
        send(body) { this.body = body; }
    }
    h.window.XMLHttpRequest = FakeXHR;
    h.sg.installWatchedRefresh(); let refreshed = 0; h.sg.refreshSpoilerableImages = () => refreshed++;
    const xhr = new h.window.XMLHttpRequest();
    xhr.open('POST', '/UserPlayedItems/aa', false, 'user', 'pw'); xhr.send('body');
    assert.deepEqual(xhr.args, ['POST', '/UserPlayedItems/aa', false, 'user', 'pw']); assert.equal(xhr.body, 'body');
    xhr.status = 204; xhr.dispatchEvent(new h.window.Event('loadend'));
    await new Promise(resolve => setTimeout(resolve, 240)); assert.equal(refreshed, 1);
    const denied = new h.window.XMLHttpRequest(); denied.open('DELETE', '/UserPlayedItems/aa'); denied.send();
    denied.status = 403; denied.dispatchEvent(new h.window.Event('loadend'));
    const pending = new h.window.XMLHttpRequest(); pending.open('POST', '/UserPlayedItems/aa'); pending.send();
    h.JE.core.lifecycle.get('spoiler-guard-watched').teardown();
    pending.status = 200; pending.dispatchEvent(new h.window.Event('loadend'));
    await new Promise(resolve => setTimeout(resolve, 240)); assert.equal(refreshed, 1);
});

test('late Seerr mutation failure after account switching produces no stale toast', async t => {
    const response = deferred();
    const h = setup(t, async (_path, opts) => opts?.method ? response.promise : stateFixture()); await h.sg.whenLoaded();
    const modal = h.document.createElement('div'); modal.className = 'je-more-info-modal';
    const button = h.sg.buildSeerrToggle({ id: 42 }, 'movie'); modal.append(button); h.document.body.append(modal);
    button.click(); await tick(); h.change(); response.reject(new Error('old account denied')); await tick();
    assert.deepEqual(h.toasts, []); assert.equal(h.sg.hasAnyState(), false);
});

test('image presentation cookie never selects mutation identity or adds authorization fields', async t => {
    const h = setup(t); await h.sg.whenLoaded();
    h.document.cookie = 'je-spoiler-uid=someone-else; path=/';
    await h.sg.enableForMovie('aa', 'Title');
    const write = h.calls.at(-1);
    assert.equal(write.user, 'alice');
    assert.equal(write.path, '/spoiler-blur/movies/aa');
    assert.deepEqual(plain(write.opts.body), { MovieName: 'Title' });
    assert.equal(write.opts.headers, undefined); assert.equal(write.opts.auth, undefined);
});
