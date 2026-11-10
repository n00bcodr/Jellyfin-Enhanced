import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { repositoryRoot } from '../helpers/discovery.mjs';
import { createPluginHost, emittedPage, pageNames, tick } from '../helpers/plugin-pages-host.mjs';

const WAIT = 5000, FIRST_POLL = 50;
const spy = calls => new Proxy({}, { get: (_, name) => (...args) => { calls.push(name); return args; } });
const container = (view, selector) => view.querySelector(selector);

const facades = {
    ActivityPage: { selector: '.jellyfinenhanced.activity', log: 'Activity Page Loaded.', calls: ['injectStyles', 'renderForCustomTab'],
        bridge: calls => ({ activityPage: spy(calls) }) },
    BookmarksPage: { selector: '.sections.bookmarks', log: 'Bookmarks Page Loaded.', calls: [],
        bridge: calls => ({ userConfig: {}, bookmarks: spy(calls) }) },
    CalendarPage: { selector: '#je-calendar-container', log: 'Calendar Page Loaded.', calls: ['injectStyles', 'loadSettings', 'renderPage', 'refresh'],
        bridge: calls => ({ calendarPage: { ...spy(calls), injectStyles: () => calls.push('injectStyles'), loadSettings: () => calls.push('loadSettings'), renderPage: () => calls.push('renderPage'), refresh: async () => { calls.push('refresh'); }, handleEventClick() {} } }) },
    CatchUpPage: { selector: '#je-catchup-container', log: null, calls: ['injectStyles', 'renderPage'],
        bridge: calls => ({ catchUpPage: spy(calls) }) },
    DownloadsPage: { selector: '#je-downloads-container', log: 'Downloads Page Loaded.', calls: ['injectStyles', 'renderPage', 'refresh', 'startPolling'],
        bridge: calls => ({ downloadsPage: { injectStyles: () => calls.push('injectStyles'), renderPage: () => calls.push('renderPage'), refresh: async () => { calls.push('refresh'); }, startPolling: () => calls.push('startPolling'), stopPolling: () => calls.push('stopPolling'), _state: {} } }) },
    HiddenContentPage: { selector: '#je-hidden-content-container', log: 'Hidden Content Page Loaded.', calls: ['injectStyles', 'renderPage'],
        bridge: calls => ({ hiddenContent: {}, hiddenContentPage: spy(calls) }) },
    RecommendationsPage: { selector: '#je-recommendations-container', log: 'Recommendations Page Loaded.', calls: ['renderForCustomTab'],
        bridge: calls => ({ recommendationsPage: spy(calls) }) }
};

test('every generated page keeps its template markup around exactly one generated classic script', () => {
    const template = name => readFileSync(resolve(repositoryRoot, 'client/html/bootstrap-pages', `${name}.html`), 'utf8');
    const script = /<script>[\s\S]*<\/script>/;
    for (const name of pageNames) {
        const html = emittedPage(name);
        assert.equal(html.match(/<script\b/g).length, 1, name);
        assert.equal(html.replace(script, ''), template(name).replace('<!-- JE_TYPED_SCRIPT:main -->', ''), name);
        const source = html.match(/<script>([\s\S]*)<\/script>/)[1];
        assert.doesNotThrow(() => new vm.Script(source), name);
        assert.match(source, /sourceMappingURL=data:application\/json/, name);
        assert.doesNotMatch(source, /<!--|\$\{/, name);
        const map = JSON.parse(Buffer.from(source.match(/base64,(\S+)/)[1], 'base64'));
        assert.ok(map.sources.some(path => path.endsWith('pages/page-mount.ts')), name);
    }
});

for (const name of pageNames) {
    const page = facades[name];
    test(`${name}: mounts once its facade exists, in the feature's order, inside its own view`, async t => {
        const calls = [];
        const h = createPluginHost(t, { JE: {} });
        const view = await h.open(name);
        h.advance(FIRST_POLL * 3);
        assert.equal(view.querySelector('#je-loading') !== null, true, 'loading stays until the facade exists');
        h.window.JellyfinEnhanced = page.bridge(calls); // Deep link: the namespace appears after the script.
        h.advance(FIRST_POLL);
        assert.deepEqual(calls, page.calls);
        assert.equal(view.querySelector('#je-loading'), null);
        assert.ok(container(view, page.selector));
        if (page.log) assert.ok(h.logs.some(line => line.includes(page.log)), page.log);
        assert.equal(h.pending(), 0, 'no wait timer survives');
        assert.deepEqual(h.errors, []);
    });

    test(`${name}: reports not ready after the timeout, in its own view, without rendering`, async t => {
        const h = createPluginHost(t, { JE: undefined });
        const stale = await h.open(name);
        h.advance(WAIT);
        const view = await h.open(name); // Behind the stale copy, so a global id lookup finds the stale one.
        h.advance(WAIT - FIRST_POLL);
        assert.equal(view.querySelector('#je-error').style.display, 'none');
        h.advance(FIRST_POLL);
        assert.equal(view.querySelector('#je-error').style.display, 'block');
        assert.equal(view.querySelector('#je-loading').style.display, 'none');
        assert.notEqual(stale.querySelector('#je-error'), view.querySelector('#je-error'));
        assert.equal(h.pending(), 0);
    });

    test(`${name}: leaving before the facade exists cancels the wait`, async t => {
        const calls = [];
        const h = createPluginHost(t, { JE: {} });
        await h.open(name);
        await h.leave();
        assert.equal(h.pending(), 0);
        h.window.JellyfinEnhanced = page.bridge(calls);
        h.advance(WAIT * 2);
        assert.deepEqual(calls, []);
    });

    test(`${name}: repeated navigation holds one mount's listeners and no timers`, async t => {
        const calls = [];
        const h = createPluginHost(t, { JE: page.bridge(calls) });
        const views = [];
        const baseline = h.listeners.length;
        for (let round = 0; round < 8; round++) {
            const view = await h.open(name);
            h.advance(FIRST_POLL);
            await h.leave();
            // jellyfin-web keeps three view slots; older ones are destroyed.
            views.push(view);
            if (views.length > 3) h.destroy(views.shift());
        }
        await tick();
        const perMount = (h.listeners.length - baseline) / views.length;
        for (const view of views) h.destroy(view);
        assert.equal(h.listeners.filter(item => item.type !== 'click').length, baseline, 'every destroyed view released its listeners');
        assert.ok(perMount < 12);
        assert.equal(h.pending(), 0);
    });
}

test('feature-off pages: a missing feature facade keeps the page in its not-ready state', async t => {
    for (const [name, bridge] of [['HiddenContentPage', { hiddenContentPage: {} }], ['BookmarksPage', { bookmarks: {} }]]) {
        const h = createPluginHost(t, { JE: bridge });
        const view = await h.open(name);
        h.advance(WAIT);
        assert.equal(view.querySelector('#je-error').style.display, 'block', name);
    }
});

test('the stale cached copy of the page does not receive the new mount', async t => {
    const targets = [];
    const h = createPluginHost(t, { JE: { recommendationsPage: { renderForCustomTab: element => targets.push(element) }, activityPage: { injectStyles() {}, renderForCustomTab: element => { targets.push(element); }, stopPolling() {} } } });
    const first = await h.open('RecommendationsPage');
    h.advance(FIRST_POLL);
    const second = await h.open('RecommendationsPage', { first: true });
    h.advance(FIRST_POLL);
    assert.deepEqual(targets, [first.querySelector('#je-recommendations-container'), second.querySelector('#je-recommendations-container')]);
});

test('unrelated containers survive a mount: custom tabs and the standalone pages', async t => {
    const seedDom = `
      <div id="indexPage" class="page mainAnimatedPage hide"><div class="tabContent">
        <div class="sections bookmarks" id="tab-bookmarks"><p>tab</p></div>
        <div class="jellyfinenhanced activity" id="tab-activity"></div>
      </div></div>
      <div id="je-downloads-page" data-type="custom" class="page mainAnimatedPage hide"><div data-role="content"><div class="je-downloads-page">
        <div id="je-downloads-container"><p>standalone</p></div></div></div></div>
      <div id="je-calendar-page" data-type="custom" class="page mainAnimatedPage hide"><div class="je-calendar-page"><div id="je-calendar-container"></div></div></div>`;
    const calls = [];
    for (const name of ['BookmarksPage', 'ActivityPage', 'DownloadsPage', 'CalendarPage']) {
        const h = createPluginHost(t, { JE: facades[name].bridge(calls), seedDom });
        const view = await h.open(name);
        h.advance(FIRST_POLL);
        assert.equal(h.document.querySelectorAll('#tab-bookmarks p').length, 1, name);
        assert.ok(h.document.querySelector('#tab-activity'), name);
        assert.ok(h.document.querySelector('#je-downloads-page div p'), `${name}: standalone container kept`);
        assert.ok(h.document.querySelector('#je-calendar-page .je-calendar-page > div'), `${name}: calendar container kept`);
        await h.leave();
        assert.equal(h.document.querySelector('#tab-bookmarks').className, 'sections bookmarks', `${name}: token returned`);
        if (name === 'DownloadsPage') assert.equal(h.document.getElementById('je-downloads-container').textContent, 'standalone');
        assert.notEqual(view.querySelector('.je-downloads-page, .je-bookmarks-page, .je-activity-standalone-page, .je-calendar-page'), null, name);
    }
});

test('global feature lookups resolve to the mounted page whatever the document order', async t => {
    for (const [name, selector] of [['DownloadsPage', '#je-downloads-container'], ['CalendarPage', '#je-calendar-container'], ['HiddenContentPage', '#je-hidden-content-container']]) {
        const seen = [];
        const id = selector.slice(1);
        const h = createPluginHost(t, { JE: {
            downloadsPage: { injectStyles() {}, renderPage() { seen.push(h.document.getElementById(id)); }, refresh: async () => {}, startPolling() {}, stopPolling() {}, _state: {} },
            calendarPage: { injectStyles() {}, loadSettings() {}, renderPage() { seen.push(h.document.getElementById(id)); }, refresh: async () => {}, handleEventClick() {} },
            hiddenContent: {}, hiddenContentPage: { injectStyles() {}, renderPage() { seen.push(h.document.getElementById(id)); } }
        }, seedDom: `<div id="standalone" data-type="custom" class="page mainAnimatedPage hide"><div id="${id}"></div></div>` });
        const one = await h.open(name, { first: true });
        const oneContainer = one.querySelector(selector);
        h.advance(FIRST_POLL);
        const two = await h.open(name, { first: true });
        const twoContainer = two.querySelector(selector);
        h.advance(FIRST_POLL);
        assert.deepEqual(seen, [oneContainer, twoContainer], name);
        await h.leave();
        assert.equal(h.document.getElementById(id).closest('#standalone') !== null, true, `${name}: id returns to its owner`);
    }
});

test('a duplicate created by the first render is displaced and the page renders into its own view', async t => {
    const h = createPluginHost(t, { JE: {} });
    const seen = [];
    let refreshed = 0;
    h.window.JellyfinEnhanced = { calendarPage: {
        injectStyles() {}, loadSettings() {}, handleEventClick() {}, refresh: async () => { refreshed++; },
        renderPage() {
            // What the real feature does when no standalone page exists, ahead of this view here.
            if (!h.document.getElementById('je-calendar-page')) h.document.querySelector('.mainAnimatedPages').insertAdjacentHTML('afterbegin', '<div id="je-calendar-page" class="page mainAnimatedPage hide"><div id="je-calendar-container"></div></div>');
            const target = h.document.getElementById('je-calendar-container');
            target.textContent = 'rendered';
            seen.push(target);
        }
    } };
    const view = await h.open('CalendarPage');
    h.advance(FIRST_POLL);
    assert.equal(view.querySelector('#je-calendar-container').textContent, 'rendered');
    assert.equal(h.document.querySelector('#je-calendar-page > div').textContent, '');
    assert.equal(h.document.getElementById('je-calendar-container'), view.querySelector('#je-calendar-container'));
    assert.equal(refreshed, 1);
});

test('an empty own page recreates its container without touching the rest of the document', async t => {
    const html = emittedPage('BookmarksPage').replace('<div class="sections bookmarks"></div>', '');
    const h = createPluginHost(t, { JE: { userConfig: {}, bookmarks: {} } });
    const view = await h.open('BookmarksPage', { html });
    assert.equal(view.querySelectorAll('.je-bookmarks-page > .sections.bookmarks').length, 1);
});

test('a host without document.currentScript still finds the visible page', async t => {
    const calls = [];
    const h = createPluginHost(t, { JE: facades.DownloadsPage.bridge(calls) });
    const source = emittedPage('DownloadsPage').match(/<script>([\s\S]*)<\/script>/)[1];
    const markup = emittedPage('DownloadsPage').replace(/<script>[\s\S]*<\/script>/, '');
    const view = await h.open('DownloadsPage', { html: markup });
    h.document.querySelector('.userPluginSettingsContainer').insertAdjacentHTML('beforeend', '');
    h.window.eval(source);
    h.advance(FIRST_POLL);
    assert.deepEqual(calls, facades.DownloadsPage.calls);
    assert.equal(view.querySelector('#je-loading'), null);
});

test('back navigation resumes a cached view whose script does not run again', async t => {
    const calls = [];
    const h = createPluginHost(t, { JE: facades.DownloadsPage.bridge(calls) });
    const view = await h.open('DownloadsPage');
    h.advance(FIRST_POLL);
    const state = h.window.JellyfinEnhanced.downloadsPage._state;
    assert.equal(state._pluginPageVisible, true);
    await h.leave();
    assert.equal(state._pluginPageVisible, false);
    assert.equal(calls.at(-1), 'stopPolling');
    assert.equal(h.document.getElementById('je-downloads-container'), null, 'a hidden view holds no global id');
    calls.length = 0;
    await h.restore('DownloadsPage', view);
    h.advance(FIRST_POLL);
    assert.deepEqual(calls, facades.DownloadsPage.calls);
    assert.equal(state._pluginPageVisible, true);
    assert.equal(h.document.getElementById('je-downloads-container'), view.querySelector('#je-downloads-container'));
});

test('a restore after a timeout retries instead of keeping the failure', async t => {
    const calls = [];
    const h = createPluginHost(t, { JE: {} });
    const view = await h.open('CatchUpPage');
    h.advance(WAIT);
    assert.equal(view.querySelector('#je-error').style.display, 'block');
    await h.leave();
    h.window.JellyfinEnhanced = facades.CatchUpPage.bridge(calls);
    await h.restore('CatchUpPage', view);
    assert.equal(view.querySelector('#je-error').style.display, 'none');
    h.advance(FIRST_POLL);
    assert.deepEqual(calls, facades.CatchUpPage.calls);
});

test('a user switch clears the visible and the cached copy and waits for the new user', async t => {
    const renders = [];
    const h = createPluginHost(t, { JE: { recommendationsPage: { renderForCustomTab(element) { element.textContent = `private:${h.api.getCurrentUserId()}`; renders.push(h.api.getCurrentUserId()); } } } });
    const cached = await h.open('RecommendationsPage');
    h.advance(FIRST_POLL);
    const visible = await h.open('RecommendationsPage');
    h.advance(FIRST_POLL);
    assert.equal(cached.querySelector('#je-recommendations-container').textContent, 'private:user-a');
    h.changeUser('user-b');
    for (const view of [cached, visible]) assert.equal(view.querySelector('#je-recommendations-container').textContent, '');
    await h.navigate('#/home.html');
    await h.navigate('#/userpluginsettings.html?pageUrl=/JellyfinEnhanced/RecommendationsPage');
    h.advance(FIRST_POLL * 4);
    assert.deepEqual(renders, ['user-a', 'user-a'], 'nothing renders before the new user data is live');
    h.userDataLoaded();
    h.advance(FIRST_POLL);
    assert.equal(visible.querySelector('#je-recommendations-container').textContent, 'private:user-b');
    assert.equal(cached.querySelector('#je-recommendations-container').textContent, '');
});

test('a logout mid-wait leaves the page unrendered', async t => {
    const calls = [];
    const h = createPluginHost(t, { JE: {} });
    await h.open('ActivityPage');
    h.changeUser(null);
    h.window.JellyfinEnhanced = facades.ActivityPage.bridge(calls);
    h.userDataLoaded();
    h.advance(WAIT);
    assert.deepEqual(calls, []);
});

test('identity missed by events is still noticed before a cached view repaints', async t => {
    const h = createPluginHost(t, { JE: { recommendationsPage: { renderForCustomTab(element) { element.append(h.document.createTextNode(h.api.getCurrentUserId())); } } } });
    const view = await h.open('RecommendationsPage');
    h.advance(FIRST_POLL);
    await h.leave();
    h.setUser('user-b'); // No session module announced it.
    await h.restore('RecommendationsPage', view);
    h.advance(FIRST_POLL);
    assert.equal(view.querySelector('#je-recommendations-container').textContent, 'user-b');
});

test('Downloads: one watch click opens the item once however often the page was mounted', async t => {
    const shown = [];
    const h = createPluginHost(t, { JE: facades.DownloadsPage.bridge([]), globals: { Emby: { Page: { showItem: id => shown.push(id) } } } });
    let view;
    for (let round = 0; round < 4; round++) {
        view = await h.open('DownloadsPage');
        h.advance(FIRST_POLL);
    }
    view.querySelector('#je-downloads-container').innerHTML = '<button class="je-request-watch-btn" data-media-id="item-1"></button>';
    view.querySelector('.je-request-watch-btn').click();
    assert.deepEqual(shown, ['item-1']);
    await h.leave();
    view.querySelector('.je-request-watch-btn').click();
    assert.deepEqual(shown, ['item-1'], 'the listener ends with the page');
});

test('Downloads: the polling fallback honours config, visibility and page exit', async t => {
    let refreshed = 0;
    const downloadsPage = { injectStyles() {}, renderPage() {}, refresh: async () => { refreshed++; } };
    const h = createPluginHost(t, { JE: { downloadsPage, pluginConfig: { DownloadsPagePollingEnabled: true, DownloadsPollIntervalSeconds: 0 } } });
    const view = await h.open('DownloadsPage');
    h.advance(FIRST_POLL);
    Object.defineProperties(h.window.HTMLElement.prototype, { offsetHeight: { configurable: true, get: () => 1 }, offsetWidth: { configurable: true, get: () => 1 } });
    assert.equal(h.pending(), 1);
    h.advance(1000);
    assert.equal(refreshed, 2, 'an interval of 0 is clamped to one second');
    assert.equal(downloadsPage._pluginPageVisible, true);
    await h.leave();
    assert.equal(h.pending(), 0);
    assert.equal(downloadsPage._pluginPageVisible, false);
    assert.ok(view.isConnected);

    const off = createPluginHost(t, { JE: { downloadsPage: { injectStyles() {}, renderPage() {}, refresh: async () => {} }, pluginConfig: {} } });
    await off.open('DownloadsPage');
    off.advance(FIRST_POLL);
    assert.equal(off.pending(), 0);
});

test('a custom tab that took over a shared poller keeps it when the page is left', async t => {
    const calls = [];
    const h = createPluginHost(t, { JE: { ...facades.DownloadsPage.bridge(calls), ...facades.ActivityPage.bridge(calls) } });
    const page = h.window.JellyfinEnhanced.downloadsPage;
    await h.open('DownloadsPage');
    h.advance(FIRST_POLL);
    page._state._customTabMode = true; // renderForCustomTab ran from the route change.
    await h.leave();
    assert.equal(calls.includes('stopPolling'), false);

    const stops = [];
    const a = createPluginHost(t, { JE: { activityPage: { injectStyles() {}, renderForCustomTab(host) { host.innerHTML = '<div class="je-activity-feed"><p>feed</p></div>'; }, stopPolling() { stops.push('stop'); } } } });
    const view = await a.open('ActivityPage');
    a.advance(FIRST_POLL);
    await a.leave();
    assert.deepEqual(stops, ['stop'], 'its own poller stops');
    await a.restore('ActivityPage', view);
    a.advance(FIRST_POLL);
    view.querySelector('.je-activity-feed').replaceChildren(); // A tab render emptied this feed.
    await a.leave();
    assert.deepEqual(stops, ['stop']);
});

test('beforeunload stops polling work like the baseline page', async t => {
    const calls = [];
    const h = createPluginHost(t, { JE: facades.DownloadsPage.bridge(calls) });
    await h.open('DownloadsPage');
    h.advance(FIRST_POLL);
    h.window.dispatchEvent(new h.window.Event('beforeunload'));
    assert.equal(calls.at(-1), 'stopPolling');
    assert.equal(h.window.JellyfinEnhanced.downloadsPage._state._pluginPageVisible, false);
});

test('a render failure surfaces the page error and does not escape the timer', async t => {
    const h = createPluginHost(t, { JE: { catchUpPage: { injectStyles() {}, renderPage() { throw new Error('boom'); } } } });
    const view = await h.open('CatchUpPage');
    h.advance(FIRST_POLL);
    assert.equal(view.querySelector('#je-error').style.display, 'block');
    assert.ok(h.errors.some(line => line.includes('failed to render')));
    assert.equal(h.errors.some(line => line.includes('Uncaught')), false);
});

test('page sources stay inside their adapter', () => {
    for (const name of ['activity', 'bookmarks', 'calendar', 'catchup', 'downloads', 'hidden-content', 'recommendations']) {
        const source = readFileSync(resolve(repositoryRoot, 'client/src/pages', `${name}-page.ts`), 'utf8');
        assert.doesNotMatch(source, /window\.|JellyfinEnhanced|ApiClient/, name);
    }
});
