const { test, expect } = require('@playwright/test');
const path = require('node:path');
const core = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js/core');

async function prepare(page) {
    await page.route('**/core-boundary-fixture', route => route.fulfill({ contentType: 'text/html',
        body: '<!doctype html><button id="focus">Keep focus</button><output id="private"></output>' }));
    await page.goto('/core-boundary-fixture');
    await page.evaluate(() => {
        window.JellyfinEnhanced = {};
        window.identity = { user: 'a', token: 'a-token' };
        window.ApiClient = {
            getCurrentUserId: () => window.identity.user,
            accessToken: () => window.identity.token,
            serverId: () => 'server-one',
            getUrl: pathname => location.origin + pathname,
            setAuthenticationInfo(token, user) { window.identity = { token, user }; }
        };
    });
    for (const module of ['navigation', 'session', 'lifecycle', 'dom-observer', 'ui-kit', 'api-client']) {
        await page.addScriptTag({ path: path.join(core, `${module}.js`) });
    }
}

test('native fetch dedup keeps the second subscriber alive after the first aborts', async ({ page }) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await prepare(page);
    let calls = 0, release;
    const ready = new Promise(resolve => { release = resolve; });
    await page.route('**/dedup-private', async route => {
        calls++;
        await ready;
        await route.fulfill({ contentType: 'application/json', body: '{"owner":"a"}' });
    });
    await page.evaluate(() => {
        const api = window.JellyfinEnhanced.core.api;
        const controller = new AbortController();
        window.first = api.jf('/dedup-private', { signal: controller.signal }).then(
            () => 'unexpected-success', error => error.name);
        window.second = api.jf('/dedup-private');
        controller.abort();
    });
    await expect.poll(() => calls).toBe(1);
    expect(await page.evaluate(() => window.first)).toBe('AbortError');
    release();
    expect(await page.evaluate(() => window.second)).toEqual({ owner: 'a' });
    expect(calls).toBe(1);
    expect(errors).toEqual([]);
});

test('switching accounts cancels native fetch and queued writes before they can alter the next view', async ({ page }) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await prepare(page);
    const requests = [];
    let heldRoute;
    await page.route('**/boundary-private', route => { requests.push(route.request().headers()['x-emby-token']); heldRoute = route; });
    await page.route('**/boundary-write', route => { requests.push('write'); return route.fulfill({ body: '{}' }); });
    await page.evaluate(() => {
        const api = window.JellyfinEnhanced.core.api;
        api.manager.CONFIG.concurrency.maxConcurrent = 1;
        window.oldRead = api.jf('/boundary-private', { cacheKey: 'private' }).then(value => {
            document.querySelector('#private').textContent = value.owner;
            return 'unexpected-success';
        }, error => error.name);
        window.oldWrite = api.jf('/boundary-write', { method: 'POST', body: { saved: true } }).then(
            () => 'unexpected-success', error => error.name);
    });
    await expect.poll(() => requests.length).toBe(1);
    await page.evaluate(() => window.ApiClient.setAuthenticationInfo('b-token', 'b'));
    expect(await page.evaluate(async () => [await window.oldRead, await window.oldWrite])).toEqual(['AbortError', 'AbortError']);
    await heldRoute.fulfill({ contentType: 'application/json', body: '{"owner":"a"}' });
    await page.route('**/boundary-fresh', route => route.fulfill({ contentType: 'application/json',
        body: JSON.stringify({ token: route.request().headers()['x-emby-token'] }) }));
    expect(await page.evaluate(() => window.JellyfinEnhanced.core.api.jf('/boundary-fresh'))).toEqual({ token: 'b-token' });
    expect(await page.evaluate(() => window.JellyfinEnhanced.core.api.manager.getCached('private'))).toBeNull();
    await expect(page.locator('#private')).toBeEmpty();
    expect(requests).toEqual(['a-token']);
    expect(errors).toEqual([]);
});

test('native mutation delivery respects replacement ownership and cancelled waits preserve focus', async ({ page }) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await prepare(page);
    const result = await page.evaluate(async () => {
        const JE = window.JellyfinEnhanced, seen = [];
        const paint = () => new Promise(resolve => JE.core.dom.afterNextPaint(resolve));
        JE.core.dom.onBodyMutation('keep', () => seen.push('keep'));
        const previous = JE.core.dom.onBodyMutation('replace', () => seen.push('old'));
        document.body.append(document.createElement('div'));
        await Promise.resolve();
        JE.core.dom.onBodyMutation('replace', () => seen.push('new'));
        previous.disconnect();
        await paint();
        const first = seen.slice();
        document.body.append(document.createElement('div'));
        await Promise.resolve();
        await paint();
        const second = seen.slice();
        const controller = new AbortController();
        const wait = JE.core.dom.waitForElement('.never-arrives', { signal: controller.signal });
        controller.abort();
        const cancelled = await wait;
        JE.core.dom.disconnectAllObservers();
        document.querySelector('#focus').focus();
        JE.toast('Saved', 20);
        return { first, second, cancelled, observers: JE.core.dom.getBodySubscriberCount(), focus: document.activeElement.id };
    });
    expect(result).toEqual({ first: ['keep'], second: ['keep', 'keep', 'new'], cancelled: null, observers: 0, focus: 'focus' });
    await expect(page.locator('.jellyfin-enhanced-toast')).toHaveCount(0);
    expect(errors).toEqual([]);
});

for (const legacy of [false, true]) test(`aborting a ${legacy ? 'legacy' : 'core'} response body closes the real HTTP stream`, async ({ page, request }, testInfo) => {
    await prepare(page);
    const id = `${testInfo.project.name}-${legacy ? 'legacy' : 'core'}`;
    await page.evaluate(({ id, legacy }) => {
        const api = window.JellyfinEnhanced.core.api;
        window.streamAbort = new AbortController();
        const url = '/tests/browser/stream?id=' + encodeURIComponent(id);
        const pending = legacy
            ? api.manager.fetchWithRetry(url, { signal: window.streamAbort.signal }).then(response => response.text())
            : api.fetch(url, { signal: window.streamAbort.signal });
        window.streamResult = pending.then(() => 'unexpected-success', error => error.name);
    }, { id, legacy });
    const status = async () => (await request.get('/tests/browser/stream-status?id=' + encodeURIComponent(id))).json();
    await expect.poll(status).toEqual({ closed: false, completed: false });
    await page.evaluate(() => window.streamAbort.abort());
    expect(await page.evaluate(() => window.streamResult)).toBe('AbortError');
    await expect.poll(status, { timeout: 3000 }).toEqual({ closed: true, completed: false });
});
