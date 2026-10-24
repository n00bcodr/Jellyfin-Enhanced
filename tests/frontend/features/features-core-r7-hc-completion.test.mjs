import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as settle} from 'node:timers/promises';
import {createHarness,deferred} from '../helpers/harness.mjs';

for (const outcome of ['accepted','refused']) test(`an old HC ${outcome} completion cannot run the incoming account's bookkeeping before polling`,async t=>{
    let user='a';const held=deferred();let readsAfterSave=0,savedEvents=0,toasts=0;
    const h=createHarness({apiClient:{getCurrentUserId:()=>user,accessToken:()=>`credential-${user}`},
        JE:{patchUserSettings:()=>held.promise,toast:()=>toasts++,t:x=>x}});
    t.after(()=>h.close());h.load('core/navigation.js');h.load('core/session.js');h.load('core/api-client.js');
    h.load('enhanced/hiddencontent/hidden-content-save.js');
    const hc=h.JE.internals.hiddenContent;hc.readAfterSave=()=>readsAfterSave++;
    h.window.addEventListener('je-hidden-content-saved',()=>savedEvents++);
    const saving=hc.persist({set:{filterSearch:true}},h.JE.core.userWrite.origin());
    user='b';
    if(outcome==='accepted')held.resolve(true);else held.reject(Object.assign(new Error('refused'),{status:400}));
    assert.equal(await saving,outcome==='accepted');await settle();
    assert.equal(readsAfterSave,0);assert.equal(savedEvents,0);assert.equal(toasts,0);
});
