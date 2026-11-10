const { test, expect } = require('@playwright/test');
const path = require('node:path');
const root = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced/js/core');

/** Exercise the generated entry points with native browser events and AbortSignals. */
async function prepare(page) {
    await page.goto('/');
    await page.setContent('<main class="libraryPage" data-type="item"></main>');
    await page.evaluate(() => {
        window.JellyfinEnhanced = {};
        window.identity = { user: 'a', token: 'a-token', server: 'one' };
        window.ApiClient = {
            getCurrentUserId: () => window.identity.user,
            serverId: () => window.identity.server,
            setAuthenticationInfo(token, user) { window.identity.token = token; window.identity.user = user; },
            getItem: () => new Promise(resolve => { window.finishItem = resolve; })
        };
        window.Emby = { Page: {} };
    });
    for (const module of ['navigation', 'session', 'lifecycle']) await page.addScriptTag({ path: path.join(root, `${module}.js`) });
}

test('core runtime aborts old work before credential writes and rejects stale item responses', async ({ page }) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await prepare(page);
    const result = await page.evaluate(async () => {
        const JE = window.JellyfinEnhanced;
        history.pushState({}, '', '#!/details?id=secret');
        let item;
        JE.core.navigation.onViewPage((_v, _e, _h, pending) => { item = pending; }, { fetchItem: true, immediate: true });
        const lease = JE.session.createLease(); const order = [];
        lease.signal.addEventListener('abort', () => order.push(`abort:${window.identity.token}`));
        JE.session.onUserChange('test', () => order.push(`reset:${window.identity.token}`));
        window.ApiClient.setAuthenticationInfo('b-token', 'b');
        window.finishItem({ private: 'a' });
        return { order, stale: await item, aborted: lease.signal.aborted, next: JE.session.createLease().userId };
    });
    expect(result).toEqual({ order: ['abort:a-token', 'reset:a-token'], stale: null, aborted: true, next: 'b' });
    expect(errors).toEqual([]);
});

test('core runtime deduplicates browser navigation and removes object listeners on reusable teardown', async ({ page }) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await prepare(page);
    const result = await page.evaluate(() => {
        const JE = window.JellyfinEnhanced; const seen = [];
        const handle = JE.core.lifecycle.register('browser');
        handle.addListener(document, 'probe', { handleEvent() { seen.push('event'); } }, { capture: true });
        handle.onTeardown(() => { seen.push('cleanup'); handle.teardown(); });
        handle.teardownOn('navigate');
        document.dispatchEvent(new Event('probe'));
        history.pushState({}, '', '#one');
        window.dispatchEvent(new PopStateEvent('popstate'));
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        document.dispatchEvent(new Event('probe'));
        history.replaceState({}, '', '#two');
        return seen;
    });
    expect(result).toEqual(['event', 'cleanup', 'cleanup']);
    expect(errors).toEqual([]);
});
