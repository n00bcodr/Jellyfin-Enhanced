import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as idle } from 'node:timers/promises';
import { createPluginHost } from '../helpers/plugin-pages-host.mjs';

const POLL = 50;
const movie = id => ({ Id: id, Name: id, Type: 'Movie', ImageTags: { Primary: 'poster' } });
function session() {
    let epoch = 0;
    const resets = new Map();
    return { resets, api: { getEpoch: () => epoch, isCurrent: value => value === epoch, getServerId: () => 'server-a', userScopedKey: key => `${key}:u`, createLease: () => ({ isCurrent: () => true }),
        onUserChange: (key, callback) => { resets.set(key, callback); return () => resets.delete(key); } },
    change() { epoch++; resets.forEach(callback => callback()); } };
}
const resources = () => ({ track: resource => resource, untrack() {}, teardown() {}, addListener(element, type, callback, capture) { element.addEventListener(type, callback, capture); } });

function downloads(t) {
    const live = session();
    const requests = [];
    const JE = { internals: {}, pluginConfig: { DownloadsPageEnabled: true, DownloadsUsePluginPages: true, DownloadsPagePollingEnabled: true, DownloadsPollIntervalSeconds: 30, ShowDownloadsInRequests: true }, t: () => 'x',
        escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'), cdn: { selfhst: () => '' }, toast() {}, session: live.api,
        helpers: { clearAvatarObjectUrlCache() {}, hydrateAvatarImages() {}, isAdmin: () => false, onSidebarRebuilt() {}, onNavigate: () => () => {} },
        core: { api: { plugin: async path => { requests.push(path); return path === '/arr/queue' ? { items: [] } : { requests: [], items: [] }; } }, ui: { injectCss() {}, skeletonGridHtml: () => '', isTvLayout: () => false }, lifecycle: { register: resources } } };
    const h = createPluginHost(t, { JE, client: { ajax: async () => ({ results: [] }), serverAddress: () => 'http://server' } });
    for (const file of ['styles', 'data', 'render-helpers', 'render-cards', 'render', 'actions', 'init']) h.load(`arr/requests/requests-page-${file}.js`);
    return { h, JE, live, requests };
}

test('real Downloads feature renders, polls and stops through the generated page', async t => {
    const { h, JE, requests } = downloads(t);
    Object.defineProperties(h.window.HTMLElement.prototype, { offsetHeight: { configurable: true, get: () => 1 }, offsetWidth: { configurable: true, get: () => 1 } });
    const view = await h.open('DownloadsPage');
    h.advance(POLL);
    await idle();
    assert.ok(view.querySelector('#je-downloads-container').hasChildNodes());
    assert.ok(requests.includes('/arr/queue'));
    assert.equal(JE.downloadsPage._state._pluginPageVisible, true);
    assert.ok(JE.downloadsPage._state.pollTimer, 'the feature poller runs for the plugin page');
    await h.leave();
    assert.equal(JE.downloadsPage._state._pluginPageVisible, false);
    assert.equal(JE.downloadsPage._state.pollTimer, null);
    requests.length = 0;
    h.advance(120000);
    await idle();
    assert.deepEqual(requests, []);
});

test('real Downloads feature repaints the restored view after the user changes while it is cached', async t => {
    const { h, JE, live, requests } = downloads(t);
    const view = await h.open('DownloadsPage');
    h.advance(POLL);
    await idle();
    await h.leave();
    const container = view.querySelector('.je-downloads-page > div');
    assert.ok(container.hasChildNodes());
    h.setUser('user-b');
    live.change(); // The feature's reset cannot find a container that gave up its id.
    h.changeUser('user-b');
    assert.equal(container.hasChildNodes(), false, 'the previous user\'s view is cleared by the page');
    h.userDataLoaded();
    requests.length = 0;
    await h.restore('DownloadsPage', view);
    h.advance(POLL);
    await idle();
    assert.ok(requests.includes('/arr/queue'));
    assert.equal(container.isConnected, true);
    assert.equal(JE.downloadsPage._state._pluginPageVisible, true);
});

test('real Calendar feature: phantom standalone page stays hidden and a repeat mount keeps rendering', async t => {
    const live = session();
    const JE = { currentSettings: {}, pluginConfig: { CalendarPageEnabled: true, CalendarUsePluginPages: true }, session: live.api, t: key => key,
        escapeHtml: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'), cdn: { selfhst: path => path },
        helpers: { onNavigate: () => () => {}, onSidebarRebuilt: () => () => {}, isActiveTabContainer: element => element.isConnected && !element.closest('.hide') },
        core: { api: { plugin: async () => ({ events: [] }) }, ui: { injectCss() {}, skeletonGridHtml: () => '<div>loading</div>' }, lifecycle: { register: resources } } };
    const h = createPluginHost(t, { JE });
    for (const entry of ['styles', 'data', 'render-events', 'render-views', 'actions', 'init']) h.load(`arr/calendar/calendar-page-${entry}.js`);
    const first = await h.open('CalendarPage');
    const firstContainer = first.querySelector('#je-calendar-container');
    h.advance(POLL);
    await idle();
    assert.ok(firstContainer.querySelector('.je-calendar-header'));
    const phantom = h.document.getElementById('je-calendar-page');
    assert.ok(phantom?.classList.contains('hide'));
    assert.equal(phantom.querySelector('.je-calendar-header'), null);
    const second = await h.open('CalendarPage', { first: true });
    h.advance(POLL);
    await idle();
    assert.ok(second.querySelector('#je-calendar-container .je-calendar-header'));
    assert.ok(firstContainer.isConnected);
    const clicks = h.counted('click');
    const third = await h.open('CalendarPage');
    h.advance(POLL);
    assert.equal(h.counted('click'), clicks, 'one document click handler however many mounts');
    assert.ok(third.isConnected);
});

test('real Catch Up and Activity features mount into the view that ran the script', async t => {
    const JE = { pluginConfig: { CatchUpEnabled: true, ActivityFeedEnabled: true, ActivityFeedShowWatched: true, ActivityFeedShowReviewed: true }, internals: {}, t: () => '', toast() {}, session: session().api,
        core: { api: { jf: async path => path === '/Users/Me' ? { Policy: { IsAdministrator: false } } : { Items: [movie('a'), movie('b')] }, plugin: async () => ({ items: [] }) }, ui: { skeletonGridHtml: () => '' } } };
    const h = createPluginHost(t, { JE, client: { getImageUrl: () => '' } });
    for (const file of ['core', 'styles', 'deck', 'activity', 'page']) h.load(`enhanced/catchup/catchup-${file}.js`);
    h.load('extras/activity-page.js');
    const stale = await h.open('CatchUpPage');
    h.advance(POLL);
    await idle();
    const fresh = await h.open('CatchUpPage', { first: true });
    h.advance(POLL);
    await idle();
    assert.ok(fresh.querySelector('#je-catchup-container .je-catchup'));
    assert.ok(stale.querySelector('#je-catchup-container'), 'the cached copy is not deleted');
    const activity = await h.open('ActivityPage');
    h.advance(POLL);
    await idle();
    assert.ok(activity.querySelector('.jellyfinenhanced.activity .je-activity-feed'));
    await h.leave();
    assert.equal(activity.querySelector('.je-activity-feed').hasChildNodes(), false, 'polling stopped with the page');
});
