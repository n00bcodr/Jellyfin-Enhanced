import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as settle} from 'node:timers/promises';
import {createHarness,deferred} from '../helpers/harness.mjs';
test('HC never publishes a read overtaken by a second known document revision',async t=>{
    const older=deferred(),current=deferred();let revision='h1',reads=0;
    const a='a'.repeat(32),b='b'.repeat(32),c='c'.repeat(32);
    const doc=id=>({items:{[id]:{itemId:id,type:'Movie',hideScope:'global'}},settings:{}});
    const h=createHarness({JE:{userConfig:{hiddenContent:doc(a)},core:{revision:{document:()=>revision}}},
        apiClient:{ajax:()=>++reads===1?older.promise:current.promise}});
    t.after(()=>h.close());h.load('enhanced/hiddencontent/hidden-content-data.js');
    const hc=h.JE.internals.hiddenContent;
    hc.refreshNativeCardVisibility=()=>{};hc.restoreNativeCardsForIds=()=>{};
    hc.resetFromUserConfig();revision='h2';const reading=hc.revalidate();await settle();
    revision='h3';older.resolve(doc(b));await settle();await settle();
    assert.equal(hc.isHidden(a),true,'the existing base stays until a current read is accepted');
    assert.equal(hc.isHidden(b),false,'known-superseded bytes cannot become the visible policy');
    current.resolve(doc(c));assert.equal(await reading,true);assert.equal(reads,2);
    assert.equal(hc.isHidden(c),true);assert.equal(hc.isHidden(a),false);
});
