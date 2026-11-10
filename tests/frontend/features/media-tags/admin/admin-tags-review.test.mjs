import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot, BASE, signedIn } from '../../../helpers/admin-tags-page.mjs';
import { deferred } from '../../../helpers/harness.mjs';
const settle = async () => { await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); };
function page(t, patch) {
    const identity = signedIn();
    const h = boot(t, { server: structuredClone(BASE), apiClient: identity.apiClient, patch });
    if (process.env.ADMIN_TAGS_BEFORE) {
        h.window.eval(readFileSync(process.env.ADMIN_TAGS_BEFORE, 'utf8'));
        h.A = h.JE.adminTags;
        for (const file of h.A.SECTION_FILES) h.load('enhanced/admintags/' + file);
    }
    const ctx = h.A.createPage(h.document.getElementById('jeTaRoot'), structuredClone(BASE));
    h.cleanup.push(() => ctx.dispose()); h.allowConsoleError('could not save');
    return { h, ctx, identity };
}
for (const kind of ['account', 'server', 'token', 'client', 'root']) test('ATB-R1-001: old held action rejects ' + kind + ' replacement', async t => {
    const pending = deferred();
    const { h, ctx, identity } = page(t, () => pending.promise);
    ctx.set('GenreTagsEnabled', true);
    let runs = 0;
    const action = h.A.holdSaves(async () => { runs++; });
    const rejected = assert.rejects(action, { name: 'AbortError' });
    if (kind === 'account') identity.who.user = 'new-admin';
    if (kind === 'server') identity.who.server = 'new-server';
    if (kind === 'token') h.window.ApiClient.accessToken = () => 'replacement';
    if (kind === 'client') h.window.ApiClient = { ...h.window.ApiClient };
    if (kind === 'root') h.window.ApiClient.getUrl = path => 'http://replacement.test/' + path;
    pending.resolve({ values: { GenreTagsEnabled: true } });
    await rejected;
    assert.equal(runs, 0);
});
test('ATB-R1-001: new account action is not blocked by old held work', async t => {
    const pending = deferred();
    const { h, ctx, identity } = page(t, () => pending.promise);
    ctx.set('GenreTagsEnabled', true);
    let oldRuns = 0, newRuns = 0;
    const old = h.A.holdSaves(async () => { oldRuns++; });
    const rejected = assert.rejects(old, { name: 'AbortError' });
    identity.who.user = 'new-admin';
    await h.A.holdSaves(async () => { newRuns++; });
    assert.equal(newRuns, 1);
    pending.resolve({ values: { GenreTagsEnabled: true } });
    await rejected; assert.equal(oldRuns, 0);
});
for (const ack of [null, {}, { values: null }, { values: [] }, { values: {} }, { values: { OtherField: true } }]) {
    test('ATB-R1-002: malformed acknowledgement preserves pending edit ' + JSON.stringify(ack), async t => {
        const { h, ctx } = page(t, () => ack);
        ctx.set('GenreTagsEnabled', true);
        assert.equal(await ctx.flush(), false);
        const state = h.A.pendingState();
        assert.equal(state.state, 'error');
        assert.deepEqual(Array.from(state.fields), ['GenreTagsEnabled']);
        assert.deepEqual(Array.from(state.failed), ['GenreTagsEnabled']);
    });
}
test('ATB-R1-002: incomplete multi-field acknowledgement preserves all intent and Retry can recover', async t => {
    let incomplete = true;
    const { h, ctx } = page(t, body => incomplete ? { values: { GenreTagsEnabled: true } } : { values: body.Changes });
    ctx.set('GenreTagsEnabled', true); ctx.set('TagsHideOnHover', true);
    assert.equal(await ctx.flush(), false);
    assert.deepEqual(Array.from(h.A.pendingState().fields).sort(), ['GenreTagsEnabled', 'TagsHideOnHover']);
    incomplete = false;
    assert.equal(await ctx.flush(), true);
    assert.deepEqual(Array.from(h.A.pendingState().fields), []);
});
for (const conflicts of [{ OtherField: false }, { '0': 'x' }, { GenreTagsEnabled: false, OtherField: false }]) {
    test('ADMIN-TAGS-04: malformed conflict map stops after one request ' + JSON.stringify(conflicts), async t => {
        let calls = 0;
        const { h, ctx } = page(t, () => {
            if (++calls > 3) throw new Error('bounded faulty implementation stop');
            throw { status: 409, json: async () => ({ conflicts }) };
        });
        ctx.set('GenreTagsEnabled', true);
        assert.equal(await ctx.flush(), false);
        assert.equal(calls, 1);
        assert.equal(h.A.pendingState().state, 'error');
        assert.deepEqual(Array.from(h.A.pendingState().fields), ['GenreTagsEnabled']);
    });
}
test('ADMIN-TAGS-04: valid subset conflict saves unrefused fields and keeps conflict choice', async t => {
    let calls = 0;
    const { h, ctx } = page(t, body => {
        calls++;
        if (calls === 1) throw { status: 409, json: async () => ({ conflicts: { GenreTagsEnabled: false } }) };
        return { values: body.Changes };
    });
    ctx.set('GenreTagsEnabled', true); ctx.set('TagsHideOnHover', true);
    assert.equal(await ctx.flush(), false); assert.equal(calls, 2);
    assert.equal(h.A.pendingState().state, 'conflict');
    assert.deepEqual(Array.from(h.A.pendingState().fields), ['GenreTagsEnabled']);
});
test('ATB-R1-003: overlapping whole-document actions serialize and field patches wait for the active hold', async t => {
    let writes = 0;
    const { h, ctx } = page(t, body => { writes++; return { values: body.Changes }; });
    const aGate = deferred(), bGate = deferred();
    const order = [];
    const a = h.A.holdSaves(async () => { order.push('a-start'); await aGate.promise; order.push('a-end'); });
    const b = h.A.holdSaves(async () => { order.push('b-start'); await bGate.promise; order.push('b-end'); });
    await settle(); assert.deepEqual(order, ['a-start']);
    aGate.resolve(); await a; await settle();
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start']);
    ctx.set('GenreTagsEnabled', true);
    const flushed = ctx.flush(); await settle(); assert.equal(writes, 0);
    bGate.resolve(); await b; assert.equal(await flushed, true);
    assert.equal(writes, 1); assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
});
test('ATB-R1-003: calls arriving during the first flush queue before either action starts', async t => {
    const patchGate = deferred(), actionGate = deferred();
    const { h, ctx } = page(t, () => patchGate.promise); ctx.set('GenreTagsEnabled', true);
    const order = [];
    const a = h.A.holdSaves(async () => { order.push('a'); await actionGate.promise; });
    const b = h.A.holdSaves(async () => { order.push('b'); });
    await settle(); assert.deepEqual(order, []);
    patchGate.resolve({ values: { GenreTagsEnabled: true } }); await settle();
    assert.deepEqual(order, ['a']);
    actionGate.resolve(); await Promise.all([a, b]); assert.deepEqual(order, ['a', 'b']);
});
test('ATB-R1-003: failed whole-document action releases the next queued operation', async t => {
    const { h } = page(t, body => ({ values: body.Changes }));
    const gate = deferred(); let next = 0;
    const a = h.A.holdSaves(async () => { await gate.promise; throw new Error('save failed'); });
    const rejected = assert.rejects(a, /save failed/);
    const b = h.A.holdSaves(async () => { next++; });
    assert.equal(next, 0); gate.resolve(); await rejected; await b; assert.equal(next, 1);
});

for (const kind of ['account', 'server', 'token', 'client', 'root']) test('ATB-R2-001: active held callback guards continuation after ' + kind + ' replacement', async t => {
    const { h, identity } = page(t, body => ({ values: body.Changes }));
    const confirmation = deferred(); let writes = 0;
    const work = h.A.holdSaves(async scope => {
        assert.equal(scope.isCurrent(), true);
        await confirmation.promise;
        scope.throwIfStale();
        writes++;
    });
    const rejected = assert.rejects(work, { name: 'AbortError' });
    if (kind === 'account') identity.who.user = 'new-admin';
    if (kind === 'server') identity.who.server = 'new-server';
    if (kind === 'token') h.window.ApiClient.accessToken = () => 'replacement';
    if (kind === 'client') h.window.ApiClient = { ...h.window.ApiClient };
    if (kind === 'root') h.window.ApiClient.getUrl = path => 'http://replacement.test/' + path;
    confirmation.resolve();
    await rejected; assert.equal(writes, 0);
});
test('ATB-R2-001: held scope permits current effects and expires when the callback finishes', async t => {
    const { h } = page(t, body => ({ values: body.Changes }));
    let savedScope, writes = 0;
    await h.A.holdSaves(async scope => {
        savedScope = scope; await settle(); scope.throwIfStale(); writes++;
    });
    assert.equal(writes, 1);
    assert.equal(savedScope.isCurrent(), false);
    assert.throws(() => savedScope.throwIfStale(), { name: 'AbortError' });
});
