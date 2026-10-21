// A tag-cache answer is published (memory, review ratings, the stored copy, the cards) only for the live account it was
// requested for and only under the privacy generation it was requested in: a download that started before a Spoiler Guard
// change or an account switch never becomes the cache, and a failed reload never brings the invalidated data back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { createHarness, deferred } from '../helpers/harness.mjs';

const card = '<div class="card" data-id="aabb" data-type="Episode"><div class="cardScalable"><div class="cardImageContainer"></div><div class="cardOverlayContainer"></div></div></div>';

async function drainIdle(idle) {
    for (let i = 0; i < 10 && idle.length; i++) {
        const work = idle.splice(0);
        for (const fn of work) fn({ timeRemaining: () => 50 });
        await settle();
    }
}

for (const reloadSucceeds of [false, true]) {
    test(`a download started before a Spoiler Guard change never becomes the cache (reload ${reloadSucceeds ? 'succeeds' : 'fails'})`, async (t) => {
        const old = deferred(), fresh = deferred(), rendered = [], idle = [], calls = [];
        const h = createHarness({
            html: card,
            globals: { requestIdleCallback: (fn) => idle.push(fn) },
            apiClient: { ajax: (o) => { calls.push(o); return calls.length === 1 ? old.promise : fresh.promise; } },
            JE: {
                pluginConfig: { TagCacheServerMode: true }, currentSettings: { qualityTagsEnabled: true },
                helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} },
                core: { tagRenderer: { applyCornerStacking() {}, scheduleCornerStacking() {} } },
                session: { getUserId: () => 'user-a', getServerId: () => 'server-a', getEpoch: () => 0, isCurrent: () => true, onUserChange() {} },
            },
        });
        t.after(() => h.close());
        h.load('tags/tag-pipeline.js');
        h.JE.tagPipeline.registerRenderer('probe', {
            isEnabled: () => true,
            renderFromServerCache: (host, item) => rendered.push(item),
            render: (host, item) => rendered.push(item),
            onServerCacheRefresh() {},
        });
        h.JE.tagPipeline.initialize();
        await settle();
        assert.equal(calls.length, 1);
        const pending = h.JE.tagPipeline.invalidateServerCache();
        h.window.dispatchEvent(new h.window.CustomEvent('je-spoiler-policy-changed'));
        old.resolve({ count: 1, items: { aabb: { Type: 'Episode', Genres: ['R25 previous policy'], StreamData: { ItemName: 'R25 previous policy' } } }, version: 1, timestamp: 100, filterRevision: 'old' });
        await settle();
        assert.equal(calls.length, 2);
        if (reloadSucceeds) fresh.resolve({ count: 1, items: { aabb: { Type: 'Episode', StreamData: { ItemName: 'Season 1 Episode 1' } } }, version: 1, timestamp: 101, filterRevision: 'new' });
        else fresh.reject(new Error('503 unavailable'));
        await pending;
        await settle();
        await drainIdle(idle);
        if (reloadSucceeds) assert.equal(rendered.some((i) => JSON.stringify(i).includes('Season 1 Episode 1')), true);
        assert.equal(rendered.some((i) => JSON.stringify(i).includes('R25 previous policy')), false, 'tags stripped under the previous policy were rendered');
    });
}

test('a download for one account is never published once another account is signed in', async (t) => {
    const old = deferred(), rendered = [], idle = [], calls = [];
    const h = createHarness({
        html: card,
        globals: { requestIdleCallback: (fn) => idle.push(fn) },
        apiClient: { getCurrentUserId: () => 'user-a', ajax: (o) => { calls.push(o); return old.promise; } },
        JE: {
            pluginConfig: { TagCacheServerMode: true }, currentSettings: { qualityTagsEnabled: true },
            helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} },
            core: { navigation: { onNavigate() {} }, tagRenderer: { applyCornerStacking() {}, scheduleCornerStacking() {} } },
        },
    });
    t.after(() => h.close());
    h.load('core/session.js');
    h.load('tags/tag-pipeline.js');
    h.JE.tagPipeline.registerRenderer('probe', { isEnabled: () => true, renderFromServerCache: (host, item) => rendered.push(item), render: (host, item) => rendered.push(item) });
    h.JE.tagPipeline.initialize();
    await settle();
    assert.equal(calls.length, 1);
    const epoch = h.JE.session.getEpoch();
    // The host signs another account in; the session's own poll has not noticed yet.
    h.window.ApiClient = { ...h.window.ApiClient, getCurrentUserId: () => 'user-b' };
    assert.equal(h.JE.session.getEpoch(), epoch);
    old.resolve({ count: 1, items: { aabb: { Type: 'Episode', StreamData: { ItemName: 'R25 first account only' } } }, version: 1, timestamp: 100, filterRevision: 'a' });
    await settle();
    await drainIdle(idle);
    assert.equal(rendered.some((i) => JSON.stringify(i).includes('R25 first account only')), false, "one account's tags were rendered for another");
});
