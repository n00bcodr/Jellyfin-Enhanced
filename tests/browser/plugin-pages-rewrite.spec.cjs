const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const plugin = path.resolve(__dirname, '../../Jellyfin.Plugin.JellyfinEnhanced');
const page_ = name => readFileSync(path.join(plugin, 'PluginPages', `${name}.html`), 'utf8');
// jellyfin-web hides cached views with this rule; visibility checks depend on it.
const shell = '<style>.hide { display: none !important; }</style><div class="mainAnimatedPages"></div>';

/** jellyfin-web view slots, with Plugin Pages' real insertion path, unchanged. */
async function host(page, JE) {
    await page.goto('/');
    await page.setContent(shell);
    await page.evaluate(serialized => {
        // eslint-disable-next-line no-eval
        window.JellyfinEnhanced = (0, eval)(`(${serialized})`)();
        window.ApiClient = { getCurrentUserId: () => 'user-a', getUrl: path => path, accessToken: () => 'token', serverId: () => 'server' };
        window.openPage = (name, html, first) => {
            const current = document.querySelector('.page:not(.hide)');
            if (current) {
                current.dispatchEvent(new CustomEvent('viewhide', { bubbles: true }));
                current.classList.add('hide');
            }
            location.hash = `/userpluginsettings.html?pageUrl=/JellyfinEnhanced/${name}`;
            const view = document.createElement('div');
            view.id = 'userPluginPreferencesPage';
            view.dataset.role = 'page';
            view.className = 'page mainAnimatedPage';
            view.innerHTML = '<div class="userPluginSettingsContainer"></div>';
            const slots = document.querySelector('.mainAnimatedPages');
            if (first) slots.prepend(view); else slots.append(view);
            const fragment = document.createRange().createContextualFragment(html);
            view.querySelector('.userPluginSettingsContainer').append(fragment);
            return view;
        };
    }, JE.toString());
}
const open = (page, name, first = false) => page.evaluate(([name, html, first]) => { window.openPage(name, html, first); }, [name, page_(name), first]);

test('a page inserted the Plugin Pages way mounts into its own view, ahead of a stale copy', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error));
    await host(page, () => ({ recommendationsPage: { renderForCustomTab(element) { element.textContent = `render ${document.querySelectorAll('.page').length}`; } } }));
    await open(page, 'RecommendationsPage');
    await expect(page.locator('#userPluginPreferencesPage:not(.hide) #je-recommendations-container')).toHaveText('render 1');
    await open(page, 'RecommendationsPage', true);
    await expect(page.locator('#userPluginPreferencesPage:not(.hide) #je-recommendations-container')).toHaveText('render 2');
    expect(await page.locator('#userPluginPreferencesPage.hide #je-recommendations-container').textContent()).toBe('render 1');
    await expect(page.locator('#je-loading')).toHaveCount(0);
    expect(errors).toEqual([]);
});

for (const first of [true, false]) {
    test(`the not-ready message appears in the mounted view when it is ${first ? 'ahead of' : 'behind'} the cached copy`, async ({ page }) => {
        await host(page, () => undefined);
        await open(page, 'CatchUpPage');
        await open(page, 'CatchUpPage', first);
        await expect(page.locator('#userPluginPreferencesPage:not(.hide) #je-error')).toBeVisible({ timeout: 7000 });
        await expect(page.locator('#userPluginPreferencesPage.hide #je-error')).toBeHidden();
        await expect(page.locator('#userPluginPreferencesPage:not(.hide) #je-loading')).toBeHidden();
    });
}

test('a later mount of the same page leaves the cached view its content', async ({ page }) => {
    await host(page, () => ({ catchUpPage: { injectStyles() {}, renderPage(element) { (element || document.getElementById('je-catchup-container')).textContent = 'deck'; } } }));
    await open(page, 'CatchUpPage');
    await expect(page.locator('.page:not(.hide) #je-catchup-container')).toHaveText('deck');
    await open(page, 'CatchUpPage');
    await expect(page.locator('.page:not(.hide) #je-catchup-container')).toHaveText('deck');
    await expect(page.locator('.page.hide #je-catchup-container')).toHaveText('deck');
});

for (const [name, selector, facade] of [
    ['BookmarksPage', '#tab-bookmarks', () => ({ userConfig: {}, bookmarks: {} })],
    ['BookmarksPage', '#standalone-bookmarks', () => ({ userConfig: {}, bookmarks: {} })],
    ['ActivityPage', '#tab-activity', () => ({ activityPage: { injectStyles() {}, stopPolling() {}, renderForCustomTab() {} } })]
]) {
    test(`mounting ${name} leaves ${selector} in place`, async ({ page }) => {
        await host(page, facade);
        await page.evaluate(() => {
            document.querySelector('.mainAnimatedPages').insertAdjacentHTML('afterbegin', `
              <div id="indexPage" class="page mainAnimatedPage hide"><div class="tabContent">
                <div id="tab-bookmarks" class="sections bookmarks">tab</div><div id="tab-activity" class="jellyfinenhanced activity">tab</div></div></div>
              <div id="je-bookmarks-standalone-page" data-type="custom" class="page mainAnimatedPage hide"><div class="content-primary je-bookmarks-page"><div id="standalone-bookmarks" class="sections bookmarks">standalone</div></div></div>`);
        });
        await open(page, name);
        await page.waitForTimeout(150);
        await expect(page.locator(selector)).toHaveCount(1);
    });
}

test('a cached copy of a page keeps no previous user content after a switch', async ({ page }) => {
    await host(page, () => ({ catchUpPage: { injectStyles() {}, renderPage(element) { (element || document.getElementById('je-catchup-container')).textContent = 'alice private'; } } }));
    await open(page, 'CatchUpPage');
    await expect(page.locator('#je-catchup-container')).toHaveText('alice private');
    await open(page, 'ActivityPage');
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('je:user-changed', { detail: { userId: 'bob', epoch: 2 } })));
    await expect(page.getByText('alice private')).toHaveCount(0);
});

test('a duplicate id created ahead of the view during render is displaced', async ({ page }) => {
    await host(page, () => ({ calendarPage: { injectStyles() {}, loadSettings() {}, handleEventClick() {}, async refresh() {},
        renderPage() {
            if (!document.getElementById('je-calendar-page')) document.querySelector('.mainAnimatedPages').insertAdjacentHTML('afterbegin', '<div id="je-calendar-page" class="page mainAnimatedPage hide"><div id="je-calendar-container"></div></div>');
            document.getElementById('je-calendar-container').textContent = 'rendered';
        } } }));
    await open(page, 'CalendarPage');
    await expect(page.locator('.page:not(.hide) .je-calendar-page > div')).toHaveText('rendered');
    await expect(page.locator('#je-calendar-page > div')).toHaveText('');
    expect(await page.evaluate(() => !!document.getElementById('je-calendar-container').closest('#userPluginPreferencesPage'))).toBe(true);
});

test('global lookups find the mounted page behind an unrelated holder, which regains its id', async ({ page }) => {
    await host(page, () => ({ downloadsPage: { injectStyles() {}, async refresh() {}, startPolling() {}, stopPolling() {}, _state: {},
        renderPage() { document.getElementById('je-downloads-container').textContent = 'rendered'; } } }));
    await page.evaluate(() => document.querySelector('.mainAnimatedPages').insertAdjacentHTML('afterbegin', '<div id="je-downloads-page" data-type="custom" class="page mainAnimatedPage hide"><div class="je-downloads-page"><div id="je-downloads-container">standalone</div></div></div>'));
    await open(page, 'DownloadsPage');
    await expect(page.locator('.page:not(.hide) .je-downloads-page > div')).toHaveText('rendered');
    await expect(page.locator('#je-downloads-page .je-downloads-page > div')).toHaveText('standalone');
    await page.evaluate(() => { const view = document.querySelector('.page:not(.hide)'); view.dispatchEvent(new CustomEvent('viewhide', { bubbles: true })); view.classList.add('hide'); location.hash = '/home.html'; });
    await expect.poll(() => page.evaluate(() => !!document.getElementById('je-downloads-container')?.closest('#je-downloads-page'))).toBe(true);
});

test('downloads keeps one watch action and releases its global id while cached', async ({ page }) => {
    await host(page, () => ({ downloadsPage: { injectStyles() {}, async refresh() {}, startPolling() { window.polling = (window.polling || 0) + 1; }, stopPolling() { window.polling--; }, _state: {},
        renderPage() { document.getElementById('je-downloads-container').innerHTML = '<button class="je-request-watch-btn" data-media-id="m"></button>'; } } }));
    await page.evaluate(() => { window.opened = []; window.Emby = { Page: { showItem: id => window.opened.push(id) } }; });
    await open(page, 'DownloadsPage');
    await expect(page.locator('.je-request-watch-btn')).toHaveCount(1);
    await open(page, 'DownloadsPage', true);
    await expect(page.locator('.page:not(.hide) .je-request-watch-btn')).toHaveCount(1);
    await page.locator('.page:not(.hide) .je-request-watch-btn').click();
    expect(await page.evaluate(() => window.opened)).toEqual(['m']);
    expect(await page.evaluate(() => window.polling)).toBe(1);
    expect(await page.evaluate(() => document.querySelectorAll('[id="je-downloads-container"]').length)).toBe(1);
});

const bootstrapPage = async (page, { blockContract = false } = {}) => {
    const { bootstrapFixture } = await import('../frontend/contracts/fixtures.mjs');
    const data = bootstrapFixture({ ComponentScripts: ['core/navigation.js', 'core/session.js', 'enhanced/config.js'], PublicConfig: { MaintenanceModeMessage: 'validated' } });
    if (blockContract) await page.route('**/js/contracts/bootstrap.js*', route => route.abort());
    await page.route('**/JellyfinEnhanced/bundle.js*', route => route.abort());
    await page.goto('/');
    await page.setContent(shell);
    await page.evaluate(data => {
        document.body.insertAdjacentHTML('beforeend', '<script plugin="Jellyfin Enhanced" version="1.2.3-build"></script>');
        window.requests = [];
        window.ApiClient = {
            getCurrentUserId: () => data.UserId, accessToken: () => 'token', serverId: () => 'server',
            getCurrentUser: async () => ({ Id: data.UserId, Policy: { IsAdministrator: false } }),
            getUrl: path => `${location.origin}${path.replace('/JellyfinEnhanced/js/', '/Jellyfin.Plugin.JellyfinEnhanced/js/')}`,
            ajax: async request => {
                const path = new URL(request.url).pathname;
                window.requests.push(path);
                if (path.endsWith('/bootstrap')) return data;
                if (path.endsWith('/public-config')) return { MaintenanceModeMessage: 'fallback' };
                if (path.endsWith('/version')) return '9.9.9';
                if (path.endsWith('/component-scripts.json')) return data.ComponentScripts;
                if (path === '/Plugins') return [];
                return {};
            }
        };
    }, data);
    await page.addScriptTag({ path: path.join(plugin, 'js/plugin.js') });
    await page.waitForFunction(() => window.JellyfinEnhanced.initialized === true);
    return page.evaluate(() => ({ message: window.JellyfinEnhanced.pluginConfig.MaintenanceModeMessage, version: window.JellyfinEnhanced.pluginVersion, requests: window.requests }));
};

test('the emitted loader applies bootstrap through the real validator script', async ({ page }) => {
    const result = await bootstrapPage(page);
    expect(result).toMatchObject({ message: 'validated', version: '1.2.3' });
    expect(result.requests.filter(path => path.endsWith('/bootstrap'))).toHaveLength(1);
});

test('the emitted loader falls back per endpoint when the validator cannot load', async ({ page }) => {
    const result = await bootstrapPage(page, { blockContract: true });
    expect(result).toMatchObject({ message: 'fallback', version: '9.9.9' });
    expect(result.requests.filter(path => path.includes('/user-settings/'))).toHaveLength(5);
});
