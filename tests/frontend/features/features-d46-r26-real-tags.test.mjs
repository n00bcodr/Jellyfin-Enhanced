import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as settle } from 'node:timers/promises';
import { createHarness } from '../helpers/harness.mjs';
const card = type => `<div class="card" data-id="aabb" data-type="${type}"><div class="cardScalable"><div class="cardImageContainer"></div><div class="cardOverlayContainer"></div></div></div>`;
const oldGenre = 'first account private genre';
async function drain(idle) { for (let i = 0; i < 5; i++) { for (const fn of idle.splice(0)) fn({timeRemaining: () => 50}); await settle(); } }
function setup(t, ajax) {
    const idle = [], account = { id: 'user-a' };
    const h = createHarness({ apiClient: { ajax: o => ajax(o, account.id) }, globals: { requestIdleCallback: fn => idle.push(fn) },
        JE: { pluginConfig: { TagCacheServerMode: true }, currentSettings: { genreTagsEnabled: true },
            helpers: { onBodyMutation() {}, onNavigate() {}, addCSS() {} }, core: { navigation: { onNavigate() {} } } } });
    t.after(() => h.close());
    h.load('core/session.js'); h.load('tags/tag-pipeline.js'); h.load('core/ui-kit.js');
    h.load('core/tag-renderer-base.js'); h.load('tags/genretags.js'); h.JE.initializeGenreTags(); h.JE.tagPipeline.initialize();
    return { h, idle, switchAccount() { account.id = 'user-b'; h.window.ApiClient = { ...h.window.ApiClient, getCurrentUserId: () => account.id }; } };
}

test('a first-episode memo does not paint the old account genre onto a new live account card', async t => {
    const { h, idle, switchAccount } = setup(t, async (o, live) => o.type === 'GET' ? { count: 0, items: {} }
        : JSON.parse(o.data)[0] === 'a111' ? { Items: [{ Id: 'a111', Type: 'Episode', Genres: live === 'user-a' ? [oldGenre] : [] }] }
        : { Items: [{ Id: 'aabb', Type: 'Series', FirstEpisode: { Id: 'a111', NeedsStreamFetch: true } }] });
    await settle();
    await h.JE.tagPipeline.getFirstEpisode('user-a', 'aabb', 'a111');
    const epoch = h.JE.session.getEpoch();
    switchAccount();
    h.document.body.innerHTML = card('Series'); h.JE.tagPipeline.scheduleScan();
    await drain(idle); await new Promise(r => setTimeout(r, 200)); await settle();
    assert.ok(h.JE.session.getEpoch() >= epoch, 'a synchronous identity check may revoke the old session before its poll');
    assert.equal(h.document.querySelector('.genre-tag')?.title, undefined, 'the real genre renderer painted the first account memo');
});

test('a renderer derived cache cannot paint for a new live account before session polling', async t => {
    const { h, idle, switchAccount } = setup(t, async (o, live) => o.type === 'GET' ? { count: 0, items: {} }
        : { Items: [{ Id: 'aabb', Type: 'Episode', Genres: live === 'user-a' ? [oldGenre] : [] }] });
    await settle();
    h.document.body.innerHTML = card('Episode'); h.JE.tagPipeline.scheduleScan();
    await drain(idle); await new Promise(r => setTimeout(r, 200)); await settle();
    assert.equal(h.document.querySelector('.genre-tag')?.title, oldGenre, 'first account control');
    const epoch = h.JE.session.getEpoch();
    switchAccount();
    h.document.body.innerHTML = card('Episode'); h.JE.tagPipeline.scheduleScan();
    await drain(idle);
    assert.ok(h.JE.session.getEpoch() >= epoch, 'a synchronous identity check may revoke the old session before its poll');
    assert.equal(h.document.querySelector('.genre-tag'), null, 'renderFromCache painted the previous account cached genre before any batch could check authority');
});

for (const held of [false, true]) test(`a ${held ? 'pending' : 'warm'} parent-series memo retains its producing account`, async t => {
    const { h, switchAccount } = setup(t, async () => ({ count: 0, items: {} }));
    await settle();
    let release, calls = 0;
    const pending = new Promise(resolve => { release = resolve; });
    h.JE.helpers.getItemCached = async () => { calls++; return held && calls === 1 ? pending : { Id: 'series', Name: calls === 1 ? 'private A' : 'safe B' }; };
    const first = h.JE.tagPipeline.getParentSeries('user-a', 'series');
    if (!held) assert.equal((await first).Name, 'private A');
    switchAccount();
    const nextRead = h.JE.tagPipeline.getParentSeries('user-b', 'series');
    if (held) release({ Id: 'series', Name: 'private A' });
    const next = await nextRead;
    assert.notEqual(next?.Name, 'private A', 'the immediate read cannot renew A under B');
    await settle();
    assert.equal((await h.JE.tagPipeline.getParentSeries('user-b', 'series')).Name, 'safe B');
    if (held) assert.equal(await first, null);
    assert.ok(calls >= 2);
});

test('a computed quality map cannot replace the current accounts empty stream answer', async t => {
    let user = 'a', spec;
    const h = createHarness({ JE: { currentSettings: { qualityTagsEnabled: true, qualityTagsPreferredAudioLanguage: 'none' },
        core: { tagRenderer: { register(_name, value) { spec = value; } } } } });
    t.after(() => h.close()); h.load('tags/qualitytags.js'); await h.JE.initializeQualityTags();
    const card = h.document.createElement('div'); let paints = 0;
    const ctx = { removeExistingOverlay() {}, isTagged: () => false, shouldIgnore: () => false, captureAuthority: () => ({ user }),
        authorityHolds: owner => owner?.user === user, commitOverlay: () => { paints++; } };
    spec.pipeline.renderFromServerCache(ctx, card, { StreamData: { Streams: [{ Type: 'Video', Width: 1920, Height: 1080, Codec: 'h264' }], Sources: [] } }, 'same-item');
    assert.ok(paints > 0, 'first-account populated quality control');
    paints = 0; user = 'b';
    spec.pipeline.renderFromServerCache(ctx, card, { StreamData: { Streams: [], Sources: [] } }, 'same-item');
    assert.equal(paints, 0, 'old computed qualities must not replace the current empty answer');
});
