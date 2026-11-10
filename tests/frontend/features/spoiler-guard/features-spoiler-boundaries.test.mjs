import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, deferred, plain } from '../../helpers/harness.mjs';

import { spoilerState } from '../../helpers/spoiler-state.mjs';
const entries = ['ids', 'state', 'image-refresh', 'snooze', 'dialog', 'identity', 'styles', 'settings-tab', 'seerr-toggle', 'detail-button', 'watched-refresh', 'index'];
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function setup(t, plugin = async () => spoilerState(), options = {}) {
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


test('closing modal during initial state load prevents deferred enable', async t => {
 const load=deferred();
 const h=setup(t, (_path,opts) => opts?.method ? Promise.resolve({promoted:'pending'}) : load.promise);
 const modal=h.document.createElement('div'); modal.className='je-more-info-modal';
 const button=h.sg.buildSeerrToggle({id:42},'movie'); modal.append(button); h.document.body.append(modal);
 button.click(); modal.remove(); load.resolve(spoilerState()); await tick(); await tick();
 assert.equal(h.calls.filter(c=>c.opts?.method==='POST').length,0);
 assert.equal(h.sg.isTmdbPending('movie',42),false);
 assert.equal(h.toasts.length,0);
});
test('closing modal during pending delete prevents follow-up item writes', async t => {
 const response=deferred();
 const h=setup(t, (path,opts) => !opts?.method ? Promise.resolve(spoilerState({Prefs:{SkipDisableConfirm:true}})) : path.includes('/pending/') ? response.promise : Promise.resolve({}));
 await h.sg.whenLoaded();
 const modal=h.document.createElement('div'); modal.className='je-more-info-modal';
 const button=h.sg.buildSeerrToggle({id:42,jeSpoilerGuard:true,jeSpoilerGuardItems:['aa','bb']},'movie'); modal.append(button); h.document.body.append(modal);
 button.click(); await tick(); modal.remove(); response.resolve({removed:true,removedFrom:'pending'}); await tick(); await tick();
 assert.deepEqual(h.calls.filter(c=>c.opts?.method==='DELETE').map(c=>c.path),['/spoiler-blur/pending/movie/42']);
 assert.equal(h.toasts.length,0);
});
for (const payload of [{}, {error:'state unavailable'}, {series:{}, movies:{}, collections:{}, pendingTmdb:{}, prefs:{}},
  ...['Series','Movies','Collections','PendingTmdb','Prefs'].map(key => {const state=spoilerState();delete state[key];return state;})]) {
 test(`malformed state envelope remains fail closed: ${JSON.stringify(payload)}`, async t => {
   const h=setup(t,async()=>payload); h.expectConsoleError(/state load failed/); await h.sg.whenLoaded();
   assert.equal(h.sg.isLoadOk(),false); await assert.rejects(h.sg.isMovieInScope('aa'), /state unavailable/);
 });
}

