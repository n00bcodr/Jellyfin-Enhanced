import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, plain } from '../helpers/harness.mjs';

function setup(t, options = {}, modules = ['navigation', 'session', 'lifecycle']) {
    const h = createHarness(options);
    t.after(() => h.close());
    for (const module of modules) h.load(`core/${module}.js`);
    return h;
}
function authFixture(t, extra = {}) {
    const state = { user: 'a', server: 'one', token: 'a-token', installs: [] };
    const h = setup(t, { apiClient: {
        getCurrentUserId: () => state.user, serverId: () => state.server,
        setAuthenticationInfo(token, user) { state.installs.push(user); state.user = user; state.token = token; return user; },
        ...extra
    } });
    return { ...h, state };
}

test('session lease aborts before reset and credentials; user and server epochs both invalidate it', t => {
    const { JE, window, state } = authFixture(t);
    const lease = JE.session.createLease();
    const seen = [];
    lease.signal.addEventListener('abort', () => seen.push(`abort:${state.token}`));
    JE.session.onUserChange('probe', () => {
        seen.push(`reset:${state.token}`);
        assert.equal(lease.isCurrent(), false);
        assert.equal(JE.session.createLease().signal.aborted, true, 'reset-phase leases cannot use pre-auth credentials');
        JE.session.checkNow('reentrant-probe');
        assert.equal(JE.session.getUserId(), 'b', 'pre-auth reconcile cannot revert projected identity');
    });
    window.ApiClient.setAuthenticationInfo('b-token', 'b');
    assert.deepEqual(seen, ['abort:a-token', 'reset:a-token']);
    assert.throws(() => lease.throwIfStale(), { name: 'AbortError' });
    const next = JE.session.createLease();
    assert.equal(next.signal.aborted, false);
    assert.deepEqual(plain({ userId: next.userId, serverId: next.serverId }), { userId: 'b', serverId: 'one' });
    JE.session.onUserChange('probe', () => {});
    state.server = 'two'; JE.session.checkNow('server');
    assert.equal(next.signal.aborted, true);
    assert.equal(JE.session.createLease().serverId, 'two');
});

test('failed credential write reconciles identity immediately and never revives old leases', t => {
    const failure = new Error('credential failure');
    const { JE, window, state } = authFixture(t, { setAuthenticationInfo() { throw failure; } });
    const lease = JE.session.createLease(); const changes = []; const during = [];
    JE.session.onUserChange('probe', change => { changes.push(change.userId); during.push(JE.session.createLease()); });
    assert.throws(() => window.ApiClient.setAuthenticationInfo('b-token', 'b'), error => error === failure);
    assert.deepEqual(changes, ['b', 'a']);
    assert.equal(JE.session.getUserId(), 'a');
    assert.equal(state.token, 'a-token');
    assert.equal(lease.isCurrent(), false);
    assert.equal(during[0].signal.aborted, true);
    assert.equal(JE.session.createLease().isCurrent(), true);
});

test('nested authentication supersedes the outer credential write and stale reset notification', t => {
    const { JE, window, state } = authFixture(t); const seen = [];
    JE.session.onUserChange('redirect', change => {
        if (change.userId === 'b') window.ApiClient.setAuthenticationInfo('c-token', 'c');
    });
    JE.session.onUserChange('after', change => seen.push(`reset:${change.userId}`));
    window.document.addEventListener('je:user-changed', event => seen.push(`event:${event.detail.userId}`));
    window.ApiClient.setAuthenticationInfo('b-token', 'b');
    assert.deepEqual(state.installs, ['c']);
    assert.deepEqual(seen, ['reset:c', 'event:c']);
    assert.equal(state.token, 'c-token');
    assert.equal(JE.session.getUserId(), 'c');
});

test('abort listener can trigger nested authentication without aborting the new generation', t => {
    const { JE, window, state } = authFixture(t);
    const lease = JE.session.createLease(); const seen = [];
    lease.signal.addEventListener('abort', () => window.ApiClient.setAuthenticationInfo('c-token', 'c'));
    JE.session.onUserChange('probe', change => seen.push(change.userId));
    window.ApiClient.setAuthenticationInfo('b-token', 'b');
    assert.deepEqual(state.installs, ['c']); assert.deepEqual(seen, ['c']);
    assert.equal(JE.session.createLease().signal.aborted, false);
});

test('old unsubscribe cannot remove replacement, even when it uses the same function', t => {
    const { JE, window } = authFixture(t); let calls = 0;
    const callback = () => calls++;
    const old = JE.session.onUserChange('same', callback);
    const current = JE.session.onUserChange('same', callback); old();
    window.ApiClient.setAuthenticationInfo('b-token', 'b'); assert.equal(calls, 1);
    current(); window.ApiClient.setAuthenticationInfo('c-token', 'c'); assert.equal(calls, 1);
});

test('session reset snapshots defer new and replaced subscriptions until the next dispatch', t => {
    const { JE, window } = authFixture(t); const seen = [];
    JE.session.onUserChange('first', () => {
        seen.push('first');
        JE.session.onUserChange('late', () => seen.push('late'));
    });
    JE.session.onUserChange('second', () => seen.push('second'));
    window.ApiClient.setAuthenticationInfo('b-token', 'b');
    assert.deepEqual(seen, ['first', 'second']);
    window.ApiClient.setAuthenticationInfo('c-token', 'c');
    assert.deepEqual(seen, ['first', 'second', 'first', 'second']);
});

test('throwing reset handlers cannot prevent other resets or credential installation', t => {
    const h = authFixture(t); const seen = [];
    h.expectConsoleError('reset handler "broken" failed');
    h.JE.session.onUserChange('broken', () => { throw new Error('broken'); });
    h.JE.session.onUserChange('next', change => seen.push(change.userId));
    h.window.ApiClient.setAuthenticationInfo('b-token', 'b');
    assert.deepEqual(seen, ['b']); assert.equal(h.state.token, 'b-token');
});

test('silent first adoption invalidates anonymous leases and retains userScopedKey format', t => {
    let user = null;
    const { JE } = setup(t, { apiClient: { getCurrentUserId: () => user, serverId: () => null } });
    let resets = 0; JE.session.onUserChange('probe', () => resets++);
    assert.equal(JE.session.userScopedKey('pref'), 'pref:anonymous');
    const lease = JE.session.createLease(); user = 'first'; JE.session.checkNow('first');
    assert.equal(resets, 0); assert.equal(lease.signal.aborted, true);
    assert.equal(JE.session.userScopedKey('pref'), 'pref:first');
    user = null; JE.session.checkNow('logout'); assert.equal(resets, 1);
});

test('inherited auth method preserves receiver, extra arguments, return and secondary client isolation', t => {
    const { JE, window } = setup(t);
    const prototype = {
        setAuthenticationInfo(token, user, extra) { this.user = user; this.extra = extra; return token; },
        getCurrentUserId() { return this.user; }, serverId() { return this.server; }
    };
    const primary = Object.assign(Object.create(prototype), { user: 'primary', server: 'one' });
    const secondary = Object.assign(Object.create(prototype), { user: 'secondary', server: 'two' });
    window.ApiClient = primary;
    window.history.pushState({}, '', '#!/server-switch');
    const epoch = JE.session.getEpoch();
    secondary.setAuthenticationInfo('secondary-token', 'other');
    assert.equal(JE.session.getEpoch(), epoch);
    assert.equal(primary.setAuthenticationInfo('token', 'next', 'extra'), 'token');
    assert.equal(primary.extra, 'extra'); assert.equal(JE.session.getUserId(), 'next');
    assert.equal(Object.hasOwn(prototype.setAuthenticationInfo, '__jeSessionWrapped'), false);
});

test('active client replacement during reset does not receive the superseded credential write', t => {
    const { JE, window, state } = authFixture(t);
    JE.session.onUserChange('replace', change => {
        if (change.userId === 'b') window.ApiClient = { getCurrentUserId: () => 'c', serverId: () => 'two' };
    });
    window.ApiClient.setAuthenticationInfo('b-token', 'b');
    assert.deepEqual(state.installs, []); assert.equal(JE.session.getUserId(), 'c');
    assert.equal(JE.session.getServerId(), 'two');
});

for (const transition of ['user', 'server', 'navigation', 'client']) {
    test(`view item lookup drops stale ${transition} responses`, async t => {
        const pending = deferred(); let user = 'a', server = 'one';
        const { JE, window } = setup(t, { html: '<main class="libraryPage" data-type="item"></main>',
            url: 'http://jellyfin.test/web/#!/details?id=secret', apiClient: {
                getCurrentUserId: () => user, serverId: () => server, getItem: () => pending.promise
            } });
        let result;
        JE.core.navigation.onViewPage((_view, _element, _hash, item) => { result = item; }, { immediate: true, fetchItem: true });
        if (transition === 'user') { user = 'b'; JE.session.checkNow('test'); }
        if (transition === 'server') { server = 'two'; JE.session.checkNow('test'); }
        if (transition === 'navigation') window.history.pushState({}, '', '#!/home');
        if (transition === 'client') window.ApiClient = { getCurrentUserId: () => user, serverId: () => server };
        pending.resolve({ secret: 'old identity' });
        assert.equal(await result, null);
    });
}

test('cached item lookup also drops results from a previous epoch after A to B to A', async t => {
    const pending = deferred(); let user = 'a';
    const { JE } = setup(t, { url: 'http://jellyfin.test/web/#!/details?id=private',
        JE: { helpers: { getItemCached: () => pending.promise } }, apiClient: { getCurrentUserId: () => user } });
    let result;
    JE.core.navigation.onViewPage((_v, _e, _h, item) => { result = item; }, { immediate: true, fetchItem: true });
    user = 'b'; JE.session.checkNow('b'); user = 'a'; JE.session.checkNow('a');
    pending.resolve({ secret: true }); assert.equal(await result, null);
});

test('nested navigations stop stale fan-out and stale callback removers preserve replacement', t => {
    const { JE, window } = setup(t); const seen = [];
    const callback = () => seen.push(window.location.hash);
    JE.core.navigation.onNavigate(() => {
        if (window.location.hash === '#outer') window.history.pushState({}, '', '#inner');
    });
    const old = JE.core.navigation.onNavigate(callback);
    JE.core.navigation.onNavigate(callback); old();
    window.history.pushState({}, '', '#outer'); assert.deepEqual(seen, ['#inner']);
});

test('view subscriptions removed during delivery are skipped and new ones wait for the next view', t => {
    const { JE, document, window } = setup(t); const seen = []; let remove;
    JE.core.navigation.onViewPage(() => {
        seen.push('first'); remove(); JE.core.navigation.onViewPage(() => seen.push('new'));
    });
    remove = JE.core.navigation.onViewPage(() => seen.push('removed'));
    document.dispatchEvent(new window.CustomEvent('viewshow'));
    assert.deepEqual(seen, ['first']);
    document.dispatchEvent(new window.CustomEvent('viewshow'));
    assert.deepEqual(seen, ['first', 'first', 'new']);
});

test('navigation and view callback errors are isolated', t => {
    const h = setup(t); const seen = [];
    h.expectConsoleError('Error in onNavigate callback'); h.expectConsoleError('Error in view handler');
    h.JE.core.navigation.onNavigate(() => { throw new Error('nav'); });
    h.JE.core.navigation.onNavigate(() => seen.push('navigate'));
    h.JE.core.navigation.onViewPage(() => { throw new Error('view'); });
    h.JE.core.navigation.onViewPage(() => seen.push('view'));
    h.window.history.pushState({}, '', '#next');
    h.document.dispatchEvent(new h.window.CustomEvent('viewshow'));
    assert.deepEqual(seen, ['navigate', 'view']);
});

test('Emby bridge forwards raw events once and does not reuse an unforwarded event in later tasks', async t => {
    const { JE, window, document } = setup(t, { globals: { Emby: { Page: {} } } });
    const seen = []; JE.core.navigation.onViewPage((_v, _el, _h, _p, raw) => seen.push(raw));
    const event = new window.CustomEvent('viewshow', { bubbles: true });
    document.addEventListener('viewshow', () => window.Emby.Page.onViewShow('home'), { once: true });
    document.dispatchEvent(event); assert.deepEqual(seen, [event]);
    document.dispatchEvent(new window.CustomEvent('viewshow')); await Promise.resolve();
    window.Emby.Page.onViewShow('home'); assert.deepEqual(seen, [event, null]);
});

test('lifecycle removes EventListener objects with capture options and survives reentrant cleanup', t => {
    const { JE, window } = setup(t); const handle = JE.core.lifecycle.register('objects'); const seen = [];
    const listener = { handleEvent() { seen.push('event'); } };
    handle.addListener(window, 'probe', listener, { capture: true });
    window.dispatchEvent(new window.Event('probe'));
    handle.track(() => { seen.push('cleanup'); handle.track(() => seen.push('next')); handle.teardown(); });
    handle.onTeardown(() => { seen.push('hook'); handle.teardown(); });
    handle.teardown(); window.dispatchEvent(new window.Event('probe'));
    assert.deepEqual(seen, ['event', 'cleanup', 'hook']);
    handle.teardown(); assert.deepEqual(seen, ['event', 'cleanup', 'hook', 'next', 'hook']);
});

test('lifecycle clears all timer representations and continues after disposer errors', async t => {
    const { JE, window } = setup(t); const handle = JE.core.lifecycle.register('timers'); const seen = [];
    handle.track(window.setInterval(() => seen.push('interval'), 5));
    handle.track({ intervalId: window.setInterval(() => seen.push('wrapped interval'), 5) });
    handle.track({ timeoutId: window.setTimeout(() => seen.push('timeout'), 5) });
    handle.track(() => { throw new Error('dispose failed'); });
    handle.track({ abort: () => seen.push('abort') });
    handle.track({ disconnect: () => seen.push('disconnect') });
    handle.track({ unsubscribe: () => seen.push('unsubscribe') });
    handle.teardown(); await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(seen, ['abort', 'disconnect', 'unsubscribe']);
});

test('teardownAll snapshots registry and ignores recursive teardownAll', t => {
    const { JE } = setup(t); const seen = [];
    JE.core.lifecycle.register('one').onTeardown(() => {
        seen.push('one'); JE.core.lifecycle.teardownAll();
        JE.core.lifecycle.register('late').track(() => seen.push('late'));
    });
    JE.core.lifecycle.register('two').onTeardown(() => seen.push('two'));
    JE.core.lifecycle.teardownAll(); assert.deepEqual(seen, ['one', 'two']);
    JE.core.lifecycle.teardownAll(); assert.deepEqual(seen, ['one', 'two', 'one', 'two', 'late', 'late']);
});

test('reloading generated entries preserves existing state and single host hooks', t => {
    const h = authFixture(t); const original = h.window.ApiClient.setAuthenticationInfo;
    const lease = h.JE.session.createLease(); let calls = 0;
    h.JE.core.navigation.onNavigate(() => calls++);
    const handle = h.JE.core.lifecycle.register('retained');
    for (const module of ['navigation', 'session', 'lifecycle']) h.load(`core/${module}.js`);
    assert.equal(h.window.ApiClient.setAuthenticationInfo, original);
    assert.equal(lease.isCurrent(), true); assert.equal(h.JE.core.lifecycle.get('retained'), handle);
    h.window.history.pushState({}, '', '#next'); assert.equal(calls, 1);
});

test('non-configurable writable authentication method can still be hooked', t => {
    const { JE, window } = setup(t); let user = 'a';
    const client = { getCurrentUserId: () => user, serverId: () => 'one' };
    Object.defineProperty(client, 'setAuthenticationInfo', {
        value: (_token, next) => { user = next; }, writable: true, configurable: false
    });
    window.ApiClient = client; window.history.pushState({}, '', '#replacement');
    let observed;
    JE.session.onUserChange('probe', () => { observed = user; });
    client.setAuthenticationInfo('b-token', 'b');
    assert.equal(observed, 'a'); assert.equal(JE.session.getUserId(), 'b');
});

test('credential setter that partially mutates then throws reconciles to the actual host identity', t => {
    let user = 'a';
    const { JE, window } = setup(t, { apiClient: {
        getCurrentUserId: () => user,
        setAuthenticationInfo() { user = 'c'; throw new Error('partial mutation'); }
    } });
    const seen = []; JE.session.onUserChange('probe', change => seen.push(change.userId));
    assert.throws(() => window.ApiClient.setAuthenticationInfo('b-token', 'b'), /partial mutation/);
    assert.deepEqual(seen, ['b', 'c']); assert.equal(JE.session.getUserId(), 'c');
});

test('lifecycle hook errors are isolated and newly registered hooks wait for another teardown', t => {
    const h = setup(t); const handle = h.JE.core.lifecycle.register('hooks'); const seen = [];
    h.expectConsoleError('Error in teardown hook for "hooks"');
    handle.onTeardown(() => { handle.onTeardown(() => seen.push('new')); throw new Error('hook error'); });
    handle.onTeardown(() => seen.push('existing'));
    handle.teardown(); assert.deepEqual(seen, ['existing']);
    handle.teardown(); assert.deepEqual(seen, ['existing', 'existing', 'new']);
});

test('nested Emby original handler supersedes outer view and keeps each raw event scoped', t => {
    const { JE, window, document } = setup(t, { globals: { Emby: { Page: {
        onViewShow(view) { if (view === 'outer') this.onViewShow('inner'); }
    } } } });
    const seen = [];
    JE.core.navigation.onViewPage((view, _e, _h, _p, event) => seen.push([view, event]));
    document.addEventListener('viewshow', () => window.Emby.Page.onViewShow('outer'));
    document.dispatchEvent(new window.CustomEvent('viewshow'));
    assert.deepEqual(seen, [['inner', null]]);
});

test('fallback view delivery hands off to a late Emby router without duplicate notifications', t => {
    const timers = [];
    const { JE, window, document } = setup(t, { globals: { setTimeout: callback => { timers.push(callback); return 1; } } });
    const seen = []; JE.core.navigation.onViewPage(view => seen.push(view));
    document.dispatchEvent(new window.CustomEvent('viewshow')); assert.equal(seen.length, 1);
    window.Emby = { Page: {} }; timers.shift()();
    document.addEventListener('viewshow', () => window.Emby.Page.onViewShow('home'));
    document.dispatchEvent(new window.CustomEvent('viewshow'));
    assert.deepEqual(seen, [undefined, 'home']);
});
