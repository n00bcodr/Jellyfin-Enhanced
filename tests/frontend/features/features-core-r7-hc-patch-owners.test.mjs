import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from '../helpers/harness.mjs';
import {settingsServer,route} from '../helpers/settings-tabs.mjs';
const camel=value=>Array.isArray(value)?value.map(camel):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).map(([key,v])=>[key[0].toLowerCase()+key.slice(1),camel(v)])):value;

for(const editsBefore of [false,true]) test(`HC patch owners preserve B's remote hide when B edits ${editsBefore?'before':'after'} A's held completion`,async t=>{
    let user='user-a'; const remote='c'.repeat(32);
    const docs=()=>({Settings:{},Shortcuts:{Shortcuts:[]},HiddenContent:{Items:{},Settings:{}}});
    const a=settingsServer(docs()),b=settingsServer(docs());
    b.documents.HiddenContent.Items[remote]={ItemId:remote,Type:'Movie',HideScope:'global'};
    const heldA=a.hold('hidden-content.json','PATCH');
    const h=createHarness({
        JE:{toCamelCase:camel,pluginConfig:{Shortcuts:[]},userConfig:{settings:{},shortcuts:{Shortcuts:[]},hiddenContent:{items:{},settings:{}}}},
        apiClient:{getCurrentUserId:()=>user,accessToken:()=>`credential-${user}`},
        fetch:async(url,options)=>{
            const request={url:String(url),type:options.method||'GET',data:options.body};
            const target=request.url.includes('/user-b/')?b:a;
            request.url=request.url.replace('/user-b/','/user-a/');
            return new Response(JSON.stringify(await route(target,request)),{status:200,headers:{'Content-Type':'application/json'}});
        }
    });
    t.after(()=>h.close());
    for(const file of ['core/navigation.js','core/session.js','core/access-revision.js','core/api-client.js','enhanced/config.js',
        'enhanced/hiddencontent/hidden-content-data.js','enhanced/hiddencontent/hidden-content-save.js'])h.load(file);
    const hc=h.JE.internals.hiddenContent;hc.refreshNativeCardVisibility=()=>{};hc.restoreNativeCardsForIds=()=>{};
    hc.resetFromUserConfig();hc.updateSettings({filterSearch:true});
    const first=hc.flushPendingSave();await heldA.reached;
    user='user-b';h.JE.session.checkNow('switch');
    h.JE.userConfig={settings:{},shortcuts:{Shortcuts:[]},hiddenContent:{items:{},settings:{}}};hc.resetFromUserConfig();
    let heldB;
    if(editsBefore){heldB=b.hold('hidden-content.json','PATCH');hc.updateSettings({filterCalendar:false});await heldB.reached;}
    heldA.release();await first;
    if(!editsBefore)hc.updateSettings({filterCalendar:false});
    heldB?.release();await hc.flushPendingSave();
    assert.equal(a.documents.HiddenContent.Settings.FilterSearch,true);
    assert.ok(b.documents.HiddenContent.Items[remote],"B's remote hide survives the exact original completion schedules");
    assert.equal(b.documents.HiddenContent.Settings.FilterCalendar,false);
    assert.equal(b.documents.HiddenContent.Settings.FilterSearch,undefined,"A's setting is never B's merge base");
    assert.equal(b.writes.length,1);assert.equal(b.writes[0].type,'PATCH');
    assert.equal(h.JE.userConfig.hiddenContent.settings.filterCalendar,false);
});
