import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from '../helpers/harness.mjs';
import {settingsServer,route} from '../helpers/settings-tabs.mjs';

const camel=value=>Array.isArray(value)?value.map(camel):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).map(([key,v])=>[key[0].toLowerCase()+key.slice(1),camel(v)])):value;
for(const hidden of [false,true]) test(`HC remote ${hidden?'hide':'unhide'} remains current through document reset and a local settings edit`,async t=>{
    const id='c'.repeat(32),entry={ItemId:id,Type:'Movie',HideScope:'global'};
    const server=settingsServer({Settings:{},HiddenContent:{Items:hidden?{}:{[id]:entry},Settings:{}}});
    let revision='h1';
    const h=createHarness({
        JE:{toCamelCase:camel,pluginConfig:{Shortcuts:[]},core:{revision:{document:()=>revision}},
            userConfig:{settings:{},hiddenContent:camel(server.documents.HiddenContent)}},
        apiClient:{ajax:request=>route(server,request)},
        fetch:async(url,options)=>new Response(JSON.stringify(await route(server,
            {url:String(url),type:options.method||'GET',data:options.body})),{status:200,headers:{'Content-Type':'application/json'}})
    });
    t.after(()=>h.close());
    for(const file of ['core/navigation.js','core/session.js','core/session-action.js','core/mutation-queue.js',
        'core/lifecycle.js','core/api-client.js','enhanced/config.js','enhanced/hiddencontent/hidden-content-data.js',
        'enhanced/hiddencontent/hidden-content-save.js']) h.load(file);
    const hc=h.JE.internals.hiddenContent;
    hc.refreshNativeCardVisibility=()=>{};hc.restoreNativeCardsForIds=()=>{};
    hc.resetFromUserConfig();
    server.documents.HiddenContent.Items=hidden?{[id]:entry}:{};revision='h2';
    assert.equal(await hc.revalidate(),true);
    assert.equal(hc.isHidden(id),hidden,'the current server rules are visible');
    assert.equal(!!h.JE.internals.userDocument('hidden-content.json').document.items[id],hidden,
        'the shared document store must own the same accepted read');
    h.document.dispatchEvent(new h.window.CustomEvent('je:user-data-loaded'));
    assert.equal(hc.isHidden(id),hidden,'a data reset cannot restore the previous policy');
    hc.updateSettings({filterCalendar:false});await hc.flushPendingSave();
    assert.equal(hc.isHidden(id),hidden,'a local edit cannot republish the previous policy');
    assert.equal(!!server.documents.HiddenContent.Items[id],hidden);
    assert.equal(server.documents.HiddenContent.Settings.FilterCalendar,false);
});
